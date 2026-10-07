"use client";

// Journey tab (spec_partner_profile_tabs/spec.md §4.2) — append-only provenance timeline. Stepper shows
// only each stage's final status; the list below shows every event. Unattributed direct applicants show
// "미분류"/"직접 지원" rather than a fabricated campaign.
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { formatKst } from "@/lib/datetime";
import type { PartnerJourneyData, PartnerJourneyStage } from "@/lib/partnerData";

const STAGE_LABELS: Record<PartnerJourneyStage, string> = {
  program: "프로그램",
  campaign: "캠페인",
  outreach: "아웃리치",
  apply: "지원",
  enrollment: "등록",
  onboarding: "온보딩",
  video_submitted: "영상 제출",
  video_approved: "영상 승인",
  partner_active: "파트너 활성화",
};

const ACTOR_LABELS: Record<PartnerJourneyData["events"][number]["actor"], string> = {
  creator: "크리에이터",
  operator: "운영자",
  flu_automation: "Flu 자동화",
  portal: "Portal",
  ai: "AI",
};

function formatMissingEvidenceLabel(label: string | null | undefined) {
  if (!label) return "";
  return label.endsWith("_evidence_missing") ? "근거 확인 필요" : label;
}

export function PartnerJourneyTab({ journey }: { journey: PartnerJourneyData }) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <ol className="flex flex-wrap items-center gap-2 px-5 py-4 text-xs">
          {journey.stages.map((stage, index) => (
            <li key={stage.stage} className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold ${
                  stage.complete ? "bg-ok-soft text-ok" : stage.critical ? "bg-danger-soft text-danger" : "bg-fill text-ink-3"
                }`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                {STAGE_LABELS[stage.stage]}
                {!stage.complete && stage.missingLabel ? ` · ${formatMissingEvidenceLabel(stage.missingLabel)}` : ""}
              </span>
              {index < journey.stages.length - 1 ? <span className="text-ink-4">→</span> : null}
            </li>
          ))}
        </ol>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="파트너 여정 타임라인" desc="여정 이벤트를 발생 시각 기준으로 정렬" />
          {journey.events.length === 0 ? (
            <p className="px-5 pb-8 text-center text-sm text-danger">여정 이벤트가 없습니다 — 데이터 무결성 오류.</p>
          ) : (
            <ul className="divide-y divide-line">
              {journey.events.map((event) => (
                <li key={event.eventId} className="px-5 py-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-ink">{STAGE_LABELS[event.stage]}</p>
                    <div className="flex items-center gap-1.5">
                      {event.delayedReceipt ? <Badge tone="warn">지연 수신</Badge> : null}
                      <Badge tone={event.confidence === "verified" ? "ok" : "neutral"}>{event.confidence === "verified" ? "검증" : "추정"}</Badge>
                    </div>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-4">
                    {formatKst(event.occurredAtIso, "—")} · {ACTOR_LABELS[event.actor]}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="유입 근거" />
          <div className="px-5 pb-4 text-sm">
            {journey.attribution ? (
              <dl className="divide-y divide-line">
                <div className="flex justify-between py-2">
                  <dt className="text-ink-3">분류</dt>
                  <dd className="font-medium text-ink">{journey.attribution.classification === "unclassified" ? "미분류" : "관리됨"}</dd>
                </div>
                <div className="flex justify-between py-2">
                  <dt className="text-ink-3">프로그램</dt>
                  <dd className="font-medium text-ink">{journey.attribution.programId ? "연결됨" : "미연결"}</dd>
                </div>
                <div className="flex justify-between py-2">
                  <dt className="text-ink-3">캠페인</dt>
                  <dd className="font-medium text-ink">{journey.attribution.campaignId ? "연결됨" : "미분류"}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-ink-4">직접 지원 · 근거 없음</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
