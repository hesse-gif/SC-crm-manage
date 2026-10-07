// Flu Cloud Functions — external calls, model usage, and DB writes route through callable-style handlers.
// Blaze-ready: no external egress, no client writes, no raw prompt/response exposure.
import { adminAuth, adminDb } from "./firebaseAdmin";
import { FieldPath, FieldValue, type DocumentReference, type DocumentSnapshot, type Query, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import type { UserRecord } from "firebase-admin/auth";
import {
  PeoplyClientError,
  isPeoplyEmployeeActive,
  type PeoplyPersonDetail,
} from "./peoplyClient";
import { getCachedOrLivePeoplyPerson } from "./peoplyDirectoryCache";
import { MVP_HESSE_PERSISTENT_DOCS, MVP_HESSE_PROTECTED_DOC_KEYS, SEED_COLLECTIONS, SEED_MANIFEST } from "./seedData";
import { isOperationalFixtureRecord } from "./operationalFixtureProvenance";
import { sourceRef as makeSourceRef, writeKnowledgeNode } from "./knowledgeGraph";
import { evaluateMailProfileSafety, renderMailTemplate, resolveMailProfile, type MailProfileResolution, type MailProfileSafetyDecision } from "./mailProfiles";
import { findMailSuppression, mailSuppressionBlocksSend, type MailSuppressionHit, type MailSuppressionLookup } from "./mailSuppression";
import { readCachedMailDeliverabilityStatuses, type MailDeliverabilityStatus } from "./mailDeliverabilityVerification";
import { evaluateMailSafety } from "./mailSafetyPolicy";
import { expireAt180DaysFromIso } from "./firestoreTtl";
import {
  readOutreachSendingEnabled,
  setOutreachSendingEnabled,
  readNudgeSendingEnabled,
  setNudgeSendingEnabled,
  koreaDayKeyFrom,
  OUTBOUND_SAFETY_STATE_PATH,
  OUTBOUND_GLOBAL_DAILY_TOTAL_CAP,
} from "./mailOutboundSafety";
import { readMailAdminStatus, type MailLaneFlags } from "./mailAdminStatus";
import { safeOutboundFailureEvidence } from "./mailSafetyShared";
import { coldmailHistoryDocId, normalizePublicYouTubeChannelUrl } from "./scpColdmailHistory";
// R30 [사용자 승인 · LLM 키워드 발굴]: 코퍼스 원장(순수)과 제안기(게이트 전담). 모델 호출은
// 아래 vertex.callModel(기존 게이트웨이 chokepoint)만 쓴다 — 새 HTTP 클라이언트 없음(SEC-P0-005).
import {
  KEYWORD_EXPANSION_LLM_CACHE_TTL_SECONDS,
  KEYWORD_EXPANSION_LLM_DAILY_CALL_CAP,
  KEYWORD_EXPANSION_LLM_ROUTE,
  suggestKeywordsViaLlm,
} from "./keywordLlmExpansion";
import {
  keywordCorpusActiveTerms,
  keywordCorpusPerformanceHints,
  readKeywordCorpus,
  recentlyRetiredTerms,
  // W90: 수율 퇴역 · 크리틱 사유 원장.
  keywordCorpusEmailDeadTerms,
  keywordCorpusRows,
  applyKeywordCorpusPassUpdates,
} from "./keywordCorpus";
import { callModel, selectVertexModelForTask } from "./vertex";
import {
  LLM_USAGE_SCHEMA_VERSION,
  llmUsageAggregationIdentity,
  llmUsageDocumentId,
  newSessionId,
  reportLlmUsage,
  type LlmUsageTransport,
} from "./aiHubReport";
import { createHash, randomBytes } from "node:crypto";
import {
  DEFAULT_PROGRAM_ID,
  campaignAllowsResendInProgram,
  creatorSentInProgramScope,
  programDedupDocId,
  resolveCreatorDedupKeys,
  resolveOutreachDedupContext,
  resolveOutreachDedupScope,
} from "./programOutreachDedup";
import { triggerScopedCampaignDiscovery, readCampaignAutoDiscoveryResultCap, resolveProgramDiscoveryCriteria, resolveOwnedCriteriaKeywords, queueScheduledCampaignYtDlpDiscovery, youtubeApiKeyCount, keywordExpansionCacheKey, keywordExpansionCacheLookup, keywordExpansionCacheStore } from "./discovery";
import type { DiscoverySliceArmSlots, DiscoverySliceType } from "./discovery";
import { YOUTUBE_GROWTH_POOL_ID, youtubeDiscoveryQuotaBudget } from "./apiQuota";
// Flu/W2 (Codex 적대 리뷰 HIGH-2 수리): shortfall 잡 admission 게이트(youtubeApiKeyCount/
// youtubeDiscoveryQuotaBudget)는 growth 전용 유닛 원장만 본다 — T049 처럼 drama_1 로 라우팅되는
// 캠페인에서 그대로 쓰면 growth 소진이 T049 잡을 부당 차단하거나, growth 잔여를 기준으로 T049
// 잡 크기를 정하게 된다. 아래에서 이 org 가 growth 가 아닌 풀에 매핑됐는지만 판정한다.
import { resolvePoolIdForOrg } from "./youtubeQuotaPools";
// W115 C2·C3·10k: 발굴 경제학 규칙의 정본(의존 없는 리프). discovery.ts 와 **같은 함수**를 쓴다 —
//   배분/쿨다운 규칙을 양쪽에 복제하면 반드시 갈라진다(W112 F-A 가 상한에서 겪은 바로 그 사고).
import {
  applyArmCooldownToSlots,
  applyArmYieldLedgerUpdate,
  costNormalizedArmWeights,
  DISCOVERY_ARM_COOLDOWN_MS,
  DISCOVERY_LOW_COST_LANE_UNIT_RESERVE,
  DISCOVERY_ARM_DEAD_STREAK_THRESHOLD,
  DISCOVERY_MIN_ARM_EXPLORATION_SHARE,
  DISCOVERY_SEARCH_LANES,
  INVENTORY_FLOOR_ENQUEUE_LIMIT_PER_PASS,
  INVENTORY_FLOOR_SCAN_LIMIT,
  inventoryFloorPerCampaignFloor,
  passLocalAvailableUnits,
  planInventoryFloorQueue,
  planLaneBudget,
  YOUTUBE_SEARCH_UNITS_PER_CALL,
  type ArmYieldLedger,
  type ArmYieldLedgerEntry,
} from "./discoveryEconomics";
import { YTDLP_UNSENT_INVENTORY_TARGET } from "./ytdlpInventoryCounter";
import { isScpOutreachLandingLinkConfigured, mintScpOutreachLandingLink } from "./scpOutreachLandingLink";
import { PORTAL_PROGRAM_ID } from "./scpPortalApplyBindingAuthority";
import { resolveCanonicalProgramId, SCP_CANONICAL_PROGRAM_ID } from "./programCanonical";
import { confirmedProgramScope, readConfirmedProgramAliasRegistryState } from "./programAliasRegistry";
import {
  buildProgramScopedCandidateParticipationWrites,
  campaignCandidateRefFor,
  candidateIdFromCandidate,
  globalCandidateIdentityData,
} from "./candidateScope";
import {
  makeSettingsAuditRecord,
  readSettings,
  SETTINGS_AUDIT_COLLECTION,
  settingsActorUidHash,
  settingsRevisionFromRecord,
} from "./settings";
import { envEmail } from "./opsDefaults";
import { compileOutboundMailArtifact } from "./mailSignature";
import { compileMailArtifact, compiledArtifactFingerprint, mailArtifactFromSnapshot, resolveMailSubject, sanitizeMailHtml } from "./mailCompiler";
import { mailAssetManifest, mailAssetPreviewContents } from "./mailAssets";
import { upsertMailAssets } from "./mailAssetRegistry";
import { rowMatchesAccountScope } from "./readScope";
import type { AuthContext } from "./shared";
import { CANONICAL_OPERATIONAL_MAILBOX_V1 } from "./mailIdentity";
import { enqueueScpLifecycleRefreshEvent } from "./scpLifecycleProfiles";
import { assertDemoSeedCreationAllowed } from "./runtimeEnvironment";
import {
  campaignApprovalAuditRef,
  campaignCommittedFloorInTransaction,
  campaignControlActor,
  campaignControlActorHash,
  readAuthorizedCampaignControlInTransaction,
} from "./campaignControl";
import {
  campaignApprovalSelectionFingerprint,
  evaluateProgramCampaignCandidateEligibility,
  gameCategoryEquivalenceKey,
  parseCampaignOutreachApprovalInput,
  resolveCampaignOperationalState,
  resolveCampaignApprovalAtomicAction,
  isCancelledCampaignStatus,
  type ProgramCampaignCandidateEligibility,
  campaignApprovalEffectiveCap,
} from "./campaignControlCore";
import { assertMutationOwner, mutationOwnerUids } from "./mutationAuthorization";
import { accountOwnershipStampForOwnedRecordAsync, accountOwnershipStampForScope, assertWritableAccountOwnershipScope, resolveAccountOwnershipScopeForRequest } from "./accountOwnership";
import {
  countryTargetingFromLegacy,
  youtubeCreatorCountryPolicyDecision,
  DEFAULT_YOUTUBE_CREATOR_COUNTRIES,
  type CountryTargeting,
  type YoutubeCreatorCountryPolicyDecision,
} from "./youtubeCreatorCountries";

type Role = "super_admin" | "admin" | "manager" | "viewer" | "guest";
type Result = "success" | "denied" | "error";
type Tier = "빠른" | "품질";
type CampaignTargetMetric = "partners" | "sent" | "replied" | "negotiating" | "contracted" | "live";

type CallableRequest = {
  auth?: { uid?: string; token?: { role?: Role; team?: string; email?: string; name?: string; picture?: string } };
  data?: unknown;
  rawRequest?: { ip?: string };
};

type BehaviorLog = {
  userId: string;
  role: Role;
  team: string;
  gameId: string;
  action: string;
  time: string;
  IP: string;
  result: Result;
  cost: number;
};

type LlmUsage = {
  model: string;
  tier: Tier;
  provider?: string;
  transport?: LlmUsageTransport;
  aggregationIdentity?: string;
  calls: number;
  tokensK: number;
  costKRW: number;
  share: number;
};

export type CampaignTarget = {
  id: string;
  name: string;
  source: "managed" | "discovered" | "program";
  creatorId?: string;
  candidateId?: string;
  email?: string;
  handle?: string;
  youtubeUrl?: string;
  avatar?: string;
  platform?: string;
  followers?: number;
  region?: string;
  category?: string;
  /**
   * T3: 발굴 시 산출된 품질 점수(카테고리 45% + 팔로워핏 30% + 비즈메일 15% + 최근성 10%,
   * `discovery.ts scoreCandidate`). 예전에는 소비 경로가 이 값을 **한 번도 참조하지 않아**
   * "잘 맞는 후보"가 아니라 "최근 갱신된 후보"부터 나갔다. 순서에만 쓰고 필터에는 쓰지 않는다.
   */
  matchScore?: number;
  publicDescription?: string;
  matchedSearchTerms?: string[];
  programTargetId?: string;
  sourceRef?: string;
  candidateRef?: string;
  campaignCandidateRef?: string;
  sourceRunId?: string;
  sourceRunRef?: string;
  discoverySource?: string;
  discoveryArm?: DiscoverySliceType;
  persistOutcome?: "created" | "merged" | "rejected";
  sourceFetchedAt?: string;
  discoveryProvenance?: Record<string, unknown>;
  canonicalProgramId?: string;
  campaignId?: string;
  sourceCampaignId?: string;
  programScopeEvidence?: ProgramCampaignCandidateEligibility;
  /**
   * P0-1 [XP→Snake 후보 이주 · 2026-09-26]: true 면 이 특정 후보가 명시적 이주
   * (campaignCandidateMigration.ts bypassKeywordGate)로 키워드/카테고리 게이트를 건너뛰고
   * 통과했다는 뜻이다. campaign_candidates/program_campaign_targets 문서의
   * `programScopeEvidence.keywordGateBypassed` 를 그대로 승계한다(campaignTargetFromCampaignCandidateDoc·
   * campaignTargetFromProgramTargetDoc). 라이브 리필의 두 독립 키워드 게이트
   * (evaluateProgramCampaignCandidateEligibility·targetMatchesCampaignIncludes) 가 이 필드가 있는
   * 후보에 한해서만 재거부를 건너뛴다 — 캠페인의 유기적 키워드 타게팅 자체는 무변경이다.
   */
  keywordGateBypassed?: boolean;
  country?: string | null;
  countryDecision?: YoutubeCreatorCountryPolicyDecision;
};

type CountryAllocation = {
  country: string;
  weight: number;
};

const ROLES: Record<Role, { rank: number }> = {
  super_admin: { rank: 5 },
  admin: { rank: 4 },
  manager: { rank: 3 },
  viewer: { rank: 2 },
  guest: { rank: 1 },
};
const ADMIN_ROLES = new Set<Role>(["super_admin", "admin"]);
const MANAGER_ROLES = new Set<Role>(["super_admin", "admin", "manager"]);
const VALID_RESULTS = new Set<Result>(["success", "denied", "error"]);
const PRIVILEGED_ROLES = new Set<Role>(["super_admin", "admin"]);
const VALID_TIERS = new Set<Tier>(["빠른", "품질"]);
const VALID_TEMPLATE_STAGES = new Set(["contact", "negotiation", "contract", "review", "thanks"]);
const VALID_TEMPLATE_CHANNELS = new Set(["이메일", "DM"]);
const VALID_CAMPAIGN_TARGET_METRICS = new Set<CampaignTargetMetric>(["partners", "sent", "replied", "negotiating", "contracted", "live"]);
const EMAIL_SETTINGS_DOC = "settings/email";
const CAMPAIGN_OUTREACH_QUEUE_LIMIT = 5_000;
const CAMPAIGN_TARGET_SCAN_LIMIT = 10_000;
const PROGRAM_CAMPAIGN_TARGETS_COLLECTION = "program_campaign_targets";
const CAMPAIGN_CANDIDATES_COLLECTION = "campaign_candidates";
/**
 * NEXT-1 [소비 표시 필터] — `campaign_candidates` 스캔이 **아직 안 쓴 후보만** 읽게 하는 술어 값.
 *
 * 이 값이 성립하는 이유는 두 writer 가 같은 어휘를 쓰기 때문이다(문자열 리터럴이 세 파일에 흩어져
 * 있으므로 드리프트는 tests/campaign-candidate-stage-filter.test.mjs 가 잠근다):
 *   · 생성:  candidateScope.ts buildProgramScopedCandidateParticipationWrites — 기본 `"discovered"`
 *   · 소비:  programOutreachDedup.ts recordProgramOutreachSend — 발송 시 `"contacted"` 로 전이(122차)
 *
 * 122차 배포 전까지 이 필드는 **레포 전체에 소비자가 0명**이었다(전량 `"discovered"` 로 고정).
 * 그래서 이 필터는 122차의 전이 배선 + 일회성 백필(scripts/backfill-candidate-contacted-stage.mjs)과
 * **함께**여야 의미가 있다: 백필 없이 필터만 걸면 이미 발송된 8,515건이 계속 신선으로 잡혀
 * 효과가 32% 로 깎인다(프로드 실측 26-08-28).
 *
 * ⚠️ 안전성 근거(프로드 실측 26-08-28): `campaign_candidates` 26,331건 **전부** `stage` 필드를
 *   갖고 있고 값이 전량 `"discovered"` 다(다른 값 0건). 등호 술어는 필드가 없는 문서를 조용히
 *   빼므로 이 전제가 깨지면 물량 손실이 된다 — 위 두 writer 가 모두 stage 를 반드시 쓰기 때문에
 *   신규 문서도 같은 전제를 만족한다.
 */
const CAMPAIGN_CANDIDATE_FRESH_STAGE = "discovered";
// W57-F1 [프로드 실측 2026-08-08]: `in` 청크가 10이라 기접촉 증거 조회가 필요보다 3배 많은 왕복을
// 냈다(스캔 717건 → 필드당 72청크 × 5필드 = 360왕복/호출). Firestore `in` 상한은 30이고 같은
// 레포 read.ts:57 이 이미 30을 쓴다 — 상한을 맞춰 왕복을 1/3로 줄인다. 판정 결과는 불변이다
// (같은 값 집합을 더 적은 페이지로 나눠 읽을 뿐이다).
const FIRESTORE_IN_QUERY_LIMIT = 30;
const GETALL_CHUNK = 300;
// R35-3 [운영 2026-08-01]: maxFollowers 해제로 374건이 한꺼번에 들어오자 후보별 Firestore/safety
// Promise.all fan-out이 540초 Cloud Run timeout을 4회 연속 만들었다. 16이면 ceil(374/16)=24
// 라운드이고, 라운드당 100~500ms 가정이면 2.4~12초라 540초 worker 예산 안에 든다.
// 정책·결과 순서는 그대로 두고 외부 I/O 동시성만 유계화한다.
export const CAMPAIGN_CANDIDATE_IO_CONCURRENCY = 16;
// R36-1/2: maxFollowers=0 pass는 remaining=310을 모두 새 target으로 고를 수 있다. BatchGet
// 요청은 310개 문서명 약 62KiB(대부분 missing)지만, target Commit은 평균 2.4KiB 문서
// 310건(약 0.75MiB)에 index fan-out까지 처리한다. R37 phase 실측으로 60s 진범은 아니라고
// 확정됐지만, read/write를 100/100/100/10으로 제한하는 방어는 유지한다. deadline 연장은 금지한다.
export const PREPARE_TARGET_PERSISTENCE_CHUNK_SIZE = 100;
// R37-1/2 [운영 2026-08-01]: 기존 92명 wave artifact는 수신자당 raw 평균 457,714B였다
// (message_source 214,044 + outreach 132,106 + conversation message 108,563 + 나머지 3,001).
// flat 450-callback 첫 RPC는 89명 완전 artifact만으로 40,736,564B(40.7MB/38.8MiB)를
// 넘고 90번째 일부도 섞였으며, knowledge edge 실제 op 수도 callback 수보다 컸다. 8명 worst
// 실측은 3,678,491B라 Firestore 10MiB 한도와 protobuf/index overhead에 여유를 둔다.
// 본문 deadline을 늘리지 않고 recipient 원자 단위 자체를 유계화한다.
export const CAMPAIGN_WAVE_QUEUE_RECIPIENT_CHUNK_SIZE = 8;

function annotateRefillFailurePhase(error: unknown, phase: string): void {
  if (!error || typeof error !== "object" || "refillPhase" in error) return;
  try {
    Object.assign(error, { refillPhase: phase });
  } catch {
    // Frozen third-party errors still propagate; message/frame diagnostics remain available.
  }
}

const refillRollbackFailureCounts = new WeakMap<object, number>();

function recordRefillRollbackFailure(error: unknown, attemptedCount: number): void {
  if (!error || typeof error !== "object" || attemptedCount <= 0) return;
  refillRollbackFailureCounts.set(
    error,
    (refillRollbackFailureCounts.get(error) ?? 0) + attemptedCount,
  );
}

function refillRollbackFailureCountForError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  return refillRollbackFailureCounts.get(error);
}

// W57-F4 [프로드 실측 2026-08-08]: 리필이 한 번 시작되면 내부에 마감이 없어 480s timeoutSeconds 를
// 넘겨 강제종료(504 → 스케줄러 DEADLINE_EXCEEDED=code 4)됐다. 발송부는 이미 sweepDeadlineMs 계약을
// 갖고 있는데 리필만 없었다. 단계 경계에서 마감을 확인해 **스스로 양보**한다 — 강제종료는 부분 진행분의
// 보상 롤백조차 못 돌지만, 여기서 던지면 기존 거부 경로(campaign_targets_* 와 동일)로 정상 정리된다.
// maxInstances=1 이고 리필은 순차 호출이라 모듈 스코프 1개로 충분하다(호출부 20곳 시그니처 무변경).
let currentRefillDeadlineMs: number | null = null;

export async function withRefillDeadline<T>(deadlineMs: number | null, operation: () => Promise<T>): Promise<T> {
  const previous = currentRefillDeadlineMs;
  currentRefillDeadlineMs = typeof deadlineMs === "number" && Number.isFinite(deadlineMs) ? deadlineMs : null;
  try {
    return await operation();
  } finally {
    currentRefillDeadlineMs = previous;
  }
}

export function refillDeadlineExceeded(marginMs = 0): boolean {
  return currentRefillDeadlineMs !== null && Date.now() >= currentRefillDeadlineMs - marginMs;
}

export async function runRefillPhase<T>(phase: string, operation: () => Promise<T>): Promise<T> {
  if (refillDeadlineExceeded()) {
    const error = Object.assign(new Error(`refill deadline reached before ${phase}; yielding to next pass`), {
      code: "deadline-exceeded",
      errorCode: "campaign_refill_deadline_yield",
    });
    annotateRefillFailurePhase(error, phase);
    throw error;
  }
  try {
    return await operation();
  } catch (error) {
    annotateRefillFailurePhase(error, phase);
    throw error;
  }
}

// W57-M2 [독립 리뷰 2026-08-08]: 커밋 단계는 **양보 불가**다. 메타데이터 쓰기와 큐 쓰기 사이에서
// 양보하면 lastRefill.queued 는 커밋된 것처럼 남는데 outreach 행은 없고, 준비된 target 은 롤백도
// 안 된 채 남는다(부분 커밋). 마감은 이 페어에 **들어가기 전에** 한 번 보고, 들어간 뒤에는 끝까지 간다
// — 스윕이 캠페인 경계에서만 예산을 보는 것과 같은 패턴이다.
export async function runRefillCommitPhase<T>(phase: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    annotateRefillFailurePhase(error, phase);
    throw error;
  }
}

// W58-라2 [프로드 실측 2026-08-09 · 과차단 회귀 수리]: "이번 pass 에 발굴 잡을 넣은 캠페인" 집합.
//
// 1차 수리(W58-라)는 리필 **호출 전에 무조건** 등록했다. "예외 경로 누락 방지"가 이유였는데,
// 리필이 실제로는 enqueue 하지 않는 pass(shortfall 1시간 간격 게이트에 막힌 경우 — autoRefill 이
// 켜져 있으면 대부분의 pass 가 여기 해당)에도 등록돼 **꼬리 floor 루프가 영구 스킵**됐다.
// 프로드 실측: autoRefill 전환 후 66분·13 pass 동안 candidatePoolInventory.atIso 가 16:32:10 에
// 고정 = 재고 센서가 한 번도 안 돌았다. B-1 이 고친 기아를 다른 문으로 되살린 셈이다.
//
// 그래서 등록 지점을 **실제 enqueue 성공 시점**으로 옮긴다. enqueueShortfallDiscoveryJob 이
// 자기 성공 경로에서 직접 넣으므로 레인(shortfall/floor)과 무관하게 정확하고, 예외 경로에서도
// "넣지 않았으면 등록되지 않는다"가 자동으로 성립한다(1차 수리가 막으려던 누락이 애초에 없다).
// 수명은 pass 단위 — 스윕 진입에서 초기화한다(계측 리셋과 같은 패턴, maxInstances/concurrency 1).
let currentPassEnqueuedCampaigns: Set<string> = new Set();

export function beginPassEnqueueTracking(): void {
  currentPassEnqueuedCampaigns = new Set();
}

export function passEnqueuedCampaigns(): ReadonlySet<string> {
  return currentPassEnqueuedCampaigns;
}

function recordPassEnqueue(campaignId: string): void {
  if (campaignId) currentPassEnqueuedCampaigns.add(campaignId);
}

// W58-Δ1: 관문 기본 예약값. 스윕의 CAMPAIGN_REFILL_COMMIT_RESERVE_MS 와 **같은 값**이어야 한다 —
// 사이징과 관문이 다른 예약을 쓰면 둘 사이 구간이 다시 무방비가 된다. 스윕은 옵션 주입을 허용하므로
// 그 경우 호출부가 같은 값을 명시로 넘긴다.
export const CAMPAIGN_REFILL_COMMIT_RESERVE_DEFAULT_MS = 15_000;

// 커밋 페어 진입 직전의 단일 관문. 여기서 양보하면 아직 아무것도 커밋되지 않았고
// preparedRefPaths 보상 롤백이 정상 동작한다.
//
// W58-Δ1 [Codex 델타]: 관문 기준을 **마감 − 커밋 예약**으로 당긴다. 사이징만 예약분을 공제하고
// 이 관문이 원 마감을 그대로 보면, 빌드가 마감 직전에 끝났을 때 커밋 페어가 그대로 시작돼
// 마진(480s−420s=60s)을 먹는다 — 커밋 페어는 W57-M2 로 양보 불가라 시작하면 끝까지 간다.
// 예약 구간에 걸린 웨이브는 여기서 yield·롤백되고 5분 뒤 재시도라 손실이 싸다(멱등 재개).
export function assertRefillDeadlineBeforeCommit(phase: string, reserveMs = CAMPAIGN_REFILL_COMMIT_RESERVE_DEFAULT_MS): void {
  if (!refillDeadlineExceeded(reserveMs)) return;
  // R34-2: errorCode 는 전역 고유해야 한다(로그만 보고 지점을 특정할 수 있어야 하므로) —
  // 단계 경계 양보(campaign_refill_deadline_yield)와 커밋 진입 관문을 다른 코드로 나눈다.
  const error = Object.assign(new Error(`refill deadline reached before ${phase}; yielding before any commit`), {
    code: "deadline-exceeded",
    errorCode: "campaign_refill_deadline_yield_precommit",
  });
  annotateRefillFailurePhase(error, phase);
  throw error;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  context: string,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(items.length, Math.trunc(concurrency) || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  let firstFailure: unknown;
  const run = async (): Promise<void> => {
    while (!failed && nextIndex < items.length) {
      const index = nextIndex;
      // W58-M2 [독립 리뷰]: 2,500ms/행 선형 모델은 **예측이지 보장이 아니다** — 16-way 배치 양자화
      // (ceil(n/16)×라운드시간)와 고정비를 무시해서, n=17 처럼 라운드 경계를 갓 넘는 크기에서 예측을
      // 크게 벗어난다. 사이징은 1차 필터로 두고, **하드 바운드**를 여기에 둔다: 이 루프가 웨이브 빌드의
      // 비싼 구간(live_draft_safety 등)을 실제로 돌리는 지점이라 아이템 경계가 유일한 안전한 중단점이다.
      // 마감 컨텍스트 밖(withRefillDeadline 미적용)에서는 refillDeadlineExceeded() 가 항상 false 라
      // 타 호출부는 무영향이고, draftPlans 는 커밋 전이라 기존 보상 롤백 경로가 그대로 처리한다.
      if (refillDeadlineExceeded()) {
        const isFirstFailure = !failed;
        failed = true;
        const error = Object.assign(
          new Error(`refill deadline reached during ${context}; yielding at item boundary`),
          { code: "deadline-exceeded", errorCode: "campaign_refill_deadline_yield_item" },
        );
        annotateRefillFailurePhase(error, context);
        if (isFirstFailure) firstFailure = error;
        return;
      }
      // W58-무비용 [독립 리뷰 델타]: 인덱스 소비는 **마감 검사를 통과한 뒤**에 한다. 앞서 올리면
      // 마감으로 빠져나간 인덱스가 results 에 구멍(undefined)으로 남는다 — 지금은 throw 로 결과를
      // 안 쓰지만, 나중에 부분 결과를 쓰게 되면 조용한 undefined 가 된다.
      nextIndex += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        const isFirstFailure = !failed;
        failed = true;
        annotateRefillFailurePhase(error, context);
        if (isFirstFailure) firstFailure = error;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, () => run()));
  if (failed) throw firstFailure;
  return results;
}

// W57-F2 [프로드 실측 2026-08-08]: 기접촉·격리 증거 조회가 `for … for … await` 완전 직렬이라 pass
// 비용이 큐 깊이에 선형으로 붙었다(큐 0 → 8s, 큐 ~90 → 211~333s, 웨이브 100 → 480s 강제종료).
// 청크 자체는 서로 독립인 읽기이므로 순서 보장이 필요 없다 — 결과를 집합으로 합치기 때문이다.
// 동시성만 유계화하고 술어·판정은 무접촉이다.
//
// ⚠️ 상한은 **전역**이어야 한다. helper 마다 유계화하면 호출부가 이들을 Promise.all 로 겹칠 때
// fan-out 이 곱해진다(개발 중 실측: helper 상한 8인데 동시 27). 그건 R35-3 이 고쳤던 Cloud Run
// timeout 회귀를 그대로 재생산한다 — 그래서 세마포어 1개를 모듈 스코프에 둔다.
export const CAMPAIGN_EVIDENCE_QUERY_CONCURRENCY = 8;

// 전역 세마포어. 대기자는 FIFO 로 깨워 기아를 만들지 않는다.
let evidenceSlotsInUse = 0;
const evidenceSlotWaiters: Array<() => void> = [];

function acquireEvidenceSlot(): Promise<void> {
  if (evidenceSlotsInUse < CAMPAIGN_EVIDENCE_QUERY_CONCURRENCY) {
    evidenceSlotsInUse += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => evidenceSlotWaiters.push(() => {
    evidenceSlotsInUse += 1;
    resolve();
  }));
}

function releaseEvidenceSlot(): void {
  evidenceSlotsInUse -= 1;
  const next = evidenceSlotWaiters.shift();
  if (next) next();
}
// W57b-3 [Codex 적대 리뷰]: 이 카운터는 **pass 단위**여야 한다. gen2 인스턴스는 웜 유지되므로
// 리셋이 없으면 값이 인스턴스 수명 전체로 누적되고, 그러면 프로드에서 "pass < 240s" 를 관측하려고
// 읽는 evidenceRoundTrips 가 단조 증가하는 무의미한 수가 된다 — 수용 기준 관측 자체가 거짓이 된다.
// inFlight 는 실행 중 슬롯 수라 리셋 대상이 아니다(리셋하면 세마포어 회계가 깨진다).
let campaignEvidenceRoundTrips = 0;
let campaignEvidenceInFlight = 0;
let campaignEvidencePeakInFlight = 0;
// T4-1 [읽기 비용 · 2026-09-05]: **왕복 수가 아니라 문서 수**를 따로 센다.
//   과금은 반환 문서 수라 roundTrips 로는 예산을 못 짠다 — `in` 30개짜리 청크 한 번이 1 왕복이지만
//   문서는 수백 건 돌아올 수 있다. 리필 읽기 예산(refillMaxDocumentReads)이 이 값을 소비한다.
let campaignEvidenceDocumentReads = 0;

export function readCampaignEvidenceMetrics(): { roundTrips: number; peakInFlight: number; documentReads: number } {
  return {
    roundTrips: campaignEvidenceRoundTrips,
    peakInFlight: campaignEvidencePeakInFlight,
    documentReads: campaignEvidenceDocumentReads,
  };
}

// pass 시작 시 호출한다(스윕 진입점). 테스트도 같은 함수를 쓴다 — 관측 의미가 한 곳에서만 정의된다.
export function resetCampaignEvidenceMetrics(): void {
  campaignEvidenceRoundTrips = 0;
  campaignEvidencePeakInFlight = 0;
  campaignEvidenceDocumentReads = 0;
}

/**
 * T4-1 회귀 수리 [2026-09-05 적대 리뷰 P1] — **읽기 예산을 실제 하드 캡으로 만든다.**
 *
 * 종전 구조: 예산은 `refillReadsSpent` 로 **사후 정산**만 됐다. 증거 쿼리는 `limit` 없이
 * `Promise.all` 로 전부 동시에 나갔고(세마포어는 **동시성**만 막지 총량을 못 막는다),
 * `campaignEvidenceDocumentReads` 는 `.get()` 이 이미 과금된 **뒤에** 증가했다.
 * 그래서 한 웨이브가 예산의 몇 배를 태워도 그 웨이브 안에서는 아무도 멈추지 못했고,
 * 예산은 "다음 캠페인"만 막았다 — 시간 축의 `withRefillDeadline` 에 대응하는 읽기 축이 없었다.
 *
 * 지금: 예산이 **쿼리 층까지 내려간다.** 청크는 발행 **전에** 예산을 선점(reserve)하고, 선점량을
 * `.limit()` 으로 쿼리에 실어 그 이상 과금될 수 없게 한다. 남은 예산이 0 이면 **발행하지 않고**
 * `truncated` 를 세운다.
 *
 * ⚠️ `limit(remaining + 1)` 이 아니라 `limit(reserved)` 인 이유: `+1` 은 청크마다 예산을 1씩
 * 초과할 수 있고(동시 발행이면 청크 수만큼), 그러면 "하드 캡"이 아니다. 대신 **가득 찬 페이지를
 * 절단으로 본다** — 실제로는 딱 맞은 경우도 절단으로 읽는 보수적(fail-closed) 오차이고,
 * 절단의 처방(증거 불명 → 미접촉으로 표시하지 않음)은 어느 쪽이든 같다.
 *
 * 예산이 없으면(스윕 밖 호출) 종전 동작 그대로다 — 무제한 병렬.
 */
export type EvidenceReadBudget = { remaining: number; truncated: boolean };

/** 선점량이 있으면 쿼리에 `limit` 을 실는다 — 예산이 없으면(null) 종전 무제한 쿼리 그대로. */
function boundedEvidenceQuery(query: Query, limit: number | null): Query {
  return limit === null ? query : query.limit(limit);
}

/**
 * 청크 1건이 한 번에 선점할 수 있는 상한. 예산 전액을 첫 청크가 삼키면 뒤 청크가 전부 절단되므로
 * 나눠 준다. `in` 30키 청크가 이 수를 넘는 증거 행을 돌려주는 것은 이미 병리적 형상이라,
 * 그때 절단으로 닫는 것이 맞는 방향이다.
 */
const EVIDENCE_CHUNK_READ_RESERVE = 500;

let currentEvidenceReadBudget: EvidenceReadBudget | null = null;
// One budget is shared by the parallel evidence readers in a refill wave. Reserving from the plain
// `remaining` number is atomic only until the first reader awaits: a sparse reader can temporarily
// reserve the whole cap, making its siblings observe zero and set sticky `truncated` before the
// unused reservation is refunded. Serialize complete budgeted executions per budget object so the
// next sibling observes the prior reader's actual usage. Different waves/budgets remain independent.
const evidenceBudgetExecutionTails = new WeakMap<EvidenceReadBudget, Promise<void>>();

async function withEvidenceBudgetExecution<T>(budget: EvidenceReadBudget, operation: () => Promise<T>): Promise<T> {
  const previousTail = evidenceBudgetExecutionTails.get(budget) ?? Promise.resolve();
  let releaseTurn!: () => void;
  const currentTurn = new Promise<void>((resolve) => { releaseTurn = resolve; });
  const queuedTail = previousTail.then(() => currentTurn);
  evidenceBudgetExecutionTails.set(budget, queuedTail);
  await previousTail;
  try {
    return await operation();
  } finally {
    releaseTurn();
    if (evidenceBudgetExecutionTails.get(budget) === queuedTail) evidenceBudgetExecutionTails.delete(budget);
  }
}

export function createEvidenceReadBudget(maxDocumentReads: number): EvidenceReadBudget {
  return { remaining: Math.max(0, Math.trunc(maxDocumentReads)), truncated: false };
}

/** 이 호출 구간의 증거 읽기를 예산에 묶는다(`withRefillDeadline` 과 같은 앰비언트 방식). */
export async function withEvidenceReadBudget<T>(
  budget: EvidenceReadBudget | null,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = currentEvidenceReadBudget;
  currentEvidenceReadBudget = budget;
  try {
    return await operation();
  } finally {
    currentEvidenceReadBudget = previous;
  }
}

/** 현재 구간의 증거 조회가 예산 때문에 잘렸는가 — **fail-closed 판정의 스위치**. */
export function evidenceReadBudgetTruncated(): boolean {
  return currentEvidenceReadBudget?.truncated === true;
}

// 반환 타입을 문서 스냅샷으로 **고정**한다 — 제네릭으로 두면 호출부에서 추론이 unknown 으로 무너져
// `doc.data()` 가 타입 에러가 난다(전 호출부가 `.docs` 를 반환하므로 일반화 이득도 없다).
// export: `adminDb` 주입점이 없는 이 파일에서 **예산 로직만** 결정적으로 시험할 수 있게 한다.
//   `run` 콜백이 곧 쿼리 층이므로, 가짜 `run` 으로 고팬아웃 증거를 흉내 내면 "예산을 넘겨 읽지
//   않는다"를 값으로 잰다(tests/t4-1-refill-read-budget.test.mjs).
export async function runChunkedEvidenceQueries(
  values: string[],
  context: string,
  run: (chunk: string[], limit: number | null) => Promise<readonly QueryDocumentSnapshot[]>,
): Promise<QueryDocumentSnapshot[]> {
  const chunks = chunkStrings(uniqueStrings(values), FIRESTORE_IN_QUERY_LIMIT).filter((chunk) => chunk.length > 0);
  if (chunks.length === 0) return [];
  const budget = currentEvidenceReadBudget;

  const runOne = async (chunk: string[]): Promise<readonly QueryDocumentSnapshot[]> => {
    // 예산 선점은 **발행 전**이다. 동시 발행이 서로의 잔량을 넘겨 읽지 못하게 한다.
    const reserved = budget ? Math.min(budget.remaining, EVIDENCE_CHUNK_READ_RESERVE) : null;
    if (budget && (reserved === null || reserved <= 0)) {
      budget.truncated = true;
      return [];
    }
    if (budget && reserved !== null) budget.remaining -= reserved;
    await acquireEvidenceSlot();
    campaignEvidenceRoundTrips += 1;
    campaignEvidenceInFlight += 1;
    campaignEvidencePeakInFlight = Math.max(campaignEvidencePeakInFlight, campaignEvidenceInFlight);
    try {
      const docs = await run(chunk, reserved);
      // T4-1: 실제로 과금된 문서 수. 예외 경로는 세지 않는다(반환이 없으면 회계에 넣을 수도 없다).
      campaignEvidenceDocumentReads += docs.length;
      if (budget && reserved !== null) {
        // 안 쓴 선점분은 돌려준다. 페이지가 가득 찼으면 더 있을 수 있으므로 절단으로 본다.
        budget.remaining += Math.max(0, reserved - docs.length);
        if (docs.length >= reserved) budget.truncated = true;
      }
      return docs;
    } catch (error) {
      if (budget && reserved !== null) budget.remaining += reserved;
      annotateRefillFailurePhase(error, context);
      throw error;
    } finally {
      campaignEvidenceInFlight -= 1;
      releaseEvidenceSlot();
    }
  };

  if (!budget) {
    const pages = await Promise.all(chunks.map(runOne));
    return pages.flat() as QueryDocumentSnapshot[];
  }
  // 같은 예산을 공유하는 형제 호출까지 **실행 전체를 순차화**한다. 예약만 잠그고 바로 풀면 실제
  // 사용량 환불 전의 0 잔액을 다음 형제가 보고 거짓 절단하는 원래 race가 그대로 남는다.
  return withEvidenceBudgetExecution(budget, async () => {
    const collected: QueryDocumentSnapshot[] = [];
    for (const chunk of chunks) {
      if (budget.remaining <= 0) { budget.truncated = true; break; }
      collected.push(...(await runOne(chunk)));
    }
    return collected;
  });
}
export async function forEachSequentialChunk<T>(
  items: readonly T[],
  chunkSize: number,
  worker: (chunk: readonly T[], chunkIndex: number) => Promise<void>,
): Promise<void> {
  const size = Math.max(1, Math.trunc(chunkSize) || 1);
  let chunkIndex = 0;
  for (let start = 0; start < items.length; start += size) {
    await worker(items.slice(start, start + size), chunkIndex);
    chunkIndex += 1;
  }
}
export async function forEachCampaignWaveQueueChunk<T>(
  groups: readonly T[],
  worker: (chunk: readonly T[], chunkIndex: number) => Promise<void>,
): Promise<void> {
  await forEachSequentialChunk(groups, CAMPAIGN_WAVE_QUEUE_RECIPIENT_CHUNK_SIZE, worker);
}

const CAMPAIGN_OUTREACH_TOUCH_STATES = new Set([
  "queued_for_review",
  "approved",
  "processing",
  "sent",
  "mock_sent",
  // W10 F-3: 두 상태 모두 "이 후보에 이미 살아 있는 아웃리치 행이 있다"는 뜻이다(접촉했다는 주장이
  // 아니다 — queued_for_review·approved 가 이 집합에 있는 것과 같은 의미다). 빠져 있으면 같은 후보가
  // 웨이브마다 다시 1순위로 뽑혀 새 행과 새 예약 attempt 를 만든다(운영 실측 attempt 63).
  // deferred_awaiting_send_authorization 은 functions/chat-ai.ts 의 동명 상수와 같은 문자열이다.
  "sent_evidence_pending",
  "deferred_awaiting_send_authorization",
  "blocked",
  "suppressed_duplicate",
  "failed",
  // P0-2 [운영 실측]: 도달성 캐시가 undeliverable 이라 워커가 **의도적으로 안 보낸** 종결 행이다
  // (functions/chat-ai.ts CAMPAIGN_OUTREACH_UNDELIVERABLE_STATE 와 같은 문자열 — admin.ts 가
  // chat-ai.ts 를 import 하면 chat-ai.ts→mailReplyLinks→admin.ts 순환이 생기므로 리터럴 유지).
  // "살아 있는 아웃리치"는 아니지만 **재선택 금지 증거**로는 위 행들과 같은 역할이다 — 이 집합에
  // 없으면 addOutreachTouchKeys 가 touch 키를 만들지 않아, 이미 skip 된 후보가 매 pass 다시
  // 선택·승인됐다가 전량 skip 된다(프로드 실측: XP skipped_undeliverable 321행 방치 + pass 당
  // ~10건씩 신규 승인 후 전량 skip 반복).
  "skipped_undeliverable",
]);
const DEFAULT_MEMBER_AVATAR = "";


type LegacyMemberFallback = {
  id: string;
  name?: string;
  email?: string;
  avatar?: string;
  role?: Role;
  team?: string;
  assigned?: number;
  status?: string;
  lastActive?: string;
};

async function readLegacyMemberFallback(_memberId: string): Promise<LegacyMemberFallback | undefined> {
  return undefined;
}

const behaviorLogs: BehaviorLog[] = [];
const llmUsage: LlmUsage[] = [
  { model: "Qwen3-32B", tier: "빠른", calls: 1840, tokensK: 920, costKRW: 41000, share: 58 },
  { model: "Gemma 3 27B", tier: "빠른", calls: 610, tokensK: 280, costKRW: 12000, share: 17 },
  { model: "Qwen3-235B (MaaS)", tier: "품질", calls: 220, tokensK: 410, costKRW: 26000, share: 22 },
  { model: "Solar Pro 3 (self-host)", tier: "품질", calls: 40, tokensK: 60, costKRW: 5000, share: 3 },
];
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function owns(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function requestedCampaignCountryTargeting(data: Record<string, unknown>): CountryTargeting {
  if (owns(data, "countryTargeting") || owns(data, "targetCountries") || owns(data, "excludedCountries")) {
    return countryTargetingFromLegacy(data);
  }
  const targeting = isRecord(data.targetingCriteria) ? data.targetingCriteria : {};
  if (owns(targeting, "countryTargeting") || owns(targeting, "targetCountries") || owns(targeting, "excludedCountries")) {
    return countryTargetingFromLegacy(targeting);
  }
  if (owns(targeting, "regions")) {
    return countryTargetingFromLegacy(targeting, { targetCountriesKey: "regions" });
  }
  return countryTargetingFromLegacy({});
}

export function campaignAllowsInflyOverlap(data: Record<string, unknown>): boolean {
  const mailProfile = isRecord(data.mailProfile) ? data.mailProfile : {};
  const targetingCriteria = isRecord(data.targetingCriteria) ? data.targetingCriteria : {};
  return data.allowInflyOverlap === true
    || mailProfile.allowInflyOverlap === true
    || targetingCriteria.allowInflyOverlap === true;
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && value in ROLES;
}

function assertAdmin(request: CallableRequest): { uid: string; role: Role; team: string; ip: string } {
  const uid = request.auth?.uid;
  const role = request.auth?.token?.role ?? "guest";
  const team = request.auth?.token?.team ?? "—";

  if (!uid || role === "guest" || !ADMIN_ROLES.has(role)) {
    const behaviorLog = {
      userId: uid ?? "anonymous",
      role,
      team,
      gameId: "—",
      action: "admin.authorize",
      time: nowIso(),
      IP: request.rawRequest?.ip ?? "0.0.0.0",
      result: "denied" as Result,
      cost: 0,
    };
    const error = new Error(!uid ? "unauthenticated" : "permission-denied: admin role required");
    Object.assign(error, { code: !uid ? "unauthenticated" : "permission-denied", errorCode: "assert_admin_unauthorized", behaviorLog });
    behaviorLogs.push(behaviorLog);
    throw error;
  }

  return { uid, role, team, ip: request.rawRequest?.ip ?? "0.0.0.0" };
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatChatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function makeBehaviorLog(auth: { uid: string; role: Role; team: string; ip: string }, action: string, result: Result, costKRW = 0, gameId = "—"): BehaviorLog {
  return { userId: auth.uid, role: auth.role, team: auth.team, gameId, action, time: nowIso(), IP: auth.ip, result, cost: costKRW };
}

function cacheMeta(key: string, hit = false) {
  return { checked: true, hit, key, ttlSeconds: 600, mode: "mock" as const };
}

function costMeta(source: string, costKRW: number, tokensK = 0) {
  const loggedAt = nowIso();
  const inputTokens = Math.max(0, Math.round(tokensK * 1000));
  return {
    source,
    tokensK,
    costKRW,
    ledgerRef: `cost_logs/admin/${safeDocId(source)}`,
    provider: "mock-admin" as const,
    model: source,
    cacheChecked: true as const,
    cacheHit: false,
    inputTokens: inputTokens,
    outputTokens: 0,
    estimatedKRW: costKRW,
    currency: "KRW" as const,
    billable: false as const,
    loggedAt,
    recorded: true,
    mode: "mock" as const,
  };
}

function withSeedIsoFields(doc: Record<string, unknown>): Record<string, unknown> {
  const stampedAt = nowIso();
  const createdAtIso = typeof doc.createdAtIso === "string" && doc.createdAtIso ? doc.createdAtIso : stampedAt;
  const updatedAtIso = typeof doc.updatedAtIso === "string" && doc.updatedAtIso ? doc.updatedAtIso : createdAtIso;
  return { ...doc, createdAtIso, updatedAtIso };
}

function assertManager(request: CallableRequest): { uid: string; role: Role; team: string; ip: string } {
  const uid = request.auth?.uid;
  const role = request.auth?.token?.role ?? "guest";
  const team = request.auth?.token?.team ?? "—";
  if (!uid || role === "guest" || !MANAGER_ROLES.has(role)) {
    const behaviorLog = {
      userId: uid ?? "anonymous",
      role,
      team,
      gameId: "—",
      action: "manager.authorize",
      time: nowIso(),
      IP: request.rawRequest?.ip ?? "0.0.0.0",
      result: "denied" as Result,
      cost: 0,
    };
    const error = new Error(!uid ? "unauthenticated" : "permission-denied: manager role required");
    Object.assign(error, { code: !uid ? "unauthenticated" : "permission-denied", errorCode: "assert_manager_unauthorized", behaviorLog });
    behaviorLogs.push(behaviorLog);
    throw error;
  }
  return { uid, role, team, ip: request.rawRequest?.ip ?? "0.0.0.0" };
}

function recalculateShares(): void {
  const total = llmUsage.reduce((sum, item) => sum + item.costKRW, 0);
  for (const item of llmUsage) item.share = total === 0 ? 0 : Math.round((item.costKRW / total) * 100);
}

function sanitizeAction(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return "admin.unknown";
  return value.slice(0, 80);
}

function safeDocId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100);
  return normalized || "item";
}

function cleanString(value: unknown, fallback: string, maxLength = 180): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, maxLength) : fallback;
}

function stripUndefinedFields<T extends Record<string, unknown>>(record: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter((entry) => entry[1] !== undefined));
}

function firstCleanString(values: unknown[], fallback: string, maxLength = 180): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim().slice(0, maxLength);
  }
  return fallback.slice(0, maxLength);
}

function cleanTeam(value: unknown): string {
  const team = cleanString(value, "", 80);
  return team && team !== "—" ? team : "";
}

function claimRoleFromUser(user: UserRecord | null | undefined): Role | undefined {
  const role = user?.customClaims?.role;
  return isRole(role) ? role : undefined;
}

function memberStatus(value: unknown): "active" | "pending" {
  return value === "active" ? "active" : "pending";
}

function memberPhotoUrl(record: Record<string, unknown>, user: UserRecord | null | undefined, fallback?: unknown): string | undefined {
  return cleanProfileUrl(record.photoURL)
    ?? cleanProfileUrl(record.photoUrl)
    ?? cleanProfileUrl(record.picture)
    ?? cleanProfileUrl(record.avatar)
    ?? cleanProfileUrl(user?.photoURL)
    ?? cleanProfileUrl(fallback);
}

type AuthMembershipBackendDeps = {
  db?: typeof adminDb;
  auth?: typeof adminAuth;
};

let authMembershipBackendDepsForTests: AuthMembershipBackendDeps | null = null;

/**
 * Test-only seam (mirrors setMailAccountsDbForTests in functions/mailAccounts.ts):
 * node-lane tests inject an in-memory members store + claims recorder so the
 * auth-membership bootstrap never touches a real backend. Production callers
 * leave this null and every helper below falls through to adminDb/adminAuth.
 */
export function setAuthMembershipBackendDepsForTests(deps: AuthMembershipBackendDeps | null): void {
  authMembershipBackendDepsForTests = deps;
}

function authMembershipDb(): typeof adminDb {
  return authMembershipBackendDepsForTests?.db ?? adminDb;
}

function authMembershipAuth(): typeof adminAuth {
  return authMembershipBackendDepsForTests?.auth ?? adminAuth;
}

async function getAuthUserByUid(uid: string): Promise<UserRecord | null> {
  if (!uid) return null;
  return authMembershipAuth().getUser(uid).catch(() => null);
}

async function getAuthUserByEmail(email: string): Promise<UserRecord | null> {
  if (!email) return null;
  return authMembershipAuth().getUserByEmail(email).catch(() => null);
}

type ClaimSyncInput = {
  role: Role;
  team: string;
  name: string;
  email: string;
  photoURL?: string;
  claimSyncReason: string;
};

async function setMergedCustomClaims(uid: string, input: ClaimSyncInput, knownUser?: UserRecord | null): Promise<Record<string, unknown>> {
  const user = knownUser ?? await authMembershipAuth().getUser(uid);
  const existingClaims = isRecord(user.customClaims) ? user.customClaims : {};
  const nextClaims = stripUndefinedFields({
    ...existingClaims,
    role: input.role,
    team: input.team,
    // Avoid OIDC-reserved claim names (email/name/picture); expose attribution under app-owned keys.
    memberName: input.name,
    memberEmail: input.email,
    memberPhotoURL: input.photoURL,
    claimSyncReason: input.claimSyncReason,
  });
  await authMembershipAuth().setCustomUserClaims(uid, nextClaims);
  return nextClaims;
}

type MemberCandidate = {
  id: string;
  ref: DocumentReference;
  data: Record<string, unknown>;
};

async function memberCandidatesForUser(uid: string, email: string): Promise<MemberCandidate[]> {
  const candidates: MemberCandidate[] = [];
  const seen = new Set<string>();
  const addSnapshot = (snapshot: DocumentSnapshot) => {
    if (!snapshot.exists || seen.has(snapshot.ref.path)) return;
    seen.add(snapshot.ref.path);
    candidates.push({ id: snapshot.id, ref: snapshot.ref, data: snapshot.data() ?? {} });
  };

  addSnapshot(await authMembershipDb().collection("members").doc(uid).get());
  if (email) {
    const emailSnapshot = await authMembershipDb().collection("members").where("email", "==", email).limit(10).get();
    for (const doc of emailSnapshot.docs) addSnapshot(doc);
  }
  return candidates;
}

function chooseAuthoritativeMember(candidates: MemberCandidate[], uid: string): MemberCandidate | null {
  return candidates.find((candidate) => candidate.id === uid && memberStatus(candidate.data.status) === "active")
    ?? candidates.find((candidate) => memberStatus(candidate.data.status) === "active")
    ?? candidates.find((candidate) => candidate.id === uid)
    ?? candidates[0]
    ?? null;
}

function emailLocalPart(email: string, fallback: string): string {
  const local = email.split("@")[0];
  return local && local.trim() ? local.trim() : fallback;
}

function fallbackAvatar(name: string, email: string): string {
  const source = name || emailLocalPart(email, "U");
  return Array.from(source.trim())[0]?.toUpperCase() ?? "U";
}

function cleanProfileUrl(value: unknown): string | undefined {
  const url = cleanString(value, "", 500);
  return /^https?:\/\//.test(url) ? url : undefined;
}

function isAllowedDomain(email: string): boolean {
  if (email.endsWith("@supercent.io")) return true;
  return process.env.FUNCTIONS_EMULATOR === "true" && email.endsWith("@demo-flu");
}

export function authBootstrapAccessForEmail(emailValue: unknown): {
  role: "viewer" | "guest";
  team: "AIX" | "pending";
  status: "active" | "pending";
  domainAllowed: boolean;
  claimSyncReason: string;
} {
  const email = cleanString(emailValue, "", 180).toLowerCase();
  const domainAllowed = Boolean(email) && isAllowedDomain(email);
  if (email === CANONICAL_OPERATIONAL_MAILBOX_V1) {
    return {
      role: "guest",
      team: "pending",
      status: "pending",
      domainAllowed: true,
      claimSyncReason: "auth.onCreate.mailbox_access_required",
    };
  }
  return domainAllowed
    ? {
      role: "viewer",
      team: "AIX",
      status: "active",
      domainAllowed: true,
      claimSyncReason: "auth.onCreate.allowed_domain_viewer",
    }
    : {
      role: "guest",
      team: "pending",
      status: "pending",
      domainAllowed: false,
      claimSyncReason: "auth.onCreate.pending_guest",
    };
}

export async function upsertPendingMemberFromAuthUser(user: {
  uid: string;
  email?: string;
  displayName?: string;
  photoURL?: string;
  providerData?: Array<{ providerId?: string }>;
}) {
  const email = cleanString(user.email, "", 180).toLowerCase();
  const access = authBootstrapAccessForEmail(email);
  const name = cleanString(user.displayName, emailLocalPart(email, "신규 가입자"), 80);
  const photoURL = cleanProfileUrl(user.photoURL);
  const now = nowIso();
  await adminDb.collection("members").doc(user.uid).set(stripUndefinedFields({
    id: user.uid,
    uid: user.uid,
    name,
    email,
    avatar: photoURL ?? fallbackAvatar(name, email),
    photoURL,
    role: access.role,
    team: access.team,
    assigned: 0,
    status: access.status,
    lastActive: access.status === "active" ? "가입 완료" : "승인 요청 전",
    domainAllowed: access.domainAllowed,
    claimSyncReason: access.claimSyncReason,
    authProviderIds: user.providerData?.map((provider) => provider.providerId).filter(Boolean) ?? [],
    createdAtIso: now,
    updatedAtIso: now,
    source: "auth.onCreate",
  }), { merge: true });
  return access;
}

export type AuthMembershipBootstrapStatus =
  | "mapped"
  | "mailbox_access"
  | "mailbox_access_required"
  | "unmapped"
  | "mismatched"
  | "disabled"
  | "unverified"
  | "outside_domain"
  | "unavailable";

export type AuthMembershipBootstrapResult = {
  ok: boolean;
  status: AuthMembershipBootstrapStatus;
  uid: string;
  role: Role;
  team: string | null;
  orgId: string | null;
  membershipStatus: "active" | "pending" | "unavailable";
  claimSyncReason: string;
  claimsWritten: boolean;
  behaviorLog: BehaviorLog;
};

function peoplyPrimaryMembership(detail: PeoplyPersonDetail) {
  const primaryOrgId = cleanTeam(detail.employee.primaryMembership);
  if (!primaryOrgId) return null;
  return detail.memberships.find(
    (membership) => membership.orgId === primaryOrgId && membership.primary === true,
  ) ?? null;
}

function peoplyTeamLabel(
  detail: PeoplyPersonDetail,
): string {
  const primaryMembership = peoplyPrimaryMembership(detail);
  const pathTeam = primaryMembership?.organizationPath
    .split("/")
    .map((segment) => cleanTeam(segment))
    .filter(Boolean)
    .at(-1) ?? "";
  return [
    primaryMembership?.organizationName,
    pathTeam,
  ].map((value) => cleanTeam(value)).find(Boolean) ?? "";
}

function peoplyFailureStatus(error: unknown): "unmapped" | "unavailable" {
  return error instanceof PeoplyClientError && error.kind === "not_found"
    ? "unmapped"
    : "unavailable";
}

function authBootstrapRole(
  authorityMember: MemberCandidate | null,
  user: UserRecord,
  identityAuthorized: boolean,
  requestRole: unknown,
  allowPersistedRoleFallback = false,
): Role {
  const persistedRole = authorityMember?.data.role;
  // allowPersistedRoleFallback covers a transient directory read failure
  // ("unavailable") only: the persisted member doc is the last-known-good role
  // source and must survive an outage. Authoritative negative answers
  // (unmapped/mismatched/disabled/unverified/outside_domain/mailbox_access_required)
  // still resolve to guest below, and claim/request roles stay identity-gated —
  // a stale claim can never outrank the persisted doc on the fallback path.
  if ((identityAuthorized || allowPersistedRoleFallback) && authorityMember && memberStatus(authorityMember.data.status) === "active" && isRole(persistedRole) && persistedRole !== "guest") {
    return persistedRole;
  }
  const claimRole = claimRoleFromUser(user);
  if (identityAuthorized && claimRole && claimRole !== "guest") return claimRole;
  if (identityAuthorized && isRole(requestRole) && requestRole !== "guest") return requestRole;
  return identityAuthorized ? "viewer" : "guest";
}

function exactUidMemberCandidate(candidates: MemberCandidate[], uid: string): MemberCandidate | null {
  return candidates.find((candidate) => candidate.id === uid && cleanString(candidate.data.uid, "") === uid) ?? null;
}

function hasActivePublicMailboxAccess(
  exactMember: MemberCandidate | null,
  uid: string,
  email: string,
): boolean {
  if (email !== CANONICAL_OPERATIONAL_MAILBOX_V1 || !exactMember) return false;
  const member = exactMember.data;
  const role = member.role;
  return exactMember.id === uid
    && cleanString(member.uid, "") === uid
    && cleanString(member.email, "", 180).toLowerCase() === email
    && memberStatus(member.status) === "active"
    && isRole(role)
    && role !== "guest"
    && Array.isArray(member.mailAccountIds)
    && member.mailAccountIds.some((accountId) => accountId === "scp");
}

function authBootstrapErrorReason(status: AuthMembershipBootstrapStatus): string {
  switch (status) {
    case "mapped": return "auth.bootstrap.peoply_mapped";
    case "mailbox_access": return "auth.bootstrap.mailbox_access";
    case "mailbox_access_required": return "auth.bootstrap.mailbox_access_required";
    case "unmapped": return "auth.bootstrap.peoply_unmapped";
    case "mismatched": return "auth.bootstrap.peoply_email_mismatch";
    case "disabled": return "auth.bootstrap.peoply_disabled";
    case "unverified": return "auth.bootstrap.unverified_email";
    case "outside_domain": return "auth.bootstrap.outside_domain";
    case "unavailable": return "auth.bootstrap.peoply_unavailable";
  }
}

function authBootstrapBehaviorLog(
  uid: string,
  role: Role,
  team: string,
  status: AuthMembershipBootstrapStatus,
  request: CallableRequest,
): BehaviorLog {
  return {
    userId: uid,
    role,
    team: team || "pending",
    gameId: "flu-auth",
    action: `auth.bootstrap.${status}`,
    time: nowIso(),
    IP: request.rawRequest?.ip ?? "0.0.0.0",
    result: status === "mapped" || status === "mailbox_access" ? "success" : status === "unavailable" ? "error" : "denied",
    cost: 0,
  };
}

/**
 * Resolve one authenticated user against the server-side Peoply directory and
 * persist the result in the existing members collection. The Auth token and
 * callable payload are deliberately excluded from identity resolution: Auth
 * Admin's verified email is the only accepted lookup key, and Peoply is the
 * only source for a newly mapped team/org.
 */
export async function bootstrapAuthMembershipForUser(
  user: UserRecord,
  request: CallableRequest = { auth: { uid: user.uid } },
): Promise<AuthMembershipBootstrapResult> {
  const uid = user.uid;
  const email = cleanString(user.email, "", 180).toLowerCase();
  const candidates = await memberCandidatesForUser(uid, email);
  const exactMember = exactUidMemberCandidate(candidates, uid);
  const publicMailboxAccess = hasActivePublicMailboxAccess(exactMember, uid, email);
  const authorityMember = email === CANONICAL_OPERATIONAL_MAILBOX_V1 ? exactMember : chooseAuthoritativeMember(candidates, uid);
  const persistedMember = authorityMember?.data ?? {};
  const persistedMailAccountIds = publicMailboxAccess ? stringArrayField(persistedMember.mailAccountIds) : [];
  const name = firstCleanString(
    [persistedMember.name, user.displayName],
    emailLocalPart(email, "신규 가입자"),
    80,
  );
  const photoURL = memberPhotoUrl(persistedMember, user);
  const mappedMemberBase = {
    id: uid,
    uid,
    name,
    email,
    avatar: photoURL ?? cleanString(persistedMember.avatar, fallbackAvatar(name, email), 500),
    photoURL,
    assigned: typeof persistedMember.assigned === "number" ? persistedMember.assigned : 0,
    createdAtIso: cleanString(persistedMember.createdAtIso, nowIso()),
    source: "auth.bootstrap.peoply",
    updatedAtIso: nowIso(),
    updatedBy: "auth.bootstrap",
  };

  let status: AuthMembershipBootstrapStatus;
  let detail: PeoplyPersonDetail | null = null;
  // The time this detail was actually verified against Peoply — the cache row's own syncedAtIso
  // on a cache hit, or "now" on a live call. Round-1 review finding #1: a cache HIT must stamp
  // peoplySyncedAtIso with the row's real sync time, never "now" (a merely-served stale/cached
  // row must not look freshly verified).
  let peoplyVerifiedAtIso: string | null = null;
  // True only when a Peoply directory lookup was actually issued — the
  // disabled/unverified/outside_domain/mailbox paths resolve without one.
  let peoplyAttempted = false;
  if (user.disabled) {
    status = "disabled";
  } else if (!user.emailVerified) {
    status = "unverified";
  } else if (!email || !isAllowedDomain(email)) {
    status = "outside_domain";
  } else if (email === CANONICAL_OPERATIONAL_MAILBOX_V1) {
    // The canonical public mailbox is authorized by its explicit member grant only. It is never
    // sent through Peoply and receives no employee/team projection.
    status = publicMailboxAccess ? "mailbox_access" : "mailbox_access_required";
  } else {
    peoplyAttempted = true;
    try {
      // 2026-09-29 (peoply-directory-cache): cache-first — a Peoply outage no longer forces this
      // login/bootstrap step to fall back to "unavailable" (and, via authBootstrapRole's
      // allowPersistedRoleFallback guard above the caller, potentially the persisted-role
      // fallback path) for a user already captured in the daily-synced directory snapshot.
      const peoplyResult = await getCachedOrLivePeoplyPerson(email, { membershipView: "official" }, { db: authMembershipDb() });
      detail = peoplyResult.detail;
      peoplyVerifiedAtIso = peoplyResult.syncedAtIso;
      const returnedEmail = cleanString(detail.employee.email, "").toLowerCase();
      if (!returnedEmail || returnedEmail !== email) {
        status = "mismatched";
      } else if (!isPeoplyEmployeeActive(detail.employee.status)) {
        status = "disabled";
      } else if (!peoplyPrimaryMembership(detail) || !peoplyTeamLabel(detail)) {
        status = "unmapped";
      } else {
        status = "mapped";
      }
    } catch (error) {
      status = peoplyFailureStatus(error);
    }
  }

  const mappedDetail = status === "mapped" ? detail : null;
  const mapped = mappedDetail !== null;
  const identityAuthorized = mapped || publicMailboxAccess;
  // "unavailable" is a transient Peoply read failure (timeout/5xx/network/
  // rate-limit/key), never an authoritative "does not belong" answer — so the
  // persisted non-guest role must be kept instead of stamping guest into both
  // claims and the members doc (a one-off outage would otherwise permanently
  // poison the doc and collapse the role to viewer on the next login).
  const resolvedRole = authBootstrapRole(authorityMember, user, identityAuthorized, request.auth?.token?.role, status === "unavailable");
  // A failed directory read is fail-closed for sender routing too. Retaining
  // an old org id here would let a transiently stale membership reach an org
  // mailbox; the next login/bootstrap refresh can restore it from Peoply.
  const primaryMembership = mappedDetail ? peoplyPrimaryMembership(mappedDetail) : null;
  const orgId = primaryMembership?.orgId || null;
  const team = mapped ? peoplyTeamLabel(mappedDetail) || null : null;
  const claimSyncReason = authBootstrapErrorReason(status);
  const claimsRole = resolvedRole;
  const claimsTeam = team || "pending";
  const memberStatusValue: "active" | "pending" = claimsRole === "guest" ? "pending" : "active";
  const memberRecord = stripUndefinedFields({
    ...mappedMemberBase,
    source: publicMailboxAccess ? "auth.bootstrap.mailbox_access" : mappedMemberBase.source,
    mailAccountIds: persistedMailAccountIds.length > 0 ? persistedMailAccountIds : undefined,
    role: claimsRole,
    team: team || "pending",
    status: memberStatusValue,
    lastActive: memberStatusValue === "active" ? "로그인 확인" : "승인 요청 전",
    domainAllowed: Boolean(email) && isAllowedDomain(email),
    claimSyncReason,
    claimsSyncedAtIso: nowIso(),
    peoplySyncStatus: status,
    // peoplySyncedAtIso is the LAST SUCCESSFUL directory sync only — stamping it
    // on a failed read would erase the staleness bound for a kept last-known-good
    // role (a sustained unavailable would look freshly synced forever). Failures
    // preserve the persisted value; peoplyLastAttemptAtIso records that a lookup
    // actually ran (omitted on paths that never reach Peoply).
    peoplySyncedAtIso: status === "mapped"
      // The row's actual verified-against-Peoply time (cache hit: the cache row's own
      // syncedAtIso; live call: "now") — never "now" for a served cache hit (round-1 review
      // finding #1).
      ? (peoplyVerifiedAtIso ?? nowIso())
      : status === "mailbox_access"
        ? nowIso()
        : cleanString(persistedMember.peoplySyncedAtIso, "") || undefined,
    peoplyLastAttemptAtIso: peoplyAttempted ? nowIso() : undefined,
    ...(mappedDetail ? {
      orgId,
      organizationName: primaryMembership?.organizationName || null,
      organizationPath: primaryMembership?.organizationPath ?? "",
      peoplyEmployeeId: mappedDetail.employee.id || null,
      peoplyEmployeeStatus: mappedDetail.employee.status || null,
      teamSource: "peoply",
    } : {
      orgId: null,
      organizationName: null,
      organizationPath: "",
      peoplyEmployeeId: null,
      peoplyEmployeeStatus: null,
      teamSource: status === "mailbox_access" || status === "mailbox_access_required"
        ? status
        : status === "unavailable" ? "unavailable" : "unmapped",
    }),
  });

  const claims = await setMergedCustomClaims(uid, {
    role: claimsRole,
    team: claimsTeam,
    name,
    email,
    photoURL,
    claimSyncReason,
  }, user);
  const writeRefs = new Map<string, DocumentReference>();
  const canonicalRef = authMembershipDb().collection("members").doc(uid);
  writeRefs.set(canonicalRef.path, canonicalRef);
  if (authorityMember && authorityMember.id !== uid) {
    writeRefs.set(authorityMember.ref.path, authorityMember.ref);
  }
  const batch = authMembershipDb().batch();
  for (const ref of writeRefs.values()) {
    batch.set(ref, { ...memberRecord, id: ref.id }, { merge: true });
  }
  await batch.commit();

  const behaviorLog = authBootstrapBehaviorLog(uid, claimsRole, team || "", status, request);
  behaviorLogs.push(behaviorLog);
  return {
    ok: identityAuthorized,
    status,
    uid,
    role: claims.role as Role,
    team: team || null,
    orgId,
    membershipStatus: status === "unavailable" ? "unavailable" : memberStatusValue,
    claimSyncReason,
    claimsWritten: true,
    behaviorLog,
  };
}

/**
 * Authenticated bootstrap entrypoint used by the login/session client. It
 * accepts no identity fields: request.auth.uid selects the Admin Auth user,
 * and the user record supplies the verified email and current claims.
 */
export async function bootstrapAuthMembership(request: CallableRequest): Promise<AuthMembershipBootstrapResult> {
  const uid = request.auth?.uid;
  if (!uid) {
    const error = new Error("unauthenticated: login required before membership bootstrap");
    Object.assign(error, { code: "unauthenticated", errorCode: "auth_bootstrap_unauthenticated" });
    throw error;
  }
  const user = await getAuthUserByUid(uid);
  if (!user) {
    const error = new Error("unauthenticated: authenticated user could not be resolved");
    Object.assign(error, { code: "unauthenticated", errorCode: "auth_bootstrap_user_not_found" });
    throw error;
  }
  return bootstrapAuthMembershipForUser(user, request);
}

function stringArrayField(value: unknown, maxItems = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 80))
    .slice(0, maxItems);
}

function stringField(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

// Flu/W2 (Codex 적대 리뷰 MEDIUM-4 수리): functions/accountOwnership.ts recordOwnerOrgId /
// functions/discovery.ts ownershipStampFromResourceRecord 와 같은 별칭 순서(ownerOrgId →
// accountOwnerOrgId → programOwnerOrgId → campaignOwnerOrgId) — 이 캠페인이 정본 ownerOrgId
// 대신 별칭 필드로 스탬프됐어도 W1 게이트·W2 풀 라우팅이 같은 org 로 읽도록 맞춘다.
function campaignOwnerOrgIdAlias(campaign: Record<string, unknown>): string {
  return stringField(campaign, "ownerOrgId", "")
    || stringField(campaign, "accountOwnerOrgId", "")
    || stringField(campaign, "programOwnerOrgId", "")
    || stringField(campaign, "campaignOwnerOrgId", "");
}

function avatarField(record: Record<string, unknown>): string {
  for (const key of [
    "avatar",
    "avatarUrl",
    "photoURL",
    "photoUrl",
    "picture",
    "imageUrl",
    "profileImageUrl",
    "profile_image_url",
    "thumbnailUrl",
    "thumbnail_url",
    "channelThumbnailUrl",
    "channel_thumbnail_url",
    "thumb",
  ]) {
    const value = stringField(record, key, "");
    if (value) return value;
  }
  return "";
}

// Red-team fix: the dot-optional pattern below exists ONLY to accept the emulator's
// dot-less "@demo-flu" fixture domain (see isAllowedDomain's matching FUNCTIONS_EMULATOR
// branch just above). It must never apply in production — a bare "a@b" is not a valid
// email — so the relaxed regex is gated on FUNCTIONS_EMULATOR the same way isAllowedDomain
// gates its own emulator-only exception.
export function validEmailField(value: unknown): string {
  if (typeof value !== "string") return "";
  const email = value.trim().toLowerCase();
  const pattern = process.env.FUNCTIONS_EMULATOR === "true" ? /^[^\s@]+@[^\s@]+$/ : /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!pattern.test(email)) return "";
  return email.slice(0, 240);
}

function hasValidTargetEmail(target: CampaignTarget): boolean {
  return validEmailField(target.email).length > 0;
}

function dedupeCampaignTargetsByRecipient(targets: CampaignTarget[]): { targets: CampaignTarget[]; skipped: number } {
  const seen = new Set<string>();
  const unique: CampaignTarget[] = [];
  let skipped = 0;
  for (const target of targets) {
    const recipient = validEmailField(target.email);
    if (!recipient) {
      unique.push(target);
      continue;
    }
    if (seen.has(recipient)) {
      skipped += 1;
      continue;
    }
    seen.add(recipient);
    unique.push(target);
  }
  return { targets: unique, skipped };
}

// P0-2 [export: 노드 레인 값 검증용 — tests/campaign-deliverability-selection-filter.test.mjs]:
//   전역 도달성 캐시 판정 맵으로 대상을 둘로 나눈다. 거르는 것은 **캐시 적중 "undeliverable"뿐**이고
//   deliverable·risky·unknown·미판정(캐시 미스/만료)은 전부 통과시켜 발송 시점 Bouncer 게이트
//   (chat-ai.ts W51)로 그대로 보낸다 — 선택 시점에 벤더를 부르지 않는 대가로 "이미 증명된 것"만
//   걸러내는 것이 이 필터의 계약이다.
export function partitionTargetsByCachedDeliverability(
  targets: readonly CampaignTarget[],
  cachedStatuses: ReadonlyMap<string, MailDeliverabilityStatus>,
): { targets: CampaignTarget[]; skipped: number } {
  const kept: CampaignTarget[] = [];
  for (const target of targets) {
    if (cachedStatuses.get(validEmailField(target.email)) === "undeliverable") continue;
    kept.push(target);
  }
  return { targets: kept, skipped: targets.length - kept.length };
}

// 위 순수 분할의 배치 읽기 짝. 이메일 목록 → 해시 문서 getAll 1회(쿼리 0)로 읽기를 유계하고,
// 어떤 이유로든 캐시 읽기가 실패하면 **통과 방향**(skipped 0)으로 떨어진다 — 캐시 장애가 후보
// 선택 자체를 멈추면 안 되고, 발송 시점 게이트가 종전대로 다시 판정한다.
async function dropCachedUndeliverableTargets(
  targets: readonly CampaignTarget[],
): Promise<{ targets: CampaignTarget[]; skipped: number }> {
  if (targets.length === 0) return { targets: [...targets], skipped: 0 };
  try {
    const statuses = await readCachedMailDeliverabilityStatuses(
      targets.map((target) => target.email ?? ""),
    );
    return partitionTargetsByCachedDeliverability(targets, statuses);
  } catch (error) {
    console.warn("[campaign-targets] cached deliverability read failed — selection continues unfiltered (send-time gate still applies)", {
      errorCode: errorCodeForLog(error),
      targets: targets.length,
    });
    return { targets: [...targets], skipped: 0 };
  }
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((value) => (value ?? "").trim()).filter(Boolean))];
}

function chunkStrings(values: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function targetTouchKeys(target: CampaignTarget): string[] {
  return uniqueStrings([
    target.creatorId ? `creatorId:${target.creatorId}` : "",
    target.candidateId ? `candidateId:${target.candidateId}` : "",
    target.id ? `targetId:${target.id}` : "",
    validEmailField(target.email) ? `email:${validEmailField(target.email)}` : "",
  ]);
}

function targetDedupKeys(target: CampaignTarget): string[] {
  return uniqueStrings([
    target.creatorId ? `creator:${target.creatorId}` : "",
    validEmailField(target.email) ? `email:${validEmailField(target.email)}` : "",
    target.candidateId ? `candidate:${target.candidateId}` : "",
  ]);
}
type ProgramTargetSafetyQuarantineTelemetry = {
  skipped: number;
  readBatches: number;
  fallbackFailed: number;
  fallbackErrorCode: string | null;
  /** W78-②: 상태 의존 사유로 걸려 있다가 이메일이 생겨 격리에서 풀린 수(관측축). */
  staleQuarantineReleased?: number;
};

type ProgramTargetSafetyQuarantineRead = ProgramTargetSafetyQuarantineTelemetry & {
  blockedKeys: Set<string>;
};

type ProgramCampaignTargetCollection = ProgramTargetSafetyQuarantineTelemetry & {
  targets: CampaignTarget[];
  /** P0-2: 선택 시점에 전역 도달성 캐시(적중 undeliverable)로 걸러낸 수 — quarantine.skipped 와 별개 축. */
  deliverabilityCachedSkipped: number;
};

function emptyProgramCampaignTargetCollection(): ProgramCampaignTargetCollection {
  return {
    targets: [],
    skipped: 0,
    readBatches: 0,
    fallbackFailed: 0,
    fallbackErrorCode: null,
    deliverabilityCachedSkipped: 0,
  };
}

export function mergeProgramTargetSafetyQuarantineTelemetry(
  finalTelemetry: ProgramTargetSafetyQuarantineTelemetry,
  preparationTelemetry?: Partial<ProgramTargetSafetyQuarantineTelemetry> | null,
  options: { reusedReadBatches?: number; reusedFallbackFailures?: number } = {},
): ProgramTargetSafetyQuarantineTelemetry {
  const preparationSkipped = numberField(preparationTelemetry ?? {}, "skipped", 0);
  const preparationReadBatches = numberField(preparationTelemetry ?? {}, "readBatches", 0);
  const preparationFallbackFailed = numberField(preparationTelemetry ?? {}, "fallbackFailed", 0);
  const preparationFallbackErrorCode = stringField(preparationTelemetry ?? {}, "fallbackErrorCode", "");
  const reusedReadBatches = Math.min(
    Math.max(0, Math.round(numberField(options, "reusedReadBatches", 0))),
    finalTelemetry.readBatches,
    preparationReadBatches,
  );
  const reusedFallbackFailures = Math.min(
    Math.max(0, Math.round(numberField(options, "reusedFallbackFailures", 0))),
    finalTelemetry.fallbackFailed,
    preparationFallbackFailed,
  );
  const fallbackErrorCode = finalTelemetry.fallbackErrorCode ?? (preparationFallbackErrorCode || null);
  return {
    // readBatches/fallbackFailed are source telemetry for physical targeted queries issued by each
    // phase. Preparation and final collection call the quarantine reader independently; this path
    // does not pass preparation query results into final collection, so there is no shared evidence
    // to de-duplicate. A caller may subtract reused batches only when it can prove final collection
    // consumed the exact preparation query evidence instead of issuing its own read.
    skipped: Math.max(finalTelemetry.skipped, preparationSkipped),
    readBatches: finalTelemetry.readBatches + preparationReadBatches - reusedReadBatches,
    fallbackFailed: finalTelemetry.fallbackFailed + preparationFallbackFailed - reusedFallbackFailures,
    fallbackErrorCode,
    staleQuarantineReleased: Math.max(
      finalTelemetry.staleQuarantineReleased ?? 0,
      numberField(preparationTelemetry ?? {}, "staleQuarantineReleased", 0),
    ),
  };
}

function preferredProgramTargetQuarantineIdentity(
  target: CampaignTarget,
): { field: "candidateId" | "creatorId" | "email"; value: string } | null {
  if (target.candidateId) return { field: "candidateId", value: target.candidateId };
  if (target.creatorId) return { field: "creatorId", value: target.creatorId };
  const email = validEmailField(target.email);
  return email ? { field: "email", value: email } : null;
}

/**
 * W78-②: **상태 의존 차단 사유는 상태가 바뀌면 풀린다.**
 *
 * 격리(`program_campaign_targets.status:"blocked"`)에는 두 종류가 섞여 있다:
 *   · 수신자의 의사·도달 불가 — 반송·수신거부·불만·블랙리스트. 이건 **영구**다.
 *   · **우리 쪽 상태** — 그때 이메일이 없었거나 발신 신원이 확인 안 됐다. 조건이지 의사가 아니다.
 *
 * 실측(리더 감사): 창에 든 미발송 128명 중 112명이 blocked 였다. 이메일이 없던 시절의 잔재가
 * 이메일이 채워진 뒤에도 격리로 남아, 만들어 둔 재고가 발송으로 가지 못한다.
 *
 * 그래서 **이 목록의 사유만**, 그리고 **지금 유효한 이메일이 있을 때만** 격리에서 뺀다.
 * 푼다고 발송이 되는 게 아니다 — suppression·dedup·safety 체인은 그 뒤에 그대로 전부 돈다.
 * 여기서 정하는 것은 "비싼 평가 대상에 넣을지"뿐이다.
 *
 * ⚠️ 이 목록은 **프로드 실측 분포로 확정했다**(첫 시도는 사유명을 추측해서 해제 0이었다).
 * 감사 시점 blocked 2,395건:
 *   mail-quality.w14_pending_verification   2,142  ← **해제 대상 아님**(아래 정정 참고).
 *   mail-safety.role-account                  149  ← 정책 판정(info@ 등). 유지.
 *   mail-safety.outbound-lock                  36  ← 발신 잠금. 유지.
 *   mail-quality.email_missing                 36  ← 이메일 없음(전원 미보유). 상태.
 *   mail-quality.no_mx / no_mx_after_repair    18  ← 도달 불가 실측. 유지.
 *   mail-quality.invalid_after_w19_extract     11  ← 추출 결과 무효. 유지.
 *   mail-safety.game-company-blacklist          2  ← 유지.
 *   mail-safety.complaint-keyword               1  ← 유지.
 *
 * ⚠️ **정정(R1-P0-B)**: 처음에는 w14_pending_verification 2,142 도 "보류"로 보고 풀었다.
 *   리뷰 실측으로 그 해석이 틀렸다 — 그 코드는 08-04 일괄 마킹이고, **08-10 전용 해제 레인이
 *   이미 Bouncer 실검증으로 ~1,687 을 풀었다.** 남은 2,142 는 기발송 2,076 + undeliverable 판정
 *   64 다. 즉 "보류"가 아니라 사유 코드 오버로드였고, 풀어도 이득이 0인데(실측 해제 35 →
 *   sendable 0) 매 pass 재해제로 평가 예산만 잠식한다. 그래서 이 축은 뺐다.
 *
 * 남은 것은 **"이메일 없음"(36건)** 하나다. 이건 그때 우리에게 주소가 없었다는 상태이고,
 * 이메일이 채워지면 차단 근거가 사라진다. 풀어도 suppression·safety·품질 체인이 뒤에서
 * 다시 판정한다. 도달 불가·역할 계정·발신 잠금·블랙리스트·불만은 **판정**이므로 안 건드린다.
 */
const RELEASABLE_STALE_TARGET_BLOCK_REASONS: ReadonlySet<string> = new Set([
  "mail-quality.email_missing",
]);

export function addBlockedProgramTargetKeys(
  blockedKeys: Set<string>,
  programId: string,
  docs: readonly QueryDocumentSnapshot[],
  /**
   * W78-②: 지금 유효한 이메일을 가진 dedup 키 집합. 상태 의존 사유는 이 집합에 있을 때만 푼다.
   *   넘기지 않으면 종전 동작 그대로다(전부 격리) — 기존 호출부 무변경.
   */
  emailCapableKeys?: ReadonlySet<string>,
): { released: number } {
  let released = 0;
  for (const doc of docs) {
    const data = doc.data() ?? {};
    if (stringField(data, "programId", "") !== programId || stringField(data, "status", "") !== "blocked") continue;
    const keys = targetDedupKeys(campaignTargetFromProgramTargetDoc(doc));
    const reason = stringField(data, "blockedReason", "");
    if (
      emailCapableKeys
      && RELEASABLE_STALE_TARGET_BLOCK_REASONS.has(reason)
      // emailCapableKeys 는 **지금 유효한 이메일을 가진 대상만으로** 만들어진다
      //   (readProgramTargetSafetyQuarantine 에서 그렇게 채운다). 그래서 어떤 축으로 겹치든
      //   "그 사람은 지금 이메일이 있다"가 성립한다. 낡은 blocked 문서의 email 필드는
      //   비어 있을 수 있으므로 candidate/creator 축으로도 이어져야 한다.
      && keys.some((key) => emailCapableKeys.has(key))
    ) {
      // 상태가 바뀌었다(이메일이 생겼다). 격리에서 빼고 정상 평가 체인으로 보낸다 —
      //   suppression·dedup·safety 가 그 뒤에서 다시 판정한다.
      released += 1;
      continue;
    }
    for (const key of keys) blockedKeys.add(key);
  }
  return { released };
}

/**
 * W7-1: a broad program-target window cannot prove that a campaign candidate is not quarantined:
 * ready rows can fill the limit before a blocked row. Reuse a complete broad snapshot at zero extra
 * reads; otherwise query only the bounded selection window by its preferred stable identity.
 */
async function readProgramTargetSafetyQuarantine(
  programId: string,
  targets: CampaignTarget[],
  options: {
    knownDocs?: readonly QueryDocumentSnapshot[];
    knownSnapshotComplete?: boolean;
  } = {},
): Promise<ProgramTargetSafetyQuarantineRead> {
  const blockedKeys = new Set<string>();
  // W78-②: 지금 유효한 이메일을 가진 대상의 dedup 키. 상태 의존 차단 사유는 이 집합에서만 푼다.
  const emailCapableKeys = new Set<string>();
  for (const target of targets) {
    if (!validEmailField(target.email)) continue;
    for (const key of targetDedupKeys(target)) emailCapableKeys.add(key);
  }
  let staleQuarantineReleased = 0;
  staleQuarantineReleased += addBlockedProgramTargetKeys(
    blockedKeys, programId, options.knownDocs ?? [], emailCapableKeys,
  ).released;
  let readBatches = 0;
  let fallbackFailed = 0;
  let fallbackErrorCode: string | null = null;

  if (options.knownSnapshotComplete !== true) {
    const targetedBlockedKeys = new Set<string>();
    try {
      const valuesByField = new Map<"candidateId" | "creatorId" | "email", string[]>();
      for (const target of targets) {
        if (targetDedupKeys(target).some((key) => blockedKeys.has(key))) continue;
        const identity = preferredProgramTargetQuarantineIdentity(target);
        if (!identity) continue;
        valuesByField.set(identity.field, [...(valuesByField.get(identity.field) ?? []), identity.value]);
      }
      // W57-F2: 필드별 × 청크 직렬 배치(프로드 실측 pass 당 37배치)를 유계 병렬로 편다.
      // readBatches 는 종전과 같은 의미(발행한 쿼리 수)로 계속 센다 — 관측 계약 무변경.
      const batches = await Promise.all([...valuesByField.entries()].map(([field, rawValues]) => runChunkedEvidenceQueries(
        rawValues,
        "evidence_safety_quarantine",
        async (values) => {
          readBatches += 1;
          return (await adminDb.collection(PROGRAM_CAMPAIGN_TARGETS_COLLECTION)
            .where("programId", "==", programId)
            .where(field, "in", values)
            .get()).docs;
        },
      )));
      staleQuarantineReleased += addBlockedProgramTargetKeys(
        targetedBlockedKeys, programId, batches.flat(), emailCapableKeys,
      ).released;
      for (const key of targetedBlockedKeys) blockedKeys.add(key);
    } catch (error) {
      // TRAIN31 M4: this fallback is the first composite query on program_campaign_targets and production
      // has no matching index. Keep the complete/limited broad snapshot as the safe degraded result instead
      // of killing the whole wave; partial targeted results are deliberately discarded.
      fallbackFailed = 1;
      fallbackErrorCode = errorCodeForLog(error);
      console.warn("[campaign-auto-refill] safety quarantine fallback query failed", {
        programId,
        errorCode: fallbackErrorCode,
      });
    }
  }

  return {
    blockedKeys,
    staleQuarantineReleased,
    skipped: targets.filter((target) => targetDedupKeys(target).some((key) => blockedKeys.has(key))).length,
    readBatches,
    fallbackFailed,
    fallbackErrorCode,
  };
}


function dedupKeyToTouchKey(creatorKey: string): string {
  if (creatorKey.startsWith("creator:")) return `creatorId:${creatorKey.slice("creator:".length)}`;
  if (creatorKey.startsWith("candidate:")) return `candidateId:${creatorKey.slice("candidate:".length)}`;
  if (creatorKey.startsWith("email:")) return creatorKey;
  return "";
}

// W15 [사용자 확정 2026-08-03]: 기컨택 차단을 전역이 아니라 **프로그램 스코프**로 집행한다. 증거 행이
// 이 프로그램 귀속이면 플래그와 무관하게 계속 차단하고(같은 프로그램 이중 발송 방지), 타 프로그램
// 귀속이면 allowResendInProgram 캠페인에 한해 차단하지 않는다. 현 프로그램을 정규화할 수 없으면
// 안전측(전역 차단)으로 남는다.
// 적대 리뷰 2026-09-16 MEDIUM 수리: programId 가 없는 레거시 행의 귀속 규칙을 programOutreachDedup.ts
// outreachRowMatchesScope와 통일했다 — "프로그램 없음"이 아니라 DEFAULT_PROGRAM_ID("scp")로 본다
// (아래 outreachEvidenceProgramId). 종전에는 이 파일만 레거시 행을 "귀속 없음"으로 취급해(위 W15
// 결정 당시의 구현) 같은 행이 발송 워커(chat-ai.ts)에서는 "scp" 프로그램 재발송으로 차단되면서
// refill 사전 필터(이 파일)에서는 차단되지 않는 fork가 있었다 — 판정 fork 금지 규율 위반이라 통일한다.
function outreachEvidenceInProgram(evidenceProgramId: string, programId: string): boolean {
  const canonical = resolveCanonicalProgramId(programId);
  if (!canonical) return true;
  return resolveCanonicalProgramId(evidenceProgramId) === canonical;
}

function outreachEvidenceProgramId(data: Record<string, unknown>): string {
  // DEFAULT_PROGRAM_ID 귀속 규칙은 programOutreachDedup.ts outreachRowMatchesScope와 동일 — 두 곳
  // 다 "programId 필드가 없는 레거시 행은 DEFAULT_PROGRAM_ID('scp')로 귀속"으로 통일한다.
  return stringField(data, "canonicalProgramId", stringField(data, "programId", "")) || DEFAULT_PROGRAM_ID;
}

// P0-2 [export]: 노드 레인에서 "skipped_undeliverable 행이 touch 키를 만든다"를 Firestore 없이
//   값으로 검증한다(tests/campaign-deliverability-selection-filter.test.mjs) — 이 키가 있어야
//   filterUntouchedCampaignTargets 의 기컨택 판정이 그 이메일을 차단한다.
export function addOutreachTouchKeys(out: Set<string>, data: Record<string, unknown>) {
  if (!CAMPAIGN_OUTREACH_TOUCH_STATES.has(stringField(data, "deliveryState", stringField(data, "status", "")))) return;
  const creatorId = stringField(data, "creatorId", "");
  const candidateId = stringField(data, "candidateId", "");
  const targetId = stringField(data, "targetId", "");
  const email = validEmailField(data.creatorEmail) || validEmailField(data.to);
  if (creatorId) out.add(`creatorId:${creatorId}`);
  if (candidateId) out.add(`candidateId:${candidateId}`);
  if (targetId) out.add(`targetId:${targetId}`);
  if (email) out.add(`email:${email}`);
}

function addMessageSourceTouchKeys(out: Set<string>, data: Record<string, unknown>) {
  const creatorId = stringField(data, "creatorId", "");
  const candidateId = stringField(data, "candidateId", "");
  const targetId = stringField(data, "targetId", "");
  const email = validEmailField(data.creatorEmail) || validEmailField(data.to) || validEmailField(data.email);
  if (creatorId) out.add(`creatorId:${creatorId}`);
  if (candidateId) out.add(`candidateId:${candidateId}`);
  if (targetId) out.add(`targetId:${targetId}`);
  if (email) out.add(`email:${email}`);
}

type OutreachTouchEvidence = { touched: Set<string>; sameProgram: Set<string> };

async function readMessageSourceOutreachTouchKeys(
  targets: CampaignTarget[],
  dedupContext: { programId: string; allowResendInProgram: boolean },
): Promise<OutreachTouchEvidence> {
  const touched = new Set<string>();
  const sameProgram = new Set<string>();
  const emails = uniqueStrings(targets.map((target) => validEmailField(target.email)));
  if (emails.length === 0) return { touched, sameProgram };
  const sourcesByPath = new Map<string, Record<string, unknown>>();
  // W57-F2: 3개 필드 × 청크가 직렬이었다. 필드 간에도 의존이 없으므로 한 번에 유계 병렬로 편다.
  const sourceDocs = await Promise.all(["to", "creatorEmail", "email"].map((field) => runChunkedEvidenceQueries(
    emails,
    "evidence_message_sources",
    async (values, limit) => (await boundedEvidenceQuery(adminDb.collection("message_sources")
      .where(field, "in", values)
      .select("creatorId", "candidateId", "targetId", "creatorEmail", "to", "email"), limit)
      .get()).docs,
  )));
  for (const doc of sourceDocs.flat()) sourcesByPath.set(doc.ref.path, doc.data() ?? {});
  const messageRefs = [...sourcesByPath.keys()];
  const outreachDocs = await runChunkedEvidenceQueries(
    messageRefs,
    "evidence_message_ref_outreach",
    async (values, limit) => (await boundedEvidenceQuery(adminDb.collection("campaign_outreach")
      .where("messageRef", "in", values)
      .select("deliveryState", "status", "creatorId", "candidateId", "targetId", "creatorEmail", "to", "messageRef", "canonicalProgramId", "programId"), limit)
      .get()).docs,
  );
  for (const doc of outreachDocs) {
    const row = doc.data() ?? {};
    if (!CAMPAIGN_OUTREACH_TOUCH_STATES.has(stringField(row, "deliveryState", stringField(row, "status", "")))) continue;
    addOutreachTouchKeys(touched, row);
    const messageSource = sourcesByPath.get(stringField(row, "messageRef", "")) ?? {};
    addMessageSourceTouchKeys(touched, messageSource);
    if (outreachEvidenceInProgram(outreachEvidenceProgramId(row), dedupContext.programId)) {
      addOutreachTouchKeys(sameProgram, row);
      addMessageSourceTouchKeys(sameProgram, messageSource);
    }
  }
  return { touched, sameProgram };
}

async function readExistingOutreachTouchKeys(
  targets: CampaignTarget[],
  dedupContext: { programId: string; allowResendInProgram: boolean },
): Promise<OutreachTouchEvidence> {
  const touched = new Set<string>();
  const sameProgram = new Set<string>();
  const queries: Array<{ field: string; values: string[] }> = [
    { field: "creatorId", values: uniqueStrings(targets.map((target) => target.creatorId)) },
    { field: "candidateId", values: uniqueStrings(targets.map((target) => target.candidateId)) },
    { field: "targetId", values: uniqueStrings(targets.map((target) => target.id)) },
    { field: "creatorEmail", values: uniqueStrings(targets.map((target) => validEmailField(target.email))) },
    { field: "to", values: uniqueStrings(targets.map((target) => validEmailField(target.email))) },
  ];
  // W57-F2: 5개 필드 × 청크 직렬(스캔 717 → 약 360왕복)이 pass 비용의 최대 항이었다.
  const rows = await Promise.all(queries.map((query) => runChunkedEvidenceQueries(
    query.values,
    "evidence_outreach_touch",
    async (values, limit) => (await boundedEvidenceQuery(adminDb.collection("campaign_outreach")
      .where(query.field, "in", values)
      .select("deliveryState", "status", "creatorId", "candidateId", "targetId", "creatorEmail", "to", "canonicalProgramId", "programId"), limit)
      .get()).docs,
  )));
  for (const doc of rows.flat()) {
    const row = doc.data() ?? {};
    addOutreachTouchKeys(touched, row);
    if (outreachEvidenceInProgram(outreachEvidenceProgramId(row), dedupContext.programId)) {
      addOutreachTouchKeys(sameProgram, row);
    }
  }
  const messageSourceTouched = await readMessageSourceOutreachTouchKeys(targets, dedupContext);
  for (const key of messageSourceTouched.touched) touched.add(key);
  for (const key of messageSourceTouched.sameProgram) sameProgram.add(key);
  return { touched, sameProgram };
}

async function readProgramOutreachDedupTouchKeys(
  targets: CampaignTarget[],
  dedupContext: { programId: string; allowResendInProgram: boolean },
): Promise<OutreachTouchEvidence> {
  const touched = new Set<string>();
  const sameProgram = new Set<string>();
  const creatorKeys = uniqueStrings(targets.flatMap((target) => targetDedupKeys(target)));
  if (creatorKeys.length === 0) return { touched, sameProgram };

  const dedupDocs = await runChunkedEvidenceQueries(
    creatorKeys,
    "evidence_program_dedup",
    async (values, limit) => (await boundedEvidenceQuery(
      adminDb.collection("program_outreach_dedup").where("creatorKey", "in", values), limit,
    ).get()).docs,
  );
  for (const doc of dedupDocs) {
    const data = doc.data() ?? {};
    const creatorKey = stringField(data, "creatorKey", "");
    const touchKey = dedupKeyToTouchKey(creatorKey);
    if (!touchKey) continue;
    touched.add(touchKey);
    // doc id 자체가 `{programId}__{creatorKey}` 라, 필드가 비어 있어도 귀속을 읽을 수 있다.
    const evidenceProgramId = stringField(data, "programId", "") || doc.id.split("__")[0];
    if (outreachEvidenceInProgram(evidenceProgramId, dedupContext.programId)) sameProgram.add(touchKey);
  }

  return { touched, sameProgram };
}

async function readColdmailHistoryTouchKeys(
  targets: CampaignTarget[],
  dedupContext: { programId: string; allowResendInProgram: boolean },
): Promise<OutreachTouchEvidence> {
  const touched = new Set<string>();
  const sameProgram = new Set<string>();
  const emails = uniqueStrings(targets.map((target) => validEmailField(target.email)));
  const historyDocs = await runChunkedEvidenceQueries(
    emails,
    "evidence_coldmail_history",
    async (values, limit) => (await boundedEvidenceQuery(
      adminDb.collection("scp_coldmail_history").where("emailLower", "in", values), limit,
    ).get()).docs,
  );
  for (const doc of historyDocs) {
    const data = doc.data() ?? {};
    const email = validEmailField(data.emailLower) || validEmailField(data.email) || validEmailField(data.to);
    if (!email) continue;
    const touchKey = `email:${email}`;
    touched.add(touchKey);
    if (outreachEvidenceInProgram(outreachEvidenceProgramId(data), dedupContext.programId)) sameProgram.add(touchKey);
  }
  return { touched, sameProgram };
}

// W57-F3 [프로드 실측 2026-08-08]: 한 create-wave 안에서 이 판정이 최대 8회 돈다
// (selectUntouchedEvaluationWindow 루프 5 + 준비 1 + 웨이브 경계 1 + 최종 게이트 1). 매번 **같은**
// 증거를 처음부터 다시 읽어 왕복이 8배로 곱해졌다. 이미 판정이 끝난 touch key 를 pass 스코프로
// 기억해 두 번째 호출부터는 미해결 키를 가진 대상만 조회한다.
//
// ⚠️ 안전성: 캐시는 **행 쓰기 이전 읽기 구간에서만** 유효하다. 캐시가 살아 있는 동안 새 outreach 행이
// 커밋되면 낡은 "미접촉" 판정이 남을 수 있으므로, 캠페인 생성 진입점에서 1회 생성하고 그 호출이
// 끝나면 버린다(수명 = 한 번의 create-wave). 정책·술어는 무접촉이다 — 조회 범위만 줄인다.
type TouchEvidenceCache = {
  // 미바인딩(스코프만 열린 상태)에서는 null 이다 — 확정 컨텍스트를 아직 모른다는 뜻.
  programId: string | null;
  allowResendInProgram: boolean | null;
  // key → 차단 여부. 조회했으나 증거가 없던 키는 false 로 기록해 재조회를 막는다.
  resolved: Map<string, boolean>;
};

function touchCacheUsable(
  cache: TouchEvidenceCache | undefined,
  dedupContext: { programId: string; allowResendInProgram: boolean },
): cache is TouchEvidenceCache {
  // 컨텍스트가 다르면 차단 근거 집합(sameProgram vs touched)이 달라진다 — 재사용 금지.
  if (cache === undefined) return false;
  const usable = cache.programId === dedupContext.programId
    && cache.allowResendInProgram === dedupContext.allowResendInProgram;
  if (!usable) {
    // W57-M1 [독립 리뷰 2026-08-08]: 캐시가 조용히 no-op 이 되는 것이 이 수리의 실패 모드였다
    // (별칭 캠페인에서 호출부 키=원본 programId, 실사용부 키=canonicalProgramId 로 어긋났다).
    // 성능만 잃고 정합성은 안전측이라 던지지 않되, 무증상으로 두지도 않는다.
    console.warn("[campaign-refill] touch evidence cache context mismatch — cache disabled for this call", {
      cacheProgramId: cache.programId,
      requestedProgramId: dedupContext.programId,
      cacheAllowResendInProgram: cache.allowResendInProgram,
      requestedAllowResendInProgram: dedupContext.allowResendInProgram,
    });
  }
  return usable;
}

// 수명 관리는 F4 의 마감과 같은 모듈 스코프 패턴이다 — 호출부 8곳의 시그니처를 건드리지 않고
// **한 번의 create-wave** 로 수명을 묶는다.
// ⚠️ 겹친 pass 의 상호 오염은 실행 모델로 막는다 — processCampaignOutreachQueue 는 W57-C1 로
// maxInstances:1 + concurrency:1 이라 한 인스턴스에 요청이 하나뿐이다(index.ts).
let currentTouchEvidenceCache: TouchEvidenceCache | null = null;

// 스코프만 연다. **키 바인딩은 하지 않는다** — 확정 컨텍스트(canonicalProgramId · 요청 기준
// allowResendInProgram)는 createCampaignWithPreparedTargets 안에서야 정해지기 때문이다.
export async function withTouchEvidenceCache<T>(operation: () => Promise<T>): Promise<T> {
  const previous = currentTouchEvidenceCache;
  currentTouchEvidenceCache = { programId: null, allowResendInProgram: null, resolved: new Map() };
  try {
    return await operation();
  } finally {
    currentTouchEvidenceCache = previous;
  }
}

// W57-M1: 확정 지점에서 키를 못박는다. 컨텍스트가 바뀌면 판정 근거가 달라지므로 항목을 버린다.
export function bindTouchEvidenceCacheContext(dedupContext: { programId: string; allowResendInProgram: boolean }): void {
  const cache = currentTouchEvidenceCache;
  if (!cache) return;
  if (cache.programId === dedupContext.programId && cache.allowResendInProgram === dedupContext.allowResendInProgram) return;
  cache.programId = dedupContext.programId;
  cache.allowResendInProgram = dedupContext.allowResendInProgram;
  cache.resolved.clear();
}
// W15: live-send prior-contact 정책은 **프로그램 스코프**다. allowResendInProgram 캠페인은 같은 프로그램
// 귀속 증거로만 차단하고(이중 발송 방지), 타 프로그램·레거시(programId 없음) 증거는 차단하지 않는다.
// 플래그가 없거나 false 면 종전과 동일한 전역 차단이다. suppression·킬스위치·infly 게이트는 무관한
// 별개 레이어로 종전대로 전부 집행된다.
// export: 예산 절단 시의 **fail-closed 판정**을 노드 레인에서 값으로 확인하기 위해(예산이 0 이면
//   증거 쿼리가 발행조차 되지 않으므로 Firestore 없이 이 경로 전체가 돈다).
export async function filterUntouchedCampaignTargets(
  targets: CampaignTarget[],
  dedupContext: { programId: string; allowResendInProgram: boolean },
  cache: TouchEvidenceCache | undefined = currentTouchEvidenceCache ?? undefined,
): Promise<{ targets: CampaignTarget[]; skipped: number }> {
  if (targets.length === 0) return { targets, skipped: 0 };
  const usableCache = touchCacheUsable(cache, dedupContext) ? cache : undefined;
  // 캐시에 이미 "차단"으로 기록된 대상은 조회 없이 탈락시키고, 전 키가 "미차단"으로 확정된 대상도
  // 조회에서 뺀다. 어느 키든 미해결이면 종전대로 증거를 읽는다(판정 누락 없음).
  const needsQuery: CampaignTarget[] = [];
  const cachedFresh = new Set<CampaignTarget>();
  for (const target of targets) {
    const keys = targetTouchKeys(target);
    if (!usableCache) { needsQuery.push(target); continue; }
    if (keys.some((key) => usableCache.resolved.get(key) === true)) continue; // 캐시 확정 차단 — 조회 불요
    else if (keys.length > 0 && keys.every((key) => usableCache.resolved.has(key))) cachedFresh.add(target);
    else needsQuery.push(target);
  }
  const blocking = new Set<string>();
  if (needsQuery.length > 0) {
    const evidence = await Promise.all([
      readExistingOutreachTouchKeys(needsQuery, dedupContext),
      readProgramOutreachDedupTouchKeys(needsQuery, dedupContext),
      readColdmailHistoryTouchKeys(needsQuery, dedupContext),
    ]);
    for (const source of evidence) {
      for (const key of dedupContext.allowResendInProgram ? source.sameProgram : source.touched) blocking.add(key);
    }
    // T4-1 fail-closed [2026-09-05 적대 리뷰]: 예산 때문에 증거 조회가 잘렸으면 이 대상들이
    //   **미접촉이라는 것을 증명하지 못한다.** 그대로 통과시키면 이미 컨택한 크리에이터에게 다시
    //   콜드메일이 나간다(예산 초과의 대가가 "덜 읽음"이 아니라 "중복 발송"이 된다).
    //   캐시에도 쓰지 않는다 — false(미접촉) 로 굳으면 이 pass 내내 같은 오판이 재사용된다.
    if (evidenceReadBudgetTruncated()) {
      return { targets: [], skipped: targets.length };
    }
    if (usableCache) {
      // 이번에 조회한 대상의 키는 전부 판정이 끝났다 — 차단이면 true, 증거 없으면 false 로 확정한다.
      for (const target of needsQuery) {
        for (const key of targetTouchKeys(target)) usableCache.resolved.set(key, blocking.has(key));
      }
    }
  }
  const queriedFresh = new Set(needsQuery.filter((target) => !targetTouchKeys(target).some((key) => blocking.has(key))));
  const fresh = targets.filter((target) => cachedFresh.has(target) || queriedFresh.has(target));
  return { targets: fresh, skipped: targets.length - fresh.length };
}

/**
 * R33-2 [운영 정체의 진범 수리]: 비싼 평가(suppression·mail-safety)에 넣을 **평가 창**을 기컨택이
 * 아닌 후보로 채운다.
 *
 * 왜 필요한가: 준비 경로는 email-ready 목록을 `slice(0, evaluationBound)` 로 잘라 평가했고, 기컨택
 * 판정은 **그 뒤**에 있었다. 스캔 앞머리에는 기컨택이 몰린다 — R33-3 [INFO-1 리뷰 정정]: 컨택이
 * candidate_pool 문서를 갱신하기 때문이 아니라(컨택 경로의 candidate_pool 쓰기는 0건이다),
 * **풀이 정체되면 `updatedAtIso desc` 정렬이 동결돼 매 pass 같은 앞머리부터 다시 시작**하고 그
 * 구간이 컨택을 거듭할수록 포화되기 때문이다. 기컨택 수가 예산을 넘는 순간 창이 전부 기컨택으로 차서
 * 미컨택 후보가 아무리 많아도 준비가 영구 0건이 된다(운영: 기컨택 292 · 미컨택 ~1,400 · 준비 85 고정).
 *
 * 정책은 바꾸지 않는다 — 같은 filterUntouchedCampaignTargets 를 그대로 쓰고, 뒤 단계의 dedup·
 * suppression·상한·승인은 전부 종전대로 다시 집행된다. 바뀌는 것은 "무엇을 비싼 평가에 넣는가"의
 * 순서뿐이다. 스캔량은 청크 상한(PREPARE_UNTOUCHED_WINDOW_MAX_CHUNKS × bound)으로 유계다(COST-P0).
 */
const PREPARE_UNTOUCHED_WINDOW_MAX_CHUNKS = 5;

/**
 * W78-①③ — **평가 시작점을 pass 마다 전진시킨다(회전 커서).**
 *
 * R33-2 가 "예산을 미컨택으로 채운다"까지 고쳤는데도 운영에서 sendable 0 이 났다. 실측:
 *   스캔 3,827 → 평가 창(최신순 2,000)의 94%가 기발송자 → 창에 든 미발송 128 → 격리 112 →
 *   sendable 0 · **evaluationTruncated 1,827**.
 * 원인은 창을 채우는 방식이 아니라 **매 pass 같은 앞머리에서 다시 시작한다**는 데 있다.
 * `updatedAtIso desc` 정렬은 컨택으로 갱신되지 않으므로(R33-3) 앞머리가 고정이고, 그 구간이
 * 기발송자로 포화되면 뒤쪽 미발송자는 청크 상한에 막혀 **영원히 읽히지 않는다**.
 * 절단량 1,827 이 매 pass 같은 사람들이라는 뜻이다.
 *
 * 그래서 시작 오프셋을 원장에 남기고 다음 pass 가 **그 다음부터** 본다. 한 바퀴 돌면 감는다.
 * 읽기는 늘지 않는다 — 이미 메모리에 있는 배열을 회전시킬 뿐이다(COST-P0 무변경).
 * 게이트는 하나도 안 건드린다: 무엇을 **먼저** 평가할지의 순서만 바꾼다.
 */
const PREPARE_ROTATION_STATE_COLLECTION = "program_prepare_state";

export function rotateEvaluationOrder<T>(items: readonly T[], offset: number): T[] {
  if (items.length === 0) return [];
  const start = ((Math.trunc(offset) % items.length) + items.length) % items.length;
  if (start === 0) return [...items];
  return [...items.slice(start), ...items.slice(0, start)];
}

function prepareRotationStateId(programId: string, campaignId: string): string {
  // P1-D: 같은 프로그램에 캠페인이 둘이면 programId 단독 키는 서로의 순번을 덮어쓴다.
  //   두 캠페인이 번갈아 돌면 각자 창이 무작위로 튀어 커버리지 보장이 깨진다.
  return campaignId ? `${programId}__${campaignId}` : programId;
}

async function readPrepareRotationOffset(stateId: string): Promise<number> {
  try {
    const snapshot = await adminDb.collection(PREPARE_ROTATION_STATE_COLLECTION).doc(stateId).get();
    const value = Number((snapshot.data() ?? {}).evaluationRotationOffset);
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
  } catch {
    // 커서를 못 읽으면 종전 동작(앞머리부터)으로 떨어진다 — 열리는 방향으로 실패하지 않는다.
    return 0;
  }
}

async function writePrepareRotationOffset(stateId: string, offset: number, nowIsoValue: string): Promise<void> {
  try {
    await adminDb.collection(PREPARE_ROTATION_STATE_COLLECTION).doc(stateId).set({
      id: stateId,
      evaluationRotationOffset: Math.max(0, Math.trunc(offset)),
      updatedAtIso: nowIsoValue,
    }, { merge: true });
  } catch {
    // 커서 쓰기 실패가 준비를 실패시키면 안 된다. 다음 pass 가 같은 자리에서 다시 볼 뿐이다.
  }
}

/**
 * Preparation joins campaign-scoped discovery rows before their email shape is known, so it
 * deliberately pages by document id rather than reusing the live refill's email cursor.  Keep
 * this state on the existing program/campaign preparation ledger; the stage-keyed map prevents a
 * future stage from resuming a cursor produced for `discovered`.
 */
async function readPrepareCampaignCandidateCursor(stateId: string, stage: string): Promise<string> {
  try {
    const snapshot = await adminDb.collection(PREPARE_ROTATION_STATE_COLLECTION).doc(stateId).get();
    const state = snapshot.data() ?? {};
    const cursors = isRecord(state.campaignCandidateScanCursor)
      ? state.campaignCandidateScanCursor as Record<string, unknown>
      : {};
    return stringField(cursors, stage, "");
  } catch {
    // A missing/unreadable cursor preserves the former first-window behavior; it must not make
    // preparation fail or relax any eligibility gate.
    return "";
  }
}

async function writePrepareCampaignCandidateCursor(
  stateId: string,
  stage: string,
  cursor: string,
  nowIsoValue: string,
): Promise<void> {
  try {
    await adminDb.collection(PREPARE_ROTATION_STATE_COLLECTION).doc(stateId).set({
      id: stateId,
      campaignCandidateScanCursor: { [stage]: cursor },
      updatedAtIso: nowIsoValue,
    }, { merge: true });
  } catch {
    // Cursor persistence is a fairness enhancement.  A transient write failure may re-read one
    // window, but must never turn a preparation into a failed or more permissive operation.
  }
}

async function selectUntouchedEvaluationWindow(
  candidates: CampaignTarget[],
  bound: number,
  dedupContext: { programId: string; allowResendInProgram: boolean },
): Promise<{ targets: CampaignTarget[]; scanned: number; skipped: number }> {
  if (bound <= 0 || candidates.length === 0) return { targets: [], scanned: 0, skipped: 0 };
  const picked: CampaignTarget[] = [];
  let scanned = 0;
  let skipped = 0;
  for (
    let chunk = 0;
    chunk < PREPARE_UNTOUCHED_WINDOW_MAX_CHUNKS && scanned < candidates.length && picked.length < bound;
    chunk += 1
  ) {
    const slice = candidates.slice(scanned, scanned + bound);
    if (slice.length === 0) break;
    scanned += slice.length;
    const untouched = await filterUntouchedCampaignTargets(slice, dedupContext);
    skipped += untouched.skipped;
    for (const target of untouched.targets) {
      if (picked.length >= bound) break;
      picked.push(target);
    }
  }
  return { targets: picked, scanned, skipped };
}

function numberField(record: Record<string, unknown>, key: string, fallback = 0): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

async function recalculateLlmUsageSharesInFirestore(): Promise<Record<string, unknown>[]> {
  const rows: Array<{ ref: DocumentReference; id: string; data: Record<string, unknown>; costKRW: number }> = [];
  await forEachCollectionPage("llm_usage", (docs) => {
    for (const doc of docs) {
      const data = doc.data();
      rows.push({ ref: doc.ref, id: doc.id, data, costKRW: numberField(data, "costKRW", 0) });
    }
  });
  const totalCost = rows.reduce((sum, row) => sum + row.costKRW, 0);
  const writes = rows.map((row) => (batch: ReturnType<typeof adminDb.batch>) => {
    const share = totalCost === 0 ? 0 : Math.round((row.costKRW / totalCost) * 100);
    batch.set(row.ref, { id: row.id, share, updatedAtIso: nowIso() }, { merge: true });
    row.data = { ...row.data, id: row.id, share };
  });
  await commitInChunks(writes);
  return rows.map((row) => row.data);
}

function campaignTargetFromCreatorDoc(doc: QueryDocumentSnapshot): CampaignTarget {
  const data = doc.data();
  return {
    id: doc.id,
    creatorId: stringField(data, "id", doc.id),
    name: stringField(data, "name", stringField(data, "handle", doc.id)),
    email: validEmailField(data.email) || undefined,
    handle: stringField(data, "handle", "") || undefined,
    youtubeUrl: normalizePublicYouTubeChannelUrl(
      stringField(data, "youtubeUrl", stringField(data, "channelUrl", stringField(data, "profileUrl", ""))),
    ) || undefined,
    avatar: avatarField(data) || undefined,
    platform: stringField(data, "platform", "YouTube") || undefined,
    followers: numberField(data, "followers", 0) || undefined,
    region: stringField(data, "region", "") || undefined,
    category: stringField(data, "category", "") || undefined,
    source: "managed" as const,
  };
}

function globalCandidateIdentityFromCandidateDoc(doc: QueryDocumentSnapshot): Record<string, unknown> {
  return globalCandidateIdentityData({
    ...doc.data(),
    id: doc.id,
    candidateId: doc.id,
    candidateRef: doc.ref.path,
  });
}

// T3: 점수 탑재 계약을 값으로 단정하기 위해 노출한다.
// R17-5 [W9-4]: candidate_pool 을 `updatedAtIso desc` 로 훑으면 **최신 구간이 커뮤니티 시그널
// 레코드**다 — communitySearch.ts 의 candidateFromResult 가 `email: null`·`region: "GLOBAL"` 을
// 하드코딩하므로 구조상 이메일이 존재할 수 없다. 이 값들이 컬렉션 전체에서 가장 최신이라 작은 스캔은
// 항상 이 밴드부터 때리고, 결과적으로 emailReady 가 0 에 가까워진다(운영 실측: 스캔 60 →
// emailReady 3 / 스캔 1000 → 722).
//
// 밴드를 **후순위로 밀고** 정렬 밖 폴백 결과에서 남은 자리를 채운다. 두 질의는 이미 존재하므로
// **읽기 횟수는 그대로**이고, 같은 스캔 폭에서 유효 후보 수만 늘어난다. 배제(delete)가 아니라
// 후순위인 이유: 이 레코드도 나중에 백필로 이메일이 붙을 수 있고, 풀 자체는 전역 설계다.
const COMMUNITY_SIGNAL_SOURCE_MARKERS = new Set(["public-community-search", "community-public-search"]);

function isEmailIncapableCommunitySignal(doc: QueryDocumentSnapshot): boolean {
  const data = doc.data() ?? {};
  // 이메일이 이미 붙어 있으면 밴드가 아니다(백필이 채운 레코드를 후순위로 밀지 않는다).
  if (validEmailField(data.email)) return false;
  return COMMUNITY_SIGNAL_SOURCE_MARKERS.has(stringField(data, "source", ""))
    || COMMUNITY_SIGNAL_SOURCE_MARKERS.has(stringField(data, "discoverySource", ""));
}

/** 후순위화 결과와 밴드 규모를 함께 돌려준다 — 규모가 보이지 않으면 운영자는 원인을 못 짚는다. */
function prioritizeEmailCapableCandidateDocs(
  docs: QueryDocumentSnapshot[],
  scanLimit: number,
): { docs: QueryDocumentSnapshot[]; deprioritized: number } {
  const capable: QueryDocumentSnapshot[] = [];
  const band: QueryDocumentSnapshot[] = [];
  for (const doc of docs) (isEmailIncapableCommunitySignal(doc) ? band : capable).push(doc);
  return { docs: [...capable, ...band].slice(0, scanLimit), deprioritized: band.length };
}

export function campaignTargetFromCandidateDoc(doc: QueryDocumentSnapshot): CampaignTarget {
  const data = globalCandidateIdentityFromCandidateDoc(doc);
  return {
    id: doc.id,
    candidateId: doc.id,
    name: stringField(data, "name", stringField(data, "channelTitle", doc.id)),
    email: validEmailField(data.email) || undefined,
    handle: stringField(data, "handle", "") || undefined,
    youtubeUrl: normalizePublicYouTubeChannelUrl(
      stringField(data, "youtubeUrl", stringField(data, "channelUrl", stringField(data, "profileUrl", ""))),
    ) || undefined,
    avatar: avatarField(data) || undefined,
    platform: stringField(data, "platform", "YouTube") || undefined,
    followers: numberField(data, "followers", 0) || undefined,
    region: stringField(data, "region", "") || undefined,
    category: stringField(data, "category", "") || undefined,
    publicDescription: stringField(data, "publicDescription", stringField(data, "description", "")).slice(0, 5_000) || undefined,
    matchedSearchTerms: stringArrayField(data.matchedSearchTerms, 12),
    // T3: 발굴 점수를 소비 단계까지 들고 온다(예전에는 여기서 버려져 참조 0회였다).
    matchScore: numberField(data, "matchScore", 0) || undefined,
    source: "discovered" as const,
    sourceRef: `candidate_pool/${doc.id}`,
    candidateRef: stringField(data, "candidateRef", `candidate_pool/${doc.id}`),
  };
}

/**
 * P0-1 [XP→Snake 후보 이주 · 2026-09-26]: campaign_candidates/program_campaign_targets 문서에
 * campaignCandidateMigration.ts 가 persist 한 `programScopeEvidence.keywordGateBypassed` 를 읽는다.
 * 이 값을 가진 문서에서 만든 CampaignTarget 만 `keywordGateBypassed` 를 승계하고, 라이브 리필의 두
 * 독립 키워드 게이트(evaluateProgramCampaignCandidateEligibility 호출부·targetMatchesCampaignIncludes)
 * 가 그 후보에 한해서만 키워드/카테고리 재거부를 건너뛴다.
 *
 * ⚠️ 알려진 한계(적대적 리뷰 2026-09-26): `campaign_candidates` 문서는 캠페인 스코프(link id +
 * campaignId 술어)지만, 승격된 `program_campaign_targets` 문서 id 는 **프로그램 스코프**
 * (programTargetDocId — 캠페인 축이 없다)라 `collectProgramCampaignTargets` 가 programId 로만 읽는다.
 * 즉 이 마커는 같은 프로그램의 **다른 캠페인**에도 그대로 보인다 — 그 캠페인이 이 마커를 부여받은
 * 적이 없어도. 이 이주가 실제로 쓰는 프로그램(pg-snake-clash-creator-program)은 이주 시점 캠페인
 * 1개뿐이라 무해하지만, 같은 프로그램에 캠페인이 늘면 이 함수에 campaignId 스코프를 추가해야 한다.
 */
function keywordGateBypassedFromDoc(data: Record<string, unknown>): boolean {
  return isRecord(data.programScopeEvidence)
    && (data.programScopeEvidence as Record<string, unknown>).keywordGateBypassed === true;
}

export function campaignTargetFromProgramTargetDoc(doc: QueryDocumentSnapshot): CampaignTarget {
  const data = doc.data();
  const candidateId = stringField(data, "candidateId", "");
  const creatorId = stringField(data, "creatorId", "");
  return {
    id: candidateId || creatorId || doc.id,
    programTargetId: doc.id,
    candidateId: candidateId || undefined,
    creatorId: creatorId || undefined,
    name: stringField(data, "name", stringField(data, "handle", doc.id)),
    email: validEmailField(data.email) || undefined,
    handle: stringField(data, "handle", "") || undefined,
    youtubeUrl: normalizePublicYouTubeChannelUrl(
      stringField(data, "youtubeUrl", stringField(data, "channelUrl", stringField(data, "profileUrl", ""))),
    ) || undefined,
    avatar: avatarField(data) || undefined,
    platform: stringField(data, "platform", "YouTube") || undefined,
    followers: numberField(data, "followers", 0) || undefined,
    region: stringField(data, "region", "") || undefined,
    category: stringField(data, "category", "") || undefined,
    publicDescription: stringField(data, "publicDescription", "").slice(0, 5_000) || undefined,
    matchedSearchTerms: stringArrayField(data.matchedSearchTerms, 12),
    // T3: 프로그램 타깃도 발굴 시 점수를 승계한 문서라면 그 값을 소비 단계까지 들고 온다.
    matchScore: numberField(data, "matchScore", 0) || undefined,
    source: "program" as const,
    sourceRef: stringField(data, "sourceRef", doc.ref.path),
    candidateRef: stringField(data, "candidateRef", "") || undefined,
    campaignCandidateRef: stringField(data, "campaignCandidateRef", "") || undefined,
    canonicalProgramId: stringField(data, "canonicalProgramId", "") || undefined,
    sourceCampaignId: stringField(data, "sourceCampaignId", stringField(data, "campaignId", "")) || undefined,
    sourceRunId: stringField(data, "sourceRunId", "") || undefined,
    sourceRunRef: stringField(data, "sourceRunRef", "") || undefined,
    ...(keywordGateBypassedFromDoc(data) ? { keywordGateBypassed: true as const } : {}),
  };
}

/**
 * R23-0 [발송 정체의 근인]: 발굴은 **캠페인 스코프 후보를 `campaign_candidates` 에만 적재한다** —
 * `discovery.ts persistCandidates` 의 exact-scope 분기는 전역 `candidate_pool` 에 쓰지 않는다(그쪽은
 * else 분기다). 그런데 라이브 refill 은 `program_campaign_targets` 만 읽었으므로, 발굴이 찾아 쌓은
 * 신선 후보(운영 실측: 이메일 보유 유니크 64명, 전원 `program_outreach_dedup` 미기록)가 발송 눈에
 * 구조적으로 보이지 않았다 — 어제부터의 `all_already_touched` 전량이 이 불일치였다.
 *
 * 이 문서는 이미 프로그램·캠페인 스코프(campaignId·canonicalProgramId·run provenance 보유)이므로
 * `collectCampaignTargets` 의 "전역 candidate_pool 직접 사용 금지"와는 다른 대상이다. 여기서 만드는
 * 대상은 게이트를 우회하지 않는다 — 국가·키워드·이메일·suppression·전역 dedup·mail-safety 는 호출부
 * 필터 체인에서 종전대로 전부 통과한다.
 *
 * ⚠️ 문서의 캠페인 식별자를 **권위 campaignId 로 되살리지 않는다**(program target 재수화와 같은 규칙).
 * 스코프는 이미 호출부 질의(`where("campaignId","==",<현재 캠페인>)`)가 고정하므로 이 필드를 실을
 * 이유가 없고, 실으면 과거 캠페인 값이 `validatedSourceCampaignId` 를 통해 현재 웨이브의 계보로
 * 승격될 수 있는 경로만 새로 생긴다.
 */
export function campaignTargetFromCampaignCandidateDoc(doc: QueryDocumentSnapshot): CampaignTarget {
  const data = doc.data();
  const candidateId = stringField(data, "candidateId", "");
  const candidateRef = stringField(data, "candidateRef", "")
    || (candidateId ? `candidate_pool/${candidateId}` : "");
  return {
    // program target 과 같은 축(candidateId)으로 식별한다 — touch/dedup 키가 어긋나면 같은 수신자가
    // 소스에 따라 다른 키를 갖고 전역 dedup 을 빠져나간다.
    id: candidateId || doc.id,
    candidateId: candidateId || undefined,
    candidateRef: candidateRef || undefined,
    campaignCandidateRef: stringField(data, "campaignCandidateRef", `${CAMPAIGN_CANDIDATES_COLLECTION}/${doc.id}`),
    canonicalProgramId: stringField(data, "canonicalProgramId", stringField(data, "programId", "")) || undefined,
    sourceRunId: stringField(data, "sourceRunId", "") || undefined,
    sourceRunRef: stringField(data, "sourceRunRef", "") || undefined,
    name: stringField(data, "name", stringField(data, "channelTitle", candidateId || doc.id)),
    email: validEmailField(data.email) || undefined,
    handle: stringField(data, "handle", "") || undefined,
    youtubeUrl: normalizePublicYouTubeChannelUrl(
      stringField(data, "youtubeUrl", stringField(data, "channelUrl", stringField(data, "profileUrl", ""))),
    ) || undefined,
    avatar: avatarField(data) || undefined,
    platform: stringField(data, "platform", "YouTube") || undefined,
    followers: numberField(data, "followers", 0) || undefined,
    region: stringField(data, "region", "") || undefined,
    category: stringField(data, "category", "") || undefined,
    publicDescription: stringField(data, "publicDescription", stringField(data, "description", "")).slice(0, 5_000) || undefined,
    matchedSearchTerms: stringArrayField(data.matchedSearchTerms, 12),
    matchScore: numberField(data, "matchScore", 0) || undefined,
    source: "discovered" as const,
    // campaign_candidates is the committed campaign-scoped provenance. candidateRef is still
    // carried separately for global dedup, but sourceRef must point at the row the refill joined.
    sourceRef: doc.ref.path,
    ...(keywordGateBypassedFromDoc(data) ? { keywordGateBypassed: true as const } : {}),
  };
}

const CAMPAIGN_CANDIDATE_MIGRATION_SOURCE = "campaign-candidate-migration";

function isMigrationCampaignCandidate(data: Record<string, unknown>): boolean {
  const candidateProvenance = isRecord(data.candidateProvenance)
    ? data.candidateProvenance as Record<string, unknown>
    : {};
  const programScopeEvidence = isRecord(data.programScopeEvidence)
    ? data.programScopeEvidence as Record<string, unknown>
    : {};
  return stringField(candidateProvenance, "kind", "") === CAMPAIGN_CANDIDATE_MIGRATION_SOURCE
    || stringField(programScopeEvidence, "kind", "") === CAMPAIGN_CANDIDATE_MIGRATION_SOURCE
    || stringField(candidateProvenance, "migrationRunId", "").length > 0
    || stringField(programScopeEvidence, "migrationRunId", "").length > 0
    || stringField(data, "migrationRunId", "").length > 0;
}

function migrationEvaluationEligible(value: unknown): boolean {
  return isRecord(value) && value.eligible === true;
}

function campaignCandidateAllowedForLiveRefill(data: Record<string, unknown>): boolean {
  if (!isMigrationCampaignCandidate(data)) return true;
  const eligibility = isRecord(data.eligibility) ? data.eligibility as Record<string, unknown> : {};
  const programScopeEvidence = isRecord(data.programScopeEvidence)
    ? data.programScopeEvidence as Record<string, unknown>
    : {};
  return stringField(eligibility, "verdict", "") === "pass"
    && migrationEvaluationEligible(eligibility.evaluation)
    && migrationEvaluationEligible(programScopeEvidence.eligibilityEvaluation);
}

function validatedSourceCampaignId(
  target: CampaignTarget,
  currentProgramId: string,
  currentCampaignId: string,
): string | undefined {
  const sourceCampaignId = (target.sourceCampaignId ?? target.campaignId ?? "").trim().slice(0, 120);
  if (!sourceCampaignId || sourceCampaignId === currentCampaignId) return undefined;
  const canonicalProgramId = resolveCanonicalProgramId(currentProgramId);
  const targetProgramId = resolveCanonicalProgramId(target.canonicalProgramId);
  return canonicalProgramId && targetProgramId === canonicalProgramId ? sourceCampaignId : undefined;
}

// W8-11b: 스캔 폭은 요청 수(KPI)와 **분리**한다. 예전에는 scanLimit 이 max(limit, limit*2, …) 라
// KPI 를 작게 잡으면 준비된 프로그램 대상 풀을 2건만 훑고 끝나 "준비 0"이 됐고, KPI 를 크게 잡으면
// exact-match 게이트가 "1건뿐"으로 거부했다 — 사용자가 어떤 조합을 눌러도 통과 불가능한 구조였다.
// 훑는 폭은 아래 하한(요청 수 무관)과 CAMPAIGN_TARGET_SCAN_LIMIT 상한 사이에서 결정되고,
// **큐잉/발송 수만** KPI·wave cap·배치 승인 상한으로 제한한다(상한 완화 없음).
// F5③: 하드코딩 하한에는 근거가 없다 — 운영이 조정할 수 있게 settings 주도로 두고, 문서·필드가
// 없을 때만 이 기본값을 쓴다(기존 동작과 같은 값).
const CAMPAIGN_TARGET_SCAN_FLOOR_DEFAULT = 1_000;

function campaignTargetScanWidth(requestedScanLimit = 0, scanFloor = CAMPAIGN_TARGET_SCAN_FLOOR_DEFAULT): number {
  const floor = Number.isFinite(scanFloor) && scanFloor > 0
    ? Math.min(CAMPAIGN_TARGET_SCAN_LIMIT, Math.round(scanFloor))
    : CAMPAIGN_TARGET_SCAN_FLOOR_DEFAULT;
  return Math.min(
    CAMPAIGN_TARGET_SCAN_LIMIT,
    Math.max(floor, Math.round(requestedScanLimit || 0)),
  );
}

async function readCampaignTargetScanFloor(): Promise<number> {
  const settings = await readSettings();
  const automation = settings.automation as Record<string, unknown>;
  const configured = automation.campaignTargetScanFloor;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.min(CAMPAIGN_TARGET_SCAN_LIMIT, Math.round(configured))
    : CAMPAIGN_TARGET_SCAN_FLOOR_DEFAULT;
}

/**
 * R23-0: 라이브 웨이브가 소비하는 프로그램 대상 풀. 소스는 두 개다.
 *  ① `program_campaign_targets` (status ready) — 준비 단계가 승격한 행.
 *  ② `campaign_candidates` 중 **이 캠페인 스코프** 행 — 발굴이 적재한 신선 후보. 승격 배선이 없어서
 *     지금까지 발송 눈에 보이지 않던 쪽이다(위 `campaignTargetFromCampaignCandidateDoc` 주석).
 * ②는 campaignId 동일 + canonical 프로그램 동일만 통과하므로 다른 캠페인 후보 유입은 0이고,
 * `status !== "ready"` 인 program target(safety 차단 등)과 같은 후보는 되살리지 않는다 — 그 상태가
 * 게이트이기 때문이다. 이메일 없는 후보는 발송 소스가 아니라 백필 대상이므로 스캔 폭을 먹지 않게
 * 여기서 제외한다(제외가 아니라 후순위였던 candidate_pool 밴드와 달리 이쪽은 재고 판정이 별도다).
 */
// W34 F-1 [근인 확정 2026-08-05]: orderBy 없는 limit 은 __name__ 오름차순 하위 scanLimit 건을 매 pass
// 다시 읽는다 — discovery.ts readChannelGraphSeeds 의 커서 회전을 재사용한다(orderBy(documentId())는
// 복합 인덱스가 불필요). 커서가 끝을 가리키면(빈 결과) 같은 pass 에서 처음으로 되감는다.
/**
 * 26-08-28: 커서가 **정렬축 값의 배열**도 될 수 있다.
 *
 * 종전에는 문자열 하나(문서 ID)만 받았고 `orderBy(documentId())` 단일 정렬을 전제했다. 아래
 * campaign_candidates 스캔이 `orderBy("email", documentId())` 로 바뀌면서 startAfter 에 두 값이
 * 필요해졌다 — 값 하나만 넘기면 Firestore 가 그걸 첫 정렬축(email)으로 해석해 커서가 조용히
 * 어긋난다(회전이 같은 구간을 맴돌거나 건너뛴다). 그래서 축 수만큼 값을 넘긴다.
 *
 * 하위 호환: 예전에 저장된 문자열 커서는 그대로 단일 값으로 쓰인다. 축이 늘어난 쿼리에서 그 값을
 * 만나면 startAfter 가 축 수와 안 맞아 던질 수 있으므로, 아래 호출부가 축 전환 시 커서를 한 번
 * 버린다(1회 처음부터 = 안전 방향, 데이터 손실 없음).
 */
async function rotatingWindow(
  query: Query,
  cursor: string | readonly string[],
): Promise<FirebaseFirestore.QuerySnapshot> {
  const values = (Array.isArray(cursor) ? cursor : [cursor]).filter((value) => typeof value === "string" && value.length > 0);
  const snapshot = await (values.length ? query.startAfter(...values) : query).get();
  // 끝에 닿았으면 처음으로 회전한다(종전 계약 그대로).
  return snapshot.empty && values.length ? query.get() : snapshot;
}
/**
 * 다음 창의 시작점. `fields` 를 주면 그 정렬축 값들 + 문서 ID 를 배열로 돌려준다(축 순서와 반드시
 * 일치해야 한다 — 어긋나면 startAfter 가 엉뚱한 지점을 가리킨다).
 */
function nextScanCursor(
  snapshot: FirebaseFirestore.QuerySnapshot,
  scanLimit: number,
  fields: readonly string[] = [],
): string | string[] {
  if (snapshot.docs.length < scanLimit) return fields.length ? [] : "";
  const last = snapshot.docs[snapshot.docs.length - 1];
  if (!last) return fields.length ? [] : "";
  if (!fields.length) return last.id;
  return [...fields.map((field) => stringField(last.data(), field, "")), last.id];
}

export async function collectProgramCampaignTargets(
  programId: string,
  total: number,
  requestedScanLimit = 0,
  scanFloor?: number,
  campaignId = "",
): Promise<ProgramCampaignTargetCollection> {
  if (!programId) return emptyProgramCampaignTargetCollection();
  void total;
  const scanLimit = campaignTargetScanWidth(requestedScanLimit, scanFloor ?? await readCampaignTargetScanFloor());
  // 캠페인별 스캔 커서 — 기존 캠페인 문서의 새 필드(refillScanCursor)에만 보관한다(새 컬렉션 없음).
  const cursorRef = campaignId ? adminDb.collection("campaigns").doc(campaignId) : null;
  const cursorData = cursorRef ? (await cursorRef.get()).data() ?? {} : {};
  const cursors = isRecord(cursorData.refillScanCursor) ? cursorData.refillScanCursor : {};
  const programCursor = stringField(cursors, "programTargets", "");
  // 26-08-28: candidate 스캔이 [email, __name__] 2축으로 바뀌었다. 예전 문자열 커서(문서 ID 하나)는
  //   축 수가 안 맞아 startAfter 가 던지므로 **한 번 버리고 처음부터** 돈다(1회 손실 없는 리셋).
  const rawCandidateCursor = cursors.campaignCandidates;
  const candidateCursor: string[] = Array.isArray(rawCandidateCursor)
    ? rawCandidateCursor.filter((value): value is string => typeof value === "string")
    : [];
  const programQuery = adminDb.collection(PROGRAM_CAMPAIGN_TARGETS_COLLECTION).where("programId", "==", programId).orderBy(FieldPath.documentId()).limit(scanLimit);
  // 26-08-28 [실측 수리] — 이 스캔이 **진짜 발송 경로**이고, 창의 절반이 산출 0 인 문서였다.
  //
  //   피어 관측(121차 배포 후 발송 152건 전수 조회): 149건(98%)이 program_campaign_targets 문서
  //   없이 나갔다. 즉 발송 물량은 위 타깃 컬렉션이 아니라 여기서 나온다.
  //   그런데 이 컬렉션의 이메일 밀도가 낮다(프로드 실측 26-08-28: 26,040건 중 유효 이메일 12,546
  //   = 48%. 특히 백로그 재수화분 6,205건은 1,587건 = 25.6%). 이메일 없는 문서는 아래 조인이
  //   `!recipient` 로 전량 버리는데(joinedDroppedMissingFields, 한 pass 실측 181건) **버리기 전에
  //   이미 읽어 과금**된다.
  //
  //   Firestore 에 "필드 존재" 술어가 없으므로 `> ""` 로 표현한다 — 문자열 필드가 있고 빈 값이
  //   아닌 문서만 반환하고, 필드 자체가 없는 문서는 인덱스에 없어 자동 제외된다.
  //   ⚠️ 이건 **읽기를 줄이는 축**이지 정확성 축이 아니다: 형식 검증은 종전대로 아래
  //   validEmailField 가 계속 한다(fail-open — 이상한 값이 통과해도 조인에서 걸린다).
  //   부등호가 첫 정렬축을 강제하므로 orderBy 가 [email, __name__] 2축이 되고, 커서도 2값이다.
  //
  //   NEXT-1 [소비 표시 필터]: 여기에 `stage == "discovered"` 를 더한다 — 122차가 발송 시
  //   `discovered → contacted` 전이를 넣었으므로(programOutreachDedup.ts) **이미 쓴 후보를
  //   애초에 안 읽는다**. 재고가 소진되면 이 쿼리는 0건을 반환해 pass 당 1 read 가 된다.
  //   등호 술어라 정렬축은 늘지 않지만 복합 인덱스는 `campaignId + stage + email + __name__`
  //   으로 바뀐다(firestore.indexes.json — 인덱스가 먼저 살아 있어야 이 쿼리가 안 던진다).
  const candidateQuery = campaignId
    ? adminDb.collection(CAMPAIGN_CANDIDATES_COLLECTION)
        .where("campaignId", "==", campaignId)
        .where("stage", "==", CAMPAIGN_CANDIDATE_FRESH_STAGE)
        .where("email", ">", "")
        .orderBy("email")
        .orderBy(FieldPath.documentId())
        .limit(scanLimit)
    : null;
  const [programSnapshot, campaignCandidateSnapshot] = await Promise.all([
    rotatingWindow(programQuery, programCursor),
    candidateQuery ? rotatingWindow(candidateQuery, candidateCursor) : Promise.resolve(null),
  ]);
  if (cursorRef) {
    await cursorRef.set({
      refillScanCursor: {
        programTargets: nextScanCursor(programSnapshot, scanLimit),
        campaignCandidates: campaignCandidateSnapshot
          ? nextScanCursor(campaignCandidateSnapshot, scanLimit, ["email"])
          : candidateCursor,
      },
    }, { merge: true });
  }
  let programTargets: CampaignTarget[] = [];
  const blockedKeys = new Set<string>();
  for (const doc of programSnapshot.docs) {
    const target = campaignTargetFromProgramTargetDoc(doc);
    if (stringField(doc.data(), "status", "ready") === "ready") programTargets.push(target);
    else for (const key of targetDedupKeys(target)) blockedKeys.add(key);
  }
  const readyBeforeBroadQuarantine = programTargets.length;
  programTargets = programTargets.filter((target) => !targetDedupKeys(target).some((key) => blockedKeys.has(key)));
  const broadSkipped = readyBeforeBroadQuarantine - programTargets.length;
  // P0-2: 준비 경로(prepareProgramCampaignTargetsCore)와 같은 **선택 시점** 도달성 필터.
  //   이 경로는 라이브 웨이브가 실제로 소비하는 풀인데, program_campaign_targets(ready) 행은
  //   준비 단계 필터 이후에 판정이 쌓였을 수 있고, campaign_candidates 조인분은 준비 경로를
  //   거치지 않는다 — 그래서 같은 캐시 판정을 여기서 다시 적용한다(캐시 읽기 전용, 벤더 미호출).
  //   창 절반 몫 계산 **앞**에 두어 skip 된 자리를 다른 후보가 흡수하게 한다.
  const programDeliverability = await dropCachedUndeliverableTargets(programTargets);
  programTargets = programDeliverability.targets;
  if (!campaignCandidateSnapshot) {
    return {
      targets: programTargets,
      skipped: broadSkipped,
      readBatches: 0,
      fallbackFailed: 0,
      fallbackErrorCode: null,
      deliverabilityCachedSkipped: programDeliverability.skipped,
    };
  }
  const canonicalProgramId = resolveCanonicalProgramId(programId);
  const campaignScopedTargets: CampaignTarget[] = [];
  for (const doc of campaignCandidateSnapshot.docs) {
    const data = doc.data();
    if (!campaignCandidateAllowedForLiveRefill(isRecord(data) ? data as Record<string, unknown> : {})) continue;
    const target = campaignTargetFromCampaignCandidateDoc(doc);
    if (resolveCanonicalProgramId(target.canonicalProgramId) !== canonicalProgramId) continue;
    if (!hasValidTargetEmail(target)) continue;
    campaignScopedTargets.push(target);
  }
  const quarantine = await readProgramTargetSafetyQuarantine(programId, campaignScopedTargets, {
    knownDocs: programSnapshot.docs,
    knownSnapshotComplete: programSnapshot.size < scanLimit,
  });
  for (const key of quarantine.blockedKeys) blockedKeys.add(key);
  programTargets = programTargets.filter((target) => !targetDedupKeys(target).some((key) => blockedKeys.has(key)));

  const seenKeys = new Set(programTargets.flatMap(targetDedupKeys));
  const joined: CampaignTarget[] = [];
  for (const target of campaignScopedTargets) {
    const keys = targetDedupKeys(target);
    if (keys.some((key) => seenKeys.has(key) || blockedKeys.has(key))) continue;
    for (const key of keys) seenKeys.add(key);
    joined.push(target);
  }
  // P0-2: 조인분(campaign_candidates)도 같은 선택 시점 필터 — 준비 경로를 우회한 후보가
  //   캐시 적중 undeliverable 이면 여기서 떨어진다. 몫 계산 전에 적용해 몫을 낭비하지 않는다.
  const joinedDeliverability = await dropCachedUndeliverableTargets(joined);
  const deliverableJoined = joinedDeliverability.targets;
  // R23-0c [기아 수리]: 예전에는 `[...programTargets, ...joined].slice(0, scanLimit)` 였다. program
  // target 이 **먼저**라 ready 행이 창을 채우면 발굴 신선 후보가 **한 명도** 안 들어왔다 — R23-0 이
  // 고치려던 `campaign_targets_all_already_touched` 가 그대로 재현된다(리뷰어 에뮬 프로브: scanFloor 3 ·
  // 기컨택 ready 3건 + 신선 2건 → queued 0). ready 행은 큐잉 후 status 가 전이되지 않아 낡은 채로
  // 누적되므로(위 F1 주석과 같은 구조) 창을 먹는 쪽이 구조적으로 낡은 행이다.
  //
  // 그래서 한쪽을 앞세우지 않고 **양쪽에 창의 절반을 보장**한다. 한쪽이 몫을 다 못 쓰면 남는 몫은 다른
  // 쪽이 흡수하므로 어느 소스도 굶지 않고 창도 낭비되지 않는다 — joined 를 그냥 앞에 두면 반대 방향
  // 기아(준비 단계가 검증·승격한 행이 밀림)를 새로 만든다.
  const halfWindow = Math.max(1, Math.floor(scanLimit / 2));
  const joinedQuota = Math.min(deliverableJoined.length, Math.max(halfWindow, scanLimit - programTargets.length));
  const programQuota = Math.max(0, scanLimit - joinedQuota);
  return {
    targets: [...programTargets.slice(0, programQuota), ...deliverableJoined.slice(0, joinedQuota)],
    skipped: broadSkipped + quarantine.skipped,
    readBatches: quarantine.readBatches,
    fallbackFailed: quarantine.fallbackFailed,
    fallbackErrorCode: quarantine.fallbackErrorCode,
    deliverabilityCachedSkipped: programDeliverability.skipped + joinedDeliverability.skipped,
  };
}

async function collectCampaignTargets(
  owner: string,
  total: number,
  requestedScanLimit = 0,
  options: { liveSend?: boolean; programId?: string; scanFloor?: number; campaignId?: string } = {},
): Promise<CampaignTarget[]> {
  const limit = Math.max(1, Math.min(total || 10, CAMPAIGN_OUTREACH_QUEUE_LIMIT));
  // Operational live waves need to cap queued rows (for example 50) while still
  // scanning enough existing engine candidates to survive dedup/suppression.
  // Keep the default behavior unchanged; only an explicit bounded targetScanLimit
  // widens reads, never the eventual queue size.
  const operatorScanLimit = Math.max(0, Math.round(requestedScanLimit || 0));
  const scanLimit = Math.min(CAMPAIGN_TARGET_SCAN_LIMIT, Math.max(limit, limit * 2, operatorScanLimit));
  if (options.liveSend === true) {
    // Live sends must come from a program-owned target pool prepared by the Flu
    // engine. Never hydrate a live wave directly from the global candidate_pool:
    // that pool is discovery-shaped and can be disconnected from a program KPI.
    // R23-0: 이 금지는 그대로다 — 추가된 소스(`campaign_candidates`)는 전역 풀이 아니라 이미
    // 프로그램·캠페인 스코프인 참여 문서다(collectProgramCampaignTargets 주석).
    const collected = await collectProgramCampaignTargets(
      options.programId ?? "",
      total,
      requestedScanLimit,
      options.scanFloor,
      options.campaignId ?? "",
    );
    return collected.targets;
  }
  const [managedSnapshot, recentDiscoveredSnapshot, fallbackDiscoveredSnapshot, campaignScopedSnapshot] = await Promise.all([
    adminDb.collection("creators").where("owner", "==", owner).limit(scanLimit).get(),
    adminDb.collection("candidate_pool").orderBy("updatedAtIso", "desc").limit(scanLimit).get()
      .catch(() => adminDb.collection("candidate_pool").limit(scanLimit).get()),
    adminDb.collection("candidate_pool").limit(scanLimit).get(),
    // R31-1: 비라이브 레인도 같은 이음매를 갖고 있었다 — 발굴 산출물(campaign_candidates)을 함께 읽는다.
    // 캠페인 스코프가 없으면(옵션 미전달) 질의 자체를 만들지 않아 종전과 완전히 동일하다.
    // NEXT-1: 라이브 경로와 같은 소비 표시 필터. 등호 2개 + 정렬축 없음이라 단일 필드 인덱스
    // 병합으로 처리된다(프로드 실측 확인 — 복합 인덱스 불필요).
    options.campaignId
      ? adminDb.collection(CAMPAIGN_CANDIDATES_COLLECTION)
        .where("campaignId", "==", options.campaignId)
        .where("stage", "==", CAMPAIGN_CANDIDATE_FRESH_STAGE)
        .limit(scanLimit)
        .get()
      : null,
  ]);
  const recentDiscoveredIds = new Set(recentDiscoveredSnapshot.docs.map((doc) => doc.id));
  // R17-5: 같은 후순위화를 레거시(비라이브) 스캔에도 적용한다 — 두 경로가 같은 풀을 훑는다.
  const discoveredDocs = prioritizeEmailCapableCandidateDocs([
    ...recentDiscoveredSnapshot.docs,
    ...fallbackDiscoveredSnapshot.docs.filter((doc) => !recentDiscoveredIds.has(doc.id)),
  ], scanLimit).docs;
  const managed = managedSnapshot.docs.map(campaignTargetFromCreatorDoc);
  const discovered = discoveredDocs.map(campaignTargetFromCandidateDoc);
  // R31-1: 이메일 정규화 값 기준 dedup — 같은 사람이 두 컬렉션에 있으면 1명이다.
  const scannedEmails = new Set([...managed, ...discovered]
    .map((target) => validEmailField(target.email))
    .filter(Boolean));
  const campaignScoped: CampaignTarget[] = [];
  for (const doc of campaignScopedSnapshot?.docs ?? []) {
    const target = campaignTargetFromCampaignCandidateDoc(doc);
    const recipient = validEmailField(target.email);
    if (!recipient || scannedEmails.has(recipient)) continue;
    scannedEmails.add(recipient);
    campaignScoped.push(target);
  }
  return [...managed, ...discovered, ...campaignScoped].slice(0, scanLimit);
}

async function readLiveCampaignWaveCap(): Promise<number> {
  const settings = await readSettings();
  const automation = settings.automation as Record<string, unknown>;
  const configured = typeof automation.maxLiveCampaignWaveSends === "number"
    ? automation.maxLiveCampaignWaveSends
    : settings.automation.maxDailyOutreachSends;
  return Math.max(0, Math.round(configured));
}

type LiveSendBatchConfig = { id: string; cap: number; source: string };

function liveSendBatchIdField(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 160) : "";
}

function liveSendBatchCapField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

async function resolveLiveSendBatchConfig(data: Record<string, unknown>): Promise<LiveSendBatchConfig | null> {
  const settings = await readSettings();
  const automation = settings.automation as Record<string, unknown>;
  const explicitId = liveSendBatchIdField(data.liveSendBatchId);
  const settingsId = liveSendBatchIdField(automation.liveSendBatchId);
  const explicitCap = liveSendBatchCapField(data.maxLiveSendBatchSends) || liveSendBatchCapField(data.liveSendBatchCap);
  const settingsCap = liveSendBatchCapField(automation.maxLiveSendBatchSends);
  const id = explicitId || settingsId;
  const cap = explicitCap || settingsCap;
  if (!id || cap <= 0) return null;
  return {
    id,
    cap,
    source: explicitId || explicitCap ? "request" : "settings/default.automation",
  };
}

function programTargetDocId(programId: string, target: CampaignTarget): string {
  const key = target.candidateId || target.creatorId || target.id || validEmailField(target.email) || target.name;
  return `${safeDocId(programId)}__${safeDocId(key)}`;
}

function programTargetRef(programId: string, target: CampaignTarget): DocumentReference {
  const docId = target.programTargetId || programTargetDocId(programId, target);
  return adminDb.collection(PROGRAM_CAMPAIGN_TARGETS_COLLECTION).doc(docId);
}

function programTargetSafetyBlockPayload(
  programId: string,
  target: CampaignTarget,
  safety: MailProfileSafetyDecision,
  blockedAtIso: string,
  source: string,
) {
  return stripUndefinedFields({
    id: target.programTargetId || programTargetDocId(programId, target),
    programId,
    status: "blocked",
    candidateId: target.candidateId,
    creatorId: target.creatorId,
    source: target.sourceRef ? "candidate_pool_existing" : target.source ?? "program",
    sourceRef: target.sourceRef ?? (target.candidateId ? `candidate_pool/${target.candidateId}` : ""),
    sourceRunId: target.sourceRunId,
    sourceRunRef: target.sourceRunRef,
    canonicalProgramId: resolveCanonicalProgramId(programId),
    programScopeEvidence: target.programScopeEvidence,
    name: target.name,
    email: validEmailField(target.email),
    handle: target.handle ?? "",
    avatar: target.avatar ?? "",
    platform: target.platform ?? "YouTube",
    followers: target.followers ?? 0,
    region: target.region ?? "",
    category: target.category ?? "",
    selectedForKpi: false,
    blockedReason: safety.ruleId,
    blockedDetail: safety.reason,
    blockedSource: source,
    blockedAtIso,
    updatedAtIso: blockedAtIso,
    updatedAt: FieldValue.serverTimestamp(),
  });
}


export function combineCampaignTargetSafety(
  profileSafety: MailProfileSafetyDecision,
  hardSafety: { allowed: boolean; ruleId?: string; reason?: string; matchedKeyword?: string },
  options: { deferIdentityUnknownForDraftCreation?: boolean } = {},
): MailProfileSafetyDecision {
  if (!hardSafety.allowed) {
    if (options.deferIdentityUnknownForDraftCreation && hardSafety.ruleId === "identity_unknown") {
      return profileSafety;
    }
    return {
      allowed: false,
      liveSendAllowed: false,
      ruleId: hardSafety.ruleId ?? "mail-safety.preflight-blocked",
      reason: hardSafety.reason ?? "메일 안전 정책으로 차단되었습니다.",
      ...(hardSafety.matchedKeyword ? { matchedKeyword: hardSafety.matchedKeyword } : {}),
    };
  }
  return profileSafety;
}
const CAMPAIGN_SAFETY_QUARANTINE_AUDIT_LIMIT = 100;

type CampaignSafetyQuarantineAuditEntry = {
  candidateKeyHash: string;
  attempts: number;
  lastAtIso: string;
};

function campaignSafetyQuarantineCandidateKey(target: CampaignTarget): string {
  if (target.candidateId) return `candidate:${target.candidateId}`;
  if (target.creatorId) return `creator:${target.creatorId}`;
  const email = validEmailField(target.email);
  return email ? `email:${email}` : "";
}

function campaignSafetyQuarantineCandidateKeyHash(candidateKey: string): string {
  return createHash("sha256").update(candidateKey).digest("hex").slice(0, 20);
}

export function advanceCampaignSafetyQuarantineAudit(
  prior: unknown,
  candidateKeys: string[],
  lastAtIso: string,
): {
  entries: CampaignSafetyQuarantineAuditEntry[];
  repeatedCount: number;
  repeatedKeyHashes: string[];
} {
  const entriesByHash = new Map<string, CampaignSafetyQuarantineAuditEntry>();
  for (const item of Array.isArray(prior) ? prior.slice(-CAMPAIGN_SAFETY_QUARANTINE_AUDIT_LIMIT) : []) {
    if (!isRecord(item)) continue;
    const candidateKeyHash = stringField(item, "candidateKeyHash", "");
    const attempts = Math.max(0, Math.round(numberField(item, "attempts", 0)));
    const priorLastAtIso = stringField(item, "lastAtIso", "");
    if (!/^[a-f0-9]{20}$/.test(candidateKeyHash) || attempts < 1 || !priorLastAtIso) continue;
    entriesByHash.set(candidateKeyHash, { candidateKeyHash, attempts, lastAtIso: priorLastAtIso });
  }

  const repeatedKeyHashes: string[] = [];
  for (const candidateKey of uniqueStrings(candidateKeys)) {
    const candidateKeyHash = campaignSafetyQuarantineCandidateKeyHash(candidateKey);
    const attempts = (entriesByHash.get(candidateKeyHash)?.attempts ?? 0) + 1;
    entriesByHash.delete(candidateKeyHash);
    entriesByHash.set(candidateKeyHash, { candidateKeyHash, attempts, lastAtIso });
    if (attempts >= 2) repeatedKeyHashes.push(candidateKeyHash);
  }

  return {
    entries: [...entriesByHash.values()].slice(-CAMPAIGN_SAFETY_QUARANTINE_AUDIT_LIMIT),
    repeatedCount: repeatedKeyHashes.length,
    repeatedKeyHashes,
  };
}

/**
 * W7-3: the final create guard remains fail-closed. After it quarantines a refill target, update a
 * bounded ring on the existing campaign so a second attempt for the same campaign/candidate is not
 * a silent loop. Diagnostic failure is swallowed and never weakens the create-time rejection.
 */
async function recordCampaignSafetyQuarantineAttempts(
  campaignId: string,
  targets: CampaignTarget[],
  blockedAtIso: string,
): Promise<void> {
  const candidateKeys = uniqueStrings(targets.map(campaignSafetyQuarantineCandidateKey));
  if (!campaignId || candidateKeys.length === 0) return;
  const campaignRef = adminDb.collection("campaigns").doc(campaignId);
  try {
    const detected = await adminDb.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(campaignRef);
      if (!snapshot.exists) return null;
      const campaign = snapshot.data() ?? {};
      const next = advanceCampaignSafetyQuarantineAudit(
        campaign.lastRefillSafetyQuarantineAudit,
        candidateKeys,
        blockedAtIso,
      );
      const write: Record<string, unknown> = {
        lastRefillSafetyQuarantineAudit: next.entries,
        lastRefillSafetyQuarantineLoop: next.repeatedCount > 0
          ? {
              detected: true,
              detectedAtIso: blockedAtIso,
              repeatedCandidates: next.repeatedCount,
              candidateKeyHashes: next.repeatedKeyHashes.slice(0, 20),
              threshold: 2,
            }
          : null,
        lastRefillCounts: { safetyQuarantineLoopDetected: next.repeatedCount },
      };
      transaction.set(campaignRef, write, {
        mergeFields: [
          "lastRefillSafetyQuarantineAudit",
          "lastRefillSafetyQuarantineLoop",
          new FieldPath("lastRefillCounts", "safetyQuarantineLoopDetected"),
        ],
      });
      return next;
    });
    if (detected && detected.repeatedCount > 0) {
      console.warn("[campaign-auto-refill] safety quarantine loop detected", {
        campaignId,
        repeatedKeyHashes: detected.repeatedKeyHashes.slice(0, 5),
      });
    }
  } catch (error) {
    console.warn("[campaign-auto-refill] safety quarantine loop audit failed", {
      campaignId,
      errorCode: errorCodeForLog(error),
    });
  }
}


async function markProgramTargetsSafetyBlocked(
  programId: string,
  items: Array<{ target: CampaignTarget; safety: MailProfileSafetyDecision }>,
  blockedAtIso: string,
  source: string,
): Promise<void> {
  if (!programId || items.length === 0) return;
  let batch = adminDb.batch();
  let ops = 0;
  for (const item of items) {
    batch.set(
      programTargetRef(programId, item.target),
      programTargetSafetyBlockPayload(programId, item.target, item.safety, blockedAtIso, source),
      { merge: true },
    );
    ops += 1;
    if (ops >= 450) {
      await batch.commit();
      batch = adminDb.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
}

function redactedProgramTargetResponse(target: CampaignTarget) {
  const email = validEmailField(target.email);
  return {
    id: target.id,
    programTargetId: target.programTargetId,
    candidateId: target.candidateId,
    creatorId: target.creatorId,
    source: target.source,
    sourceRef: target.sourceRef,
    name: target.name,
    handle: target.handle,
    platform: target.platform,
    followers: target.followers,
    region: target.region,
    category: target.category,
    recipientMasked: email ? email.replace(/^(.{0,2}).*(@.*)$/u, "$1***$2") : "",
  };
}

/**
 * R31-2 [운영 실사고 2026-07-31]: `targetingCriteria.eligibilityKeywordGate` — 자격 판정에서
 * 키워드/카테고리 일치를 **요구할지**의 캠페인 단위 스위치다.
 *
 * 기본값 `"on"`(미설정 포함) = 현행 동작 100% 유지. `"off"` 일 때만 자격 판정에 넘기는
 * keywords/categories 를 빈 배열로 만든다 — 검색용 includeKeywords 는 무접촉이고,
 * excludeKeywords·팔로워 하한·국가·suppression·전역 dedup·발송 상한은 어느 값에서도 그대로다.
 * 순수 함수 — 값으로 직접 단위 테스트한다.
 */
export function eligibilityKeywordGateEnabled(targetingCriteria: unknown): boolean {
  const record = isRecord(targetingCriteria) ? targetingCriteria : {};
  return stringField(record, "eligibilityKeywordGate", "on").trim().toLowerCase() !== "off";
}

type ProgramCampaignTargetPreparation = {
  requested: number;
  requestedBeforeKpiCap: number;
  remainingKpi: number;
  scanned: number;
  scannedRaw: number;
  programScopeRejected: number;
  /** R31-2: 자격 게이트가 키워드/카테고리 불일치로 거부한 건수 — 게이트 off 의 효과가 여기서 보인다. */
  keywordMismatchRejected: number;
  /**
   * R33-1 [적대적 리뷰 LOW-1 · 관측 갭]: 자격 거부 **사유별 분포**(program_scope_mismatch ·
   * followers_missing · keyword_mismatch · country_mismatch …). 총계(programScopeRejected)만으로는
   * "왜 준비가 멈췄나"를 운영에서 짚을 수 없다 — 오늘 정체의 진단이 정확히 이 값에서 막혔다.
   */
  programScopeRejectedReasons: Record<string, number>;
  /** R31-1: 전역 candidate_pool 에서 훑은 후보 수(합류 전). */
  poolScanned: number;
  /** R31-1: 이 캠페인 스코프 campaign_candidates 에서 읽은 문서 수. */
  campaignScopedScanned: number;
  /** R31-1: 그중 준비 대상으로 매핑에 성공한 수(이메일·식별자 보유). */
  joinedCampaignScoped: number;
  /** R31-1: 이메일 정규화 dedup 후 **실제로 합류한** 수(두 컬렉션 중복은 1명). */
  joinedUnique: number;
  /** R31-1: 문서 shape 이 달라 매핑에 실패해 버려진 수 — 조용히 사라지지 않게 남긴다. */
  joinedDroppedMissingFields: number;
  /**
   * 26-08-28 [피어 관측 후속]: 최종 산출(selected)이 **어느 컬렉션에서 왔는지**.
   * 배포 후 발송 152건 전수 조회에서 149건(98%)이 program_campaign_targets 문서 없이 나갔다 —
   * 즉 그 컬렉션을 매 pass 400건씩 스캔하는 비용이 산출에 얼마나 기여하는지가 불분명했다.
   * 이 두 값이 그 질문에 답한다: selectedFromProgramTargets 가 계속 0 에 가까우면 그 스캔은 제거 후보다.
   */
  selectedFromProgramTargets: number;
  selectedFromCampaignCandidates: number;
  /** R33-2: 평가 창을 채우려고 훑은 email-ready 후보 수(청크 상한으로 유계). */
  untouchedWindowScanned: number;
  /** R33-2: 그 창에서 기컨택으로 건너뛴 수 — 정체의 규모가 이 값에 직접 보인다. */
  untouchedWindowSkipped: number;
  /** W78-③ 감사용: 이번 pass 시작점 / 다음 pass 시작점(dryRun 은 저장하지 않는다). */
  evaluationRotationOffset?: number;
  evaluationRotationNext?: number;
  /** W78-② 감사용: 상태 의존 사유로 격리에서 풀린 수(dryRun 이면 "풀렸을" 수). */
  staleQuarantineReleased?: number;
  filtered: number;
  emailReady: number;
  sendable: number;
  safetyReady: number;
  safetyBlockedSkipped: number;
  /** W7-1: blocked program targets removed from the bounded candidate window before safety evaluation. */
  safetyQuarantinedSkipped: number;
  /** W7-1 read guard: targeted `in` query batches used for that bounded window. */
  safetyQuarantineReadBatches: number;
  /** TRAIN31 M4: the targeted composite-query fallback failed and broad-snapshot degradation was used. */
  safetyQuarantineFallbackFailed: number;
  /** Sanitized provider code for the degraded fallback; excluded from numeric preparation projections. */
  safetyQuarantineFallbackErrorCode?: string;
  alreadyTouchedSkipped: number;
  duplicateRecipientSkipped: number;
  /** P0-2: 선택 시점에 전역 도달성 캐시(적중 undeliverable)로 걸러낸 email-ready 후보 수. */
  deliverabilityCachedSkipped: number;
  selected: number;
  prepared: number;
  wouldPrepare: number;
  existing: number;
  /** F5②: suppression/safety 평가를 total 의 상수배로 절단한 건수(0 이면 절단 없음). */
  evaluationTruncated: number;
  /**
   * R17-5 [W9-4]: 이 스캔에서 후순위로 밀린 **구조상 이메일 불가** 커뮤니티 시그널 건수.
   * 이메일 확보율이 낮을 때 "풀이 마른 것"과 "오염 밴드가 창을 먹은 것"을 구분하는 값이다.
   */
  emailIncapableDeprioritized: number;
  /** F2: 이 호출이 **새로 만든** program_campaign_targets 문서 경로. 실패 시 보상 삭제 대상. */
  createdTargetRefPaths: string[];
  dryRun: boolean;
  shortfall: number;
  shortfallDiscovery: { triggered: boolean; runId?: string; candidatesFound?: number; errorKind?: string; blockedReason?: string };
  targets: ReturnType<typeof redactedProgramTargetResponse>[];
};

/**
 * W8-11a: 프로그램 KPI 대상 준비의 **본체**. 예전에는 이 로직이 콜러블 안에만 있어서 운영자가
 * 위저드에서 "KPI 대상 준비"를 따로 눌러야 했고(대기·재클릭·지문 불일치), 그 사이 준비 수와
 * createCampaign 의 exact-match 요구가 어긋나 실제 발송이 0건이었다. 이제 콜러블과 createCampaign
 * (라이브 경로)이 **같은 본체**를 호출한다 — 준비는 검토 대기열 생성에 흡수된다.
 *
 * `allowShortfallDiscovery`: 부족분 scoped discovery 는 준비 콜러블에서만 허용한다. 라이브 생성
 * 경로에서는 스코프 혼입 방지를 위해 discovery 를 금지한 기존 설계를 그대로 지킨다(W8-11d) —
 * 대신 부족 사실을 카운트로 정직하게 돌려준다.
 */
async function prepareProgramCampaignTargetsCore(input: {
  programId: string;
  program: Record<string, unknown>;
  programRefPath: string;
  data: Record<string, unknown>;
  uid: string;
  role: Role;
  remainingKpi: number;
  allowShortfallDiscovery: boolean;
  /**
   * R17-4 [W9-1]: 프로그램 KPI 를 **준비량 상한**으로 쓸지. 기본은 true(기존 동작 유지).
   * 쿼터 기반 자동 보충에서만 false 로 내려온다 — 아래 주석 참조.
   */
  kpiClampsTotal?: boolean;
  /**
   * R31-1 [운영 실사고 2026-07-31]: 이 준비가 속한 캠페인 id. 이 스코프의 `campaign_candidates`
   * (발굴이 실제로 적재하는 컬렉션)를 candidate_pool 과 함께 읽어 합류시킨다. 비어 있으면
   * `data.campaignId` 로 폴백하고, 그것도 없으면 종전과 완전히 동일하게 candidate_pool 만 읽는다.
   */
  campaignScopeId?: string;
  /** Automatic refill may narrow its own bounded source windows to fit the current deadline. */
  scanLimitOverride?: number;
  /** Operation-scoped reader supplied only by the private live-wave caller. */
  readSuppression?: (target: CampaignTarget) => Promise<MailSuppressionHit>;
  /** Private handoff for successfully persisted ready selections; never exposed in callable output. */
  consumptionTargetSink?: CampaignTarget[];
}): Promise<ProgramCampaignTargetPreparation> {
  const { programId, program, data, uid, role, remainingKpi } = input;
  const liveCap = await readLiveCampaignWaveCap();
  const requestedTotal = typeof data.total === "number" && Number.isFinite(data.total) ? Math.max(1, Math.round(data.total)) : liveCap || 50;
  // R17-4 [W9-1]: 프로그램 KPI 는 **정지 조건**이지 발송 스로틀이 아니다. 쿼터 기반 자동 캠페인에서
  // remainingKpi 가 준비량 상한으로 들어가면 kpiTarget=5 짜리 프로그램이 쿼터 150 캠페인의 보충을
  // 매 pass 5건으로 조른다(2026-07-29 운영 실측 — kpiTarget 을 올려 임시 해소했다).
  // ⚠️ 여기서 빼는 것은 **상한뿐**이다. 정지(remainingKpi<=0 → campaign_targets_kpi_filled)는
  // 호출부 두 곳에 그대로 있고 승인 시점 방어도 무접촉이다 — 둘을 같이 풀면 KPI 초과 발송이 된다.
  const kpiCeiling = input.kpiClampsTotal === false ? Number.POSITIVE_INFINITY : remainingKpi;
  const total = Math.min(requestedTotal, liveCap || requestedTotal, CAMPAIGN_OUTREACH_QUEUE_LIMIT, kpiCeiling);
  const requestedScanLimit = numberField(data, "targetScanLimit", 0);
  // W8-11b: 후보 스캔 폭은 KPI(total)와 무관하다 — 준비 수만 total 로 제한한다.
  const scanLimit = input.scanLimitOverride && input.scanLimitOverride > 0
    ? Math.min(CAMPAIGN_TARGET_SCAN_LIMIT, Math.max(1, Math.round(input.scanLimitOverride)))
    : campaignTargetScanWidth(requestedScanLimit, await readCampaignTargetScanFloor());
  const programDiscoveryPolicy = resolveProgramDiscoveryCriteria(program, data);
  const includeKeywords = stringArrayField(programDiscoveryPolicy.criteria.keywords, 40);
  const excludeKeywords = stringArrayField(programDiscoveryPolicy.criteria.excludeKeywords, 40);
  const targetCountries = countryArrayField(programDiscoveryPolicy.criteria.regions);
  const categories = stringArrayField(programDiscoveryPolicy.criteria.categories, 30);
  const minFollowers = Math.max(0, Math.round(programDiscoveryPolicy.criteria.minFollowers));
  const maxFollowers = Math.max(0, Math.round(programDiscoveryPolicy.criteria.maxFollowers));
  const targetCountryMix = countryMixField(data.targetCountryMix, targetCountries);
  const keywordFallbackEnabled = programDiscoveryPolicy.criteria.keywordFallbackEnabled;
  const allowInflyOverlap = campaignAllowsInflyOverlap(data);
  // W15: 준비 경로도 캠페인 플래그를 그대로 따른다(예전에는 두 호출부가 false 하드코딩이라
  // 프로그램 스코프 정책이 이 경로에서 죽어 있었다). 읽는 위치는 infly 플래그와 동형이다.
  const allowResendInProgram = campaignAllowsResendInProgram(data);
  // 헤세 결정 2026-09-16: 이 준비 호출 1건당 한 번만 해소한다(후보별 재호출 금지). 아래 자격 판정의
  // crossProgramCandidatesAllowed와 "이미 컨택" 판정(touchEvidenceAllowResendInProgram)이 모두 쓴다.
  // 캠페인이 명시적으로 요청한 allowResendInProgram(위, 감사/응답에 그대로 보존)은 건드리지 않는다.
  const outreachDedupScope = resolveOutreachDedupScope(await readSettings());
  const crossProgramCandidatesAllowed = outreachDedupScope === "program";
  const touchEvidenceAllowResendInProgram = allowResendInProgram || crossProgramCandidatesAllowed;
  const dryRun = data.dryRun === true || data.auditOnly === true;
  const nowIsoValue = nowIso();

  // R31-1 [운영 실사고 2026-07-31 · 블로커]: 준비 경로는 지금까지 전역 `candidate_pool` 만 읽었다.
  // 그런데 오늘의 발굴 산출물은 `campaign_candidates` 에만 쌓인다(discovery persistCandidates 의
  // scoped 분기) — 즉 **신규 발굴이 발송에 구조적으로 도달하지 못했다**(refill 이 매 pass
  // campaign_targets_all_already_touched, 운영 실측: pool 2,374건 전원 기컨택 / 신선 후보는 미조회).
  // R23-0 이 라이브 **소비** 경로에서 고친 것과 같은 클래스의 이음매가 **준비** 경로에 남아 있었다.
  // 이 문서는 이미 프로그램·캠페인 스코프이므로 "전역 풀 직접 사용 금지" 규칙과 다른 대상이고,
  // 자격·국가·suppression·safety·전역 dedup 게이트는 아래 체인에서 종전대로 전부 통과한다.
  const campaignScopeId = (input.campaignScopeId ?? stringField(data, "campaignId", "")).trim().slice(0, 120);
  const prepareStateId = prepareRotationStateId(programId, campaignScopeId);
  // Preparation retains rows without an email so their shape failure stays observable.  Its
  // bounded cursor therefore uses the stable document id, unlike live refill's email cursor.
  const campaignCandidateCursor = campaignScopeId
    ? await readPrepareCampaignCandidateCursor(prepareStateId, CAMPAIGN_CANDIDATE_FRESH_STAGE)
    : "";
  const campaignScopedQuery = campaignScopeId
    ? adminDb.collection(CAMPAIGN_CANDIDATES_COLLECTION)
      .where("campaignId", "==", campaignScopeId)
      .where("stage", "==", CAMPAIGN_CANDIDATE_FRESH_STAGE)
      .orderBy(FieldPath.documentId())
      .limit(scanLimit)
    : null;
  const [recentSnapshot, fallbackSnapshot, campaignScopedSnapshot] = await Promise.all([
    adminDb.collection("candidate_pool").orderBy("updatedAtIso", "desc").limit(scanLimit).get()
      .catch(() => adminDb.collection("candidate_pool").limit(scanLimit).get()),
    adminDb.collection("candidate_pool").limit(scanLimit).get(),
    // NEXT-1: 준비 경로에도 같은 소비 표시 필터(위 두 곳과 동형). Limit-only scans
    // starve later rows, so rotate the bounded document-id window without dropping no-email rows.
    campaignScopedQuery ? rotatingWindow(campaignScopedQuery, campaignCandidateCursor) : null,
  ]);
  // Advance as soon as a page was read.  Later eligibility, suppression, or safety failures must
  // not pin the next preparation pass to this same page. dryRun/auditOnly remains read-only.
  if (!dryRun && campaignScopedSnapshot) {
    await writePrepareCampaignCandidateCursor(
      prepareStateId,
      CAMPAIGN_CANDIDATE_FRESH_STAGE,
      nextScanCursor(campaignScopedSnapshot, scanLimit) as string,
      nowIsoValue,
    );
  }
  const recentIds = new Set(recentSnapshot.docs.map((doc) => doc.id));
  // R17-5: 오염 밴드를 후순위로 밀고 남은 자리를 폴백에서 채운다(읽기 횟수 불변).
  const prioritizedCandidates = prioritizeEmailCapableCandidateDocs([
    ...recentSnapshot.docs,
    ...fallbackSnapshot.docs.filter((doc) => !recentIds.has(doc.id)),
  ], scanLimit);
  const candidateDocs = prioritizedCandidates.docs;
  // R31-2 [볼륨 레버]: 자격 판정의 키워드/카테고리 요구를 캠페인 플래그로 분리한다.
  // 이 `keywords` 의 출처는 캠페인의 **검색용** includeKeywords 다(resolveProgramDiscoveryCriteria) —
  // "YouTube 에서 무엇으로 검색할까"와 "이미 발굴된 후보가 메일 받을 자격이 있나"를 한 필드가 겸하는
  // 구조라, 전역 풀 이메일 보유 1,690명이 emailReady 75명으로 잘렸다(사용자 확정 타깃 기준은
  // 국가 무관·팔로워 하한뿐). 기본값 "on" 은 현행 동작 100% 유지이고, "off" 일 때만 **자격 판정에
  // 넘기는** 키워드/카테고리를 빈 배열로 만든다. 검색용 includeKeywords 는 무접촉 —
  // 아래 triggerScopedCampaignDiscovery 는 종전대로 includeKeywords/categories 로 검색한다.
  // ⚠️ 자격 판정은 두 곳이다: evaluateProgramCampaignCandidateEligibility 와 그 뒤의 include 매치
  // 필터(keywordMatchedTargets). keywordFallbackEnabled 기본값이 false 라 후자도 **하드 컷**이므로,
  // 앞만 열면 레버가 아무 효과도 없다(값 프로브로 확인). excludeKeywords·팔로워·국가·suppression·
  // dedup·상한은 off 에서도 전부 그대로다.
  const eligibilityKeywordGate = eligibilityKeywordGateEnabled(data.targetingCriteria);
  const eligibilityKeywords = eligibilityKeywordGate ? includeKeywords : [];
  const eligibilityCategories = eligibilityKeywordGate ? categories : [];
  const eligibilityCriteria = {
    keywords: eligibilityKeywords,
    excludeKeywords,
    regions: targetCountries,
    categories: eligibilityCategories,
    minFollowers,
    maxFollowers,
  };
  const poolEvaluations = candidateDocs.map((doc) => {
    const candidateIdentity = globalCandidateIdentityFromCandidateDoc(doc);
    const eligibility = evaluateProgramCampaignCandidateEligibility({
      programId,
      candidate: candidateIdentity,
      criteria: eligibilityCriteria,
      crossProgramCandidatesAllowed,
    });
    return { target: { ...campaignTargetFromCandidateDoc(doc), programScopeEvidence: eligibility }, eligibility };
  });
  // R31-1: 캠페인 스코프 후보 합류. 중복은 **이메일 정규화 값** 기준으로 접는다(같은 사람이 두
  // 컬렉션에 있으면 1명) — 매핑은 기존 campaignTargetFromCampaignCandidateDoc 재사용(새 매퍼 0).
  const joinedSeenEmails = new Set(
    poolEvaluations.map((item) => validEmailField(item.target.email)).filter(Boolean),
  );
  const campaignScopedDocs = campaignScopedSnapshot?.docs ?? [];
  const campaignScopedEvaluations: typeof poolEvaluations = [];
  let joinedDroppedMissingFields = 0;
  let joinedDuplicateEmail = 0;
  for (const doc of campaignScopedDocs) {
    const data = doc.data();
    if (!campaignCandidateAllowedForLiveRefill(isRecord(data) ? data as Record<string, unknown> : {})) continue;
    const target = campaignTargetFromCampaignCandidateDoc(doc);
    const recipient = validEmailField(target.email);
    if (!recipient || !target.id) {
      // 조용히 버리지 않는다 — shape 차이로 흘린 후보 수가 보여야 다음 이음매를 짚을 수 있다.
      joinedDroppedMissingFields += 1;
      continue;
    }
    if (joinedSeenEmails.has(recipient)) {
      joinedDuplicateEmail += 1;
      continue;
    }
    joinedSeenEmails.add(recipient);
    const eligibility = evaluateProgramCampaignCandidateEligibility({
      programId,
      // ⚠️ globalCandidateIdentityFromCandidateDoc 은 **candidate_pool 문서 전용**이다(문서 id 를
      // candidateId 로, doc.ref.path 를 candidateRef 로 강제하고 신원 일치를 검증한다) —
      // campaign_candidates 문서에 쓰면 "candidateRef does not match candidate identity" 로 준비
      // 자체가 죽는다. 자격 판정이 읽는 값은 스코프·국가·팔로워·텍스트뿐이라 문서를 그대로 넘긴다.
      candidate: data,
      criteria: eligibilityCriteria,
      crossProgramCandidatesAllowed,
      // P0-1: trust the write-time bypass this specific migrated doc already carries (above
      // campaignCandidateAllowedForLiveRefill gate already required its migration verdict to be
      // "pass") — this re-evaluation uses the campaign's *current* real keyword criteria, which
      // would otherwise re-reject the same candidate every pass.
      keywordGateBypass: target.keywordGateBypassed === true,
    });
    campaignScopedEvaluations.push({ target: { ...target, programScopeEvidence: eligibility }, eligibility });
  }
  const candidateEvaluations = [...poolEvaluations, ...campaignScopedEvaluations];
  const candidates = candidateEvaluations.filter((item) => item.eligibility.eligible).map((item) => item.target);
  const programScopeRejected = candidateEvaluations.length - candidates.length;
  const keywordMismatchRejected = candidateEvaluations
    .filter((item) => !item.eligibility.eligible
      && (item.eligibility.reason === "keyword_mismatch" || item.eligibility.reason === "category_mismatch"))
    .length;
  // R33-1 [적대적 리뷰 LOW-1]: 거부 사유별 분포. 총계만으로는 "자격에서 막혔다"까지만 알 수 있고
  // **어느 조건**인지는 운영에서 볼 수 없었다(오늘 정체 진단이 정확히 여기서 막혔다).
  const programScopeRejectedReasons = candidateEvaluations.reduce<Record<string, number>>((counts, item) => {
    if (item.eligibility.eligible) return counts;
    const reason = typeof item.eligibility.reason === "string" && item.eligibility.reason
      ? item.eligibility.reason
      : "unknown";
    counts[reason] = (counts[reason] ?? 0) + 1;
    return counts;
  }, {});
  const baseFilteredTargets = candidates.filter((target) => {
    if (targetCountries.length > 0 && !targetCountries.includes((target.region ?? "").toUpperCase())) return false;
    if (excludeKeywords.length > 0 && targetMatchesAny(target, excludeKeywords)) return false;
    return true;
  });
  const hasIncludeMatchTerms = eligibilityCategories.length > 0 || eligibilityKeywords.length > 0;
  const keywordMatchedTargets = hasIncludeMatchTerms
    ? baseFilteredTargets.filter((target) => targetMatchesCampaignIncludes(
      target,
      eligibilityCategories,
      eligibilityKeywords,
    ))
    : baseFilteredTargets;
  const filteredTargets = keywordFallbackEnabled && hasIncludeMatchTerms
    ? [
      ...keywordMatchedTargets,
      ...baseFilteredTargets.filter((target) => !targetMatchesCampaignIncludes(
        target,
        eligibilityCategories,
        eligibilityKeywords,
      )),
    ]
    : keywordMatchedTargets;
  const emailReadyTargetsAll = filteredTargets.filter(hasValidTargetEmail);
  // P0-2 [운영 실측]: 전역 도달성 캐시가 **이미 undeliverable 로 판정한** 수신자는 여기서 걸러낸다.
  //   종전에는 발송 워커 게이트(chat-ai.ts W51)에서만 막아서 캐시 적중 undeliverable 후보가 매 pass
  //   선택·승인까지 갔다가 skipped_undeliverable 로 끝났다 — 평가 예산·회전 창·기컨택 증거 읽기를
  //   전부 낭비했다. **캐시 읽기 전용**이다 — 미스/만료/risky/unknown 은 통과시켜 발송 시점
  //   Bouncer 게이트로 위임한다(선택 시점에 후보당 1크레딧을 태우지 않는다). 회전 **앞**에 두어
  //   skip 된 후보가 회전 순번·평가 창을 먹지 않게 한다.
  const deliverability = await dropCachedUndeliverableTargets(emailReadyTargetsAll);
  const emailReadyTargetsPool = deliverability.targets;
  const deliverabilityCachedSkipped = deliverability.skipped;
  // F5②(COST-P0): suppression 은 후보 1건당 문서 읽기 2 + 쿼리 2, safety 평가는 2회다. 스캔 폭을
  // 요청 수에서 분리한 뒤에는 email-ready 가 수백~수천이 될 수 있어 전량 평가하면 60s/512MiB 런타임을
  // 넘긴다. 필요한 것은 total 을 채울 만큼이므로 상수배로 절단하고, 절단 사실을 카운트로 남긴다.
  // R33-2 [운영 정체의 진범 · 값으로 확정]: 예전에는 이 예산을 `slice(0, evaluationBound)` 로 잘랐다 —
  // **기컨택 필터보다 먼저** 자르므로, 스캔 앞머리가 전부 기컨택이면 미컨택 후보가 아무리 많아도
  // 창에 한 명도 들어오지 못하고 준비가 영구 0건이 된다. 앞머리가 기컨택인 것은 우연이 아니라
  // 구조다 — R33-3 [INFO-1 리뷰 정정]: **컨택은 candidate_pool.updatedAtIso 를 갱신하지 않는다**
  // (컨택 경로의 candidate_pool 쓰기 0건, 리뷰어 코드 전수 확인). 정확한 기전은 이렇다:
  // 풀이 정체되면 `updatedAtIso desc` 정렬이 **동결**되고, 준비는 매 pass 같은 앞머리부터 다시
  // 시작한다 → 그 구간이 컨택을 거듭할수록 기컨택으로 포화된다(자기강화가 아니라 정렬 동결이 원인).
  // 진단 실측(tests/campaign-prepare-stall-diagnosis.test.mjs H1): 이메일 보유 25 · 예산 21 ·
  // 기컨택 22 → sendable 21 전원 기컨택 → selected 0, 미컨택 3명은 읽히지도 않았다.
  // 운영 형상도 같다: 기컨택 292 >= 예산(총 50 기준 200) → 준비가 85 에서 얼어붙고 미컨택 ~1,400 명이
  // 대기했다. 그래서 예산을 **미컨택 후보로 채운다** — 정책은 그대로고(같은 필터 함수), 무엇을 비싼
  // 평가에 넣을지의 순서만 고친다. 스캔량은 청크 상한으로 유계다(COST-P0 유지).
  const evaluationBound = Math.max(total * 4, total + 20);
  // W78-①③: 매 pass 같은 앞머리에서 시작하면 기발송자가 창을 영구 독점한다. 원장에 남긴
  //   오프셋만큼 회전시켜 **이번 pass 는 그 다음부터** 본다(읽기 증가 0 — 메모리 회전이다).
  // W78-③ 감사 재현: dryRun 은 커서를 저장하지 않으므로, 다음 pass 시작점을 명시로 주입해
  //   "연속 pass 가 서로 다른 구간을 보는가"를 프로드 데이터로 확인할 수 있어야 한다.
  //   **dryRun 에서만** 받는다 — 실행 경로가 외부 값으로 순번을 건너뛰면 안 된다.
  const rotationOverride = dryRun && typeof data.evaluationRotationOffsetOverride === "number"
    && Number.isFinite(data.evaluationRotationOffsetOverride)
    ? Math.max(0, Math.trunc(data.evaluationRotationOffsetOverride))
    : null;
  const rotationOffset = rotationOverride
    ?? await readPrepareRotationOffset(prepareRotationStateId(programId, campaignScopeId));
  const rotatedEmailReadyTargets = rotateEvaluationOrder(emailReadyTargetsPool, rotationOffset);
  const evaluationWindow = await selectUntouchedEvaluationWindow(
    rotatedEmailReadyTargets,
    evaluationBound,
    { programId, allowResendInProgram: touchEvidenceAllowResendInProgram },
  );
  const quarantine = await readProgramTargetSafetyQuarantine(programId, evaluationWindow.targets);
  const emailReadyTargets = evaluationWindow.targets.filter(
    (target) => !targetDedupKeys(target).some((key) => quarantine.blockedKeys.has(key)),
  );
  const safetyQuarantinedSkipped = quarantine.skipped;
  // R33-3 [MEDIUM-1 관측 회귀 정정]: 이 값은 **순수 예산 절단량**이다(운영자가 "평가 예산이 모자란다"
  // 로 읽는 값). emailReadyTargets 는 이제 "예산으로 자른 앞부분"이 아니라 "미컨택으로 채운 창"이라,
  // `all - targets` 로 세면 기컨택 스킵량까지 뭉개져 예산 절단이 0인 pass 에서도 큰 값이 나온다
  // (실측: 절단 0인데 22, 최악 26). 창을 채우려고 실제로 훑은 양(scanned) 밖에 남은 것만 센다 —
  // 기컨택 스킵량은 untouchedWindowSkipped 가 따로 담당한다(두 값의 의미가 겹치지 않는다).
  const evaluationTruncated = Math.max(0, emailReadyTargetsPool.length - evaluationWindow.scanned);
  // W78-③: 이번 pass 가 훑은 만큼 시작점을 전진시킨다. 절단분(evaluationTruncated)이
  //   **다음 pass 의 앞머리**가 되므로, 절단이 영구 손실이 아니라 순번 대기로 바뀐다.
  //   한 바퀴를 돌면 자연히 처음으로 감긴다(rotateEvaluationOrder 가 모듈로 처리한다).
  //
  //   ⚠️ **dryRun/auditOnly 에서는 쓰지 않는다.** 감사는 "지금 무엇이 나갈 뻔했나"를 보는
  //   읽기 전용 경로다. 여기서 커서를 전진시키면 감사를 한 번 돌릴 때마다 실제 준비 순번이
  //   밀려, 관측 행위가 운영 상태를 바꾼다. 감사 결과의 재현성도 사라진다.
  const rotationAdvance = (rotationOffset + evaluationWindow.scanned)
    % Math.max(1, emailReadyTargetsPool.length);
  if (!dryRun && emailReadyTargetsPool.length > 0 && evaluationWindow.scanned > 0) {
    await writePrepareRotationOffset(prepareRotationStateId(programId, campaignScopeId), rotationAdvance, nowIso());
  }
  const suppressionChecks = await mapWithConcurrency(emailReadyTargets, CAMPAIGN_CANDIDATE_IO_CONCURRENCY, "prepare_suppression", async (target) => ({
    target,
    suppression: await (input.readSuppression ? input.readSuppression(target) : findMailSuppression(liveTargetSuppressionLookup(target))),
  }));
  const sendableTargets = suppressionChecks
    .filter((item) => !mailSuppressionBlocksSend(item.suppression, { allowInflyOverlap }))
    .map((item) => item.target);
  const safetyProbeId = `program-target-prep-${Date.now().toString(36)}`;
  const gameId = stringField(data, "gameId", "scp-automation");
  const profileResolution = await resolveMailProfile({
    campaignId: safetyProbeId,
    programId,
    gameId,
    intent: "campaign_outreach",
    baseIso: nowIsoValue,
    campaignOverride: {
      id: safetyProbeId,
      programId,
      gameId,
      ...(isRecord(data.mailProfile) ? { mailProfile: data.mailProfile } : {}),
      ...(isRecord(data.mailProfiles) ? { mailProfiles: data.mailProfiles } : {}),
      createdBy: uid,
      createdByRole: role,
      createdAtIso: nowIsoValue,
      updatedAtIso: nowIsoValue,
    },
  });
  const programColdMail = isRecord(program.coldMail) ? (program.coldMail as Record<string, unknown>) : null;
  const safetyChecks = await mapWithConcurrency(sendableTargets, CAMPAIGN_CANDIDATE_IO_CONCURRENCY, "prepare_mail_safety", async (target) => {
    const vars = {
      name: target.name,
      creator: target.name,
      game: stringField(program, "title", stringField(program, "name", "Super Creator Partners")),
      campaign: stringField(program, "title", stringField(program, "name", "Super Creator Partners")),
      owner: "supercent scp",
      creatorName: target.name,
      channelName: target.handle ?? target.name,
      gameTitle: gameId,
      campaignName: stringField(program, "title", stringField(program, "name", "Super Creator Partners")),
      country: target.region ?? "",
      senderName: "Supercent",
    };
    const coldMailPick = pickColdMailTemplate(programColdMail, target.region ?? "");
    const subject = coldMailPick ? fillTemplateVars(coldMailPick.subject, vars) : `[Supercent] ${vars.campaign} 협업 제안`;
    const body = coldMailPick ? fillTemplateVars(coldMailPick.body, vars) : renderMailTemplate(profileResolution.templateSnapshot, vars);
    const safetyInput = {
      to: validEmailField(target.email),
      creatorEmail: target.email ?? "",
      creatorHandle: target.handle ?? "",
      creatorName: target.name,
      creatorCategory: target.category ?? "",
      creatorPlatform: target.platform ?? "",
      creatorRegion: target.region ?? "",
      allowInflyOverlap,
      dryRun: true,
      liveSend: false,
      subject,
      body,
      text: `${target.name} ${target.category ?? ""} ${target.platform ?? ""} ${validEmailField(target.email)}`,
    };
    const [profileSafety, hardSafety] = await Promise.all([
      evaluateMailProfileSafety(safetyInput, "campaignTargetPrepare", profileResolution),
      evaluateMailSafety(safetyInput, "campaignTargetPrepare", "manual_send"),
    ]);
    const safety = combineCampaignTargetSafety(profileSafety, hardSafety);
    const needsHumanReview = safety.ruleId === "mail-safety.human-approval-required";
    return { target, safety, queueable: safety.allowed || needsHumanReview };
  });
  const safetyBlockedItems = safetyChecks.filter((item) => !item.queueable);
  const safetyReadyTargets = safetyChecks.filter((item) => item.queueable).map((item) => item.target);
  const safetyBlockedSkipped = safetyBlockedItems.length;
  // W78 [R1-P0-A]: **감사(dryRun/auditOnly)는 읽기 전용이어야 한다.**
  //   이 호출에 게이트가 없어서 auditOnly 실행이 program_campaign_targets 에 blocked 행을
  //   실제로 만들었다. 그러면 "지금 무엇이 나갈 뻔했나"를 보는 관측이 대상 상태를 바꾸고,
  //   같은 감사를 두 번 돌리면 두 번째는 첫 번째가 만든 격리를 다시 읽는다(재현성 소실).
  //   내가 낸 감사 증거표도 엄밀히는 읽기 전용 산물이 아니었다 — 그 전제부터 고친다.
  if (!dryRun) {
    await markProgramTargetsSafetyBlocked(
      programId,
      safetyBlockedItems.map((item) => ({ target: item.target, safety: item.safety })),
      nowIsoValue,
      "programTargetPrepare.safetyPrefilter",
    );
  }
  const untouchedResult = await filterUntouchedCampaignTargets(safetyReadyTargets, { programId, allowResendInProgram: touchEvidenceAllowResendInProgram });
  const recipientUniqueResult = dedupeCampaignTargetsByRecipient(untouchedResult.targets);
  const selected = selectBalancedCampaignTargets(recipientUniqueResult.targets, total, targetCountries, targetCountryMix);
  // TASK 3 self-healing target pool: when the existing candidate_pool cannot fill the requested
  // wave, automatically trigger program-scoped discovery (the same R5-A engine createCampaign uses)
  // so the pool refills and the next preparation pass completes. Discovery failure never fails the
  // preparation itself — it is reported in the response for the operator.
  const shortfall = Math.max(0, total - selected.length);
  let shortfallDiscovery: ProgramCampaignTargetPreparation["shortfallDiscovery"] = { triggered: false };
  if (shortfall > 0 && !dryRun && !input.allowShortfallDiscovery) {
    // W8-11d: 라이브 생성 경로는 scoped discovery 를 발동하지 않는다(스코프 혼입 방지 설계 유지).
    shortfallDiscovery = { triggered: false, blockedReason: "scoped_discovery_not_allowed_in_live_wave" };
  } else if (shortfall > 0 && !dryRun) {
    try {
      const discovery = await triggerScopedCampaignDiscovery({
        campaignId: safetyProbeId,
        programId,
        programPolicyRef: input.programRefPath,
        candidateCriteriaSnapshot: programDiscoveryPolicy.candidateCriteria,
        eligibilityCriteriaSnapshot: programDiscoveryPolicy.eligibilityCriteria,
        gameId,
        keywords: includeKeywords,
        categories,
        excludeKeywords,
        countryTargeting: programDiscoveryPolicy.countryTargeting,
        regions: targetCountries,
        minFollowers,
        maxFollowers,
        recentActivityDays: programDiscoveryPolicy.criteria.recentActivityDays,
        actorUserId: uid,
        actorRole: role,
        backfillExistingPool: true,
        resultCap: Math.min(CAMPAIGN_OUTREACH_QUEUE_LIMIT, Math.max(shortfall * 2, shortfall)),
      });
      shortfallDiscovery = { triggered: true, runId: discovery.runId, candidatesFound: discovery.candidates.length };
    } catch (error) {
      const failure = safeOutboundFailureEvidence(error, "program_target_prep_discovery");
      console.error("[program-target-prep] shortfall discovery failed", { programId, failureKind: failure.failureKind });
      shortfallDiscovery = { triggered: false, errorKind: failure.failureKind };
    }
  }
  const refs = selected.map((target) => adminDb.collection(PROGRAM_CAMPAIGN_TARGETS_COLLECTION).doc(programTargetDocId(programId, target)));
  const existingSnapshots: DocumentSnapshot[] = [];
  await runRefillPhase("prepare_target_read", () => forEachSequentialChunk(
    refs,
    PREPARE_TARGET_PERSISTENCE_CHUNK_SIZE,
    async (refChunk) => {
      existingSnapshots.push(...await adminDb.getAll(...refChunk));
    },
  ));
  const prepared: CampaignTarget[] = [];
  const createdTargetRefPaths: string[] = [];
  const createWrites: Array<{ ref: DocumentReference; data: Record<string, unknown> }> = [];
  let existing = 0;
  selected.forEach((target, index) => {
    if (existingSnapshots[index]?.exists) {
      existing += 1;
      return;
    }
    const ref = refs[index];
    prepared.push({ ...target, programTargetId: ref.id, source: "program" });
    createdTargetRefPaths.push(ref.path);
    createWrites.push({
      ref,
      data: stripUndefinedFields({
        id: ref.id,
        programId,
        status: "ready",
        candidateId: target.candidateId,
        creatorId: target.creatorId,
        source: target.campaignCandidateRef ? "campaign_candidates" : "candidate_pool_existing",
        sourceRef: target.sourceRef ?? (target.candidateId ? `candidate_pool/${target.candidateId}` : ""),
        candidateRef: target.candidateRef ?? (target.candidateId ? `candidate_pool/${target.candidateId}` : ""),
        campaignCandidateRef: target.campaignCandidateRef,
        sourceRunId: target.sourceRunId,
        sourceRunRef: target.sourceRunRef,
        canonicalProgramId: resolveCanonicalProgramId(programId),
        programScopeEvidence: target.programScopeEvidence,
        programPolicyRef: input.programRefPath,
        candidateCriteriaSnapshot: programDiscoveryPolicy.candidateCriteria,
        eligibilityCriteriaSnapshot: programDiscoveryPolicy.eligibilityCriteria,
        name: target.name,
        email: validEmailField(target.email),
        handle: target.handle ?? "",
        youtubeUrl: target.youtubeUrl ?? "",
        avatar: target.avatar ?? "",
        platform: target.platform ?? "YouTube",
        followers: target.followers ?? 0,
        region: target.region ?? "",
        category: target.category ?? "",
        publicDescription: target.publicDescription ?? "",
        matchedSearchTerms: target.matchedSearchTerms ?? [],
        selectedForKpi: true,
        targetMetric: stringField(program, "kpiMetric", "approved"),
        selectedBy: uid,
        selectedByRole: role,
        selectedAtIso: nowIsoValue,
        createdAtIso: nowIsoValue,
        updatedAtIso: nowIsoValue,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }),
    });
  });
  if (!dryRun && createWrites.length > 0) {
    const rollbackRefPaths: string[] = [];
    try {
      await runRefillPhase("prepare_target_write", () => forEachSequentialChunk(
        createWrites,
        PREPARE_TARGET_PERSISTENCE_CHUNK_SIZE,
        async (writeChunk) => {
          const writeRefPaths = writeChunk.map((write) => write.ref.path);
          const batch = adminDb.batch();
          for (const write of writeChunk) batch.create(write.ref, write.data);
          // R36-5: DEADLINE_EXCEEDED면 서버 commit 여부가 불확정이다. 성공 응답 뒤가 아니라 RPC
          // 시도 직전에 넣어, 실패한 현재 청크까지 멱등 delete 보상 대상에 포함한다.
          rollbackRefPaths.push(...writeRefPaths);
          await batch.commit();
        },
      ));
    } catch (error) {
      await rollbackPreparedProgramTargets(
        rollbackRefPaths,
        "program_target_persistence_chunk_failed",
        error,
      );
      throw error;
    }
  }

  // Private live-wave handoff: only committed new rows or authoritative existing ready rows may be consumed now.
  if (!dryRun && input.consumptionTargetSink) {
    selected.forEach((target, index) => {
      const existingData = existingSnapshots[index]?.data();
      if (!existingSnapshots[index]?.exists || stringField(existingData ?? {}, "status", "ready") === "ready") {
        input.consumptionTargetSink!.push({ ...target, programTargetId: refs[index].id, source: "program" });
      }
    });
  }

  // 26-08-28: 산출의 출처를 가른다. campaignScoped 유래를 식별자(정규화 이메일 우선, 없으면 id)로
  //   집합에 담고 selected 를 대조한다 — 두 소스가 같은 사람을 담을 수 있어 **이메일 기준**이
  //   조인 dedup 규약(joinedSeenEmails)과 같은 축이다.
  const campaignScopedIdentityKeys = new Set(
    campaignScopedEvaluations.map((item) => validEmailField(item.target.email) || item.target.id).filter(Boolean),
  );
  const selectedFromCampaignCandidates = selected.filter(
    (target) => campaignScopedIdentityKeys.has(validEmailField(target.email) || target.id),
  ).length;

  return {
    requested: total,
    requestedBeforeKpiCap: requestedTotal,
    selectedFromCampaignCandidates,
    selectedFromProgramTargets: selected.length - selectedFromCampaignCandidates,
    remainingKpi,
    scanned: candidates.length,
    scannedRaw: candidateEvaluations.length,
    programScopeRejected,
    keywordMismatchRejected,
    programScopeRejectedReasons,
    poolScanned: poolEvaluations.length,
    campaignScopedScanned: campaignScopedDocs.length,
    joinedCampaignScoped: campaignScopedEvaluations.length + joinedDuplicateEmail,
    joinedUnique: campaignScopedEvaluations.length,
    joinedDroppedMissingFields,
    untouchedWindowScanned: evaluationWindow.scanned,
    // W78-③ 감사용: 이번 pass 의 시작점과 다음 pass 가 쓸 시작점. dryRun 에서는 저장하지
    //   않으므로 이 값으로 커서 전진을 **메모리에서** 시뮬레이션해 재현할 수 있다.
    evaluationRotationOffset: rotationOffset,
    evaluationRotationNext: rotationAdvance,
    // W78-② 감사용: 상태 의존 사유로 격리에서 풀린 수(dryRun 이면 "풀렸을" 수).
    staleQuarantineReleased: quarantine.staleQuarantineReleased ?? 0,
    untouchedWindowSkipped: evaluationWindow.skipped,
    filtered: filteredTargets.length,
    emailReady: emailReadyTargetsAll.length,
    sendable: sendableTargets.length,
    safetyReady: safetyReadyTargets.length,
    evaluationTruncated,
    safetyBlockedSkipped,
    safetyQuarantinedSkipped,
    safetyQuarantineReadBatches: quarantine.readBatches,
    safetyQuarantineFallbackFailed: quarantine.fallbackFailed,
    ...(quarantine.fallbackErrorCode
      ? { safetyQuarantineFallbackErrorCode: quarantine.fallbackErrorCode }
      : {}),
    alreadyTouchedSkipped: untouchedResult.skipped,
    duplicateRecipientSkipped: recipientUniqueResult.skipped,
    deliverabilityCachedSkipped,
    selected: selected.length,
    prepared: dryRun ? 0 : prepared.length,
    wouldPrepare: prepared.length,
    existing,
    dryRun,
    shortfall,
    emailIncapableDeprioritized: prioritizedCandidates.deprioritized,
    shortfallDiscovery,
    createdTargetRefPaths: dryRun ? [] : createdTargetRefPaths,
    targets: prepared.slice(0, 20).map(redactedProgramTargetResponse),
  };
}

/**
 * R36-5/R37 compensation primitive. Callers pass only deterministic documents created by the
 * current refill attempt; deletes are idempotent and include a server-commit/client-timeout RPC.
 * Existing program rows and conversation roots must never be included.
 */
async function rollbackRefillDocumentPaths(
  refPaths: readonly string[],
  reason: string,
  sourceError: unknown,
): Promise<void> {
  const uniqueRefPaths = uniqueStrings([...refPaths]);
  if (uniqueRefPaths.length === 0) return;
  try {
    await forEachSequentialChunk(
      uniqueRefPaths,
      PREPARE_TARGET_PERSISTENCE_CHUNK_SIZE,
      async (pathChunk) => {
        const batch = adminDb.batch();
        for (const path of pathChunk) batch.delete(adminDb.doc(path));
        await batch.commit();
      },
    );
  } catch (error) {
    recordRefillRollbackFailure(sourceError, uniqueRefPaths.length);
    console.error("[campaign-refill] compensation rollback failed", {
      reason,
      count: uniqueRefPaths.length,
      errorName: error instanceof Error ? error.name.slice(0, 64) : typeof error,
    });
  }
}

/** F2: remove only program target rows newly prepared before the campaign write failed. */
async function rollbackPreparedProgramTargets(
  refPaths: readonly string[],
  reason: string,
  sourceError: unknown,
): Promise<void> {
  await rollbackRefillDocumentPaths(refPaths, reason, sourceError);
}

// Program/KPI target preparation for live waves. This is an engine-owned bridge:
// it may read the existing discovery candidate pool, but it writes a durable
// program-scoped target row first. createCampaign(live) then consumes only this
// program target pool, never the disconnected global candidate_pool directly.
export async function prepareProgramCampaignTargets(request: CallableRequest) {
  const uid = request.auth?.uid;
  const role = request.auth?.token?.role ?? "guest";
  const team = request.auth?.token?.team ?? "—";
  if (!uid || !CAMPAIGN_ROLES.has(role)) {
    const error = new Error(!uid ? "unauthenticated" : "permission-denied: manager role required");
    Object.assign(error, { code: !uid ? "unauthenticated" : "permission-denied" , errorCode: "prepare_program_campaign_targets_unauthorized"});
    throw error;
  }
  const data = isRecord(request.data) ? request.data : {};
  const programId = typeof data.programId === "string" ? data.programId.trim().slice(0, 120) : "";
  if (!programId) throw Object.assign(new Error("programId required"), { code: "invalid-argument", errorCode: "prepare_program_campaign_targets_program_id_required" });

  const programSnapshot = await adminDb.collection("programs").doc(programId).get();
  if (!programSnapshot.exists) throw Object.assign(new Error("program not found"), { code: "not-found", errorCode: "prepare_program_campaign_targets_program_found" });
  const program = programSnapshot.data() ?? {};
  if (stringField(program, "status", "open") !== "open") {
    throw Object.assign(new Error("failed-precondition: program is not open"), { code: "failed-precondition", errorCode: "campaign_targets_program_not_open" });
  }
  const kpiTarget = numberField(program, "kpiTarget", 0);
  const approvedCount = numberField(program, "approvedCount", 0);
  const remainingKpi = kpiTarget > 0 ? Math.max(0, kpiTarget - approvedCount) : CAMPAIGN_OUTREACH_QUEUE_LIMIT;
  if (remainingKpi <= 0) {
    throw Object.assign(new Error("failed-precondition: program KPI is already filled"), { code: "failed-precondition", errorCode: "campaign_targets_kpi_filled" });
  }

  assertMutationOwner(
    { uid, role },
    mutationOwnerUids(program, { includeCreatedBy: true }),
    "program campaign target preparation",
  );

  const preparation = await prepareProgramCampaignTargetsCore({
    programId,
    program,
    programRefPath: programSnapshot.ref.path,
    data,
    uid,
    role: role as Role,
    remainingKpi,
    allowShortfallDiscovery: true,
  });

  const behaviorLog = makeBehaviorLog(
    { uid, role, team, ip: request.rawRequest?.ip ?? "0.0.0.0" },
    `program.campaignTargets.prepare(${programId}):${preparation.prepared}`,
    "success",
  );
  behaviorLogs.push(behaviorLog);
  return {
    ok: true,
    programId,
    ...preparation,
    behaviorLog,
  };
}

export async function setMemberRole(request: CallableRequest) {
  const auth = assertAdmin(request);
  const data = isRecord(request.data) ? request.data : {};
  const memberId = cleanString(data.memberId, "", 180);
  const payloadUid = cleanString(data.uid, "", 180);
  const requestedEmail = validEmailField(data.email);
  const nextRole = data.role;

  if (!payloadUid && !memberId && !requestedEmail) throw new Error("invalid-argument: uid, memberId, or email required");
  if (!isRole(nextRole)) throw new Error("invalid-argument: role");

  const member = memberId ? await readLegacyMemberFallback(memberId) : undefined;
  const memberRef = memberId ? adminDb.collection("members").doc(memberId) : null;
  const memberSnapshot = memberRef ? await memberRef.get() : null;
  const payloadUidSnapshot = payloadUid && payloadUid !== memberId ? await adminDb.collection("members").doc(payloadUid).get() : null;
  const persistedMember = memberSnapshot?.exists
    ? memberSnapshot.data() ?? {}
    : payloadUidSnapshot?.exists
      ? payloadUidSnapshot.data() ?? {}
      : {};
  const persistedUid = cleanString(persistedMember.uid, "", 180);

  let targetUid = payloadUid || persistedUid;
  let claimSyncReason = payloadUid ? "explicit_uid" : persistedUid ? "persisted_member_uid" : "awaiting_oauth_login";
  let targetUser = targetUid ? await getAuthUserByUid(targetUid) : null;

  // Allow legacy member docs whose document id is already the Firebase Auth uid.
  if (!targetUid && memberId) {
    const memberIdUser = await getAuthUserByUid(memberId);
    if (memberIdUser) {
      targetUid = memberIdUser.uid;
      targetUser = memberIdUser;
      claimSyncReason = "member_id_is_uid";
    }
  }

  const memberEmail = validEmailField(member?.email) || validEmailField(persistedMember.email) || requestedEmail || validEmailField(targetUser?.email);
  if (!targetUid && memberEmail) {
    const emailUser = await getAuthUserByEmail(memberEmail);
    if (emailUser) {
      targetUid = emailUser.uid;
      targetUser = emailUser;
      claimSyncReason = "email_uid_resolved";
    }
  }
  if (targetUid && !targetUser) targetUser = await getAuthUserByUid(targetUid);

  const currentClaimRole = claimRoleFromUser(targetUser);
  const currentRole = member?.role
    ?? (isRole(persistedMember.role) ? persistedMember.role : undefined)
    ?? currentClaimRole;
  const targetCurrentlyPrivileged = Boolean(
    (currentRole && PRIVILEGED_ROLES.has(currentRole)) ||
    (currentClaimRole && PRIVILEGED_ROLES.has(currentClaimRole)),
  );
  if ((targetCurrentlyPrivileged || PRIVILEGED_ROLES.has(nextRole)) && auth.role !== "super_admin") {
    throw new Error("permission-denied: privileged role mutation requires super_admin");
  }

  const nextTeam = cleanTeam(data.team)
    || cleanTeam(persistedMember.team)
    || cleanTeam(member?.team)
    || cleanTeam(targetUser?.customClaims?.team)
    || cleanTeam(auth.team)
    || "AIX";
  const nextStatus = data.status === "pending" || nextRole === "guest" ? "pending" : "active";
  const email = validEmailField(targetUser?.email) || memberEmail;
  const name = firstCleanString(
    [data.name, persistedMember.name, targetUser?.displayName, member?.name],
    emailLocalPart(email, "멤버"),
    80,
  );
  const photoURL = memberPhotoUrl({ ...persistedMember, ...data }, targetUser, member?.avatar);
  const avatar = photoURL ?? cleanString(persistedMember.avatar, cleanString(member?.avatar, fallbackAvatar(name, email), 80), 500);
  const claimsRole: Role = nextStatus === "active" ? nextRole : "guest";
  const claimsTeam = nextStatus === "active" ? nextTeam : "pending";
  if (!targetUid) claimSyncReason = "awaiting_oauth_login";
  const updatedAtIso = nowIso();
  const memberDocId = memberId || targetUid || `member-${safeDocId(email || name).toLowerCase()}`;
  const memberRecord = stripUndefinedFields({
    id: memberDocId,
    uid: targetUid || undefined,
    name,
    email,
    avatar,
    photoURL,
    role: nextRole,
    team: nextTeam,
    assigned: typeof persistedMember.assigned === "number" ? persistedMember.assigned : member?.assigned ?? 0,
    status: nextStatus,
    lastActive: "방금",
    domainAllowed: email ? isAllowedDomain(email) : undefined,
    claimSyncReason,
    claimsSyncedAtIso: targetUid ? updatedAtIso : undefined,
    updatedAtIso,
    updatedBy: auth.uid,
  });

  let claimsWritten = false;
  if (targetUid) {
    await setMergedCustomClaims(targetUid, { role: claimsRole, team: claimsTeam, name, email, photoURL, claimSyncReason }, targetUser);
    claimsWritten = true;
  }

  if (member) {
    member.name = name;
    member.email = email || member.email;
    member.avatar = avatar;
    member.role = nextRole;
    member.team = nextTeam;
    member.status = nextStatus;
    member.lastActive = "방금";
  }

  const writeRefs = new Map<string, DocumentReference>();
  writeRefs.set(adminDb.collection("members").doc(memberDocId).path, adminDb.collection("members").doc(memberDocId));
  if (memberRef) writeRefs.set(memberRef.path, memberRef);
  if (targetUid) {
    const canonicalRef = adminDb.collection("members").doc(targetUid);
    writeRefs.set(canonicalRef.path, canonicalRef);
  }
  const batch = adminDb.batch();
  for (const ref of writeRefs.values()) {
    batch.set(ref, { ...memberRecord, id: ref.id }, { merge: true });
  }
  await batch.commit();

  const behaviorLog = makeBehaviorLog(auth, `rbac.update(${targetUid || memberId || email}→${nextRole})`, "success");
  behaviorLogs.push(behaviorLog);

  return {
    ok: true,
    member: { ...memberRecord, id: memberDocId },
    uid: targetUid || null,
    role: nextRole,
    team: nextTeam,
    claimSyncReason,
    claimsRole,
    claimsTeam,
    claimsWritten,
    behaviorLog,
  };
}

export async function inviteMember(request: CallableRequest) {
  const auth = assertAdmin(request);
  const data = isRecord(request.data) ? request.data : {};
  const email = cleanString(data.email, "", 180).toLowerCase();
  if (!email.includes("@")) throw new Error("invalid-argument: email");
  const name = cleanString(data.name, email.split("@")[0] ?? "신규 멤버", 80);
  const role = isRole(data.role) ? data.role : "viewer";
  const team = cleanString(data.team, auth.team, 80);
  if (PRIVILEGED_ROLES.has(role) && auth.role !== "super_admin") {
    throw new Error("permission-denied: privileged invite requires super_admin");
  }
  const id = `invite-${safeDocId(email).toLowerCase()}`;
  const member = {
    id,
    name,
    email,
    avatar: cleanString(data.avatar, DEFAULT_MEMBER_AVATAR, 500) || name.slice(0, 1).toUpperCase(),
    role,
    team,
    assigned: 0,
    status: "pending",
    lastActive: "초대 대기",
    invitedAtIso: nowIso(),
    invitedBy: auth.uid,
  };
  await adminDb.collection("members").doc(id).set(member, { merge: true });
  const behaviorLog = makeBehaviorLog(auth, `rbac.invite(${email})`, "success");
  behaviorLogs.push(behaviorLog);
  return { ok: true, member, behaviorLog };
}

export async function requestAccess(request: CallableRequest) {
  const uid = request.auth?.uid;
  if (!uid) {
    const error = new Error("unauthenticated: login required before requesting access");
    Object.assign(error, { code: "unauthenticated", errorCode: "request_access_unauthenticated_login_required_before_requesting" });
    throw error;
  }

  const data = isRecord(request.data) ? request.data : {};
  const userRecord = await getAuthUserByUid(uid);
  // Login/session bootstrap reuses this authenticated boundary but has a
  // narrower contract than an access request: it writes only the canonical
  // members projection and Auth claims. The payload flag is a mode selector,
  // never an identity or role input; bootstrapAuthMembershipForUser resolves
  // both from Admin Auth and Peoply.
  if (data.bootstrap === true) {
    if (!userRecord) {
      const error = new Error("unauthenticated: authenticated user could not be resolved");
      Object.assign(error, { code: "unauthenticated", errorCode: "auth_bootstrap_user_not_found" });
      throw error;
    }
    return bootstrapAuthMembershipForUser(userRecord, request);
  }
  const email = validEmailField(userRecord?.email) || validEmailField(request.auth?.token?.email) || validEmailField(data.email);
  const candidates = await memberCandidatesForUser(uid, email);
  const exactMember = exactUidMemberCandidate(candidates, uid);
  const publicMailboxAccess = hasActivePublicMailboxAccess(exactMember, uid, email);
  const authorityMember = email === CANONICAL_OPERATIONAL_MAILBOX_V1 ? exactMember : chooseAuthoritativeMember(candidates, uid);
  const persistedMember = authorityMember?.data ?? {};
  const canonicalMailboxRequiresExplicitAccess = email === CANONICAL_OPERATIONAL_MAILBOX_V1 && !publicMailboxAccess;
  const persistedRole = isRole(persistedMember.role) ? persistedMember.role : undefined;
  const persistedStatus = memberStatus(persistedMember.status);
  const currentRole = isRole(request.auth?.token?.role) ? request.auth.token.role : "guest";
  const currentClaimsRole = claimRoleFromUser(userRecord);
  const activePersistedRole = persistedStatus === "active" && persistedRole && persistedRole !== "guest" ? persistedRole : undefined;
  const authoritativeRole: Role = canonicalMailboxRequiresExplicitAccess
    ? "guest"
    : activePersistedRole ?? (currentRole !== "guest" ? currentRole : currentClaimsRole && currentClaimsRole !== "guest" ? currentClaimsRole : "guest");
  const domainAllowed = Boolean(email) && isAllowedDomain(email);
  const autoActivateViewer = authoritativeRole === "guest"
    && domainAllowed
    && email !== CANONICAL_OPERATIONAL_MAILBOX_V1;
  const resolvedRole: Role = autoActivateViewer ? "viewer" : authoritativeRole;
  const requestStatus = resolvedRole === "guest"
    ? email === CANONICAL_OPERATIONAL_MAILBOX_V1 ? "pending" : "blocked_domain"
    : "active";
  const persistedTeam = cleanTeam(persistedMember.team === "pending" ? "" : persistedMember.team);
  const tokenTeam = cleanTeam(request.auth?.token?.team === "pending" ? "" : request.auth?.token?.team);
  const displayTeam = requestStatus === "active"
    ? persistedTeam || tokenTeam || "AIX"
    : persistedTeam || "AIX";
  const claimTeam = requestStatus === "active" ? displayTeam : "pending";
  const name = firstCleanString(
    [persistedMember.name, userRecord?.displayName, request.auth?.token?.name, data.displayName, data.name],
    emailLocalPart(email, "신규 가입자"),
    80,
  );
  const photoURL = memberPhotoUrl({ ...persistedMember, photoURL: data.photoURL, picture: request.auth?.token?.picture }, userRecord);
  const roleToPersist: Role = resolvedRole;
  const memberStatusValue = requestStatus === "active" ? "active" : "pending";
  const claimSyncReason = requestStatus === "active"
    ? autoActivateViewer ? "access.request.allowed_domain_viewer" : "access.request.sync_active_member"
    : requestStatus === "blocked_domain"
      ? "access.request.blocked_domain"
      : email === CANONICAL_OPERATIONAL_MAILBOX_V1
        ? "access.request.mailbox_access_required"
        : "access.request.pending_guest";
  const now = nowIso();
  const member = stripUndefinedFields({
    id: uid,
    uid,
    name,
    email,
    avatar: photoURL ?? cleanString(persistedMember.avatar, fallbackAvatar(name, email), 500),
    photoURL,
    role: roleToPersist,
    team: displayTeam,
    assigned: typeof persistedMember.assigned === "number" ? persistedMember.assigned : 0,
    status: memberStatusValue,
    lastActive: requestStatus === "active" ? "방금" : "승인 요청",
    domainAllowed,
    claimSyncReason,
    claimsSyncedAtIso: now,
    requestedAccessAtIso: now,
    updatedAtIso: now,
  });
  const accessRequest = stripUndefinedFields({
    id: uid,
    uid,
    email,
    name,
    displayName: name,
    photoURL,
    team: displayTeam,
    requestedRole: "viewer",
    currentRole: resolvedRole,
    status: requestStatus,
    domainAllowed,
    claimSyncReason,
    requestedAtIso: now,
    updatedAtIso: now,
    lastIp: request.rawRequest?.ip ?? "0.0.0.0",
    source: cleanString(data.source, "access-denied", 80),
    requestCount: FieldValue.increment(1),
  });

  await setMergedCustomClaims(uid, {
    role: requestStatus === "active" ? resolvedRole : "guest",
    team: claimTeam,
    name,
    email,
    photoURL,
    claimSyncReason,
  }, userRecord);

  const batch = adminDb.batch();
  batch.set(adminDb.collection("members").doc(uid), member, { merge: true });
  if (authorityMember && authorityMember.id !== uid) {
    batch.set(authorityMember.ref, { ...member, id: authorityMember.id }, { merge: true });
  }
  batch.set(adminDb.collection("access_requests").doc(uid), accessRequest, { merge: true });
  await batch.commit();

  const behaviorLog: BehaviorLog = {
    userId: uid,
    role: requestStatus === "active" ? resolvedRole : "guest",
    team: claimTeam,
    gameId: "flu-admin",
    action: requestStatus === "blocked_domain"
      ? "access.request.blocked_domain"
      : canonicalMailboxRequiresExplicitAccess
        ? "access.request.mailbox_access_required"
        : "access.request",
    time: now,
    IP: request.rawRequest?.ip ?? "0.0.0.0",
    result: requestStatus === "blocked_domain" || canonicalMailboxRequiresExplicitAccess ? "denied" : "success",
    cost: 0,
  };
  behaviorLogs.push(behaviorLog);

  const responseAccessRequest = stripUndefinedFields({ ...accessRequest, requestCount: undefined });
  return {
    ok: requestStatus !== "blocked_domain" && !canonicalMailboxRequiresExplicitAccess,
    status: requestStatus,
    member,
    accessRequest: responseAccessRequest,
    claimSyncReason,
    claimsWritten: true,
    behaviorLog,
  };
}

export async function logBehavior(request: CallableRequest) {
  const auth = assertAdmin(request);
  const data = isRecord(request.data) ? request.data : {};
  const result = VALID_RESULTS.has(data.result as Result) ? (data.result as Result) : "success";
  const costKRW = typeof data.costKRW === "number" && Number.isFinite(data.costKRW) ? Math.max(0, Math.round(data.costKRW)) : 0;
  const behaviorLog: BehaviorLog = {
    userId: typeof data.userId === "string" ? data.userId : auth.uid,
    role: isRole(data.role) ? data.role : auth.role,
    team: typeof data.team === "string" ? data.team : auth.team,
    gameId: typeof data.gameId === "string" ? data.gameId : "—",
    action: sanitizeAction(data.action),
    time: typeof data.time === "string" ? data.time : nowIso(),
    IP: request.rawRequest?.ip ?? (typeof data.ip === "string" ? data.ip : "0.0.0.0"),
    result,
    cost: costKRW,
  };

  behaviorLogs.push(behaviorLog);
  return { ok: true, behaviorLog, costLog: costMeta("behavior_log", costKRW) };
}

// @deprecated (S12 A5, 확인 2026-07-07): 실사용처 0건 — 클라 래퍼(src/lib/data.ts recordLlmUsage)를 호출하는
// 프로덕션 UI 컴포넌트가 없고, admin/verify 하네스의 샘플 호출만 존재한다(사용처 재확인 완료).
// 신규 코드는 이 콜러블 대신 aiHubReport.reportLlmUsage(정본, byTool 집계 포함)를 쓸 것.
// 외부에서 이 이름으로 직접 호출하는 통합이 있을 수 있어 제거하지 않고 유지 — 제거는 별도 승인 후.
export async function recordLlmUsage(request: CallableRequest) {
  const auth = assertAdmin(request);
  const data = isRecord(request.data) ? request.data : {};
  const model = typeof data.model === "string" && data.model.trim().length > 0 ? data.model.slice(0, 80) : "mock-model";
  const tier = VALID_TIERS.has(data.tier as Tier) ? (data.tier as Tier) : "빠른";
  const tokensK = typeof data.tokensK === "number" && Number.isFinite(data.tokensK) ? Math.max(0, Math.round(data.tokensK * 100) / 100) : 0;
  const costKRW = typeof data.costKRW === "number" && Number.isFinite(data.costKRW) ? Math.max(0, Math.round(data.costKRW)) : 0;
  const cacheKey = typeof data.cacheKey === "string" && data.cacheKey.trim().length > 0 ? data.cacheKey.slice(0, 96) : undefined;
  const cacheHit = data.cacheHit === true;
  if (!cacheKey) throw new Error("invalid-argument: cacheKey required for COST-P0 audit");
  // Deprecated client-origin telemetry cannot self-attest a provider or transport.
  // Keep it isolated in the explicit unverified aggregation lane regardless of payload claims.
  const provider = "unverified";
  const transport = "unverified" as const;
  const legacyAggregationIdentity = llmUsageAggregationIdentity({ modelId: model, tier, provider, transport });
  const existing = llmUsage.find((item) => item.aggregationIdentity === legacyAggregationIdentity);

  if (existing) {
    existing.calls += 1;
    existing.tokensK = Math.round((existing.tokensK + tokensK) * 100) / 100;
    existing.costKRW += costKRW;
  } else {
    llmUsage.push({ model, tier, provider, transport, aggregationIdentity: legacyAggregationIdentity, calls: 1, tokensK, costKRW, share: 0 });
  }
  recalculateShares();

  const usageRef = adminDb.collection("llm_usage").doc(llmUsageDocumentId({ modelId: model, tier, provider, transport }));
  const usageSnapshot = await usageRef.get();
  const usageData = usageSnapshot.exists ? usageSnapshot.data() ?? {} : {};
  await usageRef.set({
    id: usageRef.id,
    schemaVersion: LLM_USAGE_SCHEMA_VERSION,
    aggregationIdentity: legacyAggregationIdentity,
    model,
    tier,
    provider,
    transport,
    calls: numberField(usageData, "calls", 0) + 1,
    tokensK: Math.round((numberField(usageData, "tokensK", 0) + tokensK) * 100) / 100,
    costKRW: numberField(usageData, "costKRW", 0) + costKRW,
    lastCacheKey: cacheKey,
    lastCacheHit: cacheHit,
    updatedAtIso: nowIso(),
    source: "callable-recordLlmUsage",
  }, { merge: true });
  const persistedUsage = await recalculateLlmUsageSharesInFirestore();

  const behaviorLog = makeBehaviorLog(auth, `llm.usage.record(${model})`, "success", costKRW);
  behaviorLogs.push(behaviorLog);

  return {
    ok: true,
    usage: persistedUsage.length > 0 ? persistedUsage : llmUsage,
    cache: cacheMeta(cacheKey, cacheHit),
    costLog: costMeta(`llm:${model}`, costKRW, tokensK),
    behaviorLog,
  };
}

const SEED_COLLECTION_NAMES = SEED_COLLECTIONS.map((entry) => entry.collection);
const DEMO_SEED_ID = "flu-demo-seed";
const PROTECTED_SEED_DOC_KEYS = new Set(MVP_HESSE_PROTECTED_DOC_KEYS);

function seedDocKey(collection: string, id: string): string {
  return `${collection}/${id}`;
}

const DEMO_SEED_DOC_KEYS = new Set(
  SEED_COLLECTIONS.flatMap(({ collection, docs, idField }) =>
    docs
      .map((doc) => String((doc as Record<string, unknown>)[idField] ?? (doc as Record<string, unknown>).id ?? ""))
      .filter(Boolean)
      .map((id) => seedDocKey(collection, id)),
  ),
);

function isProtectedSeedDoc(collection: string, id: string, data: Record<string, unknown>): boolean {
  return PROTECTED_SEED_DOC_KEYS.has(seedDocKey(collection, id)) || data.protected === true || data.seedWrite === false;
}

function isDemoSeedDoc(collection: string, id: string, data: Record<string, unknown>): boolean {
  return data.seedId === DEMO_SEED_ID || DEMO_SEED_DOC_KEYS.has(seedDocKey(collection, id));
}

function mergeProtectedHesseMessages(existingData: Record<string, unknown>, seedData: Record<string, unknown>): unknown[] {
  const existingMessages = Array.isArray(existingData.messages) ? existingData.messages.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item)) : [];
  const seedMessages = Array.isArray(seedData.messages) ? seedData.messages.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item)) : [];
  const seedByRef = new Map(seedMessages.map((message) => [String(message.messageRef ?? message.id ?? ""), message]));
  const usedSeedRefs = new Set<string>();
  const merged = existingMessages.map((message) => {
    const key = String(message.messageRef ?? message.id ?? "");
    const seed = seedByRef.get(key);
    if (!seed) return message;
    usedSeedRefs.add(key);
    return {
      ...seed,
      ...message,
      time: typeof message.time === "string" && message.time !== "방금" ? message.time : seed.time,
      createdAtIso: typeof message.createdAtIso === "string" ? message.createdAtIso : seed.createdAtIso,
    };
  });
  for (const seed of seedMessages) {
    const key = String(seed.messageRef ?? seed.id ?? "");
    if (!usedSeedRefs.has(key) && key) merged.push(seed);
  }
  return merged;
}

function protectedHesseMerge(collection: string, id: string, data: Record<string, unknown>, existingData: Record<string, unknown> | null): Record<string, unknown> {
  const stampedAt = nowIso();
  const createdAtIso = typeof existingData?.createdAtIso === "string" && existingData.createdAtIso
    ? existingData.createdAtIso
    : typeof data.createdAtIso === "string" && data.createdAtIso
      ? data.createdAtIso
      : stampedAt;
  const base = { id, protected: true, seedWrite: false, source: "mvp-live-test", createdAtIso, updatedAtIso: stampedAt };
  if (!existingData) return { ...data, ...base };
  if (collection === "conversations") {
    return {
      ...data,
      ...existingData,
      ...base,
      creatorId: data.creatorId,
      creatorName: data.creatorName,
      creatorAvatar: data.creatorAvatar,
      creatorEmail: data.creatorEmail,
      creatorHandle: data.creatorHandle,
      creatorPlatform: data.creatorPlatform,
      creatorFollowers: data.creatorFollowers,
      aiActive: true,
      messages: mergeProtectedHesseMessages(existingData, data),
    };
  }
  if (collection === "message_sources") {
    return {
      ...data,
      ...base,
      messageRef: data.messageRef ?? id,
      conversationId: data.conversationId,
      direction: data.direction,
    };
  }
  if (collection === "creators") {
    return {
      ...existingData,
      ...data,
      ...base,
    };
  }
  return { ...data, ...base };
}

async function ensureMvpHesseData(): Promise<number> {
  const docs = await Promise.all(MVP_HESSE_PERSISTENT_DOCS.map((doc) => adminDb.collection(doc.collection).doc(doc.id).get()));
  const writes = MVP_HESSE_PERSISTENT_DOCS.map((doc, index) => {
    const ref = adminDb.collection(doc.collection).doc(doc.id);
    const existingData = docs[index]?.exists === true ? docs[index].data() ?? {} : null;
    const data = protectedHesseMerge(doc.collection, doc.id, doc.data, existingData);
    return (batch: ReturnType<typeof adminDb.batch>) => batch.set(ref, data, { merge: true });
  });
  return commitInChunks(writes);
}

// Firestore 배치는 500 op 한도 → 안전하게 청크 단위로 커밋한다.
async function commitInChunks(
  ops: Array<(batch: ReturnType<typeof adminDb.batch>) => void>,
  beforeChunk?: () => Promise<void>,
): Promise<number> {
  const CHUNK = 450;
  for (let start = 0; start < ops.length; start += CHUNK) {
    if (beforeChunk) await beforeChunk();
    const batch = adminDb.batch();
    for (const apply of ops.slice(start, start + CHUNK)) apply(batch);
    await batch.commit();
  }
  return ops.length;
}

function campaignRefillControlChangedError(): Error {
  return Object.assign(new Error("aborted: campaign control changed during automatic refill"), {
    code: "aborted",
    errorCode: "campaign_refill_control_changed",
  });
}

async function commitInChunksWithCampaignControlGuard(
  ops: Array<(batch: ReturnType<typeof adminDb.batch>) => void>,
  campaignId: string,
  expectedControlVersion: number,
  beforeChunk?: () => Promise<void>,
): Promise<number> {
  const CHUNK = 450;
  const campaignRef = adminDb.collection("campaigns").doc(campaignId);
  for (let start = 0; start < ops.length; start += CHUNK) {
    if (beforeChunk) await beforeChunk();
    await adminDb.runTransaction(async (transaction) => {
      const campaignSnapshot = await transaction.get(campaignRef);
      const currentCampaign: Record<string, unknown> = campaignSnapshot.exists
        ? { id: campaignSnapshot.id, ...(campaignSnapshot.data() ?? {}) }
        : {};
      const currentVersion = numberField(currentCampaign, "controlVersion", 0);
      if (
        !campaignSnapshot.exists
        || resolveCampaignOperationalState(currentCampaign) !== "active"
        || currentVersion !== expectedControlVersion
      ) {
        throw campaignRefillControlChangedError();
      }
      for (const apply of ops.slice(start, start + CHUNK)) {
        // Write operations use only the shared set/create/update/delete surface.
        // Firestore Transaction implements that same surface; the cast keeps the
        // existing operation builder reusable while the campaign guard stays atomic.
        apply(transaction as unknown as ReturnType<typeof adminDb.batch>);
      }
    });
  }
  return ops.length;
}
type CampaignWaveWriteOp = (sink: ReturnType<typeof adminDb.batch>) => void;

type CampaignWaveWriteGroup = {
  operations: CampaignWaveWriteOp[];
  /** Deterministic new queue artifacts only; existing conversation roots are intentionally excluded. */
  rollbackRefPaths: string[];
};

async function commitCampaignWaveWriteGroups(
  groups: readonly CampaignWaveWriteGroup[],
  options: {
    campaignId?: string;
    expectedControlVersion?: number;
    beforeChunk?: () => Promise<void>;
  } = {},
): Promise<number> {
  const attemptedRollbackRefPaths: string[] = [];
  try {
    await forEachCampaignWaveQueueChunk(groups, async (groupChunk) => {
      if (options.beforeChunk) await options.beforeChunk();
      // The current RPC may have committed server-side before its client deadline. Include its
      // deterministic message/outreach pair before entering the commit, as in R36 compensation.
      attemptedRollbackRefPaths.push(...groupChunk.flatMap((group) => group.rollbackRefPaths));
      if (options.campaignId) {
        const campaignRef = adminDb.collection("campaigns").doc(options.campaignId);
        await adminDb.runTransaction(async (transaction) => {
          const campaignSnapshot = await transaction.get(campaignRef);
          const currentCampaign: Record<string, unknown> = campaignSnapshot.exists
            ? { id: campaignSnapshot.id, ...(campaignSnapshot.data() ?? {}) }
            : {};
          if (
            !campaignSnapshot.exists
            || resolveCampaignOperationalState(currentCampaign) !== "active"
            || numberField(currentCampaign, "controlVersion", 0) !== (options.expectedControlVersion ?? 0)
          ) {
            throw campaignRefillControlChangedError();
          }
          const sink = transaction as unknown as ReturnType<typeof adminDb.batch>;
          for (const group of groupChunk) {
            for (const operation of group.operations) operation(sink);
          }
        });
      } else {
        const batch = adminDb.batch();
        for (const group of groupChunk) {
          for (const operation of group.operations) operation(batch);
        }
        await batch.commit();
      }
    });
  } catch (error) {
    await rollbackRefillDocumentPaths(
      attemptedRollbackRefPaths,
      "campaign_wave_queue_write_failed",
      error,
    );
    throw error;
  }
  return groups.length;
}

async function forEachCollectionPage(
  collection: string,
  visit: (docs: QueryDocumentSnapshot[]) => void | Promise<void>,
): Promise<number> {
  const PAGE_SIZE = 450;
  let total = 0;
  let query: Query = adminDb.collection(collection).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);

  while (true) {
    const snapshot = await query.get();
    if (snapshot.empty) break;
    total += snapshot.size;
    await visit(snapshot.docs);
    const lastDoc = snapshot.docs.at(-1);
    if (!lastDoc || snapshot.size < PAGE_SIZE) break;
    query = adminDb.collection(collection).orderBy(FieldPath.documentId()).startAfter(lastDoc).limit(PAGE_SIZE);
  }

  return total;
}

// 로컬 에뮬레이터에만 검증용 시드를 적재한다. 호스팅 런타임은 guard에서 거부한다.
export async function createSeedData(request: CallableRequest) {
  const auth = assertAdmin(request);
  assertDemoSeedCreationAllowed();

  const writes: Array<(batch: ReturnType<typeof adminDb.batch>) => void> = [];
  const counts: Record<string, number> = {};
  for (const { collection, docs, idField, seedWrite } of SEED_COLLECTIONS) {
    if (seedWrite === false) continue; // candidate_pool 등 라이브 탐색 전용은 시드 미작성(실제 발굴로만 채움)
    counts[collection] = docs.length;
    for (const doc of docs) {
      const docId = String((doc as Record<string, unknown>)[idField] ?? doc.id ?? "");
      if (!docId) continue;
      if (PROTECTED_SEED_DOC_KEYS.has(seedDocKey(collection, docId))) continue;
      const ref = adminDb.collection(collection).doc(docId);
      writes.push((batch) => batch.set(ref, { ...withSeedIsoFields(doc as Record<string, unknown>), seedId: DEMO_SEED_ID, seededAt: nowIso() }));
    }
  }
  const written = await commitInChunks(writes);
  const protectedWritten = await ensureMvpHesseData();

  const behaviorLog = makeBehaviorLog(auth, `seed.create(${written}건+protected:${protectedWritten})`, "success");
  behaviorLogs.push(behaviorLog);

  return {
    ok: true,
    seedId: DEMO_SEED_ID,
    written,
    protectedWritten,
    counts,
    manifest: SEED_MANIFEST,
    cache: cacheMeta(`seed:${DEMO_SEED_ID}:manifest`, true),
    costLog: costMeta("seed.create", 0),
    behaviorLog,
  };
}

// 로컬 에뮬레이터에서 provenance로 식별된 검증용 시드만 정리한다. 호스팅 런타임은 guard에서 거부한다.
// 감사 로그(behavior_logs/costLogs/callableRuns/engineSnapshots)는 시드 대상이 아니므로 보존된다.
export async function deleteSeedData(request: CallableRequest) {
  const auth = assertAdmin(request);
  assertDemoSeedCreationAllowed();

  const deletes: Array<(batch: ReturnType<typeof adminDb.batch>) => void> = [];
  const counts: Record<string, number> = {};
  let preserved = 0;
  for (const collection of SEED_COLLECTION_NAMES) {
    counts[collection] = await forEachCollectionPage(collection, (docs) => {
      for (const doc of docs) {
        const data = doc.data();
        const exactFixture = isOperationalFixtureRecord(data, collection);
        if (!exactFixture && (isProtectedSeedDoc(collection, doc.id, data) || !isDemoSeedDoc(collection, doc.id, data))) {
          preserved += 1;
          continue;
        }
        const ref = doc.ref;
        deletes.push((batch) => batch.delete(ref));
      }
    });
  }
  const deleted = await commitInChunks(deletes);

  const behaviorLog = makeBehaviorLog(auth, `seed.delete(${deleted}건+preserved:${preserved})`, "success");
  behaviorLogs.push(behaviorLog);

  return {
    ok: true,
    seedId: DEMO_SEED_ID,
    deleted,
    preserved,
    counts,
    cache: cacheMeta(`seed:${DEMO_SEED_ID}:manifest`, true),
    costLog: costMeta("seed.delete", 0),
    behaviorLog,
  };
}

function sanitizeAutoReply(data: Record<string, unknown>) {
  const incomingRules = Array.isArray(data.rules) ? data.rules : [];
  const rules = incomingRules
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((rule, index) => ({
      id: cleanString(rule.id, `rule-${index + 1}`, 40),
      label: cleanString(rule.label, "자동화 규칙", 120),
      desc: cleanString(rule.desc, "", 240),
      enabled: rule.enabled !== false,
      scope: rule.scope === "human" ? "human" : "ai",
    }))
    .slice(0, 20);
  return {
    id: "default",
    enabled: data.enabled !== false,
    model: cleanString(data.model, "Claude (내부 Gateway 경유)", 100),
    tone: cleanString(data.tone, "정중·간결", 100),
    workingHours: cleanString(data.workingHours, "평시 즉시 회신 / 야간 대기열", 140),
    rules,
    updatedAtIso: nowIso(),
  };
}

export async function updateAutoReply(request: CallableRequest) {
  const auth = assertManager(request);
  const data = isRecord(request.data) ? request.data : {};
  const autoReply = sanitizeAutoReply(data);
  const autoReplyRef = adminDb.collection("auto_reply").doc("default");
  const settingsRef = adminDb.doc("settings/default");
  const policyCacheRef = adminDb.doc("settings/policy_cache");
  const auditRef = adminDb.collection("auto_reply_settings_audits").doc();
  const settingsAuditRef = adminDb.collection(SETTINGS_AUDIT_COLLECTION).doc();
  const updatedAtIso = autoReply.updatedAtIso;
  const actorUidHash = settingsActorUidHash(auth.uid);
  const mutation = await adminDb.runTransaction(async (transaction) => {
    const [autoReplySnapshot, settingsSnapshot, policyCacheSnapshot] = await Promise.all([
      transaction.get(autoReplyRef),
      transaction.get(settingsRef),
      transaction.get(policyCacheRef),
    ]);
    const previousUiEnabled = autoReplySnapshot.exists
      ? autoReplySnapshot.get("enabled") === true
      : false;
    const previousEngineEnabled = settingsSnapshot.exists
      ? settingsSnapshot.get("automation.autoReplyEnabled") === true
      : false;
    const currentSettingsRevision = settingsRevisionFromRecord(settingsSnapshot.data() ?? {});
    const engineSettingChanged = previousEngineEnabled !== autoReply.enabled;
    const nextSettingsRevision = engineSettingChanged
      ? currentSettingsRevision + 1
      : currentSettingsRevision;
    transaction.set(autoReplyRef, autoReply, { merge: true });
    // settings/default is the canonical source read by receiveEmail and the queue
    // worker. A switch transition participates in the shared revision contract,
    // so an already-loaded Settings screen will fail closed instead of silently
    // overwriting this change.
    if (engineSettingChanged) {
      transaction.set(settingsRef, {
        automation: { autoReplyEnabled: autoReply.enabled },
        revision: nextSettingsRevision,
        updatedAtIso,
        updatedAt: FieldValue.serverTimestamp(),
        updatedByHash: actorUidHash,
      }, { merge: true });
      if (policyCacheSnapshot.exists) {
        const policyVersion = typeof policyCacheSnapshot.get("version") === "number"
          ? policyCacheSnapshot.get("version") as number
          : 0;
        transaction.set(policyCacheRef, {
          automation: { autoReplyEnabled: autoReply.enabled },
          settingsRevision: nextSettingsRevision,
          version: policyVersion + 1,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      transaction.create(settingsAuditRef, makeSettingsAuditRecord({
        settingsRevision: nextSettingsRevision,
        changedSections: ["automation"],
        changedKeys: ["automation.autoReplyEnabled"],
        actorUidHash,
        actorRole: auth.role,
        createdAtIso: updatedAtIso,
        source: "functions.updateAutoReply",
      }));
    }
    transaction.create(auditRef, {
      id: auditRef.id,
      action: "auto_reply_master_switch_update",
      before: {
        uiEnabled: previousUiEnabled,
        engineEnabled: previousEngineEnabled,
      },
      after: {
        uiEnabled: autoReply.enabled,
        engineEnabled: autoReply.enabled,
      },
      actor: {
        role: auth.role,
        team: auth.team,
        uidHash: actorUidHash.slice(0, 24),
      },
      autoReplyRef: autoReplyRef.path,
      settingsRef: settingsRef.path,
      createdAtIso: updatedAtIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    return {
      engineSettingChanged,
      settingsRevision: nextSettingsRevision,
      settingsAuditRef: engineSettingChanged ? settingsAuditRef.path : null,
    };
  });
  const behaviorLog = makeBehaviorLog(auth, "auto_reply.update(default)", "success");
  behaviorLogs.push(behaviorLog);
  return {
    ok: true,
    autoReply,
    engineEnabled: autoReply.enabled,
    engineSettingChanged: mutation.engineSettingChanged,
    settingsRevision: mutation.settingsRevision,
    settingsRef: settingsRef.path,
    settingsAuditRef: mutation.settingsAuditRef,
    auditRef: auditRef.path,
    behaviorLog,
  };
}

function sanitizeTemplate(data: Record<string, unknown>) {
  const title = cleanString(data.title, "새 템플릿", 120);
  const id = cleanString(data.id, safeDocId(title), 80);
  const stage = VALID_TEMPLATE_STAGES.has(data.stage as string) ? data.stage as string : "contact";
  const channel = VALID_TEMPLATE_CHANNELS.has(data.channel as string) ? data.channel as string : "이메일";
  const personalizationHints = isRecord(data.personalizationHints)
    ? Object.fromEntries(Object.entries(data.personalizationHints).map(([key, value]) => [safeDocId(key), cleanString(value, "", 240)]))
    : {};
  return {
    id,
    title,
    stage,
    channel,
    body: cleanString(data.body, "", 5000),
    vars: stringArrayField(data.vars),
    aiManaged: data.aiManaged === true,
    fixed: data.fixed === true,
    usage: typeof data.usage === "number" && Number.isFinite(data.usage) ? Math.max(0, Math.round(data.usage)) : 0,
    personalizationHints,
    updatedAtIso: nowIso(),
  };
}

export async function upsertTemplate(request: CallableRequest) {
  const auth = assertManager(request);
  const data = isRecord(request.data) ? request.data : {};
  const template = sanitizeTemplate(data);
  await adminDb.collection("templates").doc(template.id).set(template, { merge: true });
  const behaviorLog = makeBehaviorLog(auth, `templates.upsert(${template.id})`, "success");
  behaviorLogs.push(behaviorLog);
  return { ok: true, template, behaviorLog };
}

// 단일 캠페인 생성 — "새 캠페인" 마법사 제출 시 실제 campaigns 문서를 Firestore에 쓴다(manager+).
// 시드(createSeedData)와 별개의 사용자 액션. 생성 직후 getDataset이 읽어 목록에 즉시 노출된다.
const CAMPAIGN_ROLES = new Set<Role>(["super_admin", "admin", "manager"]);
const PROGRAM_COLDMAIL_AUDIT_COLLECTION = "program_coldmail_template_audits";
// W8-FINAL R1b(사용자 확정): Typeform 폐기. 이 상수는 서명 링크를 만들 수 없는 편집기
// 미리보기의 fallback일 뿐이다. 실제 콜드메일 CTA는 per-outreach `{{apply_link}}`를 우선한다.
export const SCP_PORTAL_APPLY_LINK =
  "https://creator.supercent.io/apply?locale=en";
const PROGRAM_COLDMAIL_ALLOWED_PLACEHOLDERS = new Set([
  "name",
  "creator",
  "game",
  "campaign",
  "owner",
  "creatorName",
  "channelName",
  "gameTitle",
  "campaignName",
  "country",
  "senderName",
  "apply_link",
  "form_link",
]);
const PROGRAM_COLDMAIL_PREVIEW_VALUES: Record<string, string> = {
  name: "Sample Creator",
  creator: "Sample Creator",
  game: "Super Creator Partners",
  campaign: "Super Creator Partners",
  owner: "Supercent SCP",
  creatorName: "Sample Creator",
  channelName: "Sample Channel",
  gameTitle: "XP Hero",
  campaignName: "Super Creator Partners",
  country: "US",
  senderName: "Supercent",
  apply_link: SCP_PORTAL_APPLY_LINK,
  form_link: SCP_PORTAL_APPLY_LINK,
};

export const DEFAULT_SCP_FIRST_COLDMAIL_SUBJECT =
  "Your content caught our eye 👀 — Apply for Our Game Creator Program!";

export const DEFAULT_SCP_FIRST_COLDMAIL_BODY = `Hello, this is Supercent! 👋



Supercent is a mobile game development and publishing company,

with major titles including Burger Please! (118M+ downloads), Pizza Ready (429M+ downloads), and Snake Clash (219M+ downloads).



If you're a game creator looking for something more than a one-off sponsorship,

We have an ongoing creator program that might be just what you're looking for.

Feel free to check it out and apply!



🎮 Super Creator Partners

Super Creator Partners is an official long-term creator partnership program run by Supercent, a global mobile game publisher.



✅ Who Can Apply

Game creators with 500+ YouTube subscribers



🎥 What You'll Do

Play and create content for Supercent mobile games



🎁 What You Get

Official Channel Exposure — Be featured on Supercent's official YouTube and social media channels, reaching +2.7 million subscribers
Rewards — Earn a monthly Activity Fee, Viral Bonus, Creator Code Fee, Mission Complete Fee, etc.
Additional Benefits — In-game rewards (e.g. No Ads), Partnership Ads opportunities


📋 How to Apply

Apply here: {{apply_link}}

*A YouTube channel is required to participate.

For full details, visit: https://creator.supercent.io/?locale=en&view=guide&track=fixed-cpm



Any questions? Feel free to reply to this email 😊



Best regards,

Supercent`;

// {{key}} 치환(제목·본문 공통).
function fillTemplateVars(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => values[key] ?? `{{${key}}}`);
}

function extractTemplatePlaceholders(...texts: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
      found.add(match[1]);
    }
  }
  return Array.from(found).slice(0, 50);
}

function countryArrayField(value: unknown, maxItems = 30): string[] {
  if (!Array.isArray(value)) return [];
  const countries: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const code = item.trim().toUpperCase().slice(0, 4);
    if (code && !countries.includes(code)) countries.push(code);
    if (countries.length >= maxItems) break;
  }
  return countries;
}

type ProgramColdmailBodyFormat = "markdown" | "text" | "html";

type ProgramColdmailTemplate = {
  subject: string;
  body: string;
  sourceCountry: string;
  targetCountries: string[];
  bodyFormat: ProgramColdmailBodyFormat;
};

// bodyFormat:"html"은 운영자가 원문 HTML을 직접 작성해 마크다운 변환 없이 그대로 보내는 옵션
// (기본값 "markdown" — 기존 템플릿과 100% 동일하게 동작). html 모드는 국가별 자동번역을 쓰지 않고,
// text는 markdown과 같은 국가별 자동번역 경로를 사용한다(pickColdMailTemplate/localizeProgramMailTemplate 참조).
function normalizeProgramColdmailBodyFormat(value: unknown): ProgramColdmailBodyFormat {
  if (value === "html") return "html";
  if (value === "text") return "text";
  return "markdown";
}

function normalizeProgramColdmailInput(
  data: Record<string, unknown>,
): ProgramColdmailTemplate {
  const useDefault = data.useDefault === true;
  const subject = normalizeProgramColdmailSubject(
    data.subject,
    useDefault ? DEFAULT_SCP_FIRST_COLDMAIL_SUBJECT : "",
  );
  const bodyFormat = normalizeProgramColdmailBodyFormat(data.bodyFormat);
  const body = normalizeProgramColdmailBody(
    data.body,
    useDefault ? DEFAULT_SCP_FIRST_COLDMAIL_BODY : "",
    bodyFormat,
    true,
  );
  if (!subject && !body) {
    throw programColdmailError("failed-precondition", "subject or body required");
  }
  validateProgramColdmailPlaceholders(subject, body);
  return {
    subject,
    body,
    sourceCountry: normalizeCountryCode(data.sourceCountry, "KR"),
    targetCountries: countryArrayField(data.targetCountries),
    bodyFormat,
  };
}

function normalizeStoredProgramColdmail(
  value: Record<string, unknown>,
): ProgramColdmailTemplate {
  return {
    subject: normalizeProgramColdmailSubject(value.subject, "", false),
    body: normalizeProgramColdmailBody(value.body, "", normalizeProgramColdmailBodyFormat(value.bodyFormat)),
    sourceCountry: normalizeCountryCode(value.sourceCountry, "KR"),
    targetCountries: countryArrayField(value.targetCountries),
    bodyFormat: normalizeProgramColdmailBodyFormat(value.bodyFormat),
  };
}

function normalizeProgramColdmailSubject(
  value: unknown,
  fallback: string,
  strict = true,
): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return fallback;
  if (normalized.includes("\n")) {
    if (strict) {
      throw programColdmailError("invalid-argument", "subject must be a single line");
    }
    return normalized.replace(/\n+/g, " ").trim().slice(0, 400);
  }
  return normalized.trim().slice(0, 400);
}

// html 템플릿(원문 HTML 콜드메일)은 이미지 자산화 이전 원본이 크므로 컴파일러
// 입력 상한(256KB)에 맞춘 별도 캡을 쓴다. 쓰기 경로는 초과 시 잘라내지 않고
// 명시적으로 거부한다(무단 절단으로 템플릿이 조용히 깨지는 것을 방지).
const PROGRAM_COLDMAIL_HTML_BODY_MAX_CHARS = 256 * 1024;

function normalizeProgramColdmailBody(
  value: unknown,
  fallback: string,
  bodyFormat: ProgramColdmailBodyFormat = "markdown",
  strict = false,
): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return fallback;
  const maxChars = bodyFormat === "html" ? PROGRAM_COLDMAIL_HTML_BODY_MAX_CHARS : 8000;
  if (strict && normalized.length > maxChars) {
    throw programColdmailError(
      "invalid-argument",
      `body exceeds the ${bodyFormat} limit of ${maxChars} characters`,
      "coldmail_body_too_large",
    );
  }
  return normalized.slice(0, maxChars);
}

function normalizeCountryCode(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim()
    ? value.trim().toUpperCase().slice(0, 4)
    : fallback;
}

function validateProgramColdmailPlaceholders(subject: string, body: string) {
  const placeholders = extractTemplatePlaceholders(subject, body);
  const malformed = Array.from(`${subject}\n${body}`.matchAll(/\{\{([^{}]+)\}\}/g))
    .map((match) => match[1].trim())
    .filter((key) => !/^[a-zA-Z0-9_]+$/.test(key));
  if (malformed.length > 0) {
    throw programColdmailError(
      "invalid-argument",
      `malformed placeholders: ${[...new Set(malformed)].join(", ")}`,
    );
  }
  const unsupported = placeholders.filter(
    (placeholder) => !PROGRAM_COLDMAIL_ALLOWED_PLACEHOLDERS.has(placeholder),
  );
  if (unsupported.length > 0) {
    throw programColdmailError(
      "invalid-argument",
      `unsupported placeholders: ${unsupported.join(", ")}`,
    );
  }
  return {
    valid: true as const,
    placeholders,
    allowedPlaceholders: [...PROGRAM_COLDMAIL_ALLOWED_PLACEHOLDERS],
    requiredPlaceholders: [] as string[],
  };
}

function programColdmailPreview(
  template: ProgramColdmailTemplate,
  values: Record<string, string>,
) {
  const placeholders = extractTemplatePlaceholders(template.subject, template.body);
  const missingPlaceholders = placeholders.filter((key) => !values[key]);
  const artifact = compileMailArtifact({
    body: template.body,
    bodyFormat: template.bodyFormat,
    values,
    templateRevision: "program-preview",
  });
  return {
    subject: resolveMailSubject(template.subject, values),
    body: artifact.compiledHtml,
    text: artifact.text,
    // 응답 artifact는 manifest만 담고, 이미지 원문은 assetContents로 분리 전달
    // (프리뷰 iframe이 cid:를 data:로 로컬 치환 — 원격 요청 0 유지).
    artifact: { ...artifact, assets: mailAssetManifest(artifact.assets) },
    assetContents: mailAssetPreviewContents(artifact.assets),
    missingPlaceholders,
  };
}

function programColdmailContentHash(template: ProgramColdmailTemplate): string {
  return createHash("sha256")
    .update(JSON.stringify(template))
    .digest("hex");
}

function programColdmailChangedFields(
  before: ProgramColdmailTemplate | null,
  after: ProgramColdmailTemplate,
): string[] {
  if (!before) return ["subject", "body", "sourceCountry", "targetCountries", "bodyFormat"];
  const fields = ["subject", "body", "sourceCountry", "targetCountries", "bodyFormat"] as const;
  return fields.filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );
}

type ProgramColdmailCasExpectation = {
  expectedVersion?: number;
  expectedHash?: string;
};

function programColdmailCasExpectation(
  data: Record<string, unknown>,
): ProgramColdmailCasExpectation {
  const expectation: ProgramColdmailCasExpectation = {};
  if (Object.prototype.hasOwnProperty.call(data, "expectedVersion")) {
    if (
      typeof data.expectedVersion !== "number"
      || !Number.isSafeInteger(data.expectedVersion)
      || data.expectedVersion < 0
    ) {
      throw programColdmailError(
        "invalid-argument",
        "expectedVersion must be a non-negative integer",
      );
    }
    expectation.expectedVersion = data.expectedVersion;
  }
  if (Object.prototype.hasOwnProperty.call(data, "expectedHash")) {
    if (
      typeof data.expectedHash !== "string"
      || (data.expectedHash !== "" && !/^[a-f0-9]{64}$/i.test(data.expectedHash))
    ) {
      throw programColdmailError(
        "invalid-argument",
        "expectedHash must be empty or a SHA-256 hash",
      );
    }
    expectation.expectedHash = data.expectedHash.toLowerCase();
  }
  return expectation;
}

function assertProgramColdmailCas(
  expectation: ProgramColdmailCasExpectation,
  currentVersion: number,
  currentHash: string,
): void {
  if (
    expectation.expectedVersion === undefined
    && expectation.expectedHash === undefined
  ) {
    throw programColdmailError(
      "invalid-argument",
      "expectedVersion or expectedHash is required",
    );
  }
  if (
    expectation.expectedVersion !== undefined
    && expectation.expectedVersion !== currentVersion
  ) {
    throw programColdmailError(
      "failed-precondition",
      `cold-mail version conflict: expected ${expectation.expectedVersion}, current ${currentVersion}`,
    );
  }
  if (
    expectation.expectedHash !== undefined
    && expectation.expectedHash !== currentHash
  ) {
    throw programColdmailError(
      "failed-precondition",
      `cold-mail hash conflict: expected ${expectation.expectedHash || "<empty>"}, current ${currentHash || "<empty>"}`,
    );
  }
}

function programColdmailStoredVersion(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function programColdmailPreviewValues(value: unknown): Record<string, string> {
  if (!isRecord(value)) return { ...PROGRAM_COLDMAIL_PREVIEW_VALUES };
  const provided = Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, entry]) => [key, entry.slice(0, 1000)]),
  );
  return { ...PROGRAM_COLDMAIL_PREVIEW_VALUES, ...provided };
}

function programColdmailError(code: string, message: string, errorCode?: string): Error {
  return Object.assign(new Error(message), { code, ...(errorCode ? { errorCode } : {}) });
}

function programColdmailAuthScope(
  request: CallableRequest,
  uid: string,
  role: Role,
  team: string,
): AuthContext {
  return {
    userId: uid,
    role: role as AuthContext["role"],
    team,
    ip: request.rawRequest?.ip ?? "0.0.0.0",
    gameId: "flu-program",
    ...(request.auth?.token?.email ? { email: request.auth.token.email } : {}),
    ...(request.auth?.token?.name ? { name: request.auth.token.name } : {}),
  };
}

function assertProgramColdmailScope(
  snapshot: DocumentSnapshot,
  auth: AuthContext,
): void {
  if (
    rowMatchesAccountScope(
      "programs",
      { id: snapshot.id, ...(snapshot.data() ?? {}) },
      auth,
    )
  ) {
    return;
  }
  throw programColdmailError(
    "permission-denied",
    "permission-denied: program belongs to another account",
  );
}

function countryMixField(value: unknown, fallbackCountries: string[]): CountryAllocation[] {
  if (!Array.isArray(value)) {
    return fallbackCountries.map((country) => ({ country, weight: 1 }));
  }
  const out: CountryAllocation[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const country = stringField(item, "country", "").toUpperCase().slice(0, 4);
    const weight = numberField(item, "weight", 0);
    if (country && weight > 0 && !out.some((entry) => entry.country === country)) out.push({ country, weight });
  }
  return out.length > 0 ? out : fallbackCountries.map((country) => ({ country, weight: 1 }));
}

function regionOfTarget(target: CampaignTarget): string {
  return (target.region ?? "").toUpperCase();
}

/** T3: 정렬 전용 점수 추출. 값이 없거나 유한하지 않으면 0점(=뒤로) — 후보를 거르지는 않는다. */
export function campaignTargetMatchScore(target: { matchScore?: number }): number {
  return typeof target.matchScore === "number" && Number.isFinite(target.matchScore) ? target.matchScore : 0;
}

// T3: 정렬 계약을 값으로 단정하기 위해 노출한다(순수 함수 — 상태·IO 없음).
export function selectBalancedCampaignTargets(
  candidates: CampaignTarget[],
  limit: number,
  targetCountries: string[],
  targetCountryMix: CountryAllocation[],
): CampaignTarget[] {
  const cappedLimit = Math.max(1, Math.min(limit || 10, CAMPAIGN_OUTREACH_QUEUE_LIMIT));
  // R16-4: 국가 지정이 없는 캠페인(`countryScope:"all"` → targetCountries=[])은 이 조기 반환으로
  // 빠져나가 **T3 정렬을 통째로 건너뛰었다** — 지금 돌고 있는 실캠페인이 정확히 이 형태라, 랭킹이
  // 적용되지 않고 FIFO 로 나가고 있었다. 여기서도 점수 내림차순으로 세운 뒤 자른다(필터·개수 불변).
  if (targetCountries.length === 0) {
    return [...candidates]
      .sort((left, right) => campaignTargetMatchScore(right) - campaignTargetMatchScore(left))
      .slice(0, cappedLimit);
  }
  const countries = targetCountryMix.length > 0 ? targetCountryMix : targetCountries.map((country) => ({ country, weight: 1 }));
  const buckets = new Map<string, CampaignTarget[]>();
  for (const country of targetCountries) buckets.set(country, []);
  for (const candidate of candidates) {
    const region = regionOfTarget(candidate);
    const bucket = buckets.get(region);
    if (bucket) bucket.push(candidate);
  }
  // T3: 버킷 내부를 **품질 점수 내림차순**으로 세운다. 예전에는 FIFO(`shift()`)라 국가쿼터 안에서
  // "최근 갱신된 후보"가 먼저 나갔고, 발굴이 계산한 matchScore 는 소비 단계에서 한 번도 쓰이지 않았다.
  // ⚠️ 순서만 바꾼다 — 필터·쿼터·중복 제거는 그대로다(점수로 후보를 통과시키거나 거르지 않는다).
  // 점수 없는 후보(수동 등록분 등)는 0점이라 자연히 뒤로 가고, 동점·무점수 구간은 정렬이 안정적이라
  // 기존 순서(=updatedAtIso desc)를 유지한다.
  for (const bucket of buckets.values()) {
    bucket.sort((left, right) => campaignTargetMatchScore(right) - campaignTargetMatchScore(left));
  }
  const totalWeight = countries.reduce((sum, item) => sum + Math.max(0, item.weight), 0) || countries.length;
  const quotas = countries.map((item, index) => {
    const exact = (cappedLimit * Math.max(0, item.weight || 1)) / totalWeight;
    return { country: item.country, index, quota: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = cappedLimit - quotas.reduce((sum, item) => sum + item.quota, 0);
  for (const item of [...quotas].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (remaining <= 0) break;
    item.quota += 1;
    remaining -= 1;
  }
  const picked: CampaignTarget[] = [];
  const seen = new Set<string>();
  const take = (country: string) => {
    const bucket = buckets.get(country) ?? [];
    while (bucket.length > 0) {
      const next = bucket.shift();
      if (!next || seen.has(next.id)) continue;
      picked.push(next);
      seen.add(next.id);
      return true;
    }
    return false;
  };
  for (const quota of quotas) {
    for (let count = 0; count < quota.quota && picked.length < cappedLimit; count += 1) {
      if (!take(quota.country)) break;
    }
  }
  while (picked.length < cappedLimit) {
    let progressed = false;
    for (const country of targetCountries) {
      if (picked.length >= cappedLimit) break;
      progressed = take(country) || progressed;
    }
    if (!progressed) break;
  }
  return picked;
}

function campaignTargetSearchText(target: CampaignTarget): string {
  return [
    target.name,
    target.handle ?? "",
    target.platform ?? "",
    target.category ?? "",
    target.publicDescription ?? "",
    ...(target.matchedSearchTerms ?? []),
  ].join(" ").toLowerCase();
}

type LiveCampaignStaticCriteria = {
  countryTargeting: CountryTargeting;
  excludeKeywords: string[];
  minFollowers: number;
  maxFollowers: number;
  eligibilityCategories: string[];
  eligibilityKeywords: string[];
  keywordFallbackEnabled: boolean;
};

type LiveCampaignStaticPartition = {
  projected: CampaignTarget[];
  filtered: CampaignTarget[];
  keywordMatched: CampaignTarget[];
  countryDecisionCounts: Record<string, number>;
};

/** Keep the refill sufficiency gate and final live selection on the same deterministic policy. */
function partitionLiveCampaignTargetsByStaticCriteria(targets: CampaignTarget[], criteria: LiveCampaignStaticCriteria): LiveCampaignStaticPartition {
  const projected = targets.map((target) => {
    const countryDecision = youtubeCreatorCountryPolicyDecision(target.region, criteria.countryTargeting);
    return { ...target, country: countryDecision.country, countryDecision, ...(countryDecision.country ? { region: countryDecision.country } : {}) };
  });
  const countryDecisionCounts = projected.reduce<Record<string, number>>((counts, target) => {
    const key = target.countryDecision?.decision ?? "unknownCountryHeld";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, { countryAllowed: 0, excludedByIncludedCountries: 0, excludedByExplicitCountry: 0, unknownCountryHeld: 0 });
  const base = projected.filter((target) => {
    if (target.countryDecision?.accepted !== true) return false;
    if (criteria.excludeKeywords.length > 0 && targetMatchesAny(target, criteria.excludeKeywords)) return false;
    if (criteria.minFollowers > 0 && (target.followers ?? 0) < criteria.minFollowers) return false;
    if (criteria.maxFollowers > 0 && (target.followers ?? 0) > criteria.maxFollowers) return false;
    return true;
  });
  const hasInclude = criteria.eligibilityCategories.length > 0 || criteria.eligibilityKeywords.length > 0;
  const matched = hasInclude ? base.filter((target) => targetMatchesCampaignIncludes(target, criteria.eligibilityCategories, criteria.eligibilityKeywords)) : base;
  return { projected, filtered: criteria.keywordFallbackEnabled && hasInclude
    ? [...matched, ...base.filter((target) => !targetMatchesCampaignIncludes(target, criteria.eligibilityCategories, criteria.eligibilityKeywords))]
    : matched, keywordMatched: matched, countryDecisionCounts };
}

function liveTargetSuppressionLookup(target: CampaignTarget): MailSuppressionLookup {
  return { email: target.email, handle: target.handle, name: target.name, category: target.category, platform: target.platform,
    text: [target.name, target.handle ?? "", target.category ?? "", target.platform ?? "", target.region ?? ""].join(" ") };
}

function liveTargetSuppressionLookupKey(target: CampaignTarget): string {
  const input = liveTargetSuppressionLookup(target);
  return JSON.stringify([input.email ?? "", input.handle ?? "", input.name ?? "", input.category ?? "", input.platform ?? "", input.text ?? ""]
    .map((value) => String(value).trim().toLowerCase()));
}

function targetMatchesAny(target: CampaignTarget, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const searchable = campaignTargetSearchText(target);
  return keywords.some((keyword) => searchable.includes(keyword.toLowerCase()));
}

function targetMatchesCampaignIncludes(
  target: CampaignTarget,
  categories: string[],
  keywords: string[],
): boolean {
  if (categories.length === 0 && keywords.length === 0) return true;
  // P0-1 [XP→Snake 후보 이주]: this is the *second*, independent keyword/category gate (R31-2) —
  // evaluateProgramCampaignCandidateEligibility already applied the same bypass upstream for this
  // one candidate. Re-rejecting it here would silently undo that bypass for every consumer of this
  // shared helper (prepareProgramCampaignTargetsCore's inline filter and
  // partitionLiveCampaignTargetsByStaticCriteria's sufficiency/final-selection gates alike).
  if (target.keywordGateBypassed === true) return true;
  if (categories.length > 0 && targetMatchesAny(target, categories)) return true;
  if (keywords.length > 0 && targetMatchesAny(target, keywords)) return true;
  const candidateCategoryKey = gameCategoryEquivalenceKey(target.category ?? "");
  return candidateCategoryKey !== null
    && categories.some((category) => gameCategoryEquivalenceKey(category) === candidateCategoryKey);
}

// W48-1 [프로드 실측]: /apply?locale=en 한 모양만 봤다(프로드 0건) — 실제 정적 링크는 typeform·challenges.
const STALE_LIVE_COLDMAIL_LINK_PATTERNS = [
  "/apply?locale=en",
  "supercent.typeform.com/to/",
  "challenges.supercent.io/",
];

type StaleLiveColdMailVerdict =
  | { stale: false }
  | { stale: true; reason: "no_placeholder" }
  | { stale: true; reason: "static_link"; matchedPattern: string };

function describeStaleLiveColdMailBody(value: string): StaleLiveColdMailVerdict {
  if (!/\{\{\s*(?:apply_link|form_link)\s*\}\}/i.test(value)) return { stale: true, reason: "no_placeholder" };
  const lowerValue = value.toLowerCase();
  const normalizedRenderedHtml = sanitizeMailHtml(value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .toLowerCase();
  for (const pattern of STALE_LIVE_COLDMAIL_LINK_PATTERNS) {
    if (lowerValue.includes(pattern) || normalizedRenderedHtml.includes(pattern)) {
      return { stale: true, reason: "static_link", matchedPattern: pattern };
    }
  }
  return { stale: false };
}

export function isStaleLiveColdMailBody(value: string): boolean {
  return describeStaleLiveColdMailBody(value).stale;
}

export function sanitizeCampaignColdMail(value: unknown, createdAtIso: string) {
  const input = isRecord(value) ? value : {};
  const subject = stringField(input, "subject", "").slice(0, 400);
  const bodyFormat = normalizeProgramColdmailBodyFormat(input.bodyFormat);
  // W8-FINAL R8⑤: 예전에는 여기서 본문을 상한까지 **조용히 잘라냈다** — 83K 본문이 포맷 토글(html→
  // markdown)에 따라 무경고로 8,000자에서 끊긴 채 실제 수신자에게 나갈 수 있었다. 프로그램 콜드메일
  // 쓰기 경로가 이미 쓰는 strict 정규화를 그대로 재사용해 **거부**한다("쓰기 경로는 초과 시 잘라내지
  // 않고 명시적으로 거부한다" — PROGRAM_COLDMAIL_HTML_BODY_MAX_CHARS 주석의 기존 규칙과 동일).
  const body = normalizeProgramColdmailBody(input.body, "", bodyFormat, true);
  if (!subject && !body) return null;
  const placeholders = stringArrayField(input.placeholders, 50);
  return {
    subject,
    body,
    placeholders: placeholders.length > 0 ? placeholders : extractTemplatePlaceholders(subject, body),
    preview: stringField(input, "preview", "").slice(0, 1000),
    sourceCountry: stringField(input, "sourceCountry", "KR").toUpperCase().slice(0, 4),
    // bodyFormat:"html"은 운영자가 이 캠페인 전용 콜드메일 본문을 원문 HTML로 직접 작성해
    // 마크다운 변환 없이 그대로 보내는 옵션(기본값 "markdown" — 기존 캠페인과 동일하게 동작).
    bodyFormat,
    updatedAtIso: createdAtIso,
  };
}

type ColdMailPick = { subject: string; body: string; bodyFormat: ProgramColdmailBodyFormat } | null;

// 프로그램 콜드메일 템플릿에서 수신자 국가(region)에 맞는 변형을 고른다.
// localized[region]가 있으면 그것을, 없으면 원본(subject/body)을. coldMail이 비었으면 null(기본 프로파일 템플릿 사용).
// bodyFormat:"html"은 국가별 자동번역 자체가 없는 모드라 localized를 절대 참조하지 않고 항상 원문을 쓴다
// (localizeProgramMailTemplate도 html 모드에서 번역을 아예 돌리지 않음 — 방어적 이중 가드).
function pickColdMailTemplate(coldMail: Record<string, unknown> | null, region: string): ColdMailPick {
  if (!coldMail) return null;
  const sourceSubject = stringField(coldMail, "subject", "");
  const sourceBody = stringField(coldMail, "body", "");
  if (!sourceSubject && !sourceBody) return null;
  const bodyFormat = normalizeProgramColdmailBodyFormat(coldMail.bodyFormat);
  if (bodyFormat === "html") {
    return { subject: sourceSubject, body: sourceBody, bodyFormat };
  }
  const localized = isRecord(coldMail.localized) ? coldMail.localized : {};
  const variant = region && isRecord((localized as Record<string, unknown>)[region])
    ? ((localized as Record<string, unknown>)[region] as Record<string, unknown>)
    : null;
  const sourceHash = coldMailSourceHash(
    sourceSubject,
    sourceBody,
    stringField(coldMail, "sourceCountry", "KR"),
  );
  if (variant && stringField(variant, "sourceHash", "") === sourceHash) {
    const vs = stringField(variant, "subject", "");
    const vb = stringField(variant, "body", "");
    if (vs || vb) return { subject: vs || sourceSubject, body: vb || sourceBody, bodyFormat };
  }
  return { subject: sourceSubject, body: sourceBody, bodyFormat };
}

// ── 국가별 콜드메일 1회 번역 캐시 (G7 S2) ───────────────────────────────────
const COUNTRY_LANG: Record<string, { lang: string; name: string }> = {
  US: { lang: "en", name: "English" }, GB: { lang: "en", name: "English" }, AU: { lang: "en", name: "English" }, IN: { lang: "en", name: "English" },
  BR: { lang: "pt", name: "Portuguese" }, PT: { lang: "pt", name: "Portuguese" },
  KR: { lang: "ko", name: "Korean" },
  JP: { lang: "ja", name: "Japanese" },
  ID: { lang: "id", name: "Indonesian" },
  ES: { lang: "es", name: "Spanish" }, MX: { lang: "es", name: "Spanish" },
  FR: { lang: "fr", name: "French" }, DE: { lang: "de", name: "German" },
  VN: { lang: "vi", name: "Vietnamese" }, TH: { lang: "th", name: "Thai" },
};
function langForCountry(country: string): { lang: string; name: string } {
  return COUNTRY_LANG[country.toUpperCase()] ?? { lang: country.toLowerCase(), name: country };
}
function coldMailSourceHash(subject: string, body: string, sourceCountry: string): string {
  return createHash("sha1").update(`${subject}\0${body}\0${sourceCountry}`).digest("hex").slice(0, 16);
}

const COLD_MAIL_TRANSLATE_SCHEMA = {
  type: "OBJECT",
  properties: { subject: { type: "STRING" }, body: { type: "STRING" } },
  required: ["subject", "body"],
};
type TranslateOutput = { subject: string; body: string; inputTokens: number; outputTokens: number; estimatedCostUsd: number; modelId: string };

// 번역 chokepoint: 에뮬레이터는 결정론적 mock(Vertex 미호출·비용 0), prod는 callModel(SEC-P0-005 내부 게이트웨이/Vertex).
async function translateColdMailVariant(source: { subject: string; body: string }, target: { lang: string; name: string }): Promise<TranslateOutput> {
  if (process.env.FUNCTIONS_EMULATOR === "true") {
    return { subject: `[${target.lang}] ${source.subject}`, body: `[${target.lang}] ${source.body}`, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, modelId: "mock-translate" };
  }
  const prompt = `You are a professional email localizer. Translate the cold-outreach email below into ${target.name}. Preserve EVERY {{placeholder}} token exactly as written — never translate text inside {{ }}. Keep a concise, professional tone. Respond as JSON {"subject","body"}.\n\nSUBJECT:\n${source.subject}\n\nBODY:\n${source.body}`;
  const modelId = selectVertexModelForTask("mail_gateway_triage");
  const result = await callModel<{ subject: string; body: string }>(modelId, COLD_MAIL_TRANSLATE_SCHEMA, prompt);
  // S12 A5: 콜드메일 번역도 다른 callModel 사용처와 동일하게 llm_usage(정본, aiHubReport.reportLlmUsage)에 집계된다.
  // 이전엔 이 chokepoint만 리포팅이 빠져 있었음(콜드메일 사용량이 대시보드에 안 잡힘).
  await reportLlmUsage({
    sessionId: newSessionId(),
    toolId: "mail.coldmail_translate",
    modelId: result.modelId,
    provider: result.provider,
    transport: result.transport ?? "unverified",
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    totalCostUsd: result.estimatedCostUsd,
  });
  const json = (result.json ?? {}) as Record<string, unknown>;
  return {
    subject: stringField(json, "subject", source.subject),
    body: stringField(json, "body", source.body),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCostUsd: result.estimatedCostUsd,
    modelId: result.modelId,
  };
}

// COST-P0-011: 실제 모델 호출(캐시 hit 아님)마다 토큰·비용 로그. mock(에뮬)은 호출 없음 → 로그 없음.
// per-event 원가 로그는 llm_usage_events에 남긴다(llm_usage는 정본 집계 스키마 — aiHubReport.LlmUsageDoc 전용,
// 이 함수는 programId/country 단위 감사 추적용으로 스키마가 달라 llm_usage에 섞으면 대시보드 합산이 깨진다).
async function logColdMailTranslationCost(programId: string, country: string, out: TranslateOutput, nowIsoValue: string): Promise<void> {
  if (out.modelId === "mock-translate") return;
  await adminDb.collection("llm_usage_events").doc(safeDocId(`coldmail-localize-${programId}-${country}-${nowIsoValue}`)).set({
    source: "coldMailLocalize",
    programId,
    country,
    model: out.modelId,
    inputTokens: out.inputTokens,
    outputTokens: out.outputTokens,
    estimatedCostUsd: out.estimatedCostUsd,
    createdAtIso: nowIsoValue,
  }, { merge: true });
}

// 프로그램 원본 콜드메일 → 타깃 국가별로 1회 번역해 coldMail.localized에 저장(sourceHash 캐시로 중복 호출 방지).
export async function localizeProgramMailTemplate(request: CallableRequest) {
  const uid = request.auth?.uid;
  const role = request.auth?.token?.role ?? "guest";
  const team = request.auth?.token?.team ?? "—";
  if (!uid || !CAMPAIGN_ROLES.has(role)) {
    const error = new Error(!uid ? "unauthenticated" : "permission-denied: manager role required");
    Object.assign(error, { code: !uid ? "unauthenticated" : "permission-denied" , errorCode: "localize_program_mail_template_unauthorized"});
    throw error;
  }
  const data = isRecord(request.data) ? request.data : {};
  const programId = typeof data.programId === "string" ? data.programId.trim().slice(0, 120) : "";
  if (!programId) throw Object.assign(new Error("programId required"), { code: "invalid-argument", errorCode: "localize_program_mail_template_program_id_required" });
  const authScope = programColdmailAuthScope(request, uid, role, team);

  const programRef = adminDb.collection("programs").doc(programId);
  const snapshot = await programRef.get();
  if (!snapshot.exists) throw Object.assign(new Error("program not found"), { code: "not-found", errorCode: "localize_program_mail_template_program_found" });
  assertProgramColdmailScope(snapshot, authScope);
  const coldMail = isRecord(snapshot.data()?.coldMail) ? (snapshot.data()!.coldMail as Record<string, unknown>) : null;
  const subject = coldMail ? stringField(coldMail, "subject", "") : "";
  const body = coldMail ? stringField(coldMail, "body", "") : "";
  if (!coldMail || (!subject && !body)) throw Object.assign(new Error("program has no cold-mail template"), { code: "failed-precondition", errorCode: "localize_program_mail_template_program_cold_mail_template" });
  const sourceCountry = stringField(coldMail, "sourceCountry", "KR");
  const targetCountries = Array.isArray(coldMail.targetCountries)
    ? countryArrayField(coldMail.targetCountries)
    : [];
  const existingLocalized = isRecord(coldMail.localized) ? (coldMail.localized as Record<string, Record<string, unknown>>) : {};

  const sourceHash = coldMailSourceHash(subject, body, sourceCountry);
  const sourceVersion = programColdmailStoredVersion(coldMail.version);
  // 설계 결정: bodyFormat:"html"(원문 HTML 직접 작성) 템플릿은 국가별 자동번역을 아예 돌리지 않는다
  // (영문/원문 그대로 발송). 번역 호출·비용·localized 쓰기 전부 스킵 — pickColdMailTemplate도 이 모드에서
  // localized를 절대 참조하지 않는 동일한 가드를 갖는다(이중 방어).
  if (normalizeProgramColdmailBodyFormat(coldMail.bodyFormat) === "html") {
    const behaviorLog = makeBehaviorLog(
      { uid, role, team, ip: request.rawRequest?.ip ?? "0.0.0.0" },
      `program.coldmail.localize(${programId}):skipped-html-body-format`,
      "success",
    );
    behaviorLogs.push(behaviorLog);
    return {
      ok: true,
      programId,
      sourceHash,
      sourceVersion,
      translated: [],
      skipped: [],
      discarded: [],
      behaviorLog,
    };
  }
  const stampedAt = nowIso();
  const translated: string[] = [];
  const skipped: string[] = [];
  const discarded: string[] = [];
  for (const country of targetCountries) {
    const existing = isRecord(existingLocalized[country]) ? existingLocalized[country] : null;
    if (existing && stringField(existing, "sourceHash", "") === sourceHash) {
      skipped.push(country);
      continue;
    }
    const target = langForCountry(country);
    const out = await translateColdMailVariant({ subject, body }, target);
    const localizedVariant = {
      subject: out.subject,
      body: out.body,
      lang: target.lang,
      sourceHash,
      translatedAtIso: stampedAt,
    };
    const writeStatus = await adminDb.runTransaction(async (transaction) => {
      const currentSnapshot = await transaction.get(programRef);
      if (!currentSnapshot.exists) return "stale" as const;
      assertProgramColdmailScope(currentSnapshot, authScope);
      const currentColdmail = isRecord(currentSnapshot.data()?.coldMail)
        ? (currentSnapshot.data()!.coldMail as Record<string, unknown>)
        : null;
      if (!currentColdmail) return "stale" as const;
      const currentSubject = stringField(currentColdmail, "subject", "");
      const currentBody = stringField(currentColdmail, "body", "");
      const currentSourceCountry = stringField(currentColdmail, "sourceCountry", "KR");
      const currentSourceHash = coldMailSourceHash(
        currentSubject,
        currentBody,
        currentSourceCountry,
      );
      const currentVersion = programColdmailStoredVersion(currentColdmail.version);
      const currentTargets = countryArrayField(currentColdmail.targetCountries);
      if (
        currentSourceHash !== sourceHash
        || currentVersion !== sourceVersion
        || !currentTargets.includes(country)
      ) {
        return "stale" as const;
      }
      const currentLocalized = isRecord(currentColdmail.localized)
        ? currentColdmail.localized
        : {};
      const currentVariant = isRecord(currentLocalized[country])
        ? currentLocalized[country]
        : null;
      if (
        currentVariant
        && stringField(currentVariant, "sourceHash", "") === sourceHash
      ) {
        return "cached" as const;
      }
      transaction.update(
        programRef,
        new FieldPath("coldMail", "localized", country),
        localizedVariant,
      );
      return "written" as const;
    });
    await logColdMailTranslationCost(programId, country, out, stampedAt);
    if (writeStatus === "written") translated.push(country);
    else if (writeStatus === "cached") skipped.push(country);
    else discarded.push(country);
  }
  const behaviorLog = makeBehaviorLog(
    { uid, role, team, ip: request.rawRequest?.ip ?? "0.0.0.0" },
    `program.coldmail.localize(${programId}):${translated.length}t/${skipped.length}c/${discarded.length}d`,
    "success",
  );
  behaviorLogs.push(behaviorLog);
  return {
    ok: true,
    programId,
    sourceHash,
    sourceVersion,
    translated,
    skipped,
    discarded,
    behaviorLog,
  };
}

// 프로그램 콜드메일 원본 템플릿(제목/본문) + 타깃 국가 저장(UI 편집용).
// 원본 해시가 바뀌면 localized를 즉시 비워 stale 번역이 선택될 수 없게 한다.
export async function updateProgramColdMail(request: CallableRequest) {
  const uid = request.auth?.uid;
  const role = request.auth?.token?.role ?? "guest";
  const team = request.auth?.token?.team ?? "—";
  if (!uid || !CAMPAIGN_ROLES.has(role)) {
    const error = new Error(!uid ? "unauthenticated" : "permission-denied: manager role required");
    Object.assign(error, { code: !uid ? "unauthenticated" : "permission-denied" , errorCode: "update_program_cold_mail_unauthorized"});
    throw error;
  }
  const data = isRecord(request.data) ? request.data : {};
  const programId = typeof data.programId === "string" ? data.programId.trim().slice(0, 120) : "";
  if (!programId) throw Object.assign(new Error("programId required"), { code: "invalid-argument", errorCode: "update_program_cold_mail_program_id_required" });
  const authScope = programColdmailAuthScope(request, uid, role, team);
  const programRef = adminDb.collection("programs").doc(programId);
  const snapshot = await programRef.get();
  if (!snapshot.exists) throw Object.assign(new Error("program not found"), { code: "not-found", errorCode: "update_program_cold_mail_program_found" });
  assertProgramColdmailScope(snapshot, authScope);
  const template = normalizeProgramColdmailInput(data);
  const validation = validateProgramColdmailPlaceholders(template.subject, template.body);
  const staleBody = describeStaleLiveColdMailBody(template.body);
  const preview = programColdmailPreview(
    template,
    programColdmailPreviewValues(data.previewValues ?? data.values),
  );
  const contentHash = programColdmailContentHash(template);
  const currentColdmail = isRecord(snapshot.data()?.coldMail)
    ? (snapshot.data()!.coldMail as Record<string, unknown>)
    : null;
  const currentTemplate = currentColdmail
    ? normalizeStoredProgramColdmail(currentColdmail)
    : null;
  const currentVersion = programColdmailStoredVersion(currentColdmail?.version);
  const currentHash = currentTemplate ? programColdmailContentHash(currentTemplate) : "";
  let behaviorLog = makeBehaviorLog(
    { uid, role, team, ip: request.rawRequest?.ip ?? "0.0.0.0" },
    data.dryRun === true
      ? `program.coldmail.preview(${programId})`
      : `program.coldmail.save(${programId})`,
    "success",
  );

  if (data.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      sideEffects: "none" as const,
      programId,
      coldMail: template,
      preview,
      contentHash,
      currentHash,
      currentVersion,
      validation,
      staleBody,
      behaviorLog,
    };
  }

  // W48-1: 발송 시점에만 있던 게이트(W13 결함)를 쓰기 경로로 앞당긴다 — dryRun은 거부하지 않는다.
  if (staleBody.stale) {
    throw programColdmailError(
      "invalid-argument",
      staleBody.reason === "no_placeholder"
        ? "cold-mail body has no {{apply_link}}/{{form_link}} placeholder"
        : `cold-mail body contains a static application link pattern: ${staleBody.matchedPattern}`,
      "update_program_cold_mail_stale_body",
    );
  }

  const expectation = programColdmailCasExpectation(data);
  const stampedAt = nowIso();
  const auditRef = adminDb.collection(PROGRAM_COLDMAIL_AUDIT_COLLECTION).doc();
  const applied = await adminDb.runTransaction(async (transaction) => {
    const currentSnapshot = await transaction.get(programRef);
    if (!currentSnapshot.exists) {
      throw programColdmailError("not-found", "program not found");
    }
    assertProgramColdmailScope(currentSnapshot, authScope);
    const storedColdmail = isRecord(currentSnapshot.data()?.coldMail)
      ? (currentSnapshot.data()!.coldMail as Record<string, unknown>)
      : null;
    const beforeVersion = programColdmailStoredVersion(storedColdmail?.version);
    const beforeTemplate = storedColdmail
      ? normalizeStoredProgramColdmail(storedColdmail)
      : null;
    const beforeHash = beforeTemplate
      ? programColdmailContentHash(beforeTemplate)
      : "";
    if (storedColdmail && beforeHash === contentHash) {
      return {
        beforeHash,
        beforeVersion,
        nextVersion: beforeVersion,
        noop: true as const,
        localizedInvalidated: false,
      };
    }
    assertProgramColdmailCas(expectation, beforeVersion, beforeHash);
    const beforeSourceHash = beforeTemplate
      ? coldMailSourceHash(
          beforeTemplate.subject,
          beforeTemplate.body,
          beforeTemplate.sourceCountry,
        )
      : "";
    const nextSourceHash = coldMailSourceHash(
      template.subject,
      template.body,
      template.sourceCountry,
    );
    const sourceChanged = beforeSourceHash !== nextSourceHash;
    const storedLocalized = storedColdmail && isRecord(storedColdmail.localized)
      ? storedColdmail.localized
      : {};
    const localized = sourceChanged
      ? {}
      : Object.fromEntries(
          Object.entries(storedLocalized).filter(([country, variant]) =>
            template.targetCountries.includes(country)
            && isRecord(variant)
            && stringField(variant, "sourceHash", "") === nextSourceHash),
        );
    const nextVersion = beforeVersion + 1;
    transaction.set(
      programRef,
      {
        coldMail: {
          ...(storedColdmail ?? {}),
          ...template,
          sourceHash: nextSourceHash,
          localized,
          version: nextVersion,
          contentHash,
          updatedAtIso: stampedAt,
          updatedAt: FieldValue.serverTimestamp(),
        },
      },
      { merge: true },
    );
    transaction.create(auditRef, {
      action: storedColdmail ? "update" : "create",
      programRef: programRef.path,
      templateRef: `${programRef.path}#coldMail`,
      beforeVersion,
      afterVersion: nextVersion,
      beforeHash,
      afterHash: contentHash,
      changedFields: programColdmailChangedFields(beforeTemplate, template),
      actorUserIdHash: createHash("sha256").update(uid).digest("hex").slice(0, 16),
      actorRole: role,
      createdAtIso: stampedAt,
      createdAt: FieldValue.serverTimestamp(),
    });
    return {
      beforeHash,
      beforeVersion,
      nextVersion,
      noop: false as const,
      localizedInvalidated: sourceChanged,
    };
  });

  if (applied.noop) {
    behaviorLog = makeBehaviorLog(
      { uid, role, team, ip: request.rawRequest?.ip ?? "0.0.0.0" },
      `program.coldmail.noop(${programId})`,
      "success",
    );
  }
  behaviorLogs.push(behaviorLog);
  return {
    ok: true,
    dryRun: false,
    applied: !applied.noop,
    noop: applied.noop,
    noopReason: applied.noop ? "identical_content" : undefined,
    localizedInvalidated: applied.localizedInvalidated,
    programId,
    coldMail: { ...template, version: applied.nextVersion, contentHash },
    preview,
    contentHash,
    previousHash: applied.beforeHash,
    previousVersion: applied.beforeVersion,
    version: applied.nextVersion,
    auditRef: applied.noop ? null : auditRef.path,
    validation,
    behaviorLog,
  };
}

type ProgramColdmailStaleBodyFinding = {
  kind: "program" | "campaign";
  id: string;
  classification: "no_placeholder" | "static_link" | "ok";
  matchedPattern?: string;
};

// W48-1: 1회성 멱등 점검기 — programs/campaigns 콜드메일 본문 결함을 찾아 **기록만** 한다(본문은 절대
// 고치지 않는다 — 헤세 결정). 새 콜러블 export는 늘리지 않는다: actor/request 컨텍스트가 없는 내부
// 함수로 둔다(운영 트리거가 필요해지면 기존 관리 콜러블에 모드로 얹는다). 감사 문서 ID는
// (kind, docId, bodyHash) 기반이라 동일 본문 재실행이 감사 행을 중복시키지 않는다.
export async function auditProgramColdmailStaleBodies(
  options: { dryRun?: boolean } = {},
): Promise<{ scanned: number; written: number; findings: ProgramColdmailStaleBodyFinding[] }> {
  const dryRun = options.dryRun !== false;
  const collections = await Promise.all(
    (["programs", "campaigns"] as const).map((name) => adminDb.collection(name).select("coldMail").get()),
  );
  const findings: ProgramColdmailStaleBodyFinding[] = [];
  let written = 0;
  for (const [index, kind] of (["program", "campaign"] as const).entries()) {
    for (const doc of collections[index].docs) {
      const coldMail = isRecord(doc.data().coldMail) ? (doc.data().coldMail as Record<string, unknown>) : {};
      const body = stringField(coldMail, "body", "");
      if (!body) continue;
      const verdict = describeStaleLiveColdMailBody(body);
      const classification = verdict.stale ? verdict.reason : "ok";
      const matchedPattern = verdict.stale && verdict.reason === "static_link" ? verdict.matchedPattern : undefined;
      findings.push({ kind, id: doc.id, classification, ...(matchedPattern ? { matchedPattern } : {}) });
      if (dryRun) continue;
      const bodyHash = createHash("sha256").update(body).digest("hex").slice(0, 16);
      await adminDb.collection(PROGRAM_COLDMAIL_AUDIT_COLLECTION)
        .doc(safeDocId(`stale-body-scan-${kind}-${doc.id}-${bodyHash}`))
        .set({
          action: "stale_body_scan", kind, docRef: `${kind}s/${doc.id}`, classification,
          matchedPattern: matchedPattern ?? null, bodyHash, createdAtIso: nowIso(), createdAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      written += 1;
    }
  }
  return { scanned: findings.length, written, findings };
}

function redactedOutreachResponse(outreach: Record<string, unknown>) {
  const email = validEmailField(outreach.creatorEmail) || validEmailField(outreach.to);
  return {
    id: stringField(outreach, "id", ""),
    campaignId: stringField(outreach, "campaignId", ""),
    programId: stringField(outreach, "programId", ""),
    targetId: stringField(outreach, "targetId", ""),
    creatorId: stringField(outreach, "creatorId", ""),
    candidateId: stringField(outreach, "candidateId", ""),
    conversationId: stringField(outreach, "conversationId", ""),
    messageRef: stringField(outreach, "messageRef", ""),
    status: stringField(outreach, "status", ""),
    deliveryState: stringField(outreach, "deliveryState", ""),
    humanGate: stringField(outreach, "humanGate", ""),
    liveSend: outreach.liveSend === true,
    dryRun: outreach.dryRun === true,
    sendAfterIso: stringField(outreach, "sendAfterIso", ""),
    liveSendBatchId: stringField(outreach, "liveSendBatchId", ""),
    liveSendBatchCap: numberField(outreach, "liveSendBatchCap", 0),
    recipientMasked: email ? email.replace(/^(.{0,2}).*(@.*)$/u, "$1***$2") : "",
  };
}

function redactedCampaignResponse(campaign: Record<string, unknown>) {
  const coldMail = isRecord(campaign.coldMail) ? campaign.coldMail : null;
  return {
    id: stringField(campaign, "id", ""),
    name: stringField(campaign, "name", ""),
    owner: stringField(campaign, "owner", ""),
    source: stringField(campaign, "source", ""),
    status: stringField(campaign, "status", ""),
    priority: stringField(campaign, "priority", ""),
    programId: stringField(campaign, "programId", ""),
    allowResendInProgram: campaign.allowResendInProgram === true,
    autoDiscovery: isRecord(campaign.autoDiscovery) ? campaign.autoDiscovery : undefined,
    gameId: stringField(campaign, "gameId", ""),
    targetMetric: stringField(campaign, "targetMetric", ""),
    targetValue: numberField(campaign, "targetValue", 0),
    campaignQuota: numberField(campaign, "campaignQuota", 0),
    controlVersion: numberField(campaign, "controlVersion", 0),
    total: numberField(campaign, "total", 0),
    queued: numberField(campaign, "queued", 0),
    liveSendCap: numberField(campaign, "liveSendCap", 0),
    liveSendCapSource: stringField(campaign, "liveSendCapSource", ""),
    liveSendBatchId: stringField(campaign, "liveSendBatchId", ""),
    liveSendBatchCap: numberField(campaign, "liveSendBatchCap", 0),
    liveSendBatchCapSource: stringField(campaign, "liveSendBatchCapSource", ""),
    sent: numberField(campaign, "sent", 0),
    replied: numberField(campaign, "replied", 0),
    negotiating: numberField(campaign, "negotiating", 0),
    contracted: numberField(campaign, "contracted", 0),
    live: numberField(campaign, "live", 0),
    bounced: numberField(campaign, "bounced", 0),
    targeting: isRecord(campaign.targeting) ? campaign.targeting : undefined,
    targetingCriteria: isRecord(campaign.targetingCriteria) ? campaign.targetingCriteria : undefined,
    countryTargeting: isRecord(campaign.countryTargeting) ? campaign.countryTargeting : undefined,
    effectiveCountryTargeting: isRecord(campaign.effectiveCountryTargeting) ? campaign.effectiveCountryTargeting : undefined,
    excludedCountries: Array.isArray(campaign.excludedCountries) ? campaign.excludedCountries : [],
    coldMail: coldMail ? {
      configured: true,
      placeholderCount: Array.isArray(coldMail.placeholders) ? coldMail.placeholders.length : 0,
      sourceCountry: stringField(coldMail, "sourceCountry", ""),
      updatedAtIso: stringField(coldMail, "updatedAtIso", ""),
    } : undefined,
    ...(Array.isArray(campaign.targetCountries) ? { targetCountries: campaign.targetCountries } : {}),
    targetCountryMix: countryMixField(campaign.targetCountryMix, []),
    includeKeywords: Array.isArray(campaign.includeKeywords) ? campaign.includeKeywords : [],
    excludeKeywords: Array.isArray(campaign.excludeKeywords) ? campaign.excludeKeywords : [],
    allowInflyOverlap: campaign.allowInflyOverlap === true,
    senderName: stringField(campaign, "senderName", ""),
    sendSchedule: stringField(campaign, "sendSchedule", ""),
    createdAtIso: stringField(campaign, "createdAtIso", ""),
    updatedAtIso: stringField(campaign, "updatedAtIso", ""),
  };
}

type AuthoritativeCampaignProgramPolicy = {
  requestedProgramId: string;
  canonicalProgramId: string;
  aliasRegistryRevision: string;
  programRef: string;
  programPolicyRef: string;
  program: Record<string, unknown>;
};

async function resolveAuthoritativeCampaignProgramPolicy(
  requestedProgramId: string,
): Promise<AuthoritativeCampaignProgramPolicy> {
  const rawProgramId = requestedProgramId || DEFAULT_PROGRAM_ID;
  const aliasRegistry = await readConfirmedProgramAliasRegistryState({ bypassCache: true });
  const programScope = confirmedProgramScope(rawProgramId, aliasRegistry);
  const canonicalProgramId = safeDocId(programScope.canonicalProgramId || DEFAULT_PROGRAM_ID);

  const candidateIds = Array.from(new Set([
    canonicalProgramId,
    ...(canonicalProgramId === SCP_CANONICAL_PROGRAM_ID ? [DEFAULT_PROGRAM_ID] : []),
  ].map(safeDocId).filter(Boolean)));
  const snapshots = await adminDb.getAll(...candidateIds.map((id) => adminDb.collection("programs").doc(id)));
  const snapshot = snapshots.find((item) => item.exists && safeDocId(item.id) === canonicalProgramId)
    ?? (canonicalProgramId === SCP_CANONICAL_PROGRAM_ID
      ? snapshots.find((item) => item.exists && resolveCanonicalProgramId(item.id, aliasRegistry.aliasMap) === canonicalProgramId)
      : undefined);
  if (!snapshot) {
    const error = new Error("failed-precondition: authoritative program does not exist");
    Object.assign(error, { code: "failed-precondition", errorCode: "campaign_program_policy_program_missing" });
    throw error;
  }
  const program: Record<string, unknown> = { id: snapshot.id, ...(snapshot.data() ?? {}) };
  const claimedCanonicalProgramId = resolveCanonicalProgramId(program.canonicalProgramId, aliasRegistry.aliasMap);
  if (claimedCanonicalProgramId && safeDocId(claimedCanonicalProgramId) !== canonicalProgramId) {
    const error = new Error("failed-precondition: authoritative program scope mismatch");
    Object.assign(error, { code: "failed-precondition", errorCode: "campaign_program_policy_scope_mismatch" });
    throw error;
  }

  return {
    requestedProgramId,
    canonicalProgramId,
    aliasRegistryRevision: aliasRegistry.revision,
    programRef: `programs/${canonicalProgramId}`,
    programPolicyRef: snapshot.ref.path,
    program,
  };
}

async function assertAuthoritativeCampaignProgramPolicyCurrent(
  policy: AuthoritativeCampaignProgramPolicy,
): Promise<void> {
  const aliasRegistry = await readConfirmedProgramAliasRegistryState({ bypassCache: true });
  const liveScope = confirmedProgramScope(policy.requestedProgramId || DEFAULT_PROGRAM_ID, aliasRegistry);
  if (
    aliasRegistry.revision !== policy.aliasRegistryRevision
    || safeDocId(liveScope.canonicalProgramId || DEFAULT_PROGRAM_ID) !== policy.canonicalProgramId
  ) {
    const error = new Error("aborted: confirmed program alias registry changed while creating campaign");
    Object.assign(error, { code: "aborted", errorCode: "campaign_program_alias_registry_changed" });
    throw error;
  }
  const snapshot = await adminDb.doc(policy.programPolicyRef).get();
  const resolvedSnapshotId = resolveCanonicalProgramId(snapshot.id, aliasRegistry.aliasMap);
  const program: Record<string, unknown> = snapshot.data() ?? {};
  const claimedCanonicalProgramId = resolveCanonicalProgramId(program.canonicalProgramId, aliasRegistry.aliasMap);
  if (
    !snapshot.exists
    || safeDocId(resolvedSnapshotId) !== policy.canonicalProgramId
    || (claimedCanonicalProgramId && safeDocId(claimedCanonicalProgramId) !== policy.canonicalProgramId)
  ) {
    const error = new Error("aborted: authoritative campaign program policy changed while creating campaign");
    Object.assign(error, { code: "aborted", errorCode: "campaign_program_policy_changed" });
    throw error;
  }
}

/** F4e: 캠페인 문서/응답에 실을 준비 카운트만 추린다(targets·discovery 메타 제외). */
const CAMPAIGN_OWNERSHIP_FIELD_KEYS = [
  "accountScopeVersion",
  "ownerUid",
  "ownerUids",
  "ownerEmail",
  "ownerAuthTenantId",
  "ownerOrgId",
  "ownerMailAccountId",
  "ownerMailAccountIds",
  "ownerOrgResolutionStatus",
  "ownerTeam",
  "accountOwnerUid",
  "accountOwnerUids",
  "accountOwnerEmail",
  "accountOwnerAuthTenantId",
  "accountOwnerOrgId",
  "accountOwnerMailAccountId",
  "accountOwnerMailAccountIds",
  "programOwnerUid",
  "programOwnerUids",
  "programOwnerEmail",
  "programOwnerAuthTenantId",
  "programOwnerOrgId",
  "programOwnerMailAccountId",
  "programOwnerMailAccountIds",
  "campaignOwnerUid",
  "campaignOwnerUids",
  "campaignOwnerEmail",
  "campaignOwnerAuthTenantId",
  "campaignOwnerOrgId",
  "campaignOwnerMailAccountId",
  "campaignOwnerMailAccountIds",
] as const;

function withoutCampaignOwnershipFields(fields: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...fields };
  for (const key of CAMPAIGN_OWNERSHIP_FIELD_KEYS) delete clean[key];
  return clean;
}

function campaignPreparationCounts(preparation: ProgramCampaignTargetPreparation): Record<string, number> {
  const {
    dryRun: _dryRun,
    shortfallDiscovery: _shortfallDiscovery,
    createdTargetRefPaths: _createdTargetRefPaths,
    targets: _targets,
    safetyQuarantineFallbackErrorCode: _safetyQuarantineFallbackErrorCode,
    // R33-1: 사유별 분포는 숫자 맵(중첩)이라 이 평면 카운트에는 넣지 않는다 — 별도 필드로 나간다.
    programScopeRejectedReasons: _programScopeRejectedReasons,
    ...counts
  } = preparation;
  return counts;
}

/**
 * F2: 흡수된 준비의 batch 는 캠페인 커밋보다 먼저 커밋된다. 그 사이 게이트(no_email_ready ·
 * all_suppressed · all_already_touched · wave gate · live safety precheck)에서 throw 하면 캠페인은
 * 없는데 ready 행만 durable 하게 남고, F1 의 경계와 결합해 다음 시도가 영구 차단됐다.
 * 이 래퍼가 **이 호출이 새로 만든 행만** 보상 삭제한 뒤 원래 오류를 그대로 다시 던진다.
 */
export async function createCampaign(request: CallableRequest) {
  const preparedRefPaths: string[] = [];
  try {
    return await createCampaignWithPreparedTargets(request, preparedRefPaths);
  } catch (error) {
    await rollbackPreparedProgramTargets(preparedRefPaths, "create_campaign_failed", error);
    throw error;
  }
}

type CampaignRefillContext = {
  id: string;
  campaign: Record<string, unknown>;
};

// Flu/Task-43 적대 리뷰 P0: 캠페인 생성의 target당 초안 생성 블록(resolveMailProfile 결과를
// 재사용해 compileMailArtifact 로 제목/본문을 컴파일하고 mail-safety 를 판정한다)을 그대로
// 추출했다 — createCampaignWithPreparedTargets 아래 mapWithConcurrency 콜백 본문이었던 코드를
// 자유 변수만 ctx 필드로 바꿔 옮겼을 뿐, 로직은 바이트 단위로 동일하다(기존 캠페인 생성 테스트가
// 계속 통과하는 것이 그 증거). candidateTable.ts sendCandidateColdMail 이 실제 콜드메일 큐 경로에
// 후보 1건을 태울 때 이 함수를 그대로 재사용한다(중복 구현 금지).
export type CampaignOutreachDraftContext = {
  campaignId: string;
  campaignName: string;
  owner: string;
  gameId: string;
  senderName: string;
  // 캠페인 생성 시점엔 sanitizeCampaignColdMail 을 거친 캠페인 전용 오버라이드(로컬라이즈 없음,
  // 그대로 사용). 없으면 programColdMail 로 폴백해 지역별 로컬라이즈를 태운다.
  campaignColdMail: ReturnType<typeof sanitizeCampaignColdMail>;
  programColdMail: Record<string, unknown> | null;
  profileResolution: MailProfileResolution;
  allowInflyOverlap: boolean;
  // 테스트 전용 주입점(기본값은 항상 실제 함수 — createCampaignWithPreparedTargets는 이 필드를 절대
  // 채우지 않으므로 캠페인 생성 경로는 바이트 단위로 동일하다). candidateTable.ts sendCandidateColdMail
  // 은 Firestore 에뮬레이터 없이 fake db로 단위 테스트하기 위해 이 두 안전 판정을 주입한다.
  evaluateMailProfileSafety?: typeof evaluateMailProfileSafety;
  evaluateMailSafety?: typeof evaluateMailSafety;
};

export function campaignOutreachCompiledArtifactFields(input: {
  artifact: ReturnType<typeof compileMailArtifact>;
  subject: string;
  templateValues: Record<string, unknown>;
  compilerInputBody: string;
}) {
  const { artifact, subject, templateValues, compilerInputBody } = input;
  return {
    bodyFormat: artifact.bodyFormat,
    compilerVersion: artifact.compilerVersion,
    templateRevision: artifact.templateRevision,
    compiledHtml: artifact.compiledHtml,
    text: artifact.text,
    contentHash: artifact.contentHash,
    sourceHash: artifact.sourceHash,
    compiledHash: artifact.compiledHash,
    textHash: artifact.textHash,
    // 승인 지문은 assetsHash를 포함하므로 자산 변경은 재승인을 요구한다.
    assets: mailAssetManifest(artifact.assets),
    compiledFingerprint: compiledArtifactFingerprint(artifact),
    templateValues,
    compilerInputBody,
    subjectHash: createHash("sha256").update(subject).digest("hex"),
  };
}

export async function prepareCampaignOutreachDraft(ctx: CampaignOutreachDraftContext, target: CampaignTarget) {
  const targetId = safeDocId(target.id);
  const outreachId = `${ctx.campaignId}_${targetId}`;
  const trackingId = `campaign-${ctx.campaignId}-${targetId}`;
  const messageRef = `message_sources/${outreachId}`;
  const summaryKr = `${ctx.campaignName} 협업 제안 메일 초안 생성 — ${target.name}`;
  const to = validEmailField(target.email);
  if (!to) throw Object.assign(new Error(`target ${target.id} has no valid email`), { code: "failed-precondition", errorCode: "campaign_live_wave_target_email_invalid" });
  // TASK 3 landing link: mint the Portal-verified outreach_token_v2 Apply link per target when the
  // shared key ring + Portal origin are bound (fail-closed otherwise: templates keep their
  // placeholder). The URL carries only the opaque signed token — expected email crosses only as an
  // HMAC digest inside the signed envelope; traceId=tr_<outreachId> becomes the pipeline trace.
  const outreachLanding = isScpOutreachLandingLinkConfigured()
    ? mintScpOutreachLandingLink({
      // W47: the envelope programId is the Portal-wide apply-gate scope (view-cpm), NOT the
      // program being attributed — the Portal apply gate only recognizes that scope. Real
      // attribution travels through campaignId (resolved on receive), so this must never carry
      // canonicalProgramId (a real pg-* id gets rejected by the gate and the token is dropped).
      programId: PORTAL_PROGRAM_ID,
      campaignId: ctx.campaignId,
      outreachId,
      traceId: `tr_${outreachId}`,
      expectedEmail: to,
    })
    : null;
  const vars = {
    name: target.name,
    creator: target.name,
    game: ctx.campaignName,
    campaign: ctx.campaignName,
    owner: ctx.owner,
    creatorName: target.name,
    channelName: target.handle ?? target.name,
    gameTitle: ctx.gameId,
    campaignName: ctx.campaignName,
    country: target.region ?? "",
    senderName: ctx.senderName,
    ...(outreachLanding ? { apply_link: outreachLanding.url, form_link: outreachLanding.url } : {}),
  };
  const coldMailPick = ctx.campaignColdMail
    ? { subject: ctx.campaignColdMail.subject, body: ctx.campaignColdMail.body, bodyFormat: ctx.campaignColdMail.bodyFormat }
    : pickColdMailTemplate(ctx.programColdMail, target.region ?? "");
  const subject = coldMailPick ? fillTemplateVars(coldMailPick.subject, vars) : `[Supercent] ${ctx.campaignName} 협업 제안`;
  const body = coldMailPick ? fillTemplateVars(coldMailPick.body, vars) : renderMailTemplate(ctx.profileResolution.templateSnapshot, vars);
  const bodyFormat = coldMailPick?.bodyFormat ?? "markdown";
  const artifact = compileMailArtifact({
    body: coldMailPick?.body ?? body,
    bodyFormat,
    values: coldMailPick ? vars : undefined,
    templateRevision: coldMailPick?.bodyFormat === "html"
      ? ctx.profileResolution.templateSnapshot.version
      : ctx.profileResolution.policyVersion,
  });
  const safetyInput = {
    to,
    creatorEmail: target.email ?? "",
    creatorHandle: target.handle ?? "",
    creatorName: target.name,
    creatorCategory: target.category ?? "",
    creatorPlatform: target.platform ?? "",
    creatorRegion: target.region ?? "",
    allowInflyOverlap: ctx.allowInflyOverlap,
    dryRun: true,
    liveSend: false,
    subject,
    body,
    text: `${target.name} ${target.category ?? ""} ${target.platform ?? ""} ${to}`,
  };
  const doEvaluateMailProfileSafety = ctx.evaluateMailProfileSafety ?? evaluateMailProfileSafety;
  const doEvaluateMailSafety = ctx.evaluateMailSafety ?? evaluateMailSafety;
  const [profileSafety, hardSafety] = await Promise.all([
    doEvaluateMailProfileSafety(safetyInput, "campaignOutreach", ctx.profileResolution),
    doEvaluateMailSafety(safetyInput, "campaignOutreach", "manual_send"),
  ]);
  // Actual approval/send re-attests mailbox identity and fails closed.
  const combinedSafety = combineCampaignTargetSafety(profileSafety, hardSafety, {
    deferIdentityUnknownForDraftCreation: ctx.profileResolution.dryRun === true && ctx.profileResolution.liveSend === false,
  });
  // P8③ fail-closed: when the Apply/Form landing link is not bound, `vars` never carries
  // apply_link/form_link, so fillTemplateVars leaves the literal `{{apply_link}}`/`{{form_link}}`
  // placeholder in the rendered subject/body. Sending that literal text to a creator is worse than
  // blocking the target, so this overrides any allowed/human-review verdict — fail-closed instead
  // of a literal placeholder leak.
  const landingLinkPlaceholderExposed = !outreachLanding
    && /\{\{\s*(?:apply_link|form_link)\s*\}\}/i.test(`${subject}\n${body}`);
  const safety: MailProfileSafetyDecision = landingLinkPlaceholderExposed
    ? {
      allowed: false,
      liveSendAllowed: false,
      ruleId: "landing_link_unconfigured",
      reason: "Apply/Form 링크가 바인딩되지 않아 리터럴 placeholder 노출을 막기 위해 발송을 차단했습니다.",
    }
    : combinedSafety;
  return {
    target,
    targetId,
    outreachId,
    trackingId,
    messageRef,
    summaryKr,
    subject,
    to,
    body,
    bodyFormat,
    safety,
    artifact,
    templateValues: coldMailPick ? vars : {},
    compilerInputBody: coldMailPick?.body ?? body,
  };
}

async function createCampaignWithPreparedTargets(
  request: CallableRequest,
  preparedRefPaths: string[],
  refillContext?: CampaignRefillContext,
) {
  const uid = request.auth?.uid;
  const role = request.auth?.token?.role ?? "guest";
  const team = request.auth?.token?.team ?? "—";
  if (!uid || !CAMPAIGN_ROLES.has(role)) {
    const error = new Error(!uid ? "unauthenticated" : "permission-denied: manager role required");
    Object.assign(error, { code: !uid ? "unauthenticated" : "permission-denied" , errorCode: "create_campaign_with_prepared_targets_unauthorized"});
    throw error;
  }
  const data = isRecord(request.data) ? request.data : {};
  const accountOwnershipScope = refillContext
    ? null
    : await resolveAccountOwnershipScopeForRequest(request, "campaign.create", ["super_admin", "admin", "manager"], { data });
  if (accountOwnershipScope) assertWritableAccountOwnershipScope(accountOwnershipScope, "campaign.create");
  const name = typeof data.name === "string" && data.name.trim().length > 0 ? data.name.trim().slice(0, 80) : "새 캠페인";
  const owner = typeof data.owner === "string" && data.owner.trim().length > 0 ? data.owner.trim().slice(0, 40) : "—";
  let ownerScopeFields: Record<string, unknown> = refillContext
    ? {
        createdBy: stringField(refillContext.campaign, "createdBy", uid),
        createdByRole: stringField(refillContext.campaign, "createdByRole", role),
        createdByTeam: stringField(refillContext.campaign, "createdByTeam", team),
        ...(stringField(refillContext.campaign, "ownerUid", "") ? { ownerUid: stringField(refillContext.campaign, "ownerUid", "") } : {}),
        ...(stringField(refillContext.campaign, "ownerTeam", "") ? { ownerTeam: stringField(refillContext.campaign, "ownerTeam", "") } : {}),
        ...(stringField(refillContext.campaign, "createdByEmail", "")
          ? { createdByEmail: stringField(refillContext.campaign, "createdByEmail", "") }
          : {}),
        ...(stringField(refillContext.campaign, "ownerEmail", "")
          ? { ownerEmail: stringField(refillContext.campaign, "ownerEmail", "") }
          : {}),
        ...(stringField(refillContext.campaign, "ownerName", owner)
          ? { ownerName: stringField(refillContext.campaign, "ownerName", owner) }
          : {}),
        ...(stringField(refillContext.campaign, "accountScopeVersion", "") ? { accountScopeVersion: stringField(refillContext.campaign, "accountScopeVersion", "") } : {}),
        ...(stringField(refillContext.campaign, "ownerAuthTenantId", "") ? { ownerAuthTenantId: stringField(refillContext.campaign, "ownerAuthTenantId", "") } : {}),
        ...(stringField(refillContext.campaign, "ownerOrgId", "") ? { ownerOrgId: stringField(refillContext.campaign, "ownerOrgId", "") } : {}),
        ...(stringField(refillContext.campaign, "ownerMailAccountId", "") ? { ownerMailAccountId: stringField(refillContext.campaign, "ownerMailAccountId", "") } : {}),
        ...(Array.isArray(refillContext.campaign.ownerMailAccountIds) ? { ownerMailAccountIds: refillContext.campaign.ownerMailAccountIds.filter((value) => typeof value === "string" && value.trim().length > 0) } : {}),
        ...(stringField(refillContext.campaign, "ownerOrgResolutionStatus", "") ? { ownerOrgResolutionStatus: stringField(refillContext.campaign, "ownerOrgResolutionStatus", "") } : {}),
      }
    : {
        createdBy: uid,
        createdByRole: role,
        createdByTeam: team,
        ownerTeam: team,
        ...(request.auth?.token?.email ? { createdByEmail: request.auth.token.email } : {}),
        ...(owner !== "—" || request.auth?.token?.name ? { ownerName: owner !== "—" ? owner : request.auth?.token?.name } : {}),
        ...accountOwnershipStampForScope(accountOwnershipScope!),
      };
  const priority = ["긴급", "높음", "보통"].includes(data.priority as string) ? (data.priority as string) : "보통";
  const source = ["CSV", "검색", "추천"].includes(data.source as string) ? (data.source as string) : "검색";
  const targetMetric = VALID_CAMPAIGN_TARGET_METRICS.has(data.targetMetric as CampaignTargetMetric) ? data.targetMetric as CampaignTargetMetric : "partners";
  const requestedTotal = typeof data.total === "number" && Number.isFinite(data.total) ? Math.max(0, Math.round(data.total)) : 0;
  const targetValue = typeof data.targetValue === "number" && Number.isFinite(data.targetValue) ? Math.max(1, Math.round(data.targetValue)) : Math.max(1, requestedTotal);
  const total = requestedTotal > 0 ? requestedTotal : Math.max(1, Math.min(targetValue || 10, CAMPAIGN_OUTREACH_QUEUE_LIMIT));
  const programId = typeof data.programId === "string" && data.programId.trim().length > 0 ? data.programId.trim().slice(0, 120) : "";
  const authoritativeProgramPolicy = await runRefillPhase(
    "create_policy_read",
    () => resolveAuthoritativeCampaignProgramPolicy(programId),
  );
  const canonicalProgramId = authoritativeProgramPolicy.canonicalProgramId;
  const dedupProgramId = canonicalProgramId;
  if (!refillContext && accountOwnershipScope) {
    const parentOwnershipStamp = await accountOwnershipStampForOwnedRecordAsync(
      accountOwnershipScope,
      authoritativeProgramPolicy.program,
      "campaign parent program ownership",
    );
    ownerScopeFields = {
      ...withoutCampaignOwnershipFields(ownerScopeFields),
      ...parentOwnershipStamp,
    };
  }
  const programDiscoveryPolicy = resolveProgramDiscoveryCriteria(authoritativeProgramPolicy.program, data);
  const gameId = typeof data.gameId === "string" && data.gameId.trim().length > 0 ? data.gameId.trim().slice(0, 120) : "flu-campaign";
  const allowInflyOverlap = campaignAllowsInflyOverlap(data);
  // R5-B(철칙) 레거시 예외 플래그 — 입력/감사용으로 보존한다. prior-contact 판정 자체는 기본
  // 전역 차단이고, settings.automation.outreachDedupScope==="program"일 때만(아래
  // touchEvidenceAllowResendInProgram) 프로그램 스코프로 좁아진다.
  const allowResendInProgram = campaignAllowsResendInProgram(data);
  // 헤세 결정 2026-09-16: 이 생성/리필 호출 1건당 한 번만 해소한다(행마다 readSettings 재호출 금지).
  // 캠페인이 명시적으로 요청한 allowResendInProgram(감사·campaign 문서·targetingCriteria에 그대로
  // 보존, 아래 참조)은 건드리지 않고, "이미 컨택" 판정에만 쓰는 파생값을 별도로 둔다.
  const outreachDedupScope = resolveOutreachDedupScope(await readSettings());
  const touchEvidenceAllowResendInProgram = allowResendInProgram || outreachDedupScope === "program";
  // W57-M1 [독립 리뷰 2026-08-08]: 증거 캐시 키를 **여기서** 못박는다. 스윕 호출부에서 캠페인 문서의
  // 원본 programId·allowResend 로 키를 잡으면, 별칭 캠페인(programId ≠ canonicalProgramId)이나
  // 합성 요청에서 실사용 컨텍스트와 어긋나 캐시가 조용히 no-op 이 됐다. dedupProgramId(=canonical)와
  // 요청 기준 allowResendInProgram 이 확정된 직후가 유일하게 옳은 자리다.
  bindTouchEvidenceCacheContext({ programId: dedupProgramId, allowResendInProgram: touchEvidenceAllowResendInProgram });
  const campaignProfilePatch = {
    ...(isRecord(data.mailProfile) ? { mailProfile: data.mailProfile } : {}),
    ...(isRecord(data.mailProfiles) ? { mailProfiles: data.mailProfiles } : {}),
  };
  const id = refillContext?.id
    ?? `cp-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const createdAtIso = nowIso();
  const campaignColdMail = sanitizeCampaignColdMail(data.coldMail, createdAtIso);
  const requestedCountryTargeting = requestedCampaignCountryTargeting(data);
  const effectiveCountryTargeting = programDiscoveryPolicy.countryTargeting;
  const effectiveExcludedCountries = new Set(
    countryArrayField(effectiveCountryTargeting.excludedCountries),
  );
  const targetCountries = effectiveCountryTargeting.countryScope === "include"
    ? countryArrayField(effectiveCountryTargeting.includedCountries)
      .filter((country) => !effectiveExcludedCountries.has(country))
    : [];
  const legacyTargetCountries = requestedCountryTargeting.countryScope === "inherit"
    ? undefined
    : requestedCountryTargeting.countryScope === "all"
      ? []
      : requestedCountryTargeting.includedCountries;
  // Live-send intent must be resolved through the same mail-profile stack used for
  // outbound artifacts. Looking only at data.mailProfile misses supported overlays
  // such as mailProfiles.campaign_outreach, program profiles, and global settings.
  const profileResolution = await runRefillPhase("create_profile_read", () => resolveMailProfile({
    campaignId: id,
    programId,
    gameId,
    intent: "campaign_outreach",
    baseIso: createdAtIso,
    campaignOverride: {
      id,
      programId: programId || undefined,
      gameId,
      ...campaignProfilePatch,
      ...ownerScopeFields,
      createdAtIso,
      updatedAtIso: createdAtIso,
    },
  }));
  const liveQueueRequested = profileResolution.liveSend;
  const liveWaveCap = liveQueueRequested
    ? await runRefillPhase("create_wave_config_read", readLiveCampaignWaveCap)
    : 0;
  const configuredLiveSendBatch = liveQueueRequested
    ? await runRefillPhase("create_wave_config_read", () => resolveLiveSendBatchConfig(data))
    : null;
  // Automatic campaigns are one logical campaign batch. A settings review-batch
  // cap (historically 5) must not become the sender's permanent campaign ceiling;
  // daily/ramp/weekly limits still govern when these rows are delivered.
  const liveSendBatchConfig = liveQueueRequested && data.autoApproveLiveSend === true
    ? {
        id: `auto-${id}`,
        cap: refillContext ? targetValue : total,
        source: refillContext ? "campaign.autoRefill" : "campaign.autoApproveLiveSend",
      }
    : configuredLiveSendBatch;
  if (liveQueueRequested && !programId) {
    const error = new Error("failed-precondition: live-send campaigns require a programId");
    Object.assign(error, { code: "failed-precondition", errorCode: "campaign_live_wave_program_id_required" });
    throw error;
  }
  // F3: settings 병합에 타입 검증이 없어 maxLiveCampaignWaveSends 가 비숫자면 Math.round → NaN 이
  // 된다. NaN 이면 `NaN<=0` false · `total>NaN` false · 아래 범위 게이트도 false 가 되어 상한이
  // 전부 무력화된다(구 exact-match 는 total 로 묶여 있어 이 구멍이 없었다 — 새 게이트가 만든 완화).
  // 유한수가 아니면 미설정과 똑같이 fail-closed 한다.
  if (liveQueueRequested && (!Number.isFinite(liveWaveCap) || liveWaveCap <= 0)) {
    const error = new Error("failed-precondition: live-send campaign wave cap is not configured");
    Object.assign(error, { code: "failed-precondition", errorCode: "campaign_live_wave_cap_unconfigured" });
    throw error;
  }
  if (liveQueueRequested && total > liveWaveCap) {
    // F4b: 위저드 기본 요청 수가 kpiTarget 이라 wave cap 보다 큰 프로그램에서는 **이 오류가 최빈**이다.
    // 코드·카운트가 없으면 화면이 영어 일반 문구만 보게 되어 W8-10 목적이 최빈 실패에서 미달성한다.
    const error = new Error(`failed-precondition: live-send campaign requested ${total} recipients but wave cap is ${liveWaveCap}`);
    Object.assign(error, {
      code: "failed-precondition",
      errorCode: "campaign_live_wave_cap_exceeded",
      counts: { requested: total, liveWaveCap },
      details: { counts: { requested: total, liveWaveCap } },
    });
    throw error;
  }
  // R6 [사용자 결정]: 국가 화이트리스트(LIVE_SEND_ALLOWED_COUNTRIES)는 제거되어 전체 국가가
  // 발송 대상이 될 수 있다. 대신 live-send 의도 자체는 여전히 명시적이어야 한다(fail-closed) —
  // scope 판정을 3분기한다:
  //   - "all"                → 전체 국가 발송의 명시적 의사표시로 통과.
  //   - "include" + 빈 목록  → 제외 적용 후 대상이 0건이면 실수 방지를 위해 여전히 거부.
  //   - 그 외("inherit" 등)  → 명시적 의사표시가 없으므로 거부 유지.
  if (liveQueueRequested && effectiveCountryTargeting.countryScope === "include" && targetCountries.length === 0) {
    const error = new Error("failed-precondition: live-send campaigns require a non-empty explicit country include scope after exclusions");
    Object.assign(error, { code: "failed-precondition", errorCode: "campaign_live_country_include_scope_empty" });
    throw error;
  }
  if (
    liveQueueRequested
    && effectiveCountryTargeting.countryScope !== "all"
    && effectiveCountryTargeting.countryScope !== "include"
  ) {
    const error = new Error("failed-precondition: live-send campaigns require an explicit all or include country scope");
    Object.assign(error, { code: "failed-precondition", errorCode: "campaign_live_country_scope_not_explicit" });
    throw error;
  }
  const targetCountryMix = countryMixField(data.targetCountryMix, targetCountries);
  const includeKeywords = stringArrayField(programDiscoveryPolicy.criteria.keywords, 40);
  const excludeKeywords = stringArrayField(programDiscoveryPolicy.criteria.excludeKeywords, 40);
  const categories = stringArrayField(programDiscoveryPolicy.criteria.categories, 30);
  const keywordFallbackEnabled = programDiscoveryPolicy.criteria.keywordFallbackEnabled;
  // R32-1 [운영 실측 2026-07-31 21:24 · 같은 클래스 3번째 재발]: 라이브 웨이브의 **실제 소비 지점**은
  // 이 함수의 자체 필터 파이프라인이다(persistRefillOutcome 의 emailReady/alreadyTouchedSkipped 출처).
  // R31-2 가 게이트를 prepareProgramCampaignTargetsCore 에만 걸어, 리더가 캠페인에
  // eligibilityKeywordGate="off" 를 적용해도 **효과가 0** 이었다(패치 전후 refill 이 scannedRaw 2426 ·
  // emailReady 77 · selected 1 로 완전 동일 — 조인은 실증됐고 게이트만 도달하지 못했다).
  // R23-0 이 밟았던 함정과 같은 자리다("준비 경로는 고쳤지만 소비 지점은 라이브 웨이브").
  // 검색용 includeKeywords/categories 는 무접촉 — 아래 auto-discovery 트리거는 종전 값을 그대로 쓴다.
  const eligibilityKeywordGate = eligibilityKeywordGateEnabled(
    isRecord(data.targetingCriteria) ? data.targetingCriteria : refillContext?.campaign?.targetingCriteria,
  );
  const eligibilityKeywords = eligibilityKeywordGate ? includeKeywords : [];
  const eligibilityCategories = eligibilityKeywordGate ? categories : [];
  const minFollowers = programDiscoveryPolicy.criteria.minFollowers;
  const maxFollowers = programDiscoveryPolicy.criteria.maxFollowers;
  const recentActivityDays = programDiscoveryPolicy.criteria.recentActivityDays;
  const senderName = typeof data.senderName === "string" && data.senderName.trim().length > 0 ? data.senderName.trim().slice(0, 80) : owner;
  const sendSchedule = typeof data.sendSchedule === "string" && data.sendSchedule.trim().length > 0 ? data.sendSchedule.trim().slice(0, 120) : "human-review";
  // 라이브만 fail-closed 한다. 준비·발굴 전에 원문과 실제 선택 가능한 localized 변형을 모두 검사한다.
  const programColdMail = isRecord(authoritativeProgramPolicy.program.coldMail)
    ? (authoritativeProgramPolicy.program.coldMail as Record<string, unknown>)
    : null;
  const localizedRegions = programColdMail && isRecord(programColdMail.localized)
    ? Object.keys(programColdMail.localized)
    : [];
  const liveColdMailPicks = campaignColdMail
    ? [{ subject: campaignColdMail.subject, body: campaignColdMail.body, bodyFormat: campaignColdMail.bodyFormat }]
    : ["", ...localizedRegions].flatMap((region) => {
        const pick = pickColdMailTemplate(programColdMail, region);
        return pick ? [pick] : [];
      });
  const liveColdMailReady = liveColdMailPicks.length > 0
    && liveColdMailPicks.every((pick) => pick.subject.trim().length > 0 && pick.body.trim().length > 0);
  if (liveQueueRequested && !liveColdMailReady) {
    const error = new Error(
      `failed-precondition: live-send campaign requires a complete cold mail template (subject and body) on program ${canonicalProgramId}`,
    );
    Object.assign(error, {
      code: "failed-precondition",
      errorCode: "campaign_live_coldmail_template_missing",
      details: { programId: canonicalProgramId, requestedProgramId: programId },
    });
    throw error;
  }
  if (liveQueueRequested && liveColdMailPicks.some((pick) => isStaleLiveColdMailBody(pick.body))) {
    const error = new Error(
      `failed-precondition: live-send campaign cold mail template is stale on program ${canonicalProgramId}`,
    );
    Object.assign(error, {
      code: "failed-precondition",
      errorCode: "campaign_live_coldmail_template_stale",
      details: { programId: canonicalProgramId, requestedProgramId: programId },
    });
    throw error;
  }
  // 저장된 categories는 탐색 조건이지 실행 플래그가 아니다. 라이브 위저드는
  // autoDiscoverNow를 명시해 기존 프로그램 풀과 동일 스코프의 신규 결과를 함께 사용한다.
  // W8-11a: 라이브 웨이브의 "KPI 대상 준비"는 더 이상 운영자가 따로 눌러야 하는 단계가 아니다 —
  // 검토 대기열 생성이 서버에서 준비를 수행한다(같은 본체 prepareProgramCampaignTargetsCore).
  // 준비 결과 카운트는 성공 응답과 실패 사유에 그대로 실린다(W8-10 단계별 탈락 사유 노출).
  let livePreparation: ProgramCampaignTargetPreparation | null = null;
  // 준비는 **부족분을 채울 때만** 돈다 — 이미 풀이 요청 수를 채우고 있으면 기존 동작 그대로 그
  // 풀만 소비한다(흡수가 웨이브 구성 의미를 바꾸지 않게 하는 경계).
  //
  // F1: 예전 경계는 ready 행 **개수**만 봤다. 그런데 status 는 큐잉 후 어디서도 전이되지 않으므로
  // 낡은 ready 행이 분모를 채워 2차 웨이브부터 흡수가 영구 미실행 → 전량 alreadyTouched 거부 →
  // "메일 0건"이 재발했다(운영자에게 풀 갱신 경로도 없다). 그래서 개수가 아니라
  // **filterUntouchedCampaignTargets 를 통과한 신선분**으로 판정한다 — 이미 컨택된 낡은 행은
  // 분모에서 빠지고, 같은 프로그램의 2차 웨이브가 정상적으로 준비를 다시 돈다.
  const requestedLiveScanLimit = numberField(data, "targetScanLimit", 0);
  // Only the trusted automatic refill actor may make a configured scan width smaller.  A manual
  // request keeps campaignTargetScanWidth's floor behavior, including targetScanLimit=0.
  const automaticRefillScanLimit = isAutomaticCampaignLane(uid) && requestedLiveScanLimit > 0
    ? Math.min(CAMPAIGN_TARGET_SCAN_LIMIT, Math.max(1, Math.round(requestedLiveScanLimit)))
    : undefined;
  const liveScanFloor = liveQueueRequested
    ? await runRefillPhase("create_wave_config_read", readCampaignTargetScanFloor)
    : 0;
  const liveCollectionScanFloor = automaticRefillScanLimit ?? liveScanFloor;
  const initialLiveProgramCollection = liveQueueRequested
    // R23-0: refill 은 **같은 캠페인 id**로 다시 들어온다(`refillContext.id`). 그래서 이 캠페인 스코프로
    // 쌓인 발굴 후보가 여기서 풀에 합류한다 — 신규 생성(랜덤 id)에서는 해당 문서가 없어 종전과 같다.
    ? await runRefillPhase(
        "create_wave_pool_read",
        () => collectProgramCampaignTargets(
          dedupProgramId,
          total,
          requestedLiveScanLimit,
          liveCollectionScanFloor,
          id,
        ),
      )
    : emptyProgramCampaignTargetCollection();
  const liveProgramPool = initialLiveProgramCollection.targets;
  const initialLiveSafetyQuarantineTelemetry: ProgramTargetSafetyQuarantineTelemetry = {
    skipped: initialLiveProgramCollection.skipped,
    readBatches: initialLiveProgramCollection.readBatches,
    fallbackFailed: initialLiveProgramCollection.fallbackFailed,
    fallbackErrorCode: initialLiveProgramCollection.fallbackErrorCode,
  };
  let liveSafetyQuarantineTelemetry: ProgramTargetSafetyQuarantineTelemetry = initialLiveSafetyQuarantineTelemetry;
  // Refill sufficiency must use the same static criteria, recipient uniqueness, suppression, and
  // touch evidence as final selection.  The operation-local Promise memo makes this earlier read
  // reusable by preparation and final selection without persisting a stale suppression decision.
  const liveStaticCriteria: LiveCampaignStaticCriteria = {
    countryTargeting: effectiveCountryTargeting,
    excludeKeywords,
    minFollowers,
    maxFollowers,
    eligibilityCategories,
    eligibilityKeywords,
    keywordFallbackEnabled,
  };
  const liveSuppressionReads = new Map<string, Promise<MailSuppressionHit>>();
  const readLiveTargetSuppression = (target: CampaignTarget): Promise<MailSuppressionHit> => {
    const key = liveTargetSuppressionLookupKey(target);
    const existing = liveSuppressionReads.get(key);
    if (existing) return existing;
    const read = findMailSuppression(liveTargetSuppressionLookup(target));
    liveSuppressionReads.set(key, read);
    return read;
  };
  const evaluateLiveFreshPool = async (pool: CampaignTarget[]) => {
    const staticPartition = partitionLiveCampaignTargetsByStaticCriteria(pool, liveStaticCriteria);
    const recipientUnique = dedupeCampaignTargetsByRecipient(staticPartition.filtered);
    const emailReady = recipientUnique.targets.filter(hasValidTargetEmail);
    // A deterministic shortfall needs no external reads; keep the automatic refill budget for prep.
    if (emailReady.length < total) return { staticPartition, recipientUnique, emailReady, sendable: [] as CampaignTarget[], untouched: { targets: [] as CampaignTarget[], skipped: 0 } };
    const suppressionChecks = await runRefillPhase("create_wave_live_suppression", () => mapWithConcurrency(
      emailReady,
      CAMPAIGN_CANDIDATE_IO_CONCURRENCY,
      "live_suppression",
      async (target) => ({ target, suppression: await readLiveTargetSuppression(target) }),
    ));
    const sendable = suppressionChecks
      .filter((item) => !mailSuppressionBlocksSend(item.suppression, { allowInflyOverlap }))
      .map((item) => item.target);
    if (sendable.length < total) return { staticPartition, recipientUnique, emailReady, suppressionChecks, sendable, untouched: { targets: [] as CampaignTarget[], skipped: 0 } };
    const untouched = await runRefillPhase("create_wave_prior_contact_read", () => filterUntouchedCampaignTargets(
      sendable,
      { programId: dedupProgramId, allowResendInProgram: touchEvidenceAllowResendInProgram },
    ));
    return { staticPartition, recipientUnique, emailReady, suppressionChecks, sendable, untouched };
  };
  const initialLiveEvaluation = liveQueueRequested ? await evaluateLiveFreshPool(liveProgramPool) : null;
  const liveFreshPool = initialLiveEvaluation?.untouched.targets ?? [];
  const preparedConsumptionTargets: CampaignTarget[] = [];
  if (liveQueueRequested && liveFreshPool.length < total) {
    const liveProgram = authoritativeProgramPolicy.program;
    if (stringField(liveProgram, "status", "open") !== "open") {
      throw Object.assign(new Error("failed-precondition: program is not open"), {
        code: "failed-precondition",
        errorCode: "campaign_targets_program_not_open",
      });
    }
    const liveKpiTarget = numberField(liveProgram, "kpiTarget", 0);
    const liveApprovedCount = numberField(liveProgram, "approvedCount", 0);
    // 발송 수 목표는 이 캠페인의 발송량 계약이다. 프로그램의 파트너/승인 KPI와 독립이므로
    // 그 잔여치(운영값 5)로 150건 웨이브를 잘라서는 안 된다.
    const liveRemainingKpi = targetMetric === "sent"
      ? total
      : liveKpiTarget > 0
        ? Math.max(0, liveKpiTarget - liveApprovedCount)
        : CAMPAIGN_OUTREACH_QUEUE_LIMIT;
    if (liveRemainingKpi <= 0) {
      throw Object.assign(new Error("failed-precondition: program KPI is already filled"), {
        code: "failed-precondition",
        errorCode: "campaign_targets_kpi_filled",
      });
    }
    // 준비 콜러블이 갖고 있던 소유권 가드를 그대로 유지한다(흡수로 가드가 사라지지 않게).
    assertMutationOwner(
      { uid, role },
      mutationOwnerUids(liveProgram, { includeCreatedBy: true }),
      "program campaign target preparation",
    );
    livePreparation = await runRefillPhase("create_wave_prepare", () => prepareProgramCampaignTargetsCore({
      programId: canonicalProgramId,
      program: liveProgram,
      programRefPath: authoritativeProgramPolicy.programPolicyRef || `programs/${canonicalProgramId}`,
      // F4a: 준비 본체는 `dryRun || auditOnly` 를 dry-run 으로 본다. auditOnly 만 덮지 않으면
      // 클라가 auditOnly:true 를 보낼 때 준비가 조용히 dry-run 되어 웨이브가 no_targets 로 죽는다.
      data: { ...data, total, dryRun: false, auditOnly: false },
      uid,
      role: role as Role,
      remainingKpi: liveRemainingKpi,
      allowShortfallDiscovery: false,
      // 쿼터 기반 자동 보충(campaignQuota>0)만 KPI 상한에서 제외한다. 수동/일반 생성 경로는
      // refillContext 가 없으므로 기존대로 KPI 가 준비량을 조인다.
      // R19-1: 준비도 승인과 **같은 축**(호출 레인)으로 판정한다. 수동 생성 경로는 KPI 가 준비량을
      // 조이는 종전 동작을 그대로 유지한다.
      kpiClampsTotal: !isAutomaticCampaignLane(uid),
      scanLimitOverride: automaticRefillScanLimit,
      // R31-1: refill 은 **같은 캠페인 id** 로 다시 들어온다(`refillContext.id`) — 그 스코프의
      // campaign_candidates(발굴 산출물)를 준비 경로가 함께 읽는다. 신규 생성(랜덤 id)에서는 해당
      // 문서가 없어 종전과 완전히 같다(라이브 소비 경로의 R23-0 조인과 같은 스코프 규칙).
      campaignScopeId: id,
      readSuppression: readLiveTargetSuppression,
      consumptionTargetSink: preparedConsumptionTargets,
    }));
    // F2: 커밋된 신규 행을 래퍼에 알려 실패 시 보상 삭제가 가능하게 한다.
    preparedRefPaths.push(...livePreparation.createdTargetRefPaths);
  }
  const isAutoDiscoveryTrigger = data.autoDiscoverNow === true
    || (!liveQueueRequested && categories.length > 0);
  const autoDiscoveryResultCap = isAutoDiscoveryTrigger
    ? await runRefillPhase("create_wave_config_read", readCampaignAutoDiscoveryResultCap)
    : 0;
  const requestedTargetScanLimit = requestedLiveScanLimit;
  const effectiveTargetScanLimit = isAutoDiscoveryTrigger
    ? 0
    : Math.min(CAMPAIGN_TARGET_SCAN_LIMIT, Math.max(total || 10, (total || 10) * 2, Math.max(0, Math.round(requestedTargetScanLimit || 0))));
  let collectedTargets: CampaignTarget[];
  if (isAutoDiscoveryTrigger && !liveQueueRequested) {
    collectedTargets = [];
  } else if (liveQueueRequested && !livePreparation) {
    // F5①: 라이브 경로에서 준비가 돌지 않았다면 위 경계 측정에서 이미 같은 풀을 읽었다 —
    // program_campaign_targets 를 두 번 훑지 않는다(스캔 폭 하한이 커진 뒤 중복 읽기 비용이 크다).
    collectedTargets = liveProgramPool;
  } else if (liveQueueRequested) {
    const refreshed = await runRefillPhase(
      "create_wave_pool_read",
      () => collectProgramCampaignTargets(
        dedupProgramId,
        total,
        requestedTargetScanLimit,
        liveCollectionScanFloor,
        id,
      ),
    );
    liveSafetyQuarantineTelemetry = mergeProgramTargetSafetyQuarantineTelemetry(
      {
        skipped: refreshed.skipped,
        readBatches: refreshed.readBatches,
        fallbackFailed: refreshed.fallbackFailed,
        fallbackErrorCode: refreshed.fallbackErrorCode,
      },
      initialLiveSafetyQuarantineTelemetry,
    );
    // The refreshed cursor may have advanced past a just-persisted target. Consume only this
    // invocation's successful prepared rows first; never reset or widen the cursor window.
    const seenPreparedKeys = new Set<string>();
    const effectiveLiveCollectionCap = Math.max(
      preparedConsumptionTargets.length,
      campaignTargetScanWidth(requestedLiveScanLimit, liveCollectionScanFloor),
    );
    collectedTargets = [...preparedConsumptionTargets, ...refreshed.targets].filter((target) => {
      const keys = targetDedupKeys(target);
      if (keys.some((key) => seenPreparedKeys.has(key))) return false;
      for (const key of keys) seenPreparedKeys.add(key);
      return true;
    }).slice(0, effectiveLiveCollectionCap);
  } else {
    collectedTargets = await runRefillPhase(
      "create_wave_pool_read",
      () => collectCampaignTargets(
        owner,
        total,
        requestedTargetScanLimit,
        {
          liveSend: false,
          programId: dedupProgramId,
          scanFloor: liveScanFloor,
          campaignId: id,
        },
      ),
    );
  }
  // 비라이브 레거시는 categories 신호를 유지한다. 라이브는 autoDiscoverNow가 있어야만
  // 저장된 조건으로 scoped discovery를 실행하고, 기존 program target과 결과를 합친다.
  let autoDiscoveryMeta: { runId: string; runRef: string; source: string; candidatesFound: number; resultCap?: number } | null = null;
  let discoveredAutoTargets: CampaignTarget[] = [];
  if (isAutoDiscoveryTrigger) {
    try {
      const autoDiscoveryRequest = {
        campaignId: id,
        programId: dedupProgramId,
        programPolicyRef: authoritativeProgramPolicy.programPolicyRef || undefined,
        candidateCriteriaSnapshot: programDiscoveryPolicy.candidateCriteria,
        eligibilityCriteriaSnapshot: programDiscoveryPolicy.eligibilityCriteria,
        gameId,
        keywords: includeKeywords,
        categories,
        excludeKeywords,
        countryTargeting: effectiveCountryTargeting,
        regions: targetCountries,
        minFollowers,
        maxFollowers,
        recentActivityDays,
        actorUserId: uid,
        actorRole: role,
        backfillExistingPool: liveQueueRequested,
        resultCap: autoDiscoveryResultCap,
      };
      const autoDiscovery = await runRefillPhase(
        "create_wave_discovery",
        () => triggerScopedCampaignDiscovery(autoDiscoveryRequest),
      );
      autoDiscoveryMeta = {
        runId: autoDiscovery.runId,
        runRef: autoDiscovery.runRef,
        source: autoDiscovery.source,
        candidatesFound: autoDiscovery.candidates.length,
        resultCap: autoDiscoveryResultCap,
      };
      const candidateRefs = autoDiscovery.candidates.map((candidate) => adminDb.doc(campaignCandidateRefFor(
        autoDiscovery.canonicalProgramId,
        id,
        candidateIdFromCandidate(candidate),
      )));
      const existingCandidates = candidateRefs.length > 0 ? await adminDb.getAll(...candidateRefs) : [];
      discoveredAutoTargets = autoDiscovery.candidates.map((candidate, index): CampaignTarget => {
        const candidateId = candidateIdFromCandidate(candidate);
        const persistOutcome = existingCandidates[index]?.exists ? "merged" : "created";
        const discoverySource = candidate.discoverySource
          || (autoDiscovery.source.includes("cache") ? "cache_hit" : "keyword");
        const discoveryArm = candidate.discoveryArm
          ?? (["keyword", "broad", "topic"].includes(discoverySource) ? discoverySource as DiscoverySliceType : undefined);
        const sourceFetchedAt = candidate.sourceFetchedAt || new Date().toISOString();
        const priorProvenance = existingCandidates[index]?.data()?.discoveryProvenance;
        const discoveryProvenance = {
          ...(isRecord(priorProvenance) ? priorProvenance : {}),
          [`${discoverySource}:${persistOutcome}`]: {
            discoverySource, discoveryArm: discoveryArm ?? "", persistOutcome, sourceFetchedAt,
          },
        };
        return {
          id: candidateId,
          candidateId,
          candidateRef: candidate.candidateRef,
          campaignCandidateRef: campaignCandidateRefFor(autoDiscovery.canonicalProgramId, id, candidateId),
          canonicalProgramId: autoDiscovery.canonicalProgramId,
          campaignId: id,
          sourceCampaignId: candidate.campaignId && candidate.campaignId !== id ? candidate.campaignId : undefined,
          sourceRunId: candidate.sourceRunId || autoDiscovery.runId,
          sourceRunRef: candidate.sourceRunRef || autoDiscovery.runRef,
          discoverySource,
          discoveryArm,
          persistOutcome,
          sourceFetchedAt,
          discoveryProvenance,
          name: candidate.name,
          email: validEmailField(candidate.email) || undefined,
          handle: candidate.handle || undefined,
          avatar: candidate.avatar || undefined,
          platform: candidate.platform || "YouTube",
          followers: candidate.followers || undefined,
          region: candidate.region || undefined,
          category: candidate.category || undefined,
          publicDescription: candidate.publicDescription || undefined,
          matchedSearchTerms: candidate.matchedSearchTerms,
          source: "discovered",
        };
      });
    } catch (error) {
      const failure = safeOutboundFailureEvidence(error, "campaign_auto_discovery");
      console.error("[campaign-auto-discovery] trigger failed", {
        failureKind: failure.failureKind,
        failureRuleId: failure.failureRuleId,
        errorCode: failure.errorCode,
        correlationIdHash: failure.correlationIdHash,
      });
    }
  }
  const liveStaticPartition = partitionLiveCampaignTargetsByStaticCriteria(
    [...collectedTargets, ...discoveredAutoTargets],
    liveStaticCriteria,
  );
  const countryDecisionCounts = liveStaticPartition.countryDecisionCounts;
  const filteredTargets = liveStaticPartition.filtered;
  const keywordMatchedTargets = liveStaticPartition.keywordMatched;
  const recipientUniqueResult = dedupeCampaignTargetsByRecipient(filteredTargets);
  const emailReadyTargets = recipientUniqueResult.targets.filter(hasValidTargetEmail);
  const emailRequiredSkipped = recipientUniqueResult.targets.length - emailReadyTargets.length;
  const suppressionChecks = await mapWithConcurrency(emailReadyTargets, CAMPAIGN_CANDIDATE_IO_CONCURRENCY, "live_suppression", async (target) => ({
    target,
    suppression: await readLiveTargetSuppression(target),
  }));
  const suppressedTargets = suppressionChecks.filter((item) => mailSuppressionBlocksSend(item.suppression, { allowInflyOverlap }));
  const sendableTargets = suppressionChecks
    .filter((item) => !mailSuppressionBlocksSend(item.suppression, { allowInflyOverlap }))
    .map((item) => item.target);
  const untouchedResult = await runRefillPhase(
    "create_wave_prior_contact_read",
    () => filterUntouchedCampaignTargets(
      sendableTargets,
      { programId: dedupProgramId, allowResendInProgram: touchEvidenceAllowResendInProgram },
    ),
  );
  if (filteredTargets.length > 0 && emailReadyTargets.length === 0) {
    const error = new Error(`no email-ready targets: ${filteredTargets.length} matched candidate(s) do not have valid recipient emails`);
    Object.assign(error, {
      code: "failed-precondition",
      errorCode: "campaign_targets_no_email_ready",
      counts: { filtered: filteredTargets.length, emailReady: 0, emailIncapableDeprioritized: livePreparation?.emailIncapableDeprioritized ?? 0 },
      details: { counts: { filtered: filteredTargets.length, emailReady: 0, emailIncapableDeprioritized: livePreparation?.emailIncapableDeprioritized ?? 0 } },
      // R33-1 [적대적 리뷰 LOW-1]: 실패 경로에도 **준비 경로 단계별 수치·자격 거부 사유 분포**를
      // 동봉한다 — 이 값이 없어서 "상류가 왜 대상을 더 만들지 않는가"를 운영에서 짚을 수 없었다.
      ...(livePreparation ? {
        preparationCounts: campaignPreparationCounts(livePreparation),
        eligibilityRejections: livePreparation.programScopeRejectedReasons,
      } : {}),
    });
    throw error;
  }
  if (emailReadyTargets.length > 0 && sendableTargets.length === 0) {
    const error = new Error(`no sendable targets: ${suppressedTargets.length} email-ready candidate(s) are suppressed or already known`);
    Object.assign(error, {
      code: "failed-precondition",
      errorCode: "campaign_targets_all_suppressed",
      counts: { emailReady: emailReadyTargets.length, suppressedSkipped: suppressedTargets.length, emailIncapableDeprioritized: livePreparation?.emailIncapableDeprioritized ?? 0 },
      details: { counts: { emailReady: emailReadyTargets.length, suppressedSkipped: suppressedTargets.length, emailIncapableDeprioritized: livePreparation?.emailIncapableDeprioritized ?? 0 } },
      ...(livePreparation ? {
        preparationCounts: campaignPreparationCounts(livePreparation),
        eligibilityRejections: livePreparation.programScopeRejectedReasons,
      } : {}),
    });
    throw error;
  }
  if (sendableTargets.length > 0 && untouchedResult.targets.length === 0) {
    const error = new Error(`no new sendable targets: ${untouchedResult.skipped} candidate(s) were already queued, sent, or blocked`);
    Object.assign(error, {
      code: "failed-precondition",
      errorCode: "campaign_targets_all_already_touched",
      counts: { sendable: sendableTargets.length, alreadyTouchedSkipped: untouchedResult.skipped, emailIncapableDeprioritized: livePreparation?.emailIncapableDeprioritized ?? 0 },
      details: { counts: { sendable: sendableTargets.length, alreadyTouchedSkipped: untouchedResult.skipped, emailIncapableDeprioritized: livePreparation?.emailIncapableDeprioritized ?? 0 } },
      ...(livePreparation ? {
        preparationCounts: campaignPreparationCounts(livePreparation),
        eligibilityRejections: livePreparation.programScopeRejectedReasons,
      } : {}),
    });
    throw error;
  }
  // R5-A(HIGH-1) 자동 discovery 경로는 settings-driven cap으로 닫는다.
  // Live wave는 별도 settings-driven total cap으로 닫아 다음 날 daily counter reset으로
  // 초과 발송되는 경로를 원천 차단한다.
  const outreachQueueCap = liveQueueRequested
    ? liveWaveCap
    : isAutoDiscoveryTrigger
      ? autoDiscoveryResultCap
      : CAMPAIGN_OUTREACH_QUEUE_LIMIT;
  const targets = selectBalancedCampaignTargets(
    untouchedResult.targets,
    Math.max(1, Math.min(total || targetValue || 10, outreachQueueCap)),
    targetCountries,
    targetCountryMix,
  );
  // W8-11c: 예전 게이트는 `targets.length === total`(정확히 일치)을 요구했다. 스캔 폭이 KPI 에
  // 묶여 있던 것과 맞물려 어떤 KPI 조합으로도 통과가 불가능했다. 이제 **1건 이상 상한 이하**면
  // 확보된 만큼만 큐잉한다. 상한(liveWaveCap·배치 승인 상한·킬스위치·mail_safety)은 그대로다 —
  // 완화 대상은 "정확히 일치" 요구뿐이고 발송량 상한은 아래에서 계속 집행된다.
  // F4b: 상한 초과 분기는 도달 불가였다 — selectBalancedCampaignTargets 가 이미
  // min(total, outreachQueueCap=liveWaveCap) 로 자르므로 targets.length 가 상한을 넘을 수 없다.
  // 죽은 분기를 남겨 "상한을 여기서도 본다"고 읽히게 하지 않고, 실제 조건(확보 0)만 남긴다.
  // 상한 집행은 위 `total > liveWaveCap` 사전 거부 + select cap + 배치 승인 상한이 담당한다.
  if (liveQueueRequested && targets.length < 1) {
    const counts = {
      requested: total,
      liveWaveCap,
      available: targets.length,
      ...(livePreparation ? {
        scannedRaw: livePreparation.scannedRaw,
        programScopeRejected: livePreparation.programScopeRejected,
        filtered: livePreparation.filtered,
        emailReady: livePreparation.emailReady,
        sendable: livePreparation.sendable,
        safetyBlockedSkipped: livePreparation.safetyBlockedSkipped,
        safetyQuarantinedSkipped: livePreparation.safetyQuarantinedSkipped,
        safetyQuarantineReadBatches: livePreparation.safetyQuarantineReadBatches,
        alreadyTouchedSkipped: livePreparation.alreadyTouchedSkipped,
        // R20: 화이트리스트 열거 방식이라 새 카운터가 빠지면 조용히 사라진다.
        emailIncapableDeprioritized: livePreparation.emailIncapableDeprioritized,
        duplicateRecipientSkipped: livePreparation.duplicateRecipientSkipped,
        prepared: livePreparation.prepared,
        existing: livePreparation.existing,
        shortfall: livePreparation.shortfall,
      } : {}),
    };
    const discoveryBlockedByLiveWave = livePreparation?.shortfallDiscovery?.blockedReason === "scoped_discovery_not_allowed_in_live_wave"
      && categories.length > 0
      && includeKeywords.length === 0;
    const error = new Error(discoveryBlockedByLiveWave
      ? "failed-precondition: live-send campaigns cannot trigger scoped discovery"
      : "failed-precondition: live-send campaign has no program-linked fresh target after preparation");
    Object.assign(error, {
      code: "failed-precondition",
      errorCode: discoveryBlockedByLiveWave
        ? "campaign_live_scoped_discovery_not_allowed"
        : "campaign_live_wave_no_targets",
      counts,
      details: { counts },
      // R33-1: 이 사유(준비가 아무것도 못 만들었다)야말로 상류 진단이 필요한 지점이다.
      ...(livePreparation ? {
        preparationCounts: campaignPreparationCounts(livePreparation),
        eligibilityRejections: livePreparation.programScopeRejectedReasons,
      } : {}),
    });
    throw error;
  }
  const targeting = {
    targetMetric,
    targetValue,
    requested: total,
    queued: targets.length,
    emailReady: emailReadyTargets.length,
    emailRequiredSkipped,
    suppressedSkipped: suppressedTargets.length,
    alreadyTouchedSkipped: untouchedResult.skipped,
    duplicateRecipientSkipped: recipientUniqueResult.skipped,
    limit: outreachQueueCap,
    truncated: total > targets.length,
    countryTargeting: requestedCountryTargeting,
    effectiveCountryTargeting,
    excludedCountries: requestedCountryTargeting.excludedCountries,
    targetCountries,
    targetCountryMix,
    excludedByIncludedCountries: countryDecisionCounts.excludedByIncludedCountries,
    excludedByExplicitCountry: countryDecisionCounts.excludedByExplicitCountry,
    unknownCountryHeld: countryDecisionCounts.unknownCountryHeld,
    includeKeywords,
    excludeKeywords,
    keywordFallbackEnabled,
    keywordMatched: keywordMatchedTargets.length,
    allowInflyOverlap,
    allowResendInProgram,
    autoDiscoveredCount: discoveredAutoTargets.length,
    targetScanLimit: effectiveTargetScanLimit,
    ...(liveQueueRequested ? {
      ...(() => {
        const mergedQuarantineTelemetry = mergeProgramTargetSafetyQuarantineTelemetry(
          liveSafetyQuarantineTelemetry,
          livePreparation
            ? {
                skipped: livePreparation.safetyQuarantinedSkipped,
                readBatches: livePreparation.safetyQuarantineReadBatches,
                fallbackFailed: livePreparation.safetyQuarantineFallbackFailed,
                fallbackErrorCode: livePreparation.safetyQuarantineFallbackErrorCode,
              }
            : null,
        );
        return {
          safetyQuarantinedSkipped: mergedQuarantineTelemetry.skipped,
          safetyQuarantineReadBatches: mergedQuarantineTelemetry.readBatches,
          safetyQuarantineFallbackFailed: mergedQuarantineTelemetry.fallbackFailed,
          ...(mergedQuarantineTelemetry.fallbackErrorCode
            ? { safetyQuarantineFallbackErrorCode: mergedQuarantineTelemetry.fallbackErrorCode }
            : {}),
        };
      })(),
    } : {}),
    // W8-11a/W8-10: 서버가 수행한 준비 단계별 카운트(라이브 경로에서만 존재).
    // F4e: 캠페인 문서에 영속되는 값이므로 **카운트만** 남긴다 — 마스킹 수신자·핸들·지역이 든
    // targets 배열과 discovery 메타는 클라가 쓰지 않고 보관 이유도 없다.
    ...(livePreparation ? { preparation: campaignPreparationCounts(livePreparation) } : {}),
    // R33-1: 준비 경로의 자격 거부 **사유별 분포**도 같은 응답에 싣는다(운영 진단의 정본).
    ...(livePreparation ? { preparationEligibilityRejections: livePreparation.programScopeRejectedReasons } : {}),
  };
  const targetingCriteria = {
    countryTargeting: requestedCountryTargeting,
    effectiveCountryTargeting,
    excludedCountries: requestedCountryTargeting.excludedCountries,
    ...(legacyTargetCountries === undefined ? {} : { targetCountries: legacyTargetCountries }),
    targetCountryMix,
    includeKeywords,
    excludeKeywords,
    categories,
    regions: targetCountries,
    minFollowers,
    maxFollowers,
    recentActivityDays,
    allowInflyOverlap,
    allowResendInProgram,
  };
  const campaign = {
    id, name, owner, source, status: "대기", operationalState: "active", priority,
    programId: canonicalProgramId,
    canonicalProgramId,
    aliasRegistryRevision: authoritativeProgramPolicy.aliasRegistryRevision,
    programRef: authoritativeProgramPolicy.programRef,
    ...(authoritativeProgramPolicy.programPolicyRef ? { programPolicyRef: authoritativeProgramPolicy.programPolicyRef } : {}),
    candidateCriteriaSnapshot: programDiscoveryPolicy.candidateCriteria,
    eligibilityCriteriaSnapshot: programDiscoveryPolicy.eligibilityCriteria,
    // R5-B(RA-1) dedup 폴백용 — 발송 게이트(resolveOutreachDedupContext)가 레거시
    // campaign_outreach doc(programId 미기록)을 만나면 campaignId→이 필드로 폴백 해소한다.
    allowResendInProgram,
    ...(autoDiscoveryMeta ? { autoDiscovery: autoDiscoveryMeta } : {}),
    gameId,
    targetMetric, targetValue,
    // Queue availability can be partial while discovery continues; the campaign
    // quota remains the operator's requested ceiling rather than collapsing to the
    // first batch that happened to be email-ready.
    campaignQuota: total,
    controlVersion: 0,
    total: targets.length, queued: targets.length, sent: 0, replied: 0, negotiating: 0, contracted: 0, live: 0, bounced: 0,
    ...(liveQueueRequested ? { liveSendCap: liveWaveCap, liveSendCapSource: "settings/default.automation.maxLiveCampaignWaveSends" } : {}),
    ...(liveSendBatchConfig ? { liveSendBatchId: liveSendBatchConfig.id, liveSendBatchCap: liveSendBatchConfig.cap, liveSendBatchCapSource: liveSendBatchConfig.source } : {}),
    // TASK 3 automatic mode: unconditional approval — the auto-approval sweep approves the whole
    // wave, so the batch cap is the wave size (overrides the manual-review 1..5 cap). Hard mail
    // safety, daily send caps, suppression, and dedup still run at approval + send time; the
    // global mail safety switch is untouched. Human review remains the default elsewhere.
    ...(liveQueueRequested && data.autoApproveLiveSend === true ? {
      autoApproveLiveSend: true,
      autoRefillEnabled: data.autoDiscoverNow === true,
      liveSendBatchId: liveSendBatchConfig?.id ?? `auto-${id}`,
      liveSendBatchCap: liveSendBatchConfig?.cap ?? total,
      liveSendBatchCapSource: liveSendBatchConfig?.source ?? "campaign.autoApproveLiveSend",
    } : {}),
    counterSource: "syncCampaignFunnel", creatorStageSource: "creators.stage", counterRevision: 0, funnelSyncedAtIso: createdAtIso,
    targeting,
    targetingCriteria,
    coldMail: campaignColdMail ?? undefined,
    countryTargeting: requestedCountryTargeting,
    effectiveCountryTargeting,
    excludedCountries: requestedCountryTargeting.excludedCountries,
    ...(legacyTargetCountries === undefined ? {} : { targetCountries: legacyTargetCountries }),
    targetCountryMix,
    includeKeywords,
    excludeKeywords,
    allowInflyOverlap,
    senderName,
    sendSchedule,
    ...campaignProfilePatch,
    ...ownerScopeFields,
    createdAtIso, updatedAtIso: createdAtIso,
  };
  const draftCtx: CampaignOutreachDraftContext = {
    campaignId: id,
    campaignName: name,
    owner,
    gameId,
    senderName,
    campaignColdMail,
    programColdMail,
    profileResolution,
    allowInflyOverlap,
  };
  const draftPlans = await mapWithConcurrency(targets, CAMPAIGN_CANDIDATE_IO_CONCURRENCY, "live_draft_safety", (target) => prepareCampaignOutreachDraft(draftCtx, target));
  const nonQueueableLivePlans = liveQueueRequested
    ? draftPlans.filter((plan) => !plan.safety.allowed && plan.safety.ruleId !== "mail-safety.human-approval-required")
    : [];
  const safetyPrecheckExcludedTargetIds = new Set(nonQueueableLivePlans.map((plan) => plan.targetId));
  const queueableDraftPlans = draftPlans.filter((plan) => !safetyPrecheckExcludedTargetIds.has(plan.targetId));
  if (nonQueueableLivePlans.length > 0) {
    await runRefillPhase("create_wave_safety_write", () => markProgramTargetsSafetyBlocked(
      dedupProgramId,
      nonQueueableLivePlans.map((plan) => ({ target: plan.target, safety: plan.safety })),
      createdAtIso,
      "createCampaign.liveSafetyPrecheck",
    ));
    await recordCampaignSafetyQuarantineAttempts(
      refillContext?.id ?? "",
      nonQueueableLivePlans.map((plan) => plan.target),
      createdAtIso,
    );
    Object.assign(targeting, {
      queued: queueableDraftPlans.length,
      truncated: total > queueableDraftPlans.length,
      safetyPrecheckExcluded: nonQueueableLivePlans.length,
    });
    Object.assign(campaign, { total: queueableDraftPlans.length, queued: queueableDraftPlans.length });
    if (queueableDraftPlans.length === 0) {
      const error = new Error(`failed-precondition: live-send campaign target safety precheck blocked ${nonQueueableLivePlans.length} program-linked target(s); rerun preparation before creating an exact wave`);
      Object.assign(error, {
        code: "failed-precondition", errorCode: "campaign_live_wave_safety_precheck_blocked",
        details: {
          safetyBlockedSkipped: nonQueueableLivePlans.length,
          rules: nonQueueableLivePlans.map((plan) => plan.safety.ruleId).filter(Boolean).slice(0, 20),
        },
      });
      throw error;
    }
  }
  const writeOps: Array<(batch: ReturnType<typeof adminDb.batch>) => void> = refillContext
    ? [
        (batch) => batch.set(adminDb.collection("campaigns").doc(id), {
          autoRefillEnabled: true,
          campaignQuota: Math.max(
            numberField(refillContext.campaign, "campaignQuota", 0),
            targetValue,
          ),
          liveSendBatchId: `auto-${id}`,
          liveSendBatchCap: Math.max(
            numberField(refillContext.campaign, "liveSendBatchCap", 0),
            targetValue,
          ),
          liveSendBatchCapSource: "campaign.autoRefill",
          targeting,
          targetingCriteria,
          ...(autoDiscoveryMeta ? { autoDiscovery: autoDiscoveryMeta } : {}),
          lastRefill: {
            requested: total,
            queued: queueableDraftPlans.length,
            runId: autoDiscoveryMeta?.runId ?? "",
            atIso: createdAtIso,
          },
          updatedAtIso: createdAtIso,
        }, { merge: true }),
      ]
    : [
        (batch) => batch.set(adminDb.collection("campaigns").doc(id), campaign),
      ];
  if (autoDiscoveryMeta) {
    const created = discoveredAutoTargets.filter((target) => target.persistOutcome === "created").length;
    const merged = discoveredAutoTargets.filter((target) => target.persistOutcome === "merged").length;
    writeOps.push((batch) => batch.update(adminDb.doc(autoDiscoveryMeta.runRef), {
      "materialization.newUnique": created,
      "materialization.merged": merged,
    }));
  }
  // Auto-discovery returns an immutable run snapshot. Materialize participation-only
  // campaign scope plus a program target carrying the complete lineage before any
  // outreach artifact is added to the write queue.
  for (const target of discoveredAutoTargets) {
    if (!target.candidateId || !target.candidateRef || !target.sourceRunId || !target.sourceRunRef) continue;
    if (safetyPrecheckExcludedTargetIds.has(safeDocId(target.id))) continue;
    const sourceCampaignId = validatedSourceCampaignId(target, canonicalProgramId, id);
    const plan = buildProgramScopedCandidateParticipationWrites({
      candidate: {
        ...target,
        id: target.candidateId,
        candidateId: target.candidateId,
        candidateRef: target.candidateRef,
      },
      canonicalProgramId,
      campaignId: id,
      sourceRunId: target.sourceRunId,
      sourceRunRef: target.sourceRunRef,
    });
    const targetRef = programTargetRef(canonicalProgramId, target);
    writeOps.push((batch) => batch.set(adminDb.doc(plan.participationRef), {
      ...plan.participationData,
      updatedAtIso: createdAtIso,
    }, { merge: true }));
    writeOps.push((batch) => batch.set(targetRef, stripUndefinedFields({
      id: targetRef.id,
      programId: canonicalProgramId,
      status: "ready",
      candidateId: target.candidateId,
      candidateRef: target.candidateRef,
      campaignCandidateRef: target.campaignCandidateRef,
      canonicalProgramId,
      ...(sourceCampaignId ? { sourceCampaignId } : {}),
      sourceRunId: target.sourceRunId,
      sourceRunRef: target.sourceRunRef,
      candidateProvenance: {
        candidateRef: target.candidateRef,
        campaignCandidateRef: target.campaignCandidateRef,
        canonicalProgramId,
        campaignId: id,
        ...(sourceCampaignId ? { sourceCampaignId } : {}),
        sourceRunId: target.sourceRunId,
        sourceRunRef: target.sourceRunRef,
      },
      source: "campaign_auto_discovery",
      sourceRef: target.candidateRef,
      name: target.name,
      email: target.email,
      handle: target.handle,
      avatar: target.avatar,
      platform: target.platform,
      followers: target.followers,
      region: target.region,
      country: target.country,
      countryDecision: target.countryDecision,
      category: target.category,
      publicDescription: target.publicDescription,
      matchedSearchTerms: target.matchedSearchTerms,
      selectedForKpi: true,
      selectedBy: uid,
      selectedByRole: role,
      createdAtIso,
      updatedAtIso: createdAtIso,
    }), { merge: true }));
  }
  const outreachWriteGroups: CampaignWaveWriteGroup[] = [];
  const outreachArtifacts = queueableDraftPlans.map((plan) => {
    const { target, targetId, outreachId, trackingId, messageRef, summaryKr, subject, to, body, bodyFormat, safety, artifact, templateValues, compilerInputBody } = plan;
    const compiledArtifactFields = campaignOutreachCompiledArtifactFields({
      artifact,
      subject,
      templateValues,
      compilerInputBody,
    });
    const sourceCampaignId = validatedSourceCampaignId(target, canonicalProgramId, id);
    const conversationId = target.creatorId ? `campaign-${target.creatorId}` : `campaign-${id}-${targetId}`;
    const conversationRef = adminDb.collection("conversations").doc(conversationId);
    // `mail-safety.human-approval-required` is the desired campaign creation state:
    // create the draft row for human review, then approveCampaignOutreach and the
    // sender sweep perform the hard live-send checks again before any SMTP side effect.
    const needsHumanReview = safety.ruleId === "mail-safety.human-approval-required";
    const canQueueForReview = safety.allowed || needsHumanReview;
    const deliveryState = canQueueForReview ? "queued_for_review" : "blocked";
    const humanGate = canQueueForReview ? "needs_review" : "blocked";
    const sourceRefs = [makeSourceRef(messageRef, "message_source", summaryKr), ...profileResolution.sourceRefs];
    const message = {
      id: `msg-${outreachId}`,
      from: "ai",
      author: "Flu AI",
      time: formatChatTime(createdAtIso),
      summaryKr,
      trackingId,
      messageRef,
      humanGate,
      deliveryState,
      campaignId: id,
      createdAtIso,
      sourceRefs,
      resolvedProfileSnapshot: profileResolution.resolvedProfileSnapshot,
      templateSnapshot: profileResolution.templateSnapshot,
      policyVersion: profileResolution.policyVersion,
      sendAfterIso: profileResolution.sendAfterIso,
      dryRun: profileResolution.dryRun,
      liveSend: profileResolution.liveSend,
      ...(liveSendBatchConfig ? { liveSendBatchId: liveSendBatchConfig.id, liveSendBatchCap: liveSendBatchConfig.cap } : {}),
      allowInflyOverlap,
      ...compiledArtifactFields,
      ...ownerScopeFields,
    };
    const outreach = {
      id: outreachId,
      campaignId: id,
      // R5-B(RA-1) 발송 게이트/히스토리가 더 이상 "scp"로 collapse되지 않도록 캠페인 생성 시점에
      // programId를 직접 스탬프한다(레거시 폴백 없이 바로 조회 가능).
      programId: dedupProgramId,
      targetId: target.id,
      creatorId: target.creatorId ?? null,
      candidateId: target.candidateId ?? null,
      candidateRef: target.candidateRef,
      campaignCandidateRef: target.campaignCandidateRef,
      canonicalProgramId,
      ...(sourceCampaignId ? { sourceCampaignId } : {}),
      sourceRunId: target.sourceRunId,
      sourceRunRef: target.sourceRunRef,
      candidateProvenance: {
        candidateRef: target.candidateRef,
        campaignCandidateRef: target.campaignCandidateRef,
        canonicalProgramId,
        campaignId: id,
        ...(sourceCampaignId ? { sourceCampaignId } : {}),
        sourceRunId: target.sourceRunId,
        sourceRunRef: target.sourceRunRef,
      },
      creatorName: target.name,
      creatorEmail: target.email ?? null,
      creatorHandle: target.handle ?? null,
      youtubeUrl: target.youtubeUrl ?? null,
      creatorCategory: target.category ?? null,
      creatorPlatform: target.platform ?? "YouTube",
      creatorRegion: target.region ?? null,
      country: target.country ?? target.region ?? "",
      countryDecision: target.countryDecision?.decision ?? null,
      countryDecisionEvidence: target.countryDecision ?? null,
      countryTargetingSnapshot: effectiveCountryTargeting,
      source: target.source,
      channel: "email",
      status: deliveryState,
      ...(canQueueForReview ? {} : {
        blockedReason: safety.ruleId ?? "mail_safety_blocked",
        blockedDetail: safety.reason ?? "메일 안전 정책으로 차단되었습니다.",
        blockedAtIso: createdAtIso,
      }),
      summaryKr,
      trackingId,
      messageRef,
      conversationId,
      deliveryState,
      humanGate,
      mailSafety: safety,
      resolvedProfileSnapshot: profileResolution.resolvedProfileSnapshot,
      templateSnapshot: profileResolution.templateSnapshot,
      policyVersion: profileResolution.policyVersion,
      sourceRefs,
      sendAfterIso: profileResolution.sendAfterIso,
      dryRun: profileResolution.dryRun,
      liveSend: profileResolution.liveSend,
      ...(liveSendBatchConfig ? { liveSendBatchId: liveSendBatchConfig.id, liveSendBatchCap: liveSendBatchConfig.cap } : {}),
      allowInflyOverlap,
      ...compiledArtifactFields,
      ...ownerScopeFields,
      createdAtIso,
    };
    const messageSourceRef = adminDb.doc(messageRef);
    const outreachRef = adminDb.collection("campaign_outreach").doc(outreachId);
    const conversationMessageRef = conversationRef.collection("messages").doc(message.id);
    const recipientWriteOps: CampaignWaveWriteOp[] = [
      (batch) => batch.set(messageSourceRef, {
        id: outreachId,
        messageRef,
        campaignId: id,
        ...(sourceCampaignId ? { sourceCampaignId } : {}),
        programId: dedupProgramId,
        targetId: target.id,
        candidateRef: target.candidateRef,
        campaignCandidateRef: target.campaignCandidateRef,
        canonicalProgramId,
        sourceRunId: target.sourceRunId,
        sourceRunRef: target.sourceRunRef,
        conversationId,
        direction: "outbound",
        from: validEmailField(data.from) || validEmailField(request.auth?.token?.email) || envEmail("FLU_DEFAULT_OUTBOUND_FROM"),
        to,
        creatorName: target.name,
        creatorEmail: target.email ?? null,
        creatorHandle: target.handle ?? null,
        youtubeUrl: target.youtubeUrl ?? null,
        creatorCategory: target.category ?? null,
        creatorPlatform: target.platform ?? "YouTube",
        creatorRegion: target.region ?? null,
        country: target.country ?? target.region ?? "",
        countryDecision: target.countryDecision?.decision ?? null,
        countryDecisionEvidence: target.countryDecision ?? null,
        countryTargetingSnapshot: effectiveCountryTargeting,
        subject,
        body,
        summaryKr,
        trackingId,
        deliveryState,
        humanGate,
        mailSafety: safety,
        resolvedProfileSnapshot: profileResolution.resolvedProfileSnapshot,
        templateSnapshot: profileResolution.templateSnapshot,
        policyVersion: profileResolution.policyVersion,
        sendAfterIso: profileResolution.sendAfterIso,
        dryRun: profileResolution.dryRun,
        liveSend: profileResolution.liveSend,
        ...(liveSendBatchConfig ? { liveSendBatchId: liveSendBatchConfig.id, liveSendBatchCap: liveSendBatchConfig.cap } : {}),
        allowInflyOverlap,
        ...ownerScopeFields,
        createdAtIso,
        sourceRefs,
        ...compiledArtifactFields,
      }, { merge: true }),
      (batch) => batch.set(outreachRef, outreach),
      (batch) => batch.set(conversationRef, {
        id: conversationId,
        creatorId: target.creatorId ?? `candidate:${target.id}`,
        creatorName: target.name,
        creatorAvatar: target.avatar ?? target.name,
        creatorEmail: target.email ?? null,
        creatorHandle: target.handle ?? null,
        youtubeUrl: target.youtubeUrl ?? null,
        creatorPlatform: target.platform ?? "YouTube",
        creatorFollowers: target.followers ?? null,
        unread: 0,
        // 새 대화의 **대화별** 자동응답 스위치. 전역 게이트를 여기에 굳혀 넣으면 전역 OFF 중에
        // 만들어진 대화가 전역을 다시 켜도 영영 꺼진 채로 남는다 — 발사 시점에 전역과 AND 한다.
        aiActive: true,
        campaignId: id,
        programId: dedupProgramId,
        source: "campaign_outreach",
        lastMessage: summaryKr,
        lastMessageAtIso: createdAtIso,
        lastMessageRef: messageRef,
        lastMessageFrom: "ai",
        lastDeliveryState: deliveryState,
        sourceRefs,
        ...ownerScopeFields,
        updatedAtIso: createdAtIso,
      }, { merge: true }),
      (batch) => batch.set(conversationMessageRef, message, { merge: true }),
      (batch) => writeKnowledgeNode(batch, {
        id: `campaign-outreach-${message.id}`,
        type: "ai_summary",
        title: subject,
        summary: summaryKr,
        sourceRefs,
        entityRefs: [conversationRef.path, `campaigns/${id}`, outreachRef.path],
        createdAtIso,
      }),
    ];
    // message_sources + campaign_outreach is the sender's indivisible queue contract. Keep both
    // in one recipient transaction; deterministic IDs make retry idempotent and compensation safe.
    outreachWriteGroups.push({
      operations: recipientWriteOps,
      rollbackRefPaths: [messageSourceRef.path, outreachRef.path],
    });
    return outreach;
  });
  // 승인/발송이 참조할 공식 이미지 자산을 행 커밋 전에 등록한다(발송 시
  // 레지스트리 미존재로 fail-closed 되는 창을 없앤다). content-addressed라 중복 안전.
  const uniqueTemplateAssets = new Map<string, (typeof queueableDraftPlans)[number]["artifact"]["assets"][number]>();
  for (const plan of queueableDraftPlans) {
    for (const asset of plan.artifact.assets) uniqueTemplateAssets.set(asset.sha256, asset);
  }
  if (uniqueTemplateAssets.size > 0) {
    await runRefillPhase(
      "create_wave_asset_write",
      () => upsertMailAssets([...uniqueTemplateAssets.values()], `campaign.create(${id})`),
    );
  }
  const assertProgramPolicyCurrent = () => assertAuthoritativeCampaignProgramPolicyCurrent(authoritativeProgramPolicy);
  // W57-M2: 커밋 페어 진입 관문 — 여기까지가 양보 가능 구간이다. 통과하면 메타데이터/큐 쓰기는
  // runRefillCommitPhase 로 묶여 중간 양보가 없다(부분 커밋 방지).
  assertRefillDeadlineBeforeCommit("create_wave_commit");
  if (refillContext) {
    await runRefillCommitPhase(
      "create_wave_metadata_write",
      () => commitInChunksWithCampaignControlGuard(
        writeOps,
        id,
        numberField(refillContext.campaign, "controlVersion", 0),
        assertProgramPolicyCurrent,
      ),
    );
    await runRefillCommitPhase(
      "create_wave_queue_write",
      () => commitCampaignWaveWriteGroups(outreachWriteGroups, {
        campaignId: id,
        expectedControlVersion: numberField(refillContext.campaign, "controlVersion", 0),
        beforeChunk: assertProgramPolicyCurrent,
      }),
    );
  } else {
    await runRefillCommitPhase(
      "create_wave_metadata_write",
      () => commitInChunks(writeOps, assertProgramPolicyCurrent),
    );
    await runRefillCommitPhase(
      "create_wave_queue_write",
      () => commitCampaignWaveWriteGroups(outreachWriteGroups, {
        beforeChunk: assertProgramPolicyCurrent,
      }),
    );
  }
  // F5④(COST-P0-006/007): 라이브 웨이브 1회의 읽기 규모를 관측 가능하게 남긴다 — 스캔 폭을 요청
  // 수에서 분리한 뒤에는 이 숫자가 런타임(60s/512MiB) 한계에 가장 먼저 부딪힌다.
  if (liveQueueRequested) {
    console.info("[campaign-create] live wave read fanout", {
      campaignId: id,
      programId: canonicalProgramId,
      requested: total,
      scanFloor: liveScanFloor,
      programPoolRead: liveProgramPool.length,
      programPoolFresh: liveFreshPool.length,
      preparationRan: livePreparation !== null,
      candidateScanned: livePreparation?.scannedRaw ?? 0,
      evaluated: livePreparation?.emailReady ?? 0,
      evaluationTruncated: livePreparation?.evaluationTruncated ?? 0,
      safetyQuarantinedSkipped: liveSafetyQuarantineTelemetry.skipped,
      safetyQuarantineReadBatches: liveSafetyQuarantineTelemetry.readBatches,
      safetyQuarantineFallbackFailed: liveSafetyQuarantineTelemetry.fallbackFailed,
      queued: queueableDraftPlans.length,
      // W57-m3: 증거 조회 왕복·최대 동시성을 프로드에서도 본다. 이 두 숫자가 8s→281s→480s 를
      // 만든 축이라, 수리 효과와 회귀를 로그만으로 판정할 수 있어야 한다(에뮬 단언과 같은 계측).
      evidenceRoundTrips: readCampaignEvidenceMetrics().roundTrips,
      evidencePeakInFlight: readCampaignEvidenceMetrics().peakInFlight,
    });
  }
  const behaviorLog = makeBehaviorLog(
    { uid, role, team, ip: request.rawRequest?.ip ?? "0.0.0.0" },
    `${refillContext ? "campaign.refill" : "campaign.create"}(${id})`,
    "success",
  );
  behaviorLogs.push(behaviorLog);
  return { ok: true, campaign: redactedCampaignResponse(campaign), outreach: outreachArtifacts.map(redactedOutreachResponse), targeting, behaviorLog, autoDiscovery: autoDiscoveryMeta };
}

const CAMPAIGN_APPROVAL_CLAIMS_COLLECTION = "campaign_outreach_approval_claims";

type CampaignApprovalSummary = {
  selectedCount: number;
  approvedCount: number;
  skipped: number;
  invalidRecipientSkipped: number;
  safetyBlockedSkipped: number;
  dedupSkipped: number;
  capSkipped: number;
  committedCountBefore: number;
  effectiveCap: number;
  programRemainingKpi: number;
  controlVersion: number;
  auditRef: string;
};

function campaignApprovalEvidenceFingerprint(row: Record<string, unknown>, message: Record<string, unknown>): string {
  const evidence = {
    row: {
      campaignId: stringField(row, "campaignId", ""),
      programId: resolveCanonicalProgramId(stringField(row, "programId", "")),
      deliveryState: stringField(row, "deliveryState", stringField(row, "status", "")),
      messageRef: stringField(row, "messageRef", ""),
      to: validEmailField(row.to),
      creatorEmail: validEmailField(row.creatorEmail),
      creatorId: stringField(row, "creatorId", ""),
      candidateId: stringField(row, "candidateId", ""),
      creatorHandle: stringField(row, "creatorHandle", stringField(row, "handle", "")),
      creatorName: stringField(row, "creatorName", ""),
      creatorCategory: stringField(row, "creatorCategory", stringField(row, "category", "")),
      creatorPlatform: stringField(row, "creatorPlatform", stringField(row, "platform", "")),
      allowInflyOverlap: row.allowInflyOverlap === true,
      liveSend: row.liveSend === true,
      dryRun: row.dryRun === true,
      updatedAtIso: stringField(row, "updatedAtIso", ""),
      compilerVersion: stringField(row, "compilerVersion", stringField(message, "compilerVersion", "")),
      templateRevision: stringField(row, "templateRevision", stringField(message, "templateRevision", "")),
      bodyFormat: stringField(row, "bodyFormat", stringField(message, "bodyFormat", "")),
      contentHash: stringField(row, "contentHash", stringField(message, "contentHash", "")),
      compiledHash: stringField(row, "compiledHash", stringField(message, "compiledHash", "")),
      textHash: stringField(row, "textHash", stringField(message, "textHash", "")),
      compiledFingerprint: stringField(row, "compiledFingerprint", stringField(message, "compiledFingerprint", "")),
    },
    message: {
      campaignId: stringField(message, "campaignId", ""),
      programId: resolveCanonicalProgramId(stringField(message, "programId", "")),
      to: validEmailField(message.to),
      creatorEmail: validEmailField(message.creatorEmail),
      creatorId: stringField(message, "creatorId", ""),
      candidateId: stringField(message, "candidateId", ""),
      creatorHandle: stringField(message, "creatorHandle", ""),
      creatorName: stringField(message, "creatorName", ""),
      creatorCategory: stringField(message, "creatorCategory", ""),
      creatorPlatform: stringField(message, "creatorPlatform", ""),
      allowInflyOverlap: message.allowInflyOverlap === true,
      liveSend: message.liveSend === true,
      dryRun: message.dryRun === true,
      updatedAtIso: stringField(message, "updatedAtIso", ""),
      compilerVersion: stringField(message, "compilerVersion", ""),
      templateRevision: stringField(message, "templateRevision", ""),
      bodyFormat: stringField(message, "bodyFormat", ""),
      contentHash: stringField(message, "contentHash", ""),
      compiledHash: stringField(message, "compiledHash", ""),
      textHash: stringField(message, "textHash", ""),
      compiledFingerprint: stringField(message, "compiledFingerprint", ""),
    },
  };
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex").slice(0, 32);
}

function campaignApprovalCampaignFingerprint(campaign: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({
    controlVersion: numberField(campaign, "controlVersion", 0),
    liveSendCap: numberField(campaign, "liveSendCap", 0),
    liveSendBatchId: liveSendBatchIdField(campaign.liveSendBatchId),
    liveSendBatchCap: liveSendBatchCapField(campaign.liveSendBatchCap),
    allowInflyOverlap: campaignAllowsInflyOverlap(campaign),
  })).digest("hex").slice(0, 32);
}

function campaignApprovalSummaryFromClaim(claim: Record<string, unknown>): CampaignApprovalSummary {
  const count = (key: string) => Math.max(0, Math.round(numberField(claim, key, 0)));
  return {
    selectedCount: count("selectedCount"),
    approvedCount: count("approvedCount"),
    skipped: count("skipped"),
    invalidRecipientSkipped: count("invalidRecipientSkipped"),
    safetyBlockedSkipped: count("safetyBlockedSkipped"),
    dedupSkipped: count("dedupSkipped"),
    capSkipped: count("capSkipped"),
    committedCountBefore: count("committedCountBefore"),
    effectiveCap: count("effectiveCap"),
    programRemainingKpi: count("programRemainingKpi"),
    controlVersion: count("controlVersionAfter"),
    auditRef: stringField(claim, "auditRef", ""),
  };
}

// Exact 1–5 row approval is one serializable mutation. Expensive suppression/dedup
// reads happen as a preflight, but every row/message/campaign input is fingerprinted
// and CAS-checked in the commit transaction. The send worker rechecks mail safety.
export async function approveCampaignOutreach(request: CallableRequest) {
  const actor = campaignControlActor(request);
  const uid = actor.uid;
  const role = request.auth?.token?.role ?? "guest";
  const team = request.auth?.token?.team ?? "—";
  const data = isRecord(request.data) ? request.data : {};
  const approvalInput = parseCampaignOutreachApprovalInput(data);
  const { campaignId, programId, outreachIds, expectedVersion } = approvalInput;
  const actorUserIdHash = campaignControlActorHash(uid);
  const selectionFingerprint = campaignApprovalSelectionFingerprint(approvalInput, actorUserIdHash);
  const claimRef = adminDb.collection(CAMPAIGN_APPROVAL_CLAIMS_COLLECTION).doc(selectionFingerprint);
  const nowIsoValue = nowIso();
  const sendAfterIso = approvalInput.sendAfterIso ?? nowIsoValue;
  // 헤세 결정 2026-09-16: outreachDedupScope는 승인 1건당 한 번만 해소한다(행마다 readSettings
  // 재호출 금지) — 아래 dedup 판정(resolveOutreachDedupContext/creatorSentInProgramScope)에 그대로 넘긴다.
  const outreachDedupScope = resolveOutreachDedupScope(await readSettings());

  const initialProbe = await adminDb.runTransaction(async (transaction) => {
    const claimSnapshot = await transaction.get(claimRef);
    const authorized = await readAuthorizedCampaignControlInTransaction({
      transaction,
      actor,
      programId,
      campaignId,
      ...(claimSnapshot.exists ? {} : { expectedVersion }),
    });
    if (!claimSnapshot.exists && authorized.safeFields.operationalState !== "active") {
      throw Object.assign(new Error("failed-precondition: campaign is paused or completed"), {
        code: "failed-precondition", errorCode: "approve_campaign_outreach_campaign_paused_completed",
      });
    }
    if (!claimSnapshot.exists) return { replay: false as const, authorized };
    const claim = claimSnapshot.data() ?? {};
    resolveCampaignApprovalAtomicAction({
      expectedVersion,
      currentVersion: authorized.safeFields.controlVersion,
      selectionFingerprint,
      actorUserIdHash,
      existingClaim: claim,
      approvedCount: 0,
      committedCount: 0,
      effectiveCap: 0,
    });
    if (stringField(claim, "campaignId", "") !== campaignId
      || resolveCanonicalProgramId(stringField(claim, "programId", "")) !== authorized.canonicalProgramId) {
      throw Object.assign(new Error("aborted: approval selection claim scope mismatch"), { code: "aborted", errorCode: "approve_campaign_outreach_approval_selection_claim_scope_mismatch" });
    }
    return { replay: true as const, summary: campaignApprovalSummaryFromClaim(claim), authorized };
  });

  const finish = (summary: CampaignApprovalSummary, replayed: boolean) => {
    const behaviorLog = makeBehaviorLog(
      { uid, role, team, ip: request.rawRequest?.ip ?? "0.0.0.0" },
      `campaign.outreach.approve(${campaignId}):${summary.approvedCount}${replayed ? ":replay" : ""}`,
      "success",
    );
    behaviorLogs.push(behaviorLog);
    return {
      ok: true,
      programId: resolveCanonicalProgramId(programId),
      campaignId,
      ...summary,
      replayed,
      behaviorLog,
    };
  };
  if (initialProbe.replay) return finish(initialProbe.summary, true);

  const initialAuthorized = initialProbe.authorized;
  const campaignFingerprint = campaignApprovalCampaignFingerprint(initialAuthorized.campaign);
  const campaignAllowsOverlap = campaignAllowsInflyOverlap(initialAuthorized.campaign);
  const fallbackLiveBatchConfig = await resolveLiveSendBatchConfig(data);
  const campaignBatchId = liveSendBatchIdField(initialAuthorized.campaign.liveSendBatchId);
  const campaignBatchCap = liveSendBatchCapField(initialAuthorized.campaign.liveSendBatchCap);
  const liveBatchConfig = campaignBatchId && campaignBatchCap > 0
    ? { id: campaignBatchId, cap: campaignBatchCap, source: stringField(initialAuthorized.campaign, "liveSendBatchCapSource", "campaign") }
    : fallbackLiveBatchConfig;

  const refs = outreachIds.map((id) => adminDb.collection("campaign_outreach").doc(id));
  const snaps = await adminDb.getAll(...refs);
  if (snaps.some((snapshot) => !snapshot.exists)) {
    throw Object.assign(new Error("not-found: one or more selected outreach rows do not exist"), { code: "not-found", errorCode: "approve_campaign_outreach_outreach_rows_exist" });
  }
  const hits = snaps.map((snapshot) => ({ ref: snapshot.ref, data: snapshot.data() ?? {} }));
  for (const hit of hits) {
    if (stringField(hit.data, "campaignId", "") !== campaignId
      || resolveCanonicalProgramId(stringField(hit.data, "programId", "")) !== initialAuthorized.canonicalProgramId) {
      throw Object.assign(new Error("failed-precondition: selected outreach canonical program/campaign mismatch"), { code: "failed-precondition", errorCode: "approve_campaign_outreach_outreach_canonical_program_campaign_mismatch" });
    }
    if (stringField(hit.data, "deliveryState", stringField(hit.data, "status", "")) !== "queued_for_review") {
      throw Object.assign(new Error("aborted: selected outreach is no longer queued for review"), { code: "aborted", errorCode: "approve_campaign_outreach_outreach_longer_queued_review" });
    }
  }

  const messagePaths = uniqueStrings(hits.map((hit) => stringField(hit.data, "messageRef", "")));
  for (const path of messagePaths) {
    const segments = path.split("/").filter(Boolean);
    if (segments.length < 2 || segments.length % 2 !== 0 || segments.some((segment) => segment === "." || segment === "..")) {
      throw Object.assign(new Error("failed-precondition: selected outreach has an invalid messageRef"), { code: "failed-precondition", errorCode: "approve_campaign_outreach_outreach_invalid_message_ref" });
    }
  }
  const messageRefs = messagePaths.map((path) => adminDb.doc(path));
  const messageSnapshots = messageRefs.length > 0 ? await adminDb.getAll(...messageRefs) : [];
  const messagesByPath = new Map(messageSnapshots.map((snapshot) => [snapshot.ref.path, snapshot.data() ?? {}] as const));
  const evidenceFingerprints = new Map<string, string>();
  const queuedWrites: Array<{ ref: DocumentReference; data: Record<string, unknown>; options?: { merge: boolean } }> = [];
  let approvedCount = 0;
  let skipped = 0;
  let invalidRecipientSkipped = 0;
  let safetyBlockedSkipped = 0;
  let dedupSkipped = 0;
  const capSkipped = 0;

  for (const hit of hits) {
    const messageRefPath = stringField(hit.data, "messageRef", "");
    const message = messagesByPath.get(messageRefPath) ?? {};
    evidenceFingerprints.set(hit.ref.path, campaignApprovalEvidenceFingerprint(hit.data, message));
    const compiledArtifact = mailArtifactFromSnapshot({ ...message, ...hit.data });
    if (!compiledArtifact) {
      throw Object.assign(new Error("failed-precondition: selected outreach has no valid compiled mail approval binding"), { code: "failed-precondition", errorCode: "approve_campaign_outreach_outreach_valid_compiled_mail_approval" });
    }
    const approvalSnapshot = {
      approvalRevision: selectionFingerprint,
      approvedSubject: stringField(hit.data, "subject", stringField(message, "subject", "")),
      approvedSubjectHash: createHash("sha256").update(stringField(hit.data, "subject", stringField(message, "subject", ""))).digest("hex"),
      approvedBodyFormat: compiledArtifact.bodyFormat,
      approvedCompilerVersion: compiledArtifact.compilerVersion,
      approvedTemplateRevision: compiledArtifact.templateRevision,
      approvedContentHash: compiledArtifact.contentHash,
      approvedSourceHash: compiledArtifact.sourceHash,
      approvedCompiledHash: compiledArtifact.compiledHash,
      approvedTextHash: compiledArtifact.textHash,
      approvedCompiledHtml: compiledArtifact.compiledHtml,
      approvedText: compiledArtifact.text,
    };
    const recipientEmail = validEmailField(hit.data.to)
      || validEmailField(hit.data.creatorEmail)
      || validEmailField(message.to)
      || validEmailField(message.creatorEmail);
    const allowInflyOverlap = data.allowInflyOverlap === true
      || hit.data.allowInflyOverlap === true
      || message.allowInflyOverlap === true
      || campaignAllowsOverlap;
    const isLiveRow = (hit.data.liveSend === true || message.liveSend === true)
      && hit.data.dryRun !== true
      && message.dryRun !== true;
    if (!recipientEmail) {
      queuedWrites.push({ ref: hit.ref, data: {
        deliveryState: "blocked",
        status: "blocked",
        humanGate: "blocked",
        blockedReason: "missing_valid_recipient_email",
        blockedAtIso: nowIsoValue,
        updatedAtIso: nowIsoValue,
      }, options: { merge: true } });
      skipped += 1;
      invalidRecipientSkipped += 1;
      continue;
    }
    const suppression = await findMailSuppression({
      email: recipientEmail,
      handle: stringField(hit.data, "creatorHandle", stringField(message, "creatorHandle", stringField(hit.data, "handle", ""))),
      name: stringField(hit.data, "creatorName", stringField(message, "creatorName", "")),
      category: stringField(hit.data, "creatorCategory", stringField(message, "creatorCategory", stringField(hit.data, "category", ""))),
      platform: stringField(hit.data, "creatorPlatform", stringField(message, "creatorPlatform", stringField(hit.data, "platform", ""))),
      text: [
        stringField(hit.data, "creatorName", stringField(message, "creatorName", "")),
        stringField(hit.data, "creatorCategory", stringField(message, "creatorCategory", "")),
        stringField(hit.data, "creatorPlatform", stringField(message, "creatorPlatform", "")),
        recipientEmail,
      ].join(" "),
    });
    if (mailSuppressionBlocksSend(suppression, { allowInflyOverlap })) {
      queuedWrites.push({ ref: hit.ref, data: {
        deliveryState: "blocked",
        status: "blocked",
        humanGate: "blocked",
        blockedReason: suppression.ruleId ?? "mail_safety_blocked",
        blockedDetail: suppression.reason ?? "메일 안전 정책으로 차단되었습니다.",
        blockedAtIso: nowIsoValue,
        updatedAtIso: nowIsoValue,
      }, options: { merge: true } });
      skipped += 1;
      safetyBlockedSkipped += 1;
      continue;
    }
    const dedupData = { ...message, ...hit.data, to: recipientEmail, creatorEmail: recipientEmail };
    const dedupContext = await resolveOutreachDedupContext(dedupData, outreachDedupScope);
    const alreadyContacted = Boolean(dedupContext.creatorKey)
      && (await creatorSentInProgramScope(dedupContext, dedupData));
    if (alreadyContacted) {
      queuedWrites.push({ ref: hit.ref, data: {
        deliveryState: "suppressed_duplicate",
        status: "suppressed_duplicate",
        humanGate: "blocked",
        blockedReason: "duplicate_prior_outreach",
        blockedAtIso: nowIsoValue,
        updatedAtIso: nowIsoValue,
      }, options: { merge: true } });
      skipped += 1;
      dedupSkipped += 1;
      continue;
    }
    queuedWrites.push({ ref: hit.ref, data: {
      deliveryState: "approved",
      status: "approved",
      humanGate: "approved",
      approvedBy: uid,
      approvedByHash: actorUserIdHash,
      approvedAtIso: nowIsoValue,
      sendAfterIso,
      ...approvalSnapshot,
      ...(isLiveRow && liveBatchConfig ? { liveSendBatchId: liveBatchConfig.id, liveSendBatchCap: liveBatchConfig.cap } : {}),
      updatedAtIso: nowIsoValue,
    }, options: { merge: true } });
    if (messageRefPath) {
      queuedWrites.push({ ref: adminDb.doc(messageRefPath), data: {
        ...(isLiveRow && liveBatchConfig ? {
          liveSendBatchId: liveBatchConfig.id,
          liveSendBatchCap: liveBatchConfig.cap,
        } : {}),
        ...approvalSnapshot,
        updatedAtIso: nowIsoValue,
      }, options: { merge: true } });
    }
    approvedCount += 1;
  }

  const auditRef = campaignApprovalAuditRef();
  const commitResult = await adminDb.runTransaction(async (transaction) => {
    const claimSnapshot = await transaction.get(claimRef);
    const authorized = await readAuthorizedCampaignControlInTransaction({
      transaction,
      actor,
      programId,
      campaignId,
      ...(claimSnapshot.exists ? {} : { expectedVersion }),
    });
    if (!claimSnapshot.exists && authorized.safeFields.operationalState !== "active") {
      throw Object.assign(new Error("failed-precondition: campaign is paused or completed"), {
        code: "failed-precondition", errorCode: "approve_campaign_outreach_campaign_paused_completed_2",
      });
    }
    if (claimSnapshot.exists) {
      const claim = claimSnapshot.data() ?? {};
      resolveCampaignApprovalAtomicAction({
        expectedVersion,
        currentVersion: authorized.safeFields.controlVersion,
        selectionFingerprint,
        actorUserIdHash,
        existingClaim: claim,
        approvedCount,
        committedCount: 0,
        effectiveCap: 0,
      });
      return { replayed: true as const, summary: campaignApprovalSummaryFromClaim(claim) };
    }
    if (campaignApprovalCampaignFingerprint(authorized.campaign) !== campaignFingerprint) {
      throw Object.assign(new Error("aborted: campaign approval controls changed; reload the queue"), { code: "aborted", errorCode: "approve_campaign_outreach_campaign_approval_controls_changed" });
    }
    const currentRows = await Promise.all(refs.map((ref) => transaction.get(ref)));
    const currentMessages = await Promise.all(messageRefs.map((ref) => transaction.get(ref)));
    const currentMessagesByPath = new Map(currentMessages.map((snapshot) => [snapshot.ref.path, snapshot.data() ?? {}] as const));
    for (const current of currentRows) {
      if (!current.exists) throw Object.assign(new Error("aborted: selected outreach disappeared"), { code: "aborted", errorCode: "approve_campaign_outreach_outreach_disappeared" });
      const currentData = current.data() ?? {};
      const currentMessage = currentMessagesByPath.get(stringField(currentData, "messageRef", "")) ?? {};
      if (stringField(currentData, "campaignId", "") !== campaignId
        || resolveCanonicalProgramId(stringField(currentData, "programId", "")) !== authorized.canonicalProgramId) {
        throw Object.assign(new Error("failed-precondition: selected outreach scope changed"), { code: "failed-precondition", errorCode: "approve_campaign_outreach_outreach_scope_changed" });
      }
      if (stringField(currentData, "deliveryState", stringField(currentData, "status", "")) !== "queued_for_review") {
        throw Object.assign(new Error("aborted: selected outreach state changed; reload the queue"), { code: "aborted", errorCode: "approve_campaign_outreach_outreach_state_changed" });
      }
      if (campaignApprovalEvidenceFingerprint(currentData, currentMessage) !== evidenceFingerprints.get(current.ref.path)) {
        throw Object.assign(new Error("aborted: selected outreach evidence changed; reload the queue"), { code: "aborted", errorCode: "approve_campaign_outreach_outreach_evidence_changed" });
      }
    }
    const committedCount = await campaignCommittedFloorInTransaction(transaction, campaignId, authorized.campaign);
    const programKpiTarget = Math.max(0, Math.round(numberField(authorized.program, "kpiTarget", 0)));
    const programApprovedCount = Math.max(0, Math.round(numberField(authorized.program, "approvedCount", 0)));
    const campaignUsesProgramKpi = authorized.safeFields.targetMetric !== "sent";
    const programRemainingKpi = campaignUsesProgramKpi && programKpiTarget > 0
      ? Math.max(0, programKpiTarget - programApprovedCount)
      : authorized.safeFields.targetValue;
    // R18: 준비에서 뺀 상한을 승인에서 그대로 물리면 준비된 행이 매 tick 튕기고 스윕이 break 해
    // 영구 잼이 된다. 상한은 한 식(campaignApprovalEffectiveCap)에서 나오고, 쿼터 판정은 준비
    // 경로(kpiClampsTotal)와 **같은 isQuotaDrivenCampaign** 이다.
    const effectiveCap = campaignApprovalEffectiveCap({
      targetMetric: authorized.safeFields.targetMetric,
      outreachQuota: authorized.safeFields.outreachQuota,
      targetValue: authorized.safeFields.targetValue,
      liveSendCap: numberField(authorized.campaign, "liveSendCap", 0),
      programKpiTarget,
      programRemainingKpi,
      automaticRefillLane: isAutomaticCampaignLane(uid),
    });
    const atomicAction = resolveCampaignApprovalAtomicAction({
      expectedVersion,
      currentVersion: authorized.safeFields.controlVersion,
      selectionFingerprint,
      actorUserIdHash,
      approvedCount,
      committedCount,
      effectiveCap,
    });
    if (atomicAction.kind !== "commit") {
      throw Object.assign(new Error("aborted: unexpected approval replay state"), { code: "aborted", errorCode: "approve_campaign_outreach_unexpected_approval_replay_state" });
    }
    for (const write of queuedWrites) transaction.set(write.ref, write.data, write.options ?? { merge: true });
    const summary: CampaignApprovalSummary = {
      selectedCount: outreachIds.length,
      approvedCount,
      skipped,
      invalidRecipientSkipped,
      safetyBlockedSkipped,
      dedupSkipped,
      capSkipped,
      committedCountBefore: committedCount,
      effectiveCap,
      programRemainingKpi,
      controlVersion: atomicAction.nextVersion,
      auditRef: auditRef.path,
    };
    transaction.set(authorized.campaignRef, {
      controlVersion: atomicAction.nextVersion,
      approvalUpdatedAtIso: nowIsoValue,
      approvalUpdatedByHash: actorUserIdHash,
      updatedAtIso: nowIsoValue,
    }, { merge: true });
    transaction.create(auditRef, {
      id: auditRef.id,
      action: "campaign_outreach_selected_approval",
      campaignId,
      programId: authorized.canonicalProgramId,
      campaignRef: authorized.campaignRef.path,
      programRef: authorized.programRef.path,
      selectionClaimRef: claimRef.path,
      selectionFingerprint,
      selectedCount: outreachIds.length,
      selectedRowIdHashes: outreachIds.map((id) => createHash("sha256").update(id).digest("hex").slice(0, 20)),
      approvedCount,
      skipped,
      invalidRecipientSkipped,
      safetyBlockedSkipped,
      dedupSkipped,
      capSkipped,
      committedCountBefore: committedCount,
      effectiveCap,
      programRemainingKpi,
      controlVersionBefore: authorized.safeFields.controlVersion,
      controlVersionAfter: atomicAction.nextVersion,
      actorUserIdHash,
      actorRole: role,
      createdAtIso: nowIsoValue,
      createdAt: FieldValue.serverTimestamp(),
      expireAt: expireAt180DaysFromIso(nowIsoValue),
    });
    transaction.create(claimRef, {
      id: claimRef.id,
      status: "committed",
      selectionFingerprint,
      campaignId,
      programId: authorized.canonicalProgramId,
      expectedVersion,
      selectedCount: outreachIds.length,
      selectedRowIdHashes: outreachIds.map((id) => createHash("sha256").update(id).digest("hex").slice(0, 20)),
      approvedCount,
      skipped,
      invalidRecipientSkipped,
      safetyBlockedSkipped,
      dedupSkipped,
      capSkipped,
      committedCountBefore: committedCount,
      effectiveCap,
      programRemainingKpi,
      controlVersionAfter: atomicAction.nextVersion,
      auditRef: auditRef.path,
      actorUserIdHash,
      createdAtIso: nowIsoValue,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { replayed: false as const, summary };
  });
  return finish(commitResult.summary, commitResult.replayed);
}

const CAMPAIGN_REFILL_COUNTED_STATES = new Set([
  "queued_for_review",
  "approved",
  "processing",
  "sent",
  "mock_sent",
  // W10 F-3: 인가 대기 행도 "이미 이 캠페인 슬롯을 차지한 미결 행"이다. 여기서 빠지면 touch 집합에만
  // 들어가는 반대쪽 비대칭이 생겨, 발송이 한 건도 못 나가는 동안 refill 이 매 pass 새 크리에이터를
  // 계속 끌어다 연기 행만 쌓는다(풀 소모). 두 집합에 항상 함께 있어야 한다.
  "sent_evidence_pending",
  "deferred_awaiting_send_authorization",
  // P0-2: "skipped_undeliverable" 는 **의도적으로** 이 집합에 넣지 않는다(touch 집합에는 있다).
  //   그 행은 미결 슬롯 점유가 아니라 종결된 미발송 결과다 — 쿼터 약정으로 세면 다시는 보낼 수
  //   없는 행이 캠페인 쿼터를 영구 소진해 리필이 멈춘다(위 W10 F-3 의 "슬롯 점유" 논리와 정반대
  //   상황이라 같은 결론을 공유하지 않는다).
]);

function campaignRefillRemaining(
  campaign: Record<string, unknown>,
  outreachRows: readonly Record<string, unknown>[],
): number {
  const targetMetric = stringField(campaign, "targetMetric", "partners");
  const targetValue = Math.max(0, numberField(campaign, "targetValue", 0));
  const campaignQuota = Math.max(0, numberField(campaign, "campaignQuota", 0));
  const desired = targetMetric === "sent"
    ? Math.max(targetValue, campaignQuota)
    : campaignQuota;
  const committedOrPending = outreachRows.filter((row) => CAMPAIGN_REFILL_COUNTED_STATES.has(
    stringField(row, "deliveryState", stringField(row, "status", "")),
  )).length;
  return Math.max(0, desired - committedOrPending);
}

/**
 * A2: 같은 산식을 **개수만** 받아서 계산한다. 행 본문이 필요 없다는 사실이 count() 전환의 근거다 —
 * 위 함수와 desired 계산이 어긋나면 리필 물량이 갈리므로 반드시 한 곳에서 파생시킨다.
 */
export function campaignRefillRemainingFromCount(
  campaign: Record<string, unknown>,
  committedOrPending: number,
): number {
  const targetMetric = stringField(campaign, "targetMetric", "partners");
  const targetValue = Math.max(0, numberField(campaign, "targetValue", 0));
  const campaignQuota = Math.max(0, numberField(campaign, "campaignQuota", 0));
  const desired = targetMetric === "sent"
    ? Math.max(targetValue, campaignQuota)
    : campaignQuota;
  return Math.max(0, desired - Math.max(0, committedOrPending));
}

// T2 [flu-0544, 26-07-29 리더 실측]: candidate_pool 공급은 자정 1회 scheduledCommunityDiscovery +
// **사람이 수동으로 누르는** queueYtDlpDiscovery 뿐이었다(운영 실측: 풀 최신 300건 중 오늘 갱신
// 13건, 나머지 2~3주 정체). refill pass 가 캠페인 저장 키워드로 부족분을 자동 enqueue 하게 해서
// "알아서 찾는" 자동화의 빠진 반쪽을 채운다. 새 컬렉션은 두지 않는다 — queueYtDlpDiscovery 가 쓰는
// discovery_runs/workflow_jobs 를 그대로 재사용하고 mode:"global_candidate_pool" 로 풀에 영속시킨다
// (discovery.ts materializeYtDiscoveryRun → persistCandidates merge:true, 이메일·matchScore 포함).
//
// 레이트리밋 근거: processCampaignOutreachQueue 스케줄(functions/index.ts, "every 5 minutes")이 이
// 스윕을 하루 최대 288회 돈다 — 게이트가 없으면 shortfall 이 지속되는 캠페인마다 매 tick 새 잡을
// 쌓는다. 시간당 1잡으로 잡 폭주를 막고, queueYtDlpDiscovery 1회가 동기 YouTube Data API 프리뷰
// 호출(quota) + 비동기 yt-dlp 워커(cloud-run 비용)를 둘 다 걸기 때문에 시간당 게이트만으로도 최악
// 24개/일이 가능한 점을 별도 일일 상한으로 한 번 더 조인다. 6개/일 = 지속 shortfall 상황에서도
// 약 4시간 간격으로만 신규 검색이 트이는 보수적 값(운영 관찰치가 없어 임의 결정 — 과하면 낮춘다).
export const SHORTFALL_DISCOVERY_MIN_INTERVAL_MS = 60 * 60 * 1000;
/**
 * W59-5: 키워드 공백 스킵 사유(shortfallDiscoverySkip) 기록 스로틀. 사유 자체가 캠페인 문서를
 * 고쳐야만 바뀌는 정적 상태라, 5분 pass 마다 쓰면 하루 288회의 무의미한 merge 가 된다.
 * 발굴 간격 게이트와 같은 1시간을 쓴다 — 그보다 촘촘한 신선도는 이 사유를 보는 어떤 판단에도 쓰이지 않는다.
 */
export const SHORTFALL_DISCOVERY_SKIP_RECORD_THROTTLE_MS = SHORTFALL_DISCOVERY_MIN_INTERVAL_MS;
// R23-5: 더 이상 게이트로 쓰지 않는다(잔여 유닛 게이트로 대체됨) — dailyCount 관측 필드·기존
// 테스트가 이 값을 계속 참조하므로 상수 자체는 남긴다.
export const SHORTFALL_DISCOVERY_DAILY_CAP = 6;
// MEDIUM-1 [적대적 리뷰 4라운드 실측]: 유닛 게이트는 키가 해석될 때만 적용된다(fail-open 예외,
// enqueueShortfallDiscoveryJob 주석) — 그런데 키 미해석 환경(에뮬·시크릿 미바인딩)은 **시크릿
// 바인딩이 풀린 운영과 같은 경로**라, 그 경로에 개수 천장이 없으면 폭주한다(실측: 10회 연속 시도
// 10잡). 1시간 MIN_INTERVAL 이 만드는 물리 상한(24시간/1시간=24)을 그대로 개수 백스톱으로 쓴다 —
// 정상(키 해석 가능) 경로의 동작은 그대로다(유닛 게이트만 본다), 이건 fail-open 경로의 폭주만 막는
// 안전망이다.
export const SHORTFALL_DISCOVERY_DAILY_COUNT_BACKSTOP = 24;
const SHORTFALL_DISCOVERY_DAY_MS = 24 * 60 * 60 * 1000;
// 이 상태들이면 직전 캠페인 잡이 아직 소진되지 않은 것으로 보고 중복 enqueue 를 막는다. "retry" 는
// 실패 후 재시도가 예약된 상태라 processDiscoveryQueue 기준 진행 중과 동일하게 취급한다.
const SHORTFALL_DISCOVERY_ACTIVE_JOB_STATUSES = new Set(["queued", "processing", "retry"]);
// R23-2b: 죽은 쿼리 슬라이스 쿨다운 — newUnique=0 로 끝난 슬라이스는 7일간 재시도하지 않는다.
// 같은 슬라이스를 매 tick(레이트리밋 통과 시마다) 다시 태우는 것은 쿼터만 태우고 결과는 늘 같다.
const QUERY_SLICE_DEAD_COOLDOWN_MS = 7 * SHORTFALL_DISCOVERY_DAY_MS;

// R24 [사용자 지적: "매번 리더가 직접 하드 조치해야 하나, 엔진이 알아서 돌게 하라"]: 키워드 우주
// 자가확장/자가수축 상수. 운영 실측 배경 — 잡당 newUnique 가 1로 수렴(12키워드 우주 포화), 리더가
// expandedKeywords 28개를 **수동으로** 시드(우주 40)했다. 이 수동 개입이 재발하지 않도록 트리거·
// 상한을 여기 고정한다. "센서는 있다 — 액추에이터만 만든다": 트리거는 discovery.ts
// processDiscoveryQueue 가 매 잡 완료 시 이미 쓰는 materialization.newUnique 를 읽기만 한다(새 계측
// 0) — 최근 완료 잡 K개(기본 4)의 newUnique 합이 임계(기본 2) 미만이면 우주가 포화된 것으로 본다.
// 완료 잡이 K개 미만이면(신규 캠페인 등, 판단 근거 자체가 부족) 포화로 오판하지 않는다(호출부에서
// recentJobs.length>=jobCount 로 게이트).
export const SHORTFALL_KEYWORD_EXPANSION_TRIGGER_JOB_COUNT = 4;
export const SHORTFALL_KEYWORD_EXPANSION_TRIGGER_THRESHOLD = 2;
// 일일 추가 상한 — SHORTFALL_DISCOVERY_DAILY_COUNT_BACKSTOP(24, fail-open 경로 전용)보다 훨씬 작게
// 잡아 이 확장이 그 안전망을 압박하지 않는다. 하루 사이 우주가 급격히 바뀌면 sliceHash 회전이 매번
// 다른 슬라이스를 태워 queryLedger 신선도 판정 자체가 무의미해진다는 점도 작게 유지하는 이유다.
export const SHORTFALL_KEYWORD_EXPANSION_DAILY_CAP = 8;
// W5-1: 최근 pass의 실제 발송 가능 재고가 이 값 미만이고 shortfall이 남으면 newUnique 축과
// 독립적으로 확장을 깨운다. 캠페인 문서의 기존 lastRefillCounts만 읽으므로 새 읽기 축은 없다.
export const SHORTFALL_KEYWORD_EXPANSION_SENDABLE_FLOOR = 20;
// n-gram이 공유 예산을 먼저 채워도 우주 밖 어휘 레인이 매 발화마다 최소 한 자리는 평가하게 한다.
// 실제 LLM 채택 수를 본 뒤 n-gram으로 남은 자리를 메워 두 경로 합은 DAILY_CAP을 넘지 않는다.
const SHORTFALL_KEYWORD_EXPANSION_LLM_MIN_ADD_SHARE = 1;
// expandedKeywords 배열 자체의 총량 상한(초과 시 추가 중단 — 퇴출이 자리를 만든다). expandedKeywords
// 를 읽는 stringArrayField 호출은 이 상수를 상한으로 써야 한다(40 이면 저장은 60까지 해도 다음
// 읽기에서 뒤쪽이 잘려 나가 총량 상한 자체가 40으로 조용히 무력화된다 — 아래 enqueueShortfallDiscoveryJob
// 이 이미 그렇게 읽는다).
// R26-1 [BLOCKER-1 적대적 리뷰 실측]: 검색에 실제로 쓰이는 우주(base ∪ expanded)의 결합 캡은 원래
// 이 상수와 별개로 40 에 고정돼 있었다(HIGH-1/R23-2a). 운영 실형상(includeKeywords 12 +
// expandedKeywords 28 = 40, 이미 그 40 캡 자체가 포화)에서 마이닝은 storage(expandedKeywords 필드,
// 이 상수 60 한도)에는 정상적으로 추가되지만, 그 결합 캡(40)이 base(12)+expanded(29, 새로 1개 추가된
// 뒤)를 40으로 자르면서 Set 삽입 순서상 항상 **가장 나중에 추가된(=방금 마이닝된) 항목**을 떨어뜨렸다
// — 그래서 마이닝된 키워드는 어느 회전 tick 의 검색 창(selectHarvestKeywordWindow)에도 영원히 들어가지
// 못했다(sliceMembership 이 쌓이지 않아 HIGH-2 gate②도 충족 못 하고 가지치기도 영구 불가 → 우주가
// 60에서 포화되면 자가확장 자체가 영구 정지). base 최대(40, stringArrayField 캡)와 expanded 총량
// 상한(이 상수, 60)을 둘 다 무손실로 수용하도록 결합 캡을 두 상한의 합으로 넓힌다 — 어떤 조합의
// base/expanded 크기에서도 절대 자르지 않는다.
export const SHORTFALL_KEYWORD_EXPANSION_UNIVERSE_MAX = 60;
export const SHORTFALL_HARVEST_KEYWORD_UNIVERSE_CAP = 40 + SHORTFALL_KEYWORD_EXPANSION_UNIVERSE_MAX;

/**
 * R26-1: base(운영자 소유 includeKeywords) ∪ expanded(R24 기계 확장)를 안전하게 합친 검색 우주.
 * 두 소스 모두를 무손실로 수용하는 캡(SHORTFALL_HARVEST_KEYWORD_UNIVERSE_CAP)을 하나의 함수로
 * 고정해 호출부들이 항상 같은 규칙을 쓰게 한다 — 인라인 slice(0, 40) 을 여러 곳에 따로 두면
 * 한쪽만 고치고 다른 쪽을 놓치기 쉽다(BLOCKER-1 이 실제로 그렇게 재발했다).
 */
export function resolveShortfallHarvestKeywordUniverse(baseKeywords: string[], expandedKeywords: string[]): string[] {
  return Array.from(new Set([...baseKeywords, ...expandedKeywords])).slice(0, SHORTFALL_HARVEST_KEYWORD_UNIVERSE_CAP);
}
// 관측 맵 링버퍼 크기 — 감사 가시성 목적, 무한정 쌓이지 않게 최근 N건만 남긴다.
const SHORTFALL_KEYWORD_EXPANSION_EVENTS_RING_SIZE = 20;
// HIGH-2 [적대적 리뷰 실측]: queryLedger 는 슬라이스(12키워드 창) 단위 죽음만 안다. 옛 설계는 그
// 죽음을 "마지막으로 그 슬라이스에 속했던" 모든 키워드에 그대로 귀속시켰다 — 운영자가 12개를 직접
// 시드하면 우연히 같은 12개 창 하나로 묶여, 그 슬라이스 1건 은퇴가 시드 12개 중 11개를 한 번에
// 지웠다(실측). 두 겹 완화:
//  ① 기계가 스스로 추가한 키워드만 수축 대상이다(감사 링 keywordExpansion.events 의 "mined" 추가
//     이력에 있는 키워드만) — 운영자가 직접 심은 항목은 이 링에 없으므로 자동으로 무접촉이다.
//  ② 슬라이스 1회 죽음(창 1회 실패의 region·타이밍 노이즈일 수 있다)만으로 즉사시키지 않는다 —
//     서로 다른 슬라이스 ≥2 에서 죽음이 확인돼야 제거한다.
const SHORTFALL_KEYWORD_EXPANSION_PRUNE_DISTINCT_DEAD_SLICES_REQUIRED = 2;
// 키워드당 최근 소속 슬라이스 해시를 이만큼(중복 제거 후) 누적해 둔다 — ②의 "서로 다른 슬라이스
// ≥2" 판정 근거. 회전 주기상 이 정도면 충분히 여러 창을 거친 뒤에도 최근 증거가 남는다.
const SHORTFALL_KEYWORD_EXPANSION_SLICE_MEMBERSHIP_HISTORY = 5;
// n-gram 정규화 — 검색어로 안전한 charset(문자·숫자·공백·하이픈)만, 2~30자.
const SHORTFALL_KEYWORD_EXPANSION_MIN_LENGTH = 2;
const SHORTFALL_KEYWORD_EXPANSION_MAX_LENGTH = 30;
const SHORTFALL_KEYWORD_EXPANSION_NGRAM_MAX = 3;
// 이메일 보유 후보의 문서에서 나온 n-gram 가중치 — "실제로 통한 근방을 판다"(코디네이터 지시 원문).
const SHORTFALL_KEYWORD_EXPANSION_EMAIL_WEIGHT = 2;
// 마이닝 소스 문서 스캔 상한 — 캠페인당 이 개수까지만 candidate 문서를 읽는다(무제한 읽기 방지).
const SHORTFALL_KEYWORD_EXPANSION_CANDIDATE_SCAN_LIMIT = 300;
// 검색어로 부적절한 일반어·조사 — 관사·불용어와 코디네이터가 예시로 든 "video"/"shorts" 류.
//
// R29-2 [운영 실사고 2026-07-31]: R24 자가확장 첫 발화가 캐낸 8개 중 `com`·`gmail`·`gmail com`·`you`
// 가 여기 없어서 통과했다. 도메인/플랫폼 파편·연락 홍보 어휘·대명사를 보강한다(기존 항목 삭제 없음).
// 근본 수리는 R29-1(토큰화 전 연락처·링크 제거)이고 이 목록은 그 뒤에 남는 잔여를 막는 2선이다.
const SHORTFALL_KEYWORD_EXPANSION_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "this", "that", "is",
  "are", "be", "video", "videos", "shorts", "short", "channel", "official", "new", "best", "top",
  "how", "what", "why", "vs", "review", "reviews",
  "그리고", "그것", "이것", "저것", "영상", "채널", "공식", "최고", "방법", "리뷰",
  // R29-2 도메인·플랫폼 파편(이메일/URL 잔여물).
  "com", "net", "org", "co", "kr", "gmail", "naver", "daum", "http", "https", "www",
  "mail", "email", "youtube", "instagram", "twitter", "tiktok", "discord", "link", "links",
  // R29-2 연락·홍보 어휘.
  "business", "contact", "inquiry", "inquiries", "sponsor", "sponsored", "subscribe", "follow", "dm",
  "문의", "연락", "협찬", "비즈니스", "이메일", "구독", "좋아요", "댓글",
  // R29-2 대명사·초일반어.
  "you", "your", "we", "our", "my", "me", "it", "all",
  "play", "playing", "fun", "live", "stream", "streaming", "content", "game play",
  // R30-4 [적대 리뷰 MEDIUM-1]: 전치사·계사·대명사 보강. R29 라운드에 받은 지적("by/nobody/'us at'
  // 같은 문법 파편이 일8·총60 예산을 먹는다")이 LLM 경로로 그대로 승계돼 실측에서 `by` 가 채택됐다
  // (2자라 normalizeExpansionTerm 통과 · 우주 부분집합도 아님). 목록 보강은 1선이고, 구조적 해법은
  // 아래 isStopwordOnlyTerm(모든 토큰이 불용어인 n-gram 배제)이다.
  "by", "at", "us", "from", "as", "into", "over", "under", "about", "after", "before",
  "up", "down", "out", "off", "than", "then", "when", "where", "who", "which",
  "was", "were", "am", "been", "being", "do", "does", "did", "can", "will", "just",
  "not", "no", "nobody", "any", "some", "more", "most", "very", "here", "there",
  // W90 [프로드 실측 · cp-bd7d1ea7aq4k]: 게임 스코프 캠페인의 expandedKeywords 에 실존하던 정크.
  //   전부 n-gram 마이너 산물이고 12개 창 로테이션에서 관측 쿼터를 잠식 중이었다.
  //   "have a" 는 아래 isStopwordOnlyTerm 이 조합으로 잡고, "all levels" 는 all+levels 로 잡힌다.
  "like", "join", "have", "has", "had", "re", "go", "going", "get", "got",
  "news", "daily", "weekly", "updates", "update", "level", "levels", "culture",
  "좋아요", "가입", "소식", "매일", "업데이트",
]);

/**
 * R23-2b: 쿼리 슬라이스 해시 — 키워드서브셋×윈도×정렬×region 4축을 안정적으로 하나의 키로 접는다.
 * 오늘은 region 회전(R23-2c)·키워드 우주 확장(R23-2a)이 아직 없어 캠페인마다 사실상 슬라이스가
 * 하나뿐이지만, 원장 스키마와 쿨다운 게이트를 먼저 놓아야 이후 두 축이 실제 회전을 시작했을 때
 * 슬라이스별로 독립적으로 추적된다. sort 는 searchYouTubeLive 가 현재 "date" 로 고정하므로 그대로
 * 반영한다(R23-2c 가 회전시키면 그 값을 그대로 여기 넣으면 된다).
 */
/**
 * R23-2c: 검색 region/language 회전 축. **검색 다양화 전용**이다 — 크리에이터 국가 판정
 * (youtubeCreatorCountryPolicyDecision, snippet.country 유래 region/creatorCountry)에는 이 값을
 * 절대 쓰지 않는다(discovery.ts:1385-1386 주석과 같은 경계). 그 판정은 `countryTargeting` 이
 * 전담하고 이 함수의 반환값과는 완전히 독립이다.
 *
 * 운영자가 targetingCriteria.regions 를 명시했으면 그 값을 그대로 쓴다(회전 없음 — 명시적 설정
 * 우선). 비어 있을 때만(대부분의 캠페인이 이 경우다) 회전한다 — 회전이 없으면 매 harvest 가
 * 항상 같은(리전 힌트 없는) 검색만 반복해 다양성이 고정된다.
 */
const REGION_ROTATION_POOL: readonly string[] = DEFAULT_YOUTUBE_CREATOR_COUNTRIES;

// BLOCKER-2(iii) [적대적 리뷰 실측 · R23-5 로 전제 정정]: 회전 풀 크기(6) 가 **당시** 일일 상한
// (SHORTFALL_DISCOVERY_DAILY_CAP=6, 지금은 게이트가 아니라 관측 전용)과 같았다 — 쿼터 소진 하루면
// 6개 슬라이스 전부가 같은 날 은퇴 판정을 받아 슬라이스 우주 전체가 7일 은퇴되고, 해제 수단이
// Firestore 수동 편집뿐이었다. 새 지역 코드를 추가하지 않고(REGION_ROTATION_POOL 은 그대로) 기존
// 6개의 **조합**만 넓힌다: 단일 지역(6) + 서로 다른 두 지역의 쌍(C(6,2)=15) = 21 — searchYouTubeLive
// 는 filters.regions 에 여러 지역이 와도 이미 지원한다(categories×regions 카티션, R23-2c 이전부터
// 있던 동작 — 새 개념 아니다). 앞 6개 인덱스(0~5)는 기존 단일-지역 매핑과 완전히 동일해 기존 회전
// 테스트(R23-2c)를 그대로 통과한다. 현재는 하루 소진 판정이 잔여 유닛 게이트(R23-5)로 결정되므로
// "슬라이스 6개=일일 상한 6개" 등식 자체는 더 이상 성립하지 않는다 — 우주 21 이 하루 소진에도
// 전체가 은퇴되지 않는다는 결론(BLOCKER-2④)만 유효하게 남는다.
const REGION_ROTATION_SINGLE_COUNT = REGION_ROTATION_POOL.length;
const REGION_ROTATION_PAIR_COUNT = (REGION_ROTATION_POOL.length * (REGION_ROTATION_POOL.length - 1)) / 2;
const REGION_ROTATION_UNIVERSE_SIZE = REGION_ROTATION_SINGLE_COUNT + REGION_ROTATION_PAIR_COUNT;

/** n개 원소에서 서로 다른 두 인덱스(i<j)의 사전식 pairIndex 번째 조합을 되돌린다(0-based). */
function combinationPairIndices(n: number, pairIndex: number): [number, number] {
  let remaining = pairIndex;
  for (let i = 0; i < n; i += 1) {
    const rowSize = n - 1 - i;
    if (remaining < rowSize) return [i, i + 1 + remaining];
    remaining -= rowSize;
  }
  return [0, Math.min(1, n - 1)];
}

function regionRotationSliceAt(index: number): string[] {
  if (index < REGION_ROTATION_SINGLE_COUNT) return [REGION_ROTATION_POOL[index]];
  const [i, j] = combinationPairIndices(REGION_ROTATION_POOL.length, index - REGION_ROTATION_SINGLE_COUNT);
  return [REGION_ROTATION_POOL[i], REGION_ROTATION_POOL[j]];
}

function nextHarvestSearchRegions(
  operatorRegions: string[],
  state: Record<string, unknown>,
): { regions: string[]; nextRotationIndex: number | null } {
  if (operatorRegions.length > 0) return { regions: operatorRegions, nextRotationIndex: null };
  const currentIndex = numberField(state, "regionRotationIndex", 0);
  const index = ((Math.trunc(currentIndex) % REGION_ROTATION_UNIVERSE_SIZE) + REGION_ROTATION_UNIVERSE_SIZE) % REGION_ROTATION_UNIVERSE_SIZE;
  return { regions: regionRotationSliceAt(index), nextRotationIndex: (index + 1) % REGION_ROTATION_UNIVERSE_SIZE };
}

// HIGH-1 [운영 실측: job ytdlp_ms72zn80_iktqgz] — queueYtDlpDiscovery 는 run/job 문서에 실검색
// keywords 를 싣지 않았다. materializeYtDiscoveryRun 이 그 문서를 다시 읽어 파싱할 때
// readYtDlpDiscoveryData 는 record.keywords/filters.keywords 가 없으면 하드코딩 기본 3개
// (["mobile game shorts", "hyper casual gameplay", "casual game gameplay"])로 떨어진다 — 캠페인에
// 11개 이상을 설정해도 실검색은 매번 같은 3개였다(같은 채널만 재발견 → 쿼터 소진의 근인). 아래
// 상수·함수는 그 12개 절단을 회전과 맞물리게 한다: 우주(최대 40)가 12 초과면 어느 12개 창을 쓸지
// R23-2c 의 regionRotationIndex(새 커서 아님 — 읽기만 재사용)로 순환시킨다.
const HARVEST_KEYWORD_WINDOW_SIZE = 12;

/** 키워드 우주가 창 크기 이하면 그대로, 초과하면 rotationTick 기준으로 순환하는 12개 창을 고른다.
 * 창 시작점을 12칸씩 전진시키고(우주 길이로 mod), 우주 끝을 넘으면 앞에서부터 이어 채운다 — 그래서
 * 항상 정확히 min(12, universe.length)개를 반환한다(짧은 꼬리 창 없음). MEDIUM [적대적 리뷰 3라운드
 * 실측]: 우주 길이가 12 의 배수가 아니면 인접한 tick 의 창이 서로 **겹칠 수 있다**(예: 우주 15개 →
 * tick0=[0..11], tick1=[12,13,14,0..8] — 9개 중복). 동작 자체는 정상이다: tick 이 순환하는 동안
 * 우주 전체가 결국 커버되고(겹침이 있어도 매 tick 다른 부분집합이 섞여 들어간다), 겹침은 그저 균등
 * 분할이 아니라는 뜻일 뿐이다. 운영자 명시 region 캠페인(R23-2c②)은 regionRotationIndex 가 항상 0 에
 * 고정되므로 이 창도 함께 고정된다 — 회전 자체를 끄는 기존 계약과 같은 스코프다(새 축을 추가하지
 * 않는다).
 */
export function selectHarvestKeywordWindow(keywordUniverse: string[], rotationTick: number): string[] {
  if (keywordUniverse.length <= HARVEST_KEYWORD_WINDOW_SIZE) return keywordUniverse;
  const universeSize = keywordUniverse.length;
  const start = (((Math.trunc(rotationTick) * HARVEST_KEYWORD_WINDOW_SIZE) % universeSize) + universeSize) % universeSize;
  const window: string[] = [];
  for (let i = 0; i < HARVEST_KEYWORD_WINDOW_SIZE; i += 1) {
    window.push(keywordUniverse[(start + i) % universeSize]);
  }
  return window;
}

export type YtdlpPromotionKeywordPlan = {
  keywords: string[];
  keywordUniverse: string[];
  rotationTick: number;
  nextRotationTick: number;
};

/**
 * W75: 새 LLM 플래너가 아니라 R24/R30의 **현행 우주**를 그대로 yt-dlp queryPlan에 투영한다.
 * 캠페인 필드 우선·명시 빈 배열 의미론과 expanded 상한은 shortfall producer와 같은 resolver/상수다.
 * 프로그램 폴백은 호출자가 서버 소유 프로그램 문서를 이미 읽어 넘긴 경우에만 적용한다.
 */
export function resolveYtdlpPromotionKeywordPlan(
  campaign: Record<string, unknown>,
  program: Record<string, unknown>,
  maxQueries = 20,
): YtdlpPromotionKeywordPlan {
  const targetingCriteria = isRecord(campaign.targetingCriteria) ? campaign.targetingCriteria : {};
  const baseKeywords = resolveOwnedCriteriaKeywords([
    { record: campaign, keys: ["includeKeywords", "keywords"] },
    { record: targetingCriteria, keys: ["includeKeywords", "keywords"] },
  ]);
  const expandedKeywords = stringArrayField(
    targetingCriteria.expandedKeywords,
    SHORTFALL_KEYWORD_EXPANSION_UNIVERSE_MAX,
  );
  let keywordUniverse = resolveShortfallHarvestKeywordUniverse(baseKeywords, expandedKeywords);
  if (keywordUniverse.length === 0) {
    const candidateCriteria = isRecord(program.candidateCriteria) ? program.candidateCriteria : {};
    keywordUniverse = resolveShortfallHarvestKeywordUniverse(
      stringArrayField(candidateCriteria.keywords, SHORTFALL_KEYWORD_EXPANSION_UNIVERSE_MAX),
      [],
    );
  }
  const promotionState = isRecord(campaign.ytdlpPromotionState) ? campaign.ytdlpPromotionState : {};
  const rotationTick = Math.max(0, Math.trunc(numberField(promotionState, "rotationTick", 0)));
  return {
    keywords: selectHarvestKeywordWindow(keywordUniverse, rotationTick).slice(0, Math.max(1, Math.min(20, Math.trunc(maxQueries)))),
    keywordUniverse,
    rotationTick,
    nextRotationTick: rotationTick + 1,
  };
}

// R27 [사용자 지시: "키워드 허들을 낮추고 대카테고리에서 세분화를 우리 로직으로, 과학적·수학적으로"]
// — 3암(keyword/broad/topic) 밴딧. 새 스케줄러·새 컬렉션 없이 기존 큐잉 경로(queueYtDlpDiscovery)를
// 재사용한다: enqueue 시점에 EWMA로 원시 슬롯을 배분하고 기존 페이지 예산으로 실제 호출 가능한 암만
// 잡/런 문서에 싣는다. discovery.ts가 실제 호출과 committed-created를 측정하면 다음 pass가 그 잡의
// materialization.sliceArmStats/sliceArmCalls를 읽어 EWMA와 다음 실행 암을 계산한다.
export const SHORTFALL_SLICE_ARM_TYPES = ["keyword", "broad", "topic"] as const;
// EWMA 평활 계수 — R23-5 스타일 롤링 관측과 같은 수준의 반응성(최근 pass 에 더 가중, 그래도 노이즈에
// 과민 반응하지 않도록 0.3).
const SHORTFALL_SLICE_ARM_EWMA_ALPHA = 0.3;
// 이번 pass 의 검색 슬롯 총 예산 — 기존 회전 창 크기(HARVEST_KEYWORD_WINDOW_SIZE=12)와 같은 스케일을
// 쓴다(새 상수를 별도로 만들지 않는다). buildDiscoveryQueryPlan 은 각 암의 slice(0, N) 이 실제 가용
// category×region 조합 수를 넘으면 자연히 그 조합 수로 잘리므로, 이 예산이 실제 검색량보다 넉넉해도
// 안전하다(과다 배분이 에러가 되지 않는다).
export const SHORTFALL_SLICE_ARM_TOTAL_SLOTS = HARVEST_KEYWORD_WINDOW_SIZE;

type SliceArmLedgerEntry = { ewmaNewUniquePerSearch: number; samples: number; lastAtIso: string };
type SliceArmLedgerState = Partial<Record<(typeof SHORTFALL_SLICE_ARM_TYPES)[number], SliceArmLedgerEntry>> & {
  lastAppliedJobRef?: string;
};

/**
 * R27 수용기준④: EWMA 수익률(암별 discoveredByArm/slotsUsed) 비례 배분 + 탐색 하한(모든 암 pass 당
 * 최소 1슬롯, totalSlots>=3 일 때). 순수 함수 — Firestore 무접촉, 값으로 직접 단위 테스트한다.
 * 초기(전 암 samples=0)엔 균등 가중. 일부만 탐색됐으면 미탐색 암엔 이미 알려진 rate 의 평균을
 * 가중치로 준다(0으로 벌점을 주면 그 암이 다시는 안 뽑혀 영구 미탐색이 된다 — 밴딧의 탐색 자체가
 * 막힌다). 정수화는 최대나머지법(largest remainder)으로 총합이 정확히 totalSlots 가 되게 한다.
 */
/** W115-R1 [HIGH 1]: 비용 가중치 보정 배율의 하한/상한. 좁게 잡는다 — 아래 함수 주석 참조. */
export const SLICE_ARM_COST_MULTIPLIER_MIN = 0.25;
export const SLICE_ARM_COST_MULTIPLIER_MAX = 4;

/**
 * 암별 비용 가중치를 **평균 대비 상대비**로 정규화하고 클램프한다(순수).
 *
 * 전 암이 0(또는 관측 불가)이면 전원 1 을 돌려준다 — 분모가 없으면 보정할 근거도 없다.
 */
function normalizedCostMultipliers(rawWeights: readonly unknown[]): number[] {
  const values = rawWeights.map((value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  });
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  if (!(mean > 0)) return values.map(() => 1);
  return values.map((value) => Math.min(
    SLICE_ARM_COST_MULTIPLIER_MAX,
    Math.max(SLICE_ARM_COST_MULTIPLIER_MIN, value / mean),
  ));
}

export function allocateSliceArmSlots(
  totalSlots: number,
  ledger: SliceArmLedgerState,
  /**
   * W115 C2 — **비용 정규화 보정**(선택). 안 넘기면 종전 동작과 바이트 단위로 같다.
   *
   * 왜 곱셈 보정인가: EWMA 수익률(`newUnique/검색콜`)은 "얼마나 새로 찾았나"만 본다. 세 암이
   * 모두 search.list 100유닛/콜이라 그 안에서는 비용이 상수였지만, 실제 목표는 신규 채널이 아니라
   * **이메일**이고, 암마다 이메일 전환율이 다르다(설명란 추출이 붙은 뒤로 특히). 그래서 관측된
   * `이메일/유닛`을 가중치에 곱해 "같은 유닛으로 더 많은 이메일을 낳는 암"이 이긴다.
   * 기존 EWMA 축을 **대체하지 않고 곱한다** — 밴딧 구조·탐색 하한 계약은 그대로다.
   */
  costWeights?: Readonly<Record<string, number>>,
): Record<(typeof SHORTFALL_SLICE_ARM_TYPES)[number], number> {
  const arms = SHORTFALL_SLICE_ARM_TYPES;
  const total = Math.max(0, Math.trunc(totalSlots));
  if (total === 0) return { keyword: 0, broad: 0, topic: 0 };

  const entries = arms.map((arm) => {
    const entry = ledger[arm];
    const samples = entry && Number.isFinite(entry.samples) ? Math.max(0, entry.samples) : 0;
    const rate = samples > 0 && Number.isFinite(entry?.ewmaNewUniquePerSearch)
      ? Math.max(0, entry!.ewmaNewUniquePerSearch)
      : null;
    return { arm, rate };
  });
  const knownRates = entries.map((entry) => entry.rate).filter((rate): rate is number => rate !== null);
  const meanKnownRate = knownRates.length > 0 ? knownRates.reduce((sum, rate) => sum + rate, 0) / knownRates.length : 1;
  // W115-R1 [HIGH 1 · 적대 리뷰 — **배분 역전**]
  //   종전 규칙은 "costWeight 가 0 이면 보정하지 않는다"였다. 그 특례가 정확히 거꾸로 물었다:
  //   이메일을 **한 개도 못 낳은** 암(emails/units = 0)이 무보정 base(=스케일 1)를 받고,
  //   실제로 이메일을 낳은 암은 소수 가중치(예: 0.05)를 곱해 스스로를 20배 깎았다 —
  //   실측 재현에서 이메일 0 인 암이 12슬롯 중 10개를 가져갔다. 보정을 켠 결과가 안 켠 것보다
  //   나쁜, 곱셈 보정의 전형적 실패다(척도가 암마다 달라 base 와 비교 가능하지 않다).
  //
  //   수리: costWeight 를 **평균 대비 상대비**(w/mean)로 정규화한 뒤 [0.25, 4] 로 클램프해
  //   **전 암에 일관 적용**한다. 0 특례는 없다 — 0 인 암은 하한 0.25 배를 받고(영구 미탐색은
  //   아래 탐사 하한이 따로 막는다), 평균과 같은 암은 정확히 1 배(=무보정)를 받는다.
  //   클램프 폭이 좁은 이유: 유닛/이메일은 표본이 적을 때 두 자릿수로 튄다 — 한 pass 관측이
  //   EWMA 축을 통째로 덮으면 그건 보정이 아니라 교체다.
  const costMultipliers = costWeights ? normalizedCostMultipliers(arms.map((arm) => costWeights[arm])) : null;
  const weights = entries.map((entry, index) => {
    const base = entry.rate ?? meanKnownRate;
    return costMultipliers ? base * costMultipliers[index] : base;
  });
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);

  // 탐색 하한 — 예산이 암 개수 이상이면 암마다 최소 1슬롯을 먼저 떼어 둔다(예산이 모자라면 최선노력:
  // 하한 없이 비율로만 배분한다).
  // W115 C2: 비용 보정을 켜면 승자 쏠림이 커지므로 하한도 함께 올린다 — 최소 탐사 비율
  //   (DISCOVERY_MIN_ARM_EXPLORATION_SHARE)을 슬롯 수로 환산해 어떤 암도 그 아래로 못 내려간다.
  //   보정을 안 켜면 종전 그대로 1 이다.
  //   W115-R1 [MEDIUM]: `floor` 는 기본 예산(12)에서 `floor(1.2) = 1` 이라 종전 하한과 같은 값이
  //   되어 **무연산**이었다 — 즉 "최소 탐사 비율"이라는 이름이 지키는 것이 아무 것도 없었다.
  //   비율 하한은 올림이 맞다(10%를 보장한다는 뜻이지 10% 아래로 내려도 된다는 뜻이 아니다).
  const explorationFloor = costWeights
    ? Math.max(1, Math.ceil(total * DISCOVERY_MIN_ARM_EXPLORATION_SHARE))
    : 1;
  const floorPerArm = total >= arms.length * explorationFloor ? explorationFloor : (total >= arms.length ? 1 : 0);
  const floorReserved = floorPerArm * arms.length;
  const remaining = Math.max(0, total - floorReserved);
  const rawShares = weightSum > 0
    ? weights.map((weight) => (remaining * weight) / weightSum)
    : weights.map(() => remaining / arms.length);
  const floors = rawShares.map((share) => Math.floor(share));
  const usedByFloor = floors.reduce((sum, value) => sum + value, 0);
  let deficit = remaining - usedByFloor;
  const remainderOrder = rawShares
    .map((share, index) => ({ index, remainder: share - floors[index] }))
    .sort((a, b) => b.remainder - a.remainder);
  const additional = [...floors];
  for (let i = 0; i < remainderOrder.length && deficit > 0; i += 1) {
    additional[remainderOrder[i].index] += 1;
    deficit -= 1;
  }
  const allocation: Record<string, number> = {};
  arms.forEach((arm, index) => { allocation[arm] = floorPerArm + additional[index]; });
  return allocation as Record<(typeof SHORTFALL_SLICE_ARM_TYPES)[number], number>;
}

/**
 * R27: 잡 완료(=다음 pass 가 그 잡을 관측) 시 EWMA 갱신.
 *
 * R28-1/W9-1: 분모는 **배분 슬롯이 아니라 그 암이 실제로 발사한 검색 콜**
 * (materialization.sliceArmCalls[arm].attemptedSearchCalls)이고, 분자는 authoritative batch commit 뒤
 * 새로 생성된 campaign candidate 수(sliceArmStats)다. merged/rejected/preview 는 보상 0 이다.
 * W9-1 이전의 고정 keyword→broad→topic 실행 순서에서는 전역 페이지 예산이 먼저 마를 때 꼬리 암이
 * 실행되지 않은 채 `0/slots` 로 청구돼 영구 기아가 자기강화됐다. 실행 근거가 없는 암(attempted<=0)은
 * samples 를 올리지 않고, 계측이 없는 레거시 잡(R28 이전 완료분)은 종전대로 slots 를 분모로 쓴다.
 */
export function applySliceArmEwmaUpdate(
  priorLedger: SliceArmLedgerState,
  sliceArmStats: Record<string, unknown>,
  sliceArmSlots: Record<string, unknown>,
  nowIso: string,
  sliceArmCalls?: Record<string, unknown>,
): SliceArmLedgerState {
  const next: SliceArmLedgerState = { ...priorLedger };
  for (const arm of SHORTFALL_SLICE_ARM_TYPES) {
    const slots = Math.max(0, Math.trunc(numberField(sliceArmSlots, arm, 0)));
    if (slots <= 0) continue;
    const armCalls = sliceArmCalls && isRecord(sliceArmCalls[arm]) ? sliceArmCalls[arm] as Record<string, unknown> : null;
    // 계측이 있으면 실호출이 분모, 없으면(레거시 잡) 종전 slots.
    const denom = armCalls
      ? Math.max(0, Math.trunc(numberField(armCalls, "attemptedSearchCalls", 0)))
      : slots;
    if (denom <= 0) continue;
    const committedCreated = Math.max(0, Math.trunc(numberField(sliceArmStats, arm, 0)));
    const rate = committedCreated / denom;
    const priorEntry = priorLedger[arm];
    const priorSamples = priorEntry && Number.isFinite(priorEntry.samples) ? Math.max(0, priorEntry.samples) : 0;
    const priorEwma = priorSamples > 0 && priorEntry && Number.isFinite(priorEntry.ewmaNewUniquePerSearch)
      ? priorEntry.ewmaNewUniquePerSearch
      : rate;
    const nextEwma = priorSamples === 0
      ? rate
      : SHORTFALL_SLICE_ARM_EWMA_ALPHA * rate + (1 - SHORTFALL_SLICE_ARM_EWMA_ALPHA) * priorEwma;
    next[arm] = { ewmaNewUniquePerSearch: nextEwma, samples: priorSamples + 1, lastAtIso: nowIso };
  }
  return next;
}

function campaignHarvestSliceHash(keywords: string[], targetingCriteria: Record<string, unknown>): string {
  const regions = stringArrayField(targetingCriteria.regions, 20).map((region) => region.toUpperCase()).sort();
  const window = numberField(targetingCriteria, "recentActivityDays", 7);
  const sort = "date";
  const seed = [
    [...keywords].map((keyword) => keyword.trim().toLowerCase()).sort().join(","),
    regions.join(","),
    String(window),
    sort,
  ].join("::");
  return createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

// R24: 마이닝/가지치기 순수 함수 — Firestore 접근 없이 텍스트·맵만 다뤄 실측 테스트가 시나리오별로
// 결정론적 입력을 줄 수 있게 한다.

/** 검색어로 안전한 charset(문자·숫자·공백·하이픈)만, 2~30자로 다듬는다. 통과 못 하면 null. */
export function normalizeExpansionTerm(term: string): string | null {
  const trimmed = term.trim().toLowerCase().replace(/\s+/g, " ");
  if (trimmed.length < SHORTFALL_KEYWORD_EXPANSION_MIN_LENGTH || trimmed.length > SHORTFALL_KEYWORD_EXPANSION_MAX_LENGTH) return null;
  if (!/^[\p{L}\p{N} -]+$/u.test(trimmed)) return null;
  // 연도·번호 같은 순수 숫자(및 숫자+공백/하이픈) n-gram 은 검색어로 무의미하다(예: "2024", "10 20").
  if (/^[0-9 -]+$/.test(trimmed)) return null;
  return trimmed;
}

function tokenizeForExpansion(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
}

/**
 * R29-1 [운영 실사고 2026-07-31 · 근본 수리]: 토큰화 **전에** 연락처·링크를 지운다.
 *
 * 사고: R24 자가확장 첫 발화가 캐낸 8개 중 `com`·`gmail`·`gmail com` 은 채널 설명란의 이메일 주소
 * 파편이었다(`business@gmail.com` → 비문자 경계 분해). 게다가 이메일 보유 문서에 가중치를 곱하는
 * 설계(SHORTFALL_KEYWORD_EXPANSION_EMAIL_WEIGHT)가 이 오염을 **정확히 증폭**한다 — 이메일이 있는
 * 문서일수록 이메일 문자열도 있기 때문이다.
 *
 * 제거는 삭제가 아니라 **공백 치환**이다. 잘라 붙이면 인접 토큰이 이어져 원문에 없던 유령 n-gram
 * (`문의구독` 같은)이 생긴다. 순수 함수 — 값으로 직접 단위 테스트한다.
 */
export function stripContactArtifacts(text: string): string {
  return text
    // ① URL 먼저(이메일 패턴보다 먼저 지워야 쿼리스트링 속 @ 가 이메일로 오인되지 않는다).
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    // ② 이메일 주소 전체(로컬파트+도메인) — `\S+` 는 공백을 넘지 않으므로 한 낱말만 먹는다.
    .replace(/\S+@\S+/g, " ")
    // ③ 남은 핸들(@handle) — SNS 유도 문구에 흔하다.
    .replace(/@[\w.-]+/g, " ")
    // ④ 전화번호·타임스탬프 같은 4자리 이상 숫자열(구분자 포함). 3자리 이하(게임 제목의 숫자)는 남긴다.
    .replace(/\+?\d[\d\-().]{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ngramsFromTokens(tokens: string[], maxN: number): string[] {
  const grams: string[] = [];
  for (let n = 1; n <= maxN; n += 1) {
    for (let i = 0; i + n <= tokens.length; i += 1) {
      grams.push(tokens.slice(i, i + n).join(" "));
    }
  }
  return grams;
}

/**
 * R24: 이미 적재된 후보 문서에서 n-gram(1~3) 빈도를 집계한다. 코디네이터 원문은 "영상 제목·태그·
 * 설명"이지만 실제 CandidateResult(discovery.ts) 스키마에는 영상 단위 title/tags 필드가 없다 —
 * 채널 단위 name/publicDescription/category 만 있다(matchedSearchTerms 는 이미 검색에 쓰인 키워드라
 * 되먹이면 우주가 제자리를 맴돈다 — 마이닝 소스에서 의도적으로 제외). 그래서 이 함수는
 * name+publicDescription+category 를 문서당 텍스트로 합쳐 쓴다 — 코디네이터 표현과 다른 지점이며
 * 그 이유를 여기 남긴다. 문서 내부 중복은 한 번만 센다(한 문서가 반복 단어로 순위를 독점하지
 * 않도록) — 이메일 보유 문서는 가중치를 곱해 "실제로 통한 근방을 판다"(코디네이터 지시 원문).
 */
export function mineExpansionKeywordScores(docs: { text: string; hasEmail: boolean }[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const doc of docs) {
    // R29-1: 연락처·링크를 **토큰화 전에** 공백으로 지운다(이메일 가중치가 오염을 증폭하기 전에).
    const tokens = tokenizeForExpansion(stripContactArtifacts(doc.text));
    const grams = new Set(ngramsFromTokens(tokens, SHORTFALL_KEYWORD_EXPANSION_NGRAM_MAX));
    const weight = doc.hasEmail ? SHORTFALL_KEYWORD_EXPANSION_EMAIL_WEIGHT : 1;
    for (const gram of grams) {
      const normalized = normalizeExpansionTerm(gram);
      if (!normalized) continue;
      scores.set(normalized, (scores.get(normalized) ?? 0) + weight);
    }
  }
  return scores;
}

/**
 * R29-3 [운영 실사고 2026-07-31]: 후보가 기존 우주 어느 항목의 **토큰 부분집합**인지 판정한다.
 *
 * 사고에서 캐낸 `game`·`games`·`gaming`·`mobile` 은 전부 기존 우주 항목(`casual game`·`mobile game`·
 * `casual gaming`)의 조각이었다. 기존 우주가 이미 덮는 범위를 초일반어로 다시 캐면 총량 상한만
 * 먹고 신선도는 주지 않는다(사고 당시 60 상한 중 8 낭비).
 *
 * 방향이 중요하다 — **역방향(기존 항목 ⊂ 후보, 즉 후보가 더 구체적)은 배제하지 않는다.**
 * `merge puzzle game` 은 `casual game` 의 부분집합이 아니므로 그대로 통과한다(구체화는 우리가 원하는
 * 방향이다). 단수/복수는 뒤 `s` 하나만 떼어 비교한다(`games`→`game`). 한국어는 조사 제거 없이 원형
 * 비교한다 — 어미를 깎으면 과제거로 멀쩡한 후보까지 잡는다.
 */
function singularizeExpansionToken(token: string): string {
  return /^[a-z0-9]+s$/.test(token) && token.length > 3 ? token.slice(0, -1) : token;
}

function expansionComparableTokens(term: string): Set<string> {
  return new Set(tokenizeForExpansion(term).map(singularizeExpansionToken));
}

export function isExpansionTokenSubsetOfUniverse(term: string, universeLower: Iterable<string>): boolean {
  const candidate = expansionComparableTokens(term);
  if (candidate.size === 0) return false;
  for (const existing of universeLower) {
    const existingTokens = expansionComparableTokens(existing);
    if (existingTokens.size === 0) continue;
    // candidate ⊆ existing 이면 배제. 후보가 더 구체적이면(추가 토큰이 있으면) 이 검사에 걸리지 않는다.
    if ([...candidate].every((token) => existingTokens.has(token))) return true;
  }
  return false;
}

/**
 * R30-4 [적대 리뷰 MEDIUM-1 · 구조적 해법]: **모든 토큰이 불용어인 n-gram** 을 배제한다.
 *
 * 불용어 목록은 단일 토큰만 막는다 — 그래서 `us at`·`for inquiries`·`by the` 같은 문법 파편이
 * 조합으로 살아남아 일 8개·총 60 예산을 먹었다(R29 라운드 지적이 LLM 경로로 그대로 승계됐다).
 * 목록을 아무리 늘려도 조합은 무한하므로 **조합 자체를 막는 규칙**이 필요하다. 토큰 중 하나라도
 * 불용어가 아니면 통과시킨다 — `merge puzzle tycoon` 같은 실제 검색어는 살아야 한다.
 */
export function isStopwordOnlyTerm(term: string): boolean {
  const tokens = tokenizeForExpansion(term);
  if (tokens.length === 0) return true;
  return tokens.every((token) => SHORTFALL_KEYWORD_EXPANSION_STOPWORDS.has(token));
}

/**
 * W90 [구조적 규칙 · 실측 "email casual"]: **연락처/도메인 파편 토큰은 term 전체를 오염시킨다.**
 *
 * 불용어 목록은 단일 토큰만 막고 isStopwordOnlyTerm 은 *모든* 토큰이 불용어일 때만 막는다.
 * 그래서 `email casual` 이 살아남았다 — `email` 은 불용어지만 `casual` 은 정당한 게임 장르어라
 * "전부 불용어"가 아니다. 그런데 이건 캐주얼 게임 검색어가 아니라 **연락처 블록에서 긁힌 n-gram**
 * 이다. 한 토큰이라도 연락처/도메인 파편이면 그 term 은 검색어가 아니다.
 *
 * 오염 집합을 좁게 유지하는 이유: `business`·`contact` 는 **넣지 않는다**. `business simulation`
 * 같은 실제 장르어를 죽인다 — 그 둘은 단일 토큰 불용어로 남겨 두는 것으로 충분하다.
 */
const SHORTFALL_KEYWORD_EXPANSION_CONTACT_POISON_TOKENS = new Set([
  "email", "gmail", "naver", "daum", "mail", "http", "https", "www",
  "com", "net", "org", "co", "kr", "inquiry", "inquiries", "dm",
  "이메일", "메일",
]);

export function hasContactArtifactToken(term: string): boolean {
  return tokenizeForExpansion(term).some((token) => SHORTFALL_KEYWORD_EXPANSION_CONTACT_POISON_TOKENS.has(token));
}

/**
 * 26-08-27 [헤세 지적 · 구조적 종결] — **블랙리스트를 화이트리스트로 뒤집는다.**
 *
 * 지금까지의 방어는 전부 "정크를 이름으로 아는" 방식이었다(불용어 목록 100+개, 조합 규칙,
 * 연락처 파편 집합). 그런데 마이닝 소스가 크리에이터의 자유 서술문이라 파편은 무한히 새로 생긴다 —
 * 목록에 없는 파편이 채택되고, 정크 청소가 그걸 퇴역시키고, 다음 마이닝이 **같은 파편을 다시 캔다**.
 * 프로드 실측(cp-bd7d1ea7aq4k expandedKeywords 48개)에서 27개가 이 잔재였다:
 * `so` · `if you` · `love` · `welcome` · `hi` · `music` · `ll` · `don` · `role playing` · `sociology`.
 * 목록을 또 늘리면 다음 라운드에 또 새는 것이 이 구조의 성질이다.
 *
 * 그래서 판정을 뒤집는다: 이 캠페인들이 찾는 것은 **게임 채널**이므로, 검색어에는 도메인 신호가
 * 반드시 있어야 한다. 신호가 없으면 그 term 이 무엇이든 채택하지 않는다 — 새 파편이 나와도
 * 목록 갱신 없이 막힌다(진동 루프 종결).
 *
 * 넓게 잡은 이유: 장르어(puzzle/rpg/idle/merge/tycoon…)와 플랫폼어(mobile/android/ios)와
 * 다국어 표기(게임/ゲーム/juego/jogo/spiel/jeu…)를 전부 통과시켜야 현지어 검색축이 살아남는다.
 * `satisfying`·`asmr`·`cozy` 처럼 장르 인접 표현도 슈퍼센트 캠페인의 실제 축이라 포함한다.
 */
const EXPANSION_DOMAIN_SIGNAL = new RegExp([
  // 영문 코어
  "game|gaming|gameplay|gamer|playthrough|walkthrough|speedrun|lets ?play",
  // 장르
  "puzzle|rpg|idle|clicker|merge|tycoon|arcade|casual|hypercasual|simulator|simulation",
  "sandbox|roguelike|shooter|strategy|adventure|platformer|racing|sports|card|board",
  // `sim` 단독·농장/건설 계열: "farming sim" 같은 정당한 장르 축이 신호 없음으로 잘리면 안 된다
  //   (기존 R30-4 계약 테스트가 이 term 을 실검색어로 못 박고 있다).
  "\\bsim\\b|farm|farming|builder|building|craft|crafting|tycoons?|idle|merge",
  // 장르 인접(슈퍼센트 실제 축)
  "satisfying|asmr|cozy|relaxing|brain|trivia|quiz|sudoku|mahjong|solitaire|tetris",
  // 플랫폼·스토어
  "mobile|android|ios|iphone|smartphone|app ?store|play ?store",
  // 다국어 표기
  "게임|겜|ゲーム|ゲー|游戏|遊戲|juego|jogo|spiel|jeu|gioco|oyun|игр|gra|permainan|खेल|เกม|لعبة|trò chơi",
].join("|"), "iu");

/**
 * 이 term 이 게임 도메인 신호를 갖고 있는가. 없으면 검색어로 채택하지 않는다.
 *
 * ⚠️ 기존 우주(운영자가 직접 심은 base 키워드)에는 적용하지 않는다 — 사람이 의도적으로 넣은
 *   축까지 이 규칙으로 깎으면 운영자 결정을 코드가 뒤집는 것이 된다. 이 판정은 **기계가 추가하는
 *   경로**(n-gram 마이닝 · LLM 제안)에만 건다.
 */
export function hasExpansionDomainSignal(term: string): boolean {
  return EXPANSION_DOMAIN_SIGNAL.test(String(term ?? ""));
}

/**
 * R30-4/W5-1: 확장 예산 산술을 한 곳으로 모은다 — **총 60 상한**(활성 우주), 일 8개 상한,
 * 롤링 24h 잔여 중 가장 작은 값이 이번 pass의 채택 상한이다. n-gram과 LLM은 이 하나의 예산을
 * 나눠 쓰되, n-gram 후보가 상한을 먼저 채워도 LLM 최소 몫은 남긴다. 호출부가 실제 LLM 채택 수만큼
 * n-gram을 줄이고 빈 LLM 몫은 다시 n-gram으로 채워 두 경로 합을 addCap 이내로 유지한다.
 */
export function resolveExpansionAddCaps(input: {
  universeMax: number;
  survivorCount: number;
  dailyCap: number;
  dailyUsed: number;
  minedCount: number;
}): { roomRemaining: number; addCap: number; llmRemainingCap: number } {
  const roomRemaining = Math.max(0, input.universeMax - input.survivorCount);
  const dailyRemaining = Math.max(0, input.dailyCap - input.dailyUsed);
  const addCap = Math.max(0, Math.min(input.dailyCap, roomRemaining, dailyRemaining));
  const unclaimedCap = Math.max(0, addCap - Math.max(0, input.minedCount));
  const reservedLlmCap = addCap > 0
    ? Math.min(addCap, SHORTFALL_KEYWORD_EXPANSION_LLM_MIN_ADD_SHARE)
    : 0;
  return {
    roomRemaining,
    addCap,
    llmRemainingCap: Math.min(addCap, Math.max(reservedLlmCap, unclaimedCap)),
  };
}

/**
 * R30-2 [설계 원칙: LLM 을 신뢰하지 않는다] — **두 경로가 공유하는 검증층**.
 *
 * n-gram 마이너는 문서에서 이미 정규화된 term 을 뽑지만, LLM 은 임의 문자열을 뱉는다. 그래서 LLM
 * 산출은 R29 가 세운 층을 **순서 그대로** 통과해야 한다:
 *   stripContactArtifacts(연락처·URL 제거) → normalizeExpansionTerm(2~30자·안전 charset)
 *   → 불용어 → 기존 우주 중복 → excludeKeywords → 기존 우주 토큰 부분집합(초일반어) 배제 → 상한.
 * 이 층이 없으면 "gmail·com·game" 같은 R29 사고가 LLM 경로로 그대로 재발한다.
 */
export function validateExpansionCandidateTerms(
  terms: string[],
  input: {
    existingUniverseLower: Set<string>;
    excludeKeywordsLower: Set<string>;
    maxCount: number;
  },
): string[] {
  if (input.maxCount <= 0) return [];
  const accepted: string[] = [];
  const seen = new Set<string>();
  for (const raw of terms) {
    if (typeof raw !== "string") continue;
    const normalized = normalizeExpansionTerm(stripContactArtifacts(raw));
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    if (SHORTFALL_KEYWORD_EXPANSION_STOPWORDS.has(normalized)) continue;
    // R30-4: 단일 불용어 목록으로는 "us at"·"for inquiries" 같은 조합을 막을 수 없다.
    if (isStopwordOnlyTerm(normalized)) continue;
    // W90: 연락처 파편이 한 토큰이라도 섞이면 검색어가 아니다("email casual" 실측).
    if (hasContactArtifactToken(normalized)) continue;
    // 26-08-27: 도메인 신호가 없으면 채택하지 않는다(블랙리스트 → 화이트리스트 전환).
    if (!hasExpansionDomainSignal(normalized)) continue;
    if (input.existingUniverseLower.has(normalized)) continue;
    if (input.excludeKeywordsLower.has(normalized)) continue;
    if (isExpansionTokenSubsetOfUniverse(normalized, input.existingUniverseLower)) continue;
    seen.add(normalized);
    accepted.push(normalized);
    if (accepted.length >= input.maxCount) break;
  }
  return accepted;
}

/**
 * W90 [정크 청소를 수동 스크립트가 아니라 필터로]: **이미 우주에 들어와 있는** 기계 키워드를
 * 현행 필터로 다시 검증해 탈락분을 골라낸다.
 *
 * 왜 일회성 스크립트가 아닌가: 필터를 고칠 때마다 사람이 스크립트를 돌려야 한다면 다음 정크는
 * 다음 사람이 발견할 때까지 남는다. 필터가 정본이면 **필터를 고치는 순간 과거 산출물도 정리된다.**
 *
 * 세 가지를 지킨다:
 *   ① 운영자 시드 무접촉 — machineAddedKeywords 에 없으면 판정하지 않는다(pruneDead 와 같은 규율).
 *   ② 조용히 지우지 않는다 — 반환된 term 은 호출부가 코퍼스에 사유와 함께 retired 로 남긴다.
 *   ③ 매 pass 소량 — 한 번에 다 지우면 우주가 급변해 관측이 끊긴다. 상한을 둔다.
 *
 * 판정은 "지금 새로 제안됐다면 통과했겠는가"다. 그래서 **중복/부분집합 검사는 쓰지 않는다** —
 * 이미 우주에 있으니 자기 자신과 중복이라 전부 탈락해 버린다. 형태 규칙(정규화·불용어·조합·
 * 연락처 오염)과 excludeKeywords 만 본다.
 */
export const SHORTFALL_KEYWORD_EXPANSION_RECONCILE_MAX_PER_PASS = 4;

/**
 * W90 [가시성]: 캠페인 키워드 코퍼스 읽기 전용 조회.
 *
 * 코퍼스는 캠페인 문서 안의 map 이라 화면이 직접 못 읽는다(SEC-P0-004). 이 콜러블이 유일한
 * 통로이고 **읽기만** 한다 — 어떤 쓰기도, 어떤 모델 호출도 없다. 그래서 스테이징 export 는
 * approved 로 분류했다(functions-staging/runtime/index.cjs 주석 트레일 참조).
 */
export async function getCampaignKeywordCorpus(request: CallableRequest) {
  const uid = request.auth?.uid;
  const role = request.auth?.token?.role ?? "guest";
  if (!uid || !CAMPAIGN_ROLES.has(role)) {
    const error = new Error(!uid ? "unauthenticated" : "permission-denied: manager role required");
    Object.assign(error, {
      code: !uid ? "unauthenticated" : "permission-denied",
      errorCode: "get_campaign_keyword_corpus_unauthorized",
    });
    throw error;
  }
  const data = isRecord(request.data) ? request.data : {};
  const campaignId = typeof data.campaignId === "string" ? data.campaignId.trim().slice(0, 120) : "";
  if (!campaignId) {
    throw Object.assign(new Error("campaignId required"), {
      code: "invalid-argument",
      errorCode: "get_campaign_keyword_corpus_campaign_id_required",
    });
  }
  const snapshot = await adminDb.collection("campaigns").doc(campaignId).get();
  const campaign = snapshot.data() ?? {};
  const shortfallState = isRecord(campaign.shortfallDiscoveryState)
    ? campaign.shortfallDiscoveryState as Record<string, unknown>
    : {};
  const corpus = readKeywordCorpus(shortfallState.keywordCorpus, new Date().toISOString());
  const rows = keywordCorpusRows(corpus);
  return {
    ok: true,
    campaignId,
    generation: corpus.generation,
    updatedAtIso: corpus.updatedAtIso,
    activeCount: rows.filter((row) => row.state === "active").length,
    rows,
    // W90-R3: 크리틱이 거부한 후보 이력(유계). 우주에 없는 term 이라 rows 로는 표현할 수 없다.
    rejections: corpus.rejections ?? [],
  };
}

export function reconcileExpandedKeywordsAgainstFilters(
  expandedKeywords: string[],
  input: {
    machineAddedKeywords: ReadonlySet<string>;
    excludeKeywordsLower: Set<string>;
    maxPerPass?: number;
  },
): { kept: string[]; retired: string[] } {
  const limit = Math.max(0, input.maxPerPass ?? SHORTFALL_KEYWORD_EXPANSION_RECONCILE_MAX_PER_PASS);
  const kept: string[] = [];
  const retired: string[] = [];
  for (const keyword of expandedKeywords) {
    if (retired.length >= limit || !input.machineAddedKeywords.has(keyword)) {
      kept.push(keyword);
      continue;
    }
    // 정규화가 실패해도(오늘의 charset 으로는 못 만드는 옛 term) **퇴역시키지 않는다.**
    //   기존 회귀 테스트가 이걸 잡았다: `ske5machine_<run>` 같은 밑줄 term 이 정크가 아닌데도
    //   전부 탈락했다. charset 드리프트는 정크의 증거가 아니고, 그걸로 대량 퇴역하면 이 스윕이
    //   의도(정크 청소)를 넘어 **멀쩡한 우주를 깎는 도구**가 된다. 판정은 정크 의미론으로만 한다.
    const normalized = normalizeExpansionTerm(stripContactArtifacts(keyword)) || keyword.trim().toLowerCase();
    const failsNow = SHORTFALL_KEYWORD_EXPANSION_STOPWORDS.has(normalized)
      || isStopwordOnlyTerm(normalized)
      || hasContactArtifactToken(normalized)
      || input.excludeKeywordsLower.has(normalized);
    // 26-08-27: 도메인 신호 규칙은 **채택(진입) 경로에만** 건다. 여기(청소)에 걸면 밑줄 term 같은
    //   charset 드리프트까지 퇴역시켜 "청소가 멀쩡한 우주를 깎는 도구"가 된다(W90(b) 계약).
    //   이미 쌓인 무신호 정크는 운영 쓰기로 1회 걷었다(26-08-27, cp-bd7d1ea7aq4k 27개).
    if (failsNow) retired.push(keyword);
    else kept.push(keyword);
  }
  return { kept, retired };
}

/** 빈도 상위에서 기존 우주·excludeKeywords·불용어를 뺀 뒤 상한(maxCount)까지만 고른다. */
export function selectExpansionKeywords(
  scores: Map<string, number>,
  existingUniverseLower: Set<string>,
  excludeKeywordsLower: Set<string>,
  maxCount: number,
): string[] {
  if (maxCount <= 0) return [];
  return Array.from(scores.entries())
    .filter(([term]) => !SHORTFALL_KEYWORD_EXPANSION_STOPWORDS.has(term))
    // R30-4 [MEDIUM-1]: 모든 토큰이 불용어인 n-gram 배제 — 두 경로가 같은 규칙을 공유한다.
    .filter(([term]) => !isStopwordOnlyTerm(term))
    // 26-08-27: 게임 도메인 신호 필수 — 자유 서술문에서 긁힌 문법 파편을 구조적으로 배제한다.
    .filter(([term]) => hasExpansionDomainSignal(term))
    .filter(([term]) => !existingUniverseLower.has(term))
    .filter(([term]) => !excludeKeywordsLower.has(term))
    // R29-3: 기존 우주 항목의 토큰 조각(초일반어)은 배제 — 역방향(더 구체적인 후보)은 통과시킨다.
    .filter(([term]) => !isExpansionTokenSubsetOfUniverse(term, existingUniverseLower))
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCount)
    .map(([term]) => term);
}

/**
 * R24: 자가수축 — queryLedger 는 슬라이스(키워드 창) 단위로 키가 잡혀 개별 키워드로 역해시할 수
 * 없다. 그래서 enqueueShortfallDiscoveryJob 이 harvestKeywords/sliceHash 를 계산하는 매 성공 pass
 * 마다 "이 확장 키워드가 마지막으로 속했던 슬라이스"를 sliceMembership 맵에 남겨 두고(같은 함수 본문
 * 아래쪽), 이 함수는 그 맵을 근거로 죽음을 판정한다 — 그 슬라이스가 newUnique===0 로 은퇴
 * 상태이면(R23-2b·BLOCKER-2(ii) 와 동일 판정) 그 키워드를 제거 대상으로 삼는다. includeKeywords 는
 * 인자로도 받지 않는다 — 운영자 소유 필드를 건드릴 경로 자체가 없다.
 */
/** 감사 링(keywordExpansion.events)에서 "mined"(기계 추가) 이력이 있는 키워드만 모은다 — 운영자가
 * 직접 심은 키워드는 이 이벤트가 없으므로 자동으로 수축 스코프 밖이다(HIGH-2). */
function machineAddedKeywordsFromEvents(events: unknown[]): Set<string> {
  const result = new Set<string>();
  for (const event of events) {
    if (!isRecord(event) || event.source !== "mined" || !Array.isArray(event.added)) continue;
    for (const keyword of event.added) if (typeof keyword === "string") result.add(keyword);
  }
  return result;
}

function isSliceHashDead(
  hash: string,
  queryLedger: Record<string, unknown>,
  nowMs: number,
): boolean {
  const ledgerEntry = isRecord(queryLedger[hash]) ? queryLedger[hash] as Record<string, unknown> : null;
  const lastRunAtMs = ledgerEntry && typeof ledgerEntry.lastRunAtIso === "string" ? Date.parse(ledgerEntry.lastRunAtIso) : NaN;
  // "쿨다운 값 재사용" — R23-2b/BLOCKER-2(ii) 의 은퇴 판정과 같은 7일 창을 쓴다. newUnique===0 만
  // 보면 아주 오래 전(수개월 전) 한 번 0 이었던 흔적도 영구히 죽음으로 본다 — "은퇴 상태를 유지
  // 중"이라는 스코프를 같은 시간 창으로 좁힌다.
  return ledgerEntry !== null
    && numberField(ledgerEntry, "newUnique", -1) === 0
    && Number.isFinite(lastRunAtMs)
    && nowMs - lastRunAtMs < QUERY_SLICE_DEAD_COOLDOWN_MS;
}

function pruneDeadExpandedKeywords(
  expandedKeywords: string[],
  sliceMembership: Record<string, unknown>,
  queryLedger: Record<string, unknown>,
  nowMs: number,
  machineAddedKeywords: ReadonlySet<string>,
): { survivors: string[]; removed: string[] } {
  const survivors: string[] = [];
  const removed: string[] = [];
  for (const keyword of expandedKeywords) {
    // HIGH-2①: 운영자가 직접 심은 키워드(기계의 "mined" 추가 이력이 없음)는 이 함수가 절대 건드리지
    // 않는다 — 판정 자체를 하지 않고 무조건 생존시킨다.
    if (!machineAddedKeywords.has(keyword)) { survivors.push(keyword); continue; }
    const hashes = Array.isArray(sliceMembership[keyword])
      ? (sliceMembership[keyword] as unknown[]).filter((hash): hash is string => typeof hash === "string")
      : [];
    const deadHashes = new Set<string>();
    for (const hash of hashes) if (isSliceHashDead(hash, queryLedger, nowMs)) deadHashes.add(hash);
    // HIGH-2②: 슬라이스(12키워드 창) 1회 죽음만으로 즉사시키지 않는다 — 서로 다른 슬라이스에서
    // 반복 확인돼야("≥2") 제거한다(region·타이밍 노이즈로 우연히 한 번 0건인 경우를 견딘다).
    if (deadHashes.size >= SHORTFALL_KEYWORD_EXPANSION_PRUNE_DISTINCT_DEAD_SLICES_REQUIRED) removed.push(keyword);
    else survivors.push(keyword);
  }
  return { survivors, removed };
}

// R24: 트리거 판정 — 새 계측 0. discovery.ts processDiscoveryQueue 가 매 잡 완료 시 이미 쓰는
// materialization.newUnique 를 읽기만 한다. type 을 yt_dlp_discovery 로 좁히는 이유는 같은
// campaignId 로 커뮤니티 인계 잡(COMMUNITY_DISCOVERY_JOB_TYPE)도 workflow_jobs 에 섞여 있어서다.
async function readRecentCompletedDiscoveryJobNewUniqueValues(campaignId: string, jobCount: number): Promise<number[]> {
  const snapshot = await adminDb.collection("workflow_jobs")
    .where("campaignId", "==", campaignId)
    .where("type", "==", "yt_dlp_discovery")
    .where("status", "==", "complete")
    .orderBy("completedAtIso", "desc")
    .limit(jobCount)
    .get();
  return snapshot.docs.map((doc) => {
    const data = doc.data();
    const materialization = isRecord(data.materialization) ? data.materialization as Record<string, unknown> : {};
    return numberField(materialization, "newUnique", 0);
  });
}

// R24: 마이닝 소스 — 이 캠페인 campaign_candidates 문서(BLOCKER-1 이 이미 이 스코프를 액추에이터의
// 실제 적재 스코프로 확정했다). 위 mineExpansionKeywordScores 주석에 스키마 대체 사유를 남겼다.
async function readCampaignCandidateExpansionDocs(campaignId: string): Promise<{ text: string; hasEmail: boolean }[]> {
  const snapshot = await adminDb.collection("campaign_candidates")
    .where("campaignId", "==", campaignId)
    .limit(SHORTFALL_KEYWORD_EXPANSION_CANDIDATE_SCAN_LIMIT)
    .get();
  return snapshot.docs.map((doc) => {
    const data = doc.data();
    const text = [stringField(data, "name", ""), stringField(data, "publicDescription", ""), stringField(data, "category", "")].join(" ");
    return { text, hasEmail: stringField(data, "email", "").length > 0 };
  });
}

// R19-1: KPI 상한 면제의 판정 축은 **캠페인 문서가 아니라 호출 레인**이다.
// R18 은 `campaignQuota > 0` 로 판정했는데 createCampaign 이 모든 캠페인에 `campaignQuota: total`
// 을 쓰고(total 은 항상 >=1) campaignControl 도 하한 1 을 재기록하므로, 사실상 **모든 캠페인이
// 쿼터 캠페인**으로 판정됐다 — 그 결과 운영자 수동 승인에서도 프로그램 KPI 상한이 사라졌다
// (리뷰어 실증: 잔여 KPI 0 인데 수동 승인 2건이 통과, effectiveCap 4).
// 자동 보충 레인은 스윕이 서버에서 직접 구성하는 시스템 actor uid 로만 성립하므로 클라이언트가
// 위조할 수 없다. 준비·승인이 **같은 함수에 같은 종류의 인자**(호출자 uid)를 넘긴다.
const CAMPAIGN_AUTO_REFILL_ACTOR_UID = "system-campaign-auto-refill";
const CAMPAIGN_AUTO_APPROVAL_ACTOR_UID = "system-campaign-auto-approval";

function isAutomaticCampaignLane(uid: string | undefined): boolean {
  return uid === CAMPAIGN_AUTO_REFILL_ACTOR_UID || uid === CAMPAIGN_AUTO_APPROVAL_ACTOR_UID;
}

/**
 * R17-3①: 로그용 오류 식별자. Firestore·callable 오류는 보통 `.code` 를 갖지만, **잘못된 문서 경로
 * 같은 프로그래밍 오류에는 `.code` 가 없다**. 그걸 전부 "unknown" 으로 뭉개면 로그를 봐도 무엇이
 * 터졌는지 알 수 없어, 관측성 필드가 있으나 마나가 된다. 코드가 없으면 메시지를 요약해 남긴다.
 */
function errorCodeForLog(error: unknown): string {
  // R36 [운영 실사고 2026-08-05 15:31/15:46]: 이 함수가 `code` 를 먼저 보기 때문에, 고유
  // `errorCode` 를 붙여 둔 throw 조차 로그·캠페인 문서에 전부 `failed-precondition` 으로만 남았다
  // (자동승인 잼의 실제 사유를 20분간 특정 못 한 원인). 고유 코드가 있으면 그것을 우선한다 —
  // gRPC `code` 는 클래스이고 `errorCode` 가 신원이다.
  const specificCode = (error as { errorCode?: unknown } | null)?.errorCode;
  if (typeof specificCode === "string" && specificCode.length > 0) return specificCode;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  if (typeof code === "number" && Number.isFinite(code)) return String(code);
  const message = error instanceof Error
    ? error.message
    : typeof error === "string" ? error : "";
  const summary = message.replace(/\s+/g, " ").trim().slice(0, 200);
  return summary.length > 0 ? summary : "unknown";
}

// R17-1 [지뢰 제거]: 레이트리밋 상태의 정본 필드는 `shortfallDiscoveryState` 다. 예전에는 이 상태가
// `campaigns.shortfallDiscovery` 에 얹혀 있었는데, **같은 이름을 완전히 다른 shape 이 쓴다** —
// `ProgramCampaignTargetPreparation.shortfallDiscovery`(`{triggered, runId?, candidatesFound?, ...}`,
// 이 파일 위쪽)는 준비 1회의 결과 보고다. 둘을 갈라놓는 것은 `campaignPreparationCounts` 의
// destructure strip 한 줄뿐이었고, 그 strip 이 사라지는 순간 `{triggered:false}` 가 상태를 통째로
// 덮어 → `lastEnqueuedAtIso` undefined → `Date.parse(undefined)`=NaN →
// `Number.isFinite(NaN)===false` 로 **시간 게이트와 일일 게이트가 동시에 무력화**되어 5분 스윕마다
// 발굴 잡을 쌓는다. Firestore 문서는 양쪽 다 `Record<string, unknown>` 이라 타입은 침묵한다.
// 이름을 분리해 그 결합 자체를 끊는다.
const SHORTFALL_DISCOVERY_STATE_KEYS = [
  "lastJobId",
  "lastJobRef",
  // W115-R1: floor 레인이 마지막으로 만든 잡. 활성 잡 dedup 이 레인 우선순위를 판정하는 근거다
  // (floor 잡은 shortfall 잡을 막지 않는다 — enqueueShortfallDiscoveryJob 의 dedup 주석).
  "lastFloorJobRef",
  "lastEnqueuedAtIso",
  // W58-B1: floor 레인 전용 간격 도장. 이 목록은 "이 문서가 레이트리밋 상태인가"의 판별에도 쓰이므로,
  // floor 도장만 가진 캠페인이 상태 미인정으로 게이트를 통째로 잃지 않게 함께 등록한다.
  "lastFloorEnqueuedAtIso",
  "dailyWindowStartIso",
  "dailyCount",
] as const;

/**
 * 정본 필드를 우선 읽고, 없으면 구 필드에서 이월한다(배포 직후 기존 캠페인이 게이트를 잃지 않게).
 * 구 필드는 준비 결과 보고와 이름을 공유하므로 **레이트리밋 키가 하나라도 있을 때만** 상태로
 * 인정한다 — 보고 shape 을 상태로 받아들이면 이 분리를 한 이유가 사라진다.
 */
function readShortfallDiscoveryState(campaign: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(campaign.shortfallDiscoveryState)) return campaign.shortfallDiscoveryState;
  const legacy = isRecord(campaign.shortfallDiscovery) ? campaign.shortfallDiscovery : null;
  if (legacy && SHORTFALL_DISCOVERY_STATE_KEYS.some((key) => legacy[key] !== undefined)) return legacy;
  return {};
}

// R23-1 [사용자 지시]: 풀 재고 하한. **재고는 총 문서 수가 아니다** — 발송 소스가 될 수 있는 것만
// 센다(이메일 보유 − 이미 컨택). 총 문서 수로 세면 오염 밴드(구조상 이메일이 있을 수 없는 커뮤니티
// 시그널, R17-5)와 기컨택분이 분모를 부풀려 "풀이 충분하다"는 거짓 판정이 나온다 — R23-0 이 드러낸
// "분모가 비어 있는데 소진으로 읽는" 오판과 같은 클래스다. 하한 미달이면 **이 캠페인 부족분이 0이어도**
// 수확을 큐잉한다: 발굴은 잡 생성 → 워커 → 후보 적재까지 지연이 있어 마른 뒤에 대응하면 늦다.
const CANDIDATE_POOL_FLOOR_DEFAULT = 750;
// 하한이 스캔 창보다 크면 판정이 영구 미달로 고정되므로 같은 상한을 공유한다.
const CANDIDATE_POOL_FLOOR_MAX = CAMPAIGN_TARGET_SCAN_LIMIT;

async function readCandidatePoolFloor(): Promise<number> {
  const settings = await readSettings();
  const automation = settings.automation as Record<string, unknown>;
  const configured = automation.candidatePoolFloor;
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured < 0) {
    return CANDIDATE_POOL_FLOOR_DEFAULT;
  }
  return Math.min(CANDIDATE_POOL_FLOOR_MAX, Math.round(configured));
}

type CandidatePoolInventory = {
  emailCapable: number;
  contactedByEmail: number;
  // W21 F-4: 품질 보류 등으로 blocked 된 프로그램 타깃 수. sendableEstimate 에서 차감하되, 차감 전
  // 값(emailCapable - contactedByEmail)과 구분해 남긴다.
  blockedTargets: number;
  sendableEstimate: number;
};

/**
 * R23-1: 재고 측정. 문서를 훑지 않고 **aggregate count 3회**로 끝낸다 — 여기는 5분 스윕의 임계 경로이고
 * 승인·발송 패스보다 앞에 있다. 수백~수천 문서 읽기를 붙이면 그 패스들을 막는다(같은 이유로 준비 경로가
 * suppression 평가를 상수배로 절단한다, F5②).
 *
 * BLOCKER-1 [적대적 리뷰 실측 · 원래 R23-1 설계 오류 수정]: 이 센서는 원래 전역 `candidate_pool` 을
 * 봤다("풀은 캠페인 공용"이라는 전제). 그런데 실제 액추에이터(discovery.ts persistCandidates)는 exact
 * scope(canonicalProgramId·campaignId·sourceRunId·sourceRunRef 4종 provenance)가 있으면 **오직
 * `campaign_candidates` 에만** 쓴다(candidateScope.ts buildProgramScopedCandidateParticipationWrites) —
 * `candidate_pool` 쪽 identityRef/identityData 는 계산 후 버려진다. 이 floor harvest 는 항상 exact
 * scope 로 큐잉되므로(campaignId·programId 가 이미 있는 캠페인 컨텍스트) 액추에이터는 100% 이 경로를
 * 탄다 — 센서와 액추에이터가 다른 컬렉션을 보는 제어루프였다. 실측(적대적 리뷰 프로브 F1): 수확 3건
 * 성공(candidatesWritten 3/newUnique 3) 후에도 전역 센서 델타 0 → 다음 pass 도 belowFloor:true 재확인
 * → 트리거 영구 참 + 매 통과마다 aggregate count 2회 + 잡 큐잉을 반복.
 *
 * 수리: 센서를 액추에이터가 실제로 채우는 스코프에 맞춘다 — **이 캠페인의 `campaign_candidates`**(이메일
 * 보유) 수 − **이 캠페인의 프로그램**에서 이미 컨택된 이메일 수(`program_outreach_dedup.programId`,
 * doc id 자체가 `{programId}__{creatorKey}` 라 필드가 이미 있다 — 새 필드 0). candidate_pool 쪽으로
 * 이중 쓰기를 만들어 맞추는 방향은 채택하지 않는다(candidateScope.ts 스코프 라우팅과
 * admin.ts:1013-1015 "전역 candidate_pool 직접 사용 금지" 주석을 거스른다). 프로그램 스코프(캠페인보다
 * 넓음)로 컨택 차감을 잡는 것은 의도적 편향이다 — 같은 프로그램의 다른 캠페인이 이미 컨택한 크리에이터도
 * 정확히 재차감 대상이고(프로그램 내 재컨택 방지가 dedup 의 본래 목적), 그 폭에서 혹시 과대 차감되더라도
 * "재고를 낮게 봐 더 자주 수확"이라는 안전한 편향과 같은 방향이다(아래 주석 유지) — **단, 이 논증은
 * 조회 키가 발송 경로가 실제로 쓰는 키와 일치한다는 전제에서만 성립한다** (BLOCKER-A 참고).
 *
 * BLOCKER-A [적대적 리뷰 실측 · P-H, 이 함수 최초 커밋(BLOCKER-1)의 결함]: 처음에는 조회 키를
 * resolveCanonicalProgramId 로 정규화했다 — "프로그램 스코프가 캠페인보다 넓어 과대 차감이 나와도
 * 안전한 방향"이라는 위 논증이 성립한다고 가정했기 때문이다. 그런데 발송 경로
 * (programOutreachDedup.ts resolveOutreachDedupContext·recordProgramOutreachSend) 는 canonical 화를
 * 전혀 하지 않고 campaign.programId 를 **원본 그대로** dedup 문서에 쓴다. SCP 별칭
 * (programId:"scp" ↔ canonical "pg-super-creator-partners", scpProgramAlias.ts) 캠페인은 그래서 실제
 * dedup 문서가 "scp" 로 적재되는데, 정규화된 조회는 "pg-super-creator-partners" 로 찾아 0건을 봤다 —
 * **컨택 과소 차감(정반대 방향) → 재고 과대 추정 → 수확 조기 중단**. 지금은 정규화를 걷어내고
 * dedupProgramId(campaign.programId 원본, 없으면 canonicalProgramId, 그래도 없으면 DEFAULT_PROGRAM_ID)
 * 로 발송 경로와 같은 키를 쓴다 — dedup 쓰기 자체를 canonical 로 통일하는 방향(발송 경로 수정)은 이
 * 함수의 범위를 벗어난다.
 *
 * ⚠️ 추정 오차의 **방향을 의도적으로 한쪽으로 몰았다**: dedup 의 이메일 행에는 이 캠페인의
 * campaign_candidates 에 없는 수신자(creators 직접 컨택·CSV 임포트·프로그램 내 다른 캠페인)도 섞이므로
 * 재고는 **낮게** 추정된다(조회 키가 발송 경로와 일치하는 정상 상태에서). 낮은 추정의 결과는 "발굴을
 * 더 자주 한다"이고 그 폭은 기존 레이트리밋(1시간·6/일·활성 잡 dedup)이 그대로 조인다. 반대 방향
 * (재고를 높게 보아 수확을 멈추는 것, BLOCKER-A 가 만들었던 바로 그 방향)은 R23-0 과 같은 조용한
 * 정체를 만들므로 허용하지 않는다.
 * 정밀 판정(`validEmailField`·3축 컨택 대조)은 종전대로 발송 게이트가 한다 — 이 값은 **수확 시점 판정
 * 전용**이고 발송 여부를 바꾸지 않는다.
 */
async function measureCandidatePoolInventory(campaignId: string, dedupProgramId: string): Promise<CandidatePoolInventory> {
  const [emailCapableSnapshot, contactedSnapshot, blockedTargetSnapshot] = await Promise.all([
    adminDb.collection("campaign_candidates")
      .where("campaignId", "==", campaignId)
      .where("email", ">", "")
      .count()
      .get(),
    // BLOCKER-A: dedupProgramId 는 발송 경로(programOutreachDedup.ts resolveOutreachDedupContext/
    // recordProgramOutreachSend)가 실제로 dedup 문서에 쓰는 **원본(비정규화)** programId 와 같은 키여야
    // 한다 — canonical 로 정규화하면 SCP 별칭(programId:"scp") 캠페인의 실제 dedup 기록을 못 찾는다.
    adminDb.collection("program_outreach_dedup")
      .where("programId", "==", dedupProgramId)
      .where("creatorKey", ">=", "email:")
      .where("creatorKey", "<", "email;")
      .count()
      .get(),
    // W21 F-4: 품질 보류(blockedReason 접두 `mail-quality.`)로 blocked 된 프로그램 타깃은 이번 하한
    // 판정에서 발송 가능 재고가 아니다. 이걸 차감하지 않아 프로드 주력 캠페인에서 sendableEstimate
    // 4,421 vs 실제 ready 271(약 12배 과대)로 "재고 충분" 오판을 만들었다. 동등 필터 2개짜리 count()
    // 집계 1개만 더한다 — 문서 본문은 읽지 않는다(W20 힙 OOM 의 근인이 바로 그 전체 문서 읽기였다).
    adminDb.collection(PROGRAM_CAMPAIGN_TARGETS_COLLECTION)
      .where("programId", "==", dedupProgramId)
      .where("status", "==", "blocked")
      .count()
      .get(),
  ]);
  const emailCapable = Math.max(0, Math.round(emailCapableSnapshot.data().count ?? 0));
  const contactedByEmail = Math.max(0, Math.round(contactedSnapshot.data().count ?? 0));
  const blockedTargets = Math.max(0, Math.round(blockedTargetSnapshot.data().count ?? 0));
  return {
    emailCapable,
    contactedByEmail,
    blockedTargets,
    sendableEstimate: Math.max(0, emailCapable - contactedByEmail - blockedTargets),
  };
}

/**
 * W115-R1 [Stage 1-b] — 재고 측정 + 관측 표면 영속의 **단일 지점**.
 *
 * 왜 뽑았나: 종전에는 이 로직이 `enqueueShortfallDiscoveryJob` 안에만 있었고, 그래서 **측정이
 * 큐잉 예산에 종속**됐다 — 재고가 목표에 닿아 `enqueueBudget === 0` 이 되면 스윕이 이 함수를
 * 아예 호출하지 않고, `sendableEstimate` 가 그 시점 값으로 얼어붙어 `target_reached` 가 영구화된다
 * (발송으로 재고가 실제로 줄어도 스윕은 그 사실을 볼 수 없다 — 자동 재개가 성립하지 않는 래치).
 * 측정과 큐잉은 다른 결정이므로 호출 지점도 나눈다: 스윕은 매 pass 여기를 부르고,
 * 큐잉만 예산 게이트를 통과해야 한다.
 */
async function measureAndPersistCandidatePoolInventory(
  campaignId: string,
  campaign: Record<string, unknown>,
  floor: number,
  nowMs: number,
): Promise<{ inventory: CandidatePoolInventory; inventoryShortfall: number }> {
  // BLOCKER-1: 액추에이터(discovery.ts persistCandidates)가 실제로 채우는 스코프(이 캠페인의
  // campaign_candidates)에 센서를 맞춘다 — dedupProgramId 는 program_outreach_dedup 의
  // 컨택 차감을 프로그램 스코프로 좁히는 데 쓴다(위 함수 주석).
  // BLOCKER-A [적대적 리뷰 실측 · P-H]: 이전에는 여기서 resolveCanonicalProgramId 로 정규화한
  // 값을 조회 키로 썼다 — 그런데 발송 경로(resolveOutreachDedupContext, programOutreachDedup.ts)는
  // campaign.programId 를 **정규화 없이 그대로** dedup 문서에 쓴다(recordProgramOutreachSend 도
  // 그 값을 그대로 저장). SCP 별칭 캠페인(programId:"scp", canonical:"pg-super-creator-partners",
  // scpProgramAlias.ts)은 그래서 실제 dedup 문서가 "scp" 로 적재되는데 센서는 canonical
  // "pg-super-creator-partners" 로 찾아 0건을 봤다 — 컨택 과소 차감 → 재고 과대 추정 → 수확 조기
  // 중단(원래 의도한 안전 편향의 정반대). 정규화를 걷어내고 발송 경로와 **같은 원본 키**로 조회한다.
  const dedupProgramId = stringField(campaign, "programId", stringField(campaign, "canonicalProgramId", "")) || DEFAULT_PROGRAM_ID;
  const inventory = await measureCandidatePoolInventory(campaignId, dedupProgramId);
  const inventoryShortfall = Math.max(0, floor - inventory.sendableEstimate);
  await adminDb.collection("campaigns").doc(campaignId).set({
    // 관측 표면: 하한 판정의 입력과 결과를 남긴다. 이 값이 없으면 운영자는 "왜 지금 발굴이 도는지"
    // 또는 "왜 안 도는지"를 볼 수 없다(R17-5·T4 와 같은 이유). 새 컬렉션 0 — 기존 문서에 필드로.
    candidatePoolInventory: {
      atIso: new Date(nowMs).toISOString(),
      floor,
      emailCapable: inventory.emailCapable,
      contactedByEmail: inventory.contactedByEmail,
      // W21 F-4: 기존 필드명은 그대로 두고 차감 전/후를 나란히 남긴다 — 이 수리 전후의 관측
      // 연속성을 지키면서 "무엇이 재고를 깎았는지"를 운영자가 바로 볼 수 있어야 한다.
      blockedTargets: inventory.blockedTargets,
      sendableBeforeBlocked: Math.max(0, inventory.emailCapable - inventory.contactedByEmail),
      sendableEstimate: inventory.sendableEstimate,
      belowFloor: inventoryShortfall > 0,
    },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { inventory, inventoryShortfall };
}

/**
 * W77-⑤ [R1-P0-1/2/3]: 재고 관측의 **정본 진입점**.
 *
 * 승격 스윕도 같은 숫자를 봐야 한다 — 별도 증분 원장을 굴렸다가 배선 누락으로 조용히
 * 틀렸다(리뷰 실측). 캠페인 문서에서 dedup 조회 키를 뽑는 규칙까지 여기서 정한다:
 * 그 규칙을 호출부가 복제하면 BLOCKER-A(정규화 불일치 → 컨택 과소 차감)가 그대로 재발한다.
 */
export async function measureCampaignCandidateInventory(campaignId: string): Promise<CandidatePoolInventory> {
  const campaign = (await adminDb.collection("campaigns").doc(campaignId).get()).data() ?? {};
  const dedupProgramId = stringField(campaign, "programId", stringField(campaign, "canonicalProgramId", ""))
    || DEFAULT_PROGRAM_ID;
  return measureCandidatePoolInventory(campaignId, dedupProgramId);
}

// 부족분을 캠페인 저장 키워드(targetingCriteria.includeKeywords)로 자동 enqueue 한다. 이 함수는
// 절대 throw 하지 않는다 — enqueue 실패가 refill 자체를 깨뜨리면 안 된다(호출자는 refill 이 채운
// 만큼만 반환받으면 된다).
export async function enqueueShortfallDiscoveryJob(
  campaignId: string,
  campaign: Record<string, unknown>,
  shortfall: number,
  // R23-1: 이 캠페인 부족분이 0 이어도 **풀 재고 하한**으로 수확할 수 있다. 호출부가 명시적으로 켜야만
  // 그 경로가 열린다 — 스윕이 pass 당 1건으로 제한해 측정 비용과 잡 수를 함께 조인다(호출부 주석).
  // R26-2: keywordExpansionTriggerReader 는 테스트 주입점이다(기본값은 정본
  // readRecentCompletedDiscoveryJobNewUniqueValues) — FAILED_PRECONDITION 같은 운영 전용 실패를
  // 에뮬레이터로는 재현할 수 없어, 실제 실패를 값으로 검증하려면 이 자리로 주입해야 한다.
  options: {
    allowInventoryFloorHarvest?: boolean;
    /**
     * W115-R1 [Stage 1-a]: floor 레인 전용 **캠페인 하한 상향**. 전역 재고 목표(10,000)에서
     * 역산한 값을 호출부가 넘긴다 — 기본 하한(750)만 보면 활성 캠페인이 14개 미만일 때
     * 전역 목표가 구조적으로 도달 불가다(스윕 주석 참조). shortfall 레인은 이 값을 보지 않는다.
     */
    inventoryFloorOverride?: number;
    /**
     * W115-R1 [MEDIUM]: **같은 pass 의 앞선 잡들이 이미 계획한 유닛.** 쿼터 스냅샷은 pass 안에서
     * 갱신되지 않으므로, 이걸 빼지 않으면 pass 당 3잡이 각자 잔여 전량을 약속한다(2.85× 오버커밋).
     */
    reservedUnits?: number;
    /**
     * W115-R1 [Stage 1-b]: 재고 **측정만** 하고 큐잉은 하지 않는다. 목표 도달 상태에서도 센서가
     * 계속 돌아야 재고 감소를 볼 수 있다 — 큐잉 예산에 측정을 매달면 래치가 걸린다.
     */
    measureOnly?: boolean;
    keywordExpansionTriggerReader?: typeof readRecentCompletedDiscoveryJobNewUniqueValues;
    keywordExpansionSettingsReader?: typeof readSettings;
    keywordExpansionSuggestor?: typeof suggestKeywordsViaLlm;
  } = {},
  // HIGH [적대적 리뷰 실측 · 3라운드]: 호출부(라운드로빈 선택 루프)가 "측정을 실제로 수행했는지"를
  // 알아야 한다 — 레이트리밋 3종(활성 잡 dedup·1시간 간격·일일 6건)이 재고 측정보다 먼저 조기
  // return 하면 candidatePoolInventory.atIso 가 갱신되지 않고, 그 캠페인은 영구히 "가장 오래전에
  // 측정됨"으로 남아 매 pass 라운드로빈 선택을 독점한다(실측: T2 활성 잡 보유·T3 dailyCount=6 각각
  // 3 pass 연속 재현 — 최오래된 A 뿐 아니라 B 도 inventory null, 기아 재발). measured 는 정확히
  // "measureCandidatePoolInventory 가 호출되고 그 결과가 Firestore 에 성공적으로 쓰였는지"를 뜻한다.
  //
  // HIGH [적대적 리뷰 4라운드 · 실측 A2]: blockedGlobally 는 "이번 pass 전체가 막힌 전역 사유
  // (쿼터 소진)로 return 했는지"를 뜻한다 — per-campaign 게이트(활성 잡·1시간 간격)와 구분해야 한다.
  // 폴스루 루프가 measured:false 를 "이 후보만 안 됐다, 다음 후보를 보자"로 해석하면, 전역 사유일 때
  // 후보 전원이 같은 이유로 막히므로 **후보 수만큼 같은 쿼터 계측+캠페인 쓰기를 반복**한다(실측: floor
  // 후보 3+전 키 소진 → 계측 3회, shortfallDiscoveryQuota 쓰기 3회, measured 0/3 — N=20 이면 소진일
  // 23,040 reads + 5,760 writes/일 증폭). blockedGlobally:true 를 받으면 호출부는 다음 후보로
  // 폴스루하지 않고 루프를 즉시 멈춘다 — 그래서 쿼터 계측·쓰기가 pass 당 정확히 1회로 조여진다.
  //
  // W115-R1 [HIGH 4 · 적대 리뷰]: `enqueued` 는 "이 호출이 실제로 잡을 큐에 넣었는가"다.
  // 종전 호출부(재고 스윕)는 `measured` 를 큐잉 성공으로 읽어 예산을 깎았다 — 측정은 성공하고
  // 큐잉은 게이트에 막힌 pass 에서 예산이 헛되이 소진돼, 실제로 잡을 넣을 수 있는 뒤 후보가
  // 굶었다. 두 사건은 독립이므로 축을 나눈다. `plannedUnits` 는 이번 잡이 태우기로 계획한 유닛
  // (저비용 예약분 + 검색 콜)이며, 같은 pass 의 다음 잡이 쿼터에서 빼야 하는 값이다(MEDIUM).
): Promise<{ measured: boolean; enqueued: boolean; blockedGlobally?: boolean; blockedByCampaignGate?: boolean; plannedUnits?: number }> {
  if (shortfall <= 0 && options.allowInventoryFloorHarvest !== true) return { measured: false, enqueued: false };

  // ── W115-R1 [Stage 1-b]: 측정 전용 호출은 **어떤 큐잉 게이트도 타지 않는다** ──────────────────
  //   아래 게이트들(키워드 우주 공백 · 활성 잡 dedup · 레인 간격 · 쿼터 소진 · 슬라이스 쿨다운)은
  //   전부 "지금 이 캠페인에 잡을 넣어도 되는가"의 판정이다. 재고 측정은 count() 집계 3회일 뿐
  //   YouTube 유닛을 한 개도 안 쓰므로 그 판정에 걸릴 이유가 없다 — 그런데 종전 배치에서는
  //   측정이 그 게이트들 **뒤**에 있어, 쿼터가 마른 날·활성 잡을 든 캠페인·검색어가 없는 캠페인이
  //   전부 측정에서 빠졌다. 그러면 `sendableEstimate` 가 얼어붙어 재고 스윕이 옛 값을 계속 읽고,
  //   발송으로 재고가 줄어도 그 사실을 못 본다(Stage 1-b 래치가 원인만 바꿔 되돌아오는 형상).
  //   여기서 끝내면 키워드 우주 해석(프로그램 폴백 읽기 포함)조차 하지 않아 측정 비용도 최소다.
  if (options.measureOnly === true) {
    try {
      const baseFloor = await readCandidatePoolFloor();
      const floor = Math.max(baseFloor, Math.max(0, Math.trunc(options.inventoryFloorOverride ?? 0)));
      await measureAndPersistCandidatePoolInventory(campaignId, campaign, floor, Date.now());
      return { measured: true, enqueued: false };
    } catch (error) {
      console.warn("[campaign-shortfall-discovery] inventory measurement failed", {
        campaignId,
        errorCode: errorCodeForLog(error),
      });
      return { measured: false, enqueued: false };
    }
  }

  const targetingCriteria = isRecord(campaign.targetingCriteria) ? campaign.targetingCriteria : {};
  // W60-1 [리더 판정 2026-08-09 — C2 키워드 정본 확정]
  //
  // 판정: **캠페인 우선**이 정본이다. discovery.ts 의 resolveProgramDiscoveryCriteria 가
  // authoritative resolver 이고(이름 그대로), 발굴 기준이 이미 그 우선순위로 동작한다.
  // 근거: 캠페인 소유 타게팅이 프로그램/타게팅 별칭보다 우선 — 두 소스가 모두 있으면 캠페인 값.
  //
  // 이력(같은 자리를 세 번 고쳤다 — 다시 흔들지 않도록 남긴다):
  //   · W59c-C2: 별칭을 **선택 체인**에 끼워 공백 오판을 고쳤다 → 특정 조합에서 선택이 뒤집혔다.
  //   · W59d-F7: 선택 체인을 종전(타게팅 우선·별칭 없음)으로 되돌리고 별칭은 **공백 판정 전용**으로
  //     분리했다 → 오판은 막혔지만 별칭-온리 캠페인이 검색 우주 0 으로 스킵되는 부수효과가 남았다.
  //   · W60-1(지금): 리더 판정으로 **우선순위까지** resolver 에 정렬한다. 그러면 선택 체인 하나로
  //     공백 판정도 동시에 해결되고(집합이 같으므로), 별칭-온리 캠페인이 정상 검색된다 —
  //     W59d-F7 이 만든 harvest_keyword_universe_alias_only 상태는 **구조적으로 사라진다**.
  //
  // 소스와 순서는 resolver(discovery.ts `criteriaArray`)의 캠페인/타게팅 구간과 정확히 같다.
  // programDefaults 는 여기서 쓰지 않는다 — 프로그램 폴백은 아래 W59-3 경로가 별도 게이트(로그·사유
  // 기록·1시간 스로틀)를 달고 처리한다.
  //
  // W60c-B [Codex 평결 · 실코드 확정 후 재정합]: 종전 이 자리는 `.find((v) => v.length > 0)` 로
  //   **첫 non-empty 승**이었다. 그런데 resolver 의 실의미론은 **첫 소유 배열 승**이다 —
  //   `campaign.includeKeywords: []` 는 "비었으니 다음 소스"가 아니라 **"검색어 0 개"** 로 확정된다
  //   (discovery.ts resolveOwnedCriteriaKeywords 주석에 값 사슬을 적어 뒀다).
  //   갈리는 픽스처가 실재한다: root `includeKeywords: []` + `keywords: ["a"]` 이면 정본은 발굴을
  //   하지 않는데 이 자리는 ["a"] 로 수확을 걸었다 — **정본이 쓰지 않는 키워드로 수확**하는 잠복
  //   결함이다. 지금은 UI 가 두 필드를 함께 저장해 가려져 있을 뿐이고, 운영자가 캠페인 키워드를
  //   의도적으로 비우는 순간(= "이 캠페인은 발굴 중단") 수확기만 계속 도는 형상이 된다.
  //   주석으로 "맞춰 두라"고 적는 대신 **resolver 의 함수를 그대로 호출**한다 — 한쪽만 바뀌는 일이
  //   구조적으로 불가능해진다(뮤테이션도 이 결합을 통해 양쪽에 동시에 red 를 만든다).
  const baseKeywords = resolveOwnedCriteriaKeywords([
    { record: campaign, keys: ["includeKeywords", "keywords"] },
    { record: targetingCriteria, keys: ["includeKeywords", "keywords"] },
  ]);
  // R23-2a: 키워드 우주 확장. 회전 대상은 includeKeywords ∪ targetingCriteria.expandedKeywords
  // (운영자가 캠페인에 직접 심는 신규 필드) — 이 세션은 **읽기만** 한다, 시드는 리더가 운영 쓰기로
  // 한다. 합집합이므로 기존 includeKeywords 회전은 그대로 유지되고 우주만 넓어진다. 필드가 없으면
  // stringArrayField 가 빈 배열을 반환해 종전과 동일하게 동작한다(하위 호환).
  // R24: 총량 상한(60)까지 읽어야 한다 — 40 으로 읽으면 저장은 60까지 해도 다음 pass 의 읽기에서
  // 뒤쪽이 잘려 나가 총량 상한 자체가 조용히 40으로 무력화된다(위 SHORTFALL_KEYWORD_EXPANSION_UNIVERSE_MAX
  // 주석).
  // R26-1: 검색에 실제로 쓰이는 우주(`keywords`)는 더 이상 40으로 자르지 않는다 — base+expanded 두
  // 상한의 합(SHORTFALL_HARVEST_KEYWORD_UNIVERSE_CAP)까지 무손실로 수용한다(BLOCKER-1, 위 상수
  // 블록 주석).
  const expandedKeywords = stringArrayField(targetingCriteria.expandedKeywords, SHORTFALL_KEYWORD_EXPANSION_UNIVERSE_MAX);
  let keywords = resolveShortfallHarvestKeywordUniverse(baseKeywords, expandedKeywords);
  // W59-3 [리더 확정 의미론]: 캠페인 키워드가 **완전히 비어 있을 때만** 프로그램 키워드
  // (programs/<id>.candidateCriteria.keywords)로 폴백한다. 캠페인 키워드가 하나라도 있으면 절대
  // 덮지 않는다 — 운영자가 좁힌 타게팅을 프로그램 기본값이 넓히면 그건 조용한 타게팅 변경이다.
  // 폴백은 오직 "아무 검색어도 없어 이 캠페인만 영원히 재고가 안 느는" 상태(W58-B2 가 사유 기록만
  // 남기고 넘어가던 그 상태)를 여는 용도다. 캠페인 문서의 programId 는 dedup 원장이 쓰는 것과 같은
  // **비정규화** 값을 쓴다(admin.ts:7973 과 같은 근거 — canonical 로 정규화하면 별칭 캠페인이 어긋난다).
  let keywordFallbackProgramId = "";
  // W59c-m1 [독립 리뷰 · 권장]: 폴백이 **실패하는** 캠페인(프로그램 키워드도 비었거나 문서 없음)은
  // 5분 pass 마다 programs 문서를 다시 읽어 하루 288회 읽기를 만든다. 그 결과는 프로그램 문서를
  // 고쳐야만 바뀌므로 W59-5 스킵 기록과 **같은 신선도 창**에 묶는다 — 창 안이면 지난 pass 의 결론
  // ("검색어 없음")을 그대로 쓰고 읽기를 건너뛴다. 프로그램에 키워드가 새로 심기면 최대 1시간 뒤
  // 반영되는데, 이 레인의 enqueue 간격 게이트 자체가 1시간이라 실질 지연은 없다.
  const priorSkipRecord = isRecord(campaign.shortfallDiscoverySkip) ? campaign.shortfallDiscoverySkip : {};
  const priorSkipReasonCode = stringField(priorSkipRecord, "reasonCode", "");
  const priorSkipAtMs = Date.parse(stringField(priorSkipRecord, "atIso", ""));
  const skipRecordFresh = priorSkipReasonCode === "harvest_keyword_universe_empty"
    && Number.isFinite(priorSkipAtMs)
    && Date.now() - priorSkipAtMs < SHORTFALL_DISCOVERY_SKIP_RECORD_THROTTLE_MS;
  // W60-1: 선택 체인이 resolver 와 같은 소스 집합을 쓰므로 `keywords.length === 0` 자체가
  // "어떤 별칭에도 캠페인 키워드가 없다"와 동치다 — 별도의 공백 판정 축(W59d-F7 의
  // hasAnyCampaignKeyword)은 이제 항상 같은 값이라 죽은 조건이다. 조건을 하나로 되돌린다.
  if (keywords.length === 0 && !skipRecordFresh) {
    const programId = stringField(campaign, "programId", stringField(campaign, "canonicalProgramId", ""));
    if (programId) {
      try {
        const programSnapshot = await adminDb.collection("programs").doc(programId).get();
        const programData = programSnapshot.data();
        const candidateCriteria = isRecord(programData) && isRecord(programData.candidateCriteria)
          ? programData.candidateCriteria
          : {};
        const programKeywords = stringArrayField(
          candidateCriteria.keywords,
          SHORTFALL_KEYWORD_EXPANSION_UNIVERSE_MAX,
        );
        if (programKeywords.length > 0) {
          keywords = resolveShortfallHarvestKeywordUniverse(programKeywords, []);
          keywordFallbackProgramId = programId;
        }
      } catch (error) {
        // 폴백 조회 실패는 종전 동작(무키워드 스킵)으로 떨어진다 — 발굴을 막지 않고 아래 사유 기록이 남는다.
        console.warn("[campaign-shortfall-discovery] program keyword fallback read failed", {
          campaignId,
          programId,
          errorCode: errorCodeForLog(error),
        });
      }
    }
  }
  if (keywordFallbackProgramId) {
    console.info("[campaign-shortfall-discovery] using program keyword fallback", {
      campaignId,
      programId: keywordFallbackProgramId,
      keywords: keywords.length,
    });
    // 정합: 폴백이 성공했으면 "키워드 우주가 비었다"는 스킵 기록은 더 이상 사실이 아니다. 남겨 두면
    // 운영자가 화면에서 해소된 사유를 계속 본다. 아래 enqueue 까지 못 가고 다른 게이트에 막히는
    // pass 도 있으므로 정상 enqueue 경로의 해소(Δ3)에만 맡기지 않는다.
    // 마커가 실제로 그 사유로 남아 있을 때만 쓴다 — 매 pass 무조건 쓰기를 만들지 않는다.
    const priorSkip = isRecord(campaign.shortfallDiscoverySkip) ? campaign.shortfallDiscoverySkip : null;
    if (stringField(priorSkip ?? {}, "reasonCode", "") === "harvest_keyword_universe_empty") {
      try {
        await adminDb.collection("campaigns").doc(campaignId).set({
          shortfallDiscoverySkip: FieldValue.delete(),
        }, { merge: true });
      } catch (error) {
        console.warn("[campaign-shortfall-discovery] skip reason clear failed", {
          campaignId,
          errorCode: errorCodeForLog(error),
        });
      }
    }
  }
  // 검색어가 전혀 없으면 일반어로 전역 풀을 오염시키는 대신 넘어간다 — 그 판단 자체는 유지한다.
  //
  // W58-B2 [Codex 적대 리뷰]: 다만 **무음 반환은 금지**다. 매 5분 pass 마다 아무 기록 없이 돌아가면
  // 운영자는 "왜 이 캠페인만 영원히 재고가 안 늘지"를 화면에서도 로그에서도 볼 수 없다(오늘 정체
  // 진단이 코드 읽기로 내려간 것과 같은 형상). 사유를 캠페인 문서에 남기고 로그도 한 줄 남긴다.
  //
  // W59-5: 그 쓰기를 **1시간 스로틀**한다. W58-B2 는 "atIso 가 갱신돼야 지금도 그 상태인지 보인다"는
  // 이유로 매 pass merge 했는데, 이 사유는 캠페인 문서를 고쳐야만 바뀌는 **정적 상태**다. 5분 pass 로
  // 하루 288회 쓰기를 만들면서 신선도는 시간 단위면 충분하다(발굴 간격 게이트 자체가 1시간이다).
  // 사유가 바뀌면 스로틀과 무관하게 즉시 쓴다 — 신선도가 실제로 의미 있는 유일한 경우다.
  if (keywords.length === 0) {
    // W60-1: 별칭-온리 상태(W59d-F7 의 harvest_keyword_universe_alias_only)는 우선순위 정렬로
    // **구조적으로 사라졌다** — 별칭도 선택 체인에 있으므로 그 캠페인은 이제 정상 검색된다.
    // 도달 불가가 된 분기를 남기지 않는다(사유 코드가 두 갈래인 척하면 운영자가 없는 상태를 찾는다).
    const skipReasonCode = "harvest_keyword_universe_empty";
    // W59c-m1: 신선도 판정은 위(폴백 읽기 게이트)에서 이미 한 번 계산했다 — 같은 pass 안에서 두 번
    // 계산하면 두 값이 갈릴 수 있고(경계 시각), 그때 "읽기는 건너뛰었는데 쓰기는 했다" 같은
    // 비대칭이 생긴다. 하나의 값을 공유한다.
    if (!skipRecordFresh) {
      try {
        await adminDb.collection("campaigns").doc(campaignId).set({
          shortfallDiscoverySkip: {
            reasonCode: skipReasonCode,
            atIso: nowIso(),
            baseKeywords: baseKeywords.length,
            expandedKeywords: expandedKeywords.length,
          },
        }, { merge: true });
      } catch (error) {
        console.warn("[campaign-shortfall-discovery] skip reason persist failed", {
          campaignId,
          errorCode: errorCodeForLog(error),
        });
      }
    }
    console.warn("[campaign-shortfall-discovery] skipped: harvest keyword universe is empty", {
      campaignId,
      reasonCode: skipReasonCode,
      baseKeywords: baseKeywords.length,
      expandedKeywords: expandedKeywords.length,
      skipRecordThrottled: skipRecordFresh,
    });
    return { measured: false, enqueued: false };
  }

  // 이 시점부터 아래 try 안에서 measureCandidatePoolInventory 가 호출되고 그 Firestore 쓰기가
  // 성공하면 true 로 뒤집는다 — 그 뒤 무슨 이유로 return 하든(쿨다운·쿼터 소진·성공·예외) 이 값을
  // 그대로 들고 나간다.
  let measured = false;
  // W115-R1 [HIGH 4]: 큐잉 성공은 측정 성공과 **다른 사건**이다. 아래 상태 쓰기까지 끝난 지점에서만
  //   true 가 된다 — 그 전 어떤 게이트에서 돌아가든 false 다.
  let enqueued = false;
  // W115-R1 [MEDIUM]: 같은 pass 의 다음 잡이 쿼터에서 뺄 계획 유닛. 큐잉에 실패하면 0 이다.
  let plannedUnits = 0;

  try {
    const state = readShortfallDiscoveryState(campaign);
    const nowMs = Date.now();

    // R17-3②: 아래 캠페인 문서 쓰기(레이트리밋 상태)는 queueYtDlpDiscovery 와 **비원자적**이다.
    // 잡은 만들어졌는데 그 쓰기가 실패하면 다음 sweep 은 `state.lastJobRef` 라는 근거를 잃고 같은
    // 캠페인에 잡을 하나 더 넣는다. `ytDlpWorkflow.jobRef` 는 discovery.ts 가 **잡 문서와 같은
    // batch** 로 쓰므로 잡 생성과 원자적이다 — 상태가 유실돼도 남는 2차 근거로 함께 본다.
    // (사람이 수동으로 건 잡도 여기 잡히지만, 그 경우에도 "이 캠페인 발굴이 이미 진행 중"이므로
    // 스킵이 맞다 — 기존 dedup 의 의도와 같은 방향이다.)
    const ytDlpWorkflow = isRecord(campaign.ytDlpWorkflow) ? campaign.ytDlpWorkflow : {};
    const lastJobRefPath = typeof state.lastJobRef === "string" ? state.lastJobRef : "";
    // W115-R1 [MEDIUM · 적대 리뷰 — floor↔shortfall dedup 간섭]
    //   활성 잡 dedup 은 **레인 공유**다(W58-B1 이 의도적으로 그렇게 뒀다 — 동시 실행 자원 가드).
    //   그런데 30분 재고 스윕이 pass 당 3잡을 넣기 시작하면서, floor 레인 잡이 큐에 떠 있는 동안
    //   그 캠페인의 **부족분(shortfall) 잡이 통째로 막힌다**. 두 레인의 우선순위는 같지 않다:
    //   부족분은 이 캠페인의 확정된 목표이고 floor 는 전역 재고 보충이다.
    //   그래서 shortfall 레인은 **floor 레인이 만든 활성 잡을 사유로 스킵하지 않는다**.
    //   반대 방향(floor 가 shortfall 잡에 막히는 것)은 그대로 둔다 — 그게 우선순위다.
    const floorLane = shortfall <= 0;
    let inventoryShortfall = 0;
    const measureFloorInventoryIfNeeded = async (): Promise<void> => {
      if (!floorLane || measured) return;
      // Task71: per-campaign gates (active job / MIN_INTERVAL) must not leave the
      // candidate-pool sensor stale. Keep this cheap aggregate measurement separate
      // from enqueue state: no rate-limit stamp and no discovery job are written here.
      const baseFloor = await readCandidatePoolFloor();
      const floor = Math.max(baseFloor, Math.max(0, Math.trunc(options.inventoryFloorOverride ?? 0)));
      const measurement = await measureAndPersistCandidatePoolInventory(campaignId, campaign, floor, nowMs);
      inventoryShortfall = measurement.inventoryShortfall;
      measured = true;
    };
    const lastFloorJobRefPath = typeof state.lastFloorJobRef === "string" ? state.lastFloorJobRef : "";
    const dedupJobRefs = [
      lastJobRefPath,
      typeof ytDlpWorkflow.jobRef === "string" ? ytDlpWorkflow.jobRef : "",
    ].filter((refPath, index, all) => refPath.length > 0 && all.indexOf(refPath) === index);
    // R27: 이 루프가 어차피 state.lastJobRef 문서를 읽으므로, 그 결과를 아래 밴딧 EWMA 갱신에
    // 재사용한다(추가 읽기 0) — lastJobRefPath 가 dedupJobRefs 안에 있을 때만 채워진다.
    let lastJobData: Record<string, unknown> | undefined;
    for (const jobRefPath of dedupJobRefs) {
      const jobSnapshot = await adminDb.doc(jobRefPath).get();
      const jobData = jobSnapshot.data();
      if (jobRefPath === lastJobRefPath) lastJobData = jobData;
      const jobStatus = typeof jobData?.status === "string" ? jobData.status : "";
      // 중복 방지: 같은 캠페인의 직전 잡이 아직 대기/진행 중이면 새 잡을 넣지 않는다.
      // 단 위 주석의 우선순위 규칙 — floor 레인 잡은 shortfall 레인을 막지 않는다.
      // (문서 읽기 자체는 건너뛰지 않는다: 아래 밴딧 원장이 이 잡의 관측을 재사용한다.)
      if (SHORTFALL_DISCOVERY_ACTIVE_JOB_STATUSES.has(jobStatus)
        && (floorLane || jobRefPath !== lastFloorJobRefPath)) {
        await measureFloorInventoryIfNeeded();
        return { measured, enqueued: false, blockedByCampaignGate: true };
      }
    }

    // W58-B1 [Codex 적대 리뷰]: 간격 게이트를 **레인별로** 나눈다.
    // 종전에는 shortfall 레인(캠페인 스코프 부족분)과 floor 레인(풀 전역 하한 수확)이 같은
    // `lastEnqueuedAtIso` 하나를 공유했다. 리필이 매 pass shortfall 잡을 넣으면 그 도장이 계속
    // 갱신돼 floor 레인이 **1시간 게이트에 영구 기아**가 된다 — 헤세 확정 "항시 1만"의 실행 경로가
    // 캠페인 부족분 레인에 선점당하는 구조다(W58-2 로 센서를 살려도 여기서 다시 막힌다).
    // 레인마다 자기 도장을 쓰면 서로를 굶기지 않는다. 활성 잡 dedup 은 **공유 유지**한다 — 그건
    // 간격이 아니라 동시 실행 자원 가드이고, 잡은 분 단위로 끝나 영구 기아를 만들지 않는다.
    const lastEnqueuedFieldName = options.allowInventoryFloorHarvest === true
      ? "lastFloorEnqueuedAtIso"
      : "lastEnqueuedAtIso";
    const lastEnqueuedAtRaw = state[lastEnqueuedFieldName];
    const lastEnqueuedAtMs = typeof lastEnqueuedAtRaw === "string" ? Date.parse(lastEnqueuedAtRaw) : NaN;
    if (Number.isFinite(lastEnqueuedAtMs) && nowMs - lastEnqueuedAtMs < SHORTFALL_DISCOVERY_MIN_INTERVAL_MS) {
      await measureFloorInventoryIfNeeded();
      return { measured, enqueued: false, blockedByCampaignGate: true };
    }

    const dailyWindowStartMs = typeof state.dailyWindowStartIso === "string" ? Date.parse(state.dailyWindowStartIso) : NaN;
    const dailyWindowFresh = Number.isFinite(dailyWindowStartMs) && nowMs - dailyWindowStartMs < SHORTFALL_DISCOVERY_DAY_MS;
    // R23-5 [18차 릴리스 운영 실측]: dailyCount 는 이제 관측 전용이다(필드 제거 금지 — 기존 문서·
    // 모니터가 읽는다) — 아래에서 여전히 롤·증가시키지만 더 이상 게이트로 쓰지 않는다. 운영 실측:
    // 배포일 4/6 소진, 그런데 쿼터는 절반 이상 남아 있었다 — 스루풋 상한이 엔진 품질이 아니라 이
    // 잡-개수 상한이었다(엔진은 이미 신 코드로 키워드 12개를 실어 정상 작동 확인됨, HIGH-1).
    const dailyCount = dailyWindowFresh ? Math.max(0, numberField(state, "dailyCount", 0)) : 0;

    // R23-5: dailyCount>=6 게이트를 잔여 유닛 게이트로 대체한다 — R21-3 이 이미 쓰는 잔여 추정
    // helper(youtubeDiscoveryQuotaBudget)를 그대로 재사용한다(새 계측 없음). 이 계측은 원래 이 함수
    // 아래쪽(잡 크기 산정 직전)에서 한 번 더 했었는데, 그 자리를 여기로 옮기고 그 결과를
    // (quota/quotaSlotCount/nowIso) 그대로 들고 내려가 재사용한다 — 계측은 여전히 pass 당 이
    // 함수 호출 1회에 대해 한 번뿐이다. 키를 해석할 수 없는 환경(에뮬·시크릿 미바인딩)에서는
    // quotaSlotCount===0 → quota===null → 아래 게이트가 적용되지 않는다(기존 예외와 동일 — 깨면
    // 발굴이 쿼터와 무관한 이유로 전면 정지한다, 기존 가드 9건이 그것을 잡는다).
    // Flu/W2 (Codex 적대 리뷰 HIGH-2 수리): 이 게이트/사이징은 growth 전용 원장 기준이다 — org 가
    // 비-growth 풀(예: T049→drama_1)에 매핑됐으면 growth 잔여와 무관하므로 적용하지 않는다(quota
    // null과 동일 폴백 — 위 주석의 "키를 해석할 수 없는 환경" 예외와 같은 경로). growth(매핑 없음)
    // 캠페인은 stringField 가 빈 문자열을 돌려주는 즉시 아래를 건너뛰어 종전과 완전히 동일하다.
    const campaignOwnerOrgIdForQuotaGate = campaignOwnerOrgIdAlias(campaign);
    const campaignYoutubePoolId = campaignOwnerOrgIdForQuotaGate
      ? await resolvePoolIdForOrg(campaignOwnerOrgIdForQuotaGate)
      : YOUTUBE_GROWTH_POOL_ID;
    const campaignUsesNonGrowthYoutubePool = campaignYoutubePoolId !== YOUTUBE_GROWTH_POOL_ID;
    const quotaSlotCount = campaignUsesNonGrowthYoutubePool ? 0 : youtubeApiKeyCount();
    const quota = quotaSlotCount > 0
      ? await youtubeDiscoveryQuotaBudget({ slotCount: quotaSlotCount })
      : null;
    const nowIso = new Date(nowMs).toISOString();
    // R23-5 [리뷰어 반증 교훈]: 잡 "개수"가 아니라 "유닛"으로 게이트한다 — 첫 스펙(상한 6→24)은
    // 24×2,000유닛(floor-harvest 잡 크기 실측) = 48k > 가용 38k 로 반증됐다. 유닛 게이트는 잡 수와
    // 무관하게 예산이 마르면 서고, 남으면 돈다. quota.exhausted 는 youtubeDiscoveryQuotaBudget 이
    // 이미 주 키 예약(slot0 2,000, YOUTUBE_TRACKING_RESERVED_UNITS)을 반영해 계산한 값이다 — 별도
    // 예비 상수를 새로 만들지 않고 그 판정을 그대로 예비 임계로 쓴다("잔여 > 예비 임계" ≡
    // "!exhausted", exhausted 는 remainingUnits 가 한 페이지(100유닛) 미만일 때 참이다).
    if (quota?.exhausted) {
      await adminDb.collection("campaigns").doc(campaignId).set({
        shortfallDiscoveryQuota: {
          atIso: nowIso,
          state: "waiting_for_reset",
          remainingUnitsEstimate: quota.remainingUnits,
          nextResetIso: quota.nextResetIso,
        },
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      // HIGH(4라운드): 쿼터 소진은 이 캠페인만의 사정이 아니라 **모든 캠페인이 공유하는 전역 사유**다
      // (같은 api_usage 문서). 라운드로빈 폴스루 루프에 그 사실을 알려 다음 후보로 넘어가지 않고
      // 즉시 멈추게 한다 — 안 그러면 후보 전원이 같은 이유로 막혀 같은 계측·쓰기를 반복한다.
      return { measured, enqueued: false, blockedGlobally: true };
    }
    // MEDIUM-1 [적대적 리뷰 4라운드 실측]: quota===null(키 미해석 환경)이면 위 유닛 게이트가 통째로
    // 적용되지 않는다 — 의도된 fail-open 이지만, 지금 이 경로에 개수 천장이 없다(실측: 10회 연속
    // 시도 10잡). 에뮬·시크릿 미바인딩은 **시크릿 바인딩이 풀린 운영과 같은 코드 경로**이므로 그
    // 상태에서 무제한 큐잉은 실제 장애 시나리오다. 유닛 게이트가 적용되는 정상 환경(quota!==null)은
    // 이 백스톱과 무관하다 — fail-open 경로의 폭주만 막는다. 기존 dailyCount 관측 필드를 그대로
    // 재사용한다(새 상태 0) — 캠페인별 값이라 다른 캠페인은 계속 폴스루 가능하다(전역 사유 아님).
    if (!quota && dailyCount >= SHORTFALL_DISCOVERY_DAILY_COUNT_BACKSTOP) return { measured, enqueued: false };

    // ---- R24 phase 1: 키워드 우주 자가확장/자가수축 트리거 판정 (harvestKeywords 계산 이전) ----
    // shortfall 레인(이 캠페인의 실제 미달 목표) 전용 스코프다 — floor 레인(재고 하한 최적화,
    // shortfall<=0)은 확장/수축 범위 밖으로 명시적으로 남긴다(코디네이터 트리거 조건 자체가
    // "shortfall > 0"). 이 지점은 이미 위 quota?.exhausted 조기 return 을 통과한 뒤다 — "쿼터
    // 비소진" 트리거 조건은 이 위치 자체로 구조적으로 만족되므로 별도 런타임 체크를 반복하지 않는다.
    const queryLedger = isRecord(state.queryLedger) ? state.queryLedger : {};
    const keywordExpansionState = isRecord(state.keywordExpansion) ? state.keywordExpansion : {};
    // HIGH-2: sliceMembership 값 shape 이 string(마지막 소속 해시 1개)에서 string[](최근 소속 해시
    // 누적, 중복 제거)로 바뀌었다 — "서로 다른 슬라이스 ≥2 에서 죽음" 판정의 근거(위 상수 블록·
    // pruneDeadExpandedKeywords 주석). 옛 string 값이 저장돼 있어도(배포 전 전환) 아래 phase 2 의
    // Array.isArray 가드가 안전하게 빈 배열로 취급한다(크래시 없음, 그냥 증거가 없다고 본다).
    const priorSliceMembership = isRecord(keywordExpansionState.sliceMembership)
      ? keywordExpansionState.sliceMembership as Record<string, unknown>
      : {};
    const priorExpansionEvents = Array.isArray(keywordExpansionState.events) ? keywordExpansionState.events : [];
    // R26-5 [MEDIUM-2 적대적 리뷰 실측]: 감사 링(events)은 최근 RING_SIZE(20)건만 순환 보관한다 —
    // 오래된 캠페인이 링을 여러 번 채우면 어떤 기계 추가 키워드의 원래 "mined" 이벤트가 밀려나
    // 사라질 수 있다. 그 순간 gate①(machineAddedKeywordsFromEvents)이 그 키워드를 "운영자 시드"로
    // 오판해 영구 가지치기 불가가 된다(링 밖 = 이력 없음 = 무조건 생존). 링을 넘겨도 유지되는 durable
    // 목록(keywordExpansion.machineAddedKeywords, additive)을 정본으로 삼고 링은 감사 전용으로
    // 강등한다 — 링 판정도 union 으로 함께 두는 이유는 이 필드가 아직 없는(배포 전) 기존 캠페인
    // 문서에서도 최근 이력만큼은 그대로 동작하게 하기 위해서다(필드가 한 번이라도 쓰이고 나면 다음
    // pass 부터 이 union 은 durable 목록과 사실상 같아진다).
    const priorMachineAddedKeywords = Array.isArray(keywordExpansionState.machineAddedKeywords)
      ? keywordExpansionState.machineAddedKeywords.filter((keyword): keyword is string => typeof keyword === "string")
      : [];
    const machineAddedKeywords = new Set([
      ...priorMachineAddedKeywords,
      ...machineAddedKeywordsFromEvents(priorExpansionEvents),
    ]);
    // R26-4 [MEDIUM-1 적대적 리뷰 실측]: SHORTFALL_KEYWORD_EXPANSION_DAILY_CAP(8)은 "일 8"이 아니라
    // "pass 당 8"이었다 — 이 pass 자체는 1시간 간격 게이트(위)에 걸려 있을 뿐 별도의 24시간 창이
    // 없어서, 시간당 트리거될 때마다 다시 최대 8개까지 추가할 수 있었다(하루 최대 24 pass × 8 =
    // 192). 발굴 잡의 dailyWindowStartIso/dailyCount 롤링 24h 창(위 R23-5)과 같은 방식으로 이 확장
    // 전용 창을 keywordExpansion 하위에 별도로(additive) 둔다 — 잡 개수 관측용 카운터와 의미가
    // 달라 같은 필드를 재사용하면 두 축이 섞인다.
    const priorExpansionDailyWindowStartIso = typeof keywordExpansionState.dailyWindowStartIso === "string"
      ? keywordExpansionState.dailyWindowStartIso
      : null;
    const priorExpansionDailyWindowStartMs = priorExpansionDailyWindowStartIso
      ? Date.parse(priorExpansionDailyWindowStartIso)
      : NaN;
    const expansionDailyWindowFresh = Number.isFinite(priorExpansionDailyWindowStartMs)
      && nowMs - priorExpansionDailyWindowStartMs < SHORTFALL_DISCOVERY_DAY_MS;
    const priorExpansionDailyCount = expansionDailyWindowFresh
      ? Math.max(0, numberField(keywordExpansionState, "dailyCount", 0))
      : 0;
    let expansionMinedKeywords: string[] = [];
    let expansionPrunedKeywords: string[] = [];
    let expansionNextExpandedKeywords: string[] | null = null; // non-null 이면 이번 pass 에 우주가 바뀐 것
    let expansionNextMachineAddedKeywords: string[] = priorMachineAddedKeywords;
    let expansionTriggerCheckSkipReason: string | null = null;
    // R30 [사용자 승인]: 키워드 코퍼스 원장(캠페인 문서 안 additive 맵 — 새 컬렉션 0)과 LLM 전용
    // 일일 호출 카운터. 마이닝 일일 상한(dailyCount = 채택 **개수** 축)과 다른 축이라 따로 센다.
    const priorKeywordCorpus = readKeywordCorpus(state.keywordCorpus, nowIso);
    const expansionLlmDailyCallCount = expansionDailyWindowFresh
      ? Math.max(0, numberField(keywordExpansionState, "llmDailyCallCount", 0))
      : 0;
    let expansionLlmKeywords: string[] = [];
    // W90: 퇴역 사유를 축별로 나눠 들고 있다가 코퍼스에 각자 사유로 남긴다("왜 죽었나"가 원장의 값이다).
    let expansionFilterRetiredKeywords: string[] = [];
    let expansionEmailDeadKeywords: string[] = [];
    let expansionLlmOutcome: Awaited<ReturnType<typeof suggestKeywordsViaLlm>> | null = null;
    let expansionTriggerEvidence: {
      triggerAxis: "newUnique" | "inventory";
      sendable: number | null;
      shortfall: number | null;
    } | null = null;
    // AI-DRAMA-DISCOVERY-METAPROMPT W1: settings/default.automation.keywordExpansionDisabledOrgIds
    // 조직은 이 pass 에서 n-gram 마이닝·LLM 제안 두 레인 모두 스킵한다 — 아래 전체 블록(가지치기·
    // 재검증·마이닝·LLM 제안·expandedKeywords 재대입)을 건너뛰므로 expandedKeywords 는 이번 pass에
    // 절대 바뀌지 않는다(기존 값 보존, 신규 추가 0). ownerOrgId 가 없는 캠페인은 항상 false — 현행
    // 자가확장 동작 그대로(회귀 0).
    const shortfallOwnerOrgId = campaignOwnerOrgIdAlias(campaign);
    const keywordExpansionOrgDisabled = shortfallOwnerOrgId.length > 0 && (
      await (options.keywordExpansionSettingsReader ?? readSettings)()
    ).automation.keywordExpansionDisabledOrgIds.includes(shortfallOwnerOrgId);
    if (shortfall > 0 && !keywordExpansionOrgDisabled) {
      // W90: 확장 채택 필터와 **재검증 스윕이 같은 제외 목록**을 봐야 한다 — 아래 마이닝 블록에서만
      //   만들면 재검증이 운영자 제외 키워드를 모른 채 판정한다. 선언을 이 스코프 머리로 올린다.
      const excludeKeywordsLower = new Set(
        stringArrayField(targetingCriteria.excludeKeywords, 40).map((keyword) => keyword.trim().toLowerCase()),
      );
      // 자가수축은 트리거(포화 판정)와 무관하게 매 pass 평가한다 — 죽은 확장 키워드는 발견 즉시
      // 우주에서 뺀다(다음 harvest 가 죽은 슬라이스를 또 태우지 않도록). includeKeywords(baseKeywords)
      // 는 인자로도 넘기지 않는다 — 운영자 소유 필드를 건드릴 경로 자체가 없다.
      const pruneOutcome = pruneDeadExpandedKeywords(
        expandedKeywords,
        priorSliceMembership,
        queryLedger,
        nowMs,
        machineAddedKeywords,
      );
      // W90-①: 현행 필터 재검증(정크 청소). 필터를 고치면 **과거 산출물도 같이 정리된다** —
      //   별도 수동 스크립트를 두면 다음 필터 수리 때 또 사람이 붙어야 한다.
      const reconcileOutcome = reconcileExpandedKeywordsAgainstFilters(pruneOutcome.survivors, {
        machineAddedKeywords,
        excludeKeywordsLower,
      });
      // W90-②: 수율 기반 퇴역. "관측은 되는데 연락 가능 후보 0" 은 기존 신규채널 기준으로는
      //   영원히 안 잡힌다(광의어일수록 신규 채널은 잘 나온다) — 그래서 별도 축이다.
      const emailDeadTerms = new Set(keywordCorpusEmailDeadTerms(priorKeywordCorpus, machineAddedKeywords));
      const survivors = reconcileOutcome.kept.filter((keyword) => !emailDeadTerms.has(keyword));
      const emailDeadRemoved = reconcileOutcome.kept.filter((keyword) => emailDeadTerms.has(keyword));
      const removed = [...pruneOutcome.removed, ...reconcileOutcome.retired, ...emailDeadRemoved];
      expansionPrunedKeywords = removed;
      expansionFilterRetiredKeywords = reconcileOutcome.retired;
      expansionEmailDeadKeywords = emailDeadRemoved;

      // 자가확장 — 최근 완료 잡 K개의 newUnique 합 또는 기존 캠페인 문서의 직전 발송 가능 재고로
      // 포화를 판정한다. 두 축은 OR이며 재고 축은 새 읽기 없이 lastRefillCounts만 사용한다.
      const roomRemaining = SHORTFALL_KEYWORD_EXPANSION_UNIVERSE_MAX - survivors.length;
      if (roomRemaining > 0) {
        // R26-2 [BLOCKER-2a 적대적 리뷰 실측]: 이 쿼리(workflow_jobs, campaignId+type+status+
        // completedAtIso DESC)는 운영에 없는 복합 인덱스를 요구한다(리뷰어 실측, 115개 중 부재) —
        // 이 throw 를 감싸지 않으면 아래 queueYtDlpDiscovery 까지 건너뛰고 바깥 catch 로 직행해
        // **이번 pass 의 잡 enqueue 자체가 막힌다**(shortfall>0 캠페인 대부분이 이 경로를 타므로
        // 발굴 레인 전면 정지와 같다). 트리거 판정만 실패 격리하고 아래 enqueue는 계속 진행한다.
        // newUnique 축만 fail-closed하고 잡 enqueue 경로는 절대 막지 않는다. 재고 축은 이미 캠페인
        // 문서에 있는 값으로 독립 판정하며, 조회 실패 사유는 기존 감사 링에 남긴다.
        const triggerReader = options.keywordExpansionTriggerReader ?? readRecentCompletedDiscoveryJobNewUniqueValues;
        let recentNewUniqueValues: number[] | null = null;
        try {
          recentNewUniqueValues = await triggerReader(campaignId, SHORTFALL_KEYWORD_EXPANSION_TRIGGER_JOB_COUNT);
        } catch (error) {
          expansionTriggerCheckSkipReason = errorCodeForLog(error);
          console.warn("[campaign-shortfall-discovery] keyword expansion newUnique trigger check failed", {
            campaignId,
            errorCode: expansionTriggerCheckSkipReason,
          });
        }
        const newUniqueSaturated = recentNewUniqueValues !== null
          && recentNewUniqueValues.length >= SHORTFALL_KEYWORD_EXPANSION_TRIGGER_JOB_COUNT
          && recentNewUniqueValues.reduce((sum, value) => sum + value, 0) < SHORTFALL_KEYWORD_EXPANSION_TRIGGER_THRESHOLD;
        const lastRefillCounts = isRecord(campaign.lastRefillCounts) ? campaign.lastRefillCounts : {};
        const recordedSendable = typeof lastRefillCounts.sendable === "number" && Number.isFinite(lastRefillCounts.sendable)
          ? Math.max(0, lastRefillCounts.sendable)
          : null;
        const recordedShortfall = typeof lastRefillCounts.shortfall === "number" && Number.isFinite(lastRefillCounts.shortfall)
          ? Math.max(0, lastRefillCounts.shortfall)
          : null;
        const inventorySaturated = recordedShortfall !== null
          && recordedShortfall > 0
          && recordedSendable !== null
          && recordedSendable < SHORTFALL_KEYWORD_EXPANSION_SENDABLE_FLOOR;
        const saturated = newUniqueSaturated || inventorySaturated;
        if (saturated) {
          // 두 축이 동시에 참이면 inventory를 기록한다. 운영 오진을 만든 stale-sensitive 축을 우선
          // 노출하고, sendable/shortfall 원값도 함께 남겨 newUnique 발화와 구분 가능하게 한다.
          expansionTriggerEvidence = {
            triggerAxis: inventorySaturated ? "inventory" : "newUnique",
            sendable: recordedSendable,
            shortfall: recordedShortfall,
          };
          // R26-4: pass 당 상한(DAILY_CAP)뿐 아니라 롤링 24h 창에 이미 쓴 만큼도 뺀다 — 셋 중
          // 가장 작은 값이 실제 상한이다.
          // R30-4: 총 60·일 8·롤링 24h 잔여 중 최소값이 이번 pass 상한이다(n-gram 과 LLM 이 공유).
          const { addCap } = resolveExpansionAddCaps({
            universeMax: SHORTFALL_KEYWORD_EXPANSION_UNIVERSE_MAX,
            survivorCount: survivors.length,
            dailyCap: SHORTFALL_KEYWORD_EXPANSION_DAILY_CAP,
            dailyUsed: priorExpansionDailyCount,
            minedCount: 0,
          });
          const candidateDocs = await readCampaignCandidateExpansionDocs(campaignId);
          const scores = mineExpansionKeywordScores(candidateDocs);
          const existingUniverseLower = new Set([...baseKeywords, ...survivors].map((keyword) => keyword.trim().toLowerCase()));
          const expansionMinedCandidates = selectExpansionKeywords(
            scores,
            existingUniverseLower,
            excludeKeywordsLower,
            addCap,
          );
          // ---- R30-2 [사용자 승인]: 우주 밖 어휘 레인(하루 1콜 LLM 제안기) ----
          // n-gram 은 이미 찾은 후보 텍스트 안에서만 캐는 닫힌 루프다(그래서 풀이 마르면 같은 장르만
          // 계속 판다). 여기서만 **바깥 어휘**를 들이되, 산출은 위 n-gram 과 **같은 검증층·같은 상한**을
          // 통과한 것만 채택한다. 게이트(킬스위치·라우트·하루 1콜·캐시 선행)는 제안기가 전담한다.
          // R30-2: 킬스위치·라우트는 설정 문서에서 읽는다(기존 readSettings 경로 — 새 읽기 축 아님).
          const expansionSettingsReader = options.keywordExpansionSettingsReader ?? readSettings;
          const expansionSettings = await expansionSettingsReader();
          const { llmRemainingCap } = resolveExpansionAddCaps({
            universeMax: SHORTFALL_KEYWORD_EXPANSION_UNIVERSE_MAX,
            survivorCount: survivors.length,
            dailyCap: SHORTFALL_KEYWORD_EXPANSION_DAILY_CAP,
            dailyUsed: priorExpansionDailyCount,
            minedCount: expansionMinedCandidates.length,
          });
          if (llmRemainingCap > 0) {
            // 보류 중인 n-gram까지 중복 우주에 넣는다. LLM이 같은 말을 제안한 뒤 그 n-gram이 백필되면
            // 한 pass 안에서 중복 채택될 수 있기 때문이다.
            const minedLower = new Set(expansionMinedCandidates.map((keyword) => keyword.trim().toLowerCase()));
            const llmUniverseLower = new Set([...existingUniverseLower, ...minedLower]);
            const expansionSuggestor = options.keywordExpansionSuggestor ?? suggestKeywordsViaLlm;
            expansionLlmOutcome = await expansionSuggestor({
              enabled: expansionSettings.automation.keywordLlmExpansionEnabled === true,
              route: (expansionSettings.llmModelRoutes as Record<string, unknown> | undefined)?.[KEYWORD_EXPANSION_LLM_ROUTE] as never,
              campaignId,
              gameId: stringField(campaign, "gameId", ""),
              categories: stringArrayField(targetingCriteria.categories, 30),
              activeTerms: [...baseKeywords, ...survivors],
              retiredTerms: recentlyRetiredTerms(priorKeywordCorpus),
              performanceHints: keywordCorpusPerformanceHints(priorKeywordCorpus),
              targetCountries: stringArrayField(targetingCriteria.regions, 20),
              dailyCallCount: expansionLlmDailyCallCount,
              nowIso,
              cache: {
                key: keywordExpansionCacheKey,
                lookup: keywordExpansionCacheLookup,
                store: keywordExpansionCacheStore,
              },
              callModel,
              // R30-5 [배포 게이트 회귀 수리]: 사용량 기록은 **await 한다**(COST-P0-006/007).
              // 예전 형태(화살표가 Promise 를 그대로 반환)는 llm-report-await-contract 가드를 깼고,
              // Cloud Function 이 먼저 종료되면 토큰·비용 로그가 유실돼 비용 관측에 구멍이 난다.
              // 기다리되 실패는 흡수한다 — 로그 실패가 키워드 확장·발굴 엔진을 죽이면 안 된다
              // (제안기가 이 콜백을 await 한 뒤 .catch 로 삼킨다).
              reportUsage: async (usage) => {
                await reportLlmUsage({
                  modelId: usage.modelId,
                  provider: usage.provider,
                  transport: usage.transport as never,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  totalCostUsd: usage.totalCostUsd,
                  actionId: usage.actionId,
                  toolId: "flu-discovery",
                });
              },
              // 검증층은 캠페인 소유다 — LLM 이 무엇을 뱉든 이 층을 통과한 것만 우주에 들어간다.
              validate: (terms) => validateExpansionCandidateTerms(terms, {
                existingUniverseLower: llmUniverseLower,
                excludeKeywordsLower,
                maxCount: llmRemainingCap,
              }),
            });
            expansionLlmKeywords = expansionLlmOutcome.terms.slice(0, llmRemainingCap);
          }
          // LLM이 실제 채택한 자리만 우선 보장하고, 스킵·검증 탈락으로 비어 있는 몫은 n-gram으로
          // 되메운다. 따라서 LLM은 굶지 않고 두 경로 합은 항상 addCap 이하다.
          expansionMinedKeywords = expansionMinedCandidates.slice(
            0,
            Math.max(0, addCap - expansionLlmKeywords.length),
          );
        }
      }

      // R26-5: durable 소유 목록을 이번 pass 의 실제 expandedKeywords(survivors+mined)와 동기화한다
      // — 가지치기로 빠진 키워드는 여기서도 함께 빠지고(총량이 expandedKeywords 를 절대 넘지 않는다),
      // 새로 마이닝된 키워드는 여기 더해진다. 매 shortfall>0 pass 마다 무조건 갱신해 링 회전과 무관하게
      // 항상 최신 소유권 근거를 유지한다.
      // R30: LLM 채택분도 기계 추가분이다 — 같은 자가수축(가지치기) 스코프에 들어가야 한다.
      // 성과가 없으면 n-gram 산출과 똑같이 은퇴한다(LLM 이라고 봐주지 않는다).
      const expansionAddedKeywords = [...expansionMinedKeywords, ...expansionLlmKeywords];
      const currentExpandedKeywordsSet = new Set([...survivors, ...expansionAddedKeywords]);
      expansionNextMachineAddedKeywords = Array.from(new Set([
        ...priorMachineAddedKeywords.filter((keyword) => currentExpandedKeywordsSet.has(keyword)),
        ...expansionAddedKeywords,
      ]));

      if (removed.length > 0 || expansionAddedKeywords.length > 0) {
        expansionNextExpandedKeywords = [...survivors, ...expansionAddedKeywords];
        // HIGH-1/R23-2a 소비처는 여전히 string[] 을 읽는다 — expandedKeywords 필드 shape 은 바꾸지
        // 않는다. 이 재대입이 아래 harvestKeywords(=selectHarvestKeywordWindow(keywords, ...))
        // 계산에 그대로 반영돼, 같은 pass 안에서 새로 추가된 키워드가 검색 우주에 실제로 들어간다.
        // R26-1: 이 union 도 위와 같은 무손실 캡(resolveShortfallHarvestKeywordUniverse)을 써야
        // 한다 — 여기만 옛 40 캡으로 남으면 방금 마이닝된 항목(항상 union 의 맨 끝)이 바로 이
        // 지점에서 다시 잘려 BLOCKER-1 이 재발한다(옛 수용 기준⑥은 우주가 12 이하일 때만 우연히
        // 가려졌다 — 그 갭을 R26-1 값 테스트가 닫는다).
        keywords = resolveShortfallHarvestKeywordUniverse(baseKeywords, expansionNextExpandedKeywords);
      }
    }

    // R23-1/Task71: 기본 floor 재고 측정은 큐잉 게이트를 통과한 뒤에 한다. 다만 active-job/MIN_INTERVAL
    // 같은 캠페인별 게이트에 막힌 floor 후보도 sensor stale 을 남기면 다음 pass 정렬을 계속 오염시키므로,
    // 위 조기 return 지점에서 같은 cheap aggregate helper 를 한 번 호출한다. 전역 쿼터 게이트와 shortfall
    // 레인은 여전히 재고를 보지 않는다 — 전자는 모두가 대기해야 하고, 후자는 수확 사유가 확정됐다.
    if (shortfall <= 0) {
      // W115-R1 [Stage 1-a]: floor 레인의 하한은 **전역 목표에서 역산된 값**으로 상향될 수 있다.
      //   호출부가 안 넘기면 기본 하한 그대로다(shortfall 레인은 이 경로 자체를 안 탄다).
      // Task71: the same cheap measurement helper is also used by campaign-local blocked gates above,
      // so a blocked floor candidate never leaves stale inventory behind.
      await measureFloorInventoryIfNeeded();
      // 재고가 하한 이상이면 수확 사유가 없다. 레이트리밋 상태는 건드리지 않는다 — 잡을 넣지 않았으므로
      // 여기서 카운터를 올리면 정작 부족분이 생겼을 때 쓸 몫을 미리 태운다.
      if (inventoryShortfall <= 0) return { measured, enqueued: false };
    }

    // R23-2c: 이번 harvest 가 실제로 쓸 검색 region(회전 또는 운영자 명시)을 먼저 정한다 — 슬라이스
    // 해시(R23-2b)가 이 값을 반영해야 리전마다 독립적으로 신선율이 추적된다.
    const operatorRegions = stringArrayField(targetingCriteria.regions, 12);
    const { regions: searchRegions, nextRotationIndex } = nextHarvestSearchRegions(operatorRegions, state);

    // HIGH-1: 우주(최대 40)가 12 초과면 실제로 검색할 12개 창을 여기서 확정한다 — 이 아래의 sliceHash·
    // queueYtDlpDiscovery 호출이 전부 이 절단 후 집합을 쓴다(절단 전 우주 자체를 넘기지 않는다).
    const harvestKeywords = selectHarvestKeywordWindow(keywords, numberField(state, "regionRotationIndex", 0));

    // ---- R27: 3암 밴딧 — 직전 잡 결과로 EWMA 갱신 → 이번 pass 슬롯 배분 ----
    // shortfall<=0(floor 레인)에서도 keyword 암(A)은 기존과 동일하게 동작해야 하므로 스코프를
    // 가리지 않는다 — 다만 sliceArmSlots 를 넘기는 것 자체가 admin.ts 의 이 한 경로뿐이다.
    const priorSliceArmLedger: SliceArmLedgerState = isRecord(state.sliceArmLedger) ? state.sliceArmLedger : {};
    let sliceArmLedger = priorSliceArmLedger;
    // W115 C1·C3: 비용 원장(누적 이메일/유닛)과 암 수율 원장(연속 0 스트릭). 둘 다 캠페인 문서의
    //   shortfallDiscoveryState 안에 얹는다 — 새 컬렉션 0, 새 읽기 0(state 는 이미 읽혀 있다).
    const priorArmCostLedger: Record<string, unknown> = isRecord(state.armCostLedger) ? state.armCostLedger : {};
    let armCostLedger: Record<string, unknown> = priorArmCostLedger;
    const priorArmYieldLedger: ArmYieldLedger = (isRecord(state.armYieldLedger) ? state.armYieldLedger : {}) as ArmYieldLedger;
    let armYieldLedger: Record<string, ArmYieldLedgerEntry> = priorArmYieldLedger as Record<string, ArmYieldLedgerEntry>;
    if (lastJobData && lastJobRefPath && lastJobRefPath !== priorSliceArmLedger.lastAppliedJobRef) {
      const lastJobMaterialization = isRecord(lastJobData.materialization) ? lastJobData.materialization : {};
      const lastJobSliceArmStats: Record<string, unknown> = isRecord(lastJobMaterialization.sliceArmStats) ? lastJobMaterialization.sliceArmStats : {};
      const lastJobSliceArmSlots: Record<string, unknown> = isRecord(lastJobData.sliceArmSlots) ? lastJobData.sliceArmSlots : {};
      // R28-1 (P0-C): 그 잡이 암별로 실제 발사한 검색 콜 — EWMA 분모의 정본이다(없으면 레거시 잡).
      const lastJobSliceArmCalls: Record<string, unknown> = isRecord(lastJobMaterialization.sliceArmCalls) ? lastJobMaterialization.sliceArmCalls : {};
      // 갱신 근거(이 잡이 실제로 어느 암을 얼마나 썼는지)가 있을 때만 EWMA 를 움직인다 — 없으면
      // (searched:false 경로·R27 이전 잡·아직 완료 안 됨) 원장을 그대로 둔다.
      if (Object.keys(lastJobSliceArmStats).length > 0) {
        sliceArmLedger = applySliceArmEwmaUpdate(priorSliceArmLedger, lastJobSliceArmStats, lastJobSliceArmSlots, nowIso, lastJobSliceArmCalls);
      }
      // ── W115 C1·C3: 같은 잡 관측에서 **비용 원장**과 **암 수율 원장**도 함께 갱신한다 ─────────
      //   같은 `lastAppliedJobRef` 게이트 안에 두는 이유: 세 원장이 같은 잡을 근거로 움직여야
      //   서로 다른 pass 의 관측이 섞이지 않는다(분모가 갈리면 유닛/이메일이 성립하지 않는다).
      const lastJobLaneCostYield = isRecord(lastJobMaterialization.laneCostYield)
        ? lastJobMaterialization.laneCostYield as Record<string, Record<string, unknown>>
        : {};
      if (Object.keys(lastJobLaneCostYield).length > 0) {
        // 누적 합산 원장이다(EWMA 가 아니다) — 유닛/이메일은 표본이 적을 때 분산이 극단적이라
        //   평활보다 **누적 분자·분모**가 정직하다(1콜에서 이메일 1개면 EWMA 는 10배를 본다).
        const priorCost = isRecord(state.armCostLedger) ? state.armCostLedger as Record<string, unknown> : {};
        const nextCost: Record<string, { emails: number; units: number }> = {};
        for (const lane of DISCOVERY_SEARCH_LANES) {
          const prior = isRecord(priorCost[lane]) ? priorCost[lane] as Record<string, unknown> : {};
          const observed = isRecord(lastJobLaneCostYield[lane]) ? lastJobLaneCostYield[lane] : {};
          const emails = numberField(prior, "emails", 0) + Math.max(0, numberField(observed, "emails", 0));
          const units = numberField(prior, "units", 0) + Math.max(0, numberField(observed, "units", 0));
          if (units > 0) nextCost[lane] = { emails, units: Number(units.toFixed(3)) };
        }
        if (Object.keys(nextCost).length > 0) armCostLedger = nextCost;
      }
      // W115-R1 [HIGH 5 · 적대 리뷰 — **멱등 토큰 미전진**]
      //   `newUniqueByArm` 은 `sliceArmStats` 에서 온다. 그 맵이 비어 있으면(캐시 히트 런·
      //   searched:false·레거시 잡) 세 암 전부 newUnique=0 으로 읽혀 **쏜 적 없는 0** 이 스트릭에
      //   적립된다. 갱신 근거가 없을 때 원장을 건드리지 않는다는 규율은 EWMA 에만 걸려 있었고
      //   수율 원장에는 없었다 — 같은 규율을 여기에도 건다.
      if (Object.keys(lastJobSliceArmCalls).length > 0 && Object.keys(lastJobSliceArmStats).length > 0) {
        const successfulCallsByArm: Record<string, number> = {};
        const newUniqueByArm: Record<string, number> = {};
        for (const lane of DISCOVERY_SEARCH_LANES) {
          const armCalls = isRecord(lastJobSliceArmCalls[lane]) ? lastJobSliceArmCalls[lane] as Record<string, unknown> : {};
          // W115-R1 [HIGH 2]: 쿨다운 판정의 분모는 **응답을 받은 콜**이다. 시도(403 포함)로 세면
          //   쿼터 소진일에 세 암이 나란히 0채널로 기록돼 3연속이면 멀쩡한 암이 3일 은퇴한다.
          successfulCallsByArm[lane] = numberField(armCalls, "successfulSearchCalls", 0);
          newUniqueByArm[lane] = numberField(lastJobSliceArmStats, lane, 0);
        }
        armYieldLedger = applyArmYieldLedgerUpdate(priorArmYieldLedger, {
          successfulCallsByArm,
          newUniqueByArm,
          nowIso,
        });
      }
      // ── W115-R1 [HIGH 5]: **멱등 토큰은 세 원장의 갱신 여부와 무관하게 전진한다** ─────────────
      //   종전에는 토큰이 EWMA 갱신 블록 **안**에 있었다. 그래서 `sliceArmStats` 가 빈 잡
      //   (캐시 히트·searched:false)이 lastJobRef 에 남으면 토큰이 영원히 안 움직이고, 매 pass
      //   같은 잡이 수율 원장에 **다시 적용**돼 zeroStreak 가 3까지 올라 암을 은퇴시켰다
      //   (R27 이 EWMA 에서 겪은 재적용 사고의 같은 계열 — 그때 만든 토큰이 여기선 안 걸려 있었다).
      //   이 지점에 도달했다는 것은 위 dedup 루프가 이 잡을 **비활성**으로 판정했다는 뜻이므로
      //   (활성이면 이미 return 했다) 다시 볼 이유가 없다.
      sliceArmLedger = { ...sliceArmLedger, lastAppliedJobRef: lastJobRefPath };
    }
    // ── W115 C2: **비용 정규화 배분.** 관측이 없으면 costWeights 는 전원 동일해 종전 배분과 같다.
    const armCostWeights = costNormalizedArmWeights(
      armCostLedger as Record<string, { emails?: unknown; units?: unknown } | undefined>,
      DISCOVERY_SEARCH_LANES,
    );
    const hasCostObservation = Object.values(armCostLedger).some((entry) => numberField(entry as Record<string, unknown>, "units", 0) > 0);
    const costAllocatedSliceArmSlots = allocateSliceArmSlots(
      SHORTFALL_SLICE_ARM_TOTAL_SLOTS,
      sliceArmLedger,
      hasCostObservation ? armCostWeights : undefined,
    );
    // ── W115 C3: **쿼리 위생.** 연속 K회 신규 0 인 암은 쉰다. 전 암 동시 정지는 구조적으로 불가능하다
    //   (applyArmCooldownToSlots 가 회수분을 살아 있는 암에 되돌린다) — 위생이 발굴을 세우면 장애다.
    const armCooldown = applyArmCooldownToSlots(costAllocatedSliceArmSlots, armYieldLedger, nowMs, {
      streakThreshold: DISCOVERY_ARM_DEAD_STREAK_THRESHOLD,
      cooldownMs: DISCOVERY_ARM_COOLDOWN_MS,
      lanes: DISCOVERY_SEARCH_LANES,
    });
    const allocatedSliceArmSlots = armCooldown.slots as Record<(typeof SHORTFALL_SLICE_ARM_TYPES)[number], number>;
    if (armCooldown.cooledDown.length > 0) {
      console.info(JSON.stringify({
        event: "campaign_shortfall_discovery.arm_cooldown",
        campaignId,
        cooledDown: armCooldown.cooledDown,
        streakThreshold: DISCOVERY_ARM_DEAD_STREAK_THRESHOLD,
        // 회수된 슬롯 × 100유닛 = 이번 pass 가 안 태운 헛발 검색 비용(COST-P0-006).
        reclaimedSearchUnits: armCooldown.cooledDown
          .reduce((sum, lane) => sum + (costAllocatedSliceArmSlots[lane as (typeof SHORTFALL_SLICE_ARM_TYPES)[number]] ?? 0), 0) * 100,
      }));
    }
    // 캠페인 렉시콘 전체 우주(12개 회전 창이 아니라 harvestKeywords 계산에 이미 쓰인 union 그대로) —
    // broad/topic 산출물 분류 게이트가 이걸로 판정한다. R24 mined 키워드는 expandedKeywords 안에 이미
    // 들어 있으므로 별도로 합칠 필요가 없다.
    //
    // W59c-C3 [Codex 적대 리뷰 · MAJOR]: 프로그램 키워드 폴백(W59-3)이 **렉시콘에는 전달되지 않았다**.
    // 폴백 캠페인은 baseKeywords 가 비어 있으므로 렉시콘이 0개가 되고, 렉시콘 0 이면 broad/topic
    // 관련성 게이트가 **전부 통과**시킨다(gateDiscoveryCandidatesByLexicon 계약). 즉 검색은 프로그램
    // 키워드로 하면서 분류 게이트는 무장 해제된 상태가 되어, 폴백이 열어 준 유입이 그대로 전역 풀에
    // 무여과로 들어간다 — 폴백의 목적(막힌 캠페인을 다시 돌린다)과 정반대의 부작용이다.
    // 폴백을 쓴 pass 는 폴백 키워드를 렉시콘에도 공급한다(검색 우주와 분류 기준을 같은 소스로 맞춘다).
    const lexiconBaseKeywords = keywordFallbackProgramId ? keywords : baseKeywords;
    const campaignLexicon = resolveShortfallHarvestKeywordUniverse(
      lexiconBaseKeywords,
      keywordFallbackProgramId ? [] : (expansionNextExpandedKeywords ?? expandedKeywords),
    );

    // R23-2b: 죽은 쿼리 슬라이스 은퇴. 이 캠페인이 지금 큐잉하려는 슬라이스(키워드×윈도×정렬×region)가
    // 최근에 신규 후보를 0건 냈다면 재시도하지 않는다 — 레이트리밋을 통과했어도 결과는 달라지지 않는다.
    // 원장은 campaign 문서에 이미 실려 있는 값이라(shortfallDiscoveryState.queryLedger) 추가 읽기가
    // 없다. HIGH-1: 해시는 절단 후(실제로 검색될) 키워드 집합으로 계산한다 — 절단 전 우주만 바뀌고
    // 절단 후 창이 같으면 해시가 불변이어야 한다(같은 슬라이스를 두 번 셈하지 않는다).
    const sliceHash = campaignHarvestSliceHash(harvestKeywords, { ...targetingCriteria, regions: searchRegions });
    // R24: queryLedger 는 위(phase 1, 트리거/가지치기 판정)에서 이미 선언했다 — 여기서 다시 읽지 않는다.
    const sliceLedgerEntry = isRecord(queryLedger[sliceHash]) ? queryLedger[sliceHash] as Record<string, unknown> : {};

    // ---- R24 phase 2: 슬라이스 소속 갱신 (harvestKeywords/sliceHash 확정 후) ----
    // 이번 pass 가 실제로 검색한 창(harvestKeywords) 중 확장 키워드(운영자 소유 baseKeywords 제외)의
    // 소속 슬라이스를 기록한다 — 다음 pass 의 자가수축이 이 맵으로 죽음을 판정한다
    // (pruneDeadExpandedKeywords 주석). 새 Firestore 읽기 없음 — harvestKeywords/sliceHash 는 이미
    // 위에서 계산된 값이다. shortfall<=0(floor 레인)은 phase 1 과 같은 스코프 경계로 건너뛴다.
    // HIGH-2②: "마지막 소속 슬라이스 1개만" 덮어쓰던 옛 설계를 버리고 최근 소속 슬라이스를
    // **누적**한다(중복 제거, 키워드당 최근 N개로 유계) — 서로 다른 슬라이스 ≥2 에서 죽음을 확인
    //하려면 그 여러 슬라이스가 남아 있어야 한다.
    let keywordExpansionStateWrite: {
      // W59c-C5: 퇴출 키는 FieldValue.delete() 로 실어야 실제로 사라진다(아래 주석 — merge 딥머지).
      sliceMembership: Record<string, string[] | FieldValue>;
      events: unknown[];
      dailyCount: number;
      dailyWindowStartIso: string;
      machineAddedKeywords: string[];
      llmDailyCallCount: number;
    } | null = null;
    // R30-1: 이번 pass 의 코퍼스 원장. 우주가 바뀐 pass 에서만 쓴다(merge 보존 — 무변화 pass 는
    // 원장을 건드리지 않는다). 세 출처(seed=운영자 키워드·mined=n-gram·llm=제안기)를 각각 기록하고,
    // 가지치기로 빠진 term 은 갱신열(applyKeywordCorpusPassUpdates) 안의 sync 단계가 retired 로 내린다.
    let keywordCorpusWrite: ReturnType<typeof applyKeywordCorpusPassUpdates> | null = null;
    if (shortfall > 0) {
      const baseKeywordsLower = new Set(baseKeywords.map((keyword) => keyword.trim().toLowerCase()));
      // W59c-C5 [Codex 적대 리뷰 · MAJOR]: sliceMembership 이 **퇴출된 키워드 키까지 영구 보존**했다.
      // 각 키워드의 해시 배열은 유계였지만(HISTORY 상한) **키 개수에 상한이 없었다** — 가지치기로
      // 우주에서 빠진 키워드의 항목이 계속 남아, 장기 캠페인에서 캠페인 문서가 Firestore 1MiB 한도로
      // 자란다. 그 지점의 실패 형상이 특히 나쁘다: 발굴 잡은 이미 enqueue 된 **뒤에** 상태 쓰기만
      // 실패하므로 lastJobRef·간격 도장이 갱신되지 않아 **고아 잡 + 다음 pass 중복 잡**이 된다.
      // 살아 있는 우주에 속한 키워드만 남긴다 — 퇴출된 키워드의 소속 증거는 그 키워드가 사라진 순간
      // 판정에 쓰이지 않는다(pruneDeadExpandedKeywords 는 현재 우주의 키워드만 대상으로 한다).
      const activeExpandedUniverse = new Set(
        (expansionNextExpandedKeywords ?? expandedKeywords).map((keyword) => keyword.trim().toLowerCase()),
      );
      const nextSliceMembership: Record<string, string[] | FieldValue> = {};
      let prunedSliceMembershipKeys = 0;
      for (const [keyword, value] of Object.entries(priorSliceMembership)) {
        if (!activeExpandedUniverse.has(keyword.trim().toLowerCase())) {
          // ⚠️ 캠페인 문서 쓰기는 set(..., { merge: true }) 이고 sliceMembership 은 **중첩 맵**이라
          //    Firestore 가 딥머지한다 — 키를 빼는 것만으로는 기존 값이 그대로 살아남는다(무해한
          //    no-op 이 되어 1MiB 성장이 계속된다). 실제로 지우려면 FieldValue.delete() 를 실어야 한다.
          //    (같은 함정을 apiQuota 의 dotted-key 주석이 이미 기록해 두었다.)
          nextSliceMembership[keyword] = FieldValue.delete();
          prunedSliceMembershipKeys += 1;
          continue;
        }
        // 옛 string 값(HIGH-2 이전 배포분)도 배열로 승격해 이어간다 — 증거를 버리지 않는다.
        if (Array.isArray(value)) nextSliceMembership[keyword] = value.filter((hash): hash is string => typeof hash === "string");
        else if (typeof value === "string" && value) nextSliceMembership[keyword] = [value];
      }
      if (prunedSliceMembershipKeys > 0) {
        console.info("[campaign-shortfall-discovery] pruned stale slice membership keys", {
          campaignId,
          prunedSliceMembershipKeys,
          retainedKeys: Object.keys(nextSliceMembership).length - prunedSliceMembershipKeys,
        });
      }
      for (const keyword of harvestKeywords) {
        if (baseKeywordsLower.has(keyword.trim().toLowerCase())) continue;
        // W59c-C5: 이번 pass 에 실제로 검색되는 키워드는 살아 있는 우주의 것이므로 삭제 sentinel 을
        // 덮어쓴다(퇴출 판정 뒤 같은 pass 에 다시 등장하는 경계 — 그때는 지우면 안 된다).
        const prior = nextSliceMembership[keyword];
        const existing = Array.isArray(prior) ? prior : [];
        nextSliceMembership[keyword] = existing.includes(sliceHash)
          ? existing
          : [...existing, sliceHash].slice(-SHORTFALL_KEYWORD_EXPANSION_SLICE_MEMBERSHIP_HISTORY);
      }
      const expansionChanged = expansionPrunedKeywords.length > 0
        || expansionMinedKeywords.length > 0
        || expansionTriggerCheckSkipReason !== null;
      const events = expansionChanged
        ? [
          ...priorExpansionEvents,
          ...(expansionMinedKeywords.length > 0 ? [{ addedAtIso: nowIso, added: expansionMinedKeywords, source: "mined" as const, ...(expansionTriggerEvidence ?? {}) }] : []),
          // R30-2: LLM 채택분은 출처가 다르므로 이벤트에서도 구분한다(원장 감사 가능성).
          // SEC-P0-009: 프롬프트·응답 원문은 남기지 않는다 — 건수·길이·해시·사유 토큰만.
          ...(expansionLlmKeywords.length > 0 ? [{ addedAtIso: nowIso, added: expansionLlmKeywords, source: "llm" as const, ...(expansionTriggerEvidence ?? {}) }] : []),
          ...(expansionLlmOutcome && expansionLlmOutcome.skipReason
            ? [{
              atIso: nowIso,
              source: "llm_skipped" as const,
              ...(expansionTriggerEvidence ?? {}),
              reason: expansionLlmOutcome.skipReason,
              suggested: expansionLlmOutcome.suggestedCount,
              accepted: expansionLlmOutcome.acceptedCount,
              promptChars: expansionLlmOutcome.promptChars,
              ...(expansionLlmOutcome.responseHash ? { responseHash: expansionLlmOutcome.responseHash } : {}),
            }]
            : []),
          ...(expansionPrunedKeywords.length > 0 ? [{ removedAtIso: nowIso, removed: expansionPrunedKeywords, source: "pruned" as const }] : []),
          // R26-2: 트리거 조회 실패 사유를 기존 감사 링(shape)에 그대로 남긴다 — 새 필드 남발 금지,
          // 기존 이벤트 shape 에 사유 하나만 얹는다.
          ...(expansionTriggerCheckSkipReason !== null
            ? [{ atIso: nowIso, source: "trigger_check_skipped" as const, reason: expansionTriggerCheckSkipReason }]
            : []),
        ].slice(-SHORTFALL_KEYWORD_EXPANSION_EVENTS_RING_SIZE)
        : priorExpansionEvents;
      // 변화가 없어도(포화 미달·이번 pass 죽은 키워드 없음) 이번 pass 가 실제로 검색한 확장
      // 키워드의 소속 슬라이스는 갱신한다 — 다음 pass 의 가지치기 판정 근거가 연속 무변화 pass
      // 에서도 낡지 않게 유지된다. R26-4/R26-5: 확장 전용 일일 창·durable 소유 목록도 매 shortfall>0
      // pass 마다 함께 갱신한다(변화가 없어도 창 신선도·소유권 동기는 계속 최신으로 유지).
      keywordExpansionStateWrite = {
        sliceMembership: nextSliceMembership,
        events,
        dailyCount: (expansionDailyWindowFresh ? priorExpansionDailyCount : 0) + expansionMinedKeywords.length + expansionLlmKeywords.length,
        dailyWindowStartIso: expansionDailyWindowFresh ? (priorExpansionDailyWindowStartIso ?? nowIso) : nowIso,
        machineAddedKeywords: expansionNextMachineAddedKeywords,
        // R30-2: **모델 호출 횟수** 축(하루 1콜). 채택 개수(dailyCount)와 섞으면 "제안은 받았지만
        // 검증층에서 전부 떨어진 pass"가 상한을 소비하지 않아 하루 종일 호출이 반복된다.
        //
        // W90-R2 [리뷰 HIGH · 리더 결정 = 시도 기준]: 종전에는 pass 당 +1 이었는데 크리틱 도입으로
        //   한 pass 가 **2콜**을 쓴다 — 상한 2가 하루 4콜을 허용했다(카운터 2배 과소계상).
        //   이제 outcome 이 실제 디스패치 수(callsMade)를 돌려주므로 그대로 더한다.
        //   `modelCalled` 를 안 쓰는 이유: 그건 "성공 호출" 의미라 게이트웨이가 던진 pass 를 0으로
        //   세고, 그러면 고장난 캠페인이 상한을 안 먹고 종일 재시도한다(실패도 소모해야 한다).
        llmDailyCallCount: expansionLlmDailyCallCount + (expansionLlmOutcome?.callsMade ?? 0),
      };
    }
    // R30-1: 원장 갱신 — ①이번 pass 채택분을 출처와 함께 등재(llm 을 먼저 등재해 출처가 mined 로
    // 덮이지 않게 한다) ②현재 우주와 동기화(빠진 term 은 retired, 나머지 신규는 seed=운영자 키워드).
    // 원장이 우주를 바꾸지는 않는다 — expandedKeywords 는 위에서 확정됐고 여기선 **투영만** 한다.
    // ③직전 잡의 newUnique 를 그 잡이 태운 창(harvestKeywords)에 균등 귀속(한계는 keywordCorpus.ts 주석).
    if (shortfall > 0) {
      const universeNow = expansionNextExpandedKeywords ?? expandedKeywords;
      // W90-F3: 갱신열은 applyKeywordCorpusPassUpdates 안에 있다. 여기서 순서를 다시 쓰지 않는 이유는
      //   그것이 정확히 이 결함의 근인이었기 때문이다 — 조립이 호출부에 흩어져 있으면 테스트가
      //   순서를 복사해야 하고, 복사본은 원본이 바뀌는 순간 조용히 거짓이 된다.
      const lastJobNewUnique = lastJobData && isRecord(lastJobData.materialization)
        ? numberField(lastJobData.materialization as Record<string, unknown>, "newUnique", 0)
        : 0;
      keywordCorpusWrite = applyKeywordCorpusPassUpdates(priorKeywordCorpus, {
        llmTerms: expansionLlmKeywords,
        minedTerms: expansionMinedKeywords,
        criticVerdicts: expansionLlmOutcome?.criticVerdicts ?? [],
        universe: [...baseKeywords, ...universeNow],
        filterRetiredTerms: expansionFilterRetiredKeywords,
        emailDeadTerms: expansionEmailDeadKeywords,
        harvestKeywords,
        lastJobNewUnique,
        nowIso,
      });
    }
    const sliceLastRunAtMs = typeof sliceLedgerEntry.lastRunAtIso === "string" ? Date.parse(sliceLedgerEntry.lastRunAtIso) : NaN;
    // BLOCKER-2(ii) [적대적 리뷰 실측]: 쿨다운은 **재고 하한(floor) 레인 전용**이다 — 이 캠페인이
    // 목표를 못 채운 상황(shortfall>0)에서는 쿨다운이 걸려도 진행한다. floor harvest 는 "여유가 있을
    // 때 미리 채워 두자"는 최적화라 쉬어도 되지만, shortfall>0 은 이 캠페인의 실제 미달 목표다 — 같은
    // 슬라이스가 최근에 신규 0건이었어도 아무것도 안 하는 것보다는 다시 시도(최선노력)하는 편이 낫다.
    // 실측(리뷰 프로브 D2): 부족분 5(목표 미달)인데 6 tick 연속 발굴 잡 0건, sliceGate=cooldown_skipped
    // — 목표 미달 캠페인이 죽은 슬라이스 쿨다운에 막혀 영구 정체됐었다.
    const sliceInCooldown = shortfall <= 0
      && numberField(sliceLedgerEntry, "newUnique", -1) === 0
      && Number.isFinite(sliceLastRunAtMs)
      && nowMs - sliceLastRunAtMs < QUERY_SLICE_DEAD_COOLDOWN_MS;
    if (sliceInCooldown) {
      await adminDb.collection("campaigns").doc(campaignId).set({
        shortfallDiscoverySliceGate: {
          atIso: new Date(nowMs).toISOString(),
          sliceHash,
          state: "cooldown_skipped",
          cooldownUntilIso: new Date(sliceLastRunAtMs + QUERY_SLICE_DEAD_COOLDOWN_MS).toISOString(),
        },
        // R23-2c: 이 리전이 죽었어도 회전 커서는 전진시킨다 — 안 그러면 다음 시도(1시간 뒤)도 같은
        // 리전을 다시 골라 7일 내내 같은 슬라이스에서만 쿨다운을 반복한다. 회전이 없으면 다양화가
        // 회전 없는 것과 같아진다. 운영자가 region 을 명시한 경우(nextRotationIndex null)는 회전
        // 축이 없으므로 커서를 건드리지 않는다.
        ...(nextRotationIndex !== null ? { shortfallDiscoveryState: { regionRotationIndex: nextRotationIndex } } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return { measured, enqueued: false };
    }

    // R21-3 [사용자 지시]: 매일 쿼터를 여유만 남기고 수확한다. 예전에는 잡 크기가 고정이라
    // (resultLimit = max(shortfall*2, 10)) 잔여와 무관하게 태웠고, 실패하면 그냥 하루가 지나갔다
    // (어제: 11키워드 × 300건 ≈ 6,600유닛을 한 번에 → 전 키 소진 → 9시간 발굴 정지).
    // 잔여 추정을 보고 ①남아 있으면 그만큼만 큐잉 ②전 키 소진이면 **다음 리셋까지 대기**한다(이
    // 대기·소진 판정 자체는 R23-5 가 위(레이트리밋 구간)로 옮겼다 — quota/quotaSlotCount/nowIso 를
    // 여기서 그대로 재사용한다). 재개는 별도 스케줄이 필요 없다 — 리셋 후 슬롯 계측이 0 으로
    // 시작하므로 다음 5분 tick 이 자동으로 다시 통과한다.
    // 잔여로 감당 가능한 상한까지만 요청한다(하한 10 은 기존 동작 유지 — 잔여가 그보다 크다).
    // R23-1: 부족분이 없는 재고 수확에서는 **재고 부족분**이 잡 크기의 근거다(shortfall*2 를 쓰면 0 이
    // 되어 하한 10 으로 고정되고, 하한 750 을 회복하는 데 필요한 폭과 무관해진다). 상한은 종전대로
    // 쿼터 배급(quota.maxResultLimit)이 조인다.
    const harvestShortfall = shortfall > 0 ? shortfall : inventoryShortfall;
    const desiredResultLimit = Math.min(
      CAMPAIGN_OUTREACH_QUEUE_LIMIT,
      Math.max(harvestShortfall * 2, harvestShortfall, 10),
    );
    // ── W115 C2 [저비용 레인 우선 배분] ───────────────────────────────────────────────────
    //   채널그래프(1-hop, 시드당 1유닛)와 지역 인기차트(region 당 1유닛)는 searchYouTubeLive 안에서
    //   **검색 뒤에** 돈다. 잔여가 마르면 두 레인이 함께 죽는데, 둘은 콜당 1유닛이라 이메일/유닛이
    //   검색(100유닛/콜)보다 두 자릿수 낫다 — 가장 싼 공급을 가장 먼저 끄는 순서가 거꾸로였다.
    //   잔여에서 그 몫(31유닛)을 **먼저 떼고** 검색 예산을 정한다. 예산이 넉넉한 평소에는
    //   desiredResultLimit 가 먼저 물어 이 절단이 무연산이고, 잔여가 마지막 몇 콜만 남았을 때만 문다.
    //   W115-R1 [MEDIUM]: 가용치에서 **같은 pass 의 앞선 잡이 이미 계획한 유닛**을 뺀다.
    //   쿼터 스냅샷은 pass 안에서 갱신되지 않으므로, 안 빼면 3잡이 각자 잔여 전량을 약속한다.
    const laneBudget = quota
      ? planLaneBudget({
        availableUnits: passLocalAvailableUnits(quota.remainingUnits, options.reservedUnits ?? 0),
        reserveLowCostLanes: true,
        lowCostUnitEstimate: DISCOVERY_LOW_COST_LANE_UNIT_RESERVE,
      })
      : null;
    // W115-R1 [한 줄 수리 · 적대 리뷰]: 종전 `Math.max(1, fundedSearchCalls * 50)` 은
    //   **자금이 0콜일 때 그 사실을 지웠다** — 검색 예산이 한 콜도 안 남았는데 resultLimit 1 로
    //   잡을 만들어 100유닛짜리 search 를 한 건 태웠다(그리고 그 콜은 대개 403 이다).
    //   자금이 0 이면 이 잡은 **저비용 레인 전용**이다: 검색 슬롯을 전부 0 으로 내려 보내고
    //   resultLimit 는 보조 레인 산출물을 담을 폭으로만 둔다(그래프 1-hop·지역 인기차트는 1유닛).
    const fundedSearchCalls = laneBudget ? laneBudget.fundedSearchCalls : null;
    const searchLaneFunded = fundedSearchCalls === null || fundedSearchCalls > 0;
    const resultLimit = quota
      ? Math.max(1, Math.min(
        desiredResultLimit,
        quota.maxResultLimit,
        // 저비용 레인 예약분을 뺀 뒤 실제로 살 수 있는 검색 콜 수 × 페이지 크기.
        searchLaneFunded && fundedSearchCalls !== null ? fundedSearchCalls * 50 : desiredResultLimit,
      ))
      : desiredResultLimit;
    // W9-1: 50-result search pages are the existing admitted call budget. When fewer than three
    // pages are funded, expose only that many arms to the worker and rotate toward the least-sampled
    // arms; this avoids both arm starvation and fairness-driven quota inflation.
    const fundedArmCount = Math.min(SHORTFALL_SLICE_ARM_TYPES.length, Math.max(1, Math.ceil(resultLimit / 50)));
    // W115 C3 [두 게이트가 교차하면 검색이 통째로 0 이 된다]: 자금 배정은 "가장 덜 표집된 암"을
    //   먼저 고르는데, 하필 그 암이 쿨다운 중이면 fundedArms ∩ 살아 있는 암 = ∅ 이 되어
    //   sliceArmSlots 가 {0,0,0} 이 되고, 이 잡은 큐에 들어가 검색을 한 건도 하지 않는다.
    //   쿨다운 암을 정렬에서 **뒤로** 민다 — 쿨다운이 없을 때의 순서는 종전과 완전히 같다.
    const cooledDownArms = new Set<string>(armCooldown.cooledDown);
    const fundedArms = new Set(
      [...SHORTFALL_SLICE_ARM_TYPES]
        .sort((left, right) => {
          const cooled = Number(cooledDownArms.has(left)) - Number(cooledDownArms.has(right));
          if (cooled !== 0) return cooled;
          return (sliceArmLedger[left]?.samples ?? 0) - (sliceArmLedger[right]?.samples ?? 0);
        })
        .slice(0, fundedArmCount),
    );
    const sliceArmSlots: DiscoverySliceArmSlots = searchLaneFunded
      ? {
        keyword: fundedArms.has("keyword") ? allocatedSliceArmSlots.keyword : 0,
        broad: fundedArms.has("broad") ? allocatedSliceArmSlots.broad : 0,
        topic: fundedArms.has("topic") ? allocatedSliceArmSlots.topic : 0,
      }
      // 검색 자금 0 — 세 암 전부 0 으로 내려 보낸다. 워커는 queryPlan 이 비어 search.list 를 한 건도
      //   부르지 않고, 보조 레인(1유닛)만 돈다. 이게 "저비용 레인만"의 실행 형태다.
      : { keyword: 0, broad: 0, topic: 0 };
    // W115-R1 [MEDIUM]: 이 잡이 태우기로 **계획한** 유닛. 같은 pass 의 다음 잡이 이 값을 쿼터에서
    //   뺀다(원장은 워커가 실제로 태울 때 정본으로 갱신된다 — 여기서 원장을 미리 건드리지 않는다).
    const jobPlannedUnits = (laneBudget?.lowCostUnits ?? 0)
      + (sliceArmSlots.keyword + sliceArmSlots.broad + sliceArmSlots.topic > 0
        ? Math.ceil(resultLimit / 50) * YOUTUBE_SEARCH_UNITS_PER_CALL
        : 0);
    const discoveryLane = floorLane ? "candidate_pool_floor" : "campaign_shortfall";
    const queueResult = await queueScheduledCampaignYtDlpDiscovery({
      campaignId,
      data: {
        campaignId,
        campaignRef: `campaigns/${campaignId}`,
        gameId: stringField(campaign, "gameId", stringField(campaign, "programId", "flu-casual")),
        // HIGH-1: 우주 전체(최대 40)가 아니라 위에서 고른 절단 후 창(<=12)을 넘긴다 — 이게 그대로
        // queueYtDlpDiscovery 가 run/job 문서에 실어 materialize 시점에 다시 읽힐 실검색 키워드다.
        keywords: harvestKeywords,
        resultLimit,
        countryTargeting: campaign.countryTargeting,
        filters: {
          categories: stringArrayField(targetingCriteria.categories, 30),
          excludeKeywords: stringArrayField(targetingCriteria.excludeKeywords, 40),
          minFollowers: numberField(targetingCriteria, "minFollowers", 0),
          maxFollowers: numberField(targetingCriteria, "maxFollowers", 20_000_000),
          recentActivityDays: numberField(targetingCriteria, "recentActivityDays", 7),
          // R23-2c: 검색 다양화 전용 region 힌트(회전 또는 운영자 명시) — searchYouTubeLive 의
          // regionCode/relevanceLanguage 에만 쓰인다. 크리에이터 국가 판정은 countryTargeting(위
          // 필드, 그대로 유지)이 전담하며 이 값과 무관하다.
          regions: searchRegions,
        },
        // R23-2b: 완료 시점(discovery.ts processDiscoveryQueue)에 같은 슬라이스로 원장을 되찾기 위한
        // 키. queueYtDlpDiscovery 는 이 필드를 검색 파라미터로 쓰지 않고 잡/런 문서에 그대로 싣기만
        // 한다.
        sliceHash,
        // R27: 이번 pass 밴딧 배분(sliceType 영속 — 수용기준⑤) + 분류 게이트용 렉시콘. shortfall<=0
        // (floor 레인)에서도 함께 싣는다 — keyword 암 배분이 대부분을 차지하도록
        // allocateSliceArmSlots 자체가 이미 EWMA 로 자연 수렴하므로 별도 스코프 분기가 필요 없다.
        sliceArmSlots,
        lexicon: campaignLexicon,
      },
      actorUserId: "system-campaign-shortfall-discovery",
      actorRole: "admin",
      // R16-2: 스윕 임계 경로다 — 잡 문서만 만들고 즉시 반환한다. 인라인 프리뷰 검색(외부 API)을
      // 여기서 기다리면 승인·발송 패스보다 앞에서 캠페인 20개를 순차로 막는다. 실제 검색·적재는
      // 기존 processDiscoveryQueue 5분 워커가 한다.
      deferPreviewMaterialization: true,
    });

    await Promise.all([
      adminDb.collection("workflow_jobs").doc(queueResult.runId).set({ shortfallDiscoveryLane: discoveryLane }, { merge: true }),
      adminDb.collection("discovery_runs").doc(queueResult.runId).set({ shortfallDiscoveryLane: discoveryLane }, { merge: true }),
    ]);

    await adminDb.collection("campaigns").doc(campaignId).set({
      // R17-1: 정본 필드에만 쓴다. 구 이름으로 되돌리면 준비 결과 보고와 다시 충돌한다.
      // R21-3: 수확 상태(소진·대기·재개·잔여추정)를 R20 텔레메트리와 같은 자리에 남긴다.
      ...(quota ? {
        shortfallDiscoveryQuota: {
          atIso: nowIso,
          state: "queued",
          remainingUnitsEstimate: quota.remainingUnits,
          nextResetIso: quota.nextResetIso,
          resultLimit,
          requestedResultLimit: desiredResultLimit,
        },
      } : {}),
      // R24: expandedKeywords 는 이번 pass 에 실제로 바뀌었을 때만 쓴다(prune 로 빠진 항목·mine 으로
      // 늘어난 항목이 있을 때) — 변화가 없으면 targetingCriteria 자체를 건드리지 않는다(merge 라
      // 다른 targetingCriteria 하위 필드는 어느 쪽이든 영향받지 않는다).
      ...(expansionNextExpandedKeywords ? { targetingCriteria: { expandedKeywords: expansionNextExpandedKeywords } } : {}),
      // W58-라2: **실제 enqueue 성공 지점**. 여기서만 pass 집합에 넣는다 — 게이트에 막혀 돌아간
      // pass 는 등록되지 않으므로 꼬리 floor 루프가 과차단되지 않는다.
      // W58-Δ3 [Codex 델타]: 정상 enqueue 가 됐으면 B-2 의 스킵 사유는 더 이상 현재 상태가 아니다.
      // 남겨 두면 stale 경고가 화면·감시에 상시로 뜬다(경고 피로 = 신호 사망).
      shortfallDiscoverySkip: FieldValue.delete(),
      shortfallDiscoveryState: {
        lastJobId: queueResult.runId,
        lastJobRef: queueResult.jobRef,
        // W115-R1 [MEDIUM]: floor 레인 잡은 자기 축에도 남긴다 — 활성 잡 dedup 이 "이 활성 잡이
        //   어느 레인의 것인가"를 판정해 shortfall 잡을 막지 않게 하는 근거다(위 dedup 주석).
        ...(floorLane ? { lastFloorJobRef: queueResult.jobRef } : {}),
        // W58-B1: 레인별 간격 도장. 두 레인이 한 필드를 공유하면 shortfall 이 floor 를 영구 기아시킨다.
        // 읽기측(lastEnqueuedFieldName)과 **같은 이름**을 써야 한다 — 어긋나면 게이트가 통째로 무력해진다.
        [lastEnqueuedFieldName]: nowIso,
        dailyWindowStartIso: dailyWindowFresh ? state.dailyWindowStartIso : nowIso,
        dailyCount: dailyCount + 1,
        // R23-1: 이 잡이 **왜** 큐잉됐는지 남긴다. 부족분 수확과 재고 하한 수확은 운영 대응이 다르다
        // (전자는 이 캠페인 목표, 후자는 풀 전체) — 사유가 없으면 잡 이력만 보고 구분할 수 없다.
        lastEnqueueReason: shortfall > 0 ? "campaign_shortfall" : "candidate_pool_floor",
        lastEnqueueShortfall: harvestShortfall,
        // R23-2c: 다음 harvest 가 다른 리전을 고르도록 커서를 전진시킨다. 운영자가 region 을
        // 명시한 캠페인(nextRotationIndex null)은 회전 축이 없으므로 커서를 건드리지 않는다.
        ...(nextRotationIndex !== null ? { regionRotationIndex: nextRotationIndex } : {}),
        // R24: 슬라이스 소속 맵 + 감사 관측 링버퍼. shortfall<=0(floor 레인)에서는 null 이라 이
        // 캠페인 문서의 keywordExpansion 하위 필드는 건드리지 않는다(merge 특성상 생략 키는 보존).
        ...(keywordExpansionStateWrite ? { keywordExpansion: keywordExpansionStateWrite } : {}),
        // R30-1 [사용자 승인 · "LLM wiki 처럼 구조화"]: 키워드 코퍼스 원장. 캠페인 문서 안 additive
        // 맵이라 **새 컬렉션 0**이고, expandedKeywords(string[]) 는 이 원장의 active 투영으로 계속
        // 채워져 소비처·엔진은 아무 것도 바뀌지 않는다(하위 호환).
        ...(keywordCorpusWrite ? { keywordCorpus: keywordCorpusWrite } : {}),
        // R27 수용기준⑤: 밴딧 EWMA 원장 — 이번 pass 가 직전 잡 결과를 실제로 반영했을 때만 쓴다
        // (참조부등호로 판정, applySliceArmEwmaUpdate 가 새 객체를 만들 때만 sliceArmLedger 가
        // priorSliceArmLedger 와 달라진다). 갱신 근거가 없으면 원장을 건드리지 않는다(merge 보존).
        ...(sliceArmLedger !== priorSliceArmLedger ? { sliceArmLedger } : {}),
        // W115 C1·C3: 같은 참조부등호 규율 — 갱신 근거가 없으면 원장을 건드리지 않는다.
        ...(armCostLedger !== priorArmCostLedger ? { armCostLedger } : {}),
        ...(armYieldLedger !== priorArmYieldLedger ? { armYieldLedger } : {}),
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    // W58-라2: 상태 쓰기까지 성공한 **이 지점**이 "잡을 넣었다"의 유일한 참이다.
    // 여기서만 pass 집합에 등록한다 — 게이트에 막혀 조기 return 한 경로는 등록되지 않으므로
    // 꼬리 floor 루프가 과차단되지 않고, 같은 pass 이중 enqueue 가드는 그대로 유지된다.
    // W115-R1 [HIGH 4]: 호출부가 예산을 깎는 근거도 정확히 이 지점이다(측정 성공이 아니다).
    enqueued = true;
    plannedUnits = jobPlannedUnits;
    recordPassEnqueue(campaignId);
  } catch (error) {
    console.warn("[campaign-shortfall-discovery] enqueue failed", {
      campaignId,
      errorCode: errorCodeForLog(error),
    });
  }
  // HIGH: 정상 완료(잡 큐잉 성공)든 catch 로 빠졌든, 이 시점의 measured 값을 그대로 들고 나간다 —
  // 예외가 측정 이후 단계(예: queueYtDlpDiscovery)에서 났다면 측정 자체는 이미 Firestore 에
  // 반영됐으므로 true 가 맞다.
  // W115-R1 [HIGH 4]: `enqueued` 는 상태 쓰기까지 성공한 지점에서만 true 가 된다(아래 recordPassEnqueue
  // 와 같은 지점) — catch 로 빠진 pass 는 false 다. 측정 성공을 큐잉 성공으로 읽던 결합을 끊는다.
  return { measured, enqueued, ...(plannedUnits > 0 ? { plannedUnits } : {}) };
}

/**
 * T4: refill pass 결과를 캠페인 문서에 영속한다 — `lastRefillAtIso` · `lastRefillCounts` ·
 * `lastRefillErrorCode`. 지금까지는 `console.warn` 뿐이라 **조용한 정체**였다(운영자는 왜 안 차는지
 * 볼 수 없었다). 기록 실패가 보충 자체를 깨뜨리면 안 되므로 여기서 삼키고 경고만 남긴다.
 * ⚠️ 새 컬렉션을 만들지 않는다 — 기존 campaigns 문서에 필드로 붙인다.
 */
const REFILL_FAILURE_DIAGNOSTIC_LIMIT = 200;

function sanitizeRefillFailureDiagnostic(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, "[redacted-email]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted-google-key]")
    .replace(/\b(sk-[0-9A-Za-z_-]{12,})\b/g, "[redacted-api-key]")
    .replace(/\bprompt\s*[:=].*$/gi, "prompt=[redacted]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization|prompt)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REFILL_FAILURE_DIAGNOSTIC_LIMIT);
}

/**
 * R35-2(a): 문자열 코드가 없는 런타임 예외만 제한적으로 진단한다. 로그·캠페인 문서 양쪽이 같은
 * 비밀정보 제거 규칙을 사용하도록 순수함수로 고정한다.
 */
export function refillCodelessErrorDiagnostics(
  error: unknown,
  errorCode: string,
): { failureMessage: string; failureFrame: string; failureNumericCode?: number; failurePhase?: string } | null {
  if (errorCode !== "auto_refill_failed") return null;
  const failure = error as { code?: unknown; refillPhase?: unknown };
  const rawMessage = error instanceof Error ? error.message : String(error);
  const rawFrame = error instanceof Error && typeof error.stack === "string"
    ? error.stack.split("\n").find((line) => line.trim().startsWith("at"))?.trim() ?? ""
    : "";
  // R36-5: 앱의 선두 숫자(`2 targets failed`)를 gRPC code로 오인하지 않는다. 숫자 뒤에
  // 표준 UPPER_SNAKE status 이름(3자 이상)이 있는 grpc-js 형식만 메시지 폴백으로 인정한다.
  const messageCodeMatch = /^\s*(\d{1,2})\s+[A-Z][A-Z_]{2,}\b/.exec(rawMessage);
  const messageCode = messageCodeMatch ? Number(messageCodeMatch[1]) : Number.NaN;
  const failureNumericCode = typeof failure.code === "number" && Number.isFinite(failure.code)
    ? failure.code
    : Number.isInteger(messageCode) && messageCode >= 0 && messageCode <= 16
      ? messageCode
      : undefined;
  return {
    failureMessage: sanitizeRefillFailureDiagnostic(rawMessage),
    failureFrame: sanitizeRefillFailureDiagnostic(rawFrame),
    ...(failureNumericCode !== undefined ? { failureNumericCode } : {}),
    ...(typeof failure.refillPhase === "string" && /^[a-z0-9_]{1,64}$/.test(failure.refillPhase)
      ? { failurePhase: failure.refillPhase }
      : {}),
  };
}

function refillFailurePhase(error: unknown): string | undefined {
  const phase = (error as { refillPhase?: unknown } | null)?.refillPhase;
  return typeof phase === "string" && /^[a-z0-9_]{1,64}$/.test(phase) ? phase : undefined;
}

async function persistRefillOutcome(
  campaignId: string,
  outcome: {
    counts?: {
      scannedRaw: number;
      emailReady: number;
      sendable?: number;
      safetyQuarantinedSkipped: number;
      safetyQuarantineReadBatches: number;
      safetyQuarantineFallbackFailed: number;
      safetyQuarantineLoopDetected: number;
      alreadyTouchedSkipped: number;
      emailIncapableDeprioritized: number;
      safetyPrecheckExcluded: number;
      selected: number;
      shortfall: number;
    };
    /** R16-3: 실패 시 거부 지점이 세어 둔 단계별 카운트(스캔·이메일·dedup 소진 등)를 그대로 싣는다. */
    failureCounts?: Record<string, number>;
    /**
     * R33-1 [적대적 리뷰 LOW-1 · 관측 갭 수리]: **준비 경로**(prepareProgramCampaignTargetsCore)의
     * 단계별 수치. 지금까지 이 함수는 라이브 경로 카운터 몇 개만 남겨, "상류가 왜 대상을 더 만들지
     * 않는가"(오늘의 정체)를 운영 화면에서 짚을 수 없었다. 캠페인 문서에 별도 필드로 붙인다.
     */
    preparationCounts?: Record<string, number>;
    /** R33-1: 자격 거부 사유별 분포(followers_missing·program_scope_mismatch·keyword_mismatch…). */
    eligibilityRejections?: Record<string, number>;
    /** R35-2(a): 코드 없는 예외의 진단 문자열(메시지 앞 200자 · 스택 첫 프레임). 원문 프롬프트·키 금지. */
    failureMessage?: string;
    failureFrame?: string;
    failurePhase?: string;
    /** R36-3: gRPC numeric status. 성공·코드 있는 실패에서는 stale 값을 지운다. */
    failureNumericCode?: number;
    /** R36-5: 보상 삭제 RPC가 실패한 pass의 롤백 대상 수. */
    rollbackFailureCount?: number;
    /** TRAIN31 M4: sanitized provider code for a fail-isolated targeted quarantine query. */
    safetyQuarantineFallbackErrorCode?: string | null;
    /** TRAIN31 M2: explicit null clears a resolved loop latch; omission preserves an unrelated failed pass. */
    safetyQuarantineLoop?: Record<string, unknown> | null;
    errorCode: string | null;
  },
): Promise<void> {
  try {
    const refillCounts = outcome.counts || (outcome.failureCounts && Object.keys(outcome.failureCounts).length > 0)
      ? { ...(outcome.counts ?? {}), ...(outcome.failureCounts ?? {}) }
      : null;
    const preparationCounts = outcome.preparationCounts && Object.keys(outcome.preparationCounts).length > 0
      ? outcome.preparationCounts
      : null;
    const replaceEligibilityRejections = outcome.preparationCounts !== undefined;
    const replaceSafetyQuarantineFallbackError = outcome.safetyQuarantineFallbackErrorCode !== undefined;
    const replaceSafetyQuarantineLoop = outcome.safetyQuarantineLoop !== undefined;
    const write: Record<string, unknown> = {
      lastRefillAtIso: nowIso(),
      // R20: 기존 카운터 맵은 nested key 단위 병합을 유지한다. 아래 mergeFields도 각 key의 FieldPath를
      // 열거해, W5-2의 자격 사유 맵 전량 교체가 다른 진단 맵의 기존 동작을 바꾸지 않게 한다.
      ...(refillCounts ? { lastRefillCounts: refillCounts } : {}),
      // R33-1: 준비 경로 수치·사유 분포는 lastRefillCounts 와 **섞지 않는다** — 라이브/준비 두 갈래의
      // 출처가 한 맵에 뭉개지면 오늘 같은 오진(라이브 수치만 보고 상류를 판단)이 그대로 재발한다.
      ...(preparationCounts ? { lastRefillPreparationCounts: preparationCounts } : {}),
      // W5-2/W5-FIX: 준비 경로를 돈 pass에서만 이 맵을 전량 교체한다. 빈 맵은 이전 nested key를
      // 제거하지만, 준비 전에 난 코드 없는 예외는 직전 유효 진단을 보존한다.
      ...(replaceEligibilityRejections
        ? { lastRefillEligibilityRejections: outcome.eligibilityRejections ?? {} }
        : {}),
      ...(replaceSafetyQuarantineFallbackError
        ? { lastRefillSafetyQuarantineFallbackErrorCode: outcome.safetyQuarantineFallbackErrorCode }
        : {}),
      ...(replaceSafetyQuarantineLoop
        ? { lastRefillSafetyQuarantineLoop: outcome.safetyQuarantineLoop }
        : {}),
      // 마지막 오류와 같은 pass의 진단이어야 한다. 성공·코드 있는 실패에서는 null로 지워 stale 진단을 막는다.
      lastRefillFailureMessage: outcome.failureMessage ?? null,
      lastRefillFailureFrame: outcome.failureFrame ?? null,
      lastRefillFailurePhase: outcome.failurePhase ?? null,
      lastRefillFailureNumericCode: outcome.failureNumericCode ?? null,
      lastRefillRollbackFailureCount: outcome.rollbackFailureCount ?? null,
      lastRefillErrorCode: outcome.errorCode,
    };
    const mergeFields: Array<string | FieldPath> = [
      "lastRefillAtIso",
      ...Object.keys(refillCounts ?? {}).map((key) => new FieldPath("lastRefillCounts", key)),
      ...Object.keys(preparationCounts ?? {}).map((key) => new FieldPath("lastRefillPreparationCounts", key)),
      // Top-level merge field replaces the whole map instead of recursively merging stale reason keys.
      ...(replaceEligibilityRejections ? ["lastRefillEligibilityRejections"] : []),
      ...(replaceSafetyQuarantineFallbackError ? ["lastRefillSafetyQuarantineFallbackErrorCode"] : []),
      ...(replaceSafetyQuarantineLoop ? ["lastRefillSafetyQuarantineLoop"] : []),
      "lastRefillFailureMessage",
      "lastRefillFailureFrame",
      "lastRefillFailurePhase",
      "lastRefillFailureNumericCode",
      "lastRefillRollbackFailureCount",
      "lastRefillErrorCode",
    ];
    await adminDb.collection("campaigns").doc(campaignId).set(write, { mergeFields });
  } catch (error) {
    console.warn("[campaign-auto-refill] outcome persist failed", {
      campaignId,
      errorCode: errorCodeForLog(error),
    });
  }
}

/**
 * R18 [HIGH-2]: 승인 실패를 캠페인 문서에 영속한다. 지금까지 console.error 뿐이라, 승인이 매 tick
 * 튕겨 행이 잼인 상태에서도 refill 텔레메트리는 lastRefillErrorCode=null 이라 카드가 "성공" 배지를
 * 띄웠다. 관측 표면이 잼을 성공으로 보고하면 없느니만 못하다. lastRefillErrorCode 와 같은 패턴으로
 * 삼키고 경고만 남긴다(기록 실패가 스윕을 깨뜨리면 안 된다).
 */
async function persistApprovalOutcome(
  campaignId: string,
  outcome: { approved: number; errorCode: string | null },
): Promise<void> {
  try {
    await adminDb.collection("campaigns").doc(campaignId).set({
      lastApprovalAtIso: nowIso(),
      lastApprovalCount: outcome.approved,
      lastApprovalErrorCode: outcome.errorCode,
    }, { merge: true });
  } catch (error) {
    console.warn("[campaign-auto-approval] outcome persist failed", {
      campaignId,
      errorCode: errorCodeForLog(error),
    });
  }
}

async function backfillExistingPoolEmailsForAutomaticRefill(
  campaignId: string,
  campaign: Record<string, unknown>,
  resultCap: number,
): Promise<void> {
  const targetingCriteria = isRecord(campaign.targetingCriteria) ? campaign.targetingCriteria : {};
  const keywords = resolveOwnedCriteriaKeywords([
    { record: campaign, keys: ["includeKeywords", "keywords"] },
    { record: targetingCriteria, keys: ["includeKeywords", "keywords"] },
  ]);
  const categories = stringArrayField(targetingCriteria.categories, 12);
  await triggerScopedCampaignDiscovery({
    campaignId,
    programId: stringField(campaign, "programId", stringField(campaign, "canonicalProgramId", "")),
    programPolicyRef: stringField(campaign, "programPolicyRef", stringField(campaign, "programRef", "")) || undefined,
    candidateCriteriaSnapshot: isRecord(campaign.candidateCriteriaSnapshot) ? campaign.candidateCriteriaSnapshot : undefined,
    eligibilityCriteriaSnapshot: isRecord(campaign.eligibilityCriteriaSnapshot) ? campaign.eligibilityCriteriaSnapshot : undefined,
    gameId: stringField(campaign, "gameId", stringField(campaign, "programId", "scp-automation")),
    keywords,
    categories,
    excludeKeywords: stringArrayField(campaign.excludeKeywords, 20),
    countryTargeting: requestedCampaignCountryTargeting(campaign),
    regions: stringArrayField(targetingCriteria.regions, 12),
    minFollowers: numberField(targetingCriteria, "minFollowers", 0),
    maxFollowers: numberField(targetingCriteria, "maxFollowers", Number.MAX_SAFE_INTEGER),
    recentActivityDays: numberField(targetingCriteria, "recentActivityDays", 90),
    actorUserId: CAMPAIGN_AUTO_REFILL_ACTOR_UID,
    actorRole: "admin",
    backfillExistingPool: true,
    publicWebBackfillOnly: true,
    persistScopedResults: true,
    resultCap: Math.max(1, Math.min(resultCap, 30)),
  });
}

async function refillAutomaticCampaign(
  campaignId: string,
  campaign: Record<string, unknown>,
  // W58-M1 [독립 리뷰]: W58-1 은 pass 예산에 맞춰 **웨이브 크기**(remaining)를 줄인다. 그런데 발굴
  // 축(shortfall enqueue · counts.shortfall · 키워드 자가확장의 inventory 근거)은 "이 캠페인이 실제로
  // 얼마나 모자라는가"를 봐야 한다 — 클램프값으로 재면 클램프가 걸릴 때마다 발굴이 통째로 꺼진다
  // (W58-2 가 끊으려던 결합을 다른 축으로 되살리는 셈이다). 웨이브 크기와 부족량을 분리한다.
  // 미전달이면 종전과 동일하게 remaining 을 쓴다(타 호출부 무영향).
  remaining: number,
  trueRemaining: number = remaining,
): Promise<number> {
  if (remaining <= 0) return 0;
  const preparedRefPaths: string[] = [];
  const programId = stringField(campaign, "programId", "");
  if (!programId) return 0;
  // R38: automatic refill is one bounded wave per pass. Clamp only this synthesized request;
  // direct/manual create requests still hit campaign_live_wave_cap_exceeded, while committed-row
  // based campaignRefillRemaining naturally carries the rest into later passes.
  const waveCap = await runRefillPhase("refill_wave_config_read", readLiveCampaignWaveCap);
  const waveTotal = Math.max(1, Math.min(remaining, waveCap));
  // Automatic refill already sizes the wave to its fair deadline/read budget.  The three source
  // windows must not still read the configured floor (400 in production) when that small wave is
  // all this pass can safely process.  `0` remains unset and normalizes through the configured
  // floor; operator-provided positive limits retain their existing ceiling before this lane only
  // narrows it.  Manual create and preview never enter this helper.
  const configuredScanLimit = campaignTargetScanWidth(
    numberField(campaign, "targetScanLimit", 0),
    await runRefillPhase("refill_scan_config_read", readCampaignTargetScanFloor),
  );
  const automaticRefillScanLimit = Math.min(
    configuredScanLimit,
    Math.max(waveTotal * 4, waveTotal + 20),
  );
  const owner = stringField(campaign, "owner", stringField(campaign, "ownerName", "—"));
  const request: CallableRequest = {
    auth: {
      uid: CAMPAIGN_AUTO_REFILL_ACTOR_UID,
      token: {
        role: "admin",
        team: stringField(campaign, "ownerTeam", "scp"),
        email: stringField(campaign, "ownerEmail", "") || undefined,
        name: owner,
      },
    },
    data: {
      name: stringField(campaign, "name", "자동 캠페인"),
      programId,
      gameId: stringField(campaign, "gameId", programId),
      owner,
      priority: stringField(campaign, "priority", "보통"),
      source: stringField(campaign, "source", "검색"),
      total: waveTotal,
      // This is an internal automatic-refill request. createCampaignWithPreparedTargets recognizes
      // the trusted actor and applies the same bounded width to initial/refresh collection and
      // preparation's three source queries.
      targetScanLimit: automaticRefillScanLimit,
      targetMetric: stringField(campaign, "targetMetric", "sent"),
      targetValue: Math.max(1, numberField(campaign, "targetValue", remaining)),
      coldMail: isRecord(campaign.coldMail) ? campaign.coldMail : undefined,
      countryTargeting: campaign.countryTargeting,
      excludedCountries: campaign.excludedCountries,
      targetCountries: campaign.targetCountries,
      targetCountryMix: campaign.targetCountryMix,
      includeKeywords: campaign.includeKeywords,
      excludeKeywords: campaign.excludeKeywords,
      targetingCriteria: campaign.targetingCriteria,
      allowInflyOverlap: campaign.allowInflyOverlap === true,
      senderName: stringField(campaign, "senderName", owner),
      sendSchedule: stringField(campaign, "sendSchedule", "human-review"),
      ...(isRecord(campaign.mailProfile) ? { mailProfile: campaign.mailProfile } : {}),
      ...(isRecord(campaign.mailProfiles) ? { mailProfiles: campaign.mailProfiles } : {}),
      autoApproveLiveSend: true,
      // W57b-1 [Codex 적대 리뷰 NO-GO]: 리필 pass 안에서 **동기 발굴을 돌리지 않는다**.
      // create_wave_discovery 는 자체 데드라인(20s + 120s)만 보고 pass 마감(420s)을 무시해,
      // W57-F4 의 양보 계약을 리필 내부에서 정면으로 깬다 — code=4 재발 경로가 그대로 남는다.
      // 발굴은 비동기 레인이 전담한다: shortfall enqueue(활성 잡·1시간 간격·쿼터 게이트 보유)와
      // 하한 수확(candidatePoolFloor=10000)이 이미 상시 구동 중이다.
      // ⚠️ 실측 확인(W57b): refillContext 경로의 캠페인 문서 쓰기는 admin.ts 의 writeOps 가
      //    `autoRefillEnabled: true` 를 **하드코딩**한다. 5569 의
      //    `autoRefillEnabled: data.autoDiscoverNow === true` 매핑은 **신규 생성 경로 전용**(campaign
      //    객체 통짜 set)이라 이 false 가 자동보충을 꺼뜨리지 않는다 — 별도 제외 가드 불필요.
      autoDiscoverNow: false,
      from: stringField(campaign, "ownerEmail", ""),
    },
    rawRequest: { ip: "0.0.0.0" },
  };
  try {
    const result = await runRefillPhase("refill_campaign_create", () => createCampaignWithPreparedTargets(
      request,
      preparedRefPaths,
      { id: campaignId, campaign },
    ));
    const queued = numberField(result.targeting, "queued", 0);
    const livePreparation = isRecord(result.targeting.preparation)
      ? result.targeting.preparation
      : undefined;
    // T2: 선별(queued) < 잔여(remaining)면 캠페인 저장 키워드로 discovery 잡을 자동 enqueue해
    // 다음 pass를 위해 candidate_pool을 채운다. enqueue는 이번 pass 반환값에 영향을 주지 않는다.
    // W58-M1: **trueRemaining 기준**이다 — 웨이브를 예산으로 줄였다는 사실이 "부족하지 않다"로
    // 읽히면 안 된다(shortfall 은 발굴 잡의 resultLimit 근거이기도 해서 작게 발주되는 것까지 왜곡된다).
    const shortfall = Math.max(0, trueRemaining - queued);
    if (shortfall > 0) await enqueueShortfallDiscoveryJob(campaignId, campaign, shortfall);
    // T4: 이 pass 가 무엇을 보고 무엇을 걸렀는지 캠페인 문서에 남긴다. 예전에는 console.warn 뿐이라
    // 운영자는 "왜 안 차는지" 화면에서 볼 수 없었고, 정체가 조용했다(오늘 정체도 이 필드가 있었으면
    // 바로 보였다). 실패 경로는 호출부가 errorCode 를 남긴다.
    await persistRefillOutcome(campaignId, {
      counts: {
        scannedRaw: numberField(livePreparation ?? {}, "scannedRaw", 0),
        emailReady: numberField(result.targeting, "emailReady", 0),
        ...(livePreparation ? { sendable: numberField(livePreparation, "sendable", 0) } : {}),
        safetyQuarantinedSkipped: numberField(result.targeting, "safetyQuarantinedSkipped", 0),
        safetyQuarantineReadBatches: numberField(result.targeting, "safetyQuarantineReadBatches", 0),
        safetyQuarantineFallbackFailed: numberField(result.targeting, "safetyQuarantineFallbackFailed", 0),
        safetyQuarantineLoopDetected: 0,
        alreadyTouchedSkipped: numberField(result.targeting, "alreadyTouchedSkipped", 0),
        safetyPrecheckExcluded: numberField(result.targeting, "safetyPrecheckExcluded", 0),
        // R17-5: 오염 밴드 규모를 화면까지 들고 온다 — 규모가 안 보이면 이메일 확보율 저하의 원인을
        // "풀이 말랐다"로 오진한다.
        emailIncapableDeprioritized: numberField(
          livePreparation ?? {},
          "emailIncapableDeprioritized",
          0,
        ),
        selected: queued,
        shortfall,
      },
      // R33-1: 준비 경로 단계별 수치·자격 거부 사유 분포를 그대로 싣는다(값은 이미 응답에 있었고
      // 여기서 버려지고 있었다 — 그래서 운영에서 상류 절단 지점을 볼 수 없었다).
      preparationCounts: livePreparation
        ? Object.fromEntries(
          Object.entries(livePreparation)
            .filter(([, value]) => typeof value === "number" && Number.isFinite(value)),
        ) as Record<string, number>
        : undefined,
      eligibilityRejections: isRecord(result.targeting.preparationEligibilityRejections)
        ? Object.fromEntries(
          Object.entries(result.targeting.preparationEligibilityRejections)
            .filter(([, value]) => typeof value === "number" && Number.isFinite(value)),
        ) as Record<string, number>
        : undefined,
      safetyQuarantineFallbackErrorCode:
        stringField(result.targeting, "safetyQuarantineFallbackErrorCode", "") || null,
      safetyQuarantineLoop: null,
      errorCode: null,
    });
    return queued;
  } catch (error) {
    await rollbackPreparedProgramTargets(preparedRefPaths, "campaign_auto_refill_failed", error);
    // R16-1: 풀이 **완전히 마르면** createCampaignWithPreparedTargets 가 던진다
    // (campaign_targets_no_email_ready / _all_suppressed / _all_already_touched). 예전 T2 는 성공
    // 경로에만 enqueue 를 걸어 두어, **발굴이 가장 필요한 순간에 정확히 발동하지 않았다**(리뷰어 프로브:
    // dry pool → 잡 0건). 같은 rate limit 을 그대로 태워 여기서도 넣는다.
    // enqueue 가 원래 오류를 가리면 안 되므로 실패는 삼키고 rethrow 는 그대로 한다.
    // W57b-2 [Codex 적대 리뷰 MAJOR-2]: **양보는 종료지 추가 작업 진입점이 아니다.**
    // 마감으로 중단된 pass 에서 발굴 잡을 새로 넣으면, 예산을 지키려 멈춘 그 자리에서 다시 쓰기와
    // 쿼터 계측을 태운다(마감 초과 상태로 enqueue → 다음 pass 예산까지 잠식). 풀 고갈로 던진
    // campaign_targets_* 만 "발굴이 가장 필요한 순간"이고, 마감 양보는 그 반대다.
    const refillErrorCode = typeof (error as { errorCode?: unknown }).errorCode === "string"
      ? (error as { errorCode: string }).errorCode
      : "";
    const refillErrorMessage = error instanceof Error ? error.message : String(error ?? "");
    const yieldedOnDeadline = refillErrorCode.startsWith("campaign_refill_deadline_yield");
    const poolExhaustedForBackfill = [
      "campaign_live_wave_no_targets",
      "campaign_targets_no_email_ready",
    ].includes(refillErrorCode)
      || refillErrorMessage.includes("live-send campaign has no program-linked fresh target")
      || refillErrorMessage.includes("no email-ready targets");
    if (!yieldedOnDeadline) {
      if (poolExhaustedForBackfill) {
        try {
          // R23-3: W57b forbids full synchronous discovery in refill, but the quota-free public-web
          // enrichment lane is the exact existing-pool repair path. Keep it bounded and skip YouTube search.
          await backfillExistingPoolEmailsForAutomaticRefill(campaignId, campaign, trueRemaining);
        } catch (backfillError) {
          console.warn("[campaign-auto-refill] public-web backfill failed", {
            campaignId,
            errorCode: errorCodeForLog(backfillError),
          });
        }
      }
      try {
        // W58-M1: 성공 경로와 같은 축이다 — 풀 고갈로 던진 경우의 발주 크기도 **실제 부족량** 기준이어야
        // 한다(클램프값을 쓰면 예산으로 줄인 pass 마다 발굴 잡이 작게 나간다).
        await enqueueShortfallDiscoveryJob(campaignId, campaign, trueRemaining);
      } catch (enqueueError) {
        console.warn("[campaign-shortfall-discovery] exhausted-pool enqueue failed", {
          campaignId,
          errorCode: errorCodeForLog(enqueueError),
        });
      }
    }
    throw error;
  }
}

// TASK 3 automatic mode: unconditional approval sweep. For campaigns created with
// autoApproveLiveSend=true, approves every queued_for_review outreach row by reusing the exact
// approveCampaignOutreach core (CAS claims, evidence fingerprints, hard live-send safety recheck)
// under a trusted system actor — the schedule itself is the authorization, mirroring the
// scpOutreach SYSTEM_ACTOR pattern. Human review remains the default for all other campaigns.
// Retained safety: wave cap at creation, per-row mail-safety recheck at approval, daily caps +
// suppression + dedup at send time, and the global mail safety switch.
/**
 * W43 F-2 [운영 실사고 2026-08-05 · 2차]: 승인은 **오늘 남은 발송 여유**를 넘겨 승인하지 않는다.
 * 실측 — 캡 잔여 277 인데 승인 대기 471 행을 쌓아 두고도 pass 당 50건씩 계속 승인해 스윕 예산을
 * 태우고 code=4 를 만들었다. 승인은 발송의 준비 단계라, 발송이 소화 못 하는 양을 만드는 것 자체가
 * 발송부 기아의 원인이다. 발송 워커와 **같은 정본**을 읽는다(캡=settings.automation
 * .maxDailyOutreachSends · 누계=발송 워커가 올리는 campaign_outreach_daily_counters/{KST일자}.sent ·
 * 대기=aggregate count, 본문 미독으로 W20 힙 OOM 회피). 승인을 **줄이는** 방향으로만 쓴다.
 */
async function readApprovalSendHeadroom(nowMs: number): Promise<{ dailyCap: number; sentToday: number; pendingApproved: number; headroom: number }> {
  const settings = await readSettings();
  const dailyCap = Math.max(0, Math.round(settings.automation.maxDailyOutreachSends));
  const [counter, pending] = await Promise.all([
    adminDb.collection("campaign_outreach_daily_counters").doc(koreaDayKeyFrom(new Date(nowMs))).get(),
    adminDb.collection("campaign_outreach").where("deliveryState", "in", ["approved", "processing"]).count().get(),
  ]);
  const sentToday = Math.max(0, Math.round(numberField(counter.data() ?? {}, "sent", 0)));
  const pendingApproved = Math.max(0, Math.round(pending.data().count ?? 0));
  return { dailyCap, sentToday, pendingApproved, headroom: Math.max(0, dailyCap - sentToday - pendingApproved) };
}

/**
 * W127 [운영 실사고 2026-09-16 야간]: 승인·리필 예산은 pass 당 **공유 총량**이다 — document-id 순으로
 * 먼저 오는 캠페인이 그 총량을 혼자 다 쓰면, 뒤 캠페인은 같은 pass 에서 남는 게 없다(두 라이브
 * 캠페인이 전역 캡 하나를 나눠 쓰다가 한쪽이 굶은 사고). 캠페인 수로 나눈 **공정 몫**을 추가
 * 상한으로 건다 — 순수 함수(파이어스토어 접근 없음, 단위 테스트용). 캠페인이 1개면
 * `Math.max(1, ...)` 가 분모를 1로 고정해 총량 그대로 나온다(기존 동작과 동일 — 이 축이 실제로
 * 조이는 것은 캠페인이 2개 이상일 때뿐이다).
 */
export function perCampaignFairShare(totalBudget: number, activeCampaignsThisPass: number): number {
  return totalBudget / Math.max(1, activeCampaignsThisPass);
}

/**
 * 0.6.110 [리필 처리량]: 리필이 **소진된** 캠페인은 pass 의 공정 몫 분모에서 빼고 이번 pass 의 리필 웨이브도
 * 시작하지 않는다 — 안 그러면 후보가 이미 전원 기접촉인 캠페인(사전순으로 먼저 오는 쪽)이 자기 몫만큼의
 * 스캔 시간/읽기를 헛되이 태우고, 활성 캠페인은 총량을 나눠 받아 처리량이 줄었다(전역 예산은 올리지 않는다 —
 * 과거 OOM 사고).
 *
 * 소진 판정(셋 다 참일 때만):
 *   ① 마지막 리필 결과가 `campaign_targets_all_already_touched` (lastRefillErrorCode)
 *   ② 재고 측정이 있고 `candidatePoolInventory.sendableEstimate === 0` (측정 없음 = 모름 → 소진 아님)
 *   ③ 마지막 리필 시각(lastRefillAtIso)이 reincludeAfterMs 안이다 (**N시간이 지나면 자동 재편입** — 한 번 시도하고,
 *      다시 같은 결과면 그 시각이 갱신돼 또 N시간 제외된다)
 * 자동 재편입: 재고 측정이 회복(sendableEstimate>0)되거나 리필이 성공해 lastRefillErrorCode 가 지워지면 ①②가 깨져
 * 즉시 소진이 아니다. 순수 함수(파이어스토어 접근 없음, 단위 테스트용).
 */
export const CAMPAIGN_REFILL_EXHAUSTED_REINCLUDE_MS = 6 * 60 * 60 * 1000;
export function isCampaignRefillExhausted(
  campaign: Record<string, unknown>,
  nowMs: number,
  reincludeAfterMs: number = CAMPAIGN_REFILL_EXHAUSTED_REINCLUDE_MS,
): boolean {
  if (stringField(campaign, "lastRefillErrorCode", "") !== "campaign_targets_all_already_touched") return false;
  const inventory = isRecord(campaign.candidatePoolInventory) ? campaign.candidatePoolInventory : null;
  if (!inventory || typeof inventory.sendableEstimate !== "number" || inventory.sendableEstimate !== 0) return false;
  const lastRefillAtMs = Date.parse(stringField(campaign, "lastRefillAtIso", ""));
  if (!Number.isFinite(lastRefillAtMs)) return false;
  return nowMs - lastRefillAtMs < reincludeAfterMs;
}

/**
 * W127: 다음 pass 가 **회전**(마지막 방문 지점부터 이어서)할지 **처음으로 되감을지**의 순수 판정 —
 * 파이어스토어 접근 없음(단위 테스트용). 회전은 "이번 pass 가 더 있었을 활성 캠페인을 놓쳤을 수
 * 있을 때"만 뜻이 있다 — 그 판정은 이 pass 가 예산(시간·스캔 읽기·활성 캠페인 수) 중 **하나라도**
 * 다 써서 멈췄는지다. 예산이 남았는데 자연 소진됐다면(존재하는 활성 캠페인 전원을 이미 봤다) 회전할
 * 것이 없으므로 ""(처음)를 돌려준다 — 다음 호출이 같은 전원을 다시 보게 하는, 반복 호출로 소수
 * 캠페인을 계속 도는 기존 동작을 보존한다.
 */
export function nextCampaignScanCursorId(input: {
  lastVisitedCampaignId: string;
  timeBudgetReached: boolean;
  scanReadBudgetReached: boolean;
  activeProcessed: number;
  campaignLimit: number;
}): string {
  const passMayHaveLeftActiveCampaignsUnprocessed =
    input.timeBudgetReached || input.scanReadBudgetReached || input.activeProcessed >= input.campaignLimit;
  return passMayHaveLeftActiveCampaignsUnprocessed ? input.lastVisitedCampaignId : "";
}

/**
 * W127-후속 [운영 실측 2026-09-19]: 리필 웨이브의 **실행 마감** — 스윕 마감·리필 전용 잔여·
 * 캠페인 공정 몫의 min. 종전에는 공정 몫이 웨이브 **사이징**(affordableRows)에만 들어가고
 * 실행 마감은 글로벌 상한뿐이라, 문서 id 순 첫 캠페인(XP)이 자기 몫(45s)을 넘는 스캔
 * (~79s·~4,000 reads 실측)으로 뒤 캠페인(뽀로로)의 잔여 예산을 음수로 만들어 매 pass
 * "refill budget cannot afford a wave" 가 반복됐다. 승인 측은 이미 루프 안에서 몫을
 * 집행한다 — 리필도 같은 대칭으로 맞춘다. 순수 함수(파이어스토어 접근 없음, 단위 테스트용).
 * 캠페인이 1개면 몫=총량이라 기존 동작과 동일하다.
 */
export function refillWaveDeadlineMs(input: {
  nowMs: number;
  sweepDeadlineMs: number;
  refillScanTimeBudgetMs: number;
  refillSpentMs: number;
  perCampaignRefillTimeBudgetMs: number;
}): number {
  return Math.min(
    input.sweepDeadlineMs,
    input.nowMs + Math.max(0, input.refillScanTimeBudgetMs - input.refillSpentMs),
    input.nowMs + Math.max(0, input.perCampaignRefillTimeBudgetMs),
  );
}

/**
 * W127-후속: 리필 웨이브의 증거 **읽기** 상한 — 글로벌 잔여와 캠페인 공정 몫의 min.
 * 시간 마감(양보 에러 → 롤백)과 달리 read cap 은 쿼리 층(runChunkedEvidenceQueries)이
 * 발행 전에 선점해 **점진 절단**(truncated → 증거 판정 fail-closed)되므로 웨이브가 예산
 * 안에서 완료된다 — 둘 중 더 타이트하고 결정적인 상한이다. 스캔 커서 전진은 유지되므로
 * 절단된 웨이브의 진행은 보존된다. 순수 함수(단위 테스트용).
 */
export function refillWaveEvidenceReadCap(input: {
  refillMaxDocumentReads: number;
  refillReadsSpent: number;
  perCampaignRefillReadBudget: number;
}): number {
  return Math.min(
    Math.max(0, input.refillMaxDocumentReads - input.refillReadsSpent),
    Math.max(0, input.perCampaignRefillReadBudget),
  );
}

export async function runCampaignOutreachAutoApprovalSweep(
  // W43 F-1: sweepDeadlineMs — 발송이 예산을 넘긴 만큼 스윕이 줄어든다(발송이 **먼저** 확보).
  // approval/refillTimeBudgetMs 는 테스트 주입점이다(운영 기본값 리필 90s · 승인 60s).
  // refillRowCostMs 는 W58-1 웨이브 사이징의 행당 비용, refillCommitReserveMs 는 커밋 고정비 예약(테스트 주입점).
  options: { campaignLimit?: number; rowLimit?: number; timeBudgetMs?: number; sweepDeadlineMs?: number; approvalTimeBudgetMs?: number; refillTimeBudgetMs?: number; refillRowCostMs?: number; refillCommitReserveMs?: number; maxDocumentReads?: number; refillMaxDocumentReads?: number; refillRowReadCost?: number; refillExhaustedReincludeMs?: number } = {},
): Promise<{
  scanned: number;
  results: Array<{ campaignId: string; refilled?: number; approved: number; errorCode?: string }>;
  timeBudgetReached?: boolean; refillBudgetReached?: boolean; approvalBudgetReached?: boolean;
  /** W58-1: 예산에 맞춰 웨이브를 줄인 캠페인 수(관측용 — 줄인 사실이 안 보이면 정체로 오진한다). */
  refillWaveClamped?: number;
  /** 0.6.110: 리필이 소진돼(전원 기접촉 · 재고 0) 이번 pass 의 웨이브를 시작하지 않은 캠페인 수. */
  refillSkippedExhausted?: number;
  approvalSkippedByHeadroom?: number;
  approvalHeadroom?: { dailyCap: number; sentToday: number; pendingApproved: number; headroom: number };
  /** T0-2: 캠페인 스캔이 읽기 상한(maxDocumentReads)에 걸려 멈췄다는 뜻 — 커서는 discovery_sweep_state 에 저장. */
  scanReadBudgetReached?: boolean;
  /** T4-1: 리필 레인이 **읽기** 예산(refillMaxDocumentReads)에 걸려 웨이브를 못 시작했다는 뜻. */
  refillReadBudgetReached?: boolean;
  /** T4-1: 이 pass 의 리필 레인이 태운 문서 읽기(관측 — 예산이 실제로 어디서 소진되는지). */
  refillReadsSpent?: number;
}> {
  // W57b-3: 증거 조회 계측을 이 pass 로 한정한다. 웜 인스턴스에서 누적되면 fanout 로그의
  // evidenceRoundTrips 가 인스턴스 수명 합계가 되어 pass 비용 관측이 통째로 거짓이 된다.
  resetCampaignEvidenceMetrics();
  const campaignLimit = Math.min(Math.max(options.campaignLimit ?? 20, 1), 20);
  const rowLimit = Math.min(Math.max(options.rowLimit ?? 50, 1), 200);
  // W18 F-2: 스윕 시간 예산. 리필+승인이 스케줄 함수의 deadline 을 통째로 소진해 발송부를 굶기고
  // (2026-08-03 실측: sent 1 고정 · code=4 반복) 잡 손상까지 일으킨 것의 방어선이다. 예산을 넘기면
  // **현재 캠페인까지만** 처리하고 정상 반환한다(throw 아님 — 부분 쓰기 없음, 캠페인 경계에서만 중단).
  // 남은 캠페인은 다음 회차가 잇는다(멱등). 옵션이 없으면 종전과 동일하게 무제한이다.
  const sweepStartedAtMs = Date.now();
  const requestedBudgetMs = typeof options.timeBudgetMs === "number" && options.timeBudgetMs > 0
    ? options.timeBudgetMs
    : Number.POSITIVE_INFINITY;
  // W43 F-1: 발송이 자기 예산(240s)을 초과한 만큼 스윕 예산을 줄인다 — timeout 480s 를 넘겨 code=4 로
  // 잡을 손상시키는 것보다 스윕이 덜 하는 쪽이 항상 낫다(스윕은 멱등 재개, 발송은 굶으면 영구 정체).
  const timeBudgetMs = typeof options.sweepDeadlineMs === "number"
    ? Math.min(requestedBudgetMs, Math.max(0, options.sweepDeadlineMs - sweepStartedAtMs))
    : requestedBudgetMs;
  // W34 F-2: 리필 스캔 전용 예산 — 발송(240s)·스윕(180s)과 같은 방식으로 자체 예산을 준다. 스윕
  // 전체 예산(timeBudgetMs)의 하위 슬라이스라 420s 총합·60s 마진 계약은 그대로다(gate 무수정).
  // 넘기면 이번 pass 리필만 건너뛰고(커서는 F-1이 마지막 회차 것을 이미 보존) 다음 pass 가 잇는다.
  const CAMPAIGN_REFILL_SCAN_TIME_BUDGET_MS = options.refillTimeBudgetMs ?? 90_000;
  // W58-1 [프로드 실측 2026-08-08 · code=4 2회의 공통 형상]: 리필 게이트가 **이분법**이라
  // "돌아도 되는가"만 보고 "이 예산으로 몇 행짜리 웨이브를 감당하는가"를 보지 않았다.
  //
  // 사망 pass(13:35:14 시작, 480.0s/504) 재구성:
  //   +230s  발송 페이즈 종료(자체 240s 예산 준수 — 4/4 pass 일관)
  //   +271s  93행 웨이브 빌드 시작(createdAtIso=13:39:45.697Z 는 빌드 **시작** 도장, admin.ts:4907)
  //   +305s  안전격리 루프 가드 로그
  //   +480s  SIGKILL — 93행 중 승인 0건, 웨이브만 커밋됨
  // 즉 93행 웨이브 하나가 **최소 209s**(≥2.25s/행)를 먹었고, 시작 시점의 잔여 스윕 예산은 ~150s 였다.
  // 07:20 사망 pass 도 같은 형상이다(~99행 웨이브 → 480s).
  //
  // W57-F4 의 단계 경계 양보로는 못 막는다 — 비용의 대부분이 `live_draft_safety`(민트+본문 컴파일+
  // safety) **단일 phase 안**이라 경계가 오지 않는다. 그래서 들어가기 전에 **크기를 예산에 맞춘다**.
  // 이월은 싸다(5분 주기·멱등 재개)이므로 줄이는 방향으로만 작동한다.
  const CAMPAIGN_REFILL_ROW_COST_MS = options.refillRowCostMs ?? 2_500;
  // T4-1 [읽기 비용 · 2026-09-05 · 8/6 회귀의 재발 방지]: 리필 예산을 **시간에서 읽기로** 옮긴다.
  //
  // 8/6 W34(스캔 창 회전)는 "같은 구간을 반복 조회한다"를 고쳤지만 **스캔이 언제 멈추는가**는
  // 안 고쳤다 — 여전히 시간으로 끝났고, 풀이 자라자 비용이 3배로 돌아왔다. 시간 예산은 "할 일이
  // 0건이어도 시간이 남으면 계속 읽는다"라, 비용이 최소여야 할 상황(재고 소진)에서 최대가 되는
  // 방향이 뒤집힌 형상이다. 읽기 예산은 풀 크기와 무관하게 pass 비용을 **상수로 묶는다**.
  //
  // 시간 예산은 **제거하지 않는다** — 2차 방어선으로 그대로 둔다(둘 중 이른 쪽이 물린다).
  // 읽기가 싸도 시간이 마르는 경우(느린 왕복·재시도)가 실제로 있었고, 그때 480s 강제종료를
  // 막는 것은 시간 쪽이다(W58-1 code=4 2회).
  //
  // 계측 출처는 `readCampaignEvidenceMetrics().documentReads` — 리필의 지배적 읽기인 접촉 증거
  // 조인(readMessageSourceOutreachTouchKeys · readExistingOutreachTouchKeys ·
  // readColdmailHistoryTouchKeys)이 전부 runChunkedEvidenceQueries 를 지나므로 그 합이 곧
  // "웨이브 크기에 비례하는" 읽기다. 고정비 스캔(candidate_pool 등)은 이미 scanLimit 으로 유계다.
  //
  // 기본값 5,000 은 리포트 §07 ③ 의 "pass 당 읽기 상한 5,000" 전제와 같은 수다. 오늘의 웨이브
  // 크기(≤100행)에서는 물리지 않으므로 **현행 동작 무변경**이고, 풀이 커져도 그 이상으로는 안 큰다.
  const CAMPAIGN_REFILL_MAX_DOCUMENT_READS = Math.max(1, Math.trunc(options.refillMaxDocumentReads ?? 5_000));
  // 행당 읽기 비용 모델. CAMPAIGN_REFILL_ROW_COST_MS 와 **같은 역할**을 읽기 축에서 한다
  // (웨이브를 시작하기 전에 크기를 예산에 맞춘다 — 시작하고 나서는 못 끊는 구간이 있다).
  const CAMPAIGN_REFILL_ROW_READ_COST = Math.max(1, Math.trunc(options.refillRowReadCost ?? 6));
  // W58-A3 [Codex 적대 리뷰]: 행당 비용 모델은 웨이브 **빌드**만 재고, 그 뒤 커밋 페어
  // (create_wave_metadata_write + create_wave_queue_write)와 outcome 영속은 행 수와 무관한 **고정비**다.
  // 예약하지 않으면 빌드가 예산을 꽉 채우고 커밋이 예산 밖으로 삐져나간다 — 게다가 커밋 페어는
  // W57-M2 로 **양보 불가 구간**이라 한 번 시작하면 끝까지 간다. 그래서 고정비를 먼저 떼고 사이징한다.
  // (리뷰1 MAJOR-2 가 지적한 "고정비 무시"와 같은 항이다.)
  const CAMPAIGN_REFILL_COMMIT_RESERVE_MS = options.refillCommitReserveMs ?? CAMPAIGN_REFILL_COMMIT_RESERVE_DEFAULT_MS;
  // W43 F-1: 승인 전용 예산. 스윕 전체(180s)의 하위 슬라이스라 420s 총합·60s 마진 계약은 그대로다
  // (게이트 무수정). **두 예산은 각자 소비한 시간으로 센다** — 벽시계로 재면 리필이 늦게 끝난 것만으로
  // 승인 몫이 사라져 한 단계가 다른 단계를 굶는다(오늘 두 사고의 결합이 정확히 그것이다).
  const CAMPAIGN_APPROVAL_TIME_BUDGET_MS = options.approvalTimeBudgetMs ?? 60_000;
  // T0-2 [8/6 회귀의 근인]: 아래 캠페인 스캔 while 루프는 시간 예산(timeBudgetMs)만으로 유계였다.
  // autoApproveLiveSend=true 캠페인 중 활성 상태(programId 有 + operational state active)가 드물면
  // activeProcessed 가 거의 늘지 않아 campaignLimit(20)짜리 페이지를 시간이 남는 한 계속 다시 읽고,
  // 게다가 커서가 함수 로컬이라 pass 마다 처음부터 다시 훑는다 — pass 비용이 시간이 아니라 **풀
  // 크기**에 비례해 커진다(실측 ~140,000 reads/pass). 읽기 자체에 상한을 걸고, 상한에 걸려 멈추면
  // 커서를 영속화해 다음 pass 가 이어받게 한다. 시간 예산은 안전망으로 그대로 둔다(제거하지 않음).
  const CAMPAIGN_SCAN_MAX_DOCUMENT_READS = Math.max(1, Math.trunc(options.maxDocumentReads ?? 5_000));
  let refillSpentMs = 0, approvalSpentMs = 0, approvalSkippedByHeadroom = 0;
  let refillBudgetReached = false, approvalBudgetReached = false;
  // T4-1: 이 pass 의 리필 레인이 실제로 태운 문서 읽기. 시간(refillSpentMs)과 **같은 방식**으로
  // 자기가 쓴 만큼만 센다 — 다른 레인의 읽기까지 물면 리필이 남의 소비로 굶는다.
  let refillReadsSpent = 0;
  let refillReadBudgetReached = false;
  let refillWaveClamped = 0;
  let refillSkippedExhausted = 0;
  let timeBudgetReached = false;
  const results: Array<{ campaignId: string; refilled?: number; approved: number; errorCode?: string }> = [];
  let scanned = 0;
  let activeProcessed = 0;
  // BLOCKER-B [적대적 리뷰 실측 · P-B]: R23-1 원문 주석은 "재고 하한은 전역 지표다(풀은 캠페인
  // 공용)"였다 — BLOCKER-1 이 센서를 캠페인 스코프(campaign_candidates)로 옮기면서 이 전제가 거짓이
  // 됐는데 주석은 그대로 남아 있었다. pass 당 예산 1건(측정 count 2회)은 여전히 유지하되(비용 상한,
  // 리뷰 MEDIUM-2), **어느 캠페인이 그 1건을 쓸지**를 무조건 "이번 pass 에서 먼저 스캔된 캠페인"이
  // 아니라 "가장 오래전에(또는 아직 한 번도) 측정된 캠페인"으로 고른다 — 문서 ID 사전순으로 항상 먼저
  // 스캔되는 캠페인이 매 pass 예산을 가로채 나머지 전원이 영구 기아되는 문제(실측: 3 pass 연속
  // 캠페인 B 의 inventory 가 null)를 없앤다. candidatePoolInventory.atIso 를 재사용한다(새 필드 0) —
  // measureCandidatePoolInventory 가 실제로 호출될 때만 이 값이 갱신되므로, 순수하게 "언제 마지막으로
  // 측정됐는지"의 정직한 근거다.
  const floorHarvestCandidates: Array<{ campaignId: string; campaign: Record<string, unknown>; lastCheckedAtMs: number }> = [];
  // W58-라 [독립 리뷰 델타 · MAJOR]: 같은 pass·같은 캠페인에 발굴 잡이 **두 번** 들어갈 수 있었다.
  // 리필이 잡 A 를 넣고 shortfallDiscoveryState(lastEnqueuedAtIso·lastJobRef)를 갱신해도,
  // 꼬리 floor 루프는 (ㄱ) W58-B1 로 **분리된** lastFloorEnqueuedAtIso 를 보고, (ㄴ) 캠페인 루프
  // **진입 시점 스냅샷**(아래 push 되는 candidate.campaign)의 lastJobRef 를 보므로 잡 A 를 모른다.
  // 결과: 쿼터·비용 2배 + 잡 B 가 lastJobRef 를 덮어써 잡 A 의 밴딧 EWMA 귀속이 유실된다.
  // 게이트 분리(B1)는 옳지만 **같은 pass 안의 중복**까지 막지는 않는다 — 그건 pass 로컬 사실이므로
  // pass 로컬 집합으로 막는다(문서 재조회 0). 리필 성공/실패 양 경로에서 등록한다.
  // W58-라2: pass 집합은 모듈 스코프이고 enqueueShortfallDiscoveryJob 이 성공 시점에 채운다.
  beginPassEnqueueTracking();
  // W43 F-2: pass 당 1회 측정(get 1 + count 1). 이 pass 승인분은 로컬 차감해 캠페인 간에도 여유를
  // 나눠 쓴다 — 캠페인마다 다시 읽으면 같은 여유를 N번 쓴다.
  const approvalHeadroom = await readApprovalSendHeadroom(sweepStartedAtMs);
  // daily-cap-fairness: 캠페인별 dailyCap 클램프(아래 approvalHeadroomLeft)가 보는 것과 **같은
  // KST 달력일**이어야 한다 — 발송 워커(chat-ai.ts campaignDailyCapState)도 이 키를 쓴다.
  const dayKey = koreaDayKeyFrom(new Date(sweepStartedAtMs));
  let approvedThisSweep = 0;
  // W127 [운영 실사고 2026-09-16 야간]: 위 승인 예산·아래 리필 시간/읽기 예산은 전부 **pass 공유
  // 총량**이다 — 캠페인을 document-id 순으로 순회하므로, 사전순으로 먼저 오는 캠페인(XP Hero
  // cp-bd7d1ea7aq4k)이 자기 웨이브/승인 큐를 채우는 동안 총량을 다 써버리면, 뒤 캠페인(Snake
  // Clash×Pororo cp-mu421htee9bn)은 이번 pass 에 **한 번도** 승인·리필을 받지 못하고 매번 굶는다
  // (스윕이 정상 종료해도, 단지 뒤 순번이라는 이유만으로). 캠페인 수로 나눈 **공정 몫**을 총량과
  // 별개의 추가 상한으로 걸어, 한 캠페인이 pass 전체를 독점하지 못하게 한다 — 총 예산 자체는
  // 안 바뀐다(아래 각 사용처가 `Math.min(공유 잔여, 공정 몫)`으로 좁히기만 한다).
  //
  // AR-1 [적대적 리뷰 2026-09-17, HIGH]: 분모를 `autoApproveLiveSend==true` **전체** 개수로 재면
  // 일시정지·완료 캠페인도 섞여 들어와 실제로 순회할 활성 캠페인의 몫이 과소 배분된다.
  // resolveCampaignOperationalState 는 저장 필드 하나가 아니라 취소 상태 접두 판정 +
  // operationalState 열거 + 레거시 status 폴백의 합성값이라(campaignControlCore.ts) Firestore
  // 쿼리 필터로 옮길 수 없다 — 그래서 이 pass 가 실제로 처리할 **첫 페이지**(아래 while 루프가
  // 소비하는 것과 동일한 쿼리 · campaignLimit 로 이미 유계)를 먼저 당겨, 그 안의 active 개수로
  // 분모를 정한다(최소 1 — 활성 캠페인이 1개뿐이어도 총량 그대로 받는다). 아래 while 루프는 이
  // 미리 당긴 첫 페이지를 재사용해 읽기를 중복하지 않는다.
  //
  // T0-2: 재개 커서 — rotatingWindow(admin.ts:1820 부근, W34) 와 같은 형상(사전순 커서 · 페이지가
  // 안 찼으면 끝에 닿은 것으로 보고 다음 pass 에 처음부터 회전)이다. 새 컬렉션을 만들지 않고
  // discovery_sweep_state(W115 이 이미 만든, 같은 성격의 전역 스윕 상태 컬렉션)에 문서만 추가한다 —
  // 캠페인 문서에 얹지 않는 이유는 이 커서가 특정 캠페인이 아니라 **전역 스캔**의 상태이기 때문이다.
  const campaignScanStateRef = adminDb.collection("discovery_sweep_state").doc("campaign_auto_approval_scan");
  let persistedScanCursorId = "";
  try {
    persistedScanCursorId = stringField((await campaignScanStateRef.get()).data() ?? {}, "scanCursorId", "");
  } catch (error) {
    // 커서 읽기 실패는 최적화 손실이지 정확성 손실이 아니다 — 처음부터 훑는다(fail-open).
    console.warn("[campaign-auto-approval] scan cursor read failed; scanning from the start", {
      errorCode: errorCodeForLog(error),
    });
  }
  const campaignScanBaseQuery = (): Query => adminDb.collection("campaigns")
    .where("autoApproveLiveSend", "==", true)
    .orderBy(FieldPath.documentId())
    .limit(campaignLimit);
  let firstScanPage = await (persistedScanCursorId
    ? campaignScanBaseQuery().startAfter(persistedScanCursorId)
    : campaignScanBaseQuery()
  ).get();
  // R38-fix 와 같은 계약: 저장된 커서가 컬렉션 끝을 이미 넘은 채로 남아 있을 수 있다 — 이 최초
  // 페이지에서 비면(진짜 재고 소진이 아니라 커서만 낡았을 가능성) 한 번은 처음부터 다시 본다.
  let usedPersistedCursorWrap = false;
  if (firstScanPage.empty && persistedScanCursorId) {
    usedPersistedCursorWrap = true;
    firstScanPage = await campaignScanBaseQuery().get();
  }
  const activeInFirstScanPage = firstScanPage.docs.reduce((count, doc) => {
    const campaign = doc.data() ?? {};
    const programId = stringField(campaign, "programId", "");
    return programId && resolveCampaignOperationalState(campaign) === "active" ? count + 1 : count;
  }, 0);
  const activeCampaignsThisPass = Math.max(1, activeInFirstScanPage);
  // 0.6.110: 리필 몫의 분모는 **이번 pass 에 실제로 웨이브를 시작할 캠페인**만 센다 — 소진된(전원 기접촉 · 재고 0)
  // autoRefill 캠페인은 아래에서 웨이브를 건너뛰므로 몫을 받을 이유가 없다(승인 몫은 큐가 있을 수 있어 그대로).
  const refillExhaustedReincludeMs = options.refillExhaustedReincludeMs ?? CAMPAIGN_REFILL_EXHAUSTED_REINCLUDE_MS;
  const exhaustedInFirstScanPage = firstScanPage.docs.reduce((count, doc) => {
    const campaign = doc.data() ?? {};
    const programId = stringField(campaign, "programId", "");
    return programId
      && resolveCampaignOperationalState(campaign) === "active"
      && campaign.autoRefillEnabled === true
      && isCampaignRefillExhausted(campaign, sweepStartedAtMs, refillExhaustedReincludeMs)
      ? count + 1
      : count;
  }, 0);
  const refillShareCampaignsThisPass = Math.max(1, activeCampaignsThisPass - exhaustedInFirstScanPage);
  const perCampaignApprovalBudgetMs = perCampaignFairShare(CAMPAIGN_APPROVAL_TIME_BUDGET_MS, activeCampaignsThisPass);
  const perCampaignRefillTimeBudgetMs = perCampaignFairShare(CAMPAIGN_REFILL_SCAN_TIME_BUDGET_MS, refillShareCampaignsThisPass);
  const perCampaignRefillReadBudget = perCampaignFairShare(CAMPAIGN_REFILL_MAX_DOCUMENT_READS, refillShareCampaignsThisPass);
  let cursor: QueryDocumentSnapshot | undefined;
  // W127: **다음 pass 가 재개할 지점**(회전용) — 아래 for 루프가 실제로 진입한(스킵이든 처리든)
  // 마지막 캠페인 문서 id 다. 위 `cursor`(페이지네이션용)와 다르다 — `cursor` 는 activeProcessed
  // 상한에 걸려 for 루프가 페이지 중간에서 break 해도 그 **페이지의 마지막 문서**로 남아, 방문한
  // 적 없는 뒤쪽 문서까지 "처리됨"으로 잘못 표시할 수 있다(다음 pass 가 그 구간을 건너뛴다).
  let lastVisitedCampaignId = "";
  // R38-fix [회귀 · 2026-09-17]: 저장된 커서(persistedScanCursorId)가 컬렉션 끝을 이미 넘은 채로
  // 남아 있을 수 있다 — 예를 들어 활성 캠페인이 1개뿐인데 이전 pass 가 campaignLimit 을 그 1개에
  // 딱 맞게 소진해(activeProcessed>=campaignLimit) "더 있을 수 있다"고 보고 그 캠페인 자신을
  // 커서로 남긴 경우, 다음 pass 는 startAfter(그 캠페인)로 시작해 **유일한 활성 캠페인을 영원히
  // 건너뛴다**. rotatingWindow(admin.ts 위쪽, W34)가 이미 쓰는 것과 같은 계약 — 저장된 커서로 첫
  // 페이지가 완전히 비면 한 번은 처음부터 다시 돈다 — 를 여기도 적용한다. pass 당 최대 1회만
  // (빈 페이지 재조회 1건) 소모하므로 정상적인(진짜로 더 남은) 경우의 비용은 그대로다.
  // (usedPersistedCursorWrap/firstScanPage 는 위 AR-1 fair-share 계산에서 이미 이 최초 페이지를
  // 당겨왔다 — 아래 루프의 첫 회차는 그 결과를 재사용해 읽기를 중복하지 않는다.)
  let pendingFirstScanPage: FirebaseFirestore.QuerySnapshot | undefined = firstScanPage;
  while (activeProcessed < campaignLimit && scanned < CAMPAIGN_SCAN_MAX_DOCUMENT_READS) {
    let campaigns: FirebaseFirestore.QuerySnapshot;
    if (pendingFirstScanPage) {
      campaigns = pendingFirstScanPage;
      pendingFirstScanPage = undefined;
    } else {
      let query: Query = campaignScanBaseQuery();
      const usingPersistedCursor = !cursor && !!persistedScanCursorId;
      if (cursor) query = query.startAfter(cursor);
      else if (persistedScanCursorId) query = query.startAfter(persistedScanCursorId);
      campaigns = await query.get();
      if (campaigns.empty && usingPersistedCursor && !usedPersistedCursorWrap) {
        usedPersistedCursorWrap = true;
        campaigns = await campaignScanBaseQuery().get();
      }
    }
    if (campaigns.empty) break;
    scanned += campaigns.size;
    for (const campaignDoc of campaigns.docs) {
      if (activeProcessed >= campaignLimit) break;
      // W18 F-2: 캠페인 경계에서만 예산을 검사한다 — 진행 중인 캠페인의 리필/승인 청크를 중간에
      // 끊지 않으므로 부분 쓰기가 생기지 않는다(청크 원자성은 종전 그대로).
      if (Date.now() - sweepStartedAtMs >= timeBudgetMs) {
        timeBudgetReached = true;
        break;
      }
      lastVisitedCampaignId = campaignDoc.id;
      const campaign = campaignDoc.data() ?? {};
      const programId = stringField(campaign, "programId", "");
      if (!programId || resolveCampaignOperationalState(campaign) !== "active") continue;
      activeProcessed += 1;
      let refilled = 0;
      // W58-2 [프로드 실측 2026-08-08]: 하한 수확 후보 수집을 **autoRefill 분기 밖으로** 뺀다.
      // 종전에는 `campaign.autoRefillEnabled === true` 안에 있어서, code=4 되돌림으로 플래그를 끄면
      // 상시 탐색(candidatePoolFloor=10000)까지 함께 멎었다 — 발송 레인의 사고 대응이 발굴 레인을
      // 통째로 정지시키는 결합이다(헤세 확정 "항시 1만"이 발송 상태에 종속돼 있었다).
      // 센서는 aggregate 3회로 싸고, 수확 자체 게이트(활성 잡·1시간 간격·쿼터)는 그대로 유지된다.
      // remaining 계산은 리필 전용이므로 여기서는 하지 않는다 — 재고 하한은 remaining 과 무관하다.
      {
        const lastCheckedAtIso = stringField(
          isRecord(campaign.candidatePoolInventory) ? campaign.candidatePoolInventory : {},
          "atIso",
          "",
        );
        const lastCheckedAtMs = lastCheckedAtIso ? Date.parse(lastCheckedAtIso) : NaN;
        floorHarvestCandidates.push({
          campaignId: campaignDoc.id,
          campaign,
          // 측정된 적이 없으면(NaN) 무엇보다도 오래된 것으로 취급해 최우선으로 고른다.
          lastCheckedAtMs: Number.isFinite(lastCheckedAtMs) ? lastCheckedAtMs : -Infinity,
        });
      }
      if (campaign.autoRefillEnabled === true) {
        // W20 [프로드 실측 2026-08-04 · V8 힙 OOM 근인]: 이 쿼리는 캠페인의 **모든** outreach 행을
        // 문서 전체로 읽었다. 행마다 컴파일 본문(approvedCompiledHtml·compiledHtml·text 등)이 있어
        // **행당 문자열 125KB**이고, 496건이면 매 pass 61MB 를 힙에 올린다(Firestore 객체 오버헤드
        // 포함 시 실제 수백 MB). 그래서 memory 1GiB 에서도 컨테이너 한도가 아니라 **V8 힙**이 터졌다:
        //   node::OOMErrorHandler → v8::internal::V8::FatalProcessOutOfMemory → signal 6(SIGABRT).
        // Cloud Run 'Memory limit exceeded' 로그는 없었다 — 그래서 컨테이너 증설로는 안 잡혔다.
        // campaignRefillRemaining 이 실제로 쓰는 필드는 deliveryState/status **둘뿐**이므로
        // select() 로 투영해 전송·역직렬화 대상에서 본문을 제외한다(61MB → 수십 KB).
        //
        // A2 [읽기 비용 · 2026-08-29]: W20 의 `select()` 는 **메모리** 수리였다 — 과금 건수는
        // 반환 문서 수라 그대로 10,415 read/pass 였다(프로드 실측, 주력 캠페인).
        // 소비처인 campaignRefillRemaining 이 이 스냅샷에서 쓰는 것은 **개수 하나뿐**이므로
        // 술어를 쿼리로 내리고 count() 집계로 바꾼다 → 10,415 → 약 11 read(1,000 엔트리당 1).
        // ⚠️ `deliveryState` 결측 행이 있으면 `in` 이 그 행을 조용히 빼서 remaining 이 과대해지고
        //   리필이 풀을 과소비한다. 프로드 실측(2026-08-29)으로 **결측 0건**(10,415/10,415)을
        //   확인하고 넣었다. 기존 인메모리 판정의 `status` 폴백은 그래서 도달 불가 경로였다.
        // 기존 인덱스 `campaign_outreach(campaignId, deliveryState, __name__)` 로 그대로 처리된다.
        const committedSnapshot = await adminDb.collection("campaign_outreach")
          .where("campaignId", "==", campaignDoc.id)
          .where("deliveryState", "in", [...CAMPAIGN_REFILL_COUNTED_STATES])
          .count()
          .get();
        const remaining = campaignRefillRemainingFromCount(
          campaign,
          Math.max(0, Math.round(committedSnapshot.data().count ?? 0)),
        );
        // R23-1: 재고 하한 수확 후보 수집은 **위(autoRefill 분기 밖)로 옮겼다**(W58-2).
        // 종전에는 `remaining <= 0` 일 때만 담았으나, 재고 하한은 이 캠페인의 잔여 목표와 무관하고
        // 무엇보다 autoRefill 이 꺼지면 통째로 멎었다. 수확 대상 선정(가장 오래전 측정 1건)과
        // 게이트(활성 잡·1시간·쿼터)는 루프 뒤 호출부에 그대로 있다.
        // W58-1: 이 리필에 실제로 남은 예산. 두 상한(리필 전용 90s · 스윕 전체) 중 이른 쪽이다 —
        // W57-F4 의 refillDeadlineMs 와 **같은 산식**을 쓴다(마감과 사이징이 어긋나면 안 된다).
        // W58-A3: 커밋 고정비를 먼저 떼고 남은 예산으로만 사이징한다.
        const refillOwnBudgetLeftMs = CAMPAIGN_REFILL_SCAN_TIME_BUDGET_MS - refillSpentMs - CAMPAIGN_REFILL_COMMIT_RESERVE_MS;
        const sweepBudgetLeftMs = timeBudgetMs - (Date.now() - sweepStartedAtMs) - CAMPAIGN_REFILL_COMMIT_RESERVE_MS;
        // W127: **공정 몫**도 건다 — 안 걸면 사전순으로 먼저 오는 캠페인이 리필 시간 총량
        // (refillSpentMs 가 아직 0)을 혼자 다 써버리고, 뒤 캠페인은 이 pass 에서 남은 게 없다.
        const perCampaignBudgetLeftMs = perCampaignRefillTimeBudgetMs - CAMPAIGN_REFILL_COMMIT_RESERVE_MS;
        const refillBudgetLeftMs = Math.min(refillOwnBudgetLeftMs, sweepBudgetLeftMs, perCampaignBudgetLeftMs);
        // m6: 어느 상한이 물렸는지 남긴다 — 셋은 대응이 다르다(리필 전용·공정 몫은 다음 pass 가 잇고,
        // 스윕 전체는 발송이 예산을 많이 먹었다는 뜻이라 발송측을 봐야 한다).
        const refillTimeBoundBy = perCampaignBudgetLeftMs <= Math.min(refillOwnBudgetLeftMs, sweepBudgetLeftMs)
          ? "refillCampaignSlice"
          : refillOwnBudgetLeftMs <= sweepBudgetLeftMs ? "refillScanBudget" : "sweepBudget";
        // 예산으로 감당 가능한 웨이브 크기. 줄이는 방향으로만 작동한다(늘리지 않는다).
        const affordableRowsByTime = Math.max(0, Math.floor(refillBudgetLeftMs / CAMPAIGN_REFILL_ROW_COST_MS));
        // T4-1: 읽기 축의 같은 사이징. 위 count() 집계 1건도 이 레인이 쓴 읽기라 먼저 계상한다.
        refillReadsSpent += 1;
        // W127: 읽기 축도 공유 잔여와 공정 몫 중 **더 좁은 쪽**을 쓴다(시간 축과 같은 이유).
        const refillReadsLeft = Math.min(
          CAMPAIGN_REFILL_MAX_DOCUMENT_READS - refillReadsSpent,
          perCampaignRefillReadBudget,
        );
        const affordableRowsByReads = Math.max(0, Math.floor(refillReadsLeft / CAMPAIGN_REFILL_ROW_READ_COST));
        // m6 확장: 어느 축이 물었는지. 세 대응이 다르다 — 읽기는 다음 pass 가 잇고(비용 상한),
        // 리필 전용 시간도 다음 pass 가 잇고, 스윕 전체는 발송이 예산을 많이 먹었다는 뜻이다.
        const refillBoundBy = affordableRowsByReads < affordableRowsByTime ? "refillReadBudget" : refillTimeBoundBy;
        const affordableRows = Math.min(affordableRowsByTime, affordableRowsByReads);
        const budgetedRemaining = Math.min(remaining, affordableRows);
        if (remaining > 0 && isCampaignRefillExhausted(campaign, sweepStartedAtMs, refillExhaustedReincludeMs)) {
          // 0.6.110: 소진된 캠페인은 웨이브를 시작하지 않는다(분모에서도 이미 뺐다). N시간 뒤 자동 재편입 —
          // 그때 한 번 시도하고 같은 결과면 lastRefillAtIso 가 갱신돼 다시 N시간 제외된다.
          refillSkippedExhausted += 1;
          console.log("[campaign-auto-approval] refill skipped: campaign exhausted (all candidates already touched, sendableEstimate 0)", {
            campaignId: campaignDoc.id,
            reincludeAfterMs: refillExhaustedReincludeMs,
          });
        } else if (remaining > 0 && budgetedRemaining <= 0) {
          // W43 F-1: 리필이 자기 예산을 다 쓴 것이지 스윕이 끝난 게 아니다 — 같은 pass 의 승인은 계속 돈다.
          // W58-1: 한 행도 감당 못 하는 잔여 예산이면 웨이브를 **시작하지 않는다**. 시작해 버리면
          // 비싼 구간이 단일 phase 라 마감으로도 못 끊고 480s 강제종료가 된다(프로드 2회).
          refillBudgetReached = true;
          if (affordableRowsByReads <= 0) refillReadBudgetReached = true;
          console.log("[campaign-auto-approval] refill budget cannot afford a wave, deferring to next pass", {
            campaignId: campaignDoc.id,
            refillBudgetLeftMs,
            boundBy: refillBoundBy,
            rowCostMs: CAMPAIGN_REFILL_ROW_COST_MS,
            // T4-1: 읽기 축도 같이 남긴다 — 시간만 찍으면 읽기로 막힌 pass 를 시간 부족으로 오진한다.
            refillReadsSpent,
            refillReadsLeft,
            rowReadCost: CAMPAIGN_REFILL_ROW_READ_COST,
          });
        } else if (remaining > 0) {
          if (budgetedRemaining < remaining) {
            refillWaveClamped += 1;
            console.log("[campaign-auto-approval] refill wave clamped to remaining budget", {
              campaignId: campaignDoc.id,
              requested: remaining,
              clampedTo: budgetedRemaining,
              refillBudgetLeftMs,
              boundBy: refillBoundBy,
            });
          }
          const refillStartedAtMs = Date.now();
          // T4-1: 이 웨이브가 실제로 태운 읽기를 재려면 **호출 전후 차분**이어야 한다 — 절대값을
          // 쓰면 같은 pass 의 앞선 캠페인이 태운 읽기까지 이 캠페인에 물린다.
          const refillReadsBefore = readCampaignEvidenceMetrics().documentReads;
          let evidenceBudget: EvidenceReadBudget | null = null;
          try {
            // W57-F4/F3: 이 리필 호출에 **마감**과 **pass 스코프 증거 캐시**를 건다.
            // 마감은 스윕 예산(sweepDeadlineMs 반영분)과 리필 자기 예산 중 이른 쪽이다 —
            // 넘기면 runRefillPhase 가 campaign_targets_* 와 같은 경로로 양보 에러를 던져
            // 480s 강제종료 대신 정상 롤백·기록 후 다음 pass 로 넘어간다.
            // W127-후속 [운영 실측 2026-09-19]: 마감·읽기 상한 산식은 위쪽 순수 함수로 —
            //   공정 몫이 **실행 상한**에도 들어간다(종전에는 사이징에만 들어가 첫 캠페인이
            //   글로벌 예산을 독식했다. 실측 ~79s/45s·~4,000/5,000 reads).
            const refillDeadlineMs = refillWaveDeadlineMs({
              nowMs: Date.now(),
              sweepDeadlineMs: sweepStartedAtMs + timeBudgetMs,
              refillScanTimeBudgetMs: CAMPAIGN_REFILL_SCAN_TIME_BUDGET_MS,
              refillSpentMs,
              perCampaignRefillTimeBudgetMs,
            });
            // T4-1: 시간 축에 withRefillDeadline 이 있듯, **읽기 축에는 이 예산이** 있다.
            //   쿼리 층(runChunkedEvidenceQueries)이 발행 전에 선점하므로 이 웨이브가 남은 예산을
            //   넘겨 읽을 수 없다. 넘칠 상황이면 truncated 가 서고 증거 판정이 fail-closed 된다.
            evidenceBudget = createEvidenceReadBudget(
              refillWaveEvidenceReadCap({
                refillMaxDocumentReads: CAMPAIGN_REFILL_MAX_DOCUMENT_READS,
                refillReadsSpent,
                perCampaignRefillReadBudget,
              }),
            );
            refilled = await withRefillDeadline(
              refillDeadlineMs,
              // 캐시 스코프만 연다 — 키는 createCampaignWithPreparedTargets 가 확정 지점에서 바인딩한다(W57-M1).
              // W58-M1: 웨이브 크기는 예산 클램프값, 부족량 축은 **원래 remaining** 을 함께 넘긴다.
              () => withEvidenceReadBudget(
                evidenceBudget,
                () => withTouchEvidenceCache(() => refillAutomaticCampaign(campaignDoc.id, campaign, budgetedRemaining, remaining)),
              ),
            );
          } catch (error) {
            // R16-3: 던져진 에러에는 **구체 사유(errorCode)와 단계별 counts 가 이미 붙어 있다**
            // (`campaign_targets_all_already_touched` + scanned/emailReady/… — admin.ts 의 거부 지점).
            // 예전에는 `.code`("failed-precondition")만 읽어 그 진단을 통째로 버렸다. "어느 단계에서
            // 말랐는지"가 T4 의 존재 이유이므로 있는 그대로 남긴다.
            const failure = error as {
              code?: unknown;
              errorCode?: unknown;
              counts?: unknown;
              preparationCounts?: unknown;
              eligibilityRejections?: unknown;
            };
            const errorCode = typeof failure.errorCode === "string" && failure.errorCode
              ? failure.errorCode
              : typeof failure.code === "string" ? failure.code : "auto_refill_failed";
            // R35-2(a) [운영 진단 갭]: `auto_refill_failed` 는 **코드가 없는 에러**(순수 런타임 예외 ·
            // Firestore plain Error · gRPC 숫자 code)일 때의 최후 폴백이다. 그 한 줄만으로는 어느
            // 파일의 무슨 예외인지 알 수 없어 25차 진단이 통째로 막혔다. 코드가 없을 때만 비밀정보를 제거한
            // 메시지 앞 200자와 **스택 첫 프레임**을 함께 남긴다(SEC-P0-009).
            const codelessDiagnostics = refillCodelessErrorDiagnostics(error, errorCode);
            const rollbackFailureCount = refillRollbackFailureCountForError(error);
            const numericCounts = (value: unknown): Record<string, number> | undefined => (isRecord(value)
              ? Object.fromEntries(
                Object.entries(value)
                  .filter(([, entry]) => typeof entry === "number" && Number.isFinite(entry)),
              ) as Record<string, number>
              : undefined);
            const failureCounts = numericCounts(failure.counts);
            // R33-1: 실패 pass 야말로 상류 진단이 필요한 순간이다 — 준비 경로 수치·사유 분포를 함께 남긴다.
            const preparationCounts = numericCounts(failure.preparationCounts);
            const eligibilityRejections = numericCounts(failure.eligibilityRejections);
            console.warn("[campaign-auto-refill] pass did not add recipients", {
              campaignId: campaignDoc.id,
              remaining,
              errorCode,
              ...(failureCounts ? { counts: failureCounts } : {}),
              ...(rollbackFailureCount !== undefined ? { rollbackFailureCount } : {}),
              ...(codelessDiagnostics ?? {}),
            });
            // T4: 실패 사유도 문서에 남긴다 — 로그만 남기면 운영자에게는 여전히 조용한 정체다.
            await persistRefillOutcome(campaignDoc.id, {
              errorCode,
              failureCounts,
              preparationCounts,
              eligibilityRejections,
              // R35-2(a): 캠페인 문서에도 남긴다 — 로그 접근권이 없는 운영자도 사유를 볼 수 있어야 한다.
              failureMessage: codelessDiagnostics?.failureMessage,
              failureFrame: codelessDiagnostics?.failureFrame,
              // Coded deadline yields still carry a sanitized phase. Codeless diagnostics only
              // apply to auto_refill_failed, so preserve the shared phase separately here.
              failurePhase: codelessDiagnostics?.failurePhase ?? refillFailurePhase(error),
              failureNumericCode: codelessDiagnostics?.failureNumericCode,
              rollbackFailureCount,
            });
          }
          // W43 F-1: 성공·실패 모두 이 캠페인 리필이 실제로 쓴 시간만 리필 예산에서 차감한다.
          refillSpentMs += Date.now() - refillStartedAtMs;
          // T4-1: 읽기도 같은 규율 — 실패한 웨이브도 읽기는 이미 태웠으므로 반드시 차감한다.
          // (안 하면 실패가 반복되는 캠페인이 예산을 무한히 쓴다 — 정확히 8/6 회귀의 형상이다.)
          refillReadsSpent += Math.max(0, readCampaignEvidenceMetrics().documentReads - refillReadsBefore);
          // 예산이 실제로 잘렸으면 관측 축에도 남긴다 — 이 pass 는 증거 부족으로 fail-closed 됐다.
          if (evidenceBudget?.truncated === true) refillReadBudgetReached = true;
        }
      }
      // W20: 이 스냅샷의 사용처는 `queued.docs.map((doc) => doc.id)` 뿐이다 — 문서 데이터를 쓰지
      // 않는데 행당 125KB 본문까지 읽어 rowLimit(최대 200)에서 25MB 를 힙에 올렸다.
      // 인자 없는 select() 는 필드를 하나도 가져오지 않고 문서 참조만 돌려준다.
      // T1-2 [읽기 비용 · 2026-08-29]: 헤드룸이 0 이면 아래 슬라이스가 **전량을 버린다**
      //   (`approvableIds` 가 빈 배열이 된다). 그런데 이 쿼리는 매 pass 캠페인마다 rowLimit(최대 200)
      //   건을 읽었다 — 일일 캡 200 이 오전에 소진되므로 **하루 대부분이 그 상태**다
      //   (프로드 로그 실측: `approvalSkippedByHeadroom: 50 / headroom: 0`).
      //   ⚠️ 인자 없는 `select()` 는 W20 의 **메모리** 수리라 과금 건수를 안 줄인다(A2 와 같은 함정).
      //   그래서 헤드룸이 없으면 문서를 안 읽고 `count()` 1 read 로 **비었는지만** 본다 —
      //   아래 잼 해제(`lastApprovalErrorCode` 리셋)가 그 판정을 필요로 하므로 건너뛰지 않는다.
      const approvalHeadroomLeft = Math.max(0, approvalHeadroom.headroom - approvedThisSweep);
      const queuedBase = adminDb.collection("campaign_outreach")
        .where("campaignId", "==", campaignDoc.id)
        .where("deliveryState", "==", "queued_for_review");
      let queued: { empty: boolean; size: number; docs: readonly FirebaseFirestore.QueryDocumentSnapshot[] };
      if (approvalHeadroomLeft > 0) {
        queued = await queuedBase.select().limit(rowLimit).get();
      } else {
        // ⚠️ `size` 를 0 으로 두면 안 된다 — 아래 `approvalSkippedByHeadroom` 이 `queued.size` 로
        //   계산되고, **그 지표가 "큐 적체의 원인은 캡"이라는 진단의 근거**였다(프로드 로그
        //   `approvalSkippedByHeadroom: 50 / headroom: 0`). 0 으로 만들면 읽기는 줄지만 그 신호가
        //   사라져 다음 사람이 같은 진단을 못 한다. count() 값을 그대로 싣는다(종전과 같은 수).
        const queuedCount = Math.max(0, Math.round((await queuedBase.count().get()).data().count ?? 0));
        queued = { empty: queuedCount === 0, size: Math.min(queuedCount, rowLimit), docs: [] };
      }
      if (queued.empty) {
        // R19-2: 큐가 승인 외 경로(취소 등)로 비워졌는데 직전 승인 오류가 그대로 남아 있으면 카드가
        // 영구 "승인 막힘"이 된다. 잼이 풀린 사실도 관측 표면에 반영해야 한다.
        if (stringField(campaign, "lastApprovalErrorCode", "").length > 0) {
          await persistApprovalOutcome(campaignDoc.id, { approved: 0, errorCode: null });
        }
        if (refilled > 0) results.push({ campaignId: campaignDoc.id, refilled, approved: 0 });
        continue;
      }
      // The approval parser hard-bounds one selection to 1..5 rows (the manual-review safety bound,
      // kept intact). The sweep drains the whole queued wave by approving in 5-row chunks, tracking
      // the campaign CAS controlVersion locally (+1 per committed approval).
      // W43 F-2: 오늘 발송이 소화할 수 있는 만큼만 승인한다(초과분은 다음 pass·다음 날이 잇는다).
      // daily-cap-fairness(1c): 전역 헤드룸(위) 과 별개로, 이 캠페인의 dailyCap 도 승인 개수를
      // 좁힌다 — 안 그러면 스윕이 dailyCap 을 넘겨 승인해 두고, 발송 워커(chat-ai.ts
      // campaignDailyCapState)가 발송 직전에야 막는다. 그러면 "승인됨"인데 다음 날까지 못 나가는
      // 적체만 쌓인다(승인 자체가 헛일이 된다).
      let campaignApprovableLimit = approvalHeadroomLeft;
      const campaignDailyCap = Math.max(0, Math.round(numberField(campaign, "dailyCap", 0)));
      if (campaignDailyCap > 0) {
        const [campaignDailyCounterSnapshot, campaignPendingSnapshot] = await Promise.all([
          adminDb.collection("campaign_outreach_daily_counters").doc(`${dayKey}__${campaignDoc.id}`).get(),
          adminDb.collection("campaign_outreach")
            .where("campaignId", "==", campaignDoc.id)
            .where("deliveryState", "in", ["approved", "processing"])
            .count()
            .get(),
        ]);
        const campaignSentToday = Math.max(0, Math.round(numberField(campaignDailyCounterSnapshot.data() ?? {}, "sent", 0)));
        const pendingApprovedForCampaign = Math.max(0, Math.round(campaignPendingSnapshot.data().count ?? 0));
        const campaignHeadroom = Math.max(0, campaignDailyCap - campaignSentToday - pendingApprovedForCampaign);
        campaignApprovableLimit = Math.min(campaignApprovableLimit, campaignHeadroom);
      }
      const approvableIds = queued.docs.map((doc) => doc.id).slice(0, campaignApprovableLimit);
      approvalSkippedByHeadroom += queued.size - approvableIds.length;
      const queuedIds = approvableIds;
      let expectedVersion = numberField(campaign, "controlVersion", 0);
      let approvedTotal = 0;
      let errorCode: string | undefined;
      // W127: 이 캠페인만의 승인 시간 소비 — perCampaignApprovalBudgetMs 와 짝지어, 한 캠페인이
      // 공유 총량(approvalSpentMs)을 혼자 다 써서 뒤 캠페인을 굶기지 못하게 한다.
      let campaignApprovalSpentMs = 0;
      for (let start = 0; start < queuedIds.length; start += 5) {
        // W43 F-1: 승인 자기 예산 — 소진되면 정상 종료한다(남은 행은 queued 로 남아 다음 pass 가
        // 잇는다). 이 검사가 없으면 승인이 timeout 480s 까지 밀고 code=4 로 잡을 손상시켜 **발송까지
        // 통째로 멈춘다**(2026-08-05 실사고).
        // W127: 공유 총량 **또는** 이 캠페인의 공정 몫 중 먼저 닿는 쪽에서 멈춘다.
        if (approvalSpentMs >= CAMPAIGN_APPROVAL_TIME_BUDGET_MS || campaignApprovalSpentMs >= perCampaignApprovalBudgetMs) {
          approvalBudgetReached = true;
          break;
        }
        const approvalChunkStartedAtMs = Date.now();
        const chunk = queuedIds.slice(start, start + 5);
        try {
          const approval = await approveCampaignOutreach({
            auth: { uid: CAMPAIGN_AUTO_APPROVAL_ACTOR_UID, token: { role: "admin", team: "scp" } },
            data: {
              programId,
              campaignId: campaignDoc.id,
              outreachIds: chunk,
              confirmCount: chunk.length,
              expectedVersion,
            },
            rawRequest: { ip: "0.0.0.0" },
          } as CallableRequest);
          approvedTotal += numberField(approval, "approvedCount", 0);
          expectedVersion = numberField(approval, "controlVersion", expectedVersion + 1);
        } catch (error) {
          errorCode = errorCodeForLog(error) || "auto_approval_failed";
          console.error("[campaign-auto-approval] approval failed", { campaignId: campaignDoc.id, errorCode });
          const chunkElapsedMs = Date.now() - approvalChunkStartedAtMs;
          approvalSpentMs += chunkElapsedMs;
          campaignApprovalSpentMs += chunkElapsedMs;
          break; // stop this campaign on the first failure; the next sweep run retries the remainder.
        }
        const chunkElapsedMs = Date.now() - approvalChunkStartedAtMs;
        approvalSpentMs += chunkElapsedMs;
        campaignApprovalSpentMs += chunkElapsedMs;
      }
      approvedThisSweep += approvedTotal;
      // R18 [HIGH-2]: 승인 결과를 문서에 남긴다 — 잼이 화면에서 조용하면 안 된다.
      // 큐가 빈 경우는 위에서 이미 처리했으므로(회복 클리어 포함) 여기서는 무조건 기록한다.
      await persistApprovalOutcome(campaignDoc.id, { approved: approvedTotal, errorCode: errorCode ?? null });
      results.push({
        campaignId: campaignDoc.id,
        ...(refilled > 0 ? { refilled } : {}),
        approved: approvedTotal,
        ...(errorCode ? { errorCode } : {}),
      });
    }
    if (timeBudgetReached) break;
    cursor = campaigns.docs.at(-1);
    if (!cursor || campaigns.size < campaignLimit) break;
  }
  const scanReadBudgetReached = !timeBudgetReached && activeProcessed < campaignLimit && scanned >= CAMPAIGN_SCAN_MAX_DOCUMENT_READS;
  // W127 [운영 실사고 2026-09-16 야간 · 수리]: 종전에는 **읽기 상한에 걸렸을 때만** 커서를 남겼다
  // (T0-2). document-id 순으로 먼저 오는 캠페인들이 activeProcessed 를 campaignLimit 까지 채워
  // 정상 종료해도(읽기 상한과 무관) 커서는 매번 ""로 되돌아가, 다음 pass 가 **항상 처음부터** 다시
  // 돈다 — 그 뒤에 더 있을 활성 캠페인은 영원히 이번 pass 에 못 든다(이번 사고의 근인 중 하나).
  //
  // 그런데 무조건 매번 회전시키면 **다른 회귀**가 생긴다: 활성 캠페인이 campaignLimit 보다 적어
  // 이 pass 가 존재하는 전부를 처리하고 자연 소진(collection 끝)으로 끝난 경우, 다음 호출은
  // `.startAfter(마지막 캠페인)` 이 빈 페이지를 받아 **아무 캠페인도 재처리하지 못한다** — 반복
  // 호출로 같은 소수 캠페인을 계속 돌리는 것을 전제하는 기존 테스트 다수(예: 리필을 여러 pass 에
  // 걸쳐 이어가는 흐름)가 깨진다. 판정 본체는 nextCampaignScanCursorId(순수 함수, 위)로 뺐다.
  const nextScanCursorId = nextCampaignScanCursorId({
    lastVisitedCampaignId,
    timeBudgetReached,
    scanReadBudgetReached,
    activeProcessed,
    campaignLimit,
  });
  try {
    await campaignScanStateRef.set({
      scanCursorId: nextScanCursorId,
      atIso: new Date().toISOString(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (error) {
    console.warn("[campaign-auto-approval] scan cursor write failed", { errorCode: errorCodeForLog(error) });
  }
  // BLOCKER-B: pass 당 예산 1건 — 이번 pass 에서 모은 후보 중 가장 오래전에(또는 한 번도) 측정되지
  // 않은 캠페인부터 시도한다. 새 컬렉션·새 문서 없음, Firestore 읽기 추가 없음(이미 가져온 campaign
  // 문서의 필드만 비교).
  // HIGH [적대적 리뷰 실측 · 3라운드]: enqueueShortfallDiscoveryJob 은 캠페인별 레이트리밋(활성 잡
  // dedup·1시간 간격)을 재고 측정보다 먼저 검사하고 조기 return 한다. 가장 오래된
  // 캠페인 하나만 무조건 호출하면, 그 캠페인이 게이트에 막혀 enqueue 없이 return 했을 때
  // candidatePoolInventory.atIso 가 갱신되지 않아 **그 캠페인이 영구히 "가장 오래전"으로 남아 매
  // pass 선택을 독점**한다(실측: 활성 잡 보유·[R23-5 이전] dailyCount=6 각 3 pass 연속 재현 — 가장
  // 오래된 캠페인뿐 아니라 그다음 캠페인도 inventory null, 기아 재발). 측정을 실제로 수행했는지
  // (measured)를 신호로 받아, 못 했으면 다음으로 오래된 후보로 폴스루한다 — 측정 자체는
  // enqueueShortfallDiscoveryJob 내부에서 pass 당 최대 1회만 일어나므로(measured:true 를 받는 즉시
  // break) 읽기 비용 상한은 그대로 보존된다.
  //
  // HIGH [적대적 리뷰 4라운드 · 실측 A2]: 단, 쿼터 소진(blockedGlobally)은 **모든 후보가 공유하는
  // 전역 사유**라 폴스루가 오히려 해롭다 — measured:false 를 "이 후보만 안 됐다"로 읽고 다음
  // 후보로 넘어가면, 후보 전원이 같은 사유로 막혀 같은 쿼터 계측(슬롯 수만큼 api_usage 문서 읽기)과
  // 캠페인 쓰기를 후보 수만큼 반복한다(실측: floor 후보 3+전 키 소진 → 계측 3회·쓰기 3회, N=20 이면
  // 소진일 23,040 reads + 5,760 writes/일 증폭). blockedGlobally 를 받으면 폴스루하지 않고 루프를
  // 즉시 멈춘다 — per-campaign 게이트(활성 잡·1시간 간격)는 여전히 폴스루한다.
  // W18 F-2: 예산이 다한 pass 는 기회적 재고 측정도 건너뛴다 — 다음 회차가 잇는다.
  //
  // W58-M3 [독립 리뷰]: `!timeBudgetReached` 만으로는 부족하다. 그 플래그는 캠페인 루프가 **예산 초과로
  // 중단됐을 때만** true 라서, 루프가 자연 종료(캠페인 소진)했으면 이미 마감을 넘겼어도 false 다.
  // 그러면 이 꼬리 루프가 무방비로 실행된다 — 루프 안에 **동기 YouTube 프리뷰 호출**이 있어 예산을
  // 크게 먹을 수 있다. 실시간 잔여로 판정하고, for 선두에서도 매 반복 다시 본다(후보가 여러 개면
  // 한 번의 진입 검사로는 마지막 후보까지 보장되지 않는다).
  const sweepBudgetLeftForHarvestMs = () => timeBudgetMs - (Date.now() - sweepStartedAtMs);
  if (!timeBudgetReached && sweepBudgetLeftForHarvestMs() > 0 && floorHarvestCandidates.length > 0) {
    // N-2 [리뷰 3라운드]: 둘 다 한 번도 측정되지 않은 경우(-Infinity - -Infinity) 는 NaN 이 나온다 —
    // sort 콤퍼레이터가 NaN 을 반환하는 것은 스펙상 정의되지 않은 동작이라(엔진마다 다르게 처리할 수
    // 있다), 지금 관측된 동작(안정 정렬 유지)에 기대지 않고 Number.isFinite 로 명시적으로 분기한다 —
    // 결과 자체는 동일하다(둘 다 미측정이면 동률로 원래 순서 유지, 미측정 쪽이 있으면 그쪽을 먼저).
    const orderedCandidates = [...floorHarvestCandidates].sort((a, b) => {
      const aMeasured = Number.isFinite(a.lastCheckedAtMs);
      const bMeasured = Number.isFinite(b.lastCheckedAtMs);
      if (!aMeasured && !bMeasured) return 0;
      if (!aMeasured) return -1;
      if (!bMeasured) return 1;
      return a.lastCheckedAtMs - b.lastCheckedAtMs;
    });
    for (const candidate of orderedCandidates) {
      if (sweepBudgetLeftForHarvestMs() <= 0) {
        timeBudgetReached = true;
        console.log("[campaign-auto-approval] sweep budget exhausted before floor harvest candidate", {
          campaignId: candidate.campaignId,
        });
        break;
      }
      // W58-라: 이번 pass 에 이미 리필이 잡을 넣은(또는 넣으려 시도한) 캠페인은 건너뛴다.
      // candidate.campaign 은 캠페인 루프 **진입 시점 스냅샷**이라 방금 갱신된 lastJobRef 를 못 본다 —
      // 문서를 다시 읽어 확인하는 대신(읽기 비용) pass 로컬 사실로 판정한다.
      if (passEnqueuedCampaigns().has(candidate.campaignId)) continue;
      const { measured, enqueued, blockedGlobally, blockedByCampaignGate } = await enqueueShortfallDiscoveryJob(candidate.campaignId, candidate.campaign, 0, {
        allowInventoryFloorHarvest: true,
      });
      if (blockedGlobally || enqueued || (measured && blockedByCampaignGate !== true)) break;
    }
  }
  // W43 관측: 어느 단계가 자기 예산에서 멈췄는지·승인이 발송 여유에 막혔는지가 안 보이면 또 수동으로 플래그를 끄게 된다.
  return {
    scanned,
    results,
    ...(timeBudgetReached ? { timeBudgetReached } : {}),
    ...(refillBudgetReached ? { refillBudgetReached } : {}),
    ...(refillWaveClamped > 0 ? { refillWaveClamped } : {}),
    ...(refillSkippedExhausted > 0 ? { refillSkippedExhausted } : {}),
    ...(refillReadBudgetReached ? { refillReadBudgetReached } : {}),
    ...(refillReadsSpent > 0 ? { refillReadsSpent } : {}),
    ...(approvalBudgetReached ? { approvalBudgetReached } : {}),
    ...(approvalSkippedByHeadroom > 0 ? { approvalSkippedByHeadroom } : {}),
    ...(scanReadBudgetReached ? { scanReadBudgetReached } : {}),
    approvalHeadroom,
  };
}

export async function auditCampaignOutreachWave(request: CallableRequest) {
  const actor = campaignControlActor(request);
  const data = isRecord(request.data) ? request.data : {};
  const campaignId = typeof data.campaignId === "string" ? data.campaignId.trim().slice(0, 120) : "";
  const programId = typeof data.programId === "string" ? data.programId.trim().slice(0, 120) : "";
  if (!campaignId) throw Object.assign(new Error("campaignId required"), { code: "invalid-argument", errorCode: "audit_campaign_outreach_wave_campaign_id_required" });
  if (!programId) throw Object.assign(new Error("programId required"), { code: "invalid-argument", errorCode: "audit_campaign_outreach_wave_program_id_required" });
  const authorized = await adminDb.runTransaction((transaction) => readAuthorizedCampaignControlInTransaction({
    transaction,
    actor,
    programId,
    campaignId,
  }));
  const snapshot = await adminDb.collection("campaign_outreach")
    .where("campaignId", "==", campaignId)
    .select("programId", "messageRef", "creatorEmail", "to", "deliveryState", "status", "dryRun", "liveSend")
    .get();
  const rows = snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() ?? {} }));
  for (const row of rows) {
    if (resolveCanonicalProgramId(stringField(row.data, "programId", "")) !== authorized.canonicalProgramId) {
      throw Object.assign(new Error("failed-precondition: campaign outreach row program scope mismatch"), { code: "failed-precondition", errorCode: "audit_campaign_outreach_wave_campaign_outreach_row_program_scope" });
    }
  }
  const messageRefs = uniqueStrings(rows.map((row) => stringField(row.data, "messageRef", "")));
  const messagesByPath = new Map<string, Record<string, unknown>>();
  for (const values of chunkStrings(messageRefs, GETALL_CHUNK)) {
    if (values.length === 0) continue;
    const refs = values.map((path) => adminDb.doc(path));
    const messageSnapshots = await adminDb.getAll(...refs, {
      fieldMask: ["creatorEmail", "to", "dryRun", "liveSend"],
    });
    for (const messageSnapshot of messageSnapshots) messagesByPath.set(messageSnapshot.ref.path, messageSnapshot.data() ?? {});
  }
  const counts: Record<string, number> = {};
  const seenRecipientHashes = new Set<string>();
  let duplicateRecipientRows = 0;
  let dryRunRows = 0;
  let liveRows = 0;
  const rowHashes = rows.map((row) => {
    const message = messagesByPath.get(stringField(row.data, "messageRef", "")) ?? {};
    const email = validEmailField(row.data.creatorEmail) || validEmailField(row.data.to) || validEmailField(message.creatorEmail) || validEmailField(message.to);
    const recipientHash = email ? createHash("sha256").update(email).digest("hex").slice(0, 16) : "";
    if (recipientHash) {
      if (seenRecipientHashes.has(recipientHash)) duplicateRecipientRows += 1;
      seenRecipientHashes.add(recipientHash);
    }
    const state = stringField(row.data, "deliveryState", stringField(row.data, "status", "unknown"));
    counts[state] = (counts[state] ?? 0) + 1;
    const dryRun = row.data.dryRun === true || message.dryRun === true;
    const liveSend = row.data.liveSend === true || message.liveSend === true;
    if (dryRun) dryRunRows += 1;
    if (liveSend) liveRows += 1;
    return {
      rowIdHash: createHash("sha256").update(row.id).digest("hex").slice(0, 20),
      state,
      recipientHash,
      liveSend,
      dryRun,
    };
  });
  return {
    ok: true,
    programId: authorized.canonicalProgramId,
    campaignId,
    totalRows: rows.length,
    counts,
    uniqueRecipientCount: seenRecipientHashes.size,
    duplicateRecipientRows,
    programMismatches: 0,
    dryRunRows,
    liveRows,
    rowHashes,
  };
}

const CAMPAIGN_RECONCILIATION_PREVIEW_CLAIMS_COLLECTION = "campaign_outreach_reconciliation_preview_claims";
const CAMPAIGN_RECONCILIATION_AUDITS_COLLECTION = "campaign_outreach_reconciliation_audits";
const CAMPAIGN_RECONCILIATION_TOKEN_VERSION = "campaign-ledger-reconcile-v1";
const CAMPAIGN_RECONCILIATION_TTL_MS = 10 * 60 * 1000;

type CampaignReconciliationDocumentState = {
  path: string;
  exists: boolean;
  data: Record<string, unknown>;
  stateFingerprint: string;
};

type CampaignReconciliationReader = {
  getQuery: (query: Query) => Promise<FirebaseFirestore.QuerySnapshot>;
  getAll: (refs: readonly DocumentReference[]) => Promise<readonly DocumentSnapshot[]>;
};

/**
 * W59b-1 [리더 브리프 §1 · 회수기]: `sent_evidence_pending` 행의 **실발송 증거 재판정**.
 *
 * 이 상태는 두 갈래로 생긴다 — 섞으면 안 된다.
 *  (A) chat-ai.ts 의 중복 쿼터 예약 경로: sentEvidenceErrorCode =
 *      "duplicate_quota_reservation_without_conclusive_provider_evidence".
 *      **실제로 나갔는지 모른다.** 행 자체에는 provider 증거가 없다(SMTP 를 호출하지 않았을 수도 있다).
 *      → 오직 mail_outbound_log 가 **결정적으로** provider 확인일 때만 확정한다. 그 외에는 유지.
 *  (B) SMTP 성공 **후** 이력 원장 기록 실패: sentEvidenceErrorCode 가 그 외(예:
 *      mail_coldmail_history_write_failed) 이거나 sentEvidenceHistoryPending 이 서 있다.
 *      이 경로는 persistCampaignOutreachArtifacts 가 provider 결과(providerConfirmed/acceptedCount/
 *      providerMessageIdHash/deliverySource)를 **행에 이미 기록한 뒤** 상태만 pending 으로 덮었다.
 *      → 행이 실은 provider 증거로 확정한다.
 *
 * 어느 쪽도 아니면 **유지**한다(fail-closed) — "보냈는지 모호하면 보내지 않는다"가 철칙 R5-B 의 방향이고,
 * 이 도구의 목적은 모호함을 지우는 것이지 추정으로 덮는 것이 아니다.
 */
const CAMPAIGN_RECONCILIATION_AMBIGUOUS_EVIDENCE_CODE =
  "duplicate_quota_reservation_without_conclusive_provider_evidence";

function conclusiveOutboxProviderEvidence(outbox: Record<string, unknown>): boolean {
  // chat-ai.ts 의 conclusivelyProviderConfirmedOutbox 와 같은 기준이다(발송 경로가 재조정에 쓰는 값).
  return stringField(outbox, "deliveryState", "") === "sent"
    && stringField(outbox, "deliverySource", stringField(outbox, "source", "")) === "smtp-live-callable"
    && outbox.providerConfirmed === true
    && numberField(outbox, "acceptedCount", 0) > 0
    && /^[a-f0-9]{64}$/.test(stringField(outbox, "providerMessageIdHash", "").toLowerCase())
    && outbox.persisted === true;
}

type CampaignReconciliationSettleDecision = {
  readonly settle: boolean;
  readonly settledState: "sent" | "mock_sent";
  readonly evidence: string;
  readonly holdReason: string;
};

function campaignReconciliationSettleDecision(
  row: Record<string, unknown>,
  outbox: Record<string, unknown>,
): CampaignReconciliationSettleDecision {
  const errorCode = stringField(row, "sentEvidenceErrorCode", "");
  const deliverySource = stringField(row, "deliverySource", "");
  const rowProviderConfirmed = row.providerConfirmed === true || numberField(row, "acceptedCount", 0) > 0;
  const outboxConclusive = conclusiveOutboxProviderEvidence(outbox);

  if (errorCode === CAMPAIGN_RECONCILIATION_AMBIGUOUS_EVIDENCE_CODE) {
    // (A) 행의 provider 필드는 **증거가 아니다** — 이 경로는 SMTP 호출 자체가 불확실하다.
    if (outboxConclusive) {
      return { settle: true, settledState: "sent", evidence: "outbox_provider_confirmed", holdReason: "" };
    }
    return { settle: false, settledState: "sent", evidence: "", holdReason: "ambiguous_duplicate_reservation" };
  }

  // (B) SMTP 이후 이력 실패 경로.
  if (outboxConclusive) {
    return { settle: true, settledState: "sent", evidence: "outbox_provider_confirmed", holdReason: "" };
  }
  if (rowProviderConfirmed && deliverySource === "smtp-live-callable") {
    return { settle: true, settledState: "sent", evidence: "row_provider_confirmed", holdReason: "" };
  }
  if (deliverySource === "email-mock-callable") {
    // mock 은 provider 를 부르지 않는다 — 그 자체가 결정적 사실이라 mock_sent 로 확정한다.
    return { settle: true, settledState: "mock_sent", evidence: "row_mock_delivery", holdReason: "" };
  }
  return { settle: false, settledState: "sent", evidence: "", holdReason: "no_provider_evidence" };
}

type CampaignReconciliationCandidate = {
  rowId: string;
  rowRefPath: string;
  messageRefPath: string;
  outboxRefPath: string;
  historyRefPath: string;
  trackingId: string;
  recipient: string;
  recipientHash: string;
  recipientMasked: string;
  state: string;
  programId: string;
  needsOutbox: boolean;
  needsHistory: boolean;
  reason: string[];
  subject: string;
  body: string;
  sentAtIso: string;
  conversationId: string;
  creatorName: string;
  youtubeUrl: string;
  providerMessageIdHash: string;
  draftRef: string;
  subjectHash: string;
  bodyHash: string;
  outboxExists: boolean;
  historyExists: boolean;
  sourceStateFingerprint: string;
  outboxStateFingerprint: string;
  historyStateFingerprint: string;
  writeFingerprint: string;
  /** W59b-1: 이 후보가 sent_evidence_pending 회수 대상인지(그 외는 종전 원장 보정 대상). */
  pendingEvidenceRecovery: boolean;
  /** 회수 시 확정할 상태. 회수 대상이 아니면 state 와 같다. */
  settledState: string;
  /** 확정 근거 토큰(감사 로그에 남는다 — 원문·PII 금지). */
  settleEvidence: string;
  /** W59d-F3: doc id 에서 재도출하면 safeSegment 치환이 원본을 왜곡한다 — raw creatorKey 를 함께 싣는다. */
  dedupRefs: Array<{ path: string; creatorKey: string }>;
  /** W60-6: dedup SoT 정본 형상에 맞추기 위한 크리에이터 식별자(행/메시지에서 해석). */
  creatorId: string;
};

type CampaignReconciliationPlan = {
  configFingerprint: string;
  scopeFingerprint: string;
  sourceFingerprint: string;
  candidateFingerprint: string;
  planFingerprint: string;
  eligibleRows: number;
  skippedRows: number;
  /** W59b-1: 증거 부족으로 유지한 sent_evidence_pending 행 수(fail-closed). */
  heldRows: number;
  heldReasonCounts: Record<string, number>;
  candidates: CampaignReconciliationCandidate[];
};

function campaignReconciliationError(
  marker: string,
  message: string,
  code: "failed-precondition" | "invalid-argument" | "permission-denied" | "internal" = "failed-precondition",
): Error {
  return Object.assign(new Error(`${marker}: ${message}`), { code });
}

const CAMPAIGN_RECONCILIATION_TEAM_FIELDS = [
  "ownerTeam",
  "campaignOwnerTeam",
  "createdByTeam",
  "team",
  "teamId",
] as const;

function campaignReconciliationAuthScope(
  request: CallableRequest,
  auth: { uid: string; role: Role; team: string; ip: string },
): AuthContext {
  return {
    userId: auth.uid,
    role: auth.role as "super_admin" | "admin" | "manager",
    team: auth.team,
    ip: auth.ip,
    gameId: "flu-campaign",
    ...(request.auth?.token?.email ? { email: request.auth.token.email } : {}),
    ...(request.auth?.token?.name ? { name: request.auth.token.name } : {}),
  };
}

function campaignReconciliationTeamMatchesScope(row: Record<string, unknown>, auth: AuthContext): boolean {
  if (auth.role !== "manager") return true;
  const documentTeams = CAMPAIGN_RECONCILIATION_TEAM_FIELDS
    .map((field) => stringField(row, field, "").trim().toLowerCase())
    .filter(Boolean);
  if (documentTeams.length === 0) return true;
  const actorTeam = auth.team.trim().toLowerCase();
  return Boolean(actorTeam) && documentTeams.includes(actorTeam);
}

function campaignReconciliationRowMatchesScope(row: Record<string, unknown>, auth: AuthContext): boolean {
  return rowMatchesAccountScope("campaigns", row, auth)
    && campaignReconciliationTeamMatchesScope(row, auth);
}

function assertCampaignReconciliationScope(
  condition: boolean,
): asserts condition {
  if (condition) return;
  throw campaignReconciliationError(
    "mail-safety.campaign-ledger-scope-denied",
    "요청한 캠페인 범위에 대한 권한이 없습니다.",
    "permission-denied",
  );
}

function campaignReconciliationStableJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (value === undefined) return JSON.stringify("__undefined__");
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify({ __date: value.toISOString() });
  if (Buffer.isBuffer(value)) return JSON.stringify({ __bytes: value.toString("base64") });
  if (Array.isArray(value)) return `[${value.map((nested) => campaignReconciliationStableJson(nested, seen)).join(",")}]`;
  if (typeof value !== "object") return JSON.stringify(String(value));

  const objectValue = value as Record<string, unknown> & { toDate?: () => Date; path?: unknown };
  if (typeof objectValue.toDate === "function") {
    try {
      const date = objectValue.toDate();
      if (date instanceof Date && !Number.isNaN(date.getTime())) return JSON.stringify({ __timestamp: date.toISOString() });
    } catch {
      // Fall through to stable object serialization.
    }
  }
  if (typeof objectValue.path === "string" && ("firestore" in objectValue || "_firestore" in objectValue)) {
    return JSON.stringify({ __documentRef: objectValue.path });
  }
  if (seen.has(objectValue)) return JSON.stringify("__cycle__");
  seen.add(objectValue);
  const serialized = `{${Object.keys(objectValue).sort().map((key) =>
    `${JSON.stringify(key)}:${campaignReconciliationStableJson(objectValue[key], seen)}`).join(",")}}`;
  seen.delete(objectValue);
  return serialized;
}

function campaignReconciliationHash(value: unknown, length = 64): string {
  return createHash("sha256").update(campaignReconciliationStableJson(value)).digest("hex").slice(0, length);
}

function campaignReconciliationDocumentState(snapshot: DocumentSnapshot): CampaignReconciliationDocumentState {
  const data = snapshot.data() ?? {};
  return {
    path: snapshot.ref.path,
    exists: snapshot.exists,
    data,
    stateFingerprint: campaignReconciliationHash({ exists: snapshot.exists, data }),
  };
}

async function readCampaignReconciliationDocuments(
  reader: CampaignReconciliationReader,
  paths: readonly string[],
): Promise<Map<string, CampaignReconciliationDocumentState>> {
  const states = new Map<string, CampaignReconciliationDocumentState>();
  for (const pathChunk of chunkStrings(uniqueStrings([...paths]), GETALL_CHUNK)) {
    if (pathChunk.length === 0) continue;
    const snapshots = await reader.getAll(pathChunk.map((path) => adminDb.doc(path)));
    for (const snapshot of snapshots) states.set(snapshot.ref.path, campaignReconciliationDocumentState(snapshot));
  }
  return states;
}

function missingCampaignReconciliationDocumentState(path: string): CampaignReconciliationDocumentState {
  return {
    path,
    exists: false,
    data: {},
    stateFingerprint: campaignReconciliationHash({ exists: false, data: {} }),
  };
}

function campaignReconciliationTextHash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : "").digest("hex");
}

function campaignReconciliationEmailHash(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, 24);
}

type CampaignReconciliationStablePatchInput = {
  trackingId: string;
  recipient: string;
  recipientHash: string;
  subject: string;
  subjectHash: string;
  body: string;
  bodyHash: string;
  deliveryState: string;
  providerMessageIdHash: string;
  draftRef: string;
  sentAtIso: string;
  conversationId: string;
  campaignId: string;
  programId: string;
  sourceRef: string;
  creatorName: string;
  youtubeUrl: string;
  outboxRefPath: string;
  historyRefPath: string;
};

type CampaignReconciliationStablePatch = Record<string, string>;

const CAMPAIGN_RECONCILIATION_RAW_PROVIDER_FIELDS = [
  "providerMessageId",
  "providerMessageIdNormalized",
] as const;

function campaignReconciliationProviderMessageIdHash(value: string): string {
  const normalized = value.replace(/[<>]/g, "").trim().toLowerCase();
  return normalized ? createHash("sha256").update(normalized).digest("hex") : "";
}

function campaignReconciliationMaskEmail(value: string): string {
  const [local = "", domain = ""] = value.trim().toLowerCase().split("@");
  return `${local.slice(0, Math.min(2, local.length)) || "*"}***@${domain}`;
}

function campaignReconciliationBodyPreview(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > 280 ? `${collapsed.slice(0, 280)}…` : collapsed;
}

function campaignReconciliationCandidateStablePatchInput(
  candidate: CampaignReconciliationCandidate,
  campaignId: string,
): CampaignReconciliationStablePatchInput {
  return {
    trackingId: candidate.trackingId,
    recipient: candidate.recipient,
    recipientHash: candidate.recipientHash,
    subject: candidate.subject,
    subjectHash: candidate.subjectHash,
    body: candidate.body,
    bodyHash: candidate.bodyHash,
    // W59b-1: 원장에는 **확정 상태**를 새긴다. pending 을 원장에 남기면 회수의 목적(이력 정합)이 깨지고
    // 다음 재조정이 그 값을 정본으로 오해한다. 회수 대상이 아니면 settledState === state 다.
    deliveryState: candidate.settledState,
    providerMessageIdHash: candidate.providerMessageIdHash,
    draftRef: candidate.draftRef,
    sentAtIso: candidate.sentAtIso,
    conversationId: candidate.conversationId,
    campaignId,
    programId: candidate.programId,
    sourceRef: candidate.rowRefPath,
    creatorName: candidate.creatorName,
    youtubeUrl: candidate.youtubeUrl,
    outboxRefPath: candidate.outboxRefPath,
    historyRefPath: candidate.historyRefPath,
  };
}

function campaignReconciliationOutboxStablePatch(
  input: CampaignReconciliationStablePatchInput,
  auth: { uid: string; role: Role },
): CampaignReconciliationStablePatch {
  const maskedRecipient = campaignReconciliationMaskEmail(input.recipient);
  return {
    trackingId: input.trackingId,
    to: maskedRecipient,
    toMasked: maskedRecipient,
    toHash: input.recipientHash,
    subject: input.subject,
    subjectHash: input.subjectHash,
    deliveryState: input.deliveryState,
    providerMessageIdHash: input.providerMessageIdHash,
    draftRef: input.draftRef,
    gameId: "scp-automation",
    sentByUserId: auth.uid,
    sentByRole: auth.role,
    sentAtIso: input.sentAtIso,
    conversationId: input.conversationId,
    conversationRef: input.conversationId ? `conversations/${input.conversationId}` : "",
    campaignId: input.campaignId,
    programId: input.programId,
    source: "campaign_outreach_reconcile",
    sourceRef: input.sourceRef,
    mailType: "campaign_coldmail",
  };
}

function campaignReconciliationHistoryStablePatch(
  input: CampaignReconciliationStablePatchInput,
): CampaignReconciliationStablePatch {
  const normalizedRecipient = input.recipient.trim().toLowerCase();
  return {
    id: input.historyRefPath.slice("scp_coldmail_history/".length),
    programId: input.programId || DEFAULT_PROGRAM_ID,
    email: normalizedRecipient,
    emailLower: normalizedRecipient,
    emailMasked: campaignReconciliationMaskEmail(input.recipient),
    emailHash: input.recipientHash,
    koreanName: input.creatorName,
    youtubeUrl: input.youtubeUrl,
    subject: input.subject,
    subjectHash: input.subjectHash,
    body: input.body,
    bodyPreview: campaignReconciliationBodyPreview(input.body),
    bodySha256: input.bodyHash,
    campaign: input.campaignId,
    source: "campaign_outreach_reconcile",
    sourceRef: input.sourceRef,
    draftRef: input.draftRef,
    trackingId: input.trackingId,
    mailOutboxRef: input.outboxRefPath,
    conversationId: input.conversationId,
    conversationRef: input.conversationId ? `conversations/${input.conversationId}` : "",
    deliveryState: input.deliveryState,
    sentAtIso: input.sentAtIso,
  };
}

function campaignReconciliationStablePatchState(
  state: CampaignReconciliationDocumentState,
  expected: CampaignReconciliationStablePatch,
  forbiddenFields: readonly string[] = [],
): { exact: boolean; conflict: boolean } {
  if (!state.exists) return { exact: false, conflict: false };
  let exact = true;
  let conflict = false;
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (!Object.prototype.hasOwnProperty.call(state.data, field)) {
      exact = false;
      continue;
    }
    const actual = state.data[field];
    if (actual === expectedValue) continue;
    exact = false;
    // Missing/null/empty target fields are repairable. Any populated value of
    // the wrong type or content is treated as another writer's canonical data.
    if (actual !== undefined && actual !== null && actual !== "") conflict = true;
  }
  for (const field of forbiddenFields) {
    if (Object.prototype.hasOwnProperty.call(state.data, field)) exact = false;
  }
  return { exact: exact && !conflict, conflict };
}

async function buildCampaignReconciliationPlan(input: {
  reader: CampaignReconciliationReader;
  authScope: AuthContext;
  campaignId: string;
  programId: string;
  limit: number;
  fallbackSentAtIso: string;
}): Promise<CampaignReconciliationPlan> {
  const configFingerprint = campaignReconciliationHash({
    schemaVersion: "campaign-outreach-mail-ledger-reconciliation-v5",
    campaignId: input.campaignId,
    programId: input.programId,
    limit: input.limit,
    source: "campaign_outreach_reconcile",
    mailType: "campaign_coldmail",
  });
  const campaignRefPath = `campaigns/${input.campaignId}`;
  const campaignStates = await readCampaignReconciliationDocuments(input.reader, [campaignRefPath]);
  const campaignState = campaignStates.get(campaignRefPath) ?? missingCampaignReconciliationDocumentState(campaignRefPath);
  assertCampaignReconciliationScope(
    campaignState.exists
    && campaignReconciliationRowMatchesScope({ id: input.campaignId, ...campaignState.data }, input.authScope),
  );
  const campaignProgramId = stringField(campaignState.data, "programId", "");
  assertCampaignReconciliationScope(!input.programId || !campaignProgramId || campaignProgramId === input.programId);
  const snapshot = await input.reader.getQuery(
    adminDb.collection("campaign_outreach").where("campaignId", "==", input.campaignId).limit(input.limit),
  );
  const rows = snapshot.docs.map((doc) => ({
    id: doc.id,
    refPath: doc.ref.path,
    data: doc.data() ?? {},
    stateFingerprint: campaignReconciliationHash({ exists: true, data: doc.data() ?? {} }),
  }));
  for (const row of rows) {
    assertCampaignReconciliationScope(
      stringField(row.data, "campaignId", "") === input.campaignId
      && campaignReconciliationRowMatchesScope({ id: row.id, ...row.data }, input.authScope),
    );
  }
  const messageRefPaths = uniqueStrings(rows.map((row) => stringField(row.data, "messageRef", "")));
  const messageStates = await readCampaignReconciliationDocuments(input.reader, messageRefPaths);
  for (const row of rows) {
    const messageRefPath = stringField(row.data, "messageRef", "");
    const messageState = messageStates.get(messageRefPath) ?? missingCampaignReconciliationDocumentState(messageRefPath);
    assertCampaignReconciliationScope(
      /^message_sources\/[^/]+$/.test(messageRefPath)
      && messageState.exists
      && stringField(messageState.data, "campaignId", "") === input.campaignId
      && campaignReconciliationRowMatchesScope({ id: messageRefPath.slice("message_sources/".length), ...messageState.data }, input.authScope),
    );
  }
  const scopeFingerprint = campaignReconciliationHash({
    version: "campaign-owner-team-scope-v1",
    actor: {
      uidHash: campaignReconciliationHash(input.authScope.userId, 32),
      role: input.authScope.role,
      teamHash: campaignReconciliationHash(input.authScope.team, 32),
    },
    campaign: { path: campaignRefPath, stateFingerprint: campaignState.stateFingerprint },
    outreach: rows.map((row) => ({ path: row.refPath, stateFingerprint: row.stateFingerprint }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    messages: messageRefPaths.map((path) => ({
      path,
      stateFingerprint: (messageStates.get(path) ?? missingCampaignReconciliationDocumentState(path)).stateFingerprint,
    })).sort((left, right) => left.path.localeCompare(right.path)),
  });
  const sourceFingerprint = campaignReconciliationHash({
    query: { collection: "campaign_outreach", campaignId: input.campaignId, limit: input.limit },
    campaign: { path: campaignRefPath, stateFingerprint: campaignState.stateFingerprint },
    outreach: rows.map((row) => ({ path: row.refPath, stateFingerprint: row.stateFingerprint }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    messages: messageRefPaths.map((path) => ({
      path,
      stateFingerprint: (messageStates.get(path) ?? missingCampaignReconciliationDocumentState(path)).stateFingerprint,
    })).sort((left, right) => left.path.localeCompare(right.path)),
  });

  const eligible: Array<{
    row: typeof rows[number];
    messageRefPath: string;
    message: Record<string, unknown>;
    messageStateFingerprint: string;
    state: string;
    pendingEvidenceRecovery: boolean;
    programId: string;
    trackingId: string;
    recipient: string;
    outboxRefPath: string;
    historyRefPath: string;
  }> = [];
  let skippedRows = 0;
  for (const row of rows) {
    const messageRefPath = stringField(row.data, "messageRef", "");
    const messageState = messageStates.get(messageRefPath) ?? missingCampaignReconciliationDocumentState(messageRefPath);
    const message = messageState.data;
    const state = stringField(row.data, "deliveryState", stringField(row.data, "status", ""));
    // W59b-1: `sent_evidence_pending` 도 후보로 받는다 — 다만 **확정 여부는 증거 조회 뒤** 판정한다
    // (campaignReconciliationSettleDecision). 여기서 거르면 회수 도구 자체가 존재할 수 없다.
    const pendingEvidenceRecovery = state === "sent_evidence_pending";
    if (state !== "sent" && state !== "mock_sent" && !pendingEvidenceRecovery) {
      skippedRows += 1;
      continue;
    }
    const programId = stringField(row.data, "programId", stringField(message, "programId", input.programId));
    if (input.programId && programId !== input.programId) {
      skippedRows += 1;
      continue;
    }
    const trackingId = stringField(row.data, "trackingId", stringField(message, "trackingId", ""));
    const recipient = validEmailField(row.data.creatorEmail)
      || validEmailField(row.data.to)
      || validEmailField(message.creatorEmail)
      || validEmailField(message.to)
      || validEmailField(message.email);
    if (!trackingId || !recipient) {
      skippedRows += 1;
      continue;
    }
    eligible.push({
      row,
      messageRefPath,
      message,
      messageStateFingerprint: messageState.stateFingerprint,
      state,
      pendingEvidenceRecovery,
      programId,
      trackingId,
      recipient,
      outboxRefPath: `mail_outbound_log/${trackingId}`,
      historyRefPath: `scp_coldmail_history/${coldmailHistoryDocId({ email: recipient, trackingId })}`,
    });
  }

  const targetStates = await readCampaignReconciliationDocuments(
    input.reader,
    eligible.flatMap((row) => [row.outboxRefPath, row.historyRefPath]),
  );
  const candidates: CampaignReconciliationCandidate[] = [];
  // W59b-1: 증거 부족으로 **유지**한 행(fail-closed). 조용히 사라지면 운영자가 "왜 안 풀렸나"를 못 본다.
  let heldRows = 0;
  const heldReasonCounts: Record<string, number> = {};
  for (const base of eligible) {
    const outboxState = targetStates.get(base.outboxRefPath) ?? missingCampaignReconciliationDocumentState(base.outboxRefPath);
    const historyState = targetStates.get(base.historyRefPath) ?? missingCampaignReconciliationDocumentState(base.historyRefPath);
    // W59b-1: 회수 대상은 여기서 **증거로** 판정한다. 확정 불가면 후보에서 빼고(=행 무변경) 보류로 센다.
    const settleDecision = base.pendingEvidenceRecovery
      ? campaignReconciliationSettleDecision(base.row.data, outboxState.data)
      : { settle: true, settledState: base.state as "sent" | "mock_sent", evidence: "", holdReason: "" };
    if (base.pendingEvidenceRecovery && !settleDecision.settle) {
      heldRows += 1;
      heldReasonCounts[settleDecision.holdReason] = (heldReasonCounts[settleDecision.holdReason] ?? 0) + 1;
      continue;
    }
    const settledState = settleDecision.settledState;
    const subject = stringField(base.row.data, "subject", stringField(base.message, "subject", ""));
    const body = stringField(
      base.row.data,
      "body",
      stringField(base.message, "body", stringField(base.row.data, "summaryKr", stringField(base.message, "summaryKr", ""))),
    );
    const sentAtIso = stringField(
      base.row.data,
      "sentAtIso",
      stringField(base.row.data, "mailEventAtIso", stringField(base.message, "sentAtIso", input.fallbackSentAtIso)),
    );
    const conversationId = stringField(base.row.data, "conversationId", stringField(base.message, "conversationId", ""));
    const recipientHash = campaignReconciliationEmailHash(base.recipient);
    const subjectHash = campaignReconciliationTextHash(subject);
    const bodyHash = campaignReconciliationTextHash(body);
    const providerMessageId = stringField(
      base.row.data,
      "providerMessageId",
      stringField(
        base.row.data,
        "providerMessageIdNormalized",
        stringField(
          base.message,
          "providerMessageId",
          stringField(base.message, "providerMessageIdNormalized", ""),
        ),
      ),
    );
    const storedProviderMessageIdHash = stringField(
      base.row.data,
      "providerMessageIdHash",
      stringField(base.message, "providerMessageIdHash", ""),
    ).toLowerCase();
    const providerMessageIdHash = providerMessageId
      ? campaignReconciliationProviderMessageIdHash(providerMessageId)
      : /^[a-f0-9]{64}$/.test(storedProviderMessageIdHash)
        ? storedProviderMessageIdHash
        : "";
    const draftRef = stringField(
      base.row.data,
      "draftRef",
      stringField(base.message, "draftRef", stringField(base.row.data, "messageRef", base.row.id)),
    );
    const creatorName = stringField(base.row.data, "creatorName", stringField(base.message, "creatorName", ""));
    const youtubeUrl = stringField(base.row.data, "youtubeUrl", stringField(base.message, "youtubeUrl", ""));
    const stablePatchInput: CampaignReconciliationStablePatchInput = {
      trackingId: base.trackingId,
      recipient: base.recipient,
      recipientHash,
      subject,
      subjectHash,
      body,
      bodyHash,
      deliveryState: settledState,
      providerMessageIdHash,
      draftRef,
      sentAtIso,
      conversationId,
      campaignId: input.campaignId,
      programId: base.programId,
      sourceRef: base.row.refPath,
      creatorName,
      youtubeUrl,
      outboxRefPath: base.outboxRefPath,
      historyRefPath: base.historyRefPath,
    };
    const outboxStablePatch = campaignReconciliationOutboxStablePatch(
      stablePatchInput,
      { uid: input.authScope.userId, role: input.authScope.role },
    );
    const historyStablePatch = campaignReconciliationHistoryStablePatch(stablePatchInput);
    const outboxCanonical = campaignReconciliationStablePatchState(
      outboxState,
      outboxStablePatch,
      CAMPAIGN_RECONCILIATION_RAW_PROVIDER_FIELDS,
    );
    const historyCanonical = campaignReconciliationStablePatchState(historyState, historyStablePatch);
    if (outboxCanonical.conflict || historyCanonical.conflict) {
      throw campaignReconciliationError(
        "mail-safety.campaign-ledger-canonical-conflict",
        "기존 발송 원장이 캠페인 원본과 일치하지 않아 자동 복구할 수 없습니다.",
      );
    }
    const needsOutbox = !outboxCanonical.exact;
    const needsHistory = !historyCanonical.exact;
    // W59b-1: 회수 대상은 원장이 이미 정합이어도 **행 상태와 dedup SoT** 가 남아 있다 — 건너뛰면
    // 그 크리에이터는 계속 sent_evidence_pending 으로 전 프로그램 차단 상태에 남는다.
    if (!needsOutbox && !needsHistory && !base.pendingEvidenceRecovery) continue;
    const reason: string[] = [];
    if (needsOutbox) reason.push(outboxState.exists ? "outbox_incomplete" : "outbox_missing");
    if (needsHistory) reason.push(historyState.exists ? "history_incomplete" : "history_missing");
    const sourceStateFingerprint = campaignReconciliationHash({
      rowRefPath: base.row.refPath,
      rowStateFingerprint: base.row.stateFingerprint,
      messageRefPath: base.messageRefPath,
      messageStateFingerprint: base.messageStateFingerprint,
    });
    // W59b-1: dedup SoT(program_outreach_dedup)는 발송 시점에 기록되지 못했다 — 회수 시 소급 기록한다.
    // 트랜잭션 안에서 써야 하므로 doc 경로를 미리 계산해 후보에 싣는다(recordProgramOutreachSend 는
    // 자체 runTransaction 이라 이 트랜잭션 안에서 호출할 수 없다).
    const dedupRefs = base.pendingEvidenceRecovery
      ? resolveCreatorDedupKeys({ ...base.row.data, creatorEmail: base.recipient })
        .map((creatorKey) => ({
          path: `program_outreach_dedup/${programDedupDocId(base.programId, creatorKey)}`,
          creatorKey,
        }))
      : [];
    candidates.push({
      creatorId: stringField(base.row.data, "creatorId", stringField(base.message, "creatorId", "")),
      pendingEvidenceRecovery: base.pendingEvidenceRecovery,
      settledState,
      settleEvidence: settleDecision.evidence,
      dedupRefs,
      rowId: base.row.id,
      rowRefPath: base.row.refPath,
      messageRefPath: base.messageRefPath,
      outboxRefPath: base.outboxRefPath,
      historyRefPath: base.historyRefPath,
      trackingId: base.trackingId,
      recipient: base.recipient,
      recipientHash,
      recipientMasked: base.recipient.replace(/^(.{0,2}).*(@.*)$/u, "$1***$2"),
      state: base.state,
      programId: base.programId,
      needsOutbox,
      needsHistory,
      reason,
      subject,
      body,
      sentAtIso,
      conversationId,
      creatorName,
      youtubeUrl,
      providerMessageIdHash,
      draftRef,
      subjectHash,
      bodyHash,
      outboxExists: outboxState.exists,
      historyExists: historyState.exists,
      sourceStateFingerprint,
      outboxStateFingerprint: outboxState.stateFingerprint,
      historyStateFingerprint: historyState.stateFingerprint,
      writeFingerprint: campaignReconciliationHash({
        outbox: outboxStablePatch,
        history: historyStablePatch,
      }),
    });
  }
  candidates.sort((left, right) => left.rowRefPath.localeCompare(right.rowRefPath));
  const candidateFingerprint = campaignReconciliationHash(candidates.map((candidate) => ({
    rowRefPath: candidate.rowRefPath,
    messageRefPath: candidate.messageRefPath,
    outboxRefPath: candidate.outboxRefPath,
    historyRefPath: candidate.historyRefPath,
    trackingIdHash: campaignReconciliationHash(candidate.trackingId, 32),
    recipientHash: candidate.recipientHash,
    state: candidate.state,
    programId: candidate.programId,
    needsOutbox: candidate.needsOutbox,
    needsHistory: candidate.needsHistory,
    reason: candidate.reason,
    sourceStateFingerprint: candidate.sourceStateFingerprint,
    outboxStateFingerprint: candidate.outboxStateFingerprint,
    historyStateFingerprint: candidate.historyStateFingerprint,
    writeFingerprint: candidate.writeFingerprint,
  })));
  return {
    heldRows,
    heldReasonCounts,
    configFingerprint,
    scopeFingerprint,
    sourceFingerprint,
    candidateFingerprint,
    planFingerprint: campaignReconciliationHash({
      version: CAMPAIGN_RECONCILIATION_TOKEN_VERSION,
      configFingerprint,
      scopeFingerprint,
      sourceFingerprint,
      candidateFingerprint,
    }),
    eligibleRows: eligible.length,
    skippedRows,
    candidates,
  };
}

function publicCampaignReconciliationCandidate(candidate: CampaignReconciliationCandidate) {
  return {
    rowRefHash: campaignReconciliationHash(candidate.rowRefPath, 24),
    trackingIdHash: campaignReconciliationHash(candidate.trackingId, 24),
    recipientHash: candidate.recipientHash,
    recipientMasked: candidate.recipientMasked,
    state: candidate.state,
    programId: candidate.programId,
    needsOutbox: candidate.needsOutbox,
    needsHistory: candidate.needsHistory,
    reason: candidate.reason,
  };
}

function campaignReconciliationOutboxPatch(
  candidate: CampaignReconciliationCandidate,
  campaignId: string,
  auth: { uid: string; role: Role },
): Record<string, unknown> {
  return {
    ...campaignReconciliationOutboxStablePatch(
      campaignReconciliationCandidateStablePatchInput(candidate, campaignId),
      auth,
    ),
    providerMessageId: FieldValue.delete(),
    providerMessageIdNormalized: FieldValue.delete(),
    openCount: FieldValue.increment(0),
  };
}

function campaignReconciliationHistoryPatch(
  candidate: CampaignReconciliationCandidate,
  campaignId: string,
  auth: { uid: string; role: Role; team: string },
  nowIsoValue: string,
): Record<string, unknown> {
  return {
    ...campaignReconciliationHistoryStablePatch(
      campaignReconciliationCandidateStablePatchInput(candidate, campaignId),
    ),
    updatedAt: FieldValue.serverTimestamp(),
    ...(!candidate.historyExists ? {
      openCount: 0,
      lastOpenedAtIso: "",
      hasReply: false,
      createdAtIso: nowIsoValue,
      createdBy: auth.uid,
      createdByRole: auth.role,
      createdByTeam: auth.team,
      createdAt: FieldValue.serverTimestamp(),
    } : {}),
  };
}

function campaignReconciliationPreviewToken(): string {
  return `${CAMPAIGN_RECONCILIATION_TOKEN_VERSION}.${randomBytes(16).toString("hex")}`;
}

function validCampaignReconciliationPreviewToken(value: string): boolean {
  return new RegExp(`^${CAMPAIGN_RECONCILIATION_TOKEN_VERSION}\\.[a-f0-9]{32}$`).test(value);
}

function campaignReconciliationClaimRef(token: string): DocumentReference {
  return adminDb.collection(CAMPAIGN_RECONCILIATION_PREVIEW_CLAIMS_COLLECTION)
    .doc(campaignReconciliationHash(token, 40));
}

function campaignReconciliationNowMs(data: Record<string, unknown>): number {
  if (process.env.FUNCTIONS_EMULATOR === "true") {
    const emulated = Date.parse(stringField(data, "emulatorNowIso", ""));
    if (Number.isFinite(emulated)) return emulated;
  }
  return Date.now();
}

function validateCampaignReconciliationClaim(input: {
  claim: Record<string, unknown>;
  auth: { uid: string; role: Role; team: string };
  configFingerprint: string;
  nowMs: number;
}): void {
  const issuedAtMs = Date.parse(stringField(input.claim, "issuedAtIso", ""));
  const expiresAtMs = Date.parse(stringField(input.claim, "expiresAtIso", ""));
  if (
    stringField(input.claim, "version", "") !== CAMPAIGN_RECONCILIATION_TOKEN_VERSION
    || stringField(input.claim, "actorHash", "") !== campaignReconciliationHash(input.auth.uid, 32)
    || stringField(input.claim, "actorRole", "") !== input.auth.role
    || stringField(input.claim, "actorTeamHash", "") !== campaignReconciliationHash(input.auth.team, 32)
    || stringField(input.claim, "configFingerprint", "") !== input.configFingerprint
    || !Number.isFinite(issuedAtMs)
    || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= issuedAtMs
    || expiresAtMs - issuedAtMs > CAMPAIGN_RECONCILIATION_TTL_MS
  ) {
    throw campaignReconciliationError(
      "mail-safety.campaign-ledger-preview-mismatch",
      "미리보기 권한·범위 또는 구성 지문이 일치하지 않습니다. 다시 미리보기를 실행하세요.",
    );
  }
  const status = stringField(input.claim, "status", "");
  if (status !== "pending") {
    throw campaignReconciliationError(
      "mail-safety.campaign-ledger-preview-replayed",
      "이미 사용되었거나 무효화된 미리보기 토큰입니다. 다시 미리보기를 실행하세요.",
    );
  }
  if (input.nowMs > expiresAtMs) {
    throw campaignReconciliationError(
      "mail-safety.campaign-ledger-preview-expired",
      "미리보기 유효 시간이 만료되었습니다. 다시 미리보기를 실행하세요.",
    );
  }
}

function campaignReconciliationPlanMatchesClaim(plan: CampaignReconciliationPlan, claim: Record<string, unknown>): boolean {
  return stringField(claim, "configFingerprint", "") === plan.configFingerprint
    && stringField(claim, "scopeFingerprint", "") === plan.scopeFingerprint
    && stringField(claim, "sourceFingerprint", "") === plan.sourceFingerprint
    && stringField(claim, "candidateFingerprint", "") === plan.candidateFingerprint
    && stringField(claim, "planFingerprint", "") === plan.planFingerprint;
}

async function insertCampaignReconciliationEmulatorPhantom(data: Record<string, unknown>): Promise<void> {
  const phantom = isRecord(data.emulatorReconciliationPhantom) ? data.emulatorReconciliationPhantom : {};
  if (Object.keys(phantom).length === 0) return;
  if (process.env.FUNCTIONS_EMULATOR !== "true") {
    throw campaignReconciliationError(
      "mail-safety.campaign-ledger-emulator-phantom-only",
      "동시성 검증 어댑터는 Functions emulator에서만 허용됩니다.",
      "invalid-argument",
    );
  }
  const outreachId = stringField(phantom, "outreachId", "");
  const patch = isRecord(phantom.patch) ? phantom.patch : {};
  if (!outreachId || Object.keys(patch).length === 0) {
    throw campaignReconciliationError(
      "mail-safety.campaign-ledger-emulator-phantom-invalid",
      "emulatorReconciliationPhantom에는 outreachId와 patch가 필요합니다.",
      "invalid-argument",
    );
  }
  await adminDb.collection("campaign_outreach").doc(outreachId).set(patch, { merge: true });
}

async function insertCampaignReconciliationTargetEmulatorPhantom(data: Record<string, unknown>): Promise<void> {
  const phantom = isRecord(data.emulatorReconciliationTargetPhantom) ? data.emulatorReconciliationTargetPhantom : {};
  if (Object.keys(phantom).length === 0) return;
  if (process.env.FUNCTIONS_EMULATOR !== "true") {
    throw campaignReconciliationError(
      "mail-safety.campaign-ledger-emulator-phantom-only",
      "동시성 검증 어댑터는 Functions emulator에서만 허용됩니다.",
      "invalid-argument",
    );
  }
  const path = stringField(phantom, "path", "");
  const patch = isRecord(phantom.patch) ? phantom.patch : {};
  if (!/^(mail_outbound_log|scp_coldmail_history)\/[^/]+$/.test(path) || Object.keys(patch).length === 0) {
    throw campaignReconciliationError(
      "mail-safety.campaign-ledger-emulator-phantom-invalid",
      "target phantom에는 허용된 원장 path와 patch가 필요합니다.",
      "invalid-argument",
    );
  }
  await adminDb.doc(path).set(patch, { merge: true });
}

const CAMPAIGN_LIFECYCLE_REFRESH_FAILURE_CODE = "mail-safety.campaign-lifecycle-refresh-enqueue-failed";

type CampaignLifecycleRefreshResult = {
  status: "not_requested" | "enqueued" | "partial_failure" | "failed";
  attempted: number;
  enqueued: number;
  failed: number;
  failureCorrelationHashes: string[];
};

function assertCampaignLifecycleRefreshEmulatorAdapter(data: Record<string, unknown>): void {
  if (data.emulatorLifecycleRefreshFailure !== true || process.env.FUNCTIONS_EMULATOR === "true") return;
  throw campaignReconciliationError(
    "mail-safety.campaign-ledger-emulator-lifecycle-only",
    "수명주기 enqueue 실패 검증 어댑터는 Functions emulator에서만 허용됩니다.",
    "invalid-argument",
  );
}

async function enqueueCampaignReconciliationLifecycleRefreshes(
  candidates: CampaignReconciliationCandidate[],
  data: Record<string, unknown>,
): Promise<CampaignLifecycleRefreshResult> {
  const refreshCandidates = candidates.filter((candidate) => candidate.needsHistory);
  const outcomes = await Promise.all(refreshCandidates.map(async (candidate) => {
    try {
      if (data.emulatorLifecycleRefreshFailure === true && process.env.FUNCTIONS_EMULATOR === "true") {
        throw campaignReconciliationError(
          CAMPAIGN_LIFECYCLE_REFRESH_FAILURE_CODE,
          "emulated lifecycle refresh enqueue failure",
          "internal",
        );
      }
      await enqueueScpLifecycleRefreshEvent({
        source: "scp_coldmail_history",
        sourceRef: candidate.historyRefPath,
        reason: candidate.historyExists ? "coldmail_history_updated" : "coldmail_history_appended",
        aliases: [{
          email: candidate.recipient,
          trackingId: candidate.trackingId,
          conversationId: candidate.conversationId,
        }],
        sourceUpdatedAtIso: candidate.sentAtIso,
      });
      return { ok: true as const };
    } catch (error) {
      const errorRecord = error && typeof error === "object" ? error as Record<string, unknown> : {};
      const correlationHash = campaignReconciliationHash({
        sourceRef: candidate.historyRefPath,
        name: error instanceof Error ? error.name : typeof error,
        code: errorRecord.code,
      }, 16);
      console.error(CAMPAIGN_LIFECYCLE_REFRESH_FAILURE_CODE, {
        correlationHash,
        sourceRefHash: campaignReconciliationHash(candidate.historyRefPath, 24),
      });
      return { ok: false as const, correlationHash };
    }
  }));
  const failureCorrelationHashes = outcomes
    .filter((outcome): outcome is { ok: false; correlationHash: string } => !outcome.ok)
    .map((outcome) => outcome.correlationHash);
  const enqueued = outcomes.length - failureCorrelationHashes.length;
  const failed = failureCorrelationHashes.length;
  return {
    status: outcomes.length === 0
      ? "not_requested"
      : failed === 0
        ? "enqueued"
        : enqueued === 0
          ? "failed"
          : "partial_failure",
    attempted: outcomes.length,
    enqueued,
    failed,
    failureCorrelationHashes,
  };
}

export async function reconcileCampaignOutreachMailLedgers(request: CallableRequest) {
  const auth = assertManager(request);
  const authScope = campaignReconciliationAuthScope(request, auth);
  const data = isRecord(request.data) ? request.data : {};
  assertCampaignLifecycleRefreshEmulatorAdapter(data);
  const campaignId = typeof data.campaignId === "string" ? data.campaignId.trim().slice(0, 120) : "";
  if (!campaignId) throw Object.assign(new Error("campaignId required"), { code: "invalid-argument", errorCode: "reconcile_campaign_outreach_mail_ledgers_campaign_id_required" });
  const expectedProgramId = typeof data.programId === "string" ? data.programId.trim().slice(0, 120) : "";
  const dryRun = data.dryRun !== false;
  // A single transaction fences the preview claim, every source read, every
  // target CAS write, and the success audit — Firestore's ceiling is 500 writes.
  //
  // W59d-F4 [리뷰 실측]: 200 이라는 상한은 **회수기 이전**의 쓰기 모델(후보당 원장 2개) 기준이었다.
  // W59b-1 회수는 후보당 원장 2 + 행 1 + dedup 1~N(크리에이터 키 수) 을 더 쓰므로, 200 후보면
  // 최악 506 writes 로 한도를 넘어 **트랜잭션 전체가 실패**한다 — 28행을 풀려다 아무것도 못 푸는 형상이다.
  // 최악 케이스로 상한을 다시 계산한다: 후보당 2(원장) + 1(행) + 2(dedup, resolveCreatorDedupKeys 가
  // 내는 키 수의 실무 상한) = 5 writes, 여기에 claim 갱신·감사 2 writes.
  //   80 × 5 + 2 = 402 < 500  (여유 98)
  // 상한을 낮춰도 처리량은 문제되지 않는다 — 회수 대상은 프로드 28행이고, 이 콜러블은 dry-run →
  // apply 를 반복 호출할 수 있다(멱등). 청크화 대신 상한을 택한 이유는 트랜잭션을 쪼개면 "원장은
  // 채웠는데 행은 못 고친" 중간 상태가 생겨 이 항목이 고치려는 문제를 다시 만들기 때문이다.
  const limit = Math.max(1, Math.min(80, Math.trunc(numberField(data, "limit", 80))));
  if (!dryRun && data.actual !== true) {
    throw campaignReconciliationError(
      "mail-safety.campaign-ledger-actual-required",
      "dryRun:false 적용에는 actual:true가 필요합니다.",
      "invalid-argument",
    );
  }
  const nowMs = campaignReconciliationNowMs(data);
  const nowIsoValue = new Date(nowMs).toISOString();
  const configFingerprint = campaignReconciliationHash({
    schemaVersion: "campaign-outreach-mail-ledger-reconciliation-v5",
    campaignId,
    programId: expectedProgramId,
    limit,
    source: "campaign_outreach_reconcile",
    mailType: "campaign_coldmail",
  });
  const directReader: CampaignReconciliationReader = {
    getQuery: (query) => query.get(),
    getAll: (refs) => adminDb.getAll(...refs),
  };

  if (dryRun) {
    const issuedAtIso = nowIsoValue;
    const expiresAtIso = new Date(nowMs + CAMPAIGN_RECONCILIATION_TTL_MS).toISOString();
    const plan = await buildCampaignReconciliationPlan({
      reader: directReader,
      authScope,
      campaignId,
      programId: expectedProgramId,
      limit,
      fallbackSentAtIso: issuedAtIso,
    });
    // W60c-D [Codex 평결]: **적용할 게 없으면 claim 을 만들지 않는다.**
    //   claim 의 유일한 존재 이유는 뒤따르는 apply 를 그 계획에 고정(fence)하는 것이다.
    //   candidateCount === 0 이면 apply 가 바꿀 행이 애초에 없으므로 claim 은 순수 쓰레기이고,
    //   dry-run 은 진단 목적상 **반복 실행되는 것이 정상**이라 재실행마다 문서가 무한 누적된다
    //   (W60-2 조사에서 실제로 두 캠페인을 반복 조회했다 — 그때는 canonical conflict 로 claim 직전에
    //   끊겨 프로드 흔적이 0 이었을 뿐, 정상 hold-only 경로였다면 그대로 쌓였다).
    //   토큰은 빈 문자열로 돌려준다 — apply 경로가 이미 빈 토큰을 preview-required 로 **닫혀 있게**
    //   거절하므로, 조회 전용 응답이 실수로 적용 권한이 되지 않는다.
    const previewFences = plan.candidates.length > 0;
    const previewToken = previewFences ? campaignReconciliationPreviewToken() : "";
    const claimRef = previewFences ? campaignReconciliationClaimRef(previewToken) : null;
    if (claimRef) {
      await claimRef.create({
        schemaVersion: "campaign-outreach-mail-ledger-reconciliation-preview-claim-v5",
        version: CAMPAIGN_RECONCILIATION_TOKEN_VERSION,
        status: "pending",
        actorHash: campaignReconciliationHash(auth.uid, 32),
        actorRole: auth.role,
        actorTeamHash: campaignReconciliationHash(auth.team, 32),
        configFingerprint: plan.configFingerprint,
        scopeFingerprint: plan.scopeFingerprint,
        sourceFingerprint: plan.sourceFingerprint,
        candidateFingerprint: plan.candidateFingerprint,
        planFingerprint: plan.planFingerprint,
        issuedAtIso,
        expiresAtIso,
        counts: {
          eligibleRows: plan.eligibleRows,
          skippedRows: plan.skippedRows,
          candidateCount: plan.candidates.length,
        },
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    return {
      ok: true,
      dryRun: true,
      mode: "preview",
      // W60c-D: 상태를 남겼는지를 **값으로** 정확히 보고한다. hold-only 미리보기는 부작용이 0 이므로
      // previewStateful:false / sideEffects:[] 다 — 감사가 "미리보기가 뭘 남겼나"를 응답만 보고 안다.
      previewStateful: previewFences,
      sideEffects: previewFences ? ["preview_claim"] : [],
      businessWritesApplied: false,
      campaignId,
      programId: expectedProgramId,
      eligibleRows: plan.eligibleRows,
      skippedRows: plan.skippedRows,
      heldRows: plan.heldRows,
      heldReasonCounts: plan.heldReasonCounts,
      candidateCount: plan.candidates.length,
      reconciledOutbox: 0,
      reconciledHistory: 0,
      rows: plan.candidates.slice(0, 100).map(publicCampaignReconciliationCandidate),
      previewToken,
      previewClaimFingerprint: claimRef ? campaignReconciliationHash(claimRef.path, 40) : "",
      previewExpiresAtIso: expiresAtIso,
      auditRef: "",
    };
  }

  const previewToken = typeof data.previewToken === "string" ? data.previewToken.trim() : "";
  if (!previewToken) {
    throw campaignReconciliationError(
      "mail-safety.campaign-ledger-preview-required",
      "실제 적용 전에 동일 범위의 dry-run 미리보기가 필요합니다.",
    );
  }
  if (!validCampaignReconciliationPreviewToken(previewToken)) {
    throw campaignReconciliationError(
      "mail-safety.campaign-ledger-preview-mismatch",
      "미리보기 토큰 형식이 올바르지 않습니다. 다시 미리보기를 실행하세요.",
    );
  }
  const claimRef = campaignReconciliationClaimRef(previewToken);
  const claimSnapshot = await claimRef.get();
  if (!claimSnapshot.exists) {
    throw campaignReconciliationError(
      "mail-safety.campaign-ledger-preview-mismatch",
      "미리보기 권한을 찾을 수 없습니다. 다시 미리보기를 실행하세요.",
    );
  }
  const claim = claimSnapshot.data() ?? {};
  validateCampaignReconciliationClaim({ claim, auth, configFingerprint, nowMs });
  const issuedAtIso = stringField(claim, "issuedAtIso", "");

  if (isRecord(data.emulatorReconciliationPhantom) && Object.keys(data.emulatorReconciliationPhantom).length > 0) {
    // Establish a real pre-CAS discovery snapshot, then mutate it through the
    // emulator-only adapter. The transactional re-read below must reject it.
    await buildCampaignReconciliationPlan({
      reader: directReader,
      authScope,
      campaignId,
      programId: expectedProgramId,
      limit,
      fallbackSentAtIso: issuedAtIso,
    });
    await insertCampaignReconciliationEmulatorPhantom(data);
  }
  if (isRecord(data.emulatorReconciliationTargetPhantom) && Object.keys(data.emulatorReconciliationTargetPhantom).length > 0) {
    // Establish the exact target snapshot first, then let an unrelated writer
    // mutate it before the atomic apply transaction. The transaction must see
    // the changed target fingerprint and refuse to merge over that writer.
    await buildCampaignReconciliationPlan({
      reader: directReader,
      authScope,
      campaignId,
      programId: expectedProgramId,
      limit,
      fallbackSentAtIso: issuedAtIso,
    });
    await insertCampaignReconciliationTargetEmulatorPhantom(data);
  }

  const applicationId = campaignReconciliationHash({ previewToken, actor: auth.uid }, 40);
  const auditRef = adminDb.collection(CAMPAIGN_RECONCILIATION_AUDITS_COLLECTION)
    .doc(`mail-ledgers-${campaignReconciliationHash(previewToken, 40)}`);
  const claimResult = await adminDb.runTransaction(async (transaction) => {
    const currentClaimSnapshot = await transaction.get(claimRef);
    if (!currentClaimSnapshot.exists) {
      throw campaignReconciliationError(
        "mail-safety.campaign-ledger-preview-mismatch",
        "미리보기 권한을 찾을 수 없습니다. 다시 미리보기를 실행하세요.",
      );
    }
    const currentClaim = currentClaimSnapshot.data() ?? {};
    validateCampaignReconciliationClaim({
      claim: currentClaim,
      auth,
      configFingerprint,
      nowMs: campaignReconciliationNowMs(data),
    });
    const transactionReader: CampaignReconciliationReader = {
      getQuery: (query) => transaction.get(query),
      getAll: (refs) => transaction.getAll(...refs),
    };
    const plan = await buildCampaignReconciliationPlan({
      reader: transactionReader,
      authScope,
      campaignId,
      programId: expectedProgramId,
      limit,
      fallbackSentAtIso: issuedAtIso,
    });
    if (!campaignReconciliationPlanMatchesClaim(plan, currentClaim)) {
      transaction.update(claimRef, {
        status: "invalidated",
        invalidatedReason: "candidate_or_source_drift",
        invalidatedAt: FieldValue.serverTimestamp(),
      });
      return { kind: "mismatch" as const };
    }
    // Firestore 트랜잭션은 **모든 읽기가 모든 쓰기보다 앞서야** 한다 — dedup 문서 존재 여부를 여기서
    // 미리 읽는다(회수 후보가 없으면 읽기 0).
    const dedupRefPathsToRead = [...new Set(plan.candidates.flatMap((candidate) => candidate.dedupRefs.map((entry) => entry.path)))];
    const dedupReadStates = new Map<string, { exists: boolean }>();
    if (dedupRefPathsToRead.length > 0) {
      const dedupSnapshots = await transaction.getAll(...dedupRefPathsToRead.map((path) => adminDb.doc(path)));
      dedupSnapshots.forEach((snapshot, index) => {
        dedupReadStates.set(dedupRefPathsToRead[index], { exists: snapshot.exists });
      });
    }
    const invalidCandidate = plan.candidates.find((candidate) => !/^[A-Za-z0-9_-]{4,120}$/.test(candidate.trackingId));
    if (invalidCandidate) {
      transaction.update(claimRef, {
        status: "failed",
        failureCode: "mail-safety.campaign-ledger-invalid-tracking-id",
        failedAt: FieldValue.serverTimestamp(),
      });
      return { kind: "invalid_tracking_id" as const };
    }
    const reconciledOutbox = plan.candidates.filter((candidate) => candidate.needsOutbox).length;
    const reconciledHistory = plan.candidates.filter((candidate) => candidate.needsHistory).length;
    for (const candidate of plan.candidates) {
      if (candidate.needsOutbox) {
        transaction.set(
          adminDb.doc(candidate.outboxRefPath),
          campaignReconciliationOutboxPatch(candidate, campaignId, auth),
          { merge: true },
        );
      }
      if (candidate.needsHistory) {
        transaction.set(
          adminDb.doc(candidate.historyRefPath),
          campaignReconciliationHistoryPatch(candidate, campaignId, auth, nowIsoValue),
          { merge: true },
        );
      }
      if (!candidate.pendingEvidenceRecovery) continue;
      // W59b-1 [회수 확정] — 원장 두 개가 채워진 **뒤에만** 행을 확정한다(같은 트랜잭션이라 원자적이다).
      // 순서가 뒤집히면 "행은 sent 인데 이력은 없는" 상태가 새로 생겨 지금 고치는 문제를 재생산한다.
      transaction.set(adminDb.doc(candidate.rowRefPath), {
        status: candidate.settledState,
        deliveryState: candidate.settledState,
        sentEvidencePending: FieldValue.delete(),
        sentEvidenceHistoryPending: FieldValue.delete(),
        sentEvidenceErrorCode: FieldValue.delete(),
        sentEvidenceCorrelationIdHash: FieldValue.delete(),
        reconciliationRequired: FieldValue.delete(),
        automaticRetryBlocked: FieldValue.delete(),
        humanGate: FieldValue.delete(),
        sentEvidenceRecoveredAtIso: nowIsoValue,
        sentEvidenceRecoveryEvidence: candidate.settleEvidence,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      // dedup SoT 소급 기록. recordProgramOutreachSend 는 자체 runTransaction 이라 여기서 못 부른다 —
      // 같은 문서 형상을 트랜잭션 네이티브로 쓴다(멱등: 이미 있으면 재관측만 갱신한다).
      //
      // W60-6 [형상 정리]: 정본(recordProgramOutreachSend)과의 차이를 명시한다.
      //   · creatorId — **맞춘다**. 종전에 빠져 있었다(순수 누락). 이 필드는 이메일이 없거나 바뀐
      //     크리에이터의 크로스-프로그램 조회 축이라, 없으면 그 사람이 조용히 안 잡힌다.
      //   · sendCount — **일부러 다르다**. 정본은 재관측마다 increment 하지만 회수는 **이미 나간 발송을
      //     소급 기록**하는 것이고, 이 콜러블은 preview→apply 를 다시 돌리면(새 preview 로) 같은 행을
      //     또 처리할 수 있다. increment 를 걸면 그때 실제 발송 없이 카운트만 부푼다.
      //     기존 문서에는 count 를 건드리지 않고 재관측 축(lastSentAtIso/lastTrackingId)만 갱신한다.
      for (const { path: dedupRefPath, creatorKey } of candidate.dedupRefs) {
        const dedupRef = adminDb.doc(dedupRefPath);
        const dedupSnapshot = dedupReadStates.get(dedupRefPath);
        if (dedupSnapshot?.exists) {
          transaction.set(dedupRef, {
            lastSentAtIso: candidate.sentAtIso,
            lastTrackingId: candidate.trackingId,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          continue;
        }
        transaction.set(dedupRef, {
          id: dedupRef.id,
          programId: candidate.programId,
          // W59d-F3: doc id 에서 잘라내면 programDedupDocId 의 safeSegment 치환(허용 문자 외 → "_")이
          // 이미 적용된 값이라 원본과 다르다(리뷰 실측 3/8 불일치). recordProgramOutreachSend 가 쓰는
          // 것과 같은 **raw** 값을 그대로 싣는다 — 이 필드로 크로스-프로그램 조회가 돈다.
          creatorKey,
          campaignId,
          // W60-6: 정본 형상과 맞춘다(종전 누락). 회수 행에서 얻을 수 있는 값을 그대로 싣는다.
          creatorId: candidate.creatorId,
          email: candidate.recipient.toLowerCase(),
          firstTrackingId: candidate.trackingId,
          lastTrackingId: candidate.trackingId,
          firstSentAtIso: candidate.sentAtIso,
          lastSentAtIso: candidate.sentAtIso,
          sendCount: 1,
          recoveredFromSentEvidencePending: true,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }
    const audit = {
      id: auditRef.id,
      campaignId,
      programId: expectedProgramId,
      dryRun: false,
      eligibleRows: plan.eligibleRows,
      skippedRows: plan.skippedRows,
      heldRows: plan.heldRows,
      heldReasonCounts: plan.heldReasonCounts,
      candidateCount: plan.candidates.length,
      reconciledOutbox,
      reconciledHistory,
      candidateHashes: plan.candidates.map((row) => row.recipientHash),
      configFingerprint: plan.configFingerprint,
      scopeFingerprint: plan.scopeFingerprint,
      sourceFingerprint: plan.sourceFingerprint,
      candidateFingerprint: plan.candidateFingerprint,
      planFingerprint: plan.planFingerprint,
      previewClaimRefHash: campaignReconciliationHash(claimRef.path, 40),
      wroteAtIso: nowIsoValue,
      checkedAtIso: nowIsoValue,
      actorHash: campaignReconciliationHash(auth.uid, 32),
      actorRole: auth.role,
      actorTeamHash: campaignReconciliationHash(auth.team, 32),
      source: "reconcileCampaignOutreachMailLedgers",
    };
    transaction.create(auditRef, { ...audit, createdAt: FieldValue.serverTimestamp() });
    transaction.update(claimRef, {
      status: "completed",
      applicationId,
      auditRef: auditRef.path,
      result: { reconciledOutbox, reconciledHistory },
      completedAt: FieldValue.serverTimestamp(),
    });
    return { kind: "applied" as const, plan, reconciledOutbox, reconciledHistory };
  });
  if (claimResult.kind === "mismatch") {
    throw campaignReconciliationError(
      "mail-safety.campaign-ledger-preview-mismatch",
      "dry-run 이후 후보·원본 또는 대상 원장 상태가 변경되었습니다. 다시 미리보기를 실행하세요.",
    );
  }
  if (claimResult.kind === "invalid_tracking_id") {
    throw campaignReconciliationError(
      "mail-outbox-record-failed: invalid_tracking_id",
      "trackingId 형식이 올바르지 않아 원장을 기록할 수 없습니다.",
      "invalid-argument",
    );
  }

  const { plan, reconciledOutbox, reconciledHistory } = claimResult;
  const lifecycleRefresh = await enqueueCampaignReconciliationLifecycleRefreshes(plan.candidates, data);

  return {
    ok: true,
    dryRun: false,
    mode: "actual",
    previewStateful: false,
    sideEffects: [
      ...(reconciledOutbox > 0 ? ["mail_outbound_log"] : []),
      ...(reconciledHistory > 0 ? ["scp_coldmail_history"] : []),
      "reconciliation_audit",
      "preview_claim_status",
      ...(lifecycleRefresh.enqueued > 0 ? ["scp_lifecycle_refresh_outbox"] : []),
    ],
    businessWritesApplied: reconciledOutbox > 0
      || reconciledHistory > 0
      || plan.candidates.some((row) => row.pendingEvidenceRecovery),
    campaignId,
    programId: expectedProgramId,
    eligibleRows: plan.eligibleRows,
    skippedRows: plan.skippedRows,
    // W59b-1: 증거 부족으로 **유지**한 행(fail-closed). 조용히 0 으로 사라지면 운영자가 남은 차단을 못 본다.
    heldRows: plan.heldRows,
    heldReasonCounts: plan.heldReasonCounts,
    recoveredPendingEvidenceRows: plan.candidates.filter((row) => row.pendingEvidenceRecovery).length,
    candidateCount: plan.candidates.length,
    reconciledOutbox,
    reconciledHistory,
    rows: plan.candidates.slice(0, 100).map(publicCampaignReconciliationCandidate),
    previewClaimFingerprint: campaignReconciliationHash(claimRef.path, 40),
    previewExpiresAtIso: stringField(claim, "expiresAtIso", ""),
    auditRef: auditRef.path,
    lifecycleRefresh,
    warnings: lifecycleRefresh.failed > 0 ? [{
      code: CAMPAIGN_LIFECYCLE_REFRESH_FAILURE_CODE,
      count: lifecycleRefresh.failed,
      correlationHashes: lifecycleRefresh.failureCorrelationHashes,
    }] : [],
  };
}

// 이메일 발송 모드(연습/실발송) 게이트. settings/email.practiceMode 로 sendEmail 라이브 경로의 수신자 가드를 제어.
//  - practiceMode=true(기본): 사내 @supercent.io 샌드박스로만 발송(assertTestRecipient 유지).
//  - practiceMode=false: 실제 수신자에게 발송(실발송 엔진 풀가동).
async function readPracticeMode(): Promise<boolean> {
  const snapshot = await adminDb.doc(EMAIL_SETTINGS_DOC).get();
  const value = snapshot.data()?.practiceMode;
  return typeof value === "boolean" ? value : true; // 문서·필드 없으면 안전하게 연습모드.
}

// P8① admin UI needs to explain WHY outreach sending is off (auto bounce-threshold lock vs a
// manual pause vs never configured) — surfaces the same mail_safety_state/outbound fields the
// bounce-lock (lockOutboundMail) and manual toggle (setOutreachSendingEnabled) already persist.
// Shared by getEmailMode AND setEmailMode so the toggle response reflects the SAME lock truth as a
// fresh read (an active auto-lock's blockedUntilIso is not cleared by flipping outreachSendingEnabled
// alone — see mailOutboundSafety.resolveOutboundSafetyBlock — so the UI must keep showing it).
export function emailModeOutboundLockViewFromData(outboundLockData: Record<string, unknown>) {
  return {
    status: stringField(outboundLockData, "status", "") || null,
    reason: stringField(outboundLockData, "reason", "") || null,
    ruleId: stringField(outboundLockData, "ruleId", "") || null,
    updatedBy: stringField(outboundLockData, "manualPauseUpdatedBy", "") || null,
    // Lane audit metadata is per-lane. A generic `updatedAtIso` may be from a later nudge write,
    // so legacy rows without manualPauseUpdatedAtIso are unknown rather than guessed.
    updatedAtIso: stringField(outboundLockData, "manualPauseUpdatedAtIso", "") || null,
    // W118: 하드락(자동 잠금)이 아직 유효한지. 레인 토글과 무관하게 **모든 레인**을 막으므로
    //   화면이 "토글은 켰는데 왜 안 나가나"를 설명할 수 있어야 한다.
    blockedUntilIso: stringField(outboundLockData, "blockedUntilIso", "") || null,
    // W118: 독려 레인의 변경 이력은 아웃리치와 **따로** 남는다(setNudgeSendingEnabled).
    nudgeUpdatedBy: stringField(outboundLockData, "nudgePauseUpdatedBy", "") || null,
    nudgeUpdatedAtIso: stringField(outboundLockData, "nudgePauseUpdatedAtIso", "") || null,
  };
}

async function loadOutboundLockView() {
  const outboundLockSnapshot = await adminDb.doc(OUTBOUND_SAFETY_STATE_PATH).get();
  return emailModeOutboundLockViewFromData(outboundLockSnapshot.data() ?? {});
}

async function loadMailAdminStatusView(laneFlags: MailLaneFlags) {
  try {
    // laneFlags 는 호출부가 readOutreachSendingEnabled/readNudgeSendingEnabled 로 이미 읽은 값이다 —
    // 여기서 같은 문서를 또 읽으면 getEmailMode 응답의 다른 필드와 레인 판정이 어긋날 수 있다.
    return { mailAdminStatus: await readMailAdminStatus(new Date(), laneFlags) };
  } catch (error) {
    return {
      mailAdminStatusError: {
        errorCode: errorCodeForLog(error),
      },
    };
  }
}

// 현재 이메일 발송 모드 조회 — manager 이상 읽기 허용.
export async function getEmailMode(request: CallableRequest) {
  const uid = request.auth?.uid;
  const role = request.auth?.token?.role ?? "guest";
  if (!uid || !MANAGER_ROLES.has(role)) {
    const error = new Error(!uid ? "unauthenticated" : "permission-denied: manager role required");
    Object.assign(error, { code: !uid ? "unauthenticated" : "permission-denied" , errorCode: "get_email_mode_unauthorized"});
    throw error;
  }
  const [practiceMode, outreachSendingEnabled, nudgeSendingEnabled, outboundLock] = await Promise.all([
    readPracticeMode(),
    readOutreachSendingEnabled(),
    // W118: 독려 레인 스위치. 필드가 없으면 false(정지) — 재개는 사람이 명시적으로 켜야 한다.
    readNudgeSendingEnabled(),
    loadOutboundLockView(),
  ]);
  // mailAdminStatus 는 위에서 이미 읽은 레인 플래그를 그대로 물려받는다 — 같은 문서를 또 읽지 않는다.
  const mailAdminStatusView = await loadMailAdminStatusView({ outreachSendingEnabled, nudgeSendingEnabled });
  return {
    ok: true,
    practiceMode,
    outreachSendingEnabled,
    nudgeSendingEnabled,
    globalDailyTotalCap: OUTBOUND_GLOBAL_DAILY_TOTAL_CAP,
    outboundLock,
    ...mailAdminStatusView,
  };
}

// 이메일 발송 모드 변경 — super_admin만(L0: 실발송 게이트 해제는 최상위 권한). 권한변경 감사 로그(LOG-P0).
export async function setEmailMode(request: CallableRequest) {
  const auth = assertAdmin(request);
  if (auth.role !== "super_admin") {
    const behaviorLog = makeBehaviorLog(auth, "email.mode.set", "denied");
    behaviorLogs.push(behaviorLog);
    const error = new Error("permission-denied: email mode change requires super_admin");
    Object.assign(error, { code: "permission-denied", errorCode: "set_email_mode_email_mode_change_requires_super", behaviorLog });
    throw error;
  }
  const data = isRecord(request.data) ? request.data : {};
  const hasPracticeMode = Object.prototype.hasOwnProperty.call(data, "practiceMode");
  const hasOutreachSendingEnabled = Object.prototype.hasOwnProperty.call(data, "outreachSendingEnabled");
  // W118: 독려 레인 스위치. 아웃리치와 **독립적으로** 켜고 끈다 — 한쪽만 실어도 된다.
  const hasNudgeSendingEnabled = Object.prototype.hasOwnProperty.call(data, "nudgeSendingEnabled");
  if (!hasPracticeMode && !hasOutreachSendingEnabled && !hasNudgeSendingEnabled) {
    throw new Error("invalid-argument: practiceMode, outreachSendingEnabled or nudgeSendingEnabled boolean required");
  }
  if (hasPracticeMode && typeof data.practiceMode !== "boolean") throw new Error("invalid-argument: practiceMode boolean required");
  if (hasOutreachSendingEnabled && typeof data.outreachSendingEnabled !== "boolean") {
    throw new Error("invalid-argument: outreachSendingEnabled boolean required");
  }
  if (hasNudgeSendingEnabled && typeof data.nudgeSendingEnabled !== "boolean") {
    throw new Error("invalid-argument: nudgeSendingEnabled boolean required");
  }
  const practiceMode = typeof data.practiceMode === "boolean" ? data.practiceMode : await readPracticeMode();
  const outreachSendingEnabled = typeof data.outreachSendingEnabled === "boolean" ? data.outreachSendingEnabled : await readOutreachSendingEnabled();
  const nudgeSendingEnabled = typeof data.nudgeSendingEnabled === "boolean" ? data.nudgeSendingEnabled : await readNudgeSendingEnabled();

  const updatedAt = nowIso();
  const writes: Array<Promise<unknown>> = [];
  if (hasPracticeMode) writes.push(adminDb.doc(EMAIL_SETTINGS_DOC).set({ practiceMode, updatedAt, updatedBy: auth.uid }, { merge: true }));
  if (hasOutreachSendingEnabled) writes.push(setOutreachSendingEnabled(outreachSendingEnabled, auth.uid, updatedAt));
  if (hasNudgeSendingEnabled) writes.push(setNudgeSendingEnabled(nudgeSendingEnabled, auth.uid, updatedAt));
  await Promise.all(writes);

  const behaviorLog = makeBehaviorLog(
    auth,
    `email.mode.set(${practiceMode ? "practice" : "live"},outreach:${outreachSendingEnabled ? "enabled" : "paused"},nudge:${nudgeSendingEnabled ? "enabled" : "paused"})`,
    "success",
  );
  behaviorLogs.push(behaviorLog);

  const [outboundLock, mailAdminStatusView] = await Promise.all([
    loadOutboundLockView(),
    loadMailAdminStatusView({ outreachSendingEnabled, nudgeSendingEnabled }),
  ]);
  return {
    ok: true,
    practiceMode,
    outreachSendingEnabled,
    nudgeSendingEnabled,
    globalDailyTotalCap: OUTBOUND_GLOBAL_DAILY_TOTAL_CAP,
    outboundLock,
    ...mailAdminStatusView,
    behaviorLog,
  };
}

/**
 * W115 — **재고 하한 상시가동 스윕(10,000명).**
 *
 * ■ 왜 새 스케줄이 필요했나 (실측 근거)
 *   기존 하한 수확 레인은 `runCampaignOutreachAutoApprovalSweep` 안에 있고, 그 스윕의 캠페인
 *   쿼리는 `where("autoApproveLiveSend", "==", true)` 다. 즉 **발송 자동화가 켜진 캠페인이 하나도
 *   없으면 발굴이 통째로 선다** — "재고 1만을 상시 유지한다"는 목표가 발송 레인의 스위치에
 *   종속돼 있었다. W58-2 가 같은 결합을 autoRefill 분기에서 한 번 걷어냈지만, 바깥쪽 쿼리 조건은
 *   그대로 남아 있었다. 재고는 발송 상태와 무관한 축이므로 자기 스케줄을 갖는 것이 맞다.
 *   덧붙여 그 레인은 pass 당 1건이고 5분 스윕의 **시간 예산 잔여**에 의존한다 — 예산이 마르면
 *   조용히 건너뛴다. 재고 하한이 그런 최선노력 꼬리에 매달려 있으면 안 된다.
 *
 * ■ 무엇을 새로 만들지 않았나
 *   잡 타입·큐·워커·측정 함수 전부 기존 것을 그대로 쓴다. 이 함수가 하는 일은
 *   "재고를 보고 `enqueueShortfallDiscoveryJob(..., allowInventoryFloorHarvest:true)` 를 몇 번
 *   부를지" 정하는 것뿐이다 — 그 함수 안의 레이트리밋 3종(활성 잡 dedup · 1시간 간격 · 쿼터 유닛
 *   게이트)이 그대로 살아 있어 여기서 폭주가 나올 수 없다.
 *
 * ■ 자동 정지·자동 재개
 *   상태를 저장하지 않는다. 매 pass 지금 재고만 보고 결정하므로(planInventoryFloorQueue) 목표에
 *   닿으면 0건을 큐잉하고, 발송으로 재고가 줄면 다음 pass 가 알아서 다시 돈다. 표류할 상태가 없다.
 */
/**
 * 재고 분모에서도 수확 대상에서도 빠지는 캠페인 상태. 종료된 캠페인이 분모를 부풀리면 "재고 충분" 오판이 난다.
 *
 * 취소 계열은 여기 **열거하지 않는다** — `isCancelledCampaignStatus`(서버 정본)로 판정한다.
 * 종전에는 정확값 집합이라 `cancelled_preapproval_failed` · `cancelling` · `취소*` 가 전부 새어
 * 들어와 분모를 부풀렸다(프로드 실측: `cancelled_preapproval_failed` 1건).
 */
const INVENTORY_FLOOR_EXCLUDED_CAMPAIGN_STATES = new Set(["archived", "completed", "complete", "deleted"]);

/** 이 캠페인이 재고 분모·수확 대상에서 빠지는가. 취소는 접두 판정, 나머지는 정확값. */
function inventoryFloorExcludesCampaignStatus(status: string): boolean {
  return INVENTORY_FLOOR_EXCLUDED_CAMPAIGN_STATES.has(status) || isCancelledCampaignStatus(status);
}
/** 한 pass 가 훑을 최대 페이지 수. 페이지 크기(INVENTORY_FLOOR_SCAN_LIMIT)와 곱해 총 읽기 상한을 만든다. */
const INVENTORY_FLOOR_SCAN_PAGES = 4;
/**
 * W115-R1 [MEDIUM · 적대 리뷰] — 스캔 커서의 영속 위치.
 *
 * 종전 스캔은 매 pass **문서 ID 사전순 앞에서부터** 4페이지(=100개)만 봤다. 캠페인이 100개를 넘는
 * 순간 뒤쪽은 재고 분모에도 안 들어가고 측정 대상도 안 되어 **영구 미측정**이 된다 — 전역 재고 합이
 * 구조적으로 과소 보고되고, 그 과소가 다시 "아직 목표 미달"로 읽혀 앞쪽 100개만 계속 수확한다.
 * 커서를 남겨 pass 마다 다음 창으로 회전시킨다. 끝에 닿으면 처음으로 돌아온다(무상태 재개).
 *
 * 문서 1개짜리 싱글턴이다 — 캠페인 문서에 얹지 않는 이유는 이 커서가 **전역 스윕의 상태**이지
 * 어느 캠페인의 속성이 아니기 때문이다(잘못 얹으면 그 캠페인이 지워질 때 스윕이 리셋된다).
 */
const INVENTORY_FLOOR_SWEEP_STATE_COLLECTION = "discovery_sweep_state";
const INVENTORY_FLOOR_SWEEP_STATE_DOC = "inventory_floor";
/** 한 pass 가 큐잉 예산과 **무관하게** 재측정할 캠페인 수(회전). Stage 1-b 래치 해제의 실행 축이다. */
export const INVENTORY_FLOOR_MEASURE_PER_PASS = 3;

export async function runDiscoveryInventoryFloorSweep(options: {
  scanLimit?: number;
  enqueueLimit?: number;
  target?: number;
} = {}): Promise<{
  scanned: number;
  sendableEstimate: number;
  target: number;
  state: string;
  enqueued: number;
  measured: number;
}> {
  const target = Math.max(1, Math.trunc(options.target ?? YTDLP_UNSENT_INVENTORY_TARGET));
  const scanLimit = Math.max(1, Math.trunc(options.scanLimit ?? INVENTORY_FLOOR_SCAN_LIMIT));
  const enqueueLimit = Math.max(0, Math.trunc(options.enqueueLimit ?? INVENTORY_FLOOR_ENQUEUE_LIMIT_PER_PASS));
  const nowMs = Date.now();

  // 쿼터는 전역 사유다 — 캠페인마다 재보면 소진일에 같은 계측을 N번 반복한다(admin.ts 4라운드 실측).
  const quotaSlotCount = youtubeApiKeyCount();
  const quota = quotaSlotCount > 0 ? await youtubeDiscoveryQuotaBudget({ slotCount: quotaSlotCount }) : null;

  /**
   * 9d [읽기 비용 · 2026-09-05] — **결론이 정해진 계산에 pass 예산을 쓰지 않는다.**
   *
   * 쿼터가 소진되면 `planInventoryFloorQueue` 는 재고 값과 무관하게 `quota_exhausted` ·
   * `enqueueBudget: 0` 을 돌려준다(discoveryEconomics.ts — "태울 유닛이 없다"). 그런데 종전에는
   * 그 사실을 **스캔을 다 끝낸 뒤에야** 알았다: 커서 1 read + 캠페인 4페이지(4 × 25 = 100 docs)
   * + 하한 설정 1 read = pass 당 ~102 reads 를 태우고 결론은 언제나 0건 큐잉이었다.
   * 30분 주기(48 pass/일) 기준 ≈ 4,900 reads/day 다.
   *
   * 그래서 **읽기 앞에서** 본다. 소진 pass 는 campaigns 가 비어 아래 계획·큐잉·측정 루프가
   * 자연히 no-op 이 되고, 커서 쓰기도 lastScannedId 가 비어 일어나지 않는다(쓰기 0).
   *
   * ■ 측정 루프(Stage 1-b 래치)와의 관계 — **읽고 나서 결정할 것.**
   *   Stage 1-b 가 막은 것은 "큐잉 예산이 0 이면 측정도 멈춘다"는 **자기참조** 고리였다:
   *   측정이 멈추면 sendableEstimate 가 얼어붙고, 얼어붙은 값이 다시 `target_reached` 를
   *   영구 재생산했다. 여기서 멈추는 사유는 재고에서 파생되지 않는 **외부 상태**(YouTube 일일
   *   쿼터)라 스스로를 되먹이지 않는다 — 쿼터가 리셋되면 다음 pass 가 그대로 측정을 재개한다.
   *   그래서 측정 루프는 **구조를 그대로 둔다**(큐잉 예산에 다시 매달지 않는다, admin.ts:8229).
   *
   *   ⚠️ 다만 **대가는 있다**: 소진 pass 는 campaigns 가 비므로 그 pass 의 측정도 0건이다.
   *   `tests/w115-discovery-supply.test.mjs` 의 R1-S1b 주석은 "쿼터가 마른 날 측정이 통째로
   *   멈추면 같은 래치가 다른 원인으로 돌아온다"고 경고하는데, 그 경고는
   *   `enqueueShortfallDiscoveryJob` **내부**의 잡 단위 쿼터 게이트를 두고 한 말이고(측정 전용
   *   경로가 그 게이트보다 앞에 있어야 한다 — 그 계약은 그대로다), 여기 스윕 바깥의 스킵은
   *   층이 다르다. 그래도 결과적으로 **소진이 이어지는 동안 재고 값이 정체**한다.
   *   판단 근거: 그 창에서는 어차피 수확이 불가능해 정체한 값이 액추에이터를 잘못 움직일 수
   *   없고, 쿼터는 매일 리셋되어 창이 유계다. 이 판단이 틀렸다면 되돌리는 비용은 1줄이다
   *   (아래 세 곳의 `quotaExhausted` 가드 제거).
   */
  const quotaExhausted = quota?.exhausted === true;

  // 페이지 단위로 훑되 **총량을 상한으로 조인다**. 한 페이지만 보면 문서 ID 사전순으로 뒤에 있는
  //   캠페인이 이 레인에서 영원히 안 보이고(재고 합도 그만큼 과소), 상한이 없으면 캠페인이 늘수록
  //   pass 비용이 무제한으로 는다. 두 실패 모드를 같은 상수 쌍으로 막는다.
  // W115-R1 [MEDIUM]: 스캔 시작점을 **영속 커서**에서 읽는다. 커서가 없거나(최초 pass) 창을 다 돌면
  //   처음으로 돌아간다 — 이 회전이 없으면 문서 ID 사전순 뒤쪽 캠페인이 영구 미측정으로 남는다.
  const sweepStateRef = adminDb.collection(INVENTORY_FLOOR_SWEEP_STATE_COLLECTION).doc(INVENTORY_FLOOR_SWEEP_STATE_DOC);
  let scanCursorId = "";
  // 9d: 소진 pass 는 스캔을 안 하므로 커서도 읽지 않는다(커서는 스캔 시작점일 뿐이다).
  if (!quotaExhausted) {
    try {
      scanCursorId = stringField((await sweepStateRef.get()).data() ?? {}, "scanCursorId", "");
    } catch (error) {
      // 커서 읽기 실패는 최적화 손실이지 정확성 손실이 아니다 — 처음부터 훑는다(fail-open).
      console.warn("[discovery-inventory-floor] scan cursor read failed; scanning from the start", {
        errorCode: errorCodeForLog(error),
      });
    }
  }
  const campaigns: Array<{ campaignId: string; campaign: Record<string, unknown> }> = [];
  const scannedIds = new Set<string>();
  let cursor: QueryDocumentSnapshot | undefined;
  let lastScannedId = "";
  let wrapped = false;
  // 9d: 소진 pass 는 이 4페이지(≈100 docs)를 통째로 건너뛴다 — 결과가 어떻든 큐잉은 0건이다.
  for (let page = 0; !quotaExhausted && page < INVENTORY_FLOOR_SCAN_PAGES; page += 1) {
    let query: Query = adminDb.collection("campaigns").orderBy(FieldPath.documentId()).limit(scanLimit);
    if (cursor) query = query.startAfter(cursor);
    else if (scanCursorId) query = query.startAfter(scanCursorId);
    const snapshot = await query.get();
    for (const doc of snapshot.docs) {
      const campaign = (doc.data() ?? {}) as Record<string, unknown>;
      lastScannedId = doc.id;
      // 종료·보관된 캠페인은 재고 분모도 아니고 수확 대상도 아니다.
      if (inventoryFloorExcludesCampaignStatus(stringField(campaign, "status", ""))) continue;
      // 되감기가 같은 캠페인을 두 번 담으면 재고 합이 그만큼 부풀어 "목표 도달" 오판이 난다.
      if (scannedIds.has(doc.id)) continue;
      scannedIds.add(doc.id);
      campaigns.push({ campaignId: doc.id, campaign });
    }
    if (snapshot.size < scanLimit) {
      // 창 끝에 닿았다. **여기서 멈추면 안 된다** — 커서가 뒤쪽에 있을 때 이 pass 의 재고 합이
      //   꼬리 몇 건만으로 계산돼 전역 sendableEstimate 가 급락하고, 그 급락이 그대로
      //   "목표 미달"로 읽혀 하한 상향(Stage 1-a)까지 폭주시킨다. 남은 페이지 예산으로 앞에서
      //   이어 채운다. 되감기는 pass 당 1회이고 페이지 예산이 루프를 유계로 만든다.
      if (wrapped) break;
      wrapped = true;
      scanCursorId = "";
      cursor = undefined;
      continue;
    }
    cursor = snapshot.docs.at(-1);
  }

  // 재고 합은 **이미 캠페인 문서에 실려 있는** 측정값을 읽는다(추가 Firestore 읽기 0).
  // 신선도는 이 함수가 매 pass 후보를 하나 이상 재측정하며 자연히 회전한다 — 한 pass 에서 전 캠페인을
  // 다시 재는 것은 count() 집계 3×N 이라 30분 주기에서 정당화되지 않는다.
  const withInventory = campaigns.map((entry) => {
    const stored = isRecord(entry.campaign.candidatePoolInventory) ? entry.campaign.candidatePoolInventory : {};
    const measuredAtMs = Date.parse(stringField(stored, "atIso", ""));
    return {
      ...entry,
      sendableEstimate: Math.max(0, numberField(stored, "sendableEstimate", 0)),
      measuredAtMs: Number.isFinite(measuredAtMs) ? measuredAtMs : -Infinity,
    };
  });
  const sendableEstimate = withInventory.reduce((sum, entry) => sum + entry.sendableEstimate, 0);

  const plan = planInventoryFloorQueue({
    sendableEstimate,
    target,
    quotaExhausted,
    enqueueLimit,
  });

  // W115-R1 [Stage 1-a · 적대 리뷰 — 스윕과 액추에이터가 서로 다른 목표를 봤다]
  //   스윕은 **전역 10,000** 으로 판단하는데 액추에이터는 캠페인마다 750 으로 판단했다.
  //   활성 캠페인이 14개 미만이면 전원이 자기 하한을 채운 순간 잡이 0건이 되어 전역 목표가
  //   구조적으로 도달 불가다. 전역 부족분을 캠페인 수로 나눠 하한에 얹어 두 축을 같은 목표에 건다.
  // 9d: 이 값의 유일한 소비처는 아래 두 `enqueueShortfallDiscoveryJob` 호출인데, 소진 pass 는
  //   campaigns 가 비어 두 루프가 한 번도 안 돈다 — 설정 1 read 를 쓸 이유가 없다.
  const inventoryFloorOverride = quotaExhausted ? 0 : inventoryFloorPerCampaignFloor({
    baseFloor: await readCandidatePoolFloor(),
    target,
    sendableEstimate,
    activeCampaigns: campaigns.length,
  });

  // 가장 오래전에(또는 한 번도) 측정되지 않은 캠페인부터 — 문서 ID 사전순 고정 선택은 앞쪽
  // 캠페인이 매 pass 예산을 독점하고 나머지를 영구 기아시킨다(BLOCKER-B 실측과 같은 클래스).
  const ordered = [...withInventory].sort((left, right) => left.measuredAtMs - right.measuredAtMs);

  let enqueued = 0;
  let measured = 0;
  // W115-R1 [MEDIUM]: 같은 pass 안에서 앞선 잡이 계획한 유닛을 누적해 뒤 잡의 가용치에서 뺀다.
  let reservedUnits = 0;
  const enqueuedIds = new Set<string>();
  if (plan.enqueueBudget > 0) {
    for (const entry of ordered) {
      if (enqueued >= plan.enqueueBudget) break;
      const outcome = await enqueueShortfallDiscoveryJob(entry.campaignId, entry.campaign, 0, {
        allowInventoryFloorHarvest: true,
        inventoryFloorOverride,
        reservedUnits,
      });
      // 전역 사유(쿼터 소진)면 다음 후보도 같은 이유로 막힌다 — 즉시 멈춘다(같은 계측·쓰기 반복 금지).
      if (outcome.blockedGlobally === true) break;
      if (outcome.measured) measured += 1;
      // W115-R1 [HIGH 4]: 예산은 **실제 큐잉**에서만 깎는다. 종전에는 measured 로 깎아, 측정만
      //   되고 게이트에 막힌 후보가 예산을 태워 실제로 넣을 수 있는 뒤 후보가 굶었다.
      if (outcome.enqueued) {
        enqueued += 1;
        reservedUnits += Math.max(0, outcome.plannedUnits ?? 0);
      }
      enqueuedIds.add(entry.campaignId);
    }
  }

  // ── W115-R1 [Stage 1-b · 적대 리뷰 — 목표 도달 래치] ──────────────────────────────────────
  //   종전에는 `plan.enqueueBudget > 0` 일 때만 이 루프를 돌았고, 재고 측정이 그 안에서만 일어났다.
  //   그래서 목표에 닿아 예산이 0 이 되는 순간 **측정 자체가 멈추고** sendableEstimate 가 그 값으로
  //   얼어붙는다 — 발송으로 재고가 실제로 줄어도 다음 pass 는 얼어붙은 값을 다시 읽어
  //   `target_reached` 를 영구 반복한다("상태를 저장하지 않으므로 자동 재개된다"는 설계 단정이
  //   측정 경로에서 깨져 있었다).
  //   측정은 예산과 **무관하게** 매 pass 돈다 — 가장 오래된 것부터 N개씩 회전하므로 비용은
  //   pass 당 count() 집계 3×N 으로 고정된다.
  for (const entry of ordered) {
    if (measured >= INVENTORY_FLOOR_MEASURE_PER_PASS) break;
    if (enqueuedIds.has(entry.campaignId)) continue;
    const outcome = await enqueueShortfallDiscoveryJob(entry.campaignId, entry.campaign, 0, {
      allowInventoryFloorHarvest: true,
      inventoryFloorOverride,
      measureOnly: true,
    });
    if (outcome.measured) measured += 1;
  }

  // 커서를 전진시킨다 — 쓰기 실패가 스윕을 깨뜨리면 안 되므로 삼키고 경고만 남긴다(다음 pass 가
  //   같은 창을 다시 보는 것이 최악이고, 그건 종전 동작이다).
  if (lastScannedId) {
    try {
      await sweepStateRef.set({
        scanCursorId: lastScannedId,
        atIso: new Date(nowMs).toISOString(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (error) {
      console.warn("[discovery-inventory-floor] scan cursor write failed", { errorCode: errorCodeForLog(error) });
    }
  }

  // COST-P0-006: 이 pass 가 무엇을 보고 무엇을 큐잉했는지 한 줄로. 유닛 잔여를 함께 실어야
  //   "재고가 모자란데 왜 안 돌았나"가 로그만으로 갈린다.
  console.info(JSON.stringify({
    event: "discovery_inventory_floor.sweep",
    scanned: campaigns.length,
    scanCap: scanLimit * INVENTORY_FLOOR_SCAN_PAGES,
    sendableEstimate,
    target,
    progress: Number(plan.progress.toFixed(4)),
    state: plan.state,
    enqueueBudget: plan.enqueueBudget,
    enqueued,
    measured,
    // W115-R1 [Stage 1-a]: 이번 pass 가 캠페인에 건 실효 하한. 기본 하한과 다르면 전역 부족분이
    //   그만큼 얹혔다는 뜻이다 — 이 값이 없으면 "왜 하한을 넘겼는데도 계속 도는지"를 못 읽는다.
    inventoryFloorOverride,
    scanCursorId: lastScannedId,
    // W115-R1 [MEDIUM]: 이 pass 가 미리 약속한 유닛. 쿼터 스냅샷 대비 오버커밋 여부의 근거다.
    reservedUnits,
    remainingUnitsEstimate: quota?.remainingUnits ?? null,
    quotaExhausted,
    // 9d: 이 pass 가 스캔·커서·하한 읽기를 통째로 건너뛰었는가. 관측 한 줄은 소진 pass 에서도
    //   그대로 나가야 한다 — 조용히 사라지면 "왜 안 도나"를 로그로 못 읽는다.
    readsSkippedForQuota: quotaExhausted,
    atIso: new Date(nowMs).toISOString(),
  }));

  return { scanned: campaigns.length, sendableEstimate, target, state: plan.state, enqueued, measured };
}
