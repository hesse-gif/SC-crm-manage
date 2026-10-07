"use client";

import type { ReactNode } from "react";
import { type Creator, type ChannelStat, type GuideStatus, type Stage, fmtFollowers, fmtKRW, CHANNEL_STATS } from "@/lib/data"
import { useLiveChannelStats } from "@/lib/live";
import { Avatar } from "./Avatar";
import { Badge } from "./Badge";
import { StageBadge } from "./StageBadge";
import { GuideBadge } from "./GuideBadge";

// 인플루언서/에이전시 hover 프로필 카드 (CSS group-hover, 라이브러리 없음).
// 트리거(children)에 마우스 오버 시 프로필 미리보기가 뜬다. 인박스·CRM 공용.
function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <span className="shrink-0 text-ink-3">{k}</span>
      <span className="truncate font-medium text-ink">{v}</span>
    </div>
  );
}

function safeText(value: unknown, fallback = "—"): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function safeNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function safeStage(value: unknown): Stage | undefined {
  if (value === "contact" || value === "negotiation" || value === "contract" || value === "review" || value === "live") {
    return value;
  }
  return undefined;
}

function safeGuideStatus(value: unknown): GuideStatus | undefined {
  if (value === "within" || value === "near" || value === "over") return value;
  return undefined;
}

export function CreatorHover({
  creator,
  children,
  align = "left",
}: {
  creator: Creator;
  children: ReactNode;
  align?: "left" | "right";
}) {
  const channelStats = useLiveChannelStats<ChannelStat>(CHANNEL_STATS);
  const c = creator;
  const id = safeText(c.id, "");
  const type = c.type === "agency" ? "agency" : "influencer";
  const name = safeText(c.name, "알 수 없는 채널");
  const handle = safeText(c.handle, "");
  const avatar = safeText(c.avatar, name);
  const stage = safeStage(c.stage);
  const guideStatus = safeGuideStatus(c.guideStatus);
  const platform = safeText(c.platform);
  const category = safeText(c.category);
  const region = safeText(c.region);
  // 담당자는 서버(ownerDisplayProjection)가 members 조인으로 해석한 표시명만 쓴다.
  // 원문 `owner` 는 UID·시스템 액터가 섞여 있어 그대로 렌더하면 화면에 Firebase UID 가 뜬다.
  const owner = safeText(c.ownerDisplayName, "미지정");
  const followers = safeNumber(c.followers);
  const budgetKRW = safeNumber(c.budgetKRW);
  const st = id ? channelStats[id] : undefined;
  return (
    <span className="group/ch relative inline-flex">
      {children}
      <span
        className={`pointer-events-none absolute top-full z-40 mt-2 block w-72 origin-top scale-95 opacity-0 transition-[opacity,scale] duration-150 group-hover/ch:scale-100 group-hover/ch:opacity-100 ${
          align === "right" ? "right-0" : "left-0"
        }`}
      >
        <span className="block rounded-lg border border-line bg-paper p-4 text-left shadow-pop">
          <span className="flex items-center gap-3">
            <Avatar label={avatar} size={44} />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm font-bold text-ink">{name}</span>
                <Badge tone="neutral">{type === "agency" ? "에이전시" : "인플루언서"}</Badge>
              </span>
              {handle && <span className="block truncate text-xs text-ink-3">{handle}</span>}
            </span>
          </span>

          <span className="mt-3 flex flex-wrap gap-1.5">
            {stage && <StageBadge stage={stage} />}
            <GuideBadge status={guideStatus} />
            {c.aiHandling && <Badge tone="ai">AI 처리중</Badge>}
          </span>

          <span className="mt-3 block space-y-1.5 border-t border-line pt-3">
            <Row k="플랫폼" v={type === "agency" ? `에이전시 / ${category}` : platform} />
            {type !== "agency" && <Row k="팔로워" v={fmtFollowers(followers)} />}
            {type !== "agency" && st && (
              <>
                <Row k="평균 뷰" v={fmtFollowers(safeNumber(st.avgViews))} />
                <Row k="최근 뷰" v={fmtFollowers(safeNumber(st.recentViews))} />
                <Row k="참여율" v={`${safeNumber(st.engagement)}%`} />
              </>
            )}
            <Row k="지역" v={region} />
            <Row k="카테고리" v={category} />
            <Row k="담당자" v={owner} />
            <Row k="제안 비용" v={budgetKRW > 0 ? `₩${fmtKRW(budgetKRW)}` : "—"} />
          </span>
        </span>
      </span>
    </span>
  );
}
