// Client fetchers for the activation-only Partner detail surface (`/flu/partners/{enrollmentId}`,
// .specs/spec_partner_profile_tabs/spec.md §9). Follows the same callable-invocation shape as
// `callFluCallable` in `./data.ts` (httpsCallable + `getFluCallableName`), but is deliberately a NEW,
// standalone module — `./data.ts`'s `FluCallableName`/`FLU_CALLABLES` enum is NOT extended here per this
// lane's non-goals ("never edit data.ts itself").
//
// `getActivePartners`, `resolvePartnerRouteAlias`, and `getPartnerTabEnvelopes` are the CLIENT
// counterparts of the three factories the integration leader actually registered in
// `functions/index.ts` (see `./partnerProfileTabsCallables.ts`/`./partnerProfileTabsPorts.ts`). Every
// other Tier-A/tab data need (profile shell, overview/journey/videos/audit projections) is composed
// client-side from those three registered callables below — this module never calls a callable name
// `functions/index.ts` doesn't export.

import { canonicalCreatorId, creatorProfileSlug } from "./creator-identity.ts";
import { isOperationalFixtureRecord } from "../../functions/operationalFixtureProvenance.ts";

export type PartnerActivationStatus = "active" | "revoked";

export type ProfileImageSourceKind = "youtube_oauth" | "flu_channel" | "youtube_data_api" | "initials";

export interface PartnerProfileImage {
  url: string | null;
  fallbackInitials: string;
  source: ProfileImageSourceKind;
  verifiedAt?: string;
  imageRevision: number;
}

export interface PartnerListRow {
  enrollmentId: string;
  fluCreatorId: string;
  programId: string;
  // 서버가 해석한 프로그램 표시명. 전역 태그(view-cpm)나 이름 없는 프로그램은 null이고, 이때
  // 화면은 프로그램 세그먼트를 생략한다(원시 id를 이름 자리에 쓰지 않는다).
  programName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  displayName: string;
  handle: string | null;
  profileImage: PartnerProfileImage;
  activatedAtIso: string;
  activationEvidenceSummary: string;
}

export interface CursorPage<T> {
  rows: T[];
  pageInfo: { nextCursor: string | null; truncated: boolean };
}

export type PartnerTabKey = "overview" | "journey" | "videos" | "performance" | "audit";
export const PARTNER_TAB_KEYS: readonly PartnerTabKey[] = ["overview", "journey", "videos", "performance", "audit"];
export const DEFAULT_PARTNER_TAB: PartnerTabKey = "overview";

export function normalizePartnerTabKey(value: string | null | undefined): PartnerTabKey {
  return (PARTNER_TAB_KEYS as readonly string[]).includes(value ?? "") ? (value as PartnerTabKey) : DEFAULT_PARTNER_TAB;
}

export type SourceReadState = "idle" | "loading" | "ready" | "empty" | "stale" | "error";

export interface SourceReadEnvelope<T> {
  state: SourceReadState;
  data?: T;
  requestedAt?: string;
  updatedAt?: string;
  sourceRevision?: string;
  errorCode?: string;
  retryable?: boolean;
}

export interface PartnerBlocker {
  code: string;
  severity: "info" | "warning" | "critical";
  label: string;
  actionTarget: string | null;
}

export interface PartnerAttributionSummary {
  classification: "managed" | "unclassified";
  programId: string;
  campaignId: string | null;
  outreachId: string | null;
  applicationId: string;
  enrollmentId: string;
  assignmentRevision: number;
  reasonCode: string;
}

export interface PartnerActivationEvidenceView {
  videoSubmissionId: string;
  videoRevision: number;
  reviewDecisionId: string;
  reviewerKind: "human" | "ai_auto";
  reviewedAtIso: string;
  policyVersion: string;
}

export interface ApprovedVideoSummary {
  videoSubmissionId: string;
  videoRevision: number;
  canonicalUrl: string;
  youtubeVideoId: string;
  approvedAtIso: string;
  reviewerKind: "human" | "ai_auto";
  policyVersion: string;
}

export interface PartnerOverviewProjection {
  enrollmentId: string;
  status: PartnerActivationStatus;
  activatedAtIso: string | null;
  activationEvidence: PartnerActivationEvidenceView | null;
  approvedVideo: ApprovedVideoSummary | null;
  attribution: PartnerAttributionSummary | null;
  trackingEligible: boolean;
  trackingBlockedReasonCode: string | null;
  settlementEligible: boolean;
  settlementBlockedReasonCode: string | null;
  declaredAudienceCountry: string | null;
  verifiedAudienceCountry: string | null;
  highestPriorityBlocker: PartnerBlocker | null;
  nextAction: { label: string; href: string | null } | null;
}

export interface PartnerProfileProjection {
  enrollmentId: string;
  fluCreatorId: string;
  displayName: string;
  handle: string | null;
  canonicalChannelId: string | null;
  youtubeChannelUrl: string | null;
  emailMasked: string | null;
  ownerId: string | null;
  programId: string;
  programName: string;
  campaignId: string | null;
  campaignName: string | null;
  status: PartnerActivationStatus;
  activatedAtIso: string | null;
  activationEvidence: PartnerActivationEvidenceView | null;
  profileImage: PartnerProfileImage;
  highestPriorityBlocker: PartnerBlocker | null;
}

