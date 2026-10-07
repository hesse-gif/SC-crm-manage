"use client";

import { PageHeader } from "@/components/ui/PageHeader";
import { AdminTicketsPanel } from "@/components/ticket/TicketWidget";

// 앱 내 제보 위젯(우하단 말풍선)으로 들어온 버그 제보·개선 의견 수집함. 열람은 admin+ (AdminGate + 서버 검증).
export default function AdminTicketsPage() {
  return (
    <div className="mx-auto max-w-content px-6 py-7">
      <PageHeader
        title="티켓"
        desc="앱 안에서 보낸 버그 제보·개선 의견. 완료 처리 후 삭제할 수 있고, SuperBoard(Flu 보드)로 전달 상태를 함께 본다."
      />
      <AdminTicketsPanel />
    </div>
  );
}
