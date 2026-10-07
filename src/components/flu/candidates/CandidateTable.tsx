"use client";

import { useState, type ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Avatar } from "@/components/ui/Avatar";
import { AsyncListEmpty } from "@/components/ui/AsyncListState";
import { Play } from "@/components/icons";
import { AI_DRAMA_MIN_QUALIFYING_VIDEO_VIEWS } from "@/lib/aiDramaDiscoveryDefaults";
import { AiDramaRelevanceBadge, aiDramaRelevanceReasonLabel } from "./AiDramaRelevanceBadge";
import { EMAIL_STATUS, type CandidateContactStatus, type CandidateTableVideoSnapshot } from "@/lib/data";
import { formatKst } from "@/lib/datetime";
import {
  CONTACT_STATUS,
  type CandidateTableOutreachEvent,
  type CandidateTableRow,
  type CandidateTableRowActions,
} from "./types";

// 헤세 2026-09-27 후보 탭 가독성 개선(Aside 적대 리뷰 대응): 이메일/연락 상태 칩의 의미를
// 툴팁으로 한 번 더 설명한다 — CONTACT_STATUS/EMAIL_STATUS의 짧은 라벨만으로는 "확보/추정/
// 미발견", "검수 대기/발송 예정" 같은 값이 정확히 뭘 뜻하는지 한눈에 안 들어온다는 지적.
const EMAIL_STATUS_DESC: Record<keyof typeof EMAIL_STATUS, string> = {
  verified: "이메일 주소를 실제로 확인했습니다.",
  guessed: "패턴 추정 이메일 주소입니다(미검증).",
  none: "이메일 주소를 찾지 못했습니다.",
};
const CONTACT_STATUS_DESC: Record<CandidateContactStatus, string> = {
  미연락: "아직 메일을 보내지 않았습니다.",
  "검수 대기": "발송 전 사람 검수를 기다리고 있습니다.",
  "발송 예정": "검수를 통과해 발송 대기열에 있습니다.",
  발송: "메일이 실제로 발송되었습니다.",
  차단: "발송 규칙에 걸려 차단되었습니다.",
  회신: "후보가 회신했지만 아직 수락 의사가 명확하지 않습니다.",
  "수락 후보": "명시적으로 수락 의사를 밝혀 파트너 전환이 가능합니다.",
  "협의 중": "조건을 협의하는 중입니다.",
  수락: "파트너로 전환이 확정되었습니다.",
};

// 행 안의 통계 하나(라벨 + 값)를 통일된 크기로 그린다 — 이전에는 라벨(text-[11px])과 값(상위
// 컨테이너의 text-xs)이 둘 다 작아 "국가 —" 같은 회색 텍스트가 화면을 가득 채웠다. 값 폰트를
// 눈에 띄게 키우고, 값이 없는 통계는 호출부에서 아예 렌더하지 않는다(빈 "—" 숨기기).
function StatBlock({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <span className="block text-xs text-ink-4">{label}</span>
      <span className="text-sm font-semibold text-ink">{children}</span>
    </div>
  );
}

function fmtViews(value: number | null): string {
  // == null (not === null): a legacy candidate_pool video snapshot written before a stat field
  // (e.g. likeCount, added AI-DRAMA-DISCOVERY-METAPROMPT W4) existed has the key entirely absent,
  // not explicitly null — production crash reproduced via e2e/ai-drama-org-scope-transition.spec.ts's
  // qualifyingVideo fixture (intentionally kept as a legacy-shape repro, not "fixed").
  if (value == null) return "—";
  if (value >= 10000) return `${(value / 10000).toFixed(1)}만`;
  return value.toLocaleString("ko-KR");
}

