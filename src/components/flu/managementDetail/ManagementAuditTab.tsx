"use client";

// 감사 tab (spec §5.7) — permissioned, append-only trace. Manager sees redacted rows only; raw
// protected material/model reasoning is never returned by the server, so this view never attempts to
// render it either.
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { formatKst } from "@/lib/datetime";
import type { AuditEventRow } from "@/lib/managementTabsData";

// 감사 이벤트/결과 코드 → 한글 표시. 사전에 없는 값은 원문을 그대로 둔다(새 코드가 조용히 묻히지 않도록).
const AUDIT_LABELS: Readonly<Record<string, string>> = {
  success: "성공",
  failed: "실패",
};

function auditLabel(raw: string | undefined | null): string {
  if (!raw) return "—";
  return AUDIT_LABELS[raw] ?? raw;
}

export function ManagementAuditTab({ events }: { events: AuditEventRow[] }) {
  if (events.length === 0) {
    return <Card className="px-5 py-8 text-center text-sm text-ink-4">선택 범위의 감사 이벤트가 없습니다.</Card>;
  }

  return (
    <Card>
      <CardHeader title="감사 로그" desc={`${events.length}건`} />
      <ul className="divide-y divide-line">
        {events.map((event) => (
          <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
            <div className="min-w-0">
              <p className="font-medium text-ink">{event.eventType ? auditLabel(event.eventType) : "event"}</p>
              <p className="text-[11px] text-ink-4">
                {formatKst(event.occurredAt, "—")} · {event.actor ?? "—"} · {event.scope ?? "—"}
              </p>
            </div>
            <Badge tone={event.result === "success" ? "ok" : event.result === "failed" ? "danger" : "neutral"}>
              {auditLabel(event.result)}
            </Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}
