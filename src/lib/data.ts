// ── 데이터 레이어 (foundation seam) ────────────────────────────────────────
// UI는 "@/lib/data"만 import한다. 기존 화면은 mock 상수/타입을 그대로 재노출해
// 마크업·레이아웃을 건드리지 않고, 쓰기/집계/외부호출은 아래 callable 래퍼만 통한다.
// 규칙(§8):
//  - 클라이언트는 Firestore 직접 쓰기 금지(SEC-P0-004) → 쓰기/집계/외부호출은 Functions 경유.
//  - 모델 호출은 AI Gateway 경유(SEC-P0-005) + 캐시 선행(COST-P0-011).
//  - 외부망 호출은 Functions 프록시 경유(NET-P0-012).
import {
  SETTINGS,
  type BehaviorLogPayload,
  type CampaignTargetMetric,
  type CampaignOperationalState,
  type Conversation,
  type CountryTargeting,
  type Creator,
  type LlmCostLog,
  type Priority,
  type Program,
  type Role,
} from "./mock";
import type {
  DashboardProgramApplication,
  DashboardProgramSheetLead,
} from "./dashboard-pipeline";
import type {
  OperationalSnapshotScope,
  OperationalSnapshotSurface,
  OperationalSnapshotV1,
} from "./operational-snapshot";
import type { ProgramAliasDoc, ProgramRegistryDoc } from "./program-canonical";
import type { ScpAutomationControlEnvelope } from "./scpAutomationControlData";
import type { ScpApprovedWithoutIngestEnvelope } from "./scpDashboardIngestGapData";

export * from "./mock";
export { buildSafeMailPreviewDocument } from "./mailPreviewDocument";

export const FLU_CALLABLES = [
  "youtubeSearch",
  "emailFinder",
  "queueYtDlpDiscovery",
  "getDiscoveryRunStatus",
  "queueCommunityDiscovery",
  "recommendCreators",
  "gatewayProxy",
  "receiveEmail",
  "sendEmail",
  "markConversationRead",
  "setConversationAutoReply",
  "orchestrateCampaign",
  "syncCampaignFunnel",
  "learnCampaignPriority",
  "addCandidatesToCampaign",
  "importCandidatesToCampaign",
  "listCampaignCandidates",
  "listCandidates",
  "sendCandidateColdMail",
  "updateCandidateRowState",
  "setCandidateNudgeCadenceOverride",
  "convertCandidateToPartner",
  "revertCandidatePartnerConversion",
  "listCandidateReplyPartners",
  "repairLegacyCandidateScopes",
  "migrateCampaignCandidates",
  "listAiDramaRelevanceAudit",
  "negotiateContract",
  "createEscalation",
  "validateContractTemplate",
  "submitFeedback",
  "indexFeedbackKb",
  "retrieveFeedbackKb",
  "queueFineTuneExample",
  "retryFeedbackGraphProjection",
  "getFeedbackKbGovernanceStatus",
  "listKbReviewQueue",
  "resolveKbReview",
  "getManualReplyLearningSettings",
  "updateManualReplyLearningSettings",
  "backfillManualReplyLearningCandidates",
  "upsertCreator",
  "transitionCreatorStage",
  "syncChannelStats",
  "updateReviewStatus",
  "recordPayment",
  "syncReviewLedger",
  "aggregateReport",
  "listRawRecords",
  "logCostUsage",
  "getReportDashboard",
  "setMemberRole",
  "inviteMember",
  "requestAccess",
  "logBehavior",
  "recordLlmUsage",
  // 티켓 위젯(버그 제보·개선 의견) — src/lib/tickets.ts
  "submitTicket",
  "listTickets",
  "setTicketStatus",
  "deleteTicket",
  "retryTicketSuperboardSync",
  "createSeedData",
  "deleteSeedData",
  "updateAutoReply",
  "upsertTemplate",
  "createCampaign",
  "approveCampaignOutreach",
  "updateCampaignControl",
  "listCampaignOutreachApprovalQueue",
  "prepareProgramCampaignTargets",
  "auditCampaignOutreachWave",
  "reconcileCampaignOutreachMailLedgers",
  "createProgram",
  "getPublicProgram",
  "submitProgramApplication",
  "reviewProgramApplication",
  "syncProgramWorkflow",
  "updateProgramColdMail",
  "localizeProgramMailTemplate",
  "getEmailMode",
  "setEmailMode",
  "getSettings",
  "updateSettings",
  "refreshPolicyCache",
  "getScpAutomationSettings",
  "getScpAutomationControl",
  "updateScpAutomationSettings",
  "getScpLifecycleFlowConfig",
  "updateScpLifecycleFlowConfig",
  "previewScpLifecycleFlowConfig",
  "getMailSafetyStatus",
  "getApiQuotaStatus",
  "getAiHubKeyStatus",
  "listMailOutbox",
  "reconcileMailOutboxReplies",
  "importManualSentMailToOutbox",
  "attributeImportedSentOnlyHistory",
  "listScpColdmailHistory",
  "exportScpColdmailHistoryCsv",
  "rebuildScpColdmailHistoryProjections",
  "previewEmailDraft",
  "getMailSignatureSettings",
  "updateMailSignatureSettings",
  "getIntegrations",
  "updateIntegration",
  "getCaptchaSolverIntegration",
  "setCaptchaSolverIntegration",
  "getPeoplyStatus",
  "searchPeoplyDirectory",
  "getPeoplyPerson",
  "listMailAccounts",
  "upsertMailAccount",
  "setMailRouting",
  "setMemberMailAccountAccess",
  "resolveMyMailAccount",
  "getMyOrgContext",
  // Perf/cost 2026-09-24: batches getSettings/getMyOrgContext/listPrograms/getOperationalSnapshot/
  // getDashboardPipelineProjection into one in-process call — see functions/appBootstrap.ts. Not
  // yet called from any page in this PR (server-side foundation only); every read keeps using its
  // own individual callable above.
  "getAppBootstrap",
  "setUserPreference",
  "getOrgTabPresets",
  "setOrgTabPresets",
  "beginMailOAuth",
  "revokeMailOAuth",
  "getMailOAuthStatus",
  "startMailBackfill",
  "getMailBackfillStatus",
  "startCandidateRematch",
  "diagnoseMailTransport",
  "getMailProviderAttestationStatus",
  "attestMailProviderSubject",
  "revokeMailProviderSubject",
  "getYouTubeAuthorizationStatus",
  "updateWorkflowItemState",
  "syncGoogleSheetIntake",
  "syncParticipantRoster",
  "runSheet3SubmissionBridge",
  "getGoogleSheetIntakeStatus",
  "reconcileGoogleSheetIntake",
  "updateGoogleSheetIntakeCutover",
  "syncYouTubeEnrichment",
  "judgeQualification",
  "runQualificationBacktest",
  "writeBackQualificationSheetResults",
  "upsertCreatorLink",
  "upsertScpMailTemplate",
  "deleteScpMailTemplate",
  "prepareScpResultMail",
  "acknowledgeVideoResultMailDeadLetterAlert",
  "listScpEncouragementCandidates",
  "prepareScpEncouragementMail",
  "getVideoSubmissionReminderSettings",
  "updateVideoSubmissionReminderSettings",
  "listVideoSubmissionReminderTargets",
  "listVideoSubmissionReminderHistory",
  "previewVideoSubmissionReminderMail",
  "approveVideoSubmissionReminderMail",
  "updateVideoSubmissionReminderTarget",
  "processVideoSubmissionReminders",
  "sendPendingQualificationRejectionNotifications",
  "issueSubmissionTask",
  "getPublicSubmissionForm",
  "createSubmissionUploadUrl",
  "submitPublicSubmission",
  "judgeVideoReview",
  "runVideoReviewBacktest",
  "backfillVideoReviewAutomationOutbox",
  "getVideoReviewAutomationOutboxStatus",
  "getDataset",
  "getDashboardPipelineProjection",
  "listScpLifecycleProfiles",
  "refreshScpLifecycleProfiles",
  "diffScpLifecycleProfiles",
  "getScpLifecycleProfile",
  "getScpLifecycleVideoHistory",
  "resolveScpLifecycleProfile",
  "listScpLifecycleRefreshOutbox",
  "processScpLifecycleRefreshOutbox",
  "scheduleGemGrant",
  "holdGemGrant",
  "failGemGrant",
  "markGemGrantPaid",
  "listGemGrants",
  "getMessageSource",
  "listCreators",
  "listCampaigns",
  "listVideos",
  "listCommunityPosts",
  "listConversations",
  "listUnrepliedInbox",
  // W62-2 [헤세 · 지원 관리 탭]
  "listApplicationVideoPending",
  "enqueueApplicationVideoReminderMail",
  // W72 C-1 [코호트 × 회차 문안 매핑]
  "getScpNudgeSequenceConfig",
  "saveScpNudgeSequenceConfig",
  "saveScpNudgeProgramOverride",
  "listConversationMessages",
  "reclassifyConversationAttribution",
  "revertConversationAttribution",
  "reconcileConversationAttribution",
  "listPrograms",
  "listProgramApplications",
  "listProgramSheetLeads",
  "listEscalations",
  "listReviews",
  "listSubmissions",
  "listCandidatePool",
  "listCreatorComments",
  "listCreatorCommentInsights",
  "runCommentInsightsForVideo",
  "listTrendReports",
  "recordGoldenSetLabel",
  "createAdProposal",
  "recordAdProposalFeedback",
  "listAdProposals",
  "classifyFeedVideoAds",
  "promoteDiscoveredCreators",
  "runVideoViewSnapshots",
  "getVideoViewSeries",
  "getVideoViewRollups",
  "judgeVideoReviewMultimodal",
  "aggregateScpProgramFunnel",
  "getOperationalSnapshot",
  "rebuildOperationalSnapshot",
  "ensureOperationalSnapshotFresh",
  "getCampaignKeywordCorpus",
  "listScpQualificationQueue",
  "reconcileProgramRegistry",
  "listApplicationManageInbox",
  "assignApplicationManagement",
  "applicationManagementKpi",
  // W91 [헤세 · 크리에이터 탭]
  "listScpCreatorDirectory",
  // Flu/Task-37 [헤세 · 크리에이터 탭]
  "listScpApprovedWithoutIngest",
  // W91 [헤세 · admin-bridge]
  "listScpPortalCreators",
  "scpPortalCreatorCommand",
  "evaluateContentEligibility",
  "sendOnboardingTest",
  "transitionVideoReviewDecision",
  // Task-94: operator undo of an AI-authored `rejected` decision.
  "undoVideoReviewDecision",
  "scpEvaluateVideoDuplicate",
  "listScpVideoReviewStates",
  "getChatAutoCasePermitStatus",
  "setChatAutoCasePermitArming",
  "runChatAutoCasePermitEval",
  "listChatAutoCaseDecisionLedger",
  "getChatAutoCasebookSnapshot",
  "saveChatAutoCaseReply",
  "suggestChatAutoCaseReply",
  "resetChatAutoCaseReply",
  // Casebook inbox (2026-10-01): unclassified list + reply link preview
  "listChatAutoCasebookUnclassified",
  // Casebook inbox (2026-10-03): "실제 건 보기" — which pending conversations sit behind one card's count
  "listChatAutoCasebookCaseItems",
  // /chat/auto 검토 보드 (2026-10-05): read-only review board over the whole pending population
  "listChatAutoReviewBoard",
  "previewChatAutoCaseReply",
  // "보류 N건 지금 보내기" (case-backlog-send)
  "getChatAutoCaseHeldBacklogCount",
  "sendChatAutoCaseHeldBacklogNow",
] as const;

export type FluCallableName = (typeof FLU_CALLABLES)[number];
export type FluCallablePayload = Record<string, unknown>;
export type MailBodyFormat = "markdown" | "text" | "html";

export type CountryDecision =
  | "countryAllowed"
  | "excludedByIncludedCountries"
  | "excludedByExplicitCountry"
  | "unknownCountryHeld";

export interface FluCallableEnvelope {
  ok?: boolean;
  behaviorLog?: unknown;
  costLog?: unknown;
  [key: string]: unknown;
}

export interface YoutubeSearchPayload extends FluCallablePayload {
  queryRef: string;
  campaignRef?: string;
  gameId?: string;
  filters?: Record<string, unknown>;
}

export interface EmailFinderPayload extends FluCallablePayload {
  channelRef: string;
  candidateRef?: string;
  gameId?: string;
}

export interface QueueYtDlpDiscoveryPayload extends FluCallablePayload {
  programId?: string;
  campaignId?: string;
  campaignRef?: string;
  gameId?: string;
  discoveryVertical?: "game" | "ai_drama" | string;
  keywords?: string[];
  countryTargeting?: CountryTargeting;
  targetCountries?: string[];
  excludedCountries?: string[];
  filters?: {
    countryTargeting?: CountryTargeting;
    regions?: string[];
    targetCountries?: string[];
    excludedCountries?: string[];
    categories?: string[];
    excludeKeywords?: string[];
    minFollowers?: number;
    maxFollowers?: number;
    recentActivityDays?: number;
    minVideoViews?: number;
    minVideoCount?: number;
  };
  resultLimit?: number;
  commentLimit?: number;
  includeComments?: boolean;
}

export interface QueueCommunityDiscoveryPayload extends FluCallablePayload {
  actionId: string;
  programId?: string;
  campaignId?: string;
  campaignRef?: string;
  gameId?: string;
  trigger?: "feed_refresh" | "manual";
  respectCooldown?: boolean;
  brief?: string;
  keywords?: string[];
  countryTargeting?: CountryTargeting;
  ownedGameTags?: string[];
  similarGameTags?: string[];
  ugcKeywords?: string[];
  communitySubreddits?: string[];
  communityRefreshHours?: number;
  sources?: Array<
    | "reddit"
    | "discord"
    | "x"
    | "web"
    | "steam"
    | "Reddit"
    | "Discord"
    | "X"
    | "Web"
    | "Steam"
  >;
  filters?: {
    regions?: string[];
    categories?: string[];
    recentActivityDays?: number;
    platforms?: string[];
  };
  resultLimit?: number;
  includeComments?: boolean;
}

export interface QueueYtDlpDiscoveryEnvelope extends FluCallableEnvelope {
  ok: true;
  runId: string;
  runRef: string;
  jobRef: string;
  status: string;
  worker: string;
  countryTargeting: CountryTargeting;
}

export interface DiscoveryRunFunnelCounters {
  scanned: number;
  excludedByIncludedCountries: number;
  excludedByExplicitCountry: number;
  unknownCountryHeld: number;
  candidatesWritten: number;
  emailReady: number;
  kpiRemaining: number;
}

export interface DiscoveryRunErrorEvidence {
  code: string | null;
  message: string | null;
  errors: Array<{ index?: number; reason: string }>;
}

export interface DiscoveryRunStatusEnvelope extends FluCallableEnvelope {
  ok: true;
  runId: string;
  runRef: string;
  engine: string;
  status: string;
  terminal: boolean;
  terminalStatus: string | null;
  queuedAtIso: string | null;
  startedAtIso: string | null;
  completedAtIso: string | null;
  countryTargeting: CountryTargeting;
  counters: DiscoveryRunFunnelCounters;
  errorEvidence: DiscoveryRunErrorEvidence;
}

export interface RecommendCreatorsPayload extends FluCallablePayload {
  campaignRef?: string;
  creatorRefs?: string[];
  gameId?: string;
  limit?: number;
}

export interface GatewayProxyPayload extends FluCallablePayload {
  conversationId: string;
  threadId?: string;
  contextKey?: string;
  programId?: string;
  programTitle?: string;
  campaignId?: string;
  campaignTitle?: string;
  messageRef?: string;
  trackingId?: string;
  intent?: string;
  signal?: string;
  /** Optional operator-only drafting intent. Server normalizes and caps it before model input/cache. */
  operatorInstruction?: string;
  gameId?: string;
  dryRun?: boolean;
  // S4/P4 (RT-4/A4): marks an on-demand chat-open prefill call so the server can skip
  // re-invoking the model when this exact messageRef already has a resolved draft or
  // blockedReason (chatDraftPrefillCache.ts). The manual "AI 초안"/재시도 button never
  // sets this, so it always recomputes.
  autoPrefill?: boolean;
  // 온디맨드 프리필이 게이트웨이 evidence 집계(HumanGateContext)에 실제 대화 지표를 반영할 수
  // 있도록 — 미전달 시 gatewayContextFromData가 0으로 취급해 evidence gate가 항상 강등된다.
  creatorFollowers?: number;
  creatorRecentViews?: number;
  creatorEngagementPct?: number;
}

export interface ReceiveEmailPayload extends FluCallablePayload {
  conversationId?: string;
  threadId?: string;
  contextKey?: string;
  programId?: string;
  programTitle?: string;
  campaignId?: string;
  campaignTitle?: string;
  trackingId?: string;
  messageRef?: string;
  signal?: string;
  gameId?: string;
}

export interface SendEmailPayload extends FluCallablePayload {
  draftRef: string;
  conversationId?: string;
  threadId?: string;
  contextKey?: string;
  creatorId?: string;
  creatorName?: string;
  programId?: string;
  programTitle?: string;
  campaignId?: string;
  campaignTitle?: string;
  trackingId?: string;
  approvalRef?: string;
  approval?: "approved" | "rejected" | "pending";
  gameId?: string;
  to?: string;
  subject?: string;
  text?: string;
  intent?: "chat_manual_reply" | string;
  replyToMessageRef?: string;
  author?: string;
  fromRole?: "human" | "ai";
  dryRun?: boolean;
  liveSend?: boolean;
  forceImmediate?: boolean;
  /** Explicit sender account selected from getMyOrgContext.usableSenders. The server must
   * validate this against the caller's current sender policy before sending. */
  senderAccountId?: string;
  /** Legacy sender override accepted for older callers. New compose requests should use
   * senderAccountId; this field is unrelated to listConversations' mailAccountId view filter. */
  viewAccountId?: string;
}

export interface MarkConversationReadPayload extends FluCallablePayload {
  conversationId: string;
  threadId?: string;
  contextKey?: string;
  programId?: string;
  campaignId?: string;
  conversationIds?: string[];
  readAtIso?: string;
  gameId?: string;
}

export interface SetConversationAutoReplyPayload extends FluCallablePayload {
  conversationId: string;
  enabled: boolean;
  threadId?: string;
  contextKey?: string;
  programId?: string;
  campaignId?: string;
  conversationIds?: string[];
  gameId?: string;
}

export interface SetConversationAutoReplyEnvelope {
  ok: boolean;
  enabled: boolean;
  conversationRef: string;
  conversationRefs: string[];
  cancelledAutoReplies: number;
  updatedAtIso: string;
}

export type WorkflowEntity =
  | "conversation"
  | "campaign"
  | "program"
  | "programApplication"
  | "creator"
  | "contract"
  | "review"
  | "submission"
  | "candidate"
  | "candidatePool"
  | "escalation"
  | "video"
  | "communityPost";
export type WorkflowAction = "archive" | "delete" | "request_human" | "restore";

export interface WorkflowItemStatePayload extends FluCallablePayload {
  entity: WorkflowEntity;
  id: string;
  action: WorkflowAction;
  reason?: string;
  conversationIds?: string[];
  threadId?: string;
  contextKey?: string;
  gameId?: string;
}

export interface WorkflowItemStateEnvelope extends FluCallableEnvelope {
  blocked?: boolean;
  hidden?: boolean;
  entity?: WorkflowEntity;
  id?: string;
  action?: WorkflowAction;
  message?: string;
  interventionRef?: string;
}

export interface MessageSourcePayload extends FluCallablePayload {
  messageRef: string;
  /** Flu/Task-48: view as this mail account — same server-side validation as listConversations. */
  mailAccountId?: string;
  /** Flu/Task-50 — super_admin "대신 보기", server-verified (see DatasetPagePayload). */
  viewAsUserId?: string;
  viewAsEmail?: string;
}

export interface MessageSourceEnvelope extends FluCallableEnvelope {
  found?: boolean;
  /** found:true 인데 ok:false 일 때만 온다 — 원문은 있지만 이 역할엔 열람 권한이 없다는 뜻. */
  reason?: "scope";
  messageRef: string;
  subject?: string;
  from?: string;
  to?: string;
  direction?: string;
  body?: string;
  /** 전문이 원장에 없을 때 오는 240자 프리뷰. 뷰어는 이걸 받으면 프리뷰임을 밝히고 보여준다. */
  bodyPreview?: string;
  summaryKr?: string;
  createdAtIso?: string;
  sentAtIso?: string;
  receivedAtIso?: string;
  mailEventAtIso?: string;
}

export interface CampaignCallablePayload extends FluCallablePayload {
  campaignId: string;
  campaignRef?: string;
  gameId?: string;
  targetN?: number;
  priority?: string;
  reasonCode?: string;
}

export interface CampaignCandidateLink {
  id: string;
  name: string;
  handle: string;
  platform: string;
  campaignCandidateRef: string;
  email?: string;
  canonicalProgramId?: string;
  programId?: string;
  campaignId?: string;
  sourceRunId?: string;
  sourceRunRef?: string;
  candidateRef?: string;
  publicationCandidateRef?: string;
  publicationGenerationId?: string;
}

export interface AddCandidatesToCampaignPayload extends FluCallablePayload {
  campaignId: string;
  programId?: string;
  sourceRunId?: string;
  sourceRunRef?: string;
  gameId?: string;
  candidates: CampaignCandidateLink[];
}

export interface AddCandidatesToCampaignEnvelope extends FluCallableEnvelope {
  campaignId: string;
  campaignRef: string;
  linkedCount: number;
  createdCount: number;
  existingCount: number;
  candidateCount: number;
}

export interface ImportCampaignCandidate {
  id: string;
  name: string;
  handle: string;
  platform: string;
  email?: string;
  followers?: number;
  region?: string;
  category?: string;
  sourceUrl?: string;
}

export interface ImportCandidatesToCampaignPayload extends FluCallablePayload {
  programId: string;
  campaignId: string;
  gameId?: string;
  candidates: ImportCampaignCandidate[];
}

export interface ImportCandidatesToCampaignEnvelope extends AddCandidatesToCampaignEnvelope {
  programId: string;
  runId: string;
  runRef: string;
}

export interface ListCampaignCandidatesPayload extends FluCallablePayload {
  programId: string;
  campaignId: string;
  gameId?: string;
  pageSize?: number;
  cursor?: string;
}

export interface ScopedCampaignCandidate extends CampaignCandidateLink {
  candidateId: string;
  candidateRef: string;
  canonicalProgramId: string;
  campaignId: string;
  sourceRunId: string;
  sourceRunRef: string;
  stage?: string;
  linkState?: string;
}

export interface ListCampaignCandidatesEnvelope extends FluCallableEnvelope {
  programId: string;
  campaignId: string;
  candidates: ScopedCampaignCandidate[];
  count: number;
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
  sort: "campaign_candidate_ref_asc";
}

// Flu/Task-43: 후보 탭 테이블(functions/candidateTable.ts) — candidate_pool을 원천으로 한
// 읽기 전용 프로젝션. 이메일 본문/프롬프트 원문 없음(SEC-P0-009).
export interface CandidateTableVideoSnapshot {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  publishedAtIso: string | null;
  viewCount: number | null;
  // AI-DRAMA-DISCOVERY-METAPROMPT W4: functions/candidateTable.ts mirror.
  likeCount: number | null;
}

// AI-DRAMA-DISCOVERY-METAPROMPT W5: functions/candidateTable.ts CandidateTableCommentSentiment
// mirror — a pre-computed (never live) JEV comment-sentiment result.
export interface CandidateTableCommentSentiment {
  status: "ok" | "insufficient_sample" | "unavailable";
  choice: string | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  analyzedCount: number;
  analyzedAtIso: string;
}

// AI-DRAMA-DISCOVERY-METAPROMPT W4: functions/candidateTable.ts CandidateTableIdentity mirror —
// "who is this creator" fields already stored on the candidate_pool doc at discovery time.
export interface CandidateTableIdentity {
  avatar: string | null;
  category: string | null;
  publicDescription: string | null;
  creatorCountry: string | null;
  followers: number | null;
  youtubeUrl: string | null;
  matchScore: number | null;
  signals: string[];
}

// functions/aiDramaRelevance.ts AiDramaRelevanceStamp mirror — stamped onto the candidate_pool/
// campaign_candidates doc by the ai_drama JEV relevance gate at discovery time. `reason` is a short
// derived code (e.g. "jev_ai_drama_relevant"), never a raw JEV prompt/response (SEC-P0-009).
export interface CandidateTableAiDramaRelevance {
  score: number;
  scorePercent: number;
  reason: string;
  judgedAtIso: string;
  modelId: string;
}

export interface CandidateTableMeta {
  country: string | null;
  subscribers: number | null;
  recentVideos: CandidateTableVideoSnapshot[];
  avgRecentViews: number | null;
  qualifyingVideoCount?: number | null;
  minVideoViewThreshold?: number | null;
  topQualifyingVideo?: CandidateTableVideoSnapshot | null;
  provenance?: {
    country?: string | null;
    keywords?: string[] | null;
    tags?: string[] | null;
    providerCoverage?: string | null;
  } | null;
  enrichedAt: string | null;
  enrichSource: "cache" | "live" | null;
}

// Flu/Task-43 적대 리뷰 P0④: 로컬 필드가 아니라 원장(campaign_outreach → scp_coldmail_history)에서
// 파생된다(functions/candidateTable.ts hydrateContactStatus). "발송"은 실제 발송(sent/mock_sent)일 때만.
// Flu/Task-46: "회신"/"수락 후보"/"협의 중"/"수락"은 conversations.inboundIntent(기존 인바운드
// 분류)와 candidate_reply_partners(전환 상태)에서 파생되는 오버레이다(functions/candidateTable.ts
// hydrateReplyAcceptance) — 발송류 상태보다 항상 우선한다.
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

// Flu/Task-44: 팝오버 타임라인 한 행 — 본문/제목 원문 없음(SEC-P0-009). conversationId만 넘기고
// 클라이언트가 /chat?conversationId=... 딥링크로 연다.
export interface CandidateTableOutreachEvent {
  atIso: string;
  type: "coldmail" | "nudge";
  result: string;
  conversationId: string | null;
}

// 재리뷰(Task-44) MED-HIGH-2: nextNudgeAtIso가 어떤 축에서 나왔는지 — functions/candidateTable.ts
// CandidateTableNextNudgeBasis와 1:1.
export type CandidateTableNextNudgeBasis = "override" | "cohort" | "default";

// 2026-09-11 rebase: Task-45가 이름만 맞춰 뒀던 CandidateTableStats는 폐기하고 Task-44의 이
// 타입을 stats의 정본으로 쓴다(functions/candidateTable.ts와 동일 rebase 판단) — Task-45의
// lastOutreachAtIso는 별도 필드로 남아 stats.lastSentAtIso와 충돌하지 않는다.
export interface CandidateTableOutreachStats {
  coldmailCount: number;
  nudgeCount: number;
  lastSentAtIso: string | null;
  nextNudgeAtIso: string | null;
  hasReply: boolean;
  cadenceDaysOverride: number | null;
  effectiveCadenceDays: number;
  nextNudgeBasis: CandidateTableNextNudgeBasis;
  timeline: CandidateTableOutreachEvent[];
}

export interface CandidateTableRow {
  id: string;
  candidateRef: string;
  /** Exact scoped campaign_candidates/{id} link when this row is rendered from a campaign candidate. */
  campaignCandidateRef?: string | null;
  name: string;
  handle: string;
  platform: string;
  email: string | null;
  emailStatus: string;
  // Flu/Task-45: 캘린더 뷰(날짜별 유입 카운트)의 유입일 근거 — candidate_pool 문서의 Firestore
  // createTime(merge 쓰기로 갱신되지 않음).
  createdAtIso: string | null;
  meta: CandidateTableMeta;
  state: CandidateTableRowState;
  stats: CandidateTableOutreachStats;
  // P1-2: hydrateContactStatus가 campaign_outreach 원장에서 파생한 발송 시각 — stats와 분리된
  // 별도 필드라 Task-44의 stats 전체 덮어쓰기와 절대 충돌하지 않는다. 발송류(sent/mock_sent/
  // sent_evidence_pending) 상태로 확정된 행만 채운다(그 전 단계면 null).
  lastOutreachAtIso: string | null;
  // 2026-09-11 재리뷰 P1(기존 결함 (a)안): candidate_pool 문서로 뒷받침되지 않는 행(exact-scope
  // 디스커버리가 campaign_candidates 링크 문서만 쓴 경우)은 false — 별표/보류/주기 편집을
  // 비활성화하는 신호로 쓴다(functions/candidateTable.ts rowFromLinkDocData).
  poolBacked: boolean;
  /** Server authority for whether this scoped row may edit nudge cadence. Absent preserves legacy game behavior. */
  canEditNudgeCadence?: boolean;
  nudgeCadenceReadOnlyReason?: string | null;
  // Flu/Task-60: functions/candidateTable.ts CandidateTableRow.duplicateOf 미러(관례 — 이 파일은
  // 서버 응답 타입을 그대로 따라간다). 같은 인물이 서로 다른 channelId로 두 행이 될 때
  // annotateCandidateDuplicates가 고른 승자(canonical) 행의 channelId — 승자 자신·중복 없음은
  // null. 화면 배지(접기/강조)는 Flu/Task-55에서 CandidateTable.tsx에 추가한다(이 필드 자체는
  // Task-60 범위 — 서버 투영만).
  duplicateOf: string | null;
  // AI-DRAMA-DISCOVERY-METAPROMPT W4: functions/candidateTable.ts CandidateTableRow.identity
  // mirror. Optional here (unlike the server type) so this client type stays additive for any
  // caller that constructs a row without it in a test fixture.
  identity?: CandidateTableIdentity;
  // AI-DRAMA-DISCOVERY-METAPROMPT W5: functions/candidateTable.ts CandidateTableRow.commentSentiment
  // mirror. null/undefined both mean "no analysis yet" — the UI must not distinguish them.
  commentSentiment?: CandidateTableCommentSentiment | null;
  // functions/candidateTable.ts CandidateTableRow.aiDramaRelevance mirror — see
  // CandidateTableAiDramaRelevance doc comment. Optional/nullable here for the same reason as
  // identity/commentSentiment above.
  aiDramaRelevance?: CandidateTableAiDramaRelevance | null;
}

export interface ListCandidatesPayload extends FluCallablePayload {
  programId?: string;
  campaignId?: string;
  pageSize?: number;
  /** Flu/Task-50 — super_admin "대신 보기", server-verified (see DatasetPagePayload). */
  viewAsUserId?: string;
  viewAsEmail?: string;
}

export interface ListCandidatesEnvelope extends FluCallableEnvelope {
  ok: true;
  scope: "all" | "program" | "campaign";
  programId: string | null;
  campaignId: string | null;
  candidates: CandidateTableRow[];
  count: number;
  pageSize: number;
  // 2026-09-11 재리뷰 P1: 스코프 분기의 원 쿼리가 pageSize를 꽉 채웠는지(더 있을 수 있는지) —
  // count === pageSize는 candidate_pool 미기록 폴백 전에는 rows가 줄어들어 부정확했다.
  truncated: boolean;
  enrichment: {
    attempted: number;
    cacheHits: number;
    cacheMisses: number;
    skippedOverBatchCap: number;
    errors: number;
    providerCoverage?: string | null;
  };
  eligibility?: {
    checked: number;
    excluded: number;
    reasons: Record<string, number>;
    warning: string;
  };
}

export interface SendCandidateColdMailPayload extends FluCallablePayload {
  candidateRef: string;
  // Task-43 적대 리뷰 P0①: 후보 탭의 프로그램/캠페인 선택기 값 — 실제 콜드메일 큐(campaign_outreach)는
  // 캠페인에 귀속되므로 필수다. 클라이언트는 미선택 시 발송 버튼을 비활성화한다.
  campaignId: string;
}

export interface SendCandidateColdMailEnvelope extends FluCallableEnvelope {
  ok: true;
  // 실제 SMTP 발송은 chat-ai.ts 스윕 워커의 몫이다 — 항상 false. 큐 적재 결과는 queued/approved로 본다.
  sent: boolean;
  blocked: boolean;
  reason?: string;
  ruleId?: string;
  severity?: string;
  queued?: boolean;
  approved?: boolean;
  approvalNote?: string;
  outreachId?: string;
  candidateRef: string;
}

export interface UpdateCandidateRowStatePayload extends FluCallablePayload {
  candidateRef: string;
  /** Exact campaign_candidates/{id} link for scoped row state writes when the server returned one. */
  campaignCandidateRef?: string;
  favorite?: boolean;
  decision?: "hold" | "clear";
}

