"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { fluNavKeyForPath, isFluOptInTabPath, isFluScpGatedTabPath, isFluTabPathDenied } from "@/lib/nav";
import { useIsActiveOrgScopeConfirmed, useNavPreset, useOrgContext } from "@/lib/useNavPreset";

/**
 * Flu/Task-42 HIGH-1 (2026-09-10 adversarial review) — direct-URL access-denied guard for the
 * per-org Flu tab preset (functions/orgTabPresets.ts). Mirrors AdminGate's shape (a redirect
 * effect keyed off resolved state), but fails OPEN instead of closed: while navPreset is
 * unresolved/null, or the path matches no FLU_NAV key, children render unchanged — no hidden
 * loading state here, since Growth/no-preset orgs must see zero behavior change, including
 * render timing (see isFluTabPathDenied in src/lib/nav.ts for the actual decision + its tests).
 * Each tab's own callables keep validating server-side access independently either way — this
 * only blocks the client route, it opens no new server data path.
 */
export function FluTabGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const navPreset = useNavPreset();
  const orgContext = useOrgContext();
  // 2026-09-27 적대 리뷰 HIGH (round 3, codex) — org-context-cache.ts의 세션 영속화 때문에
  // navPreset이 하드 리로드 첫 렌더부터 "만료됐지만 아직 낙관적으로 보여지는" 값일 수 있다. 그
  // 사이 관리자가 이 경로를 허용했다면, 재검증이 끝나기 전에 이 낡은 값으로 리다이렉트해버리면
  // 정당한 접근을 거부하는 회귀다(하드 리로드로의 리다이렉트는 되돌릴 수 없는 파괴적 동작이라
  // Sidebar의 낙관적 표시와는 위험도가 다르다). isActiveScopeConfirmed가 false인 동안은 절대
  // deny 판단을 내리지 않는다 — 신선한 캐시 적중이면 마이크로태스크 안에 true가 되므로 체감
  // 지연은 없고, 진짜 만료/최초 로드면 기존과 동일하게 실제 응답을 기다린다(회귀 없음).
  const isActiveScopeConfirmed = useIsActiveOrgScopeConfirmed();
  const optInPath = isFluOptInTabPath(pathname);
  // 2026-09-27 security fix: scp explicit-grant entitlement (getMyOrgContext.scpAccessGranted) —
  // a route registered with requiresScpAccess (currently only "scp", i.e. /flu/scp and its
  // /flu/review·/flu/automation compat redirects) must deny a caller whose orgContext resolves
  // scpAccessGranted !== true, the same source src/app/(app)/chat/page.tsx already gates its
  // "미답장" tab on. Treated exactly like the opt-in-path case below: fails CLOSED while
  // unresolved (orgContext === null), never open.
  const scpGatedPath = isFluScpGatedTabPath(pathname);
  const navKey = fluNavKeyForPath(pathname);
  const optInDenied = optInPath && orgContext !== null && (!navKey || !navPreset?.includes(navKey));
  const scpGatedDenied = scpGatedPath && orgContext !== null && orgContext.scpAccessGranted !== true;
  const denied = isActiveScopeConfirmed && (
    isFluTabPathDenied(pathname, navPreset)
    || optInDenied
    || scpGatedDenied
  );

  useEffect(() => {
    if (denied) router.replace("/access-denied");
  }, [denied, router]);

  // 2026-09-27 적대 리뷰 HIGH (round 5, codex, 최종 병합 게이트) — orgContext는 만료된 캐시로도
  // 하드 리로드 첫 렌더부터 non-null일 수 있다(세션 영속화). opt-in 경로는 "orgContext만 있으면
  // 그린다"였는데, 그러면 서버가 이미 회수한 탭이라도 재검증(=isActiveScopeConfirmed)이 끝나기
  // 전에 children이 렌더돼 화면 셸이 잠깐 노출될 수 있었다(denied 판단 자체는 이미 게이트돼
  // 있었지만, 리다이렉트 effect가 돌기 전까지 이 화면이 먼저 그려진다). opt-in 경로는 "확인
  // 안 됨"도 orgContext===null과 동일하게 취급해 로딩 상태를 유지한다 — 비-opt-in 경로는 기존과
  // 동일하게(Growth 조직 무변화 계약) 전혀 건드리지 않는다. scp-gated 경로도 같은 위험(파괴적
  // 리다이렉트)이라 동일한 로딩 상태를 공유한다.
  if ((optInPath || scpGatedPath) && (orgContext === null || !isActiveScopeConfirmed)) {
    return <div role="status" className="p-6 text-sm text-muted">권한을 확인하고 있습니다.</div>;
  }

  // 2026-09-27 security fix (fix/scp-surface-gate, codex adversarial review): a confirmed-denied
  // opt-in/scp-gated path must not render children even for the one render before the
  // router.replace effect above commits — React effects run AFTER paint, so without this, denied
  // panels (and their own data-fetching effects) briefly mount and could still fire read requests.
  // Verified against a real browser (Aside) that this gap is reachable via the /flu/review and
  // /flu/automation compat-redirect pages specifically. Only the opt-in/scp-gated branches gain
  // this — the legacy preset-only isFluTabPathDenied branch keeps its existing fail-open render
  // timing (Growth/no-preset zero-regression contract), unchanged.
  if (isActiveScopeConfirmed && (optInDenied || scpGatedDenied)) {
    return <div role="status" className="p-6 text-sm text-muted">권한을 확인하고 있습니다.</div>;
  }

  return children;
}
