// Operator callables for the Flu Manage application-management surface (spec B §3.3-3.5, §7).
// These are the endpoints the Flu Manage UI invokes for the Manage inbox + manual assignment/
// reassignment (UI-completeness rule). RBAC: manager+ enforced server-side. Composes the
// applicationManagementStore (which composes the pure attribution core). No raw PII in/out.

import {
  asRecord,
  asString,
  assertNonGuestAuth,
  makeBehaviorLog,
  type CallableRequestShape,
  type Role,
} from "./shared";
import {
  assignApplicationManagementRecord,
  computeApplicationManagementKpi,
  listManageInboxRecords,
  listScpCreatorDirectoryRecords,
  type ManageInboxRecordsFilter,
} from "./applicationManagementStore";
import { evaluateContentSubmissionEligibility } from "./contentEligibilityStore";
import { AttributionLedgerError } from "./applicationManagementAttributionCore";
import { enqueueOnboardingForManagedApplication } from "./onboardingOutboxStore";
import { APPROVAL_ONBOARDING_SEND_GENERATION } from "./scpApprovalOnboarding";

const OPERATOR_ROLES: readonly Exclude<Role, "guest">[] = ["super_admin", "admin", "manager"];

function integerField(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) ? n : NaN;
}

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode: "invalid_argument_unauthorized" });
}

// 2026-09-17 [헤세 · 콘텐츠 검수 인박스]: filter 는 선택값이고 기본값은 기존 동작(manage_inbox)
// 그대로다 — /flu/manage/applications 등 기존 호출부는 파라미터를 안 보내므로 영향이 없다.
function manageInboxFilter(value: unknown): ManageInboxRecordsFilter {
  return value === "qualification_human_review" ? "qualification_human_review" : "manage_inbox";
}

export async function listApplicationManageInboxHandler(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "application_management.inbox.list", OPERATOR_ROLES);
  const data = asRecord(request.data);
  const limit = integerField(data.limit);
  const inbox = await listManageInboxRecords(
    Number.isInteger(limit) && limit > 0 ? limit : 100,
    manageInboxFilter(data.filter),
  );
  return { inbox, behaviorLog: makeBehaviorLog(auth, "application_management.inbox.list", "success") };
}

export async function assignApplicationManagementHandler(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "application_management.assign", OPERATOR_ROLES);
  const data = asRecord(request.data);
  const applicationId = asString(data.applicationId);
  const reason = asString(data.reason);
  const expectedRevision = integerField(data.expectedRevision);
  if (!applicationId) throw invalidArgument("applicationId is required");
  if (!reason) throw invalidArgument("reason is required");
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw invalidArgument("expectedRevision is required");
  }
  // Throws AttributionLedgerError (revision_conflict / revoked) or not-found — diagnosable, fail-closed.
  try {
    const result = await assignApplicationManagementRecord({
      applicationId,
      programId: asString(data.programId) || null,
      campaignId: asString(data.campaignId) || null,
      actor: auth.userId,
      reason,
      expectedRevision,
    }, new Date());
    return { ...result, behaviorLog: makeBehaviorLog(auth, "application_management.assign", "success") };
  } catch (error) {
    if (error instanceof AttributionLedgerError) {
      // §9.2 diagnosable/fail-closed: a stale optimistic-revision or a revoked ledger must NOT collapse
      // to permission-denied at the client. Map to failed-precondition + a stable, allowlisted errorCode.
      const errorCode = error.code === "revoked"
        ? "application_management_revoked"
        : "application_management_revision_conflict";
      throw Object.assign(new Error(`failed-precondition: ${errorCode}`), { code: "failed-precondition", errorCode });
    }
    throw error;
  }
}

export async function applicationManagementKpiHandler(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "application_management.kpi", OPERATOR_ROLES);
  const kpi = await computeApplicationManagementKpi();
  return { kpi, behaviorLog: makeBehaviorLog(auth, "application_management.kpi", "success") };
}

