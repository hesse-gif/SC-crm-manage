// Flu Cloud Functions — 외부망/모델 호출·DB 쓰기의 단일 경유점.
// Spark 단계에서는 callable 엔드포인트가 mock handler만 실행한다.
// 라이브 전환은 influchat-77db6 Blaze 상향 + 티코 승인 후 별도 작업으로만 수행한다.

// W62-2 [헤세 · 지원 관리 탭] — 조회 모델 + 재촉 아웃박스 적재.
import { retryPendingChatAutoPermitDisarmAlerts } from "./chatAutoPermitDisarmAudit";
import {
  listApplicationVideoPendingRows as listApplicationVideoPendingHandler,
  enqueueApplicationVideoReminder as enqueueApplicationVideoReminderHandler,
  resetApplicationVideoReminderSequence as resetApplicationVideoReminderSequenceHandler,
} from "./applicationVideoPending";
// W72 C-1: 코호트 × 회차 문안 매핑 편집(검수 > 메일 템플릿).
import {
  getScpNudgeSequenceConfig as getScpNudgeSequenceConfigHandler,
  listScpNudgeCohortCandidates as listScpNudgeCohortCandidatesHandler,
  saveScpNudgeSequenceConfig as saveScpNudgeSequenceConfigHandler,
  saveScpNudgeProgramOverride as saveScpNudgeProgramOverrideHandler,
} from "./nudgeSequenceAdmin";
// W72 A: 독려 3코호트 적재 스윕. 기존 60분 스윕의 **단계**로 돈다(새 스케줄 함수 없음).
import { NUDGE_SWEEP_BUDGET_MS, runNudgeCohortSweep, drainNudgeCohort13Outbox, NUDGE_DRAIN_BUDGET_MS } from "./nudgeCohortSweep";
// W75: 새 scheduler를 만들지 않고 기존 60분 Functions 경계 안에서 섀도 승격·다음 잡 계획을 격리 실행.
import { runYtdlpPromotionSweep } from "./ytdlpPromotionSweep";
import { onCall, onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { collectAudienceCountryObservations } from "./audienceCountryCollector";
import { deliverRecentOutreachFunnelSnapshots, OutreachFunnelPassError, type OutreachFunnelPassResult } from "./outreachFunnelSnapshot";
import { auth as authEvents } from "firebase-functions/v1";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { toHttpsError } from "./callableErrorBoundary";
// Flu/Task-50 적대 리뷰 P1: 쓰기 콜러블에 viewAsUserId가 섞이면 read-only preview로 거부하는
// 공통 게이트 — callable() 안에서 모든 콜러블에 적용한다.
import { assertViewAsReadOnlyPayload } from "./viewAsWriteGuard";
import { expireAt180DaysFromIso, expireAt180DaysFromTimestamp } from "./firestoreTtl";
import { toCallableResponse } from "./callableErrorBoundary";
// Perf/cost 2026-09-27: in-instance TTL cache wrapper for the top-invocation-count read
// callables — see functions/readCache.ts header comment for the full rationale.
import { cacheableRead } from "./readCache";
import {
  youtubeSearch as youtubeSearchHandler,
  emailFinder as emailFinderHandler,
  queueYtDlpDiscovery as queueYtDlpDiscoveryHandler,
  getDiscoveryRunStatus as getDiscoveryRunStatusHandler,
  queueCommunityDiscovery as queueCommunityDiscoveryHandler,
  scheduledCommunityDiscovery as scheduledCommunityDiscoveryHandler,
  processDiscoveryQueue as processDiscoveryQueueHandler,
} from "./discovery";
import { recommendCreators as recommendCreatorsHandler } from "./rec";
import { postScheduledReportToSlack, slackScheduledReportsHandler } from "./slackScheduledReports";
import { processSlackBotInboxDocument, slackBotEventsHandler } from "./slackBotEvents";
import {
  gatewayProxy as gatewayProxyHandler,
  resolveChatAutoPermitCurrentModelVersion,
  runChatAutoPermitGatewayEvalScenario,
  runStagingAiGatewayEval as runStagingAiGatewayEvalHandler,
  markConversationRead as markConversationReadHandler,
  setConversationAutoReply as setConversationAutoReplyHandler,
  processAutoReplyQueue as processAutoReplyQueueHandler,
  receiveEmail as receiveEmailHandler,
  sendEmail as sendEmailHandler,
  processCampaignOutreachQueue as processCampaignOutreachQueueHandler,
  scpCanarySelfSendScheduled as scpCanarySelfSendScheduledHandler,
} from "./chat-ai";
import {
  getChatAutoCasebookSnapshot as getChatAutoCasebookSnapshotHandler,
  getChatAutoCasePermitStatus as getChatAutoCasePermitStatusHandler,
  listChatAutoCaseDecisionLedger as listChatAutoCaseDecisionLedgerHandler,
  refreshArmedChatAutoCasePermits as refreshArmedChatAutoCasePermitsHandler,
  runChatAutoCasePermitEval as runChatAutoCasePermitEvalHandler,
  setChatAutoCasePermitArming as setChatAutoCasePermitArmingHandler,
} from "./chatAutoCasePermitCallables";
// Casebook inbox (2026-10-01): live list behind the snapshot's "unclassified pending" count.
import { enqueueScpVideoApprovalResultMail as enqueueScpVideoApprovalResultMailHandler } from "./scpVideoApprovalMailEnqueue";
import { reevaluateOutboundLockBlockedTargets as reevaluateOutboundLockBlockedTargetsHandler } from "./programTargetOutboundLockReevaluation";
import { listChatAutoCasebookUnclassified as listChatAutoCasebookUnclassifiedHandler } from "./chatAutoCasebookUnclassified";
import { listChatAutoCasebookCaseItems as listChatAutoCasebookCaseItemsHandler } from "./chatAutoCasebookCaseItems";
import { listChatAutoReviewBoard as listChatAutoReviewBoardHandler } from "./chatAutoReviewBoard";
import {
  previewChatAutoCaseReply as previewChatAutoCaseReplyHandler,
  resetChatAutoCaseReply as resetChatAutoCaseReplyHandler,
  saveChatAutoCaseReply as saveChatAutoCaseReplyHandler,
  suggestChatAutoCaseReply as suggestChatAutoCaseReplyHandler,
} from "./chatAutoCaseReplies";
// Casebook snapshot 504 hotfix (2026-09-29): scheduled precompute for getChatAutoCasebookSnapshot's
// pending counts — see functions/chatAutoCasebookPendingPrecompute.ts's own doc comment.
import { writeChatAutoCasebookPendingSnapshots as writeChatAutoCasebookPendingSnapshotsHandler } from "./chatAutoCasebookPendingPrecompute";
// Casebook inbox (2026-10-01): scheduled default English reply suggestions per case — see
// functions/chatAutoCaseSuggestionPrecompute.ts's own doc comment.
import { runChatAutoCaseSuggestionPrecompute as runChatAutoCaseSuggestionPrecomputeHandler } from "./chatAutoCaseSuggestionPrecompute";
import { resolveChatAutoPermitReleaseIdentity } from "./chatAutoPermitReleaseIdentity";
import { requeueAutoReplyBacklog as requeueAutoReplyBacklogHandler } from "./autoReplyBacklog";
import {
  getChatAutoCaseHeldBacklogCount as getChatAutoCaseHeldBacklogCountHandler,
  sendChatAutoCaseHeldBacklogNow as sendChatAutoCaseHeldBacklogNowHandler,
} from "./chatAutoCaseBacklogSend";
// casebook-reclassify (2026-10-01): super_admin-only classification-only backfill for pending
// conversations that carry no fresh case stamp — see functions/chatAutoCaseReclassify.ts.
import {
  reclassifyChatAutoCasebookUnclassified as reclassifyChatAutoCasebookUnclassifiedHandler,
  runChatAutoCaseReclassifySweep,
} from "./chatAutoCaseReclassify";
// classification_v1 (2026-10-03): super_admin-only official path that applies the operator's corrected
// labels (case/actor/intents/disposition) — labels only, never sends or enqueues mail.
import { applyChatAutoCaseOperatorLabels as applyChatAutoCaseOperatorLabelsHandler } from "./chatAutoCaseOperatorLabels";
import { emailDiggingBackfill as emailDiggingBackfillHandler } from "./emailDigging";
import {
  emailUploadSamplingBackfill as emailUploadSamplingBackfillHandler,
  runEmailUploadSamplingScheduled,
} from "./emailUploadSampling";
import { processImapIngestQueue as processImapIngestQueueHandler } from "./mailImapIngest";
import { drainImapMarkReadOutbox as drainImapMarkReadOutboxHandler } from "./mailImapMarkRead";
import {
  backfillInboundMailProvenanceHandler,
  dismissAgencyAndUnregisteredSenderBacklogHandler,
} from "./dismissNoReplyBacklog";
import { rescanImapByTrackingId as rescanImapByTrackingIdHandler } from "./mailImapRescan";
import { sweepMailIngestGapsCallable as sweepMailIngestGapsHandler } from "./mailIngestReconciliation";
import { withAutoPrefillCache } from "./chatDraftPrefillCache";
import {
  listApplicationManageInboxHandler,
  assignApplicationManagementHandler,
  applicationManagementKpiHandler,
  listScpCreatorDirectoryHandler,
  evaluateContentEligibilityHandler,
  sendOnboardingTestHandler,
} from "./applicationManagementCallables";
// Flu/Task-37 [헤세 · 크리에이터 탭]: 승인됐지만 Flu ingest(대시보드 스냅샷) 성공 이력이 없는
// 계정 조회. 읽기 전용 — program_applications/scp_portal_creator_bindings/
// scp_dashboard_ingest_ledger 3-way 조인.
import { listScpApprovedWithoutIngestHandler } from "./scpDashboardIngestGapCallables";
// W91 [헤세 · admin-bridge]: Portal 실계정 조회 + operator-attributed CAS 커맨드.
import {
  listScpPortalCreatorsHandler,
  scpPortalCreatorCommandHandler,
} from "./scpAdminBridgeCallables";
import { transitionVideoReviewDecisionHandler, undoVideoReviewDecisionHandler } from "./videoReviewTransitionCallables";
import { getResubmissionCycleMetricsHandler } from "./resubmissionCycleCallables";
import { enqueueResubmissionNudgeOccurrences, drainResubmissionNudgeOutbox } from "./resubmissionNudgeMail";
import { revokePartnerActivationHandler } from "./partnerActivationCallables";
import {
  acknowledgeVideoResultMailDeadLetterAlertHandler,
  listScpVideoReviewStatesHandler,
} from "./videoReviewStateCallables";
import { evaluateVideoDuplicateHandler } from "./duplicateDetectionCallables";
import {
  createManagementTabEnvelopesCallable,
  createScopedTabListCallable,
} from "./managementProfileTabsCallables";
import {
  createFirestoreManagementTabEnvelopesPort,
  createFirestoreScopedTabListPort,
} from "./managementProfileTabsPorts";
import {
  createGetActivePartnersCallable,
  createPartnerTabEnvelopesCallable,
  createResolvePartnerRouteAliasCallable,
} from "./partnerProfileTabsCallables";
import {
  createFirestoreActivePartnersPort,
  createFirestorePartnerTabEnvelopesPort,
  createFirestoreResolvePartnerRouteAliasPort,
} from "./partnerProfileTabsPorts";
import {
  createFirestoreVideoPerformanceReportPort,
  createGetVideoPerformanceSummaryCallable,
  createGetVideoPerformanceDetailCallable,
  createListVideoPerformanceLedgerCallable,
} from "./videoPerformanceReportPorts";
import { createListTrackedVideoObservationsCallable } from "./videoPerformanceTrackingPorts";
import { createGetCreatorManagementClassificationCallable } from "./managementClassificationPort";


import {
  mailOpenPixelHandler,
  listMailOutbox as listMailOutboxHandler,
  reconcileMailOutboxReplies as reconcileMailOutboxRepliesHandler,
  getMailSignatureSettings as getMailSignatureSettingsHandler,
  updateMailSignatureSettings as updateMailSignatureSettingsHandler,
} from "./mailSignature";
import {
  hydrateExternalSentBodies as hydrateExternalSentBodiesHandler,
  importManualSentMailToOutbox as importManualSentMailToOutboxHandler,
  importSentMailForActivePersonalAccounts as importSentMailForActivePersonalAccountsHandler,
  importSentMailToOutboxScheduled as importSentMailToOutboxScheduledHandler,
} from "./mailExternalSentImport";
import { attributeImportedSentOnlyHistory as attributeImportedSentOnlyHistoryHandler } from "./sentOnlyAttribution";
import {
  EXTERNAL_SENT_STITCH_PIGGYBACK_BUDGET_MS,
  retryUnstitchedSentImportStitches,
  stitchExternalSentConversations as stitchExternalSentConversationsHandler,
  stitchExternalSentConversationsCore,
} from "./externalSentConversationStitch";
import { safeOutboundFailureEvidence } from "./mailSafetyShared";
import {
  EXTERNAL_SENT_SUMMARY_PIGGYBACK_BUDGET_MS,
  summarizeExternalSentMessages as summarizeExternalSentMessagesHandler,
  summarizeExternalSentMessagesCore,
} from "./externalSentSummary";
import { getMailSafetyStatus as getMailSafetyStatusHandler } from "./mailSafetyStatus";
// W76-②: 옵트아웃 오탐으로 잠긴 크리에이터를 admin+ 가 되돌리는 문(감사 기록 필수).
import { releaseMailSuppression as releaseMailSuppressionHandler } from "./mailSafetyPolicy";
import {
  drainChatAutoPermitAdverseRetryAlerts,
  monitorOutboundOutputHeartbeat as monitorOutboundOutputHeartbeatHandler,
} from "./mailOutboundSafety";
import { getApiQuotaStatus as getApiQuotaStatusHandler } from "./apiQuota";
import { getAiHubKeyStatus as getAiHubKeyStatusHandler } from "./aiHubReport";
import {
  orchestrateCampaign as orchestrateCampaignHandler,
  syncCampaignFunnel as syncCampaignFunnelHandler,
  learnCampaignPriority as learnCampaignPriorityHandler,
  addCandidatesToCampaign as addCandidatesToCampaignHandler,
  importCandidatesToCampaign as importCandidatesToCampaignHandler,
  listCampaignCandidates as listCampaignCandidatesHandler,
} from "./campaigns";
import { repairLegacyCandidateScopes as repairLegacyCandidateScopesHandler } from "./candidateScopeRepair";
import { migrateCampaignCandidates as migrateCampaignCandidatesHandler } from "./campaignCandidateMigration";
import { repairLegacyProgramSheetLeadScopes as repairLegacyProgramSheetLeadScopesHandler } from "./sheetLeadProgramScopeRepair";
import { retireLegacyQaPrograms as retireLegacyQaProgramsHandler } from "./qaProgramRetirement";
import { repairVideoReviewSubjectIdentitiesHandler } from "./videoReviewSubjectRepair";
import { repairFluAppOriginLinksHandler } from "./fluAppOriginLinkRepair";
import { repairProgramOrgScopes as repairProgramOrgScopesHandler } from "./programOrgScopeRepair";
import {
  negotiateContract as negotiateContractHandler,
  createEscalation as createEscalationHandler,
  validateContractTemplate as validateContractTemplateHandler,
} from "./contracts";
import {
  submitFeedback as submitFeedbackHandler,
  indexFeedbackKb as indexFeedbackKbHandler,
  retrieveFeedbackKb as retrieveFeedbackKbHandler,
  queueFineTuneExample as queueFineTuneExampleHandler,
  processFineTuneCompensationOutbox as processFineTuneCompensationOutboxHandler,
  retryFeedbackGraphProjection as retryFeedbackGraphProjectionHandler,
  getFeedbackKbGovernanceStatus as getFeedbackKbGovernanceStatusHandler,
} from "./feedback-kb";
import {
  getManualReplyLearningSettings as getManualReplyLearningSettingsHandler,
  updateManualReplyLearningSettings as updateManualReplyLearningSettingsHandler,
  backfillManualReplyLearningCandidates as backfillManualReplyLearningCandidatesHandler,
  captureManualReplyLearningCandidatesForImportedReplies,
} from "./manualReplyLearning";
import {
  listKbReviewQueue as listKbReviewQueueHandler,
  resolveKbReviewCallable as resolveKbReviewCallableHandler,
} from "./knowledgeGraph";
import {
  upsertCreator as upsertCreatorHandler,
  transitionCreatorStage as transitionCreatorStageHandler,
  syncChannelStats as syncChannelStatsHandler,
} from "./crm";
import {
  updateReviewStatus as updateReviewStatusHandler,
  recordPayment as recordPaymentHandler,
  syncReviewLedger as syncReviewLedgerHandler,
} from "./review-pay";
import {
  aggregateReport as aggregateReportHandler,
  listRawRecords as listRawRecordsHandler,
  logCostUsage as logCostUsageHandler,
} from "./report";
import { getReportDashboard as getReportDashboardHandler } from "./reportDashboard";
import {
  setMemberRole as setMemberRoleHandler,
  inviteMember as inviteMemberHandler,
  requestAccess as requestAccessHandler,
  authBootstrapAccessForEmail,
  upsertPendingMemberFromAuthUser,
  logBehavior as logBehaviorHandler,
  recordLlmUsage as recordLlmUsageHandler,
  createSeedData as createSeedDataHandler,
  deleteSeedData as deleteSeedDataHandler,
  updateAutoReply as updateAutoReplyHandler,
  upsertTemplate as upsertTemplateHandler,
  createCampaign as createCampaignHandler,
  getEmailMode as getEmailModeHandler,
  setEmailMode as setEmailModeHandler,
  approveCampaignOutreach as approveCampaignOutreachHandler,
  auditCampaignOutreachWave as auditCampaignOutreachWaveHandler,
  reconcileCampaignOutreachMailLedgers as reconcileCampaignOutreachMailLedgersHandler,
  localizeProgramMailTemplate as localizeProgramMailTemplateHandler,
  updateProgramColdMail as updateProgramColdMailHandler,
  prepareProgramCampaignTargets as prepareProgramCampaignTargetsHandler,
  runCampaignOutreachAutoApprovalSweep as runCampaignOutreachAutoApprovalSweepHandler,
  runDiscoveryInventoryFloorSweep as runDiscoveryInventoryFloorSweepHandler,
  // W90: 키워드 코퍼스 읽기 전용 조회.
  getCampaignKeywordCorpus as getCampaignKeywordCorpusHandler,
} from "./admin";
// AI-DRAMA-DISCOVERY-METAPROMPT W5: JEV 댓글 감성 스윕(ai_drama 전용, commentInsightsPending 큐).
import { sweepCreatorCommentSentiment as sweepCreatorCommentSentimentHandler } from "./creatorCommentSentiment";
import {
  createProgram as createProgramHandler,
  getPublicProgram as getPublicProgramHandler,
  submitProgramApplication as submitProgramApplicationHandler,
  reviewProgramApplication as reviewProgramApplicationHandler,
  syncProgramWorkflow as syncProgramWorkflowHandler,
} from "./programs";
import {
  reconcileGoogleSheetIntake as reconcileGoogleSheetIntakeHandler,
  syncGoogleSheetIntake as syncGoogleSheetIntakeHandler,
  updateGoogleSheetIntakeCutover as updateGoogleSheetIntakeCutoverHandler,
} from "./sheetIntake";
import { getGoogleSheetIntakeStatus as getGoogleSheetIntakeStatusHandler } from "./sheetIntakeStatus";
import {
  getParticipantRosterStatus as getParticipantRosterStatusHandler,
  syncParticipantRoster as syncParticipantRosterHandler,
} from "./participantRosterEngine";
import { syncYouTubeEnrichment as syncYouTubeEnrichmentHandler } from "./youtubeEnrichment";
import {
  getScpAutomationSettings as getScpAutomationSettingsHandler,
  updateScpAutomationSettings as updateScpAutomationSettingsHandler,
} from "./scpAutomationSettings";
import { getScpAutomationControl as getScpAutomationControlHandler } from "./scpAutomationControl";
import { getPartnerSettlementSnapshot as getPartnerSettlementSnapshotHandler } from "./partnerSettlement";
import { getReviewWorkspaceSnapshot as getReviewWorkspaceSnapshotHandler } from "./reviewWorkspace";
import { getVideoReportSnapshot as getVideoReportSnapshotHandler } from "./videoReport";
import { getPartnerDetailSnapshot as getPartnerDetailSnapshotHandler } from "./partnerDetail";
import { getManagementDetailSnapshot as getManagementDetailSnapshotHandler } from "./managementDetail";
import { judgeQualification as judgeQualificationHandler } from "./qualificationJudge";
import {
  processCanonicalSheet2QualificationAutoRecommendation as processCanonicalSheet2QualificationAutoRecommendationHandler,
  processQualificationAutoRecommendation as processQualificationAutoRecommendationHandler,
} from "./qualificationAutoRecommendation";
import { runQualificationBacktestCallable as runQualificationBacktestHandler } from "./qualificationBacktest";
import { writeBackQualificationSheetResultsCallable as writeBackQualificationSheetResultsHandler } from "./scpQualificationSheetWriteback";
import { upsertCreatorLink as upsertCreatorLinkHandler } from "./creatorLinks";
import {
  deleteScpMailTemplate as deleteScpMailTemplateHandler,
  prepareScpResultMail as prepareScpResultMailHandler,
  sendPendingQualificationRejectionNotificationsCallable as sendPendingQualificationRejectionNotificationsHandler,
  upsertScpMailTemplate as upsertScpMailTemplateHandler,
} from "./scpMail";
import {
  listScpEncouragementCandidates as listScpEncouragementCandidatesHandler,
  prepareScpEncouragementMail as prepareScpEncouragementMailHandler,
} from "./scpEncouragement";
import {
  approveVideoSubmissionReminderMail as approveVideoSubmissionReminderMailHandler,
  getVideoSubmissionReminderSettings as getVideoSubmissionReminderSettingsHandler,
  listVideoSubmissionReminderHistory as listVideoSubmissionReminderHistoryHandler,
  listVideoSubmissionReminderTargets as listVideoSubmissionReminderTargetsHandler,
  previewVideoSubmissionReminderMail as previewVideoSubmissionReminderMailHandler,
  processVideoSubmissionReminders as processVideoSubmissionRemindersHandler,
  processVideoSubmissionRemindersCore,
  updateVideoSubmissionReminderSettings as updateVideoSubmissionReminderSettingsHandler,
  updateVideoSubmissionReminderTarget as updateVideoSubmissionReminderTargetHandler,
} from "./scpVideoSubmissionReminder";
import { aggregateScpProgramFunnel as aggregateScpProgramFunnelHandler } from "./scpProgramFunnelAggregate";
import {
  getOperationalSnapshot as getOperationalSnapshotHandler,
  rebuildOperationalSnapshot as rebuildOperationalSnapshotHandler,
  ensureOperationalSnapshotFresh as ensureOperationalSnapshotFreshHandler,
  refreshOperationalSnapshotsSweep,
} from "./operationalSnapshot";
import { listScpQualificationQueue as listScpQualificationQueueHandler } from "./scpQueueProjection";
import { reconcileProgramRegistry as reconcileProgramRegistryHandler } from "./programRegistry";
import { reconcileSubmissionReviewCounts as reconcileSubmissionReviewCountsHandler } from "./submissionReviewCountReconciliation";
import { reconcileConversationAttribution as reconcileConversationAttributionHandler } from "./conversationAttributionReconciliation";
import { repairInboundCreatorAttribution as repairInboundCreatorAttributionHandler } from "./inboundCreatorAttributionRepair";
import {
  listCampaignOutreachApprovalQueue as listCampaignOutreachApprovalQueueHandler,
  updateCampaignControl as updateCampaignControlHandler,
} from "./campaignControl";
import {
  createSubmissionUploadUrl as createSubmissionUploadUrlHandler,
  getPublicSubmissionForm as getPublicSubmissionFormHandler,
  issueSubmissionTask as issueSubmissionTaskHandler,
  submitPublicSubmission as submitPublicSubmissionHandler,
} from "./submissionTasks";
import { judgeVideoReview as judgeVideoReviewHandler } from "./videoReviewJudge";
import { runVideoReviewBacktestCallable as runVideoReviewBacktestHandler } from "./videoReviewBacktest";
import {
  getSettings as getSettingsHandler,
  updateSettings as updateSettingsHandler,
  refreshPolicyCache as refreshPolicyCacheHandler,
} from "./settings";
import {
  getIntegrations as getIntegrationsHandler,
  updateIntegration as updateIntegrationHandler,
} from "./integrations";
import {
  getPeoplyStatus as getPeoplyStatusHandler,
  searchPeoplyDirectory as searchPeoplyDirectoryHandler,
  getPeoplyPerson as getPeoplyPersonHandler,
  refreshPeoplyDirectoryCache as refreshPeoplyDirectoryCacheHandler,
} from "./peoplyCallables";
import { runPeoplyDirectorySync } from "./peoplyDirectoryCache";
// PLAN-ORG-MAIL-IDENTITY Slice 1: mail_accounts/mail_routing foundation callables.
import {
  listMailAccounts as listMailAccountsHandler,
  upsertMailAccount as upsertMailAccountHandler,
  setMailRouting as setMailRoutingHandler,
  setMemberMailAccountAccess as setMemberMailAccountAccessHandler,
  resolveMyMailAccount as resolveMyMailAccountHandler,
  getMyOrgContext as getMyOrgContextHandler,
} from "./mailAccountCallables";
import { setUserPreference as setUserPreferenceHandler } from "./userPreferences";
// Perf/cost 2026-09-24: composes getSettings/getMyOrgContext/listPrograms/getOperationalSnapshot/
// getDashboardPipelineProjection into one in-process callable — see functions/appBootstrap.ts for
// why (collapses up to 5 concurrent cold starts into 1 for a caller that wants all five).
import { getAppBootstrap as getAppBootstrapHandler } from "./appBootstrap";
// Flu/Task-42: org -> Flu tab preset mapping (settings/org_tab_presets), same shape as
// settings/mail_routing above.
import {
  getOrgTabPresets as getOrgTabPresetsHandler,
  setOrgTabPresets as setOrgTabPresetsHandler,
} from "./orgTabPresets";
// Flu/Task-43: 후보 탭 테이블 투영(candidate_pool/campaign_candidates 읽기 전용) + YouTube 메타
// 캐시 우선 보강 + 메일 발송 킬스위치/suppression 게이트. functions/candidateTable.ts 헤더 참조.
import {
  listCandidates as listCandidatesHandler,
  sendCandidateColdMail as sendCandidateColdMailHandler,
  updateCandidateRowState as updateCandidateRowStateHandler,
  setCandidateNudgeCadenceOverride as setCandidateNudgeCadenceOverrideHandler,
} from "./candidateTable";
// Flu/Task-46: 후보 회신 → 파트너 전환(사람 확정) + AI Drama 파트너 탭 전체 뷰 읽기. Growth의
// scp_partner_activations/getActivePartners와는 별개 컬렉션 — functions/candidatePartnerConversion.ts
// 헤더 참조.
import {
  convertCandidateToPartner as convertCandidateToPartnerHandler,
  listCandidateReplyPartners as listCandidateReplyPartnersHandler,
  revertCandidatePartnerConversion as revertCandidatePartnerConversionHandler,
} from "./candidatePartnerConversion";
// PLAN-ORG-MAIL-IDENTITY Slice 2: Gmail OAuth for workspace_oauth mail accounts.
import {
  beginMailOAuth as beginMailOAuthHandler,
  revokeMailOAuth as revokeMailOAuthHandler,
  getMailOAuthStatus as getMailOAuthStatusHandler,
  handleMailOAuthCallback,
} from "./mailOAuth";
// Flu/Task-49: org -> YouTube quota pool mapping (functions/youtubeQuotaPools.ts).
import {
  getYouTubeQuotaPools as getYouTubeQuotaPoolsHandler,
  setYouTubeQuotaPools as setYouTubeQuotaPoolsHandler,
} from "./youtubeQuotaPools";
// AI-DRAMA-DISCOVERY-METAPROMPT W6: Apify 캡챠 우회 연동 골격 (functions/captchaSolverIntegration.ts).
import {
  getCaptchaSolverIntegration as getCaptchaSolverIntegrationHandler,
  setCaptchaSolverIntegration as setCaptchaSolverIntegrationHandler,
} from "./captchaSolverIntegration";
// PLAN-ORG-MAIL-IDENTITY Slice 4: mail history backfill for a connected mail account.
import {
  startMailBackfill as startMailBackfillHandler,
  getMailBackfillStatus as getMailBackfillStatusHandler,
  runMailBackfillJobs,
} from "./mailImapBackfill";
// Flu/Task-47: rematch previously-unregistered personal-account conversations against
// candidate_pool once an operator registers a new candidate.
import { startCandidateRematch as startCandidateRematchHandler } from "./candidateRematch";
import {
  rejudgeAiDramaCampaignCandidates as rejudgeAiDramaCampaignCandidatesHandler,
  listAiDramaRelevanceAudit as listAiDramaRelevanceAuditHandler,
} from "./aiDramaRelevance";
import { diagnoseMailTransport as diagnoseMailTransportHandler } from "./mailTransportDiagnostics";
import {
  attestMailProviderSubject as attestMailProviderSubjectHandler,
  getMailProviderAttestationStatus as getMailProviderAttestationStatusHandler,
  revokeMailProviderSubject as revokeMailProviderSubjectHandler,
} from "./mailProviderAttestationCallables";
// 티켓 위젯(버그 제보·개선 의견) — supercent-io/ticket-widget-skill 이식. 클라 Firestore 직접 접근 없음.
import {
  submitTicket as submitTicketHandler,
  listTickets as listTicketsHandler,
  setTicketStatus as setTicketStatusHandler,
  deleteTicket as deleteTicketHandler,
  retryTicketSuperboardSync as retryTicketSuperboardSyncHandler,
} from "./tickets";
import {
  getDataset as getDatasetHandler,
  getMessageSource as getMessageSourceHandler,
  listCampaigns as listCampaignsHandler,
  listCandidatePool as listCandidatePoolHandler,
  listCommunityPosts as listCommunityPostsHandler,
  listConversationMessages as listConversationMessagesHandler,
  listConversations as listConversationsHandler,
  listUnrepliedInboxHandler,
  listCreatorComments as listCreatorCommentsHandler,
  listCreatorCommentInsights as listCreatorCommentInsightsHandler,
  listCreators as listCreatorsHandler,
  listEscalations as listEscalationsHandler,
  listProgramApplications as listProgramApplicationsHandler,
  listProgramSheetLeads as listProgramSheetLeadsHandler,
  listPrograms as listProgramsHandler,
  listReviews as listReviewsHandler,
  listScpLifecycleProfiles as listScpLifecycleProfilesHandler,
  listSubmissions as listSubmissionsHandler,
  listVideos as listVideosHandler,
} from "./read";
import { getDashboardPipelineProjection as getDashboardPipelineProjectionHandler } from "./dashboardPipelineProjection";
import { updateWorkflowItemState as updateWorkflowItemStateHandler } from "./workflowActions";
import { refreshCreatorActivityFeed as refreshCreatorActivityFeedHandler } from "./activityRefresh";
import { runCommentInsightsForVideo as runCommentInsightsForVideoHandler } from "./commentInsightsAdmin";
import {
  diffScpLifecycleProfiles as diffScpLifecycleProfilesHandler,
  getScpLifecycleProfile as getScpLifecycleProfileHandler,
  getScpLifecycleVideoHistory as getScpLifecycleVideoHistoryHandler,
  listScpLifecycleRefreshOutbox as listScpLifecycleRefreshOutboxHandler,
  processScpLifecycleRefreshOutbox as processScpLifecycleRefreshOutboxHandler,
  processScpLifecycleRefreshOutboxCore as processScpLifecycleRefreshOutboxCoreHandler,
  refreshScpLifecycleProfiles as refreshScpLifecycleProfilesHandler,
  resolveScpLifecycleProfile as resolveScpLifecycleProfileHandler,
} from "./scpLifecycleProfiles";
import {
  getScpLifecycleFlowConfig as getScpLifecycleFlowConfigHandler,
  previewScpLifecycleFlowConfig as previewScpLifecycleFlowConfigHandler,
  updateScpLifecycleFlowConfig as updateScpLifecycleFlowConfigHandler,
} from "./scpLifecycleFlowConfig";
import {
  failGemGrant as failGemGrantHandler,
  holdGemGrant as holdGemGrantHandler,
  listGemGrants as listGemGrantsHandler,
  markGemGrantPaid as markGemGrantPaidHandler,
  scheduleGemGrant as scheduleGemGrantHandler,
} from "./scpGemGrants";
import { scpCleanup as scpCleanupHandler } from "./scpCleanup";
import {
  handleScpInboundReply as handleScpInboundReplyHandler,
  recordScpColdOutreach as recordScpColdOutreachHandler,
  runScpOutreachFollowup as runScpOutreachFollowupHandler,
  scpOutreachFollowupScheduled as scpOutreachFollowupScheduledHandler,
} from "./scpOutreach";
import {
  listScpColdmailHistory as listScpColdmailHistoryHandler,
  exportScpColdmailHistoryCsv as exportScpColdmailHistoryCsvHandler,
  rebuildScpColdmailHistoryProjections as rebuildScpColdmailHistoryProjectionsHandler,
} from "./scpColdmailHistory";
import {
  reclassifyConversationAttribution as reclassifyConversationAttributionHandler,
  revertConversationAttribution as revertConversationAttributionHandler,
} from "./conversationAttribution";
import {
  getYouTubeAuthorizationStatus as getYouTubeAuthorizationStatusHandler,
  ingestSignedYouTubeAuthorizationWebhook,
} from "./youtubeAuthorization";
import {
  ingestYouTubeOAuthHandoff,
  queryYouTubeOAuthHandoffStatus,
} from "./youtubeOAuthHandoff";
import {
  provisionScpPortalCreatorBinding as provisionScpPortalCreatorBindingHandler,
  provisionScpPortalApprovedCreatorBinding as provisionScpPortalApprovedCreatorBindingHandler,
} from "./scpPortalCreatorBinding";
import { provisionScpPortalApplyBinding as provisionScpPortalApplyBindingHandler } from "./scpPortalApplyBindingAuthority";
import {
  getScpPortalSubmissionIngressReport as getScpPortalSubmissionIngressReportHandler,
} from "./scpPortalSubmissionIngress";
import {
  getScpFluApplicationCommandReport as getScpFluApplicationCommandReportHandler,
  ingestScpFluApplicationCommand,
  SCP_FLU_APPLICATION_COMMAND_PREVIOUS_SECRET_ENV,
  SCP_FLU_APPLICATION_COMMAND_SECRET_ENV,
} from "./scpFluApplicationCommand";
import {
  ingestScpFluVideoIntake,
  SCP_FLU_VIDEO_INTAKE_PREVIOUS_SECRET_ENV,
  SCP_FLU_VIDEO_INTAKE_SECRET_ENV,
} from "./scpFluVideoIntake";
import {
  ingestScpIntegrationEventV2,
  integrationEventV2ErrorStatus,
  SCP_INTEGRATION_EVENT_V2_SECRET_ENV,
  SCP_INTEGRATION_EVENT_V2_PREVIOUS_SECRET_ENV,
} from "./scpIntegrationEventV2";
import {
  drainIntegrationEventV2Callbacks,
  reconcileIntegrationEventV2ReviewCallbacks,
  reconcileIntegrationEventV2ViewSnapshotCallbacks,
  INTEGRATION_EVENT_V2_CALLBACK_CYCLE_SCHEDULE,
  SCP_INTEGRATION_EVENT_V2_CALLBACK_URL_ENV,
} from "./scpIntegrationEventV2Callbacks";
import { runScpSheetReviewSync } from "./scpSheetReviewSync";
import { runScpSheetReviewWriteback } from "./scpSheetReviewWriteback";
import {
  scpCreatorPipelineV3IntakeHandler,
  SCP_CREATOR_PIPELINE_V3_CURRENT_KEY_ID_ENV,
  SCP_CREATOR_PIPELINE_V3_CURRENT_KEY_SECRET_ENV,
  SCP_CREATOR_PIPELINE_V3_PREVIOUS_KEY_ID_ENV,
  SCP_CREATOR_PIPELINE_V3_PREVIOUS_KEY_SECRET_ENV,
} from "./scpCreatorPipelineV3Receiver";
import {
  drainVideoReviewV3Callbacks,
  SCP_VIDEO_REVIEW_CALLBACK_CURRENT_KEY_ID_ENV,
  SCP_VIDEO_REVIEW_CALLBACK_CURRENT_KEY_SECRET_ENV,
  SCP_VIDEO_REVIEW_CALLBACK_PREVIOUS_KEY_ID_ENV,
  SCP_VIDEO_REVIEW_CALLBACK_PREVIOUS_KEY_SECRET_ENV,
  SCP_VIDEO_DOWNSTREAM_CALLBACK_CURRENT_KEY_ID_ENV,
  SCP_VIDEO_DOWNSTREAM_CALLBACK_CURRENT_KEY_SECRET_ENV,
  SCP_VIDEO_DOWNSTREAM_CALLBACK_PREVIOUS_KEY_ID_ENV,
  SCP_VIDEO_DOWNSTREAM_CALLBACK_PREVIOUS_KEY_SECRET_ENV,
} from "./scpVideoReviewV3Callbacks";
import {
  scpVideoRevisionIngressHandler,
  SCP_VIDEO_REVIEW_CURRENT_KEY_ID_ENV,
  SCP_VIDEO_REVIEW_CURRENT_KEY_SECRET_ENV,
  SCP_VIDEO_REVIEW_PREVIOUS_KEY_ID_ENV,
  SCP_VIDEO_REVIEW_PREVIOUS_KEY_SECRET_ENV,
} from "./scpVideoRevisionIngress";
import { drainOnboardingOutbox, drainVideoResultMailOutbox, drainContentSubmittedMailOutbox, drainApplicationConfirmedMailOutbox, drainApplicationVideoReminderOutbox, drainLoginApprovedMailOutbox, drainLoginRejectedMailOutbox } from "./scpOutboxMailWorkers";
import { drainUidGuideOutbox } from "./scpUidGuideMailWorker";
import { drainCreatorPipelineV3ManagementAck, backfillDeclaredAudienceCountry } from "./scpCreatorPipelineV3ManagementAckStore";
import { sweepApplicationEligibilityJudge } from "./applicationEligibilityJudgeSweep";
import { undoApplicationQualificationDecisionHandler } from "./applicationQualificationLedger";
import { rejudgeApplicationQualificationHandler } from "./applicationQualificationRejudge";
import { drainVideoReviewAnalysisJudge, videoReviewAnalysisJudgeScheduleLogSummary } from "./videoReviewAnalysisJudge";
import {
  runYouTubeOAuthCredentialRefreshSweep,
  runYouTubeOAuthLifecycleDeliverySweep,
} from "./youtubeOAuthLifecycle";
import { previewEmailDraft as previewEmailDraftHandler } from "./mailPreview";
import { processVideoClassificationQueue as processVideoClassificationQueueHandler } from "./videoClassifier";
import { processVideoAdClassificationQueue as processVideoAdClassificationQueueHandler } from "./videoAdClassifier";
import { classifyFeedVideoAds as classifyFeedVideoAdsHandler } from "./videoAdClassifierAdmin";
import {
  createAdProposal as createAdProposalHandler,
  listAdProposals as listAdProposalsHandler,
  recordAdProposalFeedback as recordAdProposalFeedbackHandler,
} from "./adProposal";
import {
  promoteDiscoveredCreators as promoteDiscoveredCreatorsHandler,
  promoteCandidatesToCreators as promoteCandidatesToCreatorsHandler,
} from "./creatorPromotion";
import {
  runVideoViewSnapshots as runVideoViewSnapshotsHandler,
  getVideoViewSeries as getVideoViewSeriesHandler,
  getVideoViewRollups as getVideoViewRollupsHandler,
} from "./videoViewSnapshotsAdmin";
import { processVideoViewSnapshotQueue as processVideoViewSnapshotQueueHandler } from "./videoViewSnapshots";
import { getVideoMetricExact168hReadiness as getVideoMetricExact168hReadinessHandler } from "./videoPerformanceObservationAdmin";
import { judgeVideoReviewMultimodalCallable as judgeVideoReviewMultimodalHandler } from "./videoReviewMultimodal";
import { previewVideoReviewMediaResolution as previewVideoReviewMediaResolutionHandler } from "./videoReviewMultimodal";
import {
  drainVideoReviewAutomationOutbox as drainVideoReviewAutomationOutboxHandler,
  processVideoReviewAutomationOutbox as processVideoReviewAutomationOutboxHandler,
  backfillVideoReviewAutomationOutboxCallable as backfillVideoReviewAutomationOutboxHandler,
  getVideoReviewAutomationOutboxStatusCallable as getVideoReviewAutomationOutboxStatusHandler,
  forceRedrainVideoReviewAutomationOutboxCallable as forceRedrainVideoReviewAutomationOutboxHandler,
  videoReviewAutomationScheduleLogSummary,
} from "./videoReviewAutomationOutbox";
import { runWeeklyDeepAnalysisBatch } from "./videoDeepAnalysis";
import {
  buildWeeklyTrendSnapshot,
  publishWeeklyTrendReport,
  weekWindowForKey,
  type WeeklyTrendSnapshot,
  type WeeklyVideoRecord,
} from "./trendReport";
import {
  recordGoldenSetLabelImpl,
  computeGoldenSetAgreement,
  type GoldenSetQualitativeLabel,
  type FirestoreDb as GoldenSetFirestoreDb,
} from "./goldenSet";
import { adminAuth, adminDb } from "./firebaseAdmin";
import { adminRuntimeEnvironment } from "./firebaseAdmin";
import { assertCallableAuthTenantBoundary } from "./authTenantBoundary";
import type { CallableRequestShape, Role } from "./shared";
import { assertNonGuestAuth, asRecord, makeBehaviorLog, makeDeniedBehaviorLog } from "./shared";
import { sweepApplicationDeclaredIdentity as sweepApplicationDeclaredIdentityHandler } from "./applicationDeclaredIdentitySweep";

type Handler = (request: CallableRequestShape) => Promise<unknown>;
type CallableRuntimeConfig = {
  readonly secrets?: string[];
  readonly maxInstances?: number;
  // Perf/cost 2026-09-24: opt-in only, last resort per callable — every idle minInstance is a
  // standing cost. Omit unless a callable is both on a real user-facing cold-start path and has
  // no cheaper fix (batching/caching first). Deliberately no cpu/concurrency override here: the
  // default (idle CPU throttling) stays on, so a warm-but-unused instance still bills at the
  // cheaper throttled rate instead of "always allocated" CPU.
  readonly minInstances?: number;
  readonly timeoutSeconds?: number;
  readonly memory?: "128MiB" | "256MiB" | "512MiB" | "1GiB";
  readonly concurrency?: number;
  readonly enforceAppCheck?: boolean;
};

const DEFAULT_CALLABLE_RUNTIME = {
  cors: true,
  maxInstances: 10,
  timeoutSeconds: 60,
  memory: "512MiB" as const,
  concurrency: 20,
};

// Perf/cost 2026-09-27: TTL for cacheableRead() below (functions/readCache.ts) — shorter than the
// client-side SWR caches this same read traffic already tolerates being stale for
// (ORG_CONTEXT_CACHE_TTL_MS, PARTNER_LIST_CACHE_TTL_MS, CANDIDATE_LIST_CACHE_TTL_MS,
// CONVERSATION_LIST_CACHE_TTL_MS all use 60s in src/lib/), so this server layer is never the
// longer staleness bound. Set below the 30-60s starting target after adversarial review (codex,
// round 1 HIGH): this cache has no write-side invalidation hook, so a mutation immediately
// followed by the same caller re-reading the same params can observe the pre-write value until
// this entry expires — see functions/readCache.ts's header comment for the full tradeoff.
//
// Only listCreators below is wrapped with this cache. codex round 2 adversarial review found that
// every OTHER top-invocation-count read candidate (getDataset/listCampaigns/listConversations/
// listPrograms/listProgramApplications/getMyOrgContext) resolves the caller's *live* mailbox/
// account grant on every request (mailAccounts.ts's readExplicitMailAccountIds, deliberately
// never cached so access revocation is immediate) — caching their whole response would delay that
// revocation by up to READ_CACHE_TTL_MS. listCreators is the one candidate whose only
// authorization is the static role check (canReadDatasetKey — "creators" is not in read.ts's
// ACCOUNT_OWNERSHIP_DATASET_KEYS), so it has no such live grant to go stale. See each excluded
// export's own comment below for its specific reason.
const READ_CACHE_TTL_MS = 15_000;

const PUBLIC_CALLABLE_RUNTIME = {
  enforceAppCheck:
    process.env.FUNCTIONS_EMULATOR !== "true" &&
    !process.env.FIRESTORE_EMULATOR_HOST,
} satisfies CallableRuntimeConfig;
// R21-1: YouTube Data API 키 4개(주 + 폴백 3). 로테이션 로직(fetchYouTubeRecord)은 이미 있었고
// 막힌 것은 **키 목록이 2개뿐**이라는 점이었다. 목록이 index.ts 안에 여러 번 복제돼 있던 것이
// 새 키가 조용히 빠진 근인이므로, 인라인 리터럴을 이 상수 하나로 모은다.
// Flu/Task-49: YOUTUBE_POOL_DRAMA_1_API_KEY 추가 — Cloud Functions의 secrets 배열은 배포 시점에
// 정적이라(동적 구성 불가) 새 풀의 키를 쓰는 함수는 전부 이 상수를 통해서만 바인딩할 수 있다. 풀
// 라우팅 자체(functions/youtubeQuotaPools.ts)는 이 시크릿이 바인딩된 함수 안에서 orgId 기준으로
// growth/drama_1 중 어느 값을 실제로 읽을지 고른다 — growth 조직은 여전히 위 4개만 쓴다(회귀 0).
const YOUTUBE_API_SECRETS = [
  "YOUTUBE_API_KEY",
  "YOUTUBE_API_KEY_FALLBACK_1",
  "YOUTUBE_API_KEY_FALLBACK_2",
  "YOUTUBE_API_KEY_FALLBACK_3",
  "YOUTUBE_POOL_DRAMA_1_API_KEY",
];
// Account-ownership resolution verifies the signed caller's email against
// Peoply. Bind this existing secret only to exports that enter that resolver.
const PEOPLY_API_SECRETS = ["PEOPLY_API_KEY"];

// Live 어댑터가 런타임에 process.env로 읽는 secret을 함수별로 바인딩(Secret Manager).
// secret을 실제로 읽는 callable에만 바인딩한다 — 그 외(admin/settings/crm/...)는 바인딩 없음.
// 로컬 에뮬레이터(demo-flu)는 Secret Manager가 없으므로, secret 미바인딩 callable은 호출 시 에러 없이 동작한다.
// gateway(GATEWAY_API_KEY)는 엔드포인트 확보 후 추가 — 현재 mock.
function callable(
  handler: Handler,
  config: string[] | CallableRuntimeConfig = {},
  options: { persistOutcome?: boolean } = {},
) {
  // persistOutcome=false: for callables whose contract REQUIRES zero durable mutation on
  // dry-run/rejection (G008 identity-authority engine) — callableRuns/engineSnapshots
  // writes on every outcome would violate that contract. Non-durable logs still apply.
  const persistOutcome = options.persistOutcome !== false;
  const runtime = Array.isArray(config) ? {} : config;
  const secrets = Array.isArray(config) ? config : runtime.secrets;
  return onCall(
    {
      ...DEFAULT_CALLABLE_RUNTIME,
      ...runtime,
      ...(secrets && secrets.length ? { secrets } : {}),
    },
    async (request) => {
      try {
        assertCallableAuthTenantBoundary(
          request.auth,
          process.env,
          adminRuntimeEnvironment,
        );
      } catch (error) {
        throw toHttpsError(error);
      }

      const shapedRequest = {
        auth: request.auth
          ? {
              uid: request.auth.uid,
              token: {
                role: request.auth.token.role as Role | undefined,
                team:
                  typeof request.auth.token.team === "string"
                    ? request.auth.token.team
                    : undefined,
                gameId:
                  typeof request.auth.token.gameId === "string"
                    ? request.auth.token.gameId
                    : undefined,
                email:
                  typeof request.auth.token.email === "string"
                    ? request.auth.token.email
                    : undefined,
                // Keep only the reserved identity claims needed by the
                // self-ownership path. This projection happens after both
                // the callable runtime's ID-token verification and the exact
                // tenant boundary above; never copy arbitrary token claims.
                emailVerified: request.auth.token.email_verified === true,
                firebase: typeof request.auth.token.firebase?.tenant === "string"
                  ? { tenant: request.auth.token.firebase.tenant }
                  : undefined,
                name:
                  typeof request.auth.token.name === "string"
                    ? request.auth.token.name
                    : undefined,
                picture:
                  typeof request.auth.token.picture === "string"
                    ? request.auth.token.picture
                    : undefined,
                memberName:
                  typeof request.auth.token.memberName === "string"
                    ? request.auth.token.memberName
                    : undefined,
                memberEmail:
                  typeof request.auth.token.memberEmail === "string"
                    ? request.auth.token.memberEmail
                    : undefined,
                memberPhotoURL:
                  typeof request.auth.token.memberPhotoURL === "string"
                    ? request.auth.token.memberPhotoURL
                    : undefined,
                claimSyncReason:
                  typeof request.auth.token.claimSyncReason === "string"
                    ? request.auth.token.claimSyncReason
                    : undefined,
                financeRole:
                  typeof request.auth.token.financeRole === "string"
                    ? request.auth.token.financeRole
                    : undefined,
                scpFinanceRole:
                  typeof request.auth.token.scpFinanceRole === "string"
                    ? request.auth.token.scpFinanceRole
                    : undefined,
                finance_role:
                  typeof request.auth.token.finance_role === "string"
                    ? request.auth.token.finance_role
                    : undefined,
              },
            }
          : undefined,
        data: request.data,
        app: request.app ? { appId: request.app.appId } : undefined,
        rawRequest: { ip: request.rawRequest.ip },
      } as CallableRequestShape;

      try {
        // Flu/Task-50 적대 리뷰 P1: 핸들러를 부르기 전에 먼저 거른다 — 화이트리스트 밖 콜러블은
        // viewAsUserId를 아예 받지 않는다(쓰기 권한이 "대신 보기"로 격상되지 않는다는 계약).
        assertViewAsReadOnlyPayload(handler.name, shapedRequest.data);
        const result = await handler(shapedRequest);
        if (persistOutcome) {
          await persistCallableOutcome(
            handler.name,
            shapedRequest,
            result,
            "success",
          );
        }
        return toCallableResponse(result);
      } catch (error) {
        // Flu/Task-50 재리뷰 — viewAsWriteGuard.ts의 거부(view_as_write_forbidden)는 핸들러를
        // 부르기도 전에 던져지므로 핸들러 자신의 makeBehaviorLog 호출을 절대 못 거친다 — 여기서
        // 합성하지 않으면 이 거부는 behavior_logs에 전혀 안 남는다. request(guest/미인증 포함
        // 누구든 이 게이트에 걸릴 수 있다)에서 직접 만드는 makeDeniedBehaviorLog를 쓴다 —
        // assertNonGuestAuth(AuthContext 요구, guest 거부)와 달리 예외를 던지지 않는다.
        if (
          error && typeof error === "object" &&
          (error as { errorCode?: unknown }).errorCode === "view_as_write_forbidden" &&
          !(error as { behaviorLog?: unknown }).behaviorLog
        ) {
          Object.assign(error, {
            behaviorLog: makeDeniedBehaviorLog(shapedRequest, `viewAs.writeDenied(${handler.name})`),
          });
        }
        if (persistOutcome) {
          await persistCallableOutcome(
            handler.name,
            shapedRequest,
            error,
            "error",
          );
        }
        throw toHttpsError(error);
      }
    },
  );
}

async function persistCallableOutcome(
  name: string,
  request: CallableRequestShape,
  outcome: unknown,
  status: "success" | "error",
) {
  const record =
    outcome && typeof outcome === "object"
      ? (outcome as Record<string, unknown>)
      : {};
  const behaviorLog =
    record.behaviorLog && typeof record.behaviorLog === "object"
      ? (record.behaviorLog as Record<string, unknown>)
      : null;
  const costLog =
    record.costLog && typeof record.costLog === "object"
      ? (record.costLog as Record<string, unknown>)
      : null;
  const gameId = asString(
    behaviorLog?.gameId,
    request.auth?.token?.gameId ?? "global",
  );
  const callableName = name || "anonymousCallable";
  const snapshotRef = adminDb.collection("engineSnapshots").doc(callableName);
  const output = summarizeOutcome(record);

  const batch = adminDb.batch();
  const runRef = adminDb.collection("callableRuns").doc();

  batch.set(runRef, {
    name: callableName,
    status,
    uid: request.auth?.uid ?? null,
    role: request.auth?.token?.role ?? "guest",
    team: request.auth?.token?.team ?? "unknown",
    gameId,
    payload: summarizePayload(request.data),
    output,
    createdAt: FieldValue.serverTimestamp(),
  });

  batch.set(
    snapshotRef,
    {
      name: callableName,
      status,
      gameId,
      lastRunRef: runRef.path,
      lastPayload: summarizePayload(request.data),
      lastOutput: output,
      // Atomic increment removes a serialized read from every callable response and prevents
      // concurrent requests from overwriting each other's run count.
      runCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  if (behaviorLog) {
    const createdAt = Timestamp.now();
    batch.set(adminDb.collection("behavior_logs").doc(), {
      ...behaviorLog,
      callable: callableName,
      createdAt,
      expireAt: expireAt180DaysFromTimestamp(createdAt),
    });
  }

  if (costLog) {
    const costRef = adminDb.collection("cost_logs").doc();
    batch.set(
      costRef,
      normalizeCostLog(costLog, callableName, gameId, costRef.path),
    );
  }

  await batch.commit();
}

function normalizeCostLog(
  costLog: Record<string, unknown>,
  callableName: string,
  gameId: string,
  fallbackLedgerRef: string,
) {
  const normalizedCostLogLoggedAt = asString(costLog.loggedAt, new Date().toISOString());
  return {
    ...costLog,
    ledgerRef: asString(costLog.ledgerRef, fallbackLedgerRef),
    provider: asString(costLog.provider, asString(costLog.meter, "mock")),
    model: asString(
      costLog.model,
      asString(costLog.action, asString(costLog.source, callableName)),
    ),
    cacheChecked:
      typeof costLog.cacheChecked === "boolean" ? costLog.cacheChecked : true,
    cacheHit: typeof costLog.cacheHit === "boolean" ? costLog.cacheHit : false,
    inputTokens: nonNegativeInteger(
      costLog.inputTokens ?? costLog.tokensIn ?? costLog.tokens,
    ),
    outputTokens: nonNegativeInteger(costLog.outputTokens ?? costLog.tokensOut),
    estimatedKRW: estimatedKrw(costLog),
    currency: "KRW",
    billable: typeof costLog.billable === "boolean" ? costLog.billable : false,
    loggedAt: normalizedCostLogLoggedAt,
    callable: callableName,
    gameId,
    createdAt: FieldValue.serverTimestamp(),
    expireAt: expireAt180DaysFromIso(normalizedCostLogLoggedAt),
  };
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}

function estimatedKrw(costLog: Record<string, unknown>): number {
  const explicitKrw =
    finiteNumber(costLog.estimatedKRW) ?? finiteNumber(costLog.costKRW);
  if (explicitKrw !== undefined) return Math.max(0, Math.round(explicitKrw));

  const amount = finiteNumber(costLog.amount);
  if (
    amount !== undefined &&
    asString(costLog.currency, "").toUpperCase() === "KRW"
  ) {
    return Math.max(0, Math.round(amount));
  }

  const usd =
    finiteNumber(costLog.estimatedCostUsd) ??
    finiteNumber(costLog.costUSD) ??
    finiteNumber(costLog.estimatedUsd);
  return usd === undefined ? 0 : Math.max(0, Math.round(usd * 1400));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function summarizePayload(value: unknown): Record<string, unknown> {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    Object.entries(input)
      .filter(
        ([key, item]) =>
          /(^id$|id$|ref$|role$|status$|gameId$|team$|target$|rating$|priority$|reasonCode$)/i.test(
            key,
          ) && isSafeScalar(item),
      )
      .map(([key, item]) => [key, item]),
  );
}

function summarizeOutcome(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ok: record.ok === true,
    keys: Object.keys(record)
      .filter((key) => key !== "behaviorLog" && key !== "costLog")
      .slice(0, 20),
  };
}

function isSafeScalar(
  value: unknown,
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (typeof value === "string" && value.length <= 140)
  );
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

// Auth claims pipeline: allowed organization accounts receive read-only viewer
// access. Unknown domains remain guest/pending, and no signup path grants writes.
// (AUTH-P0-001: 신규 가입자를 admin/manager로 승격하지 않는다.)
export const assignGuestClaims = authEvents.user().onCreate(async (user) => {
  // Identity Platform tenants share the project-wide onCreate trigger surface.
  // Staging tenant accounts must never mutate parent Auth claims or `(default)`
  // Firestore membership records through this production bootstrap path.
  if (user.tenantId) {
    return;
  }
  if (
    process.env.FUNCTIONS_EMULATOR === "true" &&
    user.email === "test-admin@demo-flu"
  ) {
    return;
  }
  const access = authBootstrapAccessForEmail(user.email);
  await adminAuth.setCustomUserClaims(user.uid, {
    role: access.role,
    team: access.team,
    claimSyncReason: access.claimSyncReason,
  });
  await upsertPendingMemberFromAuthUser(user);
});
// M1 discovery callable exports — YouTube Data API secret
// ai_drama JEV relevance gate (functions/aiDramaRelevance.ts, wired inside searchYouTubeLive) reaches
// callJev whenever discoveryVertical === "ai_drama" — JEV_API_KEY/AI_HUB_LLM_API_KEY bound below on
// every export that can reach searchYouTubeLive so the gate never fails closed for a missing secret.
export const youtubeSearch = callable(
  youtubeSearchHandler,
  [...YOUTUBE_API_SECRETS, "AI_HUB_LLM_API_KEY", "JEV_API_KEY"],
);
export const emailFinder = callable(emailFinderHandler, YOUTUBE_API_SECRETS);
export const queueYtDlpDiscovery = callable(
  queueYtDlpDiscoveryHandler,
  [...YOUTUBE_API_SECRETS, ...PEOPLY_API_SECRETS, "AI_HUB_LLM_API_KEY", "JEV_API_KEY"],
);
export const getDiscoveryRunStatus = callable(getDiscoveryRunStatusHandler);
export const queueCommunityDiscovery = callable(queueCommunityDiscoveryHandler);

export const processDiscoveryQueue = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    concurrency: 1,
    retryCount: 0,
    timeoutSeconds: 540,
    // 2026-09-26 [프로드 실측]: 512MiB 에서 하루 십수~수십 회 OOM 크래시(actual 512-532MiB
    //   used) — maxInstances:1·retryCount:0 라 크래시 한 번마다 그 5분 틱의 배치
    //   (DISCOVERY_QUEUE_SWEEP_LIMIT=2 잡)가 통째로 유실된다. 09-16부터 빈도가 늘다 09-21부터
    //   급증(47/26/11/32/52 건/일)했고, 같은 창에서 전역 "신규 편입"(campaign_candidates 최초
    //   등장)이 ~280-300/일 → 31-120/일로 붕괴했다 — 이 스케줄러가 전 캠페인 공용 단일 워커라
    //   크래시 손실이 특정 캠페인이 아니라 시스템 전체 발굴 처리량을 갉아먹는다. 512→1GiB로
    //   여유를 둔다(추가 비용은 무시 가능 — 5분 스케줄 1개, 초과분 20MiB 수준).
    memory: "1GiB",
    // S12 A5: communitySearch 경유로 reportLlmUsage에 도달 — AI Hub secret 바인딩 보강.
    // AI-DRAMA Apify: materializePublicWebBackfill(=이 워커가 도는 processDiscoveryQueueHandler의
    // "public-web-backfill" 잡 타입 경로)이 T049 등 allowedOrgIds org에서 captchaSolverIntegration의
    // callApifyChannelEmailActor를 부른다 — 이 워커만 APIFY_API_KEY를 바인딩한다. 다른 호출부
    // (triggerScopedCampaignDiscovery — createCampaign/prepareProgramCampaignTargets/
    // processCampaignOutreachQueue 경로)는 20초 예산(PUBLIC_WEB_EMAIL_BACKFILL_DEADLINE_MS)이라
    // APIFY_CALL_MIN_BUDGET_MS(60s) 문턱을 구조적으로 못 넘어 이 시크릿을 절대 읽지 않는다(캐시
    // 조회만 한다) — 그래서 그 경로들에는 바인딩하지 않는다(불필요한 시크릿 노출면 최소화).
    // JEV_API_KEY: 이 워커가 materializeYtDiscoveryRun→searchYouTubeLive를 직접 도는 유일한 스케줄
    // 경로다 — ai_drama 런은 여기서 aiDramaRelevance.ts의 관련성 게이트(callJev)를 반드시 거치므로,
    // 시크릿 미바인딩이면 매 판정이 fail-closed(hold)되어 ai_drama 발굴이 사실상 통째로 막힌다.
    secrets: [...YOUTUBE_API_SECRETS, "AI_HUB_LLM_API_KEY", "APIFY_API_KEY", "JEV_API_KEY"],
  },
  async () => {
    await processDiscoveryQueueHandler();
  },
);

