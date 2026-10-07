import type { Sentiment } from "./community";
import type { PaymentStatus, ReviewReasonCode, ReviewStatus } from "./review";

// ── 콘텐츠 피드: 실제 영상(Infly videos) + 관계 태그 ──
// 영상 댓글 원문은 미수집(집계 수만) — commentThreads API + Functions 프록시 필요(검증 결과).
export type ContentTag = "자사" | "UGC" | "유료" | "커뮤니티";
export const CONTENT_TAG: Record<ContentTag, { label: string; tone: "accent" | "ai" | "ok" | "info" }> = {
  자사: { label: "자사 관련", tone: "accent" },
  UGC: { label: "UGC", tone: "ai" },
  유료: { label: "유료(광고)", tone: "ok" },
  커뮤니티: { label: "커뮤니티", tone: "info" },
};
export interface VideoItem {
  videoId: string;
  creatorId?: string;
  channelId?: string;
  youtubeUrl?: string;
  sourceUrl?: string;
  url?: string;
  source?: string;
  scpReviewPass?: boolean;
  scpReviewMeta?: {
    source?: string;
    submissionId?: string;
    submissionRef?: string;
    reviewStatus?: string;
    verdict?: string;
    reasons?: string[];
    reasonText?: string;
    feedbackText?: string;
    approver?: string;
    approvedAtIso?: string;
    payableStatus?: PaymentStatus | string;
    programId?: string;
    leadId?: string;
    creatorLinkRef?: string;
    campaign?: string;
    latestVideoReviewDecisionRef?: string;
  };
  title: string;
  channel: string;
  views: number;
  likes: number;
  comments: number;
  published: string;
  publishedAtIso?: string;
  publishedIso?: string;
  thumb: string;
  tag: ContentTag;
  archivedAt?: string;
  deletedAt?: string;
  humanGate?: "needs_review" | "resolved";
  manualIntervention?: {
    requestedAt?: string;
    requestedBy?: string;
    reason?: string;
    status?: "open" | "resolved";
  };
  // P3 1차 텍스트 분류 + P5 멀티모달 심층 분석 (엔진이 videos doc에 병합, feed read 레이어가 전달).
  classification?: {
    format: string;
    genreStyle: string;
    contentNature: string;
    confidence?: number;
    classificationSource?: string;
  };
  analysis?: {
    stageTransitions?: string[];
    sessionComposition?: Record<string, number>;
    editDensity?: number;
    coreLoopObservations?: string[];
    estimatedSessionMinutes?: number;
    sessionConfidence?: number;
  };
  language?: string; // en | ja | ko | other (엔진 META 패스)
  keywordTags?: string[]; // 핵심 태그 (엔진 META 패스)
  commentInsights?: { // 댓글 3축 인사이트 (엔진: videos.commentInsights)
    sentimentPct?: { positive: number; neutral: number; negative: number };
    categories?: Array<{ id: string; count: number }>;
    brandSafety?: { flagged?: boolean; flagRatio?: number; severeCount?: number };
    themes?: string[];
    summary?: string;
    sampleQuotes?: string[];
    analyzedCount?: number;
  };
  audioAccent?: { // 오디오 억양 게이트 (엔진: creatorLanguageGate.classifyCreatorVideoAccent → videos.audioAccent)
    spokenLanguage?: string; // en|ko|ja|hi|bn|... (실제 발화 언어)
    englishAccent?: string; // american|british|australian|canadian|indian|south_asian|...
    category?: "target" | "nonTarget" | "unclear" | "nospeech";
    confidence?: number;
    analyzedAtIso?: string;
  };
  adClassification?: { // 광고 분류 + 게임적합도 (C1 엔진: videoAdClassifier → videos.adClassification)
    isAd: boolean;
    adConfidence?: number;
    adSignals?: string[];
    gameFit: number;
    fitReasons?: string[];
    verdict: "good_ad_candidate" | "brand_deal_low_fit" | "organic_good_fit" | "not_relevant";
    classificationSource?: string;
    model?: string;
  };
}
export const VIDEOS: VideoItem[] = [
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
  { videoId: "qX9H5BlAexw", creatorId: "rc-hesse", title: "Waiting 24 hours just for this...⏳ | XPHERO", channel: "Supercent", views: 91, likes: 2, comments: 0, published: "2026-06-23", thumb: "https://i.ytimg.com/vi/qX9H5BlAexw/hqdefault.jpg", tag: "자사" },
  { videoId: "CqeMrJuw0x4", creatorId: "rc-hesse", title: "When the camera stops rolling 🎬 | XPHERO", channel: "Supercent", views: 811, likes: 13, comments: 1, published: "2026-06-21", thumb: "https://i.ytimg.com/vi/CqeMrJuw0x4/hqdefault.jpg", tag: "자사" },
  { videoId: "6rl3HiPmYPk", creatorId: "rc-hesse", title: "🗡️ ONE MUST FALL 🔥 | XPHERO", channel: "Supercent", views: 814, likes: 17, comments: 4, published: "2026-06-19", thumb: "https://i.ytimg.com/vi/6rl3HiPmYPk/hqdefault.jpg", tag: "자사" },
  { videoId: "IOHVA2zdg5A", creatorId: "rc-hesse", title: "One-Sided Rivalry Begins! ⚔️ | XPHERO", channel: "Supercent", views: 1062, likes: 15, comments: 3, published: "2026-06-17", thumb: "https://i.ytimg.com/vi/IOHVA2zdg5A/hqdefault.jpg", tag: "자사" },
  { videoId: "1dfLUSNOSo8", creatorId: "rc-hesse", title: "My New Form Is Insane! ⚡  | XPHERO", channel: "Supercent", views: 1255, likes: 20, comments: 6, published: "2026-06-15", thumb: "https://i.ytimg.com/vi/1dfLUSNOSo8/hqdefault.jpg", tag: "자사" },
  { videoId: "0uHIyun8u1o", creatorId: "rc-hesse", title: "He Finally Became Strong… Right? 🤣 | XPHERO", channel: "Supercent", views: 1706, likes: 32, comments: 7, published: "2026-06-13", thumb: "https://i.ytimg.com/vi/0uHIyun8u1o/hqdefault.jpg", tag: "자사" },
];

