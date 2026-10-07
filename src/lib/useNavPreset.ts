"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getMyOrgContext, type MyOrgContextEnvelope } from "@/lib/data";
import { useAuthProfile, useAuthUser, useRole } from "@/lib/role";
import { useViewAs, type ViewAsTarget } from "@/lib/viewAs";
import {
  orgContextAuthIdentityKey,
  orgContextCacheKey,
  readLastKnownAuthIdentityKey,
  writeLastKnownAuthIdentityKey,
} from "@/lib/org-context-cache-key";
import {
  fetchOrgContextOnce as fetchCachedOrgContext,
  getStaleOrgContext,
  hasFreshOrgContextCache,
  hasScopeSettledThisPageLoad,
  invalidateOrgContextCache,
  orgContextCacheRevision,
  subscribeOrgContextInvalidation,
  subscribeOrgContextSettlement,
  ORG_CONTEXT_CACHE_TTL_MS,
} from "@/lib/org-context-cache";

// Flu/Task-42 HIGH-1 (2026-09-10 adversarial review) — Sidebar, /flu/settings, and FluTabGate
// each mount independently and previously called getMyOrgContext separately (the same read, up
// to 3x on a single app-shell mount). Module-level promise memo: the first caller in this session
// triggers the fetch, every other caller in-flight awaits the same promise instead of re-issuing
// it. On failure the memo is cleared so a later caller (e.g. a subsequent navigation) retries
// instead of the whole session being stuck on a transient error — this is a UI convenience only
// (see functions/orgTabPresets.ts's header comment), so a brief stale/retry window is fine.
// Flu/Task-46 적대 리뷰 MEDIUM-1: the memoized value is now the full envelope (still one fetch),
// so partnerDataSource consumers (파트너 탭) can read it via useOrgContext below without a second
// getMyOrgContext call.
// Flu/Task-50: keyed by viewAs target (default key "self") so switching "대신 보기" targets (or
// returning to one's own view) gets its own memoized fetch instead of colliding with — or being
// starved by — another target's in-flight/cached promise.
//
// Flu/Task-50 적대 리뷰 P1-3: the bounded cache is kept in the small standalone module so
// mutation surfaces can invalidate it without reaching into this hook's React state.
export { invalidateOrgContextCache };

/**
 * The read scope every org-context consumer shares: the caller's auth identity plus the verified
 * super_admin viewAs target (a non-super_admin's stored target is ignored here, and the server
 * re-verifies anyway — AUTH-P0-003). Extracted so mutation surfaces (useInvalidateOrgContext
 * below) can invalidate exactly the scope they are reading instead of every cached entry.
 */
function useOrgContextScope() {
  const { role } = useRole();
  const { email } = useAuthProfile();
  const authUser = useAuthUser();
  const { target: viewAsTarget } = useViewAs();
  const activeViewAsTarget = role === "super_admin" ? viewAsTarget : null;
  const authIdentityKey = orgContextAuthIdentityKey(authUser);
  const activeScopeKey = authIdentityKey
    ? orgContextCacheKey(authIdentityKey, activeViewAsTarget)
    : "anonymous";
  return { role, email, authIdentityKey, activeViewAsTarget, activeScopeKey };
}

/**
 * codex final-gate round 10 (HIGH) — the public counterpart of useOrgContextScope's own
 * activeScopeKey, for consumers that derive their OWN local state from useOrgContext() via an
 * effect (e.g. MailConnectNotice's visible/noticeMessage, computed from an async
 * getMailOAuthStatus call) rather than reading the projection directly. Those consumers have the
 * exact same render-phase flash risk useOrgContext itself had before this same round's fix: their
 * effect only corrects derived state AFTER a render commits, so a real identity/viewAs switch can
 * still paint one frame of the PREVIOUS scope's derived UI under the NEW (already-corrected, per
 * useOrgContext's own render-phase guard) orgContext. This key intentionally tracks only the
 * identity/viewAs boundary (not every field a fresh orgContext response might touch, unlike
 * authoritativeOrgContextScopeKey below) so it does not fire on an ordinary same-scope SWR
 * background revalidation — only a genuine scope change.
 */
export function useOrgContextScopeKey(): string {
  return useOrgContextScope().activeScopeKey;
}