/**
 * W115 — **재고 하한 상시가동(1만 명).**
 *
 * 왜 기존 스윕에 얹지 않았나: 하한 수확 레인은 `processCampaignOutreachQueue` 안에 있고 그 캠페인
 * 쿼리가 `autoApproveLiveSend == true` 로 좁혀져 있다 — 발송 자동화가 꺼진 상태(사고 대응·주말
 * 정지)에서는 발굴이 통째로 섰다. 재고는 발송 상태와 독립 축이므로 자기 스케줄을 갖는다.
 * 게다가 그 레인은 스윕의 **시간 예산 잔여**에 매달린 꼬리라, 예산이 마르면 조용히 건너뛴다.
 *
 * 주기 30분: 발굴 잡은 큐잉 → 워커(5분 tick) → 적재까지 지연이 있어 더 촘촘히 돌 이유가 없고,
 * `enqueueShortfallDiscoveryJob` 의 캠페인별 1시간 간격 게이트가 실질 상한이라 그보다 짧은 주기는
 * 게이트에 막혀 계측만 반복한다. 잡을 실제로 태우는 상한은 이 주기가 아니라 그 게이트다.
 *
 * timeoutSeconds 300: 한 pass 의 실작업은 캠페인 목록 1회 읽기 + 최대 3건 enqueue 다
 * (프리뷰 검색은 deferPreviewMaterialization 으로 워커에 넘긴다).
 */
export const scheduledDiscoveryInventoryFloor = onSchedule(
  {
    schedule: "every 30 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    concurrency: 1,
    retryCount: 0,
    timeoutSeconds: 300,
    memory: "512MiB",
    secrets: [...YOUTUBE_API_SECRETS, "AI_HUB_LLM_API_KEY"],
  },
  async () => {
    await runDiscoveryInventoryFloorSweepHandler();
  },
);

/**
 * AI-DRAMA-DISCOVERY-METAPROMPT W5 — JEV 댓글 감성 스윕. comment_insights_pending 큐(ai_drama-vertical
 * 발굴 materialize 시점에만 세워진다 — materializeYtDiscoveryRun)를 드레인한다. 다른 어떤 스케줄도
 * JEV_API_KEY를 바인딩하지 않았다(스펙 명시 사항) — 이 함수가 최초 바인딩이다. YOUTUBE_API_SECRETS
 * (growth 4키 + drama_1)도 함께 바인딩 — 댓글 수집이 commentThreads.list를 후보의 org 풀 라우팅으로
 * 호출한다(W2 격리 유지, growth 새지 않음). AI_HUB_LLM_API_KEY도 바인딩 — callJev 의 내장
 * reportLlmUsage 가 AI Hub 외부 보고 레그에서 이 시크릿을 읽는다(processDiscoveryQueue 등 기존
 * 스케줄과 동일 패턴, Codex 적대 리뷰 P1 수리 — 없어도 그 레그는 조용히 no-op 이지만 COST-P0-006/007
 * 완전성을 위해 바인딩한다).
 * 주기 10분: 발굴 pass(5분) 보다 넉넉히 느슨해 pending 적재 속도를 항상 앞선다. 실작업은 pass당
 * 최대 5건(JEV 콜 + commentThreads.list 콜) 뿐이라 타임아웃 여유를 크게 둔다.
 */
export const scheduledCreatorCommentSentimentSweep = onSchedule(
  {
    schedule: "every 10 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    concurrency: 1,
    retryCount: 0,
    timeoutSeconds: 300,
    memory: "512MiB",
    secrets: [...YOUTUBE_API_SECRETS, "JEV_API_KEY", "AI_HUB_LLM_API_KEY"],
  },
  async () => {
    await sweepCreatorCommentSentimentHandler();
  },
);

export const scheduledCommunityDiscovery = onSchedule(
  {
    schedule: "0 0 * * *",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 1,
    timeoutSeconds: 540,
    memory: "512MiB",
    // P8↔P12 결합(S12 A5): reportLlmUsage 도달 5번째 함수 — AI Hub secret 바인딩 보강.
    secrets: [...YOUTUBE_API_SECRETS, "AI_HUB_LLM_API_KEY"],
  },
  async () => {
    // 26-07-07 재개 승인(S8 인터뷰 #6, 조건: AI_HUB 바인딩 보강 — 위 secrets 반영 완료).
    // 26-07-08 G-DEPLOY(헤세 승인)로 재개: false 전환. 재정지가 필요하면 true로 되돌리고 재배포.
    const COMMUNITY_DISCOVERY_PAUSED: boolean = false;
    if (COMMUNITY_DISCOVERY_PAUSED) return;
    await scheduledCommunityDiscoveryHandler();
  },
);

// 2026-09-27: 정지된 09:00 웹훅 리포트(slackDailyReport.ts)를 삭제했다 — 10:00 봇 리포트(W73)가
// 대체한 지 오래고, LEGACY_SLACK_DAILY_REPORT_PAUSED=true 로 하드 정지된 채 실제 전송이 없었다.
// 이 스케줄 함수 자체가 프로덕션에 배포돼 있었다면(과거 `postSlackDailyReportSchedule`), 운영자가
// `firebase functions:delete postSlackDailyReportSchedule --project <prod-project> --force` 로
// 별도 삭제해야 한다 — 소스에서 지운다고 배포된 함수가 같이 지워지지 않는다(docs/DEPLOYMENT.md).
//
// W73: exactly one new schedule. KST weekday/date branching happens inside the formatter so daily,
// Monday weekly, and first-of-month monthly reports share one 10:00 invocation and one bot token.
// W110: 월요일 리포트는 **누계 구간의 레인 분해**까지 읽는다(월 단위 콜드+독려 행). 화~일은
//   종전과 같은 부하다. retryCount 0 이라 한 번 터지면 그 주 리포트가 통째로 없어지므로,
//   가장 무거운 날 기준으로 예산을 잡는다. 하루 한 번 · 수 초짜리 함수라 GB-s 증가분은 무시할 수준이다.
export const postSlackScheduledBotReportsSchedule = onSchedule(
  {
    schedule: "0 10 * * *",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 0,
    timeoutSeconds: 300,
    memory: "512MiB",
    secrets: ["SLACK_BOT_TOKEN"],
  },
  async () => {
    await slackScheduledReportsHandler();
  },
);

// Creator Portal Daily Outreach: Flu owns send/reply/apply attribution and exports only
// aggregate KST cohorts. Recompute nine dates so the final late-day send in a seven-day
// window receives one fully-mature snapshot on the following scheduler pass.
export const deliverOutreachFunnelSnapshotsSchedule = onSchedule(
  {
    schedule: "every day 05:30",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    concurrency: 1,
    retryCount: 1,
    timeoutSeconds: 300,
    memory: "256MiB",
    secrets: ["SCP_FLU_OUTREACH_FUNNEL_SECRET"],
  },
  async () => {
    // Per-date results ride the same log line on both paths: a partial pass must name which dates
    // moved and which one blocked, and it must still end as a failure so the scheduler retries.
    const logPass = (pass: OutreachFunnelPassResult, failed: boolean) => {
      const line = JSON.stringify({
        accepted: pass.accepted,
        duplicate: pass.duplicate,
        failed: pass.failed,
        firstDate: pass.dates[0] ?? "",
        lastDate: pass.dates.at(-1) ?? "",
        results: pass.results,
      });
      if (failed) console.error("[outreach-funnel-snapshot]", line);
      else console.log("[outreach-funnel-snapshot]", line);
    };
    try {
      logPass(await deliverRecentOutreachFunnelSnapshots({
        baseUrl: "https://creator.supercent.io",
      }), false);
    } catch (error) {
      if (error instanceof OutreachFunnelPassError) logPass(error.pass, true);
      throw error;
    }
  },
);

// Slack @멘션 인바운드 — 공개 HTTP 표면은 raw body 서명 검증 후 allowlist + 멱등 inbox 적재만
// 수행한다. Slack API 호출은 아래 Firestore 생성 트리거로 분리해 3초 ACK 경로에서 제외한다.
export const slackBotEvents = onRequest(
  {
    invoker: "public",
    maxInstances: 3,
    concurrency: 20,
    timeoutSeconds: 15,
    memory: "256MiB",
    secrets: ["SLACK_SIGNING_SECRET"],
  },
  slackBotEventsHandler,
);

// event_id 해시 문서를 transaction 으로 queued→processing claim 하므로 Eventarc 중복 전달도
// 실제 Slack 호출을 두 번 시작하지 않는다. 봇 토큰은 이 외부 호출 함수에만 바인딩한다.
export const processSlackBotEventInbox = onDocumentCreated(
  {
    document: "slack_event_inbox/{eventId}",
    maxInstances: 3,
    concurrency: 1,
    timeoutSeconds: 60,
    memory: "256MiB",
    secrets: ["SLACK_BOT_TOKEN"],
  },
  async (event) => {
    await processSlackBotInboxDocument(event.data);
  },
);

// M2 rec callable exports — discovery 연동 (YouTube Data API secret)
export const recommendCreators = callable(
  recommendCreatorsHandler,
  YOUTUBE_API_SECRETS,
);

