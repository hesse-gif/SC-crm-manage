import type { Role } from "@/lib/data";

// F1 (2026-09-05 Aside 실측): arm/disarm/eval 세 콜러블이 전부 요구하는 역할 하한선.
// functions/chatAutoCasePermitCallables.ts 의 MUTATION_ROLES 와 같은 목록이어야 한다 —
// 어긋나면 화면은 되는 줄 알고 눌렀는데 서버가 막는(또는 그 반대) 조용한 불일치가 생긴다.
// 서버가 최종 권한이다(AUTH-P0) — 이 함수는 그 사실을 화면에 미리 알리는 순수 판정일 뿐이다.
//
// 0.6.63 빌드 수리: 이 함수는 원래 src/app/(app)/chat/auto/page.tsx 안에 있었다 — Next 15의
// 페이지 export-shape 검사가 page.tsx의 default export 외 다른 named export를 전부 거부하면서
// (`"permitManageRoleGate" is not a valid Page export field`) 프로덕션 빌드 자체가 깨졌다.
// 순수 판정 함수라 UI와 무관하므로 여기 lib로 옮기고 page.tsx는 import만 한다.
export function permitManageRoleGate(role: Role): boolean {
  return role === "super_admin" || role === "admin" || role === "manager";
}
