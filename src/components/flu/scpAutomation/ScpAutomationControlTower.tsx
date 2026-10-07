"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { Badge, type Tone as BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { LoadingStatus } from "@/components/ui/LoadingStatus";
import { formatKst } from "@/lib/datetime";
import { cn } from "@/lib/cn";
import type {
  ScpAutomationControlSnapshot,
  ScpControlCard,
  ScpControlFailure,
  ScpControlPilotRow,
  ScpControlPipelineStep,
  ScpControlTone,
  ScpControlTrendPoint,
  ScpControlWorker,
} from "@/lib/scpAutomationControlData";

type ControlTowerProps = {
  snapshot: ScpAutomationControlSnapshot | null;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
};

const ROWS_PER_PAGE = 8;
const toneToBadge: Record<ScpControlTone, BadgeTone> = {
  green: "ok",
  blue: "info",
  amber: "warn",
  red: "danger",
  purple: "ai",
};
const metricLabel: Record<string, string> = {
  intake: "검수 행",
  review: "검수 대기",
  approved: "승인",
  tracking: "추적 후보",
};
const statusLabel: Record<string, string> = {
  bounded: "제한 조회",
  "human gate": "사람 검수",
  "current only": "최신만",
  "168h blocked": "168h 차단",
};
const pipelineLabel: Record<string, string> = {
  queued: "대기",
  review: "검수",
  approved: "승인",
  tracking: "추적",
};
const stateLabel: Record<string, string> = {
  queued: "대기",
  in_review: "검수중",
  human_review_required: "사람 검수",
  changes_requested: "수정 요청",
  approved: "승인",
  rejected: "반려",
  tracking_observation: "추적 중",
};

function badgeTone(tone?: ScpControlTone): BadgeTone {
  return tone ? toneToBadge[tone] : "neutral";
}
function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function textOrDash(value?: string | null): string {
  return hasText(value) ? value : "—";
}
function formatNumber(value?: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("ko-KR") : "—";
}
function formatDateTime(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
function parseTrendNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function formatTrendDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return textOrDash(value);
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric" }).format(date);
}
function rowSafeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-") || "row";
}
function koreanCardLabel(card: ScpControlCard): string {
  const key = card.key ?? "";
  return metricLabel[key] ?? card.label ?? key ?? "지표";
}
function koreanStatusLabel(label?: string): string {
  return label ? statusLabel[label] ?? "운영 상태 확인" : "";
}
function koreanState(value?: string): string {
  return value ? stateLabel[value] ?? "확인 필요" : "—";
}
function cardSubLabel(value?: string): string {
  const raw = value?.toLowerCase() ?? "";
  if (!raw) return "";
  if (/bounded|limit|page/.test(raw)) return "제한 조회";
  if (/current|revision/.test(raw)) return "최신 리비전";
  if (/human|review/.test(raw)) return "사람 검수 필요";
  if (/blocked|missing|gap/.test(raw)) return "증거 보완 필요";
  if (/complete|ready|ok/.test(raw)) return "운영 가능";
  return "운영 상태 확인";
}
function policyEvidenceLabel(value?: string | null): string {
  if (!hasText(value)) return "정책 근거 대기";
  if (value.includes("xp-hero-content-policy")) return "현행 정책";
  return "정책 근거 연결됨";
}
function pipelineStepLabel(step?: string): string {
  return step ? pipelineLabel[step] ?? "운영 단계" : "운영 단계";
}
function pipelineStepDesc(step?: string, desc?: string): string {
  const raw = `${step ?? ""} ${desc ?? ""}`.toLowerCase();
  if (/queue|inbox|intake/.test(raw)) return "접수 대기열";
  if (/review|human/.test(raw)) return "사람 검수 흐름";
  if (/approved|pass/.test(raw)) return "승인 원장";
  if (/tracking|performance|trend/.test(raw)) return "성과 추적 흐름";
  if (/blocked|missing|gap/.test(raw)) return "운영 증거 보완 필요";
  return "운영 흐름";
}
function workerLabel(worker: ScpControlWorker): string {
  const raw = `${worker.key ?? ""} ${worker.status ?? ""}`.toLowerCase();
  if (/mail|smtp|notify/.test(raw)) return "작성자 안내 워커";
  if (/callback|projection|feed|activation/.test(raw)) return "후속 콜백 워커";
  if (/review|judge|ai|video/.test(raw)) return "영상 검수 워커";
  if (/trend|performance|metric/.test(raw)) return "성과 수집 워커";
  return "운영 워커";
}
function workerStatusLabel(worker: ScpControlWorker): string {
  const raw = `${worker.status ?? ""} ${worker.key ?? ""}`.toLowerCase();
  if (worker.ok) return "정상";
  if (/retry|queued|pending/.test(raw)) return "재시도 대기";
  if (/dead|dlq|failed|error|blocked/.test(raw)) return "확인 필요";
  return "확인 필요";
}
function failureLabel(failure: ScpControlFailure): string {
  const raw = `${failure.code ?? ""} ${failure.hint ?? ""} ${failure.action ?? ""}`.toLowerCase();
  if (/mail|smtp|notify/.test(raw)) return "작성자 안내 예외";
  if (/callback|projection|feed|activation/.test(raw)) return "후속 콜백 예외";
  if (/readiness|168|trend|performance|metric/.test(raw)) return "운영 증거 예외";
  if (/review|judge|video|ai/.test(raw)) return "영상 검수 예외";
  return "운영 예외";
}
function failureHintLabel(failure: ScpControlFailure): string {
  const raw = `${failure.code ?? ""} ${failure.hint ?? ""} ${failure.action ?? ""}`.toLowerCase();
  if (/retry/.test(raw)) return "재시도 상태를 확인하세요.";
  if (/dead|dlq/.test(raw)) return "DLQ 처리 여부를 확인하세요.";
  if (/missing|not_found|gap/.test(raw)) return "필수 운영 근거를 보완하세요.";
  if (/blocked|permission|auth/.test(raw)) return "운영 차단 조건을 해제해야 합니다.";
  return "세부 코드는 감사 원장에서 확인하세요.";
}
function rowsFromSnapshot(snapshot: ScpAutomationControlSnapshot | null): ScpControlPilotRow[] {
  return snapshot?.realRows ?? snapshot?.readModel?.rows ?? [];
}
function trendsFromRows(rows: ScpControlPilotRow[], snapshot: ScpAutomationControlSnapshot | null): ScpControlTrendPoint[] {
  if (snapshot?.trends?.length) return snapshot.trends;
  return rows.map((row) => ({
    rowId: row.id,
    youtubeVideoId: row.video.youtubeVideoId,
    sourcePath: row.trend.sourcePath,
    watermarkIso: row.trend.watermarkIso,
    totalViews: row.trend.totalViews,
    pointCount: row.trend.pointCount,
    points: row.trend.points,
    exists: row.trend.exists,
  }));
}
function firstFullyAttributed(rows: ScpControlPilotRow[], snapshot: ScpAutomationControlSnapshot | null): ScpControlPilotRow | null {
  if (snapshot?.fullyAttributedPilot?.provenance.fullyAttributed === true) return snapshot.fullyAttributedPilot;
  return rows.find((row) => row.provenance.fullyAttributed === true) ?? null;
}

