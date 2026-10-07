// Client fetchers for the creator Management detail seven-tab surface (`/flu/influencers/{fluCreatorId}`,
// .specs/spec_creator_management_profile_tabs/spec.md §3-6). Follows the same callable-invocation shape
// as `callFluCallable` in `./data.ts` (httpsCallable + `getFluCallableName`) and mirrors the standalone
// module pattern already used by `./partnerData.ts` — a NEW, standalone module; `./data.ts`'s
// `FluCallableName`/`FLU_CALLABLES` enum is NOT extended here per this lane's non-goals ("never edit
// data.ts itself").
//
// Server-side counterparts: `functions/managementProfileTabsReadModels.ts` (pure core — tab keys,
// envelope, scope, and shared projection types mirrored below) and
// `functions/managementProfileTabsCallables.ts` (handler factories: a generic bounded scoped-list
// factory used once per tab, plus one batched all-tab-envelopes factory). Per this wave's wiring
// contract those become the exported callables `manageProfileTabEnvelopes` and
// `manageProfileTab<Tab>List` (e.g. `manageProfileTabJourneyList`). Until the integration leader
// registers them in `functions/index.ts`, calls through this module reject with a callable-not-found
// error — expected for this wave; the page/components render that as an ordinary per-tab `error`
// envelope, never a blank crash (identical posture to `partnerData.ts`).
//
// [확인 필요] Outreach/Onboarding/Channel-intelligence/Audit row shapes are NOT fixed by any exported
// server type yet (only Journey/Applications/Content-review have named projection interfaces in
// managementProfileTabsReadModels.ts). This module models those four as intentionally loose, optional-
// field rows so the UI degrades gracefully to whatever concrete shape the wiring lane lands, rather than
// inventing an undocumented contract.


// ---- Tab keys (mirrors functions/managementProfileTabsReadModels.ts MANAGEMENT_TAB_KEYS exactly —
// order and values must match) ----------------------------------------------------------------------

export type ManagementTabKey =
  | "journey"
  | "outreach"
  | "applications"
  | "onboarding"
  | "content-review"
  | "channel-intelligence"
  | "audit";

export const MANAGEMENT_TAB_KEYS: readonly ManagementTabKey[] = [
  "journey",
  "outreach",
  "applications",
  "onboarding",
  "content-review",
  "channel-intelligence",
  "audit",
];

export const DEFAULT_MANAGEMENT_TAB: ManagementTabKey = "journey";

export function normalizeManagementTabKey(value: string | null | undefined): ManagementTabKey {
  return (MANAGEMENT_TAB_KEYS as readonly string[]).includes(value ?? "")
    ? (value as ManagementTabKey)
    : DEFAULT_MANAGEMENT_TAB;
}

// ---- Envelope primitives (mirrors managementProfileTabsReadModels.ts) -------------------------------

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

export type ManagementTabEnvelopes = Partial<Record<ManagementTabKey, SourceReadEnvelope<unknown>>>;

