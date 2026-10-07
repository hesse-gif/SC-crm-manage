"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { logBehavior, type BehaviorLogPayload } from "@/lib/data";

// Flu/Task-50 — 슈퍼어드민 쉐도우 로그인("대신 보기") 클라이언트 상태. role.tsx의 미리보기
// 역할(previewRole/sessionStorage) 과 같은 이유로 sessionStorage에 둔다 — 새로고침에는 살아남고
// 탭을 닫으면 사라진다(실수로 다른 세션까지 뒤 사용자 시점으로 남는 것을 막는다). 실제 권한 판단은
// 절대 여기서 하지 않는다 — 이 상태는 어떤 fetch를 보낼지 고르는 힌트일 뿐이고, 매 호출마다 서버
// (functions/mailAccountCallables.ts getMyOrgContext)가 caller.role === "super_admin" 을 다시
// 검증한다(AUTH-P0-003) — 클라이언트가 이 상태를 조작해도 서버가 permission-denied로 막는다.
export type ViewAsTarget = { userId: string; email: string; name: string };

const VIEW_AS_STORAGE_KEY = "flu.viewAs.target";

type ViewAsState = {
  target: ViewAsTarget | null;
  /** Flu/Task-50 적대 리뷰 P1 — `Boolean(target)`의 파생값. 소비 화면(Chat/후보/파트너)이 매번
   * `Boolean(target)`을 다시 쓰지 않고 이 필드로 "지금 대신 보기 중인가"를 읽는다. role 재검증은
   * 여전히 소비처 몫이다(src/lib/useNavPreset.ts의 `role === "super_admin" ? viewAsTarget : null`
   * 패턴과 동일 — 여기서는 role을 모르므로 role.tsx를 새로 import해 순환을 만들지 않는다). */
  isViewingAs: boolean;
  startViewAs: (target: ViewAsTarget) => void;
  stopViewAs: () => void;
};

const ViewAsCtx = createContext<ViewAsState>({ target: null, isViewingAs: false, startViewAs: () => {}, stopViewAs: () => {} });

function readStoredViewAsTarget(): ViewAsTarget | null {
  try {
    const raw = window.sessionStorage.getItem(VIEW_AS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ViewAsTarget> | null;
    if (parsed && typeof parsed.userId === "string" && parsed.userId && typeof parsed.email === "string" && parsed.email) {
      return { userId: parsed.userId, email: parsed.email, name: typeof parsed.name === "string" && parsed.name ? parsed.name : parsed.email };
    }
    return null;
  } catch {
    // 프라이빗 모드 등 storage 접근 불가 환경 — 대신 보기가 세션 안에서 못 버틸 뿐 화면은 그대로 동작한다.
    return null;
  }
}

function writeStoredViewAsTarget(target: ViewAsTarget | null) {
  try {
    if (target) window.sessionStorage.setItem(VIEW_AS_STORAGE_KEY, JSON.stringify(target));
    else window.sessionStorage.removeItem(VIEW_AS_STORAGE_KEY);
  } catch {
    // 위와 같은 이유로 조용히 무시한다.
  }
}

export function ViewAsProvider({ children }: { children: ReactNode }) {
  // Flu/Task-59 — 이전엔 null로 시작해 마운트 후 useEffect에서만 sessionStorage를 읽었다. 정상
  // 소프트 내비게이션에서는 이 Provider가 루트에서 한 번만 마운트돼 문제가 없었지만, 이 Provider의
  // 모든 소비자(Topbar 배너 포함)는 AuthGate가 로그인 해석을 끝내야 렌더되므로(src/components/
  // shell/AuthGate.tsx) 이미 알려진 하드 내비게이션 인시던트(프로드 호스팅이 RSC 페이로드
  // 요청에 HTML을 돌려줘 라우트 전환마다 전체 문서가 다시 로드됨 — f4ce1aff)가 겹치면 이 Provider
  // 자체도 매번 새로 마운트된다. 그때 target이 null로 시작해 effect가 한 틱 뒤에야 채우면, 이미
  // 진행 중인(인증 재해석 지연이 지배적인) 배너 부재 구간 위에 불필요한 프레임 하나가 더 겹친다.
  // sessionStorage 읽기는 동기 함수라 useState 초기화 함수 안에서 즉시 실행해도 비용이 없다 —
  // SSR에는 window가 없으므로 가드한다. hydration mismatch 걱정은 없다: 이 값을 실제로 그리는
  // 모든 소비자가 AuthGate 뒤에 있어 서버/최초 클라이언트 렌더 모두 로딩 플레이스홀더만 그린다.
  const [target, setTarget] = useState<ViewAsTarget | null>(() =>
    typeof window === "undefined" ? null : readStoredViewAsTarget(),
  );

  const startViewAs = useCallback((next: ViewAsTarget) => {
    setTarget(next);
    writeStoredViewAsTarget(next);
  }, []);

  const stopViewAs = useCallback(() => {
    setTarget(null);
    writeStoredViewAsTarget(null);
  }, []);

  // Flu/Task-50 적대 리뷰 LOW — "종료" 버튼을 누르지 않고 탭을 닫거나 다른 사이트로 이동하면
  // (Topbar.tsx endViewAs가 실행될 기회 자체가 없다) viewAs.end 감사 로그가 영영 안 남는다.
  // pagehide는 beforeunload와 달리 bfcache 친화적이라 이 앱이 이미 쓰는 관용구다(뒤로가기 복원과
  // 충돌하지 않는다). sendBeacon은 인증 콜러블(Authorization 헤더 필요)에 못 쓰므로, 언로드 중에도
  // 잠시 실행이 허용되는 fetch 기반의 기존 logBehavior 콜러블을 awaiting 없이 best-effort 호출한다
  // — 실패/미완주는 무시: 프리뷰 자체는 이미 로컬에서 끝났고, 이 로그는 감사 편의일 뿐 어떤 권한
  // 판단에도 쓰이지 않는다.
  useEffect(() => {
    function handlePageHide() {
      if (!target) return;
      void logBehavior({
        action: `viewAs.end(${target.userId})`,
        gameId: "global",
        result: "success",
        costKRW: 0,
        time: new Date().toISOString(),
      } as BehaviorLogPayload).catch(() => {
        // 위 주석 참조 — best-effort.
      });
    }
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [target]);

  const value = useMemo<ViewAsState>(
    () => ({ target, isViewingAs: target !== null, startViewAs, stopViewAs }),
    [target, startViewAs, stopViewAs],
  );

  return <ViewAsCtx.Provider value={value}>{children}</ViewAsCtx.Provider>;
}

export const useViewAs = () => useContext(ViewAsCtx);
