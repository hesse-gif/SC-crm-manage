// ── 대량 협업 캠페인 (수천~수만 건 집계) ──
import type { CountryTargeting } from "./programs";

export type Priority = "긴급" | "높음" | "보통";
export type CampaignTargetMetric = "partners" | "sent" | "replied" | "negotiating" | "contracted" | "live";
export type CampaignOperationalState = "active" | "paused" | "completed" | "cancelled";
export type CampaignMailBodyFormat = "markdown" | "text" | "html";
export const PRIORITY: Record<Priority, { label: string; tone: "danger" | "warn" | "neutral"; rank: number }> = {
  긴급: { label: "긴급", tone: "danger", rank: 3 },
  높음: { label: "높음", tone: "warn", rank: 2 },
  보통: { label: "보통", tone: "neutral", rank: 1 },
};
export interface Campaign {
  id: string;
  canonicalProgramId?: string;
  programId?: string;
  discoveryVertical?: "game" | "ai_drama" | string;
  name: string;
  createdAt?: string;
  createdAtIso?: string;
  updatedAtIso?: string;
  owner: string;
  source: "CSV" | "검색" | "추천";
  status: "대기" | "발송중" | "완료" | "예약" | "탐색중" | "일시정지" | "확인 필요";
  operationalState?: CampaignOperationalState;
  priority: Priority;
  targetMetric?: CampaignTargetMetric;
  targetValue?: number;
  campaignQuota?: number;
  controlVersion?: number;
  /** W100: 누적 라이브 발송 상한(도달 시 전량 차단). 파도별 배치 상한과 다른 축. */
  liveSendCap?: number;
  liveSendCapSource?: string;
  /** daily-cap-fairness: 캠페인별 KST 일일 발송 상한. 0/미설정 = 전역 캡만 적용. */
  dailyCap?: number;
  liveSendBatchCap?: number;
  total: number;
  queued?: number;
  targeting?: {
    requested?: number;
    queued?: number;
    emailReady?: number;
    emailRequiredSkipped?: number;
    limit?: number;
    truncated?: boolean;
    targetMetric?: CampaignTargetMetric;
    targetValue?: number;
    countryTargeting?: CountryTargeting;
    effectiveCountryTargeting?: CountryTargeting;
    excludedCountries?: string[];
    targetCountries?: string[];
    targetCountryMix?: { country: string; weight: number }[];
    includeKeywords?: string[];
    excludeKeywords?: string[];
  };
  coldMail?: {
    subject: string;
    body: string;
    bodyFormat?: CampaignMailBodyFormat;
    placeholders: string[];
    preview?: string;
    sourceCountry?: string;
    templateValues?: Record<string, string>;
    templateRevision?: string;
    trackingId?: string;
    draftRef?: string;
    updatedAtIso?: string;
  };
  countryTargeting?: CountryTargeting;
  effectiveCountryTargeting?: CountryTargeting;
  excludedCountries?: string[];
  targetCountries?: string[];
  targetCountryMix?: { country: string; weight: number }[];
  allowInflyOverlap?: boolean;
  includeKeywords?: string[];
  excludeKeywords?: string[];
  targetingCriteria?: {
    discoveryVertical?: "game" | "ai_drama" | string;
    countryTargeting?: CountryTargeting;
    effectiveCountryTargeting?: CountryTargeting;
    excludedCountries?: string[];
    targetCountries?: string[];
    targetCountryMix?: { country: string; weight: number }[];
    includeKeywords?: string[];
    excludeKeywords?: string[];
    categories?: string[];
    regions?: string[];
    minFollowers?: number;
    maxFollowers?: number;
    recentActivityDays?: number;
    minVideoViews?: number;
    minVideoCount?: number;
    allowInflyOverlap?: boolean;
  };
  senderName?: string;
  sendSchedule?: string;
  archivedAt?: string;
  deletedAt?: string;
  humanGate?: "auto_reply" | "needs_review" | "blocked" | "auto_close";
  manualIntervention?: {
    status: "open" | "resolved";
    reason?: string;
    requestedAt?: string;
    requestedBy?: string;
  };
  sent: number;
  replied: number;
  negotiating: number;
  contracted: number;
  live: number;
  bounced: number;
  /** 발송 제외/억제/중복가드/반송 누계(syncCampaignFunnel가 영속화). 폴더 "제외" 카운트. */
  dropped?: number;
  /** A3 캡 판정 카운터(functions/chat-ai.ts) — 폴더 합계보다 신뢰할 수 있는 canonical 총 발송. */
  liveSentCount?: number;
  /** liveSentCount 일회성 백필 완료 마커. 있을 때만 liveSentCount를 우선한다(campaign-live-sent.ts). */
  liveSentCountBackfilledAtIso?: string;
}
// AI가 priority rank 높은 순으로 먼저 작업. CAMPAIGNS는 우선순위 desc로 정렬해 노출.
export const CAMPAIGNS: Campaign[] = [
  { id: "cp1", programId: "pg-xphero-creator-challenge", name: "캐주얼 신작 글로벌 컨택", createdAtIso: "2026-06-15T00:00:00.000Z", owner: "헤세", source: "CSV", status: "발송중", priority: "긴급", total: 12480, sent: 11900, replied: 1830, negotiating: 420, contracted: 88, live: 36, bounced: 540 },
  { id: "cp3", name: "퍼즐 KR 마이크로", createdAtIso: "2026-06-18T00:00:00.000Z", owner: "헤세", source: "검색", status: "발송중", priority: "높음", total: 840, sent: 300, replied: 42, negotiating: 11, contracted: 2, live: 0, bounced: 8 },
  { id: "cp2", name: "하이퍼캐주얼 UGC 대량", createdAtIso: "2026-06-12T00:00:00.000Z", owner: "시몬", source: "CSV", status: "완료", priority: "보통", total: 5200, sent: 5200, replied: 910, negotiating: 160, contracted: 41, live: 22, bounced: 210 },
  { id: "cp4", name: "Mid-core 추천 배치", createdAtIso: "2026-06-10T00:00:00.000Z", owner: "제오", source: "추천", status: "완료", priority: "보통", total: 320, sent: 320, replied: 88, negotiating: 24, contracted: 9, live: 6, bounced: 5 },
];
export const campaignById = (id: string) => CAMPAIGNS.find((c) => c.id === id);