export type PartnerJourneyStage =
  | "program"
  | "campaign"
  | "outreach"
  | "apply"
  | "enrollment"
  | "onboarding"
  | "video_submitted"
  | "video_approved"
  | "partner_active";

export interface PartnerJourneyEvent {
  eventId: string;
  enrollmentId: string;
  stage: PartnerJourneyStage;
  occurredAtIso: string;
  source: string;
  sourceRef: string;
  actor: "creator" | "operator" | "flu_automation" | "portal" | "ai";
  confidence: "verified" | "inferred";
  delayedReceipt: boolean;
}

export interface PartnerJourneyStageStatus {
  stage: PartnerJourneyStage;
  complete: boolean;
  missingLabel: string | null;
  critical: boolean;
}

export interface PartnerJourneyData {
  stages: PartnerJourneyStageStatus[];
  events: PartnerJourneyEvent[];
  attribution: PartnerAttributionSummary | null;
}

export type VideoRevisionState = "current" | "superseded" | "removed";
export type PartnerVideoReviewStatus = "pending" | "needs_review" | "changes_requested" | "approved" | "rejected";

export interface PartnerVideoRevision {
  revision: number;
  state: VideoRevisionState;
  canonicalUrl: string;
  youtubeVideoId: string;
  submittedAtIso: string;
  reviewStatus: PartnerVideoReviewStatus;
  decisionId: string | null;
  decisionAtIso: string | null;
  publicReasonCode: string | null;
  analysisEvidenceRef: string | null;
}

export interface PartnerVideo {
  videoSubmissionId: string;
  applicationId: string;
  enrollmentId: string;
  title: string | null;
  thumbnailUrl: string | null;
  currentRevision: number;
  revisions: PartnerVideoRevision[];
  trackingEligible: boolean;
  settlementEligible: boolean;
  downstreamProjectionConfirmed: boolean;
}

export type PartnerPaymentStatus = "unavailable" | "not_payable" | "payable" | "scheduled" | "paid" | "failed";
export type PartnerAudienceAuthority = "declared" | "youtube_verified" | "unavailable";

export interface PartnerPerformanceSummary {
  enrollmentId: string;
  approvedVideoCount: number;
  totalViews: string;
  eligibleViews: string;
  excludedViews: string;
  estimatedAmountMinor: string | null;
  paidAmountMinor: string | null;
  currency: string | null;
  paymentStatus: PartnerPaymentStatus;
  declaredPrimaryAudienceCountry: string | null;
  verifiedPrimaryAudienceCountry: string | null;
  audienceAuthority: PartnerAudienceAuthority;
  lastCollectedAtIso: string | null;
  stale: boolean;
}

export type PartnerAuditEventType =
  | "application.received"
  | "application.materialized"
  | "application.assigned"
  | "onboarding.observed"
  | "video.revision.received"
  | "video.revision.superseded"
  | "analysis.completed"
  | "analysis.failed"
  | "review.decision.changed"
  | "partner.activated"
  | "partner.revoked"
  | "callback.queued"
  | "callback.delivered"
  | "callback.dead_letter"
  | "feed_report.projection.changed"
  | "tracking.snapshot.recorded"
  | "settlement.estimate.changed"
  | "settlement.payment.changed"
  | "profile_image.source.changed";

export interface PartnerAuditEvent {
  eventId: string;
  enrollmentId: string;
  fluCreatorId: string;
  programId: string;
  eventType: PartnerAuditEventType;
  occurredAtIso: string;
  recordedAtIso: string;
  actor: { kind: "human" | "ai" | "system"; actorId: string | null };
  result: "success" | "rejected" | "failed";
  source: string;
  sourceRefHash: string | null;
  idempotencyKeyHash: string | null;
  evidenceRefs: string[];
  reasonCode: string | null;
  policyVersion: string | null;
  beforeHash: string | null;
  afterHash: string | null;
}

