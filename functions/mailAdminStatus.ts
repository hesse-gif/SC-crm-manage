import { createHash } from "node:crypto";
import { FieldPath } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { readSettings } from "./settings";
import type { Settings } from "./_settings-mock";
import {
  OUTBOUND_GLOBAL_DAILY_TOTAL_CAP,
  accountAgeDaysFrom,
  effectiveDailyCap,
  readOutboundPolicy,
  readOutboundWeeklyUsage,
  totalDailyQuotaAllows,
  type OutboundPolicy,
} from "./mailOutboundSafety";
import { NUDGE_COHORT_KEYS, nudgeCohortCeilings, readNudgeSequenceConfig } from "./nudgeSequenceTemplates";

type CountState = { state: "available"; value: number; updatedAtIso?: string } | { state: "unavailable"; errorCode: string };
type InputCountState = { state: "available"; sent: number; updatedAtIso?: string } | { state: "unavailable"; errorCode: string };

type WeeklyInput = { state: "available"; used: number; cap: number } | { state: "unavailable"; errorCode: string };
type NudgeInput = { state: "available"; used: number; cap: number | null; cohortDailyCaps: Record<string, number> } | { state: "unavailable"; errorCode: string };

type ApprovedQueueSample = {
  readonly idHash: string;
  readonly campaignId: string;
  readonly programId: string;
  readonly deliveryState?: string;
  readonly approvedAtIso?: string;
  readonly sendAfterIso?: string;
};

type ApprovedQueueInput = {
  readonly count: number;
  readonly truncated: boolean;
  readonly sample: ApprovedQueueSample[];
};

export type MailAdminStatusReadModel = {
  readonly observedAtIso: string;
  readonly resets: {
    readonly kstOutreachDayResetIso: string;
    readonly utcQuotaDayResetIso: string;
    readonly utcQuotaHourResetIso: string;
    readonly utcQuotaWeekResetIso: string;
  };
  readonly coldOutreach: {
    readonly todaySent: CountState;
    readonly dailyCap: number;
    readonly rampDailyCap: number;
    readonly effectiveDailyCap: number;
    readonly remainingToday: CountState;
  };
  readonly approvedQueue: ApprovedQueueInput;
  readonly providerQuota: {
    readonly daily: { readonly cap: number; readonly sent: CountState; readonly remainingAtNextKstDay: CountState };
    readonly hourly: { readonly cap: number; readonly sent: CountState; readonly remainingAtNextKstDay: CountState };
    readonly uniqueRecipients: { readonly cap: number; readonly remainingAtNextKstDay: CountState };
    readonly weekly: { readonly cap: number; readonly used: CountState; readonly remainingAtNextKstDay: CountState };
    readonly globalDaily: { readonly cap: number; readonly sent: CountState; readonly remainingAtNextKstDay: CountState };
  };
  readonly nudge: {
    readonly totalDailyCap: number | null;
    readonly usedToday: CountState;
    readonly cohortDailyCaps: Record<string, number>;
    readonly cohortDailyCapTotal: number;
  };
  readonly configuredDailyCombinedCap: {
    readonly value: number | null;
    readonly guaranteed: false;
    readonly note: string;
  };
  readonly tomorrowPotentialUpperBound: {
    readonly value: number | null;
    readonly guaranteed: false;
    readonly note: string;
    readonly constraints: Array<{ key: string; label: string; value: number | null; state: "available" | "unavailable" }>;
  };
};

// W118 레인 킬스위치(outreachSendingEnabled/nudgeSendingEnabled) — getEmailMode(functions/admin.ts)가
// mailOutboundSafety.readOutreachSendingEnabled/readNudgeSendingEnabled 로 이미 읽은 값을 그대로
// 물려받는다. 여기서 Firestore 를 다시 읽지 않는다 — 같은 문서를 또 조회하면 레인 판정이
// getEmailMode 응답의 다른 필드와 어긋날 수 있다.
export type MailLaneFlags = {
  readonly outreachSendingEnabled: boolean;
  readonly nudgeSendingEnabled: boolean;
};

const LANES_ENABLED: MailLaneFlags = { outreachSendingEnabled: true, nudgeSendingEnabled: true };

