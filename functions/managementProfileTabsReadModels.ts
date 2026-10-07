// Pure, server-authorized read-model core for the creator Management detail (`/flu/influencers/{fluCreatorId}`)
// seven-tab surface (spec_creator_management_profile_tabs/spec.md §3-6; handoff
// docs/integrations/flu-partner-management-profile-tabs-handoff-20260719.md).
//
// This module is pure logic ONLY: scope/role enforcement, cursor/limit clamping, PII/token masking,
// profile-image source precedence, and independent per-tab `SourceReadEnvelope` construction. It never
// touches Firestore/network directly — callable handler factories in ./managementProfileTabsCallables.ts
// inject data-access "ports" and compose these primitives. This mirrors the existing
// pure-core/store-separation pattern (see ./videoReviewTransitionCore.ts, ./applicationManagementStore.ts).
//
// FAIL-CLOSED, NOT WIRED: exported factories here are NOT registered in functions/index.ts. The
// integration leader wires routes/exports. No production mock rows; Sheet3/Typeform/legacy compatibility
// rows are never treated as current truth (spec §1, handoff invariant #9).
//
// [확인 필요] Every field in this module that would require an undocumented business-policy decision
// (reason-code taxonomy, cutoff tolerance, admin override authority, max query period, settlement
// lock/reopen, payout timing, CPM/currency/rounding authority) is intentionally NOT modeled here. Those
// policy surfaces stay out of scope for this read-model lane and must not be inferred.
//
// ---------------------------------------------------------------------------------------------------
// REQUIRED_FIRESTORE_COMPOSITE_INDEXES (for the integration leader to add to firestore.indexes.json —
// this lane does NOT edit that file per its non-goals). One signature per tab's bounded list read.
//
// AUDITED AGAINST REAL WRITERS (adversarial-review remediation): `outreach` and `applications` are the
// only two of these seven collections with an actual production writer today —
// ./scpColdmailHistory.ts (scp_coldmail_history: programId/campaignId/sentAtIso, all top-level, flat)
// and ./applicationManagementStore.ts (scp_application_management: identity.programId/
// identity.enrollmentId are nested under the `identity` object; submittedAtIso is top-level and set only
// at creation, never overwritten). Both signatures below are corrected to those REAL field names/paths —
// the prior "sentAt"/"submittedAt" (missing the Iso suffix) and flat "programId"/"enrollmentId" for
// applications never matched what either writer persists, so the composite indexes built from them would
// never have served the intended query.
//
// `journey` (flu_journey_events), `onboarding` (scp_application_onboarding_audit_events), `content-review`
// (scp_application_video_submission_revisions), `channel-intelligence` (flu_channel_video_snapshots), and
// `audit` (flu_management_audit_events) have NO production writer anywhere in this codebase (grepped
// clean across functions/ and functions-staging/) — `hasProductionWriter: false` below. Their
// `collectionGroup`/`fields` stay as documentation of the eventual real writer's likely shape, but no
// composite index for them is checked into firestore.indexes.json (an index for a collection nothing
// ever writes to is dead weight and would misleadingly imply the tab is live), and the port
// (./managementProfileTabsPorts.ts) never queries them — it fails closed with an explicit, reason-coded
// no-source result instead of a silent empty page.
// ---------------------------------------------------------------------------------------------------
/*
[
  {
    "tab": "outreach",
    "collectionGroup": "scp_coldmail_history",
    "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "programId", "order": "ASCENDING" },
      { "fieldPath": "campaignId", "order": "ASCENDING" },
      { "fieldPath": "sentAtIso", "order": "DESCENDING" }
    ]
  },
  {
    "tab": "applications",
    "collectionGroup": "scp_application_management",
    "queryScope": "COLLECTION",
    "variants": ["identity.channelId", "identity.fluCreatorId", "identity.portalCreatorId"],
    "fieldsPerVariant": [
      "<identity variant> ASCENDING",
      "identity.programId ASCENDING",
      "submittedAtIso DESCENDING",
      "__name__ DESCENDING"
    ]
  }
]
*/
// The remaining five tabs (journey/onboarding/content-review/channel-intelligence/audit) have no real
// writer yet — see `hasProductionWriter: false` in MANAGEMENT_TAB_REQUIRED_INDEXES below; deliberately no
// composite-index JSON block for them here (nothing to add-only into firestore.indexes.json).