// M3 chat-ai callable exports — SMTP/IMAP + AI Hub LLM secret
// S4/P4 (RT-4/A4): wrapped at this callable boundary (not inside chat-ai.ts) with a
// permanent per-messageRef cache so the chat-open on-demand prefill flow never re-calls
// the model for an inbound message it has already resolved — see chatDraftPrefillCache.ts.
// 2026-09-27 codex adversarial review round 2: exactFeedbackScopeForGateway now resolves the
// caller's org via Peoply (functions/conversationMailAccessScope.ts) to enforce the scp
// per-org gate — PEOPLY_API_KEY must be bound or every non-super_admin caller resolves a null org.
export const gatewayProxy = callable(withAutoPrefillCache(gatewayProxyHandler), ["AI_HUB_LLM_API_KEY", "JEV_API_KEY", "PEOPLY_API_KEY"]);
// Deployed in the production manifest so the staging facade can prefix and
// isolate it. The handler itself rejects every non-staging runtime before work.
export const runStagingAiGatewayEval = callable(
  runStagingAiGatewayEvalHandler,
  {
    secrets: ["AI_HUB_LLM_API_KEY"],
    maxInstances: 1,
    concurrency: 1,
    timeoutSeconds: 300,
    memory: "512MiB",
  },
);
function resolveChatAutoPermitCurrentSourceCommit(): string {
  const stagingSourceCommit = (globalThis as Record<symbol, unknown>)[Symbol.for("flu.functions.staging-release-source-commit")];
  if (typeof stagingSourceCommit === "string" && /^[a-f0-9]{40}$/.test(stagingSourceCommit)) return stagingSourceCommit;
  return resolveChatAutoPermitReleaseIdentity().sourceCommit;
}
// 2026-09-27 scp entitlement gate (casebook, this callable's own — NOT the broader sweep that
// lived on fix/scp-surface-gate and was reverted from this branch on 2026-09-28): both call
// isCallerScpEntitled (functions/mailAccounts.ts) to gate the replyText field, which needs
// PEOPLY_API_KEY to resolve a non-super_admin caller's org.
// codex adversarial review round 4 (2026-09-28) P0: callable()'s viewAs guard (and its
// persistCallableOutcome/behaviorLog audit logging, further below) key off `handler.name`. An
// arrow function passed inline as an argument has NO name (`fn.name === ""`) — the previous
// `(request) => ...` wrappers here silently defeated both the viewAs allowlist match (this
// export's replyText fix from round 3 never actually ran under viewAs — the guard rejected the
// payload before the handler was ever reached) AND every audit-log entry for these two callables
// (recorded under an empty name). A NAMED function expression keeps its own name even when passed
// inline, without colliding with the outer `const` binding of the same name (function-expression
// names are scoped to their own body only).
export const getChatAutoCasePermitStatus = callable(
  function getChatAutoCasePermitStatus(request) {
    return getChatAutoCasePermitStatusHandler(request, {
      resolveModelVersion: resolveChatAutoPermitCurrentModelVersion,
      resolveSourceCommit: resolveChatAutoPermitCurrentSourceCommit,
    });
  },
  ["PEOPLY_API_KEY"],
);
export const setChatAutoCasePermitArming = callable(
  function setChatAutoCasePermitArming(request) {
    return setChatAutoCasePermitArmingHandler(request, {
      resolveModelVersion: resolveChatAutoPermitCurrentModelVersion,
      resolveSourceCommit: resolveChatAutoPermitCurrentSourceCommit,
    });
  },
  // Arming an operator-saved counter reply may await one Vertex semantic-guard call (callModel has its own
  // transport timeout); keep the callable timeout well above it so usage is always reported inside the request.
  { secrets: ["PEOPLY_API_KEY", "SLACK_BOT_TOKEN"], timeoutSeconds: 180 },
);
export const runChatAutoCasePermitEval = callable(
  (request) => runChatAutoCasePermitEvalHandler(request, {
    buildSha: resolveChatAutoPermitReleaseIdentity().sourceCommit,
    resolveModelVersion: resolveChatAutoPermitCurrentModelVersion,
    runGatewayEval: runChatAutoPermitGatewayEvalScenario,
  }),
  {
    secrets: ["AI_HUB_LLM_API_KEY", "JEV_API_KEY", "SLACK_BOT_TOKEN"],
    maxInstances: 1,
    concurrency: 1,
    timeoutSeconds: 300,
    memory: "512MiB",
  },
);
// 헤세 지시(2026-09-24, JEV 컨텍스트 모순 수리 부수 작업): armed chat-auto-case permit 의
//   evalEvidence 24h TTL 이 자연 만료하기 전에 미리 갱신한다(12h 주기, 여유 2배). 위
//   runChatAutoCasePermitEval 과 같은 실비용 작업이라 secrets/timeoutSeconds/memory 를 그대로
//   맞춘다. maxInstances:1·retryCount:0 은 이 스윕이 이미 만족한다(중복 arm 전투 방지).
// release-refresh-repin (2026-09-25, Codex gate round 1 HIGH): refreshArmedChatAutoCasePermits now
// posts to Slack on a failed re-eval (chatAutoCasePermitCallables.ts) — without SLACK_BOT_TOKEN
// bound, postScheduledReportToSlack silently returns {posted:false, reason:"bot_token_missing"}
// (never throws), so the alert this fix depends on would have vanished with zero signal.
export const refreshChatAutoCasePermitsSchedule = onSchedule(
  {
    schedule: "every 720 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 0,
    timeoutSeconds: 300,
    memory: "512MiB",
    secrets: ["AI_HUB_LLM_API_KEY", "JEV_API_KEY", "SLACK_BOT_TOKEN"],
  },
  async () => {
    await refreshArmedChatAutoCasePermitsHandler({
      buildSha: resolveChatAutoPermitReleaseIdentity().sourceCommit,
      resolveModelVersion: resolveChatAutoPermitCurrentModelVersion,
      runGatewayEval: runChatAutoPermitGatewayEvalScenario,
    });
  },
);
export const listChatAutoCaseDecisionLedger = callable(listChatAutoCaseDecisionLedgerHandler);
// Casebook snapshot (2026-09-28, "simplify in place" direction, owner-approved): the ONE read
// callable for /chat/auto's casebook console — replaces the old three-callable shape (see
// functions/chatAutoCasePermitCallables.ts's own doc comment for the full rationale). NAMED
// function expression (not an inline arrow) for the same reason getChatAutoCasePermitStatus above
// needs one: callable()'s audit logging (persistCallableOutcome/behaviorLog) keys off
// handler.name, which an anonymous arrow leaves empty. This callable is deliberately NOT added to
// viewAsWriteGuard.ts's VIEW_AS_READ_ALLOWLIST — it rejects any viewAsUserId/viewAsEmail payload
// outright (both via that guard's default-deny and its own explicit in-handler check).
// assertScpEntitled (functions/mailAccounts.ts) needs PEOPLY_API_KEY to resolve a non-super_admin
// caller's org.
export const getChatAutoCasebookSnapshot = callable(
  function getChatAutoCasebookSnapshot(request) {
    return getChatAutoCasebookSnapshotHandler(request, {
      resolveModelVersion: resolveChatAutoPermitCurrentModelVersion,
      resolveSourceCommit: resolveChatAutoPermitCurrentSourceCommit,
    });
  },
  ["PEOPLY_API_KEY"],
);
// Casebook inbox (2026-10-01): lists WHICH pending conversations the snapshot's unclassifiedPendingCount
// counts (never_classified / unknown_case / stale_stamp), via a bounded live scan. Same surface rules
// as getChatAutoCasebookSnapshot: NAMED function expression (callable()'s audit logging keys off
// handler.name), deliberately NOT in viewAsWriteGuard.ts's VIEW_AS_READ_ALLOWLIST (viewAs rejected),
// and PEOPLY_API_KEY for assertScpEntitled's org lookup.
export const listChatAutoCasebookUnclassified = callable(
  function listChatAutoCasebookUnclassified(request) {
    return listChatAutoCasebookUnclassifiedHandler(request);
  },
  ["PEOPLY_API_KEY"],
);
// Casebook inbox (2026-10-03): "실제 건 보기" — lists WHICH pending conversations sit behind one card's
// 대기 중 N건 (case id / unclassified / no_reply_needed). Same surface rules as the unclassified list
// above: NAMED function expression, NOT in VIEW_AS_READ_ALLOWLIST (viewAs rejected), PEOPLY_API_KEY.
export const listChatAutoCasebookCaseItems = callable(
  function listChatAutoCasebookCaseItems(request) {
    return listChatAutoCasebookCaseItemsHandler(request);
  },
  ["PEOPLY_API_KEY"],
);
// /chat/auto 검토 보드 (2026-10-05): read-only review board over the whole pending population
// (이번 발송 제외 / 운영자 판단 / 마지막 안전 확인 대기). Same surface rules as the case-items list:
// NAMED function expression, NOT in VIEW_AS_READ_ALLOWLIST (viewAs rejected), PEOPLY_API_KEY.
// persistOutcome=false: a read-only review surface must not write callableRuns/engineSnapshots
// rows; non-durable logs still apply.
export const listChatAutoReviewBoard = callable(
  function listChatAutoReviewBoard(request) {
    return listChatAutoReviewBoardHandler(request);
  },
  ["PEOPLY_API_KEY"],
  { persistOutcome: false },
);
export const saveChatAutoCaseReply = callable(
  function saveChatAutoCaseReply(request) {
    return saveChatAutoCaseReplyHandler(request);
  },
  ["PEOPLY_API_KEY", "SLACK_BOT_TOKEN"],
);
export const resetChatAutoCaseReply = callable(
  function resetChatAutoCaseReply(request) {
    return resetChatAutoCaseReplyHandler(request);
  },
  ["PEOPLY_API_KEY", "SLACK_BOT_TOKEN"],
);
export const suggestChatAutoCaseReply = callable(
  function suggestChatAutoCaseReply(request) {
    return suggestChatAutoCaseReplyHandler(request);
  },
  {
    secrets: ["AI_HUB_LLM_API_KEY", "PEOPLY_API_KEY"],
    maxInstances: 2,
    concurrency: 1,
    timeoutSeconds: 90,
    memory: "512MiB",
  },
);
// Read-only reply preview (casebook inbox, 2026-10-01): validates a draft exactly as save would and
// returns it after the dispatch resolver's {{TOKEN}} → anchor substitution. No model call, no write.
// NAMED function expression (callable()'s audit logging keys off handler.name). Not in
// viewAsWriteGuard's read allowlist — viewAs payloads are rejected outright, like its siblings.
// assertScpEntitled needs PEOPLY_API_KEY for a non-super_admin caller's org lookup.
export const previewChatAutoCaseReply = callable(
  function previewChatAutoCaseReply(request) {
    return previewChatAutoCaseReplyHandler(request);
  },
  ["PEOPLY_API_KEY"],
);
// Casebook snapshot 504 hotfix (2026-09-29; single-scan redesign same day, adversarial review round
// 1): getChatAutoCasebookSnapshot above used to run the unreplied-inbox pending scan INLINE (~900
// conversation reads + ~200 manual-reply checks + a Peoply org lookup) — slow enough in production
// to hit the 60s Cloud Run request timeout and 504 the whole /chat/auto console. This schedule moves
// that scan off the request path entirely — see functions/chatAutoCasebookPendingPrecompute.ts's own
// (long) doc comment for the full redesign rationale; summary:
//   - The scan itself (functions/read.ts scanUnrepliedInboxForScope, super_admin/unfiltered access)
//     runs per tick (up to CHAT_AUTO_CASEBOOK_PENDING_MAX_SCAN_ITERATIONS=3 chained calls — round 3
//     adversarial review, 2026-09-29: one call alone has its own internal GLOBAL candidate cap that
//     one busy org can fill, starving every other org's scan out of the tick entirely and producing a
//     false "0" for it — see functions/chatAutoCasebookPendingPrecompute.ts's scanOnce doc comment),
//     NOT once per scope — round 1 of this schedule ran the full ~10,900-read pipeline PER SCOPE
//     (super_admin + each configured org), ~33,000 reads/tick at a 5-minute cadence ≈ 9.6M reads/day
//     (codex adversarial review, 2026-09-29). Every scope's counts are DERIVED IN MEMORY from that
//     chained scan by re-applying canReadConversationRowForScope per scope — zero extra Firestore
//     reads per scope. New per-tick ceiling: ~32,700 reads (3 x ~10,900-read scan iterations) + a
//     handful of enumeration reads/Peoply lookups (see below), REGARDLESS of scope count. At every
//     15 minutes (96 ticks/day) that is ≈3.14M reads/day worst case — still well under round 1's
//     ~9.6M reads/day, and it no longer scales with the number of orgs.
//   - Scope coverage now also includes org ids resolved from members holding a DIRECT scp grant
//     (functions/mailAccounts.ts MAIL_ACCOUNT_ACCESS_FIELD — round 1 only covered settings/
//     mail_routing.scpAllowedOrgIds, so a directly-granted caller outside that list could resolve to
//     a scope with no precomputed doc, stuck at "missing"/"계산 중" forever), plus a shared
//     "no_resolved_org" bucket and a shared per-tick row-cache fallback the callable derives any
//     still-unenumerated scope from on demand (cheap: one doc read, no re-scan) before ever reporting
//     "missing" — see readCallerChatAutoCasebookPendingSnapshot.
// PEOPLY_API_KEY is bound because chatAutoCasebookPendingScopeTargets's direct-grant org enumeration
// resolves each such member's org via resolveConversationMailAccessScope (Peoply-backed) — the
// configured-org half (settings/mail_routing) still needs no secret on its own.
// NEW onSchedule (not piggybacked onto an existing one, same reasoning as scpSheetReviewSyncSchedule/
// runMailBackfillJobsSchedule below): this scan needs its own generous timeout/memory budget
// independent of any other worker's — see tests/w72-a-nudge-sweep.test.mjs and
// tests/w115-discovery-supply.test.mjs's onSchedule count pin (43 → 44).
export const chatAutoCasebookPendingPrecomputeSchedule = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    concurrency: 1,
    retryCount: 0,
    timeoutSeconds: 300,
    memory: "1GiB",
    secrets: ["PEOPLY_API_KEY"],
  },
  async () => {
    const result = await writeChatAutoCasebookPendingSnapshotsHandler();
    if (result.failed.length > 0) {
      console.error("[chatAutoCasebookPendingPrecomputeSchedule] one or more scopes failed to precompute", {
        failed: result.failed,
        succeeded: result.scopeKeys,
      });
    }
    // The full precompute pipeline has a wall-clock guard so a slow scan, lookup, or write returns
    // before this schedule's 300s hard timeout. Keep deadline exhaustion visible even when it occurs
    // before targets can be enumerated; callers still have the last-known snapshot/row-cache data.
    if (result.deadlineExceeded || result.skipped.length > 0) {
      console.error("[chatAutoCasebookPendingPrecomputeSchedule] this tick reached its deadline before all work completed", {
        deadlineExceeded: result.deadlineExceeded,
        skipped: result.skipped,
        succeeded: result.scopeKeys,
      });
    }
  },
);
// Default reply suggestions (casebook inbox, 2026-10-01): drafts ONE English reply per applicable
// casebook case into chat_auto_case_reply_default_suggestions so the console shows it instantly. Gated
// on VERTEX_TICO_APPROVED like suggestChatAutoCaseReply, cache-first, max 6 model calls/run, per-case
// transactional lease, exponential backoff on failure — see functions/chatAutoCaseSuggestionPrecompute.ts.
// NEW onSchedule (45 → 46 in tests/w72-a-nudge-sweep.test.mjs / tests/w115-discovery-supply.test.mjs's
// pin): needs its own generous timeout, independent of the pending-count precompute's. Only
// AI_HUB_LLM_API_KEY is bound (llm usage reporting); no Peoply/entitlement lookup happens here.
export const chatAutoCaseSuggestionPrecomputeSchedule = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    concurrency: 1,
    retryCount: 0,
    timeoutSeconds: 300,
    memory: "512MiB",
    secrets: ["AI_HUB_LLM_API_KEY"],
  },
  async () => {
    const result = await runChatAutoCaseSuggestionPrecomputeHandler();
    if (result.failed.length > 0 || result.deadlineExceeded) {
      console.error("[chatAutoCaseSuggestionPrecomputeSchedule] some default suggestions were not produced this tick", {
        failed: result.failed,
        deadlineExceeded: result.deadlineExceeded,
        generated: result.generated,
        cacheHits: result.cacheHits,
      });
    }
  },
);
// Task C (auto-reply-risk-taxonomy 2026-09-17): re-runs the live gateway per candidate
// (bypassGatewayCache:true) — same cost/runtime shape as runChatAutoCasePermitEval above, so it
// gets the same generous timeout/concurrency=1 and AI_HUB_LLM_API_KEY binding.
export const requeueAutoReplyBacklog = callable(
  requeueAutoReplyBacklogHandler,
  {
    secrets: ["AI_HUB_LLM_API_KEY", "JEV_API_KEY"],
    maxInstances: 1,
    concurrency: 1,
    timeoutSeconds: 540,
    memory: "512MiB",
  },
);
// case-backlog-send (2026-09-27): bounded Firestore read, no live model call. round-2 hardening
// (2026-09-28): now scp-entitlement-gated (isCallerScpEntitled, viewAs-aware) — PEOPLY_API_KEY is
// bound so a deployed instance can resolve a non-super_admin caller's org instead of always denying
// for a missing secret (same reasoning as every other assertScpEntitled-gated export below).
export const getChatAutoCaseHeldBacklogCount = callable(getChatAutoCaseHeldBacklogCountHandler, ["PEOPLY_API_KEY"]);
// case-backlog-send (2026-09-27): internally runs requeueAutoReplyBacklogHandler's own pipeline
// (dry-run then real, both caseIdFilter-scoped) IN PROCESS, so this callable's own deployment needs
// the exact same secrets/concurrency/timeout shape requeueAutoReplyBacklog above declares — it is
// the same live-gateway cost/risk surface, just narrowed to one case and reachable by manager+
// instead of super_admin-only (see MUTATION_ROLES reuse in chatAutoCaseBacklogSend.ts). round-2
// hardening (2026-09-28): also scp-entitlement-gated (assertScpEntitled) — PEOPLY_API_KEY added.
export const sendChatAutoCaseHeldBacklogNow = callable(
  (request) =>
    sendChatAutoCaseHeldBacklogNowHandler(request, {
      resolveModelVersion: resolveChatAutoPermitCurrentModelVersion,
      resolveSourceCommit: resolveChatAutoPermitCurrentSourceCommit,
    }),
  {
    secrets: ["AI_HUB_LLM_API_KEY", "JEV_API_KEY", "PEOPLY_API_KEY"],
    maxInstances: 1,
    concurrency: 1,
    timeoutSeconds: 540,
    memory: "512MiB",
  },
);
// email-digging (2026-10-02): super_admin, dryRun-by-default backfill of missing creator emails on
// campaign_candidates (description re-parse + same-channel reuse + allowlisted link-in-bio pages —
// robots/SSRF-guarded public fetch, no paid API, no YouTube units, never sends mail). The handler is
// passed by its declared name so callable()'s handler.name (viewAs guard + audit log) is
// "emailDiggingBackfill". Single instance: the run also takes a Firestore lease.
export const emailDiggingBackfill = callable(
  emailDiggingBackfillHandler,
  {
    maxInstances: 1,
    concurrency: 1,
    timeoutSeconds: 300,
    memory: "512MiB",
  },
);
// email-digging upload sampling (2026-10-03): official YouTube Data API only (channels.list →
// uploads playlistItems → videos.list descriptions) through the SAME discovery-lane key pool/accounting
// (fetchYouTubeRecord) plus a lane-only daily unit cap (settings.automation.emailUploadSampling.dailyUnitCap,
// default 5000, 0 = off). super_admin, dryRun by default (dry runs still spend units), never sends mail.
export const emailUploadSamplingBackfill = callable(
  emailUploadSamplingBackfillHandler,
  {
    secrets: YOUTUBE_API_SECRETS,
    maxInstances: 1,
    concurrency: 1,
    timeoutSeconds: 300,
    memory: "512MiB",
  },
);
// email-digging upload sampling schedule (2026-10-03): hourly, OFF by default — it only runs when
// settings.automation.emailUploadSampling = { enabled: true, programId, dailyUnitCap }. Same core as the
// callable, system actor, apply mode, single-flight lease + shared daily unit ledger. Production only (the
// staging facade never exports schedule workers). NEW onSchedule (47 -> 48 in tests/w72-a-nudge-sweep.test.mjs /
// tests/w115-discovery-supply.test.mjs's pin).
export const emailUploadSamplingSchedule = onSchedule(
  {
    schedule: "every 60 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    concurrency: 1,
    retryCount: 0,
    timeoutSeconds: 300,
    memory: "512MiB",
    secrets: YOUTUBE_API_SECRETS,
  },
  async () => {
    const result = await runEmailUploadSamplingScheduled();
    if (result.status === "failed") {
      console.error("[emailUploadSamplingSchedule] run failed; cursor kept for the next tick", { errorCode: result.errorCode });
    }
  },
);
// casebook-reclassify (2026-10-01): classification ONLY — never drafts, sends, requeues, changes
// autoReplyStatus or touches permits (writes: conversation stamp fields + chat_auto_case_reclassify_runs
// audit doc). super_admin only, viewAs rejected. Calls the live model (cache-first, ≤25 per call), so
// it binds the same AI Hub secret + serialized single-instance shape as the sibling live-model
// callables above; no JEV (classification only) and no Peoply lookup (super_admin scope is built
// directly). The handler is passed by its own declared name so callable()'s handler.name — used by the
// viewAs guard and audit log — is "reclassifyChatAutoCasebookUnclassified".
export const reclassifyChatAutoCasebookUnclassified = callable(
  reclassifyChatAutoCasebookUnclassifiedHandler,
  {
    secrets: ["AI_HUB_LLM_API_KEY"],
    maxInstances: 1,
    concurrency: 1,
    timeoutSeconds: 300,
    memory: "512MiB",
  },
);
// classification_v1 (2026-10-03): operator label apply — dryRun by default, up to 100 items, each re-validated
// against the conversation's CURRENT latest inbound messageRef (stale → skipped). Writes only classification
// stamps / the explicit no-reply disposition / chat_auto_case_gold_labels / one audit doc per run; no model
// call (so no AI Hub secret), no mail send or enqueue, no permit/suppression/gate access. super_admin only,
// viewAs rejected. The handler is passed by its own declared name so callable()'s handler.name (viewAs guard
// + audit log) is "applyChatAutoCaseOperatorLabels".
export const applyChatAutoCaseOperatorLabels = callable(
  applyChatAutoCaseOperatorLabelsHandler,
  {
    maxInstances: 1,
    concurrency: 1,
    timeoutSeconds: 300,
    memory: "512MiB",
  },
);
// casebook 0.6.105 (2026-10-01): automatic reclassify sweep — the system-actor schedule over the SAME
// core as reclassifyChatAutoCasebookUnclassified above (classification only: stamp/marker + audit in
// chat_auto_case_reclassify_runs with actor "system:schedule" + one cursor/lease doc). dryRun false,
// limit 10, only rows whose lastInboundAtIso is ≥15 min old, single-flight lease, kill switch
// settings/default automation.casebookReclassifySweep.enabled (absent = on). Production only: the
// staging facade never exports schedule workers (functions-staging/runtime/index.cjs).
// NEW onSchedule (46 → 47 in tests/w72-a-nudge-sweep.test.mjs / tests/w115-discovery-supply.test.mjs's
// pin): its own timeout budget, independent of the precompute schedules. Same AI Hub secret binding as
// the callable (usage reporting); no JEV, no Peoply.
export const chatAutoCaseReclassifySweepSchedule = onSchedule(
  {
    schedule: "every 30 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    concurrency: 1,
    retryCount: 0,
    timeoutSeconds: 300,
    memory: "512MiB",
    secrets: ["AI_HUB_LLM_API_KEY"],
  },
  async () => {
    const result = await runChatAutoCaseReclassifySweep();
    if (result.status === "failed") {
      console.error("[chatAutoCaseReclassifySweepSchedule] sweep failed; cursor kept for the next tick", { errorCode: result.errorCode });
    } else if (result.status === "completed" && result.counts.failed > 0) {
      console.error("[chatAutoCaseReclassifySweepSchedule] some classifications failed this tick", {
        runId: result.runId,
        failed: result.counts.failed,
        stoppedReason: result.stoppedReason,
      });
    }
  },
);
export const receiveEmail = callable(receiveEmailHandler, ["IMAP_PASSWORD", "AI_HUB_LLM_API_KEY", "JEV_API_KEY"]);
export const sendEmail = callable(sendEmailHandler, ["SMTP_PASSWORD", "AI_HUB_LLM_API_KEY", "PEOPLY_API_KEY"]);
// 열람(오픈) 트래킹 픽셀 — 메일 클라이언트가 이미지를 로드할 때 호출되므로 공개 엔드포인트여야 한다.
// tid(trackingId) 외 어떤 원문 데이터도 받지 않는다 (SEC-P0-009).
export const mailOpenPixel = onRequest(
  { invoker: "public", maxInstances: 3 },
  mailOpenPixelHandler,
);
// Flu conversation org-filter round 3 (codex adversarial review round 3, finding #3): both
// resolvers now call resolveConversationMailAccessScope for every non-super_admin caller, which
// needs a live Peoply lookup to resolve the caller's org/entitlement — without this secret bound,
// that resolution fails closed (directory_unavailable) for every real user.
export const listMailOutbox = callable(listMailOutboxHandler, ["PEOPLY_API_KEY"]);
export const reconcileMailOutboxReplies = callable(reconcileMailOutboxRepliesHandler, ["PEOPLY_API_KEY"]);
export const importManualSentMailToOutbox = callable(
  importManualSentMailToOutboxHandler,
  ["IMAP_PASSWORD"],
);
export const attributeImportedSentOnlyHistory = callable(
  attributeImportedSentOnlyHistoryHandler,
  { maxInstances: 1, concurrency: 1, timeoutSeconds: 120 },
);
// W117 본문 백필 — 이미 편입된 발송분의 **본문 평문**을 IMAP 에서 되찾아 원장에 채운다.
// 전방 편입은 이제 본문을 저장하지만(헤세 결정 2026-08-23), 그 이전에 들어온 행은 해시만 갖는다.
// Message-ID 해시 등가 일치 + bodyHash 일치 2중 잠금으로만 채운다(근사 매칭 없음 — 오귀속 방지).
// IMAP 왕복이라 회당 상한이 보수적이다(기본 25, 최대 50) — dryRun→actual, 커서로 반복 호출한다.
// W117-R2 `{ mode: "reclassify" }` — 드레인 임포터가 툴 원장 행의 source 를 편입값으로 덮은 오염을
// 되돌린다(판별: external 인데 `message_sources/external-sent-{tid}` 부재, 복원값: 발송 시점의
// `deliverySource`). IMAP 에 붙기 전에 갈라지므로 메일함 접속이 없다. 물질화 메시지는 기존
// `tool_duplicate` 숨김 축으로 같이 정리되고 `{ mode: "unhide" }` 로 가역이다.
export const hydrateExternalSentBodies = callable(
  hydrateExternalSentBodiesHandler,
  {
    secrets: ["IMAP_PASSWORD"],
    maxInstances: 1,
    concurrency: 1,
    timeoutSeconds: 300,
  },
);
// 보낸편지함 편입분 대화 물질화 — 편입된 발송을 대화에 붙이는 **백필** 문. 스케줄 편승은 방금 편입분만
// 처리하므로 밀린 과거분은 이 콜러블을 dryRun→actual, 커서로 반복 호출해 비운다.
// `{ mode: "relabel" }` 은 이미 물질화된 메시지의 라벨만 새 규칙으로 정정한다(W116 — 대화를 새로 찾지 않는다).
export const stitchExternalSentConversations = callable(
  stitchExternalSentConversationsHandler,
  { maxInstances: 1, concurrency: 1, timeoutSeconds: 300 },
);
// W119 편입 발신 한국어 AI 요약 — 본문이 있는 편입 소스 문서에 게이트웨이 경유 한 줄 요약을 붙이고
// (message_sources.summaryKr + mail_outbound_log.summaryKr 미러), 스티치 relabel 로 대화 문구까지
// 갱신하는 **백필** 문이다. 스케줄 편승은 방금 편입분만 처리하므로 밀린 과거분은 이 콜러블을
// dryRun→actual, 커서로 반복 호출해 비운다.
//   ⚠️ 커서가 훑는 모수는 "본문 있는 외부 발신 ~1,927건"이 **아니다**. 스캔 축은
//   `mail_outbound_log where source == external_sent_mail_import` 전량(프로드 ~10.4k행)이고,
//   본문 없는 행은 훑은 뒤 `skippedNoBody` 로 떨어진다. 즉 limit 50 기준 **~209회** 호출이
//   필요하고, 그중 실제 모델 호출은 본문 보유분에서만 일어난다(요약 대상 자체는 ~1.9k).
//   모델 호출이 있어 회당 상한이 보수적이다(기본 25, 최대 50).
//   dryRun 회차는 계획만 세우고 모델을 부르지 않는다. `{ force: true }` 는 캐시를 무시한 재요약이다.
export const summarizeExternalSentMessages = callable(
  summarizeExternalSentMessagesHandler,
  {
    secrets: ["AI_HUB_LLM_API_KEY"],
    maxInstances: 1,
    concurrency: 1,
    timeoutSeconds: 300,
  },
);
export const getMailSignatureSettings = callable(
  getMailSignatureSettingsHandler,
);
export const updateMailSignatureSettings = callable(
  updateMailSignatureSettingsHandler,
);
// 2026-09-27 codex adversarial review round 2: both now resolve the caller's org via Peoply
// (functions/conversationMailAccessScope.ts) to enforce the scp per-org gate before mutating a
// conversation — see PEOPLY_API_SECRETS's doc comment above.
export const markConversationRead = callable(markConversationReadHandler, PEOPLY_API_SECRETS);
export const setConversationAutoReply = callable(setConversationAutoReplyHandler, PEOPLY_API_SECRETS);
// release-refresh-repin (2026-09-25): AI_HUB_LLM_API_KEY/JEV_API_KEY + a longer timeout added
// alongside SMTP_PASSWORD — processAutoReplyQueue's own
// triggerChatAutoCasePermitRefreshOnReleaseChangeOnce (chat-ai.ts) now runs the same
// gateway-eval refresh refreshChatAutoCasePermitsSchedule above uses, but only once per distinct
// deployed release (not every 5-minute pass), the first time a sweep tries to actually dispatch
// after a deploy. SLACK_BOT_TOKEN is needed for the same reason as refreshChatAutoCasePermitsSchedule
// above (Codex gate round 1 HIGH) — this trigger can reach the same failed-refresh Slack post.
// timeoutSeconds matches processCampaignOutreachQueue's own reasoning (W18 F-3) for a
// 5-minute-scheduled function that occasionally does heavier work than its steady-state pass.
// concurrency:1 (Codex gate round 1 HIGH): gen2's default concurrency (80) would otherwise let a
// slow (refresh-triggering) invocation overlap a second 5-minute-later invocation on the same warm
// instance — this repo already applies the identical fix for processCampaignOutreachQueue below
// (W57-C1) for the same class of risk (shared module-scope state across overlapping passes).
export const processAutoReplyQueue = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    concurrency: 1,
    retryCount: 0,
    timeoutSeconds: 480,
    secrets: ["SMTP_PASSWORD", "AI_HUB_LLM_API_KEY", "JEV_API_KEY", "SLACK_BOT_TOKEN"],
  },
  async () => {
    // 2026-10-02: 무장 해제 Slack 알림 중 전달 실패/유실분을 5분 주기로 재시도(던지지 않음).
    await retryPendingChatAutoPermitDisarmAlerts();
    const result = await processAutoReplyQueueHandler();
    // [적대 리뷰 MED-3] 만료/일시정지/실패는 auto_reply_queue 컬렉션을 직접 뒤지지 않으면
    // 보이지 않았다 — [campaign-auto-approval] sweep 로그와 같은 스타일로 눈에 띄게 남긴다.
    if (
      (result.expired ?? 0) > 0 ||
      result.failed > 0 ||
      result.pausedByGlobalSwitch ||
      (result.pausedMidSweep ?? 0) > 0 ||
      (result.releaseIdentityPending ?? 0) > 0 ||
      result.sent > 0
    ) {
      console.log("[auto-reply-queue] sweep", JSON.stringify(result));
    }
  },
);

// 콜드/대량 아웃리치 드레인 워커(G1). maxInstances:1 로 동시 sweep을 막아 중복 발송을 방지하고,
// 일일 캡(maxDailyOutreachSends)·creator당 1 touch·sendAfterIso 지연을 서버측에서 집행한다.
// W57-C1 [독립 리뷰 2026-08-08]: 아래 `concurrency: 1` 은 장식이 아니다. maxInstances 는 **인스턴스
// 수**만 묶고 gen2 기본 concurrency 는 80 이라, 스케줄 300s < 타임아웃 480s 인 이 워커는 같은 인스턴스에서
// pass 가 겹친다. 그러면 W57 의 모듈 스코프 상태(증거 캐시 currentTouchEvidenceCache · 리필 마감
// currentRefillDeadlineMs)가 호출 간 오염되고, 겹친 pass A 가 B 의 캐시로 판정하면 B 가 커밋한 수신자를
// 미접촉으로 오판해 **같은 크리에이터에게 콜드메일 2통**이 나간다(processDiscoveryQueue 와 같은 형태).
// ⚠️ 이 주석은 선언 **위**에 둔다 — 옵션 블록 안에 넣으면 발송-우선 게이트의 3,000자 창을 밀어낸다.
export const processCampaignOutreachQueue = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    concurrency: 1,
    retryCount: 0,
    // W18 F-3 [프로드 실측 2026-08-03]: 종전 540s 는 Cloud Scheduler attemptDeadline(540s)과 **같은
    // 값**이라, 함수가 deadline 을 넘길 때마다 스케줄러에 DEADLINE_EXCEEDED(4)가 남고 그게 반복되면
    // **잡 자체가 손상**된다 — pause/resume 으로도 안 풀리고 schedule 필드 변경 또는 재배포로만
    // 복구됐다(당일 4회 실측). 함수가 스케줄러보다 먼저 스스로 끝나야 code=4 가 안 남는다.
    timeoutSeconds: 480,
    // W17 F-2 [프로드 실측 2026-08-03]: 512MiB 로는 매 실행 OOM 이었다
    // ('Memory limit of 512 MiB exceeded' — 08:33/08:52/08:59/11:55/12:14Z 반복).
    // W14 시딩으로 스캔 모수가 3배(풀 2,374→7,050 · 프로그램 타깃 164→4,275)가 된 뒤 발현했고,
    // `automation.campaignTargetScanFloor` 를 5,000→500 으로 낮춰도 재발했다 = 스캔 폭 축소만으로는
    // 부족. OOM 은 컨테이너를 죽이는 데 그치지 않고 Cloud Scheduler 에 INTERNAL(13)/DEADLINE(4) 을
    // 남겨 **잡 자체를 웨지**시킨다(당일 3회 pause/resume 필요) → 발송 전면 정지.
    // W20 [프로드 실측 2026-08-04]: 1GiB 로도 **V8 힙**이 터졌다 — 컨테이너 메모리와 Node 힙 상한은
    // 별개다. 실측 크래시 스택이 그 증거다:
    //   node::OOMErrorHandler → v8::Utils::ReportOOMFailure
    //   → v8::internal::V8::FatalProcessOutOfMemory → Uncaught signal: 6 (SIGABRT)
    // Cloud Run 의 'Memory limit exceeded' 로그는 **없었다**(컨테이너는 여유였다). 즉 W17 F-2 의
    // 1GiB 증설은 절반만 유효했고, 스캔 폭을 올리자(scanFloor 500→2,000) 바로 힙이 터져 스케줄러가
    // code=4 로 다시 손상됐다. 2GiB 로 올리면 런타임이 잡는 V8 기본 힙도 함께 커진다.
    // (즉시 완화는 데이터로 했다: automation.campaignTargetScanFloor 2,000 → 400.)
    memory: "2GiB",
    secrets: [
      "SMTP_PASSWORD",
      ...YOUTUBE_API_SECRETS,
      "SCP_OUTREACH_HMAC_KEY_ID",
      "SCP_OUTREACH_HMAC_SECRET",
      "SCP_PORTAL_APPLY_ORIGIN",
      // W51: 이 바인딩이 없으면 도달성 게이트가 apiKey 부재로 매번 fail-open 해서 배선이 무의미해진다.
      "BOUNCER_API_KEY",
    ],
  },
  async () => {
    // W18 F-1 [프로드 실측 2026-08-03]: 발송을 스윕보다 **먼저** 실행한다. 종전 순서(스윕→발송)에서는
    // 스윕(리필+자동승인)이 attemptDeadline 540s 를 통째로 소진해 발송부가 **한 번도 실행되지 못했다**
    // (status.code=4 반복 · queued 350→444/approved 50→75 로 스윕은 진행되는데 sent 는 1 고정,
    // 발송부 쿼리 재현은 정상). 발송은 자체 시간 예산(CAMPAIGN_OUTREACH_WORKER_TIME_BUDGET_MS)과
    // 워커 락으로 스스로 유계이고, 스윕은 실패·중단돼도 다음 회차가 멱등 재개한다 — 굶으면 안 되는
    // 쪽이 발송이다. 승인된 행은 이미 모든 안전 게이트를 통과한 상태라, 발송이 굶으면 영구 정체한다.
    const passStartedAtMs = Date.now();
    await processCampaignOutreachQueueHandler();
    // TASK 3 automatic mode: approve queued waves of autoApproveLiveSend campaigns (no manual
    // per-batch gate). Sweep failures never block the send worker.
    // W18 F-2: 스윕에 시간 예산을 준다 — 발송이 먼저 실행돼도 스윕이 남은 deadline 을 다 쓰면
    // 다음 회차 발화가 지연되고(code=4) 잡 손상이 재발한다(F-3 주석 참조).
    try {
      // W43 F-1: literal 180_000 은 W24 게이트가 읽어 240s+180s=420s < 480s−마진 60s 를 검사하는
      // 값이라 형태를 바꾸지 않는다. sweepDeadlineMs 가 그 계약을 **런타임에도** 지킨다 — 발송이
      // 240s 를 넘겼으면 스윕이 그만큼 줄어 총합 420s 를 넘지 않는다(발송이 먼저 예산을 확보).
      const sweep = await runCampaignOutreachAutoApprovalSweepHandler({
        timeBudgetMs: 180_000,
        sweepDeadlineMs: passStartedAtMs + 420_000,
      });
      if (sweep.results.length > 0 || sweep.timeBudgetReached || sweep.refillReadBudgetReached) {
        console.log("[campaign-auto-approval] sweep", JSON.stringify(sweep));
      }
    } catch (error) {
      console.error("[campaign-auto-approval] sweep failed", error);
    }
  },
);

export const monitorOutboundOutputHeartbeatSchedule = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 0,
    timeoutSeconds: 60,
    // 프로드 실측(2026-08-04 37차 1차 시도): 128MiB 는 컨테이너가 뜨지 못한다 —
    // `Memory limit of 128 MiB exceeded with 129 MiB used` + STARTUP TCP probe 실패로
    // 함수 생성 자체가 실패했다(269개 중 이 하나만 드롭). 번들 로드가 128MiB 를 1MiB 넘긴다.
    // 격리의 목적은 감시 대상(발송 워커)과 **다른 컨테이너**에 두는 것이지 작게 두는 것이 아니다.
    // 256MiB 는 이 저장소 스케줄 함수의 사실상 최소값이다(256MiB 22개 · 512MiB 15개).
    memory: "256MiB",
  },
  async () => {
    await monitorOutboundOutputHeartbeatHandler();
    // P1-1 [적대 리뷰]: adverse-disarm append 실패는 mailOutboundSafety.recordChatAutoPermitAdverseRetryAlert가
    // scp_canary_alerts에 재시도 흔적을 남긴다 — 새 onSchedule을 추가하지 않고 이 기존 5분 하트비트에
    // 드레인 단계를 얹는다. 실패해도 하트비트 판정 자체에는 영향을 주지 않는다(fire-and-forget).
    try {
      const drainResult = await drainChatAutoPermitAdverseRetryAlerts();
      if (drainResult.slackNotices.length > 0) {
        await postScheduledReportToSlack(
          [
            "⚠️ *Permit adverse-disarm 재시도 실패*",
            `${drainResult.slackNotices.length}건이 반복 재시도에도 원장 기록에 실패했습니다 — `
              + "scp_canary_alerts(kind:permit_adverse_retry)에서 상세를 확인하고 수동 조치하세요.",
          ].join("\n"),
        );
      }
    } catch (error) {
      console.error("[chat-auto-permit-adverse] retry drain schedule step failed", error);
    }
  },
);

// R5-D (RA-5) — weekly runtime-configured canary self-send pipeline health monitor.
// 트렌드 리포트 발행 스케줄(0 9 * * 1, buildWeeklyTrendReportSnapshot 아래 참고)과 동일한 주간
// KST cron 패턴 재사용. scpCanarySelfSendScheduledHandler는 내부적으로 절대 throw하지 않는다
// (실패/스킵은 scp_canary_alerts 문서 + 콘솔 경고로만 남는다) — retryCount:0으로 충분.
export const scpCanarySelfSendSchedule = onSchedule(
  {
    // W90 [헤세 지시]: 주 1회 → **월/목 주 2회**. 발송량 램프 구간에서는 평판이 며칠 단위로
    //   움직이는데 주 1회면 악화를 최대 7일 뒤에 안다. 안정화 후 주 1회 복귀는 나중 결정.
    schedule: "0 9 * * 1,4",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 0,
    timeoutSeconds: 120,
    memory: "256MiB",
    secrets: ["SMTP_PASSWORD"],
  },
  async () => {
    const result = await scpCanarySelfSendScheduledHandler();
    console.log("[scp-canary] schedule run", JSON.stringify(result));
  },
);

