// F-3 (AUTO-MAIL-SAFETY-DESIGN-2026-09-16.md §D): 자동 회신을 고정 지연(예: 정확히 60분) 없이
// 지터 + 영업시간 창으로 흩뿌린다. 고정 오프셋은 "봇이 보낸 메일"로 읽혀 신뢰를 깎는다는 헤세
// 요구 반영. 이 모듈은 firebase-admin 등 런타임 의존성이 전혀 없는 순수 함수만 담는다 —
// tests/auto-reply-send-window.test.mjs 가 에뮬레이터 없이 ts.transpileModule 로 직접 로드한다.

export type AutoReplyBusinessHoursKst = {
  enabled: boolean;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  weekdaysOnly: boolean;
};

export type ComputeAutoReplySendAfterInput = {
  baseIso: string;
  minDelayMinutes: number;
  jitterMaxMinutes: number;
  businessHours: AutoReplyBusinessHoursKst | null;
  // auto-reply-pacing (2026-09-17, hesse + architect review): 영업창 밖으로 미뤄질 때 쓰는
  // "몰림 방지" 균등분포 U(0, spread)의 상한(분). 생략하면 DEFAULT_BURST_SPREAD_MINUTES —
  // settings.automation.autoReplyBurstSpreadMinutes가 실제 값을 공급한다(mailProfiles.ts 배선).
  burstSpreadMinutes?: number;
  rng?: () => number;
};

export type ComputeAutoReplySendAfterResult = {
  sendAfterIso: string;
  delayMinutes: number;
  deferredToBusinessWindow: boolean;
};

const MINUTE_MS = 60_000;
const KST_OFFSET_MS = 9 * 60 * MINUTE_MS;
// 창 재탐색 상한 — weekdaysOnly=true 여도 1~2주 안에는 반드시 평일이 있다. 설정 오류로
// 무한루프에 빠지는 대신 명시적으로 실패한다.
const MAX_WINDOW_SEARCH_DAYS = 14;
// auto-reply-pacing (2026-09-17): 몰림 방지 스프레드 기본값·경계 — settings.automation.
// autoReplyBurstSpreadMinutes(기본 150, 30~360)의 방어적 클램프와 짝을 이룬다.
const DEFAULT_BURST_SPREAD_MINUTES = 150;
const MIN_BURST_SPREAD_MINUTES = 30;
const MAX_BURST_SPREAD_MINUTES = 360;

function clampNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function clampBurstSpreadMinutes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_BURST_SPREAD_MINUTES;
  return Math.min(MAX_BURST_SPREAD_MINUTES, Math.max(MIN_BURST_SPREAD_MINUTES, Math.round(value)));
}

function uniformMinutes(rng: () => number, minMinutes: number, maxMinutes: number): number {
  if (maxMinutes <= minMinutes) return minMinutes;
  const sample = Math.min(Math.max(rng(), 0), 1);
  return minMinutes + sample * (maxMinutes - minMinutes);
}

/** KST(UTC+9, DST 없음) 기준 그 날 00:00 을 UTC ms 로 반환한다. */
function kstDayStartUtcMs(utcMs: number): number {
  const shifted = new Date(utcMs + KST_OFFSET_MS);
  const shiftedDayStartMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return shiftedDayStartMs - KST_OFFSET_MS;
}

/** KST 기준 요일. 0=일 ... 6=토. */
function kstWeekday(utcMs: number): number {
  return new Date(utcMs + KST_OFFSET_MS).getUTCDay();
}

function isWithinBusinessWindow(utcMs: number, hours: AutoReplyBusinessHoursKst): boolean {
  const weekday = kstWeekday(utcMs);
  if (hours.weekdaysOnly && (weekday === 0 || weekday === 6)) return false;
  const dayStartUtcMs = kstDayStartUtcMs(utcMs);
  // [적대 리뷰 LOW] Math.round(...)로 분 단위 반올림하면 경계 근처 시각(예: 09:59:59.999,
  // 18:30:29.999)이 인접한 분으로 반올림돼 실제로는 창 밖인데 "창 안"으로 오판정된다. 분 단위
  // 대신 ms 단위 그대로 비교한다 — 시작 포함, 종료는 정확히 HH:MM:00.000 까지 포함.
  const msOfDay = utcMs - dayStartUtcMs;
  const startMs = (hours.startHour * 60 + hours.startMinute) * MINUTE_MS;
  const endMs = (hours.endHour * 60 + hours.endMinute) * MINUTE_MS;
  return msOfDay >= startMs && msOfDay <= endMs;
}

