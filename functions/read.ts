import { createHash } from "node:crypto";
import { CHAT_CASEBOOK } from "./chatCasebook";
import { adminDb, adminRuntimeEnvironment } from "./firebaseAdmin";
import { FieldPath, Filter, Timestamp, type Query, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { asRecord, asString, assertNonGuestAuth, makeBehaviorLog } from "./shared";
import { MAX_SCP_SHEET_ROWS, readScpQualificationReviewRows } from "./scpSheetReviewService";
import {
  ScpSheetDatasetEngineError,
  readScpSheetDatasetControl,
  readScpSheetDatasetWithCutover,
  readScpSheetPublicProjection,
} from "./scpSheetPublicProjection";
import type { CallableRequestShape, Role } from "./shared";
import {
  canonicalThreadIdForData,
  conversationIdsForData,
  workflowContextKeyForData,
  workflowContextKeyForSnapshot,
} from "./conversationScope";
import { isOperationalFixtureRecord } from "./operationalFixtureProvenance";
import { canonicalOutboundFailure } from "./mailSafetyShared";
import {
  llmUsageAggregationIdentity,
  normalizeLlmProvider,
  normalizeLlmUsageTransport,
} from "./aiHubReport";
import {
  confirmedProgramIdentitySet,
  MAX_CONFIRMED_PROGRAM_IDENTITIES,
  mergeConfirmedProgramRows,
  resolveCanonicalProgramId,
  SCP_CANONICAL_PROGRAM_ID,
} from "./programCanonical";
import { readConfirmedProgramAliasRegistryState } from "./programAliasRegistry";
import {
  applicationManagementFallbackAliasIds,
  applicationManagementFallbackProfileRow,
  scpLifecycleProfileNotFoundReason,
} from "./scpLifecycleProfiles";
import {
  listApplicationManagementLifecycleFallbackRecords,
  type ApplicationManagementLifecycleFallbackProfile,
} from "./applicationManagementStore";
import { enrichApplicationManagementProvenance } from "./provenanceDisplay";
import {
  creatorProfileImageSourceInputs,
  isInternalIdentityEmail,
  resolveCreatorDisplayIdentity,
  resolveProfileImageProjection,
} from "./managementProfileTabsReadModels";
import {
  isCallerScpEntitled,
  listAccessibleMailAccountsForEmail,
  readMailAccountsCached,
  resolveMailAccountsDb,
  resolveMailSenderPolicyForEmail,
} from "./mailAccounts";
import { canonicalScpOrgId, normalizedMailAccountIdForRead } from "./mailConversationAuthorization";
import {
  canReadConversationRowForScope,
  resolveConversationMailAccessScope,
  type ConversationMailAccessScope,
} from "./conversationMailAccessScope";

// 대화에서 파생된 크리에이터 행의 문서 id 접두(운영 실측 28건).
const CONVERSATION_DERIVED_CREATOR_PREFIX = "conv_";
import { loadOwnerDisplayIndex, resolveOwnerDisplayForRecord } from "./ownerDisplayProjection";
// Flu/Task-50 적대 리뷰 P0-2: super_admin "대신 보기" 검증 헬퍼 — Chat 목록/메시지/원문 읽기
// 스코프에도 같은 신원 검증(members 컬렉션 재조회)을 재사용한다. mailAccountCallables.ts는
// read.ts를 import하지 않으므로(반대 방향만 존재) 순환 의존 없음.
import { resolveViewAsTarget } from "./mailAccountCallables";
// "미답장 인박스" (2026-09-26): scp 사서함 대화 중 사람 답장이 필요한 것만 모으는 전용 큐가
// 재사용하는 헬퍼들 — manual-reply defense-in-depth(같은 모듈이 sendAutoReplyJob 발송 직전에도
// 쓴다)와 T049류 조직 제외(같은 판정을 발송 게이트와 공유해 두 축이 갈라지지 않게 한다).
import { detectManualReplySinceInbound } from "./manualReplyDetection";
import { disabledOrgSharesMailAccount, isAutoReplyOrgExcluded } from "./mailHumanGate";
import { readMailRouting } from "./mailAccounts";
import { readSettings } from "./settings";
import {
  accountOwnedRowMatchesScopeAsync,
  resolveAccountOwnershipScopeForAuth,
  resolveTrustedLegacyOwnerForRecord,
  type AccountOwnershipScope,
} from "./accountOwnership";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 2000;
const MAX_HIDDEN_PAGE_SCAN_PAGES = 10;
const CACHE_MAX_AGE_SECONDS = 60;
const APPLICATION_MANAGEMENT_FALLBACK_WINDOW_SIZE = 200;
const FIRESTORE_IN_QUERY_LIMIT = 30;
export const COMMUNITY_DISCOVERY_GLOBAL_SCOPE = "__global__" as const;

// The web release and callable release can be deployed independently. Keep an explicit
// response contract marker so the SCP screen can distinguish a genuinely old callable
// (which does not know the Sheet dataset keys) from a current request that is merely
// still in flight behind another progressively committed dataset.
export const GET_DATASET_CONTRACT_VERSION = "get-dataset-v2" as const;

export type DatasetKey =
  | "creators"
  | "channelStats"
  | "agencies"
  | "campaigns"
  | "programs"
  | "programApplications"
  | "programSheetLeads"
  | "scpQualificationRows"
  | "creatorLinks"
  | "scpMailTemplates"
  | "scpMailResults"
  | "submissionTasks"
  | "contracts"
  | "reviews"
  | "escalations"
  | "submissions"
  | "videos"
  | "scpLifecycleProfiles"
  | "candidatePool"
  | "communityPosts"
  | "feedDiscoveryState"
  | "members"
  | "llmUsage"
  | "templates"
  | "conversations"
  | "autoReply"
  | "feedback"
  | "knowledgeNodes"
  | "knowledgeEdges"
  | "behaviorLogs"
  | "costLogs"
  | "rawRecords"
  | "recCandidates"
  | "creatorComments"
  | "creatorCommentInsights";

const STAGING_EXTERNAL_DATASET_KEYS: ReadonlySet<DatasetKey> = new Set([
  "scpQualificationRows",
]);
const PROGRAM_SCOPED_LIST_KEYS: ReadonlySet<DatasetKey> = new Set([
  "programApplications",
  "programSheetLeads",
  "reviews",
  "submissions",
]);

export function datasetKeyAllowedInRuntime(
  key: DatasetKey,
  runtimeEnvironment = adminRuntimeEnvironment.runtimeEnvironment,
): boolean {
  return runtimeEnvironment !== "staging" || !STAGING_EXTERNAL_DATASET_KEYS.has(key);
}

type DatasetBundle = {
  ok: true;
  seeded: boolean;
  loadedKeys: DatasetKey[];
  datasetContract: {
    version: typeof GET_DATASET_CONTRACT_VERSION;
    runtimeEnvironment: typeof adminRuntimeEnvironment.runtimeEnvironment;
  };
  cache: {
    generatedAtIso: string;
    maxAgeSeconds: number;
    requestedKeys: DatasetKey[];
  };
  counts: Record<string, number>;
  pageInfo: Record<string, PageInfo>;
  creators: Record<string, unknown>[];
  channelStats: Record<string, Record<string, unknown>>;
  agencies: Record<string, unknown>[];
  campaigns: Record<string, unknown>[];
  programs: Record<string, unknown>[];
  programApplications: Record<string, unknown>[];
  programSheetLeads: Record<string, unknown>[];
  scpQualificationRows: Record<string, unknown>[];
  creatorLinks: Record<string, unknown>[];
  scpMailTemplates: Record<string, unknown>[];
  scpMailResults: Record<string, unknown>[];
  submissionTasks: Record<string, unknown>[];
  contracts: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  escalations: Record<string, unknown>[];
  submissions: Record<string, unknown>[];
  videos: Record<string, unknown>[];
  scpLifecycleProfiles: Record<string, unknown>[];
  candidatePool: Record<string, unknown>[];
  communityPosts: Record<string, unknown>[];
  feedDiscoveryState: Record<string, unknown>[];
  members: Record<string, unknown>[];
  llmUsage: Record<string, unknown>[];
  templates: Record<string, unknown>[];
  conversations: Record<string, unknown>[];
  autoReply: Record<string, unknown>[];
  feedback: Record<string, unknown>[];
  knowledgeNodes: Record<string, unknown>[];
  knowledgeEdges: Record<string, unknown>[];
  behaviorLogs: Record<string, unknown>[];
  costLogs: Record<string, unknown>[];
  rawRecords: Record<string, unknown>[];
  recCandidates: Record<string, unknown>[];
  creatorComments: Record<string, unknown>[];
  behaviorLog: ReturnType<typeof makeBehaviorLog>;
};

type PageInfo = {
  limit: number;
  truncated: boolean;
  nextCursor: string | null;
  otherProgramCount?: number;
};

type OrderDirection = "asc" | "desc";
type CollectionOrder = {
  field?: string;
  direction?: OrderDirection;
};
type CollectionFilter = {
  field: string;
  value: string;
};

type CanonicalProgramScope = {
  canonicalProgramId: string;
  queryProgramIds: string[];
  aliasMap: Record<string, string>;
};

type PageCursor = {
  docId: string;
  orderValue?: unknown;
  scopeKey?: string;
  // Set when the page that produced this cursor was served by the missing-index
  // document-order fallback. Later pages must then stay on document order even if
  // the composite index finishes building mid-pagination — mixing order modes
  // between pages would skip or duplicate rows.
  fallback?: boolean;
};

type MessageSourceEnvelope = {
  ok: boolean;
  found: boolean;
  /** ok:false, found:true 일 때만 채워진다 — 원문 자체는 있지만 이 역할엔 열람 권한이 없다는 뜻. */
  reason?: "scope";
  messageRef: string;
  subject?: string;
  from?: string;
  to?: string;
  direction?: string;
  body?: string;
  /** 전문이 원장에 없을 때의 대체 축(240자 프리뷰). 뷰어는 이걸 받으면 "프리뷰만 보존됨"을 밝힌다. */
  bodyPreview?: string;
  summaryKr?: string;
  createdAtIso?: string;
  sentAtIso?: string;
  receivedAtIso?: string;
  mailEventAtIso?: string;
  behaviorLog: ReturnType<typeof makeBehaviorLog>;
};

type DatasetPageEnvelope = {
  ok: true;
  key: DatasetKey;
  rows: Record<string, unknown>[];
  counts: Record<string, number>;
  pageInfo: PageInfo;
  cache: {
    generatedAtIso: string;
    maxAgeSeconds: number;
    requestedKeys: DatasetKey[];
  };
  // PLAN-ORG-MAIL-IDENTITY Slice 5: only present for key === "conversations". viewerOrgId is
  // the caller's own resolved org (null for admins, who are never scoped); orgFilterApplied is
  // true whenever the row set was actually restricted (always true for manager/viewer, true for
  // an admin who passed an explicit orgId filter).
  viewerOrgId?: string | null;
  orgFilterApplied?: boolean;
  timing?: ReadPhaseTiming;
  behaviorLog: ReturnType<typeof makeBehaviorLog>;
};

type ConversationMessagesEnvelope = {
  ok: true;
  conversationId: string;
  threadId?: string;
  contextKey?: string;
  conversationIds?: string[];
  messages: Record<string, unknown>[];
  pageInfo: PageInfo;
  cache: {
    generatedAtIso: string;
    maxAgeSeconds: number;
    requestedKeys: ["conversationMessages"];
  };
  timing?: ReadPhaseTiming;
  behaviorLog: ReturnType<typeof makeBehaviorLog>;
};

type CollectionRead = {
  rows: Record<string, unknown>[];
  pageInfo: PageInfo;
  // chat-latency 계측: 이 읽기가 실제로 스캔한 Firestore 페이지 수(숨김/스코프 백필 루프 포함).
  // in-memory/빈 읽기는 0 — 쿼리를 한 번도 치지 않았다는 뜻이다.
  scannedPages: number;
};

/**
 * Chat 지연 분해 계측(feat/chat-latency-instrument): 읽기 callable 응답의 기존
 * cache/behaviorLog 메타데이터 옆에 얹는 구간별 벽시계 ms — /chat 지연의 다음 측정이
 * 추론이 아니라 실측이 되게 한다. additive 필드일 뿐 기존 응답 계약은 바뀌지 않는다.
 * SEC-P0-009: 숫자만 담는다 — 행/페이로드 내용은 절대 로그·응답에 넣지 않는다.
 */
type ReadPhaseTiming = {
  /** 함수 진입부터 응답 조립 직전까지의 전체 벽시계 ms. */
  totalMs: number;
  /** assertNonGuestAuth + 역할 게이트 + 요청 파싱 구간. */
  authMs: number;
  /** effectiveConversationAuth + resolveConversationOrgScope/resolveRequestedMailAccountId 등 스코프·정책 해석 구간(여러 조각이면 합산). */
  policyMs: number;
  /** readCollection 스캔/백필 루프 또는 targeted-id read 쿼리 구간. */
  queryMs: number;
  /** normalizeRowsForKey 정규화/하이드레이션(+ 스코프 필터) 구간. */
  normalizeMs: number;
  /** readCollection 이 실제로 스캔한 페이지 수 — target read 처럼 스캔 루프가 없는 경로는 생략. */
  scannedPages?: number;
};

const SHARED_DATASET_KEYS: DatasetKey[] = [
  "creators",
  "channelStats",
  "agencies",
  "campaigns",
  "programs",
  "programApplications",
  "programSheetLeads",
  "scpQualificationRows",
  "creatorLinks",
  "scpMailTemplates",
  "scpMailResults",
  "submissionTasks",
  "contracts",
  "reviews",
  "escalations",
  "submissions",
  "videos",
  "scpLifecycleProfiles",
  "candidatePool",
  "communityPosts",
  "feedDiscoveryState",
  "templates",
  "conversations",
  "recCandidates",
  "creatorComments",
];

const ADMIN_KEYS: DatasetKey[] = [
  ...SHARED_DATASET_KEYS,
  "videos",
  "communityPosts",
  "creatorComments",
  "creatorCommentInsights",
  "llmUsage",
  "conversations",
  "autoReply",
  "feedback",
  "knowledgeNodes",
  "knowledgeEdges",
  "behaviorLogs",
  "costLogs",
  "rawRecords",
  "members",
];

const SUPER_ADMIN_KEYS: DatasetKey[] = [
  ...ADMIN_KEYS,
];

const ALL_DATASET_KEYS: DatasetKey[] = SUPER_ADMIN_KEYS;
const DATASET_KEY_SET = new Set<DatasetKey>(ALL_DATASET_KEYS);
const PAGED_DATASET_KEYS = new Set<DatasetKey>([
  "creators",
  "campaigns",
  "videos",
  "communityPosts",
  "conversations",
  "submissions",
  "candidatePool",
  "programs",
  "programApplications",
  "scpLifecycleProfiles",
]);
const CREATOR_STAGE_KEYS = new Set(["contact", "negotiation", "contract", "review", "live"]);
const CREATOR_GUIDE_STATUS_KEYS = new Set(["within", "near", "over"]);
const ROLE_DATASET_POLICY: Record<Role, Set<DatasetKey>> = {
  guest: new Set(),
  viewer: new Set(SHARED_DATASET_KEYS),
  manager: new Set(SHARED_DATASET_KEYS),
  admin: new Set(ADMIN_KEYS),
  super_admin: new Set(SUPER_ADMIN_KEYS),
};

function canReadDatasetKey(role: Role, key: DatasetKey): boolean {
  return ROLE_DATASET_POLICY[role].has(key);
}

export function datasetKeysForReadRole(role: Role): DatasetKey[] {
  return ALL_DATASET_KEYS.filter((key) => canReadDatasetKey(role, key));
}

function isDatasetKey(value: unknown): value is DatasetKey {
  return typeof value === "string" && DATASET_KEY_SET.has(value as DatasetKey);
}

function requestedDatasetKeys(data: unknown, role: Role): DatasetKey[] {
  const record = asRecord(data);
  const rawKeys = Array.isArray(record.keys) ? record.keys : ALL_DATASET_KEYS;
  const requested = new Set<DatasetKey>();
  for (const key of rawKeys) {
    if (
      isDatasetKey(key) &&
      canReadDatasetKey(role, key)
    ) {
      requested.add(key);
    }
  }
  return Array.from(requested);
}

function emptyRead(): Promise<CollectionRead> {
  return Promise.resolve({ rows: [], pageInfo: { limit: 0, truncated: false, nextCursor: null }, scannedPages: 0 });
}

function inMemoryRead(rows: Record<string, unknown>[], limit = DEFAULT_PAGE_SIZE): Promise<CollectionRead> {
  const boundedLimit = pageSize(limit);
  const sliced = rows.slice(0, boundedLimit);
  return Promise.resolve({
    rows: sliced,
    pageInfo: {
      limit: boundedLimit,
      truncated: rows.length > boundedLimit,
      nextCursor: null,
    },
    scannedPages: 0,
  });
}

async function readScpSheetDataset(key: "scpQualificationRows", limit: number): Promise<CollectionRead> {
  const effectiveLimit = Math.max(pageSize(limit), MAX_SCP_SHEET_ROWS);
  try {
    const result = await readScpSheetDatasetWithCutover({
      datasetKey: key,
      readControl: () => readScpSheetDatasetControl(key),
      readGoogle: async () => await readScpQualificationReviewRows() as unknown as Record<string, unknown>[],
      readProjection: ({ datasetKey, sourceId, metadata }) =>
        readScpSheetPublicProjection({ datasetKey, sourceId, metadata }),
    });
    return inMemoryRead(result.rows, effectiveLimit);
  } catch (error) {
    return inMemoryRead([{
      id: `${key}-read-error`,
      readError: true,
      status: "read_error",
      reviewStatus: "read_error",
      qualificationStatus: "read_error",
      sourceType: "sheet_cutover_engine",
      ...safeDatasetReadFailureEvidence(error, key),
      updatedAtIso: new Date().toISOString(),
    }], effectiveLimit);
  }
}

export function safeDatasetReadFailureEvidence(
  error: unknown,
  key: "scpQualificationRows",
): {
  errorCode:
    | "scp_sheet_read_failed"
    | "scp_sheet_cutover_invalid"
    | "scp_sheet_projection_unavailable"
    | "scp_sheet_cutover_changed";
  failureReason:
    | "google_sheet_read_failed"
    | "sheet_cutover_invalid"
    | "firestore_projection_unavailable"
    | "sheet_cutover_changed";
  correlationIdHash: string;
} {
  const privateErrorText =
    error instanceof Error
      ? `${error.name}\u0000${error.message}`
      : typeof error === "string" || typeof error === "number"
        ? String(error)
        : "unknown_sheet_read_failure";
  const cutoverError = error instanceof ScpSheetDatasetEngineError
    ? error
    : null;
  return {
    errorCode: cutoverError?.code ?? "scp_sheet_read_failed",
    failureReason: cutoverError?.publicFailureReason ?? "google_sheet_read_failed",
    correlationIdHash: createHash("sha256")
      .update(`${key}\u0000${privateErrorText}`)
      .digest("hex")
      .slice(0, 24),
  };
}

function pageSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(Math.trunc(value), MAX_PAGE_SIZE));
}

function safeMessageSourceId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
  return normalized || "missing";
}

function messageSourceRef(messageRef: string) {
  if (/^message_sources\/[a-zA-Z0-9_-]{1,120}$/.test(messageRef)) {
    return adminDb.doc(messageRef);
  }
  return adminDb.collection("message_sources").doc(safeMessageSourceId(messageRef));
}

function sourceString(record: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = asString(record[key]);
  return value ? value.slice(0, maxLength) : undefined;
}

function maskEmail(value?: string): string | undefined {
  if (!value) return undefined;
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) => {
    const [local = "", domain = ""] = email.split("@");
    const prefix = local.slice(0, Math.min(2, local.length));
    return `${prefix || "*"}***@${domain}`;
  });
}

function rowString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value.trim() || fallback;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function rowNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function rowEnum(value: unknown, allowed: ReadonlySet<string>, fallback: string): string {
  const text = rowString(value);
  return allowed.has(text) ? text : fallback;
}

function normalizeCreatorRow(row: Record<string, unknown>): Record<string, unknown> {
  const id = rowString(row.id, "creator");
  const name = rowString(row.name, id);
  return {
    ...row,
    id,
    name,
    handle: rowString(row.handle),
    avatar: rowString(row.avatar, rowString(row.thumbnailUrl, rowString(row.thumbnail_url, name))),
    platform: rowString(row.platform, "YouTube"),
    region: rowString(row.region, "unknown"),
    category: rowString(row.category, "uncategorized"),
    type: rowString(row.type, "influencer"),
    stage: rowEnum(row.stage, CREATOR_STAGE_KEYS, "contact"),
    owner: rowString(row.owner, "미지정"),
    guideStatus: rowEnum(row.guideStatus, CREATOR_GUIDE_STATUS_KEYS, "within"),
    email: rowString(row.email),
    profileMatchedEmail: rowString(row.profileMatchedEmail),
    channelId: rowString(row.channelId),
    youtubeUrl: rowString(row.youtubeUrl),
    followers: rowNumber(row.followers),
    budgetKRW: rowNumber(row.budgetKRW),
  };
}

