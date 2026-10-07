// Flu/Task-37 — 승인된 SCP 크리에이터 중 Flu ingest(대시보드 스냅샷) 성공 이력이 없는 계정을
// 조회하는 admin/manager 전용 읽기 콜러블. 실행 액션 없음(읽기 전용) — 재시도/발송은 이 티켓
// 범위 밖이다.

import { asRecord, assertNonGuestAuth, makeBehaviorLog, type CallableRequestShape, type Role } from "./shared";
import { listScpApprovedCreatorsWithoutIngest } from "./scpApprovedIngestGapStore";
// 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate): see scpAutomationSettings.ts.
import { assertScpEntitled } from "./mailAccounts";

const OPERATOR_ROLES: readonly Exclude<Role, "guest">[] = ["super_admin", "admin", "manager"];

function integerField(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) ? n : Number.NaN;
}

export async function listScpApprovedWithoutIngestHandler(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_dashboard_ingest.approved_without_ingest.list", OPERATOR_ROLES);
  await assertScpEntitled(auth, request, "scp_dashboard_ingest.approved_without_ingest.list");
  const data = asRecord(request.data);
  const limitField = integerField(data.limit);
  const limit = Number.isInteger(limitField) && limitField > 0 ? limitField : 100;
  const result = await listScpApprovedCreatorsWithoutIngest(limit);
  return {
    ...result,
    behaviorLog: makeBehaviorLog(auth, "scp_dashboard_ingest.approved_without_ingest.list", "success"),
  };
}