// W91 [헤세 · 크리에이터 탭] P0: Flu 가 이미 가진 데이터(scp_application_management +
// scp_portal_creator_bindings)만으로 만든 읽기 전용 디렉터리. Portal API 호출도, 실행 액션도 없다
// — 실행은 화면에서 Portal 딥링크로 보낸다.
export async function listScpCreatorDirectoryHandler(request: CallableRequestShape) {
  // 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate): NOT gated by
  // assertScpEntitled — this read-only directory is also the fallback source for the
  // general-purpose Partners page (src/app/(app)/flu/partners/page.tsx's GrowthPartnersPanel,
  // reachable by every org regardless of scp mailbox entitlement), not exclusive to the /flu/scp
  // creators tab. OPERATOR_ROLES (manager+) remains the only gate here.
  const auth = assertNonGuestAuth(request, "application_management.creator_directory.list", OPERATOR_ROLES);
  const data = asRecord(request.data);
  const limit = integerField(data.limit);
  const { rows, scanned, truncated } = await listScpCreatorDirectoryRecords(
    Number.isInteger(limit) && limit > 0 ? limit : 100,
  );
  return {
    rows,
    scanned,
    truncated,
    generatedAtIso: new Date().toISOString(),
    behaviorLog: makeBehaviorLog(auth, "application_management.creator_directory.list", "success"),
  };
}

// F4 content-submission eligibility (spec C / §5). UID/OAuth never inputs; eligibility ≠ approval.
export async function evaluateContentEligibilityHandler(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "content_eligibility.evaluate", OPERATOR_ROLES);
  const data = asRecord(request.data);
  const applicationId = asString(data.applicationId);
  if (!applicationId) throw invalidArgument("applicationId is required");
  const grant = asRecord(data.contentGrant);
  const hasGrant = grant.signed !== undefined || grant.unexpired !== undefined || grant.unrevoked !== undefined;
  const result = await evaluateContentSubmissionEligibility({
    applicationId,
    contentGrant: hasGrant
      ? { signed: grant.signed === true, unexpired: grant.unexpired === true, unrevoked: grant.unrevoked === true }
      : null,
    declaredPrimaryAudienceCountry: asString(data.declaredPrimaryAudienceCountry) || null,
    bindingAcknowledged: data.bindingAcknowledged === true,
  });
  return { ...result, behaviorLog: makeBehaviorLog(auth, "content_eligibility.evaluate", "success") };
}

// F3 onboarding test-send (spec D.3): managed-gated ENQUEUE only (draft-only, fail-closed). The real
// provider render/send via prepareScpResultMail stays gated until staging + provider binding + attestation.
export async function sendOnboardingTestHandler(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "onboarding.test_send", OPERATOR_ROLES);
  const data = asRecord(request.data);
  const applicationId = asString(data.applicationId);
  if (!applicationId) throw invalidArgument("applicationId is required");
  const result = await enqueueOnboardingForManagedApplication(
    {
      applicationId,
      campaignOverrideTemplateRef: asString(data.campaignOverrideTemplateRef) || null,
      programDefaultTemplateRef: asString(data.programDefaultTemplateRef) || null,
      globalDefaultTemplateRef: asString(data.globalDefaultTemplateRef) || "templates/onboarding-default",
      sendGeneration: 0,
      // 양방향 가드: 승인 세대(gen 1)가 이미 큐/발송돼 있으면 테스트 발송을 거부한다 —
      // 드레인은 세대 간 dedupe 없이 [queued,failed] 를 한 패스에 집으므로, 여기서 막지
      // 않으면 "배정 → 승인 큐잉 → 배너의 테스트 발송 클릭" 정규 UI 플로우가 동일
      // 수신자에게 실메일 2통을 만든다(4차 리뷰 HIGH).
      guardAgainstGeneration: APPROVAL_ONBOARDING_SEND_GENERATION,
    },
    new Date(),
  );
  return { ...result, behaviorLog: makeBehaviorLog(auth, "onboarding.test_send", result.enqueued ? "success" : "denied") };
}