// W111-A: 발송분 수집 주기(분). 호스트 스윕은 1분마다 돌지만 이 단계는 10분에 한 번만 탄다
// — 헤세 결정(1분은 비용부담)을 지키기 위한 스로틀이다.
const SENT_IMPORT_INTERVAL_MINUTES = 10;

export const processImapIngestQueue = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 0,
    timeoutSeconds: 300,
    memory: "512MiB",
    // PLAN-ORG-MAIL-IDENTITY Slice 4: the per-account loop below now also polls active
    // workspace_oauth accounts (functions/mailImapIngest.ts -> readImapLatestLiveForAccount ->
    // getMailOAuthAccessToken), which needs the same 3 secrets functions/mailOAuth.ts's own
    // refresh path binds — added here, not only on the new backfill schedule below.
    // Flu/Task-49: drama pool's OAuth client id/secret — getMailOAuthAccessToken (functions/
    // mailOAuth.ts) now resolves the client per the credential's stored poolId, so a drama
    // workspace_oauth account polled here needs its own pair bound alongside growth's.
    secrets: [
      "IMAP_PASSWORD",
      "AI_HUB_LLM_API_KEY",
      "JEV_API_KEY",
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "YOUTUBE_OAUTH_CREDENTIAL_ENCRYPTION_KEY",
      "YOUTUBE_POOL_DRAMA_1_OAUTH_CLIENT_ID",
      "YOUTUBE_POOL_DRAMA_1_OAUTH_CLIENT_SECRET",
    ],
  },
  async () => {
    const result = await processImapIngestQueueHandler();
    const summary = {
      ok: result.ok,
      runId: result.runId,
      fetched: result.fetched,
      matched: result.matched,
      bounced: result.bounced,
      ignored: result.ignored,
      quarantined: result.quarantined,
      errors: result.errors,
    };
    // W111-A (헤세): 발송분(scp@supercent.io 의 Sent) 수집을 **이 함수의 한 단계**로 붙인다.
    //   신규 onSchedule 을 만들지 않는 게 이 저장소 규약이다(tests/w72-a-nudge-sweep.test.mjs:
    //   "스윕은 함수가 아니라 기존 함수의 단계여야 한다"). 같은 IMAP 시크릿을 이미 쓰는 이 자리가
    //   자연스럽고, 추가 호출 비용도 0 이다.
    //   INBOX 수집 결과와 **독립**으로 처리한다 — 발송분 수집이 실패해도 받은 메일 수집은 이미
    //   끝났으므로 그 결과를 뒤집지 않는다. 대신 실패는 아래에서 명시적으로 표면화한다.
    //   ⚠️ 이 호스트는 **1분 주기**다. 발송분 수집까지 매분 돌리면 Sent 메일함 IMAP 폴링이
    //   하루 144회 → 1,440회로 10배가 된다. 헤세가 "1분은 비용부담"이라고 명시적으로 판단해
    //   10분 주기로 정한 사항이므로, 여기서 틱을 솎아 그 결정을 지킨다(리뷰 재검 MEDIUM).
    //   분(minute) 나머지로만 판정한다 — 상태를 두지 않아 콜드스타트·재배포에 영향받지 않고,
    //   틱을 한 번 놓쳐도 다음 10분 경계에서 자연히 복구된다.
    const sentImportTick = new Date().getMinutes() % SENT_IMPORT_INTERVAL_MINUTES === 0;
    let sentImport: Awaited<ReturnType<typeof importSentMailToOutboxScheduledHandler>> | undefined;
    let sentImportError: unknown;
    // Personal Sent ingest (hesse@supercent.io 등): 링크된 개인 계정의 보낸편지함도 같은 틱에서
    // 수집한다 — 지금까지 canonical(scp) Sent 만 읽어서 개인 계정 발송분은 원장에 아예 없었고,
    // 그래서 "내가 보낸 메일에 답장 안 온 사람" 질의가 개인 발송을 영영 못 봤다.
    //   · 같은 10분 스로틀 안에서 돈다(계정 수만큼 틱이 늘지 않는다 — 헤세의 비용 결정 불변).
    //   · 계정당 실패는 그 계정 outcome 으로만 남는다 — 한 계정의 OAuth 철회/시크릿 결손이
    //     나머지 계정이나 canonical 수집을 막지 못한다(mailImapIngest 의 계정 루프와 같은 격리).
    //   · 편입된 trackingId 는 아래 요약·스티치 편승에 합류한다 — 개인 발송분도 같은 회차에
    //     대화로 물질화된다.
    let personalSentImport: Awaited<ReturnType<typeof importSentMailForActivePersonalAccountsHandler>> | undefined;
    if (sentImportTick) {
      try {
        // 96차 핫픽스: 8/12~8/19 mail-safety 미승인으로 임포트가 정지해 백로그 ~10일이 쌓였다.
        // 핸들러 자체 클램프(≤50) 안에서 배치만 2배로 — 10분 주기(헤세의 비용 결정)는 불변.
        // 백로그 해소 후 25로 되돌려도 되고, 유지해도 비용 차이는 IMAP fetch 25통/틱뿐이다.
        sentImport = await importSentMailToOutboxScheduledHandler({ limit: 50 });
      } catch (error) {
        sentImportError = error;
      }
      try {
        personalSentImport = await importSentMailForActivePersonalAccountsHandler({ limit: 50 });
      } catch (error) {
        // 계정 인벤토리 자체를 못 읽은 경우다(계정별 실패는 헬퍼 안에서 이미 격리된다).
        // 발송분 수집 실패 표면화 계약과 같은 이유로 로그만 남긴다 — INBOX 수집 결과를 뒤집지 않는다.
        // 로그는 분류된 증거만 남긴다 — 원문 에러 텍스트는 프로바이더 응답·사서함 경로 같은
        // 잔재를 실을 수 있어 담지 않는다(계정별 실패 경로의 safeOutboundFailureEvidence 와 같은 규약).
        const evidence = safeOutboundFailureEvidence(error, "personal-sent-import:inventory");
        console.error("[sent-import] personal accounts inventory failed", JSON.stringify({
          errorCode: evidence.errorCode,
          failureKind: evidence.failureKind,
          failureRuleId: evidence.failureRuleId,
          correlationIdHash: evidence.correlationIdHash,
        }));
      }
    }
    const sentSummary = !sentImportTick
      ? { skipped: "not_sent_import_tick" }
      : sentImport
      ? {
        skippedReason: sentImport.skippedReason,
        candidateCount: sentImport.candidateCount,
        importedOutbox: sentImport.importedOutbox,
        importedMessageSources: sentImport.importedMessageSources,
        skippedUnapprovedFrom: sentImport.skippedUnapprovedFrom,
        skippedNoRecipient: sentImport.skippedNoRecipient,
        skippedUnparseable: sentImport.skippedUnparseable,
        cursorAdvanced: sentImport.cursorAdvanced,
      }
      : { failed: true };
    console.log("[sent-import] schedule step", JSON.stringify({
      ...sentSummary,
      ...(personalSentImport
        ? {
          personalAccounts: personalSentImport.outcomes.map((outcome) => ({
            mailAccountId: outcome.mailAccountId,
            ok: outcome.ok,
            importedOutbox: outcome.importedOutbox,
            importedMessageSources: outcome.importedMessageSources,
            ...(outcome.skippedReason ? { skippedReason: outcome.skippedReason } : {}),
            ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
          })),
        }
        : {}),
    }));

    // [가져온 발송 대화 물질화 · 헤세 프로드 실측]: 편입된 발송분을 **대화에 물질화**하는 단계를
    //   바로 뒤에 얹는다.
    //   신규 onSchedule 은 만들지 않는다(onSchedule 총수 40 핀 — tests/w72-a-nudge-sweep.test.mjs,
    //   tests/w115-discovery-supply.test.mjs). W114-F 의 코호트1·3 드레인 편승과 같은 결이다.
    //   방금 편입한 trackingId 들만 넘겨 읽기량을 배치 크기로 묶는다(전량 백필은 콜러블 몫).
    //   물질화 실패는 임포트 결과를 뒤집지 않는다 — 원장 편입은 이미 끝났고, 다음 회차나 백필
    //   콜러블이 같은 행을 멱등하게 다시 시도한다(레인 격리 원칙).
    //   시간 예산을 넘겨 임포트가 쓴 커서를 이 단계가 밀어내지 못하게 한다 — 예산이 끊기면 남은
    //   분량은 `deferred` 로 세는데, **다음 틱은 임포터 커서가 전진해 다른 배치를 받으므로**
    //   deferred 행의 회수는 백필 콜러블 몫이다(리뷰 재검증 M-2). 그래서 아래에서 warn 을 남긴다.
    //   성공 로그는 코어가 한 줄로 남긴다(중복 집계 방지). 여기서는 실패만 따로 남긴다.
    // [W119 편입 발신 한국어 요약]: 물질화 **앞**에 붙인다. 요약을 먼저 원장에 미러해 두면 아래
    //   스티치가 처음부터 요약 문구로 메시지를 만든다 — 물질화 뒤에 요약했다면 같은 문서를 다시
    //   쓰는 relabel 왕복이 매 회차 필요하다(형제 본문 백필이 겪는 그 비용이다).
    //   신규 onSchedule 은 만들지 않는다(onSchedule 총수 핀 — tests/w72-a-nudge-sweep.test.mjs).
    //   요약 실패는 편입도 물질화도 뒤집지 않는다 — 요약이 없으면 화면은 종전대로 원문 프리뷰로
    //   폴백하고(stitchMessageText), 밀린 분량은 백필 콜러블(summarizeExternalSentMessages)이 회수한다.
    const summaryTrackingIds = [
      ...(sentImport?.importedTrackingIds ?? []),
      ...(personalSentImport?.importedTrackingIds ?? []),
    ];
    if (summaryTrackingIds.length > 0) {
      try {
        const summarized = await summarizeExternalSentMessagesCore({
          trackingIds: summaryTrackingIds,
          dryRun: false,
          // 이 행들은 **아직 물질화되지 않았다**(바로 아래 스티치가 처음 만든다). relabel 을 켜면
          // 존재하지 않는 메시지를 상대로 원장·메시지를 한 번씩 더 읽고 전량 not_stitched 로 끝난다.
          relabel: false,
          deadlineMs: Date.now() + EXTERNAL_SENT_SUMMARY_PIGGYBACK_BUDGET_MS,
        });
        if (summarized.deferred > 0 || summarized.failedSummaries > 0 || summarized.skippedReason) {
          // 편승엔 커서가 없어 이 행들은 이 레인이 다시 못 집는다 — 백필 콜러블로 회수하라는 신호.
          console.warn("[external-sent-summary] rows need backfill", JSON.stringify({
            deferred: summarized.deferred,
            failedSummaries: summarized.failedSummaries,
            skippedReason: summarized.skippedReason,
          }));
        }
      } catch (error) {
        console.error("[external-sent-summary] schedule step failed", JSON.stringify({
          message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        }));
      }
    }

    const stitchTrackingIds = [
      ...(sentImport?.importedTrackingIds ?? []),
      ...(personalSentImport?.importedTrackingIds ?? []),
    ];
    if (stitchTrackingIds.length > 0) {
      try {
        const stitched = await stitchExternalSentConversationsCore({
          trackingIds: stitchTrackingIds,
          stitchDeadlineMs: Date.now() + EXTERNAL_SENT_STITCH_PIGGYBACK_BUDGET_MS,
        });
        if (stitched.deferred > 0) {
          // 편승엔 커서가 없어 deferred 행은 이 레인이 다시 못 집는다 — 백필 콜러블로 회수하라는 신호.
          console.warn("[external-sent-stitch] deferred rows need backfill", JSON.stringify({ deferred: stitched.deferred }));
        }
      } catch (error) {
        console.error("[external-sent-stitch] schedule step failed", JSON.stringify({
          message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        }));
      }
    }

    // [P1 — 편입 발신 스티치 재시도]: 위 편승은 **이번 회차에 편입된** trackingId 만 본다.
    //   편입 시점에 수신자의 대화가 없거나 아직 그 계정에 귀속되지 않아
    //   skippedNoConversationForIdentity 로 끝난 행은 이 경로로는 다시는 시도되지 않는다 —
    //   개인 발송은 미귀속 대화에 붙는 게 금지라(conversationEligibleForAccount) "발송 먼저 ·
    //   대화 귀속 나중"이 상시 경로다. 그대로 두면 stitchedConversationId 가 영영 비어
    //   mailSignature 의 hasReply 폴백이 발화하지 못하고, "내가 보낸 메일에 답장 안 온 사람"
    //   질의가 정확히 그 행들을 조용히 놓친다.
    //   그래서 같은 10분 틱에서 계정별 **유계 순환 스캔**(창 상한·되감김 커서는 헬퍼 안)으로
    //   미부착 편입분을 다시 시도한다 — 회차당 읽기는 계정 수 × 창 크기로 묶여 잔량과 무관하게
    //   자라지 않고, 계정 실패는 계정 단위로 격리돼 나머지 계정·INBOX 수집을 뒤집지 않는다.
    //   계정 목록은 방금 돌린 인벤토리 outcome 을 재사용한다(실패 계정도 포함 — IMAP 실패와
    //   미부착 스티치는 무관하다). 인벤토리 자체가 실패한 틱에는 canonical("scp")만 돌린다 —
    //   같은 영구 정체가 canonical 스탬프 행에도 있기 때문이다(mailAccountId 무스탬프 역대 행은
    //   어느 창에도 없다 — 그쪽은 종전대로 백필 콜러블 몫).
    if (sentImportTick) {
      try {
        await retryUnstitchedSentImportStitches({
          accountIds: [
            "scp",
            ...(personalSentImport?.outcomes.map((outcome) => outcome.mailAccountId) ?? []),
          ],
          stitchDeadlineMs: Date.now() + EXTERNAL_SENT_STITCH_PIGGYBACK_BUDGET_MS,
        });
        // 회차 요약 로그는 헬퍼가 한 줄로 남긴다 — 여기서 다시 집계하면 중복 집계다.
      } catch (error) {
        const evidence = safeOutboundFailureEvidence(error, "sent-import-stitch-retry:schedule");
        console.error("[external-sent-stitch] retry pass failed", JSON.stringify({
          errorCode: evidence.errorCode,
          failureKind: evidence.failureKind,
          failureRuleId: evidence.failureRuleId,
          correlationIdHash: evidence.correlationIdHash,
        }));
      }
    }

    // 수동 답장 학습 캡처 (functions/manualReplyLearning.ts): 이번 회차가 편입·페어링한
    //   reply-shaped 행만 넘긴다(kind:"manual_reply" + pairedInboundMessageSourceId). 설정
    //   플래그(settings/manual_reply_learning, 기본 OFF)와 일일 캡을 이 헬퍼 안에서 스스로
    //   게이트하므로 여기선 무조건 넘기고 결과만 로그로 남긴다. 실패는 임포트 결과를 뒤집지
    //   않는다 — 형제 요약·스티치 편승과 같은 격리 원칙.
    const importedReplyCandidates = [
      ...(sentImport?.importedReplyCandidates ?? []),
      ...(personalSentImport?.importedReplyCandidates ?? []),
    ];
    if (importedReplyCandidates.length > 0) {
      try {
        const captured = await captureManualReplyLearningCandidatesForImportedReplies(importedReplyCandidates);
        console.log("[manual-reply-learning] schedule step", JSON.stringify(captured));
      } catch (error) {
        const evidence = safeOutboundFailureEvidence(error, "manual-reply-learning:schedule");
        console.error("[manual-reply-learning] schedule step failed", JSON.stringify({
          errorCode: evidence.errorCode,
          failureKind: evidence.failureKind,
          failureRuleId: evidence.failureRuleId,
          correlationIdHash: evidence.correlationIdHash,
        }));
      }
    }

    // "실제 Gmail에도 읽음 표시" (2026-09-26): 자동응답/수동 답장 발송 경로가 적재한 아웃박스
    //   (imap_mark_read_outbox)를 이 틱에서 드레인한다 — 같은 IMAP_PASSWORD 시크릿을 이미 쓰는
    //   이 자리가 자연스럽고, onSchedule 총수 핀(tests/w72-a-nudge-sweep.test.mjs)을 지킨다.
    //   실패는 임포트 결과를 뒤집지 않는다 — 형제 요약·스티치 편승과 같은 격리 원칙(best-effort,
    //   메일 발송은 이미 끝난 뒤라 여기서 막을 게 없다). 안읽음 아웃박스는 다음 틱에 재시도된다.
    try {
      const markReadResult = await drainImapMarkReadOutboxHandler();
      if (markReadResult.processed > 0) {
        console.log("[imap-mark-read] schedule step", JSON.stringify(markReadResult));
      }
    } catch (error) {
      const evidence = safeOutboundFailureEvidence(error, "imap-mark-read:schedule");
      console.error("[imap-mark-read] schedule step failed", JSON.stringify({
        errorCode: evidence.errorCode,
        failureKind: evidence.failureKind,
        failureRuleId: evidence.failureRuleId,
        correlationIdHash: evidence.correlationIdHash,
      }));
    }

    // 받은 메일 수집이 정상인데 발송분만 실패한 경우에만 여기서 던진다. 조용히 넘기면 수집이
    // 멈춘 걸 아무도 모른다(형제 계약과 동일한 성질). 커서는 전진하지 않았으므로 다음 회차가
    // 같은 구간을 다시 시도한다. 받은 메일 수집도 실패했다면 아래 기존 경로가 그쪽을 먼저 던진다
    // — INBOX 수집이 이 함수의 주 계약이라 그 오류가 우선한다(mail-imap-scheduler-health 계약 보존).
    if (sentImportError && result.ok) {
      console.error("[sent-import] schedule step failed", JSON.stringify({
        message: sentImportError instanceof Error ? sentImportError.message.slice(0, 200) : "unknown",
      }));
      throw Object.assign(new Error("sent mail import step failed"), {
        code: "internal", errorCode: "sent_import_step_failed",
      });
    }
    if (result.ok) {
      console.log("[imap-ingest] schedule run", JSON.stringify(summary));
      return;
    }
    console.warn("[imap-ingest] schedule completed with errors", JSON.stringify(summary));
    throw Object.assign(new Error("IMAP ingest completed with unresolved errors"), {
      code: "internal", errorCode: "as_string_imap_ingest_completed_with_unresolved",
      runId: result.runId,
      errorCount: result.errors,
    });
  },
);

// PLAN-ORG-MAIL-IDENTITY Slice 4: mail history backfill worker. This is a NEW onSchedule
// (repo convention is to piggyback new work onto an existing schedule — see the "onSchedule
// 총수 41 핀" comments above and in tests/w72-a-nudge-sweep.test.mjs / tests/w115-discovery-
// supply.test.mjs) for the same reason scpSheetReviewSyncSchedule got its own schedule: one
// backfill batch's IMAP SINCE-scan needs its own up-to-4-minute budget
// (MAIL_BACKFILL_TIME_BUDGET_MS), and stacking that onto processImapIngestQueue's already-tight
// 1-minute-cadence/300s-timeout schedule would risk that schedule missing its own timeout on
// every tick a backfill job happens to be active. Every invocation advances at most ONE job by
// one bounded batch (functions/mailImapBackfill.ts) — most ticks are a single-document Firestore
// scan (no active job) and return immediately.
export const runMailBackfillJobsSchedule = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 0,
    timeoutSeconds: 280,
    memory: "512MiB",
    // Flu/Task-49: same drama-pool addition as processImapIngestQueue above.
    secrets: [
      "IMAP_PASSWORD",
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "YOUTUBE_OAUTH_CREDENTIAL_ENCRYPTION_KEY",
      "YOUTUBE_POOL_DRAMA_1_OAUTH_CLIENT_ID",
      "YOUTUBE_POOL_DRAMA_1_OAUTH_CLIENT_SECRET",
    ],
  },
  async () => {
    const result = await runMailBackfillJobs();
    console.log("[mail-backfill] schedule run", JSON.stringify(result));
  },
);

// PLAN-ORG-MAIL-IDENTITY Slice 4: self-service (owner) or admin-triggered mail history load.
// startMailBackfill only enqueues a mail_backfill_jobs/{jobId} doc (Firestore write, no IMAP
// secret needed by the callable itself — runMailBackfillJobsSchedule above does the live work).
// getMailBackfillStatus is a pure Firestore projection.
export const startMailBackfill = callable(startMailBackfillHandler);
export const getMailBackfillStatus = callable(getMailBackfillStatusHandler);

// S2/P2 (RT-1/A1) — operator-triggered recovery for a poison-quarantined IMAP message
// (trackingId or uid+mailbox). RBAC manager+ enforced server-side in the handler.
export const rescanImapByTrackingId = callable(rescanImapByTrackingIdHandler, {
  secrets: ["IMAP_PASSWORD", "AI_HUB_LLM_API_KEY", "JEV_API_KEY"],
  timeoutSeconds: 120,
});
// S2/P2 (RT-1 acceptance b) — reconciliation ledger between sent trackingIds waiting on a
// reply and IMAP ingest dead-letters. Read/write only, no live IMAP secret needed.
export const sweepMailIngestGaps = callable(sweepMailIngestGapsHandler);

// F2 Manage application-management operator surface (spec B §3.3-3.5, §7). RBAC manager+ in handlers.
export const listApplicationManageInbox = callable(listApplicationManageInboxHandler);
export const assignApplicationManagement = callable(assignApplicationManagementHandler);
export const applicationManagementKpi = callable(applicationManagementKpiHandler);
// Task-95 §4: 자동 판정 원장의 record-only undo(적용된 자동 반려를 실제로 되돌리지 않는다 —
// 포털 admin-bridge 에 application.reopen 이 없다, TICKET-MAP §3 결정 #11). manager+.
export const undoApplicationQualificationDecision = callable(undoApplicationQualificationDecisionHandler);
// channel_not_found_pending_review(identity.channelId 부재 단락)에 갇힌 신청 + 스캔 창 밖
// 미판정 신청을 id 단건으로 재판정한다 — 마커만 지우는 게 아니라 스윕과 같은 판정
// 파이프라인을 직접 실행하므로 updatedAtIso desc 창 밖 문서도 처리된다. manager+,
// 기본 dry-run + confirm 토큰. 문서별 YouTube 왕복(해소+구독자 조회)이 직렬이라 300초.
// ADMIN 링은 재판정 판정이 auto-reject 를 적용할 때 포털 커맨드 서명에 필요하다 —
// 스케줄(drainScpCreatorPipelineV3ManagementAck)은 이 링을 아직 바인딩하지 않아 스윕 경로의
// applyAutoReject 는 플래그를 켜도 fail-closed 로 남는다(적대적 리뷰 F4 — 기존 갭, 별개 수리 대상).
export const rejudgeApplicationQualification = callable(rejudgeApplicationQualificationHandler, {
  secrets: [
    ...YOUTUBE_API_SECRETS,
    "SCP_CREATOR_PIPELINE_V3_ADMIN_CURRENT_KEY_ID",
    "SCP_CREATOR_PIPELINE_V3_ADMIN_CURRENT_KEY_SECRET",
  ],
  timeoutSeconds: 300,
});
// W91 [헤세 · 크리에이터 탭] P0: Portal 지원서 관리 레코드 + scp_portal_creator_bindings 조인
// 읽기 전용 디렉터리. 실행 액션은 전부 Portal 딥링크(포털 API 호출 없음).
export const listScpCreatorDirectory = callable(listScpCreatorDirectoryHandler);
// Flu/Task-37: 읽기 전용, Firestore 조인 자체는 secret 불필요하지만 2026-09-27 scp entitlement
// gate(assertScpEntitled, functions/mailAccounts.ts)가 Peoply org 해석에 PEOPLY_API_KEY가
// 필요하다 — codex 적대 리뷰: 미바인딩이면 배포 환경에서 정당한 사용자도 permission-denied.
export const listScpApprovedWithoutIngest = callable(listScpApprovedWithoutIngestHandler, ["PEOPLY_API_KEY"]);
// W91 P1/P2 [헤세 · admin-bridge]: Portal 실계정 조회 + operator-attributed CAS 커맨드. 둘 다
// SCP_CREATOR_PIPELINE_V3_ADMIN_* (ADMIN 링) 로 서명한다 — MATERIAL/INBOUND 링과 별개 회전 창.
// CURRENT 페어만 선언한다 — PREVIOUS 2종은 아직 Secret Manager 에 없어 선언 시 deploy 가 실패한다
// (키 회전 시점에 추가).
// Task-52 (적대적 리뷰 P1-1): limit>100 요청은 이제 이 핸들러 안에서 브리지 페이지를 최대 5회
// 체인하고 매번 채널 통계 청크를 순회한다 — 최악(500핸들 ÷ 30/청크 = 17청크 × 4초 타임아웃 ≈
// 68초) + 브리지 5페이지 왕복을 더해도 기본 60초 타임아웃엔 못 들어갈 수 있어 120초로 명시한다.
export const listScpPortalCreators = callable(listScpPortalCreatorsHandler, {
  secrets: [
    // 디렉터리 구독자 수 보강(channels.list) — 키 부재 시 fail-open(보강만 생략).
    ...YOUTUBE_API_SECRETS,
    "SCP_CREATOR_PIPELINE_V3_ADMIN_CURRENT_KEY_ID",
    "SCP_CREATOR_PIPELINE_V3_ADMIN_CURRENT_KEY_SECRET",
  ],
  timeoutSeconds: 120,
});
// 2026-09-27 scp entitlement gate (assertScpEntitled) needs PEOPLY_API_KEY to resolve the
// caller's org — see listScpApprovedWithoutIngest's comment above.
export const scpPortalCreatorCommand = callable(scpPortalCreatorCommandHandler, [
  "SCP_CREATOR_PIPELINE_V3_ADMIN_CURRENT_KEY_ID",
  "SCP_CREATOR_PIPELINE_V3_ADMIN_CURRENT_KEY_SECRET",
  "PEOPLY_API_KEY",
]);
// F4 content-submission eligibility (spec C / §5).
export const evaluateContentEligibility = callable(evaluateContentEligibilityHandler);
// F3 onboarding test-send (spec D.3) — managed-gated enqueue (draft-only, fail-closed).
export const sendOnboardingTest = callable(sendOnboardingTestHandler);
// §4 canonical review transition operator command (CAS + ledger + projection + outboxes).
// 2026-09-27 scp entitlement gate (assertScpEntitled) needs PEOPLY_API_KEY — see
// listScpApprovedWithoutIngest's comment above.
export const transitionVideoReviewDecision = callable(transitionVideoReviewDecisionHandler, ["PEOPLY_API_KEY"]);
// Task-94: manager+ operator undo of an AI-authored `rejected` decision (rejected ->
// human_review_required). Hard precondition for ever turning auto-reject ON.
export const undoVideoReviewDecision = callable(undoVideoReviewDecisionHandler, ["PEOPLY_API_KEY"]);
// Task-100 §4: 사유코드별 재제출/이탈 지표(읽기 전용, manager+).
export const getResubmissionCycleMetrics = callable(getResubmissionCycleMetricsHandler);
// spec_partner_activation_from_video_approval §7.2 explicit revocation command — standalone, permissioned,
// audited CAS; NEVER invoked automatically. 0.5.38 fix: this callable was implemented in
// partnerActivationStore.ts but never exported/wired — closing the P2#4 gap by wiring it here and
// classifying it DENIED (mutation, unreviewed) in functions-staging/runtime/index.cjs.
export const revokePartnerActivation = callable(revokePartnerActivationHandler);
// G005 canonical review-state read surface for the /flu/review canonical panel (list only; decisions
// flow exclusively through transitionVideoReviewDecision above).
// 2026-09-27 codex adversarial review (rounds 1-2): needs PEOPLY_API_KEY to resolve a
// non-super_admin caller's org for the scp entitlement check that decides between the full/slim
// scp row and an empty list for a non-entitled caller (functions/videoReviewStateCallables.ts).
export const listScpVideoReviewStates = callable(listScpVideoReviewStatesHandler, [
  ...YOUTUBE_API_SECRETS,
  "SCP_FLU_APPLICATION_COMMAND_SECRET",
  "SCP_FLU_APPLICATION_COMMAND_SECRET_PREVIOUS",
  "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_ID",
  "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_SECRET",
  "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_ID",
  "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_SECRET",
  "PEOPLY_API_KEY",
]);
// 2026-09-27 scp entitlement gate (assertScpEntitled) needs PEOPLY_API_KEY — see
// listScpApprovedWithoutIngest's comment above.
export const acknowledgeVideoResultMailDeadLetterAlert = callable(
  acknowledgeVideoResultMailDeadLetterAlertHandler,
  ["PEOPLY_API_KEY"],
);
// §6 duplicate detection read (manager+) — bounded indexed candidate retrieval, never all-pairs.
// 2026-09-27 codex adversarial review round 2 sweep: gated by assertScpEntitled — needs
// PEOPLY_API_KEY.
export const scpEvaluateVideoDuplicate = callable(evaluateVideoDuplicateHandler, PEOPLY_API_SECRETS);
// spec_creator_management_profile_tabs: bounded seven-tab Management read models (manager+), each tab
// index-backed per MANAGEMENT_TAB_REQUIRED_INDEXES (firestore.indexes.json). Independent per-tab
// envelope batch (Tier-B lazy load) + one paginated list callable per tab (cursor+limit bound, never an
// unbounded scan).
// 2026-09-27 codex adversarial review round 2: the journey loader/list resolve the caller's org
// via Peoply (functions/conversationMailAccessScope.ts) to enforce the scp per-org gate on the
// conversation-outreach event — see PEOPLY_API_SECRETS's doc comment above.
export const manageProfileTabEnvelopes = createManagementTabEnvelopesCallable({
  minimumRole: "manager",
  port: createFirestoreManagementTabEnvelopesPort(),
  secrets: PEOPLY_API_SECRETS,
});
export const manageProfileTabJourneyList = createScopedTabListCallable({
  minimumRole: "manager",
  port: createFirestoreScopedTabListPort("journey"),
  secrets: PEOPLY_API_SECRETS,
});
export const manageProfileTabOutreachList = createScopedTabListCallable({
  minimumRole: "manager",
  port: createFirestoreScopedTabListPort("outreach"),
});
export const manageProfileTabApplicationsList = createScopedTabListCallable({
  minimumRole: "manager",
  port: createFirestoreScopedTabListPort("applications"),
});
export const manageProfileTabOnboardingList = createScopedTabListCallable({
  minimumRole: "manager",
  port: createFirestoreScopedTabListPort("onboarding"),
});
export const manageProfileTabContentReviewList = createScopedTabListCallable({
  minimumRole: "manager",
  port: createFirestoreScopedTabListPort("content-review"),
});
export const manageProfileTabChannelIntelligenceList = createScopedTabListCallable({
  minimumRole: "manager",
  port: createFirestoreScopedTabListPort("channel-intelligence"),
});
export const manageProfileTabAuditList = createScopedTabListCallable({
  minimumRole: "manager",
  port: createFirestoreScopedTabListPort("audit"),
});
// spec_partner_profile_tabs: activation-only Partner list/detail 5-tab surface (manager+), bounded
// index-backed reads (functions/partnerProfileTabsPorts.ts). getActivePartners/resolvePartnerRouteAlias
// serve the Partner list route; getPartnerTabEnvelopes is the independent per-tab envelope batch for
// /flu/partners/{enrollmentId} (mirrors manageProfileTabEnvelopes above). Names match
// src/lib/partnerData.ts's callable invocations exactly.
export const getActivePartners = createGetActivePartnersCallable({
  minimumRole: "manager",
  port: createFirestoreActivePartnersPort(),
});
export const resolvePartnerRouteAlias = createResolvePartnerRouteAliasCallable({
  minimumRole: "manager",
  port: { lookup: createFirestoreResolvePartnerRouteAliasPort().lookup },
});
export const getPartnerTabEnvelopes = createPartnerTabEnvelopesCallable({
  minimumRole: "manager",
  port: createFirestorePartnerTabEnvelopesPort(),
});
// GAP-C (FLU-0538 completion, 2026-07-21): per-creator management-classification signal so the
// management detail seven-tab clone renders as the DEFAULT view for managed creators (no ?view=management
// gate). manager+, read-only, single bounded equality on identity.fluCreatorId (no new composite index).
export const getCreatorManagementClassification = createGetCreatorManagementClassificationCallable();

// spec_video_performance_settlement_report: bounded video-performance/settlement report read surface
// (manager+), index-backed over video_performance_report_rows (functions/videoPerformanceReportPorts.ts,
// functions/videoPerformanceReportProjection.ts). Names match src/lib/videoPerformanceData.ts's callable
// invocations exactly.
export const getVideoPerformanceSummary = createGetVideoPerformanceSummaryCallable({
  port: createFirestoreVideoPerformanceReportPort(),
});
export const listVideoPerformanceLedger = createListVideoPerformanceLedgerCallable({
  port: createFirestoreVideoPerformanceReportPort(),
});
export const getVideoPerformanceDetail = createGetVideoPerformanceDetailCallable({
  port: createFirestoreVideoPerformanceReportPort(),
});

// GAP-B (FLU-0538 completion, operator-locked 2026-07-21): descriptive tracked-video read surface
// (manager+). Additive alongside the settlement callables above — reads video_performance_report_rows
// where descriptive==true (always reportEligible==false), so /flu/report/video-performance can show the
// real 104 video_view_series / 940 video_view_snapshots numbers without touching the settlement ledger.
export const listTrackedVideoObservations = createListTrackedVideoObservationsCallable();

export const refreshCreatorActivityFeed = onSchedule(
  {
    schedule: "20 5 * * *",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 1,
    timeoutSeconds: 540,
    memory: "512MiB",
    // S12 A5: videoCommentAnalysisInline 경유로 reportLlmUsage에 도달 — AI Hub secret 바인딩 보강.
    secrets: [...YOUTUBE_API_SECRETS, "AI_HUB_LLM_API_KEY"],
  },
  async () => {
    await refreshCreatorActivityFeedHandler();
  },
);

// SCP TTL/rate-limit housekeeping (Wave3 W3-3, P1-8 growth finding) — sweeps
// expired judge caches and stale rate-limit/throttle counters in small,
// capped batches. See functions/scpCleanup.ts for exact scope/safety notes.
export const scpCleanup = onSchedule(
  {
    schedule: "every 60 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 0,
    timeoutSeconds: 300,
    memory: "256MiB",
  },
  async () => {
    await scpCleanupHandler();
  },
);

