"use client";

// Outreach tab (spec §5.2) — discovery/cold-mail/reply summary + bounded list.
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ExternalLink } from "@/components/icons";
import { formatKst } from "@/lib/datetime";
import { deliveryStateLabel } from "@/lib/statusLabels";
import type { OutreachActivityRow } from "@/lib/managementTabsData";

export function ManagementOutreachTab({ rows }: { rows: OutreachActivityRow[] }) {
  if (rows.length === 0) {
    return <Card className="px-5 py-8 text-center text-sm text-ink-4">이 프로그램에서 발송한 메일이 없습니다.</Card>;
  }

  const sent = rows.length;
  const replied = rows.filter((row) => row.replied).length;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="아웃리치 요약" desc={`발송 ${sent}건 · 회신 ${replied}건`} />
        <ul className="divide-y divide-line">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium text-ink">{row.subject ?? "(제목 없음)"}</p>
                <p className="text-[11px] text-ink-4">
                  {row.campaignName ?? "캠페인 이름 미연결"} · {formatKst(row.sentAt, "—")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {typeof row.openCount === "number" ? <Badge tone="neutral">열람 {row.openCount}</Badge> : null}
                <Badge tone={row.replied ? "ok" : "neutral"}>{row.replied ? "회신" : row.deliveryState ? deliveryStateLabel(row.deliveryState) : "발송"}</Badge>
                {row.conversationHref ? (
                  <a href={row.conversationHref} className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline">
                    대화 열기<ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
