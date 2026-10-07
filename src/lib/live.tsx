"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import {
  getDataset,
  listCampaigns,
  listCandidatePool,
  listCommunityPosts,
  listConversations,
  listCreators,
  listProgramApplications,
  listPrograms,
  listSubmissions,
  listVideos,
  listScpLifecycleProfiles,
  type DatasetBundle,
  type DatasetKey,
  type DatasetPageEnvelope,
  type Role,
} from "@/lib/data";
import { subscribeAuthState, type AuthState } from "@/lib/auth";
import {
  invokeScopedDatasetPageLoader,
  resetScpLifecycleProfilePage,
  scopedDatasetPagePayload,
  type LivePagedDatasetScope,
} from "@/lib/scp-lifecycle-page-scope";
import { callableDedupeKey, dedupeCallable, invalidateCallableDedupe } from "@/lib/callable-dedupe";
import { useAuthoritativeOrgContextScopeKey } from "@/lib/useNavPreset";
import { useViewAs } from "@/lib/viewAs";

export type ChatForegroundSyncState = {
  enabled: boolean;
  inFlight: boolean;
  intervalMs: number;
  lastStartedAtIso?: string;
  lastFinishedAtIso?: string;
  error: string | null;
};

type LiveState = {
  data: DatasetBundle | null;
  loading: boolean;
  loadingMore: Partial<Record<DatasetKey, boolean>>;
  // R7 P10: 키 단위 in-flight 신호 — 화면이 자신에게 필요한 키만 보고 벌크 loading에 얽매이지 않도록 점진 전환 가능.
  loadingKeys: Partial<Record<DatasetKey, boolean>>;
  stale: boolean;
  error: string | null;
  chatForegroundSync: ChatForegroundSyncState;
  seeded: boolean;
  authReady: boolean;
  canRead: boolean;
  authScopeKey: string | null;
  authScopeGeneration: number;
  role: Role | null;
  refresh: () => Promise<void>;
  // Mount-time consumers must call the provider directly: a child effect can fire before
  // this provider's window-event subscription is installed and silently lose the request.
  loadKeys: (keys: readonly DatasetKey[], background?: boolean, force?: boolean, scope?: DatasetLoadScope) => Promise<void>;
  loadMore: (key: DatasetKey) => Promise<void>;
  // W108: 이미 있던 내부 helper(아래 useCallback 정의, 자동 하이드레이션에도 재사용됨)를
  // 컨텍스트로 추가 노출한 것뿐 — 시그니처/동작 변경 없음(additive). 목적: /chat "사람" 탭처럼
  // 사용자가 명시적으로 연 화면이 온디맨드로 한 데이터셋을 끝까지 드레인할 수 있게 하기 위함.
  // 라우트 진입 시 자동으로 도는 것(autoHydratePageKeysForPath)과는 별개의 트리거다.
  /**
   * 남은 페이지를 소진까지 당긴다. **소진에 도달했으면 true**, 시작도 못 했거나(전제 미비·이미 실행 중)
   * 중간에 실패했으면 false. 호출자가 "완료"를 기억해 재시도를 막는 경우가 있어(사람 탭 드레인),
   * 성공 여부를 돌려주지 않으면 한 번의 실패가 그 스코프를 영구히 죽인다.
   */
  loadRemainingPages: (key: DatasetKey, initialCursor: string | null | undefined) => Promise<boolean>;
  mutate: (fn: (prev: DatasetBundle) => DatasetBundle) => void;
  // R7 P10: 특정 키가 이미 로드됐는지(벌크 loading과 무관) — 화면별 점진 전환의 진입점.
  perKeyLoaded: (key: DatasetKey) => boolean;
  // R7 P10 hotfix: 특정 키가 최종적으로 실패했는지(벌크 error/partialLoadError와 무관) —
  // progressive-commit로 다른 키가 먼저 로드돼도, 정작 필요한 키가 에러난 상태에서 그 키에
  // 의존하는 화면이 "로드됨"으로 착각해 폴백 UI를 잘못 그리지 않도록 한다.
  perKeyError: (key: DatasetKey) => string | undefined;
};

type LoadOptions = {
  background?: boolean;
  // `background` 는 "블로킹 UI(로딩 스켈레톤·에러 배너)를 건드리지 않는다"는 렌더 신호일 뿐이다.
  // 화면 훅이 자기 화면에 필요한 키를 당길 때도 background=true 를 쓰므로, 신선도 정책의 축으로
  // 쓰면 **사용자가 보고 있는 데이터의 재검증까지 함께 꺼진다**(H1: `/flu/programs` 상세 키가
  // 어떤 새로고침으로도 재조회되지 않던 원인). 유휴 프리페치처럼 "아직 아무도 안 본 화면을 미리
  // 채우는" 요청만 아래 `prefetch` 로 표시하고, 휘발성 키 재검증은 그 경로에서만 생략한다.
  prefetch?: boolean;
  force?: boolean;
  appendKeys?: DatasetKey[];
  cursors?: Partial<Record<DatasetKey, string>>;
  throwOnError?: boolean;
};

type DatasetLoadScope = {
  scpLifecycleProgramId?: string;
};

type DataKeysRefreshEvent = CustomEvent<{ keys: DatasetKey[]; background?: boolean }>;

type LiveMemoryCache = {
  identity: string;
  bundle: DatasetBundle;
  storedAt: number;
};

type LiveInFlightRequest = {
  requestKey: string;
  scopeIdentity: string;
  keys: DatasetKey[];
  cursorKey: string;
  promise: Promise<DatasetBundle>;
};

type LiveAuthScope = Readonly<{
  authScopeKey: string;
  generation: number;
  communityScope: CommunityDatasetScope;
  scpLifecycleScope: ScpLifecycleDatasetScope;
  viewAsScope: ViewAsDatasetScope;
}>;

type ViewAsDatasetScope = Readonly<{
  userId: string;
  email: string;
}>;

const SELF_VIEW_AS_DATASET_SCOPE: ViewAsDatasetScope = Object.freeze({ userId: "", email: "" });

function effectiveViewAsDatasetScope(role: Role | null, requested: ViewAsDatasetScope): ViewAsDatasetScope {
  return role === "super_admin" ? requested : SELF_VIEW_AS_DATASET_SCOPE;
}

type ScpLifecycleDatasetScope = Readonly<{
  programId: string;
  revision: number;
  registered: boolean;
  scopeKey: string;
}>;

type CommunityDatasetScope = Readonly<{
  programId: string;
  campaignId: string;
  scopeKey: string;
}>;

export const SYSTEM_COMMUNITY_DATASET_SCOPE: CommunityDatasetScope = Object.freeze({
  programId: "__global__",
  campaignId: "__global__",
  scopeKey: "community:__global__:__global__",
});

const UNREGISTERED_SCP_LIFECYCLE_DATASET_SCOPE: ScpLifecycleDatasetScope = Object.freeze({
  programId: "",
  revision: 0,
  registered: false,
  scopeKey: "scp-lifecycle:unregistered",
});

function makeLiveAuthScope(
  authScopeKey: string,
  generation: number,
  scpLifecycleScope: ScpLifecycleDatasetScope = UNREGISTERED_SCP_LIFECYCLE_DATASET_SCOPE,
  viewAsScope: ViewAsDatasetScope = SELF_VIEW_AS_DATASET_SCOPE,
): LiveAuthScope {
  return {
    authScopeKey,
    generation,
    communityScope: SYSTEM_COMMUNITY_DATASET_SCOPE,
    scpLifecycleScope,
    viewAsScope,
  };
}

export function canonicalScopeIdentity(namespace: string, parts: readonly string[]): string {
  return `lp1:${namespace.length}:${namespace}:${parts.length}:${parts.map((part) => `${part.length}:${part}`).join("")}`;
}

export function canonicalLiveAuthScopeKey(
  userId: string,
  tenantId: string,
  role: string,
  team: string,
  claimSyncReason: string,
  orgScopeKey: string,
  viewAsUserId = "",
  viewAsEmail = "",
): string {
  return canonicalScopeIdentity("live-auth-v5", [userId, tenantId, role, team, claimSyncReason, orgScopeKey, viewAsUserId, viewAsEmail]);
}

function liveScopeCacheIdentity(scope: LiveAuthScope): string {
  return canonicalScopeIdentity("live-cache-v2", [scope.authScopeKey, String(scope.generation), scope.communityScope.scopeKey]);
}

const LiveCtx = createContext<LiveState>({
  data: null,
  loading: false,
  loadingMore: {},
  loadingKeys: {},
  error: null,
  chatForegroundSync: { enabled: false, inFlight: false, intervalMs: 0, error: null },
  stale: false,
  seeded: false,
  authReady: false,
  canRead: false,
  authScopeKey: null,
  authScopeGeneration: 0,
  role: null,
  refresh: async () => {},
  loadKeys: async () => {},
  loadMore: async () => {},
  loadRemainingPages: async () => false,
  mutate: () => {},
  perKeyLoaded: () => false,
  perKeyError: () => undefined,
});

const CAN_READ = new Set(["super_admin", "admin", "manager", "viewer"]);
const MEMORY_TTL_MS = 60_000;
const BACKGROUND_HYDRATE_TIMEOUT_MS = 2_500;

const DATASET_KEYS: DatasetKey[] = [
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
  "members",
  "llmUsage",
  "templates",
  "conversations",
  "autoReply",
  "feedback",
  "knowledgeNodes",
  "knowledgeEdges",
  "behaviorLogs",
  "costLogs",
  "rawRecords",
  "recCandidates",
  "creatorComments",
];

export const FLU_DASHBOARD_PRIMARY_KEYS = [
] as const satisfies readonly DatasetKey[];

export const FLU_DASHBOARD_POST_SNAPSHOT_KEYS = [
  "programs",
  "campaigns",
  "reviews",
  "escalations",
] as const satisfies readonly DatasetKey[];

export const FLU_DASHBOARD_REFRESH_KEYS = [
  ...FLU_DASHBOARD_PRIMARY_KEYS,
  ...FLU_DASHBOARD_POST_SNAPSHOT_KEYS,
] as const satisfies readonly DatasetKey[];

export const FLU_PROGRAMS_POST_SNAPSHOT_KEYS = [
  "programs",
] as const satisfies readonly DatasetKey[];

// `/flu/programs` 가 프로그램 종류와 무관하게 **항상** 그리는 상세 키 — 페이지의
// PROGRAM_CONTEXT_DETAIL_KEYS 와 같은 집합이다. 이 목록이 없으면 전역 새로고침
// (`flu:data-refresh`)이 `programs` 한 키만 다시 당기면서 **번들 storedAt 만 리셋**해
// 나머지 상세 키의 staleness 를 오히려 연장했다(H1).
//
// PROGRAM_OPERATIONAL_DETAIL_KEYS(programSheetLeads·creatorLinks·submissionTasks·submissions·
// conversations)는 **일부러 뺐다**. 페이지가 그 다섯을 SCP 프로그램에서는 아예 안 받고(서버측
// canonical aggregate 를 쓴다) 일반 프로그램에서만 받는데, 라우트는 어떤 프로그램이 선택됐는지
// 모른다. 여기에 넣으면 캐시에 없는 키는 항상 받는 규칙 때문에 **SCP 프로그램에서 탭 복귀할 때마다**
// submissions/conversations(각 2000행)까지 새로 당긴다 — 이 커밋이 지키기로 한 비용 균형이 깨진다.
// 그 다섯 키는 페이지의 loadKeys(PROGRAM_OPERATIONAL_DETAIL_KEYS, true) 훅이 H1 게이트 수리로
// 다시 재검증되므로(프로그램 전환·화면 진입) 정지 상태는 아니다. 남는 간극: 같은 프로그램에 머문 채
// 새로고침만 누르면 그 다섯은 갱신되지 않는다.
export const FLU_PROGRAMS_DETAIL_KEYS = [
  "programApplications",
  "campaigns",
  "creators",
] as const satisfies readonly DatasetKey[];

export const FLU_PROGRAMS_REFRESH_KEYS = [
  ...FLU_PROGRAMS_POST_SNAPSHOT_KEYS,
  ...FLU_PROGRAMS_DETAIL_KEYS,
] as const satisfies readonly DatasetKey[];

export function isDevelopmentOnlyNoDataRoute(pathname: string): boolean {
  // 0.5.38 IA Override: /flu/scp is now the real "SCP 자동화" control-plane surface (single
  // parent product surface), not a static placeholder — no route is a development-only
  // no-data placeholder anymore. Kept as a named predicate (always false) so existing callers
  // (AppShell/SeedWidget/dataset-key guards) stay structurally unchanged and harmless.
  void pathname;
  return false;
}

export function requiredDatasetKeysAfterSnapshot(pathname: string): DatasetKey[] {
  if (isDevelopmentOnlyNoDataRoute(pathname)) return [];
  if (pathname === "/flu" || pathname === "/flu/") return [...FLU_DASHBOARD_POST_SNAPSHOT_KEYS];
  if (pathname.startsWith("/flu/programs")) return [...FLU_PROGRAMS_POST_SNAPSHOT_KEYS];
  return [];
}

export function requiredDatasetKeysForSnapshotRouteRefresh(pathname: string): DatasetKey[] {
  if (isDevelopmentOnlyNoDataRoute(pathname)) return [];
  if (pathname === "/flu" || pathname === "/flu/") return [...FLU_DASHBOARD_REFRESH_KEYS];
  if (pathname.startsWith("/flu/programs")) return [...FLU_PROGRAMS_REFRESH_KEYS];
  return [];
}

type ReadableRole = Exclude<Role, "guest">;
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
const ROLE_DATASET_KEYS: Record<ReadableRole, ReadonlySet<DatasetKey>> = {
  viewer: new Set<DatasetKey>(SHARED_DATASET_KEYS),
  manager: new Set<DatasetKey>(SHARED_DATASET_KEYS),
  admin: new Set<DatasetKey>([
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
    "candidatePool",
    "templates",
    "recCandidates",
    "videos",
    "scpLifecycleProfiles",
    "communityPosts",
    "feedDiscoveryState",
    "creatorComments",
    "members",
    "llmUsage",
    "conversations",
    "autoReply",
    "feedback",
    "knowledgeNodes",
    "knowledgeEdges",
    "behaviorLogs",
    "costLogs",
    "rawRecords",
  ]),
  super_admin: new Set<DatasetKey>(DATASET_KEYS),
};
const PAGED_DATASET_KEYS = new Set<DatasetKey>([
  "creators",
  "campaigns",
  "videos",
  "communityPosts",
  "conversations",
  "submissions",
  "scpLifecycleProfiles",
  "candidatePool",
  "programs",
  "programApplications",
]);