function rowIsoMillis(row: Record<string, unknown>, fields: readonly string[]): number {
  for (const field of fields) {
    const parsed = Date.parse(asString(row[field], ""));
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function sortConversationRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((left, right) => {
    const byTime = rowIsoMillis(right, ["lastMessageAtIso", "updatedAtIso", "createdAtIso"]) -
      rowIsoMillis(left, ["lastMessageAtIso", "updatedAtIso", "createdAtIso"]);
    return byTime || asString(left.id).localeCompare(asString(right.id));
  });
}

function missingValue(value: unknown): boolean {
  return typeof value === "string" ? !value.trim() : value === null || value === undefined;
}

function conversationFallback(
  creatorValue: unknown,
  conversationValue: unknown,
): unknown {
  return missingValue(creatorValue) ? conversationValue : creatorValue;
}

export interface CreatorReadExclusion {
  readonly id: string;
  readonly reason: string;
}

// 2026-09-28 owner scope decision (codex adversarial review round 2, finding #2): this join feeds
// the general "creators" dataset key/page, not a scp@ mailbox surface — out of the scp org-filter's
// scope (role-only, unchanged) per 헤세's decision that general SCP-program data stays role-gated.
async function joinCreatorConversationIdentity(
  rows: Record<string, unknown>[],
  excluded: CreatorReadExclusion[],
): Promise<Record<string, unknown>[]> {
  const ids = rows.map((row) => asString(row.id)).filter(Boolean);
  if (ids.length === 0) return rows;

  const conversations = new Map<string, Record<string, unknown>>();
  for (const idsChunk of chunk(ids, 200)) {
    const snapshots = await adminDb.getAll(
      ...idsChunk.map((id) => adminDb.collection("conversations").doc(id)),
    );
    for (const snapshot of snapshots) {
      if (snapshot.exists) conversations.set(snapshot.id, asRecord(snapshot.data()));
    }
  }

  return rows.flatMap((creator) => {
    const id = asString(creator.id);
    const conversation = conversations.get(id);
    // U7 P5: 대화가 있는 행만 정본 해석기를 태우던 게이트를 없앤다. 대화가 없는 크리에이터도
    // 이름/핸들/프로필 이미지는 같은 해석기(resolveCreatorDisplayIdentity ·
    // creatorProfileImageSourceInputs → resolveProfileImageProjection)로 풀어 투영해야 화면마다
    // 즉석 폴백 체인을 다시 만들지 않는다(관리 상세 아바타 유실의 근인).
    const identity = resolveCreatorDisplayIdentity(creator, id, conversation);
    // 사내 계정과 주고받은 대화에서 파생된 행은 크리에이터가 아니다 — 관리 모수에서 뺀다.
    // 대화 파생(conv_*)에만 적용해서, 의도적으로 유지되는 사내 테스트 레코드(rc-hesse)는 남긴다.
    if (
      conversation
      && id.startsWith(CONVERSATION_DERIVED_CREATOR_PREFIX)
      && (isInternalIdentityEmail(identity.emailOnly)
        || isInternalIdentityEmail(conversation.creatorEmail)
        || isInternalIdentityEmail(conversation.creatorName))
    ) {
      // 조용히 지우지 않는다. 왜 빠졌는지 사유와 함께 세어 두고 응답에 실어 보낸다 —
      // 목록 건수와 KPI 가 말없이 어긋나는 것을 막는다.
      excluded.push({ id, reason: "internal_sender_conversation_derived" });
      return [];
    }
    // 이미지도 정본 해석기 한 벌로. 참조 구현은 videoReviewStateCallables 의 검수 행 투영이다.
    const projectedProfileImageUrl = resolveProfileImageProjection(
      creatorProfileImageSourceInputs(creator),
      identity.displayName,
      typeof creator.profileImageRevision === "number" ? creator.profileImageRevision : 0,
      asString(creator.profileImageVerifiedAt) || undefined,
    ).url ?? "";
    // F7(b): 정본 해석기는 이름 후보가 전무하면 raw fluCreatorId 로 폴백한다(다른 소비처가 그 계약에
    // 의존한다). 목록 표면에서는 opaque id 를 사람 이름 자리에 넣지 않는다 — B2 행과 같은 결로
    // "이름 미확인" 을 쓴다. 원본 id 는 행의 `id` 필드에 그대로 있다.
    const listDisplayName = identity.displayName && identity.displayName !== id
      ? identity.displayName
      : "이름 미확인";
    return [{
      ...creator,
      name: listDisplayName,
      displayName: listDisplayName,
      handle: identity.handle ?? "",
      // 이름으로 승격하지 않은 이메일은 버리지 않고 이메일 자리에 남긴다.
      email: conversationFallback(
        creator.email,
        conversationFallback(conversation?.creatorEmail, identity.emailOnly ?? ""),
      ),
      // 해석기가 고른 이미지가 있으면 그것이 정본이고, 없으면 기존 폴백 순서를 그대로 둔다.
      profileImageUrl: projectedProfileImageUrl || asString(creator.profileImageUrl),
      avatar: projectedProfileImageUrl
        || conversationFallback(creator.avatar, conversation?.creatorAvatar),
      platform: conversationFallback(creator.platform, conversation?.creatorPlatform),
      followers: conversationFallback(creator.followers, conversation?.creatorFollowers),
      youtubeUrl: conversationFallback(creator.youtubeUrl, conversation?.youtubeUrl),
      recentViews: conversationFallback(creator.recentViews, conversation?.creatorRecentViews),
      engagementPct: conversationFallback(creator.engagementPct, conversation?.creatorEngagementPct),
    }];
  });
}

// 프로그램 신청 행의 표시 신원 정규화.
//
// 운영 실측(2026-07-26): program_applications 4건 중 1건(operator-reviewed-pilot-*)에는
// name·avatar 필드 자체가 없다. 화면은 `app.avatar || app.name.slice(0, 1)` 로 이니셜을
// 만들기 때문에 그 한 행이 프로그램 화면을 "Cannot read properties of undefined
// (reading 'slice')" 로 무너뜨렸다(신청자 목록 1회 + 퍼널 인원 1회 = 실측 2회).
//
// 여기서 이름을 지어내지는 않는다. 붙는 신원(채널명·핸들·이메일)이 하나도 없으면
// "이름 미확인" 으로 남긴다 — 문자열이라는 사실만 보장한다.
export const PROGRAM_APPLICATION_NAME_UNRESOLVED = "이름 미확인";

function normalizeProgramApplicationRow(row: Record<string, unknown>): Record<string, unknown> {
  const applicant = asRecord(row.applicant);
  const name = rowString(row.name)
    || rowString(row.channelName)
    || rowString(applicant.name)
    || rowString(applicant.channelName)
    || rowString(row.creatorName)
    || rowString(row.handle)
    || rowString(row.email)
    || PROGRAM_APPLICATION_NAME_UNRESOLVED;
  return {
    ...row,
    name,
    avatar: rowString(row.avatar, rowString(row.thumbnailUrl, rowString(applicant.avatar))),
  };
}

async function normalizeRowsForKey(
  key: DatasetKey,
  rows: Record<string, unknown>[],
  excluded: CreatorReadExclusion[] = [],
): Promise<Record<string, unknown>[]> {
  if (key === "creators") {
    // 담당자는 읽기 시점 조인으로만 해석한다(복사 금지). members 색인은 사내 인원 수만큼
    // (운영 실측 14문서) 읽고 프로세스 안에서 30초 재사용하므로, 크리에이터 페이지를 넘겨도
    // 페이지마다 members 를 다시 읽지 않는다.
    const [joined, ownerIndex] = await Promise.all([
      joinCreatorConversationIdentity(rows, excluded),
      loadOwnerDisplayIndex(),
    ]);
    return joined.map(normalizeCreatorRow).map((creator) => ({
      ...creator,
      ownerDisplayName: resolveOwnerDisplayForRecord(creator, ownerIndex),
    }));
  }
  if (key === "programApplications") return rows.map(normalizeProgramApplicationRow);
  if (key === "videos") return rows.map((video) => ({ videoId: video.id, ...video }));
  if (key === "conversations") {
    // W128: 허용목록 밖으로 빠진 키는 **건수만** 남긴다. 키 이름 자체가 스키마 정보라 로그에 싣지 않는다
    // (SEC-P0-009). 건수가 갑자기 뛰면 업스트림이 새 필드를 쓰기 시작했다는 신호다.
    const dropStats: ConversationProjectionDropStats = { records: 0, droppedKeys: 0 };
    const projected = rows.map((row) => projectConversationRecordForClient(row, dropStats));
    if (dropStats.droppedKeys > 0) {
      console.info(JSON.stringify({
        event: "conversations.projection.allowlist",
        records: dropStats.records,
        droppedKeys: dropStats.droppedKeys,
      }));
    }
    return sortConversationRows(projected);
  }
  return rows;
}

function validQualificationDecisionRef(value: unknown): string {
  const ref = asString(value);
  return /^qualification_decisions\/[A-Za-z0-9._:-]{1,220}$/.test(ref) ? ref : "";
}

const QUALIFICATION_POLICY_HASH_PATTERN = /^[a-f0-9]{64}$/;

type QualificationHydrationScope = {
  leadId: string;
  leadRef: string;
  canonicalProgramId: string;
  applicationId: string;
  applicationRef: string;
  qualificationPolicyHash: string;
  qualificationAssessmentRef: string;
  exactCanonicalScpEvidence: boolean;
  legacyScpProjection: boolean;
};

type ExactDocumentIdentity = {
  id: string;
  ref: string;
  valid: boolean;
};

function exactDocumentIdentity(
  directValue: unknown,
  refValue: unknown,
  collection: string,
): ExactDocumentIdentity {
  const directId = asString(directValue);
  const ref = asString(refValue);
  const match = ref.match(new RegExp(`^${collection}\\/([A-Za-z0-9._:-]{1,220})$`));
  if (ref && !match) return { id: "", ref, valid: false };
  const refId = match?.[1] ?? "";
  if (directId.includes("/") || (directId && refId && directId !== refId)) {
    return { id: "", ref, valid: false };
  }
  const id = directId || refId;
  return { id, ref: ref || (id ? `${collection}/${id}` : ""), valid: true };
}

function exactCanonicalProgramIdentity(record: Record<string, unknown>): {
  canonicalProgramId: string;
  exactCanonicalField: boolean;
  refs: string[];
  valid: boolean;
} {
  const declaredCanonicalProgramId = asString(record.canonicalProgramId);
  const declaredProgramId = asString(record.programId);
  const rawRefs = Array.from(new Set([
    asString(record.programRef),
    asString(record.qualificationProgramRef),
  ].filter(Boolean)));
  const refIds: string[] = [];
  for (const ref of rawRefs) {
    const match = ref.match(/^programs\/([A-Za-z0-9._:-]{1,220})$/);
    if (!match) {
      return {
        canonicalProgramId: "",
        exactCanonicalField: false,
        refs: rawRefs,
        valid: false,
      };
    }
    refIds.push(match[1]);
  }
  const canonicalCandidates = [declaredCanonicalProgramId, declaredProgramId, ...refIds]
    .filter(Boolean)
    .map((value) => resolveCanonicalProgramId(value));
  const distinct = Array.from(new Set(canonicalCandidates));
  if (distinct.length !== 1) {
    return {
      canonicalProgramId: "",
      exactCanonicalField: false,
      refs: rawRefs,
      valid: false,
    };
  }
  const canonicalProgramId = distinct[0];
  return {
    canonicalProgramId,
    exactCanonicalField: declaredCanonicalProgramId === canonicalProgramId,
    refs: rawRefs,
    valid: Boolean(canonicalProgramId),
  };
}

function exactQualificationPolicyHash(value: unknown): { value: string; valid: boolean } {
  const normalized = asString(value).toLowerCase();
  if (!normalized) return { value: "", valid: true };
  return QUALIFICATION_POLICY_HASH_PATTERN.test(normalized)
    ? { value: normalized, valid: true }
    : { value: "", valid: false };
}

function qualificationHydrationScope(row: Record<string, unknown>): QualificationHydrationScope | null {
  const lead = exactDocumentIdentity(row.leadId || row.id, row.leadRef, "program_sheet_leads");
  const rowId = asString(row.id);
  if (!lead.valid || !lead.id || (rowId && rowId !== lead.id)) return null;

  const program = exactCanonicalProgramIdentity(row);
  const application = exactDocumentIdentity(row.applicationId, row.applicationRef, "program_applications");
  const policyHash = exactQualificationPolicyHash(row.qualificationPolicyHash);
  const assessment = exactDocumentIdentity(
    row.qualificationAssessmentId,
    row.qualificationAssessmentRef,
    "program_qualification_assessments",
  );
  if (!program.valid || !application.valid || !policyHash.valid || !assessment.valid) return null;

  const exactCanonicalScpEvidence =
    program.canonicalProgramId === SCP_CANONICAL_PROGRAM_ID &&
    program.exactCanonicalField;
  const legacyScpProjection =
    exactCanonicalScpEvidence &&
    !application.id &&
    !policyHash.value &&
    !assessment.id;
  // Non-SCP rows have no safe compatibility mirror. Both application and policy
  // identities are mandatory before a global lead can hydrate a program verdict.
  if (
    program.canonicalProgramId !== SCP_CANONICAL_PROGRAM_ID &&
    (!application.id || !policyHash.value || !assessment.id)
  ) {
    return null;
  }
  // A current SCP projection is scoped by the same assessment receipt as every
  // other program. Only the pre-scope explicit SCP mirror may omit it.
  if (
    program.canonicalProgramId === SCP_CANONICAL_PROGRAM_ID &&
    !legacyScpProjection &&
    (!policyHash.value || !assessment.id)
  ) {
    return null;
  }

  return {
    leadId: lead.id,
    leadRef: lead.ref,
    canonicalProgramId: program.canonicalProgramId,
    applicationId: application.id,
    applicationRef: application.ref,
    qualificationPolicyHash: policyHash.value,
    qualificationAssessmentRef: assessment.ref,
    exactCanonicalScpEvidence,
    legacyScpProjection,
  };
}

function qualificationDecisionMatchesHydrationScope(
  decision: Record<string, unknown>,
  scope: QualificationHydrationScope,
  allowExplicitLegacyScp: boolean,
): boolean {
  const lead = exactDocumentIdentity(decision.leadId, decision.leadRef, "program_sheet_leads");
  if (!lead.valid || lead.id !== scope.leadId || lead.ref !== scope.leadRef) return false;

  const program = exactCanonicalProgramIdentity(decision);
  const legacyScpProgram =
    !program.valid &&
    !asString(decision.canonicalProgramId) &&
    !asString(decision.programId) &&
    allowExplicitLegacyScp &&
    scope.exactCanonicalScpEvidence &&
    scope.legacyScpProjection;
  if (!legacyScpProgram && (!program.valid || program.canonicalProgramId !== scope.canonicalProgramId)) {
    return false;
  }
  const explicitLegacyScpCompatibility =
    allowExplicitLegacyScp &&
    scope.exactCanonicalScpEvidence &&
    scope.legacyScpProjection;
  const currentScope = Boolean(
    scope.applicationId ||
    scope.qualificationPolicyHash ||
    scope.qualificationAssessmentRef,
  );
  if (currentScope && program.refs.length === 0) return false;

  const application = exactDocumentIdentity(
    decision.applicationId,
    decision.applicationRef,
    "program_applications",
  );
  if (!application.valid || application.id !== scope.applicationId) return false;
  if (scope.applicationId && application.ref !== scope.applicationRef) return false;

  const policyHash = exactQualificationPolicyHash(decision.qualificationPolicyHash);
  if (!policyHash.valid) return false;
  const legacyScpPolicy =
    !policyHash.value &&
    allowExplicitLegacyScp &&
    scope.exactCanonicalScpEvidence &&
    scope.legacyScpProjection &&
    !scope.qualificationPolicyHash;
  if (!legacyScpPolicy && policyHash.value !== scope.qualificationPolicyHash) return false;

  const assessment = exactDocumentIdentity(
    decision.qualificationAssessmentId,
    decision.assessmentRef,
    "program_qualification_assessments",
  );
  if (!assessment.valid) return false;
  if (scope.qualificationAssessmentRef) {
    if (!assessment.id || assessment.ref !== scope.qualificationAssessmentRef) return false;
  } else if (assessment.id || !explicitLegacyScpCompatibility) return false;
  return true;
}

function qualificationDecisionRecommendation(
  decision: Record<string, unknown>,
  decisionRef: string,
): Record<string, unknown> | null {
  const raw = asRecord(decision.aiRecommendation);
  const verdict = asString(raw.verdict);
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "hold") return null;
  return {
    ...raw,
    verdict,
    decisionRef,
    source: "ledger",
    generatedAtIso:
      asString(raw.generatedAtIso) ||
      asString(decision.decidedAtIso) ||
      asString(decision.updatedAtIso) ||
      asString(decision.createdAtIso),
  };
}

async function latestQualificationDecisionForLead(row: Record<string, unknown>): Promise<{ ref: string; data: Record<string, unknown> } | null> {
  const scope = qualificationHydrationScope(row);
  if (!scope) return null;

  const explicitRef = validQualificationDecisionRef(row.latestDecisionRef);
  if (explicitRef) {
    const snap = await adminDb.doc(explicitRef).get().catch(() => null);
    const data = snap?.exists ? snap.data() ?? {} : null;
    if (data && qualificationDecisionMatchesHydrationScope(data, scope, true)) {
      return { ref: explicitRef, data };
    }
  }

  // Read every decision for this one lead, then filter by all scope dimensions in
  // memory. A lead-only order/limit can otherwise hide an older program-A verdict
  // behind a newer program-B verdict, which is the cross-program leakage this
  // hydration path must never reintroduce.
  const snap = await adminDb.collection("qualification_decisions")
    .where("leadId", "==", scope.leadId)
    .get()
    .catch(() => null);
  const latest = (snap?.docs ?? [])
    .filter((item) => qualificationDecisionMatchesHydrationScope(item.data(), scope, false))
    .map((item) => ({ item, time: rowIsoMillis(item.data(), ["decidedAtIso", "updatedAtIso", "createdAtIso"]) }))
    .sort((left, right) => right.time - left.time || left.item.ref.path.localeCompare(right.item.ref.path))[0]?.item;
  return latest ? { ref: latest.ref.path, data: latest.data() } : null;
}

function withoutUnverifiedQualificationProjection(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const hasDecisionProjection =
    Boolean(asString(row.latestDecisionRef)) ||
    Boolean(asString(asRecord(row.latestAiRecommendation).verdict));
  if (!hasDecisionProjection) return row;
  const safeRow = { ...row };
  delete safeRow.latestDecisionRef;
  delete safeRow.latestAiRecommendation;
  delete safeRow.qualificationLastDecidedAtIso;
  delete safeRow.qualificationFinalReason;
  return { ...safeRow, qualificationStatus: "unreviewed" };
}

async function hydrateProgramSheetLeadRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return rows;
  const hydrated = await Promise.all(rows.map(async (row) => {
    const decision = await latestQualificationDecisionForLead(row);
    if (!decision) return withoutUnverifiedQualificationProjection(row);
    const latestAiRecommendation = qualificationDecisionRecommendation(decision.data, decision.ref);
    if (!latestAiRecommendation) return withoutUnverifiedQualificationProjection(row);
    return {
      ...row,
      latestDecisionRef: decision.ref,
      latestAiRecommendation,
      qualificationLastDecidedAtIso:
        asString(decision.data.decidedAtIso) ||
        asString(decision.data.updatedAtIso) ||
        asString(decision.data.createdAtIso) ||
        asString(row.qualificationLastDecidedAtIso),
      qualificationFinalReason:
        asString(decision.data.finalReason) ||
        asString(decision.data.reason) ||
        asString(row.qualificationFinalReason),
      qualificationStatus:
        asString(decision.data.finalVerdict) ||
        asString(row.qualificationStatus),
    };
  }));
  return hydrated;
}

function uniqueStrings(values: unknown, max = 20): string[] {
  const source = Array.isArray(values) ? values : typeof values === "string" ? [values] : [];
  const out: string[] = [];
  for (const value of source) {
    const text = asString(value);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

const LIST_PROGRAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,139}$/;
const MAX_CANONICAL_QUERY_PROGRAM_IDS = 15;

async function readConfirmedProgramAliasMap(): Promise<Record<string, string>> {
  return (await readConfirmedProgramAliasRegistryState()).aliasMap;
}

function canonicalProgramScopeForListRequest(
  value: unknown,
  aliasMap: Record<string, string> = {},
  maxQueryProgramIds = MAX_CANONICAL_QUERY_PROGRAM_IDS,
): CanonicalProgramScope | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw Object.assign(new Error("invalid-argument: programId must be a string"), { code: "invalid-argument", errorCode: "canonical_program_scope_for_list_request_program_id_must_be_string" });
  }
  const requestedProgramId = asString(value);
  if (!requestedProgramId) {
    throw Object.assign(new Error("invalid-argument: programId must not be blank"), { code: "invalid-argument", errorCode: "canonical_program_scope_for_list_request_program_id_must_be_blank" });
  }
  if (!LIST_PROGRAM_ID_PATTERN.test(requestedProgramId)) {
    throw Object.assign(new Error("invalid-argument: programId is invalid"), { code: "invalid-argument", errorCode: "canonical_program_scope_for_list_request_program_id_invalid" });
  }
  const canonicalProgramId = resolveCanonicalProgramId(requestedProgramId, aliasMap);
  if (!canonicalProgramId || !LIST_PROGRAM_ID_PATTERN.test(canonicalProgramId)) {
    throw Object.assign(new Error("invalid-argument: programId is not canonicalizable"), { code: "invalid-argument", errorCode: "canonical_program_scope_for_list_request_program_id_canonicalizable" });
  }
  const queryProgramIds = confirmedProgramIdentitySet(canonicalProgramId, aliasMap, maxQueryProgramIds);
  return {
    canonicalProgramId,
    queryProgramIds,
    aliasMap,
  };
}

function canonicalProgramQueryIdentityLimit(
  _auth: ReturnType<typeof assertNonGuestAuth>,
  _key: DatasetKey,
): number {
  // Shared reads do not add an owner branch. canonicalProgramId/programId still
  // contributes two OR branches, so keep the Firestore DNF query below 30.
  return Math.floor(30 / 2);
}

async function communityListScope(
  auth: ReturnType<typeof assertNonGuestAuth>,
  requestData: Record<string, unknown>,
): Promise<{ canonicalProgramId: string; campaignId: string; systemGlobal: boolean }> {
  const rawProgramId = requestData.programId;
  const campaignId = asString(requestData.campaignId);
  const hasProgram = rawProgramId !== undefined && Boolean(asString(rawProgramId));
  const hasCampaign = Boolean(campaignId);
  if (!hasProgram && !hasCampaign) {
    return {
      canonicalProgramId: COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
      campaignId: COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
      systemGlobal: true,
    };
  }
  if (!hasProgram || !hasCampaign) {
    const error = new Error("invalid-argument: community posts require exact programId and campaignId scope");
    Object.assign(error, { code: "invalid-argument", errorCode: "community_list_scope_community_posts_require_exact_program", behaviorLog: makeBehaviorLog(auth, "data.communityPosts.list", "error") });
    throw error;
  }
  const rawProgramIdValue = asString(rawProgramId);
  const requestsGlobalScope = rawProgramIdValue === COMMUNITY_DISCOVERY_GLOBAL_SCOPE
    || campaignId === COMMUNITY_DISCOVERY_GLOBAL_SCOPE;
  if (requestsGlobalScope) {
    if (
      rawProgramIdValue !== COMMUNITY_DISCOVERY_GLOBAL_SCOPE
      || campaignId !== COMMUNITY_DISCOVERY_GLOBAL_SCOPE
    ) {
      const error = new Error("invalid-argument: system community scope requires both global programId and campaignId");
      Object.assign(error, { code: "invalid-argument", errorCode: "community_list_scope_system_community_scope_requires_both", behaviorLog: makeBehaviorLog(auth, "data.communityPosts.list", "error") });
      throw error;
    }
    return {
      canonicalProgramId: COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
      campaignId: COMMUNITY_DISCOVERY_GLOBAL_SCOPE,
      systemGlobal: true,
    };
  }
  if (!LIST_PROGRAM_ID_PATTERN.test(campaignId)) {
    const error = new Error("invalid-argument: campaignId is invalid");
    Object.assign(error, { code: "invalid-argument", errorCode: "community_list_scope_campaign_id_invalid", behaviorLog: makeBehaviorLog(auth, "data.communityPosts.list", "error") });
    throw error;
  }
  const programScope = canonicalProgramScopeForListRequest(rawProgramId, await readConfirmedProgramAliasMap());
  if (!programScope) {
    const error = new Error("invalid-argument: programId is required");
    Object.assign(error, { code: "invalid-argument", errorCode: "community_list_scope_program_id_required", behaviorLog: makeBehaviorLog(auth, "data.communityPosts.list", "error") });
    throw error;
  }
  const campaignSnapshot = await adminDb.collection("campaigns").doc(campaignId).get();
  if (!campaignSnapshot.exists) {
    const error = new Error("failed-precondition: community campaign not found");
    Object.assign(error, { code: "failed-precondition", errorCode: "community_list_scope_community_campaign_found", behaviorLog: makeBehaviorLog(auth, "data.communityPosts.list", "error") });
    throw error;
  }
  const campaign: Record<string, unknown> = { id: campaignSnapshot.id, ...(campaignSnapshot.data() ?? {}) };
  const campaignProgramIds = Array.from(new Set([
    resolveCanonicalProgramId(campaign.canonicalProgramId, programScope.aliasMap),
    resolveCanonicalProgramId(campaign.programId, programScope.aliasMap),
  ].filter(Boolean)));
  if (campaignProgramIds.length !== 1 || campaignProgramIds[0] !== programScope.canonicalProgramId) {
    const error = new Error("failed-precondition: campaign does not belong to the requested program");
    Object.assign(error, { code: "failed-precondition", errorCode: "community_list_scope_campaign_belong_requested_program", behaviorLog: makeBehaviorLog(auth, "data.communityPosts.list", "error") });
    throw error;
  }
  return { canonicalProgramId: programScope.canonicalProgramId, campaignId, systemGlobal: false };
}

