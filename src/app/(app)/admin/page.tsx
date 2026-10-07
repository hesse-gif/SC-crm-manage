"use client";

import Link from "next/link";
import { externalFluHref } from "@/lib/flu-external-link";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { WorkflowActionMenu } from "@/components/ui/WorkflowActionMenu";
import { Alert } from "@/components/icons";
import { STAGES,
fmtKRW,
type Member,
type Creator,
type Escalation, } from "@/lib/data"
import { useLiveMembers, useLiveCreators, useLiveEscalations } from "@/lib/live";
import MailAdminControlsCard from "./MailAdminControlsCard";
import MailLaneSwitchesCard from "../flu/settings/MailLaneSwitchesCard";

function isVisibleCreator(creator: Creator): boolean {
  return !creator.deletedAt && !creator.archivedAt;
}

function isVisibleEscalation(escalation: Escalation): boolean {
  return !escalation.deletedAt && !escalation.archivedAt;
}

export default function AdminPage() {
  const members = useLiveMembers<Member>([]);
  const creators = useLiveCreators<Creator>([]).filter(isVisibleCreator);
  const escalations = useLiveEscalations<Escalation>([]).filter(isVisibleEscalation);

  const totalMembers = members.length;
  const activeMembers = members.filter((m) => m.status === "active").length;
  const managers = members.filter((m) => m.role === "manager");

  return (
    <div className="mx-auto max-w-content px-6 py-7">
      <PageHeader
        title="전사 현황"
        desc="팀·담당자 전체 운영 현황 (Super Admin)"
      />

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4">
          <div className="text-xs font-medium text-ink-3">전체 멤버</div>
          <div className="mt-2 text-[28px] font-bold leading-none text-ink">
            {totalMembers}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs font-medium text-ink-3">활성</div>
          <div className="mt-2 text-[28px] font-bold leading-none text-ink">
            {activeMembers}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs font-medium text-ink-3">진행 협업</div>
          <div className="mt-2 text-[28px] font-bold leading-none text-ink">
            {creators.length}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs font-medium text-ink-3">사람 검수 필요</div>
          <div className="mt-2 flex items-end justify-between">
            <div className="text-[28px] font-bold leading-none text-danger">
              {escalations.length}
            </div>
            <Badge tone="danger">{escalations.length}건</Badge>
          </div>
        </Card>
      </div>

      {/* 담당자별 현황 */}
      <Card className="mt-6">
        <CardHeader
          title="담당자별 현황"
          desc="Manager 역할 기준 담당 협업 파이프라인"
        />
        <div>
          {managers.map((m) => {
            const owned = creators.filter((c) => c.owner === m.name);
            const stageCounts = STAGES.map((s) => ({
              ...s,
              count: owned.filter((c) => c.stage === s.key).length,
            })).filter((s) => s.count > 0);

            return (
              <div
                key={m.id}
                className="flex items-center gap-4 border-b border-line px-5 py-3.5 last:border-0"
              >
                <Avatar label={m.avatar} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-ink">
                      {m.name}
                    </span>
                    <span className="text-xs text-ink-3">{m.team}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-ink-3">
                    담당 {m.assigned}명
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  {stageCounts.length > 0 ? (
                    stageCounts.map((s) => (
                      <span
                        key={s.key}
                        className="inline-flex items-center gap-1 rounded-full bg-fill px-2 py-0.5 text-[11px] font-semibold text-ink-2"
                      >
                        {s.label}
                        <span className="font-bold text-ink">{s.count}</span>
                      </span>
                    ))
                  ) : (
                    <span className="text-xs text-ink-4">없음</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* 전사 에스컬레이션 */}
      <Card className="mt-6 border-danger/30">
        <CardHeader
          title="전사 에스컬레이션"
          desc="AI 자동 처리가 중단된 건 — 승인 또는 반려 필요"
          action={
            <Badge tone="danger" dot>
              {escalations.length}건
            </Badge>
          }
        />
        <div>
          {escalations.map((e) => {
            const c = creators.find((cr) => cr.id === e.creatorId);
            const over = e.overPct >= 0;
            return (
              <div
                key={e.id}
                className="flex items-center gap-3 border-b border-line px-5 py-3.5 last:border-0"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-danger-soft text-danger">
                  <Alert className="h-[18px] w-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                    {c?.name}
                    <span className="text-ink-3">·</span>
                    <span className="text-xs font-normal text-ink-2">
                      {e.reason}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-ink-3">
                    요청 ₩{fmtKRW(e.requestedKRW)} / 가이드 상한 ₩
                    {fmtKRW(e.guideMaxKRW)} ·{" "}
                    <span
                      className={
                        over
                          ? "font-semibold text-danger"
                          : "font-semibold text-warn"
                      }
                    >
                      {over
                        ? `상한 ${e.overPct}% 초과`
                        : `상한 ${Math.abs(e.overPct)}% 근접`}
                    </span>{" "}
                    · {e.time}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {c ? (
                    <Link
                      href={externalFluHref(`/flu/influencers/${encodeURIComponent(c.id)}`)}
                      className="inline-flex min-h-10 items-center rounded-md border border-line bg-paper px-3 text-[13px] font-semibold text-ink-2 transition-[color,background-color,border-color] hover:bg-fill"
                    >
                      협업 열기
                    </Link>
                  ) : (
                    <Badge tone="warn">연결된 협업 없음</Badge>
                  )}
                  <WorkflowActionMenu
                    entity="escalation"
                    id={e.id}
                    label={`${c?.name ?? e.creatorId} ${e.reason}`}
                    compact
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="mt-6 space-y-6" data-testid="admin-mail-controls">
        <MailAdminControlsCard />
        <MailLaneSwitchesCard />
      </div>
    </div>
  );
}
