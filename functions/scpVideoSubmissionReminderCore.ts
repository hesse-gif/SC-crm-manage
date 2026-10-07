import { createHash } from "node:crypto";

export const MAX_VIDEO_REMINDER_STEPS = 12;
export const MAX_VIDEO_REMINDER_DAY = 365;
export const DEFAULT_VIDEO_REMINDER_TIMEZONE = "Asia/Seoul";
export const DEFAULT_VIDEO_REMINDER_SEND_TIME = "09:00";

export type VideoReminderDeliveryMode = "approval_required" | "auto_send";

export interface VideoReminderSettings {
  enabled: boolean;
  offsets: number[];
  deliveryMode: VideoReminderDeliveryMode;
  timezone: string;
  sendTime: string;
  sendOnWeekends: boolean;
  pauseOnReply: boolean;
  pauseOnBounce: boolean;
  pauseOnOptOut: boolean;
  submissionFormUrl: string;
}

export interface ReminderOccurrenceLike {
  id: string;
  offsetDays: number;
  dueAtIso: string;
  status: string;
}

function finiteInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) ? parsed : null;
}

export function normalizeReminderOffsets(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const offsets = value.map((item) => {
    const parsed = finiteInteger(item);
    if (parsed === null || parsed <= 0) {
      throw new Error("video reminder offsets must be positive integers");
    }
    if (parsed > MAX_VIDEO_REMINDER_DAY) {
      throw new Error(`video reminder offset exceeds maximum day ${MAX_VIDEO_REMINDER_DAY}`);
    }
    return parsed;
  });
  const normalized = [...new Set(offsets)].sort((left, right) => left - right);
  if (normalized.length > MAX_VIDEO_REMINDER_STEPS) {
    throw new Error(`video reminder offsets exceed maximum steps ${MAX_VIDEO_REMINDER_STEPS}`);
  }
  return normalized;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function safeTimezone(value: unknown): string {
  const candidate = typeof value === "string" && value.trim()
    ? value.trim().slice(0, 80)
    : DEFAULT_VIDEO_REMINDER_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    throw new Error("video reminder timezone must be a valid IANA timezone");
  }
}

function safeSendTime(value: unknown): string {
  const candidate = typeof value === "string" && value.trim()
    ? value.trim()
    : DEFAULT_VIDEO_REMINDER_SEND_TIME;
  const match = candidate.match(/^(\d{2}):(\d{2})$/);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("video reminder sendTime must use HH:mm");
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function safeHttpsUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") throw new Error("not https");
    return url.toString();
  } catch {
    throw new Error("video reminder submissionFormUrl must be an https URL");
  }
}

export function normalizeReminderSettings(value: unknown): VideoReminderSettings {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const deliveryMode: VideoReminderDeliveryMode = row.deliveryMode === "auto_send"
    ? "auto_send"
    : "approval_required";
  return {
    enabled: row.enabled === true,
    offsets: normalizeReminderOffsets(row.offsets),
    deliveryMode,
    timezone: safeTimezone(row.timezone),
    sendTime: safeSendTime(row.sendTime),
    sendOnWeekends: booleanValue(row.sendOnWeekends, false),
    pauseOnReply: booleanValue(row.pauseOnReply, true),
    pauseOnBounce: booleanValue(row.pauseOnBounce, true),
    pauseOnOptOut: booleanValue(row.pauseOnOptOut, true),
    submissionFormUrl: safeHttpsUrl(row.submissionFormUrl),
  };
}

export function reminderSettingsHash(settingsValue: unknown): string {
  const settings = normalizeReminderSettings(settingsValue);
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function zonedParts(date: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.get("year")),
    month: Number(byType.get("month")),
    day: Number(byType.get("day")),
    hour: Number(byType.get("hour")),
    minute: Number(byType.get("minute")),
    second: Number(byType.get("second")),
  };
}

function localPartsToUtc(parts: LocalParts, timezone: string): Date {
  const desiredAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let candidate = desiredAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = zonedParts(new Date(candidate), timezone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const delta = desiredAsUtc - observedAsUtc;
    candidate += delta;
    if (delta === 0) break;
  }
  return new Date(candidate);
}

