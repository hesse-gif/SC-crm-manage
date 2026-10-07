import { canonicalCreatorId } from "./creator-identity.ts";
import { conversationMillis, type ChatConversation } from "./chat-normalization.ts";
import { resolveCanonicalProgramId, SCP_CANONICAL_PROGRAM_ID } from "./program-canonical.ts";

type ProgramLike = {
  id: string;
  canonicalProgramId?: string;
  slug?: string;
  aliases?: string[];
  legacyProgramIds?: string[];
  title?: string;
  name?: string;
  gameTitle?: string;
};

type CampaignLike = {
  id: string;
  programId?: string;
  canonicalProgramId?: string;
  name?: string;
  title?: string;
};

export type ChatPrimaryBucket = "program" | "direct";

export type ChatPrimaryRouteReasonId =
  | "attribution_final_program"
  | "attribution_final_direct"
  | "explicit_program_id"
  | "campaign_resolved_program"
  | "campaign_unresolved"
  | "unassigned_ai_active"
  | "routing_status_ambiguous"
  | "direct_unassigned";

export type ChatPrimaryRoute = {
  readonly primaryBucket: ChatPrimaryBucket;
  readonly reviewRequired: boolean;
  readonly reasonId: ChatPrimaryRouteReasonId;
  readonly programId?: string;
  readonly campaignId?: string;
};

export type ChatProgramGroup = {
  readonly programId: string;
  readonly title: string;
  readonly campaignCount: number;
  readonly participantCount: number;
  readonly unread: number;
  readonly latestMillis: number;
  readonly conversations: readonly ChatConversation[];
};

function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function titleForProgram(program?: ProgramLike, fallbackId?: string): string {
  return text(program?.title) || text(program?.gameTitle) || text(program?.name) || text(fallbackId) || "프로그램";
}

function canonicalProgramReference(value: unknown): string {
  const raw = text(value);
  if (!raw) return "";
  const normalized = raw.toLowerCase();
  if (normalized === "super-creator-partners") return SCP_CANONICAL_PROGRAM_ID;
  return resolveCanonicalProgramId(raw);
}

function canonicalProgramRecordId(program: ProgramLike): string {
  const declaredCanonical = canonicalProgramReference(program.canonicalProgramId);
  if (declaredCanonical) return declaredCanonical;
  const references = [program.id, program.slug, ...(program.aliases ?? []), ...(program.legacyProgramIds ?? [])];
  if (references.some((value) => canonicalProgramReference(value) === SCP_CANONICAL_PROGRAM_ID)) {
    return SCP_CANONICAL_PROGRAM_ID;
  }
  if (text(program.title).toLowerCase().replace(/\s+/g, " ") === "super creator partners") {
    return SCP_CANONICAL_PROGRAM_ID;
  }
  return canonicalProgramReference(program.id);
}

function hasAmbiguousRoutingStatus(conversation: ChatConversation): boolean {
  const signals = [
    conversation.routeReason,
    conversation.status,
    conversation.deliveryState,
    conversation.lastDeliveryState,
    conversation.outreachStatus,
  ].map((value) => text(value).toLowerCase());
  return signals.some((signal) =>
    signal === "unknown" ||
    signal === "error" ||
    signal === "failed" ||
    signal.includes("unknown") ||
    signal.includes("error"),
  );
}

export function classifyChatPrimaryRoute(
  conversation: ChatConversation,
  campaignsById: ReadonlyMap<string, CampaignLike>,
): ChatPrimaryRoute {
  const finalAttribution = conversation.attribution?.final;
  if (finalAttribution?.primaryBucket === "program" && finalAttribution.programId) {
    return {
      primaryBucket: "program",
      reviewRequired: conversation.attribution?.reviewRequired === true || conversation.attributionReviewRequired === true,
      reasonId: "attribution_final_program",
      programId: canonicalProgramReference(finalAttribution.programId),
      campaignId: text(finalAttribution.campaignId) || undefined,
    };
  }
  if (finalAttribution?.primaryBucket === "direct") {
    return {
      primaryBucket: "direct",
      reviewRequired: conversation.attribution?.reviewRequired === true || conversation.attributionReviewRequired === true,
      reasonId: "attribution_final_direct",
    };
  }

  const explicitProgramId = canonicalProgramReference(conversation.canonicalProgramId || conversation.programId);
  if (explicitProgramId) {
    return {
      primaryBucket: "program",
      reviewRequired: false,
      reasonId: "explicit_program_id",
      programId: explicitProgramId,
      campaignId: text(conversation.campaignId) || undefined,
    };
  }

  const campaignId = text(conversation.campaignId);
  if (campaignId) {
    const campaign = campaignsById.get(campaignId);
    const programId = canonicalProgramReference(campaign?.canonicalProgramId || campaign?.programId);
    if (programId) {
      return {
        primaryBucket: "program",
        reviewRequired: false,
        reasonId: "campaign_resolved_program",
        programId,
        campaignId,
      };
    }
    return {
      primaryBucket: "direct",
      reviewRequired: true,
      reasonId: "campaign_unresolved",
      campaignId,
    };
  }

  if (hasAmbiguousRoutingStatus(conversation)) {
    return {
      primaryBucket: "direct",
      reviewRequired: true,
      reasonId: "routing_status_ambiguous",
    };
  }

  if (conversation.aiActive) {
    return {
      primaryBucket: "direct",
      reviewRequired: true,
      reasonId: "unassigned_ai_active",
    };
  }

  return {
    primaryBucket: "direct",
    reviewRequired: false,
    reasonId: "direct_unassigned",
  };
}