// SCP no-response follow-up sweep (case F) — scans scp_outreach for cold sends past
// autoFollowupDays with no reply and no form submission and queues a single draft_only follow-up
// per recipient. Never sends: every mail goes through the draft_only + human gate + suppression
// stack. maxInstances:1 prevents concurrent double-queuing.
export const scpOutreachFollowupSweep = onSchedule(
  {
    schedule: "every 60 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 0,
    timeoutSeconds: 300,
    memory: "256MiB",
    // JEV_API_KEY: the w75_ytdlp_promotion stage below can reach hydrateYtdlpPromotionObservations→
    // searchYouTubeLive with a program-policy-derived discoveryVertical, which can be "ai_drama" —
    // aiDramaRelevance.ts's relevance gate then calls callJev.
    secrets: ["SMTP_PASSWORD", "AI_HUB_LLM_API_KEY", "JEV_API_KEY", ...YOUTUBE_API_SECRETS],
  },
  async () => {
    // W72/W75: 독립 단계를 **격리**한다. 순차 await 만 두면 앞 단계가 throw 할 때
    //   스윕이 아예 안 돌고, 스윕이 throw 하면 cron 전체가 실패로 기록된다 —
    //   서로 독립된 레인이므로 한쪽 장애가 다른 쪽을 멈추면 안 된다.
    //
    // W72 A: 새 스케줄 함수를 만들지 않는다. 독려 3코호트 적재는 이 함수의 단계로 돈다 —
    //   새 onSchedule 은 schedules invariant 를 38→39 로 만들어 릴리스 게이트를 정지시킨다
    //   (인계서 §7-2). 주기(60분)·maxInstances:1·retryCount:0 은 이 스윕이 이미 만족한다.
    // W72 합동리뷰 R2-6: 단계에 **이름을 붙여** 어느 레인이 죽었는지 로그에서 바로 갈린다.
    //   이름 없는 allSettled 는 "어느 단계가 실패했다"를 말하지 못한다.
    // W113 [헤세 배정]: 이 호스트는 timeoutSeconds 300 인데 독려 스윕이 매 런 그것을 넘겨
    //   SIGKILL 됐고(24h 요청로그 18/18 이 504 · 299.97s), 커서 저장 지점에 도달 못 해
    //   2026-08-13 부터 커서가 동결됐다. 스테이지에 **절대 시각 마감**을 준다 — 세 스테이지가
    //   동시 실행이라 벽시계 기준 하나를 공유하는 것이 맞다.
    const stageDeadlineMs = Date.now() + NUDGE_SWEEP_BUDGET_MS;
    const stages = [
      { stage: "scp_outreach_followup", run: () => scpOutreachFollowupScheduledHandler() },
      { stage: "w72_nudge_cohort_sweep", run: () => runNudgeCohortSweep({ deadlineMs: stageDeadlineMs }) },
      { stage: "w75_ytdlp_promotion", run: () => runYtdlpPromotionSweep() },
    ] as const;
    const outcomes = await Promise.allSettled(stages.map((entry) => entry.run()));
    // W113: 완료 판정(커서 전진·504 소멸)을 로그에서 바로 읽을 수 있게 스윕 요약을 싣는다.
    const nudgeOutcome = outcomes[1];
    if (nudgeOutcome.status === "fulfilled") {
      const value = nudgeOutcome.value as {
        totalEnqueued?: number; budgetStopped?: boolean; stopReason?: string; freshRun?: boolean;
        maxObservedSendMs?: number; haltReason?: string;
        phases?: {
          phaseCohort2Ms?: number; phaseHistoryQueryMs?: number; phaseExclusionBatchMs?: number;
          phaseRowLoopMs?: number; rowsScanned?: number; eligibleSeen?: number;
          stopConditionCalls?: number; stopConditionMs?: number; stopWriteCalls?: number;
          firstSendOffsetMs?: number; deadlineHeadroomMsAtCut?: number;
        };
      };
      console.log(JSON.stringify({
        event: "w72_nudge_sweep.run",
        totalEnqueued: value.totalEnqueued ?? 0,
        budgetStopped: value.budgetStopped === true,
        // W113 P3: 시간 예산 스톱과 건수 상한 스톱은 정반대 처방이라 갈라 싣는다.
        stopReason: value.stopReason ?? "",
        freshRun: value.freshRun === true,
        maxObservedSendMs: value.maxObservedSendMs ?? 0,
        haltReason: value.haltReason ?? "",
        elapsedMs: Date.now() - (stageDeadlineMs - NUDGE_SWEEP_BUDGET_MS),
      }));
      // W114 [헤세 배정]: W75 완주(+54s)와 첫 발송(+205s) 사이 148초의 로그 공백을 여는 순수 계측.
      //   기존 w72_nudge_sweep.run 스키마는 건드리지 않는다 — 별도 이벤트로 낸다.
      const phases = value.phases;
      if (phases) {
        console.log(JSON.stringify({
          event: "w72_nudge_sweep.phases",
          phaseCohort2Ms: phases.phaseCohort2Ms ?? 0,
          phaseHistoryQueryMs: phases.phaseHistoryQueryMs ?? 0,
          phaseExclusionBatchMs: phases.phaseExclusionBatchMs ?? 0,
          phaseRowLoopMs: phases.phaseRowLoopMs ?? 0,
          rowsScanned: phases.rowsScanned ?? 0,
          eligibleSeen: phases.eligibleSeen ?? 0,
          stopConditionCalls: phases.stopConditionCalls ?? 0,
          stopConditionMs: phases.stopConditionMs ?? 0,
          stopWriteCalls: phases.stopWriteCalls ?? 0,
          firstSendOffsetMs: phases.firstSendOffsetMs ?? 0,
          deadlineHeadroomMsAtCut: phases.deadlineHeadroomMsAtCut ?? 0,
        }));
      }
    }
    let failedStages = 0;
    outcomes.forEach((outcome, index) => {
      if (outcome.status !== "rejected") return;
      failedStages += 1;
      console.error(JSON.stringify({
        event: "scp_outreach_followup_sweep.stage_failed",
        stage: stages[index].stage,
        stageIndex: index,
        failedStages,
        totalStages: stages.length,
        reason: String((outcome.reason as { message?: unknown } | null)?.message ?? outcome.reason).slice(0, 300),
      }));
    });
    // 모든 단계가 실패했을 때만 함수가 실패한다 — 그때는 실제로 이 cron 이 아무 일도 못 한 것이다.
    if (failedStages === stages.length) {
      throw new Error("scpOutreachFollowupSweep: all stages failed");
    }
  },
);

// P3 1차 텍스트 영상 분류 — 미분류/자막상태 변경분을 배치 분류해 youtube_videos.classification 병합.
export const processVideoClassificationQueue = onSchedule(
  {
    schedule: "every 10 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 0,
    timeoutSeconds: 300,
    memory: "512MiB",
    // S12 A5: videoClassifier.ts가 reportLlmUsage에 직접 도달 — AI Hub secret 바인딩 보강.
    secrets: ["AI_HUB_LLM_API_KEY"],
  },
  async () => {
    await processVideoClassificationQueueHandler();
  },
);
// C1 광고 분류 — videos.adClassificationPending 배치 분류해 videos.adClassification 병합(LLM: callModel 초크포인트).
export const processVideoAdClassificationQueue = onSchedule(
  {
    schedule: "every 10 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 0,
    timeoutSeconds: 300,
    memory: "512MiB",
    secrets: ["AI_HUB_LLM_API_KEY"],
  },
  async () => {
    await processVideoAdClassificationQueueHandler();
  },
);
// C2 후보 승격 — candidate_pool → creators(type=influencer). activityRefresh(5:20) 직전(5:00 KST) 실행.
export const promoteDiscoveredCreatorsScheduled = onSchedule(
  {
    schedule: "0 5 * * *",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 0,
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async () => {
    await promoteCandidatesToCreatorsHandler();
  },
);
// C4 유튜브 링크 조회수 시계열 — CPM 정산용 시간별 트래킹(일일 버킷은 같은 날 마지막 수집이 자연 갱신).
//
// W8-5b: 매시 40분 → **5분 주기**. 제출 직후 첫 수집은 판정과 무관하게 시작하고, 승인된 뒤에는
// 승인 24시간 내 15분 / 이후 1시간의 적응형 cadence
// (videoViewSnapshotAdaptiveIntervalMs)가 이미 있었지만 크론이 시간당이라 그 분기가 잠들어 있었다.
// 5분을 고른 근거: ①제출→첫 스냅샷 5분 SLO(첫 스냅샷은 항상 due) ②크론(5분) < 적응형 간격(15분)
// 이라 due 판정이 정상 작동한다 — 기준 시각이 마지막 **성공** 수집(lastSuccessAtIso)이므로 skip 이
// 시계를 밀지 않는다(그 전에는 skip 이 lastAttemptAtIso 를 갱신해 크론≤간격이면 영원히 due 가
// 되지 않았다).
// 선행 조건은 W8-5a 배칭이었다: 예전에는 영상 1건당 videos.list 1콜이라 12배 실행 = 쿼터 12배였다.
// 배칭 후에는 실행당 ⌈due/50⌉ 콜이라 288회/일 × 1~2콜 ≈ 300~600유닛/일로 매시 실행 시절(1,200)보다
// 낮다. 아무것도 due 가 아니면 API 콜은 0이다(skippedFresh dedupe).
export const processVideoViewSnapshotQueueSchedule = onSchedule(
  {
    schedule: "*/5 * * * *",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    // R4: 예전에는 timeoutSeconds(300) == 스케줄 간격(300s) 이고 retryCount 0 이라 실행 여유가 0 이었다
    // (한 번 늦어지면 다음 tick 과 겹치거나 그 tick 을 잃는다). 타임아웃을 간격보다 짧게 잡아
    // 한 실행이 다음 tick 을 침범하지 않게 하고, 실패 시 1회 재시도를 허용한다(maxInstances:1 이
    // 직렬화하므로 재시도가 겹쳐 돌 수 없다).
    retryCount: 1,
    timeoutSeconds: 240,
    memory: "512MiB",
    secrets: [...YOUTUBE_API_SECRETS],
  },
  async () => {
    await processVideoViewSnapshotQueueHandler();
  },
);
// P4 주간 트렌드 리포트 — 스냅샷(월요일 00:00 KST, 직전 일요일 24:00 컷오프) → 발행(월요일 09:00 KST, 골든셋 게이트).
function trendReportWeekKeyForNowIso(nowIso: string): string {
  return new Date(Date.parse(nowIso) + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function classificationFromVideoDoc(
  data: Record<string, unknown>,
): WeeklyVideoRecord["classification"] {
  const classification =
    data.classification && typeof data.classification === "object"
      ? (data.classification as Record<string, unknown>)
      : null;
  if (
    !classification ||
    typeof classification.format !== "string" ||
    typeof classification.genreStyle !== "string" ||
    typeof classification.contentNature !== "string"
  )
    return undefined;
  return {
    format: classification.format,
    genreStyle: classification.genreStyle,
    contentNature: classification.contentNature,
  };
}

async function loadWeeklyVideoRecords(
  weekKey: string,
): Promise<WeeklyVideoRecord[]> {
  const { startIso, endIsoExclusive } = weekWindowForKey(weekKey);
  const snapshot = await adminDb
    .collection("youtube_videos")
    .where("publishedAtIso", ">=", startIso)
    .where("publishedAtIso", "<", endIsoExclusive)
    .get();
  return snapshot.docs.map((doc) => {
    const data = doc.data() ?? {};
    const classification =
      data.classification && typeof data.classification === "object"
        ? (data.classification as Record<string, unknown>)
        : null;
    const analysis =
      data.analysis && typeof data.analysis === "object"
        ? (data.analysis as Record<string, unknown>)
        : null;
    return {
      id: doc.id,
      timestampIso:
        typeof data.publishedAtIso === "string"
          ? data.publishedAtIso
          : startIso,
      classification: classificationFromVideoDoc(data),
      classificationPending: data.classificationPending === true,
      classificationSource:
        classification &&
        typeof classification.classificationSource === "string"
          ? classification.classificationSource
          : undefined,
      analysis:
        analysis &&
        typeof analysis.editDensity === "number" &&
        typeof analysis.estimatedSessionMinutes === "number"
          ? {
              editDensity: analysis.editDensity,
              estimatedSessionMinutes: analysis.estimatedSessionMinutes,
            }
          : undefined,
    };
  });
}

async function loadWeeklySnapshotDoc(
  weekKey: string,
): Promise<WeeklyTrendSnapshot | null> {
  const doc = await adminDb.collection("trend_reports").doc(weekKey).get();
  if (!doc.exists) return null;
  const data = doc.data() ?? {};
  return {
    weekKey,
    axisTopDeltas:
      (data.axisTopDeltas as WeeklyTrendSnapshot["axisTopDeltas"]) ?? {
        format: [],
        genreStyle: [],
        contentNature: [],
      },
    crossCellMovers:
      (data.crossCellMovers as WeeklyTrendSnapshot["crossCellMovers"]) ?? [],
    sampleScope: typeof data.sampleScope === "string" ? data.sampleScope : "",
    analysisCoveragePct:
      typeof data.analysisCoveragePct === "number"
        ? data.analysisCoveragePct
        : 0,
    carriedOver: Array.isArray(data.carriedOver)
      ? (data.carriedOver as string[])
      : [],
    proxyFieldsPending: true,
    tierTwoReclassificationRatePct:
      typeof data.tierTwoReclassificationRatePct === "number"
        ? data.tierTwoReclassificationRatePct
        : 0,
    ...(data.observedProxyMetrics &&
    typeof data.observedProxyMetrics === "object"
      ? {
          observedProxyMetrics:
            data.observedProxyMetrics as WeeklyTrendSnapshot["observedProxyMetrics"],
        }
      : {}),
    ...(data.qualityWarning === true ? { qualityWarning: true as const } : {}),
  };
}

async function loadGoldenSetAgreementRatio(): Promise<number> {
  const labelsSnapshot = await adminDb.collection("golden_set_labels").get();
  const labels = labelsSnapshot.docs
    .map((doc) => {
      const data = doc.data() ?? {};
      return {
        videoId: typeof data.videoId === "string" ? data.videoId : "",
        format: typeof data.format === "string" ? data.format : "",
        genreStyle: typeof data.genreStyle === "string" ? data.genreStyle : "",
        contentNature:
          typeof data.contentNature === "string" ? data.contentNature : "",
      };
    })
    .filter(
      (label): label is GoldenSetQualitativeLabel & { videoId: string } =>
        label.videoId.length > 0,
    );

  const classifications = new Map<string, GoldenSetQualitativeLabel>();
  await Promise.all(
    labels.map(async (label) => {
      const videoDoc = await adminDb
        .collection("youtube_videos")
        .doc(label.videoId)
        .get();
      if (!videoDoc.exists) return;
      const classification = classificationFromVideoDoc(videoDoc.data() ?? {});
      if (classification) classifications.set(label.videoId, classification);
    }),
  );

  return computeGoldenSetAgreement(labels, classifications).agreementRatio;
}

export const buildWeeklyTrendReportSnapshot = onSchedule(
  {
    schedule: "0 0 * * 1",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 1,
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async () => {
    const nowIso = new Date().toISOString();
    const weekKey = trendReportWeekKeyForNowIso(nowIso);
    const [videos, prevSnapshot] = await Promise.all([
      loadWeeklyVideoRecords(weekKey),
      loadWeeklySnapshotDoc(
        new Date(
          Date.parse(`${weekKey}T00:00:00+09:00`) - 7 * 24 * 60 * 60 * 1000,
        )
          .toISOString()
          .slice(0, 10),
      ),
    ]);
    const snapshot = buildWeeklyTrendSnapshot(weekKey, {
      videos,
      prevSnapshot,
    });
    await adminDb
      .collection("trend_reports")
      .doc(weekKey)
      .set(
        {
          weekKey: snapshot.weekKey,
          axisTopDeltas: snapshot.axisTopDeltas,
          crossCellMovers: snapshot.crossCellMovers,
          sampleScope: snapshot.sampleScope,
          analysisCoveragePct: snapshot.analysisCoveragePct,
          carriedOver: snapshot.carriedOver,
          proxyFieldsPending: true,
          tierTwoReclassificationRatePct:
            snapshot.tierTwoReclassificationRatePct,
          ...(snapshot.observedProxyMetrics
            ? { observedProxyMetrics: snapshot.observedProxyMetrics }
            : {}),
          ...(snapshot.qualityWarning ? { qualityWarning: true } : {}),
          snapshotGeneratedAtIso: nowIso,
        },
        { merge: true },
      );
  },
);

// P5 영상 2차(멀티모달) 분석 배치 — 스냅샷(00:00 KST) 직후·발행(09:00 KST) 전인 00:30 KST에 실행해
// 그 주의 3축 재분류/qualityWarning이 발행 시점 trend_reports 문서에 반영되도록 한다.
// SEC-P0-005 B2 예외(callVideoModel)로 Vertex(ADC) 직행 — AI_HUB_LLM_API_KEY는 aiHubReport.reportLlmUsage용.
export const runWeeklyVideoDeepAnalysis = onSchedule(
  {
    schedule: "30 0 * * 1",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 1,
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: ["AI_HUB_LLM_API_KEY"],
  },
  async () => {
    const nowIso = new Date().toISOString();
    const weekKey = trendReportWeekKeyForNowIso(nowIso);
    await runWeeklyDeepAnalysisBatch({
      weekKey,
      nowIso,
      runId: `video-deep-analysis-${weekKey}`,
    });
  },
);

export const publishWeeklyTrendReportSchedule = onSchedule(
  {
    schedule: "0 9 * * 1",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 1,
    timeoutSeconds: 300,
    memory: "512MiB",
    secrets: ["AI_HUB_LLM_API_KEY"],
  },
  async () => {
    const nowIso = new Date().toISOString();
    const weekKey = trendReportWeekKeyForNowIso(nowIso);
    const snapshot = await loadWeeklySnapshotDoc(weekKey);
    if (!snapshot) {
      console.warn("[trend-report] publish skipped: no snapshot found", {
        weekKey,
      });
      return;
    }
    const goldenSetAgreement = await loadGoldenSetAgreementRatio();
    await publishWeeklyTrendReport(weekKey, {
      snapshot,
      goldenSetAgreement,
      runId: `trend-report-${weekKey}`,
      nowIso,
    });
  },
);

// 골든셋 정성 라벨링 — RBAC manager+(assertNonGuestAuth 재사용). 라벨러는 auth.userId로 서버 확정.
async function recordGoldenSetLabelHandler(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "goldenSet.label.record", [
    "super_admin",
    "admin",
    "manager",
  ]);
  const data = asRecord(request.data);
  const phase =
    data.phase === "full" ? ("full" as const) : ("calibration" as const);
  const record = await recordGoldenSetLabelImpl(
    adminDb as unknown as GoldenSetFirestoreDb,
    {
      videoId: asString(data.videoId, ""),
      format: asString(data.format, ""),
      genreStyle: asString(data.genreStyle, ""),
      contentNature: asString(data.contentNature, ""),
      labeler: auth.userId,
      phase,
    },
  );
  return { ok: true, record };
}

// 읽기 전용 리포트 목록 — SEC-P0-004: 클라 Firestore 직접 read 금지, callable 경유.
async function listTrendReportsHandler(request: CallableRequestShape) {
  const rawLimit = asRecord(request.data).limit;
  assertNonGuestAuth(request, "trendReport.list", [
    "super_admin",
    "admin",
    "manager",
    "viewer",
  ]);
  const limit = Math.max(
    1,
    Math.min(
      52,
      typeof rawLimit === "number" && Number.isFinite(rawLimit)
        ? Math.trunc(rawLimit)
        : 12,
    ),
  );
  const snapshot = await adminDb
    .collection("trend_reports")
    .orderBy("weekKey", "desc")
    .limit(limit)
    .get();
  return { ok: true, reports: snapshot.docs.map((doc) => doc.data()) };
}

export const recordGoldenSetLabel = callable(recordGoldenSetLabelHandler);
export const listTrendReports = callable(listTrendReportsHandler);

// M4 campaigns callable exports
export const orchestrateCampaign = callable(orchestrateCampaignHandler);
export const syncCampaignFunnel = callable(syncCampaignFunnelHandler);
export const learnCampaignPriority = callable(learnCampaignPriorityHandler);
export const addCandidatesToCampaign = callable(addCandidatesToCampaignHandler, PEOPLY_API_SECRETS);
export const importCandidatesToCampaign = callable(importCandidatesToCampaignHandler, PEOPLY_API_SECRETS);
export const listCampaignCandidates = callable(listCampaignCandidatesHandler, PEOPLY_API_SECRETS);
export const repairLegacyCandidateScopes = callable(repairLegacyCandidateScopesHandler);
// P0-1 [XP→Pororo 후보 이주]: contacted 후보를 타깃 캠페인 후보 풀(campaign_candidates,
// stage:"discovered")로 복사하는 운영자 트리거 이주. dryRun 기본, 실행은 confirm 문구 필수.
// ~11k 문서 스캔+배치 쓰기라 540s · 동시 실행 1(재실행은 link-id merge 라 멱등).
// 2026-09-27 [프로드 실측]: bypassKeywordGate:true 로 XP Hero→Snake 전체(~11k 후보) 한 번에
//   돌리면 기본 512MiB 에서 OOM("Memory limit of 512 MiB exceeded with 513 MiB used") — 이
//   콜러블은 이미 maxInstances:1·concurrency:1 싱글턴이라 재시도 없이 그 실행 전체가 유실된다.
//   같은 근인·같은 처방을 processDiscoveryQueue 512→1GiB 수정(#195)에서 확인했다.
export const migrateCampaignCandidates = callable(
  migrateCampaignCandidatesHandler,
  { timeoutSeconds: 540, maxInstances: 1, concurrency: 1, memory: "1GiB" },
);
export const repairLegacyProgramSheetLeadScopes = callable(
  repairLegacyProgramSheetLeadScopesHandler,
  { timeoutSeconds: 120, maxInstances: 1, concurrency: 1 },
);
export const retireLegacyQaPrograms = callable(
  retireLegacyQaProgramsHandler,
  { timeoutSeconds: 540, maxInstances: 1, concurrency: 1 },
);
// W122: repairs settlement-relevant review-subject identity from the immutable binding
// registry. Mutation-capable maintenance => DENIED in the staging facade.
// 2026-09-27 codex adversarial review round 4 FAIL-4: now calls assertScpEntitled — needs
// PEOPLY_API_KEY.
export const repairVideoReviewSubjectIdentities = callable(
  repairVideoReviewSubjectIdentitiesHandler,
  { secrets: ["PEOPLY_API_KEY"], timeoutSeconds: 120, maxInstances: 1, concurrency: 1 },
);
// Rewrites persisted flu.supercent.io links (NXDOMAIN — never provisioned) to sc-flu.web.app in
// submission-task/lead/application docs + queued mail outboxes. dryRun-first, confirmation-gated
// maintenance write => DENIED in the staging facade.
export const repairFluAppOriginLinks = callable(
  repairFluAppOriginLinksHandler,
  { timeoutSeconds: 540, maxInstances: 1, concurrency: 1 },
);

// M5 contracts callable exports
export const negotiateContract = callable(negotiateContractHandler);
export const createEscalation = callable(createEscalationHandler);
export const validateContractTemplate = callable(
  validateContractTemplateHandler,
);

// M6 feedback-kb callable exports — AI Hub project key secret
export const submitFeedback = callable(submitFeedbackHandler, [
  "AIHUB_PROJECT_KEY",
]);
export const indexFeedbackKb = callable(indexFeedbackKbHandler, [
  "AIHUB_PROJECT_KEY",
]);
export const retrieveFeedbackKb = callable(retrieveFeedbackKbHandler, [
  "AIHUB_PROJECT_KEY",
]);
export const queueFineTuneExample = callable(queueFineTuneExampleHandler, [
  "AIHUB_PROJECT_KEY",
]);
export const processFineTuneCompensationOutbox = callable(
  processFineTuneCompensationOutboxHandler,
  ["AIHUB_PROJECT_KEY"],
);
export const retryFeedbackGraphProjection = callable(retryFeedbackGraphProjectionHandler);
export const getFeedbackKbGovernanceStatus = callable(getFeedbackKbGovernanceStatusHandler, [
  "AIHUB_PROJECT_KEY",
]);

// S9 kb_review 충돌 큐 UI — 외부 API/secret 불필요(Firestore 조회·머지뿐).
export const listKbReviewQueue = callable(listKbReviewQueueHandler);
export const resolveKbReview = callable(resolveKbReviewCallableHandler);

// 수동 답장 학습 캡처 — Firestore 조회·쓰기뿐, AI Hub 시크릿 불필요
// (functions/manualReplyLearning.ts, submitFeedbackAsSystem 경로는 processFeedbackGraphProjection
// 만 타고 AI Hub fine-tune enqueue 는 절대 타지 않는다).
export const getManualReplyLearningSettings = callable(getManualReplyLearningSettingsHandler);
export const updateManualReplyLearningSettings = callable(updateManualReplyLearningSettingsHandler);
export const backfillManualReplyLearningCandidates = callable(backfillManualReplyLearningCandidatesHandler);

// M7 crm callable exports
export const upsertCreator = callable(upsertCreatorHandler);
export const transitionCreatorStage = callable(transitionCreatorStageHandler);
export const syncChannelStats = callable(syncChannelStatsHandler);

// M8 review-pay callable exports
// 2026-09-27 codex adversarial review round 4 FAIL-3: both now gate their video-submissionId
// branch with assertVideoSubmissionScpEntitled (review-pay.ts), which resolves entitlement via
// isCallerScpEntitled (PEOPLY_API_KEY, same as every other scp-entitlement check).
export const updateReviewStatus = callable(updateReviewStatusHandler, ["PEOPLY_API_KEY"]);
export const recordPayment = callable(recordPaymentHandler, ["PEOPLY_API_KEY"]);
export const syncReviewLedger = callable(syncReviewLedgerHandler);

// M9 report callable exports
export const aggregateReport = callable(aggregateReportHandler);
export const listRawRecords = callable(listRawRecordsHandler);
export const logCostUsage = callable(logCostUsageHandler);
// /flu/report rebuild (SCP Creator Portal admin dashboard clone) — 2026-09-07
// 크리에이터 국가 분포/포털 계정 현황은 admin-bridge 를 읽는다 — listScpPortalCreators 와 같은
// ADMIN 키 페어(CURRENT only)가 있어야 fail-open 이 아니라 실제로 조회된다.
// 2026-09-07 라운드 3: 승인→트래킹 프로젝션이 멎어 있는 동안 조회수 3단 사다리의 마지막 단이
// 라이브 YouTube Data API videos.list(processVideoViewSnapshotQueueSchedule 과 같은 클라이언트
// 구성)라 YOUTUBE_API_SECRETS 도 묶는다 — 채널 구독자 보강(channels.list)은 여전히 안 한다.
export const getReportDashboard = callable(getReportDashboardHandler, [
  "SCP_CREATOR_PIPELINE_V3_ADMIN_CURRENT_KEY_ID",
  "SCP_CREATOR_PIPELINE_V3_ADMIN_CURRENT_KEY_SECRET",
  ...YOUTUBE_API_SECRETS,
]);

// M10 admin callable exports
export const setMemberRole = callable(setMemberRoleHandler);
export const inviteMember = callable(inviteMemberHandler);
// Auth login/session bootstrap resolves the verified Admin Auth email against
// Peoply. Keep the existing callable boundary so staging classification and
// the client contract do not grow a second membership endpoint.
export const requestAccess = callable(requestAccessHandler, {
  secrets: ["PEOPLY_API_KEY"],
  timeoutSeconds: 20,
  maxInstances: 5,
  concurrency: 5,
});
export const logBehavior = callable(logBehaviorHandler);
// 티켓 위젯. SuperBoard 전달(Functions 발 외부 egress, NET-P0-012)은 SUPERBOARD_TOKEN 시크릿을 읽는 두
// callable 에만 바인딩한다(Secret Manager 2026-09-03 생성). 스테이징은 시크릿이 제거돼 manual 폴백으로 남는다.
const SUPERBOARD_SECRETS = ["SUPERBOARD_TOKEN"];
export const submitTicket = callable(submitTicketHandler, SUPERBOARD_SECRETS);
// listTickets 는 토큰을 쓰지 않지만 Admin 배너·재전달 버튼 게이트(superboardConfigured)가 존재 여부를 읽는다 —
// 바인딩이 없으면 프로드 Admin 이 "자동 전달 꺼짐"으로 오표시되고 재시도 버튼이 숨는다(0.6.55 실측).
export const listTickets = callable(listTicketsHandler, SUPERBOARD_SECRETS);
export const setTicketStatus = callable(setTicketStatusHandler);
export const deleteTicket = callable(deleteTicketHandler);
export const retryTicketSuperboardSync = callable(retryTicketSuperboardSyncHandler, SUPERBOARD_SECRETS);
export const recordLlmUsage = callable(recordLlmUsageHandler);
export const createSeedData = callable(createSeedDataHandler);
export const deleteSeedData = callable(deleteSeedDataHandler);
export const updateAutoReply = callable(updateAutoReplyHandler);
export const upsertTemplate = callable(upsertTemplateHandler);
// createCampaign mints Portal-verified outreach_token_v2 Apply landing links per target once the
// shared key ring + Portal Apply origin are bound (fail-closed placeholder until Portal G011).
export const createCampaign = callable(createCampaignHandler, {
  timeoutSeconds: 540,
  maxInstances: 2,
  concurrency: 2,
  secrets: [
    ...YOUTUBE_API_SECRETS,
    "SCP_OUTREACH_HMAC_KEY_ID",
    "SCP_OUTREACH_HMAC_SECRET",
    "SCP_PORTAL_APPLY_ORIGIN",
    ...PEOPLY_API_SECRETS,
    // triggerScopedCampaignDiscovery→searchYouTubeLive is reachable from here for an ai_drama-scoped
    // campaign, where aiDramaRelevance.ts's relevance gate calls callJev.
    "AI_HUB_LLM_API_KEY",
    "JEV_API_KEY",
  ],
});
export const approveCampaignOutreach = callable(approveCampaignOutreachHandler);
export const updateCampaignControl = callable(updateCampaignControlHandler, PEOPLY_API_SECRETS);
export const listCampaignOutreachApprovalQueue = callable(listCampaignOutreachApprovalQueueHandler, PEOPLY_API_SECRETS);
// triggerScopedCampaignDiscovery→searchYouTubeLive is reachable from here for an ai_drama-scoped
// program (adversarial review 2026-09-27: a pinned test alone is not sound justification to leave
// this path's JEV gate unable to reach JEV — updated tests/campaign-engine-auto-refill-wiring.test.mjs
// alongside this).
export const prepareProgramCampaignTargets = callable(
  prepareProgramCampaignTargetsHandler,
  { timeoutSeconds: 540, secrets: [...YOUTUBE_API_SECRETS, "AI_HUB_LLM_API_KEY", "JEV_API_KEY"] },
);
export const auditCampaignOutreachWave = callable(
  auditCampaignOutreachWaveHandler,
);
export const reconcileCampaignOutreachMailLedgers = callable(
  reconcileCampaignOutreachMailLedgersHandler,
);
export const localizeProgramMailTemplate = callable(
  localizeProgramMailTemplateHandler,
  ["AI_HUB_LLM_API_KEY"],
);
export const updateProgramColdMail = callable(updateProgramColdMailHandler);
export const getEmailMode = callable(getEmailModeHandler);
export const setEmailMode = callable(setEmailModeHandler);

export const createProgram = callable(createProgramHandler, PEOPLY_API_SECRETS);
export const getPublicProgram = callable(
  getPublicProgramHandler,
  PUBLIC_CALLABLE_RUNTIME,
);
export const submitProgramApplication = callable(
  submitProgramApplicationHandler,
  PUBLIC_CALLABLE_RUNTIME,
);
export const reviewProgramApplication = callable(
  reviewProgramApplicationHandler,
  PEOPLY_API_SECRETS,
);
export const syncProgramWorkflow = callable(syncProgramWorkflowHandler, PEOPLY_API_SECRETS);
// SCP PR1 intake ledger — server-side Google Sheet raw adapter. No client Firestore/external access.
export const syncGoogleSheetIntake = callable(syncGoogleSheetIntakeHandler);
// Google Sheet → Firestore dual-run control plane. These operate only on the
// intake ledger/config in the selected runtime database; the legacy live Sheet
// reader remains excluded from hosted staging.
export const getGoogleSheetIntakeStatus = callable(
  getGoogleSheetIntakeStatusHandler,
);
export const reconcileGoogleSheetIntake = callable(
  reconcileGoogleSheetIntakeHandler,
);
export const updateGoogleSheetIntakeCutover = callable(
  updateGoogleSheetIntakeCutoverHandler,
);
// 참가자 명부 전용 dual-read/cutover 엔진. 신규 [참가자] 탭만
// Firestore 투영에 사용하고 기존 [참가자리스트] 탭은 parity 검증에만 사용한다.
export const syncParticipantRoster = callable(
  syncParticipantRosterHandler,
  { timeoutSeconds: 120, maxInstances: 1, concurrency: 1 },
);
export const getParticipantRosterStatus = callable(
  getParticipantRosterStatusHandler,
);
// SCP PR2 YouTube metrics enrichment — server-side YouTube Data API proxy only.
export const syncYouTubeEnrichment = callable(syncYouTubeEnrichmentHandler, [
  ...YOUTUBE_API_SECRETS,
]);
// SCP PR3 automation gate settings — fail-safe human gate toggles for qualification/video review.
// 2026-09-27 scp entitlement gate (assertScpEntitled) needs PEOPLY_API_KEY — see
// listScpApprovedWithoutIngest's comment above.
export const getScpAutomationSettings = callable(
  getScpAutomationSettingsHandler,
  ["PEOPLY_API_KEY"],
);
// FLU-0538 pixel-clone surface 08 (/flu/scp control-tower): read-only snapshot, manager+ gate.
export const getScpAutomationControl = callable(getScpAutomationControlHandler, ["PEOPLY_API_KEY"]);

// FLU-0538 pixel-clone surface 07 (/flu/partners/{id}?tab=performance): read-only settlement snapshot, manager+ gate.
export const getPartnerSettlementSnapshot = callable(getPartnerSettlementSnapshotHandler);

// FLU-0538 pixel-clone surface 09 (/flu/review): read-only review-workspace snapshot, manager+ gate.
export const getReviewWorkspaceSnapshot = callable(getReviewWorkspaceSnapshotHandler);

// FLU-0538 pixel-clone surface 10 (/flu/report/video-performance): read-only report snapshot, manager+ gate.
export const getVideoReportSnapshot = callable(getVideoReportSnapshotHandler);

// FLU-0538 pixel-clone surface 05 (/flu/partners/{id} 개요): read-only partner-detail snapshot, manager+ gate.
export const getPartnerDetailSnapshot = callable(getPartnerDetailSnapshotHandler);

// FLU-0538 pixel-clone surface 06 (/flu/influencers/{id} Journey): read-only management-detail snapshot, manager+ gate.
export const getManagementDetailSnapshot = callable(getManagementDetailSnapshotHandler);
// 2026-09-27 scp entitlement gate (assertScpEntitled) needs PEOPLY_API_KEY — see
// listScpApprovedWithoutIngest's comment above.
export const updateScpAutomationSettings = callable(
  updateScpAutomationSettingsHandler,
  ["PEOPLY_API_KEY"],
);
// SCP lifecycle flow config — program-level step order/visibility/labels/gate pins.
// Reads never create docs; update is transactional with expectedVersion + audit row.
export const getScpLifecycleFlowConfig = callable(
  getScpLifecycleFlowConfigHandler,
);
// 2026-09-27 scp entitlement gate (assertScpEntitled) needs PEOPLY_API_KEY — see
// listScpApprovedWithoutIngest's comment above. getScpLifecycleFlowConfig above stays
// unbound/ungated (also read by the general-purpose Influencer detail page).
export const updateScpLifecycleFlowConfig = callable(
  updateScpLifecycleFlowConfigHandler,
  ["PEOPLY_API_KEY"],
);
export const previewScpLifecycleFlowConfig = callable(
  previewScpLifecycleFlowConfigHandler,
  ["PEOPLY_API_KEY"],
);
// SCP PR4 Judge A qualification recommendation — callModel-only, cached, human-gated finalization.
// 언어/억양 게이트(멀티모달 오디오 억양 분석 + 채널 업로드 조회): YOUTUBE_API_KEY(채널·업로드 목록) + AI_HUB_LLM_API_KEY(usage 리포팅) 바인딩.
// 지원자당 영상 3~6개를 직렬 멀티모달 분석하므로 기본 60s로는 부족 → 타임아웃 540s·메모리 1GiB. (대량 배치는 호출측에서 청크 분할 권장.)
export const judgeQualification = callable(judgeQualificationHandler, {
  secrets: [...YOUTUBE_API_SECRETS, "AI_HUB_LLM_API_KEY"],
  timeoutSeconds: 540,
  memory: "1GiB",
  maxInstances: 5,
});
// Periodic qualification scheduler. Judge A re-reads authoritative automation settings:
// default/human/required configurations produce recommendations only, while an explicitly
// enabled auto_ai + gate:off stage with a valid qualification backtest may finalize and use
// the existing idempotent downstream engines. Same secrets as judgeQualification (language
// gate needs YOUTUBE_API_KEY; usage needs AI_HUB_LLM_API_KEY).
// 2026-09-27 codex adversarial review round 2 sweep: gated by assertScpEntitled — also needs
// PEOPLY_API_KEY.
export const processQualificationAutoRecommendation = callable(
  processQualificationAutoRecommendationHandler,
  {
    secrets: [...YOUTUBE_API_SECRETS, "AI_HUB_LLM_API_KEY", "PEOPLY_API_KEY"],
    timeoutSeconds: 540,
    memory: "1GiB",
    maxInstances: 1,
  },
);
// Cost-opt 2026-09: 캐던스(매 1분)는 손대지 않는다 — tests/qualification-auto-recommend.test.mjs
// 의 "qualification schedule polls canonical Sheet2 every minute" 계약 테스트가 이 값을 명시적으로
// 고정한다(Judge A 근실시간 신규 지원자 판정이 목적). 실측상 거의 모든 회차가 noOp(candidateCount:0)
// 이라 로그만 게이팅해 Cloud Logging 볼륨을 줄인다(동작/리턴값은 불변, 캐던스·기능 무변경).
export const processQualificationAutoRecommendationSchedule = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 0,
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: [...YOUTUBE_API_SECRETS, "AI_HUB_LLM_API_KEY"],
  },
  async () => {
    const result = await processCanonicalSheet2QualificationAutoRecommendationHandler();
    // Cost-opt 2026-09: noOp 회차(사실상 전부)는 로그를 찍지 않는다 — 실제 활동이 있을 때만 남겨
    // Cloud Logging 볼륨을 줄인다(동작/리턴값은 그대로, 로그만 게이팅).
    if (!result.noOp) {
      console.log(
        "[qualification-auto-recommendation] schedule run",
        JSON.stringify(result),
      );
    }
  },
);
// SCP PR5 qualification backtest harness — Sheet2 labels, calibration, and optional emulator ledger.
// 2026-09-27 codex adversarial review round 2 sweep: both gated by assertScpEntitled — need
// PEOPLY_API_KEY.
export const runQualificationBacktest = callable(
  runQualificationBacktestHandler,
  PEOPLY_API_SECRETS,
);
export const writeBackQualificationSheetResults = callable(
  writeBackQualificationSheetResultsHandler,
  { timeoutSeconds: 60, maxInstances: 3, secrets: PEOPLY_API_SECRETS },
);
// SCP Round3 P3 canonical program funnel — full collection scans with field projection; no ordered query/index required.
// W72 [라이브 500 · 2026-08-13]: Memory limit of 512 MiB exceeded (516~519MiB · 00:53 최초, 08:22·08:28 재발).
//   옵션을 아예 안 주고 있어서 **기본 512MiB** 였다. 데이터 성장(발송·후보 누적)이 한도를 넘었다.
//   ⚠️ 1GiB 는 **시간을 버는 조치**다 — 상주 메모리가 데이터 크기에 비례하는 구조라
//      데이터가 계속 크면 언젠가 다시 넘는다. 근본 수리(스트리밍 집계)는 64차 백로그.
export const aggregateScpProgramFunnel = callable(
  aggregateScpProgramFunnelHandler,
  { memory: "1GiB", timeoutSeconds: 60, maxInstances: 3 },
);
// G003 operational snapshots — aggregate-only snapshot read/rebuild with RBAC, dryRun default, audit, and idempotency.
export const getOperationalSnapshot = callable(getOperationalSnapshotHandler);
export const rebuildOperationalSnapshot = callable(rebuildOperationalSnapshotHandler);
// W86-A: 접속 시 갱신 트리거. 읽기와 같은 RBAC(viewer 포함)이라 viewer 만 접속한 시간대에도
//   갱신이 돈다. 재구축이 최대 ~35초라 콜러블 기본 타임아웃(60s)으로는 얇아 여유를 준다.
//   maxInstances 는 리스가 이미 single-flight 를 보장하므로 폭주 방지용 상한일 뿐이다.
export const ensureOperationalSnapshotFresh = callable(
  ensureOperationalSnapshotFreshHandler,
  { timeoutSeconds: 300, memory: "512MiB", maxInstances: 3 },
);
// Full lifecycle source projection exceeded the shared 512 MiB budget in production.
// Keep concurrent projections on separate instances so their working sets do not overlap.
// 2026-09-27 scp entitlement gate (assertScpEntitled) needs PEOPLY_API_KEY — see
// listScpApprovedWithoutIngest's comment above.
export const listScpQualificationQueue = callable(
  listScpQualificationQueueHandler,
  { memory: "1GiB", concurrency: 1, secrets: ["PEOPLY_API_KEY"] },
);
// W90: 키워드 코퍼스 읽기 전용 조회(어드민 가시성). 쓰기·모델 호출 없음.
export const getCampaignKeywordCorpus = callable(getCampaignKeywordCorpusHandler);
// W86-A [SWR 전환]: 이 스케줄은 더 이상 **1차 갱신자가 아니다.**
//   종전 30분 주기는 아무도 안 보는 시간에도 하루 48회를 무조건 태웠다(게이트 없는 유일한 폴링).
//   이제 화면이 stale 문서를 관측하면 ensureOperationalSnapshotFresh 로 그 자리에서 갱신하므로,
//   여기 남는 역할은 셋뿐이다:
//     ① 배포 직후 첫 물질화(아무도 아직 안 봤을 때)
//     ② 읽기 경로가 서비스하지 않는 manager scope 문서 유지(읽기는 global 만 본다)
//     ③ 트리거 경로가 망가졌을 때의 바닥(floor)
//   그래서 **안전망 저주기 6시간**으로 내린다. retryCount 는 그대로 1 — 실패 1회를 같은 주기
//   안에서 흡수한다는 W85 원칙은 주기가 길어질수록 오히려 더 중요하다(1회 실패 = 12시간 공백).
//   ⚠️ 주기·STALE_MS·프론트 사다리는 여전히 맞물린 값이다. 다만 SWR 에서 **부등호가 뒤집혔다**:
//      종전 `STALE_MS ≥ 2×주기` → 현재 `STALE_MS < 주기`. 관계식 pin 은
//      tests/operational-snapshot-callable.test.mjs "W86-A" 가 지킨다.
export const refreshOperationalSnapshotsSchedule = onSchedule(
  {
    schedule: "every 360 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 1,
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async () => {
    const result = await refreshOperationalSnapshotsSweep();
    console.log("[operational-snapshot] schedule run", JSON.stringify(result));
  },
);
export const reconcileProgramRegistry = callable(reconcileProgramRegistryHandler);
// Legacy submission_review_counts aliases are repaired only through this bounded,
// resumable engine. The handler defaults to dry-run and requires a second stable
// verification pass plus aggregate CAS before any canonical replacement.
// 2026-09-27 codex adversarial review round 5 FAIL-2: calls assertScpEntitled — needs
// PEOPLY_API_KEY to resolve the caller's org (missing this let an org-entitled admin be denied
// in deployment even though the round-4 test fixture bypassed it via super_admin).
export const reconcileSubmissionReviewCounts = callable(
  reconcileSubmissionReviewCountsHandler,
  { secrets: ["PEOPLY_API_KEY"], timeoutSeconds: 120, maxInstances: 1, concurrency: 1 },
);
// Existing Direct/ambiguous conversation repair is page-bounded and capability
// gated. Preview and apply always run through the attribution engine; staging
// keeps this maintenance mutation denied until the named database is proven.
export const reconcileConversationAttribution = callable(
  reconcileConversationAttributionHandler,
  { timeoutSeconds: 120, maxInstances: 1, concurrency: 1 },
);
// 2026-10-03: super_admin-only repair of the INBOUND source + conversation attribution pair behind held
// `sender_not_creator` replies (functions/inboundCreatorAttributionRepair.ts). dryRun default true, preview
// token + hash + explicit confirm to apply, hashed manifest/audit, viewAs rejected. Never enqueues or sends:
// the unchanged backlog gate must re-pass afterwards. Staging keeps this maintenance mutation denied.
export const repairInboundCreatorAttribution = callable(
  repairInboundCreatorAttributionHandler,
  // IMAP_PASSWORD: legacy rows are authenticated by re-reading the exact message from the canonical mailbox.
  { secrets: ["IMAP_PASSWORD"], timeoutSeconds: 120, maxInstances: 1, concurrency: 1 },
);
// SCP PR7 AppsFlyer OneLink manual ledger — API mode remains dormant behind APPSFLYER_ONELINK_API_ENABLED/TOKEN.
export const upsertCreatorLink = callable(upsertCreatorLinkHandler, [
  "APPSFLYER_ONELINK_TOKEN",
]);
// SCP PR8 result mail templates — draft_only by default; approved sends reuse sendEmail safety stack.
// 2026-09-27 scp entitlement gate (assertScpEntitled) needs PEOPLY_API_KEY — see
// listScpApprovedWithoutIngest's comment above.
export const upsertScpMailTemplate = callable(upsertScpMailTemplateHandler, ["PEOPLY_API_KEY"]);
export const deleteScpMailTemplate = callable(deleteScpMailTemplateHandler, ["PEOPLY_API_KEY"]);
// prepareScpResultMail gates its external entry only (assertScpEntitled) — the internal
// SYSTEM_ACTOR/systemRequest/mailRequestFor worker paths mark internalTrustedInvocation:true and
// skip it, but the secret must still be bound for the external, gated path to resolve org.
export const prepareScpResultMail = callable(prepareScpResultMailHandler, [
  "SMTP_PASSWORD",
  "AI_HUB_LLM_API_KEY",
  "BOUNCER_API_KEY",
  "PEOPLY_API_KEY",
]);
// 2026-09-27 scp entitlement gate (assertScpEntitled) needs PEOPLY_API_KEY — see
// listScpApprovedWithoutIngest's comment above.
export const listScpEncouragementCandidates = callable(
  listScpEncouragementCandidatesHandler,
  ["PEOPLY_API_KEY"],
);
export const prepareScpEncouragementMail = callable(
  prepareScpEncouragementMailHandler,
  ["SMTP_PASSWORD", "PEOPLY_API_KEY"],
);
// 2026-09-27 scp entitlement gate (assertScpEntitled) needs PEOPLY_API_KEY on every export in
// this family — see listScpApprovedWithoutIngest's comment above.
export const getVideoSubmissionReminderSettings = callable(
  getVideoSubmissionReminderSettingsHandler,
  ["PEOPLY_API_KEY"],
);
export const updateVideoSubmissionReminderSettings = callable(
  updateVideoSubmissionReminderSettingsHandler,
  ["PEOPLY_API_KEY"],
);
export const listVideoSubmissionReminderTargets = callable(
  listVideoSubmissionReminderTargetsHandler,
  ["PEOPLY_API_KEY"],
);
export const listVideoSubmissionReminderHistory = callable(
  listVideoSubmissionReminderHistoryHandler,
  ["PEOPLY_API_KEY"],
);
export const previewVideoSubmissionReminderMail = callable(
  previewVideoSubmissionReminderMailHandler,
  ["PEOPLY_API_KEY"],
);
export const approveVideoSubmissionReminderMail = callable(
  approveVideoSubmissionReminderMailHandler,
  ["SMTP_PASSWORD", "AI_HUB_LLM_API_KEY", "PEOPLY_API_KEY"],
);
export const updateVideoSubmissionReminderTarget = callable(
  updateVideoSubmissionReminderTargetHandler,
  ["PEOPLY_API_KEY"],
);
export const processVideoSubmissionReminders = callable(
  processVideoSubmissionRemindersHandler,
  {
    secrets: ["SMTP_PASSWORD", "AI_HUB_LLM_API_KEY", "PEOPLY_API_KEY"],
    timeoutSeconds: 300,
    maxInstances: 1,
    concurrency: 1,
  },
);
export const processVideoSubmissionRemindersSchedule = onSchedule(
  {
    // 26-08-28 비용 리포트 item 8: 메일 드레인 레인 1분→3분 완화(예상 절감 ≈$8/월, 지연 ≤2분).
    schedule: "every 3 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 0,
    timeoutSeconds: 300,
    memory: "512MiB",
    secrets: ["SMTP_PASSWORD", "AI_HUB_LLM_API_KEY"],
  },
  async () => {
    const result = await processVideoSubmissionRemindersCore();
    console.log("[scp-video-submission-reminder] schedule run", JSON.stringify(result.counts));
    // Task-100 F-6: 재제출 독려 occurrence 적재 + 기한초과 종결 — 같은 이유로 이 기존 스케줄에
    //   얹는다(새 onSchedule 금지, 핀 42). 실패해도 위 리마인더 결과에는 영향이 없어야 하므로
    //   별도 try/catch(형제 스케줄들의 스테이지 격리와 같은 원칙).
    try {
      const resubmissionResult = await enqueueResubmissionNudgeOccurrences();
      if (resubmissionResult.scanned > 0) {
        console.log(JSON.stringify({ event: "task100_resubmission_nudge.enqueue", ...resubmissionResult }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "task100_resubmission_nudge.enqueue_failed",
        reason: String((error as { message?: unknown } | null)?.message ?? error).slice(0, 300),
      }));
    }
  },
);
// 2026-09-27 codex adversarial review round 2 sweep: gated by assertScpEntitled — also needs
// PEOPLY_API_KEY.
export const sendPendingQualificationRejectionNotifications = callable(
  sendPendingQualificationRejectionNotificationsHandler,
  {
    secrets: ["SMTP_PASSWORD", "AI_HUB_LLM_API_KEY", "PEOPLY_API_KEY"],
    timeoutSeconds: 120,
    maxInstances: 1,
    concurrency: 1,
  },
);
// SCP cold-outreach reply responder + no-response follow-up (cases B/D/F). All mail queuing runs
// through prepareScpResultMail (draft_only + human gate + suppression); no new auto-send path.
// 2026-09-27 codex adversarial review FAIL-4: all three public entries now gated by
// assertScpEntitled (functions/scpOutreach.ts's shared actorFromRequest) — needs PEOPLY_API_KEY.
// scpOutreachFollowupScheduled (the real scheduled worker) never goes through these exports.
export const recordScpColdOutreach = callable(recordScpColdOutreachHandler, ["PEOPLY_API_KEY"]);
export const handleScpInboundReply = callable(handleScpInboundReplyHandler, [
  "SMTP_PASSWORD",
  "AI_HUB_LLM_API_KEY",
  "PEOPLY_API_KEY",
]);
export const runScpOutreachFollowup = callable(runScpOutreachFollowupHandler, [
  "SMTP_PASSWORD",
  "AI_HUB_LLM_API_KEY",
  "PEOPLY_API_KEY",
]);
// SCP 콜드메일 발송 히스토리 (append-only 원장) — list/CSV. append 훅은 발송경로(scpOutreach/campaign worker)에서 호출.
// 2026-09-27 codex adversarial review FAIL-2: now gated by assertScpEntitled (functions/
// scpColdmailHistory.ts) — needs PEOPLY_API_KEY to resolve a non-super_admin caller's org.
export const listScpColdmailHistory = callable(listScpColdmailHistoryHandler, ["PEOPLY_API_KEY"]);
// 2026-09-27 scp entitlement gate (assertScpEntitled) needs PEOPLY_API_KEY — see
// listScpApprovedWithoutIngest's comment above.
export const exportScpColdmailHistoryCsv = callable(
  exportScpColdmailHistoryCsvHandler,
  ["PEOPLY_API_KEY"],
);
export const rebuildScpColdmailHistoryProjections = callable(
  rebuildScpColdmailHistoryProjectionsHandler,
  ["PEOPLY_API_KEY"],
);
// 메일 미리보기 (PR3B) — 실발송과 동일 렌더, 순수(발송/큐/원장 무변경).
export const previewEmailDraft = callable(previewEmailDraftHandler);
// SCP PR9 public video submission surface — token form + signed MP4 upload + first-submit guard.
export const issueSubmissionTask = callable(issueSubmissionTaskHandler);
export const getPublicSubmissionForm = callable(
  getPublicSubmissionFormHandler,
  PUBLIC_CALLABLE_RUNTIME,
);
export const createSubmissionUploadUrl = callable(
  createSubmissionUploadUrlHandler,
  PUBLIC_CALLABLE_RUNTIME,
);
export const submitPublicSubmission = callable(
  submitPublicSubmissionHandler,
  PUBLIC_CALLABLE_RUNTIME,
);
// SCP PR11 Judge B video review recommendation — callModel-only, cached, human-gated.
// 2026-09-27 codex adversarial review round 4 FAIL-2: now calls assertScpEntitled — needs
// PEOPLY_API_KEY to resolve the caller's org.
export const judgeVideoReview = callable(judgeVideoReviewHandler, ["PEOPLY_API_KEY"]);
// SCP W5 video review backtest — Sheet3 labels, before/after few-shot comparison; no auto stamp write.
// 백테스트는 Sheet3 전량 + 미판정분 모델 판정까지 돌므로 기본 60s로는 부족하다.
// 2026-09-27 codex adversarial review round 4 FAIL-2: now calls assertScpEntitled — needs
// PEOPLY_API_KEY.
export const runVideoReviewBacktest = callable(runVideoReviewBacktestHandler, {
  secrets: ["PEOPLY_API_KEY"],
  timeoutSeconds: 540,
  maxInstances: 1,
});
// SCP Round3 P1 video review automation outbox — public submissions enqueue only; scheduler performs AI recommendation generation off the request path.
// 2026-09-27 codex adversarial review round 4 FAIL-2: now calls assertScpEntitled — added
// PEOPLY_API_KEY alongside the existing AI_HUB_LLM_API_KEY.
export const processVideoReviewAutomationOutbox = callable(
  processVideoReviewAutomationOutboxHandler,
  {
    secrets: ["AI_HUB_LLM_API_KEY", "PEOPLY_API_KEY"],
    timeoutSeconds: 540,
    memory: "1GiB",
    maxInstances: 1,
  },
);
export const processVideoReviewAutomationOutboxSchedule = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 0,
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: ["AI_HUB_LLM_API_KEY"],
  },
  async () => {
    const result = await drainVideoReviewAutomationOutboxHandler();
    // Cost-opt 2026-09: 캐던스(1분)는 그대로 둔다 — 사람 게이트 이전 AI 추천 생성이 요청 경로
    // 밖에서 돌아 크리에이터 체감 리뷰 turnaround 에 걸린다. 실측상 거의 모든 회차가 noOp(claimed:0)
    // 이라 로그만 게이팅해 Cloud Logging 볼륨을 줄인다(동작/리턴값은 불변).
    if (!result.noOp) {
      console.log(
        "[video-review-automation-outbox] schedule run",
        JSON.stringify(videoReviewAutomationScheduleLogSummary(result)),
      );
    }
  },
);
// S6(P6) RT-6/A6 — 레거시(outbox 도입 전) 제출물 백필 enqueue. admin 전용, drain 상한
// (10/25) 재사용 — enqueue만 하고 LLM 실행은 하지 않으므로 별도 secrets 불필요(PM-2).
// 2026-09-27 codex adversarial review round 4 sweep: now calls assertScpEntitled — needs
// PEOPLY_API_KEY.
export const backfillVideoReviewAutomationOutbox = callable(
  backfillVideoReviewAutomationOutboxHandler,
  { secrets: ["PEOPLY_API_KEY"], timeoutSeconds: 120, maxInstances: 3 },
);
// RA-8 (R5-I) — migration-only manual re-drain for "processed" ghost jobs (submission
// never actually judged) that neither the fingerprint-changed re-enqueue path nor the
// no-outbox-doc backfill path can reach. Never wired into the recurring cron sweep.
// dryRun defaults true; LLM execution happens later via the normal drain, not here.
// 2026-09-27 codex adversarial review round 4 sweep: now calls assertScpEntitled — needs
// PEOPLY_API_KEY.
export const forceRedrainVideoReviewAutomationOutbox = callable(
  forceRedrainVideoReviewAutomationOutboxHandler,
  { secrets: ["PEOPLY_API_KEY"], timeoutSeconds: 120, maxInstances: 1 },
);
// S6(P6) acceptance (e) — UI가 outbox 상태(queued/processing/processed/no_op/failed/dead_letter)를
// 읽기만 하는 경량 콜러블. LLM 미실행이므로 secrets 불필요.
// 2026-09-27 codex adversarial review round 4 FAIL-2: now calls assertScpEntitled — needs
// PEOPLY_API_KEY.
export const getVideoReviewAutomationOutboxStatus = callable(
  getVideoReviewAutomationOutboxStatusHandler,
  { secrets: ["PEOPLY_API_KEY"], timeoutSeconds: 30, maxInstances: 10 },
);

