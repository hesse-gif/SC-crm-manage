// Pure, server-authorized read-model core for the Partner detail 5-tab surface
// (`/flu/partners/{enrollmentId}`) — .specs/spec_partner_profile_tabs/spec.md §3-6.
//
// This module is pure logic ONLY: activation-only membership, cursor/limit clamping, legacy route-alias
// classification (never exposes a raw token), and independent per-tab envelope composition. It never
// touches Firestore/Portal/network directly — callable handler factories in
// ./partnerProfileTabsCallables.ts inject data-access "ports" and compose these primitives. This mirrors
// the existing pure-core/store-separation pattern (see ./partnerActivationCore.ts,
// ./managementProfileTabsReadModels.ts).
//
// Cursor/limit bounding, envelope/stale-fallback loading, PII masking, and profile-image precedence are
// NOT re-implemented here — they are imported as-is from ./managementProfileTabsReadModels, which already
// owns those primitives for the sibling Management seven-tab surface (spec instruction: "reuse via
// import — do not duplicate"). Only domain-specific pieces that genuinely differ (Partner is scoped by a
// single `enrollmentId`, not `fluCreatorId`+`programId`; Partner membership is activation-only) are new.
//
// FAIL-CLOSED, NOT WIRED: exported factories in ./partnerProfileTabsCallables.ts are NOT registered in
// functions/index.ts. The integration leader wires routes/exports next wave (same pattern as L3's
// managementProfileTabsCallables.ts).
//
// Hard rule reaffirmed from functions/partnerActivationCore.ts: a creator appears on `/flu/partners`
// IF AND ONLY IF an `active` `PartnerActivation` document exists for the enrollment. Legacy
// Sheet3/submission/qualification/contract-derived membership (scpPartnerAdapter.ts's `buildScpPartners`
// union) must NEVER be read, unioned, or otherwise treated as Partner-membership evidence here.
//
// [확인 필요] Settlement rate/currency/rounding authority, payout timing, and reason-code taxonomy for
// blockers are NOT modeled here — those are undocumented business-policy decisions out of scope for this
// read-model lane (see spec §5, §9 "확인 필요" analog in managementProfileTabsReadModels.ts).
//
// ---------------------------------------------------------------------------------------------------
// REQUIRED_FIRESTORE_COMPOSITE_INDEXES (for the integration leader to add to firestore.indexes.json —
// this lane does NOT edit that file per its non-goals; spec §6.3). One signature per bounded query.
// ---------------------------------------------------------------------------------------------------
/*
[
  {
    "query": "partnerList",
    "collectionGroup": "partner_activations",
    "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "status", "order": "ASCENDING" },
      { "fieldPath": "activatedAtIso", "order": "DESCENDING" }
    ]
  },
  {
    "query": "journey",
    "collectionGroup": "scp_application_management+scp_onboarding_outbox+scp_video_review_state+scp_partner_activations",
    "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "enrollmentId", "order": "ASCENDING" },
      { "fieldPath": "occurredAtIso", "order": "DESCENDING" }
    ]
  },
  {
    "query": "videos",
    "collectionGroup": "scp_video_review_state",
    "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "enrollmentId", "order": "ASCENDING" },
      { "fieldPath": "submittedAtIso", "order": "DESCENDING" }
    ]
  },
  {
    "query": "audit",
    "collectionGroup": "partner_activation_events",
    "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "enrollmentId", "order": "ASCENDING" },
      { "fieldPath": "occurredAtIso", "order": "DESCENDING" }
    ]
  }
]
*/

import { createHash } from "crypto";
import {
  assertRoleAtLeast,
  buildCursorPage,
  loadAllTabEnvelopesIndependently,
  loadTabEnvelope,
  maskEmail,
  resolveCursorPageRequest,
  resolveProfileImageProjection,
  ManagementReadModelError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
  type CursorPage,
  type CursorPageRequest,
  type LoadTabEnvelopeOptions,
  type ManagementRole,
  type ProfileImageProjection,
  type ProfileImageSourceInputs,
  type ResolvedCursorPageRequest,
  type SourceReadEnvelope,
  type SourceReadState,
} from "./managementProfileTabsReadModels";

import type { PartnerActivationDocument, PartnerActivationStatus } from "./partnerActivationCore";

