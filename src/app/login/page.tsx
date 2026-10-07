"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Google } from "@/components/icons";
import { signInWithGoogleOrEmulator } from "@/lib/auth";

function nextPath() {
  if (typeof window === "undefined") return "/chat";
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("next");
  if (!requested || !requested.startsWith("/") || requested.startsWith("//")) return "/chat";
  return requested;
}

function authErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
  return typeof code === "string" ? code : "";
}

function loginErrorMessage(error: unknown): string {
  switch (authErrorCode(error)) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "로그인 창이 닫혔습니다. 다시 시도해 주세요.";
    case "auth/popup-blocked":
      return "브라우저가 로그인 팝업을 차단했습니다. 팝업 허용 후 다시 시도해 주세요.";
    case "auth/unauthorized-domain":
      return "현재 도메인이 Google 로그인 허용 목록에 없습니다.";
    case "auth/network-request-failed":
      return "네트워크 연결을 확인한 뒤 다시 시도해 주세요.";
    default:
      return "로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.";
  }
}

// Flu/Task-61: 에뮬레이터에서만 의미 있는 QA 계정 선택자 — signInWithGoogleOrEmulator가 실제
// production 경로(NEXT_PUBLIC_USE_EMULATOR!=="1")에서는 이 값을 완전히 무시하므로 hosted
// 로그인 흐름은 전혀 영향받지 않는다.
function emulatorTestAccountId() {
  if (typeof window === "undefined") return "admin";
  return new URLSearchParams(window.location.search).get("testAccount") || "admin";
}

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleLogin() {
    setLoading(true);
    setError("");
    try {
      await signInWithGoogleOrEmulator(emulatorTestAccountId());
      router.replace(nextPath());
    } catch (error) {
      setLoading(false);
      setError(loginErrorMessage(error));
      console.error(error);
    }
  }

  return (
    <div className="min-h-screen grid md:grid-cols-2">
      {/* LEFT — brand panel (hidden on mobile) */}
      <div className="hidden md:flex flex-col justify-center px-14 bg-surface">
        {/* Brand mark */}
        <div className="flex items-center gap-3 mb-10">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-accent text-white text-xl font-bold select-none">
            M
          </span>
          <span className="text-2xl font-bold text-ink tracking-tight">Mixmax</span>
        </div>

        {/* Tagline */}
        <p className="text-sm font-medium text-ink-3 mb-8 leading-relaxed max-w-xs">
Sales communication workspace for live creator conversations
        </p>

        {/* Value bullets */}
        <ul className="space-y-4 max-w-xs">
          {[
            {
              title: "Live feed",
              desc: "Program and direct conversations in one focused inbox",
            },
            {
              title: "Sequences",
              desc: "Draft, review, and send assisted outreach from the same workflow",
            },
            {
              title: "Event based refresh",
              desc: "Refreshes after operator actions, mail events, and tab recovery",
            },
          ].map((b) => (
            <li key={b.title} className="flex gap-3">
              <span className="mt-0.5 w-1.5 h-1.5 rounded-full bg-accent shrink-0 mt-1.5" />
              <div>
                <div className="text-sm font-semibold text-ink">{b.title}</div>
                <div className="text-xs text-ink-3 mt-0.5 leading-relaxed">{b.desc}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* RIGHT — login panel */}
      <div className="flex items-center justify-center bg-paper px-6 py-12">
        <div className="w-full max-w-sm">
          {/* Mobile brand mark */}
          <div className="flex items-center gap-2.5 mb-8 md:hidden">
            <span className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-accent text-white text-lg font-bold select-none">
              M
            </span>
            <span className="text-xl font-bold text-ink">Mixmax</span>
          </div>

          <h1 className="text-2xl font-bold text-ink mb-1.5">로그인</h1>
          <p className="text-sm text-ink-3 mb-8">Google 계정으로 시작하세요</p>

          {/* Google OAuth button */}
          <button
            className="w-full h-11 flex items-center justify-center gap-2.5 rounded-md border border-line bg-white text-sm font-semibold text-ink hover:bg-fill transition-colors"
            disabled={loading}
            onClick={handleLogin}
            type="button"
          >
            <Google />
            {loading ? "로그인 중…" : "Google로 로그인"}
          </button>

          {error ? (
            <p role="alert" className="mt-3 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          ) : null}

          {/* Domain badge */}
          <div className="mt-4 flex justify-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-fill px-3 py-1 text-xs text-ink-3">
              🔒 @supercent.io 계정만 접근 가능
            </span>
          </div>

          {/* Footer */}
          <p className="mt-12 text-center text-[11px] text-ink-4">
Mixmax · internal workspace
          </p>
        </div>
      </div>
    </div>
  );
}