function ReadModelMeta({ snapshot }: { snapshot: ScpAutomationControlSnapshot | null }) {
  const source = snapshot?.source;
  const generatedAt = formatDateTime(source?.generatedAt ?? snapshot?.updatedAt);
  const dataAsOf = formatDateTime(source?.dataAsOf);
  const completeness = source?.completeness ?? (snapshot?.present ? "partial" : "blocked");
  const labels: Record<string, string> = { complete: "정상", partial: "부분", stale: "지연", blocked: "차단", unknown: "확인중" };
  const tone: BadgeTone = completeness === "complete" ? "ok" : completeness === "blocked" ? "danger" : completeness === "stale" ? "warn" : "neutral";
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3" data-testid="scp-control-read-model-meta">
      <Badge tone={tone}>{labels[completeness] ?? "확인중"}</Badge>
      {generatedAt ? <span>생성 {generatedAt}</span> : null}
      {dataAsOf ? <span>기준 {dataAsOf}</span> : null}
    </div>
  );
}

function MetricCard({ card }: { card: ScpControlCard }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-paper px-3 py-2" data-testid={`scp-control-card-${card.key ?? card.label ?? "metric"}`}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="truncate text-xs font-bold text-ink-2">{koreanCardLabel(card)}</div>
        {card.statusLabel ? <Badge tone={badgeTone(card.tone)} className="max-w-24 truncate">{koreanStatusLabel(card.statusLabel)}</Badge> : null}
      </div>
      <div className="mt-1 text-2xl font-black tracking-[-0.04em] text-ink tabular-nums">{formatNumber(card.value)}</div>
      {card.sub ? <div className="truncate text-[11px] text-ink-3">{cardSubLabel(card.sub)}</div> : null}
    </div>
  );
}

function EmptyContract({ loading, error }: { loading?: boolean; error?: string | null }) {
  if (loading) {
    return <LoadingStatus className="justify-center rounded-xl border border-line bg-fill/40 py-4">운영 데이터를 불러오는 중</LoadingStatus>;
  }
  return (
    <div className="rounded-xl border border-dashed border-line bg-fill/30 p-4 text-sm text-ink-2" data-testid="scp-control-empty-contract">
      <div className="font-bold text-ink">운영 데이터 대기</div>
      <p className="mt-1">집계가 아직 없어 값을 만들지 않습니다. 아래 실제 패널에서 개별 상태를 확인하세요.</p>
      {error ? <p className="mt-1 text-danger">호출 오류: {error}</p> : null}
    </div>
  );
}

