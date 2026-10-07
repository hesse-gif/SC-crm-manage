/**
 * Flu/Task-43 — 후보 탭: 캠페인 디스커버리 결과(candidate_pool/campaign_candidates)를 국가·최근
 * 영상 3개·최근 3개 평균 조회수 메타와 함께 테이블로 투영하고, 메일 발송 결정을 기록한다.
 *
 * 데이터 원천: candidate_pool(전역, doc id = YouTube channelId)와 campaign_candidates(캠페인별
 * 링크, functions/discovery.ts persistCandidates가 이미 채운다 — 이 파일은 그 쓰기 경로를
 * 전혀 건드리지 않는다). 프로그램/캠페인 스코프가 없으면 candidate_pool 전체를, 스코프가 있으면
 * campaign_candidates에서 channelId를 모은 뒤 candidate_pool을 원천으로 행을 만든다(신원·이메일·
 * 메타·연락 상태는 전부 candidate_pool 문서 하나에 산다 — "이 테이블이 인플루언서 모수의 원천").
 *
 * YouTube 메타(국가·최근 영상·평균 조회수)는 functions/activityRefresh.ts의 fetchChannel/
 * fetchRecentVideos를 그대로 재사용한다(호출당 COST-P0-006 쿼터 회계가 이미 내장돼 있다).
 * 캐시: candidate_pool 문서 자신의 candidateMeta.enrichedAt을 캐시 판정 기준으로 쓴다(TTL
 * CANDIDATE_META_CACHE_TTL_SECONDS=3600, discovery.ts DISCOVERY_CACHE_TTL_SECONDS와 동일한
 * "expensive call 1h" 룰) — listCandidates가 어차피 candidate_pool을 읽으므로 별도 discovery_cache
 * 조회 없이 "동일 문서 재사용"이 곧 캐시 선행이다(COST-P0-011). 히트/미스는 console.info 한 줄 +
 * 응답의 enrichment 집계로 모두 관찰 가능하다. 배치당 최대 CANDIDATE_ENRICH_BATCH_CAP개만 라이브
 * 조회한다(실비용 기준 채널 1유닛 + 검색 100유닛 + 영상 1유닛 ≈ 102유닛/후보 — 20건이면 호출당
 * ~2,040유닛이라 5로 낮춘다. 상한 밖 stale 행은 이번 호출에서 건너뛰고 다음 새로고침에서 다시
 * isCandidateMetaStale 대상이 된다 — 캐시 미스분만 계속 채워진다).
 *
 * 발송("메일 보내기", Task-43 적대 리뷰 P0): 더 이상 로컬 상태만 바꾸는 스텁이 아니다. 실제 콜드메일
 * 큐 경로(functions/admin.ts createCampaign이 쓰는 campaign_outreach/conversations 문서 계약)에
 * 후보 1건을 태운다 — 그 경로의 target당 초안 생성 블록을 admin.ts prepareCampaignOutreachDraft로
 * 추출해 그대로 재사용한다(resolveMailProfile 결과 + compileMailArtifact 컴파일 + mail-safety 판정,
 * 캠페인 생성과 동일 함수). 킬스위치/mail-safety, 그리고 programOutreachDedup.ts의 전역 dedup(어느
 * 프로그램에서든 이미 접촉했는가)를 모두 통과해야 campaign_outreach(queued_for_review) +
 * conversations 문서를 쓴다 — 막히면 문서를 아예 만들지 않고 사유만 반환한다. 사람이 "보내기"를
 * 눌렀으므로(SEND_ROLES=WRITE_ROLES=manager 이상, admin.ts approveCampaignOutreach의 승인 권한과
 * 동일 등급) 같은 호출 안에서 approveCampaignOutreach를 그대로 재호출해 승인까지 이어간다(승인
 * 로직 복제 금지 — 실제 콜러블 재사용). 실제 SMTP 발송은 여전히 functions/chat-ai.ts의 스윕
 * 워커(approved/processing 행만 집어간다)의 몫이다 — human gate는 유지된다.
 *
 * 행의 연락 상태(contactStatus)는 더 이상 로컬 필드에 쓰지 않는다(즐겨찾기/보류만 로컬). listCandidates
 * 투영 시 campaign_outreach.deliveryState(전역, 후보 channelId 기준) → 없으면 scp_coldmail_history
 * 이메일 매치 순으로 원장에서 파생한다. "발송" 라벨은 실제 deliveryState가 sent/mock_sent일 때만 쓴다.
 */
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString, assertNonGuestAuth, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { evaluateMailSafety } from "./mailSafetyPolicy";
import type { AiDramaRelevanceStamp } from "./aiDramaRelevance";
// Flu/Task-60 적대 리뷰 P0③: 이메일 정규화는 메일 발송 경로(mailSafetyPolicy 등)와 동일한
// 정본(normalizeEmailAddress)을 재사용한다 — candidatePersonKey가 독자적으로 trim/lowerCase를
// 재구현하면 두 곳의 정규화 규칙이 갈라질 위험이 있다.
import { normalizeEmailAddress } from "./mailSafetyShared";
import { fetchChannel, fetchRecentVideos } from "./activityRefresh";
import { evaluateMailProfileSafety, resolveMailProfile } from "./mailProfiles";
import { sourceRef as makeSourceRef } from "./knowledgeGraph";
import { assertScpEntitled, resolveMailAccountForEmail, type MailAccountsFirestoreDb } from "./mailAccounts";
// Flu/Task-50 적대 리뷰 P0-3: super_admin "대신 보기" 검증 헬퍼 — 쿼터 풀 라우팅 판정에도 같은
// 신원 검증(members 컬렉션 재조회)을 재사용한다.
import { resolveViewAsTarget } from "./mailAccountCallables";
import {
  resolvePoolIdForOrg,
  selectYoutubeApiKey,
  YoutubeQuotaPoolExhaustedError,
  type SelectYoutubeApiKeyInput,
} from "./youtubeQuotaPools";
import {
  approveCampaignOutreach,
  campaignOutreachCompiledArtifactFields,
  prepareCampaignOutreachDraft,
  type CampaignOutreachDraftContext,
  type CampaignTarget,
} from "./admin";
import {
  creatorSentInProgramScope,
  resolveOutreachDedupContext,
  resolveOutreachDedupScope,
} from "./programOutreachDedup";
import { readSettings } from "./settings";
import {
  assertCampaignControlActor,
  assertCampaignControlIdentity,
  campaignControlSafeFields,
} from "./campaignControlCore";
import { readConfirmedProgramAliasRegistryState } from "./programAliasRegistry";
import { resolveProgramDiscoveryCriteria, type ProgramDiscoveryPolicyResolution } from "./discovery";
import type { MutationAuthorizationActor } from "./mutationAuthorization";
import {
  canBypassAccountOwnership,
  accountOwnedRowMatchesScopeAsync,
  assertAccountOwnershipForRecordAsync,
  assertWritableAccountOwnershipScope,
  resolveAccountOwnershipScopeForRequest,
  type AccountOwnershipScope,
} from "./accountOwnership";
import { orgTabAllows } from "./orgTabPresets";
// Flu/Task-44: 후보별 발송·독려 집계 + 독려 주기 오버라이드.
import {
  NUDGE_DEFAULT_CADENCE_DAYS,
  NUDGE_SEQUENCE_TEMPLATES_DOC_PATH,
  parseNudgeSequenceConfig,
  NUDGE_COHORT1_KEY,
  NUDGE_COHORT2_KEY,
  NUDGE_COHORT3_KEY,
  type NudgeCohortKey,
  type NudgeSequenceConfig,
} from "./nudgeSequenceTemplates";
import { nudgeEmailDigest, resolveCohortCadenceMsMap } from "./nudgeCohortSweep";
import { recipientIdentityHash } from "./recipientIdentityHash";
import { nudgeSendRowFrom, NUDGE_PURPOSE_TO_COHORT } from "./nudgeReportFacts";
import {
  assertValidCandidateCadenceDays,
  writeCandidateNudgeCadenceOverride,
  CANDIDATE_CADENCE_DAYS_MIN,
  CANDIDATE_CADENCE_DAYS_MAX,
  MS_PER_DAY,
} from "./candidateNudgeCadenceOverride";
import { youtubeCreatorCountryPolicyDecision } from "./youtubeCreatorCountries";

export const CANDIDATE_POOL_COLLECTION = "candidate_pool";
const CAMPAIGN_CANDIDATES_COLLECTION = "campaign_candidates";

function requestAuthTenantId(request: CallableRequestShape): string {
  const token = asRecord(request.auth?.token);
  const firebase = asRecord(token.firebase);
  return asString(token.tenant) || asString(token.tenantId) || asString(firebase.tenant) || "default";
}
const CAMPAIGN_OUTREACH_COLLECTION = "campaign_outreach";
const COLDMAIL_HISTORY_COLLECTION = "scp_coldmail_history";
// AI-DRAMA-DISCOVERY-METAPROMPT W5: same collection functions/read.ts's listCreatorCommentInsights
// already reads. 최종 전체-브랜치 Codex 적대 리뷰 P0 수리: doc id는 `${ownerOrgId}::${channelId}`다
// (functions/creatorCommentSentiment.ts orgScopedInsightKey와 동일 규칙) — bare channelId로
// join하면 T049가 분석한 결과가 같은 채널을 발굴한 다른 org(T056 등)의 후보 행에도 그대로
// 노출됐다(T049 격리를 어김). row.ownerOrgId가 있는 행만 조회한다.
const CREATOR_COMMENT_INSIGHTS_COLLECTION = "creator_comment_insights";
const MAIL_OUTBOUND_LOG_COLLECTION = "mail_outbound_log";
const PROGRAMS_COLLECTION = "programs";
const CAMPAIGNS_COLLECTION = "campaigns";
// 팝오버 타임라인에 보관하는 최근 이벤트 상한(발송+독려 합산). 본문/제목은 절대 담지 않는다
// (SEC-P0-009) — 일시·유형·결과·대화 딥링크만.
const OUTREACH_TIMELINE_MAX_EVENTS = 10;
// Flu/Task-46: 후보 회신 → 파트너 전환. candidateTable.ts/candidatePartnerConversion.ts 양쪽이
// 같은 문자열을 쓰도록 여기서 export한다(매직 스트링 드리프트 방지) — 컬렉션 읽기/쓰기 로직은
// candidatePartnerConversion.ts에만 있다(이 파일은 listCandidates 투영을 위해 읽기만 한다).
export const CANDIDATE_REPLY_PARTNERS_COLLECTION = "candidate_reply_partners";
const CONVERSATIONS_COLLECTION = "conversations";

// COST-P0-011: YouTube 채널/영상 조회는 "expensive call" — discovery.ts DISCOVERY_CACHE_TTL_SECONDS
// 와 동일한 1시간 TTL. 후보 문서 자신의 candidateMeta.enrichedAt이 캐시 상태다.
const CANDIDATE_META_CACHE_TTL_SECONDS = 3600;
const CANDIDATE_RECENT_VIDEO_COUNT = 3;
// 한 번의 listCandidates 호출에서 라이브로 재조회할 후보 수 상한. 실비용 기준 채널(1) + 검색(100) +
// 영상(1) ≈ 102유닛/후보 — 예전 20은 호출당 최대 ~2,040유닛이라 5로 낮춘다(~510유닛/호출).
const CANDIDATE_ENRICH_BATCH_CAP = 5;
// Flu/0673 핫픽스 보강: 후보 탭 무한 로딩 회귀 근인 — 이 배치(최대 5건)를 순차 조회하면 각 건이
// activityRefresh.ts youtubeGet의 기본 12s fetch 타임아웃까지 대기할 수 있어 listCandidates가
// 60초를 넘길 수 있었다(index.ts는 이미 timeoutSeconds:120으로 늘려뒀다 — 이 상수는 그 여유를
// 갉아먹지 않도록 한 건당 대기를 짧게 끊는다). 이 경로에서만 짧게 끊는다 — activityRefresh.ts
// 자체의 스케줄 경로는 기본값(12s) 그대로 둔다(youtubeGet의 timeoutMs 기본값 참고).
const CANDIDATE_ENRICH_YOUTUBE_TIMEOUT_MS = 4_000;
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;
// Firestore `in` 쿼리 상한(programOutreachDedup.ts FIRESTORE_IN_QUERY_LIMIT과 동일 근거).
const CANDIDATE_TABLE_IN_QUERY_LIMIT = 30;

const READ_ROLES = ["super_admin", "admin", "manager", "viewer"] as const;
// WRITE_ROLES: 후보 테이블에 쓰기를 남기는 모든 변경(행 상태·메일 발송)의 공통 권한 등급 —
// functions/chat-ai.ts sendEmail, admin.ts approveCampaignOutreach의 WRITE_ROLES와 동일.
const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;
const SEND_ROLES = WRITE_ROLES;

// ---------- 최소 구조적 Firestore 인터페이스(테스트에서 에뮬레이터 없이 페이크로 대체 가능) ----------
// functions/mailAccounts.ts MailAccountsFirestoreDb와 같은 목적의 최소 구조 타입.

interface CandidateTableDocSnapshot {
  readonly id: string;
  readonly exists: boolean;
  // Task-45: Firestore가 문서마다 자동으로 붙이는 생성 시각(merge 쓰기로도 절대 갱신되지 않는다 —
  // updatedAtIso와 달리 재디스커버리로 후보가 다시 갱신돼도 "새 유입"으로 잘못 세지 않는다).
  // 옵션 필드라 이 구조적 인터페이스를 구현하는 다른(테스트용) 더미 스냅샷도 깨지지 않는다.
  readonly createTime?: { toDate(): Date } | null;
  data(): Record<string, unknown> | undefined;
}
interface CandidateTableDocRef {
  readonly id: string;
  get(): Promise<CandidateTableDocSnapshot>;
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
  // conversations/{id}/messages/{msgId} 같은 서브컬렉션 쓰기용(sendCandidateColdMail).
  collection(name: string): CandidateTableCollectionRef;
}
interface CandidateTableQuerySnapshot {
  readonly docs: CandidateTableDocSnapshot[];
}
interface CandidateTableQuery {
  where(field: string, op: "==" | "in", value: unknown): CandidateTableQuery;
  // P1-3(2026-09-11 적대 리뷰): limit(pageSize)만 쓰고 정렬이 없으면 Firestore가 어느 페이지가
  // 나올지 보장하지 않는다 — 문서 이름 기준으로 정렬해 같은 pageSize 안에서는 항상 같은 첫 페이지가
  // 결정적으로 나오게 한다(기존에도 무순서였으므로 정렬 도입 자체는 회귀가 아니다).
  orderBy(field: string): CandidateTableQuery;
  limit(n: number): CandidateTableQuery;
  get(): Promise<CandidateTableQuerySnapshot>;
}
interface CandidateTableCollectionRef extends CandidateTableQuery {
  doc(id: string): CandidateTableDocRef;
}
interface CandidateTableWriteBatch {
  set(ref: CandidateTableDocRef, data: Record<string, unknown>, options?: { merge?: boolean }): void;
  commit(): Promise<unknown>;
}
export interface CandidateTableDb {
  collection(name: string): CandidateTableCollectionRef;
  getAll(...refs: CandidateTableDocRef[]): Promise<CandidateTableDocSnapshot[]>;
  batch(): CandidateTableWriteBatch;
}

function resolveCandidateTableDb(db?: CandidateTableDb): CandidateTableDb {
  return db ?? (adminDb as unknown as CandidateTableDb);
}

// ---------- 공개 타입(클라이언트 프로젝션 — 이메일 본문/프롬프트 원문 없음, SEC-P0-009) ----------

export interface CandidateTableVideoSnapshot {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  publishedAtIso: string | null;
  viewCount: number | null;
  // AI-DRAMA-DISCOVERY-METAPROMPT W4: statistics.likeCount was already in the YouTube videos.list
  // response toVideoSnapshot parses — it was simply discarded. No new API call.
  likeCount: number | null;
}

// AI-DRAMA-DISCOVERY-METAPROMPT W4: "who is this creator" fields already written onto
// candidate_pool docs at discovery time (functions/candidateScope.ts globalCandidateIdentityData
// spreads the full CandidateResult, discovery.ts:230-250) but never projected into the table row.
// Zero new API calls — this is a read-time projection of already-stored fields.
export interface CandidateTableIdentity {
  avatar: string | null;
  category: string | null;
  // Truncated summary — full publicDescription can run to ~5,000 chars (discovery.ts persist cap).
  publicDescription: string | null;
  creatorCountry: string | null;
  followers: number | null;
  youtubeUrl: string | null;
  matchScore: number | null;
  signals: string[];
}

// AI-DRAMA-DISCOVERY-METAPROMPT W5: pre-computed (never live — listCandidates never triggers
// analysis itself) JEV comment-sentiment result, read from creator_comment_insights/{channelId}
// (functions/creatorCommentSentiment.ts's async sweep writes it). null when no analysis has run
// yet, or the async pipeline found the sample insufficient/the JEV call unavailable.
export interface CandidateTableCommentSentiment {
  status: "ok" | "insufficient_sample" | "unavailable";
  choice: string | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  analyzedCount: number;
  analyzedAtIso: string;
}

export interface CandidateTableMeta {
  country: string | null;
  subscribers: number | null;
  recentVideos: CandidateTableVideoSnapshot[];
  avgRecentViews: number | null;
  enrichedAt: string | null;
  enrichSource: "cache" | "live" | null;
  qualifyingVideoCount: number | null;
  minVideoViewThreshold: number | null;
  topQualifyingVideo: Record<string, unknown> | null;
  qualifyingVideoEvidence: Record<string, unknown>[];
}

// Task-43 적대 리뷰 P0④: 로컬 필드가 아니라 원장(campaign_outreach → scp_coldmail_history)에서
// 파생한다. "발송"은 실제 deliveryState가 sent/mock_sent(_evidence_pending)일 때만.
// Task-46: "회신"/"수락 후보"/"협의 중"/"수락"은 hydrateReplyAcceptance가 conversations.inboundIntent
// (기존 인바운드 분류 파이프라인, functions/mailHumanGate.ts)와 candidate_reply_partners(전환 상태)
// 에서 덮어쓰는 오버레이다 — hydrateContactStatus가 채운 발송류 상태보다 항상 우선한다(회신은
// 발송 이후에만 존재할 수 있으므로 순서상 상위 정보다).
export type CandidateContactStatus =
  | "미연락"
  | "검수 대기"
  | "발송 예정"
  | "발송"
  | "차단"
  | "회신"
  | "수락 후보"
  | "협의 중"
  | "수락";

export interface CandidateTableRowState {
  contactStatus: CandidateContactStatus;
  favorite: boolean;
  decision: "hold" | null;
  lastActionAt: string | null;
  lastActionBy: string | null;
  lastSendBlockedReason: string | null;
  lastSendBlockedRuleId: string | null;
}

// Flu/Task-44: 팝오버 타임라인 한 행 — 본문/제목 원문은 절대 담지 않는다(SEC-P0-009). 대화는
// conversationId만 넘기고 클라이언트가 /chat?conversationId=... 딥링크로 연다.
export interface CandidateTableOutreachEvent {
  atIso: string;
  type: "coldmail" | "nudge";
  result: string;
  conversationId: string | null;
}

