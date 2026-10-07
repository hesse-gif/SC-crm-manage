"use client";

// Tier-A stable header (spec_creator_management_profile_tabs/spec.md §3.1) — renders immediately and
// independently of every tab. Profile image follows the same canonical source preference as Partner:
// verified YouTube OAuth thumbnail → Flu canonical channel image → YouTube Data API thumbnail → explicit
// localized disconnected/recovery state. It never falls back to unexplained initials.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { ExternalLink } from "@/components/icons";
import { formatKst } from "@/lib/datetime";
import type { ManagementProfileImageProjection } from "@/lib/managementProfileImage";

export interface ManagementHeaderIdentity {
  displayName: string;
  handle?: string;
  profileImage: ManagementProfileImageProjection;
  platform: string;
  followers?: number;
  region?: string;
  owner?: string;
}

export interface ManagementPartnerLink {
  enrollmentId: string;
  activatedAt?: string;
}

export function ManagementProfileHeader({
  identity,
  active,
  partnerLink,
}: {
  identity: ManagementHeaderIdentity;
  active: boolean;
  partnerLink?: ManagementPartnerLink;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = identity.profileImage.url;

  useEffect(() => {
    setImageFailed(false);
  }, [imageUrl]);

  const imageStatusLabel = imageFailed ? identity.profileImage.recoveryLabel : identity.profileImage.statusLabel;

  return (
    <div className="rounded-xl border border-line bg-paper px-6 py-5" data-testid="management-profile-header">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex flex-col items-center gap-1.5">
            <div
              className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-fill text-center text-[11px] font-bold leading-tight text-ink-3 outline outline-1 -outline-offset-1 outline-black/10"
              data-testid="management-profile-image"
              title={imageStatusLabel}
              aria-label={imageStatusLabel}
            >
              {imageUrl && !imageFailed ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={imageUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  onError={() => setImageFailed(true)}
                  className="h-full w-full object-cover"
                />
              ) : imageFailed ? (
                <span>이미지<br />복구 필요</span>
              ) : (
                <span>이미지<br />미연결</span>
              )}
            </div>
            {/* 이미지 출처(YouTube Data API 등)는 내부 정보다 — 운영자가 할 일이 없으므로 캡션에서
                내린다. 이미지를 못 붙였을 때만, 그 사실을 알아야 하므로 남긴다.
                (전체 상태 문구는 아바타 툴팁으로 계속 확인할 수 있다.) */}
            {!imageUrl || imageFailed ? (
              <span className="text-[10px] font-semibold text-warn">{imageStatusLabel}</span>
            ) : null}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-bold text-ink">{identity.displayName}</h1>
              <Badge tone={active ? "ok" : "info"} dot>
                {active ? "활동 중" : "활동 전"}
              </Badge>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-ink-3">
              {identity.handle ? <span>{identity.handle}</span> : null}
              <span className="inline-flex items-center gap-1">{identity.platform}</span>
              {typeof identity.followers === "number" ? <span>{identity.followers.toLocaleString("ko-KR")} 구독자</span> : null}
              {identity.region ? <span>{identity.region}</span> : null}
            </div>
            {identity.owner ? <p className="mt-1 text-xs text-ink-4">담당자 {identity.owner}</p> : null}
          </div>
        </div>

        {partnerLink ? (
          <div className="flex flex-col items-end gap-1 text-right">
            <Badge tone="ok">Partner 활성{partnerLink.activatedAt ? ` · ${formatKst(partnerLink.activatedAt, "—")}` : ""}</Badge>
            <Link
              href={`/flu/partners/${encodeURIComponent(partnerLink.enrollmentId)}`}
              className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline"
            >
              Partner 상세 →<ExternalLink className="h-3 w-3" aria-hidden="true" />
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}
