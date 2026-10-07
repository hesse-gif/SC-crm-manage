"use client";

// Applications/지원서 tab (spec §5.3) — the IA-override fold-in point for application inbox/attribution/
// onboarding-UID state; deliberately renders straight from the read-model projection, no separate
// 지원관리 nav is created here.
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { formatKst } from "@/lib/datetime";
import type { ApplicationManagementProjection, AttributionState } from "@/lib/managementTabsData";

const ATTRIBUTION_LABEL: Record<AttributionState, string> = {
  managed: "관리됨",
  unclassified: "미분류",
  ambiguous: "모호",
  conflict: "충돌",
};

function attributionTone(state: AttributionState): "ok" | "warn" | "danger" | "neutral" {
  if (state === "managed") return "ok";
  if (state === "conflict") return "danger";
  if (state === "ambiguous") return "warn";
  return "neutral";
}

export function ManagementApplicationsTab({
  applications,
  programLabel,
  campaignLabel,
}: {
  applications: ApplicationManagementProjection[];
  /** 스코프에서 이미 해석된 표시 이름(Journey 탭과 같은 값). 없으면 raw id 를 그대로 둔다. */
  programLabel?: string;
  campaignLabel?: string;
}) {
  if (applications.length === 0) {
    return (
      <Card className="px-5 py-8 text-center text-sm text-ink-4">
        Portal 지원서가 없습니다.
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {applications.map((application, index) => (
        <Card key={application.applicationId}>
          <CardHeader
            title={`Portal 지원서 ${index + 1}`}
            desc={`제출 ${formatKst(application.submittedAt, "—")} · ${application.latestRevision}차 제출`}
            action={<Badge tone={attributionTone(application.attributionState)}>{ATTRIBUTION_LABEL[application.attributionState]}</Badge>}
          />
          <dl className="divide-y divide-line px-5 pb-4 text-sm">
            <div className="flex items-center justify-between py-2.5">
              <dt className="text-ink-3">프로그램 / 캠페인</dt>
              {/* U9/B2-7: read-model 이 programId·campaignId 를 실어 보내도 "프로그램 정보 미연결"을
                  하드코딩해 렌더하던 자리다(운영 실측 렌더 버그). 붙은 값은 그대로 보여주고,
                  정말 없을 때만 미연결이라고 말한다. */}
              <dd className="font-medium text-ink">
                {application.programId || application.campaignId
                  // W7-1e: 라벨이 넘어오면 raw id 대신 이름을 보여준다. 라벨이 없을 때의 표시는
                  // 종전과 같다(id 그대로) — 이름을 지어내지 않고, 원값은 title 로 남긴다.
                  ? (
                    <span title={`${application.programId ?? ""} / ${application.campaignId ?? ""}`.trim()}>
                      {`${programLabel || application.programId || "프로그램 미지정"} / ${campaignLabel || application.campaignId || "캠페인 미지정"}`}
                    </span>
                  )
                  : "프로그램 정보 미연결"}
              </dd>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <dt className="text-ink-3">주요 오디언스 국가</dt>
              <dd className="font-medium text-ink">{application.declaredPrimaryAudienceCountry ?? "—"}</dd>
            </div>
            {application.revokedAt ? (
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-ink-3">철회됨</dt>
                <dd className="font-medium text-danger">{formatKst(application.revokedAt, "—")}</dd>
              </div>
            ) : null}
          </dl>
        </Card>
      ))}
    </div>
  );
}
