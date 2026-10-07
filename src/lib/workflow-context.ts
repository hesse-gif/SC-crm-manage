import { canonicalCreatorId, canonicalWorkflowContextKey } from "./creator-identity.ts";
import { isScpProgramId } from "./scp-program-alias.ts";

export type WorkflowContextKind = "program" | "campaign" | "mail" | "direct";

export type WorkflowContextTag = {
  key: string;
  kind: WorkflowContextKind;
  label: string;
  href?: string;
};

type ConversationLike = {
  id?: string;
  threadId?: string;
  contextKey?: string;
  type?: string;
  source?: string;
  originalCreatorId?: string;
  creatorId?: string;
  creatorEmail?: string;
  creatorHandle?: string;
  creatorName?: string;
  channelId?: string;
  youtubeUrl?: string;
  programId?: string;
  programTitle?: string;
  campaignId?: string;
  campaignTitle?: string;
  protected?: boolean;
  participationActive?: boolean;
  participationStatus?: string;
  status?: string;
};

type CreatorLike = {
  id?: string;
  email?: string;
  handle?: string;
  name?: string;
  channelId?: string;
  youtubeUrl?: string;
  programId?: string;
  programTitle?: string;
  campaignId?: string;
  campaignTitle?: string;
};

type ProgramLike = {
  id: string;
  slug?: string;
  name?: string;
  title?: string;
  gameTitle?: string;
};

type CampaignLike = {
  id: string;
  programId?: string;
  name?: string;
  title?: string;
};