type BuildInput = {
  readonly now: Date;
  readonly settings: Pick<Settings, "automation" | "mailSafety">;
  readonly emailSettings: Record<string, unknown>;
  readonly outboundPolicy: Pick<OutboundPolicy, "dailyCap" | "hourlyCap" | "weeklyTotalCap" | "uniqueRecipientDailyCap" | "rampUpPlan">;
  readonly coldDailyCounter: InputCountState;
  readonly globalDailyRollup: InputCountState;
  readonly hourlyRollup: InputCountState;
  readonly weeklyUsage: WeeklyInput;
  readonly nudgeTotal: NudgeInput;
  readonly approvedQueue: ApprovedQueueInput;
  /** 생략 시 두 레인 모두 켜진 것으로 취급(기존 호출부·테스트 하위호환). */
  readonly laneFlags?: MailLaneFlags;
};

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function countFromInput(input: InputCountState): CountState {
  return input.state === "available"
    ? { state: "available", value: Math.max(0, Math.round(input.sent)), ...(input.updatedAtIso ? { updatedAtIso: input.updatedAtIso } : {}) }
    : { state: "unavailable", errorCode: input.errorCode };
}

function countRemaining(cap: number, sent: CountState): CountState {
  if (sent.state === "unavailable") return sent;
  return { state: "available", value: Math.max(0, cap - sent.value), ...(sent.updatedAtIso ? { updatedAtIso: sent.updatedAtIso } : {}) };
}

function safeErrorCode(error: unknown): string {
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
  const code = stringValue(record.errorCode) || stringValue(record.code) || (error instanceof Error ? error.name : "");
  return code.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80) || "read_failed";
}

function nextUtcHour(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1, 0, 0, 0));
}

function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
}

function nextUtcWeek(now: Date): Date {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = new Date(midnight).getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const thisMonday = midnight - daysSinceMonday * 24 * 60 * 60 * 1000;
  return new Date(thisMonday + 7 * 24 * 60 * 60 * 1000);
}

function utcDayResetOnOrAfter(ms: number): Date {
  const date = new Date(ms);
  let resetMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0);
  if (resetMs < ms) resetMs += 24 * 60 * 60 * 1000;
  return new Date(resetMs);
}

function utcHourResetOnOrAfter(ms: number): Date {
  const date = new Date(ms);
  let resetMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), 0, 0, 0);
  if (resetMs < ms) resetMs += 60 * 60 * 1000;
  return new Date(resetMs);
}

function utcWeekResetOnOrAfter(ms: number): Date {
  const date = new Date(ms);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const day = new Date(midnight).getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  let resetMs = midnight - daysSinceMonday * 24 * 60 * 60 * 1000;
  if (resetMs < ms) resetMs += 7 * 24 * 60 * 60 * 1000;
  return new Date(resetMs);
}

export function kstDayKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function kstDayResetIso(now = new Date()): string {
  const key = kstDayKey(now);
  const [year, month, day] = key.split("-").map((item) => Number(item));
  return new Date(Date.UTC(year, month - 1, day + 1, -9, 0, 0, 0)).toISOString();
}

export function utcDayKey(now = new Date()): string {
  return `day_${now.toISOString().slice(0, 10)}`;
}

export function utcHourKey(now = new Date()): string {
  return `hour_${now.toISOString().slice(0, 13)}`;
}

export function utcWeekKey(now = new Date()): string {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = new Date(midnight).getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  return `week_${new Date(midnight - daysSinceMonday * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}`;
}

export function utcDayResetIso(now = new Date()): string {
  return nextUtcDay(now).toISOString();
}

export function utcHourResetIso(now = new Date()): string {
  return nextUtcHour(now).toISOString();
}

export function utcWeekResetIso(now = new Date()): string {
  return nextUtcWeek(now).toISOString();
}

function resetsBeforeTarget(now: Date) {
  const targetMs = Date.parse(kstDayResetIso(now));
  return {
    day: nextUtcDay(now).getTime() <= targetMs,
    hour: nextUtcHour(now).getTime() <= targetMs,
    week: nextUtcWeek(now).getTime() <= targetMs,
  };
}

function resetsDuringNextKstDay(now: Date) {
  const startMs = Date.parse(kstDayResetIso(now));
  const endMs = startMs + 24 * 60 * 60 * 1000;
  const dayResetMs = utcDayResetOnOrAfter(startMs).getTime();
  const hourResetMs = utcHourResetOnOrAfter(startMs).getTime();
  const weekResetMs = utcWeekResetOnOrAfter(startMs).getTime();
  return {
    day: dayResetMs >= startMs && dayResetMs < endMs,
    hour: hourResetMs >= startMs && hourResetMs < endMs,
    week: weekResetMs >= startMs && weekResetMs < endMs,
  };
}

