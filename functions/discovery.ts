import { generatedExampleEmail } from "./opsDefaults";
import { createHash, randomUUID } from "node:crypto";
import { FieldPath, FieldValue, type WriteBatch } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { expireAt180DaysFromIso } from "./firestoreTtl";
import { buildCommunityFallbackArtifacts, buildCommunitySearchQueries, communitySourceLabel, searchCommunitySources, type CommunitySource, type CommunitySourceReport, type ParsedCommunityDiscoveryData } from "./communitySearch";
import { COMMUNITY_DISCOVERY_STATE_COLLECTION, DEFAULT_COMMUNITY_DISCOVERY_COOLDOWN_HOURS, readCommunityDiscoveryState, writeCommunityDiscoveryState } from "./communityDiscoveryThrottle";
import { buildCreatorPaidStatusIndex, enrichCommunityArtifactsWithPaidStatus } from "./communityPaidStatus";
import { envSecret, getRuntimeIntegration, liveIntegrationsEnabled, publicNumber, requireEnvSecret, timeoutSignal, type RuntimeIntegration } from "./liveIntegrations";
import { readSettings } from "./settings";
import { resolveCanonicalProgramId, SCP_LEGACY_PROGRAM_ID } from "./programCanonical";
import {
  DEFAULT_YOUTUBE_CREATOR_COUNTRIES,
  countryTargetingFromLegacy,
  normalizeYoutubeCreatorCountry,
  normalizeYoutubeCreatorCountryAllowlist,
  resolveCountryTargeting,
  youtubeCreatorCountryPolicyDecision,
  type CountryTargeting,
} from "./youtubeCreatorCountries";
import {
  discoveryMayUsePrimaryYoutubeKey,
  noteYoutubeSearchCallConsumed,
  noteYoutubeSearchSlotQuotaBlocked,
  recordYoutubeApiAttempt,
  recordYoutubeApiUnits,
  reserveStagingYoutubeApiUnits,
  seoulDayKey,
  YOUTUBE_GROWTH_POOL_ID,
  YOUTUBE_SEARCH_QUERIES_DAILY_CAP_PER_SLOT,
  youtubeOperationFromUrl,
  youtubeQuotaDayKey,
  youtubeSearchSlotBudgets,
  youtubeUnitCost,
} from "./apiQuota";
// Flu/W2 (AI Drama org pool routing): resolves the caller's ownerOrgId to a YouTube quota pool
// (settings/youtube_quota_pools.byOrgId — Flu/Task-49) so a scoped discovery run's search/hydration
// calls can be billed against that org's dedicated key instead of growth's rotation. No orgId or
// no mapping resolves to YOUTUBE_GROWTH_POOL_ID — zero behavior change for every existing caller.
import { readYouTubeQuotaPools, resolvePoolIdForOrg, selectYoutubeApiKey, YoutubeQuotaPoolExhaustedError, type SelectYoutubeApiKeyInput } from "./youtubeQuotaPools";
// 헤세 결정(2026-09-24): T049(allowedOrgIds에 있는 org)는 이메일 확보에 Apify actor만 쓴다 — 아래
// publicWebBackfillExistingCandidateEmails가 About 스크레이핑 전에 이 모듈로 라우팅을 확정한다.
import {
  APIFY_BATCH_SIZE_MAX,
  APIFY_CALL_MIN_BUDGET_MS,
  APIFY_CALL_TIMEOUT_MS_MAX,
  APIFY_EMAIL_EVENT_PRICE_USD,
  callApifyChannelEmailActor,
  captchaSolverCacheLookup,
  captchaSolverCacheStore,
  isApifyExclusiveOrg,
  isCaptchaSolverAllowedForOrg,
  readCaptchaSolverIntegration,
  recordCaptchaSolverCall,
  reserveCaptchaSolverCallSlots,
} from "./captchaSolverIntegration";
import { enqueueCreatorCommentSentimentPending } from "./creatorCommentSentiment";
import { gateAiDramaCandidatesByRelevance, type AiDramaRelevanceStamp } from "./aiDramaRelevance";
import { isOperationalFixtureRecord } from "./operationalFixtureProvenance";
import { isDemoFixtureRuntimeAllowed, isStagingRuntime, type RuntimeEnvironmentSource } from "./runtimeEnvironment";
import {
  assertStagingYoutubeLiveEgressAllowed,
  STAGING_YOUTUBE_MAX_PAGES,
  STAGING_YOUTUBE_MAX_RESULTS,
} from "./stagingSafety";
import {
  buildProgramScopedCandidateParticipationWrites,
  CANDIDATE_SCOPE_VERSION,
  CANDIDATE_SOURCE_PURPOSE,
  type CandidateSourcePurpose,
  globalCandidateIdentityData,
} from "./candidateScope";
import { assertMutationOwner, mutationOwnerUids, permissionDenied } from "./mutationAuthorization";
import {
  ACCOUNT_OWNERSHIP_SCOPE_VERSION,
  accountOwnershipStampForOwnedRecordAsync,
  accountOwnershipStampForScope,
  accountOwnershipStampForTrustedLegacyOwnerRecord,
  assertAccountOwnershipForRecordAsync,
  assertWritableAccountOwnershipScope,
  resolveAccountOwnershipScopeForRequest,
  type AccountOwnershipScope,
} from "./accountOwnership";
import { assertViewAsReadOnlyPayload } from "./viewAsWriteGuard";
import type { CallableRequestShape } from "./shared";
import {
  AI_DRAMA_YTDLP_PRIMARY_LANE_APPROVAL_REF,
  YTDLP_PROMOTION_CONFIG_PATH,
  YTDLP_PROMOTION_DAILY_COLLECTION,
  YTDLP_PROMOTION_PRIMARY_LANE_ALLOWED_VERTICALS,
  filterPromotionObservationsByRecentVideo,
  resolveYtdlpPromotionConfig,
} from "./ytdlpPromotionCore";
import {
  AI_DRAMA_DISCOVERY_CATEGORIES,
  AI_DRAMA_MIN_QUALIFYING_VIDEO_COUNT,
  AI_DRAMA_MIN_QUALIFYING_VIDEO_VIEWS,
  bestQualifyingVideoEvidence,
  qualifyingVideoEvidencesFromRecords,
  normalizeDiscoveryVertical,
  readOwnedDiscoveryVertical,
  readOwnedPositiveInteger,
  type DiscoveryVertical,
  type QualifyingVideoEvidence,
} from "./discoveryVerticalPolicy";

export type Role = "super_admin" | "admin" | "manager" | "viewer" | "guest";

export interface CallableRequest {
  auth?: {
    uid?: string;
    token?: {
      role?: Role;
      team?: string;
      email?: string;
      tenant?: string;
      tenantId?: string;
      firebase?: { tenant?: string };
    };
  };
  data?: unknown;
  rawRequest?: {
    ip?: string;
  };
}

export interface BehaviorLog {
  userId: string;
  role: Role;
  team: string;
  gameId: string;
  action: string;
  time: string;
  IP: string;
  result: "success" | "denied" | "mock";
  cost: number;
}

type CacheMeta = {
  status: "hit" | "miss";
  key: string;
  ttlSeconds: number;
  checkedAt: string;
  // Set only on a hit — the cached payload that lets the caller skip the expensive path.
  expiresAtIso?: string;
  value?: Record<string, unknown>;
};

// Discovery cache kinds. queryRef/channelRef + filters fold into the doc id; "kind" namespaces them.
// R30-2: keyword_expansion 은 LLM 키워드 제안기의 TTL 캐시 종류다(같은 컬렉션·같은 계약 재사용).
type DiscoveryCacheKind = "youtube" | "email" | "keyword_expansion";

type CostLog = {
  provider: "mock" | "youtube-data-api" | "yt-dlp" | "community-adapter" | "apify";
  model: "mock-youtube-search" | "mock-email-finder" | "youtube-data-api-v3" | "youtube-channel-email" | "yt-dlp-worker" | "insane-search-adapter" | "apify-channel-email";
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  currency: "USD";
  loggedAt: string;
};

type GuardContext = {
  userId: string;
  role: Exclude<Role, "guest">;
  team: string;
  ip: string;
};

// Raw (pre-parse) callable input contract for youtubeSearch — all fields optional;
// readYoutubeData() normalizes this into ParsedYoutubeSearchData. Exported as the
// documented input shape (consumed by callers/tooling, not internally referenced).
export type YoutubeSearchData = {
  queryRef?: string;
  campaignRef?: string;
  gameId?: string;
  resultLimit?: number;
  filters?: {
    regions?: string[];
    categories?: string[];
    minFollowers?: number;
    recentActivityDays?: number;
    minVideoViews?: number;
    minVideoCount?: number;
  };
  discoveryVertical?: string;
  minVideoViews?: number;
  minVideoCount?: number;
};

type ParsedYoutubeSearchData = {
  queryRef: string;
  campaignRef: string;
  gameId: string;
  resultLimit: number;
  countryTargeting: CountryTargeting;
  filters: {
    regions: string[];
    categories: string[];
    categoriesExplicit: boolean;
    minFollowers: number;
    recentActivityDays: number;
  };
  // R27: 둘 다 optional — 안 넘기면(기존 4개 호출부 전부) 100% keyword 암, 분류 게이트 미적용으로
  // R27 이전과 완전히 동일하게 동작한다. shortfall 발굴 워커(materializeYtDiscoveryRun)만 채운다.
  sliceArmSlots?: DiscoverySliceArmSlots;
  lexicon?: string[];
  discoveryVertical: DiscoveryVertical;
  minVideoViews: number;
  minVideoCount: number;
  // Flu/W2 (AI Drama org pool routing): the owning campaign/run's ownerOrgId, when known. Only
  // materializeYtDiscoveryRun's worker path (the only caller that has an already-resolved
  // accountOwnership at hand) sets this — every other searchYouTubeLive caller leaves it
  // undefined, which resolves to the growth pool exactly as before (resolvePoolIdForOrg(null)).
  ownerOrgId?: string;
};


// Raw (pre-parse) callable input contract for emailFinder — normalized by readEmailFinderData().
export type EmailFinderData = {
  channelRef?: string;
  candidateRef?: string;
  gameId?: string;
};

type ParsedEmailFinderData = {
  channelRef: string;
  candidateRef: string;
  gameId: string;
  // Raw YouTube identifier for the live adapter: channelId / @handle / username / search query.
  channelHint: string | undefined;
};

type ParsedYtDlpDiscoveryData = {
  campaignId: string | undefined;
  campaignRef: string;
  gameId: string;
  keywords: string[];
  countryTargeting: CountryTargeting;
  filters: {
    regions: string[];
    categories: string[];
    categoriesExplicit: boolean;
    excludeKeywords: string[];
    minFollowers: number;
    maxFollowers: number;
    recentActivityDays: number;
  };
  resultLimit: number;
  commentLimit: number;
  includeComments: boolean;
  // R27: enqueue 시점(admin.ts)에 계산된 밴딧 슬롯 배분 + 캠페인 렉시콘 전체 우주(includeKeywords ∪
  // expandedKeywords ∪ mined, 12개 창 절단 이전) — job/run 문서를 거쳐 materializeYtDiscoveryRun 이
  // 재파싱할 때도 살아남아야 하므로(readYtDlpDiscoveryData 재호출) 이 스키마에 포함한다.
  sliceArmSlots: DiscoverySliceArmSlots | undefined;
  lexicon: string[];
  discoveryVertical: DiscoveryVertical;
  minVideoViews: number;
  minVideoCount: number;
};

export type CandidateResult = {
  candidateRef: string;
  channelRef: string;
  name: string;
  handle: string;
  avatar: string;
  platform: "YouTube";
  followers: number;
  region: string;
  creatorCountry?: string;
  countryFilterReason?: string;
  category: string;
  matchScore: number;
  confidence: number;
  signals: string[];
  email?: string | null;
  emailStatus?: EmailFinderStored["status"];
  emailSource?: string;
  /**
   * W115 A3 — 이메일을 **어디서** 캤는지의 기계 판독 축.
   *
   * `emailSource` 는 이미 존재하지만 값이 사람이 읽는 라벨("About 페이지")과 기계 라벨
   * ("video_description")로 섞여 있어 집계 키로 못 쓴다. 노출률 기여를 소스별로 측정하려면
   * (A4 가 이 값을 읽는다) 값 집합이 닫혀 있어야 한다 — 그래서 축을 하나 더 둔다.
   */
  emailSourceKind?: EmailSourceKind;
  youtubeUrl?: string;
  sourcePlatform?: string;
  sourceUrl?: string;
  discoverySource?: string;
  discoveryArm?: DiscoverySliceType;
  persistOutcome?: "created" | "merged" | "rejected";
  sourceFetchedAt?: string;
  discoveryProvenance?: Record<string, unknown>;
  qualifyingVideo?: QualifyingVideoEvidence;
  videoQualification?: Record<string, unknown>;
  /** ai_drama vertical only — stamped by functions/aiDramaRelevance.ts's gate right before this
   * candidate is persisted. Absent on game-vertical candidates and on any ai_drama candidate that
   * was rejected/held (those are never written — see AI_DRAMA_RELEVANCE_AUDIT_COLLECTION instead). */
  aiDramaRelevance?: AiDramaRelevanceStamp;
  publicDescription?: string;
  matchedSearchTerms?: string[];
  canonicalProgramId?: string;
  programId?: string;
  programRef?: string;
  campaignId?: string;
  campaignRef?: string;
  sourceRunId?: string;
  sourceRunRef?: string;
  stage?: string;
  eligibility?: Record<string, unknown>;
  programScopeEvidence?: Record<string, unknown>;
  candidateProvenance?: Record<string, unknown>;
  criteriaHash?: string;
  policyHash?: string;
  /** W9-1 transient reward attribution; removed before any return or Firestore write. */
  __sliceType?: DiscoverySliceType;
};

/**
 * W75: 섀도 관측은 검색 결과를 다시 검색하지 않고 채널 hydration 입력으로만 쓴다.
 * queryTerms 는 해당 채널을 실제로 관측한 yt-dlp 검색어다. 이 값이 기존 keyword 분류·정책
 * 필터의 검색 귀속 근거가 되며, 채널 title/URL 은 증거 표시용일 뿐 신원·메타데이터 정본은 channels.list 다.
 */
export type YtdlpPromotionObservedChannel = {
  channelId: string;
  channelUrl: string;
  title: string;
  queryTerms: string[];
  videoIds: string[];
  latestVideoPublishedAtIso?: string;
};

type EmailFinderStored = {
  candidateRef: string;
  channelRef: string;
  email: string | null;
  status: "verified" | "guessed" | "none";
  source: "about" | "video_description" | "public_scrape" | "none";
  confidence: number;
};

type EmailFinderResult = {
  candidateRef: string;
  channelRef: string;
  emailRef: string;
  maskedEmail: string | null;
  status: "verified" | "guessed" | "none";
  sourceRef: string;
  confidence: number;
};

const MOCK_CANDIDATES: CandidateResult[] = [
  {
    candidateRef: "candidate_pool/p1",
    channelRef: "yt_channel_bento_plays",
    name: "Bento Plays",
    handle: "@bentoplays",
    avatar: "🍱",
    platform: "YouTube",
    followers: 320000,
    region: "US",
    category: "Casual",
    matchScore: 89,
    confidence: 96,
    signals: ["keyword", "followers", "region", "recentActivity"],
  },
  {
    candidateRef: "candidate_pool/p2",
    channelRef: "yt_channel_luna_mobile",
    name: "Luna Mobile",
    handle: "@lunamobile",
    avatar: "🌙",
    platform: "YouTube",
    followers: 180000,
    region: "BR",
    category: "Hyper Casual",
    matchScore: 85,
    confidence: 92,
    signals: ["keyword", "region", "recentActivity"],
  },
  {
    candidateRef: "candidate_pool/p3",
    channelRef: "yt_channel_pixelhan",
    name: "PixelHan",
    handle: "@pixelhan",
    avatar: "🎮",
    platform: "YouTube",
    followers: 540000,
    region: "KR",
    category: "Mid-core",
    matchScore: 83,
    confidence: 61,
    signals: ["followers", "region", "recentActivity"],
  },
];

const MOCK_EMAILS: Record<string, EmailFinderStored> = {
  yt_channel_bento_plays: {
    candidateRef: "candidate_pool/p1",
    channelRef: "yt_channel_bento_plays",
    email: generatedExampleEmail("yt-channel-bento-plays"),
    status: "verified",
    source: "about",
    confidence: 96,
  },
  yt_channel_luna_mobile: {
    candidateRef: "candidate_pool/p2",
    channelRef: "yt_channel_luna_mobile",
    email: generatedExampleEmail("yt-channel-luna-mobile"),
    status: "verified",
    source: "video_description",
    confidence: 92,
  },
  yt_channel_pixelhan: {
    candidateRef: "candidate_pool/p3",
    channelRef: "yt_channel_pixelhan",
    email: generatedExampleEmail("yt-channel-pixelhan"),
    status: "guessed",
    source: "public_scrape",
    confidence: 61,
  },
};

function assertRole(request: CallableRequest): GuardContext {
  const role = request.auth?.token?.role ?? "guest";

  if (!request.auth?.uid || role === "guest") {
    const error = new Error(!request.auth?.uid ? "unauthenticated" : "permission-denied: guest role cannot call discovery engines");
    Object.assign(error, { code: !request.auth?.uid ? "unauthenticated" : "permission-denied" , errorCode: "assert_role_unauthorized"});
    throw error;
  }

  return {
    userId: request.auth.uid,
    role,
    team: request.auth?.token?.team ?? "unassigned",
    ip: request.rawRequest?.ip ?? "0.0.0.0",
  };
}

function requireDiscoveryWriteRole(request: CallableRequest, resource: string): GuardContext {
  const context = assertRole(request);
  if (context.role !== "super_admin" && context.role !== "admin" && context.role !== "manager") {
    throw permissionDenied(`${resource} requires a manager or admin role`);
  }
  return context;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown, fallback?: string): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : undefined;
}

function stableRef(prefix: string, seed: string | undefined): string {
  const safeSeed = seed ?? "default";
  let hash = 0;

  for (let index = 0; index < safeSeed.length; index += 1) {
    hash = (hash * 31 + safeSeed.charCodeAt(index)) >>> 0;
  }

  return `${prefix}_${hash.toString(36)}`;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const next = asNumber(value) ?? fallback;
  return Math.max(min, Math.min(Math.trunc(next), max));
}

function readDiscoveryRecentActivityDays(value: unknown, discoveryVertical: DiscoveryVertical, fallback: number): number {
  const numeric = asNumber(value);
  if (numeric === undefined) return discoveryVertical === "ai_drama" ? 0 : fallback;
  return boundedInt(numeric, fallback, discoveryVertical === "ai_drama" ? 0 : 1, 90);
}

function readYoutubeData(data: unknown): ParsedYoutubeSearchData {
  const record = asRecord(data);
  const filters = asRecord(record.filters);
  const discoveryVertical = normalizeDiscoveryVertical(record.discoveryVertical ?? filters.discoveryVertical);

  return {
    queryRef: asString(record.queryRef) ?? stableRef("dq", asString(record.query)),
    campaignRef: asString(record.campaignRef) ?? "campaign_mock_discovery",
    gameId: asString(record.gameId) ?? "game_unknown",
    resultLimit: boundedInt(record.resultLimit, 50, 1, DISCOVERY_RESULT_LIMIT_MAX),
    countryTargeting: readDiscoveryCountryTargeting(record, filters),
    filters: {
      regions: asStringArray(filters.regions) ?? [],
      categories: asStringArray(filters.categories) ?? [],
      categoriesExplicit: owns(filters, "categories"),
      minFollowers: asNumber(filters.minFollowers) ?? 0,
      recentActivityDays: readDiscoveryRecentActivityDays(filters.recentActivityDays, discoveryVertical, 30),
    },
    discoveryVertical,
    minVideoViews: boundedInt(record.minVideoViews ?? filters.minVideoViews, 0, 0, 100_000_000),
    minVideoCount: boundedInt(record.minVideoCount ?? filters.minVideoCount, 0, 0, 100),
  };
}

function readEmailFinderData(data: unknown): ParsedEmailFinderData {
  const record = asRecord(data);
  // Raw YouTube lookup identifier, in priority order: explicit channel/handle/queryRef field,
  // or a channelId recovered from a "yt_channel_<id>" channelRef produced by youtubeSearch.
  const rawChannel = asString(record.channel) ?? asString(record.handle) ?? asString(record.queryRef);
  const channelRef = asString(record.channelRef) ?? stableRef("yt_channel", rawChannel);
  const channelHint = rawChannel
    ?? (channelRef.startsWith("yt_channel_") ? channelRef.slice("yt_channel_".length) : undefined);

  return {
    channelRef,
    candidateRef: asString(record.candidateRef) ?? `candidate_pool/${channelRef}`,
    gameId: asString(record.gameId) ?? "game_unknown",
    channelHint,
  };
}

function readDiscoveryCountryTargeting(
  record: Record<string, unknown>,
  filters: Record<string, unknown> = {},
): CountryTargeting {
  const recordOwnsScope = owns(record, "countryTargeting") || owns(record, "targetCountries");
  const filterOwnsScope = owns(filters, "countryTargeting") || owns(filters, "targetCountries");
  const filtersOwnLegacyRegions = owns(filters, "regions");
  const recordPolicy = countryTargetingFromLegacy(record);
  const filterPolicy = filterOwnsScope
    ? countryTargetingFromLegacy(filters)
    : filtersOwnLegacyRegions
      ? countryTargetingFromLegacy(filters, { targetCountriesKey: "regions" })
      : countryTargetingFromLegacy(filters);
  const selected = recordOwnsScope
    ? recordPolicy
    : filterOwnsScope || filtersOwnLegacyRegions
      ? filterPolicy
      : countryTargetingFromLegacy({});
  return {
    ...selected,
    excludedCountries: Array.from(new Set([
      ...selected.excludedCountries,
      ...recordPolicy.excludedCountries,
      ...filterPolicy.excludedCountries,
    ])),
  };
}

/** R27: 잡/런 문서(또는 raw callable data)에 실린 sliceArmSlots 를 방어적으로 파싱한다 — 셋 다 유한
 * 음이 아닌 정수가 아니면 통째로 무시한다(부분 손상 값으로 잘못된 배분을 만들지 않는다, fail-closed
 * to undefined = keyword-only 폴백). */
function readDiscoverySliceArmSlots(value: unknown): DiscoverySliceArmSlots | undefined {
  const record = asRecord(value);
  const keyword = asNumber(record.keyword);
  const broad = asNumber(record.broad);
  const topic = asNumber(record.topic);
  if (keyword === undefined || broad === undefined || topic === undefined) return undefined;
  if (keyword < 0 || broad < 0 || topic < 0) return undefined;
  return { keyword: Math.trunc(keyword), broad: Math.trunc(broad), topic: Math.trunc(topic) };
}

function readYtDlpDiscoveryData(data: unknown): ParsedYtDlpDiscoveryData {
  const record = asRecord(data);
  const filters = asRecord(record.filters);
  const candidateCriteriaSnapshot = asRecord(record.candidateCriteriaSnapshot);
  const keywords = asStringArray(record.keywords)
    ?? asStringArray(filters.keywords)
    ?? ["mobile game shorts", "hyper casual gameplay", "casual game gameplay"];
  const discoveryVertical = readOwnedDiscoveryVertical([record, filters, candidateCriteriaSnapshot]);
  const keywordLimit = discoveryVertical === "ai_drama" ? 40 : 12;

  return {
    campaignId: asString(record.campaignId),
    campaignRef: asString(record.campaignRef) ?? (asString(record.campaignId) ? `campaigns/${asString(record.campaignId)}` : "campaigns/yt_dlp_discovery"),
    gameId: asString(record.gameId) ?? "flu-casual",
    keywords: keywords.slice(0, keywordLimit),
    countryTargeting: readDiscoveryCountryTargeting(record, filters),
    filters: {
      regions: asStringArray(filters.regions) ?? [],
      categories: asStringArray(filters.categories) ?? [],
      categoriesExplicit: owns(filters, "categories"),
      excludeKeywords: asStringArray(filters.excludeKeywords) ?? [],
      minFollowers: boundedInt(filters.minFollowers, 0, 0, 100_000_000),
      // W21 F-2: 운영자가 "무상한" 의도로 저장한 maxFollowers=0(프로드 cp-bd7d1ea7aq4k 실측)이 하한 1
      // 클램프에 걸려 1 이 되고, 소비부(candidateMatchesYtDiscovery)가 `followers > 1` 을 전부 거부해
      // 이메일 백필 레인이 그 캠페인에서 통째로 0건이었다. 소비부에 이미 `> 0` 가드가 있으므로 0 은
      // 그대로 흘려보낸다. 음수·비수치는 종전 클램프 동작을 유지한다(0 만 특별 취급).
      maxFollowers: asNumber(filters.maxFollowers) === 0
        ? 0
        : boundedInt(filters.maxFollowers, 20_000_000, 1, 100_000_000),
      recentActivityDays: readDiscoveryRecentActivityDays(filters.recentActivityDays, discoveryVertical, 7),
    },
    resultLimit: boundedInt(record.resultLimit, 50, 5, DISCOVERY_RESULT_LIMIT_MAX),
    commentLimit: boundedInt(record.commentLimit, 5, 0, 50),
    includeComments: asBoolean(record.includeComments, true),
    sliceArmSlots: readDiscoverySliceArmSlots(record.sliceArmSlots),
    lexicon: (asStringArray(record.lexicon) ?? []).slice(0, 100),
    discoveryVertical,
    minVideoViews: readOwnedPositiveInteger(
      [record, filters, candidateCriteriaSnapshot],
      ["minVideoViews", "minQualifyingVideoViews", "minimumVideoViews"],
      0,
      0,
      100_000_000,
    ),
    minVideoCount: readOwnedPositiveInteger(
      [record, filters, candidateCriteriaSnapshot],
      ["minVideoCount", "minQualifyingVideoCount", "minimumVideoCount"],
      0,
      0,
      100,
    ),
  };
}

function normalizeCommunitySource(value: string): CommunitySource | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "reddit") return "reddit";
  if (normalized === "discord") return "discord";
  if (normalized === "x" || normalized === "twitter") return "x";
  if (normalized === "web" || normalized === "public web" || normalized === "insane-search") return "web";
  if (normalized === "steam") return "steam";
  return null;
}

type FeedSettingsInput = {
  ownedGameTags?: string[];
  similarGameTags?: string[];
  ugcKeywords?: string[];
  communitySubreddits?: string[];
  officialChannels?: string[];
  steamAppIds?: string[];
  steamLanguage?: string;
  communityRefreshHours?: number;
  platforms?: string[];
  freshnessDays?: number;
};

function normalizeSteamAppIds(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const appIds: string[] = [];
  for (const value of values ?? []) {
    const appId = value.trim().replace(/[^0-9]/g, "");
    if (!appId || seen.has(appId)) continue;
    seen.add(appId);
    appIds.push(appId);
    if (appIds.length >= 12) break;
  }
  return appIds;
}

function normalizeSteamLanguage(value: string | undefined): string {
  const language = value?.trim() || "all";
  return /^[a-z][a-z0-9_-]{0,31}$/i.test(language) ? language : "all";
}

function readCommunityDiscoveryData(data: unknown, feedSettings: FeedSettingsInput = {}): ParsedCommunityDiscoveryData {
  const record = asRecord(data);
  const filters = asRecord(record.filters);
  const rawSources = asStringArray(record.sources) ?? asStringArray(filters.platforms) ?? ["reddit", "discord", "x", "web"];
  const sources = rawSources
    .map(normalizeCommunitySource)
    .filter((source): source is CommunitySource => Boolean(source));
  const brief = asString(record.brief) ?? "";
  const keywords = asStringArray(record.keywords)
    ?? asStringArray(filters.keywords)
    ?? brief
      .split(/[^a-zA-Z0-9가-힣+#._-]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2)
      .slice(0, 8);

  return {
    programId: asString(record.programId),
    campaignId: asString(record.campaignId),
    campaignRef: asString(record.campaignRef) ?? (asString(record.campaignId) ? `campaigns/${asString(record.campaignId)}` : "campaigns/community_discovery"),
    gameId: asString(record.gameId) ?? "flu-casual",
    brief,
    keywords: (keywords.length > 0 ? keywords : ["Supercent", "mobile game", "casual game"]).slice(0, 12),
    ownedGameTags: (
      asStringArray(record.ownedGameTags)
      ?? asStringArray(filters.ownedGameTags)
      ?? feedSettings.ownedGameTags
      ?? []
    ).slice(0, 32),
    similarGameTags: (
      asStringArray(record.similarGameTags)
      ?? asStringArray(filters.similarGameTags)
      ?? feedSettings.similarGameTags
      ?? []
    ).slice(0, 32),
    ugcKeywords: (
      asStringArray(record.ugcKeywords)
      ?? asStringArray(filters.ugcKeywords)
      ?? feedSettings.ugcKeywords
      ?? []
    ).slice(0, 16),
    communitySubreddits: (
      asStringArray(record.communitySubreddits)
      ?? asStringArray(filters.communitySubreddits)
      ?? feedSettings.communitySubreddits
      ?? []
    ).slice(0, 12),
    officialChannels: (
      asStringArray(record.officialChannels)
      ?? asStringArray(filters.officialChannels)
      ?? feedSettings.officialChannels
      ?? []
    ).slice(0, 32),
    steamAppIds: normalizeSteamAppIds(feedSettings.steamAppIds),
    steamLanguage: normalizeSteamLanguage(
      asString(record.steamLanguage)
      ?? asString(filters.steamLanguage)
      ?? feedSettings.steamLanguage,
    ),
    communityRefreshHours: boundedInt(record.communityRefreshHours ?? filters.communityRefreshHours, feedSettings.communityRefreshHours ?? 24, 1, 168),
    sources: sources.length > 0 ? sources : ["reddit", "discord", "x", "web"],
    filters: {
      regions: asStringArray(filters.regions) ?? [],
      categories: asStringArray(filters.categories) ?? [],
      recentActivityDays: boundedInt(filters.recentActivityDays, 30, 1, 90),
    },
    resultLimit: boundedInt(record.resultLimit, 50, 5, DISCOVERY_RESULT_LIMIT_MAX),
    includeComments: asBoolean(record.includeComments, true),
  };
}

// Expensive-call TTL: 1h, matching the company LLM/expensive-call cache rule.
const DISCOVERY_CACHE_TTL_SECONDS = 3600;
const DISCOVERY_RESULT_LIMIT_MAX = 1_000;
const DISCOVERY_WORKER_YOUTUBE_SEARCH_LIMIT = 1_000;
export const COMMUNITY_DISCOVERY_ARTIFACT_BATCH_LIMIT = 400;
// W63 델타 M6: 잡 타입 정본은 의존 없는 리프 모듈이 소유한다(functions/discoveryJobTypes.ts).
//   섀도 프로듀서가 여기서 import 하면 firebase-admin 을 통째로 끌고 오기 때문이다 —
//   "프로듀서는 순수 함수"라는 단정이 소스 텍스트로는 통과하면서 **전이 의존**으로 깨진다.
//   기존 import 경로를 유지하려고 re-export 도 남긴다.
import {
  COMMUNITY_DISCOVERY_JOB_TYPE,
  LIVE_DISCOVERY_JOB_TYPES,
  SHADOW_DISCOVERY_JOB_TYPE,
  YOUTUBE_CHANNEL_LOOKUP_LIMIT,
  YOUTUBE_CHANNELS_LIST_BATCH_SIZE,
  YOUTUBE_HYDRATION_UNIT_BUDGET_PER_RUN,
} from "./discoveryJobTypes";
// W115: 발굴 경제학(유닛 단가·프리필터 정책·수율 귀속)의 정본. 이 모듈도 import 가 없는 리프라
//   여기서 가져와도 의존 그래프가 늘지 않는다 — admin.ts 와 규칙을 공유하되 복제하지 않는다.
import {
  accumulateSegmentEmailCounts,
  attributeLaneCostYield,
  EMPTY_SEGMENT_EMAIL_COUNTS,
  KNOWN_CHANNEL_EMAIL_NONE_REVISIT_MS,
  KNOWN_CHANNEL_LOOKUP_BATCH_SIZE,
  partitionHydrationTargets,
  planVideoDescriptionBackfill,
  publishSegmentEmailRates,
  rankHydrationTargetsBySegment,
  SEGMENT_EMAIL_RATE_KEY_VERSION,
  SEGMENT_EMAIL_RATE_SCAN_INTERVAL_MS,
  SEGMENT_EMAIL_RATE_SCAN_PAGE_LIMIT,
  VIDEO_DESCRIPTION_BACKFILL_UNIT_BUDGET_PER_RUN,
  VIDEO_DESCRIPTION_SAMPLE_PER_CHANNEL,
  YOUTUBE_CHANNELS_UNITS_PER_CALL,
  YOUTUBE_SEARCH_UNITS_PER_CALL,
  YOUTUBE_VIDEOS_UNITS_PER_CALL,
  type EmailSourceKind,
  type KnownChannelRecord,
  type LaneCostYield,
  type LaneObservation,
  type SegmentEmailCounts,
  type SegmentEmailRateTable,
} from "./discoveryEconomics";
export {
  COMMUNITY_DISCOVERY_JOB_TYPE,
  SHADOW_DISCOVERY_JOB_TYPE,
  LIVE_DISCOVERY_JOB_TYPES,
} from "./discoveryJobTypes";
export const COMMUNITY_DISCOVERY_MAX_ATTEMPTS = 4;
export const COMMUNITY_PUBLICATION_CONTRACT_VERSION = "community-publication-generation/v1" as const;
const COMMUNITY_DISCOVERY_LEASE_MS = 8 * 60 * 1000;
const COMMUNITY_DISCOVERY_GLOBAL_SCOPE = "__global__";
const YOUTUBE_SEARCH_MAX_PAGES = 20;
// W112 F-A (헤세 배정, 발굴 공급 레버): 100 → 300. 정본은 의존 없는 리프 모듈
//   `discoveryJobTypes.ts` 가 소유한다 — ytdlpPromotionCore 가 같은 상한을 하드코딩으로 따로
//   들고 있어 상향 때 그쪽만 옛 값에 남는 드리프트가 실제로 났기 때문이다(적대 리뷰 실측).
//   근인: 검색이 **이미 쿼터를 지불하고 관측한** 채널의 57%가 조회 없이 폐기됐다
//   (최근 2일 hydrationSeen 10,444 → dropped 5,948). channels.list 는 50개/콜·1유닛이라
//   300 이면 런당 6콜(6유닛) — 종전 2유닛 대비 +4.
//   ⚠️ 쿼터 회계 정정(적대 리뷰): 이 +4 는 "유휴 비검색 버킷"이 아니라 **검색과 공유하는
//   레거시 풀**(apiQuota bySlot, search=100/콜·channels=1/콜)에 실린다. 실측상 슬롯 1~3은
//   이미 10,000 초과, 슬롯 0은 08-18 에 소진돼 그날 전체가 blockedGlobally 였다. 즉 여유가
//   넉넉한 풀이 아니다 — 프로드 실측 때 newUnique 뿐 아니라 슬롯 0 remainingUnits 와
//   blockedGlobally 발생 빈도를 함께 봐야 한다.
//   ⚠️ 절단 세 갈래(밴딧·보조 인터리브·폴백 slice)와 fail-closed 불변식
//   (hydration_lookup_cap_exceeded)이 이 심볼을 공유한다(W63 델타 M1).
export { YOUTUBE_CHANNEL_LOOKUP_LIMIT };
// W9-3 [리더 확정 전제 — W59-6 에서 **전제 소멸**]: 이 그래프 레인은 "검색 콜을 한 건도 추가하지
// 않는다"를 설계 전제로 만들어졌다. 근거는 "Search Queries 는 100콜/일/프로젝트로 이미 천장"이었고,
// 그때 우리는 그 천장을 **배치 전체에 하나**로 읽고 있었다.
// 전제 소멸 근거(리더 확인 2026-08-09, 헤세 지시): 등록된 키 4개(YOUTUBE_API_KEY + FALLBACK_1~3)는
// **서로 다른 4개 GCP 프로젝트** 소속이다. Search Queries 버킷은 프로젝트 단위이므로 실제 천장은
// 100 이 아니라 400콜/일(= 콜당 50건 × 400 ≈ 일 20,000건 원시)이다. 그 4버킷을 실제로 소진시키는
// 슬롯 회전은 youtubeLaneKeys/withSearchBucketBudget(W59-6)이 담당한다.
// 이 레인 자체는 **그대로 둔다**: 검색을 안 쓰는 유입 경로는 검색 천장이 올라가도 여전히 공짜이고,
// W9-5 프로버넌스에서 검색·인기차트 산출물과 분리 계측되는 독립 축이다(효과 판정 근거가 섞이면 안 된다).
// 즉 바뀐 것은 "검색을 늘릴 수 없다"는 제약이지 이 레인의 존재 이유가 아니다.
// 한 pass 비용 = seed 수(≤10유닛) + 이웃 hydrate(≤1유닛). 같은 시드를 매 pass 다시 캐지 않도록
// 시드 문서에 확장 시각만 남기고 그 창(30일) 안에는 다음 시드로 넘어간다.
const YOUTUBE_GRAPH_SEED_SCAN_LIMIT = 50;
const YOUTUBE_GRAPH_SEED_LIMIT = 10;
const YOUTUBE_GRAPH_NEIGHBOR_LIMIT = 50;
const YOUTUBE_GRAPH_SEED_RETRY_MS = 30 * 24 * 60 * 60 * 1000;
/** W9-3: W9-5 프로버넌스에 싣는 유입 경로 라벨 — 효과 판정의 유일한 근거다. */
const CHANNEL_GRAPH_SOURCE = "channel_graph";
// W9-4: 지역 인기 차트 시드 상한. `videos.list(chart=mostPopular)` 는 1유닛에 영상 50개를 주고
// Search Queries 버킷을 쓰지 않는다 — region 당 1콜, pass 당 최대 20콜이다(W21 F-1: 3→20).
// 비검색 버킷은 하루 40,000유닛 중 276유닛(0.7%)만 쓰고 있어 이 상향의 몫은 0.4% 수준이다.
const YOUTUBE_POPULAR_REGION_LIMIT = 20;
const YOUTUBE_POPULAR_SEED_LIMIT = 50;
/**
 * W9-4: 이 시드는 **head-biased** 다 — 지역 인기 차트 상위이지 long-tail 신규 발굴이 아니다.
 * 라벨을 별도로 두어 프로버넌스에서 검색·그래프 산출물과 절대 섞이지 않게 한다.
 */
const POPULAR_SEED_SOURCE = "most_popular";
const YOUTUBE_API_FETCH_TIMEOUT_MS = 5_000;
const DISCOVERY_QUEUE_SCAN_LIMIT = 500;
const DISCOVERY_QUEUE_SWEEP_LIMIT = 2;
const DISCOVERY_RETRY_BACKOFF_MS = 60 * 60 * 1000;
const DISCOVERY_STALE_RECOVERY_LIMIT = 3;
const DISCOVERY_WORKER_MATERIALIZE_DEADLINE_MS = 120_000;
// The operational pool is larger than the old newest-1,000 window. Keep each network
// pass bounded to 30 pages, but let selection advance across the whole current pool so
// older eligible candidates are not permanently starved.
const PUBLIC_WEB_EMAIL_BACKFILL_LIMIT = 5_000;
const PUBLIC_WEB_EMAIL_BACKFILL_FETCH_LIMIT = 30;
const PUBLIC_WEB_EMAIL_BACKFILL_CONCURRENCY = 20;
const PUBLIC_WEB_EMAIL_BACKFILL_DEADLINE_MS = 20_000;
const PUBLIC_WEB_FETCH_TIMEOUT_MS = 2_000;
const PUBLIC_WEB_EMAIL_BACKFILL_RETRY_MS = 24 * 60 * 60 * 1000;
const DISCOVERY_PROCESSING_STALE_MS = 3 * 60 * 1000;

type CommunityDiscoveryWriteBatch = Pick<WriteBatch, "set" | "commit">;
export type CommunityDiscoveryArtifactWrite = (batch: CommunityDiscoveryWriteBatch) => void;

/**
 * Commits idempotent merge writes in bounded, sequential Firestore batches.
 * Completion records are deliberately not accepted here; callers must write them
 * only after this function resolves so a partial artifact failure cannot look done.
 */
export async function commitCommunityDiscoveryArtifactWrites(
  writes: readonly CommunityDiscoveryArtifactWrite[],
  createBatch: () => CommunityDiscoveryWriteBatch = () => adminDb.batch(),
  options: {
    beforeChunk?: (input: { chunkIndex: number; offset: number; size: number }) => Promise<void>;
    afterChunk?: (input: { chunkIndex: number; offset: number; size: number }) => Promise<void>;
  } = {},
): Promise<number[]> {
  const committedChunkSizes: number[] = [];
  for (let offset = 0; offset < writes.length; offset += COMMUNITY_DISCOVERY_ARTIFACT_BATCH_LIMIT) {
    const chunk = writes.slice(offset, offset + COMMUNITY_DISCOVERY_ARTIFACT_BATCH_LIMIT);
    const chunkInput = { chunkIndex: committedChunkSizes.length, offset, size: chunk.length };
    await options.beforeChunk?.(chunkInput);
    const batch = createBatch();
    for (const write of chunk) write(batch);
    await batch.commit();
    await options.afterChunk?.(chunkInput);
    committedChunkSizes.push(chunk.length);
  }
  return committedChunkSizes;
}

export function communityDiscoveryCompletionSummary(
  reports: readonly Pick<CommunitySourceReport, "sourceKey" | "status">[],
): { status: "complete" | "partial"; blockedSources: number } {
  const incompleteSourceStatuses = new Set(["error", "blocked", "auth_required"]);
  const incompleteSourceReports = reports.filter((report) => incompleteSourceStatuses.has(report.status));
  return {
    status: incompleteSourceReports.length > 0 ? "partial" : "complete",
    blockedSources: new Set(incompleteSourceReports.map((report) => report.sourceKey)).size,
  };
}

// R21-1: 폴백 슬롯 3개. 리더가 시크릿 4개를 등록·검증했는데 코드가 2·3 을 읽지 않아 쓰이지 않았다
// (로테이션 로직은 이미 있었다 — 막힌 것은 목록 길이 하나였다).
// 스테이징은 대칭 이름을 두되 값이 없으면 youtubeApiKeys() 가 걸러낸다(주 키만 필수).
const PRODUCTION_YOUTUBE_SECRET_NAMES = [
  "YOUTUBE_API_KEY",
  "YOUTUBE_API_KEY_FALLBACK_1",
  "YOUTUBE_API_KEY_FALLBACK_2",
  "YOUTUBE_API_KEY_FALLBACK_3",
] as const;
const STAGING_YOUTUBE_SECRET_NAMES = [
  "FLU_STAGING_YOUTUBE_API_KEY",
  "FLU_STAGING_YOUTUBE_API_KEY_FALLBACK_1",
  "FLU_STAGING_YOUTUBE_API_KEY_FALLBACK_2",
  "FLU_STAGING_YOUTUBE_API_KEY_FALLBACK_3",
] as const;
const YOUTUBE_GAMING_CATEGORY_ID = "20";
const YOUTUBE_GAMING_TOPIC_ID = "/m/0bzvm2";
const YOUTUBE_GAMING_SUBGENRE_TOPIC_IDS: Record<string, string> = {
  action: "/m/025zzc",
  rpg: "/m/0403l3g",
  "role playing": "/m/0403l3g",
  strategy: "/m/03hf_rm",
  racing: "/m/01sjng",
  simulation: "/m/021bp2",
  sim: "/m/021bp2",
  sports: "/m/022dc6",
  puzzle: "/m/04q1x3q",
};

/**
 * R21-2/W9-0-FIX2: `discovery` 검색은 폴백 키부터 쓰고 주 키(슬롯 0)의 추적 예약분을 침범하지 않는다.
 * 단, 이미 수집한 ID를 잃지 않도록 1유닛 `channels.list` 조회만 폴백 소진 뒤 주 키를 마지막으로 쓸 수 있다.
 * 그 외(추적·보강)는 종전 순서(주 키 우선) 그대로다 — 정산 측정이 최우선이라는 사용자 지시.
 */
export type YoutubeQuotaLane = "discovery" | "default";
// Flu/W2: poolId is set only when the caller resolved a non-growth org pool (e.g. T049's
// "drama_1") — absent/undefined means growth, exactly like every pre-W2 keyState literal in this
// file (`{ index: 0, lane: "discovery" }`), so those call sites keep 100% growth behavior.
// 인시던트 2026-09-29 Codex 리뷰 #2: 항목별 poolId — 대부분의 항목(own-pool 키)은 비워 두고
// fetchYouTubeRecord 가 바깥 keyState.poolId 로 폴백한다(종전과 바이트 단위로 동일). 차용된
// growth 키를 담은 항목만 명시적으로 poolId 를 "growth" 로 찍어, 그 항목이 성공/실패했을 때
// 계상이 drama_1 이 아니라 growth 원장으로 가게 한다(50% 잔여율 판정이 실제 소비를 반영해야 한다).
type YoutubeLaneKeyEntry = { key: string; slot: number; poolId?: string };
// 인시던트 2026-09-29 Codex 리뷰 #3: forcedKeys 는 fetchYouTubeRecord 자신의 재시도 1회 전용
// 내부 채널이다 — 라이브 429 로 own-pool 전 키가 소진된 뒤, selectYoutubeApiKey 로 얻은 차용
// 키 하나로 재귀 호출할 때만 채운다. 일반 호출부는 절대 이 필드를 채우지 않는다(선언만 하고
// 방치 — 옵셔널). ⚠️ 재귀 가드는 이 필드가 아니라 아래 borrowRetried 가 진다 — forcedKeys 는
// 테스트가 (실제 Firestore 없이) **첫** 시도의 키를 직접 주입하는 용도로도 쓰이므로, forcedKeys
// 존재 자체를 "이미 재시도했다"로 겹쳐 쓰면 그 주입 경로에서 재시도 로직 자체를 검증할 수 없다.
type YoutubeKeyState = {
  index: number;
  lane?: YoutubeQuotaLane;
  poolId?: string;
  forcedKeys?: YoutubeLaneKeyEntry[];
  /** 인시던트 2026-09-29 Codex 리뷰 #3: 이 fetchYouTubeRecord 호출 체인에서 crossBorrow 재시도를
   * 이미 한 번 썼다 — 무한 재귀 방지(호출당 최대 1회). 일반 호출부는 채우지 않는다. */
  borrowRetried?: boolean;
};

/**
 * R21-2/W9-0-FIX2: 레인별 키 순서. fetchYouTubeRecord 는 현재 인덱스부터 이 배열을 한 바퀴만 순회한다.
 * 발굴 검색은 폴백 1/2/3 → (예약분에 여유가 있을 때만) 주 키 순이다. `channels.list` 조회는 이미 태운
 * 검색 산출물을 보존하기 위해 가드가 닫혀도 폴백 1/2/3 → 주 키 순을 유지한다. 반환값의 slot 은 계측용
 * 인덱스다(키 원문은 key 에만, 로그·문서 금지 — SEC-P0-009).
 *
 * W59-6 [4-프로젝트 쿼터 활용]: 키 4개는 **서로 다른 4개 GCP 프로젝트**이므로 Search Queries 버킷도
 * 4개(100콜/일/슬롯)다. 그 소진 판정은 여기서 하지 않는다 — 이 배열의 **길이는 계약**이기 때문이다.
 * keyState.index 가 이 배열의 위치이고 R22-4 는 "index 가 배열 밖이면 시도 0회"를 소진 신호로 쓴다.
 * 버킷 상태로 길이를 흔들면 멀쩡한 키를 두고 그 경로가 오발화하고, 실패 후 index 전진이 남은 슬롯을
 * 건너뛴다. 그래서 슬롯 소진은 **배열에서 빼지 않고** fetchYouTubeRecord 루프 안에서 건너뛴다.
 */
// Flu/W2: a resolved non-growth org pool (e.g. T049's "drama_1") never shares growth's GCP
// projects, so none of growth's key-rotation policy below (primary-key reserve, search-first
// fallback ordering) applies to it — that policy exists only to protect growth's own activity-
// tracking reservation (R21-2) on growth's own keys. Returns the pool's configured keys in
// settings/youtube_quota_pools order, skipping unset/blank secrets (mirrors youtubeApiKeys()'s
// own filter). No caller passes a poolId here unless it already resolved one via
// resolvePoolIdForOrg — growth (the default) always takes the unchanged branch below.
// 인시던트 2026-09-29 (오너 결정: "Growth 쿼터 빌려쓰기"): 이 풀 자신의 키가 (원장 기준) 소진이면
// selectYoutubeApiKey 로 넘긴다 — own-pool 우선 판정 · 차용 허용 판정(minLenderRemainingRatio ·
// dailyBorrowCapCalls) · 차용 기록(recordBorrowAttempt/recordBorrowGrant)을 그 함수가 이미 전부
// 한다(재구현 없음). deps 는 노드 레인 테스트 전용 주입구다 — 프로덕션 호출(youtubeLaneKeys, 아래)은
// deps 없이 불러 종전과 동일하게 실제 원장(adminDb)을 읽는다.
export async function youtubePoolLaneKeys(
  poolId: string,
  deps: Pick<SelectYoutubeApiKeyInput, "db" | "readSlotUnitsUsed" | "now"> = {},
): Promise<YoutubeLaneKeyEntry[]> {
  const pools = await readYouTubeQuotaPools({ db: deps.db });
  const config = pools.pools[poolId];
  if (!config) return [];
  // Preflight returns borrower-owned keys only. Borrowing here would spend a lender grant before
  // the caller knows the operation, its cost, or whether its staging reservation will pass.
  return config.apiKeySecretNames
    .map((name, slot) => ({ key: envSecret(name), slot }))
    .filter((entry) => entry.key.trim().length > 0);
}

async function youtubeLaneKeys(
  lane: YoutubeQuotaLane | undefined,
  operation: string,
  poolId?: string,
): Promise<YoutubeLaneKeyEntry[]> {
  if (poolId && poolId !== YOUTUBE_GROWTH_POOL_ID) return youtubePoolLaneKeys(poolId);
  const keys = youtubeApiKeys().map((key, slot) => ({ key, slot }));
  if (lane !== "discovery") return keys;
  const [primary, ...fallbacks] = keys;
  // W59d-F5 [리뷰 · 슬롯 0 제외 우회]: 종전에는 `keys.length <= 1` 조기 반환이 **제외보다 먼저** 있어,
  // 폴백 키가 하나도 바인딩되지 않은 환경(시크릿 미설정·부분 롤아웃)에서 발굴 검색이 주 키를 그대로
  // 썼다 — C1 이 막으려던 조회수 추적 예약분 침범이 정확히 그 조건에서 되살아난다.
  // 그래서 **제외를 조기 반환보다 먼저** 적용한다: search 에 남는 슬롯이 없으면 빈 배열을 돌려주고,
  // fetchYouTubeRecord 의 R22-4 "시도 0회" 경로가 quotaLimited 로 세워 R21-4 인계로 넘긴다
  // (주 키를 태우느니 검색을 멈추는 쪽이 맞다 — 정산 측정이 최우선이라는 R21-2 사용자 제약).
  if (operation === "search") return fallbacks;
  if (keys.length <= 1) return keys;
  // W115-R1 [MEDIUM · 적대 리뷰]: `channels.list` 도 주 키 예약분 가드를 통과해야 한다.
  //   종전에는 이 레인만 무조건 주 키를 꼬리에 달았다 — 콜당 1유닛이라 무해하다는 전제였는데,
  //   A1 이 hydration 상한을 300 → 1,000 으로 올리면서 런당 최대 20콜이 됐고, 5분 워커가 병렬
  //   캠페인을 돌리면 하루 수천 유닛이 조회수 추적 예약분(2,000유닛)을 그대로 갉는다.
  //   가드가 닫히면 폴백만 쓴다 — hydration 은 검색과 달리 폴백 3슬롯으로 충분하다(1유닛/콜).
  if (operation === "channels") {
    return (await discoveryMayUsePrimaryYoutubeKey()) ? [...fallbacks, primary] : fallbacks;
  }
  // ⚠️ [W60-6 · keyState 순서 전제] 아래 분기들이 만드는 배열의 **길이와 순서는 계약**이다.
  //    fetchYouTubeRecord 는 keyState.index 를 이 배열의 **위치**로 쓰고(한 바퀴 순회), R22-4 는
  //    "index 가 배열 밖 = 시도 0회"를 쿼터 소진 신호로 쓴다. 그래서 여기서 배열을 만들 때는:
  //      · 슬롯을 **거르는** 판정(버킷 소진 등)을 이 함수에서 하지 않는다 — 길이가 흔들리면 같은
  //        keyState 를 들고 다니는 다음 페이지가 남은 슬롯을 건너뛰고, R22-4 가 멀쩡한 키에서 오발화한다.
  //        소진 슬롯은 fetchYouTubeRecord 루프가 **건너뛴다**(W59-6).
  //      · 순서는 R21-2 사용자 제약(폴백 우선·주 키 최후)이 정본이고, 어떤 쿼터 판정도 이를 뒤집지 않는다.
  //    즉 이 함수는 "레인별 **정렬**"만 하고 "가용성 **필터**"는 하지 않는다.
  //
  // W59c-C1 [Codex 적대 리뷰 · CRITICAL]: 발굴 **검색**은 주 키(슬롯 0)를 무조건 제외한다.
  //
  // 종전에는 discoveryMayUsePrimaryYoutubeKey() 가 열려 있으면 폴백 소진 후 주 키까지 썼다. 그런데
  // 그 가드는 **유닛 기준**(잔여 > 2,000 units)이지 콜 기준이 아니다. 내부 모델에서 search=100유닛
  // 이므로 주 키 잔여 8,000유닛은 검색 **80콜**을 그대로 허용한다 — 그 80콜은 실제로는 1유닛짜리라
  // legacy 유닛 원장만 8,000 태우고, 그 사이 activityRefresh(조회수 추적 = CPM 정산 근거)가 굶는다.
  // R21-2 사용자 하드 제약("조회수 쿼터는 가장 중요하니 메인 키에 항상 룸을 남긴다")이 유닛 축의
  // 근사로 지켜지고 있었고, 검색이 그 근사의 구멍이었다.
  // 폴백 3슬롯 × 100콜/일 = 300콜/일은 W59-6 이 여는 처리량으로 충분하다(종전 실효 천장이 그 이하였다).
  // 조건부 허용은 **검색 연산에서만** 폐지한다(위 W59d-F5 분기) — channels.list 와 그 외 1유닛
  // 연산은 종전 그대로다.
  return (await discoveryMayUsePrimaryYoutubeKey()) ? [...fallbacks, primary] : fallbacks;
}

/**
 * W59-6: 이번 호출에서 Search Queries 버킷이 이미 마른 슬롯. 배열에서 빼는 대신 루프가 건너뛴다
 * (위 youtubeLaneKeys 주석 — 배열 길이는 keyState.index 의 계약이다).
 *
 * 게이트는 **발굴 레인의 search 에만** 건다. 추적·보강 레인은 "종전 순서 그대로"가 R21-2 사용자
 * 제약이고, 그 레인의 검색은 pass 예산이 아니라 정산 경로라 여기서 막을 대상이 아니다. 반면 소모
 * **계상**은 레인과 무관하게 한다(버킷은 프로젝트 단위 사실이지 우리 레인 구분이 아니다).
 *
 * 원장 읽기 실패는 fail-open 이다(apiQuota.youtubeSearchSlotBudgets 주석) — 계측 장애가 검색 레인
 * 전면 정지로 번지면 안 된다.
 */
async function exhaustedSearchSlots(
  lane: YoutubeQuotaLane | undefined,
  operation: string,
  keys: readonly YoutubeLaneKeyEntry[],
  poolId?: string,
): Promise<ReadonlySet<number>> {
  // Flu/W2: the process-local search-bucket ledger below (youtubeSearchSlotBudgets) is keyed by
  // slot index only, with no poolId axis — it is growth's own project-quota tracker. A non-growth
  // pool's slot 0 is a different GCP project than growth's slot 0, so checking/skipping against
  // this ledger for a non-growth pool would misread (or corrupt, via the sibling
  // noteYoutubeSearchCallConsumed call in fetchYouTubeRecord) growth's own bucket state. Non-growth
  // pools rely on the same reactive 429/403 handling growth used before W59-6 added this ledger.
  if (poolId && poolId !== YOUTUBE_GROWTH_POOL_ID) return EMPTY_SLOT_SET;
  if (operation !== "search" || lane !== "discovery" || keys.length === 0) return EMPTY_SLOT_SET;
  const budgets = await youtubeSearchSlotBudgets(keys.map((entry) => entry.slot));
  const exhausted = new Set(budgets.filter((budget) => budget.remainingCalls <= 0).map((budget) => budget.slot));
  if (exhausted.size > 0) {
    // ⚠️ 슬롯 **인덱스**만 남긴다 — 키 원문·지문 금지(SEC-P0-009).
    console.info("[youtube-search-quota] search slot buckets exhausted", {
      exhaustedSlots: [...exhausted],
      usableSlots: keys.map((entry) => entry.slot).filter((slot) => !exhausted.has(slot)),
      perSlotDailyCap: YOUTUBE_SEARCH_QUERIES_DAILY_CAP_PER_SLOT,
    });
  }
  return exhausted;
}

const EMPTY_SLOT_SET: ReadonlySet<number> = new Set<number>();
export type YoutubeFetchDependencies = {
  reserve(operation: string): Promise<unknown>;
  fetch(input: URL, init?: RequestInit): Promise<Response>;
  /**
   * W59c-C4: 원장 기록 주입점. 검색 성공/일일소진 기록은 **await 되는 것이 계약**인데(인스턴스가
   * 쓰기 도달 전에 죽으면 그 콜이 durable 원장에서 사라져 다음 인스턴스가 마른 프로젝트를 다시
   * 고른다), fire-and-forget 과의 차이는 타이밍이라 "빨리 읽어 본다"로는 판별되지 않는다
   * (실측: void 로 되돌린 뮤테이션이 green 이었다).
   * 기록을 주입 가능하게 만들어 **완료 전에는 fetchYouTubeRecord 가 resolve 하지 않는다**를 값으로
   * 고정한다. 기본값은 정본 recordYoutubeApiAttempt 이므로 운영 경로는 무변경이다.
   */
  recordAttempt?: typeof recordYoutubeApiAttempt;
  /** 인시던트 2026-09-29 Codex 리뷰 #3: own-pool 전 키가 라이브 429 로 소진된 뒤의 crossBorrow
   * 재확인 전용 주입점(테스트가 실제 Firestore 원장 없이 재시도 분기를 값으로 검증하게 한다).
   * 기본값은 정본 selectYoutubeApiKey 이므로 운영 경로는 무변경이다. */
  selectApiKey?: typeof selectYoutubeApiKey;
};

function assertDiscoveryDeadline(deadlineMs: number, stage: string, minRemainingMs: number) {
  if (Date.now() + minRemainingMs < deadlineMs) return;
  const error = new Error(`Discovery worker deadline reached during ${stage}`);
  Object.assign(error, { code: "deadline-exceeded", errorCode: "assert_discovery_deadline_discovery_worker_deadline_reached_during" });
  throw error;
}

function discoveryCacheDoc(key: string) {
  return adminDb.collection("discovery_cache").doc(key);
}

// Deterministic doc id from the semantic query so identical inputs collide on the same cache doc.
// kind namespaces youtube vs email; the seed folds in the query ref plus the relevance-shaping filters.
function discoveryCacheKey(kind: DiscoveryCacheKind, queryRef: string, seedParts: string[] = []): string {
  return stableRef(`${kind}_cache`, [queryRef, ...seedParts].join("|"));
}

// R27-b [MEDIUM-1 리뷰 실측]: sliceArmSlots(암 배분)를 키에 넣지 않으면, queryRef 가 우연히 같은
// 두 호출(예: materializeYtDiscoveryRun 의 queryRef 폴백이 runId 없이 campaignRef 로 떨어지는
// 손상 문서 경로)에서 keyword 위주 pass 의 캐시가 그 뒤 broad/topic 위주 pass 에 조용히 재사용될
// 수 있다 — 밴딧이 실제로 검색하지 않은 암을 "관측"으로 착각해 EWMA 표본이 오염된다. lexicon 은
// 넣지 않는다 — 우주(키워드 회전)는 sliceArmSlots 와 독립적으로 계속 바뀌는 값이라 캐시 키에 넣으면
// 사실상 매 pass 캐시가 무력화된다(과분화) — sliceArmSlots(3개 정수)만으로 이 사고를 막기에 충분하다.
export function youtubeDiscoveryCacheKey(data: ParsedYoutubeSearchData): string {
  return discoveryCacheKey("youtube", data.queryRef, [
    JSON.stringify(data.countryTargeting),
    data.filters.regions.join(","),
    data.filters.categories.join(","),
    String(data.filters.minFollowers),
    String(data.resultLimit),
    data.discoveryVertical,
    String(data.minVideoViews),
    String(data.minVideoCount),
    JSON.stringify(data.sliceArmSlots ?? null),
    // 코덱스 적대 리뷰(2026-09-27, MEDIUM): ai_drama 는 channel_graph/most_popular 폴백을 껐지만
    // (위 [a]), 배포 전에 그 폴백이 섞여 캐시된 pass 가 TTL(1h) 동안 캐시 히트로 그대로 재반환·
    // 재적재될 수 있다 — 캐시 조회는 라이브 검색을 건너뛰므로 이 커밋의 게이트를 안 탄다. ai_drama만
    // 키 솔트를 한 번 바꿔 배포 이전 캐시를 강제 미스로 만든다. game 은 배열 길이·값이 그대로라
    // 기존 캐시 키가 바이트 단위로 불변이다(위 R27-b①① 테스트가 그 불변을 고정한다).
    ...(data.discoveryVertical === "ai_drama" ? ["fallback-lanes-disabled-v1"] : []),
  ]);
}

// Real Firestore-backed TTL read. Returns a hit (with the cached payload) only when a non-expired
// doc exists, so the caller can gate the expensive search/scrape path. (COST-P0-011)
async function cacheLookup(key: string, ttlSeconds: number): Promise<CacheMeta> {
  const checkedAt = new Date().toISOString();
  const miss: CacheMeta = { status: "miss", key, ttlSeconds, checkedAt };

  const snapshot = await discoveryCacheDoc(key).get();
  if (!snapshot.exists) return miss;

  const record = snapshot.data() ?? {};
  const expiresAtIso = typeof record.expiresAtIso === "string" ? record.expiresAtIso : undefined;
  if (!expiresAtIso || Date.now() > Date.parse(expiresAtIso)) return miss;

  const value = record.value && typeof record.value === "object" ? record.value as Record<string, unknown> : undefined;
  if (!value) return miss;

  return { status: "hit", key, ttlSeconds, checkedAt, expiresAtIso, value };
}

// Persist a freshly computed payload so the next identical call hits the cache instead of the API.
async function cacheStore(key: string, kind: DiscoveryCacheKind, queryRef: string, ttlSeconds: number, value: Record<string, unknown>): Promise<string> {
  const expiresAtIso = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await discoveryCacheDoc(key).set({
    key,
    kind,
    queryRef,
    ttlSeconds,
    value,
    expiresAtIso,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return expiresAtIso;
}

/**
 * R30-2 [COST-P0-011]: 키워드 확장 LLM 제안기가 쓰는 캐시 어댑터. **새 캐시 구현 금지** — 위의 기존
 * TTL 캐시(discoveryCacheKey/cacheLookup/cacheStore)를 그대로 재사용하는 얇은 창구다.
 * 캐시에는 제안 term 목록만 담는다(프롬프트·응답 원문 금지, SEC-P0-009).
 */
export function keywordExpansionCacheKey(seedParts: string[]): string {
  return discoveryCacheKey("keyword_expansion", seedParts[0] ?? "campaign", seedParts.slice(1));
}

export async function keywordExpansionCacheLookup(
  key: string,
  ttlSeconds: number,
): Promise<{ status: "hit" | "miss"; value?: Record<string, unknown> }> {
  const meta = await cacheLookup(key, ttlSeconds);
  return meta.status === "hit" ? { status: "hit", value: meta.value } : { status: "miss" };
}

export async function keywordExpansionCacheStore(
  key: string,
  ttlSeconds: number,
  value: Record<string, unknown>,
): Promise<string> {
  return cacheStore(key, "keyword_expansion", key, ttlSeconds, value);
}

function costLog(model: CostLog["model"], provider: CostLog["provider"] = "mock", estimatedUsd = 0): CostLog {
  return {
    provider,
    model,
    inputTokens: 0,
    outputTokens: 0,
    estimatedUsd,
    currency: "USD",
    loggedAt: new Date().toISOString(),
  };
}

function behaviorLog(context: GuardContext, gameId: string, action: string, result: BehaviorLog["result"], cost: number): BehaviorLog {
  return {
    userId: context.userId,
    role: context.role,
    team: context.team,
    gameId,
    action,
    time: new Date().toISOString(),
    IP: context.ip,
    result,
    cost,
  };
}

export function youtubeApiSecretNames(staging = isStagingRuntime()): readonly string[] {
  return staging ? STAGING_YOUTUBE_SECRET_NAMES : PRODUCTION_YOUTUBE_SECRET_NAMES;
}

/**
 * R21-1: 주 키는 필수, 폴백은 있는 것만 순서대로 쓴다. 예전에는 앞의 두 이름만 구조분해해서
 * 슬롯을 늘려도 코드가 읽지 않았다 — 목록을 그대로 순회한다(슬롯이 늘면 자동으로 따라온다).
 * ⚠️ 키 원문은 반환값에만 존재한다 — 로그·Firestore·에러에 싣지 않는다(SEC-P0-009).
 */
/**
 * R21-3: 키 개수만 필요한 호출부용 **비throw** 접근자. youtubeApiKeys() 는 주 키가 없으면 throw 하므로
 * (requireEnvSecret) 쿼터 배급 판단에서 그걸 직접 부르면 "키 미바인딩" 이 "발굴 전면 중단" 으로 번진다.
 */
export function youtubeApiKeyCount(): number {
  try {
    return youtubeApiKeys().length;
  } catch {
    return 0;
  }
}

export function youtubeApiKeys(): string[] {
  const [primaryName, ...fallbackNames] = youtubeApiSecretNames();
  const primary = requireEnvSecret(primaryName, "YouTube Data API");
  const keys = [
    primary,
    ...fallbackNames.map((name) => envSecret(name)),
  ].filter((key) => key.trim().length > 0);
  return Array.from(new Set(keys));
}

export function youtubeQuotaLimited(status: number, body: string): boolean {
  return status === 429 || (
    status === 403 &&
    /\b(?:quota(?:Exceeded)?|rateLimitExceeded|dailyLimitExceeded|userRateLimitExceeded)\b|too many requests/i.test(body)
  );
}

/**
 * W59-6: youtubeQuotaLimited 는 **키 로테이션** 판정이라 일일 소진과 단기 레이트리밋을 일부러 함께
 * 잡는다(둘 다 "다음 키로 넘어가라"의 근거다). 그런데 슬롯 버킷 래치는 의미가 다르다 — 그 슬롯을
 * **오늘 하루** 닫는 판정이므로 단기 429/rateLimitExceeded 로 래치하면 몇 초짜리 스로틀 때문에
 * 프로젝트 하나의 100콜을 통째로 버린다(이 항목의 목적과 정반대다).
 * 그래서 래치는 **일일 소진 사유**에만 건다. 그 외는 종전 로테이션이 그대로 처리한다.
 */
export function youtubeSearchDailyQuotaExhausted(status: number, body: string): boolean {
  return status === 403 && /\b(?:quotaExceeded|dailyLimitExceeded)\b/i.test(body);
}

export async function fetchYouTubeRecord(
  url: URL,
  failurePrefix: string,
  keyState: YoutubeKeyState,
  dependencies: YoutubeFetchDependencies = {
    reserve: reserveStagingYoutubeApiUnits,
    fetch: (input, init) => fetch(input, init),
  },
): Promise<Record<string, unknown>> {
  const operation = youtubeOperationFromUrl(url);
  const recordAttempt = dependencies.recordAttempt ?? recordYoutubeApiAttempt;
  // Flu/W2: absent for every pre-W2 caller (growth, unchanged). Only a caller that resolved a
  // non-growth org pool (settings/youtube_quota_pools.byOrgId) sets this.
  const poolId = keyState.poolId;
  // 인시던트 2026-09-29 Codex 리뷰 #3: forcedKeys 가 있으면(이 함수 자신의 재시도 1회 — 아래
  // 참조) 그 배열을 그대로 쓴다. youtubeLaneKeys 를 다시 부르지 않는다 — 다시 부르면 own-pool
  // 사전 판정을 또 거쳐 방금 라이브 429 로 확인한 소진을 무시하고 같은 own 키를 또 고를 수 있다.
  const keys = keyState.forcedKeys ?? await youtubeLaneKeys(keyState.lane, operation, poolId);
  // W59-6: 슬롯(=프로젝트)마다 별개인 Search Queries 버킷 소진 집합. 배열에서 빼지 않고 아래 루프가
  // 건너뛴다 — 길이가 흔들리면 keyState.index 계약(R22-4)이 깨진다.
  const skipSlots = await exhaustedSearchSlots(keyState.lane, operation, keys, poolId);
  let lastError: unknown;
  const canBorrowForOperation = poolId !== undefined
    && poolId !== YOUTUBE_GROWTH_POOL_ID
    && (operation === "videos" || operation === "channels")
    && !keyState.borrowRetried;
  const retryWithBorrowedKey = async (ownPoolDailyQuotaExhausted: boolean): Promise<Record<string, unknown> | null> => {
    if (!canBorrowForOperation) return null;
    // Reserve the actual call cost first. Selection commits the grant only after this succeeds;
    // the recursive call skips reservation so the same attempt is not counted twice.
    await dependencies.reserve(operation);
    const selectApiKey = dependencies.selectApiKey ?? selectYoutubeApiKey;
    let selection: Awaited<ReturnType<typeof selectYoutubeApiKey>>;
    try {
      selection = await selectApiKey({
        poolIdOverride: poolId,
        ownPoolConfirmedExhausted: true,
        estimatedUnitCost: youtubeUnitCost(operation),
      });
    } catch (selectError) {
      if ((selectError as { errorCode?: unknown } | null)?.errorCode !== "youtube_quota_pool_exhausted") {
        throw selectError;
      }
      return null;
    }
    if (!selection.borrowedFromPoolId) return null;
    const borrowedEntry: YoutubeLaneKeyEntry = {
      key: selection.apiKey,
      slot: selection.slotIndex,
      poolId: selection.borrowedFromPoolId,
    };
    try {
      return await fetchYouTubeRecord(url, failurePrefix, {
        ...keyState,
        index: 0,
        borrowRetried: true,
        forcedKeys: [borrowedEntry],
      }, { ...dependencies, reserve: async () => undefined });
    } catch (retryError) {
      throw Object.assign(retryError as Error, { dailyQuotaExhausted: ownPoolDailyQuotaExhausted });
    }
  };

  // With no own key configured, a cheap metadata call may still use a lender. Search never enters
  // this path and therefore always waits for the borrower's own quota window.
  if (keys.length === 0) {
    const borrowedResult = await retryWithBorrowedKey(false);
    if (borrowedResult) return borrowedResult;
  }
  const startIndex = Math.max(0, keyState.index);
  for (
    let attempt = 0;
    startIndex < keys.length && attempt < keys.length;
    attempt += 1
  ) {
    const index = (startIndex + attempt) % keys.length;
    if (skipSlots.has(keys[index].slot)) {
      // 마른 버킷에 콜을 태우면 403 을 받으려고 pass 예산을 쓰는 셈이다. 다음 슬롯으로 넘긴다.
      keyState.index = (index + 1) % keys.length;
      continue;
    }
    // 인시던트 2026-09-29 Codex 리뷰 #2: 이 항목이 차용된 키면(youtubePoolLaneKeys 의 사전 판정
    // 또는 아래 라이브-429 재시도가 poolId 를 명시로 찍는다) 계상은 그 키의 **실제 소유 풀**
    // (growth)로 간다 — 바깥 keyState.poolId("drama_1")로 잡으면 growth 소비가 drama_1 원장에
    // 묻히고, growth 자신의 50% 잔여율 판정(minLenderRemainingRatio)이 실제보다 넉넉해 보인다.
    const entryPoolId = keys[index].poolId ?? poolId;
    const requestUrl = new URL(url.toString());
    requestUrl.searchParams.set("key", keys[index].key);
    await dependencies.reserve(operation);
    // R28-3 (P0-A): fetch **직전**에 시도를 선기록한다 — 아래에서 실패하면 이 콜은 쿼터를 태우고도
    // 계측에 흔적을 남기지 않았다(성공만 기록하던 현행 모델의 사각지대).
    void recordAttempt({ operation, slotIndex: keys[index].slot, outcome: "attempted", poolId: entryPoolId });
    const response = await dependencies.fetch(requestUrl, { signal: timeoutSignal(YOUTUBE_API_FETCH_TIMEOUT_MS) });
    const body = await response.text();
    if (response.ok) {
      keyState.index = index;
      // R21-2: 어느 슬롯이 썼는지 남긴다 — 슬롯별 계측이 없으면 주 키 잔여를 알 수 없다.
      void recordYoutubeApiUnits(operation, 1, keys[index].slot, entryPoolId ?? YOUTUBE_GROWTH_POOL_ID);
      // W59-6: Search Queries 는 슬롯(=프로젝트)마다 별개 버킷이다. Firestore 쓰기 도달 전에도
      // 같은 pass 의 다음 페이지가 정확히 보도록 프로세스 원장에서 **즉시** 차감한다.
      // Flu/W2: 이 process-local 원장은 growth 슬롯 전용이다(exhaustedSearchSlots 주석) — 비growth
      // 풀의 slot 0 은 growth 의 slot 0 과 다른 프로젝트라 여기서 계상하면 growth 버킷이 오염된다.
      if (operation === "search" && !entryPoolId) noteYoutubeSearchCallConsumed(keys[index].slot);
      // W59c-C4 [Codex 적대 리뷰 · MAJOR]: 검색 성공의 durable 계상(v2.bySlotSearchCalls)은
      // fire-and-forget 이면 안 된다. 이 값이 다음 인스턴스의 슬롯 회전 원장 정본인데, 인스턴스가
      // 쓰기 도달 전에 종결되면 그 콜은 durable 원장에서 사라지고 다음 인스턴스가 **이미 마른
      // 프로젝트를 다시 고른다**(W59-6 이 없애려던 403 낭비가 그대로 돌아온다).
      // 그래서 search 성공 경로만 await 한다 — 계측 실패가 발송/발굴을 깨뜨리면 안 되므로 삼키되
      // 조용히 넘기지 않는다(경고 로그). 그 외 연산은 종전대로 fire-and-forget 이다.
      if (operation === "search") {
        try {
          await recordAttempt({ operation, slotIndex: keys[index].slot, outcome: "success", poolId: entryPoolId });
        } catch (error) {
          console.warn("[youtube-search-quota] durable search call record failed", {
            slot: keys[index].slot,
            errorCode: (error as { errorCode?: string } | null)?.errorCode ?? "unknown",
          });
        }
      } else {
        void recordAttempt({ operation, slotIndex: keys[index].slot, outcome: "success", poolId: entryPoolId });
      }
      return asRecord(JSON.parse(body));
    }
    const message = `${failurePrefix} (${response.status})`;
    const quotaLimited = youtubeQuotaLimited(response.status, body);
    // W59-6/W59c-M3: **일일 소진**(403 quotaExceeded/dailyLimitExceeded)과 단기 429 를 갈라 본다.
    // 전자만 그 슬롯의 Search Queries 버킷을 오늘 닫는 근거다(youtubeSearchDailyQuotaExhausted 주석).
    // ⚠️ 이 축(searchDailyExhausted)은 growth 전용 **검색** 슬롯 버킷 래치에만 쓴다(operation==
    // "search" 게이트는 그 래치의 계약이지, "일일 소진이 검색에서만 일어난다"는 뜻이 아니다).
    const searchDailyExhausted = operation === "search"
      && youtubeSearchDailyQuotaExhausted(response.status, body);
    // 인시던트 2026-09-29 Codex 리뷰 라운드4 #5: 아래 lastError.dailyQuotaExhausted(= W75 쿼터
    // 유예 분류가 쓰는 값)는 **연산 무관**이어야 한다 — videos.list 같은 다른 연산의 403
    // quotaExceeded 도 정확히 같은 일일 소진이다. searchDailyExhausted 의 operation==="search"
    // 게이트를 여기서까지 물려받으면 videos.list 소진이 "단기"로 오분류돼 25h 유예 없이 매시간
    // 재시도된다(리뷰어 실측: 직접 호출로 재현).
    const dailyQuotaExhausted = youtubeSearchDailyQuotaExhausted(response.status, body);
    // R28-3: 실패 완결 — 사유(쿼터 소진/그 외 HTTP)를 버리지 않는다. 기록은 **정확히 한 번**이다.
    // W59c-M3: 일일 소진 건은 durable 래치 필드를 함께 싣고 await 한다(사라지면 래치가 없는 것과 같다).
    // 그 외는 종전대로 fire-and-forget — 실패 계상이 실제 호출 경로를 느리게 만들면 안 된다.
    const failureRecord = {
      operation,
      slotIndex: keys[index].slot,
      outcome: "failure" as const,
      httpStatus: response.status,
      ...(quotaLimited ? { errorReason: "quotaExceeded" } : {}),
      ...(searchDailyExhausted ? { searchDailyExhausted: true } : {}),
      poolId: entryPoolId,
    };
    if (searchDailyExhausted) {
      try {
        await recordAttempt(failureRecord);
      } catch (error) {
        console.warn("[youtube-search-quota] durable search exhaustion record failed", {
          slot: keys[index].slot,
          errorCode: (error as { errorCode?: string } | null)?.errorCode ?? "unknown",
        });
      }
    } else {
      void recordAttempt(failureRecord);
    }
    // 인시던트 2026-09-29 Codex 리뷰 #4/라운드4 #5: dailyQuotaExhausted 는 연산 무관 판정
    // (위 dailyQuotaExhausted 축)을 싣는다 — 호출부(fetchTopVideoIdsForChannels 등)가 이 값으로만
    // 하루 소진 마커를 세운다. 단기 429(rateLimitExceeded 등)는 여기서 false 로 남아 호출부가
    // 마커를 세우지 않는다(이번 pass 만 접고 다음 시간에 새로 시도한다).
    lastError = Object.assign(new Error(message), {
      code: "failed-precondition", errorCode: "fetch_you_tube_record_unauthorized",
      quotaLimited, dailyQuotaExhausted,
    });
    if (!quotaLimited) throw lastError;
    // W59-6: 구글이 준 **일일 소진** 신호가 슬롯 버킷의 정본이다 — 남은 추정과 무관하게 오늘은 닫는다.
    // 안 닫으면 같은 pass 의 다음 페이지가 마른 슬롯을 다시 골라 실패 응답으로 pass 예산을 먹는다.
    if (searchDailyExhausted && !entryPoolId) {
      // Flu/W2: growth-only process ledger — see the noteYoutubeSearchCallConsumed guard above.
      noteYoutubeSearchSlotQuotaBlocked(keys[index].slot);
      // W59c-M3: durable 래치 필드(v2.bySlotSearchDailyExhausted)는 위 실패 기록이 이미 실어 보냈다
      // (403 전용 — bySlotSearchQuotaBlocked 는 429 가 섞여 래치 근거가 못 된다).
      // ⚠️ 슬롯 **인덱스**만 남긴다 — 키 원문·지문 금지(SEC-P0-009).
      console.info("[youtube-search-quota] search slot quota blocked", {
        slot: keys[index].slot,
        httpStatus: response.status,
      });
    } else if (searchDailyExhausted && entryPoolId) {
      // 사용자 리포트(2026-09-27): drama_1 등 non-growth 풀의 소진은 이 분기가 growth 전용
      // 프로세스 원장(noteYoutubeSearchSlotQuotaBlocked)을 건너뛰면서 콘솔 로그까지 함께 묵음
      // 처리됐다 — durable Firestore 기록(recordAttempt, 위)은 남지만 운영자가 실시간으로 볼 수
      // 있는 흔적이 없었다. 원장은 여전히 안 건드린다(growth 전용이라는 계약은 그대로) — 가시성만
      // 추가한다. ⚠️ 슬롯 **인덱스**만 남긴다 — 키 원문·지문 금지(SEC-P0-009).
      console.info("[youtube-search-quota] pool search slot quota blocked", {
        poolId: entryPoolId,
        slot: keys[index].slot,
        httpStatus: response.status,
      });
    }
    keyState.index = (index + 1) % keys.length;
    if (attempt === keys.length - 1) {
      // Only cheap metadata calls can retry against Growth, and each call chain gets one attempt.
      const ownPoolDailyQuotaExhausted = (lastError as { dailyQuotaExhausted?: unknown } | null)?.dailyQuotaExhausted === true;
      const borrowedResult = await retryWithBorrowedKey(ownPoolDailyQuotaExhausted);
      if (borrowedResult) return borrowedResult;
      throw lastError;
    }
  }
  // R22-4: 이 지점은 **한 번도 시도하지 못한** 경우다 — keyState.index 가 레인 정렬 배열의 인덱스인데
  // 발굴 레인의 배열 길이는 주 키 가드(60초 캐시) 상태에 따라 4↔3 으로 바뀐다. index=3 까지 진행한 뒤
  // 가드가 닫히면 루프가 0회 돌고 여기로 온다. 예전에는 quotaLimited 가 undefined 라 R21-4 인계가
  // 걸리지 않고 그대로 dead_letter 였다(20페이지 발굴은 60초를 쉽게 넘긴다).
  // 발굴 레인에서 쓸 키가 없다는 것은 곧 쿼터/예약분 소진이므로 소진 신호를 세운다.
  throw lastError ?? Object.assign(new Error(`${failurePrefix} (no api key available)`), {
    code: "failed-precondition", errorCode: "fetch_you_tube_record_api_key_available",
    quotaLimited: true,
  });
}

export function youtubeLiveSearchLimits(
  resultLimit: number,
  configuredPageSize: number,
  configuredMaxPages: number,
  staging = isStagingRuntime(),
): { requestedLimit: number; pageSize: number; maxPages: number } {
  const requestedLimit = Math.max(1, Math.min(
    Math.trunc(resultLimit),
    staging ? STAGING_YOUTUBE_MAX_RESULTS : DISCOVERY_RESULT_LIMIT_MAX,
  ));
  const boundedPageSize = Math.min(50, Math.max(1, Math.trunc(configuredPageSize)));
  const pageSize = staging
    ? Math.min(boundedPageSize, STAGING_YOUTUBE_MAX_RESULTS)
    : boundedPageSize;
  const boundedConfiguredMaxPages = Math.max(
    1,
    Math.min(YOUTUBE_SEARCH_MAX_PAGES, Math.trunc(configuredMaxPages)),
  );
  const maxPages = Math.min(
    staging
      ? Math.min(boundedConfiguredMaxPages, STAGING_YOUTUBE_MAX_PAGES)
      : boundedConfiguredMaxPages,
    Math.ceil(requestedLimit / pageSize),
  );
  return { requestedLimit, pageSize, maxPages };
}

function filterCandidates(
  candidates: CandidateResult[],
  filters: ParsedYoutubeSearchData["filters"],
  countryTargeting: CountryTargeting = {
    countryScope: "include",
    includedCountries: [...DEFAULT_YOUTUBE_CREATOR_COUNTRIES],
    excludedCountries: [],
  },
): CandidateResult[] {
  const countryFiltered = candidates.flatMap((candidate) => {
    const decision = youtubeCreatorCountryPolicyDecision(
      candidate.creatorCountry ?? candidate.region,
      countryTargeting,
    );
    return decision.accepted
      ? [{
          ...candidate,
          // W15 F-1b: scope=all 에서 국가불명이 accept 되면 판정 국가가 없다 — 후보의 원래 값을 유지한다.
          creatorCountry: decision.country ?? candidate.creatorCountry,
          region: decision.country ?? candidate.region,
          countryFilterReason: "country_allowed",
        }]
      : [];
  });
  return filterCandidateMetrics(countryFiltered, filters);
}

// R27: 제네릭화 — searchYouTubeLive 가 이 필터 전후로 CandidateResult 에 없는 임시 필드(__sliceType,
// sliceArmStats 집계 전용, persist 되지 않는다)를 들고 다니는데, 이 함수는 순수 .filter() 라 타입을
// 좁히지 않고 그대로 통과시켜야 그 필드가 살아남는다. 기존 호출부(filterCandidates)는 그대로
// CandidateResult[] 로 추론되어 동작·타입 모두 불변이다.
function filterCandidateMetrics<T extends CandidateResult>(candidates: T[], filters: ParsedYoutubeSearchData["filters"]): T[] {
  return candidates.filter((candidate) => {
    const matchesCategory = filters.categories.length === 0 || filters.categories.some((category) => candidate.category.toLowerCase().includes(category.toLowerCase()));

    return matchesCategory && candidate.followers >= filters.minFollowers;
  });
}

// Flu domain = 캐주얼/퍼즐/하이퍼캐주얼 모바일게임. 캠페인 category가 있으면 맨 앞에 끼워
// relevance 스프레드를 만든다. (플랫 60/99 금지 — 실제 적합도 기반 점수.)
const BASE_TARGET_KEYWORDS = [
  "game", "gaming", "mobile", "casual", "puzzle", "hypercasual", "game review", "게임",
];

// 모바일게임 협업 sweet-spot 기준 팔로워 적합도.
function followerFit(followers: number): number {
  if (followers < 10_000) return 10;
  if (followers < 50_000) return 55;
  if (followers <= 2_000_000) return 100;
  if (followers <= 10_000_000) return 82;
  return 66;
}

function followerTierLabel(followers: number): string {
  if (followers >= 1_000_000) return "메가";
  if (followers >= 100_000) return "미드";
  return "그로스";
}

// title+description 키워드 매칭 → categoryMatch, 그리고 4개 신호 가중합 matchScore.
export function scoreCandidate(
  title: string,
  description: string,
  followers: number,
  hasBusinessEmail: boolean,
  targetKeywords: string[],
  mostRecentMatchPublishedAtIso?: string,
  nowMs: number = Date.now(),
): { matchScore: number; categoryMatch: number; kwHits: number } {
  const text = `${title} ${description}`.toLowerCase();
  const kwHits = targetKeywords.filter((keyword) => text.includes(keyword.toLowerCase())).length;
  const categoryMatch = Math.min(100, kwHits * 22);
  const contactFit = hasBusinessEmail ? 100 : 45;
  const recencyFit = youtubeRecencyFit(mostRecentMatchPublishedAtIso, nowMs);
  const matchScore = Math.max(
    0,
    Math.min(100, Math.round(categoryMatch * 0.45 + followerFit(followers) * 0.30 + contactFit * 0.15 + recencyFit * 0.10)),
  );
  return { matchScore, categoryMatch, kwHits };
}

function youtubeGamingTopicId(category: string): string {
  const normalized = category.toLowerCase();
  for (const [term, topicId] of Object.entries(YOUTUBE_GAMING_SUBGENRE_TOPIC_IDS)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![a-z])${escaped}(?![a-z])`).test(normalized)) return topicId;
  }
  return YOUTUBE_GAMING_TOPIC_ID;
}

// R27 [사용자 지시: "키워드 허들을 낮추고 대카테고리에서 세분화를 우리 로직으로, 과학적·수학적으로"] —
// 3암 밴딧. 현행 검색(A="keyword")은 videoCategoryId=20 ∩ topicId(서브장르) ∩ q=키워드 ∩
// publishedAfter ∩ regionCode 회전이다 — q 가 모집단을 좁혀 회전할수록 같은 표면을 재노출한다(운영
// 실측: 발견 채널 중복률 ~93%, 1,000유닛당 순신규 ~1.1명). 검색 비용은 q 유무와 무관하게 100유닛/콜
// 이므로 q 를 빼는 것만으로 비용 증가 없이 모집단이 넓어진다. 두 신규 암을 추가한다:
//  - "broad"(B): q 미설정, category(=키워드/캠페인 카테고리)+topic(같은 유도)+publishedAfter+region 만.
//  - "topic"(C): q 미설정 + YOUTUBE_GAMING_SUBGENRE_TOPIC_IDS 의 서로 다른 topicId 를 그대로 순회
//    (카테고리 텍스트 유도가 아니라 서브장르 자체를 축으로 넓게 훑는다).
// A(keyword)는 이미 q 가 필터이므로 로컬 분류 게이트를 적용하지 않는다(동작 불변) — B/C 산출물만
// 캠페인 렉시콘(includeKeywords ∪ expandedKeywords ∪ R24 mined) n-gram/키워드-hit 매칭을 통과해야
// 후보로 인정된다(scoreCandidate 의 기존 kwHits 채점을 그대로 재사용 — 새 스코어러를 만들지 않는다).
export type DiscoverySliceType = "keyword" | "broad" | "topic";
/**
 * 암 순서의 정본 — buildDiscoveryQueryPlan 이 각 라운드에서 이 순서로 한 항목씩 인터리브한다.
 * 배분된 암의 첫 호출이 같은 암의 후속 호출보다 먼저 나가도록 하는 W9-1 실행 순서이기도 하다.
 */
export const DISCOVERY_SLICE_TYPES: readonly DiscoverySliceType[] = ["keyword", "broad", "topic"];

export interface DiscoveryQueryPlanItem {
  readonly sliceType: DiscoverySliceType;
  readonly category: string;
  readonly region: string;
  readonly topicId: string;
  /** "keyword" 슬라이스에만 존재 — 이 필드의 유무가 곧 URL 조립 시 q 설정 여부다. */
  readonly query?: string;
}

/** 잡/런 문서에 영속되는 밴딧 슬롯 배분(예산) — enqueue 시점에 admin.ts 가 계산해 그대로 싣는다. */
export interface DiscoverySliceArmSlots {
  readonly keyword: number;
  readonly broad: number;
  readonly topic: number;
}

/**
 * R28-1/W9-1: 암별 **실호출** 계측 — 밴딧 EWMA 의 정당한 분모다.
 *
 * sliceArmSlots 는 배분일 뿐이다. W9-1은 queryPlan 을 암별 round-robin 으로 인터리브하고 배분된
 * 각 암의 첫 호출을 위한 페이지를 먼저 연다. 그래도 쿼터 절단처럼 호출 전에 멈춘 암은 수익률 0으로
 * 청구하면 안 되므로, 실제로 발사한 검색 콜만 분모로 쓴다.
 */
export interface SliceArmCallCounters {
  /** fetch **직전**에 +1 — 실패(4xx/5xx/네트워크)한 콜도 포함한다("시도한 검색"이 분모다). */
  attemptedSearchCalls: number;
  /** response.ok 였던 콜만 +1(fetchYouTubeRecord 는 그 외엔 throw 한다). */
  successfulSearchCalls: number;
  /** dedup·필터 이전에 검색 응답이 실제로 돌려준 채널 참조 수 — 암별 원시 산출량. */
  rawChannelsSeen: number;
}
export type SliceArmCalls = Record<DiscoverySliceType, SliceArmCallCounters>;

export function emptySliceArmCalls(): SliceArmCalls {
  return {
    keyword: { attemptedSearchCalls: 0, successfulSearchCalls: 0, rawChannelsSeen: 0 },
    broad: { attemptedSearchCalls: 0, successfulSearchCalls: 0, rawChannelsSeen: 0 },
    topic: { attemptedSearchCalls: 0, successfulSearchCalls: 0, rawChannelsSeen: 0 },
  };
}

/**
 * R28-6 [LOW-2 적대적 리뷰 실측]: 암별 발견 수의 **영(0) 기준선**. 빈 객체가 아니라 세 암 모두 0 을
 * 명시하는 것이 계약이다 — admin.ts 의 갱신 근거 가드(`Object.keys(sliceArmStats).length > 0`)는
 * 빈 객체를 "관측 없음"으로 읽어 그 pass 를 통째로 학습에서 제외한다. 그러면 "콜은 썼는데 0채널"
 * 이라는 **가장 중요한 음성 표본**이 사라져 성공 pass 만 학습되고 전 암 수익률이 공통 상향 편향된다
 * (R28-1 이 세운 정당한 분모의 목표가 절반만 달성된다).
 */
export function emptySliceArmStats(): Record<DiscoverySliceType, number> {
  return { keyword: 0, broad: 0, topic: 0 };
}
type SliceArmFailureEvidence = {
  sliceArmStats: Record<DiscoverySliceType, number>;
  sliceArmCalls: SliceArmCalls;
};

function withSliceArmFailureEvidence(error: unknown, sliceArmCalls: SliceArmCalls): Error {
  return Object.assign(error instanceof Error ? error : new Error(String(error)), {
    sliceArmStats: emptySliceArmStats(),
    sliceArmCalls,
  });
}

function readSliceArmFailureEvidence(value: unknown): Partial<SliceArmFailureEvidence> {
  const record = asRecord(value);
  const sliceArmStats = asRecord(record.sliceArmStats);
  const sliceArmCalls = asRecord(record.sliceArmCalls);
  return {
    ...(Object.keys(sliceArmStats).length > 0
      ? { sliceArmStats: sliceArmStats as Record<DiscoverySliceType, number> }
      : {}),
    ...(Object.keys(sliceArmCalls).length > 0 ? { sliceArmCalls: sliceArmCalls as SliceArmCalls } : {}),
  };
}

function mergeSliceArmCalls(...values: Array<SliceArmCalls | undefined>): SliceArmCalls | undefined {
  const present = values.filter((value): value is SliceArmCalls => Boolean(value));
  if (present.length === 0) return undefined;
  const merged = emptySliceArmCalls();
  for (const value of present) {
    for (const arm of DISCOVERY_SLICE_TYPES) {
      merged[arm].attemptedSearchCalls += value[arm]?.attemptedSearchCalls ?? 0;
      merged[arm].successfulSearchCalls += value[arm]?.successfulSearchCalls ?? 0;
      merged[arm].rawChannelsSeen += value[arm]?.rawChannelsSeen ?? 0;
    }
  }
  return merged;
}

/** R28-2 (P0-D): 배분 관측 — 기아 직접 신호(알고리즘 무변경, 잡/런 문서 additive 필드 전용). */
export interface SliceArmObservability {
  /** enqueue 시점에 admin.ts 가 이 잡에 실어 보낸 암별 배분 슬롯. */
  plannedSlots: Record<DiscoverySliceType, number>;
  /** 이 잡이 암별로 실제 발사한 검색 콜(sliceArmCalls.attemptedSearchCalls). */
  executedCalls: Record<DiscoverySliceType, number>;
  /** 배분을 받고도(planned>0) 한 번도 실행되지 않은(executed===0) 암 — P0-C 기아의 직접 신호. */
  starvedArms: DiscoverySliceType[];
  /**
   * round-robin 플랜에서 실제로 소진한 슬롯 수. 전 암이 계획만큼 실행됐으면 null.
   * 페이지네이션으로 한 플랜 항목이 여러 콜을 쓰면 암별 planned 값으로 clamp 한다.
   */
  planTailCutAt: number | null;
}

/**
 * R28-2 (P0-D): 이 잡의 배분 대비 실행을 값으로 요약한다. **판정에 쓰이지 않는 순수 관측**이다 —
 * 밴딧 배분(allocateSliceArmSlots)·EWMA(applySliceArmEwmaUpdate) 알고리즘은 이 값을 읽지 않는다.
 * 관측 표면이 없으면 운영자는 "왜 topic 이 계속 0 인가"를 잡 문서만 보고 답할 수 없다(R20/T4 와 같은 이유).
 *
 * 주의: executedCalls 는 **페이지 단위 콜**이라 pagesPerQuery>1 인 pass 에서는 planned 를 넘길 수
 * 있다(플랜 항목 하나가 여러 페이지를 부른다) — planTailCutAt 은 그래서 planned 로 clamp 한다.
 */
export function computeSliceArmObservability(
  sliceArmSlots: unknown,
  sliceArmCalls: SliceArmCalls,
): SliceArmObservability {
  const slotsRecord = asRecord(sliceArmSlots);
  const plannedSlots = {} as Record<DiscoverySliceType, number>;
  const executedCalls = {} as Record<DiscoverySliceType, number>;
  const starvedArms: DiscoverySliceType[] = [];
  let totalPlanned = 0;
  let executedWithinPlan = 0;
  for (const arm of DISCOVERY_SLICE_TYPES) {
    const planned = Math.max(0, Math.trunc(asNumber(slotsRecord[arm]) ?? 0));
    const executed = Math.max(0, Math.trunc(sliceArmCalls[arm]?.attemptedSearchCalls ?? 0));
    plannedSlots[arm] = planned;
    executedCalls[arm] = executed;
    if (planned > 0 && executed === 0) starvedArms.push(arm);
    totalPlanned += planned;
    executedWithinPlan += Math.min(executed, planned);
  }
  const planTailCutAt = executedWithinPlan < totalPlanned ? executedWithinPlan : null;
  return { plannedSlots, executedCalls, starvedArms, planTailCutAt };
}

// YOUTUBE_GAMING_SUBGENRE_TOPIC_IDS 는 여러 키워드 문자열이 같은 topicId 를 공유한다("rpg"/"role
// playing", "sim"/"simulation") — topic 암은 **서로 다른 topicId**만 순회한다(같은 슬라이스 중복 방지).
const YOUTUBE_GAMING_SUBGENRE_TOPIC_ID_VALUES: readonly string[] = Array.from(
  new Set(Object.values(YOUTUBE_GAMING_SUBGENRE_TOPIC_IDS)),
);
/**
 * 암 간 라운드로빈 절단. **나머지는 앞선 그룹부터 가져간다**(한 라운드 안에서 groups 순서대로 push).
 *
 * W112 F-A: 종전에는 이 타이브레이크가 W9-1 의 `{keyword:34, broad:33, topic:33}` 단정에 **우연히**
 * 걸려 있었다 — 상한 100 이 3으로 안 나뉘어서다. 상한이 300 이 되며 정확히 나뉘자 그 분기가
 * 픽스처로 도달 불가가 됐고, 이 함수는 미export 라 어디서도 안 잡히게 됐다(적대 리뷰 2R MEDIUM).
 * 그래서 export 해 순수 단위 테스트로 직접 못박는다.
 */
export function interleaveByRound<T>(groups: readonly (readonly T[])[], limit = Number.POSITIVE_INFINITY): T[] {
  const result: T[] = [];
  const rounds = Math.max(...groups.map((items) => items.length), 0);
  for (let round = 0; round < rounds && result.length < limit; round += 1) {
    for (const items of groups) {
      if (items[round] !== undefined && result.length < limit) result.push(items[round]);
    }
  }
  return result;
}

/**
 * R27: 검색 쿼리 플랜(암별로 실제로 검색할 category×region/topicId×region 조합) 을 슬롯 예산 안에서
 * 구성하는 순수 함수 — Firestore·네트워크 접근 없이 값으로 단위 테스트 가능하다.
 *
 * sliceArmSlots 를 넘기지 않으면(기존 4개 호출부는 넘기지 않는다) **R27 이전과 완전히 동일한
 * 100% keyword 암**을 반환한다 — 새 암이 섞이는 경로는 admin.ts 의 shortfall 발굴 잡 하나뿐이다.
 */
export function buildDiscoveryQueryPlan(
  categories: readonly string[],
  regions: readonly string[],
  sliceArmSlots?: DiscoverySliceArmSlots,
  discoveryVertical: DiscoveryVertical = "game",
): DiscoveryQueryPlanItem[] {
  const keywordPairs = categories.flatMap((category) => regions.map((region) => ({ category, region })));
  const toKeywordItem = ({ category, region }: { category: string; region: string }): DiscoveryQueryPlanItem => ({
    sliceType: "keyword",
    category,
    region,
    topicId: discoveryVertical === "ai_drama" ? "" : youtubeGamingTopicId(category),
    query: discoveryVertical === "ai_drama" ? category : [category, "gameplay review"].join(" "),
  });
  if (discoveryVertical === "ai_drama" || !sliceArmSlots) return keywordPairs.map(toKeywordItem);

  const keywordItems = keywordPairs.slice(0, Math.max(0, Math.trunc(sliceArmSlots.keyword))).map(toKeywordItem);
  // broad: 같은 category(→topicId 유도)×region 조합을 재사용한다 — 바뀌는 것은 q 부재뿐이다("B: 기존
  // category+topic+publishedAfter+region 만"이라는 설계 그대로).
  const broadItems: DiscoveryQueryPlanItem[] = keywordPairs
    .slice(0, Math.max(0, Math.trunc(sliceArmSlots.broad)))
    .map(({ category, region }) => ({
      sliceType: "broad",
      category,
      region,
      topicId: youtubeGamingTopicId(category),
    }));
  // topic: 서로 다른 subgenre topicId 자체를 축으로 region 과 곱한다 — 카테고리 텍스트 유도가 없다.
  const topicPairs = YOUTUBE_GAMING_SUBGENRE_TOPIC_ID_VALUES.flatMap((topicId) => regions.map((region) => ({ topicId, region })));
  const topicItems: DiscoveryQueryPlanItem[] = topicPairs
    .slice(0, Math.max(0, Math.trunc(sliceArmSlots.topic)))
    .map(({ topicId, region }) => ({ sliceType: "topic", category: "", region, topicId }));
  return interleaveByRound([keywordItems, broadItems, topicItems]);
}

/**
 * R27 수용기준①: URL 조립을 별도 순수 함수로 뽑아 q 유무를 값으로 직접 검증할 수 있게 한다.
 * keyword 슬라이스만 q 를 설정한다 — broad/topic 은 category/topic(topicId)+publishedAfter+region
 * 만 싣는다(q 부재가 이 함수의 핵심 계약).
 */
export function buildYouTubeDiscoverySearchUrl(
  item: DiscoveryQueryPlanItem,
  options: { maxResults: number; publishedAfterIso?: string; pageToken?: string; discoveryVertical?: DiscoveryVertical },
): URL {
  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("type", "video");
  searchUrl.searchParams.set("maxResults", String(Math.max(1, Math.trunc(options.maxResults))));
  if (item.sliceType === "keyword" && item.query) searchUrl.searchParams.set("q", item.query);
  if ((options.discoveryVertical ?? "game") !== "ai_drama") {
    searchUrl.searchParams.set("videoCategoryId", YOUTUBE_GAMING_CATEGORY_ID);
    searchUrl.searchParams.set("topicId", item.topicId);
  }
  searchUrl.searchParams.set("order", "date");
  if (options.publishedAfterIso) searchUrl.searchParams.set("publishedAfter", options.publishedAfterIso);
  if (options.pageToken) searchUrl.searchParams.set("pageToken", options.pageToken);
  // YouTube regionCode controls video viewability/search localization, not creator country.
  // The creator-country hard gate below uses channel snippet.country after channel lookup.
  if (/^[A-Z]{2}$/.test(item.region)) searchUrl.searchParams.set("regionCode", item.region);
  const relevanceLanguage = youtubeRegionLanguage(item.region);
  if (relevanceLanguage) searchUrl.searchParams.set("relevanceLanguage", relevanceLanguage);
  return searchUrl;
}

/** R27 수용기준②: broad/topic 산출물 전용 로컬 분류 게이트 결과. */
export interface LexiconClassificationResult {
  readonly matched: boolean;
  readonly hits: number;
}

/**
 * 캠페인 렉시콘(includeKeywords ∪ expandedKeywords ∪ R24 mined — admin.ts 가 이미 들고 있는 우주
 * 그대로) 대비 title/description 매칭. 새 스코어러를 만들지 않고 기존 scoreCandidate 의 kwHits 채점을
 * 그대로 재사용한다(followers/hasBusinessEmail 은 이 게이트와 무관해 중립값을 넣는다) — 1개 이상
 * hit 이면 통과.
 */
export function classifyAgainstLexicon(title: string, description: string, lexicon: readonly string[]): LexiconClassificationResult {
  const { kwHits } = scoreCandidate(title, description, 0, false, [...lexicon]);
  return { matched: kwHits >= 1, hits: kwHits };
}

/**
 * R27 수용기준②③: broad/topic 산출물 전용 로컬 분류 게이트를 별도 순수 함수로 뽑았다 — searchYouTubeLive
 * 는 liveIntegrationsEnabled("youtube")===false(에뮬 기본값)면 이 로직에 도달하기 전에 이미 null 을
 * 반환하므로, 에뮬 통합 테스트로는 이 게이트 자체를 절대 재현할 수 없다. 값 테스트가 이 함수를 직접
 * 호출해야 한다. keyword 암(A)은 이미 q 가 필터이므로 게이트를 절대 타지 않는다(무접촉, 종전 동작
 * 그대로). 렉시콘이 비어 있으면(전달 안 됨 — 기존 4개 호출부 전부) 게이트 자체가 성립하지 않아 항상
 * 통과시킨다. 분류기 예외는 후보 1건만 배제하고(fail-closed) 나머지 후보·호출자(엔진/잡)는 그대로
 * 계속 진행한다 — 예외가 이 함수 밖으로 전파되지 않는다.
 */
// W9-3: 암 없는 후보(그래프 이웃)도 이 게이트를 그대로 탄다 — keyword 예외가 아니므로 렉시콘 검증 대상이다.
// 리더 리크 조사(2026-09-27) [c]: 렉시콘이 비어 있을 때 non-keyword 후보를 통과시키는 기존 동작은
// game 버티컬(4개 기존 호출부)에서는 그대로 둔다 — 그 회귀를 재현할 값 테스트가 없다. ai_drama 등
// 비-game 버티컬은 `failClosedWhenLexiconEmpty=true`로 opt-in 해 렉시콘 미보유 non-keyword 후보를
// fail-closed 로 배제한다(관련 없는 채널이 게이트 없이 새는 것을 막는다).
export function gateDiscoveryCandidatesByLexicon<T extends { __sliceType?: DiscoverySliceType; name: string; publicDescription: string; channelRef?: string }>(
  candidates: readonly T[],
  lexicon: readonly string[],
  classify: (title: string, description: string, lexicon: readonly string[]) => LexiconClassificationResult,
  failClosedWhenLexiconEmpty = false,
): { gated: T[]; classifiedIn: number; classifiedOut: number; classificationExceptions: number } {
  let classifiedIn = 0;
  let classifiedOut = 0;
  let classificationExceptions = 0;
  const gated = candidates.filter((candidate) => {
    if (candidate.__sliceType === "keyword") return true;
    if (lexicon.length === 0) {
      if (!failClosedWhenLexiconEmpty) return true;
      classifiedOut += 1;
      return false;
    }
    try {
      const classification = classify(candidate.name, candidate.publicDescription, lexicon);
      if (classification.matched) { classifiedIn += 1; return true; }
      classifiedOut += 1;
      return false;
    } catch (error) {
      classificationExceptions += 1;
      console.warn("[youtube-discovery] lexicon classification failed — excluding this candidate, engine continues", {
        channelRef: candidate.channelRef,
        sliceType: candidate.__sliceType,
        errorCode: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
      return false;
    }
  });
  return { gated: [...gated], classifiedIn, classifiedOut, classificationExceptions };
}

/**
 * R27-b [INFO-1 리뷰 실측]: 채널의 sliceArmStats 귀속은 **최초로 발견한 슬라이스**가 정본이다 —
 * keyword 는 유일한 예외로 언제나 승격한다(그 쿼리 자체가 이미 q 로 필터했으므로 게이트 면제
 * 자격이 있다). 옛 인라인 조건(`priorSliceType !== "keyword"` 이면 무조건 덮어쓰기)은 "최초 발견"이
 * 아니라 "가장 나중에 만난 non-keyword 슬라이스"를 남겨, queryPlan 순서(broad 다음 topic,
 * buildDiscoveryQueryPlan)상 broad 로 먼저 발견된 채널이 나중 topic 재발견에 조용히 덮여
 * sliceArmStats 가 broad 를 과소·topic 을 과대 집계했다. 순수 함수로 뽑아 그 편향을 값으로 검증한다.
 */
export function attributeChannelSliceType(
  priorSliceType: DiscoverySliceType | undefined,
  discoveredSliceType: DiscoverySliceType,
): DiscoverySliceType {
  if (priorSliceType === undefined || discoveredSliceType === "keyword") return discoveredSliceType;
  return priorSliceType;
}

/**
 * R27 수용기준③ 테스트 주입점(YtDiscoveryMaterializeDependencies 와 같은 이유 — 분류기 예외를 값으로
 * 재현하려면 주입이 필요하다: 실제 classifyAgainstLexicon 은 항상 문자열 정규화를 거쳐 예외를 던지지
 * 않는다).
 */
export type YoutubeSearchLiveDependencies = {
  classifyLexiconMatch(title: string, description: string, lexicon: readonly string[]): LexiconClassificationResult;
};

const DEFAULT_YOUTUBE_SEARCH_LIVE_DEPENDENCIES: YoutubeSearchLiveDependencies = {
  classifyLexiconMatch: classifyAgainstLexicon,
};

function youtubeRegionLanguage(region: string): string | null {
  const code = region.toUpperCase();
  if (code === "KR") return "ko";
  if (code === "JP") return "ja";
  if (["US", "GB", "CA", "AU"].includes(code)) return "en";
  return null;
}

// YouTube Data API search publishedAfter 하한(RFC3339), recentActivityDays 파생.
// 호출부마다 bound 정책이 달라(1~90일 또는 무제한) 여기서 한 번 더 방어적으로 clamp.
export function youtubePublishedAfterIso(recentActivityDays: number, nowMs: number = Date.now()): string | undefined {
  if (recentActivityDays === 0) return undefined;
  const days = boundedInt(recentActivityDays, 30, 1, 3650);
  return new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
}

// 채널이 검색에 매칭된 가장 최근 영상의 publishedAt 기준 recency 감쇠(0~100, 기존 스코어 스케일 유지).
// 알 수 없으면 중립(50) — 과거의 고정값 70은 실측 데이터가 없는 채널을 부당하게 우대했다.
export function youtubeRecencyFit(publishedAtIso: string | undefined, nowMs: number = Date.now()): number {
  if (!publishedAtIso) return 50;
  const publishedMs = Date.parse(publishedAtIso);
  if (!Number.isFinite(publishedMs)) return 50;
  const ageDays = Math.max(0, (nowMs - publishedMs) / 86_400_000);
  if (ageDays <= 7) return 100;
  if (ageDays <= 30) return 80;
  if (ageDays <= 90) return 55;
  if (ageDays <= 180) return 30;
  return 10;
}

export type ScopedCampaignDiscoveryContext = {
  canonicalProgramId: string;
  programId: string;
  programRef: string;
  campaignId: string;
  campaignRef: string;
};

export type ProgramDiscoveryCriteria = {
  keywords: string[];
  regions: string[];
  categories: string[];
  excludeKeywords: string[];
  minFollowers: number;
  maxFollowers: number;
  recentActivityDays: number;
  keywordFallbackEnabled: boolean;
  discoveryVertical: DiscoveryVertical;
  minVideoViews: number;
  minVideoCount: number;
};

export type ProgramDiscoveryPolicyResolution = {
  candidateCriteria: Record<string, unknown>;
  eligibilityCriteria: Record<string, unknown>;
  countryTargeting: CountryTargeting;
  criteria: ProgramDiscoveryCriteria;
};

type ScopedCampaignDiscoveryCacheSeed = {
  keywords: string[];
  countryTargeting?: CountryTargeting;
  filters: {
    regions: string[];
    categories: string[];
    categoriesExplicit: boolean;
    excludeKeywords: string[];
    minFollowers: number;
    maxFollowers: number;
    recentActivityDays: number;
  };
  resultLimit: number;
  discoveryVertical: DiscoveryVertical;
  minVideoViews: number;
  minVideoCount: number;
};

type YoutubeDiscoveryPersistence =
  | { mode: "global_candidate_pool"; source: string; provenance?: CandidateDiscoveryProvenance }
  | { mode: "scoped_snapshot"; context: ScopedCampaignDiscoveryContext };

type AccountOwnershipStamp = Record<string, unknown>;

type CandidateDiscoveryProvenance = ScopedCampaignDiscoveryContext & {
  sourceRunId: string;
  sourceRunRef: string;
  programScopeEvidence?: Record<string, unknown>;
  criteriaHash?: string;
  policyHash?: string;
} & AccountOwnershipStamp;

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? Array.from(new Set(value.map((item) => asString(item) ?? "").filter(Boolean))) : [];
}

function ownershipStampFromResourceRecord(row: unknown, resource: string): AccountOwnershipStamp {
  const record = asRecord(row);
  const ownerOrgId = asString(record.ownerOrgId) || asString(record.accountOwnerOrgId) || asString(record.programOwnerOrgId) || asString(record.campaignOwnerOrgId);
  if (!ownerOrgId) {
    throw Object.assign(new Error(`failed-precondition: ${resource} account ownership is unavailable`), {
      code: "failed-precondition",
      errorCode: "discovery_authority_account_ownership_unavailable",
    });
  }
  const ownerMailAccountIds = arrayStrings(record.ownerMailAccountIds).length > 0
    ? arrayStrings(record.ownerMailAccountIds)
    : arrayStrings(record.accountOwnerMailAccountIds);
  const ownerMailAccountId = asString(record.ownerMailAccountId)
    || asString(record.accountOwnerMailAccountId)
    || asString(record.programOwnerMailAccountId)
    || asString(record.campaignOwnerMailAccountId)
    || ownerMailAccountIds[0]
    || "";
  const ownerUid = asString(record.ownerUid) || asString(record.accountOwnerUid) || asString(record.programOwnerUid) || asString(record.campaignOwnerUid) || "";
  const ownerEmail = (asString(record.ownerEmail) || asString(record.accountOwnerEmail) || asString(record.programOwnerEmail) || asString(record.campaignOwnerEmail) || "").toLowerCase();
  return {
    accountScopeVersion: asString(record.accountScopeVersion) || ACCOUNT_OWNERSHIP_SCOPE_VERSION,
    ...(ownerUid ? { ownerUid } : {}),
    ...(ownerEmail ? { ownerEmail } : {}),
    ownerAuthTenantId: asString(record.ownerAuthTenantId) || asString(record.accountOwnerAuthTenantId) || "default",
    ownerOrgId,
    ...(ownerMailAccountId ? { ownerMailAccountId } : {}),
    ...(ownerMailAccountIds.length > 0 ? { ownerMailAccountIds } : {}),
    ownerOrgResolutionStatus: asString(record.ownerOrgResolutionStatus) || "resolved",
  };
}

async function resourceOwnershipStamp(
  row: Record<string, unknown>,
  resource: string,
): Promise<AccountOwnershipStamp | null> {
  if (row.ownerOrgId || row.accountOwnerOrgId || row.programOwnerOrgId || row.campaignOwnerOrgId) {
    return ownershipStampFromResourceRecord(row, resource);
  }
  return accountOwnershipStampForTrustedLegacyOwnerRecord(row, resource);
}

function assertCompatibleDiscoveryAuthorityOwnership(
  campaignOwnership: AccountOwnershipStamp,
  programOwnership: AccountOwnershipStamp,
  resource: string,
): void {
  const campaignOrgId = asString(campaignOwnership.ownerOrgId) || "";
  const programOrgId = asString(programOwnership.ownerOrgId) || "";
  if (campaignOrgId && programOrgId && campaignOrgId !== programOrgId) {
    throw Object.assign(new Error(`permission-denied: ${resource} campaign/program ownership conflict`), {
      code: "permission-denied",
      errorCode: "discovery_authority_ownership_org_conflict",
    });
  }
  const campaignTenantId = asString(campaignOwnership.ownerAuthTenantId) || "default";
  const programTenantId = asString(programOwnership.ownerAuthTenantId) || "default";
  if (campaignTenantId && programTenantId && campaignTenantId !== programTenantId) {
    throw Object.assign(new Error(`permission-denied: ${resource} campaign/program tenant conflict`), {
      code: "permission-denied",
      errorCode: "discovery_authority_ownership_tenant_conflict",
    });
  }
}

async function authoritativeDiscoveryOwnershipStamp(
  campaignRecord: Record<string, unknown>,
  programRecord: Record<string, unknown>,
  resource: string,
): Promise<AccountOwnershipStamp> {
  const [campaignOwnership, programOwnership] = await Promise.all([
    resourceOwnershipStamp(campaignRecord, resource),
    resourceOwnershipStamp(programRecord, `${resource} program`),
  ]);
  if (campaignOwnership && programOwnership) {
    assertCompatibleDiscoveryAuthorityOwnership(campaignOwnership, programOwnership, resource);
    return campaignOwnership;
  }
  if (campaignOwnership) return campaignOwnership;
  if (programOwnership) return programOwnership;
  return ownershipStampFromResourceRecord(programRecord, resource);
}

function accountOwnershipFromCandidate(candidate: Record<string, unknown>): AccountOwnershipStamp {
  return Object.fromEntries([
    "accountScopeVersion",
    "ownerUid",
    "ownerEmail",
    "ownerAuthTenantId",
    "ownerOrgId",
    "ownerMailAccountId",
    "ownerMailAccountIds",
    "ownerOrgResolutionStatus",
  ].flatMap((key) => {
    const value = candidate[key];
    if (value === undefined || value === null || value === "") return [];
    if (Array.isArray(value) && value.length === 0) return [];
    return [[key, value]];
  }));
}

// R23-2b/W9-1: created vs merged is resolved at the authoritative write target. Per-candidate
// outcomes are exposed only after the containing batch commits, so EWMA never learns from a proxy row count.
export type CandidatePersistOutcome = {
  candidateRef: string;
  sliceType?: DiscoverySliceType;
  outcome: "created" | "merged";
};
type CandidatePersistCounts = {
  created: number;
  merged: number;
  outcomes: CandidatePersistOutcome[];
};
type CandidatePersister = (results: CandidateResult[], source: string) => Promise<CandidatePersistCounts>;

export function sliceArmStatsFromPersistOutcomes(
  outcomes: readonly CandidatePersistOutcome[],
): Record<DiscoverySliceType, number> {
  const stats = emptySliceArmStats();
  for (const outcome of outcomes) {
    if (outcome.outcome === "created" && outcome.sliceType) stats[outcome.sliceType] += 1;
  }
  return stats;
}

function withoutSliceType(candidate: CandidateResult): CandidateResult {
  const clean = { ...candidate };
  delete clean.__sliceType;
  return clean;
}
function stampPersistOutcomes(
  results: CandidateResult[],
  outcomes: readonly CandidatePersistOutcome[],
): CandidateResult[] {
  const byRef = new Map(outcomes.map((outcome) => [outcome.candidateRef, outcome.outcome]));
  return results.map((candidate) => ({
    ...candidate,
    ...(byRef.get(candidate.candidateRef) ? { persistOutcome: byRef.get(candidate.candidateRef) } : {}),
  }));
}

export function buildScopedCampaignDiscoveryContext(programId: string | undefined, campaignId: string): ScopedCampaignDiscoveryContext {
  const canonicalProgramId = resolveCanonicalProgramId(programId) || resolveCanonicalProgramId(SCP_LEGACY_PROGRAM_ID);
  return {
    canonicalProgramId,
    programId: canonicalProgramId,
    programRef: `programs/${canonicalProgramId}`,
    campaignId,
    campaignRef: `campaigns/${campaignId}`,
  };
}

async function resolveAuthoritativeDiscoveryCampaignContext(
  campaignId: string | undefined,
  campaignRef: string,
  actor?: GuardContext,
  resource = "discovery campaign",
  requestedProgramId?: string,
): Promise<ScopedCampaignDiscoveryContext | null> {
  if (!campaignId) {
    if (actor) {
      assertMutationOwner(
        { uid: actor.userId, role: actor.role },
        [],
        resource,
      );
    }
    return null;
  }
  const expectedCampaignRef = `campaigns/${campaignId}`;
  if (campaignRef && campaignRef !== expectedCampaignRef) {
    throw Object.assign(new Error("failed-precondition: discovery campaignRef does not match campaignId"), { code: "failed-precondition", errorCode: "resolve_authoritative_discovery_campaign_context_discovery_campaign" });
  }
  const campaign = await adminDb.collection("campaigns").doc(campaignId).get();
  if (!campaign.exists) {
    throw Object.assign(new Error("failed-precondition: discovery campaign not found"), { code: "failed-precondition", errorCode: "resolve_authoritative_discovery_campaign_context_discovery_campaign_2" });
  }
  const campaignRecord: Record<string, unknown> = { id: campaign.id, ...(campaign.data() ?? {}) };
  if (actor) {
    assertMutationOwner(
      { uid: actor.userId, role: actor.role },
      mutationOwnerUids(campaignRecord, { includeCreatedBy: true }),
      resource,
    );
  }
  const programIds = Array.from(new Set([
    resolveCanonicalProgramId(campaignRecord.canonicalProgramId),
    resolveCanonicalProgramId(campaignRecord.programId),
  ].filter(Boolean)));
  if (programIds.length !== 1) {
    throw Object.assign(new Error("failed-precondition: discovery campaign has ambiguous program ownership"), { code: "failed-precondition", errorCode: "resolve_authoritative_discovery_campaign_context_discovery_campaign_3" });
  }
  const authoritativeProgramId = programIds[0];
  if (requestedProgramId && resolveCanonicalProgramId(requestedProgramId) !== authoritativeProgramId) {
    throw Object.assign(new Error("failed-precondition: requested program does not own the discovery campaign"), {
      code: "failed-precondition",
      errorCode: "resolve_authoritative_discovery_campaign_context_requested_program_mismatch",
    });
  }
  const program = await adminDb.collection("programs").doc(authoritativeProgramId).get();
  if (!program.exists) {
    throw Object.assign(new Error("failed-precondition: discovery campaign program not found"), {
      code: "failed-precondition",
      errorCode: "resolve_authoritative_discovery_campaign_context_program_not_found",
    });
  }
  return buildScopedCampaignDiscoveryContext(authoritativeProgramId, campaignId);
}

async function resolveDiscoveryAuthorityOwnership(
  scopedContext: ScopedCampaignDiscoveryContext | null,
  accountScope?: AccountOwnershipScope,
  resource = "discovery campaign",
): Promise<AccountOwnershipStamp> {
  if (!scopedContext) {
    if (!accountScope) return {};
    return accountOwnershipStampForScope(accountScope);
  }
  const [campaignSnapshot, programSnapshot] = await Promise.all([
    adminDb.collection("campaigns").doc(scopedContext.campaignId).get(),
    adminDb.collection("programs").doc(scopedContext.canonicalProgramId).get(),
  ]);
  if (!campaignSnapshot.exists) {
    throw Object.assign(new Error("failed-precondition: discovery campaign not found"), {
      code: "failed-precondition", errorCode: "resolve_discovery_authority_ownership_campaign_not_found",
    });
  }
  if (!programSnapshot.exists) {
    throw Object.assign(new Error("failed-precondition: discovery campaign program not found"), {
      code: "failed-precondition", errorCode: "resolve_discovery_authority_ownership_program_not_found",
    });
  }
  const campaignRecord: Record<string, unknown> = { id: campaignSnapshot.id, ...(campaignSnapshot.data() ?? {}) };
  const programRecord: Record<string, unknown> = { id: programSnapshot.id, ...(programSnapshot.data() ?? {}) };
  const campaignProgramIds = Array.from(new Set([
    resolveCanonicalProgramId(campaignRecord.canonicalProgramId),
    resolveCanonicalProgramId(campaignRecord.programId),
  ].filter(Boolean)));
  if (campaignProgramIds.length !== 1 || campaignProgramIds[0] !== scopedContext.canonicalProgramId) {
    throw Object.assign(new Error("failed-precondition: discovery campaign/program relation is inconsistent"), {
      code: "failed-precondition", errorCode: "resolve_discovery_authority_ownership_relation_mismatch",
    });
  }
  if (accountScope) {
    await assertAccountOwnershipForRecordAsync(accountScope, programRecord, `${resource} program`);
    return accountOwnershipStampForOwnedRecordAsync(accountScope, campaignRecord, resource);
  }
  return authoritativeDiscoveryOwnershipStamp(campaignRecord, programRecord, resource);
}

// Scheduled producers predate durable account ownership on some canonical campaign/program
// pairs.  That legacy state is an established server scope, not a reason to infer a human
// account from ownerUid.  Keep this exception private to the scheduled shortfall producer:
// public callers and all other server flows continue through resolveDiscoveryAuthorityOwnership.
const DISCOVERY_DURABLE_OWNERSHIP_ORG_FIELDS = [
  "ownerOrgId",
  "accountOwnerOrgId",
  "programOwnerOrgId",
  "campaignOwnerOrgId",
] as const;
const DISCOVERY_DURABLE_OWNERSHIP_TENANT_FIELDS = [
  "ownerAuthTenantId",
  "accountOwnerAuthTenantId",
  "programOwnerAuthTenantId",
  "campaignOwnerAuthTenantId",
] as const;

type ScheduledDiscoveryOwnershipFields = {
  hasExplicitField: boolean;
  complete: boolean;
};

function scheduledDiscoveryOwnershipFields(record: Record<string, unknown>): ScheduledDiscoveryOwnershipFields {
  const hasOwn = (field: string) => Object.prototype.hasOwnProperty.call(record, field);
  const orgFields = DISCOVERY_DURABLE_OWNERSHIP_ORG_FIELDS.filter(hasOwn);
  const tenantFields = DISCOVERY_DURABLE_OWNERSHIP_TENANT_FIELDS.filter(hasOwn);
  const orgValues = orgFields.map((field) => asString(record[field]));
  const tenantValues = tenantFields.map((field) => asString(record[field]));
  const orgValuesAreValid = orgValues.length > 0 && orgValues.every(Boolean) && new Set(orgValues).size === 1;
  // The normal ownership resolver treats an absent tenant as "default".  Preserve that
  // established org-only contract, while rejecting a tenant field that is present but blank,
  // null, or internally inconsistent.
  const tenantValuesAreValid = tenantValues.length === 0 || (tenantValues.every(Boolean) && new Set(tenantValues).size === 1);
  return {
    hasExplicitField: orgFields.length > 0 || tenantFields.length > 0,
    // An explicit org is required.  Tenant aliases may be absent (the established default
    // tenant contract), but if supplied must be nonblank, non-null, and internally consistent.
    complete: orgValuesAreValid && tenantValuesAreValid,
  };
}

async function resolveScheduledCampaignDiscoveryAuthorityOwnership(
  scopedContext: ScopedCampaignDiscoveryContext,
  resource: string,
): Promise<AccountOwnershipStamp> {
  const [campaignSnapshot, programSnapshot] = await Promise.all([
    adminDb.collection("campaigns").doc(scopedContext.campaignId).get(),
    adminDb.collection("programs").doc(scopedContext.canonicalProgramId).get(),
  ]);
  if (!campaignSnapshot.exists) {
    throw Object.assign(new Error("failed-precondition: discovery campaign not found"), {
      code: "failed-precondition", errorCode: "resolve_scheduled_discovery_authority_ownership_campaign_not_found",
    });
  }
  if (!programSnapshot.exists) {
    throw Object.assign(new Error("failed-precondition: discovery campaign program not found"), {
      code: "failed-precondition", errorCode: "resolve_scheduled_discovery_authority_ownership_program_not_found",
    });
  }
  const campaignRecord: Record<string, unknown> = { id: campaignSnapshot.id, ...(campaignSnapshot.data() ?? {}) };
  const programRecord: Record<string, unknown> = { id: programSnapshot.id, ...(programSnapshot.data() ?? {}) };
  const campaignProgramIds = Array.from(new Set([
    resolveCanonicalProgramId(campaignRecord.canonicalProgramId),
    resolveCanonicalProgramId(campaignRecord.programId),
  ].filter(Boolean)));
  if (campaignProgramIds.length !== 1 || campaignProgramIds[0] !== scopedContext.canonicalProgramId) {
    throw Object.assign(new Error("failed-precondition: discovery campaign/program relation is inconsistent"), {
      code: "failed-precondition", errorCode: "resolve_scheduled_discovery_authority_ownership_relation_mismatch",
    });
  }

  const campaignOwnership = scheduledDiscoveryOwnershipFields(campaignRecord);
  const programOwnership = scheduledDiscoveryOwnershipFields(programRecord);
  if (!campaignOwnership.hasExplicitField && !programOwnership.hasExplicitField) {
    return {};
  }
  if (!campaignOwnership.complete || !programOwnership.complete) {
    throw Object.assign(new Error(`failed-precondition: ${resource} durable ownership is partial or invalid`), {
      code: "failed-precondition", errorCode: "scheduled_discovery_authority_ownership_partial_or_invalid",
    });
  }

  // Reuse the normal authoritative resolver for fully stamped records so its exact org/tenant
  // conflict checks and queue provenance remain the single source of truth.
  return resolveDiscoveryAuthorityOwnership(scopedContext, undefined, resource);
}

function resolvedRecordCountryTargeting(
  record: Record<string, unknown>,
  nestedRecords: readonly Record<string, unknown>[] = [],
): CountryTargeting {
  let resolved: CountryTargeting = {
    countryScope: "all",
    includedCountries: [],
    excludedCountries: [],
  };
  for (const source of [...nestedRecords].reverse()) {
    resolved = resolveCountryTargeting(readDiscoveryCountryTargeting(source), resolved);
  }
  return resolveCountryTargeting(readDiscoveryCountryTargeting(record), resolved);
}

async function resolveQueuedCountryTargeting(
  requested: CountryTargeting,
  scopedContext: ScopedCampaignDiscoveryContext | null,
): Promise<CountryTargeting> {
  if (!scopedContext) return resolveCountryTargeting(requested);
  const [campaignSnapshot, programSnapshot] = await Promise.all([
    adminDb.collection("campaigns").doc(scopedContext.campaignId).get(),
    adminDb.collection("programs").doc(scopedContext.canonicalProgramId).get(),
  ]);
  const campaign = campaignSnapshot.data() ?? {};
  const program = programSnapshot.data() ?? {};
  const programPolicy = resolvedRecordCountryTargeting(program, [
    asRecord(program.candidateCriteria),
    asRecord(program.eligibilityCriteria),
  ]);
  const campaignPolicy = resolveCountryTargeting(
    readDiscoveryCountryTargeting(campaign, asRecord(campaign.targetingCriteria)),
    programPolicy,
  );
  return resolveCountryTargeting(requested, campaignPolicy);
}

function stampCandidateDiscoveryProvenance(
  results: CandidateResult[],
  provenance: CandidateDiscoveryProvenance,
): CandidateResult[] {
  return results.map((candidate) => ({ ...candidate, ...provenance }));
}

function discoveryCandidateSnapshot(results: CandidateResult[]): Array<Record<string, unknown>> {
  return results.map((candidate) => ({
    candidateRef: candidate.candidateRef,
    channelRef: candidate.channelRef,
    name: candidate.name,
    email: candidate.email ?? null,
    canonicalProgramId: candidate.canonicalProgramId,
    programId: candidate.programId,
    programRef: candidate.programRef,
    campaignId: candidate.campaignId,
    campaignRef: candidate.campaignRef,
    sourceRunId: candidate.sourceRunId,
    sourceRunRef: candidate.sourceRunRef,
    candidateSourcePurpose: candidate.campaignId
      ? CANDIDATE_SOURCE_PURPOSE.PROGRAM_CANDIDATE
      : CANDIDATE_SOURCE_PURPOSE.FEED_DISCOVERY,
    candidateSourcePurposeVersion: CANDIDATE_SCOPE_VERSION,
    programScopeEvidence: candidate.programScopeEvidence,
    criteriaHash: candidate.criteriaHash,
    policyHash: candidate.policyHash,
    discoverySource: candidate.discoverySource,
    discoveryArm: candidate.discoveryArm,
    persistOutcome: candidate.persistOutcome,
    sourceFetchedAt: candidate.sourceFetchedAt,
    qualifyingVideo: candidate.qualifyingVideo,
    videoQualification: candidate.videoQualification,
  }));
}

function owns(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function normalizedCriteriaStrings(value: unknown, maxItems = 50, uppercase = false): string[] | undefined {
  const values = asStringArray(value);
  if (!values) return undefined;
  return Array.from(new Set(values
    .map((item) => uppercase ? item.toUpperCase() : item)
    .filter(Boolean)))
    .slice(0, maxItems);
}

function criteriaArray(
  sources: Array<{ record: Record<string, unknown>; keys: string[] }>,
  fallback: string[],
  options: { maxItems?: number; uppercase?: boolean } = {},
): string[] {
  for (const source of sources) {
    for (const key of source.keys) {
      if (!owns(source.record, key)) continue;
      const value = normalizedCriteriaStrings(source.record[key], options.maxItems, options.uppercase);
      if (value) return value;
    }
  }
  return fallback;
}

/**
 * W60c-B [Codex 평결 · 실코드로 확정]: 위 criteriaArray 의 **실의미론은 "첫 non-empty 승"이 아니라
 * "첫 소유(owned) 배열 승"**이다. 사슬을 값으로 따라가면 그렇게밖에 안 된다:
 *   asStringArray([])              → []            (배열이므로 undefined 가 아니다)
 *   normalizedCriteriaStrings([])  → []            (`if (!values)` 는 [] 에서 거짓 — [] 는 truthy)
 *   criteriaArray                  → `if (value) return value` 로 **[] 를 최종값으로 반환**
 * 즉 `campaign.includeKeywords: []` 는 "비어 있으니 다음 소스를 보라"가 아니라 **"검색어 0 개"** 다.
 * 이 파일 상단 독스트링("explicit campaign fields win last, **including intentional empty arrays**")이
 * 원래 의도이고, 구현이 그 의도와 일치한다.
 *
 * 이 함수를 내보내는 이유는 admin.ts 의 수확 선택 체인이 **같은 함수**를 쓰게 하기 위해서다.
 * 종전 admin 은 `.find((values) => values.length > 0)` 로 "첫 non-empty 승"이었다 — 위 의미론과
 * 갈린다. 갈리는 픽스처: `campaign.includeKeywords: []` + `campaign.keywords: ["a"]` 이면
 * resolver 는 검색어 0(발굴 안 함), admin 은 ["a"] 로 수확을 건다 — **정본이 안 쓰는 키워드로
 * 수확하는** 잠복 결함이다(현재는 UI 가 두 필드를 함께 저장해 가려져 있다).
 * 주석으로 "맞춰 두라"고 적는 대신 호출을 공유해 **구조적으로** 갈릴 수 없게 만든다.
 */
export function resolveOwnedCriteriaKeywords(
  sources: Array<{ record: Record<string, unknown>; keys: string[] }>,
  maxItems = 40,
): string[] {
  return criteriaArray(sources, [], { maxItems });
}

function criteriaNumber(
  sources: Array<{ record: Record<string, unknown>; key: string }>,
  fallback: number,
  min: number,
  max: number,
): number {
  for (const source of sources) {
    if (!owns(source.record, source.key)) continue;
    const value = asNumber(source.record[source.key]);
    if (value !== undefined) return Math.max(min, Math.min(Math.trunc(value), max));
  }
  return fallback;
}

function criteriaBoolean(
  sources: Array<{ record: Record<string, unknown>; key: string }>,
  fallback: boolean,
): boolean {
  for (const source of sources) {
    if (!owns(source.record, source.key)) continue;
    if (typeof source.record[source.key] === "boolean") return source.record[source.key] as boolean;
  }
  return fallback;
}

function normalizedProgramCriteriaSnapshot(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const snapshot: Record<string, unknown> = {};
  const arrays: Array<{ output: string; keys: string[]; uppercase?: boolean }> = [
    { output: "keywords", keys: ["keywords", "includeKeywords"] },
    { output: "regions", keys: ["regions", "targetCountries"], uppercase: true },
    { output: "categories", keys: ["categories"] },
    { output: "excludeKeywords", keys: ["excludeKeywords"] },
    { output: "platforms", keys: ["platforms"] },
  ];
  for (const field of arrays) {
    const value = criteriaArray([{ record, keys: field.keys }], [], { uppercase: field.uppercase });
    if (field.keys.some((key) => owns(record, key))) snapshot[field.output] = value;
  }
  for (const key of ["minFollowers", "maxFollowers", "recentActivityDays", "minVideoViews", "minQualifyingVideoViews", "minimumVideoViews", "minVideoCount", "minQualifyingVideoCount", "minimumVideoCount"] as const) {
    const value = asNumber(record[key]);
    if (owns(record, key) && value !== undefined) snapshot[key] = Math.max(0, Math.min(Math.trunc(value), 100_000_000));
  }
  if (owns(record, "keywordFallbackEnabled") && typeof record.keywordFallbackEnabled === "boolean") {
    snapshot.keywordFallbackEnabled = record.keywordFallbackEnabled;
  }
  if (owns(record, "discoveryVertical") || owns(record, "vertical")) {
    snapshot.discoveryVertical = normalizeDiscoveryVertical(record.discoveryVertical ?? record.vertical);
  }
  return snapshot;
}

/**
 * Program policy is the server-owned default. Eligibility criteria provide the
 * broad fallback, candidateCriteria refine discovery, and explicit campaign
 * fields win last (including intentional empty arrays and zero bounds).
 */
export function resolveProgramDiscoveryCriteria(
  program: Record<string, unknown>,
  campaign: Record<string, unknown>,
): ProgramDiscoveryPolicyResolution {
  const eligibilityCriteria = normalizedProgramCriteriaSnapshot(program.eligibilityCriteria);
  const candidateCriteria = normalizedProgramCriteriaSnapshot(program.candidateCriteria);
  const programDefaults = { ...eligibilityCriteria, ...candidateCriteria };
  const targeting = asRecord(campaign.targetingCriteria);
  const programCountryTargeting = resolvedRecordCountryTargeting(program, [
    asRecord(program.candidateCriteria),
    asRecord(program.eligibilityCriteria),
  ]);
  const countryTargeting = resolveCountryTargeting(
    readDiscoveryCountryTargeting(campaign, targeting),
    programCountryTargeting,
  );

  const keywords = criteriaArray([
    { record: campaign, keys: ["includeKeywords", "keywords"] },
    { record: targeting, keys: ["includeKeywords", "keywords"] },
    { record: programDefaults, keys: ["keywords"] },
  ], [], { maxItems: 40 });
  const regions = countryTargeting.countryScope === "include"
    ? countryTargeting.includedCountries
    : [];
  const categories = criteriaArray([
    { record: campaign, keys: ["categories"] },
    { record: targeting, keys: ["categories"] },
    { record: programDefaults, keys: ["categories"] },
  ], [], { maxItems: 30 });
  const excludeKeywords = criteriaArray([
    { record: campaign, keys: ["excludeKeywords"] },
    { record: targeting, keys: ["excludeKeywords"] },
    { record: programDefaults, keys: ["excludeKeywords"] },
  ], [], { maxItems: 40 });
  const discoveryVertical = readOwnedDiscoveryVertical([campaign, targeting, programDefaults]);
  const defaultMinVideoViews = discoveryVertical === "ai_drama" ? AI_DRAMA_MIN_QUALIFYING_VIDEO_VIEWS : 0;
  const defaultMinVideoCount = discoveryVertical === "ai_drama" ? AI_DRAMA_MIN_QUALIFYING_VIDEO_COUNT : 0;

  return {
    candidateCriteria,
    eligibilityCriteria,
    countryTargeting,
    criteria: {
      keywords,
      regions,
      categories,
      excludeKeywords,
      minFollowers: criteriaNumber([
        { record: targeting, key: "minFollowers" },
        { record: campaign, key: "minFollowers" },
        { record: programDefaults, key: "minFollowers" },
      ], 0, 0, 100_000_000),
      maxFollowers: criteriaNumber([
        { record: targeting, key: "maxFollowers" },
        { record: campaign, key: "maxFollowers" },
        { record: programDefaults, key: "maxFollowers" },
      ], 0, 0, 100_000_000),
      recentActivityDays: criteriaNumber([
        { record: targeting, key: "recentActivityDays" },
        { record: campaign, key: "recentActivityDays" },
        { record: programDefaults, key: "recentActivityDays" },
      ], discoveryVertical === "ai_drama" ? 0 : 30, 0, 90),
      keywordFallbackEnabled: criteriaBoolean([
        { record: campaign, key: "keywordFallbackEnabled" },
        { record: targeting, key: "keywordFallbackEnabled" },
        { record: programDefaults, key: "keywordFallbackEnabled" },
      ], false),
      discoveryVertical,
      minVideoViews: readOwnedPositiveInteger(
        [campaign, targeting, programDefaults],
        ["minVideoViews", "minQualifyingVideoViews", "minimumVideoViews"],
        defaultMinVideoViews,
        0,
        100_000_000,
      ),
      minVideoCount: readOwnedPositiveInteger(
        [campaign, targeting, programDefaults],
        ["minVideoCount", "minQualifyingVideoCount", "minimumVideoCount"],
        defaultMinVideoCount,
        0,
        100,
      ),
    },
  };
}

export function scopedCampaignDiscoveryCacheKey(
  context: ScopedCampaignDiscoveryContext,
  seed: ScopedCampaignDiscoveryCacheSeed,
): string {
  const semanticSeed = JSON.stringify({
    canonicalProgramId: context.canonicalProgramId,
    campaignId: context.campaignId,
    countryTargeting: seed.countryTargeting ?? null,
    keywords: [...seed.keywords].sort(),
    regions: [...seed.filters.regions].sort(),
    categories: [...seed.filters.categories].sort(),
    excludeKeywords: [...seed.filters.excludeKeywords].sort(),
    minFollowers: seed.filters.minFollowers,
    maxFollowers: seed.filters.maxFollowers,
    recentActivityDays: seed.filters.recentActivityDays,
    resultLimit: seed.resultLimit,
    discoveryVertical: seed.discoveryVertical,
    minVideoViews: seed.minVideoViews,
    minVideoCount: seed.minVideoCount,
    // 코덱스 적대 리뷰(2026-09-27 round2, MEDIUM): youtubeDiscoveryCacheKey 와 같은 이유 — 이
    // scoped 캐시 키(스케줄 캠페인 발굴이 쓰는 쪽)도 ai_drama 사전 캐시를 강제 미스시킨다. game·
    // 미지정 버티컬은 필드 자체가 추가되지 않아 JSON 이 바이트 단위로 불변이다.
    ...(seed.discoveryVertical === "ai_drama" ? { fallbackLanesDisabledVersion: "v1" } : {}),
  });
  return discoveryCacheKey("youtube", `program:${context.canonicalProgramId}:campaign:${context.campaignId}`, [semanticSeed]);
}

export function readScopedCampaignDiscoveryCacheCandidates(
  value: unknown,
  context: ScopedCampaignDiscoveryContext,
): CandidateResult[] | null {
  const record = asRecord(value);
  if (asString(record.canonicalProgramId) !== context.canonicalProgramId
    || asString(record.campaignId) !== context.campaignId
    || !Array.isArray(record.results)) return null;
  const rows = record.results as unknown[];
  if (rows.some((row) => {
    const candidate = asRecord(row);
    return asString(candidate.canonicalProgramId) !== context.canonicalProgramId
      || asString(candidate.campaignId) !== context.campaignId;
  })) return null;
  const candidates = rows as CandidateResult[];
  const safeCandidates = withoutHostedFixtureCandidates(candidates);
  return candidates.length > 0 && safeCandidates.length === 0 ? null : safeCandidates;
}

export function scopeYoutubeDiscoveryResults(
  results: CandidateResult[],
  context: ScopedCampaignDiscoveryContext,
): CandidateResult[] {
  return results.map((result) => ({ ...result, ...context }));
}

export async function finalizeYoutubeDiscoveryResults(
  results: CandidateResult[],
  persistence: YoutubeDiscoveryPersistence,
  persist: CandidatePersister,
  // R23-2b: 반환 타입을 바꾸면 이 함수를 배열로 직접 소비하는 기존 계약(tests/discovery-program-scope)이
  // 깨진다 — 대신 부가 채널로만 created/merged 를 흘려보낸다. 인자를 생략하는 기존 3-인자 호출부는
  // 전부 그대로 동작한다.
  onPersisted?: (counts: CandidatePersistCounts) => void,
): Promise<CandidateResult[]> {
  if (persistence.mode === "scoped_snapshot") {
    return scopeYoutubeDiscoveryResults(results.map(withoutSliceType), persistence.context);
  }
  const persistedResults = persistence.provenance
    ? stampCandidateDiscoveryProvenance(results, persistence.provenance)
    : results;
  const counts = await persist(persistedResults, persistence.source);
  if (onPersisted && counts) onPersisted(counts);
  return persistedResults.map(withoutSliceType);
}

/**
 * W9-3: 공식 응답에서 **공개 featured-channel edge 만** 뽑는다.
 * `channelSections.list` 의 `snippet.type === "multipleChannels"` 섹션의 `contentDetails.channels[]`
 * 만 채널 목록이다 — singlePlaylist/popularUploads 등은 재생목록·영상이라 이웃이 아니다.
 * 섹션이 없거나 multipleChannels 가 없으면 빈 배열이 정상 outcome 이다(실패가 아니다).
 *
 * 계약 재확인(2026-08-03 접속, 문서 갱신일 2026-06-01):
 *  · https://developers.google.com/youtube/v3/docs/channelSections — `multipleChannels` +
 *    `contentDetails.channels[]` 현존.
 *  · https://developers.google.com/youtube/v3/docs/channelSections/list — `channelId` 필터는
 *    인증 요구 표시가 없는 공개 필터, 쿼터 1유닛.
 *  · https://developers.google.com/youtube/v3/docs/channels — `brandingSettings.channel` 에
 *    `featuredChannelsUrls`/`featuredChannelsTitle` 이 **더 이상 없다**(title·description·keywords·
 *    trackingAnalyticsAccountId·unsubscribedTrailer·defaultLanguage·country 만). 그래서 featured
 *    channel 1-hop 은 `channels.list` 가 아니라 이 엔드포인트로만 얻을 수 있고, 비용은 동일한 1유닛이다.
 *
 * ⚠️ 실호출 실측(2026-08-03, 실제 candidate_pool 시드 50개·50유닛): 살아 있는 API 는 `snippet.type`
 * 을 **소문자**로 준다(`multiplechannels`·`singleplaylist`·`channelsectiontypeundefined`). 문서의
 * camelCase 와 와이어 값이 다르다. 문서 표기로 정확히 비교하면 프로드에서 이 레인은 **영구 0건**이다
 * (문서대로 비교한 첫 프로브: 섹션 보유 시드 0·이웃 0). 대소문자 무시로 비교해야 값이 나온다
 * (같은 50시드 재측정: multipleChannels 보유 시드 11 · 채널 edge 36 · 고유 이웃 34 · 순신규 26).
 */
export function channelGraphNeighborIds(json: Record<string, unknown>): string[] {
  const items = Array.isArray(json.items) ? json.items.map(asRecord) : [];
  const neighborIds: string[] = [];
  for (const item of items) {
    // 문서는 camelCase, 와이어는 소문자다 — 둘 다 받는다(위 ⚠️ 실측).
    if ((asString(asRecord(item.snippet).type) ?? "").toLowerCase() !== "multiplechannels") continue;
    const channels = asRecord(item.contentDetails).channels;
    if (Array.isArray(channels)) neighborIds.push(...(asStringArray(channels) ?? []));
  }
  return neighborIds;
}

/** W9-3: 후보 문서에서 seed 로 쓸 정규 채널 ID(없으면 null — 커뮤니티 레코드 등은 시드가 아니다). */
export function channelGraphSeedId(candidate: Record<string, unknown>): string | null {
  const fromField = asString(candidate.channelId) ?? "";
  const fromRef = (asString(candidate.channelRef) ?? "").replace(/^yt_channel_/, "");
  const channelId = /^UC[\w-]{20,}$/.test(fromField) ? fromField : fromRef;
  return /^UC[\w-]{20,}$/.test(channelId) ? channelId : null;
}

/** W9-3: 같은 시드를 매 pass 다시 캐면 이웃이 그대로라 유닛만 태운다 — 확장 창 안이면 건너뛴다. */
export function channelGraphRecentlyExpanded(candidate: Record<string, unknown>, nowMs = Date.now()): boolean {
  const expandedAtMs = Date.parse(asString(candidate.channelGraphExpandedAtIso) ?? "");
  return Number.isFinite(expandedAtMs) && nowMs - expandedAtMs < YOUTUBE_GRAPH_SEED_RETRY_MS;
}

/**
 * W9-3 [깊이 1 강제]: 그래프로**만** 알게 된 사람은 다음 pass 에서 시드가 되지 못한다. 이 가드가 없으면
 * pass N 의 이웃이 pass N+1 의 시드가 되어(적재 컬렉션이 곧 다음 입력이다) 사실상 2홉 크롤러가 된다.
 * 검색 등 다른 유입이 한 번이라도 있었던 사람은 그대로 시드다. provenance 가 없는 옛 후보(W9-5 이전
 * 2,374명)도 시드다 — 그래프가 데려온 사람이라는 근거가 없기 때문이다.
 */
export function channelGraphOnlyCandidate(candidate: Record<string, unknown>): boolean {
  const edgeSources = Object.keys(asRecord(candidate.discoveryProvenance)).map((key) => key.split(":")[0]);
  const sources = edgeSources.length > 0 ? edgeSources : [asString(candidate.discoverySource) ?? ""].filter(Boolean);
  return sources.length > 0 && sources.every((source) => source === CHANNEL_GRAPH_SOURCE);
}

/** W9-3: 시드 순회 커서를 두는 기존 lane 상태 문서(커뮤니티 레인이 쓰는 그 컬렉션). */
const CHANNEL_GRAPH_STATE_DOC = "channel_graph";

/**
 * W9-3: 시드는 **이미 가진 사람들**이다 — 새 검색 콜 0. 문서 ID 순서로 컬렉션을 순회하고 커서만
 * lane 상태 문서에 남긴다. `updatedAtIso desc` 고정 정렬로 1,000건씩 읽던 이전 방식은 필요량의
 * 200배를 읽으면서도 상위 1,000위 밖 문서(candidate_pool 2,374 중 약 1,374)를 **영구히** 시드에서
 * 제외했다 — 공급 확대가 목적인 레인의 도달 상한이 거기서 잘렸다.
 * ⚠️ `channelGraphExpandedAtIso` 부등호 필터로 바꾸지 마라 — 그 필드가 없는 문서(=아직 확장하지
 * 않은 문서)가 통째로 빠진다. 확장 창 판정은 읽어온 문서에서 값으로 한다.
 * orderBy 실패는 삼키지 않는다(조용한 임의 표본이 진단을 숨긴다) — 그대로 던져 잡이 알게 한다.
 */
/**
 * 리더 리크 조사(2026-09-27) [b]: `candidate_pool`은 설계상 프로그램/버티컬 귀속이 없는 전역 공유
 * 버킷이다(persistCandidates 주석 — "candidate_pool 은 전역 풀 설계"). game 버티컬(XP Hero/Snake 등)은
 * 그 공유가 의도된 동작이라 `scope` 를 안 넘기면(기존 유일 호출부) 종전과 바이트 단위로 동일하게
 * 두 컬렉션을 전부 훑는다. ai_drama 등 non-game 버티컬은 (a) `candidate_pool`을 아예 스킵하고
 * (신뢰할 귀속 필드가 없어 추측하느니 스킵 — fail-closed), (b) `campaign_candidates`는 **같은
 * campaignRef** 로만 좁힌다 — game 캠페인의 시드가 ai_drama 그래프 확장에 새어 들어가지 않는다.
 */
async function readChannelGraphSeeds(
  limit: number,
  scope?: { discoveryVertical: DiscoveryVertical; campaignRef: string },
): Promise<Array<{ channelId: string; ref: string }>> {
  const nonGameVertical = Boolean(scope && scope.discoveryVertical !== "game");
  const stateRef = adminDb.collection(COMMUNITY_DISCOVERY_STATE_COLLECTION).doc(CHANNEL_GRAPH_STATE_DOC);
  const cursors = asRecord((await stateRef.get()).data());
  const seeds = new Map<string, { channelId: string; ref: string }>();
  const nextCursors: Record<string, string> = {};
  for (const collection of ["candidate_pool", "campaign_candidates"] as const) {
    if (nonGameVertical && collection === "candidate_pool") continue;
    const cursorField = `${collection}Cursor`;
    const cursor = asString(cursors[cursorField]) ?? "";
    const query = adminDb.collection(collection).orderBy(FieldPath.documentId()).limit(YOUTUBE_GRAPH_SEED_SCAN_LIMIT);
    // 커서는 문서 키 **값**이라 그 문서가 지워져도 재개 지점이 유효하다(스냅샷 커서였다면 멈춘다).
    // 그럼에도 창이 비면(커서가 끝을 가리킴) 같은 pass 에서 처음으로 되감는다 — 커서 도입이
    // 조용한 시딩 정지를 새로 만들면 안 된다.
    let snapshot = await (cursor ? query.startAfter(cursor) : query).get();
    if (snapshot.empty && cursor) snapshot = await query.get();
    let lastExaminedId = "";
    for (const doc of snapshot.docs) {
      lastExaminedId = doc.id;
      const data = asRecord(doc.data());
      if (nonGameVertical && collection === "campaign_candidates" && asString(data.campaignRef) !== scope?.campaignRef) {
        // 커서는 그대로 전진한다 — 다른 캠페인 문서를 스킵할 뿐 창 진행은 game 과 동일하다.
        continue;
      }
      const channelId = channelGraphSeedId(data);
      if (channelId && !seeds.has(channelId)
        && !channelGraphRecentlyExpanded(data) && !channelGraphOnlyCandidate(data)) {
        seeds.set(channelId, { channelId, ref: `${collection}/${doc.id}` });
      }
      // 커서는 **본 문서**까지만 전진한다 — 창을 다 보지 않고 건너뛰면 그 구간이 영영 안 읽힌다.
      if (seeds.size >= limit) break;
    }
    const windowFullyRead = lastExaminedId === snapshot.docs[snapshot.docs.length - 1]?.id;
    nextCursors[cursorField] = windowFullyRead && snapshot.docs.length < YOUTUBE_GRAPH_SEED_SCAN_LIMIT
      ? ""
      : lastExaminedId;
  }
  await stateRef.set({ ...nextCursors, updatedAtIso: new Date().toISOString() }, { merge: true });
  return [...seeds.values()];
}

/**
 * W9-3: seed 채널당 1유닛 `channelSections.list` 한 번으로 **깊이 1** 이웃만 캔다(이웃의 이웃 금지).
 * hidden/삭제 채널의 403·404 는 **그 시드만** unavailable 로 처리해 다음 시드를 계속하고, 쿼터 소진
 * 신호만 확장을 즉시 멈춘다(잡 전체 실패가 아니다). 시도한 시드는 성공·실패 모두 확장 시각을 남겨
 * 같은 시드가 다음 pass 를 독점하지 못하게 한다.
 */
async function expandChannelGraphNeighbors(input: {
  seen: ReadonlySet<string>;
  keyState: YoutubeKeyState;
  deadlineMs: number;
  scope?: { discoveryVertical: DiscoveryVertical; campaignRef: string };
}): Promise<{ neighbors: string[]; seedsAttempted: number; truncatedByQuota: boolean }> {
  const seeds = await readChannelGraphSeeds(YOUTUBE_GRAPH_SEED_LIMIT, input.scope);
  // self-loop 뿐 아니라 **다른 시드**도 이웃에서 뺀다 — 이미 가진 사람을 hydrate 슬롯에 넣을 이유가 없다.
  const seedIds = new Set(seeds.map((seed) => seed.channelId));
  const neighbors = new Set<string>();
  const expandedAtIso = new Date().toISOString();
  let seedsAttempted = 0;
  for (const seed of seeds) {
    if (neighbors.size >= YOUTUBE_GRAPH_NEIGHBOR_LIMIT) break;
    const graphUrl = new URL("https://www.googleapis.com/youtube/v3/channelSections");
    graphUrl.searchParams.set("part", "snippet,contentDetails");
    graphUrl.searchParams.set("channelId", seed.channelId);
    // 그래프는 부가 레인이다 — 마감이 임박하면 이번 pass 를 죽이지 말고 확장만 멈춘다(이미 태운
    // 검색 유닛의 산출물을 잃지 않는다).
    if (Date.now() + YOUTUBE_API_FETCH_TIMEOUT_MS + 2_000 >= input.deadlineMs) break;
    seedsAttempted += 1;
    let graphJson: Record<string, unknown>;
    try {
      graphJson = await fetchYouTubeRecord(graphUrl, "YouTube channel graph lookup failed", input.keyState);
    } catch (error) {
      if ((error as { quotaLimited?: unknown } | null)?.quotaLimited === true) {
        return { neighbors: [...neighbors], seedsAttempted, truncatedByQuota: true };
      }
      await adminDb.doc(seed.ref).set({ channelGraphExpandedAtIso: expandedAtIso }, { merge: true });
      continue;
    }
    for (const channelId of channelGraphNeighborIds(graphJson)) {
      if (seedIds.has(channelId) || input.seen.has(channelId) || neighbors.has(channelId)) continue;
      neighbors.add(channelId);
      if (neighbors.size >= YOUTUBE_GRAPH_NEIGHBOR_LIMIT) break;
    }
    await adminDb.doc(seed.ref).set({ channelGraphExpandedAtIso: expandedAtIso }, { merge: true });
  }
  return { neighbors: [...neighbors], seedsAttempted, truncatedByQuota: false };
}

/**
 * W9-4: 지역 게이밍 인기 차트에서 채널 시드를 캔다 — `videos.list(chart=mostPopular)` 는 **1유닛에
 * 영상 50개**이고 Search Queries 버킷을 쓰지 않는다(검색 콜 순증 0).
 *
 * 계약 재확인(2026-08-03 접속, 문서 갱신일 2026-07-08)
 * https://developers.google.com/youtube/v3/docs/videos/list — 쿼터 1유닛, `chart=mostPopular`,
 * `regionCode`·`videoCategoryId` 는 chart 와만 함께 쓰며, 지원하지 않는 차트는 400
 * `videoChartNotFound` 다. 그 400 과 빈 결과는 **정상 outcome** 으로 처리해 다음 region 을 계속한다
 * (잡 실패 아님). 쿼터 소진 신호만 시드 수집을 멈춘다.
 *
 * 리더 리크 조사(2026-09-27) [b]: `videoCategoryId` 는 하드코딩된 YouTube "게이밍" 카테고리다 —
 * game 버티컬 전제다. non-game(`discoveryVertical`)에는 대응 카테고리가 없으므로(추측해서 잘못된
 * 카테고리를 넣느니) 이 레인 자체를 0건으로 반환한다 — 외부 호출 0회, 기존 호출부(game, 인자 생략)는
 * 그대로다.
 */
async function fetchPopularSeedChannelIds(input: {
  regions: readonly string[];
  seen: ReadonlySet<string>;
  keyState: YoutubeKeyState;
  deadlineMs: number;
  discoveryVertical?: DiscoveryVertical;
}): Promise<{ channelIds: string[]; regionsAttempted: number; truncatedByQuota: boolean }> {
  if (input.discoveryVertical && input.discoveryVertical !== "game") {
    return { channelIds: [], regionsAttempted: 0, truncatedByQuota: false };
  }
  const seedIds = new Set<string>();
  let regionsAttempted = 0;
  for (const region of input.regions.slice(0, YOUTUBE_POPULAR_REGION_LIMIT)) {
    if (seedIds.size >= YOUTUBE_POPULAR_SEED_LIMIT) break;
    // 인기 차트도 부가 레인이다 — 마감이 임박하면 이번 pass 를 죽이지 말고 수집만 멈춘다.
    if (Date.now() + YOUTUBE_API_FETCH_TIMEOUT_MS + 2_000 >= input.deadlineMs) break;
    const chartUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
    chartUrl.searchParams.set("part", "snippet");
    chartUrl.searchParams.set("chart", "mostPopular");
    chartUrl.searchParams.set("regionCode", region);
    chartUrl.searchParams.set("videoCategoryId", YOUTUBE_GAMING_CATEGORY_ID);
    chartUrl.searchParams.set("maxResults", "50");
    regionsAttempted += 1;
    let chartJson: Record<string, unknown>;
    try {
      chartJson = await fetchYouTubeRecord(chartUrl, "YouTube popular chart lookup failed", input.keyState);
    } catch (error) {
      if ((error as { quotaLimited?: unknown } | null)?.quotaLimited === true) {
        return { channelIds: [...seedIds], regionsAttempted, truncatedByQuota: true };
      }
      // 문서화된 미지원 차트/region(400 videoChartNotFound·404)만 정상 outcome 이라 다음 region 을
      // 계속한다. 자격증명·5xx 같은 예기치 못한 실패까지 삼키면 이 레인이 조용히 영구 0건이 되므로,
      // 사유를 남기고 이 레인만 멈춘다(잡은 계속).
      const status = Number(/\((\d{3})\)\s*$/.exec(error instanceof Error ? error.message : "")?.[1] ?? 0);
      if (status !== 400 && status !== 404) {
        console.warn("[youtube-discovery] popular chart lookup failed — stopping W9-4 lane", { region, status });
        break;
      }
      continue;
    }
    const items = Array.isArray(chartJson.items) ? chartJson.items.map(asRecord) : [];
    for (const item of items) {
      const channelId = asString(asRecord(item.snippet).channelId);
      if (!channelId || input.seen.has(channelId) || seedIds.has(channelId)) continue;
      seedIds.add(channelId);
      if (seedIds.size >= YOUTUBE_POPULAR_SEED_LIMIT) break;
    }
  }
  return { channelIds: [...seedIds], regionsAttempted, truncatedByQuota: false };
}

/**
 * W42 F-1: 비쿼터 페이지 실패로 **중단됐지만 수확은 살린** 런의 증거. 런/잡 문서에 그대로 실려
 * "몇 명을 건지고 어느 페이지에서 왜 죽었는지"를 사후에 값으로 확인하게 한다(지금은 그게 안 보인다).
 */
export type YoutubeSearchHarvestPartial = {
  stage: "search" | "channel_lookup";
  failedAtPage: number;
  harvestedChannels: number;
  reason: string;
};

/**
 * W63 Phase 0 [API-only 기준선 · PRD §3.1/§5 Option A]
 *
 * 한 런에서 검색으로 **본** 채널 수와 실제로 hydration 한 채널 수의 차이다. 지금 코드는 초과분을
 * `slice(0, 100)` 으로 **조용히 버린다** — 버린 사실이 어디에도 안 남아서 "검색을 더 해야 하나"와
 * "hydration 을 더 해야 하나"를 구분할 근거가 없었다. yt-dlp 도입 여부를 이 숫자 없이 정하면
 * 엉뚱한 병목에 투자하게 된다.
 *
 * 이 함수는 **계측만** 한다. 절단 동작도, API 지출도 바꾸지 않는다(기존 lane 무변경 게이트).
 */
export type HydrationOverflowStat = {
  readonly seen: number;
  /** 상한 적용 후 **요청하기로 한** 고유 채널 수. */
  readonly attempted: number;
  /** 실제 응답을 받은 고유 채널 수. 쿼터 절단·에러로 attempted 보다 작을 수 있다. */
  readonly succeeded: number;
  /** 상한 절단으로 버린 수(계획 손실). */
  readonly dropped: number;
  /** 요청했는데 못 받은 수(실행 손실). 종전에는 이 축이 없어 손실이 과소 보고됐다. */
  readonly unfetched: number;
  /** W63 델타 M3: "상한에 걸렸나"는 실행 결과가 아니라 **입력 크기**로 정한다. */
  readonly capped: boolean;
  /**
   * W115 A2: known-channel 프리필터가 **일부러** 뺀 수. `dropped`(상한 절단 손실)와 섞으면 안 된다 —
   * 이건 손실이 아니라 절약이고, 두 축을 합치면 "상한을 더 올려야 하나"의 판단이 통째로 틀어진다.
   */
  readonly knownSkipped: number;
};

export function hydrationOverflowStat(
  channelIds: readonly string[],
  channelLookupIds: readonly string[],
  hydratedChannelIds: readonly string[] = channelLookupIds,
  /** 프리필터 통과분. 안 넘기면 종전 의미(관측 전량이 hydration 후보) 그대로다. */
  hydratableChannelIds: readonly string[] = channelIds,
  /** 이번 런에 실제로 적용된 채널 상한. 안 넘기면 하드캡(종전 의미) 그대로다. */
  appliedChannelLimit: number = YOUTUBE_CHANNEL_LOOKUP_LIMIT,
): HydrationOverflowStat {
  const seenUnique = new Set(channelIds.filter(Boolean));
  const hydratableUnique = new Set(hydratableChannelIds.filter(Boolean));
  const attemptedUnique = new Set(channelLookupIds.filter(Boolean));
  const succeededUnique = new Set(hydratedChannelIds.filter(Boolean));
  return {
    seen: seenUnique.size,
    attempted: attemptedUnique.size,
    succeeded: succeededUnique.size,
    // 음수로 접지 않는다. 인터리브 경로가 목록 밖 ID 를 섞으면 그건 통계가 아니라 결함이다.
    // W115 A2: 분모는 관측 전량이 아니라 **프리필터 통과분**이다 — 이미 아는 채널을 안 본 것은
    //   상한 때문에 못 본 것이 아니므로 `dropped` 로 세면 상한 상향 판단이 오염된다.
    dropped: Math.max(0, hydratableUnique.size - attemptedUnique.size),
    knownSkipped: Math.max(0, seenUnique.size - hydratableUnique.size),
    unfetched: Math.max(0, attemptedUnique.size - succeededUnique.size),
    // 실행 결과(dropped>0)로 판정하면 쿼터 절단 런에서 "상한에 안 걸렸다"가 나온다 —
    // 상한 판정은 입력이 상한을 넘었는지의 문제다.
    // W115-R1 [LOW]: 분자·분모를 정합시킨다. 종전에는 분자가 `seen`(관측 전량)이고 분모가
    //   하드캡이었는데, 상한이 실제로 무는 대상은 **프리필터 통과분**이고 상한 자체도 이번 런의
    //   유닛 예산으로 더 조여질 수 있다 — 두 축이 어긋나면 절약분(knownSkipped)만큼 capped 가
    //   위로 오발화하고, "상한을 더 올려야 하나"의 판단이 그만큼 틀어진다.
    capped: hydratableUnique.size > Math.max(0, Math.trunc(appliedChannelLimit)),
  };
}

/**
 * W115 A1 — **hydration 예산의 단일 해석 지점.**
 *
 * 상한이 상수 하나로 굳어 있으면 운영자가 프로드에서 조일 수 없고, 반대로 코드 상한 없이 설정만
 * 보면 오타 하나가 쿼터를 태운다. 그래서 두 축을 곱한다:
 *   · 코드 하드캡 `YOUTUBE_CHANNEL_LOOKUP_LIMIT` — 설정이 무엇이든 절대 못 넘는다(fail-closed 불변식이
 *     이 값을 그대로 강제한다).
 *   · 설정 `youtubeChannelLookupLimit` / env `YOUTUBE_CHANNEL_LOOKUP_LIMIT` — 하드캡 **아래로만** 조인다.
 *   · 유닛 예산 `youtubeHydrationUnitBudget` — "몇 명"이 아니라 "몇 유닛"으로 거는 두 번째 밧줄.
 *     channels.list 는 50개/1유닛이므로 예산 × 50 이 채널 상한으로 환산된다.
 * 셋 중 가장 작은 값이 이번 런의 상한이다.
 */

// 인시던트 2026-09-29 (AI Drama 발굴 정지): drama_1 풀은 **단일 키**(~10,000유닛/일)라 25채널/패스 ×
// 100유닛(search.list) = 최대 2,500유닛짜리 이 폴백 하나가 하루 예산의 1/4~전부를 태웠다 — 채널
// 상한을 낮춰 패스당 최대 유닛 소모 자체를 줄인다(운영 결정: Growth 쿼터 빌려쓰기 + 검증 축소).
export const AI_DRAMA_TOP_VIDEO_CHANNEL_SAMPLE_LIMIT = 10;
const AI_DRAMA_TOP_VIDEO_RESULTS_PER_CHANNEL = 3;

// 인시던트 2026-09-29: 위 폴백이 429(quotaLimited)를 맞으면 — 특히 drama_1 처럼 로테이션할 다음
// 키가 없는 단일 키 풀에서는 — 하루 안의 다음 시도도 전부 같은 429 를 받는다. 이 마커가 없던 이전
// 동작은 (a) 매시 스윕이 **똑같이 실패하는 콜을 다시 시도**했고 (b) fetchYouTubeRecord 가 던진
// quotaLimited 에러가 이 함수 밖으로 그대로 새어나가 w75_ytdlp_promotion 스테이지 전체를
// 매시간 실패시켰다(Cloud Logging 실측: 2026-09-28T19:01Z~2026-09-29T01:01Z 7회 연속 stage_failed).
// 마커는 (poolId, PT 쿼터일) 단위로 "오늘은 이 폴백을 쓰지 마라"만 기록한다 — YouTube 쿼터 리셋
// 자체가 PT 자정이므로 youtubeQuotaDayKey(America/Los_Angeles)를 그대로 쓴다(youtubeQuotaPools.ts
// 의 크로스보로우 dayKey 와 같은 시간대 계약). fail-open: Firestore 장애가 이 최적화 자체를 막아도
// 발굴은 계속돼야 하므로 읽기/쓰기 실패는 삼키고 로그만 남긴다.
const AI_DRAMA_TOP_VIDEO_QUALIFICATION_EXHAUSTED_COLLECTION = "youtube_top_video_qualification_exhausted";

export async function isYoutubeTopVideoQualificationExhaustedToday(
  poolId: string,
  deps: { db?: Pick<FirebaseFirestore.Firestore, "collection">; now?: Date } = {},
): Promise<boolean> {
  const db = deps.db ?? adminDb;
  const now = deps.now ?? new Date();
  try {
    const doc = await db
      .collection(AI_DRAMA_TOP_VIDEO_QUALIFICATION_EXHAUSTED_COLLECTION)
      .doc(`${poolId}_${youtubeQuotaDayKey(now)}`)
      .get();
    return doc.exists;
  } catch {
    return false;
  }
}

export async function markYoutubeTopVideoQualificationExhaustedToday(
  poolId: string,
  deps: { db?: Pick<FirebaseFirestore.Firestore, "collection">; now?: Date } = {},
): Promise<void> {
  const db = deps.db ?? adminDb;
  const now = deps.now ?? new Date();
  const dayKey = youtubeQuotaDayKey(now);
  try {
    await db
      .collection(AI_DRAMA_TOP_VIDEO_QUALIFICATION_EXHAUSTED_COLLECTION)
      .doc(`${poolId}_${dayKey}`)
      .set({ poolId, dayKey, markedAtIso: now.toISOString() }, { merge: true });
  } catch (error) {
    console.warn("[discovery-video-qualification] failed to persist top-video qualification exhaustion marker", {
      poolId,
      errorCode: (error as { code?: unknown } | null)?.code ?? "unknown",
    });
  }
}

type VideoQualificationResult = {
  candidateByChannelId: Map<string, { best: QualifyingVideoEvidence; count: number }>;
  units: number;
  topVideoChannelsSampled: number;
};

export function youtubeVideoItemsByChannel(
  items: readonly Record<string, unknown>[],
  expectedChannelByVideoId: ReadonlyMap<string, string>,
): Map<string, Record<string, unknown>[]> {
  const byChannel = new Map<string, Record<string, unknown>[]>();
  for (const item of items) {
    const videoId = asString(item.id) ?? "";
    const expectedChannelId = expectedChannelByVideoId.get(videoId);
    const snippet = asRecord(item.snippet);
    const actualChannelId = asString(snippet.channelId) ?? "";
    if (!videoId || !expectedChannelId || actualChannelId !== expectedChannelId) continue;
    const bucket = byChannel.get(expectedChannelId) ?? [];
    bucket.push(item);
    byChannel.set(expectedChannelId, bucket);
  }
  return byChannel;
}

async function fetchVideoItemsForEvidence(
  videoIdsByChannel: ReadonlyMap<string, readonly string[]>,
  keyState: YoutubeKeyState,
  deadlineMs: number,
): Promise<{ byChannel: Map<string, Record<string, unknown>[]>; calls: number }> {
  const expectedChannelByVideoId = new Map<string, string>();
  for (const [channelId, videoIds] of videoIdsByChannel) {
    for (const videoId of videoIds) {
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
      if (!expectedChannelByVideoId.has(videoId)) expectedChannelByVideoId.set(videoId, channelId);
    }
  }
  const videoIds = [...expectedChannelByVideoId.keys()];
  const byChannel = new Map<string, Record<string, unknown>[]>();
  let calls = 0;
  for (let index = 0; index < videoIds.length; index += 50) {
    assertDiscoveryDeadline(deadlineMs, "youtube video qualification lookup", YOUTUBE_API_FETCH_TIMEOUT_MS + 2_000);
    const page = videoIds.slice(index, index + 50);
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,statistics");
    url.searchParams.set("id", page.join(","));
    const response = await fetchYouTubeRecord(url, "YouTube video qualification lookup failed", keyState);
    calls += 1;
    const items = Array.isArray(response.items) ? response.items.map(asRecord) : [];
    for (const [channelId, channelItems] of youtubeVideoItemsByChannel(items, expectedChannelByVideoId)) {
      const bucket = byChannel.get(channelId) ?? [];
      bucket.push(...channelItems);
      byChannel.set(channelId, bucket);
    }
  }
  return { byChannel, calls };
}

async function fetchTopVideoIdsForChannels(
  channelIds: readonly string[],
  keyState: YoutubeKeyState,
  deadlineMs: number,
): Promise<{ videoIdsByChannel: Map<string, string[]>; calls: number }> {
  const videoIdsByChannel = new Map<string, string[]>();
  let calls = 0;
  const poolId = keyState.poolId ?? YOUTUBE_GROWTH_POOL_ID;
  // 인시던트 2026-09-29 Codex 리뷰 #1: 오늘 이미 일일 소진으로 확정된 풀이면 콜을 태우지도 않는다
  // — 단, 이 스킵을 **성공**으로 위장해 돌려주지 않는다(예전 실수: 빈 Map 을 정상 반환하면 W75
  // 관측 receipt 가 이 채널들을 examined 로 보고 offset 을 전진·완료시켜, 쿼터 리셋 뒤에도 다시
  // 시도할 기회를 영영 잃는다 — functions/ytdlpPromotionSweep.ts 의 offset 전진은 정상 반환과
  // 예외를 구분하지 못한다). 그래서 YoutubeQuotaPoolExhaustedError 를 던져 기존 recordFailure
  // 경로(레인 offset 불변·lease 해제·다음 sweep 재시도)를 그대로 태운다.
  // 인시던트 2026-09-29 Codex 리뷰 라운드3: dailyQuotaExhausted:true 를 명시로 싣는다 — 이 마커는
  // **오직** 일일 소진(fetchYouTubeRecord 의 dailyQuotaExhausted===true)에만 세워지므로, 여기
  // 도달했다는 것 자체가 이미 일일 소진 확정이다. ytdlpPromotionSweep.ts 의 쿼터 유예 분류가 이
  // 필드로 nextEligibleAtIso(다음 PT 리셋)를 세운다 — 없으면 단기 429 로 오분류돼 다음 스윕에
  // 바로 재시도하고, 방금 확정된 일일 소진과 똑같이 또 스킵되는 헛수고가 반복된다.
  if (await isYoutubeTopVideoQualificationExhaustedToday(poolId)) {
    console.info("[discovery-video-qualification] top video qualification pool already exhausted for today — skipping search", { poolId });
    throw Object.assign(new YoutubeQuotaPoolExhaustedError(poolId), { dailyQuotaExhausted: true });
  }
  for (const channelId of channelIds.slice(0, AI_DRAMA_TOP_VIDEO_CHANNEL_SAMPLE_LIMIT)) {
    assertDiscoveryDeadline(deadlineMs, "youtube top video qualification search", YOUTUBE_API_FETCH_TIMEOUT_MS + 2_000);
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("channelId", channelId);
    url.searchParams.set("order", "viewCount");
    url.searchParams.set("maxResults", String(AI_DRAMA_TOP_VIDEO_RESULTS_PER_CHANNEL));
    let response: Record<string, unknown>;
    try {
      response = await fetchYouTubeRecord(url, "YouTube top video qualification search failed", keyState);
    } catch (error) {
      // 인시던트 2026-09-29 Codex 리뷰 #1/#4: quotaLimited 가 아니면(진짜 결함) 그대로 던진다.
      // quotaLimited 면 — 이 시점에 fetchYouTubeRecord 는 이미 own-pool 전 키와(가능했다면)
      // 차용까지 다 써 본 뒤다(Codex 리뷰 #3, fetchYouTubeRecord 자체의 재시도) — **일일 소진**
      // (dailyQuotaExhausted, 기존 youtubeSearchDailyQuotaExhausted 판정 재사용)에만 하루 마커를
      // 세운다. 단기 429(rateLimitExceeded 등)는 W59-6 이 이미 정립한 구분대로 마커 없이 이번
      // pass 만 접고 다음 시간에 새로 시도한다("skip this tick only"). 어느 쪽이든 부분 결과를
      // **성공으로 위장하지 않는다** — 위 마커-스킵과 같은 이유로 그대로 던져 recordFailure
      // 경로(재시도 보장)를 태운다.
      if ((error as { quotaLimited?: unknown } | null)?.quotaLimited !== true) throw error;
      if ((error as { dailyQuotaExhausted?: unknown } | null)?.dailyQuotaExhausted === true) {
        await markYoutubeTopVideoQualificationExhaustedToday(poolId);
        console.warn("[discovery-video-qualification] top video qualification search daily-exhausted — marking for the rest of the day", { poolId });
      } else {
        console.warn("[discovery-video-qualification] top video qualification search rate-limited — retrying next pass (no day-long marker)", { poolId });
      }
      throw error;
    }
    calls += 1;
    const videoIds = (Array.isArray(response.items) ? response.items.map(asRecord) : [])
      .map((item) => asString(asRecord(item.id).videoId))
      .filter((videoId): videoId is string => Boolean(videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)));
    if (videoIds.length > 0) videoIdsByChannel.set(channelId, [...new Set(videoIds)]);
  }
  return { videoIdsByChannel, calls };
}

export function applyVideoQualificationEvidence(
  candidates: readonly CandidateResult[],
  evidenceByChannelId: ReadonlyMap<string, readonly QualifyingVideoEvidence[]>,
  options: { minVideoViews: number; minVideoCount: number; observedAtIso: string; boundedSample: Record<string, unknown> },
): CandidateResult[] {
  const requiredCount = Math.max(1, Math.trunc(options.minVideoCount));
  return candidates.flatMap((candidate) => {
    const channelId = promotionChannelIdFromCandidate(candidate);
    const evidences = [...(evidenceByChannelId.get(channelId) ?? [])]
      .filter((evidence) => evidence.viewCount >= options.minVideoViews)
      .filter((evidence, index, array) => array.findIndex((item) => item.videoId === evidence.videoId) === index)
      .sort((left, right) => right.viewCount - left.viewCount);
    if (evidences.length < requiredCount) return [];
    return [{
      ...candidate,
      qualifyingVideo: evidences[0],
      videoQualification: {
        minVideoViews: options.minVideoViews,
        minVideoCount: requiredCount,
        qualifyingVideoCount: evidences.length,
        unknownDisposition: "reject",
        observedAtIso: options.observedAtIso,
        boundedSample: options.boundedSample,
      },
      signals: candidate.signals.includes("qualifiedVideo") ? candidate.signals : [...candidate.signals, "qualifiedVideo"],
    }];
  });
}

async function qualifyCandidatesByObservedVideoViews(
  candidates: readonly CandidateResult[],
  channelVideoIds: ReadonlyMap<string, readonly string[]>,
  options: { minVideoViews: number; minVideoCount: number; keyState: YoutubeKeyState; deadlineMs: number },
): Promise<{ candidates: CandidateResult[]; evidence: VideoQualificationResult }> {
  const threshold = Math.max(1, Math.trunc(options.minVideoViews));
  const requiredCount = Math.max(1, Math.trunc(options.minVideoCount));
  const observedAtIso = new Date().toISOString();
  const candidateChannelIds = [...new Set(candidates.map((candidate) => promotionChannelIdFromCandidate(candidate)).filter(Boolean))];
  const matchedInput = new Map<string, string[]>();
  for (const channelId of candidateChannelIds) {
    const videoIds = [...new Set(channelVideoIds.get(channelId) ?? [])];
    if (videoIds.length > 0) matchedInput.set(channelId, videoIds);
  }

  const evidenceByChannelId = new Map<string, QualifyingVideoEvidence[]>();
  let units = 0;
  if (matchedInput.size > 0) {
    const matched = await fetchVideoItemsForEvidence(matchedInput, options.keyState, options.deadlineMs);
    units += matched.calls * YOUTUBE_VIDEOS_UNITS_PER_CALL;
    for (const [channelId, items] of matched.byChannel) {
      evidenceByChannelId.set(channelId, qualifyingVideoEvidencesFromRecords(items, "youtube.matched_videos", threshold, observedAtIso));
    }
  }

  const unresolvedChannelIds = candidateChannelIds.filter((channelId) => (evidenceByChannelId.get(channelId)?.length ?? 0) < requiredCount);
  let topVideoChannelsSampled = 0;
  if (unresolvedChannelIds.length > 0) {
    const topIds = await fetchTopVideoIdsForChannels(unresolvedChannelIds, options.keyState, options.deadlineMs);
    topVideoChannelsSampled = topIds.videoIdsByChannel.size;
    units += topIds.calls * YOUTUBE_SEARCH_UNITS_PER_CALL;
    if (topIds.videoIdsByChannel.size > 0) {
      const topItems = await fetchVideoItemsForEvidence(topIds.videoIdsByChannel, options.keyState, options.deadlineMs);
      units += topItems.calls * YOUTUBE_VIDEOS_UNITS_PER_CALL;
      for (const [channelId, items] of topItems.byChannel) {
        const existing = evidenceByChannelId.get(channelId) ?? [];
        evidenceByChannelId.set(channelId, [
          ...existing,
          ...qualifyingVideoEvidencesFromRecords(items, "youtube.channel_top_videos", threshold, observedAtIso),
        ]);
      }
    }
  }

  const qualified = applyVideoQualificationEvidence(candidates, evidenceByChannelId, {
    minVideoViews: threshold,
    minVideoCount: requiredCount,
    observedAtIso,
    boundedSample: {
      matchedVideoChannels: matchedInput.size,
      topVideoChannelsSampled,
      topVideoChannelSampleLimit: AI_DRAMA_TOP_VIDEO_CHANNEL_SAMPLE_LIMIT,
      topVideoResultsPerChannel: AI_DRAMA_TOP_VIDEO_RESULTS_PER_CHANNEL,
      absenceMeans: "no qualifying video observed in bounded sample",
    },
  });
  const candidateByChannelId = new Map<string, { best: QualifyingVideoEvidence; count: number }>();
  for (const candidate of qualified) {
    const channelId = promotionChannelIdFromCandidate(candidate);
    if (candidate.qualifyingVideo) candidateByChannelId.set(channelId, {
      best: candidate.qualifyingVideo,
      count: Math.trunc(asNumber(asRecord(candidate.videoQualification).qualifyingVideoCount) ?? 1),
    });
  }
  return { candidates: qualified, evidence: { candidateByChannelId, units, topVideoChannelsSampled } };
}

function resolveHydrationBudget(config: RuntimeIntegration): {
  channelLimit: number;
  unitBudget: number;
  hardCap: number;
} {
  const unitBudget = Math.max(
    1,
    Math.min(
      YOUTUBE_HYDRATION_UNIT_BUDGET_PER_RUN,
      Math.trunc(publicNumber(config, "youtubeHydrationUnitBudget", "YOUTUBE_HYDRATION_UNIT_BUDGET", YOUTUBE_HYDRATION_UNIT_BUDGET_PER_RUN)),
    ),
  );
  const configuredLimit = Math.max(
    1,
    Math.trunc(publicNumber(config, "youtubeChannelLookupLimit", "YOUTUBE_CHANNEL_LOOKUP_LIMIT", YOUTUBE_CHANNEL_LOOKUP_LIMIT)),
  );
  return {
    channelLimit: Math.min(YOUTUBE_CHANNEL_LOOKUP_LIMIT, configuredLimit, unitBudget * YOUTUBE_CHANNELS_LIST_BATCH_SIZE),
    unitBudget,
    hardCap: YOUTUBE_CHANNEL_LOOKUP_LIMIT,
  };
}

/**
 * W115 A2 — **channels.list 를 부르기 전에** candidate_pool 을 대조한다.
 *
 * candidate_pool 문서 ID 는 채널 ID 다(`candidateRef: candidate_pool/${channelId}`, 이 파일의
 * hydration 매퍼가 그렇게 만든다) — 그래서 인덱스 쿼리가 아니라 **doc id 배치 읽기**(getAll)로 끝난다.
 * 쿼리를 쓰면 새 복합 인덱스가 필요하고 비용도 훨씬 크다.
 *
 * 실패해도 던지지 않는다: 프리필터는 최적화이지 정확성 축이 아니다. 읽기가 죽으면 종전대로
 * 전량 hydration 한다(fail-open) — 여기서 fail-closed 로 가면 Firestore 일시 장애가 발굴을 통째로 세운다.
 */
/**
 * W115-R1 [MEDIUM · 적대 리뷰]: 프리필터가 **왜** 아무 것도 걸러내지 않았는지의 축.
 *
 * 종전에는 실패 시 빈 Map 을 돌려줬고, 그건 "아는 채널이 하나도 없다"와 **구분이 불가능**했다 —
 * Firestore 가 며칠 죽어 프리필터가 전량 fail-open 으로 돌아도 로그의 `knownSkipped: 0` 은
 * 정상 신규 유입과 같은 모양이라 아무도 못 본다.
 */
export type HydrationPrefilterStatus = "applied" | "failed_open" | "skipped_promotion";

async function readKnownChannelRecords(
  channelIds: readonly string[],
): Promise<{ known: Map<string, KnownChannelRecord | null>; status: HydrationPrefilterStatus }> {
  const known = new Map<string, KnownChannelRecord | null>();
  const unique = [...new Set(channelIds.filter(Boolean))];
  for (let offset = 0; offset < unique.length; offset += KNOWN_CHANNEL_LOOKUP_BATCH_SIZE) {
    const page = unique.slice(offset, offset + KNOWN_CHANNEL_LOOKUP_BATCH_SIZE);
    try {
      const snapshots = await adminDb.getAll(...page.map((channelId) => adminDb.collection("candidate_pool").doc(channelId)));
      snapshots.forEach((snapshot, index) => {
        known.set(page[index], snapshot.exists ? (snapshot.data() ?? {}) as KnownChannelRecord : null);
      });
    } catch (error) {
      console.warn("[discovery-prefilter] known-channel lookup failed; hydrating without prefilter", {
        batchSize: page.length,
        errorCode: (error as { code?: unknown } | null)?.code ?? "unknown",
      });
      return { known: new Map(), status: "failed_open" };
    }
  }
  return { known, status: "applied" };
}

/**
 * A4 — 세그먼트 노출률 집계 상태 문서. 채널그래프 커서와 **같은 lane 상태 컬렉션**을 쓴다:
 * 새 컬렉션을 만들면 규칙·백업·정리 대상이 하나 늘 뿐, 이 값은 그 커서와 성격이 같다(회전 스캔 상태).
 * 서버 전용이다 — firestore.rules 는 기본 거부이고 이 컬렉션에 read 예외가 없다(SEC-P0-004).
 */
const SEGMENT_EMAIL_RATE_STATE_DOC = "segment_email_rates";

function segmentEmailRateStateRef() {
  return adminDb.collection(COMMUNITY_DISCOVERY_STATE_COLLECTION).doc(SEGMENT_EMAIL_RATE_STATE_DOC);
}

function readSegmentEmailCounts(value: unknown): SegmentEmailCounts {
  const record = asRecord(value);
  const segments: Record<string, { total: number; withEmail: number }> = {};
  for (const [key, entry] of Object.entries(asRecord(record.segments))) {
    const item = asRecord(entry);
    const total = asNumber(item.total) ?? 0;
    if (total <= 0) continue;
    segments[key] = { total, withEmail: asNumber(item.withEmail) ?? 0 };
  }
  return { total: asNumber(record.total) ?? 0, withEmail: asNumber(record.withEmail) ?? 0, segments };
}

/**
 * A4 — 이번 런의 랭킹 근거를 읽는다(런당 문서 1건).
 *
 * 실패·미승격이면 `null` 이고, 그때 랭킹은 **항등**이 된다(fail-open). A2 프리필터와 같은 계약이다:
 * 랭킹은 최적화이지 정확성 축이 아니라, 여기서 fail-closed 로 가면 상태 문서 하나가 발굴을 세운다.
 */
async function readSegmentEmailRateTable(): Promise<SegmentEmailRateTable | null> {
  try {
    const published = asRecord(asRecord((await segmentEmailRateStateRef().get()).data()).published);
    const segments: Record<string, number> = {};
    for (const [key, value] of Object.entries(asRecord(published.segments))) {
      const rate = asNumber(value);
      if (rate !== undefined && rate >= 0) segments[key] = rate;
    }
    if (Object.keys(segments).length === 0) return null;
    return { globalRate: asNumber(published.globalRate) ?? 0, sampleSize: asNumber(published.sampleSize) ?? 0, segments };
  } catch (error) {
    console.warn("[discovery-segment-rates] rate table read failed; hydration ranking disabled", {
      errorCode: (error as { code?: unknown } | null)?.code ?? "unknown",
    });
    return null;
  }
}

/**
 * A4 — candidate_pool 을 **문서 ID 순으로 회전 스캔**하며 세그먼트별 이메일 노출률을 집계한다.
 *
 * 왜 신규 스케줄이 아닌가: 이 계산은 5분 워커가 이미 도는 프로세스에 얹으면 끝나는 일이고,
 * 스케줄을 하나 늘리면 배포 표면(락·타임아웃·불변식 핀)이 통째로 하나 늘어난다.
 * 자기 간격(SEGMENT_EMAIL_RATE_SCAN_INTERVAL_MS)으로 스스로를 조이므로 워커 주기와 독립이다.
 *
 * 왜 count() 조합이 아닌가: 세그먼트 키가 `국가 × 카테고리 × 밴드` 의 곱이라 count() 를 세그먼트마다
 * 쏘려면 쿼리 수가 세그먼트 수만큼 늘고 복합 인덱스도 그만큼 필요하다. 페이지 순회는 인덱스 0개에
 * **읽기 상한이 상수**(페이지 500)라 비용이 예측 가능하다.
 *
 * COST-P0-006: 한 pass 의 읽기 상한은 `SEGMENT_EMAIL_RATE_SCAN_PAGE_LIMIT` 이고 실제 읽은 수를
 * 로그로 남긴다. `select()` 로 필요한 5필드만 받아 대역폭도 함께 조인다(publicDescription 5,000자를
 * 매 pass 끌어오지 않는다).
 *
 * 한 바퀴를 다 돌기 **전에는 표로 승격하지 않는다** — 부분 스캔은 문서 ID 구간의 표본이라
 * 세그먼트 분포가 그 구간에 치우친다(치우친 표를 쓰면 랭킹이 그 치우침을 그대로 증폭한다).
 */
async function refreshSegmentEmailRates(nowIso: string): Promise<{ docsRead: number; cycleCompleted: boolean } | null> {
  const stateRef = segmentEmailRateStateRef();
  const stored = asRecord((await stateRef.get()).data());
  // A4-R2: 키 스키마 버전이 다르면 원장·표를 리셋한다 — 구 포맷 키를 이어받으면 조회 전량이 전역
  // 폴백으로 떨어지고 구 키가 cap 슬롯을 먹어, 정규화를 고친 배포가 최대 두 사이클 동안 A4 를
  // 무력화한다. 리셋 후 첫 완주까지는 전역 폴백(안전)이고 그 뒤는 깨끗한 표다. 간격 도장은 유지.
  const storedKeyVersion = Math.trunc(Number(stored.keyVersion)) || 0;
  const state = storedKeyVersion === SEGMENT_EMAIL_RATE_KEY_VERSION
    ? stored
    : { lastScanAtIso: stored.lastScanAtIso };
  const lastScanMs = Date.parse(asString(state.lastScanAtIso) ?? "");
  const nowMs = Date.parse(nowIso);
  if (Number.isFinite(lastScanMs) && Number.isFinite(nowMs) && nowMs - lastScanMs < SEGMENT_EMAIL_RATE_SCAN_INTERVAL_MS) {
    return null;
  }
  const cursor = asString(state.cursor) ?? "";
  const query = adminDb.collection("candidate_pool")
    .orderBy(FieldPath.documentId())
    .select("category", "creatorCountry", "region", "followers", "email")
    .limit(SEGMENT_EMAIL_RATE_SCAN_PAGE_LIMIT);
  const snapshot = await (cursor ? query.startAfter(cursor) : query).get();
  const samples = snapshot.docs.map((doc) => {
    const data = asRecord(doc.data());
    return {
      country: asString(data.creatorCountry) ?? asString(data.region),
      category: asString(data.category),
      followers: data.followers,
      email: data.email,
    };
  });
  const building = accumulateSegmentEmailCounts(readSegmentEmailCounts(state.building), samples);
  // 페이지가 상한보다 짧으면 컬렉션 끝이다 — 그 순간이 한 바퀴의 완료 시점이고 승격 시점이다.
  const cycleCompleted = snapshot.docs.length < SEGMENT_EMAIL_RATE_SCAN_PAGE_LIMIT;
  // 리뷰(A4-R1): 자격 세그먼트 0 인 완주는 승격하지 않는다 — 빈 표로 직전 정상 표를 덮으면
  // readSegmentEmailRateTable 이 null 을 돌려 A4 가 영구 자기정지한다(안전 방향이지만 비복귀).
  const publishedCandidate = cycleCompleted ? publishSegmentEmailRates(building) : null;
  const published = publishedCandidate && Object.keys(publishedCandidate.segments).length > 0
    ? publishedCandidate
    : null;
  await stateRef.set({
    keyVersion: SEGMENT_EMAIL_RATE_KEY_VERSION,
    cursor: cycleCompleted ? "" : (snapshot.docs[snapshot.docs.length - 1]?.id ?? ""),
    lastScanAtIso: nowIso,
    building: cycleCompleted ? EMPTY_SEGMENT_EMAIL_COUNTS : building,
    // 승격 전에는 **직전 표를 그대로 들고 간다** — 새 바퀴가 도는 동안 랭킹이 꺼지면
    // A4 는 매 바퀴마다 몇 시간씩 무력해진다.
    published: published ? { ...published, publishedAtIso: nowIso } : asRecord(state.published),
    updatedAt: FieldValue.serverTimestamp(),
  });
  // COST-P0-006: 읽기 비용과 그 대가(집계 표본·세그먼트 수)를 한 줄로. 채널 ID·이메일은 싣지 않는다(SEC-P0-009).
  console.info(JSON.stringify({
    event: "discovery.segment_email_rate_scan",
    docsRead: snapshot.docs.length,
    pageLimit: SEGMENT_EMAIL_RATE_SCAN_PAGE_LIMIT,
    scannedTotal: building.total,
    segmentsTracked: Object.keys(building.segments).length,
    cycleCompleted,
    ...(published
      ? { segmentsKnown: Object.keys(published.segments).length, globalRate: published.globalRate, sampleSize: published.sampleSize }
      : {}),
  }));
  return { docsRead: snapshot.docs.length, cycleCompleted };
}

/**
 * 헤세 결정(2026-09-27) "AI Drama만 상시 허용" — settings/ytdlp_promotion 문서가 정확히 이 캠페인을
 * 가리키고, `primaryLaneApprovalRef` 가 그 결정의 참조 문자열과 일치하며, **캠페인·프로그램 문서를
 * 직접 다시 읽어서** 그 캠페인이 실제로 ai_drama 버티컬인지 재확인했을 때만 true다. 셋 중 하나라도
 * 아니면 false — search.list 키워드 레인은 종전대로 돈다(fail-closed: 설정이 없거나 불완전하거나
 * 조회가 실패하면 아무것도 안 바뀐다).
 *
 * 코덱스 라운드1 적대 리뷰 수리:
 *   · BLOCKER — `campaignRef` 는 스코프드 호출부에서 `campaigns/<id>` 형태고 설정 문서의
 *     `campaignId` 는 맨 ID 다. 접두어를 벗기지 않으면 절대 일치하지 않아 이 레인이 아무 효과가
 *     없었다.
 *   · HIGH — 호출자가 준 `discoveryVertical` 파라미터를 신뢰하면, 그 값과 `enqueueNextShadowJob`
 *     이 캠페인/프로그램 문서에서 **독립적으로 재계산**한 버티컬이 서로 어긋날 수 있다(캠페인
 *     `targetingCriteria`·프로그램 `candidateCriteria` 필드 형태 차이). 어긋나면 "실검색은 꺼졌는데
 *     스윕도 거절"하는 완전한 공급 단절이 생긴다. 그래서 여기서는 호출자의 discoveryVertical 을
 *     아예 받지 않고, `enqueueNextShadowJob` 과 **동일한 경로**(`resolveProgramDiscoveryCriteria`)로
 *     캠페인·프로그램 문서를 직접 읽어 재확인한다 — 두 게이트의 판정이 구조적으로 갈릴 수 없다.
 *   · MEDIUM — Firestore 조회 실패가 이 검색 패스 전체를 던지지 않는다. 실패하면 로그만 남기고
 *     false 로 fail-open 한다(= 종전처럼 search.list 가 그대로 돈다. "primary 취급을 못 받는다"는
 *     방향의 fail이라 안전하다).
 *
 * true 여도 이 함수 자체는 아무것도 쓰지 않는다 — 호출부가 이 값으로 자신의 search.list 루프를
 * 스킵할지만 결정한다. yt-dlp 관측 승격 경로(observedChannels)는 이미 그 루프를 무조건 스킵하므로
 * (W75) 이 게이트를 몰라도 된다 — 여기서 검사하는 것은 오직 **실검색(search.list) 패스**뿐이다.
 *
 * 코덱스 라운드2 HIGH 수리 — **자동 회복(자가 치유) 조건.** 승인 문자열·버티컬이 다 맞아도 대체
 * 공급(스윕)이 실제로 죽어 있으면(키워드 우주 소진·활성화 만료·디스패치 실패 등) search.list 를 계속
 * 꺼 둔 채 방치하면 안 된다 — "배포 직전에 로그로 한 번 확인했다"는 그 순간의 증거일 뿐, 그 뒤의
 * 장애를 못 잡는다. 그래서 매 패스마다 `ytdlp_promotion_daily`(오늘·어제) 문서를 같이 본다 —
 * 최근 이틀 안에 증거가 하나도 없으면 "공급 증거 없음"으로 보고 이 패스는 search.list 를 그대로
 * 돌린다. 승인 자체는 그대로 유지된다: 공급이 돌아오면 다음 패스부터 다시 자동으로 꺼진다 —
 * 사람이 설정을 껐다 켰다 할 필요가 없는 **자동 롤백/자동 재개**다.
 *
 * 코덱스 라운드3 HIGH 수리: `observedCount`(이 배치가 **처리한** 관측 수)가 아니라
 * `candidatesCreatedCount`(이 배치가 **실제로 새로 만든 후보 수**, ytdlpPromotionSweep.ts 가 같은
 * 문서에 같이 쓴다)를 본다. dedup(이미 아는 채널·이미 접촉한 채널)로 100% 걸러지는 비생산적
 * 배치도 observedCount 는 그대로 올리므로, 그 값만으로는 "공급이 산다"가 아니라 "스윕이 죽지는
 * 않았다"만 증명한다 — 진짜 필요한 증거는 후보가 실제로 나왔는가다.
 */
async function hasRecentYtdlpPromotionSupplyEvidence(nowMs: number = Date.now()): Promise<boolean> {
  // apiQuota.ts 의 seoulDayKey(Date 인자)를 쓴다 — ytdlpPromotionCore.ts 에도 같은 이름의 함수가
  // 있지만(nowMs 인자, 같은 Intl 포맷이라 값은 동일) 이 파일은 이미 apiQuota.ts 쪽을 임포트하고
  // 있어 이름이 충돌한다. 새 임포트를 늘리는 대신 이미 있는 것을 쓴다.
  const [todaySnapshot, yesterdaySnapshot] = await Promise.all([
    adminDb.collection(YTDLP_PROMOTION_DAILY_COLLECTION).doc(seoulDayKey(new Date(nowMs))).get(),
    adminDb.collection(YTDLP_PROMOTION_DAILY_COLLECTION).doc(seoulDayKey(new Date(nowMs - 24 * 60 * 60 * 1000))).get(),
  ]);
  const createdToday = asNumber(todaySnapshot.data()?.candidatesCreatedCount) ?? 0;
  const createdYesterday = asNumber(yesterdaySnapshot.data()?.candidatesCreatedCount) ?? 0;
  return createdToday > 0 || createdYesterday > 0;
}

export async function isYtdlpPromotionPrimaryLaneApprovedForCampaign(campaignRef: string): Promise<boolean> {
  const campaignId = campaignRef.startsWith("campaigns/") ? campaignRef.slice("campaigns/".length) : campaignRef;
  if (!campaignId) return false;
  try {
    const configSnapshot = await adminDb.doc(YTDLP_PROMOTION_CONFIG_PATH).get();
    const resolution = resolveYtdlpPromotionConfig(configSnapshot.data());
    if (!resolution.enabled) return false;
    if (resolution.config.campaignId !== campaignId) return false;
    if (!resolution.config.primaryLaneApprovalRef
      || resolution.config.primaryLaneApprovalRef !== AI_DRAMA_YTDLP_PRIMARY_LANE_APPROVAL_REF) return false;

    const campaignSnapshot = await adminDb.collection("campaigns").doc(campaignId).get();
    if (!campaignSnapshot.exists) return false;
    const campaign = campaignSnapshot.data() ?? {};
    const rawProgramId = asString(campaign.programId) ?? asString(campaign.canonicalProgramId) ?? "";
    const canonicalProgramId = resolveCanonicalProgramId(rawProgramId);
    if (!rawProgramId || !canonicalProgramId) return false;
    const programSnapshot = await adminDb.collection("programs").doc(canonicalProgramId).get();
    if (!programSnapshot.exists) return false;
    const liveDiscoveryVertical = resolveProgramDiscoveryCriteria(programSnapshot.data() ?? {}, campaign).criteria.discoveryVertical;
    if (!YTDLP_PROMOTION_PRIMARY_LANE_ALLOWED_VERTICALS.includes(liveDiscoveryVertical)) return false;

    const supplyHealthy = await hasRecentYtdlpPromotionSupplyEvidence();
    if (!supplyHealthy) {
      // 코덱스 라운드2 MEDIUM 수리 겸용 — 설정은 승인처럼 보이는데 실제로 안 켜져 있는 상태가
      // 조용히 무기한 지속되면 안 된다. 이 로그가 "왜 아직도 search.list 가 도나"에 답한다.
      console.warn(JSON.stringify({
        event: "youtube-discovery.ytdlp_primary_lane_supply_stale",
        campaignId,
        hint: "no ytdlp_promotion_daily candidatesCreatedCount in the last 48h — falling back to search.list until supply resumes",
      }));
      return false;
    }
    return true;
  } catch (error) {
    console.warn(JSON.stringify({
      event: "youtube-discovery.ytdlp_primary_lane_check_failed",
      campaignId,
      errorCode: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    }));
    return false;
  }
}

async function searchYouTubeLive(
  data: ParsedYoutubeSearchData,
  deadlineMs = Date.now() + DISCOVERY_WORKER_MATERIALIZE_DEADLINE_MS,
  persistence: YoutubeDiscoveryPersistence = { mode: "global_candidate_pool", source: "youtube-data-api" },
  dependencies: YoutubeSearchLiveDependencies = DEFAULT_YOUTUBE_SEARCH_LIVE_DEPENDENCIES,
  observedChannels: readonly YtdlpPromotionObservedChannel[] | null = null,
): Promise<{
  results: CandidateResult[];
  cost: CostLog;
  newUnique: number;
  // W9-1: actual committed `created` outcomes are reduced by arm after persistence. Legacy callers
  // without sliceArmSlots still attribute all search observations to keyword.
  sliceArmStats?: Record<DiscoverySliceType, number>;
  // R28-1 (P0-C): 암별 실호출 계측 — 다음 pass 의 EWMA 분모다(배분 슬롯이 아니라 실제로 발사한 콜).
  sliceArmCalls?: SliceArmCalls;
  truncatedByQuota?: boolean;
  // W42 F-1: 비쿼터 실패로 중단됐지만 수확을 보존한 pass 의 증거(있으면 이 런은 partial 이다).
  harvestPartial?: YoutubeSearchHarvestPartial;
  classifiedIn?: number;
  classifiedOut?: number;
  classificationExceptions?: number;
  // W63 Phase 0 [API-only 기준선]: hydration 절단 실측. PRD §3.1 의 주장 — "손실은 검색 결과 부족이
  //   아니라 채널 hydration 절단과 하류 필터에서 난다" — 을 숫자로 확인/반증하는 축이다.
  //   yt-dlp 는 이 기준선을 **이겨야** 정당화된다. 계측만 한다: 절단 동작 자체는 그대로 둔다.
  hydrationOverflow?: HydrationOverflowStat;
  /** W115 C1: 레인별 유닛·수율. `유닛/이메일` 비교의 유일한 근거다. */
  laneCostYield?: Record<string, LaneCostYield>;
  /** W115 C1: 이 런이 태운 총 유닛(search + hydration + 설명란 + 보조 레인). */
  unitsSpent?: number;
  /** W115 A3: 설명란에서 새로 캔 이메일 수(About 으로는 못 얻었을 순증분). */
  videoDescriptionEmails?: number;
  /**
   * 헤세 결정(2026-09-27) — true 면 이번 패스는 ytdlpPrimaryLaneApproved 로 인해 **search.list 를
   * 아예 호출하지 않았다**(쿼터 소진·API 실패로 0건이 된 것이 아니다). 코덱스 라운드1 HIGH-3 수리:
   * 호출부는 이 값이 true 면 이 결과를 "실검색 0건"으로 캐시하거나 검색-원장(searched:true/쿼리
   * 수율)에 반영하면 안 된다 — 승인이 철회된 뒤에도 캐시 TTL 동안 빈 결과가 굳어 있게 되고,
   * 실검색이 없었는데 있었던 것처럼 원장이 오염된다.
   */
  primaryLaneSkipped?: true;
} | null> {
  if (!liveIntegrationsEnabled("youtube")) return null;

  const staging = isStagingRuntime();
  const config = await getRuntimeIntegration("externalApi");
  const settings = await readSettings();
  const settingsCountryTargeting: CountryTargeting = {
    countryScope: "include",
    includedCountries: normalizeYoutubeCreatorCountryAllowlist(settings.feed.youtubeCreatorCountries),
    excludedCountries: [],
  };
  const effectiveCountryTargeting = data.countryTargeting.countryScope === "inherit"
    ? resolveCountryTargeting(data.countryTargeting, settingsCountryTargeting)
    : resolveCountryTargeting(data.countryTargeting);
  // R21-2/W9-0-FIX2: 검색은 예약분을 지키고, channels.list 만 폴백 소진 뒤 주 키를 마지막으로 쓴다.
  // Flu/W2: data.ownerOrgId 가 없거나 매핑이 없으면 resolvePoolIdForOrg 가 growth 를 돌려주므로
  // nonGrowthYoutubePoolId 는 undefined 로 남고 아래는 종전과 바이트 단위로 동일하게 동작한다.
  // growth 를 명시적으로 poolId 필드에 싣지 않는다 — fetchYouTubeRecord 의 몇몇 분기(예:
  // noteYoutubeSearchCallConsumed 가드)는 `!poolId`(undefined 판정)로 growth 를 가려내므로, 리터럴
  // "growth" 문자열을 poolId 에 넣으면 그 가드가 오발화한다(Codex 적대 리뷰 재확인 사항).
  const resolvedYoutubePoolId = await resolvePoolIdForOrg(data.ownerOrgId ?? null);
  const nonGrowthYoutubePoolId = resolvedYoutubePoolId !== YOUTUBE_GROWTH_POOL_ID ? resolvedYoutubePoolId : undefined;
  const youtubeKeyState: YoutubeKeyState = {
    index: 0,
    lane: "discovery",
    ...(nonGrowthYoutubePoolId ? { poolId: nonGrowthYoutubePoolId } : {}),
  };
  const configuredPageSize = Math.min(50, Math.max(1, Math.trunc(publicNumber(config, "youtubeMaxResults", "YOUTUBE_MAX_RESULTS", 50))));
  const configuredMaxPages = Math.max(1, Math.min(YOUTUBE_SEARCH_MAX_PAGES, Math.trunc(publicNumber(config, "youtubeMaxPages", "YOUTUBE_MAX_PAGES", YOUTUBE_SEARCH_MAX_PAGES))));
  const { requestedLimit, pageSize, maxPages: resultPageLimit } = youtubeLiveSearchLimits(
    data.resultLimit,
    configuredPageSize,
    configuredMaxPages,
    staging,
  );
  const discoveryVertical = data.discoveryVertical ?? "game";
  const defaultCategories = discoveryVertical === "ai_drama" ? [...AI_DRAMA_DISCOVERY_CATEGORIES] : ["mobile casual game"];
  const categoryLimit = discoveryVertical === "ai_drama" ? 40 : 12;
  const categories = (data.filters.categories.length > 0 ? data.filters.categories : data.filters.categoriesExplicit ? [] : defaultCategories)
    .map((category) => category.trim())
    .filter(Boolean)
    .slice(0, categoryLimit);
  const regions = (data.filters.regions.length > 0 ? data.filters.regions : [""])
    .map((region) => normalizeYoutubeCreatorCountry(region) ?? region.trim().toUpperCase())
    .filter((region, index, array) => array.indexOf(region) === index)
    .slice(0, 12);
  // R27: sliceArmSlots 가 없으면(기존 4개 호출부) buildDiscoveryQueryPlan 이 R27 이전과 완전히
  // 동일한 100% keyword 플랜을 만든다 — 아래 로직의 나머지는 sliceType 분기가 있어도 keyword 항목만
  // 있을 때는 옛 URL/스코어 계약과 바이트 단위로 같다(q 항상 설정, 게이트 미적용).
  const queryPlan = buildDiscoveryQueryPlan(categories, regions, data.sliceArmSlots, discoveryVertical);
  const targetKeywords = discoveryVertical === "ai_drama" ? categories : [...categories, ...BASE_TARGET_KEYWORDS];
  // recentActivityDays 하한 — search 자체를 최신 업로드로 제한해 과거글 과다 유입을 근본 차단.
  const publishedAfterIso = youtubePublishedAfterIso(data.filters.recentActivityDays);
  const channelIds: string[] = [];
  const seenChannelIds = new Set<string>();
  const channelMatchedSearchTerms = new Map<string, Set<string>>();
  // R27: 채널이 최초로 발견된 슬라이스 타입. keyword 로 한 번이라도 발견되면(그 쿼리 자체가 q 로 이미
  // 필터한 것이므로) 이후 broad/topic 재발견에도 절대 강등하지 않는다 — "keyword 로 발견된 채널은
  // 게이트 미적용"을 보수적으로 지킨다.
  const channelSliceType = new Map<string, DiscoverySliceType>();
  // 채널이 매칭된 영상들 중 가장 최근 publishedAt (여러 category×region 쿼리에 걸쳐 갱신됨).
  // scoreCandidate의 recencyFit 계산 신호로 쓰인다.
  const channelPublishedAtIso = new Map<string, string>();
  // W115 A3: 검색 응답이 **이미 들고 있는** videoId·설명란. 추가 호출 0으로 두 번째 이메일 소스가 된다.
  //   search.list 의 snippet.description 은 YouTube 가 잘라서 주지만(약 160자) 공짜다 — 공짜 소스를
  //   먼저 쓰고, 그래도 못 찾은 후보만 videos.list 백필(50영상/1유닛)로 넘긴다.
  const channelVideoIds = new Map<string, string[]>();
  const searchSnippetDescriptions = new Map<string, string>();
  // W75: 관측 소비자는 이미 yt-dlp 가 채널을 찾았다. search.list·그래프·인기차트를 다시 호출하면
  // "yt-dlp 관측 → 기존 hydration"이 아니라 API 검색을 한 번 더 하는 별도 발굴 레인이 된다.
  // 채널 ID와 실제 매칭 쿼리만 기존 매핑/국가/팔로워/렉시콘 게이트로 주입한다.
  if (observedChannels) {
    for (const observation of observedChannels.slice(0, YOUTUBE_CHANNEL_LOOKUP_LIMIT)) {
      const channelId = observation.channelId.trim();
      if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) continue;
      const matchedTerms = channelMatchedSearchTerms.get(channelId) ?? new Set<string>();
      observation.queryTerms.map((term) => term.trim()).filter(Boolean).forEach((term) => matchedTerms.add(term));
      channelMatchedSearchTerms.set(channelId, matchedTerms);
      const latestVideoPublishedAtIso = observation.latestVideoPublishedAtIso?.trim() ?? "";
      if (latestVideoPublishedAtIso && Number.isFinite(Date.parse(latestVideoPublishedAtIso))) {
        channelPublishedAtIso.set(channelId, latestVideoPublishedAtIso);
      }
      channelSliceType.set(channelId, "keyword");
      if (seenChannelIds.has(channelId)) continue;
      seenChannelIds.add(channelId);
      channelIds.push(channelId);
    }
  }
  // 헤세 결정(2026-09-27) "AI Drama만 상시 허용": 이 패스 자체가 이미 observedChannels(yt-dlp
  // 승격 경로)면 아래 값은 안 쓴다(그 경로는 이미 무조건 search.list 를 스킵한다 — 위 W75 주석).
  // 실검색(search.list) 패스에서만, 그리고 discoveryVertical 이 ai_drama 일 때만 조회한다 — game
  // 버티컬은 이 읽기 자체가 0회로 바이트 단위 불변이다.
  const ytdlpPrimaryLaneApproved = !observedChannels && discoveryVertical === "ai_drama"
    ? await isYtdlpPromotionPrimaryLaneApprovedForCampaign(data.campaignRef)
    : false;
  // R28-1/W9-1: 배분된 암은 queryPlan 에서 round-robin으로 인터리브한다. 기존 maxPages는
  // hard cap이므로 늘리지 않고, 밴딧 경로는 모든 첫 페이지를 먼저 연 뒤 남은 페이지를 다시 round-robin한다.
  const sliceArmCalls = emptySliceArmCalls();
  const activeSliceTypes = new Set(queryPlan.map((item) => item.sliceType));
  const attemptedSliceTypes = new Set<DiscoverySliceType>();
  const maxPages = resultPageLimit;
  const firstRoundPageSize = Math.min(
    pageSize,
    Math.max(1, Math.ceil(requestedLimit / Math.max(1, Math.min(activeSliceTypes.size, maxPages)))),
  );
  let searchPages = 0;
  let truncatedByQuota = false;
  const pagesPerQuery = Math.max(1, Math.ceil(maxPages / Math.max(1, queryPlan.length)));

  // W42 F-1: **비쿼터** 페이지 실패도 이미 쿼터를 태워 모아 둔 수확을 버리지 않는다 — W9-0/W9-0-FIX 가
  // 쿼터 절단에만 해 준 것의 대칭이다(100명을 모으고 101번째 페이지가 400/5xx 로 죽으면 종전에는 그
  // 100명이 호출부에 도달하지 못했다). 수확 0 이면 종전대로 던진다 — 0 을 partial 로 위장하면 키
  // 만료·자격증명 오류가 실패로 보이지 않는다. 던지는 경로도 실패 증거를 그대로 싣는다.
  let harvestPartial: YoutubeSearchHarvestPartial | undefined;
  const stopWithPreservedHarvest = (
    error: unknown,
    stage: YoutubeSearchHarvestPartial["stage"],
    harvested: number,
    failedAtPage: number,
  ): null => {
    if (harvested === 0) throw withSliceArmFailureEvidence(error, sliceArmCalls);
    harvestPartial = {
      stage,
      failedAtPage,
      harvestedChannels: channelIds.length,
      // 원문 payload·키가 아니라 fetchYouTubeRecord 가 만든 분류 가능한 메시지다(SEC-P0-009).
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 200),
    };
    return null;
  };

  const fetchSearchPage = async (
    item: DiscoveryQueryPlanItem,
    nextPageToken: string | undefined,
    maxResults: number,
  ): Promise<{ nextPageToken?: string } | null> => {
    assertDiscoveryDeadline(deadlineMs, "youtube search", YOUTUBE_API_FETCH_TIMEOUT_MS + 2_000);
    const searchUrl = buildYouTubeDiscoverySearchUrl(item, { maxResults, publishedAfterIso, pageToken: nextPageToken, discoveryVertical });
    const armCalls = sliceArmCalls[item.sliceType];
    // R28-1: fetch **직전**에 시도를 계상한다 — 실패한 검색도 이 암의 음성 표본이다.
    armCalls.attemptedSearchCalls += 1;
    attemptedSliceTypes.add(item.sliceType);
    let searchJson: Record<string, unknown>;
    try {
      searchJson = await fetchYouTubeRecord(searchUrl, "YouTube search failed", youtubeKeyState);
    } catch (error) {
      if ((error as { quotaLimited?: unknown } | null)?.quotaLimited !== true) {
        // W42 F-1: 수확이 있으면 여기서 멈추고 그대로 반환한다(수확 0 이면 helper 가 던진다).
        return stopWithPreservedHarvest(error, "search", channelIds.length, searchPages + 1);
      }
      truncatedByQuota = true;
      return null;
    }
    armCalls.successfulSearchCalls += 1;
    const searchItems = Array.isArray(searchJson.items) ? searchJson.items.map(asRecord) : [];
    for (const resultItem of searchItems) {
      const snippet = asRecord(resultItem.snippet);
      const channelId = asString(snippet.channelId) ?? asString(asRecord(resultItem.id).channelId);
      if (!channelId) continue;
      armCalls.rawChannelsSeen += 1;
      const matchedTerms = channelMatchedSearchTerms.get(channelId) ?? new Set<string>();
      if (item.category) matchedTerms.add(item.category);
      channelMatchedSearchTerms.set(channelId, matchedTerms);
      channelSliceType.set(channelId, attributeChannelSliceType(channelSliceType.get(channelId), item.sliceType));
      const publishedAt = asString(snippet.publishedAt);
      if (publishedAt) {
        const seenPublishedAt = channelPublishedAtIso.get(channelId);
        if (!seenPublishedAt || publishedAt > seenPublishedAt) channelPublishedAtIso.set(channelId, publishedAt);
      }
      // W115 A3: 채널당 최신 영상 몇 개만 담는다. 더 담아 봐야 백필 예산에서 잘리고, 담는 순간
      //   메모리만 는다(런당 최대 1,000채널 × 3 = 3,000 id).
      const videoId = asString(asRecord(resultItem.id).videoId);
      if (videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        const bucket = channelVideoIds.get(channelId) ?? [];
        if (bucket.length < VIDEO_DESCRIPTION_SAMPLE_PER_CHANNEL && !bucket.includes(videoId)) {
          bucket.push(videoId);
          channelVideoIds.set(channelId, bucket);
        }
        const snippetDescription = asString(snippet.description);
        if (snippetDescription) searchSnippetDescriptions.set(videoId, snippetDescription);
      }
      if (seenChannelIds.has(channelId)) continue;
      seenChannelIds.add(channelId);
      channelIds.push(channelId);
      if (!data.sliceArmSlots && channelIds.length >= requestedLimit) break;
    }
    searchPages += 1;
    return { ...(asString(searchJson.nextPageToken) ? { nextPageToken: asString(searchJson.nextPageToken) } : {}) };
  };

  if (!observedChannels && !data.sliceArmSlots && !ytdlpPrimaryLaneApproved) {
    searchPlan: for (const item of queryPlan) {
      let nextPageToken: string | undefined;
      let pagesForQuery = 0;
      while (
        channelIds.length < requestedLimit
        && pagesForQuery < pagesPerQuery
        && searchPages < maxPages
      ) {
        const page = await fetchSearchPage(
          item,
          nextPageToken,
          Math.min(pageSize, Math.max(1, requestedLimit - channelIds.length)),
        );
        if (!page) break searchPlan;
        pagesForQuery += 1;
        nextPageToken = page.nextPageToken;
        if (!nextPageToken) break;
      }
      if (searchPages >= maxPages || channelIds.length >= requestedLimit) break;
    }
  } else if (!observedChannels && !ytdlpPrimaryLaneApproved) {
    const continuations: Array<{ item: DiscoveryQueryPlanItem; pageToken: string }> = [];
    searchPlan: for (const item of queryPlan) {
      const firstRoundComplete = [...activeSliceTypes].every((sliceType) => attemptedSliceTypes.has(sliceType));
      if (searchPages >= maxPages || (channelIds.length >= requestedLimit && firstRoundComplete)) break;
      const firstCallForArm = !attemptedSliceTypes.has(item.sliceType);
      const page = await fetchSearchPage(
        item,
        undefined,
        firstCallForArm
          ? firstRoundPageSize
          : Math.min(pageSize, Math.max(1, requestedLimit - channelIds.length)),
      );
      if (!page) break searchPlan;
      if (page.nextPageToken) continuations.push({ item, pageToken: page.nextPageToken });
    }
    while (continuations.length > 0 && searchPages < maxPages && channelIds.length < requestedLimit) {
      const continuation = continuations.shift()!;
      const page = await fetchSearchPage(
        continuation.item,
        continuation.pageToken,
        Math.min(pageSize, Math.max(1, requestedLimit - channelIds.length)),
      );
      if (!page) break;
      if (page.nextPageToken) continuations.push({ item: continuation.item, pageToken: page.nextPageToken });
    }
  }

  // W9-3: 검색이 끝난 뒤(=검색 콜을 하나도 더 쓰지 않고) 이미 가진 사람들에서 1-hop 이웃을 캔다.
  // 검색이 0건이어도(쿼터 천장) 이 확장은 그대로 돈다 — 오늘 실측의 병목이 정확히 그 상태다.
  const graphNeighborIds = new Set<string>();
  // C1: 보조 레인의 **실호출 수**. 이 두 값이 없으면 "그래프 1유닛 vs 검색 100유닛"을 같은 척도로
  //   비교할 수 없다 — 종전에는 보조 레인이 비용 계측 밖에 있었다.
  let graphSeedCalls = 0;
  let popularRegionCalls = 0;
  // 리더 리크 조사(2026-09-27) [a]: ai_drama 는 channel_graph·most_popular 폴백을 전면 끈다 — 두
  // 레인 모두 game 인접 시드/게이밍 카테고리 전제라(위 readChannelGraphSeeds·fetchPopularSeedChannelIds
  // 주석) ai_drama 검색이 쿼터로 막혀도 무관한 채널을 채워 넣느니 그 pass 를 비워 두는 쪽이 맞다.
  const fallbackLanesDisabledForVertical = discoveryVertical === "ai_drama";
  // ⚠️ w75-ytdlp-promotion-mutation.test.mjs 가 "observedChannels && asBoolean(config.public.
  // youtubeGraphExpansion)" 리터럴 인접을 소스 앵커로 쓴다 — 새 조건은 반드시 **뒤에** 붙인다.
  if (!observedChannels && asBoolean(config.public.youtubeGraphExpansion) && !fallbackLanesDisabledForVertical) {
    const expansion = await expandChannelGraphNeighbors({
      seen: seenChannelIds,
      keyState: youtubeKeyState,
      deadlineMs,
      scope: { discoveryVertical, campaignRef: data.campaignRef },
    });
    graphSeedCalls = expansion.seedsAttempted;
    if (expansion.truncatedByQuota) truncatedByQuota = true;
    for (const channelId of expansion.neighbors) {
      graphNeighborIds.add(channelId);
      seenChannelIds.add(channelId);
      channelIds.push(channelId);
    }
  }

  // W9-4: 지역 인기 차트 시드도 검색 콜을 쓰지 않는다(videos.list=1유닛, Search Queries 버킷 아님).
  const popularSeedIds = new Set<string>();
  // ⚠️ w75-ytdlp-promotion-mutation.test.mjs 가 "observedChannels && asBoolean(config.public.
  // youtubePopularSeed)" 리터럴 인접을 소스 앵커로 쓴다 — 새 조건은 반드시 **뒤에** 붙인다.
  if (!observedChannels && asBoolean(config.public.youtubePopularSeed) && !fallbackLanesDisabledForVertical) {
    // W21 F-1: 캠페인 targetingCriteria.regions 가 빈 배열이면(프로드 주력 cp-bd7d1ea7aq4k 실측)
    // 위 정규화가 [""] 를 만들고 filter(Boolean) 이 그걸 지워 region 0개 = 이 레인 통째 no-op 이었다.
    // 설정의 발굴 대상국(settings.feed.youtubeCreatorCountries)으로 폴백한다 — 새 하드코딩 목록은
    // 만들지 않으므로 설정도 비어 있으면 종전대로 no-op 이다.
    const explicitPopularRegions = regions.filter(Boolean);
    const popular = await fetchPopularSeedChannelIds({
      regions: explicitPopularRegions.length > 0
        ? explicitPopularRegions
        : settingsCountryTargeting.includedCountries,
      seen: seenChannelIds,
      keyState: youtubeKeyState,
      deadlineMs,
      discoveryVertical,
    });
    popularRegionCalls = popular.regionsAttempted;
    if (popular.truncatedByQuota) truncatedByQuota = true;
    for (const channelId of popular.channelIds) {
      popularSeedIds.add(channelId);
      seenChannelIds.add(channelId);
      channelIds.push(channelId);
    }
  }

  if (fallbackLanesDisabledForVertical && truncatedByQuota) {
    // 사용자 질문("오늘 발굴이 왜 이렇게 적었나")에 답할 수 있는 유일한 흔적 — 폴백을 껐다는 사실
    // 자체가 로그에 없으면 "검색이 0건이었다"와 "검색은 됐는데 폴백을 스킵했다"를 구분할 수 없다.
    console.info("[youtube-discovery] ai_drama search quota-limited — skipping channel_graph/most_popular fallback (vertical-unsafe lanes)", {
      campaignRef: data.campaignRef,
      channelsFoundBeforeFallback: channelIds.length,
    });
  }

  if (ytdlpPrimaryLaneApproved) {
    // 헤세 결정(2026-09-27) 감사 흔적 — search.list 를 아예 호출하지 않은 이유가 로그에 없으면
    // "검색 0건"과 "의도적으로 스킵"을 구분할 수 없다. 실제 후보는 scheduled_promotion 잡의
    // observedChannels 경로(hydrateYtdlpPromotionObservations)가 별도 스윕에서 공급한다.
    console.info("[youtube-discovery] ai_drama primary lane approved — skipping search.list keyword lane", {
      campaignRef: data.campaignRef,
      lane: "ytdlp_search",
      primaryLaneApprovalRef: AI_DRAMA_YTDLP_PRIMARY_LANE_APPROVAL_REF,
    });
  }

  if (channelIds.length === 0) {
    // R28-6 [LOW-2]: 검색 콜은 실제로 나갔는데 채널이 0건인 pass 다 — 밴딧이 반드시 배워야 할 음성
    // 표본이다. sliceArmStats 를 빼면 admin.ts 의 갱신 근거 가드에 걸려 이 pass 가 학습에서 통째로
    // 빠지고(원장 무갱신), 성공 pass 만 반영돼 전 암 수익률이 공통 상향 편향된다. 암별 0 을 명시해
    // 실호출 분모(sliceArmCalls)와 함께 그대로 싣는다 — 실행되지 않은 암은 attempted 0 이라
    // applySliceArmEwmaUpdate 가 여전히 건너뛴다(R28-1 계약 유지).
    return {
      results: [],
      cost: costLog("youtube-data-api-v3", "youtube-data-api", 0),
      newUnique: 0,
      sliceArmStats: emptySliceArmStats(),
      sliceArmCalls,
      ...(truncatedByQuota ? { truncatedByQuota: true } : {}),
      // 헤세 결정(2026-09-27): 이 0건은 검색이 정말 돌았는데 못 찾은 게 아니라 애초에 search.list 를
      // 안 불렀다는 뜻이다 — 호출부가 이 값을 캐시하거나 원장에 "실검색 0건"으로 반영하면 안 된다.
      ...(ytdlpPrimaryLaneApproved ? { primaryLaneSkipped: true as const } : {}),
    };
  }

  const channelItems: Record<string, unknown>[] = [];
  // ── W115 A1·A2: 관측 → hydration 사이의 **예산 절단과 기지 채널 프리필터** ──────────────────
  //   A2 [근인]: 이메일 없음(emailStatus:"none")으로 판정된 채널도 candidate_pool 에 영속되는데,
  //     다음 런에서 그 사실을 **조회 전에** 보는 코드가 없었다. 그래서 같은 채널을 계속 다시 사서
  //     hydration 슬롯을 먹고, 정작 처음 보는 채널이 상한에 밀려 나갔다.
  //     이제 channels.list 를 부르기 **전에** doc-id 배치 읽기로 걸러낸다 — 절약된 슬롯은
  //     아래 인터리브가 그대로 신규 채널로 채운다(목록이 짧아질 뿐 규칙은 같다).
  //   A1: 남은 대상을 유닛 예산으로 한 번 더 조인다. 하드캡(YOUTUBE_CHANNEL_LOOKUP_LIMIT)은
  //     아래 세 절단 갈래와 fail-closed 불변식이 계속 강제한다 — 설정은 그 **아래로만** 조인다.
  const hydrationBudget = resolveHydrationBudget(config);
  const [knownChannelLookup, segmentEmailRates] = await Promise.all([
    observedChannels
      // 승격 경로(W75)는 관측 자체가 이미 dedup 을 거쳤고, 프리필터를 또 걸면 같은 판정을 두 번 한다.
      ? Promise.resolve({ known: new Map<string, KnownChannelRecord | null>(), status: "skipped_promotion" as HydrationPrefilterStatus })
      : readKnownChannelRecords(channelIds),
    // A4: 랭킹 표 1건. 프리필터 읽기와 **같은 왕복**에 태워 hydration 앞에 지연을 더하지 않는다.
    readSegmentEmailRateTable(),
  ]);
  const prefilterStatus = knownChannelLookup.status;
  const hydrationPrefilter = partitionHydrationTargets(
    channelIds,
    knownChannelLookup.known,
    Date.now(),
    KNOWN_CHANNEL_EMAIL_NONE_REVISIT_MS,
  );
  // ⚠️ 여기서 예산으로 자르지 않는다. 관측 순서대로 앞에서 1,000개를 떼면 **암 인터리브 이전에**
  //   뒤쪽 암(그리고 검색 뒤에 붙는 보조 레인 산출물)이 통째로 잘려 나간다 — W9-1 공정성 계약과
  //   W9-4 "보조 산출물이 검색 ID 에 밀리지 않는다"가 동시에 깨진다(실측으로 확인: topic 0,
  //   차트 시드 소실). 예산 절단은 인터리브 **뒤**에 건다 — 라운드로빈 결과의 접두는 여전히 공평하다.
  const hydratableChannelIds = hydrationPrefilter.hydratable;
  // ── A4: 프리필터 **뒤**, 절단 **앞**의 세그먼트 사전 랭킹 ────────────────────────────────
  //   무엇을 바꾸는가: 각 그룹(암·보조 레인) **내부의 순서**만 바꾼다. 그룹 구성원도 그룹 크기도
  //   그대로이므로 아래 인터리브가 그룹에 배정하는 **위치 집합이 완전히 동일**하다 — 라운드로빈
  //   위치는 오직 그룹 크기로만 정해지기 때문이다. 그래서 어느 지점에서 잘라도 암별 슬롯 수가
  //   랭킹 전후 같다(W9-1 공정성 계약 무손상). 바뀌는 것은 "그 슬롯을 누가 차지하는가" 뿐이다.
  //
  //   왜 인터리브 **뒤**가 아니라 앞인가: 실효 절단은 예산이 아니라 인터리브 상한
  //   (YOUTUBE_CHANNEL_LOOKUP_LIMIT)이다 — 기본 설정에서 예산 상한과 하드캡이 같아 아래 예산
  //   절단은 무연산이다(A1 주석이 말하는 바로 그 성질). 인터리브 뒤에 세우면 A4 는 **이미 잘려
  //   나간 후보에 손이 닿지 않아** 기본 설정에서 구조적으로 무력해진다. 여기서 세우면 두 절단
  //   모두에 걸린다. ⚠️ 절단 자체는 여전히 인터리브 **뒤**다 — 그 계약은 손대지 않는다.
  const hydrationRanking = rankHydrationTargetsBySegment(
    hydratableChannelIds.map((channelId) => {
      const known = knownChannelLookup.known.get(channelId);
      return {
        channelId,
        // 인터리브가 쓰는 그룹 축과 **같은 식**이어야 위 위치 보존 논증이 성립한다.
        group: graphNeighborIds.has(channelId) ? CHANNEL_GRAPH_SOURCE
          : popularSeedIds.has(channelId) ? POPULAR_SEED_SOURCE
            : channelSliceType.get(channelId) ?? "keyword",
        // 서술자는 **추가 읽기 0** 이다: 재관측 채널은 프리필터가 이미 읽은 문서에서(국가·밴드까지),
        // 신규 채널은 매칭 검색어에서 카테고리만 온다(국가·구독자는 channels.list 가 파는 값이다).
        // 매퍼의 category 유도 규칙과 **같은 식**을 쓴다 — 다르면 집계 축과 조회 축이 갈라진다.
        segment: {
          country: asString(known?.creatorCountry) ?? asString(known?.region),
          category: asString(known?.category)
            ?? [...(channelMatchedSearchTerms.get(channelId) ?? [])][0]
            ?? data.filters.categories[0]
            // 매퍼(:3104)와 같은 종단 폴백 — 한 항이라도 다르면 집계는 g=gaming, 조회는 [] 로 갈라진다(A4-R1).
            ?? "Gaming",
          followers: known?.followers,
        },
      };
    }),
    segmentEmailRates,
  );
  const rankedHydratableIds = hydrationRanking.channelIds;
  // W9-3·W9-4 산출물은 검색 암이 아니다 — 별도 그룹으로 같은 라운드에 섞어 hydration cap 을 공평히
  // 나눈다. 밴딧 슬롯이 없는 호출부(직접/레거시)도 마찬가지다: 검색 ID 가 먼저 100칸을 채우면 이미
  // 유닛을 쓴 보조 레인 산출물이 통째로 잘려 나가므로, 보조 산출물이 있으면 검색 묶음과 인터리브한다.
  // 보조 산출물이 없으면(양쪽 flag off 포함) 종전 표현식과 완전히 같다.
  const auxiliaryLookupGroups = [
    ...(graphNeighborIds.size > 0 ? [rankedHydratableIds.filter((channelId) => graphNeighborIds.has(channelId))] : []),
    ...(popularSeedIds.size > 0 ? [rankedHydratableIds.filter((channelId) => popularSeedIds.has(channelId))] : []),
  ];
  const channelLookupIds = data.sliceArmSlots
    ? interleaveByRound(
        [
          ...DISCOVERY_SLICE_TYPES.map((arm) => rankedHydratableIds.filter((channelId) => channelSliceType.get(channelId) === arm)),
          ...auxiliaryLookupGroups,
        ],
        YOUTUBE_CHANNEL_LOOKUP_LIMIT,
      )
    : auxiliaryLookupGroups.length > 0
      ? interleaveByRound(
          [
            rankedHydratableIds.filter((channelId) => !graphNeighborIds.has(channelId) && !popularSeedIds.has(channelId)),
            ...auxiliaryLookupGroups,
          ],
          YOUTUBE_CHANNEL_LOOKUP_LIMIT,
        )
      : rankedHydratableIds.slice(0, YOUTUBE_CHANNEL_LOOKUP_LIMIT);
  // A1: 설정/유닛 예산은 하드캡 **아래로만** 조인다. 기본값에서는 두 값이 같아 이 절단이 무연산이고
  //   (동작 무변경), 운영자가 예산을 낮췄을 때만 이미 공평하게 섞인 목록의 꼬리를 자른다.
  const budgetedLookupIds = channelLookupIds.slice(0, hydrationBudget.channelLimit);
  // W63 델타 M1 [라이브 레인 무변경 게이트가 주 경로를 못 덮었다]
  //   절단은 세 갈래(밴딧 인터리브 · 보조 인터리브 · 폴백 slice)인데 테스트가 **폴백 하나만** 고정해
  //   주 경로 상한을 100→1000 으로 올리는 뮤테이션이 GREEN 이었다. 텍스트로 세 곳을 고정하는 대신
  //   **런타임 불변식**을 건다 — 어느 갈래로 오든 상한을 넘으면 여기서 죽는다.
  //   상한 초과는 조용한 초과 지출이라 fail-open 이 아니라 fail-closed 가 맞다.
  if (channelLookupIds.length > YOUTUBE_CHANNEL_LOOKUP_LIMIT) {
    const error = new Error(
      `FLU_HYDRATION_CAP: channel lookup ${channelLookupIds.length} exceeds ${YOUTUBE_CHANNEL_LOOKUP_LIMIT}`,
    );
    Object.assign(error, { code: "failed-precondition", errorCode: "hydration_lookup_cap_exceeded" });
    throw error;
  }
  // COST-P0-006: **실제로 발사한** channels.list 콜 수. 계획(channelLookupIds/50)이 아니다 —
  //   쿼터 절단·에러로 루프가 중간에 끊기면 두 값이 갈린다.
  let channelLookupCalls = 0;
  for (let index = 0; index < budgetedLookupIds.length; index += 50) {
    assertDiscoveryDeadline(deadlineMs, "youtube channel lookup", YOUTUBE_API_FETCH_TIMEOUT_MS + 2_000);
    const channelUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
    channelUrl.searchParams.set("part", "snippet,statistics,brandingSettings,topicDetails");
    channelUrl.searchParams.set("id", budgetedLookupIds.slice(index, index + 50).join(","));
    let channelJson: Record<string, unknown>;
    try {
      channelJson = await fetchYouTubeRecord(channelUrl, "YouTube channel lookup failed", youtubeKeyState);
      // W115-R1 [HIGH 3]: **응답을 받은 뒤**에 계상한다. 종전에는 fetch 직전이라 403(쿼터 소진)·
      //   5xx 로 한 건도 못 받은 콜까지 유닛으로 청구됐다 — YouTube 는 실패한 요청에 유닛을 물리지
      //   않으므로 그 회계는 위로 틀리고, C1 의 유닛/이메일이 저비용 레인을 실제보다 나쁘게 만든다.
      channelLookupCalls += 1;
    } catch (error) {
      if ((error as { quotaLimited?: unknown } | null)?.quotaLimited !== true) {
        // W42 F-1: hydration 도 같은 계약 — 던지면 검색 쿼터로 얻은 채널과 앞선 배치의 메타데이터가 함께 날아간다.
        stopWithPreservedHarvest(error, "channel_lookup", channelItems.length, Math.floor(index / 50) + 1);
        break;
      }
      truncatedByQuota = true;
      break;
    }
    const items = Array.isArray(channelJson.items) ? channelJson.items.map(asRecord) : [];
    channelItems.push(...items);
  }

  // W63 델타 M3 [계측이 계획 vs 실제였다]: 종전에는 조회 루프 **앞**에서 계측해 "요청할 예정"을 셌다.
  //   쿼터 절단·에러로 루프가 중간에 끊긴 런에서는 실제 hydrate 된 채널이 훨씬 적은데도 손실이
  //   과소 보고됐다 — 기준선을 낮게 잡으면 yt-dlp 판단이 통째로 틀어진다.
  //   루프가 끝난 뒤 **실제 응답**으로 다시 센다.
  const hydrationOverflow = hydrationOverflowStat(
    channelIds,
    budgetedLookupIds,
    channelItems.map((item) => asString(item.id) ?? ""),
    hydratableChannelIds,
    // W115-R1 [LOW]: 이번 런에 **실제로 적용된** 상한으로 판정한다. 하드캡으로 고정하면 운영자가
    //   유닛 예산을 조인 런에서 "상한에 안 걸렸다"가 나온다(그 절단이 상한 절단인데).
    hydrationBudget.channelLimit,
  );
  // COST-P0-006: 이 런의 hydration 이 실제로 태운 유닛을 예산과 나란히 남긴다. 콜 수는 배치 크기로
  //   환산하지 않고 **실제 루프 회차**로 센다 — 쿼터 절단으로 중간에 끊긴 런에서 계획을 지출로
  //   보고하면 회계가 위로 틀린다(W63 델타 M3 가 채널 수에서 겪은 것과 같은 실수다).
  const hydrationUnits = channelLookupCalls * YOUTUBE_CHANNELS_UNITS_PER_CALL;

  const sourceFetchedAt = new Date().toISOString();
  const mapped = channelItems.map((item) => {
    const snippet = asRecord(item.snippet);
    const statistics = asRecord(item.statistics);
    const branding = asRecord(asRecord(item.brandingSettings).channel);
    const topicDetails = asRecord(item.topicDetails);
    const thumbnails = asRecord(snippet.thumbnails);
    const channelId = asString(item.id) ?? stableRef("channel", JSON.stringify(item));
    // W9-3·W9-4 산출물은 어떤 검색 암도 낳지 않았다 — 암 귀속을 비워 밴딧 보상이 위조되지 않게 하고,
    // 유입 라벨(head-biased 인기 차트 포함)을 그대로 보존한다.
    const nonArmSource = graphNeighborIds.has(channelId)
      ? CHANNEL_GRAPH_SOURCE
      : popularSeedIds.has(channelId) ? POPULAR_SEED_SOURCE : undefined;
    const discoveryArm = nonArmSource ? undefined : channelSliceType.get(channelId) ?? "keyword";
    const rawFollowers = Number(asString(statistics.subscriberCount, "0"));
    const followers = Number.isFinite(rawFollowers) ? rawFollowers : 0;
    const creatorCountry = normalizeYoutubeCreatorCountry(asString(snippet.country));
    const region = creatorCountry ?? "";
    const matchedSearchTerms = [...(channelMatchedSearchTerms.get(channelId) ?? [])];
    const category = matchedSearchTerms[0] ?? data.filters.categories[0] ?? "Gaming";
    const title = asString(snippet.title, "Unknown channel") ?? "Unknown channel";
    const description = [asString(snippet.description), asString(branding.description)].filter(Boolean).join("\n");
    const topicCategories = Array.isArray(topicDetails.topicCategories)
      ? topicDetails.topicCategories.filter((value): value is string => typeof value === "string")
      : [];
    const email = preferBusinessEmail(extractEmails(description));
    const emailStatus: EmailFinderStored["status"] = email ? (isBusinessEmail(email) ? "verified" : "guessed") : "none";
    // Avatar URL: high → medium → default. Avatar 컴포넌트가 http URL이면 이미지 렌더.
    const avatar = asString(asRecord(thumbnails.high).url)
      ?? asString(asRecord(thumbnails.medium).url)
      ?? asString(asRecord(thumbnails.default).url)
      ?? "🎬";

    const hasBusinessEmail = emailStatus === "verified";
    const { matchScore, categoryMatch, kwHits } = scoreCandidate(
      title,
      description,
      followers,
      hasBusinessEmail,
      targetKeywords,
      channelPublishedAtIso.get(channelId),
    );

    // 의미있는 신호 기록 (단순 라벨 나열이 아니라 실제 근거).
    const signals: string[] = ["youtube-live", "gamingVideoSearch"];
    if (categoryMatch >= 44) signals.push("category");
    if (topicCategories.length > 0) signals.push("topicCategories");
    signals.push(`tier:${followerTierLabel(followers)}`);
    if (kwHits > 0) signals.push(`kwHits:${kwHits}`);
    if (hasBusinessEmail) signals.push("businessEmail");

    return {
      candidateRef: `candidate_pool/${channelId}`,
      channelRef: `yt_channel_${channelId}`,
      name: title,
      handle: asString(snippet.customUrl, `@${channelId}`) ?? `@${channelId}`,
      avatar,
      platform: "YouTube" as const,
      followers,
      region,
      ...(creatorCountry ? { creatorCountry, countryFilterReason: "country_allowed" } : {}),
      category,
      matchScore,
      confidence: 88,
      signals,
      email,
      emailStatus,
      emailSource: email ? "About 페이지" : "none",
      emailSourceKind: (email ? "about" : "none") as EmailSourceKind,
      youtubeUrl: `https://www.youtube.com/channel/${channelId}`,
      sourcePlatform: "YouTube",
      sourceUrl: `https://www.youtube.com/channel/${channelId}`,
      discoverySource: observedChannels ? "ytdlp-promotion" : nonArmSource ?? discoveryArm ?? "keyword",
      ...(discoveryArm ? { discoveryArm } : {}),
      sourceFetchedAt,
      topicCategories,
      publicDescription: description.slice(0, 5_000),
      matchedSearchTerms,
      // Transient W9-1 reward attribution is stripped before storage; durable W9-5 provenance
      // remains in the four-field discovery edge. W9-3 이웃은 암이 없으므로 이 값도 싣지 않는다
      // (렉시콘 게이트는 keyword 예외가 아니라서 그대로 적용된다).
      ...(discoveryArm ? { __sliceType: discoveryArm } : {}),
    };
  });

  // ── W115 A3: **영상 설명란 이메일 추출의 일반 경로 승격** ────────────────────────────────
  //   종전(W77-②)에는 이 로직이 yt-dlp 승격 경로에만 있었다 — 검색으로 발굴한 채널은 About 하나만
  //   보고, 거기 없으면 그대로 emailStatus:"none" 이 됐다. 그런데 검색은 이미 100유닛을 내고
  //   videoId·설명란 스니펫을 받아 왔다. 그 응답을 안 쓰는 것은 이미 산 것을 버리는 것이다.
  //
  //   순서가 곧 비용이다:
  //     ① 검색 스니펫 설명란 — **추가 호출 0유닛**. 잘려 있어 수율은 낮지만 공짜다.
  //     ② 그래도 못 찾은 후보만 videos.list 백필 — 50영상/1유닛, 런당 예산 상한 안에서만.
  //   About 이 있으면 건드리지 않는다(기존 판정 불변). 승격 경로(observedChannels)는 자기 마이닝을
  //   이미 했으므로 여기서 또 하지 않는다.
  let videoDescriptionEmails = 0;
  let videoDescriptionUnits = 0;
  const emailsByLaneFromAbout = new Map<string, number>();
  const emailsByLaneFromDescription = new Map<string, number>();
  const laneOfCandidate = (candidate: { discoverySource?: string; discoveryArm?: DiscoverySliceType }): string =>
    candidate.discoverySource === CHANNEL_GRAPH_SOURCE ? CHANNEL_GRAPH_SOURCE
      : candidate.discoverySource === POPULAR_SEED_SOURCE ? POPULAR_SEED_SOURCE
        : candidate.discoveryArm ?? "keyword";
  for (const candidate of mapped) {
    if (asString(candidate.email)) {
      emailsByLaneFromAbout.set(laneOfCandidate(candidate), (emailsByLaneFromAbout.get(laneOfCandidate(candidate)) ?? 0) + 1);
    }
  }
  const enriched: typeof mapped = observedChannels ? mapped : await (async (): Promise<typeof mapped> => {
    const pending = mapped.filter((candidate) => !asString(candidate.email));
    if (pending.length === 0) return mapped;
    const targets = pending
      .map((candidate) => ({
        channelId: promotionChannelIdFromCandidate(candidate),
        videoIds: channelVideoIds.get(promotionChannelIdFromCandidate(candidate)) ?? [],
      }))
      .filter((target) => target.videoIds.length > 0);
    if (targets.length === 0) return mapped;

    // ① 공짜 소스부터. **절단본**이라는 사실을 값으로 들고 다닌다(W115-R1 CRITICAL) —
    //   이 집합에 남은 id 에서 나온 주소는 verified 로 승격되지 않는다.
    const descriptionByVideoId = new Map<string, string>(searchSnippetDescriptions);
    const truncatedVideoIds = new Set<string>(searchSnippetDescriptions.keys());
    let minedByChannelId = mineEmailsFromVideoDescriptions(targets, descriptionByVideoId, truncatedVideoIds);

    // ② 남은 후보만 예산 안에서 백필한다.
    //   W115-R1: 스니펫에서 **절단본 주소만** 나온 채널도 백필 대상이다 — 전문으로 확인해야
    //   그 주소가 verified 로 올라갈 수 있다(그러지 않으면 CRITICAL 이 만든 강등이 영구화된다).
    const unresolved = targets.filter((target) => minedByChannelId.get(target.channelId)?.truncatedSource !== false);
    if (unresolved.length > 0) {
      const plan = planVideoDescriptionBackfill(unresolved, {
        unitBudget: VIDEO_DESCRIPTION_BACKFILL_UNIT_BUDGET_PER_RUN,
        perChannelSample: VIDEO_DESCRIPTION_SAMPLE_PER_CHANNEL,
        batchSize: 50,
      });
      if (plan.videoIds.length > 0) {
        try {
          const backfill = await readVideoDescriptionsForBackfill(plan.videoIds, plan.plannedCalls, nonGrowthYoutubePoolId);
          videoDescriptionUnits = backfill.videoListCalls * YOUTUBE_VIDEOS_UNITS_PER_CALL;
          for (const [videoId, description] of backfill.descriptionByVideoId) {
            descriptionByVideoId.set(videoId, description);
            // 전문을 받았으므로 이 id 는 더 이상 절단본이 아니다 — 승격 경로가 여기서 열린다.
            truncatedVideoIds.delete(videoId);
          }
          minedByChannelId = mineEmailsFromVideoDescriptions(targets, descriptionByVideoId, truncatedVideoIds);
        } catch (error) {
          // 백필은 보충이다 — 실패해도 About 으로 얻은 이번 런의 수확을 버리지 않는다.
          console.warn("[discovery-email-mining] video description backfill failed", {
            plannedCalls: plan.plannedCalls,
            plannedUnits: plan.plannedUnits,
            errorCode: (error as { errorCode?: unknown; code?: unknown } | null)?.errorCode
              ?? (error as { code?: unknown } | null)?.code ?? "unknown",
          });
        }
      }
    }
    if (minedByChannelId.size === 0) return mapped;

    return mapped.map((candidate) => {
      if (asString(candidate.email)) return candidate;
      const mined = minedByChannelId.get(promotionChannelIdFromCandidate(candidate));
      if (!mined) return candidate;
      videoDescriptionEmails += 1;
      const lane = laneOfCandidate(candidate);
      emailsByLaneFromDescription.set(lane, (emailsByLaneFromDescription.get(lane) ?? 0) + 1);
      // W115-R1 [CRITICAL]: **절단본 유래는 verified 가 될 수 없다.** 도메인 꼬리가 잘려도 문법은
      //   멀쩡해 보이므로(`business@mystudio.co` ← `.com`) 아래 어떤 위생 게이트도 못 잡는다.
      //   `guessed` 로 내려 두면 발송 게이트가 별도 확인을 요구하고, 다음 런의 videos.list 전문이
      //   같은 주소를 확인해 주면 그때 승격된다(A2 90일 재방문 창이 그 경로를 열어 둔다).
      const verified = isBusinessEmail(mined.email) && !mined.truncatedSource;
      // 이메일 유무는 matchScore 의 contactFit 축(15%)이다 — 보충하고 점수를 그대로 두면 설명란
      //   후보만 구조적으로 낮게 랭크돼 아래 requestedLimit 절단에서 먼저 잘린다(같은 자격인데).
      const rescored = scoreCandidate(
        candidate.name,
        candidate.publicDescription ?? "",
        candidate.followers,
        verified,
        targetKeywords,
        channelPublishedAtIso.get(promotionChannelIdFromCandidate(candidate)),
      );
      return {
        ...candidate,
        email: mined.email,
        emailStatus: (verified ? "verified" : "guessed") as EmailFinderStored["status"],
        emailSource: "video_description",
        emailSourceKind: (mined.truncatedSource ? "search_snippet" : "video_description") as EmailSourceKind,
        matchScore: rescored.matchScore,
        signals: verified && !candidate.signals.includes("businessEmail")
          ? [...candidate.signals, "businessEmail"]
          : candidate.signals,
      };
    });
  })();

  // R27 수용기준②③: broad/topic 산출물만 캠페인 렉시콘 게이트를 통과해야 후보로 남는다.
  const lexicon = data.lexicon ?? [];
  // 리더 리크 조사(2026-09-27) [c]: non-game 버티컬은 렉시콘이 비어도 non-keyword 후보를 통과시키지
  // 않는다(fail-closed) — game(XP/Snake)은 인자를 안 넘겨 기존 동작 그대로다.
  // ⚠️ w115-discovery-supply.test.mjs 가 "gateDiscoveryCandidatesByLexicon(enriched" 리터럴 문자열을
  // 소스 슬라이스 경계로 쓴다 — 이 호출을 여러 줄로 쪼개거나 인자 순서를 바꾸지 마라.
  const gateResult = gateDiscoveryCandidatesByLexicon(enriched, lexicon, dependencies.classifyLexiconMatch, discoveryVertical !== "game");
  const gated = gateResult.gated;
  const { classifiedIn, classifiedOut, classificationExceptions } = gateResult;
  let videoQualificationUnits = 0;
  let videoQualificationRejected = 0;
  let videoQualificationTopChannelsSampled = 0;
  const videoQualified = discoveryVertical === "ai_drama"
    ? await qualifyCandidatesByObservedVideoViews(gated, channelVideoIds, {
        minVideoViews: data.minVideoViews || AI_DRAMA_MIN_QUALIFYING_VIDEO_VIEWS,
        minVideoCount: data.minVideoCount || AI_DRAMA_MIN_QUALIFYING_VIDEO_COUNT,
        keyState: youtubeKeyState,
        deadlineMs,
      })
    : null;
  const qualificationGated = videoQualified?.candidates ?? gated;
  if (videoQualified) {
    videoQualificationUnits = videoQualified.evidence.units;
    videoQualificationRejected = Math.max(0, gated.length - videoQualified.candidates.length);
    videoQualificationTopChannelsSampled = videoQualified.evidence.topVideoChannelsSampled;
    if (videoQualificationRejected > 0) {
      console.info("[discovery-video-qualification] rejected candidates without observed qualifying video", {
        queryRef: data.queryRef,
        threshold: data.minVideoViews || AI_DRAMA_MIN_QUALIFYING_VIDEO_VIEWS,
        requiredCount: data.minVideoCount || AI_DRAMA_MIN_QUALIFYING_VIDEO_COUNT,
        rejected: videoQualificationRejected,
        unknownDisposition: "reject",
      });
    }
  }

  // channelId 중복 제거, matchScore 내림차순 정렬.
  // W21 F-3: 이 한 상수가 "정크 방어(팔로워 10k 미만 컷)"와 "캠페인 하한"을 겸직해, 캠페인이 명시한
  // minFollowers=100(프로드 cp-bd7d1ea7aq4k 실측)을 10,000 으로 100배 덮어썼다. 명시값은 그대로
  // 존중하고, 정크 방어는 **미명시(0)** 분기 전용 기본값으로 분리한다.
  const minFollowers = data.filters.minFollowers > 0 ? data.filters.minFollowers : 10_000;
  const countryDecisions = qualificationGated.map((candidate) => ({
    candidate,
    decision: youtubeCreatorCountryPolicyDecision(candidate.creatorCountry, effectiveCountryTargeting),
  }));
  const countryFiltered = countryDecisions
    .filter((entry) => entry.decision.accepted)
    .map((entry) => ({
      ...entry.candidate,
      creatorCountry: entry.decision.country ?? entry.candidate.creatorCountry,
      region: entry.decision.country ?? entry.candidate.region,
      countryFilterReason: "country_allowed",
    }));
  const excludedCountryDecisions = countryDecisions.filter((entry) => !entry.decision.accepted);
  if (excludedCountryDecisions.length > 0) {
    const excluded = excludedCountryDecisions.reduce<Record<string, number>>((counts, entry) => {
      counts[entry.decision.decision] = (counts[entry.decision.decision] ?? 0) + 1;
      return counts;
    }, {});
    console.info("youtube creator country filter excluded channels", {
      countryTargeting: effectiveCountryTargeting,
      excluded,
    });
  }
  const seenChannels = new Set<string>();
  const resultsWithSliceType = filterCandidateMetrics(countryFiltered, { ...data.filters, minFollowers })
    .filter((candidate) => {
      if (seenChannels.has(candidate.channelRef)) return false;
      seenChannels.add(candidate.channelRef);
      return true;
    })
    .sort((left, right) => right.matchScore - left.matchScore)
    .slice(0, requestedLimit);

  // JEV ai_drama relevance gate (functions/aiDramaRelevance.ts). Independent, semantic second line of
  // defense on top of PR #203's structural fix (channel_graph/most_popular fully disabled for
  // discoveryVertical === "ai_drama", fail-closed lexicon gate above): that fix stops the *fallback
  // lanes* from seeding irrelevant channels, but it does not — and this does — (a) judge the keyword
  // lane's own results (YouTube's search API can itself return loosely-related channels for a query),
  // (b) produce a score/reason for the admin "관련도" badge and audit panel, or (c) let an operator
  // re-judge candidates that were already materialized before either fix existed. Every lane converges
  // into resultsWithSliceType by this point, so gating here covers whatever lane(s) are still active
  // with no lane-specific wiring. Only ai_drama runs pay this cost; game-vertical discovery is
  // byte-for-byte unchanged.
  let relevanceGatedResults: CandidateResult[] = resultsWithSliceType;
  if (discoveryVertical === "ai_drama") {
    const campaignIdForGate = (persistence.mode === "global_candidate_pool" ? persistence.provenance?.campaignId : persistence.context.campaignId)
      ?? data.campaignRef;
    // Adversarial review (2026-09-27): thread the search's own remaining-time budget through so an
    // unbounded sequential JEV-call loop (one call per surviving candidate) can never itself blow the
    // worker's overall deadline — a 5s safety margin leaves room to finish persisting whatever was
    // already judged. gateAiDramaCandidatesByRelevance also caps the absolute call count per pass
    // independently of this deadline.
    const gateResult = await gateAiDramaCandidatesByRelevance(resultsWithSliceType, {
      campaignId: campaignIdForGate,
      ownerOrgId: data.ownerOrgId ?? null,
      deadlineMs: deadlineMs - 5_000,
    });
    if (gateResult.rejected > 0 || gateResult.held > 0) {
      console.info("[ai-drama-relevance] gated non-AI-drama/unjudged candidates before persistence", {
        queryRef: data.queryRef,
        judged: gateResult.judged,
        accepted: gateResult.accepted,
        rejected: gateResult.rejected,
        held: gateResult.held,
      });
    }
    relevanceGatedResults = gateResult.gated;
  }

  let persistedCounts: CandidatePersistCounts = { created: 0, merged: 0, outcomes: [] };
  const finalizedResults = await finalizeYoutubeDiscoveryResults(
    relevanceGatedResults,
    persistence,
    persistCandidates,
    (counts) => { persistedCounts = counts; },
  );
  const sliceArmStats = sliceArmStatsFromPersistOutcomes(persistedCounts.outcomes);

  // ── C1: 레인별 비용·수율 귀속 ──────────────────────────────────────────────────────────────
  //   search 3암(100유닛/콜)과 저비용 보조 2레인(1유닛/콜)을 **같은 척도**(1,000유닛당 이메일)에
  //   올린다. 공유 비용(hydration channels.list + 설명란 videos.list)은 hydrate 한 채널 수에
  //   비례 배분한다 — 균등 배분은 저비용 레인을 실제보다 나쁘게 보이게 해 C2 의 판단을 뒤집는다.
  const hydratedByLane = new Map<string, number>();
  for (const item of channelItems) {
    const hydratedId = asString(item.id) ?? "";
    if (!hydratedId) continue;
    const lane = graphNeighborIds.has(hydratedId) ? CHANNEL_GRAPH_SOURCE
      : popularSeedIds.has(hydratedId) ? POPULAR_SEED_SOURCE
        : channelSliceType.get(hydratedId) ?? "keyword";
    hydratedByLane.set(lane, (hydratedByLane.get(lane) ?? 0) + 1);
  }
  const observedByLane = new Map<string, number>();
  for (const channelId of channelIds) {
    const lane = graphNeighborIds.has(channelId) ? CHANNEL_GRAPH_SOURCE
      : popularSeedIds.has(channelId) ? POPULAR_SEED_SOURCE
        : channelSliceType.get(channelId) ?? "keyword";
    observedByLane.set(lane, (observedByLane.get(lane) ?? 0) + 1);
  }
  const laneObservations: LaneObservation[] = [
    // W115-R1 [HIGH 3]: 비용 귀속의 분자는 **응답을 받은 콜**이다. 403 으로 죽은 시도는 YouTube 가
    //   유닛을 물리지 않는데 종전에는 attemptedSearchCalls 로 100유닛씩 청구했다 — 쿼터 소진일에
    //   유닛/이메일이 통째로 왜곡되고 그 왜곡이 C2 배분으로 그대로 넘어간다.
    //   (암 공정성 축인 EWMA 분모는 R28-1 대로 계속 attempted 를 쓴다 — 다른 질문이다.)
    ...DISCOVERY_SLICE_TYPES.map((arm) => ({
      lane: arm,
      calls: sliceArmCalls[arm].successfulSearchCalls,
      unitsPerCall: YOUTUBE_SEARCH_UNITS_PER_CALL,
      channelsObserved: observedByLane.get(arm) ?? 0,
      channelsHydrated: hydratedByLane.get(arm) ?? 0,
      emails: (emailsByLaneFromAbout.get(arm) ?? 0) + (emailsByLaneFromDescription.get(arm) ?? 0),
    })),
    {
      lane: CHANNEL_GRAPH_SOURCE,
      calls: graphSeedCalls,
      unitsPerCall: YOUTUBE_CHANNELS_UNITS_PER_CALL,
      channelsObserved: observedByLane.get(CHANNEL_GRAPH_SOURCE) ?? 0,
      channelsHydrated: hydratedByLane.get(CHANNEL_GRAPH_SOURCE) ?? 0,
      emails: (emailsByLaneFromAbout.get(CHANNEL_GRAPH_SOURCE) ?? 0) + (emailsByLaneFromDescription.get(CHANNEL_GRAPH_SOURCE) ?? 0),
    },
    {
      lane: POPULAR_SEED_SOURCE,
      calls: popularRegionCalls,
      unitsPerCall: YOUTUBE_VIDEOS_UNITS_PER_CALL,
      channelsObserved: observedByLane.get(POPULAR_SEED_SOURCE) ?? 0,
      channelsHydrated: hydratedByLane.get(POPULAR_SEED_SOURCE) ?? 0,
      emails: (emailsByLaneFromAbout.get(POPULAR_SEED_SOURCE) ?? 0) + (emailsByLaneFromDescription.get(POPULAR_SEED_SOURCE) ?? 0),
    },
  ] as LaneObservation[];
  const laneCostYield = attributeLaneCostYield(laneObservations, hydrationUnits + videoDescriptionUnits);
  const searchUnits = laneObservations
    .filter((item) => item.unitsPerCall === YOUTUBE_SEARCH_UNITS_PER_CALL)
    .reduce((sum, item) => sum + item.calls * item.unitsPerCall, 0);
  const unitsSpent = searchUnits + hydrationUnits + videoDescriptionUnits + videoQualificationUnits
    + (graphSeedCalls * YOUTUBE_CHANNELS_UNITS_PER_CALL) + (popularRegionCalls * YOUTUBE_VIDEOS_UNITS_PER_CALL);
  // COST-P0-006: 이 런이 태운 유닛과 그 대가(신규 채널·이메일)를 한 줄로 남긴다. 슬롯 인덱스도
  //   키 자체도 싣지 않는다(SEC-P0-009) — 회계에 필요한 것은 유닛과 수율뿐이다.
  console.info(JSON.stringify({
    event: "discovery.run_cost_yield",
    queryRef: data.queryRef,
    unitsSpent,
    searchUnits,
    hydrationUnits,
    hydrationUnitBudget: hydrationBudget.unitBudget,
    hydrationChannelLimit: hydrationBudget.channelLimit,
    videoDescriptionUnits,
    videoQualificationUnits,
    videoQualificationRejected,
    videoQualificationTopChannelsSampled,
    hydrationSeen: hydrationOverflow.seen,
    hydrationKnownSkipped: hydrationOverflow.knownSkipped,
    hydrationAttempted: hydrationOverflow.attempted,
    hydrationDropped: hydrationOverflow.dropped,
    // W115-R1 [MEDIUM]: knownSkipped:0 이 "신규뿐"인지 "프리필터가 죽었다"인지 로그만으로 갈린다.
    prefilterStatus,
    // A4: 랭킹이 이 런에 **실제로 걸렸는지**의 축. 효과 실측은 이 축이 켜진 런과 꺼진 런의
    //   `newUnique 대비 이메일` 비교로 한다 — 축이 없으면 A4 는 영원히 "적용했다"까지만 말할 수 있다.
    //   applied:true + fallbackShare≈1 은 "표는 있는데 이 런의 후보와 안 만났다"는 별개 신호다.
    //   applied:true + reorderedShare 0 은 제3의 무연산(전원 동률로 순서 무변)이다 — A4-R1 리뷰.
    rankedHydration: {
      applied: hydrationRanking.applied,
      segmentsKnown: hydrationRanking.segmentsKnown,
      fallbackShare: hydrationRanking.fallbackShare,
      reorderedShare: hydrationRanking.reorderedShare,
    },
    newUnique: persistedCounts.created,
    videoDescriptionEmails,
    laneCostYield,
  }));

  return {
    results: stampPersistOutcomes(finalizedResults, persistedCounts.outcomes),
    cost: costLog("youtube-data-api-v3", "youtube-data-api", 0),
    // R23-2b: scoped_snapshot 모드는 onPersisted 가 호출되지 않으므로(persist 자체를 안 함) 0 이
    // 그대로 맞다 — 프리뷰는 신규 발굴 신호가 아니다.
    newUnique: persistedCounts.created,
    sliceArmStats,
    sliceArmCalls,
    ...(truncatedByQuota ? { truncatedByQuota: true } : {}),
    ...(harvestPartial ? { harvestPartial } : {}),
    classifiedIn,
    classifiedOut,
    classificationExceptions,
    hydrationOverflow,
    laneCostYield,
    unitsSpent,
    videoDescriptionEmails,
  };
}

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
const OBFUSC_FULL_PATTERN = /([a-zA-Z0-9._%+-]+)\s*[\[\(\{<]\s*(?:at|@)\s*[\]\)\}>]\s*([a-zA-Z0-9-]+(?:\s*[\[\(\{<]\s*(?:dot|\.)\s*[\]\)\}>]\s*[a-zA-Z0-9-]+)+)/gi;
const OBFUSC_AT_ONLY_PATTERN = /([a-zA-Z0-9._%+-]+)\s*[\[\(\{<]\s*(?:at|@)\s*[\]\)\}>]\s*([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,})/gi;
const OBFUSC_SPACED_PATTERN = /\b([a-zA-Z0-9._%+-]{3,})\s+at\s+([a-zA-Z0-9-]{3,})\s+dot\s+([a-zA-Z]{2,}(?:\s+dot\s+[a-zA-Z]{2,})?)\b/gi;
const DOT_OBFUSC_PATTERN = /\s*[\[\(\{<]\s*(?:dot|\.)\s*[\]\)\}>]\s*/gi;
const PLACEHOLDER_EMAILS = new Set([
  "example@example.com", "test@test.com", "name@email.com", "your@email.com",
  "someone@example.com", "user@domain.com", "email@example.com", "info@yourdomain.com",
  "me@me.com", "admin@admin.com", "yt-support-solutions-kr@google.com",
]);
const PLACEHOLDER_DOMAINS = new Set(["example.com", "test.com", "domain.com", "email.com", "yourdomain.com", "mail.com.com"]);
const PLATFORM_DOMAINS = new Set(["google.com", "youtube.com", "googlemail.com"]);
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp"];
const TRAILING_WORDS_AFTER_TLD = ["hi", "hello", "hey", "thanks", "thank", "thankyou", "business", "contact", "for", "please"];
// W19 ① [프로드 실측 2026-08-04]: 위 화이트리스트는 **관측된 단어만** 잡는다. 실제 재고 감사에서
// 새 뒤단어가 계속 나왔다: gmail.comtwitter(6) · gmail.comi(5) · gmail.cominstagram(2) ·
// gmail.comfollow(2) · gmail.comwelcome(2) · gmail.comif(2) · gmail.combu(1) · gmail.comspeedrunning(1).
// 채널 설명의 "x@gmail.com twitter: @yy" 같은 문장에서 공백이 없거나 지워지며 TLD 뒤에 단어가 붙는다.
// 화이트리스트를 늘리는 것은 끝이 없으므로 **유효 TLD 집합**으로 바꾼다: tld 가 유효 목록에 없고
// 유효 TLD 로 시작하면 그 지점에서 절단한다(company/community 같은 실존 TLD 는 목록에 있어 보존된다).
export const VALID_TLDS = new Set([
  "com", "net", "org", "edu", "gov", "mil", "int", "io", "co", "ai", "app", "dev", "me", "tv",
  "biz", "info", "pro", "xyz", "site", "online", "store", "shop", "email", "live", "link", "click",
  "cc", "gg", "to", "ly", "sh", "fm", "am", "im", "is", "it", "in", "id", "ru", "ua", "pl", "cz",
  "kr", "jp", "cn", "tw", "hk", "sg", "my", "th", "vn", "ph", "au", "nz", "uk", "ie", "de", "fr",
  "es", "pt", "nl", "be", "ch", "at", "se", "no", "dk", "fi", "gr", "tr", "il", "ae", "sa", "eg",
  "za", "ng", "ke", "ma", "br", "ar", "cl", "mx", "pe", "ca", "us", "eu", "asia", "agency",
  "company", "community", "media", "studio", "team", "world", "life", "today", "digital", "network",
  "solutions", "services", "group", "games", "video", "art", "design", "one", "space", "tech", "mc",
]);
// 유효 TLD 접두 후보를 긴 것부터 검사한다("community" 를 "com" 으로 잘못 자르지 않도록).
const VALID_TLDS_BY_LENGTH_DESC = [...VALID_TLDS].sort((a, b) => b.length - a.length);
// Local-part markers for business / outreach inboxes (subset of Infly BUSINESS_KEYWORDS).
const BUSINESS_KEYWORDS = [
  "business", "biz", "contact", "pr", "inquiries", "inquiry", "partnership",
  "partnerships", "collab", "collaboration", "sponsor", "sponsorship",
  "marketing", "media", "press", "booking", "manager", "agency", "official",
  "hello", "team", "ads", "advertise", "advertising", "문의", "비즈니스", "광고",
  "제휴", "협찬", "협업", "연락",
];

export function cleanEmailCandidate(value: string): string {
  // P0-3 (prod 0.6.82 실측): 불릿 리스트 잔재 `-` 가 선행 strip 을 통과해 `-radha@...`·`--anshslice@...`
  // 같은 오형 주소가 저장됐다 — 도달성 판정은 오형 해시 키로 쌓여 정본 재추출과 캐시가 안 맞았다.
  // `-` 를 선행 문자 클래스 끝에 추가한다(클래스 끝의 `-` 는 리터럴). 정본 이메일은 절대 `-` 로
  // 시작하지 않고, local-part 하이픈(a-b@...)은 문자열 중간이라 영향이 없다.
  const email = value.trim().trim().replace(/^[<("'\[-]+/, "").replace(/[.,;:)\]}>\"']+$/, "").toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 0) return email;
  const local = email.slice(0, at);
  let domain = email.slice(at + 1);
  // W19 ①-a: 연속 점 이후는 문장 잔재다 — "x@gmail.com...tap here" 가 도메인 gmail.com...tap 으로
  // 들어왔다(실측 16건, 재고 최다 오염). 첫 연속 점에서 절단한다.
  const doubleDot = domain.indexOf("..");
  if (doubleDot > 0) domain = domain.slice(0, doubleDot);
  const dot = domain.lastIndexOf(".");
  if (!local || dot < 0) return `${local}@${domain}`;
  const head = domain.slice(0, dot);
  const tld = domain.slice(dot + 1);
  for (const word of TRAILING_WORDS_AFTER_TLD) {
    if (tld === `com${word}`) return `${local}@${head}.com`;
    if (tld === `net${word}`) return `${local}@${head}.net`;
    if (tld === `org${word}`) return `${local}@${head}.org`;
  }
  // W19 ①-b: 화이트리스트에 없는 뒤단어를 유효 TLD 접두로 절단한다. tld 가 이미 유효하면 손대지 않는다.
  if (!VALID_TLDS.has(tld)) {
    for (const candidate of VALID_TLDS_BY_LENGTH_DESC) {
      if (tld.length > candidate.length && tld.startsWith(candidate)) {
        return `${local}@${head}.${candidate}`;
      }
    }
  }
  return `${local}@${domain}`;
}

function plausibleEmail(email: string): boolean {
  if (!email || PLACEHOLDER_EMAILS.has(email)) return false;
  const parts = email.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || !domain || !domain.includes(".")) return false;
  if (PLACEHOLDER_DOMAINS.has(domain)) return false;
  if (FREE_MAIL_DOMAINS.has(domain) && FREE_MAIL_PLACEHOLDER_LOCALS.has(local)) return false;
  // 답장이 불가능한 주소는 후보 이메일이 될 수 없다(발송 단계 역할계정 차단과 별개의 추출 단계 위생).
  if (/^(?:no[._-]?reply|do[._-]?not[._-]?reply|mailer-daemon|postmaster|bounces?)(?:[._+-]|$)/i.test(local)) return false;
  if (PLATFORM_DOMAINS.has(domain) && (local.startsWith("yt-") || local.startsWith("youtube") || local.startsWith("support"))) return false;
  if (IMAGE_EXTENSIONS.some((extension) => domain.endsWith(extension))) return false;
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (!/^[a-z]+$/i.test(tld) || tld.length < 2 || tld.length > 24) return false;
  // W19 ①-c: 절단(cleanEmailCandidate)을 거쳐도 남는 미지 TLD 는 발송 대상에서 뺀다 — 오늘 실측
  // 배달실패 16%(하드반송 11.4% + no-mx 4.5%)의 사전 차단선이다. 도메인 실존 여부는 여기서 알 수
  // 없으므로(MX 조회는 발송 경로 밖) 최소한 **TLD 가 실재하는지**로 1차 방어한다.
  // 주의: 이 게이트는 추출 단계이므로 통과가 곧 배달 보장은 아니다.
  return VALID_TLDS.has(tld);
}

function addEmailCandidate(raw: string, seen: Set<string>, ordered: string[], unfiltered = false) {
  const email = cleanEmailCandidate(raw);
  // unfiltered: 심층 추출의 조각 판정용 — 위생 게이트(자리표시자·no-reply·TLD)로 거부될 토큰도 "그 자리에 주소가 있었다"는
  // 증거이므로 모은다. 라이브 경로는 항상 false 다.
  if ((!unfiltered && !plausibleEmail(email)) || !email.includes("@") || seen.has(email)) return;
  seen.add(email);
  ordered.push(email);
}

/**
 * W115-R1 [CRITICAL · 적대 리뷰] — **절단 경계에 걸린 매치를 버릴 여유폭.**
 *
 * search.list `snippet.description` 은 ≈160자에서 잘린다. 잘린 자리에 이메일이 걸리면 도메인의
 * 꼬리가 사라지는데, `cleanEmailCandidate` 는 그 잔재를 **유효한 값으로 다듬어 버린다**:
 *   `"…business@mystudio.co..."` → `business@mystudio.co`
 * `co` 는 실존 TLD(콜롬비아)라 `plausibleEmail` 을 통과하고, local-part 에 `business` 가 있어
 * `isBusinessEmail` → `verified` 까지 간다. 실주소는 `.com` 이었다. 같은 함정이 `.media`/`.studio`/
 * `.team` 처럼 **일반 단어를 겸하는 TLD** 전부에 있다.
 *
 * 그래서 절단본에서는 "끝에 붙은 매치"를 신뢰하지 않는다. 3자인 이유: YouTube 가 붙이는 말줄임
 * (`...`)이 정확히 3자이고, 말줄임 없이 잘리는 경우(=매치가 텍스트 끝에 딱 붙음)도 함께 덮는다.
 */
export const TRUNCATED_TEXT_EMAIL_BOUNDARY_SLACK = 3;

// 이메일 난독화 정규화(email-digging a). NFKC 가 전각 `＠`·`（at）`·`．` 와 호환 문자를 정본으로 접고,
// 여기서는 NFKC 가 못 접는 것(HTML 엔티티, 제로폭 문자, 한자 마침표 `。`)만 보탠다.
const ZERO_WIDTH_PATTERN = /[\u200b-\u200d\u2060\ufeff\u00ad]/g;
const JP_AT_MARK_PATTERN = /([a-zA-Z0-9._%+-]+)\s*[\[\(\{<]?\s*(?:アットマーク|アット|あっとまーく)\s*[\]\)\}>]?\s*([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,})/gi;
// "name @ gmail.com" / "name at gmail.com" — 공백으로 떨어진 `@`/`at` 는 문장("find me @ youtube.com")과
// 구별이 안 되므로 **무료 메일 도메인에서만** 인정한다(오탐 방지 > 재현율).
const FREE_MAIL_DOMAIN_LIST = [
  "gmail.com", "googlemail.com", "hotmail.com", "outlook.com", "live.com", "yahoo.com", "yahoo.co.jp",
  "yahoo.co.kr", "yahoo.co.uk", "icloud.com", "me.com", "proton.me", "protonmail.com", "naver.com",
  "daum.net", "hanmail.net", "qq.com", "163.com", "126.com", "gmx.com", "gmx.de", "web.de", "mail.ru",
  "yandex.com", "yandex.ru", "ymail.com", "aol.com",
] as const;
const FREE_MAIL_DOMAINS = new Set<string>(FREE_MAIL_DOMAIN_LIST);
const FREE_MAIL_DOMAINS_FOR_SPACED_AT = FREE_MAIL_DOMAIN_LIST.map((domain) => domain.replace(/\./g, "\\.")).join("|");
// 무료 메일 도메인에 붙은 자리표시자 local-part("name@gmail.com" — 설명란 안내문 "my YouTube name at Gmail.com").
const FREE_MAIL_PLACEHOLDER_LOCALS = new Set([
  "name", "yourname", "your.name", "your_name", "username", "user", "email", "youremail", "your.email",
  "your_email", "yourmail", "mail", "myemail", "my.email", "example", "sample", "someone", "firstname.lastname",
  "firstnamelastname", "channelname", "yourchannel", "youtubename", "myname", "xxx", "xxxx", "abc", "abcd", "test",
]);
const SPACED_AT_FREE_MAIL_PATTERN = new RegExp(`(?<![a-zA-Z0-9._%+-])([a-zA-Z0-9][a-zA-Z0-9._%+-]{2,})\\s+(?:@|at)\\s+(${FREE_MAIL_DOMAINS_FOR_SPACED_AT})(?![a-zA-Z0-9-])(?!\\.[a-zA-Z0-9])`, "gi");
const SPACED_AT_LOCAL_STOPWORDS = new Set([
  "find", "follow", "me", "us", "you", "just", "email", "mail", "contact", "reach", "here", "now",
  "also", "and", "the", "for", "dm", "or", "is", "are", "was", "meet", "see", "visit", "watch",
]);

/**
 * **스타일/전각 표기 접기** — 심층 추출(`extractEmailsDeep`) 전용이다. 전각 ASCII(`＠`·`（at）`·`．`)와 수학
 * 영숫자 글꼴(`𝗴𝗮𝗺𝗲𝗿`)만 ASCII 로 접고, 제로폭 문자·HTML 엔티티·한자 마침표를 정리한다. NFKC **전체**는 쓰지 않는다 —
 * `①`→`1`, `…`→`...` 처럼 주소의 신원이나 주소 사이 구분자를 바꾸는 변환을 피하기 위해서다.
 */
export function foldStyledEmailText(text: string): string {
  let folded = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xff01 && cp <= 0xff5e) folded += String.fromCharCode(cp - 0xfee0);
    else if (cp === 0xfe6b) folded += "@";
    else if (cp >= 0x1d400 && cp <= 0x1d7ff) folded += ch.normalize("NFKC");
    else folded += ch;
  }
  return folded
    .replace(ZERO_WIDTH_PATTERN, "")
    .replace(/&commat;/gi, "@")
    .replace(/&period;/gi, ".")
    // 숫자 엔티티는 인쇄 가능한 ASCII(0x20–0x7e)만 푼다(`&#45;`→`-`, `&#64;`→`@`, `&#46;`→`.`).
    .replace(/&#0*(\d{2,3});/g, (whole, dec: string) => { const code = Number(dec); return code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : whole; })
    .replace(/&#x0*([0-9a-f]{2});/gi, (whole, hex: string) => { const code = parseInt(hex, 16); return code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : whole; })
    .replace(/(?<=[a-zA-Z0-9])[。｡](?=[a-zA-Z0-9])/g, ".");
}

/**
 * 텍스트에서 이메일을 뽑는다.
 *
 * `options.truncated` 는 "이 텍스트는 원문의 앞부분만이다"라는 **호출부의 사실 진술**이다
 * (검색 스니펫). 켜지면 끝 경계에 걸린 매치를 폐기한다 — 잘린 주소는 문법적으로 멀쩡해 보이므로
 * 아래 어떤 위생 게이트도 그것을 걸러내지 못한다.
 */
export function extractEmailsForDiscovery(
  text: string,
  options: { readonly truncated?: boolean } = {},
): string[] {
  return extractEmailCandidates(text, options, false);
}

function extractEmailCandidates(
  text: string,
  options: { readonly truncated?: boolean },
  unfiltered: boolean,
): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  const boundary = options.truncated === true
    ? text.length - TRUNCATED_TEXT_EMAIL_BOUNDARY_SLACK
    : Number.POSITIVE_INFINITY;
  const withinBoundary = (match: RegExpMatchArray): boolean =>
    (match.index ?? 0) + match[0].length < boundary;

  for (const match of text.matchAll(EMAIL_PATTERN)) {
    if (!withinBoundary(match)) continue;
    addEmailCandidate(match[0], seen, ordered, unfiltered);
  }
  for (const match of text.matchAll(OBFUSC_FULL_PATTERN)) {
    if (!withinBoundary(match)) continue;
    const local = match[1] ?? "";
    const domain = (match[2] ?? "").replace(DOT_OBFUSC_PATTERN, ".");
    addEmailCandidate(`${local}@${domain}`, seen, ordered, unfiltered);
  }
  for (const match of text.matchAll(OBFUSC_AT_ONLY_PATTERN)) {
    if (!withinBoundary(match)) continue;
    addEmailCandidate(`${match[1] ?? ""}@${match[2] ?? ""}`, seen, ordered, unfiltered);
  }
  for (const match of text.matchAll(OBFUSC_SPACED_PATTERN)) {
    if (!withinBoundary(match)) continue;
    const tld = (match[3] ?? "").replace(/\s+dot\s+/gi, ".");
    addEmailCandidate(`${match[1] ?? ""}@${match[2] ?? ""}.${tld}`, seen, ordered, unfiltered);
  }
  return ordered;
}


// 주소 끝에 도메인이 **이어지는** 표기가 남아 있으면(`gmail.com[dot]vn`, `gmail.com dot vn`, `gmail.com.vn`,
// `gmail.com .vn`, `gmail.com. vn`) 그 앞까지만 뽑은 주소(`x@gmail.com`)는 잘린 도메인이다 — 문법·MX 가 다 맞아서
// 검증으로는 못 잡는다. 공백 뒤 마침표는 문장 끝과 구별해야 하므로 **소문자 TLD 단어**일 때만 이어짐으로 본다.
const DOMAIN_CONTINUATION_PATTERN = /^(?:\s*[\[\(\{<]\s*(?:dot|\.)\s*[\]\)\}>]\s*[a-z0-9]|\s+dot\s+[a-z0-9]|\.[a-z0-9]|\s*[\uff0e\u3002\uff61]\s*[a-z0-9]|\s+\.\s*[a-z0-9]|&#?[a-z0-9]+;?|\s*\.\s+([a-z]{2,24})(?![a-z0-9]))/i;

function followedByDomainContinuation(tail: string): boolean {
  const match = DOMAIN_CONTINUATION_PATTERN.exec(tail);
  if (!match) return false;
  // `. vn` 형태(마지막 대안)는 단어가 실제 TLD 일 때만 이어짐이다 — 일반 소문자 단어로 시작하는 문장은 살린다.
  // 대소문자 무시 정규식이라 단어가 대문자로 시작하면(문장 시작) 여기서 걸러 살린다.
  return match[1] === undefined || (match[1] === match[1].toLowerCase() && VALID_TLDS.has(match[1]));
}

/**
 * 후보 **왼쪽** 이웃이 안전한가 — **허용 목록**: 처음/공백/명시한 구분자/이모지·그림 기호뿐이다. 그 밖의 문자(글자·숫자·표식,
 * 아포스트로피·`#`·`;`·`&`·`%` 같은 엔티티/토큰 잔재)가 붙어 있으면 앞의 일부가 잘린 조각일 수 있다.
 */
function leftBoundarySafe(source: string, start: number): boolean {
  if (start <= 0) return true;
  const previous = Array.from(source.slice(Math.max(0, start - 2), start)).pop() ?? "";
  if (/\s/.test(previous)) return true;
  if ("\"([{<|,:>)]}=→←•·–—「」『』（）［］【】、。：・“”…‥!?*~^/\\".includes(previous)) return true;
  return /\p{Extended_Pictographic}/u.test(previous);
}

/**
 * 모든 토크나이저의 후보 중 **조각일 가능성이 있는** 것(필터 전): 도메인이 이어지는데 거기서 끊겼거나, 왼쪽에 글자/엔티티
 * 잔재가 붙은 것. 심층 추출이 이 주소들을 버린다.
 */
function unsafeBoundaryCandidates(source: string): Set<string> {
  const unsafe = new Set<string>();
  const check = (candidate: string, match: RegExpMatchArray) => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (!leftBoundarySafe(source, start) || followedByDomainContinuation(source.slice(end, end + 400).replace(/\s{2,}/g, " ").slice(0, 28))) {
      unsafe.add(cleanEmailCandidate(candidate));
    }
  };
  for (const match of source.matchAll(EMAIL_PATTERN)) check(match[0], match);
  for (const match of source.matchAll(OBFUSC_FULL_PATTERN)) check(`${match[1] ?? ""}@${(match[2] ?? "").replace(DOT_OBFUSC_PATTERN, ".")}`, match);
  for (const match of source.matchAll(OBFUSC_AT_ONLY_PATTERN)) check(`${match[1] ?? ""}@${match[2] ?? ""}`, match);
  for (const match of source.matchAll(OBFUSC_SPACED_PATTERN)) {
    check(`${match[1] ?? ""}@${match[2] ?? ""}.${(match[3] ?? "").replace(/\s+dot\s+/gi, ".")}`, match);
  }
  for (const match of source.matchAll(JP_AT_MARK_PATTERN)) check(`${match[1] ?? ""}@${match[2] ?? ""}`, match);
  for (const match of source.matchAll(SPACED_AT_FREE_MAIL_PATTERN)) check(`${match[1] ?? ""}@${match[2] ?? ""}`, match);
  return unsafe;
}

/** `fragment` 가 `whole` 의 local-part 꼬리 또는 도메인 머리를 잘라 낸 조각인가(둘 다 잘렸어도 포함). */
function isEmailFragmentOf(fragment: string, whole: string): boolean {
  if (fragment === whole) return false;
  const [fragmentLocal = "", fragmentDomain = ""] = fragment.split("@");
  const [wholeLocal = "", wholeDomain = ""] = whole.split("@");
  const localCovers = wholeLocal === fragmentLocal || wholeLocal.endsWith(fragmentLocal);
  const domainCovers = wholeDomain === fragmentDomain || wholeDomain.startsWith(fragmentDomain);
  return localCovers && domainCovers;
}

/**
 * **심층 추출**(email-digging 백필 전용 — 라이브 발굴 경로는 `extractEmailsForDiscovery` 를 그대로 쓴다).
 * 원문 결과를 먼저 보존하고, 접힌 텍스트(전각·수학 글꼴·엔티티·제로폭·한자 마침표)와 추가 난독화
 * (일본어 アットマーク, 무료 메일 도메인의 공백 `@`/`at`)에서만 나오는 주소를 **덧붙인다**. 접힌 쪽이 같은 주소의
 * 완전한 형태를 낼 때 원문 패스가 뽑은 꼬리/머리 조각(`one@x.com` ← `gamerone@x.com`)은 버린다. 절단 스니펫
 * 입력은 지원하지 않는다(저장된 전문만 다룬다).
 */
export function extractEmailsDeep(text: string): string[] {
  if (!text) return [];
  const raw = extractEmailsForDiscovery(text);
  const folded = foldStyledEmailText(text);
  const seen = new Set<string>();
  const foldedAll: string[] = [];
  if (folded !== text) {
    for (const email of extractEmailsForDiscovery(folded)) {
      if (!seen.has(email)) { seen.add(email); foldedAll.push(email); }
    }
  }
  for (const match of folded.matchAll(JP_AT_MARK_PATTERN)) {
    addEmailCandidate(`${match[1] ?? ""}@${match[2] ?? ""}`, seen, foldedAll);
  }
  for (const match of folded.matchAll(SPACED_AT_FREE_MAIL_PATTERN)) {
    const local = match[1] ?? "";
    if (SPACED_AT_LOCAL_STOPWORDS.has(local.toLowerCase())) continue;
    addEmailCandidate(`${local}@${match[2] ?? ""}`, seen, foldedAll);
  }
  // 원문 패스가 변환된 주소의 조각(`mer@yahoo.com` ← `ga<ZWSP>mer@yahoo.com<ZWSP>.vn`, `reply@gmail.com` ← `no<ZWSP>reply@…`)을
  // 뽑았다면 버린다. 접힌 텍스트의 **필터 전** 토큰(placeholder/no-reply 로 거부된 것 포함)까지 비교 대상이다.
  const foldedTokens = folded === text ? [] : extractEmailCandidates(folded, {}, true);
  // 접힌 텍스트의 **모든** 난독화 토크나이저(JP·공백 @/at 포함)를 필터 없이 돈 결과도 비교 풀에 넣는다.
  const foldedExtraTokens: string[] = [];
  const unfilteredSeen = new Set<string>();
  for (const match of folded.matchAll(JP_AT_MARK_PATTERN)) {
    addEmailCandidate(`${match[1] ?? ""}@${match[2] ?? ""}`, unfilteredSeen, foldedExtraTokens, true);
  }
  for (const match of folded.matchAll(SPACED_AT_FREE_MAIL_PATTERN)) {
    addEmailCandidate(`${match[1] ?? ""}@${match[2] ?? ""}`, unfilteredSeen, foldedExtraTokens, true);
  }
  const foldedPool = [...foldedAll, ...foldedTokens, ...foldedExtraTokens];
  const rawKept = raw.filter((email) => foldedPool.includes(email) || !foldedPool.some((other) => isEmailFragmentOf(email, other)));
  const ordered = [...rawKept];
  for (const email of foldedAll) if (!ordered.includes(email)) ordered.push(email);
  // 도메인이 이어지는 표기에서 끊겼거나 왼쪽에 글자/엔티티 잔재가 붙은 주소(원문·접힌 텍스트 어느 쪽이든)는 버린다.
  const unsafe = new Set([...unsafeBoundaryCandidates(text), ...unsafeBoundaryCandidates(folded)]);
  return ordered.filter((email) => !unsafe.has(email));
}

/**
 * 출처 경계를 지키는 추출(**reject-only**): `extractEmailsForDiscovery` 결과에서 도메인이 이어지는 표기(`x@gmail.com[dot]vn`)에서
 * 끊겼거나 왼쪽에 글자/엔티티 잔재가 붙은 주소(= 조각일 수 있는 주소)만 버린다. 새 주소를 받아들이지 않는다.
 * 라이브 발굴 경로(`extractEmailsForDiscovery`)는 그대로다 — 이메일 백필 레인만 쓴다.
 */
export function extractEmailsBoundarySafe(text: string): string[] {
  const all = extractEmailsForDiscovery(text);
  if (all.length === 0) return all;
  // 원문과 **접은 텍스트**(제로폭 문자·전각 표기·엔티티 정리) 양쪽에서 경계를 본다 — `x@gmail.com\u200b.vn` 같은 꼬리가 숨지 못하게.
  const folded = foldStyledEmailText(text);
  const unsafe = new Set([...unsafeBoundaryCandidates(text), ...unsafeBoundaryCandidates(folded)]);
  // 접은 텍스트가 같은 주소의 **더 긴 형태**(`x@gmail.com\u200b.vn` → `x@gmail.com.vn`)를 내면 원문 패스의 조각은 버린다.
  // 필터 전 토큰을 쓴다(`museum` 처럼 유효 TLD 집합 밖이라 필터가 버린 긴 형태도 조각 판정 근거다).
  const foldedAll = folded === text ? [] : extractEmailCandidates(folded, {}, true);
  return all.filter((email) => !unsafe.has(email) && (foldedAll.includes(email) || !foldedAll.some((other) => isEmailFragmentOf(email, other))));
}

function extractEmails(text: string): string[] {
  return extractEmailsForDiscovery(text);
}

export function isBusinessEmail(email: string): boolean {
  const local = email.split("@", 1)[0]?.toLowerCase() ?? "";
  return BUSINESS_KEYWORDS.some((keyword) => local.includes(keyword));
}

// Prefer a business/contact inbox when multiple are present; otherwise first found.
/**
 * W84: 설명란 텍스트 → 이메일 1개(정본). 보충 레인이 규칙을 복제하지 않도록 여기서 연다 —
 *   복제하면 두 레인이 서로 다른 이메일을 고르고, 그 차이는 아무 데도 안 남는다.
 */
export function mineBusinessEmailFromText(text: string): string | null {
  return preferBusinessEmail(extractEmails(text));
}

function preferBusinessEmail(emails: string[]): string | null {
  if (emails.length === 0) return null;
  return emails.find(isBusinessEmail) ?? emails[0];
}

// Resolve the YouTube channels.list lookup param from a raw hint
// (channelId UC..., @handle, legacy username, or search query).
function channelLookupParam(hint: string): { key: "id" | "forHandle" | "forUsername"; value: string } | null {
  const value = hint.trim();
  if (!value) return null;
  if (value.startsWith("@")) return { key: "forHandle", value };
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(value)) return { key: "id", value };
  if (/^[A-Za-z0-9_.\-\s]+$/.test(value) && !value.includes(" ")) return { key: "forUsername", value };
  return null;
}

async function resolveChannelIdViaSearch(query: string, keyState: YoutubeKeyState): Promise<string | null> {
  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("type", "channel");
  searchUrl.searchParams.set("maxResults", "1");
  searchUrl.searchParams.set("q", query);
  const json = await fetchYouTubeRecord(searchUrl, "YouTube search failed", keyState);
  const items = Array.isArray(json.items) ? json.items.map(asRecord) : [];
  return items.length > 0 ? asString(asRecord(items[0].id).channelId) ?? null : null;
}

async function findEmailLive(data: ParsedEmailFinderData): Promise<{ stored: EmailFinderStored; cost: CostLog } | null> {
  if (!liveIntegrationsEnabled("email")) return null;
  if (!data.channelHint) return null;

  // R21-2: 이메일 보강도 발굴 레인이다(정산 추적이 아니다).
  const youtubeKeyState: YoutubeKeyState = { index: 0, lane: "discovery" };

  const channelUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
  channelUrl.searchParams.set("part", "snippet,brandingSettings");
  channelUrl.searchParams.set("maxResults", "1");
  const lookup = channelLookupParam(data.channelHint);
  if (lookup) {
    channelUrl.searchParams.set(lookup.key, lookup.value);
  } else {
    const resolvedId = await resolveChannelIdViaSearch(data.channelHint, youtubeKeyState);
    if (!resolvedId) return null;
    channelUrl.searchParams.set("id", resolvedId);
  }

  const channelJson = await fetchYouTubeRecord(channelUrl, "YouTube channel lookup failed", youtubeKeyState);
  const items = Array.isArray(channelJson.items) ? channelJson.items.map(asRecord) : [];
  if (items.length === 0) return null;

  const item = items[0];
  const snippet = asRecord(item.snippet);
  const branding = asRecord(asRecord(item.brandingSettings).channel);
  const text = [asString(snippet.description), asString(branding.description)].filter(Boolean).join("\n");
  const emails = extractEmails(text);
  const email = preferBusinessEmail(emails);

  const status: EmailFinderStored["status"] = email ? (isBusinessEmail(email) ? "verified" : "guessed") : "none";
  const confidence = email ? (isBusinessEmail(email) ? 90 : 70) : 0;
  const stored: EmailFinderStored = {
    candidateRef: data.candidateRef,
    channelRef: data.channelRef,
    email,
    status,
    source: email ? "about" : "none",
    confidence,
  };

  await adminDb.collection("emailFinds").doc(stableRef("email", `${data.channelRef}:${email ?? "none"}`)).set({
    ...stored,
    maskedEmail: maskEmail(email),
    updatedAt: FieldValue.serverTimestamp(),
    source: "youtube-data-api",
  }, { merge: true });
  return { stored, cost: costLog("youtube-channel-email", "youtube-data-api", 0) };
}

async function persistCandidates(
  results: CandidateResult[],
  source: string,
  requestedPurpose?: CandidateSourcePurpose,
): Promise<CandidatePersistCounts> {
  if (results.length === 0) return { created: 0, merged: 0, outcomes: [] };
  const updatedAtIso = new Date().toISOString();
  let created = 0;
  let merged = 0;
  const outcomes: CandidatePersistOutcome[] = [];
  for (let offset = 0; offset < results.length; offset += 200) {
    const chunk = results.slice(offset, offset + 200);
    const writes = chunk.map((candidate) => {
      const sliceType = candidate.__sliceType;
      const storedCandidate = withoutSliceType(candidate);
      const hasExactScope = Boolean(
        storedCandidate.canonicalProgramId
        && storedCandidate.campaignId
        && storedCandidate.sourceRunId
        && storedCandidate.sourceRunRef,
      );
      const plan = hasExactScope
        ? buildProgramScopedCandidateParticipationWrites({
          candidate: storedCandidate,
          canonicalProgramId: storedCandidate.canonicalProgramId ?? "",
          campaignId: storedCandidate.campaignId ?? "",
          sourceRunId: storedCandidate.sourceRunId ?? "",
          sourceRunRef: storedCandidate.sourceRunRef ?? "",
          accountOwnership: accountOwnershipFromCandidate(storedCandidate as Record<string, unknown>),
        })
        : null;
      const candidateSourcePurpose = requestedPurpose
        ?? (plan ? CANDIDATE_SOURCE_PURPOSE.PROGRAM_CANDIDATE : CANDIDATE_SOURCE_PURPOSE.FEED_DISCOVERY);
      const identityRef = plan?.identityRef ?? storedCandidate.candidateRef;
      const identityData = plan?.identityData ?? globalCandidateIdentityData(storedCandidate);
      const targetRef = plan
        ? adminDb.collection("campaign_candidates").doc(plan.participationRef.slice("campaign_candidates/".length))
        : adminDb.doc(identityRef);
      return {
        plan,
        candidateSourcePurpose,
        identityData,
        targetRef,
        candidateRef: storedCandidate.candidateRef,
        sliceType,
      };
    });
    // W9-1: 존재 판정과 authoritative target write를 같은 transaction에 묶는다. 동시 생성자는
    // transaction retry에서 merged로 재분류되고, commit 실패 전에는 outcome이 호출자에게 노출되지 않는다.
    const chunkOutcomes = await adminDb.runTransaction(async (transaction) => {
      const existingDocs = await transaction.getAll(...writes.map((write) => write.targetRef));
      const committedOutcomes: CandidatePersistOutcome[] = writes.map((write, index) => ({
        candidateRef: write.candidateRef,
        ...(write.sliceType ? { sliceType: write.sliceType } : {}),
        outcome: existingDocs[index]?.exists ? "merged" : "created",
      }));
      writes.forEach((write, index) => {
        const persistOutcome = committedOutcomes[index].outcome;
        const discoverySource = asString(write.identityData.discoverySource) ?? "";
        const discoveryArm = asString(write.identityData.discoveryArm) ?? "";
        const sourceFetchedAt = asString(write.identityData.sourceFetchedAt) ?? "";
        // One bounded edge per controlled source+outcome preserves first-save/rewrite and multi-source
        // history without growing on every repeated cache write.
        const provenanceFields = discoverySource && sourceFetchedAt ? {
          discoverySource,
          ...(discoveryArm ? { discoveryArm } : {}),
          persistOutcome,
          sourceFetchedAt,
          discoveryProvenance: {
            ...asRecord(existingDocs[index]?.data()?.discoveryProvenance),
            [`${discoverySource}:${persistOutcome}`]: {
              discoverySource, discoveryArm, persistOutcome, sourceFetchedAt,
            },
          },
        } : { persistOutcome };
        if (write.plan) {
          transaction.set(write.targetRef, {
            ...write.plan.participationData,
            ...provenanceFields,
            source,
            updatedAtIso,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        } else {
          transaction.set(write.targetRef, {
            ...write.identityData,
            ...provenanceFields,
            candidateSourcePurpose: write.candidateSourcePurpose,
            candidateSourcePurposeVersion: CANDIDATE_SCOPE_VERSION,
            ...(write.candidateSourcePurpose === CANDIDATE_SOURCE_PURPOSE.FEED_DISCOVERY ? { feedDiscoveryCandidate: true } : {}),
            source,
            updatedAtIso,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }
      });
      return committedOutcomes;
    });
    for (const outcome of chunkOutcomes) {
      outcomes.push(outcome);
      if (outcome.outcome === "created") created += 1;
      else merged += 1;
    }
  }
  return { created, merged, outcomes };
}

/**
 * R21-4②: handle 에서 YouTube URL 을 **조작하지 않는다.** 예전에는 어떤 handle 이든
 * `https://www.youtube.com/@<handle>/about` 을 만들어 붙였는데, 커뮤니티 시그널 레코드는
 * `@${host.split(".")[0]}`(예: `@reddit`, `@steamcommunity`)를 handle 로 갖는다
 * (communitySearch.ts candidateFromResult). 그 값이 YouTube 채널 URL 로 조작되면서 밴드 레코드가
 * 백필 후보 필터(`publicYoutubeUrls(...).length > 0`)를 통과하고, `updatedAtIso desc` 정렬상 가장
 * 최신이라 **30건/pass 예산을 먼저 먹은 뒤 반드시 실패**했다(이메일이 있을 수 없는 URL).
 * 게다가 실패는 `not_found` 로 기록돼 24시간 재시도까지 막았다.
 * → handle 파생 URL 은 **YouTube 채널이라는 독립 근거가 있을 때만** 만든다.
 */
function candidateHasYoutubeChannelIdentity(candidate: Record<string, unknown>): boolean {
  if (/^UC[\w-]{20,}$/.test(asString(candidate.channelId, "") ?? "")) return true;
  const explicit = [
    asString(candidate.youtubeUrl),
    asString(candidate.sourceUrl),
    asString(candidate.externalProfileUrl),
    asString(candidate.channelUrl),
  ];
  if (explicit.some((url) => typeof url === "string" && /^https:\/\/(www\.)?youtube\.com\//i.test(url))) return true;
  // 플랫폼 표기만 남은 레코드는 발굴 출처가 YouTube 계열일 때만 인정한다 — 커뮤니티 스크레이핑
  // 산출물은 platform 에 사이트 라벨(Reddit 등)이 들어가므로 여기서 걸러진다.
  const platform = (asString(candidate.platform, "") ?? "").toLowerCase();
  const discoverySource = (asString(candidate.discoverySource, "") ?? "").toLowerCase();
  const source = (asString(candidate.source, "") ?? "").toLowerCase();
  if (platform !== "youtube") return false;
  return !discoverySource.includes("community") && !source.includes("community");
}

function publicYoutubeUrls(candidate: Record<string, unknown>): string[] {
  const urls = [
    asString(candidate.youtubeUrl),
    asString(candidate.sourceUrl),
    asString(candidate.externalProfileUrl),
  ].filter((url): url is string => typeof url === "string" && /^https:\/\/(www\.)?youtube\.com\//i.test(url));
  const handle = asString(candidate.handle);
  if (handle && candidateHasYoutubeChannelIdentity(candidate)) {
    urls.push(`https://www.youtube.com/${handle.startsWith("@") ? handle : `@${handle}`}/about`);
  }
  return Array.from(new Set(urls.map((url) => url.includes("/about") ? url : `${url.replace(/\/$/, "")}/about`))).slice(0, 2);
}

function candidatePoolDocPath(candidate: Record<string, unknown>, fallbackSeed: string): string {
  const candidateRef = asString(candidate.candidateRef) ?? `candidate_pool/${asString(candidate.id, stableRef("candidate", fallbackSeed))}`;
  return candidateRef.includes("/") ? candidateRef : `candidate_pool/${candidateRef}`;
}

function publicWebBackfillRecentlyAttempted(candidate: Record<string, unknown>): boolean {
  const attemptedAtIso = asString(candidate.publicWebEmailBackfillAttemptedAtIso);
  if (!attemptedAtIso) return false;
  const attemptedAtMs = Date.parse(attemptedAtIso);
  return Number.isFinite(attemptedAtMs) && Date.now() - attemptedAtMs < PUBLIC_WEB_EMAIL_BACKFILL_RETRY_MS;
}

async function markPublicWebBackfillAttempt(candidate: Record<string, unknown>, status: "found" | "not_found", fallbackSeed: string) {
  await adminDb.doc(candidatePoolDocPath(candidate, fallbackSeed)).set({
    publicWebEmailBackfillAttemptedAtIso: new Date().toISOString(),
    publicWebEmailBackfillStatus: status,
    publicWebEmailBackfillUpdatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

/**
 * Apify actor 입력용 plain 채널 URL(About 접미사 없음) — publicYoutubeUrls의 identity 해석(채널 id
 * 정규식·handle 독립 근거 가드)을 그대로 재사용해 About 경로와 "같은 후보를 같은 채널로" 본다. actor
 * 는 "URL or channel id" 를 받는다 — 여기서는 실측 검증된 `/channel/<id>` URL 형태를 우선한다.
 */
function apifyChannelInputForCandidate(candidate: Record<string, unknown>): string | null {
  const urls = publicYoutubeUrls(candidate).map((url) => url.replace(/\/about$/, ""));
  return urls[0] ?? null;
}

/** captchaSolverCacheLookup/Store·recordCaptchaSolverCall 의 channelId 축 — 페이지 원문·쿼리
 * 파라미터가 아니라 채널 식별자만 남긴다(SEC-P0-009, captchaSolverIntegration.ts와 동일 원칙). */
function apifyCandidateChannelKey(candidate: Record<string, unknown>, fallback: string): string {
  return asString(candidate.channelId) ?? fallback;
}

/**
 * 헤세 결정(2026-09-24): T049(isApifyExclusiveOrg) 는 About 스크레이핑을 전혀 타지 않고 Apify
 * actor로만 이메일을 얻는다 — 실패/캡 소진 시에도 About로 폴백하지 않는다(§ 상단 모듈 docblock).
 *
 * 시간 예산: 채널당 ~49s 실측(captchaSolverIntegration.ts 상단 주석) 이므로, 남은 deadlineMs가
 * APIFY_CALL_MIN_BUDGET_MS 보다 적으면 이번 pass는 캐시 적중만 반영하고 실호출은 스킵한다(다음
 * pass가 재시도) — triggerScopedCampaignDiscovery(20s 예산)는 구조적으로 항상 이 경로를 타고,
 * materializePublicWebBackfill(120s 예산, processDiscoveryQueue 비동기 워커)만 실호출까지 간다.
 */
async function enrichCandidatesViaApify(
  candidates: Record<string, unknown>[],
  ownerOrgId: string,
  writeSharedPool: boolean,
  deadlineMs: number,
): Promise<CandidateResult[]> {
  const integration = await readCaptchaSolverIntegration();
  const results: CandidateResult[] = [];
  const live: Array<{ candidate: Record<string, unknown>; channelInput: string; channelKey: string }> = [];

  for (const candidate of candidates) {
    const channelInput = apifyChannelInputForCandidate(candidate);
    if (!channelInput) continue;
    const channelKey = apifyCandidateChannelKey(candidate, channelInput);
    const cached = await captchaSolverCacheLookup(ownerOrgId, channelKey, integration.cacheTtlHours);
    if (cached.status === "hit") {
      const cachedEmail = asString(cached.value.email);
      if (cachedEmail) results.push(await applyApifyEmailToCandidate(candidate, cachedEmail, writeSharedPool));
      continue; // cache hit (found or confirmed-empty) — never re-calls within the TTL window.
    }
    live.push({ candidate, channelInput, channelKey });
  }
  if (live.length === 0) return results;

  const remainingBudgetMs = deadlineMs - Date.now();
  if (remainingBudgetMs < APIFY_CALL_MIN_BUDGET_MS) return results;

  const gate = await isCaptchaSolverAllowedForOrg(ownerOrgId);
  if (!gate.allowed) {
    console.warn("[ai-drama-apify-email-backfill] blocked", { ownerOrgId, reason: gate.reason });
    return results;
  }

  const desiredBatchSize = Math.min(live.length, integration.perJobCallCap, APIFY_BATCH_SIZE_MAX);
  const reservedCount = await reserveCaptchaSolverCallSlots(desiredBatchSize, { dailyCallCap: integration.dailyCallCap });
  if (reservedCount === 0) {
    console.warn("[ai-drama-apify-email-backfill] daily_call_cap_reached", { ownerOrgId });
    return results;
  }
  const batch = live.slice(0, reservedCount);

  const callResult = await callApifyChannelEmailActor(
    batch.map((entry) => entry.channelInput),
    { actorId: integration.actorId },
    { timeoutMs: Math.min(remainingBudgetMs, APIFY_CALL_TIMEOUT_MS_MAX) },
  );

  if (callResult.status !== "success") {
    console.warn("[ai-drama-apify-email-backfill] call_failed", { ownerOrgId, status: callResult.status });
    await Promise.all(batch.map((entry) => recordCaptchaSolverCall(
      { orgId: ownerOrgId, channelId: entry.channelKey, costUsd: 0, cacheHit: false, reservedCallSlot: true },
    )));
    return results;
  }

  const itemByQuery = new Map(callResult.items.map((item) => [item.query, item]));
  for (const entry of batch) {
    const item = itemByQuery.get(entry.channelInput);
    const email = item?.email ?? null;
    await recordCaptchaSolverCall({
      orgId: ownerOrgId, channelId: entry.channelKey, costUsd: email ? APIFY_EMAIL_EVENT_PRICE_USD : 0, cacheHit: false, reservedCallSlot: true,
    });
    await captchaSolverCacheStore(ownerOrgId, entry.channelKey, { email }, integration.cacheTtlHours);
    if (email) {
      results.push(await applyApifyEmailToCandidate(entry.candidate, email, writeSharedPool));
    } else {
      await markPublicWebBackfillAttempt(entry.candidate, "not_found", entry.channelInput);
    }
  }
  return results;
}

/** enrichCandidateViaPublicWeb의 update/CandidateResult 쉐이프를 그대로 따른다 — 값만 source="apify"
 * (COST-P0/SEC-P0-009 provenance 축은 동일 필드명, discoverySource만 갈아 끼운다). */
async function applyApifyEmailToCandidate(
  candidate: Record<string, unknown>,
  email: string,
  writeSharedPool: boolean,
): Promise<CandidateResult> {
  const nowIso = new Date().toISOString();
  const emailStatus: EmailFinderStored["status"] = isBusinessEmail(email) ? "verified" : "guessed";
  const seed = apifyChannelInputForCandidate(candidate) ?? asString(candidate.id, "candidate") ?? "candidate";
  const docPath = candidatePoolDocPath(candidate, seed);
  const update = {
    email,
    emailStatus,
    emailSource: "apify",
    emailSourceKind: "apify" as EmailSourceKind,
    discoverySource: "ai-drama-apify-email-backfill",
    publicWebEmailBackfillAttemptedAtIso: nowIso,
    publicWebEmailBackfillStatus: "found",
    updatedAtIso: nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (writeSharedPool) {
    await adminDb.doc(docPath).set(update, { merge: true });
  } else {
    await markPublicWebBackfillAttempt(candidate, "found", seed);
  }
  return {
    candidateRef: docPath,
    channelRef: asString(candidate.channelRef, `yt_channel_${asString(candidate.id, docPath)}`) ?? docPath,
    name: asString(candidate.name, "Unknown channel") ?? "Unknown channel",
    handle: asString(candidate.handle, "") ?? "",
    avatar: asString(candidate.avatar, "🎬") ?? "🎬",
    platform: "YouTube",
    followers: asNumber(candidate.followers) ?? 0,
    region: asString(candidate.region, "GLOBAL") ?? "GLOBAL",
    category: asString(candidate.category, "Gaming") ?? "Gaming",
    matchScore: asNumber(candidate.matchScore) ?? 70,
    confidence: emailStatus === "verified" ? 86 : 68,
    signals: [...(Array.isArray(candidate.signals) ? candidate.signals.filter((item): item is string => typeof item === "string") : []), "apifyEmail"],
    email,
    emailStatus,
    emailSource: "apify",
    emailSourceKind: "apify" as EmailSourceKind,
    youtubeUrl: asString(candidate.youtubeUrl),
    sourcePlatform: "YouTube",
    sourceUrl: seed,
    discoverySource: "ai-drama-apify-email-backfill",
    publicDescription: asString(candidate.publicDescription, "")?.slice(0, 5_000),
    matchedSearchTerms: asStringArray(candidate.matchedSearchTerms)?.slice(0, 12),
  };
}

function candidateMatchesYtDiscovery(candidate: Record<string, unknown>, data: ParsedYtDlpDiscoveryData): boolean {
  const country = asString(candidate.creatorCountry) ?? asString(candidate.region);
  if (!youtubeCreatorCountryPolicyDecision(country, data.countryTargeting).accepted) return false;
  const followers = asNumber(candidate.followers) ?? 0;
  if (data.filters.minFollowers > 0 && followers < data.filters.minFollowers) return false;
  if (data.filters.maxFollowers > 0 && followers > data.filters.maxFollowers) return false;
  const text = [
    asString(candidate.name, ""),
    asString(candidate.handle, ""),
    asString(candidate.platform, ""),
    asString(candidate.category, ""),
    asString(candidate.publicDescription, ""),
    ...(asStringArray(candidate.matchedSearchTerms) ?? []),
  ].join(" ").toLowerCase();
  const includeTerms = Array.from(new Set([
    ...data.filters.categories,
    ...data.keywords,
  ])).map((item) => item.toLowerCase());
  if (includeTerms.length > 0 && !includeTerms.some((term) => text.includes(term))) return false;
  if (data.filters.excludeKeywords.some((term) => text.includes(term.toLowerCase()))) return false;
  if (data.discoveryVertical === "ai_drama") {
    const minVideoViews = Math.max(1, Math.trunc(data.minVideoViews || AI_DRAMA_MIN_QUALIFYING_VIDEO_VIEWS));
    const minVideoCount = Math.max(1, Math.trunc(data.minVideoCount || AI_DRAMA_MIN_QUALIFYING_VIDEO_COUNT));
    const qualifyingVideo = asRecord(candidate.qualifyingVideo);
    const qualifyingCount = Math.trunc(asNumber(asRecord(candidate.videoQualification).qualifyingVideoCount) ?? 0);
    const viewCount = asNumber(qualifyingVideo.viewCount);
    if (qualifyingCount < minVideoCount) return false;
    if (viewCount === undefined || viewCount < minVideoViews) return false;
  }
  return true;
}

function publicWebTextFromHtml(html: string): string {
  return html
    .replace(/\\u0026/g, "&")
    .replace(/\\n/g, "\n")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

async function fetchPublicYoutubeChannelText(url: string): Promise<string> {
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  const timeout = setTimeout(() => controller?.abort(), PUBLIC_WEB_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "accept": "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 FluDiscovery/1.0 (+https://sc-flu.web.app)",
      },
      signal: controller?.signal,
    });
    if (!response.ok) return "";
    const body = await Promise.race([
      response.text(),
      new Promise<string>((resolve) => setTimeout(() => {
        controller?.abort();
        resolve("");
      }, PUBLIC_WEB_FETCH_TIMEOUT_MS)),
    ]);
    return publicWebTextFromHtml(body);
  } finally {
    clearTimeout(timeout);
    controller?.abort();
  }
}

async function enrichCandidateViaPublicWeb(
  candidate: Record<string, unknown>,
  writeSharedPool: boolean,
): Promise<CandidateResult | null> {
  const urls = publicYoutubeUrls(candidate);
  for (const url of urls) {
    try {
      const text = await fetchPublicYoutubeChannelText(url);
      const email = preferBusinessEmail(extractEmails(text));
      if (!email) continue;
      const nowIso = new Date().toISOString();
      const emailStatus: EmailFinderStored["status"] = isBusinessEmail(email) ? "verified" : "guessed";
      const docPath = candidatePoolDocPath(candidate, url);
      const update = {
        email,
        emailStatus,
        emailSource: "youtube_public_web",
        // W115-R1 [LOW]: 닫힌 값 집합의 `public_scrape` 를 실제로 스탬프하는 유일한 레인이다.
        //   종전에는 이 축이 비어 있어 A4 소스별 기여 측정에서 이 레인이 통째로 "미상"이었다.
        emailSourceKind: "public_scrape" as EmailSourceKind,
        discoverySource: "youtube-public-web-email-backfill",
        publicWebEmailBackfillAttemptedAtIso: nowIso,
        publicWebEmailBackfillStatus: "found",
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (writeSharedPool) {
        await adminDb.doc(docPath).set(update, { merge: true });
      } else {
        // R28-4 [HIGH-3]: scoped pass(provenance 有)는 공유 풀의 **후보 내용**을 쓰지 않는다 —
        // 그러나 시도 마커는 남긴다. 마커까지 게이트에 묶여 있던 옛 코드에서는 provenance 가 붙은
        // pass 가 아무 흔적도 남기지 않아 24h 재시도 펜스(publicWebBackfillRecentlyAttempted)가
        // 무력화됐고, 같은 채널을 매 pass 무한 재스크래핑했다(행동 축소 방향의 수리).
        await markPublicWebBackfillAttempt(candidate, "found", url);
      }
      return {
        candidateRef: docPath,
        channelRef: asString(candidate.channelRef, `yt_channel_${asString(candidate.id, docPath)}`) ?? docPath,
        name: asString(candidate.name, "Unknown channel") ?? "Unknown channel",
        handle: asString(candidate.handle, "") ?? "",
        avatar: asString(candidate.avatar, "🎬") ?? "🎬",
        platform: "YouTube",
        followers: asNumber(candidate.followers) ?? 0,
        region: asString(candidate.region, "GLOBAL") ?? "GLOBAL",
        category: asString(candidate.category, "Gaming") ?? "Gaming",
        matchScore: asNumber(candidate.matchScore) ?? 70,
        confidence: emailStatus === "verified" ? 86 : 68,
        signals: [...(Array.isArray(candidate.signals) ? candidate.signals.filter((item): item is string => typeof item === "string") : []), "publicWebEmail"],
        email,
        emailStatus,
        emailSource: "youtube_public_web",
        emailSourceKind: "public_scrape" as EmailSourceKind,
        youtubeUrl: asString(candidate.youtubeUrl),
        sourcePlatform: "YouTube",
        sourceUrl: url,
        discoverySource: "youtube-public-web-email-backfill",
        publicDescription: asString(candidate.publicDescription, "")?.slice(0, 5_000),
        matchedSearchTerms: asStringArray(candidate.matchedSearchTerms)?.slice(0, 12),
      };
    } catch {
      continue;
    }
  }
  // R28-4 [HIGH-3]: not_found 마커도 공유 풀 쓰기 게이트와 분리한다 — 이 채널을 방금 긁어 이메일을
  // 못 찾았다는 사실은 scoped pass 에서도 참이고, 24h 안에 다시 긁을 이유가 없다.
  await markPublicWebBackfillAttempt(candidate, "not_found", urls[0] ?? asString(candidate.id, "candidate") ?? "candidate");
  return null;
}

async function publicWebBackfillExistingCandidateEmails(
  data: ParsedYtDlpDiscoveryData,
  deadlineMs = Date.now() + PUBLIC_WEB_EMAIL_BACKFILL_DEADLINE_MS,
  writeSharedPool = true,
  ownerOrgId?: string,
): Promise<{ results: CandidateResult[]; source: string; cost: CostLog }> {
  const snapshot = await adminDb.collection("candidate_pool")
    .orderBy("updatedAtIso", "desc")
    .limit(PUBLIC_WEB_EMAIL_BACKFILL_LIMIT)
    .get()
    .catch(async () => adminDb.collection("candidate_pool").limit(PUBLIC_WEB_EMAIL_BACKFILL_LIMIT).get());
  const candidates = snapshot.docs
    .map((doc): Record<string, unknown> => ({ id: doc.id, candidateRef: `candidate_pool/${doc.id}`, ...(doc.data() ?? {}) }))
    .filter((candidate) => !asString(candidate.email))
    .filter((candidate) => publicYoutubeUrls(candidate).length > 0)
    .filter((candidate) => !publicWebBackfillRecentlyAttempted(candidate))
    .filter((candidate) => candidateMatchesYtDiscovery(candidate, data))
    .slice(0, Math.max(1, Math.min(data.resultLimit, PUBLIC_WEB_EMAIL_BACKFILL_FETCH_LIMIT)));

  // 헤세 결정(2026-09-24): ownerOrgId가 integrations/captcha_solver.allowedOrgIds 멤버(T049 등)면
  // 이 pass는 About을 전혀 타지 않는다 — Apify 전용 경로로 완전히 갈라진다(후보별로 섞이지 않는다).
  // 다른 org는 이 분기 자체를 평가하지 않으므로(아래 && 단락 평가) 기존 About 경로가 100% 그대로다.
  if (ownerOrgId && await isApifyExclusiveOrg(ownerOrgId)) {
    const results = await enrichCandidatesViaApify(candidates, ownerOrgId, writeSharedPool, deadlineMs);
    return { results, source: "ai-drama-apify-email-backfill", cost: costLog("apify-channel-email", "apify", 0) };
  }

  const results: CandidateResult[] = [];
  let cursor = 0;
  const boundedDeadlineMs = Math.min(deadlineMs, Date.now() + PUBLIC_WEB_EMAIL_BACKFILL_DEADLINE_MS);
  async function worker() {
    while (cursor < candidates.length && Date.now() + PUBLIC_WEB_FETCH_TIMEOUT_MS < boundedDeadlineMs) {
      const candidate = candidates[cursor];
      cursor += 1;
      const enriched = await enrichCandidateViaPublicWeb(candidate, writeSharedPool);
      if (enriched) results.push(enriched);
    }
  }
  await Promise.all(Array.from({ length: Math.min(PUBLIC_WEB_EMAIL_BACKFILL_CONCURRENCY, candidates.length) }, () => worker()));
  return { results, source: "youtube-public-web-email-backfill", cost: costLog("yt-dlp-worker", "yt-dlp", 0) };
}

/**
 * R21-4③ [사용자 질문의 답]: YouTube API 쿼터가 소진되면(전 키 429/403) **쿼터 0 커뮤니티 레인**으로
 * 인계한다. 사용자 질문("yt-dlp 로 부족한 거 채우는 로직 없나")에 대한 답은 리더 실측으로 확정됐다:
 * yt-dlp 레인은 라벨만 있고(commandPlan·engine·worker 문자열) **그 잡을 실행하는 워커가 레포에 없다**
 * — 실제 검색은 searchYouTubeLive(=API)다. 반면 communitySearch.ts 는 YouTube 쿼터를 **1유닛도 쓰지
 * 않는다**(Google 검색·news RSS·Steam·r.jina.ai 스크레이핑, 참조 0건 실측). 이미 배선된 그 레인을 쓴다.
 *
 * 예전 동작: 429 → materializePublicWebBackfill(기존 후보 이메일 **보강만**, 신규 채널 0)
 * → results.length===0 → rethrow → dead_letter. 어제 잡 4회 전멸의 정확한 이유다.
 *
 * ⚠️ 새 Cloud Run 워커를 만들지 않는다(인프라 요청 대상). 레이트리밋은 enqueueCommunityDiscovery 의
 * 기존 쿨다운(readCommunityDiscoveryState)을 그대로 쓴다 — 스크레이핑도 남용하면 차단된다.
 * 인계는 잡 생성까지이고 실제 적재는 기존 processDiscoveryQueue 워커가 한다.
 */
/** 마지막 인계 실패 사유(진단 전용 — 키·PII 없음). 테스트·운영 로그가 같은 값을 본다. */
let lastCommunityHandoffError: string | null = null;
export function lastQuotaFallbackHandoffError(): string | null {
  return lastCommunityHandoffError;
}

async function handOffToQuotaFreeCommunityLane(
  data: ParsedYtDlpDiscoveryData,
): Promise<{ runId: string; jobRef: string; status: string } | null> {
  const keywords = data.keywords.filter((keyword) => keyword.trim().length > 0).slice(0, 12);
  // 검색어가 없으면 일반어로 전역 풀을 오염시키는 대신 넘어간다(발굴 enqueue 와 같은 판단).
  if (keywords.length === 0) return null;
  // ⚠️ source:"scheduled" 를 쓰면 안 된다 — 그 경로의 멱등 키가 `scheduled:<날짜>` 라서(자정 1회
  // 스케줄 실행과 **같은 정체성**) 하루 한 건으로 묶이고, 온디맨드 인계가 그 날의 정규 실행을
  // 대체해 버린다. callable 경로의 actionId 를 쓰되, (KST 일자 + 검색어)로 **결정적으로** 만들어
  // 같은 날 같은 키워드의 반복 인계는 멱등 영수증으로 접히게 한다(스크레이핑 남용 방지).
  // 레이트리밋의 정본은 그와 별개로 enqueueCommunityDiscovery 의 기존 쿨다운이다.
  const actionSeed = createHash("sha256")
    .update(`youtube-quota-fallback:${seoulDayKey()}:${keywords.join("|")}`)
    .digest("hex");
  const actionId = [
    actionSeed.slice(0, 8),
    actionSeed.slice(8, 12),
    `4${actionSeed.slice(13, 16)}`,
    `${"89ab"[parseInt(actionSeed.slice(16, 17), 16) % 4]}${actionSeed.slice(17, 20)}`,
    actionSeed.slice(20, 32),
  ].join("-");
  try {
    const handoff = await enqueueCommunityDiscovery({
      data: {
        gameId: data.gameId,
        keywords,
        actionId,
        // 캠페인 스코프는 붙이지 않는다 — candidate_pool 은 전역 풀 설계이고(candidateScope 의도)
        // 커뮤니티 산출물에 프로그램 귀속을 부착하지 않는다.
        respectCooldown: true,
        trigger: "youtube_quota_exhausted",
      },
      context: {
        userId: "system-youtube-quota-fallback",
        role: "admin",
        team: "scp",
        ip: "0.0.0.0",
      },
      source: "callable",
      action: "queueCommunityDiscovery",
      // 레이트리밋 필수: 쿼터 소진은 지속 상태라 매 잡마다 스크레이핑을 새로 트리거하면 남용이 된다.
      enforceCooldown: true,
    });
    return {
      runId: asString(asRecord(handoff).runId, "") ?? "",
      jobRef: asString(asRecord(handoff).jobRef, "") ?? "",
      status: asString(asRecord(handoff).status, "queued") ?? "queued",
    };
  } catch (error) {
    // 인계 실패가 원래 쿼터 오류를 가려선 안 된다 — 호출부가 rethrow 하도록 null 을 돌려준다.
    // R21-4: 인계 실패 사유를 **호출부가 볼 수 있게** 남긴다. console.warn 만으로는 잼 진단이 안 된다
    // (R20 에서 같은 클래스를 이미 고쳤다 — 관측 표면이 없으면 조용한 실패가 된다).
    lastCommunityHandoffError = error instanceof Error ? error.message.slice(0, 300) : "unknown";
    console.warn("[youtube-quota-fallback] community lane handoff failed", {
      gameId: data.gameId,
      errorCode: lastCommunityHandoffError,
    });
    return null;
  }
}

export async function materializePublicWebBackfill(
  data: ParsedYtDlpDiscoveryData,
  deadlineMs: number,
  provenance: CandidateDiscoveryProvenance | null,
  ownerOrgId?: string,
): Promise<{ results: CandidateResult[]; source: string; cost: CostLog }> {
  const materialized = await publicWebBackfillExistingCandidateEmails(data, deadlineMs, !provenance, ownerOrgId);
  const results = provenance ? stampCandidateDiscoveryProvenance(materialized.results, provenance) : materialized.results;
  await persistCandidates(
    results,
    materialized.source,
    provenance ? CANDIDATE_SOURCE_PURPOSE.PROGRAM_CANDIDATE : CANDIDATE_SOURCE_PURPOSE.IDENTITY_ENRICHMENT,
  );
  return { ...materialized, results };
}

// Reusable live discovery entry point for other engines (e.g. recommendCreators) to populate
// candidate_pool without duplicating the YouTube fetch/persist logic. Returns the count written.
export async function discoverAndPersistCandidates(query?: string | { keywords?: string[]; categories?: string[]; minFollowers?: number; recentActivityDays?: number }): Promise<number> {
  const categories = typeof query === "string"
    ? [query]
    : query?.keywords?.length
      ? query.keywords
      : query?.categories?.length
        ? query.categories
        : ["mobile game review"];
  const data: ParsedYoutubeSearchData = {
    queryRef: stableRef("dq", categories[0]),
    campaignRef: "campaign_recommend_discovery",
    gameId: "game_unknown",
    resultLimit: DISCOVERY_RESULT_LIMIT_MAX,
    countryTargeting: {
      countryScope: "inherit",
      includedCountries: [],
      excludedCountries: [],
    },
    filters: {
      regions: [],
      categories,
      categoriesExplicit: true,
      minFollowers: typeof query === "object" ? query.minFollowers ?? 0 : 0,
      recentActivityDays: typeof query === "object" ? query.recentActivityDays ?? 30 : 30,
    },
    discoveryVertical: "game",
    minVideoViews: 0,
    minVideoCount: 0,
  };
  const live = await searchYouTubeLive(data);
  return live ? live.results.length : 0;
}

export type YtdlpPromotionHydrationRequest = {
  campaignId: string;
  observations: readonly YtdlpPromotionObservedChannel[];
};

export type YtdlpPromotionHydrationResult = {
  candidates: CandidateResult[];
  canonicalProgramId: string;
  policy: ProgramDiscoveryPolicyResolution;
  recencyFiltered: number;
  hydrationOverflow?: HydrationOverflowStat;
  /**
   * W75-R1 P1-4: **비용 회계.** 종전에는 `searchYouTubeLive` 가 낸 cost 를 여기서 버려
   *   승격 경로의 YouTube 호출이 원장에 전혀 남지 않았다(COST 규율 위반).
   *   다른 호출자(processDiscoveryQueue·youtubeSearch)와 **같은 형상**으로 흘린다.
   */
  cost?: CostLog;
  /**
   * W75-R1 P1-4: recency 판정용 `videos.list` 호출 수(50건/호출 = 1유닛/호출).
   *   hydration 의 channels.list 와 **다른 축**이라 cost 하나로는 설명되지 않는다.
   */
  recencyVideoListCalls?: number;
  /** W77-②: 영상 설명란에서 새로 캔 이메일 수(해소율 개선 효과 관측축). */
  videoDescriptionEmails?: number;
  /** W84: hydration 이 받아온 설명란(추가 조회 없이 보충 레인이 재사용한다). */
  descriptionByVideoId?: ReadonlyMap<string, string>;
};

/**
 * W77-④ — **백필 재마이닝용 영상 설명란 조회.**
 *
 * ②의 recency 경로와 **같은 규율**을 쓴다: 캐시 선행 · 50개 배치 · 호출 상한 · 유닛 회계.
 * 차이는 목적뿐이다(여기서는 recency 가 아니라 description 만 필요하다).
 * 채널당 조회를 하지 않는 것이 핵심이다 — videoId 배치라 채널 1명당이 아니라 50영상당 1유닛이다.
 */
export async function readVideoDescriptionsForBackfill(
  videoIds: readonly string[],
  maxCalls: number,
  // Flu/W2 (Codex 적대 리뷰 HIGH-1 수리): 이 백필은 searchYouTubeLive 의 이메일 마이닝 보조
  // 레인이다 — 호출부가 resolvedYoutubePoolId 를 넘기지 않으면 growth(undefined)로 남는다(기존
  // 4개 호출부는 없었으므로 회귀 0). 넘기면 그 run 의 검색과 같은 풀을 써 T049 런 안에서 이 백필만
  // growth 로 새는 것을 막는다.
  poolId?: string,
): Promise<{
  descriptionByVideoId: Map<string, string>;
  /**
   * R1-P0-5: **실제로 조회한** videoId. 설명란이 비어 있어도 "봤다"는 사실이 필요하다 —
   *   호출 상한 밖이라 아예 안 본 대상과 구분해야 시도(attempts)를 잘못 적립하지 않는다.
   */
  fetchedVideoIds: Set<string>;
  videoListCalls: number;
}> {
  const unique = Array.from(new Set(videoIds)).filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id));
  const descriptionByVideoId = new Map<string, string>();
  const fetchedVideoIds = new Set<string>();
  const keyState: YoutubeKeyState = { index: 0, lane: "discovery", ...(poolId ? { poolId } : {}) };
  let videoListCalls = 0;
  const pages: string[][] = [];
  for (let index = 0; index < unique.length; index += 50) {
    pages.push(unique.slice(index, index + 50));
  }
  for (const page of pages.slice(0, Math.max(0, Math.trunc(maxCalls)))) {
    for (const videoId of page) fetchedVideoIds.add(videoId);
    const cacheKey = discoveryCacheKey("youtube", `w77:videos:${page.join(",")}`);
    const cached = await cacheLookup(cacheKey, DISCOVERY_CACHE_TTL_SECONDS);
    const cachedItems = Array.isArray(asRecord(cached.value).items)
      ? (asRecord(cached.value).items as unknown[]).map(asRecord)
      : null;
    let items: Record<string, unknown>[];
    if (cached.status === "hit" && cachedItems) {
      items = cachedItems;
    } else {
      const url = new URL("https://www.googleapis.com/youtube/v3/videos");
      url.searchParams.set("part", "snippet");
      url.searchParams.set("id", page.join(","));
      const response = await fetchYouTubeRecord(url, "YouTube backfill description lookup failed", keyState);
      videoListCalls += 1;
      items = Array.isArray(response.items) ? response.items.map(asRecord) : [];
      await cacheStore(cacheKey, "youtube", "w77:videos", DISCOVERY_CACHE_TTL_SECONDS, { items });
    }
    for (const item of items) {
      const videoId = asString(item.id) ?? "";
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
      const description = asString(asRecord(item.snippet).description);
      if (description) descriptionByVideoId.set(videoId, description);
    }
  }
  return { descriptionByVideoId, fetchedVideoIds, videoListCalls };
}

/**
 * W77-② — **최신 영상 설명란 이메일 마이닝(순수).**
 *
 * 지금까지 이메일은 채널 About 설명란 하나에서만 캤다(첫 표본 해소율 ~6%). 관측은 이미
 * videoIds 를 들고 있고, recency 판정용 `videos.list` 는 이미 `part=snippet` 으로 부르므로
 * 응답에 description 이 들어 있다 — 즉 **추가 API 호출 0**으로 두 번째 소스가 생긴다.
 *
 * 귀속은 **관측이 들고 있던 videoId → 채널 매핑으로만** 한다. 응답의 snippet.channelId 를
 * 쓰면 같은 페이지(50 id)에 섞인 다른 채널로 이메일이 새어 들어간다 — 잘못된 사람에게
 * 메일이 나가는 사고다.
 */
/**
 * W77-② [R1-P0-6]: 후보 → 채널 ID 의 **정본 규칙**.
 *   내가 처음 쓴 `channelRef.replace(/^channels\//)` 는 실제 접두(yt_channel_)와 달라 no-op 이었고,
 *   그래서 hydration 마이닝이 프로덕션에서 **한 건도 발화하지 않았다**(에뮬은 스텁이라 안 잡혔다).
 *   승격 스윕(channelIdFromCandidate)과 같은 축을 쓴다 — 규칙을 복제하지 않는다.
 */
export function promotionChannelIdFromCandidate(candidate: { candidateRef?: string; channelRef?: string }): string {
  const fromCandidateRef = String(candidate.candidateRef ?? "").replace(/^candidate_pool\//, "");
  if (fromCandidateRef) return fromCandidateRef;
  return String(candidate.channelRef ?? "").replace(/^yt_channel_/i, "");
}

/**
 * W115-R1: 캔 이메일과 **그 출처의 신뢰 등급**. 절단본(검색 스니펫)에서 나온 주소는 도메인 꼬리가
 * 잘렸을 수 있어 `verified` 승격 자격이 없다 — 그 사실이 값과 함께 다니지 않으면 호출부가
 * 복원할 방법이 없다(문자열만 돌려주던 종전 형상의 결함).
 */
export type MinedDescriptionEmail = {
  readonly email: string;
  /** true 면 검색 스니펫(절단본) 유래다. videos.list 전문에서 확인되면 false 가 된다. */
  readonly truncatedSource: boolean;
};

const EMPTY_TRUNCATED_VIDEO_IDS: ReadonlySet<string> = new Set<string>();

export function mineEmailsFromVideoDescriptions(
  observations: readonly { readonly channelId: string; readonly videoIds: readonly string[] }[],
  descriptionByVideoId: ReadonlyMap<string, string>,
  /** 값이 **절단본**인 videoId 집합(검색 스니펫). 백필로 전문을 받은 id 는 여기서 빠진다. */
  truncatedVideoIds: ReadonlySet<string> = EMPTY_TRUNCATED_VIDEO_IDS,
): Map<string, MinedDescriptionEmail> {
  const emailByChannelId = new Map<string, MinedDescriptionEmail>();
  for (const observation of observations) {
    if (emailByChannelId.has(observation.channelId)) continue;
    // 전문과 절단본을 **분리해서** 판정한다. 합쳐서 한 덩어리로 뽑으면 어느 쪽에서 나온
    //   주소인지 되읽을 수 없고, 절단 경계 판정 자체가 성립하지 않는다(합친 텍스트의 끝은
    //   마지막 조각의 끝일 뿐이다).
    const fullEmails: string[] = [];
    const truncatedEmails: string[] = [];
    for (const videoId of observation.videoIds) {
      const description = descriptionByVideoId.get(videoId);
      if (!description) continue;
      const truncated = truncatedVideoIds.has(videoId);
      const mined = extractEmailsForDiscovery(description, { truncated });
      (truncated ? truncatedEmails : fullEmails).push(...mined);
    }
    // 전문 유래를 먼저 본다 — 같은 채널에 둘 다 있으면 승격 가능한 쪽이 이긴다.
    const fromFull = preferBusinessEmail(fullEmails);
    if (fromFull) {
      emailByChannelId.set(observation.channelId, { email: fromFull, truncatedSource: false });
      continue;
    }
    const fromTruncated = preferBusinessEmail(truncatedEmails);
    if (fromTruncated) emailByChannelId.set(observation.channelId, { email: fromTruncated, truncatedSource: true });
  }
  return emailByChannelId;
}

async function resolveYtdlpPromotionRecentObservations(
  observations: readonly YtdlpPromotionObservedChannel[],
  recentActivityDays: number,
  // Flu/W2 (Codex 적대 리뷰 MEDIUM-5 수리): 호출부(hydrateYtdlpPromotionObservations)가 이 W75
  // 캠페인의 org 별칭을 읽었으면 넘긴다 — 안 넘기면(기존 유일 호출부 이전 상태) growth, 회귀 0.
  poolId?: string,
): Promise<{
  observations: YtdlpPromotionObservedChannel[];
  recencyFiltered: number;
  /** W75-R1 P1-4: 실제로 발사한 videos.list 호출 수(1유닛/호출). 회계에서 빠지면 안 된다. */
  videoListCalls: number;
  /**
   * W77-② 최신 영상 설명란에서 캔 이메일(channelId → email).
   *   **추가 API 호출은 0이다** — 아래 videos.list 는 이미 `part=snippet` 으로 부르고 있고
   *   snippet 에 description 이 들어 있다. 지금까지 같은 응답의 절반을 버리고 있었다.
   */
  emailByChannelId: Map<string, MinedDescriptionEmail>;
  /** W84: 이번 호출이 받아온 설명란(추가 조회 없이 재사용). */
  descriptionByVideoId: Map<string, string>;
}> {
  const videoIds = Array.from(new Set(observations.flatMap((item) => item.videoIds)))
    .filter((videoId) => /^[A-Za-z0-9_-]{11}$/.test(videoId));
  const publishedAtByVideoId = new Map<string, string>();
  const descriptionByVideoId = new Map<string, string>();
  const keyState: YoutubeKeyState = { index: 0, lane: "discovery", ...(poolId ? { poolId } : {}) };
  let videoListCalls = 0;
  // W77-②: **배치당 호출 상한(COST 규율).** channelsPerBatch 를 200 으로 올렸으므로 관측
  //   videoId 수가 함께 늘어난다. 상한이 없으면 한 배치가 videos.list 를 무제한으로 때린다.
  //   1페이지 = 50 id 이므로 20페이지면 1,000 videoId 까지 덮는다(배치 200채널에 충분).
  const maxVideoListCalls = 20;
  const pages: string[][] = [];
  for (let index = 0; index < videoIds.length; index += 50) {
    pages.push(videoIds.slice(index, index + 50));
  }
  for (const page of pages.slice(0, maxVideoListCalls)) {
    // W77-②: **캐시 선행(COST-P0-011).** 같은 id 묶음은 TTL 안에서 다시 안 부른다 —
    //   다회 배치·재시도에서 같은 페이지가 반복되는 형상이 실제로 있다.
    const cacheKey = discoveryCacheKey("youtube", `w77:videos:${page.join(",")}`);
    const cached = await cacheLookup(cacheKey, DISCOVERY_CACHE_TTL_SECONDS);
    const cachedItems = Array.isArray(asRecord(cached.value).items)
      ? (asRecord(cached.value).items as unknown[]).map(asRecord)
      : null;
    let items: Record<string, unknown>[];
    if (cached.status === "hit" && cachedItems) {
      items = cachedItems;
    } else {
      const url = new URL("https://www.googleapis.com/youtube/v3/videos");
      url.searchParams.set("part", "snippet");
      url.searchParams.set("id", page.join(","));
      const response = await fetchYouTubeRecord(url, "YouTube promotion recency lookup failed", keyState);
      videoListCalls += 1;
      items = Array.isArray(response.items) ? response.items.map(asRecord) : [];
      await cacheStore(cacheKey, "youtube", "w77:videos", DISCOVERY_CACHE_TTL_SECONDS, { items });
    }
    for (const item of items) {
      const videoId = asString(item.id) ?? "";
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
      const snippet = asRecord(item.snippet);
      const publishedAtIso = asString(snippet.publishedAt) ?? "";
      if (Number.isFinite(Date.parse(publishedAtIso))) {
        publishedAtByVideoId.set(videoId, publishedAtIso);
      }
      const description = asString(snippet.description);
      if (description) descriptionByVideoId.set(videoId, description);
    }
  }
  const emailByChannelId = mineEmailsFromVideoDescriptions(observations, descriptionByVideoId);
  // W84: 이 맵을 버리지 않는다 — 기존 무이메일 후보 보충이 **같은 응답**을 재사용한다.
  //   버리면 호출부가 같은 videos.list 를 다시 때리게 되고, 그게 COST 규율 위반이다.
  const result = filterPromotionObservationsByRecentVideo({
    observations: observations.map((item) => ({
      channelId: item.channelId,
      channelUrl: item.channelUrl,
      title: item.title,
      queries: item.queryTerms,
      videoIds: item.videoIds,
    })),
    publishedAtByVideoId,
    recentActivityDays,
    nowMs: Date.now(),
  });
  return {
    observations: result.eligible.map((item) => ({
      channelId: item.channelId,
      channelUrl: item.channelUrl,
      title: item.title,
      queryTerms: [...item.queries],
      videoIds: [...item.videoIds],
      latestVideoPublishedAtIso: result.latestPublishedAtByChannelId.get(item.channelId),
    })),
    recencyFiltered: result.dropped,
    videoListCalls,
    emailByChannelId,
    descriptionByVideoId,
  };
}

/**
 * W75 승격의 외부 호출 경계. yt-dlp 가 이미 찾은 채널 ID만 channels.list 로 hydration하고,
 * 기존 프로그램 정책(국가·팔로워·제외어)과 기존 이메일 추출을 그대로 거친다. search.list,
 * 그래프 확장, 인기차트는 observedChannels 분기에서 전부 0회다.
 */
export async function hydrateYtdlpPromotionObservations(
  request: YtdlpPromotionHydrationRequest,
): Promise<YtdlpPromotionHydrationResult> {
  const scopedContext = await resolveAuthoritativeDiscoveryCampaignContext(
    request.campaignId,
    `campaigns/${request.campaignId}`,
  );
  if (!scopedContext) {
    throw Object.assign(new Error("failed-precondition: W75 campaign scope is required"), {
      code: "failed-precondition",
      errorCode: "ytdlp_promotion_campaign_scope_missing",
    });
  }
  const [campaignSnapshot, programSnapshot] = await Promise.all([
    adminDb.collection("campaigns").doc(scopedContext.campaignId).get(),
    adminDb.collection("programs").doc(scopedContext.canonicalProgramId).get(),
  ]);
  const campaign = campaignSnapshot.data() ?? {};
  const program = programSnapshot.data() ?? {};
  const policy = resolveProgramDiscoveryCriteria(program, campaign);
  // Flu/W2 (Codex 적대 리뷰 MEDIUM-5 수리): 이 함수는 accountOwnership 을 따로 해석하지 않으므로
  // (persistYtdlpPromotionCandidates 의 기존 ownership 미탑재 갭과 같은 한계) 문서 원문 별칭만
  // 읽는다 — 정본 스탬프가 있는 경로(triggerScopedCampaignDiscovery 등)와 달리 신뢰 수준이 낮지만,
  // 안 읽는 것보다는 growth 예산을 지킨다. 없으면(대부분의 오늘 캠페인) growth 로 폴백 — 회귀 0.
  //
  // 최종 전체-브랜치 Codex 적대 리뷰 2차 재검증에서 program 문서로 한 단계 더 폴백하는 안을
  // 시도했다가 되돌렸다: resolveAuthoritativeDiscoveryCampaignContext는 campaign-program 관계만
  // 검증할 뿐 둘의 org 소유자가 서로 일치하는지는 검증하지 않는다 — 레거시 캠페인의 진짜 소유자와
  // 연결된 program의 ownerOrgId 스탬프가 서로 다르면(데이터 정합성 이상 상태), program 폴백이
  // "누락된 별칭을 메우는" 대신 "다른 org의 풀을 잘못 고르는" 새로운 실패 모드를 만든다. 이 함수의
  // 원래 철학("모르면 growth" — 이미 검증된 안전한 기본값)을 깨는 리스크가 얻는 이득보다 커서,
  // W75(이 스펙의 W1-W6 범위 밖 기존 기능)의 진짜 authoritative ownership 해석은 별도 작업으로
  // 미룬다.
  const promotionOwnerOrgId = asString(campaign.ownerOrgId)
    || asString(campaign.accountOwnerOrgId)
    || asString(campaign.programOwnerOrgId)
    || asString(campaign.campaignOwnerOrgId);
  const promotionResolvedPoolId = promotionOwnerOrgId ? await resolvePoolIdForOrg(promotionOwnerOrgId) : YOUTUBE_GROWTH_POOL_ID;
  const promotionNonGrowthPoolId = promotionResolvedPoolId !== YOUTUBE_GROWTH_POOL_ID ? promotionResolvedPoolId : undefined;
  const queryTerms = Array.from(new Set(request.observations.flatMap((item) => item.queryTerms))).slice(0, 100);
  const targeting = asRecord(campaign.targetingCriteria);
  const expandedKeywords = (Array.isArray(targeting.expandedKeywords) ? targeting.expandedKeywords : [])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 60);
  const authoritativeLexicon = Array.from(new Set([
    ...policy.criteria.keywords,
    ...expandedKeywords,
    ...policy.criteria.categories,
  ])).slice(0, 100);
  if (request.observations.length === 0) {
    // 관측이 0건이면 외부 호출도 0건이다 — 회계도 0으로 명시한다(누락과 0을 구분한다).
    return {
      candidates: [], canonicalProgramId: scopedContext.canonicalProgramId, policy,
      recencyFiltered: 0, recencyVideoListCalls: 0,
    };
  }
  const recent = await resolveYtdlpPromotionRecentObservations(
    request.observations,
    policy.criteria.recentActivityDays,
    promotionNonGrowthPoolId,
  );
  if (recent.observations.length === 0) {
    return {
      candidates: [],
      canonicalProgramId: scopedContext.canonicalProgramId,
      policy,
      recencyFiltered: recent.recencyFiltered,
      // recency 판정에서 이미 videos.list 를 썼다. 후보가 0이어도 **비용은 발생했다**.
      recencyVideoListCalls: recent.videoListCalls,
    };
  }
  const observedCategories = queryTerms.length > 0 ? queryTerms : policy.criteria.categories;
  const live = await searchYouTubeLive({
    queryRef: `w75:${scopedContext.campaignId}`,
    campaignRef: scopedContext.campaignRef,
    gameId: asString(campaign.gameId) ?? "flu-casual",
    resultLimit: Math.min(recent.observations.length, DISCOVERY_RESULT_LIMIT_MAX),
    countryTargeting: policy.countryTargeting,
    filters: {
      regions: policy.criteria.regions,
      // 이 필드는 기존 search 내부의 임시 category filter용이다. 최종 authoritative 판정은 아래
      // policyData(프로그램 keywords/categories)로 다시 하므로 수동 쿼리가 정책을 확장하지 않는다.
      categories: observedCategories.slice(0, 100),
      categoriesExplicit: policy.criteria.categories.length === 0,
      minFollowers: policy.criteria.minFollowers,
      recentActivityDays: policy.criteria.recentActivityDays,
    },
    discoveryVertical: policy.criteria.discoveryVertical,
    minVideoViews: policy.criteria.minVideoViews,
    minVideoCount: policy.criteria.minVideoCount,
    lexicon: authoritativeLexicon,
    // Flu/W2 (Codex 적대 리뷰 MEDIUM-5 수리): W75 승격 경로도 이 campaign 문서의 org 스탬프가
    // 있으면 그 org 의 풀로 hydration 을 라우팅한다(promotionOwnerOrgId — 위에서 이미 해석).
    ...(promotionOwnerOrgId ? { ownerOrgId: promotionOwnerOrgId } : {}),
  }, undefined, {
    mode: "scoped_snapshot",
    context: scopedContext,
  }, DEFAULT_YOUTUBE_SEARCH_LIVE_DEPENDENCIES, recent.observations);
  if (!live) {
    throw Object.assign(new Error("failed-precondition: W75 YouTube hydration integration is disabled"), {
      code: "failed-precondition",
      errorCode: "ytdlp_promotion_youtube_hydration_disabled",
    });
  }

  const policyData: ParsedYtDlpDiscoveryData = {
    campaignId: scopedContext.campaignId,
    campaignRef: scopedContext.campaignRef,
    gameId: asString(campaign.gameId) ?? "flu-casual",
    keywords: authoritativeLexicon,
    countryTargeting: policy.countryTargeting,
    filters: { ...policy.criteria, categoriesExplicit: true },
    discoveryVertical: policy.criteria.discoveryVertical,
    minVideoViews: policy.criteria.minVideoViews,
    minVideoCount: policy.criteria.minVideoCount,
    resultLimit: Math.min(recent.observations.length, DISCOVERY_RESULT_LIMIT_MAX),
    commentLimit: 0,
    includeComments: false,
    sliceArmSlots: undefined,
    lexicon: policy.criteria.keywords,
  };
  // W77-②: **이메일 마이닝 확장.** 채널 About 에서 못 찾은 후보만, 최신 영상 설명란에서
  //   캔 이메일로 채운다(About 이 있으면 그쪽 우선 — 기존 판정 불변).
  //   추가 API 호출은 0이다: 같은 videos.list 응답의 description 을 쓴다.
  //   emailStatus 는 기존 규칙 그대로 재판정한다(비즈니스 도메인이면 verified, 아니면 guessed).
  const hydrated = live.results.filter((candidate) => candidateMatchesYtDiscovery(candidate, policyData));
  let videoDescriptionEmails = 0;
  const candidates = hydrated.map((candidate) => {
    if (asString(candidate.email)) return candidate;
    const channelId = promotionChannelIdFromCandidate(candidate);
    const mined = recent.emailByChannelId.get(channelId);
    if (!mined) return candidate;
    videoDescriptionEmails += 1;
    // 승격 레인의 설명란은 videos.list **전문**이라 절단 위험이 없다 — 그래도 판정을 값에서 읽는다
    //   (여기서 상수 false 를 쓰면 소스가 바뀌는 날 조용히 틀린다).
    const verified = isBusinessEmail(mined.email) && !mined.truncatedSource;
    return {
      ...candidate,
      email: mined.email,
      emailStatus: (verified ? "verified" : "guessed") as EmailFinderStored["status"],
      emailSource: "video_description",
      emailSourceKind: (mined.truncatedSource ? "search_snippet" : "video_description") as EmailSourceKind,
    };
  });
  return {
    candidates,
    canonicalProgramId: scopedContext.canonicalProgramId,
    policy,
    recencyFiltered: recent.recencyFiltered,
    hydrationOverflow: live.hydrationOverflow,
    // W75-R1 P1-4: 종전에는 여기서 cost 를 통째로 버렸다 — 승격이 쓴 YouTube 유닛이
    //   어느 원장에도 남지 않았다. 다른 호출자와 같은 형상으로 그대로 흘린다.
    cost: live.cost,
    recencyVideoListCalls: recent.videoListCalls,
    /** W77-②: 영상 설명란에서 새로 캔 이메일 수 — 해소율 개선 효과의 관측축이다. */
    videoDescriptionEmails,
    /**
     * W84: 이번 hydration 이 **이미 받아온** 설명란 맵. 기존 무이메일 후보 보충이 재사용한다 —
     *   안 넘기면 호출부가 같은 videos.list 를 다시 때린다(COST 규율 위반).
     */
    descriptionByVideoId: recent.descriptionByVideoId,
  };
}

/** W75: 이메일까지 dedup 된 후보만 기존 프로그램 후보 writer로 넘긴다. */
export async function persistYtdlpPromotionCandidates(input: {
  campaignId: string;
  canonicalProgramId: string;
  promotionRunId: string;
  candidates: readonly CandidateResult[];
}): Promise<CandidatePersistCounts> {
  const sourceRunRef = `discovery_runs/${input.promotionRunId}`;
  const provenance: CandidateDiscoveryProvenance = {
    ...buildScopedCampaignDiscoveryContext(input.canonicalProgramId, input.campaignId),
    sourceRunId: input.promotionRunId,
    sourceRunRef,
  };
  return persistCandidates(
    stampCandidateDiscoveryProvenance([...input.candidates], provenance),
    "ytdlp-promotion",
    CANDIDATE_SOURCE_PURPOSE.PROGRAM_CANDIDATE,
  );
}

/**
 * R16-2: 잡 문서까지만 만들고 **인라인 프리뷰 검색(외부 API)을 건너뛴다**.
 *
 * 이 함수는 원래 사람이 화면에서 누르는 경로라, 눌렀을 때 바로 결과를 보여주려고 잡 생성 후
 * `searchYouTubeLive` 를 동기 대기한다. 그런데 자동 스윕(campaign auto-approval)에서 부르면 그 대기가
 * **승인 청크·발송 패스보다 앞**에 놓이고 캠페인 최대 20개를 순차로 도는 루프 안이라, 외부 API 지연이
 * 그대로 발송 지연이 된다(스케줄러 540s 한도, 타임아웃 가드 없음).
 * 큐에 넣기만 하면 기존 `processDiscoveryQueue` 5분 워커가 materialize 한다 — 그게 그 워커의 용도다.
 */
export type QueueYtDlpDiscoveryOptions = { deferPreviewMaterialization?: boolean };

export async function queueYtDlpDiscovery(
  request: CallableRequest,
  options: QueueYtDlpDiscoveryOptions = {},
) {
  assertViewAsReadOnlyPayload("queueYtDlpDiscovery", request.data);
  const context = requireDiscoveryWriteRole(request, "YouTube discovery queue");
  const accountScope = await resolveAccountOwnershipScopeForRequest(request as CallableRequestShape, "discovery.queueYtDlp", ["super_admin", "admin", "manager"]);
  assertWritableAccountOwnershipScope(accountScope, "discovery.queueYtDlp");
  const data = readYtDlpDiscoveryData(request.data);
  // R23-2b: 쿼리 슬라이스 원장의 키. 호출부(enqueueShortfallDiscoveryJob)가 큐잉 시점에 계산해 넘긴다 —
  // 이 함수는 그 값을 그대로 잡/런 문서에 실어 완료 시점에 같은 슬라이스로 되찾을 수 있게만 한다
  // (파서를 거치지 않는 이유: 이 필드는 discovery 자체의 검색 파라미터가 아니라 admin.ts 의 원장
  // 키이므로 ParsedYtDlpDiscoveryData 스키마를 넓힐 필요가 없다).
  const sliceHash = asString(asRecord(request.data).sliceHash);
  const requestRecord = asRecord(request.data);
  const requestedProgramId = resolveCanonicalProgramId(requestRecord.programId)
    || resolveCanonicalProgramId(asString(requestRecord.programPolicyRef)?.split("/").pop());
  const scopedContext = await resolveAuthoritativeDiscoveryCampaignContext(
    data.campaignId,
    data.campaignRef,
    context,
    "YouTube discovery campaign",
    requestedProgramId,
  );
  const accountOwnership = await resolveDiscoveryAuthorityOwnership(scopedContext, accountScope, "YouTube discovery campaign");
  return queueYtDlpDiscoveryWithAuthority({
    context,
    data,
    sliceHash,
    scopedContext,
    accountOwnership,
    options,
  });
}

type QueueYtDlpDiscoveryAuthority = {
  context: GuardContext;
  data: ParsedYtDlpDiscoveryData;
  sliceHash?: string;
  scopedContext: ScopedCampaignDiscoveryContext | null;
  accountOwnership: AccountOwnershipStamp;
  options: QueueYtDlpDiscoveryOptions;
  // This capability is constructed only by the server-owned shortfall producer below.  It is
  // deliberately absent from ParsedYtDlpDiscoveryData, so callable request data cannot choose it.
  scheduledShortfallAuthority?: ScopedCampaignDiscoveryContext;
};

const SCHEDULED_SHORTFALL_AUTHORITY_KIND = "scheduled_campaign_shortfall";
const SCHEDULED_SHORTFALL_AUTHORITY_VERSION = 1;

function scheduledShortfallAuthorityMarker(
  context: ScopedCampaignDiscoveryContext,
  runId: string,
  runRef: string,
  jobRef: string,
) {
  return {
    kind: SCHEDULED_SHORTFALL_AUTHORITY_KIND,
    version: SCHEDULED_SHORTFALL_AUTHORITY_VERSION,
    runId,
    runRef,
    jobRef,
    type: "yt_dlp_discovery",
    campaignId: context.campaignId,
    campaignRef: context.campaignRef,
    canonicalProgramId: context.canonicalProgramId,
    programRef: context.programRef,
  };
}

function assertScheduledShortfallAuthorityMarkers(
  job: { id: string; ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> },
  runRef: FirebaseFirestore.DocumentReference,
  runDocumentData: Record<string, unknown>,
): boolean {
  const jobHasMarker = Object.prototype.hasOwnProperty.call(job.data, "scheduledShortfallAuthority");
  const runHasMarker = Object.prototype.hasOwnProperty.call(runDocumentData, "scheduledShortfallAuthority");
  if (!jobHasMarker && !runHasMarker) return false;
  const jobMarker = asRecord(job.data.scheduledShortfallAuthority);
  const runMarker = asRecord(runDocumentData.scheduledShortfallAuthority);
  const context = buildScopedCampaignDiscoveryContext(
    resolveCanonicalProgramId(runDocumentData.canonicalProgramId) || resolveCanonicalProgramId(runDocumentData.programId),
    asString(runDocumentData.campaignId) ?? "",
  );
  const expected = context.campaignId
    ? scheduledShortfallAuthorityMarker(context, job.id, runRef.path, job.ref.path)
    : null;
  if (
    !expected
    || !jobHasMarker
    || !runHasMarker
    || Object.entries(expected).some(([key, value]) => jobMarker[key] !== value)
    || Object.entries(expected).some(([key, value]) => runMarker[key] !== value)
    || Object.keys(jobMarker).length !== Object.keys(expected).length
    || Object.keys(runMarker).length !== Object.keys(expected).length
    || asString(runDocumentData.campaignRef) !== expected.campaignRef
    || asString(runDocumentData.programRef) !== expected.programRef
    || asString(job.data.type) !== expected.type
  ) {
    throw Object.assign(new Error("failed-precondition: scheduled discovery authority marker is invalid"), {
      code: "failed-precondition", errorCode: "materialized_scheduled_discovery_authority_marker_invalid",
    });
  }
  return true;
}

// The document-writing core has no callable request.  Public callers reach it only after the
// normal role, viewAs, verified-email, and ownership checks above; scheduled producers resolve
// the same exact campaign/program authority before constructing this input.
async function queueYtDlpDiscoveryWithAuthority(input: QueueYtDlpDiscoveryAuthority) {
  const { context, data, sliceHash, scopedContext, accountOwnership, options, scheduledShortfallAuthority } = input;
  const sliceArmSlots = data.sliceArmSlots;
  const countryTargeting = await resolveQueuedCountryTargeting(data.countryTargeting, scopedContext);
  const queuedAtIso = new Date().toISOString();
  const runId = `ytdlp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const runRef = adminDb.collection("discovery_runs").doc(runId);
  const jobRef = adminDb.collection("workflow_jobs").doc(runId);
  const provenance = scopedContext
    ? { ...scopedContext, ...accountOwnership, sourceRunId: runId, sourceRunRef: runRef.path }
    : null;
  const scheduledShortfallMarker = scheduledShortfallAuthority
    ? scheduledShortfallAuthorityMarker(scheduledShortfallAuthority, runId, runRef.path, jobRef.path)
    : null;
  const queryPlan = data.keywords.map((keyword) => ({
    keyword,
    search: `ytsearch${data.resultLimit}:${keyword} #shorts`,
    dateAfterDays: data.filters.recentActivityDays,
    preferredSort: "upload_date",
  }));
  const ytDlpOptions = {
    extract_flat: true,
    skip_download: true,
    quiet: true,
    no_warnings: true,
    dump_single_json: true,
  };
  const commentOptions = {
    enabled: data.includeComments,
    perVideoCap: data.commentLimit,
    commandTemplate: "yt-dlp --skip-download --write-comments -J <videoUrl>",
  };
  const dedupePolicy = {
    primaryKeys: ["channel_id", "channel_url", "video_id", "email"],
    // W115 A2 [죽은 라벨 제거]: 종전 `skipKnownChannels: true` 는 **소비자가 없는 라벨**이었다 —
    //   어떤 코드도 읽지 않는데 "이미 아는 채널은 건너뛴다"고 선언해 읽는 사람에게 구현된 기능처럼
    //   보였다. 지금은 실제로 동작한다: hydration 직전 candidate_pool doc-id 대조
    //   (searchYouTubeLive → partitionHydrationTargets). 참/거짓 불명인 불리언 대신 **어디서 강제되고
    //   어떤 창으로 재방문하는지**를 값으로 적는다 — 라벨이 아니라 계약이라야 나중에 검증된다.
    knownChannelSkip: {
      enforcedBy: "searchYouTubeLive.partitionHydrationTargets",
      emailKnown: "permanent",
      emailNoneRevisitMs: KNOWN_CHANNEL_EMAIL_NONE_REVISIT_MS,
    },
    keepNewVideoActivityForKnownPartners: true,
    sourceFingerprintCollection: "source_fingerprints",
  };

  const batch = adminDb.batch();
  batch.set(runRef, {
    id: runId,
    engine: "yt-dlp",
    status: "queued",
    ...(scopedContext ?? {}),
    ...accountOwnership,
    ...(scheduledShortfallMarker ? { scheduledShortfallAuthority: scheduledShortfallMarker } : {}),
    campaignId: data.campaignId ?? null,
    campaignRef: data.campaignRef,
    gameId: data.gameId,
    discoveryVertical: data.discoveryVertical,
    minVideoViews: data.minVideoViews,
    minVideoCount: data.minVideoCount,
    // HIGH-1 [운영 실측: job ytdlp_ms72zn80_iktqgz] — 이전에는 이 문서에 실검색 키워드가 전혀
    // 실리지 않았다(queryPlan 은 검색어를 담고 있어도 존재하지 않는 yt-dlp 워커 라벨용이라 읽는
    // 코드가 없었다). materializeYtDiscoveryRun 이 이 문서를 다시 읽어 readYtDlpDiscoveryData 로
    // 재파싱할 때 record.keywords 가 없으면 하드코딩 기본 3개로 떨어졌다 — 여기 싣는 것이 그 재파싱의
    // 유일한 근거다.
    keywords: data.keywords,
    ...(sliceHash ? { sliceHash } : {}),
    ...(sliceArmSlots ? { sliceArmSlots } : {}),
    ...(data.lexicon.length > 0 ? { lexicon: data.lexicon } : {}),
    queryPlan,
    countryTargeting,
    filters: {
      ...data.filters,
      // R23-2c: region 은 이제 두 소스를 가질 수 있다 — 크리에이터 국가 판정과 무관한 **검색
      // 다양화 힌트**(caller 가 명시적으로 채운 data.filters.regions, 예: admin.ts 의 회전 축)를
      // 우선하고, 호출부가 아무것도 안 주면(기존 모든 호출부가 그렇다) 종전대로
      // countryTargeting.includedCountries 로 폴백한다 — 하위 호환.
      regions: data.filters.regions.length > 0
        ? data.filters.regions
        : (countryTargeting.countryScope === "include" ? countryTargeting.includedCountries : []),
    },
    resultLimit: data.resultLimit,
    commentLimit: data.commentLimit,
    includeComments: data.includeComments,
    counters: {
      scanned: 0,
      excludedByIncludedCountries: 0,
      excludedByExplicitCountry: 0,
      unknownCountryHeld: 0,
      candidatesWritten: 0,
      emailReady: 0,
      kpiRemaining: data.resultLimit,
      scannedVideos: 0,
      discoveredChannels: 0,
      skippedKnownChannels: 0,
      commentsCollected: 0,
      emailsFound: 0,
    },
    dedupePolicy,
    worker: "cloud-run-job/yt-dlp-worker",
    queuedAtIso,
    retryAfterIso: queuedAtIso,
    createdAt: FieldValue.serverTimestamp(),
    expireAt: expireAt180DaysFromIso(queuedAtIso),
    createdBy: context.userId,
    createdByRole: context.role,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  batch.set(jobRef, {
    id: runId,
    type: "yt_dlp_discovery",
    engine: "yt-dlp",
    status: "queued",
    runRef: runRef.path,
    ...(scopedContext ?? {}),
    ...accountOwnership,
    ...(scheduledShortfallMarker ? { scheduledShortfallAuthority: scheduledShortfallMarker } : {}),
    campaignRef: data.campaignRef,
    gameId: data.gameId,
    discoveryVertical: data.discoveryVertical,
    minVideoViews: data.minVideoViews,
    minVideoCount: data.minVideoCount,
    // HIGH-1: run 문서와 같은 이유로 job 문서에도 싣는다 — 두 문서 모두 readYtDlpDiscoveryData 의
    // 재파싱 입력이 될 수 있다(processDiscoveryQueue 가 어느 쪽을 넘기든 폴백이 재발하지 않아야 한다).
    keywords: data.keywords,
    ...(sliceHash ? { sliceHash } : {}),
    ...(sliceArmSlots ? { sliceArmSlots } : {}),
    ...(data.lexicon.length > 0 ? { lexicon: data.lexicon } : {}),
    countryTargeting,
    resultLimit: data.resultLimit,
    worker: "cloud-run-job/yt-dlp-worker",
    commandPlan: {
      metadataCommand: "yt-dlp --skip-download --flat-playlist -J <ytsearch>",
      commentCommand: commentOptions.commandTemplate,
      pythonOptions: ytDlpOptions,
      queries: queryPlan,
      countryTargeting,
    },
    commentOptions,
    dedupePolicy,
    rateLimit: {
      maxConcurrentSearches: 2,
      maxConcurrentCommentFetches: 1,
      backoff: "exponential",
    },
    queuedAtIso,
    retryAfterIso: queuedAtIso,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  if (data.campaignId) {
    batch.set(adminDb.collection("campaigns").doc(data.campaignId), {
      ytDlpWorkflow: {
        status: "queued",
        runRef: runRef.path,
        jobRef: jobRef.path,
        queuedAtIso,
        keywords: data.keywords,
        includeComments: data.includeComments,
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  await batch.commit();

  let previewMaterialization: {
    status: "skipped" | "complete" | "error";
    candidatesWritten: number;
    reason?: string;
  } = { status: liveIntegrationsEnabled("youtube") ? "skipped" : "skipped", candidatesWritten: 0, reason: liveIntegrationsEnabled("youtube") ? "not_started" : "youtube_live_disabled" };
  // R16-2: 자동 스윕 호출은 잡 생성까지만 하고 즉시 돌아간다(외부 API 대기 0). 큐는 5분 워커가 문다.
  if (options.deferPreviewMaterialization) {
    previewMaterialization = { status: "skipped", candidatesWritten: 0, reason: "deferred_to_discovery_queue_worker" };
    // 지연 사실을 문서에도 남긴다 — 남기지 않으면 운영자에게는 "아직 아무 일도 안 일어난 잡"과
    // 구분되지 않는다(조용한 대기). 검색·적재는 5분 워커가 한다.
    await Promise.all([
      runRef.set({ previewMaterialization, updatedAt: FieldValue.serverTimestamp() }, { merge: true }),
      jobRef.set({ previewMaterialization, updatedAt: FieldValue.serverTimestamp() }, { merge: true }),
    ]);
  } else if (liveIntegrationsEnabled("youtube")) {
    try {
      const live = await searchYouTubeLive({
        queryRef: runId,
        campaignRef: data.campaignRef,
        gameId: data.gameId,
        resultLimit: data.resultLimit,
        filters: {
          regions: countryTargeting.countryScope === "include" ? countryTargeting.includedCountries : [],
          categories: Array.from(new Set([...data.filters.categories, ...data.keywords])).slice(0, data.discoveryVertical === "ai_drama" ? 40 : 12),
          categoriesExplicit: data.filters.categoriesExplicit || data.keywords.length === 0,
          minFollowers: data.filters.minFollowers,
          recentActivityDays: data.filters.recentActivityDays,
        },
        countryTargeting,
        discoveryVertical: data.discoveryVertical,
        minVideoViews: data.minVideoViews,
        minVideoCount: data.minVideoCount,
        // Flu/W2: this is the non-deferred (immediate) preview materialization branch of
        // queueYtDlpDiscovery — thread the same accountOwnership.ownerOrgId the batch write above
        // already stamps, so an org-scoped test run (e.g. T049) bills its own pool.
        ...(asString(accountOwnership.ownerOrgId) ? { ownerOrgId: asString(accountOwnership.ownerOrgId) } : {}),
      }, undefined, {
        mode: "global_candidate_pool",
        source: "youtube-data-api",
        ...(provenance ? { provenance } : {}),
      });
      previewMaterialization = {
        status: "complete",
        candidatesWritten: live?.results.length ?? 0,
      };
      if (live) {
        await runRef.set({
          candidateSnapshot: discoveryCandidateSnapshot(live.results),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    } catch (error) {
      previewMaterialization = {
        status: "error",
        candidatesWritten: 0,
        reason: error instanceof Error ? error.message : "youtube_preview_failed",
      };
    }
    await runRef.set({
      previewMaterialization,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await jobRef.set({
      previewMaterialization,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  const cost = costLog("yt-dlp-worker", "yt-dlp", 0);
  return {
    ok: true,
    runId,
    runRef: runRef.path,
    jobRef: jobRef.path,
    status: "queued",
    worker: "cloud-run-job/yt-dlp-worker",
    countryTargeting,
    queryPlan,
    ytDlpOptions,
    commentOptions,
    dedupePolicy,
    previewMaterialization,
    costLog: cost,
    behaviorLog: behaviorLog(context, data.gameId, "queueYtDlpDiscovery", "success", cost.estimatedUsd),
  };
}

/**
 * Server-only producer for a scheduled campaign shortfall.  It accepts no CallableRequest and
 * resolves both the campaign/program relation and its durable ownership stamp from Firestore
 * before reaching the queue writer.  Keep it out of Functions exports: user-controlled request
 * data must continue through queueYtDlpDiscovery's verified-email boundary.
 */
export async function queueScheduledCampaignYtDlpDiscovery(input: {
  campaignId: string;
  data: Record<string, unknown>;
  actorUserId: string;
  actorRole: Exclude<Role, "guest">;
  deferPreviewMaterialization?: boolean;
}) {
  const campaignId = input.campaignId.trim();
  const rawData = asRecord(input.data);
  if (!campaignId || asString(rawData.campaignId) !== campaignId || asString(rawData.campaignRef) !== `campaigns/${campaignId}`) {
    throw Object.assign(new Error("failed-precondition: scheduled discovery requires an exact campaign scope"), {
      code: "failed-precondition",
      errorCode: "queue_scheduled_campaign_ytdlp_discovery_raw_scope_missing",
    });
  }
  const data = readYtDlpDiscoveryData(rawData);
  const requestedProgramId = resolveCanonicalProgramId(rawData.programId)
    || resolveCanonicalProgramId(asString(rawData.programPolicyRef)?.split("/").pop());
  const scopedContext = await resolveAuthoritativeDiscoveryCampaignContext(
    campaignId,
    `campaigns/${campaignId}`,
    undefined,
    "scheduled campaign discovery",
    requestedProgramId,
  );
  if (!scopedContext) {
    throw Object.assign(new Error("failed-precondition: scheduled discovery requires an exact campaign scope"), {
      code: "failed-precondition",
      errorCode: "queue_scheduled_campaign_ytdlp_discovery_resolved_scope_missing",
    });
  }
  const accountOwnership = await resolveScheduledCampaignDiscoveryAuthorityOwnership(
    scopedContext,
    "scheduled campaign discovery",
  );
  return queueYtDlpDiscoveryWithAuthority({
    context: {
      userId: input.actorUserId,
      role: input.actorRole,
      team: "system",
      ip: "0.0.0.0",
    },
    data,
    sliceHash: asString(rawData.sliceHash),
    scopedContext,
    accountOwnership,
    scheduledShortfallAuthority: scopedContext,
    options: { deferPreviewMaterialization: input.deferPreviewMaterialization === true },
  });
}

const DISCOVERY_TERMINAL_STATUSES = new Set(["complete", "partial", "partial_failure", "failed", "dead_letter"]);

function discoveryRunFunnelCounters(value: unknown): Record<string, number> {
  const counters = asRecord(value);
  const number = (key: string, fallbackKey?: string) => Math.max(
    0,
    Math.trunc(asNumber(counters[key]) ?? (fallbackKey ? asNumber(counters[fallbackKey]) : undefined) ?? 0),
  );
  return {
    scanned: number("scanned", "recordsReceived"),
    excludedByIncludedCountries: number("excludedByIncludedCountries"),
    excludedByExplicitCountry: number("excludedByExplicitCountry"),
    unknownCountryHeld: number("unknownCountryHeld"),
    candidatesWritten: number("candidatesWritten", "discoveredChannels"),
    emailReady: number("emailReady", "emailsFound"),
    kpiRemaining: number("kpiRemaining"),
  };
}

function discoveryRunErrorEvidence(run: Record<string, unknown>): {
  code: string | null;
  message: string | null;
  errors: Array<{ index?: number; reason: string }>;
} {
  const rawErrors = Array.isArray(run.errors) ? run.errors : [];
  return {
    code: asString(run.failureCode) ?? asString(run.errorCode) ?? null,
    message: (asString(run.error) ?? asString(run.lastError) ?? null)?.slice(0, 500) ?? null,
    errors: rawErrors.slice(0, 20).flatMap((value) => {
      const record = asRecord(value);
      const reason = asString(record.reason) ?? asString(record.message);
      if (!reason) return [];
      const index = asNumber(record.index);
      return [{
        ...(index === undefined ? {} : { index: Math.max(0, Math.trunc(index)) }),
        reason: reason.slice(0, 300),
      }];
    }),
  };
}

export async function getDiscoveryRunStatus(request: CallableRequest) {
  const context = assertRole(request);
  const data = asRecord(request.data);
  const runId = asString(data.runId) ?? "";
  if (!/^[A-Za-z0-9_-]{1,180}$/.test(runId)) {
    throw Object.assign(new Error("invalid-argument: discovery runId is required"), { code: "invalid-argument", errorCode: "get_discovery_run_status_discovery_run_id_required" });
  }
  const runSnapshot = await adminDb.collection("discovery_runs").doc(runId).get();
  if (!runSnapshot.exists) {
    throw Object.assign(new Error("not-found: discovery run not found"), { code: "not-found", errorCode: "get_discovery_run_status_discovery_run_found" });
  }
  const run = runSnapshot.data() ?? {};
  if (context.role !== "super_admin" && context.role !== "admin") {
    if (context.role !== "manager") {
      throw permissionDenied("discovery run status requires an owner or admin role");
    }
    const runOwners = mutationOwnerUids(run, { includeCreatedBy: true });
    let allowed = runOwners.length === 1 && runOwners[0] === context.userId;
    const campaignId = asString(run.campaignId);
    if (!allowed && campaignId) {
      const campaignSnapshot = await adminDb.collection("campaigns").doc(campaignId).get();
      const campaignOwners = mutationOwnerUids(campaignSnapshot.data() ?? {}, { includeCreatedBy: true });
      allowed = campaignOwners.length === 1 && campaignOwners[0] === context.userId;
    }
    if (!allowed) {
      throw permissionDenied("discovery run ownership is missing, ambiguous, or belongs to another account");
    }
  }
  const status = asString(run.status) ?? "unknown";
  return {
    ok: true,
    runId,
    runRef: runSnapshot.ref.path,
    engine: asString(run.engine) ?? "unknown",
    status,
    terminal: DISCOVERY_TERMINAL_STATUSES.has(status),
    terminalStatus: asString(run.terminalStatus) ?? (DISCOVERY_TERMINAL_STATUSES.has(status) ? status : null),
    queuedAtIso: asString(run.queuedAtIso) ?? null,
    startedAtIso: asString(run.startedAtIso) ?? null,
    completedAtIso: asString(run.completedAtIso) ?? asString(run.failedAtIso) ?? null,
    countryTargeting: resolveCountryTargeting(readDiscoveryCountryTargeting(run)),
    counters: discoveryRunFunnelCounters(run.counters),
    errorEvidence: discoveryRunErrorEvidence(run),
  };
}

// R5-A(RA-6) 캠페인 등록 자동 discovery — S2S 코어 트리거. queueYtDlpDiscovery(콜러블, assertRole)와
// 달리 서버 내부(createCampaign)에서 직접 호출되므로 CallableRequest/사용자 인증이 필요 없다.
// 캠페인당 최대 N은 settings/default.automation.campaignAutoDiscoveryResultCap(Q2 디폴트 50, 비용 방어)에서 읽는다. 결과는 discovery_runs/{runId}에만 감사용으로 남기고
// **전역 candidate_pool에는 쓰지 않는다** — 전역 collectCampaignTargets 재사용/과거 후보 혼입을
// 원천 차단(RA-6 scope 한정). 호출자(admin.ts createCampaign)가 반환된 candidates를 직접
// CampaignTarget으로 변환해 자신의 queued_for_review 파이프라인에 태우므로, 자동 approve/발송
// 경로는 존재하지 않는다(ADR-3 격리 — createCampaign은 항상 safety.allowed 여부로만
// queued_for_review/blocked를 정하고 절대 "approved"를 직접 쓰지 않는다).
export const DEFAULT_CAMPAIGN_AUTO_DISCOVERY_RESULT_CAP = 50;
export const MAX_CAMPAIGN_AUTO_DISCOVERY_RESULT_CAP = 1_000;

/**
 * Synthetic creator fixtures are a local emulator aid only. A hosted runtime
 * must expose an unavailable discovery engine as an honest empty/failed run;
 * substituting fixture creators would make them indistinguishable from real
 * program-scoped candidates in the review pipeline.
 */
export function discoveryFixtureFallbackAllowed(
  environment: RuntimeEnvironmentSource = process.env,
): boolean {
  try {
    return isDemoFixtureRuntimeAllowed(environment);
  } catch {
    return false;
  }
}

export function scopedCampaignDiscoveryFixtureFallbackAllowed(
  environment: RuntimeEnvironmentSource = process.env,
): boolean {
  return discoveryFixtureFallbackAllowed(environment);
}

function discoveryUnavailable(engine: "youtube" | "email" | "community"): Error {
  return Object.assign(
    new Error(`discovery_live_unavailable: ${engine} engine returned no live result`),
    { code: "unavailable", errorCode: "discovery_unavailable_discovery_live_unavailable_engine_returned" },
  );
}

function candidateFixtureRecord(candidate: CandidateResult): Record<string, unknown> {
  const candidateRef = asString(candidate.candidateRef) ?? "";
  const id = candidateRef.split("/").filter(Boolean).at(-1) ?? "";
  return { ...candidate, id };
}

function withoutHostedFixtureCandidates(results: CandidateResult[]): CandidateResult[] {
  if (discoveryFixtureFallbackAllowed()) return results;
  return results.filter((candidate) => !isOperationalFixtureRecord(candidateFixtureRecord(candidate), "candidate_pool"));
}

export async function readCampaignAutoDiscoveryResultCap(): Promise<number> {
  const settings = await readSettings();
  const automation = (settings.automation ?? {}) as Record<string, unknown>;
  return boundedInt(
    automation.campaignAutoDiscoveryResultCap,
    DEFAULT_CAMPAIGN_AUTO_DISCOVERY_RESULT_CAP,
    1,
    MAX_CAMPAIGN_AUTO_DISCOVERY_RESULT_CAP,
  );
}

export type ScopedCampaignDiscoveryResult = {
  runId: string;
  runRef: string;
  jobRef: string;
  source: string;
  canonicalProgramId: string;
  programId: string;
  programRef: string;
  campaignId: string;
  campaignRef: string;
  candidates: CandidateResult[];
};

export async function triggerScopedCampaignDiscovery(params: {
  campaignId: string;
  programId?: string;
  programPolicyRef?: string;
  candidateCriteriaSnapshot?: Record<string, unknown>;
  eligibilityCriteriaSnapshot?: Record<string, unknown>;
  gameId: string;
  keywords: string[];
  categories: string[];
  excludeKeywords: string[];
  countryTargeting?: CountryTargeting;
  regions: string[];
  minFollowers: number;
  maxFollowers: number;
  recentActivityDays: number;
  actorUserId: string;
  actorRole: string;
  resultCap?: number;
  backfillExistingPool?: boolean;
  publicWebBackfillOnly?: boolean;
  persistScopedResults?: boolean;
}): Promise<ScopedCampaignDiscoveryResult> {
  const queuedAtIso = new Date().toISOString();
  const runId = `campaign_auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const runRef = adminDb.collection("discovery_runs").doc(runId);
  const jobRef = adminDb.collection("workflow_jobs").doc(runId);
  const scopedContext = await resolveAuthoritativeDiscoveryCampaignContext(
    params.campaignId,
    `campaigns/${params.campaignId}`,
    undefined,
    "scheduled campaign discovery",
    params.programId,
  );
  if (!scopedContext) {
    throw Object.assign(new Error("failed-precondition: scheduled campaign discovery requires exact campaign scope"), {
      code: "failed-precondition", errorCode: "trigger_scoped_campaign_discovery_missing_scope",
    });
  }
  const accountOwnership = await resolveDiscoveryAuthorityOwnership(scopedContext, undefined, "scheduled campaign discovery");
  const { campaignRef } = scopedContext;
  const resultCap = boundedInt(params.resultCap, await readCampaignAutoDiscoveryResultCap(), 1, MAX_CAMPAIGN_AUTO_DISCOVERY_RESULT_CAP);

  const data = readYtDlpDiscoveryData({
    campaignId: params.campaignId,
    campaignRef,
    gameId: params.gameId,
    keywords: params.keywords,
    ...(params.countryTargeting ? { countryTargeting: params.countryTargeting } : {}),
    filters: {
      regions: params.regions,
      categories: params.categories,
      excludeKeywords: params.excludeKeywords,
      minFollowers: params.minFollowers,
      maxFollowers: params.maxFollowers,
      recentActivityDays: params.recentActivityDays,
    },
    discoveryVertical: params.candidateCriteriaSnapshot?.discoveryVertical,
    minVideoViews: params.candidateCriteriaSnapshot?.minVideoViews,
    minVideoCount: params.candidateCriteriaSnapshot?.minVideoCount,
    candidateCriteriaSnapshot: params.candidateCriteriaSnapshot,
    resultLimit: resultCap,
  });
  const cacheKey = scopedCampaignDiscoveryCacheKey(scopedContext, data);
  const cache = await cacheLookup(cacheKey, DISCOVERY_CACHE_TTL_SECONDS);
  const cachedResults = cache.status === "hit"
    ? (readScopedCampaignDiscoveryCacheCandidates(cache.value, scopedContext)?.filter((candidate) => candidateMatchesYtDiscovery(candidate, data)) ?? null)
    : null;
  const programPolicySnapshot = {
    ...(params.programPolicyRef ? { programPolicyRef: params.programPolicyRef } : {}),
    ...(params.candidateCriteriaSnapshot ? { candidateCriteriaSnapshot: params.candidateCriteriaSnapshot } : {}),
    ...(params.eligibilityCriteriaSnapshot ? { eligibilityCriteriaSnapshot: params.eligibilityCriteriaSnapshot } : {}),
  };

  await Promise.all([
    runRef.set({
      id: runId,
      engine: "yt-dlp",
      status: "queued",
      trigger: "campaign_auto_discovery",
      ...scopedContext,
      ...accountOwnership,
      gameId: data.gameId,
      countryTargeting: data.countryTargeting,
      filters: data.filters,
      resultLimit: data.resultLimit,
      discoveryVertical: data.discoveryVertical,
      minVideoViews: data.minVideoViews,
      minVideoCount: data.minVideoCount,
      scopeCap: resultCap,
      cacheKey,
      ...programPolicySnapshot,
      queuedAtIso,
      createdAt: FieldValue.serverTimestamp(),
      expireAt: expireAt180DaysFromIso(queuedAtIso),
      createdBy: params.actorUserId,
      createdByRole: params.actorRole,
      updatedAt: FieldValue.serverTimestamp(),
    }),
    jobRef.set({
      id: runId,
      type: "campaign_auto_discovery",
      engine: "yt-dlp",
      status: "queued",
      runRef: runRef.path,
      ...scopedContext,
      ...accountOwnership,
      gameId: data.gameId,
      countryTargeting: data.countryTargeting,
      cacheKey,
      ...programPolicySnapshot,
      queuedAtIso,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }),
  ]);

  // Reuse the campaign's saved criteria to advance email enrichment through the
  // existing candidate pool before requesting more channels. Each pass fetches at
  // most PUBLIC_WEB_EMAIL_BACKFILL_FETCH_LIMIT public pages and records attempts, so
  // later scheduled refill passes naturally move on instead of replaying a hand-made
  // keyword list or getting stuck on the newest rows.
  let backfilledResults: CandidateResult[] = [];
  if (params.backfillExistingPool === true) {
    try {
      const backfill = await publicWebBackfillExistingCandidateEmails(
        data,
        Date.now() + PUBLIC_WEB_EMAIL_BACKFILL_DEADLINE_MS,
        params.persistScopedResults === true ? false : true,
        asString(accountOwnership.ownerOrgId),
      );
      backfilledResults = backfill.results;
    } catch (error) {
      console.warn("[scoped-campaign-discovery] candidate email backfill failed", {
        runId,
        messageHash: createHash("sha256")
          .update(error instanceof Error ? error.message : String(error))
          .digest("hex")
          .slice(0, 16),
      });
    }
  }

  let results: CandidateResult[];
  let source: string;
  let completionStatus: "complete" | "partial" | "failed" = "complete";
  let failureCode = "";
  let truncatedByQuota = false;
  // W42 F-1: 프로드 failed 386건 중 380건이 이 경로다(youtube_live_request_failed·candidateSnapshot 0행).
  let harvestPartial: YoutubeSearchHarvestPartial | undefined;
  if (params.publicWebBackfillOnly === true) {
    results = [];
    source = "youtube-public-web-email-backfill";
  } else if (cachedResults !== null) {
    results = cachedResults.map((candidate) => ({
      ...candidate, discoverySource: "cache_hit", sourceFetchedAt: new Date().toISOString(),
    }));
    source = "youtube-program-cache";
  } else {
    try {
      if (liveIntegrationsEnabled("youtube")) {
        const live = await searchYouTubeLive({
          queryRef: runId,
          campaignRef,
          gameId: data.gameId,
          resultLimit: data.resultLimit,
          countryTargeting: data.countryTargeting,
          filters: {
            ...data.filters,
            categories: Array.from(new Set([...data.filters.categories, ...data.keywords])).slice(0, data.discoveryVertical === "ai_drama" ? 40 : 12),
            categoriesExplicit: data.filters.categoriesExplicit || data.keywords.length === 0,
          },
          discoveryVertical: data.discoveryVertical,
          minVideoViews: data.minVideoViews,
          minVideoCount: data.minVideoCount,
          // Flu/W2: threads the same accountOwnership.ownerOrgId the run/job docs above already
          // stamp, so a T049-owned campaign's discovery search bills the org's own pool (drama_1)
          // instead of growth's key rotation.
          ...(asString(accountOwnership.ownerOrgId) ? { ownerOrgId: asString(accountOwnership.ownerOrgId) } : {}),
        }, undefined, { mode: "scoped_snapshot", context: scopedContext });
        if (live?.primaryLaneSkipped) {
          // 헤세 결정(2026-09-27) 코덱스 라운드1 HIGH-3 수리: 이 패스는 search.list 를 아예 안
          // 불렀다(승인된 ai_drama 캠페인) — 실검색 0건처럼 캐시하거나 partial/failed 로 잘못
          // 표기하면 승인 철회 뒤에도 캐시 TTL 동안 빈 결과가 굳고, "검색했다"는 거짓 흔적이 남는다.
          results = [];
          source = "ytdlp-primary-lane-skip";
        } else if (live) {
          results = live.results;
          source = "youtube-data-api";
          truncatedByQuota = live.truncatedByQuota === true;
          harvestPartial = live.harvestPartial;
          if (truncatedByQuota || harvestPartial) completionStatus = "partial";
          await cacheStore(cacheKey, "youtube", campaignRef, DISCOVERY_CACHE_TTL_SECONDS, {
            canonicalProgramId: scopedContext.canonicalProgramId,
            campaignId: scopedContext.campaignId,
            results,
          });
        } else if (scopedCampaignDiscoveryFixtureFallbackAllowed()) {
          results = mockDiscoveryResults(data);
          source = "mock-campaign-auto-discovery";
        } else {
          results = [];
          source = "youtube-live-unavailable";
          completionStatus = "failed";
          failureCode = "youtube_live_unavailable";
        }
      } else if (scopedCampaignDiscoveryFixtureFallbackAllowed()) {
        results = mockDiscoveryResults(data);
        source = "mock-campaign-auto-discovery";
      } else {
        results = [];
        source = "youtube-live-unavailable";
        completionStatus = "failed";
        failureCode = "youtube_live_disabled";
      }
    } catch (error) {
      // W8-10③: 이 자리는 예전에 `catch {}` 로 예외를 **통째로 버렸다**. 그래서 운영에서
      // youtube_live_request_failed 가 떠도 원인(쿼터 초과·API 키 거부·네트워크·스키마)을 사후에
      // 확정할 방법이 없었다 — 실패 코드만 남고 증거가 사라졌다. 원문 메시지·키는 로그에 남기지
      // 않고(SEC-P0-009) 분류 가능한 안전 필드만 남긴다.
      const errorRecord = (error && typeof error === "object" ? error : {}) as Record<string, unknown>;
      const safeCode = typeof errorRecord.code === "string" ? errorRecord.code.slice(0, 64) : "";
      const safeStatus = typeof errorRecord.status === "number" ? errorRecord.status : undefined;
      console.error("[scoped-campaign-discovery] youtube live request failed", {
        runId,
        errorName: error instanceof Error ? error.name.slice(0, 64) : typeof error,
        ...(safeCode ? { errorCode: safeCode } : {}),
        ...(safeStatus !== undefined ? { httpStatus: safeStatus } : {}),
        messageHash: createHash("sha256")
          .update(error instanceof Error ? error.message : String(error))
          .digest("hex")
          .slice(0, 16),
      });
      if (scopedCampaignDiscoveryFixtureFallbackAllowed()) {
        results = mockDiscoveryResults(data);
        source = "mock-campaign-auto-discovery-fallback";
      } else {
        results = [];
        source = "youtube-live-unavailable";
        completionStatus = "failed";
        failureCode = "youtube_live_request_failed";
      }
    }
  }
  const ingressByIdentity = new Map(results.map((candidate) => [
    candidate.candidateRef || candidate.channelRef || candidate.email || candidate.name,
    {
      discoverySource: candidate.discoverySource,
      discoveryArm: candidate.discoveryArm,
      sourceFetchedAt: candidate.sourceFetchedAt,
    },
  ]));
  const resultsByIdentity = new Map<string, CandidateResult>();
  for (const candidate of [...backfilledResults, ...results]) {
    const identity = candidate.candidateRef || candidate.channelRef || candidate.email || candidate.name;
    const existing = resultsByIdentity.get(identity);
    if (!existing || (!existing.email && candidate.email)) resultsByIdentity.set(identity, candidate);
  }
  results = [...resultsByIdentity.values()].map((candidate) => ({
    ...candidate,
    ...(ingressByIdentity.get(candidate.candidateRef || candidate.channelRef || candidate.email || candidate.name) ?? {}),
  }));
  if (backfilledResults.length > 0 && completionStatus === "failed") {
    // Existing-pool enrichment is still useful, but it must not erase evidence
    // that the primary YouTube discovery lane failed.
    completionStatus = "partial";
    source = "youtube-public-web-email-backfill";
  } else if (backfilledResults.length > 0) {
    source = `${source}+youtube-public-web-email-backfill`;
  }

  // 스코프(이 run) 한정 결과에 N 상한 적용(RA-6: 상한은 scoped 조회 후 적용 — 전역 쿼리 아님).
  results = stampCandidateDiscoveryProvenance(
    scopeYoutubeDiscoveryResults(results, scopedContext),
    {
      ...scopedContext,
      ...accountOwnership,
      sourceRunId: runId,
      sourceRunRef: runRef.path,
      ...(Object.keys(programPolicySnapshot).length > 0 ? { programScopeEvidence: programPolicySnapshot } : {}),
    },
  ).slice(0, resultCap);
  const scopedPersistCounts = params.persistScopedResults === true
    ? await persistCandidates(results, source, CANDIDATE_SOURCE_PURPOSE.PROGRAM_CANDIDATE)
    : null;

  const completedAtIso = new Date().toISOString();
  const batch = adminDb.batch();
  batch.set(runRef, {
    status: completionStatus,
    completedAtIso,
    ...scopedContext,
    ...(failureCode ? { failureCode } : {}),
    ...(truncatedByQuota ? { truncatedByQuota: true } : {}),
    cache: { key: cacheKey, status: cachedResults !== null ? "hit" : "miss", ttlSeconds: DISCOVERY_CACHE_TTL_SECONDS },
    ...programPolicySnapshot,
    materialization: {
      source,
      persistence: "scoped_snapshot",
      candidatesWritten: scopedPersistCounts?.created ?? results.length,
      emailsFound: emailReadyCount(results),
      ...(scopedPersistCounts ? { newUnique: scopedPersistCounts.created, merged: scopedPersistCounts.merged } : {}),
      ...(harvestPartial ? { harvestPartial } : {}),
    },
    // 감사용 스냅샷만 — candidate_pool(전역)에는 쓰지 않는다(RA-6 scope 한정, 과거 후보 혼입 방지).
    candidateSnapshot: discoveryCandidateSnapshot(results),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  batch.set(jobRef, {
    status: completionStatus,
    completedAtIso,
    ...(failureCode ? { failureCode } : {}),
    ...(truncatedByQuota ? { truncatedByQuota: true } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  // createCampaign owns campaigns/{id}. Discovery may finish before the caller's
  // recipient/safety validation, so writing that document here would leave a
  // merge-created partial campaign whenever a later validation fails.
  await batch.commit();

  return { runId, runRef: runRef.path, jobRef: jobRef.path, source, ...scopedContext, candidates: results };
}

type DiscoveryQueueItemResult = {
  runId: string;
  jobRef: string;
  runRef: string;
  status: "complete" | "partial" | "failed" | "retry" | "dead_letter";
  candidatesWritten: number;
  emailsFound: number;
  error?: string;
  retryAfterIso?: string;
};

function discoveryQueueSortKey(row: { id: string; data: Record<string, unknown> }): string {
  return `${asString(row.data.retryAfterIso) ?? asString(row.data.queuedAtIso) ?? ""}\0${asString(row.data.queuedAtIso) ?? asString(row.data.createdAtIso) ?? row.id}\0${row.id}`;
}

function discoveryQueueRunnable(row: { data: Record<string, unknown> }, nowIsoValue: string): boolean {
  const retryAfterIso = asString(row.data.retryAfterIso);
  return !retryAfterIso || retryAfterIso <= nowIsoValue;
}

function isRetryableDiscoveryError(message: string): boolean {
  return /\b(429|quota|rate limit|too many requests|deadline reached|aborted)\b|lease (?:was )?(?:lost|expired)/i.test(message);
}

function emailReadyCount(results: CandidateResult[]): number {
  return results.filter((candidate) => typeof candidate.email === "string" && extractEmails(candidate.email).length > 0).length;
}

function mockDiscoveryResults(data: ParsedYtDlpDiscoveryData): CandidateResult[] {
  const mockCategories = Array.from(new Set([...data.filters.categories, ...data.keywords])).slice(0, data.discoveryVertical === "ai_drama" ? 40 : 12);
  if (data.filters.categoriesExplicit && mockCategories.length === 0) return [];
  const results = filterCandidates(MOCK_CANDIDATES, {
    regions: data.filters.regions,
    categories: mockCategories,
    categoriesExplicit: data.filters.categoriesExplicit,
    minFollowers: data.filters.minFollowers,
    recentActivityDays: data.filters.recentActivityDays,
  }, data.countryTargeting).slice(0, data.resultLimit);
  const sourceFetchedAt = new Date().toISOString();

  return results.map((candidate) => {
    const stored = MOCK_EMAILS[candidate.channelRef];
    return {
      ...candidate,
      discoverySource: "keyword",
      discoveryArm: "keyword",
      sourceFetchedAt,
      email: stored?.email ?? null,
      emailStatus: stored?.status ?? "none",
      emailSource: stored?.source ?? "none",
    };
  });
}

/**
 * R21-4 봉합선: 발굴 materialize 의 **주입 지점**. 기본값은 정확히 현재 운영 배선(searchYouTubeLive)
 * 이므로 기본 경로 동작은 바뀌지 않는다 — 같은 파일 fetchYouTubeRecord 의
 * `dependencies: YoutubeFetchDependencies = ...` 패턴과 같은 스타일이다.
 *
 * 왜 fetch 층이 아니라 이 층인가: 에뮬에서는 liveIntegrationsEnabled("youtube") 가 최상단에서 false 라
 * (liveIntegrations.ts: FUNCTIONS_EMULATOR === "true" → false) searchYouTubeLive 가 fetch 를 하기 전에
 * null 을 반환한다. fetch 를 주입해도 쿼터 소진 catch 경로에 **도달 자체가 불가능**하다.
 * 이 층에 주입하면 "전 키 429" 를 값으로 재현할 수 있고, 핫패스 로직은 호출 형태만 바뀐다.
 */
export type YtDiscoveryMaterializeDependencies = {
  searchLive(
    data: ParsedYoutubeSearchData,
    deadlineMs: number,
    persistence: YoutubeDiscoveryPersistence,
  ): Promise<{
    results: CandidateResult[];
    cost: CostLog;
    newUnique?: number;
    sliceArmStats?: Record<DiscoverySliceType, number>;
    sliceArmCalls?: SliceArmCalls;
    classifiedIn?: number;
    classifiedOut?: number;
    classificationExceptions?: number;
    truncatedByQuota?: boolean;
    harvestPartial?: YoutubeSearchHarvestPartial;
    hydrationOverflow?: HydrationOverflowStat;
    laneCostYield?: Record<string, LaneCostYield>;
    unitsSpent?: number;
    videoDescriptionEmails?: number;
    /** 헤세 결정(2026-09-27) — searchYouTubeLive 의 primaryLaneSkipped 와 같은 계약. */
    primaryLaneSkipped?: true;
  } | null>;
};

export const DEFAULT_YT_DISCOVERY_MATERIALIZE_DEPENDENCIES: YtDiscoveryMaterializeDependencies = {
  searchLive: (data, deadlineMs, persistence) => searchYouTubeLive(data, deadlineMs, persistence),
};

const VALIDATED_SCHEDULED_SHORTFALL_AUTHORITY = Symbol("validated scheduled shortfall authority");

export async function materializeYtDiscoveryRun(
  runData: Record<string, unknown>,
  dependencies: YtDiscoveryMaterializeDependencies = DEFAULT_YT_DISCOVERY_MATERIALIZE_DEPENDENCIES,
  validatedAuthority?: typeof VALIDATED_SCHEDULED_SHORTFALL_AUTHORITY,
) {
  const scheduledShortfall = validatedAuthority === VALIDATED_SCHEDULED_SHORTFALL_AUTHORITY;
  const data = readYtDlpDiscoveryData(runData);
  const scopedContext = await resolveAuthoritativeDiscoveryCampaignContext(data.campaignId, data.campaignRef);
  if (scheduledShortfall && !scopedContext) {
    throw Object.assign(new Error("failed-precondition: scheduled discovery authority requires exact campaign scope"), {
      code: "failed-precondition", errorCode: "materialized_scheduled_discovery_authority_scope_missing",
    });
  }
  const accountOwnership = scheduledShortfall
    ? await resolveScheduledCampaignDiscoveryAuthorityOwnership(scopedContext!, "materialized scheduled discovery campaign")
    : await resolveDiscoveryAuthorityOwnership(scopedContext, undefined, "materialized discovery campaign");
  const sourceRunId = asString(runData.id) ?? asString(runData.runId) ?? "";
  const sourceRunRef = asString(runData.runRef) ?? (sourceRunId ? `discovery_runs/${sourceRunId}` : "");
  const provenance = scopedContext && sourceRunId && sourceRunRef
    ? {
      ...scopedContext,
      ...accountOwnership,
      sourceRunId,
      sourceRunRef,
      ...((
        asString(runData.programPolicyRef)
        || Object.keys(asRecord(runData.candidateCriteriaSnapshot)).length > 0
        || Object.keys(asRecord(runData.eligibilityCriteriaSnapshot)).length > 0
      ) ? {
          programScopeEvidence: {
            ...(asString(runData.programPolicyRef) ? { programPolicyRef: asString(runData.programPolicyRef) } : {}),
            ...(Object.keys(asRecord(runData.candidateCriteriaSnapshot)).length > 0
              ? { candidateCriteriaSnapshot: asRecord(runData.candidateCriteriaSnapshot) }
              : {}),
            ...(Object.keys(asRecord(runData.eligibilityCriteriaSnapshot)).length > 0
              ? { eligibilityCriteriaSnapshot: asRecord(runData.eligibilityCriteriaSnapshot) }
              : {}),
          },
        } : {}),
      ...(asString(runData.criteriaHash) ? { criteriaHash: asString(runData.criteriaHash) } : {}),
      ...(asString(runData.policyHash) ? { policyHash: asString(runData.policyHash) } : {}),
    }
    : null;
  const deadlineMs = Date.now() + DISCOVERY_WORKER_MATERIALIZE_DEADLINE_MS;
  const materializationMode = asString(runData.materializationMode) ?? asString(runData.discoveryMode) ?? "";
  if (materializationMode === "public-web-backfill") {
    // R23-2b: 백필은 이미 알려진(이메일 없는) 후보를 보강한다 — 새 쿼리 슬라이스가 발견한 신규 후보가
    // 아니므로 쿼리 원장 신선율에 넣지 않는다(항상 0).
    // BLOCKER-2(i): 이 잡은 검색을 하지 않는다(searched:false) — processDiscoveryQueue 가 이 신호로
    // 쿼리 슬라이스 원장(R23-2b) 기록을 건너뛴다. 검색을 안 한 경로가 은퇴 판정을 남기면 슬라이스가
    // 억울하게 7일 은퇴된다(적대적 리뷰 실측).
    return {
      ...await materializePublicWebBackfill(data, deadlineMs, provenance, asString(accountOwnership.ownerOrgId)),
      newUnique: 0,
      searched: false,
    };
  }
  const workerSearchData = {
    queryRef: asString(runData.id) ?? asString(runData.runId) ?? data.campaignRef,
    campaignRef: data.campaignRef,
    gameId: data.gameId,
    resultLimit: Math.min(data.resultLimit, DISCOVERY_WORKER_YOUTUBE_SEARCH_LIMIT),
    countryTargeting: data.countryTargeting,
    filters: {
      regions: data.filters.regions,
      categories: Array.from(new Set([...data.filters.categories, ...data.keywords])).slice(0, data.discoveryVertical === "ai_drama" ? 40 : 12),
      categoriesExplicit: data.filters.categoriesExplicit || data.keywords.length === 0,
      minFollowers: data.filters.minFollowers,
      recentActivityDays: data.filters.recentActivityDays,
    },
    discoveryVertical: data.discoveryVertical,
    minVideoViews: data.minVideoViews,
    minVideoCount: data.minVideoCount,
    // Flu/W2: this worker path is the only searchYouTubeLive caller that already resolved
    // accountOwnership (above) — thread it through so T049 (AI Drama) scoped runs bill their
    // search/hydration units against the org's drama_1 pool instead of growth's rotation. Absent
    // ownerOrgId (unscoped/global runs) resolves to growth, unchanged.
    ...(asString(accountOwnership.ownerOrgId) ? { ownerOrgId: asString(accountOwnership.ownerOrgId) } : {}),
    // R27: 이 발굴 워커 경로만 밴딧 슬롯 배분·렉시콘을 싣는다 — searchYouTubeLive 의 다른 3개
    // 호출부(scoped_snapshot·프리뷰·communitySearch 인접 경로)는 이 필드들을 만들지 않으므로
    // sliceArmSlots undefined → 기존 100% keyword 동작 그대로다.
    ...(data.sliceArmSlots ? { sliceArmSlots: data.sliceArmSlots } : {}),
    ...(data.lexicon.length > 0 ? { lexicon: data.lexicon } : {}),
  };
  const cacheKey = youtubeDiscoveryCacheKey(workerSearchData);
  const cache = await cacheLookup(cacheKey, DISCOVERY_CACHE_TTL_SECONDS);
  if (cache.status === "hit" && cache.value) {
    const cachedResults = Array.isArray(cache.value.results) ? cache.value.results as CandidateResult[] : [];
    const safeCachedResults = withoutHostedFixtureCandidates(cachedResults);
    if (cachedResults.length === 0 || safeCachedResults.length > 0) {
      const cacheResults = safeCachedResults
        .filter((candidate) => candidateMatchesYtDiscovery(candidate, data))
        .map((candidate) => ({
          ...candidate, discoverySource: "cache_hit", sourceFetchedAt: new Date().toISOString(),
        }));
      const results = provenance ? stampCandidateDiscoveryProvenance(cacheResults, provenance) : cacheResults;
      // R23-2b: 캐시 히트도 실제 created 카운트를 그대로 쓴다 — 값을 임의로 0으로 단정하지 않는다.
      // 캐시된 결과가 이미 전부 적재돼 있으면 자연히 created=0(merge)이 나온다(캐시 재적재는 신규를
      // 만들지 않는다는 것이 조작이 아니라 실측으로 드러난다).
      const cachePersisted = await persistCandidates(results, "youtube-cache");
      // HIGH-C [적대적 리뷰 실측 · 프로브 P-F, BLOCKER-2(i) 자체의 결함]: 캐시 히트는 searched:true 가
      // 아니다 — 외부 YouTube API 호출이 전혀 없었으므로(캐시 TTL 이내 재요청) 이번 호출이 "이 슬라이스가
      // 신규 후보를 냈는지"에 대해 아무 정보도 주지 않는다. 실경로: recoverStaleDiscoveryJobs 가 잡을
      // 재큐 → 캐시 TTL(3600s) 이내라 캐시 히트 → 캐시된 후보는 이미 적재돼 있어 created=0 →
      // newUnique=0 → (searched:true 였을 때) 원장에 기록 → **방금 전 실검색이 실제로 후보를 찾아낸
      // 생산적 슬라이스가 자신의 캐시 히트 때문에 7일 은퇴**된다(검색을 안 한 경로가 은퇴 판정을 쓰면 안
      // 된다는 BLOCKER-2(i) 의 원래 취지와 같은 결함, 대상만 캐시 히트로 바뀐 것). searched:false 로
      // 원장 기록 자체를 건너뛴다 — 직전(또는 이후) 실검색이 남긴 원장 값을 이 캐시 응답이 덮어쓰지
      // 않는다.
      return { results: stampPersistOutcomes(results, cachePersisted.outcomes), source: "youtube-cache", cost: costLog("youtube-data-api-v3", "youtube-data-api", 0), newUnique: cachePersisted.created, searched: false };
    }
  }
  try {
    const live = await dependencies.searchLive(workerSearchData, deadlineMs, {
      mode: "global_candidate_pool",
      source: "youtube-data-api",
      ...(provenance ? { provenance } : {}),
    });
    if (live?.primaryLaneSkipped) {
      // 헤세 결정(2026-09-27) 코덱스 라운드1 HIGH-3 수리: search.list 를 아예 안 부른 패스다 —
      // 캐시하거나 searched:true 로 원장에 남기면 승인 철회 뒤에도 빈 캐시가 TTL 동안 굳고,
      // sliceArm/쿼리 수율 원장이 "검색했는데 0건"이라는 거짓 신호를 학습한다.
      return { results: [], source: "ytdlp-primary-lane-skip", cost: live.cost, newUnique: 0, searched: false };
    }
    if (live) {
      if (live.results.length === 0 && live.truncatedByQuota === true) {
        throw withSliceArmFailureEvidence(Object.assign(
          new Error("YouTube discovery quota exhausted before any candidate materialized"),
          { code: "failed-precondition", errorCode: "youtube_quota_empty_result", quotaLimited: true },
        ), live.sliceArmCalls ?? emptySliceArmCalls());
      }
      const authoritativeResults = live.results.filter((candidate) => candidateMatchesYtDiscovery(candidate, data));
      const needsMaterializePersist = Boolean(provenance)
        && authoritativeResults.length > 0
        && authoritativeResults.some((candidate) => !candidate.persistOutcome);
      const materializedPersisted = needsMaterializePersist
        ? await persistCandidates(
            stampCandidateDiscoveryProvenance(authoritativeResults, provenance as CandidateDiscoveryProvenance),
            "youtube-data-api",
            CANDIDATE_SOURCE_PURPOSE.PROGRAM_CANDIDATE,
          )
        : null;
      const materializedResults = materializedPersisted
        ? stampPersistOutcomes(
            stampCandidateDiscoveryProvenance(authoritativeResults, provenance as CandidateDiscoveryProvenance),
            materializedPersisted.outcomes,
          )
        : authoritativeResults;
      // AI-DRAMA-DISCOVERY-METAPROMPT W5: queue the async JEV comment-sentiment pipeline for this
      // pass's candidates — ai_drama-vertical + org-scoped runs only (data.discoveryVertical is
      // this run's own criteria, accountOwnership.ownerOrgId is the authoritative stamp resolved
      // above). Every other discovery lane (growth included) never sets this flag, so
      // comment_insights_pending stays untouched for them — zero JEV cost for non-ai_drama
      // candidates. Best-effort: caught below, never fails the discovery pass itself (the
      // candidates are already durably persisted above) — but awaited (Codex 적대 리뷰 P1 수리)
      // so a successful enqueue isn't silently lost to an instance dying mid-flight.
      const commentSentimentOwnerOrgId = asString(accountOwnership.ownerOrgId) ?? "";
      if (data.discoveryVertical === "ai_drama" && commentSentimentOwnerOrgId) {
        // Codex 적대 리뷰 P2 수리: merge(이미 이전 pass에서 큐잉/분석됐을 후보)는 다시 태우지
        // 않는다 — created만 큐잉한다. qualifyingVideoId는 여기서 직접 캡처한다(스윕이 나중에
        // candidate_pool/campaign_candidates를 다시 읽지 않아도 되게 — 파일 헤더의 P0 수리 참고).
        const newlyCreatedCandidates = materializedResults
          .filter((candidate) => candidate.persistOutcome === "created" && candidate.candidateRef.startsWith("candidate_pool/"))
          .map((candidate) => ({
            channelId: candidate.candidateRef.slice("candidate_pool/".length),
            qualifyingVideoId: candidate.qualifyingVideo?.videoId ?? null,
          }))
          .filter((candidate) => Boolean(candidate.channelId));
        if (newlyCreatedCandidates.length > 0) {
          try {
            await enqueueCreatorCommentSentimentPending(newlyCreatedCandidates, commentSentimentOwnerOrgId);
          } catch (error) {
            console.warn("[ai-drama-comment-sentiment] enqueue failed", {
              errorCode: (error as { errorCode?: unknown; code?: unknown } | null)?.errorCode
                ?? (error as { code?: unknown } | null)?.code ?? "unknown",
            });
          }
        }
      }
      await cacheStore(cacheKey, "youtube", workerSearchData.queryRef, DISCOVERY_CACHE_TTL_SECONDS, { results: materializedResults });
      // BLOCKER-2(i): 실검색이 수행됐다(0건이든 N건이든 — searchYouTubeLive 가 실제로 YouTube API 를
      // 불렀다) → searched:true, 원장 은퇴 판정의 정당한 근거다.
      return {
        results: materializedResults,
        source: "youtube-data-api",
        cost: live.cost,
        newUnique: materializedPersisted?.created ?? live.newUnique ?? 0,
        searched: true,
        // R27: 밴딧 EWMA 갱신 근거 — processDiscoveryQueue 가 잡 completion 시점에 그대로 원장에
        // 남긴다(admin.ts 는 다음 pass 에 이 값을 읽어 EWMA 를 갱신한다).
        sliceArmStats: live.sliceArmStats,
        // R28-1: 암별 실호출 계측도 같이 흘린다 — processDiscoveryQueue 가 잡/런 문서에 영속하고
        // admin.ts 가 이 값을 EWMA 분모로 쓴다.
        sliceArmCalls: live.sliceArmCalls,
        truncatedByQuota: live.truncatedByQuota === true,
        // W42 F-1: 수확 보존 중단의 증거를 잡 완료 경로로 흘린다 — 이 값이 있으면 런은 partial 이다.
        harvestPartial: live.harvestPartial,
        // W63 Phase 0: hydration 절단 실측을 잡 완료 경로로 그대로 흘린다.
        hydrationOverflow: live.hydrationOverflow,
        // W115 C1: 레인별 유닛·수율과 총 유닛도 같은 경로로 흘린다 — 잡 완료 시점에 영속돼야
        //   admin.ts 다음 pass 가 **비용 정규화** 배분의 근거로 읽을 수 있다.
        laneCostYield: live.laneCostYield,
        unitsSpent: live.unitsSpent,
        videoDescriptionEmails: live.videoDescriptionEmails,
        // R28-2 (P0-D): 이 잡의 배분 대비 실행 관측 — 계획(data.sliceArmSlots, 실제로 queryPlan 을
        // 만든 값)과 실행을 여기서 맞춰 둔다. 판정에는 쓰이지 않는다.
        sliceArmObservability: live.sliceArmCalls
          ? computeSliceArmObservability(data.sliceArmSlots, live.sliceArmCalls)
          : undefined,
        classifiedIn: live.classifiedIn,
        classifiedOut: live.classifiedOut,
        classificationExceptions: live.classificationExceptions,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureEvidence = readSliceArmFailureEvidence(error);
    const failureObservability = failureEvidence.sliceArmCalls
      ? computeSliceArmObservability(data.sliceArmSlots, failureEvidence.sliceArmCalls)
      : undefined;
    const armEvidence = {
      ...failureEvidence,
      ...(failureObservability ? { sliceArmObservability: failureObservability } : {}),
    };
    // R21-4: 소진 판정은 **fetchYouTubeRecord 가 붙여 주는 quotaLimited 플래그**를 정본으로 본다.
    // 메시지 정규식만 보면 일일 쿼터 소진(403)이 빠진다 — 실제 메시지는 "YouTube search failed (403)"
    // 이고 isRetryableDiscoveryError 의 `\bquota\b` 는 "quotaExceeded" 에도 매칭되지 않는다(뒤가 단어
    // 문자). 즉 429 만 인계되고 403 소진은 그대로 dead_letter 였다 — R21-4 수용 테스트가 잡은 결함이다.
    // 플래그는 youtubeQuotaLimited(429 + 403 쿼터 계열)가 세운다.
    const quotaLimited = (error as { quotaLimited?: unknown }).quotaLimited === true;
    if (!quotaLimited && !isRetryableDiscoveryError(message)) throw error;
    // ① 기존 이메일 보강 폴백은 유지한다(신규 채널은 못 만들지만 이메일은 붙는다).
    const fallback = await materializePublicWebBackfill(data, deadlineMs, provenance, asString(accountOwnership.ownerOrgId));
    // R23-2b: 백필은 신규 채널을 만들지 않는다(위 주석) — 쿼리 원장 신선율은 0.
    // BLOCKER-2(i) [적대적 리뷰 프로브 C1 실측]: 이 경로는 **쿼터 소진으로 실검색을 하지 않고** 백필로
    // 대체됐다(searched:false) — 그런데도 newUnique=0 이 그대로 원장에 기록돼 슬라이스가 7일 은퇴되는
    // 사고가 재현됐다(403 quotaLimited 주입 → 백필 1건 적재 + newUnique=0 → 원장 기록 → 은퇴). 검색을
    // 안 했으니 이 슬라이스가 "죽었다"고 판정할 근거가 없다 — searched:false 로 원장 기록 자체를
    // 건너뛰게 한다.
    Object.assign(fallback, armEvidence);
    if (fallback.results.length > 0) return { ...fallback, newUnique: 0, searched: false };
    // ② R21-4③: 보강이 0건이면 예전에는 rethrow → dead_letter 였다. 쿼터 0 커뮤니티 레인으로
    //    인계하고 이 잡은 정상 종료한다 — 신규 후보 적재는 인계된 잡이 한다.
    const handoff = await handOffToQuotaFreeCommunityLane(data);
    if (handoff) {
      return {
        results: [],
        source: `community-discovery-handoff:${handoff.status}`,
        cost: costLog("insane-search-adapter", "community-adapter", 0),
        // 이 잡 자체는 후보를 적재하지 않는다 — 인계된 커뮤니티 잡이 별도로 한다.
        newUnique: 0,
        // BLOCKER-2(i): 이 잡 자체는 검색을 하지 않았다(다른 잡으로 인계) — 원장 기록 대상이 아니다.
        searched: false,
        ...armEvidence,
      };
    }
    throw error;
  }
  if (discoveryFixtureFallbackAllowed()) {
    const mockResults = mockDiscoveryResults(data);
    const results = provenance ? stampCandidateDiscoveryProvenance(mockResults, provenance) : mockResults;
    const mockPersisted = await persistCandidates(results, "mock-youtube-discovery-worker");
    // BLOCKER-2(i): 에뮬/개발 전용 목 발굴 폴백 — 운영에서는 liveIntegrationsEnabled("youtube") 가
    // 항상 true 라 이 분기 자체가 없다. 실검색의 테스트 대역이므로 searched:true(원장 기록 대상).
    return { results, source: "mock-youtube-discovery-worker", cost: costLog("mock-youtube-search"), newUnique: mockPersisted.created, searched: true };
  }
  throw discoveryUnavailable("youtube");
}

function discoveryProcessingStartedMs(data: Record<string, unknown>): number | null {
  const startedAtIso = asString(data.startedAtIso);
  if (!startedAtIso) return null;
  const startedAtMs = Date.parse(startedAtIso);
  return Number.isFinite(startedAtMs) ? startedAtMs : null;
}

type DiscoveryQueueJob = {
  id: string;
  ref: FirebaseFirestore.DocumentReference;
  data: Record<string, unknown>;
};

function leaseMatches(
  data: Record<string, unknown>,
  lease: Pick<CommunityDiscoveryLease, "attempt" | "leaseToken">,
): boolean {
  return asString(data.status) === "processing"
    && asNumber(data.attempt) === lease.attempt
    && asString(data.leaseToken) === lease.leaseToken;
}

export async function assertAndHeartbeatCommunityDiscoveryLease(
  jobRef: FirebaseFirestore.DocumentReference,
  lease: CommunityDiscoveryLease,
  nowIsoValue = new Date().toISOString(),
): Promise<CommunityDiscoveryLease> {
  return adminDb.runTransaction(async (transaction) => {
    const current = await transaction.get(jobRef);
    const data = current.data() ?? {};
    const currentExpiry = asString(data.leaseExpiresAtIso);
    if (!current.exists || !leaseMatches(data, lease) || !currentExpiry || currentExpiry <= nowIsoValue) {
      throw Object.assign(new Error("aborted: community discovery lease was lost or expired"), { code: "aborted", errorCode: "assert_and_heartbeat_community_discovery_lease_community_discovery" });
    }
    const refreshedExpiry = new Date(Date.parse(nowIsoValue) + COMMUNITY_DISCOVERY_LEASE_MS).toISOString();
    transaction.set(jobRef, {
      leaseExpiresAtIso: refreshedExpiry,
      heartbeatAtIso: nowIsoValue,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { ...lease, leaseExpiresAtIso: refreshedExpiry };
  });
}

type DiscoveryJobLeaseClaimResult = {
  lease: CommunityDiscoveryLease;
  runRef: FirebaseFirestore.DocumentReference;
  jobData: Record<string, unknown>;
  runDocumentData: Record<string, unknown>;
  runData: Record<string, unknown>;
};

type DiscoveryJobLeaseClaimIdentity = CommunityDiscoveryLease;

type DiscoveryJobLeaseRecoveryOutcome = "own_committed" | "foreign_winner" | "not_claimable" | "retry" | "retry_exhausted";

type DiscoveryJobLeaseTransactionRunner = (
  job: DiscoveryQueueJob,
  nowIsoValue: string,
  identity: DiscoveryJobLeaseClaimIdentity,
) => Promise<DiscoveryJobLeaseClaimResult | null>;

type DiscoveryJobLeaseClaimOptions = {
  runLeaseTransactionForTest?: DiscoveryJobLeaseTransactionRunner;
};

const COMMUNITY_DISCOVERY_LEASE_TRANSACTION_RECOVERY_MAX_ATTEMPTS = 2;

function isVerifiedFirestoreEmulatorRuntime(): boolean {
  return Boolean(process.env.FIRESTORE_EMULATOR_HOST && process.env.FUNCTIONS_EMULATOR === "true");
}

function isFirestoreInvalidClosedTransactionError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate?.code === 3
    && typeof candidate.message === "string"
    && candidate.message.includes("Transaction is invalid or closed");
}

function canRecoverFirestoreInvalidClosedTransaction(error: unknown): boolean {
  return isVerifiedFirestoreEmulatorRuntime() && isFirestoreInvalidClosedTransactionError(error);
}

function logDiscoveryLeaseTransactionRecovery(outcome: DiscoveryJobLeaseRecoveryOutcome, context: { jobId: string; attempt?: number }): void {
  console.warn("community_discovery_lease_transaction_recovery", {
    outcome,
    jobId: context.jobId,
    ...(context.attempt !== undefined ? { attempt: context.attempt } : {}),
  });
}

async function runDiscoveryJobLeaseTransaction(
  job: DiscoveryQueueJob,
  nowIsoValue: string,
  identity: DiscoveryJobLeaseClaimIdentity,
): Promise<DiscoveryJobLeaseClaimResult | null> {
  return adminDb.runTransaction(async (transaction) => {
    const currentJob = await transaction.get(job.ref);
    if (!currentJob.exists) return null;
    const currentJobData = currentJob.data() ?? {};
    if (asString(currentJobData.status) !== "queued" || !discoveryQueueRunnable({ data: currentJobData }, nowIsoValue)) return null;
    const runRefPath = asString(currentJobData.runRef);
    const runRef = runRefPath ? adminDb.doc(runRefPath) : adminDb.collection("discovery_runs").doc(job.id);
    const runSnapshot = await transaction.get(runRef);
    const runData: Record<string, unknown> = { id: job.id, ...currentJobData, ...(runSnapshot.data() ?? {}) };
    const scopedContext = asString(currentJobData.type) === COMMUNITY_DISCOVERY_JOB_TYPE
      ? exactStoredCommunityScope(runData)
      : null;
    if (scopedContext) {
      const [campaign, program] = await Promise.all([
        transaction.get(adminDb.collection("campaigns").doc(scopedContext.campaignId)),
        transaction.get(adminDb.collection("programs").doc(scopedContext.canonicalProgramId)),
      ]);
      const campaignData = campaign.data() ?? {};
      const programData = program.data() ?? {};
      if (!campaign.exists || !program.exists
        || discoveryAuthorityDocumentRetired(campaignData, RETIRED_DISCOVERY_CAMPAIGN_STATUSES)
        || discoveryAuthorityDocumentRetired(programData, RETIRED_DISCOVERY_PROGRAM_STATUSES)
        || resolveCanonicalProgramId(campaignData.canonicalProgramId ?? campaignData.programId) !== scopedContext.canonicalProgramId) {
        throw Object.assign(new Error("failed-precondition: community discovery authority is not operational"), { code: "failed-precondition", errorCode: "claim_discovery_job_lease_community_discovery_authority_operational" });
      }
    }
    const attempt = Math.max(0, asNumber(currentJobData.attempt) ?? 0) + 1;
    if (attempt > COMMUNITY_DISCOVERY_MAX_ATTEMPTS) {
      const terminal = {
        status: "dead_letter",
        terminalStatus: "failed",
        error: "Discovery job exceeded maximum attempts",
        failedAtIso: nowIsoValue,
        leaseOwner: FieldValue.delete(),
        leaseToken: FieldValue.delete(),
        leaseExpiresAtIso: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      transaction.set(job.ref, terminal, { merge: true });
      transaction.set(runRef, terminal, { merge: true });
      return null;
    }
    if (identity.attempt > 0 && identity.attempt !== attempt) return null;
    identity.attempt = attempt;
    const lease: CommunityDiscoveryLease = { ...identity };
    const phase = asString(currentJobData.phase) ?? "collect";
    transaction.set(job.ref, {
      status: "processing",
      phase,
      startedAtIso: nowIsoValue,
      heartbeatAtIso: nowIsoValue,
      ...lease,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    if (asString(runData.artifactStatus) !== "complete" && asString(runData.artifactStatus) !== "partial") {
      transaction.set(runRef, {
        status: "processing",
        startedAtIso: nowIsoValue,
        attempt,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    if (asString(currentJobData.type) === COMMUNITY_DISCOVERY_JOB_TYPE) {
      const receiptId = `${job.id}__${attempt}__${phase}__leased`;
      transaction.set(adminDb.collection("discovery_run_receipts").doc(receiptId), {
        id: receiptId,
        runId: job.id,
        runRef: runRef.path,
        jobRef: job.ref.path,
        attempt,
        leaseOwner: identity.leaseOwner,
        leaseToken: identity.leaseToken,
        leaseExpiresAtIso: identity.leaseExpiresAtIso,
        phase,
        status: "leased",
        recordedAtIso: nowIsoValue,
        expireAt: expireAt180DaysFromIso(nowIsoValue),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    return { lease, runRef, jobData: currentJobData, runDocumentData: runSnapshot.data() ?? {}, runData };
  });
}

async function claimDiscoveryJobLeaseWithEmulatorCasFallback(
  job: DiscoveryQueueJob,
  nowIsoValue: string,
  identity: DiscoveryJobLeaseClaimIdentity,
): Promise<{ outcome: DiscoveryJobLeaseRecoveryOutcome; result: DiscoveryJobLeaseClaimResult | null }> {
  const currentJob = await job.ref.get();
  if (!currentJob.exists || !currentJob.updateTime) return { outcome: "not_claimable", result: null };
  const currentJobData = currentJob.data() ?? {};
  const status = asString(currentJobData.status);
  const leaseToken = asString(currentJobData.leaseToken);
  const leaseOwner = asString(currentJobData.leaseOwner);
  const leaseExpiresAtIso = asString(currentJobData.leaseExpiresAtIso);
  if (leaseToken && leaseOwner && leaseExpiresAtIso && leaseExpiresAtIso > nowIsoValue) {
    return { outcome: "foreign_winner", result: null };
  }
  if (status !== "queued" || !discoveryQueueRunnable({ data: currentJobData }, nowIsoValue)) return { outcome: "not_claimable", result: null };
  const runRefPath = asString(currentJobData.runRef);
  const runRef = runRefPath ? adminDb.doc(runRefPath) : adminDb.collection("discovery_runs").doc(job.id);
  const runSnapshot = await runRef.get();
  if (!runSnapshot.exists || !runSnapshot.updateTime) return { outcome: "not_claimable", result: null };
  const runData: Record<string, unknown> = { id: job.id, ...currentJobData, ...(runSnapshot.data() ?? {}) };
  const runStatus = asString(runData.status);
  if (runStatus && runStatus !== "queued") return { outcome: "not_claimable", result: null };
  if (asString(currentJobData.type) === COMMUNITY_DISCOVERY_JOB_TYPE && exactStoredCommunityScope(runData)) {
    return { outcome: "retry", result: null };
  }
  if (asString(runData.artifactStatus) === "complete" || asString(runData.artifactStatus) === "partial") {
    return { outcome: "retry", result: null };
  }
  const attempt = Math.max(0, asNumber(currentJobData.attempt) ?? 0) + 1;
  if (attempt > COMMUNITY_DISCOVERY_MAX_ATTEMPTS) return { outcome: "not_claimable", result: null };
  const lease: CommunityDiscoveryLease = { ...identity, attempt };
  const phase = asString(currentJobData.phase) ?? "collect";
  const batch = adminDb.batch();
  batch.update(job.ref, {
    status: "processing",
    phase,
    startedAtIso: nowIsoValue,
    heartbeatAtIso: nowIsoValue,
    ...lease,
    updatedAt: FieldValue.serverTimestamp(),
  }, { lastUpdateTime: currentJob.updateTime });
  batch.update(runRef, {
    status: "processing",
    startedAtIso: nowIsoValue,
    attempt,
    updatedAt: FieldValue.serverTimestamp(),
  }, { lastUpdateTime: runSnapshot.updateTime });
  if (asString(currentJobData.type) === COMMUNITY_DISCOVERY_JOB_TYPE) {
    const receiptId = `${job.id}__${attempt}__${phase}__leased`;
    batch.set(adminDb.collection("discovery_run_receipts").doc(receiptId), {
      id: receiptId,
      runId: job.id,
      runRef: runRef.path,
      jobRef: job.ref.path,
      attempt,
      leaseOwner: identity.leaseOwner,
      leaseToken: identity.leaseToken,
      leaseExpiresAtIso: identity.leaseExpiresAtIso,
      phase,
      status: "leased",
      recordedAtIso: nowIsoValue,
      expireAt: expireAt180DaysFromIso(nowIsoValue),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  try {
    await batch.commit();
  } catch {
    return reconcileDiscoveryJobLeaseClaimAfterInvalidClosedTransaction(job, nowIsoValue, identity);
  }
  identity.attempt = attempt;
  return { outcome: "own_committed", result: { lease, runRef, jobData: currentJobData, runDocumentData: runSnapshot.data() ?? {}, runData } };
}

async function reconcileDiscoveryJobLeaseClaimAfterInvalidClosedTransaction(
  job: DiscoveryQueueJob,
  nowIsoValue: string,
  identity: DiscoveryJobLeaseClaimIdentity,
): Promise<{ outcome: DiscoveryJobLeaseRecoveryOutcome; result: DiscoveryJobLeaseClaimResult | null }> {
  const currentJob = await job.ref.get();
  if (!currentJob.exists) return { outcome: "not_claimable", result: null };
  const currentJobData = currentJob.data() ?? {};
  const status = asString(currentJobData.status);
  const leaseToken = asString(currentJobData.leaseToken);
  const leaseOwner = asString(currentJobData.leaseOwner);
  const leaseExpiresAtIso = asString(currentJobData.leaseExpiresAtIso);
  const attempt = asNumber(currentJobData.attempt);

  if (status === "processing") {
    if (leaseToken === identity.leaseToken && leaseOwner === identity.leaseOwner) {
      const runRefPath = asString(currentJobData.runRef);
      const runRef = runRefPath ? adminDb.doc(runRefPath) : adminDb.collection("discovery_runs").doc(job.id);
      const runSnapshot = await runRef.get();
      const runData: Record<string, unknown> = { id: job.id, ...currentJobData, ...(runSnapshot.data() ?? {}) };
      const runStatus = asString(runData.status);
      const runAttempt = asNumber(runData.attempt);
      if (attempt === identity.attempt
        && leaseExpiresAtIso
        && leaseExpiresAtIso > nowIsoValue
        && runSnapshot.exists
        && runStatus === "processing"
        && runAttempt === attempt) {
        const scopedContext = asString(currentJobData.type) === COMMUNITY_DISCOVERY_JOB_TYPE
          ? exactStoredCommunityScope(runData)
          : null;
        if (scopedContext && (asString(runData.campaignRef) !== scopedContext.campaignRef || asString(runData.programRef) !== scopedContext.programRef)) {
          return { outcome: "retry", result: null };
        }
        const lease: CommunityDiscoveryLease = { attempt, leaseOwner, leaseToken, leaseExpiresAtIso };
        return { outcome: "own_committed", result: { lease, runRef, jobData: currentJobData, runDocumentData: runSnapshot.data() ?? {}, runData } };
      }
      return { outcome: "retry", result: null };
    }
    if (leaseToken && leaseOwner && leaseExpiresAtIso && leaseExpiresAtIso > nowIsoValue) {
      return { outcome: "foreign_winner", result: null };
    }
    return { outcome: "not_claimable", result: null };
  }

  if (status === "queued" && discoveryQueueRunnable({ data: currentJobData }, nowIsoValue)) {
    return { outcome: "retry", result: null };
  }
  return { outcome: "not_claimable", result: null };
}

export async function claimDiscoveryJobLease(
  job: DiscoveryQueueJob,
  nowIsoValue: string,
  options: DiscoveryJobLeaseClaimOptions = {},
): Promise<DiscoveryJobLeaseClaimResult | null> {
  const identity: DiscoveryJobLeaseClaimIdentity = {
    attempt: 0,
    leaseOwner: `scheduled-discovery-worker:${process.env.K_REVISION ?? process.env.FUNCTION_TARGET ?? "local"}`,
    leaseToken: randomUUID(),
    leaseExpiresAtIso: new Date(Date.parse(nowIsoValue) + COMMUNITY_DISCOVERY_LEASE_MS).toISOString(),
  };
  const runLeaseTransaction = options.runLeaseTransactionForTest ?? runDiscoveryJobLeaseTransaction;
  let originalInvalidClosedError: unknown = null;
  for (let attemptIndex = 0; attemptIndex < COMMUNITY_DISCOVERY_LEASE_TRANSACTION_RECOVERY_MAX_ATTEMPTS; attemptIndex += 1) {
    try {
      const result = await runLeaseTransaction(job, nowIsoValue, identity);
      if (originalInvalidClosedError && result === null) {
        const recovered = await reconcileDiscoveryJobLeaseClaimAfterInvalidClosedTransaction(job, nowIsoValue, identity);
        logDiscoveryLeaseTransactionRecovery(recovered.outcome, { jobId: job.id, attempt: identity.attempt });
        if (recovered.outcome === "own_committed" || recovered.outcome === "foreign_winner" || recovered.outcome === "not_claimable") {
          return recovered.result;
        }
        break;
      }
      return result;
    } catch (error) {
      if (!canRecoverFirestoreInvalidClosedTransaction(error)) throw error;
      originalInvalidClosedError ??= error;
      const recovered = await reconcileDiscoveryJobLeaseClaimAfterInvalidClosedTransaction(job, nowIsoValue, identity);
      logDiscoveryLeaseTransactionRecovery(recovered.outcome, { jobId: job.id, attempt: identity.attempt });
      if (recovered.outcome === "own_committed" || recovered.outcome === "foreign_winner" || recovered.outcome === "not_claimable") {
        return recovered.result;
      }
      if (recovered.outcome === "retry" && identity.attempt === 0) {
        const fallback = await claimDiscoveryJobLeaseWithEmulatorCasFallback(job, nowIsoValue, identity);
        logDiscoveryLeaseTransactionRecovery(fallback.outcome, { jobId: job.id, attempt: identity.attempt });
        if (fallback.outcome === "own_committed" || fallback.outcome === "foreign_winner" || fallback.outcome === "not_claimable") {
          return fallback.result;
        }
      }
    }
  }
  logDiscoveryLeaseTransactionRecovery("retry_exhausted", { jobId: job.id, attempt: identity.attempt });
  throw originalInvalidClosedError;
}

export const __testCommunityDiscoveryLeaseRecovery = {
  isFirestoreInvalidClosedTransactionError,
  canRecoverFirestoreInvalidClosedTransaction,
  runDiscoveryJobLeaseTransaction,
  reconcileDiscoveryJobLeaseClaimAfterInvalidClosedTransaction,
};

async function recoverStaleDiscoveryJobs(nowIsoValue: string): Promise<number> {
  const staleBeforeMs = Date.parse(nowIsoValue) - DISCOVERY_PROCESSING_STALE_MS;
  const processingSnapshots = await Promise.all(
    LIVE_DISCOVERY_JOB_TYPES.map((type) => adminDb.collection("workflow_jobs")
      .where("status", "==", "processing")
      .where("type", "==", type)
      .limit(DISCOVERY_QUEUE_SCAN_LIMIT)
      .get()),
  );
  const staleJobs = processingSnapshots.flatMap((snapshot) => snapshot.docs)
    .map((doc) => ({ id: doc.id, ref: doc.ref, data: doc.data() ?? {} }))
    .filter((doc) => {
      const leaseExpiresAtIso = asString(doc.data.leaseExpiresAtIso);
      if (leaseExpiresAtIso) return leaseExpiresAtIso <= nowIsoValue;
      const startedAtMs = discoveryProcessingStartedMs(doc.data);
      return startedAtMs !== null && startedAtMs <= staleBeforeMs;
    })
    .slice(0, DISCOVERY_QUEUE_SWEEP_LIMIT);

  await Promise.all(staleJobs.map(async (job) => adminDb.runTransaction(async (transaction) => {
    const current = await transaction.get(job.ref);
    const currentData = current.data() ?? {};
    if (!current.exists || asString(currentData.status) !== "processing") return;
    const currentLeaseExpiry = asString(currentData.leaseExpiresAtIso);
    if (currentLeaseExpiry && currentLeaseExpiry > nowIsoValue) return;
    if (!currentLeaseExpiry) {
      const currentStartedAtMs = discoveryProcessingStartedMs(currentData);
      if (currentStartedAtMs === null || currentStartedAtMs > staleBeforeMs) return;
    }
    const runRefPath = asString(currentData.runRef);
    const runRef = runRefPath ? adminDb.doc(runRefPath) : adminDb.collection("discovery_runs").doc(job.id);
    const attempt = asNumber(currentData.attempt) ?? 0;
    const retryCount = asNumber(currentData.retryCount) ?? 0;
    if (attempt >= COMMUNITY_DISCOVERY_MAX_ATTEMPTS || retryCount >= DISCOVERY_STALE_RECOVERY_LIMIT) {
      const failed = {
        status: "dead_letter",
        terminalStatus: "failed",
        error: "Discovery job exceeded stale recovery or maximum attempt limit",
        failedAtIso: nowIsoValue,
        staleFailedAtIso: nowIsoValue,
        leaseOwner: FieldValue.delete(),
        leaseToken: FieldValue.delete(),
        leaseExpiresAtIso: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      transaction.set(job.ref, failed, { merge: true });
      transaction.set(runRef, asString(currentData.artifactStatus) === "complete" || asString(currentData.artifactStatus) === "partial"
        ? { ...failed, publicationStatus: "dead_letter", publicationError: failed.error }
        : failed, { merge: true });
      return;
    }
    const recovery = {
      status: "queued",
      lastError: "Recovered expired discovery lease",
      retryAfterIso: nowIsoValue,
      staleRecoveredAtIso: nowIsoValue,
      retryCount: FieldValue.increment(1),
      leaseOwner: FieldValue.delete(),
      leaseToken: FieldValue.delete(),
      leaseExpiresAtIso: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    transaction.set(job.ref, recovery, { merge: true });
    transaction.set(runRef, asString(currentData.artifactStatus) === "complete" || asString(currentData.artifactStatus) === "partial"
      ? { publicationStatus: "retry", updatedAt: FieldValue.serverTimestamp() }
      : recovery, { merge: true });
  })));

  return staleJobs.length;
}

// R23-2b: 쿼리 슬라이스 원장 항목 상한 — campaigns/{id}.shortfallDiscoveryState.queryLedger 맵에
// 얹으므로(새 컬렉션 0) 캠페인 하나당 항목이 무한정 늘어나지 않도록 스스로 상한·evict 를 지킨다.
const QUERY_LEDGER_MAX_ENTRIES = 20;

type QueryLedgerEntry = {
  lastRunAtIso: string;
  newUnique: number;
  unitsSpentEstimate: number;
  /**
   * W115-R1 [한 줄 수리 · 적대 리뷰]: 이 추정치가 **실측인가 폴백인가**.
   * 두 값은 척도가 100배 다르다(유닛 vs 결과 건수). 축이 없으면 슬라이스 비용 비교가 두 척도를
   * 섞은 채로 이뤄지고, 그 사실이 어디에도 안 남는다.
   */
  unitsSpentEstimateSource: "measured" | "legacy";
};

/**
 * 기존 원장에 이번 완료분을 병합한 **쓰기용 부분 맵**을 만든다(merge:true 로 다른 슬라이스 항목은
 * 건드리지 않는다). 상한을 넘으면 `lastRunAtIso` 가 가장 오래된 슬라이스부터 `FieldValue.delete()`
 * 로 비운다 — 최근에 실행된 슬라이스일수록 살아남는다(오래 안 돈 슬라이스는 관측 가치도 낮다).
 */
function queryLedgerUpsertWrite(
  existingLedger: Record<string, unknown>,
  sliceHash: string,
  entry: QueryLedgerEntry,
): Record<string, unknown> {
  const otherKeys = Object.keys(existingLedger).filter((key) => key !== sliceHash);
  const write: Record<string, unknown> = { [sliceHash]: entry };
  if (otherKeys.length >= QUERY_LEDGER_MAX_ENTRIES) {
    const oldest = otherKeys
      .map((key) => ({ key, lastRunAtIso: asString(asRecord(existingLedger[key]).lastRunAtIso) ?? "" }))
      .sort((left, right) => left.lastRunAtIso.localeCompare(right.lastRunAtIso))[0];
    if (oldest) write[oldest.key] = FieldValue.delete();
  }
  return write;
}

export async function processDiscoveryQueue(): Promise<{ ok: true; scanned: number; recoveredStale: number; processed: DiscoveryQueueItemResult[] }> {
  const nowIsoValue = new Date().toISOString();
  const recoveredStale = await recoverStaleDiscoveryJobs(nowIsoValue);
  const queuedByType = await Promise.all(
    LIVE_DISCOVERY_JOB_TYPES.map(async (type) => {
      const [scheduledSnapshot, transitionSnapshot] = await Promise.all([
        adminDb.collection("workflow_jobs")
          .where("status", "==", "queued")
          .where("type", "==", type)
          .where("retryAfterIso", "<=", nowIsoValue)
          .orderBy("retryAfterIso", "asc")
          .orderBy("queuedAtIso", "asc")
          .limit(DISCOVERY_QUEUE_SCAN_LIMIT)
          .get(),
        // Transition read: inequality queries omit documents whose field does not
        // exist. Keep a bounded exact-type scan until every legacy queued job has
        // been backfilled with retryAfterIso.
        adminDb.collection("workflow_jobs")
          .where("status", "==", "queued")
          .where("type", "==", type)
          .limit(DISCOVERY_QUEUE_SCAN_LIMIT)
          .get(),
      ]);
      const legacyDocs = transitionSnapshot.docs.filter((doc) => !asString(doc.get("retryAfterIso")));
      if (legacyDocs.length > 0) {
        await commitCommunityDiscoveryArtifactWrites(legacyDocs.map((doc) => (batch) => batch.set(doc.ref, {
          retryAfterIso: asString(doc.get("queuedAtIso")) ?? nowIsoValue,
          retryAfterBackfilledAtIso: nowIsoValue,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true })));
      }
      const docsByPath = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
      for (const doc of [...scheduledSnapshot.docs, ...legacyDocs]) docsByPath.set(doc.ref.path, doc);
      return Array.from(docsByPath.values())
        .map((doc) => ({ id: doc.id, ref: doc.ref, data: doc.data() ?? {} }))
        .filter((doc) => discoveryQueueRunnable(doc, nowIsoValue))
        .sort((left, right) => discoveryQueueSortKey(left).localeCompare(discoveryQueueSortKey(right)));
    }),
  );
  const queuedDocs = queuedByType.flat();
  const jobs = queuedByType.flatMap((rows) => rows.slice(0, 1))
    .sort((left, right) => discoveryQueueSortKey(left).localeCompare(discoveryQueueSortKey(right)))
    .slice(0, DISCOVERY_QUEUE_SWEEP_LIMIT);
  const processed: DiscoveryQueueItemResult[] = [];

  for (const job of jobs) {
    const now = new Date().toISOString();
    const claimed = await claimDiscoveryJobLease(job, now);
    if (!claimed) continue;
    const { lease, runRef, jobData, runDocumentData, runData } = claimed;
    let currentLease = lease;

    try {
      if (asString(job.data.type) === COMMUNITY_DISCOVERY_JOB_TYPE) {
        const community = await materializeCommunityDiscoveryRun(job.id, runData, job.ref, runRef, lease);
        processed.push({
          runId: job.id,
          jobRef: job.ref.path,
          runRef: runRef.path,
          status: community.status,
          candidatesWritten: community.candidatesWritten,
          emailsFound: 0,
        });
        continue;
      }
      const scheduledShortfall = assertScheduledShortfallAuthorityMarkers({ ...job, data: jobData }, runRef, runDocumentData);
      const materialized = await materializeYtDiscoveryRun(
        runData,
        DEFAULT_YT_DISCOVERY_MATERIALIZE_DEPENDENCIES,
        scheduledShortfall ? VALIDATED_SCHEDULED_SHORTFALL_AUTHORITY : undefined,
      );
      currentLease = await assertAndHeartbeatCommunityDiscoveryLease(job.ref, currentLease);
      const completedAtIso = new Date().toISOString();
      const candidatesWritten = materialized.results.length;
      const emailsFound = emailReadyCount(materialized.results);
      // R23-2b: created 만 신선율이다 — candidatesWritten 은 merge 도 섞여 있어 "죽은 쿼리" 판정의
      // 근거가 될 수 없다(실측: candidatesWritten 24 가 전부 merge 였는데 24 로 잡힌 사례).
      const newUnique = Math.max(0, materialized.newUnique ?? 0);
      // BLOCKER-2(i) [적대적 리뷰 프로브 C1 실측 수정]: newUnique=0 을 반환하는 경로 중 일부(백필
      // 모드·쿼터 소진 폴백·커뮤니티 인계)는 **검색을 하지 않았다** — 그런데도 그대로 원장에
      // 기록되면 슬라이스가 억울하게 7일 은퇴된다(403 quotaLimited 주입 → 백필 1건 적재 +
      // newUnique=0 → 원장 기록 → 은퇴 재현 확인). materializeYtDiscoveryRun 이 실제로 검색을
      // 수행했을 때만(searched:true) 원장에 은퇴 판정 근거를 남긴다.
      const searched = materialized.searched === true;
      // W42 F-1: 수확은 살렸지만 계획한 페이지를 다 못 돈 pass 는 기존 `partial` 로 남긴다(새 상태값
      // 0). 캠페인 ytDlpWorkflow.status 는 다른 축이라 건드리지 않는다 — campaign-refill-status.ts 가
      // 그 값으로 카드 가시성을 판정해서, 여기서 바꾸면 부분 수확 캠페인의 보충 카드가 숨는다.
      const completionStatus = materialized.harvestPartial ? "partial" : "complete";
      const existingCounters = asRecord(runData.counters);
      const counters = {
        scanned: asNumber(existingCounters.scanned) ?? candidatesWritten,
        excludedByIncludedCountries: asNumber(existingCounters.excludedByIncludedCountries) ?? 0,
        excludedByExplicitCountry: asNumber(existingCounters.excludedByExplicitCountry) ?? 0,
        unknownCountryHeld: asNumber(existingCounters.unknownCountryHeld) ?? 0,
        candidatesWritten,
        newUnique,
        emailReady: emailsFound,
        kpiRemaining: Math.max(0, boundedInt(runData.resultLimit, candidatesWritten, 0, DISCOVERY_RESULT_LIMIT_MAX) - emailsFound),
        scannedVideos: asNumber(existingCounters.scannedVideos) ?? 0,
        discoveredChannels: candidatesWritten,
        skippedKnownChannels: asNumber(existingCounters.skippedKnownChannels) ?? 0,
        commentsCollected: asNumber(existingCounters.commentsCollected) ?? 0,
        emailsFound,
        // W63 Phase 0 [API-only 기준선]: hydration 절단 실측 + **net-new email-ready**.
        //   raw 볼륨(candidatesWritten·discoveredChannels)은 merge 를 섞고 있어 기준선이 못 된다
        //   (R23-2b 가 같은 이유로 newUnique 를 도입했다). yt-dlp 가 이겨야 하는 숫자는
        //   "이번 런이 **처음 보는 사람 중 메일 보낼 수 있는 사람**을 몇 명 늘렸나"다.
        //
        // W63 델타 M2 [주석 방향이 반대였다]: min(newUnique, emailsFound) 는 두 집합의 **교집합
        //   상한**이다. 실제 교집합은 이보다 작을 수 있으므로 이 값은 위로 틀린다 — 그런데 종전
        //   주석은 "부풀리지 않는 방향으로만 틀린다"고 정반대로 적혀 있었다. 기준선을 실제보다
        //   높게 잡으면 yt-dlp 가 넘어야 할 문턱이 과대평가되고, 그 판단이 통째로 틀어진다.
        //   이름도 상한임을 드러내게 바꾼다 — 필드명이 값의 성격을 숨기면 소비자가 오해한다.
        netNewEmailReadyUpperBound: Math.min(newUnique, emailsFound),
        hydrationSeen: materialized.hydrationOverflow?.seen ?? 0,
        // M3: 계획(attempted)과 실제(succeeded)를 나눠 싣는다. 한 축만 있으면 쿼터 절단 런의
        //   손실이 보이지 않는다.
        hydrationAttempted: materialized.hydrationOverflow?.attempted ?? 0,
        hydrationSucceeded: materialized.hydrationOverflow?.succeeded ?? 0,
        hydrationDropped: materialized.hydrationOverflow?.dropped ?? 0,
        hydrationUnfetched: materialized.hydrationOverflow?.unfetched ?? 0,
        hydrationCapped: materialized.hydrationOverflow?.capped === true,
        // W115 A2: 프리필터가 아낀 조회 수. `hydrationDropped`(상한 손실)와 반드시 분리해서 본다 —
        //   합치면 "상한을 더 올려야 하나"의 판단이 절약분만큼 위로 틀어진다.
        hydrationKnownSkipped: materialized.hydrationOverflow?.knownSkipped ?? 0,
        // W115 C1 (COST-P0-006): 이 런이 실제로 태운 유닛과 설명란 순증분.
        unitsSpent: Math.max(0, Math.trunc(materialized.unitsSpent ?? 0)),
        videoDescriptionEmails: Math.max(0, Math.trunc(materialized.videoDescriptionEmails ?? 0)),
      };
      const campaignId = asString(runData.campaignId);
      const sliceHash = asString(runData.sliceHash);
      // W9-1: 이전 retry가 이미 태운 실패 콜은 같은 잡의 분모에 합친다. 성공 retry의 created
      // numerator는 그대로 두고, 실패 시도만 사라져 수익률이 부풀지 않게 한다.
      const priorArmEvidence = readSliceArmFailureEvidence(runData.materialization);
      const sliceArmStats = materialized.sliceArmStats ?? priorArmEvidence.sliceArmStats;
      const sliceArmCalls = mergeSliceArmCalls(priorArmEvidence.sliceArmCalls, materialized.sliceArmCalls);
      const sliceArmObservability = sliceArmCalls
        ? computeSliceArmObservability(runData.sliceArmSlots, sliceArmCalls)
        : materialized.sliceArmObservability;
      await adminDb.runTransaction(async (transaction) => {
        const currentJob = await transaction.get(job.ref);
        const currentJobData = currentJob.data() ?? {};
        if (!currentJob.exists || !leaseMatches(currentJobData, currentLease) || (asString(currentJobData.leaseExpiresAtIso) ?? "") <= completedAtIso) {
          throw Object.assign(new Error("aborted: discovery completion lost its lease"), { code: "aborted", errorCode: "process_discovery_queue_discovery_completion_lost_its_lease" });
        }
        // R23-2b: 쿼리 원장 갱신은 이 잡이 실제로 슬라이스 해시를 들고 왔을 때만(enqueue 시점에
        // admin.ts 가 계산해 stamp 함) — 트랜잭션 내 쓰기 전에 먼저 읽어야 하므로 다른 get() 과 함께
        // 여기서 수행한다. BLOCKER-2(i): 검색을 안 한 잡(searched:false)이면 원장을 아예 안 건드리므로
        // 이 읽기도 하지 않는다(낭비 회피).
        const campaignSnapshot = campaignId && sliceHash && searched
          ? await transaction.get(adminDb.collection("campaigns").doc(campaignId))
          : null;
        transaction.set(runRef, {
        status: completionStatus,
        completedAtIso,
        counters,
        candidateSnapshot: discoveryCandidateSnapshot(materialized.results),
        ...(materialized.truncatedByQuota ? { truncatedByQuota: true } : {}),
        materialization: {
          source: materialized.source,
          candidatesWritten,
          newUnique,
          merged: Math.max(0, candidatesWritten - newUnique),
          emailsFound,
          ...(sliceArmStats ? { sliceArmStats } : {}),
          ...(sliceArmCalls ? { sliceArmCalls } : {}),
          ...(sliceArmObservability ? { sliceArmObservability } : {}),
          // W115 C1: 다음 pass 의 **비용 정규화 배분**이 읽는 축(admin.ts costNormalizedArmWeights).
          //   sliceArmStats 옆에 두는 이유: 두 값의 분모(같은 잡)가 같아야 유닛/이메일이 성립한다.
          ...(materialized.laneCostYield ? { laneCostYield: materialized.laneCostYield } : {}),
          ...(materialized.unitsSpent !== undefined ? { unitsSpent: materialized.unitsSpent } : {}),
          ...(materialized.classifiedIn !== undefined ? { classifiedIn: materialized.classifiedIn } : {}),
          ...(materialized.classifiedOut !== undefined ? { classifiedOut: materialized.classifiedOut } : {}),
          ...(materialized.classificationExceptions !== undefined ? { classificationExceptions: materialized.classificationExceptions } : {}),
          ...(materialized.truncatedByQuota ? { truncatedByQuota: true } : {}),
          // W42 F-1 관측: 수확 건수·실패 페이지 번호·실패 사유를 런/잡 문서에 남긴다.
          ...(materialized.harvestPartial ? { harvestPartial: materialized.harvestPartial } : {}),
        },
        updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.set(job.ref, {
        status: completionStatus,
        completedAtIso,
        counters,
        ...(materialized.truncatedByQuota ? { truncatedByQuota: true } : {}),
        materialization: {
          source: materialized.source,
          candidatesWritten,
          newUnique,
          merged: Math.max(0, candidatesWritten - newUnique),
          emailsFound,
          ...(sliceArmStats ? { sliceArmStats } : {}),
          ...(sliceArmCalls ? { sliceArmCalls } : {}),
          ...(sliceArmObservability ? { sliceArmObservability } : {}),
          // W115 C1: 다음 pass 의 **비용 정규화 배분**이 읽는 축(admin.ts costNormalizedArmWeights).
          //   sliceArmStats 옆에 두는 이유: 두 값의 분모(같은 잡)가 같아야 유닛/이메일이 성립한다.
          ...(materialized.laneCostYield ? { laneCostYield: materialized.laneCostYield } : {}),
          ...(materialized.unitsSpent !== undefined ? { unitsSpent: materialized.unitsSpent } : {}),
          ...(materialized.classifiedIn !== undefined ? { classifiedIn: materialized.classifiedIn } : {}),
          ...(materialized.classifiedOut !== undefined ? { classifiedOut: materialized.classifiedOut } : {}),
          ...(materialized.classificationExceptions !== undefined ? { classificationExceptions: materialized.classificationExceptions } : {}),
          ...(materialized.truncatedByQuota ? { truncatedByQuota: true } : {}),
          // W42 F-1 관측: 수확 건수·실패 페이지 번호·실패 사유를 런/잡 문서에 남긴다.
          ...(materialized.harvestPartial ? { harvestPartial: materialized.harvestPartial } : {}),
        },
        leaseOwner: FieldValue.delete(),
        leaseToken: FieldValue.delete(),
        leaseExpiresAtIso: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        if (campaignId) {
          // BLOCKER-2(i): searched 가 false 면 이 잡은 무엇을 근거로도 "이 슬라이스가 죽었다"고 말할
          // 수 없다 — 원장 기록 자체를 건너뛴다(기존 원장 값이 있으면 그대로 둔다, 덮어쓰지 않는다).
          // W115 C1 [이름/값 불일치 수정]: 이 필드는 "유닛"을 자칭하면서 실제로는
          //   `resultLimit`(결과 **건수**)를 담고 있었다 — 100배 척도가 다른 값이라 쿼리
          //   슬라이스의 비용 판단에 쓸 수 없었다. 이제 런이 실제로 태운 유닛을 싣는다.
          // W115-R1 [한 줄 수리]: `||` 는 **측정된 0** 을 폴백으로 뒤집는다 — 쿼터가 말라 한 콜도
          //   못 쏜 런(unitsSpent === 0)이 resultLimit(예: 750)을 유닛으로 보고했다. 그 런은
          //   비용이 0 인 것이 사실이고, 0 은 폴백 사유가 아니다. 계측 유무로만 갈린다(`??`).
          const measuredUnitsSpent = typeof materialized.unitsSpent === "number" && Number.isFinite(materialized.unitsSpent)
            ? Math.max(0, Math.trunc(materialized.unitsSpent))
            : null;
          const queryLedgerWrite = sliceHash && searched
            ? queryLedgerUpsertWrite(
              asRecord(asRecord(campaignSnapshot?.data()?.shortfallDiscoveryState).queryLedger),
              sliceHash,
              {
                lastRunAtIso: completedAtIso,
                newUnique,
                unitsSpentEstimate: measuredUnitsSpent
                  ?? boundedInt(runData.resultLimit, 0, 0, DISCOVERY_RESULT_LIMIT_MAX),
                unitsSpentEstimateSource: measuredUnitsSpent === null ? "legacy" : "measured",
              },
            )
            : null;
          transaction.set(adminDb.collection("campaigns").doc(campaignId), {
          ytDlpWorkflow: {
            status: "complete",
            runRef: runRef.path,
            jobRef: job.ref.path,
            completedAtIso,
            candidatesWritten,
            newUnique,
            emailsFound,
            // 코덱스 라운드2 MEDIUM 수리: status 자체은 건드리지 않는다(위 주석 — 카드 가시성이
            // 그 값에 걸려 있다). 대신 이 필드를 **추가**해서 "0건인데 진짜 검색했다"와 "헤세 결정
            // primary-lane 이라 애초에 안 돌았다"를 구분 가능하게 남긴다.
            // 코덱스 라운드3 MEDIUM 수리: 이 문서는 {merge:true} 로 쓴다 — 스킵이 아닐 때 필드를
            // 그냥 생략하면 이전 pass 가 남긴 skippedReason 이 그대로 남아, 방금 진짜 검색이
            // 돌았는데도 "primary-lane 스킵"으로 계속 보인다. 아닐 때는 명시적으로 지운다.
            skippedReason: materialized.source === "ytdlp-primary-lane-skip"
              ? "ytdlp_primary_lane"
              : FieldValue.delete(),
          },
          ...(queryLedgerWrite ? { shortfallDiscoveryState: { queryLedger: queryLedgerWrite } } : {}),
          updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }
      });
      processed.push({ runId: job.id, jobRef: job.ref.path, runRef: runRef.path, status: completionStatus, candidatesWritten, emailsFound });
    } catch (error) {
      const failedAtIso = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const failureEvidence = readSliceArmFailureEvidence(error);
      if (asString(job.data.type) === COMMUNITY_DISCOVERY_JOB_TYPE) {
        try {
          await assertFreshCommunityDiscoveryAuthority(exactStoredCommunityScope(runData));
        } catch {
          processed.push({
            runId: job.id,
            jobRef: job.ref.path,
            runRef: runRef.path,
            status: "retry",
            candidatesWritten: 0,
            emailsFound: 0,
            error: message,
          });
          continue;
        }
      }
      const latestRun = asString(job.data.type) === COMMUNITY_DISCOVERY_JOB_TYPE
        ? await runRef.get().catch(() => null)
        : null;
      const latestRunData = latestRun?.data() ?? {};
      const publicationRetry = asString(job.data.type) === COMMUNITY_DISCOVERY_JOB_TYPE
        && (asString(latestRunData.artifactStatus) === "complete" || asString(latestRunData.artifactStatus) === "partial");
      const retryable = isRetryableDiscoveryError(message) || publicationRetry;
      const terminal = !retryable || currentLease.attempt >= COMMUNITY_DISCOVERY_MAX_ATTEMPTS;
      const retryAfterIso = terminal ? undefined : new Date(Date.now() + DISCOVERY_RETRY_BACKOFF_MS).toISOString();
      const settlement = await adminDb.runTransaction(async (transaction) => {
        const current = await transaction.get(job.ref);
        const currentData = current.data() ?? {};
        const currentLeaseExpiry = asString(currentData.leaseExpiresAtIso);
        if (
          !current.exists
          || !leaseMatches(currentData, currentLease)
          || !currentLeaseExpiry
          || currentLeaseExpiry <= failedAtIso
        ) return "lease_lost" as const;
        const priorArmEvidence = readSliceArmFailureEvidence(currentData.materialization);
        const failedSliceArmCalls = mergeSliceArmCalls(priorArmEvidence.sliceArmCalls, failureEvidence.sliceArmCalls);
        const armEvidencePatch = failedSliceArmCalls
          ? {
              materialization: {
                ...asRecord(currentData.materialization),
                sliceArmStats: failureEvidence.sliceArmStats ?? priorArmEvidence.sliceArmStats ?? emptySliceArmStats(),
                sliceArmCalls: failedSliceArmCalls,
                sliceArmObservability: computeSliceArmObservability(
                  currentData.sliceArmSlots ?? runData.sliceArmSlots,
                  failedSliceArmCalls,
                ),
              },
            }
          : {};
        if (!terminal && retryAfterIso) {
          const retryJob = {
            status: "queued",
            phase: publicationRetry ? "publish" : (asString(currentData.phase) ?? "collect"),
            lastError: message,
            ...armEvidencePatch,
            retryAfterIso,
            retryCount: FieldValue.increment(1),
            leaseOwner: FieldValue.delete(),
            leaseToken: FieldValue.delete(),
            leaseExpiresAtIso: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          };
          transaction.set(job.ref, retryJob, { merge: true });
          transaction.set(runRef, publicationRetry
            ? { publicationStatus: "retry", publicationError: message, retryAfterIso, updatedAt: FieldValue.serverTimestamp() }
            : { ...retryJob, status: "queued" }, { merge: true });
          return "retry" as const;
        }
        const terminalStatus = retryable ? "dead_letter" : "failed";
        const failed = {
          status: terminalStatus,
          terminalStatus: "failed",
          failedAtIso,
          error: message,
          ...armEvidencePatch,
          leaseOwner: FieldValue.delete(),
          leaseToken: FieldValue.delete(),
          leaseExpiresAtIso: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        };
        transaction.set(runRef, publicationRetry
          ? { ...failed, publicationStatus: terminalStatus, publicationError: message }
          : failed, { merge: true });
        transaction.set(job.ref, failed, { merge: true });
        return terminalStatus;
      });
      if (settlement === "lease_lost") {
        processed.push({ runId: job.id, jobRef: job.ref.path, runRef: runRef.path, status: "retry", candidatesWritten: 0, emailsFound: 0, error: "lease_lost_before_failure_settlement" });
        continue;
      }
      if (asString(job.data.type) === COMMUNITY_DISCOVERY_JOB_TYPE) {
        await persistCommunityDiscoveryReceipt({
          runId: job.id,
          lease: currentLease,
          phase: publicationRetry ? "publish" : "collect",
          status: settlement === "retry" ? "retry" : "failed",
          message,
        }).catch(() => undefined);
      }
      processed.push({
        runId: job.id,
        jobRef: job.ref.path,
        runRef: runRef.path,
        status: settlement,
        candidatesWritten: 0,
        emailsFound: 0,
        error: message,
        ...(retryAfterIso ? { retryAfterIso } : {}),
      });
    }
  }

  // A4: 세그먼트 노출률 집계는 **이 워커에 편승**한다(신규 스케줄 0 — 스케줄 표면을 늘리지 않는다).
  //   잡 처리와 독립이므로 큐가 비어 있어도 돈다. 실패해도 삼킨다: 이건 랭킹의 근거를 갱신하는
  //   부가 레인이고, 여기서 던지면 이미 처리한 잡의 결과 보고가 통째로 날아간다.
  await refreshSegmentEmailRates(new Date().toISOString()).catch((error: unknown) => {
    console.warn("[discovery-segment-rates] refresh failed", {
      errorCode: (error as { code?: unknown } | null)?.code ?? "unknown",
    });
    return null;
  });

  return { ok: true, scanned: queuedDocs.length, recoveredStale, processed };
}

type CommunityDiscoveryEnqueueSource = "callable" | "scheduled";

type CommunityDiscoveryEnqueueContext = {
  readonly data?: unknown;
  readonly context: GuardContext;
  readonly source: CommunityDiscoveryEnqueueSource;
  readonly action: "queueCommunityDiscovery" | "scheduledCommunityDiscovery";
  readonly enforceCooldown?: boolean;
  readonly nowIso?: string;
};

function shouldRespectCommunityDiscoveryCooldown(data: unknown): boolean {
  const record = asRecord(data);
  return asBoolean(record.respectCooldown, false) || asString(record.trigger) === "feed_refresh";
}

function scheduledCommunitySources(feedSettings: FeedSettingsInput): CommunitySource[] {
  const platformSources = (feedSettings.platforms ?? [])
    .map(normalizeCommunitySource)
    .filter((source): source is CommunitySource => Boolean(source));
  const sources = platformSources.filter((source) => source !== "steam" || (feedSettings.steamAppIds ?? []).length > 0);
  if ((feedSettings.steamAppIds ?? []).length > 0 && !sources.includes("steam")) sources.push("steam");
  return sources.length > 0 ? sources : ["reddit", "discord", "x", "web"];
}

function scheduledCommunityDiscoveryData(feedSettings: FeedSettingsInput): Record<string, unknown> {
  const sources = scheduledCommunitySources(feedSettings);
  const requestWindow = new Date().toISOString().slice(0, 10);
  return {
    campaignRef: "campaigns/community_discovery",
    gameId: "flu-feed",
    ownedGameTags: feedSettings.ownedGameTags ?? [],
    similarGameTags: feedSettings.similarGameTags ?? [],
    ugcKeywords: feedSettings.ugcKeywords ?? [],
    communitySubreddits: feedSettings.communitySubreddits ?? [],
    officialChannels: feedSettings.officialChannels ?? [],
    communityRefreshHours: feedSettings.communityRefreshHours ?? 24,
    sources,
    includeComments: true,
    resultLimit: 50,
    requestWindow,
    filters: {
      recentActivityDays: feedSettings.freshnessDays ?? 14,
      platforms: sources,
    },
  };
}

function systemCommunityDiscoveryContext(): GuardContext {
  return {
    userId: "system:scheduled-community-discovery",
    role: "super_admin",
    team: "system",
    ip: "scheduler",
  };
}

export async function queueCommunityDiscovery(request: CallableRequest) {
  return enqueueCommunityDiscovery({
    data: request.data,
    context: requireDiscoveryWriteRole(request, "community discovery queue"),
    source: "callable",
    action: "queueCommunityDiscovery",
    enforceCooldown: shouldRespectCommunityDiscoveryCooldown(request.data),
  });
}

export async function scheduledCommunityDiscovery() {
  const settings = await readSettings();
  return enqueueCommunityDiscovery({
    data: scheduledCommunityDiscoveryData(settings.feed),
    context: systemCommunityDiscoveryContext(),
    source: "scheduled",
    action: "scheduledCommunityDiscovery",
    enforceCooldown: true,
  });
}

type CommunityDiscoveryRunProvenance = {
  sourceRunId: string;
  sourceRunRef: string;
  scopedContext: ScopedCampaignDiscoveryContext | null;
};

type CommunityDiscoveryCompletionStatus = "complete" | "partial";

type CommunityDiscoveryLease = {
  attempt: number;
  leaseOwner: string;
  leaseToken: string;
  leaseExpiresAtIso: string;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

const COMMUNITY_ACTION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function communityDiscoveryActionId(rawData: unknown, source: CommunityDiscoveryEnqueueSource): string {
  const raw = asRecord(rawData);
  if (source === "scheduled") {
    const requestWindow = asString(raw.requestWindow) ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestWindow)) {
      throw new Error("invalid-argument: scheduled community discovery requires a date requestWindow");
    }
    return `scheduled:${requestWindow}`;
  }
  const actionId = asString(raw.actionId) ?? "";
  if (!COMMUNITY_ACTION_UUID.test(actionId)) {
    throw Object.assign(new Error("invalid-argument: manual community discovery requires an action UUID"), { code: "invalid-argument", errorCode: "community_discovery_action_id_manual_community_discovery_requires" });
  }
  return actionId.toLowerCase();
}

function communityDiscoveryRequestPayload(
  data: ParsedCommunityDiscoveryData,
  rawData: unknown,
  source: CommunityDiscoveryEnqueueSource,
): Record<string, unknown> {
  const raw = asRecord(rawData);
  return {
    programId: resolveCanonicalProgramId(data.programId) || null,
    campaignId: data.campaignId ?? null,
    campaignRef: data.campaignRef,
    gameId: data.gameId,
    brief: data.brief,
    keywords: data.keywords,
    ownedGameTags: data.ownedGameTags,
    similarGameTags: data.similarGameTags,
    ugcKeywords: data.ugcKeywords,
    communitySubreddits: data.communitySubreddits,
    officialChannels: data.officialChannels,
    steamAppIds: data.steamAppIds,
    steamLanguage: data.steamLanguage,
    communityRefreshHours: data.communityRefreshHours,
    sources: data.sources,
    filters: data.filters,
    resultLimit: data.resultLimit,
    includeComments: data.includeComments,
    actionId: communityDiscoveryActionId(rawData, source),
    requestWindow: asString(raw.requestWindow) ?? null,
  };
}

export function communityDiscoveryRequestIdentity(input: {
  actorUid: string;
  canonicalProgramId: string | null;
  campaignId: string | null;
  requestPayload: Record<string, unknown>;
}): { requestHash: string; runId: string } {
  const requestHash = createHash("sha256").update(canonicalJson(input.requestPayload)).digest("hex");
  const runDigest = createHash("sha256").update(canonicalJson({
    actorUid: input.actorUid,
    canonicalProgramId: input.canonicalProgramId ?? COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
    campaignId: input.campaignId ?? COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
    requestHash,
  })).digest("hex");
  return { requestHash, runId: `community_${runDigest.slice(0, 40)}` };
}

function communityArtifactDocumentId(runId: string, artifactGenerationId: string, artifactId: string): string {
  return `${runId}__${createHash("sha256").update(canonicalJson({ artifactGenerationId, artifactId })).digest("hex").slice(0, 40)}`;
}

export function communityPublicationPointerId(input: {
  canonicalProgramId: string | null;
  campaignId: string | null;
}): string {
  return `community_pointer_${createHash("sha256").update(canonicalJson({
    contractVersion: COMMUNITY_PUBLICATION_CONTRACT_VERSION,
    canonicalProgramId: input.canonicalProgramId ?? COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
    campaignId: input.campaignId ?? COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
  })).digest("hex").slice(0, 40)}`;
}

export function communityPublicationGenerationId(input: {
  sourceRunId: string;
  canonicalProgramId: string | null;
  campaignId: string | null;
  attempt: number;
  leaseToken: string;
}): string {
  return `community_generation_${createHash("sha256").update(canonicalJson({
    contractVersion: COMMUNITY_PUBLICATION_CONTRACT_VERSION,
    sourceRunId: input.sourceRunId,
    canonicalProgramId: input.canonicalProgramId ?? COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
    campaignId: input.campaignId ?? COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
    attempt: input.attempt,
    leaseToken: input.leaseToken,
  })).digest("hex").slice(0, 48)}`;
}

export function communityPostHeadId(input: {
  canonicalProgramId: string | null;
  campaignId: string | null;
  sourceIdentity: string;
  publicationGenerationId?: string;
}): string {
  const generationId = input.publicationGenerationId ?? "legacy";
  return `community_post_${createHash("sha256").update(canonicalJson({
    contractVersion: COMMUNITY_PUBLICATION_CONTRACT_VERSION,
    generationId,
    canonicalProgramId: input.canonicalProgramId ?? COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
    campaignId: input.campaignId ?? COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
    sourceIdentity: input.sourceIdentity,
  })).digest("hex").slice(0, 48)}`;
}

function communityCandidateGenerationDocumentId(publicationGenerationId: string, candidateId: string): string {
  return `community_candidate_${createHash("sha256").update(canonicalJson({
    contractVersion: COMMUNITY_PUBLICATION_CONTRACT_VERSION,
    publicationGenerationId,
    candidateId,
  })).digest("hex").slice(0, 48)}`;
}

function withoutCommunityArtifactMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const next = { ...value };
  delete next.artifactRef;
  delete next.artifactStatus;
  delete next.updatedAt;
  return next;
}

const COMMUNITY_SOURCE_IDENTITY_PATTERN = /^community_source_v2_[a-f0-9]{64}$/;

function uniqueCommunityRecordsBySourceIdentity(
  records: readonly Record<string, unknown>[],
  recordKind: "post" | "candidate",
): Record<string, unknown>[] {
  const seenSourceIdentities = new Set<string>();
  const seenRecordIds = new Set<string>();
  const uniqueRecords: Record<string, unknown>[] = [];
  for (const record of records) {
    const recordId = asString(record.id) ?? "";
    const sourceIdentity = asString(record.sourceIdentity) ?? "";
    if (!recordId || !COMMUNITY_SOURCE_IDENTITY_PATTERN.test(sourceIdentity)) {
      throw new Error(`failed-precondition: community ${recordKind} requires a stable record and source identity`);
    }
    if (seenSourceIdentities.has(sourceIdentity) || seenRecordIds.has(recordId)) continue;
    seenSourceIdentities.add(sourceIdentity);
    seenRecordIds.add(recordId);
    uniqueRecords.push(record);
  }
  return uniqueRecords;
}

/** Materialize run-versioned artifacts without exposing them to product reads. */
export function buildCommunityDiscoveryArtifactWrites(input: {
  posts: readonly Record<string, unknown>[];
  candidates: readonly Record<string, unknown>[];
  provenance: CommunityDiscoveryRunProvenance;
  queuedAtIso: string;
  artifactGenerationId?: string;
}): CommunityDiscoveryArtifactWrite[] {
  const { sourceRunId, sourceRunRef, scopedContext } = input.provenance;
  if (!sourceRunId || sourceRunRef !== `discovery_runs/${sourceRunId}`) {
    throw new Error("failed-precondition: exact community discovery run provenance is required");
  }
  const artifactGenerationId = asString(input.artifactGenerationId) || sourceRunId;
  const scopeFields = scopedContext ?? {
    canonicalProgramId: COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
    programId: COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
    programRef: null,
    campaignId: COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
    campaignRef: null,
  };
  const posts = uniqueCommunityRecordsBySourceIdentity(input.posts, "post");
  const candidates = uniqueCommunityRecordsBySourceIdentity(input.candidates, "candidate");
  const artifactWrites: CommunityDiscoveryArtifactWrite[] = posts.map((post) => {
    const postId = asString(post.id);
    if (!postId) throw new Error("failed-precondition: community post identity is required");
    return (batch) => {
      const artifactRef = adminDb.collection("community_post_artifacts").doc(communityArtifactDocumentId(sourceRunId, artifactGenerationId, postId));
      batch.set(artifactRef, {
        ...post,
        ...scopeFields,
        artifactRef: artifactRef.path,
        artifactStatus: "materialized",
        artifactGenerationId,
        sourceRunId,
        sourceRunRef,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    };
  });

  for (const candidate of candidates) {
    const candidateId = asString(candidate.id) ?? "";
    if (!candidateId) throw new Error("failed-precondition: community candidate identity is required");
    artifactWrites.push((batch) => {
      const artifactRef = adminDb.collection("community_candidate_artifacts").doc(communityArtifactDocumentId(sourceRunId, artifactGenerationId, candidateId));
      batch.set(artifactRef, {
        ...candidate,
        ...scopeFields,
        artifactRef: artifactRef.path,
        artifactStatus: "materialized",
        artifactGenerationId,
        sourceRunId,
        sourceRunRef,
        updatedAtIso: input.queuedAtIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
  }

  return artifactWrites;
}

export function buildCommunityDiscoveryPublicationWrites(input: {
  posts: readonly Record<string, unknown>[];
  candidates: readonly Record<string, unknown>[];
  provenance: CommunityDiscoveryRunProvenance;
  completedStatus: CommunityDiscoveryCompletionStatus;
  publishedAtIso: string;
  publicationGenerationId: string;
}): CommunityDiscoveryArtifactWrite[] {
  const { sourceRunId, sourceRunRef, scopedContext } = input.provenance;
  if (!sourceRunId || sourceRunRef !== `discovery_runs/${sourceRunId}`) {
    throw new Error("failed-precondition: exact community discovery publication provenance is required");
  }
  if (input.completedStatus !== "complete" && input.completedStatus !== "partial") {
    throw new Error("failed-precondition: community discovery publication requires a completed run");
  }
  const canonicalProgramId = scopedContext?.canonicalProgramId ?? COMMUNITY_DISCOVERY_GLOBAL_SCOPE;
  const campaignId = scopedContext?.campaignId ?? COMMUNITY_DISCOVERY_GLOBAL_SCOPE;
  const publicationGenerationId = asString(input.publicationGenerationId) ?? "";
  if (!/^community_generation_[a-f0-9]{48}$/.test(publicationGenerationId)) {
    throw new Error("failed-precondition: community publication generation identity is invalid");
  }
  const publicationGenerationRef = `community_publication_generations/${publicationGenerationId}`;
  const writes: CommunityDiscoveryArtifactWrite[] = [];
  const posts = uniqueCommunityRecordsBySourceIdentity(input.posts, "post");
  const candidates = uniqueCommunityRecordsBySourceIdentity(input.candidates, "candidate");

  for (const post of posts) {
    const sourceIdentity = asString(post.sourceIdentity) ?? "";
    const artifactRef = asString(post.artifactRef);
    if (!COMMUNITY_SOURCE_IDENTITY_PATTERN.test(sourceIdentity) || !artifactRef?.startsWith("community_post_artifacts/")) {
      throw new Error("failed-precondition: community post publication requires a stable source identity and artifact ref");
    }
    const headId = communityPostHeadId({ canonicalProgramId, campaignId, sourceIdentity, publicationGenerationId });
    const publishedPost = withoutCommunityArtifactMetadata(post);
    writes.push((batch) => {
      batch.set(adminDb.collection("community_posts").doc(headId), {
        ...publishedPost,
        id: headId,
        canonicalProgramId,
        programId: canonicalProgramId,
        programRef: scopedContext?.programRef ?? null,
        campaignId,
        campaignRef: scopedContext?.campaignRef ?? null,
        sourceIdentity,
        sourceArtifactRef: artifactRef,
        sourceRunId,
        sourceRunRef,
        sourceRunStatus: input.completedStatus,
        publicationStatus: "published",
        publicationGenerationId,
        publicationGenerationRef,
        publicationContractVersion: COMMUNITY_PUBLICATION_CONTRACT_VERSION,
        publishedAtIso: input.publishedAtIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
  }

  for (const candidate of candidates) {
    const candidateId = asString(candidate.id) ?? "";
    const artifactRef = asString(candidate.artifactRef);
    if (!candidateId || !artifactRef?.startsWith("community_candidate_artifacts/")) {
      throw new Error("failed-precondition: community candidate publication requires an identity and artifact ref");
    }
    const publishedCandidate = withoutCommunityArtifactMetadata(candidate);
    const plan = scopedContext
      ? buildProgramScopedCandidateParticipationWrites({
        candidate: publishedCandidate,
        canonicalProgramId: scopedContext.canonicalProgramId,
        campaignId: scopedContext.campaignId,
        sourceRunId,
        sourceRunRef,
      })
      : null;
    const generationCandidate = plan?.participationData ?? {
      ...globalCandidateIdentityData(publishedCandidate),
      canonicalProgramId,
      programId: canonicalProgramId,
      programRef: null,
      campaignId,
      campaignRef: null,
    };
    writes.push((batch) => {
      const generationRef = adminDb.collection("community_candidate_generations")
        .doc(communityCandidateGenerationDocumentId(publicationGenerationId, candidateId));
      batch.set(generationRef, {
        ...generationCandidate,
        id: plan?.participationRef.slice("campaign_candidates/".length) ?? candidateId,
        campaignCandidateRef: plan?.participationRef ?? null,
        stableCampaignCandidateId: plan?.participationRef.slice("campaign_candidates/".length) ?? candidateId,
        source: "community-discovery",
        sourceArtifactRef: artifactRef,
        sourceRunStatus: input.completedStatus,
        publicationStatus: "published",
        communityGenerationRow: true,
        publicationGenerationId,
        publicationGenerationRef,
        publicationContractVersion: COMMUNITY_PUBLICATION_CONTRACT_VERSION,
        updatedAtIso: input.publishedAtIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
  }
  return writes;
}

async function readCommunityRunArtifacts(runId: string, artifactGenerationId: string): Promise<{
  posts: Record<string, unknown>[];
  candidates: Record<string, unknown>[];
}> {
  const [postSnapshot, candidateSnapshot] = await Promise.all([
    adminDb.collection("community_post_artifacts").where("sourceRunId", "==", runId).get(),
    adminDb.collection("community_candidate_artifacts").where("sourceRunId", "==", runId).get(),
  ]);
  return {
    posts: postSnapshot.docs
      .filter((doc) => asString(doc.get("artifactGenerationId")) === artifactGenerationId)
      .map((doc) => ({ id: asString(doc.get("id")) ?? doc.id, ...doc.data(), artifactRef: doc.ref.path })),
    candidates: candidateSnapshot.docs
      .filter((doc) => asString(doc.get("artifactGenerationId")) === artifactGenerationId)
      .map((doc) => ({ id: asString(doc.get("id")) ?? doc.id, ...doc.data(), artifactRef: doc.ref.path })),
  };
}

function exactStoredCommunityScope(runData: Record<string, unknown>): ScopedCampaignDiscoveryContext | null {
  const campaignId = asString(runData.campaignId);
  if (!campaignId || campaignId === COMMUNITY_DISCOVERY_GLOBAL_SCOPE) return null;
  const canonicalProgramId = resolveCanonicalProgramId(runData.canonicalProgramId ?? runData.programId);
  if (!canonicalProgramId) throw new Error("failed-precondition: queued community run lost its program scope");
  const scope = buildScopedCampaignDiscoveryContext(canonicalProgramId, campaignId);
  if (
    asString(runData.campaignRef) !== scope.campaignRef
    || asString(runData.programRef) !== scope.programRef
    || resolveCanonicalProgramId(runData.programId) !== scope.canonicalProgramId
  ) {
    throw new Error("failed-precondition: queued community run scope is inconsistent");
  }
  return scope;
}

async function assertFreshCommunityDiscoveryAuthority(
  scopedContext: ScopedCampaignDiscoveryContext | null,
): Promise<void> {
  if (!scopedContext) return;
  const authoritative = await resolveAuthoritativeDiscoveryCampaignContext(
    scopedContext.campaignId,
    scopedContext.campaignRef,
  );
  if (!authoritative || authoritative.canonicalProgramId !== scopedContext.canonicalProgramId) {
    throw Object.assign(new Error("failed-precondition: community campaign ownership changed during execution"), {
      code: "failed-precondition", errorCode: "assert_fresh_community_discovery_authority_community_campaign",
    });
  }
}

const RETIRED_DISCOVERY_PROGRAM_STATUSES = new Set(["deleted", "archived", "inactive", "closed"]);
const RETIRED_DISCOVERY_CAMPAIGN_STATUSES = new Set(["deleted", "archived", "closed", "inactive", "completed"]);

function discoveryAuthorityDocumentRetired(data: Record<string, unknown>, statuses: ReadonlySet<string>): boolean {
  return Boolean(data.deletedAt || data.deletedAtIso || data.archivedAt || data.archivedAtIso)
    || data.active === false || data.visible === false
    || statuses.has((asString(data.status) ?? "").trim().toLowerCase());
}

async function validateScopedCommunityMutationAuthority(
  transaction: FirebaseFirestore.Transaction,
  input: {
    jobRef: FirebaseFirestore.DocumentReference;
    runRef: FirebaseFirestore.DocumentReference;
    lease: CommunityDiscoveryLease;
    scopedContext: ScopedCampaignDiscoveryContext;
    nowIso: string;
  },
): Promise<void> {
  const [job, run, campaign, program] = await Promise.all([
    transaction.get(input.jobRef),
    transaction.get(input.runRef),
    transaction.get(adminDb.collection("campaigns").doc(input.scopedContext.campaignId)),
    transaction.get(adminDb.collection("programs").doc(input.scopedContext.canonicalProgramId)),
  ]);
  const jobData = job.data() ?? {};
  const runData = run.data() ?? {};
  if (!job.exists || !leaseMatches(jobData, input.lease)
    || (asString(jobData.leaseExpiresAtIso) ?? "") <= input.nowIso) {
    throw Object.assign(new Error("aborted: community discovery mutation lost its lease"), { code: "aborted", errorCode: "validate_scoped_community_mutation_authority_community_discovery" });
  }
  const runScope = run.exists ? exactStoredCommunityScope(runData) : null;
  if (!runScope || runScope.campaignId !== input.scopedContext.campaignId
    || runScope.canonicalProgramId !== input.scopedContext.canonicalProgramId) {
    throw Object.assign(new Error("failed-precondition: community discovery run scope changed during execution"), { code: "failed-precondition", errorCode: "validate_scoped_community_mutation_authority_community_discovery_run" });
  }
  if (!campaign.exists || !program.exists) {
    throw Object.assign(new Error("failed-precondition: community discovery authority is missing"), { code: "failed-precondition", errorCode: "validate_scoped_community_mutation_authority_community_discovery_2" });
  }
  const campaignData = campaign.data() ?? {};
  const programData = program.data() ?? {};
  if (discoveryAuthorityDocumentRetired(campaignData, RETIRED_DISCOVERY_CAMPAIGN_STATUSES)
    || discoveryAuthorityDocumentRetired(programData, RETIRED_DISCOVERY_PROGRAM_STATUSES)) {
    throw Object.assign(new Error("failed-precondition: community discovery authority is not operational"), { code: "failed-precondition", errorCode: "validate_scoped_community_mutation_authority_community_discovery_3" });
  }
  if (resolveCanonicalProgramId(campaignData.canonicalProgramId ?? campaignData.programId) !== input.scopedContext.canonicalProgramId
    || (asString(campaignData.programRef) && asString(campaignData.programRef) !== input.scopedContext.programRef)) {
    throw Object.assign(new Error("failed-precondition: community campaign ownership changed during execution"), { code: "failed-precondition", errorCode: "validate_scoped_community_mutation_authority_community_campaign" });
  }
}

async function commitScopedCommunityDiscoveryWrites(input: {
  writes: readonly CommunityDiscoveryArtifactWrite[];
  jobRef: FirebaseFirestore.DocumentReference;
  runRef: FirebaseFirestore.DocumentReference;
  lease: CommunityDiscoveryLease;
  scopedContext: ScopedCampaignDiscoveryContext;
  beforeTransaction?: (chunkIndex: number) => Promise<void> | void;
}): Promise<number[]> {
  const committed: number[] = [];
  for (let offset = 0; offset < input.writes.length; offset += COMMUNITY_DISCOVERY_ARTIFACT_BATCH_LIMIT) {
    const chunk = input.writes.slice(offset, offset + COMMUNITY_DISCOVERY_ARTIFACT_BATCH_LIMIT);
    await input.beforeTransaction?.(committed.length);
    await adminDb.runTransaction(async (transaction) => {
      const nowIso = new Date().toISOString();
      await validateScopedCommunityMutationAuthority(transaction, { ...input, nowIso });
      for (const write of chunk) write(transaction as unknown as CommunityDiscoveryWriteBatch);
      transaction.set(input.jobRef, {
        heartbeatAtIso: nowIso,
        leaseExpiresAtIso: new Date(Date.parse(nowIso) + COMMUNITY_DISCOVERY_LEASE_MS).toISOString(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    committed.push(chunk.length);
  }
  return committed;
}

async function persistCommunityDiscoveryReceipt(input: {
  runId: string;
  lease: CommunityDiscoveryLease;
  phase: string;
  status: "leased" | "complete" | "partial" | "retry" | "failed";
  message?: string;
}): Promise<void> {
  const id = `${input.runId}__${input.lease.attempt}__${input.phase}__${input.status}`;
  const recordedAtIso = new Date().toISOString();
  await adminDb.collection("discovery_run_receipts").doc(id).set({
    id,
    runId: input.runId,
    runRef: `discovery_runs/${input.runId}`,
    jobRef: `workflow_jobs/${input.runId}`,
    attempt: input.lease.attempt,
    leaseOwner: input.lease.leaseOwner,
    leaseToken: input.lease.leaseToken,
    phase: input.phase,
    status: input.status,
    ...(input.message ? { message: input.message.slice(0, 500) } : {}),
    recordedAtIso,
    expireAt: expireAt180DaysFromIso(recordedAtIso),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

function communityPublicationScope(scopedContext: ScopedCampaignDiscoveryContext | null) {
  return {
    canonicalProgramId: scopedContext?.canonicalProgramId ?? COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
    programId: scopedContext?.canonicalProgramId ?? COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
    programRef: scopedContext?.programRef ?? null,
    campaignId: scopedContext?.campaignId ?? COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
    campaignRef: scopedContext?.campaignRef ?? null,
  };
}

async function markCommunityArtifactsComplete(input: {
  jobRef: FirebaseFirestore.DocumentReference;
  runRef: FirebaseFirestore.DocumentReference;
  lease: CommunityDiscoveryLease;
  completedStatus: CommunityDiscoveryCompletionStatus;
  artifactGenerationId: string;
  collected: { mode: string; reports: CommunitySourceReport[]; externalRequests: number };
  counters: Record<string, number>;
  candidateSnapshot: Record<string, unknown>[];
  completedAtIso: string;
  scopedContext?: ScopedCampaignDiscoveryContext | null;
}): Promise<void> {
  await adminDb.runTransaction(async (transaction) => {
    if (input.scopedContext) {
      await validateScopedCommunityMutationAuthority(transaction, {
        jobRef: input.jobRef, runRef: input.runRef, lease: input.lease,
        scopedContext: input.scopedContext, nowIso: input.completedAtIso,
      });
    }
    const job = await transaction.get(input.jobRef);
    const data = job.data() ?? {};
    if (!job.exists || !leaseMatches(data, input.lease) || (asString(data.leaseExpiresAtIso) ?? "") <= input.completedAtIso) {
      throw Object.assign(new Error("aborted: community artifact completion lost its lease"), { code: "aborted", errorCode: "mark_community_artifacts_complete_community_artifact_completion_lost" });
    }
    transaction.set(input.runRef, {
      status: input.completedStatus,
      artifactStatus: input.completedStatus,
      artifactGenerationId: input.artifactGenerationId,
      publicationStatus: "pending",
      mode: input.collected.mode,
      sourceReports: input.collected.reports,
      counters: input.counters,
      candidateSnapshot: input.candidateSnapshot,
      completedAtIso: input.completedAtIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(input.jobRef, {
      phase: "publish",
      artifactStatus: input.completedStatus,
      artifactGenerationId: input.artifactGenerationId,
      publicationStatus: "pending",
      sourceReports: input.collected.reports,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

const COMMUNITY_EMPTY_PARTIAL_PUBLICATION_REASON = "empty_partial_provider_result";

async function settleEmptyPartialCommunityPublication(input: {
  jobRef: FirebaseFirestore.DocumentReference;
  runRef: FirebaseFirestore.DocumentReference;
  lease: CommunityDiscoveryLease;
  scope: ReturnType<typeof communityPublicationScope>;
  settledAtIso: string;
  scopedContext?: ScopedCampaignDiscoveryContext | null;
}): Promise<void> {
  const pointerRef = adminDb.collection("community_publication_heads").doc(communityPublicationPointerId(input.scope));
  await adminDb.runTransaction(async (transaction) => {
    if (input.scopedContext) {
      await validateScopedCommunityMutationAuthority(transaction, {
        jobRef: input.jobRef, runRef: input.runRef, lease: input.lease,
        scopedContext: input.scopedContext, nowIso: input.settledAtIso,
      });
    }
    const [job, run, pointer] = await Promise.all([
      transaction.get(input.jobRef),
      transaction.get(input.runRef),
      transaction.get(pointerRef),
    ]);
    const jobData = job.data() ?? {};
    const runData = run.data() ?? {};
    if (!job.exists || !leaseMatches(jobData, input.lease) || (asString(jobData.leaseExpiresAtIso) ?? "") <= input.settledAtIso) {
      throw Object.assign(new Error("aborted: empty partial publication settlement lost its lease"), { code: "aborted", errorCode: "settle_empty_partial_community_publication_empty_partial_publication" });
    }
    if (
      !run.exists
      || asString(runData.status) !== "partial"
      || asString(runData.artifactStatus) !== "partial"
      || !asString(runData.artifactGenerationId)
    ) {
      throw new Error("failed-precondition: empty partial publication requires completed partial artifacts");
    }
    const sourceReports = Array.isArray(runData.sourceReports) ? runData.sourceReports.map(asRecord) : [];
    const incompleteSourceCount = sourceReports.filter((report) => (
      asString(report.status) === "auth_required"
      || asString(report.status) === "blocked"
      || asString(report.status) === "error"
    )).length;
    const publicationEvidence = {
      decision: "preserve_active_generation",
      reason: COMMUNITY_EMPTY_PARTIAL_PUBLICATION_REASON,
      postsExpected: 0,
      candidatesExpected: 0,
      incompleteSourceCount,
      preservedActiveGenerationRef: asString(pointer.data()?.activeGenerationRef) ?? null,
    };
    const nonPublished = {
      status: "partial",
      publicationStatus: "not_published",
      publicationReason: COMMUNITY_EMPTY_PARTIAL_PUBLICATION_REASON,
      publicationEvidence,
      publicationSettledAtIso: input.settledAtIso,
      publicationGenerationId: FieldValue.delete(),
      publicationGenerationRef: FieldValue.delete(),
      publishedAtIso: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    transaction.set(input.runRef, nonPublished, { merge: true });
    transaction.set(input.jobRef, {
      ...nonPublished,
      phase: "complete",
      completedAtIso: input.settledAtIso,
      leaseOwner: FieldValue.delete(),
      leaseToken: FieldValue.delete(),
      leaseExpiresAtIso: FieldValue.delete(),
    }, { merge: true });
  });
}

export async function prepareCommunityPublicationGeneration(input: {
  jobRef: FirebaseFirestore.DocumentReference;
  runRef: FirebaseFirestore.DocumentReference;
  lease: CommunityDiscoveryLease;
  publicationGenerationId: string;
  completedStatus: CommunityDiscoveryCompletionStatus;
  scope: ReturnType<typeof communityPublicationScope>;
  postsExpected: number;
  candidatesExpected: number;
  nowIso: string;
  scopedContext?: ScopedCampaignDiscoveryContext | null;
}): Promise<FirebaseFirestore.DocumentReference> {
  const generationRef = adminDb.collection("community_publication_generations").doc(input.publicationGenerationId);
  await adminDb.runTransaction(async (transaction) => {
    if (input.scopedContext) {
      await validateScopedCommunityMutationAuthority(transaction, {
        jobRef: input.jobRef, runRef: input.runRef, lease: input.lease,
        scopedContext: input.scopedContext, nowIso: input.nowIso,
      });
    }
    const [job, run, generation] = await Promise.all([
      transaction.get(input.jobRef),
      transaction.get(input.runRef),
      transaction.get(generationRef),
    ]);
    const jobData = job.data() ?? {};
    const runData = run.data() ?? {};
    if (!job.exists || !leaseMatches(jobData, input.lease) || (asString(jobData.leaseExpiresAtIso) ?? "") <= input.nowIso) {
      throw Object.assign(new Error("aborted: community publication preparation lost its lease"), { code: "aborted", errorCode: "prepare_community_publication_generation_community_publication" });
    }
    if (
      !run.exists
      || asString(runData.artifactStatus) !== input.completedStatus
      || !asString(runData.artifactGenerationId)
    ) {
      throw new Error("failed-precondition: completed community artifacts are required before publication staging");
    }
    const expected = {
      contractVersion: COMMUNITY_PUBLICATION_CONTRACT_VERSION,
      id: input.publicationGenerationId,
      generationRef: generationRef.path,
      sourceRunId: input.runRef.id,
      sourceRunRef: input.runRef.path,
      sourceRunStatus: input.completedStatus,
      attempt: input.lease.attempt,
      leaseTokenHash: createHash("sha256").update(input.lease.leaseToken).digest("hex"),
      scopeSequence: (() => {
        const queuedAtMs = Date.parse(asString(runData.queuedAtIso) ?? asString(jobData.queuedAtIso) ?? "");
        return Number.isFinite(queuedAtMs) ? queuedAtMs : 0;
      })(),
      scopeSequenceTieBreaker: input.runRef.id,
      ...input.scope,
      postsExpected: input.postsExpected,
      candidatesExpected: input.candidatesExpected,
    };
    if (generation.exists) {
      const stored = generation.data() ?? {};
      for (const [key, value] of Object.entries(expected)) {
        if ((key === "scopeSequence" || key === "scopeSequenceTieBreaker") && stored[key] === undefined) continue;
        if (canonicalJson(stored[key]) !== canonicalJson(value)) {
          throw new Error("failed-precondition: community publication generation replay mismatch");
        }
      }
    }
    transaction.set(generationRef, {
      ...expected,
      status: "staging",
      stagedAtIso: asString(generation.data()?.stagedAtIso) || input.nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(input.runRef, {
      publicationStatus: "staging",
      publicationGenerationId: input.publicationGenerationId,
      publicationGenerationRef: generationRef.path,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  return generationRef;
}

export async function activateCommunityPublicationGeneration(input: {
  jobRef: FirebaseFirestore.DocumentReference;
  runRef: FirebaseFirestore.DocumentReference;
  lease: CommunityDiscoveryLease;
  generationRef: FirebaseFirestore.DocumentReference;
  completedStatus: CommunityDiscoveryCompletionStatus;
  scope: ReturnType<typeof communityPublicationScope>;
  publishedAtIso: string;
  scopedContext?: ScopedCampaignDiscoveryContext | null;
}): Promise<void> {
  const pointerId = communityPublicationPointerId(input.scope);
  const pointerRef = adminDb.collection("community_publication_heads").doc(pointerId);
  await adminDb.runTransaction(async (transaction) => {
    if (input.scopedContext) {
      await validateScopedCommunityMutationAuthority(transaction, {
        jobRef: input.jobRef, runRef: input.runRef, lease: input.lease,
        scopedContext: input.scopedContext, nowIso: input.publishedAtIso,
      });
    }
    const [job, run, generation, pointer] = await Promise.all([
      transaction.get(input.jobRef),
      transaction.get(input.runRef),
      transaction.get(input.generationRef),
      transaction.get(pointerRef),
    ]);
    const jobData = job.data() ?? {};
    const runData = run.data() ?? {};
    const generationData = generation.data() ?? {};
    if (!job.exists || !leaseMatches(jobData, input.lease) || (asString(jobData.leaseExpiresAtIso) ?? "") <= input.publishedAtIso) {
      throw Object.assign(new Error("aborted: community publication activation lost its lease"), { code: "aborted", errorCode: "activate_community_publication_generation_community_publication" });
    }
    if (
      !run.exists
      || asString(runData.artifactStatus) !== input.completedStatus
      || asString(runData.publicationGenerationRef) !== input.generationRef.path
      || !generation.exists
      || asString(generationData.status) !== "staging"
      || asString(generationData.sourceRunRef) !== input.runRef.path
      || resolveCanonicalProgramId(generationData.canonicalProgramId) !== resolveCanonicalProgramId(input.scope.canonicalProgramId)
      || asString(generationData.campaignId) !== input.scope.campaignId
    ) {
      throw new Error("failed-precondition: community publication generation cannot be activated");
    }
    const previousGenerationRef = asString(pointer.data()?.activeGenerationRef);
    const incomingScopeSequence = asNumber(generationData.scopeSequence) ?? 0;
    const incomingTieBreaker = asString(generationData.scopeSequenceTieBreaker) ?? input.runRef.id;
    const currentScopeSequence = asNumber(pointer.data()?.activeScopeSequence) ?? -1;
    const currentTieBreaker = asString(pointer.data()?.activeScopeSequenceTieBreaker)
      ?? asString(pointer.data()?.activeSourceRunId)
      ?? "";
    const pointerAlreadyAhead = Boolean(pointer.exists && previousGenerationRef && previousGenerationRef !== input.generationRef.path) && (
      currentScopeSequence > incomingScopeSequence
      || (currentScopeSequence === incomingScopeSequence && currentTieBreaker > incomingTieBreaker)
    );
    if (pointerAlreadyAhead) {
      transaction.set(input.generationRef, {
        status: "superseded",
        supersededAtIso: input.publishedAtIso,
        supersededByGenerationRef: previousGenerationRef,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(input.runRef, {
        status: input.completedStatus,
        publicationStatus: "superseded",
        supersededAtIso: input.publishedAtIso,
        supersededByGenerationRef: previousGenerationRef,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(input.jobRef, {
        status: input.completedStatus,
        phase: "complete",
        publicationStatus: "superseded",
        completedAtIso: input.publishedAtIso,
        leaseOwner: FieldValue.delete(),
        leaseToken: FieldValue.delete(),
        leaseExpiresAtIso: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }
    const previousGeneration = previousGenerationRef && previousGenerationRef !== input.generationRef.path
      ? adminDb.doc(previousGenerationRef)
      : null;
    if (previousGeneration) {
      transaction.set(previousGeneration, {
        status: "superseded",
        supersededAtIso: input.publishedAtIso,
        supersededByGenerationRef: input.generationRef.path,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    transaction.set(input.generationRef, {
      status: "active",
      activatedAtIso: input.publishedAtIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(pointerRef, {
      id: pointerId,
      contractVersion: COMMUNITY_PUBLICATION_CONTRACT_VERSION,
      ...input.scope,
      status: "active",
      activeGenerationId: input.generationRef.id,
      activeGenerationRef: input.generationRef.path,
      activeSourceRunId: input.runRef.id,
      activeSourceRunRef: input.runRef.path,
      activeSourceRunStatus: input.completedStatus,
      activeScopeSequence: incomingScopeSequence,
      activeScopeSequenceTieBreaker: incomingTieBreaker,
      activatedAtIso: input.publishedAtIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: false });
    transaction.set(input.runRef, {
      status: input.completedStatus,
      publicationStatus: "complete",
      publishedAtIso: input.publishedAtIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(input.jobRef, {
      status: input.completedStatus,
      phase: "complete",
      publicationStatus: "complete",
      publishedAtIso: input.publishedAtIso,
      completedAtIso: input.publishedAtIso,
      leaseOwner: FieldValue.delete(),
      leaseToken: FieldValue.delete(),
      leaseExpiresAtIso: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

type CommunityDiscoveryMaterializationHooks = {
  collect?: typeof searchCommunitySources;
  enrich?: typeof enrichCommunityArtifactsWithPaidStatus;
  afterArtifactsComplete?: () => Promise<void> | void;
  beforeArtifactTransaction?: (chunkIndex: number) => Promise<void> | void;
  beforePublicationTransaction?: (chunkIndex: number) => Promise<void> | void;
};

export async function materializeCommunityDiscoveryRun(
  runId: string,
  runData: Record<string, unknown>,
  jobRef: FirebaseFirestore.DocumentReference,
  runRef: FirebaseFirestore.DocumentReference,
  lease: CommunityDiscoveryLease,
  hooks: CommunityDiscoveryMaterializationHooks = {},
): Promise<{ status: CommunityDiscoveryCompletionStatus; postsWritten: number; candidatesWritten: number }> {
  let activeLease = lease;
  let completedStatus = asString(runData.artifactStatus) as CommunityDiscoveryCompletionStatus;
  let artifacts: { posts: Record<string, unknown>[]; candidates: Record<string, unknown>[] };
  const queuedAtIso = asString(runData.queuedAtIso) ?? new Date().toISOString();
  const scopedContext = exactStoredCommunityScope(runData);
  const publicationScope = communityPublicationScope(scopedContext);
  const publicationGenerationId = communityPublicationGenerationId({
    sourceRunId: runId,
    canonicalProgramId: publicationScope.canonicalProgramId,
    campaignId: publicationScope.campaignId,
    attempt: lease.attempt,
    leaseToken: lease.leaseToken,
  });
  activeLease = await assertAndHeartbeatCommunityDiscoveryLease(jobRef, activeLease);

  if (completedStatus !== "complete" && completedStatus !== "partial") {
    const artifactGenerationId = publicationGenerationId;
    const settings = await readSettings();
    const data = readCommunityDiscoveryData(runData, settings.feed);
    await assertFreshCommunityDiscoveryAuthority(scopedContext);
    const communityLive = liveIntegrationsEnabled("community");
    if (!communityLive && !discoveryFixtureFallbackAllowed()) throw discoveryUnavailable("community");
    const collected = hooks.collect
      ? await hooks.collect(data, runId, { enableLlmSentiment: true, enableRedditComments: true })
      : communityLive
      ? await searchCommunitySources(data, runId, { enableLlmSentiment: true, enableRedditComments: true })
      : buildCommunityFallbackArtifacts(data, runId);
    await assertFreshCommunityDiscoveryAuthority(scopedContext);
    const paidStatusIndex = await buildCreatorPaidStatusIndex();
    await assertFreshCommunityDiscoveryAuthority(scopedContext);
    const enrich = hooks.enrich ?? enrichCommunityArtifactsWithPaidStatus;
    const enrichedPosts = await enrich(collected.posts, paidStatusIndex);
    await assertFreshCommunityDiscoveryAuthority(scopedContext);
    const enrichedCandidates = (await enrich(collected.candidates, paidStatusIndex)).map((candidate) => ({
      ...candidate,
      candidateRef: `candidate_pool/${candidate.id}`,
      ...(scopedContext ?? {}),
      sourceRunId: runId,
      sourceRunRef: runRef.path,
    }));
    const completion = communityDiscoveryCompletionSummary(collected.reports);
    completedStatus = completion.status;
    const artifactWrites = buildCommunityDiscoveryArtifactWrites({
      posts: enrichedPosts,
      candidates: enrichedCandidates,
      provenance: { sourceRunId: runId, sourceRunRef: runRef.path, scopedContext },
      queuedAtIso,
      artifactGenerationId,
    });
    if (scopedContext) {
      await commitScopedCommunityDiscoveryWrites({
        writes: artifactWrites,
        jobRef,
        runRef,
        lease: activeLease,
        scopedContext,
        beforeTransaction: hooks.beforeArtifactTransaction,
      });
    } else {
      await commitCommunityDiscoveryArtifactWrites(artifactWrites, undefined, {
        beforeChunk: async () => {
          activeLease = await assertAndHeartbeatCommunityDiscoveryLease(jobRef, activeLease);
        },
      });
    }
    activeLease = await assertAndHeartbeatCommunityDiscoveryLease(jobRef, activeLease);
    await assertFreshCommunityDiscoveryAuthority(scopedContext);
    const completedAtIso = new Date().toISOString();
    await markCommunityArtifactsComplete({
      jobRef,
      runRef,
      lease: activeLease,
      completedStatus,
      artifactGenerationId,
      collected,
      counters: {
        queuedSources: data.sources.length,
        communityPostsWritten: enrichedPosts.length,
        candidateSignalsWritten: enrichedCandidates.length,
        externalRequests: collected.externalRequests,
        blockedSources: completion.blockedSources,
      },
      candidateSnapshot: enrichedCandidates.map((candidate) => ({
        id: candidate.id,
        candidateId: candidate.id,
        candidateRef: candidate.candidateRef,
        canonicalProgramId: candidate.canonicalProgramId,
        campaignId: candidate.campaignId,
        sourceRunId: runId,
        sourceRunRef: runRef.path,
      })),
      completedAtIso,
      scopedContext,
    });
    await hooks.afterArtifactsComplete?.();
  }

  activeLease = await assertAndHeartbeatCommunityDiscoveryLease(jobRef, activeLease);
  await assertFreshCommunityDiscoveryAuthority(scopedContext);
  const publicationReceipt = await runRef.get();
  const publicationRunData = publicationReceipt.data() ?? {};
  if (
    !publicationReceipt.exists
    || asString(publicationRunData.status) !== completedStatus
    || asString(publicationRunData.artifactStatus) !== completedStatus
  ) {
    throw new Error("failed-precondition: community artifacts cannot publish before their run is completed");
  }
  const artifactGenerationId = asString(publicationRunData.artifactGenerationId);
  if (!artifactGenerationId) {
    throw new Error("failed-precondition: completed community run lost its artifact generation");
  }
  artifacts = await readCommunityRunArtifacts(runId, artifactGenerationId);
  await assertFreshCommunityDiscoveryAuthority(scopedContext);
  if (completedStatus === "partial" && artifacts.posts.length === 0 && artifacts.candidates.length === 0) {
    const settledAtIso = new Date().toISOString();
    await assertFreshCommunityDiscoveryAuthority(scopedContext);
    await settleEmptyPartialCommunityPublication({
      jobRef,
      runRef,
      lease: activeLease,
      scope: publicationScope,
      settledAtIso,
      scopedContext,
    });
    await persistCommunityDiscoveryReceipt({
      runId,
      lease: activeLease,
      phase: "publish",
      status: "partial",
      message: COMMUNITY_EMPTY_PARTIAL_PUBLICATION_REASON,
    });
    return { status: "partial", postsWritten: 0, candidatesWritten: 0 };
  }
  await assertFreshCommunityDiscoveryAuthority(scopedContext);
  const generationRef = await prepareCommunityPublicationGeneration({
    jobRef,
    runRef,
    lease: activeLease,
    publicationGenerationId,
    completedStatus,
    scope: publicationScope,
    postsExpected: artifacts.posts.length,
    candidatesExpected: artifacts.candidates.length,
    nowIso: new Date().toISOString(),
    scopedContext,
  });
  const publicationWrites = buildCommunityDiscoveryPublicationWrites({
    ...artifacts,
    provenance: { sourceRunId: runId, sourceRunRef: runRef.path, scopedContext },
    completedStatus,
    publishedAtIso: new Date().toISOString(),
    publicationGenerationId,
  });
  if (scopedContext) {
    await commitScopedCommunityDiscoveryWrites({
      writes: publicationWrites,
      jobRef,
      runRef,
      lease: activeLease,
      scopedContext,
      beforeTransaction: hooks.beforePublicationTransaction,
    });
  } else {
    await commitCommunityDiscoveryArtifactWrites(publicationWrites, undefined, {
      beforeChunk: async () => {
        activeLease = await assertAndHeartbeatCommunityDiscoveryLease(jobRef, activeLease);
      },
    });
  }
  activeLease = await assertAndHeartbeatCommunityDiscoveryLease(jobRef, activeLease);
  await assertFreshCommunityDiscoveryAuthority(scopedContext);
  const publishedAtIso = new Date().toISOString();
  await activateCommunityPublicationGeneration({
    jobRef,
    runRef,
    lease: activeLease,
    generationRef,
    completedStatus,
    scope: publicationScope,
    publishedAtIso,
    scopedContext,
  });
  await writeCommunityDiscoveryState(adminDb, {
    nowIso: publishedAtIso,
    runId,
    source: asString(runData.enqueueSource) === "scheduled" ? "scheduled" : "callable",
    cooldownHours: DEFAULT_COMMUNITY_DISCOVERY_COOLDOWN_HOURS,
  }).catch(() => undefined);
  await persistCommunityDiscoveryReceipt({ runId, lease: activeLease, phase: "publish", status: completedStatus });
  return { status: completedStatus, postsWritten: artifacts.posts.length, candidatesWritten: artifacts.candidates.length };
}

export async function enqueueCommunityDiscovery(ctx: CommunityDiscoveryEnqueueContext) {
  const context = ctx.context;
  const settings = await readSettings();
  const data = readCommunityDiscoveryData(ctx.data, settings.feed);
  const requestedProgramId = resolveCanonicalProgramId(data.programId);
  if (context.role === "manager" && (!requestedProgramId || !data.campaignId)) {
    throw Object.assign(new Error("invalid-argument: manager community discovery requires exact programId and campaignId"), { code: "invalid-argument", errorCode: "enqueue_community_discovery_manager_community_discovery_requires_exact" });
  }
  if ((requestedProgramId && !data.campaignId) || (!requestedProgramId && data.campaignId && context.role === "manager")) {
    throw Object.assign(new Error("invalid-argument: community discovery program and campaign scope must be supplied together"), { code: "invalid-argument", errorCode: "enqueue_community_discovery_community_discovery_program_campaign_scope" });
  }
  const scopedContext = await resolveAuthoritativeDiscoveryCampaignContext(
    data.campaignId,
    data.campaignRef,
    context,
    `${ctx.source === "scheduled" ? "scheduled" : "community"} discovery campaign`,
  );
  if (requestedProgramId && scopedContext?.canonicalProgramId !== requestedProgramId) {
    throw Object.assign(new Error("failed-precondition: requested community program does not own the campaign"), { code: "failed-precondition", errorCode: "enqueue_community_discovery_requested_community_program_own_campaign" });
  }
  const queuedAtIso = ctx.nowIso ?? new Date().toISOString();
  const requestPayload = communityDiscoveryRequestPayload(data, ctx.data, ctx.source);
  const identity = communityDiscoveryRequestIdentity({
    actorUid: context.userId,
    canonicalProgramId: scopedContext?.canonicalProgramId ?? null,
    campaignId: scopedContext?.campaignId ?? null,
    requestPayload,
  });
  const runId = identity.runId;
  const runRef = adminDb.collection("discovery_runs").doc(runId);
  const jobRef = adminDb.collection("workflow_jobs").doc(runId);
  const existing = await runRef.get();
  if (existing.exists) {
    const stored = existing.data() ?? {};
    if (
      asString(stored.requestHash) !== identity.requestHash
      || asString(stored.createdBy) !== context.userId
      || asString(stored.campaignId) !== (scopedContext?.campaignId ?? COMMUNITY_DISCOVERY_GLOBAL_SCOPE)
      || asString(stored.canonicalProgramId) !== (scopedContext?.canonicalProgramId ?? COMMUNITY_DISCOVERY_GLOBAL_SCOPE)
    ) {
      throw new Error("failed-precondition: community discovery idempotency receipt does not match the request");
    }
    const cost = costLog("insane-search-adapter", "community-adapter", 0);
    return {
      ok: true,
      replay: true,
      runId,
      runRef: runRef.path,
      jobRef: jobRef.path,
      status: asString(stored.status) ?? "queued",
      requestHash: identity.requestHash,
      costLog: cost,
      behaviorLog: behaviorLog(context, data.gameId, ctx.action, "success", cost.estimatedUsd),
    };
  }
  const cooldown = await readCommunityDiscoveryState(adminDb, queuedAtIso, DEFAULT_COMMUNITY_DISCOVERY_COOLDOWN_HOURS);
  if (ctx.enforceCooldown && !cooldown.allowed) {
    const cost = costLog("insane-search-adapter", "community-adapter", 0);
    return {
      ok: true,
      status: "skipped",
      skipped: true,
      reason: "community_discovery_cooldown",
      cooldown,
      sourcePlan: [],
      sourceReports: [],
      counters: {
        communityPostsWritten: 0,
        candidateSignalsWritten: 0,
        externalRequests: 0,
      },
      costLog: cost,
      behaviorLog: behaviorLog(context, data.gameId, ctx.action, "success", cost.estimatedUsd),
    };
  }
  const queryPlan = buildCommunitySearchQueries(data);
  const sourcePlan = data.sources.map((source) => ({
    source: communitySourceLabel(source),
    sourceKey: source,
    engine: "insane-search-adapter",
    queries: queryPlan.filter((item) => item.source === source).map((item) => item.query),
    dateAfterDays: data.filters.recentActivityDays,
    includeComments: data.includeComments,
  }));
  const storedScope = scopedContext ?? {
    canonicalProgramId: COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
    programId: COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
    programRef: null,
    campaignId: COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
    campaignRef: null,
  };
  const created = await adminDb.runTransaction(async (transaction) => {
    const [runSnapshot, jobSnapshot] = await Promise.all([transaction.get(runRef), transaction.get(jobRef)]);
    if (runSnapshot.exists !== jobSnapshot.exists) {
      throw new Error("failed-precondition: community discovery idempotency pair is incomplete");
    }
    if (runSnapshot.exists && jobSnapshot.exists) {
      const stored = runSnapshot.data() ?? {};
      if (
        asString(stored.requestHash) !== identity.requestHash
        || asString(stored.createdBy) !== context.userId
        || asString(stored.campaignId) !== (scopedContext?.campaignId ?? COMMUNITY_DISCOVERY_GLOBAL_SCOPE)
        || asString(stored.canonicalProgramId) !== (scopedContext?.canonicalProgramId ?? COMMUNITY_DISCOVERY_GLOBAL_SCOPE)
      ) {
        throw new Error("failed-precondition: community discovery replay receipt does not match the request");
      }
      return false;
    }
    const common = {
      id: runId,
      engine: "insane-search-adapter",
      status: "queued",
      phase: "collect",
      requestHash: identity.requestHash,
      requestPayload,
      ...storedScope,
      gameId: data.gameId,
      brief: data.brief,
      keywords: data.keywords,
      filters: data.filters,
      ownedGameTags: data.ownedGameTags,
      similarGameTags: data.similarGameTags,
      ugcKeywords: data.ugcKeywords,
      communitySubreddits: data.communitySubreddits,
      officialChannels: data.officialChannels,
      steamAppIds: data.steamAppIds,
      steamLanguage: data.steamLanguage,
      communityRefreshHours: data.communityRefreshHours,
      sources: data.sources,
      resultLimit: data.resultLimit,
      includeComments: data.includeComments,
      sourcePlan,
      worker: "scheduled-discovery-worker",
      enqueueSource: ctx.source,
      queuedAtIso,
      retryAfterIso: queuedAtIso,
      createdBy: context.userId,
      createdByRole: context.role,
      createdAt: FieldValue.serverTimestamp(),
      expireAt: expireAt180DaysFromIso(queuedAtIso),
      updatedAt: FieldValue.serverTimestamp(),
    };
    transaction.set(runRef, common);
    transaction.set(jobRef, {
      ...common,
      type: COMMUNITY_DISCOVERY_JOB_TYPE,
      runRef: runRef.path,
    });
    return true;
  });
  const cost = costLog("insane-search-adapter", "community-adapter", 0);
  return {
    ok: true,
    runId,
    runRef: runRef.path,
    jobRef: jobRef.path,
    status: "queued",
    replay: !created,
    requestHash: identity.requestHash,
    worker: "scheduled-discovery-worker",
    sourcePlan,
    cooldown,
    counters: {
      communityPostsWritten: 0,
      candidateSignalsWritten: 0,
      externalRequests: 0,
      blockedSources: 0,
    },
    costLog: cost,
    behaviorLog: behaviorLog(context, data.gameId, ctx.action, "success", cost.estimatedUsd),
  };
}

export async function youtubeSearch(request: CallableRequest) {
  const context = assertRole(request);
  assertStagingYoutubeLiveEgressAllowed();
  const data = readYoutubeData(request.data);
  // Semantic seed: same query + relevance-shaping filters → same cache doc.
  const cacheKey = youtubeDiscoveryCacheKey(data);
  const cache = await cacheLookup(cacheKey, DISCOVERY_CACHE_TTL_SECONDS);

  // Cache hit: skip the expensive YouTube Data API / mock search entirely. (COST-P0-011)
  if (cache.status === "hit" && cache.value) {
    const cachedResults = Array.isArray(cache.value.results) ? cache.value.results as CandidateResult[] : [];
    const safeCachedResults = withoutHostedFixtureCandidates(cachedResults);
    const cachedFixture = cache.value.fixture === true;
    if (discoveryFixtureFallbackAllowed() || (!cachedFixture && (cachedResults.length === 0 || safeCachedResults.length > 0))) {
      return {
        queryRef: data.queryRef,
        campaignRef: data.campaignRef,
        source: "youtube-cache",
        results: discoveryFixtureFallbackAllowed() ? cachedResults : safeCachedResults,
        cache,
        costLog: cachedFixture
          ? costLog("mock-youtube-search")
          : costLog("youtube-data-api-v3", "youtube-data-api", 0),
        behaviorLog: behaviorLog(context, data.gameId, "youtubeSearch", "success", 0),
      };
    }
  }

  const live = await searchYouTubeLive(data);
  if (live?.primaryLaneSkipped) {
    // 헤세 결정(2026-09-27) 코덱스 라운드2 대비 수리: 이 콜러블(수동 관리자 검색)의 캐시 키는
    // youtubeDiscoveryCacheKey — 스케줄 발굴 워커와 **같은 의미론 캐시 네임스페이스**를 공유한다.
    // 여기서 빈 결과를 캐시하면 자동 파이프라인까지 최대 1시간 오염될 수 있다 — 캐시하지 않는다.
    return {
      queryRef: data.queryRef,
      campaignRef: data.campaignRef,
      source: "ytdlp-primary-lane-skip",
      results: [],
      cache,
      costLog: live.cost,
      behaviorLog: behaviorLog(context, data.gameId, "youtubeSearch", "success", live.cost.estimatedUsd),
    };
  }
  if (live) {
    await cacheStore(cacheKey, "youtube", data.queryRef, DISCOVERY_CACHE_TTL_SECONDS, { results: live.results });
    return {
      queryRef: data.queryRef,
      campaignRef: data.campaignRef,
      source: "youtube-live-callable",
      results: live.results,
      cache,
      costLog: live.cost,
      behaviorLog: behaviorLog(context, data.gameId, "youtubeSearch", "success", live.cost.estimatedUsd),
    };
  }

  if (discoveryFixtureFallbackAllowed()) {
    const cost = costLog("mock-youtube-search");
    const results = filterCandidates(MOCK_CANDIDATES, data.filters);
    await cacheStore(cacheKey, "youtube", data.queryRef, DISCOVERY_CACHE_TTL_SECONDS, { results, fixture: true });

    return {
      queryRef: data.queryRef,
      campaignRef: data.campaignRef,
      source: "mock-youtube-callable",
      results,
      cache,
      costLog: cost,
      behaviorLog: behaviorLog(context, data.gameId, "youtubeSearch", "mock", cost.estimatedUsd),
    };
  }
  throw discoveryUnavailable("youtube");
}

// Email cache TTL: 1 day. Channel→email is far more stable than a discovery search.
const EMAIL_CACHE_TTL_SECONDS = 86400;

export async function emailFinder(request: CallableRequest) {
  const context = assertRole(request);
  const data = readEmailFinderData(request.data);
  const cacheKey = discoveryCacheKey("email", data.channelRef, [data.candidateRef]);
  const cache = await cacheLookup(cacheKey, EMAIL_CACHE_TTL_SECONDS);

  // Cache hit: skip the expensive YouTube channel email scrape entirely. (COST-P0-011)
  if (cache.status === "hit" && cache.value) {
    const cachedResult = cache.value.result && typeof cache.value.result === "object"
      ? cache.value.result as EmailFinderResult
      : publicEmailResult({
          candidateRef: data.candidateRef,
          channelRef: data.channelRef,
          email: null,
          status: "none",
          source: "none",
          confidence: 0,
        });
    const legacyMock = MOCK_EMAILS[data.channelRef];
    const cachedFixture = cache.value.fixture === true
      || Boolean(legacyMock && JSON.stringify(cachedResult) === JSON.stringify(publicEmailResult(legacyMock)));
    if (discoveryFixtureFallbackAllowed() || !cachedFixture) {
      return {
        channelRef: data.channelRef,
        candidateRef: data.candidateRef,
        result: cachedResult,
        source: "email-cache",
        cache,
        costLog: cachedFixture
          ? costLog("mock-email-finder")
          : costLog("youtube-channel-email", "youtube-data-api", 0),
        behaviorLog: behaviorLog(context, data.gameId, "emailFinder", "success", 0),
      };
    }
  }

  const live = await findEmailLive(data);
  if (live) {
    const result = publicEmailResult(live.stored);
    await cacheStore(cacheKey, "email", data.channelRef, EMAIL_CACHE_TTL_SECONDS, { result });
    return {
      channelRef: data.channelRef,
      candidateRef: data.candidateRef,
      result,
      source: "youtube-email-live-callable",
      cache,
      costLog: live.cost,
      behaviorLog: behaviorLog(context, data.gameId, "emailFinder", "success", live.cost.estimatedUsd),
    };
  }

  if (discoveryFixtureFallbackAllowed()) {
    const cost = costLog("mock-email-finder");
    const fallback: EmailFinderStored = {
      candidateRef: data.candidateRef,
      channelRef: data.channelRef,
      email: null,
      status: "none",
      source: "none",
      confidence: 0,
    };
    const stored = MOCK_EMAILS[data.channelRef] ?? fallback;
    const result = publicEmailResult(stored);
    await cacheStore(cacheKey, "email", data.channelRef, EMAIL_CACHE_TTL_SECONDS, { result, fixture: true });

    return {
      channelRef: data.channelRef,
      candidateRef: data.candidateRef,
      result,
      source: "mock-email-finder-callable",
      cache,
      costLog: cost,
      behaviorLog: behaviorLog(context, data.gameId, "emailFinder", "mock", cost.estimatedUsd),
    };
  }
  throw discoveryUnavailable("email");
}

function publicEmailResult(stored: EmailFinderStored): EmailFinderResult {
  return {
    candidateRef: stored.candidateRef,
    channelRef: stored.channelRef,
    emailRef: stableRef("email_ref", `${stored.channelRef}:${stored.status}`),
    maskedEmail: maskEmail(stored.email),
    status: stored.status,
    sourceRef: stableRef("source_ref", `${stored.channelRef}:${stored.source}`),
    confidence: stored.confidence,
  };
}

function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}
