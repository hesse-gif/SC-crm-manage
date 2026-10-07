"use client";

// Flu — SCP 자동화 > 운영 모니터링 (B2 확정안, B2-3 / 2026-07-27).
//
// 정본: artifacts/figma-scp-monitoring-20260727 의 CMUX-HANDOFF §2·§4·§5,
// B2-CODE-REUSE-PLUMBING-REVIEW, B2-AUDIENCE-INGRESS-DATA-CONTRACT, PNG 03/04.
//
// 지켜야 하는 것:
//  - 42% 좌목록 + 58% 우상세, 보조탭 `운영 중` / `정산 완료`(KST 캘린더 분류, P1).
//  - **CPM 숫자와 역산 가능한 예상/계산 금액은 화면·DOM 어디에도 없다(P2).** 이 컴포넌트는
//    `listB2OperationalRows` 가 돌려주는 안전 view-model 만 받는다 — 금액 필드가 애초에 없다.
//  - 국가 오디언스 이중 권위(P3): Studio verified 가 fresh 하면 국기+실비중, 아니면 Apply 신고
//    국가를 국기만(비중 없음). Apply 원본은 서버에서 보존되고 화면은 출처를 밝힌다.
//  - 미수집 메트릭은 `수집 없음`/`추적 전`으로 두고 **0 으로 위조하지 않는다**.
//  - 거시 KPI 차트·raw backend error code·수동 outbox 조회·예외 진단 모델은 넣지 않는다.
//  - OperationalUniverseCards / TrendAndPipelinePanel / VideoPerformanceLedger 를 복제하지 않는다.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { LoadingStatus } from "@/components/ui/LoadingStatus";
import { flagEmojiFromIsoCode } from "@/lib/countryFlag";
import { formatKst } from "@/lib/datetime";
import { publicCallableErrorMessage } from "@/lib/live";
import { campaignScopeLabel } from "@/lib/statusLabels";
import {
  b2OperationalMonitorDisplayState,
  listB2OperationalRows,
  type B2AudienceProjection,
  type B2OperationalRow,
} from "@/lib/videoPerformanceData";

const LIST_BUCKETS = [
  { value: "active", label: "측정 운영 중" },
  { value: "settled", label: "정산 완료" },
] as const;

type ListBucket = (typeof LIST_BUCKETS)[number]["value"];

const COLLECTION_STATE_LABEL: Record<B2OperationalRow["collectionState"], { label: string; tone: Tone }> = {
  not_started: { label: "추적 전", tone: "neutral" },
  healthy: { label: "정상", tone: "ok" },
  missing_today: { label: "오늘 수집 누락", tone: "warn" },
  stalled_48h: { label: "48시간 증가 정체", tone: "warn" },
};

const AUDIENCE_STATUS_NOTE: Record<B2AudienceProjection["status"], string> = {
  declared_only: "Apply 신고",
  collecting: "Studio 수집 중",
  verified: "Studio 확인",
  stale: "Studio 갱신 지연",
  reauth_required: "Studio 재연결 필요",
  failed: "Studio 수집 실패",
  // W63: 관측값/원천 없음은 국가 칸 자체에 사유를 그리므로 보조 주석을 덧붙이지 않는다.
  initial_observed: "발굴 관측",
  unresolved_no_source: "미확인 · 원천 없음",
  unavailable: "확인 대기",
};

// W63(결정 1): 관측 국가는 **출처 라벨과 함께만** 화면에 오른다. 코드 → 사람이 읽는 이름.
const INITIAL_COUNTRY_SOURCE_LABEL: Record<string, string> = {
  campaign_outreach: "아웃리치",
  candidate_pool: "후보 풀",
  campaign_candidates: "캠페인 후보",
  creators: "크리에이터",
};