function rowMatchesCanonicalProgramScope(
  row: Record<string, unknown>,
  scope: CanonicalProgramScope | null,
): boolean {
  if (!scope) return true;
  const declaredCanonicalProgramId = resolveCanonicalProgramId(row.canonicalProgramId, scope.aliasMap);
  const declaredProgramId = resolveCanonicalProgramId(row.programId, scope.aliasMap);
  if (
    declaredCanonicalProgramId &&
    declaredProgramId &&
    declaredCanonicalProgramId !== declaredProgramId
  ) {
    return false;
  }
  return (declaredCanonicalProgramId || declaredProgramId) === scope.canonicalProgramId;
}

function applyCanonicalProgramScopeQuery(query: Query, scope: CanonicalProgramScope | null): Query {
  if (!scope) return query;
  const canonicalProgramIdFilter = scope.queryProgramIds.length === 1
    ? Filter.where("canonicalProgramId", "==", scope.queryProgramIds[0])
    : Filter.where("canonicalProgramId", "in", scope.queryProgramIds);
  const programIdFilter = scope.queryProgramIds.length === 1
    ? Filter.where("programId", "==", scope.queryProgramIds[0])
    : Filter.where("programId", "in", scope.queryProgramIds);
  return query.where(Filter.or(
    canonicalProgramIdFilter,
    programIdFilter,
  ));
}

function hasTargetFilters(data: Record<string, unknown>): boolean {
  return ["ids", "creatorIds", "channelIds", "handles", "emails"].some((key) => uniqueStrings(data[key]).length > 0);
}

function chunk<T>(values: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size) groups.push(values.slice(index, index + size));
  return groups;
}

