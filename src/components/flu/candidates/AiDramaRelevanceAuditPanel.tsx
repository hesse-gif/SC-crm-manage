"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { listAiDramaRelevanceAudit, type AiDramaRelevanceAuditRow } from "@/lib/data";
import { aiDramaRelevanceReasonLabel, aiDramaRelevanceTone } from "./AiDramaRelevanceBadge";

// Small, standalone panel on purpose — self-fetching, collapsed by default, and touches page.tsx
// through a single render call (헤세 2026-09-27: keep the row-level change a small badge and put the
// audit surface elsewhere so it doesn't collide with the candidate-big-thumbs work on CandidateTable).
// Shows what the ai_drama JEV relevance gate DROPPED (rejected/held), not what it kept — for auditing
// the gate itself, not for browsing candidates.

type VerdictFilter = "all" | "rejected" | "held";

const VERDICT_LABEL: Record<VerdictFilter, string> = {
  all: "전체",
  rejected: "거부",
  held: "보류",
};

function verdictTone(row: AiDramaRelevanceAuditRow): "danger" | "neutral" {
  return row.verdict === "rejected" ? "danger" : "neutral";
}

function formatJudgedAt(judgedAtIso: string): string {
  if (!judgedAtIso) return "—";
  const parsed = new Date(judgedAtIso);
  return Number.isNaN(parsed.getTime()) ? judgedAtIso : parsed.toLocaleString("ko-KR");
}

export function AiDramaRelevanceAuditPanel({ campaignId }: { campaignId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>("all");
  const [rows, setRows] = useState<AiDramaRelevanceAuditRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!campaignId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listAiDramaRelevanceAudit({ campaignId, verdict: verdictFilter });
      setRows(result.rows);
    } catch {
      setError("감사 목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [campaignId, verdictFilter]);

  useEffect(() => {
    if (expanded) void load();
  }, [expanded, load]);

  return (
    <Card className="mt-4">
      <CardHeader
        title="AI 드라마 관련도 감사"
        desc="JEV 관련성 게이트가 거부(rejected)/보류(held)로 제외한 채널 — 점수·사유 확인용"
        action={
          <Button variant="secondary" size="sm" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "접기" : "펼치기"}
          </Button>
        }
      />
      {expanded && (
        <div className="p-4">
          <div className="mb-3 flex items-center gap-1.5">
            {(Object.keys(VERDICT_LABEL) as VerdictFilter[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setVerdictFilter(option)}
                className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                  verdictFilter === option ? "bg-accent text-white" : "bg-fill text-ink-2 hover:bg-fill/70"
                }`}
              >
                {VERDICT_LABEL[option]}
              </button>
            ))}
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              새로고침
            </Button>
          </div>

          {loading && <p className="text-xs text-ink-3">불러오는 중…</p>}
          {!loading && error && <p className="text-xs font-medium text-danger">{error}</p>}
          {!loading && !error && rows && rows.length === 0 && (
            <p className="text-xs text-ink-3">해당 조건으로 제외된 채널이 없습니다.</p>
          )}
          {!loading && !error && rows && rows.length > 0 && (
            <ul className="divide-y divide-line">
              {rows.map((row) => (
                <li key={row.channelId} className="flex flex-wrap items-center gap-2 py-2 text-xs">
                  <span className="min-w-[160px] font-medium text-ink">{row.channelName || row.channelId}</span>
                  <Badge tone={verdictTone(row)}>{row.verdict === "rejected" ? "거부" : "보류"}</Badge>
                  {row.scorePercent !== null && (
                    <Badge tone={aiDramaRelevanceTone(row.scorePercent)}>{row.scorePercent}%</Badge>
                  )}
                  <span className="text-ink-3">{aiDramaRelevanceReasonLabel(row.reason)}</span>
                  <span className="ml-auto text-ink-4">{formatJudgedAt(row.judgedAtIso)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