// 검수 판정과 조회수 수집은 독립이다. 제출 직후 5분 등록 패스를 기다리는 동안 `수집 준비`,
// 첫 series 가 생기면 승인 전/반려 후에도 `조회수 수집 중`으로 표시한다. 정산 자격은 별도 승인
// 게이트가 계속 담당한다.
function rowStage(row: B2OperationalRow): { label: string; tone: Tone } {
  const reviewStage = row.reviewStage ?? "";
  const collecting = row.metrics.dailySeries.length > 0;
  if (reviewStage === "rejected") {
    return {
      label: collecting ? "반려 · 조회수 수집 중" : "반려 · 수집 준비",
      tone: "danger",
    };
  }
  if (reviewStage && reviewStage !== "approved") {
    return {
      label: collecting ? "검수 대기 · 조회수 수집 중" : "검수 대기 · 수집 준비",
      tone: collecting ? "info" : "warn",
    };
  }
  if (collecting) return { label: "운영 중", tone: "ok" };
  return { label: "추적 준비 중", tone: "info" };
}

function operationalProgramLabel(row: B2OperationalRow): string {
  const joined = row.program.name.trim();
  if (
    joined &&
    joined !== "프로그램 미지정" &&
    joined !== row.program.id
  ) {
    return joined;
  }
  return row.program.id
    ? campaignScopeLabel(row.program.id)
    : "프로그램 미지정";
}

function formatCount(value: string | null): string {
  if (value === null) return "수집 없음";
  try {
    return BigInt(value).toLocaleString("ko-KR");
  } catch {
    return "확인 필요";
  }
}

function formatSharePercent(shareBps: string): string {
  try {
    const bps = BigInt(shareBps);
    return `${(Number(bps) / 100).toFixed(bps % 100n === 0n ? 0 : 1)}%`;
  } catch {
    return "";
  }
}

