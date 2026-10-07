// SCP Creator Portal 대시보드 스냅샷 프로듀서 — 계약/머니 수학 코어 (P1-FLU-PRODUCER).
//
// 포털 ingest 계약(scp-creator-portal docs/integrations/flu-dashboard-ingest-v1.md,
// src/lib/creatorDashboardDomain.ts / viewCpmPolicy.ts)을 프로듀서 측에서 그대로
// 강제한다: 잘못된 스냅샷은 와이어에 올라가기 전에 여기서 fail-closed 된다.
//
// - 모든 금액/카운트는 십진 문자열(BigInt 연산, JS Number 금지).
// - View CPM 보상: floor(eligibleViews × appliedCpmMicrosPerThousand / 10,000,000)
//   — 제출물당 단 한 번 minor 단위 floor. 국가 가중 평균 금지.
// - 측정 창: [publishedAt, publishedAt + 168h) 정확한 반개구간(UTC ms — DST 무관).
// - 28일 audienceRateBasis: 최고 조회 국가 1개(동률 fail-closed)의 단일 CPM.
// - 이 모듈은 순수(pure)이며 Firestore/네트워크에 접근하지 않는다.

export const SCP_DASHBOARD_SCHEMA_V1 = "flu.creator-dashboard.v1" as const;
export const SCP_DASHBOARD_SCHEMA_V1_1 = "flu.creator-dashboard.v1.1" as const;
export const SCP_DASHBOARD_SOURCE_SYSTEM = "flu" as const;
export const SCP_DASHBOARD_POLICY_VERSION = "view-cpm-2026-07-v1" as const;
export const SCP_DASHBOARD_CURRENCY = "USD" as const;
export const SCP_DASHBOARD_DAILY_TIME_ZONE = "America/Los_Angeles" as const;
export const VIEW_CPM_WINDOW_HOURS = 168;
export const VIEW_CPM_WINDOW_MS = VIEW_CPM_WINDOW_HOURS * 60 * 60 * 1_000;
export const VIEW_CPM_AUDIENCE_WINDOW_DAYS = 28;
export const VIEW_CPM_PAYOUT_THRESHOLD_MINOR = "5000";
export const VIEW_CPM_REWARD_DIVISOR = 10_000_000n;
export const DASHBOARD_MAX_SUBMISSIONS = 100;
export const DASHBOARD_DAILY_TREND_DAYS = 7;

// 포털 src/lib/viewCpmPolicy.ts 사본 — 두 저장소의 계약 맵 pin 테스트가 동치를 고정한다.
export const VIEW_CPM_TIER_CODES = ["US", "T1", "T2", "T3", "T4"] as const;
export type ViewCpmTierCode = (typeof VIEW_CPM_TIER_CODES)[number];

export const VIEW_CPM_COUNTRIES_BY_TIER: Readonly<Record<"T1" | "T2" | "T3", readonly string[]>> = {
  T1: ["KR", "JP", "DE", "GB", "CA", "AU", "CH"],
  T2: ["FR", "RU", "TW", "IT", "NL", "ES", "IL", "HK", "SG", "AT", "BE", "NZ", "SE", "DK", "NO", "PT", "FI", "IE", "IS", "LU", "LI"],
  T3: ["BR", "MX", "TR", "MY", "VN", "ID", "PL", "TH", "PH", "SA", "CL", "AR", "ZA", "CO", "AE", "PE", "UA", "CZ", "RO", "HU", "RS", "BG", "HR", "LT", "GT", "BY", "PR", "BO", "UY", "EC", "LV", "GE", "EE", "AL", "CR", "DO", "BA", "AM", "PY", "MD", "MK", "JM", "PA", "TT", "ME", "BB", "XK"],
};

export const VIEW_CPM_MICROS_PER_THOUSAND: Readonly<Record<ViewCpmTierCode, string>> = {
  US: "12000000",
  T1: "10000000",
  T2: "8000000",
  T3: "2000000",
  T4: "500000",
};

