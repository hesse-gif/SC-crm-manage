"use client";

// 채널 정보 tab (spec §5.6) — separated from workflow judgement; a failure here never blocks
// onboarding/review actions (enforced by the caller only ever mounting this behind its own
// PartnerTabBoundary-shaped envelope, independent of every other tab).
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ExternalLink } from "@/components/icons";
import { formatKst } from "@/lib/datetime";
import type { ChannelActivityRow } from "@/lib/managementTabsData";

export function ManagementChannelIntelligenceTab({ rows }: { rows: ChannelActivityRow[] }) {
  if (rows.length === 0) {
    return <Card className="px-5 py-8 text-center text-sm text-ink-4">채널 활동 데이터가 없습니다.</Card>;
  }

  const videos = rows.filter((row) => row.kind === "video");
  const comments = rows.filter((row) => row.kind === "comment");

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="최근 영상" desc={`${videos.length}건`} />
        {videos.length === 0 ? (
          <p className="px-5 pb-4 text-sm text-ink-4">데이터 없음</p>
        ) : (
          <ul className="divide-y divide-line">
            {videos.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-2 px-5 py-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink">{row.title ?? "(제목 없음)"}</p>
                  <p className="text-[11px] text-ink-4">{formatKst(row.occurredAt, "—")}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {typeof row.viewCount === "number" ? <Badge tone="neutral">{row.viewCount.toLocaleString("ko-KR")} 조회</Badge> : null}
                  {row.href ? (
                    <a href={row.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline">
                      열기<ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="최근 댓글" desc={`${comments.length}건`} />
        {comments.length === 0 ? (
          <p className="px-5 pb-4 text-sm text-ink-4">데이터 없음</p>
        ) : (
          <ul className="divide-y divide-line">
            {comments.map((row) => (
              <li key={row.id} className="px-5 py-3 text-sm">
                <p className="text-ink-2">{row.text ?? "—"}</p>
                <p className="mt-0.5 text-[11px] text-ink-4">{formatKst(row.occurredAt, "—")}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