/**
 * 2026-09-27 적대 리뷰 HIGH (round 3, codex) — 세션 영속화(org-context-cache.ts) 덕에
 * useOrgContext의 첫 렌더가 과거(만료된) 프리셋을 낙관적으로 보여줄 수 있게 됐다. Sidebar 같은
 * 표시 전용 소비자에겐 안전하지만(플래시 방지가 목적), FluTabGate 같은 **파괴적** 소비자(잘못
 * 판단하면 /access-denied 로 리다이렉트)에는 위험하다 — 그 사이 관리자가 새 탭을 허용했다면,
 * 재검증이 끝나기 전에 오래된 프리셋으로 정당한 접근을 거부해버릴 수 있다.
 * hasScopeSettledThisPageLoad는 "이번 하드 리로드 이후 이 스코프가 최소 한 번 실제로 settle
 * 됐는가"만 본다(신선한 캐시 적중도 마이크로태스크 안에 settle 되므로 체감 지연은 없다) — 이
 * 훅을 쓰는 소비자는 그 확인 전까지는 절대 거부 판단을 내리면 안 된다.
 *
 * 2026-09-27 적대 리뷰 HIGH (round 4, codex, 최종 병합 게이트) — hasScopeSettledThisPageLoad를
 * 렌더 중에 그냥 읽기만 하면(구독 없이) React가 다시 렌더할 이유를 모른다. 특히 하이드레이션된
 * 신선한 캐시 적중은 lazy initializer가 이미 정확한 값을 읽어 놨으므로, settle 시점에
 * setOrgContext(response)가 *같은 참조*를 다시 넣어 React가 리렌더를 건너뛸 수 있다 — 그러면
 * 이 값이 true로 바뀌어도 FluTabGate가 그걸 관찰할 렌더 자체가 없어, 원래 막아야 할 탭이
 * 리다이렉트 없이 계속 보일 수 있었다(반대 방향의 회귀 — client route-guard 우회). 매 settle/
 * invalidate 이벤트(org-context-cache.ts subscribeOrgContextSettlement)마다 강제로 리렌더시켜
 * 이 훅이 항상 최신 값을 반영하게 한다 — 무관한 스코프의 settle까지 구독하지만(키로 필터링하지
 * 않음) 이벤트 자체가 드물고(사용자 내비게이션 단위) 이 훅은 값 하나만 재계산하므로 비용은
 * 무시할 만하다.
 */
export function useIsActiveOrgScopeConfirmed(): boolean {
  const { activeScopeKey } = useOrgContextScope();
  const [, forceRerenderOnSettlement] = useState(0);
  useEffect(() => {
    const unsubscribe = subscribeOrgContextSettlement(() => forceRerenderOnSettlement((n) => n + 1));
    return () => unsubscribe();
  }, []);
  return hasScopeSettledThisPageLoad(activeScopeKey);
}

/**
 * Full getMyOrgContext projection (functions/mailAccountCallables.ts), shared/memoized the same
 * way useNavPreset always has been (see fetchCachedOrgContext above) — one fresh request per
 * authenticated identity and viewAs target, every mounting consumer awaits the same in-flight
 * promise. null while unresolved, and guests never fetch (no mail identity to resolve;
 * getMyOrgContext itself rejects a guest caller).
 *
 * Flu/Task-50: when a super_admin has an active "대신 보기" target (src/lib/viewAs.tsx), every
 * consumer of this hook (Sidebar, FluTabGate, Chat, 파트너 탭, /flu/settings) transparently gets
 * that target's projection instead of the caller's own — this is the single place viewAs actually
 * takes effect for reads. A non-super_admin's stored target (e.g. after a mid-session role
 * downgrade) is never sent — the server re-verifies this too (AUTH-P0-003), but the client avoids
 * the guaranteed-denied round trip and its audit noise.
 */