// M11 settings callable exports
// 2026-09-27 codex adversarial review FAIL-5: both now call callerScpEntitled
// (functions/settings.ts) to strip (getSettings)/reject (updateSettings) the two scp-only
// automation fields for a non-entitled caller — needs PEOPLY_API_KEY to resolve their org.
export const getSettings = callable(getSettingsHandler, ["PEOPLY_API_KEY"]);
export const updateSettings = callable(updateSettingsHandler, ["PEOPLY_API_KEY"]);
export const refreshPolicyCache = callable(refreshPolicyCacheHandler);
export const getMailSafetyStatus = callable(getMailSafetyStatusHandler, [
  "IMAP_PASSWORD",
]);
export const releaseMailSuppression = callable(releaseMailSuppressionHandler);
export const getApiQuotaStatus = callable(getApiQuotaStatusHandler);
// S12(d): AI Hub secret/env 설정 여부(boolean만, 값은 절대 반환 안 함) + 리포팅 실패 상태.
// super_admin 게이트는 핸들러 내부(assertNonGuestAuth). AI_HUB_LLM_API_KEY(존재하는 secret)만 바인딩해
// process.env 존재 여부로 판정한다. AI_HUB_GATEWAY_API_KEY는 Secret Manager에 아직 생성되지 않았고
// (gateway URL 미설정 → vertex.ts가 Vertex ADC로 폴백, 실사용 안 함) 존재하지 않는 secret을 바인딩하면
// 배포가 실패하므로 바인딩하지 않는다 — 핸들러는 미바인딩 시 hasGatewayApiKey:false(정확)로 보고.
export const getAiHubKeyStatus = callable(getAiHubKeyStatusHandler, [
  "AI_HUB_LLM_API_KEY",
]);

// M12 integrations callable exports
export const getIntegrations = callable(getIntegrationsHandler, [
  "SMTP_PASSWORD",
  "IMAP_PASSWORD",
  // Readiness projection only: these server-side bindings expose booleans and
  // never return credential values. Staging strips the canonical SMTP/IMAP
  // pair while retaining the Peoply + OAuth capability bindings.
  "PEOPLY_API_KEY",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "YOUTUBE_OAUTH_CREDENTIAL_ENCRYPTION_KEY",
  "YOUTUBE_POOL_DRAMA_1_OAUTH_CLIENT_ID",
  "YOUTUBE_POOL_DRAMA_1_OAUTH_CLIENT_SECRET",
]);
export const updateIntegration = callable(updateIntegrationHandler);
export const getMailProviderAttestationStatus = callable(
  getMailProviderAttestationStatusHandler,
);
export const attestMailProviderSubject = callable(
  attestMailProviderSubjectHandler,
);
export const revokeMailProviderSubject = callable(
  revokeMailProviderSubjectHandler,
);
// Admin-only, no-send transport preflight. SMTP uses verify/auth only; IMAP
// opens the canonical mailbox read-only and parses at most one bounded message.
export const diagnoseMailTransport = callable(
  diagnoseMailTransportHandler,
  {
    secrets: ["SMTP_PASSWORD", "IMAP_PASSWORD"],
    timeoutSeconds: 30,
    maxInstances: 3,
    concurrency: 3,
  },
);
export const getYouTubeAuthorizationStatus = callable(
  getYouTubeAuthorizationStatusHandler,
  ["YOUTUBE_AUTH_WEBHOOK_SECRET"],
);

// Peoply (사내 인명부) — server-only read client, key never leaves this runtime.
// See functions/peoplyClient.ts for the security posture and functions/peoplyCallables.ts
// for the RBAC + non-throwing PeoplyClientError projection.
export const getPeoplyStatus = callable(getPeoplyStatusHandler, {
  secrets: ["PEOPLY_API_KEY"],
  timeoutSeconds: 20,
  maxInstances: 5,
  concurrency: 5,
});
export const searchPeoplyDirectory = callable(searchPeoplyDirectoryHandler, {
  secrets: ["PEOPLY_API_KEY"],
  timeoutSeconds: 20,
  maxInstances: 5,
  concurrency: 5,
});
export const getPeoplyPerson = callable(getPeoplyPersonHandler, {
  secrets: ["PEOPLY_API_KEY"],
  timeoutSeconds: 20,
  maxInstances: 5,
  concurrency: 5,
});
// peoply-directory-cache (2026-09-29): daily server-only Firestore snapshot of the org/team
// projection request-path lookups need (functions/peoplyDirectoryCache.ts), so a Peoply outage no
// longer breaks login bootstrap/mail routing/casebook scope for a user already synced. This
// callable is the super_admin "지금 동기화" manual refresh for an org change that can't wait for
// the next daily run; the schedule right below it is the daily run itself. Both bind
// PEOPLY_API_KEY because both talk to Peoply directly (unlike the cache-reading request paths,
// which only need it for their own cache-miss live-fallback binding, already in place above).
export const refreshPeoplyDirectoryCache = callable(refreshPeoplyDirectoryCacheHandler, {
  secrets: ["PEOPLY_API_KEY"],
  timeoutSeconds: 300,
  maxInstances: 1,
  concurrency: 1,
});
export const peoplyDirectoryCacheSyncSchedule = onSchedule(
  {
    schedule: "0 4 * * *",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 0,
    timeoutSeconds: 300,
    memory: "256MiB",
    secrets: ["PEOPLY_API_KEY"],
  },
  async () => {
    try {
      const result = await runPeoplyDirectorySync({ source: "scheduled-sync" });
      console.log("[peoply-directory-cache] schedule run", JSON.stringify(result));
    } catch (error) {
      console.error("[peoply-directory-cache] schedule run failed", error);
    }
  },
);

// PLAN-ORG-MAIL-IDENTITY Slice 1 — mail_accounts/settings/mail_routing foundation.
// listMailAccounts/upsertMailAccount/setMailRouting only touch Firestore. resolveMyMailAccount
// resolves the caller's org via Peoply (fail-open to the default account — see
// functions/mailAccounts.ts resolveMailAccountForEmail), so it alone binds PEOPLY_API_KEY.
export const listMailAccounts = callable(listMailAccountsHandler);
export const upsertMailAccount = callable(upsertMailAccountHandler);
export const setMailRouting = callable(setMailRoutingHandler);
export const setMemberMailAccountAccess = callable(setMemberMailAccountAccessHandler);
export const resolveMyMailAccount = callable(resolveMyMailAccountHandler, {
  secrets: ["PEOPLY_API_KEY"],
});
// PLAN-ORG-MAIL-IDENTITY Slice 5 — org chip/notice projection for Chat + the app shell.
// Resolves the caller's org via Peoply (same as resolveMyMailAccount) plus an org name lookup.
// Perf/cost 2026-09-27: NOT wrapped in cacheableRead (see functions/readCache.ts) even though it
// was a top-7d-invocation-count read — adversarial review (codex round 2) confirmed it calls
// resolveMailSenderPolicyForEmail, which resolves the caller's *live* per-user mailbox grant
// (mailAccounts.ts's readExplicitMailAccountIds — deliberately never cached, so an admin revoking
// someone's mailbox access takes effect on their very next call). A whole-response cache here
// would delay that revocation by up to the cache TTL. See functions/readCache.ts's header comment
// for the full exclusion criterion.
export const getMyOrgContext = callable(getMyOrgContextHandler, {
  secrets: ["PEOPLY_API_KEY"],
});
// Tiny per-user preference doc (today: the "메일 연결(선택)" banner dismissal). Firestore-only.
export const setUserPreference = callable(setUserPreferenceHandler);

// Flu/Task-42 — org -> Flu tab preset mapping (settings/org_tab_presets). Both callables touch
// only Firestore directly, but each resolves the caller's verified account-ownership scope
// (resolveAccountOwnershipScopeForRequest in orgTabPresets.ts's resolveVerifiedPresetOwnership —
// getOrgTabPresets unconditionally, setOrgTabPresets for an "admin"-role caller), which requires
// PEOPLY_API_KEY the same as listPrograms/listCandidatePool above (2026-09-23 fix — was
// previously unbound and threw for any caller whose role reached that branch).
// getOrgTabPresets: manager+ read. setOrgTabPresets: admin+ write, audited via makeBehaviorLog
// like setMailRouting.
export const getOrgTabPresets = callable(getOrgTabPresetsHandler, PEOPLY_API_SECRETS);
export const setOrgTabPresets = callable(setOrgTabPresetsHandler, PEOPLY_API_SECRETS);
// Flu/Task-49 — org -> YouTube quota pool mapping (settings/youtube_quota_pools). Both callables
// only touch Firestore (no secret, no external call) — unlike getOrgTabPresets/setOrgTabPresets
// above, these do not resolve account-ownership scope. getYouTubeQuotaPools: admin+ read, returns
// pool ids/orgId mapping only — never a secret name (SEC-P0-009). setYouTubeQuotaPools: admin+
// write (secret **names** only, never a value), audited via makeBehaviorLog.
export const getYouTubeQuotaPools = callable(getYouTubeQuotaPoolsHandler);
export const setYouTubeQuotaPools = callable(setYouTubeQuotaPoolsHandler);
// AI-DRAMA-DISCOVERY-METAPROMPT W6: integrations/captcha_solver config read/write. 이 두 콜러블
// 자체는 Firestore만 만진다(actor 호출은 processDiscoveryQueue 워커가 한다 — 위 secrets 주석
// 참고) — 그래서 여기에는 여전히 APIFY_API_KEY를 바인딩하지 않는다. no secret value ever leaves
// this doc (getCaptchaSolverIntegration returns runtimeSecretBound:boolean only, SEC-P0-009),
// same admin-only grade as getYouTubeQuotaPools/setYouTubeQuotaPools above.
export const getCaptchaSolverIntegration = callable(getCaptchaSolverIntegrationHandler);
export const setCaptchaSolverIntegration = callable(setCaptchaSolverIntegrationHandler);
// Flu/Task-47 — admin-triggered rematch of unregistered personal-account conversations against
// candidate_pool (functions/candidateRematch.ts). Firestore-only (no secret, no external call),
// admin+ RBAC enforced in-handler, audited via makeBehaviorLog — same grade as setOrgTabPresets
// above. Advances one bounded batch synchronously per call; no companion onSchedule (this repo
// pins its exact onSchedule count — see functions/candidateRematch.ts's module docblock).
export const startCandidateRematch = callable(startCandidateRematchHandler);

// AI Drama JEV relevance gate (functions/aiDramaRelevance.ts) — operator cleanup for campaign_
// candidates that were materialized before the gate existed (or under a stale threshold). super_
// admin only, dryRun default true (no writes), confirm-literal required for a real run — same grade
// as migrateCampaignCandidates below. Binds the JEV secrets since it calls callJev per candidate.
export const rejudgeAiDramaCampaignCandidates = callable(
  rejudgeAiDramaCampaignCandidatesHandler,
  { secrets: ["AI_HUB_LLM_API_KEY", "JEV_API_KEY"], timeoutSeconds: 540, maxInstances: 1, concurrency: 1 },
);
// Read-only audit view (viewer+) — the candidates_page "관련도 감사" panel reads this to show
// rejected/held ai_drama candidates and why. Binds PEOPLY_API_SECRETS: its per-campaign
// account-ownership check (resolveAccountOwnershipScopeForRequest) resolves the caller's org via the
// same mailAccounts.ts→Peoply path listCampaignCandidates uses (functions/campaigns.ts) — without
// this secret every non-super_admin call would fail closed (adversarial review, round 2, 2026-09-27).
export const listAiDramaRelevanceAudit = callable(listAiDramaRelevanceAuditHandler, PEOPLY_API_SECRETS);

// Flu/Task-43: listCandidates reads candidate_pool/campaign_candidates (viewer+) and calls the
// YouTube Data API for cache-first meta enrichment (candidate_pool doc's own candidateMeta.
// enrichedAt is the cache — see candidateTable.ts header). sendCandidateColdMail (manager+) never
// contacts SMTP itself — it only runs the shared mailSafetyPolicy.evaluateMailSafety kill-switch/
// suppression gate (same one sendEmail uses) and flips the candidate's own contact-status field;
// see the file header for why real dispatch queuing is deliberately out of this ticket's scope.
// updateCandidateRowState (viewer+) is a narrow favorite/hold toggle on the same document.
// Flu/Task-49 재리뷰 P0: listCandidates가 enrichCandidateMeta 내부에서 selectYoutubeApiKey로 실제
// org -> 풀 라우팅을 소비하므로, growth 폴백 슬롯(FALLBACK_1~3)과 비-growth 풀(드라마 등)의 키가 모두
// process.env에 있어야 한다 — 예전 단일 YOUTUBE_API_KEY 바인딩으로는 drama 풀 키가 항상 비어 있어
// 실제로는 절대 선택되지 못한다(quota_exhausted로 항상 fail-closed). functions-staging은 이 콜러블을
// 특례 분기 없이 기본 sanitizedEndpoint로 시크릿을 통째로 벗기므로(runtime/index.cjs) 스테이징 계약은
// 바뀌지 않는다.
// 0.6.73 Aside 핫픽스 — 프로그램/캠페인 미선택("전체") 스코프에서 근인 확정: enrichCandidateMeta가
// 스테일 행마다 최대 CANDIDATE_ENRICH_BATCH_CAP(5)건을 순차로 개별 조회하고 각 건이
// activityRefresh.ts의 12초 fetch 타임아웃까지 기다릴 수 있어(5 × 12s = 60s) 그 자체로
// DEFAULT_CALLABLE_RUNTIME.timeoutSeconds(60, 위 참조)를 채우고, 그 앞에 Peoply 풀 해석(최대 수초)과
// candidate_pool 조회, hydrateContactStatus/hydrateOutreachStats/hydrateReplyAcceptance의 순차
// CANDIDATE_TABLE_IN_QUERY_LIMIT(30) 배치 조회가 더해진다 — 조직 매핑이 없어 스코프를 좁힐 기본값이
// 없는 caller(대량 "전체" 스캔을 더 자주 타는 조건)에서 플랫폼이 60초에 강제 종료해, 클라이언트는
// 응답도 에러도 못 받고 로딩 스피너·새로고침 버튼 비활성 상태로 멈춘 것처럼 보였다(listCandidates
// 콜러블 완주 로그가 안 잡힘). 핸들러 로직은 그대로 두고(과다 수리 금지), 자체 최악 예산(~64s+)을
// 넘는 여유(120s)만 준다 — 다른 배치성 콜러블(위 timeoutSeconds:120)과 동급.
export const listCandidates = callable(listCandidatesHandler, {
  secrets: [...YOUTUBE_API_SECRETS, ...PEOPLY_API_SECRETS],
  timeoutSeconds: 120,
});
// 2026-09-23 fix: sendCandidateColdMail unconditionally resolves account-ownership scope
// (candidateTable.ts) before writing, same as updateCandidateRowState below — was previously
// unbound.
export const sendCandidateColdMail = callable(sendCandidateColdMailHandler, PEOPLY_API_SECRETS);
export const updateCandidateRowState = callable(updateCandidateRowStateHandler, PEOPLY_API_SECRETS);
// Flu/Task-44: 후보별 독려 주기(cadenceDays) 편집 — manager+, saveScpNudgeSequenceConfig와 같은
// 등급("누가 언제 메일을 받는가"를 바꾸는 축). candidate_pool 문서 자신의 필드 1건 + 스윕측 사본
// 컬렉션(scp_candidate_nudge_cadence_overrides) 문서 1건만 쓴다 — 외부호출·시크릿 없음.
export const setCandidateNudgeCadenceOverride = callable(
  setCandidateNudgeCadenceOverrideHandler,
  PEOPLY_API_SECRETS,
);
// Flu/Task-46: 후보 회신 → 파트너 전환(manager+) + 취소(manager+) + AI Drama 파트너 탭 목록(viewer+).
export const convertCandidateToPartner = callable(convertCandidateToPartnerHandler);
export const revertCandidatePartnerConversion = callable(revertCandidatePartnerConversionHandler);
export const listCandidateReplyPartners = callable(listCandidateReplyPartnersHandler);

// PLAN-ORG-MAIL-IDENTITY Slice 2 — Gmail OAuth for workspace_oauth mail accounts. Each
// callable binds only the secret(s) its own code path actually reads (functions/mailOAuth.ts):
// beginMailOAuth builds the consent URL (GOOGLE_OAUTH_CLIENT_ID) and HMAC-signs the state
// param (the production YOUTUBE_OAUTH_CREDENTIAL_ENCRYPTION_KEY; hosted staging swaps in its
// dedicated FLU_STAGING_MAIL_OAUTH_ENCRYPTION_KEY through the staging facade). revokeMailOAuth
// only needs the encryption key to decrypt the token it best-effort-revokes; Google's revoke
// endpoint takes no client credential. getMailOAuthStatus is a Firestore projection by default,
// but its optional verifyConnection path force-refreshes the caller's own personal credential and
// therefore binds the same OAuth client/encryption secrets as the callback.
// Flu/Task-49: also binds the drama pool's OAuth client id/secret — beginMailOAuth resolves
// orgId -> pool (functions/youtubeQuotaPools.ts) and reads whichever name applies; growth keeps
// reading GOOGLE_OAUTH_CLIENT_ID unchanged.
export const beginMailOAuth = callable(beginMailOAuthHandler, {
  secrets: [
    "PEOPLY_API_KEY",
    "GOOGLE_OAUTH_CLIENT_ID",
    "YOUTUBE_OAUTH_CREDENTIAL_ENCRYPTION_KEY",
    "YOUTUBE_POOL_DRAMA_1_OAUTH_CLIENT_ID",
  ],
});
export const revokeMailOAuth = callable(revokeMailOAuthHandler, {
  secrets: ["YOUTUBE_OAUTH_CREDENTIAL_ENCRYPTION_KEY"],
});
export const getMailOAuthStatus = callable(getMailOAuthStatusHandler, {
  secrets: [
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "YOUTUBE_OAUTH_CREDENTIAL_ENCRYPTION_KEY",
    "YOUTUBE_POOL_DRAMA_1_OAUTH_CLIENT_ID",
    "YOUTUBE_POOL_DRAMA_1_OAUTH_CLIENT_SECRET",
  ],
});

// Browser-facing OAuth redirect target (Google redirects the user's own browser here after
// consent) — invoker:"public" like mailOpenPixel above, not the server-to-server x-scp HMAC
// pattern used by scpYoutubeOAuthHandoff below. The staging facade exports this endpoint under
// stagingMailOAuthCallback through its explicit reviewed HTTP surface; all other onRequest
// production endpoints remain absent from staging.
export const mailOAuthCallback = onRequest(
  {
    invoker: "public",
    maxInstances: 5,
    timeoutSeconds: 30,
    memory: "256MiB",
    // Flu/Task-49: drama pool's client id/secret bound alongside growth's — handleMailOAuthCallback
    // resolves which pair to read from the linked account's orgId (functions/youtubeQuotaPools.ts).
    secrets: [
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "YOUTUBE_OAUTH_CREDENTIAL_ENCRYPTION_KEY",
      "YOUTUBE_POOL_DRAMA_1_OAUTH_CLIENT_ID",
      "YOUTUBE_POOL_DRAMA_1_OAUTH_CLIENT_SECRET",
    ],
  },
  (request, response) => handleMailOAuthCallback(request, response),
);