function formatRemaining(remainingMs: number | null): string {
  if (remainingMs === null) return "마감 지남";
  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}일 ${hours}시간 ${minutes}분`;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  return `${minutes}분`;
}

function isCutoffImminent(remainingMs: number | null): boolean {
  return remainingMs !== null && remainingMs <= 3 * 24 * 60 * 60 * 1000;
}

function AudienceCell({ audience }: { audience: B2AudienceProjection }) {
  if (audience.authority === "youtube_verified" && audience.countries.length > 0) {
    const top = audience.countries.slice(0, 3);
    const restBps = audience.countries
      .slice(3)
      .reduce((total, country) => total + BigInt(country.shareBps), 0n);
    return (
      <span className="flex flex-col gap-0.5 text-[11px] text-ink-2" data-audience-authority="youtube_verified">
        {top.map((country) => (
          <span key={country.countryCode} className="inline-flex items-center gap-1">
            <span aria-hidden="true">{flagEmojiFromIsoCode(country.countryCode) || "🏳️"}</span>
            <span className="font-semibold tabular-nums">{formatSharePercent(country.shareBps)}</span>
          </span>
        ))}
        {restBps > 0n ? <span className="text-ink-4">기타 {formatSharePercent(restBps.toString())}</span> : null}
      </span>
    );
  }
  const flag = flagEmojiFromIsoCode(audience.declaredCountryCode);
  // W62-6 [헤세 · ops 국가 미표시]: 값이 없을 때 **왜 없는지**를 말한다.
  //   종전에는 무조건 "확인 대기"였다. 그런데 신고 국가 투영이 **반복 실패**한 행도 똑같이 "대기"로
  //   보여서, 운영자는 기다리면 채워질 줄 알고 영원히 기다린다 — **화면이 실패를 대기라고 말했다.**
  //   W62-3(A2)에서 차단을 모의발송으로 오표기해 원인 추적을 헤맨 것과 같은 종류다(틀린 사유는
  //   없는 사유보다 비싸다). 여기서는 서버가 이미 들고 있는 시도 횟수를 그대로 쓴다 — 추측하지 않는다.
  //
  // W62f [리더 검토 ①]: **재정규화하지 않는다.** 값의 정규화(음수·소수·NaN 클램프)는 서버 투영
  //   (resolveB2Audience)이 단 한 번 한다. 여기서 또 하면 같은 규칙이 두 곳에 생기고, 한쪽만
  //   바뀌는 순간 화면과 서버가 다른 숫자를 말한다 — 이 라운드가 내내 고쳐 온 결함의 형상이다.
  //   내가 그 위험을 경고해 놓고 그대로 만들었다. 널 가드만 남긴다(필드는 선택값이다).
  const attempts = audience.declaredCountryAttempts ?? 0;
  // W63 [리더 L2026-0810-42 결정 1]: 신고값이 없을 때 **발굴 시점 관측값**을 대신 보여 준다.
  //   다만 신고값과 같은 모양으로 그리지 않는다 — 출처를 값 옆에 붙여야 운영자가 두 축을 섞지
  //   않는다(정산·발송 게이트는 declared 전용이다). 출처가 없으면 값도 없는 것으로 다룬다.
  const initialCode = audience.initialCountrySource ? audience.initialCountryCode ?? null : null;
  const initialFlag = flagEmojiFromIsoCode(initialCode);
  return (
    <span className="flex flex-col gap-0.5 text-[11px] text-ink-2" data-audience-authority="declared">
      {flag ? (
        // Apply 신고 국가에는 비중을 붙이지 않는다 — 지원 국가와 실제 시청자 비중은 다른 사실이다.
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true">{flag}</span>
          <span className="text-ink-3">Apply 신고</span>
        </span>
      ) : initialFlag ? (
        <span
          className="inline-flex items-center gap-1 text-ink-3"
          data-declared-country-state="initial_observed"
          data-initial-country-source={audience.initialCountrySource ?? ""}
        >
          <span aria-hidden="true">{initialFlag}</span>
          <span>{`발굴 관측 · ${INITIAL_COUNTRY_SOURCE_LABEL[audience.initialCountrySource ?? ""] ?? audience.initialCountrySource}`}</span>
        </span>
      ) : (
        <span
          className="inline-flex items-center gap-1 text-ink-4"
          data-declared-country-state={
            audience.status === "unresolved_no_source" ? "no_source" : attempts > 0 ? "failed" : "pending"
          }
        >
          <span aria-hidden="true">🏳️</span>
          {audience.status === "unresolved_no_source"
            // 기다릴 것이 없다는 사실을 말한다. "확인 대기"는 여기서 거짓말이다.
            ? "미확인 · 원천 없음"
            : attempts > 0 ? `확인 실패 · ${attempts}회` : "확인 대기"}
        </span>
      )}
      {audience.status !== "declared_only"
        && audience.status !== "unavailable"
        && audience.status !== "initial_observed"
        && audience.status !== "unresolved_no_source" ? (
        <span className="text-ink-4">{AUDIENCE_STATUS_NOTE[audience.status]}</span>
      ) : null}
    </span>
  );
}

// W7-4b: 좌측 행 썸네일. 검수 패널과 같은 규칙 — URL 이 없거나 404 면 지어내지 않고 자리표시만 둔다.
// 한 번 실패한 썸네일은 다시 요청하지 않는다(검수 패널의 실패 기억 패턴과 동일).
function RowThumbnail({
  row,
  failed,
  onFailed,
}: {
  row: B2OperationalRow;
  failed: boolean;
  onFailed: (rowId: string) => void;
}) {
  if (!row.video.thumbnailUrl || failed) {
    return (
      <span
        data-testid="b2-row-thumbnail-unavailable"
        className="grid h-10 w-16 shrink-0 place-items-center rounded border border-line bg-fill text-[9px] font-semibold text-ink-4"
      >
        미리보기 없음
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      data-testid="b2-row-thumbnail"
      src={row.video.thumbnailUrl}
      alt=""
      aria-hidden="true"
      onError={() => onFailed(row.rowId)}
      className="h-10 w-16 shrink-0 rounded border border-line object-cover"
    />
  );
}

function DailySeriesChart({ points }: { points: B2OperationalRow["metrics"]["dailySeries"] }) {
  if (points.length === 0) {
    return (
      <div data-testid="b2-daily-series-empty" className="rounded-lg border border-line bg-fill/50 px-3 py-6 text-center text-xs text-ink-4">
        아직 수집된 일별 조회수가 없습니다. (수집 없음 — 0으로 표시하지 않습니다)
      </div>
    );
  }
  const maxDelta = points.reduce((max, point) => {
    const value = BigInt(point.dailyDeltaViews);
    return value > max ? value : max;
  }, 1n);
  const maxTotal = points.reduce((max, point) => {
    const value = BigInt(point.totalViews);
    return value > max ? value : max;
  }, 1n);
  return (
    <div data-testid="b2-daily-series-chart" className="rounded-lg border border-line bg-paper p-3">
      <div className="mb-2 flex items-center justify-between text-[11px] font-semibold text-ink-3">
        <span>일일 조회수 추이 (최근 {points.length}일)</span>
        <span className="text-ink-4">막대 = 일일 증가 · 점 = 누적</span>
      </div>
      <div className="flex items-end gap-2">
        {points.map((point) => {
          const deltaHeight = Number((BigInt(point.dailyDeltaViews) * 100n) / maxDelta);
          const totalHeight = Number((BigInt(point.totalViews) * 100n) / maxTotal);
          return (
            <div key={point.date} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <div className="relative h-28 w-full">
                <div
                  className="absolute bottom-0 left-1/2 w-3 -translate-x-1/2 rounded-t bg-accent/80"
                  style={{ height: `${Math.max(2, deltaHeight)}%` }}
                  title={`일일 증가 ${formatCount(point.dailyDeltaViews)}`}
                />
                <div
                  className="absolute left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-info"
                  style={{ bottom: `${Math.min(98, Math.max(2, totalHeight))}%` }}
                  title={`누적 ${formatCount(point.totalViews)}`}
                />
              </div>
              <span className="truncate text-[10px] text-ink-4">{point.date.slice(5)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function B2OperationalMonitor() {
  const [rows, setRows] = useState<B2OperationalRow[]>([]);
  const [generatedAtIso, setGeneratedAtIso] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [bucket, setBucket] = useState<ListBucket>("active");
  const [selectedRowId, setSelectedRowId] = useState("");
  const [truncated, setTruncated] = useState(false);
  // W7-4b: 404 를 준 썸네일 행 id — 한 번 실패하면 다시 요청하지 않는다.
  const [failedThumbnails, setFailedThumbnails] = useState<ReadonlySet<string>>(() => new Set());
  const markThumbnailFailed = useCallback((rowId: string) => {
    setFailedThumbnails((previous) => (previous.has(rowId) ? previous : new Set(previous).add(rowId)));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const envelope = await listB2OperationalRows({});
      setRows(envelope.rows);
      setGeneratedAtIso(envelope.generatedAtIso);
      // R3③: universe 절단도 같은 고지로 드러낸다 — 목록이 전체라고 오해하게 두지 않는다.
      setTruncated(envelope.globalFetchTruncated || envelope.universeTruncated);
    } catch (caught) {
      setRows([]);
      setError(publicCallableErrorMessage(caught, "운영 모니터링 데이터를 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    let active = 0;
    let settled = 0;
    let unclassified = 0;
    for (const row of rows) {
      if (row.listBucket === "active") active += 1;
      else if (row.listBucket === "settled") settled += 1;
      else unclassified += 1;
    }
    return { active, settled, unclassified };
  }, [rows]);

  const visibleRows = useMemo(
    () =>
      rows
        .filter((row) => row.listBucket === bucket)
        .sort((left, right) => (left.remainingMs ?? Number.MAX_SAFE_INTEGER) - (right.remainingMs ?? Number.MAX_SAFE_INTEGER)),
    [bucket, rows],
  );

  useEffect(() => {
    if (visibleRows.length === 0) return;
    if (selectedRowId && visibleRows.some((row) => row.rowId === selectedRowId)) return;
    setSelectedRowId(visibleRows[0].rowId);
  }, [selectedRowId, visibleRows]);

  const selected = visibleRows.find((row) => row.rowId === selectedRowId) ?? null;

  // E7 (2026-09-05 Aside 실측): 로딩/실패/성공 세 상태의 렌더 규칙을 값으로 확인 가능한
  // 순수 함수 하나로 판정한다 — "측정 운영 중 0" 과 "요청을 처리하지 못했습니다" 가 동시에
  // 뜨는 조용한 실패를 막는다.
  const displayState = b2OperationalMonitorDisplayState({
    loading,
    hasError: Boolean(error),
    hasRows: rows.length > 0,
  });

  return (
    <Card data-testid="b2-operational-monitor">
      <CardHeader
        title="운영 모니터링"
        desc="제출일 기준 +7일의 23:59:59 KST에 마감하며, 다음 날부터 정산 완료로 이동합니다."
        action={
          <Button variant="secondary" disabled={loading} onClick={() => void load()}>
            {loading ? "불러오는 중" : "새로고침"}
          </Button>
        }
      />
      <div className="space-y-3 border-t border-line px-5 py-4">
        <div className="flex flex-wrap gap-1" role="group" aria-label="운영 분류">
          {LIST_BUCKETS.map((item) => (
            <button
              key={item.value}
              type="button"
              data-testid={`b2-bucket-${item.value}`}
              aria-pressed={bucket === item.value}
              onClick={() => setBucket(item.value)}
              className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold transition-colors ${bucket === item.value ? "border-accent bg-accent-soft text-accent" : "border-line bg-paper text-ink-3 hover:text-ink-2"}`}
            >
              {item.label}
              <span className="tabular-nums" data-testid={`b2-bucket-${item.value}-count`}>
                {displayState.countsKnown ? (item.value === "active" ? counts.active : counts.settled) : "…"}
              </span>
            </button>
          ))}
        </div>

        {error ? (
          <div data-testid="b2-operational-error" className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs font-semibold text-danger">
            <span>{error}</span>
            <Button variant="secondary" size="sm" disabled={loading} onClick={() => void load()}>
              다시 시도
            </Button>
          </div>
        ) : null}
        {counts.unclassified > 0 ? (
          // 제출 시각 정본이 없으면 운영 중/정산 완료로 추측하지 않는다.
          <div data-testid="b2-unclassified-notice" className="rounded-lg bg-warn-soft px-3 py-2 text-xs font-semibold text-warn">
            제출 시각 정본이 없어 분류하지 못한 행 {counts.unclassified.toLocaleString("ko-KR")}건은 목록에 넣지 않았습니다.
          </div>
        ) : null}
        {truncated ? (
          <div className="text-[11px] text-ink-4">서버 조회가 상한에서 잘렸습니다 — 표시된 집합이 전체가 아닐 수 있습니다.</div>
        ) : null}
        {displayState.showSkeleton ? (
          <LoadingStatus className="justify-center border-y border-line py-8">운영 데이터를 불러오는 중</LoadingStatus>
        ) : null}

        <div className="grid gap-3 lg:grid-cols-[minmax(0,0.42fr)_minmax(0,0.58fr)] lg:items-start">
          <div data-testid="b2-operational-list" className="min-w-0">
            <div className="max-h-[70vh] space-y-2 overflow-y-auto pr-1">
              {visibleRows.map((row) => {
                const collection = COLLECTION_STATE_LABEL[row.collectionState];
                return (
                  <button
                    key={row.rowId}
                    type="button"
                    data-testid="b2-operational-row"
                    data-row-id={row.rowId}
                    data-list-bucket={row.listBucket}
                    aria-pressed={selectedRowId === row.rowId}
                    onClick={() => setSelectedRowId(row.rowId)}
                    className={`flex w-full flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${selectedRowId === row.rowId ? "border-accent bg-fill" : "border-line bg-paper hover:bg-fill"}`}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="flex min-w-0 items-start gap-2">
                        {/* W7-4b: 좌측 행 시각 요소 — 썸네일 + 크리에이터/채널. 42/58 골격·KST 분류·
                            CPM 마스킹·데이터 계약은 그대로이고 표시 요소만 더한다. */}
                        <RowThumbnail row={row} onFailed={markThumbnailFailed} failed={failedThumbnails.has(row.rowId)} />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-ink">{row.creator.displayName}</span>
                          <span className="block truncate text-[11px] text-ink-3">{row.creator.handle}</span>
                          <span className="mt-0.5 block truncate text-xs text-ink-2">{row.video.title}</span>
                        </span>
                      </span>
                      <AudienceCell audience={row.audience} />
                    </span>
                    <span className="grid grid-cols-4 gap-2 text-[11px] text-ink-3">
                      <span>
                        <span className="block text-ink-4">누적 조회</span>
                        <span className="tabular-nums text-ink">{formatCount(row.metrics.totalViews)}</span>
                      </span>
                      <span>
                        <span className="block text-ink-4">오늘 증가</span>
                        <span className="tabular-nums text-ink">{formatCount(row.metrics.latestDailyDeltaViews)}</span>
                      </span>
                      <span>
                        <span className="block text-ink-4">제출일</span>
                        <span className="text-ink">{row.submittedAtIso ? formatKst(row.submittedAtIso) : "미확인"}</span>
                      </span>
                      <span>
                        <span className="block text-ink-4">측정 마감(KST)</span>
                        <span className={isCutoffImminent(row.remainingMs) ? "font-semibold text-danger" : "text-ink"}>
                          {row.cutoffAtIso ? formatKst(row.cutoffAtIso) : "분류 불가"}
                        </span>
                        <span className="block text-ink-4">남은 시간 {formatRemaining(row.remainingMs)}</span>
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={rowStage(row).tone}>{rowStage(row).label}</Badge>
                      <Badge tone={collection.tone}>{collection.label}</Badge>
                      {row.cpmPolicyApplied ? <Badge tone="neutral">CPM 비공개</Badge> : null}
                    </span>
                  </button>
                );
              })}
              {displayState.showEmptyState && visibleRows.length === 0 ? (
                <div data-testid="b2-operational-empty" className="rounded-lg border border-line bg-paper px-3 py-10 text-center text-xs text-ink-4">
                  {bucket === "active" ? "운영 중인 영상이 없습니다." : "정산 완료로 이동한 영상이 없습니다."}
                </div>
              ) : null}
            </div>
            {generatedAtIso ? (
              <div className="mt-2 text-[11px] text-ink-4">
                최신 데이터 기준 {formatKst(generatedAtIso)} · 시간: Asia/Seoul (KST)
              </div>
            ) : null}
          </div>

          <div data-testid="b2-operational-detail" className="min-w-0 space-y-3 lg:sticky lg:top-4">
            {selected ? (
              <>
                <div className="rounded-xl border border-line bg-paper p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-bold text-ink">{selected.creator.displayName}</div>
                      <div className="truncate text-[11px] text-ink-3">{selected.creator.handle}</div>
                      <div className="mt-1 truncate text-xs text-ink-2">{selected.video.title}</div>
                      <div className="mt-0.5 text-[11px] text-ink-4">
                        {operationalProgramLabel(selected)}
                        {selected.campaign.name ? ` · ${selected.campaign.name}` : ""}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[11px] text-ink-4">CPM 적용</div>
                      {/* CPM 숫자는 화면·DOM 어디에도 넣지 않는다(P2). 정책 적용 여부만 밝힌다. */}
                      <div data-testid="b2-cpm-display" className="text-xs font-semibold text-ink-2">
                        {selected.cpmPolicyApplied ? selected.cpmDisplay : "정책 미적용"}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
                    <span className="font-semibold text-ink-2">국가 오디언스</span>
                    <AudienceCell audience={selected.audience} />
                    <span className="text-ink-4">
                      {selected.audience.authority === "youtube_verified"
                        ? `Studio 확인${selected.audience.window ? ` · ${selected.audience.window.startDate}~${selected.audience.window.endDate}` : ""}`
                        : AUDIENCE_STATUS_NOTE[selected.audience.status]}
                    </span>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
                    <div>
                      <dt className="text-ink-4">제출일</dt>
                      <dd className="text-ink">{selected.submittedAtIso ? formatKst(selected.submittedAtIso) : "미확인"}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-4">측정 마감(KST)</dt>
                      <dd className={isCutoffImminent(selected.remainingMs) ? "font-semibold text-danger" : "text-ink"}>
                        {selected.cutoffAtIso ? formatKst(selected.cutoffAtIso) : "분류 불가"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-4">남은 시간</dt>
                      <dd className="text-ink">{formatRemaining(selected.remainingMs)}</dd>
                    </div>
                    <div>
                      <dt className="text-ink-4">정산 완료 예정</dt>
                      <dd className="text-ink">{selected.settledFromIso ? formatKst(selected.settledFromIso) : "분류 불가"}</dd>
                    </div>
                  </dl>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-4">
                    <Badge tone={rowStage(selected).tone}>{rowStage(selected).label}</Badge>
                    최신 수집 {selected.metrics.freshnessWatermarkIso ? formatKst(selected.metrics.freshnessWatermarkIso) : "수집 없음"}
                    {" · "}
                    <span className="font-semibold">{COLLECTION_STATE_LABEL[selected.collectionState].label}</span>
                  </div>
                </div>

                <DailySeriesChart points={selected.metrics.dailySeries} />

                <div className="overflow-hidden rounded-xl border border-line">
                  <table className="w-full text-[11px]" data-testid="b2-daily-ledger">
                    <thead className="bg-fill text-ink-3">
                      <tr>
                        <th className="px-2 py-1.5 text-left font-semibold">날짜</th>
                        <th className="px-2 py-1.5 text-right font-semibold">일일 증가</th>
                        <th className="px-2 py-1.5 text-right font-semibold">누적 조회</th>
                        <th className="px-2 py-1.5 text-right font-semibold">인정 조회</th>
                        <th className="px-2 py-1.5 text-left font-semibold">상태</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.metrics.dailySeries.map((point, index) => {
                        const isLast = index === selected.metrics.dailySeries.length - 1;
                        return (
                          <tr key={point.date} className="border-t border-line">
                            <td className="px-2 py-1.5 text-ink-2">{point.date}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-ink">{formatCount(point.dailyDeltaViews)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-ink">{formatCount(point.totalViews)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-ink-3">
                              {isLast ? formatCount(selected.metrics.eligibleViews) : "—"}
                            </td>
                            <td className="px-2 py-1.5 text-ink-3">집계 완료</td>
                          </tr>
                        );
                      })}
                      {selected.metrics.dailySeries.length === 0 ? (
                        <tr className="border-t border-line">
                          <td colSpan={5} className="px-2 py-6 text-center text-ink-4">
                            수집된 일자별 기록이 없습니다 (수집 없음).
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="rounded-xl border border-line bg-paper px-3 py-10 text-center text-xs text-ink-4">
                왼쪽 목록에서 영상을 선택하면 일별 추이와 원장이 표시됩니다.
              </div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