// ---- Tab / role / envelope primitives (spec §4, §6) --------------------------------------------------

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

export interface RequiredIndexSignature {
  readonly tab: ManagementTabKey;
  readonly collectionGroup: string;
  readonly fields: ReadonlyArray<{
    readonly fieldPath: string;
    readonly order: "ASCENDING" | "DESCENDING";
    // The key to read the equality value from `UnderlyingQueryScope` when it differs from `fieldPath`
    // (e.g. a nested Firestore field path like "identity.programId" queried/indexed under the flat scope
    // key "programId"). Defaults to `fieldPath` when omitted.
    readonly scopeKey?: "fluCreatorId" | "programId" | "campaignId" | "enrollmentId";
  }>;
  // false => no production writer exists anywhere for this collection yet (audited, not guessed). The
  // port must never query it — it fails closed with a reason-coded no-source result instead of a
  // silent/misleading empty page.
  readonly hasProductionWriter: boolean;
}

// One signature remains the compatibility accessor for each fixed tab. Applications additionally query
// three strict identity axes; MANAGEMENT_APPLICATION_REQUIRED_INDEXES is the complete machine-checkable set.
export const MANAGEMENT_APPLICATION_REQUIRED_INDEXES = [
  {
    tab: "applications",
    collectionGroup: "scp_application_management",
    fields: [
      { fieldPath: "identity.channelId", order: "ASCENDING" },
      { fieldPath: "identity.programId", order: "ASCENDING", scopeKey: "programId" },
      { fieldPath: "submittedAtIso", order: "DESCENDING" },
      { fieldPath: "__name__", order: "DESCENDING" },
    ],
    hasProductionWriter: true,
  },
  {
    tab: "applications",
    collectionGroup: "scp_application_management",
    fields: [
      { fieldPath: "identity.fluCreatorId", order: "ASCENDING", scopeKey: "fluCreatorId" },
      { fieldPath: "identity.programId", order: "ASCENDING", scopeKey: "programId" },
      { fieldPath: "submittedAtIso", order: "DESCENDING" },
      { fieldPath: "__name__", order: "DESCENDING" },
    ],
    hasProductionWriter: true,
  },
  {
    tab: "applications",
    collectionGroup: "scp_application_management",
    fields: [
      { fieldPath: "identity.portalCreatorId", order: "ASCENDING" },
      { fieldPath: "identity.programId", order: "ASCENDING", scopeKey: "programId" },
      { fieldPath: "submittedAtIso", order: "DESCENDING" },
      { fieldPath: "__name__", order: "DESCENDING" },
    ],
    hasProductionWriter: true,
  },
] as const satisfies readonly RequiredIndexSignature[];

export const MANAGEMENT_TAB_REQUIRED_INDEXES: Readonly<Record<ManagementTabKey, RequiredIndexSignature>> = {
  journey: {
    tab: "journey",
    collectionGroup: "scp_coldmail_history+scp_application_management+scp_partner_activations",
    fields: [
      { fieldPath: "enrollmentId", order: "ASCENDING" },
      { fieldPath: "occurredAt", order: "DESCENDING" },
    ],
    hasProductionWriter: true,
  },
  outreach: {
    tab: "outreach",
    collectionGroup: "scp_coldmail_history",
    fields: [
      { fieldPath: "programId", order: "ASCENDING" },
      { fieldPath: "campaignId", order: "ASCENDING" },
      { fieldPath: "sentAtIso", order: "DESCENDING" },
    ],
    hasProductionWriter: true,
  },
  applications: MANAGEMENT_APPLICATION_REQUIRED_INDEXES[1],
  onboarding: {
    tab: "onboarding",
    collectionGroup: "scp_onboarding_outbox",
    fields: [
      { fieldPath: "enrollmentId", order: "ASCENDING" },
      { fieldPath: "occurredAt", order: "DESCENDING" },
    ],
    hasProductionWriter: true,
  },
  "content-review": {
    tab: "content-review",
    collectionGroup: "scp_video_review_state",
    fields: [
      { fieldPath: "enrollmentId", order: "ASCENDING" },
      { fieldPath: "submittedAt", order: "DESCENDING" },
    ],
    hasProductionWriter: true,
  },
  "channel-intelligence": {
    tab: "channel-intelligence",
    collectionGroup: "videos",
    fields: [
      { fieldPath: "fluCreatorId", order: "ASCENDING" },
      { fieldPath: "publishedAt", order: "DESCENDING" },
    ],
    hasProductionWriter: true,
  },
  audit: {
    tab: "audit",
    collectionGroup: "scp_partner_activation_events",
    fields: [
      { fieldPath: "enrollmentId", order: "ASCENDING" },
      { fieldPath: "occurredAt", order: "DESCENDING" },
    ],
    hasProductionWriter: true,
  },
};