function addCalendarDays(parts: Pick<LocalParts, "year" | "month" | "day">, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function localWeekday(parts: Pick<LocalParts, "year" | "month" | "day">): number {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

export function reminderDueAtIso(input: {
  triggerSentAtIso: string;
  offsetDays: number;
  timezone?: string;
  sendTime?: string;
  sendOnWeekends?: boolean;
}): string {
  const trigger = new Date(input.triggerSentAtIso);
  if (Number.isNaN(trigger.getTime())) throw new Error("triggerSentAtIso must be a valid ISO timestamp");
  const offsetDays = normalizeReminderOffsets([input.offsetDays])[0];
  const timezone = safeTimezone(input.timezone);
  const sendTime = safeSendTime(input.sendTime);
  const [hour, minute] = sendTime.split(":").map(Number);
  const triggerLocal = zonedParts(trigger, timezone);
  let targetDate = addCalendarDays(triggerLocal, offsetDays);
  if (input.sendOnWeekends !== true) {
    while ([0, 6].includes(localWeekday(targetDate))) {
      targetDate = addCalendarDays(targetDate, 1);
    }
  }
  return localPartsToUtc({ ...targetDate, hour, minute, second: 0 }, timezone).toISOString();
}

export function selectLatestDueOccurrence(
  occurrences: readonly ReminderOccurrenceLike[],
  nowIso: string,
): { selected: ReminderOccurrenceLike | null; superseded: ReminderOccurrenceLike[] } {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) throw new Error("nowIso must be a valid ISO timestamp");
  const due = occurrences
    .filter((row) => row.status === "scheduled" && Date.parse(row.dueAtIso) <= now)
    .sort((left, right) => (
      Date.parse(left.dueAtIso) - Date.parse(right.dueAtIso)
      || left.offsetDays - right.offsetDays
      || left.id.localeCompare(right.id)
    ));
  const selected = due.at(-1) ?? null;
  return {
    selected,
    superseded: selected ? due.slice(0, -1) : [],
  };
}

function stableId(prefix: string, seed: string): string {
  return `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 40)}`;
}

export function reminderTargetId(input: {
  programId: string;
  identityKey: string;
  triggerMailResultRef: string;
}): string {
  return stableId("scp_vsr_target", [input.programId, input.identityKey, input.triggerMailResultRef].join("\u0000"));
}

export function reminderOccurrenceId(
  targetId: string,
  secondMailVersion: number,
  offsetDays: number,
): string {
  return stableId("scp_vsr_occ", [targetId, secondMailVersion, offsetDays].join("\u0000"));
}

export function reconcileReminderOffsets(input: {
  previousOffsets: unknown;
  nextOffsets: unknown;
  sentOffsets: unknown;
  triggerSentAtIso: string;
  nowIso: string;
  settings: VideoReminderSettings;
}): {
  preserveSent: number[];
  cancelFuture: number[];
  addFuture: number[];
  activeOffsets: number[];
} {
  const previous = normalizeReminderOffsets(input.previousOffsets);
  const next = normalizeReminderOffsets(input.nextOffsets);
  const sent = normalizeReminderOffsets(input.sentOffsets);
  const sentSet = new Set(sent);
  const nextSet = new Set(next);
  const now = Date.parse(input.nowIso);
  const future = (offset: number) => Date.parse(reminderDueAtIso({
    triggerSentAtIso: input.triggerSentAtIso,
    offsetDays: offset,
    timezone: input.settings.timezone,
    sendTime: input.settings.sendTime,
    sendOnWeekends: input.settings.sendOnWeekends,
  })) > now;
  const cancelFuture = previous.filter((offset) => !sentSet.has(offset) && !nextSet.has(offset) && future(offset));
  const previousSet = new Set(previous);
  const addFuture = next.filter((offset) => !sentSet.has(offset) && !previousSet.has(offset) && future(offset));
  return {
    preserveSent: sent,
    cancelFuture,
    addFuture,
    activeOffsets: [...new Set([...sent, ...next.filter((offset) => future(offset))])].sort((a, b) => a - b),
  };
}
