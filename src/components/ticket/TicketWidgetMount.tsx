"use client";

import { usePathname } from "next/navigation";
import { useAuthProfile, useRole } from "@/lib/role";
import { isDevelopmentOnlyNoDataRoute } from "@/lib/live";
import { TicketButton } from "./TicketWidget";

// 로그인·이메일이 있는 비게스트 사용자에게만 우하단 제보 버튼을 띄운다(제출 권한은 서버가 최종 검증).
// 에뮬레이터에서는 같은 자리에 SeedWidget(admin)이 있어 한 칸 왼쪽으로 비켜 둔다. 사용자는 버튼을 드래그해 옮길 수 있다.
const seedWidgetVisible = process.env.NEXT_PUBLIC_USE_EMULATOR === "1";

export function TicketWidgetMount() {
  const pathname = usePathname();
  const { role } = useRole();
  const { email } = useAuthProfile();
  if (isDevelopmentOnlyNoDataRoute(pathname)) return null;
  if (role === "guest" || !email) return null;
  return <TicketButton userEmail={email} defaultOffset={seedWidgetVisible ? { right: 80, bottom: 20 } : { right: 20, bottom: 20 }} />;
}
