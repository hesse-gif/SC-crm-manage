import { canonicalCreatorId, creatorProfileSlug } from "./creator-identity.ts";
import type { ChatConversation } from "./chat-normalization";
import type { Campaign } from "./mock/campaigns";
import type { Program, ProgramApplication, ProgramApplicationStatus } from "./mock/programs";

export type ProgramParticipantRow = {
  readonly key: string;
  readonly name: string;
  readonly avatar: string;
  readonly meta: string;
  readonly href: string | null;
  readonly sourceLabel: string;
  readonly status?: ProgramApplicationStatus;
};

export type CanonicalParticipantDisplay = {
  readonly name: string;
  readonly avatar?: string;
  readonly meta?: string;
};

type ParticipantOptions = {
  readonly applicationProfileHref: (application: ProgramApplication) => string | null;
  readonly canonicalDisplayByIdentity?: ReadonlyMap<string, CanonicalParticipantDisplay>;
};

function formatFollowers(value?: number): string {
  if (!value) return "";
  if (value >= 10000) return `${Number((value / 10000).toFixed(1)).toLocaleString("ko-KR")}만 팔로워`;
  return `${value.toLocaleString("ko-KR")} 팔로워`;
}

function applicationBaseKey(application: ProgramApplication): string {
  return canonicalCreatorId({
    creatorId: application.creatorId,
    email: application.email,
    handle: application.handle,
    name: application.name,
    youtubeUrl: application.youtubeUrl,
  }) || application.email || application.handle || application.id;
}