function dedupeById(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const deduped: Record<string, unknown>[] = [];
  for (const row of rows) {
    const id = asString(row.id);
    const key = id || JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function sortTargetRows(key: DatasetKey, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const timeFor = (row: Record<string, unknown>) => {
    const value = key === "creatorComments"
      ? asString(row.time) || asString(row.updatedAtIso)
      : asString(row.publishedAtIso) || asString(row.publishedIso) || asString(row.published) || asString(row.updatedAtIso);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  if (key === "videos" || key === "creatorComments") {
    return [...rows].sort((left, right) => timeFor(right) - timeFor(left) || asString(left.id).localeCompare(asString(right.id)));
  }
  return rows;
}

function targetOrderForKey(key: DatasetKey): CollectionOrder {
  if (key === "videos") return { field: "published", direction: "desc" };
  if (key === "creatorComments") return { field: "time", direction: "desc" };
  return {};
}

async function readTargetedRows(
  key: DatasetKey,
  collection: string,
  fields: Record<string, string[]>,
  limit: number,
  auth?: ReturnType<typeof assertNonGuestAuth>,
  programScope: CanonicalProgramScope | null = null,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const col = adminDb.collection(collection);
  const ids = fields.id ?? [];
  await Promise.all(ids.map(async (id) => {
    const snap = await col.doc(id).get();
    if (snap.exists) rows.push({ ...snap.data(), id: snap.id });
  }));

  const fieldEntries = Object.entries(fields).filter(([field, values]) => field !== "id" && values.length > 0);
  const order = targetOrderForKey(key);
  for (const [field, values] of fieldEntries) {
    for (const group of chunk(values, 10)) {
      let query: Query = col.where(field, "in", group);
      if (order.field) query = query.orderBy(order.field, order.direction ?? "desc").orderBy(FieldPath.documentId());
      const snap = await query.limit(limit).get();
      rows.push(...snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
    }
  }
  return dedupeById(rows).filter((row) =>
    !isSoftHidden(row)
    && !isMockHidden(row, collection)
    && rowMatchesCanonicalProgramScope(row, programScope));
}

function isSoftHidden(row: Record<string, unknown>): boolean {
  return Boolean(row.deletedAt || row.archivedAt || row.deletedAtIso || row.archivedAtIso);
}

// W41: 보관 해제 대상을 화면에서 고를 수 있어야 "되돌릴 수 있는 보관"이 성립한다. 삭제 표식은
// 어떤 경우에도 열지 않고, **보관 표식만** 가진 행에 한해 campaigns 데이터셋 + 관리자 역할에서만
// 순수 opt-in 으로 열어준다(옵션이 없으면 종전과 100% 동일하게 숨는다).
const ARCHIVED_VISIBLE_ROLES = new Set(["super_admin", "admin"]);
function isArchivedOnlyRow(row: Record<string, unknown>): boolean {
  return Boolean(row.archivedAt || row.archivedAtIso) && !row.deletedAt && !row.deletedAtIso;
}

function firebaseConfigProjectId(): string | undefined {
  const raw = process.env.FIREBASE_CONFIG;
  if (!raw) return undefined;
  try {
    return asString(asRecord(JSON.parse(raw)).projectId);
  } catch {
    return undefined;
  }
}

function isDemoProjectRuntime(): boolean {
  const projectId =
    process.env.GCLOUD_PROJECT ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.GCP_PROJECT ??
    firebaseConfigProjectId();
  return projectId === "demo-flu";
}

function isEmulatorRuntime(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true" || Boolean(process.env.FIRESTORE_EMULATOR_HOST) || isDemoProjectRuntime();
}

function isMockHidden(row: Record<string, unknown>, collection = ""): boolean {
  return !isEmulatorRuntime() && isOperationalFixtureRecord(row, collection);
}

// Exported (casebook inbox 2026-10-01, AGG lane) so functions/chatAutoCasebookUnclassified.ts can
// resume the unreplied-inbox scanner from the last row it actually consumed with the same codec.
export function encodePageCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

// Exported (2026-09-29 casebook pending precompute round 3 adversarial review) so
// functions/chatAutoCasebookPendingPrecompute.ts's scanOnce can resume scanUnrepliedInboxForScope
// across multiple internal calls in a single tick using the SAME cursor codec
// listUnrepliedInboxHandler already trusts for its own HTTP-request-to-HTTP-request pagination —
// see that module's doc comment for why one call's own internal candidate cap can no longer be the
// only thing standing between a starved org and a false zero.
export function decodePageCursor(value: unknown): PageCursor | null {
  const raw = asString(value);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    const record = asRecord(parsed);
    const docId = asString(record.docId);
    if (!docId) return null;
    return {
      docId,
      orderValue: record.orderValue,
      fallback: record.fallback === true,
      ...(asString(record.scopeKey) ? { scopeKey: asString(record.scopeKey) } : {}),
    };
  } catch {
    return null;
  }
}

function cursorForDoc(doc: QueryDocumentSnapshot, order: CollectionOrder, scopeKey?: string): PageCursor {
  return {
    docId: doc.id,
    ...(order.field ? { orderValue: doc.get(order.field) ?? null } : {}),
    ...(scopeKey ? { scopeKey } : {}),
  };
}

function cursorByKey(data: Record<string, unknown>, key: DatasetKey, loadedKeys: DatasetKey[]): string | undefined {
  const cursors = asRecord(data.cursors);
  const keyCursor = asString(cursors[key]);
  if (keyCursor) return keyCursor;
  const singleCursor = asString(data.cursor);
  return loadedKeys.length === 1 ? singleCursor || undefined : undefined;
}

function collectionOrderForKey(key: DatasetKey): CollectionOrder {
  if (key === "videos") return { field: "published", direction: "desc" };
  if (key === "creatorCommentInsights") return { field: "updatedAtIso", direction: "desc" };
  if (key === "communityPosts") return { field: "createdAtIso", direction: "desc" };
  if (key === "knowledgeNodes" || key === "knowledgeEdges") return { field: "createdAtIso", direction: "desc" };
  if (key === "conversations") return { field: "lastMessageAtIso", direction: "desc" };
  if (key === "scpLifecycleProfiles") return { field: "stateEnteredAt", direction: "desc" };
  // S12 A5: 이전엔 order 없음(문서 순서 임의) — 두 정본 writer(aiHubReport.persistLlmUsageLocal,
  // admin.recordLlmUsage)가 모두 updatedAtIso를 쓰므로 최신순 정렬이 안전하다.
  if (key === "llmUsage") return { field: "updatedAtIso", direction: "desc" };
  if (
    key === "creators" ||
    key === "campaigns" ||
    key === "candidatePool" ||
    key === "submissions" ||
    key === "programs" ||
    key === "programApplications" ||
    key === "programSheetLeads" ||
    key === "scpQualificationRows" ||
    key === "creatorLinks"
  ) {
    return { field: "updatedAtIso", direction: "desc" };
  }
  return {};
}

// S12 A5: llm_usage에는 스키마가 다른 과거 writer(chat-ai.ts rollup 등) 문서가 섞여 있을 수 있다.
// calls/tokensK/costKRW가 없거나 비유한(non-finite)이면 클라 reduce 합산이 NaN으로 전파되어 대시보드
// 총계 전체가 깨진다(하나의 이질 문서가 전체를 오염) — 0으로 방어해 합산이 항상 유한하게 유지되게 한다.
function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const LLM_USAGE_SCHEMA_VERSION = "llm-usage-v2";

function normalizeLlmUsageRow(row: Record<string, unknown>): Record<string, unknown> {
  const provider = normalizeLlmProvider(row.provider);
  const claimedTransport = normalizeLlmUsageTransport(row.transport);
  const expectedIdentity = llmUsageAggregationIdentity({
    modelId: asString(row.model),
    tier: asString(row.tier),
    provider,
    transport: claimedTransport,
  });
  const schemaVerified = row.schemaVersion === LLM_USAGE_SCHEMA_VERSION
    && row.aggregationIdentity === expectedIdentity;
  return {
    ...row,
    schemaVersion: schemaVerified ? LLM_USAGE_SCHEMA_VERSION : "legacy-unverified",
    aggregationIdentity: schemaVerified ? expectedIdentity : `legacy-unverified:${asString(row.id) || "row"}`,
    provider,
    transport: schemaVerified ? normalizeLlmUsageTransport(row.transport) : "unverified",
    calls: finiteOrZero(row.calls),
    tokensK: finiteOrZero(row.tokensK),
    costKRW: finiteOrZero(row.costKRW),
  };
}

function shouldRetryQueryWithoutCompositeIndex(error: unknown, order: CollectionOrder): boolean {
  if (!order.field) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (/requires an index|index is currently building/i.test(message)) return true;
  // Firestore surfaces missing-index errors as FAILED_PRECONDITION (gRPC code 9);
  // message wording is not guaranteed, so degrade safely on the code as well
  // instead of throwing and blanking the dataset.
  const code = (error as { code?: unknown } | null)?.code;
  return code === 9 || code === "failed-precondition" || /failed.precondition/i.test(message);
}

const COMPLETED_DISCOVERY_RUN_STATUSES = new Set(["complete", "partial"]);
export const COMMUNITY_PUBLICATION_CONTRACT_VERSION = "community-publication-generation/v1";

export function communityPublicationPointerId(scope: { canonicalProgramId: string; campaignId: string }): string {
  const canonicalJson = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (!value || typeof value !== "object") return JSON.stringify(value) ?? "null";
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  };
  return `community_pointer_${createHash("sha256").update(canonicalJson({
    contractVersion: COMMUNITY_PUBLICATION_CONTRACT_VERSION,
    canonicalProgramId: scope.canonicalProgramId,
    campaignId: scope.campaignId,
  })).digest("hex").slice(0, 40)}`;
}

export async function activeCommunityPublicationGeneration(
  scope: { canonicalProgramId: string; campaignId: string; systemGlobal?: boolean },
): Promise<string | null> {
  const pointerRef = adminDb.collection("community_publication_heads").doc(communityPublicationPointerId(scope));
  const pointer = await pointerRef.get();
  const row = pointer.data() ?? {};
  const generationId = asString(row.activeGenerationId);
  const generationRef = asString(row.activeGenerationRef);
  const sourceRunId = asString(row.activeSourceRunId);
  const systemGlobal = scope.systemGlobal === true || (
    scope.canonicalProgramId === COMMUNITY_DISCOVERY_GLOBAL_SCOPE
    && scope.campaignId === COMMUNITY_DISCOVERY_GLOBAL_SCOPE
  );
  const pointerScopeMatches = systemGlobal
    ? asString(row.canonicalProgramId) === COMMUNITY_DISCOVERY_GLOBAL_SCOPE
      && asString(row.campaignId) === COMMUNITY_DISCOVERY_GLOBAL_SCOPE
      && !asString(row.programRef)
      && !asString(row.campaignRef)
    : resolveCanonicalProgramId(row.canonicalProgramId) === scope.canonicalProgramId
      && asString(row.campaignId) === scope.campaignId
      && asString(row.programRef) === `programs/${scope.canonicalProgramId}`
      && asString(row.campaignRef) === `campaigns/${scope.campaignId}`;
  if (
    !pointer.exists
    || asString(row.contractVersion) !== COMMUNITY_PUBLICATION_CONTRACT_VERSION
    || asString(row.status) !== "active"
    || !pointerScopeMatches
    || !/^community_generation_[a-f0-9]{48}$/.test(generationId)
    || generationRef !== `community_publication_generations/${generationId}`
    || !sourceRunId
    || asString(row.activeSourceRunRef) !== `discovery_runs/${sourceRunId}`
    || !COMPLETED_DISCOVERY_RUN_STATUSES.has(asString(row.activeSourceRunStatus))
  ) return null;
  const generation = await adminDb.doc(generationRef).get();
  const generationRow = generation.data() ?? {};
  const generationScopeMatches = systemGlobal
    ? asString(generationRow.canonicalProgramId) === COMMUNITY_DISCOVERY_GLOBAL_SCOPE
      && asString(generationRow.campaignId) === COMMUNITY_DISCOVERY_GLOBAL_SCOPE
      && !asString(generationRow.programRef)
      && !asString(generationRow.campaignRef)
    : resolveCanonicalProgramId(generationRow.canonicalProgramId) === scope.canonicalProgramId
      && asString(generationRow.campaignId) === scope.campaignId
      && asString(generationRow.programRef) === `programs/${scope.canonicalProgramId}`
      && asString(generationRow.campaignRef) === `campaigns/${scope.campaignId}`;
  if (
    !generation.exists
    || asString(generationRow.contractVersion) !== COMMUNITY_PUBLICATION_CONTRACT_VERSION
    || asString(generationRow.status) !== "active"
    || !generationScopeMatches
    || asString(generationRow.generationRef) !== generationRef
    || asString(generationRow.sourceRunId) !== sourceRunId
    || asString(generationRow.sourceRunRef) !== `discovery_runs/${sourceRunId}`
    || !COMPLETED_DISCOVERY_RUN_STATUSES.has(asString(generationRow.sourceRunStatus))
  ) return null;
  return generationId;
}

/**
 * New community rows are stable publication heads. Their denormalized receipt is
 * sufficient to prove visibility, so a page never performs one discovery-run read
 * per row. Pre-publication run artifacts are kept in separate collections. Truly
 * legacy rows without run provenance remain visible; old run-versioned rows are
 * hidden because they cannot prove that publication finished.
 */
export function publishedCommunityPostVisible(row: Record<string, unknown>, activeGenerationId: string | null = null): boolean {
  const publicationStatus = asString(row.publicationStatus);
  const sourceRunId = asString(row.sourceRunId);
  const sourceRunRef = asString(row.sourceRunRef);
  const sourceRunStatus = asString(row.sourceRunStatus);
  const publicationGenerationId = asString(row.publicationGenerationId);
  if (publicationStatus === "published") {
    return Boolean(activeGenerationId)
      && publicationGenerationId === activeGenerationId
      && asString(row.publicationGenerationRef) === `community_publication_generations/${activeGenerationId}`
      && asString(row.publicationContractVersion) === COMMUNITY_PUBLICATION_CONTRACT_VERSION
      && asString(row.id).startsWith("community_post_")
      && Boolean(asString(row.sourceIdentity))
      && asString(row.sourceArtifactRef).startsWith("community_post_artifacts/")
      && Boolean(sourceRunId)
      && sourceRunRef === `discovery_runs/${sourceRunId}`
      && COMPLETED_DISCOVERY_RUN_STATUSES.has(sourceRunStatus);
  }
  if (
    publicationStatus
    || sourceRunId
    || sourceRunRef
    || sourceRunStatus
    || asString(row.discoveryRunId)
    || asString(row.sourceIdentity)
    || publicationGenerationId
  ) return false;
  return true;
}

async function readCollection(
  name: string,
  limit = DEFAULT_PAGE_SIZE,
  cursor?: string,
  order: CollectionOrder = {},
  auth?: ReturnType<typeof assertNonGuestAuth>,
  key?: DatasetKey,
  filters: CollectionFilter[] = [],
  programScope: CanonicalProgramScope | null = null,
  activeCommunityGenerationId: string | null = null,
  cursorScopeKey?: string,
  includeArchivedCampaigns = false,
  // PLAN-ORG-MAIL-IDENTITY Slice 5 fix (2026-09-10 adversarial review HIGH-3): an extra
  // row-accept predicate folded into the SAME scan/backfill loop as isSoftHidden/programScope,
  // instead of being applied to the page's rows AFTER readCollection already decided
  // pageInfo/nextCursor. Today's only caller is listDatasetPage's conversationOrgScope.filter —
  // applying it post-hoc there meant an org-sparse manager page could come back short (or even
  // empty) of a "full" boundedLimit page while pageInfo still claimed truncated:false, and the
  // MAX_HIDDEN_PAGE_SCAN_PAGES backfill never ran for org-excluded rows.
  extraRowFilter?: (row: Record<string, unknown>) => boolean | Promise<boolean>,
): Promise<CollectionRead> {
  const boundedLimit = pageSize(limit);
  const rows: Record<string, unknown>[] = [];
  let decodedCursor = decodePageCursor(cursor);
  if (decodedCursor && cursorScopeKey && decodedCursor.scopeKey !== cursorScopeKey) {
    throw Object.assign(new Error("failed-precondition: page cursor belongs to a different product scope"), { code: "failed-precondition", errorCode: "read_collection_page_cursor_belongs_different_product" });
  }
  let nextCursor: string | null = null;
  let hasMore = false;
  let scannedPages = 0;

  while (rows.length < boundedLimit && scannedPages < MAX_HIDDEN_PAGE_SCAN_PAGES) {
    let query: Query = adminDb.collection(name);
    for (const filter of filters) query = query.where(filter.field, "==", filter.value);
    query = applyCanonicalProgramScopeQuery(query, programScope);
    // A cursor minted during document-order fallback pins the whole pagination to
    // document order: switching back to the composite order mid-stream (index
    // finished building) would skip or duplicate rows.
    const stickyFallback = decodedCursor?.fallback === true;
    if (order.field && !stickyFallback) {
      query = query.orderBy(order.field, order.direction ?? "desc").orderBy(FieldPath.documentId());
      if (decodedCursor) query = query.startAfter(decodedCursor.orderValue ?? null, decodedCursor.docId);
    } else {
      query = query.orderBy(FieldPath.documentId());
      if (decodedCursor) query = query.startAfter(decodedCursor.docId);
    }

    let usedDocumentOrderFallback = stickyFallback;
    let snapshot: FirebaseFirestore.QuerySnapshot;
    try {
      snapshot = await query.limit(boundedLimit + 1).get();
    } catch (error) {
      if (!shouldRetryQueryWithoutCompositeIndex(error, order)) throw error;
      usedDocumentOrderFallback = true;
      let fallbackQuery: Query = adminDb.collection(name);
      for (const filter of filters) fallbackQuery = fallbackQuery.where(filter.field, "==", filter.value);
      fallbackQuery = applyCanonicalProgramScopeQuery(fallbackQuery, programScope);
      fallbackQuery = fallbackQuery.orderBy(FieldPath.documentId());
      if (decodedCursor) fallbackQuery = fallbackQuery.startAfter(decodedCursor.docId);
      snapshot = await fallbackQuery.limit(boundedLimit + 1).get();
    }
    scannedPages += 1;
    const docs = snapshot.docs.slice(0, boundedLimit);
    const hasExtraDoc = snapshot.docs.length > boundedLimit;
    hasMore = hasExtraDoc;
    nextCursor = null;

    for (let index = 0; index < docs.length; index += 1) {
      const doc = docs[index];
      const pageCursor = usedDocumentOrderFallback
        ? { docId: doc.id, fallback: true, ...(cursorScopeKey ? { scopeKey: cursorScopeKey } : {}) }
        : cursorForDoc(doc, order, cursorScopeKey);
      const hasRemainingInSnapshot = index < docs.length - 1 || hasExtraDoc;
      const row: Record<string, unknown> = { ...doc.data(), id: doc.id };
      if (
        (!isSoftHidden(row) || (includeArchivedCampaigns && key === "campaigns" && isArchivedOnlyRow(row))) &&
        !isMockHidden(row, name) &&
        (key !== "scpLifecycleProfiles" || scpLifecycleProfileNotFoundReason(row) === null) &&
        (key !== "communityPosts" || publishedCommunityPostVisible(row, activeCommunityGenerationId)) &&
        rowMatchesCanonicalProgramScope(row, programScope) &&
        (!extraRowFilter || await extraRowFilter(row))
      ) {
        rows.push(row);
        if (rows.length >= boundedLimit) {
          hasMore = hasRemainingInSnapshot;
          nextCursor = hasRemainingInSnapshot ? encodePageCursor(pageCursor) : null;
          break;
        }
      }
      if (hasRemainingInSnapshot) nextCursor = encodePageCursor(pageCursor);
      decodedCursor = pageCursor;
    }

    if (rows.length >= boundedLimit || !hasMore || !nextCursor) break;
    decodedCursor = decodePageCursor(nextCursor);
  }

  return {
    rows,
    pageInfo: {
      limit: boundedLimit,
      truncated: hasMore,
      nextCursor,
    },
    scannedPages,
  };
}


const ACCOUNT_OWNERSHIP_DATASET_KEYS = new Set<DatasetKey>(["campaigns", "programs", "candidatePool"]);
// Application rows contain applicant contact data, but their ownership lives on
// the parent program. Keep the parent lookup bounded per request: a sparse
// collection scan must never turn into an unbounded N+1 authorization walk.
const MAX_PROGRAM_APPLICATION_PARENT_READS = 2_000;

function ownerEmailFromRow(row: Record<string, unknown>): string {
  return (asString(row.ownerEmail) || asString(row.createdByEmail) || asString(row.accountOwnerEmail) || asString(row.programOwnerEmail) || asString(row.campaignOwnerEmail)).toLowerCase();
}

function ownerUidFromRow(row: Record<string, unknown>): string {
  return asString(row.ownerUid) || asString(row.createdBy) || asString(row.accountOwnerUid) || asString(row.programOwnerUid) || asString(row.campaignOwnerUid);
}

async function memberEmailForUid(uid: string, cache: Map<string, Promise<string>>): Promise<string> {
  if (!uid) return "";
  const cached = cache.get(uid);
  if (cached) return cached;
  const loaded = resolveMailAccountsDb().collection("members").doc(uid).get()
    .then((snapshot) => {
      const data = snapshot.exists ? asRecord(snapshot.data()) : {};
      const storedUid = asString(data.uid);
      if (storedUid && storedUid !== uid) return "";
      return asString(data.email).toLowerCase();
    })
    .catch(() => "");
  cache.set(uid, loaded);
  return loaded;
}

async function ownerEmailResolvesToViewerOrg(
  ownerEmail: string,
  viewerScope: AccountOwnershipScope,
  cache: Map<string, Promise<boolean>>,
): Promise<boolean> {
  const normalized = ownerEmail.trim().toLowerCase();
  if (!normalized || !viewerScope.orgId) return false;
  const cached = cache.get(normalized);
  if (cached) return cached;
  const resolved = resolveMailSenderPolicyForEmail(normalized)
    .then((policy) => policy.orgResolutionStatus === "resolved" && policy.orgId === viewerScope.orgId)
    .catch(() => false);
  cache.set(normalized, resolved);
  return resolved;
}

async function datasetAccountOwnershipFilter(
  request: CallableRequestShape,
  auth: ReturnType<typeof assertNonGuestAuth>,
  key: DatasetKey,
): Promise<((row: Record<string, unknown>) => Promise<boolean>) | undefined> {
  if (!ACCOUNT_OWNERSHIP_DATASET_KEYS.has(key)) return undefined;
  const requestData = asRecord(request.data);
  const scope = await resolveAccountOwnershipScopeForAuth(auth, request, { data: requestData });
  return async (row: Record<string, unknown>) => {
    // Centralized account ownership handles explicit stamps and trusted legacy ownerUid rows
    // through members/{uid} + official org resolution. A single unresolved
    // legacy owner is excluded (with a fixed-category diagnostic) rather than
    // aborting a whole read; direct record authorization remains fail-closed.
    return accountOwnedRowMatchesScopeAsync(scope, row, {}, { excludeLegacyScopeUnavailable: true });
  };
}

export const __testDatasetAccountOwnershipFilter = datasetAccountOwnershipFilter;

type ProgramApplicationParentFilter = {
  readonly parentMatches: (canonicalProgramId: string) => Promise<boolean>;
  readonly rowMatches: (row: Record<string, unknown>) => Promise<boolean>;
};

async function programApplicationParentFilter(
  request: CallableRequestShape,
  auth: ReturnType<typeof assertNonGuestAuth>,
  aliasMap: Record<string, string>,
): Promise<ProgramApplicationParentFilter> {
  // This resolves the verified viewAs target (when present) once, then applies
  // its role/org to every parent. A caller super_admin never bypasses a target
  // manager's scope because accountOwnershipScope marks verified viewAs.
  const scope = await resolveAccountOwnershipScopeForAuth(auth, request, { data: asRecord(request.data) });
  const parentCache = new Map<string, Promise<boolean>>();

  const parentMatches = async (canonicalProgramId: string): Promise<boolean> => {
    if (!canonicalProgramId || !LIST_PROGRAM_ID_PATTERN.test(canonicalProgramId)) return false;
    // A super_admin acting as themself has the existing all-program read
    // contract, including orphaned legacy applications. A viewAs target must
    // still prove ownership of a real parent before any applicant is returned.
    if (scope.role === "super_admin" && !scope.viewAs) return true;
    const cached = parentCache.get(canonicalProgramId);
    if (cached) return cached;
    if (parentCache.size >= MAX_PROGRAM_APPLICATION_PARENT_READS) return false;
    const matching = adminDb.collection("programs").doc(canonicalProgramId).get()
      .then(async (snapshot) => {
        // For scoped viewers, missing parents and unresolved legacy ownership
        // are denied. Applicant/creator fields never substitute for ownership.
        if (!snapshot.exists) return false;
        return accountOwnedRowMatchesScopeAsync(
          scope,
          { id: snapshot.id, ...asRecord(snapshot.data()) },
          {},
          { excludeLegacyScopeUnavailable: true },
        );
      })
      .catch(() => false);
    parentCache.set(canonicalProgramId, matching);
    return matching;
  };

  const rowMatches = async (row: Record<string, unknown>): Promise<boolean> => {
    const canonicalIds = new Set([
      resolveCanonicalProgramId(row.canonicalProgramId, aliasMap),
      resolveCanonicalProgramId(row.programId, aliasMap),
    ].filter(Boolean));
    // A missing or contradictory parent reference must not expose an applicant.
    if (canonicalIds.size !== 1) return false;
    if (scope.role === "super_admin" && !scope.viewAs) return parentMatches([...canonicalIds][0]);
    // Most application rows inherit their parent's scope. An explicit child
    // ownership stamp is different: it must agree with the verified viewer
    // too, even when its programId points at an accessible parent.
    const stampedOrgIds = new Set([
      row.ownerOrgId,
      row.accountOwnerOrgId,
      row.programOwnerOrgId,
      row.campaignOwnerOrgId,
    ].map((value) => asString(value)).filter(Boolean));
    if (stampedOrgIds.size > 1) return false;
    if (stampedOrgIds.size === 1 && !await accountOwnedRowMatchesScopeAsync(
      scope,
      row,
      {},
      { excludeLegacyScopeUnavailable: true },
    )) return false;
    // Application writers copy the program owner's UID/email onto the child.
    // Every present child identity must resolve to this viewer's organization;
    // an accessible parent alone must not override a contradictory child.
    const ownerUids = new Set<string>();
    for (const field of ["ownerUid", "accountOwnerUid", "programOwnerUid", "campaignOwnerUid"]) {
      const uid = asString(row[field]);
      if (uid) ownerUids.add(uid);
    }
    for (const field of ["ownerUids", "accountOwnerUids", "programOwnerUids", "campaignOwnerUids"]) {
      for (const value of Array.isArray(row[field]) ? row[field] as unknown[] : []) {
        const uid = asString(value);
        if (uid) ownerUids.add(uid);
      }
    }
    const ownerEmails = new Set<string>();
    for (const field of ["ownerEmail", "accountOwnerEmail", "programOwnerEmail", "campaignOwnerEmail"]) {
      const email = asString(row[field]).toLowerCase();
      if (email) ownerEmails.add(email);
    }
    for (const field of ["ownerEmails", "accountOwnerEmails", "programOwnerEmails", "campaignOwnerEmails"]) {
      for (const value of Array.isArray(row[field]) ? row[field] as unknown[] : []) {
        const email = asString(value).toLowerCase();
        if (email) ownerEmails.add(email);
      }
    }
    const verifiedOwnerEmails = new Set<string>();
    for (const uid of ownerUids) {
      try {
        const owner = await resolveTrustedLegacyOwnerForRecord(scope, { ownerUid: uid }, "program application");
        if (!owner) return false;
        verifiedOwnerEmails.add(owner.ownerEmail.toLowerCase());
      } catch {
        return false;
      }
    }
    for (const email of ownerEmails) {
      if (ownerUids.size > 0) {
        if (!verifiedOwnerEmails.has(email)) return false;
      } else {
        try {
          const policy = await resolveMailSenderPolicyForEmail(email);
          if (policy.orgResolutionStatus !== "resolved" || policy.orgId !== scope.orgId) return false;
        } catch {
          return false;
        }
      }
    }
    return parentMatches([...canonicalIds][0]);
  };

  return { parentMatches, rowMatches };
}

async function listDatasetPage(
  request: CallableRequestShape,
  key: DatasetKey,
  collection: string,
  filters: CollectionFilter[] = [],
  programScope: CanonicalProgramScope | null = null,
  activeCommunityGenerationId: string | null = null,
  cursorScopeKey?: string,
): Promise<DatasetPageEnvelope> {
  // chat-latency 계측 t0 — 구간 경계는 아래 tPolicy/tQuery/tNormalize 가 자른다(ReadPhaseTiming 주석).
  const t0 = Date.now();
  const auth = assertNonGuestAuth(request, `data.${key}.list`);
  if (!canReadDatasetKey(auth.role, key)) {
    const error = new Error(`permission-denied: ${key} requires a higher role`);
    Object.assign(error, { code: "permission-denied", errorCode: "list_dataset_page_requires_higher_role", behaviorLog: makeBehaviorLog(auth, `data.${key}.list`, "error") });
    throw error;
  }
  const requestData = asRecord(request.data);
  // W41 제약: campaigns 에서 권한 없이 옵션만 붙여 숨김을 우회하는 것은 거부한다. campaigns 가
  // 아니면 값을 조용히 무시한다(전역 showHidden 을 만들지 않는다).
  const requestedArchived = requestData.includeArchivedCampaigns === true;
  // Archive visibility is evaluated against the server-verified target, not
  // the caller. A super_admin previewing a manager therefore cannot open the
  // manager's archive inventory merely because the caller is privileged.
  const archiveViewerScope = requestedArchived && key === "campaigns"
    ? await resolveAccountOwnershipScopeForAuth(auth, request, { data: requestData })
    : null;
  if (requestedArchived && key === "campaigns" && !ARCHIVED_VISIBLE_ROLES.has(archiveViewerScope?.role ?? "guest")) {
    const error = new Error("permission-denied: archived campaigns require an admin role");
    Object.assign(error, { code: "permission-denied", errorCode: "list_dataset_page_archived_requires_admin", behaviorLog: makeBehaviorLog(auth, `data.${key}.list`, "error") });
    throw error;
  }
  const includeArchivedCampaigns = requestedArchived && key === "campaigns" && ARCHIVED_VISIBLE_ROLES.has(archiveViewerScope?.role ?? "guest");
  const limit = typeof requestData.limit === "number" ? pageSize(requestData.limit) : DEFAULT_PAGE_SIZE;
  // PLAN-ORG-MAIL-IDENTITY Slice 5 fix (2026-09-10 adversarial review HIGH-3): resolved BEFORE
  // readCollection so its filter participates in the same scan/backfill loop as
  // isSoftHidden/programScope (MAX_HIDDEN_PAGE_SCAN_PAGES) — an org-sparse manager page now gets
  // backfilled instead of coming back short of a full page while pageInfo claims truncated:false.
  const tPolicy = Date.now();
  const conversationOrgScope = key === "conversations"
    ? await resolveConversationOrgScope(
        // Flu/Task-50 적대 리뷰 P0-2: super_admin "대신 보기" 대상이 있으면 그 대상자 기준으로
        // 스코프를 계산한다(effectiveConversationAuth 주석 참조).
        await effectiveConversationAuth(auth, requestData),
        asString(requestData.orgId),
        requestData.includeUnregistered === true,
        asString(requestData.mailAccountId),
      )
    : null;
  const accountFilter = await datasetAccountOwnershipFilter(request, auth, key);
  const applicationParentFilter = key === "programApplications"
    ? await programApplicationParentFilter(request, auth, programScope?.aliasMap ?? await readConfirmedProgramAliasMap())
    : null;
  const combinedRowFilter = accountFilter || conversationOrgScope || applicationParentFilter
    ? async (row: Record<string, unknown>) => (!accountFilter || await accountFilter(row)) && (!conversationOrgScope || conversationOrgScope.filter(row)) && (!applicationParentFilter || await applicationParentFilter.rowMatches(row))
    : undefined;
  const tQuery = Date.now();
  const read = await readCollection(
    collection,
    limit,
    asString(requestData.cursor),
    collectionOrderForKey(key),
    auth,
    key,
    filters,
    programScope,
    activeCommunityGenerationId,
    cursorScopeKey,
    includeArchivedCampaigns,
    combinedRowFilter,
  );
  const tNormalize = Date.now();
  const excluded: CreatorReadExclusion[] = [];
  const rows = await normalizeRowsForKey(key, read.rows, excluded);
  const normalizeMs = Date.now() - tNormalize;
  return {
    ok: true,
    key,
    rows,
    counts: { [key]: rows.length },
    // 읽기 필터로 빠진 행은 조용히 사라지지 않는다 — 사유별 건수를 응답에 남긴다.
    ...(excluded.length > 0 ? { excludedCount: excluded.length, excluded } : {}),
    ...(conversationOrgScope
      ? {
          viewerOrgId: conversationOrgScope.viewerOrgId,
          orgFilterApplied: conversationOrgScope.orgFilterApplied,
          viewMailAccountId: conversationOrgScope.mailAccountId || null,
        }
      : {}),
    pageInfo: read.pageInfo,
    cache: {
      generatedAtIso: new Date().toISOString(),
      maxAgeSeconds: CACHE_MAX_AGE_SECONDS,
      requestedKeys: [key],
    },
    timing: {
      totalMs: Date.now() - t0,
      authMs: tPolicy - t0,
      policyMs: tQuery - tPolicy,
      queryMs: tNormalize - tQuery,
      normalizeMs,
      scannedPages: read.scannedPages,
    },
    behaviorLog: makeBehaviorLog(auth, `data.${key}.list`, "success"),
  };
}

async function listTargetableDatasetPage(
  request: CallableRequestShape,
  key: DatasetKey,
  collection: string,
): Promise<DatasetPageEnvelope> {
  // chat-latency 계측 t0 — listDatasetPage 와 같은 구간명을 쓴다(ReadPhaseTiming 주석).
  const t0 = Date.now();
  const auth = assertNonGuestAuth(request, `data.${key}.list`);
  if (!canReadDatasetKey(auth.role, key)) {
    const error = new Error(`permission-denied: ${key} requires a higher role`);
    Object.assign(error, { code: "permission-denied", errorCode: "list_targetable_dataset_page_requires_higher_role", behaviorLog: makeBehaviorLog(auth, `data.${key}.list`, "error") });
    throw error;
  }
  const requestData = asRecord(request.data);
  const tAfterAuth = Date.now();
  let programScope: CanonicalProgramScope | null = null;
  if (PROGRAM_SCOPED_LIST_KEYS.has(key)) {
    try {
      const requestedProgramId = requestData.programId;
      programScope = canonicalProgramScopeForListRequest(
        requestedProgramId,
        await readConfirmedProgramAliasMap(),
        canonicalProgramQueryIdentityLimit(auth, key),
      );
    } catch (error) {
      Object.assign(error as object, {
        behaviorLog: makeBehaviorLog(auth, `data.${key}.list`, "error"),
      });
      throw error;
    }
  }
  const applicationParentFilter = key === "programApplications"
    ? await programApplicationParentFilter(request, auth, programScope?.aliasMap ?? await readConfirmedProgramAliasMap())
    : null;
  // Authorize an explicitly requested parent before touching child rows. This
  // keeps aliases canonical while denying a missing, unresolved, or foreign
  // parent without ever projecting its applicants (including email fields).
  if (programScope && applicationParentFilter && !await applicationParentFilter.parentMatches(programScope.canonicalProgramId)) {
    throw Object.assign(new Error("permission-denied: program applications parent is not accessible"), {
      code: "permission-denied",
      errorCode: "program_applications_parent_scope_denied",
      behaviorLog: makeBehaviorLog(auth, `data.${key}.list`, "error"),
    });
  }
  // policy 구간 ① program-scope 해석(alias map read 포함). 아래 ② org-scope 해석과 합산한다.
  let policyMs = Date.now() - tAfterAuth;
  // 이 위임 경로는 listDatasetPage 자체의 timing 을 그대로 실어 보낸다 — 이중 계측하지 않는다.
  if (!hasTargetFilters(requestData)) return listDatasetPage(request, key, collection, [], programScope);

  const limit = typeof requestData.limit === "number" ? pageSize(requestData.limit) : DEFAULT_PAGE_SIZE;
  const ids = uniqueStrings(requestData.ids);
  const creatorIds = uniqueStrings(requestData.creatorIds);
  const channelIds = uniqueStrings(requestData.channelIds);
  const handles = uniqueStrings(requestData.handles);
  const emails = uniqueStrings(requestData.emails);
  const fields: Record<string, string[]> = {};

  if (key === "creators") {
    fields.id = ids;
    fields.channelId = channelIds;
    fields.handle = handles;
    fields.email = emails;
  } else if (key === "videos" || key === "creatorComments") {
    fields.id = ids;
    fields.creatorId = creatorIds;
    fields.channelId = channelIds;
  } else if (
    key === "conversations" ||
    key === "programs" ||
    key === "programApplications" ||
    key === "programSheetLeads" ||
    key === "escalations" ||
    key === "reviews" ||
    key === "submissions" ||
    key === "candidatePool"
  ) {
    fields.id = ids;
  }

  const tQuery = Date.now();
  const targetedRows = sortTargetRows(
    key,
    await readTargetedRows(key, collection, fields, limit, auth, programScope),
  ).slice(0, limit);
  const queryMs = Date.now() - tQuery;
  const excluded: CreatorReadExclusion[] = [];
  const tOrgScope = Date.now();
  const conversationOrgScope = key === "conversations"
    ? await resolveConversationOrgScope(
        // Flu/Task-50 적대 리뷰 P0-2: see the matching comment on the listDatasetPage call site.
        await effectiveConversationAuth(auth, requestData),
        asString(requestData.orgId),
        requestData.includeUnregistered === true,
        asString(requestData.mailAccountId),
      )
    : null;
  const accountFilter = await datasetAccountOwnershipFilter(request, auth, key);
  // policy 구간 ② org-scope 해석 — 위 program-scope 해석과 같은 policyMs 버킷으로 합산한다.
  policyMs += Date.now() - tOrgScope;
  // PLAN-ORG-MAIL-IDENTITY Slice 5 fix (2026-09-10 adversarial review HIGH-3): the targeted-id
  // read has no pagination cursor of its own, so an org-excluded row can't be "backfilled" the
  // way listDatasetPage's readCollection loop does — instead, count it (reason "org_scope") like
  // every other read-time exclusion, and report truncated:true so the caller knows this page is
  // not the full set of requested ids, rather than silently looking like a complete result.
  // (계측: 이 스코프 필터 + 정규화를 normalizeMs 버킷으로 묶는다 — ReadPhaseTiming 주석.)
  const tNormalize = Date.now();
  const scopedTargetedRows: Record<string, unknown>[] = [];
  for (const row of targetedRows) {
    if (accountFilter && !await accountFilter(row)) {
      excluded.push({ id: asString(row.id), reason: "account_scope" });
      continue;
    }
    if (conversationOrgScope && !conversationOrgScope.filter(row)) {
      excluded.push({ id: asString(row.id), reason: "org_scope" });
      continue;
    }
    if (applicationParentFilter && !await applicationParentFilter.rowMatches(row)) {
      excluded.push({ id: asString(row.id), reason: "parent_program_scope" });
      continue;
    }
    scopedTargetedRows.push(row);
  }
  const rows = await normalizeRowsForKey(key, scopedTargetedRows, excluded);
  const normalizeMs = Date.now() - tNormalize;
  return {
    ok: true,
    key,
    rows,
    counts: { [key]: rows.length },
    ...(excluded.length > 0 ? { excludedCount: excluded.length, excluded } : {}),
    ...(conversationOrgScope
      ? {
          viewerOrgId: conversationOrgScope.viewerOrgId,
          orgFilterApplied: conversationOrgScope.orgFilterApplied,
          viewMailAccountId: conversationOrgScope.mailAccountId || null,
        }
      : {}),
    pageInfo: { limit, truncated: scopedTargetedRows.length < targetedRows.length, nextCursor: null },
    cache: {
      generatedAtIso: new Date().toISOString(),
      maxAgeSeconds: CACHE_MAX_AGE_SECONDS,
      requestedKeys: [key],
    },
    // targeted-id read 는 스캔 루프가 없다 — scannedPages 는 생략하고 구간 ms 만 보고한다.
    timing: {
      totalMs: Date.now() - t0,
      authMs: tAfterAuth - t0,
      policyMs,
      queryMs,
      normalizeMs,
    },
    behaviorLog: makeBehaviorLog(auth, `data.${key}.list`, "success"),
  };
}

export function applicationManagementFallbackMatchesCanonicalProgram(
  recordProgramId: string | null,
  canonicalProgramId: string,
): boolean {
  return !canonicalProgramId || resolveCanonicalProgramId(recordProgramId) === canonicalProgramId;
}
async function readLifecycleProfileFallbackRows(
  records: readonly ApplicationManagementLifecycleFallbackProfile[],
): Promise<Record<string, unknown>[]> {
  const identifiers = [...new Set(records
    .map((record) => asString(record.matchedIdentifier))
    .filter(Boolean))]
    .slice(0, APPLICATION_MANAGEMENT_FALLBACK_WINDOW_SIZE);
  const snapshots = await Promise.all(
    chunk(identifiers, FIRESTORE_IN_QUERY_LIMIT).map((identifierBatch) =>
      adminDb
        .collection("scp_lifecycle_profiles")
        .where("profileId", "in", identifierBatch)
        .limit(identifierBatch.length)
        .get()),
  );
  return dedupeById(
    snapshots.flatMap((snapshot) =>
      snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() ?? {}) }))),
  );
}

export function partitionApplicationManagementFallbackWindow(
  records: readonly ApplicationManagementLifecycleFallbackProfile[],
  lifecycleRows: readonly Record<string, unknown>[],
  canonicalProgramId: string,
  selectedProgramLifecycleRows: readonly Record<string, unknown>[] = lifecycleRows,
): {
  visibleRecords: ApplicationManagementLifecycleFallbackProfile[];
  otherProgramCount: number;
} {
  const knownIdentifiers = (rows: readonly Record<string, unknown>[]): Set<string> => {
    const known = new Set<string>();
    for (const row of rows) {
      const record = asRecord(row);
      // channelId 를 키에 포함하는 이유: 폴백 행은 identity.channelId 를 aliasIds 로 투영하므로,
      // 같은 채널의 실 lifecycle 프로필이 이미 있으면 그 사람은 한 번만 세어야 한다. 채널 이관·
      // 재지정으로 같은 channelId 를 다른 사람이 물려받은 경우에도 이 사전 dedup 이 먼저 걷어낸다.
      for (const key of ["profileId", "id", "fluCreatorId", "portalCreatorId", "applicationId", "channelId"]) {
        const value = asString(record[key]);
        if (value) known.add(value);
      }
      // 실 lifecycle 프로필 문서가 신원을 들고 있는 필드는 `aliasIds` 뿐이다(scpLifecycleProfiles
      // 의 profileDoc 이 그렇게 쓴다 — channelId/fluCreatorId 를 평평하게 갖고 있지 않다). 이 축을
      // 빼면 채널·크리에이터 id 로만 겹치는 중복은 사전 dedup 이 영원히 보지 못한다.
      for (const aliasId of Array.isArray(record.aliasIds) ? record.aliasIds : []) {
        const value = asString(aliasId);
        if (value) known.add(value);
      }
    }
    return known;
  };
  const globalKnown = knownIdentifiers(lifecycleRows);
  const selectedProgramKnown = knownIdentifiers(selectedProgramLifecycleRows);
  // 폴백 행이 실을 신원을 그 행을 만드는 **같은 함수**로 계산해 dedup 축에 넣는다. matchedIdentifier/
  // applicationId 만 보던 예전 키 집합은 채널·크리에이터 id 로만 겹치는 중복을 그대로 통과시켰다.
  const aliasIdentifiers = (
    record: ApplicationManagementLifecycleFallbackProfile,
  ): string[] => [
    record.fluCreatorId ?? "",
    record.channelId ?? "",
    ...applicationManagementFallbackAliasIds(record),
  ].filter(Boolean);

  const visibleRecords: ApplicationManagementLifecycleFallbackProfile[] = [];
  let otherProgramCount = 0;
  for (const record of records) {
    const aliasKeys = aliasIdentifiers(record);
    if (applicationManagementFallbackMatchesCanonicalProgram(record.programId, canonicalProgramId)) {
      if (
        selectedProgramKnown.has(record.matchedIdentifier)
        || selectedProgramKnown.has(record.applicationId)
        || aliasKeys.some((identifier) => selectedProgramKnown.has(identifier))
      ) continue;
      visibleRecords.push(record);
      continue;
    }
    if (
      globalKnown.has(record.matchedIdentifier)
      || globalKnown.has(record.applicationId)
      || aliasKeys.some((identifier) => globalKnown.has(identifier))
    ) continue;
    otherProgramCount += 1;
  }
  return { visibleRecords, otherProgramCount };
}

