"use client";

// 콘텐츠·검수 tab (spec §5.5) — submission/revision review state + the immutable Partner-activation
// milestone. Activation link only ever appears once a current+approved revision exists in this list
// (spec §1 rule 7: the management screen never infers Partner status — it only ever displays evidence
// that a real approved-current revision produced).
import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ExternalLink, Youtube } from "@/components/icons";
import { formatKst } from "@/lib/datetime";
import type { VideoRevisionProjection, VideoReviewState } from "@/lib/managementTabsData";

const REVIEW_LABEL: Record<VideoReviewState, string> = {
  queued: "대기",
  in_review: "검수중",
  changes_requested: "변경요청",
  human_review_required: "사람 검토 필요",
  rejected: "반려",
  approved: "승인됨",
};

export function ManagementContentReviewTab({
  revisions,
  enrollmentId,
}: {
  revisions: VideoRevisionProjection[];
  enrollmentId?: string;
}) {
  if (revisions.length === 0) {
    return <Card className="px-5 py-8 text-center text-sm text-ink-4">아직 제출된 영상이 없습니다.</Card>;
  }

  const activationRevision = revisions.find((rev) => rev.isCurrentRevision && rev.reviewState === "approved");

  return (
    <div className="flex flex-col gap-4">
      {activationRevision && enrollmentId ? (
        <Card className="border-ok/30 bg-ok-soft px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-ok">
              rev.{activationRevision.revision} 승인으로 Partner 활성 근거가 생성되었습니다 · {formatKst(activationRevision.reviewedAt, "—")}
            </p>
            <Link
              href={`/flu/partners/${encodeURIComponent(enrollmentId)}`}
              className="inline-flex items-center gap-1 text-xs font-semibold text-ok hover:underline"
            >
              Partner 상세로 이동 <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </Link>
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="영상 제출·검수" desc={`${revisions.length}건`} />
        <ul className="divide-y divide-line">
          {revisions.map((revision) => (
            <li key={revision.revisionId} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5 text-sm">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 font-medium text-ink">
                  rev.{revision.revision}
                  {revision.isCurrentRevision ? <Badge tone="accent">현재</Badge> : <Badge tone="neutral">이전 버전</Badge>}
                </p>
                <p className="text-[11px] text-ink-4">제출 {formatKst(revision.submittedAt, "—")}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Badge tone={revision.analyzerStatus === "failed" ? "danger" : revision.analyzerStatus === "pending" ? "warn" : "neutral"}>
                  분석 {revision.analyzerStatus === "complete" ? "완료" : revision.analyzerStatus === "failed" ? "실패" : "대기"}
                </Badge>
                <span className="text-xs font-medium text-ink-3">검수 상태 · {REVIEW_LABEL[revision.reviewState]}</span>
                <a href={revision.canonicalUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                  <Youtube className="h-3.5 w-3.5" aria-hidden="true" />
                  영상 열기
                </a>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