function reviewQueueHref(snapshot: ScpAutomationControlSnapshot | null): string {
  const params = new URLSearchParams({ queue: "video" });
  const programId = snapshot?.programId || snapshot?.fullyAttributedPilot?.program.programId || snapshot?.realRows?.[0]?.program.programId;
  const campaignId = snapshot?.campaignId || snapshot?.fullyAttributedPilot?.campaign.campaignId || snapshot?.realRows?.[0]?.campaign.campaignId;
  if (programId) params.set("programId", programId);
  if (campaignId) params.set("campaignId", campaignId);
  params.set("filter", "pending");
  return `/flu/review?${params.toString()}`;
}

function HumanReviewSummary({ snapshot }: { snapshot: ScpAutomationControlSnapshot | null }) {
  const hr = snapshot?.humanReview;
  const chips = hr?.chips?.filter((chip) => hasText(chip.label)) ?? [];
  const pendingTotal = typeof hr?.total === "number" && Number.isFinite(hr.total) ? hr.total : 0;
  return (
    <div className="self-start rounded-xl border border-line bg-paper p-3 text-ink shadow-sm" data-testid="scp-control-human-review">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-black text-ink-3">사람 검수</div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="text-2xl font-black tracking-[-0.05em] tabular-nums">{formatNumber(hr?.total)}</span>
            <span className="text-xs font-semibold text-ink-3">대기</span>
          </div>
        </div>
        <Link
          href={reviewQueueHref(snapshot)}
          className="inline-flex min-h-9 shrink-0 items-center justify-center rounded-md bg-accent px-3 text-xs font-black text-white transition-[background-color,scale] hover:bg-accent/90 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ai/40"
          data-testid="scp-control-review-link"
        >
          사람 검수 열기
        </Link>
      </div>
      {chips.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {chips.map((chip) => {
            const label = chip.label ?? "";
            return <Badge key={label} tone={badgeTone(chip.tone)}>{label.replace(/changes/i, "변경 요청").replace(/rejected/i, "반려")}</Badge>;
          })}
        </div>
      ) : null}
    </div>
  );
}

function TrendSparkline({ source }: { source: ScpControlTrendPoint }) {
  const instanceId = useId().replace(/:/g, "");
  const points = source.points.filter((point) => parseTrendNumber(point.views) !== null);
  if (points.length === 0) {
    return <div className="rounded-lg border border-dashed border-line bg-paper p-3 text-xs text-ink-3">추세 포인트 없음</div>;
  }
  const values = points.map((point) => parseTrendNumber(point.views) ?? 0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = Math.max(max - min, 1);
  const width = 220;
  const height = 58;
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const coordinates = values.map((value, index) => ({ x: points.length > 1 ? index * step : width / 2, y: height - ((value - min) / spread) * (height - 12) - 6 }));
  const polyline = coordinates.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const safeId = `${rowSafeId(source.rowId)}-${instanceId}`;
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <div>
      <svg role="img" aria-labelledby={`scp-trend-title-${safeId} scp-trend-desc-${safeId}`} viewBox={`0 0 ${width} ${height}`} className="h-20 w-full rounded-lg bg-paper" preserveAspectRatio="none">
        <title id={`scp-trend-title-${safeId}`}>최근 {points.length}개 조회 추세</title>
        <desc id={`scp-trend-desc-${safeId}`}>{formatTrendDate(first.timestamp)} {first.views}에서 {formatTrendDate(last.timestamp)} {last.views}까지의 실제 포인트입니다.</desc>
        <line x1="0" y1={height - 6} x2={width} y2={height - 6} stroke="rgb(var(--line))" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <polyline fill="none" stroke="rgb(var(--accent))" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" points={polyline} vectorEffect="non-scaling-stroke" />
        {coordinates.map((point, index) => <circle key={`${points[index].timestamp}-${index}`} cx={point.x} cy={point.y} r="2.6" fill="rgb(var(--ink))" vectorEffect="non-scaling-stroke" />)}
      </svg>
      <ol className="sr-only">
        {points.map((point, index) => <li key={`${point.timestamp}-${index}`}>{formatTrendDate(point.timestamp)} 조회 {point.views}, 일증가 {textOrDash(point.dailyDeltaViews)}</li>)}
      </ol>
      <div className="mt-1 flex justify-between gap-2 text-[11px] text-ink-3">
        <span>시작 {formatTrendDate(first.timestamp)} · {first.views}</span>
        <span>최신 {formatTrendDate(last.timestamp)} · {last.views}</span>
      </div>
    </div>
  );
}