// Re-exported so callers of this module never need to import managementProfileTabsReadModels directly
// just to catch/inspect the shared error shape.
export {
  assertRoleAtLeast,
  buildCursorPage,
  loadAllTabEnvelopesIndependently,
  loadTabEnvelope,
  maskEmail,
  resolveCursorPageRequest,
  resolveProfileImageProjection,
  ManagementReadModelError as PartnerReadModelError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
};
export type {
  CursorPage,
  CursorPageRequest,
  LoadTabEnvelopeOptions,
  ManagementRole as PartnerRole,
  ProfileImageProjection,
  ProfileImageSourceInputs,
  ResolvedCursorPageRequest,
  SourceReadEnvelope,
  SourceReadState,
};

// ---- Tab keys (spec §2.1, §5) -----------------------------------------------------------------------

export type PartnerTabKey = "overview" | "journey" | "videos" | "performance" | "audit";

export const PARTNER_TAB_KEYS: readonly PartnerTabKey[] = ["overview", "journey", "videos", "performance", "audit"];

export const DEFAULT_PARTNER_TAB: PartnerTabKey = "overview";

// Unknown query-string tab values normalize to `overview` (spec §2.1: "알 수 없는 탭 값은 overview로
// 정규화하고 URL을 replace합니다") rather than throwing — this is a client-route concern, not an error.
export function normalizePartnerTabKey(value: string | null | undefined): PartnerTabKey {
  return (PARTNER_TAB_KEYS as readonly string[]).includes(value ?? "") ? (value as PartnerTabKey) : DEFAULT_PARTNER_TAB;
}

// Bounded-list queries that require a declared composite index (overview/performance are single-doc
// reads and declare no list index).
export type PartnerBoundedQuery = "partnerList" | "journey" | "videos" | "audit";

export const PARTNER_BOUNDED_QUERIES: readonly PartnerBoundedQuery[] = ["partnerList", "journey", "videos", "audit"];

export interface PartnerRequiredIndexSignature {
  readonly query: PartnerBoundedQuery;
  readonly collectionGroup: string;
  readonly fields: ReadonlyArray<{ readonly fieldPath: string; readonly order: "ASCENDING" | "DESCENDING" }>;
}

// Machine-checkable mirror of the JSON-comment block above (mirrors MANAGEMENT_TAB_REQUIRED_INDEXES).
export const PARTNER_REQUIRED_INDEXES: Readonly<Record<PartnerBoundedQuery, PartnerRequiredIndexSignature>> = {
  partnerList: {
    query: "partnerList",
    collectionGroup: "partner_activations",
    fields: [
      { fieldPath: "status", order: "ASCENDING" },
      { fieldPath: "activatedAtIso", order: "DESCENDING" },
    ],
  },
  journey: {
    query: "journey",
    collectionGroup: "scp_application_management+scp_onboarding_outbox+scp_video_review_state+scp_partner_activations",
    fields: [
      { fieldPath: "enrollmentId", order: "ASCENDING" },
      { fieldPath: "occurredAtIso", order: "DESCENDING" },
    ],
  },
  videos: {
    query: "videos",
    collectionGroup: "scp_video_review_state",
    fields: [
      { fieldPath: "enrollmentId", order: "ASCENDING" },
      { fieldPath: "submittedAtIso", order: "DESCENDING" },
    ],
  },
  audit: {
    query: "audit",
    collectionGroup: "partner_activation_events",
    fields: [
      { fieldPath: "enrollmentId", order: "ASCENDING" },
      { fieldPath: "occurredAtIso", order: "DESCENDING" },
    ],
  },
};

export function requiredIndexSignatureForPartnerQuery(query: PartnerBoundedQuery): PartnerRequiredIndexSignature {
  return PARTNER_REQUIRED_INDEXES[query];
}

// ---- Activation-only membership (spec §1 rule 2, §6.2, §10 non-goal, hard invariant) ------------------

// The ONLY predicate allowed to decide Partner list/detail membership. A creator/enrollment appears iff
// this returns true for its activation document — never inferred from submissions/qualification/
// onboarding/contract/Sheet3 rows, which this module never even accepts as input.
export function isActivePartnerActivation(activation: Pick<PartnerActivationDocument, "status">): boolean {
  return activation.status === ("active" satisfies PartnerActivationStatus);
}