function scpLifecycleProfileFilters(data: Record<string, unknown>, canonicalProgramId: string): CollectionFilter[] {
  const filters: CollectionFilter[] = [];
  const currentState = asString(data.currentState);
  if (canonicalProgramId) filters.push({ field: "programId", value: canonicalProgramId });
  if (currentState) filters.push({ field: "currentState", value: currentState });
  return filters;
}

export const listCreators = (request: CallableRequestShape) => listTargetableDatasetPage(request, "creators", "creators");
export const listCampaigns = (request: CallableRequestShape) => listTargetableDatasetPage(request, "campaigns", "campaigns");
export const listVideos = (request: CallableRequestShape) => listTargetableDatasetPage(request, "videos", "videos");
export const listCommunityPosts = async (request: CallableRequestShape) => {
  const auth = assertNonGuestAuth(request, "data.communityPosts.list");
  if (!canReadDatasetKey(auth.role, "communityPosts")) {
    const error = new Error("permission-denied: communityPosts requires a higher role");
    Object.assign(error, { code: "permission-denied", errorCode: "list_community_posts_community_posts_requires_higher_role", behaviorLog: makeBehaviorLog(auth, "data.communityPosts.list", "error") });
    throw error;
  }
  const requestData = asRecord(request.data);
  const scope = await communityListScope(auth, requestData);
  // The system-wide discovery feed is deliberately unscoped. `__global__` is a
  // request-scope sentinel, not a value persisted on each community row; using
  // it as an equality filter hid every legacy and newly-seeded global signal.
  const filters = scope && !scope.systemGlobal
    ? [
      { field: "canonicalProgramId", value: scope.canonicalProgramId },
      { field: "campaignId", value: scope.campaignId },
    ]
    : [];
  const activeGenerationId = scope ? await activeCommunityPublicationGeneration(scope) : null;
  const generationFilters = activeGenerationId
    ? [...filters, { field: "publicationGenerationId", value: activeGenerationId }]
    : filters;
  return listDatasetPage(
    request,
    "communityPosts",
    "community_posts",
    generationFilters,
    null,
    activeGenerationId,
    `community:${scope.canonicalProgramId}:${scope.campaignId}:${activeGenerationId ?? "legacy"}`,
  );
};
export const listCreatorComments = (request: CallableRequestShape) => listTargetableDatasetPage(request, "creatorComments", "creator_comments");
export const listConversations = (request: CallableRequestShape) => listTargetableDatasetPage(request, "conversations", "conversations");

// "미답장 인박스" (2026-09-26, 헤세 요청) — scp 사서함으로 들어왔는데 아직 사람 답장이 필요한
// 대화만 모은 전용 큐. listConversations(제네릭 데이터셋 페이저, 위)를 그대로 확장하지 않는
// 이유: 이 큐만 유일하게 message_sources 를 다시 조회하는 detectManualReplySinceInbound 서버
// 판정이 필요하다(제네릭 페이저는 순수 Firestore 필터/스코프만 안다 — 행 하나마다 추가 조회를
// 태우는 필터를 얹으면 그 페이저를 쓰는 다른 11개 데이터셋까지 같은 비용 모양을 상속한다).
// RBAC·scp 계정 스코프·조직 스코프는 listConversations 가 쓰는 것과 같은 헬퍼
// (canReadDatasetKey/resolveRequestedMailAccountId/conversationRegistrationGateFilter/
// isAutoReplyOrgExcluded)를 그대로 재사용한다 — 새 정책을 만들지 않는다.
//
// Firestore 쿼리는 autoReplyBacklog.ts defaultQueryCandidates 와 바이트 단위로 같은 모양이다
// (lastMessageFrom==창작자 + autoReplyStatus in [...] + lastInboundAtIso asc + __name__ asc) —
// 그 쿼리가 이미 프로드에 쓰는 복합 인덱스를 그대로 재사용해 새 인덱스 배포가 필요 없다.
const UNREPLIED_INBOX_SCAN_LIMIT = 300;
// 한 페이지(300)로 안 끝나면 최대 3페이지(900건)까지 이어서 스캔한다 — 다른 조직/계정 행이
// 먼저 창을 채워도 이 호출자의 정당한 오래된 대기 행이 사라지지 않게 한다(Codex 적대 리뷰
// MEDIUM 수리). 그 이상은 truncated:true 로 보고하고 멈춘다(무한 스캔 방지).
const UNREPLIED_INBOX_MAX_SCAN_PAGES = 3;
const UNREPLIED_INBOX_DEFAULT_LIMIT = 50;
const UNREPLIED_INBOX_MAX_LIMIT = 200;
// autoReplyBacklog.ts SELECTABLE_AUTO_REPLY_STATUSES 와 값이 같아야 한다(그 모듈이 export 하지
// 않아 import 는 못 하지만, "사람 답장이 필요함"의 정본 정의는 거기 있다 — 값이 갈라지면 이
// 인박스와 실제 발송 백로그가 서로 다른 대화를 "미답장"으로 본다).
const UNREPLIED_INBOX_STATUSES = ["waiting_for_human", "draft_only"] as const;

function unrepliedInboxLimit(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return UNREPLIED_INBOX_DEFAULT_LIMIT;
  return Math.min(Math.floor(num), UNREPLIED_INBOX_MAX_LIMIT);
}

export interface UnrepliedInboxEnvelope {
  ok: true;
  queue: "unreplied_inbox";
  rows: Record<string, unknown>[];
  // `total` is only the count of in-scope candidates found within THIS request's bounded scan
  // window (UNREPLIED_INBOX_MAX_SCAN_PAGES) — a lower bound, not the true queue size, whenever
  // pageInfo.truncated/nextCursor say more remain. See listUnrepliedInboxHandler's cursor doc
  // comment (Flu conversation org-filter round 2, codex adversarial review finding #8).
  counts: { returned: number; total: number };
  pageInfo: { limit: number; truncated: boolean; nextCursor: string | null };
  cache: { generatedAtIso: string; maxAgeSeconds: number };
  behaviorLog: ReturnType<typeof makeBehaviorLog>;
}

export async function listUnrepliedInboxHandler(request: CallableRequestShape): Promise<UnrepliedInboxEnvelope> {
  const auth = assertNonGuestAuth(request, "data.unrepliedInbox.list");
  if (!canReadDatasetKey(auth.role, "conversations")) {
    const error = new Error("permission-denied: unreplied inbox requires a higher role");
    Object.assign(error, {
      code: "permission-denied",
      errorCode: "list_unreplied_inbox_requires_higher_role",
      behaviorLog: makeBehaviorLog(auth, "data.unrepliedInbox.list", "error"),
    });
    throw error;
  }
  const requestData = asRecord(request.data);
  const limit = unrepliedInboxLimit(requestData.limit);
  const emptyEnvelope = (): UnrepliedInboxEnvelope => ({
    ok: true,
    queue: "unreplied_inbox",
    rows: [],
    counts: { returned: 0, total: 0 },
    pageInfo: { limit, truncated: false, nextCursor: null },
    cache: { generatedAtIso: new Date().toISOString(), maxAgeSeconds: CACHE_MAX_AGE_SECONDS },
    behaviorLog: makeBehaviorLog(auth, "data.unrepliedInbox.list", "success"),
  });
  // Flu conversation org-filter round 2 (codex adversarial review finding #8): the bounded scan
  // below (UNREPLIED_INBOX_MAX_SCAN_PAGES) can leave a sparse org's rows behind hundreds of other
  // orgs'/accounts' rows with no way to ever reach them — a client that always starts a fresh scan
  // from the beginning can never page past that window. An explicit cursor (same PageCursor shape
  // readCollection's pagination already uses) lets a caller resume the scan exactly where the
  // previous call's window ended; an invalid/missing cursor just starts from the beginning, same
  // as before this fix (this queue must never hard-fail the panel on a malformed cursor).
  const requestedCursor = decodePageCursor(requestData.cursor);

  // scp 사서함 전용 — 이 큐의 정의 자체가 "scp-mailbox creator conversation"이다. hesse@ 등
  // 개인 계정은 이 mailAccountId 스코프 하나로 이미 배제된다(listConversations 가 쓰는 것과
  // 같은 엔타이틀먼트 검증). 호출자가 scp 접근권이 아예 없는 조직(예: 개인계정 기본 뷰)이면
  // 빈 인박스로 처리한다 — 이 화면은 목록 필터일 뿐이라 페이지가 깨지면 안 된다.
  // 2026-09-27 security fix (codex round1 finding #3): super_admin "대신 보기" 대상 기준으로
  // 스코프를 계산해야 한다 — raw auth를 그대로 쓰면 대신 보기 중에도 호출자(super_admin) 자신의
  // scp 접근권으로 판정돼, 제한된 대상자를 보고 있다고 표시하면서 실제로는 호출자 자신의 scp
  // 인박스가 새어 나간다(effectiveConversationAuth 주석 참조 — 다른 conversations 읽기 전부가
  // 이미 이 패턴을 쓴다).
  // 2026-09-27 security fix round 2 (codex adversarial review round2, medium finding #5):
  // effectiveConversationAuth는 아래 try 밖에서 먼저 호출해야 한다 — try 안에 있으면
  // resolveViewAsTarget이 던지는 진짜 거부(잘못된/불일치하는 viewAs 신원 — permission-denied,
  // 감사 로그 포함)까지 이 화면의 "scp 접근권 없음 → 빈 인박스" fail-safe로 흡수돼, 위조된
  // viewAs 시도가 조용히 성공한 빈 응답으로 위장된다. mailAccountId 해석 실패(scp 접근권 없음)만
  // fail-safe로 삼는다.
  const scopeAuth = await effectiveConversationAuth(auth, requestData);
  let mailAccountId: string;
  let access: MailConversationReadAccess;
  try {
    const resolved = await resolveRequestedMailAccountId(scopeAuth, "scp");
    mailAccountId = resolved.mailAccountId;
    access = resolved.access;
  } catch (error) {
    // Flu conversation org-filter round 4 (codex adversarial review round 2, finding #4): only a
    // confident "this caller has no scp access" (permission-denied — thrown by
    // resolveRequestedMailAccountId itself when "scp" isn't in the resolved authorized set) may
    // still fail safe into the friendly empty-inbox response ("이 화면은 목록 필터일 뿐이라
    // 페이지가 깨지면 안 된다" above). Anything else — most importantly a Peoply/directory outage
    // (conversationMailAccessDirectoryUnavailableError, code "unavailable") — must surface as a
    // real, visible, retryable error instead of silently looking like an empty mailbox.
    if ((error as { code?: unknown } | undefined)?.code === "permission-denied") return emptyEnvelope();
    throw error;
  }
  if (!mailAccountId) return emptyEnvelope();
  const registrationGate = conversationRegistrationGateFilter(auth.role, false);

  const scan = await scanUnrepliedInboxForScope({
    access,
    mailAccountId,
    limit,
    cursor: requestedCursor ? { docId: requestedCursor.docId, orderValue: asString(requestedCursor.orderValue, "") } : null,
    registrationGate,
  });
  const projected = scan.rows.map((row) => projectConversationRecordForClient(row));
  return {
    ok: true,
    queue: "unreplied_inbox",
    rows: projected,
    counts: { returned: projected.length, total: scan.total },
    pageInfo: { limit, truncated: scan.truncated, nextCursor: scan.nextCursor },
    cache: { generatedAtIso: new Date().toISOString(), maxAgeSeconds: CACHE_MAX_AGE_SECONDS },
    behaviorLog: makeBehaviorLog(auth, "data.unrepliedInbox.list", "success"),
  };
}

export type UnrepliedInboxScopeScanResult = {
  rows: Record<string, unknown>[];
  total: number;
  truncated: boolean;
  nextCursor: string | null;
  /** Fixed point-in-time used for every page and manual-reply probe in a resumable precompute. */
  readTime: { seconds: number; nanoseconds: number };
  readTimeIso: string;
  policy: UnrepliedInboxScopeScanPolicy;
};

export type UnrepliedInboxScopeScanPolicy = {
  disabledOrgIds: string[];
  mailRoutingByOrgId: Record<string, string>;
};

/**
 * Casebook pending precompute (2026-09-29, casebook snapshot 504 hotfix): the scan+filter core of
 * listUnrepliedInboxHandler above, factored out so the scheduled per-scope pending precompute
 * (functions/chatAutoCasebookPendingPrecompute.ts — replaces the inline scan
 * getChatAutoCasebookSnapshot used to run, which hit the 60s Cloud Run request timeout in
 * production) can reuse the EXACT SAME Firestore query + canReadConversationRowForScope filtering
 * + manual-reply detection this callable already ran inline, without forking it and without a
 * live Peoply lookup — the precompute already knows which scope (super_admin or one specific org)
 * it wants and builds the ConversationMailAccessScope directly; it never resolves an unknown
 * caller's own org the way listUnrepliedInboxHandler's caller-facing path must.
 * listUnrepliedInboxHandler itself is UNCHANGED in behavior — it still does its own auth + role
 * check + Peoply-backed scope resolution above (including building registrationGate from its own
 * real auth.role), then delegates here for the scan itself. registrationGate is an explicit input
 * (not rebuilt in here from some fixed role) so this shared core never has to guess or hardcode a
 * role for a caller — like the scheduled precompute — that has no real auth.role of its own.
 */
export async function scanUnrepliedInboxForScope(input: {
  access: ConversationMailAccessScope;
  mailAccountId: string;
  limit: number;
  cursor: { docId: string; orderValue: string } | null;
  /** Persisted Timestamp parts from a previous page; omitted only for the first page. */
  readTime?: { seconds: number; nanoseconds: number };
  /** Policy loaded on the first page and frozen across all pages of an exact precompute. */
  policy?: UnrepliedInboxScopeScanPolicy;
  /** Exact background scans cannot publish if the org-to-mailbox exclusions are unavailable. */
  policyFailureMode?: "fail_open" | "fail_closed";
  registrationGate: (row: Record<string, unknown>) => boolean;
  /** Optional cooperative stop check for bounded background scans. */
  shouldContinue?: () => boolean;
  /** Scan order over lastInboundAtIso. Default "asc" (oldest first) — the precompute never sets it.
   *  The cursor contract (startAfter [lastInboundAtIso, docId]) is the same in both directions. */
  direction?: "asc" | "desc";
  /** Narrow the Firestore query to these autoCaseId values (casebook case-items list only). Rows are
   *  still run through the identical gates below, so a narrowed scan is a strict subset of the
   *  unnarrowed one. Needs the conversations composite index with autoCaseId (firestore.indexes.json). */
  autoCaseIds?: readonly string[];
}): Promise<UnrepliedInboxScopeScanResult> {
  const { access, mailAccountId, limit, cursor, registrationGate, shouldContinue } = input;
  const scanDirection = input.direction === "desc" ? "desc" : "asc";
  const narrowCaseIds = input.autoCaseIds && input.autoCaseIds.length > 0 ? [...input.autoCaseIds] : null;
  let fixedReadTime = input.readTime
    ? new Timestamp(input.readTime.seconds, input.readTime.nanoseconds)
    : null;

  const policy = input.policy ?? await (async (): Promise<UnrepliedInboxScopeScanPolicy> => {
    const [settings, mailRoutingByOrgId] = await Promise.all([
      readSettings(),
      // disabledOrgSharesMailAccount 전용 — readMailRoutingCached 는 이 판정에 못 쓴다
      // (mailAccounts.ts 주석 참조). Exact precompute passes this first-page policy snapshot
      // back on resumed calls so configuration cannot change the filter between pages. Its
      // fail-closed mode must surface a routing read failure: substituting {} could count rows
      // belonging to a disabled org that shares the canonical SCP mailbox.
      input.policyFailureMode === "fail_closed"
        ? readMailRouting().then((routing) => routing.byOrgId)
        : readMailRouting().then((routing) => routing.byOrgId).catch(() => ({}) as Readonly<Record<string, string>>),
    ]);
    return {
      disabledOrgIds: [...settings.automation.autoReplyDisabledOrgIds],
      mailRoutingByOrgId: { ...mailRoutingByOrgId },
    };
  })();
  const disabledOrgIds = policy.disabledOrgIds;

  // Codex 적대 리뷰(2026-09-26) MEDIUM 수리: 스캔 상한을 한 페이지로 끝내면, 다른 조직/계정의
  // 행이 그 300건 창을 먼저 채웠을 때 이 호출자의 정당한(더 오래된) 대기 행이 통째로 안 보일 수
  // 있다 — readCollection 의 backfill 스캔 루프(MAX_HIDDEN_PAGE_SCAN_PAGES)와 같은 원리로,
  // 승인된 후보가 limit 만큼 모이거나 페이지 상한에 닿을 때까지 이어서 스캔한다.
  const candidates: Record<string, unknown>[] = [];
  let lastPageSize = 0;
  // A resumed scan starts exactly after the previous call's window instead of from the beginning
  // of the collection (see listUnrepliedInboxHandler's requestedCursor doc comment).
  let lastPageSort: [string, string] | null = cursor ? [cursor.orderValue, cursor.docId] : null;
  for (let page = 0; page < UNREPLIED_INBOX_MAX_SCAN_PAGES; page += 1) {
    if (shouldContinue && !shouldContinue()) break;
    let baseQuery = adminDb
      .collection("conversations")
      .where("lastMessageFrom", "==", "creator")
      .where("autoReplyStatus", "in", [...UNREPLIED_INBOX_STATUSES]);
    if (narrowCaseIds) {
      baseQuery = narrowCaseIds.length === 1
        ? baseQuery.where("autoCaseId", "==", narrowCaseIds[0])
        : baseQuery.where("autoCaseId", "in", narrowCaseIds);
    }
    let query = baseQuery
      .orderBy("lastInboundAtIso", scanDirection)
      .orderBy(FieldPath.documentId(), scanDirection)
      .limit(UNREPLIED_INBOX_SCAN_LIMIT);
    if (lastPageSort) query = query.startAfter(lastPageSort[0], lastPageSort[1]);
    const snapshot = fixedReadTime
      ? await adminDb.runTransaction(
          (transaction) => transaction.get(query),
          { readOnly: true, readTime: fixedReadTime },
        )
      : await query.get();
    fixedReadTime ??= snapshot.readTime;
    lastPageSize = snapshot.size;
    for (const doc of snapshot.docs) {
      const row: Record<string, unknown> = { id: doc.id, ...doc.data() };
      lastPageSort = [asString(row.lastInboundAtIso, ""), doc.id];
      if (!registrationGate(row)) continue;
      if (!canReadConversationRowForScope(row, access, mailAccountId)) continue;
      if (
        isAutoReplyOrgExcluded({ orgId: row.orgId, mailAccountId, disabledOrgIds }) ||
        disabledOrgSharesMailAccount(disabledOrgIds, mailAccountId, policy.mailRoutingByOrgId)
      ) continue;
      candidates.push(row);
    }
    if (snapshot.size < UNREPLIED_INBOX_SCAN_LIMIT) break;
    // Codex 적대 리뷰(2026-09-26) MEDIUM 재검증: 여기서 `limit`(기본 50) 만큼만 모으고 멈추면,
    // 그 후보들 중 다수가 아래 manual-reply 재검증에서 걸러질 때(이미 수동으로 답장된 케이스)
    // 실제로 더 있었을 유효한 후보를 놓칠 수 있다 — manual-reply 검사 예산과 같은 상한
    // (UNREPLIED_INBOX_MAX_LIMIT)까지는 여유를 두고 모은다.
    if (candidates.length >= UNREPLIED_INBOX_MAX_LIMIT) break;
  }

  const rows: Record<string, unknown>[] = [];
  let manualReplyChecks = 0;
  // Flu conversation org-filter round 5 (codex adversarial review round 5, finding #4): tracks
  // whether every already-scanned, already-authorized candidate was examined for this response —
  // false the moment the loop stops early (the `limit` was reached, or the manual-reply check
  // budget was spent) while candidates still remain unexamined. Also subsumes origin/main's
  // casebook round 7 fix (processedCandidateCount/candidateCheckCutShort, merged 2026-09-28): both
  // track the identical "did the loop stop before visiting every candidate" condition, folded into
  // `truncated` below — this branch's version additionally drives the cursor (round 10).
  let examinedAllCandidates = true;
  // Flu conversation org-filter round 10 (codex adversarial review round 10, finding #1): the LAST
  // candidate that actually finished a manual-reply check (detectManualReplySinceInbound resolved
  // for it), regardless of whether it was filtered out or pushed to `rows`. Round 5's cursor used
  // the last RETURNED row instead — if the check budget (UNREPLIED_INBOX_MAX_LIMIT) is spent before
  // any candidate survives filtering (e.g. the first 200 of 201 candidates were all already
  // manual-replied), `rows` stays empty, that cursor came back null, and candidate #201 became
  // permanently unreachable with the response looking like a genuinely empty inbox.
  let lastExaminedRow: Record<string, unknown> | null = null;
  for (const row of candidates) {
    if (shouldContinue && !shouldContinue()) {
      examinedAllCandidates = false;
      break;
    }
    if (rows.length >= limit) {
      examinedAllCandidates = false;
      break;
    }
    // manual-reply defense-in-depth (functions/manualReplyDetection.ts) — scp 가 이미 Gmail 에서
    // 수동으로 답장했는데 스티치(externalSentConversationStitch.ts)가 아직
    // conversation.lastMessageFrom 을 못 따라잡은 경우를 잡는다. 비용 상한: 이 인박스는 원래
    // 작아야 하는 큐지만, 만에 하나 크게 불어나도 요청당 검사 횟수를 캡핑한다(오래된 순으로
    // 우선 검사하므로 상한에 걸려도 가장 급한 건부터 채운다).
    manualReplyChecks += 1;
    if (manualReplyChecks > UNREPLIED_INBOX_MAX_LIMIT) {
      examinedAllCandidates = false;
      break;
    }
    const manualReply = await detectManualReplySinceInbound({
      creatorEmail: asString(row.creatorEmail, ""),
      lastInboundAtIso: asString(row.lastInboundAtIso, ""),
      readTime: fixedReadTime ?? undefined,
    });
    lastExaminedRow = row;
    if (manualReply.detected) continue;
    rows.push(row);
  }

  // Flu conversation org-filter round 5/10 (codex adversarial review round 5 finding #4, round 10
  // finding #1): the OLD cursor only ever looked at whether the Firestore SCAN window was
  // exhausted (lastPageSort) — with e.g. 75 already-scanned, already-authorized candidates and
  // limit=50 in one short/final scan page, the scan itself was exhausted (scanWindowExhausted=
  // false) so nextCursor came back null even though 25 real candidates already sat in memory,
  // unreturned. Resume from the LAST EXAMINED candidate (round 10: not just the last RETURNED one
  // — a candidate that was checked and filtered out still counts as "examined", and the cursor
  // must still advance past it) whenever the rows loop stopped before examining every candidate —
  // this is independent of (and takes priority over) whether the underlying scan window itself has
  // more unscanned documents beyond it.
  const truncatedByReturnLimit = !examinedAllCandidates && Boolean(lastExaminedRow);
  const scanWindowExhausted = lastPageSize >= UNREPLIED_INBOX_SCAN_LIMIT;
  const truncated = truncatedByReturnLimit || scanWindowExhausted;
  const nextCursor = truncatedByReturnLimit && lastExaminedRow
    ? encodePageCursor({ docId: asString(lastExaminedRow.id, ""), orderValue: asString(lastExaminedRow.lastInboundAtIso, "") })
    : scanWindowExhausted && lastPageSort
      ? encodePageCursor({ docId: lastPageSort[1], orderValue: lastPageSort[0] })
      : null;
  const resolvedReadTime = fixedReadTime ?? Timestamp.now();
  return {
    rows,
    total: candidates.length,
    truncated,
    nextCursor,
    readTime: { seconds: resolvedReadTime.seconds, nanoseconds: resolvedReadTime.nanoseconds },
    readTimeIso: resolvedReadTime.toDate().toISOString(),
    policy,
  };
}

