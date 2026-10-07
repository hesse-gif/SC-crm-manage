// ── AI 발굴: LLM 리스트업 + 이메일 파인더 후보 풀 ──
// 이메일 파인더(Infly extractor.py 패턴): 채널 About → 영상 설명 → 공개 스크랩 → 분류·신뢰도
export type EmailStatus = "verified" | "guessed" | "none";
export const EMAIL_STATUS: Record<EmailStatus, { label: string; tone: "ok" | "warn" | "neutral" }> = {
  verified: { label: "확보", tone: "ok" },
  guessed: { label: "추정", tone: "warn" },
  none: { label: "미발견", tone: "neutral" },
};

import type { Platform } from "./core";

export type DiscoverySignal = "keyword" | "followers" | "region" | "recentActivity";
export type CommunityDiscoverySignal = "community" | "reddit" | "discord" | "x" | "web" | "publicSearch" | "emulatorFallback";

export interface PoolCandidate {
  id: string;
  name: string;
  handle: string;
  avatar: string;
  followers: number | null;
  region: string;
  category: string;
  matchScore: number;
  email: string | null;
  emailStatus: EmailStatus;
  emailSource?: string;
  confidence: number;
  platform?: Platform | "Email";
  sourcePlatform?: Platform;
  sourceKey?: "reddit" | "discord" | "x" | "web" | string;
  discoverySource?: string;
  sourceNote?: string;
  sourceUrl?: string;
  externalProfileUrl?: string;
  sourceDisplayUrl?: string;
  youtubeUrl?: string;
  channelRef?: string;
  candidateRef?: string;
  campaignCandidateRef?: string;
  canonicalProgramId?: string;
  programId?: string;
  programRef?: string;
  campaignId?: string;
  campaignRef?: string;
  sourceRunId?: string;
  sourceRunRef?: string;
  publicationCandidateRef?: string;
  publicationGenerationId?: string;
  queryRef?: string;
  recentActivity?: string;
  discoverySignals?: Array<DiscoverySignal | CommunityDiscoverySignal | string>;
  protected?: boolean;
  archivedAt?: string;
  deletedAt?: string;
  humanGate?: "needs_review" | "resolved";
  manualIntervention?: {
    requestedAt?: string;
    requestedBy?: string;
    reason?: string;
    status?: "open" | "resolved";
  };
}

export interface DiscoveryEngineRun {
  queryRef: string;
  campaignRef: string;
  source: "mock-youtube-callable";
  cache: { status: "hit" | "miss"; key: string; ttlSeconds: number };
  costLog: { provider: "mock"; model: "mock-discovery"; inputTokens: number; outputTokens: number; estimatedUsd: number };
  candidateIds: string[];
}

export interface EmailFinderRun {
  channelRef: string;
  status: EmailStatus;
  source: "about" | "video_description" | "public_scrape" | "none";
  confidence: number;
  cache: { status: "hit" | "miss"; key: string; ttlSeconds: number };
  costLog: { provider: "mock"; model: "mock-email-finder"; inputTokens: number; outputTokens: number; estimatedUsd: number };
}

