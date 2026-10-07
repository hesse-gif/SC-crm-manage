import { createHash, randomBytes } from "node:crypto";

export const MIXMAX_GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

export const MIXMAX_GMAIL_TOPIC = "projects/influencer-crm-296ca/topics/mixmax-gmail";
export const MIXMAX_GOOGLE_REDIRECT_URI = "https://influencer-crm-296ca.web.app/mixmaxGoogleCallback";

const GMAIL_API_ROOT = "https://gmail.googleapis.com/gmail/v1";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}>;

export interface TimestampFactory {
  fromDate(date: Date): unknown;
  now(): unknown;
}

export interface GmailRuntimeDeps {
  fetch: FetchLike;
  now?: () => Date;
  logger?: Pick<Console, "warn" | "error" | "info">;
}

export interface GoogleOAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}

export interface GmailConnection {
  id: string;
  workspaceId: string;
  ownerUid: string;
  email: string;
  refreshToken: string;
  historyId?: string | null;
}

export interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailPayloadPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: {
    data?: string;
    size?: number;
  };
  parts?: GmailPayloadPart[];
}

export interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPayloadPart;
}

export interface GmailHistoryPage {
  history?: Array<{
    id?: string;
    messages?: Array<{ id?: string; threadId?: string }>;
    messagesAdded?: Array<{ message?: { id?: string; threadId?: string } }>;
    messagesDeleted?: Array<{ message?: { id?: string; threadId?: string } }>;
    labelsAdded?: Array<{ message?: { id?: string; threadId?: string } }>;
    labelsRemoved?: Array<{ message?: { id?: string; threadId?: string } }>;
  }>;
  nextPageToken?: string;
  historyId?: string;
}