export const DASHBOARD_ACTIVITY_IDS = [
  "upload_published",
  "link_tracked",
  "performance_report_ready",
] as const;
export type DashboardActivityId = (typeof DASHBOARD_ACTIVITY_IDS)[number];

export type DashboardContractIssue = { field: string; reason: string };

export class DashboardProducerContractError extends Error {
  readonly code = "dashboard_producer_contract_invalid";
  constructor(readonly issues: DashboardContractIssue[]) {
    super(`dashboard producer contract invalid: ${issues.map((issue) => issue.field).join(", ")}`);
    this.name = "DashboardProducerContractError";
  }
}

function invalid(field: string, reason: string): never {
  throw new DashboardProducerContractError([{ field, reason }]);
}

// ---- 기본 타입 (포털 normalizeFluDashboardIngest 와 1:1) --------------------

export type AudienceCountryViews = { countryCode: string; views: string };

export type AudienceRateBasis = {
  collectedAt: string;
  countries: AudienceCountryViews[];
  primaryCountryCode: string;
  totalViews: string;
  window: { endDate: string; startDate: string };
};

export type SubmissionRewardFact = {
  appliedCpmMicrosPerThousand: string;
  appliedTierCode: ViewCpmTierCode;
  audienceRateBasis: AudienceRateBasis;
  eligibleViews: string;
  finalizedAt?: string;
  measurementEndExclusive: string;
  measurementStartAt: string;
  measurementStatus: "in_progress" | "finalized";
  publishedAt: string;
  reviewStatus: "approved" | "pending" | "rejected";
  rewardAmountMinor: string;
  submissionId: string;
  thumbnailUrl: string;
  title: string;
  totalViews: string;
  videoUrl: string;
  youtubeVideoId: string;
};

export type DashboardRevenueFact = { amountMinor: string; finalizedAmountMinor: string };

export type DashboardDailyFact = {
  activityFeeMinor: string;
  date: string;
  iapMinor: string;
  referralMinor: string;
  viewCpmMinor: string;
};

export type DashboardActivityFact = { complete: boolean; completedAt?: string; id: DashboardActivityId };

export type DashboardSnapshotV1 = {
  activity: DashboardActivityFact[];
  carryForwardMinor: string;
  creatorId: string;
  currency: typeof SCP_DASHBOARD_CURRENCY;
  dailyEarnings: DashboardDailyFact[];
  dailyTimeZone: typeof SCP_DASHBOARD_DAILY_TIME_ZONE;
  dataAsOf: string;
  enrollmentId: string;
  inputWatermark: string;
  isSynthetic: boolean;
  nextPayoutAt?: string;
  partnerId: string;
  payoutThresholdMinor: string;
  period: { endDate: string; startDate: string };
  policyVersion: string;
  programId: string;
  referral: { clicks: string; installs: string; payers: string; storeVisits: string; trackingUrl: string };
  revenue: { activityFee: DashboardRevenueFact; iap: DashboardRevenueFact; referral: DashboardRevenueFact };
  schemaVersion: typeof SCP_DASHBOARD_SCHEMA_V1;
  sourceSystem: string;
  sourceUpdatedAt: string;
  submissions: SubmissionRewardFact[];
};

export type PortalDashboardIdentity = {
  portalCreatorId: string;
  fluCreatorId: string;
  partnerId: string;
  programId: string;
  enrollmentId: string;
  channelId: string;
};

// v1.1 wire envelope: 관측 identity + v1 필드가 같은 top level에 평탄화되고
// legacy creatorId 대신 portalCreatorId 를 쓴다 (포털 normalizeFluDashboardObservation).
export type DashboardObservationUpsertWire = Omit<DashboardSnapshotV1, "creatorId" | "schemaVersion"> & {
  channelId: string;
  fluCreatorId: string;
  operation: "upsert";
  portalCreatorId: string;
  revision: string;
  schemaVersion: typeof SCP_DASHBOARD_SCHEMA_V1_1;
  sourceObservationId: string;
  sourceWatermark: string;
};