export const CANDIDATE_POOL: PoolCandidate[] = [
  { id: "p1", name: "Bento Plays", handle: "@bentoplays", avatar: "🍱", followers: 320000, region: "US", category: "Casual", matchScore: 89, email: "biz@bentoplays.com", emailStatus: "verified", emailSource: "About 페이지", confidence: 96, platform: "YouTube", channelRef: "yt_channel_bento_plays", queryRef: "dq_casual_us_mid", recentActivity: "최근 14일 내 모바일 퍼즐 영상 3건", discoverySignals: ["keyword", "followers", "region", "recentActivity"] },
  { id: "p2", name: "Luna Mobile", handle: "@lunamobile", avatar: "🌙", followers: 180000, region: "BR", category: "Hyper Casual", matchScore: 85, email: "luna.collab@gmail.com", emailStatus: "verified", emailSource: "영상 설명", confidence: 92, platform: "YouTube", channelRef: "yt_channel_luna_mobile", queryRef: "dq_hyper_br_mid", recentActivity: "최근 Shorts 업로드 빈도 주 5회", discoverySignals: ["keyword", "region", "recentActivity"] },
  { id: "p3", name: "PixelHan", handle: "@pixelhan", avatar: "🟦", followers: 540000, region: "KR", category: "Mid-core", matchScore: 83, email: "contact@pixelhan.gg", emailStatus: "guessed", emailSource: "도메인 추정", confidence: 61, platform: "YouTube", channelRef: "yt_channel_pixelhan", queryRef: "dq_midcore_kr_high", recentActivity: "최근 라이브 스트림 평균 CCV 상승", discoverySignals: ["followers", "region", "recentActivity"] },
  { id: "p4", name: "Sora Games", handle: "@soragames", avatar: "🌸", followers: 95000, region: "JP", category: "Puzzle", matchScore: 80, email: "sora@soragames.jp", emailStatus: "verified", emailSource: "About 페이지", confidence: 90, platform: "YouTube", channelRef: "yt_channel_sora_games", queryRef: "dq_puzzle_jp_ugc", recentActivity: "최근 30일 퍼즐 게임 리뷰 4건", discoverySignals: ["keyword", "region", "recentActivity"] },
  { id: "p5", name: "Clip Master", handle: "@clipmaster", avatar: "🎞️", followers: 1200000, region: "US", category: "UGC/Shorts", matchScore: 78, email: null, emailStatus: "none", confidence: 0, platform: "YouTube", channelRef: "yt_channel_clip_master", queryRef: "dq_shorts_us_mega", recentActivity: "최근 숏폼 조회수 상위 5%", discoverySignals: ["followers", "region", "recentActivity"] },
  { id: "p6", name: "Indie Vault", handle: "@indievault", avatar: "🗝️", followers: 76000, region: "GB", category: "Indie", matchScore: 76, email: "hello@indievault.io", emailStatus: "verified", emailSource: "영상 설명", confidence: 88, platform: "YouTube", channelRef: "yt_channel_indie_vault", queryRef: "dq_indie_gb_ugc", recentActivity: "스팀 넥스트 페스트 리뷰 업로드", discoverySignals: ["keyword", "region", "recentActivity"] },
  { id: "p7", name: "MoaPlay", handle: "@moaplay", avatar: "🎮", followers: 240000, region: "KR", category: "Casual", matchScore: 74, email: "moaplay.biz@gmail.com", emailStatus: "guessed", emailSource: "도메인 추정", confidence: 58, platform: "YouTube", channelRef: "yt_channel_moaplay", queryRef: "dq_casual_kr_mid", recentActivity: "신작 모바일 게임 프리뷰 정기 업로드", discoverySignals: ["keyword", "followers", "region"] },
  { id: "p8", name: "Arena Kim", handle: "@arenakim", avatar: "🏟️", followers: 410000, region: "KR", category: "Mid-core", matchScore: 72, email: "arena@kim.gg", emailStatus: "verified", emailSource: "About 페이지", confidence: 84, platform: "YouTube", channelRef: "yt_channel_arena_kim", queryRef: "dq_midcore_kr_high", recentActivity: "RPG/전략 영상 댓글 참여율 상승", discoverySignals: ["keyword", "followers", "region", "recentActivity"] },
  { id: "p9", name: "Tiny Games", handle: "@tinygames", avatar: "🐣", followers: 33000, region: "ID", category: "UGC", matchScore: 69, email: null, emailStatus: "none", confidence: 0, platform: "YouTube", channelRef: "yt_channel_tiny_games", queryRef: "dq_ugc_id_seed", recentActivity: "주 6회 숏폼 업로드", discoverySignals: ["region", "recentActivity"] },
  { id: "p10", name: "Puzzle Yui", handle: "@puzzleyui", avatar: "🧩", followers: 150000, region: "JP", category: "Puzzle", matchScore: 67, email: "yui.collab@gmail.com", emailStatus: "verified", emailSource: "영상 설명", confidence: 80, platform: "YouTube", channelRef: "yt_channel_puzzle_yui", queryRef: "dq_puzzle_jp_mid", recentActivity: "최근 퍼즐 캠페인 협업 사례 공개", discoverySignals: ["keyword", "followers", "region"] },
];

export const DISCOVERY_ENGINE_RUNS: DiscoveryEngineRun[] = [
  {
    queryRef: "dq_casual_us_mid",
    campaignRef: "campaign_mock_discovery",
    source: "mock-youtube-callable",
    cache: { status: "miss", key: "youtubeSearch:dq_casual_us_mid", ttlSeconds: 3600 },
    costLog: { provider: "mock", model: "mock-discovery", inputTokens: 0, outputTokens: 0, estimatedUsd: 0 },
    candidateIds: ["p1", "p5"],
  },
];

export const EMAIL_FINDER_RUNS: EmailFinderRun[] = [
  {
    channelRef: "yt_channel_bento_plays",
    status: "verified",
    source: "about",
    confidence: 96,
    cache: { status: "miss", key: "emailFinder:yt_channel_bento_plays", ttlSeconds: 86400 },
    costLog: { provider: "mock", model: "mock-email-finder", inputTokens: 0, outputTokens: 0, estimatedUsd: 0 },
  },
];
