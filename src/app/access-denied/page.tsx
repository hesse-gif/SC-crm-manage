"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Shield } from "@/components/icons";
import { APP_VERSION } from "@/lib/appVersion";
import { subscribeAuthState, type AuthState } from "@/lib/auth";
import { requestAccess } from "@/lib/data";

const initialAuthState: AuthState = { user: null, role: null, loading: true };

export default function AccessDeniedPage() {
  const [authState, setAuthState] = useState<AuthState>(initialAuthState);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const autoReconcileUidRef = useRef("");

  useEffect(() => subscribeAuthState(setAuthState), []);

  const profile = useMemo(() => ({
    email: authState.user?.email ?? "",
    displayName: authState.user?.displayName ?? authState.user?.email ?? "",
    photoURL: authState.user?.photoURL ?? "",
  }), [authState.user]);

  const handleRequestAccess = useCallback(async (source = "access-denied") => {
    if (!authState.user) {
      window.location.href = `/login?next=${encodeURIComponent("/access-denied")}`;
      return;
    }

    setSubmitting(true);
    setNotice("");
    setError("");
    try {
      const result = await requestAccess({
        ...profile,
        teamHint: "AIX",
        source,
      });
      if (result.status === "active") {
        setNotice("읽기 권한이 활성화되었습니다. Flu로 이동합니다.");
        await authState.user.getIdToken(true);
        window.location.replace("/flu");
        return;
      } else if (result.status === "blocked_domain") {
        setNotice("요청은 Flu에 기록했지만 @supercent.io 계정만 승인할 수 있습니다.");
      } else {
        setNotice("권한 요청을 Flu에 보냈습니다. 관리자 승인 후 다시 접속해 주세요.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "권한 요청을 보내지 못했습니다.");
    } finally {
      setSubmitting(false);
    }
  }, [authState.user, profile]);

  useEffect(() => {
    const user = authState.user;
    if (authState.loading || !user || (authState.role && authState.role !== "guest")) return;
    if (autoReconcileUidRef.current === user.uid) return;
    autoReconcileUidRef.current = user.uid;
    setNotice("기존 계정의 공용 읽기 권한을 확인하고 있습니다.");
    void handleRequestAccess("access-denied-auto-reconcile");
  }, [authState.loading, authState.role, authState.user, handleRequestAccess]);

  return (
    <div className="min-h-screen grid place-items-center bg-surface px-4 py-12">
      <div className="w-full max-w-[480px] rounded-xl border border-line bg-paper shadow-card overflow-hidden">
        {/* Top danger bar */}
        <div className="h-[3px] w-full bg-danger" />

        {/* Body */}
        <div className="p-10 text-center">
          {/* Shield icon tile */}
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-xl bg-danger-soft text-danger mb-5">
            <Shield className="w-8 h-8" />
          </div>

          {/* Eyebrow */}
          <p className="text-[11px] uppercase tracking-wide text-ink-4 mb-2">
            접근 제한
          </p>

          {/* Headline */}
          <h1 className="text-2xl font-bold text-ink mb-6">
            접근 권한이 없습니다
          </h1>

          {/* Reason list */}
          <div className="space-y-3 text-left mb-8">
            <div className="border-l-2 border-danger pl-3">
              <div className="text-sm font-semibold text-ink">
                @supercent.io 계정만 접근 가능
              </div>
              <div className="text-xs text-ink-3 mt-0.5">
                현재 로그인된 계정의 도메인이 허용되지 않습니다
              </div>
            </div>
            <div className="border-l-2 border-warn pl-3">
              <div className="text-sm font-semibold text-ink">
                관리자 승인 대기 (Guest)
              </div>
              <div className="text-xs text-ink-3 mt-0.5">
                Super Admin 승인 후 이용 가능
              </div>
            </div>
          </div>

          {notice ? (
            <div className="mb-4 rounded-md border border-accent/20 bg-accent-soft px-3 py-2 text-xs font-semibold text-accent">
              {notice}
            </div>
          ) : null}
          {error ? (
            <div className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs font-semibold text-danger">
              {error}
            </div>
          ) : null}

          {/* Buttons */}
          <div className="flex flex-col gap-2.5 mt-6">
            <Link href="/login" className="block w-full">
              <Button className="w-full h-11">다른 계정으로 로그인</Button>
            </Link>
            <Button
              type="button"
              variant="secondary"
              className="w-full h-11"
              disabled={authState.loading || submitting}
              onClick={() => void handleRequestAccess()}
            >
              {submitting ? "요청 중…" : "관리자에게 요청하기"}
            </Button>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-line px-10 py-4 text-center">
          <p className="text-[11px] text-ink-4">Flu · v{APP_VERSION} · 내부 도구</p>
        </div>
      </div>
    </div>
  );
}
