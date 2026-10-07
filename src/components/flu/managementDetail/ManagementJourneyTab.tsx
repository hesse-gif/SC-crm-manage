"use client";

// Journey tab (spec_creator_management_profile_tabs/spec.md §5.1) — 6-step stepper (발굴 → 콜드메일 →
// 지원 → 온보딩 → 영상 검수 → Partner) plus 유입 경로 / 최근 활동 cards, matching mockup 06. The
// underlying `JourneyStage` ledger has 10 values (spec §6); this UI consolidates them into the spec's
// explicit 6 stepper boxes (지원 groups applied+qualified; 온보딩 groups onboarding_sent/uid_submitted/
// gem_sent; 영상 검수 groups content_submitted+video_reviewed) — a documented, deliberate grouping, not
// a new source of truth.
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Check, Doc, Chat, Users } from "@/components/icons";
import { formatKst } from "@/lib/datetime";
import type { JourneyEvent, JourneyStage } from "@/lib/managementTabsData";

const STEPS: ReadonlyArray<{ key: string; label: string; stages: readonly JourneyStage[] }> = [
  { key: "discovered", label: "발굴", stages: ["discovered"] },
  // 스텝퍼는 스펙대로 6칸을 유지한다. 답장은 아웃리치 왕복의 일부이므로 콜드메일 칸에 함께 묶고,
  // 최근 활동 줄에서는 아래 STAGE_LABEL 로 "답장 수신"이라고 정확히 적는다.
  { key: "coldmail_sent", label: "콜드메일", stages: ["coldmail_sent", "replied"] },
  { key: "applied", label: "지원", stages: ["applied", "qualified"] },
  { key: "onboarding_sent", label: "온보딩", stages: ["onboarding_sent", "uid_submitted", "gem_sent"] },
  { key: "video_reviewed", label: "영상 검수", stages: ["content_submitted", "video_reviewed"] },
  { key: "partner_active", label: "Partner", stages: ["partner_active"] },
];

const ACTOR_ICON: Record<JourneyEvent["actor"], typeof Doc> = {
  creator: Users,
  operator: Doc,
  flu_automation: Check,
  portal: Doc,
  ai: Chat,
};

function latestOccurredAt(events: readonly JourneyEvent[], stages: readonly JourneyStage[]): string | undefined {
  return events
    .filter((event) => stages.includes(event.stage))
    .map((event) => event.occurredAt)
    .sort()
    .at(-1);
}

export function ManagementJourneyTab({
  events,
  programLabel,
  campaignLabel,
  coldmailBasisLabel,
}: {
  events: JourneyEvent[];
  programLabel?: string;
  campaignLabel?: string;
  coldmailBasisLabel?: string;
}) {
  const currentStepIndex = STEPS.reduce((acc, step, index) => (latestOccurredAt(events, step.stages) ? index : acc), -1);
  const recent = [...events].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 5);

  if (events.length === 0) {
    return (
      <Card className="px-5 py-8 text-center text-sm text-ink-4">
        진행 이벤트가 아직 없습니다
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="px-5 py-6">
        <ol className="flex flex-wrap items-start gap-1">
          {STEPS.map((step, index) => {
            const done = index < currentStepIndex;
            const current = index === currentStepIndex;
            const occurredAt = latestOccurredAt(events, step.stages);
            return (
              <li key={step.key} className="flex flex-1 min-w-[92px] flex-col items-center gap-1.5 px-1 text-center">
                <div className="flex w-full items-center">
                  <span
                    className={`mx-auto flex h-9 w-9 items-center justify-center rounded-full border-2 text-xs font-bold ${
                      done
                        ? "border-ok bg-ok-soft text-ok"
                        : current
                          ? "border-accent bg-accent-soft text-accent"
                          : "border-line bg-fill text-ink-4"
                    }`}
                  >
                    {done ? <Check className="h-4 w-4" aria-hidden="true" /> : String(index + 1).padStart(2, "0")}
                  </span>
                </div>
                <p className="text-xs font-semibold text-ink">{step.label}</p>
                <p className="text-[11px] text-ink-4">{current ? "현재 단계" : occurredAt ? formatKst(occurredAt, "—").slice(0, 10) : "대기"}</p>
              </li>
            );
          })}
        </ol>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="유입 경로" />
          <dl className="divide-y divide-line px-5 pb-4 text-sm">
            <div className="flex items-center justify-between py-2.5">
              <dt className="text-ink-3">프로그램</dt>
              <dd className="font-medium text-ink">{programLabel ?? "미분류"}</dd>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <dt className="text-ink-3">캠페인</dt>
              <dd className="font-medium text-ink">{campaignLabel ?? "미분류"}</dd>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <dt className="text-ink-3">콜드메일 근거</dt>
              <dd className="font-medium text-ink">{coldmailBasisLabel ?? "—"}</dd>
            </div>
          </dl>
        </Card>

        <Card>
          <CardHeader title="최근 활동" />
          <ul className="divide-y divide-line">
            {recent.map((event) => {
              const Icon = ACTOR_ICON[event.actor];
              return (
                <li key={event.eventId} className="flex items-center gap-3 px-5 py-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fill text-ink-3">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{stepLabel(event.stage)}</p>
                    <p className="text-[11px] text-ink-4">{formatKst(event.occurredAt, "—")}</p>
                  </div>
                  <Badge tone={event.confidence === "verified" ? "ok" : "neutral"}>{event.confidence === "verified" ? "검증" : "추정"}</Badge>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </div>
  );
}

// 스텝퍼 칸 이름과 개별 이벤트 이름은 다르다. 한 칸에 두 stage 가 묶이면 칸 이름만으로는
// 무슨 일이 있었는지 알 수 없다 — 활동 줄에는 stage 고유 문구를 쓴다.
const STAGE_LABEL: Partial<Record<JourneyStage, string>> = {
  coldmail_sent: "콜드메일 발송",
  replied: "답장 수신",
};

function stepLabel(stage: JourneyStage): string {
  const step = STEPS.find((candidate) => candidate.stages.includes(stage));
  return STAGE_LABEL[stage] ?? step?.label ?? stage;
}
