"use client";

// 영상별 성과·정산 원장 — 시각 정본 10번 하단 표 + 선택 행 inline detail을 따른다.
// (.specs/spec_video_performance_settlement_report/spec.md §4.4/§4.7). 서버가 이미 bounded/sorted/grouped
// 로 반환한 `VideoPerformanceLedgerPage`만 렌더한다 — 브라우저에서 전체 collection을 합산하지 않는다.
import { Fragment, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import type { B2DailySeriesPoint, VideoPerformanceLedgerPage, VideoPerformanceReportRow, VideoPerformanceRowDetail } from "@/lib/videoPerformanceData";
import {
  formatKstDateTime,
  formatRemainingToCutoff,
  formatSignedDelta,
  formatUsdMinor,
  formatViews,
  SETTLEMENT_STATE_LABEL,
  settlementStateTone,
  TRACKING_STATE_LABEL,
  trackingStateTone,
  MEASUREMENT_STATE_LABEL,
  COUNTRY_EVIDENCE_STATE_LABEL,
} from "./formatters";
import { excludedViewsForRow } from "@/lib/videoPerformanceOperationalSemantics";
import { RowMiniSparkline } from "./OperationalOverview";

const COLUMNS = [
  "크리에이터",
  "프로그램/캠페인",
  "영상",
  "국가",
  "총 조회수",
  // periodDeltaViews 는 원장·롤업 어느 쪽에서 와도 최근 1일 증가다(latestDailyDeltaViews).
  // 예전 컬럼명은 조회 기간 합계로 읽혀서 실제 값과 달랐다.
  "일일 증가",
  "인정 조회수",
  "마감",
  "적용 CPM",
  "예상 금액",
  "최종 금액",
  "추적 상태",
  "정산 상태",
];

// F5②: 프로그램 이름이 안 붙은 행은 id 를 병기한다. 서버가 이름을 못 찾으면 "프로그램 미지정"이
// 오는데 그 문자열만 찍으면 **서로 다른 미해석 프로그램이 같은 헤더로 병합**돼 보인다
// (운영 실측: programs/view-cpm 은 이름 필드가 없는 카운터 스텁이다). 이름을 지어내지 않고 id 만 덧붙인다.
function programScopeLabel(scope: { programId: string; programName: string }): string {
  const programName = (scope.programName ?? "").trim();
  const programId = (scope.programId ?? "").trim();
  if (!programName) return programId || "프로그램 미지정";
  if (!programId || programName === programId) return programName;
  return programName === "프로그램 미지정" ? `${programName} (${programId})` : programName;
}

// 정산 근거 국가는 verified 또는 declared 뿐이다. creatorRegion 은 참고 표시 전용이라
// 여기 판정에 넣지 않는다(정산 근거 오염 금지).
function settlementCountryMissing(row: VideoPerformanceReportRow): boolean {
  if (row.settlement.estimatedAmountMinor || row.settlement.fluCalculatedAmountMinor) return false;
  if (row.settlement.portalFinalAmountMinor) return false;
  return !row.country.verified && !row.country.declared;
}

// W6-5: 그룹 예상 금액 합계 — 정산 근거 국가가 없어 금액이 없는 행은 더하지 않는다(0 위조 금지).
function groupEstimatedAmountMinor(rows: readonly VideoPerformanceReportRow[]): string {
  let total = 0n;
  for (const row of rows) {
    const amount = row.settlement.estimatedAmountMinor;
    if (typeof amount !== "string" || !/^-?\d+$/.test(amount)) continue;
    total += BigInt(amount);
  }
  return total.toString();
}

export function VideoPerformanceLedger({
  page,
  nowIso,
  onRequestPage,
  onSelectRow,
  selectedRowId,
  rowDetail,
  rowDetailState,
  dailySeriesByVideoId,
  expandedProgramId,
  onRequestRefresh,
  onOpenSettlementReview,
}: {
  page: VideoPerformanceLedgerPage;
  nowIso: string;
  onRequestPage?: (cursor: string | null) => void;
  onSelectRow: (rowId: string | null) => void;
  selectedRowId: string | null;
  rowDetail: VideoPerformanceRowDetail | null;
  rowDetailState: "idle" | "loading" | "ready" | "error";
  /**
   * W6-4: 행 인라인 확장의 일자별 시계열. `listTrackedVideoObservations` 응답에 이미 실려 온
   * 실측 시계열을 youtubeVideoId 로 넘겨받는다 — 추가 서버 호출을 만들지 않는다.
   */
  dailySeriesByVideoId?: ReadonlyMap<string, readonly B2DailySeriesPoint[]>;
  /**
   * W6-5: URL/필터로 지정된 프로그램. 지정되면 그 프로그램 그룹만 펼치고 나머지는 접는다.
   * 지정이 없으면 전부 펼친 상태가 기본이다(그룹 접힘 상태는 로컬 UI 상태일 뿐 서버 쿼리는 불변).
   */
  expandedProgramId?: string;
  onRequestRefresh?: (rowId: string) => void;
  onOpenSettlementReview?: (rowId: string) => void;
}) {
  // F1(CRITICAL): 훅은 **모든 조기 리턴보다 먼저** 전부 호출한다. 예전 구조는 hook#1 뒤에
  // `page.rows.length === 0` 조기 리턴이 있고 그 아래에 hook#2/#3 이 있어서, 행이 있는 렌더(3훅)와
  // 필터 결과 0건 렌더(1훅)를 오가면 React 훅 수가 달라져 리포트 화면이 크래시했다(양방향).
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([null]);
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [appliedExpandedProgramId, setAppliedExpandedProgramId] = useState<string | undefined>(undefined);

  const grouped = new Map<string, VideoPerformanceReportRow[]>();
  for (const row of page.rows) {
    const key = `${row.scope.programId}::${row.scope.campaignId ?? ""}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(row);
    grouped.set(key, bucket);
  }

  // W6-5: 프로그램 뎁스 접기/펼치기 — 클라 로컬 상태. 기본 전부 펼침이고, URL/필터로 프로그램이
  // 지정되면 그 프로그램만 펼친다. 서버 쿼리·정렬·그룹 소계는 그대로 쓴다(재요청 없음).
  const groupKeys = [...grouped.keys()];
  // F1 부수: 행이 도착하기 전(rows=[])에 조정하면 빈 집합이 래치돼 "URL program 지정 시 그 그룹만
  // 펼침"이 첫 로드에 깨진다 — 그룹 키가 생긴 뒤에만 래치한다.
  if (page.rows.length > 0 && expandedProgramId !== appliedExpandedProgramId) {
    setAppliedExpandedProgramId(expandedProgramId);
    setCollapsedGroupKeys(
      expandedProgramId
        ? new Set(groupKeys.filter((key) => !key.startsWith(`${expandedProgramId}::`)))
        : new Set(),
    );
  }
  const toggleGroup = (groupKey: string) => {
    setCollapsedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  if (page.rows.length === 0) {
    return (
      <Card className="grid place-items-center py-16 text-center text-sm text-ink-3">
        현재 필터에 해당하는 승인 영상이 없습니다 — 최신 승인본 정산 대상만 표시합니다
      </Card>
    );
  }

  return (
    <Card className="p-0" data-testid="video-performance-settlement-ledger" role="region" aria-label="정산 원장">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <th key={col} className="border-b border-line px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-ink-3">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...grouped.entries()].map(([groupKey, rows]) => {
              const subtotal = page.groupSubtotals.find((g) => `${g.programId}::${g.campaignId ?? ""}` === groupKey);
              return (
                <Fragment key={groupKey}>
                  <tr key={`${groupKey}-subtotal`} className="bg-fill/60">
                    <td colSpan={COLUMNS.length} className="px-0 py-0">
                      <button
                        type="button"
                        data-testid="video-performance-group-header"
                        data-group-key={groupKey}
                        aria-expanded={!collapsedGroupKeys.has(groupKey)}
                        onClick={() => toggleGroup(groupKey)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-semibold text-ink-2 hover:bg-fill"
                      >
                        <span aria-hidden="true" className="text-ink-4">{collapsedGroupKeys.has(groupKey) ? "▸" : "▾"}</span>
                        <span title={`${rows[0].scope.programId}${rows[0].scope.campaignId ? ` / ${rows[0].scope.campaignId}` : ""}`}>
                          {/* F5②: 이름이 안 붙은 프로그램은 헤더에 id 를 병기한다. 서로 다른 미해석
                              프로그램이 "프로그램 미지정" 한 헤더로 합쳐져 보이면 안 된다. */}
                          {programScopeLabel(rows[0].scope)}
                          {rows[0].scope.campaignName ? ` · ${rows[0].scope.campaignName}` : ""}
                          {subtotal ? ` — ${subtotal.rowCount}건 · 총 ${formatViews(subtotal.totalViews)} · 인정 ${formatViews(subtotal.eligibleViews)}` : ""}
                          {/* W6-5: 예상 금액 합계는 이 페이지 행에서 클라이언트가 합산한다(서버 쿼리 불변).
                              근거 국가가 없어 금액이 없는 행은 합계에서 제외한다 — 0 으로 채우지 않는다. */}
                          {` · 예상 ${formatUsdMinor(groupEstimatedAmountMinor(rows))}`}
                        </span>
                      </button>
                    </td>
                  </tr>
                  {!collapsedGroupKeys.has(groupKey) && rows.map((row) => (
                    <VideoPerformanceRowLine
                      key={row.rowId}
                      row={row}
                      nowIso={nowIso}
                      selected={selectedRowId === row.rowId}
                      onSelect={() => onSelectRow(selectedRowId === row.rowId ? null : row.rowId)}
                    />
                  ))}
                  {!collapsedGroupKeys.has(groupKey) && selectedRowId && rows.some((r) => r.rowId === selectedRowId) && (
                    <tr key={`${groupKey}-detail`}>
                      <td colSpan={COLUMNS.length} className="border-b border-line bg-fill/30 px-3 py-3">
                        <VideoPerformanceInlineDetail
                          detail={rowDetail}
                          state={rowDetailState}
                          dailySeries={
                            dailySeriesByVideoId?.get(
                              rows.find((candidate) => candidate.rowId === selectedRowId)?.video.youtubeVideoId ?? "",
                            ) ?? []
                          }
                          onRequestRefresh={onRequestRefresh ? () => onRequestRefresh(selectedRowId) : undefined}
                          onOpenSettlementReview={onOpenSettlementReview ? () => onOpenSettlementReview(selectedRowId) : undefined}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-ink-3">
        <span>{page.pageInfo.truncated ? "다음 페이지 있음" : "마지막 페이지"}</span>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={cursorHistory.length <= 1}
            onClick={() => {
              const next = cursorHistory.slice(0, -1);
              setCursorHistory(next);
              onRequestPage?.(next[next.length - 1] ?? null);
            }}
          >
            이전
          </Button>
          <Button
            variant="secondary"
            size="sm"
            aria-label="정산 원장 다음 페이지"
            disabled={!page.pageInfo.nextCursor}
            onClick={() => {
              if (!page.pageInfo.nextCursor) return;
              setCursorHistory((prev) => [...prev, page.pageInfo.nextCursor]);
              onRequestPage?.(page.pageInfo.nextCursor);
            }}
          >
            다음
          </Button>
        </div>
      </div>
    </Card>
  );
}

function VideoPerformanceRowLine({
  row,
  nowIso,
  selected,
  onSelect,
}: {
  row: VideoPerformanceReportRow;
  nowIso: string;
  selected: boolean;
  onSelect: () => void;
}) {
  // 정산 국가(effective/declared)가 없을 때만 creators 등록 국가를 **참고**로 보여준다. 출처를 함께 적어
  // 검증된 국가로 오인되지 않게 한다 — 정산 근거는 여전히 비어 있는 상태다.
  const settlementCountry = row.country.effective ?? row.country.declared ?? null;
  const referenceRegion = settlementCountry ? null : row.country.creatorRegion ?? null;
  const effectiveCountry = settlementCountry ?? referenceRegion ?? "—";
  const countrySourceLabel = row.country.verified
    ? "YouTube 확인"
    : row.country.declared
      ? "신고"
      : referenceRegion
        ? `참고 · 출처 creators.${row.country.creatorRegionSource ?? "region"}`
        : "미확인";
  return (
    <tr
      role="button"
      tabIndex={0}
      aria-label={`${row.video.title || row.rowId} 정산 행 상세 열기`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={`cursor-pointer border-b border-line last:border-0 hover:bg-fill/60 focus:outline-none focus:ring-2 focus:ring-accent ${selected ? "bg-accent-soft/40" : ""}`}
    >
      <td className="px-3 py-2.5">
        <div className="flex min-w-36 items-center gap-2">
          {row.creator.profileImageUrl ? (
            <img src={row.creator.profileImageUrl} alt="" className="h-8 w-8 shrink-0 rounded-full bg-fill object-cover" loading="lazy" referrerPolicy="no-referrer" />
          ) : (
            <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-fill text-[11px] font-bold text-ink-3">{row.creator.displayName.slice(0, 1)}</span>
          )}
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-ink">{row.creator.displayName}</div>
            <div className="truncate text-xs text-ink-3">{row.creator.handle}</div>
          </div>
        </div>
      </td>
      <td className="px-3 py-2.5 text-xs text-ink-2" title={`${row.scope.programId}${row.scope.campaignId ? ` / ${row.scope.campaignId}` : ""}`}>
        {programScopeLabel(row.scope)}
        <br />
        {row.scope.campaignName ?? "—"}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex min-w-52 items-center gap-2">
          {row.video.thumbnailUrl ? <img src={row.video.thumbnailUrl} alt="" className="h-9 w-16 shrink-0 rounded bg-fill object-cover" loading="lazy" referrerPolicy="no-referrer" /> : <span aria-hidden="true" className="h-9 w-16 shrink-0 rounded bg-fill" />}
          <a
            href={row.video.canonicalUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="line-clamp-2 text-sm text-accent underline decoration-dotted"
          >
            {row.video.title}
          </a>
        </div>
      </td>
      <td className="px-3 py-2.5 text-xs text-ink-2">
        {effectiveCountry} <span className="text-ink-3">({countrySourceLabel})</span>
      </td>
      <td className="px-3 py-2.5 text-sm">{formatViews(row.metrics.totalViews)}</td>
      <td className="px-3 py-2.5 text-sm text-ink-2">{formatSignedDelta(row.metrics.periodDeltaViews)}</td>
      <td className="px-3 py-2.5 text-sm">{formatViews(row.metrics.eligibleViews)}</td>
      <td className="px-3 py-2.5 text-xs text-ink-2">
        {row.metrics.finalizedAt ? formatKstDateTime(row.metrics.finalizedAt) : formatRemainingToCutoff(nowIso, row.metrics.measurementEndExclusive)}
      </td>
      <td className="px-3 py-2.5 text-sm">
        {row.rate ? (
          <>
            <span>{`$${(Number(row.rate.cpmMicrosPerThousand) / 1_000_000).toFixed(2)}`}</span>
            {/* 티어는 정산 근거 국가로 정해진다. 신고 국가로 잡은 행은 그렇다고 밝힌다. */}
            <span className="mt-0.5 block text-[11px] text-ink-4">{row.rate.tier}</span>
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="px-3 py-2.5 text-sm">
        {/* 정산 근거 국가(verified/declared)가 없으면 금액을 만들지 않는다 — 최저 티어로 채우면 날조다. */}
        {settlementCountryMissing(row)
          ? <span className="text-ink-4">국가 확인 대기</span>
          : <>예상 {formatUsdMinor(row.settlement.estimatedAmountMinor)}</>}
      </td>
      <td className="px-3 py-2.5 text-sm font-semibold">
        {row.settlement.hasPortalReceipt ? `Portal 확정 ${formatUsdMinor(row.settlement.portalFinalAmountMinor)}` : "—"}
      </td>
      <td className="px-3 py-2.5">
        <Badge tone={trackingStateTone(row.trackingState)}>{TRACKING_STATE_LABEL[row.trackingState]}</Badge>
      </td>
      <td className="px-3 py-2.5">
        <Badge tone={settlementStateTone(row.settlement.state)}>{SETTLEMENT_STATE_LABEL[row.settlement.state]}</Badge>
      </td>
    </tr>
  );
}

function VideoPerformanceInlineDetail({
  detail,
  state,
  dailySeries = [],
  onRequestRefresh,
  onOpenSettlementReview,
}: {
  detail: VideoPerformanceRowDetail | null;
  state: "idle" | "loading" | "ready" | "error";
  dailySeries?: readonly B2DailySeriesPoint[];
  onRequestRefresh?: () => void;
  onOpenSettlementReview?: () => void;
}) {
  if (state === "loading" || state === "idle") {
    return <div className="py-6 text-center text-sm text-ink-3">상세 정보를 불러오는 중입니다</div>;
  }
  if (state === "error" || !detail) {
    return <div className="py-6 text-center text-sm text-danger">상세 정보를 불러오지 못했습니다. 다시 시도해 주세요.</div>;
  }
  return (
    <div className="grid gap-4 md:grid-cols-[280px_1fr]" data-testid="video-performance-expanded-row-panel">
      <div>
        <div className="text-xs font-semibold text-ink-3">최근 7일 실측 추이</div>
        <RowMiniSparkline row={detail.row} points={dailySeries} />
        <div className="mt-2 text-xs text-ink-2">
          <div>측정 상태: {MEASUREMENT_STATE_LABEL[detail.row.measurementState]}</div>
          <div>추적 상태: {TRACKING_STATE_LABEL[detail.row.trackingState]}</div>
          <div>영상 링크: <a href={detail.row.video.canonicalUrl} target="_blank" rel="noreferrer" className="text-accent underline">YouTube 열기 ↗</a></div>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-4">
      <div>
        <div className="text-xs font-semibold text-ink-3">마감 정보</div>
        <dl className="mt-1 space-y-1 text-xs text-ink-2">
          <div>게시: {formatKstDateTime(detail.measurementWindow.publishedAt)}</div>
          <div>측정 시작: {formatKstDateTime(detail.measurementWindow.measurementStartAt)}</div>
          <div>마감(제외): {formatKstDateTime(detail.measurementWindow.measurementEndExclusive)}</div>
          <div>확정: {detail.measurementWindow.finalizedAt ? formatKstDateTime(detail.measurementWindow.finalizedAt) : "미확정"}</div>
        </dl>
        {/* W6-4: 마감 한 줄 요약 — "마감 시점 N뷰 → 인정 M뷰 → $X". 운영 모니터링(B2)과 달리 리포트는
            거시 화면이므로 금액을 그대로 표시한다(P2). 근거가 없으면 금액을 만들지 않는다. */}
        <div data-testid="video-performance-cutoff-summary" className="mt-2 rounded bg-fill px-2 py-1.5 text-[11px] text-ink-2">
          마감 시점 {formatViews(detail.row.metrics.totalViews)}뷰 → 인정 {formatViews(detail.row.metrics.eligibleViews)}뷰 → {
            settlementCountryMissing(detail.row)
              ? "국가 확인 대기"
              : detail.row.settlement.hasPortalReceipt
                ? `Portal 확정 ${formatUsdMinor(detail.displayAmounts.portalFinalAmountMinor)}`
                : `예상 ${formatUsdMinor(detail.displayAmounts.estimatedAmountMinor)}`
          }
          {detail.row.rate ? (
            <span className="ml-1 text-ink-4">
              · 적용 CPM ${(Number(detail.row.rate.cpmMicrosPerThousand) / 1_000_000).toFixed(2)} · {detail.row.rate.tier}
            </span>
          ) : null}
        </div>
      </div>
      <div>
        <div className="text-xs font-semibold text-ink-3">국가 근거</div>
        <dl className="mt-1 space-y-1 text-xs text-ink-2">
          <div>신고: {detail.countryEvidence.declared ?? "—"}</div>
          <div>YouTube 확인: {detail.countryEvidence.verified ?? "미확인"}</div>
          <div>상태: {COUNTRY_EVIDENCE_STATE_LABEL[detail.countryEvidence.state]}</div>
          <div>기준: {detail.countryEvidence.effective ?? detail.countryEvidence.declared ?? "미확인"}</div>
          <div className="text-ink-3">
            참고(정산 근거 아님):{" "}
            {detail.countryEvidence.creatorRegion
              ? `${detail.countryEvidence.creatorRegion} · 출처 creators.${detail.countryEvidence.creatorRegionSource ?? "region"}`
              : "—"}
          </div>
        </dl>
      </div>
      <div>
        <div className="text-xs font-semibold text-ink-3">제외 조회수</div>
        <dl className="mt-1 space-y-1 text-xs text-ink-2">
          <div>제외 합계: {formatViews(excludedViewsForRow(detail.row))}</div>
          <div>진단 코드: {detail.row.attentionCodes.length ? detail.row.attentionCodes.join(", ") : "없음"}</div>
          <div>정책: 공식 168시간 운영 증명 없이는 자동 확정 금지</div>
        </dl>
      </div>
      <div>
        <div className="text-xs font-semibold text-ink-3">금액 / 정산 내역</div>
        <dl className="mt-1 space-y-1 text-xs text-ink-2">
          <div>예상: {formatUsdMinor(detail.displayAmounts.estimatedAmountMinor)}</div>
          <div>Flu 계산: {formatUsdMinor(detail.displayAmounts.fluCalculatedAmountMinor)}</div>
          <div>Portal 확정: {formatUsdMinor(detail.displayAmounts.portalFinalAmountMinor)}</div>
          <div>상태: {SETTLEMENT_STATE_LABEL[detail.row.settlement.state]}</div>
        </dl>
        {detail.diagnosticOnlyCounts.length > 0 && (
          <div className="mt-2 text-[11px] text-ink-4">
            진단용(정산 미반영): {detail.diagnosticOnlyCounts.map((c) => `${c.kind} ${formatViews(c.views)}`).join(", ")}
          </div>
        )}
      </div>
      <div className="md:col-span-4 flex gap-2 border-t border-line pt-3">
        {onRequestRefresh && (
          <Button variant="secondary" size="sm" onClick={onRequestRefresh}>
            재수집 요청
          </Button>
        )}
        {onOpenSettlementReview && (
          <Button variant="secondary" size="sm" onClick={onOpenSettlementReview}>
            정산 검토 열기
          </Button>
        )}
      </div>
      </div>
    </div>
  );
}
