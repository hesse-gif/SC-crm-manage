// Flu — B2 운영 모니터링의 KST 캘린더 마감 분류 (P1, 2026-07-27).
//
// ⚠️ 이 파일은 **표시 분류 전용 순수 함수**다. 기존 정산/측정 계약을 바꾸지 않는다:
//   - `measurementEndExclusive`(= publishedAt + 168h, videoPerformanceTrackingProjection /
//     videoPerformanceObservationCore)는 정산·측정창의 의미 그대로 남는다.
//   - `eligibleViews`·닫힌 측정창의 금액/조회수 불변식도 그대로다.
//   - 여기서 만드는 값은 `운영 중 | 정산 완료` 화면 분류와 `cutoffAtIso` 표시뿐이다.
//
// 공식(사용자 확정): 측정 마감 = 제출일(KST) + 7일인 날짜의 23:59:59.999 KST.
// 그 다음 날 00:00:00.000 KST(= D+8)부터 `정산 완료`로 이동한다. 실제 경과 시간은 약 191시간이
// 될 수 있고, 그것이 의도다(시간 가산이 아니라 캘린더 날짜 기준).
//
// 제출 시각 정본은 호출자가 넘긴다(제출/ingress 원장). `updatedAtIso`·승인 시각·게시 시각을
// 대체값으로 쓰지 않는다. 값이 없거나 파싱 실패면 `active`/`settled` 로 추측하지 않고
// `unclassified`(분류 불가)로 둔다.

/** KST 는 UTC+09:00 고정 오프셋이다(대한민국은 1988년 이후 서머타임 없음). */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MEASUREMENT_CALENDAR_DAYS = 7;

export type OperationsBucket = "active" | "settled" | "unclassified";

export interface KstSettlementWindow {
  /** 입력으로 받은 제출 시각(정규화된 ISO instant). 분류 불가면 null. */
  readonly submittedAtIso: string | null;
  /** D+7 23:59:59.999 KST 의 instant. 분류 불가면 null. */
  readonly cutoffAtIso: string | null;
  /** D+8 00:00:00.000 KST 의 instant(= cutoff + 1ms). 분류 불가면 null. */
  readonly settledFromIso: string | null;
  readonly bucket: OperationsBucket;
}

const UNCLASSIFIED: KstSettlementWindow = {
  submittedAtIso: null,
  cutoffAtIso: null,
  settledFromIso: null,
  bucket: "unclassified",
};

function parseInstantMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 제출 시각(instant) → KST 캘린더 마감 창.
 * @param submittedAtIso 제출/ingress 원장이 기록한 정본 제출 시각.
 * @param nowIso 분류 기준 시각. 파싱 실패면 분류 불가(현재 시각을 지어내지 않는다).
 */
export function resolveKstSettlementWindow(
  submittedAtIso: unknown,
  nowIso: unknown,
): KstSettlementWindow {
  const submittedMs = parseInstantMs(submittedAtIso);
  const nowMs = parseInstantMs(nowIso);
  if (submittedMs === null || nowMs === null) return UNCLASSIFIED;

  // 제출 instant 를 KST 벽시계로 옮겨 캘린더 날짜(Y-M-D)만 뽑는다.
  const kstWallClock = new Date(submittedMs + KST_OFFSET_MS);
  const cutoffKstWallClockMs = Date.UTC(
    kstWallClock.getUTCFullYear(),
    kstWallClock.getUTCMonth(),
    kstWallClock.getUTCDate() + MEASUREMENT_CALENDAR_DAYS,
    23,
    59,
    59,
    999,
  );
  const cutoffMs = cutoffKstWallClockMs - KST_OFFSET_MS;
  const settledFromMs = cutoffMs + 1;

  return {
    submittedAtIso: new Date(submittedMs).toISOString(),
    cutoffAtIso: new Date(cutoffMs).toISOString(),
    settledFromIso: new Date(settledFromMs).toISOString(),
    bucket: nowMs < settledFromMs ? "active" : "settled",
  };
}

/** 남은 시간(ms). 마감이 지났거나 분류 불가면 null — 음수를 만들어 보여주지 않는다. */
export function remainingMsUntilSettled(
  window: KstSettlementWindow,
  nowIso: unknown,
): number | null {
  const nowMs = parseInstantMs(nowIso);
  const settledFromMs = parseInstantMs(window.settledFromIso);
  if (nowMs === null || settledFromMs === null) return null;
  const remaining = settledFromMs - nowMs;
  return remaining > 0 ? remaining : null;
}

/** `2026-07-28` 처럼 KST 캘린더 날짜만. 분류 불가면 null. */
export function kstCalendarDate(instantIso: unknown): string | null {
  const ms = parseInstantMs(instantIso);
  if (ms === null) return null;
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 하루 경계 계산용 상수 — 소비자가 매직 넘버를 다시 만들지 않도록 함께 노출한다. */
export const KST_SETTLEMENT_CONSTANTS = {
  KST_OFFSET_MS,
  DAY_MS,
  MEASUREMENT_CALENDAR_DAYS,
} as const;