export interface PartnerAuditEventPage {
  items: PartnerAuditEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ResolvedPartnerRoute {
  enrollmentId: string;
  redirected: boolean;
  canonicalRoute: string;
}

export type PartnerTabEnvelopes = Partial<Record<PartnerTabKey, SourceReadEnvelope<unknown>>>;

// ---- callable transport (mirrors callFluCallable in ./data.ts; a standalone helper so data.ts stays untouched) --

async function callPartnerCallable<TResponse>(name: string, payload: Record<string, unknown> = {}): Promise<TResponse> {
  if (typeof window === "undefined") {
    throw new Error(`Partner callable "${name}" must be invoked from a client interaction.`);
  }
  const [{ httpsCallable }, { functions, getFluCallableName }] = await Promise.all([
    import("firebase/functions"),
    import("./firebase"),
  ]);
  const callable = httpsCallable<Record<string, unknown>, TResponse>(functions, getFluCallableName(name));
  const result = await callable(payload);
  return result.data;
}

export const getActivePartners = (payload: { programId?: string; campaignId?: string; cursor?: string; limit?: number } = {}) =>
  callPartnerCallable<CursorPage<PartnerListRow>>("getActivePartners", payload);

export const resolvePartnerRouteAlias = (routeId: string) =>
  callPartnerCallable<ResolvedPartnerRoute>("resolvePartnerRouteAlias", { routeId });

// ---- 사람 단위 표시 그룹 (UI 전용) -------------------------------------------------------------
//
// 데이터 정본 축은 enrollment 그대로다 — getActivePartners 의 dedupe/커서/페이지 계약은 건드리지
// 않는다. 같은 크리에이터가 프로그램·캠페인별로 여러 enrollment 를 가지면 목록에 사람이 여러 번
// 흩어져 보이므로, 화면에서만 fluCreatorId 로 접어 대표 행 + "외 enrollment N건"으로 보여준다.
export interface PartnerPersonGroup {
  personKey: string;
  primary: PartnerListRow;
  others: PartnerListRow[];
}

export function groupPartnersByPerson(rows: readonly PartnerListRow[]): PartnerPersonGroup[] {
  const buckets = new Map<string, PartnerListRow[]>();
  for (const row of rows) {
    // fluCreatorId 가 비어 있는 행(데이터 결손)은 접지 않고 자기 자신으로 남긴다 — 서로 다른
    // 사람을 하나로 합치는 쪽이 훨씬 나쁘다.
    const personKey = row.fluCreatorId || `enrollment:${row.enrollmentId}`;
    const bucket = buckets.get(personKey);
    if (bucket) bucket.push(row);
    else buckets.set(personKey, [row]);
  }
  return [...buckets.entries()].map(([personKey, bucket]) => {
    // 대표 행은 최신 activatedAtIso. 서버가 이미 desc 로 주지만 표시 축을 여기서 못박는다.
    const ordered = [...bucket].sort((left, right) => (right.activatedAtIso ?? "").localeCompare(left.activatedAtIso ?? ""));
    return { personKey, primary: ordered[0], others: ordered.slice(1) };
  });
}

// ---- Tier-A/tab composition over REGISTERED callables only ------------------------------------------
//
// `getPartnerProfile`/`getPartnerOverview`/`getPartnerJourney`/`getPartnerVideos`/
// `getPartnerPerformance`/`getPartnerAuditEvents` used to call callable names functions/index.ts never
// registers. functions/partnerProfileTabsPorts.ts's `loadPartnerTab` shows what `getPartnerTabEnvelopes`
// (the callable the integration leader DID register) returns a raw activation plus additive creator identity
// in `overview`, a raw activation in `performance`, and canonical Journey/video/audit payloads in the other
// slices. Client projections come from that ONE registered batch call. Tier-A
// display identity is joined into the enrollment-scoped overview envelope, so detail rendering never
// depends on a bounded Partner-list page. Fields unavailable from registered surfaces degrade to
// `null`/an identity-derived value, never an invented one.

export interface RawPartnerActivationIdentity {
  enrollmentId: string;
  applicationId: string;
  programId: string;
  campaignId: string;
  outreachId?: string;
  portalCreatorId: string;
  fluCreatorId: string;
  integrationPartnerId: string;
  settlementCreatorCode?: string;
  channelId?: string;
}

export interface RawPartnerActivationEvidence {
  submissionId: string;
  videoRevision: number;
  reviewDecisionRef: string;
  reviewTransitionVersion: string;
  actorType: "human" | "ai";
  actorId: string;
  approvedAtIso: string;
}

export interface RawPartnerActivationRecord {
  activationId: string;
  status: PartnerActivationStatus;
  identity: RawPartnerActivationIdentity;
  evidence: RawPartnerActivationEvidence;
  activatedAtIso: string;
  revokedAtIso?: string;
}

export type PartnerOverviewTabRawData = {
  activation: RawPartnerActivationRecord | null;
  program?: { id: string; name: string } | null;
  campaign?: { id: string; name: string } | null;
  displayName?: string;
  handle?: string | null;
  profileImage?: PartnerProfileImage;
};
export type PartnerJourneyTabRawData = Partial<PartnerJourneyData> & {
  rows?: PartnerJourneyEvent[];
  emptyReasonCode?: string;
};
export type PartnerVideosTabRawData = { rows: PartnerVideo[]; emptyReasonCode?: string };
export type PartnerAuditTabRawData = { rows: PartnerAuditEvent[]; emptyReasonCode?: string };

function initialsFromLabel(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 2).toUpperCase() : "?";
}

function activationEvidenceView(evidence: RawPartnerActivationEvidence): PartnerActivationEvidenceView {
  return {
    videoSubmissionId: evidence.submissionId,
    videoRevision: evidence.videoRevision,
    reviewDecisionId: evidence.reviewDecisionRef,
    reviewerKind: evidence.actorType === "ai" ? "ai_auto" : "human",
    reviewedAtIso: evidence.approvedAtIso,
    // The activation record has no separate `policyVersion` field; `reviewTransitionVersion` is the
    // closest real value it carries, surfaced honestly under that label rather than inventing one.
    policyVersion: evidence.reviewTransitionVersion,
  };
}

function canonicalDisplayName(
  value: { name?: string | null } | null | undefined,
  fallback: string,
): string {
  const name = typeof value?.name === "string" ? value.name.trim() : "";
  return name.length > 0 ? name : fallback;
}

function classifiedScopeId(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && normalized !== "unclassified" ? normalized : null;
}

