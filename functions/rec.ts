import { adminDb } from "./firebaseAdmin";
import { discoverAndPersistCandidates } from "./discovery";
import { liveIntegrationsEnabled } from "./liveIntegrations";
import { buildRecommendationMock, type RecCandidate } from "./_rec-mock";
import { isOperationalFixtureRecord } from "./operationalFixtureProvenance";
import { readSettings } from "./settings";
import { rerankCandidatesBySimilarity } from "./recommendationSimilarity";

export type Role = "super_admin" | "admin" | "manager" | "viewer" | "guest";
type AllowedRole = "super_admin" | "admin" | "manager";

type CallableRequest = {
  auth?: { uid?: string; token?: { role?: Role; team?: string } };
  data?: unknown;
  rawRequest?: { ip?: string };
};

type BehaviorLog = {
  userId: string;
  role: Role;
  team: string;
  gameId: string;
  action: string;
  time: string;
  IP: string;
  result: "success" | "denied" | "error" | "mock";
  cost: number;
};

type RecommendationPayload = {
  campaignRef?: string;
  creatorRefs?: string[];
  gameId?: string;
  limit?: number;
  keywords?: string[];
  filters?: {
    categories?: string[];
    minFollowers?: number;
    maxFollowers?: number;
    recentActivityDays?: number;
  };
};
type CandidateCriteria = {
  keywords: string[];
  minFollowers: number;
  maxFollowers: number;
  recentActivityDays: number;
  platforms: string[];
};

type AuthContext = { userId: string; role: AllowedRole; team: string };
type RecommendationSource = "candidate_pool" | "rec_candidates" | "live_discovery" | "emulator_mock";

const ALLOWED_ROLES: AllowedRole[] = ["super_admin", "admin", "manager"];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const MAX_POOL_SCAN_LIMIT = 500;

function isEmulatorRuntime(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true" || Boolean(process.env.FIRESTORE_EMULATOR_HOST);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const asStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;

const parseRecommendationPayload = (data: unknown): RecommendationPayload => {
  if (!isRecord(data)) return {};
  const filters = isRecord(data.filters) ? data.filters : {};

  return {
    campaignRef: typeof data.campaignRef === "string" ? data.campaignRef : undefined,
    creatorRefs: asStringArray(data.creatorRefs),
    gameId: typeof data.gameId === "string" ? data.gameId : undefined,
    limit: typeof data.limit === "number" && Number.isFinite(data.limit) ? data.limit : undefined,
    keywords: asStringArray(data.keywords),
    filters: {
      categories: asStringArray(filters.categories),
      minFollowers: typeof filters.minFollowers === "number" && Number.isFinite(filters.minFollowers) ? filters.minFollowers : undefined,
      maxFollowers: typeof filters.maxFollowers === "number" && Number.isFinite(filters.maxFollowers) ? filters.maxFollowers : undefined,
      recentActivityDays: typeof filters.recentActivityDays === "number" && Number.isFinite(filters.recentActivityDays) ? filters.recentActivityDays : undefined,
    },
  };
};

const normalizeLimit = (limit: number | undefined): number => {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(limit ?? DEFAULT_LIMIT), MAX_LIMIT));
};

const createCostLog = (source: RecommendationSource | "error") => ({
  provider: source === "emulator_mock" ? "mock" as const : "mock-gateway" as const,
  model: source,
  promptTokens: 0,
  completionTokens: 0,
  embeddingTokens: 0,
  estimatedUsd: 0,
  logged: true,
});

const createBehaviorLog = (
  request: CallableRequest,
  authContext: { userId: string; role: Role; team: string },
  gameId: string,
  result: BehaviorLog["result"],
  cost: number,
): BehaviorLog => ({
  userId: authContext.userId,
  role: authContext.role,
  team: authContext.team,
  gameId,
  action: "recommendCreators",
  time: new Date().toISOString(),
  IP: request.rawRequest?.ip ?? "0.0.0.0",
  result,
  cost,
});