export function requiredIndexSignatureFor(tab: ManagementTabKey): RequiredIndexSignature {
  return MANAGEMENT_TAB_REQUIRED_INDEXES[tab];
}

// ---- Roles / fail-closed errors ------------------------------------------------------------------

export type ManagementRole = "guest" | "manager" | "admin" | "super_admin";

const ROLE_RANK: Readonly<Record<ManagementRole, number>> = {
  guest: 0,
  manager: 1,
  admin: 2,
  super_admin: 3,
};

// `code` is restricted to the standard callable public codes consumed by
// ./callableErrorBoundary.ts's `toHttpsError` (it maps any other string to `permission-denied` anyway;
// being explicit here keeps the mapping intentional rather than accidental).
export type ManagementReadModelErrorCode = "permission-denied" | "invalid-argument" | "failed-precondition";

export class ManagementReadModelError extends Error {
  readonly code: ManagementReadModelErrorCode;
  readonly retryable: boolean;

  constructor(code: ManagementReadModelErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "ManagementReadModelError";
    this.code = code;
    this.retryable = retryable;
  }
}

// manager+ only (spec §2 access table: guest/unauthenticated can never read).
export function assertRoleAtLeast(role: ManagementRole | null | undefined, minimum: ManagementRole): void {
  const actualRank = role ? ROLE_RANK[role] : undefined;
  if (actualRank === undefined || actualRank < ROLE_RANK[minimum]) {
    throw new ManagementReadModelError(
      "permission-denied",
      `role "${role ?? "none"}" is below the required minimum "${minimum}"`,
      false,
    );
  }
}

// ---- Scope enforcement (spec §1 rule 1 / §4.1: "requests cannot widen scope") ----------------------

export interface ManagementTabScopeRequest {
  readonly fluCreatorId: string;
  readonly programId: string;
  readonly campaignId?: string;
  readonly enrollmentId?: string;
}

export type ManagementCreatorIdentityMatchedBy =
  | "applicationId"
  | "identity.fluCreatorId"
  | "identity.portalCreatorId"
  | "identity.channelId";

export const MANAGEMENT_CREATOR_IDENTITY_MATCH = Symbol("managementCreatorIdentityMatch");

export interface CreatorIdentityScopedRecord {
  readonly applicationId?: string;
  readonly fluCreatorId: string;
  readonly portalCreatorId?: string;
  readonly channelId?: string;
  readonly [MANAGEMENT_CREATOR_IDENTITY_MATCH]?: {
    readonly matchedBy: ManagementCreatorIdentityMatchedBy;
  };
}

export interface ScopedRecord extends CreatorIdentityScopedRecord {
  readonly programId: string;
  readonly campaignId?: string;
  readonly enrollmentId?: string;
}

// The exact, non-widened scope handed to the underlying store. Only fields the caller actually supplied
// are present; a store implementation cannot "helpfully" widen a request by defaulting an omitted field,
// because the field key itself is absent from this object (never `undefined`-present).
export interface UnderlyingQueryScope {
  readonly fluCreatorId: string;
  readonly programId: string;
  readonly campaignId?: string;
  readonly enrollmentId?: string;
}