// Tier-A profile shell — renders the header independently of every tab. Creator identity comes from
// the enrollment-scoped overview envelope; list ordering, pagination, and getActivePartners availability
// cannot change the detail header.
export async function resolvePartnerProfile(
  enrollmentId: string,
): Promise<{ status: "not_active" } | { status: "ready"; profile: PartnerProfileProjection; sourceStates: PartnerTabEnvelopes }> {
  const { sourceStates } = await getPartnerTabEnvelopes(enrollmentId);
  const overviewData = sourceStates.overview?.data as PartnerOverviewTabRawData | undefined;
  const activation = overviewData?.activation ?? null;
  if (!activation || activation.status !== "active") {
    return { status: "not_active" };
  }
  const { identity, evidence } = activation;
  const programName = canonicalDisplayName(overviewData?.program, "프로그램명 미연결");
  const campaignId = classifiedScopeId(identity.campaignId);
  const campaignName = campaignId ? canonicalDisplayName(overviewData?.campaign, "캠페인명 미연결") : null;

  const envelopeDisplayName =
    typeof overviewData?.displayName === "string" ? overviewData.displayName.trim() : "";
  const displayName = envelopeDisplayName || identity.fluCreatorId;
  const handle =
    typeof overviewData?.handle === "string" && overviewData.handle.trim()
      ? overviewData.handle.trim()
      : null;
  const profileImage: PartnerProfileImage = overviewData?.profileImage ?? {
    url: null,
    fallbackInitials: initialsFromLabel(displayName),
    source: "initials",
    imageRevision: 0,
  };

  return {
    status: "ready",
    profile: {
      enrollmentId: identity.enrollmentId,
      fluCreatorId: identity.fluCreatorId,
      displayName,
      handle,
      canonicalChannelId: identity.channelId ?? null,
      youtubeChannelUrl: null,
      emailMasked: null,
      ownerId: null,
      programId: identity.programId,
      programName,
      campaignId,
      campaignName,
      status: activation.status,
      activatedAtIso: activation.activatedAtIso ?? null,
      activationEvidence: activationEvidenceView(evidence),
      profileImage,
      highestPriorityBlocker: null,
    },
    sourceStates,
  };
}

// Overview-tab projection combines the activation with its activation-attributed current video and
// Journey attribution. Missing enrichment keeps the existing reason code; no synthetic eligibility,
// video, or attribution values are created.
export function buildOverviewProjection(
  activation: RawPartnerActivationRecord,
  enrichment: {
    videos?: readonly PartnerVideo[];
    journey?: PartnerJourneyData | null;
  } = {},
): PartnerOverviewProjection {
  const attributedVideo = enrichment.videos?.find(
    (video) =>
      video.enrollmentId === activation.identity.enrollmentId &&
      video.videoSubmissionId === activation.evidence.submissionId,
  );
  const approvedRevision = attributedVideo?.revisions.find(
    (revision) =>
      revision.revision === attributedVideo.currentRevision &&
      revision.revision === activation.evidence.videoRevision &&
      revision.state === "current" &&
      revision.reviewStatus === "approved",
  );
  const approvedVideo: ApprovedVideoSummary | null =
    attributedVideo && approvedRevision
      ? {
          videoSubmissionId: attributedVideo.videoSubmissionId,
          videoRevision: approvedRevision.revision,
          canonicalUrl: approvedRevision.canonicalUrl,
          youtubeVideoId: approvedRevision.youtubeVideoId,
          approvedAtIso: approvedRevision.decisionAtIso ?? activation.evidence.approvedAtIso,
          reviewerKind: activation.evidence.actorType === "ai" ? "ai_auto" : "human",
          policyVersion: activation.evidence.reviewTransitionVersion,
        }
      : null;
  const eligibilityAvailable = attributedVideo !== undefined;

  return {
    enrollmentId: activation.identity.enrollmentId,
    status: activation.status,
    activatedAtIso: activation.activatedAtIso ?? null,
    activationEvidence: activationEvidenceView(activation.evidence),
    approvedVideo,
    attribution: enrichment.journey?.attribution ?? null,
    trackingEligible: attributedVideo?.trackingEligible ?? false,
    trackingBlockedReasonCode: eligibilityAvailable ? null : "overview_enrichment_unavailable",
    settlementEligible: attributedVideo?.settlementEligible ?? false,
    settlementBlockedReasonCode: eligibilityAvailable ? null : "overview_enrichment_unavailable",
    declaredAudienceCountry: null,
    verifiedAudienceCountry: null,
    highestPriorityBlocker: null,
    nextAction: null,
  };
}

// Batched, independent per-tab envelope fetch — mirrors functions/partnerProfileTabsCallables.ts's
// `createPartnerTabEnvelopesHandler`. One slow/failed tab's envelope never blocks the others.
export const getPartnerTabEnvelopes = (enrollmentId: string) =>
  callPartnerCallable<{ sourceStates: PartnerTabEnvelopes }>("getPartnerTabEnvelopes", { enrollmentId });

// ---- W26-F3: submitted-creator visibility band (additive, NOT the retired buildScpPartners union) --
//
// "영상을 제출하면 파트너다" (user-confirmed funnel rule). `scp_partner_activations` stays the sole
// "활성 파트너" ledger (exactly-once on approval, unchanged). This just surfaces creators who
// submitted a video, deduped by canonicalCreatorId, so they are not invisible until activation.
// Prod-measured: sheet3-origin submissions carry no enrollmentId (0/128) — link to the creator
// profile, never an enrollment route. Pure transform only; the caller supplies rows from the
// EXISTING `listSubmissions` dataset callable (`./data.ts`) — no new callable/collection here.