export interface UpdateCandidateRowStateEnvelope extends FluCallableEnvelope {
  ok: true;
  candidateRef: string;
  favorite?: boolean;
  decision?: "hold" | null;
}

// Flu/Task-44: 후보별 독려 주기(cadenceDays) 편집. cadenceDays: null이면 오버라이드 해제
// (전역 기본으로 폴백).
export interface SetCandidateNudgeCadenceOverridePayload extends FluCallablePayload {
  candidateRef: string;
  /** Exact campaign_candidates/{id} link for scoped cadence writes when the server returned one. */
  campaignCandidateRef?: string;
  cadenceDays: number | null;
}

export interface SetCandidateNudgeCadenceOverrideEnvelope extends FluCallableEnvelope {
  ok: true;
  candidateRef: string;
  cadenceDaysOverride: number | null;
  effectiveCadenceDays: number;
  // 재리뷰 MED-HIGH-1: 같은 이메일을 공유해 함께 갱신된 후보 id 전부(자기 자신 포함).
  appliedCandidateIds: string[];
}

// Flu/Task-46: 후보 회신 → 파트너 전환. 서버(functions/candidatePartnerConversion.ts)가
// candidateRef만으로 conversationId를 직접 재확인하므로 클라이언트는 candidateRef만 넘긴다.
export interface ConvertCandidateToPartnerPayload extends FluCallablePayload {
  candidateRef: string;
}

export interface ConvertCandidateToPartnerEnvelope extends FluCallableEnvelope {
  ok: true;
  channelId: string;
  candidateRef: string;
  conversationId: string | null;
  status: "active";
  alreadyConverted: boolean;
}

export interface RevertCandidatePartnerConversionPayload extends FluCallablePayload {
  candidateRef: string;
  reasonCode?: string;
}

export interface RevertCandidatePartnerConversionEnvelope extends FluCallableEnvelope {
  ok: true;
  channelId: string;
  status: "revoked";
  alreadyRevoked: boolean;
}

export interface ListCandidateReplyPartnersPayload extends FluCallablePayload {
  /** Flu/Task-50 — super_admin "대신 보기", server-verified (see DatasetPagePayload). */
  viewAsUserId?: string;
  viewAsEmail?: string;
}

export interface CandidateReplyPartnerRow {
  channelId: string;
  candidateRef: string;
  conversationId: string | null;
  name: string;
  handle: string;
  platform: string;
  email: string | null;
  acceptedAt: string;
  acceptedBy: string;
  source: "candidate_reply";
}

export interface ListCandidateReplyPartnersEnvelope extends FluCallableEnvelope {
  ok: true;
  partners: CandidateReplyPartnerRow[];
  count: number;
}

export interface RepairLegacyCandidateScopesPayload extends FluCallablePayload {
  limit?: number;
  afterCandidateId?: string;
}

export interface RepairLegacyCandidateScopesEnvelope extends FluCallableEnvelope {
  scannedCount: number;
  repairedCount: number;
  humanGateCount: number;
  nextCandidateId: string | null;
  done: boolean;
  results: Array<{
    candidateId: string;
    status: "repair" | "human_gate";
    reason: string;
    targetRef?: string;
  }>;
}

// 운영자 수동 이주(예: XP Hero contacted → Snake Clash discovered) — admin+ only,
// 기본 dryRun. execute 는 서버측 confirm 문구 게이트가 필요하다.
export interface MigrateCampaignCandidatesPayload extends FluCallablePayload {
  sourceCampaignId: string;
  targetCampaignId: string;
  /** 기본 ["contacted"]. */
  sourceStages?: string[];
  /** 기본 true. */
  dryRun?: boolean;
  batchSize?: number;
  limit?: number;
  /** dryRun=false 일 때 필수 — "migrate-xp-pororo-campaign-candidates-v1". */
  confirm?: string;
  /** 이전 호출의 `nextCursor` 를 그대로 되돌려주면 그 지점부터 이어서 스캔한다(2026-09-27). */
  cursor?: string;
}

export interface MigrateCampaignCandidatesEnvelope extends FluCallableEnvelope {
  ok: true;
  dryRun: boolean;
  migrationRunId: string | null;
  runRef: string | null;
  sourceCanonicalProgramId: string;
  targetCanonicalProgramId: string;
  scannedRows: number;
  withEmail: number;
  uniqueEmails: number;
  skippedNoCandidateId: number;
  skippedNoEmail: number;
  duplicateEmailsInRun: number;
  judgmentDist: Record<string, number>;
  suppressionDist: Record<string, number>;
  eligibilityDist: Record<string, number>;
  skippedUndeliverable: number;
  skippedSuppressedOther: number;
  alreadyExistingTargetDocs: number;
  wouldMigrate: number;
  written: number;
  createdDocs: number;
  mergedDocs: number;
  /** true when this call stopped early(limit or the internal time budget) and `nextCursor` is set. */
  truncated: boolean;
  /** Pass back as `cursor` to continue past this call's stopping point when `truncated` is true. */
  nextCursor: string | null;
  excludedSampleRefs: string[];
}

export interface ContractCallablePayload extends FluCallablePayload {
  contractRef: string;
  creatorId?: string;
  templateRef?: string;
  capKRW?: number;
  requestedKRW?: number;
  round?: number;
  gameId?: string;
  templateFileName?: string;
  templateFileRef?: string;
  pdfText?: string;
  pdfFileName?: string;
  followers?: number;
  recentViews?: number;
  engagementPct?: number;
}

export interface FeedbackCallablePayload extends FluCallablePayload {
  target: "chat" | "email" | "contract" | "priority" | "negotiation" | "mail";
  pipelineDomain?: "priority" | "negotiation" | "mail" | "contract" | "chat";
  rating?: "up" | "down";
  reason?: string;
  artifactRef?: string;
  feedbackRef?: string;
  excerpt?: string;
  note?: string;
  gameId?: string;
  programId?: string;
  campaignId?: string;
  locale: string;
  globalScope?: "global";
  reviewDecision?: "approve" | "reject";
  reviewNote?: string;
  correctionNote?: string;
  expectedRevision?: number;
  transitionId?: string;
  releaseApproved?: boolean;
  fineTuneAction?: "release" | "retry";
  expectedOutboxRevision?: number;
}

export interface RetrieveFeedbackKbPayload extends FluCallablePayload {
  target?: FeedbackCallablePayload["target"];
  pipelineDomain?: FeedbackCallablePayload["pipelineDomain"];
  query?: string;
  artifactRef?: string;
  limit?: number;
  candidateLimit?: number;
  cursor?: string;
  gameId?: string;
  programId?: string;
  campaignId?: string;
  locale?: string;
  globalScope?: "global";
}

export interface RetryFeedbackGraphProjectionPayload extends FluCallablePayload {
  feedbackRef: string;
  graphProjectionOutboxRef?: string;
}

export interface UpsertCreatorPayload extends FluCallablePayload {
  id: string;
  name: string;
  handle: string;
  avatar?: string;
  email?: string;
  type: string;
  platform: string;
  followers?: number;
  region: string;
  category: string;
  stage: string;
  owner: string;
  budgetKRW?: number;
  team?: string;
}

export interface TransitionCreatorStagePayload extends FluCallablePayload {
  creatorId: string;
  from?: string;
  to: string;
}

export interface SyncChannelStatsPayload extends FluCallablePayload {
  creatorId: string;
  channelId: string;
  longAvgViews?: number;
  recentViews?: number;
  engagement?: number;
}

export interface ReviewStatusPayload extends FluCallablePayload {
  reviewId?: string;
  submissionId?: string;
  /** Legacy: pending | pass | revise | block | human_reply. SCP video: pending | approved | rejected | needs_review. */
  status: string;
  reviewStatus?: string;
  reasonCode?: string;
  reasonText?: string;
  feedbackText?: string;
  amount?: number;
  amountKRW?: number;
  currency?: "KRW" | "USD";
  /** Required when status === "block" */
  reason?: string;
  /** Required when status === "human_reply" */
  replyText?: string;
}

export interface RecordPaymentPayload extends FluCallablePayload {
  reviewId?: string;
  submissionId?: string;
  paymentRef: string;
  reasonText?: string;
}

export interface ReportPayload extends FluCallablePayload {
  gameId?: string;
  period?: string;
  filters?: Record<string, unknown>;
}

// getReportDashboard — /flu/report rebuild (SCP Creator Portal admin dashboard clone, 2026-09-07).
export interface GetReportDashboardPayload extends FluCallablePayload {
  fromDate: string; // YYYY-MM-DD, KST 달력일
  toDate: string; // YYYY-MM-DD, KST 달력일
}
export interface ReportDashboardTopVideo {
  rank: number;
  youtubeVideoId: string;
  title: string;
  views: number;
  publishedAt: string;
}
export interface ReportDashboardRewardByCountry {
  code: string;
  tierCode: string;
  cpmMicrosPerThousand: string;
  videos: number;
  views: number;
  estimatedRewardUsd: number;
}
export interface ReportDashboardPulseDay {
  date: string;
  applications: number;
  submissions: number;
  views: number;
}
export interface ReportDashboardSubmittedVideoRow {
  date: string;
  youtubeVideoId: string;
  title: string;
  views: number | null;
  reviewStatus: string;
  tracked: boolean;
}
/** 조회수 3단 사다리(1단 tracked=video_performance_report_rows·2단 rollup=video_view_rollups·
 * 3단 live=라이브 YouTube API) 결과 분포. unavailable 은 세 단 모두 실패한 영상 수. */
export interface ReportDashboardVideoViewsSource {
  tracked: number;
  rollup: number;
  live: number;
  unavailable: number;
}
export interface ReportDashboardResponse {
  period: { fromDate: string; toDate: string };
  operations: {
    coldEmails: number;
    replies: number;
    replyRatePct: number;
    applications: number;
    loginRequests: number | null;
    loginRequestRatePct: number | null;
    contentSubmissions: { total: number; pending: number; approved: number; rejected: number };
    videoViews: number;
    viewsPerColdEmail: number;
  };
  topVideos: ReportDashboardTopVideo[];
  viewReward: {
    participatingCreators: number;
    submittedContent: number;
    rejectedContent: number;
    viewsIn7dWindow: number;
    estimatedRewardUsd: number;
    byCountry: ReportDashboardRewardByCountry[];
  };
  pulse: { days: ReportDashboardPulseDay[] };
  submittedVideos: {
    uniqueInPeriod: number;
    rejectedInPeriod: number;
    /** 누적 제출 건수(반려 제외) — "유니크 영상" 이 아니다. */
    allTimeSubmissions: number;
    withPublicViews: number;
    tracked: number;
    untracked: number;
    rows: ReportDashboardSubmittedVideoRow[];
    viewsSource: ReportDashboardVideoViewsSource;
  };
  creatorCountries: Array<{ code: string; name: string; count: number }>;
  portalAccounts: { total: number; approved: number; pending: number; rejected: number } | null;
  truncated: {
    applicationDays: boolean;
    bridge: boolean;
    submissions: boolean;
    reportRows: boolean;
  };
  generatedAtIso: string;
  cache?: { hit: boolean; ageSeconds: number };
}

export interface RecordLlmUsagePayload extends FluCallablePayload {
  usage?: Partial<LlmCostLog>;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedUsd?: number;
  cacheHit?: boolean;
  gameId?: string;
}

export interface SeedDataPayload extends FluCallablePayload {
  entity?: string;
  count?: number;
  gameId?: string;
}

export interface SettingsPayload extends FluCallablePayload {
  patch?: Record<string, unknown>;
  expectedRevision?: number;
  confirm?: boolean;
  scope?: string;
  gameId?: string;
}

export interface SettingsEnvelope extends FluCallableEnvelope {
  ok: true;
  settings: typeof SETTINGS;
  revision: number;
  settingsContract?: {
    firestorePath: "settings/default";
    source: "persisted" | "initialized_defaults";
    persistedSections: string[];
  };
}

export interface SettingsUpdateEnvelope extends SettingsEnvelope {
  updatedKeys: string[];
  changedKeys: string[];
  noop: boolean;
}

export interface MailSafetyStatusEnvelope extends FluCallableEnvelope {
  status?: {
    /**
     * @deprecated Legacy alias for `automatedSendLocked`.
     * This field never implies that manual one-to-one sending is locked.
     */
    outboundLocked?: boolean;
    /** Whether the automated-send lane is blocked. */
    automatedSendLocked?: boolean;
    /** True only when both automated and manual outbound lanes are blocked. */
    allOutboundLocked?: boolean;
    /** Whether a person may still send a manual one-to-one message. */
    manualSendAllowed?: boolean;
    lockedReason?: string;
    lockedRuleId?: string;
    unlockTimeIso?: string;
    todaySent?: number;
    hourSent?: number;
    bounced?: number;
    deferred?: number;
    suppressed?: number;
    policy?: {
      hourlyCap?: number;
      dailyCap?: number;
      burstCap?: number;
      uniqueRecipientDailyCap?: number;
      weeklyTotalCap?: number;
      reputationStatus?: string;
    };
    // A3(RT-3)/S3: 동일-tx rollup — 별도 카운터 아님, "현재 주 사용량" 표시용.
    weeklyOutbound?: {
      weekKey?: string;
      used?: number;
      cap?: number;
    };
    imapConfiguration?: {
      liveEnabled?: boolean;
      configured?: boolean;
      missingFields?: string[];
      operationalReady?: boolean;
      operationalMissingFields?: string[];
      hostConfigured?: boolean;
      usernameConfigured?: boolean;
      credentialConfigured?: boolean;
      runtimeSecretBound?: boolean;
      passwordReferenceConfigured?: boolean;
    };
    imapLastSync?: {
      runId?: string;
      status?: string;
      finishedAtIso?: string;
      fetched?: number;
      matched?: number;
      bounced?: number;
      errors?: number;
    };
    imapLastSuccess?: {
      runId?: string;
      status?: string;
      finishedAtIso?: string;
      fetched?: number;
      matched?: number;
      bounced?: number;
      errors?: number;
    };
    imapLastSyncIso?: string;
    imapLastResult?: "ok" | "error";
    ingestBacklogQueued?: number;
    ingestErrors?: number;
    ingestUnresolvedErrors?: number;
    quarantineCount?: number;
    operational?: MailSafetyOperationalState;
    controls?: {
      emergencyShutdown?: MailSafetyControlState;
      manualPause?: MailSafetyControlState;
      activeOutboundLock?: MailSafetyControlState & { unlockTimeIso?: string };
      quota?: MailSafetyQuotaStatus;
      recipientPolicy?: MailSafetyRecipientPolicySummary;
    };
    recipientCheck?: {
      evaluated: true;
      manualSend: MailSafetyLaneStatus;
      automatedSend: MailSafetyLaneStatus;
    };
  };
}

export interface MailSafetyLaneStatus {
  allowed: boolean;
  state: "available" | "blocked" | "degraded";
  code: string;
  message: string;
  blockerCode?: string;
  blockerReason?: string;
  requiresInboundSafety: boolean;
}

export interface MailSafetyQuotaStatus {
  blocked: boolean;
  blockerCode?: string;
  blockerReason?: string;
  todaySent: number;
  hourSent: number;
  weeklyUsed: number;
  dailyCap: number;
  hourlyCap: number;
  weeklyCap: number;
}

export interface MailSafetyOperationalState {
  manualSend: MailSafetyLaneStatus;
  automatedSend: MailSafetyLaneStatus;
  inboxReceive: MailSafetyLaneStatus;
  inboundDependentAutomation: MailSafetyLaneStatus;
  quota: MailSafetyQuotaStatus;
}

export interface MailSafetyControlState {
  active: boolean;
  blockerCode: string;
  blockerReason: string;
}

export interface MailSafetyRecipientPolicySummary {
  activeSuppressionCount: number;
  blockedEmailCount: number;
  blockedDomainCount: number;
  suppressedHandleCount: number;
  recipientSpecificRulesActive: boolean;
  requiresRecipientCheck: true;
}

export interface AutoReplyPayload extends FluCallablePayload {
  enabled: boolean;
  model: string;
  tone: string;
  workingHours: string;
  rules: Record<string, unknown>[];
}

export interface TemplatePayload extends FluCallablePayload {
  id: string;
  title: string;
  stage: string;
  channel: string;
  body: string;
  vars: string[];
  aiManaged: boolean;
  usage?: number;
  fixed?: boolean;
  personalizationHints?: Record<string, string>;
}

export const CANONICAL_OPERATIONAL_MAILBOX = "scp@supercent.io" as const;

export type IntegrationKey =
  "mailSmtp" | "mailImap" | "gateway" | "externalApi" | "aiHub";

export interface IntegrationPayload extends FluCallablePayload {
  key: IntegrationKey;
  values?: Record<string, unknown>;
}

export type MailDiagnosticCode =
  | "smtp_ok"
  | "imap_ok"
  | "imap_empty"
  | "runtime_disabled"
  | "configuration_missing"
  | "secret_not_bound"
  | "timeout"
  | "authentication_failed"
  | "tls_failed"
  | "connection_failed"
  | "mailbox_not_found"
  | "mailbox_list_failed"
  | "mailbox_open_failed"
  | "message_probe_failed"
  | "identity_mismatch"
  | "identity_unknown"
  | "probe_stale_config_changed"
  | "unexpected_failure";

export interface MailTransportProbeLane {
  status: "ok" | "failed" | "skipped";
  code: MailDiagnosticCode;
  checkedAtIso: string;
  latencyMs: number;
  runtimeSecretBound: boolean;
  mailbox?: string;
  messageProbe?: "parsed" | "empty" | "not_run";
}

export type MailProbeFingerprintState = "fresh" | "probe_stale_config_changed";

export interface MailTransportProbeStatus {
  valid: boolean;
  checkedAtIso: string;
  expiresAtIso: string;
  operationalReady: boolean;
  smtp: MailTransportProbeLane;
  imap: MailTransportProbeLane;
  configFingerprint?: string;
  probeState?: MailProbeFingerprintState;
  receiptHash?: string;
  receiptIntegrityValid?: boolean;
}

export interface DiagnoseMailTransportEnvelope extends FluCallableEnvelope {
  ok: true;
  probe: MailTransportProbeStatus;
  statusPersisted: boolean;
  noMailSent: true;
  attestationChallengeToken: string;
}

export type MailProviderAttestationStatus =
  "active" | "expired" | "revoked" | "missing" | "config_changed";

export type MailProviderAttestationReasonCode =
  | "attestation_active"
  | "attestation_missing"
  | "attestation_expired"
  | "attestation_revoked"
  | "attestation_config_changed"
  | "attestation_invalid_receipt";

export interface MailProviderAttestationProjection {
  schemaVersion: "mail-provider-subject-attestation-public-v1";
  status: MailProviderAttestationStatus;
  providerSubjectVerified: boolean;
  canonicalMailbox: typeof CANONICAL_OPERATIONAL_MAILBOX;
  attestedAt: string | null;
  expiresAt: string | null;
  diagnosticCheckedAt: string | null;
  diagnosticExpiresAt: string | null;
  fingerprintPrefix: string;
  currentFingerprintPrefix: string;
  correlationReceipt: string | null;
  reasonCode: MailProviderAttestationReasonCode;
  reasonKo: string;
}

export interface MailProviderAttestationEnvelope extends FluCallableEnvelope {
  ok: true;
  attestation: MailProviderAttestationProjection;
}

export interface AttestMailProviderSubjectPayload extends FluCallablePayload {
  canonicalMailboxConfirmation: typeof CANONICAL_OPERATIONAL_MAILBOX;
  diagnosticChallengeToken: string;
}

export interface RevokeMailProviderSubjectPayload extends FluCallablePayload {
  canonicalMailboxConfirmation: typeof CANONICAL_OPERATIONAL_MAILBOX;
}

export interface IntegrationSummary {
  key: IntegrationKey;
  label: string;
  configured: boolean;
  liveReady?: boolean;
  configurationSaved?: boolean;
  credentialConfigured?: boolean;
  runtimeSecretBound?: boolean;
  operationalReady?: boolean;
  runtimeEnabled?: boolean;
  public: Record<string, unknown>;
  secrets: Record<string, string>;
  requiredEnv?: Record<string, string>;
  updatedAt: string;
}

// Hosted runtime readiness is deliberately separate from the legacy `mode` field. The
// capability flags describe configuration binding only; they do not claim that a mailbox
// token or provider connection has been validated.
export type IntegrationRuntimeMode = "hosted_staging" | "production" | "emulator";

export interface IntegrationCapabilityStatus {
  configured: boolean;
  ready: boolean;
  code: string | null;
}

export interface IntegrationCapabilities {
  peoply: IntegrationCapabilityStatus & {
    code: "missing_key" | "invalid_base_url" | null;
  };
  mailOAuth: IntegrationCapabilityStatus & {
    code: "missing_client_id" | "missing_client_secret" | "missing_encryption_key" | "missing_redirect_uri" | "callback_mismatch" | "disabled_in_staging" | null;
    callbackUrl: string | null;
  };
  mailRouting: IntegrationCapabilityStatus & {
    code: "unavailable" | null;
  };
}

export interface GetIntegrationsEnvelope extends FluCallableEnvelope {
  ok: true;
  integrations: IntegrationSummary[];
  mailTransportProbe: MailTransportProbeStatus | null;
  mailProviderAttestation: MailProviderAttestationProjection | null;
  mode: string;
  runtimeMode?: IntegrationRuntimeMode;
  capabilities?: IntegrationCapabilities;
}

export interface UpdateIntegrationEnvelope extends FluCallableEnvelope {
  ok: true;
  integration: IntegrationSummary;
}

// AI-DRAMA-DISCOVERY-METAPROMPT W6 — Apify 캡챠 우회 연동 골격. functions/captchaSolverIntegration.ts
// mirror. Separate from IntegrationSummary above (integrations/default) — this is its own doc
// (integrations/captcha_solver) with array/cap fields the generic Definition-driven system doesn't
// model. 실제 actor 호출은 없다(골격만) — APIFY_API_KEY 미구매 상태에서도 enabled:false로 안전하다.
export interface CaptchaSolverIntegrationUsageToday {
  callCount: number;
  costUsd: number;
}

export interface CaptchaSolverIntegration {
  provider: "apify";
  enabled: boolean;
  allowedOrgIds: string[];
  actorId: string;
  dailyCallCap: number;
  dailyBudgetUsd: number;
  perJobCallCap: number;
  cacheTtlHours: number;
  updatedBy: string;
  updatedAt: string;
  runtimeSecretBound: boolean;
  requiredEnv: string;
  usageToday: CaptchaSolverIntegrationUsageToday;
}

export interface SetCaptchaSolverIntegrationPayload extends FluCallablePayload {
  enabled?: boolean;
  allowedOrgIds?: string[];
  actorId?: string;
  dailyCallCap?: number;
  dailyBudgetUsd?: number;
  perJobCallCap?: number;
  cacheTtlHours?: number;
}

export interface GetCaptchaSolverIntegrationEnvelope extends FluCallableEnvelope {
  ok: true;
  integration: CaptchaSolverIntegration;
}

export interface SetCaptchaSolverIntegrationEnvelope extends FluCallableEnvelope {
  ok: true;
  integration: CaptchaSolverIntegration;
}

// Peoply (사내 인명부, Supercent HR directory) — server-only read client. These types
// mirror the privacy-safe projections in functions/peoplyClient.ts; the raw upstream
// payload and the key never reach the client (SEC-P0-009 / SEC-P0-005).
export type PeoplyErrorKind =
  | "missing_key"
  | "invalid_base_url"
  | "forbidden"
  | "rate_limited"
  | "not_found"
  | "invalid_request"
  | "upstream"
  | "network";

export interface PeoplyErrorProjection {
  kind: PeoplyErrorKind;
  httpStatus: number | null;
  retryAfterSeconds: number | null;
  upstreamCode: string | null;
}

export interface PeoplyQuotaBucket {
  limit: number | null;
  used: number | null;
  remaining: number | null;
  resetsAt: string | null;
}

export interface PeoplyScopeRequest {
  status: string;
  createdAt: string | null;
  reviewedAt: string | null;
  additionalScopes: string[];
}

export interface PeoplyRateLimitRequest {
  status: string;
  createdAt: string | null;
  reviewedAt: string | null;
  rateLimitPerMinute: number | null;
  rateLimitPerDay: number | null;
}

export interface PeoplyKeyStatus {
  status: string;
  appName: string;
  scopes: string[];
  accessMode: string;
  expiresAt: string | null;
  daysRemaining: number | null;
  rateLimitPerMinute: number | null;
  rateLimitPerDay: number | null;
  quota: {
    minute: PeoplyQuotaBucket;
    day: PeoplyQuotaBucket;
  };
  scopeRequest: PeoplyScopeRequest | null;
  rateLimitRequest: PeoplyRateLimitRequest | null;
}

export interface PeoplyPerson {
  id: string;
  email: string;
  displayName: string;
  nickname: string;
  koreanName: string;
  department: string;
  title: string;
  jobName: string;
  status: string;
  primaryMembership: string;
  slackUserId: string | null;
}

export interface PeoplyMembership {
  orgId: string;
  organizationName: string;
  /** Peoply 0.15 returns the display hierarchy as one string. */
  organizationPath: string;
  title: string;
  role: string;
  source: string;
  purpose: string;
  primary: boolean;
  managerEmail: string | null;
}

export interface PeoplyPersonDetail {
  directoryUpdatedAt: string | null;
  employee: PeoplyPerson;
  memberships: PeoplyMembership[];
}

export interface PeoplyOrgLeader {
  email: string;
  displayName: string;
  leaderLevel: string;
  leaderLevelLabel: string;
}

export interface PeoplyOrganization {
  id: string;
  hrOrgCode: string | null;
  name: string;
  parentId: string | null;
  active: boolean;
  type: string;
  source: string;
  organizationLevel: string;
  organizationLevelLabel: string;
  leaders: PeoplyOrgLeader[];
}

export interface PeoplyWorkspaceGroup {
  email: string;
  name: string;
  description: string;
  directMemberCount: number;
}

export interface PeoplySnapshot<T> {
  directoryUpdatedAt: string | null;
  fetchedAtIso: string;
  cacheHit: boolean;
  items: T[];
}

export type PeoplyMembershipView = "effective" | "official";
export type PeoplySearchKind = "people" | "orgs" | "tfs" | "workspace-groups";

export interface GetPeoplyStatusEnvelope extends FluCallableEnvelope {
  ok: boolean;
  configured: boolean;
  integratedApiVersion: string;
  runtimeContractRevision?: string;
  status: PeoplyKeyStatus | null;
  peoplyError: PeoplyErrorProjection | null;
}

export interface SearchPeoplyDirectoryPayload extends FluCallablePayload {
  kind: PeoplySearchKind;
  q?: string;
  membershipView?: PeoplyMembershipView;
}

export type PeoplyDirectoryItem = PeoplyPerson | PeoplyOrganization | PeoplyWorkspaceGroup;

export interface SearchPeoplyDirectoryEnvelope extends FluCallableEnvelope {
  ok: boolean;
  kind: PeoplySearchKind;
  snapshot: PeoplySnapshot<PeoplyDirectoryItem> | null;
  peoplyError: PeoplyErrorProjection | null;
  runtimeContractRevision?: string;
}

export interface GetPeoplyPersonPayload extends FluCallablePayload {
  email: string;
}

export interface GetPeoplyPersonEnvelope extends FluCallableEnvelope {
  ok: boolean;
  detail: PeoplyPersonDetail | null;
  peoplyError: PeoplyErrorProjection | null;
  runtimeContractRevision?: string;
}

// mail_accounts / settings/mail_routing (PLAN-ORG-MAIL-IDENTITY Slice 1). These mirror the
// projections in functions/mailAccounts.ts; secretRef is never exposed, only its
// env/oauth/none prefix (secretRefKind) — SEC-P0-009.
export type MailAccountKind = "canonical_scp" | "workspace_oauth" | "external_smtp_imap";
export type MailAccountStatus = "active" | "disabled" | "pending_auth";

