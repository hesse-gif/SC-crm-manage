export type CreatorIdentityInput = {
  id?: unknown;
  creatorId?: unknown;
  candidateId?: unknown;
  conversationId?: unknown;
  threadId?: unknown;
  contextKey?: unknown;
  programId?: unknown;
  campaignId?: unknown;
  type?: unknown;
  source?: unknown;
  email?: unknown;
  creatorEmail?: unknown;
  handle?: unknown;
  creatorHandle?: unknown;
  name?: unknown;
  creatorName?: unknown;
  channelId?: unknown;
  youtubeUrl?: unknown;
};

export const CANONICAL_HESSE_CREATOR_ID = "rc-hesse";
export const CANONICAL_HESSE_THREAD_ID = "v-hesse";
export const HESSE_EMAIL = "hesse@supercent.io";
export const HESSE_HANDLE = "@supercent_official";
export const HESSE_CHANNEL_ID = "UCB_NwEsoJQkEgzzqsjaPSpQ";

const HESSE_ALIAS_TOKENS = new Set([
  CANONICAL_HESSE_CREATOR_ID,
  CANONICAL_HESSE_THREAD_ID,
  "program-hesse-supercent-io",
  "program-supercent-official",
  "campaign-rc-hesse",
  "campaign-hesse-supercent-io",
  HESSE_EMAIL,
  HESSE_HANDLE,
  "supercent_official",
  "supercent official",
  HESSE_CHANNEL_ID.toLowerCase(),
  "https://www.youtube.com/@supercent_official",
  "youtube.com/@supercent_official",
  "@supercentofficial",
]);

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeIdentityToken(value: unknown): string {
  return stringValue(value)
    .toLowerCase()
    .replace(/^mailto:/, "")
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\s+/g, " ");
}

function tokenVariants(value: unknown): string[] {
  const token = normalizeIdentityToken(value);
  if (!token) return [];
  const variants = [token];
  if (token.startsWith("candidate:")) variants.push(token.replace(/^candidate:/, ""));
  if (token.startsWith("@")) variants.push(token.slice(1));
  for (const match of token.matchAll(/@([a-z0-9][a-z0-9_.-]{1,63})/gi)) {
    variants.push(`@${match[1]}`);
    variants.push(match[1]);
  }
  if (token.includes("youtube.com/@")) variants.push(token.split("youtube.com/@").pop() ?? "");
  if (token.includes("/@")) variants.push(token.split("/@").pop() ?? "");
  if (token.includes("/channel/")) variants.push(token.split("/channel/").pop() ?? "");
  for (const part of token.split(/[/:]+/)) {
    const clean = part.replace(/[^a-z0-9_.-]+/gi, "");
    if (clean.length >= 3) variants.push(clean);
  }
  return Array.from(new Set(variants.filter(Boolean)));
}

function identityTokens(input: CreatorIdentityInput, fields?: Array<keyof CreatorIdentityInput>): string[] {
  const values = fields?.map((field) => input[field]) ?? [
    input.id,
    input.creatorId,
    input.candidateId,
    input.conversationId,
    input.threadId,
    input.email,
    input.creatorEmail,
    input.handle,
    input.creatorHandle,
    input.name,
    input.creatorName,
    input.channelId,
    input.youtubeUrl,
  ];
  return values.flatMap(tokenVariants);
}

function hasProtectedHesseAlias(input: CreatorIdentityInput, fields: Array<keyof CreatorIdentityInput>): boolean {
  return identityTokens(input, fields).some((token) => HESSE_ALIAS_TOKENS.has(token));
}

function hasDistinctExplicitActor(input: CreatorIdentityInput): boolean {
  return [
    input.creatorId,
    input.candidateId,
    input.threadId,
  ].some((value) => {
    const variants = tokenVariants(value);
    return variants.length > 0 && !variants.some((token) => HESSE_ALIAS_TOKENS.has(token));
  });
}

function isHesseAliasValue(value: unknown): boolean {
  return tokenVariants(value).some((token) => HESSE_ALIAS_TOKENS.has(token));
}

export function isProtectedHesseIdentity(input: CreatorIdentityInput): boolean {
  if (hasDistinctExplicitActor(input)) return false;
  if (hasProtectedHesseAlias(input, [
    "id",
    "creatorId",
    "candidateId",
    "conversationId",
    "threadId",
    "handle",
    "creatorHandle",
    "name",
    "creatorName",
    "channelId",
    "youtubeUrl",
  ])) {
    return true;
  }
  return hasProtectedHesseAlias(input, ["email", "creatorEmail"]);
}

function ownedOfficialAliasTokens(officialChannels: readonly string[]): Set<string> {
  const aliases = new Set(HESSE_ALIAS_TOKENS);
  for (const channel of officialChannels) {
    for (const token of tokenVariants(channel)) aliases.add(token);
  }
  return aliases;
}

export function isOwnedOfficialIdentity(input: CreatorIdentityInput | string[], officialChannels: readonly string[] = []): boolean {
  const tokens = Array.isArray(input) ? input.flatMap(tokenVariants) : identityTokens(input);
  const aliases = ownedOfficialAliasTokens(officialChannels);
  return tokens.some((token) => aliases.has(token));
}