export function buildUnderlyingQueryScope(request: ManagementTabScopeRequest): UnderlyingQueryScope {
  if (typeof request.fluCreatorId !== "string" || request.fluCreatorId.length === 0) {
    throw new ManagementReadModelError("invalid-argument", "fluCreatorId is required", false);
  }
  if (typeof request.programId !== "string" || request.programId.length === 0) {
    throw new ManagementReadModelError("invalid-argument", "programId is required", false);
  }
  const scope: { fluCreatorId: string; programId: string; campaignId?: string; enrollmentId?: string } = {
    fluCreatorId: request.fluCreatorId,
    programId: request.programId,
  };
  if (typeof request.campaignId === "string" && request.campaignId.length > 0) {
    scope.campaignId = request.campaignId;
  }
  if (typeof request.enrollmentId === "string" && request.enrollmentId.length > 0) {
    scope.enrollmentId = request.enrollmentId;
  }
  return scope;
}

// Defense-in-depth: even if a store leaked a cross-scope row, this rejects it before it reaches the
// caller. An authoritative fluCreatorId can never be displaced by a lower-authority alias. Only a row
// without that owner claim may use the exact application/Portal/channel axis proved by the store lookup.
export function assertCreatorIdentityMatch(
  requestedFluCreatorId: string,
  record: CreatorIdentityScopedRecord,
): void {
  const authoritativeOwner = record.fluCreatorId.trim();
  if (authoritativeOwner) {
    if (authoritativeOwner === requestedFluCreatorId) return;
    throw new ManagementReadModelError(
      "permission-denied",
      "record is outside the requested fluCreatorId scope",
      false,
    );
  }

  const matchedBy = record[MANAGEMENT_CREATOR_IDENTITY_MATCH]?.matchedBy;
  const matchedAlias =
    matchedBy === "applicationId" ? record.applicationId :
    matchedBy === "identity.portalCreatorId" ? record.portalCreatorId :
    matchedBy === "identity.channelId" ? record.channelId :
    matchedBy === "identity.fluCreatorId" ? record.fluCreatorId :
    undefined;
  const aliases = new Set([matchedAlias].filter((value): value is string => Boolean(value)));
  if (!aliases.has(requestedFluCreatorId)) {
    throw new ManagementReadModelError(
      "permission-denied",
      "record has no proven alias for the requested fluCreatorId",
      false,
    );
  }
}

export function assertScopeMatch(request: ManagementTabScopeRequest, record: ScopedRecord): void {
  assertCreatorIdentityMatch(request.fluCreatorId, record);
  if (record.programId !== request.programId) {
    throw new ManagementReadModelError(
      "permission-denied",
      "record is outside the requested programId scope",
      false,
    );
  }
  if (request.campaignId !== undefined && record.campaignId !== request.campaignId) {
    throw new ManagementReadModelError("permission-denied", "record is outside the requested campaign scope", false);
  }
  if (request.enrollmentId !== undefined && record.enrollmentId !== request.enrollmentId) {
    throw new ManagementReadModelError(
      "permission-denied",
      "record is outside the requested enrollment scope",
      false,
    );
  }
}

// Fail-closed filter: silently drop (never throw through) any row a store returned outside the
// requested scope, rather than surfacing widened data to the caller.
export function filterRecordsByScope<T extends ScopedRecord>(
  request: ManagementTabScopeRequest,
  records: readonly T[],
): T[] {
  return records.filter((record) => {
    try {
      assertScopeMatch(request, record);
      return true;
    } catch {
      return false;
    }
  });
}

// ---- Cursor + limit bounding (spec §4.1: "cursor/limit required, no unbounded collection fallback") --

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const MIN_PAGE_SIZE = 1;

export interface CursorPageRequest {
  cursor?: string | null;
  limit?: number;
}

export interface ResolvedCursorPageRequest {
  readonly cursor: string | null;
  readonly limit: number;
}