export interface MailAccountPublic {
  accountId: string;
  label: string;
  mailbox: string;
  kind: MailAccountKind;
  status: MailAccountStatus;
  ownerEmail: string;
  orgIds: string[];
  smtp: Record<string, unknown>;
  imap: Record<string, unknown>;
  secretRefKind: "env" | "oauth" | "none";
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

/** Server-authorized sender projection for the current signed-in user/team. This is deliberately
 * separate from the administrative mail_accounts inventory: an inventory row is not a send-as
 * grant. */
export type MailSenderBlockedReason =
  | "personal_connection_required"
  | "org_mail_account_unavailable"
  | string;

export type MailOrgResolutionStatus = "resolved" | "unresolved" | "directory_unavailable";

export interface MailRouting {
  defaultAccountId: string;
  byOrgId: Record<string, string>;
  /** Flu/Task-48: null = not yet configured (fail-open, no org restricted). A configured
   * (non-null) array is a strict allowlist of orgs that may self-connect a personal mailbox. */
  personalMailAllowedOrgIds: string[] | null;
  /** Flu/Task-48: orgs whose Chat first-time default view is the caller's own connected mailbox
   * instead of the org account (e.g. AI Drama). Empty = every org defaults to the org account. */
  chatPersonalViewDefaultOrgIds: string[];
  /** (scp 계정 배정 허용) null = not yet configured (fail-open, every org may resolve scp as its
   * org/default account — today's behavior). A configured (non-null) array is a strict allowlist
   * of orgs that may have scp resolved as their org/default mail account — writable only by a
   * super_admin (functions/mailAccountCallables.ts setMailRouting). */
  scpAllowedOrgIds: string[] | null;
  policyVersion: string;
  updatedBy: string;
  updatedAt: string;
}

export interface ListMailAccountsEnvelope extends FluCallableEnvelope {
  ok: true;
  accounts: MailAccountPublic[];
  routing: MailRouting;
}

export interface UpsertMailAccountPayload extends FluCallablePayload {
  accountId: string;
  label?: string;
  mailbox?: string;
  kind?: MailAccountKind;
  status?: MailAccountStatus;
  ownerEmail?: string;
  orgIds?: string[];
  smtp?: Record<string, unknown>;
  imap?: Record<string, unknown>;
  secretRef?: string;
}

export interface UpsertMailAccountEnvelope extends FluCallableEnvelope {
  ok: true;
  account: MailAccountPublic;
}

export interface SetMailRoutingPayload extends FluCallablePayload {
  defaultAccountId?: string;
  /** A null value removes that org's mapping (reverts it to the default account). */
  byOrgId?: Record<string, string | null>;
  /** Flu/Task-48: omit to keep the current value; null resets to "not configured" (fail-open);
   * an array (possibly empty) sets the strict allowlist. */
  personalMailAllowedOrgIds?: string[] | null;
  /** Flu/Task-48: omit to keep the current value; an array replaces it. */
  chatPersonalViewDefaultOrgIds?: string[];
  /** (scp 계정 배정 허용) omit to keep the current value; null resets to "not configured"
   * (fail-open); an array (possibly empty) sets the strict allowlist. Server-enforced
   * super_admin-only — an admin caller setting this field is rejected with permission-denied. */
  scpAllowedOrgIds?: string[] | null;
}

export interface SetMailRoutingEnvelope extends FluCallableEnvelope {
  ok: true;
  routing: MailRouting;
  /** Flu/Task-48: present only when turning personalMailAllowedOrgIds off for an org disabled at
   * least one existing self-connected account. */
  disabledAccountIds?: string[];
}

export interface ResolveMyMailAccountEnvelope extends FluCallableEnvelope {
  ok: true;
  account: MailAccountPublic | null;
  orgId: string | null;
  source: "user_linked" | "peoply" | "fallback";
  personalAccount?: MailAccountPublic | null;
  orgAccount?: MailAccountPublic | null;
  usableSenders?: MailAccountPublic[];
  defaultSenderId?: string | null;
  senderBlockedReason?: MailSenderBlockedReason | null;
  orgResolutionStatus?: MailOrgResolutionStatus;
}

// getMyOrgContext / setUserPreference (PLAN-ORG-MAIL-IDENTITY Slice 5 — org chip/filter for
// Chat, the admin console, and the dismissible "메일 연결(선택)" notice). No token/secret ever
// leaves the server here — accountMailbox/accountLabel are the only account fields surfaced.
export interface MyOrgContextEnvelope extends FluCallableEnvelope {
  ok: true;
  orgId: string | null;
  orgName: string | null;
  /** (scp 계정 배정 허용) null when orgAccountAssigned is false — this caller's org has no
   * assigned org mail account (scp excluded via settings/mail_routing.scpAllowedOrgIds and no
   * other org-mapped account). Never the actual scp label/mailbox in that case. */
  accountLabel: string | null;
  accountMailbox: string | null;
  /** (scp 계정 배정 허용) false when this caller has no assigned org mail account — accountLabel/
   * accountMailbox are null in that case. Always true while scpAllowedOrgIds is not configured
   * (null) — zero behavior change for every org until a super_admin sets it. */
  orgAccountAssigned: boolean;
  /** 2026-09-27 security fix: explicit server-computed entitlement flag for scp specifically.
   * Client UI that shows scp-only controls (mailbox selector entries, sender options, scp tabs)
   * must gate on this — or on accessibleAccounts/usableSenders already containing "scp" — never
   * re-derive scp visibility from role/orgId/navPreset client-side. False during a viewAs preview
   * of a member who was not themselves explicitly granted scp, even when the viewer is
   * super_admin. */
  scpAccessGranted: boolean;
  linked: boolean;
  mailConnectNoticeDismissed: boolean;
  /** Flu/Task-42: FLU_NAV keys this caller's org is restricted to, or null when unrestricted
   * (no admin-set preset for this org, or no resolved org at all — the current full tab set). */
  navPreset: string[] | null;
  /** Flu/Task-46 적대 리뷰 MEDIUM-1: 서버가 판정한 파트너 탭 데이터 소스 — navPreset이 있고
   * "scp"를 포함하지 않으면 "candidate_reply"(AI Drama), 그 외(프리셋 없음 = Growth 기본, 또는
   * "scp" 포함)는 전부 "scp". 클라이언트는 이 값을 그대로 분기에만 쓰고 직접 판정하지 않는다. */
  partnerDataSource: "scp" | "candidate_reply";
  /** Flu/Task-48: [Chat 계정 보기] 토글 — strict mailbox views the server authorizes for this
   * caller (own personal and explicitly mapped team accounts), token/secret-free. Pending or
   * disabled owned accounts may remain here so existing history stays visible while sending is
   * blocked. A global routing default is never synthesized into this list. */
  accessibleAccounts: MailAccountPublic[];
  /** The caller's own entitled personal mailbox view, including a pending/disabled record when
   * its existing history remains readable. This is separate from active sender usability. */
  personalAccount?: MailAccountPublic | null;
  /** The explicitly configured shared account mapped to this caller's team, if any, including an
   * unavailable record when its existing history remains readable. */
  orgAccount?: MailAccountPublic | null;
  /** Only active accounts the server authorizes this caller to use as an outbound sender. Never
   * derive this list from accessibleAccounts or the admin inventory. */
  usableSenders?: MailAccountPublic[];
  /** Server-selected initial sender from usableSenders. Null means the caller must remain blocked
   * until policy is resolved or a connection is made. */
  defaultSenderId?: string | null;
  /** Stable server reason for a blocked sender state; null/undefined means no policy block. */
  senderBlockedReason?: MailSenderBlockedReason | null;
  /** Server outcome for the Peoply team lookup used by sender policy. */
  orgResolutionStatus?: MailOrgResolutionStatus;
  /** Flu/Task-48: whether this caller's org currently allows a personal mailbox connection at
   * all — governs the "메일 연결(선택)" banner/connect button and the toggle's very existence. */
  personalMailConnectAllowed: boolean;
  /** Flu/Task-48: the resolved current Chat account view — the caller's last explicit choice if
   * still valid, else the org's configured default, else "org". Always "org" when the toggle
   * would be hidden (no linked account, or personalMailConnectAllowed is false). */
  chatMailAccountView: "personal" | "org";
  /** Flu/Task-48: the concrete mail_accounts id chatMailAccountView currently resolves to — pass
   * this straight through as mailAccountId to listConversations/listConversationMessages. */
  viewMailAccountId: string | null;
  /** Flu/Task-50 — present only when this response was computed for another user via
   * viewAsUserId/viewAsEmail (super_admin "대신 보기"). Drives the "OOO로 보는 중" banner; every
   * other field above is already that user's own projection when this is non-null. */
  viewingAs: { userId: string; email: string; orgName: string | null } | null;
}

// Flu/Task-50: super_admin-only "대신 보기" — both must be provided together (server rejects a
// partial pair and rejects any non-super_admin caller regardless of pairing).
export interface GetMyOrgContextPayload extends FluCallablePayload {
  viewAsUserId?: string;
  viewAsEmail?: string;
}

// getOrgTabPresets / setOrgTabPresets (Flu/Task-42, functions/orgTabPresets.ts) — org -> Flu tab
// preset mapping, same shape/merge semantics as settings/mail_routing above.
export interface OrgTabPresets {
  byOrgId: Record<string, string[]>;
  policyVersion: string;
  revision: number;
  updatedBy: string;
  updatedAt: string;
}

export interface GetOrgTabPresetsEnvelope extends FluCallableEnvelope {
  ok: true;
  presets: OrgTabPresets;
}

export interface SetOrgTabPresetsPayload extends FluCallablePayload {
  /** Required optimistic-concurrency token returned by getOrgTabPresets. */
  expectedRevision: number;
  /** A null value removes that org's tab preset (reverts it to the full FLU_NAV tab set). */
  byOrgId?: Record<string, string[] | null>;
}

export interface SetOrgTabPresetsEnvelope extends FluCallableEnvelope {
  ok: true;
  presets: OrgTabPresets;
}

export type UserPreferenceKey = "mailConnectNoticeDismissedAt" | "chatMailAccountView";

export interface SetUserPreferencePayload extends FluCallablePayload {
  key: UserPreferenceKey;
  value?: string;
}

export interface SetUserPreferenceEnvelope extends FluCallableEnvelope {
  ok: true;
  key: UserPreferenceKey;
  value: string;
}

// mail_oauth_credentials / mail_oauth_states (PLAN-ORG-MAIL-IDENTITY Slice 2, functions/
// mailOAuth.ts). Self-service: any signed-in non-guest may connect/check their OWN mailbox
// (self: true, or omit accountId); connecting or checking someone else's mailbox stays
// admin-only (beginMailOAuth) / manager+ (getMailOAuthStatus).
export interface BeginMailOAuthPayload extends FluCallablePayload {
  accountId?: string;
  self?: boolean;
}

export interface BeginMailOAuthEnvelope extends FluCallableEnvelope {
  ok: boolean;
  consentUrl?: string;
  accountId?: string;
  expiresAtIso?: string;
  error?: {
    kind: "not_configured" | "callback_mismatch" | "tenant_mismatch" | "account_not_found";
    code?: "missing_client_id" | "missing_client_secret" | "missing_encryption_key" | "missing_redirect_uri" | "callback_mismatch" | "disabled_in_staging" | "tenant_mismatch" | "account_not_found";
    message?: string;
  };
}

export type MailOAuthConnectionCheckStatus = "verified" | "reauth_required" | "unavailable";

/** Safe result of an explicit, no-send OAuth credential check. Tokens never cross this seam. */
export interface MailOAuthConnectionCheck {
  status: MailOAuthConnectionCheckStatus;
  checkedAt: string;
  reason?: string;
}

export interface RevokeMailOAuthPayload extends FluCallablePayload {
  accountId: string;
}

export interface RevokeMailOAuthEnvelope extends FluCallableEnvelope {
  ok: true;
  accountId: string;
}

export interface GetMailOAuthStatusPayload extends FluCallablePayload {
  accountId?: string;
  self?: boolean;
  /** Explicitly verify the caller's own OAuth credential without sending mail. */
  verifyConnection?: boolean;
}

export interface GetMailOAuthStatusEnvelope extends FluCallableEnvelope {
  ok: true;
  accountId: string | null;
  linked: boolean;
  subjectEmail: string | null;
  scopes: string[];
  linkedAt: string | null;
  expiresAt: string | null;
  status: "active" | "revoked" | null;
  /** Present only when verifyConnection was requested; never contains token material. */
  connectionCheck?: MailOAuthConnectionCheck;
}

// mail_backfill_jobs (PLAN-ORG-MAIL-IDENTITY Slice 4, functions/mailImapBackfill.ts). Owner or
// admin only — one active (queued/running) job per account at a time.
export type MailBackfillJobStatus = "queued" | "running" | "done" | "failed";

export interface MailBackfillJob {
  jobId: string;
  accountId: string;
  requestedBy: string;
  sinceIso: string;
  status: MailBackfillJobStatus;
  scannedUids: number;
  ingested: number;
  skippedDuplicates: number;
  lastUid: number;
  createdAt: string;
  updatedAt: string;
  errorCode?: string;
}

export interface StartMailBackfillPayload extends FluCallablePayload {
  accountId: string;
  /** 1-90, default 30. */
  days?: number;
}

export interface StartMailBackfillEnvelope extends FluCallableEnvelope {
  ok: true;
  jobId: string;
  accountId: string;
  status: "queued";
  sinceIso: string;
}

export interface GetMailBackfillStatusPayload extends FluCallablePayload {
  accountId: string;
}

export interface GetMailBackfillStatusEnvelope extends FluCallableEnvelope {
  ok: true;
  accountId: string;
  job: MailBackfillJob | null;
}

// Flu/Task-47 — admin-triggered rematch of unregistered personal-account Chat conversations
// against candidate_pool (functions/candidateRematch.ts). No arguments: there is a single global
// job — call again while `hasMore` is true to continue it.
export interface StartCandidateRematchEnvelope extends FluCallableEnvelope {
  ok: true;
  jobId: string;
  status: "running" | "done";
  scanned: number;
  matched: number;
  hasMore: boolean;
}

export type YouTubeAuthorizationStatus =
  | "NOT_CONFIGURED"
  | "AUTH_PENDING"
  | "AUTHORIZED"
  | "EXPIRED"
  | "REVOKED"
  | "ERROR";

export interface YouTubeAuthorizationConfiguration {
  mode: "external_api_login" | "viewer_fallback";
  callbackEnabled: boolean;
  callbackSecretReady: boolean;
  externalToolName: string;
  policyVersion: string;
  allowedScopes: string[];
  fallbackViewer: string;
}

export interface YouTubeAuthorizationConnection {
  id: string;
  programId: string;
  status: YouTubeAuthorizationStatus;
  authMode?: "external_api_login" | "viewer_fallback";
  providerAccountRef?: string;
  channelId: string;
  scopes: string[];
  requestedAt?: string;
  authorizedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  lastCheckedAt?: string;
  policyVersion?: string;
  programVersion?: string;
  errorCode?: string;
  needsReconnect: boolean;
  version?: number;
  updatedAtIso: string;
}

export interface YouTubeAuthorizationStatusEnvelope extends FluCallableEnvelope {
  configuration?: YouTubeAuthorizationConfiguration;
  summaryStatus?: YouTubeAuthorizationStatus;
  connections?: YouTubeAuthorizationConnection[];
}

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
  | "creatorComments";

export interface DatasetPayload extends FluCallablePayload {
  keys?: DatasetKey[];
  limit?: number;
  cursor?: string;
  cursors?: Partial<Record<DatasetKey, string>>;
}

export async function callFluCallable<TResponse = FluCallableEnvelope>(
  name: FluCallableName,
  payload: FluCallablePayload = {},
): Promise<TResponse> {
  if (typeof window === "undefined") {
    throw new Error(
      `Flu callable "${name}" must be invoked from a client interaction.`,
    );
  }

  const [{ httpsCallable }, { functions, getFluCallableName }] =
    await Promise.all([import("firebase/functions"), import("./firebase")]);
  const callable = httpsCallable<FluCallablePayload, TResponse>(
    functions,
    getFluCallableName(name),
  );
  const result = await callable(payload);
  return result.data;
}

// F2/F4 Manage application-management operator client wrappers (spec B §3.3-3.5,§7 / C §5).
// RBAC (manager+) + all invariants are enforced server-side; these are typed client bridges only.
export interface AssignApplicationManagementPayload extends FluCallablePayload {
  applicationId: string;
  programId?: string | null;
  campaignId?: string | null;
  reason: string;
  expectedRevision: number;
}
export interface EvaluateContentEligibilityPayload extends FluCallablePayload {
  applicationId: string;
  contentGrant?: {
    signed: boolean;
    unexpired: boolean;
    unrevoked: boolean;
  } | null;
  declaredPrimaryAudienceCountry?: string | null;
  bindingAcknowledged?: boolean;
}
export const listApplicationManageInbox = (
  payload: { limit?: number; filter?: "manage_inbox" | "qualification_human_review" } = {},
) =>
  callFluCallable<{ inbox: Array<Record<string, unknown>> }>(
    "listApplicationManageInbox",
    payload,
  );
export const assignApplicationManagement = (
  payload: AssignApplicationManagementPayload,
) =>
  callFluCallable<{
    applicationId: string;
    revision: number;
    currentCampaignId: string | null;
    classification: string;
  }>("assignApplicationManagement", payload);
export const applicationManagementKpi = () =>
  callFluCallable<{
    kpi: {
      perCampaign: Record<string, number>;
      crossCampaignTotal: number;
      unattributed: number;
      scanned: number;
      truncated: boolean;
    };
  }>("applicationManagementKpi", {});

// W91 [헤세 · 크리에이터 탭] P0: Flu 가 이미 가진 데이터(scp_application_management +
// scp_portal_creator_bindings)만으로 만든 읽기 전용 디렉터리. 실행 액션은 없다(Portal 딥링크만).
export type ScpCreatorDirectoryIdentity = {
  portalCreatorId: string | null;
  fluCreatorId: string | null;
  channelId: string | null;
  enrollmentId: string | null;
  programId: string | null;
};
export type ScpCreatorDirectoryBinding = {
  linked: boolean;
  fluCreatorId: string | null;
  partnerId: string | null;
  enrollmentId: string | null;
};
export type ScpCreatorDirectoryRow = {
  applicationId: string;
  classification: string;
  reasonCode: string | null;
  currentProgramId: string | null;
  currentCampaignId: string | null;
  submittedAtIso: string | null;
  revision: number;
  identity: ScpCreatorDirectoryIdentity;
  /** W104 스윕 자가신고 신원 — 해석된 크리에이터가 없는 행의 표시 신원 폴백. 없으면 null. */
  declaredIdentity?: {
    handle: string | null;
    name: string | null;
    country: string | null;
    category: string | null;
    channelUrl: string | null;
  } | null;
  creatorDisplayName: string | null;
  creatorHandle: string | null;
  binding: ScpCreatorDirectoryBinding;
  manageInboxPending: boolean;
};
export type ScpCreatorDirectoryEnvelope = {
  rows: ScpCreatorDirectoryRow[];
  scanned: number;
  truncated: boolean;
  generatedAtIso: string;
};
export const listScpCreatorDirectory = (payload: { limit?: number } = {}) =>
  callFluCallable<ScpCreatorDirectoryEnvelope>("listScpCreatorDirectory", payload);

// Flu/Task-37 [헤세 · 크리에이터 탭]: 승인됐지만 Flu ingest(대시보드 스냅샷) 성공 이력이 없는
// 계정 + 마지막 시도 결과·사유. 나머지 타입(행 shape·사유 enum)은 ./scpDashboardIngestGapData 에서
// 직접 import한다(ScpAutomationControlTower 가 scpAutomationControlData 를 쓰는 것과 동일 패턴).
export const listScpApprovedWithoutIngest = (payload: { limit?: number } = {}) =>
  callFluCallable<ScpApprovedWithoutIngestEnvelope>("listScpApprovedWithoutIngest", payload);

// W91 [헤세 · admin-bridge] P1/P2: Portal 실계정 조회 + operator-attributed CAS 커맨드.
// RBAC(manager+) + 서명·매핑·에러코드 전부 서버측(functions/scpAdminBridgeClient.ts,
// functions/scpAdminBridgeCallables.ts)에서 강제된다 — 아래는 타입이 붙은 클라이언트 브리지일 뿐이다.
export type ScpPortalCreatorProfile = {
  displayName?: string;
  channelUrl?: string;
  country?: string;
  language?: string;
};
export type ScpPortalCreatorApprovalApplication = {
  id: string;
  status: string;
  revision: number;
  loginRequested: boolean;
  programId?: string;
};
export type ScpPortalCreatorDataLink = {
  fluCreatorId?: string;
  partnerId?: string;
  enrollmentCount: number;
};
export type ScpPortalCreatorRow = {
  id: string;
  name?: string;
  emailMasked: string;
  status: string;
  role: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  loginRequestedAt?: string;
  portalReady: boolean;
  profile: ScpPortalCreatorProfile;
  audienceGeo?: Record<string, unknown>;
  approvalApplicationId?: string;
  approvalApplication?: ScpPortalCreatorApprovalApplication;
  dataLink: ScpPortalCreatorDataLink;
  /** 서버측 보강(channels.list, 24h 캐시). 조회 실패 시 부재 — UI 는 "—" 로 표기한다. */
  channelStats?: { subscriberCount: number; channelTitle?: string; channelCountry?: string };
};
export type ListScpPortalCreatorsResult =
  | { configured: false; rows: [] }
  | {
      configured: true;
      rows: ScpPortalCreatorRow[];
      nextCursor?: string;
      /** Task-52: set when a `limit` beyond one bridge page (>100) hit its cap before the bridge
       * ran out of pages — the handler already chained internally, so this is informational only. */
      truncated?: boolean;
      /** Task-52 (적대적 리뷰 P1-2): "cap"=500행 상한에 닿음(정상) vs "bridge_error"=페이지 도중
       * 브리지 실패로 일부만 모음(새로고침 여지 있음). truncated가 true일 때만 채워진다. */
      truncatedReason?: "cap" | "bridge_error";
      generatedAtIso: string;
    };
export const listScpPortalCreators = (
  payload: { cursor?: string; limit?: number; updatedSince?: string } = {},
) => callFluCallable<ListScpPortalCreatorsResult>("listScpPortalCreators", payload);

export type ScpPortalCreatorCommandName =
  | "application.start-review"
  | "application.approve"
  | "application.reject"
  | "creator.set-status"
  | "creator.set-notes"
  | "creator.data-link";
export interface ScpPortalCreatorCommandPayload extends FluCallablePayload {
  command: ScpPortalCreatorCommandName;
  targetId: string;
  expectedRevision?: number;
  expectedUpdatedAt?: string;
  params?: Record<string, unknown>;
}
export const scpPortalCreatorCommand = (payload: ScpPortalCreatorCommandPayload) =>
  callFluCallable<{ result: Record<string, unknown> }>("scpPortalCreatorCommand", payload);

export const evaluateContentEligibility = (
  payload: EvaluateContentEligibilityPayload,
) =>
  callFluCallable<{
    applicationId: string;
    eligible: boolean;
    blockedReasons: string[];
    impliesApproval: false;
    managedRecordFound: boolean;
  }>("evaluateContentEligibility", payload);
export const sendOnboardingTest = (payload: {
  applicationId: string;
  globalDefaultTemplateRef?: string;
  campaignOverrideTemplateRef?: string | null;
  programDefaultTemplateRef?: string | null;
}) =>
  callFluCallable<{
    enqueued: boolean;
    state: string;
    reason?: string;
    templateRef?: string;
  }>("sendOnboardingTest", payload);
export const transitionVideoReviewDecision = (payload: {
  submissionId: string;
  targetStatus:
    | "queued"
    | "in_review"
    | "changes_requested"
    | "human_review_required"
    | "rejected"
    | "approved";
  expectedRevision: number;
  expectedContentFingerprint?: string;
  expectedCanonicalProgramId?: string;
  expectedPolicyConfigHash?: string;
  decisionRef: string;
  reasonCode?: string | null;
  customerMessageCode?: string | null;
  /** W102: 건별 운영자 편집 문안(변경요청·반려 전용, 서버가 최종 검증·원장 기록). */
  operatorMessage?: string | null;
  /**
   * W121: 사유 태그 키(변경요청·반려 전용, 순서 = 메일 불릿 순서). 문장이 아니라 **키**만 보낸다 —
   * 크리에이터 문구는 서버 사전이 만든다(SEC-P0-009).
   */
  reasonTagKeys?: string[];
  notifyCreator?: boolean;
  evidence?: unknown[];
}) =>
  callFluCallable<{
    applied: boolean;
    idempotent: boolean;
    nextState: string;
    projectToFeed: boolean;
    requiresHumanReview: boolean;
    mailKind: string | null;
  }>("transitionVideoReviewDecision", payload);
/**
 * Task-94: manager+ operator undo of an AI-authored `rejected` decision (rejected ->
 * human_review_required). The server re-reads CAS fields itself — the client only supplies the
 * seq of the decision it means to undo (read off the row it is showing) + an optional note.
 */
export const undoVideoReviewDecision = (payload: {
  submissionId: string;
  expectedSeq: number;
  note?: string | null;
}) =>
  callFluCallable<{
    applied: boolean;
    idempotent: boolean;
    nextState: string;
  }>("undoVideoReviewDecision", payload);
export type ScpVideoReviewStateRow = {
  id: string;
  detailHydrated: boolean;
  videoSubmissionId: string;
  state: string;
  revision: number;
  contentFingerprint: string;
  canonicalProgramId: string;
  policyConfigHash: string;
  campaignId: string;
  fluCreatorId: string;
  youtubeUrl: string;
  youtubeVideoId: string;
  traceId: string;
  withdrawn: boolean;
  superseded: boolean;
  feedEligible: boolean;
  trackingEligible: boolean;
  lastTransitionSeq: number;
  updatedAtIso: string;
  sourceSubmissionId: string;
  mailPreview?: {
    targetStatus: "approved" | "changes_requested" | "rejected";
    mailKind:
      | "content_approved"
      | "content_changes_requested"
      | "content_rejected";
    recipientResolved: boolean;
    recipientMasked: string | null;
    subject: string;
    text: string;
    bodyFormat: "html" | "text";
    templateSource: "published" | "fallback";
    correctionLinkAvailable: boolean;
  } | null;
  media?: {
    playableUrl: string | null;
    thumbnailUrl: string | null;
    youtubeVideoId: string | null;
    title: string | null;
    // 제목 출처: YouTube 스냅샷이 확인해 준 값인지, 등록 시점 사내 라벨인지.
    titleSource?: "youtube_snapshot" | "ledger" | "none";
    /**
     * W120: 서버가 확인한 링크 가용성(videos.list 응답 유무). `unavailable` 은 비공개·삭제,
     * `unknown` 은 확인 실패다 — 확인 실패를 "영상 없음"으로 읽지 않는다.
     */
    availability?: "available" | "unavailable" | "unknown";
  };
  creator?:
    | { available: false; unavailableReason: string; channelUrl?: string | null }
    | {
        available: true;
        displayName: string;
        profileImageUrl: string | null;
        countryCode: string | null;
        emailMasked?: string | null;
        handle: string | null;
        /** 이름의 출처: creators 문서 / channelId 조인 / videos.channel. */
        displayNameSource?: "creator" | "channel_match" | "video_channel";
        /** 실제 UC… 채널 id 가 있을 때만. 이름이 안 붙어도 채널로는 갈 수 있다. */
        channelUrl?: string | null;
      };
  aiRecommendation?: {
    policy: Record<string, unknown> | null;
    frame: Record<string, unknown> | null;
    brand: Record<string, unknown> | null;
    engine: {
      engine: string | null;
      model: string | null;
      version: string | null;
    };
  } | null;
  /** W102: AI 사전판정 — 합격 확률(approvalProbability)을 검수 상세에 직관 표시. */
  aiJudge?: {
    verdict: string;
    disapprovalProbability: number;
    approvalProbability: number;
    decidedAtIso: string | null;
    modelId: string | null;
    policyVersion: string | null;
    /** W107 T5: rule IDs behind a decisive (canAutoReject) hard failure, if any. */
    hardFailRuleIds?: string[];
    /** W107 T5: closed rule-key constants for the same failures — never free text. */
    hardFailReasonCodes?: string[];
    /**
     * W121: 반려 메일 사유 태그 후보(failed·unknown 룰). closed 카탈로그 상수 + 파생 수치만이고,
     * `confidence` 는 **검수자 화면 전용**이다 — 크리에이터 메일에는 퍼센트가 나가지 않는다.
     */
    reasonTagCandidates?: Array<{
      ruleId: string;
      ruleKey: string;
      ruleName: string;
      status: "failed" | "unknown";
      confidence: number;
    }>;
  } | null;
  duplicateEvidence?: {
    count: number | null;
    members: Array<{ videoSubmissionId: string; fingerprint: string | null }>;
    fingerprint: string | null;
  } | null;
  voiceEvidence?: {
    authenticity: string | null;
    accent: string | null;
    language: string | null;
    confidence: number | null;
    engine: string | null;
    version: string | null;
  } | null;
  attributionContext?: Record<string, unknown>;
  reviewFacts?: {
    submittedAtIso: string | null;
    contentUploadedAtIso?: string | null;
    contentPublishedAtIso?: string | null;
    resubmittedAtIso: string | null;
    creatorEmailMasked: string | null;
    creatorCountryCode: string | null;
    d7Views: string | null;
    d7ViewsSource: string | null;
    expectedReward: {
      amountMinor: string;
      currency: string;
      source: string | null;
    } | null;
  };
  canonicalRevision?: {
    available: boolean;
    unavailableReason: string | null;
    portalProjectionRef: string | null;
    sourceSubmissionId: string | null;
    revision: number | null;
    sourceFingerprint: string | null;
    portalState: string | null;
    canonicalRefs?: Record<string, string | null>;
    portalProjection?: Record<string, unknown> | null;
  };
  decisionLedger?: Array<{
    seq: number | null;
    fromState: string | null;
    toState: string | null;
    atIso: string | null;
    revision: number | null;
    reasonCode: string | null;
    customerMessageCode: string | null;
    /** W102: 그 판정에서 실제 발송된 운영자 편집 문안(있을 때만). */
    operatorMessage?: string | null;
    decisionRef: string | null;
    /** Task-94: who made this decision — the undo button only targets an AI-authored row. */
    actorType?: "human" | "ai" | null;
  }>;
  /** Task-94: video.review.appeal 수신 시 서버가 세운다. 열려 있으면 큐에 "이의제기" 배지. */
  appeal?: {
    open: boolean;
    message?: string | null;
    submittedAtIso?: string | null;
    decisionSeq?: number | null;
  } | null;
  postDecisionStatus?: {
    callbackOutbox: {
      state: string;
      outboxId: string | null;
      deliveryState: string | null;
      attempts: number;
      nextAttemptAtIso: string | null;
      deadLetter: boolean;
      delivered: boolean;
      updatedAtIso?: string | null;
    };
    resultMailOutbox: {
      state: string;
      outboxId: string | null;
      deliveryState: string | null;
      attempts: number;
      nextAttemptAtIso: string | null;
      deadLetter: boolean;
      delivered: boolean;
      updatedAtIso?: string | null;
    };
    downstreamCallbackOutbox: {
      state: string;
      outboxId: string | null;
      deliveryState: string | null;
      attempts: number;
      nextAttemptAtIso: string | null;
      deadLetter: boolean;
      delivered: boolean;
      updatedAtIso?: string | null;
    };
    /**
     * W126: 결과 메일이 실패한 채로 남은 제출의 표식(서버 계약:
     * functions/videoReviewStateCallables ScpVideoReviewStateRow.postDecisionStatus.resultMailAlert).
     * 큐 목록에서만 채워지고, 실패가 없으면 null 이다.
     */
    resultMailAlert?: {
      deliveryState: "dead_letter" | "retryable_failed";
      outboxId: string;
    } | null;
    /**
     * Ack metadata for a dead-letter result-mail alert. Points to the exact acknowledged
     * outbox row even when the latest/current result-mail outbox differs.
     */
    resultMailAcknowledgement?: {
      outboxId: string;
      submissionId: string;
      acknowledged: true;
      acknowledgedAtIso: string | null;
      acknowledgedBy: string | null;
      acknowledgedByRole: string | null;
      acknowledgedReason: string | null;
    } | null;
    partnerActivation: {
      state: string;
      activationId: string | null;
      active: boolean;
      updatedAtIso?: string | null;
    };
    auditReceipt: {
      state: string;
      receiptId: string | null;
      eventId: string | null;
    };
  };
  evidence: Record<string, unknown> | null;
  reviewHistory: Record<string, unknown>[];
  /** W120: 이 제출의 판정 이력 요약(원장 집계) — 목록 행에도 실린다. */
  reviewHistorySummary?: {
    approvals: number;
    declines: number;
    lastDeclineReasonCode: string | null;
    repeatedReasonCode: string | null;
    repeatedReasonCount: number;
  };
  /** W120: 상세 전용 — 같은 영상의 다른 제출 반려 이력 + 크리에이터 단위 집계. */
  relatedHistory?: {
    sameVideoDeclines: Array<{
      videoSubmissionId: string;
      state: string;
      reasonCode: string | null;
      atIso: string | null;
    }>;
    creatorApproved: number;
    creatorDeclined: number;
    creatorRepeatedReasonCode: string | null;
    creatorRepeatedReasonCount: number;
    /** W120: 표본 크기와 상한 도달 여부 — 화면이 "N건"을 전수인 양 말하지 않게 한다(무순서 표본). */
    creatorScanned: number;
    creatorTruncated?: boolean;
    /** W126: 통지된 판정만 센 사유별 집계(에스컬레이션 계수 축). */
    creatorNotifiedDeclineReasonCounts?: Record<string, number>;
    /** W126: 이 제출이 표본 창(무순서·상한 50) 안에 있었는가 — 밖이면 드레인도 못 읽는다. */
    creatorSampleIncludesSelf?: boolean;
    sameVideoScanned?: number;
    sameVideoTruncated?: boolean;
  } | null;
  portalProjection: Record<string, unknown> | null;
};
export type ScpVideoReviewStatePage = {
  states: ScpVideoReviewStateRow[];
  nextCursor: string | null;
  resultMailAlertScan?: {
    status: "ok" | "incomplete" | "unavailable";
    scanned: number;
    limit: number;
    pages: number;
    reason?: string;
  } | null;
  counts: {
    action: number;
    changes_requested: number;
    approved: number;
    /** W102: 반려도 세는 축이 있어야 "반려하면 사라진다"는 체감이 없다. */
    rejected?: number;
    all: number;
    /**
     * E2 (2026-09-06 Aside 게이트 후속): 프로그램 필터가 걸리면 이 집계는 canonicalProgramId 가
     * 아직 포털 별칭(view-cpm)으로 남은 행을 세지 못한다 — false 면 배지는 하한값이다.
     */
    countsIncludeUnresolved?: boolean;
    /** E2: 배지엔 안 잡히지만 목록(states)에는 조인·합류되어 보이는 행 수. */
    portalAliasSplicedRowCount?: number;
    /**
     * 타이틀 필터가 걸린 응답이면 false — 이 집계는 필터 스코프를 모르는 프로그램/캠페인
     * 총계다. 필터 없는 요청에는 실리지 않는다.
     */
    titleFiltered?: boolean;
  } | null;
};
export const listScpVideoReviewStates = (
  payload: {
    limit?: number;
    cursor?: string;
    programId?: string;
    campaignId?: string;
    /** 다타이틀 서버 필터(task-88/89/90): 레지스트리 타이틀 id — 비어 있으면 필터 없음. */
    titleId?: string;
    detailId?: string;
    mailPreviewTarget?: "approved" | "changes_requested" | "rejected";
    mailPreviewReasonCode?: string | null;
    mailPreviewCustomerMessageCode?: string | null;
    /** W102: 운영자 편집 문안의 실시간 미리보기(발송 렌더러 read-only 통과). */
    mailPreviewMessage?: string | null;
    /** W121: 사유 태그 미리보기 — 실발송과 같은 서버 렌더를 타야 WYSIWYG 이 성립한다. */
    mailPreviewReasonTagKeys?: string[];
  } = {},
) =>
  callFluCallable<ScpVideoReviewStatePage>("listScpVideoReviewStates", payload);

export interface AcknowledgeVideoResultMailDeadLetterAlertPayload extends FluCallablePayload {
  outboxId: string;
  acknowledged: boolean;
  reason?: string;
}

export interface AcknowledgeVideoResultMailDeadLetterAlertEnvelope {
  ok: true;
  outboxId: string;
  submissionId: string;
  acknowledged: boolean;
  acknowledgedAtIso: string | null;
  behaviorLog?: unknown;
}

export const acknowledgeVideoResultMailDeadLetterAlert = (
  payload: AcknowledgeVideoResultMailDeadLetterAlertPayload,
) =>
  callFluCallable<AcknowledgeVideoResultMailDeadLetterAlertEnvelope>(
    "acknowledgeVideoResultMailDeadLetterAlert",
    payload,
  );

export const youtubeSearch = (payload: YoutubeSearchPayload) =>
  callFluCallable("youtubeSearch", payload);
export const emailFinder = (payload: EmailFinderPayload) =>
  callFluCallable("emailFinder", payload);
export const queueYtDlpDiscovery = (payload: QueueYtDlpDiscoveryPayload) =>
  callFluCallable<QueueYtDlpDiscoveryEnvelope>("queueYtDlpDiscovery", payload);
export const getDiscoveryRunStatus = (
  payload: FluCallablePayload & { runId: string },
) =>
  callFluCallable<DiscoveryRunStatusEnvelope>("getDiscoveryRunStatus", payload);
export const queueCommunityDiscovery = (
  payload: QueueCommunityDiscoveryPayload,
) => callFluCallable("queueCommunityDiscovery", payload);
export const recommendCreators = (payload: RecommendCreatorsPayload = {}) =>
  callFluCallable("recommendCreators", payload);

export const gatewayProxy = (payload: GatewayProxyPayload) =>
  callFluCallable("gatewayProxy", payload);
export const receiveEmail = (payload: ReceiveEmailPayload) =>
  callFluCallable("receiveEmail", payload);
export const sendEmail = (payload: SendEmailPayload) =>
  callFluCallable("sendEmail", payload);
export const markConversationRead = (payload: MarkConversationReadPayload) =>
  callFluCallable("markConversationRead", payload);
export const setConversationAutoReply = (payload: SetConversationAutoReplyPayload) =>
  callFluCallable<SetConversationAutoReplyEnvelope>("setConversationAutoReply", payload);
export const updateWorkflowItemState = (payload: WorkflowItemStatePayload) =>
  callFluCallable<WorkflowItemStateEnvelope>(
    "updateWorkflowItemState",
    payload,
  );

export const orchestrateCampaign = (payload: CampaignCallablePayload) =>
  callFluCallable("orchestrateCampaign", payload);
export const syncCampaignFunnel = (payload: CampaignCallablePayload) =>
  callFluCallable("syncCampaignFunnel", payload);
export const learnCampaignPriority = (payload: CampaignCallablePayload) =>
  callFluCallable("learnCampaignPriority", payload);
export const addCandidatesToCampaign = (
  payload: AddCandidatesToCampaignPayload,
) =>
  callFluCallable<AddCandidatesToCampaignEnvelope>(
    "addCandidatesToCampaign",
    payload,
  );
export const importCandidatesToCampaign = (
  payload: ImportCandidatesToCampaignPayload,
) =>
  callFluCallable<ImportCandidatesToCampaignEnvelope>(
    "importCandidatesToCampaign",
    payload,
  );
export const listCampaignCandidates = (
  payload: ListCampaignCandidatesPayload,
) =>
  callFluCallable<ListCampaignCandidatesEnvelope>(
    "listCampaignCandidates",
    payload,
  );
export const listCandidates = (payload: ListCandidatesPayload = {}) =>
  callFluCallable<ListCandidatesEnvelope>("listCandidates", payload);

// functions/aiDramaRelevance.ts listAiDramaRelevanceAudit mirror — the rejected/held channels an
// ai_drama discovery pass dropped, for the candidates page's "관련도 감사" panel.
export type AiDramaRelevanceAuditRow = {
  channelId: string;
  channelName: string;
  verdict: "rejected" | "held";
  scorePercent: number | null;
  reason: string;
  judgedAtIso: string;
};
export type ListAiDramaRelevanceAuditPayload = {
  campaignId: string;
  verdict?: "all" | "rejected" | "held";
};
export type ListAiDramaRelevanceAuditEnvelope = {
  ok: true;
  campaignId: string;
  rows: AiDramaRelevanceAuditRow[];
  hasMore: boolean;
};
export const listAiDramaRelevanceAudit = (payload: ListAiDramaRelevanceAuditPayload) =>
  callFluCallable<ListAiDramaRelevanceAuditEnvelope>("listAiDramaRelevanceAudit", payload);
export const sendCandidateColdMail = (payload: SendCandidateColdMailPayload) =>
  callFluCallable<SendCandidateColdMailEnvelope>("sendCandidateColdMail", payload);
export const updateCandidateRowState = (
  payload: UpdateCandidateRowStatePayload,
) =>
  callFluCallable<UpdateCandidateRowStateEnvelope>(
    "updateCandidateRowState",
    payload,
  );
export const setCandidateNudgeCadenceOverride = (
  payload: SetCandidateNudgeCadenceOverridePayload,
) =>
  callFluCallable<SetCandidateNudgeCadenceOverrideEnvelope>(
    "setCandidateNudgeCadenceOverride",
    payload,
  );
export const convertCandidateToPartner = (
  payload: ConvertCandidateToPartnerPayload,
) =>
  callFluCallable<ConvertCandidateToPartnerEnvelope>(
    "convertCandidateToPartner",
    payload,
  );
export const revertCandidatePartnerConversion = (
  payload: RevertCandidatePartnerConversionPayload,
) =>
  callFluCallable<RevertCandidatePartnerConversionEnvelope>(
    "revertCandidatePartnerConversion",
    payload,
  );
export const listCandidateReplyPartners = (
  payload: ListCandidateReplyPartnersPayload = {},
) =>
  callFluCallable<ListCandidateReplyPartnersEnvelope>(
    "listCandidateReplyPartners",
    payload,
  );

export const repairLegacyCandidateScopes = (
  payload: RepairLegacyCandidateScopesPayload = {},
) =>
  callFluCallable<RepairLegacyCandidateScopesEnvelope>(
    "repairLegacyCandidateScopes",
    payload,
  );

export const migrateCampaignCandidates = (
  payload: MigrateCampaignCandidatesPayload,
) =>
  callFluCallable<MigrateCampaignCandidatesEnvelope>(
    "migrateCampaignCandidates",
    payload,
  );

export const negotiateContract = (payload: ContractCallablePayload) =>
  callFluCallable("negotiateContract", payload);
export const createEscalation = (payload: ContractCallablePayload) =>
  callFluCallable("createEscalation", payload);
export const validateContractTemplate = (payload: ContractCallablePayload) =>
  callFluCallable("validateContractTemplate", payload);

export const submitFeedback = (payload: FeedbackCallablePayload) =>
  callFluCallable("submitFeedback", payload);
export const indexFeedbackKb = (payload: FeedbackCallablePayload) =>
  callFluCallable("indexFeedbackKb", payload);
export const retrieveFeedbackKb = (payload: RetrieveFeedbackKbPayload = {}) =>
  callFluCallable("retrieveFeedbackKb", payload);
export const queueFineTuneExample = (payload: FeedbackCallablePayload) =>
  callFluCallable("queueFineTuneExample", payload);
export const retryFeedbackGraphProjection = (
  payload: RetryFeedbackGraphProjectionPayload,
) => callFluCallable("retryFeedbackGraphProjection", payload);

export interface FeedbackGovernanceScope {
  version: "feedback-scope-v2";
  kind: "campaign" | "global";
  scopeKey: string;
  accountOwnerUid: string | null;
  programId: string | null;
  campaignId: string | null;
  locale: string;
}

export interface FeedbackKbGovernanceStatusEnvelope extends FluCallableEnvelope {
  ok: true;
  checkedAt: string;
  source: "firestore-aggregations";
  capabilities: {
    lexicalRetrieval: {
      status: "available";
      strategy: string;
      scopeContract: string;
      legacyUnscoped: "fail_closed";
    };
    vectorRetrieval: {
      status: "unavailable";
      reason: string;
      indexedDocuments: number;
    };
    knowledgeGraph: {
      status: "available" | "degraded";
      conflictResolution: string;
      durableProjectionOutbox: true;
      retryCallable: "retryFeedbackGraphProjection";
    };
    feedbackReview: {
      status: "available";
      transition: string;
      audit: string;
      piiRedaction: string;
    };
    fineTuneRelease: {
      status: "provider_configured" | "durable_outbox_only";
      durableOutbox: true;
      idempotency: string;
      integrationEnabled: boolean;
      endpointConfigured: boolean;
      projectKeyConfigured: boolean;
    };
  };
  counts: {
    feedback: {
      total: number;
      pending: number;
      approved: number;
      rejected: number;
    };
    knowledge: { activeEntries: number; pendingConflicts: number };
    fineTuneOutbox: {
      total: number;
      pending: number;
      retryable: number;
      sent: number;
      compensationRequired: number;
    };
    graphProjectionOutbox: {
      total: number;
      pending: number;
      processing: number;
      retryable: number;
      complete: number;
    };
  };
}

export const getFeedbackKbGovernanceStatus = () =>
  callFluCallable<FeedbackKbGovernanceStatusEnvelope>(
    "getFeedbackKbGovernanceStatus",
    {},
  );

// S9 kb_review 충돌 큐 UI.
export interface KbReviewQueueItem {
  id: string;
  nodeId: string;
  nodeRef: string;
  reason: string;
  status: string;
  revision: number;
  existing: Record<string, unknown>;
  incoming: Record<string, unknown>;
  governanceScope: FeedbackGovernanceScope | null;
  createdAtIso: string;
}
export interface KbReviewQueueEnvelope extends FluCallableEnvelope {
  items: KbReviewQueueItem[];
  total: number;
  pageInfo: {
    limit: number;
    returned: number;
    truncated: boolean;
    nextCursor: string | null;
  };
}
export interface ListKbReviewQueuePayload extends FluCallablePayload {
  limit?: number;
  cursor?: string;
}
export interface ResolveKbReviewPayload extends FluCallablePayload {
  reviewId: string;
  decision: "accept" | "keep";
  expectedRevision: number;
  transitionId: string;
}
export interface ResolveKbReviewEnvelope extends FluCallableEnvelope {
  status: "resolved";
  decision: "accept" | "keep";
  nodePath?: string;
  revision: number;
  resolutionEventRef: string;
  idempotent: boolean;
}
export const listKbReviewQueue = (payload: ListKbReviewQueuePayload = {}) =>
  callFluCallable<KbReviewQueueEnvelope>("listKbReviewQueue", payload);
export const resolveKbReview = (payload: ResolveKbReviewPayload) =>
  callFluCallable<ResolveKbReviewEnvelope>("resolveKbReview", payload);

// Manual-reply learning capture (functions/manualReplyLearning.ts) — settings toggle
// (default OFF, daily cap) + the one-shot backfill callable. Review itself reuses
// indexFeedbackKb above (implicit_manual_reply-tagged feedback entries).
export interface ManualReplyLearningSettings {
  enabled: boolean;
  dailyCap: number;
  updatedAtIso: string | null;
  updatedBy: string | null;
}
export interface ManualReplyLearningSettingsEnvelope extends FluCallableEnvelope {
  ok: true;
  settings: ManualReplyLearningSettings;
}
export interface UpdateManualReplyLearningSettingsPayload extends FluCallablePayload {
  enabled?: boolean;
  dailyCap?: number;
}
export const getManualReplyLearningSettings = () =>
  callFluCallable<ManualReplyLearningSettingsEnvelope>("getManualReplyLearningSettings", {});
export const updateManualReplyLearningSettings = (
  payload: UpdateManualReplyLearningSettingsPayload,
) => callFluCallable<ManualReplyLearningSettingsEnvelope>("updateManualReplyLearningSettings", payload);

export interface BackfillManualReplyLearningPayload extends FluCallablePayload {
  dryRun?: boolean;
  limit?: number;
}
export interface BackfillManualReplyLearningEnvelope extends FluCallableEnvelope {
  ok: true;
  dryRun: boolean;
  windowDays: number;
  limit: number;
  counts: {
    scanned: number;
    alreadyPaired: number;
    notReplyShaped: number;
    noInboundMatch: number;
    captured: number;
    skipped: number;
    errored: number;
  };
  preview: { sourceId: string; inboundSourceId: string }[];
}
export const backfillManualReplyLearningCandidates = (
  payload: BackfillManualReplyLearningPayload = {},
) => callFluCallable<BackfillManualReplyLearningEnvelope>("backfillManualReplyLearningCandidates", payload);

export const upsertCreator = (payload: UpsertCreatorPayload) =>
  callFluCallable("upsertCreator", payload);
export const transitionCreatorStage = (
  payload: TransitionCreatorStagePayload,
) => callFluCallable("transitionCreatorStage", payload);
export const syncChannelStats = (payload: SyncChannelStatsPayload) =>
  callFluCallable("syncChannelStats", payload);

export const updateReviewStatus = (payload: ReviewStatusPayload) =>
  callFluCallable("updateReviewStatus", payload);
export const recordPayment = (payload: RecordPaymentPayload) =>
  callFluCallable("recordPayment", payload);
export const syncReviewLedger = (payload: FluCallablePayload = {}) =>
  callFluCallable("syncReviewLedger", payload);

export const aggregateReport = (payload: ReportPayload = {}) =>
  callFluCallable("aggregateReport", payload);
export const listRawRecords = (payload: ReportPayload = {}) =>
  callFluCallable("listRawRecords", payload);
export const logCostUsage = (payload: RecordLlmUsagePayload) =>
  callFluCallable("logCostUsage", payload);
export const getReportDashboard = (payload: GetReportDashboardPayload) =>
  callFluCallable<ReportDashboardResponse>("getReportDashboard", payload);

export const setMemberRole = (payload: SetMemberRolePayload) =>
  callFluCallable("setMemberRole", payload);
export const setMemberMailAccountAccess = (payload: SetMemberMailAccountAccessPayload) =>
  callFluCallable<SetMemberMailAccountAccessEnvelope>("setMemberMailAccountAccess", payload);
export const inviteMember = (payload: InviteMemberPayload) =>
  callFluCallable("inviteMember", payload);
export const requestAccess = (payload: RequestAccessPayload = {}) =>
  callFluCallable<RequestAccessEnvelope>("requestAccess", payload);
export const logBehavior = (payload: BehaviorLogPayload) =>
  callFluCallable("logBehavior", payload);
export const recordLlmUsage = (payload: RecordLlmUsagePayload) =>
  callFluCallable("recordLlmUsage", payload);
export const createSeedData = (payload: SeedDataPayload = {}) =>
  callFluCallable("createSeedData", payload);
export const deleteSeedData = (payload: SeedDataPayload = {}) =>
  callFluCallable("deleteSeedData", payload);
export const updateAutoReply = (payload: AutoReplyPayload) =>
  callFluCallable("updateAutoReply", payload);
export const upsertTemplate = (payload: TemplatePayload) =>
  callFluCallable("upsertTemplate", payload);
export interface CreateCampaignPayload extends FluCallablePayload {
  name: string;
  programId?: string;
  discoveryVertical?: "game" | "ai_drama" | string;
  owner?: string;
  priority?: string;
  source?: string;
  total?: number;
  targetMetric?: string;
  targetValue?: number;
  gameId?: string;
  coldMail?: {
    subject: string;
    body: string;
    placeholders?: string[];
    preview?: string;
    sourceCountry?: string;
    bodyFormat?: MailBodyFormat;
    templateValues?: Record<string, string>;
    templateRevision?: string;
    trackingId?: string;
    draftRef?: string;
  };
  countryTargeting?: CountryTargeting;
  excludedCountries?: string[];
  targetCountries?: string[];
  targetCountryMix?: { country: string; weight: number }[];
  includeKeywords?: string[];
  excludeKeywords?: string[];
  targetingCriteria?: {
    discoveryVertical?: "game" | "ai_drama" | string;
    countryTargeting?: CountryTargeting;
    excludedCountries?: string[];
    targetCountries?: string[];
    targetCountryMix?: { country: string; weight: number }[];
    includeKeywords?: string[];
    excludeKeywords?: string[];
    categories?: string[];
    regions?: string[];
    minFollowers?: number;
    maxFollowers?: number;
    recentActivityDays?: number;
    minVideoViews?: number;
    minVideoCount?: number;
  };
  senderName?: string;
  sendSchedule?: string;
  mailProfile?: {
    enabled?: boolean;
    dryRun?: boolean;
    liveSend?: boolean;
    humanApprovalRequired?: boolean;
    maxDailySends?: number;
  };
  mailProfiles?: Record<string, unknown>;
  liveSendBatchId?: string;
  liveSendBatchCap?: number;
  maxLiveSendBatchSends?: number;
  /** TASK 3 automatic mode: the auto-approval sweep approves the whole queued wave (no manual 1–5 batch gate). */
  autoApproveLiveSend?: boolean;
  autoDiscoverNow?: boolean;
}
export const createCampaign = (payload: CreateCampaignPayload) =>
  callFluCallable("createCampaign", payload);

export interface ApproveCampaignOutreachPayload extends FluCallablePayload {
  programId: string;
  campaignId: string;
  outreachIds: string[];
  expectedVersion: number;
  confirmCount: number;
  sendAfterIso?: string;
}

export interface ApproveCampaignOutreachEnvelope extends FluCallableEnvelope {
  programId: string;
  campaignId: string;
  selectedCount: number;
  approvedCount: number;
  skipped: number;
  controlVersion: number;
}

export const approveCampaignOutreach = (
  payload: ApproveCampaignOutreachPayload,
) =>
  callFluCallable<ApproveCampaignOutreachEnvelope>(
    "approveCampaignOutreach",
    payload,
  );

export interface UpdateCampaignControlPayload extends FluCallablePayload {
  programId: string;
  campaignId: string;
  expectedVersion: number;
  targetMetric?: CampaignTargetMetric;
  targetValue?: number;
  outreachQuota?: number;
  priority?: Priority;
  operationalState?: CampaignOperationalState;
  name?: string;
  countryTargeting?: CountryTargeting;
  targetingCriteria?: {
    discoveryVertical?: "game" | "ai_drama" | string;
    countryTargeting?: CountryTargeting;
    excludedCountries?: string[];
    targetCountries?: string[];
    targetCountryMix?: { country: string; weight: number }[];
    includeKeywords?: string[];
    excludeKeywords?: string[];
    categories?: string[];
    regions?: string[];
    minFollowers?: number;
    maxFollowers?: number;
    recentActivityDays?: number;
    minVideoViews?: number;
    minVideoCount?: number;
  };
  allowInflyOverlap?: boolean;
  /** W41: 보관 토글 — 문서를 남긴 채 목록에서 감추고 실행 상태를 completed 로 닫는다. */
  archived?: boolean;
  /** W100: 누적 라이브 발송 상한 — super_admin 전용, 변경 시 liveSendCapReason(5자+) 필수. */
  liveSendCap?: number;
  liveSendCapReason?: string;
  /** daily-cap-fairness: 캠페인별 KST 일일 발송 상한. 0/미설정 = 전역 캡만(manager+ 누구나 설정). */
  dailyCap?: number;
}
export interface CampaignControlFields {
  targetMetric: CampaignTargetMetric;
  targetValue: number;
  outreachQuota: number;
  priority: Priority;
  operationalState: CampaignOperationalState;
  name: string;
  countryTargeting: CountryTargeting;
  effectiveCountryTargeting: CountryTargeting;
  targetingCriteria?: Record<string, unknown>;
  allowInflyOverlap: boolean;
  /** W100: 0 = 미설정(무상한). */
  liveSendCap: number;
  /** daily-cap-fairness: 0 = 미설정(전역 캡만). */
  dailyCap: number;
  controlVersion: number;
}
export interface UpdateCampaignControlEnvelope extends FluCallableEnvelope {
  programId: string;
  campaignId: string;
  controlVersion: number;
  committedCount: number;
  controls: CampaignControlFields;
  auditRef: string;
}
export const updateCampaignControl = (payload: UpdateCampaignControlPayload) =>
  callFluCallable<UpdateCampaignControlEnvelope>(
    "updateCampaignControl",
    payload,
  );

export interface CampaignOutreachApprovalQueueRow {
  id: string;
  recipientMasked: string;
  country: string;
  countryDecision: CountryDecision | null;
  createdAtIso: string;
  sendAfterIso: string;
  liveSend: boolean;
}
export interface ListCampaignOutreachApprovalQueueEnvelope extends FluCallableEnvelope {
  programId: string;
  campaignId: string;
  pendingCount: number;
  returnedCount: number;
  selectionLimit: number;
  controlVersion: number;
  rows: CampaignOutreachApprovalQueueRow[];
}
export const listCampaignOutreachApprovalQueue = (
  payload: FluCallablePayload & {
    programId: string;
    campaignId: string;
    limit?: number;
  },
) =>
  callFluCallable<ListCampaignOutreachApprovalQueueEnvelope>(
    "listCampaignOutreachApprovalQueue",
    payload,
  );

export interface PrepareProgramCampaignTargetsEnvelope extends FluCallableEnvelope {
  programId: string;
  requested: number;
  requestedBeforeKpiCap: number;
  remainingKpi: number;
  selected: number;
  prepared: number;
  existing: number;
  dryRun: boolean;
}
export const prepareProgramCampaignTargets = (
  payload: FluCallablePayload & {
    programId: string;
    total: number;
    dryRun?: boolean;
    targetScanLimit?: number;
    countryTargeting?: CountryTargeting;
    excludedCountries?: string[];
    includeKeywords?: string[];
    excludeKeywords?: string[];
    targetCountries?: string[];
    targetCountryMix?: { country: string; weight: number }[];
    keywordFallbackEnabled?: boolean;
    gameId?: string;
    mailProfile?: Record<string, unknown>;
  },
) =>
  callFluCallable<PrepareProgramCampaignTargetsEnvelope>(
    "prepareProgramCampaignTargets",
    payload,
  );

export interface AuditCampaignOutreachWaveEnvelope extends FluCallableEnvelope {
  programId: string;
  campaignId: string;
  totalRows: number;
  counts: Record<string, number>;
  uniqueRecipientCount: number;
  duplicateRecipientRows: number;
  programMismatches: number;
  dryRunRows: number;
  liveRows: number;
  rowHashes: Array<{
    rowIdHash: string;
    state: string;
    recipientHash: string;
    liveSend: boolean;
    dryRun: boolean;
  }>;
}
export const auditCampaignOutreachWave = (
  payload: FluCallablePayload & { programId: string; campaignId: string },
) =>
  callFluCallable<AuditCampaignOutreachWaveEnvelope>(
    "auditCampaignOutreachWave",
    payload,
  );

export type ProgramStatus = "draft" | "open" | "closed";
export type ProgramApplicationStatus =
  "pending" | "approved" | "rejected" | "hold";
export type ProgramKpiMetric =
  "applicants" | "approved" | "contracted" | "reviewed" | "live";
export type MailTemplateTone = "정중" | "간결" | "행사초대형";

export interface ProgramMailTemplate {
  tone: MailTemplateTone;
  contentTags: string[];
}

export interface ProgramLinkPayload {
  label: string;
  url: string;
}

export interface ProgramPayload extends FluCallablePayload {
  id?: string;
  programId?: string;
  slug?: string;
  title?: string;
  status?: ProgramStatus;
  brief?: string;
  gameTitle?: string;
  owner?: string;
  rewardKRW?: number;
  kpiMetric?: ProgramKpiMetric;
  kpiTarget?: number;
  tags?: string[];
  imageUrl?: string;
  discoveryVertical?: "game" | "ai_drama" | string;
  mailTemplate?: ProgramMailTemplate;
  countryTargeting?: CountryTargeting;
  targetCountries?: string[];
  excludedCountries?: string[];
  requiredLinks?: ProgramLinkPayload[];
  assetLinks?: ProgramLinkPayload[];
  submissionEndpoint?: ProgramLinkPayload;
  applicationEndpoint?: ProgramLinkPayload;
  qualificationPolicy?: Record<string, unknown>;
  qualificationConfig?: Record<string, unknown>;
  candidateCriteria?: Record<string, unknown>;
  eligibilityCriteria?: Record<string, unknown>;
  videoReviewPolicy?: Record<string, unknown>;
  videoReviewConfig?: Record<string, unknown>;
  programAi?: Record<string, unknown>;
  /** super_admin-only: stamp a specific Peoply org (and optional member) as this program's owner
   * instead of the caller's own resolved org. Server-verified in functions/accountOwnership.ts
   * resolveExplicitOwnershipAssignment; ignored/rejected for non-super_admin callers. */
  ownershipAssignment?: { orgId: string; personEmail?: string };
}

export interface CreateProgramEnvelope extends FluCallableEnvelope {
  program: Program;
}

export interface PublicProgramEnvelope extends FluCallableEnvelope {
  program: {
    id: string;
    slug: string;
    title: string;
    status: ProgramStatus;
    brief: string;
    gameTitle: string;
    rewardKRW: number;
    kpiMetric: ProgramKpiMetric;
    kpiTarget: number;
    tags: string[];
    publicApplyPath: string;
    requiredLinks?: ProgramLinkPayload[];
    assetLinks?: ProgramLinkPayload[];
    submissionEndpoint?: ProgramLinkPayload;
    applicationEndpoint?: ProgramLinkPayload;
    imageUrl?: string;
    mailTemplate?: ProgramMailTemplate;
  };
}

export interface ProgramApplicationPayload extends FluCallablePayload {
  id?: string;
  applicationId?: string;
  programId?: string;
  slug?: string;
  status?: ProgramApplicationStatus;
  reason?: string;
  name?: string;
  email?: string;
  handle?: string;
  youtubeUrl?: string;
  platform?: string;
  followers?: number;
  region?: string;
  category?: string;
  pitch?: string;
}

export interface InviteMemberPayload extends FluCallablePayload {
  email: string;
  name?: string;
  role?: Role;
  team?: string;
  gameId?: string;
}

export interface RequestAccessPayload extends FluCallablePayload {
  /** Server-only login/session bootstrap mode; identity comes from Admin Auth. */
  bootstrap?: boolean;
  email?: string | null;
  displayName?: string | null;
  photoURL?: string | null;
  teamHint?: string;
  source?: string;
}

export interface RequestAccessEnvelope extends FluCallableEnvelope {
  status?: "pending" | "active" | "blocked_domain";
  member?: Record<string, unknown>;
  accessRequest?: Record<string, unknown>;
}

export interface SetMemberRolePayload extends FluCallablePayload {
  uid?: string;
  memberId?: string;
  role: Role;
  team?: string;
  status?: "active" | "pending";
  gameId?: string;
}

export interface SetMemberMailAccountAccessPayload extends FluCallablePayload {
  uid?: string;
  memberId?: string;
  mailAccountIds: string[];
}

export interface SetMemberMailAccountAccessEnvelope extends FluCallableEnvelope {
  ok: true;
  uid: string;
  mailAccountIds: string[];
  behaviorLog?: Record<string, unknown>;
}

export const createProgram = (payload: ProgramPayload) =>
  callFluCallable<CreateProgramEnvelope>("createProgram", payload);
export const getPublicProgram = (payload: ProgramPayload) =>
  callFluCallable<PublicProgramEnvelope>("getPublicProgram", payload);
export const submitProgramApplication = (payload: ProgramApplicationPayload) =>
  callFluCallable("submitProgramApplication", payload);
export const reviewProgramApplication = (payload: ProgramApplicationPayload) =>
  callFluCallable("reviewProgramApplication", payload);
export const syncProgramWorkflow = (payload: ProgramPayload) =>
  callFluCallable("syncProgramWorkflow", payload);

export interface ProgramColdMailTemplateInput {
  subject: string;
  body: string;
  sourceCountry: string;
  targetCountries: string[];
  // "html"이면 원문 HTML을 마크다운 변환 없이 그대로 발송(국가별 자동번역 비활성화). 기본 "markdown".
  bodyFormat?: MailBodyFormat;
}

export interface ProgramColdMailPreview {
  subject: string;
  body: string;
  text?: string;
  artifact?: PreviewEmailDraftArtifact;
  missingPlaceholders: string[];
  values?: Record<string, string>;
}

export interface UpdateProgramColdMailPayload
  extends FluCallablePayload, Partial<ProgramColdMailTemplateInput> {
  programId: string;
  useDefault?: boolean;
  dryRun?: boolean;
  expectedVersion?: number;
  expectedHash?: string;
  previewValues?: Record<string, string>;
}

export interface UpdateProgramColdMailEnvelope extends FluCallableEnvelope {
  ok: true;
  dryRun: boolean;
  sideEffects?: "none";
  applied?: boolean;
  noop?: boolean;
  noopReason?: "identical_content";
  localizedInvalidated?: boolean;
  programId: string;
  coldMail: ProgramColdMailTemplateInput & {
    version?: number;
    contentHash?: string;
  };
  preview: ProgramColdMailPreview;
  contentHash: string;
  currentHash?: string;
  currentVersion?: number;
  previousHash?: string;
  previousVersion?: number;
  version?: number;
  auditRef?: string | null;
  validation?: {
    valid?: boolean;
    placeholders?: string[];
    missingPlaceholders?: string[];
    [key: string]: unknown;
  };
}

export interface LocalizeProgramMailTemplatePayload extends FluCallablePayload {
  programId: string;
}

export interface LocalizeProgramMailTemplateEnvelope extends FluCallableEnvelope {
  ok: true;
  programId: string;
  sourceHash: string;
  sourceVersion: number;
  translated: string[];
  skipped: string[];
  discarded: string[];
}

export const updateProgramColdMail = (payload: UpdateProgramColdMailPayload) =>
  callFluCallable<UpdateProgramColdMailEnvelope>(
    "updateProgramColdMail",
    payload,
  );
export const localizeProgramMailTemplate = (
  payload: LocalizeProgramMailTemplatePayload,
) =>
  callFluCallable<LocalizeProgramMailTemplateEnvelope>(
    "localizeProgramMailTemplate",
    payload,
  );

// ── 이메일 발송 모드(연습/실발송) 게이트 ────────────────────────────────────
// 모든 메일은 샌드박스 모드로만 기록한다. 실 SMTP/IMAP 전환은 별도 승인 전까지 비활성화한다.
export interface EmailModeOutboundLock {
  status: string | null;
  reason: string | null;
  ruleId: string | null;
  /** Outreach lane audit fields. Legacy rows without manualPauseUpdatedAtIso report null. */
  updatedBy: string | null;
  updatedAtIso: string | null;
  /** W118: 자동 하드락 해제 시각. 값이 있고 미래면 레인 토글과 무관하게 전 레인이 막힌다. */
  blockedUntilIso?: string | null;
  /** W118: 독려 레인 토글의 마지막 변경자·시각(아웃리치와 별도로 기록된다). */
  nudgeUpdatedBy?: string | null;
  nudgeUpdatedAtIso?: string | null;
}
export type EmailModeCountState =
  | { state: "available"; value: number; updatedAtIso?: string }
  | { state: "unavailable"; errorCode: string };
export interface EmailModeMailAdminConstraint {
  key: string;
  label: string;
  value: number | null;
  state: "available" | "unavailable";
}
export interface EmailModeMailAdminStatus {
  observedAtIso: string;
  resets: {
    kstOutreachDayResetIso: string;
    utcQuotaDayResetIso: string;
    utcQuotaHourResetIso: string;
    utcQuotaWeekResetIso: string;
  };
  coldOutreach: {
    todaySent: EmailModeCountState;
    dailyCap: number;
    rampDailyCap: number;
    effectiveDailyCap: number;
    remainingToday: EmailModeCountState;
  };
  approvedQueue: {
    count: number;
    truncated: boolean;
    sample: Array<{
      idHash: string;
      campaignId: string;
      programId: string;
      deliveryState?: string;
      approvedAtIso?: string;
      sendAfterIso?: string;
    }>;
  };
  providerQuota: {
    daily: { cap: number; sent: EmailModeCountState; remainingAtNextKstDay: EmailModeCountState };
    hourly: { cap: number; sent: EmailModeCountState; remainingAtNextKstDay: EmailModeCountState };
    uniqueRecipients: { cap: number; remainingAtNextKstDay: EmailModeCountState };
    weekly: { cap: number; used: EmailModeCountState; remainingAtNextKstDay: EmailModeCountState };
    globalDaily: { cap: number; sent: EmailModeCountState; remainingAtNextKstDay: EmailModeCountState };
  };
  nudge: {
    totalDailyCap: number | null;
    usedToday: EmailModeCountState;
    cohortDailyCaps: Record<string, number>;
    cohortDailyCapTotal: number;
  };
  configuredDailyCombinedCap: {
    value: number | null;
    guaranteed: false;
    note: string;
  };
  tomorrowPotentialUpperBound: {
    value: number | null;
    guaranteed: false;
    note: string;
    constraints: EmailModeMailAdminConstraint[];
  };
}
export interface EmailModeEnvelope extends FluCallableEnvelope {
  practiceMode: boolean;
  outreachSendingEnabled: boolean;
  /** W118: 독려(재촉) 메일 레인 스위치. 1차 콜드메일 스위치와 독립이다. */
  nudgeSendingEnabled?: boolean;
  /** 서버 정본의 모든 메일 합산 일일 상한. 구버전 서버는 값을 안 줄 수 있다. */
  globalDailyTotalCap?: number | null;
  outboundLock?: EmailModeOutboundLock;
  mailAdminStatus?: EmailModeMailAdminStatus;
  mailAdminStatusError?: { errorCode: string };
}
export interface SetEmailModePayload extends FluCallablePayload {
  practiceMode?: boolean;
  outreachSendingEnabled?: boolean;
  nudgeSendingEnabled?: boolean;
}
export const getEmailMode = () =>
  callFluCallable<EmailModeEnvelope>("getEmailMode");
export const setEmailMode = (payload: SetEmailModePayload) =>
  callFluCallable<EmailModeEnvelope>("setEmailMode", payload);

// ── 읽기 데이터셋 (getDataset) ──────────────────────────────────────────────
export interface DatasetPageInfo {
  limit: number;
  truncated: boolean;
  nextCursor: string | null;
  otherProgramCount?: number;
}

// 화면 렌더용 컬렉션 묶음. 클라이언트는 Firestore 직접 read 금지(SEC-P0-004) → 이 callable만 경유.
export interface DatasetBundle {
  ok: true;
  seeded: boolean;
  loadedKeys?: DatasetKey[];
  datasetContract?: {
    version: "get-dataset-v2";
    runtimeEnvironment: "production" | "staging" | "emulator";
  };
  cache?: {
    generatedAtIso: string;
    maxAgeSeconds: number;
    requestedKeys: DatasetKey[];
  };
  counts: Record<string, number>;
  pageInfo: Record<string, DatasetPageInfo>;
  loadErrors?: Partial<Record<DatasetKey | "bundle", string>>;
  partialLoadError?: string;
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
  feedDiscoveryState: Record<string, unknown>[];
  members: Record<string, unknown>[];
  llmUsage: Record<string, unknown>[];
  communityPosts: Record<string, unknown>[];
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
}
export const getDataset = (payload: DatasetPayload = {}) =>
  callFluCallable<DatasetBundle>("getDataset", payload);

export interface DashboardPipelineProjectionPayload extends FluCallablePayload {
  limit?: number;
  applicationCursor?: string;
  leadCursor?: string;
  creatorCursor?: string;
  conversationCursor?: string;
  // Flu conversation org-filter round 4 (codex adversarial review round 2, finding #3): without
  // these, a super_admin's viewAs preview of a restricted member showed the caller's OWN full scp
  // conversations lane instead of narrowing to the target's real, restricted scope
  // (functions/dashboardPipelineProjection.ts resolveViewAsTarget).
  viewAsUserId?: string;
  viewAsEmail?: string;
}

export interface DashboardPipelineProjectionPageInfo {
  limit: number;
  returned: number;
  scanned: number;
  hasMore: boolean;
  truncated: boolean;
  nextCursor: string | null;
}

export interface DashboardPipelineProjectionEnvelope extends FluCallableEnvelope {
  ok: true;
  generatedAtIso: string;
  ordering: "updated_at_iso_desc_document_id_asc";
  applications: DashboardProgramApplication[];
  programSheetLeads: DashboardProgramSheetLead[];
  creators: Creator[];
  conversations: Conversation[];
  pageInfo: {
    applications: DashboardPipelineProjectionPageInfo;
    programSheetLeads: DashboardPipelineProjectionPageInfo;
    creators: DashboardPipelineProjectionPageInfo;
    conversations: DashboardPipelineProjectionPageInfo;
  };
  performance: {
    queryCount: number;
    perRowReads: 0;
    documentReads: number;
    documentReadUpperBound: number;
    durationMs: number;
  };
}

export const getDashboardPipelineProjection = (
  payload: DashboardPipelineProjectionPayload = {},
) =>
  callFluCallable<DashboardPipelineProjectionEnvelope>(
    "getDashboardPipelineProjection",
    payload,
  );

export type ScpProgramFunnelCanonicalStage =
  | "sent"
  | "sheetLeads"
  | "responded"
  | "passed"
  | "oneLinkSent"
  | "videoSubmitted"
  | "approved"
  | "paid";

export interface ScpProgramFunnelPersonSample {
  key: string;
  programId: string;
  name: string;
  email: string;
  emailMasked: string;
  handle: string;
  creatorId: string;
  stages: Record<ScpProgramFunnelCanonicalStage, boolean>;
  evidenceRefs: Record<ScpProgramFunnelCanonicalStage, string[]>;
  updatedAtIso: string;
}

export interface ScpProgramFunnelAggregateRow {
  programId: string;
  counts: Record<ScpProgramFunnelCanonicalStage, number>;
  evidenceRefs: Record<ScpProgramFunnelCanonicalStage, string[]>;
  people: ScpProgramFunnelPersonSample[];
}

export interface ScpProgramFunnelAggregateEnvelope extends FluCallableEnvelope {
  ok: true;
  generatedAtIso: string;
  scanned: Record<string, number>;
  aggregates: ScpProgramFunnelAggregateRow[];
}

export const aggregateScpProgramFunnel = (
  payload: FluCallablePayload & { programIds?: string[] } = {},
) =>
  callFluCallable<ScpProgramFunnelAggregateEnvelope>(
    "aggregateScpProgramFunnel",
    payload,
  );

export interface ProgramRegistryReconcilePayload extends FluCallablePayload {
  dryRun?: boolean;
  actual?: boolean;
  scope?: "global" | `manager:${string}`;
  confirmationToken?: string;
  aliasConfirmations?: Array<{ proposalId: string }>;
}

export interface ProgramRegistryReconcileEnvelope extends FluCallableEnvelope {
  ok: true;
  dryRun: boolean;
  actual: boolean;
  written: boolean;
  idempotent?: boolean;
  scope: "global" | `manager:${string}`;
  idempotencyKey: string;
  confirmationToken: string;
  sourceStateHash: string;
  ambiguousProposals: Array<{
    proposalId: string;
    alias: string;
    canonicalProgramId: string;
    aliasSourceRef: string;
    canonicalSourceRef: string;
    evidenceType: "immutable_slug_owner" | "title_only_ambiguous";
    reason:
      | "same_slug_same_owner_requires_admin_confirmation"
      | "title_only_requires_external_evidence";
    mergeEligible: boolean;
    status: "human_gate";
    sourceRevisionHash: string;
  }>;
  duplicateGroups: Array<{
    canonicalProgramId: string;
    aliases: string[];
    legacyProgramIds: string[];
    sourceRefs: string[];
    mergedCounts: Record<string, number>;
  }>;
  proposedRegistryWrites: ProgramRegistryDoc[];
  proposedAliasWrites: ProgramAliasDoc[];
  affectedCollections: Record<string, number>;
}

export const reconcileProgramRegistry = (
  payload: ProgramRegistryReconcilePayload = {},
) =>
  callFluCallable<ProgramRegistryReconcileEnvelope>(
    "reconcileProgramRegistry",
    payload,
  );

export interface SyncGoogleSheetIntakePayload extends FluCallablePayload {
  sourceKey?: SheetSourceKey;
  spreadsheetId?: string;
  tabName?: string;
  startRow?: number;
  rows?: Array<Record<string, unknown> | unknown[]>;
  dryRun?: boolean;
  actual?: boolean;
  confirm?: string;
  previewToken?: string;
  expectedSourceVersion?: number;
}

export interface SyncGoogleSheetIntakeEnvelope extends FluCallableEnvelope {
  ok: true;
  sourceKey: SheetSourceKey | "staging_fixture";
  runRef: string;
  mode: "dry_run" | "emulator_write" | "staging_write" | "production_write";
  readMode: "input_rows" | "sheets_api";
  status: "success" | "blocked" | "error" | "conflict";
  startRow: number;
  rowCount: number;
  sourceVersion: number;
  originFingerprint: string;
  schemaFingerprint: string;
  insertedRawRows: number;
  duplicateRawRows: number;
  normalizedLeadCount: number;
  rawRowCount: number;
  leadCount: number;
  canApply?: boolean;
  previewToken?: string;
  previewExpiresAtIso?: string;
  planFingerprint?: string;
  confirmation?: string;
  businessWritesApplied?: boolean;
  idempotentReplay?: boolean;
}
export const syncGoogleSheetIntake = (
  payload: SyncGoogleSheetIntakePayload = {},
) =>
  callFluCallable<SyncGoogleSheetIntakeEnvelope>(
    "syncGoogleSheetIntake",
    payload,
  );

export type SheetCutoverState =
  "shadow" | "dual_read" | "primary" | "rollbackable_primary" | "retired";
export type SheetSourceKey =
  | "scp_apply"
  | "participant_selection"
  | "participant_registry"
  | "content_review";
export interface PublicSheetCutoverRecord {
  state: SheetCutoverState;
  version: number;
  ownerHash?: string | null;
  enteredAtIso?: string | null;
  updatedAtIso: string | null;
  targetExitAt: string | null;
  rollbackCheckpoint: SheetCutoverState | null;
  lastRollbackAtIso?: string | null;
}
export interface PublicSheetOperationCapability {
  supported: boolean;
  engine: "generic_intake" | "participant_roster" | "video_submission_bridge";
  controlPlane: "generic" | "dedicated";
  genericCallableSupported: boolean;
  requiresPreview: true;
  reason?: string | null;
}
export interface PublicSheetIntakeSourceStatus {
  key: SheetSourceKey;
  displayName: string;
  domain: SheetSourceKey;
  projectionStrategy:
    | "applicant_projection"
    | "participant_registry_projection"
    | "video_submission_bridge";
  syncSupported: boolean;
  sourceReady: boolean;
  sourceVersion: number;
  reconciliationVersion: number;
  projectionRevision: number;
  lastSyncStatus: string | null;
  lastSyncAtIso: string | null;
  publicProjection: {
    datasetKey: "scpQualificationRows" | "scpVideoRows" | null;
    ready: boolean;
    generation: number;
    rowCount: number;
    completedAtIso: string | null;
  };
  cutover: PublicSheetCutoverRecord;
  operations: {
    manualSync: PublicSheetOperationCapability & {
      schedulerManaged?: boolean;
    };
    reconciliation: PublicSheetOperationCapability;
    cutover: PublicSheetOperationCapability & {
      allowedTargets?: SheetCutoverState[];
      allowedTargetStates?: SheetCutoverState[];
    };
  };
}
export interface GoogleSheetIntakeStatusEnvelope extends FluCallableEnvelope {
  ok: true;
  topologyVersion: string;
  sourceCount: number;
  sources: PublicSheetIntakeSourceStatus[];
}
export const getGoogleSheetIntakeStatus = (payload: FluCallablePayload = {}) =>
  callFluCallable<GoogleSheetIntakeStatusEnvelope>(
    "getGoogleSheetIntakeStatus",
    payload,
  );
export interface SheetIntakeControlPayload extends FluCallablePayload {
  sourceKey?: SheetSourceKey;
  sourceId?: string;
  expectedVersion: number;
  dryRun?: boolean;
  actual?: boolean;
  previewToken?: string;
  confirm?: string;
}
export interface ReconcileGoogleSheetIntakeEnvelope extends FluCallableEnvelope {
  ok: true;
  sourceKey: SheetSourceKey | "staging_fixture";
  runId: string;
  mode: "preview" | "actual";
  counts: {
    missing: number;
    extra: number;
    stale: number;
    conflict: number;
    activeCurrent: number;
    rowMoved: number;
  };
  observedRows?: number;
  parityEligible?: boolean;
  masked: true;
  previewToken?: string;
  previewExpiresAtIso?: string;
  confirmation?: string;
  businessWritesApplied: boolean;
  idempotentReplay: boolean;
  auditRef?: string;
}
export interface UpdateGoogleSheetIntakeCutoverPayload extends SheetIntakeControlPayload {
  targetState: SheetCutoverState;
  targetExitAt?: string | null;
  rollbackCheckpoint?: SheetCutoverState | null;
}
export interface UpdateGoogleSheetIntakeCutoverEnvelope extends FluCallableEnvelope {
  ok: true;
  sourceKey: SheetSourceKey | "staging_fixture";
  mode: "preview" | "actual";
  current?: PublicSheetCutoverRecord;
  targetState?: SheetCutoverState;
  planned?: {
    rollbackCheckpoint: SheetCutoverState | null;
    targetExitAt: string | null;
    isRollback: boolean;
  };
  state?: SheetCutoverState;
  version?: number;
  enteredAtIso?: string;
  updatedAtIso?: string;
  targetExitAt?: string | null;
  rollbackCheckpoint?: SheetCutoverState | null;
  lastRollbackAtIso?: string | null;
  previewToken?: string;
  previewExpiresAtIso?: string;
  confirmation?: string;
  businessWritesApplied: boolean;
  idempotentReplay: boolean;
  auditRef?: string;
}
export const reconcileGoogleSheetIntake = (
  payload: SheetIntakeControlPayload,
) =>
  callFluCallable<ReconcileGoogleSheetIntakeEnvelope>(
    "reconcileGoogleSheetIntake",
    payload,
  );
export const updateGoogleSheetIntakeCutover = (
  payload: UpdateGoogleSheetIntakeCutoverPayload,
) =>
  callFluCallable<UpdateGoogleSheetIntakeCutoverEnvelope>(
    "updateGoogleSheetIntakeCutover",
    payload,
  );

export interface SyncParticipantRosterPayload extends FluCallablePayload {
  dryRun?: boolean;
  actual?: boolean;
  confirm?: string;
  previewToken?: string;
  expectedSourceVersion?: number;
  expectedProjectionVersion?: number;
  expectedCutoverVersion?: number;
  targetCutoverState?: SheetCutoverState;
}

export interface SyncParticipantRosterEnvelope extends FluCallableEnvelope {
  ok: true;
  dryRun: boolean;
  schemaVersion: string;
  canonicalProgramId: string;
  sourceVersion: number;
  projectionVersion: number;
  metrics: {
    primaryCount: number;
    currentMaterializedCount: number;
    estimatedMaterializedCount: number;
    upsertCount: number;
    retainedAbsentCount: number;
  };
  parity: {
    status: "match" | "mismatch" | "unavailable";
    primaryCount: number;
    legacyCount: number | null;
    matchingCount: number;
    changedCount: number;
    primaryOnlyCount: number;
    legacyOnlyCount: number;
  };
  cutover: PublicSheetCutoverRecord;
  expectedSourceVersion?: number;
  expectedProjectionVersion?: number;
  expectedCutoverVersion?: number;
  previewToken?: string;
  previewExpiresAtIso?: string;
  confirmation?: string;
  canApply?: boolean;
  appliedCount?: number;
  retainedAbsentCount: number;
  idempotent: boolean;
  businessWritesApplied: boolean;
  idempotentReplay: boolean;
}

export const syncParticipantRoster = (
  payload: SyncParticipantRosterPayload = {},
) =>
  callFluCallable<SyncParticipantRosterEnvelope>(
    "syncParticipantRoster",
    payload,
  );

export interface RunSheet3SubmissionBridgePayload extends FluCallablePayload {
  dryRun?: boolean;
  actual?: boolean;
  confirm?: string;
  previewToken?: string;
  expectedSourceVersion?: number;
}

export interface RunSheet3SubmissionBridgeEnvelope extends FluCallableEnvelope {
  ok: true;
  dryRun: boolean;
  sourceVersion: number;
  expectedSourceVersion?: number;
  previewToken?: string;
  previewExpiresAtIso?: string;
  confirmation?: string;
  canApply?: boolean;
  scanned: number;
  eligible?: number;
  ineligible?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  failed?: number;
  businessWritesApplied: boolean;
  idempotentReplay: boolean;
}

export const runSheet3SubmissionBridge = (
  payload: RunSheet3SubmissionBridgePayload = {},
) =>
  callFluCallable<RunSheet3SubmissionBridgeEnvelope>(
    "runSheet3SubmissionBridge",
    payload,
  );

export interface SyncYouTubeEnrichmentPayload extends FluCallablePayload {
  leadIds?: string[];
  leadRefs?: string[];
  leads?: Array<{ id?: string; youtubeUrl?: string } & Record<string, unknown>>;
  dryRun?: boolean;
  nowIso?: string;
}

export interface SyncYouTubeEnrichmentEnvelope extends FluCallableEnvelope {
  ok: true;
  mode: "dry_run" | "emulator_write";
  requestedLeadCount: number;
  enrichedCount: number;
  failedCount: number;
  skippedCount: number;
  writeCount: number;
  results: Array<Record<string, unknown>>;
}
export const syncYouTubeEnrichment = (
  payload: SyncYouTubeEnrichmentPayload = {},
) =>
  callFluCallable<SyncYouTubeEnrichmentEnvelope>(
    "syncYouTubeEnrichment",
    payload,
  );

export type ScpAutomationStage =
  "qualification" | "videoReview" | "encouragement";
export type ScpAutomationAction =
  | "ai_recommendation"
  | "final_decision"
  | "mail_send"
  | "link_issue"
  | "status_transition";
export type ScpAutomationMode = "human_assist" | "ai_assist" | "auto_ai";
export type ScpAutomationGate = "required" | "off";
export interface ScpAutomationSettingsPayload extends FluCallablePayload {
  patch?: {
    stages?: Partial<
      Record<
        ScpAutomationStage,
        {
          mode?: ScpAutomationMode;
          gate?: ScpAutomationGate;
          actions?: Partial<
            Record<ScpAutomationAction, { gate?: ScpAutomationGate }>
          >;
        }
      >
    >;
    autoPilotEnabled?: boolean;
    lastBacktestPassedAt?: string | null;
    // S5(P5) 인터뷰 #3 확정 hard gate threshold (0..1, 기본 0.8). super_admin write만 허용.
    countryConfidenceThreshold?: number;
    // Red-team fix(S5 P5-a): 국가게이트 전용 백테스트 스탬프. super_admin이 오프라인
    // 오탈락률 분석 검토 후 수동으로 부여(자동 작성기 없음). null = 스탬프 해제.
    countryGateBacktestPassedAt?: {
      passedAtIso: string;
      gateVersion: number;
      threshold: number;
    } | null;
  };
}
export interface ScpAutomationSettingsEnvelope extends FluCallableEnvelope {
  ok: true;
  settings: {
    stages: Record<
      ScpAutomationStage,
      {
        mode: ScpAutomationMode;
        gate: ScpAutomationGate;
        actions: Partial<
          Record<ScpAutomationAction, { gate: ScpAutomationGate }>
        >;
      }
    >;
    autoPilotEnabled: boolean;
    lastBacktestPassedAt: string | null;
    countryConfidenceThreshold: number;
    countryGateBacktestPassedAt: {
      passedAtIso: string;
      gateVersion: number;
      threshold: number;
    } | null;
    updatedAtIso: string | null;
    updatedBy: string | null;
  };
  // Server-computed validity of countryGateBacktestPassedAt (exists + gateVersion/threshold
  // still match the live config) — the settings UI must use this, not a truthy-check on the
  // stamp container itself (that was always truthy and masked a null/expired stamp).
  countryGateBacktestValid?: boolean;
  updatedKeys?: string[];
}
export const getScpAutomationSettings = (payload: FluCallablePayload = {}) =>
  callFluCallable<ScpAutomationSettingsEnvelope>(
    "getScpAutomationSettings",
    payload,
  );
export const updateScpAutomationSettings = (
  payload: ScpAutomationSettingsPayload,
) =>
  callFluCallable<ScpAutomationSettingsEnvelope>(
    "updateScpAutomationSettings",
    payload,
  );
export const getScpAutomationControl = (payload: FluCallablePayload = {}) =>
  callFluCallable<ScpAutomationControlEnvelope>(
    "getScpAutomationControl",
    payload,
  );

// ── SCP lifecycle flow config (program-level step order/visibility/gate pins) ──
// Canonical state IDs stay immutable server-side; this config is presentation +
// gate-pin metadata only. All mutations go through callables (RBAC + audit +
// expectedVersion optimistic concurrency).
export type ScpLifecycleFlowTone =
  "neutral" | "info" | "accent" | "warn" | "ai" | "ok" | "danger";
export interface ScpLifecycleFlowStep {
  id: string;
  label: string;
  description: string;
  order: number;
  enabled: boolean;
  deletedAtIso: string | null;
  terminal: boolean;
  humanGateRequired: boolean;
  tone: ScpLifecycleFlowTone;
}
export interface ScpLifecycleFlowConfigData {
  version: number;
  programId: string;
  steps: ScpLifecycleFlowStep[];
  updatedAtIso: string;
  updatedBy: string;
}
export interface ScpLifecycleFlowConfigEnvelope extends FluCallableEnvelope {
  ok: true;
  config: ScpLifecycleFlowConfigData;
  source: "program" | "default" | "canonical";
  lockedGateStates: string[];
  terminalStates: string[];
}
export interface ScpLifecycleFlowUpdatePayload extends FluCallablePayload {
  programId?: string;
  expectedVersion: number;
  steps: ScpLifecycleFlowStep[];
}
export interface ScpLifecycleFlowPreviewPayload extends FluCallablePayload {
  programId?: string;
  steps: ScpLifecycleFlowStep[];
}
export interface ScpLifecycleFlowPreviewEnvelope extends FluCallableEnvelope {
  ok: true;
  valid: boolean;
  validationErrors: string[];
  currentVersion: number;
  source: "program" | "default" | "canonical";
  impact: {
    profilesScanned: number;
    profilesScanTruncated: boolean;
    profilesByState: Record<string, number>;
    hiddenStates: string[];
    disabledStates: string[];
    deletedStates: string[];
    hiddenProfileCount: number;
    terminalStates: string[];
    orderChanged: boolean;
    humanGateAdded: string[];
    humanGateRemoved: string[];
    programScoped: boolean;
    indexNotes: string[];
  } | null;
}
export const getScpLifecycleFlowConfig = (payload: FluCallablePayload = {}) =>
  callFluCallable<ScpLifecycleFlowConfigEnvelope>(
    "getScpLifecycleFlowConfig",
    payload,
  );
export const updateScpLifecycleFlowConfig = (
  payload: ScpLifecycleFlowUpdatePayload,
) =>
  callFluCallable<ScpLifecycleFlowConfigEnvelope>(
    "updateScpLifecycleFlowConfig",
    payload,
  );
export const previewScpLifecycleFlowConfig = (
  payload: ScpLifecycleFlowPreviewPayload,
) =>
  callFluCallable<ScpLifecycleFlowPreviewEnvelope>(
    "previewScpLifecycleFlowConfig",
    payload,
  );

export interface JudgeQualificationPayload extends FluCallablePayload {
  leadIds?: string[];
  leadRefs?: string[];
  leads?: Array<Record<string, unknown>>;
  finalVerdict?: "pass" | "fail" | "hold" | null;
  finalReason?: string;
  overrideOfRef?: string;
  dryRun?: boolean;
  nowIso?: string;
}
export interface JudgeQualificationEnvelope extends FluCallableEnvelope {
  ok: true;
  mode: "dry_run" | "emulator_write";
  requestedLeadCount: number;
  recommendedCount: number;
  failedCount: number;
  skippedCount: number;
  writeCount: number;
  results: Array<Record<string, unknown>>;
  cache: { checked: true; hits: number; misses: number; ttlSeconds: number };
}
export const judgeQualification = (payload: JudgeQualificationPayload = {}) =>
  callFluCallable<JudgeQualificationEnvelope>("judgeQualification", payload);

export interface RunQualificationBacktestPayload extends FluCallablePayload {
  spreadsheetId?: string;
  tabName?: string;
  startRow?: number;
  rows?: Array<Record<string, unknown> | unknown[]>;
  predictions?: Array<Record<string, unknown>>;
  dryRun?: boolean;
  judgeMissing?: boolean;
  nowIso?: string;
  minPrecision?: number;
  minLabelCount?: number;
  minAutoRejectCount?: number;
}
export interface RunQualificationBacktestEnvelope extends FluCallableEnvelope {
  ok: true;
  mode: "dry_run" | "emulator_write";
  readMode: "input_rows" | "sheets_api";
  spreadsheetId: string;
  tabName: string;
  rowCount: number;
  labeledCount: number;
  passCount: number;
  failCount: number;
  excludedCount: number;
  blankCount: number;
  missingPredictionCount: number;
  metrics: Record<string, unknown>;
  thresholdLock: Record<string, unknown>;
  examples: Array<Record<string, unknown>>;
  runRef: string | null;
}
export const runQualificationBacktest = (
  payload: RunQualificationBacktestPayload = {},
) =>
  callFluCallable<RunQualificationBacktestEnvelope>(
    "runQualificationBacktest",
    payload,
  );

export interface WriteBackQualificationSheetResultsPayload extends FluCallablePayload {
  rowNumber?: number;
  rowNumbers?: number[];
  sourceDecisionRef?: string;
  desiredAG?: "합격" | "불합격";
  desiredAH?:
    | "장르불일치"
    | "저티어국가"
    | "구독자1K미만"
    | "업로드빈도"
    | "인게이지먼트"
    | "중복지원"
    | "유튜브없음"
    | "비대상언어"
    | "보류";
  force?: boolean;
  dryRun?: boolean;
  spreadsheetId?: string;
  tabName?: string;
  gid?: string;
}
export interface WriteBackQualificationSheetResultsRow {
  rowNumber: number;
  current: { AG: string; AH: string };
  previous: { AG: string; AH: string };
  applicantHash: string;
  emailHash: string;
  youtubeHash: string;
  appHash: string;
  metricsHash: string;
  desired: { AG: "합격" | "불합격"; AH: string };
  wrote: { AG: "합격" | "불합격"; AH: string } | null;
  status: "dry_run" | "written" | "blocked" | "idempotent/noop";
  blockedReason?: string;
  auditRef?: string | null;
}
export interface WriteBackQualificationSheetResultsEnvelope extends FluCallableEnvelope {
  ok: true;
  dryRun: boolean;
  sourceDecisionRef: string | null;
  updatePayload: Array<{
    rowNumber: number;
    columns: ["AG", "AH"];
    values: [["합격" | "불합격", string]];
  }>;
  rows: WriteBackQualificationSheetResultsRow[];
  wroteCount: number;
  blockedCount: number;
  idempotentCount: number;
}
export const writeBackQualificationSheetResults = (
  payload: WriteBackQualificationSheetResultsPayload = {},
) =>
  callFluCallable<WriteBackQualificationSheetResultsEnvelope>(
    "writeBackQualificationSheetResults",
    payload,
  );

export interface RunVideoReviewBacktestPayload extends FluCallablePayload {
  spreadsheetId?: string;
  tabName?: string;
  startRow?: number;
  rows?: Array<Record<string, unknown> | unknown[]>;
  predictionsBefore?: Array<Record<string, unknown>>;
  predictionsAfter?: Array<Record<string, unknown>>;
  dryRun?: boolean;
  judgeMissing?: boolean;
  nowIso?: string;
}
export interface RunVideoReviewBacktestEnvelope extends FluCallableEnvelope {
  ok: true;
  mode: "dry_run" | "emulator_write";
  // R14-7: 영상검수 백테스트의 라벨 코호트는 Sheet3 가 아니라 `scp_video_review_state` 스캔이다.
  // 서버가 `spreadsheetId`(컬렉션명을 스프레드시트 id 자리에 넣던 오용)·`range:"n/a"` 를 없앴으므로
  // 클라 타입도 같이 지운다 — 타입만 남으면 "라벨이 Sheets 에서 왔다"는 거짓이 여기서 계속 산다.
  readMode: "input_rows" | "review_state_scan";
  tabName: string;
  rowCount: number;
  labeledCount: number;
  approvalCount: number;
  disapprovalCount: number;
  pendingCount: number;
  missingPredictionCount: number;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  comparison: Record<string, unknown>;
  examples: Array<Record<string, unknown>>;
  report: Record<string, unknown>;
  runRef: string | null;
}
export const runVideoReviewBacktest = (
  payload: RunVideoReviewBacktestPayload = {},
) =>
  callFluCallable<RunVideoReviewBacktestEnvelope>(
    "runVideoReviewBacktest",
    payload,
  );

// S6(P6) RT-6/A6 — 레거시 제출물 백필 enqueue(admin 전용, enqueue만 — LLM 실행은 서버 drain
// 상한 내에서만). dryRun 기본 true(명시적으로 false를 넘겨야 실제 enqueue).
export interface BackfillVideoReviewAutomationOutboxPayload extends FluCallablePayload {
  batchLimit?: number;
  dryRun?: boolean;
}
export interface BackfillVideoReviewAutomationOutboxEnvelope extends FluCallableEnvelope {
  ok: true;
  scanned: number;
  candidateCount: number;
  enqueuedCount: number;
  dryRun: boolean;
  submissionIds: string[];
}
export const backfillVideoReviewAutomationOutbox = (
  payload: BackfillVideoReviewAutomationOutboxPayload = {},
) =>
  callFluCallable<BackfillVideoReviewAutomationOutboxEnvelope>(
    "backfillVideoReviewAutomationOutbox",
    payload,
  );

// S6(P6) acceptance (e) — outbox 상태(queued/processing/processed/no_op/failed/dead_letter) 읽기 전용 조회.
export interface GetVideoReviewAutomationOutboxStatusPayload extends FluCallablePayload {
  submissionIds: string[];
}
export interface VideoReviewAutomationOutboxStatusEntry {
  submissionId: string;
  kind: "ai_recommendation" | "multimodal";
  canonicalProgramId: string;
  policyConfigHash: string;
  status:
    "queued" | "processing" | "processed" | "no_op" | "failed" | "dead_letter";
  attempts: number;
  lastError: string | null;
  lastResult: Record<string, unknown> | null;
  processedAtIso: string | null;
}
export interface GetVideoReviewAutomationOutboxStatusEnvelope extends FluCallableEnvelope {
  ok: true;
  entries: VideoReviewAutomationOutboxStatusEntry[];
}
export const getVideoReviewAutomationOutboxStatus = (
  payload: GetVideoReviewAutomationOutboxStatusPayload,
) =>
  callFluCallable<GetVideoReviewAutomationOutboxStatusEnvelope>(
    "getVideoReviewAutomationOutboxStatus",
    payload,
  );
export interface EvaluateVideoDuplicatePayload extends FluCallablePayload {
  videoSubmissionId: string;
  topK?: number;
  threshold?: number;
}
export type VideoDuplicateExactHit = {
  videoSubmissionId: string;
  kind: "youtube_video_id" | "file_hash";
};
export type VideoDuplicateNearCandidate = {
  videoSubmissionId: string;
  similarity: number;
  signals: { pHash: number; transcript: number };
};
export interface EvaluateVideoDuplicateEnvelope extends FluCallableEnvelope {
  ok: true;
  videoSubmissionId: string;
  exactHit: VideoDuplicateExactHit | null;
  topK: VideoDuplicateNearCandidate[];
  clusterId: string | null;
  scanned: number;
  version: string;
  evaluatedAtIso: string;
}
export const scpEvaluateVideoDuplicate = (
  payload: EvaluateVideoDuplicatePayload,
) =>
  callFluCallable<EvaluateVideoDuplicateEnvelope>(
    "scpEvaluateVideoDuplicate",
    payload,
  );

export interface UpsertCreatorLinkPayload extends FluCallablePayload {
  leadId?: string;
  creatorId?: string;
  programId?: string;
  applicationId?: string;
  applicationRef?: string;
  email?: string;
  channelName?: string;
  country?: string;
  appsflyerOneLink?: string;
  adjustLink?: string;
  campaign?: string;
  source?: "manual" | "api" | "composed";
  status?: "active" | "failed" | "rolled_back";
  dryRun?: boolean;
  nowIso?: string;
}
export interface UpsertCreatorLinkEnvelope extends FluCallableEnvelope {
  ok: true;
  mode: "dry_run" | "emulator_write" | "staging_write";
  creatorLinkRef: string;
  creatorLink: Record<string, unknown>;
  duplicatePrevented: boolean;
}
export const upsertCreatorLink = (payload: UpsertCreatorLinkPayload = {}) =>
  callFluCallable<UpsertCreatorLinkEnvelope>("upsertCreatorLink", payload);

export interface MailOutboxRow {
  trackingId: string;
  /** Which mail_accounts row this send was imported through ("scp" = canonical). Absent on rows imported before per-account Sent ingest. */
  mailAccountId?: string;
  to: string;
  toMasked?: string;
  toHash?: string;
  subject: string;
  deliveryState: string;
  sentAtIso: string;
  openCount: number;
  lastOpenedAtIso: string;
  rawOpenCount?: number;
  likelyRecipientOpenCount?: number;
  firstLikelyRecipientOpenedAtIso?: string;
  openConfidence?: string;
  openSuppressionReason?: string;
  openSignalVersion?: string;
  source?: string;
  mailType?: string;
  gameId: string;
  conversationId: string;
  conversationRef: string;
  conversationSnapshot?: Record<string, unknown>;
  hasReply: boolean;
  hasReplySource?: "ledger" | "live_projection" | "none";
}
export interface MailOutboxPageCursor {
  sentAtIso: string;
  trackingId: string;
}
export interface ListMailOutboxEnvelope extends FluCallableEnvelope {
  rows?: MailOutboxRow[];
  /** Non-null when the server's per-call scan budget was hit before enough authorized rows were
   * found (round 8) — pass cursorSentAtIso/cursorTrackingId back to continue the same scan
   * ("더 보기"), rather than treating this page as the end of the backlog. */
  nextCursor?: MailOutboxPageCursor | null;
}
export const listMailOutbox = (
  payload: FluCallablePayload & { limit?: number; cursorSentAtIso?: string; cursorTrackingId?: string } = {},
) => callFluCallable<ListMailOutboxEnvelope>("listMailOutbox", payload);

export interface ReconcileMailOutboxRepliesPayload extends FluCallablePayload {
  dryRun?: boolean;
  actual?: boolean;
  limit?: number;
  cursorSentAtIso?: string;
  cursorTrackingId?: string;
}
export interface ReconcileMailOutboxRepliesEnvelope extends FluCallableEnvelope {
  ok: true;
  dryRun: boolean;
  mode: "dry_run" | "actual";
  scannedCount: number;
  alreadyMemoizedCount: number;
  detectedReplyCount: number;
  pendingWriteCount: number;
  updatedCount: number;
  lifecycleEnqueuedCount: number;
  lifecycleFailedCount: number;
  /** Non-null when the server's per-call scan budget was hit before `limit` authorized rows were
   * found (round 8) — pass back to continue reconciling the same backlog. */
  nextCursor?: MailOutboxPageCursor | null;
}
export const reconcileMailOutboxReplies = (
  payload: ReconcileMailOutboxRepliesPayload = {},
) =>
  callFluCallable<ReconcileMailOutboxRepliesEnvelope>(
    "reconcileMailOutboxReplies",
    payload,
  );

export interface ImportManualSentMailPayload extends FluCallablePayload {
  dryRun?: boolean;
  preview?: boolean;
  actual?: boolean;
  execute?: boolean;
  previewToken?: string;
  limit?: number;
  sentMailbox?: string;
  messages?: Array<Record<string, unknown>>;
}
export interface ImportManualSentMailEnvelope extends FluCallableEnvelope {
  ok: true;
  dryRun: boolean;
  mode: "dry_run" | "actual";
  candidateCount: number;
  safeCandidateCount: number;
  pendingWriteCount: number;
  skippedUnsafe: number;
  duplicateCount: number;
  importedOutbox: number;
  importedMessageSources: number;
  rows: Array<Record<string, unknown> & {
    attributionIdentity?: ImportedSentAttributionIdentity;
  }>;
  previewToken?: string;
  previewStateful: boolean;
  sideEffects: string[];
  businessWritesApplied: boolean;
  previewClaimFingerprint?: string;
  auditRef?: string | null;
  idempotentReplay: boolean;
  allowedSentMailboxes?: string[];
  cursorPreview?: {
    mailbox: string;
    nextLastUid: number;
    uidValidity: string;
  };
}
export const importManualSentMailToOutbox = (
  payload: ImportManualSentMailPayload = {},
) =>
  callFluCallable<ImportManualSentMailEnvelope>(
    "importManualSentMailToOutbox",
    payload,
  );

export interface ImportedSentAttributionIdentity {
  outboxRef: string;
  messageSourceRef: string;
  trackingId: string;
  providerMessageIdHash: string;
  expectedAttributionVersion: number;
  supersedesAuditRef: string;
}
export interface AttributeImportedSentOnlyHistoryPayload extends FluCallablePayload {
  action: "assign" | "supersede" | "remove";
  programId?: string;
  campaignId?: string;
  reason: string;
  identities: ImportedSentAttributionIdentity[];
  dryRun?: boolean;
  actual?: boolean;
  confirm?: boolean;
  confirmationToken?: string;
  confirmationVersion?: string;
}
export interface AttributeImportedSentOnlyHistoryEnvelope extends FluCallableEnvelope {
  ok: true;
  dryRun: boolean;
  mode: "dry_run" | "actual";
  action: "assign" | "supersede" | "remove";
  programId: string | null;
  campaignId: string | null;
  identityCount: number;
  projectionWriteCount: number;
  pendingWriteCount: number;
  rows: Array<Record<string, unknown>>;
  confirmationToken?: string;
  confirmationVersion: string;
  expiresAtIso?: string;
  planFingerprint?: string;
  previewStateful?: boolean;
  sideEffects: string[];
  businessWritesApplied: boolean;
  idempotentReplay: boolean;
  auditRef?: string;
  receiptHash?: string;
  mailSent?: false;
}
export const attributeImportedSentOnlyHistory = (
  payload: AttributeImportedSentOnlyHistoryPayload,
) => callFluCallable<AttributeImportedSentOnlyHistoryEnvelope>(
  "attributeImportedSentOnlyHistory",
  payload,
);

export interface ReconcileCampaignOutreachMailLedgersEnvelope extends FluCallableEnvelope {
  ok: true;
  dryRun: boolean;
  mode: "preview" | "actual";
  previewStateful: boolean;
  sideEffects: string[];
  businessWritesApplied: boolean;
  campaignId: string;
  programId?: string;
  eligibleRows: number;
  skippedRows: number;
  candidateCount: number;
  reconciledOutbox: number;
  reconciledHistory: number;
  rows: Array<Record<string, unknown>>;
  previewToken?: string;
  previewClaimFingerprint?: string;
  previewExpiresAtIso?: string;
  auditRef?: string;
  lifecycleRefresh?: {
    status: "not_requested" | "enqueued" | "partial_failure" | "failed";
    attempted: number;
    enqueued: number;
    failed: number;
    failureCorrelationHashes: string[];
  };
  warnings?: Array<{
    code: string;
    count: number;
    correlationHashes: string[];
  }>;
}
export interface ReconcileCampaignOutreachMailLedgersPayload extends FluCallablePayload {
  campaignId: string;
  programId?: string;
  dryRun?: boolean;
  preview?: boolean;
  actual?: boolean;
  previewToken?: string;
  limit?: number;
}
export const reconcileCampaignOutreachMailLedgers = (
  payload: ReconcileCampaignOutreachMailLedgersPayload,
) =>
  callFluCallable<ReconcileCampaignOutreachMailLedgersEnvelope>(
    "reconcileCampaignOutreachMailLedgers",
    payload,
  );

export interface ColdmailHistoryRow {
  id: string;
  programId: string;
  email?: string;
  emailMasked: string;
  koreanName: string;
  youtubeUrl?: string;
  youtubeSource?: string;
  youtubeValidation?: string;
  youtubeConfidence?: number;
  youtubeVerifiedAtIso?: string;
  youtubeMaterializationVersion?: string;
  humanMigrationRequired?: boolean;
  subject: string;
  bodyPreview: string;
  campaign: string;
  campaignId: string;
  campaignRef: string;
  source: string;
  templateKind: string;
  sentAtIso: string;
  deliveryState: string;
  openCount: number;
  hasReply: boolean;
  conversationId: string;
  createdByRole: string;
}
export interface ListScpColdmailHistoryEnvelope extends FluCallableEnvelope {
  rows?: ColdmailHistoryRow[];
  count?: number;
  programId?: string;
  includedPii?: boolean;
}
export interface ExportScpColdmailHistoryCsvEnvelope extends FluCallableEnvelope {
  filename?: string;
  mimeType?: string;
  csv?: string;
  rowCount?: number;
  includedBody?: boolean;
  includedPii?: boolean;
}
export const listScpColdmailHistory = (
  payload: FluCallablePayload & {
    programId: string;
    email?: string;
    query?: string;
    dateFrom?: string;
    dateTo?: string;
    campaignId?: string;
    campaignRef?: string;
    limit?: number;
    includePii?: boolean;
  },
) =>
  callFluCallable<ListScpColdmailHistoryEnvelope>(
    "listScpColdmailHistory",
    payload,
  );
export const exportScpColdmailHistoryCsv = (
  payload: FluCallablePayload & {
    programId: string;
    email?: string;
    query?: string;
    dateFrom?: string;
    dateTo?: string;
    campaignId?: string;
    campaignRef?: string;
    includeBody?: boolean;
    includePii?: boolean;
  },
) =>
  callFluCallable<ExportScpColdmailHistoryCsvEnvelope>(
    "exportScpColdmailHistoryCsv",
    payload,
  );

export interface RebuildScpColdmailHistoryProjectionsEnvelope extends FluCallableEnvelope {
  ok: true;
  dryRun: boolean;
  scanned: number;
  eligible: number;
  replyLinks: number;
  youtubeResolved: number;
  planned: number;
  updated: number;
  planFingerprint: string;
  programId: string;
  aliasRegistryRevision: string;
  pageSize: number;
  nextCursor: string | null;
  complete: boolean;
}
export const rebuildScpColdmailHistoryProjections = (
  payload: FluCallablePayload & {
    programId: string;
    dryRun?: boolean;
    actual?: boolean;
    pageSize?: number;
    cursor?: string;
    expectedFingerprint?: string;
  },
) =>
  callFluCallable<RebuildScpColdmailHistoryProjectionsEnvelope>(
    "rebuildScpColdmailHistoryProjections",
    payload,
  );

export interface MailAssetManifestEntry {
  cid: string;
  sha256: string;
  mime: string;
  bytes: number;
}

export interface MailAssetPreviewContent {
  cid: string;
  mime: string;
  base64: string;
}

export interface PreviewEmailDraftArtifact {
  bodyFormat: MailBodyFormat;
  compilerVersion: string;
  templateRevision: string;
  compiledHtml: string;
  text: string;
  contentHash: string;
  sourceHash: string;
  compiledHash: string;
  textHash: string;
  assets?: MailAssetManifestEntry[];
}

export interface PreviewEmailDraftPayload extends FluCallablePayload {
  conversationId?: string;
  subject?: string;
  body?: string;
  text?: string;
  recipient?: string;
  to?: string;
  sender?: string;
  from?: string;
  templateKind?: string;
  bodyFormat?: MailBodyFormat;
  templateValues?: Record<string, unknown>;
  templateRevision?: string | number;
  trackingId?: string;
  draftRef?: string;
}

export interface PreviewEmailDraftEnvelope extends FluCallableEnvelope {
  ok: true;
  artifact: PreviewEmailDraftArtifact;
  assetContents?: MailAssetPreviewContent[];
  html: string;
  text: string;
  resolvedSubject?: string;
  recipientLabel?: string;
  senderLabel?: string;
  conversationId?: string;
  warnings?: string[];
  sideEffects?: string;
}
export const previewEmailDraft = (payload: PreviewEmailDraftPayload = {}) =>
  callFluCallable<PreviewEmailDraftEnvelope>("previewEmailDraft", payload);

export interface MailSignatureGameInput {
  name: string;
  imageUrl: string;
  linkUrl: string;
}
export interface MailSignatureSettingsShape {
  senderName: string;
  senderTeam: string;
  senderEmail: string;
  siteUrl: string;
  logoUrl: string;
  tagline: string;
  games: MailSignatureGameInput[];
}
export interface MailSignatureEnvelope extends FluCallableEnvelope {
  ok?: true;
  dryRun?: boolean;
  sideEffects?: "none";
  settings?: MailSignatureSettingsShape;
  previewHtml?: string;
  contentHash?: string;
  currentHash?: string;
  currentVersion?: number;
  previousHash?: string;
  previousVersion?: number;
  version?: number;
  applied?: boolean;
  noop?: boolean;
  noopReason?: "identical_content";
  auditRef?: string | null;
  allowedHttpsHosts?: string[];
  validation?: {
    valid: true;
    allowedHttpsHosts: string[];
    maximumGames: number;
    gameCount: number;
  };
}
export const getMailSignatureSettings = (payload: FluCallablePayload = {}) =>
  callFluCallable<MailSignatureEnvelope>("getMailSignatureSettings", payload);
export interface UpdateMailSignatureSettingsPayload extends FluCallablePayload {
  settings: MailSignatureSettingsShape;
  dryRun?: boolean;
  expectedVersion?: number;
  expectedHash?: string;
}
export const updateMailSignatureSettings = (
  payload: UpdateMailSignatureSettingsPayload,
) =>
  callFluCallable<MailSignatureEnvelope>(
    "updateMailSignatureSettings",
    payload,
  );

export type ScpMailTemplateKind =
  | "qualification_pass"
  | "qualification_fail"
  | "re_guide"
  | "gem_paid_submission_request"
  | "video_submission_reminder";
export type ScpReceiptMailTemplateKind =
  | "application_confirmed"
  | "content_submitted";
// W7-3b: 편집기가 HTML+텍스트로 다루는 오버라이드 kind. 발송 경로는 문서가 없으면 코드 렌더러를
// fallback 으로 쓴다(functions/scpReceiptMailTemplates.ts ScpMailTemplateOverrideKind 와 같은 집합).
export type ScpMailTemplateOverrideKind =
  | "uid_guide"
  | "video_result_mail"
  // W120: 승인 결과 메일 전용 override kind(반려 문안이 승인 통지로 새지 않게 분리).
  | "video_result_mail_approved"
  // 26-08-27 동기화: 백엔드 집합과 어긋나 있던 드리프트 해소(코호트 독려 3종·login_approved 누락).
  | "scp_nudge_cohort1_read_no_reply_en"
  | "scp_nudge_cohort2_applied_no_video_en"
  | "scp_nudge_cohort3_unread_no_reply_en"
  | "login_approved"
  // 반려 안내 2종(사유별 kind — 헤세 확정 카피).
  | "login_rejected_subscriber_minimum"
  | "login_rejected_channel_not_found";
export type ScpEditableMailTemplateKind =
  | ScpReceiptMailTemplateKind
  | ScpMailTemplateOverrideKind;
export interface ScpMailTemplatePayload extends FluCallablePayload {
  id?: ScpMailTemplateKind | ScpEditableMailTemplateKind;
  kind?: ScpMailTemplateKind | ScpEditableMailTemplateKind;
  title?: string;
  subject?: string;
  body?: string;
  html?: string;
  text?: string;
  plainText?: string;
  vars?: string[];
  status?: "active" | "archived";
  dryRun?: boolean;
  expectedVersion?: number;
  expectedHash?: string;
  quickStartGuideLink?: string;
  guidebookLink?: string;
  userIdGuideLink?: string;
  guideLinks?: {
    quickStartGuideLink?: string;
    guidebookLink?: string;
    userIdGuideLink?: string;
  };
  previewValues?: Record<string, string>;
}
export interface ScpMailTemplateEnvelope extends FluCallableEnvelope {
  template?: Record<string, unknown>;
  templateRef?: string;
  status?: string;
  dryRun?: boolean;
  sideEffects?: "none";
  preview?: {
    subject?: string;
    body?: string;
    preview?: string;
    missingPlaceholders?: string[];
    values?: Record<string, string>;
  };
  contentHash?: string;
  currentHash?: string;
  currentVersion?: number;
  previousHash?: string;
  previousVersion?: number;
  version?: number;
  applied?: boolean;
  noop?: boolean;
  noopReason?: "identical_content";
  auditRef?: string | null;
  validation?: {
    valid?: boolean;
    renderable?: boolean;
    missingPreviewValues?: string[];
    [key: string]: unknown;
  };
  // W7-3f: 저장 전 경고(서버 계산). 저장을 막지 않고 사실만 싣는다.
  lints?: {
    conditionallyInjectedVariables?: string[];
    safetyKeywordMatches?: string[];
  } | null;
}
export interface PrepareScpResultMailPayload extends FluCallablePayload {
  leadId: string;
  kind?: ScpMailTemplateKind;
  templateKind?: ScpMailTemplateKind;
  mode?: "draft_only" | "send_approved";
  approval?: "approved" | "pending" | "rejected";
  approvalRef?: string;
  draftRef?: string;
  formLink?: string;
  quickStartGuideLink?: string;
  guidebookLink?: string;
  userIdGuideLink?: string;
  guideLinks?: {
    quickStartGuideLink?: string;
    guidebookLink?: string;
    userIdGuideLink?: string;
  };
  reason?: string;
  dryRun?: boolean;
  liveSend?: boolean;
}
export interface PrepareScpResultMailEnvelope extends FluCallableEnvelope {
  status?: "draft_only" | "sent" | "blocked" | "held" | "skipped";
  blocked?: boolean;
  held?: boolean;
  skipped?: boolean;
  skippedReason?: string;
  resultRef?: string;
  draft?: {
    subject?: string;
    body?: string;
    preview?: string;
    missingPlaceholders?: string[];
  };
  mailSafety?: Record<string, unknown>;
  scpGate?: Record<string, unknown>;
  sendResult?: Record<string, unknown>;
  operatorAlert?: {
    type?: string;
    needsOperator?: boolean;
    missingPlaceholders?: string[];
  };
}
export interface SendPendingQualificationRejectionNotificationsPayload extends FluCallablePayload {
  dryRun?: boolean;
  liveSend?: boolean;
  allowAiRecommendation?: boolean;
  limit?: number;
  leadIds?: string[];
}
export interface SendPendingQualificationRejectionNotificationsEnvelope extends FluCallableEnvelope {
  dryRun?: boolean;
  liveSend?: boolean;
  allowAiRecommendation?: boolean;
  candidateCount?: number;
  sentCount?: number;
  skippedCount?: number;
  blockedCount?: number;
  rows?: Array<Record<string, unknown>>;
  capScope?: string;
  batchLimit?: number;
  batchLimitScope?: string;
  campaignColdmailCapApplied?: boolean;
}
export const upsertScpMailTemplate = (payload: ScpMailTemplatePayload) =>
  callFluCallable<ScpMailTemplateEnvelope>("upsertScpMailTemplate", payload);
export const deleteScpMailTemplate = (
  payload: Pick<ScpMailTemplatePayload, "kind" | "id">,
) => callFluCallable<ScpMailTemplateEnvelope>("deleteScpMailTemplate", payload);
export const prepareScpResultMail = (payload: PrepareScpResultMailPayload) =>
  callFluCallable<PrepareScpResultMailEnvelope>(
    "prepareScpResultMail",
    payload,
  );

export interface ListScpEncouragementCandidatesPayload extends FluCallablePayload {
  states?: string[];
  limit?: number;
  pageSize?: number;
  nowIso?: string;
}

export interface ScpEncouragementCandidateCard {
  profileId: string;
  programTag: string;
  identityHash: string;
  state: string;
  waitedDays: number;
  lastContactAtIso: string | null;
}

export interface ListScpEncouragementCandidatesEnvelope extends FluCallableEnvelope {
  ok: true;
  states: string[];
  scanned: number;
  counts: {
    eligible: number;
    states: Record<string, number>;
    ineligible: Record<string, number>;
  };
  cards: ScpEncouragementCandidateCard[];
  pageInfo: { limit: number; truncated: boolean; nextCursor: string | null };
}

export interface PrepareScpEncouragementMailPayload extends FluCallablePayload {
  profileId: string;
  mode?: "draft_only" | "send_approved";
  encouragementStage?: string;
  cadenceSlot?: string;
  cooldownDays?: number;
  nowIso?: string;
}

export interface PrepareScpEncouragementMailEnvelope extends FluCallableEnvelope {
  ok: boolean;
  status: "draft_only" | "blocked" | "skipped";
  blocked?: boolean;
  skipped?: boolean;
  blockedReason?: string;
  skippedReason?: string;
  resultRef?: string;
  cadenceRef?: string;
  nextEligibleAt?: string;
  draft?: {
    subject: string;
    body: string;
    preview: string;
    missingPlaceholders: string[];
    values: Record<string, string>;
  };
}

export const listScpEncouragementCandidates = (
  payload: ListScpEncouragementCandidatesPayload = {},
) =>
  callFluCallable<ListScpEncouragementCandidatesEnvelope>(
    "listScpEncouragementCandidates",
    payload,
  );
export const prepareScpEncouragementMail = (
  payload: PrepareScpEncouragementMailPayload,
) =>
  callFluCallable<PrepareScpEncouragementMailEnvelope>(
    "prepareScpEncouragementMail",
    payload,
  );

export type VideoSubmissionReminderDeliveryMode =
  "approval_required" | "auto_send";
export interface VideoSubmissionReminderSettings {
  enabled: boolean;
  offsets: number[];
  timezone: string;
  sendTime: string;
  sendOnWeekends: boolean;
  deliveryMode: VideoSubmissionReminderDeliveryMode;
  pauseOnReply: boolean;
  pauseOnBounce: boolean;
  pauseOnOptOut: boolean;
  submissionFormUrl: string;
}
export interface VideoSubmissionReminderSettingsEnvelope extends FluCallableEnvelope {
  ok: true;
  programId: string;
  settings: VideoSubmissionReminderSettings;
  version: number;
  hash: string;
  exists: boolean;
  suggestedOffsets: number[];
  previewHash?: string;
  impact?: Record<string, unknown>;
}
export interface VideoSubmissionReminderTarget extends Record<string, unknown> {
  id: string;
  status: "due" | "upcoming" | "paused" | "closed";
  canonicalProgramId?: string;
  campaignId?: string;
  canonicalCampaignId?: string;
  campaignRef?: string;
  creatorId?: string;
  creatorName?: string;
  email?: string;
  nextDueAtIso?: string;
  nextOccurrenceId?: string;
  nextOccurrenceStatus?:
    | "scheduled"
    | "processing"
    | "awaiting_approval"
    | "paused"
    | "sent"
    | "skipped"
    | "superseded"
    | "cancelled"
    | "failed"
    | null;
  currentOccurrenceId?: string;
  occurrenceId?: string;
  triggerSentAtIso?: string;
  lastReminderAtIso?: string;
  pauseReason?: string;
  closeReason?: string;
}
export interface VideoSubmissionReminderTargetsEnvelope extends FluCallableEnvelope {
  ok: true;
  programId: string;
  rows: VideoSubmissionReminderTarget[];
  counts: { due: number; upcoming: number; paused: number; closed: number };
  pageInfo: { limit: number; truncated: boolean; nextCursor: string | null };
}
export const getVideoSubmissionReminderSettings = (payload: {
  programId: string;
}) =>
  callFluCallable<VideoSubmissionReminderSettingsEnvelope>(
    "getVideoSubmissionReminderSettings",
    payload,
  );
export const updateVideoSubmissionReminderSettings = (
  payload: FluCallablePayload & { programId: string },
) =>
  callFluCallable<VideoSubmissionReminderSettingsEnvelope>(
    "updateVideoSubmissionReminderSettings",
    payload,
  );
export const listVideoSubmissionReminderTargets = (
  payload: FluCallablePayload & { programId: string },
) =>
  callFluCallable<VideoSubmissionReminderTargetsEnvelope>(
    "listVideoSubmissionReminderTargets",
    payload,
  );
export const listVideoSubmissionReminderHistory = (payload: {
  targetId: string;
  limit?: number;
}) =>
  callFluCallable<
    FluCallableEnvelope & { rows?: Array<Record<string, unknown>> }
  >("listVideoSubmissionReminderHistory", payload);
export const previewVideoSubmissionReminderMail = (
  payload: FluCallablePayload,
) =>
  callFluCallable<PrepareScpResultMailEnvelope>(
    "previewVideoSubmissionReminderMail",
    payload,
  );
export const approveVideoSubmissionReminderMail = (
  payload: FluCallablePayload,
) =>
  callFluCallable<FluCallableEnvelope>(
    "approveVideoSubmissionReminderMail",
    payload,
  );
export const updateVideoSubmissionReminderTarget = (
  payload: FluCallablePayload & { targetId: string; action: string },
) =>
  callFluCallable<FluCallableEnvelope>(
    "updateVideoSubmissionReminderTarget",
    payload,
  );
export const processVideoSubmissionReminders = (
  payload: FluCallablePayload = {},
) =>
  callFluCallable<FluCallableEnvelope>(
    "processVideoSubmissionReminders",
    payload,
  );
export const sendPendingQualificationRejectionNotifications = (
  payload: SendPendingQualificationRejectionNotificationsPayload = {},
) =>
  callFluCallable<SendPendingQualificationRejectionNotificationsEnvelope>(
    "sendPendingQualificationRejectionNotifications",
    payload,
  );

export interface IssueSubmissionTaskPayload extends FluCallablePayload {
  leadId?: string;
  applicationId?: string;
  applicationRef?: string;
  creatorId?: string;
  programId?: string;
  email?: string;
  channelName?: string;
  country?: string;
  locale?: "en" | "ko" | "vi" | string;
  contentType?: string;
  ttlDays?: number;
  baseUrl?: string;
  forceNewToken?: boolean;
}
export interface IssueSubmissionTaskEnvelope extends FluCallableEnvelope {
  task?: Record<string, unknown>;
  taskRef?: string;
  formLink?: string;
}
export interface PublicSubmissionFormEnvelope extends FluCallableEnvelope {
  form?: {
    id?: string;
    app?: string;
    appName?: string;
    contentType?: string;
    locale?: string;
    formTitle?: string;
    formInstructions?: string;
    requiredFields?: string[];
    taskStatus?: string;
    expiresAtIso?: string;
    snapshot?: Record<string, unknown>;
    maxUploadBytes?: number;
    uploadContentType?: string;
  };
}
export interface CreateSubmissionUploadUrlPayload extends FluCallablePayload {
  token: string;
  filename: string;
  contentType: string;
  size: number;
}
export interface CreateSubmissionUploadUrlEnvelope extends FluCallableEnvelope {
  uploadUrl?: string;
  method?: "PUT";
  requiredHeaders?: Record<string, string>;
  fileUrl?: string;
  objectPath?: string;
  uploadReservationId?: string;
  maxBytes?: number;
  expiresInMs?: number;
}
export interface SubmitPublicSubmissionPayload extends FluCallablePayload {
  token: string;
  youtubeUrl?: string;
  tiktokUrl?: string;
  instaUrl?: string;
  instagramUrl?: string;
  uploadedFileUrl?: string;
  uploadedFileGeneration?: string;
  contentUrls?: string[];
  submitNote?: string;
  fields?: Array<{
    key?: string;
    label?: string;
    type?: string;
    value?: string;
    sortOrder?: number | null;
  }>;
}
export interface SubmitPublicSubmissionEnvelope extends FluCallableEnvelope {
  submissionId?: string;
  submissionRef?: string;
  reviewStatus?: "pending" | string;
  resubmitted?: boolean;
  idempotent?: boolean;
}
export const issueSubmissionTask = (payload: IssueSubmissionTaskPayload) =>
  callFluCallable<IssueSubmissionTaskEnvelope>("issueSubmissionTask", payload);
export const getPublicSubmissionForm = (payload: { token: string }) =>
  callFluCallable<PublicSubmissionFormEnvelope>(
    "getPublicSubmissionForm",
    payload,
  );
export const createSubmissionUploadUrl = (
  payload: CreateSubmissionUploadUrlPayload,
) =>
  callFluCallable<CreateSubmissionUploadUrlEnvelope>(
    "createSubmissionUploadUrl",
    payload,
  );
export const submitPublicSubmission = (
  payload: SubmitPublicSubmissionPayload,
) =>
  callFluCallable<SubmitPublicSubmissionEnvelope>(
    "submitPublicSubmission",
    payload,
  );

export interface JudgeVideoReviewPayload extends FluCallablePayload {
  submissionIds?: string[];
  submissionRefs?: string[];
  submissions?: Array<Record<string, unknown>>;
  dryRun?: boolean;
  nowIso?: string;
}
export interface JudgeVideoReviewEnvelope extends FluCallableEnvelope {
  mode: "dry_run" | "emulator_write";
  requestedSubmissionCount: number;
  recommendedCount: number;
  failedCount: number;
  skippedCount: number;
  writeCount: number;
  transitionedCount: number;
  results: Array<Record<string, unknown>>;
  cache: { checked: true; hits: number; misses: number; ttlSeconds: number };
}
export const judgeVideoReview = (payload: JudgeVideoReviewPayload = {}) =>
  callFluCallable<JudgeVideoReviewEnvelope>("judgeVideoReview", payload);

export interface DatasetPageEnvelope extends FluCallableEnvelope {
  ok: true;
  key: DatasetKey;
  rows: Record<string, unknown>[];
  counts: Record<string, number>;
  pageInfo: DatasetPageInfo;
  cache: {
    generatedAtIso: string;
    maxAgeSeconds: number;
    requestedKeys: DatasetKey[];
  };
  /** PLAN-ORG-MAIL-IDENTITY Slice 5: only present for key === "conversations" (listConversations). */
  viewerOrgId?: string | null;
  orgFilterApplied?: boolean;
  /** Flu/Task-48: only present for key === "conversations" when mailAccountId was passed —
   * echoes back the validated account id the row set was actually filtered to. */
  viewMailAccountId?: string | null;
}
export interface DatasetPagePayload extends FluCallablePayload {
  cursor?: string;
  limit?: number;
  programId?: string;
  campaignId?: string;
  ids?: string[];
  creatorIds?: string[];
  channelIds?: string[];
  handles?: string[];
  emails?: string[];
  /** W41: campaigns 한정 opt-in — 관리자만, 옵션 없으면 서버 판정 불변(functions/read.ts). */
  includeArchivedCampaigns?: boolean;
  /** PLAN-ORG-MAIL-IDENTITY Slice 5: listConversations only — admin/super_admin may filter to one org. */
  orgId?: string;
  /** Flu/Task-47: listConversations only — admin/super_admin opt-in to also see personal-account
   * conversations whose counterpartyRegistered stamp is exactly false. Ignored for every other
   * role/key (re-checked against the caller's role server-side, never trusted as-is). */
  includeUnregistered?: boolean;
  /** Flu/Task-48: listConversations/listConversationMessages only — view as this mail account
   * (getMyOrgContext's viewMailAccountId). Server-validated against the caller's accessible set;
   * an inaccessible id is a permission-denied, never a silent empty result. */
  mailAccountId?: string;
  /** Flu/Task-50 — listConversations/listConversationMessages only, super_admin "대신 보기".
   * Must be provided together with viewAsEmail; the server re-verifies both against the members
   * collection (functions/mailAccountCallables.ts resolveViewAsTarget) — a non-super_admin caller
   * or a pair that does not match a real member is rejected, never silently ignored. */
  viewAsUserId?: string;
  viewAsEmail?: string;
}
export const listCreators = (payload: DatasetPagePayload = {}) =>
  callFluCallable<DatasetPageEnvelope>("listCreators", payload);
export const listVideos = (payload: DatasetPagePayload = {}) =>
  callFluCallable<DatasetPageEnvelope>("listVideos", payload);
// W90: 캠페인 키워드 코퍼스 읽기 전용 조회(어드민 가시성). 서버가 정제한 행만 온다 —
//   프롬프트/응답 원문은 애초에 저장되지 않는다(SEC-P0-009).
export interface KeywordCorpusRowView {
  term: string;
  source: "seed" | "mined" | "llm";
  state: "active" | "retired";
  newUniqueTotal: number;
  observedUniqueTotal: number;
  emailResolvedTotal: number;
  emailZeroStreak: number;
  criticReason: string;
  retiredReason: string;
  lastUsedAtIso: string;
}

export interface KeywordCorpusRejectionView {
  term: string;
  reason: string;
  rejectedAtIso: string;
}

export interface CampaignKeywordCorpusEnvelope {
  ok: boolean;
  campaignId: string;
  generation: number;
  updatedAtIso: string;
  activeCount: number;
  rows: KeywordCorpusRowView[];
  // W90-R3: 크리틱 거부 이력(유계). 우주에 없는 term 이라 rows 와 별개 축이다.
  rejections: KeywordCorpusRejectionView[];
}

export const getCampaignKeywordCorpus = (payload: { campaignId: string }) =>
  callFluCallable<CampaignKeywordCorpusEnvelope>("getCampaignKeywordCorpus", payload);

export const listScpLifecycleProfiles = (payload: DatasetPagePayload = {}) =>
  callFluCallable<DatasetPageEnvelope>("listScpLifecycleProfiles", payload);

export interface ListScpQualificationQueuePayload extends FluCallablePayload {
  queue: "qualification";
  programIds?: string[];
  cursor?: string;
  pageSize?: number;
  filters?: Record<string, unknown>;
}

export interface ScpQualificationQueueCard {
  id: string;
  queue: "qualification";
  canonicalProgramId: string;
  programLabel: string;
  canonicalIdentityHash: string;
  lifecycleProfileId: string;
  state: string;
  verdict: "pass" | "fail" | "pending" | "identity_conflict";
  automationBlocked: boolean;
  automationBlockReasonCode: "identity_conflict_human_required" | null;
  reasons: string[];
  sourceRefs: {
    all: string[];
    applications: string[];
    sheetRows: string[];
    decisions: string[];
  };
  applicationIds: string[];
  sheetRowRefs: string[];
  decisionRefs: string[];
  timestamps: string[];
  metricSnapshots: Array<Record<string, unknown>>;
  verdictEvidence: {
    pass: string[];
    fail: string[];
    pending: string[];
  };
  capabilityFlags: {
    canJudgeQualification: boolean;
    canPrepareResultMail: boolean;
    canIssueOneLink: boolean;
    canRunEncouragement: boolean;
    canAdvanceAutomation: boolean;
  };
}

export interface ListScpQualificationQueueEnvelope extends FluCallableEnvelope {
  ok: true;
  queue: "qualification";
  rows: ScpQualificationQueueCard[];
  counts: {
    returned: number;
    total: number;
    byProgram: Record<string, number>;
  };
  pageInfo: { limit: number; truncated: boolean; nextCursor: string | null };
  cache: { generatedAtIso: string; maxAgeSeconds: number };
}

export const listScpQualificationQueue = (
  payload: ListScpQualificationQueuePayload,
) =>
  callFluCallable<ListScpQualificationQueueEnvelope>(
    "listScpQualificationQueue",
    payload,
  );
export const listCampaigns = (payload: DatasetPagePayload = {}) =>
  callFluCallable<DatasetPageEnvelope>("listCampaigns", payload);
export const listCommunityPosts = (payload: DatasetPagePayload = {}) =>
  callFluCallable<DatasetPageEnvelope>("listCommunityPosts", payload);
export const listConversations = (payload: DatasetPagePayload = {}) =>
  callFluCallable<DatasetPageEnvelope>("listConversations", payload);

// "미답장 인박스" (2026-09-26, 헤세 요청) — scp 사서함 대화 중 사람 답장이 필요한 것만 모은
// 전용 큐(functions/read.ts listUnrepliedInboxHandler). 서버가 이미 RBAC·조직 스코프·
// manual-reply 재검증을 끝낸 뒤 내려주는 행만 받는다 — 클라이언트는 Firestore를 직접 보지
// 않는다(SEC-P0-004).
export interface ListUnrepliedInboxPayload extends FluCallablePayload {
  limit?: number;
  /** Flu conversation org-filter round 3: resumes a bounded scan window past pageInfo.nextCursor
   * from a previous call — see UnrepliedInboxEnvelope.pageInfo's doc comment. */
  cursor?: string;
}

export interface UnrepliedInboxRow {
  id: string;
  creatorId?: string;
  creatorName?: string;
  creatorEmail?: string;
  creatorHandle?: string;
  creatorAvatar?: string;
  lastMessage?: string;
  lastMessageAtIso?: string;
  lastInboundAtIso?: string;
  autoReplyStatus?: string;
  /** 보류 사유 — humanGate 판정 원문(예: 협상/통화금액·계약·감사인사 등). 없으면 부재. */
  autoReplyBlockedReason?: string;
  /** 사람 검수용 참고 초안. draft_only 상태일 때만 온다. */
  humanDraftSuggestion?: string;
  humanDraftSuggestionKr?: string;
  programTitle?: string;
  campaignTitle?: string;
  orgId?: string;
}

export interface UnrepliedInboxEnvelope extends FluCallableEnvelope {
  ok: true;
  queue: "unreplied_inbox";
  rows: UnrepliedInboxRow[];
  // `total` is only the count of in-scope candidates found within THIS request's bounded scan
  // window — a lower bound, not the true queue size, whenever pageInfo.truncated/nextCursor say
  // more remain (functions/read.ts listUnrepliedInboxHandler UNREPLIED_INBOX_MAX_SCAN_PAGES).
  counts: { returned: number; total: number };
  // Flu conversation org-filter round 3: nextCursor resumes the scan exactly where this window
  // ended (server: encodePageCursor) — a sparse-scoped caller's rows can sit behind hundreds of
  // other orgs'/accounts' rows with no way to reach them otherwise. null once the scan reaches the
  // true end of the collection.
  pageInfo: { limit: number; truncated: boolean; nextCursor: string | null };
  cache: { generatedAtIso: string; maxAgeSeconds: number };
}

export const listUnrepliedInbox = (payload: ListUnrepliedInboxPayload = {}) =>
  callFluCallable<UnrepliedInboxEnvelope>("listUnrepliedInbox", payload);

export type ChatAutoCasePermitState =
  | "default_off"
  | "candidate"
  | "armed"
  | "disarmed"
  | "stale_pin"
  | "eval_failed";

export type ChatAutoCasePermitEvalStatus =
  | "missing"
  | "passed"
  | "failed"
  | "unavailable"
  | "expired";

export interface ChatAutoNeedsReviewCandidate {
  caseId: string;
  title: string;
  reasonCode: string;
  clampReasonIds: string[];
}

export interface ChatAutoCasePermitStatusRow {
  caseId: string;
  caseTitle: string;
  caseDescription: string;
  state: ChatAutoCasePermitState;
  armed: boolean;
  counterFloor: 20;
  counters: {
    consecutiveHumanUneditedApprovedSent: number;
    totalHumanUneditedApprovedSent: number;
    unavailableEvidenceCount: number;
  };
  pins: {
    casebookHash: string;
    casebookMatchesCurrent: boolean;
    modelVersion: string;
    modelMatchesCurrent: boolean;
  };
  eval: {
    status: ChatAutoCasePermitEvalStatus;
    runId: string | null;
    evaluatedAtIso: string | null;
    expiresAtIso: string | null;
    heldoutTotal: number;
    heldoutPassed: number;
    rerollTotal: number;
    rerollStable: number;
    transports: string[];
    estimatedCostUsd: number;
  };
  lastDisarmReason: string | null;
  caseCandidates: ChatAutoNeedsReviewCandidate[];
  /** Public template reply text (functions/chatCasebook.ts autoReplyTemplate.template), or null
   *  when the case has no template / it can't render. */
  replyText: string | null;
}

export interface ChatAutoCasePermitStatusEnvelope extends FluCallableEnvelope {
  ok: true;
  rows: ChatAutoCasePermitStatusRow[];
  cache: { generatedAtIso: string; maxAgeSeconds: number };
  behaviorLog: Record<string, unknown>;
}

export interface GetChatAutoCasePermitStatusPayload extends FluCallablePayload {
  caseIds?: string[];
}

export interface SetChatAutoCasePermitArmingPayload extends FluCallablePayload {
  caseId: string;
  action: "arm" | "disarm";
  expectedCasebookHash: string;
  expectedModelVersion: string;
  expectedEvalRunId?: string;
  /** Required when arming an operator-saved reply: the saved-reply revisionHash the operator confirmed. */
  expectedReplyRevisionHash?: string;
  expectedCounterFloor: 20;
  /** Super-admin-only exception to the evidence-count floor; the server still verifies every
   * current eval, source, model, casebook, and transport requirement. */
  operatorOverride?: boolean;
  /** Required with operatorOverride; server accepts a trimmed 10–300 character audit reason. */
  overrideReason?: string;
}

export interface RunChatAutoCasePermitEvalPayload extends FluCallablePayload {
  caseIds: string[];
  confirm: `RUN_CHAT_AUTO_CASE_PERMIT_EVAL:${string}`;
  bypassGatewayCache: true;
}

export interface RunChatAutoCasePermitEvalEnvelope extends ChatAutoCasePermitStatusEnvelope {
  runIds: string[];
}

export interface ListChatAutoCaseDecisionLedgerPayload extends FluCallablePayload {
  caseId?: string;
  cursor?: string;
  limit?: number;
}

export interface ChatAutoCaseDecisionLedgerEnvelope extends FluCallableEnvelope {
  ok: true;
  rows: Array<Record<string, unknown>>;
  pageInfo: { limit: number; truncated: boolean; nextCursor: string | null };
  behaviorLog: Record<string, unknown>;
}

export const getChatAutoCasePermitStatus = (
  payload: GetChatAutoCasePermitStatusPayload = {},
) =>
  callFluCallable<ChatAutoCasePermitStatusEnvelope>(
    "getChatAutoCasePermitStatus",
    payload,
  );

export const setChatAutoCasePermitArming = (
  payload: SetChatAutoCasePermitArmingPayload,
) =>
  callFluCallable<ChatAutoCasePermitStatusEnvelope>(
    "setChatAutoCasePermitArming",
    payload,
  );

export const runChatAutoCasePermitEval = (
  payload: RunChatAutoCasePermitEvalPayload,
) =>
  callFluCallable<RunChatAutoCasePermitEvalEnvelope>(
    "runChatAutoCasePermitEval",
    payload,
  );

export const listChatAutoCaseDecisionLedger = (
  payload: ListChatAutoCaseDecisionLedgerPayload = {},
) =>
  callFluCallable<ChatAutoCaseDecisionLedgerEnvelope>(
    "listChatAutoCaseDecisionLedger",
    payload,
  );

// Casebook snapshot (2026-09-28, "simplify in place" direction, owner-approved): replaces the old
// P1/P2 getChatAutoCaseSendHistory (paginated two-source drilldown) + getChatAutoCaseUnhandledStats
// (historical denied-decision count) pair with ONE read callable. See
// functions/chatAutoCasePermitCallables.ts's own doc comment for the full rationale.
export interface ChatAutoCaseCommittedSendRow {
  id: string;
  conversationId: string | null;
  sender: "human" | "ai" | null;
  approval: "approved" | "rejected" | "skipped" | "unknown" | null;
  deliveryState: "sent" | "mock_sent" | "blocked" | "failed" | "skipped_duplicate" | "unknown" | null;
  providerConfirmed: boolean;
  bounced: boolean;
  complained: boolean;
  optedOut: boolean;
  suppressed: boolean;
  atIso: string | null;
}

export type ChatAutoCasebookReplyTextState = "auto_ok" | "needs_review" | "non_auto_ok" | "unavailable";

export interface ChatAutoCasebookReplyText {
  state: ChatAutoCasebookReplyTextState;
  /** Template text (pre send-time link substitution), or null for the non_auto_ok state. */
  text: string | null;
  /** Korean UI label for the state. */
  label: string | null;
  /** Whether an administrator may save a human-reviewed override for this case. */
  editable: boolean;
  /** Whether the server permits an AI suggestion for this case. */
  suggestionAllowed: boolean;
  source: "static" | "operator_override" | "none";
  revision: number;
  revisionHash: string;
  casebookHash: string;
  unavailableReason: string | null;
  reviewRequired: boolean;
  automaticStatus: "blocked" | "human_review_only" | "permit_gated" | "no_reply";
}

/** Casebook inbox (2026-10-01, contract §1): per-case "does a human need to look at this" signal.
 *  Optional on purpose — an older server omits it, and the UI then treats every row as needsHuman. */
export type ChatAutoCasebookAttentionAutoReply = "healthy" | "armed_unhealthy" | "off";

export interface ChatAutoCasebookAttention {
  autoReply: ChatAutoCasebookAttentionAutoReply;
  needsHuman: boolean;
  /** Stable reason codes, e.g. "not_armed", "eval_stale", "eval_expired", "pin_mismatch",
   *  "pending_while_armed", "blocked_case". */
  reasons: string[];
}

export type ChatAutoCasebookDefaultSuggestionStatus = "ready" | "stale" | "pending" | "failed" | "not_applicable";

/** A background-precomputed default reply suggestion. `text` is non-null only when status is "ready". */
export interface ChatAutoCasebookDefaultSuggestion {
  status: ChatAutoCasebookDefaultSuggestionStatus;
  text: string | null;
  generatedAtIso: string | null;
  modelId: string | null;
}

export interface ChatAutoCasebookReplyLink {
  token: string;
  label: string;
  url: string;
}

export type ChatAutoCasebookSnapshotRow = Omit<ChatAutoCasePermitStatusRow, "replyText"> & {
  replyText: ChatAutoCasebookReplyText;
  /** Unreplied-inbox rows currently attributed to this case (autoCaseId + autoCaseMessageRef ==
   *  conversation.lastMessageRef). A lower bound when pendingTotal.truncated is true. */
  pendingCount: number;
  /** Contract §1 additions — all optional so an older server response never crashes the console. */
  attention?: ChatAutoCasebookAttention;
  /** Link tokens this case's reply may use (no GUIDELINE_AMOUNT). */
  allowedLinkTokens?: string[];
  defaultSuggestion?: ChatAutoCasebookDefaultSuggestion;
};

export interface GetChatAutoCasebookSnapshotPayload extends FluCallablePayload {
  /** When given, the response also includes the latest 20 provider-confirmed AI sends for this
   *  case. Selecting a case never blocks on the pending scan — the callable never runs it (see
   *  ChatAutoCasebookSnapshotEnvelope.pendingTotal below): it only ever reads a doc a scheduled
   *  job (every 15 minutes) precomputes server-side. */
  selectedCaseId?: string;
}

/** casebook snapshot 504 hotfix (2026-09-29): "missing" means no scheduled precompute has ever
 *  written a doc for this caller's scope yet (show "계산 중"); "stale" means the last precompute
 *  is older than 45 minutes (show the numbers anyway, with "N분 전 기준" from computedAtIso — this
 *  is not an error). Neither state should ever render as a red error banner. */
export type ChatAutoCasebookPendingStatus = "fresh" | "stale" | "missing";

export type ChatAutoCasebookUnclassifiedReason = "never_classified" | "unknown_case" | "stale_stamp";

/** Contract §1: explains pendingTotal.count = managed cases + closed + unclassified. Only
 *  status "available" carries trustworthy numbers (written by the new precompute). */
export interface ChatAutoCasebookPendingBreakdown {
  status: "available" | "unavailable";
  managedCaseTotal: number;
  closedCaseCount: number;
  unclassified: {
    total: number;
    byReason: Record<ChatAutoCasebookUnclassifiedReason, number>;
    /** How many of byReason.never_classified arrived before case stamping launched (2026-09-28) —
     *  mail the classifier could never have stamped. Optional: absent / null on an older server. */
    neverClassifiedBeforeStampLaunch?: number | null;
  };
  /** 답장 불필요 overlay (0.6.105): fresh-stamped pending in no-reply-needed cases (부재중 등) + the
   *  closed (종결 인사) count. Display only — never subtracted from pendingTotal.count on the server.
   *  Optional: absent on an older server (UI keeps the plain total headline). */
  noReplyNeeded?: { total: number; byCaseId: Record<string, number> };
}

export interface ChatAutoCasebookSnapshotEnvelope extends FluCallableEnvelope {
  ok: true;
  rows: ChatAutoCasebookSnapshotRow[];
  /** Program-wide pending backlog headline count (unreplied-inbox rules, not a historical decision
   *  count) — always the LAST value a scheduled precompute wrote, never a live scan. truncated:true
   *  means that scan hit its cap — show "count+", never an exact-looking number. */
  pendingTotal: {
    count: number;
    truncated: boolean;
    exact: boolean;
    countStatus: "exact" | "lower_bound" | "unknown";
    status: ChatAutoCasebookPendingStatus;
    /** When the precomputed doc was written, or null when status is "missing". */
    computedAtIso: string | null;
    asOfIso: string | null;
  };
  /** Pending rows with no (or a stale) autoCaseId stamp — the "미분류" bucket. */
  unclassifiedPendingCount: number;
  /** Optional: absent from an older server (the UI then keeps the legacy single-number headline). */
  pendingBreakdown?: ChatAutoCasebookPendingBreakdown;
  /** Optional: link catalog for the reply editor's "링크 넣기" control. */
  replyLinkCatalog?: ChatAutoCasebookReplyLink[];
  selected: { caseId: string; sends: ChatAutoCaseCommittedSendRow[] } | null;
  cache: { generatedAtIso: string; maxAgeSeconds: number };
  behaviorLog: Record<string, unknown>;
}

// This console does not support super_admin "대신 보기" preview — the server rejects any
// viewAsUserId/viewAsEmail payload outright (see the backend's own doc comment). Never pass those
// fields here.
export const getChatAutoCasebookSnapshot = (
  payload: GetChatAutoCasebookSnapshotPayload = {},
) =>
  callFluCallable<ChatAutoCasebookSnapshotEnvelope>(
    "getChatAutoCasebookSnapshot",
    payload,
  );

export interface SaveChatAutoCaseReplyPayload extends FluCallablePayload {
  caseId: string;
  text: string;
  expectedRevision: number;
  expectedRevisionHash: string;
}

export interface SaveChatAutoCaseReplyEnvelope extends FluCallableEnvelope {
  ok: true;
  caseId: string;
  replyText: ChatAutoCasebookReplyText;
  casebookHash: string;
  permitState: "disarmed" | "not_armable";
  evalStatus: "invalidated" | "not_applicable";
}

/** Persist a human-reviewed reply override. This never sends or arms a case. */
export const saveChatAutoCaseReply = (payload: SaveChatAutoCaseReplyPayload) =>
  callFluCallable<SaveChatAutoCaseReplyEnvelope>("saveChatAutoCaseReply", payload);

export interface ResetChatAutoCaseReplyPayload extends FluCallablePayload {
  caseId: string;
  expectedRevision: number;
  expectedRevisionHash: string;
}

/** Restore the server's static casebook reply. This never arms or sends a case. */
export const resetChatAutoCaseReply = (payload: ResetChatAutoCaseReplyPayload) =>
  callFluCallable<SaveChatAutoCaseReplyEnvelope>("resetChatAutoCaseReply", payload);

export interface SuggestChatAutoCaseReplyPayload extends FluCallablePayload {
  caseId: string;
  operatorInstruction?: string;
  expectedRevision: number;
  expectedRevisionHash: string;
}

export interface SuggestChatAutoCaseReplyEnvelope extends FluCallableEnvelope {
  ok: true;
  caseId: string;
  /** Sanitized suggestion only; the callable never persists it. */
  text: string;
  reason: string;
  /** Literal normalized provider name returned by the server. */
  provider: string;
  /** True only when the server returned a verified, non-expired cached proposal. */
  cacheHit: boolean;
  modelId: string;
  transport: string;
}

/** Request an unsaved suggestion. Applying it in the UI only fills the human editor. */
export const suggestChatAutoCaseReply = (payload: SuggestChatAutoCaseReplyPayload) =>
  callFluCallable<SuggestChatAutoCaseReplyEnvelope>("suggestChatAutoCaseReply", payload);

// Casebook inbox (2026-10-01, contract §2): live, paged list of the pending conversations the
// snapshot counts as "미분류". Like the snapshot it is blocked entirely during viewAs (the server
// rejects it too), so this wrapper never passes viewAsUserId/viewAsEmail.
export interface ListChatAutoCasebookUnclassifiedPayload extends FluCallablePayload {
  reason?: ChatAutoCasebookUnclassifiedReason | "all";
  cursor?: string | null;
  /** 1..50, server default 25. */
  limit?: number;
}

export interface ChatAutoCasebookUnclassifiedRow {
  conversationId: string;
  reason: ChatAutoCasebookUnclassifiedReason;
  creatorName: string | null;
  creatorEmailMasked: string | null;
  subject: string | null;
  lastInboundAtIso: string | null;
  mailAccountLabel: string | null;
  /** True for mail received before case stamping launched. Optional: absent on an older server. */
  legacy?: boolean;
}

export interface ChatAutoCasebookUnclassifiedEnvelope extends FluCallableEnvelope {
  ok: true;
  rows: ChatAutoCasebookUnclassifiedRow[];
  nextCursor: string | null;
  exhausted: boolean;
  /** Live scan time — NOT the snapshot's cached read time. */
  scannedAtIso: string;
  behaviorLog: Record<string, unknown>;
}

export const listChatAutoCasebookUnclassified = (
  payload: ListChatAutoCasebookUnclassifiedPayload = {},
) =>
  callFluCallable<ChatAutoCasebookUnclassifiedEnvelope>(
    "listChatAutoCasebookUnclassified",
    payload,
  );

// Casebook inbox (2026-10-03): "실제 건 보기" — live, newest-first, paged list of the pending
// conversations behind ONE card's "대기 중 N건" (a casebook case id, "unclassified" or
// "no_reply_needed"). Same rules as the unclassified list: blocked during viewAs (the server rejects
// it too, so this wrapper never passes viewAsUserId/viewAsEmail), no direct Firestore read. The
// payload carries no message body/subject — only the server-generated Korean summary.
export interface ListChatAutoCasebookCaseItemsPayload extends FluCallablePayload {
  caseId: string;
  cursor?: string | null;
  /** 1..50, server default 25. */
  limit?: number;
}

export interface ChatAutoCasebookCaseItemRow {
  conversationId: string;
  caseId: string | null;
  bucket: "managed" | "closed" | "unclassified";
  unclassifiedReason: ChatAutoCasebookUnclassifiedReason | null;
  creatorName: string | null;
  creatorHandle: string | null;
  creatorEmailMasked: string | null;
  programLabel: string | null;
  lastInboundAtIso: string | null;
  summaryKr: string | null;
  inboundIntent: string | null;
  inboundIntentLabel: string | null;
  replyState: "queued" | "held";
  holdReasonLabel: string | null;
}

export interface ChatAutoCasebookCaseItemsEnvelope extends FluCallableEnvelope {
  ok: true;
  caseId: string;
  rows: ChatAutoCasebookCaseItemRow[];
  nextCursor: string | null;
  exhausted: boolean;
  /** Live scan time — NOT the snapshot's cached read time. */
  scannedAtIso: string;
  behaviorLog: Record<string, unknown>;
}

export const listChatAutoCasebookCaseItems = (payload: ListChatAutoCasebookCaseItemsPayload) =>
  callFluCallable<ChatAutoCasebookCaseItemsEnvelope>("listChatAutoCasebookCaseItems", payload);

// /chat/auto 검토 보드 (2026-10-05): READ-ONLY review board. Three independent row states — sendBatch
// (this automated batch only), question, draft (review only, never sendable). No send/save action
// exists for it. Blocked during viewAs like the other casebook lists (the server rejects it too).
// The payload carries no body/subject/address — only masked email, a ≤200-char server summary
// (omitted for protected / AI-off rows) and the conversation id used for the /chat link.
export type ChatAutoReviewFieldStatus = "confirmed" | "partial" | "unknown";
export type ChatAutoReviewBucket = "excluded" | "operator_judgment" | "final_safety_wait";
export type ChatAutoReviewNextAction =
  | "operator_owned_ai_off"
  | "suppressed"
  | "recent_real_reply_found"
  | "queued"
  | "we_replied_last"
  | "not_pending"
  | "org_automation_off"
  | "exclude_no_reply"
  | "vendor_auto"
  | "closing_no_reply"
  | "sender_check"
  | "discontinued"
  | "original_missing_judgment"
  | "personal_review_status_check"
  | "operator_judgment"
  | "policy_guide_draft_review"
  | "participation_guide_draft_review"
  | "reward_guide_draft_review"
  | "final_safety_check";
export type ChatAutoReviewTemplateId = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "greeting_a" | "rate_policy";
export interface ChatAutoReviewDerived<T> { status: ChatAutoReviewFieldStatus; value: T; reason: string | null }
export interface ChatAutoReviewBoardRow {
  rowKey: string;
  conversationId: string;
  conversationTail: string;
  primaryCaseId: string | null;
  primaryCaseLabel: string | null;
  evidenceCaseIds: string[];
  protected: boolean;
  protectedReasons: string[];
  sendBatch: { bucket: ChatAutoReviewBucket; reason: string | null; reasonLabel: string | null; allReasons: string[] };
  nextAction: ChatAutoReviewNextAction;
  nextActionLabel: string;
  classification: { kind: "auto" | "operator_label"; label: string };
  claims: string[];
  newInboundSinceJudgment: boolean;
  question: { status: "unresolved" | "not_needed" | "unknown"; label: string; questionCount: number | null; recommendedHandling: string };
  draft: {
    status: "system_default" | "none" | "not_allowed";
    draftAllowed: boolean;
    reason: string | null;
    caseId: string | null;
    label: string;
    sourceLabel: string | null;
    basisLabel: string | null;
    text: string | null;
    suggestedTemplateId: ChatAutoReviewTemplateId | null;
    sendable: false;
    sendableLabel: string;
  };
  summary: ChatAutoReviewDerived<string | null> & { source: "body" | "summary_fallback" | "unverified" | "none"; sourceLabel: string };
  realReplies: ChatAutoReviewDerived<number> & {
    latestAtIso: string | null;
    latestAfterInbound: boolean;
    possibleCount: number;
    evidence: Array<{ kind: string; kindLabel: string; sentAtIso: string | null; sameConversation: boolean; conversationTail: string | null }>;
  };
  queued: ChatAutoReviewDerived<boolean>;
  suppressed: ChatAutoReviewDerived<boolean>;
  aiActive: ChatAutoReviewDerived<boolean | null>;
  orgAutomationOff: boolean;
  identity: ChatAutoReviewDerived<"verified" | "review_required" | "missing"> & { fromMatches: boolean };
  registration: ChatAutoReviewDerived<"not_applicable" | "registered" | "unknown">;
  latestInboundAtIso: string | null;
  lastMessageSide: "creator" | "operator" | "unknown";
  creatorName: string | null;
  creatorHandle: string | null;
  creatorEmailMasked: string | null;
  programLabel: string | null;
  unknowns: string[];
  grouping: { kind: "verified_sender" | "single_conversation"; label: string };
  conversations: Array<{ conversationId: string; conversationTail: string; primaryCaseId: string | null; primaryCaseLabel: string | null; latestInboundAtIso: string | null; protected: boolean }>;
}
export interface ListChatAutoReviewBoardPayload extends FluCallablePayload {
  cursor?: string | null;
  /** 1..50, server default 25. */
  limit?: number;
}
export interface ChatAutoReviewBoardEnvelope extends FluCallableEnvelope {
  ok: true;
  rows: ChatAutoReviewBoardRow[];
  counts: {
    conversations: number;
    people: number;
    protectedConversations: number;
    byBucket: Record<ChatAutoReviewBucket, number>;
  };
  scope?: { mailbox: "scp"; orgLabel: string; period: string; population: string };
  nextCursor: string | null;
  exhausted: boolean;
  verifiedAtIso: string;
  behaviorLog: Record<string, unknown>;
}
export const listChatAutoReviewBoard = (payload: ListChatAutoReviewBoardPayload) =>
  callFluCallable<ChatAutoReviewBoardEnvelope>("listChatAutoReviewBoard", payload);

// Casebook inbox (2026-10-01, contract §3): read-only preview of a reply with `{{TOKEN}}` links
// resolved by the SAME server resolver the dispatch path uses. No model call, no write.
export interface PreviewChatAutoCaseReplyPayload extends FluCallablePayload {
  caseId: string;
  text: string;
}

export interface PreviewChatAutoCaseReplyEnvelope extends FluCallableEnvelope {
  ok: true;
  caseId: string;
  valid: boolean;
  errorMessage: string | null;
  resolvedText: string | null;
  links: ChatAutoCasebookReplyLink[];
}

export const previewChatAutoCaseReply = (payload: PreviewChatAutoCaseReplyPayload) =>
  callFluCallable<PreviewChatAutoCaseReplyEnvelope>("previewChatAutoCaseReply", payload);

// "보류 N건 지금 보내기" (case-backlog-send, 2026-09-28): per-case held-backlog count + scoped
// send-now for an ARMED case (functions/chatAutoCaseBacklogSend.ts). Like the rest of this console,
// viewAs is blocked entirely client-side (PermitCasePanel/CasebookSection never mount while viewing
// as — see getChatAutoCasebookSnapshot's own doc comment above), so these wrappers never pass
// viewAsUserId/viewAsEmail even though the count callable's backend also accepts them for other
// (non-console) callers.
export type ChatAutoCaseHeldBacklogSkipped = {
  takenOver: number;
  alreadyReplied: number;
  laneLocked: number;
  aiInactive: number;
  denied: number;
  stale: number;
  recentlyDenied: number;
  orgExcluded: number;
  manualReplyDetected: number;
  caseMismatch: number;
  humanReviewHeld: number;
};

export interface GetChatAutoCaseHeldBacklogCountPayload extends FluCallablePayload {
  caseId: string;
  /** Inspect exactly one thread using the same eligibility gates. */
  conversationId?: string;
}

export interface GetChatAutoCaseHeldBacklogCountEnvelope extends FluCallableEnvelope {
  ok: true;
  caseId: string;
  heldCount: number;
  scanCap: number;
  /** true when the scan hit scanCap before exhausting the window — heldCount is then a LOWER bound
   *  ("N+건"), never an exact count. */
  scannedCapped: boolean;
  behaviorLog: Record<string, unknown>;
}

export const getChatAutoCaseHeldBacklogCount = (
  payload: GetChatAutoCaseHeldBacklogCountPayload,
) =>
  callFluCallable<GetChatAutoCaseHeldBacklogCountEnvelope>(
    "getChatAutoCaseHeldBacklogCount",
    payload,
  );

export interface SendChatAutoCaseHeldBacklogNowPayload extends FluCallablePayload {
  caseId: string;
  /** Process only this eligible thread; omit pagination in this mode. */
  conversationId?: string;
  limit?: number;
  cursor?: string;
}

export interface SendChatAutoCaseHeldBacklogNowEnvelope extends FluCallableEnvelope {
  ok: true;
  caseId: string;
  planned: number;
  queued: number;
  scanned: number;
  skipped: ChatAutoCaseHeldBacklogSkipped;
  denyReasons: Record<string, number>;
  pagesProcessed: number;
  /** Non-null when more of the backlog remains — pass back as `cursor` to continue. */
  nextCursor: string | null;
  /** "deadline" only when the wall-clock budget is why the sweep stopped (never confuse with a
   *  genuinely exhausted backlog, which is nextCursor:null with stoppedReason:null). */
  stoppedReason: "deadline" | null;
  behaviorLog: Record<string, unknown>;
}

export const sendChatAutoCaseHeldBacklogNow = (
  payload: SendChatAutoCaseHeldBacklogNowPayload,
) =>
  callFluCallable<SendChatAutoCaseHeldBacklogNowEnvelope>(
    "sendChatAutoCaseHeldBacklogNow",
    payload,
  );

/** W62-2: apply 완료·영상 미제출자 목록. 응답에 수신자 주소가 없다(PII 비노출 설계). */
export type ApplicationVideoPendingRow = {
  applicationId: string;
  programId: string;
  appliedAtIso: string;
  daysSinceApply: number | null;
  confirmationDelivery: "delivered" | "dead_letter" | "pending" | "unknown";
  availableAction: "nudge" | "resend_confirmation" | "blocked";
  lastReminderAtIso: string;
  reminderCount: number;
  cooldownUntilIso: string;
  creatorHandle: string;
  creatorDisplayName: string;
};
export type ApplicationVideoPendingEnvelope = {
  ok: boolean;
  cooldownDays: number;
  /** W62c-C3: 발송 워커가 배선됐는가. 화면은 이 **서버 사실**로 버튼을 낸다(클라 상수 복제 금지). */
  reminderSendEnabled?: boolean;
  counts: { pending: number; nudgeEligible: number; resendEligible: number; blocked: number; inCooldown: number };
  rows: ApplicationVideoPendingRow[];
};
export const listApplicationVideoPending = (payload: { limit?: number } = {}) =>
  callFluCallable<ApplicationVideoPendingEnvelope>("listApplicationVideoPending", payload);
export const enqueueApplicationVideoReminderMail = (payload: { applicationId: string }) =>
  callFluCallable<{ ok: boolean; queued: boolean; cooldownUntilIso: string }>(
    "enqueueApplicationVideoReminderMail",
    payload,
  );

// W72 C-1 — 코호트 × 회차 문안 매핑.
//   상한·레인 캡·실발송 여부는 **서버가 내려주는 천장**을 쓴다. 화면이 3/10/5 를 복제하면
//   코드 천장이 바뀌었을 때 화면만 옛 값을 말한다.
export type NudgeSequenceCohortView = {
  cohort: string;
  maxSends: number;
  cadenceDays: number;
  dailyCap: number;
  liveSend: boolean;
  sequence: Record<string, string>;
};
export type NudgeSequenceConfigEnvelope = {
  ok: boolean;
  enabled: boolean;
  cadenceDays: number;
  cohorts: NudgeSequenceCohortView[];
  templateOptions: Array<{ key: string; status: string; sendable: boolean }>;
  docPath: string;
  updatedAtIso: string;
  actorRole: string;
  // [헤세 2026-09-03] 세 코호트 합산 배출 상한. null = 미설정(코호트별 캡만 적용).
  totalDailyCap: number | null;
  totalDailyCapCeiling: number;
  // 0.6.110: 프로그램/캠페인별 문안 매핑 오버라이드(서버 파서를 통과한 활성 값).
  programOverrides: Array<{ id: string; enabled: boolean; cohorts: Record<string, Record<string, string>> }>;
  programOptions: Array<{ id: string; label: string; kind: "program" | "campaign" }>;
};
export const getScpNudgeSequenceConfig = () =>
  callFluCallable<NudgeSequenceConfigEnvelope>("getScpNudgeSequenceConfig", {});
export type NudgeSequenceConfigPayload =
  | {
    enabled: boolean;
    cadenceDays: number;
    cohorts: Record<string, { sequence: Record<string, string> }>;
    totalDailyCap: number | null;
  }
  | {
    totalDailyCapOnly: true;
    expectedUpdatedAtIso: string;
    cohortDailyCaps?: Record<string, number>;
    totalDailyCap: number | null;
  };

export const saveScpNudgeSequenceConfig = (payload: NudgeSequenceConfigPayload) =>
  callFluCallable<{
    ok: boolean; enabled: boolean; mappedSequences: number; updatedAtIso: string; totalDailyCap: number | null;
  }>(
    "saveScpNudgeSequenceConfig",
    payload,
  );
export const saveScpNudgeProgramOverride = (payload: {
  programKey: string;
  enabled: boolean;
  remove?: boolean;
  expectedUpdatedAtIso: string;
  cohorts: Record<string, { sequence: Record<string, string> }>;
}) =>
  callFluCallable<{
    ok: boolean; programKey: string; enabled: boolean; removed: boolean;
    mappedSequences: number; globalEnabled: boolean; updatedAtIso: string;
  }>("saveScpNudgeProgramOverride", payload);
export const listPrograms = (payload: DatasetPagePayload = {}) =>
  callFluCallable<DatasetPageEnvelope>("listPrograms", payload);
export const listProgramApplications = (payload: DatasetPagePayload = {}) =>
  callFluCallable<DatasetPageEnvelope>("listProgramApplications", payload);
export const listProgramSheetLeads = (payload: DatasetPagePayload = {}) =>
  callFluCallable<DatasetPageEnvelope>("listProgramSheetLeads", payload);
export const listEscalations = (payload: DatasetPagePayload = {}) =>
  callFluCallable<DatasetPageEnvelope>("listEscalations", payload);
export const listReviews = (payload: DatasetPagePayload = {}) =>
  callFluCallable<DatasetPageEnvelope>("listReviews", payload);
export const listSubmissions = (payload: DatasetPagePayload = {}) =>
  callFluCallable<DatasetPageEnvelope>("listSubmissions", payload);
export const listCandidatePool = (payload: DatasetPagePayload = {}) =>
  callFluCallable<DatasetPageEnvelope>("listCandidatePool", payload);
export const listCreatorComments = (payload: DatasetPagePayload = {}) =>
  callFluCallable<DatasetPageEnvelope>("listCreatorComments", payload);

export interface ScpLifecycleProfilePayload extends FluCallablePayload {
  profileId?: string;
  aliasId?: string;
  kind?: string;
  value?: unknown;
  email?: string;
  leadId?: string;
  creatorId?: string;
  submissionId?: string;
  videoId?: string;
  channelId?: string;
  trackingId?: string;
  limit?: number;
}

export const refreshScpLifecycleProfiles = (payload: FluCallablePayload = {}) =>
  callFluCallable("refreshScpLifecycleProfiles", payload);
export const diffScpLifecycleProfiles = (payload: FluCallablePayload = {}) =>
  callFluCallable("diffScpLifecycleProfiles", payload);
export const getScpLifecycleProfile = (
  payload: ScpLifecycleProfilePayload = {},
) => callFluCallable("getScpLifecycleProfile", payload);
export const getScpLifecycleVideoHistory = (
  payload: ScpLifecycleProfilePayload = {},
) => callFluCallable("getScpLifecycleVideoHistory", payload);
export const resolveScpLifecycleProfile = (
  payload: ScpLifecycleProfilePayload = {},
) => callFluCallable("resolveScpLifecycleProfile", payload);
export const listScpLifecycleRefreshOutbox = (
  payload: FluCallablePayload = {},
) => callFluCallable("listScpLifecycleRefreshOutbox", payload);
export const processScpLifecycleRefreshOutbox = (
  payload: FluCallablePayload = {},
) => callFluCallable("processScpLifecycleRefreshOutbox", payload);

export interface GemGrantPayload extends FluCallablePayload {
  grantId?: string;
  id?: string;
  profileId?: string;
  leadId?: string;
  creatorId?: string;
  email?: string;
  handle?: string;
  channelId?: string;
  uid?: string;
  submissionId?: string;
  videoId?: string;
  trackingId?: string;
  amountGems?: number;
  fridayAtIso?: string;
  scheduledForIso?: string;
  reason?: string;
  paymentRef?: string;
  paidAtIso?: string;
  status?: string;
  limit?: number;
}

export const scheduleGemGrant = (payload: GemGrantPayload = {}) =>
  callFluCallable("scheduleGemGrant", payload);
export const holdGemGrant = (payload: GemGrantPayload = {}) =>
  callFluCallable("holdGemGrant", payload);
export const failGemGrant = (payload: GemGrantPayload = {}) =>
  callFluCallable("failGemGrant", payload);
export const markGemGrantPaid = (payload: GemGrantPayload = {}) =>
  callFluCallable("markGemGrantPaid", payload);
export const listGemGrants = (payload: GemGrantPayload = {}) =>
  callFluCallable("listGemGrants", payload);
// ── 댓글 인사이트 (P-comment-insights) ──────────────────────────────────────
export interface CommentInsight {
  sentimentCounts: { positive: number; neutral: number; negative: number };
  sentimentPct: { positive: number; neutral: number; negative: number };
  categories: Array<{ id: string; count: number }>;
  brandSafety: {
    flaggedCount: number;
    severeCount: number;
    flagRatio: number;
    flagged: boolean;
  };
  themes: string[];
  summary: string;
  sampleQuotes: string[];
  analyzedCount: number;
  commentCountAtAnalysis?: number;
}
export interface CreatorCommentInsight {
  creatorId: string;
  status: "ok" | "insufficient";
  validVideoCount: number;
  weightedSentiment: { positive: number; neutral: number; negative: number };
  flagRatio: number;
  flaggedVideoCount: number;
  recentVideoCount: number;
  updatedAtIso?: string;
}
export const listCreatorCommentInsights = (payload: DatasetPagePayload = {}) =>
  callFluCallable<DatasetPageEnvelope>("listCreatorCommentInsights", payload);
export const runCommentInsightsForVideo = (
  payload: FluCallablePayload & { videoId: string },
) => callFluCallable("runCommentInsightsForVideo", payload);

export type ProposalReasonCode =
  | "ad_fit"
  | "gameplay_relevance"
  | "audience_match"
  | "language_region_fit"
  | "comment_sentiment"
  | "creator_quality"
  | "recent_growth"
  | "manual_operator_signal";

export interface ProposalWhy {
  summary: string;
  reasonCodes: ProposalReasonCode[];
  positiveSignals: string[];
  cautionSignals: string[];
  sourceSignals: {
    adVerdict?: string;
    gameFit?: number | null;
    adConfidence?: number | null;
    adSignals?: string[];
    fitReasons?: string[];
    language?: string;
    audioAccent?: string;
    keywordTags?: string[];
    commentInsightSummary?: string;
    creatorCountry?: string;
    creatorLanguage?: string;
    followerCount?: number | null;
    emailResolved?: boolean;
  };
}

export interface ProposalLearningScore {
  proposalFit: number;
  confidence: "low" | "medium" | "high";
  explanation: string;
  matchedLearningPatterns: string[];
  negativeLearningPatterns: string[];
}

export interface AdProposal {
  proposalId: string;
  videoId: string;
  creatorId?: string;
  channelId?: string;
  creatorEmail: string;
  emailSource?: string;
  creatorName: string;
  youtubeUrl?: string;
  verdict: string;
  adSnapshot?: Record<string, unknown>;
  whyProposed?: ProposalWhy;
  learningSnapshot?: ProposalLearningScore;
  draftSubject: string;
  draftBody: string;
  draftSource: string;
  draftModel?: string;
  status: string;
  mode: "draft_only" | string;
  emailResolved: boolean;
  latestHumanDecision?: Record<string, unknown>;
  createdAtIso?: string;
  updatedAtIso?: string;
}

export interface AdProposalEnvelope extends FluCallableEnvelope {
  proposal?: AdProposal;
  humanGate?: { sends: boolean; requiresHumanApproval: boolean; note: string };
}
export type AdProposalFeedbackAction =
  "human_approved" | "human_rejected" | "human_edited";
export interface RecordAdProposalFeedbackPayload extends FluCallablePayload {
  videoId: string;
  action: AdProposalFeedbackAction;
  operatorReasonCodes?: string[];
  operatorNote?: string;
  draftChangedFields?: string[];
}
export interface RecordAdProposalFeedbackEnvelope extends FluCallableEnvelope {
  latestHumanDecision?: Record<string, unknown>;
  learningEvent?: Record<string, unknown>;
  kbNode?: { path?: string; id?: string };
  humanGate?: { sends: false; requiresHumanApproval: true; note: string };
}
export const createAdProposal = (
  payload: FluCallablePayload & { videoId: string },
) => callFluCallable<AdProposalEnvelope>("createAdProposal", payload);
export const recordAdProposalFeedback = (
  payload: RecordAdProposalFeedbackPayload,
) =>
  callFluCallable<RecordAdProposalFeedbackEnvelope>(
    "recordAdProposalFeedback",
    payload,
  );
export const listAdProposals = (
  payload: FluCallablePayload & { limit?: number } = {},
) => callFluCallable("listAdProposals", payload);
export const classifyFeedVideoAds = (
  payload: FluCallablePayload & { videoId?: string; limit?: number } = {},
) => callFluCallable("classifyFeedVideoAds", payload);
export const promoteDiscoveredCreators = (
  payload: FluCallablePayload & { limit?: number; minFollowers?: number } = {},
) => callFluCallable("promoteDiscoveredCreators", payload);
export interface VideoViewSeriesEnvelope extends FluCallableEnvelope {
  videoId?: string;
  series?: {
    videoId: string;
    points: Array<{
      date: string;
      views: number;
      likes: number;
      comments: number;
      dailyDeltaViews: number;
      growthRatePct: number;
    }>;
    totalViews: number;
    latestDailyDeltaViews: number;
    latestGrowthRatePct: number;
    dayCount: number;
    commentInsights?: {
      summary?: string;
      sentimentPct?: { positive: number; neutral: number; negative: number };
      analyzedCount?: number;
    } | null;
    updatedAtIso: string;
  } | null;
  monitor?: {
    status: string;
    lastAttemptAtIso?: string;
    lastSuccessAtIso?: string;
    lastSnapshotDate?: string;
    lastError?: string | null;
    lastErrorAtIso?: string | null;
    retryCount?: number;
  } | null;
}
export const runVideoViewSnapshots = (
  payload: FluCallablePayload & {
    videoId?: string;
    youtubeUrl?: string;
    submissionId?: string;
    limit?: number;
  } = {},
) => callFluCallable("runVideoViewSnapshots", payload);
export const getVideoViewSeries = (
  payload: FluCallablePayload & { videoId?: string; youtubeUrl?: string },
) => callFluCallable<VideoViewSeriesEnvelope>("getVideoViewSeries", payload);

export interface VideoViewRollupVideo {
  videoId: string;
  submissionId: string;
  creator: string;
  totalViews: number;
  latestDailyDeltaViews: number;
  publishedAtIso: string | null;
  submittedAtIso: string | null;
}
export interface VideoViewRollup {
  id: string;
  programId: string;
  campaignId: string;
  totalViews: number;
  videoCount: number;
  updatedAtIso: string;
  videos: VideoViewRollupVideo[];
}
export interface VideoViewRollupsEnvelope {
  ok: boolean;
  rollups: VideoViewRollup[];
}
export const getVideoViewRollups = (
  payload: FluCallablePayload & { programId?: string } = {},
) => callFluCallable<VideoViewRollupsEnvelope>("getVideoViewRollups", payload);
export const judgeVideoReviewMultimodal = (
  payload: FluCallablePayload & {
    submissionId?: string;
    youtubeUrl?: string;
  } = {},
) => callFluCallable("judgeVideoReviewMultimodal", payload);
export interface ConversationMessagesPayload extends DatasetPagePayload {
  conversationId: string;
  threadId?: string;
  contextKey?: string;
  programId?: string;
  campaignId?: string;
  conversationIds?: string[];
}
export interface ConversationMessagesEnvelope extends FluCallableEnvelope {
  ok: true;
  conversationId: string;
  threadId?: string;
  contextKey?: string;
  conversationIds?: string[];
  messages: Record<string, unknown>[];
  pageInfo: { limit: number; truncated: boolean; nextCursor: string | null };
  cache: {
    generatedAtIso: string;
    maxAgeSeconds: number;
    requestedKeys: ["conversationMessages"];
  };
}
export const listConversationMessages = (
  payload: ConversationMessagesPayload,
) =>
  callFluCallable<ConversationMessagesEnvelope>(
    "listConversationMessages",
    payload,
  );

export interface ConversationAttributionMutationPayload extends FluCallablePayload {
  conversationId: string;
  expectedVersion?: number;
  reason: string;
}
export interface ReclassifyConversationAttributionPayload extends ConversationAttributionMutationPayload {
  actionId: string;
  primaryBucket: "program" | "direct";
  programId?: string;
  campaignId?: string;
  dryRun?: boolean;
  actual?: boolean;
  confirm?: boolean;
  previewToken?: string;
  previewHash?: string;
}
export interface RevertConversationAttributionPayload extends ConversationAttributionMutationPayload {
  auditRef: string;
}
export interface ConversationAttributionMutationEnvelope extends FluCallableEnvelope {
  ok: true;
  conversationId: string;
  version: number;
  auditRef: string;
}
export interface ConversationAttributionReclassificationEnvelope extends FluCallableEnvelope {
  ok: true;
  dryRun: boolean;
  actionId: string;
  conversationId: string;
  version: number;
  auditRef?: string;
  previewToken?: string;
  previewHash?: string;
  projectedMessageSourceCount: number;
  projectedOutboundLedgerCount: number;
  ambiguityDetected: boolean;
  ambiguityTargetKeys: string[];
  humanConfirmationRequired: boolean;
  idempotentReplay: boolean;
  readbackVerified: boolean;
  mailSent: false;
}
export const reclassifyConversationAttribution = (
  payload: ReclassifyConversationAttributionPayload,
) =>
  callFluCallable<ConversationAttributionReclassificationEnvelope>(
    "reclassifyConversationAttribution",
    payload,
  );
export const revertConversationAttribution = (
  payload: RevertConversationAttributionPayload,
) =>
  callFluCallable<ConversationAttributionMutationEnvelope>(
    "revertConversationAttribution",
    payload,
  );
export interface ConversationAttributionReconciliationPayload extends FluCallablePayload {
  dryRun?: boolean;
  actual?: boolean;
  confirm?: boolean;
  pageSize?: number;
  runId?: string;
  cursor?: string;
  previewToken?: string;
  previewHash?: string;
}
export interface ConversationAttributionReconciliationCounts {
  scanned: number;
  eligible: number;
  planned: number;
  skipped: number;
  applied: number;
  stale: number;
  idempotent: number;
}
export interface ConversationAttributionReconciliationTargetCount {
  primaryBucket: "program" | "direct";
  programId: string | null;
  campaignId: string | null;
  planned: number;
}
export interface ConversationAttributionReconciliationEnvelope extends FluCallableEnvelope {
  ok: true;
  dryRun: boolean;
  runId: string;
  watermarkHash: string;
  cursor: string | null;
  nextCursor: string | null;
  done: boolean;
  complete: boolean;
  readbackVerified: boolean;
  pageSize: number;
  counts: ConversationAttributionReconciliationCounts;
  reasonCounts: Record<string, number>;
  targetCounts: ConversationAttributionReconciliationTargetCount[];
  previewToken?: string;
  previewHash?: string;
}
export const reconcileConversationAttribution = (
  payload: ConversationAttributionReconciliationPayload = {},
) =>
  callFluCallable<ConversationAttributionReconciliationEnvelope>(
    "reconcileConversationAttribution",
    payload,
  );
export const getMessageSource = (payload: MessageSourcePayload) =>
  callFluCallable<MessageSourceEnvelope>("getMessageSource", payload);

export const getSettings = (payload: SettingsPayload = {}) =>
  callFluCallable<SettingsEnvelope>("getSettings", payload);
export const updateSettings = (payload: SettingsPayload) =>
  callFluCallable<SettingsUpdateEnvelope>("updateSettings", payload);
export const refreshPolicyCache = (payload: SettingsPayload = {}) =>
  callFluCallable("refreshPolicyCache", payload);
export const getMailSafetyStatus = (payload: FluCallablePayload = {}) =>
  callFluCallable<MailSafetyStatusEnvelope>("getMailSafetyStatus", payload);
export interface ApiQuotaStatusEnvelope extends FluCallableEnvelope {
  status?: {
    dayKey?: string;
    youtube?: {
      unitsUsed?: number;
      dailyCap?: number;
      remaining?: number;
      percentUsed?: number;
      calls?: number;
      byOperation?: Record<string, number>;
    };
    mail?: {
      todaySent?: number;
      dailyCap?: number;
      hourSent?: number;
      hourlyCap?: number;
      burstCap?: number;
      bounced?: number;
      deferred?: number;
      suppressed?: number;
      outboundLocked?: boolean;
      lockedReason?: string;
      reputationStatus?: string;
    };
  };
}
export const getApiQuotaStatus = (payload: FluCallablePayload = {}) =>
  callFluCallable<ApiQuotaStatusEnvelope>("getApiQuotaStatus", payload);
// S12(d): AI Hub 키/엔드포인트 설정 여부(boolean만) + 리포팅 실패 상태. super_admin 전용, 값 자체는 절대 없음(G-SECRET).
export interface AiHubKeyStatusEnvelope extends FluCallableEnvelope {
  keyStatus?: {
    enabled?: boolean;
    hasProjectId?: boolean;
    hasApiKey?: boolean;
    hasSessionEndpoint?: boolean;
    hasReportEndpoint?: boolean;
    hasGatewayApiKey?: boolean;
  };
  failureStatus?: {
    failureCount?: number;
    lastFailureKind?: string | null;
    lastFailureCode?: string | null;
    lastHttpStatus?: number | null;
    lastCorrelationIdHash?: string | null;
    lastFailureAtIso?: string | null;
  } | null;
}
export const getAiHubKeyStatus = (payload: FluCallablePayload = {}) =>
  callFluCallable<AiHubKeyStatusEnvelope>("getAiHubKeyStatus", payload);
export const getIntegrations = (payload: SettingsPayload = {}) =>
  callFluCallable<GetIntegrationsEnvelope>("getIntegrations", payload);
export const updateIntegration = (payload: IntegrationPayload) =>
  callFluCallable<UpdateIntegrationEnvelope>("updateIntegration", payload);
export const getCaptchaSolverIntegration = (payload: FluCallablePayload = {}) =>
  callFluCallable<GetCaptchaSolverIntegrationEnvelope>("getCaptchaSolverIntegration", payload);
export const setCaptchaSolverIntegration = (payload: SetCaptchaSolverIntegrationPayload) =>
  callFluCallable<SetCaptchaSolverIntegrationEnvelope>("setCaptchaSolverIntegration", payload);
export const getPeoplyStatus = (payload: FluCallablePayload = {}) =>
  callFluCallable<GetPeoplyStatusEnvelope>("getPeoplyStatus", payload);
export const searchPeoplyDirectory = (payload: SearchPeoplyDirectoryPayload) =>
  callFluCallable<SearchPeoplyDirectoryEnvelope>("searchPeoplyDirectory", payload);
export const getPeoplyPerson = (payload: GetPeoplyPersonPayload) =>
  callFluCallable<GetPeoplyPersonEnvelope>("getPeoplyPerson", payload);
export const listMailAccounts = (payload: FluCallablePayload = {}) =>
  callFluCallable<ListMailAccountsEnvelope>("listMailAccounts", payload);
export const upsertMailAccount = (payload: UpsertMailAccountPayload) =>
  callFluCallable<UpsertMailAccountEnvelope>("upsertMailAccount", payload);
export const setMailRouting = (payload: SetMailRoutingPayload) =>
  callFluCallable<SetMailRoutingEnvelope>("setMailRouting", payload);
export const resolveMyMailAccount = (payload: FluCallablePayload = {}) =>
  callFluCallable<ResolveMyMailAccountEnvelope>("resolveMyMailAccount", payload);
export const getMyOrgContext = (payload: GetMyOrgContextPayload = {}) =>
  callFluCallable<MyOrgContextEnvelope>("getMyOrgContext", payload);

// Perf/cost 2026-09-24 — see functions/appBootstrap.ts. Typed client wrapper for the batch
// endpoint; not called from any page in this PR. Ready for a future PR that wires all 5 fields
// through their respective hooks (getSettings/getMyOrgContext/listPrograms/
// getOperationalSnapshot/getDashboardPipelineProjection), which keep working unchanged.
export type AppBootstrapFieldResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string; code?: string } };

