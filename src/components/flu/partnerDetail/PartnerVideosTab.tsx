"use client";

// Videos tab (spec_partner_profile_tabs/spec.md §4.3) — one row per submission; revisions nest inside as
// an internal timeline. Superseded revisions are visually distinguished and never counted toward
// approval/tracking/settlement.
import { useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { ExternalLink, Youtube } from "@/components/icons";
import { formatKst } from "@/lib/datetime";
import type { PartnerVideo, PartnerVideoReviewStatus, VideoRevisionState } from "@/lib/partnerData";

const REVIEW_STATUS_LABEL: Record<PartnerVideoReviewStatus, string> = {
  pending: "대기",
  needs_review: "검수중",
  changes_requested: "변경요청",
  approved: "승인",
  rejected: "반려",
};

const REVISION_STATE_LABEL: Record<VideoRevisionState, string> = {
  current: "현재",
  superseded: "이전(superseded)",
  removed: "삭제됨",
};

function reviewTone(status: PartnerVideoReviewStatus): "ok" | "warn" | "danger" | "neutral" {
  if (status === "approved") return "ok";
  if (status === "rejected") return "danger";
  if (status === "needs_review" || status === "changes_requested") return "warn";
  return "neutral";
}

export function PartnerVideosTab({ videos }: { videos: PartnerVideo[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(videos[0]?.videoSubmissionId ?? null);

  if (videos.length === 0) {
    return (
      <div role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-5 py-8 text-center text-sm text-danger">
        active Partner인데 영상이 0건입니다 — 활성화 원장 불일치.
      </div>
    );
  }

  return (
    <Card>
      <CardHeader title="영상" desc={`${videos.length}건 · submission 1개당 1 row`} />
      <ul className="divide-y divide-line">
        {videos.map((video) => {
          const expanded = expandedId === video.videoSubmissionId;
          const currentRevisionRow = video.revisions.find((rev) => rev.revision === video.currentRevision) ?? null;
          return (
            <li key={video.videoSubmissionId} className="px-5 py-4">
              <button
                type="button"
                onClick={() => setExpandedId(expanded ? null : video.videoSubmissionId)}
                className="flex w-full items-center justify-between gap-3 text-left"
                aria-expanded={expanded}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar label={video.thumbnailUrl ?? video.title ?? "?"} size={40} />
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-ink" title={video.videoSubmissionId}>
                      {/* 제목이 안 붙으면 제출 UUID 를 제목 자리에 넣지 않는다 — 미확인이라고 밝힌다. */}
                      {video.title ?? "제목 미확인"}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-4">current rev.{video.currentRevision}</p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {currentRevisionRow ? <Badge tone={reviewTone(currentRevisionRow.reviewStatus)}>{REVIEW_STATUS_LABEL[currentRevisionRow.reviewStatus]}</Badge> : null}
                  <Badge tone={video.trackingEligible ? "ok" : "neutral"}>{video.trackingEligible ? "추적중" : "추적 대기"}</Badge>
                </div>
              </button>

              {expanded ? (
                <div className="mt-3 rounded-lg border border-line bg-fill/40 px-4 py-3">
                  <ul className="flex flex-col gap-2">
                    {video.revisions.map((revision) => (
                      <li key={revision.revision} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span className={`font-semibold ${revision.state === "current" ? "text-ink" : "text-ink-4"}`}>rev.{revision.revision}</span>
                          <Badge tone={revision.state === "current" ? "accent" : "neutral"}>{REVISION_STATE_LABEL[revision.state]}</Badge>
                          <Badge tone={reviewTone(revision.reviewStatus)}>{REVIEW_STATUS_LABEL[revision.reviewStatus]}</Badge>
                        </div>
                        <div className="flex items-center gap-2 text-ink-4">
                          <span>{formatKst(revision.submittedAtIso, "—")}</span>
                          <a href={revision.canonicalUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                            <Youtube className="h-3.5 w-3.5" aria-hidden="true" />
                            영상 열기
                            <ExternalLink className="h-3 w-3" aria-hidden="true" />
                          </a>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {!video.downstreamProjectionConfirmed ? (
                    <p className="mt-2 text-[11px] text-warn">downstream 확인 대기 — 추적/정산 미확정</p>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
