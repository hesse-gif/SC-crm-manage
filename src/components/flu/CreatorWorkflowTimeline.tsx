"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Card, CardHeader } from "@/components/ui/Card";
import {
  buildScpLifecycleMacroTimeline,
  type ScpLifecycleMacroTimelineItem,
  type ScpLifecycleTimelineStatus,
} from "@/lib/workflow-timeline";
import { useScpLifecycleFlow, type ScpLifecycleState } from "@/lib/scp-lifecycle-flow";

function assertNever(value: never): never {
  throw new Error(`Unexpected workflow value: ${value}`);
}

type ScpLifecycleTimelineProfile = {
  readonly currentState: ScpLifecycleState | "identity_conflict";
  readonly stateEnteredAt?: string;
  readonly projectionStatus?: "fresh" | "stale" | "failed" | "rebuilding";
  readonly programId?: string;
};

function timelineStatusLabel(status: ScpLifecycleTimelineStatus): string {
  switch (status) {
    case "done":
      return "완료";
    case "current":
      return "진행 중";
    case "pending":
      return "대기";
    default:
      return assertNever(status);
  }
}

function macroHeaderClass(item: ScpLifecycleMacroTimelineItem): string {
  if (item.status === "done") return "border-accent/25 bg-accent-soft/30";
  if (item.status === "current") return "border-accent bg-paper shadow-sm ring-2 ring-accent/20";
  return "border-line bg-fill";
}

function detailMarkerClass(status: ScpLifecycleTimelineStatus): string {
  if (status === "done") return "bg-accent text-white";
  if (status === "current") return "bg-accent text-white ring-2 ring-accent/25";
  return "bg-fill text-ink-4";
}

