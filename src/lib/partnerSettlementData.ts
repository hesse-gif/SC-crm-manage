// FLU-0538 pixel-clone surface 07 (/flu/partners/{id}?tab=performance — 성과·정산 tab) — typed client
// contract for the getPartnerSettlementSnapshot read callable. Mirrors the server snapshot shape 1:1.
// Reads go through the Functions callable (SEC-P0-004 / report-lane §8: no client Firestore direct read).
// DEMO-seeded today (scripts/seed-flu-0538-demo.mjs, demoSeed:true, single --rollback); a real settlement
// projection later writes the same shape. Values port the frozen mockup #settlement section verbatim
// (artifacts/ux-audit-20260719/07-view-settlement-scp-review-mockups.html).
//
// FLU-0540 gap-closure: `buildPartnerSettlementSnapshotFromReal` below is the promotion path — it maps the
// REAL video-performance read-model (the same `VideoPerformanceSummary` + `VideoPerformanceReportRow[]`
// the enrollment-scoped performance tab already fetches via the registered `getVideoPerformanceSummary` /
// `listVideoPerformanceLedger` callables) onto this snapshot shape, so `PartnerSettlementView` can become
// the default performance-tab layout. KPI/CPM/settlement-amount math reuses the exact BigInt-safe
// formatters `PartnerPerformanceSummaryCards`/`PartnerPerformanceCalcPanel` already use — no new money math
// is invented here. Fields the real read-model has no daily/payment-schedule granularity for degrade to an
// honest label instead of the demo's illustrative numbers.
import {
  formatUsdMinor,
  formatViews,
  SETTLEMENT_STATE_LABEL,
  subtractViews,
  sumMoneyMinor,
  formatKstDateTime,
} from "@/components/flu/videoPerformance/formatters";
import type { PartnerVideo, PartnerVideoRevision } from "./partnerData";
import type { VideoPerformanceReportRow, VideoPerformanceSummary } from "./videoPerformanceData";
export type SettlementTone = "green" | "blue" | "amber" | "red" | "purple";

export interface SettlementKpi {
  label: string;
  pillTone: SettlementTone;
  pillText: string;
  value: string;
  micro: string;
}
export interface SettlementTableRow {
  video: string;
  status: string;
  totalViews: string;
  eligibleViews: string;
  countryCpm: string;
  amount: string;
  sync: string;
  muted?: boolean;
}
export interface SettlementLedgerCard {
  label: string;
  value: string;
  micro: string;
  tone: SettlementTone;
}
export interface SettlementHeroVideo {
  title: string;
  channel: string;
  publishedAt: string;
  thumbnailUrl: string | null;
  canonicalUrl: string | null;
  metadata: string;
}
export interface PartnerSettlementSnapshot {
  present: boolean;
  topline: string;
  handle: string;
  displayName: string;
  profileImageUrl: string | null;
  avatarInitial: string;
  imageStatusLabel: string;
  statusPillText: string;
  subtitle: string;
  programLabel: string;
  campaignLabel: string;
  heroVideo: SettlementHeroVideo | null;
  countryProvenance: string;
  ledgers: SettlementLedgerCard[];
  activeTab: string;
  kpis: SettlementKpi[];
  chartTitle: string;
  chartSub: string;
  bars: number[];
  calcTitle: string;
  calcFormula: string[];
  calcResult: string;
  calcMicro: string[];
  tableTitle: string;
  tableSub: string;
  tableHead: string[];
  tableRows: SettlementTableRow[];
  footerNote: string;
  updatedAt: string | null;
}
export interface PartnerSettlementEnvelope {
  ok: boolean;
  snapshot: PartnerSettlementSnapshot;
}