// Fail-closed filter mirroring filterRecordsByScope's "never surface what shouldn't be visible" stance:
// silently drops non-active activations rather than trusting an upstream query to have already filtered
// by status (defense-in-depth against a store that leaked a revoked/pending doc).
export function filterActivePartnerActivations<T extends Pick<PartnerActivationDocument, "status">>(
  activations: readonly T[],
): T[] {
  return activations.filter(isActivePartnerActivation);
}

// ---- Partner list scope (spec §9 `getActivePartners({ programId?, campaignId?, cursor, limit })`) ----
// Unlike Management's ManagementTabScopeRequest (fluCreatorId+programId both REQUIRED), the Partner list
// scope is entirely optional — a manager may list every active Partner across all programs. Reusing
// buildUnderlyingQueryScope as-is would incorrectly reject that unscoped case, so this is a small,
// non-duplicated sibling shaped for Partner's actually-optional filters.

export interface PartnerListScopeRequest {
  readonly programId?: string;
  readonly campaignId?: string;
}

export interface PartnerListQueryScope {
  readonly programId?: string;
  readonly campaignId?: string;
}

export function buildPartnerListQueryScope(request: PartnerListScopeRequest | undefined | null): PartnerListQueryScope {
  const scope: { programId?: string; campaignId?: string } = {};
  if (request?.programId !== undefined) {
    if (typeof request.programId !== "string" || request.programId.length === 0) {
      throw new ManagementReadModelError("invalid-argument", "programId, if supplied, must be a non-empty string", false);
    }
    scope.programId = request.programId;
  }
  if (request?.campaignId !== undefined) {
    if (typeof request.campaignId !== "string" || request.campaignId.length === 0) {
      throw new ManagementReadModelError("invalid-argument", "campaignId, if supplied, must be a non-empty string", false);
    }
    scope.campaignId = request.campaignId;
  }
  return scope;
}

// Defense-in-depth: a store that ignored the programId/campaignId filter is rejected here rather than
// silently widening the caller's view.
export function matchesPartnerListScope(
  scope: PartnerListQueryScope,
  record: { readonly programId: string; readonly campaignId?: string | null },
): boolean {
  if (scope.programId !== undefined && record.programId !== scope.programId) return false;
  if (scope.campaignId !== undefined && (record.campaignId ?? null) !== scope.campaignId) return false;
  return true;
}

// ---- Partner detail scope (single enrollmentId; every tab read is re-checked against it) -------------

export interface PartnerScopeRequest {
  readonly enrollmentId: string;
}

export function assertValidEnrollmentId(enrollmentId: unknown): asserts enrollmentId is string {
  if (typeof enrollmentId !== "string" || enrollmentId.trim().length === 0) {
    throw new ManagementReadModelError("invalid-argument", "enrollmentId is required", false);
  }
}

// Defense-in-depth: even if a store leaked a row for a different enrollment (e.g. a cross-enrollment
// join bug), this rejects it before it reaches the tab response.
export function assertPartnerScopeMatch(request: PartnerScopeRequest, record: { readonly enrollmentId: string }): void {
  assertValidEnrollmentId(request.enrollmentId);
  if (record.enrollmentId !== request.enrollmentId) {
    throw new ManagementReadModelError("permission-denied", "record is outside the requested enrollment scope", false);
  }
}

export function filterPartnerRecordsByScope<T extends { readonly enrollmentId: string }>(
  request: PartnerScopeRequest,
  records: readonly T[],
): T[] {
  return records.filter((record) => {
    try {
      assertPartnerScopeMatch(request, record);
      return true;
    } catch {
      return false;
    }
  });
}

// ---- Legacy route-alias resolution (spec §2.1, §9 `resolvePartnerRouteAlias`) -------------------------
// `/flu/partners/submission-token:...`, `submission-*`, `lead-*` are legacy lookup aliases. The raw
// token/value is NEVER stored, logged, or returned — only a one-way hash ever leaves parsePartnerRouteId.

export type PartnerRouteAliasKind = "submission_token" | "submission" | "lead";

export interface ParsedPartnerRoute {
  readonly kind: "enrollment" | "alias";
  readonly enrollmentId: string | null;
  readonly aliasKind: PartnerRouteAliasKind | null;
  readonly aliasHash: string | null;
}