type PagedDatasetLoader = (payload?: { cursor?: string; limit?: number; programId?: string; campaignId?: string; includeArchivedCampaigns?: boolean }) => Promise<DatasetPageEnvelope>;

const PAGED_LOADERS: Partial<Record<DatasetKey, PagedDatasetLoader>> = {
  creators: listCreators,
  campaigns: listCampaigns,
  videos: listVideos,
  scpLifecycleProfiles: listScpLifecycleProfiles,
  communityPosts: listCommunityPosts,
  conversations: listConversations,
  submissions: listSubmissions,
  candidatePool: listCandidatePool,
  programs: listPrograms,
  programApplications: listProgramApplications,
};
const PAGE_LIMITS: Partial<Record<DatasetKey, number>> = {
  campaigns: 2000,
  candidatePool: 200,
  conversations: 2000,
  creators: 1000,
  videos: 200,
  // 조인 모수는 양쪽을 같이 봐야 한다: creators가 1000인데 여기가 200이면 매칭이 조용히 잘린다.
  // 프로드 실측(2026-07-26) 서빙 프로필 1623건 중 200건(12%)만 첫 페인트에 도달해 신규 행이
  // 관리 버킷에 들어오지 못했다. 서버가 stale/legacy 행을 이미 제외하고(read.ts
  // scpLifecycleProfileNotFoundReason) 숨은 행만큼 다음 페이지를 채우므로, 한도만 서버 MAX까지
  // 올리면 서빙분 전체가 덮인다(1623 < 2000). 정렬 인덱스는 stateEnteredAt DESC 기존 것 그대로다.
  scpLifecycleProfiles: 2000,
  communityPosts: 200,
  // R3 P2: 파트너 모수 = 영상 제출자 전부 — 첫 페이지 100건 캡이 모수를 자르면 안 된다(프로드 113+건, 서버 MAX 2000).
  submissions: 2000,
};
const REVALIDATE_WHEN_FRESH_KEYS = new Set<DatasetKey>([
  "campaigns",
  "programs",
  "programApplications",
  "programSheetLeads",
  "scpQualificationRows",
  "creatorLinks",
  "scpMailTemplates",
  "scpMailResults",
  "submissionTasks",
  "reviews",
  "escalations",
  "submissions",
  "videos",
  "scpLifecycleProfiles",
  "communityPosts",
  "conversations",
  "autoReply",
  "feedback",
  "knowledgeNodes",
  "knowledgeEdges",
  "llmUsage",
]);
const NOTIFICATION_DATASET_KEYS: DatasetKey[] = ["reviews", "conversations"];
let liveMemoryCache: LiveMemoryCache | null = null;
let liveInFlightRequests: LiveInFlightRequest[] = [];
let liveAuthGenerationSequence = 0;

// R7 P10: 개별 콜이 끝나는 즉시(벌크 Promise.allSettled를 기다리지 않고) 그 키만 커밋할 수 있도록
// 하는 알림 채널 — perKeyLoaded/loadingKeys가 실제로 "벌크 loading과 무관"해지려면 fetchDatasetBundle
// 내부에서 개별 콜이 settle되는 시점에 그 결과를 알려야 한다(그 전엔 API만 있고 배선이 없었다).
type PartialBundlePayload = Readonly<{
  bundle: DatasetBundle;
  scope: LiveAuthScope;
}>;
type PartialBundleListener = (payload: PartialBundlePayload) => void;
const partialBundleListeners = new Set<PartialBundleListener>();
function announcePartialBundle(payload: PartialBundlePayload) {
  for (const listener of partialBundleListeners) listener(payload);
}
function subscribePartialBundle(listener: PartialBundleListener): () => void {
  partialBundleListeners.add(listener);
  return () => partialBundleListeners.delete(listener);
}

function uniqueDatasetKeys(keys: readonly DatasetKey[]): DatasetKey[] {
  return Array.from(new Set(keys));
}

// `undefined` is the only "load the default/all datasets" signal. Snapshot-first routes
// intentionally pass an explicit empty array until their aggregate snapshot settles; treating
// that array as falsy here starts every paged loader and defeats the route contract.
export function resolveRequestedDatasetKeys(keys: DatasetKey[] | undefined): DatasetKey[] {
  return keys === undefined ? DATASET_KEYS : uniqueDatasetKeys(keys);
}

export function datasetLoadErrorsForKeys(
  keys: readonly DatasetKey[],
  message: string,
): Partial<Record<DatasetKey, string>> {
  return Object.fromEntries(uniqueDatasetKeys(keys).map((key) => [key, message]));
}

export type PublicCallableErrorCode =
  | "unauthenticated"
  | "cancelled"
  | "unknown"
  | "invalid-argument"
  | "deadline-exceeded"
  | "failed-precondition"
  | "resource-exhausted"
  | "not-found"
  | "already-exists"
  | "permission-denied"
  | "aborted"
  | "out-of-range"
  | "unimplemented"
  | "internal"
  | "unavailable"
  | "data-loss";

const PUBLIC_CALLABLE_ERROR_MESSAGES: Record<PublicCallableErrorCode, string> = {
  unauthenticated: "로그인이 필요합니다.",
  cancelled: "요청이 취소되었습니다.",
  unknown: "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  "invalid-argument": "입력값을 확인해 주세요.",
  "deadline-exceeded": "요청 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.",
  "failed-precondition": "현재 상태에서는 요청을 처리할 수 없습니다. 새로고침 후 다시 시도해 주세요.",
  "resource-exhausted": "요청이 많습니다. 잠시 후 다시 시도해 주세요.",
  "not-found": "요청한 정보를 찾지 못했습니다.",
  "already-exists": "이미 처리된 요청입니다. 화면을 새로고침해 주세요.",
  "permission-denied": "이 작업을 수행할 권한이 없습니다.",
  aborted: "요청이 중단되었습니다. 다시 시도해 주세요.",
  "out-of-range": "허용 범위를 벗어난 입력값이 있습니다.",
  unimplemented: "지원하지 않는 요청입니다.",
  internal: "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  unavailable: "서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
  "data-loss": "요청을 안전하게 처리하지 못했습니다.",
};

const PUBLIC_BUSINESS_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  chat_auto_case_reply_revision_conflict: "다른 곳에서 답신이 먼저 변경됐습니다. 최신 상태를 불러온 뒤 다시 확인해 주세요.",
  chat_auto_case_reply_failed_precondition: "답신 기능의 실행 조건을 확인하지 못했습니다. 관리자 설정과 최신 상태를 확인해 주세요.",
  chat_auto_case_reply_dispatch_in_flight: "이 케이스의 발송 결과를 확인 중이어서 변경할 수 없습니다. 발송이 끝났거나 결과가 확인된 뒤 다시 시도해 주세요.",
  chat_auto_case_reply_rate_limited: "AI 의견을 너무 자주 요청했습니다. 잠시 후 다시 시도해 주세요.",
  chat_auto_case_reply_invalid_argument: "답신 문구와 입력 내용을 확인해 주세요. 링크·마크업·지원하지 않는 변수를 포함할 수 없습니다.",
  chat_auto_case_reply_auto_send_refused: "저장한 답신이 자동발송 안전 검사를 통과하지 못했습니다. 영어 문장이어야 하며 금액·숫자·요율 변경·보너스·예외를 약속하거나 암시하면 안 됩니다(AI 검사 실패·시간 초과도 거부됩니다). 문구를 고쳐 저장한 뒤 다시 검증해 주세요.",

  scp_lifecycle_refresh_invalid_source: "새로고침 요청의 데이터 출처가 올바르지 않습니다.",
  scp_lifecycle_refresh_missing_source_ref: "새로고침할 데이터 연결 정보를 찾지 못했습니다.",
  scp_lifecycle_refresh_enqueue_failed: "새로고침 요청을 등록하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  scp_lifecycle_refresh_failed: "데이터 새로고침에 실패했습니다. 잠시 후 다시 시도해 주세요.",
  scp_lifecycle_refresh_failure_record_write_failed: "데이터 새로고침 오류를 기록하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  mail_signature_settings_read_failed: "메일 서명 설정을 불러오지 못했습니다.",
  mail_outbox_invalid_tracking_id: "메일 추적 정보가 올바르지 않습니다.",
  mail_outbox_write_failed: "메일 처리 상태를 저장하지 못했습니다.",
  mail_outbox_lifecycle_enqueue_failed: "메일 처리 후속 작업을 등록하지 못했습니다.",
  mail_outbox_reply_memoize_failed: "답장 확인 상태를 저장하지 못했습니다.",
  mail_open_event_write_failed: "메일 열람 상태를 저장하지 못했습니다.",
  "mail-safety.sent-import-imap-runtime-failed": "Gmail 보낸편지함 조회를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  "mail-safety.sent-import-mailbox-not-allowed": "Gmail의 보낸편지함을 자동으로 확인하지 못했습니다. IMAP Sent 폴더 설정을 확인해 주세요.",
  "mail-safety.sent-import-from-not-allowed": "승인된 Gmail 발신 계정의 메일만 가져올 수 있습니다.",
  "mail-safety.sent-import-preview-required": "적용 전에 같은 범위의 미리보기를 먼저 실행해 주세요.",
  "mail-safety.sent-import-preview-mismatch": "미리보기 이후 메일 범위가 변경되었습니다. 새 미리보기를 실행해 주세요.",
  "mail-safety.sent-import-preview-expired": "미리보기 유효 시간이 만료되었습니다. 새 미리보기를 실행해 주세요.",
  // W8-1b: 메일 템플릿 편집기의 거절 사유. 서버는 원문 메시지를 내보내지 않으므로
  // (callableErrorBoundary) 코드별 문구를 여기서 갖는다 — "입력값을 확인해 주세요"만 보고
  // 무엇이 막혔는지 알 수 없던 상태를 없앤다.
  // R7b: 서버(functions/scpReceiptMailTemplates.ts renderScpReceiptMailTemplate)는 subject·text 만
  // 필수로 거부한다 — html 은 W8-3 부터 선택이다("HTML 은 선택이다" 주석·OutboundMailMessage.html
  // optional). 예전 문구는 HTML 도 필수라고 말해 텍스트 전용 발행 사용자를 오도했다.
  mail_template_field_required: "제목과 텍스트 본문은 비워둘 수 없습니다(HTML은 선택입니다).",
  mail_template_subject_too_large: "제목이 너무 깁니다. 400바이트 이내로 줄여 주세요.",
  mail_template_variables_invalid: "변수를 확인해 주세요 — 허용 목록에 없는 변수, 필수 변수 누락, 또는 {{ }} 형식 오류입니다.",
  mail_template_unsafe_html: "본문에 허용되지 않는 HTML이 있습니다 — script·iframe·form 등 요소, on* 이벤트 속성, javascript:·data:·// 로 시작하는 링크는 쓸 수 없습니다(본문 이미지는 data:image 로 붙여넣어도 됩니다).",
  campaign_live_wave_no_targets: "이 웨이브에 넣을 수 있는 대상이 한 건도 확보되지 않았습니다. 아래 단계별 탈락 수를 확인해 타게팅 기준을 조정하거나 후보 풀을 먼저 확보해 주세요.",
  campaign_live_wave_cap_exceeded: "확보된 대상이 발송 상한을 넘었습니다. 상한을 넘겨 큐잉하지 않습니다 — 요청 수를 줄여 주세요.",
  campaign_targets_no_email_ready: "타게팅을 통과한 후보에게 유효한 수신 이메일이 없습니다.",
  campaign_targets_all_suppressed: "수신 이메일이 있는 후보가 전부 수신거부·차단·중복 판정입니다.",
  campaign_targets_all_already_touched: "후보 전원이 이미 큐잉·발송·차단된 이력이 있습니다(재발송 금지).",
  // W8-FINAL R6: 국가 화이트리스트는 없앴지만 라이브 발송 의사표시는 여전히 명시적이어야 한다.
  // 두 거부는 원인이 달라 문구도 분리한다(하나는 제외 적용 결과가 0건, 하나는 범위 자체가 비명시).
  campaign_live_country_include_scope_empty: "지정한 발송 국가가 제외 설정에 모두 걸려 대상이 0건입니다. 국가를 추가하거나 제외 목록을 조정해 주세요.",
  campaign_live_country_scope_not_explicit: "라이브 발송은 국가 범위를 명시해야 합니다 — 전체 국가로 보내려면 '전체', 일부만 보내려면 국가를 직접 지정해 주세요.",
  // R12: 예전에는 템플릿이 없으면 "[Supercent] {캠페인명} 협업 제안" + 기본 문안으로 조용히 대체돼
  // 캠페인 내부명이 제품명 자리에 박힌 채 실제로 발송됐다. 이제 라이브 큐잉은 거부된다.
  campaign_live_coldmail_template_missing: "이 프로그램에 콜드메일 템플릿이 없어 라이브 웨이브를 만들 수 없습니다. 메일 템플릿 탭에서 프로그램 콜드메일(제목·본문)을 먼저 저장해 주세요 — 임의의 기본 문안으로 대신 보내지 않습니다.",
  campaign_live_coldmail_template_stale: "이 프로그램의 콜드메일 저장본이 오래되어 라이브 웨이브를 만들 수 없습니다. 코드 배포 후 메일 템플릿 탭에서 프로그램 콜드메일을 다시 발행해 {{apply_link}} 서명 링크 변수를 반영해 주세요.",
  // W8-FINAL R8⑤: 예전에는 상한 초과 본문을 조용히 잘라 저장했다(잘린 채 실제 발송). 이제 거부이므로
  // 무엇이 막혔는지 문구로 알린다.
  coldmail_body_too_large: "콜드메일 본문이 상한을 넘었습니다. 마크다운 본문은 8,000자, HTML 본문은 256KB까지입니다 — 본문을 줄이거나 HTML 형식으로 바꿔 주세요.",
  mail_template_image_rejected: "본문 이미지를 저장할 수 없습니다 — 허용 형식은 PNG·JPEG·GIF·WebP이고, 이미지 1개 200KB·합계 600KB·최대 8개까지입니다.",
  video_review_stale_precondition: "검수 대상의 최신 리비전·정책 정보가 바뀌었습니다. 상세를 다시 불러온 뒤 판정해 주세요.",
  video_review_invalid_transition: "이미 판정이 끝났거나 현재 상태에서 선택할 수 없는 판정입니다. 목록을 새로고침해 주세요.",
  video_review_reason_required: "변경 요청·반려 사유를 선택해 주세요.",
  video_review_customer_message_required: "크리에이터에게 보여줄 안내 문구를 선택해 주세요.",
  // RAF 진단: 파트너 활성화 사전조건 실패는 승인 확정 경로에서 발생한다. 서버가 코드만
  // 통과시키므로(원문 메시지·식별자 비노출) 화면은 아래 고정 문구로 사유와 다음 조치를 구분한다.
  partner_activation_identity_incomplete: "연결 정보(등록·리비전 식별자)가 일부 비어 있어 활성화를 확정할 수 없습니다. 새로고침으로 해결되지 않으니 관리자가 연결 정보를 대조·보완해 주세요.",
  partner_activation_identity_conflict: "연결 정보가 현재 프로그램·리비전과 서로 어긋나 활성화를 확정할 수 없습니다. 새로고침으로 해결되지 않으니 관리자가 연결 정보를 대조해 바로잡아 주세요.",
  partner_activation_not_current_revision: "활성화 대상 리비전이 최신 상태가 아닙니다. 상세를 다시 불러온 뒤 최신 리비전으로 다시 시도해 주세요.",
  partner_activation_withdrawn_revision: "철회된 리비전은 승인·활성화할 수 없습니다. 최신 리비전을 다시 불러와 주세요.",
  partner_activation_already_revoked: "이미 해지된 활성화입니다. 재활성화가 필요하면 운영자가 해지 이력을 확인한 뒤 명시적으로 검토해야 합니다.",
  partner_activation_counter_drift: "활성화 카운터·상태 값이 어긋나 있어 자동 확정을 멈췄습니다. 새로고침으로 해결되지 않으니 관리자가 활성화 상태를 대조해 주세요.",
  partner_activation_unparseable: "기존 활성화 기록을 해석할 수 없어 자동 확정을 멈췄습니다. 관리자가 활성화 기록을 대조·정정해 주세요.",
  partner_activation_rejected: "활성화 사전조건을 확인하지 못해 승인 확정을 진행할 수 없습니다. 관리자가 활성화 상태를 확인한 뒤 다시 시도해 주세요.",
  // W91 [헤세 · admin-bridge]: scpPortalCreatorCommand 의 포털 커맨드 거부 코드별 문구.
  // ScpCreatorDirectoryPanel 은 stale_revision 을 별도로 잡아 자동 재로딩까지 하므로, 여기 문구는
  // 그 처리가 실패했을 때(또는 다른 진입점)의 최소 안내다.
  stale_revision: "다른 곳에서 먼저 변경됐습니다 — 새로고침 후 다시 시도해 주세요.",
  receipt_conflict: "이미 처리된 요청과 충돌합니다. 목록을 새로고침한 뒤 다시 시도해 주세요.",
  application_workflow_required: "먼저 검토 시작 단계를 거쳐야 하는 요청입니다.",
  flu_creator_mapping_conflict: "이미 다른 크리에이터에 연결된 매핑입니다.",
  superadmin_required: "이 작업은 최고 관리자만 수행할 수 있습니다.",
  program_forbidden: "이 작업에 필요한 프로그램 권한이 없습니다.",
  scp_admin_bridge_command_unavailable: "포털 연결이 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.",
  scp_admin_bridge_command_rejected: "포털에서 요청을 거부했습니다. 잠시 후 다시 시도해 주세요.",
  scp_admin_bridge_command_role_forbidden: "이 작업은 관리자 이상만 수행할 수 있습니다.",
  // W91 정정(적대적 리뷰 LOW): programEnrollments 필드별 힌트 문구 — 편집기가 어느 입력이
  // 틀렸는지 보여줄 수 있게 한다.
  scp_admin_bridge_enrollment_empty: "참여 프로그램을 1개 이상 입력하세요.",
  scp_admin_bridge_enrollment_id_invalid: "참여 항목의 식별자(id) 형식이 올바르지 않습니다.",
  scp_admin_bridge_enrollment_program_id_invalid: "참여 항목의 프로그램을 선택하세요.",
  scp_admin_bridge_enrollment_guide_release_id_invalid: "Guide Release ID 형식이 올바르지 않습니다 — 포털 admin 화면의 값을 그대로 입력하세요.",
  scp_admin_bridge_enrollment_policy_version_invalid: "Policy Version 형식이 올바르지 않습니다 — 포털 admin 화면의 값을 그대로 입력하세요.",
  scp_admin_bridge_enrollment_status_invalid: "참여 상태 값이 올바르지 않습니다.",
  scp_admin_bridge_enrollment_valid_from_invalid: "시작일(validFrom)이 올바르지 않습니다.",
  scp_admin_bridge_enrollment_valid_to_invalid: "종료일(validTo)은 시작일 이후여야 합니다.",
  scp_admin_bridge_enrollment_duplicate_pair: "같은 프로그램에 같은 참여 항목이 중복됐습니다.",
  scp_admin_bridge_enrollment_duplicate_active_program: "같은 프로그램에 active 상태 참여가 2개 이상입니다.",
  scp_admin_bridge_enrollment_default_conflict: "기본(isDefault) 참여는 active 상태 중 1개만 지정할 수 있습니다.",
  scp_admin_bridge_enrollment_default_requires_active: "기본(isDefault) 참여는 active 상태여야 합니다.",
};

