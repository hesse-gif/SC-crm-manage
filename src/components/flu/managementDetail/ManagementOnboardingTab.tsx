"use client";

// Onboarding tab (spec §5.4) — mail/grant/UID/Gem progression, no protected material ever surfaced
// (values stay hidden; only submitted/verified booleans and receipt refs are shown).
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { formatKst } from "@/lib/datetime";
import type { OnboardingStepRow } from "@/lib/managementTabsData";

const STATUS_LABEL: Record<NonNullable<OnboardingStepRow["status"]>, string> = {
  unsent: "미발송",
  queued: "대기",
  sent: "발송됨",
  delivered: "전달됨",
  bounced: "반송",
  failed: "실패",
  submitted: "제출됨",
  verified: "검증됨",
};

function statusTone(status: OnboardingStepRow["status"]): "ok" | "warn" | "danger" | "neutral" {
  if (status === "delivered" || status === "verified") return "ok";
  if (status === "bounced" || status === "failed") return "danger";
  if (status === "queued" || status === "sent" || status === "submitted") return "warn";
  return "neutral";
}

export function ManagementOnboardingTab({ steps }: { steps: OnboardingStepRow[] }) {
  if (steps.length === 0) {
    return <Card className="px-5 py-8 text-center text-sm text-ink-4">온보딩 단계 데이터가 없습니다.</Card>;
  }

  return (
    <Card>
      <CardHeader title="온보딩 진행" desc="UID 원문/제출 값은 표시하지 않습니다" />
      <ul className="divide-y divide-line">
        {steps.map((step) => (
          <li key={step.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 text-sm">
            <div>
              <p className="font-medium text-ink">{step.stepLabel}</p>
              <p className="text-[11px] text-ink-4">
                {step.requestedAt ? `요청 ${formatKst(step.requestedAt, "—")}` : ""}
                {step.completedAt ? ` · 완료 ${formatKst(step.completedAt, "—")}` : ""}
                {step.retryState ? ` · ${step.retryState}` : ""}
              </p>
            </div>
            <Badge tone={statusTone(step.status)}>{step.status ? STATUS_LABEL[step.status] : "—"}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}
