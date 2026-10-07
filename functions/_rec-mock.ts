// ── 추천 (Recommended for you) — 추천 엔진 결과 목업 ──
// 2단계: RRF 멀티소스 retrieval → relevance-gated weighted-sum rerank(임베딩 유사도·collab graph 포함)

export interface RecCandidate {
  id: string;
  name: string;
  handle: string;
  avatar: string;
  email?: string;
  platform: string;
  sourcePlatform?: string;
  sourceKey?: string;
  sourceUrl?: string;
  sourceNote?: string;
  discoverySource?: string;
  channelId?: string;
  youtubeUrl?: string;
  followers: number;
  region: string;
  category: string;
  matchScore: number; // 0-100 (RRF 융합 점수 + weighted rerank → 정규화)
  reasons: string[];
  breakdown: { relevance: number; similarity: number; freshness: number; contact: number };
}

type RetrievalSource = "keyword" | "category" | "partnerLookalike" | "region" | "growth";

type RecEngineSeed = Omit<RecCandidate, "matchScore" | "reasons" | "breakdown"> & {
  creatorRef: string;
  keywordRank: number;
  categoryRank: number;
  partnerLookalikeRank: number;
  regionRank: number;
  growthRank: number;
  relevance: number;
  embeddingSimilarity: number;
  collabGraph: number;
  freshness: number;
  contact: number;
  sanitizedReasonPool: string[];
};

export interface RecommendationRequestMock {
  campaignRef?: string;
  creatorRefs?: string[];
  limit?: number;
}

export interface RecommendationEngineTraceMock {
  campaignRef: string;
  creatorRefs: string[];
  retrieval: {
    method: "reciprocal_rank_fusion";
    sources: RetrievalSource[];
    k: number;
    candidateCount: number;
  };
  rerank: {
    method: "relevance_gated_weighted_sum";
    relevanceGate: number;
    weights: { relevance: number; embeddingSimilarity: number; collabGraph: number; freshness: number; contact: number };
  };
}

const RRF_K = 60;
const RELEVANCE_GATE = 60;
const RERANK_WEIGHTS = {
  relevance: 0.34,
  embeddingSimilarity: 0.24,
  collabGraph: 0.18,
  freshness: 0.14,
  contact: 0.10,
} as const;