const ALIAS_PATTERNS: ReadonlyArray<{ readonly kind: PartnerRouteAliasKind; readonly test: RegExp }> = [
  { kind: "submission_token", test: /^submission-token:/i },
  { kind: "submission", test: /^submission-/i },
  { kind: "lead", test: /^lead-/i },
];

// One-way, deterministic, never reversible from the output alone — the raw alias never leaves this
// function, and this hash (not the raw value) is what any lookup port/audit record receives.
export function hashPartnerRouteAlias(rawRouteValue: string): string {
  return createHash("sha256").update(`partner_route_alias:${rawRouteValue}`).digest("hex").slice(0, 48);
}

function safeDecodeRouteSegment(rawRouteId: string): string {
  try {
    return decodeURIComponent(rawRouteId);
  } catch {
    // A malformed percent-encoding is treated as the literal raw string rather than thrown — this is a
    // route lookup, not a strict parser, and legacy aliases must still resolve.
    return rawRouteId;
  }
}

export function parsePartnerRouteId(rawRouteId: unknown): ParsedPartnerRoute {
  if (typeof rawRouteId !== "string" || rawRouteId.trim().length === 0) {
    throw new ManagementReadModelError("invalid-argument", "routeId is required", false);
  }
  const decoded = safeDecodeRouteSegment(rawRouteId);
  const match = ALIAS_PATTERNS.find((pattern) => pattern.test.test(decoded));
  if (match) {
    return { kind: "alias", enrollmentId: null, aliasKind: match.kind, aliasHash: hashPartnerRouteAlias(decoded) };
  }
  return { kind: "enrollment", enrollmentId: decoded, aliasKind: null, aliasHash: null };
}

export function canonicalPartnerRoute(enrollmentId: string): string {
  assertValidEnrollmentId(enrollmentId);
  return `/flu/partners/${encodeURIComponent(enrollmentId)}`;
}

// Injected lookup port: given the alias's hash (never the raw value) and its kind, resolves the
// canonical enrollmentId, or null if unresolvable. The actual Firestore/alias-table read lives in the
// callable/store layer; this module only ever composes over the injected function.
export type PartnerRouteAliasLookupPort = (aliasHash: string, aliasKind: PartnerRouteAliasKind) => Promise<string | null>;

export interface ResolvedPartnerRoute {
  readonly enrollmentId: string;
  readonly redirected: boolean;
  readonly canonicalRoute: string;
}

export async function resolvePartnerRoute(
  rawRouteId: unknown,
  lookup: PartnerRouteAliasLookupPort,
): Promise<ResolvedPartnerRoute> {
  const parsed = parsePartnerRouteId(rawRouteId);
  if (parsed.kind === "enrollment") {
    const enrollmentId = parsed.enrollmentId as string;
    return { enrollmentId, redirected: false, canonicalRoute: canonicalPartnerRoute(enrollmentId) };
  }
  const enrollmentId = await lookup(parsed.aliasHash as string, parsed.aliasKind as PartnerRouteAliasKind);
  if (!enrollmentId) {
    throw new ManagementReadModelError("failed-precondition", "alias could not be resolved to an enrollment", false);
  }
  return { enrollmentId, redirected: true, canonicalRoute: canonicalPartnerRoute(enrollmentId) };
}

// ---- Domain projection types (spec §5) -----------------------------------------------------------------

export interface PartnerActivationEvidenceView {
  readonly videoSubmissionId: string;
  readonly videoRevision: number;
  readonly reviewDecisionId: string;
  readonly reviewerKind: "human" | "ai_auto";
  readonly reviewedAtIso: string;
  readonly policyVersion: string;
}

export interface PartnerProfileImageProjection extends ProfileImageProjection {}

export interface PartnerProfileProjection {
  readonly enrollmentId: string;
  readonly fluCreatorId: string;
  readonly displayName: string;
  readonly handle: string | null;
  readonly canonicalChannelId: string | null;
  readonly youtubeChannelUrl: string | null;
  readonly emailMasked: string | null;
  readonly ownerId: string | null;
  readonly programId: string;
  readonly programName: string;
  readonly campaignId: string | null;
  readonly campaignName: string | null;
  readonly status: PartnerActivationStatus;
  readonly activatedAtIso: string | null;
  readonly activationEvidence: PartnerActivationEvidenceView | null;
  readonly profileImage: PartnerProfileImageProjection;
  readonly highestPriorityBlocker: PartnerBlocker | null;
}