export function ScpLifecycleTimelinePanel({ profile }: { profile: ScpLifecycleTimelineProfile }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { flow, loading, warning } = useScpLifecycleFlow(profile.programId);
  const identityConflict = profile.currentState === "identity_conflict";
  const phases = identityConflict ? [] : buildScpLifecycleMacroTimeline({ currentState: profile.currentState, flow });
  const currentPhase = phases.find((phase) => phase.current);

  if (identityConflict) {
    return (
      <Card>
        <CardHeader title="SCP lifecycle timeline" desc="자동화가 신원 충돌로 중단되었습니다" />
        <div className="border-t border-line p-5">
          <div role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-4 text-sm text-danger">
            <div className="font-bold">신원 충돌 확인 필요</div>
            <p className="mt-1 text-xs leading-relaxed">서로 다른 지원·메일·제출 기록이 한 사람으로 합쳐졌거나 자격 판정이 충돌합니다. 사람 확인 전에는 완료 단계로 표시하지 않고 자동화를 차단합니다.</p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="relative h-full">
      <CardHeader
        title="SCP lifecycle timeline"
        desc={currentPhase ? `현재 ${currentPhase.label} · 세부 단계는 클릭해서 펼칩니다` : "세부 단계는 클릭해서 펼칩니다"}
        action={loading ? <span className="text-[11px] font-semibold text-ink-4">flow 확인 중</span> : undefined}
      />
      {warning ? (
        <div className="mx-5 mb-3 rounded-md border border-warn/40 bg-warn-soft/40 px-3 py-2 text-[11px] text-ink-2">
          {warning}
        </div>
      ) : null}
      <div className="border-t border-line px-5 py-4">
        <div className="grid gap-2 md:grid-cols-5" role="list" aria-label="SCP lifecycle macro phases">
          {phases.map((phase, index) => {
            const expanded = expandedId === phase.id;
            return (
              <div key={phase.id} role="listitem" className="min-w-0">
                <button
                  type="button"
                  data-testid="scp-macro-phase"
                  aria-expanded={expanded}
                  aria-controls={`scp-macro-detail-${phase.id}`}
                  onClick={() => setExpandedId(expanded ? null : phase.id)}
                  className={[
                    "flex h-full min-h-[126px] w-full min-w-0 flex-col rounded-lg border px-3 py-3 text-left transition hover:border-accent/50",
                    macroHeaderClass(phase),
                  ].join(" ")}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[11px] font-bold text-ink-4">{index + 1}</span>
                    <Badge tone={phase.status === "current" ? "accent" : phase.status === "done" ? "ok" : "neutral"}>
                      {timelineStatusLabel(phase.status)}
                    </Badge>
                  </div>
                  <div className="mt-2 truncate text-sm font-bold text-ink">{phase.label}</div>
                  <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-ink-4">{phase.description}</div>
                  <div className="mt-2 text-[11px] font-semibold text-ink-3">{phase.detailCount}개 세부 단계</div>
                </button>
              </div>
            );
          })}
        </div>
        {phases.map((phase) => {
          const expanded = expandedId === phase.id;
          if (!expanded) return null;
          return (
            <div
              key={`detail-${phase.id}`}
              id={`scp-macro-detail-${phase.id}`}
              className="mt-3 rounded-lg border border-line"
            >
              <div className="border-b border-line bg-fill px-3 py-2 text-[12px] font-bold text-ink">
                {phase.label} 세부 단계
              </div>
              <div className="divide-y divide-line">
                {phase.details.map((detail, index) => (
                  <div key={detail.state} data-testid="scp-detail-state" className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={["flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold", detailMarkerClass(detail.status)].join(" ")}>
                        {detail.status === "done" ? "✓" : index + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-ink">{detail.label}</div>
                        <div className="truncate text-[10px] text-ink-4">{detail.state}</div>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-1">
                      <Badge tone={detail.status === "current" ? "accent" : detail.status === "done" ? "ok" : "neutral"}>
                        {timelineStatusLabel(detail.status)}
                      </Badge>
                      {detail.gate ? <Badge tone="warn">게이트</Badge> : null}
                      {detail.terminal ? <Badge tone="danger">종료</Badge> : null}
                      {detail.hidden ? <Badge tone="neutral">숨김</Badge> : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}


export function CreatorWorkflowTimelinePanel({ currentState }: { currentState: ScpLifecycleState }) {
  const { flow, loading, warning } = useScpLifecycleFlow();
  const phases = buildScpLifecycleMacroTimeline({ currentState, flow });
  const currentPhase = phases.find((phase) => phase.current);

  return (
    <Card className="relative h-full">
      <CardHeader
        title="매크로 타임라인"
        desc={currentPhase ? `현재 ${currentPhase.label} · 레거시 5단계 대신 공유 매크로 단계로 표시합니다` : "레거시 5단계 대신 공유 매크로 단계로 표시합니다"}
        action={loading ? <span className="text-[11px] font-semibold text-ink-4">flow 확인 중</span> : undefined}
      />
      {warning ? (
        <div className="mx-5 mb-3 rounded-md border border-warn/40 bg-warn-soft/40 px-3 py-2 text-[11px] text-ink-2">
          {warning}
        </div>
      ) : null}
      <div className="border-t border-line px-5 py-4">
        <div className="grid auto-rows-fr gap-2 sm:grid-cols-2 xl:grid-cols-5" role="list" aria-label="Creator macro lifecycle phases">
          {phases.map((phase, index) => (
            <div key={phase.id} role="listitem" className="min-w-0">
              <div
                data-testid="scp-macro-phase"
                className={[
                  "flex h-full min-h-[126px] w-full min-w-0 flex-col rounded-lg border px-3 py-3 text-left",
                  macroHeaderClass(phase),
                ].join(" ")}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[11px] font-bold text-ink-4">{index + 1}</span>
                  <Badge tone={phase.status === "current" ? "accent" : phase.status === "done" ? "ok" : "neutral"}>
                    {timelineStatusLabel(phase.status)}
                  </Badge>
                </div>
                <div className="mt-2 truncate text-sm font-bold text-ink">{phase.label}</div>
                <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-ink-4">{phase.description}</div>
                <div className="mt-auto pt-2 text-[11px] font-semibold text-ink-3">{phase.detailCount}개 세부 단계</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