export interface SubmittedCreatorRow {
  key: string;
  displayName: string;
  profileHref: string | null;
  programId: string | null;
  submissionCount: number;
  latestSubmittedAtIso: string | null;
  // W92: band 3(포털 가입만) 과의 조인 키 — canonicalCreatorId 로 접기 전의 원본 신원을
  // 그대로 남긴다. maskedEmail 필드는 두지 않는다(적대적 리뷰: bob@gmail.com/bobby@gmail.com 이
  // 둘 다 bo***@gmail.com 으로 마스킹되는 손실 압축 값이라 신원 키로 못 쓴다 — 아래
  // partitionPortalCreators/submittedDisplayName 은 creatorId(=fluCreatorId) 정확 일치로만 조인한다).
  creatorId: string | null;
  // W7-1c-fix (2026-09-07): review-state-origin(scp_video_review_state) 그룹만 채운다 — 실제
  // 판정 상태를 아는 소스이기 때문이다. 레거시 submissions 행은 판정 축이 없어 undefined 로 남고,
  // 화면은 undefined 일 때 기존 "검수 중" 고정 배지로 폴백한다.
  badge?: "승인" | "검수 중" | "반려";
  stateMixLabel?: string | null;
  // band 3 배제(applicationId 정확 일치)용 — review-state 그룹에만 있다.
  applicationId?: string | null;
}

function isVisibleSubmissionRow(row: Record<string, unknown>): boolean {
  // W26-FIX-2: two distinct, both pre-existing fixture markers. mockHidden/archivedAt/deletedAt is a
  // prod-cleanup marker observed on `submissions` docs (e.g. mockHiddenCleanupId
  // "prod-mock-hesse-cleanup-..."). isOperationalFixtureRecord is the repo-wide legacy hardcoded seed
  // detector (c1/c4/c6/c10 etc. — predates that cleanup convention and never got the mockHidden flag
  // retrofitted). Reused as-is (see src/lib/dashboard-human-review.ts for the same import pattern) —
  // no new fixture rule invented here.
  if (row.mockHidden === true || row.archivedAt || row.deletedAt) return false;
  return !isOperationalFixtureRecord(row, "submissions");
}

function maskedEmailLabel(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return domain ? `${local.slice(0, 2) || "*"}***@${domain}` : email;
}

// W7-1c-fix (2026-09-07 프로드 실측 근인): sheet3-era `submissions` 문서의 submittedAtIso 는
// 한국어 로캘 문자열일 수 있다("2026. 7. 15 오후 10:39:09") — Date.parse 가 이를 파싱하지 못해
// (NaN) band 2 전체가 "최근 —"로만 렌더됐다. 문자열이 "있음"만으로는 부족하고, 실제로 ISO 로
// 파싱되는 값만 채택한다.
export function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

// W92 수리("최근 —" 근인): submittedAtIso 는 scpPortalSubmissionIngress.ts/sheet3SubmissionBridge.ts
// 두 writer 모두 신규 제출엔 문자열로 쓰지만, 그 필드 도입 이전에 만들어진 레거시 문서에는 없을 수
// 있다. `createdAtIso`가 다음 보루(제출 시점에 가장 가깝다), `updatedAtIso`는 functions/read.ts
// `collectionOrderForKey("submissions")`가 정렬 기준으로 쓰는 필드라 — Firestore orderBy는 그
// 필드가 없는 문서를 결과에서 아예 제외한다 — 응답에 실리는 모든 submissions 행에 항상 존재가
// 보장되는 마지막 보루다.
function firstIsoString(...values: unknown[]): string | null {
  for (const value of values) {
    if (isValidIsoTimestamp(value)) return value;
  }
  return null;
}

export function submittedCreatorRows(rows: readonly Record<string, unknown>[]): SubmittedCreatorRow[] {
  const byKey = new Map<string, SubmittedCreatorRow>();
  for (const row of rows) {
    if (!isVisibleSubmissionRow(row)) continue;
    const creatorId = typeof row.creatorId === "string" ? row.creatorId : "";
    const email = typeof row.email === "string" ? row.email : "";
    const youtubeUrl = typeof row.youtubeUrl === "string" ? row.youtubeUrl : "";
    const identity = { creatorId, email, youtubeUrl };
    const key = canonicalCreatorId(identity);
    if (!key) continue;
    const submittedAtIso = firstIsoString(row.submittedAtIso, row.createdAtIso, row.updatedAtIso);
    const existing = byKey.get(key);
    if (existing) {
      existing.submissionCount += 1;
      if (submittedAtIso && (!existing.latestSubmittedAtIso || submittedAtIso > existing.latestSubmittedAtIso)) {
        existing.latestSubmittedAtIso = submittedAtIso;
      }
      continue;
    }
    const slug = creatorProfileSlug(identity);
    byKey.set(key, {
      key,
      displayName: email ? maskedEmailLabel(email) : (creatorId || "제출자"),
      profileHref: slug ? `/flu/influencers/${encodeURIComponent(slug)}` : null,
      programId: typeof row.programId === "string" ? row.programId : null,
      submissionCount: 1,
      latestSubmittedAtIso: submittedAtIso,
      creatorId: creatorId || null,
    });
  }
  return Array.from(byKey.values())
    .sort((a, b) => (b.latestSubmittedAtIso ?? "").localeCompare(a.latestSubmittedAtIso ?? ""));
}