export interface PartnerBlocker {
  readonly code: string;
  readonly severity: "info" | "warning" | "critical";
  readonly label: string;
  readonly actionTarget: string | null;
}

export interface PartnerAttributionSummary {
  readonly classification: "managed" | "unclassified";
  readonly programId: string;
  readonly campaignId: string | null;
  readonly outreachId: string | null;
  readonly applicationId: string;
  readonly enrollmentId: string;
  readonly assignmentRevision: number;
  readonly reasonCode: string;
}

export interface ApprovedVideoSummary {
  readonly videoSubmissionId: string;
  readonly videoRevision: number;
  readonly canonicalUrl: string;
  readonly youtubeVideoId: string;
  readonly approvedAtIso: string;
  readonly reviewerKind: "human" | "ai_auto";
  readonly policyVersion: string;
}

export interface PartnerOverviewProjection {
  readonly enrollmentId: string;
  readonly status: PartnerActivationStatus;
  readonly activatedAtIso: string | null;
  readonly activationEvidence: PartnerActivationEvidenceView | null;
  readonly approvedVideo: ApprovedVideoSummary | null;
  readonly attribution: PartnerAttributionSummary | null;
  readonly trackingEligible: boolean;
  readonly trackingBlockedReasonCode: string | null;
  readonly settlementEligible: boolean;
  readonly settlementBlockedReasonCode: string | null;
  readonly declaredAudienceCountry: string | null;
  readonly verifiedAudienceCountry: string | null;
  readonly highestPriorityBlocker: PartnerBlocker | null;
  readonly nextAction: { readonly label: string; readonly href: string | null } | null;
}

// Overview empty-state classification (spec §4.1 "빈 상태"): active status with missing evidence, or
// missing current approved video, is a data-integrity error — never silently rendered as a normal empty
// state.
export type PartnerOverviewIntegrityErrorCode = "activation_evidence_missing" | "current_revision_mismatch";

export function classifyPartnerOverviewIntegrity(
  overview: Pick<PartnerOverviewProjection, "status" | "activationEvidence" | "approvedVideo">,
): PartnerOverviewIntegrityErrorCode | null {
  if (overview.status !== "active") return null;
  if (!overview.activationEvidence) return "activation_evidence_missing";
  if (!overview.approvedVideo) return "current_revision_mismatch";
  return null;
}

// ---- Journey tab (spec §4.2) ---------------------------------------------------------------------------

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
  readonly eventId: string;
  readonly enrollmentId: string;
  readonly stage: PartnerJourneyStage;
  readonly occurredAtIso: string;
  readonly source: string;
  readonly sourceRef: string;
  readonly actor: "creator" | "operator" | "flu_automation" | "portal" | "ai";
  readonly confidence: "verified" | "inferred";
  readonly delayedReceipt: boolean;
}

export interface PartnerJourneyStageStatus {
  readonly stage: PartnerJourneyStage;
  readonly complete: boolean;
  readonly missingLabel: string | null;
  readonly critical: boolean;
}

export interface PartnerJourneyData {
  readonly stages: readonly PartnerJourneyStageStatus[];
  readonly events: readonly PartnerJourneyEvent[];
  readonly attribution: PartnerAttributionSummary | null;
}

// ---- Videos tab (spec §4.3, §5) ------------------------------------------------------------------------

export type VideoRevisionState = "current" | "superseded" | "removed";
export type PartnerVideoReviewStatus = "pending" | "needs_review" | "changes_requested" | "approved" | "rejected";

export interface PartnerVideoRevision {
  readonly revision: number;
  readonly state: VideoRevisionState;
  readonly canonicalUrl: string;
  readonly youtubeVideoId: string;
  readonly submittedAtIso: string;
  readonly reviewStatus: PartnerVideoReviewStatus;
  readonly decisionId: string | null;
  readonly decisionAtIso: string | null;
  readonly publicReasonCode: string | null;
  readonly analysisEvidenceRef: string | null;
}