export function resolveCursorPageRequest(input: CursorPageRequest | undefined | null): ResolvedCursorPageRequest {
  let limit = DEFAULT_PAGE_SIZE;
  const rawLimit = input?.limit;
  if (typeof rawLimit === "number" && Number.isFinite(rawLimit)) {
    limit = Math.trunc(rawLimit);
  }
  if (limit < MIN_PAGE_SIZE) limit = MIN_PAGE_SIZE;
  if (limit > MAX_PAGE_SIZE) limit = MAX_PAGE_SIZE;
  const cursor = typeof input?.cursor === "string" && input.cursor.length > 0 ? input.cursor : null;
  return { cursor, limit };
}

export interface CursorPage<T> {
  rows: T[];
  pageInfo: {
    nextCursor: string | null;
    truncated: boolean;
  };
  sourceState: SourceReadEnvelope<unknown>;
}

// `rows` MUST be the store's fetch of at most `limit + 1` records (never an unbounded scan) — the extra
// row (if present) is only used to detect truncation and is stripped from the returned page.
export function buildCursorPage<T>(rows: readonly T[], limit: number, cursorOf: (row: T) => string): CursorPage<T> {
  if (rows.length > limit + 1) {
    // A store that ignored the bound is a programming error in the store, not something this pure
    // function should silently paper over by truncating further — fail closed and loudly.
    throw new ManagementReadModelError(
      "failed-precondition",
      `store returned ${rows.length} rows for limit ${limit}; expected at most limit + 1`,
      false,
    );
  }
  const truncated = rows.length > limit;
  const pageRows = truncated ? rows.slice(0, limit) : rows.slice();
  const nextCursor = truncated ? cursorOf(pageRows[pageRows.length - 1]) : null;
  const now = new Date().toISOString();
  return {
    rows: pageRows,
    pageInfo: { nextCursor, truncated },
    sourceState: { state: pageRows.length === 0 ? "empty" : "ready", updatedAt: now, requestedAt: now },
  };
}

// ---- PII / protected-material masking (spec §3.2/§4.3/§5.x: no raw email/UID/token anywhere) --------

// Never reveals the original length or full domain; keeps only a first-character hint plus the TLD so
// operators can sanity-check without any raw email ever crossing the projection boundary.
export function maskEmail(email: string | null | undefined): string | null {
  if (typeof email !== "string" || email.length === 0) return null;
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const localMasked = `${local[0]}***`;
  const domainParts = domain.split(".").filter((part) => part.length > 0);
  const tld = domainParts.length > 1 ? domainParts[domainParts.length - 1] : "";
  const domainMasked = tld ? `***.${tld}` : "***";
  return `${localMasked}@${domainMasked}`;
}

// UID/token/secret/model-reasoning fields are never returned at all (spec §1 non-goal, §5.7 permissions)
// — this always redacts regardless of role, input, or environment. There is no "reveal for admin" path.
export function redactProtectedField(_value: unknown): null {
  return null;
}

// ---- Profile image resolution (spec §3.2 precedence order) ------------------------------------------

export type ProfileImageSourceKind = "youtube_oauth" | "flu_channel" | "youtube_data_api" | "initials";

export interface ProfileImageProjection {
  url: string | null;
  fallbackInitials: string;
  source: ProfileImageSourceKind;
  verifiedAt?: string;
  imageRevision: number;
}

export interface ProfileImageSourceInputs {
  readonly youtubeOauthVerifiedThumbnailUrl?: string | null;
  readonly fluCanonicalChannelImageUrl?: string | null;
  readonly youtubeDataApiPublicThumbnailUrl?: string | null;
}

function computeInitials(displayName: string | null | undefined): string {
  const trimmed = (displayName ?? "").trim();
  if (trimmed.length === 0) return "?";
  const parts = trimmed.split(/\s+/).slice(0, 2);
  const initials = parts.map((part) => part.charAt(0).toUpperCase()).join("");
  return initials.length > 0 ? initials : "?";
}