export const listEscalations = (request: CallableRequestShape) => listTargetableDatasetPage(request, "escalations", "escalations");
export const listSubmissions = (request: CallableRequestShape) => listTargetableDatasetPage(request, "submissions", "submissions");
export const listReviews = (request: CallableRequestShape) => listTargetableDatasetPage(request, "reviews", "reviews");
export const listScpLifecycleProfiles = async (request: CallableRequestShape) => {
  // 2026-09-27 codex adversarial review round 5 FAIL-1: rounds 2/3 gated this on scp mailbox
  // entitlement, but the owner's scope decision keeps lifecycle profile reads role-only — this
  // list backs the general-purpose Influencer list page (src/app/(app)/flu/influencers/page.tsx),
  // reachable by every org regardless of scp mailbox entitlement, same as getScpLifecycleProfile/
  // getScpLifecycleVideoHistory/getScpLifecycleFlowConfig (see the scope-decision comment above
  // assertScpEntitled in mailAccounts.ts). Role-only access via listDatasetPage below (its own
  // assertNonGuestAuth + canReadDatasetKey check) is correct — do not re-add an entitlement gate
  // here without confirming with 헤세 first.
  const data = asRecord(request.data);
  const requestedProgramId = asString(data.programId);
  const aliasMap = requestedProgramId ? await readConfirmedProgramAliasMap() : {};
  const canonicalProgramId = requestedProgramId
    ? resolveCanonicalProgramId(requestedProgramId, aliasMap)
    : "";
  const page = await listDatasetPage(
    request,
    "scpLifecycleProfiles",
    "scp_lifecycle_profiles",
    scpLifecycleProfileFilters(data, canonicalProgramId),
  );
  const cursorRequested = asString(data.cursor);
  // Management fallback rows are additive only on the first page. Returning here prevents every cursor
  // request from paying for a 200-row intake window and then discarding the result.
  if (cursorRequested) return page;
  try {
    if (canonicalProgramId) {
      // Keep the confirmed alias graph inside Firestore's bounded read contract. This validation is
      // deliberately part of the graceful fallback path: an oversized graph must not kill the
      // lifecycle profile page that was already read successfully.
      confirmedProgramIdentitySet(
        canonicalProgramId,
        aliasMap,
        MAX_CONFIRMED_PROGRAM_IDENTITIES,
      );
    }
    const { records, truncated } = await listApplicationManagementLifecycleFallbackRecords(
      APPLICATION_MANAGEMENT_FALLBACK_WINDOW_SIZE,
    );
    // Dedup only against profile identifiers present in the same bounded intake window. A collection-wide
    // lifecycle scan was 100x+ more expensive in production (3,421 profiles) and ran even on cursor pages.
    const lifecyclePopulation = records.length > 0
      ? await readLifecycleProfileFallbackRows(records)
      : [];
    const { visibleRecords, otherProgramCount } = partitionApplicationManagementFallbackWindow(
      records,
      [...lifecyclePopulation, ...page.rows],
      canonicalProgramId,
      page.rows,
    );
    const signaledPage = {
      ...page,
      pageInfo: {
        ...page.pageInfo,
        // This count has the same population as the intake rows: only management records in the
        // latest 200-record window that survived lifecycle-profile deduplication.
        otherProgramCount,
        truncated: Boolean(page.pageInfo?.truncated) || truncated,
      },
    };

    // B2-7: accepted Apply 의 완료 조건은 메일 outbox + scp_application_management 두 projection 이고,
    // 후자만 있는 Apply(management-only)는 lifecycle 소스가 아니어서 관리 목록 universe 에서 빠졌다.
    // 여기서 **읽기 시점에** 같은 fallback 투영(상세 경로와 동일한 한 벌)을 additive 하게 얹는다 —
    // 새 컬렉션·새 콜러블·복사본 없이, 이미 있는 프로필과 겹치지 않는 것만.
    if (visibleRecords.length === 0) return signaledPage;
    const enrichedVisibleRecords = await enrichApplicationManagementProvenance(adminDb, visibleRecords);

    const computedAtIso = new Date().toISOString();
    const appended = enrichedVisibleRecords.map(
      (record) => applicationManagementFallbackProfileRow(record, computedAtIso),
    );
    return {
      ...signaledPage,
      rows: [...page.rows, ...appended],
    };
  } catch {
    // Fallback/alias/profile-dedup failure must not destroy the lifecycle profile page.
    return page;
  }
};
export const listCandidatePool = (request: CallableRequestShape) => listDatasetPage(request, "candidatePool", "candidate_pool");
const CANONICAL_PROGRAM_CURSOR_VERSION = "canonical-program-registry-v1";

export const listPrograms = async (request: CallableRequestShape): Promise<DatasetPageEnvelope> => {
  const auth = assertNonGuestAuth(request, "data.programs.list");
  if (!canReadDatasetKey(auth.role, "programs")) {
    const error = new Error("permission-denied: programs requires a higher role");
    Object.assign(error, { code: "permission-denied", errorCode: "list_programs_programs_requires_higher_role", behaviorLog: makeBehaviorLog(auth, "data.programs.list", "error") });
    throw error;
  }
  const requestData = asRecord(request.data);
  const limit = pageSize(typeof requestData.limit === "number" ? requestData.limit : DEFAULT_PAGE_SIZE);
  const aliasMap = await readConfirmedProgramAliasMap();
  const sourceRead = await readCollection(
    "programs",
    MAX_PAGE_SIZE,
    undefined,
    collectionOrderForKey("programs"),
    auth,
    "programs",
    [],
    null,
    null,
    undefined,
    false,
    await datasetAccountOwnershipFilter(request, auth, "programs"),
  );
  if (sourceRead.pageInfo.truncated) {
    throw Object.assign(new Error("failed-precondition: canonical program list exceeds its bounded source read contract"), { code: "failed-precondition", errorCode: "list_programs_canonical_program_list_exceeds_its" });
  }
  const canonicalRows = mergeConfirmedProgramRows(sourceRead.rows, aliasMap);
  const requestedCursor = asString(requestData.cursor);
  let startIndex = 0;
  if (requestedCursor) {
    const cursor = decodePageCursor(requestedCursor);
    if (!cursor || cursor.orderValue !== CANONICAL_PROGRAM_CURSOR_VERSION) {
      throw Object.assign(new Error("invalid-argument: canonical programs cursor is invalid"), { code: "invalid-argument", errorCode: "list_programs_canonical_programs_cursor_invalid" });
    }
    const matchedIndex = canonicalRows.findIndex((row) => asString(row.id) === cursor.docId);
    if (matchedIndex < 0) {
      throw Object.assign(new Error("failed-precondition: canonical programs cursor is stale"), { code: "failed-precondition", errorCode: "list_programs_canonical_programs_cursor_stale" });
    }
    startIndex = matchedIndex + 1;
  }
  const rows = canonicalRows.slice(startIndex, startIndex + limit);
  const hasMoreCanonicalRows = startIndex + rows.length < canonicalRows.length;
  const nextCursor = hasMoreCanonicalRows && rows.length > 0
    ? encodePageCursor({ docId: asString(rows.at(-1)?.id), orderValue: CANONICAL_PROGRAM_CURSOR_VERSION })
    : null;
  return {
    ok: true,
    key: "programs",
    rows,
    counts: { programs: rows.length },
    pageInfo: {
      limit,
      truncated: hasMoreCanonicalRows,
      nextCursor,
    },
    cache: {
      generatedAtIso: new Date().toISOString(),
      maxAgeSeconds: CACHE_MAX_AGE_SECONDS,
      requestedKeys: ["programs"],
    },
    behaviorLog: makeBehaviorLog(auth, "data.programs.list", "success"),
  };
};
export const listProgramApplications = (request: CallableRequestShape) => listTargetableDatasetPage(request, "programApplications", "program_applications");
export const listProgramSheetLeads = (request: CallableRequestShape) => listTargetableDatasetPage(request, "programSheetLeads", "program_sheet_leads");
export const listCreatorCommentInsights = (request: CallableRequestShape) => listDatasetPage(request, "creatorCommentInsights", "creator_comment_insights");

/**
 * Flu/Task-50 적대 리뷰 P0-2 — super_admin "대신 보기"가 Chat 목록/메시지/원문 읽기 스코프에도
 * 적용되도록, resolveViewAsTarget(functions/mailAccountCallables.ts, members 컬렉션 재조회로
 * 검증됨)이 있으면 그 대상자의 role/email로 파생된 auth를 만든다 — 아래
 * resolveRequestedMailAccountId/canReadConversationForAuth/resolveConversationOrgScope 는 전부
 * 이 파생 auth만 받아 접근 가능 계정 판정이 대상자 기준으로 계산되게 한다. 원본 auth(호출자 자신)는 감사 로그
 * (makeBehaviorLog)에 그대로 남는다 — 이 함수는 스코프 계산에만 쓰는 파생값을 만들 뿐이다.
 * viewAs 미요청이거나 대상자가 없으면 원본 auth를 그대로 돌려준다.
 */
export async function effectiveConversationAuth(
  auth: ReturnType<typeof assertNonGuestAuth>,
  requestData: Record<string, unknown>,
): Promise<ReturnType<typeof assertNonGuestAuth>> {
  const target = await resolveViewAsTarget(auth, requestData);
  if (!target) return auth;
  return { ...auth, role: target.role ?? "viewer", userId: target.uid, email: target.email };
}

/**
 * Resolve the positive mail-account entitlement used by every conversation list/room/source
 * read. The strict account-view policy is intentionally separate from the infrastructure resolver:
 * it never turns routing.defaultAccountId into a caller grant. super_admin retains the explicit
 * administrative ability to inspect every configured account; all other roles use the same
 * personal/explicit-parent-mapped set that powers the Chat account toggle.
 *
 * Flu conversation org-filter round 2 (codex adversarial review): this resolver and the row
 * predicate below now live in functions/conversationMailAccessScope.ts — the shared choke point
 * every conversation-reading/-mutating surface uses (dashboardPipelineProjection.ts, chat-ai.ts,
 * managementProfileTabsPorts.ts), not just this file's own list/room/source reads.
 */
type MailConversationReadAccess = ConversationMailAccessScope;

async function resolveMailConversationReadAccess(
  auth: ReturnType<typeof assertNonGuestAuth>,
): Promise<MailConversationReadAccess> {
  return resolveConversationMailAccessScope(auth);
}

/**
 * Validate a client-supplied account-view ID against the strict positive entitlement set before
 * it reaches a row predicate. Blank means "all accounts in the already-authorized set"; it never
 * means "fall back to SCP".
 */
async function resolveRequestedMailAccountId(
  auth: ReturnType<typeof assertNonGuestAuth>,
  requestedMailAccountId: string,
  access?: MailConversationReadAccess,
): Promise<{ mailAccountId: string; access: MailConversationReadAccess }> {
  const mailAccountId = requestedMailAccountId.trim();
  const resolvedAccess = access ?? await resolveMailConversationReadAccess(auth);
  if (!mailAccountId) return { mailAccountId: "", access: resolvedAccess };
  if (!resolvedAccess.authorizedMailAccountIds.includes(mailAccountId)) {
    const error = new Error(`permission-denied: mailAccountId is not accessible to this caller: ${mailAccountId}`);
    Object.assign(error, {
      code: "permission-denied",
      errorCode: "conversation_read_mail_account_not_accessible",
    });
    throw error;
  }
  return { mailAccountId, access: resolvedAccess };
}

function canReadConversationForAuth(
  row: Record<string, unknown>,
  access: MailConversationReadAccess,
  requestedMailAccountId = "",
): boolean {
  return canReadConversationRowForScope(row, access, requestedMailAccountId);
}

/**
 * Flu/Task-47: does `row` pass the counterparty-registration gate? `counterpartyRegistered` is
 * stamped ONLY on personal-account conversations (functions/chat-ai.ts persistReceivedEmail) —
 * scp/canonical conversations and every pre-existing row from before this stamp shipped never
 * get the field at all, so they pass through unfiltered (same "legacy row stays visible"
 * compatibility rule resolveConversationOrgScope's orgId check already uses below). Only a row
 * explicitly resolved to `counterpartyRegistered === false` is ever hidden, and only from a
 * non-admin role or an admin who did not opt in — client-supplied `includeUnregistered` is
 * re-checked against `role` here, never trusted as-is.
 *
 * Pure (no Firestore) so it is unit-testable without the emulator chat-org-scope.test.mjs
 * needs for the org half of this scope.
 */
export function conversationRegistrationGateFilter(
  role: ReturnType<typeof assertNonGuestAuth>["role"],
  includeUnregistered: boolean,
): (row: Record<string, unknown>) => boolean {
  const showUnregistered = (role === "super_admin" || role === "admin") && includeUnregistered === true;
  return (row) => showUnregistered || row.counterpartyRegistered !== false;
}

/**
 * PLAN-ORG-MAIL-IDENTITY: conversation-list scope. Filters the already-fetched page in memory
 * (conversations has no mail-account index, and adding a Firestore `where` here would need a new
 * composite index) rather than changing the query shape. Every role receives only its strict
 * server-derived account whitelist; legacy blank rows are canonical SCP only when that whitelist
 * includes SCP. Admin may still pass an explicit orgId filter and super_admin keeps its inventory
 * view.
 *
 * Flu/Task-47 folds the registration gate (conversationRegistrationGateFilter above) into the
 * SAME returned filter — one predicate, applied inside readCollection's scan/backfill loop, same
 * as the Slice 5 fix comment on readCollection's extraRowFilter documents for orgId.
 */
async function resolveConversationOrgScope(
  auth: ReturnType<typeof assertNonGuestAuth>,
  requestedOrgId: string,
  includeUnregistered: boolean,
  requestedMailAccountId = "",
): Promise<{
  viewerOrgId: string | null;
  orgFilterApplied: boolean;
  mailAccountId: string;
  filter: (row: Record<string, unknown>) => boolean;
}> {
  const registrationGate = conversationRegistrationGateFilter(auth.role, includeUnregistered);
  // Validate the optional account view and resolve its positive entitlement set once. The same
  // predicate is reused by list backfill and targeted reads, so an account-sparse page cannot
  // accidentally turn a missing mailAccountId into a wildcard.
  const { mailAccountId, access } = await resolveRequestedMailAccountId(
    auth,
    requestedMailAccountId,
  );
  const accountGate = (row: Record<string, unknown>) =>
    canReadConversationForAuth(row, access, mailAccountId);
  if (auth.role === "super_admin" || auth.role === "admin") {
    const target = requestedOrgId.trim();
    // Flu conversation org-filter round 2 (codex adversarial review): compare through
    // canonicalScpOrgId on both sides so an admin filtering by "G005" also matches rows stamped
    // "T056" and vice versa — the same alias the scp per-org gate itself already applies.
    const canonicalTarget = target ? canonicalScpOrgId(target) : "";
    return {
      viewerOrgId: access.viewerOrgId,
      orgFilterApplied: Boolean(target),
      mailAccountId,
      filter: canonicalTarget
        ? (row) => canonicalScpOrgId(asString(row.orgId)) === canonicalTarget && registrationGate(row) && accountGate(row)
        : (row) => registrationGate(row) && accountGate(row),
    };
  }
  return {
    viewerOrgId: access.viewerOrgId,
    orgFilterApplied: true,
    mailAccountId,
    filter: (row) => registrationGate(row) && accountGate(row),
  };
}

const PRIVATE_CONVERSATION_RECORD_KEYS = new Set([
  "providermessageid",
  "providermessageidnormalized",
  "matchedoutboundprovidermessageid",
  "matchedoutboundmatchedprovidermessageid",
  "inreplyto",
  "inreplytoprovidermessageid",
  "references",
  "replyheaders",
  "headers",
  "transport",
  "transportresponse",
  "provider",
  "providerid",
  "providermetadata",
  "providerrunid",
  "runid",
  "capability",
  "capabilities",
  "gatewaybypassed",
  "smtp",
  "imap",
  "envelope",
  "response",
  "command",
  "accepted",
  "rejected",
  "acceptedmasked",
  "rejectedmasked",
  "error",
  "errormessage",
  "errortext",
  "lasterror",
  "lastautoreplyerror",
  "failure",
  "failurereason",
  "failurestack",
  "stack",
  "runtimemetadata",
  "secret",
  "password",
  "credential",
  "authorization",
  "apikey",
  "token",
  "endpoint",
  "host",
  "hostname",
  "remoteip",
  "ipaddress",
  "recipient",
]);

function normalizedPrivateKey(value: string): string {
  return value.toLowerCase().replace(/[_-]/g, "");
}

/**
 * W128: 대화 레코드 공개 투영의 **기본 정책은 드랍(fail-closed)** 이다.
 *
 * 형제 축인 `PRIVATE_CONVERSATION_RECORD_KEYS` 는 denylist 라 "목록에 없으면 통과" 로 동작했다.
 * 업스트림이 새 필드를 하나 쓰면 아무도 목록을 갱신하지 않는 한 그대로 클라이언트로 나간다 —
 * 지금 안 새는 것은 우연이지 구조가 아니다(SEC-P0-009 를 구조적으로 못 지킨다).
 * 프로드 실측(conversations 11,508문서 전수)에서 denylist 가 실제로 막은 최상위 키는 97개 중 1개뿐이었다.
 *
 * 그래서 정책을 뒤집는다: **여기 있는 키만 통과하고 나머지는 전부 드랍**한다. denylist 는 그대로
 * 앞단에 남겨 둔다(이미 합의된 항목을 두 번 막는 비용은 0이고, 목록이 줄면 의도가 흐려진다).
 *
 * 비교는 `normalizedPrivateKey`(소문자화 + `_`/`-` 제거)를 거친 형태로 한다 — 원본 키 이름은
 * 그대로 내보내므로 클라이언트 계약은 변하지 않는다. 재귀 호출이 같은 집합을 쓰므로
 * **중첩 레코드에도 동일하게 적용**된다(최상위만 닫으면 중첩이 구멍으로 남는다).
 *
 * ■ 키를 추가하려는 다음 사람에게: "원장에 있으니까" 는 근거가 아니다. **화면(또는 정렬/필터 같은
 *   서버 소비처)이 그 키를 실제로 읽는다**는 것을 확인하고, 아래 그룹 중 맞는 자리에 넣어라.
 *   읽는 곳이 없으면 넣지 마라 — 그게 이 목록의 존재 이유다.
 */
const PUBLIC_CONVERSATION_RECORD_KEYS = new Set([
  // 문서·스레드 신원. 화면이 행을 식별하고 스레드로 묶는 축이다.
  "id",
  "threadId",
  "contextKey",
  "type",

  // 크리에이터 표시 신원. 목록/헤더에 그대로 렌더된다(chat-normalization.ts 의 명시적 읽기).
  "creatorId",
  "creatorName",
  "creatorAvatar",
  "creatorEmail",
  "creatorHandle",
  "creatorPlatform",
  "creatorFollowers",
  "channelId",
  "youtubeUrl",
  "profileMatchedEmail",
  "profileSourceRef",
  "profileSnapshotUpdatedAtIso",
  "candidateId",

  // 워크플로 링크 id. 화면이 이 값으로 프로그램/캠페인/신청서를 조인한다.
  "programId",
  "canonicalProgramId",
  "programTitle",
  "campaignId",
  "campaignTitle",
  "applicationId",
  "applicationRef",

  // PLAN-ORG-MAIL-IDENTITY Slice 5: /chat 의 admin 전용 조직 필터(src/app/(app)/chat/page.tsx)가
  // 클라이언트 사이드로 이 값을 읽어 필터링한다 — 서버 스코프(resolveConversationOrgScope)는
  // 이미 manager/viewer 를 걸러 두므로 여기 노출은 새 정보 유출이 아니다.
  "orgId",

  // Flu/Task-47: 서버가 이미 필터링을 끝낸 뒤(resolveConversationOrgScope) 노출하는 판정
  // 불리언/참조값 — admin '미등록 보기' 토글로 넘어온 행을 화면이 구분해 보여줄 수 있게 한다.
  "counterpartyRegistered",
  "candidateRef",

  // 상태·판정. 배지·필터·게이트 분기의 입력이다.
  "aiActive",
  "unread",
  "alert",
  "protected",
  "source",
  "visibility",
  "hiddenFromDefaultChat",
  "routeReason",
  "hasCreatorReply",
  "humanGate",
  "manualIntervention",
  "deliveryState",
  "lastDeliveryState",
  "outreachStatus",
  "status",
  "participationActive",
  "participationStatus",
  "participationStage",
  "autoReplyStatus",
  "autoReplyBlockedReason",
  // auto-close 정책(B): autoReplyStatus="closed" 인 대화의 종결 사유·시각 — blockedReason 과
  //   같은 게이트 reason 문자열/ISO 시각이라 노출 정책이 동일하다.
  "autoReplyClosedReason",
  "autoReplyClosedAtIso",
  "autoReplyDraftText",
  "autoReplyQueueRef",

  // 시각. 정렬 축(sortConversationRows)과 화면 표시를 겸한다.
  // `createdAtIso` 는 화면이 아니라 **서버 정렬기**가 읽는 폴백 축이라 반드시 남아야 한다.
  "createdAtIso",
  "updatedAtIso",
  "lastMessageAtIso",
  "lastInboundAtIso",
  "participationUpdatedAtIso",
  "nextAutoReplyAtIso",
  // 가시성 필터(archived/deleted)는 값이 있으면 행을 숨긴다 — 드랍하면 숨어야 할 행이 보인다.
  "archivedAt",
  "archivedAtIso",
  "deletedAt",
  "deletedAtIso",

  // 담당자 표시. flu 대시보드가 캠페인 소유자 라벨로 읽는다(conversationField 리터럴 호출).
  "ownerName",
  "ownerEmail",

  // 마지막 메시지 프리뷰. `messages` 컨테이너는 여기를 통과한 뒤
  // `projectConversationRecordForClient` 가 메시지 허용목록 투영으로 **덮어쓴다**.
  "lastMessage",
  "lastMessageFrom",
  "lastMessageRef",
  "messages",

  // 사람 검수용 참고 초안. needs_review 화면이 운영자에게 그대로 보여주는 값이다.
  "humanDraftSuggestion",
  "humanDraftSuggestionKr",

  // 귀속(attribution) 상태와 그 중첩 항목. 중첩도 같은 집합으로 걸러지므로 하위 키까지 여기 있어야 한다.
  "attribution",
  "attributionStatus",
  "attributionReviewRequired",
  "lastAttributionAuditRef",
  "original",
  "suggested",
  "final",
  "policyVersion",
  "version",
  "reviewRequired",
  "primaryBucket",
  "reasonId",
  "confidence",
  "decidedAtIso",

  // manualIntervention 중첩 항목(`status` 는 위 상태 그룹과 공유).
  "reason",
  "requestedAt",
  "requestedBy",
].map(normalizedPrivateKey));

