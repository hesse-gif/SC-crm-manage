// Task-100 §4: 사유코드별 재제출/이탈 지표. 순수(I/O 없음) — 콜러블(resubmissionCycleCallables.ts)
// 이 video_resubmission_cycles 를 읽어 이 함수에 넘긴다. "rejected" 축은 사이클 문서 수 자체다
// (문서 1개 = 반려 1건), 나머지 축은 status 로 분류한다.

import type { ResubmissionCycleStatus } from "./videoResubmissionCycleCore";

export type ResubmissionCycleMetricsInput = {
  readonly reasonCode: string;
  readonly status: ResubmissionCycleStatus;
};

export type ReasonCodeResubmissionMetrics = {
  /** 이 사유로 반려된 사이클 총수(사이클 문서 수 자체). */
  readonly rejected: number;
  /** 재제출됨(resubmitted 이후 상태 전부 — passed·failed 도 재제출은 했으므로 포함). */
  readonly resubmitted: number;
  /** 재제출 후 최종 승인. */
  readonly passed: number;
  /** 기한 초과 + 독려 소진으로 이탈. */
  readonly churned: number;
  /** resubmitted / rejected. rejected 가 0 이면 0(분모 0 방지). */
  readonly resubmissionRate: number;
};

function emptyBucket() {
  return { rejected: 0, resubmitted: 0, passed: 0, churned: 0 };
}

/** 사이클 문서 배열 → 사유코드별 지표. 알 수 없는/빈 reasonCode 는 "other_documented" 로 모은다. */
export function computeResubmissionCycleMetrics(
  cycles: readonly ResubmissionCycleMetricsInput[],
): Readonly<Record<string, ReasonCodeResubmissionMetrics>> {
  const byReason = new Map<string, ReturnType<typeof emptyBucket>>();
  for (const cycle of cycles) {
    // Task-94 undo 로 취소된 반려는 반려가 아니다 — 분모·분자 어디에도 넣지 않는다.
    if (cycle.status === "undone") continue;
    const reasonCode = cycle.reasonCode && cycle.reasonCode.trim() ? cycle.reasonCode.trim() : "other_documented";
    const bucket = byReason.get(reasonCode) ?? emptyBucket();
    bucket.rejected += 1;
    if (cycle.status === "resubmitted" || cycle.status === "passed" || cycle.status === "failed") {
      bucket.resubmitted += 1;
    }
    if (cycle.status === "passed") bucket.passed += 1;
    if (cycle.status === "churned") bucket.churned += 1;
    byReason.set(reasonCode, bucket);
  }
  const out: Record<string, ReasonCodeResubmissionMetrics> = {};
  for (const [reasonCode, bucket] of byReason) {
    out[reasonCode] = {
      ...bucket,
      resubmissionRate: bucket.rejected > 0 ? bucket.resubmitted / bucket.rejected : 0,
    };
  }
  return out;
}