function callableError(
  message: string,
  code: "permission-denied" | "unauthenticated" | "failed-precondition",
  behaviorLog: BehaviorLog,
  costLog = createCostLog("error"),
) {
  return Object.assign(new Error(message), { code, behaviorLog, costLog });
}

function requireRole(request: CallableRequest, gameId: string): AuthContext {
  const userId = request.auth?.uid ?? "anonymous";
  const role = request.auth?.token?.role ?? "guest";
  const team = request.auth?.token?.team ?? "unknown";
  const authContext = { userId, role, team };

  if (!request.auth?.uid) {
    throw callableError(
      "unauthenticated",
      "unauthenticated",
      createBehaviorLog(request, authContext, gameId, "denied", 0),
    );
  }

  if (!ALLOWED_ROLES.includes(role as AllowedRole)) {
    throw callableError(
      "Recommendation engine access denied.",
      "permission-denied",
      createBehaviorLog(request, authContext, gameId, "denied", 0),
    );
  }

  return { userId, role: role as AllowedRole, team };
}

const getRecommendationCache = (campaignRef: string, creatorRefs: string[]) => ({
  status: "miss" as const,
  key: `recommendCreators:${campaignRef}:${creatorRefs.join("|") || "all"}`,
  checkedBeforeModel: true,
  ttlSeconds: 600,
});

const asNumber = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const asReasonString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const normalizeLookup = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
};

const normalizeHandle = (value: unknown): string => normalizeLookup(value).replace(/^@/, "");

function normalizeUrl(value: unknown): string {
  return normalizeLookup(value).replace(/\/+$/, "");
}

type LookupKind = "id" | "handle" | "name" | "email" | "channelId" | "youtubeUrl";

function addCreatorKey(keys: Set<string>, kind: LookupKind, value: unknown) {
  const normalized = kind === "handle"
    ? normalizeHandle(value)
    : kind === "youtubeUrl"
      ? normalizeUrl(value)
      : normalizeLookup(value);
  if (normalized) keys.add(`${kind}:${normalized}`);
}

function addCandidateKey(keys: Set<string>, candidate: RecCandidate) {
  addCreatorKey(keys, "id", candidate.id);
  addCreatorKey(keys, "handle", candidate.handle);
  addCreatorKey(keys, "name", candidate.name);
  addCreatorKey(keys, "email", candidate.email);
  addCreatorKey(keys, "channelId", candidate.channelId);
  addCreatorKey(keys, "youtubeUrl", candidate.youtubeUrl);
}