function capacityAtNextKstReset(cap: number, used: CountState, resetBeforeTarget: boolean): CountState {
  if (resetBeforeTarget) return { state: "available", value: cap };
  return countRemaining(cap, used);
}

function capacityAcrossNextKstDay(cap: number, used: CountState, resetsDuringTarget: boolean): CountState {
  if (cap <= 0) return { state: "available", value: 0 };
  if (!resetsDuringTarget) return countRemaining(cap, used);
  if (used.state === "unavailable") return used;
  return { state: "available", value: Math.max(0, cap - used.value) + cap };
}

function configuredNudgeDailyCap(totalCap: number | null, cohortDailyCapTotal: number): number {
  return totalCap === null ? cohortDailyCapTotal : Math.min(totalCap, cohortDailyCapTotal);
}

function nudgeCapacityAcrossNextKstDay(totalCap: number | null, cohortDailyCapTotal: number, used: CountState, resetsDuringTarget: boolean): CountState {
  const configuredCap = configuredNudgeDailyCap(totalCap, cohortDailyCapTotal);
  return capacityAcrossNextKstDay(configuredCap, used, resetsDuringTarget);
}

function warmupCap(policy: Pick<OutboundPolicy, "dailyCap" | "rampUpPlan">, emailSettings: Record<string, unknown>, now: Date): number {
  const ageDays = accountAgeDaysFrom(stringValue(emailSettings.warmupStartIso), now);
  if (ageDays === null) return policy.dailyCap;
  return effectiveDailyCap({
    hourlyCap: 0,
    burstCap: 0,
    burstWindowMinutes: 0,
    uniqueRecipientDailyCap: 0,
    weeklyTotalCap: 0,
    hardBounceLockThreshold: 0,
    highVolumeEnabled: false,
    reputationStatus: "",
    jitterMinSeconds: 0,
    jitterMaxSeconds: 0,
    quotaDeferralCap: 0,
    ...policy,
  }, ageDays);
}

function availableConstraint(key: string, label: string, value: number) {
  return { key, label, value: Math.max(0, Math.round(value)), state: "available" as const };
}

// 레인이 정지 중이면 그 레인의 남은/잠재 수량은 하부 카운터 상태와 무관하게 0이다 — 카운터가
// unavailable 이어도 "정지 중이라 0" 이 더 정확한 답이라 available:0 으로 덮어쓴다.
function clampCountWhenLaneDisabled(count: CountState, laneEnabled: boolean): CountState {
  return laneEnabled ? count : { state: "available", value: 0 };
}

function unavailableConstraint(key: string, label: string) {
  return { key, label, value: null, state: "unavailable" as const };
}