// ---- callable transport (mirrors callPartnerCallable in ./partnerData.ts; standalone so data.ts + its
// tested FLU_CALLABLES union stay untouched — same non-goal as partnerData/managementTabsData) ----
async function callSettlementCallable<TResponse>(name: string, payload: Record<string, unknown> = {}): Promise<TResponse> {
  if (typeof window === "undefined") {
    throw new Error(`Settlement callable "${name}" must be invoked from a client interaction.`);
  }
  const [{ httpsCallable }, { functions, getFluCallableName }] = await Promise.all([
    import("firebase/functions"),
    import("./firebase"),
  ]);
  const callable = httpsCallable<Record<string, unknown>, TResponse>(functions, getFluCallableName(name));
  const result = await callable(payload);
  return result.data;
}

// Demo-gated overlay fetch for surface 07: returns the settlement snapshot (present:false when unseeded,
// so the caller renders nothing extra and the real activation-tab envelope stays untouched).
export async function getPartnerSettlementSnapshot(): Promise<PartnerSettlementSnapshot> {
  const env = await callSettlementCallable<PartnerSettlementEnvelope>("getPartnerSettlementSnapshot");
  return env.snapshot;
}

// ---- FLU-0540 gap-closure: real-data adapter (promotion path) ---------------------------------------
function formatCpm(row: VideoPerformanceReportRow | undefined): string {
  if (!row?.rate) return "—";
  const dollarsPerThousand = Number(row.rate.cpmMicrosPerThousand) / 1_000_000;
  if (!Number.isFinite(dollarsPerThousand)) return "—";
  return `$${dollarsPerThousand.toFixed(dollarsPerThousand % 1 === 0 ? 0 : 2)} / 1K`;
}

function countryProvenance(row: VideoPerformanceReportRow | undefined, hasApprovedVideo = false): string {
  if (!row) return hasApprovedVideo
    ? "국가 근거: 승인 영상 연결됨 · YouTube 추적 소스 없음"
    : "국가 근거: 표시할 영상 없음";
  const declared = row.country.declared ?? "미신고";
  const verified = row.country.verified ?? "미확인";
  const effective = row.country.effective ?? row.country.verified ?? row.country.declared ?? "미정";
  if (row.country.verified) {
    return `국가 근거: 신고 ${declared} → YouTube 검증 ${verified} · 적용 ${effective}`;
  }
  return `국가 근거: 신고 ${declared} · YouTube 검증 미확인 · 적용 ${effective}`;
}

function formatPublishedDate(iso: string | undefined): string {
  if (!iso) return "게시일 —";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "게시일 —";
  return `게시일 ${date.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" })}`;
}

function formatSubmittedDate(iso: string | undefined): string {
  if (!iso) return "제출일 —";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "제출일 —";
  return `제출일 ${date.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" })}`;
}

function currentApprovedRevision(video: PartnerVideo | null | undefined): PartnerVideoRevision | null {
  if (!video) return null;
  return video.revisions.find(
    (revision) => revision.revision === video.currentRevision
      && revision.state === "current"
      && revision.reviewStatus === "approved",
  ) ?? null;
}

const MEASUREMENT_STATE_LABEL: Record<VideoPerformanceReportRow["measurementState"], string> = {
  not_started: "측정 전",
  collecting: "수집 중",
  cutoff_waiting_source: "마감 소스 대기",
  verification_pending: "검증 대기",
  finalized: "측정 확정",
  conflict: "충돌",
  invalidated: "무효",
};

const TRACKING_STATE_LABEL_KO: Record<VideoPerformanceReportRow["trackingState"], string> = {
  not_eligible: "추적 제외",
  registration_pending: "등록 대기",
  active: "추적 중",
  stale: "지연",
  source_diverged: "소스 불일치",
  temporarily_failed: "일시 실패",
  unavailable: "수집 불가",
  cutoff_reached: "마감 완료",
  retired_superseded: "교체 제외",
  retired_withdrawn: "철회 제외",
};

export interface PartnerSettlementRealScope {
  enrollmentId: string;
  programName: string;
  campaignName?: string | null;
  handle: string | null;
  displayName: string;
  profileImageUrl?: string | null;
  avatarInitial?: string;
  currentApprovedVideo: PartnerVideo | null;
}