export interface GmailListMessagesPage {
  messages?: Array<{ id?: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface ProjectedThread {
  id: string;
  workspaceId: string;
  connectionId: string;
  source: "gmail";
  subject: string;
  snippet: string;
  participantEmails: string[];
  lastMessageAt: string;
  unread: boolean;
  gmailThreadId: string;
}

export interface ProjectedMessage {
  id: string;
  workspaceId: string;
  connectionId: string;
  threadId: string;
  source: "gmail";
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  sentAt: string;
  direction: "inbound" | "outbound";
  gmailMessageId: string;
}

export interface GmailProjection {
  thread: ProjectedThread;
  message: ProjectedMessage;
}

export interface GmailSyncResult {
  connectionId: string;
  mode: "history" | "full";
  fetchedMessages: number;
  projectedMessages: number;
  historyId: string | null;
}

export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function randomOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function oauthStateDocId(state: string): string {
  return sha256Hex(`mixmax-oauth-state:${state}`);
}

export function connectionIdFor(workspaceId: string, ownerUid: string, email: string): string {
  return `gmail_${sha256Hex(`${workspaceId}\n${ownerUid}\n${email.toLowerCase()}`).slice(0, 32)}`;
}

export function buildGoogleOAuthUrl(config: GoogleOAuthClientConfig, state: string): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri ?? MIXMAX_GOOGLE_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", MIXMAX_GMAIL_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

export function messageDocId(connectionId: string, gmailMessageId: string): string {
  return `${connectionId}_${sha256Hex(gmailMessageId).slice(0, 32)}`;
}

export function threadDocId(connectionId: string, gmailThreadId: string): string {
  return `${connectionId}_${sha256Hex(gmailThreadId).slice(0, 32)}`;
}

export function parseAddressEmails(value: string): string[] {
  const emails = new Set<string>();
  for (const match of value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    emails.add(match[0].toLowerCase());
  }
  return [...emails];
}

export function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  const wanted = name.toLowerCase();
  return headers?.find((header) => String(header.name ?? "").toLowerCase() === wanted)?.value ?? "";
}

export function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

export function extractMessageBodies(payload: GmailPayloadPart | undefined): { text: string; html: string } {
  const text: string[] = [];
  const html: string[] = [];
  const visit = (part: GmailPayloadPart | undefined) => {
    if (!part) return;
    const decoded = part.body?.data ? decodeBase64Url(part.body.data) : "";
    const mimeType = String(part.mimeType ?? "").toLowerCase();
    if (decoded && mimeType === "text/plain") text.push(decoded);
    if (decoded && mimeType === "text/html") html.push(decoded);
    for (const child of part.parts ?? []) visit(child);
  };
  visit(payload);
  return {
    text: text.join("\n").trim(),
    html: html.join("\n").trim(),
  };
}

export function plainTextFromHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function projectGmailMessage(connection: Omit<GmailConnection, "refreshToken">, message: GmailMessage): GmailProjection {
  if (!message.id) throw new Error("Gmail message is missing id");
  if (!message.threadId) throw new Error("Gmail message is missing threadId");
  const headers = message.payload?.headers ?? [];
  const subject = headerValue(headers, "subject") || "(no subject)";
  const from = headerValue(headers, "from");
  const to = headerValue(headers, "to");
  const cc = headerValue(headers, "cc");
  const sentAtHeader = headerValue(headers, "date");
  const sentAt = normalizeGmailDate(message.internalDate, sentAtHeader);
  const bodies = extractMessageBodies(message.payload);
  const text = bodies.text || plainTextFromHtml(bodies.html);
  const participantEmails = [...new Set([
    ...parseAddressEmails(from),
    ...parseAddressEmails(to),
    ...parseAddressEmails(cc),
  ])].sort();
  const labelIds = new Set((message.labelIds ?? []).map((label) => label.toUpperCase()));
  const senderEmails = parseAddressEmails(from);
  const connectionEmail = connection.email.toLowerCase();
  const direction = labelIds.has("SENT") || senderEmails.includes(connectionEmail) ? "outbound" : "inbound";
  const threadId = threadDocId(connection.id, message.threadId);
  return {
    thread: {
      id: threadId,
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      source: "gmail",
      subject,
      snippet: message.snippet ?? text.slice(0, 180),
      participantEmails,
      lastMessageAt: sentAt,
      unread: labelIds.has("UNREAD"),
      gmailThreadId: message.threadId,
    },
    message: {
      id: messageDocId(connection.id, message.id),
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      threadId,
      source: "gmail",
      from,
      to: parseAddressEmails(`${to},${cc}`),
      subject,
      text,
      html: bodies.html,
      sentAt,
      direction,
      gmailMessageId: message.id,
    },
  };
}

export function normalizeGmailDate(internalDate?: string, headerDate?: string): string {
  const internalMs = Number(internalDate);
  if (Number.isFinite(internalMs) && internalMs > 0) return new Date(internalMs).toISOString();
  const headerMs = Date.parse(headerDate ?? "");
  if (Number.isFinite(headerMs)) return new Date(headerMs).toISOString();
  return new Date(0).toISOString();
}

async function parseJsonResponse<T>(response: Awaited<ReturnType<FetchLike>>, label: string): Promise<T> {
  const body = await response.text();
  if (!response.ok) throw new GmailApiError(`${label} failed with ${response.status}`, response.status, body.slice(0, 1000));
  return body ? JSON.parse(body) as T : {} as T;
}

export async function exchangeOAuthCode(deps: GmailRuntimeDeps, config: GoogleOAuthClientConfig, code: string): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}> {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri ?? MIXMAX_GOOGLE_REDIRECT_URI,
    grant_type: "authorization_code",
  });
  const response = await deps.fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return parseJsonResponse(response, "google oauth token exchange");
}

export async function refreshAccessToken(deps: GmailRuntimeDeps, config: GoogleOAuthClientConfig, refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await deps.fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = await parseJsonResponse<{ access_token?: string }>(response, "google oauth refresh");
  if (!json.access_token) throw new Error("Google token refresh returned no access token");
  return json.access_token;
}

