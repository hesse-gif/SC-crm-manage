"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { subscribeAuthState, type AuthState } from "@/lib/auth";

const initialState: AuthState = { user: null, role: null, loading: true };

export function AdminGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState>(initialState);

  useEffect(() => subscribeAuthState(setState), []);

  useEffect(() => {
    if (state.loading || state.errorKind === "configuration" || !state.user) return;
    if (state.role !== "admin" && state.role !== "super_admin") {
      router.replace("/access-denied");
    }
  }, [router, state.errorKind, state.loading, state.role, state.user]);

  if (state.loading || !state.user || !state.role) {
    return (
      <div className="grid min-h-[40vh] place-items-center text-sm font-medium text-ink-3" role="status">
        관리자 권한 확인 중…
      </div>
    );
  }

  if (state.role !== "admin" && state.role !== "super_admin") return null;
  return children;
}
