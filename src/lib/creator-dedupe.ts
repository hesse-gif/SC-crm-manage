import { canonicalCreatorId } from "./creator-identity.ts";
import type { Creator } from "./mock/creators";
import type { Stage, GuideStatus } from "./mock/core";

const STAGE_RANK: Record<Stage, number> = {
  contact: 0,
  negotiation: 1,
  contract: 2,
  review: 3,
  live: 4,
};

const GUIDE_RANK: Record<GuideStatus, number> = {
  within: 0,
  near: 1,
  over: 2,
};

function creatorIdentity(creator: Creator): string {
  return canonicalCreatorId({
    creatorId: creator.id,
    email: creator.email,
    handle: creator.handle,
    name: creator.name,
    channelId: creator.channelId,
    youtubeUrl: creator.youtubeUrl,
  }) || creator.id;
}

function betterBase(left: Creator, right: Creator): Creator {
  if (right.protected && !left.protected) return right;
  if (!right.protected && left.protected) return left;
  if (STAGE_RANK[right.stage] > STAGE_RANK[left.stage]) return right;
  if (STAGE_RANK[right.stage] < STAGE_RANK[left.stage]) return left;
  return (right.followers ?? 0) > (left.followers ?? 0) ? right : left;
}

function maxStage(creators: readonly Creator[]): Stage {
  return creators.reduce((stage, creator) =>
    STAGE_RANK[creator.stage] > STAGE_RANK[stage] ? creator.stage : stage, creators[0]?.stage ?? "contact");
}

function maxGuideStatus(creators: readonly Creator[]): GuideStatus {
  return creators.reduce((status, creator) =>
    GUIDE_RANK[creator.guideStatus] > GUIDE_RANK[status] ? creator.guideStatus : status, creators[0]?.guideStatus ?? "within");
}

function firstText(values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim());
}

export function dedupeCreatorsByCanonical(creators: readonly Creator[]): Creator[] {
  const groups = new Map<string, Creator[]>();
  for (const creator of creators) {
    const key = creatorIdentity(creator);
    groups.set(key, [...(groups.get(key) ?? []), creator]);
  }

  return Array.from(groups.entries()).map(([canonicalId, group]) => {
    const base = group.reduce(betterBase);
    return {
      ...base,
      id: canonicalId,
      name: firstText([base.name, ...group.map((creator) => creator.name)]) ?? base.name,
      handle: firstText([base.handle, ...group.map((creator) => creator.handle)]) ?? base.handle,
      email: firstText([base.email, ...group.map((creator) => creator.email)]),
      avatar: firstText([base.avatar, ...group.map((creator) => creator.avatar)]) ?? base.avatar,
      followers: Math.max(...group.map((creator) => creator.followers ?? 0)),
      stage: maxStage(group),
      guideStatus: maxGuideStatus(group),
      budgetKRW: Math.max(...group.map((creator) => creator.budgetKRW ?? 0)),
      aiHandling: group.some((creator) => creator.aiHandling),
      protected: group.some((creator) => creator.protected),
      lastActivity: firstText([base.lastActivity, ...group.map((creator) => creator.lastActivity)]) ?? base.lastActivity,
      profileMatchedEmail: firstText([base.profileMatchedEmail, base.email, ...group.map((creator) => creator.profileMatchedEmail), ...group.map((creator) => creator.email)]),
      youtubeUrl: firstText([base.youtubeUrl, ...group.map((creator) => creator.youtubeUrl)]),
      channelId: firstText([base.channelId, ...group.map((creator) => creator.channelId)]),
    };
  });
}
