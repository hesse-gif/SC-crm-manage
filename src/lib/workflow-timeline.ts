import { canonicalCreatorId } from "./creator-identity.ts";
import { isScpProgramId } from "./scp-program-alias.ts";
import {
  WORKFLOW_TIMELINE_STAGE_LABELS,
  WORKFLOW_TIMELINE_STAGES,
  type BuildCreatorWorkflowTimelineInput,
  type CampaignLike,
  type ContextAccumulator,
  type ContractLike,
  type ConversationLike,
  type CreatorLike,
  type CreatorWorkflowTimelineItem,
  type ProgramApplicationLike,
  type ProgramLike,
  type ReviewLike,
  type WorkflowStageDuration,
  type WorkflowTimelineStage,
} from "./workflow-timeline-types.ts";
import { SCP_LIFECYCLE_STATES, type ScpLifecycleState } from "./scp-lifecycle-states.ts";
import type { ResolvedScpLifecycleFlow } from "./scp-lifecycle-flow.ts";
import { SCP_LIFECYCLE_MACRO_PHASES, stateToMacro, type ScpLifecycleMacroId } from "./scp-lifecycle-macro.ts";

export type {
  BuildCreatorWorkflowTimelineInput,
  CreatorWorkflowTimelineItem,
  WorkflowTimelineStage,
  WorkflowTimelineStatus,
} from "./workflow-timeline-types.ts";

export type ScpLifecycleTimelineStatus = "done" | "current" | "pending";

export type ScpLifecycleTimelineDetail = {
  readonly state: ScpLifecycleState;
  readonly label: string;
  readonly status: ScpLifecycleTimelineStatus;
  readonly tone: ReturnType<ResolvedScpLifecycleFlow["toneFor"]>;
  readonly hidden: boolean;
  readonly gate: boolean;
  readonly terminal: boolean;
};

export type ScpLifecycleMacroTimelineItem = {
  readonly id: ScpLifecycleMacroId;
  readonly label: string;
  readonly description: string;
  readonly status: ScpLifecycleTimelineStatus;
  readonly current: boolean;
  readonly detailCount: number;
  readonly details: readonly ScpLifecycleTimelineDetail[];
};

const DAY_MS = 86_400_000;
type SubmissionLike = {
  readonly id?: string;
  readonly creatorId?: string;
  readonly email?: string;
  readonly creatorEmail?: string;
  readonly handle?: string;
  readonly creatorHandle?: string;
  readonly name?: string;
  readonly creatorName?: string;
  readonly channelId?: string;
  readonly youtubeUrl?: string;
  readonly status?: string;
  readonly reviewStatus?: string;
  readonly payableStatus?: string;
  readonly date?: string;
  readonly updatedAtIso?: string;
};

type CreatorWorkflowMacroStateInput = BuildCreatorWorkflowTimelineInput & {
  readonly submissions?: readonly SubmissionLike[];
};