function ownClientErrorField(value: unknown, field: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function callableErrorCode(error: unknown): PublicCallableErrorCode | null {
  const rawCode = ownClientErrorField(error, "code");
  if (typeof rawCode !== "string") return null;
  const normalized = rawCode.startsWith("functions/") ? rawCode.slice("functions/".length) : rawCode;
  return Object.prototype.hasOwnProperty.call(PUBLIC_CALLABLE_ERROR_MESSAGES, normalized)
    ? normalized as PublicCallableErrorCode
    : null;
}

export function callableBusinessErrorCode(error: unknown): string {
  const details = ownClientErrorField(error, "details");
  const rawErrorCode = ownClientErrorField(details, "errorCode");
  return typeof rawErrorCode === "string"
    && Object.prototype.hasOwnProperty.call(PUBLIC_BUSINESS_ERROR_MESSAGES, rawErrorCode)
    ? rawErrorCode
    : "";
}

/**
 * W8-10: 허용된 사유 코드에 실려 온 **단계별 탈락 카운트**. 서버가 센 숫자만 통과하므로
 * (functions/callableErrorBoundary.callableErrorCounts) 화면이 사유를 추측하지 않아도 된다.
 */
export function publicCallableErrorCounts(error: unknown): Record<string, number> {
  if (!callableBusinessErrorCode(error)) return {};
  const details = ownClientErrorField(error, "details");
  const raw = ownClientErrorField(details, "counts");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) counts[key] = value;
  }
  return counts;
}

export function publicCallableErrorMessage(
  error: unknown,
  fallback = "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
): string {
  const businessErrorCode = callableBusinessErrorCode(error);
  if (businessErrorCode) return PUBLIC_BUSINESS_ERROR_MESSAGES[businessErrorCode];
  const code = callableErrorCode(error);
  return code ? PUBLIC_CALLABLE_ERROR_MESSAGES[code] : fallback;
}

function isReadableRole(role: Role | null): role is ReadableRole {
  return role === "super_admin" || role === "admin" || role === "manager" || role === "viewer";
}

function canReadDatasetKeyForRole(role: ReadableRole | null, key: DatasetKey): boolean {
  return role !== null && ROLE_DATASET_KEYS[role].has(key);
}

function datasetKeysForRole(keys: DatasetKey[], role: ReadableRole | null): DatasetKey[] {
  if (!role) return [];
  const allowed = ROLE_DATASET_KEYS[role];
  return uniqueDatasetKeys(keys).filter((key) => allowed.has(key));
}

function isSnapshotFirstRoute(pathname: string): boolean {
  return pathname === "/flu" || pathname === "/flu/" || pathname.startsWith("/flu/programs");
}

export function datasetKeysForPath(pathname: string): DatasetKey[] {
  if (isDevelopmentOnlyNoDataRoute(pathname)) return [];
  if (pathname.startsWith("/chat")) return ["conversations", "creators", "templates", "autoReply", "programs", "programApplications", "campaigns"];
  if (pathname.startsWith("/admin/knowledge")) return ["feedback", "knowledgeNodes", "knowledgeEdges", "behaviorLogs", "llmUsage"];
  if (pathname.startsWith("/admin/logs")) return ["behaviorLogs", "costLogs"];
  if (pathname.startsWith("/admin/llm")) return ["llmUsage", "feedback"];
  if (pathname.startsWith("/admin/members")) return ["members", "behaviorLogs"];
  if (pathname.startsWith("/admin")) return ["members", "llmUsage", "creators", "escalations", "behaviorLogs"];
  if (pathname.startsWith("/flu/campaigns")) return ["campaigns", "contracts", "creators", "channelStats", "members", "candidatePool", "recCandidates", "conversations", "programs"];
  // Flu/Task-43: 후보 탭 프로그램/캠페인 셀렉터에만 필요. 후보 행 자체는 listCandidates 콜러블을
  // 직접 호출해 받는다(discover 페이지의 스코프드 후보 목록과 같은 패턴 — candidatePool 라이브
  // 번들을 거치지 않는다).
  if (pathname.startsWith("/flu/candidates")) return ["campaigns", "programs"];
  if (pathname.startsWith("/flu/community")) return ["communityPosts", "creators", "creatorComments"];
  if (pathname.startsWith("/flu/content")) return ["videos", "communityPosts", "creators", "submissions"];
  if (pathname.startsWith("/flu/contracts")) return ["contracts", "creators", "conversations", "programs", "programApplications"];
  if (pathname.startsWith("/flu/cost-guide")) return ["escalations", "creators"];
  if (pathname.startsWith("/flu/data")) return ["rawRecords", "contracts", "reviews", "creators", "campaigns", "programs", "programApplications", "conversations"];
  if (pathname.startsWith("/flu/discover")) return ["candidatePool", "recCandidates", "creators", "channelStats", "videos", "creatorComments", "campaigns", "programs", "programApplications"];
  if (pathname.startsWith("/flu/influencers")) return ["scpLifecycleProfiles", "creators", "channelStats", "contracts", "reviews", "submissions", "videos", "conversations", "creatorComments", "candidatePool", "recCandidates", "programApplications", "programs", "campaigns"];
  if (pathname.startsWith("/flu/new")) return ["creators", "campaigns", "candidatePool", "members", "recCandidates"];
  // Partner list/detail are Firestore-callable cutover surfaces (getActivePartners/getPartnerTabEnvelopes);
  // do not hydrate retired Sheets/submission datasets for the normal Partner route.
  if (pathname.startsWith("/flu/partners")) return [];
  if (pathname.startsWith("/flu/programs")) return [];
  if (pathname.startsWith("/flu/report")) return ["creators", "channelStats", "campaigns", "programs", "programApplications", "contracts", "reviews", "videos", "candidatePool", "submissions", "escalations"];
  // Review first paints from canonical Firestore review/application/lead/submission ledgers.
  if (pathname.startsWith("/flu/review")) return ["reviews", "creators", "submissions", "programApplications", "programSheetLeads"];
  if (pathname.startsWith("/flu/search")) return ["creators", "channelStats", "recCandidates", "candidatePool"];
  // W8-1c: 메일 템플릿 탭(`/flu/scp?tab=mail-templates`)은 발행본을 scpMailTemplates 로 읽는다.
  // 이 분기가 없어 라우트가 아래 기본 세트로 떨어지면서 그 키가 한 번도 실리지 않았고, 카드가
  // 항상 fallback 뱃지 + 기본 초안 프리필로 떠서 Publish 가 발행본을 덮어쓸 위험이 있었다.
  // 나머지 세 키는 이 분기가 생기기 전 기본 세트와 같다(호환 검수 뷰 하이드레이션 무변경).
  // W8-9: 콜드메일 편집기가 이 탭으로 이설돼 프로그램 목록(programs)이 필요하다 — 키가 없으면
  // 셀렉트가 영원히 비어 편집 자체가 불가능하다(W8-1c 와 같은 결함 클래스).
  // /flu/review 의 비-영상 레거시 딥링크는 이제 이 라우트(?tab=ops)로 리다이렉트되어 호환 영역
  // (ReviewWorkspace compatibilityMode)을 렌더한다. 결과메일 큐는 scpMailResults(발송 원장)로
  // provider-confirmed 발송 완료 리드를 걸러낸다 — 키가 없으면 이미 보낸 리드가 계속 "미발송"으로
  // 큐에 남는다(W8-1c 와 같은 결함 클래스: 키 누락이 조용한 오판정을 만든다).
  if (pathname.startsWith("/flu/scp")) return ["scpMailTemplates", "programs", "creators", "reviews", "escalations", "scpMailResults"];
  if (pathname.startsWith("/flu/settings")) {
    return ["members", "templates", "autoReply", "feedback", "programs", "scpMailTemplates"];
  }
  if (pathname === "/flu" || pathname === "/flu/") return [];
  return ["creators", "reviews", "escalations"];
}

export function prefetchGroupsForPath(pathname: string): DatasetKey[][] {
  if (isDevelopmentOnlyNoDataRoute(pathname)) return [];
  if (isSnapshotFirstRoute(pathname)) return [];
  if (pathname.startsWith("/chat")) return [["feedback"]];
  if (pathname.startsWith("/flu/discover") || pathname.startsWith("/flu/search")) {
    return [["campaigns", "contracts", "programs"], ["conversations", "templates"]];
  }
  if (pathname.startsWith("/flu/influencers")) {
    return [["programs", "programApplications", "campaigns"], ["templates", "autoReply"], ["submissions", "programSheetLeads", "submissionTasks", "creatorLinks"]];
  }
  if (pathname.startsWith("/flu/campaigns")) return [["reviews", "escalations", "programs", "programApplications"], ["templates", "autoReply"]];
  if (pathname.startsWith("/flu/report")) return [["communityPosts", "creatorComments"], ["llmUsage"]];
  if (pathname.startsWith("/flu/review")) return [["creatorLinks", "scpMailTemplates", "scpMailResults", "submissionTasks"]];
  return [];
}

export function autoHydratePageKeysForPath(pathname: string): DatasetKey[] {
  if (isDevelopmentOnlyNoDataRoute(pathname)) return [];
  if (
    pathname === "/flu" ||
    pathname === "/flu/"
  ) {
    return [];
  }
  if (pathname.startsWith("/flu/influencers")) {
    return ["scpLifecycleProfiles"];
  }
  // Conversation-heavy route read models rely on the bounded first page plus explicit
  // loadMore/targeted fetches; do not drain the entire mail history by default.
  if (
    pathname.startsWith("/chat") ||
    pathname.startsWith("/flu/programs") ||
    pathname.startsWith("/flu/campaigns")
  ) {
    return [];
  }
  return [];
}