function identityToken(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function applicationIdentityTokens(application: ProgramApplication): string[] {
  return [
    applicationBaseKey(application),
    identityToken(application.email),
    identityToken(application.handle),
    identityToken(application.name),
    identityToken(application.youtubeUrl),
  ].filter(Boolean);
}

function conversationBaseKey(conversation: ChatConversation): string {
  return canonicalCreatorId({
    creatorId: conversation.creatorId,
    email: conversation.creatorEmail,
    handle: conversation.creatorHandle,
    name: conversation.creatorName,
  }) || conversation.creatorEmail || conversation.creatorHandle || conversation.creatorId || conversation.id;
}

function conversationIdentityTokens(conversation: ChatConversation): string[] {
  return [
    conversationBaseKey(conversation),
    identityToken(conversation.creatorEmail),
    identityToken(conversation.creatorHandle),
    identityToken(conversation.creatorName),
  ].filter(Boolean);
}

function scopedParticipantKey(baseKey: string, campaignId: string | undefined, selectedCampaign: Campaign | null): string {
  if (selectedCampaign) return baseKey;
  return campaignId ? `${baseKey}::campaign:${campaignId}` : `${baseKey}::program`;
}

function conversationHref(conversation: ChatConversation): string | null {
  const creatorId = creatorProfileSlug({
    creatorId: conversation.creatorId,
    email: conversation.creatorEmail,
    handle: conversation.creatorHandle,
    name: conversation.creatorName,
  });
  return creatorId ? `/flu/influencers/${encodeURIComponent(creatorId)}` : null;
}

function campaignLabel(campaignId: string | undefined, campaignsById: Map<string, Campaign>): string {
  if (!campaignId) return "";
  return campaignsById.get(campaignId)?.name || "캠페인";
}

function conversationProgramId(conversation: ChatConversation, campaignsById: Map<string, Campaign>): string | undefined {
  return conversation.programId || campaignsById.get(conversation.campaignId || "")?.programId;
}

function participantDisplay(baseKey: string, options: ParticipantOptions): CanonicalParticipantDisplay | undefined {
  return options.canonicalDisplayByIdentity?.get(baseKey);
}

function withContextMeta(contextLabel: string, profileMeta: string | undefined, fallbackMetaParts: ReadonlyArray<string | undefined>): string {
  return [contextLabel, profileMeta || fallbackMetaParts.filter(Boolean).join(" · ")].filter(Boolean).join(" · ");
}

function aggregateProgramOverviewRows(rows: readonly ProgramParticipantRow[], campaigns: readonly Campaign[]): ProgramParticipantRow[] {
  const campaignNames = campaigns.map((campaign) => campaign.name).filter(Boolean);
  const byIdentity = new Map<string, {
    row: ProgramParticipantRow;
    contextLabels: string[];
    profileMeta: string;
    sourceLabels: Set<string>;
  }>();

  for (const row of rows) {
    const identityKey = row.key.split("::")[0] || row.key;
    const contextLabels = campaignNames.filter((name) => row.meta.includes(name));
    let profileMeta = row.meta;
    for (const label of contextLabels) {
      profileMeta = profileMeta.replace(label, "").replace(/^ · /, "").replace(/ ·  · /g, " · ");
    }
    profileMeta = profileMeta.replace(/^ ·\s*/, "").replace(/\s*·$/, "").trim();

    const existing = byIdentity.get(identityKey);
    if (!existing) {
      byIdentity.set(identityKey, {
        row: { ...row, key: identityKey },
        contextLabels: [...contextLabels],
        profileMeta,
        sourceLabels: new Set([row.sourceLabel]),
      });
      continue;
    }

    for (const label of contextLabels) {
      if (!existing.contextLabels.includes(label)) existing.contextLabels.push(label);
    }
    if (!existing.profileMeta && profileMeta) existing.profileMeta = profileMeta;
    existing.sourceLabels.add(row.sourceLabel);
    if (!existing.row.status && row.status) existing.row = { ...existing.row, status: row.status };
    if (!existing.row.href && row.href) existing.row = { ...existing.row, href: row.href };
  }

  return Array.from(byIdentity.values()).map(({ row, contextLabels, profileMeta, sourceLabels }) => ({
    ...row,
    meta: [...contextLabels, profileMeta].filter(Boolean).join(" · "),
    sourceLabel: sourceLabels.size > 1 ? "프로그램·캠페인" : row.sourceLabel,
  }));
}

export function programParticipantRowsForScope(
  program: Program,
  selectedCampaign: Campaign | null,
  campaigns: readonly Campaign[],
  applications: readonly ProgramApplication[],
  conversations: readonly ChatConversation[],
  options: ParticipantOptions,
): ProgramParticipantRow[] {
  const rows: ProgramParticipantRow[] = [];
  const seen = new Set<string>();
  const campaignsById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const applicationByBaseKey = new Map<string, ProgramApplication>();
  const campaignConversationIdentityKeys = new Set<string>();

  for (const application of applications) {
    if (application.programId !== program.id) continue;
    const baseKey = applicationBaseKey(application);
    if (!applicationByBaseKey.has(baseKey)) applicationByBaseKey.set(baseKey, application);
  }

  for (const conversation of conversations) {
    if (conversationProgramId(conversation, campaignsById) !== program.id || !conversation.campaignId) continue;
    for (const token of conversationIdentityTokens(conversation)) campaignConversationIdentityKeys.add(token);
  }

  for (const application of applications) {
    if (application.programId !== program.id) continue;
    if (selectedCampaign && application.campaignId !== selectedCampaign.id) continue;
    const baseKey = applicationBaseKey(application);
    const overlapsCampaignConversation = applicationIdentityTokens(application).some((token) => campaignConversationIdentityKeys.has(token));
    if (!selectedCampaign && !application.campaignId && overlapsCampaignConversation) continue;
    const key = scopedParticipantKey(baseKey, application.campaignId, selectedCampaign);
    if (seen.has(key)) continue;
    seen.add(key);
    const contextLabel = selectedCampaign ? "" : campaignLabel(application.campaignId, campaignsById);
    const display = participantDisplay(baseKey, options);
    rows.push({
      key,
      name: display?.name || application.name,
      avatar: display?.avatar || application.avatar || application.name.slice(0, 1),
      meta: withContextMeta(contextLabel, display?.meta, [application.platform, application.handle, application.email, formatFollowers(application.followers), application.category]),
      href: options.applicationProfileHref(application),
      sourceLabel: "신청자",
      status: application.status,
    });
  }

  for (const conversation of conversations) {
    if (conversationProgramId(conversation, campaignsById) !== program.id) continue;
    if (selectedCampaign && conversation.campaignId !== selectedCampaign.id) continue;
    const baseKey = conversationBaseKey(conversation);
    const key = scopedParticipantKey(baseKey, conversation.campaignId, selectedCampaign);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = conversation.creatorName || conversation.creatorHandle || conversation.creatorEmail || "이름 없음";
    const application = applicationByBaseKey.get(baseKey);
    const contextLabel = selectedCampaign ? "" : campaignLabel(conversation.campaignId, campaignsById);
    const display = participantDisplay(baseKey, options);
    rows.push({
      key,
      name: display?.name || name,
      avatar: display?.avatar || conversation.creatorAvatar || name.slice(0, 1),
      meta: withContextMeta(contextLabel, display?.meta, [conversation.creatorPlatform, conversation.creatorHandle, conversation.creatorEmail]),
      href: conversationHref(conversation),
      sourceLabel: conversation.campaignId ? "캠페인 thread" : "메일 thread",
      status: application?.status,
    });
  }
  return selectedCampaign ? rows : aggregateProgramOverviewRows(rows, campaigns);
}
