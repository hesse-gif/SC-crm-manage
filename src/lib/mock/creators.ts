import type { Platform, Stage, GuideStatus } from "./core";

export interface Creator {
  id: string;
  name: string;
  handle: string;
  email?: string;
  type: "influencer" | "agency";
  avatar: string;
  platform: Platform;
  followers: number;
  region: string;
  category: string;
  stage: Stage;
  owner: string;
  /** 읽기 시점에 functions/ownerDisplayProjection 이 members 조인으로 해석한 담당자 표시명. 못 붙으면 "미지정". */
  ownerDisplayName?: string;
  budgetKRW: number;
  guideStatus: GuideStatus;
  aiHandling: boolean;
  lastActivity: string;
  agencyId?: string;
  team?: string;
  firestorePath?: string;
  youtubeUrl?: string;
  channelId?: string;
  primaryPlatform?: Platform;
  profileMatchedEmail?: string;
  protected?: boolean;
  archivedAt?: string;
  deletedAt?: string;
  humanGate?: "auto_reply" | "needs_review" | "blocked" | "auto_close";
  manualIntervention?: {
    status: "open" | "resolved";
    reason?: string;
    requestedAt?: string;
    requestedBy?: string;
  };
}

export interface Agency {
  id: string;
  name: string;
  region: string;
  owner: string;
  creatorIds: string[];
  firestorePath: string;
}

export interface PipelineTransition {
  from: Stage;
  to: Stage;
  writeFunction: "transitionCreatorStage";
  behaviorAction: "crm.stage.transition";
}

export const CRM_STAGE_TRANSITIONS: PipelineTransition[] = [
  { from: "contact", to: "negotiation", writeFunction: "transitionCreatorStage", behaviorAction: "crm.stage.transition" },
  { from: "negotiation", to: "contract", writeFunction: "transitionCreatorStage", behaviorAction: "crm.stage.transition" },
  { from: "contract", to: "review", writeFunction: "transitionCreatorStage", behaviorAction: "crm.stage.transition" },
  { from: "review", to: "live", writeFunction: "transitionCreatorStage", behaviorAction: "crm.stage.transition" },
];

export const AGENCIES: Agency[] = [
  { id: "a-total-gaming", name: "Arcade Collective Network", region: "IN", owner: "헤세", creatorIds: ["c2"], firestorePath: "agencies/a-total-gaming" },
  { id: "a-arab-games", name: "Desert Arcade Network", region: "SA", owner: "시몬", creatorIds: ["c5"], firestorePath: "agencies/a-arab-games" },
  { id: "a-pokemon-id", name: "Creature Quest Indonesia", region: "ID", owner: "헤세", creatorIds: ["c8"], firestorePath: "agencies/a-pokemon-id" },
];

// 공개 레포용 synthetic fixture. 실제 채널명·프로필 URL·개인 이메일은 포함하지 않는다.
// stage/owner/budget/guideStatus/aiHandling 등 운영 필드는 데모 값. 운영 쓰기는 Functions만 경유한다.
export const CREATORS: Creator[] = [
  { id: "c1", name: "Nova Play Studio", handle: "@nova-play-studio", type: "influencer", avatar: "https://example.test/avatar.png", platform: "YouTube", followers: 57000000, region: "US", category: "Action/Adventure", stage: "negotiation", owner: "헤세", budgetKRW: 3200000, guideStatus: "within", aiHandling: true, lastActivity: "10분 전", team: "flu", firestorePath: "creators/c1" },
  { id: "c2", name: "Arcade Collective", handle: "@arcade-collective", type: "agency", avatar: "https://example.test/avatar.png", platform: "YouTube", followers: 45700000, region: "IN", category: "MCN/네트워크", stage: "contract", owner: "헤세", budgetKRW: 8500000, guideStatus: "near", aiHandling: false, lastActivity: "1시간 전", agencyId: "a-total-gaming", team: "flu", firestorePath: "creators/c2" },
  { id: "c3", name: "Pixel Turbo", handle: "@pixel-turbo", type: "influencer", avatar: "https://example.test/avatar.png", platform: "YouTube", followers: 51700000, region: "IN", category: "Action/Simulation", stage: "contact", owner: "시몬", budgetKRW: 0, guideStatus: "within", aiHandling: true, lastActivity: "방금", team: "flu", firestorePath: "creators/c3" },
  { id: "c4", name: "Dungeon Dan", handle: "@dungeon-dan", type: "influencer", avatar: "https://example.test/avatar.png", platform: "YouTube", followers: 29100000, region: "GB", category: "Puzzle/Adventure", stage: "review", owner: "헤세", budgetKRW: 1500000, guideStatus: "within", aiHandling: false, lastActivity: "3시간 전", team: "flu", firestorePath: "creators/c4" },
  { id: "c5", name: "Desert Arcade Network", handle: "@desert-arcade-network", type: "agency", avatar: "https://example.test/avatar.png", platform: "YouTube", followers: 25800000, region: "SA", category: "MCN/네트워크", stage: "negotiation", owner: "시몬", budgetKRW: 14000000, guideStatus: "over", aiHandling: false, lastActivity: "25분 전", agencyId: "a-arab-games", team: "flu", firestorePath: "creators/c5" },
  { id: "c6", name: "Atlas Plays", handle: "@atlas-plays", type: "influencer", avatar: "https://example.test/avatar.png", platform: "YouTube", followers: 19700000, region: "GB", category: "Action/Adventure", stage: "live", owner: "헤세", budgetKRW: 2800000, guideStatus: "within", aiHandling: false, lastActivity: "어제", team: "flu", firestorePath: "creators/c6" },
  { id: "c7", name: "Riley Plays", handle: "@riley-plays", type: "influencer", avatar: "https://example.test/avatar.png", platform: "YouTube", followers: 40300000, region: "US", category: "Entertainment", stage: "contact", owner: "시몬", budgetKRW: 0, guideStatus: "within", aiHandling: true, lastActivity: "2시간 전", team: "flu", firestorePath: "creators/c7" },
  { id: "c8", name: "Creature Quest Indonesia", handle: "@creature-quest-id", type: "agency", avatar: "https://example.test/avatar.png", platform: "YouTube", followers: 20000000, region: "ID", category: "네트워크", stage: "contract", owner: "헤세", budgetKRW: 6200000, guideStatus: "within", aiHandling: false, lastActivity: "5시간 전", agencyId: "a-pokemon-id", team: "flu", firestorePath: "creators/c8" },
  { id: "c9", name: "Breeze Arcade", handle: "@breeze-arcade", type: "influencer", avatar: "https://example.test/avatar.png", platform: "YouTube", followers: 19600000, region: "ID", category: "RPG/Adventure", stage: "negotiation", owner: "헤세", budgetKRW: 2100000, guideStatus: "near", aiHandling: true, lastActivity: "40분 전", team: "flu", firestorePath: "creators/c9" },
  { id: "c10", name: "GH Sample", handle: "@gh-sample", type: "influencer", avatar: "https://example.test/avatar.png", platform: "YouTube", followers: 27600000, region: "KR", category: "Action", stage: "review", owner: "시몬", budgetKRW: 7400000, guideStatus: "within", aiHandling: false, lastActivity: "어제", team: "flu", firestorePath: "creators/c10" },
  { id: "rc-hesse", name: "Sample Studio Channel", handle: "@sample-studio-channel", email: "operator@example.test", type: "influencer", avatar: "https://example.test/avatar.png", platform: "YouTube", primaryPlatform: "YouTube", youtubeUrl: "https://www.youtube.com/@sample-studio-channel", channelId: "SAMPLE_CHANNEL_ID", profileMatchedEmail: "operator@example.test", followers: 2800000, region: "KR", category: "Mobile Game/XPHERO", stage: "contact", owner: "헤세", budgetKRW: 0, guideStatus: "within", aiHandling: true, lastActivity: "2026-06-21", team: "flu", firestorePath: "creators/rc-hesse", protected: true },
];

