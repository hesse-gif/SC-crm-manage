"use client";

import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { ROLES, type BehaviorLog } from "@/lib/data"
import { useLive, useLiveBehaviorLogs } from "@/lib/live";

export default function LogsPage() {
  const { data } = useLive();
  const behaviorLogs = useLiveBehaviorLogs<BehaviorLog>([]);
  const totalBehaviorLogs = data?.counts?.behaviorLogs ?? 0;
  const isTruncated = totalBehaviorLogs > behaviorLogs.length && behaviorLogs.length > 0;
  return (
    <div className="mx-auto max-w-content px-6 py-7">
      <PageHeader
        title="행동 로그"
        desc="9필드 감사 로그 (userId·Role·team·gameId·action·time·IP·result·cost) · §14"
      />

      {isTruncated ? (
        <div
          data-testid="truncation-indicator"
          className="mb-4 flex items-center justify-between rounded-lg border border-warn/40 bg-warn-soft px-4 py-2.5 text-sm text-warn"
        >
          <span>전체 {totalBehaviorLogs.toLocaleString()}건 중 {behaviorLogs.length}건 표시</span>
          <span className="text-xs font-semibold">더보기 준비 중</span>
        </div>
      ) : null}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-line bg-fill text-xs font-semibold text-ink-3">
                <th className="px-4 py-2.5 text-left">시간</th>
                <th className="px-4 py-2.5 text-left">사용자</th>
                <th className="px-4 py-2.5 text-left">역할</th>
                <th className="px-4 py-2.5 text-left">팀</th>
                <th className="px-4 py-2.5 text-left">gameId</th>
                <th className="px-4 py-2.5 text-left">action</th>
                <th className="px-4 py-2.5 text-left">IP</th>
                <th className="px-4 py-2.5 text-left">결과</th>
                <th className="px-4 py-2.5 text-right">비용</th>
              </tr>
            </thead>
            <tbody>
              {behaviorLogs.map((log) => {
                const roleMeta = ROLES[log.role];
                const resultTone =
                  log.result === "success"
                    ? "ok"
                    : log.result === "denied"
                      ? "danger"
                      : "warn";
                const resultLabel =
                  log.result === "success"
                    ? "success"
                    : log.result === "denied"
                      ? "denied"
                      : "error";
                return (
                  <tr
                    key={log.id}
                    className={
                      "border-b border-line last:border-0 " +
                      (log.result === "denied"
                        ? "bg-danger-soft/40"
                        : "")
                    }
                  >
                    <td className="px-4 py-2.5 text-[11px] text-ink-3">{log.time}</td>
                    <td className="px-4 py-2.5 text-[12px] font-medium text-ink">{log.userId}</td>
                    <td className="px-4 py-2.5">
                      <Badge tone={roleMeta.tone}>{roleMeta.label}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-[12px] text-ink-2">{log.team}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-2">{log.gameId}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-2">{log.action}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-3">{log.ip}</td>
                    <td className="px-4 py-2.5">
                      <Badge tone={resultTone}>{resultLabel}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-right text-[12px] text-ink-2">
                      {log.costKRW > 0 ? `₩${log.costKRW}` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