export async function gmailFetch<T>(
  deps: GmailRuntimeDeps,
  accessToken: string,
  path: string,
  init?: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined> },
): Promise<T> {
  const url = new URL(`${GMAIL_API_ROOT}${path}`);
  for (const [key, value] of Object.entries(init?.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const response = await deps.fetch(url.toString(), {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return parseJsonResponse<T>(response, `gmail ${path}`);
}

export async function getGmailProfile(deps: GmailRuntimeDeps, accessToken: string): Promise<{ emailAddress: string; historyId?: string }> {
  const profile = await gmailFetch<{ emailAddress?: string; historyId?: string }>(deps, accessToken, "/users/me/profile");
  if (!profile.emailAddress) throw new Error("Gmail profile returned no email address");
  return { emailAddress: profile.emailAddress.toLowerCase(), historyId: profile.historyId };
}

export async function watchGmailMailbox(deps: GmailRuntimeDeps, accessToken: string): Promise<{ historyId: string; expiration?: string }> {
  const watch = await gmailFetch<{ historyId?: string; expiration?: string }>(deps, accessToken, "/users/me/watch", {
    method: "POST",
    body: {
      topicName: MIXMAX_GMAIL_TOPIC,
    },
  });
  if (!watch.historyId) throw new Error("Gmail watch returned no historyId");
  return { historyId: watch.historyId, expiration: watch.expiration };
}

export async function stopGmailMailbox(deps: GmailRuntimeDeps, accessToken: string): Promise<void> {
  await gmailFetch<Record<string, never>>(deps, accessToken, "/users/me/stop", { method: "POST", body: {} });
}

export async function sendGmailRawMessage(
  deps: GmailRuntimeDeps,
  accessToken: string,
  raw: string,
  threadId?: string,
): Promise<{ id?: string; threadId?: string; labelIds?: string[] }> {
  return gmailFetch(deps, accessToken, "/users/me/messages/send", {
    method: "POST",
    body: { raw: Buffer.from(raw).toString("base64url"), ...(threadId ? { threadId } : {}) },
  });
}

export async function fetchGmailMessage(deps: GmailRuntimeDeps, accessToken: string, messageId: string): Promise<GmailMessage> {
  return gmailFetch<GmailMessage>(deps, accessToken, `/users/me/messages/${encodeURIComponent(messageId)}`, {
    query: { format: "full" },
  });
}

export function collectHistoryMessageIds(page: GmailHistoryPage): string[] {
  const ids = new Set<string>();
  for (const row of page.history ?? []) {
    for (const item of row.messagesAdded ?? []) if (item.message?.id) ids.add(item.message.id);
    for (const item of row.labelsAdded ?? []) if (item.message?.id) ids.add(item.message.id);
    for (const item of row.labelsRemoved ?? []) if (item.message?.id) ids.add(item.message.id);
    if (!row.messagesAdded?.length && !row.labelsAdded?.length && !row.labelsRemoved?.length) {
      for (const message of row.messages ?? []) if (message.id) ids.add(message.id);
    }
  }
  return [...ids];
}

export function watchExpirationIso(expiration?: string): string | null {
  const millis = Number(expiration);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  return new Date(millis).toISOString();
}

export function encodeSimpleRawEmail(input: {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
}): string {
  for (const value of [input.from, ...input.to, ...(input.cc ?? []), ...(input.bcc ?? []), input.inReplyTo ?? "", input.references ?? ""]) {
    if (/[\r\n]/.test(value)) throw new Error("Invalid mail header");
  }
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to.join(", ")}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    ...(input.bcc?.length ? [`Bcc: ${input.bcc.join(", ")}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(input.subject.replace(/[\r\n]/g, " ")).toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
  ];
  return `${headers.join("\r\n")}\r\n\r\n${input.text}`;
}
