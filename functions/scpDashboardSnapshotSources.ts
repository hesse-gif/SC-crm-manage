// SCP 대시보드 스냅샷 프로듀서 — 소스 해석 계층 (schema/contract map 의 코드 정본).
//
// 매핑 tuple 은 super-admin 이 제공한 `scp_portal_creator_bindings`(youtube-oauth
// handoff 와 동일 정본)에서만 해석한다. 이메일 조인 금지. 비활성/부재 매핑은
// fail-closed. 아직 Flu 가 정본을 갖지 못한 소스 필드는 여기에서 명시적으로
// `unresolved` 로 선언되고, 실(비합성) 스냅샷 조립은 해당 필드가 남아 있는 한
// `dashboard_source_unresolved` 로 fail-closed 된다 — 조용한 0/추정치 금지.
//
// docs/integrations/scp-flu-dashboard-contract-map.v1.json (양 저장소 동일 사본)이
// 이 목록의 기계가독 정본이며, 테스트가 코드/문서 동치를 고정한다.

import type { Firestore } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { youtubeOAuthPortalBindingDocumentId } from "./youtubeOAuthHandoff";
import {
  buildDashboardObservationUpsert,
  getMeasurementEndExclusive,
  getViewCpmPolicyForCountry,
  calculateViewCpmRewardMinor,
  SCP_DASHBOARD_CURRENCY,
  SCP_DASHBOARD_DAILY_TIME_ZONE,
  SCP_DASHBOARD_POLICY_VERSION,
  SCP_DASHBOARD_SCHEMA_V1,
  SCP_DASHBOARD_SOURCE_SYSTEM,
  VIEW_CPM_PAYOUT_THRESHOLD_MINOR,
  type AudienceCountryViews,
  type DashboardObservationUpsertWire,
  type DashboardSnapshotV1,
  type PortalDashboardIdentity,
} from "./scpDashboardSnapshotContract";

const BINDINGS_COLLECTION = "scp_portal_creator_bindings";

// ---- 미해결 소스 선언 (기계가독 — contract map 과 pin 테스트로 동기화) -------

export type UnresolvedDashboardSource = {
  field: string;
  reason: string;
  owner: string;
};

export const UNRESOLVED_DASHBOARD_SOURCES: readonly UnresolvedDashboardSource[] = [
  {
    field: "submissions[].totalViews,submissions[].eligibleViews",
    reason:
      "Flu는 일 단위 조회수 시계열(video_view_series)만 보유한다. 계약은 정확한 168시간 반개구간 소스-윈도 총계를 요구하며 일 단위 bin에서 파생하는 것을 금지한다. 정확-윈도 수집기(YouTube Analytics 시각 경계 수집)가 없다.",
    owner: "flu: exact-window view collector (신규)",
  },
  {
    field: "submissions[].audienceRateBasis",
    reason:
      "최근 28 완결일 채널 국가별 조회수 근거가 Flu에 없다. OAuth handoff 로 위임된 크리에이터 자격증명으로 채널 country 리포트를 수집하는 어댑터가 필요하다.",
    owner: "flu: channel audience collector (신규, OAuth credential store 소비)",
  },
  {
    field: "dailyEarnings",
    reason: "7일 대시보드 트렌드 금액의 정본이 없다(뷰CPM 일할 금액은 정확-윈도 수집기 의존).",
    owner: "flu: settlement trend projection (신규)",
  },
  {
    field: "revenue.activityFee,revenue.iap,revenue.referral",
    reason:
      "활동비/추천/IAP 수익 컴포넌트의 정본이 Flu에 없다. v2 revenue-components 계약에서 activity_fee/referral_install/viral_bonus 는 Flu 소유로 분리될 예정이나 아직 소스가 없고, iap/view_cpm 은 포털 소유다.",
    owner: "flu: revenue component facts (flu-revenue-components-v2 선행)",
  },
  {
    field: "referral",
    reason: "클릭→스토어→설치→결제 funnel 은 AppsFlyer OneLink 계측 정본이 필요하다(Flu는 링크 조합만 보유).",
    owner: "flu: AppsFlyer funnel ingestion (신규)",
  },
  {
    field: "activity",
    reason: "지원 활동(upload_published/link_tracked/performance_report_ready) 완료 상태의 단일 정본 프로젝션이 없다.",
    owner: "flu: activity status projection (신규)",
  },
  {
    field: "carryForwardMinor,nextPayoutAt",
    reason: "이월 잔액/차기 지급 일정은 정산 원장 소유이며 Flu에 존재하지 않는다.",
    owner: "portal settlement ledger 또는 별도 정산 시스템",
  },
] as const;