// W108: /chat "사람" 탭 전용 온디맨드 드레인 판정 — 위 autoHydratePageKeysForPath의 "/chat" 분기
// (라우트 진입 시 기본 자동 드레인은 하지 않는다는 2026-08-16 비용 정책)는 그대로 둔 채, 탭을
// 연 사용자 행동에만 붙이는 별도 트리거다. 순수 함수라 세 조건을 한 곳에서 검증할 수 있다:
//   1) cursor 가 없으면(=이미 전부 로드됨) 호출 자체가 불필요하다.
//   2) 같은 인증 스코프(scopeKey)에서 이미 드레인을 마쳤으면 탭을 오가도 다시 돌지 않는다.
//   3) 스코프가 바뀌면(계정 전환 등) 다시 드레인할 수 있어야 한다.
// scopeKey/drainedScopeKey는 호출부가 인증 스코프(authScopeKey+authScopeGeneration)로부터
// canonicalScopeIdentity로 만들어 넣는다 — makeLiveAuthScope/isCurrentAuthScope와 같은 인증
// 스코프 판정 축(identity/generation)을 그대로 재사용한 것.
// W111 리뷰(HIGH): 이 시간 이상 자리를 비웠다 돌아오면 병합이 아니라 교체로 받아 정합을 회복한다.
const STALE_REPLACE_AFTER_HIDDEN_MS = 10 * 60 * 1000;

export function shouldDrainConversations(
  scopeKey: string | null,
  drainedScopeKey: string | null,
  cursor: string | null | undefined,
): boolean {
  if (!scopeKey || !cursor) return false;
  return drainedScopeKey !== scopeKey;
}

function loadedKeySet(bundle: DatasetBundle): Set<DatasetKey> {
  return new Set(bundle.loadedKeys ?? DATASET_KEYS);
}

function hasLoadedKeys(bundle: DatasetBundle, keys?: DatasetKey[]): boolean {
  if (!keys || keys.length === 0) return true;
  const loaded = loadedKeySet(bundle);
  return keys.every((key) => loaded.has(key));
}

function hasAnyLoadedKey(bundle: DatasetBundle, keys?: DatasetKey[]): boolean {
  if (!keys || keys.length === 0) return true;
  const loaded = loadedKeySet(bundle);
  return keys.some((key) => loaded.has(key));
}

function isMemoryFresh(cache: LiveMemoryCache): boolean {
  return Date.now() - cache.storedAt < MEMORY_TTL_MS;
}

function readMemoryBundle(identity: string, keys?: DatasetKey[], allowStale = false, requireAllKeys = true): DatasetBundle | null {
  if (!liveMemoryCache || liveMemoryCache.identity !== identity) return null;
  if (!allowStale && !isMemoryFresh(liveMemoryCache)) return null;
  const hasRequestedKeys = requireAllKeys
    ? hasLoadedKeys(liveMemoryCache.bundle, keys)
    : hasAnyLoadedKey(liveMemoryCache.bundle, keys);
  return hasRequestedKeys ? liveMemoryCache.bundle : null;
}

export function shouldRevalidateFreshCache(keys?: DatasetKey[]): boolean {
  if (!keys || keys.length === 0) return true;
  return keys.some((key) => REVALIDATE_WHEN_FRESH_KEYS.has(key));
}

/**
 * 휘발성 키를 재조회할 때 **함께 재조회해야 하는 조인 파트너**. 휘발성 키만 새로 받고 조인 상대를
 * 60초 캐시로 두면, 새로 들어온 행이 상대 쪽에 없어 **화면에서 조용히 사라진다**(H5):
 *   - `scpLifecycleProfiles`↔`creators`: 관리 탭의 새 프로필이 creator 문서를 못 찾아 행이 빠진다.
 *   - `conversations`↔`creators`: /chat 사람 검색이 새 발신자를 찾지 못한다(M2).
 *   - `reviews`↔`creators`: 검수 행이 이름 대신 익명 해시로 뜬다(M3).
 * 파트너는 **요청 묶음에 이미 들어 있을 때만** 함께 받는다 — 화면이 요청하지도 않은 키를 새로
 * 여는 것은 이 계약의 일이 아니다(비용 회귀 방지).
 */
const DATASET_COFETCH_PARTNERS: Partial<Record<DatasetKey, readonly DatasetKey[]>> = {
  scpLifecycleProfiles: ["creators"],
  conversations: ["creators"],
  reviews: ["creators"],
};

export function datasetCofetchPartners(key: DatasetKey): readonly DatasetKey[] {
  return DATASET_COFETCH_PARTNERS[key] ?? [];
}

/**
 * 캐시가 신선한데(<60s) 휘발성 키 때문에 재검증해야 할 때, **실제로 네트워크로 보낼 키**를 고른다.
 * 캐시에 없는 키 + 휘발성 키 + (요청 묶음 안에 있는) 그 조인 파트너만 남기고, 나머지 비휘발성 키
 * (creators 652KB 등)는 캐시를 그대로 쓴다.
 * COST-P0-011: 종전엔 묶음에 휘발성 키가 하나만 있어도 묶음 전체를 재전송했다.
 */
export function datasetKeysToFetchFromFreshCache(
  requested: readonly DatasetKey[],
  missingFromCache: readonly DatasetKey[],
): DatasetKey[] {
  const requestedSet = new Set(requested);
  const volatileKeys = requested.filter((key) => REVALIDATE_WHEN_FRESH_KEYS.has(key));
  const joinPartners = volatileKeys.flatMap(
    (key) => datasetCofetchPartners(key).filter((partner) => requestedSet.has(partner)),
  );
  return uniqueDatasetKeys([...missingFromCache, ...volatileKeys, ...joinPartners]);
}

function splitDatasetKeys(keys?: DatasetKey[]): { smallKeys?: DatasetKey[]; pageKeys: DatasetKey[] } {
  if (!keys) return { smallKeys: undefined, pageKeys: Array.from(PAGED_DATASET_KEYS) };
  return {
    smallKeys: keys.filter((key) => !PAGED_DATASET_KEYS.has(key)),
    pageKeys: keys.filter((key) => PAGED_DATASET_KEYS.has(key)),
  };
}

function emptyDatasetBundle(): DatasetBundle {
  return {
    ok: true,
    seeded: false,
    loadedKeys: [],
    counts: {},
    pageInfo: {},
    creators: [],
    channelStats: {},
    agencies: [],
    campaigns: [],
    programs: [],
    programApplications: [],
    programSheetLeads: [],
    scpQualificationRows: [],
    creatorLinks: [],
    scpMailTemplates: [],
    scpMailResults: [],
    submissionTasks: [],
    contracts: [],
    reviews: [],
    escalations: [],
    submissions: [],
    videos: [],
    scpLifecycleProfiles: [],
    candidatePool: [],
    feedDiscoveryState: [],
    members: [],
    llmUsage: [],
    communityPosts: [],
    templates: [],
    conversations: [],
    autoReply: [],
    feedback: [],
    knowledgeNodes: [],
    knowledgeEdges: [],
    behaviorLogs: [],
    costLogs: [],
    rawRecords: [],
    recCandidates: [],
    creatorComments: [],
  };
}

function withoutUntrustedDatasetLoadErrors(bundle: DatasetBundle): DatasetBundle {
  const safe = { ...bundle };
  delete safe.loadErrors;
  delete safe.partialLoadError;
  return safe;
}

function bundleFromPage(page: DatasetPageEnvelope): DatasetBundle {
  const bundle = emptyDatasetBundle();
  bundle.seeded = page.key === "creators" ? page.rows.length > 0 : false;
  bundle.loadedKeys = [page.key];
  bundle.cache = page.cache;
  bundle.counts = page.counts;
  bundle.pageInfo = { [page.key]: page.pageInfo };
  const record = bundle as unknown as Record<DatasetKey, unknown>;
  record[page.key] = page.rows;
  return bundle;
}

function livePagedDatasetScope(scope: LiveAuthScope): LivePagedDatasetScope {
  return {
    communityProgramId: scope.communityScope.programId,
    communityCampaignId: scope.communityScope.campaignId,
    scpLifecycleProgramId: scope.scpLifecycleScope.programId,
    ...(scope.viewAsScope.userId && scope.viewAsScope.email
      ? { viewAsUserId: scope.viewAsScope.userId, viewAsEmail: scope.viewAsScope.email }
      : {}),
  };
}

// COST-P0-006/011 대응(이 wrapper 자체가 비용 절감 룰 대응이다): 진행 중인 **동일 콜러블·동일
// 페이로드** 요청을 한 번으로 합친다. load() 단위의 기존 in-flight 병합(overlappingInFlightKeys)이
// 못 덮는 두 구멍을 막는다 — (1) 드레인 루프(loadRemainingPages)는 load()를 거치지 않고 로더를 직접
// 부른다, (2) force 경로는 그 병합을 통째로 우회한다. 프로드 실측에서 /flu/influencers 의
// listScpLifecycleProfiles 7.6MB 중복 호출(라우트 로더 + 화면 훅이 같은 페이로드로 각자 요청)이
// 여기서 1회로 수렴한다. 완료된 응답은 캐싱하지 않으므로(callable-dedupe.ts) 신선도 계약 무변경.
function loadDatasetPageDeduped(
  loader: PagedDatasetLoader,
  key: DatasetKey,
  payload: { cursor?: string; limit?: number },
  scope: LiveAuthScope,
  force = false,
): Promise<DatasetPageEnvelope> {
  const pagedScope = livePagedDatasetScope(scope);
  const dedupeKey = callableDedupeKey(
    `dataset-page:${key}`,
    scopedDatasetPagePayload(key, payload, pagedScope),
    scope,
  );
  return dedupeCallable(
    dedupeKey,
    () => invokeScopedDatasetPageLoader(loader, key, payload, pagedScope),
    { bypass: force },
  );
}

async function fetchDatasetBundle(
  keys: DatasetKey[] | undefined,
  cursors: Partial<Record<DatasetKey, string>> | undefined,
  scope: LiveAuthScope,
  // force 의 계약은 "네트워크 재요청을 강제한다"이다. 이 값을 아래 dedupeCallable 로 내려보내지
  // 않으면 수동 새로고침이 **진행 중이던 이전 응답에 그대로 합류**해, 사용자가 방금 만든 변경
  // 이전의 값을 다시 받는다(H4).
  force = false,
): Promise<DatasetBundle> {
  const { smallKeys, pageKeys } = splitDatasetKeys(keys);
  const calls: Array<{ errorKeys: DatasetKey[]; promise: Promise<DatasetBundle> }> = [];
  if (!keys || !smallKeys || smallKeys.length > 0) {
    // 2026-09-27 codex adversarial review round 3 FAIL-10: this small-key getDataset call omitted
    // viewAs entirely, unlike the paged loaders below (livePagedDatasetScope) — a super_admin
    // viewAs a non-granted person saw the super_admin's own scp entitlement (scpMailTemplates/
    // scpMailResults/scpQualificationRows/scpLifecycleProfiles keys) instead of the target's real
    // (denied) one. functions/read.ts's getDataset re-verifies this pair server-side
    // (effectiveConversationAuth/resolveViewAsTarget) before deriving the target's scope — never
    // trusts it as-is.
    const viewAsFields = scope.viewAsScope.userId && scope.viewAsScope.email
      ? { viewAsUserId: scope.viewAsScope.userId, viewAsEmail: scope.viewAsScope.email }
      : {};
    const datasetPayload = smallKeys && smallKeys.length > 0
      ? { keys: [...smallKeys].sort(), ...viewAsFields }
      : { ...viewAsFields };
    const bundlePromise = dedupeCallable(
      callableDedupeKey("getDataset", datasetPayload, scope),
      () => getDataset(datasetPayload),
      { bypass: force },
    ).then(withoutUntrustedDatasetLoadErrors);
    bundlePromise.then((bundle) => announcePartialBundle({ bundle, scope })).catch(() => {});
    calls.push({
      errorKeys: smallKeys ?? DATASET_KEYS.filter((key) => !PAGED_DATASET_KEYS.has(key)),
      promise: bundlePromise,
    });
  }
  for (const key of pageKeys) {
    const loadPage = PAGED_LOADERS[key];
    const cursor = cursors?.[key];
    const limit = PAGE_LIMITS[key];
    if (loadPage) {
      const pagePromise = loadDatasetPageDeduped(
        loadPage,
        key,
        {
          ...(cursor ? { cursor } : {}),
          ...(limit ? { limit } : {}),
        },
        scope,
        force,
      ).then(bundleFromPage);
      // cursor 있는 콜(loadMore 계속 페이지)은 append 병합이 필요해 즉시-커밋 대상에서 제외 —
      // 그대로 announce하면 commitBundle의 기본 replace 병합이 순간적으로 기존 목록을 새 페이지 분량으로 덮어쓴다.
      if (!cursor) pagePromise.then((bundle) => announcePartialBundle({ bundle, scope })).catch(() => {});
      calls.push({ errorKeys: [key], promise: pagePromise });
    }
  }
  const results = await Promise.allSettled(calls.map((call) => call.promise));
  const loadErrors: Partial<Record<DatasetKey, string>> = {};
  results.forEach((result, index) => {
    if (result.status !== "rejected") return;
    const reason: unknown = result.reason;
    const message = publicCallableErrorMessage(reason, "데이터를 불러오지 못했습니다.");
    Object.assign(loadErrors, datasetLoadErrorsForKeys(calls[index]?.errorKeys ?? [], message));
  });
  const fulfilled = results
    .filter((result): result is PromiseFulfilledResult<DatasetBundle> => result.status === "fulfilled")
    .map((result) => result.value);
  // A background request where every loader rejects still needs to commit terminal per-key
  // errors. Returning an empty, explicitly-loaded-nothing bundle lets the page leave its pending
  // state and present a retry path without clearing any previously cached rows.
  const first = fulfilled[0] ?? emptyDatasetBundle();
  const merged = fulfilled.slice(1).reduce((acc, next) => mergeDatasetBundle(acc, next), first);
  if (Object.keys(loadErrors).length > 0) {
    const partialLoadError = Object.entries(loadErrors)
      .map(([key, message]) => `${key}: ${message}`)
      .join("; ");
    return { ...merged, loadErrors, partialLoadError };
  }
  return merged;
}

function requestCursorKey(cursors?: Partial<Record<DatasetKey, string>>): string {
  return cursors
    ? Object.entries(cursors)
      .filter((entry): entry is [DatasetKey, string] => typeof entry[1] === "string" && entry[1].length > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, cursor]) => `${key}:${cursor}`)
      .join("|")
    : "";
}