// Maps the real `VideoPerformanceSummary` + ledger rows (already fetched by the caller against the same
// enrollment/program/campaign scope `PartnerPerformancePanel` uses) onto `PartnerSettlementSnapshot`. Every
// amount/CPM/views figure reuses the shared BigInt-safe formatters — this function only reshapes, it never
// recomputes money. `rows` may be empty (no approved current-revision video yet); the snapshot still
// resolves `present:true` with an honest empty table rather than falling back to a legacy layout.
export function buildPartnerSettlementSnapshotFromReal(
  scope: PartnerSettlementRealScope,
  summary: VideoPerformanceSummary,
  rows: VideoPerformanceReportRow[],
): PartnerSettlementSnapshot {
  const currentApprovedVideo = scope.currentApprovedVideo;
  const approvedRevision = currentApprovedRevision(currentApprovedVideo);
  const matchingRows = approvedRevision && currentApprovedVideo
    ? rows.filter((row) =>
        row.isCurrentRevision
        && row.isApproved
        && row.scope.enrollmentId === scope.enrollmentId
        && row.video.videoSubmissionId === currentApprovedVideo.videoSubmissionId
        && Number(row.video.revision) === approvedRevision.revision
        && row.video.youtubeVideoId === approvedRevision.youtubeVideoId)
    : [];
  const authoritativeRows = matchingRows.length === 1 ? matchingRows : [];
  const representativeRow = authoritativeRows[0];
  const approvedWithoutTracking = Boolean(approvedRevision) && authoritativeRows.length === 0;
  const approvedVideoTitle = scope.currentApprovedVideo?.title ?? approvedRevision?.youtubeVideoId ?? "승인 영상";
  const carryForwardEstimate = sumMoneyMinor(
    authoritativeRows
      .filter((row) => !row.settlement.hasPortalReceipt)
      .map((row) => row.settlement.estimatedAmountMinor),
  );
  // U6(d): representativeRow 가 없으면 조회수는 "없음"이지 0 이 아니다. formatViews("0") 은 화면에
  // "0"을 찍어 실제로 수집된 0회처럼 읽혔다 — null 로 두고 표시 단계에서 "—" 로 떨어뜨린다.
  const currentTotalViews = representativeRow?.metrics.totalViews ?? null;
  const currentEligibleViews = representativeRow?.metrics.eligibleViews ?? null;
  const currentSettlementConfirmedAmount = representativeRow?.settlement.hasPortalReceipt
    ? representativeRow.settlement.portalFinalAmountMinor
      ?? representativeRow.settlement.fluCalculatedAmountMinor
      ?? representativeRow.settlement.estimatedAmountMinor
      ?? "0"
    : "0";
  const totalEstimate = sumMoneyMinor([currentSettlementConfirmedAmount, carryForwardEstimate]);
  const excludedViews = subtractViews(currentTotalViews, currentEligibleViews);
  const effectiveCountry = representativeRow?.country.effective ?? representativeRow?.country.declared;
  const verifiedLedgerAmount = currentSettlementConfirmedAmount;
  const provisionalLedgerAmount = carryForwardEstimate;

  const maxEligible = authoritativeRows.slice(0, 7).reduce((max, row) => {
    const value = row.metrics.eligibleViews ? Number(row.metrics.eligibleViews) : 0;
    return Number.isFinite(value) && value > max ? value : max;
  }, 0);
  const bars = authoritativeRows.slice(0, 7).map((row) => {
    const value = row.metrics.eligibleViews ? Number(row.metrics.eligibleViews) : 0;
    return maxEligible > 0 ? Math.max(8, Math.round((value / maxEligible) * 140)) : 8;
  });

  return {
    present: true,
    topline: "← 파트너 목록",
    handle: scope.handle ?? scope.displayName ?? "—",
    displayName: scope.displayName,
    profileImageUrl: scope.profileImageUrl ?? representativeRow?.creator.profileImageUrl ?? null,
    avatarInitial: scope.avatarInitial ?? (scope.displayName || scope.handle || "P").slice(0, 1).toUpperCase(),
    imageStatusLabel: scope.profileImageUrl ?? representativeRow?.creator.profileImageUrl ? "이미지 연결됨" : "이미지 미연결 · 복구 필요",
    statusPillText: "Partner 활성",
    subtitle: "활성 Partner 성과·정산",
    programLabel: scope.programName || "프로그램 미지정",
    campaignLabel: scope.campaignName || "캠페인 미지정",
    heroVideo: representativeRow
      ? {
          title: representativeRow.video.title,
          channel: representativeRow.video.channelTitle ?? representativeRow.creator.handle ?? representativeRow.creator.displayName,
          publishedAt: formatPublishedDate(representativeRow.video.publishedAt),
          thumbnailUrl: representativeRow.video.thumbnailUrl ?? null,
          canonicalUrl: representativeRow.video.canonicalUrl ?? null,
          metadata: `개정 ${representativeRow.video.revision} · ${MEASUREMENT_STATE_LABEL[representativeRow.measurementState]} · ${TRACKING_STATE_LABEL_KO[representativeRow.trackingState]}`,
        }
      : approvedRevision
        ? {
            title: approvedVideoTitle,
            channel: scope.handle ?? scope.displayName,
            publishedAt: formatSubmittedDate(approvedRevision.submittedAtIso),
            thumbnailUrl: scope.currentApprovedVideo?.thumbnailUrl ?? null,
            canonicalUrl: approvedRevision.canonicalUrl || null,
            metadata: `개정 ${approvedRevision.revision} · 승인됨 · 추적 소스 없음`,
          }
        : null,
    countryProvenance: countryProvenance(representativeRow, Boolean(approvedRevision)),
    ledgers: [
      {
        label: "임시 원장",
        value: provisionalLedgerAmount ? formatUsdMinor(provisionalLedgerAmount) : "—",
        micro: "Portal 영수증 전 추정/이월 금액",
        tone: "amber",
      },
      {
        label: "검증 원장",
        value: approvedWithoutTracking ? "—" : formatUsdMinor(verifiedLedgerAmount),
        micro: approvedWithoutTracking ? "승인 영상 연결됨 · 추적 소스 없음" : "Portal 확정 영수증 반영 금액",
        tone: "green",
      },
    ],
    activeTab: "성과·정산",
    kpis: [
      {
        label: "이번 정산 예상",
        pillTone: "amber",
        pillText: "추정",
        value: totalEstimate ? formatUsdMinor(totalEstimate) : "—",
        micro: approvedWithoutTracking
          ? "추적 소스 없음 · 산정하지 않음"
          : `확정 ${formatUsdMinor(currentSettlementConfirmedAmount)} · 이월 ${carryForwardEstimate ? formatUsdMinor(carryForwardEstimate) : "—"}`,
      },
      {
        label: "인정 조회수",
        pillTone: "blue",
        pillText: "168h",
        value: approvedWithoutTracking || currentEligibleViews === null ? "—" : formatViews(currentEligibleViews),
        micro: approvedWithoutTracking
          ? "승인 영상 연결됨 · 추적 소스 없음"
          : currentTotalViews === null
            ? "추적 소스 없음 · 수집된 조회수 없음"
            : `전체 ${formatViews(currentTotalViews)} · 제외 ${excludedViews ? formatViews(excludedViews) : "—"}`,
      },
      {
        label: "적용 CPM",
        pillTone: "green",
        pillText: effectiveCountry ?? "—",
        value: formatCpm(representativeRow),
        micro: representativeRow
          ? countryProvenance(representativeRow).replace("국가 근거: ", "")
          : approvedRevision
            ? "승인 영상 연결됨 · 추적 소스 없음"
            : "표시할 영상 없음",
      },
      {
        // U6(e): 이 카드는 Portal 지급 일정 연동 전까지 **항상** 값이 없다. 영구 amber "확인 필요"
        // 배지는 운영자가 고칠 수 있는 문제처럼 읽혀 매번 확인 비용만 만들었다 — 상태가 아니라
        // 사실("연동 전")을 중립 톤으로 밝힌다.
        label: "다음 지급",
        // 톤 유니온을 늘리지 않는다(픽셀 클론 셸 매핑 불변) — 경고 amber 대신 정보 blue.
        pillTone: "blue",
        pillText: "연동 전",
        value: "—",
        micro: "Portal 지급 일정·최소 지급액 연동 전 — 확인할 항목 없음",
      },
    ],
    chartTitle: "영상별 인정 조회수",
    chartSub: "승인된 현재 revision 기준 (일별 시계열 데이터 없음)",
    bars,
    calcTitle: "정산 계산 근거",
    calcFormula: representativeRow
      ? [`${formatViews(representativeRow.metrics.eligibleViews)} eligible views`, `× ${formatCpm(representativeRow).replace(" / 1K", "")} CPM`]
      : approvedRevision
        ? ["승인 영상은 연결되었으나 추적 소스가 없습니다"]
        : ["표시할 영상이 없습니다"],
    calcResult: representativeRow
      ? `= ${formatUsdMinor(representativeRow.settlement.estimatedAmountMinor ?? representativeRow.settlement.fluCalculatedAmountMinor)}`
      : "—",
    calcMicro: representativeRow
      ? [
          countryProvenance(representativeRow),
          `영상 메타: ${representativeRow.video.title} · ${formatPublishedDate(representativeRow.video.publishedAt)}`,
        ]
      : approvedRevision
        ? [
            `현재 승인 영상: ${approvedVideoTitle} · 개정 ${approvedRevision.revision}`,
            "조회수·정산 값은 추적 소스가 생기기 전까지 산정하지 않음",
          ]
        : [],
    tableTitle: "영상별 정산 내역",
    tableSub: "승인된 현재 revision만 정산 대상",
    tableHead: ["영상", "상태", "전체 조회", "인정 조회", "국가 / CPM", "금액", "동기화"],
    tableRows: authoritativeRows.length > 0
      ? authoritativeRows.map((row) => ({
          video: `${row.video.title} · 개정 ${row.video.revision}`,
          status: SETTLEMENT_STATE_LABEL[row.settlement.state],
          totalViews: formatViews(row.metrics.totalViews),
          eligibleViews: row.metrics.eligibleViews ? formatViews(row.metrics.eligibleViews) : "—",
          countryCpm: `${row.country.verified ? `YT ${row.country.verified}` : `신고 ${row.country.declared ?? "—"}`} · 적용 ${row.country.effective ?? row.country.declared ?? "—"} · ${formatCpm(row)}`,
          amount: formatUsdMinor(
            row.settlement.estimatedAmountMinor ?? row.settlement.fluCalculatedAmountMinor ?? row.settlement.portalFinalAmountMinor,
          ),
          sync: formatKstDateTime(row.lastSyncedAt),
          muted: !row.isCurrentRevision,
        }))
      : approvedRevision
        ? [{
            video: `${approvedVideoTitle} · 개정 ${approvedRevision.revision}`,
            status: "추적 소스 없음",
            totalViews: "—",
            eligibleViews: "—",
            countryCpm: "추적 소스 없음",
            amount: "—",
            sync: "—",
            muted: true,
          }]
        : [],
    footerNote: approvedRevision && authoritativeRows.length === 0
      ? "승인 영상은 연결되었지만 YouTube 추적 소스가 없어 조회수·정산 값을 산정하지 않음"
      : summary.coverage.complete
        ? "Flu 원장과 YouTube 검증 근거를 모두 보존"
        : `일부 소스 제외됨: ${summary.coverage.excludedReasons.join(", ") || "사유 미상"}`,
    updatedAt: new Date().toISOString(),
  };
}