// Flu/Task-44: 후보별 발송·독려 집계(scp_coldmail_history + mail_outbound_log 원장에서 매
// listCandidates 호출마다 라이브로 파생 — 별도 카운터/백필 없음, 원장이 정본이라 항상 정확하다).
// 재리뷰 MED-HIGH-2: nextNudgeAtIso가 어떤 축에서 나왔는지 UI가 밝힐 수 있게 하는 근거 표시 —
// "override"(후보 오버라이드) > "cohort"(코호트별 cadence, resolveCohortCadenceMsMap) >
// "default"(전역 기본, 판정 불가 포함) 순으로 판정한다.
export type CandidateTableNextNudgeBasis = "override" | "cohort" | "default";

// 2026-09-11 rebase(Task-45 우선 재리뷰 P1-2가 예고한 대로): Task-44의 hydrateOutreachStats가
// stats 필드 전체(발송·독려 카운트 포함)의 정본이다 — Task-45가 이름만 맞춰 뒀던
// CandidateTableStats는 폐기하고 이 타입을 그대로 쓴다. Task-45의 lastOutreachAtIso 계산
// (campaign_outreach 기준)은 별도 필드로 남아 있으니 stats.lastSentAtIso와 충돌하지 않는다 —
// historySortKey는 stats?.lastSentAtIso를 우선하고 lastOutreachAtIso로 폴백한다.
export interface CandidateTableOutreachStats {
  coldmailCount: number;
  nudgeCount: number;
  lastSentAtIso: string | null;
  nextNudgeAtIso: string | null;
  hasReply: boolean;
  // null이면 후보 오버라이드 없음 — effectiveCadenceDays가 전역 기본(NUDGE_DEFAULT_CADENCE_DAYS)이다.
  cadenceDaysOverride: number | null;
  effectiveCadenceDays: number;
  nextNudgeBasis: CandidateTableNextNudgeBasis;
  timeline: CandidateTableOutreachEvent[];
}

export interface CandidateTableRow {
  id: string; // channelId
  candidateRef: string; // candidate_pool/{channelId}
  campaignCandidateRef: string | null;
  programId: string | null;
  campaignId: string | null;
  name: string;
  handle: string;
  platform: string;
  email: string | null;
  emailStatus: string;
  // Task-45: 캘린더 뷰(날짜별 유입 카운트)의 유입일 근거. candidate_pool 문서 자신의 Firestore
  // createTime(문서 생성 시각, merge 쓰기로 갱신되지 않음) — 기존 후보가 재디스커버리로 갱신돼도
  // 새 유입으로 잘못 세지 않는다.
  createdAtIso: string | null;
  meta: CandidateTableMeta;
  state: CandidateTableRowState;
  stats: CandidateTableOutreachStats;
  // P1-2: hydrateContactStatus가 campaign_outreach 원장에서 파생한 발송 시각 — stats와 분리된
  // 별도 필드라 Task-44의 stats 전체 덮어쓰기와 절대 충돌하지 않는다. 발송류(sent/mock_sent/
  // sent_evidence_pending) 상태로 확정된 행만 채운다(그 전 단계면 null).
  lastOutreachAtIso: string | null;
  // 2026-09-11 재리뷰 P1(기존 결함 (a)안): exact-scope 디스커버리(program/campaign 스코프)는
  // candidateScope.ts buildProgramScopedCandidateParticipationWrites 경로로 campaign_candidates
  // 링크 문서만 쓰고 candidate_pool은 아직 안 쓸 수 있다 — 그런 행은 rowFromLinkDocData로 읽기
  // 전용 투영되고 poolBacked=false다. candidate_pool 문서가 실제로 있는 행만 true(별표/보류/주기
  // 편집 가능 — updateCandidateRowState가 candidate_pool 존재를 전제하므로 poolBacked=false 행은
  // 그 콜러블을 호출하면 not-found로 거부된다. 클라이언트는 poolBacked로 미리 막는다).
  poolBacked: boolean;
  // Flu/Task-60: 채널ID 단위 dedupe(rowsByChannelId Map) 위의 2차(사람 단위) dedupe 표시 — 같은
  // 인물이 서로 다른 channelId로 candidate_pool/campaign_candidates에 존재해 두 행으로 보일 때,
  // annotateCandidateDuplicates가 우선순위 규칙으로 고른 승자(canonical) 행의 channelId를 나머지
  // (패자) 행에 채운다. 승자 자신과, 병합 대상이 없는 일반 행은 null — 행 자체는 응답에서 제거하지
  // 않는다(서버 투영에서만 해결하는 범위 — 실제 화면에서 접거나 강조 표시하는 것은 이후 UI 작업).
  duplicateOf: string | null;
  accountScopeVersion: string | null;
  ownerOrgId: string | null;
  ownerMailAccountId: string | null;
  canEditNudgeCadence: boolean;
  nudgeCadenceReadOnlyReason: string | null;
  qualifyingVideoCount: number | null;
  minVideoViewThreshold: number | null;
  topQualifyingVideo: Record<string, unknown> | null;
  qualifyingVideoEvidence: Record<string, unknown>[];
  // AI-DRAMA-DISCOVERY-METAPROMPT W4: see CandidateTableIdentity doc comment.
  identity: CandidateTableIdentity;
  // AI-DRAMA-DISCOVERY-METAPROMPT W5: see CandidateTableCommentSentiment doc comment. Populated by
  // hydrateCommentSentiment (listCandidates) — null until the async sweep has written a result.
  commentSentiment: CandidateTableCommentSentiment | null;
  // functions/aiDramaRelevance.ts's gate stamps this directly onto the candidate_pool/
  // campaign_candidates doc at discovery time (ai_drama vertical only) — unlike commentSentiment
  // this is a plain field read, not a separate async-sweep hydrate. null for game-vertical
  // candidates and for any ai_drama candidate materialized before this gate existed.
  aiDramaRelevance: AiDramaRelevanceStamp | null;
}

// ---------- 작은 헬퍼(이 파일 전용 — asRecord/asString은 shared.ts 것을 쓴다) ----------

function asNumber(value: unknown, fallback: number): number {
  const num = typeof value === "string" ? Number(value) : value;
  return typeof num === "number" && Number.isFinite(num) ? num : fallback;
}

function numberOrNull(value: unknown): number | null {
  const num = typeof value === "string" ? Number(value) : value;
  return typeof num === "number" && Number.isFinite(num) ? num : null;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

// Task-46: candidatePartnerConversion.ts가 candidateRef → channelId 변환을 그대로 재사용한다
// (동일 로직 중복 금지 — export만 추가, 본문은 그대로).
export function channelIdFromCandidateRef(candidateRef: string): string {
  const prefix = `${CANDIDATE_POOL_COLLECTION}/`;
  return candidateRef.startsWith(prefix) ? candidateRef.slice(prefix.length) : "";
}

function channelIdFromLinkDoc(data: Record<string, unknown>): string {
  const fromRef = channelIdFromCandidateRef(asString(data.candidateRef));
  if (fromRef) return fromRef;
  return asString(data.candidateId);
}

function invalidArgument(errorCode: string, message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode });
}

function notFound(errorCode: string, message: string): Error {
  return Object.assign(new Error(`not-found: ${message}`), { code: "not-found", errorCode });
}

function permissionDenied(errorCode: string, message: string): Error {
  return Object.assign(new Error(`permission-denied: ${message}`), { code: "permission-denied", errorCode });
}

function failedPrecondition(errorCode: string, message: string): Error {
  return Object.assign(new Error(`failed-precondition: ${message}`), { code: "failed-precondition", errorCode });
}

function toVideoSnapshot(raw: Record<string, unknown>): CandidateTableVideoSnapshot | null {
  const videoId = asString(raw.id);
  if (!videoId) return null;
  const snippet = asRecord(raw.snippet);
  const statistics = asRecord(raw.statistics);
  const thumbnails = asRecord(snippet.thumbnails);
  const thumbnailUrl =
    asString(asRecord(thumbnails.medium).url) ||
    asString(asRecord(thumbnails.high).url) ||
    asString(asRecord(thumbnails.default).url) ||
    null;
  return {
    videoId,
    title: asString(snippet.title, "(제목 없음)"),
    thumbnailUrl,
    publishedAtIso: asString(snippet.publishedAt) || null,
    viewCount: numberOrNull(statistics.viewCount),
    likeCount: numberOrNull(statistics.likeCount),
  };
}

// AI-DRAMA-DISCOVERY-METAPROMPT W4: projects candidate_pool's already-stored identity fields
// (functions/candidateScope.ts globalCandidateIdentityData spreads the full CandidateResult onto
// the doc at discovery time — discovery.ts:230-250 for the field set). publicDescription is
// summarized to a short excerpt for the row (the full text stays in the source doc, unread here).
const CANDIDATE_IDENTITY_DESCRIPTION_EXCERPT_LENGTH = 200;

// Codex 적대 리뷰 P0 수리: publicDescription은 YouTube About 텍스트 원문이고, 이 저장소의 이메일
// 채굴 파이프라인(discovery.ts extractEmailsForDiscovery)이 바로 이 텍스트에서 이메일을 캔다 —
// 즉 원문을 그대로 돌려주면 emailStatus로 통제되지 않는 별도 경로로 원문 이메일이 새 나간다
// (SEC-P0-009). row.email/emailStatus가 이미 통제된 정본 노출 경로이므로, 카드 설명란에서는
// 이메일처럼 보이는 부분 문자열을 제거한다.
const DESCRIPTION_EMAIL_REDACT_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function redactEmailsForDisplay(text: string): string {
  return text.replace(DESCRIPTION_EMAIL_REDACT_PATTERN, "[email]");
}

// Codex 적대 리뷰 P1 수리: avatar/publicDescription/creatorCountry/followers/youtubeUrl은 채널
// 자체의 사실(candidate_pool 전역 문서가 정본)이지만, category/matchScore/signals는 qualifyingVideo*
// 와 같은 급의 "이 캠페인 기준으로 왜/어떻게 매치됐는가" 증거다 — rowFromPoolDocData가
// qualifyingVideoCount 등에 이미 쓰는 projectionData(스코프 오버레이가 있으면 오버레이, 없으면
// data 자신)를 그대로 받아 같은 우선순위를 따른다. matchContext 기본값이 data 자신이므로 오버레이가
// 없는 기존 호출(rowFromLinkDocData 등)은 동작이 완전히 그대로다.
function identityFromCandidateData(
  data: Record<string, unknown>,
  matchContext: Record<string, unknown> = data,
): CandidateTableIdentity {
  const publicDescription = asString(data.publicDescription);
  return {
    avatar: asString(data.avatar) || null,
    category: asString(matchContext.category) || null,
    publicDescription: publicDescription
      ? redactEmailsForDisplay(publicDescription).slice(0, CANDIDATE_IDENTITY_DESCRIPTION_EXCERPT_LENGTH)
      : null,
    creatorCountry: asString(data.creatorCountry) || null,
    followers: numberOrNull(data.followers),
    youtubeUrl: asString(data.youtubeUrl) || null,
    matchScore: numberOrNull(matchContext.matchScore),
    signals: Array.isArray(matchContext.signals)
      ? matchContext.signals.filter((item): item is string => typeof item === "string")
      : [],
  };
}

function aiDramaRelevanceFromCandidateData(data: Record<string, unknown>): AiDramaRelevanceStamp | null {
  const raw = asRecord(data.aiDramaRelevance);
  const score = numberOrNull(raw.score);
  const scorePercent = numberOrNull(raw.scorePercent);
  const reason = asString(raw.reason);
  const judgedAtIso = asString(raw.judgedAtIso);
  if (score === null || scorePercent === null || !reason || !judgedAtIso) return null;
  return { score, scorePercent, reason, judgedAtIso, modelId: asString(raw.modelId) };
}

function isCandidateMetaStale(enrichedAtIso: string | null, nowMs: number): boolean {
  if (!enrichedAtIso) return true;
  const enrichedMs = Date.parse(enrichedAtIso);
  if (!Number.isFinite(enrichedMs)) return true;
  return nowMs - enrichedMs > CANDIDATE_META_CACHE_TTL_SECONDS * 1000;
}

// Task-45: candidate_pool 문서의 Firestore createTime(문서 자체 생성 시각)을 ISO 문자열로 읽는다.
// merge 쓰기(재디스커버리)로는 절대 갱신되지 않는다 — updatedAtIso와 달리 유입일 집계에 안전하다.
function snapshotCreatedAtIso(snap: CandidateTableDocSnapshot): string | null {
  const toDate = snap.createTime?.toDate;
  if (typeof toDate !== "function") return null;
  const date = toDate.call(snap.createTime);
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}


// AI-DRAMA-DISCOVERY-METAPROMPT W4 legacy-doc fix: topQualifyingVideoField/qualifyingVideoEvidenceField
// below return raw Firestore records verbatim (unlike rowFromPoolDocData's own recentVideos mapping,
// which already runs every field through numberOrNull). A record written before likeCount (or any
// future per-video stat field) existed has that key entirely absent, not explicitly null, so once
// this record reaches the client typed as CandidateTableVideoSnapshot (src/lib/data.ts — `number |
// null`, never optional), a naive `=== null` guard on the client sees `undefined` and crashes
// (CandidateTable.tsx fmtViews/fmtCount — the production bug e2e/ai-drama-org-scope-transition.spec.ts
// reproduces). Coerce the two numeric snapshot fields so the contract actually holds for legacy docs
// without disturbing the record's other (non-snapshot) fields some callers also read off it (e.g.
// row.topQualifyingVideo?.country).
function normalizeVideoSnapshotNumericFields(record: Record<string, unknown>): Record<string, unknown> {
  return {
    ...record,
    viewCount: numberOrNull(record.viewCount),
    likeCount: numberOrNull(record.likeCount),
  };
}

function topQualifyingVideoField(data: Record<string, unknown>, metaRaw: Record<string, unknown> = asRecord(data.candidateMeta)): Record<string, unknown> | null {
  const direct = asRecord(data.qualifyingVideo);
  if (Object.keys(direct).length > 0) return normalizeVideoSnapshotNumericFields(direct);
  const explicit = asRecord(data.topQualifyingVideo);
  if (Object.keys(explicit).length > 0) return normalizeVideoSnapshotNumericFields(explicit);
  const metaDirect = asRecord(metaRaw.qualifyingVideo);
  if (Object.keys(metaDirect).length > 0) return normalizeVideoSnapshotNumericFields(metaDirect);
  const metaTop = asRecord(metaRaw.topQualifyingVideo);
  if (Object.keys(metaTop).length > 0) return normalizeVideoSnapshotNumericFields(metaTop);
  const videos = Array.isArray(data.qualifyingVideos) ? data.qualifyingVideos.map(asRecord) : [];
  const metaVideos = Array.isArray(metaRaw.qualifyingVideos) ? metaRaw.qualifyingVideos.map(asRecord) : [];
  const found = [...videos, ...metaVideos].find((video) => Object.keys(video).length > 0) ?? null;
  return found ? normalizeVideoSnapshotNumericFields(found) : null;
}

function qualifyingVideoEvidenceField(data: Record<string, unknown>, metaRaw: Record<string, unknown> = asRecord(data.candidateMeta)): Record<string, unknown>[] {
  const qualification = videoQualificationRecord(data, metaRaw);
  return [
    topQualifyingVideoField(data, metaRaw),
    ...asRecordArray(data.qualifyingVideos),
    ...asRecordArray(data.qualifyingVideoEvidence),
    ...asRecordArray(data.qualifyingVideoEvidences),
    ...asRecordArray(metaRaw.qualifyingVideos),
    ...asRecordArray(metaRaw.qualifyingVideoEvidence),
    ...asRecordArray(metaRaw.qualifyingVideoEvidences),
    asRecord(qualification.qualifyingVideo),
    ...asRecordArray(qualification.qualifyingVideos),
    ...asRecordArray(qualification.qualifyingVideoEvidence),
    ...asRecordArray(qualification.qualifyingVideoEvidences),
  ].map(asRecord).filter((record) => Object.keys(record).length > 0).map(normalizeVideoSnapshotNumericFields);
}

function videoQualificationRecord(data: Record<string, unknown>, metaRaw: Record<string, unknown> = asRecord(data.candidateMeta)): Record<string, unknown> {
  const direct = asRecord(data.videoQualification);
  return Object.keys(direct).length > 0 ? direct : metaRaw;
}

function qualifyingVideoCountField(data: Record<string, unknown>, metaRaw: Record<string, unknown> = asRecord(data.candidateMeta)): number | null {
  const qualification = videoQualificationRecord(data, metaRaw);
  return numberOrNull(qualification.qualifyingVideoCount) ?? numberOrNull(data.qualifyingVideoCount) ?? numberOrNull(metaRaw.qualifyingVideoCount);
}

function minVideoViewThresholdField(data: Record<string, unknown>, metaRaw: Record<string, unknown> = asRecord(data.candidateMeta)): number | null {
  const qualification = videoQualificationRecord(data, metaRaw);
  return numberOrNull(qualification.minVideoViews)
    ?? numberOrNull(qualification.minVideoViewThreshold)
    ?? numberOrNull(data.minVideoViews)
    ?? numberOrNull(data.minVideoViewThreshold)
    ?? numberOrNull(metaRaw.minVideoViews)
    ?? numberOrNull(metaRaw.minVideoViewThreshold);
}

function minVideoCountField(data: Record<string, unknown>, metaRaw: Record<string, unknown> = asRecord(data.candidateMeta)): number | null {
  const qualification = videoQualificationRecord(data, metaRaw);
  return numberOrNull(qualification.minVideoCount) ?? numberOrNull(data.minVideoCount) ?? numberOrNull(metaRaw.minVideoCount);
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((record) => Object.keys(record).length > 0)
    : [];
}

