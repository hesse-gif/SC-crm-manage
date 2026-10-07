// Task-100 §4: 사유코드별 재제출 지표 콜러블. manager+ 전용 읽기 — 원장을 바꾸지 않는다.

import { adminDb } from "./firebaseAdmin";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape, type Role } from "./shared";
import { VIDEO_RESUBMISSION_CYCLE_COLLECTION, type ResubmissionCycleStatus } from "./videoResubmissionCycleCore";
import { computeResubmissionCycleMetrics } from "./resubmissionCycleMetrics";

const OPERATOR_ROLES: readonly Exclude<Role, "guest">[] = ["super_admin", "admin", "manager"];

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "awaiting_resubmission", "resubmitted", "passed", "failed", "churned",
]);

function isResubmissionCycleStatus(value: unknown): value is ResubmissionCycleStatus {
  return typeof value === "string" && VALID_STATUSES.has(value);
}

// 무제한 컬렉션 스캔을 막는다 — 사이클 문서는 반려 1건당 1개라 누적이 빠르다. 지표는 최근
// 창(기본 90일)만 보는 것으로 충분하고, 그 이상은 운영 리포트가 아니라 별도 백필 분석 몫이다.
const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 365;
const SCAN_LIMIT = 5000;

export async function getResubmissionCycleMetricsHandler(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "resubmission_cycle.metrics.read", OPERATOR_ROLES);
  const data = asRecord(request.data);
  const requestedWindowDays = Number(data.windowDays);
  const windowDays = Number.isInteger(requestedWindowDays) && requestedWindowDays > 0
    ? Math.min(requestedWindowDays, MAX_WINDOW_DAYS)
    : DEFAULT_WINDOW_DAYS;
  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const snapshot = await adminDb
    .collection(VIDEO_RESUBMISSION_CYCLE_COLLECTION)
    .where("rejectedAtIso", ">=", sinceIso)
    .orderBy("rejectedAtIso", "asc")
    .limit(SCAN_LIMIT)
    .get();

  const cycles = snapshot.docs
    .map((doc) => {
      const row = doc.data() ?? {};
      const status = row.status;
      if (!isResubmissionCycleStatus(status)) return null;
      return { reasonCode: asString(row.reasonCode, "other_documented"), status };
    })
    .filter((row): row is { reasonCode: string; status: ResubmissionCycleStatus } => row !== null);

  const metrics = computeResubmissionCycleMetrics(cycles);
  return {
    windowDays,
    sinceIso,
    scanned: snapshot.size,
    metrics,
    behaviorLog: makeBehaviorLog(auth, "resubmission_cycle.metrics.read", "success"),
  };
}