export class DashboardSourceUnresolvedError extends Error {
  readonly code = "dashboard_source_unresolved";
  constructor(readonly unresolved: readonly UnresolvedDashboardSource[]) {
    super(`dashboard source facts unresolved: ${unresolved.map((item) => item.field).join(" | ")}`);
    this.name = "DashboardSourceUnresolvedError";
  }
}

export class DashboardMappingError extends Error {
  constructor(readonly code: "mapping_not_found" | "mapping_inactive" | "mapping_invalid", message: string) {
    super(message);
    this.name = "DashboardMappingError";
  }
}

// ---- 매핑(identity tuple) 해석 ----------------------------------------------

function requiredBindingField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new DashboardMappingError("mapping_invalid", `portal creator binding is missing ${field}`);
  }
  return value;
}

export async function resolvePortalDashboardIdentity(
  fluCreatorId: string,
  db: Firestore = adminDb,
): Promise<PortalDashboardIdentity> {
  const snapshot = await db
    .collection(BINDINGS_COLLECTION)
    .doc(youtubeOAuthPortalBindingDocumentId(fluCreatorId))
    .get();
  if (!snapshot.exists) {
    throw new DashboardMappingError("mapping_not_found", "no provisioned portal creator binding for this Flu creator");
  }
  const record = snapshot.data() ?? {};
  if (record.status !== "active") {
    throw new DashboardMappingError("mapping_inactive", "portal creator binding is not active");
  }
  const identity: PortalDashboardIdentity = {
    portalCreatorId: requiredBindingField(record, "portalCreatorId"),
    fluCreatorId: requiredBindingField(record, "fluCreatorId"),
    partnerId: requiredBindingField(record, "partnerId"),
    programId: requiredBindingField(record, "programId"),
    enrollmentId: requiredBindingField(record, "enrollmentId"),
    channelId: requiredBindingField(record, "channelId"),
  };
  if (identity.fluCreatorId !== fluCreatorId) {
    throw new DashboardMappingError("mapping_invalid", "binding fluCreatorId does not match the requested creator");
  }
  return identity;
}

// ---- 실 스냅샷 조립 (미해결 소스가 남아 있는 동안 fail-closed) ---------------

export function assembleProducerSnapshot(): never {
  // 실(비합성) 스냅샷은 위 UNRESOLVED_DASHBOARD_SOURCES 가 비워질 때까지 생산 금지.
  // 부분 데이터로 지급 가능 스냅샷을 위조하는 폴백은 제공하지 않는다.
  throw new DashboardSourceUnresolvedError(UNRESOLVED_DASHBOARD_SOURCES);
}

// ---- 합성(Eval) 관측 — 스테이징/에뮬레이터 증빙 전용 -------------------------
//
// 계약상 isSynthetic=true 는 Eval fixture 전용이며 절대 지급되지 않는다.
// 결정적 입력(고정 시각/식별자)이면 결정적 바이트가 나온다 — 골든 픽스처의 기반.

export type SyntheticObservationInput = {
  identity: PortalDashboardIdentity;
  revision: string;
  sourceObservationId: string;
  sourceUpdatedAt: string;
  dataAsOf: string;
  trackingUrl?: string;
};

