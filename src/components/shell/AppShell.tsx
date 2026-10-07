"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { isDevelopmentOnlyNoDataRoute } from "@/lib/live";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileNavButtonRef = useRef<HTMLButtonElement>(null);

  const closeMobileNavigation = useCallback((restoreFocus: boolean) => {
    setMobileNavOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => mobileNavButtonRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const closeAtDesktopBreakpoint = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileNavOpen(false);
    };

    if (desktop.matches) setMobileNavOpen(false);
    desktop.addEventListener("change", closeAtDesktopBreakpoint);
    return () => desktop.removeEventListener("change", closeAtDesktopBreakpoint);
  }, []);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMobileNavigation(true);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeMobileNavigation, mobileNavOpen]);

  if (isDevelopmentOnlyNoDataRoute(pathname)) {
    return <div className="min-h-dvh bg-surface">{children}</div>;
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-surface md:h-screen">
      {mobileNavOpen ? (
        <div
          aria-hidden="true"
          onClick={() => closeMobileNavigation(true)}
          className="fixed inset-0 z-30 bg-ink/20 md:hidden"
        />
      ) : null}
      <Sidebar
        mobileOpen={mobileNavOpen}
        onMobileClose={() => closeMobileNavigation(true)}
        onMobileNavigate={() => closeMobileNavigation(true)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          mobileNavOpen={mobileNavOpen}
          mobileNavButtonRef={mobileNavButtonRef}
          onOpenNavigation={() => setMobileNavOpen(true)}
        />
        <div
          data-testid="app-content"
          // min-h-0 필수: 이 래퍼는 overflow가 visible이라 flex-column 자동 최소
          // 높이(min-height:auto)가 콘텐츠 높이만큼 커져 main이 뷰포트로 잘리지
          // 않고 통째로 늘어난다 → 스크롤 컨테이너가 사라져 전역 휠 스크롤 불가
          // (v0.5.34 P0). e2e/wheel-scroll.spec.ts가 회귀를 감시한다.
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          aria-hidden={mobileNavOpen}
          inert={mobileNavOpen}
        >
          <main data-testid="app-main" className="scroll-quiet min-w-0 flex-1 overflow-y-auto">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