function TrendEvidence({ row, trend }: { row: ScpControlPilotRow; trend?: ScpControlTrendPoint }) {
  const source = trend ?? {
    rowId: row.id,
    youtubeVideoId: row.video.youtubeVideoId,
    sourcePath: row.trend.sourcePath,
    watermarkIso: row.trend.watermarkIso,
    totalViews: row.trend.totalViews,
    pointCount: row.trend.pointCount,
    points: row.trend.points,
    exists: row.trend.exists,
  };
  const hasPoints = source.exists && source.points.length > 0;
  return (
    <div data-testid="scp-trend" className="rounded-xl border border-line bg-fill/35 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-xs font-black text-ink-3">성과 추세</div>
        <Badge tone={hasPoints ? "info" : "warn"}>{hasPoints ? "실측" : "포인트 없음"}</Badge>
      </div>
      <TrendSparkline source={source} />
      <div className="mt-2 grid gap-1 text-xs text-ink-2 sm:grid-cols-2">
        <div className="truncate">영상 {textOrDash(source.youtubeVideoId)}</div>
        <div className="truncate">기준 {textOrDash(source.watermarkIso)}</div>
        <div>총 조회 {textOrDash(source.totalViews)}</div>
      </div>
    </div>
  );
}

function ReadinessBlocker({ snapshot }: { snapshot: ScpAutomationControlSnapshot | null }) {
  const readiness = snapshot?.readModel?.operationalReadiness;
  if (!readiness) return null;
  return (
    <div data-testid="scp-exact168h-blocker" className="rounded-xl border border-warn/30 bg-warn-soft/70 px-3 py-2 text-xs text-warn">
      <span className="font-black text-ink">168시간 운영 증거 없음</span>
      <span> · 성과 추세와 운영 증빙이 충분히 쌓일 때까지 자동 승인을 보류합니다.</span>
      <span className="ml-1 font-mono">{readiness.blockerCode}</span>
    </div>
  );
}

