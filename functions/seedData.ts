// Flu 시드 데이터셋 — 프런트엔드 목업(src/lib/mock)과 동일한 값을 Firestore에 적재하기 위한 단일 소스.
// createSeedData가 이 데이터를 컬렉션별로 write하고, getDataset이 다시 read해 화면에 그대로 렌더한다.
// 즉 "시드됨 == 목업과 동일한 화면"이지만, 데이터 출처는 정적 상수가 아니라 Firestore다(SEC-P0-004: Functions 경유).
// 운영 필드(stage/owner/budget 등)는 데모 값. 채널/썸네일은 Infly youtube_influencers 기반 실제 채널.

export type SeedCreator = {
  id: string;
  name: string;
  handle: string;
  type: "influencer" | "agency";
  avatar: string;
  platform: "YouTube" | "Instagram" | "TikTok" | "X";
  followers: number;
  region: string;
  category: string;
  stage: "contact" | "negotiation" | "contract" | "review" | "live";
  owner: string;
  budgetKRW: number;
  guideStatus: "within" | "near" | "over";
  aiHandling: boolean;
  lastActivity: string;
  agencyId?: string;
  team?: string;
  firestorePath?: string;
};

export type SeedChannelStat = {
  id: string; // creatorId
  avgViews: number;
  recentViews: number;
  engagement: number;
  longAvgViews?: number;
  channelRef?: string;
  metricSource?: string;
  syncedAt?: string;
};

export const SEED_CREATORS: SeedCreator[] = [
  { id: "c1", name: "MrBeast Gaming", handle: "@mrbeastgaming", type: "influencer", avatar: "https://yt3.ggpht.com/ytc/AIdro_lMiSL6eHqg2dVxvll6mVMeXo1qVak4TZ4_7mEWdobRRCk=s800-c-k-c0x00ffffff-no-rj", platform: "YouTube", followers: 57000000, region: "US", category: "Action/Adventure", stage: "negotiation", owner: "데모운영자", budgetKRW: 3200000, guideStatus: "within", aiHandling: true, lastActivity: "10분 전", team: "flu", firestorePath: "creators/c1" },
  { id: "c2", name: "Total Gaming", handle: "@totalgaming093", type: "agency", avatar: "https://yt3.ggpht.com/ytc/AIdro_l7o9hDEiDVLvAW00YMnnYKzf4UpyJWhREfNWD3V33mBhM=s800-c-k-c0x00ffffff-no-rj", platform: "YouTube", followers: 45700000, region: "IN", category: "MCN/네트워크", stage: "contract", owner: "데모운영자", budgetKRW: 8500000, guideStatus: "near", aiHandling: false, lastActivity: "1시간 전", agencyId: "a-total-gaming", team: "flu", firestorePath: "creators/c2" },
  { id: "c3", name: "Techno Gamerz", handle: "@technogamerzofficial", type: "influencer", avatar: "https://yt3.ggpht.com/ytc/AIdro_mSh0doIgogNhhpzLcRYEMRorZefkBUe_6LYOWnLgzSyFc=s800-c-k-c0x00ffffff-no-rj", platform: "YouTube", followers: 51700000, region: "IN", category: "Action/Simulation", stage: "contact", owner: "데모매니저", budgetKRW: 0, guideStatus: "within", aiHandling: true, lastActivity: "방금", team: "flu", firestorePath: "creators/c3" },
  { id: "c4", name: "DanTDM", handle: "@dantdm", type: "influencer", avatar: "https://yt3.ggpht.com/1IPv4TRdl3RaT1HEsqdvjzqA0OvBHbVxZFt2U5QZHKDgbEGosdazeBqyJH9ZU5rhs9kfC8dGXRc=s800-c-k-c0x00ffffff-no-rj", platform: "YouTube", followers: 29100000, region: "GB", category: "Puzzle/Adventure", stage: "review", owner: "데모운영자", budgetKRW: 1500000, guideStatus: "within", aiHandling: false, lastActivity: "3시간 전", team: "flu", firestorePath: "creators/c4" },
  { id: "c5", name: "Arab Games Network", handle: "@arabgamesnetwork", type: "agency", avatar: "https://yt3.ggpht.com/ytc/AIdro_mid9j0O4gqIjBuoWNK3CG72LRvFpxzoFtEdjhngld91l0=s800-c-k-c0x00ffffff-no-rj", platform: "YouTube", followers: 25800000, region: "SA", category: "MCN/네트워크", stage: "negotiation", owner: "데모매니저", budgetKRW: 14000000, guideStatus: "over", aiHandling: false, lastActivity: "25분 전", agencyId: "a-arab-games", team: "flu", firestorePath: "creators/c5" },
  { id: "c6", name: "Ali-A", handle: "@alia", type: "influencer", avatar: "https://yt3.ggpht.com/PEWUpS4lfXweWds1DtbHnlVA0eVXmqypfHZe8-Hatzu_7Evzp3Efgf515TmeCXd_0po2Ypi08g=s800-c-k-c0x00ffffff-no-rj", platform: "YouTube", followers: 19700000, region: "GB", category: "Action/Adventure", stage: "live", owner: "데모운영자", budgetKRW: 2800000, guideStatus: "within", aiHandling: false, lastActivity: "어제", team: "flu", firestorePath: "creators/c6" },
  { id: "c7", name: "Ryan's World", handle: "@ryansworld", type: "influencer", avatar: "https://yt3.ggpht.com/ytc/AIdro_mIPCAPZ4k1NbKEYcWQ-TbtucaftdvpIaBZRjzOodYoWGA=s800-c-k-c0x00ffffff-no-rj", platform: "YouTube", followers: 40300000, region: "US", category: "Entertainment", stage: "contact", owner: "데모매니저", budgetKRW: 0, guideStatus: "within", aiHandling: true, lastActivity: "2시간 전", team: "flu", firestorePath: "creators/c7" },
  { id: "c8", name: "Pokémon Indonesia", handle: "@pokemonindonesiaofficial", type: "agency", avatar: "https://yt3.ggpht.com/YHH_fHzDV3t1_UYgdqhUp9xW1wZgG2X_5XfbLyl2cmL6b3-LEtdiWWDOxovrSJJu_ZZs9NvW-g=s800-c-k-c0x00ffffff-no-rj", platform: "YouTube", followers: 20000000, region: "ID", category: "네트워크", stage: "contract", owner: "데모운영자", budgetKRW: 6200000, guideStatus: "within", aiHandling: false, lastActivity: "5시간 전", agencyId: "a-pokemon-id", team: "flu", firestorePath: "creators/c8" },
  { id: "c9", name: "Windah Basudara", handle: "@windahbasudara", type: "influencer", avatar: "https://yt3.ggpht.com/ZM0JpQTkJn-wJ3OfOD_TLFPnI-uno1QrWz20JH_FBtWK1oUCq032OkHIHO4Rr27ul_czy8g6Xw=s800-c-k-c0x00ffffff-no-rj", platform: "YouTube", followers: 19600000, region: "ID", category: "RPG/Adventure", stage: "negotiation", owner: "데모운영자", budgetKRW: 2100000, guideStatus: "near", aiHandling: true, lastActivity: "40분 전", team: "flu", firestorePath: "creators/c9" },
  { id: "c10", name: "GH'S", handle: "@gh.s", type: "influencer", avatar: "https://yt3.ggpht.com/EIgEVfLNXj7LHM98mXOoG0mBE_7nsL6Pf9wjfiofqF5Un9akWxLbTIRZtasy3jd_WcaJmQxk=s800-c-k-c0x00ffffff-no-rj", platform: "YouTube", followers: 27600000, region: "KR", category: "Action", stage: "review", owner: "데모매니저", budgetKRW: 7400000, guideStatus: "within", aiHandling: false, lastActivity: "어제", team: "flu", firestorePath: "creators/c10" },
];

export const SEED_CHANNEL_STATS: SeedChannelStat[] = [
  { id: "c1", avgViews: 30954030, recentViews: 28400000, engagement: 6.2, longAvgViews: 30954030, channelRef: "channels/c1", metricSource: "infly.long_avg_views", syncedAt: "seed" },
  { id: "c2", avgViews: 748837, recentViews: 690000, engagement: 4.1, longAvgViews: 748837, channelRef: "channels/c2", metricSource: "infly.long_avg_views", syncedAt: "seed" },
  { id: "c3", avgViews: 11287011, recentViews: 9800000, engagement: 5.7, longAvgViews: 11287011, channelRef: "channels/c3", metricSource: "infly.long_avg_views", syncedAt: "seed" },
  { id: "c4", avgViews: 334506, recentViews: 410000, engagement: 3.8, longAvgViews: 334506, channelRef: "channels/c4", metricSource: "infly.long_avg_views", syncedAt: "seed" },
  { id: "c5", avgViews: 235798, recentViews: 220000, engagement: 3.2, longAvgViews: 235798, channelRef: "channels/c5", metricSource: "infly.long_avg_views", syncedAt: "seed" },
  { id: "c6", avgViews: 56920, recentViews: 71000, engagement: 2.9, longAvgViews: 56920, channelRef: "channels/c6", metricSource: "infly.long_avg_views", syncedAt: "seed" },
  { id: "c7", avgViews: 2010000, recentViews: 1750000, engagement: 4.5, longAvgViews: 2010000, channelRef: "channels/c7", metricSource: "infly.long_avg_views", syncedAt: "seed" },
  { id: "c8", avgViews: 20112, recentViews: 18500, engagement: 2.1, longAvgViews: 20112, channelRef: "channels/c8", metricSource: "infly.long_avg_views", syncedAt: "seed" },
  { id: "c9", avgViews: 358097, recentViews: 402000, engagement: 4.8, longAvgViews: 358097, channelRef: "channels/c9", metricSource: "infly.long_avg_views", syncedAt: "seed" },
  { id: "c10", avgViews: 820000, recentViews: 910000, engagement: 5.1, longAvgViews: 820000, channelRef: "channels/c10", metricSource: "infly.long_avg_views", syncedAt: "seed" },
];

export const SEED_AGENCIES = [
  { id: "a-total-gaming", name: "Total Gaming Network", region: "IN", owner: "데모운영자", creatorIds: ["c2"], firestorePath: "agencies/a-total-gaming" },
  { id: "a-arab-games", name: "Arab Games Network", region: "SA", owner: "데모매니저", creatorIds: ["c5"], firestorePath: "agencies/a-arab-games" },
  { id: "a-pokemon-id", name: "Pokémon Indonesia", region: "ID", owner: "데모운영자", creatorIds: ["c8"], firestorePath: "agencies/a-pokemon-id" },
];

