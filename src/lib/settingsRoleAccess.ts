import type { Role } from "@/lib/data";

/**
 * A1 (2026-09-05 Aside 실측): "아직 확인 못함(pending)"과 "확실히 거부됨(denied)"을 하나의
 * 불리언으로 뭉치면, 느린 role 로드가 거부로 오인될 수 있다 — 프로드에서 관측된 모양이 정확히
 * 이거였다(콘솔 에러 없이 ~7초간 멈췄다가 다른 화면으로 이동). `serverRole` 은 subscribeAuthState
 * 가 비동기로 채우므로 초기값 `null` 은 "권한 없음"이 아니라 "아직 모름"이다. 이 페이지는 그
 * 경계에서 어떤 경우에도 페이지를 떠나지 않는다 — pending·denied 둘 다 읽기전용 렌더로만
 * 반영하고(canEditGlobalEmergencyShutdown), 네비게이션은 이 값과 무관하다. 이 tri-state 는 그
 * 구분을 값으로 고정한다: pending 은 절대 denied 와 같은 코드로 떨어지지 않는다.
 *
 * 0.6.63 빌드 수리: 이 함수는 원래 src/app/(app)/flu/settings/page.tsx 안에 있었다 — Next 15의
 * 페이지 export-shape 검사가 page.tsx의 default export 외 다른 named export를 전부 거부하면서
 * (`"settingsRoleAccessState" is not a valid Page export field`) 프로덕션 빌드 자체가 깨졌다.
 * 순수 판정 함수라 UI와 무관하므로 여기 lib로 옮기고 page.tsx는 import만 한다.
 */
export type SettingsRoleAccessState = "pending" | "authorized" | "denied";

export function settingsRoleAccessState(serverRole: Role | null, effectiveRole: Role): SettingsRoleAccessState {
  if (serverRole === null) return "pending";
  return serverRole === "super_admin" && effectiveRole === "super_admin" ? "authorized" : "denied";
}