// 헤세 요청(2026-09-27): 후보 탭 최근 영상이 h-9 w-16(36×64px)이라 한눈에 안 보인다 — Game Bird
// Daily(~/Dev/dailygame react/src/components/AppCard.tsx)의 game-discovery 큰 스크린샷 스트립
// 레이아웃 아이디어만 차용(코드는 새로 작성): 16:9 카드를 가로 스트립으로, 제목+조회수는 하단
// 스크림 오버레이, 클릭은 새 탭으로 유튜브 영상을 연다. 카드 자체는 이 저장소에 이미 있는
// CanonicalVideoReviewPanel.tsx의 aspect-video+하단 스크림 관용구(디자인 토큰 일관성)를 재사용.
function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function CandidateVideoThumbCard({ video }: { video: CandidateTableVideoSnapshot }) {
  const href = video.videoId ? youtubeWatchUrl(video.videoId) : null;
  const cardClassName =
    "group relative block aspect-video w-[240px] shrink-0 overflow-hidden rounded-lg border border-line bg-fill transition-transform duration-150 sm:w-[280px]";
  const content = (
    <>
      {video.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={video.thumbnailUrl}
          alt={video.title || "영상 썸네일"}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="grid h-full w-full place-items-center text-[11px] font-semibold text-ink-4">썸네일 없음</div>
      )}
      {href && (
        <span className="pointer-events-none absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-paper/90 text-ink opacity-0 shadow-sm ring-1 ring-line transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
          <Play className="h-3.5 w-3.5" />
        </span>
      )}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/85 via-ink/35 to-transparent px-2.5 pb-2 pt-6">
        <span className="block truncate text-[12px] font-semibold leading-snug text-paper">
          {video.title || "제목 없음"}
        </span>
        <span className="mt-0.5 block text-[11px] text-paper/85">
          조회수 {fmtViews(video.viewCount)} · ♥{fmtViews(video.likeCount)}
        </span>
      </span>
    </>
  );
  if (!href) {
    return (
      <div className={cardClassName} title={video.title || undefined}>
        {content}
      </div>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={video.title || undefined}
      aria-label={video.title ? `${video.title} — YouTube에서 새 탭으로 열기` : "YouTube에서 새 탭으로 열기"}
      className={`${cardClassName} cursor-pointer hover:-translate-y-0.5 hover:shadow-pop`}
    >
      {content}
    </a>
  );
}

// 두 스코프 분기(AI Drama rich card / 기본 컴팩트)가 공유하는 최근 영상 스트립 — 헤세 요청대로
// 3~4개를 240~280px 16:9 카드로, 통계 줄(국가·구독자 등)과는 별도로 행 전체 폭을 쓰는 한 줄에
// 렌더한다(기존 컬럼·액션 버튼 배치는 그대로 둔다).
function CandidateRecentVideoStrip({ videos, candidateId }: { videos: CandidateTableVideoSnapshot[]; candidateId: string }) {
  if (videos.length === 0) return null;
  return (
    <div className="mt-3 flex gap-3 overflow-x-auto pb-1" data-testid="candidate-recent-video-strip">
      {videos.map((video, index) => (
        <CandidateVideoThumbCard key={video.videoId || `${candidateId}-${index}`} video={video} />
      ))}
    </div>
  );
}

function fmtCount(value: number | null): string {
  // Same undefined-vs-null gap as fmtViews above — see its comment.
  return value == null ? "—" : value.toLocaleString("ko-KR");
}

// AI-DRAMA-DISCOVERY-METAPROMPT W5: "confidence 낮으면 표시 억제" — below this, the chip is
// suppressed rather than shown with a misleadingly precise-looking low-confidence number.
const COMMENT_SENTIMENT_DISPLAY_CONFIDENCE_MIN = 0.5;
const COMMENT_SENTIMENT_LABEL: Record<string, string> = { positive: "긍정", mixed: "혼합", negative: "부정" };
const COMMENT_SENTIMENT_TONE: Record<string, "ok" | "neutral" | "danger"> = { positive: "ok", mixed: "neutral", negative: "danger" };

