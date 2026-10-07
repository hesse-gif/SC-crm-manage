"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  WORKSPACES,
  ADMIN_WORKSPACE,
  FOOTER_NAV,
  filterNavByPreset,
  navForWorkspace,
  workspaceFromPath,
  isNavActive,
} from "@/lib/nav";
import { signOutCurrentUser } from "@/lib/auth";
import { useRole, canSeeAdmin, canPreviewRoles, clampPreviewRole } from "@/lib/role";
import { ROLES, type Role } from "@/lib/data";
import { useNavPreset, useOrgContext } from "@/lib/useNavPreset";
import { APP_VERSION } from "@/lib/appVersion";
import { APP_SOURCE_COMMIT_SHORT, appVersionLabel } from "@/lib/releaseMarker";
import { useLive } from "@/lib/live";
import { icons, ChevronLeft, ChevronRight, Plus, Dots, Close } from "@/components/icons";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { MailConnectNotice } from "./MailConnectNotice";

const ROLE_ORDER: Role[] = ["super_admin", "admin", "manager", "viewer", "guest"];
const SIDEBAR_COLLAPSED_KEY = "flu.sidebar.collapsed";

function warnSidebarStorageFailure(error: unknown) {
  if (error instanceof DOMException && (error.name === "SecurityError" || error.name === "QuotaExceededError")) return;
  console.warn("Sidebar could not persist collapsed state", error);
}