export function buildMailAdminStatusReadModel(input: BuildInput): MailAdminStatusReadModel {
  const observedAtIso = input.now.toISOString();
  const laneFlags = input.laneFlags ?? LANES_ENABLED;
  const coldDailyCap = Math.max(0, Math.round(numberValue(input.settings.automation.maxDailyOutreachSends)));
  const rampDailyCap = warmupCap(input.outboundPolicy, input.emailSettings, input.now);
  const effectiveColdDailyCap = Math.min(coldDailyCap, rampDailyCap);
  const coldSent = countFromInput(input.coldDailyCounter);
  // W118: 아웃리치 레인이 정지 중이면 카운터가 뭘 말하든 오늘 더 나갈 수 있는 양은 0이다.
  const coldRemaining = clampCountWhenLaneDisabled(countRemaining(effectiveColdDailyCap, coldSent), laneFlags.outreachSendingEnabled);
  const providerDailySent = countFromInput(input.globalDailyRollup);
  const hourlySent = countFromInput(input.hourlyRollup);
  const weeklyUsed: CountState = input.weeklyUsage.state === "available"
    ? { state: "available", value: Math.max(0, Math.round(input.weeklyUsage.used)) }
    : { state: "unavailable", errorCode: input.weeklyUsage.errorCode };
  const nudgeUsed: CountState = input.nudgeTotal.state === "available"
    ? { state: "available", value: Math.max(0, Math.round(input.nudgeTotal.used)) }
    : { state: "unavailable", errorCode: input.nudgeTotal.errorCode };
  const reset = resetsBeforeTarget(input.now);
  const nextKstDayReset = resetsDuringNextKstDay(input.now);
  const providerDailyRemainingAtNextKst = capacityAtNextKstReset(input.outboundPolicy.dailyCap, providerDailySent, reset.day);
  const hourlyRemainingAtNextKst = capacityAtNextKstReset(input.outboundPolicy.hourlyCap, hourlySent, reset.hour);
  const weeklyRemainingAtNextKst = input.weeklyUsage.state === "available"
    ? capacityAtNextKstReset(input.weeklyUsage.cap, weeklyUsed, reset.week)
    : weeklyUsed;
  const globalRemainingAtNextKst = capacityAtNextKstReset(OUTBOUND_GLOBAL_DAILY_TOTAL_CAP, providerDailySent, reset.day);
  const providerDailyCapacityDuringTomorrow = capacityAcrossNextKstDay(input.outboundPolicy.dailyCap, providerDailySent, nextKstDayReset.day);
  const weeklyCapacityDuringTomorrow = input.weeklyUsage.state === "available"
    ? capacityAcrossNextKstDay(input.weeklyUsage.cap, weeklyUsed, nextKstDayReset.week)
    : weeklyUsed;
  const uniqueRecipientCapacityDuringTomorrow = {
    state: "available" as const,
    value: nextKstDayReset.day ? input.outboundPolicy.uniqueRecipientDailyCap * 2 : input.outboundPolicy.uniqueRecipientDailyCap,
  };
  const uniqueRecipientRemainingAtNextKst = { state: "unavailable" as const, errorCode: "not_measured" };
  const globalCapacityDuringTomorrow = capacityAcrossNextKstDay(OUTBOUND_GLOBAL_DAILY_TOTAL_CAP, providerDailySent, nextKstDayReset.day);
  // W118: 아웃리치 레인이 정지 중이면 내일 잠재치의 콜드메일 몫도 0 — 다른 레인(독려) 몫은 그대로 둔다.
  const coldTomorrowCap = laneFlags.outreachSendingEnabled ? effectiveColdDailyCap : 0;
  const nudgeCohortDailyCaps = input.nudgeTotal.state === "available" ? input.nudgeTotal.cohortDailyCaps : {};
  const nudgeCohortDailyCapTotal = Object.values(nudgeCohortDailyCaps).reduce((sum, value) => sum + value, 0);
  const nudgeTotalCap = input.nudgeTotal.state === "available" ? input.nudgeTotal.cap : null;
  const nudgeConfiguredDailyCap = input.nudgeTotal.state === "available" ? configuredNudgeDailyCap(nudgeTotalCap, nudgeCohortDailyCapTotal) : null;
  // W118: 독려 레인이 정지 중이면 내일 잠재치의 독려 몫도 0 — 아웃리치 몫과 독립적으로 클램프한다.
  const nudgeTomorrowCapacity = input.nudgeTotal.state === "available"
    ? clampCountWhenLaneDisabled(nudgeCapacityAcrossNextKstDay(nudgeTotalCap, nudgeCohortDailyCapTotal, nudgeUsed, nextKstDayReset.day), laneFlags.nudgeSendingEnabled)
    : null;
  const constraints = [
    ...(laneFlags.outreachSendingEnabled ? [] : [availableConstraint("outreach_lane_paused", "아웃리치 레인 정지", 0)]),
    ...(laneFlags.nudgeSendingEnabled ? [] : [availableConstraint("nudge_lane_paused", "독려 레인 정지", 0)]),
    availableConstraint("approved_queue", "승인 큐", input.approvedQueue.count),
    availableConstraint("cold_daily_cap", "콜드메일 일 상한", coldDailyCap),
    availableConstraint("ramp_daily_cap", "워밍업 일 상한", rampDailyCap),
    nudgeConfiguredDailyCap === null
      ? unavailableConstraint("nudge_total_daily_cap", "독려 전체 일 상한")
      : availableConstraint("nudge_total_daily_cap", "독려 전체 일 상한", nudgeTotalCap ?? nudgeConfiguredDailyCap),
    availableConstraint("nudge_cohort_daily_cap_total", "독려 코호트 일 상한 합계", nudgeCohortDailyCapTotal),
    providerDailyCapacityDuringTomorrow.state === "available"
      ? availableConstraint("provider_daily_cap", "UTC 일일 제공자 상한", providerDailyCapacityDuringTomorrow.value)
      : unavailableConstraint("provider_daily_cap", "UTC 일일 제공자 상한"),
    hourlyRemainingAtNextKst.state === "available"
      ? availableConstraint("provider_hourly_cap", "UTC 시간당 제공자 상한", input.outboundPolicy.hourlyCap)
      : unavailableConstraint("provider_hourly_cap", "UTC 시간당 제공자 상한"),
    availableConstraint("unique_recipient_daily_cap", "고유 수신자 일 상한", uniqueRecipientCapacityDuringTomorrow.value),
    input.weeklyUsage.state === "available" && input.weeklyUsage.cap <= 0
      ? { key: "provider_weekly_cap", label: "UTC 주간 제공자 상한 없음", value: null, state: "available" as const }
      : weeklyCapacityDuringTomorrow.state === "available"
        ? availableConstraint("provider_weekly_cap", "UTC 주간 제공자 상한", weeklyCapacityDuringTomorrow.value)
      : unavailableConstraint("provider_weekly_cap", "UTC 주간 제공자 상한"),
    globalCapacityDuringTomorrow.state === "available"
      ? availableConstraint("global_daily_total_cap", "비거래성 전체 일 상한", globalCapacityDuringTomorrow.value)
      : unavailableConstraint("global_daily_total_cap", "비거래성 전체 일 상한"),
  ];
  const explanatoryConstraintKeys = new Set([
    "approved_queue",
    "cold_daily_cap",
    "ramp_daily_cap",
    "nudge_total_daily_cap",
    "nudge_cohort_daily_cap_total",
    "provider_hourly_cap",
    // 레인 정지는 이미 coldTomorrowCap/nudgeTomorrowCapacity 클램프로 capPotential 에 반영돼 있다 —
    // 여기서도 하드 min 에 넣으면 정지 안 된 레인의 잠재치까지 0으로 뭉개진다. 표시용으로만 둔다.
    "outreach_lane_paused",
    "nudge_lane_paused",
  ]);
  const configuredDailyCombinedCap = nudgeConfiguredDailyCap === null ? null : coldDailyCap + nudgeConfiguredDailyCap;
  const capPotential = nudgeTomorrowCapacity === null || nudgeTomorrowCapacity.state === "unavailable" ? null : coldTomorrowCap + nudgeTomorrowCapacity.value;
  const availableValues = constraints
    .filter((item): item is { key: string; label: string; value: number; state: "available" } => item.state === "available" && typeof item.value === "number" && !explanatoryConstraintKeys.has(item.key))
    .map((item) => item.value);
  const hasUnavailable = constraints.some((item) => item.state === "unavailable" && !explanatoryConstraintKeys.has(item.key));
  const upperBound = hasUnavailable || capPotential === null || availableValues.length === 0 ? null : Math.min(capPotential, ...availableValues);

  return {
    observedAtIso,
    resets: {
      kstOutreachDayResetIso: kstDayResetIso(input.now),
      utcQuotaDayResetIso: utcDayResetIso(input.now),
      utcQuotaHourResetIso: utcHourResetIso(input.now),
      utcQuotaWeekResetIso: utcWeekResetIso(input.now),
    },
    coldOutreach: {
      todaySent: coldSent,
      dailyCap: coldDailyCap,
      rampDailyCap,
      effectiveDailyCap: effectiveColdDailyCap,
      remainingToday: coldRemaining,
    },
    approvedQueue: input.approvedQueue,
    providerQuota: {
      daily: { cap: input.outboundPolicy.dailyCap, sent: providerDailySent, remainingAtNextKstDay: providerDailyRemainingAtNextKst },
      hourly: { cap: input.outboundPolicy.hourlyCap, sent: hourlySent, remainingAtNextKstDay: hourlyRemainingAtNextKst },
      uniqueRecipients: { cap: input.outboundPolicy.uniqueRecipientDailyCap, remainingAtNextKstDay: uniqueRecipientRemainingAtNextKst },
      weekly: {
        cap: input.weeklyUsage.state === "available" ? input.weeklyUsage.cap : input.outboundPolicy.weeklyTotalCap,
        used: weeklyUsed,
        remainingAtNextKstDay: weeklyRemainingAtNextKst,
      },
      globalDaily: { cap: OUTBOUND_GLOBAL_DAILY_TOTAL_CAP, sent: providerDailySent, remainingAtNextKstDay: globalRemainingAtNextKst },
    },
    nudge: {
      totalDailyCap: nudgeTotalCap,
      usedToday: nudgeUsed,
      cohortDailyCaps: nudgeCohortDailyCaps,
      cohortDailyCapTotal: nudgeCohortDailyCapTotal,
    },
    configuredDailyCombinedCap: {
      value: configuredDailyCombinedCap,
      guaranteed: false,
      note: "Configured daily combined cap from cold outreach plus one UTC-day of nudge capacity; resets can make the next KST-day upper bound higher.",
    },
    tomorrowPotentialUpperBound: {
      value: upperBound,
      guaranteed: false,
      note: "Conditional KST-day potential upper bound from cold outreach and nudge caps plus known quota constraints; not a guaranteed send count.",
      constraints,
    },
  };
}