// total은 assert-emulator-firestore.mjs의 assertCampaignTotals가 요구하는 대로
// queued(미기재 시 0)+sent+replied+negotiating+contracted+live 합과 정확히 일치시킨다(syncCampaignFunnel의 totalFunnel 계산과 동일 규칙).
// counterSource는 "카운터는 syncCampaignFunnel만 갱신"이라는 불변식을 시드 문서에도 표시하기 위한 필드.
export const SEED_CAMPAIGNS = [
  { id: "cp1", programId: "pg-xphero-creator-challenge", ownerUid: "flu-emulator-admin", createdBy: "flu-emulator-admin", name: "캐주얼 신작 글로벌 컨택", createdAtIso: "2026-06-15T00:00:00.000Z", owner: "데모운영자", source: "CSV", status: "발송중", priority: "긴급", counterSource: "syncCampaignFunnel", total: 14274, sent: 11900, replied: 1830, negotiating: 420, contracted: 88, live: 36, bounced: 540 },
  { id: "cp3", name: "퍼즐 KR 마이크로", createdAtIso: "2026-06-18T00:00:00.000Z", owner: "데모운영자", source: "검색", status: "발송중", priority: "높음", counterSource: "syncCampaignFunnel", total: 355, sent: 300, replied: 42, negotiating: 11, contracted: 2, live: 0, bounced: 8 },
  { id: "cp2", name: "하이퍼캐주얼 UGC 대량", createdAtIso: "2026-06-12T00:00:00.000Z", owner: "데모매니저", source: "CSV", status: "완료", priority: "보통", counterSource: "syncCampaignFunnel", total: 6333, sent: 5200, replied: 910, negotiating: 160, contracted: 41, live: 22, bounced: 210 },
  { id: "cp4", name: "Mid-core 추천 배치", createdAtIso: "2026-06-10T00:00:00.000Z", owner: "데모리뷰어", source: "추천", status: "완료", priority: "보통", counterSource: "syncCampaignFunnel", total: 447, sent: 320, replied: 88, negotiating: 24, contracted: 9, live: 6, bounced: 5 },
];

export const SEED_CONTRACTS = [
  { id: "k1", creatorId: "c1", title: "MrBeast Gaming — 전용 영상 1편", status: "ai_revised", valueKRW: 3000000, updatedAt: "10분 전", template: "표준 인플루언서 계약서 v3", templateRef: "tpl-influencer-v3", templateGate: { status: "attached", templateRef: "tpl-influencer-v3", required: true, reason: "standard_template_attached" } },
  { id: "k2", creatorId: "c2", title: "Total Gaming — 분기 패키지", status: "awaiting_sign", valueKRW: 8500000, updatedAt: "1시간 전", template: "표준 에이전시 계약서 v2", templateRef: "tpl-agency-v2", templateGate: { status: "attached", templateRef: "tpl-agency-v2", required: true, reason: "standard_template_attached" } },
  { id: "k3", creatorId: "c8", title: "Pokémon Indonesia — 숏폼 3편", status: "draft", valueKRW: 6200000, updatedAt: "5시간 전", template: "표준 에이전시 계약서 v2", templateRef: "tpl-agency-v2", templateGate: { status: "needs_review", templateRef: "tpl-agency-v2", required: true, reason: "draft_requires_template_validation" } },
  { id: "k4", creatorId: "c6", title: "Ali-A — 운영 영상", status: "signed", valueKRW: 2800000, updatedAt: "어제", template: "표준 인플루언서 계약서 v3", templateRef: "tpl-influencer-v3", templateGate: { status: "attached", templateRef: "tpl-influencer-v3", required: true, reason: "standard_template_attached" } },
  { id: "k5", creatorId: "c4", title: "DanTDM — 퍼즐 리뷰", status: "awaiting_sign", valueKRW: 1500000, updatedAt: "3시간 전", template: "표준 인플루언서 계약서 v3", templateRef: "tpl-influencer-v3", templateGate: { status: "attached", templateRef: "tpl-influencer-v3", required: true, reason: "standard_template_attached" } },
];

export const SEED_REVIEWS = [
  { id: "r1", creatorId: "c4", submissionId: "s4", deliverable: "퍼즐 리뷰 영상 (4:32)", submittedAt: "3시간 전", status: "pending", reviewer: "데모운영자", reasonCode: "missing_hashtag", payableStatus: "not_payable", payableAmountKRW: 1500000, cost: { currency: "KRW", amount: 1500000, vatIncluded: true }, checks: [{ label: "게임명 정확 노출", ok: true }, { label: "다운로드 링크 포함", ok: true }, { label: "필수 해시태그", ok: false }, { label: "가이드 문구", ok: true }] },
  { id: "r2", creatorId: "c10", submissionId: "s5", deliverable: "Mid-core 플레이 영상 (8:10)", submittedAt: "어제", status: "pass", reviewer: "데모매니저", reasonCode: "approved", payableStatus: "paid", payableAmountKRW: 6200000, cost: { currency: "KRW", amount: 6200000, vatIncluded: true }, transitionedAt: "06-18 14:02", checks: [{ label: "게임명 정확 노출", ok: true }, { label: "다운로드 링크 포함", ok: true }, { label: "필수 해시태그", ok: true }, { label: "가이드 문구", ok: true }] },
  { id: "r3", creatorId: "c6", submissionId: "s3", deliverable: "운영 영상 #2 (2:40)", submittedAt: "어제", status: "revise", reviewer: "데모운영자", reasonCode: "missing_link", payableStatus: "not_payable", payableAmountKRW: 2800000, cost: { currency: "KRW", amount: 2800000, vatIncluded: true }, transitionedAt: "06-16 10:15", checks: [{ label: "게임명 정확 노출", ok: true }, { label: "다운로드 링크 포함", ok: false }, { label: "필수 해시태그", ok: true }, { label: "가이드 문구", ok: false }] },
];

export const SEED_SUBMISSIONS = [
  { id: "s1", creatorId: "c1", title: "신작 콜라보 티저", kind: "숏폼", thumb: "🎮", views: 5400000, likes: 210000, comments: 8800, status: "게시", date: "06-12", reviewStatus: "pass", reviewReasonCode: "approved", payableStatus: "paid", payableAmountKRW: 3000000, paidAt: "06-19" },
  { id: "s2", creatorId: "c6", title: "신작 캐주얼 런 영상", kind: "영상", thumb: "▶️", views: 1200000, likes: 45000, comments: 2100, status: "게시", date: "06-15", reviewStatus: "pass", reviewReasonCode: "approved", payableStatus: "payable", payableAmountKRW: 2800000 },
  { id: "s3", creatorId: "c6", title: "운영 영상 #2", kind: "영상", thumb: "🎬", views: 880000, likes: 31000, comments: 1500, status: "수정요청", date: "06-16", reviewStatus: "revise", reviewReasonCode: "missing_link", payableStatus: "not_payable", payableAmountKRW: 2800000 },
  { id: "s4", creatorId: "c4", title: "퍼즐 리뷰", kind: "영상", thumb: "🧩", views: 540000, likes: 22000, comments: 980, status: "검수중", date: "06-18", reviewStatus: "pending", reviewReasonCode: "missing_hashtag", payableStatus: "not_payable", payableAmountKRW: 1500000 },
  { id: "s5", creatorId: "c10", title: "Mid-core 플레이", kind: "영상", thumb: "🕹️", views: 910000, likes: 38000, comments: 1700, status: "게시", date: "06-14", reviewStatus: "pass", reviewReasonCode: "approved", payableStatus: "paid", payableAmountKRW: 6200000, paidAt: "06-18" },
  { id: "s6", creatorId: "c10", title: "하이라이트 숏폼", kind: "숏폼", thumb: "⚡", views: 2300000, likes: 120000, comments: 3400, status: "게시", date: "06-17", reviewStatus: "pass", reviewReasonCode: "approved", payableStatus: "payable", payableAmountKRW: 1800000 },
];

