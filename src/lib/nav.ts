// 뎁스: 런처(/) → 워크스페이스(Flu / Chat / Admin) → 사이드바 나비.
export type NavMinRole = "super_admin" | "admin" | "manager" | "viewer" | "guest";

export interface NavItem {
  key: string;
  label: string;
  href: string;
  icon: string;
  badge?: number;
  match?: string[]; // 활성 처리에 포함할 통합 하위 경로
  superAdminOnly?: boolean; // Super Admin에게만 노출
  managerPlusOnly?: boolean; // Manager 이상에게만 노출
  minRole?: NavMinRole; // 세부 최소 역할(서버 클레임 rank 기준)
  emulatorOnly?: boolean; // 로컬 검증 도구 — 호스팅 내비게이션에서 숨김
  // 2026-09-11 헤세 결정: Growth(조직 탭 프리셋이 없는 조직)에는 노출하지 않는 opt-in 탭.
  // filterNavByPreset 참고 — navPreset이 null(프리셋 없음)일 때는 제외되고, 프리셋에 이 항목의
  // key가 명시된 조직에서만 보인다. 프리셋이 있는 조직에서는 일반 항목과 동일하게 취급된다.
  optIn?: boolean;
  // 2026-09-27 security fix: scp explicit-grant entitlement gate (getMyOrgContext.
  // scpAccessGranted, functions/mailAccountCallables.ts) — orthogonal to navPreset/role. Consumers
  // (Sidebar, FluTabGate) must hide/deny this item when the caller's orgContext.scpAccessGranted
  // is not true (fail closed while orgContext is still unresolved), regardless of role or preset.
  requiresScpAccess?: boolean;
}

export type WorkspaceKey = "flu" | "chat" | "admin";

export interface Workspace {
  key: WorkspaceKey;
  label: string;
  href: string;
  desc: string;
  icon: string;
}

export const WORKSPACES: Workspace[] = [
  { key: "chat", label: "Chat", href: "/chat", desc: "AI 어시스트 커뮤니케이션", icon: "chat" },
];

export const ADMIN_WORKSPACE: Workspace = {
  key: "admin",
  label: "Admin",
  href: "/admin",
  desc: "전사 운영·권한",
  icon: "shield",
};

export const FLU_NAV: NavItem[] = [
  { key: "dashboard", label: "대시보드", href: "/flu", icon: "grid" },
  { key: "programs", label: "프로그램", href: "/flu/programs", icon: "send", match: ["/flu/campaigns"] },
  // Flu/Task-43: 캠페인 디스커버리 결과(candidate_pool/campaign_candidates)를 국가·최근 영상·
  // 평균 조회수 메타와 함께 보여주는 테이블. 후속 티켓(44 발송/독려, 45 서브뷰, 46 파트너 전환)이
  // 이 탭 위에 얹힌다.
  { key: "candidates", label: "후보", href: "/flu/candidates", icon: "userCheck", optIn: true },
  // 0.5.38 IA Override(user-approved 2026-07-19): 'SCP 자동화'는 유일한 부모 표면이다. Portal 수집,
  // Program/Campaign 귀속, 영상검수 자동화 outbox, AI 분석/중복 클러스터 판단, 재처리/상태는 전부
  // /flu/scp 안의 섹션/서브탭이다. 별도 "SCP 자동화 허브" primary tab은 없다.
  // Task-29: 콘텐츠 승인/반려 운영 표면임을 primary nav 에서도 그대로 드러낸다.
  // /flu/review는 검수 > 영상 검수로 들어가는 호환 딥링크로 match에 남아 활성 표시를 잇는다.
  { key: "scp", label: "콘텐츠 검수", href: "/flu/scp", icon: "ruler", match: ["/flu/review", "/flu/automation"], requiresScpAccess: true },
  { key: "manage", label: "관리", href: "/flu/influencers", icon: "users", match: ["/flu/manage"] },
  // 0.5.38 IA Override: '지원 관리'는 별도 primary nav가 아니다. /flu/manage/applications는
  // 관리(위 "manage" match)의 sub-tab 호환 딥링크로 남는다.
  { key: "partners", label: "파트너", href: "/flu/partners", icon: "star" },
  { key: "feed", label: "피드", href: "/flu/content", icon: "play", match: ["/flu/community"] },
  { key: "report", label: "리포트", href: "/flu/report", icon: "doc", match: ["/flu/data", "/flu/reports"] },
  { key: "settings", label: "설정", href: "/flu/settings", icon: "cog", match: ["/flu/contracts", "/flu/cost-guide"] },
];

export const CHAT_NAV: NavItem[] = [
  { key: "inbox", label: "Live feed", href: "/chat", icon: "chat" },
  { key: "auto", label: "Sequences", href: "/chat/auto", icon: "sparkles" },
  { key: "templates", label: "Email templates", href: "/chat/templates", icon: "doc" },
  { key: "receipts", label: "Outbox", href: "/chat/receipts", icon: "check" },
];

