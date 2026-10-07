// 영상 성과 화면 공용 포맷터 — 정수 문자열(UIntString/MoneyMinorString) 표시 변환만 담당한다.
// 절대 부동소수점 합산을 하지 않는다(spec §1.2: "금액과 조회수는 정수 문자열과 BigInt로 계산").
import type { CountryEvidenceState, MeasurementState, SettlementDisplayState, TrackingState } from "@/lib/videoPerformanceData";

export function formatViews(value: string | undefined | null): string {
  if (value == null || value === "") return "—";
  try {
    return BigInt(value).toLocaleString("ko-KR");
  } catch {
    return "—";
  }
}

// BigInt-safe 합산 — 여러 MoneyMinorString(옵션) 값을 부동소수점 없이 더한다(spec §1.2). 값이 전혀 없으면
// null을 반환해 "0"과 "데이터 없음"을 혼용하지 않는다.
export function sumMoneyMinor(values: (string | undefined | null)[]): string | null {
  let total: bigint | null = null;
  for (const value of values) {
    if (value == null || value === "") continue;
    try {
      const parsed = BigInt(value);
      total = (total ?? 0n) + parsed;
    } catch {
      // 파싱 불가 값은 무시 — 표시 실패보다 부분 합산을 우선한다.
    }
  }
  return total == null ? null : total.toString();
}

// BigInt-safe 뺄셈(제외 조회수 = 전체 - 인정 등) — 음수 방지를 위해 하한 0을 보장한다.
export function subtractViews(minuend: string | undefined | null, subtrahend: string | undefined | null): string | null {
  if (minuend == null || minuend === "") return null;
  try {
    const a = BigInt(minuend);
    const b = subtrahend == null || subtrahend === "" ? 0n : BigInt(subtrahend);
    const diff = a - b;
    return (diff < 0n ? 0n : diff).toString();
  } catch {
    return null;
  }
}

export function formatSignedDelta(value: string | undefined | null): string {
  if (value == null || value === "") return "—";
  try {
    const n = BigInt(value);
    return `${n >= 0n ? "+" : ""}${n.toLocaleString("ko-KR")}`;
  } catch {
    return "—";
  }
}

// USD cents(MoneyMinorString) → `$1,234.56`. 절대 값이 없으면(추정/확정 전) `—`를 반환한다 — 0과 혼용하지 않는다.
export function formatUsdMinor(value: string | undefined | null): string {
  if (value == null || value === "") return "—";
  try {
    const cents = BigInt(value);
    const negative = cents < 0n;
    const abs = negative ? -cents : cents;
    const dollars = abs / 100n;
    const remainder = (abs % 100n).toString().padStart(2, "0");
    return `${negative ? "-" : ""}$${dollars.toLocaleString("ko-KR")}.${remainder}`;
  } catch {
    return "—";
  }
}

export const TRACKING_STATE_LABEL: Record<TrackingState, string> = {
  not_eligible: "추적 대상 아님",
  registration_pending: "등록 대기",
  active: "추적 중",
  stale: "지연(stale)",
  source_diverged: "소스 불일치",
  temporarily_failed: "일시 실패",
  unavailable: "수집 불가",
  cutoff_reached: "마감 완료",
  retired_superseded: "교체됨(제외)",
  retired_withdrawn: "철회됨(제외)",
};

export const SETTLEMENT_STATE_LABEL: Record<SettlementDisplayState, string> = {
  not_eligible: "정산 대상 아님",
  estimated: "예상",
  measurement_pending: "마감 대기",
  country_verification_pending: "국가 검증 대기",
  calculation_ready: "계산 완료",
  delivery_pending: "전달 대기",
  portal_review: "Portal 검토 중",
  portal_confirmed: "정산 확정",
  payable: "지급 가능",
  paid: "지급 완료",
  disputed: "분쟁",
  adjustment_required: "조정 필요",
  void: "무효",
};

export type BadgeTone = "neutral" | "info" | "accent" | "warn" | "ai" | "ok" | "danger";

export function trackingStateTone(state: TrackingState): BadgeTone {
  if (state === "active" || state === "registration_pending") return "info";
  if (state === "cutoff_reached") return "warn";
  if (state === "stale" || state === "source_diverged" || state === "temporarily_failed" || state === "unavailable") return "danger";
  if (state === "retired_superseded" || state === "retired_withdrawn" || state === "not_eligible") return "neutral";
  return "neutral";
}

export function settlementStateTone(state: SettlementDisplayState): BadgeTone {
  if (state === "portal_confirmed") return "accent";
  if (state === "payable" || state === "paid") return "ok";
  if (state === "estimated" || state === "measurement_pending" || state === "country_verification_pending" || state === "delivery_pending" || state === "portal_review") return "warn";
  if (state === "disputed" || state === "adjustment_required") return "danger";
  if (state === "calculation_ready") return "ok";
  return "neutral";
}

export function formatKstDateTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function formatRemainingToCutoff(nowIso: string, measurementEndExclusiveIso: string): string {
  const now = new Date(nowIso).getTime();
  const end = new Date(measurementEndExclusiveIso).getTime();
  if (Number.isNaN(now) || Number.isNaN(end)) return "—";
  if (now >= end) return "마감 완료";
  const remainingMs = end - now;
  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
  return `${hours}시간 ${minutes}분 남음`;
}


export const MEASUREMENT_STATE_LABEL: Record<MeasurementState, string> = {
  not_started: "시작 전",
  collecting: "수집 중",
  cutoff_waiting_source: "컷오프 대기",
  verification_pending: "정확성 검증 대기",
  finalized: "측정 확정",
  conflict: "측정 충돌",
  invalidated: "무효화",
};

export const COUNTRY_EVIDENCE_STATE_LABEL: Record<CountryEvidenceState, string> = {
  declared_only: "신고값만 있음",
  oauth_pending: "YouTube 연결 대기",
  collecting: "수집 중",
  verified: "YouTube 확인",
  ambiguous_tie: "동률/불명확",
  stale: "오래된 근거",
  failed: "확인 실패",
};

export function formatShortDate(iso: string | undefined | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit" });
}