export interface CursorPage<T> {
  rows: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

// ---- Scope (mirrors CreatorManagementScope / ManagementTabScopeRequest) -----------------------------

export type AttributionState = "managed" | "unclassified" | "ambiguous" | "conflict";
export type PartnerActivationState = "pending" | "active" | "revoked";

export interface ManagementScopeRequest {
  fluCreatorId: string;
  programId: string;
  campaignId?: string;
  enrollmentId?: string;
  // Flu conversation org-filter round 16 (codex adversarial review round 16, finding #3):
  // super_admin-only "대신 보기" (viewAs) — must be provided together, same contract as every other
  // viewAs-aware request in src/lib/data.ts. The server (functions/managementProfileTabsCallables.ts
  // resolveEffectiveAuthContext) re-verifies this pair against the members collection; these are
  // never trusted directly for scoping.
  viewAsUserId?: string;
  viewAsEmail?: string;
}

export interface ScopedTabListRequest extends ManagementScopeRequest {
  cursor?: string | null;
  limit?: number;
}

// ---- Shared projection/domain types (mirrors managementProfileTabsReadModels.ts §6) -----------------

export type JourneyStage =
  | "discovered"
  | "coldmail_sent"
  // 크리에이터 답장 수신. 아웃리치 다음, 지원/자격검증 앞이 실제 여정 순서다.
  | "replied"
  | "applied"
  | "qualified"
  | "onboarding_sent"
  | "uid_submitted"
  | "gem_sent"
  | "content_submitted"
  | "video_reviewed"
  | "partner_active";

export interface JourneyEvent {
  eventId: string;
  enrollmentId?: string;
  programId?: string;
  campaignId?: string;
  stage: JourneyStage;
  occurredAt: string;
  source: string;
  sourceRef: string;
  actor: "creator" | "operator" | "flu_automation" | "portal" | "ai";
  confidence: "verified" | "inferred";
  payloadSummary: Record<string, string | number | boolean | null>;
}

export interface ApplicationManagementProjection {
  applicationId: string;
  portalCreatorId?: string;
  fluCreatorId: string;
  enrollmentId?: string;
  programId?: string;
  campaignId?: string;
  outreachId?: string;
  settlementCreatorCode?: string;
  channelId?: string;
  submittedAt: string;
  declaredPrimaryAudienceCountry?: string;
  attributionState: AttributionState;
  latestRevision: number;
  revokedAt?: string;
}

export type VideoReviewState =
  | "queued"
  | "in_review"
  | "changes_requested"
  | "human_review_required"
  | "rejected"
  | "approved";

export interface VideoRevisionProjection {
  submissionId: string;
  revisionId: string;
  revision: number;
  canonicalVideoId: string;
  canonicalUrl: string;
  fingerprint: string;
  submittedAt: string;
  isCurrentRevision: boolean;
  reviewState: VideoReviewState;
  reasonCode?: string;
  policyVersion?: string;
  reviewedAt?: string;
  analyzerStatus: "pending" | "complete" | "failed";
}

export interface ActivationEvidence {
  activationId: string;
  enrollmentId: string;
  fluCreatorId: string;
  programId: string;
  submissionId: string;
  revisionId: string;
  decisionRef: string;
  activatedAt: string;
  state: PartnerActivationState;
}

// ---- Loosely-typed rows for tabs without a fixed server projection yet (see module header note) -----

export interface OutreachActivityRow {
  id: string;
  enrollmentId?: string;
  programId?: string;
  campaignId?: string;
  campaignName?: string;
  sentAt?: string;
  subject?: string;
  deliveryState?: string;
  openCount?: number;
  replied?: boolean;
  conversationHref?: string;
}

export interface OnboardingStepRow {
  id: string;
  enrollmentId?: string;
  stepLabel: string;
  status?: "unsent" | "queued" | "sent" | "delivered" | "bounced" | "failed" | "submitted" | "verified";
  requestedAt?: string;
  completedAt?: string;
  receiptRef?: string;
  retryState?: string;
}

export interface ChannelActivityRow {
  id: string;
  kind: "video" | "comment" | "summary";
  title?: string;
  text?: string;
  occurredAt?: string;
  viewCount?: number;
  href?: string;
}

export interface AuditEventRow {
  id: string;
  occurredAt?: string;
  eventType?: string;
  actor?: string;
  scope?: string;
  result?: string;
  sourceRef?: string;
}

// ---- Callable transport (mirrors callPartnerCallable in ./partnerData.ts; standalone helper so
// data.ts/partnerData.ts both stay untouched) ---------------------------------------------------------

async function callManagementCallable<TResponse>(name: string, payload: Record<string, unknown>): Promise<TResponse> {
  if (typeof window === "undefined") {
    throw new Error(`Management callable "${name}" must be invoked from a client interaction.`);
  }
  const [{ httpsCallable }, { functions, getFluCallableName }] = await Promise.all([
    import("firebase/functions"),
    import("./firebase"),
  ]);
  const callable = httpsCallable<Record<string, unknown>, TResponse>(functions, getFluCallableName(name));
  const result = await callable(payload);
  return result.data;
}

// Batched, independent per-tab envelope fetch — mirrors
// functions/managementProfileTabsCallables.ts's `createManagementTabEnvelopesHandler`. Kept for contract
// completeness (the leader's `manageProfileTabEnvelopes` export); the Management shell/page does NOT
// call this on mount for all 7 tabs — spec §1 non-goal #6 forbids pre-fetching every tab on entry. Only
// individual `getManagementTabList` calls, issued lazily per visited tab, drive the default UI.
export const getManagementTabEnvelopes = (scope: ManagementScopeRequest) =>
  callManagementCallable<{ sourceStates: ManagementTabEnvelopes }>("manageProfileTabEnvelopes", { ...scope });

// GAP-C (FLU-0538 completion): narrow per-creator managed signal that promotes the management detail
// seven-tab clone to the DEFAULT view for managed creators (no ?view=management). manager+, read-only.
export const getCreatorManagementClassification = (fluCreatorId: string) =>
  callManagementCallable<{ ok: boolean; managed: boolean; recordCount: number; scopes: Array<{ programId: string; campaignId?: string; enrollmentId?: string }> }>(
    "getCreatorManagementClassification",
    { fluCreatorId },
  );

const TAB_CALLABLE_SUFFIX: Record<ManagementTabKey, string> = {
  journey: "Journey",
  outreach: "Outreach",
  applications: "Applications",
  onboarding: "Onboarding",
  "content-review": "ContentReview",
  "channel-intelligence": "ChannelIntelligence",
  audit: "Audit",
};

function managementTabListCallableName(tab: ManagementTabKey): string {
  return `manageProfileTab${TAB_CALLABLE_SUFFIX[tab]}List`;
}

// Generic bounded/scoped list fetch for one tab. `TRow` is supplied by the caller per tab (see the
// typed convenience wrappers below) — this function itself stays untyped-by-tab since the server's
// `createScopedTabListHandler<TRow>` factory is generic over the row shape, too.
export function getManagementTabList<TRow>(tab: ManagementTabKey, request: ScopedTabListRequest): Promise<CursorPage<TRow>> {
  return callManagementCallable<CursorPage<TRow>>(managementTabListCallableName(tab), { ...request });
}

export const getManagementJourneyList = (request: ScopedTabListRequest) =>
  getManagementTabList<JourneyEvent>("journey", request);

export const getManagementOutreachList = (request: ScopedTabListRequest) =>
  getManagementTabList<OutreachActivityRow>("outreach", request);

export const getManagementApplicationsList = (request: ScopedTabListRequest) =>
  getManagementTabList<ApplicationManagementProjection>("applications", request);

export const getManagementOnboardingList = (request: ScopedTabListRequest) =>
  getManagementTabList<OnboardingStepRow>("onboarding", request);

export const getManagementContentReviewList = (request: ScopedTabListRequest) =>
  getManagementTabList<VideoRevisionProjection>("content-review", request);

export const getManagementChannelIntelligenceList = (request: ScopedTabListRequest) =>
  getManagementTabList<ChannelActivityRow>("channel-intelligence", request);

export const getManagementAuditList = (request: ScopedTabListRequest) =>
  getManagementTabList<AuditEventRow>("audit", request);