export interface AppBootstrapPayload extends FluCallablePayload {
  viewAsUserId?: string;
  viewAsEmail?: string;
  operationalSnapshot?: Pick<GetOperationalSnapshotPayload, "surface" | "acceptedSchemaVersions">;
  dashboardPipelineProjection?: Pick<DashboardPipelineProjectionPayload, "limit">;
  programs?: Pick<DatasetPagePayload, "limit" | "cursor">;
}

export interface AppBootstrapEnvelope extends FluCallableEnvelope {
  ok: true;
  settings: AppBootstrapFieldResult<SettingsEnvelope>;
  orgContext: AppBootstrapFieldResult<MyOrgContextEnvelope>;
  programs: AppBootstrapFieldResult<DatasetPageEnvelope>;
  operationalSnapshot: AppBootstrapFieldResult<GetOperationalSnapshotEnvelope>;
  dashboardPipelineProjection: AppBootstrapFieldResult<DashboardPipelineProjectionEnvelope>;
}

export const getAppBootstrap = (payload: AppBootstrapPayload = {}) =>
  callFluCallable<AppBootstrapEnvelope>("getAppBootstrap", payload);

export const setUserPreference = (payload: SetUserPreferencePayload) =>
  callFluCallable<SetUserPreferenceEnvelope>("setUserPreference", payload);