function rowFromPoolDocData(channelId: string, data: Record<string, unknown>, createdAtIso: string | null, scopedOverlay: Record<string, unknown> = {}): CandidateTableRow {
  const overlay = asRecord(scopedOverlay);
  const hasScopedOverlay = Object.keys(overlay).length > 0;
  const metaRaw = asRecord(data.candidateMeta);
  const projectionData = hasScopedOverlay ? overlay : data;
  const stateRaw = hasScopedOverlay
    ? asRecord(overlay.candidateTableState)
    : asRecord(data.candidateTableState);
  const recentVideosRaw = Array.isArray(metaRaw.recentVideos) ? metaRaw.recentVideos : [];
  const enrichSourceRaw = metaRaw.enrichSource;
  return {
    id: channelId,
    candidateRef: asString(data.candidateRef) || `${CANDIDATE_POOL_COLLECTION}/${channelId}`,
    campaignCandidateRef: asString(projectionData.campaignCandidateRef) || null,
    programId: asString(projectionData.canonicalProgramId) || asString(projectionData.programId) || null,
    campaignId: asString(projectionData.campaignId) || null,
    name: asString(data.name, "(이름 없음)"),
    handle: asString(data.handle),
    platform: asString(data.platform, "YouTube"),
    email: asString(data.email) || null,
    emailStatus: asString(data.emailStatus, "none"),
    createdAtIso,
    meta: {
      country: asString(metaRaw.country) || null,
      subscribers: numberOrNull(metaRaw.subscribers),
      recentVideos: recentVideosRaw.map(asRecord).map((v) => ({
        videoId: asString(v.videoId),
        title: asString(v.title),
        thumbnailUrl: asString(v.thumbnailUrl) || null,
        publishedAtIso: asString(v.publishedAtIso) || null,
        viewCount: numberOrNull(v.viewCount),
        // AI-DRAMA-DISCOVERY-METAPROMPT W4: mirrors toVideoSnapshot's new field — this reads back
        // the stored candidateMeta.recentVideos snapshot (written by toVideoSnapshot at enrichment
        // time), not a fresh API call.
        likeCount: numberOrNull(v.likeCount),
      })),
      avgRecentViews: numberOrNull(metaRaw.avgRecentViews),
      enrichedAt: asString(metaRaw.enrichedAt) || null,
      enrichSource: enrichSourceRaw === "live" || enrichSourceRaw === "cache" ? enrichSourceRaw : null,
      qualifyingVideoCount: qualifyingVideoCountField(projectionData, metaRaw),
      minVideoViewThreshold: minVideoViewThresholdField(projectionData, metaRaw),
      topQualifyingVideo: topQualifyingVideoField(projectionData, metaRaw),
      qualifyingVideoEvidence: qualifyingVideoEvidenceField(projectionData, metaRaw),
    },
    state: {
      // Task-43 P0④: contactStatus는 더 이상 이 로컬 필드에서 읽지 않는다 — listCandidates가
      // hydrateContactStatus로 원장에서 덮어쓴다. 여기 기본값은 "아직 못 찾았을 때"의 폴백뿐이다.
      contactStatus: "미연락",
      favorite: stateRaw.favorite === true,
      decision: stateRaw.decision === "hold" ? "hold" : null,
      lastActionAt: asString(stateRaw.lastActionAt) || null,
      lastActionBy: asString(stateRaw.lastActionBy) || null,
      lastSendBlockedReason: asString(stateRaw.lastSendBlockedReason) || null,
      lastSendBlockedRuleId: asString(stateRaw.lastSendBlockedRuleId) || null,
    },
    // Task-44: 카운트/타임라인은 hydrateOutreachStats가 채운다(listCandidates). 오버라이드 자체는
    // candidate_pool 문서 자기 필드라 여기서 바로 읽는다 — 편집 즉시(재조회 없이) 화면에 반영된다.
    stats: {
      coldmailCount: 0,
      nudgeCount: 0,
      lastSentAtIso: null,
      nextNudgeAtIso: null,
      hasReply: false,
      cadenceDaysOverride: candidateCadenceDaysOverrideFromState(stateRaw),
      effectiveCadenceDays: candidateCadenceDaysOverrideFromState(stateRaw) ?? NUDGE_DEFAULT_CADENCE_DAYS,
      // 재리뷰 MED-HIGH-2: hydrateOutreachStats가 발송 이력이 있는 후보만 "cohort"로 승격한다 —
      // 오버라이드가 있으면 "override", 그 외(발송 이력 없음 포함)는 일단 "default".
      nextNudgeBasis: candidateCadenceDaysOverrideFromState(stateRaw) !== null ? "override" : "default",
      timeline: [],
    },
    // hydrateContactStatus가 발송류 상태로 확정된 행만 lastOutreachAtIso를 덮어쓴다.
    lastOutreachAtIso: null,
    poolBacked: true,
    // annotateCandidateDuplicates(listCandidates)가 있으면 채운다 — 기본은 중복 아님.
    duplicateOf: null,
    accountScopeVersion: asString(projectionData.accountScopeVersion) || null,
    ownerOrgId: asString(projectionData.ownerOrgId) || null,
    ownerMailAccountId: asString(projectionData.ownerMailAccountId) || null,
    canEditNudgeCadence: true,
    nudgeCadenceReadOnlyReason: null,
    qualifyingVideoCount: qualifyingVideoCountField(projectionData, metaRaw),
    minVideoViewThreshold: minVideoViewThresholdField(projectionData, metaRaw),
    topQualifyingVideo: topQualifyingVideoField(projectionData, metaRaw),
    qualifyingVideoEvidence: qualifyingVideoEvidenceField(projectionData, metaRaw),
    // AI-DRAMA-DISCOVERY-METAPROMPT W4: avatar/description/country/followers/youtubeUrl live on
    // the candidate_pool doc itself (like name/handle/email above); category/matchScore/signals
    // are match evidence and use the same scope-overlay priority as qualifyingVideoCount etc.
    // above (Codex 적대 리뷰 P1 수리 — projectionData falls back to `data` when there is no
    // overlay, so this is byte-identical to before for every non-overlay call).
    identity: identityFromCandidateData(data, projectionData),
    commentSentiment: null,
    aiDramaRelevance: aiDramaRelevanceFromCandidateData(projectionData) ?? aiDramaRelevanceFromCandidateData(data),
  };
}

// 2026-09-11 재리뷰 P1(기존 결함 (a)안): candidate_pool 문서가 아직 없는 채널을 위해 링크 문서
// (campaign_candidates) 자체의 필드로 읽기 전용 행을 구성한다. persistCandidates(discovery.ts)가
// exact-scope 경로에서 candidateScope.ts buildProgramScopedCandidateParticipationWrites의
// participationData를 그대로 써 넣으므로 — participationData는 globalCandidateIdentityData를
// 스프레드해 candidate_pool 문서와 같은 필드명(name/handle/platform/email/emailStatus/followers/
// creatorCountry|region)을 그대로 담는다.
function rowFromLinkDocData(channelId: string, data: Record<string, unknown>): CandidateTableRow {
  return {
    id: channelId,
    candidateRef: asString(data.candidateRef) || `${CANDIDATE_POOL_COLLECTION}/${channelId}`,
    campaignCandidateRef: asString(data.campaignCandidateRef) || null,
    programId: asString(data.canonicalProgramId) || asString(data.programId) || null,
    campaignId: asString(data.campaignId) || null,
    name: asString(data.name, "(이름 없음)"),
    handle: asString(data.handle),
    platform: asString(data.platform, "YouTube"),
    email: asString(data.email) || null,
    emailStatus: asString(data.emailStatus, "none"),
    createdAtIso: null,
    meta: {
      country: asString(data.creatorCountry) || asString(data.region) || null,
      subscribers: numberOrNull(data.followers),
      recentVideos: [],
      avgRecentViews: null,
      enrichedAt: null,
      enrichSource: null,
      qualifyingVideoCount: qualifyingVideoCountField(data),
      minVideoViewThreshold: minVideoViewThresholdField(data),
      topQualifyingVideo: topQualifyingVideoField(data),
      qualifyingVideoEvidence: qualifyingVideoEvidenceField(data),
    },
    state: {
      contactStatus: "미연락",
      favorite: false,
      decision: null,
      lastActionAt: null,
      lastActionBy: null,
      lastSendBlockedReason: null,
      lastSendBlockedRuleId: null,
    },
    // candidateTableState가 없는(candidate_pool 미등록) 행이라 오버라이드도 없다 — 전역 기본으로.
    // hydrateOutreachStats(Task-44)가 email 기준 발송 이력을 찾으면 이 기본값을 덮어쓴다.
    stats: {
      coldmailCount: 0,
      nudgeCount: 0,
      lastSentAtIso: null,
      nextNudgeAtIso: null,
      hasReply: false,
      cadenceDaysOverride: null,
      effectiveCadenceDays: NUDGE_DEFAULT_CADENCE_DAYS,
      nextNudgeBasis: "default",
      timeline: [],
    },
    lastOutreachAtIso: null,
    poolBacked: false,
    // annotateCandidateDuplicates(listCandidates)가 있으면 채운다 — 기본은 중복 아님.
    duplicateOf: null,
    accountScopeVersion: asString(data.accountScopeVersion) || null,
    ownerOrgId: asString(data.ownerOrgId) || null,
    ownerMailAccountId: asString(data.ownerMailAccountId) || null,
    canEditNudgeCadence: false,
    nudgeCadenceReadOnlyReason: "candidate_pool_required",
    qualifyingVideoCount: qualifyingVideoCountField(data),
    minVideoViewThreshold: minVideoViewThresholdField(data),
    topQualifyingVideo: topQualifyingVideoField(data),
    qualifyingVideoEvidence: qualifyingVideoEvidenceField(data),
    // AI-DRAMA-DISCOVERY-METAPROMPT W4: participationData (this function's `data`) already spreads
    // globalCandidateIdentityData (file header comment above) — same field names as the pool doc.
    identity: identityFromCandidateData(data),
    commentSentiment: null,
    aiDramaRelevance: aiDramaRelevanceFromCandidateData(data),
  };
}

function candidateCadenceDaysOverrideFromState(stateRaw: Record<string, unknown>): number | null {
  const value = stateRaw.nudgeCadenceDaysOverride;
  return typeof value === "number" && Number.isInteger(value)
    && value >= CANDIDATE_CADENCE_DAYS_MIN && value <= CANDIDATE_CADENCE_DAYS_MAX
    ? value
    : null;
}

// ---------- 연락 상태 파생(campaign_outreach → scp_coldmail_history, 전역 판단) ----------

// deliveryState/status → 라벨. 값이 여러 개면(여러 캠페인에서 한 후보를 건드렸으면) 더 진행된
// 상태가 이긴다(발송 > 발송 예정 > 검수 대기 > 차단). admin.ts CAMPAIGN_REFILL_COUNTED_STATES /
// programOutreachDedup.ts SENT_OUTREACH_STATES와 동일한 상태 이름을 쓴다.
const OUTREACH_STATE_RANK: Record<string, number> = {
  sent: 4,
  mock_sent: 4,
  sent_evidence_pending: 4,
  approved: 3,
  processing: 3,
  queued_for_review: 2,
  blocked: 1,
  suppressed_duplicate: 1,
};

function contactStatusFromDeliveryState(state: string): CandidateContactStatus | null {
  if (state === "sent" || state === "mock_sent" || state === "sent_evidence_pending") return "발송";
  if (state === "approved" || state === "processing") return "발송 예정";
  if (state === "queued_for_review") return "검수 대기";
  if (state === "blocked" || state === "suppressed_duplicate") return "차단";
  return null;
}

// rows를 제자리에서 갱신한다(row.state.contactStatus). campaign_outreach를 candidateId(=channelId)
// 로 배치 조회하고, 거기 없는 후보만 scp_coldmail_history를 이메일로 배치 조회해 레거시/수기 발송
// 이력을 잡는다(programOutreachDedup.ts creatorSentInColdmailHistory와 동일 판단 — 존재 자체가
// "이미 콜드 접촉함"). program_outreach_dedup SoT는 여기서 조회하지 않는다(500행 페이지에서 행당
// round-trip이 되는 걸 피하려 배치 가능한 두 원장만 쓴다 — sent로 끝난 발송은 항상 campaign_outreach
// 에도 남으므로 커버리지 공백은 program_outreach_dedup에만 있고 campaign_outreach엔 없는 극히 드문
// 정합성 갭뿐이다).
// Task-45: 발송류(sent/mock_sent/sent_evidence_pending) 상태에서만 발송일을 잡는다 — "발송 예정"
// 단계 등은 아직 실제로 보낸 게 아니므로 히스토리 서브뷰 정렬 근거(lastOutreachAtIso)로 삼지 않는다.
const SENT_CLASS_STATES = new Set(["sent", "mock_sent", "sent_evidence_pending"]);

type CandidateTableLedgerScope = {
  accountScope: AccountOwnershipScope | null;
  programId: string;
  campaignId: string;
};

function scopedLedgerProgramIds(scope: CandidateTableLedgerScope): Set<string> {
  return new Set([scope.programId].filter(Boolean));
}

function ledgerProgramIds(record: Record<string, unknown>): string[] {
  return [
    asString(record.programId),
    asString(record.canonicalProgramId),
    asString(record.gameId),
  ].filter(Boolean);
}

function ledgerCampaignIds(record: Record<string, unknown>): string[] {
  return [asString(record.campaignId), asString(record.campaign)].filter(Boolean);
}

function ledgerRowMatchesProgram(record: Record<string, unknown>, scope: CandidateTableLedgerScope): boolean {
  const programIds = scopedLedgerProgramIds(scope);
  if (programIds.size === 0) return true;
  const rowProgramIds = ledgerProgramIds(record);
  return rowProgramIds.some((programId) => programIds.has(programId));
}

async function ledgerRowMatchesScope(
  scope: CandidateTableLedgerScope,
  row: Record<string, unknown>,
): Promise<boolean> {
  const rowCampaignIds = ledgerCampaignIds(row);
  if (scope.campaignId && rowCampaignIds.length > 0) {
    if (!rowCampaignIds.includes(scope.campaignId)) return false;
    return ledgerRowMatchesProgram(row, scope);
  }

  const rowProgramIds = ledgerProgramIds(row);
  if (scope.programId && rowProgramIds.length > 0) return ledgerRowMatchesProgram(row, scope);

  if (scope.campaignId || scope.programId) {
    return scope.accountScope ? accountOwnedRowMatchesScopeAsync(scope.accountScope, row) : false;
  }
  if (!scope.accountScope) return true;
  return accountOwnedRowMatchesScopeAsync(scope.accountScope, row);
}

async function hydrateContactStatus(
  db: CandidateTableDb,
  rows: CandidateTableRow[],
  scope: CandidateTableLedgerScope,
): Promise<void> {
  if (rows.length === 0) return;
  const channelIds = dedupeStrings(rows.map((row) => row.id).filter((id) => id.length > 0));
  const bestStateByChannelId = new Map<string, string>();
  // Task-45: campaign_outreach 문서 자신의 발송 시각(chat-ai.ts 스윕 워커가 채우는 sentAtIso,
  // 없으면 sendCandidateColdMail이 큐에 넣을 때 찍은 createdAtIso로 폴백) — 랭크가 더 높은 상태로
  // 갱신될 때만 같이 갱신한다(가장 진행된 상태의 시각이 정본).
  const sentAtIsoByChannelId = new Map<string, string>();
  for (const chunk of chunkArray(channelIds, CANDIDATE_TABLE_IN_QUERY_LIMIT)) {
    if (chunk.length === 0) continue;
    const snapshot = await db.collection(CAMPAIGN_OUTREACH_COLLECTION).where("candidateId", "in", chunk).get();
    for (const doc of snapshot.docs) {
      if (!doc.exists) continue;
      const data = asRecord(doc.data());
      if (!await ledgerRowMatchesScope(scope, data)) continue;
      const candidateId = asString(data.candidateId);
      const state = asString(data.deliveryState) || asString(data.status);
      if (!candidateId || !state) continue;
      const rank = OUTREACH_STATE_RANK[state] ?? 0;
      const previousState = bestStateByChannelId.get(candidateId);
      const previousRank = previousState ? (OUTREACH_STATE_RANK[previousState] ?? 0) : -1;
      if (rank > previousRank) {
        bestStateByChannelId.set(candidateId, state);
        const sentAtIso = SENT_CLASS_STATES.has(state)
          ? asString(data.sentAtIso) || asString(data.createdAtIso)
          : "";
        if (sentAtIso) sentAtIsoByChannelId.set(candidateId, sentAtIso);
        else sentAtIsoByChannelId.delete(candidateId);
      }
    }
  }

  const emailsToProbe = dedupeStrings(
    rows
      .filter((row) => !bestStateByChannelId.has(row.id))
      .map((row) => (row.email ?? "").toLowerCase())
      .filter((email) => email.includes("@")),
  );
  const sentEmails = new Set<string>();
  // Task-45: scp_coldmail_history는 sentAtIso를 최상위 평평한 필드로 갖는다
  // (functions/managementProfileTabsReadModels.ts 주석 — 발송 원장 스키마 근거).
  const sentAtIsoByEmail = new Map<string, string>();
  for (const chunk of chunkArray(emailsToProbe, CANDIDATE_TABLE_IN_QUERY_LIMIT)) {
    if (chunk.length === 0) continue;
    const snapshot = await db.collection(COLDMAIL_HISTORY_COLLECTION).where("emailLower", "in", chunk).get();
    for (const doc of snapshot.docs) {
      if (!doc.exists) continue;
      const historyData = asRecord(doc.data());
      if (!await ledgerRowMatchesScope(scope, historyData)) continue;
      const email = asString(historyData.emailLower).toLowerCase();
      if (!email) continue;
      sentEmails.add(email);
      const sentAtIso = asString(historyData.sentAtIso);
      if (sentAtIso) sentAtIsoByEmail.set(email, sentAtIso);
    }
  }

  for (const row of rows) {
    const deliveryState = bestStateByChannelId.get(row.id);
    if (deliveryState) {
      row.state = { ...row.state, contactStatus: contactStatusFromDeliveryState(deliveryState) ?? "미연락" };
      // P1-2: stats는 건드리지 않는다(Task-44 hydrateOutreachStats가 통째로 덮어쓸 자리) —
      // campaign_outreach 기준 값은 별도 필드 lastOutreachAtIso로만 채운다.
      row.lastOutreachAtIso = sentAtIsoByChannelId.get(row.id) ?? null;
      continue;
    }
    const email = (row.email ?? "").toLowerCase();
    if (email && sentEmails.has(email)) {
      row.state = { ...row.state, contactStatus: "발송" };
      row.lastOutreachAtIso = sentAtIsoByEmail.get(email) ?? null;
    }
  }
}

// ---------- 발송·독려 집계(Task-44) ----------
// row.stats를 제자리에서 채운다(row.state는 건드리지 않는다 — hydrateContactStatus와 병렬로
// Promise.all에서 같이 돌아도 서로 다른 필드라 충돌하지 않는다).
//
// 콜드메일 = scp_coldmail_history 전량(append-only, "발송 1건=1행" — 막힌/억제된 발송은애초에
// 이 원장에 쓰이지 않는다: candidateTable.ts sendCandidateColdMail의 블록 경로는 이 원장에
// 아무것도 안 쓰고, chat-ai.ts/scpOutreach.ts도 실제 발송 성공 후에만 append한다 — 그래서
// deliveryState로 다시 거르지 않는다. "발송 실패·억제분 포함 여부" 결정: append-only 원장
// 자체가 이미 성공분만 담으므로 별도 필터가 불필요).
// 독려 = mail_outbound_log 중 nudgeSendRowFrom이 인정하는 행만(mailPurpose가 독려 목적이고
// deliveryState==="sent"인 것만 — mock_sent/blocked/skipped_duplicate 제외, W118 사고 교훈과
// 동일 기준). 두 원장은 서로 쓰지 않는 축이라(독려는 scp_coldmail_history에 절대 안 쓴다,
// Task-44 조사 결과) 합산해도 이중계상이 없다.
// 재리뷰 MED-HIGH-2: NUDGE_PURPOSE_TO_COHORT(nudgeReportFacts.ts)가 쓰는 짧은 코호트 이름
// ("cohort1" 등)을 nudgeSequenceTemplates.ts의 NudgeCohortKey("cohort1_read_no_reply" 등)로
// 바꾼다 — resolveCohortCadenceMsMap이 반환하는 맵은 후자를 키로 쓰므로 반드시 거쳐야 한다.
const NUDGE_COHORT_SHORT_TO_KEY: Readonly<Record<"cohort1" | "cohort2" | "cohort3", NudgeCohortKey>> = {
  cohort1: NUDGE_COHORT1_KEY,
  cohort2: NUDGE_COHORT2_KEY,
  cohort3: NUDGE_COHORT3_KEY,
};

