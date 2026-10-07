"use client";

// Flu/Task-37 [헤세 · 크리에이터 탭] — 포털에서 승인됐지만 Flu ingest(대시보드 스냅샷) 성공
// 이력이 없는 계정을 찾는 패널. 읽기 전용(실행 액션 없음) — listScpApprovedWithoutIngest 콜러블
// 하나로 program_applications × scp_portal_creator_bindings × scp_dashboard_ingest_ledger 조인
// 결과를 그대로 보여준다. LIVE DATA ONLY.
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge, type Tone } from "@/components/ui/Badge";
import { LoadingStatus } from "@/components/ui/LoadingStatus";
import { formatKst } from "@/lib/datetime";
import { listScpApprovedWithoutIngest } from "@/lib/data";
import {
  INGEST_GAP_REASON_CODES,
  type IngestGapReasonCode,
  type ScpApprovedWithoutIngestEnvelope,
  type ScpApprovedWithoutIngestRow,
} from "@/lib/scpDashboardIngestGapData";

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "요청을 처리하지 못했습니다.";
}

const REASON_LABEL: Record<IngestGapReasonCode, string> = {
  identity_not_provisioned: "신원 미발행",
  command_rejected: "커맨드 거절",
  delivery_retry_exhausted: "재시도 소진",
  ingest_never_attempted: "시도 이력 없음",
};

const REASON_TONE: Record<IngestGapReasonCode, Tone> = {
  identity_not_provisioned: "warn",
  command_rejected: "danger",
  delivery_retry_exhausted: "danger",
  ingest_never_attempted: "neutral",
};

const ALL_FILTER = "all" as const;
type ReasonFilter = IngestGapReasonCode | typeof ALL_FILTER;