export const getOrgTabPresets = (payload: FluCallablePayload = {}) =>
  callFluCallable<GetOrgTabPresetsEnvelope>("getOrgTabPresets", payload);
export const setOrgTabPresets = (payload: SetOrgTabPresetsPayload) =>
  callFluCallable<SetOrgTabPresetsEnvelope>("setOrgTabPresets", payload);
export const beginMailOAuth = (payload: BeginMailOAuthPayload = {}) =>
  callFluCallable<BeginMailOAuthEnvelope>("beginMailOAuth", payload);
export const revokeMailOAuth = (payload: RevokeMailOAuthPayload) =>
  callFluCallable<RevokeMailOAuthEnvelope>("revokeMailOAuth", payload);
export const getMailOAuthStatus = (payload: GetMailOAuthStatusPayload = {}) =>
  callFluCallable<GetMailOAuthStatusEnvelope>("getMailOAuthStatus", payload);
export const startMailBackfill = (payload: StartMailBackfillPayload) =>
  callFluCallable<StartMailBackfillEnvelope>("startMailBackfill", payload);
export const getMailBackfillStatus = (payload: GetMailBackfillStatusPayload) =>
  callFluCallable<GetMailBackfillStatusEnvelope>("getMailBackfillStatus", payload);
export const startCandidateRematch = (payload: FluCallablePayload = {}) =>
  callFluCallable<StartCandidateRematchEnvelope>("startCandidateRematch", payload);