// 재리뷰 MED-HIGH-2: nudgeSequenceTemplates.ts readNudgeSequenceConfig()는 adminDb를 직접 써서
// db 주입 테스트가 불가능하다(이 파일 CandidateTableDb 관례 위반) — 그래서 같은 문서
// (NUDGE_SEQUENCE_TEMPLATES_DOC_PATH)를 주입된 db로 읽고, 파싱은 정본 parseNudgeSequenceConfig를
// 그대로 재사용한다(파싱 로직 복제 금지 — 정본은 한 곳).
async function readCandidateTableCohortConfig(db: CandidateTableDb): Promise<NudgeSequenceConfig> {
  const [collectionName, docId] = NUDGE_SEQUENCE_TEMPLATES_DOC_PATH.split("/");
  try {
    const snap = await db.collection(collectionName).doc(docId).get();
    return parseNudgeSequenceConfig(snap.exists ? asRecord(snap.data()) : {});
  } catch (error) {
    console.warn("readCandidateTableCohortConfig: 코호트 설정 조회 실패 — 기본값으로 폴백", error);
    return parseNudgeSequenceConfig({});
  }
}

// AI-DRAMA-DISCOVERY-METAPROMPT W5: batched read-only join from creator_comment_insights (doc id
// === channelId, functions/creatorCommentSentiment.ts's async sweep is the only writer of the
// commentSentiment field). Pure projection — never triggers analysis, never blocks on it, and a
// missing/malformed doc simply leaves row.commentSentiment at its null default (set by
// rowFromPoolDocData/rowFromLinkDocData). Independent of row.state/row.meta/row.stats, so it is
// safe to run in parallel with the other hydrators.
function commentSentimentFromInsightData(data: Record<string, unknown>): CandidateTableCommentSentiment | null {
  const stored = asRecord(data.commentSentiment);
  const status = asString(stored.status);
  if (status !== "ok" && status !== "insufficient_sample" && status !== "unavailable") return null;
  const probabilitiesRaw = asRecord(stored.probabilities);
  const probabilities = Object.keys(probabilitiesRaw).length > 0
    ? Object.fromEntries(Object.entries(probabilitiesRaw).map(([key, value]) => [key, numberOrNull(value) ?? 0]))
    : null;
  return {
    status,
    choice: asString(stored.choice) || null,
    probabilities,
    confidence: numberOrNull(stored.confidence),
    analyzedCount: numberOrNull(stored.analyzedCount) ?? 0,
    analyzedAtIso: asString(stored.analyzedAtIso) || "",
  };
}

async function hydrateCommentSentiment(db: CandidateTableDb, rows: CandidateTableRow[]): Promise<void> {
  // ownerOrgId가 없는 행(growth 등 org-scope 밖)은 애초에 comment_insights_pending을 절대
  // 채우지 않는 발굴 경로에서 나온 것이라 조회해도 항상 미스다 — 스킵해서 불필요한 읽기를 줄인다.
  const scopedRows = rows.filter((row): row is CandidateTableRow & { ownerOrgId: string } => Boolean(row.ownerOrgId));
  if (scopedRows.length === 0) return;
  for (const chunk of chunkArray(scopedRows, CANDIDATE_TABLE_IN_QUERY_LIMIT)) {
    const refs = chunk.map((row) => db.collection(CREATOR_COMMENT_INSIGHTS_COLLECTION).doc(`${row.ownerOrgId}::${row.id}`));
    const snaps = await db.getAll(...refs);
    snaps.forEach((snap, index) => {
      if (!snap.exists) return;
      chunk[index].commentSentiment = commentSentimentFromInsightData(asRecord(snap.data()));
    });
  }
}

async function hydrateOutreachStats(
  db: CandidateTableDb,
  rows: CandidateTableRow[],
  scope: CandidateTableLedgerScope,
): Promise<void> {
  if (rows.length === 0) return;
  const rowsByEmail = new Map<string, CandidateTableRow[]>();
  for (const row of rows) {
    const email = (row.email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) continue;
    const bucket = rowsByEmail.get(email);
    if (bucket) bucket.push(row);
    else rowsByEmail.set(email, [row]);
  }
  const emails = [...rowsByEmail.keys()];
  if (emails.length === 0) return;

  type Accum = {
    coldmail: CandidateTableOutreachEvent[];
    nudge: CandidateTableOutreachEvent[];
    hasReply: boolean;
    // 재리뷰 MED-HIGH-2: "다음 독려 코호트" 판정용 — 마지막 독려의 mailPurpose(있으면 그걸로
    // 코호트를 정한다), 없으면 마지막 콜드메일의 trackingId(스윕이 "첫 독려"에 쓰는 코호트를
    // 그대로 따라간다 — 콜드메일 열람 여부로 코호트1/3을 가른다).
    lastNudgeAtMs: number;
    lastNudgeMailPurpose: string;
    lastColdmailAtMs: number;
    lastColdmailTrackingId: string;
  };
  const accumByEmail = new Map<string, Accum>();
  const accumFor = (email: string): Accum => {
    let acc = accumByEmail.get(email);
    if (!acc) {
      acc = {
        coldmail: [], nudge: [], hasReply: false,
        lastNudgeAtMs: 0, lastNudgeMailPurpose: "",
        lastColdmailAtMs: 0, lastColdmailTrackingId: "",
      };
      accumByEmail.set(email, acc);
    }
    return acc;
  };

  // 콜드메일: emailLower 그대로 평문 비교(hydrateContactStatus와 동일 축, scp_coldmail_history는
  // 마스킹하지 않는다).
  for (const chunk of chunkArray(emails, CANDIDATE_TABLE_IN_QUERY_LIMIT)) {
    if (chunk.length === 0) continue;
    const snapshot = await db.collection(COLDMAIL_HISTORY_COLLECTION).where("emailLower", "in", chunk).get();
    for (const doc of snapshot.docs) {
      if (!doc.exists) continue;
      const data = asRecord(doc.data());
      if (!await ledgerRowMatchesScope(scope, data)) continue;
      const email = asString(data.emailLower).toLowerCase();
      if (!email) continue;
      const sentAtIso = asString(data.sentAtIso);
      if (!sentAtIso) continue;
      const acc = accumFor(email);
      acc.coldmail.push({
        atIso: sentAtIso,
        type: "coldmail",
        result: asString(data.deliveryState, "sent"),
        conversationId: asString(data.conversationId) || null,
      });
      if (data.hasReply === true) acc.hasReply = true;
      const sentAtMs = Date.parse(sentAtIso);
      if (Number.isFinite(sentAtMs) && sentAtMs > acc.lastColdmailAtMs) {
        acc.lastColdmailAtMs = sentAtMs;
        acc.lastColdmailTrackingId = asString(data.trackingId);
      }
    }
  }

  // 독려: mail_outbound_log는 to를 마스킹해 저장하므로 toHash(24자 해시)로만 조인한다
  // (recipientIdentityHash — nudgeReportFacts.ts nudgeSendRowFrom.identityKey와 같은 정본 해시).
  const hashToEmail = new Map<string, string>();
  for (const email of emails) hashToEmail.set(recipientIdentityHash(email), email);
  const hashes = [...hashToEmail.keys()];
  for (const chunk of chunkArray(hashes, CANDIDATE_TABLE_IN_QUERY_LIMIT)) {
    if (chunk.length === 0) continue;
    const snapshot = await db.collection(MAIL_OUTBOUND_LOG_COLLECTION).where("toHash", "in", chunk).get();
    for (const doc of snapshot.docs) {
      if (!doc.exists) continue;
      const data = asRecord(doc.data());
      if (!await ledgerRowMatchesScope(scope, data)) continue;
      const nudgeRow = nudgeSendRowFrom(data);
      if (!nudgeRow) continue; // 독려 목적이 아니거나 실제 발송(sent)이 아님 — 세지 않는다.
      // 재리뷰 P1: cohort2(application_video_reminder, 영상 제출 재촉)는 콜드메일 독려 축이 아니다
      // — 이 테이블의 "독려"는 콜드메일 독려만 가리키므로 카운트/코호트 판정에서 제외한다(별도
      // 필드로 셀 필요 없음, 티켓 범위 밖).
      // Task-100: cohort4(resubmission_nudge, 반려 후 재제출 독려)도 같은 이유로 제외한다.
      const rowCohort = NUDGE_PURPOSE_TO_COHORT[nudgeRow.mailPurpose];
      if (rowCohort === "cohort2" || rowCohort === "cohort4") continue;
      const email = hashToEmail.get(asString(data.toHash));
      if (!email) continue;
      const acc = accumFor(email);
      acc.nudge.push({
        atIso: new Date(nudgeRow.sentAtMs).toISOString(),
        type: "nudge",
        result: nudgeRow.opened ? "발송·열람" : "발송",
        conversationId: asString(data.conversationId) || null,
      });
      if (data.hasReply === true) acc.hasReply = true;
      if (nudgeRow.sentAtMs > acc.lastNudgeAtMs) {
        acc.lastNudgeAtMs = nudgeRow.sentAtMs;
        acc.lastNudgeMailPurpose = nudgeRow.mailPurpose;
      }
    }
  }

  // 재리뷰 MED-HIGH-2: 독려 이력이 없는 후보의 "첫 독려 코호트"는 스윕(runNudgeCohortSweep)과
  // 같은 규칙으로 정한다 — 콜드메일의 열람 여부(mail_outbound_log 문서 id = trackingId,
  // openCount>0 또는 lastOpenedAtIso 존재)로 코호트1/3을 가른다(nudgeCohortSweep.ts
  // openedTrackingIds와 동일 판정 — 그 함수는 adminDb를 직접 써서 여기 주입된 db로 재사용할 수
  // 없어 같은 규칙만 재현한다).
  const trackingIdsNeedingOpenCheck = dedupeStrings(
    [...accumByEmail.values()]
      .filter((acc) => acc.nudge.length === 0 && acc.lastColdmailTrackingId)
      .map((acc) => acc.lastColdmailTrackingId),
  );
  const openedColdmailTrackingIds = new Set<string>();
  for (const chunk of chunkArray(trackingIdsNeedingOpenCheck, CANDIDATE_TABLE_IN_QUERY_LIMIT)) {
    if (chunk.length === 0) continue;
    const refs = chunk.map((id) => db.collection(MAIL_OUTBOUND_LOG_COLLECTION).doc(id));
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const data = asRecord(snap.data());
      if (Math.trunc(Number(data.openCount ?? 0)) > 0 || asString(data.lastOpenedAtIso)) {
        openedColdmailTrackingIds.add(snap.id);
      }
    }
  }

  const cohortConfig = await readCandidateTableCohortConfig(db);
  const cadenceMsByCohort = resolveCohortCadenceMsMap(cohortConfig);

  const cohortKeyForAccum = (acc: Accum): NudgeCohortKey | null => {
    if (acc.lastNudgeMailPurpose) {
      const short = NUDGE_PURPOSE_TO_COHORT[acc.lastNudgeMailPurpose];
      // 재리뷰 P1: cohort2(application_video_reminder)는 콜드메일 독려 축이 아니므로 코호트
      // 판정에서 제외하고 콜드메일 open 기반 "첫 독려" 규칙(아래)으로 폴백한다(위 루프에서 이미
      // acc.nudge/lastNudgeMailPurpose를 채우지 않으므로 실전에서는 도달하지 않지만, 방어적으로
      // 남겨둔다). Task-100: cohort4(resubmission_nudge)도 같은 이유로 제외한다.
      if (short && short !== "cohort2" && short !== "cohort4") return NUDGE_COHORT_SHORT_TO_KEY[short];
    }
    if (acc.lastColdmailTrackingId) {
      return openedColdmailTrackingIds.has(acc.lastColdmailTrackingId) ? NUDGE_COHORT1_KEY : NUDGE_COHORT3_KEY;
    }
    return null;
  };

  for (const [email, bucketRows] of rowsByEmail) {
    const acc = accumByEmail.get(email);
    if (!acc) continue;
    const timeline = [...acc.coldmail, ...acc.nudge].sort((a, b) => b.atIso.localeCompare(a.atIso));
    const lastSentAtIso = timeline[0]?.atIso ?? null;
    const cohortKey = cohortKeyForAccum(acc);
    const cohortCadenceMs = cohortKey ? cadenceMsByCohort.get(cohortKey) : undefined;
    for (const row of bucketRows) {
      const hasOverride = row.stats.cadenceDaysOverride !== null;
      let effectiveCadenceDays = row.stats.effectiveCadenceDays;
      let nextNudgeBasis: CandidateTableNextNudgeBasis = hasOverride ? "override" : "default";
      // 오버라이드가 1순위다 — 없을 때만 코호트 cadence로 승격한다(판정 불가 시 전역 기본 유지).
      if (!hasOverride && typeof cohortCadenceMs === "number" && cohortCadenceMs > 0) {
        effectiveCadenceDays = Math.round(cohortCadenceMs / MS_PER_DAY);
        nextNudgeBasis = "cohort";
      }
      const nextNudgeAtIso = lastSentAtIso
        ? new Date(Date.parse(lastSentAtIso) + effectiveCadenceDays * MS_PER_DAY).toISOString()
        : null;
      row.stats = {
        ...row.stats,
        coldmailCount: acc.coldmail.length,
        nudgeCount: acc.nudge.length,
        lastSentAtIso,
        nextNudgeAtIso,
        hasReply: acc.hasReply,
        effectiveCadenceDays,
        nextNudgeBasis,
        timeline: timeline.slice(0, OUTREACH_TIMELINE_MAX_EVENTS),
      };
    }
  }
}

// ---------- 회신 수락 판정 투영 (Task-46, 후보 회신 → 파트너 전환) ----------
// conversations.inboundIntent(기존 인바운드 분류 파이프라인, functions/mailHumanGate.ts
// resolveInboundIntent가 receiveEmail에서 이미 계산해 둔 값 — 새 LLM 호출 없이 읽기만 한다,
// COST-P0-011)와 candidate_reply_partners(전환 확정 상태, functions/candidatePartnerConversion.ts)
// 를 후보 행에 투영한다. hydrateContactStatus가 채운 발송류 상태 위의 오버레이이므로 반드시 그
// 다음에 호출해야 한다(listCandidates에서 순서 보장).
const REPLY_ACCEPTANCE_RANK: Record<string, number> = {
  replied: 1,
  price_inquiry: 2,
  partner_accept: 3,
};

async function hydrateReplyAcceptance(
  db: CandidateTableDb,
  rows: CandidateTableRow[],
  scope: CandidateTableLedgerScope,
): Promise<void> {
  if (rows.length === 0) return;

  const candidateRefs = dedupeStrings(rows.map((row) => row.candidateRef).filter((ref) => ref.length > 0));
  const bestSignalByCandidateRef = new Map<string, string>();
  for (const chunk of chunkArray(candidateRefs, CANDIDATE_TABLE_IN_QUERY_LIMIT)) {
    if (chunk.length === 0) continue;
    const snapshot = await db.collection(CONVERSATIONS_COLLECTION).where("candidateRef", "in", chunk).get();
    for (const doc of snapshot.docs) {
      if (!doc.exists) continue;
      const data = asRecord(doc.data());
      if (!await ledgerRowMatchesScope(scope, data)) continue;
      const candidateRef = asString(data.candidateRef);
      if (!candidateRef) continue;
      const intentId = asString(asRecord(data.inboundIntent).id);
      // 분류 결과가 명시적 수락/조건 문의가 아니면(=other_human 등 미분류) 회신 자체가 있었는지만
      // 표시한다("분류 결과가 없으면 '회신'만 표시" — 티켓 완료 조건). 회신 본문/요약은 여기 담지
      // 않는다(라벨만, SEC-P0-009).
      const signal = intentId === "partner_accept" || intentId === "price_inquiry"
        ? intentId
        : data.hasCreatorReply === true
          ? "replied"
          : null;
      if (!signal) continue;
      const rank = REPLY_ACCEPTANCE_RANK[signal] ?? 0;
      const previousSignal = bestSignalByCandidateRef.get(candidateRef);
      const previousRank = previousSignal ? (REPLY_ACCEPTANCE_RANK[previousSignal] ?? 0) : -1;
      if (rank > previousRank) bestSignalByCandidateRef.set(candidateRef, signal);
    }
  }

  // candidate_reply_partners: 전환이 active면 무조건 "수락"(터미널) — revoked는 무시하고(재활성화
  // 금지) 위 회신 신호로 되돌린다.
  const refs = rows.map((row) => db.collection(CANDIDATE_REPLY_PARTNERS_COLLECTION).doc(row.id));
  const conversionSnaps = refs.length > 0 ? await db.getAll(...refs) : [];
  const activeChannelIds = new Set<string>();
  for (const snap of conversionSnaps) {
    if (!snap.exists) continue;
    const data = asRecord(snap.data());
    if (!await ledgerRowMatchesScope(scope, data)) continue;
    if (asString(data.status) === "active") activeChannelIds.add(snap.id);
  }

  for (const row of rows) {
    if (activeChannelIds.has(row.id)) {
      row.state = { ...row.state, contactStatus: "수락" };
      continue;
    }
    const signal = bestSignalByCandidateRef.get(row.candidateRef);
    if (signal === "partner_accept") row.state = { ...row.state, contactStatus: "수락 후보" };
    else if (signal === "price_inquiry") row.state = { ...row.state, contactStatus: "협의 중" };
    else if (signal === "replied") row.state = { ...row.state, contactStatus: "회신" };
  }
}

async function hydrateRowsFromPool(
  db: CandidateTableDb,
  channelIds: string[],
  out: Map<string, CandidateTableRow>,
  // 2026-09-11 재리뷰 P1(기존 결함 (a)안): 링크 문서(campaign_candidates)가 아직 전역 풀에 없는
  // 채널을 가리키는 경우(exact-scope 디스커버리가 candidate_pool을 아직 안 쓴 정상 케이스) 추가
  // 왕복 없이 링크 문서 자체의 필드로 읽기 전용 행을 구성한다 — 호출자가 이미 읽은 snap.docs에서
  // channelId → 원본 데이터로 만든 맵을 그대로 넘긴다.
  linkDataByChannelId?: Map<string, Record<string, unknown>>,
  // Flu/Task-60: annotateCandidateDuplicates의 우선순위 규칙②(최신 updatedAt)에 쓸 원본 문서의
  // updatedAtIso를 channelId별로 같이 모아 둔다 — CandidateTableRow 공개 타입에는 올리지 않는다
  // (클라이언트 응답에 원문 타임스탬프를 새로 노출할 이유가 없다, 우선순위 판정에만 내부적으로 쓴다).
  updatedAtIsoOut?: Map<string, string | null>,
): Promise<void> {
  if (channelIds.length === 0) return;
  const refs = channelIds.map((id) => db.collection(CANDIDATE_POOL_COLLECTION).doc(id));
  const snaps = await db.getAll(...refs);
  for (const snap of snaps) {
    if (snap.exists) {
      const data = asRecord(snap.data());
      out.set(snap.id, rowFromPoolDocData(snap.id, data, snapshotCreatedAtIso(snap), linkDataByChannelId?.get(snap.id)));
      updatedAtIsoOut?.set(snap.id, asString(data.updatedAtIso) || null);
      continue;
    }
    const linkData = linkDataByChannelId?.get(snap.id);
    if (linkData) {
      out.set(snap.id, rowFromLinkDocData(snap.id, linkData));
      updatedAtIsoOut?.set(snap.id, asString(linkData.updatedAtIso) || null);
    }
  }
}