// 2026-07-27 사고: 온보딩 워커 스케줄러가 07-22부터 멈춰 있었는데 "due 인데 attempts=0" 상태를
// 어떤 화면도 보여주지 않아 닷새 동안 아무도 몰랐다. 0건이면 아예 렌더하지 않는다.
function MailQueueStalls({ snapshot }: { snapshot: ScpAutomationControlSnapshot | null }) {
  const mailQueue = snapshot?.readModel?.mailQueue;
  if (!mailQueue || mailQueue.lanes.length === 0) return null;
  const anyTruncated = mailQueue.lanes.some((lane) => lane.truncated);
  // W127 [적대 리뷰 M3]: 레인 줄이 남는 조건이 정체뿐이 아니게 됐다(종결 행만 있는 레인 · 합계에서
  //   빠지는 원장 레인). 헤더가 무조건 빨간 "정체 N건"이면 **"정체 0건"을 상시로 띄우는 배너**가
  //   되고, 그건 144행 상시 배너를 없애려다 같은 실패(배너 무시)를 다시 만드는 것이다.
  //   경보는 실제로 조치가 필요한 축에만 켠다: 합계 정체 > 0, 못 읽은 레인이 있다, 또는 종결 적체가
  //   임계를 넘겼다(closedWithoutSendStale) — W127 [적대 리뷰 N2]: 종결 적체만 있고 합계 정체가
  //   0이면 종전 조건은 경보를 꺼서 두 달째 쌓인 종결 행이 조용해졌다.
  const alerting = mailQueue.totalStalled > 0
    || mailQueue.unavailableLaneCount > 0
    || mailQueue.lanes.some((lane) => lane.closedWithoutSendStale);
  return (
    <div
      data-testid="scp-mail-queue-stalls"
      data-alerting={alerting ? "true" : "false"}
      className={alerting
        ? "rounded-xl border border-danger/30 bg-danger-soft/70 px-3 py-2 text-xs text-danger"
        : "rounded-xl border border-line bg-fill px-3 py-2 text-xs text-ink-3"}
    >
      {alerting ? (
        <>
          <span className="font-black text-ink">
            발송 대기 정체 {mailQueue.totalStalled}건{anyTruncated || mailQueue.unavailableLaneCount > 0 ? " 이상" : ""}
          </span>
          <span> · 보낼 때가 지났는데 아직 한 번도 시도되지 않았습니다.</span>
        </>
      ) : (
        <span className="font-semibold text-ink">발송 대기 정체 없음 · 아래는 참고 레인입니다.</span>
      )}
      {/* W127 [적대 리뷰 N3]: 게이트는 행 사유 카운트가 아니라 설정 상태다 — 전 행에 행 사유가
          붙어 사유 잔여가 0이어도 이 배너는 켜져 있어야 한다. 못 읽었다는 사실도 "닫힘"과 구분한다. */}
      {mailQueue.uidGuideRolloutGate === "closed" || mailQueue.uidGuideRolloutGate === "unknown" ? (
        <div data-testid="scp-mail-queue-uid-guide-gate" className="mt-1">
          <span className="font-semibold text-ink">UID 안내 발송 게이트</span>{" "}
          {mailQueue.uidGuideRolloutGate === "closed" ? (
            <span data-testid="scp-mail-queue-uid-guide-gate-closed" className="font-semibold text-warn">닫힘 · 신규 발송 보류 중</span>
          ) : (
            <span data-testid="scp-mail-queue-uid-guide-gate-unknown" className="font-semibold">상태 확인 불가</span>
          )}
        </div>
      ) : null}
      <ul className="mt-1 space-y-0.5">
        {mailQueue.lanes.map((lane) => (
          <li key={lane.lane} data-testid={`scp-mail-queue-lane-${lane.lane}`}>
            <span className="font-semibold text-ink">{lane.label}</span>{" "}
            {/* 조회 실패는 0건이 아니다 — 못 읽었다는 사실을 그대로 적는다. */}
            {lane.unavailable ? (
              <span data-testid={`scp-mail-queue-lane-${lane.lane}-unavailable`} className="font-semibold">확인 불가</span>
            ) : (
              <>
                {lane.stalled}건{lane.truncated ? " 이상" : ""}
                {/* W127: 합계에서 빠지는 레인은 그 사실을 줄에 적는다 — 안 그러면 배너 숫자와
                    레인 숫자가 어긋나 보인다. */}
                {lane.excludedFromTotals ? <span className="text-ink-3"> · 합계 제외</span> : null}
                {/* W127: 종결된 채 되살아난 행. 대기가 아니라 별도 축이다(게이트 사유가 안 붙는다). */}
                {(lane.closedWithoutSend ?? 0) > 0 ? (
                  <span
                    data-testid={`scp-mail-queue-lane-${lane.lane}-closed`}
                    className="text-ink-3"
                  >
                    {" "}· 종결(발송 없음) {lane.closedWithoutSend}건{lane.truncated ? " 이상" : ""}
                    {/* M4: 건수만 있으면 "어제 한 건"과 "두 달째"가 같은 회색 한 줄이 된다. */}
                    {lane.oldestClosedSinceIso
                      ? ` · 가장 오래된 종결 ${formatKst(lane.oldestClosedSinceIso, "—")}`
                      : ""}
                  </span>
                ) : null}
                {lane.closedWithoutSendStale ? (
                  <span
                    data-testid={`scp-mail-queue-lane-${lane.lane}-closed-stale`}
                    className="font-semibold text-warn"
                  >
                    {" "}· 종결 적체(임계 초과)
                  </span>
                ) : null}
                {lane.oldestWaitingSinceIso ? <span className="text-ink-3"> · 가장 오래된 대기 {formatKst(lane.oldestWaitingSinceIso, "—")}</span> : null}
                {lane.awaitingPortalMaterial > 0 ? (
                  <span className="text-ink-3"> · 그중 포털 자료 대기 {lane.awaitingPortalMaterial}건</span>
                ) : null}
                {Object.keys(lane.skipReasonCounts ?? {}).length > 0 ? (
                  <span
                    data-testid={`scp-mail-queue-lane-${lane.lane}-reasons`}
                    className="text-ink-3"
                  >
                    {" "}
                    · 사유{" "}
                    {Object.entries(lane.skipReasonCounts ?? {})
                      .filter(([, count]) => count > 0)
                      .sort(([left], [right]) => left.localeCompare(right))
                      .map(([reason, count]) => `${reason} ${count}건`)
                      .join(", ")}
                  </span>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FullyAttributedPilot({ row }: { row: ScpControlPilotRow | null }) {
  if (!row || row.provenance.fullyAttributed !== true) return null;
  const country = row.country.effective || row.country.verified || row.country.declared;
  return (
    <div data-testid="scp-fully-attributed-pilot" className="rounded-xl border border-ok/30 bg-ok-soft/70 px-3 py-2 text-xs text-ok">
      <span className="font-black text-ink">파일럿 귀속 완료</span> · 크리에이터 {textOrDash(row.creator.displayName || "이름 미확인")} · 프로그램 {textOrDash(row.program.title || "프로그램 미지정")} · 캠페인 {textOrDash(row.campaign.title || "캠페인 미지정")} · 국가 {textOrDash(country)} · 영상 {textOrDash(row.video.title || "제목 미확인")}
    </div>
  );
}

function PrimaryTrendCard({ snapshot }: { snapshot: ScpAutomationControlSnapshot | null }) {
  const rows = rowsFromSnapshot(snapshot);
  const trend = trendsFromRows(rows, snapshot).find((item) => item.exists && item.points.length > 0);
  const row = trend ? rows.find((candidate) => candidate.id === trend.rowId) : null;
  if (!trend || !row) return null;
  return (
    <div data-testid="scp-trend" className="rounded-xl border border-accent/15 bg-accent-soft/45 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-black text-accent">실측 조회 추세</div>
          <div className="mt-0.5 max-w-[36rem] truncate text-sm font-bold text-ink">{textOrDash(row.video.title || "제목 미확인")}</div>
        </div>
        <Badge tone="info">{trend.points.length}포인트</Badge>
      </div>
      <TrendSparkline source={trend} />
    </div>
  );
}

function healthStateLabel(kind: "retry" | "dlq" | "callback" | "mail", snapshot: ScpAutomationControlSnapshot | null): { label: string; tone: BadgeTone } {
  const failures = snapshot?.failures ?? [];
  const workers = snapshot?.workers ?? [];
  const haystack = [...failures.map((item) => `${item.code ?? ""} ${item.hint ?? ""} ${item.action ?? ""}`), ...workers.map((item) => `${item.key ?? ""} ${item.status ?? ""}`)].join(" ").toLowerCase();
  if (!snapshot?.present) return { label: "대기", tone: "neutral" };
  if (kind === "retry") {
    if (/retry|재시도/.test(haystack)) return { label: "재시도 확인", tone: "warn" };
    return { label: "재시도 예외 없음", tone: "ok" };
  }
  if (kind === "dlq") {
    if (/dead.?letter|dlq|중단/.test(haystack)) return { label: "DLQ 확인 필요", tone: "danger" };
    return { label: "DLQ 없음", tone: "ok" };
  }
  if (kind === "callback") {
    if (/callback|projection|feed|activation/.test(haystack)) return { label: "콜백 추적 중", tone: "info" };
    return { label: "콜백 대기", tone: "neutral" };
  }
  if (/mail|smtp|creator.?notify|notification/.test(haystack)) return { label: "메일 헬스 추적", tone: "info" };
  return { label: "메일 대기", tone: "neutral" };
}

function OperationsHealthStrip({ snapshot }: { snapshot: ScpAutomationControlSnapshot | null }) {
  const items = [
    ["재시도", healthStateLabel("retry", snapshot)],
    ["DLQ", healthStateLabel("dlq", snapshot)],
    ["콜백", healthStateLabel("callback", snapshot)],
    ["메일", healthStateLabel("mail", snapshot)],
  ] as const;
  return (
    <div data-testid="scp-control-health-strip" className="grid gap-2 sm:grid-cols-4">
      {items.map(([label, state]) => (
        <div key={label} className="flex items-center justify-between gap-2 rounded-xl border border-line bg-fill/35 px-3 py-2">
          <span className="text-xs font-black text-ink-3">{label}</span>
          <Badge tone={state.tone}>{state.label}</Badge>
        </div>
      ))}
    </div>
  );
}

function axisSummary(row: ScpControlPilotRow) {
  return [
    ["크리에이터", row.provenance.creatorExists, row.creator.displayName || "이름 미확인"],
    ["프로필", row.provenance.profileExists, row.profile.currentState || row.profile.profileId],
    ["프로그램", row.provenance.programExists, row.program.title || "프로그램 미지정"],
    ["캠페인", row.provenance.campaignExists, row.campaign.title || "캠페인 미지정"],
    ["국가", row.provenance.countryEvidenceExists, row.country.effective || row.country.verified || row.country.declared],
    ["영상", row.provenance.videoExists, row.video.title || "제목 미확인"],
  ] as const;
}

function RealRowLedger({ snapshot }: { snapshot: ScpAutomationControlSnapshot | null }) {
  const rows = rowsFromSnapshot(snapshot);
  const trends = trendsFromRows(rows, snapshot);
  const pilot = firstFullyAttributed(rows, snapshot);
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<"trend" | "provenance" | "authority">("trend");
  const pageCount = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  const safePage = Math.min(pageIndex, pageCount - 1);
  const visibleRows = rows.slice(safePage * ROWS_PER_PAGE, safePage * ROWS_PER_PAGE + ROWS_PER_PAGE);
  const selected = rows.find((row) => row.id === selectedRowId) ?? visibleRows[0] ?? null;
  const selectedTrend = selected ? trends.find((candidate) => candidate.rowId === selected.id) ?? trends[rows.indexOf(selected)] : undefined;

  if (!snapshot?.readModel && rows.length === 0) return null;

  return (
    <section className="space-y-3 border-t border-line bg-paper/80 p-4 lg:p-5" aria-labelledby="scp-real-row-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="scp-real-row-heading" className="text-sm font-black text-ink">크리에이터·영상 운영표</h3>
          <p className="text-xs text-ink-3">모든 행 보존 · 화면은 {ROWS_PER_PAGE}개씩 표시</p>
        </div>
        <Badge tone="neutral">{rows.length}건</Badge>
      </div>
      <MailQueueStalls snapshot={snapshot} />
      <ReadinessBlocker snapshot={snapshot} />
      <FullyAttributedPilot row={pilot} />
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line bg-fill/30 p-4 text-sm text-ink-3">표시할 운영 행이 없습니다.</div>
      ) : (
        <Card className="p-0">
          <div className="max-h-[42vh] overflow-auto scroll-quiet">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="sticky top-0 z-10 bg-paper shadow-[0_1px_0_rgb(var(--line))]">
                <tr className="text-left text-xs font-bold text-ink-3">
                  <th className="px-3 py-2">크리에이터</th>
                  <th className="px-3 py-2">영상</th>
                  <th className="px-3 py-2">상태</th>
                  <th className="px-3 py-2">귀속</th>
                  <th className="px-3 py-2">성과</th>
                  <th className="px-3 py-2">동작</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const country = row.country.effective || row.country.verified || row.country.declared;
                  const rowTrend = trends.find((candidate) => candidate.rowId === row.id);
                  const isSelected = selected?.id === row.id;
                  return (
                    <tr key={row.id} data-testid="scp-real-row" className={cn("border-b border-line/70", isSelected ? "bg-accent-soft/45" : "hover:bg-fill/45")}>
                      <td className="px-3 py-2">
                        <div className="font-bold text-ink">{textOrDash(row.creator.displayName || "이름 미확인")}</div>
                        <div className="text-xs text-ink-3">{textOrDash(row.creator.handle || country)}</div>
                      </td>
                      <td className="max-w-[22rem] px-3 py-2">
                        <a href={row.video.url} target="_blank" rel="noreferrer" className="line-clamp-1 font-semibold text-ink underline-offset-2 hover:underline">{textOrDash(row.video.title || "제목 미확인")}</a>
                        <div className="text-xs text-ink-3">{textOrDash(row.program.title || "프로그램 미지정")} · {textOrDash(row.campaign.title || "캠페인 미지정")}</div>
                      </td>
                      <td className="px-3 py-2"><Badge tone={row.review.isCurrentRevision ? "ok" : "warn"}>{koreanState(row.review.state)}</Badge></td>
                      <td className="px-3 py-2"><Badge tone={row.provenance.fullyAttributed ? "ok" : "warn"}>{row.provenance.fullyAttributed ? "완료" : `${row.provenance.attributionGapReasons.length}개 누락`}</Badge></td>
                      <td className="px-3 py-2 text-xs text-ink-2">{rowTrend?.points.length ? `${rowTrend.points.length}포인트 · ${textOrDash(rowTrend.totalViews)}` : "포인트 없음"}</td>
                      <td className="px-3 py-2"><Button type="button" variant="secondary" size="sm" onClick={() => setSelectedRowId(isSelected ? null : row.id)}>{isSelected ? "접기" : "펼치기"}</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-ink-3">
            <span>{safePage + 1}/{pageCount}쪽 · {ROWS_PER_PAGE}건 단위</span>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" size="sm" disabled={safePage === 0} onClick={() => setPageIndex((value) => Math.max(0, value - 1))}>이전</Button>
              <Button type="button" variant="secondary" size="sm" disabled={safePage >= pageCount - 1} onClick={() => setPageIndex((value) => Math.min(pageCount - 1, value + 1))}>다음</Button>
            </div>
          </div>
        </Card>
      )}
      {selected ? (
        <Card className="p-3" data-testid="scp-expanded-performance-row">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-black text-ink">확장 행 · {textOrDash(selected.video.title || "제목 미확인")}</div>
              <div className="text-xs text-ink-3">승인/추적 판단 전용 상세</div>
            </div>
            <div className="flex rounded-lg bg-fill p-1">
              {(["trend", "provenance", "authority"] as const).map((tab) => (
                <button key={tab} type="button" onClick={() => setDetailTab(tab)} className={cn("rounded-md px-3 py-1.5 text-xs font-bold", detailTab === tab ? "bg-paper text-ink shadow-card" : "text-ink-3 hover:text-ink")}>{tab === "trend" ? "성과" : tab === "provenance" ? "귀속" : "검수근거"}</button>
              ))}
            </div>
          </div>
          {detailTab === "trend" ? <TrendEvidence row={selected} trend={selectedTrend} /> : null}
          {detailTab === "provenance" ? (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {axisSummary(selected).map(([label, ok, value]) => <div key={label} className="rounded-lg border border-line bg-fill/35 p-3"><div className="flex justify-between gap-2"><span className="text-xs font-black text-ink-3">{label}</span><Badge tone={ok ? "ok" : "warn"}>{ok ? "근거 있음" : "누락"}</Badge></div><div className="mt-1 truncate text-sm font-bold text-ink">{textOrDash(value)}</div></div>)}
            </div>
          ) : null}
          {detailTab === "authority" ? (
            <div className="grid gap-2 text-xs text-ink-2 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg bg-fill/35 p-3"><b className="text-ink">리비전</b><br />{selected.review.revision}</div>
              <div className="rounded-lg bg-fill/35 p-3"><b className="text-ink">콘텐츠 지문</b><br /><span title={selected.review.contentFingerprint}>{selected.review.contentFingerprint ? "지문 확인됨" : "지문 대기"}</span></div>
              <div className="rounded-lg bg-fill/35 p-3"><b className="text-ink">정책</b><br /><span title={selected.review.policyVersion || selected.review.policyConfigHash}>{selected.review.policyVersion || selected.review.policyConfigHash ? "정책 버전 확인됨" : policyEvidenceLabel(null)}</span></div>
              <div className="rounded-lg bg-fill/35 p-3"><b className="text-ink">결정 근거</b><br /><span>{selected.review.decisionRef ? "결정 원장 연결됨" : "결정 원장 대기"}</span></div>
            </div>
          ) : null}
        </Card>
      ) : null}
    </section>
  );
}

function EvidenceTabs({ pipeline, workers, failures }: { pipeline: ScpControlPipelineStep[]; workers: ScpControlWorker[]; failures: ScpControlFailure[] }) {
  const [tab, setTab] = useState<"pipeline" | "workers" | "failures">("pipeline");
  return (
    <section className="border-t border-line bg-paper/70 p-4 lg:p-5" aria-label="보조 근거">
      <div className="mb-3 flex rounded-lg bg-fill p-1">
        {(["pipeline", "workers", "failures"] as const).map((key) => <button key={key} type="button" onClick={() => setTab(key)} className={cn("rounded-md px-3 py-1.5 text-xs font-bold", tab === key ? "bg-paper text-ink shadow-card" : "text-ink-3 hover:text-ink")}>{key === "pipeline" ? "흐름" : key === "workers" ? "워커" : "예외"}</button>)}
      </div>
      {tab === "pipeline" ? <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{pipeline.map((step, index) => <div key={`${step.step}-${index}`} className="rounded-lg border border-line bg-paper p-3"><div className="text-xs font-bold text-ink-3">{pipelineStepLabel(step.step)}</div><div className="mt-1 text-lg font-black text-ink">{formatNumber(step.count)}</div><div className="truncate text-xs text-ink-3">{pipelineStepDesc(step.step, step.desc)}</div></div>)}</div> : null}
      {tab === "workers" ? <div className="grid gap-2 sm:grid-cols-2">{workers.map((worker, index) => <div key={`${worker.key}-${index}`} className="flex justify-between gap-2 rounded-lg border border-line bg-paper p-3"><span className="truncate text-sm font-bold text-ink">{workerLabel(worker)}</span><Badge tone={worker.ok ? "ok" : "warn"}>{workerStatusLabel(worker)}</Badge></div>)}</div> : null}
      {tab === "failures" ? <div className="grid gap-2 sm:grid-cols-2">{failures.length === 0 ? <div className="text-sm text-ink-3">예외 없음</div> : failures.map((failure, index) => <div key={`${failure.code}-${index}`} className="rounded-lg border border-line bg-paper p-3"><div className="font-bold text-ink">{failureLabel(failure)}</div><div className="text-xs text-ink-3">{failureHintLabel(failure)}</div></div>)}</div> : null}
    </section>
  );
}

export function ScpAutomationControlTower({ snapshot, loading = false, error = null, onRefresh }: ControlTowerProps) {
  const cards = (snapshot?.cards ?? []).filter((card) => hasText(card.label) || hasText(card.key));
  const pipeline = (snapshot?.pipeline ?? []).filter((step) => hasText(step.step) || hasText(step.desc));
  const workers = (snapshot?.workers ?? []).filter((worker) => hasText(worker.key) || hasText(worker.status));
  const failures = (snapshot?.failures ?? []).filter((failure) => hasText(failure.code) || hasText(failure.hint));
  const rows = rowsFromSnapshot(snapshot);
  const hasReadModel = snapshot?.present === true;
  const summary = useMemo(() => rows.length ? `${rows.length}건 · 최신 승인 ${snapshot?.readModel?.aggregates.approvedCurrent ?? 0}건 · 귀속 ${snapshot?.readModel?.aggregates.fullyAttributed ?? 0}건` : "운영 행 대기", [rows.length, snapshot]);

  return (
    <Card className="overflow-hidden border-ink/10 bg-paper" data-testid="scp-control-tower" aria-labelledby="scp-control-title">
      <div className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_16rem] lg:p-5">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="scp-control-title" className="text-xl font-black tracking-[-0.03em] text-ink">SCP 운영</h2>
                <Badge tone="accent">운영 원장</Badge>
              </div>
              <p className="mt-1 text-sm text-ink-2">{summary}</p>
            </div>
            {onRefresh ? <Button type="button" variant="secondary" size="sm" onClick={onRefresh} disabled={loading} data-testid="scp-control-refresh">{loading ? "갱신 중" : "새로고침"}</Button> : null}
          </div>
          <ReadModelMeta snapshot={snapshot} />
          {!hasReadModel || cards.length === 0 ? <EmptyContract loading={loading} error={error} /> : <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" data-testid="scp-control-metric-grid">{cards.map((card, index) => <MetricCard key={card.key || card.label || index} card={card} />)}</div>}
          <OperationsHealthStrip snapshot={snapshot} />
          <PrimaryTrendCard snapshot={snapshot} />
        </div>
        <HumanReviewSummary snapshot={snapshot} />
      </div>
      <RealRowLedger snapshot={snapshot} />
      <EvidenceTabs pipeline={pipeline} workers={workers} failures={failures} />
    </Card>
  );
}
