import type { ViewAsTarget } from "@/lib/viewAs";

export type AuthIdentity = { uid?: string | null; tenantId?: string | null } | null;

/**
 * The Firebase UID is the stable identity boundary for org context. Email alone is not enough:
 * it can be absent during auth bootstrap and it is not a durable account identity across tenants.
 */
export function orgContextAuthIdentityKey(user: AuthIdentity): string | null {
  const uid = typeof user?.uid === "string" ? user.uid.trim() : "";
  if (!uid) return null;
  const tenantId = typeof user?.tenantId === "string" ? user.tenantId.trim() : "";
  return `uid:${tenantId}:${uid}`;
}

/**
 * A cached projection is scoped by both the authenticated caller and the optional viewAs target.
 * Keeping those dimensions together prevents one signed-in person's full org context from being
 * reused after a sign-out/sign-in transition.
 */
export function orgContextCacheKey(authIdentityKey: string, viewAsTarget: ViewAsTarget | null): string {
  const targetKey = viewAsTarget ? `viewAs:${viewAsTarget.userId}:${viewAsTarget.email}` : "self";
  return `${authIdentityKey}|${targetKey}`;
}

// 2026-09-27 적대 리뷰 HIGH (round 2, codex) — AuthGate(src/components/shell/AuthGate.tsx)와
// RoleProvider(src/lib/role.tsx)는 서로 다른 독립적인 subscribeAuthState 구독이다. 하드 리로드
// 직후 AuthGate가 먼저 realOk가 되어 children(결국 Sidebar/FluTabGate)을 마운트하는 순간에도
// RoleProvider의 role/authUser는 아직 초기값(guest/null)일 수 있다 — 그러면
// orgContextAuthIdentityKey(authUser)가 null이 되어 useOrgContext의 lazy initializer가
// "anonymous" 스코프를 찾고, org-context-cache.ts의 sessionStorage 하이드레이션이 있어도 캐시를
// 못 찾아 이 파일이 고치려던 플래시가 그 레이스 창에서는 여전히 남는다.
// role.tsx/AuthGate.tsx를 합쳐 이 레이스 자체를 근본적으로 없애는 건 두 파일 모두 과거 운영
// 장애 이력이 있는 민감한 경로라 이 버그 수정 범위를 넘는 별도 작업으로 남겨둔다(후속 필요). 대신
// 여기서는 훨씬 좁고 안전한 완화책만 더한다 — "이 탭에서 마지막으로 확인된 로그인 uid"를
// sessionStorage에 남겨, RoleProvider가 아직 안 따라잡았을 때 useOrgContext의 첫 렌더 낙관적
// 표시에**만** 그 힌트를 쓴다("self" 스코프만 추측 — role을 아직 모르니 super_admin 여부를
// 검증 못해 viewAs 스코프는 추측하지 않는다). 실제 fetch/유효성 판단에 쓰이는 activeScopeKey는
// 이 힌트와 무관하게 항상 라이브 role/authUser로 계산되고, 그 값이 도착하면 기존 scope-change
// effect(useNavPreset.ts)가 틀린 낙관적 값을 즉시 정정한다 — 이 힌트는 순수 UI 낙관 표시용이며
// 서버 인가 판단에는 전혀 관여하지 않는다.
const LAST_KNOWN_AUTH_IDENTITY_STORAGE_KEY = "flu.orgContext.lastAuthIdentity.v1";

export function readLastKnownAuthIdentityKey(): string | null {
  try {
    return window.sessionStorage.getItem(LAST_KNOWN_AUTH_IDENTITY_STORAGE_KEY);
  } catch {
    // 프라이빗 모드 등 storage 접근 불가 환경 — 낙관적 힌트를 못 쓸 뿐 화면은 그대로 동작한다.
    return null;
  }
}

/**
 * 로그인 확정 시 기록하고, 로그아웃(authIdentityKey === null) 시 반드시 지운다 — 지우지 않으면
 * 같은 탭에서 다른 사용자가 곧바로 로그인했을 때 그 사람의 첫 렌더가 이전 사용자의 힌트를 잠깐
 * 추측 스코프로 쓸 수 있다(둘 다 UI 표시 전용이라 데이터 유출은 아니지만, 불필요하게 넓은 창).
 */
export function writeLastKnownAuthIdentityKey(authIdentityKey: string | null): void {
  try {
    if (authIdentityKey) window.sessionStorage.setItem(LAST_KNOWN_AUTH_IDENTITY_STORAGE_KEY, authIdentityKey);
    else window.sessionStorage.removeItem(LAST_KNOWN_AUTH_IDENTITY_STORAGE_KEY);
  } catch {
    // 위와 같은 이유로 무시.
  }
}