export const diagnoseMailTransport = (payload: FluCallablePayload = {}) =>
  callFluCallable<DiagnoseMailTransportEnvelope>(
    "diagnoseMailTransport",
    payload,
  );
export const getMailProviderAttestationStatus = (
  payload: FluCallablePayload = {},
) =>
  callFluCallable<MailProviderAttestationEnvelope>(
    "getMailProviderAttestationStatus",
    payload,
  );
export const attestMailProviderSubject = (
  payload: AttestMailProviderSubjectPayload,
) =>
  callFluCallable<MailProviderAttestationEnvelope>(
    "attestMailProviderSubject",
    payload,
  );
export const revokeMailProviderSubject = (
  payload: RevokeMailProviderSubjectPayload,
) =>
  callFluCallable<MailProviderAttestationEnvelope>(
    "revokeMailProviderSubject",
    payload,
  );
export const getYouTubeAuthorizationStatus = (
  payload: FluCallablePayload = {},
) =>
  callFluCallable<YouTubeAuthorizationStatusEnvelope>(
    "getYouTubeAuthorizationStatus",
    payload,
  );

// ── 주간 트렌드 리포트 + 골든셋 라벨링 (P4) ──────────────────────────────────
// trend_reports/{weekKey}는 스케줄러가 생성하는 집계 문서 — 클라 직접 read 금지(SEC-P0-004),
// listTrendReports callable만 경유. 라벨은 recordGoldenSetLabel callable로만 기록(서버 RBAC manager+).
export type TrendAxis = "format" | "genreStyle" | "contentNature";

