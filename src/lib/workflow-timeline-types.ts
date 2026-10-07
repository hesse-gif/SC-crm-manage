export const WORKFLOW_TIMELINE_STAGES = ["contact", "negotiation", "contract", "review", "live"] as const;

export type WorkflowTimelineStage = (typeof WORKFLOW_TIMELINE_STAGES)[number];

export type WorkflowTimelineStatus = "done" | "current" | "pending";

export type CreatorWorkflowRecordCounts = {
  readonly applications: number;
  readonly conversations: number;
  readonly contracts: number;
  readonly reviews: number;
};

export type WorkflowStageDuration = {
  readonly stage: WorkflowTimelineStage;
  readonly label: string;
  readonly status: WorkflowTimelineStatus;
  readonly dateLabel: string;
  readonly durationLabel: string;
};

export type CreatorWorkflowTimelineItem = {
  readonly id: string;
  readonly programId: string;
  readonly campaignId: string;
  readonly programLabel: string;
  readonly campaignLabel: string;
  readonly currentStage: WorkflowTimelineStage;
  readonly currentStageLabel: string;
  readonly updatedAtMs: number;
  readonly stageDurations: readonly WorkflowStageDuration[];
  readonly replyPredictionLabel: string;
  readonly records: CreatorWorkflowRecordCounts;
};

export type CreatorLike = {
  readonly id?: string;
  readonly creatorId?: string;
  readonly email?: string;
  readonly handle?: string;
  readonly name?: string;
  readonly channelId?: string;
  readonly youtubeUrl?: string;
  readonly stage?: WorkflowTimelineStage;
  readonly programId?: string;
};

export type ProgramLike = {
  readonly id: string;
  readonly title?: string;
  readonly name?: string;
  readonly gameTitle?: string;
};

export type CampaignLike = {
  readonly id: string;
  readonly programId?: string;
  readonly name?: string;
  readonly title?: string;
};

export type ProgramApplicationLike = {
  readonly id: string;
  readonly creatorId?: string;
  readonly email?: string;
  readonly handle?: string;
  readonly name?: string;
  readonly youtubeUrl?: string;
  readonly programId?: string;
  readonly programTitle?: string;
  readonly campaignId?: string;
  readonly campaignTitle?: string;
  readonly status?: string;
  readonly submittedAtIso?: string;
  readonly updatedAtIso?: string;
  readonly contractId?: string;
  readonly reviewId?: string;
  readonly participationActive?: boolean;
  readonly participationStatus?: string;
  readonly participationStage?: WorkflowTimelineStage;
  readonly participationUpdatedAtIso?: string;
};

export type ConversationMessageLike = {
  readonly from?: "ai" | "human" | "creator";
  readonly createdAtIso?: string;
};

export type ConversationLike = {
  readonly id: string;
  readonly creatorId?: string;
  readonly creatorEmail?: string;
  readonly creatorHandle?: string;
  readonly creatorName?: string;
  readonly programId?: string;
  readonly programTitle?: string;
  readonly campaignId?: string;
  readonly campaignTitle?: string;
  readonly lastMessageAtIso?: string;
  readonly lastMessageFrom?: "ai" | "human" | "creator";
  readonly updatedAtIso?: string;
  readonly messages?: readonly ConversationMessageLike[];
  readonly participationActive?: boolean;
  readonly participationStatus?: string;
  readonly participationStage?: WorkflowTimelineStage;
  readonly participationUpdatedAtIso?: string;
};

export type ContractLike = {
  readonly id: string;
  readonly creatorId?: string;
  readonly creatorName?: string;
  readonly programId?: string;
  readonly programTitle?: string;
  readonly campaignId?: string;
  readonly campaignTitle?: string;
  readonly status?: string;
  readonly updatedAtIso?: string;
  readonly participationActive?: boolean;
  readonly participationStatus?: string;
  readonly participationStage?: WorkflowTimelineStage;
  readonly participationUpdatedAtIso?: string;
};

export type ReviewLike = {
  readonly id: string;
  readonly creatorId?: string;
  readonly creatorName?: string;
  readonly programId?: string;
  readonly programTitle?: string;
  readonly campaignId?: string;
  readonly campaignTitle?: string;
  readonly status?: string;
  readonly updatedAtIso?: string;
  readonly transitionedAt?: string;
  readonly participationActive?: boolean;
  readonly participationStatus?: string;
  readonly participationStage?: WorkflowTimelineStage;
  readonly participationUpdatedAtIso?: string;
};

export type ContextAccumulator = {
  readonly id: string;
  programId: string;
  campaignId: string;
  programLabel: string;
  campaignLabel: string;
  currentStage: WorkflowTimelineStage;
  updatedAtMs: number;
  lastMessageFrom: "ai" | "human" | "creator" | "";
  lastMessageAtMs: number;
  readonly stageStarts: Map<WorkflowTimelineStage, number>;
  readonly records: { applications: number; conversations: number; contracts: number; reviews: number };
};

export type BuildCreatorWorkflowTimelineInput = {
  readonly creator: CreatorLike;
  readonly programs?: readonly ProgramLike[];
  readonly campaigns?: readonly CampaignLike[];
  readonly programApplications?: readonly ProgramApplicationLike[];
  readonly conversations?: readonly ConversationLike[];
  readonly contracts?: readonly ContractLike[];
  readonly reviews?: readonly ReviewLike[];
  readonly nowIso?: string;
};

export const WORKFLOW_TIMELINE_STAGE_LABELS: Record<WorkflowTimelineStage, string> = {
  contact: "컨택",
  negotiation: "협의",
  contract: "계약",
  review: "검수",
  live: "운영중",
};