// ---- W7-1c-fix (2026-09-07): review-state-origin submitter band (scp_video_review_state) --------
//
// 프로드 실측(2026-09-07 read-only probe): 위 `submittedCreatorRows`가 읽는 legacy `submissions`
// 컬렉션(128건, 최신 2026-07-20)은 sheet3-era 정본이고, 현재 포털 제출의 정본은
// `scp_video_review_state`(234건)다. 그 컬렉션의 `subject.creatorId` 는 sheet-era 키
// (`CR_jonnyboesee-gmail-com`)라 band 1/포털의 fluCreatorId(`CR00061` 형)와 조인되지 않는다 —
// 대신 `applicationId`(subject.applicationId, 응답의 attributionContext.application.id 에 실린다)가
// 안정적인 사람 키다. `listScpCreatorDirectory` 는 그 applicationId 로 행이 키잉되어 있어 이름을
// 조인할 수 있다.
//
// state enum(2026-09-07 프로드 실측): "queued"(대기) | "approved"(승인) | "rejected"(반려).
// withdrawn/superseded 행은 철회/구버전이라 배제한다(오늘 기준 0건이지만 계약은 지킨다).

const REVIEW_STATE_LABEL: Record<string, "대기" | "승인" | "반려"> = {
  queued: "대기",
  approved: "승인",
  rejected: "반려",
};

/** `unclassified:*` 는 포털이 아직 못 붙인 센티널이다 — 사람 키로도 링크 대상으로도 쓰지 않는다. */
function realIdentityId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && !trimmed.startsWith("unclassified:") ? trimmed : null;
}

function attributionApplicationId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const application = (value as Record<string, unknown>).application;
  if (!application || typeof application !== "object") return null;
  const id = (application as Record<string, unknown>).id;
  return typeof id === "string" && id ? id : null;
}

// 적대적 리뷰 수리(round 2, MEDIUM): 한 크리에이터가 프로그램/캠페인별로 여러 applicationId 를
// 가질 수 있다(band 1 의 groupPartnersByPerson 이 이미 같은 이유로 enrollment 를 fluCreatorId 로
// 접는다). applicationId 로만 그룹핑하면 그 사람이 band 2 에 여러 번 뜨고 "검수 중 N명" 이
// 부풀려진다 — **실제 사람 키(fluCreatorId, unclassified 가 아닐 때)** 를 우선하고, 그게 없을
// 때만 applicationId 로 접는다(지어내지 않는다). 두 단계로 나눈다: (1) applicationId 단위로
// state/제출수/최신시각을 모으고, (2) 그 applicationId 들을 resolved fluCreatorId 로 다시 접는다.
export function reviewStateSubmitterRows(
  states: readonly {
    id: string;
    state: string;
    withdrawn: boolean;
    superseded: boolean;
    fluCreatorId: string;
    updatedAtIso: string;
    attributionContext?: Record<string, unknown>;
    reviewFacts?: { submittedAtIso: string | null } | null;
  }[],
  directoryRows: readonly {
    applicationId: string;
    creatorDisplayName: string | null;
    creatorHandle: string | null;
    identity: { fluCreatorId: string | null; portalCreatorId: string | null; channelId: string | null };
  }[],
): SubmittedCreatorRow[] {
  const directoryByApplicationId = new Map<string, (typeof directoryRows)[number]>();
  for (const row of directoryRows) {
    if (row.applicationId) directoryByApplicationId.set(row.applicationId, row);
  }

  // ---- pass 1: applicationId 단위 집계 (원장 행 raw 데이터만 안다) --------------------------
  type ApplicationGroup = {
    applicationId: string;
    submissionCount: number;
    latestSubmittedAtIso: string | null;
    counts: { 대기: number; 승인: number; 반려: number };
    // 디렉터리 조인이 그 applicationId 를 못 찾을 때의 폴백 — 원장 행 자신의 fluCreatorId(있고,
    // unclassified 가 아닐 때만).
    stateRowFluCreatorId: string | null;
  };
  const applicationGroups = new Map<string, ApplicationGroup>();

  for (const row of states) {
    if (row.withdrawn || row.superseded) continue;
    const applicationId = attributionApplicationId(row.attributionContext);
    if (!applicationId) continue; // 안정적인 사람 키가 없으면 묶을 수 없다 — 지어내지 않는다.
    const submittedAtIso = firstIsoString(row.reviewFacts?.submittedAtIso, row.updatedAtIso);
    const stateLabel = REVIEW_STATE_LABEL[row.state] ?? "대기";
    const rowFluCreatorId = realIdentityId(row.fluCreatorId);
    const existing = applicationGroups.get(applicationId);
    if (existing) {
      existing.submissionCount += 1;
      existing.counts[stateLabel] += 1;
      if (submittedAtIso && (!existing.latestSubmittedAtIso || submittedAtIso > existing.latestSubmittedAtIso)) {
        existing.latestSubmittedAtIso = submittedAtIso;
      }
      if (!existing.stateRowFluCreatorId && rowFluCreatorId) existing.stateRowFluCreatorId = rowFluCreatorId;
      continue;
    }
    const counts = { 대기: 0, 승인: 0, 반려: 0 };
    counts[stateLabel] = 1;
    applicationGroups.set(applicationId, {
      applicationId,
      submissionCount: 1,
      latestSubmittedAtIso: submittedAtIso,
      counts,
      stateRowFluCreatorId: rowFluCreatorId,
    });
  }

  // ---- pass 2: applicationId 그룹들을 resolved 사람 키로 다시 접는다 -------------------------
  type PersonGroup = {
    personKey: string;
    fluCreatorId: string | null;
    // 병합 전(=applicationCount 1) 일 때만 의미 있다 — band 3 의 applicationId 정확 일치 배제는
    // fluCreatorId 가 없을 때의 대체 축이므로, 병합되어 fluCreatorId 가 있는 순간부터는
    // fluCreatorId 축이 이미 배제를 커버한다.
    soleApplicationId: string | null;
    firstApplicationId: string;
    displayNameCandidate: string | null;
    submissionCount: number;
    latestSubmittedAtIso: string | null;
    counts: { 대기: number; 승인: number; 반려: number };
  };
  const personGroups = new Map<string, PersonGroup>();

  for (const app of applicationGroups.values()) {
    const directory = directoryByApplicationId.get(app.applicationId) ?? null;
    const directoryFluCreatorId = realIdentityId(directory?.identity.fluCreatorId ?? null);
    const fluCreatorId = directoryFluCreatorId ?? app.stateRowFluCreatorId;
    const personKey = fluCreatorId ?? `app:${app.applicationId}`;
    const nameCandidate = directory?.creatorDisplayName?.trim() || directory?.creatorHandle?.trim() || null;

    const existing = personGroups.get(personKey);
    if (existing) {
      existing.submissionCount += app.submissionCount;
      existing.counts.대기 += app.counts.대기;
      existing.counts.승인 += app.counts.승인;
      existing.counts.반려 += app.counts.반려;
      existing.soleApplicationId = null; // 두 번째 applicationId 가 합류 — 더 이상 단일이 아니다.
      if (!existing.displayNameCandidate && nameCandidate) existing.displayNameCandidate = nameCandidate;
      if (app.latestSubmittedAtIso && (!existing.latestSubmittedAtIso || app.latestSubmittedAtIso > existing.latestSubmittedAtIso)) {
        existing.latestSubmittedAtIso = app.latestSubmittedAtIso;
      }
      continue;
    }
    personGroups.set(personKey, {
      personKey,
      fluCreatorId,
      soleApplicationId: app.applicationId,
      firstApplicationId: app.applicationId,
      displayNameCandidate: nameCandidate,
      submissionCount: app.submissionCount,
      latestSubmittedAtIso: app.latestSubmittedAtIso,
      counts: { ...app.counts },
    });
  }

  return Array.from(personGroups.values())
    .map((person) => {
      const displayName =
        person.displayNameCandidate ||
        person.fluCreatorId ||
        `지원서 ${person.firstApplicationId.slice(0, 8)}`;
      const badge: "승인" | "검수 중" | "반려" =
        person.counts.승인 > 0 ? "승인" : person.counts.반려 === person.submissionCount ? "반려" : "검수 중";
      return {
        key: `review:${person.personKey}`,
        displayName,
        profileHref: person.fluCreatorId ? `/flu/influencers/${encodeURIComponent(person.fluCreatorId)}` : null,
        programId: null,
        submissionCount: person.submissionCount,
        latestSubmittedAtIso: person.latestSubmittedAtIso,
        creatorId: person.fluCreatorId,
        badge,
        stateMixLabel: `승인 ${person.counts.승인} · 대기 ${person.counts.대기} · 반려 ${person.counts.반려}`,
        applicationId: person.soleApplicationId,
      };
    })
    .sort((a, b) => (b.latestSubmittedAtIso ?? "").localeCompare(a.latestSubmittedAtIso ?? ""));
}