function addCreatorDocKeys(keys: Set<string>, docId: string, data: Record<string, unknown>) {
  addCreatorKey(keys, "id", docId);
  addCreatorKey(keys, "id", data.id);
  addCreatorKey(keys, "handle", data.handle);
  addCreatorKey(keys, "name", data.name);
  addCreatorKey(keys, "email", data.email);
  addCreatorKey(keys, "email", data.profileMatchedEmail);
  addCreatorKey(keys, "channelId", data.channelId);
  addCreatorKey(keys, "youtubeUrl", data.youtubeUrl);
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function candidateIdentity(candidate: RecCandidate): string {
  const keys = new Set<string>();
  addCandidateKey(keys, candidate);
  return Array.from(keys)[0] ?? `id:${candidate.id}`;
}

const NON_YOUTUBE_RECOMMENDATION_SOURCES = new Set(["reddit", "discord", "x", "web", "instagram", "tiktok"]);

function isYoutubeRecommendationCandidate(candidate: RecCandidate): boolean {
  const platform = normalizeLookup(candidate.sourcePlatform ?? candidate.platform);
  const sourceKey = normalizeLookup(candidate.sourceKey);
  const discoverySource = normalizeLookup(candidate.discoverySource);
  if (platform === "youtube") return true;
  if (NON_YOUTUBE_RECOMMENDATION_SOURCES.has(platform) || NON_YOUTUBE_RECOMMENDATION_SOURCES.has(sourceKey)) return false;
  if (discoverySource.includes("community")) return false;
  return Boolean(candidate.channelId || candidate.youtubeUrl);
}

function candidateExists(candidate: RecCandidate, existingKeys: Set<string>): boolean {
  const keys = new Set<string>();
  addCandidateKey(keys, candidate);
  return Array.from(keys).some((key) => existingKeys.has(key));
}

const followerTier = (followers: number): string => {
  if (followers >= 1_000_000) return "mega";
  if (followers >= 100_000) return "mid";
  return "growth";
};

function resolveCandidateCriteria(payload: RecommendationPayload, settingsCriteria: CandidateCriteria): CandidateCriteria {
  const keywords = payload.keywords?.length
    ? payload.keywords
    : payload.filters?.categories?.length
      ? payload.filters.categories
      : settingsCriteria.keywords;

  return {
    ...settingsCriteria,
    keywords: keywords.filter((keyword) => keyword.trim().length > 0).slice(0, 12),
    minFollowers: payload.filters?.minFollowers ?? settingsCriteria.minFollowers,
    maxFollowers: payload.filters?.maxFollowers ?? settingsCriteria.maxFollowers,
    recentActivityDays: payload.filters?.recentActivityDays ?? settingsCriteria.recentActivityDays,
    platforms: ["YouTube"],
  };
}

const poolDocToCandidate = (id: string, doc: Record<string, unknown>): RecCandidate => {
  const matchScore = asNumber(doc.matchScore);
  const confidence = asNumber(doc.confidence);
  const followers = asNumber(doc.followers);
  const emailStatus = typeof doc.emailStatus === "string" ? doc.emailStatus : undefined;
  const signals = (Array.isArray(doc.discoverySignals)
    ? doc.discoverySignals
    : Array.isArray(doc.signals)
      ? doc.signals
      : []).filter((item): item is string => typeof item === "string");
  const hasBusinessEmail = emailStatus === "verified" || signals.includes("businessEmail");
  const reasons: string[] = [];
  const sourcePlatform = asReasonString(doc.sourcePlatform);

  if (sourcePlatform) reasons.push(`${sourcePlatform} public signal`);
  if (signals.includes("category") || matchScore >= 70) reasons.push("category fit");
  if (followers > 0) reasons.push(`${followerTier(followers)} tier (${followers.toLocaleString("en-US")} followers)`);
  if (hasBusinessEmail) reasons.push("business email found");
  if (asReasonString(doc.recentActivity) || signals.includes("recentActivity")) reasons.push("recent activity");
  if (reasons.length === 0) reasons.push("discovered channel candidate");

  return {
    id,
    name: asReasonString(doc.name) ?? id,
    handle: asReasonString(doc.handle) ?? `@${id}`,
    avatar: asReasonString(doc.avatar) ?? "RC",
    email: asReasonString(doc.email),
    platform: asReasonString(doc.sourcePlatform) ?? asReasonString(doc.platform) ?? "YouTube",
    sourcePlatform: asReasonString(doc.sourcePlatform),
    sourceKey: asReasonString(doc.sourceKey),
    sourceUrl: asReasonString(doc.sourceUrl) ?? asReasonString(doc.externalProfileUrl),
    sourceNote: asReasonString(doc.sourceNote),
    discoverySource: asReasonString(doc.discoverySource) ?? asReasonString(doc.source),
    followers,
    region: asReasonString(doc.region) ?? "GLOBAL",
    category: asReasonString(doc.category) ?? "Gaming",
    matchScore,
    reasons: reasons.slice(0, 3),
    breakdown: {
      relevance: matchScore,
      similarity: confidence,
      freshness: 70,
      contact: hasBusinessEmail ? 100 : emailStatus === "guessed" ? 60 : 45,
    },
  };
};

const readExistingCreatorKeys = async (candidates: RecCandidate[]): Promise<Set<string>> => {
  const keys = new Set<string>();
  const ids = new Set<string>();
  const handles = new Set<string>();
  const names = new Set<string>();
  const emails = new Set<string>();
  const channelIds = new Set<string>();
  const youtubeUrls = new Set<string>();
  const creators = adminDb.collection("creators");

  for (const candidate of candidates) {
    const id = normalizeLookup(candidate.id);
    const handle = candidate.handle.trim();
    const name = candidate.name.trim();
    const email = normalizeLookup(candidate.email);
    const channelId = normalizeLookup(candidate.channelId);
    const youtubeUrl = normalizeUrl(candidate.youtubeUrl);
    if (id) ids.add(id);
    if (handle) handles.add(handle);
    if (name) names.add(name);
    if (email) emails.add(email);
    if (channelId) channelIds.add(channelId);
    if (youtubeUrl) youtubeUrls.add(youtubeUrl);
  }

  const reads: Promise<unknown>[] = Array.from(ids).map((id) =>
    creators.doc(id).get().then((doc) => {
      if (doc.exists) addCreatorDocKeys(keys, doc.id, doc.data() as Record<string, unknown>);
    }),
  );

  for (const values of chunk(Array.from(handles), 10)) {
    reads.push(
      creators.where("handle", "in", values).limit(values.length).get().then((snapshot) => {
        for (const doc of snapshot.docs) addCreatorDocKeys(keys, doc.id, doc.data() as Record<string, unknown>);
      }),
    );
  }

  for (const values of chunk(Array.from(names), 10)) {
    reads.push(
      creators.where("name", "in", values).limit(values.length).get().then((snapshot) => {
        for (const doc of snapshot.docs) addCreatorDocKeys(keys, doc.id, doc.data() as Record<string, unknown>);
      }),
    );
  }

  for (const values of chunk(Array.from(emails), 10)) {
    reads.push(
      creators.where("email", "in", values).limit(values.length).get().then((snapshot) => {
        for (const doc of snapshot.docs) addCreatorDocKeys(keys, doc.id, doc.data() as Record<string, unknown>);
      }),
    );
  }

  for (const values of chunk(Array.from(channelIds), 10)) {
    reads.push(
      creators.where("channelId", "in", values).limit(values.length).get().then((snapshot) => {
        for (const doc of snapshot.docs) addCreatorDocKeys(keys, doc.id, doc.data() as Record<string, unknown>);
      }),
    );
  }

  for (const values of chunk(Array.from(youtubeUrls), 10)) {
    reads.push(
      creators.where("youtubeUrl", "in", values).limit(values.length).get().then((snapshot) => {
        for (const doc of snapshot.docs) addCreatorDocKeys(keys, doc.id, doc.data() as Record<string, unknown>);
      }),
    );
  }

  await Promise.all(reads);
  return keys;
};

const readCandidateCollection = async (
  collection: "candidate_pool" | "rec_candidates",
  limit: number,
): Promise<RecCandidate[]> => {
  const boundedLimit = normalizeLimit(limit);
  const scanLimit = Math.min(MAX_POOL_SCAN_LIMIT, Math.max(boundedLimit + 50, boundedLimit));
  const snapshot = await adminDb.collection(collection).orderBy("matchScore", "desc").limit(scanLimit).get();
  return snapshot.docs
    .flatMap((doc) => {
      const data = doc.data() as Record<string, unknown>;
      if (!isEmulatorRuntime() && isOperationalFixtureRecord(data, "rec_candidates")) return [];
      return [poolDocToCandidate(doc.id, data)];
    })
    .filter(isYoutubeRecommendationCandidate)
    .slice(0, boundedLimit);
};

const referenceDocId = (ref: string): string => ref.trim().replace(/^creators\//, "");

const readRecommendationReferenceTerms = async (creatorRefs: string[]): Promise<string[]> => {
  const ids = Array.from(new Set(creatorRefs.map(referenceDocId).filter(Boolean))).slice(0, 12);
  if (ids.length === 0) return [];

  const docs = await Promise.all(ids.map((id) => adminDb.collection("creators").doc(id).get()));
  const terms: string[] = [...ids];
  for (const doc of docs) {
    if (!doc.exists) continue;
    const data = doc.data() as Record<string, unknown>;
    for (const key of ["name", "handle", "category", "region", "primaryPlatform", "platform", "youtubeUrl", "channelId"]) {
      const value = asReasonString(data[key]);
      if (value) terms.push(value);
    }
  }
  return terms;
};

const readRecommendationPools = async (limit: number): Promise<{ candidates: RecCandidate[]; source?: "candidate_pool" | "rec_candidates" }> => {
  const [pool, recCandidates] = await Promise.all([
    readCandidateCollection("candidate_pool", limit),
    readCandidateCollection("rec_candidates", limit),
  ]);
  const merged = new Map<string, RecCandidate>();

  for (const candidate of [...pool, ...recCandidates]) {
    const key = candidateIdentity(candidate);
    const current = merged.get(key);
    if (!current || candidate.matchScore > current.matchScore) merged.set(key, candidate);
  }

  const unfiltered = Array.from(merged.values());
  const existingKeys = await readExistingCreatorKeys(unfiltered);
  const candidates = Array.from(merged.values())
    .filter((candidate) => !candidateExists(candidate, existingKeys))
    .sort((left, right) => right.matchScore - left.matchScore)
    .slice(0, normalizeLimit(limit));
  const hasPoolCandidate = pool.some((candidate) => !candidateExists(candidate, existingKeys));

  return {
    candidates,
    source: hasPoolCandidate ? "candidate_pool" : candidates.length > 0 ? "rec_candidates" : undefined,
  };
};

async function resolveCandidates(limit: number, fallback: RecCandidate[], candidateCriteria: CandidateCriteria): Promise<{ candidates: RecCandidate[]; source: RecommendationSource }> {
  try {
    let pool = await readRecommendationPools(limit);
    if (pool.candidates.length > 0 && pool.source) return { candidates: pool.candidates, source: pool.source };

    if (liveIntegrationsEnabled("youtube")) {
      await discoverAndPersistCandidates(candidateCriteria);
      pool = await readRecommendationPools(limit);
      if (pool.candidates.length > 0) return { candidates: pool.candidates, source: "live_discovery" };
    }
  } catch (error) {
    if (isEmulatorRuntime()) {
      return { candidates: fallback.slice(0, limit), source: "emulator_mock" };
    }
    throw error;
  }

  if (isEmulatorRuntime()) {
    return { candidates: fallback.slice(0, limit), source: "emulator_mock" };
  }

  throw new Error("recommendation candidate source unavailable");
}

export async function recommendCreators(request: CallableRequest) {
  const payload = parseRecommendationPayload(request.data);
  const campaignRef = payload.campaignRef ?? "campaigns/live-launch";
  const creatorRefs = payload.creatorRefs ?? [];
  const limit = normalizeLimit(payload.limit);
  const gameId = payload.gameId ?? campaignRef;
  const authContext = requireRole(request, gameId);
  const settings = await readSettings();
  const candidateCriteria = resolveCandidateCriteria(payload, settings.candidateCriteria);
  const emulatorFallback = isEmulatorRuntime()
    ? buildRecommendationMock({ campaignRef, creatorRefs, limit }).candidates
    : [];
  const cache = getRecommendationCache(campaignRef, creatorRefs);

  try {
    const { candidates, source } = await resolveCandidates(limit, emulatorFallback, candidateCriteria);
    const referenceTerms = await readRecommendationReferenceTerms(creatorRefs);
    const rerankedCandidates = rerankCandidatesBySimilarity(candidates, candidateCriteria, {
      campaignRef,
      creatorRefs,
      gameId,
      referenceTerms,
    });
    const costLog = createCostLog(source);
    const behaviorLog = createBehaviorLog(
      request,
      authContext,
      gameId,
      source === "emulator_mock" ? "mock" : "success",
      costLog.estimatedUsd,
    );

    return {
      campaignRef,
      creatorRefs,
      candidates: rerankedCandidates,
      engine: {
        campaignRef,
        creatorRefs,
        source,
        candidateCount: rerankedCandidates.length,
        similarity: "minisearch-bm25",
      },
      cache,
      costLog,
      behaviorLog,
    };
  } catch {
    const behaviorLog = createBehaviorLog(request, authContext, gameId, "error", 0);
    throw callableError(
      "recommendation candidate source unavailable",
      "failed-precondition",
      behaviorLog,
    );
  }
}
