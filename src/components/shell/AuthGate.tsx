"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { subscribeAuthState, type AuthState } from "@/lib/auth";

const initialState: AuthState = { user: null, role: null, loading: true };

function authGateNavigationDiagnostic(pathname: string) {
  const navigation = window.performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  let chunkErrorCategory = "none";
  try {
    const chunkRecoveryAt = Number(window.sessionStorage.getItem("flu:chunk-reload-at") || "0");
    chunkErrorCategory = chunkRecoveryAt > 0 && Date.now() - chunkRecoveryAt < 15_000
      ? "recent-chunk-recovery"
      : "none";
  } catch {
    chunkErrorCategory = "storage-unavailable";
  }
  return {
    route: pathname,
    navigationType: navigation?.type ?? "unknown",
    hydrationStatus: document.readyState,
    chunkErrorCategory,
    authGateMounted: "true",
  };
}

function initialAuthGateNavigationDiagnostic(pathname: string) {
  return {
    route: pathname,
    navigationType: "server",
    hydrationStatus: "server",
    chunkErrorCategory: "unknown",
    authGateMounted: "false",
  };
}

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<AuthState>(initialState);
  const [navigationDiagnostic, setNavigationDiagnostic] = useState(() =>
    initialAuthGateNavigationDiagnostic(pathname)
  );

  useEffect(() => subscribeAuthState(setState), []);

  useEffect(() => {
    setNavigationDiagnostic(authGateNavigationDiagnostic(pathname));
  }, [pathname]);

  useEffect(() => {
    if (state.loading) return;
    if (state.errorKind === "configuration") return;

    if (!state.user) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }

    if (!state.role || state.role === "guest") {
      router.replace("/access-denied");
    }
  }, [pathname, router, state.errorKind, state.loading, state.role, state.user]);

  const realOk = !state.loading && Boolean(state.user) && Boolean(state.role) && state.role !== "guest";
  const diagnostics = (
    <div
      data-testid="auth-gate-diagnostics"
      data-auth-loading={String(state.loading)}
      data-auth-ready={String(!state.loading)}
      data-auth-role={state.role ?? "none"}
      data-auth-error-kind={state.errorKind ?? "none"}
      data-auth-has-user={String(Boolean(state.user))}
      data-auth-route={navigationDiagnostic.route}
      data-auth-navigation-type={navigationDiagnostic.navigationType}
      data-auth-hydration-status={navigationDiagnostic.hydrationStatus}
      data-auth-chunk-error-category={navigationDiagnostic.chunkErrorCategory}
      data-auth-gate-mounted={navigationDiagnostic.authGateMounted}
      hidden
    />
  );

  if (realOk) return <>{children}{diagnostics}</>;

  if (state.errorKind === "configuration") {
    return (
      <main className="grid min-h-screen place-items-center bg-surface px-6 text-ink-1 antialiased">
        {diagnostics}
        <section
          className="w-full max-w-md rounded-2xl bg-paper p-6 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)]"
          aria-live="polite"
        >
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-danger">Configuration error</p>
          <h1 className="mt-2 text-balance text-xl font-semibold">앱 설정 오류</h1>
          <p className="mt-3 text-pretty text-sm leading-6 text-ink-3">
            {state.errorMessage}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-6 min-h-10 rounded-lg bg-ink-1 px-4 py-2 text-sm font-semibold text-paper transition-[scale,opacity] duration-150 ease-out active:scale-[0.96]"
          >
            다시 시도
          </button>
        </section>
      </main>
    );
  }

  return (
    <div className="grid min-h-screen place-items-center bg-surface px-6 text-sm font-medium text-ink-3">
      {diagnostics}
      권한 확인 중…
    </div>
  );
}