// ── 인플루언서 활동·창작물(제출물) ──
export interface Submission {
  id: string;
  creatorId: string;
  title: string;
  kind: "영상" | "숏폼" | "라이브";
  thumb: string;
  thumbnailUrl?: string;
  url?: string;
  source?: "manual" | "youtube.data-api" | "infly";
  views: number;
  likes: number;
  comments: number;
  status: "게시" | "검수중" | "수정요청";
  date: string;
  reviewStatus?: ReviewStatus;
  reviewReasonCode?: ReviewReasonCode;
  payableStatus?: PaymentStatus;
  payableAmountKRW?: number;
  paidAt?: string;
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
export const SUBMISSIONS: Submission[] = [
  { id: "s1", creatorId: "c1", title: "신작 콜라보 티저", kind: "숏폼", thumb: "🎮", views: 5400000, likes: 210000, comments: 8800, status: "게시", date: "06-12", reviewStatus: "pass", reviewReasonCode: "approved", payableStatus: "paid", payableAmountKRW: 3000000, paidAt: "06-19" },
  { id: "s2", creatorId: "c6", title: "신작 캐주얼 런 영상", kind: "영상", thumb: "▶️", views: 1200000, likes: 45000, comments: 2100, status: "게시", date: "06-15", reviewStatus: "pass", reviewReasonCode: "approved", payableStatus: "payable", payableAmountKRW: 2800000 },
  { id: "s3", creatorId: "c6", title: "운영 영상 #2", kind: "영상", thumb: "🎬", views: 880000, likes: 31000, comments: 1500, status: "수정요청", date: "06-16", reviewStatus: "revise", reviewReasonCode: "missing_link", payableStatus: "not_payable", payableAmountKRW: 2800000 },
  { id: "s4", creatorId: "c4", title: "퍼즐 리뷰", kind: "영상", thumb: "🧩", views: 540000, likes: 22000, comments: 980, status: "검수중", date: "06-18", reviewStatus: "pending", reviewReasonCode: "missing_hashtag", payableStatus: "not_payable", payableAmountKRW: 1500000 },
  { id: "s5", creatorId: "c10", title: "Mid-core 플레이", kind: "영상", thumb: "🕹️", views: 910000, likes: 38000, comments: 1700, status: "게시", date: "06-14", reviewStatus: "pass", reviewReasonCode: "approved", payableStatus: "paid", payableAmountKRW: 6200000, paidAt: "06-18" },
  { id: "s6", creatorId: "c10", title: "하이라이트 숏폼", kind: "숏폼", thumb: "⚡", views: 2300000, likes: 120000, comments: 3400, status: "게시", date: "06-17", reviewStatus: "pass", reviewReasonCode: "approved", payableStatus: "payable", payableAmountKRW: 1800000 },
  { id: "hs-CqeMrJuw0x4", creatorId: "rc-hesse", title: "When the camera stops rolling 🎬 | XPHERO", kind: "숏폼", thumb: "https://i.ytimg.com/vi/CqeMrJuw0x4/hqdefault.jpg", thumbnailUrl: "https://i.ytimg.com/vi/CqeMrJuw0x4/hqdefault.jpg", url: "https://www.youtube.com/watch?v=CqeMrJuw0x4", views: 639, likes: 11, comments: 1, status: "게시", date: "06-21", reviewStatus: "pass", reviewReasonCode: "approved", payableStatus: "not_payable", source: "youtube.data-api" },
  { id: "hs-UrwwBz1Jr3I", creatorId: "rc-hesse", title: "Boss Fight: Behind the Camera 😈 #XPHERO", kind: "숏폼", thumb: "https://i.ytimg.com/vi/UrwwBz1Jr3I/hqdefault.jpg", thumbnailUrl: "https://i.ytimg.com/vi/UrwwBz1Jr3I/hqdefault.jpg", url: "https://www.youtube.com/watch?v=UrwwBz1Jr3I", views: 4478, likes: 48, comments: 2, status: "게시", date: "06-21", reviewStatus: "pass", reviewReasonCode: "approved", payableStatus: "not_payable", source: "youtube.data-api" },
  { id: "hs-6rl3HiPmYPk", creatorId: "rc-hesse", title: "🗡️ ONE MUST FALL 🔥 | XPHERO", kind: "숏폼", thumb: "https://i.ytimg.com/vi/6rl3HiPmYPk/hqdefault.jpg", thumbnailUrl: "https://i.ytimg.com/vi/6rl3HiPmYPk/hqdefault.jpg", url: "https://www.youtube.com/watch?v=6rl3HiPmYPk", views: 752, likes: 17, comments: 4, status: "게시", date: "06-19", reviewStatus: "pass", reviewReasonCode: "approved", payableStatus: "not_payable", source: "youtube.data-api" },
];

// ── 창작물 댓글·반응 ──
export interface CreatorComment {
  id: string;
  creatorId: string;
  videoId?: string;
  authorChannelId?: string;
  author: string;
  text: string;
  time: string;
  sentiment: Sentiment;
  likeCount?: number;
  source?: "manual" | "youtube.data-api";
  url?: string;
}
export const CREATOR_COMMENTS: CreatorComment[] = [
  { id: "cm1", creatorId: "c1", author: "mbfan", text: "MrBeast가 하면 일단 깐다 ㅋㅋ", time: "2시간 전", sentiment: "positive" },
  { id: "cm2", creatorId: "c6", author: "viewer_99", text: "이 게임 진짜 중독성 있다", time: "5시간 전", sentiment: "positive" },
  { id: "cm3", creatorId: "c6", author: "Tom", text: "광고 너무 많은 거 아님?", time: "어제", sentiment: "negative" },
  { id: "cm4", creatorId: "c4", author: "puzzlefan", text: "Day 1 download!", time: "어제", sentiment: "positive" },
  { id: "cm5", creatorId: "c10", author: "GG_kim", text: "그래픽 미쳤다", time: "2일 전", sentiment: "positive" },
  { id: "cm6", creatorId: "c10", author: "neutral_n", text: "재밌긴 한데 과금 유도가 좀…", time: "2일 전", sentiment: "neutral" },
  { id: "hs-cm-UgyHLnTq6UpEMGaG2rp4AaABAg", creatorId: "rc-hesse", videoId: "gpw5B2Q6GCE", author: "@Arceus-YT-XPhero", authorChannelId: "UCOceFbAGOH3wqL9nkylxzUw", text: "New chapter story ?", time: "2026-06-20 05:03", sentiment: "neutral", likeCount: 1, source: "youtube.data-api", url: "https://www.youtube.com/watch?v=gpw5B2Q6GCE&lc=UgyHLnTq6UpEMGaG2rp4AaABAg" },
  { id: "hs-cm-UgzsORW87Rn2TZHt2654AaABAg", creatorId: "rc-hesse", videoId: "gpw5B2Q6GCE", author: "@NakhorGouba", authorChannelId: "UCpWUj-FA-u4msJb9bKvfoSQ", text: "❤️", time: "2026-06-20 23:22", sentiment: "positive", likeCount: 0, source: "youtube.data-api", url: "https://www.youtube.com/watch?v=gpw5B2Q6GCE&lc=UgzsORW87Rn2TZHt2654AaABAg" },
  { id: "hs-cm-UgysAuoApTxuRFSiKSp4AaABAg", creatorId: "rc-hesse", videoId: "gpw5B2Q6GCE", author: "@KaiqueAugusto-j1v", authorChannelId: "UCBlWawI-YzK9e5dyMb-1bFg", text: "😂", time: "2026-06-21 23:05", sentiment: "positive", likeCount: 0, source: "youtube.data-api", url: "https://www.youtube.com/watch?v=gpw5B2Q6GCE&lc=UgysAuoApTxuRFSiKSp4AaABAg" },
  { id: "hs-cm-UgzKbSI4-UEa_wpAXCp4AaABAg", creatorId: "rc-hesse", videoId: "6rl3HiPmYPk", author: "@GL2OM_Officiel", authorChannelId: "UCMX_bpb72L_1AtQCYo0-__Q", text: "Best game for me ❤", time: "2026-06-20 12:01", sentiment: "positive", likeCount: 1, source: "youtube.data-api", url: "https://www.youtube.com/watch?v=6rl3HiPmYPk&lc=UgzKbSI4-UEa_wpAXCp4AaABAg" },
  { id: "hs-cm-UgwJuRifIvGmrti_M2Z4AaABAg", creatorId: "rc-hesse", videoId: "6rl3HiPmYPk", author: "@safetank2049", authorChannelId: "UCOxom71_Isbj0K1CpNnIqmQ", text: "My name in game is egyption", time: "2026-06-21 09:17", sentiment: "neutral", likeCount: 0, source: "youtube.data-api", url: "https://www.youtube.com/watch?v=6rl3HiPmYPk&lc=UgwJuRifIvGmrti_M2Z4AaABAg" },
];