export function safeIdentitySlug(value: unknown): string {
  return normalizeIdentityToken(value)
    .replace(/^@/, "")
    .replace(/[^a-z0-9가-힣_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function firstString(values: unknown[]): string {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return "";
}

export function canonicalCreatorId(input: CreatorIdentityInput): string {
  if (isProtectedHesseIdentity(input)) return CANONICAL_HESSE_CREATOR_ID;
  const explicit = firstString([input.creatorId, input.candidateId, input.id]);
  if (explicit) return explicit.replace(/^candidate:/, "");
  const seed = firstString([input.email, input.creatorEmail, input.handle, input.creatorHandle, input.youtubeUrl, input.name, input.creatorName]);
  const slug = safeIdentitySlug(seed);
  return slug ? `program-${slug}` : "";
}

export function creatorProfileSlug(input: CreatorIdentityInput): string {
  if (isProtectedHesseIdentity(input)) return CANONICAL_HESSE_CREATOR_ID;
  const youtubeToken = normalizeIdentityToken(input.youtubeUrl);
  const youtubeHandle = youtubeToken.includes("youtube.com/@")
    ? youtubeToken.split("youtube.com/@").pop()
    : youtubeToken.includes("/@")
      ? youtubeToken.split("/@").pop()
      : "";
  const handleSlug = safeIdentitySlug(firstString([input.handle, input.creatorHandle, youtubeHandle]));
  if (handleSlug) return handleSlug;

  const channelId = firstString([input.channelId]);
  if (channelId) return safeIdentitySlug(channelId);

  const explicit = firstString([input.creatorId, input.candidateId, input.id]);
  if (explicit) return safeIdentitySlug(explicit.replace(/^candidate:/, ""));

  const seed = firstString([input.email, input.creatorEmail, input.youtubeUrl, input.name, input.creatorName]);
  return safeIdentitySlug(seed) || canonicalCreatorId(input);
}

export function canonicalThreadId(input: CreatorIdentityInput): string {
  const distinctActor = hasDistinctExplicitActor(input);
  if (!distinctActor && isProtectedHesseIdentity(input)) return CANONICAL_HESSE_THREAD_ID;
  const explicitThread = firstString([input.threadId]);
  if (explicitThread && !(distinctActor && isHesseAliasValue(explicitThread))) return explicitThread;
  const conversationId = firstString([input.conversationId, input.id]);
  const creatorId = canonicalCreatorId(input);
  if (conversationId && /^(program|campaign)-/.test(conversationId) && creatorId) return `thread-${creatorId}`;
  if (conversationId) return conversationId;
  return creatorId ? `thread-${creatorId}` : "";
}

export function canonicalWorkflowContextKey(input: CreatorIdentityInput): string {
  const explicitContext = firstString([input.contextKey]);
  if (/^(program|campaign|mail):/.test(explicitContext)) return explicitContext;
  const campaignId = firstString([input.campaignId]);
  if (campaignId) return `campaign:${campaignId}`;
  const programId = firstString([input.programId]);
  if (programId) return `program:${programId}`;

  const source = normalizeIdentityToken(input.source);
  const type = normalizeIdentityToken(input.type);
  const conversationId = firstString([input.conversationId, input.id]);
  if ((type === "program" || source.includes("program_application")) && conversationId) {
    return `program:${conversationId}`;
  }
  if ((type === "campaign" || source.includes("campaign")) && conversationId) {
    return `campaign:${conversationId}`;
  }

  const threadId = canonicalThreadId(input) || conversationId || canonicalCreatorId(input);
  return threadId ? `mail:${threadId}` : "mail:unknown";
}

export function canonicalConversationDocumentId(input: CreatorIdentityInput): string {
  const requestedConversationId = firstString([input.conversationId, input.id]);
  const threadId = canonicalThreadId(input);
  const contextKey = canonicalWorkflowContextKey(input);
  if (contextKey.startsWith("program:") || contextKey.startsWith("campaign:")) {
    if (requestedConversationId && requestedConversationId !== threadId) return requestedConversationId;
    const [kind, rawContextId = ""] = contextKey.split(":", 2);
    const contextId = safeIdentitySlug(rawContextId) || kind;
    const creatorId = canonicalCreatorId(input) || safeIdentitySlug(firstString([
      input.email,
      input.creatorEmail,
      input.handle,
      input.creatorHandle,
      input.name,
      input.creatorName,
    ])) || "creator";
    return safeIdentitySlug(`${kind}-${contextId}-${creatorId}`) || `${kind}-${contextId}`;
  }
  return threadId || requestedConversationId || canonicalCreatorId(input);
}

function pushUnique(values: string[], value: string) {
  if (value && !values.includes(value)) values.push(value);
}

export function conversationThreadCandidates(input: CreatorIdentityInput): string[] {
  const values: string[] = [];
  const creatorId = canonicalCreatorId(input);
  const threadId = canonicalThreadId(input);
  for (const value of [input.conversationId, input.threadId, input.id]) pushUnique(values, stringValue(value));
  pushUnique(values, threadId);
  if (creatorId) {
    pushUnique(values, creatorId);
    pushUnique(values, `thread-${creatorId}`);
    pushUnique(values, `program-${creatorId}`);
    pushUnique(values, `campaign-${creatorId}`);
  }
  for (const seed of [input.email, input.creatorEmail, input.handle, input.creatorHandle, input.youtubeUrl]) {
    const slug = safeIdentitySlug(seed);
    if (slug) {
      pushUnique(values, `program-${slug}`);
      pushUnique(values, `campaign-${slug}`);
    }
  }
  if (isProtectedHesseIdentity(input)) {
    for (const alias of [
      CANONICAL_HESSE_THREAD_ID,
      CANONICAL_HESSE_CREATOR_ID,
      "program-hesse-supercent-io",
      "program-supercent-official",
      "campaign-rc-hesse",
      "campaign-hesse-supercent-io",
    ]) pushUnique(values, alias);
  }
  return values;
}