/** 드랍 건수만 세는 누산기. 키 이름은 담지 않는다 — 키 이름 자체가 스키마 정보다. */
type ConversationProjectionDropStats = {
  records: number;
  droppedKeys: number;
};

function projectCanonicalOutboundFailureEvidence(
  value: Record<string, unknown>,
): Record<string, string> {
  const failure = canonicalOutboundFailure(value.failureKind);
  const correlationIdHash = asString(value.correlationIdHash).toLowerCase();
  if (!failure || !/^[a-f0-9]{24}$/.test(correlationIdHash)) return {};
  return {
    failureKind: failure.kind,
    failureRuleId: failure.ruleId,
    failureReason: failure.reason,
    errorCode: `mail_outbound_${failure.kind}`,
    correlationIdHash,
  };
}

function sanitizeConversationRecordValue(
  value: unknown,
  stats?: ConversationProjectionDropStats,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeConversationRecordValue(item, stats));
  }
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(
    record,
  )) {
    const normalizedKey = normalizedPrivateKey(key);
    if (PRIVATE_CONVERSATION_RECORD_KEYS.has(normalizedKey)) {
      if (stats) stats.droppedKeys += 1;
      continue;
    }
    if (
      normalizedKey === "providermessageidhash" ||
      normalizedKey === "matchedoutboundprovidermessageidhash"
    ) {
      const hash = asString(nestedValue).toLowerCase();
      if (/^[a-f0-9]{64}$/.test(hash)) safe[key] = hash;
      else if (stats) stats.droppedKeys += 1;
      continue;
    }
    if (
      normalizedKey === "correlationidhash" ||
      normalizedKey === "failurekind" ||
      normalizedKey === "failureruleid" ||
      normalizedKey === "errorcode"
    ) {
      // 원본은 버리고, 아래 `projectCanonicalOutboundFailureEvidence` 가 정본 4종을 다시 붙인다.
      continue;
    }
    // W128 기본 정책: 허용목록에 없으면 드랍한다. 처음 보는 키는 통과하지 못한다.
    if (!PUBLIC_CONVERSATION_RECORD_KEYS.has(normalizedKey)) {
      if (stats) stats.droppedKeys += 1;
      continue;
    }
    safe[key] = sanitizeConversationRecordValue(nestedValue, stats);
  }
  Object.assign(safe, projectCanonicalOutboundFailureEvidence(record));
  return safe;
}

const PUBLIC_CONVERSATION_MESSAGE_DELIVERY_STATES = new Set([
  "queued_for_review",
  "queued_for_send",
  "sent",
  "mock_sent",
  "received",
  "blocked",
]);

const PUBLIC_CONVERSATION_MESSAGE_HUMAN_GATES = new Set([
  "auto_reply",
  "needs_review",
  "blocked",
  // auto_close (종결 인사): 메시지에 "스레드가 자동 종결됐다"는 분류 표식으로만 노출된다 —
  //   발송·검수 어떤 후속 아이템도 만들어지지 않는다.
  "auto_close",
]);

/**
 * W116-H1: 클라이언트가 **메시지를 통째로 숨기는** 축이라 값 집합이 닫혀 있어야 한다.
 * 자유 문자열을 그대로 투영하면 원장 어딘가에 들어온 임의의 `hiddenReason` 이 조용히 대화를 지운다
 * (숨김은 화면에서 삭제와 구별되지 않는다). 형제 축(DELIVERY_STATES/HUMAN_GATES)과 같은 규칙을 쓴다.
 */
const PUBLIC_CONVERSATION_MESSAGE_HIDDEN_REASONS = new Set([
  "tool_duplicate",
]);

function boundedConversationMessageString(
  value: unknown,
  maxLength: number,
): string {
  return asString(value).slice(0, maxLength);
}

const PUBLIC_CHAT_AUTO_CASE_IDS = new Set(CHAT_CASEBOOK.map((item) => item.id));
const PUBLIC_CHAT_AUTO_REASON_IDS = new Set([
  "needs_review", "classified_case", "global_off", "conversation_off", "dry_run",
  "draft_only", "untrusted_sender", "sender_not_creator", "gateway_transport_unverified", "human_gate_not_auto_reply",
  "case_unclassified", "case_not_auto_ok", "unsupported_factual_claim", "unsupported_link_token",
  "unsupported_fact_token", "server_render_unavailable", "permit_missing", "permit_disarmed", "permit_case_mismatch",
  "pin_mismatch", "eval_missing", "eval_not_passed", "counter_floor_not_met",
  "counter_evidence_unavailable", "case_already_reserved", "case_already_sent",
  "mail_safety_blocked", "profile_disabled",
  // Task-91 확장 ④⑤: SCP 상태 문의 전용 사유(chatAutoCasePermit.ts ChatAutoCasePermitDenyReason).
  "scp_type_disabled", "scp_facts_unavailable",
]);

function projectChatAutoReviewFields(row: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  const caseId = asString(row.caseId);
  if (PUBLIC_CHAT_AUTO_CASE_IDS.has(caseId)) projected.caseId = caseId;
  const reasons = (value: unknown) => Array.isArray(value)
    ? [...new Set(value.filter((item): item is string =>
        typeof item === "string" && PUBLIC_CHAT_AUTO_REASON_IDS.has(item)))].slice(0, 12)
    : [];
  for (const field of ["clampReasonIds", "permitDenyReasons"] as const) {
    if (Array.isArray(row[field])) projected[field] = reasons(row[field]);
  }
  if (Array.isArray(row.autoRepliedCaseIds)) {
    projected.autoRepliedCaseIds = [...new Set(row.autoRepliedCaseIds.filter(
      (id): id is string => typeof id === "string" && PUBLIC_CHAT_AUTO_CASE_IDS.has(id),
    ))];
  }
  if (Array.isArray(row.caseCandidates)) {
    const candidates = new Map<string, Record<string, unknown>>();
    for (const value of row.caseCandidates) {
      const candidate = asRecord(value);
      const id = asString(candidate.caseId);
      if (!PUBLIC_CHAT_AUTO_CASE_IDS.has(id) || candidates.has(id)) continue;
      candidates.set(id, {
        caseId: id,
        title: id.replace(/_/g, " "),
        reasonCode: PUBLIC_CHAT_AUTO_REASON_IDS.has(asString(candidate.reasonCode))
          ? candidate.reasonCode : "needs_review",
        clampReasonIds: reasons(candidate.clampReasonIds),
      });
      if (candidates.size === 4) break;
    }
    projected.caseCandidates = [...candidates.values()];
  }
  return projected;
}

export function projectConversationMessageForClient(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const fromValue = asString(row.from);
  const from = fromValue === "creator" || fromValue === "human" || fromValue === "ai"
    ? fromValue
    : "ai";
  const text = boundedConversationMessageString(
    row.text ?? row.summaryKr ?? row.bodyPreview ?? row.body,
    20_000,
  );
  const projected: Record<string, unknown> = {
    id: boundedConversationMessageString(row.id, 240),
    from,
    author: boundedConversationMessageString(row.author, 240),
    text,
    time: boundedConversationMessageString(row.time, 120),
  };
  // 2026-10-05: say when the shown text IS the stored summary (no original text on this record, or
  // text identical to summaryKr) so /chat can badge it 요약본 instead of presenting it as the original.
  const summaryKr = typeof row.summaryKr === "string" ? row.summaryKr.trim() : "";
  const rawText = typeof row.text === "string" ? row.text.trim() : "";
  if (summaryKr && (rawText ? rawText === summaryKr : row.text === undefined || row.text === null)) projected.textSource = "summary";
  for (const [key, maxLength] of [
    ["createdAtIso", 80],
    ["sentAtIso", 80],
    ["receivedAtIso", 80],
    ["mailEventAtIso", 80],
    ["messageRef", 320],
    // 0.6.107 E: 메시지를 소유한 실제 conversations 문서 id — 병합 스레드에서 composer 가 replyToMessageRef 와 같은 대화에 바인딩하도록.
    ["conversationId", 240],
    ["trackingId", 240],
    ["campaignId", 240],
    ["programId", 240],
  ] as const) {
    const value = boundedConversationMessageString(row[key], maxLength);
    if (value) projected[key] = value;
  }
  const deliveryState = asString(row.deliveryState);
  if (PUBLIC_CONVERSATION_MESSAGE_DELIVERY_STATES.has(deliveryState)) {
    projected.deliveryState = deliveryState;
  }
  const humanGate = asString(row.humanGate);
  if (PUBLIC_CONVERSATION_MESSAGE_HUMAN_GATES.has(humanGate)) {
    projected.humanGate = humanGate;
  }
  // W116: 툴 발송과 중복으로 확인된 편입 메시지의 숨김 사유. 원장에서 지우는 대신 마킹만 하고
  // (되돌릴 수 있어야 한다) 클라이언트가 이 값으로 렌더에서 뺀다 — 허용값만 넘긴다.
  const hiddenReason = asString(row.hiddenReason);
  if (PUBLIC_CONVERSATION_MESSAGE_HIDDEN_REASONS.has(hiddenReason)) {
    projected.hiddenReason = hiddenReason;
  }
  Object.assign(projected, projectCanonicalOutboundFailureEvidence(row));
  Object.assign(projected, projectChatAutoReviewFields(row));
  return projected;
}

export function projectConversationRecordForClient(
  row: Record<string, unknown>,
  stats?: ConversationProjectionDropStats,
): Record<string, unknown> {
  if (stats) stats.records += 1;
  const projected = sanitizeConversationRecordValue(row, stats) as Record<string, unknown>;
  Object.assign(projected, projectChatAutoReviewFields(row));
  if (Array.isArray(row.messages)) {
    projected.messages = row.messages
      .filter(
        (message): message is Record<string, unknown> =>
          Boolean(message) &&
          typeof message === "object" &&
          !Array.isArray(message),
      )
      .map(projectConversationMessageForClient);
  }
  return projected;
}

function messageKey(row: Record<string, unknown>): string {
  return asString(row.messageRef) ||
    asString(row.sourceRef) ||
    `${asString(row.id)}:${asString(row.createdAtIso)}:${asString(row.from)}:${asString(row.text)}`;
}

