// W91 [헤세 · 크리에이터 탭] — Portal(scp-creator-portal) 딥링크 상수.
//
// Flu 는 Portal 레포·Portal API 를 절대 건드리지 않는다(P0 하드 룰). 이 모듈이 하는 일은
// **네비게이션 링크 문자열**을 만드는 것뿐이다 — 클릭하면 새 탭으로 Portal admin 화면이 열릴 뿐,
// 클라이언트가 그 서버를 직접 호출(fetch)하지 않으므로 NET-P0-012(외부 IP 직접 호출 금지) 위반이
// 아니다. 같은 base URL 이 functions/scpReceiptMailTemplates.ts 등 서버 쪽 메일 템플릿에도 이미
// 하드코딩돼 있지만, 그쪽은 클라이언트에서 import 할 수 없어 이 모듈을 새로 둔다.
export const SCP_PORTAL_BASE_URL = "https://creator.supercent.io";

export const SCP_PORTAL_ADMIN_CREATORS_PATH = "/admin/creators";

/** 포털 admin > 크리에이터 화면 딥링크. applicationId 가 있으면 지원서 탭 맥락을 함께 연다. */
export function scpPortalAdminCreatorsHref(options: { applicationId?: string | null } = {}): string {
  const url = new URL(`${SCP_PORTAL_BASE_URL}${SCP_PORTAL_ADMIN_CREATORS_PATH}`);
  if (options.applicationId) {
    url.searchParams.set("tab", "applications");
    url.searchParams.set("applicationId", options.applicationId);
  }
  return url.toString();
}