async function readRollup(docId: string): Promise<InputCountState> {
  try {
    const snapshot = await adminDb.collection("mail_quota_rollups").doc(docId).get();
    const data = snapshot.data() ?? {};
    return { state: "available", sent: numberValue(data.sent), ...(stringValue(data.updatedAtIso) ? { updatedAtIso: stringValue(data.updatedAtIso) } : {}) };
  } catch (error) {
    return { state: "unavailable", errorCode: safeErrorCode(error) };
  }
}

async function readColdDailyCounter(dayKey: string): Promise<InputCountState> {
  try {
    const snapshot = await adminDb.collection("campaign_outreach_daily_counters").doc(dayKey).get();
    const data = snapshot.data() ?? {};
    return { state: "available", sent: numberValue(data.sent), ...(stringValue(data.updatedAtIso) ? { updatedAtIso: stringValue(data.updatedAtIso) } : {}) };
  } catch (error) {
    return { state: "unavailable", errorCode: safeErrorCode(error) };
  }
}

async function readNudgeTotal(now: Date): Promise<NudgeInput> {
  try {
    const config = await readNudgeSequenceConfig();
    const ceilings = nudgeCohortCeilings();
    const cohortDailyCaps = Object.fromEntries(
      NUDGE_COHORT_KEYS.map((cohort) => [cohort, config.cohorts.get(cohort)?.dailyCap ?? ceilings[cohort].dailyCap]),
    );
    const quota = await totalDailyQuotaAllows(config.totalDailyCap, now);
    return { state: "available", used: quota.used, cap: quota.cap, cohortDailyCaps };
  } catch (error) {
    return { state: "unavailable", errorCode: safeErrorCode(error) };
  }
}