function messageSortKey(row: Record<string, unknown>): number {
  const parsed = Date.parse(asString(row.createdAtIso));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function messageOrderId(row: Record<string, unknown>): string {
  return `${asString(row.conversationId)}/${asString(row.id)}`;
}

function messageCursorSortKey(cursor: PageCursor): number {
  const parsed = Date.parse(asString(cursor.orderValue));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function messageCursorForRow(row: Record<string, unknown>): PageCursor {
  return {
    docId: messageOrderId(row) || messageKey(row),
    orderValue: asString(row.createdAtIso) || null,
  };
}

function isAfterMessageCursor(row: Record<string, unknown>, cursor: PageCursor): boolean {
  const rowSort = messageSortKey(row);
  const cursorSort = messageCursorSortKey(cursor);
  if (rowSort !== cursorSort) return rowSort > cursorSort;
  return messageOrderId(row) > cursor.docId;
}

function dedupeMessages(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = messageKey(row);
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return Array.from(byKey.values());
}

export async function listConversationMessages(request: CallableRequestShape): Promise<ConversationMessagesEnvelope> {
  // chat-latency 계측 t0 — ReadPhaseTiming 주석 참조. 이 함수는 readCollection 을 거치지
  // 않으므로 queryMs 는 아래 seed/fan-out/messages 쿼리 전체를, scannedPages 는 스캔한
  // conversation 문서 수(문서당 messages 서브컬렉션 1페이지)를 담는다.
  const t0 = Date.now();
  const auth = assertNonGuestAuth(request, "data.conversationMessages.list");
  const requestData = asRecord(request.data);
  const conversationId = asString(requestData.conversationId);
  if (!conversationId) {
    const error = new Error("invalid-argument: conversationId required");
    Object.assign(error, { code: "invalid-argument", errorCode: "list_conversation_messages_conversation_id_required", behaviorLog: makeBehaviorLog(auth, "data.conversationMessages.list", "error") });
    throw error;
  }
  const boundedLimit = pageSize(typeof requestData.limit === "number" ? requestData.limit : DEFAULT_PAGE_SIZE);
  const decodedCursor = decodePageCursor(requestData.cursor);
  const threadId = asString(requestData.threadId, "");
  // Flu/Task-50 적대 리뷰 P0-2: super_admin "대신 보기" 대상이 있으면 아래 스코프 판정 전부 그
  // 대상자 기준(effectiveConversationAuth 주석 참조) — makeBehaviorLog는 계속 원본 auth를 쓴다.
  const tPolicy = Date.now();
  const scopeAuth = await effectiveConversationAuth(auth, requestData);
  const { mailAccountId: requestedMailAccountId, access } = await resolveRequestedMailAccountId(
    scopeAuth,
    asString(requestData.mailAccountId),
  );
  const policyMs = Date.now() - tPolicy;
  const tQuery = Date.now();
  const seedSnapshot = await adminDb.collection("conversations").doc(conversationId).get();
  const seed = seedSnapshot.data() ?? {};
  if (seedSnapshot.exists && !canReadConversationForAuth({ id: seedSnapshot.id, ...seed }, access, requestedMailAccountId)) {
    const error = new Error("permission-denied: conversation belongs to another account");
    Object.assign(error, { code: "permission-denied", errorCode: "list_conversation_messages_conversation_belongs_another_account", behaviorLog: makeBehaviorLog(auth, "data.conversationMessages.list", "error") });
    throw error;
  }
  const scopedData = { ...requestData, ...seed, conversationIds: requestData.conversationIds, conversationId };
  const canonicalThread = canonicalThreadIdForData(scopedData, conversationId) || threadId || conversationId;
  const requestedContextKey = asString(requestData.contextKey) || workflowContextKeyForData({
    ...scopedData,
    conversationId,
    threadId: canonicalThread,
  }, conversationId, canonicalThread);
  const conversationIds = conversationIdsForData({
    ...scopedData,
    threadId: canonicalThread,
  }, conversationId, 20);
  const rows: Record<string, unknown>[] = [];
  let collectionHasMore = false;
  const conversationSnapshots = await Promise.all(conversationIds.map((id) => adminDb.collection("conversations").doc(id).get()));
  for (const conversationSnapshot of conversationSnapshots) {
    if (!conversationSnapshot.exists) continue;
    const data = conversationSnapshot.data() ?? {};
    if (!canReadConversationForAuth({ id: conversationSnapshot.id, ...data }, access, requestedMailAccountId)) continue;
    if (requestedContextKey && workflowContextKeyForSnapshot(conversationSnapshot.id, data) !== requestedContextKey) continue;
    const embedded = Array.isArray(data.messages) ? data.messages : [];
    for (const [index, message] of embedded.entries()) {
      if (message && typeof message === "object" && !Array.isArray(message)) {
        const row = projectConversationMessageForClient({
          id: asString((message as Record<string, unknown>).id, `${conversationSnapshot.id}-embedded-${index}`),
          ...(message as Record<string, unknown>),
          conversationId: conversationSnapshot.id,
        });
        if (!decodedCursor || isAfterMessageCursor(row, decodedCursor)) rows.push(row);
      }
    }
    let query: Query = conversationSnapshot.ref.collection("messages")
      .orderBy("createdAtIso", "asc")
      .orderBy(FieldPath.documentId());
    if (decodedCursor) query = query.startAt(decodedCursor.orderValue ?? null);
    const snapshot = await query.limit(boundedLimit + 1).get();
    if (snapshot.docs.length > boundedLimit) collectionHasMore = true;
    for (const doc of snapshot.docs.slice(0, boundedLimit + 1)) {
      const row = projectConversationMessageForClient({
        id: doc.id,
        ...doc.data(),
        conversationId: conversationSnapshot.id,
      });
      if (!decodedCursor || isAfterMessageCursor(row, decodedCursor)) rows.push(row);
    }
  }
  const queryMs = Date.now() - tQuery;
  const tNormalize = Date.now();
  const merged = dedupeMessages(rows).sort((left, right) => messageSortKey(left) - messageSortKey(right) || messageOrderId(left).localeCompare(messageOrderId(right)));
  const hasMore = collectionHasMore || merged.length > boundedLimit;
  const messages = merged.slice(0, boundedLimit);
  const lastMessage = messages.at(-1);
  const normalizeMs = Date.now() - tNormalize;
  return {
    ok: true,
    conversationId,
    threadId: canonicalThread,
    contextKey: requestedContextKey,
    conversationIds,
    messages,
    pageInfo: {
      limit: boundedLimit,
      truncated: hasMore,
      nextCursor: hasMore && messages.length > 0 && lastMessage
        ? encodePageCursor(messageCursorForRow(lastMessage))
        : null,
    },
    cache: {
      generatedAtIso: new Date().toISOString(),
      maxAgeSeconds: CACHE_MAX_AGE_SECONDS,
      requestedKeys: ["conversationMessages"],
    },
    timing: {
      totalMs: Date.now() - t0,
      authMs: tPolicy - t0,
      policyMs,
      queryMs,
      normalizeMs,
      scannedPages: conversationSnapshots.length,
    },
    behaviorLog: makeBehaviorLog(auth, "data.conversationMessages.list", "success"),
  };
}

export async function getMessageSource(request: CallableRequestShape): Promise<MessageSourceEnvelope> {
  const auth = assertNonGuestAuth(request, "messageSource.read", ["super_admin", "admin", "manager", "viewer"]);
  const data = asRecord(request.data);
  const messageRef = asString(data.messageRef);
  if (!messageRef) {
    const error = new Error("invalid-argument: messageRef required");
    Object.assign(error, { code: "invalid-argument", errorCode: "get_message_source_message_ref_required", behaviorLog: makeBehaviorLog(auth, "messageSource.read", "error") });
    throw error;
  }

  const snapshot = await messageSourceRef(messageRef).get();
  const behaviorLog = makeBehaviorLog(auth, "messageSource.read", "success");
  if (!snapshot.exists) {
    return { ok: false, found: false, messageRef, behaviorLog };
  }

  const source = snapshot.data() ?? {};
  const sourceConversationId = asString(source.conversationId, "");
  // Resolve the same strict account view used by conversation list/room reads before exposing
  // any source body. A source with no conversation link must carry its own explicit account stamp;
  // a blank stamp alone cannot prove ownership of a source that has no conversation to authorize.
  const scopeAuth = await effectiveConversationAuth(auth, data);
  const { mailAccountId: requestedMailAccountId, access } = await resolveRequestedMailAccountId(
    scopeAuth,
    asString(data.mailAccountId),
  );
  const sourceMailAccountId = asString(source.mailAccountId, "");
  const denySourceRead = (message: string): never => {
    const error = new Error(`permission-denied: ${message}`);
    Object.assign(error, {
      code: "permission-denied",
      errorCode: "get_message_source_conversation_belongs_another_account",
      behaviorLog: makeBehaviorLog(auth, "messageSource.read", "error"),
    });
    throw error;
  };
  if (sourceConversationId) {
    const conversationSnapshot = await adminDb.collection("conversations").doc(sourceConversationId).get();
    if (!conversationSnapshot.exists) {
      return { ok: false, found: false, messageRef, behaviorLog };
    }
    const conversationRow: Record<string, unknown> = {
      id: conversationSnapshot.id,
      ...(conversationSnapshot.data() ?? {}),
    };
    if (!canReadConversationForAuth(conversationRow, access, requestedMailAccountId)) {
      denySourceRead("message source belongs to a conversation in another account");
    }
    // Source writers currently leave this field absent for legacy and provider-backed rows. If a
    // newer writer supplies it, require the source and conversation to identify the same account;
    // otherwise an independently stamped source could cross-link into an authorized room.
    if (sourceMailAccountId && normalizedMailAccountIdForRead(source) !== normalizedMailAccountIdForRead(conversationRow)) {
      denySourceRead("message source account does not match its conversation");
    }
  } else {
    // Orphan/unlinked source rows have no conversation identity from which to derive legacy SCP
    // ownership. Ordinary callers may read one only when the source itself proves an explicit
    // account entitlement; super_admin remains the administrative inventory exception.
    if (scopeAuth.role !== "super_admin" && !sourceMailAccountId) {
      denySourceRead("message source has no authorized conversation binding");
    }
    // Flu conversation org-filter round 2 (codex adversarial review): an orphan source has no
    // conversation to derive an orgId from, so a source explicitly stamped mailAccountId:"scp"
    // must go through the SAME scp-per-org gate as a linked conversation, not just the mailbox
    // entitlement check — canReadConversationRowForScope's org half (row.orgId is absent here)
    // fails closed for every non-super_admin caller, exactly as an unprovable org must.
    if (!canReadConversationRowForScope(source, access, requestedMailAccountId)) {
      denySourceRead("message source account is not accessible to this caller");
    }
  }
  if (!canReadDatasetKey(auth.role, "conversations")) {
    return {
      ok: false,
      found: true,
      reason: "scope",
      messageRef,
      behaviorLog: makeBehaviorLog(auth, "messageSource.read", "denied"),
    };
  }
  const canReadRaw = auth.role === "super_admin" || auth.role === "admin" || auth.role === "manager" || auth.role === "viewer";
  const canReadAddresses = canReadRaw;
  const summaryKr = sourceString(source, "summaryKr", 1000);
  const rawFrom = sourceString(source, "from", 240);
  // W116: 보낸편지함 편입(`external-sent-*`) 원장은 평문 수신자를 **의도적으로** 담지 않고
  // `toMasked` 만 갖는다(mailExternalSentImport — 테스트로 봉인). 그 행에서 `to` 만 읽으면 뷰어의
  // 수신자 줄이 통째로 비어 "원문을 못 가져왔다"처럼 읽힌다. 있는 값(이미 마스킹된 표기)을 쓴다.
  const rawTo = sourceString(source, "to", 240) ?? sourceString(source, "toMasked", 240);
  return {
    ok: true,
    found: true,
    messageRef,
    subject: sourceString(source, "subject", 300),
    from: canReadAddresses ? rawFrom : maskEmail(rawFrom),
    to: canReadAddresses ? rawTo : maskEmail(rawTo),
    direction: sourceString(source, "direction", 40),
    body: canReadRaw ? sourceString(source, "body", 20000) : summaryKr,
    // W116: 전문(`body`)이 없는 원장도 있다. 프리뷰를 실은 레인이면 그 값이라도 돌려주고,
    // 뷰어가 "프리뷰만 보존됨"을 정직하게 말한다. 둘 다 없으면 뷰어는 "본문이 원장에 없다"고
    // 말한다 — 빈 화면으로 침묵하지 않는다.
    //
    // ■ W117 갱신 (헤세 결정 2026-08-23): 이 분기는 더 이상 장래 대비가 아니다.
    //   보낸편지함 편입 레인이 이제 `body`(전문, 64K자 상한) + `bodyPreview`(240자)를
    //   `message_sources` 에 싣는다(mailExternalSentImport — 툴 발송 레인과 같은 노출 등급).
    //   그래서 **신규 편입분은 1단(`body`)** 으로 바로 떨어진다.
    //   2단(`bodyPreview`)은 두 부류가 남는다: ① 백필(hydrateExternalSentBodies)이 IMAP 에서
    //   원문을 되찾지 못해 원장 프리뷰만 있는 과거 편입분, ② 프리뷰만 싣는 다른 레인.
    //   3단(둘 다 없음)은 백필 이전의 과거 편입분이다 — 그 행은 여전히 해시만 갖는다.
    bodyPreview: canReadRaw ? sourceString(source, "bodyPreview", 400) : undefined,
    summaryKr,
    createdAtIso: sourceString(source, "createdAtIso", 80),
    sentAtIso: sourceString(source, "sentAtIso", 80),
    receivedAtIso: sourceString(source, "receivedAtIso", 80),
    mailEventAtIso: sourceString(source, "mailEventAtIso", 80),
    behaviorLog,
  };
}

function redactMemberMailAccountAccessForRole(row: Record<string, unknown>, role: Role): Record<string, unknown> {
  if (role === "super_admin") return row;
  const { mailAccountIds: _mailAccountIds, mailAccountAccessUpdatedBy: _mailAccountAccessUpdatedBy, mailAccountAccessUpdatedAtIso: _mailAccountAccessUpdatedAtIso, ...safe } = row;
  return safe;
}

export async function getDataset(request: CallableRequestShape): Promise<DatasetBundle> {
  const auth = assertNonGuestAuth(request, "data.getDataset.read");
  const requestData = asRecord(request.data);
  const limit = typeof requestData.limit === "number" ? pageSize(requestData.limit) : DEFAULT_PAGE_SIZE;
  // Preserve the caller's accepted request separately from runtime gating. Previously
  // `cache.requestedKeys` echoed `loadedKeys`, so a staging gate or a stale/partial server
  // response looked as if the client had never requested the SCP keys at all.
  const requestedKeys = requestedDatasetKeys(request.data, auth.role)
    .filter((key) => !PAGED_DATASET_KEYS.has(key));
  const loadedKeys = requestedKeys.filter((key) => datasetKeyAllowedInRuntime(key));
  const loadedKeySet = new Set<DatasetKey>(loadedKeys);
  // 2026-09-27 codex adversarial review FAIL-1: scpMailTemplates/scpMailResults are SCP mailbox
  // content (templates + send results) — role alone (canReadDatasetKey) let any manager/viewer
  // read them through this general dataset callable regardless of the new /flu/scp scp
  // entitlement gate. Only call isCallerScpEntitled (a live Peoply org lookup) when one of these
  // keys was actually requested — getDataset is the highest-invocation-count read callable in
  // this app, and every other key here never needed it, so gating it unconditionally would add a
  // network round trip to every dataset read (COST-P0 — cache/skip when not needed).
  // 2026-09-27 codex adversarial review round 2 FAIL-2: scpQualificationRows is scp mailbox/review
  // content too — gated the same conditional way, not just the two mail keys.
  // 2026-09-27 codex adversarial review round 5 FAIL-1: scpLifecycleProfiles was gated here too in
  // round 2, but the owner's scope decision keeps lifecycle profile reads role-only (this key
  // backs the general-purpose Influencer list page, same reasoning as listScpLifecycleProfiles
  // above) — removed from this check. Do not re-add without confirming with 헤세 first.
  const needsScpEntitlementCheck = loadedKeySet.has("scpMailTemplates")
    || loadedKeySet.has("scpMailResults")
    || loadedKeySet.has("scpQualificationRows");
  // 2026-09-27 codex adversarial review round 3 FAIL-10: a super_admin "대신 보기" (viewAs) a
  // non-granted person must have these keys evaluate the TARGET's entitlement, not the
  // super_admin's own bypass — reuse effectiveConversationAuth (already used for Chat scope
  // above), which resolves a server-verified viewAs target (resolveViewAsTarget) and derives an
  // auth reflecting the target's role/email/uid, or returns the original auth unchanged when no
  // viewAs was requested. Only called when a scp key was actually requested (same cost guard).
  const scpEntitlementAuth = needsScpEntitlementCheck ? await effectiveConversationAuth(auth, requestData) : auth;
  const scpEntitled = needsScpEntitlementCheck
    ? await isCallerScpEntitled(scpEntitlementAuth.email ?? "", scpEntitlementAuth.role === "super_admin", { userId: scpEntitlementAuth.userId })
    : false;
  const readKey = async (key: DatasetKey, collection: string) =>
    readCollection(
      collection,
      limit,
      cursorByKey(requestData, key, loadedKeys),
      collectionOrderForKey(key),
      auth,
      key,
      [],
      null,
      null,
      undefined,
      false,
      await datasetAccountOwnershipFilter(request, auth, key),
    );
  const [
    creatorsRead,
    channelStatsRead,
    agenciesRead,
    campaignsRead,
    programsRead,
    programApplicationsRead,
    programSheetLeadsRead,
    scpQualificationRowsRead,
    creatorLinksRead,
    scpMailTemplatesRead,
    scpMailResultsRead,
    submissionTasksRead,
    contractsRead,
    reviewsRead,
    escalationsRead,
    submissionsRead,
    videosRead,
    scpLifecycleProfilesRead,
    candidatePoolRead,
    communityPostsRead,
    feedDiscoveryStateRead,
    membersRead,
    llmUsageRead,
    templatesRead,
    conversationsRead,
    autoReplyRead,
    feedbackRead,
    knowledgeNodesRead,
    knowledgeEdgesRead,
    behaviorLogsRead,
    costLogsRead,
    rawRecordsRead,
    recCandidatesRead,
    creatorCommentsRead,
  ] = await Promise.all([
    loadedKeySet.has("creators") && canReadDatasetKey(auth.role, "creators") ? readKey("creators", "creators") : emptyRead(),
    loadedKeySet.has("channelStats") && canReadDatasetKey(auth.role, "channelStats") ? readKey("channelStats", "channel_stats") : emptyRead(),
    loadedKeySet.has("agencies") && canReadDatasetKey(auth.role, "agencies") ? readKey("agencies", "agencies") : emptyRead(),
    loadedKeySet.has("campaigns") && canReadDatasetKey(auth.role, "campaigns") ? readKey("campaigns", "campaigns") : emptyRead(),
    loadedKeySet.has("programs") && canReadDatasetKey(auth.role, "programs") ? readKey("programs", "programs") : emptyRead(),
    loadedKeySet.has("programApplications") && canReadDatasetKey(auth.role, "programApplications") ? readKey("programApplications", "program_applications") : emptyRead(),
    loadedKeySet.has("programSheetLeads") && canReadDatasetKey(auth.role, "programSheetLeads") ? readKey("programSheetLeads", "program_sheet_leads") : emptyRead(),
    loadedKeySet.has("scpQualificationRows") && canReadDatasetKey(auth.role, "scpQualificationRows") && scpEntitled ? readScpSheetDataset("scpQualificationRows", limit) : emptyRead(),
    loadedKeySet.has("creatorLinks") && canReadDatasetKey(auth.role, "creatorLinks") ? readKey("creatorLinks", "creator_links") : emptyRead(),
    loadedKeySet.has("scpMailTemplates") && canReadDatasetKey(auth.role, "scpMailTemplates") && scpEntitled ? readKey("scpMailTemplates", "scp_mail_templates") : emptyRead(),
    loadedKeySet.has("scpMailResults") && canReadDatasetKey(auth.role, "scpMailResults") && scpEntitled ? readKey("scpMailResults", "scp_mail_results") : emptyRead(),
    loadedKeySet.has("submissionTasks") && canReadDatasetKey(auth.role, "submissionTasks") ? readKey("submissionTasks", "submission_tasks") : emptyRead(),
    loadedKeySet.has("contracts") && canReadDatasetKey(auth.role, "contracts") ? readKey("contracts", "contracts") : emptyRead(),
    loadedKeySet.has("reviews") && canReadDatasetKey(auth.role, "reviews") ? readKey("reviews", "reviews") : emptyRead(),
    loadedKeySet.has("escalations") && canReadDatasetKey(auth.role, "escalations") ? readKey("escalations", "escalations") : emptyRead(),
    loadedKeySet.has("submissions") && canReadDatasetKey(auth.role, "submissions") ? readKey("submissions", "submissions") : emptyRead(),
    loadedKeySet.has("videos") && canReadDatasetKey(auth.role, "videos") ? readKey("videos", "videos") : emptyRead(),
    loadedKeySet.has("scpLifecycleProfiles") && canReadDatasetKey(auth.role, "scpLifecycleProfiles") ? readKey("scpLifecycleProfiles", "scp_lifecycle_profiles") : emptyRead(),
    loadedKeySet.has("candidatePool") && canReadDatasetKey(auth.role, "candidatePool") ? readKey("candidatePool", "candidate_pool") : emptyRead(),
    loadedKeySet.has("communityPosts") && canReadDatasetKey(auth.role, "communityPosts") ? readKey("communityPosts", "community_posts") : emptyRead(),
    loadedKeySet.has("feedDiscoveryState") && canReadDatasetKey(auth.role, "feedDiscoveryState") ? readKey("feedDiscoveryState", "feed_discovery_state") : emptyRead(),
    loadedKeySet.has("members") && canReadDatasetKey(auth.role, "members") ? readKey("members", "members") : emptyRead(),
    loadedKeySet.has("llmUsage") && canReadDatasetKey(auth.role, "llmUsage") ? readKey("llmUsage", "llm_usage") : emptyRead(),
    loadedKeySet.has("templates") && canReadDatasetKey(auth.role, "templates") ? readKey("templates", "templates") : emptyRead(),
    // Flu conversation org-filter (coordinator gap-close round 3, corrected round 4): "conversations"
    // is a PAGED_DATASET_KEYS entry (line ~3441 above), so it is unconditionally filtered out of
    // requestedKeys/loadedKeys before this Promise.all runs — loadedKeySet.has("conversations") is
    // always false here and this branch never executes. Round 3 mistakenly added a scp org-scope
    // resolver for this dead branch; removed rather than left as unreachable code. Real conversation
    // access for this app goes through listConversations/listTargetableDatasetPage (which DOES apply
    // functions/conversationMailAccessScope.ts's predicate) — see that path, not this one.
    loadedKeySet.has("conversations") && canReadDatasetKey(auth.role, "conversations") ? readKey("conversations", "conversations") : emptyRead(),
    loadedKeySet.has("autoReply") && canReadDatasetKey(auth.role, "autoReply") ? readKey("autoReply", "auto_reply") : emptyRead(),
    loadedKeySet.has("feedback") && canReadDatasetKey(auth.role, "feedback") ? readKey("feedback", "feedback") : emptyRead(),
    loadedKeySet.has("knowledgeNodes") && canReadDatasetKey(auth.role, "knowledgeNodes") ? readKey("knowledgeNodes", "knowledge_nodes") : emptyRead(),
    loadedKeySet.has("knowledgeEdges") && canReadDatasetKey(auth.role, "knowledgeEdges") ? readKey("knowledgeEdges", "knowledge_edges") : emptyRead(),
    loadedKeySet.has("behaviorLogs") && canReadDatasetKey(auth.role, "behaviorLogs") ? readKey("behaviorLogs", "behavior_logs") : emptyRead(),
    loadedKeySet.has("costLogs") && canReadDatasetKey(auth.role, "costLogs") ? readKey("costLogs", "cost_logs") : emptyRead(),
    loadedKeySet.has("rawRecords") && canReadDatasetKey(auth.role, "rawRecords") ? readKey("rawRecords", "raw_records") : emptyRead(),
    loadedKeySet.has("recCandidates") && canReadDatasetKey(auth.role, "recCandidates") ? readKey("recCandidates", "rec_candidates") : emptyRead(),
    loadedKeySet.has("creatorComments") && canReadDatasetKey(auth.role, "creatorComments") ? readKey("creatorComments", "creator_comments") : emptyRead(),
  ]);

  const creators = creatorsRead.rows;
  const channelStatsArr = channelStatsRead.rows;
  const agencies = agenciesRead.rows;
  const campaigns = campaignsRead.rows;
  const programs = programsRead.rows;
  const programApplications = programApplicationsRead.rows;
  const programSheetLeads = await hydrateProgramSheetLeadRows(programSheetLeadsRead.rows);
  const scpQualificationRows = scpQualificationRowsRead.rows;
  const creatorLinks = creatorLinksRead.rows;
  const scpMailTemplates = scpMailTemplatesRead.rows;
  const scpMailResults = scpMailResultsRead.rows;
  const submissionTasks = submissionTasksRead.rows;
  const contracts = contractsRead.rows;
  const reviews = reviewsRead.rows;
  const escalations = escalationsRead.rows;
  const submissions = submissionsRead.rows;
  const videos = videosRead.rows;
  const scpLifecycleProfiles = scpLifecycleProfilesRead.rows;
  const candidatePool = candidatePoolRead.rows;
  const communityPosts = communityPostsRead.rows;
  const feedDiscoveryState = feedDiscoveryStateRead.rows;
  const members = membersRead.rows.map((row) => redactMemberMailAccountAccessForRole(row, auth.role));
  const llmUsage = llmUsageRead.rows.map(normalizeLlmUsageRow);
  const templates = templatesRead.rows;
  const conversations = conversationsRead.rows;
  const autoReply = autoReplyRead.rows;
  const feedback = feedbackRead.rows;
  const knowledgeNodes = knowledgeNodesRead.rows;
  const knowledgeEdges = knowledgeEdgesRead.rows;
  const behaviorLogs = behaviorLogsRead.rows;
  const costLogs = costLogsRead.rows;
  const rawRecords = rawRecordsRead.rows;
  const recCandidates = recCandidatesRead.rows;
  const creatorComments = creatorCommentsRead.rows;

  const videosNormalized = videos.map((video) => ({ videoId: video.id, ...video }));
  const channelStats: Record<string, Record<string, unknown>> = {};
  for (const stat of channelStatsArr) {
    const id = typeof stat.id === "string" ? stat.id : "";
    if (id) channelStats[id] = stat;
  }

  // For audit/compliance keys that are capped at DEFAULT_PAGE_SIZE, fetch the
  // real collection count so consumers can detect truncation without ambiguity.
  // Other keys keep their .length value (cheap, already correct for small sets).
  const AUDIT_TOTAL_KEYS: Array<{ key: DatasetKey; collection: string; read: CollectionRead }> = [
    { key: "behaviorLogs", collection: "behavior_logs", read: behaviorLogsRead },
    { key: "costLogs", collection: "cost_logs", read: costLogsRead },
    { key: "llmUsage", collection: "llm_usage", read: llmUsageRead },
    { key: "members", collection: "members", read: membersRead },
    { key: "feedback", collection: "feedback", read: feedbackRead },
    // P9/S10 교차(A12): /admin/knowledge 카운터가 DEFAULT_PAGE_SIZE(100) 캡을 "전체"인 것처럼
    // 보여줘 프로드 실측 knowledge_nodes 2084건과 모순됐다 — 다른 audit 키와 동일하게 실제
    // 컬렉션 총계로 보정한다.
    { key: "knowledgeNodes", collection: "knowledge_nodes", read: knowledgeNodesRead },
  ];
  const auditTotals = await Promise.all(
    AUDIT_TOTAL_KEYS.map(async ({ collection, read }) => {
      if (!read.pageInfo.truncated) return read.rows.length;
      const snap = await adminDb.collection(collection).count().get();
      return snap.data().count;
    }),
  );
  const [behaviorLogsTotal, costLogsTotal, llmUsageTotal, membersTotal, feedbackTotal, knowledgeNodesTotal] = auditTotals;

  const counts = {
    creators: creators.length,
    campaigns: campaigns.length,
    programs: programs.length,
    programApplications: programApplications.length,
    programSheetLeads: programSheetLeads.length,
    scpQualificationRows: scpQualificationRows.length,
    creatorLinks: creatorLinks.length,
    scpMailTemplates: scpMailTemplates.length,
    scpMailResults: scpMailResults.length,
    submissionTasks: submissionTasks.length,
    contracts: contracts.length,
    reviews: reviews.length,
    submissions: submissions.length,
    videos: videosNormalized.length,
    scpLifecycleProfiles: scpLifecycleProfiles.length,
    candidatePool: candidatePool.length,
    feedDiscoveryState: feedDiscoveryState.length,
    members: membersTotal,
    llmUsage: llmUsageTotal,
    conversations: conversations.length,
    feedback: feedbackTotal,
    knowledgeNodes: knowledgeNodesTotal,
    knowledgeEdges: knowledgeEdges.length,
    behaviorLogs: behaviorLogsTotal,
    costLogs: costLogsTotal,
    truncatedCollections: [
      creatorsRead,
      channelStatsRead,
      agenciesRead,
      campaignsRead,
      programsRead,
      programApplicationsRead,
      programSheetLeadsRead,
      scpQualificationRowsRead,
      creatorLinksRead,
      scpMailTemplatesRead,
      scpMailResultsRead,
      submissionTasksRead,
      contractsRead,
      reviewsRead,
      escalationsRead,
      submissionsRead,
      videosRead,
      scpLifecycleProfilesRead,
      candidatePoolRead,
      communityPostsRead,
      feedDiscoveryStateRead,
      membersRead,
      llmUsageRead,
      templatesRead,
      conversationsRead,
      autoReplyRead,
      feedbackRead,
      knowledgeNodesRead,
      knowledgeEdgesRead,
      behaviorLogsRead,
      costLogsRead,
      rawRecordsRead,
      recCandidatesRead,
      creatorCommentsRead,
    ].filter((entry) => entry.pageInfo.truncated).length,
  };

  const pageInfo = {
    creators: creatorsRead.pageInfo,
    channelStats: channelStatsRead.pageInfo,
    agencies: agenciesRead.pageInfo,
    campaigns: campaignsRead.pageInfo,
    programs: programsRead.pageInfo,
    programApplications: programApplicationsRead.pageInfo,
    programSheetLeads: programSheetLeadsRead.pageInfo,
    scpQualificationRows: scpQualificationRowsRead.pageInfo,
    creatorLinks: creatorLinksRead.pageInfo,
    scpMailTemplates: scpMailTemplatesRead.pageInfo,
    scpMailResults: scpMailResultsRead.pageInfo,
    submissionTasks: submissionTasksRead.pageInfo,
    contracts: contractsRead.pageInfo,
    reviews: reviewsRead.pageInfo,
    escalations: escalationsRead.pageInfo,
    submissions: submissionsRead.pageInfo,
    videos: videosRead.pageInfo,
    scpLifecycleProfiles: scpLifecycleProfilesRead.pageInfo,
    candidatePool: candidatePoolRead.pageInfo,
    communityPosts: communityPostsRead.pageInfo,
    feedDiscoveryState: feedDiscoveryStateRead.pageInfo,
    members: membersRead.pageInfo,
    llmUsage: llmUsageRead.pageInfo,
    templates: templatesRead.pageInfo,
    conversations: conversationsRead.pageInfo,
    autoReply: autoReplyRead.pageInfo,
    feedback: feedbackRead.pageInfo,
    knowledgeNodes: knowledgeNodesRead.pageInfo,
    knowledgeEdges: knowledgeEdgesRead.pageInfo,
    behaviorLogs: behaviorLogsRead.pageInfo,
    costLogs: costLogsRead.pageInfo,
    rawRecords: rawRecordsRead.pageInfo,
    recCandidates: recCandidatesRead.pageInfo,
    creatorComments: creatorCommentsRead.pageInfo,
  };

  const scpRequestedKeys = loadedKeys.filter((key) =>
    key === "scpQualificationRows" ||
    key === "programSheetLeads" ||
    key === "creatorLinks" ||
    key === "submissionTasks",
  );
  if (scpRequestedKeys.length > 0) {
    const readErrorCount = (rows: Record<string, unknown>[]) => rows.filter((row) => row.readError === true).length;
    console.info(JSON.stringify({
      event: "scp.dataset.read",
      role: auth.role,
      requestedKeys: scpRequestedKeys,
      counts: {
        programSheetLeads: counts.programSheetLeads,
        scpQualificationRows: counts.scpQualificationRows,
        creatorLinks: counts.creatorLinks,
        submissionTasks: counts.submissionTasks,
      },
      readErrors: {
        scpQualificationRows: readErrorCount(scpQualificationRows),
      },
      truncated: {
        scpQualificationRows: pageInfo.scpQualificationRows.truncated,
      },
    }));
  }

  return {
    ok: true,
    seeded: creators.length > 0,
    loadedKeys,
    datasetContract: {
      version: GET_DATASET_CONTRACT_VERSION,
      runtimeEnvironment: adminRuntimeEnvironment.runtimeEnvironment,
    },
    cache: {
      generatedAtIso: new Date().toISOString(),
      maxAgeSeconds: CACHE_MAX_AGE_SECONDS,
      requestedKeys,
    },
    counts,
    pageInfo,
    creators,
    channelStats,
    agencies,
    campaigns,
    programs,
    programApplications,
    programSheetLeads,
    scpQualificationRows,
    creatorLinks,
    contracts,
    reviews,
    scpMailTemplates,
    scpMailResults,
    submissionTasks,
    escalations,
    submissions,
    videos: videosNormalized,
    scpLifecycleProfiles,
    candidatePool,
    communityPosts,
    feedDiscoveryState,
    members,
    llmUsage,
    templates,
    conversations,
    autoReply,
    feedback,
    knowledgeNodes,
    knowledgeEdges,
    behaviorLogs,
    costLogs,
    rawRecords,
    recCandidates,
    creatorComments,
    behaviorLog: makeBehaviorLog(auth, "data.getDataset.read", "success"),
  };
}
