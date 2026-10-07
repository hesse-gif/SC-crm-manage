import { Suspense, type ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { AuthGate } from "@/components/shell/AuthGate";
import { LiveDataProvider } from "@/lib/live";
import { LoadingStatus } from "@/components/ui/LoadingStatus";

// (app) 라우트 그룹: URL에 영향 없이 셸(사이드바+탑바)을 입힌다.
// 정적 Firebase Hosting 배포를 위해 클라이언트 훅(useSearchParams 등)을 쓰는 셸 트리를 Suspense로 감싼다.
function AppShellFallback() {
  return (
    <div className="grid min-h-screen place-items-center bg-surface px-6 text-center">
      <LoadingStatus>Chat 워크스페이스 준비 중</LoadingStatus>
    </div>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<AppShellFallback />}>
      <AuthGate>
        <LiveDataProvider>
          <AppShell>{children}</AppShell>
        </LiveDataProvider>
      </AuthGate>
    </Suspense>
  );
}