function requestKey(scope: LiveAuthScope, keys?: DatasetKey[], cursors?: Partial<Record<DatasetKey, string>>): string {
  const cursorKey = requestCursorKey(cursors);
  return `${scope.authScopeKey}@${scope.generation}:${scope.communityScope.scopeKey}:${scope.scpLifecycleScope.scopeKey}:${keys && keys.length > 0 ? [...keys].sort().join(",") : "all"}:${cursorKey}`;
}

function inFlightScopeIdentity(scope: LiveAuthScope): string {
  return `${scope.authScopeKey}@${scope.generation}:${scope.communityScope.scopeKey}:${scope.scpLifecycleScope.scopeKey}`;
}

function containsEveryDatasetKey(source: readonly DatasetKey[], target: readonly DatasetKey[]): boolean {
  const sourceSet = new Set(source);
  return target.every((key) => sourceSet.has(key));
}

function reusableInFlightRequest(
  scope: LiveAuthScope,
  keys: readonly DatasetKey[],
  cursorKey: string,
): LiveInFlightRequest | null {
  const scopeIdentity = inFlightScopeIdentity(scope);
  return liveInFlightRequests.find((request) => (
    request.scopeIdentity === scopeIdentity
    && request.cursorKey === cursorKey
    && containsEveryDatasetKey(request.keys, keys)
  )) ?? null;
}

function overlappingInFlightKeys(
  scope: LiveAuthScope,
  keys: readonly DatasetKey[],
  cursorKey: string,
): DatasetKey[] {
  const scopeIdentity = inFlightScopeIdentity(scope);
  const overlapped = new Set<DatasetKey>();
  for (const request of liveInFlightRequests) {
    if (request.scopeIdentity !== scopeIdentity || request.cursorKey !== cursorKey) continue;
    for (const key of keys) {
      if (request.keys.includes(key)) overlapped.add(key);
    }
  }
  return [...overlapped];
}

function mergeRows(prev: unknown, next: unknown): unknown {
  if (!Array.isArray(prev) || !Array.isArray(next)) return next;
  const merged = [...prev];
  const indexById = new Map<string, number>();
  prev.forEach((item, index) => {
    const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
    if (typeof id === "string" && id.length > 0) indexById.set(id, index);
  });
  for (const item of next) {
    const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
    if (typeof id === "string" && id.length > 0) {
      const existingIndex = indexById.get(id);
      if (existingIndex !== undefined) {
        merged[existingIndex] = item;
        continue;
      }
      indexById.set(id, merged.length);
    }
    merged.push(item);
  }
  return merged;
}

function mergeDatasetBundle(
  prev: DatasetBundle | null,
  next: DatasetBundle,
  appendKeys: Set<DatasetKey> = new Set(),
  authoritative = false,
  authoritativeKeys: ReadonlySet<DatasetKey> = new Set(),
): DatasetBundle {
  if (!prev) return next;

  const nextLoaded = loadedKeySet(next);
  const merged = { ...prev, ...next } as DatasetBundle;
  const prevRecord = prev as unknown as Record<DatasetKey, unknown>;
  const mergedRecord = merged as unknown as Record<DatasetKey, unknown>;

  // `cache.requestedKeys` is request history, not the keys of whichever auxiliary
  // response happened to settle last. Without this union a quick reviews/notifications
  // request overwrote the slower SCP Sheet request metadata, making the status panel claim
  // those keys had never been requested even while they were still in flight.
  const latestCache = next.cache ?? prev.cache;
  if (latestCache) {
    merged.cache = {
      ...latestCache,
      requestedKeys: uniqueDatasetKeys([
        ...(prev.cache?.requestedKeys ?? []),
        ...(next.cache?.requestedKeys ?? []),
      ]),
    };
  }

  for (const key of DATASET_KEYS) {
    if (!nextLoaded.has(key)) {
      mergedRecord[key] = prevRecord[key];
    } else if (appendKeys.has(key)) {
      mergedRecord[key] = mergeRows(prevRecord[key], mergedRecord[key]);
    }
  }

  merged.loadedKeys = uniqueDatasetKeys([...(prev.loadedKeys ?? DATASET_KEYS), ...(next.loadedKeys ?? DATASET_KEYS)]);
  merged.counts = { ...prev.counts, ...next.counts };
  merged.pageInfo = { ...prev.pageInfo, ...next.pageInfo };
  for (const key of DATASET_KEYS) {
    if (!nextLoaded.has(key)) {
      if (prev.counts[key] !== undefined) merged.counts[key] = prev.counts[key];
      if (prev.pageInfo[key]) merged.pageInfo[key] = prev.pageInfo[key];
    }
  }
  merged.seeded = nextLoaded.has("creators") ? next.seeded : prev.seeded;
  // hotfix2: progressive-commit로 도착하는 개별 키 부분 번들(next)은 loadErrors를 절대 건드리지 않는다
  // (authoritative=false, 기본값 — 아래 블록 전체 skip). 문제는 authoritative=true라도 그 호출이 "이번에
  // 실제로 요청한 키(authoritativeKeys)"만 알 뿐이라는 것 — 예: 백그라운드 prefetch 그룹이
  // ["conversations","templates","autoReply"]만 요청해 전부 성공하면, 그 결과의 loadErrors는 비어있지만
  // 그렇다고 별개 키인 scpLifecycleProfiles의 기존 실패 기록까지 지우면 안 된다(레이스 - §coordinator 리포트).
  // 그래서 loadErrors는 키 단위로 병합한다: authoritativeKeys에 없는(=이번 호출이 관여하지 않은) 키의
  // 기존 에러는 그대로 보존하고, authoritativeKeys에 포함된 키만 이번 결과(next.loadErrors)로 갱신한다.
  // "bundle"(smallKeys getDataset 집계 호출) 슈도키는 authoritativeKeys에 smallKeys가 하나라도 있었을
  // 때만 이번 호출이 관여한 것으로 간주한다.
  if (authoritative) {
    const nextErrors = next.loadErrors ?? {};
    const prevErrors = prev.loadErrors ?? {};
    const attemptedBundleThisRound = [...authoritativeKeys].some((key) => !PAGED_DATASET_KEYS.has(key));
    const mergedErrors: Partial<Record<DatasetKey | "bundle", string>> = {};
    for (const key of Object.keys(prevErrors) as (DatasetKey | "bundle")[]) {
      const outOfScope = key === "bundle" ? !attemptedBundleThisRound : !authoritativeKeys.has(key);
      if (outOfScope) mergedErrors[key] = prevErrors[key];
    }
    for (const key of Object.keys(nextErrors) as (DatasetKey | "bundle")[]) {
      mergedErrors[key] = nextErrors[key];
    }
    if (Object.keys(mergedErrors).length > 0) {
      merged.loadErrors = mergedErrors;
      merged.partialLoadError = Object.entries(mergedErrors).map(([key, message]) => `${key}: ${message}`).join("; ");
    } else {
      delete merged.loadErrors;
      delete merged.partialLoadError;
    }
  }
  return merged;
}

function keyIsLoaded(data: DatasetBundle, key: DatasetKey): boolean {
  return loadedKeySet(data).has(key);
}

function scheduleIdleTask(task: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (idleWindow.requestIdleCallback) {
    const handle = idleWindow.requestIdleCallback(task, { timeout: BACKGROUND_HYDRATE_TIMEOUT_MS });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(task, BACKGROUND_HYDRATE_TIMEOUT_MS);
  return () => window.clearTimeout(handle);
}

export function LiveDataSkeleton({
  label = "데이터 로딩 중",
  rows = 5,
  className = "",
}: {
  label?: string;
  rows?: number;
  className?: string;
}) {
  return (
    <div aria-label={label} className={["divide-y divide-line", className].filter(Boolean).join(" ")}>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3">
          <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-fill" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3.5 w-2/5 animate-pulse rounded bg-fill" />
            <div className="h-3 w-3/5 animate-pulse rounded bg-fill" />
          </div>
          <div className="h-6 w-16 animate-pulse rounded-full bg-fill" />
        </div>
      ))}
    </div>
  );
}

