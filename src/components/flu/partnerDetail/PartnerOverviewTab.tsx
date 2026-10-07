"use client";

// Overview tab (spec_partner_profile_tabs/spec.md §4.1) — deliberately small: activation evidence,
// current approved video, attribution, next action, tracking/settlement summary. Raw IDs, full
// callbacks, and superseded revisions are never shown here.
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ExternalLink, Youtube } from "@/components/icons";
import { formatKst } from "@/lib/datetime";
import type { PartnerOverviewProjection } from "@/lib/partnerData";

export function PartnerOverviewTab({ overview }: { overview: PartnerOverviewProjection }) {
  const countryMismatch =
    overview.declaredAudienceCountry &&
    overview.verifiedAudienceCountry &&
    overview.declaredAudienceCountry !== overview.verifiedAudienceCountry;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="파트너 전환 근거" desc="승인 영상으로 Partner 전환" />
          <dl className="divide-y divide-line px-5 pb-4 text-sm">
            <div className="flex items-center justify-between py-2.5">
              <dt className="text-ink-3">승인 시각</dt>
              <dd className="font-medium text-ink">{formatKst(overview.activatedAtIso, "—")}</dd>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <dt className="text-ink-3">승인 revision</dt>
              <dd className="font-medium text-ink">{overview.activationEvidence ? `rev.${overview.activationEvidence.videoRevision}` : "—"}</dd>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <dt className="text-ink-3">판정</dt>
              <dd className="font-medium text-ink">
                {overview.activationEvidence ? (
                  <>
                    {overview.activationEvidence.reviewerKind === "ai_auto" ? "AI 승인" : "사람 승인"}
                    <span className="ml-1 text-xs text-ink-4">· {overview.activationEvidence.policyVersion}</span>
                  </>
                ) : (
                  "—"
                )}
              </dd>
            </div>
          </dl>
        </Card>

        <Card>
          <CardHeader title="현재 승인 영상" desc="current revision 한 건만 표시" />
          {overview.approvedVideo ? (
            <div className="px-5 pb-4">
              <a
                href={overview.approvedVideo.canonicalUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline"
              >
                <Youtube className="h-4 w-4" aria-hidden="true" />
                rev.{overview.approvedVideo.videoRevision} 영상 열기
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
              <p className="mt-1 text-xs text-ink-4">승인 {formatKst(overview.approvedVideo.approvedAtIso, "—")}</p>
            </div>
          ) : (
            <p className="px-5 pb-4 text-sm text-danger">현재 승인 revision 불일치 — Review 큐를 확인하세요.</p>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="유입·소속" />
          <div className="px-5 pb-4 text-sm text-ink-2">
            {overview.attribution ? (
              <p>
                {overview.attribution.classification === "unclassified" ? "미분류 유입" : `${overview.attribution.programId} · ${overview.attribution.campaignId ?? "미분류"}`}
              </p>
            ) : (
              <p className="text-ink-4">미분류 유입</p>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="다음 액션" />
          <div className="px-5 pb-4">
            {overview.nextAction ? (
              overview.nextAction.href ? (
                <a href={overview.nextAction.href} className="text-sm font-semibold text-accent hover:underline">
                  {overview.nextAction.label}
                </a>
              ) : (
                <p className="text-sm text-ink-2">{overview.nextAction.label}</p>
              )
            ) : (
              <p className="text-sm text-ink-4">추가 조치가 필요하지 않습니다.</p>
            )}
            {overview.highestPriorityBlocker ? (
              <Badge tone={overview.highestPriorityBlocker.severity === "critical" ? "danger" : "warn"} className="mt-2">
                {overview.highestPriorityBlocker.label}
              </Badge>
            ) : null}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="상태 요약" desc="추적 · 정산 적격 · 오디언스 국가 · 데이터 신선도" />
        <div className="grid grid-cols-2 gap-4 px-5 pb-5 sm:grid-cols-4">
          <div>
            <p className="text-[11px] text-ink-4">조회수 추적</p>
            <Badge tone={overview.trackingEligible ? "ok" : "neutral"}>{overview.trackingEligible ? "추적 중" : overview.trackingBlockedReasonCode ?? "대기"}</Badge>
          </div>
          <div>
            <p className="text-[11px] text-ink-4">정산 적격</p>
            <Badge tone={overview.settlementEligible ? "ok" : "neutral"}>{overview.settlementEligible ? "적격" : overview.settlementBlockedReasonCode ?? "대기"}</Badge>
          </div>
          <div>
            <p className="text-[11px] text-ink-4">오디언스 국가</p>
            <p className="text-sm font-medium text-ink">
              {overview.declaredAudienceCountry ?? "—"}
              {overview.verifiedAudienceCountry ? ` / 검증 ${overview.verifiedAudienceCountry}` : ""}
            </p>
            {countryMismatch ? <p className="mt-0.5 text-[11px] text-warn">국가 확인 필요</p> : null}
          </div>
          <div>
            <p className="text-[11px] text-ink-4">활성화 상태</p>
            <Badge tone={overview.status === "active" ? "ok" : "danger"}>{overview.status}</Badge>
          </div>
        </div>
      </Card>
    </div>
  );
}