// ---------- 캐시 우선 YouTube 메타 보강 ----------

interface EnrichCandidateMetaDeps {
  now?: () => number;
  apiKey?: string;
  // Flu/Task-49 재리뷰 P0②: listCandidates가 미리 해석해 둔 org -> YouTube 쿼터 풀 id. 비어 있으면
  // selectYoutubeApiKey 자신의 기본값(growth)을 쓴다.
  poolId?: string;
  quotaPoolsDb?: MailAccountsFirestoreDb;
  readSlotUnitsUsed?: SelectYoutubeApiKeyInput["readSlotUnitsUsed"];
  fetchChannel?: typeof fetchChannel;
  fetchRecentVideos?: typeof fetchRecentVideos;
}

interface EnrichCandidateMetaStats {
  attempted: number;
  cacheHits: number;
  cacheMisses: number;
  skippedOverBatchCap: number;
  errors: number;
}

// rows를 제자리에서 갱신한다(row.meta). 신규/스테일 조회를 CANDIDATE_ENRICH_BATCH_CAP개로 제한하고,
// 나머지는 TTL 이내면 캐시 히트로, TTL 밖이면(=상한 초과로 이번엔 재조회 못함) 기존 값을 그대로 둔다.
async function enrichCandidateMeta(
  rows: CandidateTableRow[],
  deps: EnrichCandidateMetaDeps = {},
): Promise<{ stats: EnrichCandidateMetaStats }> {
  const now = deps.now ?? (() => Date.now());
  const doFetchChannel = deps.fetchChannel ?? fetchChannel;
  const doFetchRecentVideos = deps.fetchRecentVideos ?? fetchRecentVideos;
  const nowMs = now();
  const stats: EnrichCandidateMetaStats = { attempted: 0, cacheHits: 0, cacheMisses: 0, skippedOverBatchCap: 0, errors: 0 };

  const staleRows = rows.filter((row) => isCandidateMetaStale(row.meta.enrichedAt, nowMs));
  const toFetch = staleRows.slice(0, CANDIDATE_ENRICH_BATCH_CAP);
  stats.skippedOverBatchCap = staleRows.length - toFetch.length;
  const toFetchIds = new Set(toFetch.map((row) => row.id));

  // Flu/Task-49 재리뷰 P0②③④: deps.apiKey 테스트 시임은 그대로 유지한다 — 주어지면(기존
  // candidate-table.test.mjs 스위트) 풀 라우팅을 아예 건너뛰고 그 키를 그대로 쓴다. 주어지지
  // 않으면(운영 경로) selectYoutubeApiKey가 listCandidates가 해석한 poolId(비어 있으면 growth)의
  // 실제 슬롯·키를 고른다 — growth면 종전과 바이트 동일(YOUTUBE_API_KEY, slot 0, poolId 생략).
  let apiKey = deps.apiKey ?? "";
  let quotaContext: { slotIndex?: number; poolId?: string } = {};
  if (!apiKey && toFetch.length > 0) {
    try {
      const selection = await selectYoutubeApiKey({
        poolIdOverride: deps.poolId,
        db: deps.quotaPoolsDb,
        readSlotUnitsUsed: deps.readSlotUnitsUsed,
      });
      apiKey = selection.apiKey;
      quotaContext = { slotIndex: selection.slotIndex, poolId: selection.poolId };
    } catch (error) {
      if (!(error instanceof YoutubeQuotaPoolExhaustedError)) throw error;
      // 재리뷰 P0④: 풀 소진은 기존 missing_api_key 분기와 같은 급으로 처리한다 — 보강만
      // fail-closed(행은 '—' 그대로), listCandidates 자체는 절대 실패하지 않는다. growth 원장은
      // 이 경로에서 절대 대신 쓰지 않는다(교차 차용은 selectYoutubeApiKey 내부에서만 판단).
      console.info(JSON.stringify({
        event: "candidateTable.enrich", cacheStatus: "error", reason: "quota_pool_exhausted", poolId: error.poolId,
      }));
    }
  }

  // Flu/0673 핫픽스 보강: toFetch(최대 CANDIDATE_ENRICH_BATCH_CAP=5건)를 순차가 아니라 병렬로
  // 조회한다 — 각 건은 여전히 자기 자신의 stats/row.meta만 건드려 카운터 이중 계산이나 경합이
  // 없다(Task-49 풀 슬롯 해석·원장 기록은 위에서 이미 배치 전체 공통으로 한 번만 끝났고, 건별
  // 라이브 조회만 아래에서 병렬화된다). 실패한 건은 catch에서 row.meta를 건드리지 않고 즉시
  // 반환하므로(기존 동작 그대로) 클라이언트는 해당 필드를 그대로 '—'로 렌더링한다.
  await Promise.all(toFetch.map(async (row) => {
    stats.attempted += 1;
    if (!apiKey) {
      // 시크릿 미바인딩(예: functions-staging 기본 sanitizedEndpoint가 벗김) 또는 풀 소진 —
      // 보강만 fail-closed, 읽기 자체는 절대 실패하지 않는다. 기존 캐시/빈 값 그대로 반환.
      stats.errors += 1;
      console.info(JSON.stringify({ event: "candidateTable.enrich", channelId: row.id, cacheStatus: "error", reason: "missing_api_key" }));
      return;
    }
    try {
      const [channelRaw, videoItems] = await Promise.all([
        doFetchChannel(row.id, apiKey, quotaContext, CANDIDATE_ENRICH_YOUTUBE_TIMEOUT_MS),
        doFetchRecentVideos(row.id, apiKey, CANDIDATE_RECENT_VIDEO_COUNT, quotaContext, CANDIDATE_ENRICH_YOUTUBE_TIMEOUT_MS),
      ]);
      const snippet = asRecord(channelRaw?.snippet);
      const statistics = asRecord(channelRaw?.statistics);
      const country = asString(snippet.country) || null;
      const subscribers = statistics.hiddenSubscriberCount === true ? null : numberOrNull(statistics.subscriberCount);
      const recentVideos = videoItems
        .map(toVideoSnapshot)
        .filter((v): v is CandidateTableVideoSnapshot => v !== null);
      const viewNumbers = recentVideos.map((v) => v.viewCount).filter((v): v is number => typeof v === "number");
      const avgRecentViews = viewNumbers.length
        ? Math.round(viewNumbers.reduce((a, b) => a + b, 0) / viewNumbers.length)
        : null;
      row.meta = {
        country,
        subscribers,
        recentVideos,
        avgRecentViews,
        enrichedAt: new Date(nowMs).toISOString(),
        enrichSource: "live",
        qualifyingVideoCount: row.meta.qualifyingVideoCount,
        minVideoViewThreshold: row.meta.minVideoViewThreshold,
        topQualifyingVideo: row.meta.topQualifyingVideo,
        qualifyingVideoEvidence: row.meta.qualifyingVideoEvidence,
      };
      stats.cacheMisses += 1;
      console.info(JSON.stringify({ event: "candidateTable.enrich", channelId: row.id, cacheStatus: "miss" }));
    } catch (error) {
      stats.errors += 1;
      console.info(
        JSON.stringify({
          event: "candidateTable.enrich",
          channelId: row.id,
          cacheStatus: "error",
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }));

  for (const row of rows) {
    if (toFetchIds.has(row.id)) continue;
    if (row.meta.enrichedAt && !isCandidateMetaStale(row.meta.enrichedAt, nowMs)) {
      stats.cacheHits += 1;
      row.meta = { ...row.meta, enrichSource: "cache" };
      console.info(JSON.stringify({ event: "candidateTable.enrich", channelId: row.id, cacheStatus: "hit" }));
    }
  }

  return { stats };
}

// ---------- Flu/Task-60: 채널ID 단위 dedupe 위의 사람 단위 2차 dedupe(주석) ----------
//
// listCandidates는 rowsByChannelId(Map<channelId, row>)로 "응답 안에서 같은 channelId가 두 행이 되는"
// 경우는 이미 정확히 막는다(위 hydrateRowsFromPool/all-scope 루프). 이 절이 다루는 건 다른 문제다 —
// *같은 사람*이 *서로 다른 channelId*로 candidate_pool/campaign_candidates에 두 번 등록된 경우
// (채널 이전, 다른 유입 경로로 재발견 등)에는 channelId 기준 Map으로는 절대 걸러지지 않고 화면에
// 시각적으로 동일한 두 행이 남는다. 근본 원인(정말 같은 사람이 채널ID 두 개를 갖는지)은 티켓
// 단계에서 미확정이므로, 행을 실제로 지우는 대신(false positive면 후보가 통째로 사라져 더 위험하다)
// annotateCandidateDuplicates가 duplicateOf만 채운다 — 실제 화면에서 접거나 강조하는 건 이후 UI
// 작업(candidates/page.tsx·CandidateTable.tsx, 이 티켓 범위 밖)의 몫이다. 프로드 재현: 2026-09-11
// influchat-77db6 candidate_pool 읽기 전용 스캔(scripts/task60-prod-duplicate-scan.mjs) 결과는
// 이 커밋 본문에 기록한다.
//
// 사람 단위 식별 키: 이메일을 최우선으로 쓰고(정규화는 mailSafetyShared.normalizeEmailAddress —
// 발송 경로와 동일 정본, 독자 재구현 금지), 이메일이 없으면 handle로 폴백한다. handle은 플랫폼이
// 다르면 같은 handle 문자열이어도 다른 사람일 수 있으므로 platform을 키에 포함한다
// (`handle:${platform}:${handle}`, 대소문자 무시·trim·선행 @ 제거는 handle에만 적용 — platform은
// asString(data.platform, "YouTube") 그대로 이미 정규 표기다). 이메일·handle 둘 다 비어 있으면
// 병합 대상에서 제외한다(식별자가 없는 행끼리 묶으면 서로 무관한 후보가 잘못 병합 표시될 수 있다 —
// false positive 회피가 우선).
function candidatePersonKey(row: CandidateTableRow): string | null {
  const email = normalizeEmailAddress(row.email ?? "");
  if (email) return `email:${email}`;
  const handle = row.handle.trim().toLowerCase().replace(/^@/, "");
  return handle ? `handle:${row.platform}:${handle}` : null;
}

// infly_* 접두 channelId는 임포트(백필/외부 소스) 문서다(scripts/seed-infly-discovered.mjs·
// backfill-infly-target-seeding.mjs가 이 접두로 candidate_pool 문서를 심는다) — 네이티브 YouTube
// 채널ID(UC 접두, activityRefresh.ts가 실제 채널 조회로 채우는 원천)가 아니라 2차 사본이다. 임포트
// 사본은 백필 배치가 돌 때마다 updatedAtIso가 갱신되므로, 우연히 네이티브 문서보다 최신이어도
// 대표가 되어서는 안 된다.
function isInflyImportedChannelId(channelId: string): boolean {
  return channelId.startsWith("infly_");
}

// 같은 사람 그룹 안에서 "승자(canonical)"를 고르는 우선순위 규칙(티켓 정본, 코드 주석으로 명시):
//   1) candidate_pool 문서로 뒷받침된 행(poolBacked=true)이 링크 전용 행(poolBacked=false)을 이긴다
//      — candidate_pool이 신원/이메일/메타/연락 상태의 원천이므로 더 완전한 행이 우선이다.
//   2) 네이티브 channelId(UC*)가 infly_* 임포트 문서를 이긴다 — 같은 사람의 임포트 사본이 우연히
//      updatedAt이 더 최신이어도 네이티브가 대표(위 isInflyImportedChannelId).
//   3) 즐겨찾기(state.favorite=true) 또는 보류 결정(state.decision==="hold")을 보유한 행 — 운영자가
//      이미 손댄 행은 최신 갱신 여부와 무관하게 절대 패자(duplicateOf)로 만들지 않는다(더 오래된
//      즐겨찾기 행이라도 승자).
//   4) 그다음 candidate_pool/campaign_candidates 문서 자신의 updatedAtIso(discovery.ts
//      persistCandidates가 매 재디스커버리마다 갱신)가 더 최신인 행 — 더 최근에 관측된 신원이 우선.
//   5) 완전 동률이면 channelId 사전순으로 결정적으로 고정한다(테스트 안정성 목적 — 실사용에는
//      영향 없다, 어느 쪽이 승자여도 duplicateOf 관계 자체는 동일하다).
function pickCanonicalCandidateRow(
  a: CandidateTableRow,
  b: CandidateTableRow,
  updatedAtIsoByChannelId: Map<string, string | null>,
): CandidateTableRow {
  if (a.poolBacked !== b.poolBacked) return a.poolBacked ? a : b;

  const aImported = isInflyImportedChannelId(a.id);
  const bImported = isInflyImportedChannelId(b.id);
  if (aImported !== bImported) return aImported ? b : a;

  const aFlagged = a.state.favorite || a.state.decision === "hold";
  const bFlagged = b.state.favorite || b.state.decision === "hold";
  if (aFlagged !== bFlagged) return aFlagged ? a : b;

  const aUpdatedMs = Date.parse(updatedAtIsoByChannelId.get(a.id) ?? "");
  const bUpdatedMs = Date.parse(updatedAtIsoByChannelId.get(b.id) ?? "");
  const aHasUpdated = Number.isFinite(aUpdatedMs);
  const bHasUpdated = Number.isFinite(bUpdatedMs);
  if (aHasUpdated !== bHasUpdated) return aHasUpdated ? a : b;
  if (aHasUpdated && bHasUpdated && aUpdatedMs !== bUpdatedMs) return aUpdatedMs > bUpdatedMs ? a : b;

  return a.id <= b.id ? a : b;
}

// rows를 제자리에서 갱신한다(row.duplicateOf) — 행을 추가·제거하지 않는다(count/truncated 등
// 기존 응답 계약은 그대로 유지). 식별 키가 같은 행이 2건 이상인 그룹에서만 승자를 고르고, 승자를
// 뺀 나머지 모두에 duplicateOf = 승자 channelId를 채운다. 그룹이 1건이면(중복 없음) 아무것도
// 건드리지 않는다 — 회귀 0(중복 없는 데이터에서는 모든 행의 duplicateOf가 생성 시 기본값 null 그대로).
function annotateCandidateDuplicates(
  rows: CandidateTableRow[],
  updatedAtIsoByChannelId: Map<string, string | null>,
): void {
  const groupsByPersonKey = new Map<string, CandidateTableRow[]>();
  for (const row of rows) {
    const key = candidatePersonKey(row);
    if (!key) continue;
    const group = groupsByPersonKey.get(key);
    if (group) group.push(row);
    else groupsByPersonKey.set(key, [row]);
  }

  for (const group of groupsByPersonKey.values()) {
    if (group.length < 2) continue;
    let canonical = group[0];
    for (let index = 1; index < group.length; index += 1) {
      canonical = pickCanonicalCandidateRow(canonical, group[index], updatedAtIsoByChannelId);
    }
    for (const row of group) {
      row.duplicateOf = row.id === canonical.id ? null : canonical.id;
    }
  }
}


async function loadCandidateTableDocData(
  db: CandidateTableDb,
  collectionName: string,
  id: string,
  resource: string,
): Promise<Record<string, unknown>> {
  const snap = await db.collection(collectionName).doc(id).get();
  if (!snap.exists) {
    throw Object.assign(new Error(`not-found: ${resource}`), {
      code: "not-found",
      errorCode: "candidate_table_scope_not_found",
    });
  }
  const row: Record<string, unknown> = { id: snap.id, ...asRecord(snap.data()) };
  const deletedAt = asString(row.deletedAt);
  const archivedAt = asString(row.archivedAt);
  const status = asString(row.status).toLowerCase();
  if (deletedAt || archivedAt || status === "deleted" || status === "archived") {
    throw Object.assign(new Error(`failed-precondition: ${resource} is not active`), {
      code: "failed-precondition",
      errorCode: "candidate_table_scope_inactive",
    });
  }
  return row;
}

type CandidateListScopeResources = {
  campaign: Record<string, unknown> | null;
  program: Record<string, unknown> | null;
};

async function loadCandidateListScopeResources(
  db: CandidateTableDb,
  accountScope: AccountOwnershipScope | null,
  input: { programId?: string; campaignId?: string },
): Promise<CandidateListScopeResources> {
  const loadScoped = async (collectionName: string, id: string, resource: string): Promise<Record<string, unknown> | null> => {
    try {
      return await loadCandidateTableDocData(db, collectionName, id, resource);
    } catch (error) {
      const code = asString(asRecord(error).code);
      if (!accountScope && code === "not-found") return null;
      throw error;
    }
  };
  if (input.campaignId) {
    const campaign = await loadScoped("campaigns", input.campaignId, "campaign");
    if (!campaign) return { campaign: null, program: null };
    if (accountScope) await assertAccountOwnershipForRecordAsync(accountScope, campaign, "campaign");
    const canonicalProgramId = asString(campaign.canonicalProgramId) || asString(campaign.programId) || input.programId || "";
    let program: Record<string, unknown> | null = null;
    if (canonicalProgramId) {
      program = await loadScoped("programs", canonicalProgramId, "program");
      if (!program) return { campaign, program: null };
      if (accountScope) await assertAccountOwnershipForRecordAsync(accountScope, program, "program");
    }
    return { campaign, program };
  }
  if (input.programId) {
    const program = await loadScoped("programs", input.programId, "program");
    if (!program) return { campaign: null, program: null };
    if (accountScope) await assertAccountOwnershipForRecordAsync(accountScope, program, "program");
    return { campaign: null, program };
  }
  return { campaign: null, program: null };
}

async function queryOwnedCandidateLinks(
  db: CandidateTableDb,
  accountScope: AccountOwnershipScope,
  pageSize: number,
): Promise<CandidateTableDocSnapshot[]> {
  const docsById = new Map<string, CandidateTableDocSnapshot>();
  if (accountScope.orgId) {
    const orgSnap = await db
      .collection(CAMPAIGN_CANDIDATES_COLLECTION)
      .where("ownerOrgId", "==", accountScope.orgId)
      .orderBy("__name__")
      .limit(pageSize)
      .get();
    for (const doc of orgSnap.docs) docsById.set(doc.id, doc);
  }
  const legacySnap = await db
    .collection(CAMPAIGN_CANDIDATES_COLLECTION)
    .where("ownerUid", "==", accountScope.uid)
    .orderBy("__name__")
    .limit(pageSize)
    .get();
  for (const doc of legacySnap.docs) docsById.set(doc.id, doc);
  const allowedDocs: CandidateTableDocSnapshot[] = [];
  for (const doc of docsById.values()) {
    if (await accountOwnedRowMatchesScopeAsync(accountScope, doc.data())) allowedDocs.push(doc);
  }
  return allowedDocs.sort((a, b) => a.id.localeCompare(b.id)).slice(0, pageSize);
}

function linkIdFromCampaignCandidateRef(value: string): string {
  const ref = value.trim();
  const prefix = `${CAMPAIGN_CANDIDATES_COLLECTION}/`;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : "";
}

type ScopedCandidateMutationTarget = {
  ref: CandidateTableDocRef;
  data: Record<string, unknown>;
  program: Record<string, unknown> | null;
  campaign: Record<string, unknown>;
};


async function hasOwnedScopedParticipationForCandidate(
  db: CandidateTableDb,
  accountScope: AccountOwnershipScope,
  candidateRef: string,
): Promise<boolean> {
  const snap = await db
    .collection(CAMPAIGN_CANDIDATES_COLLECTION)
    .where("candidateRef", "==", candidateRef)
    .limit(20)
    .get();
  for (const doc of snap.docs) {
    if (await accountOwnedRowMatchesScopeAsync(accountScope, { id: doc.id, ...asRecord(doc.data()) })) return true;
  }
  return false;
}

async function resolveScopedCandidateMutationTarget(
  db: CandidateTableDb,
  accountScope: AccountOwnershipScope,
  input: {
    channelId: string;
    candidateRef: string;
    campaignCandidateRef: string;
  },
): Promise<ScopedCandidateMutationTarget> {
  assertWritableAccountOwnershipScope(accountScope, "candidate row state");
  const linkId = linkIdFromCampaignCandidateRef(input.campaignCandidateRef);
  if (!linkId) {
    throw invalidArgument("candidate_table_scoped_link_ref_invalid", "campaignCandidateRef is invalid");
  }
  const ref = db.collection(CAMPAIGN_CANDIDATES_COLLECTION).doc(linkId);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("candidate_table_scoped_link_not_found", `campaign candidate ${linkId} not found`);
  const data: Record<string, unknown> = { id: snap.id, ...asRecord(snap.data()) };
  const actualChannelId = channelIdFromLinkDoc(data);
  const actualCandidateRef = asString(data.candidateRef) || `${CANDIDATE_POOL_COLLECTION}/${actualChannelId}`;
  if (!actualChannelId || actualChannelId !== input.channelId || actualCandidateRef !== input.candidateRef) {
    throw permissionDenied("candidate_table_scoped_link_candidate_mismatch", "campaignCandidateRef does not match candidateRef");
  }
  await assertAccountOwnershipForRecordAsync(accountScope, data, "campaign candidate");

  const campaignId = asString(data.campaignId);
  if (!campaignId) throw failedPrecondition("candidate_table_scoped_link_missing_campaign", "campaign candidate has no campaignId");
  const campaign = await loadCandidateTableDocData(db, CAMPAIGNS_COLLECTION, campaignId, "campaign");
  await assertAccountOwnershipForRecordAsync(accountScope, campaign, "campaign");
  const campaignProgramId = asString(campaign.canonicalProgramId) || asString(campaign.programId);
  const linkProgramId = asString(data.canonicalProgramId) || asString(data.programId);
  if (linkProgramId && campaignProgramId && linkProgramId !== campaignProgramId) {
    throw permissionDenied("candidate_table_scoped_link_program_mismatch", "campaign candidate program does not match parent campaign");
  }

  let program: Record<string, unknown> | null = null;
  const programId = campaignProgramId || linkProgramId;
  if (programId) {
    program = await loadCandidateTableDocData(db, PROGRAMS_COLLECTION, programId, "program");
    await assertAccountOwnershipForRecordAsync(accountScope, program, "program");
  }
  return { ref, data, campaign, program };
}

type CandidateScopeEligibilityDiagnostics = {
  checked: number;
  excluded: number;
  reasons: Record<string, number>;
};

function bumpEligibilityReason(reasons: Record<string, number>, reason: string): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

function candidateRowCountry(row: CandidateTableRow): string | null {
  return row.meta.country
    || asString(row.topQualifyingVideo?.country)
    || asString(row.topQualifyingVideo?.creatorCountry)
    || null;
}

function videoStableId(value: Record<string, unknown>): string {
  const direct = asString(value.videoId) || asString(value.id);
  if (direct) return direct;
  const idRecord = asRecord(value.id);
  return asString(idRecord.videoId);
}

function videoChannelId(value: Record<string, unknown>): string {
  const direct = asString(value.channelId) || asString(value.creatorChannelId);
  if (direct) return direct;
  const snippet = asRecord(value.snippet);
  return asString(snippet.channelId);
}

function candidateRowQualifyingVideos(row: CandidateTableRow): Record<string, unknown>[] {
  const videos: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const push = (value: unknown, defaults: Record<string, unknown> = {}) => {
    const record = asRecord(value);
    if (Object.keys(record).length === 0) return;
    const channelId = videoChannelId(record);
    if (channelId && channelId !== row.id) return;
    const videoId = videoStableId(record);
    if (!videoId) return;
    const key = `video:${videoId}`;
    if (seen.has(key)) return;
    seen.add(key);
    videos.push({ ...defaults, ...record });
  };
  push(row.topQualifyingVideo);
  for (const video of row.meta.qualifyingVideoEvidence) push(video);
  const recentDefaults = {
    source: "candidate_table.recent_videos",
    observedAtIso: row.meta.enrichedAt,
    threshold: row.meta.minVideoViewThreshold ?? 0,
  };
  for (const video of row.meta.recentVideos) push(video, recentDefaults);
  return videos;
}

function hasVerifiableVideoProvenance(value: Record<string, unknown>): boolean {
  const source = asString(value.source);
  const observedAtIso = asString(value.observedAtIso);
  const threshold = numberOrNull(value.threshold);
  return Boolean(source && observedAtIso && threshold !== null);
}

function videoViewCount(value: Record<string, unknown>): number | null {
  const direct = numberOrNull(value.viewCount);
  if (direct !== null) return direct;
  const statistics = asRecord(value.statistics);
  return numberOrNull(statistics.viewCount);
}

function candidateMeetsCurrentVideoCriteria(
  row: CandidateTableRow,
  criteria: ProgramDiscoveryPolicyResolution["criteria"],
): { accepted: boolean; qualifyingVideos?: Record<string, unknown>[]; threshold?: number; reason?: string; diagnosticReasons?: string[] } {
  const minVideoViews = Math.trunc(criteria.minVideoViews);
  const minVideoCount = Math.trunc(criteria.minVideoCount);
  if (minVideoViews <= 0 && minVideoCount <= 0) return { accepted: true };

  const requiredCount = Math.max(1, minVideoCount);
  const candidateVideos = candidateRowQualifyingVideos(row);
  const videosAtCurrentThreshold = candidateVideos
    .filter((video) => {
      const views = videoViewCount(video);
      return views !== null && views >= minVideoViews;
    });
  const qualifyingVideos = videosAtCurrentThreshold.filter(hasVerifiableVideoProvenance);
  if (qualifyingVideos.length >= requiredCount) return { accepted: true, qualifyingVideos, threshold: minVideoViews };
  if (videosAtCurrentThreshold.length >= requiredCount) {
    return {
      accepted: false,
      reason: requiredCount > 1 ? "insufficient_current_qualifying_video_count" : "missing_current_qualifying_video_evidence",
      diagnosticReasons: ["unverified_qualifying_video_provenance"],
    };
  }
  const storedCount = row.qualifyingVideoCount ?? row.meta.qualifyingVideoCount;
  if (storedCount !== null && storedCount >= requiredCount && qualifyingVideos.length === 0) {
    return {
      accepted: false,
      reason: "missing_current_qualifying_video_evidence",
      diagnosticReasons: ["unverified_count_only_qualifying_video_evidence"],
    };
  }
  if (candidateVideos.length > 0) {
    return {
      accepted: false,
      reason: videosAtCurrentThreshold.length > 0 ? "insufficient_current_qualifying_video_count" : "missing_current_qualifying_video_evidence",
      diagnosticReasons: ["stale_or_insufficient_current_qualifying_video_evidence"],
    };
  }
  return {
    accepted: false,
    reason: "missing_current_qualifying_video_evidence",
  };
}

function projectCurrentVideoQualification(
  row: CandidateTableRow,
  qualifyingVideos: Record<string, unknown>[],
  threshold: number,
): void {
  const sorted = [...qualifyingVideos].sort((left, right) => (videoViewCount(right) ?? 0) - (videoViewCount(left) ?? 0));
  const top = sorted[0] ?? null;
  row.qualifyingVideoCount = sorted.length;
  row.minVideoViewThreshold = threshold;
  row.topQualifyingVideo = top;
  row.qualifyingVideoEvidence = sorted;
  row.meta = {
    ...row.meta,
    qualifyingVideoCount: sorted.length,
    minVideoViewThreshold: threshold,
    topQualifyingVideo: top,
    qualifyingVideoEvidence: sorted,
  };
}

function filterRowsByCurrentScopedCriteria(
  rows: CandidateTableRow[],
  resources: CandidateListScopeResources,
  scope: "all" | "program" | "campaign",
): { rows: CandidateTableRow[]; diagnostics: CandidateScopeEligibilityDiagnostics | null } {
  if (scope === "all" || !resources.program) return { rows, diagnostics: null };
  const policy = resolveProgramDiscoveryCriteria(resources.program, resources.campaign ?? {});
  const requiresCurrentVideoProof = policy.criteria.discoveryVertical === "ai_drama"
    || policy.criteria.minVideoViews > 0
    || policy.criteria.minVideoCount > 0;
  if (
    !requiresCurrentVideoProof
    && policy.countryTargeting.countryScope !== "include"
    && policy.countryTargeting.excludedCountries.length === 0
  ) {
    return { rows, diagnostics: null };
  }

  const reasons: Record<string, number> = {};
  const acceptedRows: CandidateTableRow[] = [];
  for (const row of rows) {
    if (policy.criteria.discoveryVertical === "ai_drama") {
      row.canEditNudgeCadence = false;
      row.nudgeCadenceReadOnlyReason = "scoped_ai_drama_disabled";
    }
    const countryDecision = youtubeCreatorCountryPolicyDecision(candidateRowCountry(row), policy.countryTargeting);
    if (!countryDecision.accepted) {
      bumpEligibilityReason(reasons, `country_${countryDecision.decision}`);
      continue;
    }
    if (requiresCurrentVideoProof) {
      const videoDecision = candidateMeetsCurrentVideoCriteria(row, policy.criteria);
      if (!videoDecision.accepted) {
        bumpEligibilityReason(reasons, videoDecision.reason ?? "missing_current_video_evidence");
        for (const reason of videoDecision.diagnosticReasons ?? []) bumpEligibilityReason(reasons, reason);
        continue;
      }
      projectCurrentVideoQualification(row, videoDecision.qualifyingVideos ?? [], videoDecision.threshold ?? policy.criteria.minVideoViews);
    }
    acceptedRows.push(row);
  }
  return {
    rows: acceptedRows,
    diagnostics: {
      checked: rows.length,
      excluded: rows.length - acceptedRows.length,
      reasons,
    },
  };
}

// ---------- listCandidates ----------

export interface ListCandidatesDeps {
  db?: CandidateTableDb;
  now?: () => number;
  apiKey?: string;
  fetchChannel?: typeof fetchChannel;
  fetchRecentVideos?: typeof fetchRecentVideos;
  // Flu/Task-49 재리뷰 P0①: org -> YouTube 쿼터 풀 라우팅에 쓰는 실제 소비 경로 주입점. 프로덕션은
  // 전부 기본값(실제 resolveMailAccountForEmail/실제 Firestore)을 쓴다 — 테스트만 좁은 페이크를 넣는다.
  resolveMailAccountForEmail?: typeof resolveMailAccountForEmail;
  quotaPoolsDb?: MailAccountsFirestoreDb;
  readSlotUnitsUsed?: SelectYoutubeApiKeyInput["readSlotUnitsUsed"];
  resolveAccountOwnershipScope?: typeof resolveAccountOwnershipScopeForRequest;
  /** Test-only seam; production always evaluates the canonical org-tab policy. */
  orgTabAllows?: typeof orgTabAllows;
}

export async function listCandidates(
  request: CallableRequestShape,
  deps: ListCandidatesDeps = {},
): Promise<Record<string, unknown>> {
  const ctx = assertNonGuestAuth(request, "candidateTable.list", READ_ROLES);
  const data = asRecord(request.data);
  const programId = asString(data.programId);
  const campaignId = asString(data.campaignId);
  const pageSize = Math.max(1, Math.min(asNumber(data.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE));
  const db = resolveCandidateTableDb(deps.db);
  const doResolveAccountOwnershipScope = deps.resolveAccountOwnershipScope
    ?? (deps.db ? null : resolveAccountOwnershipScopeForRequest);
  const accountScope: AccountOwnershipScope | null = doResolveAccountOwnershipScope
    ? await doResolveAccountOwnershipScope(request, "candidateTable.list", READ_ROLES, { data })
    : null;
  // Candidate visibility is opt-in by organization. A normal super_admin retains the existing
  // global operational view; a viewAs request resolves to the target's verified organization and
  // must meet exactly the same server policy as that member.
  const doOrgTabAllows = deps.orgTabAllows ?? (deps.resolveAccountOwnershipScope ? async () => true : orgTabAllows);
  if (accountScope && !canBypassAccountOwnership(accountScope)) {
    if (!await doOrgTabAllows(accountScope.orgId, "candidates")) {
      throw Object.assign(new Error("permission-denied: candidates tab is not enabled for this organization"), {
        code: "permission-denied",
        errorCode: "candidate_table_org_tab_forbidden",
      });
    }
  }

  // Flu/Task-49 재리뷰 P0①: 호출자 이메일 -> Peoply org(mailAccounts.ts와 동일 해석 경로) ->
  // YouTube 쿼터 풀. 이메일이 없거나 해석이 실패해도 조회 자체는 절대 막지 않는다 — growth로
  // fail-open하고 사유만 로그(mail 라우팅resolveMailAccountForEmail이 이미 쓰는 것과 같은 원칙).
  // Flu/Task-50 적대 리뷰 P0-3: super_admin "대신 보기" 대상이 있으면(members 컬렉션으로 검증됨)
  // 호출자 자신이 아니라 대상자의 email로 쿼터 풀을 해석한다.
  let poolId: string | undefined;
  const viewAsTarget = accountScope ? null : await resolveViewAsTarget(ctx, data, requestAuthTenantId(request));
  const callerEmail = accountScope?.email ?? asString(viewAsTarget ? viewAsTarget.email : ctx.email).toLowerCase();
  if (callerEmail) {
    try {
      if (accountScope && !deps.resolveMailAccountForEmail) {
        poolId = await resolvePoolIdForOrg(accountScope.orgId, { db: deps.quotaPoolsDb });
      } else {
        const doResolveMailAccountForEmail = deps.resolveMailAccountForEmail ?? resolveMailAccountForEmail;
        const resolution = await doResolveMailAccountForEmail(callerEmail, { db: deps.quotaPoolsDb });
        poolId = await resolvePoolIdForOrg(resolution.orgId, { db: deps.quotaPoolsDb });
      }
    } catch (error) {
      console.info(JSON.stringify({
        event: "candidateTable.pool_resolve", cacheStatus: "error",
        reason: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  let scope: "all" | "program" | "campaign" = "all";
  // 2026-09-11 재리뷰 P1: 스코프 분기의 원 쿼리 결과 수(hydrateRowsFromPool 이후의 rows.length가
  // 아니라)로 "더 있을 수 있다"를 판정한다 — candidate_pool 미기록으로 rows가 줄어도(poolBacked
  // 폴백 전에는 스킵됐다) 원 쿼리가 pageSize를 꽉 채웠으면 여전히 truncated다.
  let truncated = false;
  const rowsByChannelId = new Map<string, CandidateTableRow>();
  // Flu/Task-60: annotateCandidateDuplicates 우선순위 규칙②(최신 updatedAt)용 — 아래 세 분기가
  // 채운다(hydrateRowsFromPool의 updatedAtIsoOut 파라미터, all-scope 분기는 직접 채운다).
  const updatedAtIsoByChannelId = new Map<string, string | null>();

  const scopeResources = await loadCandidateListScopeResources(db, accountScope, { programId, campaignId });

  if (campaignId) {
    scope = "campaign";
    const snap = await db
      .collection(CAMPAIGN_CANDIDATES_COLLECTION)
      .where("campaignId", "==", campaignId)
      .orderBy("__name__")
      .limit(pageSize)
      .get();
    const linkDataByChannelId = new Map<string, Record<string, unknown>>();
    for (const doc of snap.docs) {
      const data = asRecord(doc.data());
      if (accountScope && !await accountOwnedRowMatchesScopeAsync(accountScope, data)) continue;
      const channelId = channelIdFromLinkDoc(data);
      if (channelId) linkDataByChannelId.set(channelId, {
        ...data,
        campaignCandidateRef: `${CAMPAIGN_CANDIDATES_COLLECTION}/${doc.id}`,
      });
    }
    await hydrateRowsFromPool(db, [...linkDataByChannelId.keys()], rowsByChannelId, linkDataByChannelId, updatedAtIsoByChannelId);
    truncated = snap.docs.length === pageSize;
  } else if (programId) {
    scope = "program";
    const snap = await db
      .collection(CAMPAIGN_CANDIDATES_COLLECTION)
      .where("canonicalProgramId", "==", programId)
      .orderBy("__name__")
      .limit(pageSize)
      .get();
    const linkDataByChannelId = new Map<string, Record<string, unknown>>();
    for (const doc of snap.docs) {
      const data = asRecord(doc.data());
      if (accountScope && !await accountOwnedRowMatchesScopeAsync(accountScope, data)) continue;
      const channelId = channelIdFromLinkDoc(data);
      if (channelId) linkDataByChannelId.set(channelId, {
        ...data,
        campaignCandidateRef: `${CAMPAIGN_CANDIDATES_COLLECTION}/${doc.id}`,
      });
    }
    await hydrateRowsFromPool(db, [...linkDataByChannelId.keys()], rowsByChannelId, linkDataByChannelId, updatedAtIsoByChannelId);
    truncated = snap.docs.length === pageSize;
  } else if (accountScope && !accountScope.viewAs && accountScope.role === "super_admin") {
    const snap = await db.collection(CANDIDATE_POOL_COLLECTION).orderBy("__name__").limit(pageSize).get();
    for (const doc of snap.docs) {
      if (!doc.exists) continue;
      const data = asRecord(doc.data());
      rowsByChannelId.set(doc.id, rowFromPoolDocData(doc.id, data, snapshotCreatedAtIso(doc)));
      updatedAtIsoByChannelId.set(doc.id, asString(data.updatedAtIso) || null);
    }
    truncated = snap.docs.length === pageSize;
  } else if (accountScope) {
    const docs = await queryOwnedCandidateLinks(db, accountScope, pageSize);
    const linkDataByChannelId = new Map<string, Record<string, unknown>>();
    for (const doc of docs) {
      const data = asRecord(doc.data());
      const channelId = channelIdFromLinkDoc(data);
      if (channelId) linkDataByChannelId.set(channelId, {
        ...data,
        campaignCandidateRef: `${CAMPAIGN_CANDIDATES_COLLECTION}/${doc.id}`,
      });
    }
    await hydrateRowsFromPool(db, [...linkDataByChannelId.keys()], rowsByChannelId, linkDataByChannelId, updatedAtIsoByChannelId);
    truncated = docs.length === pageSize;
  } else {
    const snap = await db.collection(CANDIDATE_POOL_COLLECTION).orderBy("__name__").limit(pageSize).get();
    for (const doc of snap.docs) {
      if (!doc.exists) continue;
      const data = asRecord(doc.data());
      rowsByChannelId.set(doc.id, rowFromPoolDocData(doc.id, data, snapshotCreatedAtIso(doc)));
      updatedAtIsoByChannelId.set(doc.id, asString(data.updatedAtIso) || null);
    }
    truncated = snap.docs.length === pageSize;
  }

  const eligibility = filterRowsByCurrentScopedCriteria([...rowsByChannelId.values()], scopeResources, scope);
  const rows = eligibility.rows;
  const ledgerScope: CandidateTableLedgerScope = {
    accountScope,
    campaignId: campaignId || "",
    programId: asString(scopeResources.program?.id)
      || asString(scopeResources.campaign?.canonicalProgramId)
      || asString(scopeResources.campaign?.programId)
      || programId
      || "",
  };
  // Flu/Task-60: 채널ID 단위 dedupe(위의 rowsByChannelId Map) 다음, 하지만 이후 hydrate*(발송/독려/
  // 회신 상태)보다 먼저 — duplicateOf 판정은 row.email/handle/poolBacked/state.favorite·decision처럼
  // 이미 이 시점에 다 채워진 필드만 쓰고, hydrate* 단계와 서로 의존하지 않는다(순서 무관하지만 dedupe
  // 식별을 다른 dedupe 로직 바로 옆에 둔다).
  annotateCandidateDuplicates(rows, updatedAtIsoByChannelId);
  // Task-46: hydrateReplyAcceptance는 hydrateContactStatus가 채운 발송류 상태 위의 오버레이라
  // 반드시 그 다음에 실행해야 한다(둘 다 row.state를 스프레드로 덮어쓰므로 병렬 실행 시 순서에
  // 따라 서로를 지울 수 있다) — enrichCandidateMeta는 row.meta만 건드리므로 그대로 병렬 유지.
  const [{ stats }] = await Promise.all([
    enrichCandidateMeta(rows, {
      now: deps.now,
      apiKey: deps.apiKey,
      poolId,
      quotaPoolsDb: deps.quotaPoolsDb,
      readSlotUnitsUsed: deps.readSlotUnitsUsed,
      fetchChannel: deps.fetchChannel,
      fetchRecentVideos: deps.fetchRecentVideos,
    }),
    // Task-46: hydrateReplyAcceptance는 hydrateContactStatus 다음에 순차 실행해야 한다(둘 다
    // row.state를 스프레드로 덮어쓰므로 병렬이면 순서에 따라 서로를 지울 수 있다).
    // hydrateOutreachStats(Task-44)는 row.stats만 건드리므로 독립적으로 병렬 유지.
    hydrateContactStatus(db, rows, ledgerScope).then(() => hydrateReplyAcceptance(db, rows, ledgerScope)),
    hydrateOutreachStats(db, rows, ledgerScope),
    // AI-DRAMA-DISCOVERY-METAPROMPT W5: only touches row.commentSentiment — independent of the
    // other hydrators' row.state/row.meta/row.stats, safe in the same parallel batch. Pure read of
    // an already-computed async result (never live analysis — the 4s/5-row enrichment budget stays
    // untouched).
    hydrateCommentSentiment(db, rows),
  ]);

  const dirtyRows = rows.filter((row) => row.meta.enrichSource === "live");
  if (dirtyRows.length > 0 && !accountScope?.viewAs && !viewAsTarget) {
    const batch = db.batch();
    for (const row of dirtyRows) {
      batch.set(db.collection(CANDIDATE_POOL_COLLECTION).doc(row.id), { candidateMeta: row.meta }, { merge: true });
    }
    await batch.commit();
  }

  return {
    ok: true,
    scope,
    programId: programId || null,
    campaignId: campaignId || null,
    candidates: rows,
    count: rows.length,
    pageSize,
    truncated,
    enrichment: stats,
    ...(eligibility.diagnostics
      ? {
          eligibility: {
            ...eligibility.diagnostics,
            warning: eligibility.diagnostics.excluded > 0
              ? "Some scoped candidates were omitted because current campaign criteria could not be re-proven from stored evidence."
              : "",
          },
        }
      : {}),
    behaviorLog: makeBehaviorLog(ctx, "candidateTable.list", "success"),
  };
}

// ---------- sendCandidateColdMail ----------

// approveCampaignOutreach(admin.ts)를 재사용할 때 꼭 필요한 요청/응답 모양만 좁힌 타입 — 페이크
// 테스트 더블이 CampaignApprovalSummary 전체 필드를 채우지 않아도 되게 한다. 실제 함수는 이보다
// 넓은 요청을 받고 넓은 응답을 주므로 구조적으로 호환된다.
type ApproveCampaignOutreachRequest = {
  auth?: CallableRequestShape["auth"];
  data: Record<string, unknown>;
  rawRequest?: { ip?: string };
};
type ApproveCampaignOutreachResult = { approvedCount?: number } & Record<string, unknown>;
type ApproveCampaignOutreachFn = (request: ApproveCampaignOutreachRequest) => Promise<ApproveCampaignOutreachResult>;

async function defaultCheckPriorOutreach(data: Record<string, unknown>): Promise<boolean> {
  // 헤세 결정 2026-09-16: 이 콜드메일 1건당 한 번만 settings를 해소한다(후보 루프가 아니다).
  const scope = resolveOutreachDedupScope(await readSettings());
  const context = await resolveOutreachDedupContext(data, scope);
  if (!context.creatorKey) return false;
  return creatorSentInProgramScope(context, data);
}

// 재리뷰 P0(HIGH): 문서를 쓰기 전에 admin.ts approveCampaignOutreach가 쓰는 것과 동일한 캠페인
// 소유권·정체성 게이트(campaignControlCore.ts)를 통과해야 한다 — 위조/타팀 campaignId나
// 종료·일시정지 캠페인이면 아무 문서도 쓰지 않고 permission-denied/failed-precondition으로 거부.
type CampaignAccessCheckInput = {
  actor: MutationAuthorizationActor;
  requestedProgramId: string;
  requestedCampaignId: string;
  program: Record<string, unknown>;
  campaign: Record<string, unknown>;
};

async function defaultAssertCampaignAccess(input: CampaignAccessCheckInput): Promise<void> {
  const aliasRegistry = await readConfirmedProgramAliasRegistryState();
  // admin.ts approveCampaignOutreach/updateCampaignControl이 readAuthorizedCampaignControlInTransaction
  // 안에서 부르는 것과 같은 두 단언 — 위조된/다른 프로그램·캠페인 정체성과 소유권을 그대로 재검증한다.
  assertCampaignControlIdentity({
    requestedProgramId: input.requestedProgramId,
    requestedCampaignId: input.requestedCampaignId,
    program: input.program,
    campaign: input.campaign,
    aliasMap: aliasRegistry.aliasMap,
  });
  assertCampaignControlActor(input.actor, input.program, input.campaign);
  // approveCampaignOutreach가 트랜잭션 진입 직후 던지는 것과 같은 기준(operationalState !== "active").
  const safeFields = campaignControlSafeFields(input.campaign, input.program);
  if (safeFields.operationalState !== "active") {
    throw Object.assign(new Error("failed-precondition: campaign is paused or completed"), {
      code: "failed-precondition",
      errorCode: "candidate_table_send_campaign_not_active",
    });
  }
}

export interface SendCandidateColdMailDeps {
  db?: CandidateTableDb;
  now?: () => number;
  evaluateMailSafety?: typeof evaluateMailSafety;
  // prepareCampaignOutreachDraft(admin.ts)가 내부적으로 같은 mail-safety 판정을 다시 돌린다 —
  // 주입하지 않으면 실제 evaluateMailSafety/evaluateMailProfileSafety를 그대로 쓴다.
  evaluateMailProfileSafety?: typeof evaluateMailProfileSafety;
  resolveMailProfile?: typeof resolveMailProfile;
  // programOutreachDedup.ts의 dedup 판정(creatorSentInProgramScope — settings.automation.
  // outreachDedupScope에 따라 전역/프로그램 스코프) 합성. 실제 함수는 adminDb를 직접 써서
  // 테스트 페이크 db로 가로챌 수 없으므로 통째로 주입한다.
  checkPriorOutreach?: (data: Record<string, unknown>) => Promise<boolean>;
  // admin.ts approveCampaignOutreach 재사용 지점 — 승인 로직은 복제하지 않고 실제 콜러블을 호출한다.
  approveCampaignOutreach?: ApproveCampaignOutreachFn;
  // 문서를 쓰기 전에 실행하는 캠페인 소유권·정체성·운영상태 게이트. 실제 함수는 alias 레지스트리를
  // adminDb에서 직접 읽어 테스트 페이크 db로 가로챌 수 없으므로 통째로 주입한다.
  assertCampaignAccess?: (input: CampaignAccessCheckInput) => Promise<void>;
  resolveAccountOwnershipScope?: typeof resolveAccountOwnershipScopeForRequest;
  orgTabAllows?: typeof orgTabAllows;
}

async function assertCandidateTabAccess(
  scope: AccountOwnershipScope,
  allows: typeof orgTabAllows,
): Promise<void> {
  if (canBypassAccountOwnership(scope)) return;
  if (await allows(scope.orgId, "candidates")) return;
  throw Object.assign(new Error("permission-denied: candidates tab is not enabled for this organization"), {
    code: "permission-denied",
    errorCode: "candidate_table_org_tab_forbidden",
  });
}

async function blockSend(
  db: CandidateTableDb,
  ref: CandidateTableDocRef,
  ctx: ReturnType<typeof assertNonGuestAuth>,
  candidateRef: string,
  nowIso: string,
  reason: string,
  ruleId: string,
): Promise<Record<string, unknown>> {
  await ref.set(
    { candidateTableState: { lastSendBlockedReason: reason, lastSendBlockedRuleId: ruleId, lastActionAt: nowIso, lastActionBy: ctx.userId } },
    { merge: true },
  );
  return {
    ok: true,
    sent: false,
    blocked: true,
    reason,
    ruleId,
    candidateRef,
    behaviorLog: makeBehaviorLog(ctx, "candidateTable.sendColdMail", "blocked"),
  };
}

export async function sendCandidateColdMail(
  request: CallableRequestShape,
  deps: SendCandidateColdMailDeps = {},
): Promise<Record<string, unknown>> {
  const ctx = assertNonGuestAuth(request, "candidateTable.sendColdMail", SEND_ROLES);
  const data = asRecord(request.data);
  const doResolveAccountOwnershipScope = deps.resolveAccountOwnershipScope ?? resolveAccountOwnershipScopeForRequest;
  const accountScope = await doResolveAccountOwnershipScope(request, "candidateTable.sendColdMail", SEND_ROLES, { data });
  // 2026-09-27 codex adversarial review round 3 FAIL-8: accountScope.mailAccountId is this
  // caller's own resolved send-as mailbox (accountOwnership.ts: policy.defaultSenderId ??
  // policy.defaultAccount?.accountId — the SAME resolveMailSenderPolicyForEmail policy
  // isCallerScpEntitled itself checks) — the authoritative "which mailbox will this caller's
  // outreach actually send from" signal for an authenticated end-user action like this one.
  // (mailAccountSelection.ts's selectOutboundMailAccount/resolveMailAccountForEmail are the wrong
  // layer here — that module's own doc comment says explicitly it is for server-owned/operational
  // mail flows, "never surfaced as a user send-as grant".) Require scp entitlement (super_admin
  // bypass, via assertScpEntitled) only when that resolved mailbox is scp — never gate a
  // genuinely non-scp resolved mailbox.
  if (accountScope.mailAccountId === "scp") {
    await assertScpEntitled(ctx, request, "candidateTable.sendColdMail");
  }
  assertWritableAccountOwnershipScope(accountScope, "candidate cold mail");
  await assertCandidateTabAccess(accountScope, deps.orgTabAllows ?? (deps.resolveAccountOwnershipScope ? async () => true : orgTabAllows));
  const channelId = channelIdFromCandidateRef(asString(data.candidateRef)) || asString(data.channelId);
  if (!channelId) {
    throw invalidArgument("candidate_table_send_missing_candidate", "candidateRef is required");
  }
  // P0①: campaignId는 후보 탭의 프로그램/캠페인 선택기 값 — 실제 콜드메일 큐(campaign_outreach)는
  // 캠페인에 귀속되므로 캠페인 없이는 큐에 태울 수 없다(클라이언트는 미선택 시 버튼을 비활성화한다).
  const campaignId = asString(data.campaignId);
  if (!campaignId) {
    throw invalidArgument("candidate_table_send_missing_campaign", "campaignId is required — select a program/campaign first");
  }
  const db = resolveCandidateTableDb(deps.db);
  const now = deps.now ?? (() => Date.now());
  const nowIso = new Date(now()).toISOString();
  const doEvaluateMailSafety = deps.evaluateMailSafety ?? evaluateMailSafety;
  const doResolveMailProfile = deps.resolveMailProfile ?? resolveMailProfile;
  const doCheckPriorOutreach = deps.checkPriorOutreach ?? defaultCheckPriorOutreach;
  const doApproveCampaignOutreach: ApproveCampaignOutreachFn = deps.approveCampaignOutreach ?? approveCampaignOutreach;
  const doAssertCampaignAccess = deps.assertCampaignAccess ?? defaultAssertCampaignAccess;

  const ref = db.collection(CANDIDATE_POOL_COLLECTION).doc(channelId);
  const campaignRef = db.collection(CAMPAIGNS_COLLECTION).doc(campaignId);
  const [snap, campaignSnap] = await Promise.all([ref.get(), campaignRef.get()]);
  if (!snap.exists) {
    throw notFound("candidate_table_send_not_found", `candidate ${channelId} not found`);
  }
  if (!campaignSnap.exists) {
    throw notFound("candidate_table_send_campaign_not_found", `campaign ${campaignId} not found`);
  }
  const docData = asRecord(snap.data());
  // admin.ts resolveAuthoritativeCampaignProgramPolicy와 동일하게 문서 id를 명시적으로 채운다 —
  // assertCampaignControlIdentity가 campaign.id === requestedCampaignId를 직접 비교한다.
  const campaignData: Record<string, unknown> = { id: campaignSnap.id, ...asRecord(campaignSnap.data()) };
  const candidateRef = `${CANDIDATE_POOL_COLLECTION}/${channelId}`;
  const canonicalProgramId = asString(campaignData.canonicalProgramId) || asString(campaignData.programId);

  const programSnap = canonicalProgramId ? await db.collection(PROGRAMS_COLLECTION).doc(canonicalProgramId).get() : null;
  const programData: Record<string, unknown> = programSnap && programSnap.exists
    ? { id: programSnap.id, ...asRecord(programSnap.data()) }
    : {};

  // 재리뷰 P0(HIGH): 문서를 쓰기 전에(즉 이메일/킬스위치/dedup 체크보다도 먼저) 캠페인 소유권·정체성·
  // 운영상태를 확정한다 — 위조된/타팀 campaignId나 종료·일시정지 캠페인은 여기서 문서 0건으로 거부한다.
  await doAssertCampaignAccess({
    actor: { uid: ctx.userId, role: ctx.role },
    requestedProgramId: canonicalProgramId,
    requestedCampaignId: campaignId,
    program: programData,
    campaign: campaignData,
  });

  const email = asString(docData.email);
  if (!email) {
    return blockSend(db, ref, ctx, candidateRef, nowIso, "이메일 정보가 없어 발송할 수 없습니다.", "candidate-table.missing-email");
  }

  // sendEmail(functions/chat-ai.ts)/createCampaign(functions/admin.ts)과 동일한 킬스위치(긴급
  // 셧다운·레인별 수동 정지)/suppression 판정 — 진짜 공유 프로덕션 경로를 그대로 호출한다.
  const decision = await doEvaluateMailSafety(
    {
      creatorEmail: email,
      to: email,
      creatorHandle: asString(docData.handle),
      creatorName: asString(docData.name),
      creatorCategory: asString(docData.category),
      creatorPlatform: asString(docData.platform, "YouTube"),
      allowInflyOverlap: campaignData.allowInflyOverlap === true,
    },
    "candidateTable.sendColdMail",
    "manual_send",
  );
  if (!decision.allowed) {
    return blockSend(db, ref, ctx, candidateRef, nowIso, decision.reason, decision.ruleId);
  }

  // R5-B 철칙: 전역 dedup — 어느 프로그램에서든 이미 콜드 접촉한 크리에이터면 큐 문서를 아예
  // 만들지 않는다(approveCampaignOutreach가 승인 시점에 다시 재검증하지만, 그 전에도 fail-closed).
  const dedupProbeData: Record<string, unknown> = {
    creatorEmail: email,
    to: email,
    campaignId,
    programId: canonicalProgramId,
    candidateId: channelId,
    creatorId: asString(docData.creatorId),
  };
  const alreadyContacted = await doCheckPriorOutreach(dedupProbeData);
  if (alreadyContacted) {
    return blockSend(
      db,
      ref,
      ctx,
      candidateRef,
      nowIso,
      "이미 이 크리에이터에게 콜드메일을 보낸 이력이 있어 중복 발송을 차단했습니다.",
      "candidate-table.duplicate-prior-outreach",
    );
  }

  // 캠페인이 이미 들고 있는 콜드메일 오버라이드/프로그램 폴백 템플릿을 그대로 읽는다(로컬라이즈가
  // 없는 캠페인 전용 오버라이드는 pickColdMailTemplate에 넣어도 원문 그대로 나온다 — admin.ts
  // sanitizeCampaignColdMail이 만드는 값엔 localized가 없기 때문). programData는 위 소유권 게이트에서
  // 이미 읽었다 — 두 번째 Firestore 왕복 없이 재사용한다.
  const programColdMailRaw = programData.coldMail;
  const campaignColdMailRaw = asRecord(campaignData.coldMail);
  const effectiveColdMail = Object.keys(campaignColdMailRaw).length > 0
    ? campaignColdMailRaw
    : (programColdMailRaw && typeof programColdMailRaw === "object" ? programColdMailRaw as Record<string, unknown> : null);

  const profileResolution = await doResolveMailProfile({
    campaignId,
    programId: canonicalProgramId,
    gameId: asString(campaignData.gameId),
    intent: "campaign_outreach",
    baseIso: nowIso,
  });

  const target: CampaignTarget = {
    id: channelId,
    name: asString(docData.name, "(이름 없음)"),
    source: "managed",
    email,
    handle: asString(docData.handle) || undefined,
    platform: asString(docData.platform, "YouTube"),
    category: asString(docData.category) || undefined,
    region: asString(docData.region) || undefined,
    candidateRef,
  };
  const draftCtx: CampaignOutreachDraftContext = {
    campaignId,
    campaignName: asString(campaignData.name, "캠페인"),
    owner: asString(campaignData.owner, "—"),
    gameId: asString(campaignData.gameId, "flu-campaign"),
    senderName: asString(campaignData.senderName) || asString(campaignData.owner, "—"),
    campaignColdMail: null,
    programColdMail: effectiveColdMail,
    profileResolution,
    allowInflyOverlap: campaignData.allowInflyOverlap === true,
    evaluateMailProfileSafety: deps.evaluateMailProfileSafety,
    evaluateMailSafety: deps.evaluateMailSafety,
  };
  const draft = await prepareCampaignOutreachDraft(draftCtx, target);

  if (!draft.safety.allowed && draft.safety.ruleId !== "mail-safety.human-approval-required") {
    return blockSend(db, ref, ctx, candidateRef, nowIso, draft.safety.reason, draft.safety.ruleId);
  }

  // 킬스위치/dedup 통과 — 실제 콜드메일 큐 문서 계약(admin.ts createCampaign과 동일 필드)으로
  // queued_for_review 적재. 실제 SMTP 발송은 chat-ai.ts 스윕 워커가 approved 행만 집어간다.
  const outreachId = draft.outreachId;
  const conversationId = `campaign-${campaignId}-${draft.targetId}`;
  const conversationRef = db.collection("conversations").doc(conversationId);
  const outreachRef = db.collection(CAMPAIGN_OUTREACH_COLLECTION).doc(outreachId);
  const messageSourceRef = db.collection("message_sources").doc(outreachId);
  const messageId = `msg-${outreachId}`;
  const sourceRefs = [makeSourceRef(draft.messageRef, "message_source", draft.summaryKr), ...profileResolution.sourceRefs];
  const compiledArtifactFields = campaignOutreachCompiledArtifactFields({
    artifact: draft.artifact,
    subject: draft.subject,
    templateValues: draft.templateValues,
    compilerInputBody: draft.compilerInputBody,
  });

  const outreach = {
    id: outreachId,
    campaignId,
    programId: canonicalProgramId || null,
    targetId: channelId,
    candidateId: channelId,
    candidateRef,
    creatorName: target.name,
    creatorEmail: email,
    creatorHandle: target.handle ?? null,
    creatorCategory: target.category ?? null,
    creatorPlatform: target.platform ?? "YouTube",
    creatorRegion: target.region ?? null,
    country: target.region ?? "",
    source: "candidate_table",
    channel: "email",
    status: "queued_for_review",
    summaryKr: draft.summaryKr,
    trackingId: draft.trackingId,
    messageRef: draft.messageRef,
    subject: draft.subject,
    to: draft.to,
    body: draft.body,
    ...compiledArtifactFields,
    conversationId,
    deliveryState: "queued_for_review",
    humanGate: "needs_review",
    mailSafety: draft.safety,
    resolvedProfileSnapshot: profileResolution.resolvedProfileSnapshot,
    templateSnapshot: profileResolution.templateSnapshot,
    policyVersion: profileResolution.policyVersion,
    sendAfterIso: profileResolution.sendAfterIso,
    dryRun: profileResolution.dryRun,
    liveSend: profileResolution.liveSend,
    allowInflyOverlap: draftCtx.allowInflyOverlap,
    sourceRefs,
    createdAtIso: nowIso,
    createdBy: ctx.userId,
    createdByRole: ctx.role,
  };
  const message = {
    id: messageId,
    from: "ai",
    author: "Flu AI",
    time: nowIso,
    summaryKr: draft.summaryKr,
    trackingId: draft.trackingId,
    messageRef: draft.messageRef,
    campaignId,
    createdAtIso: nowIso,
    humanGate: "needs_review",
    deliveryState: "queued_for_review",
    sourceRefs,
    resolvedProfileSnapshot: profileResolution.resolvedProfileSnapshot,
    templateSnapshot: profileResolution.templateSnapshot,
    policyVersion: profileResolution.policyVersion,
    sendAfterIso: profileResolution.sendAfterIso,
    dryRun: profileResolution.dryRun,
    liveSend: profileResolution.liveSend,
    allowInflyOverlap: draftCtx.allowInflyOverlap,
    subject: draft.subject,
    body: draft.body,
    ...compiledArtifactFields,
  };
  const messageSource = {
    id: outreachId,
    messageRef: draft.messageRef,
    campaignId,
    programId: canonicalProgramId || null,
    targetId: channelId,
    candidateRef,
    conversationId,
    direction: "outbound",
    to: draft.to,
    creatorName: target.name,
    creatorEmail: email,
    creatorHandle: target.handle ?? null,
    creatorCategory: target.category ?? null,
    creatorPlatform: target.platform ?? "YouTube",
    creatorRegion: target.region ?? null,
    country: target.region ?? "",
    subject: draft.subject,
    body: draft.body,
    summaryKr: draft.summaryKr,
    trackingId: draft.trackingId,
    deliveryState: "queued_for_review",
    humanGate: "needs_review",
    mailSafety: draft.safety,
    resolvedProfileSnapshot: profileResolution.resolvedProfileSnapshot,
    templateSnapshot: profileResolution.templateSnapshot,
    policyVersion: profileResolution.policyVersion,
    sendAfterIso: profileResolution.sendAfterIso,
    dryRun: profileResolution.dryRun,
    liveSend: profileResolution.liveSend,
    allowInflyOverlap: draftCtx.allowInflyOverlap,
    createdAtIso: nowIso,
    sourceRefs,
    ...compiledArtifactFields,
  };

  await Promise.all([
    messageSourceRef.set(messageSource, { merge: true }),
    outreachRef.set(outreach),
    conversationRef.set(
      {
        id: conversationId,
        creatorId: `candidate:${channelId}`,
        creatorName: target.name,
        creatorEmail: email,
        creatorHandle: target.handle ?? null,
        creatorPlatform: target.platform ?? "YouTube",
        campaignId,
        programId: canonicalProgramId || null,
        source: "candidate_table",
        lastMessage: draft.summaryKr,
        lastMessageAtIso: nowIso,
        lastMessageFrom: "ai",
        lastDeliveryState: "queued_for_review",
        lastMessageRef: draft.messageRef,
        sourceRefs,
        aiActive: true,
        unread: 0,
        updatedAtIso: nowIso,
      },
      { merge: true },
    ),
    conversationRef.collection("messages").doc(messageId).set(message, { merge: true }),
  ]);

  // 사람이 "보내기"를 눌렀다 — SEND_ROLES(=WRITE_ROLES=manager 이상)는 approveCampaignOutreach의
  // 승인 권한 등급과 동일해 여기 도달한 호출자는 이미 승인 자격이 있다. 승인 로직은 복제하지 않고
  // 실제 콜러블을 그대로 호출한다(재검증·감사 로그·controlVersion 갱신까지 프로덕션과 동일 경로).
  // 캠페인 소유자가 아닌 manager가 다른 사람 캠페인에 보내면 approveCampaignOutreach 자체의 소유권
  // 게이트(mutationAuthorization.ts)가 permission-denied를 던진다 — 그대로 durable queued_for_review
  // 결과로 흡수한다(문서 자체는 살아있으니 소유자가 나중에 검수 화면에서 승인할 수 있다).
  let approved = false;
  let approvalNote = "";
  try {
    const approvalResult = await doApproveCampaignOutreach({
      auth: request.auth,
      data: {
        campaignId,
        programId: canonicalProgramId,
        outreachIds: [outreachId],
        confirmCount: 1,
        expectedVersion: numberOrNull(campaignData.controlVersion) ?? 0,
      },
      rawRequest: request.rawRequest,
    });
    approved = approvalResult.approvedCount === 1;
    if (!approved) approvalNote = "검수 대기로 큐에 적재되었고, 자동 승인은 다른 사유(중복/유효하지 않은 수신자 등)로 보류되었습니다.";
  } catch (error) {
    approvalNote = error instanceof Error ? error.message : String(error);
  }

  await ref.set(
    { candidateTableState: { lastActionAt: nowIso, lastActionBy: ctx.userId, lastSendBlockedReason: null, lastSendBlockedRuleId: null } },
    { merge: true },
  );

  return {
    ok: true,
    // 실제 SMTP 발송은 chat-ai.ts 스윕 워커의 몫이다 — 이 응답은 큐 적재(+가능하면 승인) 결과다.
    sent: false,
    queued: true,
    approved,
    ...(approvalNote ? { approvalNote } : {}),
    blocked: false,
    outreachId,
    candidateRef,
    behaviorLog: makeBehaviorLog(ctx, "candidateTable.sendColdMail", "success"),
  };
}

// ---------- updateCandidateRowState (즐겨찾기 토글 / 보류 결정) ----------

export interface UpdateCandidateRowStateDeps {
  db?: CandidateTableDb;
  now?: () => number;
  resolveAccountOwnershipScope?: typeof resolveAccountOwnershipScopeForRequest;
  orgTabAllows?: typeof orgTabAllows;
}

export async function updateCandidateRowState(
  request: CallableRequestShape,
  deps: UpdateCandidateRowStateDeps = {},
): Promise<Record<string, unknown>> {
  // P1-1: 행 상태 쓰기(즐겨찾기/보류)도 WRITE_ROLES(manager 이상)로 좁힌다 — viewer는 읽기 전용.
  const ctx = assertNonGuestAuth(request, "candidateTable.updateRowState", WRITE_ROLES);
  const data = asRecord(request.data);
  const channelId = channelIdFromCandidateRef(asString(data.candidateRef)) || asString(data.channelId);
  if (!channelId) {
    throw invalidArgument("candidate_table_row_state_missing_candidate", "candidateRef is required");
  }
  const candidateRef = `${CANDIDATE_POOL_COLLECTION}/${channelId}`;
  const db = resolveCandidateTableDb(deps.db);
  const now = deps.now ?? (() => Date.now());
  const nowIso = new Date(now()).toISOString();
  const doResolveAccountOwnershipScope = deps.resolveAccountOwnershipScope ?? resolveAccountOwnershipScopeForRequest;
  const accountScope = await doResolveAccountOwnershipScope(request, "candidateTable.updateRowState", WRITE_ROLES, { data });
  assertWritableAccountOwnershipScope(accountScope, "candidate row state");
  await assertCandidateTabAccess(accountScope, deps.orgTabAllows ?? (deps.resolveAccountOwnershipScope ? async () => true : orgTabAllows));

  const patch: Record<string, unknown> = { lastActionAt: nowIso, lastActionBy: ctx.userId };
  if (typeof data.favorite === "boolean") patch.favorite = data.favorite;
  if (data.decision === "hold") patch.decision = "hold";
  else if (data.decision === "clear") patch.decision = null;

  let writeRef: CandidateTableDocRef;
  const campaignCandidateRef = asString(data.campaignCandidateRef);
  if (campaignCandidateRef) {
    const scoped = await resolveScopedCandidateMutationTarget(db, accountScope, {
      channelId,
      candidateRef,
      campaignCandidateRef,
    });
    writeRef = scoped.ref;
  } else {
    const ref = db.collection(CANDIDATE_POOL_COLLECTION).doc(channelId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw notFound("candidate_table_row_state_not_found", `candidate ${channelId} not found`);
    }
    await assertAccountOwnershipForRecordAsync(accountScope, { id: snap.id, ...asRecord(snap.data()) }, "candidate");
    if (accountScope.role !== "super_admin" && await hasOwnedScopedParticipationForCandidate(db, accountScope, candidateRef)) {
      throw invalidArgument(
        "candidate_table_row_state_scoped_ref_required",
        "campaignCandidateRef is required for scoped candidate row state updates",
      );
    }
    writeRef = ref;
  }
  await writeRef.set({ candidateTableState: patch }, { merge: true });

  return {
    ok: true,
    candidateRef,
    ...(campaignCandidateRef ? { campaignCandidateRef } : {}),
    favorite: typeof data.favorite === "boolean" ? data.favorite : undefined,
    decision: "decision" in patch ? patch.decision : undefined,
    behaviorLog: makeBehaviorLog(ctx, "candidateTable.updateRowState", "success"),
  };
}

// ---------- setCandidateNudgeCadenceOverride (후보별 독려 주기 편집, Task-44) ----------
// mailSignature.ts maskEmail과 같은 목적(로그/저장용 마스킹) — 그 함수는 export되지 않아 최소
// 형태로 이 파일에 둔다(복제가 아니라 이 모듈만의 저장 표시용 파생값).
function maskEmailForStorage(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, Math.min(2, local.length)) || "*"}***@${domain}`;
}

export interface SetCandidateNudgeCadenceOverrideDeps {
  db?: CandidateTableDb;
  now?: () => number;
  resolveAccountOwnershipScope?: typeof resolveAccountOwnershipScopeForRequest;
  orgTabAllows?: typeof orgTabAllows;
}

export async function setCandidateNudgeCadenceOverride(
  request: CallableRequestShape,
  deps: SetCandidateNudgeCadenceOverrideDeps = {},
): Promise<Record<string, unknown>> {
  // 독려 주기는 "누가 언제 메일을 받는가"를 바꾸는 축이다 — saveScpNudgeSequenceConfig와 같은
  // 등급(WRITE_ROLES=manager 이상), viewer는 거부.
  const ctx = assertNonGuestAuth(request, "candidateTable.setNudgeCadenceOverride", WRITE_ROLES);
  const data = asRecord(request.data);
  const channelId = channelIdFromCandidateRef(asString(data.candidateRef)) || asString(data.channelId);
  if (!channelId) {
    throw invalidArgument("candidate_nudge_cadence_missing_candidate", "candidateRef is required");
  }
  const candidateRef = `${CANDIDATE_POOL_COLLECTION}/${channelId}`;
  const db = resolveCandidateTableDb(deps.db);
  const now = deps.now ?? (() => Date.now());
  const nowIso = new Date(now()).toISOString();

  // null/undefined = 오버라이드 해제(전역 기본 NUDGE_DEFAULT_CADENCE_DAYS로 폴백). 그 외 값은
  // 1~365 정수가 아니면 던진다(assertValidCandidateCadenceDays).
  const rawCadenceDays = data.cadenceDays;
  const cadenceDays = rawCadenceDays === null || rawCadenceDays === undefined
    ? null
    : assertValidCandidateCadenceDays(rawCadenceDays);

  const doResolveAccountOwnershipScope = deps.resolveAccountOwnershipScope ?? resolveAccountOwnershipScopeForRequest;
  const accountScope = await doResolveAccountOwnershipScope(request, "candidateTable.setNudgeCadenceOverride", WRITE_ROLES, { data });
  assertWritableAccountOwnershipScope(accountScope, "candidate nudge cadence");
  await assertCandidateTabAccess(accountScope, deps.orgTabAllows ?? (deps.resolveAccountOwnershipScope ? async () => true : orgTabAllows));

  let scopedRef: CandidateTableDocRef | null = null;
  const campaignCandidateRef = asString(data.campaignCandidateRef);
  if (campaignCandidateRef) {
    const scoped = await resolveScopedCandidateMutationTarget(db, accountScope, {
      channelId,
      candidateRef,
      campaignCandidateRef,
    });
    const policy = scoped.program ? resolveProgramDiscoveryCriteria(scoped.program, scoped.campaign) : null;
    if (policy?.criteria.discoveryVertical === "ai_drama") {
      throw failedPrecondition(
        "candidate_nudge_cadence_scoped_ai_drama_disabled",
        "AI Drama scoped cadence override is disabled until AI mail timing permissions are explicitly granted",
      );
    }
    scopedRef = scoped.ref;
  }

  const ref = db.collection(CANDIDATE_POOL_COLLECTION).doc(channelId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw notFound("candidate_nudge_cadence_not_found", `candidate ${channelId} not found`);
  }
  const snapData = asRecord(snap.data());
  await assertAccountOwnershipForRecordAsync(accountScope, { id: snap.id, ...snapData }, "candidate");
  const rawEmail = asString(snapData.email);
  const email = rawEmail.trim().toLowerCase();
  // 재리뷰 MEDIUM: 감사 로그에 이전 값을 남긴다(mailImapRescan.ts 관례).
  const prevCadenceDays = candidateCadenceDaysOverrideFromState(asRecord(snapData.candidateTableState));

  // 재리뷰 MED-HIGH-1: 스윕은 이메일 단위로 동작한다 — "같은 이메일 = 같은 주기"가 실체다. 이
  // 이메일을 가진 candidate_pool 문서 전부(자기 자신 포함)를 같은 batch에서 동일 값으로 갱신한다.
  let appliedCandidateIds = [channelId];
  if (rawEmail) {
    const siblingSnap = await db.collection(CANDIDATE_POOL_COLLECTION).where("email", "==", rawEmail).get();
    const siblingIds: string[] = [];
    for (const doc of siblingSnap.docs) {
      if (!doc.exists) continue;
      if (await accountOwnedRowMatchesScopeAsync(accountScope, { id: doc.id, ...asRecord(doc.data()) })) {
        siblingIds.push(doc.id);
      }
    }
    appliedCandidateIds = dedupeStrings([channelId, ...siblingIds]);
  }

  // 재리뷰 HIGH: candidate_pool 정본 쓰기 + 스윕측 사본 쓰기를 db.batch() 하나로 묶어 원자
  // commit한다 — 하나가 실패하면 둘 다 커밋되지 않는다. 이메일을 공유하는 후보가 많을 때는
  // CANDIDATE_TABLE_IN_QUERY_LIMIT(30)씩 나눠 커밋하되, 원자성이 필요한 "1차 후보 + 스윕 사본"
  // 쌍은 항상 첫 청크(첫 batch)에 함께 들어간다(channelId가 appliedCandidateIds 맨 앞).
  const idChunks = chunkArray(appliedCandidateIds, CANDIDATE_TABLE_IN_QUERY_LIMIT);
  for (let chunkIndex = 0; chunkIndex < idChunks.length; chunkIndex += 1) {
    const chunk = idChunks[chunkIndex];
    const batch = db.batch();
    for (const id of chunk) {
      batch.set(
        db.collection(CANDIDATE_POOL_COLLECTION).doc(id),
        { candidateTableState: { nudgeCadenceDaysOverride: cadenceDays, lastActionAt: nowIso, lastActionBy: ctx.userId } },
        { merge: true },
      );
    }
    if (chunkIndex === 0 && scopedRef) {
      batch.set(
        scopedRef,
        { candidateTableState: { nudgeCadenceDaysOverride: cadenceDays, lastActionAt: nowIso, lastActionBy: ctx.userId } },
        { merge: true },
      );
    }
    if (chunkIndex === 0 && email) {
      // ② 스윕측 사본 — nudgeCohortSweep.ts가 이메일 해시로 조회한다(후보에 이메일이 없으면
      //   스윕이 어차피 이 후보를 모르므로 건너뛴다). 1차 후보와 같은 배치에 넣어 원자화한다.
      await writeCandidateNudgeCadenceOverride(db, {
        candidateRef: `${CANDIDATE_POOL_COLLECTION}/${channelId}`,
        emailDigest: nudgeEmailDigest(email),
        emailMasked: maskEmailForStorage(email),
        cadenceDays,
        updatedAtIso: nowIso,
        updatedBy: ctx.userId,
        updatedByRole: ctx.role,
      }, batch);
    }
    await batch.commit();
  }

  return {
    ok: true,
    candidateRef,
    ...(campaignCandidateRef ? { campaignCandidateRef } : {}),
    cadenceDaysOverride: cadenceDays,
    effectiveCadenceDays: cadenceDays ?? NUDGE_DEFAULT_CADENCE_DAYS,
    // 재리뷰 MED-HIGH-1: 같은 이메일을 공유해 함께 갱신된 후보 id 전부(UI가 "N건에 함께 적용" 안내).
    appliedCandidateIds,
    behaviorLog: makeBehaviorLog(
      ctx,
      `candidateTable.setNudgeCadenceOverride(${prevCadenceDays ?? "default"}→${cadenceDays ?? "default"})`,
      "success",
    ),
  };
}