export type CampaignWorkflowStage = "candidate_search" | "outreach" | "negotiation" | "contract";

export interface CampaignWorkflowStep {
  stage: CampaignWorkflowStage;
  label: string;
  status: "대기" | "진행" | "완료";
  count: number;
}

export interface CampaignWorkflow {
  campaignId: string;
  targetN: number;
  currentStage: CampaignWorkflowStage;
  steps: CampaignWorkflowStep[];
  nextAction: string;
}

export interface CampaignFunnel {
  campaignId: string;
  targetN: number;
  candidateSearch: number;
  sent: number;
  replied: number;
  negotiating: number;
  contracted: number;
  rates: {
    sendRate: number;
    replyRate: number;
    negotiationRate: number;
    contractRate: number;
  };
}

export interface CampaignPriorityFeedback {
  id: string;
  campaignId: string;
  priority: Priority;
  reasonCode: "launch_urgent" | "high_roi" | "strategic_market" | "manual_override";
  feedbackRef: string;
  queuedFor: "feedback-kb";
}

export const CAMPAIGN_WORKFLOWS: CampaignWorkflow[] = CAMPAIGNS.map((campaign) => ({
  campaignId: campaign.id,
  targetN: Math.max(campaign.contracted, Math.ceil(campaign.total * 0.02)),
  currentStage: campaign.contracted > 0 ? "contract" : campaign.negotiating > 0 ? "negotiation" : campaign.sent > 0 ? "outreach" : "candidate_search",
  steps: [
    { stage: "candidate_search", label: "후보탐색", status: "완료", count: campaign.total },
    { stage: "outreach", label: "발송", status: campaign.sent >= campaign.total ? "완료" : "진행", count: campaign.sent },
    { stage: "negotiation", label: "협의", status: campaign.negotiating > 0 ? "진행" : "대기", count: campaign.negotiating },
    { stage: "contract", label: "계약", status: campaign.contracted > 0 ? "진행" : "대기", count: campaign.contracted },
  ],
  nextAction: campaign.contracted >= Math.ceil(campaign.total * 0.02) ? "목표 달성률 확인" : "목표 N까지 다음 배치 오케스트레이션",
}));

export const CAMPAIGN_FUNNELS: CampaignFunnel[] = CAMPAIGNS.map((campaign) => ({
  campaignId: campaign.id,
  targetN: Math.max(campaign.contracted, Math.ceil(campaign.total * 0.02)),
  candidateSearch: campaign.total,
  sent: campaign.sent,
  replied: campaign.replied,
  negotiating: campaign.negotiating,
  contracted: campaign.contracted,
  rates: {
    sendRate: campaign.total ? Math.round((campaign.sent / campaign.total) * 1000) / 10 : 0,
    replyRate: campaign.sent ? Math.round((campaign.replied / campaign.sent) * 1000) / 10 : 0,
    negotiationRate: campaign.replied ? Math.round((campaign.negotiating / campaign.replied) * 1000) / 10 : 0,
    contractRate: campaign.negotiating ? Math.round((campaign.contracted / campaign.negotiating) * 1000) / 10 : 0,
  },
}));

export const CAMPAIGN_PRIORITY_FEEDBACK: CampaignPriorityFeedback[] = [
  { id: "cpf1", campaignId: "cp1", priority: "긴급", reasonCode: "launch_urgent", feedbackRef: "feedback-kb/campaign-priority/cpf1", queuedFor: "feedback-kb" },
  { id: "cpf2", campaignId: "cp3", priority: "높음", reasonCode: "strategic_market", feedbackRef: "feedback-kb/campaign-priority/cpf2", queuedFor: "feedback-kb" },
];

export const campaignWorkflowById = (campaignId: string) => CAMPAIGN_WORKFLOWS.find((workflow) => workflow.campaignId === campaignId);
export const campaignFunnelById = (campaignId: string) => CAMPAIGN_FUNNELS.find((funnel) => funnel.campaignId === campaignId);