export interface TrendAxisDelta {
  id: string;
  count: number;
  prevCount: number;
  delta: number;
}

export interface TrendCrossCellMover {
  format: string;
  genreStyle: string;
  contentNature: string;
  count: number;
  delta: number;
}

export interface TrendReport {
  weekKey: string;
  generatedAtIso: string;
  visibility: "published" | "gate_blocked";
  axisTopDeltas: Record<TrendAxis, TrendAxisDelta[]>;
  crossCellMovers: TrendCrossCellMover[];
  headline300: string;
  sampleScope: string;
  analysisCoveragePct: number;
  carriedOver: string[];
  qualityWarning?: boolean;
  proxyFieldsPending: boolean;
}

export interface ListTrendReportsPayload extends FluCallablePayload {
  limit?: number;
}

export interface ListTrendReportsEnvelope extends FluCallableEnvelope {
  ok: true;
  reports: TrendReport[];
}

export const listTrendReports = (payload: ListTrendReportsPayload = {}) =>
  callFluCallable<ListTrendReportsEnvelope>("listTrendReports", payload);

export interface RecordGoldenSetLabelPayload extends FluCallablePayload {
  videoId: string;
  format: string;
  genreStyle: string;
  contentNature: string;
  phase?: "calibration" | "full";
}

export const recordGoldenSetLabel = (payload: RecordGoldenSetLabelPayload) =>
  callFluCallable("recordGoldenSetLabel", payload);