export function useOrgContext(): MyOrgContextEnvelope | null {
  const { role, email, authIdentityKey, activeViewAsTarget, activeScopeKey } = useOrgContextScope();
  // 2026-09-27 적대 리뷰 HIGH-1 (codex) — 이 state가 항상 null로 시작하면, 하드 리로드 뒤
  // sessionStorage에서 하이드레이션된 캐시가 있어도 첫 렌더는 여전히 orgContext===null이라 (아래
  // effect가 커밋 다음에야 getStaleOrgContext를 읽는다) Sidebar가 그 첫 프레임에 무제한 탭을,
  // FluTabGate가 "권한 확인 중"을 그린다 — org-context-cache.ts의 sessionStorage 영속화가
  // 막으려던 바로 그 플래시가 첫 렌더 한 프레임만큼 여전히 남는다. lazy initializer로 마운트
  // 시점(=하드 리로드 직후 이 훅이 처음 호출되는 시점)에 activeScopeKey(위에서 이미 role/authUser/
  // viewAs로 계산됨)로 즉시 스토어를 읽으면 첫 렌더부터 올바른 값으로 시작한다 — 캐시가 없으면
  // 기존과 동일하게 null이다(회귀 없음).
  //
  // 2026-09-27 적대 리뷰 HIGH (round 2, codex) — activeScopeKey 자체가 AuthGate/RoleProvider의
  // 독립된 구독 레이스 때문에 이 첫 호출 시점엔 아직 "anonymous"일 수 있다(authIdentityKey가
  // null). 그 경우 org-context-cache-key.ts의 낙관적 힌트(마지막으로 확인된 uid, "self" 스코프만
  // 추측 — role을 모르니 viewAs는 추측하지 않는다)로 한 번 더 시도한다. 진짜 activeScopeKey는
  // 이 초기화와 무관하게 그대로 계산되어 아래 effect들이 정정을 담당한다.
  const [orgContext, setOrgContext] = useState<MyOrgContextEnvelope | null>(() => {
    const staleForLiveScope = getStaleOrgContext(activeScopeKey);
    if (staleForLiveScope !== null) return staleForLiveScope;
    if (authIdentityKey) return null; // 실제 인증 정보가 이미 있는데 캐시가 없으면 진짜 미스다.
    const lastKnownAuthIdentityKey = readLastKnownAuthIdentityKey();
    if (!lastKnownAuthIdentityKey) return null;
    return getStaleOrgContext(orgContextCacheKey(lastKnownAuthIdentityKey, null));
  });

  // codex final-gate round 9 (HIGH) — a mounted useOrgContext consumer (e.g. Sidebar, under
  // RoleProvider) can re-render with a NEW activeScopeKey (a real A→B identity switch, via
  // RoleProvider's own separate subscribeAuthState subscription updating role/authUser through
  // context) before the scope-change effect below has run — effects only run after a render
  // commits, never during or before it. That render would return the PREVIOUS scope's (A's)
  // orgContext state under the NEW (B's) role/email — a real, paintable cross-user data flash
  // (org name, mail identity, navPreset) surviving for at least one committed frame, exactly the
  // kind of leak the sign-out/identity-switch purge in src/lib/auth.ts exists to prevent (it only
  // clears the shared cache this hook reads from — not a value already sitting in this
  // component's own React state). React's documented "adjust state during rendering" pattern
  // (calling a state setter directly in the render body, comparing against a value tracked by its
  // own useState — a ref would not trigger React's render-phase bailout/re-render machinery the
  // same way) closes this synchronously: on the render where activeScopeKey first differs,
  // orgContext is corrected to the NEW scope's own stale/cached value (or null) before that render
  // is ever committed/painted. This runs on every render, not just mount (unlike the lazy
  // initializer above, which only resolves the very first render).
  const [scopeKeyForOrgContext, setScopeKeyForOrgContext] = useState(activeScopeKey);
  if (scopeKeyForOrgContext !== activeScopeKey) {
    setScopeKeyForOrgContext(activeScopeKey);
    setOrgContext(getStaleOrgContext(activeScopeKey));
  }

  const previousScopeKeyRef = useRef<string | null>(null);
  const requestGenerationRef = useRef(0);
  const [cacheRevision, setCacheRevision] = useState(() => orgContextCacheRevision());

  useEffect(() => {
    const unsubscribe = subscribeOrgContextInvalidation(setCacheRevision);
    return () => unsubscribe();
  }, []);

  // 로그인 확정 시 기록하고 로그아웃 시 지운다(org-context-cache-key.ts 주석 참고) — 위 lazy
  // initializer가 다음 하드 리로드에서 authIdentityKey가 아직 레이스 중일 때 참고할 힌트다.
  useEffect(() => {
    writeLastKnownAuthIdentityKey(authIdentityKey);
  }, [authIdentityKey]);

  // Auth identity and viewAs are both part of the read scope. Clear the visible projection as soon
  // as either changes, evict the departed scope, and advance the generation so an old response
  // cannot publish after a sign-out/sign-in or target switch.
  useEffect(() => {
    const previousScopeKey = previousScopeKeyRef.current;
    if (previousScopeKey && previousScopeKey !== activeScopeKey) {
      invalidateOrgContextCache(previousScopeKey);
    }
    previousScopeKeyRef.current = activeScopeKey;
  }, [activeScopeKey]);

  // A routing/account mutation in another browser session cannot emit this tab's local signal.
  // Revalidate the active scope after it has aged past the bounded TTL when the tab regains focus.
  // The in-flight entry itself is considered fresh, so repeated focus events do not duplicate a
  // request or clear a newly mounted consumer before its first response arrives.
  useEffect(() => {
    if (typeof window === "undefined" || !authIdentityKey) return undefined;
    let lastFocusCheckAt = 0;
    const refreshIfStale = () => {
      const now = Date.now();
      if (now - lastFocusCheckAt < ORG_CONTEXT_CACHE_TTL_MS) return;
      lastFocusCheckAt = now;
      if (!hasFreshOrgContextCache(activeScopeKey, now)) invalidateOrgContextCache(activeScopeKey);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshIfStale();
    };
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [activeScopeKey, authIdentityKey]);

  useEffect(() => {
    const requestGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestGeneration;
    if (role === "guest" || !email || !authIdentityKey) {
      // 같은 null 을 무조건 다시 쓰면 의존 배열이 흔들릴 때마다 렌더가 한 번 더 돈다 —
      //   실제로 값이 있을 때만 비운다.
      setOrgContext((current) => (current === null ? current : null));
      return;
    }
    // Stale-while-revalidate: TTL 만료·뮤테이션 무효화(cacheRevision bump)로 재읽기가 시작돼도
    //   이 스코프의 마지막 확정 투영을 그대로 보여준다. null 로 먼저 비우면 포커스 복귀 때마다
    //   useOrgContext 소비자 전체(특히 /chat 의 selectedViewMailAccountId → 대화 목록)가
    //   비었다가 다시 차오르는 플래시가 난다. 스코프 전환(로그인·viewAs 변경)은 이 키에 확정값이
    //   없거나 다른 스코프의 값이므로 여전히 비운 채 시작하고, 재검증 실패 시에는 아래 fetch 가
    //   null 을 돌려줘 기존과 같이 비워진다.
    const stale = getStaleOrgContext(activeScopeKey);
    setOrgContext((current) => (current === stale ? current : stale));
    let cancelled = false;
    fetchCachedOrgContext(
      activeScopeKey,
      () => getMyOrgContext(activeViewAsTarget
        ? { viewAsUserId: activeViewAsTarget.userId, viewAsEmail: activeViewAsTarget.email }
        : {}),
    ).then((response) => {
      if (!cancelled && requestGeneration === requestGenerationRef.current) setOrgContext(response);
    });
    return () => {
      cancelled = true;
    };
  }, [activeScopeKey, activeViewAsTarget, authIdentityKey, cacheRevision, email, role]);

  return orgContext;
}


export function authoritativeOrgContextScopeKey(orgContext: MyOrgContextEnvelope | null): string {
  if (!orgContext) return "org-context:pending";
  return JSON.stringify([
    "org-context:v1",
    orgContext.orgResolutionStatus ?? "unknown",
    orgContext.orgId ?? "no-org",
    orgContext.viewMailAccountId ?? "no-view-account",
    orgContext.orgAccount?.accountId ?? "no-org-account",
    orgContext.orgAccount?.status ?? "",
    orgContext.personalAccount?.accountId ?? "no-personal-account",
    orgContext.personalAccount?.status ?? "",
    orgContext.defaultSenderId ?? "no-default-sender",
    ...(orgContext.accessibleAccounts ?? []).map((account) => `${account.accountId}:${account.status}`).sort(),
  ]);
}

export function useAuthoritativeOrgContextScopeKey(): string {
  const orgContext = useOrgContext();
  return authoritativeOrgContextScopeKey(orgContext);
}

/**
 * A scoped counterpart to a bare invalidateOrgContextCache() for mutation surfaces whose write
 * feeds back into this projection — e.g. dismissing the mail-connect notice persists
 * user_preferences, which getMyOrgContext folds into mailConnectNoticeDismissed. Without
 * invalidation a remount inside the TTL would serve the pre-write entry and resurrect the
 * dismissed UI; invalidating only the caller's active scope also leaves unrelated entries (e.g. a
 * parked viewAs target's projection) warm.
 */
export function useInvalidateOrgContext(): () => void {
  const { activeScopeKey } = useOrgContextScope();
  return useCallback(() => invalidateOrgContextCache(activeScopeKey), [activeScopeKey]);
}

/**
 * org tab preset (functions/orgTabPresets.ts getMyOrgContext.navPreset) — a list of FLU_NAV
 * `key`s the caller's org is restricted to. Returns null while unresolved AND when unrestricted
 * (no admin-set preset, or no resolved org at all) — every consumer's fail-open behavior is
 * identical either way (프리셋 없으면 현행 탭 전부, 회귀 0), so the two cases are deliberately not
 * distinguished. Guests never fetch — guests have no mail identity to resolve and getMyOrgContext
 * itself rejects a guest caller.
 */
export function useNavPreset(): readonly string[] | null {
  const orgContext = useOrgContext();
  return orgContext?.navPreset ?? null;
}
