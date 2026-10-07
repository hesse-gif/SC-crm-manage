"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { LoadingStatus } from "@/components/ui/LoadingStatus";
import { ChevronRight, Plus, Check, Refresh } from "@/components/icons";
import { cn } from "@/lib/cn";
import { buildCandidateHoverIntelligence } from "@/lib/discovery/candidate-hover";
import { addCandidatesToCampaign, fmtFollowers, type ChannelStat, type CreatorComment, type PoolCandidate, type RecCandidate, type VideoItem } from "@/lib/data";
import { publicCallableErrorMessage, useLiveChannelStats, useLiveCreatorComments, useLiveVideos } from "@/lib/live";

function tierOf(followers: number): { label: string; tone: "accent" | "info" | "ai" } {
  if (followers >= 1_000_000) return { label: "메가", tone: "accent" };
  if (followers >= 100_000) return { label: "미드", tone: "info" };
  return { label: "UGC", tone: "ai" };
}

function normalizeLookup(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function normalizeHandle(value: string | undefined): string {
  return normalizeLookup(value).replace(/^@/, "");
}

function normalizeUrl(value: string | undefined): string {
  return normalizeLookup(value).replace(/\/+$/, "");
}

type LookupKind = "id" | "handle" | "name" | "email" | "channelId" | "youtubeUrl";

function addKey(keys: Set<string>, kind: LookupKind, value: string | undefined) {
  const normalized = kind === "handle"
    ? normalizeHandle(value)
    : kind === "youtubeUrl"
      ? normalizeUrl(value)
      : normalizeLookup(value);
  if (normalized) keys.add(`${kind}:${normalized}`);
}

function candidateKeys(rc: RecCandidate): string[] {
  const keys = new Set<string>();
  addKey(keys, "id", rc.id);
  addKey(keys, "handle", rc.handle);
  addKey(keys, "name", rc.name);
  addKey(keys, "email", rc.email);
  addKey(keys, "channelId", rc.channelId);
  addKey(keys, "youtubeUrl", rc.youtubeUrl);
  return Array.from(keys);
}

function isVisibleCandidate(rc: { deletedAt?: string; archivedAt?: string }): boolean {
  return !rc.deletedAt && !rc.archivedAt;
}

const NON_YOUTUBE_RECOMMENDATION_SOURCES = new Set(["reddit", "discord", "x", "web", "instagram", "tiktok"]);

function isYoutubeRecommendationCandidate(rc: RecCandidate): boolean {
  const platform = normalizeLookup(rc.sourcePlatform ?? rc.platform);
  const sourceKey = normalizeLookup(rc.sourceKey);
  const discoverySource = normalizeLookup(rc.discoverySource);
  if (platform === "youtube") return true;
  if (NON_YOUTUBE_RECOMMENDATION_SOURCES.has(platform) || NON_YOUTUBE_RECOMMENDATION_SOURCES.has(sourceKey)) return false;
  if (discoverySource.includes("community")) return false;
  return Boolean(rc.channelId || rc.youtubeUrl);
}

function youtubeOnlyRecommendationRows<T extends RecCandidate>(rows: readonly T[]): T[] {
  return rows.filter(isYoutubeRecommendationCandidate);
}

function poolCandidatePlatform(candidate: PoolCandidate): RecCandidate["platform"] {
  const platform = candidate.sourcePlatform ?? candidate.platform;
  return platform && platform !== "Email" ? platform : "YouTube";
}

function poolCandidateSourceReason(candidate: PoolCandidate): string | null {
  const platform = candidate.sourcePlatform ?? poolCandidatePlatform(candidate);
  if (candidate.discoverySource?.includes("community") || candidate.sourceKey) return `${platform} 공개 신호`;
  if (candidate.sourceNote) return candidate.sourceNote;
  return null;
}

type ScopedRecCandidate = RecCandidate & {
  candidateId: string;
  campaignCandidateRef: string;
  candidateRef: string;
  canonicalProgramId: string;
  campaignId: string;
  sourceRunId: string;
  sourceRunRef: string;
};

type ScopedPoolCandidate = PoolCandidate & {
  candidateId?: string;
  linkState?: string;
  linkedAtIso?: string;
};

type CandidateScopeEvidence = {
  candidateId?: string;
  campaignCandidateRef?: string;
  candidateRef?: string;
  canonicalProgramId?: string;
  campaignId?: string;
  sourceRunId?: string;
  sourceRunRef?: string;
};

type ExactCandidateScopeEvidence = {
  candidateId: string;
  campaignCandidateRef: string;
  candidateRef: string;
  canonicalProgramId: string;
  campaignId: string;
  sourceRunId: string;
  sourceRunRef: string;
};

type RecPanelProps = {
  programId: string | null;
  campaignId: string | null;
  campaignName?: string | null;
  candidates: readonly ScopedPoolCandidate[];
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  onCandidatesLinked?: () => void;
};

function candidateHasExactScope<T extends CandidateScopeEvidence>(
  candidate: T,
  programId: string,
  campaignId: string,
): candidate is T & ExactCandidateScopeEvidence {
  const candidateId = candidate.candidateId?.trim() ?? "";
  return Boolean(candidateId)
    && candidateId === candidate.candidateId
    && !candidateId.includes("/")
    && candidate.canonicalProgramId === programId
    && candidate.campaignId === campaignId
    && /^campaign_candidates\/[^/]+$/.test(candidate.campaignCandidateRef ?? "")
    && candidate.candidateRef === `candidate_pool/${candidateId}`
    && Boolean(candidate.sourceRunId)
    && candidate.sourceRunRef === `discovery_runs/${candidate.sourceRunId}`;
}

function recCandidateHasExactScope(
  candidate: ScopedRecCandidate,
  programId: string,
  campaignId: string,
): boolean {
  return candidate.id === candidate.candidateId
    && candidateHasExactScope(candidate, programId, campaignId);
}

function candidateIsAlreadyLinked(candidate: ScopedPoolCandidate): boolean {
  return candidate.linkState === "linked" || Boolean(candidate.linkedAtIso);
}

function poolToRecCandidate(candidate: ScopedPoolCandidate & {
  candidateId: string;
  campaignCandidateRef: string;
  candidateRef: string;
  canonicalProgramId: string;
  campaignId: string;
  sourceRunId: string;
  sourceRunRef: string;
}): ScopedRecCandidate {
  const sourceReason = poolCandidateSourceReason(candidate);
  return {
    id: candidate.candidateId,
    candidateId: candidate.candidateId,
    name: candidate.name,
    handle: candidate.handle,
    avatar: candidate.avatar,
    ...(candidate.email ? { email: candidate.email } : {}),
    platform: poolCandidatePlatform(candidate),
    sourcePlatform: candidate.sourcePlatform,
    sourceKey: candidate.sourceKey,
    sourceUrl: candidate.sourceUrl ?? candidate.externalProfileUrl,
    sourceNote: candidate.sourceNote,
    discoverySource: candidate.discoverySource,
    channelId: candidate.channelRef,
    followers: candidate.followers ?? 0,
    region: candidate.region,
    category: candidate.category,
    matchScore: candidate.matchScore,
    reasons: [sourceReason, candidate.recentActivity, candidate.category, candidate.emailStatus ? `이메일 ${candidate.emailStatus}` : ""].filter(Boolean) as string[],
    breakdown: {
      relevance: candidate.matchScore,
      similarity: candidate.confidence,
      freshness: candidate.discoverySignals?.includes("recentActivity") ? 90 : 60,
      contact: candidate.email ? 100 : 30,
    },
    protected: candidate.protected,
    archivedAt: candidate.archivedAt,
    deletedAt: candidate.deletedAt,
    humanGate: candidate.humanGate,
    manualIntervention: candidate.manualIntervention,
    campaignCandidateRef: candidate.campaignCandidateRef,
    candidateRef: candidate.candidateRef,
    canonicalProgramId: candidate.canonicalProgramId,
    campaignId: candidate.campaignId,
    sourceRunId: candidate.sourceRunId,
    sourceRunRef: candidate.sourceRunRef,
  };
}

function CandidateHoverCard({
  candidate,
  channelStats,
  videos,
  creatorComments,
}: {
  candidate: RecCandidate;
  channelStats: Record<string, ChannelStat>;
  videos: readonly VideoItem[];
  creatorComments: readonly CreatorComment[];
}) {
  const hover = buildCandidateHoverIntelligence(candidate, { channelStats, videos, creatorComments });
  const source = candidate.sourcePlatform ?? candidate.platform;
  const metricBadge = hover.emptyReason === "no-recent-activity" ? "없음" : "실측";
  const metricTone = hover.emptyReason === "no-recent-activity" ? "neutral" : "ok";
  const freshnessLabel = hover.freshness === null ? "—" : `${hover.freshness}%`;
  const engagementLabel = hover.engagement === null ? "—" : `${hover.engagement}%`;

  return (
    <span className="pointer-events-none absolute left-0 top-full z-40 mt-2 block w-80 translate-y-1 opacity-0 transition-[transform,opacity] duration-150 ease-out group-hover/candidate:translate-y-0 group-hover/candidate:opacity-100">
      <span className="block rounded-lg border border-line bg-paper p-4 text-left shadow-pop">
        <span className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold text-ink">{candidate.name}</span>
            <span className="mt-0.5 block truncate text-xs text-ink-3">
              {source} · {candidate.region} · {candidate.category}
            </span>
          </span>
          <Badge tone="ai">{candidate.matchScore}%</Badge>
        </span>

        <span className="mt-3 grid grid-cols-3 gap-1.5">
          <span className="rounded-md bg-fill px-2 py-2">
            <span className="block text-[10px] font-semibold text-ink-3">평균 뷰</span>
            <span className="mt-0.5 flex min-w-0 items-baseline gap-1 text-xs font-bold text-ink">
              <span className="truncate">{fmtFollowers(hover.avgViews)}</span>
            </span>
          </span>
          <span className="rounded-md bg-fill px-2 py-2">
            <span className="block text-[10px] font-semibold text-ink-3">최근 뷰</span>
            <span className="mt-0.5 flex min-w-0 items-baseline gap-1 text-xs font-bold text-ink">
              <span className="truncate">{fmtFollowers(hover.recentViews)}</span>
            </span>
          </span>
          <span className="rounded-md bg-fill px-2 py-2">
            <span className="block text-[10px] font-semibold text-ink-3">댓글/참여</span>
            <span className="mt-0.5 flex min-w-0 items-baseline gap-1 text-xs font-bold text-ink">
              <span className="truncate">{hover.commentCount.toLocaleString()} · {engagementLabel}</span>
            </span>
          </span>
        </span>
        <span className="mt-2 grid grid-cols-2 gap-1.5">
          <span className="rounded-md bg-fill px-2 py-2">
            <span className="block text-[10px] font-semibold text-ink-3">신선도</span>
            <span className="mt-0.5 flex min-w-0 items-baseline gap-1 text-xs font-bold text-ink">
              <span className="truncate">{freshnessLabel}</span>
            </span>
          </span>
          <span className="rounded-md bg-fill px-2 py-2">
            <span className="block text-[10px] font-semibold text-ink-3">지표 출처</span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1">
              <span className="min-w-0 truncate text-xs font-bold text-ink">{hover.metricSource}</span>
              <Badge tone={metricTone} className="px-1.5 py-0 text-[10px]">{metricBadge}</Badge>
            </span>
          </span>
        </span>

        <span className="mt-3 block border-t border-line pt-3">
          <span className="mb-1.5 block text-[11px] font-bold text-ink-2">최근 영상</span>
          {hover.recentVideos.length === 0 ? (
            <span className="block py-1.5 text-xs text-ink-3">저장된 최근 영상이 없습니다.</span>
          ) : hover.recentVideos.map((video, index) => (
            <span key={`${candidate.id}-video-${index}`} className="block py-1.5">
              <span className="block truncate text-xs font-semibold text-ink">{video.title}</span>
              <span className="mt-0.5 block text-[11px] text-ink-3">
                {video.published} · {fmtFollowers(video.views)} 뷰 · 댓글 {video.comments.toLocaleString()}
              </span>
            </span>
          ))}
        </span>
        {hover.recentComments.length > 0 ? (
          <span className="mt-2 block border-t border-line pt-2">
            <span className="mb-1 block text-[11px] font-bold text-ink-2">최근 댓글</span>
            {hover.recentComments.map((comment, index) => (
              <span key={`${candidate.id}-comment-${index}`} className="block truncate py-1 text-[11px] text-ink-3">
                {comment.author} · {comment.text}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </span>
  );
}

export function RecPanel({
  programId,
  campaignId,
  campaignName,
  candidates,
  loading = false,
  error = null,
  onRefresh,
  onCandidatesLinked,
}: RecPanelProps) {
  const channelStats = useLiveChannelStats<ChannelStat>({});
  const videos = useLiveVideos<VideoItem>([]);
  const creatorComments = useLiveCreatorComments<CreatorComment>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAdds, setPendingAdds] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAdding, setBulkAdding] = useState(false);
  const pendingRef = useRef<Set<string>>(new Set());
  const hasScope = Boolean(programId && campaignId);
  const scopeKey = programId && campaignId ? `${programId}:${campaignId}` : "";
  const activeScopeRef = useRef(scopeKey);
  const scopeRevisionRef = useRef(0);
  const scopedRows = useMemo(() => {
    if (!programId || !campaignId) return [];
    return candidates.filter((candidate) => candidateHasExactScope(candidate, programId, campaignId));
  }, [campaignId, candidates, programId]);
  const rejectedScopeCount = hasScope ? candidates.length - scopedRows.length : 0;
  const visibleCandidates = useMemo(
    () => youtubeOnlyRecommendationRows(
      scopedRows
        .filter(isVisibleCandidate)
        .filter((candidate) => !candidateIsAlreadyLinked(candidate))
        .map(poolToRecCandidate),
    )
      .filter((candidate) => candidateKeys(candidate).every((key) => !hiddenKeys.has(key)))
      .sort((left, right) => right.matchScore - left.matchScore) as ScopedRecCandidate[],
    [hiddenKeys, scopedRows],
  );
  const displayedCandidates = useMemo(
    () => (showAll ? visibleCandidates : visibleCandidates.slice(0, 7)),
    [showAll, visibleCandidates],
  );
  const selectedRows = useMemo(
    () => visibleCandidates.filter((candidate) => selectedIds.has(candidate.id)),
    [selectedIds, visibleCandidates],
  );
  const displayedAllSelected = displayedCandidates.length > 0 && displayedCandidates.every((candidate) => selectedIds.has(candidate.id));
  useEffect(() => {
    activeScopeRef.current = scopeKey;
    scopeRevisionRef.current += 1;
    pendingRef.current.clear();
    setActionError(null);
    setPendingAdds(new Set());
    setAdded(new Set());
    setHiddenKeys(new Set());
    setSelectedIds(new Set());
    setBulkAdding(false);
  }, [scopeKey]);

  useEffect(() => {
    setSelectedIds((prev) => {
      const allowed = new Set(visibleCandidates.map((candidate) => candidate.id));
      const next = new Set(Array.from(prev).filter((id) => allowed.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visibleCandidates]);

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleDisplayed() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (displayedAllSelected) {
        for (const candidate of displayedCandidates) next.delete(candidate.id);
      } else {
        for (const candidate of displayedCandidates) next.add(candidate.id);
      }
      return next;
    });
  }

  function hideCandidate(rc: RecCandidate) {
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      for (const key of candidateKeys(rc)) next.add(key);
      return next;
    });
  }

  function restoreCandidate(rc: RecCandidate) {
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      for (const key of candidateKeys(rc)) next.delete(key);
      return next;
    });
  }

  async function addCandidate(rc: ScopedRecCandidate, refreshAfter = true): Promise<boolean> {
    if (pendingRef.current.has(rc.id) || added.has(rc.id)) return false;
    if (!programId || !campaignId) {
      setActionError("프로그램과 캠페인 범위를 먼저 선택하세요.");
      return false;
    }
    if (!recCandidateHasExactScope(rc, programId, campaignId)) {
      setActionError("프로그램 후보 원장 증거가 현재 범위와 일치하지 않습니다.");
      return false;
    }
    const operationScopeKey = scopeKey;
    const operationScopeRevision = scopeRevisionRef.current;
    const operationIsCurrent = () => activeScopeRef.current === operationScopeKey
      && scopeRevisionRef.current === operationScopeRevision;
    pendingRef.current.add(rc.id);
    setActionError(null);
    setPendingAdds((prev) => new Set(prev).add(rc.id));
    setAdded((prev) => new Set(prev).add(rc.id));
    hideCandidate(rc);
    try {
      const result = await addCandidatesToCampaign({
        programId,
        campaignId,
        sourceRunId: rc.sourceRunId,
        sourceRunRef: rc.sourceRunRef,
        candidates: [{
          id: rc.candidateId,
          name: rc.name,
          handle: rc.handle,
          platform: rc.platform,
          ...(rc.email ? { email: rc.email } : {}),
          canonicalProgramId: rc.canonicalProgramId,
          programId: rc.canonicalProgramId,
          campaignId: rc.campaignId,
          sourceRunId: rc.sourceRunId,
          sourceRunRef: rc.sourceRunRef,
          campaignCandidateRef: rc.campaignCandidateRef,
          candidateRef: rc.candidateRef,
        }],
      });
      if (result.ok !== true || result.createdCount + result.existingCount !== 1) {
        throw new Error("프로그램 후보 연결이 완료되지 않았습니다.");
      }
      if (refreshAfter && operationIsCurrent()) {
        onCandidatesLinked?.();
      }
      return true;
    } catch (caught) {
      if (operationIsCurrent()) {
        setAdded((prev) => {
          const next = new Set(prev);
          next.delete(rc.id);
          return next;
        });
        restoreCandidate(rc);
        setActionError(publicCallableErrorMessage(caught, "프로그램 후보 연결에 실패했습니다."));
      }
      return false;
    } finally {
      if (operationIsCurrent()) {
        pendingRef.current.delete(rc.id);
        setPendingAdds((prev) => {
          const next = new Set(prev);
          next.delete(rc.id);
          return next;
        });
      }
    }
  }

  async function handleAdd(rc: ScopedRecCandidate) {
    await addCandidate(rc);
  }

  async function handleBulkAdd(targets: ScopedRecCandidate[]) {
    if (bulkAdding || !programId || !campaignId) return;
    if (targets.some((candidate) => !recCandidateHasExactScope(candidate, programId, campaignId))) {
      setActionError("프로그램 후보 원장 증거가 현재 범위와 일치하지 않습니다.");
      return;
    }
    const queue = targets.filter((candidate) => !pendingRef.current.has(candidate.id) && !added.has(candidate.id));
    if (queue.length === 0) return;
    const operationScopeKey = scopeKey;
    const operationScopeRevision = scopeRevisionRef.current;
    const operationIsCurrent = () => activeScopeRef.current === operationScopeKey
      && scopeRevisionRef.current === operationScopeRevision;
    setBulkAdding(true);
    setActionError(null);
    for (const candidate of queue) {
      pendingRef.current.add(candidate.id);
    }
    setPendingAdds((prev) => new Set([...prev, ...queue.map((candidate) => candidate.id)]));
    setAdded((prev) => new Set([...prev, ...queue.map((candidate) => candidate.id)]));
    for (const candidate of queue) hideCandidate(candidate);
    try {
      const result = await addCandidatesToCampaign({
        programId,
        campaignId,
        candidates: queue.map((candidate) => ({
          id: candidate.candidateId,
          name: candidate.name,
          handle: candidate.handle,
          platform: candidate.platform,
          ...(candidate.email ? { email: candidate.email } : {}),
          canonicalProgramId: candidate.canonicalProgramId,
          programId: candidate.canonicalProgramId,
          campaignId: candidate.campaignId,
          sourceRunId: candidate.sourceRunId,
          sourceRunRef: candidate.sourceRunRef,
          campaignCandidateRef: candidate.campaignCandidateRef,
          candidateRef: candidate.candidateRef,
        })),
      });
      if (result.ok !== true || result.createdCount + result.existingCount !== queue.length) {
        throw new Error("선택한 프로그램 후보를 모두 연결하지 못했습니다.");
      }
      if (operationIsCurrent()) {
        setSelectedIds(new Set());
        onCandidatesLinked?.();
      }
    } catch (caught) {
      if (operationIsCurrent()) {
        setAdded((prev) => {
          const next = new Set(prev);
          for (const candidate of queue) next.delete(candidate.id);
          return next;
        });
        for (const candidate of queue) restoreCandidate(candidate);
        setActionError(publicCallableErrorMessage(caught, "프로그램 후보 연결에 실패했습니다."));
      }
    } finally {
      if (operationIsCurrent()) {
        for (const candidate of queue) pendingRef.current.delete(candidate.id);
        setPendingAdds((prev) => {
          const next = new Set(prev);
          for (const candidate of queue) next.delete(candidate.id);
          return next;
        });
        setBulkAdding(false);
      }
    }
  }

  return (
    <Card>
      <CardHeader
        title="추천 인플루언서"
        desc={!hasScope
          ? "프로그램 범위 선택 필요"
          : visibleCandidates.length > 0
            ? `${campaignName ?? "선택 캠페인"}의 연결 대기 후보 ${visibleCandidates.length.toLocaleString()}명`
            : loading
              ? "프로그램 후보 확인 중"
              : error
                ? "프로그램 후보 연결 확인 필요"
                : "연결 대기 후보 없음"}
        action={
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              className="min-h-10"
              disabled={!hasScope || loading || !onRefresh}
              onClick={onRefresh}
            >
              <Refresh className="h-3.5 w-3.5" />
              범위 후보 새로고침
            </Button>
            {visibleCandidates.length > 0 ? (
              <button
                type="button"
                onClick={() => setShowAll((prev) => !prev)}
                className="flex min-h-10 items-center gap-0.5 rounded-md px-2 text-xs font-semibold text-accent transition-[background-color,scale] duration-150 ease-out hover:bg-accent-soft active:scale-[0.96]"
              >
                {showAll ? "접기" : "전체 보기"}
                <ChevronRight className={cn("h-3 w-3 transition-transform duration-150 ease-out", showAll ? "rotate-90" : "")} />
              </button>
            ) : null}
          </div>
        }
      />
      {rejectedScopeCount > 0 ? (
        <p className="border-b border-line bg-warn-soft px-5 py-2.5 text-xs font-semibold text-warn" role="status">
          프로그램·캠페인 원장 증거가 일치하지 않는 후보 {rejectedScopeCount.toLocaleString()}명은 표시하지 않았습니다.
        </p>
      ) : null}
      {!loading && !error && visibleCandidates.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2">
          <label className="flex items-center gap-2 text-[12px] font-semibold text-ink-2">
            <input
              type="checkbox"
              checked={displayedAllSelected}
              onChange={toggleDisplayed}
              className="h-4 w-4 rounded border-line accent-accent"
            />
            화면 선택
          </label>
          <span className="text-[11px] text-ink-3">{selectedRows.length}명 선택</span>
          <Button
            size="sm"
            variant="secondary"
            disabled={selectedRows.length === 0 || bulkAdding}
            onClick={() => handleBulkAdd(selectedRows)}
          >
            선택 추가
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={visibleCandidates.length === 0 || bulkAdding}
            onClick={() => handleBulkAdd(visibleCandidates)}
          >
            전체 추가
          </Button>
        </div>
      ) : null}
      <ul className="divide-y divide-line">
        {!hasScope ? (
          <li className="px-4 py-5 text-xs text-ink-3">
            프로그램과 캠페인을 선택하면 범위가 확인된 후보만 표시됩니다.
          </li>
        ) : loading ? (
          <li className="px-4 py-5">
            <LoadingStatus compact>
              프로그램별 후보를 확인하는 중입니다.
            </LoadingStatus>
          </li>
        ) : error ? (
          <li className="px-4 py-5 text-xs text-danger" role="alert">{error}</li>
        ) : visibleCandidates.length === 0 ? (
          <li className="px-4 py-5 text-xs text-ink-3">이 캠페인에 연결할 범위 확인 후보가 없습니다. AI 브리프로 프로그램별 탐색을 먼저 실행하세요.</li>
        ) : <>
          {actionError ? (
            <li className="px-4 py-2 text-xs text-danger">{actionError}</li>
          ) : null}
          {displayedCandidates.map((rc) => {
          const tierMeta = tierOf(rc.followers);
          const isAdded = added.has(rc.id);
          const isPending = pendingAdds.has(rc.id);
          return (
            <li key={rc.id} className="flex items-center gap-2.5 px-4 py-3">
              <input
                type="checkbox"
                checked={selectedIds.has(rc.id)}
                onChange={() => toggleOne(rc.id)}
                aria-label={`${rc.name} 선택`}
                className="h-4 w-4 shrink-0 rounded border-line accent-accent"
              />
              <span className="group/candidate relative flex min-w-0 flex-1 items-center gap-2.5">
                <Avatar label={rc.avatar} size={32} />
                <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-semibold text-ink">
                    {rc.name}
                  </span>
                  <Badge tone={tierMeta.tone}>{tierMeta.label}</Badge>
                  <span className="ml-auto shrink-0 text-[11px] font-semibold text-accent">
                    {rc.matchScore}% 적합
                  </span>
                </span>

                <span className="mt-0.5 block truncate text-[11px] text-ink-3">
                  {rc.reasons[0]}
                  {rc.followers > 0 ? ` · ${fmtFollowers(rc.followers)} 팔로워` : ""}
                </span>
                </span>
                    <CandidateHoverCard candidate={rc} channelStats={channelStats} videos={videos} creatorComments={creatorComments} />
              </span>

              <Button
                size="sm"
                variant="secondary"
                className="shrink-0"
                disabled={isAdded || isPending}
                title={isPending ? "저장 확인 중" : undefined}
                onClick={() => handleAdd(rc)}
              >
                {isAdded ? (
                  <>
                    <Check className="h-3 w-3" />
                    추가됨
                  </>
                ) : (
                  <>
                    <Plus className="h-3 w-3" />
                    추가
                  </>
                )}
              </Button>
            </li>
          );
          })}
        </>}
      </ul>
    </Card>
  );
}