// The OAuth/login flow is owned by the external authorization tool. Flu only
// receives signed status events and never accepts or stores OAuth credentials.
// This unrelated webhook remains absent from the staging facade.
export const youtubeAuthorizationWebhook = onRequest(
  {
    invoker: "public",
    maxInstances: 3,
    timeoutSeconds: 30,
    memory: "256MiB",
    secrets: ["YOUTUBE_AUTH_WEBHOOK_SECRET"],
  },
  async (request, response) => {
    response.set("Cache-Control", "no-store");
    response.set("Content-Type", "application/json; charset=utf-8");
    if (request.method !== "POST") {
      response.status(405).set("Allow", "POST").send({ ok: false, code: "method_not_allowed" });
      return;
    }

    const rawBody = Buffer.isBuffer(request.rawBody)
      ? request.rawBody.toString("utf8")
      : "";
    const timestamp = request.get("x-flu-auth-timestamp") ?? "";
    const signature = request.get("x-flu-auth-signature") ?? "";
    try {
      const result = await ingestSignedYouTubeAuthorizationWebhook({
        rawBody,
        timestamp,
        signature,
      });
      response.status(200).send({
        ok: true,
        idempotent: result.idempotent,
        connection: result.connection,
      });
    } catch (error) {
      const code = asRecord(error).code;
      const status = code === "permission-denied"
        ? 401
        : code === "invalid-argument"
          ? 400
          : code === "already-exists"
            ? 409
            : 503;
      response.status(status).send({
        ok: false,
        code: status === 401
          ? "invalid_signature"
          : status === 400
            ? "invalid_event"
            : status === 409
              ? "event_conflict"
              : "temporarily_unavailable",
      });
    }
  },
);

// Portal-only durable OAuth handoff. Authentication is the versioned x-scp
// HMAC contract; browser/Firebase/Google bearer credentials are never accepted.
export const scpYoutubeOAuthHandoff = onRequest(
  {
    invoker: "public",
    maxInstances: 3,
    concurrency: 20,
    timeoutSeconds: 30,
    memory: "256MiB",
    serviceAccount: "scp-youtube-oauth-handoff@influchat-77db6.iam.gserviceaccount.com",
    secrets: [
      "SCP_FLU_OAUTH_HANDOFF_SECRET",
      "SCP_FLU_OAUTH_HANDOFF_SECRET_PREVIOUS",
      "YOUTUBE_OAUTH_CREDENTIAL_ENCRYPTION_KEY",
    ],
  },
  async (request, response) => {
    response.set("Cache-Control", "no-store");
    response.set("X-Content-Type-Options", "nosniff");
    if (request.method !== "POST") {
      response.status(405).set("Allow", "POST").send({ ok: false, code: "method_not_allowed" });
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.get("content-type") ?? "")) {
      response.status(415).send({ ok: false, code: "unsupported_media_type" });
      return;
    }
    const rawBody = Buffer.isBuffer(request.rawBody)
      ? request.rawBody.toString("utf8")
      : "";
    if (Buffer.byteLength(rawBody, "utf8") > 64 * 1024) {
      response.status(413).send({ ok: false, code: "payload_too_large" });
      return;
    }
    const forwardedProtocol = (request.get("x-forwarded-proto") ?? "").split(",", 1)[0]?.trim().toLowerCase();
    const emulatorHttpsException = process.env.FUNCTIONS_EMULATOR === "true"
      && /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(request.get("host") ?? "");
    try {
      await ingestYouTubeOAuthHandoff({
        rawBody,
        timestamp: request.get("x-scp-timestamp") ?? "",
        handoffIdHeader: request.get("x-scp-idempotency-key") ?? "",
        contractVersionHeader: request.get("x-scp-contract-version") ?? "",
        signature: request.get("x-scp-signature") ?? "",
        isHttps: request.secure || request.protocol === "https" || forwardedProtocol === "https" || emulatorHttpsException,
      });
      response.status(204).send();
    } catch (error) {
      const code = asRecord(error).code;
      const status = code === "invalid_signature"
        ? 401
        : code === "rate_limited"
          ? 429
          : code === "handoff_conflict" || code === "mapping_conflict"
            ? 409
            : code === "mapping_unavailable"
              ? 422
            : code === "encryption_unavailable"
              ? 503
              : code === "https_required"
                ? 403
                : typeof code === "string" && [
                    "idempotency_mismatch",
                    "invalid_payload",
                    "unsupported_contract",
                  ].includes(code)
                  ? 400
                  : 503;
      response.status(status).send({
        ok: false,
        code: typeof code === "string" && /^[a-z][a-z0-9_]{2,79}$/.test(code)
          ? code
          : "temporarily_unavailable",
      });
    }
  },
);

// Authenticated convergence probe for an ambiguous Portal handoff. The only
// observable state is committed vs missing; no credential or mapping data is returned.
export const scpYoutubeOAuthHandoffStatus = onRequest(
  {
    invoker: "public",
    maxInstances: 3,
    concurrency: 20,
    timeoutSeconds: 15,
    memory: "256MiB",
    serviceAccount: "scp-youtube-oauth-handoff@influchat-77db6.iam.gserviceaccount.com",
    secrets: [
      "SCP_FLU_OAUTH_HANDOFF_SECRET",
      "SCP_FLU_OAUTH_HANDOFF_SECRET_PREVIOUS",
    ],
  },
  async (request, response) => {
    response.set("Cache-Control", "private, no-store, max-age=0");
    response.set("X-Content-Type-Options", "nosniff");
    if (request.method !== "POST") {
      response.status(405).set("Allow", "POST").send({ ok: false, code: "method_not_allowed" });
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.get("content-type") ?? "")) {
      response.status(415).send({ ok: false, code: "unsupported_media_type" });
      return;
    }
    const rawBody = Buffer.isBuffer(request.rawBody)
      ? request.rawBody.toString("utf8")
      : "";
    if (Buffer.byteLength(rawBody, "utf8") > 64 * 1024) {
      response.status(413).send({ ok: false, code: "payload_too_large" });
      return;
    }
    const forwardedProtocol = (request.get("x-forwarded-proto") ?? "").split(",", 1)[0]?.trim().toLowerCase();
    const emulatorHttpsException = process.env.FUNCTIONS_EMULATOR === "true"
      && /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(request.get("host") ?? "");
    try {
      const result = await queryYouTubeOAuthHandoffStatus({
        rawBody,
        timestamp: request.get("x-scp-timestamp") ?? "",
        handoffIdHeader: request.get("x-scp-idempotency-key") ?? "",
        contractVersionHeader: request.get("x-scp-contract-version") ?? "",
        signature: request.get("x-scp-signature") ?? "",
        isHttps: request.secure || request.protocol === "https" || forwardedProtocol === "https" || emulatorHttpsException,
      });
      response.status(result.status === "committed" ? 200 : 404).send(result);
    } catch (error) {
      const code = asRecord(error).code;
      const status = code === "invalid_signature"
        ? 401
        : code === "rate_limited"
          ? 429
          : code === "https_required"
            ? 403
            : typeof code === "string" && [
                "idempotency_mismatch",
                "invalid_payload",
                "unsupported_contract",
              ].includes(code)
              ? 400
              : 503;
      response.status(status).send({
        ok: false,
        code: typeof code === "string" && /^[a-z][a-z0-9_]{2,79}$/.test(code)
          ? code
          : "temporarily_unavailable",
      });
    }
  },
);

// Portal -> Flu server-to-server ingress 공통 파서/상태 매핑.
// 브라우저/Firebase/Google bearer 또는 Cookie 가 붙은 호출은 서비스 채널이 아니다.
function portalIngressRequestEnvelope(request: {
  method: string;
  secure: boolean;
  protocol: string;
  rawBody?: Buffer | string;
  get(name: string): string | undefined;
}): {
  ok: boolean;
  status?: number;
  code?: string;
  rawBody: string;
  headers: {
    timestamp: string;
    idempotencyKeyHeader: string;
    contractVersionHeader: string;
    signature: string;
    isHttps: boolean;
    hasBearerOrCookie: boolean;
  };
} {
  const empty = {
    timestamp: "",
    idempotencyKeyHeader: "",
    contractVersionHeader: "",
    signature: "",
    isHttps: false,
    hasBearerOrCookie: false,
  };
  if (request.method !== "POST") return { ok: false, status: 405, code: "method_not_allowed", rawBody: "", headers: empty };
  if (!/^application\/json(?:\s*;|$)/i.test(request.get("content-type") ?? "")) {
    return { ok: false, status: 415, code: "unsupported_media_type", rawBody: "", headers: empty };
  }
  const rawBody = Buffer.isBuffer(request.rawBody) ? request.rawBody.toString("utf8") : "";
  if (Buffer.byteLength(rawBody, "utf8") > 64 * 1024) {
    return { ok: false, status: 413, code: "payload_too_large", rawBody: "", headers: empty };
  }
  const forwardedProtocol = (request.get("x-forwarded-proto") ?? "").split(",", 1)[0]?.trim().toLowerCase();
  const emulatorHttpsException = process.env.FUNCTIONS_EMULATOR === "true"
    && /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(request.get("host") ?? "");
  return {
    ok: true,
    rawBody,
    headers: {
      timestamp: request.get("x-scp-timestamp") ?? "",
      idempotencyKeyHeader: request.get("x-scp-idempotency-key") ?? "",
      contractVersionHeader: request.get("x-scp-contract-version") ?? "",
      signature: request.get("x-scp-signature") ?? "",
      isHttps: request.secure || request.protocol === "https" || forwardedProtocol === "https" || emulatorHttpsException,
      hasBearerOrCookie: Boolean(request.get("authorization") || request.get("cookie")),
    },
  };
}

function portalIngressErrorStatus(code: unknown): number {
  if (code === "invalid_signature" || code === "service_auth_required") return 401;
  if (code === "https_required") return 403;
  if (code === "rate_limited") return 429;
  if (typeof code === "string" && [
    "command_conflict",
    "intake_conflict",
    "guide_conflict",
    "observation_conflict",
    "stale_source_revision",
    "stale_source_update",
    "submission_not_found",
  ].includes(code)) return 409;
  if (typeof code === "string" && [
    "idempotency_mismatch",
    "invalid_payload",
    "material_source_mismatch",
    "unsupported_contract",
    "unknown_reason_code",
  ].includes(code)) return 400;
  return 503;
}

function portalIngressErrorBody(code: unknown): { ok: false; code: string } {
  return {
    ok: false,
    code: typeof code === "string" && /^[a-z][a-z0-9_]{2,79}$/.test(code) ? code : "temporarily_unavailable",
  };
}

function portalIngressEmulatorSecretPair(
  currentEnv: string,
  previousEnv: string,
  fallbackSecret: string,
): { secret?: string; previousSecret?: string } {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
  if (process.env.FUNCTIONS_EMULATOR !== "true" || projectId !== "demo-flu") return {};
  return {
    secret: process.env[currentEnv] || fallbackSecret,
    previousSecret: process.env[previousEnv] || "",
  };
}

// Portal 영상 인테이크 수신기 (Portal 핀 계약 scp.flu.video-intake.v1) —
// 얇은 wire 를 권위 매핑 해석과 함께 영상검수 ingest 엔진 봉투로 변환한다.
// UID kind 미결정 동안 모든 인테이크는 human_required 로 fail-closed 수용·감사된다.
export const scpFluVideoIntake = onRequest(
  {
    invoker: "public",
    maxInstances: 3,
    concurrency: 20,
    timeoutSeconds: 30,
    memory: "256MiB",
    secrets: ["SCP_FLU_VIDEO_INTAKE_SECRET", "SCP_FLU_VIDEO_INTAKE_SECRET_PREVIOUS"],
  },
  async (request, response) => {
    response.set("Cache-Control", "private, no-store, max-age=0");
    response.set("X-Content-Type-Options", "nosniff");
    const envelope = portalIngressRequestEnvelope(request);
    if (!envelope.ok) {
      if (envelope.status === 405) response.set("Allow", "POST");
      response.status(envelope.status ?? 400).send({ ok: false, code: envelope.code });
      return;
    }
    try {
      const result = await ingestScpFluVideoIntake({
        rawBody: envelope.rawBody,
        ...envelope.headers,
        ...portalIngressEmulatorSecretPair(
          SCP_FLU_VIDEO_INTAKE_SECRET_ENV,
          SCP_FLU_VIDEO_INTAKE_PREVIOUS_SECRET_ENV,
          "flu-video-intake-e2e-secret-0123456789abcdef",
        ),
      });
      // Portal 은 상태코드만 소비한다(2xx/409 accepted) — 본문은 안전 상태 최소만.
      response.status(result.duplicate ? 200 : 201).send({
        ok: true,
        duplicate: result.duplicate,
        state: result.state,
      });
    } catch (error) {
      const code = asRecord(error).code;
      response.status(portalIngressErrorStatus(code)).send(portalIngressErrorBody(code));
    }
  },
);

// Portal application-command 수신기 (Portal 핀 계약 scp.flu.application-command.v1) —
// 명령 본문에는 전달 상세가 없고, Flu 가 별도 HMAC 채널로 보호 전달자료를 회수한다.
// 메일 outbox/전달/재시도/감사는 Flu 소유이며 transport 는 바인딩 전까지 fail-closed.
export const scpFluApplicationCommand = onRequest(
  {
    invoker: "public",
    maxInstances: 3,
    concurrency: 20,
    timeoutSeconds: 30,
    memory: "256MiB",
    secrets: ["SCP_FLU_APPLICATION_COMMAND_SECRET", "SCP_FLU_APPLICATION_COMMAND_SECRET_PREVIOUS"],
  },
  async (request, response) => {
    response.set("Cache-Control", "private, no-store, max-age=0");
    response.set("X-Content-Type-Options", "nosniff");
    const envelope = portalIngressRequestEnvelope(request);
    if (!envelope.ok) {
      if (envelope.status === 405) response.set("Allow", "POST");
      response.status(envelope.status ?? 400).send({ ok: false, code: envelope.code });
      return;
    }
    try {
      const result = await ingestScpFluApplicationCommand({
        rawBody: envelope.rawBody,
        ...envelope.headers,
        ...portalIngressEmulatorSecretPair(
          SCP_FLU_APPLICATION_COMMAND_SECRET_ENV,
          SCP_FLU_APPLICATION_COMMAND_PREVIOUS_SECRET_ENV,
          "flu-application-command-e2e-secret-0123456789abcdef",
        ),
      });
      // 계약: 안전한 accepted/queued 상태만 — 전달 상세(수신자/URL/상태 세부)는 절대 없다.
      response.status(result.duplicate ? 200 : 201).send({
        ok: true,
        duplicate: result.duplicate,
      });
    } catch (error) {
      const code = asRecord(error).code;
      response.status(portalIngressErrorStatus(code)).send(portalIngressErrorBody(code));
    }
  },
);

// scp.integration-event.v2 inbound receiver (Portal -> Flu). Versioned adapter over the deployed
// engines; the v1 receivers above stay intact as rollback-compatible compatibility surfaces.
// Portal consumes a hash-bound durable receipt: 201 accepted / 200 duplicate / 400 invalid /
// 401 auth / 409 replay|idempotency|revision|trace conflict. No private delivery detail is returned.
export const scpIntegrationEventV2 = onRequest(
  {
    invoker: "public",
    maxInstances: 3,
    concurrency: 20,
    timeoutSeconds: 30,
    memory: "256MiB",
    // creator.channel-verified 는 검증 채널ID로 YouTube 표시명을 확정한다(핸들은 계약에서
    // 배제돼 있어 이 조회가 이름의 유일한 출처다). 키가 없으면 클라이언트 생성 시점에
    // failed-precondition 이 나서 **신규 채널 전건이 실패**하므로 인그레스에도 배선한다 —
    // 110차에서 새 콜러블이 정확히 이 누락으로 조용히 전건 거절했다.
    secrets: [
      SCP_INTEGRATION_EVENT_V2_SECRET_ENV,
      SCP_INTEGRATION_EVENT_V2_PREVIOUS_SECRET_ENV,
      ...YOUTUBE_API_SECRETS,
    ],
  },
  async (request, response) => {
    response.set("Cache-Control", "private, no-store, max-age=0");
    response.set("X-Content-Type-Options", "nosniff");
    if (request.method !== "POST") {
      response.set("Allow", "POST");
      response.status(405).send({ ok: false, code: "method_not_allowed" });
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.get("content-type") ?? "")) {
      response.status(415).send({ ok: false, code: "unsupported_media_type" });
      return;
    }
    const rawBody = Buffer.isBuffer(request.rawBody) ? request.rawBody.toString("utf8") : "";
    const forwardedProtocol = (request.get("x-forwarded-proto") ?? "").split(",", 1)[0]?.trim().toLowerCase();
    const emulatorHttpsException = process.env.FUNCTIONS_EMULATOR === "true"
      && /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(request.get("host") ?? "");
    try {
      const result = await ingestScpIntegrationEventV2({
        rawBody,
        headers: {
          "x-scp-content-sha256": request.get("x-scp-content-sha256"),
          "x-scp-event-id": request.get("x-scp-event-id"),
          "x-scp-key-id": request.get("x-scp-key-id"),
          "x-scp-signature": request.get("x-scp-signature"),
          "x-scp-timestamp": request.get("x-scp-timestamp"),
        },
        isHttps: request.secure || request.protocol === "https" || forwardedProtocol === "https" || emulatorHttpsException,
        hasBearerOrCookie: Boolean(request.get("authorization") || request.get("cookie")),
      });
      response.status(result.status).send(result.receipt);
    } catch (error) {
      const code = asRecord(error).code;
      response.status(integrationEventV2ErrorStatus(typeof code === "string" ? code : undefined)).send({
        ok: false,
        code: typeof code === "string" && /^[a-z][a-z0-9_]{2,79}$/.test(code) ? code : "temporarily_unavailable",
      });
    }
  },
);

// scp.integration-event.v2 Flu -> Portal signed callback outbox drain. Durable delivery with
// leases, retry/backoff, dead-letter, per-eventId idempotency, and secret rotation. Transport is
// fail-closed until the Portal callback URL secret is bound (contract_only in G013).
export const drainScpIntegrationEventV2Callbacks = onSchedule(
  {
    schedule: INTEGRATION_EVENT_V2_CALLBACK_CYCLE_SCHEDULE,
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    timeoutSeconds: 120,
    // Perf/cost 2026-09-24: prod OOM every ~5min since 09-23 (258-275MiB used vs 256MiB cap) —
    // bump one tier to 512MiB. No logic change.
    memory: "512MiB",
    secrets: [
      SCP_INTEGRATION_EVENT_V2_SECRET_ENV,
      SCP_INTEGRATION_EVENT_V2_PREVIOUS_SECRET_ENV,
      SCP_INTEGRATION_EVENT_V2_CALLBACK_URL_ENV,
    ],
  },
  async () => {
    // Detect Flu review-status transitions on v2-linked submissions and enqueue signed callbacks,
    // then drain the outbox in the same cycle.
    const reviewCallbacks = await reconcileIntegrationEventV2ReviewCallbacks({});
    // W125: 종전에는 emitted>0 일 때만 찍었고 skip 은 사유 없이 숫자만 셌다. 그래서 조인 키가
    // 어긋나 emitted 가 구조적으로 0 이 된 두 달 동안 로그가 통째로 비어 아무도 알아채지 못했다.
    // 매 사이클 무조건, 사유별로 찍는다 — 이 레인의 유일한 관측점이다.
    // `enabled:false` 는 밸브가 닫힌 정상 상태다(settings/scp_integration_event_v2_review_reconcile).
    console.log("[integration-event-v2-callbacks] review-status reconcile", JSON.stringify({
      enabled: reviewCallbacks.enabled,
      scanLimit: reviewCallbacks.scanLimit,
      scanned: reviewCallbacks.scanned,
      emitted: reviewCallbacks.emitted,
      duplicateSuppressed: reviewCallbacks.duplicateSuppressed,
      deadLetterReclaimed: reviewCallbacks.deadLetterReclaimed,
      skipped: reviewCallbacks.skipped,
      emittedByStatus: reviewCallbacks.emittedByStatus,
      skippedByReason: reviewCallbacks.skippedByReason,
      cursorWrapped: reviewCallbacks.cursorWrapped,
    }));
    const snapshotCallbacks = await reconcileIntegrationEventV2ViewSnapshotCallbacks({});
    // 2026-09-27 비용 감사: 이 레인도 이제 회전 커서를 쓴다 — 리뷰 리콘실과 같은 이유로 매 사이클
    // 무조건 찍는다(스캔/스킵/wrap 이 조용히 죽는 것을 관측 부재로 놓치지 않기 위해).
    console.log("[integration-event-v2-callbacks] view-snapshot reconcile", JSON.stringify({
      enabled: snapshotCallbacks.enabled,
      scanLimit: snapshotCallbacks.scanLimit,
      scanned: snapshotCallbacks.scanned,
      emitted: snapshotCallbacks.emitted,
      skipped: snapshotCallbacks.skipped,
      cursorWrapped: snapshotCallbacks.cursorWrapped,
    }));
    const result = await drainIntegrationEventV2Callbacks({ batchLimit: 25 });
    // W125: 조건부 로그는 "아무 일도 안 일어남"과 "레인이 통째로 멈춤"을 구분하지 못한다 —
    // 바로 위 리콘실러가 두 달간 그렇게 조용했다. 배달 결과는 매 사이클 무조건 찍는다.
    console.log("[integration-event-v2-callbacks] drain", JSON.stringify({
      scanned: result.scanned,
      delivered: result.delivered,
      retried: result.retried,
      deadLettered: result.deadLettered,
      skipped: result.skipped,
    }));
    // dead_letter 는 이 레인에서 **영구 유실 후보**다(드레인 due 쿼리가 다시 집지 않는다).
    // 리콘실러가 링크 발신 기록을 지워 재도출하지만 회수 상한이 있으므로 사람이 봐야 한다.
    if (result.deadLettered > 0) {
      console.error("[integration-event-v2-callbacks] ALERT dead_letter", JSON.stringify({
        deadLettered: result.deadLettered,
        runbook: "docs/runbooks/w125-portal-video-review-callbacks.md",
      }));
    }
  },
);

// 콘텐츠 검수 시트(gid 1035597980, "콘텐츠 검수" 탭) 판정 → flu 원장(scp_video_review_state)
// 동기화. 운영자가 시트에서 AL/AM 열을 채워 넣어도 flu 원장은 그 판정을 읽어오지 않아 영원히
// `queued` 로 남고 포털은 "심사 대기"를 계속 보여줬다(2026-08-24 CS 이슈) — 이 레인이 그 간극을
// 메운다. 밸브(settings/scp_sheet_review_sync) 부재 = 닫힘(배포가 백필이 되지 않게).
export const scpSheetReviewSyncSchedule = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async () => {
    const cycle = await runScpSheetReviewSync({});
    // COST-P0-006/LOG-P0-008: id·카운트만 — 크리에이터 이메일/핸들/채널명/사유 원문은 절대 넣지
    // 않는다(SEC-P0-009). enabled:false 는 밸브가 닫힌 정상 상태다.
    console.log("[sheet-review-sync] cycle", JSON.stringify({
      enabled: cycle.enabled,
      scanLimit: cycle.scanLimit,
      scanned: cycle.scanned,
      applied: cycle.applied,
      skipped: cycle.skipped,
      blocked: cycle.blocked,
      failed: cycle.failed,
      blockedByReason: cycle.blockedByReason,
    }));

    // 스테이지 2 (반대 방향): flu 원장 판정 → 시트 되쓰기. 새 onSchedule 을 만들지 않고 같은 15분
    // 주기 안에서 이어 붙인다(불변식 게이트가 onSchedule 선언 개수를 검사한다). 밸브가 독립이라
    // (writebackEnabled) 스테이지 1 이 실패해도 스테이지 2 를 막지 않는다 — try/catch 로 격리한다.
    try {
      const writeback = await runScpSheetReviewWriteback({});
      console.log("[sheet-review-writeback] cycle", JSON.stringify({
        enabled: writeback.enabled,
        scanned: writeback.scanned,
        written: writeback.written,
        skippedSame: writeback.skippedSame,
        conflict: writeback.conflict,
        rowMissing: writeback.rowMissing,
        failed: writeback.failed,
      }));
    } catch (error) {
      console.error("[sheet-review-writeback] cycle_failed", JSON.stringify({
        code: (error as { code?: unknown })?.code ?? "unknown_error",
      }));
    }
  },
);

// scp.video-submission-review.v3 canonical revision receiver (Portal video.revision.submitted/
// withdrawn -> Flu SCP Automation review-state seed + immediate analysis enqueue). Fail-closed until
// the Portal->Flu review-delivery signing secret binds.
export const scpVideoRevisionIntake = onRequest(
  {
    invoker: "public",
    maxInstances: 3,
    concurrency: 20,
    timeoutSeconds: 30,
    memory: "256MiB",
    secrets: [
      SCP_VIDEO_REVIEW_CURRENT_KEY_ID_ENV,
      SCP_VIDEO_REVIEW_CURRENT_KEY_SECRET_ENV,
      SCP_VIDEO_REVIEW_PREVIOUS_KEY_ID_ENV,
      SCP_VIDEO_REVIEW_PREVIOUS_KEY_SECRET_ENV,
    ],
  },
  scpVideoRevisionIngressHandler,
);

// F2 scp.creator-pipeline.v3 inbound receiver (Portal application.intake.recorded -> Flu Manage
// materialization with real signed-token-evidence classification). Fail-closed until keys bind.
export const scpCreatorPipelineV3Intake = onRequest(
  {
    invoker: "public",
    maxInstances: 3,
    concurrency: 20,
    timeoutSeconds: 30,
    memory: "256MiB",
    secrets: [
      SCP_CREATOR_PIPELINE_V3_CURRENT_KEY_ID_ENV,
      SCP_CREATOR_PIPELINE_V3_CURRENT_KEY_SECRET_ENV,
      SCP_CREATOR_PIPELINE_V3_PREVIOUS_KEY_ID_ENV,
      SCP_CREATOR_PIPELINE_V3_PREVIOUS_KEY_SECRET_ENV,
    ],
  },
  scpCreatorPipelineV3IntakeHandler,
);

// scp.video-submission-review.v3 Flu -> Portal signed callback outbox drains (review-status +
// downstream-eligible). Durable delivery: leases, retry/backoff, dead-letter, idempotency, secret
// rotation. Transport fail-closed until Portal base URL + callback secret bind. Downstream delivery
// is the accepted step that flips tracking/settlement eligible.
export const drainScpVideoReviewV3Callbacks = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    timeoutSeconds: 120,
    memory: "256MiB",
    secrets: [
      SCP_VIDEO_REVIEW_CALLBACK_CURRENT_KEY_ID_ENV,
      SCP_VIDEO_REVIEW_CALLBACK_CURRENT_KEY_SECRET_ENV,
      SCP_VIDEO_REVIEW_CALLBACK_PREVIOUS_KEY_ID_ENV,
      SCP_VIDEO_REVIEW_CALLBACK_PREVIOUS_KEY_SECRET_ENV,
      SCP_VIDEO_DOWNSTREAM_CALLBACK_CURRENT_KEY_ID_ENV,
      SCP_VIDEO_DOWNSTREAM_CALLBACK_CURRENT_KEY_SECRET_ENV,
      SCP_VIDEO_DOWNSTREAM_CALLBACK_PREVIOUS_KEY_ID_ENV,
      SCP_VIDEO_DOWNSTREAM_CALLBACK_PREVIOUS_KEY_SECRET_ENV,
    ],
  },
  async () => {
    const review = await drainVideoReviewV3Callbacks({ kind: "review", batchLimit: 25 });
    const downstream = await drainVideoReviewV3Callbacks({ kind: "downstream", batchLimit: 25 });
    if (review.delivered || review.retried || review.deadLettered || downstream.delivered || downstream.retried || downstream.deadLettered) {
      console.log("[video-review-v3-callbacks] drain", JSON.stringify({
        review: { delivered: review.delivered, retried: review.retried, deadLettered: review.deadLettered },
        downstream: { delivered: downstream.delivered, retried: downstream.retried, deadLettered: downstream.deadLettered },
      }));
    }
  },
);

// scp.creator-pipeline.v3 Flu -> Portal signed application.management.acknowledged outbox drain.
// Signs with the INBOUND ring; verifies materialization via the MATERIAL ring before emitting.
// Durable lease/retry/dead-letter; idempotent on managementEventId. Fail-closed + DORMANT-by-omission:
// enqueue skips any application missing the creator-enrollment identities (fluCreatorId/partnerId/
// enrollmentId), so nothing is delivered until that Flu enrollment-identity source lands.
export const drainScpCreatorPipelineV3ManagementAck = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    timeoutSeconds: 120,
    memory: "256MiB",
    secrets: [
      "SCP_CREATOR_PIPELINE_V3_INBOUND_CURRENT_KEY_ID",
      "SCP_CREATOR_PIPELINE_V3_INBOUND_CURRENT_KEY_SECRET",
      "SCP_CREATOR_PIPELINE_V3_INBOUND_PREVIOUS_KEY_ID",
      "SCP_CREATOR_PIPELINE_V3_INBOUND_PREVIOUS_KEY_SECRET",
      "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_ID",
      "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_SECRET",
      "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_ID",
      "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_SECRET",
      // Task-95: applicationEligibilityJudgeSweep 의 구독자 조회용(piggyback, 아래 R25-B와 동일 논리).
      ...YOUTUBE_API_SECRETS,
    ],
  },
  async () => {
    const result = await drainCreatorPipelineV3ManagementAck({ batchLimit: 25 });
    if (result.delivered || result.failed || result.deadLettered) {
      console.log("[creator-pipeline-v3-management-ack] drain", JSON.stringify(result));
    }
    // R25-B: same schedule, same material-signing secrets already bound above — no new scheduler.
    // Fixes the path gap where declared-audience-country projection never runs for the (overwhelming
    // majority of) applications that never make it into the ack outbox above (classification!=="managed"
    // or FLU-DOMAIN GAP fields missing). Never lets a backfill failure affect the drain's own result.
    try {
      const backfill = await backfillDeclaredAudienceCountry();
      if (backfill.processed || backfill.candidates) {
        console.log("[declared-audience-country-backfill] pass", JSON.stringify(backfill));
      }
    } catch (error) {
      console.warn("[declared-audience-country-backfill] pass failed", { errorCode: (error as { code?: string })?.code ?? "unknown" });
    }
    // Task-95: same schedule, same piggyback rationale as R25-B above — no new scheduler (핀 42).
    // "6시간 sweep 은 너무 느림"(TICKET-MAP) 이라 1분 스케줄에 얹는다. 자체 실패는 드레인 결과에
    // 영향을 주지 않는다.
    try {
      const eligibility = await sweepApplicationEligibilityJudge({});
      if (eligibility.judged || eligibility.errors || eligibility.retryScheduled) {
        console.log("[application-eligibility-judge] sweep", JSON.stringify(eligibility));
      }
    } catch (error) {
      console.warn("[application-eligibility-judge] sweep failed", { errorCode: (error as { code?: string })?.code ?? "unknown" });
    }
  },
);

// §3 onboarding provider send drain — managed-gated render/send via prepareScpResultMail reuse;
// fail-closed (no state change) until SMTP provider + Portal delivery-material binding are present.
export const scpOnboardingOutboxSendWorker = onSchedule(
  {
    // 26-08-28 비용 리포트 item 8: 메일 드레인 레인 1분→3분 완화(예상 절감 ≈$8/월, 지연 ≤2분).
    schedule: "every 3 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    concurrency: 1,
    retryCount: 0,
    timeoutSeconds: 120,
    memory: "256MiB",
    // v1 커맨드 계보 지원서의 수신자 자료는 fetchScpPortalDeliveryMaterial 이 커맨드 시크릿으로
    // HMAC 서명해 회수한다. 이 쌍이 없으면 그 경로가 조용히 null(fail-closed)로 떨어져 수신자
    // 없음 → skip, 행은 시도 소모 없이 queued 영구 잔류한다 — 실측: 26-08-26 온보딩 7건이
    // 3시간+ attempts=0. 커맨드 시크릿을 배선한 형제(application-confirmed 계열)와의 비대칭이
    // 근인이라, 같은 리졸버 사다리를 타는 세 워커(onboarding·video-result·uid-guide)에 함께 배선한다.
    secrets: ["SMTP_PASSWORD", "AI_HUB_LLM_API_KEY", "SCP_FLU_APPLICATION_COMMAND_SECRET", "SCP_FLU_APPLICATION_COMMAND_SECRET_PREVIOUS", "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_ID", "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_SECRET", "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_ID", "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_SECRET"],
  },
  async () => {
    await drainOnboardingOutbox({});
  },
);

// §4 video-result creator mail drain (content_approved/changes_requested/rejected). Durable
// lease/retry/dead-letter; fail-closed until SMTP provider + Portal delivery-material binding.
export const scpVideoResultMailWorker = onSchedule(
  {
    // 26-08-28 비용 리포트 item 8: 메일 드레인 레인 1분→3분 완화(예상 절감 ≈$8/월, 지연 ≤2분).
    schedule: "every 3 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    concurrency: 1,
    retryCount: 0,
    timeoutSeconds: 120,
    memory: "256MiB",
    // legacy v1 video-result 행은 컷오버 게이트가 기본 거부하고, 설정 opt-in +
    // 신규 휴먼 전용 조건에서만 연다. 게이트가 v1 material 회수를 허용할 때
    // 서명 검증이 실패하지 않도록 커맨드 시크릿 쌍을 배선한다. 여기서 설정을
    // 활성화하지는 않는다.
    secrets: ["SMTP_PASSWORD", "AI_HUB_LLM_API_KEY", "SCP_FLU_APPLICATION_COMMAND_SECRET", "SCP_FLU_APPLICATION_COMMAND_SECRET_PREVIOUS", "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_ID", "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_SECRET", "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_ID", "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_SECRET"],
  },
  async () => {
    await drainVideoResultMailOutbox({});
  },
);

// TASK 4 UID-guide mail drain (Portal G008 recovery): consumes the durable fail-closed intents in
// scp_integration_event_v2_uid_guide_outbox, retrieves Portal v2 protected material in memory via
// the attested MATERIAL ring, and sends through the shared adapter behind the production-pilot
// fence. Fail-closed at every hop; delivered is terminal per revision.
export const scpUidGuideMailWorker = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    concurrency: 1,
    retryCount: 0,
    timeoutSeconds: 120,
    memory: "256MiB",
    // v1 커맨드 계보 지원서의 수신자 자료는 fetchScpPortalDeliveryMaterial 이 커맨드 시크릿으로
    // HMAC 서명해 회수한다. 이 쌍이 없으면 그 경로가 조용히 null(fail-closed)로 떨어져 수신자
    // 없음 → skip, 행은 시도 소모 없이 queued 영구 잔류한다 — 실측: 26-08-26 온보딩 7건이
    // 3시간+ attempts=0. 커맨드 시크릿을 배선한 형제(application-confirmed 계열)와의 비대칭이
    // 근인이라, 같은 리졸버 사다리를 타는 세 워커(onboarding·video-result·uid-guide)에 함께 배선한다.
    secrets: ["SMTP_PASSWORD", "AI_HUB_LLM_API_KEY", "SCP_FLU_APPLICATION_COMMAND_SECRET", "SCP_FLU_APPLICATION_COMMAND_SECRET_PREVIOUS", "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_ID", "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_SECRET", "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_ID", "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_SECRET"],
  },
  async () => {
    // W124: 결과를 버리지 않는다. 이 워커는 두 달간 매 5분 돌면서 **아무것도 기록하지 않았고**,
    // 그래서 60건 전량 미발송이 로그에서 보이지 않았다. 건수만 싣는다(SEC-P0-009 — 수신자 원문 금지).
    const result = await drainUidGuideOutbox({});
    if (result.scanned || result.delivered || result.retried || result.deadLettered) {
      console.log("[uid-guide-mail] drain", JSON.stringify(result));
    }
  },
);

// Application receipt mail. Current anonymous Portal Apply uses
// scp.flu.application-command.v1; acceptance and outbox creation are atomic.
//
// W91 [헤세 · admin-bridge 승인 메일]: login_approved 드레인은 새 onSchedule 을 만들지 않고 이
// 기존 1분 워커의 **두 번째 단계**로 얹는다(W72-A/R25-B 와 같은 이유 —
// tests/w72-a-nudge-sweep.test.mjs 가 onSchedule 총수를 38로 고정해 새 스케줄을 막는다). material
// 회수가 같은 함수(fetchScpPortalReceiptMailMaterial, SCP_FLU_APPLICATION_COMMAND_SECRET 로 서명)를
// 재사용하므로 secrets 도 이미 전부 바인딩돼 있다 — 새 secret 바인딩이 필요 없다. 한쪽 드레인 실패가
// 다른 쪽을 막지 않도록 격리한다(R25-B 와 동일 패턴).
export const scpApplicationConfirmedMailWorker = onSchedule(
  {
    // 26-08-28 비용 리포트 item 8: 메일 드레인 레인 1분→3분 완화(예상 절감 ≈$8/월, 지연 ≤2분).
    schedule: "every 3 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    concurrency: 1,
    retryCount: 0,
    timeoutSeconds: 120,
    memory: "256MiB",
    secrets: ["SMTP_PASSWORD", "AI_HUB_LLM_API_KEY", "SCP_FLU_APPLICATION_COMMAND_SECRET", "SCP_FLU_APPLICATION_COMMAND_SECRET_PREVIOUS", "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_ID", "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_SECRET", "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_ID", "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_SECRET"],
  },
  async () => {
    await drainApplicationConfirmedMailOutbox({});
    try {
      await drainLoginApprovedMailOutbox({});
    } catch (error) {
      console.warn("[login-approved-mail] drain pass failed", { errorCode: (error as { code?: string })?.code ?? "unknown" });
    }
    // 반려 안내 메일(사유 2종) 드레인 — 같은 이유로 세 번째 단계로 얹는다(새 onSchedule 금지,
    // v1 delivery-material 사다리의 커맨드 시크릿이 이 워커에 이미 배선돼 있다). 실패 격리 동일.
    try {
      const rejected = await drainLoginRejectedMailOutbox({});
      if (rejected.scanned || rejected.delivered || rejected.retried || rejected.deadLettered) {
        console.log("[login-rejected-mail] drain", JSON.stringify(rejected));
      }
    } catch (error) {
      console.warn("[login-rejected-mail] drain pass failed", { errorCode: (error as { code?: string })?.code ?? "unknown" });
    }
  },
);

