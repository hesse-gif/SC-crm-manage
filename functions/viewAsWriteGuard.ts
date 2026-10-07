/**
 * Flu/Task-50 적대 리뷰 P1 — 쓰기 콜러블에 viewAsUserId가 섞여 들어오면 즉시 거부하는 공통
 * 게이트. functions/index.ts의 callable() 래퍼가 모든 콜러블 호출 직전에(핸들러 자체를 부르기
 * 전에) 이 함수를 부른다 — sendEmail/markConversationRead/setUserPreference 등 수백 개 쓰기
 * 콜러블마다 따로 방어 코드를 넣지 않고 한 곳에서 강제한다("대신 보기"는 읽기 전용 프리뷰다 —
 * functions/mailAccountCallables.ts resolveViewAsTarget/getMyOrgContext 주석 참조).
 *
 * viewAsUserId/viewAsEmail을 실제로 검증·소비하는 읽기 콜러블만 화이트리스트로 통과한다 — 그
 * 외에는(쓰기든, viewAs를 아직 지원하지 않는 읽기든) payload에 viewAsUserId가 있으면 무조건
 * 거부한다. 화이트리스트 이름은 각 핸들러 함수의 선언 이름(handler.name)과 정확히 같아야 한다 —
 * functions/index.ts는 `export const X = callable(XHandler, ...)`처럼 원본 함수를 alias로
 * import하므로 `.name`은 alias가 아니라 원본 선언 이름(예: "getMyOrgContext")을 유지한다.
 *
 * functions/authTenantBoundary.ts와 같은 이유로 별도 파일에 둔다 — index.ts를 통째로 import하지
 * 않고 이 순수 함수만 에뮬레이터 없이 유닛테스트할 수 있다(tests/view-as-write-guard.test.mjs).
 *
 * Flu/Task-50 재리뷰: 이 함수는 behaviorLog를 붙이지 않는다(request 전체가 아니라 callableName+
 * data만 받으므로 감사 로그에 필요한 uid/role/team/ip가 없다) — functions/index.ts의 callable()
 * catch 블록이 errorCode==="view_as_write_forbidden"을 보고 makeDeniedBehaviorLog(shapedRequest,
 * `viewAs.writeDenied(${handler.name})`)로 합성해 붙인다.
 */
const VIEW_AS_READ_ALLOWLIST = new Set([
  "getMyOrgContext",
  "listConversations",
  "listConversationMessages",
  "getMessageSource",
  "listCandidates",
  "listCandidateReplyPartners",
  "listPrograms",
  "listCampaigns",
  "listProgramApplications",
  // 2026-09-27 codex adversarial review round 2 FAIL-5: getSettings' scp-field masking must
  // reflect a viewAs target's real entitlement (functions/settings.ts's callerScpEntitled calls
  // resolveViewAsTarget itself, same verification every other entry here uses).
  "getSettings",
  // Perf/cost 2026-09-24: batches getMyOrgContext + listPrograms + getSettings (all already
  // above) alongside 2 viewAs-blind reads (functions/appBootstrap.ts forwards viewAsUserId/
  // viewAsEmail only to those three nested handlers, which already verify it themselves).
  "getAppBootstrap",
  // 2026-09-28 codex adversarial review round 2 (finding #3): the conversations lane resolves and
  // verifies viewAsUserId/viewAsEmail itself (functions/dashboardPipelineProjection.ts
  // resolveViewAsTarget) — a super_admin's viewAs preview of a restricted member must see that
  // member's real, narrower scp scope, not the caller's own super_admin bypass.
  "getDashboardPipelineProjection",
  // Casebook P1 (2026-09-28, codex adversarial review round 3 P0): getChatAutoCasePermitStatus's
  // replyText field now also resolves effectiveConversationAuth before its (optional,
  // never-throwing) entitlement check — same reasoning as the two above. The rest of the status
  // row (state/counters/eval/pins) predates this and stays exposed at the existing bar
  // regardless of viewAs.
  "getChatAutoCasePermitStatus",
  // case-backlog-send round 2 (2026-09-28, codex 적대 리뷰): "보류 N건" count must scope to the
  // EFFECTIVE viewer's scp entitlement, not just the real caller's — resolveViewAsTarget +
  // assertScpEntitled in chatAutoCaseBacklogSend.ts.
  "getChatAutoCaseHeldBacklogCount",
  // Flu conversation org-filter round 6 (codex adversarial review round 6, finding #4): the
  // receipts page's outbox listing must show the TARGET's scp scope during viewAs, not the real
  // super_admin's own unrestricted bypass — functions/mailSignature.ts listMailOutbox now calls
  // resolveViewAsTarget itself (same pattern as every other entry above). Its mutation-capable
  // sibling, reconcileMailOutboxReplies, is deliberately NOT added here — viewAs stays read-only.
  "listMailOutbox",
  // 2026-09-27 codex adversarial review round 3 FAIL-10: a super_admin "대신 보기" (viewAs) a
  // non-granted person must have getDataset's scp-key gate (scpMailTemplates/scpMailResults/
  // scpQualificationRows/scpLifecycleProfiles) and listScpLifecycleProfiles' own gate evaluate the
  // TARGET's entitlement, not the super_admin's own bypass. Both handlers already call
  // effectiveConversationAuth(auth, requestData), which re-verifies the viewAs pair server-side
  // via resolveViewAsTarget before trusting it (same pattern as every other entry above) — without
  // this allowlist entry, the shared callable() wrapper rejected the payload outright
  // (invalid-argument) before the handler ever ran, silently breaking viewAs for these two reads.
  "getDataset",
  "listScpLifecycleProfiles",
  // Flu conversation org-filter round 16 (codex adversarial review round 16, finding #3): the
  // Management Journey tab's conversation-outreach reader now resolves viewAs itself
  // (functions/managementProfileTabsCallables.ts resolveEffectiveAuthContext, same
  // resolveViewAsTarget verification every other entry here uses) so a super_admin's "대신 보기"
  // preview shows the TARGET's real scp scope, not the caller's own unrestricted bypass. Listed
  // here for the same documentation/consistency reason as every other read above, though these two
  // exports (functions/index.ts manageProfileTabJourneyList/manageProfileTabEnvelopes) are built via
  // createScopedTabListCallable/createManagementTabEnvelopesCallable, which call Firebase's onCall
  // directly rather than going through this file's index.ts callable() wrapper — this guard does not
  // currently run in front of them either way (nothing to protect: both are read-only), but the
  // entry keeps this allowlist an accurate map of every viewAs-consuming read callable.
  "manageProfileTabJourneyList",
  "manageProfileTabEnvelopes",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function viewAsWriteGuardError(): Error {
  return Object.assign(new Error("invalid-argument: read-only preview"), {
    code: "invalid-argument",
    errorCode: "view_as_write_forbidden",
  });
}

/** Throws viewAsWriteGuardError() when `data` carries viewAsUserId and `callableName` is not a
 * read-only callable that actually verifies/consumes it. No-op when `data` has no viewAsUserId
 * field at all, or when the field is present but the callable is allowlisted. */
export function assertViewAsReadOnlyPayload(callableName: string, data: unknown): void {
  if (!isRecord(data)) return;
  if (!Object.prototype.hasOwnProperty.call(data, "viewAsUserId")) return;
  if (VIEW_AS_READ_ALLOWLIST.has(callableName)) return;
  throw viewAsWriteGuardError();
}