export interface PartnerVideo {
  readonly videoSubmissionId: string;
  readonly applicationId: string;
  readonly enrollmentId: string;
  readonly title: string | null;
  readonly thumbnailUrl: string | null;
  readonly currentRevision: number;
  readonly revisions: readonly PartnerVideoRevision[];
  readonly trackingEligible: boolean;
  readonly settlementEligible: boolean;
  readonly downstreamProjectionConfirmed: boolean;
}

// Row key is videoSubmissionId; a revision is never surfaced as a standalone row (spec §4.3 normalization
// rule) — this asserts that invariant over an already-built list, failing closed on a violation instead
// of silently deduping.
export function assertNoDuplicateVideoSubmissionRows(videos: readonly PartnerVideo[]): void {
  const seen = new Set<string>();
  for (const video of videos) {
    if (seen.has(video.videoSubmissionId)) {
      throw new ManagementReadModelError(
        "failed-precondition",
        `duplicate row for videoSubmissionId "${video.videoSubmissionId}" — revisions must nest, not duplicate rows`,
        false,
      );
    }
    seen.add(video.videoSubmissionId);
  }
}

// ---- Performance & settlement tab (spec §4.4, §5) --------------------------------------------------------

export type PartnerPaymentStatus = "unavailable" | "not_payable" | "payable" | "scheduled" | "paid" | "failed";
export type PartnerAudienceAuthority = "declared" | "youtube_verified" | "unavailable";

export interface PartnerPerformanceSummary {
  readonly enrollmentId: string;
  readonly approvedVideoCount: number;
  // Decimal strings (never `number`) — avoids JS unsafe-integer/float loss for view counts and minor-unit
  // currency amounts (spec §5 comment; §4.4 "모든 금액은 minor unit 정수와 ISO currency로 저장합니다.
  // UI에서 부동소수점 계산하지 않습니다").
  readonly totalViews: string;
  readonly eligibleViews: string;
  readonly excludedViews: string;
  readonly estimatedAmountMinor: string | null;
  readonly paidAmountMinor: string | null;
  readonly currency: string | null;
  readonly paymentStatus: PartnerPaymentStatus;
  readonly declaredPrimaryAudienceCountry: string | null;
  readonly verifiedPrimaryAudienceCountry: string | null;
  readonly audienceAuthority: PartnerAudienceAuthority;
  readonly lastCollectedAtIso: string | null;
  readonly stale: boolean;
}

// `estimatedAmountMinor`/`paidAmountMinor` must never be defaulted to "0" merely because no payment
// ledger is connected yet (spec §5.1 결측 규칙) — this asserts a store never smuggled that in as data.
export function assertNoFabricatedZeroAmount(summary: Pick<PartnerPerformanceSummary, "paymentStatus" | "paidAmountMinor">): void {
  if (summary.paymentStatus === "unavailable" && summary.paidAmountMinor !== null) {
    throw new ManagementReadModelError(
      "failed-precondition",
      "paidAmountMinor must be null when paymentStatus is unavailable — never fabricate a paid amount",
      false,
    );
  }
}

// ---- Audit tab (spec §4.5, §5) ---------------------------------------------------------------------------

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
  readonly eventId: string;
  readonly enrollmentId: string;
  readonly fluCreatorId: string;
  readonly programId: string;
  readonly eventType: PartnerAuditEventType;
  readonly occurredAtIso: string;
  readonly recordedAtIso: string;
  readonly actor: { readonly kind: "human" | "ai" | "system"; readonly actorId: string | null };
  readonly result: "success" | "rejected" | "failed";
  readonly source: string;
  readonly sourceRefHash: string | null;
  readonly idempotencyKeyHash: string | null;
  readonly evidenceRefs: readonly string[];
  readonly reasonCode: string | null;
  readonly policyVersion: string | null;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
}