// Content receipt mail. Both v2 video.submitted and v3
// video.revision.submitted acceptance transactions use the same stable row identity.
// W62c-C2 [두 리뷰 수렴]: 영상 제출 재촉 메일 소비자. 이게 없으면 버튼이 아무도 받지 않는 메일을
// 만든다(적재만 되고 소비 안 됨). 확인 메일 워커와 **같은 주기·같은 게이트**를 쓴다.
export const scpApplicationVideoReminderMailWorker = onSchedule(
  {
    // 26-08-28 비용 리포트 item 8: 메일 드레인 레인 1분→3분 완화(예상 절감 ≈$8/월, 지연 ≤2분).
    schedule: "every 3 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    // W72-A [적대 리뷰 P1]: 레인 일캡은 read → send → increment 라 원자적이지 않다.
    //   maxInstances:1 만으로는 **한 인스턴스 안의 동시 호출**을 막지 못해 캡을 넘길 수 있다.
    //   이 워커는 순차 루프를 전제로 캡을 세므로 동시성을 1 로 못 박는다.
    concurrency: 1,
    retryCount: 0,
    timeoutSeconds: 120,
    memory: "256MiB",
    // W114-F: AI_HUB_LLM_API_KEY 추가 — 코호트1·3 드레인(아래)이 부르는 sendNudgeLiveForSweep 은
    //   scpOutreachFollowupSweep(구 호스트)의 실행 환경에서 이 값을 갖고 있었다(secrets 목록에
    //   있었다). prepareScpResultMail→sendEmail 경로의 실사용은 fail-open(aiHubReport.ts:
    //   `!apiKey → return`, 사용량 리포팅만 no-op)이라 없어도 발송 자체는 막히지 않지만, 호출
    //   시점을 옮기면서 실행 환경만 조용히 좁아지는 것은 피한다 — 형제 워커(scpVideoResultMailWorker
    //   등)도 전부 이 값을 갖고 있다. BOUNCER_API_KEY 는 추가하지 않는다(헤세 결정 2026-08-21 —
    //   독려 대상은 이미 콜드메일 발송 시점에 1차 검증을 통과했고 반송 주소는 mail_suppressions 로
    //   걸러지므로 재검증은 새 정보가 없고, BOUNCER_ABORT_MS 12s 를 더하는 게 처리량 목표와 반대로
    //   간다 — 콜드메일 경로(processCampaignOutreachQueue)의 BOUNCER_API_KEY 바인딩은 그대로 둔다).
    secrets: ["SMTP_PASSWORD", "AI_HUB_LLM_API_KEY", "SCP_FLU_APPLICATION_COMMAND_SECRET", "SCP_FLU_APPLICATION_COMMAND_SECRET_PREVIOUS", "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_ID", "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_SECRET", "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_ID", "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_SECRET",
      // 0.6.110: 프로그램 오버라이드 독려가 캠페인 서명 랜딩 링크를 mint 한다(콜드메일 경로와 같은 키링).
      "SCP_OUTREACH_HMAC_KEY_ID", "SCP_OUTREACH_HMAC_SECRET", "SCP_PORTAL_APPLY_ORIGIN"],
  },
  async () => {
    // [리뷰어 B HIGH] 이 워커의 호출 시작 시각 — 코호트1·3 드레인의 마감(deadlineMs)을 여기서
    //   센다. 코호트2 드레인이 얼마나 걸릴지 모르므로, "코호트2 이후부터 N초"가 아니라 "워커
    //   시작부터 N초"로 재야 timeoutSeconds:120 예산을 실제로 초과하지 않는다.
    const workerStartMs = Date.now();
    await drainApplicationVideoReminderOutbox({});
    // W114-F [적재/발송 분리, 새 onSchedule 없음]: 코호트1·3 은 더 이상 스윕(w72_nudge_cohort_sweep,
    //   scpOutreachFollowupSweep 의 한 단계) 안에서 인라인으로 발송하지 않는다 — 스윕은 큐에
    //   적재만 하고, 이 기존 워커(이미 1분마다 도는 코호트2 드레인)가 코호트2 처리 직후 이어서
    //   코호트1·3 큐를 페이싱하며 비운다. 실패해도 코호트2 드레인 결과에는 영향이 없어야 하므로
    //   별도로 try/catch 한다(한쪽 레인 장애가 다른 레인을 막지 않는다 — scpOutreachFollowupSweep
    //   의 스테이지 격리와 같은 원칙).
    try {
      const drained = await drainNudgeCohort13Outbox({ deadlineMs: workerStartMs + NUDGE_DRAIN_BUDGET_MS });
      if (drained.scanned > 0 || drained.laneCapped > 0 || drained.deadlineStopped) {
        console.log(JSON.stringify({ event: "w114_nudge_cohort13_outbox.drain", ...drained }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "w114_nudge_cohort13_outbox.drain_failed",
        reason: String((error as { message?: unknown } | null)?.message ?? error).slice(0, 300),
      }));
    }
    // Task-100 F-6: 반려 후 재제출 독려 드레인 — 같은 이유로 네 번째 단계로 얹는다(새 onSchedule
    //   금지, 핀 42). 실패 격리는 위 코호트1·3 과 같은 원칙(한쪽 레인 장애가 다른 레인을 막지 않는다).
    try {
      const resubmissionDrained = await drainResubmissionNudgeOutbox({});
      if (resubmissionDrained.scanned > 0) {
        console.log(JSON.stringify({ event: "task100_resubmission_nudge_outbox.drain", ...resubmissionDrained }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "task100_resubmission_nudge_outbox.drain_failed",
        reason: String((error as { message?: unknown } | null)?.message ?? error).slice(0, 300),
      }));
    }
  },
);

export const scpContentSubmittedMailWorker = onSchedule(
  {
    // 26-08-28 비용 리포트 item 8: 메일 드레인 레인 1분→3분 완화(예상 절감 ≈$8/월, 지연 ≤2분).
    schedule: "every 3 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    concurrency: 1,
    retryCount: 0,
    timeoutSeconds: 120,
    memory: "256MiB",
    secrets: ["SMTP_PASSWORD", "AI_HUB_LLM_API_KEY", "SCP_FLU_APPLICATION_COMMAND_SECRET", "SCP_FLU_APPLICATION_COMMAND_SECRET_PREVIOUS", "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_ID", "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_SECRET", "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_ID", "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_SECRET"],
  },
  async () => {
    await drainContentSubmittedMailOutbox({});
  },
);

// §5 analysis-evidence + dormant AI Judge — produces versioned voice_authenticity_risk.v1 +
// language_accent.v1 evidence and routes through the SINGLE canonical transitionVideoReviewDecision
// (actorType ai). autoPilot defaults OFF (human-assist) so the Judge routes to human_review_required;
// the default analyzer is fail-closed (no evidence) until a real Vertex/AI-Hub model chokepoint binds.
export const processVideoReviewAnalysisJudgeSchedule = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 0,
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: ["AI_HUB_LLM_API_KEY"],
  },
  async () => {
    const result = await drainVideoReviewAnalysisJudge();
    if (result.judged) {
      console.log("[video-review-analysis-judge] schedule run", JSON.stringify(videoReviewAnalysisJudgeScheduleLogSummary(result)));
    }
  },
);

// 운영 감사/리포트 — 읽기 전용 콜러블(manager+). PII/UID 원문 없음.
// 2026-09-27 codex adversarial review round 2 sweep: both gated by assertScpEntitled — need
// PEOPLY_API_KEY.
export const getScpPortalSubmissionIngressReport = callable(
  getScpPortalSubmissionIngressReportHandler,
  { timeoutSeconds: 30, maxInstances: 5, secrets: PEOPLY_API_SECRETS },
);
export const getScpFluApplicationCommandReport = callable(
  getScpFluApplicationCommandReportHandler,
  { timeoutSeconds: 30, maxInstances: 5, secrets: PEOPLY_API_SECRETS },
);

// Refresh encrypted YouTube credentials before expiry and project only
// credential-free terminal lifecycle events when Google access is no longer valid.
export const refreshYouTubeOAuthCredentialsSchedule = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    concurrency: 1,
    retryCount: 0,
    timeoutSeconds: 240,
    memory: "256MiB",
    serviceAccount: "scp-youtube-oauth-handoff@influchat-77db6.iam.gserviceaccount.com",
    secrets: [
      "YOUTUBE_OAUTH_CREDENTIAL_ENCRYPTION_KEY",
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
    ],
  },
  async () => {
    await runYouTubeOAuthCredentialRefreshSweep();
  },
);

// R4: Studio 국가 오디언스 수집기. `scp_audience_country_channels` 의 **유일한 생산자**다 —
// 이게 없으면 B2 의 Studio 권위(B)는 영원히 비어 있고 화면은 Apply 신고 국가만 보여준다.
// 승인된 OAuth 경로만 쓴다(같은 서비스 계정 + 같은 암호화 키 시크릿), 외부 호출은 이 서버 안에서만
// 일어나며 토큰 본문은 저장하지 않는다. 28 완결일 창이라 하루 1회로 충분하다.
export const collectAudienceCountryObservationsSchedule = onSchedule(
  {
    schedule: "every day 04:20",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    concurrency: 1,
    retryCount: 0,
    timeoutSeconds: 540,
    memory: "256MiB",
    serviceAccount: "scp-youtube-oauth-handoff@influchat-77db6.iam.gserviceaccount.com",
    secrets: ["YOUTUBE_OAUTH_CREDENTIAL_ENCRYPTION_KEY"],
  },
  async () => {
    const result = await collectAudienceCountryObservations({
      db: adminDb,
      nowIso: new Date().toISOString(),
    });
    console.log("[audience-country-collector]", JSON.stringify(result));
  },
);

// Retry signed lifecycle delivery to Portal. The durable outbox contains only
// mapping IDs and lifecycle status; OAuth credentials never cross this path.
export const deliverYouTubeOAuthLifecycleSchedule = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    concurrency: 1,
    retryCount: 0,
    timeoutSeconds: 120,
    memory: "256MiB",
    serviceAccount: "scp-youtube-oauth-handoff@influchat-77db6.iam.gserviceaccount.com",
    secrets: ["SCP_FLU_OAUTH_LIFECYCLE_SECRET"],
  },
  async () => {
    await runYouTubeOAuthLifecycleDeliverySweep({
      baseUrl: "https://creator.supercent.io",
    });
  },
);

// Read layer — 화면 데이터 단일 조회점(SEC-P0-004: 클라 Firestore 직접 read 금지).
// Perf/cost 2026-09-27: NOT wrapped in cacheableRead (see functions/readCache.ts) despite being
// the highest 7d-invocation-count read callable — its per-key readKey() calls
// datasetAccountOwnershipFilter for "campaigns"/"programs"/"candidatePool" (read.ts's
// ACCOUNT_OWNERSHIP_DATASET_KEYS), which resolves the caller's *live* mailbox/account grant on
// every request. Whole-response caching would delay an access revocation for those keys by up to
// the cache TTL — same exclusion as getMyOrgContext below.
// 2026-09-28 codex adversarial review round 2 (finding: round 3 had bound PEOPLY_API_KEY here for
// a "conversations" scp org-scope check that turned out to be unreachable dead code — conversations
// is a PAGED_DATASET_KEYS entry, see functions/read.ts getDataset — and that binding was removed).
// The secret is still required here for an unrelated, legitimate reason: fix/scp-surface-gate's
// scpMailTemplates/scpMailResults keys now need isCallerScpEntitled (read.ts), which needs
// PEOPLY_API_KEY to resolve a non-super_admin caller's org — only actually called when one of
// those two keys is requested.
export const getDataset = callable(getDatasetHandler, PEOPLY_API_SECRETS);
// 2026-09-27 codex adversarial review round 2 sweep: gated by assertScpEntitled — also needs
// PEOPLY_API_KEY.
export const provisionScpPortalCreatorBinding = callable(
  provisionScpPortalCreatorBindingHandler,
  { maxInstances: 1, concurrency: 1, secrets: PEOPLY_API_SECRETS },
);
// Portal-approved-command authority path (v2 lineage): dry-run/rejection is contract-mandated
// to be zero durable mutation (same as the G008 engine below), so callableRuns/engineSnapshots
// outcome persistence is disabled here too.
export const provisionScpPortalApprovedCreatorBinding = callable(
  provisionScpPortalApprovedCreatorBindingHandler,
  // tier 3 는 지원서 선언 핸들의 **현재 소유 채널**을 YouTube 로 확인한다(운영자·포털 어느 쪽도
  // 위조 못 하는 축). 시크릿이 없으면 그 조회가 실패하고 경로 전체가 fail-closed 로 거부된다 —
  // 실제로 배선 없이 배포해 그렇게 막혔다. 폴백 키는 붙이지 않는다: 이 경로는 운영자가 건별로
  // 부르는 호출이라 쿼터 분산이 필요 없고, 최소 권한이 낫다.
  { maxInstances: 1, concurrency: 1, secrets: ["YOUTUBE_API_KEY"] },
  { persistOutcome: false },
);
// G008 identity-authority engine: zero durable mutation on dry-run/rejection is
// contract-mandated, so callableRuns/engineSnapshots outcome persistence is disabled.
export const provisionScpPortalApplyBinding = callable(
  provisionScpPortalApplyBindingHandler,
  { maxInstances: 1, concurrency: 1 },
  { persistOutcome: false },
);
// 2026-09-27 codex adversarial review round 2: the conversations lane now resolves the caller's
// org via Peoply (functions/conversationMailAccessScope.ts) to enforce the scp per-org gate.
export const getDashboardPipelineProjection = callable(getDashboardPipelineProjectionHandler, PEOPLY_API_SECRETS);
export const getMessageSource = callable(getMessageSourceHandler, {
  secrets: ["PEOPLY_API_KEY"],
});
// Perf/cost 2026-09-27: top-7d-invocation-count read (see functions/readCache.ts). "creators" is
// not in read.ts's ACCOUNT_OWNERSHIP_DATASET_KEYS, so this route's only authorization is the
// static role check (canReadDatasetKey) — no live per-request Firestore/Peoply grant lookup for
// this key, so caching the whole response cannot delay an access revocation. Confirmed via
// read.ts: listCreators -> listTargetableDatasetPage/listDatasetPage's datasetAccountOwnershipFilter
// returns undefined for "creators", and conversationOrgScope/applicationParentFilter are both null
// for this key too.
export const listCreators = callable(cacheableRead("listCreators", READ_CACHE_TTL_MS, listCreatorsHandler));
// Perf/cost 2026-09-27: NOT wrapped in cacheableRead — "campaigns" IS in
// ACCOUNT_OWNERSHIP_DATASET_KEYS, so datasetAccountOwnershipFilter resolves the caller's live
// mailbox/account grant on every request (same exclusion as getDataset above).
export const listCampaigns = callable(listCampaignsHandler, PEOPLY_API_SECRETS);
export const listEscalations = callable(listEscalationsHandler);
export const listVideos = callable(listVideosHandler);
export const listCommunityPosts = callable(listCommunityPostsHandler);
export const listCreatorComments = callable(listCreatorCommentsHandler);
// PLAN-ORG-MAIL-IDENTITY Slice 5: org-scoped for manager/viewer via resolveMailAccountForEmail.
// Perf/cost 2026-09-27: NOT wrapped in cacheableRead (see functions/readCache.ts) despite being a
// top-7d-invocation-count read — its conversationOrgScope resolution (resolveConversationOrgScope
// -> effectiveConversationAuth) resolves the caller's live mailbox grant the same way
// getMyOrgContext does (readExplicitMailAccountIds, deliberately never cached). A cache hit here
// was confirmed by adversarial review (codex round 2) to bypass that per-request check.
export const listConversations = callable(listConversationsHandler, {
  secrets: ["PEOPLY_API_KEY"],
});
// "미답장 인박스" (2026-09-26): scp 사서함 대화 중 사람 답장이 필요한 것만 모은 전용 큐
// (functions/read.ts listUnrepliedInboxHandler).
// 2026-09-27 codex adversarial review round 2: 위 "비밀은 필요 없다" 는 더 이상 사실이 아니다 —
// resolveRequestedMailAccountId -> resolveConversationMailAccessScope(2026-09-27 conversation
// org-filter)가 호출자 org를 Peoply로 해석해 scp per-org 게이트에 쓴다. 미바인딩이면 배포
// 환경에서 정당한 non-super_admin 호출자가 매번 null org로 해석돼 scp 명시 스탬프 행을 전부
// 못 본다(super_admin과 legacy blank-mailAccountId 행은 이 게이트의 영향을 받지 않아 그대로 보임).
export const listUnrepliedInbox = callable(listUnrepliedInboxHandler, PEOPLY_API_SECRETS);
// "미답장 인박스 dismiss 백로그 정리" (2026-09-26, 헤세 결정) — super_admin 전용, dryRun 기본
// true. 헤세가 배포 후 직접 dryRun:false 로 실행한다(functions/dismissNoReplyBacklog.ts 헤더
// 주석 참조) — 이 배포/PR은 이 콜러블을 절대 호출하지 않는다.
export const dismissAgencyAndUnregisteredSenderBacklog = callable(dismissAgencyAndUnregisteredSenderBacklogHandler);
// "inboundMailProvenance 백필" (0.6.96 item 2, 2026-09-26 헤세 결정) — super_admin 전용, dryRun
// 기본 true. 0.6.95 이전 scp 백로그 대화는 이 필드가 없어 dismissAgencyAndUnregisteredSenderBacklog
// 가드에 걸려 스킵된다(functions/dismissNoReplyBacklog.ts 헤더 주석 참조). 헤세가 배포 후 직접
// dryRun:false 로 실행한다 — 이 배포/PR은 이 콜러블을 절대 호출하지 않는다.
export const backfillInboundMailProvenance = callable(backfillInboundMailProvenanceHandler);
// 0.6.109: re-enqueue the EXISTING approval result mail (content_approved) for canonically approved videos
// whose approval was applied with notifyCreator:false (sheet sync) and so never got the mail. Same shared
// outbox-row builder as transitionVideoReviewDecision; rendering/safety/suppression/quota/audit/send stay in
// the existing drainer. super_admin only, viewAs rejected, dryRun default true, 1..25 submissionIds,
// idempotent per (submission, approval ledger seq). Handler passed by its declared name for callable()'s
// viewAs guard / audit log.
// Secrets: exactly the recipient-resolution secrets scpVideoResultMailWorker binds (command secret pair + Portal
// material key ring), so the legacy Portal delivery-material fetch does not fail delivery_material_unconfigured.
// SMTP/AI Hub secrets are not needed (this callable never renders or sends).
export const enqueueScpVideoApprovalResultMail = callable(enqueueScpVideoApprovalResultMailHandler, [
  "SCP_FLU_APPLICATION_COMMAND_SECRET",
  "SCP_FLU_APPLICATION_COMMAND_SECRET_PREVIOUS",
  "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_ID",
  "SCP_CREATOR_PIPELINE_V3_MATERIAL_CURRENT_KEY_SECRET",
  "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_ID",
  "SCP_CREATOR_PIPELINE_V3_MATERIAL_PREVIOUS_KEY_SECRET",
]);
// 0.6.110: release program targets quarantined ONLY by the transient global outbound-lock live precheck
// (blockedReason mail-safety.outbound-lock / blockedSource createCampaign.liveSafetyPrecheck). Re-runs the same
// live safety precheck NOW + per-target eligibility (suppression/bounce/opt-out/no-mx/role/complaint/blacklist,
// cached undeliverable, prior contact in program); only passing targets return to status "ready" (per-target
// transaction CAS). Never sends; the normal refill/send pipeline decides afterwards. super_admin only, viewAs
// rejected, dryRun default true, limit<=500 with cursor, counts-only response + audit doc.
// Secrets: the rendered-draft precheck mints the same Apply landing link createCampaign does, so it needs the same
// outreach HMAC key ring + Portal Apply origin (otherwise landing_link_unconfigured).
export const reevaluateOutboundLockBlockedTargets = callable(reevaluateOutboundLockBlockedTargetsHandler, {
  timeoutSeconds: 540,
  secrets: ["SCP_OUTREACH_HMAC_KEY_ID", "SCP_OUTREACH_HMAC_SECRET", "SCP_PORTAL_APPLY_ORIGIN"],
});
// W62-2 [헤세 · 지원 관리 탭]: apply 완료·영상 미제출자 조회 + 재촉 적재.
//   재촉은 **아웃박스 적재만** 한다 — 실제 발송은 승인·쿼터·suppression 게이트가 걸린 기존
//   드레인이 하고, 이 콜러블은 직접 SMTP 를 부르지 않는다(리더 지시).
// 2026-09-27 scp entitlement gate (assertScpEntitled) needs PEOPLY_API_KEY — see
// listScpApprovedWithoutIngest's comment above.
export const listApplicationVideoPending = callable(listApplicationVideoPendingHandler, ["PEOPLY_API_KEY"]);
export const enqueueApplicationVideoReminderMail = callable(enqueueApplicationVideoReminderHandler, ["PEOPLY_API_KEY"]);
// W72 [R1 P1-2]: 회차 시도 예산 복구(운영자 판단). 자동 리셋 경로는 만들지 않는다.
// 2026-09-27 codex adversarial review FAIL-4: gated by assertScpEntitled — needs PEOPLY_API_KEY.
export const resetApplicationVideoReminderSequence = callable(resetApplicationVideoReminderSequenceHandler, ["PEOPLY_API_KEY"]);
export const getScpNudgeSequenceConfig = callable(getScpNudgeSequenceConfigHandler);
// W72-C2 [헤세 지시 2026-08-13]: 검수 탭 코호트①③ 리스트업(읽기 전용 · 스윕과 같은 판정 코어).
// 2026-09-27 codex adversarial review FAIL-4: gated by assertScpEntitled — needs PEOPLY_API_KEY.
export const listScpNudgeCohortCandidates = callable(listScpNudgeCohortCandidatesHandler, ["PEOPLY_API_KEY"]);
// 2026-09-27 codex adversarial review round 2 FAIL-3: its full cadence/sequence-mapping branch is
// gated by assertScpEntitled — needs PEOPLY_API_KEY. The shared totalDailyCapOnly branch (general
// Admin workspace) stays ungated but this secret must still bind for the gated branch to resolve.
export const saveScpNudgeSequenceConfig = callable(saveScpNudgeSequenceConfigHandler, PEOPLY_API_SECRETS);
// 0.6.110: 프로그램/캠페인별 독려 문안 오버라이드 — super_admin/admin + scp entitlement(PEOPLY_API_KEY).
export const saveScpNudgeProgramOverride = callable(saveScpNudgeProgramOverrideHandler, PEOPLY_API_SECRETS);
// PLAN-ORG-MAIL-IDENTITY Slice 5: org-scoped read gate (resolveMailAccountForEmail).
export const listConversationMessages = callable(
  listConversationMessagesHandler,
  { secrets: ["PEOPLY_API_KEY"] },
);
// Flu conversation org-filter round 16 (codex adversarial review round 16, finding #2): round 14
// added resolveConversationMailAccessScope (→ listAccessibleMailAccountsForEmail → Peoply) to both
// handlers for every non-super_admin caller — needs PEOPLY_API_KEY bound, same as every other
// callable that resolves a caller's org through Peoply. Without it, a legit own-org
// reclassify/revert fails closed as "directory unavailable" in production (the local emulator has
// no Secret Manager, so this gap is invisible to emulator-only test runs — see
// tests/scp-callable-entitlement.test.mjs for the automated binding scan this now extends to catch
// it going forward).
export const reclassifyConversationAttribution = callable(
  reclassifyConversationAttributionHandler,
  PEOPLY_API_SECRETS,
);
export const revertConversationAttribution = callable(
  revertConversationAttributionHandler,
  PEOPLY_API_SECRETS,
);
// Perf/cost 2026-09-27: NOT wrapped in cacheableRead (see functions/readCache.ts) despite being a
// top-7d-invocation-count read — it calls datasetAccountOwnershipFilter(request, auth, "programs"),
// and "programs" is in ACCOUNT_OWNERSHIP_DATASET_KEYS, so this resolves the caller's live
// mailbox/account grant on every request (same exclusion as getDataset/listCampaigns above).
export const listPrograms = callable(listProgramsHandler, PEOPLY_API_SECRETS);

// Perf/cost 2026-09-24: batches the 5 read callables above into one in-process call (see
// functions/appBootstrap.ts's header comment) — every other caller keeps using the individual
// callables unchanged. Memory stays at the smallest tier since this handler only fans out
// Promise.allSettled and returns each nested read's own (already-cheap) response; no extra
// Firestore/Peoply work beyond what the 5 individual callables already do.
//
// Not called by the client in this PR (2026-09-24 adversarial review round 2 — see
// functions/appBootstrap.ts's header comment for why an earlier client-prefetch version was
// removed) and no minInstances: a cold, unused callable should not carry standing cost.
// minInstances stays on ssrscflu (firebase.json frameworksBackend), which every page load
// genuinely hits. This is the server-side foundation for a future PR that wires all 5 fields
// through their respective client hooks.
export const getAppBootstrap = callable(getAppBootstrapHandler, {
  secrets: ["PEOPLY_API_KEY"],
  memory: "256MiB",
  timeoutSeconds: 30,
});
export const repairProgramOrgScopes = callable(repairProgramOrgScopesHandler, PEOPLY_API_SECRETS);
// 2026-09-23 fix: listTargetableDatasetPage -> programApplicationParentFilter resolves
// account-ownership scope for every "programApplications" read (read.ts), which needs
// PEOPLY_API_KEY the same as listCampaigns/listPrograms/listCandidatePool above — was
// previously unbound, so manager/viewer program-scoped reads dropped rows or threw.
// Perf/cost 2026-09-27: NOT wrapped in cacheableRead (see functions/readCache.ts) despite being a
// top-7d-invocation-count read — programApplicationParentFilter (comment above) resolves the
// caller's live account-ownership/mailbox grant on every request, the same exclusion as
// getDataset/listCampaigns/listPrograms above.
export const listProgramApplications = callable(listProgramApplicationsHandler, PEOPLY_API_SECRETS);
export const listProgramSheetLeads = callable(listProgramSheetLeadsHandler);
export const listReviews = callable(listReviewsHandler);
export const listSubmissions = callable(listSubmissionsHandler);
export const listScpLifecycleProfiles = callable(
  listScpLifecycleProfilesHandler,
);
export const listCandidatePool = callable(listCandidatePoolHandler, PEOPLY_API_SECRETS);
export const listCreatorCommentInsights = callable(
  listCreatorCommentInsightsHandler,
);
// S12 A5: videoCommentAnalysisInline 경유로 reportLlmUsage에 도달 — AI Hub secret 바인딩 보강.
export const runCommentInsightsForVideo = callable(
  runCommentInsightsForVideoHandler,
  ["AI_HUB_LLM_API_KEY"],
);
// 2026-09-27 codex adversarial review round 2 sweep: refresh/diff/resolve/outbox (all except
// getScpLifecycleProfile/getScpLifecycleVideoHistory below, which back the general-purpose
// Influencer detail page) are now gated by assertScpEntitled — need PEOPLY_API_KEY.
export const refreshScpLifecycleProfiles = callable(
  refreshScpLifecycleProfilesHandler,
  PEOPLY_API_SECRETS,
);
export const diffScpLifecycleProfiles = callable(
  diffScpLifecycleProfilesHandler,
  PEOPLY_API_SECRETS,
);
export const getScpLifecycleProfile = callable(getScpLifecycleProfileHandler);
export const getScpLifecycleVideoHistory = callable(
  getScpLifecycleVideoHistoryHandler,
);
export const resolveScpLifecycleProfile = callable(
  resolveScpLifecycleProfileHandler,
  PEOPLY_API_SECRETS,
);
export const listScpLifecycleRefreshOutbox = callable(
  listScpLifecycleRefreshOutboxHandler,
  PEOPLY_API_SECRETS,
);
export const processScpLifecycleRefreshOutbox = callable(
  processScpLifecycleRefreshOutboxHandler,
  PEOPLY_API_SECRETS,
);
// SCP lifecycle outbox 드레인 스케줄러 — 변이 지점(메일/자격/링크/젬/제출/스냅샷)이 적재한
// refresh 이벤트를 주기 처리해 scp_lifecycle_profiles projection을 자동 최신화한다.
// 이 스케줄러가 없으면 outbox에 이벤트만 쌓이고 projection은 수동 콜러블 없이는 영구 stale.
// queued 0건이면 코어가 즉시 no-op 반환하므로 유휴 비용 없음. maxInstances:1로 동시 재계산 방지.
//
// W86-A [SWR 전환]: 어드민이 lifecycle 목록에 들어오면 그 자리에서 드레인이 돌므로(드레인 힌트 →
//   processScpLifecycleRefreshOutbox), 이 스케줄도 **안전망 저주기 6시간**으로 내린다.
//   적체 안 남 산술(브리핑 §작업2-2 요구):
//     · 1 pass 회수 상한 = MAX_REFRESH_RETIRE_PER_PASS 20,000건
//     · floor 4 pass/일 → 스케줄만으로 최대 80,000건/일 회수
//     · W86-B day-grain 이후 하루 적재 상한 = (source × sourceRef × reason × aliases × 그날) 고유 조합.
//       실측 적체 7,939건은 **밀리초 중복이 부풀린** 값이었으므로 day-grain 이후 일일 유입은 그보다
//       작다. 80,000 ≫ 유입이라 어드민 접속이 0인 날에도 큐가 단조 증가하지 않는다.
//     · 어드민 접속 pass 는 그 위에 얹히는 여유분이다(0이어도 위 부등식이 성립한다).
//
//   26-09-05 [헤세 지시 · 작업3 실측]: 위 80,000/일 산술은 **한 번도 실현되지 않았다** — 프로드
//   로그(2026-09-03 배포 이후 매 pass) 가 매번 `JavaScript heap out of memory`/`Memory limit of
//   512 MiB exceeded`로 죽는다. `readScpLifecycleSources(2000)` + 프로젝션 재계산이 512MiB 를
//   넘어서면서 클레임한 최대 20건이 "processing" 에 갇혀 attempts 만 20+ 회 올라가고(관측: 일부는
//   createdAtIso 가 8/23까지 거슬러 올라감), retire(20,000/pass)까지 아예 도달하지 못한다 —
//   실측 62,307 queued 는 이 크래시 루프의 결과다. 메모리를 1GiB 로 올려 pass 가 실제로 완주하게
//   한다(원래 산술의 20,000×4/pass 상한은 그대로 — 늘리지 않는다, refill/read 예산 불변).
export const processScpLifecycleRefreshOutboxSchedule = onSchedule(
  {
    schedule: "every 360 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 0,
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async () => {
    await processScpLifecycleRefreshOutboxCoreHandler();
  },
);

// W104(헤세): 지원서 자가신고 신원 스윕 — token_absent 지원(서명 material 미전달)의 관리 카드가
// opaque id 로만 뜨던 공백을 포털 answers 안전 서브셋으로 메운다. 저주기 안전망(6시간) + 수동
// 콜러블. 크로스 프로젝트 IAM 부재 시 permissionDenied 로 보고되고 아무것도 쓰지 않는다.
export const sweepApplicationDeclaredIdentityNow = callable(async (request) => {
  const auth = assertNonGuestAuth(request as never, "application_management.declared_identity_sweep", ["super_admin", "admin"]);
  const result = await sweepApplicationDeclaredIdentityHandler();
  return { ok: true, ...result, behaviorLog: makeBehaviorLog(auth, "application_management.declared_identity_sweep", "success") };
});
export const sweepApplicationDeclaredIdentitySchedule = onSchedule(
  {
    schedule: "every 360 minutes",
    timeZone: "Asia/Seoul",
    maxInstances: 1,
    retryCount: 0,
    timeoutSeconds: 300,
    memory: "256MiB",
  },
  async () => {
    const result = await sweepApplicationDeclaredIdentityHandler();
    if (result.permissionDenied) {
      console.error("[declared-identity-sweep] portal read permission denied — request cross-project IAM", result);
    } else if (result.transientFailure || result.cursorContended) {
      // 커서는 보존되고 다음 회차가 이어받지만, 조용히 실패하지 않는다는 모듈 원칙대로 남긴다.
      console.warn("[declared-identity-sweep] transient stop — cursor preserved", result);
    } else if (result.backfilled > 0) {
      console.info("[declared-identity-sweep] backfilled", result);
    }
  },
);
// W9-6 수리 순서 1: Sheet3(content_review) 신규 유입 차단 — 스케줄/콜러블 제거.
// functions/sheet3SubmissionBridge.ts는 역사 조회·백필 스크립트가 참조하므로 남겨두되,
// 배포 후 어떤 Cloud Function도 그 쓰기 경로를 더 이상 호출하지 않는다.
// 2026-09-27 codex adversarial review round 2 FAIL-3: all five now gated by assertScpEntitled
// (functions/scpGemGrants.ts) — need PEOPLY_API_KEY to resolve a non-super_admin caller's org.
export const scheduleGemGrant = callable(scheduleGemGrantHandler, PEOPLY_API_SECRETS);
export const holdGemGrant = callable(holdGemGrantHandler, PEOPLY_API_SECRETS);
export const failGemGrant = callable(failGemGrantHandler, PEOPLY_API_SECRETS);
export const markGemGrantPaid = callable(markGemGrantPaidHandler, PEOPLY_API_SECRETS);
export const listGemGrants = callable(listGemGrantsHandler, PEOPLY_API_SECRETS);
// C1 광고 분류 + 휴먼게이트 자동제안 — 외부 AI는 callModel(SEC-P0-005) + usage 로그. 발송 없음(draft_only, 사람 승인 필요).
export const classifyFeedVideoAds = callable(classifyFeedVideoAdsHandler, [
  "AI_HUB_LLM_API_KEY",
]);
export const createAdProposal = callable(createAdProposalHandler, [
  "AI_HUB_LLM_API_KEY",
]);
export const recordAdProposalFeedback = callable(
  recordAdProposalFeedbackHandler,
);
export const listAdProposals = callable(listAdProposalsHandler);
// C2 후보 승격(멀티컨트리 트렌딩) — candidate_pool → creators. 외부호출 없음(DB 승격만).
export const promoteDiscoveredCreators = callable(
  promoteDiscoveredCreatorsHandler,
);
// C4 유튜브 링크 일일 모니터링 — 스냅샷 실행(수동/admin verify) + 시계열 조회(리포트/영상검수 UI).
export const runVideoViewSnapshots = callable(runVideoViewSnapshotsHandler, [
  ...YOUTUBE_API_SECRETS,
]);
export const getVideoViewSeries = callable(getVideoViewSeriesHandler);
export const getVideoViewRollups = callable(getVideoViewRollupsHandler);
export const getVideoMetricExact168hReadiness = callable(
  getVideoMetricExact168hReadinessHandler,
  [
    ...YOUTUBE_API_SECRETS,
    "YOUTUBE_OAUTH_CREDENTIAL_ENCRYPTION_KEY",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
  ],
);
// C5 영상검수 멀티모달 판정 — 파일 미제출(YouTube 링크) 제출물을 callVideoModel로 실제 관찰 판정(few-shot 재사용, 사람 검수 게이트 유지).
// 2026-09-27 codex adversarial review round 4 FAIL-2: now calls assertScpEntitled — added
// PEOPLY_API_KEY alongside the existing AI_HUB_LLM_API_KEY.
export const judgeVideoReviewMultimodal = callable(
  judgeVideoReviewMultimodalHandler,
  {
    secrets: ["AI_HUB_LLM_API_KEY", "PEOPLY_API_KEY"],
    timeoutSeconds: 540,
    memory: "1GiB",
    maxInstances: 3,
  },
);
// W89 레버 3 — mediaResolution 품질 비교 하네스(super_admin/admin 전용, 운영 캐시/데이터 쓰기 없음).
// 2026-09-27 codex adversarial review round 4 sweep: now calls assertScpEntitled — added
// PEOPLY_API_KEY alongside the existing AI_HUB_LLM_API_KEY.
export const previewVideoReviewMediaResolution = callable(
  previewVideoReviewMediaResolutionHandler,
  {
    secrets: ["AI_HUB_LLM_API_KEY", "PEOPLY_API_KEY"],
    timeoutSeconds: 540,
    memory: "1GiB",
    maxInstances: 3,
  },
);

// Flu conversation org-filter round 16 (codex adversarial review round 16, finding #2): round 14
// added resolveConversationMailAccessScope (→ Peoply) for entity "conversation" actions — needs
// PEOPLY_API_KEY bound (see reclassifyConversationAttribution's matching comment above).
export const updateWorkflowItemState = callable(updateWorkflowItemStateHandler, PEOPLY_API_SECRETS);

// SCP PR1 intake ledger — server-side Google Sheet raw adapter. No client Firestore/external access.