/**
 * band 2 의 두 소스(review-state 그룹 + 레거시 submissions)를 합친다. **정확히 일치하는
 * fluCreatorId 로만** 중복을 뺀다 — review-state 쪽이 실제 판정 상태를 아는 현재 정본이라 겹치면
 * 그쪽을 남기고 레거시 행을 버린다. id 가 없는(조인 근거가 없는) 행은 절대 서로 지우지 않는다
 * (partitionPortalCreators 와 같은 원칙 — 사람을 지우는 쪽보다 중복 표시가 낫다).
 */
export function mergeSubmissionBandRows(
  reviewStateRows: readonly SubmittedCreatorRow[],
  legacyRows: readonly SubmittedCreatorRow[],
): SubmittedCreatorRow[] {
  const reviewStateIds = new Set(
    reviewStateRows.map((row) => row.creatorId).filter((value): value is string => Boolean(value)),
  );
  const merged = [
    ...reviewStateRows,
    ...legacyRows.filter((row) => !(row.creatorId && reviewStateIds.has(row.creatorId))),
  ];
  return merged.sort((a, b) => (b.latestSubmittedAtIso ?? "").localeCompare(a.latestSubmittedAtIso ?? ""));
}

// ---- W92: 포털 가입 크리에이터 밴드(band 3, additive) ------------------------------------------
//
// listScpPortalCreators(브리지 configured:true) 또는 configured:false 폴백인 listScpCreatorDirectory
// 로 이미 얻은 원시 행을 표시용 최소 셰입으로 정규화한 뒤, band 1(활성)·band 2(제출·검수 중)에
// 이미 나온 사람을 뺀 "가입만" 인구를 반환한다 — 세 밴드가 포털 가입 인구를 분할(partition)한다.
// 두 소스는 신원 필드가 달라(브리지는 항상 안정적인 id, 폴백은 그게 없어 identity 폴백 체인을
// 쓴다) 매핑 함수를 둘로 나눈다.
export interface PortalCreatorRow {
  personKey: string;
  fluCreatorId: string | null;
  emailMasked: string | null;
  title: string;
  badge: string;
  createdAtIso: string | null;
  country: string | null;
  href: string | null;
  // W7-1c-fix: review-state(band 2) 그룹의 applicationId 와 정확 일치로 band 3 을 배제하기
  // 위한 추가 축 — fluCreatorId 조인이 실패해도(디렉터리 100건 상한 등) 이 축으로 잡힌다.
  applicationId: string | null;
}