export type DashboardObservationDeleteWire = {
  channelId: string;
  deletedAt: string;
  deletionReasonCode: string;
  enrollmentId: string;
  fluCreatorId: string;
  operation: "delete";
  partnerId: string;
  policyVersion: string;
  portalCreatorId: string;
  programId: string;
  revision: string;
  schemaVersion: typeof SCP_DASHBOARD_SCHEMA_V1_1;
  sourceObservationId: string;
  sourceSystem: string;
  sourceUpdatedAt: string;
  sourceWatermark: string;
};

// ---- 정책/머니 수학 ---------------------------------------------------------

export function getViewCpmPolicyForCountry(countryCode: string): { cpmMicrosPerThousand: string; tierCode: ViewCpmTierCode } {
  const normalized = countryCode.trim().toUpperCase();
  let tierCode: ViewCpmTierCode = "T4";
  if (normalized === "US") tierCode = "US";
  else if (VIEW_CPM_COUNTRIES_BY_TIER.T1.includes(normalized)) tierCode = "T1";
  else if (VIEW_CPM_COUNTRIES_BY_TIER.T2.includes(normalized)) tierCode = "T2";
  else if (VIEW_CPM_COUNTRIES_BY_TIER.T3.includes(normalized)) tierCode = "T3";
  return { cpmMicrosPerThousand: VIEW_CPM_MICROS_PER_THOUSAND[tierCode], tierCode };
}

export function calculateViewCpmRewardMinor(eligibleViews: string, cpmMicrosPerThousand: string): string {
  return (
    (BigInt(requireUnsignedInteger(eligibleViews, "eligibleViews")) *
      BigInt(requireUnsignedInteger(cpmMicrosPerThousand, "appliedCpmMicrosPerThousand"))) /
    VIEW_CPM_REWARD_DIVISOR
  ).toString();
}

export function getMeasurementEndExclusive(publishedAt: string): string {
  const start = Date.parse(publishedAt);
  if (Number.isNaN(start)) invalid("publishedAt", "must be an ISO timestamp");
  return new Date(start + VIEW_CPM_WINDOW_MS).toISOString();
}

export type PrimaryAudienceCountry = { countryCode: string; totalViews: string; views: string };

// 포털 selectPrimaryAudienceCountry 와 동일: 최고 조회 국가 1개, 1위 동률은 fail-closed.
export function selectPrimaryAudienceCountry(countries: readonly AudienceCountryViews[]): PrimaryAudienceCountry {
  if (countries.length === 0) invalid("audienceRateBasis.countries", "audience country rows are required");
  const sorted = [...countries].sort((a, b) => {
    const left = BigInt(a.views);
    const right = BigInt(b.views);
    if (left !== right) return left > right ? -1 : 1;
    return a.countryCode.localeCompare(b.countryCode);
  });
  const primary = sorted[0];
  const runnerUp = sorted[1];
  if (BigInt(primary.views) === 0n) invalid("audienceRateBasis.countries", "audience country views must contain a positive value");
  if (runnerUp && BigInt(primary.views) === BigInt(runnerUp.views)) {
    invalid("audienceRateBasis.primaryCountryCode", "highest view count is tied; primary country is ambiguous");
  }
  const totalViews = countries.reduce((sum, country) => sum + BigInt(country.views), 0n).toString();
  return { countryCode: primary.countryCode, totalViews, views: primary.views };
}

// ---- 프로듀서 측 스냅샷 검증 (와이어 이전 fail-closed) ----------------------

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireIdentifier(value: string, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) invalid(field, "is not a supported identifier");
  return value;
}

function requireUnsignedInteger(value: string, field: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) invalid(field, "must be a non-negative integer string");
  return BigInt(value.trim()).toString();
}

function requireIsoInstant(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (typeof value !== "string" || Number.isNaN(parsed)) invalid(field, "must be an ISO timestamp");
  return new Date(parsed).toISOString();
}

