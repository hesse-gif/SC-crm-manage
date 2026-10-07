"use client";

// Common profile header (spec_partner_profile_tabs/spec.md §3.1) — always rendered first, independent of
// any tab's data. Reuses the existing Avatar component's URL-or-initials rendering, passing the resolved
// `profileImage.url ?? displayName` per the spec's explicit instruction (§8.3: "Avatar에는
// partner.profileImageUrl ?? partner.displayName을 전달합니다").
// W91: 이미지 URL이 로드에 실패하면 URL 문자열로는 이니셜을 만들 수 없어 리터럴 "?"가 떴다. 서버가
// 이미 계산해 보내는 `profileImage.fallbackInitials`를 폴백으로 함께 넘긴다(추가 조회 없음).
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/icons";
import { formatKst } from "@/lib/datetime";
import type { PartnerProfileProjection } from "@/lib/partnerData";

const PROVENANCE_STEPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "program", label: "프로그램" },
  { key: "campaign", label: "캠페인/콜드메일" },
  { key: "apply", label: "Apply" },
  { key: "enrollment", label: "Enrollment" },
  { key: "video_approved", label: "영상 승인" },
];

export function PartnerProfileHeader({ profile }: { profile: PartnerProfileProjection }) {
  const isActive = profile.status === "active";
  return (
    <div className="rounded-xl border border-line bg-paper px-6 py-5" data-testid="partner-profile-header">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <Avatar
            label={profile.profileImage.url ?? profile.displayName}
            fallback={profile.profileImage.fallbackInitials}
            size={96}
          />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-bold text-ink">{profile.displayName}</h1>
              <Badge tone={isActive ? "ok" : "danger"} dot>
                {isActive ? "파트너 활성" : "해제됨"}
              </Badge>
              {profile.highestPriorityBlocker ? (
                <Badge tone={profile.highestPriorityBlocker.severity === "critical" ? "danger" : "warn"}>
                  {profile.highestPriorityBlocker.label}
                </Badge>
              ) : null}
            </div>
            {profile.handle ? <p className="mt-0.5 text-sm text-ink-3">{profile.handle}</p> : null}
            <p className="mt-1 text-xs text-ink-4" data-testid="partner-provenance">
              출처 · 프로그램 {profile.programName || profile.programId}
              {profile.campaignId ? ` · 캠페인 ${profile.campaignName || "캠페인명 미연결"}` : ""}
              {profile.ownerId ? ` · 담당자 ${profile.ownerId}` : ""}
              {profile.activatedAtIso ? ` · Partner since ${formatKst(profile.activatedAtIso, "—")}` : ""}
            </p>
            {profile.activationEvidence ? (
              <p className="mt-1 text-xs text-ink-3">
                활성 근거: rev.{profile.activationEvidence.videoRevision} 승인 ·{" "}
                {profile.activationEvidence.reviewerKind === "ai_auto" ? "AI 승인" : "사람 승인"} · {profile.activationEvidence.policyVersion}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {!profile.activationEvidence ? (
        <div role="alert" className="mt-4 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
          <Alert className="h-4 w-4 shrink-0" aria-hidden="true" />
          Partner 활성화 근거를 찾을 수 없습니다.
        </div>
      ) : null}

      <ol className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-2 border-t border-line pt-4 text-[11px] text-ink-3">
        {PROVENANCE_STEPS.map((step, index) => (
          <li key={step.key} className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-fill px-2.5 py-1 font-semibold text-ink-2">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
              {step.label}
            </span>
            {index < PROVENANCE_STEPS.length - 1 ? <span className="text-ink-4">→</span> : null}
          </li>
        ))}
        <span className="text-ink-4">→</span>
        <li>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-semibold ${isActive ? "bg-ok-soft text-ok" : "bg-danger-soft text-danger"}`}>
            <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
            Partner {isActive ? "활성" : "해제됨"}
          </span>
        </li>
      </ol>
    </div>
  );
}
