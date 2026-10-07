import { createHash } from "node:crypto";

export const DEFAULT_DAILY_CLASSIFICATION_CAP = 100;
export const DEFAULT_DAILY_SEND_CAP = 20;

export interface AutomationCasePolicy {
  name?: unknown;
  description?: unknown;
  body?: unknown;
  skeleton?: unknown;
  never?: unknown;
  importNever?: unknown;
  draftForbidden?: unknown;
  noReplyNeeded?: unknown;
}

export interface AutomationMessageLike {
  direction?: unknown;
  from?: unknown;
  to?: unknown;
  replyTo?: unknown;
  cc?: unknown;
  autoSubmitted?: unknown;
  precedence?: unknown;
  listId?: unknown;
  labelIds?: unknown;
}

export interface AutomationConnectionLike {
  id: string;
  email?: unknown;
  automationEnabled?: unknown;
  automationEnabledAt?: unknown;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function automationPolicyDigest(data: AutomationCasePolicy): string {
  return sha256Hex(stableJson({
    name: stringValue(data.name),
    description: stringValue(data.description),
    body: stringValue(data.body),
    skeleton: stringValue(data.skeleton),
    never: stringValue(data.never),
    importNever: stringValue(data.importNever),
    draftForbidden: data.draftForbidden === true,
    noReplyNeeded: data.noReplyNeeded === true,
  }));
}

export function automationRunId(threadId: string, messageId: string): string {
  return `run_${sha256Hex(`${threadId}\n${messageId}`).slice(0, 40)}`;
}

export function pendingCaseId(workspaceId: string, threadId: string, messageId: string): string {
  return `case_${sha256Hex(`${workspaceId}\n${threadId}\n${messageId}`).slice(0, 32)}`;
}

export function dailyBudgetId(workspaceId: string, connectionId: string, iso: string): string {
  return `${workspaceId}_${connectionId}_${iso.slice(0, 10)}`;
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function emailList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map(item => stringValue(item).toLowerCase()).filter(Boolean))]
    : [];
}

export function isAutomationEnabledForMessage(connection: AutomationConnectionLike, sentAt: string): boolean {
  if (connection.automationEnabled !== true) return false;
  const enabledAt = stringValue(connection.automationEnabledAt);
  const activated = Date.parse(enabledAt);
  const received = Date.parse(sentAt);
  return Number.isFinite(activated) && Number.isFinite(received) && received >= activated;
}

export function directReplyAddress(message: AutomationMessageLike, connectionEmail: string): { ok: true; to: string } | { ok: false; reason: string } {
  const replyTo = emailList(message.replyTo);
  const fromAddresses = emailListFromHeader(message.from);
  const senders = replyTo.length ? replyTo : fromAddresses;
  const from = senders[0] ?? "";
  const recipients = emailList(message.to);
  const cc = emailList(message.cc);
  const labels = emailList(message.labelIds).map(label => label.toUpperCase());
  const autoSubmitted = stringValue(message.autoSubmitted).toLowerCase();
  const precedence = stringValue(message.precedence).toLowerCase();
  const listId = stringValue(message.listId);
  const sender = from.toLowerCase();
  const mailbox = connectionEmail.trim().toLowerCase();

  if (message.direction !== "inbound") return { ok: false, reason: "not_inbound" };
  if (!/^[^\s<>\r\n@]+@[^\s<>\r\n@]+\.[^\s<>\r\n@]+$/.test(mailbox)) return { ok: false, reason: "invalid_mailbox" };
  if (fromAddresses.length !== 1) return { ok: false, reason: "ambiguous_sender" };
  if (senders.length !== 1) return { ok: false, reason: "ambiguous_sender" };
  if (!sender) return { ok: false, reason: "missing_sender" };
  if (!/^[^\s<>\r\n@]+@[^\s<>\r\n@]+\.[^\s<>\r\n@]+$/.test(sender)) return { ok: false, reason: "invalid_sender" };
  if (sender === mailbox) return { ok: false, reason: "self_reply" };
  if (fromAddresses[0] === mailbox) return { ok: false, reason: "self_reply" };
  if (/(^|[._+-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster)(@|[._+-])/i.test(fromAddresses[0])) return { ok: false, reason: "system_sender" };
  if (/(^|[._+-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster)(@|[._+-])/i.test(sender)) return { ok: false, reason: "system_sender" };
  if (autoSubmitted && autoSubmitted !== "no") return { ok: false, reason: "auto_submitted" };
  if (["bulk", "list", "junk"].includes(precedence)) return { ok: false, reason: "bulk_or_list" };
  if (listId) return { ok: false, reason: "mailing_list" };
  if (labels.some(label => ["SPAM", "TRASH", "DRAFT"].includes(label))) return { ok: false, reason: "unsafe_label" };
  if (cc.length) return { ok: false, reason: "multi_party" };
  if (recipients.length !== 1 || recipients[0] !== mailbox) return { ok: false, reason: "ambiguous_recipient" };
  return { ok: true, to: sender };
}

export function emailListFromHeader(value: unknown): string[] {
  const text = stringValue(value).toLowerCase();
  return [...new Set([...text.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g)].map(match => match[0]))];
}

export function parseClassifierJson(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Classifier did not return an object");
  if (typeof parsed.caseId !== "string" || parsed.caseId.length > 240 || typeof parsed.noReply !== "boolean" || typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) throw new Error("Classifier fields are invalid");
  for (const [key, max] of [["reason", 1000], ["proposedName", 200], ["proposedDescription", 4000], ["proposedReply", 50000]] as const) {
    if (parsed[key] !== undefined && (typeof parsed[key] !== "string" || parsed[key].length > max)) throw new Error("Classifier field exceeds its bound");
  }
  return parsed as Record<string, unknown>;
}

export function normalizeConfidence(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0;
}