export function LiveDataProvider({ children }: { children: ReactNode }) {
  const authoritativeOrgScopeKey = useAuthoritativeOrgContextScopeKey();
  const { target: storedViewAsTarget } = useViewAs();
  const authoritativeOrgScopeKeyRef = useRef(authoritativeOrgScopeKey);
  const activeViewAsScopeRef = useRef<ViewAsDatasetScope>(SELF_VIEW_AS_DATASET_SCOPE);
  const latestAuthStateRef = useRef<AuthState | null>(null);
  const pathname = usePathname();
  const noDataRoute = useMemo(() => isDevelopmentOnlyNoDataRoute(pathname), [pathname]);
  // R7 P10: NOTIFICATION_DATASET_KEYS(reviews/conversations)를 라우트 필수 키에 더 이상 강제 병합하지 않는다 —
  // conversations 2000건 로드가 무관 라우트(예: /admin/llm, /flu/settings, /flu/content)의 벌크 loading을 잡던 구조 원인.
  // 알림 배지 데이터는 아래 별도 백그라운드 부트스트랩 effect가 채운다(키 단위 전환).
  const routeKeys = useMemo(() => uniqueDatasetKeys(datasetKeysForPath(pathname)), [pathname]);
  const [data, setDataState] = useState<DatasetBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState<Partial<Record<DatasetKey, boolean>>>({});
  const [loadingKeys, setLoadingKeys] = useState<Partial<Record<DatasetKey, boolean>>>({});
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [canRead, setCanRead] = useState(false);
  const [identity, setIdentity] = useState<string | null>(null);
  const [identityGeneration, setIdentityGeneration] = useState(0);
  const [liveRole, setLiveRole] = useState<ReadableRole | null>(null);
  const [chatForegroundSync, setChatForegroundSync] = useState<ChatForegroundSyncState>({
    enabled: false,
    inFlight: false,
    intervalMs: 0,
    error: null,
  });
  const snapshotFirstRoute = useMemo(() => isSnapshotFirstRoute(pathname), [pathname]);
  const snapshotRouteKey = useMemo(
    () => snapshotFirstRoute && identity ? canonicalScopeIdentity("snapshot-route-v2", [identity, pathname]) : null,
    [identity, pathname, snapshotFirstRoute],
  );
  const [postSnapshotHydratedRouteKey, setPostSnapshotHydratedRouteKey] = useState<string | null>(null);
  // The page emits its concrete key request only after the snapshot promise has actually settled.
  // Until that handshake arrives, refresh/visibility events are snapshot-only and must not start
  // route datasets from pathname/role information alone.
  const snapshotRouteSettled = !snapshotFirstRoute
    || (snapshotRouteKey !== null && postSnapshotHydratedRouteKey === snapshotRouteKey);
  const readableRouteKeys = useMemo(() => datasetKeysForRole(routeKeys, liveRole), [liveRole, routeKeys]);
  // 현재 라우트가 이미 요구하지 않는 알림 키만 분리 — 배지 데이터는 유지하되 라우트 loading을 잡지 않는다.
  // 스냅샷-first 화면은 알림/메일성 키도 스냅샷 이후 명시 요청으로만 시작해 첫 네트워크 호출을 보호한다.
  const notificationKeys = useMemo(
    () => isSnapshotFirstRoute(pathname)
      ? []
      : datasetKeysForRole(NOTIFICATION_DATASET_KEYS, liveRole).filter((key) => !readableRouteKeys.includes(key)),
    [liveRole, pathname, readableRouteKeys],
  );
  // Review action helpers are deliberately outside the blocking route load, but mutation and
  // visibility refreshes must still revalidate them after their idle hydration has started.
  const deferredRouteKeys = useMemo(
    () => pathname.startsWith("/flu/review")
      ? datasetKeysForRole(uniqueDatasetKeys(prefetchGroupsForPath(pathname).flat()), liveRole)
      : [],
    [liveRole, pathname],
  );
  const deferNotificationBootstrap = pathname.startsWith("/flu/review");
  const postSnapshotHydrationKeys = useMemo(
    () => datasetKeysForRole(requiredDatasetKeysAfterSnapshot(pathname), liveRole),
    [liveRole, pathname],
  );
  const snapshotRouteRefreshKeys = useMemo(
    () => datasetKeysForRole(requiredDatasetKeysForSnapshotRouteRefresh(pathname), liveRole),
    [liveRole, pathname],
  );
  // Snapshot-first routes deliberately have no blocking route keys, but an explicit refresh,
  // mutation refresh, or visibility revalidation must still refresh the datasets the page uses
  // after its snapshot settled. `/flu` may start its single primary route key immediately, while
  // pre-settlement revalidation remains empty so global events cannot duplicate that cold request.
  const refreshKeys = useMemo(
    () => noDataRoute
      ? []
      : uniqueDatasetKeys(snapshotFirstRoute
        ? (snapshotRouteSettled ? snapshotRouteRefreshKeys : [])
        : [...readableRouteKeys, ...deferredRouteKeys, ...notificationKeys]),
    [deferredRouteKeys, noDataRoute, notificationKeys, readableRouteKeys, snapshotFirstRoute, snapshotRouteRefreshKeys, snapshotRouteSettled],
  );
  const identityRef = useRef<string | null>(null);
  const identityGenerationRef = useRef(0);
  const routeKeysRef = useRef<DatasetKey[]>(routeKeys);
  const foregroundRouteLoadRef = useRef<Promise<void>>(Promise.resolve());
  const scpLifecycleScopeRef = useRef<ScpLifecycleDatasetScope>(UNREGISTERED_SCP_LIFECYCLE_DATASET_SCOPE);
  // 탭이 숨겨진 시각. 오래 비운 뒤 복귀하면 교체로 받아 보관·삭제 상태를 회복한다(W111 리뷰).
  const hiddenSinceMsRef = useRef(0);
  const chatRefreshInFlightRef = useRef(false);
  const chatRefreshRunRef = useRef(0);
  const autoHydrateRunningRef = useRef<Map<DatasetKey, string>>(new Map());
  const loadingKeyCountsRef = useRef<Partial<Record<DatasetKey, number>>>({});

  const isCurrentAuthScope = useCallback((scope: LiveAuthScope) => (
    identityRef.current === scope.authScopeKey
    && identityGenerationRef.current === scope.generation
    && scope.communityScope.scopeKey === SYSTEM_COMMUNITY_DATASET_SCOPE.scopeKey
  ), []);

  const isCurrentDatasetScope = useCallback((scope: LiveAuthScope, keys: readonly DatasetKey[]) => (
    !keys.includes("scpLifecycleProfiles")
    || scope.scpLifecycleScope.scopeKey === scpLifecycleScopeRef.current.scopeKey
  ), []);

  const bumpLoadingKeys = useCallback((keys: DatasetKey[], delta: 1 | -1, scope: LiveAuthScope) => {
    if (keys.length === 0 || !isCurrentAuthScope(scope)) return;
    const counts = loadingKeyCountsRef.current;
    for (const key of keys) {
      counts[key] = Math.max(0, (counts[key] ?? 0) + delta);
    }
    setLoadingKeys(() => {
      const next: Partial<Record<DatasetKey, boolean>> = {};
      for (const key of Object.keys(counts) as DatasetKey[]) {
        if ((counts[key] ?? 0) > 0) next[key] = true;
      }
      return next;
    });
  }, [isCurrentAuthScope]);

  useEffect(() => {
    routeKeysRef.current = routeKeys;
  }, [routeKeys]);

  const commitBundle = useCallback((next: DatasetBundle, scope: LiveAuthScope, appendKeys: DatasetKey[] = [], authoritative = false, authoritativeKeys: DatasetKey[] = []) => {
    const committedKeys = uniqueDatasetKeys([...(next.loadedKeys ?? []), ...authoritativeKeys]);
    if (!isCurrentDatasetScope(scope, committedKeys)) return;
    if (!isCurrentAuthScope(scope)) return;
    setDataState((prev) => {
      if (!isCurrentAuthScope(scope)) return prev;
      if (!isCurrentDatasetScope(scope, committedKeys)) return prev;
      const merged = mergeDatasetBundle(prev, next, new Set(appendKeys), authoritative, new Set(authoritativeKeys));
      liveMemoryCache = { identity: liveScopeCacheIdentity(scope), bundle: merged, storedAt: Date.now() };
      return merged;
    });
  }, [isCurrentAuthScope, isCurrentDatasetScope]);

  // R7 P10: fetchDatasetBundle이 개별 콜 settle 시점에 announce한 부분 번들을 즉시 커밋 —
  // 벌크 Promise.allSettled가 끝나기 전에도 이미 도착한 키는 perKeyLoaded에 바로 반영된다.
  useEffect(() => subscribePartialBundle(({ bundle, scope }) => {
    commitBundle(bundle, scope);
  }), [commitBundle]);

  const load = useCallback(async (keys?: DatasetKey[], options: LoadOptions = {}) => {
    if (noDataRoute) return;
    if (!identity || !liveRole) return;
    const requestScope = makeLiveAuthScope(identity, identityGeneration, scpLifecycleScopeRef.current, effectiveViewAsDatasetScope(liveRole, activeViewAsScopeRef.current));
    if (!isCurrentAuthScope(requestScope)) return;
    const requested = datasetKeysForRole(resolveRequestedDatasetKeys(keys), liveRole);
    if (requested.length === 0) {
      if (!options.background) {
        setLoading(false);
        setError(null);
      }
      return;
    }
    const cached = options.cursors ? null : readMemoryBundle(liveScopeCacheIdentity(requestScope), requested, true, false);
    const cachedComplete = Boolean(cached && hasLoadedKeys(cached, requested));
    const fresh = cached && liveMemoryCache ? isMemoryFresh(liveMemoryCache) : false;
    // COST-P0-011 대응: 휘발성 키(REVALIDATE_WHEN_FRESH_KEYS)의 "신선해도 재검증한다" 계약을
    //   생략하는 경로는 **유휴 프리페치 전용**이다(options.prefetch). 아직 아무도 열지 않은 화면을
    //   미리 채우는 요청까지 매번 재검증하면서 같은 페이지 로드 안에서 동일 데이터셋을 두 번씩
    //   당기고 있었다(프로드 실측: /flu/influencers 의 listSubmissions 1.5MB ×2 — 라우트 로더가
    //   받은 직후 유휴 프리페치 그룹이 같은 키를 다시 요청).
    //   H1: 종전엔 이 게이트가 `!options.background` 였는데, background 는 "블로킹 UI 를 건드리지
    //   않는다"는 렌더 신호일 뿐 **화면 훅의 정상 로드에도 붙는다**. 그래서 유일한 로더가
    //   background=true 인 `/flu/programs` 상세 키(PROGRAM_CONTEXT/OPERATIONAL_DETAIL_KEYS)는
    //   어떤 새로고침으로도 재조회되지 않았다. 이제 화면이 보고 있는 데이터는 배경 로드로도
    //   재검증되고, 프리페치만 60초 캐시를 그대로 쓴다 — 화면은 캐시로 즉시 그려지므로 SWR 그대로다.
    const revalidateFresh = !options.prefetch && shouldRevalidateFreshCache(requested);
    const requestedMissingFromCache = cached
      ? requested.filter((key) => !keyIsLoaded(cached, key))
      : requested;
    let fetchRequested = requested;

    // Foreground refreshes for volatile, high-volume datasets (notably conversations) must retain
    // the last visible rows while the replacement page is in flight. Clearing here made Chat/Programs
    // counts flicker to zero at bulk sizes; revalidation state is surfaced through loading/loadingKeys/stale.
    if (cached && !options.background) {
      setDataState((prev) => (isCurrentAuthScope(requestScope) ? cached : prev));
    }
    if (fresh && cachedComplete && !options.force && !revalidateFresh) {
      if (!options.background) {
        setLoading(false);
        setStale(false);
        setError(null);
      }
      return;
    }
    if (fresh && !cachedComplete && !options.force && !revalidateFresh) {
      fetchRequested = requestedMissingFromCache;
    } else if (fresh && !options.force && revalidateFresh) {
      // COST-P0-011 대응: 재검증은 **휘발성 키 + 그 조인 파트너**에만 건다. 종전엔 요청 키 묶음에
      //   휘발성 키가 하나라도 있으면 묶음 전체를 다시 당겼다 — 신선 캐시에 이미 있던 creators
      //   652KB 가 campaigns 때문에 함께 재전송됐다(프로드 실측 2026-08-22).
      //   creators/channelStats/templates 처럼 REVALIDATE_WHEN_FRESH_KEYS 에 없는 키는 60초 캐시를
      //   그대로 쓰고, 휘발성 키만 네트워크로 간다 — 화면은 캐시로 즉시 그려지므로 SWR 그대로다.
      //   단 조인 파트너(datasetCofetchPartners)는 예외로 함께 받는다: 휘발성 쪽에 새로 들어온 행이
      //   상대 캐시에 없으면 화면에서 조용히 사라지기 때문이다(H5).
      //   이 분기는 요청 묶음 단위라 influencers/chat/programs/review 가 공통으로 쓰는 키에 한 곳의
      //   수정이 동시에 적용된다(페이지별 특수 처리 없음).
      fetchRequested = datasetKeysToFetchFromFreshCache(requested, requestedMissingFromCache);
    }
    if (fetchRequested.length === 0) {
      if (!options.background) {
        setLoading(false);
        setStale(false);
        setError(null);
      }
      return;
    }

    if (!options.background) {
      // Cached volatile revalidation is a background freshness concern, not a route-wide blocking
      // load. Keeping global loading=false is what prevents Chat/Programs from swapping stable
      // counts/lists back to skeleton/zero during requestDataRefresh.
      setLoading(!cached);
      setStale(Boolean(cached) && !options.cursors);
      setError(null);
    }

    const cursorKey = requestCursorKey(options.cursors);
    const overlappedKeys = !options.force ? overlappingInFlightKeys(requestScope, fetchRequested, cursorKey) : [];
    const overlappedKeySet = new Set(overlappedKeys);
    const networkRequested = options.force
      ? fetchRequested
      : fetchRequested.filter((key) => !overlappedKeySet.has(key));
    const reusableInFlight = !options.force
      ? reusableInFlightRequest(requestScope, fetchRequested, cursorKey)
      : null;
    if (networkRequested.length === 0 && !reusableInFlight) {
      if (!options.background && isCurrentAuthScope(requestScope)) {
        setLoading(false);
        setStale(Boolean(cached) && !options.cursors);
        setError(null);
      }
      bumpLoadingKeys(fetchRequested, 1, requestScope);
      void Promise.all(
        liveInFlightRequests
          .filter((request) => (
            request.scopeIdentity === inFlightScopeIdentity(requestScope)
            && request.cursorKey === cursorKey
            && request.keys.some((key) => overlappedKeySet.has(key))
          ))
          .map((request) => request.promise.catch(() => emptyDatasetBundle())),
      ).finally(() => bumpLoadingKeys(fetchRequested, -1, requestScope));
      return;
    }
    const promiseRequested = reusableInFlight ? fetchRequested : networkRequested;
    const nextRequestKey = requestKey(requestScope, promiseRequested, options.cursors);
    const promise = reusableInFlight
      ? reusableInFlight.promise
      : fetchDatasetBundle(networkRequested, options.cursors, requestScope, Boolean(options.force));
    if (!reusableInFlight) {
      liveInFlightRequests.push({
        requestKey: nextRequestKey,
        scopeIdentity: inFlightScopeIdentity(requestScope),
        keys: networkRequested,
        cursorKey,
        promise,
      });
    }

    bumpLoadingKeys(fetchRequested, 1, requestScope);
    try {
      const bundle = await promise;
      // authoritative=true + requested: 이 결과는 fetchDatasetBundle이 "requested" 범위를 집계한 최종
      // 결과이므로, 그 범위 안에서는 에러 없음을 근거로 이전 loadErrors를 소거해도 된다 — 단 범위 밖
      // (이번에 요청 안 한) 키의 기존 에러는 mergeDatasetBundle이 authoritativeKeys로 보존한다.
      commitBundle(bundle, requestScope, options.appendKeys, true, promiseRequested);
      if (!options.background && isCurrentAuthScope(requestScope) && isCurrentDatasetScope(requestScope, promiseRequested)) setError(bundle.partialLoadError ?? null);
      // Keep successful partial rows, but do not report a failed dataset read as
      // a successful foreground sync merely because allSettled resolved.
      if (options.throwOnError && bundle.partialLoadError) {
        throw new Error("일부 채팅 데이터를 갱신하지 못했습니다.");
      }
    } catch (e) {
      if (!options.background && isCurrentAuthScope(requestScope) && isCurrentDatasetScope(requestScope, promiseRequested)) {
        // Keep any previously committed route data visible on refresh failures instead of dropping
        // lists/counts to an empty state. Initial loads with no prior data naturally remain null.
        setError(publicCallableErrorMessage(e, "데이터를 불러오지 못했습니다."));
      }
      if (options.throwOnError) throw e;
    } finally {
      liveInFlightRequests = liveInFlightRequests.filter((request) => request.requestKey !== nextRequestKey);
      if (!options.background && isCurrentAuthScope(requestScope)) setLoading(false);
      if (!options.background && isCurrentAuthScope(requestScope)) setStale(false);
      bumpLoadingKeys(fetchRequested, -1, requestScope);
    }
  }, [bumpLoadingKeys, commitBundle, identity, identityGeneration, isCurrentAuthScope, isCurrentDatasetScope, liveRole, noDataRoute]);

  const refresh = useCallback(async () => {
    if (noDataRoute || !authReady || !canRead) return;
    // 수동 새로고침은 언제나 네트워크로 간다: 진행 중이던 응답에 합류하면 사용자가 방금 만든
    // 변경(발송·검수 판정 등) 이전의 값을 다시 볼 수 있다. 등록 해제만 하고 새 호출을 낸다.
    invalidateCallableDedupe();
    if (snapshotFirstRoute) window.dispatchEvent(new Event("flu:operational-snapshot-refresh"));
    if (refreshKeys.length > 0) await load(refreshKeys, { force: true });
  }, [authReady, canRead, load, noDataRoute, refreshKeys, snapshotFirstRoute]);

  const loadKeys = useCallback(async (
    keys: readonly DatasetKey[],
    background = true,
    force = false,
    scope?: DatasetLoadScope,
  ) => {
    if (noDataRoute || !authReady || !canRead) return;
    const requestedKeys = uniqueDatasetKeys(keys);
    if (requestedKeys.length === 0) return;

    let scopeChanged = false;
    if (
      requestedKeys.includes("scpLifecycleProfiles")
      && scope
      && Object.prototype.hasOwnProperty.call(scope, "scpLifecycleProgramId")
    ) {
      const programId = scope.scpLifecycleProgramId?.trim() ?? "";
      const currentScope = scpLifecycleScopeRef.current;
      if (!currentScope.registered || currentScope.programId !== programId) {
        const revision = currentScope.revision + 1;
        const nextScope: ScpLifecycleDatasetScope = {
          programId,
          revision,
          registered: true,
          scopeKey: canonicalScopeIdentity("scp-lifecycle-v1", [programId, String(revision)]),
        };
        scpLifecycleScopeRef.current = nextScope;
        autoHydrateRunningRef.current.delete("scpLifecycleProfiles");
        setLoadingMore((prev) => {
          const next = { ...prev };
          delete next.scpLifecycleProfiles;
          return next;
        });
        setDataState((prev) => {
          if (!prev) return prev;
          const reset = resetScpLifecycleProfilePage(prev);
          if (liveMemoryCache) {
            liveMemoryCache = { ...liveMemoryCache, bundle: reset };
          }
          return reset;
        });
        scopeChanged = true;
      }
    }

    // Pages may call this context method before the provider's window-event
    // listener is attached. Treat the direct path as the same snapshot
    // handshake so later refreshes retain their scoped SWR keys.
    if (
      snapshotRouteKey
      && postSnapshotHydrationKeys.length > 0
      && postSnapshotHydrationKeys.every((key) => requestedKeys.includes(key))
    ) {
      setPostSnapshotHydratedRouteKey(snapshotRouteKey);
    }
    await load(requestedKeys, { background, force: force || scopeChanged });
  }, [authReady, canRead, load, noDataRoute, postSnapshotHydrationKeys, snapshotRouteKey]);

  // ViewAsProvider publishes its new target before the passive effect below
  // replaces this provider's bundle. Never render the previous target's rows
  // in that transition frame.
  const currentAuthState = latestAuthStateRef.current;
  const currentRole = currentAuthState && isReadableRole(currentAuthState.role) ? currentAuthState.role : null;
  const requestedViewAsScope = effectiveViewAsDatasetScope(
    currentRole,
    storedViewAsTarget
      ? { userId: storedViewAsTarget.userId, email: storedViewAsTarget.email }
      : SELF_VIEW_AS_DATASET_SCOPE,
  );
  const requestedIdentity = currentAuthState?.user && currentRole && CAN_READ.has(currentRole)
    ? canonicalLiveAuthScopeKey(
        currentAuthState.user.uid,
        currentAuthState.user.tenantId?.trim() || "tenant:none",
        currentRole,
        currentAuthState.team ?? "pending",
        currentAuthState.claimSyncReason ?? "missing-claim-sync-reason",
        authoritativeOrgScopeKey,
        requestedViewAsScope.userId,
        requestedViewAsScope.email,
      )
    : null;
  const currentScopeMatches = requestedIdentity !== null && identity === requestedIdentity;
  const visibleData = currentScopeMatches ? data : null;
  const perKeyLoaded = useCallback((key: DatasetKey) => (visibleData ? keyIsLoaded(visibleData, key) : false), [visibleData]);
  const perKeyError = useCallback((key: DatasetKey) => visibleData?.loadErrors?.[key], [visibleData]);

  const loadMore = useCallback(async (key: DatasetKey) => {
    if (noDataRoute || !authReady || !canRead || !identity || !data || !liveRole) return;
    const requestScope = makeLiveAuthScope(identity, identityGeneration, scpLifecycleScopeRef.current, effectiveViewAsDatasetScope(liveRole, activeViewAsScopeRef.current));
    if (!isCurrentAuthScope(requestScope)) return;
    if (!canReadDatasetKeyForRole(liveRole, key)) return;
    if (loadingMore[key]) return;
    const cursor = data.pageInfo?.[key]?.nextCursor;
    if (!cursor) return;
    setLoadingMore((prev) => ({ ...prev, [key]: true }));
    try {
      await load([key], {
        background: true,
        force: true,
        appendKeys: [key],
        cursors: { [key]: cursor },
      });
    } finally {
      if (isCurrentAuthScope(requestScope) && isCurrentDatasetScope(requestScope, [key])) {
        setLoadingMore((prev) => ({ ...prev, [key]: false }));
      }
    }
  }, [authReady, canRead, data, identity, identityGeneration, isCurrentAuthScope, isCurrentDatasetScope, liveRole, load, loadingMore, noDataRoute]);

  const loadRemainingPages = useCallback(async (key: DatasetKey, initialCursor: string | null | undefined): Promise<boolean> => {
    if (noDataRoute || !authReady || !canRead || !identity || !liveRole || !initialCursor) return false;
    const requestScope = makeLiveAuthScope(identity, identityGeneration, scpLifecycleScopeRef.current, effectiveViewAsDatasetScope(liveRole, activeViewAsScopeRef.current));
    if (!isCurrentAuthScope(requestScope)) return false;
    if (!canReadDatasetKeyForRole(liveRole, key)) return false;
    const loadPage = PAGED_LOADERS[key];
    if (!loadPage || autoHydrateRunningRef.current.has(key)) return false;

    const hydrationScopeIdentity = inFlightScopeIdentity(requestScope);
    autoHydrateRunningRef.current.set(key, hydrationScopeIdentity);
    setLoadingMore((prev) => ({ ...prev, [key]: true }));
    // W111: 종전엔 catch 가 없어서 페이지 하나가 던지면 예외가 `void loadRemainingPages(...)` 밖으로
    //   새어나가 unhandled rejection 이 됐다 — 화면엔 아무 신호도 없고 로그도 안 남았다. 그 결과
    //   "첫 페이지에서 멈췄는데 에러도 재시도도 없는" 상태가 됐다(프로드 실측: 사람 탭이 7,114명 중
    //   1,919명만 들고 있었다). 실패를 삼키되 **흔적을 남기고 false 로 알린다**.
    let drained = false;
    try {
      let cursor: string | null | undefined = initialCursor;
      while (cursor && isCurrentAuthScope(requestScope) && isCurrentDatasetScope(requestScope, [key])) {
        const limit = PAGE_LIMITS[key];
        const page: DatasetPageEnvelope = await loadDatasetPageDeduped(
          loadPage,
          key,
          {
            cursor,
            ...(limit ? { limit } : {}),
          },
          requestScope,
        );
        commitBundle(bundleFromPage(page), requestScope, [key]);
        cursor = page.pageInfo.nextCursor;
        if (!page.pageInfo.truncated || !cursor) break;
      }
      drained = true;
    } catch (error) {
      console.warn("[live] loadRemainingPages failed", JSON.stringify({
        key,
        message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      }));
    } finally {
      if (autoHydrateRunningRef.current.get(key) === hydrationScopeIdentity) {
        autoHydrateRunningRef.current.delete(key);
      }
      if (isCurrentAuthScope(requestScope) && isCurrentDatasetScope(requestScope, [key])) {
        setLoadingMore((prev) => ({ ...prev, [key]: false }));
      }
    }
    return drained;
  }, [authReady, canRead, commitBundle, identity, identityGeneration, isCurrentAuthScope, isCurrentDatasetScope, liveRole, noDataRoute]);

  const mutate = useCallback((fn: (prev: DatasetBundle) => DatasetBundle) => {
    if (!identity) return;
    const mutationScope = makeLiveAuthScope(identity, identityGeneration, scpLifecycleScopeRef.current, effectiveViewAsDatasetScope(liveRole, activeViewAsScopeRef.current));
    if (!isCurrentAuthScope(mutationScope)) return;
    setDataState((prev) => {
      if (!prev || !isCurrentAuthScope(mutationScope)) return prev;
      const next = fn(prev);
      // M1: 낙관적 갱신은 **신선도 근거가 아니다**. 종전엔 여기서 storedAt 을 지금으로 리셋해,
      //   잦은 mutate(/chat 5초 폴링 등)가 60초 창을 계속 밀어내며 재검증 자체를 굶겼다.
      //   기존 storedAt 을 보존하고, 캐시가 없던 상태에서 처음 만들어진 항목은 0(=즉시 만료)으로
      //   둔다 — 다음 로드가 서버 값으로 정합을 맞춘다.
      const identityKey = liveScopeCacheIdentity(mutationScope);
      const storedAt = liveMemoryCache && liveMemoryCache.identity === identityKey ? liveMemoryCache.storedAt : 0;
      liveMemoryCache = { identity: identityKey, bundle: next, storedAt };
      return next;
    });
  }, [identity, identityGeneration, isCurrentAuthScope]);

  const applyLiveAuthState = useCallback((state: AuthState, orgScopeKey: string, requestedViewAsScope = activeViewAsScopeRef.current) => {
    const nextLiveRole = isReadableRole(state.role) ? state.role : null;
    const nextCanRead = Boolean(state.user) && nextLiveRole !== null && CAN_READ.has(nextLiveRole);
    const identityTenant = state.user?.tenantId?.trim() || "tenant:none";
    const identityTeam = state.team ?? "pending";
    const identityClaimSyncReason = state.claimSyncReason ?? "missing-claim-sync-reason";
    const effectiveViewAsScope = effectiveViewAsDatasetScope(nextLiveRole, requestedViewAsScope);
    const nextIdentity = nextCanRead && state.user && nextLiveRole
      ? canonicalLiveAuthScopeKey(
          state.user.uid,
          identityTenant,
          nextLiveRole,
          identityTeam,
          identityClaimSyncReason,
          orgScopeKey,
          effectiveViewAsScope.userId,
          effectiveViewAsScope.email,
        )
      : null;
    setAuthReady(!state.loading);
    setCanRead(nextCanRead);
    setLiveRole(nextLiveRole);
    if (identityRef.current !== nextIdentity) {
      const nextGeneration = ++liveAuthGenerationSequence;
      identityRef.current = nextIdentity;
      identityGenerationRef.current = nextGeneration;
      setIdentityGeneration(nextGeneration);
      setDataState(nextCanRead && nextIdentity
        ? readMemoryBundle(liveScopeCacheIdentity(makeLiveAuthScope(nextIdentity, nextGeneration, UNREGISTERED_SCP_LIFECYCLE_DATASET_SCOPE, effectiveViewAsScope)), datasetKeysForRole(routeKeysRef.current, nextLiveRole), true)
        : null);
      setError(null);
      setLoading(false);
      setLoadingMore({});
      loadingKeyCountsRef.current = {};
      setLoadingKeys({});
      autoHydrateRunningRef.current.clear();
      liveInFlightRequests = [];
      // 인증·조직 스코프가 바뀌면 이전 사용자의 진행 중 호출에 합류할 수 없어야 한다.
      invalidateCallableDedupe();
      setStale(false);
    }
    setIdentity(nextIdentity);
    if (!state.loading && !nextCanRead) {
      setDataState(null);
      setError(null);
      setLoading(false);
      setLoadingMore({});
      loadingKeyCountsRef.current = {};
      setLoadingKeys({});
      autoHydrateRunningRef.current.clear();
      liveInFlightRequests = [];
      invalidateCallableDedupe();
      setStale(false);
    }
  }, []);

  useEffect(() => subscribeAuthState((state) => {
    latestAuthStateRef.current = state;
    applyLiveAuthState(state, authoritativeOrgScopeKeyRef.current, activeViewAsScopeRef.current);
  }), [applyLiveAuthState]);

  useEffect(() => {
    authoritativeOrgScopeKeyRef.current = authoritativeOrgScopeKey;
    if (latestAuthStateRef.current) applyLiveAuthState(latestAuthStateRef.current, authoritativeOrgScopeKey, activeViewAsScopeRef.current);
  }, [applyLiveAuthState, authoritativeOrgScopeKey]);

  useEffect(() => {
    const requestedViewAsScope = storedViewAsTarget
      ? { userId: storedViewAsTarget.userId, email: storedViewAsTarget.email }
      : SELF_VIEW_AS_DATASET_SCOPE;
    const current = activeViewAsScopeRef.current;
    if (current.userId === requestedViewAsScope.userId && current.email === requestedViewAsScope.email) return;
    activeViewAsScopeRef.current = requestedViewAsScope;
    if (latestAuthStateRef.current) {
      applyLiveAuthState(latestAuthStateRef.current, authoritativeOrgScopeKeyRef.current, requestedViewAsScope);
    }
  }, [applyLiveAuthState, storedViewAsTarget]);

  useEffect(() => {
    if (noDataRoute || !authReady || !canRead || !identity) {
      foregroundRouteLoadRef.current = Promise.resolve();
      return;
    }
    const routeLoad = load(readableRouteKeys);
    foregroundRouteLoadRef.current = routeLoad;
    void routeLoad;
  }, [authReady, canRead, identity, load, noDataRoute, readableRouteKeys]);

  // R7 P10: 알림 배지 데이터(reviews/conversations)는 라우트 loading과 분리된 백그라운드 부트스트랩으로 채운다 —
  // Sidebar/Topbar 배지는 유지하되, 이 키를 필요로 하지 않는 라우트의 초기 로딩을 더 이상 블로킹하지 않는다.
  useEffect(() => {
    if (noDataRoute || !authReady || !canRead || !identity || notificationKeys.length === 0) return undefined;
    // 알림 배지(reviews/conversations)는 사용자가 연 화면이 아니라 배경 부트스트랩이다 — 60초
    // 캐시를 그대로 쓴다(prefetch).
    const bootstrapNotifications = () => void load(notificationKeys, { background: true, prefetch: true });
    if (deferNotificationBootstrap) {
      let cancelled = false;
      const cancelIdleTask = scheduleIdleTask(() => {
        void foregroundRouteLoadRef.current.then(() => {
          if (!cancelled) bootstrapNotifications();
        });
      });
      return () => {
        cancelled = true;
        cancelIdleTask();
      };
    }
    bootstrapNotifications();
    return undefined;
  }, [authReady, canRead, deferNotificationBootstrap, identity, load, noDataRoute, notificationKeys]);

  useEffect(() => {
    if (noDataRoute || !authReady || !canRead || !identity || !liveRole || !data) return;
    for (const key of autoHydratePageKeysForPath(pathname)) {
      if (!canReadDatasetKeyForRole(liveRole, key)) continue;
      const cursor = data.pageInfo?.[key]?.nextCursor;
      if (cursor) void loadRemainingPages(key, cursor);
    }
  }, [authReady, canRead, data, identity, liveRole, loadRemainingPages, noDataRoute, pathname]);

  useEffect(() => {
    if (noDataRoute || !authReady || !canRead || !identity || !liveRole) return undefined;
    const groups = prefetchGroupsForPath(pathname)
      .map((group) => datasetKeysForRole(uniqueDatasetKeys(group), liveRole))
      .filter((group) => group.length > 0);
    let cancelled = false;
    let cancelIdleTask = () => {};

    const runGroup = (index: number) => {
      if (cancelled || index >= groups.length) return;
      cancelIdleTask = scheduleIdleTask(() => {
        const foregroundSettled = pathname.startsWith("/flu/review")
          ? foregroundRouteLoadRef.current
          : Promise.resolve();
        void foregroundSettled.then(() => {
          if (cancelled) return;
          void load(groups[index], { background: true, prefetch: true }).finally(() => {
            if (!cancelled) runGroup(index + 1);
          });
        });
      });
    };

    runGroup(0);
    return () => {
      cancelled = true;
      cancelIdleTask();
    };
  }, [authReady, canRead, identity, liveRole, load, noDataRoute, pathname]);

  // Chat is refreshed by explicit app events and visibility recovery below. A fixed foreground
  // timer would repeatedly reread large conversation pages while the operator is idle.
  useEffect(() => {
    const enabled = pathname.startsWith("/chat")
      && !noDataRoute
      && authReady
      && canRead
      && Boolean(identity)
      && Boolean(liveRole)
      && refreshKeys.length > 0;

    setChatForegroundSync((prev) => ({
      ...prev,
      enabled,
      inFlight: enabled ? prev.inFlight : false,
      intervalMs: 0,
      error: enabled ? prev.error : null,
    }));

    if (!enabled) {
      chatRefreshInFlightRef.current = false;
    }
    return () => {
      chatRefreshRunRef.current += 1;
      chatRefreshInFlightRef.current = false;
      setChatForegroundSync((prev) => ({ ...prev, inFlight: false }));
    };
  }, [authReady, canRead, identity, liveRole, noDataRoute, pathname, refreshKeys]);

  useEffect(() => {
    function trackChatRefresh(pendingRead: Promise<void>) {
      if (!pathname.startsWith("/chat") || chatRefreshInFlightRef.current) return;
      chatRefreshInFlightRef.current = true;
      const runId = chatRefreshRunRef.current + 1;
      chatRefreshRunRef.current = runId;
      const startedAtIso = new Date().toISOString();
      setChatForegroundSync((prev) => ({
        ...prev,
        enabled: true,
        inFlight: true,
        intervalMs: 0,
        lastStartedAtIso: startedAtIso,
        error: null,
      }));
      void pendingRead
        .then(() => {
          if (chatRefreshRunRef.current !== runId) return;
          const finishedAtIso = new Date().toISOString();
          setChatForegroundSync((prev) => ({
            ...prev,
            enabled: true,
            inFlight: false,
            intervalMs: 0,
            lastFinishedAtIso: finishedAtIso,
            error: null,
          }));
          window.dispatchEvent(new CustomEvent("chat:foreground-sync", { detail: { status: "success", finishedAtIso } }));
        })
        .catch((error) => {
          if (chatRefreshRunRef.current !== runId) return;
          const finishedAtIso = new Date().toISOString();
          const message = publicCallableErrorMessage(error, "채팅 갱신에 실패했습니다.");
          setChatForegroundSync((prev) => ({
            ...prev,
            enabled: true,
            inFlight: false,
            intervalMs: 0,
            lastFinishedAtIso: finishedAtIso,
            error: message,
          }));
          window.dispatchEvent(new CustomEvent("chat:foreground-sync", { detail: { status: "error", finishedAtIso, message } }));
        })
        .finally(() => {
          if (chatRefreshRunRef.current === runId) chatRefreshInFlightRef.current = false;
        });
    }

    function onRefresh() {
      // W114 (헤세 실측): 이전엔 { force: true }만 줘서 mergeDatasetBundle이 conversations를
      //   **교체**로 커밋했다 — 명시적 새로고침을 누를 때마다 드레인해둔 뒷 페이지가 통째로
      //   날아가 페이지 1로 되돌아갔고, 그래서 숫자가 매번 처음부터 다시 올라가는 재드레인
      //   비용이 발생했다(W111이 고친 visibilitychange 경로의 나머지 절반, 아래 onVisible 참고).
      //   병합은 id 기준(mergeRows)이고 페이지네이션은 최신순(functions/read.ts lastMessageAtIso desc)
      //   이라 새 대화는 그대로 1페이지로 들어와 병합해도 정상 반영된다. **교체가 필요한 이유**
      //   (다른 운영자가 보관·삭제한 대화의 재검증)는 사라지지 않았다 — 그 탈출구는
      //   STALE_REPLACE_AFTER_HIDDEN_MS 경로(아래 onVisible)에 그대로 남아 있다.
      // refresh()와 같은 이유로 진행 중 응답 합류를 끊는다 — 명시적 새로고침은 항상 새 네트워크 호출.
      invalidateCallableDedupe();
      if (authReady && canRead && refreshKeys.length > 0) {
        const pendingRead = load(refreshKeys, { force: true, appendKeys: ["conversations"], throwOnError: pathname.startsWith("/chat") });
        trackChatRefresh(pendingRead);
        void pendingRead;
      }
    }
    function onVisible() {
      if (authReady && canRead && refreshKeys.length > 0 && document.visibilityState === "visible") {
        // W111 리뷰(HIGH): 병합만 하면 **첫 페이지 밖으로 밀려난 행이 영영 재검증되지 않는다** —
        //   다른 탭/운영자가 보관·삭제한 대화가 이 탭에선 계속 살아 있는 것처럼 남는다.
        //   오래 자리를 비웠다 돌아온 경우엔 교체로 정합을 회복한다(그때만 목록이 잠깐 줄었다
        //   드레인으로 다시 찬다 — 탭 전환마다 겪던 churn 과 달리 드물게만 일어난다).
        //   W114: 명시적 새로고침(onRefresh, 위)도 이제 병합이라 이 경로가 유일한 교체 탈출구다.
        const hiddenFor = hiddenSinceMsRef.current > 0 ? Date.now() - hiddenSinceMsRef.current : 0;
        hiddenSinceMsRef.current = 0;
        if (hiddenFor >= STALE_REPLACE_AFTER_HIDDEN_MS) {
          const pendingRead = load(refreshKeys, { background: true, throwOnError: pathname.startsWith("/chat") });
          trackChatRefresh(pendingRead);
          void pendingRead;
          return;
        }
        // W111 (헤세: "가만히 두면 260 → 86 으로 줄었다 다시 오른다"): 배경 갱신은 첫 페이지만
        //   다시 받아오는데, 그걸 **교체**로 커밋하면 드레인으로 채워둔 뒷 페이지가 통째로 날아간다
        //   (사람 수가 첫 페이지분으로 급감했다가 재드레인으로 다시 차오르는 churn 의 원인).
        //   id 기준 병합(mergeRows)으로 커밋하면 최신 행은 갱신되고 이미 받은 행은 살아남는다.
        //   W114: 명시적 새로고침(flu:data-refresh, force, 위 onRefresh)도 같은 이유로 이제 병합이다
        //   — force는 여기선 "네트워크 재요청을 강제한다"는 뜻일 뿐 커밋 방식과는 별개다.
        const pendingRead = load(refreshKeys, { background: true, appendKeys: ["conversations"], throwOnError: pathname.startsWith("/chat") });
        trackChatRefresh(pendingRead);
        void pendingRead;
      }
    }
    function onHidden() {
      if (document.visibilityState === "hidden") hiddenSinceMsRef.current = Date.now();
    }
    window.addEventListener("flu:data-refresh", onRefresh);
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("flu:data-refresh", onRefresh);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [authReady, canRead, load, pathname, refreshKeys]);

  useEffect(() => {
    function onDataKeysRefresh(event: Event) {
      if (noDataRoute || !authReady || !canRead) return;
      const detail = (event as DataKeysRefreshEvent).detail;
      const keys = Array.isArray(detail?.keys) ? detail.keys : [];
      if (keys.length === 0) return;
      if (
        snapshotRouteKey
        && postSnapshotHydrationKeys.length > 0
        && postSnapshotHydrationKeys.every((key) => keys.includes(key))
      ) {
        setPostSnapshotHydratedRouteKey(snapshotRouteKey);
      }
      void loadKeys(keys, detail?.background !== false);
    }
    window.addEventListener("flu:data-load-keys", onDataKeysRefresh);
    return () => window.removeEventListener("flu:data-load-keys", onDataKeysRefresh);
  }, [authReady, canRead, loadKeys, noDataRoute, postSnapshotHydrationKeys, snapshotRouteKey]);

  return (
    <LiveCtx.Provider value={{ data: visibleData, loading, stale, loadingMore, loadingKeys, error, chatForegroundSync, seeded: visibleData?.seeded ?? false, authReady, canRead, authScopeKey: currentScopeMatches ? identity : null, authScopeGeneration: identityGeneration, role: liveRole, refresh, loadKeys, loadMore, loadRemainingPages, mutate, perKeyLoaded, perKeyError }}>
      {children}
    </LiveCtx.Provider>
  );
}

export const useLive = () => useContext(LiveCtx);

export function requestDataRefresh() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("flu:data-refresh"));
  }
}