export function participantKey(conversation: ChatConversation): string {
  return canonicalCreatorId({
    creatorId: conversation.creatorId,
    email: conversation.creatorEmail,
    handle: conversation.creatorHandle,
    name: conversation.creatorName,
  }) || conversation.creatorEmail || conversation.creatorHandle || conversation.creatorId || conversation.id;
}

export function buildChatProgramGroups(
  programs: readonly ProgramLike[],
  campaigns: readonly CampaignLike[],
  conversations: readonly ChatConversation[],
): ChatProgramGroup[] {
  const campaignsById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const programsById = new Map<string, ProgramLike>();
  for (const program of programs) {
    const canonicalId = canonicalProgramRecordId(program);
    const existing = programsById.get(canonicalId);
    if (!existing || program.id === canonicalId) programsById.set(canonicalId, program);
  }
  const ids = new Set(programs.map(canonicalProgramRecordId).filter(Boolean));
  for (const conversation of conversations) {
    const route = classifyChatPrimaryRoute(conversation, campaignsById);
    if (route.primaryBucket === "program" && route.programId) ids.add(route.programId);
  }

  const programGroups = Array.from(ids).map((programId) => {
    const programCampaignIds = new Set(campaigns
      .filter((campaign) => canonicalProgramReference(campaign.canonicalProgramId || campaign.programId) === programId)
      .map((campaign) => campaign.id));
    const groupConversations = conversations
      .filter((conversation) => {
        const route = classifyChatPrimaryRoute(conversation, campaignsById);
        return route.primaryBucket === "program" && route.programId === programId;
      })
      .sort((left, right) => conversationMillis(right) - conversationMillis(left));
    const participants = new Set(groupConversations.map(participantKey).filter(Boolean));
    return {
      programId,
      title: titleForProgram(programsById.get(programId), programId),
      campaignCount: programCampaignIds.size,
      participantCount: participants.size,
      unread: groupConversations.reduce((sum, conversation) => sum + Math.max(0, conversation.unread), 0),
      latestMillis: Math.max(0, ...groupConversations.map(conversationMillis)),
      conversations: groupConversations,
    };
  }).sort((left, right) => {
    if (right.latestMillis !== left.latestMillis) return right.latestMillis - left.latestMillis;
    return left.title.localeCompare(right.title);
  });

  return programGroups;
}

function conversationSelectionKey(conversation: ChatConversation): string {
  return conversation.uiThreadKey || conversation.id;
}

export function chatConversationMatchesSelection(
  conversation: ChatConversation,
  selectedId: string,
): boolean {
  if (!selectedId) return false;
  return conversationSelectionKey(conversation) === selectedId ||
    conversation.id === selectedId ||
    (conversation.threadConversationIds ?? []).includes(selectedId);
}

export function selectChatConversationForView(
  conversations: readonly ChatConversation[],
  visibleConversations: readonly ChatConversation[],
  selectedId: string,
  options: { requireExactSelection?: boolean } = {},
): ChatConversation | undefined {
  const selectedVisible = visibleConversations.find((conversation) => chatConversationMatchesSelection(conversation, selectedId));
  if (selectedVisible) return selectedVisible;
  if (options.requireExactSelection) return undefined;
  if (visibleConversations.length > 0) return visibleConversations[0];
  return conversations.find((conversation) => chatConversationMatchesSelection(conversation, selectedId)) ?? conversations[0];
}