export interface PartnerAuditEventPage {
  readonly items: readonly PartnerAuditEvent[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

// Raw email/UID/OAuth-token/HMAC-secret/grant-token fields must never appear on an audit event (spec
// §4.5, §12.4). Fails closed rather than silently redacting, because a leaked raw value here indicates
// an upstream store bug this pure layer must surface loudly.
const FORBIDDEN_AUDIT_VALUE_PATTERN = /(?:@[^\s]+\.[a-z]{2,})|(?:AKIA|Bearer\s|hmac_[a-z0-9]{8,})/i;

export function assertAuditEventHasNoRawSecrets(event: PartnerAuditEvent): void {
  const haystack = JSON.stringify([event.source, event.reasonCode, event.evidenceRefs]);
  if (FORBIDDEN_AUDIT_VALUE_PATTERN.test(haystack)) {
    throw new ManagementReadModelError(
      "failed-precondition",
      "audit event appears to carry a raw email/token/secret value — must be hashed/redacted upstream",
      false,
    );
  }
}

// ---- Partner list row (spec §9 `getActivePartners`) --------------------------------------------------

export interface PartnerListRow {
  readonly enrollmentId: string;
  readonly fluCreatorId: string;
  readonly programId: string;
  // W91 additive: 해석된 프로그램 표시명. `view-cpm` 같은 전역 태그이거나 programs 문서에 이름이
  // 없으면 null이다 — 소비처는 원시 programId를 이름 자리에 대신 쓰지 않는다(오귀속 금지).
  readonly programName: string | null;
  readonly campaignId: string | null;
  readonly campaignName: string | null;
  readonly displayName: string;
  readonly handle: string | null;
  readonly profileImage: PartnerProfileImageProjection;
  readonly activatedAtIso: string;
  readonly activationEvidenceSummary: string;
}

export interface BuildPartnerListRowInput {
  readonly activation: PartnerActivationDocument;
  readonly displayName: string;
  readonly handle: string | null;
  readonly profileImageInputs: ProfileImageSourceInputs;
  readonly profileImageRevision: number;
  readonly profileImageVerifiedAt?: string;
  readonly campaignName?: string | null;
  readonly programName?: string | null;
}

// Fails closed if handed anything but an `active` activation — this is the one place a list ROW is
// constructed, so this is the enforcement point for "membership is activation-only" at the row-shape
// level (the boolean check in isActivePartnerActivation/filterActivePartnerActivations is the filtering
// enforcement point upstream of this).
export function buildPartnerListRow(input: BuildPartnerListRowInput): PartnerListRow {
  const { activation } = input;
  if (!isActivePartnerActivation(activation)) {
    throw new ManagementReadModelError(
      "failed-precondition",
      `refusing to build a Partner list row for a non-active activation (status="${activation.status}")`,
      false,
    );
  }
  if (!activation.activatedAtIso) {
    throw new ManagementReadModelError(
      "failed-precondition",
      "active activation is missing activatedAtIso — data integrity error, never fabricated",
      false,
    );
  }
  const profileImage = resolveProfileImageProjection(
    input.profileImageInputs,
    input.displayName,
    input.profileImageRevision,
    input.profileImageVerifiedAt,
  );
  return {
    enrollmentId: activation.identity.enrollmentId,
    fluCreatorId: activation.identity.fluCreatorId,
    programId: activation.identity.programId,
    programName: input.programName ?? null,
    campaignId: activation.identity.campaignId ?? null,
    campaignName: input.campaignName ?? null,
    displayName: input.displayName,
    handle: input.handle,
    profileImage,
    activatedAtIso: activation.activatedAtIso,
    activationEvidenceSummary: `rev.${activation.evidence.videoRevision} · ${activation.evidence.actorType}`,
  };
}

export function cursorOfPartnerListRow(row: PartnerListRow): string {
  return row.enrollmentId;
}

// ---- Independent per-tab envelope batch (spec §3.2, §9) -------------------------------------------------
// Thin, Partner-flavored wrapper over the generic loadAllTabEnvelopesIndependently: identical
// slow/failed-tab isolation semantics, scoped to PartnerTabKey instead of ManagementTabKey.

export type PartnerTabLoaders = Partial<Record<PartnerTabKey, () => Promise<unknown>>>;
export type PartnerTabEnvelopes = Partial<Record<PartnerTabKey, SourceReadEnvelope<unknown>>>;

export async function loadAllPartnerTabEnvelopesIndependently(
  loaders: PartnerTabLoaders,
  previous: PartnerTabEnvelopes = {},
  options: LoadTabEnvelopeOptions = {},
): Promise<PartnerTabEnvelopes> {
  // ManagementTabEnvelopes/ManagementTabLoaders are structurally `Partial<Record<string, ...>>`, so this
  // delegates directly rather than re-implementing Promise.allSettled isolation.
  return loadAllTabEnvelopesIndependently(loaders, previous, options) as Promise<PartnerTabEnvelopes>;
}