const REC_ENGINE_SEEDS: RecEngineSeed[] = [
  {
    id: "rc-hesse",
    creatorRef: "creators/rc-hesse",
    name: "Supercent Official",
    handle: "@supercent_official",
    avatar: "https://yt3.ggpht.com/gf0wAEnwry8iGHxxMSusiFzcqbcj8nzX3k7S8rQMv4BoNJgP7KN9yLu7K9bBMof_PfuuIoDY9A=s800-c-k-c0x00ffffff-no-rj",
    email: "hesse@supercent.io",
    platform: "YouTube",
    followers: 2800000,
    region: "KR",
    category: "Mobile Game/XPHERO",
    keywordRank: 1,
    categoryRank: 1,
    partnerLookalikeRank: 1,
    regionRank: 1,
    growthRank: 1,
    relevance: 99,
    embeddingSimilarity: 96,
    collabGraph: 93,
    freshness: 95,
    contact: 100,
    sanitizedReasonPool: ["hesse@supercent.io 테스트 수신자", "@supercent_official 채널 매칭", "최근 XPHERO 콘텐츠 확인"],
  },
  {
    id: "rc1",
    creatorRef: "creators/minecraft",
    name: "Minecraft",
    handle: "@minecraft",
    avatar: "https://yt3.ggpht.com/2gEQWk9ws0NNWIOva0M7NwU9LtIDHfNvY0nLGdhqNvDUn3Sk4kNsTZQZ_ILl70CQrjKSZjhqAP0=s800-c-k-c0x00ffffff-no-rj",
    platform: "YouTube",
    followers: 19600000,
    region: "SE",
    category: "Adventure/Action",
    keywordRank: 1,
    categoryRank: 1,
    partnerLookalikeRank: 2,
    regionRank: 2,
    growthRank: 5,
    relevance: 95,
    embeddingSimilarity: 91,
    collabGraph: 89,
    freshness: 70,
    contact: 100,
    sanitizedReasonPool: ["기존 파트너와 유사 시청자층", "게임 카테고리 일치", "이메일 확보됨"],
  },
  {
    id: "rc2",
    creatorRef: "creators/roxicakegamer",
    name: "RoxiCake Gamer",
    handle: "@roxicakegamer",
    avatar: "https://yt3.ggpht.com/ytc/AIdro_ksHBi1JjROBQWfXc5rO-3LKs43R1SYntNgPmwxyPVstsc=s800-c-k-c0x00ffffff-no-rj",
    platform: "YouTube",
    followers: 16900000,
    region: "PE",
    category: "Action/Adventure",
    keywordRank: 3,
    categoryRank: 2,
    partnerLookalikeRank: 1,
    regionRank: 4,
    growthRank: 1,
    relevance: 80,
    embeddingSimilarity: 87,
    collabGraph: 90,
    freshness: 92,
    contact: 60,
    sanitizedReasonPool: ["최근 뷰 급상승", "유사 채널 그래프 연결", "액션 게임 시청자층 적합"],
  },
  {
    id: "rc3",
    creatorRef: "creators/pixelpop",
    name: "Pixel Pop",
    handle: "@pixelpop",
    avatar: "🟪",
    platform: "YouTube",
    followers: 880000,
    region: "US",
    category: "Casual/Puzzle",
    keywordRank: 2,
    categoryRank: 3,
    partnerLookalikeRank: 4,
    regionRank: 1,
    growthRank: 6,
    relevance: 88,
    embeddingSimilarity: 72,
    collabGraph: 69,
    freshness: 65,
    contact: 100,
    sanitizedReasonPool: ["캐주얼 신작 타깃 적합", "이메일 확보됨", "미드티어 효율 후보"],
  },
  {
    id: "rc4",
    creatorRef: "creators/mobilearena",
    name: "Mobile Arena",
    handle: "@mobilearena",
    avatar: "🎯",
    platform: "YouTube",
    followers: 1500000,
    region: "BR",
    category: "Hyper Casual",
    keywordRank: 5,
    categoryRank: 4,
    partnerLookalikeRank: 5,
    regionRank: 3,
    growthRank: 3,
    relevance: 75,
    embeddingSimilarity: 67,
    collabGraph: 64,
    freshness: 80,
    contact: 55,
    sanitizedReasonPool: ["하이퍼캐주얼 전문", "신규 지역(BR) 확장", "성장세 양호"],
  },
  {
    id: "rc5",
    creatorRef: "creators/yuagames",
    name: "Yua Games",
    handle: "@yuagames",
    avatar: "🌷",
    platform: "YouTube",
    followers: 210000,
    region: "JP",
    category: "Puzzle",
    keywordRank: 4,
    categoryRank: 5,
    partnerLookalikeRank: 6,
    regionRank: 5,
    growthRank: 4,
    relevance: 72,
    embeddingSimilarity: 61,
    collabGraph: 58,
    freshness: 70,
    contact: 70,
    sanitizedReasonPool: ["퍼즐 카테고리 일치", "참여율 상위", "지역 포트폴리오 보완"],
  },
  {
    id: "rc6",
    creatorRef: "creators/casualclips",
    name: "Casual Clips",
    handle: "@casualclips",
    avatar: "🎞️",
    platform: "YouTube",
    followers: 45000,
    region: "US",
    category: "UGC/Casual",
    keywordRank: 6,
    categoryRank: 6,
    partnerLookalikeRank: 3,
    regionRank: 6,
    growthRank: 2,
    relevance: 68,
    embeddingSimilarity: 58,
    collabGraph: 61,
    freshness: 85,
    contact: 50,
    sanitizedReasonPool: ["UGC 크리에이터 — 높은 참여율", "숏폼 다작·저비용", "유사 파트너 반응 양호"],
  },
  {
    id: "rc7",
    creatorRef: "creators/gamemoa",
    name: "GameMoa",
    handle: "@gamemoa",
    avatar: "🕹️",
    platform: "YouTube",
    followers: 28000,
    region: "KR",
    category: "UGC/Mobile",
    keywordRank: 7,
    categoryRank: 7,
    partnerLookalikeRank: 7,
    regionRank: 7,
    growthRank: 2,
    relevance: 66,
    embeddingSimilarity: 54,
    collabGraph: 51,
    freshness: 88,
    contact: 65,
    sanitizedReasonPool: ["국내 UGC", "최근 업로드 활발", "모바일 게임 소재 적합"],
  },
];