function commentSentimentChip(row: CandidateTableRow): { label: string; tone: "ok" | "neutral" | "danger" } | null {
  const sentiment = row.commentSentiment;
  if (!sentiment || sentiment.status !== "ok" || !sentiment.choice || sentiment.confidence === null) return null;
  if (sentiment.confidence < COMMENT_SENTIMENT_DISPLAY_CONFIDENCE_MIN) return null;
  const probability = sentiment.probabilities?.[sentiment.choice];
  const percentLabel = typeof probability === "number" ? `${Math.round(probability * 100)}%` : "";
  return {
    label: `${COMMENT_SENTIMENT_LABEL[sentiment.choice] ?? sentiment.choice} ${percentLabel}`.trim(),
    tone: COMMENT_SENTIMENT_TONE[sentiment.choice] ?? "neutral",
  };
}

function qualifyingVideoEvidence(row: CandidateTableRow) {
  const threshold = row.meta.minVideoViewThreshold ?? AI_DRAMA_MIN_QUALIFYING_VIDEO_VIEWS;
  const provided = row.meta.topQualifyingVideo ?? null;
  const fromRecent = row.meta.recentVideos
    .filter((video) => typeof video.viewCount === "number" && video.viewCount >= threshold)
    .sort((left, right) => (right.viewCount ?? 0) - (left.viewCount ?? 0))[0] ?? null;
  const topVideo = provided ?? fromRecent;
  const qualifyingCount = row.meta.qualifyingVideoCount
    ?? row.meta.recentVideos.filter((video) => typeof video.viewCount === "number" && video.viewCount >= threshold).length;
  return {
    threshold,
    topVideo,
    qualifyingCount,
  };
}

function timelineEventLabel(event: CandidateTableOutreachEvent): string {
  return event.type === "coldmail" ? "콜드메일" : "독려";
}

function nudgeCadenceDisabledReason(row: CandidateTableRow, readOnlyReason: string | null): string | null {
  if (readOnlyReason) return readOnlyReason;
  if (!row.poolBacked) return "후보 풀 미등록";
  if (row.canEditNudgeCadence === false) return row.nudgeCadenceReadOnlyReason ?? "이 후보의 독려 주기를 편집할 수 없습니다.";
  return null;
}

