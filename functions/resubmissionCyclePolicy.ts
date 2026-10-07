// Task-100 결정 #7 (별첨 B 원문 미정) — 독려 횟수·기한 표가 아직 없다. 이 파일은 그 사람 결정이
// 내려질 자리를 settings 문서로 비워 둔다: 문서가 없거나 enabled!==true 면 **사이클 원장은 그대로
// 쓰되 독려는 0건**이다(TICKET-MAP §3 "미정 확인 필요" 항목의 fail-closed 번역).
//
// deadlineDays 는 예외다 — 사이클 원장은 enabled 여부와 무관하게 항상 deadlineAtIso 를 갖는다
// (원장은 "언제까지 기다렸는가"를 기록하는 관측 축이고, "독려를 보낼지"는 별개 축이다). 그래서
// deadlineDays 에는 코드 기본값(14일, 보수적 추정 — 결정 #7 확정 전까지의 자리끼움)이 있고,
// maxNudges 는 disabled 일 때 0 으로 닫혀 독려가 물리적으로 생기지 않는다.

import { adminDb } from "./firebaseAdmin";

export const RESUBMISSION_POLICY_DOC_PATH = "settings/scp_resubmission_policy";

export type ResubmissionCyclePolicy = {
  /** 독려만 게이트한다 — 사이클 원장 적재는 이 값과 무관하다. */
  enabled: boolean;
  /** 반려 후 재제출 기한(일). 결정 #7 확정 전까지 코드 기본값 14. */
  deadlineDays: number;
  /** 최대 독려 횟수. disabled 면 항상 0. */
  maxNudges: number;
  /** 독려 간격(일). */
  nudgeIntervalDays: number;
};

const DEFAULT_DEADLINE_DAYS = 14;
const DEFAULT_NUDGE_INTERVAL_DAYS = 3;
const MAX_DEADLINE_DAYS = 90;
const MAX_NUDGES_CEILING = 10;
const MAX_NUDGE_INTERVAL_DAYS = 30;

export const RESUBMISSION_POLICY_DISABLED: ResubmissionCyclePolicy = {
  enabled: false,
  deadlineDays: DEFAULT_DEADLINE_DAYS,
  maxNudges: 0,
  nudgeIntervalDays: DEFAULT_NUDGE_INTERVAL_DAYS,
};

/** 손상값은 기본값으로 닫는다(설정 오타가 기한을 늘리거나 독려를 늘리는 방향으로 실패하지 않는다). */
function boundedPositiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  if (value < 0) return fallback;
  return Math.min(value, max);
}

export function parseResubmissionCyclePolicy(
  record: Record<string, unknown> | null | undefined,
): ResubmissionCyclePolicy {
  if (!record) return RESUBMISSION_POLICY_DISABLED;
  const deadlineDays = boundedPositiveInt(record.deadlineDays, DEFAULT_DEADLINE_DAYS, MAX_DEADLINE_DAYS) || DEFAULT_DEADLINE_DAYS;
  const nudgeIntervalDays = boundedPositiveInt(record.nudgeIntervalDays, DEFAULT_NUDGE_INTERVAL_DAYS, MAX_NUDGE_INTERVAL_DAYS) || DEFAULT_NUDGE_INTERVAL_DAYS;
  if (record.enabled !== true) {
    return { enabled: false, deadlineDays, maxNudges: 0, nudgeIntervalDays };
  }
  const maxNudges = boundedPositiveInt(record.maxNudges, 0, MAX_NUDGES_CEILING);
  return { enabled: true, deadlineDays, maxNudges, nudgeIntervalDays };
}

export async function readResubmissionCyclePolicy(
  db: FirebaseFirestore.Firestore = adminDb,
): Promise<ResubmissionCyclePolicy> {
  try {
    const [collection, docId] = RESUBMISSION_POLICY_DOC_PATH.split("/");
    const snapshot = await db.collection(collection).doc(docId).get();
    if (!snapshot.exists) return RESUBMISSION_POLICY_DISABLED;
    return parseResubmissionCyclePolicy(snapshot.data() ?? null);
  } catch {
    // 읽기 실패 = 문서 없음과 동일 취급(fail-closed).
    return RESUBMISSION_POLICY_DISABLED;
  }
}