/**
 * auto-reply-pacing (2026-09-17, hesse + architect review) GAP fix: 발송 큐 스윕이 claim
 * 직전에 "지금"도 영업창 안인지 재검증할 때 쓰는 공개 헬퍼. isWithinBusinessWindow와 계약이
 * 다르다 — hours가 없거나 enabled:false면 창 검사 자체를 건너뛰고 항상 true(due)를 반환해,
 * businessHours 미설정/비활성 상태의 기존 동작(무제한)을 그대로 보존한다.
 */
export function isWithinAutoReplyBusinessWindow(
  nowMs: number,
  businessHours: AutoReplyBusinessHoursKst | null,
): boolean {
  if (!businessHours || !businessHours.enabled) return true;
  return isWithinBusinessWindow(nowMs, businessHours);
}

/** candidateUtcMs 이후(포함) 가장 가까운 영업창 시작 시각을 UTC ms 로 반환한다. */
function nextWindowStartUtcMs(candidateUtcMs: number, hours: AutoReplyBusinessHoursKst): number {
  const startMinuteOfDay = hours.startHour * 60 + hours.startMinute;
  const endMinuteOfDay = hours.endHour * 60 + hours.endMinute;
  let dayStartUtcMs = kstDayStartUtcMs(candidateUtcMs);
  for (let i = 0; i < MAX_WINDOW_SEARCH_DAYS; i += 1) {
    const weekday = kstWeekday(dayStartUtcMs);
    const isAllowedDay = !hours.weekdaysOnly || (weekday !== 0 && weekday !== 6);
    if (isAllowedDay) {
      const startUtcMs = dayStartUtcMs + startMinuteOfDay * MINUTE_MS;
      const endUtcMs = dayStartUtcMs + endMinuteOfDay * MINUTE_MS;
      // candidateUtcMs 가 창 시작 전이면 오늘 시작으로, 이미 창 안이면(호출부는 보통 창 밖일 때만
      // 부르지만 방어적으로) 그대로 반환한다.
      if (candidateUtcMs <= endUtcMs) return Math.max(candidateUtcMs, startUtcMs);
    }
    dayStartUtcMs += 24 * 60 * MINUTE_MS;
  }
  throw new Error("nextWindowStartUtcMs: no business day found within search bound");
}

/**
 * sendAfterIso = max(receivedAt + U(minDelay, minDelay+jitterMax)분, 다음 영업창 시작).
 * 후보 시각이 창 밖(시작 전/종료 후/주말)이면 다음 창 시작 + U(0,spread)분으로 미룬다(몰림 방지).
 * spread(분)는 input.burstSpreadMinutes(기본 DEFAULT_BURST_SPREAD_MINUTES=150, 30~360로 클램프)
 * — auto-reply-pacing(2026-09-17)에서 고정 90분을 설정 가능하게 바꿨다.
 * rng 는 [0,1) 균등분포를 기대하며 기본값은 Math.random — 테스트는 결정론적 rng 를 주입한다.
 */
export function computeAutoReplySendAfter(input: ComputeAutoReplySendAfterInput): ComputeAutoReplySendAfterResult {
  const rng = input.rng ?? Math.random;
  const parsedBaseMs = Date.parse(input.baseIso);
  const baseMs = Number.isFinite(parsedBaseMs) ? parsedBaseMs : Date.now();
  const minDelayMinutes = clampNonNegative(input.minDelayMinutes);
  const jitterMaxMinutes = clampNonNegative(input.jitterMaxMinutes);
  const floorMs = baseMs + minDelayMinutes * MINUTE_MS;

  const jitteredDelayMinutes = uniformMinutes(rng, minDelayMinutes, minDelayMinutes + jitterMaxMinutes);
  let candidateMs = baseMs + jitteredDelayMinutes * MINUTE_MS;

  const hours = input.businessHours;
  let deferredToBusinessWindow = false;
  if (hours && hours.enabled && !isWithinBusinessWindow(candidateMs, hours)) {
    const windowStartMs = nextWindowStartUtcMs(candidateMs, hours);
    const spreadMinutes = clampBurstSpreadMinutes(input.burstSpreadMinutes);
    const burstAvoidanceMinutes = uniformMinutes(rng, 0, spreadMinutes);
    candidateMs = windowStartMs + burstAvoidanceMinutes * MINUTE_MS;
    deferredToBusinessWindow = true;
  }

  // baseIso + minDelay 보다 이른 시각은 절대 반환하지 않는다(방어적 하한).
  const finalMs = Math.max(candidateMs, floorMs);
  return {
    sendAfterIso: new Date(finalMs).toISOString(),
    delayMinutes: Math.round((finalMs - baseMs) / MINUTE_MS),
    deferredToBusinessWindow,
  };
}