const rrfScore = (seed: RecEngineSeed) =>
  [seed.keywordRank, seed.categoryRank, seed.partnerLookalikeRank, seed.regionRank, seed.growthRank].reduce(
    (score, rank) => score + 1 / (RRF_K + rank),
    0,
  );

const weightedRerankScore = (seed: RecEngineSeed) =>
  seed.relevance * RERANK_WEIGHTS.relevance +
  seed.embeddingSimilarity * RERANK_WEIGHTS.embeddingSimilarity +
  seed.collabGraph * RERANK_WEIGHTS.collabGraph +
  seed.freshness * RERANK_WEIGHTS.freshness +
  seed.contact * RERANK_WEIGHTS.contact;

const normalizeScore = (rrf: number, rerank: number) => Math.round(Math.min(100, rerank * 0.82 + rrf * 110));

const toCandidate = (seed: RecEngineSeed): RecCandidate => {
  const similarity = Math.round(seed.embeddingSimilarity * 0.58 + seed.collabGraph * 0.42);

  return {
    id: seed.id,
    name: seed.name,
    handle: seed.handle,
    avatar: seed.avatar,
    email: seed.email,
    platform: seed.platform,
    followers: seed.followers,
    region: seed.region,
    category: seed.category,
    matchScore: normalizeScore(rrfScore(seed), weightedRerankScore(seed)),
    reasons: seed.sanitizedReasonPool.slice(0, 3),
    breakdown: {
      relevance: seed.relevance,
      similarity,
      freshness: seed.freshness,
      contact: seed.contact,
    },
  };
};

export function buildRecommendationMock(request: RecommendationRequestMock = {}): {
  campaignRef: string;
  creatorRefs: string[];
  candidates: RecCandidate[];
  trace: RecommendationEngineTraceMock;
} {
  const campaignRef = request.campaignRef ?? "campaigns/mock-launch";
  const candidateLimit = Math.max(1, Math.min(request.limit ?? REC_ENGINE_SEEDS.length, REC_ENGINE_SEEDS.length));
  const rankedSeeds = REC_ENGINE_SEEDS
    .filter((seed) => seed.relevance >= RELEVANCE_GATE)
    .sort((left, right) => {
      const leftScore = normalizeScore(rrfScore(left), weightedRerankScore(left));
      const rightScore = normalizeScore(rrfScore(right), weightedRerankScore(right));
      return rightScore - leftScore;
    })
    .slice(0, candidateLimit);
  const creatorRefs = request.creatorRefs?.length ? request.creatorRefs : rankedSeeds.map((seed) => seed.creatorRef);

  return {
    campaignRef,
    creatorRefs,
    candidates: rankedSeeds.map(toCandidate),
    trace: {
      campaignRef,
      creatorRefs,
      retrieval: {
        method: "reciprocal_rank_fusion",
        sources: ["keyword", "category", "partnerLookalike", "region", "growth"],
        k: RRF_K,
        candidateCount: rankedSeeds.length,
      },
      rerank: {
        method: "relevance_gated_weighted_sum",
        relevanceGate: RELEVANCE_GATE,
        weights: RERANK_WEIGHTS,
      },
    },
  };
}

export const REC_CANDIDATES: RecCandidate[] = buildRecommendationMock().candidates;

// 추천 티어 — UGC 크리에이터도 추천에 포함 (메가만 아니라 mid/UGC 믹스)
export const REC_TIER: Record<string, "mega" | "mid" | "ugc"> = {
  "rc-hesse": "ugc", rc1: "mega", rc2: "mega", rc3: "mid", rc4: "mid", rc5: "mid", rc6: "ugc", rc7: "ugc",
};

export const REC_TIER_LABEL: Record<"mega" | "mid" | "ugc", { label: string; tone: "accent" | "info" | "ai" }> = {
  mega: { label: "메가", tone: "accent" },
  mid: { label: "미드", tone: "info" },
  ugc: { label: "UGC", tone: "ai" },
};