export function ScpApprovedWithoutIngestPanel() {
  const [envelope, setEnvelope] = useState<ScpApprovedWithoutIngestEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState<ReasonFilter>(ALL_FILTER);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      // 서버 클램프(functions/managementProfileTabsReadModels.ts MAX_PAGE_SIZE)가 100이라 200을
      // 요청해도 100으로 잘린다 — 요청 값을 서버 상한과 맞춰 혼동을 없앤다.
      const result = await listScpApprovedWithoutIngest({ limit: 100 });
      setEnvelope(result);
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const list = envelope?.rows ?? [];
    return filter === ALL_FILTER ? list : list.filter((row) => row.reasonCode === filter);
  }, [envelope, filter]);

  if (loading && !envelope) {
    return <LoadingStatus className="justify-center border-y border-line py-8">ingest 미기록 계정을 불러오는 중</LoadingStatus>;
  }
  if (loadError) {
    return (
      <div
        data-testid="scp-approved-without-ingest-error"
        className="rounded-lg border border-line bg-paper p-4 text-sm text-ink-2"
      >
        목록을 불러오지 못했습니다: {loadError}
      </div>
    );
  }

  const counts = envelope?.countsByReason;
  // countsByReason 은 서버가 전체 스캔 결과에서 낸 정본 집계다(목록 자체는 상한으로 잘릴 수
  // 있다) — 헤더 총계는 이 정본에서 합산한다. envelope?.rows.length 를 쓰면 truncated 일 때
  // 실제보다 작은 숫자를 "총계"라고 보여주게 된다.
  const total = counts ? Object.values(counts).reduce((sum, n) => sum + n, 0) : 0;

  return (
    <div data-testid="scp-approved-without-ingest-panel" className="space-y-4">
      <div className="rounded-lg border border-line bg-paper p-4">
        <div className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
          <span className="font-semibold text-ink">Flu ingest 미기록 승인 계정 {total}명</span>
          <span className="text-ink-3">
            스캔 {envelope?.scanned ?? 0}건
            {envelope?.truncated ? ` · 목록 표시는 ${envelope.rows.length}건까지(상한 도달)` : ""}
          </span>
        </div>
        <p className="mt-2 text-xs text-ink-3">
          승인됐지만 Flu → Portal ingest(대시보드 스냅샷)가 한 번도 성공하지 않은 계정입니다. 실행 액션은
          없습니다(읽기 전용) — 사유별로 담당을 배정해 조치해 주세요.
        </p>
      </div>

      <div className="flex flex-wrap gap-2" data-testid="scp-ingest-gap-reason-buttons">
        <button
          type="button"
          data-testid="scp-ingest-gap-reason-button-all"
          aria-pressed={filter === ALL_FILTER}
          onClick={() => setFilter(ALL_FILTER)}
          className={`min-h-10 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
            filter === ALL_FILTER ? "border-ink bg-fill font-semibold text-ink" : "border-line bg-paper text-ink-2 hover:bg-fill"
          }`}
        >
          <span className="block">전체</span>
          <span className="mt-0.5 block text-[11px] text-ink-3">{total}명</span>
        </button>
        {INGEST_GAP_REASON_CODES.map((code) => {
          const selected = filter === code;
          const count = counts?.[code] ?? 0;
          return (
            <button
              key={code}
              type="button"
              data-testid={`scp-ingest-gap-reason-button-${code}`}
              aria-pressed={selected}
              onClick={() => setFilter(code)}
              className={`min-h-10 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                selected ? "border-ink bg-fill font-semibold text-ink" : "border-line bg-paper text-ink-2 hover:bg-fill"
              }`}
            >
              <span className="block">{REASON_LABEL[code]}</span>
              <span className="mt-0.5 block text-[11px] text-ink-3">{count}명</span>
            </button>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-line bg-paper p-6 text-center text-sm text-ink-2">
          {total === 0 ? "ingest 미기록 승인 계정이 없습니다." : "이 사유에 해당하는 계정이 없습니다."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-paper">
          <table className="w-full min-w-[760px] text-left text-xs" data-testid="scp-approved-without-ingest-table">
            <thead className="border-b border-line text-ink-3">
              <tr>
                <th scope="col" className="px-3 py-2 font-semibold">크리에이터</th>
                <th scope="col" className="px-3 py-2 font-semibold">사유</th>
                <th scope="col" className="px-3 py-2 font-semibold">승인일</th>
                <th scope="col" className="px-3 py-2 font-semibold">마지막 시도</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <IngestGapTableRow key={row.applicationId} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function IngestGapTableRow({ row }: { row: ScpApprovedWithoutIngestRow }) {
  return (
    <tr data-testid="scp-approved-without-ingest-row" className="border-b border-line last:border-b-0 align-top">
      <td className="px-3 py-2">
        <span className="block max-w-[220px] truncate font-semibold text-ink">
          {row.creatorDisplayName || row.creatorHandle || row.fluCreatorId}
        </span>
        <span className="mt-0.5 block text-[11px] text-ink-3">{row.applicationId}</span>
      </td>
      <td className="px-3 py-2">
        <Badge tone={REASON_TONE[row.reasonCode]}>{REASON_LABEL[row.reasonCode]}</Badge>
        {row.suspectedSheetSyncGap ? (
          <span className="mt-1 block text-[11px] text-ink-3">시트 싱크 중단 구간(8/25~8/28) 의심</span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-ink-2">{formatKst(row.approvedAtIso)}</td>
      <td className="px-3 py-2 text-ink-2">
        {row.lastAttempt ? (
          <>
            <span className="block">{formatKst(row.lastAttempt.atIso)}</span>
            <span className="mt-0.5 block text-[11px] text-ink-3">
              {row.lastAttempt.outcome}
              {row.lastAttempt.code ? ` · ${row.lastAttempt.code}` : ""}
              {row.lastAttempt.httpStatus ? ` · HTTP ${row.lastAttempt.httpStatus}` : ""}
            </span>
          </>
        ) : (
          <span className="text-ink-3">시도 없음</span>
        )}
      </td>
    </tr>
  );
}