export function requestDataKeys(keys: readonly DatasetKey[], background = true) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("flu:data-load-keys", { detail: { keys: uniqueDatasetKeys(keys), background } }));
  }
}

export function useOptimisticClear() {
  const { mutate } = useLive();
  return useCallback(() => {
    mutate((prev) => {
      const cleared = { ...prev } as Record<string, unknown>;
      for (const k of Object.keys(cleared)) {
        if (Array.isArray(cleared[k])) cleared[k] = [];
        else if (k === "channelStats") cleared[k] = {};
      }
      cleared.seeded = false;
      return cleared as unknown as DatasetBundle;
    });
  }, [mutate]);
}

export function useLiveCollection<T>(
  key: DatasetKey,
  select: (d: DatasetBundle) => unknown[] | undefined,
  _fallback: T[],
): T[] {
  const { data, authReady, canRead } = useLive();
  // Production callers historically passed demo fixtures here. Returning those while a
  // key was pending or failed made named mocks look like real Firestore records. Live data
  // is now fail-closed; loading/error/empty states are rendered by the owning screen.
  if (!authReady) return [];
  if (!canRead) return [];
  if (!data || !keyIsLoaded(data, key)) return [];
  const live = select(data);
  return Array.isArray(live) ? (live as unknown as T[]) : [];
}