export function buildSyntheticEvalSnapshot(input: SyntheticObservationInput): DashboardSnapshotV1 {
  const dataAsOf = new Date(Date.parse(input.dataAsOf)).toISOString();
  const sourceUpdatedAt = new Date(Date.parse(input.sourceUpdatedAt)).toISOString();
  const periodEnd = dataAsOf.slice(0, 10);
  const dayMs = 86_400_000;
  const endOrdinal = Date.parse(`${periodEnd}T00:00:00.000Z`);
  const dates = Array.from({ length: 7 }, (_, index) =>
    new Date(endOrdinal - (6 - index) * dayMs).toISOString().slice(0, 10),
  );
  const audienceWindowEnd = new Date(endOrdinal - dayMs).toISOString().slice(0, 10);
  const audienceWindowStart = new Date(endOrdinal - 28 * dayMs).toISOString().slice(0, 10);
  const publishedAt = new Date(endOrdinal - 10 * dayMs).toISOString();
  const finalizedAt = getMeasurementEndExclusive(publishedAt);

  // 70% US / 30% T2(FR): 단일 미국 CPM이 전 eligible view 에 적용되는 골든 케이스.
  const countries: AudienceCountryViews[] = [
    { countryCode: "FR", views: "30000" },
    { countryCode: "US", views: "70000" },
  ];
  const policy = getViewCpmPolicyForCountry("US");
  const eligibleViews = "620114";
  const rewardMinor = calculateViewCpmRewardMinor(eligibleViews, policy.cpmMicrosPerThousand);

  return {
    activity: [
      { complete: true, completedAt: sourceUpdatedAt, id: "upload_published" },
      { complete: true, completedAt: sourceUpdatedAt, id: "link_tracked" },
      { complete: false, id: "performance_report_ready" },
    ],
    carryForwardMinor: "0",
    creatorId: input.identity.portalCreatorId,
    currency: SCP_DASHBOARD_CURRENCY,
    dailyEarnings: dates.map((date) => ({
      activityFeeMinor: "0",
      date,
      iapMinor: "0",
      referralMinor: "0",
      viewCpmMinor: "0",
    })),
    dailyTimeZone: SCP_DASHBOARD_DAILY_TIME_ZONE,
    dataAsOf,
    enrollmentId: input.identity.enrollmentId,
    inputWatermark: sourceUpdatedAt,
    isSynthetic: true,
    partnerId: input.identity.partnerId,
    payoutThresholdMinor: VIEW_CPM_PAYOUT_THRESHOLD_MINOR,
    period: { endDate: periodEnd, startDate: dates[0] },
    policyVersion: SCP_DASHBOARD_POLICY_VERSION,
    programId: input.identity.programId,
    referral: {
      clicks: "0",
      installs: "0",
      payers: "0",
      storeVisits: "0",
      trackingUrl: input.trackingUrl ?? "https://supercent.io/scp/eval-synthetic",
    },
    revenue: {
      activityFee: { amountMinor: "0", finalizedAmountMinor: "0" },
      iap: { amountMinor: "0", finalizedAmountMinor: "0" },
      referral: { amountMinor: "0", finalizedAmountMinor: "0" },
    },
    schemaVersion: SCP_DASHBOARD_SCHEMA_V1,
    sourceSystem: SCP_DASHBOARD_SOURCE_SYSTEM,
    sourceUpdatedAt,
    submissions: [
      {
        appliedCpmMicrosPerThousand: policy.cpmMicrosPerThousand,
        appliedTierCode: policy.tierCode,
        audienceRateBasis: {
          collectedAt: dataAsOf,
          countries,
          primaryCountryCode: "US",
          totalViews: "100000",
          window: { endDate: audienceWindowEnd, startDate: audienceWindowStart },
        },
        eligibleViews,
        finalizedAt,
        measurementEndExclusive: getMeasurementEndExclusive(publishedAt),
        measurementStartAt: publishedAt,
        measurementStatus: "finalized",
        publishedAt,
        reviewStatus: "approved",
        rewardAmountMinor: rewardMinor,
        submissionId: "submission_synthetic_001",
        thumbnailUrl: "https://i.ytimg.com/vi/evalsynth001/hqdefault.jpg",
        title: "SCP Eval synthetic submission",
        totalViews: "642700",
        videoUrl: "https://www.youtube.com/watch?v=evalsynth001",
        youtubeVideoId: "evalsynth001",
      },
    ],
  };
}

export function buildSyntheticEvalObservation(input: SyntheticObservationInput): DashboardObservationUpsertWire {
  return buildDashboardObservationUpsert(
    { identity: input.identity, revision: input.revision, sourceObservationId: input.sourceObservationId },
    buildSyntheticEvalSnapshot(input),
  );
}