export const ADMIN_NAV: NavItem[] = [
  { key: "overview", label: "전사 현황", href: "/admin", icon: "grid" },
  { key: "members", label: "멤버·권한", href: "/admin/members", icon: "users" },
  { key: "logs", label: "행동 로그", href: "/admin/logs", icon: "doc" },
  { key: "tickets", label: "티켓", href: "/admin/tickets", icon: "chat" },
  { key: "llm", label: "LLM 모니터링", href: "/admin/llm", icon: "pulse" },
  { key: "knowledge", label: "지식 베이스", href: "/admin/knowledge", icon: "book" },
  { key: "integrations", label: "연동 설정", href: "/admin/integrations", icon: "cog", superAdminOnly: true },
];

// 141차: "컴포넌트 갤러리"(/gallery, haru-ui Storybook 대용)는 개발자용 디자인 토큰 레퍼런스라
// SCP 운영자가 쓸 일이 없어 주 내비게이션에서 제거했다. 페이지 자체는 개발 참고용으로 남긴다.
export const FOOTER_NAV: NavItem[] = [];

export function workspaceFromPath(pathname: string): WorkspaceKey {
  if (pathname.startsWith("/admin")) return "admin";
  return "chat";
}
export function navForWorkspace(ws: WorkspaceKey): NavItem[] {
  if (ws === "admin") return ADMIN_NAV;
  if (ws === "chat") return CHAT_NAV;
  return FLU_NAV;
}

// Flu/Task-42: org tab preset (functions/orgTabPresets.ts getMyOrgContext.navPreset) — a list of
// FLU_NAV `key`s the caller's org is restricted to, or null/undefined for no restriction (the
// current full tab set — Growth org and any org without an admin-set preset). UI convenience
// only; each nav item's own callables keep validating server-side access independently.
//
// 2026-09-11 헤세 결정: navPreset이 null(프리셋 없음 = Growth 기본)일 때는 opt-in 항목(optIn:
// true, 현재 "candidates")을 제외한다 — Growth는 0.6.70과 바이트 동일한 탭 집합을 유지한다.
// 프리셋이 있는 조직은 기존 로직 그대로: 프리셋에 key가 명시된 항목만(opt-in 여부 무관) 포함.
export function filterNavByPreset<T extends { key: string; optIn?: boolean }>(
  items: readonly T[],
  navPreset: readonly string[] | null | undefined,
): T[] {
  if (!navPreset) return items.filter((item) => !item.optIn);
  return items.filter((item) => navPreset.includes(item.key));
}

export function isNavActive(item: NavItem, pathname: string): boolean {
  if (item.href === "/flu" || item.href === "/chat" || item.href === "/admin") {
    return pathname === item.href || (item.match ?? []).some((m) => pathname.startsWith(m));
  }
  return [item.href, ...(item.match ?? [])].some((m) => pathname.startsWith(m));
}

// Flu/Task-42 HIGH-1 (2026-09-10 adversarial review) — pure decision function for
// src/components/shell/FluTabGate.tsx (direct-URL access-denied guard for the org tab preset).
// Extracted out of the component so the redirect decision is unit-testable directly (this
// codebase's tests/*.test.mjs import plain .ts logic, never renders a component) — see
// tests/flu-tab-gate.test.mjs. Fails OPEN (false = render, never redirect) whenever navPreset is
// null/undefined (unresolved yet, or no restriction — Growth/no-preset orgs must see zero
// behavior change) or when pathname matches no FLU_NAV key at all (a route this preset system
// doesn't know about yet). Only Flu-workspace paths are ever passed in by the gate — Chat/Admin
// are unaffected by the Flu tab preset (see Sidebar.tsx's same scoping comment).
export function isFluTabPathDenied(pathname: string, navPreset: readonly string[] | null | undefined): boolean {
  if (!navPreset) return false;
  const activeItem = FLU_NAV.find((item) => isNavActive(item, pathname));
  if (!activeItem) return false;
  return !navPreset.includes(activeItem.key);
}

/** Returns true only for a route backed by a registry item marked optIn. */
export function isFluOptInTabPath(pathname: string): boolean {
  return FLU_NAV.find((item) => isNavActive(item, pathname))?.optIn === true;
}

/** Returns true only for a route backed by a registry item marked requiresScpAccess (2026-09-27
 * security fix) — used by FluTabGate to deny direct-URL access when getMyOrgContext.
 * scpAccessGranted is not true, the same entitlement source src/app/(app)/chat/page.tsx already
 * gates its "미답장" tab on. */
export function isFluScpGatedTabPath(pathname: string): boolean {
  return FLU_NAV.find((item) => isNavActive(item, pathname))?.requiresScpAccess === true;
}

/** Registry key for a Flu route; callers must not duplicate per-tab route maps. */
export function fluNavKeyForPath(pathname: string): string | null {
  return FLU_NAV.find((item) => isNavActive(item, pathname))?.key ?? null;
}