// G003 operational snapshots — aggregate-only first-paint contracts.
export type {
  OperationalSnapshotScope,
  OperationalSnapshotSurface,
  OperationalSnapshotV1,
} from "./operational-snapshot";

export interface GetOperationalSnapshotPayload extends FluCallablePayload {
  surface?: OperationalSnapshotSurface;
  scope?: OperationalSnapshotScope;
  acceptedSchemaVersions?: string[];
}

export interface GetOperationalSnapshotEnvelope extends FluCallableEnvelope {
  ok: true;
  found: boolean;
  storedFound?: boolean;
  requiresRebuild: boolean;
  unavailable?: boolean;
  unavailableReason?: string;
  scope: OperationalSnapshotScope;
  surface: OperationalSnapshotSurface;
  snapshot: OperationalSnapshotV1;
}

export interface RebuildOperationalSnapshotPayload extends GetOperationalSnapshotPayload {
  dryRun?: boolean;
  actual?: boolean;
}

export interface RebuildOperationalSnapshotEnvelope extends FluCallableEnvelope {
  ok: true;
  dryRun: boolean;
  actual: boolean;
  written: boolean;
  idempotencyKey: string;
  snapshot: OperationalSnapshotV1;
}

export const getOperationalSnapshot = (
  payload: GetOperationalSnapshotPayload = {},
) =>
  callFluCallable<GetOperationalSnapshotEnvelope>(
    "getOperationalSnapshot",
    payload,
  );

export const rebuildOperationalSnapshot = (
  payload: RebuildOperationalSnapshotPayload = {},
) =>
  callFluCallable<RebuildOperationalSnapshotEnvelope>(
    "rebuildOperationalSnapshot",
    payload,
  );

// W86-A: 접속 시 갱신(SWR) 트리거. 화면은 이걸 **await 하지 않고** 쏜다 — 재구축(~35초)에
//   사용자를 붙잡지 않는 것이 계약이다. 서버가 stale 게이트와 single-flight 리스를 모두 지므로
//   클라가 중복 호출해도 재구축은 한 번만 돈다.
export interface EnsureOperationalSnapshotFreshEnvelope {
  ok: boolean;
  triggered: boolean;
  reason: "fresh" | "in_flight" | "rebuilt" | "unavailable";
  unavailable?: boolean;
  unavailableReason?: string;
  written?: boolean;
  scope: string;
  surface: string;
}

export const ensureOperationalSnapshotFresh = (
  payload: GetOperationalSnapshotPayload = {},
) =>
  callFluCallable<EnsureOperationalSnapshotFreshEnvelope>(
    "ensureOperationalSnapshotFresh",
    payload,
  );

// ─────────────────────────────────────────────────────────────────────────────
// APPEND-ONLY BLOCK (2026-09-05, Programs 탭 숫자 감사 수리) — 이 파일을 동시에 편집 중인
// 다른 작업과 충돌하지 않도록 파일 맨 끝에만 덧붙인다. 위 본문은 손대지 않았다.
//
// aggregateScpProgramFunnel 응답에 컬렉션별 읽기 상한 도달 여부가 추가됐다
// (functions/scpProgramFunnelAggregate.ts `truncated`). 인터페이스 선언 병합으로 얹는다.
// true 인 컬렉션이 있으면 그 컬렉션 유래 카운트는 확정값이 아니라 **하한**이다.
// ─────────────────────────────────────────────────────────────────────────────
export interface ScpProgramFunnelAggregateEnvelope {
  truncated?: Record<string, boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
// APPEND-ONLY BLOCK (2026-09-05, 검수 탭 다타이틀 + 큐 배지 카운트) — 같은 파일을 동시에
// 편집 중인 다른 작업과 충돌하지 않도록 파일 맨 끝에만 덧붙인다. 위 본문은 손대지 않았다.
//
// `listScpVideoReviewStates` 응답에 두 가지가 추가됐다(functions/videoReviewStateCallables.ts):
//   ① 행별 `gameId` 원값 + 레지스트리로 해석한 `title`  ② 응답 단위 `titleOptions`(필터 선택지).
// 게임명은 **전부 서버 레지스트리에서** 온다 — 클라이언트에는 타이틀 리터럴이 없다.
// 위 `ScpVideoReviewStateRow`/`ScpVideoReviewStatePage` 는 `type` 별칭이라 선언 병합이 안 된다.
// 그래서 본문을 고치지 않고 **교차 타입**으로 확장한 별칭을 여기서 새로 내보낸다.
// 필드는 전부 선택적이다 — 서버가 아직 실어 보내지 않는 배포본에서도 화면이 그대로 동작한다.
// ─────────────────────────────────────────────────────────────────────────────
export type ScpVideoReviewTitleOption = {
  id: string;
  name: string;
  storeUrl?: string;
  requiredHashtag?: string;
  requiredHashtags?: string[];
  driveFolderUrl?: string;
  guidebookUrl?: string;
  default?: boolean;
};

/** 행에 붙는 다타이틀 필드. 서버가 아직 실어 보내지 않으면 둘 다 undefined 다. */
export type ScpVideoReviewRowTitleFields = {
  /** 원장에 저장된 원값(미등록·누락이면 빈 문자열). */
  gameId?: string;
  /** 레지스트리로 해석한 표시용 타이틀. 등록된 타이틀이 없으면 null. */
  title?: ScpVideoReviewTitleOption | null;
};

export type ScpVideoReviewStateRowWithTitle =
  ScpVideoReviewStateRow & ScpVideoReviewRowTitleFields;

/** 응답 단위 필드. 레지스트리 미등록 프로그램이면 빈 배열이 온다. */
export type ScpVideoReviewStatePageWithTitles = ScpVideoReviewStatePage & {
  states: ScpVideoReviewStateRowWithTitle[];
  titleOptions?: ScpVideoReviewTitleOption[];
  /**
   * titleId 필터가 걸린 응답의 스캔 계측(functions/videoReviewStateCallables.ts).
   * countsExact:false 면 큐 배지 숫자는 필터 스코프가 아닌 전체 집계다 — 화면이 그 사실을 밝힌다.
   */
  titleFilter?: {
    titleId: string;
    registered: boolean;
    scanned: number;
    capped: boolean;
    countsExact: boolean;
  } | null;
};