// Task-44: 행 상세(발송·독려 타임라인 + 독려 주기 편집). 클릭으로 여닫는 인라인 패널 — 이 저장소엔
// Popover/Dialog 라이브러리가 없고(CreatorHover.tsx는 순수 CSS hover라 입력폼엔 부적합), 입력
// 컨트롤을 담으므로 hover가 아니라 클릭 토글로 연다.
function CandidateDetailPanel({
  row,
  onSetNudgeCadence,
  readOnlyReason = null,
}: {
  row: CandidateTableRow;
  onSetNudgeCadence: CandidateTableRowActions["onSetNudgeCadence"];
  readOnlyReason?: string | null;
}) {
  const [draft, setDraft] = useState(String(row.stats.cadenceDaysOverride ?? row.stats.effectiveCadenceDays));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 재리뷰 MED-HIGH-1: 같은 이메일을 공유하는 다른 후보에도 함께 적용됐으면 안내한다.
  const [sharedNote, setSharedNote] = useState<string | null>(null);

  const save = (cadenceDays: number | null) => {
    setSaving(true);
    setError(null);
    setSharedNote(null);
    Promise.resolve(onSetNudgeCadence(row, cadenceDays))
      .then((result) => {
        const appliedCount = result?.appliedCandidateIds?.length ?? 0;
        if (appliedCount > 1) {
          setSharedNote(`이 이메일을 공유하는 후보 ${appliedCount}건에 함께 적용되었습니다.`);
        }
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "독려 주기 저장에 실패했습니다."))
      .finally(() => setSaving(false));
  };

  // 재리뷰 LOW: 정수 여부만 보고 저장 버튼을 켰다 — 서버(assertValidCandidateCadenceDays)는
  // 1~365 범위 밖이면 invalid-argument로 거부하므로, 그 전에 버튼에서부터 막는다.
  const draftDays = Number(draft);
  const draftValid = Number.isInteger(draftDays) && draftDays >= 1 && draftDays <= 365;

  // 2026-09-11 재리뷰 P1(기존 결함 (a)안): setCandidateNudgeCadenceOverride도 updateCandidateRowState
  // 와 같은 candidate_pool 존재 전제라 poolBacked=false 행에서는 not-found로 거부된다. AI Drama
  // scoped rows may also be deliberately server-disabled so this UI cannot authorize new mail timing.
  const cadenceReadOnlyReason = nudgeCadenceDisabledReason(row, readOnlyReason);
  const cadenceEditDisabled = saving || Boolean(cadenceReadOnlyReason);
  const cadenceEditTitle = cadenceReadOnlyReason ?? undefined;

  return (
    <div className="mt-3 rounded-lg border border-line bg-fill/40 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink-2">독려 주기(일)</span>
        <input
          type="number"
          min={1}
          max={365}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={cadenceEditDisabled}
          title={cadenceEditTitle}
          className="w-16 rounded border border-line bg-paper px-2 py-1 text-ink"
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={cadenceEditDisabled || !draftValid}
          title={cadenceEditTitle}
          onClick={() => save(draftDays)}
        >
          저장
        </Button>
        {row.stats.cadenceDaysOverride !== null ? (
          <>
            <Badge tone="info">오버라이드 적용</Badge>
            <Button
              variant="secondary"
              size="sm"
              disabled={cadenceEditDisabled}
              title={cadenceEditTitle}
              onClick={() => {
                setDraft(String(row.stats.effectiveCadenceDays));
                save(null);
              }}
            >
              기본값으로
            </Button>
          </>
        ) : (
          <Badge tone="neutral">전역 기본값</Badge>
        )}
      </div>
      {cadenceReadOnlyReason && (
        <p className="mt-1 text-ink-3">{cadenceReadOnlyReason}</p>
      )}
      {error && <p className="mt-1 text-danger">{error}</p>}
      {sharedNote && <p className="mt-1 text-ink-3">{sharedNote}</p>}

      <div className="mt-3 border-t border-line pt-3">
        <p className="mb-1.5 font-semibold text-ink-2">발송·독려 타임라인</p>
        {row.stats.timeline.length === 0 ? (
          <p className="text-ink-4">발송 이력이 없습니다.</p>
        ) : (
          <ul className="space-y-1.5">
            {row.stats.timeline.map((event, index) => (
              <li key={`${event.atIso}-${index}`} className="flex flex-wrap items-center gap-2">
                <span className="text-ink-3">{formatKst(event.atIso)}</span>
                <Badge tone={event.type === "coldmail" ? "neutral" : "info"}>{timelineEventLabel(event)}</Badge>
                <span className="text-ink-3">{event.result}</span>
                {event.conversationId ? (
                  <a
                    href={`/chat?conversationId=${encodeURIComponent(event.conversationId)}`}
                    className="text-accent hover:underline"
                  >
                    대화 열기
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// Flu/Task-43: discover/page.tsx의 행 레이아웃(체크박스 대신 즐겨찾기 토글) 패턴을 재사용한 최소
// 테이블. 서브뷰/즐겨찾기 필터/캘린더(45) 같은 확장은 이 컴포넌트를 감싸는 페이지에서 다룬다.
export function CandidateTable({
  rows,
  onSend,
  onHold,
  onToggleFavorite,
  onSetNudgeCadence,
  sendDisabledReason,
  onConvertToPartner,
  readOnlyReason = null,
  // AI-DRAMA-DISCOVERY-METAPROMPT W4: true only when the page's currently *selected* scope is the
  // ai_drama vertical (see candidates/page.tsx isAiDramaScope) — a page-level switch, not a
  // per-row property. Defaults to false so every other caller of this component (and the default
  // "전체" program view) renders the existing compact layout byte-identical to before.
  isAiDramaScope = false,
}: { rows: CandidateTableRow[]; isAiDramaScope?: boolean } & CandidateTableRowActions) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [detailOpenId, setDetailOpenId] = useState<string | null>(null);

  if (rows.length === 0) {
    // Flu/Task-55: 로딩 중에는 부모(candidates/page.tsx)가 이 컴포넌트를 아예 렌더하지 않는다
    // (loading && rows.length===0 게이트) — 여기 도달했다면 로딩이 끝난 뒤 실제로 빈 결과다.
    return (
      <AsyncListEmpty
        message="표시할 후보가 없습니다."
        action="캠페인 디스커버리를 실행하면 여기에 채워집니다."
      />
    );
  }

  return (
    <Card>
      <div className="divide-y divide-line" data-testid="candidate-table-rows">
        {rows.map((row) => {
          const status = CONTACT_STATUS[row.state.contactStatus];
          const emailStatusInfo = EMAIL_STATUS[row.emailStatus as keyof typeof EMAIL_STATUS];
          const busy = pendingId === row.id;
          const sendBlockReason = readOnlyReason ?? (sendDisabledReason?.(row) ?? null);
          const detailOpen = detailOpenId === row.id;
          const videoEvidence = qualifyingVideoEvidence(row);
          return (
            <div key={row.id} data-testid="candidate-table-row" className="px-6 py-5">
            <div
              className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"
            >
              <div className="flex min-w-0 items-start gap-3.5">
                {isAiDramaScope ? (
                  <Avatar label={row.identity?.avatar || row.name} fallback={row.name} size={48} />
                ) : (
                  <Avatar label={row.name} size={48} />
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-base font-bold text-ink">{row.name}</p>
                    <button
                      type="button"
                      onClick={() => onToggleFavorite(row)}
                      disabled={!row.poolBacked || Boolean(readOnlyReason)}
                      aria-pressed={row.state.favorite}
                      aria-label="즐겨찾기"
                      title={readOnlyReason ?? (row.poolBacked ? undefined : "후보 풀 미등록")}
                      className={
                        !row.poolBacked || readOnlyReason
                          ? "cursor-not-allowed text-ink-4 opacity-50"
                          : row.state.favorite
                            ? "text-warn"
                            : "text-ink-4 hover:text-ink-2"
                      }
                    >
                      ★
                    </button>
                  </div>
                  <p className="truncate text-sm text-ink-3">
                    {row.handle || "—"} · {row.platform}
                  </p>
                </div>
              </div>

              <div className="min-w-0 flex-1">
                {isAiDramaScope ? (
                  // AI-DRAMA-DISCOVERY-METAPROMPT W4: rich card — "who this creator is" visible
                  // without a click. Only ever rendered when the selected scope is ai_drama
                  // (CandidateTable isAiDramaScope prop) — the compact branch below is untouched.
                  <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
                    <div className="min-w-[220px] max-w-md">
                      <div className="flex flex-wrap items-center gap-2">
                        <AiDramaRelevanceBadge relevance={row.aiDramaRelevance} />
                        {row.aiDramaRelevance && (
                          // 헤세 요청(2026-09-27): JEV 판정 근거를 배지 툴팁이 아니라 바로 보이는
                          // 텍스트로 — 절대 raw JEV 응답이 아니라 aiDramaRelevanceReasonLabel이
                          // 만든 한글 라벨만 보여준다(SEC-P0-009).
                          <span className="text-sm font-medium text-ink-2">
                            {aiDramaRelevanceReasonLabel(row.aiDramaRelevance.reason)}
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <Badge tone="info">AI Drama</Badge>
                        {row.identity?.category && <Badge tone="neutral">{row.identity.category}</Badge>}
                        {(() => {
                          const chip = commentSentimentChip(row);
                          return chip ? (
                            <Badge
                              tone={chip.tone}
                              title="댓글 감성(JEV) — 표본이 충분하고 신뢰도가 일정 이상일 때만 표시됩니다"
                            >
                              {chip.label}
                            </Badge>
                          ) : null;
                        })()}
                      </div>
                      {row.identity?.publicDescription && (
                        <p className="mt-1.5 line-clamp-2 text-sm text-ink-3">{row.identity.publicDescription}</p>
                      )}
                      {row.identity?.matchScore != null && (
                        <p className="mt-1 text-xs text-ink-4">
                          매치 {row.identity.matchScore}점
                          {row.identity.signals.length > 0 ? ` · ${row.identity.signals.join(", ")}` : ""}
                        </p>
                      )}
                    </div>
                    {(() => {
                      // 헤세 요청(2026-09-27): 값이 하나도 없으면 "— · —" 대신 통계 블록 자체를
                      // 숨긴다 — 한쪽만 있으면 그 값만 보여준다.
                      const country = row.identity?.creatorCountry ?? row.meta.country;
                      const followers = row.identity?.followers ?? row.meta.subscribers;
                      if (!country && followers === null) return null;
                      const parts = [country, followers !== null ? fmtCount(followers) : null].filter(
                        (part): part is string => Boolean(part),
                      );
                      return <StatBlock label="국가·구독자">{parts.join(" · ")}</StatBlock>;
                    })()}
                    {row.meta.avgRecentViews !== null && (
                      <StatBlock label="최근 평균 조회수">{fmtViews(row.meta.avgRecentViews)}</StatBlock>
                    )}
                    {/* 컴팩트 카드(아래 else 분기)와 동일한 자격 영상 근거 — rich card로 갈아탈 때
                     * 실수로 빠졌던 정보(qualifyingCount)를 복원(같은 videoEvidence 변수 재사용). */}
                    <StatBlock label="5만+ 단일 영상">
                      {videoEvidence.topVideo ? (
                        <span title={videoEvidence.topVideo.title}>
                          {fmtViews(videoEvidence.topVideo.viewCount)} · {videoEvidence.qualifyingCount.toLocaleString("ko-KR")}개
                        </span>
                      ) : row.meta.recentVideos.length === 0 ? (
                        <span className="font-normal text-ink-4">근거 없음</span>
                      ) : (
                        <span className="font-normal text-ink-4">{videoEvidence.threshold.toLocaleString("ko-KR")}회 미충족</span>
                      )}
                    </StatBlock>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
                    {/* 헤세 요청(2026-09-27): 값이 없는 통계는 "국가 —"처럼 회색 대시로 채우지 않고
                        블록 자체를 렌더하지 않는다 — 실제로 확보된 근거만 눈에 띈다. */}
                    {row.meta.country && <StatBlock label="국가">{row.meta.country}</StatBlock>}
                    {row.meta.subscribers !== null && (
                      <StatBlock label="구독자">{fmtCount(row.meta.subscribers)}</StatBlock>
                    )}
                    <StatBlock label="5만+ 단일 영상">
                      {videoEvidence.topVideo ? (
                        <span title={videoEvidence.topVideo.title}>
                          {fmtViews(videoEvidence.topVideo.viewCount)} · {videoEvidence.qualifyingCount.toLocaleString("ko-KR")}개
                        </span>
                      ) : row.meta.recentVideos.length === 0 ? (
                        <span className="font-normal text-ink-4">근거 없음</span>
                      ) : (
                        <span className="font-normal text-ink-4">{videoEvidence.threshold.toLocaleString("ko-KR")}회 미충족</span>
                      )}
                    </StatBlock>
                    {((row.stats.coldmailCount ?? 0) > 0 || (row.stats.nudgeCount ?? 0) > 0) && (
                      <StatBlock label="발송·독려">
                        {fmtCount(row.stats.coldmailCount)}·{fmtCount(row.stats.nudgeCount)}
                      </StatBlock>
                    )}
                    {row.stats.lastSentAtIso && (
                      <StatBlock label="마지막 발송">{formatKst(row.stats.lastSentAtIso)}</StatBlock>
                    )}
                    {row.stats.nextNudgeAtIso && (
                      <StatBlock label="다음 독려 예정">{formatKst(row.stats.nextNudgeAtIso)}</StatBlock>
                    )}
                  </div>
                )}

                {/* 상태 칩 한 줄 — 두 분기가 쓰던 동일한 로직을 하나로 합쳤다. 확보/추정/미발견,
                    미연락/검수 대기/… 는 뜻이 한눈에 안 들어온다는 지적이 있어 툴팁으로 설명을
                    덧붙인다(Aside 적대 리뷰 대응). */}
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {emailStatusInfo && (
                    <Badge
                      tone={emailStatusInfo.tone}
                      title={EMAIL_STATUS_DESC[row.emailStatus as keyof typeof EMAIL_STATUS]}
                    >
                      {emailStatusInfo.label}
                    </Badge>
                  )}
                  <Badge tone={status.tone} title={CONTACT_STATUS_DESC[row.state.contactStatus]}>
                    {status.label}
                  </Badge>
                  {row.state.decision === "hold" && <Badge tone="neutral">보류</Badge>}
                  {row.stats.hasReply && <Badge tone="ok">회신</Badge>}
                  {/* Flu/Task-60 클라이언트 표시: 접거나 숨기지 않는다 — 운영자 판단은 대표 행이
                      아니라 이 행에서도 그대로 유지된다. 배지·툴팁만 동일 인물임을 알린다. */}
                  {row.duplicateOf ? (
                    <Badge
                      tone="warn"
                      title="같은 이메일/핸들의 다른 후보와 동일 인물로 판정 — 대표 행에서 관리하세요"
                    >
                      중복 · 대표 {row.duplicateOf.slice(0, 8)}
                    </Badge>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setDetailOpenId((id) => (id === row.id ? null : row.id))}
                    aria-expanded={detailOpen}
                    className="text-xs font-semibold text-accent hover:underline"
                  >
                    {detailOpen ? "상세 닫기" : "상세"}
                  </button>
                </div>
              </div>

              {/* 헤세 요청(2026-09-27): 행마다 하나의 주 액션만 — 메일 보내기/파트너 전환은 현재
                  상태에서 실제로 실행 가능할 때만 나타난다(미연락→메일 보내기, 수락 후보→파트너
                  전환). 다른 상태에선 굵은 액션 버튼이 아예 안 보인다(전에는 두 버튼 모두 늘
                  떠 있었고, 대부분의 행에서 계속 비활성 상태였다). 보류는 항상 있는 보조 액션이라
                  얇은 ghost 버튼으로 내렸다. "캠페인을 먼저 선택하세요" 같이 모든 행에서 똑같이
                  반복되던 비활성 사유 문단은 지우고, 페이지 상단 배너 한 곳(candidates/page.tsx)
                  + 버튼 title 툴팁으로만 안내한다. */}
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || !row.poolBacked || Boolean(readOnlyReason)}
                    title={readOnlyReason ?? (row.poolBacked ? undefined : "후보 풀 미등록")}
                    onClick={() => {
                      setPendingId(row.id);
                      Promise.resolve(onHold(row)).finally(() => setPendingId((id) => (id === row.id ? null : id)));
                    }}
                  >
                    보류
                  </Button>
                  {row.state.contactStatus === "미연락" && (
                    <Button
                      variant="primary"
                      size="md"
                      disabled={busy || Boolean(sendBlockReason)}
                      title={sendBlockReason ?? undefined}
                      onClick={() => {
                        setPendingId(row.id);
                        Promise.resolve(onSend(row)).finally(() => setPendingId((id) => (id === row.id ? null : id)));
                      }}
                    >
                      메일 보내기
                    </Button>
                  )}
                  {onConvertToPartner && row.state.contactStatus === "수락 후보" && (
                    <Button
                      variant="primary"
                      size="md"
                      disabled={busy || Boolean(readOnlyReason)}
                      title={readOnlyReason ?? undefined}
                      onClick={() => {
                        setPendingId(row.id);
                        Promise.resolve(onConvertToPartner(row)).finally(() => setPendingId((id) => (id === row.id ? null : id)));
                      }}
                    >
                      파트너 전환
                    </Button>
                  )}
                </div>
                {row.state.lastSendBlockedReason && (
                  <p className="max-w-[240px] text-right text-xs font-medium text-danger">
                    {row.state.lastSendBlockedReason}
                  </p>
                )}
              </div>
            </div>
            <CandidateRecentVideoStrip videos={row.meta.recentVideos} candidateId={row.id} />
            {detailOpen && (
              <CandidateDetailPanel
                row={row}
                onSetNudgeCadence={onSetNudgeCadence}
                readOnlyReason={nudgeCadenceDisabledReason(row, readOnlyReason)}
              />
            )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