export const SEED_VIDEOS = [
  { videoId: "16QT6Cr3Lq0", title: "LUAN GAMEPLAYS ACHA O GOD OF WAR ANTIGO MELHOR! #godofwar", channel: "Game Shark", views: 124781, likes: 7322, comments: 193, published: "2026-06-06", thumb: "https://i.ytimg.com/vi/16QT6Cr3Lq0/maxresdefault.jpg", tag: "커뮤니티" },
  { videoId: "eoNURcNhCjA", title: "Реалистичные обновления для игр. Часть 3. #games #shorts", channel: "Vitaliks", views: 11325, likes: 1019, comments: 27, published: "2026-06-04", thumb: "https://i.ytimg.com/vi/eoNURcNhCjA/maxresdefault.jpg", tag: "UGC" },
  { videoId: "B3EWEUMTakg", title: "BARU RILIS TRAILER, EHH MALAH DIHUJAT 😡 #godofwar #games", channel: "Crazy Games Ind", views: 9310, likes: 671, comments: 52, published: "2026-06-04", thumb: "https://i.ytimg.com/vi/B3EWEUMTakg/maxresdefault.jpg", tag: "UGC" },
  { videoId: "jhwYDynLhqE", title: "EX ROCKSTAR DIZ QUE GTA 6 PODE DECEPCIONAR! #gta6", channel: "Game Shark", views: 8262, likes: 378, comments: 11, published: "2026-06-05", thumb: "https://i.ytimg.com/vi/jhwYDynLhqE/maxresdefault.jpg", tag: "커뮤니티" },
  { videoId: "xC9HWAcr3yI", title: "Vai Ter Jogo Bom? Future Games Show na E3 2026", channel: "Velberan", views: 6727, likes: 462, comments: 2, published: "2026-06-06", thumb: "https://i.ytimg.com/vi/xC9HWAcr3yI/maxresdefault.jpg", tag: "커뮤니티" },
  { videoId: "C8bTcrosZZo", title: "ดูสดพร้อมกัน Future Games Show 2026", channel: "Gamer Inside", views: 6550, likes: 147, comments: 1, published: "2026-06-06", thumb: "https://i.ytimg.com/vi/C8bTcrosZZo/maxresdefault.jpg", tag: "자사" },
  { videoId: "HO1i0AclKps", title: "The Creepiest MYSTERY in GTA 5", channel: "GAMERANGE", views: 3446, likes: 82, comments: 2, published: "2026-06-04", thumb: "https://i.ytimg.com/vi/HO1i0AclKps/maxresdefault.jpg", tag: "커뮤니티" },
  { videoId: "CuDw5hp9HUo", title: "Shape-shifting Funny Race new hyper casual game #gameplay", channel: "World Game x Me", views: 3017, likes: 25, comments: 0, published: "2026-06-04", thumb: "https://i.ytimg.com/vi/CuDw5hp9HUo/maxresdefault.jpg", tag: "유료" },
  { videoId: "hEuuWfBMRmQ", title: "ดูสดพร้อมกัน SEA Games & Wholesome Direct", channel: "Gamer Inside", views: 2421, likes: 54, comments: 1, published: "2026-06-06", thumb: "https://i.ytimg.com/vi/hEuuWfBMRmQ/maxresdefault.jpg", tag: "자사" },
  { videoId: "Ue5mUlZ1z3I", title: "Police prank #roblox #funny #games #minecraft", channel: "Youtube Gamer", views: 2282, likes: 18, comments: 0, published: "2026-06-04", thumb: "https://i.ytimg.com/vi/Ue5mUlZ1z3I/maxresdefault.jpg", tag: "UGC" },
  { videoId: "ADr2FUqtUD0", title: "Top 3 Rarest Secret Weapons in RDR2", channel: "GAMERANGE", views: 1452, likes: 55, comments: 0, published: "2026-06-06", thumb: "https://i.ytimg.com/vi/ADr2FUqtUD0/maxresdefault.jpg", tag: "커뮤니티" },
  { videoId: "Je8IHhEUk4k", title: "Thailand Game Dev & Media #2 — 게임 제작 준비", channel: "Gamer Inside", views: 1274, likes: 50, comments: 0, published: "2026-06-06", thumb: "https://i.ytimg.com/vi/Je8IHhEUk4k/maxresdefault.jpg", tag: "유료" },
  { videoId: "addemo00001", creatorId: "p1", channelId: "p1", title: "협찬 캐주얼 퍼즐 게임 광고 리뷰 #광고 #sponsored", description: "This video is sponsored. 유료 광고 포함. Casual mobile puzzle gameplay for a broad audience.", channel: "Bento Plays", views: 50000, likes: 3000, comments: 120, published: "2026-06-30", publishedAtIso: "2026-06-30T00:00:00.000Z", thumb: "https://i.ytimg.com/vi/addemo00001/hqdefault.jpg", thumbnailUrl: "https://i.ytimg.com/vi/addemo00001/hqdefault.jpg", tag: "유료", language: "ko", url: "https://www.youtube.com/watch?v=addemo00001", adClassification: { isAd: true, adConfidence: 0.9, adSignals: ["#광고", "sponsored", "유료 광고 포함"], gameFit: 0.85, fitReasons: ["casual puzzle gameplay", "broad casual-game audience"], verdict: "good_ad_candidate", classificationSource: "text_v1", model: "seed", promptVersion: 1 } },
  { videoId: "addemo00002", creatorId: "p4", channelId: "p4", title: "スポンサー パズルゲーム紹介 #pr #広告", description: "この動画はスポンサー広告を含みます。カジュアル モバイル パズルゲーム。", channel: "Sora Games", views: 42000, likes: 2100, comments: 90, published: "2026-06-29", publishedAtIso: "2026-06-29T00:00:00.000Z", thumb: "https://i.ytimg.com/vi/addemo00002/hqdefault.jpg", thumbnailUrl: "https://i.ytimg.com/vi/addemo00002/hqdefault.jpg", tag: "유료", language: "ja", url: "https://www.youtube.com/watch?v=addemo00002", adClassification: { isAd: true, adConfidence: 0.88, adSignals: ["#広告", "スポンサー"], gameFit: 0.8, fitReasons: ["casual puzzle mobile game"], verdict: "good_ad_candidate", classificationSource: "text_v1", model: "seed", promptVersion: 1 } },
  { videoId: "addemo00003", creatorId: "p6", channelId: "p6", title: "Indie casual game first look — cozy mobile puzzle", description: "casual mobile puzzle gameplay, no sponsorship.", channel: "Indie Vault", views: 28000, likes: 1400, comments: 60, published: "2026-06-28", publishedAtIso: "2026-06-28T00:00:00.000Z", thumb: "https://i.ytimg.com/vi/addemo00003/hqdefault.jpg", thumbnailUrl: "https://i.ytimg.com/vi/addemo00003/hqdefault.jpg", tag: "UGC", language: "en", url: "https://www.youtube.com/watch?v=addemo00003", adClassification: { isAd: false, adConfidence: 0.1, adSignals: [], gameFit: 0.75, fitReasons: ["casual puzzle gameplay", "cozy broad audience"], verdict: "organic_good_fit", classificationSource: "text_v1", model: "seed", promptVersion: 1 } },
];