export const creatorById = (id: string) => CREATORS.find((c) => c.id === id);

// ── 채널 지표 (뷰수·최근 뷰수·참여율) — Infly long_avg_views 기반 ──
export interface ChannelStat {
  avgViews: number;
  recentViews: number; // 최근 30일 평균
  engagement: number; // %
  longAvgViews?: number;
  channelRef?: string;
  channelId?: string;
  subscriberCount?: number;
  videoCount?: number;
  viewCount?: number;
  metricSource?: "infly.long_avg_views" | "youtube.data-api";
  syncedAt?: string;
}

export const CHANNEL_STATS: Record<string, ChannelStat> = {
  c1: { avgViews: 30954030, recentViews: 28400000, engagement: 6.2, longAvgViews: 30954030, channelRef: "channels/c1", metricSource: "infly.long_avg_views", syncedAt: "mock" },
  c2: { avgViews: 748837, recentViews: 690000, engagement: 4.1, longAvgViews: 748837, channelRef: "channels/c2", metricSource: "infly.long_avg_views", syncedAt: "mock" },
  c3: { avgViews: 11287011, recentViews: 9800000, engagement: 5.7, longAvgViews: 11287011, channelRef: "channels/c3", metricSource: "infly.long_avg_views", syncedAt: "mock" },
  c4: { avgViews: 334506, recentViews: 410000, engagement: 3.8, longAvgViews: 334506, channelRef: "channels/c4", metricSource: "infly.long_avg_views", syncedAt: "mock" },
  c5: { avgViews: 235798, recentViews: 220000, engagement: 3.2, longAvgViews: 235798, channelRef: "channels/c5", metricSource: "infly.long_avg_views", syncedAt: "mock" },
  c6: { avgViews: 56920, recentViews: 71000, engagement: 2.9, longAvgViews: 56920, channelRef: "channels/c6", metricSource: "infly.long_avg_views", syncedAt: "mock" },
  c7: { avgViews: 2010000, recentViews: 1750000, engagement: 4.5, longAvgViews: 2010000, channelRef: "channels/c7", metricSource: "infly.long_avg_views", syncedAt: "mock" },
  c8: { avgViews: 20112, recentViews: 18500, engagement: 2.1, longAvgViews: 20112, channelRef: "channels/c8", metricSource: "infly.long_avg_views", syncedAt: "mock" },
  c9: { avgViews: 358097, recentViews: 402000, engagement: 4.8, longAvgViews: 358097, channelRef: "channels/c9", metricSource: "infly.long_avg_views", syncedAt: "mock" },
  c10: { avgViews: 820000, recentViews: 910000, engagement: 5.1, longAvgViews: 820000, channelRef: "channels/c10", metricSource: "infly.long_avg_views", syncedAt: "mock" },
  "rc-hesse": { avgViews: 1926, recentViews: 9631, engagement: 3.1, longAvgViews: 1926, channelRef: "youtube/SAMPLE_CHANNEL_ID", channelId: "SAMPLE_CHANNEL_ID", subscriberCount: 2800000, videoCount: 729, viewCount: 57769464, metricSource: "youtube.data-api", syncedAt: "2026-06-23T00:00:00.000Z" },
};
