import { normalizeIdentityToken } from "./creator-identity.ts";
import type { Conversation } from "./mock/chat.ts";
import type { Creator } from "./mock/creators.ts";

export function pipelineIdentityAliases(input: {
  id?: unknown;
  email?: unknown;
  matchedEmail?: unknown;
  handle?: unknown;
}): string[] {
  const aliases = new Set<string>();
  const id = normalizeIdentityToken(input.id).replace(/^candidate:/, "");
  const email = normalizeIdentityToken(input.email);
  const matchedEmail = normalizeIdentityToken(input.matchedEmail);
  const handle = normalizeIdentityToken(input.handle)
    .replace(/^youtube\.com\/@/, "")
    .replace(/^@/, "");
  if (id) aliases.add(`id:${id}`);
  if (email) aliases.add(`email:${email}`);
  if (matchedEmail) aliases.add(`email:${matchedEmail}`);
  if (handle) aliases.add(`handle:${handle}`);
  return Array.from(aliases);
}

function creatorAliasIndex(creators: readonly Creator[]): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const creator of creators) {
    const aliases = pipelineIdentityAliases({
      id: creator.id,
      email: creator.email,
      matchedEmail: creator.profileMatchedEmail,
      handle: creator.handle,
    });
    for (const alias of aliases) {
      if (!index.has(alias)) {
        index.set(alias, creator.id);
        continue;
      }
      if (index.get(alias) !== creator.id) index.set(alias, null);
    }
  }
  return index;
}

export function matchingPipelineCreatorId(
  conversation: Conversation,
  creators: readonly Creator[],
): string | null {
  const index = creatorAliasIndex(creators);
  const matches = new Set<string>();
  for (const alias of pipelineIdentityAliases({
    id: conversation.creatorId,
    email: conversation.creatorEmail,
    handle: conversation.creatorHandle,
  })) {
    if (!index.has(alias)) continue;
    const creatorId = index.get(alias);
    // Shared inboxes/handles and contradictory aliases are not strong enough to hide a card.
    if (creatorId == null) return null;
    matches.add(creatorId);
  }
  return matches.size === 1 ? Array.from(matches)[0] : null;
}

export function standalonePipelineConversations(
  creators: readonly Creator[],
  conversations: readonly Conversation[],
): Conversation[] {
  const index = creatorAliasIndex(creators);
  return conversations.filter((conversation) => {
    const matches = new Set<string>();
    for (const alias of pipelineIdentityAliases({
      id: conversation.creatorId,
      email: conversation.creatorEmail,
      handle: conversation.creatorHandle,
    })) {
      if (!index.has(alias)) continue;
      const creatorId = index.get(alias);
      if (creatorId == null) return true;
      matches.add(creatorId);
    }
    return matches.size !== 1;
  });
}