async function readWeekly(now: Date): Promise<WeeklyInput> {
  try {
    const usage = await readOutboundWeeklyUsage(now);
    return { state: "available", used: usage.used, cap: usage.cap };
  } catch (error) {
    return { state: "unavailable", errorCode: safeErrorCode(error) };
  }
}

function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function readApprovedQueue(limit = 25): Promise<ApprovedQueueInput> {
  const countSnapshot = await adminDb.collection("campaign_outreach").where("deliveryState", "==", "approved").count().get();
  const count = numberValue(countSnapshot.data().count);
  const snapshot = await adminDb.collection("campaign_outreach")
    .where("deliveryState", "==", "approved")
    .orderBy("sendAfterIso", "asc")
    .orderBy(FieldPath.documentId(), "asc")
    .limit(Math.max(1, Math.min(limit, 50)))
    .get();
  const sample = snapshot.docs.map((doc) => {
    const data = doc.data() ?? {};
    return {
      idHash: hashId(doc.id),
      campaignId: stringValue(data.campaignId).slice(0, 80),
      programId: stringValue(data.programId).slice(0, 80),
      deliveryState: stringValue(data.deliveryState).slice(0, 40),
      approvedAtIso: stringValue(data.approvedAtIso).slice(0, 40),
      sendAfterIso: stringValue(data.sendAfterIso).slice(0, 40),
    };
  });
  return { count, truncated: count > sample.length, sample };
}

export async function readMailAdminStatus(now = new Date(), laneFlags: MailLaneFlags = LANES_ENABLED): Promise<MailAdminStatusReadModel> {
  const [settings, policy, emailSettingsSnapshot, coldDailyCounter, globalDailyRollup, hourlyRollup, weeklyUsage, nudgeTotal, approvedQueue] = await Promise.all([
    readSettings(),
    readOutboundPolicy(),
    adminDb.doc("settings/email").get(),
    readColdDailyCounter(kstDayKey(now)),
    readRollup(utcDayKey(now)),
    readRollup(utcHourKey(now)),
    readWeekly(now),
    readNudgeTotal(now),
    readApprovedQueue(),
  ]);
  return buildMailAdminStatusReadModel({
    now,
    settings,
    emailSettings: emailSettingsSnapshot.data() ?? {},
    outboundPolicy: policy,
    coldDailyCounter,
    globalDailyRollup,
    hourlyRollup,
    weeklyUsage,
    nudgeTotal,
    approvedQueue,
    laneFlags,
  });
}