export function Sidebar({
  mobileOpen,
  onMobileClose,
  onMobileNavigate,
}: {
  mobileOpen: boolean;
  onMobileClose: () => void;
  onMobileNavigate: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { role, setRole, name, email, photoURL } = useRole();
  const { data } = useLive();
  const [collapsed, setCollapsed] = useState(false);
  const [collapsePreferenceLoaded, setCollapsePreferenceLoaded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null);
  // Flu/Task-42: org tab preset — null (no restriction) until resolved, so the sidebar never
  // flashes an empty/partial nav before the callable returns (프리셋 없으면 현행 탭 전부, 회귀 0).
  const navPreset = useNavPreset();
  // 2026-09-27 security fix: scp explicit-grant entitlement (getMyOrgContext.scpAccessGranted) —
  // orthogonal to navPreset. Unlike navPreset (fail-open while unresolved), this fails CLOSED:
  // requiresScpAccess nav items stay hidden until orgContext resolves and confirms the grant, same
  // direction as the optIn "candidates" tab treats an unresolved navPreset (nav.ts:117-118).
  const orgContext = useOrgContext();
  const scpAccessGranted = orgContext?.scpAccessGranted === true;

  // 에뮬레이터/개발 환경 여부 (빌드 타임 상수 — 프로덕션 번들에서 dead code 제거됨)
  const isEmulator = process.env.NEXT_PUBLIC_USE_EMULATOR === "1";
  // 실제 서버 클레임 역할. RoleProvider가 subscribeAuthState에서 설정하며
  // 프리뷰 switcher 외에 모든 메뉴 가시성의 기준이 된다.
  const actualClaim = role;

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true");
    } catch (error) {
      warnSidebarStorageFailure(error);
    } finally {
      setCollapsePreferenceLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!collapsePreferenceLoaded) return;
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
    } catch (error) {
      warnSidebarStorageFailure(error);
    }
  }, [collapsePreferenceLoaded, collapsed]);

  useEffect(() => {
    if (!mobileOpen) return;
    const frame = window.requestAnimationFrame(() => mobileCloseButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [mobileOpen]);

  // Post-merge review (PR #210 follow-up, codex round 3) — this "로그아웃" control used to be a
  // bare navigation Link to the login route, which only navigates: it never called Firebase's
  // signOut, so the Auth session stayed alive and onIdTokenChanged never fired the sign-out branch in
  // src/lib/auth.ts (the one that purges the org context cache and membership bootstrap markers).
  // Clicking it just showed the login screen while the previous user was still authenticated
  // underneath — this is the only "로그아웃" control in the app (grep across src confirms it), so a
  // real logout never happened anywhere. signOutCurrentUser() actually calls Firebase's signOut().
  //
  // codex confirmatory-round follow-up (HIGH) — a first version of this handler still navigated to
  // /login even when signOutCurrentUser() rejected. That looked like a harmless "never leave the
  // user stuck on a dead click" fallback, but it is the opposite of harmless here specifically:
  // if Firebase's signOut() truly failed, the user is still authenticated underneath, the `!user`
  // purge branch in src/lib/auth.ts never runs, and navigating away made a *failed* sign-out look
  // successful — silently defeating the very purge this PR exists to guarantee. On failure this now
  // keeps the menu open, shows a retryable error, and does not navigate; only a confirmed
  // signOutCurrentUser() success closes the menu and navigates.
  const [signOutError, setSignOutError] = useState("");

  async function handleSignOut() {
    setSignOutError("");
    try {
      await signOutCurrentUser();
    } catch (error) {
      console.error("Sidebar sign-out failed", error);
      setSignOutError("로그아웃에 실패했습니다. 다시 시도해 주세요.");
      return;
    }
    setMenuOpen(false);
    router.replace("/login");
  }

  // 사이드바 프로필 표시값 (Google OAuth 실데이터). 사진 없으면 이니셜 폴백.
  const displayName = name || email || "사용자";
  const displayEmail = email || "";
  const avatarLabel = photoURL || displayName.charAt(0).toUpperCase();

  const ws = workspaceFromPath(pathname);
  // Flu/Task-42: org tab preset only restricts the Flu workspace (Chat/Admin are unaffected —
  // the ticket's AI Drama preset is a Flu-tab list, and Growth/no-preset orgs must see the
  // current full nav in every workspace unchanged).
  const nav = ws === "flu" ? filterNavByPreset(navForWorkspace(ws), navPreset) : navForWorkspace(ws);
  // 메뉴 가시성은 실제 서버 클레임 기준 (클라이언트 프리뷰 역할로 상위 메뉴 노출 불가)
  const visibleNav = nav.filter((item) => {
    if (item.emulatorOnly && !isEmulator) return false;
    if (item.superAdminOnly && actualClaim !== "super_admin") return false;
    if (item.managerPlusOnly && ROLES[actualClaim].rank < ROLES.manager.rank) return false;
    if (item.minRole && ROLES[actualClaim].rank < ROLES[item.minRole].rank) return false;
    if (item.requiresScpAccess && !scpAccessGranted) return false;
    return true;
  });
  const switcher = canSeeAdmin(actualClaim) ? [...WORKSPACES, ADMIN_WORKSPACE] : WORKSPACES;
  const chatAlert = Array.isArray(data?.conversations) && data.conversations.some((conversation) => {
    const unread = typeof conversation.unread === "number" ? conversation.unread : 0;
    return unread > 0;
  });
  const actionLabel = ws === "admin" ? "멤버 초대" : "새 메시지";
  const expanded = mobileOpen || !collapsed;

  // 활성 판정은 nav.ts의 isNavActive 사용 (통합 경로 match[] 포함)

  return (
    <aside
      id="app-navigation"
      data-testid="app-sidebar"
      aria-label="주 내비게이션"
      onClickCapture={(event) => {
        if (event.target instanceof Element && event.target.closest("a")) onMobileNavigate();
      }}
      className={cn(
        "fixed inset-y-0 left-0 z-40 h-dvh w-[min(280px,calc(100vw-48px))] flex-col border-r border-line bg-paper shadow-pop md:static md:z-auto md:h-screen md:shrink-0 md:shadow-none md:transition-[width] md:duration-200",
        mobileOpen ? "flex" : "hidden md:flex",
        collapsed ? "md:w-[64px]" : "md:w-[240px]",
      )}
    >
      {/* Brand → 런처 */}
      <div className="flex h-16 items-center">
        <Link href="/" className="flex min-w-0 flex-1 items-center gap-2.5 px-4" title="런처로">
          <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-md bg-white ring-1 ring-line">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/supercent-source.png" alt="Supercent" className="h-full w-full object-contain p-[3px]" />
          </span>
          {expanded && (
            <div className="min-w-0 leading-tight">
              <div className="text-sm font-extrabold text-ink">Mixmaxclone</div>
              <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
                <span className="truncate">Chat 워크스페이스</span>
                <span className="shrink-0 rounded bg-fill px-1 text-[10px] font-semibold text-ink-4">
                  {appVersionLabel(APP_VERSION, APP_SOURCE_COMMIT_SHORT)}
                </span>
              </div>
            </div>
          )}
        </Link>
        <button
          ref={mobileCloseButtonRef}
          type="button"
          aria-label="메뉴 닫기"
          onClick={onMobileClose}
          className="mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-2 transition-colors hover:bg-fill active:scale-[0.96] md:hidden"
        >
          <Close className="h-5 w-5" />
        </button>
      </div>

      {/* 워크스페이스 스위처 */}
      {!expanded ? (
        <div className="space-y-1 px-2 pb-2">
          {switcher.map((w) => {
            const Icon = icons[w.icon];
            const active = ws === w.key;
            return (
              <Link
                key={w.key}
                href={w.href}
                title={w.label}
                className={cn(
                  "relative flex h-10 items-center justify-center rounded-md transition-colors md:h-9",
                  active ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-fill hover:text-ink",
                )}
              >
                <Icon className="h-5 w-5" />
                {w.key === "chat" && chatAlert && (
                  <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-danger" />
                )}
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="px-3 pb-2">
          <div className="flex gap-1 rounded-md bg-fill p-1">
            {switcher.map((w) => {
              const Icon = icons[w.icon];
              const active = ws === w.key;
              return (
                <Link
                  key={w.key}
                  href={w.href}
                  className={cn(
                    "flex h-10 flex-1 items-center justify-center gap-1 rounded-[6px] text-[12px] font-semibold transition-colors md:h-8",
                    active ? "bg-paper text-ink shadow-card" : "text-ink-2 hover:text-ink",
                  )}
                >
                  <Icon className="h-[15px] w-[15px]" />
                  {w.label}
                  {w.key === "chat" && chatAlert && (
                    <span className="h-1.5 w-1.5 rounded-full bg-danger" />
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Primary action */}
      <div className="px-3 pb-2">
        <Link
          href={ws === "admin" ? "/admin/members" : "/chat?compose=new"}
          className="flex h-10 w-full items-center justify-center gap-1.5 rounded-md bg-accent text-[13px] font-semibold text-white transition-colors hover:bg-accent/90 md:h-9"
          title={actionLabel}
        >
          <Plus className="h-4 w-4" />
          {expanded && actionLabel}
        </Link>
      </div>

      {/* Nav */}
      <nav className="scroll-quiet flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
        {visibleNav.map((item) => {
          const Icon = icons[item.icon];
          const active = isNavActive(item, pathname);
          return (
            <Link
              key={item.key}
              href={item.href}
              title={item.label}
              className={cn(
                "group relative flex h-10 items-center gap-3 rounded-md px-2.5 text-sm font-medium transition-colors",
                active ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-fill hover:text-ink",
              )}
            >
              {active && (
                <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-accent" />
              )}
              <Icon className="h-[20px] w-[20px] shrink-0" />
              {expanded && <span className="flex-1 truncate">{item.label}</span>}
              {expanded && item.badge && (
                <Badge tone={active ? "accent" : "neutral"}>{item.badge}</Badge>
              )}
              {!expanded && item.badge && (
                <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent" />
              )}
            </Link>
          );
        })}
      </nav>

      {/* 메일 연결(선택) — 접힌 사이드바에서는 숨김, 모바일 드로어에서는 항상 표시(expanded) */}
      {expanded && <MailConnectNotice />}

      {/* Footer: gallery + account widget + collapse */}
      <div className="shrink-0 border-t border-line px-2 pb-3 pt-2">
        {FOOTER_NAV.map((item) => {
          const Icon = icons[item.icon];
          const active = isNavActive(item, pathname);
          return (
            <Link
              key={item.key}
              href={item.href}
              title={item.label}
              className={cn(
                "mb-1 flex h-10 items-center gap-3 rounded-md px-2.5 text-[13px] font-medium transition-colors md:h-9",
                active ? "bg-accent-soft text-accent" : "text-ink-3 hover:bg-fill hover:text-ink",
              )}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" />
              {expanded && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}

        {/* 계정 위젯 (좌하단) */}
        <div className="relative">
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
              <div className="absolute bottom-full left-0 z-40 mb-2 w-60 rounded-lg border border-line bg-paper p-1.5 shadow-pop">
                <div className="px-2.5 py-2">
                  <div className="text-sm font-bold text-ink">{displayName}</div>
                  <div className="truncate text-xs text-ink-3">{displayEmail}</div>
                </div>
                {canPreviewRoles(isEmulator) && (
                  <>
                    <div className="border-t border-line px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-4">
                      역할 미리보기 (데모)
                    </div>
                    {ROLE_ORDER.map((r) => (
                      <button
                        key={r}
                        onClick={() => {
                          setRole(clampPreviewRole(r, actualClaim));
                          setMenuOpen(false);
                        }}
                        className={cn(
                          "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] transition-colors hover:bg-fill",
                          r === role ? "font-semibold text-ink" : "text-ink-2",
                        )}
                      >
                        <span>{ROLES[r].label}</span>
                        {r === role && <span className="text-accent">●</span>}
                      </button>
                    ))}
                  </>
                )}
                <div className="mt-1 border-t border-line pt-1">
                  {signOutError && (
                    <div className="px-2.5 pb-1 text-[11px] text-danger">{signOutError}</div>
                  )}
                  <button
                    type="button"
                    onClick={handleSignOut}
                    className="flex w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-danger transition-colors hover:bg-fill"
                  >
                    로그아웃
                  </button>
                </div>
              </div>
            </>
          )}
          <button
            onClick={() => {
              setSignOutError("");
              setMenuOpen((o) => !o);
            }}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md p-1.5 transition-colors hover:bg-fill",
              !expanded && "justify-center",
            )}
          >
            <Avatar
              label={avatarLabel}
              size={32}
              className="bg-accent-soft text-xs font-bold text-accent"
            />
            {expanded && (
              <>
                <span className="min-w-0 flex-1 text-left leading-tight">
                  <span className="block truncate text-[13px] font-bold text-ink">
                    {displayName}
                  </span>
                  <span className="block text-[11px] text-ink-3">{ROLES[role].label}</span>
                </span>
                <Dots className="h-4 w-4 shrink-0 text-ink-3" />
              </>
            )}
          </button>
        </div>

        <button
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className={cn(
            "mt-1 hidden h-10 w-full items-center gap-3 rounded-md text-[13px] font-medium text-ink-4 transition-colors hover:bg-fill hover:text-ink md:flex",
            collapsed ? "justify-center px-0" : "px-2.5",
          )}
          title={collapsed ? "펼치기" : "접기"}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <>
              <ChevronLeft className="h-4 w-4" />
              <span>접기</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