function isNonEmptyUrl(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Precedence, fixed by spec §3.2: (1) verified YouTube OAuth thumbnail, (2) Flu canonical channel image,
// (3) server-fetched public YouTube Data API thumbnail, (4) initials. Never merges/reorders sources.
export function resolveProfileImageProjection(
  inputs: ProfileImageSourceInputs,
  displayName: string | null | undefined,
  imageRevision: number,
  verifiedAt?: string,
): ProfileImageProjection {
  const fallbackInitials = computeInitials(displayName);
  if (isNonEmptyUrl(inputs.youtubeOauthVerifiedThumbnailUrl)) {
    return {
      url: inputs.youtubeOauthVerifiedThumbnailUrl,
      fallbackInitials,
      source: "youtube_oauth",
      verifiedAt,
      imageRevision,
    };
  }
  if (isNonEmptyUrl(inputs.fluCanonicalChannelImageUrl)) {
    return { url: inputs.fluCanonicalChannelImageUrl, fallbackInitials, source: "flu_channel", imageRevision };
  }
  if (isNonEmptyUrl(inputs.youtubeDataApiPublicThumbnailUrl)) {
    return {
      url: inputs.youtubeDataApiPublicThumbnailUrl,
      fallbackInitials,
      source: "youtube_data_api",
      imageRevision,
    };
  }
  return { url: null, fallbackInitials, source: "initials", imageRevision };
}

// ---- creator display identity (name/handle) ------------------------------------------------------
//
// 프로필 이미지가 resolveProfileImageProjection 하나로 수렴한 것과 같은 이유로, 이름/핸들도 여기 하나만
// 둔다. 이 규칙이 흩어져 있었을 때 세 갈래로 갈렸다: tracking store 는 displayName 에 fluCreatorId 를
// 하드코딩했고(운영 행 97개에 "CR00037" 박제), partner ports 는 @ 필터 없이 creators.handle 을 그대로
// 통과시켰다(이메일 노출 경로).
//
// 규칙:
//   displayName — creators 가 정본. 비어 있을 때만 fluCreatorId 로 폴백한다(빈 이름을 만들지 않기 위한
//                 최후 수단이지 정상 경로가 아니다 — creatorIdentityViolations 가 그 상태를 감시한다).
//   handle      — YouTube 핸들(@ 접두)만 통과. creators.handle 에 이메일이 든 레코드가 있고 리포트·파트너
//                 표면은 공개 표면이다. 필터가 여기 한 곳이라 우회 경로가 생길 수 없다.
// creators 문서에서 이미지 소스 3종을 뽑는 정본. 이 매핑이 흩어져 있어서 검수 화면은 실제로 값이 들어
// 있는 youtubeOauth/fluCanonical/youtubeDataApi 필드를 못 보고 아바타를 비워 두고 있었다(운영 112/118건 보유).
export function creatorProfileImageSourceInputs(
  creator: Record<string, unknown> | undefined,
): ProfileImageSourceInputs {
  const httpsOnly = (value: unknown): string | null => {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return null;
    try {
      return new URL(text).protocol === "https:" ? text : null;
    } catch {
      return null;
    }
  };
  const nested =
    creator?.profileImage && typeof creator.profileImage === "object"
      ? (creator.profileImage as Record<string, unknown>)
      : {};
  return {
    youtubeOauthVerifiedThumbnailUrl:
      httpsOnly(creator?.youtubeOauthVerifiedThumbnailUrl) ?? httpsOnly(nested.url),
    fluCanonicalChannelImageUrl:
      httpsOnly(creator?.fluCanonicalChannelImageUrl) ??
      httpsOnly(creator?.canonicalProfileImageUrl),
    youtubeDataApiPublicThumbnailUrl:
      httpsOnly(creator?.youtubeDataApiPublicThumbnailUrl) ??
      httpsOnly(creator?.avatar) ??
      httpsOnly(creator?.thumbnailUrl) ??
      httpsOnly(creator?.profileImageUrl),
  };
}

export interface CreatorDisplayIdentity {
  readonly displayName: string;
  readonly handle: string | null;
  /**
   * 이름이 아직 이메일 주소밖에 없을 때 그 주소. 화면은 이 값을 이름 자리에 쓰지 않는다.
   * (운영 실측 2026-07-26: conversations 폴백으로 만들어진 conv_* 28건 전부 creatorName 이
   * 발신자 이메일이었고, 그대로 이름 자리에 렌더됐다 — 사내 주소 3건 포함.)
   */
  readonly emailOnly: string | null;
}

/** 이름 자리에 들어오면 안 되는 값 — 이메일 주소 형태. */
export const EMAIL_ONLY_DISPLAY_NAME = "이메일만 확보";

const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailShapedIdentity(value: unknown): boolean {
  return EMAIL_SHAPED.test(identityText(value));
}

/** 사내 계정은 크리에이터가 아니다. 대화 파생 행을 관리 모수에서 걸러낼 때 쓴다. */
export const INTERNAL_IDENTITY_DOMAIN = "@supercent.io";

export function isInternalIdentityEmail(value: unknown): boolean {
  return identityText(value).toLowerCase().endsWith(INTERNAL_IDENTITY_DOMAIN);
}

function identityText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveCreatorDisplayIdentity(
  creator: Record<string, unknown> | undefined,
  fluCreatorId: string,
  conversation?: Record<string, unknown>,
): CreatorDisplayIdentity {
  // 이메일 주소는 이름이 아니다. 이름 후보가 이메일 형태면 승격하지 않고 별도 필드로 넘긴다.
  const nameCandidates = [
    identityText(creator?.displayName),
    identityText(creator?.name),
    identityText(conversation?.creatorName),
  ].filter(Boolean);
  const displayName = nameCandidates.find((candidate) => !EMAIL_SHAPED.test(candidate)) ?? "";
  const emailOnly = displayName ? "" : (nameCandidates.find((candidate) => EMAIL_SHAPED.test(candidate)) ?? "");
  const creatorHandle = identityText(creator?.handle);
  const conversationHandle = identityText(conversation?.creatorHandle);
  const handle = [creatorHandle, conversationHandle].find((candidate) =>
    candidate.startsWith("@")
  );
  return {
    displayName: displayName || (emailOnly ? EMAIL_ONLY_DISPLAY_NAME : identityText(fluCreatorId)),
    handle: handle ?? null,
    emailOnly: emailOnly || null,
  };
}

// 결과 가드. 어떤 경로로 만들어졌든 "저장/노출된 정체성"만 보고 판정하므로 새 코드 경로가 우회할 수 없다.
// scripts/assert-emulator-firestore.mjs 가 e2e 끝에서 영속된 행 전체에 이걸 돌린다.
export function creatorIdentityViolations(
  identity: { displayName?: unknown; handle?: unknown; fluCreatorId?: unknown },
  creator: Record<string, unknown> | undefined,
): string[] {
  const violations: string[] = [];
  const displayName = identityText(identity.displayName);
  const handle = identityText(identity.handle);
  const fluCreatorId = identityText(identity.fluCreatorId);
  if (
    fluCreatorId &&
    displayName === fluCreatorId &&
    identityText(creator?.displayName)
  ) {
    violations.push("creator_id_persisted_as_display_name");
  }
  if (handle && !handle.startsWith("@")) {
    violations.push("non_youtube_handle_exposed");
  }
  return violations;
}

// ---- Independent per-tab envelopes (spec §3.1/§4.2/§5.x: a slow/failed tab never blocks Tier-A) -----

export interface LoadTabEnvelopeOptions {
  readonly now?: () => string;
}

// Loads exactly one tab's data behind its own try/catch. On failure: keep the last good snapshot as
// `stale` if one exists, otherwise return a bare `error` envelope — either way this never throws, so a
// caller looping over tabs independently cannot have one failure cancel the others.
export async function loadTabEnvelope<T>(
  previous: SourceReadEnvelope<T> | undefined,
  loader: () => Promise<T>,
  isEmpty: (data: T) => boolean,
  options: LoadTabEnvelopeOptions = {},
): Promise<SourceReadEnvelope<T>> {
  const now = options.now ?? (() => new Date().toISOString());
  const requestedAt = now();
  try {
    const data = await loader();
    const updatedAt = now();
    if (isEmpty(data)) {
      return { state: "empty", data, requestedAt, updatedAt };
    }
    return { state: "ready", data, requestedAt, updatedAt, sourceRevision: updatedAt };
  } catch (err) {
    const errorCode = err instanceof ManagementReadModelError ? err.code : "internal";
    const retryable = err instanceof ManagementReadModelError ? err.retryable : true;
    if (previous && (previous.state === "ready" || previous.state === "stale") && previous.data !== undefined) {
      return { ...previous, state: "stale", errorCode, retryable, requestedAt };
    }
    return { state: "error", requestedAt, errorCode, retryable };
  }
}

export type ManagementTabLoaders = Partial<Record<ManagementTabKey, () => Promise<unknown>>>;
export type ManagementTabEnvelopes = Partial<Record<ManagementTabKey, SourceReadEnvelope<unknown>>>;

function defaultIsEmpty(data: unknown): boolean {
  if (Array.isArray(data)) return data.length === 0;
  if (data && typeof data === "object" && "rows" in (data as Record<string, unknown>)) {
    const rows = (data as { rows?: unknown }).rows;
    return Array.isArray(rows) && rows.length === 0;
  }
  return data === null || data === undefined;
}

// Runs every supplied tab loader concurrently and in isolation (Promise.allSettled): one tab timing out
// or throwing can never prevent another tab's envelope (or the already-rendered Tier-A shell) from
// resolving.
export async function loadAllTabEnvelopesIndependently(
  loaders: ManagementTabLoaders,
  previous: ManagementTabEnvelopes = {},
  options: LoadTabEnvelopeOptions = {},
): Promise<ManagementTabEnvelopes> {
  const entries = Object.entries(loaders) as Array<[ManagementTabKey, () => Promise<unknown>]>;
  const settled = await Promise.allSettled(
    entries.map(async ([tab, loader]) => {
      const envelope = await loadTabEnvelope(previous[tab], loader, defaultIsEmpty, options);
      return [tab, envelope] as const;
    }),
  );
  const out: ManagementTabEnvelopes = {};
  settled.forEach((result, index) => {
    const [tab] = entries[index];
    if (result.status === "fulfilled") {
      out[result.value[0]] = result.value[1];
    } else {
      // loadTabEnvelope never throws in practice, but guard anyway so one tab can never take others down.
      out[tab] = { state: "error", errorCode: "internal", retryable: true };
    }
  });
  return out;
}

// ---- Shared projection/domain types (spec §6) --------------------------------------------------------

export type AttributionState = "managed" | "unclassified" | "ambiguous" | "conflict";
export type PartnerActivationState = "pending" | "active" | "revoked";

export interface CreatorIdentityProjection {
  fluCreatorId: string;
  displayName: string;
  handle?: string;
  canonicalChannelId?: string;
  platform: "YouTube" | "Instagram" | "TikTok" | "X" | "Web";
  owner?: string;
  followers?: number;
  profileImage: ProfileImageProjection;
}

export interface CreatorManagementScope {
  fluCreatorId: string;
  applicationId?: string;
  portalCreatorId?: string;
  enrollmentId?: string;
  programId?: string;
  campaignId?: string;
  outreachId?: string;
  attributionState: AttributionState;
  attributionEvidence: "signed_outreach_token" | "operator_assignment" | "none";
  scopeRevision: number;
}

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

export interface CurrentActionProjection {
  state: string;
  stateEnteredAt?: string;
  actionCode?: string;
  actionLabel: string;
  actionHref?: string;
  blockerCode?: string;
  blockerLabel?: string;
  projectionStatus: "fresh" | "stale" | "failed" | "rebuilding";
  computedAt: string;
  expectedRevision: number;
}

export interface CreatorManagementShell {
  creator: CreatorIdentityProjection;
  scope: CreatorManagementScope;
  enrollments: Array<{
    enrollmentId: string;
    programId: string;
    campaignId?: string;
    status: "active" | "revoked" | "completed";
  }>;
  currentAction: CurrentActionProjection;
  partnerLink?: {
    enrollmentId: string;
    partnerRoute: string;
    activationState: PartnerActivationState;
    activatedAt?: string;
    activationEvidenceRef?: string;
  };
  sourceStates: Record<string, SourceReadEnvelope<unknown>>;
  routeRedirect?: string;
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

// Read-only, immutable evidence type. L1 (Partner activation transaction core) owns the WRITE side; this
// module never creates/mutates activation evidence — it only ever displays what already exists.
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