export const SEED_CANDIDATE_POOL = [
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

export const SEED_MEMBERS = [
  { id: "u1", name: "데모운영자", email: "demo.operator@example.com", avatar: "https://yt3.ggpht.com/gf0wAEnwry8iGHxxMSusiFzcqbcj8nzX3k7S8rQMv4BoNJgP7KN9yLu7K9bBMof_PfuuIoDY9A=s800-c-k-c0x00ffffff-no-rj", role: "manager", team: "AIX", assigned: 6, status: "active", lastActive: "방금" },
  { id: "u2", name: "데모매니저", email: "demo.manager@example.com", avatar: "시", role: "admin", team: "AIX", assigned: 4, status: "active", lastActive: "10분 전" },
  { id: "u3", name: "데모관리자", email: "demo.admin@example.com", avatar: "티", role: "super_admin", team: "AIX", assigned: 0, status: "active", lastActive: "1시간 전" },
  { id: "u4", name: "데모뷰어", email: "demo.viewer@example.com", avatar: "루", role: "viewer", team: "Growth", assigned: 0, status: "active", lastActive: "어제" },
  { id: "u5", name: "데모리뷰어", email: "demo.reviewer@example.com", avatar: "제", role: "manager", team: "Growth", assigned: 3, status: "active", lastActive: "2시간 전" },
  { id: "u6", name: "신규 가입자", email: "demo.guest@example.com", avatar: "N", role: "guest", team: "—", assigned: 0, status: "pending", lastActive: "방금" },
];

export const SEED_ESCALATIONS = [
  { id: "e1", creatorId: "c5", reason: "협의가 가이드 상한 초과", requestedKRW: 14000000, guideMaxKRW: 11000000, overPct: 28, time: "25분 전", contractRef: "contract/k6", round: 3, guideDelta: { targetPct: 80, requestedPct: 127, walkAwayPct: 110 } },
  { id: "e2", creatorId: "c9", reason: "제안가 상한 92% 근접", requestedKRW: 2100000, guideMaxKRW: 2280000, overPct: -8, time: "40분 전", contractRef: "contract/k7", round: 4, guideDelta: { targetPct: 80, requestedPct: 92, walkAwayPct: 110 } },
];

export const SEED_COMMUNITY_POSTS = [
  { id: "p-xphero-reddit", source: "Reddit", subreddit: "r/XPHero", title: "XPHERO creator clips and gameplay feedback thread", sentiment: "positive", score: 184, comments: 37, time: "오늘", createdAtIso: "2026-06-27T18:42:50.118Z", game: "XPHERO", matchedGame: "XPHERO", sourceUrl: "https://www.reddit.com/r/XPHero/search/?q=XPHERO%20creator%20clips%20gameplay&restrict_sr=1&sort=new" },
  { id: "p1", source: "Reddit", subreddit: "r/AndroidGaming", title: "Pizza Ready gameplay loop is surprisingly polished", sentiment: "positive", score: 312, comments: 48, time: "2시간 전", createdAtIso: "2026-06-27T07:00:00.000Z", game: "Pizza Ready", sourceUrl: "https://www.reddit.com/r/AndroidGaming/search/?q=Pizza%20Ready%20Supercent" },
  { id: "p2", source: "Reddit", subreddit: "r/iosgaming", title: "Burger Please has too many ads after level 10", sentiment: "negative", score: 87, comments: 63, time: "5시간 전", createdAtIso: "2026-06-27T04:00:00.000Z", game: "Burger Please", sourceUrl: "https://www.reddit.com/r/iosgaming/search/?q=Burger%20Please%20Supercent" },
  { id: "p3", source: "Reddit", subreddit: "r/puzzlegames", title: "Anyone else hooked on Snake Clash puzzle runs?", sentiment: "positive", score: 201, comments: 29, time: "어제", createdAtIso: "2026-06-26T10:00:00.000Z", game: "Snake Clash", sourceUrl: "https://www.reddit.com/r/puzzlegames/search/?q=Snake%20Clash%20Supercent" },
  { id: "p4", source: "Discord", subreddit: "discord.gg/demo-creators", title: "Creator asking for XPHERO sponsorship slots this week", sentiment: "positive", score: 42, comments: 11, time: "오늘", createdAtIso: "2026-06-27T08:40:00.000Z", game: "XPHERO", sourceUrl: "https://discord.example.com/demo-creators" },
  { id: "p5", source: "X", subreddit: "@SupercentCreators", title: "Shorts creators comparing XPHERO with new casual boss fight clips", sentiment: "neutral", score: 96, comments: 21, time: "오늘", createdAtIso: "2026-06-27T06:50:00.000Z", game: "XPHERO", sourceUrl: "https://x.com/search?q=XPHERO%20Supercent%20creator%20clips&f=live" },
  { id: "p6", source: "Web", subreddit: "creator-news", title: "Mobile game reviewers are rotating into Dinosaur Universe clips", sentiment: "neutral", score: 18, comments: 4, time: "2일 전", createdAtIso: "2026-06-25T12:30:00.000Z", game: "Dinosaur Universe", sourceUrl: "https://www.example.com/" },
];

// S12(d): byTool/updatedAtIso를 첫 문서에 포함시켜 e2e(llm-monitoring.spec.ts)가 "기능별 사용 현황" +
// "마지막 사용" 표시를 실 시드 데이터로 검증할 수 있게 한다(다른 문서는 기존 스키마 그대로 유지 — hetero 방어 회귀 확인 겸용).
export const SEED_LLM_USAGE = [
  {
    id: "qwen3-32b",
    model: "Qwen3-32B",
    tier: "빠른",
    calls: 1840,
    tokensK: 920,
    costKRW: 41000,
    share: 58,
    byTool: {
      "mail.coldmail_translate": { calls: 1200, tokensK: 600, costMilliKRW: 25000000 },
      gatewayProxy: { calls: 640, tokensK: 320, costMilliKRW: 16000000 },
    },
    updatedAtIso: "2026-07-07T09:00:00.000Z",
  },
  { id: "gemma3-27b", model: "Gemma 3 27B", tier: "빠른", calls: 610, tokensK: 280, costKRW: 12000, share: 17 },
  { id: "qwen3-235b", model: "Qwen3-235B (MaaS)", tier: "품질", calls: 220, tokensK: 410, costKRW: 26000, share: 22 },
  { id: "solar-pro-3", model: "Solar Pro 3 (self-host)", tier: "품질", calls: 40, tokensK: 60, costKRW: 5000, share: 3 },
];

export const SEED_CONVERSATIONS = [
  {
    id: "v-hesse",
    threadId: "v-hesse",
    contextKey: "mail:v-hesse",
    creatorId: "rc-hesse",
    creatorName: "Demo Studio Official",
    creatorAvatar: "https://yt3.ggpht.com/gf0wAEnwry8iGHxxMSusiFzcqbcj8nzX3k7S8rQMv4BoNJgP7KN9yLu7K9bBMof_PfuuIoDY9A=s800-c-k-c0x00ffffff-no-rj",
    creatorEmail: "demo.operator@example.com",
    creatorHandle: "@demo_studio_official",
    creatorPlatform: "YouTube",
    creatorFollowers: 2800000,
    source: "mvp-live-test",
    protected: true,
    seedWrite: false,
    unread: 0,
    aiActive: true,
    hasCreatorReply: true,
    lastMessageFrom: "creator",
    lastMessageAtIso: "2026-06-23T04:16:00.000Z",
    lastInboundAtIso: "2026-06-23T04:16:00.000Z",
    lastMessageRef: "mailref_hesse_in_001",
    messages: [
      { id: "m1", from: "human", author: "데모운영자", time: "13:11", createdAtIso: "2026-06-23T04:11:00.000Z", text: "MVP 테스트 컨택 발송 — demo.operator@example.com", trackingId: "flu-hesse-out-001", messageRef: "mailref_hesse_out_001", humanGate: "auto_reply" },
      { id: "m2", from: "ai", author: "Flu AI", time: "13:12", createdAtIso: "2026-06-23T04:12:00.000Z", text: "추천 후보 저장 후 협업 제안 메일이 발송 대기열에 기록됨", trackingId: "flu-hesse-out-001", messageRef: "summary_hesse_out_001", humanGate: "auto_reply" },
      { id: "m3", from: "creator", author: "de***@example.com", time: "13:16", createdAtIso: "2026-06-23T04:16:00.000Z", text: "테스트 수신자가 협업 워크플로우 확인을 위해 회신 가능 상태", trackingId: "flu-hesse-in-001", messageRef: "mailref_hesse_in_001", humanGate: "auto_reply" },
    ],
  },
  {
    id: "v-verify-console",
    threadId: "v-verify-console",
    contextKey: "mail:v-verify-console",
    creatorId: "verify-creator",
    creatorName: "Verify Creator",
    creatorEmail: "verify.creator@example.test",
    creatorHandle: "@verify_creator",
    creatorPlatform: "YouTube",
    type: "campaign",
    primaryBucket: "program",
    programId: "pg-xphero-creator-challenge",
    campaignId: "cp1",
    source: "verify-console",
    protected: true,
    seedWrite: false,
    unread: 0,
    aiActive: true,
    hasCreatorReply: true,
    lastMessageFrom: "creator",
    lastMessageAtIso: "2026-07-22T00:00:00.000Z",
    lastInboundAtIso: "2026-07-22T00:00:00.000Z",
    lastMessageRef: "mailref_verify_in_001",
    messages: [
      { id: "m1", from: "creator", author: "verify.creator@example.test", time: "09:00", createdAtIso: "2026-07-22T00:00:00.000Z", text: "Verify console scoped reply", trackingId: "verify-track-001", messageRef: "mailref_verify_in_001", humanGate: "auto_reply" },
    ],
  },
  {
    id: "v1", creatorId: "c1", unread: 0, aiActive: true,
    messages: [
      { id: "m1", from: "human", author: "데모운영자", time: "09:12", text: "첫 컨택 — 신작 협업 제안", trackingId: "flu-v1-out-001", messageRef: "msgref_v1_m1", humanGate: "auto_reply" },
      { id: "m2", from: "creator", author: "MrBeast Gaming", time: "09:40", text: "관심 있음 — 전용 영상 단가 문의", trackingId: "flu-v1-in-001", messageRef: "msgref_v1_m2", humanGate: "auto_reply" },
      { id: "m3", from: "ai", author: "Flu AI", time: "09:41", text: "가이드 내 단가 제안($2,000–2,400) 자동 회신", trackingId: "flu-v1-out-002", messageRef: "draftref_v1_m3", humanGate: "auto_reply" },
      { id: "m4", from: "creator", author: "MrBeast Gaming", time: "10:02", text: "$2,300 / 다음 주 진행 희망", trackingId: "flu-v1-in-002", messageRef: "msgref_v1_m4", humanGate: "auto_reply" },
      { id: "m5", from: "ai", author: "Flu AI", time: "10:03", text: "$2,300 가이드 이내 확정 — 계약서 초안 준비", trackingId: "flu-v1-out-003", messageRef: "draftref_v1_m5", humanGate: "auto_reply" },
    ],
  },
  {
    id: "v2", creatorId: "c5", unread: 2, aiActive: false,
    alert: "협의 금액(₩14,000,000)이 비용 가이드 상한을 28% 초과 — 사람 검수 필요",
    messages: [
      { id: "m1", from: "human", author: "데모매니저", time: "어제", text: "5인 패키지 단가 협의 시작", trackingId: "flu-v2-out-001", messageRef: "msgref_v2_m1", humanGate: "auto_reply" },
      { id: "m2", from: "creator", author: "Arab Games Network", time: "어제", text: "5인 패키지 총 $10,500 요청", trackingId: "flu-v2-in-001", messageRef: "msgref_v2_m2", humanGate: "needs_review" },
      { id: "m3", from: "ai", author: "Flu AI", time: "어제", text: "⚠️ 가이드 상한(₩11.0M) 초과 — 자동 회신 중단·담당자 에스컬레이션", messageRef: "gateref_v2_m3", humanGate: "blocked" },
    ],
  },
  {
    id: "v3", creatorId: "c3", unread: 1, aiActive: true,
    messages: [
      { id: "m1", from: "ai", author: "Flu AI", time: "10:18", createdAtIso: "2026-06-23T01:18:00.000Z", text: "신작 협업 제안 (자동 컨택)", trackingId: "flu-v3-out-001", messageRef: "draftref_v3_m1", humanGate: "auto_reply" },
      { id: "m2", from: "creator", author: "Techno Gamerz", time: "10:22", createdAtIso: "2026-06-23T01:22:00.000Z", text: "관심 있음 — 상세 요청", trackingId: "flu-v3-in-001", messageRef: "msgref_v3_m2", humanGate: "auto_reply" },
    ],
  },
  {
    id: "v4", creatorId: "c9", unread: 0, aiActive: true,
    alert: "제안가(₩2,100,000)가 가이드 상한의 92% — 근접 경고",
    messages: [
      { id: "m1", from: "human", author: "데모운영자", time: "11:20", text: "퍼즐 신작 단가 조율", trackingId: "flu-v4-out-001", messageRef: "msgref_v4_m1", humanGate: "auto_reply" },
      { id: "m2", from: "creator", author: "Windah Basudara", time: "11:35", text: "€1,500 요청", trackingId: "flu-v4-in-001", messageRef: "msgref_v4_m2", humanGate: "needs_review" },
      { id: "m3", from: "ai", author: "Flu AI", time: "11:36", text: "€1,500 ≈ ₩2.1M, 상한 92% 근접 — 회신 전 담당자 확인 권장", messageRef: "gateref_v4_m3", humanGate: "needs_review" },
    ],
  },
];

const HESSE_MESSAGE_SOURCE_IDS = new Set(["mailref_hesse_out_001", "summary_hesse_out_001", "mailref_hesse_in_001"]);

export const SEED_MESSAGE_SOURCES: Array<Record<string, unknown> & { id: string }> = [
  {
    id: "mailref_hesse_out_001",
    messageRef: "mailref_hesse_out_001",
    conversationId: "v-hesse",
    direction: "outbound",
    from: "partnerships@example.com",
    to: "demo.operator@example.com",
    subject: "Supercent Flu MVP workflow test",
    summaryKr: "MVP 테스트 컨택 발송 — demo.operator@example.com",
    body: [
      "안녕하세요 demo.operator@example.com 테스트 수신자님,",
      "",
      "Flu MVP 워크플로우 검증을 위해 Supercent 캠페인 협업 제안 메일을 발송합니다.",
      "추천 후보에서 관리 대상으로 전환된 뒤, 캠페인 컨택과 채팅 누적 흐름이 정상 동작하는지 확인하는 테스트입니다.",
      "수신 확인 후 회신이 들어오면 AI 요약본만 대화 데이터에 남고, 이 전문은 message_sources에만 보관됩니다.",
      "",
      "감사합니다.",
      "Supercent Partnerships",
    ].join("\n"),
    createdAtIso: "2026-06-23T04:11:00.000Z",
  },
  {
    id: "summary_hesse_out_001",
    messageRef: "summary_hesse_out_001",
    conversationId: "v-hesse",
    direction: "system",
    from: "flu-ai@example.com",
    to: "demo.operator@example.com",
    subject: "AI summary for Supercent Flu MVP workflow test",
    summaryKr: "추천 후보 저장 후 협업 제안 메일이 발송 대기열에 기록됨",
    body: [
      "AI 요약 기록",
      "",
      "Demo Studio Official 추천 후보가 관리 목록에 저장되었고, 협업 제안 메일 발송 대기열과 채팅 메시지 참조가 생성되었습니다.",
      "대화 화면에는 요약만 표시하며, 메일 전문은 권한 확인 후 message_sources에서 조회합니다.",
    ].join("\n"),
    createdAtIso: "2026-06-23T04:12:00.000Z",
  },
  {
    id: "mailref_hesse_in_001",
    messageRef: "mailref_hesse_in_001",
    conversationId: "v-hesse",
    direction: "inbound",
    from: "demo.operator@example.com",
    to: "partnerships@example.com",
    subject: "Re: Supercent Flu MVP workflow test",
    summaryKr: "테스트 수신자가 협업 워크플로우 확인을 위해 회신 가능 상태",
    body: [
      "안녕하세요 Supercent Partnerships 팀,",
      "",
      "테스트 메일 수신 확인했습니다.",
      "추천 후보 추가, 관리 목록 전환, 채팅 요약 누적, 원문 호버 조회까지 이어지는 MVP 전 워크플로우 검증에 사용할 수 있습니다.",
      "",
      "demo.operator@example.com",
    ].join("\n"),
    createdAtIso: "2026-06-23T04:16:00.000Z",
  },
  ...SEED_CONVERSATIONS.flatMap((conversation) =>
    conversation.messages.map((message) => ({
      id: message.messageRef,
      messageRef: message.messageRef,
      conversationId: conversation.id,
      direction: message.from === "creator" ? "inbound" : "outbound",
      from: message.from === "creator" ? `${message.author} <creator@example.com>` : `${message.author} <partnerships@example.com>`,
      to: message.from === "creator" ? "partnerships@example.com" : "creator@example.com",
      subject: `Flu conversation source: ${conversation.id}`,
      summaryKr: message.text,
      body: [
        `대화 ${conversation.id}의 보관 메시지입니다.`,
        "",
        `요약: ${message.text}`,
        `추적 ID: ${message.trackingId ?? message.messageRef}`,
        "",
        "운영 데이터에서는 실제 발송 또는 수신된 메일 전문이 이 문서에 저장됩니다.",
      ].join("\n"),
      createdAtIso: typeof (message as { createdAtIso?: unknown }).createdAtIso === "string"
        ? (message as { createdAtIso: string }).createdAtIso
        : "seed",
    })),
  ).filter((source) => !HESSE_MESSAGE_SOURCE_IDS.has(source.id)),
];

export const SEED_AUTO_REPLY = [
  {
    id: "default",
    enabled: true,
    model: "Claude (내부 Gateway 경유)",
    tone: "정중·간결",
    workingHours: "평시 즉시 회신 / 야간 대기열",
    rules: [
      { id: "a1", label: "가이드 범위 내 단가 자동 회신", desc: "시작가~상한 이내 협의는 AI가 즉시 회신", enabled: true, scope: "ai" },
      { id: "a2", label: "표준 계약서 초안·수정본 자동 작성", desc: "표준 템플릿이 있으면 AI가 작성/수정해 회신", enabled: true, scope: "ai" },
      { id: "a3", label: "가이드 초과 시 자동 회신 중단", desc: "상한 초과·근접 시 사람에게 에스컬레이션", enabled: true, scope: "human" },
      { id: "a4", label: "신규 에이전시 첫 거래는 사람 확인", desc: "첫 계약은 항상 담당자 검토 후 진행", enabled: true, scope: "human" },
      { id: "a5", label: "계약 최종 서명은 사람", desc: "서명 단계는 AI 자동화에서 제외", enabled: true, scope: "human" },
      { id: "a6", label: "야간(22:00–08:00) 자동 회신", desc: "야간에도 가이드 내 회신 자동 발송", enabled: false, scope: "ai" },
    ],
  },
];

export const SEED_TEMPLATES = [
  { id: "t1", title: "첫 컨택 — 캐주얼 게임", stage: "contact", channel: "이메일", aiManaged: true, usage: 128, vars: ["name", "game"], body: "안녕하세요 {{name}}님, Supercent의 신작 {{game}} 협업을 제안드립니다. 전용 영상 1편 기준으로 함께하고 싶어요. 관심 있으실까요?" },
  { id: "t2", title: "단가 협의 — 가이드 내 자동", stage: "negotiation", channel: "이메일", aiManaged: true, usage: 86, vars: ["price"], body: "제안 주신 단가는 내부 가이드 범위 내라 {{price}}로 확정 가능합니다. 진행 원하시면 표준 계약서를 보내드릴게요." },
  { id: "t3", title: "계약서 송부", stage: "contract", channel: "이메일", aiManaged: true, usage: 54, vars: ["name"], body: "{{name}}님, 표준 계약서 초안을 첨부드립니다. 내용 확인 후 회신 부탁드립니다. 수정 필요 사항 있으면 말씀 주세요." },
  { id: "t4", title: "검수 결과 — 수정 요청", stage: "review", channel: "DM", aiManaged: false, usage: 22, vars: ["point"], body: "영상 잘 받았습니다! {{point}} 부분만 수정해주시면 바로 게시 가능합니다 🙏" },
  { id: "t5", title: "마무리 감사", stage: "thanks", channel: "DM", aiManaged: false, usage: 71, vars: ["name"], body: "{{name}}님, 이번 협업 정말 감사했습니다. 다음에 또 좋은 기회로 함께해요 🙌" },
  {
    id: "t-infly-intake",
    title: "Infly 폼 제출 안내 — 고정",
    stage: "review",
    channel: "이메일",
    aiManaged: true,
    fixed: true,
    usage: 0,
    vars: ["name", "game", "formUrl", "deadline"],
    personalizationHints: {
      name: "Demo Studio Official",
      game: "XPHERO",
      formUrl: "https://example.com/forms/xphero-submit",
      deadline: "2026-06-30",
    },
    body: "{{name}}님, {{game}} 협업 창작물 제출은 아래 Infly 고정 폼으로 부탁드립니다.\n\n제출 폼: {{formUrl}}\n마감일: {{deadline}}\n\n영상 URL, 썸네일, 게시 예정일, 원본 파일 링크를 함께 입력해주시면 검수와 정산이 바로 이어집니다.",
  },
];

export const SEED_FEEDBACK: Array<Record<string, unknown>> = [
  { id: "f1", target: "email", model: "Qwen3-32B", excerpt: "가이드 내 단가 제안($2,000–2,400) 자동 회신", rating: "up", user: "데모운영자", time: "10:03" },
  { id: "f2", target: "chat", model: "Qwen3-32B", excerpt: "하이퍼캐주얼 숏폼 협업 제안(자동 컨택)", rating: "down", reason: "톤이 안 맞음", note: "첫 컨택치곤 너무 캐주얼 — 격식 ↑", user: "데모매니저", time: "09:20" },
  { id: "f3", target: "contract", model: "Qwen3-235B (MaaS)", excerpt: "독점 조항 14일 → 30일 수정본", rating: "down", reason: "사실/숫자 오류", note: "회사 표준 독점기간은 21일", user: "데모운영자", time: "어제" },
  { id: "f4", target: "email", model: "Gemma 3 27B", excerpt: "€1,500 상한 근접 — 회신 보류 안내", rating: "up", user: "데모리뷰어", time: "어제" },
  { id: "f5", target: "chat", model: "Qwen3-32B", excerpt: "$2,300 가이드 이내 확정 — 계약서 초안 준비", rating: "up", user: "데모운영자", time: "10:04" },
  { id: "f6", target: "email", model: "Solar Pro 3", excerpt: "검수 수정 요청 메시지", rating: "down", reason: "너무 김/장황", note: "3줄로 충분", user: "데모리뷰어", time: "2일 전" },
];

// IP/cost/callable/createdAt은 shared.ts BehaviorLog(9필드 감사 로그: userId·role·team·gameId·action·time·IP·result·cost)와
// index.ts persistCallableOutcome이 실제로 쓰는 키명(대문자 IP, cost, callable, createdAt)을
// assert-emulator-firestore.mjs assertRequiredFields(behavior_logs)가 그대로 요구하므로 병행 표기한다.
// 기존 소문자 ip/costKRW는 admin/logs 페이지 등 기존 소비자를 깨지 않도록 남겨둔다.
export const SEED_BEHAVIOR_LOGS: Array<Record<string, unknown>> = [
  { id: "l1", userId: "데모운영자", role: "manager", team: "AIX", gameId: "casual-01", action: "ai.auto_reply", time: "10:03", ip: "10.0.2.11", IP: "10.0.2.11", result: "success", costKRW: 18, cost: 18, callable: "processAutoReplyQueue", createdAt: "2026-06-27T10:03:00.000Z" },
  { id: "l2", userId: "Flu AI", role: "manager", team: "AIX", gameId: "casual-01", action: "contract.draft", time: "10:04", ip: "10.0.2.11", IP: "10.0.2.11", result: "success", costKRW: 240, cost: 240, callable: "negotiateContract", createdAt: "2026-06-27T10:04:00.000Z" },
  { id: "l3", userId: "데모매니저", role: "admin", team: "AIX", gameId: "midcore-02", action: "escalation.review", time: "09:40", ip: "10.0.2.20", IP: "10.0.2.20", result: "success", costKRW: 0, cost: 0, callable: "createEscalation", createdAt: "2026-06-27T09:40:00.000Z" },
  { id: "l4", userId: "신규 가입자", role: "guest", team: "—", gameId: "—", action: "inbox.open", time: "09:32", ip: "211.x.x.x", IP: "211.x.x.x", result: "denied", costKRW: 0, cost: 0, callable: "listConversations", createdAt: "2026-06-27T09:32:00.000Z" },
  { id: "l5", userId: "데모리뷰어", role: "manager", team: "Growth", gameId: "puzzle-03", action: "review.submit", time: "어제", ip: "10.0.3.7", IP: "10.0.3.7", result: "success", costKRW: 0, cost: 0, callable: "updateReviewStatus", createdAt: "2026-06-26T09:20:00.000Z" },
  { id: "l6", userId: "데모운영자", role: "manager", team: "AIX", gameId: "casual-01", action: "model.call(qwen3-32b)", time: "10:02", ip: "10.0.2.11", IP: "10.0.2.11", result: "success", costKRW: 12, cost: 12, callable: "gatewayProxy", createdAt: "2026-06-27T10:02:00.000Z" },
  { id: "l7", userId: "데모관리자", role: "super_admin", team: "AIX", gameId: "—", action: "rbac.update(u6→viewer)", time: "08:55", ip: "10.0.1.2", IP: "10.0.1.2", result: "success", costKRW: 0, cost: 0, callable: "setMemberRole", createdAt: "2026-06-27T08:55:00.000Z" },
];

export const SEED_RAW_RECORDS: Array<Record<string, unknown>> = [
  { id: "rr1", time: "06-19 10:03", type: "협의", creatorId: "c1", owner: "데모운영자", status: "ai_auto", amountKRW: 3000000, channel: "email", ref: "OUT-1042", aggregateKey: "2026-W25:협의:ai_auto", source: "firestore" },
  { id: "rr2", time: "06-19 10:04", type: "계약", creatorId: "c1", owner: "데모운영자", status: "ai_revised", amountKRW: 3000000, channel: "email", ref: "K-1042", aggregateKey: "2026-W25:계약:ai_revised", source: "firestore" },
  { id: "rr3", time: "06-19 09:41", type: "회신", creatorId: "c1", owner: "데모운영자", status: "received", channel: "email", ref: "IMAP-8841", aggregateKey: "2026-W25:회신:received", source: "firestore" },
  { id: "rr4", time: "06-19 09:20", type: "컨택", creatorId: "c3", owner: "데모매니저", status: "ai_sent", channel: "email", ref: "OUT-1041", aggregateKey: "2026-W25:컨택:ai_sent", source: "firestore" },
  { id: "rr5", time: "06-19 08:55", type: "협의", creatorId: "c5", owner: "데모매니저", status: "escalated", amountKRW: 14000000, channel: "email", ref: "OUT-1039", aggregateKey: "2026-W25:협의:escalated", source: "firestore" },
  { id: "rr6", time: "06-18 17:30", type: "계약", creatorId: "c2", owner: "데모운영자", status: "awaiting_sign", amountKRW: 8500000, channel: "docusign", ref: "K-1038", aggregateKey: "2026-W25:계약:awaiting_sign", source: "firestore" },
  { id: "rr7", time: "06-18 15:10", type: "검수", creatorId: "c4", owner: "데모운영자", status: "needs_review", channel: "form", ref: "SUB-771", aggregateKey: "2026-W25:검수:needs_review", source: "firestore", reviewStatus: "pending", reviewReasonCode: "missing_hashtag", paymentStatus: "not_payable", amountKRW: 1500000, currency: "KRW" },
  { id: "rr8", time: "06-18 14:02", type: "검수", creatorId: "c10", owner: "데모매니저", status: "approved", channel: "form", ref: "SUB-770", aggregateKey: "2026-W25:검수:approved", source: "firestore", reviewStatus: "pass", reviewReasonCode: "approved", paymentStatus: "paid", amountKRW: 6200000, currency: "KRW", paidAt: "06-18 14:30" },
  { id: "rr9", time: "06-18 11:20", type: "협의", creatorId: "c9", owner: "데모운영자", status: "near_cap", amountKRW: 2100000, channel: "email", ref: "OUT-1035", aggregateKey: "2026-W25:협의:near_cap", source: "firestore" },
  { id: "rr10", time: "06-17 18:40", type: "지급", creatorId: "c6", owner: "데모운영자", status: "paid", amountKRW: 2800000, channel: "wire", ref: "PAY-512", aggregateKey: "2026-W25:지급:paid", source: "firestore", paymentStatus: "paid", currency: "KRW", paidAt: "06-17 18:40" },
  { id: "rr11", time: "06-17 16:05", type: "계약", creatorId: "c6", owner: "데모운영자", status: "signed", amountKRW: 2800000, channel: "docusign", ref: "K-1031", aggregateKey: "2026-W25:계약:signed", source: "firestore" },
  { id: "rr12", time: "06-17 13:22", type: "컨택", creatorId: "c7", owner: "데모매니저", status: "ai_sent", channel: "email", ref: "OUT-1029", aggregateKey: "2026-W25:컨택:ai_sent", source: "firestore" },
  { id: "rr13", time: "06-16 19:48", type: "지급", creatorId: "c8", owner: "데모운영자", status: "payable", amountKRW: 6200000, channel: "wire", ref: "PAY-509", aggregateKey: "2026-W25:지급:payable", source: "firestore", paymentStatus: "payable", currency: "KRW" },
  { id: "rr14", time: "06-16 10:15", type: "검수", creatorId: "c6", owner: "데모운영자", status: "revise", channel: "form", ref: "SUB-765", aggregateKey: "2026-W25:검수:revise", source: "firestore", reviewStatus: "revise", reviewReasonCode: "missing_link", paymentStatus: "not_payable", amountKRW: 2800000, currency: "KRW" },
  { id: "rr15", time: "06-16 09:30", type: "회신", creatorId: "c9", owner: "데모운영자", status: "received", channel: "email", ref: "IMAP-8810", aggregateKey: "2026-W25:회신:received", source: "firestore" },
  { id: "rr16", time: "06-15 17:00", type: "지급", creatorId: "c4", owner: "데모매니저", status: "hold", amountKRW: 1500000, channel: "wire", ref: "PAY-505", aggregateKey: "2026-W25:지급:hold", source: "firestore", paymentStatus: "not_payable", currency: "KRW" },
];

export const SEED_REC_CANDIDATES: Array<Record<string, unknown>> = [
  { id: "rc-hesse", name: "Demo Studio Official", handle: "@demo_studio_official", avatar: "https://yt3.ggpht.com/gf0wAEnwry8iGHxxMSusiFzcqbcj8nzX3k7S8rQMv4BoNJgP7KN9yLu7K9bBMof_PfuuIoDY9A=s800-c-k-c0x00ffffff-no-rj", email: "demo.operator@example.com", platform: "YouTube", channelId: "UCDEMO00000000000000000", youtubeUrl: "https://www.youtube.com/@demo_studio_official", followers: 2800000, videoCount: 729, viewCount: 57769464, region: "KR", category: "Mobile Game/XPHERO", matchScore: 99, reasons: ["demo.operator@example.com 테스트 수신자", "@demo_studio_official 채널 매칭", "최근 XPHERO 콘텐츠 확인"], breakdown: { relevance: 99, similarity: 94, freshness: 98, contact: 100 } },
  { id: "rc1", name: "Minecraft", handle: "@minecraft", avatar: "https://yt3.ggpht.com/2gEQWk9ws0NNWIOva0M7NwU9LtIDHfNvY0nLGdhqNvDUn3Sk4kNsTZQZ_ILl70CQrjKSZjhqAP0=s800-c-k-c0x00ffffff-no-rj", platform: "YouTube", followers: 19600000, region: "SE", category: "Adventure/Action", matchScore: 95, reasons: ["기존 파트너와 유사 시청자층", "게임 카테고리 일치", "이메일 확보됨"], breakdown: { relevance: 95, similarity: 78, freshness: 70, contact: 100 } },
  { id: "rc2", name: "RoxiCake Gamer", handle: "@roxicakegamer", avatar: "https://yt3.ggpht.com/ytc/AIdro_ksHBi1JjROBQWfXc5rO-3LKs43R1SYntNgPmwxyPVstsc=s800-c-k-c0x00ffffff-no-rj", platform: "YouTube", followers: 16900000, region: "PE", category: "Action/Adventure", matchScore: 90, reasons: ["최근 뷰 급상승", "유사 채널 그래프 연결", "액션 게임 시청자층 적합"], breakdown: { relevance: 80, similarity: 79, freshness: 92, contact: 60 } },
  { id: "rc3", name: "Pixel Pop", handle: "@pixelpop", avatar: "🟪", platform: "YouTube", followers: 880000, region: "US", category: "Casual/Puzzle", matchScore: 82, reasons: ["캐주얼 신작 타깃 적합", "이메일 확보됨", "미드티어 효율 후보"], breakdown: { relevance: 88, similarity: 71, freshness: 65, contact: 100 } },
  { id: "rc4", name: "Mobile Arena", handle: "@mobilearena", avatar: "🎯", platform: "YouTube", followers: 1500000, region: "BR", category: "Hyper Casual", matchScore: 76, reasons: ["하이퍼캐주얼 전문", "신규 지역(BR) 확장", "성장세 양호"], breakdown: { relevance: 75, similarity: 66, freshness: 80, contact: 55 } },
  { id: "rc5", name: "Yua Games", handle: "@yuagames", avatar: "🌷", platform: "YouTube", followers: 210000, region: "JP", category: "Puzzle", matchScore: 71, reasons: ["퍼즐 카테고리 일치", "참여율 상위", "지역 포트폴리오 보완"], breakdown: { relevance: 72, similarity: 60, freshness: 70, contact: 70 } },
  { id: "rc6", name: "Casual Clips", handle: "@casualclips", avatar: "🎞️", platform: "YouTube", followers: 45000, region: "US", category: "UGC/Casual", matchScore: 67, reasons: ["UGC 크리에이터 — 높은 참여율", "숏폼 다작·저비용", "유사 파트너 반응 양호"], breakdown: { relevance: 68, similarity: 59, freshness: 85, contact: 50 } },
  { id: "rc7", name: "GameMoa", handle: "@gamemoa", avatar: "🕹️", platform: "YouTube", followers: 28000, region: "KR", category: "UGC/Mobile", matchScore: 65, reasons: ["국내 UGC", "최근 업로드 활발", "모바일 게임 소재 적합"], breakdown: { relevance: 66, similarity: 53, freshness: 88, contact: 65 } },
];

export const MVP_HESSE_CANDIDATE_ID = "rc-hesse";
export const MVP_HESSE_CONVERSATION_ID = "v-hesse";
export const MVP_HESSE_EMAIL = "demo.operator@example.com";
export const MVP_HESSE_YOUTUBE_HANDLE = "@demo_studio_official";
export const MVP_HESSE_YOUTUBE_URL = "https://www.youtube.com/@demo_studio_official";
export const MVP_HESSE_YOUTUBE_CHANNEL_ID = "UCDEMO00000000000000000";
export const MVP_HESSE_YOUTUBE_AVATAR = "https://yt3.ggpht.com/gf0wAEnwry8iGHxxMSusiFzcqbcj8nzX3k7S8rQMv4BoNJgP7KN9yLu7K9bBMof_PfuuIoDY9A=s800-c-k-c0x00ffffff-no-rj";
export const MVP_HESSE_REC_CANDIDATE = SEED_REC_CANDIDATES.find((doc) => doc.id === MVP_HESSE_CANDIDATE_ID) ?? {
  id: MVP_HESSE_CANDIDATE_ID,
  name: "Demo Studio Official",
  handle: MVP_HESSE_YOUTUBE_HANDLE,
  avatar: MVP_HESSE_YOUTUBE_AVATAR,
  email: MVP_HESSE_EMAIL,
  platform: "YouTube",
  channelId: MVP_HESSE_YOUTUBE_CHANNEL_ID,
  youtubeUrl: MVP_HESSE_YOUTUBE_URL,
  followers: 2800000,
  region: "KR",
  category: "Mobile Game/XPHERO",
  matchScore: 99,
  reasons: ["demo.operator@example.com 테스트 수신자", "@demo_studio_official 채널 매칭", "최근 XPHERO 콘텐츠 확인"],
  breakdown: { relevance: 99, similarity: 94, freshness: 98, contact: 100 },
};
export const MVP_HESSE_CONVERSATION = SEED_CONVERSATIONS.find((doc) => doc.id === MVP_HESSE_CONVERSATION_ID) ?? {
  id: MVP_HESSE_CONVERSATION_ID,
  creatorId: MVP_HESSE_CANDIDATE_ID,
  creatorName: "Demo Studio Official",
  creatorAvatar: MVP_HESSE_YOUTUBE_AVATAR,
  creatorEmail: MVP_HESSE_EMAIL,
  creatorHandle: MVP_HESSE_YOUTUBE_HANDLE,
  creatorPlatform: "YouTube",
  creatorFollowers: 2800000,
  unread: 0,
  aiActive: true,
  messages: [],
};
export const MVP_HESSE_MESSAGE_SOURCES = SEED_MESSAGE_SOURCES.filter((doc) => HESSE_MESSAGE_SOURCE_IDS.has(doc.id));
export const MVP_HESSE_CREATOR = {
  id: MVP_HESSE_CANDIDATE_ID,
  name: "Demo Studio Official",
  handle: MVP_HESSE_YOUTUBE_HANDLE,
  type: "influencer",
  avatar: MVP_HESSE_YOUTUBE_AVATAR,
  email: MVP_HESSE_EMAIL,
  platform: "YouTube",
  primaryPlatform: "YouTube",
  youtubeUrl: MVP_HESSE_YOUTUBE_URL,
  channelId: MVP_HESSE_YOUTUBE_CHANNEL_ID,
  profileMatchedEmail: MVP_HESSE_EMAIL,
  followers: 2800000,
  region: "KR",
  category: "Mobile Game/XPHERO",
  stage: "contact",
  owner: "데모운영자",
  budgetKRW: 0,
  guideStatus: "within",
  aiHandling: true,
  lastActivity: "2026-06-21",
  team: "flu",
};
export const MVP_HESSE_CHANNEL_STAT = {
  id: MVP_HESSE_CANDIDATE_ID,
  avgViews: 1926,
  recentViews: 9631,
  engagement: 3.1,
  longAvgViews: 1926,
  channelId: MVP_HESSE_YOUTUBE_CHANNEL_ID,
  channelRef: `youtube/${MVP_HESSE_YOUTUBE_CHANNEL_ID}`,
  subscriberCount: 2800000,
  videoCount: 729,
  viewCount: 57769464,
  metricSource: "youtube.data-api",
  syncedAt: "2026-06-23T00:00:00.000Z",
};
export const MVP_HESSE_YOUTUBE_SUBMISSIONS = [
  {
    id: "hs-CqeMrJuw0x4",
    creatorId: MVP_HESSE_CANDIDATE_ID,
    title: "When the camera stops rolling 🎬 | XPHERO",
    kind: "숏폼",
    thumb: "https://i.ytimg.com/vi/CqeMrJuw0x4/hqdefault.jpg",
    thumbnailUrl: "https://i.ytimg.com/vi/CqeMrJuw0x4/hqdefault.jpg",
    url: "https://www.youtube.com/watch?v=CqeMrJuw0x4",
    views: 639,
    likes: 11,
    comments: 1,
    status: "게시",
    date: "06-21",
    reviewStatus: "pass",
    reviewReasonCode: "approved",
    payableStatus: "not_payable",
    source: "youtube.data-api",
  },
  {
    id: "hs-UrwwBz1Jr3I",
    creatorId: MVP_HESSE_CANDIDATE_ID,
    title: "Boss Fight: Behind the Camera 😈 #XPHERO",
    kind: "숏폼",
    thumb: "https://i.ytimg.com/vi/UrwwBz1Jr3I/hqdefault.jpg",
    thumbnailUrl: "https://i.ytimg.com/vi/UrwwBz1Jr3I/hqdefault.jpg",
    url: "https://www.youtube.com/watch?v=UrwwBz1Jr3I",
    views: 4478,
    likes: 48,
    comments: 2,
    status: "게시",
    date: "06-21",
    reviewStatus: "pass",
    reviewReasonCode: "approved",
    payableStatus: "not_payable",
    source: "youtube.data-api",
  },
  {
    id: "hs-6rl3HiPmYPk",
    creatorId: MVP_HESSE_CANDIDATE_ID,
    title: "🗡️ ONE MUST FALL 🔥 | XPHERO",
    kind: "숏폼",
    thumb: "https://i.ytimg.com/vi/6rl3HiPmYPk/hqdefault.jpg",
    thumbnailUrl: "https://i.ytimg.com/vi/6rl3HiPmYPk/hqdefault.jpg",
    url: "https://www.youtube.com/watch?v=6rl3HiPmYPk",
    views: 752,
    likes: 17,
    comments: 4,
    status: "게시",
    date: "06-19",
    reviewStatus: "pass",
    reviewReasonCode: "approved",
    payableStatus: "not_payable",
    source: "youtube.data-api",
  },
];
export const MVP_HESSE_YOUTUBE_VIDEOS = [
  {
    videoId: "qX9H5BlAexw",
    creatorId: MVP_HESSE_CANDIDATE_ID,
    title: "Waiting 24 hours just for this...⏳ | XPHERO",
    channel: "Supercent",
    views: 91,
    likes: 2,
    comments: 0,
    published: "2026-06-23",
    thumb: "https://i.ytimg.com/vi/qX9H5BlAexw/hqdefault.jpg",
    tag: "자사",
  },
  {
    videoId: "CqeMrJuw0x4",
    creatorId: MVP_HESSE_CANDIDATE_ID,
    title: "When the camera stops rolling 🎬 | XPHERO",
    channel: "Supercent",
    views: 811,
    likes: 13,
    comments: 1,
    published: "2026-06-21",
    thumb: "https://i.ytimg.com/vi/CqeMrJuw0x4/hqdefault.jpg",
    tag: "자사",
  },
  {
    videoId: "6rl3HiPmYPk",
    creatorId: MVP_HESSE_CANDIDATE_ID,
    title: "🗡️ ONE MUST FALL 🔥 | XPHERO",
    channel: "Supercent",
    views: 814,
    likes: 17,
    comments: 4,
    published: "2026-06-19",
    thumb: "https://i.ytimg.com/vi/6rl3HiPmYPk/hqdefault.jpg",
    tag: "자사",
  },
  {
    videoId: "IOHVA2zdg5A",
    creatorId: MVP_HESSE_CANDIDATE_ID,
    title: "One-Sided Rivalry Begins! ⚔️ | XPHERO",
    channel: "Supercent",
    views: 1062,
    likes: 15,
    comments: 3,
    published: "2026-06-17",
    thumb: "https://i.ytimg.com/vi/IOHVA2zdg5A/hqdefault.jpg",
    tag: "자사",
  },
  {
    videoId: "1dfLUSNOSo8",
    creatorId: MVP_HESSE_CANDIDATE_ID,
    title: "My New Form Is Insane! ⚡  | XPHERO",
    channel: "Supercent",
    views: 1255,
    likes: 20,
    comments: 6,
    published: "2026-06-15",
    thumb: "https://i.ytimg.com/vi/1dfLUSNOSo8/hqdefault.jpg",
    tag: "자사",
  },
  {
    videoId: "0uHIyun8u1o",
    creatorId: MVP_HESSE_CANDIDATE_ID,
    title: "He Finally Became Strong… Right? 🤣 | XPHERO",
    channel: "Supercent",
    views: 1706,
    likes: 32,
    comments: 7,
    published: "2026-06-13",
    thumb: "https://i.ytimg.com/vi/0uHIyun8u1o/hqdefault.jpg",
    tag: "자사",
  },
];
export const MVP_HESSE_YOUTUBE_COMMENTS = [
  {
    id: "hs-cm-UgyHLnTq6UpEMGaG2rp4AaABAg",
    creatorId: MVP_HESSE_CANDIDATE_ID,
    videoId: "gpw5B2Q6GCE",
    author: "@Arceus-YT-XPhero",
    authorChannelId: "UCOceFbAGOH3wqL9nkylxzUw",
    text: "New chapter story ?",
    time: "2026-06-20 05:03",
    sentiment: "neutral",
    likeCount: 1,
    source: "youtube.data-api",
    url: "https://www.youtube.com/watch?v=gpw5B2Q6GCE&lc=UgyHLnTq6UpEMGaG2rp4AaABAg",
  },
  {
    id: "hs-cm-UgzsORW87Rn2TZHt2654AaABAg",
    creatorId: MVP_HESSE_CANDIDATE_ID,
    videoId: "gpw5B2Q6GCE",
    author: "@NakhorGouba",
    authorChannelId: "UCpWUj-FA-u4msJb9bKvfoSQ",
    text: "❤️",
    time: "2026-06-20 23:22",
    sentiment: "positive",
    likeCount: 0,
    source: "youtube.data-api",
    url: "https://www.youtube.com/watch?v=gpw5B2Q6GCE&lc=UgzsORW87Rn2TZHt2654AaABAg",
  },
  {
    id: "hs-cm-UgysAuoApTxuRFSiKSp4AaABAg",
    creatorId: MVP_HESSE_CANDIDATE_ID,
    videoId: "gpw5B2Q6GCE",
    author: "@KaiqueAugusto-j1v",
    authorChannelId: "UCBlWawI-YzK9e5dyMb-1bFg",
    text: "😂",
    time: "2026-06-21 23:05",
    sentiment: "positive",
    likeCount: 0,
    source: "youtube.data-api",
    url: "https://www.youtube.com/watch?v=gpw5B2Q6GCE&lc=UgysAuoApTxuRFSiKSp4AaABAg",
  },
  {
    id: "hs-cm-UgzKbSI4-UEa_wpAXCp4AaABAg",
    creatorId: MVP_HESSE_CANDIDATE_ID,
    videoId: "6rl3HiPmYPk",
    author: "@GL2OM_Officiel",
    authorChannelId: "UCMX_bpb72L_1AtQCYo0-__Q",
    text: "Best game for me ❤",
    time: "2026-06-20 12:01",
    sentiment: "positive",
    likeCount: 1,
    source: "youtube.data-api",
    url: "https://www.youtube.com/watch?v=6rl3HiPmYPk&lc=UgzKbSI4-UEa_wpAXCp4AaABAg",
  },
  {
    id: "hs-cm-UgwJuRifIvGmrti_M2Z4AaABAg",
    creatorId: MVP_HESSE_CANDIDATE_ID,
    videoId: "6rl3HiPmYPk",
    author: "@safetank2049",
    authorChannelId: "UCOxom71_Isbj0K1CpNnIqmQ",
    text: "My name in game is egyption",
    time: "2026-06-21 09:17",
    sentiment: "neutral",
    likeCount: 0,
    source: "youtube.data-api",
    url: "https://www.youtube.com/watch?v=6rl3HiPmYPk&lc=UgwJuRifIvGmrti_M2Z4AaABAg",
  },
];
export const MVP_HESSE_MEMBER = SEED_MEMBERS.find((doc) => doc.email === MVP_HESSE_EMAIL) ?? {
  id: "u1",
  name: "데모운영자",
  email: MVP_HESSE_EMAIL,
  avatar: "헤",
  role: "manager",
  team: "AIX",
  assigned: 6,
  status: "active",
  lastActive: "방금",
};
export const MVP_HESSE_INFLY_TEMPLATE = SEED_TEMPLATES.find((doc) => doc.id === "t-infly-intake") ?? {
  id: "t-infly-intake",
  title: "Infly 폼 제출 안내 — 고정",
  stage: "review",
  channel: "이메일",
  aiManaged: true,
  fixed: true,
  usage: 0,
  vars: ["name", "game", "formUrl", "deadline"],
  personalizationHints: {
    name: "Demo Studio Official",
    game: "XPHERO",
    formUrl: "https://example.com/forms/xphero-submit",
    deadline: "2026-06-30",
  },
  body: "{{name}}님, {{game}} 협업 창작물 제출은 아래 Infly 고정 폼으로 부탁드립니다.\n\n제출 폼: {{formUrl}}\n마감일: {{deadline}}\n\n영상 URL, 썸네일, 게시 예정일, 원본 파일 링크를 함께 입력해주시면 검수와 정산이 바로 이어집니다.",
};
export const MVP_PROGRAM = {
  id: "pg-xphero-creator-challenge",
  slug: "xphero-creator-challenge",
  title: "XPHERO 크리에이터 챌린지",
  status: "open",
  brief: "XPHERO 숏폼과 플레이 리뷰를 모집하고 승인된 신청자는 계약과 검수로 연결합니다.",
  gameTitle: "XPHERO",
  owner: "데모운영자",
  rewardKRW: 2300000,
  kpiMetric: "approved",
  kpiTarget: 20,
  tags: ["UGC", "YouTube", "KR"],
  applicationCount: 1,
  approvedCount: 0,
  contractCount: 0,
  reviewCount: 0,
  publicApplyPath: "/programs/xphero-creator-challenge/apply",
};
export const MVP_PROGRAM_APPLICATION = {
  id: "pg-xphero-creator-challenge-hesse-supercent-io",
  programId: MVP_PROGRAM.id,
  programSlug: MVP_PROGRAM.slug,
  programTitle: MVP_PROGRAM.title,
  status: "pending",
  creatorId: "rc-hesse",
  name: "Demo Studio Official",
  email: MVP_HESSE_EMAIL,
  handle: MVP_HESSE_YOUTUBE_HANDLE,
  youtubeUrl: MVP_HESSE_YOUTUBE_URL,
  platform: "YouTube",
  followers: 2800000,
  region: "KR",
  category: "Mobile Game/XPHERO",
  pitch: "MVP 프로그램 신청과 승인, 계약, 검수 흐름을 확인하는 고정 테스트 신청자입니다.",
  avatar: MVP_HESSE_YOUTUBE_AVATAR,
  submittedAtIso: "2026-06-23T15:00:00.000+09:00",
};
export const SEED_PROGRAMS = [MVP_PROGRAM];
export const SEED_PROGRAM_APPLICATIONS = [MVP_PROGRAM_APPLICATION];
export const MVP_HESSE_PERSISTENT_DOCS: Array<{ collection: string; id: string; data: Record<string, unknown> }> = [
  {
    collection: "members",
    id: "u1",
    data: { ...MVP_HESSE_MEMBER, protected: true, seedWrite: false, source: "mvp-live-test" },
  },
  {
    collection: "rec_candidates",
    id: MVP_HESSE_CANDIDATE_ID,
    data: { ...MVP_HESSE_REC_CANDIDATE, matchScore: 100, pinned: true, protected: true, seedWrite: false, source: "mvp-live-test" },
  },
  {
    collection: "creators",
    id: MVP_HESSE_CANDIDATE_ID,
    data: { ...MVP_HESSE_CREATOR, protected: true, seedWrite: false, source: "mvp-live-test" },
  },
  {
    collection: "conversations",
    id: MVP_HESSE_CONVERSATION_ID,
    data: { ...MVP_HESSE_CONVERSATION, protected: true, seedWrite: false, source: "mvp-live-test" },
  },
  {
    collection: "channel_stats",
    id: MVP_HESSE_CANDIDATE_ID,
    data: { ...MVP_HESSE_CHANNEL_STAT, protected: true, seedWrite: false, source: "mvp-live-test" },
  },
  {
    collection: "programs",
    id: MVP_PROGRAM.id,
    data: { ...MVP_PROGRAM, protected: true, seedWrite: false, source: "mvp-live-test" },
  },
  {
    collection: "program_applications",
    id: MVP_PROGRAM_APPLICATION.id,
    data: { ...MVP_PROGRAM_APPLICATION, protected: true, seedWrite: false, source: "mvp-live-test" },
  },
  ...MVP_HESSE_YOUTUBE_SUBMISSIONS.map((doc) => ({
    collection: "submissions",
    id: doc.id,
    data: { ...doc, protected: true, seedWrite: false, source: "mvp-live-test" },
  })),
  ...MVP_HESSE_YOUTUBE_VIDEOS.map((doc) => ({
    collection: "videos",
    id: doc.videoId,
    data: { ...doc, protected: true, seedWrite: false, source: "mvp-live-test" },
  })),
  ...MVP_HESSE_YOUTUBE_COMMENTS.map((doc) => ({
    collection: "creator_comments",
    id: doc.id,
    data: { ...doc, protected: true, seedWrite: false, source: "mvp-live-test" },
  })),
  {
    collection: "templates",
    id: "t-infly-intake",
    data: { ...MVP_HESSE_INFLY_TEMPLATE, protected: true, seedWrite: false, source: "mvp-live-test" },
  },
  {
    collection: "auto_reply",
    id: "default",
    data: { ...SEED_AUTO_REPLY[0], protected: true, seedWrite: false, source: "mvp-live-test" },
  },
  ...MVP_HESSE_MESSAGE_SOURCES.map((doc) => ({
    collection: "message_sources",
    id: doc.id,
    data: { ...doc, protected: true, seedWrite: false, source: "mvp-live-test" },
  })),
  {
    collection: "candidate_pool",
    id: MVP_HESSE_CANDIDATE_ID,
    data: { ...MVP_HESSE_REC_CANDIDATE, matchScore: 100, pinned: true, protected: true, source: "mvp-live-test" },
  },
];
export const MVP_HESSE_PROTECTED_DOC_KEYS = MVP_HESSE_PERSISTENT_DOCS.map((doc) => `${doc.collection}/${doc.id}`);

export const SEED_CREATOR_COMMENTS = [
  { id: "cm1", creatorId: "c1", author: "mbfan", text: "MrBeast가 하면 일단 깐다 ㅋㅋ", time: "2시간 전", sentiment: "positive" },
  { id: "cm2", creatorId: "c6", author: "viewer_99", text: "이 게임 진짜 중독성 있다", time: "5시간 전", sentiment: "positive" },
  { id: "cm3", creatorId: "c6", author: "Tom", text: "광고 너무 많은 거 아님?", time: "어제", sentiment: "negative" },
  { id: "cm4", creatorId: "c4", author: "puzzlefan", text: "Day 1 download!", time: "어제", sentiment: "positive" },
  { id: "cm5", creatorId: "c10", author: "GG_kim", text: "그래픽 미쳤다", time: "2일 전", sentiment: "positive" },
  { id: "cm6", creatorId: "c10", author: "neutral_n", text: "재밌긴 한데 과금 유도가 좀…", time: "2일 전", sentiment: "neutral" },
];

// seed 매니페스트 — UI 표·로그용 요약. 실제 write 건수와 일치시킨다.
export const SEED_MANIFEST = [
  { entity: "멤버 (members)", count: SEED_MEMBERS.length, meta: "role·team·status·email·last_login" },
  { entity: "인플루언서·파트너 (creators)", count: SEED_CREATORS.length, meta: "platform·followers·views·stage·owner·guideStatus" },
  { entity: "채널 지표 (channel_stats)", count: SEED_CHANNEL_STATS.length, meta: "avgViews·recentViews·engagement" },
  { entity: "에이전시 (agencies)", count: SEED_AGENCIES.length, meta: "region·owner·creatorIds" },
  { entity: "캠페인 (campaigns)", count: SEED_CAMPAIGNS.length, meta: "목표·발송·퍼널·priority·source" },
  { entity: "프로그램 (programs)", count: SEED_PROGRAMS.length, meta: "공개 신청·KPI·승인 퍼널" },
  { entity: "프로그램 신청 (program_applications)", count: SEED_PROGRAM_APPLICATIONS.length, meta: "신청자·승인상태·계약·검수 연결" },
  { entity: "계약 (contracts)", count: SEED_CONTRACTS.length, meta: "status·valueKRW·template·gate" },
  { entity: "검수 (reviews)", count: SEED_REVIEWS.length, meta: "checks·result·reviewer·payable" },
  { entity: "에스컬레이션 (escalations)", count: SEED_ESCALATIONS.length, meta: "reason·requestedKRW·overPct·round" },
  { entity: "제출물 (submissions)", count: SEED_SUBMISSIONS.length, meta: "views·likes·reviewStatus·payable" },
  { entity: "영상·콘텐츠 (videos)", count: SEED_VIDEOS.length, meta: "videoId·views·likes·tag·thumb" },
  { entity: "추천·후보 (candidate_pool)", count: SEED_CANDIDATE_POOL.length, meta: "matchScore·emailStatus·confidence" },
  { entity: "커뮤니티 (community_posts)", count: SEED_COMMUNITY_POSTS.length, meta: "source·subreddit·sentiment·score" },
  { entity: "LLM 사용량 (llm_usage)", count: SEED_LLM_USAGE.length, meta: "model·tier·calls·tokens·cost·share" },
  { entity: "메시지 템플릿 (templates)", count: SEED_TEMPLATES.length, meta: "stage·channel·aiManaged·usage·vars" },
  { entity: "대화 (conversations)", count: SEED_CONVERSATIONS.length, meta: "creatorId·unread·aiActive·messages[]" },
  { entity: "메일 전문 보관소 (message_sources)", count: SEED_MESSAGE_SOURCES.length, meta: "messageRef·subject·direction·body" },
  { entity: "AI 자동응답 설정 (auto_reply)", count: SEED_AUTO_REPLY.length, meta: "enabled·model·tone·rules[]" },
  { entity: "피드백 (feedback)", count: SEED_FEEDBACK.length, meta: "target·model·excerpt·rating·reason·note·user·time" },
  { entity: "행동 로그 (behavior_logs)", count: SEED_BEHAVIOR_LOGS.length, meta: "userId·role·team·gameId·action·time·ip·result·costKRW" },
  { entity: "원시 레코드 (raw_records)", count: SEED_RAW_RECORDS.length, meta: "type·creatorId·owner·status·amountKRW·channel·ref" },
  { entity: "추천 후보 (rec_candidates)", count: SEED_REC_CANDIDATES.length, meta: "matchScore·reasons·breakdown·platform·followers" },
  { entity: "크리에이터 댓글 (creator_comments)", count: SEED_CREATOR_COMMENTS.length, meta: "creatorId·author·text·time·sentiment" },
];

// 컬렉션명 → 시드 배열 매핑. createSeedData/deleteSeedData가 이 테이블을 순회한다.
export const SEED_COLLECTIONS: { collection: string; docs: Array<Record<string, unknown> & { id?: string; videoId?: string }>; idField: "id" | "videoId"; seedWrite?: boolean }[] = [
  { collection: "members", docs: SEED_MEMBERS, idField: "id" },
  { collection: "creators", docs: SEED_CREATORS, idField: "id" },
  { collection: "channel_stats", docs: SEED_CHANNEL_STATS, idField: "id" },
  { collection: "agencies", docs: SEED_AGENCIES, idField: "id" },
  { collection: "campaigns", docs: SEED_CAMPAIGNS, idField: "id" },
  { collection: "programs", docs: SEED_PROGRAMS, idField: "id" },
  { collection: "program_applications", docs: SEED_PROGRAM_APPLICATIONS, idField: "id" },
  { collection: "contracts", docs: SEED_CONTRACTS, idField: "id" },
  { collection: "reviews", docs: SEED_REVIEWS, idField: "id" },
  { collection: "escalations", docs: SEED_ESCALATIONS, idField: "id" },
  { collection: "submissions", docs: SEED_SUBMISSIONS, idField: "id" },
  { collection: "videos", docs: SEED_VIDEOS, idField: "videoId" },
  { collection: "candidate_pool", docs: SEED_CANDIDATE_POOL, idField: "id" },
  { collection: "community_posts", docs: SEED_COMMUNITY_POSTS, idField: "id" },
  { collection: "llm_usage", docs: SEED_LLM_USAGE, idField: "id" },
  { collection: "templates", docs: SEED_TEMPLATES, idField: "id" },
  { collection: "conversations", docs: SEED_CONVERSATIONS, idField: "id" },
  { collection: "message_sources", docs: SEED_MESSAGE_SOURCES, idField: "id" },
  { collection: "auto_reply", docs: SEED_AUTO_REPLY, idField: "id" },
  { collection: "feedback", docs: SEED_FEEDBACK, idField: "id" },
  { collection: "behavior_logs", docs: SEED_BEHAVIOR_LOGS, idField: "id" },
  { collection: "raw_records", docs: SEED_RAW_RECORDS, idField: "id" },
  { collection: "rec_candidates", docs: SEED_REC_CANDIDATES, idField: "id" },
  { collection: "creator_comments", docs: SEED_CREATOR_COMMENTS, idField: "id" },
];