export function useLiveRecord<T>(
  key: DatasetKey,
  select: (d: DatasetBundle) => Record<string, unknown> | undefined,
  _fallback: Record<string, T>,
): Record<string, T> {
  const { data, authReady, canRead } = useLive();
  if (!authReady) return {};
  if (!canRead) return {};
  if (!data || !keyIsLoaded(data, key)) return {};
  const live = select(data);
  return live ? (live as unknown as Record<string, T>) : {};
}

export const useLiveCreators = <T,>(fallback: T[]) => useLiveCollection<T>("creators", (d) => d.creators, fallback);
export const useLiveChannelStats = <T,>(fallback: Record<string, T>) => useLiveRecord<T>("channelStats", (d) => d.channelStats, fallback);
export const useLiveAgencies = <T,>(fallback: T[]) => useLiveCollection<T>("agencies", (d) => d.agencies, fallback);
export const useLiveCampaigns = <T,>(fallback: T[]) => useLiveCollection<T>("campaigns", (d) => d.campaigns, fallback);
export const useLivePrograms = <T,>(fallback: T[]) => useLiveCollection<T>("programs", (d) => d.programs, fallback);
export const useLiveProgramApplications = <T,>(fallback: T[]) => useLiveCollection<T>("programApplications", (d) => d.programApplications, fallback);
export const useLiveProgramSheetLeads = <T,>(fallback: T[]) => useLiveCollection<T>("programSheetLeads", (d) => d.programSheetLeads, fallback);
export const useLiveScpQualificationRows = <T,>(fallback: T[]) => useLiveCollection<T>("scpQualificationRows", (d) => d.scpQualificationRows, fallback);
export const useLiveCreatorLinks = <T,>(fallback: T[]) => useLiveCollection<T>("creatorLinks", (d) => d.creatorLinks, fallback);
export const useLiveScpMailTemplates = <T,>(fallback: T[]) => useLiveCollection<T>("scpMailTemplates", (d) => d.scpMailTemplates, fallback);
export const useLiveScpMailResults = <T,>(fallback: T[]) => useLiveCollection<T>("scpMailResults", (d) => d.scpMailResults, fallback);
export const useLiveSubmissionTasks = <T,>(fallback: T[]) => useLiveCollection<T>("submissionTasks", (d) => d.submissionTasks, fallback);
export const useLiveContracts = <T,>(fallback: T[]) => useLiveCollection<T>("contracts", (d) => d.contracts, fallback);
export const useLiveReviews = <T,>(fallback: T[]) => useLiveCollection<T>("reviews", (d) => d.reviews, fallback);
export const useLiveEscalations = <T,>(fallback: T[]) => useLiveCollection<T>("escalations", (d) => d.escalations, fallback);
export const useLiveSubmissions = <T,>(fallback: T[]) => useLiveCollection<T>("submissions", (d) => d.submissions, fallback);
export function useLiveScpLifecycleProfiles<T>(fallback: T[], programId = ""): T[] {
  const { loadKeys } = useLive();
  useEffect(() => {
    // COST-P0-011 대응: 예전엔 force=true 였다. `loadKeys` 는 provider 의 useCallback 이라 인증
    //   상태가 정착하는 동안(authReady/canRead/identity/liveRole 변화) 신원이 여러 번 바뀌고, 그때마다
    //   이 effect 가 다시 돌며 **60초 신선 캐시도 in-flight 병합도 전부 우회한 채** 7.6MB짜리
    //   listScpLifecycleProfiles 를 새로 당겼다(프로드 실측: 1회 로드에 3회 호출 / 9.6MB).
    //   이제 강제는 loadKeys 내부의 **스코프 변경 판정**에만 맡긴다 — 첫 마운트(스코프 미등록)와
    //   프로그램 필터 변경은 여전히 force 로 재조회되고(정합 계약 유지), 같은 스코프의 단순
    //   재실행은 캐시/진행 중 요청으로 수렴한다.
    void loadKeys(
      ["scpLifecycleProfiles"],
      true,
      false,
      { scpLifecycleProgramId: programId },
    );
  }, [loadKeys, programId]);
  return useLiveCollection<T>("scpLifecycleProfiles", (d) => d.scpLifecycleProfiles, fallback);
}
export const useLiveVideos = <T,>(fallback: T[]) => useLiveCollection<T>("videos", (d) => d.videos, fallback);
export const useLiveCandidatePool = <T,>(fallback: T[]) => useLiveCollection<T>("candidatePool", (d) => d.candidatePool, fallback);
export const useLiveMembers = <T,>(fallback: T[]) => useLiveCollection<T>("members", (d) => d.members, fallback);
export const useLiveLlmUsage = <T,>(fallback: T[]) => useLiveCollection<T>("llmUsage", (d) => d.llmUsage, fallback);
export const useLiveCommunityPosts = <T,>(fallback: T[]) => useLiveCollection<T>("communityPosts", (d) => d.communityPosts, fallback);
export const useLiveFeedDiscoveryState = <T,>(fallback: T[]) => useLiveCollection<T>("feedDiscoveryState", (d) => d.feedDiscoveryState, fallback);
export const useLiveTemplates = <T,>(fallback: T[]) => useLiveCollection<T>("templates", (d) => d.templates, fallback);
export const useLiveConversations = <T,>(fallback: T[]) => useLiveCollection<T>("conversations", (d) => d.conversations, fallback);
export const useLiveAutoReply = <T,>(fallback: T[]) => useLiveCollection<T>("autoReply", (d) => d.autoReply, fallback);
export const useLiveFeedback = <T,>(fallback: T[]) => useLiveCollection<T>("feedback", (d) => d.feedback, fallback);
export const useLiveKnowledgeNodes = <T,>(fallback: T[]) => useLiveCollection<T>("knowledgeNodes", (d) => d.knowledgeNodes, fallback);
export const useLiveKnowledgeEdges = <T,>(fallback: T[]) => useLiveCollection<T>("knowledgeEdges", (d) => d.knowledgeEdges, fallback);
export const useLiveBehaviorLogs = <T,>(fallback: T[]) => useLiveCollection<T>("behaviorLogs", (d) => d.behaviorLogs, fallback);
export const useLiveCostLogs = <T,>(fallback: T[]) => useLiveCollection<T>("costLogs", (d) => d.costLogs, fallback);
export const useLiveRawRecords = <T,>(fallback: T[]) => useLiveCollection<T>("rawRecords", (d) => d.rawRecords, fallback);
export const useLiveRecCandidates = <T,>(fallback: T[]) => useLiveCollection<T>("recCandidates", (d) => d.recCandidates, fallback);
export const useLiveCreatorComments = <T,>(fallback: T[]) => useLiveCollection<T>("creatorComments", (d) => d.creatorComments, fallback);