function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function millis(value: unknown): number {
  const source = text(value);
  if (!source) return 0;
  const parsed = Date.parse(source);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordEmail(record: CreatorLike | ProgramApplicationLike | ConversationLike | ContractLike | ReviewLike | SubmissionLike): string | undefined {
  if ("email" in record) return record.email;
  if ("creatorEmail" in record) return record.creatorEmail;
  return undefined;
}

function recordHandle(record: CreatorLike | ProgramApplicationLike | ConversationLike | ContractLike | ReviewLike | SubmissionLike): string | undefined {
  if ("handle" in record) return record.handle;
  if ("creatorHandle" in record) return record.creatorHandle;
  return undefined;
}

function recordName(record: CreatorLike | ProgramApplicationLike | ConversationLike | ContractLike | ReviewLike | SubmissionLike): string | undefined {
  if ("name" in record) return record.name;
  if ("creatorName" in record) return record.creatorName;
  return undefined;
}

function sameCreator(record: CreatorLike | ProgramApplicationLike | ConversationLike | ContractLike | ReviewLike, canonicalId: string): boolean {
  return canonicalCreatorId({
    creatorId: record.creatorId,
    email: recordEmail(record),
    handle: recordHandle(record),
    name: recordName(record),
    channelId: "channelId" in record ? record.channelId : undefined,
    youtubeUrl: "youtubeUrl" in record ? record.youtubeUrl : undefined,
  }) === canonicalId;
}

function sameCreatorSignal(record: SubmissionLike | ProgramApplicationLike | ConversationLike | ContractLike | ReviewLike, canonicalId: string): boolean {
  return canonicalCreatorId({
    creatorId: record.creatorId,
    email: recordEmail(record),
    handle: recordHandle(record),
    name: recordName(record),
    channelId: "channelId" in record ? record.channelId : undefined,
    youtubeUrl: "youtubeUrl" in record ? record.youtubeUrl : undefined,
  }) === canonicalId;
}


function stageRank(stage: WorkflowTimelineStage): number {
  return WORKFLOW_TIMELINE_STAGES.indexOf(stage);
}

function laterStage(left: WorkflowTimelineStage, right: WorkflowTimelineStage): WorkflowTimelineStage {
  return stageRank(right) > stageRank(left) ? right : left;
}

function isRetractedParticipation(record: {
  participationActive?: boolean;
  participationStatus?: string;
  status?: string;
}): boolean {
  const status = text(record.status).toLowerCase();
  return record.participationStatus === "retracted"
    || ["retracted", "rejected", "failed", "withdrawn", "excluded"].includes(status);
}

function isInactiveArtifact(record: {
  participationActive?: boolean;
  participationStatus?: string;
  status?: string;
}): boolean {
  return record.participationActive === false || isRetractedParticipation(record);
}

function stateRank(state: ScpLifecycleState): number {
  return SCP_LIFECYCLE_STATES.indexOf(state);
}

function laterState(left: ScpLifecycleState, right: ScpLifecycleState): ScpLifecycleState {
  return stateRank(right) > stateRank(left) ? right : left;
}

function workflowStageToScpState(stage: WorkflowTimelineStage | undefined): ScpLifecycleState {
  switch (stage) {
    case "negotiation":
      return "reply_received";
    case "contract":
      return "onelink_sent";
    case "review":
      return "video_review_pending";
    case "live":
      return "live_tracking";
    case "contact":
    default:
      return "coldmail_sent";
  }
}

function submissionSignalState(submission: SubmissionLike): ScpLifecycleState {
  const reviewStatus = text(submission.reviewStatus).toLowerCase();
  const payableStatus = text(submission.payableStatus).toLowerCase();
  const status = text(submission.status).toLowerCase();
  if (payableStatus === "paid") return "live_tracking";
  if (reviewStatus === "pass" || reviewStatus === "approved" || status.includes("게시")) return "video_approved";
  if (reviewStatus === "pending" || reviewStatus === "revise" || status.includes("검수") || status.includes("수정")) return "video_review_pending";
  return "video_submitted";
}


function programLabel(programs: readonly ProgramLike[], programId: string, explicit?: string): string {
  const program = programs.find((item) => item.id === programId);
  return text(explicit) || text(program?.title) || text(program?.gameTitle) || text(program?.name) || "프로그램";
}

function campaignLabel(campaigns: readonly CampaignLike[], campaignId: string, explicit?: string): string {
  const campaign = campaigns.find((item) => item.id === campaignId);
  return text(explicit) || text(campaign?.name) || text(campaign?.title) || "캠페인";
}

function contextId(programId: string, campaignId: string): string {
  if (campaignId) return `campaign:${campaignId}`;
  if (programId) return `program:${programId}`;
  return "mail:direct";
}

function touchStage(context: ContextAccumulator, stage: WorkflowTimelineStage, atMs: number): void {
  context.currentStage = laterStage(context.currentStage, stage);
  if (atMs <= 0) return;
  const previous = context.stageStarts.get(stage) ?? 0;
  if (previous === 0 || atMs < previous) context.stageStarts.set(stage, atMs);
  if (atMs > context.updatedAtMs) context.updatedAtMs = atMs;
}

function durationLabel(startMs: number, endMs: number): string {
  if (startMs <= 0 || endMs <= 0 || endMs < startMs) return "기간 데이터 부족";
  const days = Math.max(1, Math.ceil((endMs - startMs) / DAY_MS));
  return `${days}일`;
}

function dateLabel(valueMs: number): string {
  if (valueMs <= 0) return "날짜 없음";
  return new Date(valueMs).toISOString().slice(5, 10);
}

function replyPrediction(lastFrom: ContextAccumulator["lastMessageFrom"], lastAtMs: number, nowMs: number): string {
  if (lastAtMs <= 0) return "예측 데이터 부족";
  if (lastFrom === "creator") return "회신 도착";
  const elapsedDays = Math.max(0, Math.floor((nowMs - lastAtMs) / DAY_MS));
  const expectedDays = 3;
  if (elapsedDays > expectedDays) return `예상 초과 D+${elapsedDays}`;
  return `메일 예상 D+${expectedDays}`;
}

function stageDurations(context: ContextAccumulator, nowMs: number): WorkflowStageDuration[] {
  const currentRank = stageRank(context.currentStage);
  return WORKFLOW_TIMELINE_STAGES.map((stage, index) => {
    const startMs = context.stageStarts.get(stage) ?? 0;
    const nextStage = WORKFLOW_TIMELINE_STAGES.slice(index + 1).find((candidate) => (context.stageStarts.get(candidate) ?? 0) > 0);
    const endMs = nextStage ? context.stageStarts.get(nextStage) ?? 0 : nowMs;
    return {
      stage,
      label: WORKFLOW_TIMELINE_STAGE_LABELS[stage],
      status: index < currentRank ? "done" : index === currentRank ? "current" : "pending",
      dateLabel: dateLabel(startMs),
      durationLabel: index <= currentRank ? durationLabel(startMs, endMs) : "대기",
    };
  });
}

export function buildCreatorWorkflowTimeline(input: BuildCreatorWorkflowTimelineInput): CreatorWorkflowTimelineItem[] {
  const canonicalId = canonicalCreatorId(input.creator);
  if (!canonicalId) return [];

  const programs = input.programs ?? [];
  const campaigns = input.campaigns ?? [];
  const nowMs = millis(input.nowIso) || Date.now();
  const contexts = new Map<string, ContextAccumulator>();
  const appsByContractId = new Map<string, ProgramApplicationLike>();
  const appsByReviewId = new Map<string, ProgramApplicationLike>();

  const ensureContext = (programId: string, campaignId: string, programTitle?: string, campaignTitle?: string): ContextAccumulator => {
    const id = contextId(programId, campaignId);
    const existing = contexts.get(id);
    if (existing) return existing;
    const context: ContextAccumulator = {
      id,
      programId,
      campaignId,
      programLabel: programId ? programLabel(programs, programId, programTitle) : "직접 메일",
      campaignLabel: campaignId ? campaignLabel(campaigns, campaignId, campaignTitle) : "",
      currentStage: ((!programId && !campaignId) || isScpProgramId(programId))
        ? input.creator.stage ?? "contact"
        : "contact",
      updatedAtMs: 0,
      lastMessageFrom: "",
      lastMessageAtMs: 0,
      stageStarts: new Map(),
      records: { applications: 0, conversations: 0, contracts: 0, reviews: 0 },
    };
    contexts.set(id, context);
    return context;
  };

  for (const application of input.programApplications ?? []) {
    if (!sameCreator(application, canonicalId) || isRetractedParticipation(application)) continue;
    if (application.contractId) appsByContractId.set(application.contractId, application);
    if (application.reviewId) appsByReviewId.set(application.reviewId, application);
    const context = ensureContext(text(application.programId), text(application.campaignId), application.programTitle, application.campaignTitle);
    context.records.applications += 1;
    touchStage(
      context,
      application.participationStage ?? (application.status === "approved" ? "contract" : "contact"),
      millis(application.participationUpdatedAtIso) || millis(application.submittedAtIso) || millis(application.updatedAtIso),
    );
  }

  for (const conversation of input.conversations ?? []) {
    if (!sameCreator(conversation, canonicalId) || isInactiveArtifact(conversation)) continue;
    const context = ensureContext(text(conversation.programId), text(conversation.campaignId), conversation.programTitle, conversation.campaignTitle);
    context.records.conversations += 1;
    const creatorReply = conversation.messages?.find((message) => message.from === "creator");
    touchStage(
      context,
      conversation.participationStage ?? (creatorReply ? "negotiation" : "contact"),
      millis(conversation.participationUpdatedAtIso) || millis(creatorReply?.createdAtIso) || millis(conversation.lastMessageAtIso) || millis(conversation.updatedAtIso),
    );
    const lastAtMs = millis(conversation.lastMessageAtIso) || millis(conversation.updatedAtIso);
    if (lastAtMs > context.lastMessageAtMs) {
      context.lastMessageAtMs = lastAtMs;
      context.lastMessageFrom = conversation.lastMessageFrom ?? "";
    }
  }

  for (const contract of input.contracts ?? []) {
    if (!sameCreator(contract, canonicalId) || isInactiveArtifact(contract)) continue;
    const linkedApplication = appsByContractId.get(contract.id);
    const context = ensureContext(
      text(contract.programId) || text(linkedApplication?.programId),
      text(contract.campaignId) || text(linkedApplication?.campaignId),
      contract.programTitle || linkedApplication?.programTitle,
      contract.campaignTitle || linkedApplication?.campaignTitle,
    );
    context.records.contracts += 1;
    touchStage(context, contract.participationStage ?? "contract", millis(contract.participationUpdatedAtIso) || millis(contract.updatedAtIso));
  }

  for (const review of input.reviews ?? []) {
    if (!sameCreator(review, canonicalId) || isInactiveArtifact(review)) continue;
    const linkedApplication = appsByReviewId.get(review.id);
    const context = ensureContext(
      text(review.programId) || text(linkedApplication?.programId),
      text(review.campaignId) || text(linkedApplication?.campaignId),
      review.programTitle || linkedApplication?.programTitle,
      review.campaignTitle || linkedApplication?.campaignTitle,
    );
    context.records.reviews += 1;
    touchStage(
      context,
      review.participationStage ?? (review.status === "pass" ? "live" : "review"),
      millis(review.participationUpdatedAtIso) || millis(review.updatedAtIso) || millis(review.transitionedAt),
    );
  }

  return [...contexts.values()]
    .map((context) => ({
      id: context.id,
      programId: context.programId,
      campaignId: context.campaignId,
      programLabel: context.programLabel,
      campaignLabel: context.campaignLabel,
      currentStage: context.currentStage,
      currentStageLabel: WORKFLOW_TIMELINE_STAGE_LABELS[context.currentStage],
      updatedAtMs: context.updatedAtMs,
      stageDurations: stageDurations(context, nowMs),
      replyPredictionLabel: replyPrediction(context.lastMessageFrom, context.lastMessageAtMs, nowMs),
      records: context.records,
    }))
    .sort((left, right) => stageRank(right.currentStage) - stageRank(left.currentStage) || right.updatedAtMs - left.updatedAtMs);
}

export function resolveCreatorWorkflowMacroState(input: CreatorWorkflowMacroStateInput): ScpLifecycleState {
  const canonicalId = canonicalCreatorId(input.creator);
  let currentState = workflowStageToScpState(isScpProgramId(input.creator.programId) ? input.creator.stage : undefined);

  if (!canonicalId) return currentState;

  for (const item of buildCreatorWorkflowTimeline(input)) {
    currentState = laterState(currentState, workflowStageToScpState(item.currentStage));
  }

  for (const conversation of input.conversations ?? []) {
    if (!sameCreatorSignal(conversation, canonicalId) || isInactiveArtifact(conversation)) continue;
    const creatorReply = conversation.messages?.some((message) => message.from === "creator") || conversation.lastMessageFrom === "creator";
    currentState = laterState(currentState, creatorReply ? "reply_received" : "coldmail_sent");
  }

  for (const application of input.programApplications ?? []) {
    if (!sameCreatorSignal(application, canonicalId) || isRetractedParticipation(application)) continue;
    currentState = laterState(currentState, application.status === "approved" ? "qualification_passed" : "form_submitted");
  }

  for (const contract of input.contracts ?? []) {
    if (!sameCreatorSignal(contract, canonicalId) || isInactiveArtifact(contract)) continue;
    currentState = laterState(currentState, "onelink_sent");
  }

  for (const review of input.reviews ?? []) {
    if (!sameCreatorSignal(review, canonicalId) || isInactiveArtifact(review)) continue;
    currentState = laterState(currentState, review.status === "pass" ? "live_tracking" : "video_review_pending");
  }

  for (const submission of input.submissions ?? []) {
    if (!sameCreatorSignal(submission, canonicalId)) continue;
    currentState = laterState(currentState, submissionSignalState(submission));
  }

  return currentState;
}

export function buildScpLifecycleMacroTimeline(input: {
  readonly currentState: ScpLifecycleState;
  readonly flow: ResolvedScpLifecycleFlow;
}): ScpLifecycleMacroTimelineItem[] {
  const currentMacro = stateToMacro(input.currentState);
  const currentMacroIndex = SCP_LIFECYCLE_MACRO_PHASES.findIndex((phase) => phase.id === currentMacro?.id);
  const currentStateIndex = SCP_LIFECYCLE_STATES.indexOf(input.currentState);

  return SCP_LIFECYCLE_MACRO_PHASES.map((phase, phaseIndex) => {
    const status: ScpLifecycleTimelineStatus = phaseIndex < currentMacroIndex ? "done" : phaseIndex === currentMacroIndex ? "current" : "pending";
    return {
      id: phase.id,
      label: phase.label,
      description: phase.description,
      status,
      current: phase.id === currentMacro?.id,
      detailCount: phase.stateIds.length,
      details: phase.stateIds.map((state) => {
        const stateIndex = SCP_LIFECYCLE_STATES.indexOf(state);
        const detailStatus: ScpLifecycleTimelineStatus = stateIndex < currentStateIndex ? "done" : stateIndex === currentStateIndex ? "current" : "pending";
        return {
          state,
          label: input.flow.labelFor(state, "detail"),
          status: detailStatus,
          tone: input.flow.toneFor(state),
          hidden: input.flow.hiddenStates.has(state),
          gate: input.flow.gateStates.has(state),
          terminal: input.flow.terminalStates.has(state),
        };
      }),
    };
  });
}