const PORTAL_APPLICATION_STATUS_LABEL: Record<string, string> = {
  pending: "승인 대기",
  approved: "승인",
  rejected: "반려",
};

/** 브리지 실계정 행(ScpPortalCreatorRow) → 표시용 셰입. id 는 브리지가 보장하는 안정 식별자다. */
export function portalCreatorRowFromBridgeRow(row: {
  id: string;
  name?: string;
  emailMasked: string;
  createdAt: string;
  profile?: { displayName?: string; country?: string };
  approvalApplication?: { id?: string; status?: string };
  dataLink?: { fluCreatorId?: string };
}): PortalCreatorRow {
  const fluCreatorId = row.dataLink?.fluCreatorId || null;
  const status = row.approvalApplication?.status;
  return {
    personKey: row.id,
    fluCreatorId,
    emailMasked: row.emailMasked || null,
    title: row.name || row.profile?.displayName || row.emailMasked,
    badge: status ? (PORTAL_APPLICATION_STATUS_LABEL[status] ?? "가입") : "가입",
    createdAtIso: row.createdAt || null,
    country: row.profile?.country || null,
    href: fluCreatorId ? `/flu/influencers/${encodeURIComponent(fluCreatorId)}` : null,
    applicationId: row.approvalApplication?.id || null,
  };
}

/** 브리지 미구성 폴백 행(ScpCreatorDirectoryRow) → 표시용 셰입. 안정 id 가 없어 신원 폴백 체인을 쓴다. */
export function portalCreatorRowFromDirectoryRow(row: {
  applicationId: string;
  submittedAtIso: string | null;
  creatorDisplayName: string | null;
  creatorHandle: string | null;
  identity: { fluCreatorId: string | null; portalCreatorId: string | null; channelId: string | null };
}): PortalCreatorRow {
  const fluCreatorId = row.identity.fluCreatorId || null;
  const personKey = fluCreatorId || row.identity.portalCreatorId || row.identity.channelId || row.applicationId;
  return {
    personKey,
    fluCreatorId,
    emailMasked: null,
    title: row.creatorDisplayName || row.creatorHandle || personKey,
    badge: "가입",
    createdAtIso: row.submittedAtIso,
    country: null,
    href: fluCreatorId ? `/flu/influencers/${encodeURIComponent(fluCreatorId)}` : null,
    applicationId: row.applicationId || null,
  };
}

/**
 * band 1(활성)의 fluCreatorId, band 2(제출·검수 중)의 creatorId 와 **정확히** 겹치는 후보만
 * 뺀다. 같은 사람이 두 소스에 걸쳐 중복 후보로 들어오는 경우(폴백의 지원서별 행 등)도
 * personKey 로 한 번만 남긴다.
 *
 * 적대적 리뷰 수리: emailMasked 는 절대 배제 키로 쓰지 않는다 — bob@gmail.com 과
 * bobby@gmail.com 이 둘 다 bo***@gmail.com 으로 마스킹되는 손실 압축 값이라, 이걸로 배제하면
 * 서로 다른 두 사람 중 한 명을 세 밴드 어디에도 없는 것처럼(오배제) 지워버릴 수 있다. 매칭
 * 근거가 없는 제출자(포털 fluCreatorId 매핑이 없는 sheet3 행 등)는 band 2(마스킹 표시)와
 * band 3(실명 표시)에 둘 다 나타날 수 있다 — 사람을 지우는 쪽보다 훨씬 낫다.
 *
 * W7-1c-fix: `reviewStateApplicationIds`(4번째 인자, 옵션)는 band 2 의 review-state 그룹
 * applicationId 집합이다 — fluCreatorId 조인이 실패한 제출자(디렉터리 100건 상한 등)도
 * `approvalApplication.id` 정확 일치로 배제할 수 있는 두 번째 축이다.
 */
export function partitionPortalCreators(
  candidates: readonly PortalCreatorRow[],
  activeRows: readonly PartnerListRow[],
  submittedRows: readonly SubmittedCreatorRow[],
  reviewStateApplicationIds: readonly string[] = [],
): PortalCreatorRow[] {
  const activeIds = new Set(activeRows.map((row) => row.fluCreatorId).filter(Boolean));
  const submittedIds = new Set(submittedRows.map((row) => row.creatorId).filter((value): value is string => Boolean(value)));
  const reviewAppIds = new Set(reviewStateApplicationIds.filter(Boolean));
  const seen = new Set<string>();
  const result: PortalCreatorRow[] = [];
  for (const candidate of candidates) {
    if (!candidate.personKey || seen.has(candidate.personKey)) continue;
    if (candidate.fluCreatorId && (activeIds.has(candidate.fluCreatorId) || submittedIds.has(candidate.fluCreatorId))) continue;
    if (candidate.applicationId && reviewAppIds.has(candidate.applicationId)) continue;
    seen.add(candidate.personKey);
    result.push(candidate);
  }
  return result;
}