function requireDate(value: string, field: string): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) invalid(field, "must be a YYYY-MM-DD date");
  if (new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) invalid(field, "must be a valid date");
  return value;
}

function requireHttpsUrl(value: string, field: string): string {
  try {
    if (new URL(value).protocol !== "https:") invalid(field, "must be an https URL");
  } catch {
    invalid(field, "must be an https URL");
  }
  return value;
}

function dateOrdinal(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`) / 86_400_000;
}

function sumMinor(values: readonly string[]): bigint {
  return values.reduce((sum, value) => sum + BigInt(value), 0n);
}

export function validateAudienceRateBasis(basis: AudienceRateBasis, field: string): void {
  requireIsoInstant(basis.collectedAt, `${field}.collectedAt`);
  requireDate(basis.window.startDate, `${field}.window.startDate`);
  requireDate(basis.window.endDate, `${field}.window.endDate`);
  if (dateOrdinal(basis.window.endDate) - dateOrdinal(basis.window.startDate) + 1 !== VIEW_CPM_AUDIENCE_WINDOW_DAYS) {
    invalid(`${field}.window`, `must contain exactly ${VIEW_CPM_AUDIENCE_WINDOW_DAYS} inclusive source dates`);
  }
  if (basis.window.endDate > basis.collectedAt.slice(0, 10)) invalid(`${field}.window.endDate`, "cannot be after collectedAt");
  if (basis.countries.length === 0 || basis.countries.length > 200) invalid(`${field}.countries`, "must contain 1 to 200 rows");
  const codes = basis.countries.map((row) => row.countryCode);
  if (new Set(codes).size !== codes.length) invalid(`${field}.countries`, "country codes must be unique");
  for (const row of basis.countries) {
    if (!/^[A-Z]{2}$/.test(row.countryCode)) invalid(`${field}.countries.countryCode`, "must be ISO alpha-2");
    requireUnsignedInteger(row.views, `${field}.countries.views`);
  }
  const primary = selectPrimaryAudienceCountry(basis.countries);
  if (basis.totalViews !== primary.totalViews) invalid(`${field}.totalViews`, "must equal the country-row sum");
  if (basis.primaryCountryCode !== primary.countryCode) {
    invalid(`${field}.primaryCountryCode`, "must be the unique highest-view country");
  }
}

export function validateSubmissionRewardFact(item: SubmissionRewardFact, index: number, dataAsOf: string): void {
  const field = `submissions[${index}]`;
  requireIdentifier(item.submissionId, `${field}.submissionId`);
  requireIdentifier(item.youtubeVideoId, `${field}.youtubeVideoId`);
  requireHttpsUrl(item.videoUrl, `${field}.videoUrl`);
  requireHttpsUrl(item.thumbnailUrl, `${field}.thumbnailUrl`);
  if (!item.title.trim()) invalid(`${field}.title`, "is required");

  const publishedAt = requireIsoInstant(item.publishedAt, `${field}.publishedAt`);
  if (Date.parse(item.measurementStartAt) !== Date.parse(publishedAt)) {
    invalid(`${field}.measurementStartAt`, "must equal publishedAt");
  }
  if (item.measurementEndExclusive !== getMeasurementEndExclusive(publishedAt)) {
    invalid(`${field}.measurementEndExclusive`, "must be exactly 168 hours after publishedAt");
  }
  if (Date.parse(publishedAt) > Date.parse(dataAsOf)) invalid(`${field}.publishedAt`, "cannot be after dataAsOf");

  requireUnsignedInteger(item.totalViews, `${field}.totalViews`);
  requireUnsignedInteger(item.eligibleViews, `${field}.eligibleViews`);
  if (BigInt(item.eligibleViews) > BigInt(item.totalViews)) invalid(`${field}.eligibleViews`, "cannot exceed totalViews");

  validateAudienceRateBasis(item.audienceRateBasis, `${field}.audienceRateBasis`);
  const expectedPolicy = getViewCpmPolicyForCountry(item.audienceRateBasis.primaryCountryCode);
  if (item.appliedTierCode !== expectedPolicy.tierCode || item.appliedCpmMicrosPerThousand !== expectedPolicy.cpmMicrosPerThousand) {
    invalid(`${field}.appliedTierCode`, "must apply the single CPM for the recent-28-day primary audience country");
  }

  if (item.measurementStatus === "finalized") {
    if (!item.finalizedAt) invalid(`${field}.finalizedAt`, "is required for finalized measurements");
    if (Date.parse(item.finalizedAt) < Date.parse(item.measurementEndExclusive)) {
      invalid(`${field}.finalizedAt`, "cannot be before measurementEndExclusive");
    }
    if (Date.parse(item.finalizedAt) > Date.parse(dataAsOf)) invalid(`${field}.finalizedAt`, "cannot be after dataAsOf");
  } else if (item.finalizedAt) {
    invalid(`${field}.finalizedAt`, "is not allowed while in_progress");
  }

  const expectedReward = item.reviewStatus === "approved"
    ? calculateViewCpmRewardMinor(item.eligibleViews, item.appliedCpmMicrosPerThousand)
    : "0";
  if (item.rewardAmountMinor !== expectedReward) {
    invalid(`${field}.rewardAmountMinor`, "does not match approved eligible views and CPM (floor once, minor units)");
  }
}

export function validateDashboardSnapshotV1(snapshot: DashboardSnapshotV1): DashboardSnapshotV1 {
  if (snapshot.schemaVersion !== SCP_DASHBOARD_SCHEMA_V1) invalid("schemaVersion", "must be flu.creator-dashboard.v1");
  requireIdentifier(snapshot.creatorId, "creatorId");
  requireIdentifier(snapshot.partnerId, "partnerId");
  requireIdentifier(snapshot.programId, "programId");
  requireIdentifier(snapshot.enrollmentId, "enrollmentId");
  requireIdentifier(snapshot.policyVersion, "policyVersion");
  requireIdentifier(snapshot.sourceSystem, "sourceSystem");
  if (snapshot.currency !== SCP_DASHBOARD_CURRENCY) invalid("currency", "must be USD");
  if (snapshot.dailyTimeZone !== SCP_DASHBOARD_DAILY_TIME_ZONE) invalid("dailyTimeZone", `must be ${SCP_DASHBOARD_DAILY_TIME_ZONE}`);
  if (snapshot.payoutThresholdMinor !== VIEW_CPM_PAYOUT_THRESHOLD_MINOR) {
    invalid("payoutThresholdMinor", `must match the View CPM policy value ${VIEW_CPM_PAYOUT_THRESHOLD_MINOR}`);
  }
  requireUnsignedInteger(snapshot.carryForwardMinor, "carryForwardMinor");

  const dataAsOf = requireIsoInstant(snapshot.dataAsOf, "dataAsOf");
  const sourceUpdatedAt = requireIsoInstant(snapshot.sourceUpdatedAt, "sourceUpdatedAt");
  const inputWatermark = requireIsoInstant(snapshot.inputWatermark, "inputWatermark");
  if (Date.parse(sourceUpdatedAt) > Date.parse(dataAsOf) || Date.parse(inputWatermark) > Date.parse(dataAsOf)) {
    invalid("dataAsOf", "sourceUpdatedAt and inputWatermark cannot be later than dataAsOf");
  }
  if (snapshot.nextPayoutAt !== undefined) requireIsoInstant(snapshot.nextPayoutAt, "nextPayoutAt");

  requireDate(snapshot.period.startDate, "period.startDate");
  requireDate(snapshot.period.endDate, "period.endDate");
  if (snapshot.period.startDate > snapshot.period.endDate) invalid("period", "startDate must not be after endDate");

  if (snapshot.submissions.length > DASHBOARD_MAX_SUBMISSIONS) invalid("submissions", "cannot exceed 100 items");
  const submissionIds = snapshot.submissions.map((item) => item.submissionId);
  if (new Set(submissionIds).size !== submissionIds.length) invalid("submissions.submissionId", "must be unique");
  const videoIds = snapshot.submissions.map((item) => item.youtubeVideoId);
  if (new Set(videoIds).size !== videoIds.length) invalid("submissions.youtubeVideoId", "must be unique");
  snapshot.submissions.forEach((item, index) => validateSubmissionRewardFact(item, index, dataAsOf));

  if (snapshot.dailyEarnings.length !== DASHBOARD_DAILY_TREND_DAYS) {
    invalid("dailyEarnings", "must contain exactly seven consecutive source-calendar dates");
  }
  snapshot.dailyEarnings.forEach((item, index) => {
    requireDate(item.date, `dailyEarnings[${index}].date`);
    for (const key of ["activityFeeMinor", "iapMinor", "referralMinor", "viewCpmMinor"] as const) {
      requireUnsignedInteger(item[key], `dailyEarnings[${index}].${key}`);
    }
    if (item.date < snapshot.period.startDate || item.date > snapshot.period.endDate) {
      invalid(`dailyEarnings[${index}].date`, "must be inside the dashboard period");
    }
    if (index > 0 && dateOrdinal(item.date) - dateOrdinal(snapshot.dailyEarnings[index - 1].date) !== 1) {
      invalid("dailyEarnings", "dates must be ascending and consecutive");
    }
  });

  for (const [key, fact] of Object.entries(snapshot.revenue) as Array<[string, DashboardRevenueFact]>) {
    requireUnsignedInteger(fact.amountMinor, `revenue.${key}.amountMinor`);
    requireUnsignedInteger(fact.finalizedAmountMinor, `revenue.${key}.finalizedAmountMinor`);
    if (BigInt(fact.finalizedAmountMinor) > BigInt(fact.amountMinor)) {
      invalid(`revenue.${key}.finalizedAmountMinor`, "cannot exceed amountMinor");
    }
  }
  const approvedViewCpm = sumMinor(
    snapshot.submissions.filter((item) => item.reviewStatus === "approved").map((item) => item.rewardAmountMinor),
  );
  const dailyBounds: Array<[string, bigint, bigint]> = [
    ["viewCpm", sumMinor(snapshot.dailyEarnings.map((item) => item.viewCpmMinor)), approvedViewCpm],
    ["activityFee", sumMinor(snapshot.dailyEarnings.map((item) => item.activityFeeMinor)), BigInt(snapshot.revenue.activityFee.amountMinor)],
    ["referral", sumMinor(snapshot.dailyEarnings.map((item) => item.referralMinor)), BigInt(snapshot.revenue.referral.amountMinor)],
    ["iap", sumMinor(snapshot.dailyEarnings.map((item) => item.iapMinor)), BigInt(snapshot.revenue.iap.amountMinor)],
  ];
  for (const [label, daily, period] of dailyBounds) {
    if (daily > period) invalid(`dailyEarnings.${label}`, "cannot exceed its period total");
  }

  for (const key of ["clicks", "installs", "payers", "storeVisits"] as const) {
    requireUnsignedInteger(snapshot.referral[key], `referral.${key}`);
  }
  requireHttpsUrl(snapshot.referral.trackingUrl, "referral.trackingUrl");
  if (
    BigInt(snapshot.referral.payers) > BigInt(snapshot.referral.installs) ||
    BigInt(snapshot.referral.installs) > BigInt(snapshot.referral.storeVisits) ||
    BigInt(snapshot.referral.storeVisits) > BigInt(snapshot.referral.clicks)
  ) {
    invalid("referral", "funnel must satisfy payers <= installs <= storeVisits <= clicks");
  }

  const activityIds = snapshot.activity.map((item) => item.id);
  if (
    snapshot.activity.length !== DASHBOARD_ACTIVITY_IDS.length ||
    DASHBOARD_ACTIVITY_IDS.some((id) => !activityIds.includes(id)) ||
    new Set(activityIds).size !== activityIds.length
  ) {
    invalid("activity", "must contain every supported activity id exactly once");
  }
  for (const [index, item] of snapshot.activity.entries()) {
    if (item.complete !== Boolean(item.completedAt)) {
      invalid(`activity[${index}].completedAt`, "must exist exactly when complete is true");
    }
    if (item.completedAt !== undefined) requireIsoInstant(item.completedAt, `activity[${index}].completedAt`);
  }
  return snapshot;
}

// ---- v1.1 관측 봉투 ---------------------------------------------------------

export type ObservationEnvelopeInput = {
  identity: PortalDashboardIdentity;
  revision: string;
  sourceObservationId: string;
};

export function buildDashboardObservationUpsert(
  input: ObservationEnvelopeInput,
  snapshot: DashboardSnapshotV1,
): DashboardObservationUpsertWire {
  validateDashboardSnapshotV1(snapshot);
  const { identity } = input;
  for (const [field, value] of Object.entries(identity)) requireIdentifier(value, `identity.${field}`);
  requireUnsignedInteger(input.revision, "revision");
  requireIdentifier(input.sourceObservationId, "sourceObservationId");
  if (snapshot.creatorId !== identity.portalCreatorId) {
    invalid("creatorId", "v1 creatorId must be the provisioned portalCreatorId");
  }
  if (
    snapshot.partnerId !== identity.partnerId ||
    snapshot.programId !== identity.programId ||
    snapshot.enrollmentId !== identity.enrollmentId
  ) {
    invalid("identity", "observation identity does not match its dashboard payload");
  }
  const { creatorId: _creatorId, schemaVersion: _schemaVersion, ...v1Fields } = snapshot;
  return {
    ...v1Fields,
    channelId: identity.channelId,
    fluCreatorId: identity.fluCreatorId,
    operation: "upsert",
    portalCreatorId: identity.portalCreatorId,
    revision: input.revision,
    schemaVersion: SCP_DASHBOARD_SCHEMA_V1_1,
    sourceObservationId: input.sourceObservationId,
    // upsert 계약: top-level sourceWatermark == 내장 v1 inputWatermark.
    sourceWatermark: snapshot.inputWatermark,
  };
}

export function buildDashboardObservationDelete(input: {
  identity: PortalDashboardIdentity;
  revision: string;
  sourceObservationId: string;
  policyVersion: string;
  sourceUpdatedAt: string;
  sourceWatermark: string;
  deletedAt: string;
  deletionReasonCode: string;
}): DashboardObservationDeleteWire {
  for (const [field, value] of Object.entries(input.identity)) requireIdentifier(value, `identity.${field}`);
  requireUnsignedInteger(input.revision, "revision");
  requireIdentifier(input.sourceObservationId, "sourceObservationId");
  requireIdentifier(input.deletionReasonCode, "deletionReasonCode");
  const sourceUpdatedAt = requireIsoInstant(input.sourceUpdatedAt, "sourceUpdatedAt");
  const deletedAt = requireIsoInstant(input.deletedAt, "deletedAt");
  if (deletedAt < sourceUpdatedAt) invalid("deletedAt", "cannot be earlier than sourceUpdatedAt");
  return {
    channelId: input.identity.channelId,
    deletedAt,
    deletionReasonCode: input.deletionReasonCode,
    enrollmentId: input.identity.enrollmentId,
    fluCreatorId: input.identity.fluCreatorId,
    operation: "delete",
    partnerId: input.identity.partnerId,
    policyVersion: input.policyVersion,
    portalCreatorId: input.identity.portalCreatorId,
    programId: input.identity.programId,
    sourceSystem: SCP_DASHBOARD_SOURCE_SYSTEM,
    revision: input.revision,
    schemaVersion: SCP_DASHBOARD_SCHEMA_V1_1,
    sourceObservationId: input.sourceObservationId,
    sourceUpdatedAt,
    sourceWatermark: requireIsoInstant(input.sourceWatermark, "sourceWatermark"),
  };
}