type ProgramApplicationLike = {
  id: string;
  programId?: string;
  programTitle?: string;
  creatorId?: string;
  email?: string;
  handle?: string;
  name?: string;
  youtubeUrl?: string;
  status?: string;
  participationActive?: boolean;
  participationStatus?: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function programById(programs: readonly ProgramLike[], id?: string): ProgramLike | undefined {
  return programs.find((program) => program.id === id);
}

function campaignById(campaigns: readonly CampaignLike[], id?: string): CampaignLike | undefined {
  return campaigns.find((campaign) => campaign.id === id);
}

function programLabel(programId: string, explicitTitle: unknown, program?: ProgramLike): string {
  return text(explicitTitle) || text(program?.title) || text(program?.gameTitle) || text(program?.name) || "프로그램";
}

function campaignLabel(campaignId: string, explicitTitle: unknown, campaign?: CampaignLike): string {
  return text(explicitTitle) || text(campaign?.name) || text(campaign?.title) || "캠페인";
}

function campaignHref(programId?: string): string {
  const id = text(programId);
  return id ? `/flu/campaigns?programId=${encodeURIComponent(id)}` : "/flu/campaigns";
}

function uniqueTags(tags: readonly WorkflowContextTag[]): WorkflowContextTag[] {
  const seen = new Set<string>();
  const result: WorkflowContextTag[] = [];
  for (const tag of tags) {
    if (!tag.key || seen.has(tag.key)) continue;
    seen.add(tag.key);
    result.push(tag);
  }
  return result;
}

function readableTags(tags: readonly WorkflowContextTag[]): WorkflowContextTag[] {
  const unique = uniqueTags(tags);
  const genericCounts = new Map<string, number>();
  for (const tag of unique) {
    if (tag.label === "프로그램" || tag.label === "캠페인") {
      genericCounts.set(tag.label, (genericCounts.get(tag.label) ?? 0) + 1);
    }
  }

  const genericIndexes = new Map<string, number>();
  return unique.map((tag) => {
    if ((genericCounts.get(tag.label) ?? 0) <= 1) return tag;
    const next = (genericIndexes.get(tag.label) ?? 0) + 1;
    genericIndexes.set(tag.label, next);
    return { ...tag, label: `${tag.label} ${next}` };
  });
}

export function workflowContextKey(conversation: ConversationLike): string {
  return canonicalWorkflowContextKey({
    id: conversation.id,
    conversationId: conversation.id,
    threadId: conversation.threadId,
    contextKey: conversation.contextKey,
    type: conversation.type,
    source: conversation.source,
    creatorId: conversation.creatorId,
    creatorEmail: conversation.creatorEmail,
    creatorHandle: conversation.creatorHandle,
    creatorName: conversation.creatorName,
    channelId: conversation.channelId,
    youtubeUrl: conversation.youtubeUrl,
    programId: conversation.programId,
    campaignId: conversation.campaignId,
  });
}

export function workflowConversationKey(conversation: ConversationLike): string {
  return `${conversation.threadId || conversation.id || "conversation"}::${workflowContextKey(conversation)}`;
}

const SYNTHETIC_CONVERSATION_ALIAS_RE = /^(thread|program|campaign)-/;

export function primaryConversationId(conversation: ConversationLike & { threadConversationIds?: string[] }): string {
  // 서버(sendEmail 등)는 실제 conversations 문서 id 만 받는다. conversation.id 는 로드된 실제 대화(병합 그룹이면 대표 멤버)의 id 이므로
  //   항상 우선한다 — id === threadId 인 직접 메일(conv_*, mail-*)도 그대로 반환. threadConversationIds 에는
  //   conversationThreadCandidates 가 만든 합성 별칭(thread-*, program-*, campaign-*)이 섞여 있어 id 가 비었을 때도 별칭은 고르지 않는다.
  if (conversation.id) return conversation.id;
  return conversation.threadConversationIds?.find((id) => id && id !== conversation.threadId && !SYNTHETIC_CONVERSATION_ALIAS_RE.test(id)) || conversation.threadId || "";
}

export function workflowContextTagsForConversation(
  conversation: ConversationLike,
  context: {
    programs?: readonly ProgramLike[];
    campaigns?: readonly CampaignLike[];
  } = {},
): WorkflowContextTag[] {
  const tags: WorkflowContextTag[] = [];
  const programs = context.programs ?? [];
  const campaigns = context.campaigns ?? [];
  const campaign = campaignById(campaigns, conversation.campaignId);
  const programId = text(conversation.programId) || text(campaign?.programId);
  const program = programById(programs, programId);

  if (programId) {
    tags.push({
      key: `program:${programId}`,
      kind: "program",
      label: programLabel(programId, conversation.programTitle, program),
      href: `/flu/programs?programId=${encodeURIComponent(programId)}`,
    });
  }
  if (conversation.campaignId) {
    tags.push({
      key: `campaign:${conversation.campaignId}`,
      kind: "campaign",
      label: campaignLabel(conversation.campaignId, conversation.campaignTitle, campaign),
      href: campaignHref(programId),
    });
  }
  if (tags.length > 0) return readableTags(tags);

  if (conversation.source === "mvp-live-test" || conversation.protected) {
    return [{ key: "mail:sandbox", kind: "mail", label: "테스트 메일" }];
  }
  return [{ key: "mail:direct", kind: "direct", label: "메일 thread" }];
}

function sameCreator(left: CreatorLike | ProgramApplicationLike | ConversationLike, rightCanonicalId: string): boolean {
  const record = left as CreatorLike & ProgramApplicationLike & ConversationLike;
  return canonicalCreatorId({
    creatorId: record.creatorId ?? record.id,
    email: record.email ?? record.creatorEmail,
    handle: record.handle ?? record.creatorHandle,
    name: record.name ?? record.creatorName,
    channelId: record.channelId,
    youtubeUrl: record.youtubeUrl,
  }) === rightCanonicalId;
}

function recordToken(value: unknown): string {
  return text(value)
    .toLowerCase()
    .replace(/^mailto:/, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

function samePipelineRecord(left: ProgramApplicationLike | ConversationLike, creator: CreatorLike): boolean {
  const creatorRecordId = recordToken(creator.id);
  if (!creatorRecordId) return false;
  const record = left as ProgramApplicationLike & ConversationLike;
  const primaryRecordId = recordToken(record.originalCreatorId);
  if (primaryRecordId) return primaryRecordId === creatorRecordId;
  return [record.creatorId, record.id].map(recordToken).some((token) => token === creatorRecordId);
}

function isRetractedParticipation(record: ProgramApplicationLike | ConversationLike): boolean {
  const status = text(record.status).toLowerCase();
  return record.participationStatus === "retracted"
    || ["rejected", "failed", "withdrawn", "excluded"].includes(status);
}

function isInactiveConversation(record: ConversationLike): boolean {
  return record.participationActive === false || isRetractedParticipation(record);
}

export function workflowContextTagsForCreator(
  creator: CreatorLike,
  context: {
    programApplications?: readonly ProgramApplicationLike[];
    programs?: readonly ProgramLike[];
    campaigns?: readonly CampaignLike[];
    conversations?: readonly ConversationLike[];
    limit?: number;
  } = {},
): WorkflowContextTag[] {
  const canonicalId = canonicalCreatorId({
    creatorId: creator.id,
    email: creator.email,
    handle: creator.handle,
    name: creator.name,
    channelId: creator.channelId,
    youtubeUrl: creator.youtubeUrl,
  });
  if (!canonicalId) return [];

	  const programs = context.programs ?? [];
  const campaigns = context.campaigns ?? [];
  const tags: WorkflowContextTag[] = [];

  for (const application of context.programApplications ?? []) {
    if (!sameCreator(application, canonicalId) || !application.programId || isRetractedParticipation(application)) continue;
    tags.push({
      key: `program:${application.programId}`,
      kind: "program",
      label: programLabel(application.programId, application.programTitle, programById(programs, application.programId)),
      href: `/flu/programs?programId=${encodeURIComponent(application.programId)}`,
    });
  }

  const creatorProgramId = text(creator.programId);
  if (isScpProgramId(creatorProgramId)) {
    tags.push({
      key: `program:${creatorProgramId}`,
      kind: "program",
      label: programLabel(creatorProgramId, creator.programTitle, programById(programs, creatorProgramId)),
      href: `/flu/programs?programId=${encodeURIComponent(creatorProgramId)}`,
    });
  }

  for (const conversation of context.conversations ?? []) {
    if (!sameCreator(conversation, canonicalId) || isInactiveConversation(conversation)) continue;
    for (const tag of workflowContextTagsForConversation(conversation, { programs, campaigns })) {
      if (tag.kind === "program" || tag.kind === "campaign") tags.push(tag);
    }
  }

  const creatorCampaignId = text(creator.campaignId);
  if (creatorCampaignId && isScpProgramId(creatorProgramId)) {
    const campaign = campaignById(campaigns, creatorCampaignId);
    tags.push({
      key: `campaign:${creatorCampaignId}`,
      kind: "campaign",
      label: campaignLabel(creatorCampaignId, creator.campaignTitle, campaign),
      href: campaignHref(campaign?.programId),
    });
  }

  return readableTags(tags).slice(0, context.limit ?? 4);
}

export function workflowContextTagsForPipelineCard(
  creator: CreatorLike,
  context: {
    programApplications?: readonly ProgramApplicationLike[];
    programs?: readonly ProgramLike[];
    campaigns?: readonly CampaignLike[];
    conversations?: readonly ConversationLike[];
    limit?: number;
  } = {},
): WorkflowContextTag[] {
  const programs = context.programs ?? [];
  const campaigns = context.campaigns ?? [];
  const tags: WorkflowContextTag[] = [];
  const creatorProgramId = text(creator.programId);
  const creatorCampaignId = text(creator.campaignId);

  for (const application of context.programApplications ?? []) {
    if (!samePipelineRecord(application, creator) || !application.programId || isRetractedParticipation(application)) continue;
    tags.push({
      key: `program:${application.programId}`,
      kind: "program",
      label: programLabel(application.programId, application.programTitle, programById(programs, application.programId)),
      href: `/flu/programs?programId=${encodeURIComponent(application.programId)}`,
    });
  }

  for (const conversation of context.conversations ?? []) {
    if (!samePipelineRecord(conversation, creator) || isInactiveConversation(conversation)) continue;
    for (const tag of workflowContextTagsForConversation(conversation, { programs, campaigns })) {
      if (tag.kind === "program" || tag.kind === "campaign") tags.push(tag);
    }
  }

  if (isScpProgramId(creatorProgramId)) {
    tags.push({
      key: `program:${creatorProgramId}`,
      kind: "program",
      label: programLabel(creatorProgramId, creator.programTitle, programById(programs, creatorProgramId)),
      href: `/flu/programs?programId=${encodeURIComponent(creatorProgramId)}`,
    });
  }

  if (creatorCampaignId && isScpProgramId(creatorProgramId)) {
    const campaign = campaignById(campaigns, creatorCampaignId);
    tags.push({
      key: `campaign:${creatorCampaignId}`,
      kind: "campaign",
      label: campaignLabel(creatorCampaignId, creator.campaignTitle, campaign),
      href: campaignHref(campaign?.programId),
    });
  }

  return readableTags(tags).slice(0, context.limit ?? 3);
}
