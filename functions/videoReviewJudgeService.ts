import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { reportLlmUsage, newSessionId } from "./aiHubReport";
import { adminDb } from "./firebaseAdmin";
import { hasScpAutomationBacktestApproval, isHumanGateRequiredFromSettings, readScpAutomationSettings } from "./scpAutomationSettings";
import { canonicalReviewStatus, updateReviewStatus } from "./review-pay";
import { callModel, selectVertexModelForTask, type VertexResult } from "./vertex";
import { hasVideoReviewMediaCandidate } from "./videoReviewMedia";
import { resolveCanonicalProgramId, SCP_CANONICAL_PROGRAM_ID } from "./programCanonical";
import { loadProgramTitleRegistry } from "./programTitlesStore";
import {
  programScopeError,
  resolveAuthoritativeVideoReviewProgramScope,
  sameVideoReviewProgramScope,
  videoReviewEffectiveProgramPolicy,
  videoReviewProgramScopeKey,
  videoReviewProgramScopeFromTrustedRecords,
  videoReviewScopePreservingSubmissionUpdate,
  videoReviewScopedFingerprint,
  type VideoReviewProgramScope,
} from "./videoReviewProgramScope";
import {
  trustedVideoReviewEvidenceEnvelope,
  videoReviewEvidenceSummary,
} from "./videoReviewEvidence";
import {
  VIDEO_REVIEW_POLICY_VERSION,
  VIDEO_REVIEW_RULES,
  ruleApplicabilityForTracks,
  videoReviewCriteriaMetadata,
  videoReviewCriteriaPromptBlock,
  videoReviewCriteriaPromptMetadata,
  videoReviewRubricTitle,
  videoReviewRuleById,
  XP_HERO_ALLOWED_CONTENT_LANGUAGE_CODES,
  type VideoReviewAssessment,
  type VideoReviewRubricTitle,
  type VideoReviewRuleEvidenceStatus,
  type VideoReviewTrack,
} from "./videoReviewCriteria";

export type VideoReviewVerdictValue = "approval" | "disapproval" | "needs_review";
export type VideoReviewFinalStatus = "approved" | "rejected" | "needs_review" | null;

export interface VideoReviewChecks {
  customLinkUsed: boolean | null;
  contentRelevance: "strong" | "weak" | "unknown";
  gameplayDepth: "good" | "simple" | "unknown";
  linkValidity: "valid" | "invalid" | "unknown";
  publicAccess: "public" | "private" | "unknown";
  duplicationOrOriginality: "original" | "duplicate_or_reused" | "simple_reupload" | "unknown";
}

export interface VideoReviewRuleEvidence {
  ruleId: string;
  ruleKey: string;
  ruleName: string;
  assessment: VideoReviewAssessment;
  applicability: "applicable" | "not_applicable" | "unknown";
  status: VideoReviewRuleEvidenceStatus;
  confidence: number;
  summary: string;
  observedAtIso: string | null;
  timestampMs: number | null;
  frameRef: string | null;
  transcriptRef: string | null;
  mediaFingerprint: string | null;
  provider: "server" | "vertex" | "human" | "unknown";
  modelId: string | null;
  policyVersion: typeof VIDEO_REVIEW_POLICY_VERSION;
}

export interface VideoReviewHumanGate {
  required: boolean;
  ruleIds: string[];
  reasons: string[];
}

export interface VideoReviewVerdict {
  verdict: VideoReviewVerdictValue;
  disapprovalProbability: number;
  reasons: string[];
  checks: VideoReviewChecks;
  policyFlags: string[];
  missingFields: string[];
  policyVersion: typeof VIDEO_REVIEW_POLICY_VERSION;
  evidence: VideoReviewRuleEvidence[];
  humanGate: VideoReviewHumanGate;
}

export type VideoReviewNormalizationContext = {
  modality?: "text" | "multimodal";
  provider?: "server" | "vertex" | "human" | "unknown";
  modelId?: string;
  observedAtIso?: string;
  mediaFingerprint?: string;
};

export interface VideoReviewJudgeInput {
  submissionIds?: unknown;
  submissionRefs?: unknown;
  submissions?: unknown;
  dryRun?: unknown;
  disableFewShot?: unknown;
  nowIso?: unknown;
  requestedBy: string;
  requestedRole?: string;
  requestedTeam?: string;
}

export interface VideoReviewFewShotCase {
  submissionId: string;
  submissionRef: string;
  programId: string;
  policyConfigHash?: string;
  label: "approval" | "disapproval";
  reason: string;
  decidedAtIso: string;
  programMatch: boolean;
  features: Record<string, unknown>;
}

export interface VideoReviewJudgeResult {
  submissionId: string;
  submissionRef: string;
  status: "recommended" | "skipped" | "failed";
  cacheHit: boolean;
  fewShotContext: { checked: true; disabled: boolean; cases: number; hash: string };
  humanGateRequired: boolean;
  mode: string;
  aiRecommendation: VideoReviewVerdict | null;
  finalStatus: VideoReviewFinalStatus;
  finalReason: string | null;
  decisionRef: string | null;
  transitionRef: string | null;
  canonicalProgramId?: string;
  policyConfigHash?: string;
  /** Internal compatibility alias; non-enumerable on failed results. */
  error?: VideoReviewPublicErrorCode;
  errorCode?: VideoReviewPublicErrorCode;
  correlationIdHash?: string;
}

export interface VideoReviewJudgeRunResult {
  mode: "dry_run" | "emulator_write" | "live_write";
  requestedSubmissionCount: number;
  recommendedCount: number;
  failedCount: number;
  skippedCount: number;
  writeCount: number;
  transitionedCount: number;
  results: VideoReviewJudgeResult[];
  cache: { checked: true; hits: number; misses: number; ttlSeconds: number };
  fewShot: { checked: true; disabled: boolean; caseSetHashes: string[] };
  costLog: VideoReviewCostLog;
}

type VideoReviewCostLog = {
  model: string;
  cacheChecked: true;
  cacheHit: boolean;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  ledgerRef: string;
};

type ModelCaller = (
  modelId: string,
  responseSchema: unknown,
  promptText: string,
) => Promise<VertexResult<VideoReviewVerdict>>;
type SubmissionInput = Record<string, unknown> & { id?: string };
const AUTHORITATIVE_VIDEO_SUBMISSION = Symbol("authoritative-video-submission");
type ResolvedSubmissionInput = SubmissionInput & { [AUTHORITATIVE_VIDEO_SUBMISSION]?: true };
export type VideoReviewJudgeRuntimeOptions = {
  authoritativeScopes?: ReadonlyMap<string, VideoReviewProgramScope>;
};
type CachePayload = {
  verdict: VideoReviewVerdict;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};
type VideoReviewCachedRuleEvidence = Omit<VideoReviewRuleEvidence, "provider" | "modelId">;
type VideoReviewCachedVerdict = Omit<VideoReviewVerdict, "evidence"> & {
  evidence: VideoReviewCachedRuleEvidence[];
};

export const VIDEO_REVIEW_PUBLIC_ERROR_CODES = [
  "video_review_missing_submission_id",
  "video_review_submission_not_found",
  "video_review_backtest_required",
  "video_review_transition_failed",
  "video_review_judge_failed",
  "video_review_program_scope_unresolved",
  "video_review_program_scope_ambiguous",
  "video_review_program_scope_changed",
] as const;

export type VideoReviewPublicErrorCode = typeof VIDEO_REVIEW_PUBLIC_ERROR_CODES[number];
type VideoReviewBoundaryError = {
  errorCode: VideoReviewPublicErrorCode;
  correlationIdHash: string;
};

const VIDEO_REVIEW_ERROR_HASH_DOMAIN = "scp-video-review-boundary:v1";
const VIDEO_REVIEW_CACHE_TRANSPORT_FIELDS = new Set([
  "capabilities",
  "capability",
  "gatewaybypassed",
  "meter",
  "meterid",
  "metering",
  "meteringmetadata",
  "provider",
  "providerid",
  "providermetadata",
  "providerrunid",
  "runid",
  "transport",
  "transportmetadata",
]);

export const VIDEO_REVIEW_JUDGE_CACHE_TTL_SECONDS = 60 * 60;
export const VIDEO_REVIEW_JUDGE_MODEL_TASK = "scp_video_review_judge";
export const VIDEO_REVIEW_DECISIONS_COLLECTION = "video_review_decisions";
export const VIDEO_REVIEW_JUDGE_CACHE_COLLECTION = "video_review_judge_cache";
export const VIDEO_REVIEW_FEW_SHOT_PER_VERDICT = 3;
export const VIDEO_REVIEW_FEW_SHOT_LEDGER_LIMIT = 200;

export const VIDEO_REVIEW_REASONS: readonly string[] = [...new Set([
  "커스텀링크 미사용",
  "타게임 위주",
  "단순플레이",
  "잘못된 링크",
  "비공개영상",
  "중복/재탕",
  ...VIDEO_REVIEW_RULES.map((item) => item.reason),
])];

const VIDEO_REVIEW_REASON_SET = new Set(VIDEO_REVIEW_REASONS);
const VIDEO_REVIEW_RULE_ID_SET = new Set<string>(VIDEO_REVIEW_RULES.map((item) => item.id));
const VIDEO_REVIEW_FEW_SHOT_REASON_CODES = new Set([
  "approved",
  "missing_link",
  "missing_hashtag",
  "brand_mismatch",
  "quality_issue",
]);

export const VIDEO_LABEL_OUTPUT_KEYS = new Set([
  "email",
  "mail",
  "token",
  "submitToken",
  "reviewStatus",
  "reviewNotes",
  "reviewMemo",
  "rejectedReason",
  "payment",
  "payableStatus",
  "paidAt",
  "aiRecommendation",
  "latestVideoReviewDecisionRef",
  "approval",
  "disapproval",
  "status",
]);

export const VIDEO_REVIEW_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    verdict: { type: "STRING", enum: ["approval", "disapproval", "needs_review"] },
    disapprovalProbability: { type: "NUMBER" },
    reasons: { type: "ARRAY", items: { type: "STRING", enum: VIDEO_REVIEW_REASONS } },
    checks: {
      type: "OBJECT",
      properties: {
        customLinkUsed: { type: "BOOLEAN", nullable: true },
        contentRelevance: { type: "STRING", enum: ["strong", "weak", "unknown"] },
        gameplayDepth: { type: "STRING", enum: ["good", "simple", "unknown"] },
        linkValidity: { type: "STRING", enum: ["valid", "invalid", "unknown"] },
        publicAccess: { type: "STRING", enum: ["public", "private", "unknown"] },
        duplicationOrOriginality: { type: "STRING", enum: ["original", "duplicate_or_reused", "simple_reupload", "unknown"] },
      },
      required: ["customLinkUsed", "contentRelevance", "gameplayDepth", "linkValidity", "publicAccess", "duplicationOrOriginality"],
    },
    policyFlags: { type: "ARRAY", items: { type: "STRING", enum: VIDEO_REVIEW_RULES.map((item) => item.id) } },
    missingFields: { type: "ARRAY", items: { type: "STRING", enum: VIDEO_REVIEW_RULES.map((item) => item.id) } },
    evidence: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          ruleId: { type: "STRING" },
          status: { type: "STRING", enum: ["observed", "unknown", "failed"] },
          confidence: { type: "NUMBER" },
          summary: { type: "STRING" },
          timestampMs: { type: "NUMBER", nullable: true },
          frameRef: { type: "STRING", nullable: true },
          transcriptRef: { type: "STRING", nullable: true },
        },
        required: ["ruleId", "status", "confidence", "summary", "timestampMs", "frameRef", "transcriptRef"],
      },
    },
  },
  required: ["verdict", "disapprovalProbability", "reasons", "checks", "policyFlags", "missingFields", "evidence"],
} as const;

export async function runVideoReviewJudge(
  input: VideoReviewJudgeInput,
  modelCaller: ModelCaller = callModel<VideoReviewVerdict>,
  runtimeOptions: VideoReviewJudgeRuntimeOptions = {},
): Promise<VideoReviewJudgeRunResult> {
  const dryRun = input.dryRun === true;

  const now = parseDate(input.nowIso, new Date()) ?? new Date();
  const settings = await readScpAutomationSettings();
  const stageSettings = settings.stages.videoReview;
  const gateDecision = isHumanGateRequiredFromSettings("videoReview", "final_decision", settings);
  const submissions = await resolveSubmissionInputs(input);
  const modelId = selectVertexModelForTask(VIDEO_REVIEW_JUDGE_MODEL_TASK);
  const results: VideoReviewJudgeResult[] = [];
  let hits = 0;
  let misses = 0;
  let writes = 0;
  let transitioned = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCostUsd = 0;
  const fewShotHashes = new Set<string>();

  for (const submission of submissions) {
    const submissionId = cleanSubmissionId(submission.id);
    const submissionRef = submissionPath(submissionId);
    if (!submissionId) {
      results.push(emptyResult({
        submissionId,
        submissionRef,
        mode: stageSettings.mode,
        humanGateRequired: gateDecision.required,
        status: "skipped",
        boundaryError: videoReviewBoundaryError("missing submission id", "video_review_missing_submission_id"),
      }));
      continue;
    }
    // S6(P6) RT-6/A6 "쓰기 대상 문서 존재 확인" assert — resolveSubmissionInputs marks a
    // fetch miss with `missing: true` instead of throwing. Before this fix, execution
    // fell through here and writeVideoReviewDecision would silently CREATE a ghost
    // submissions/{id} doc via `.set(..., {merge:true})` with a fabricated verdict built
    // from near-empty features, while the outbox still recorded the job as "processed"
    // (success). Fail loudly instead so the outbox surfaces this as a real failure.
    if ((submission as SubmissionInput & { missing?: boolean }).missing === true) {
      results.push(emptyResult({
        submissionId,
        submissionRef,
        mode: stageSettings.mode,
        humanGateRequired: gateDecision.required,
        status: "failed",
        boundaryError: videoReviewBoundaryError(submissionRef, "video_review_submission_not_found"),
      }));
      continue;
    }

    let humanGateRequired = gateDecision.required;
    try {
      const scope = runtimeOptions.authoritativeScopes?.get(submissionId)
        ?? await videoReviewProgramScopeForJudgeInput(submission);
      // 2026-09-05 P1 리뷰 수리: 운영 오버라이드가 루브릭·증거 정규화에도 닿게 한다(60s 캐시라
      // 배치 안에서 반복 호출해도 저장소를 다시 읽지 않는다).
      const registryOverride = await loadProgramTitleRegistry(scope.canonicalProgramId);
      const features = videoReviewFeaturesFromSubmission(submission, scope, registryOverride);
      // Text-only metadata is never sufficient to consume a review/payable transition when
      // an actual video can be inspected. The multimodal result also remains human-gated; this
      // canonical media resolver includes youtubeUrl/videoUrl/reviewUrl aliases and uploads.
      humanGateRequired = gateDecision.required || hasVideoReviewMediaCandidate(submission);
      const fewShotCases = input.disableFewShot === true ? [] : await selectRecentVideoReviewFewShotCases(submission, { scope });
      const fewShotHash = hashVideoReviewFewShotCases(fewShotCases);
      fewShotHashes.add(fewShotHash);
      const fewShotContext = {
        checked: true as const,
        disabled: input.disableFewShot === true,
        cases: fewShotCases.length,
        hash: fewShotHash,
      };
      const cacheKey = videoReviewCacheKey(modelId, features, fewShotHash, VIDEO_REVIEW_POLICY_VERSION, scope);
      const cached = await videoReviewCacheLookup(cacheKey, features, scope);
      const promptText = cached ? "" : videoReviewPrompt(features, fewShotCases);
      let verdict: VideoReviewVerdict;
      let cacheHit = false;
      let modelResult: VertexResult<VideoReviewVerdict> | null = null;

      if (cached) {
        cacheHit = true;
        hits += 1;
        verdict = cached.verdict;
        // W89: cacheHit 관례를 영상 멀티모달 레인(videoLlm.ts logVideoLlmUsage)과 맞춘다 —
        // 캐시 히트를 reportLlmUsage에서 완전히 건너뛰면 llm_usage.calls가 실제 판정 호출량보다
        // 낮게 집계된다(토큰/비용 0, transport="cache"로 실제 모델 호출과는 구분된다).
        await reportLlmUsage({
          sessionId: newSessionId(),
          toolId: VIDEO_REVIEW_JUDGE_MODEL_TASK,
          modelId,
          provider: "unverified",
          transport: "cache",
          inputTokens: 0,
          outputTokens: 0,
          totalCostUsd: 0,
          actionId: submissionId,
        });
      } else {
        misses += 1;
        modelResult = await modelCaller(modelId, VIDEO_REVIEW_RESPONSE_SCHEMA, promptText);
        verdict = normalizeVideoReviewVerdict(modelResult.json, features, {
          modality: "text",
          provider: modelResult.provider === "vertex" ? "vertex" : "unknown",
          modelId,
          observedAtIso: now.toISOString(),
        });
        inputTokens += modelResult.inputTokens;
        outputTokens += modelResult.outputTokens;
        estimatedCostUsd += modelResult.estimatedCostUsd;
        // 캐시는 dry-run에서도 기록한다 (COST-P0-011). 캐시는 내용 지문(fingerprint)+
        // few-shot 해시 키의 "모델 산출물"일 뿐 원장/제출물에 아무것도 쓰지 않으므로
        // N-2/N-3(dry-run 인라인 입력의 원장 오염 차단)과 무관하다. 이거 없으면
        // Sheet3 백테스트(dry-run 전용)가 매 실행 전량 재과금·재판정돼 수렴 불가
        // (2026-07-03 실측: 100행×2패스가 540s 타임아웃 반복, 캐시 0건).
        await videoReviewCacheStore(cacheKey, features.submissionFingerprint, scope, {
          verdict,
          modelId,
          inputTokens: modelResult.inputTokens,
          outputTokens: modelResult.outputTokens,
          estimatedCostUsd: modelResult.estimatedCostUsd,
        });
        await reportLlmUsage({
          sessionId: newSessionId(),
          toolId: VIDEO_REVIEW_JUDGE_MODEL_TASK,
          modelId,
          provider: modelResult.provider,
          transport: modelResult.transport ?? "unverified",
          inputTokens: modelResult.inputTokens,
          outputTokens: modelResult.outputTokens,
          totalCostUsd: modelResult.estimatedCostUsd,
          actionId: submissionId,
        });
      }

      // Policy evidence is a second fail-closed gate independent of the operator setting.
      // Missing/unavailable evidence and every human-only rule remain assistive recommendations;
      // they can never consume a review/payable transition automatically.
      humanGateRequired = humanGateRequired || verdict.humanGate.required;
      const finalStatus = humanGateRequired ? null : finalStatusForVerdict(verdict.verdict);
      const finalReason = finalStatus ? verdict.reasons[0] ?? null : null;

      // Stage-scoped backtest gate: a persisting auto-finalization (finalStatus
      // set means the videoReview gate is off) must never fire on the shared
      // qualification stamp. Until a videoReview backtest stamp exists it is
      // blocked outright — no decision write, no review-pay/payable transition
      // (P0-5 / N-1). Human-assist recommendation writes (finalStatus === null)
      // are unaffected.
      if (!dryRun && finalStatus && !hasScpAutomationBacktestApproval("videoReview")) {
        results.push(emptyResult({
          submissionId,
          submissionRef,
          mode: stageSettings.mode,
          humanGateRequired,
          status: "failed",
          fewShotContext,
          boundaryError: videoReviewBoundaryError(submissionRef, "video_review_backtest_required"),
        }));
        continue;
      }

      const decisionRefObj = dryRun ? null : decisionDocRef(submissionId, scope, now);
      const decisionRef = decisionRefObj?.path ?? null;
      let transitionRef: string | null = null;

      if (!dryRun && decisionRefObj) {
        await writeVideoReviewDecision({
          submissionId,
          submissionRef,
          decisionRef: decisionRefObj,
          verdict,
          finalStatus,
          finalReason,
          decidedBy: input.requestedBy,
          decidedAtIso: now.toISOString(),
          mode: stageSettings.mode,
          modelId,
          cacheHit,
          scope,
          fewShotFeatures: compactFewShotFeatures(features),
        });
        writes += 1;
      }

      if (!dryRun && finalStatus) {
        try {
          const transition = await updateReviewStatus({
            auth: { uid: input.requestedBy, token: { role: normalizeRole(input.requestedRole), team: text(input.requestedTeam) || "scp" } },
            data: {
              submissionId,
              status: finalStatus,
              reasonText: finalReason || verdict.reasons[0] || "auto_ai video review decision",
              feedbackText: verdict.reasons.join(" / "),
              decidedAtIso: now.toISOString(),
              decisionRef,
              latestVideoReviewDecisionRef: decisionRef,
              expectedCanonicalProgramId: scope.canonicalProgramId,
              expectedPolicyConfigHash: scope.policyConfigHash,
              expectedProgramScopeVersion: scope.scopeVersion,
            },
            rawRequest: { ip: "127.0.0.1" },
          }) as { review?: { ledgerRef?: unknown } };
          transitionRef = typeof transition.review?.ledgerRef === "string" ? transition.review.ledgerRef : null;
          transitioned += 1;
        } catch (error) {
          results.push(emptyResult({
            submissionId,
            submissionRef,
            mode: stageSettings.mode,
            humanGateRequired,
            status: "failed",
            fewShotContext,
            boundaryError: videoReviewBoundaryError(error, "video_review_transition_failed"),
          }));
          continue;
        }
      }

      results.push({
        submissionId,
        submissionRef,
        status: "recommended",
        cacheHit,
        fewShotContext,
        humanGateRequired,
        mode: stageSettings.mode,
        aiRecommendation: verdict,
        finalStatus,
        finalReason,
        decisionRef,
        transitionRef,
        canonicalProgramId: scope.canonicalProgramId,
        policyConfigHash: scope.policyConfigHash,
      });
    } catch (error) {
      const scopeErrorCode = videoReviewProgramScopePublicErrorCode(error);
      results.push(emptyResult({
        submissionId,
        submissionRef,
        mode: stageSettings.mode,
        humanGateRequired,
        status: "failed",
        fewShotContext: { checked: true, disabled: input.disableFewShot === true, cases: 0, hash: hashVideoReviewFewShotCases([]) },
        boundaryError: videoReviewBoundaryError(error, scopeErrorCode ?? "video_review_judge_failed"),
      }));
    }
  }

  return {
    mode: dryRun ? "dry_run" : persistedWriteMode(),
    requestedSubmissionCount: submissions.length,
    recommendedCount: results.filter((result) => result.status === "recommended").length,
    failedCount: results.filter((result) => result.status === "failed").length,
    skippedCount: results.filter((result) => result.status === "skipped").length,
    writeCount: writes,
    transitionedCount: transitioned,
    results,
    cache: { checked: true, hits, misses, ttlSeconds: VIDEO_REVIEW_JUDGE_CACHE_TTL_SECONDS },
    fewShot: { checked: true, disabled: input.disableFewShot === true, caseSetHashes: [...fewShotHashes].sort() },
    costLog: {
      model: modelId,
      cacheChecked: true,
      cacheHit: misses === 0,
      inputTokens,
      outputTokens,
      estimatedCostUsd: Number(estimatedCostUsd.toFixed(8)),
      ledgerRef: `cost_logs/${VIDEO_REVIEW_JUDGE_MODEL_TASK}/${now.getTime()}`,
    },
  };
}

/**
 * 제출이 어느 프로그램 타이틀의 콘텐츠인지 해석한다 — 루브릭(R1/R2/R6/R8)과 반려 문구의 유일한
 * 입력이다. `gameId`(정본) → `gameName`(포털 레거시) 순으로 읽고, 없거나 미등록이면 프로그램
 * 기본 타이틀로 착지한다. 오늘 원장의 review-state 문서에는 gameId 가 하나도 없으므로 기존 행은
 * 전부 기본 타이틀(XP Hero)로 읽히고 판정이 바뀌지 않는다.
 */
export function videoReviewRubricTitleFromSubmission(
  submission: Record<string, unknown>,
  programScope?: VideoReviewProgramScope,
  // 2026-09-05 P1 리뷰 수리: 운영 오버라이드(settings/program_titles). 이 함수는 동기라 직접
  // 로드하지 못한다 — 호출부가 이미 async 체인 안에서 programScope 를 안 직후 한 번 로드해
  // 넘긴다. 미지정이면 코드 시드만 본다(오늘 동작 그대로).
  registryOverride?: unknown,
): VideoReviewRubricTitle {
  const programId = text(programScope?.canonicalProgramId, 180)
    || text(submission.canonicalProgramId, 180)
    || text(submission.programId, 180);
  return videoReviewRubricTitle(programId || undefined, submission.gameId ?? submission.gameName, registryOverride);
}

// R2 tri-state source. Only server-enriched YouTube-description metadata is authoritative;
// URLs supplied as content/form fields are deliberately ignored.
export function customLinkStatusFromSubmission(
  submission: Record<string, unknown>,
  programScope?: VideoReviewProgramScope,
): boolean | null {
  const fact = trustedVideoReviewEvidenceEnvelope(submission, { programScope })?.facts.find((item) => item.ruleId === "R2");
  if (fact?.code === "r2_assigned_destination_present" || fact?.code === "r2_unclassified_store_destination") return true;
  if (fact?.code === "r2_assigned_destination_missing" || fact?.code === "r2_other_title_destination_present") return false;
  return null;
}

export function serverVideoReviewEvidenceFromSubmission(
  submission: Record<string, unknown>,
  tracks?: readonly VideoReviewTrack[],
  programScope: VideoReviewProgramScope = videoReviewProgramScopeFromTrustedRecords({ submission }),
  registryOverride?: unknown,
): VideoReviewRuleEvidence[] {
  const trustedEnvelope = trustedVideoReviewEvidenceEnvelope(submission, { programScope });
  const sanitized = pruneVideoReviewOutputFields(submission);
  const urlSignalsForSubmission = collectUrlSignals(sanitized);
  const resolvedTracks = tracks?.length ? [...tracks] : videoReviewTracksFromSignals(urlSignalsForSubmission, sanitized);
  const rubricTitle = videoReviewRubricTitleFromSubmission(sanitized, programScope, registryOverride);
  const applicability = ruleApplicabilityForTracks(resolvedTracks, rubricTitle);
  const youtubeMetadata = asRecord(sanitized.youtubeMetadata);
  const descriptionMetadata = asRecord(sanitized.youtubeDescriptionMetadata);
  const mediaMetadata = asRecord(sanitized.uploadedMedia);
  const effectiveProgramPolicy = videoReviewEffectiveProgramPolicy(programScope);
  const evidence = VIDEO_REVIEW_RULES.map((item): VideoReviewRuleEvidence => {
    const ruleApplicability = applicability[item.id]?.status ?? "unknown";
    return {
      ruleId: item.id,
      ruleKey: item.key,
      ruleName: item.name,
      assessment: item.assessment,
      applicability: ruleApplicability,
      status: ruleApplicability === "not_applicable" ? "observed" : "unknown",
      confidence: ruleApplicability === "not_applicable" ? 1 : 0,
      summary: ruleApplicability === "not_applicable" ? "not applicable to this submission track" : "evidence unavailable",
      observedAtIso: null,
      timestampMs: null,
      frameRef: null,
      transcriptRef: null,
      mediaFingerprint: null,
      provider: "server",
      modelId: null,
      policyVersion: VIDEO_REVIEW_POLICY_VERSION,
    };
  });
  const byId = new Map(evidence.map((item) => [item.ruleId, item]));
  const set = (
    ruleId: string,
    status: VideoReviewRuleEvidenceStatus,
    confidence: number,
    summary: string,
    observedAtIso: string | null = sourceEvidenceTimestamp(sanitized),
  ) => {
    const current = byId.get(ruleId);
    if (!current || current.applicability === "not_applicable") return;
    Object.assign(current, {
      status,
      confidence: clampConfidence(confidence),
      summary: safeEvidenceText(summary, 300),
      observedAtIso,
    });
  };

  for (const fact of trustedEnvelope?.facts ?? []) {
    set(fact.ruleId, fact.status, fact.confidence, videoReviewEvidenceSummary(fact.code), fact.observedAtIso);
  }

  const publicStatus = text(
    sanitized.youtubePrivacyStatus
      ?? sanitized.publicStatus
      ?? youtubeMetadata.privacyStatus
      ?? youtubeMetadata.publicStatus,
    40,
  ).toLowerCase();
  const hasValidYoutubeTarget = urlSignalsForSubmission.some((url) => !url.uploadedFile && url.validHttpUrl && isYoutubeHost(url.host));
  if (!hasValidYoutubeTarget && resolvedTracks.includes("youtube_link")) set("R3", "failed", 1, "submitted YouTube target is invalid");
  else if (["private", "unlisted"].includes(publicStatus)) set("R3", "failed", 1, `YouTube visibility is ${publicStatus}`);
  else if (publicStatus === "public" && hasValidYoutubeTarget) set("R3", "observed", 1, "YouTube target resolves and is public");
  else if (hasValidYoutubeTarget) set("R3", "unknown", 0.6, "YouTube target parses; authoritative public visibility unavailable");

  const durationSeconds = firstFiniteNumber([
    sanitized.durationSeconds,
    sanitized.videoDurationSeconds,
    youtubeMetadata.durationSeconds,
    mediaMetadata.durationSeconds,
  ]);
  const liveVod = firstBoolean([sanitized.isLiveVod, sanitized.isLiveContent, youtubeMetadata.isLiveVod, youtubeMetadata.isLiveContent]);
  if (liveVod === true) set("R5", "failed", 1, "live-stream VOD is not eligible");
  else if (durationSeconds !== null && durationSeconds < effectiveProgramPolicy.minimumDurationSeconds) {
    set("R5", "failed", 1, `duration ${durationSeconds}s is below program minimum ${effectiveProgramPolicy.minimumDurationSeconds}s`);
  } else if (durationSeconds !== null && durationSeconds >= effectiveProgramPolicy.minimumDurationSeconds && liveVod === false) {
    set("R5", "observed", 1, `duration ${durationSeconds}s meets program minimum ${effectiveProgramPolicy.minimumDurationSeconds}s and is not a live VOD`);
  } else if (durationSeconds !== null && durationSeconds >= effectiveProgramPolicy.minimumDurationSeconds) {
    set("R5", "unknown", 0.8, `duration ${durationSeconds}s meets program minimum ${effectiveProgramPolicy.minimumDurationSeconds}s; live-VOD metadata unavailable`);
  }

  const languageCode = normalizeContentLanguage(
    sanitized.contentLanguage
      ?? sanitized.languageCode
      ?? youtubeMetadata.defaultLanguage
      ?? youtubeMetadata.defaultAudioLanguage
      ?? descriptionMetadata.languageCode,
  );
  if (languageCode) {
    const allowed = (XP_HERO_ALLOWED_CONTENT_LANGUAGE_CODES as readonly string[]).includes(languageCode);
    // Uploader-set YouTube language metadata is a HINT, not content truth (a creator can stamp a
    // wrong defaultAudioLanguage). A disallowed code at confidence 1 would become a decisive
    // canAutoReject failure on metadata alone — keep it below the 0.75 decisive threshold so it
    // lands in the human gate; the multimodal merge (R7 conflict → unknown) keeps media evidence
    // authoritative either way.
    set("R7", allowed ? "observed" : "failed", allowed ? 1 : 0.5, allowed ? `content language ${languageCode} is allowed` : `content language ${languageCode} is not allowed (uploader metadata hint — human confirmation)`);
  }

  return evidence;
}

function firstBoolean(values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    const normalized = text(value, 20).toLowerCase();
    if (["true", "yes", "present", "valid", "public", "allowed"].includes(normalized)) return true;
    if (["false", "no", "absent", "invalid", "private", "forbidden"].includes(normalized)) return false;
  }
  return null;
}

function firstFiniteNumber(values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return null;
}

function normalizeContentLanguage(value: unknown): string {
  const normalized = text(value, 80).toLowerCase().replace(/_/g, "-");
  if (!normalized) return "";
  const aliases: Record<string, string> = {
    english: "en", korean: "ko", german: "de", japanese: "ja", chinese: "zh", french: "fr", italian: "it",
    norwegian: "no", danish: "da", icelandic: "is", dutch: "nl", swedish: "sv", russian: "ru", hebrew: "he",
    spanish: "es", finnish: "fi", portuguese: "pt", thai: "th", turkish: "tr", filipino: "fil", tagalog: "fil",
    vietnamese: "vi", indonesian: "id", hindi: "hi", arabic: "ar",
    // Common platform/legacy BCP-47 aliases for languages explicitly allowed by policy.
    tl: "fil", iw: "he", in: "id", nb: "no", nn: "no",
  };
  return aliases[normalized] ?? normalized.split("-")[0];
}

function sourceEvidenceTimestamp(submission: Record<string, unknown>): string | null {
  // Generic updatedAtIso is deliberately excluded: recommendation persistence updates that
  // field and would otherwise change the submission fingerprint after every judge run,
  // defeating cache hits even though the underlying media/metadata stayed identical.
  const candidates = [
    submission.youtubeMetadataFetchedAtIso,
    asRecord(submission.youtubeMetadata).fetchedAtIso,
    asRecord(submission.uploadedMedia).verifiedAtIso,
    submission.submittedAtIso,
  ];
  for (const value of candidates) {
    const raw = text(value, 80);
    if (raw && Number.isFinite(Date.parse(raw))) return new Date(raw).toISOString();
  }
  return null;
}

export function videoReviewFeaturesFromSubmission(
  submission: SubmissionInput,
  programScope: VideoReviewProgramScope = videoReviewProgramScopeFromTrustedRecords({ submission }),
  registryOverride?: unknown,
): Record<string, unknown> & { submissionFingerprint: string } {
  const customLinkUsed = customLinkStatusFromSubmission(submission, programScope);
  const sanitized = pruneVideoReviewOutputFields(submission);
  const urls = collectUrlSignals(sanitized);
  const tracks = videoReviewTracksFromSignals(urls, sanitized);
  const rubricTitle = videoReviewRubricTitleFromSubmission(sanitized, programScope, registryOverride);
  const criteriaMetadata = videoReviewCriteriaPromptMetadata(rubricTitle);
  const effectiveProgramPolicy = videoReviewEffectiveProgramPolicy(programScope);
  const ruleApplicability = ruleApplicabilityForTracks(tracks, rubricTitle);
  const serverEvidence = serverVideoReviewEvidenceFromSubmission(submission, tracks, programScope, registryOverride);
  const formResponses = Array.isArray(sanitized.formResponses)
    ? sanitized.formResponses.slice(0, 20).flatMap((value) => {
      const row = asRecord(value);
      const key = text(row.fieldKey ?? row.key, 120);
      const label = text(row.fieldLabel ?? row.label, 180);
      const answer = text(row.answerText ?? row.value, 8000);
      if (!key && !label && !answer) return [];
      return [{ key, label, hasAnswer: Boolean(answer), answerUrlSignals: urlSignals(answer) }];
    })
    : [];
  const mediaIdentityFingerprint = videoReviewMediaIdentityFingerprint(sanitized);
  const features = {
    programScope: {
      scopeVersion: programScope.scopeVersion,
      canonicalProgramId: programScope.canonicalProgramId,
      policyConfigHash: programScope.policyConfigHash,
      effectivePolicy: effectiveProgramPolicy,
    },
    contentType: text(sanitized.contentType, 120),
    app: text(sanitized.app, 120),
    hasUploadedFile: Boolean(text(sanitized.uploadedFileUrl, 2000)),
    hasSubmitNote: Boolean(text(sanitized.submitNote, 8000)),
    // Full media identity (including canonical object path and authoritative generation when
    // available) contributes only as a one-way digest. Same-host videos therefore cannot share
    // a text-judge cache key, while signed query strings and raw object names never enter prompts.
    mediaIdentityFingerprint,
    reviewCriteria: {
      source: criteriaMetadata.source,
      policyVersion: VIDEO_REVIEW_POLICY_VERSION,
      rulecheckSummary: criteriaMetadata.rulecheckSummary,
      effectiveProgramPolicy,
      tracks,
      ruleApplicability,
    },
    urlSignals: urls,
    formResponses,
    deterministicChecks: {
      // R2 is description metadata. A submitted content URL or OneLink-looking hostname is
      // not evidence that the already-posted YouTube description contains the required link.
      customLinkUsed,
      hasPlayableUrl: urls.some((url) => url.validHttpUrl && !url.uploadedFile),
      hasMp4Upload: urls.some((url) => url.uploadedFile),
      hasKnownVideoHost: urls.some((url) => url.knownVideoHost),
      trackMetadata: {
        tracks,
        uploadedFile: tracks.includes("uploaded_file"),
        youtubeLink: tracks.includes("youtube_link"),
      },
      ruleApplicability,
      ruleEvidence: serverEvidence,
      ruleStatuses: {
        R1: ruleApplicability.R1.status,
        R2: ruleApplicability.R2.status === "applicable"
          ? customLinkUsed === true
            ? "metadata_description_custom_link_present"
            : customLinkUsed === false
              ? "metadata_description_custom_link_absent"
              : "metadata_only_unknown_description"
          : ruleApplicability.R2.status,
        R3: ruleApplicability.R3.status === "applicable" ? (urls.some((url) => url.validHttpUrl && url.knownVideoHost && !url.uploadedFile) ? "metadata_parse_pass_target_unknown" : "metadata_parse_unknown") : ruleApplicability.R3.status,
        R4: ruleApplicability.R4.status === "applicable" ? "unknown_video_or_relation_needed" : ruleApplicability.R4.status,
      },
    },
  };
  return { ...features, submissionFingerprint: sha256(JSON.stringify(features)) };
}

export function pruneVideoReviewOutputFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (VIDEO_LABEL_OUTPUT_KEYS.has(key)) continue;
    if (child && typeof child === "object" && !Array.isArray(child)) result[key] = pruneVideoReviewOutputFields(child);
    else if (Array.isArray(child)) result[key] = child.slice(0, 20).map((item) => typeof item === "object" ? pruneVideoReviewOutputFields(item) : item);
    else result[key] = child;
  }
  return result;
}

function collectUrlSignals(submission: Record<string, unknown>) {
  const urls = [
    { field: "youtubeUrl", value: submission.youtubeUrl, uploadedFile: false },
    { field: "videoUrl", value: submission.videoUrl, uploadedFile: false },
    { field: "reviewUrl", value: submission.reviewUrl, uploadedFile: false },
    { field: "tiktokUrl", value: submission.tiktokUrl, uploadedFile: false },
    { field: "instaUrl", value: submission.instaUrl ?? submission.instagramUrl, uploadedFile: false },
    { field: "uploadedFileUrl", value: directUploadedIdentityValue(submission) || canonicalUploadedIdentityValue(submission), uploadedFile: true },
  ];
  if (Array.isArray(submission.contentUrls)) {
    // writeVideoReviewDecision persists a derived contentUrls (union of the
    // named URL fields) back onto the submission. Counting those duplicates as
    // extra signals changed the submissionFingerprint after the first judged
    // run, so the judge cache could never hit on a re-judge (COST-P0-011).
    // Only genuinely new URLs contribute signals; the appended index keeps the
    // fingerprint identical whether or not duplicates are present.
    const namedValues = new Set(urls.map((item) => text(item.value, 2000)).filter(Boolean));
    let appended = 0;
    for (const value of submission.contentUrls) {
      const cleaned = text(value, 2000);
      if (!cleaned || namedValues.has(cleaned)) continue;
      namedValues.add(cleaned);
      urls.push({ field: `contentUrls[${appended}]`, value, uploadedFile: false });
      appended += 1;
    }
  }
  const uploadedGeneration = mediaGenerationForIdentity(submission);
  const seenSignals = new Set<string>();
  return urls.flatMap((item) => {
    const signal = urlSignals(item.value, item.uploadedFile, item.uploadedFile ? uploadedGeneration : "");
    if (!signal.rawPresent) return [];
    const key = `${item.uploadedFile}:${signal.identityHash}`;
    if (seenSignals.has(key)) return [];
    seenSignals.add(key);
    return [{ field: item.field, ...signal }];
  });
}

function videoReviewTracksFromSignals(urls: ReturnType<typeof collectUrlSignals>, submission: Record<string, unknown>): VideoReviewTrack[] {
  const tracks = new Set<VideoReviewTrack>();
  if (urls.some((url) => url.uploadedFile) || text(submission.uploadedFileUrl, 2000)) tracks.add("uploaded_file");
  if (urls.some((url) => !url.uploadedFile && isYoutubeHost(url.host))) tracks.add("youtube_link");
  return [...tracks].sort();
}

function isHostOrSubdomain(host: string, root: string): boolean {
  return host === root || host.endsWith(`.${root}`);
}

function isYoutubeHost(host: string): boolean {
  return host === "youtu.be" || isHostOrSubdomain(host, "youtube.com");
}

function isKnownVideoHost(host: string): boolean {
  return isYoutubeHost(host)
    || isHostOrSubdomain(host, "tiktok.com")
    || isHostOrSubdomain(host, "instagram.com")
    || host === "firebasestorage.googleapis.com";
}

function urlSignals(value: unknown, uploadedFile = false, generation = "") {
  const raw = text(value, 2000);
  if (!raw) return { rawPresent: false, validHttpUrl: false, host: "", pathHint: "", identityHash: "", knownVideoHost: false, uploadedFile };
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    return {
      rawPresent: true,
      validHttpUrl: parsed.protocol === "http:" || parsed.protocol === "https:",
      host,
      // URL paths can contain creator handles, object names, or access tokens. Host-level
      // signals are sufficient for deterministic routing and keep prompts free of raw PII.
      pathHint: "",
      identityHash: sha256(normalizeMediaIdentity(raw, generation)),
      knownVideoHost: isKnownVideoHost(host),
      uploadedFile,
    };
  } catch {
    return { rawPresent: true, validHttpUrl: false, host: "invalid", pathHint: "", identityHash: sha256(`invalid:${raw}:${generation}`), knownVideoHost: false, uploadedFile };
  }
}

export function videoReviewMediaIdentityFingerprint(submission: Record<string, unknown>): string {
  const identities: string[] = [];
  const generation = mediaGenerationForIdentity(submission);
  for (const value of [submission.youtubeUrl, submission.videoUrl, submission.reviewUrl]) {
    const raw = text(value, 2000);
    if (raw) identities.push(`video:${normalizeMediaIdentity(raw, "")}`);
  }
  const named = [
    ["tiktok", submission.tiktokUrl, ""],
    ["instagram", submission.instaUrl ?? submission.instagramUrl, ""],
    ["uploaded", directUploadedIdentityValue(submission) || canonicalUploadedIdentityValue(submission), generation],
  ] as const;
  for (const [field, value, mediaGeneration] of named) {
    const raw = text(value, 2000);
    if (raw) identities.push(`${field}:${normalizeMediaIdentity(raw, mediaGeneration)}`);
  }
  if (Array.isArray(submission.contentUrls)) {
    for (const value of submission.contentUrls) {
      const raw = text(value, 2000);
      if (raw) identities.push(`content:${normalizeMediaIdentity(raw, "")}`);
    }
  }
  return sha256(JSON.stringify([...new Set(identities)].sort()));
}

function normalizeMediaIdentity(raw: string, generation: string): string {
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (isYoutubeHost(host)) {
      const videoId = host === "youtu.be"
        ? parsed.pathname.split("/").filter(Boolean)[0] ?? ""
        : parsed.searchParams.get("v") ?? parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
      return `youtube:${videoId}`;
    }
    const storage = normalizedStorageIdentity(parsed);
    if (storage) return `${storage}${generation ? `:generation:${generation}` : ""}`;
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|signature|credential|authorization|expires|x-goog-/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    return `${parsed.protocol.toLowerCase()}//${host}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}${parsed.search}`;
  } catch {
    return `opaque:${raw}:${generation}`;
  }
}

function normalizedStorageIdentity(parsed: URL): string {
  if (parsed.protocol === "gs:") {
    return `gcs:${parsed.hostname.toLowerCase()}/${safeDecodeIdentity(parsed.pathname.replace(/^\/+/, ""))}`;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "firebasestorage.googleapis.com") {
    const match = parsed.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
    return match ? `gcs:${safeDecodeIdentity(match[1]).toLowerCase()}/${safeDecodeIdentity(match[2])}` : "";
  }
  if (host === "storage.googleapis.com") {
    const [, bucket = "", ...segments] = parsed.pathname.split("/");
    return bucket && segments.length ? `gcs:${safeDecodeIdentity(bucket).toLowerCase()}/${safeDecodeIdentity(segments.join("/"))}` : "";
  }
  if (host.endsWith(".storage.googleapis.com")) {
    return `gcs:${host.slice(0, -".storage.googleapis.com".length)}/${safeDecodeIdentity(parsed.pathname.replace(/^\/+/, ""))}`;
  }
  return "";
}

function mediaGenerationForIdentity(submission: Record<string, unknown>): string {
  const explicit = text(submission.uploadedFileGeneration, 80);
  if (explicit) return explicit;
  const media = asRecord(submission.uploadedMedia);
  const persisted = text(media.generation, 80);
  if (!persisted) return "";
  const direct = directUploadedIdentityValue(submission);
  if (!direct) return persisted;
  const directIdentity = normalizeMediaIdentity(direct, "");
  const canonical = canonicalUploadedIdentityValue(submission);
  return canonical && directIdentity === normalizeMediaIdentity(canonical, "") ? persisted : "";
}

function directUploadedIdentityValue(submission: Record<string, unknown>): string {
  return text(submission.uploadedFileUrl ?? submission.uploaded_file_url ?? submission.uploaded_file ?? submission.uploadedFile, 2000);
}

function canonicalUploadedIdentityValue(submission: Record<string, unknown>): string {
  const media = asRecord(submission.uploadedMedia);
  return text(submission.uploadedFileGcsUri, 2000)
    || text(media.gcsUri, 2000)
    || (text(media.bucket, 240) && text(media.objectPath, 1200) ? `gs://${text(media.bucket, 240)}/${text(media.objectPath, 1200)}` : "");
}

function safeDecodeIdentity(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export async function selectRecentVideoReviewFewShotCases(
  submission: SubmissionInput,
  options: { perVerdict?: number; ledgerLimit?: number; scope?: VideoReviewProgramScope } = {},
): Promise<VideoReviewFewShotCase[]> {
  const perVerdict = Math.max(1, Math.min(5, Math.floor(options.perVerdict ?? VIDEO_REVIEW_FEW_SHOT_PER_VERDICT)));
  const ledgerLimit = Math.max(perVerdict * 4, Math.min(500, Math.floor(options.ledgerLimit ?? VIDEO_REVIEW_FEW_SHOT_LEDGER_LIMIT)));
  const targetScope = options.scope ?? videoReviewProgramScopeFromTrustedRecords({ submission });
  const currentSubmissionId = cleanSubmissionId(submission.id);

  const snapshot = await adminDb.collection("review_ledger")
    .orderBy("createdAtIso", "desc")
    .limit(ledgerLimit)
    .get();

  const labeled = snapshot.docs.flatMap((doc) => {
    const ledger = doc.data() ?? {};
    const submissionId = cleanSubmissionId(ledger.submissionId);
    if (!submissionId || submissionId === currentSubmissionId) return [];
    const label = videoReviewLabelFromLedger(ledger);
    const canonicalProgramId = resolveCanonicalProgramId(ledger.canonicalProgramId ?? ledger.programId ?? ledger.gameId);
    const policyConfigHash = text(ledger.policyConfigHash, 64).toLowerCase();
    const decisionRef = immutableDecisionRefFromLedger(ledger);
    if (!label || !canonicalProgramId || !/^[a-f0-9]{64}$/.test(policyConfigHash) || !decisionRef) return [];
    if (!sameVideoReviewProgramScope({ canonicalProgramId, policyConfigHash }, targetScope)) return [];
    return [{ ledger, submissionId, label, canonicalProgramId, policyConfigHash, decisionRef }];
  });
  const decisionRefs = [...new Set(labeled.map((item) => item.decisionRef))]
    .map((ref) => adminDb.doc(ref));
  const decisionSnapshots = decisionRefs.length > 0 ? await adminDb.getAll(...decisionRefs) : [];
  const decisionByPath = new Map(decisionSnapshots.map((item) => [item.ref.path, item]));
  const candidates: VideoReviewFewShotCase[] = [];
  for (const { ledger, submissionId, label, canonicalProgramId, policyConfigHash, decisionRef } of labeled) {
    const decisionSnapshot = decisionByPath.get(decisionRef);
    if (!decisionSnapshot?.exists) continue;
    const decision = decisionSnapshot.data() ?? {};
    if (resolveCanonicalProgramId(decision.canonicalProgramId) !== canonicalProgramId
      || text(decision.policyConfigHash, 64).toLowerCase() !== policyConfigHash) continue;
    const features = compactFewShotFeatures(asRecord(decision.fewShotFeatures));
    const featureScope = asRecord(asRecord(features).programScope);
    if (text(featureScope.canonicalProgramId, 180) !== canonicalProgramId
      || text(featureScope.policyConfigHash, 64).toLowerCase() !== policyConfigHash) continue;
    // Only the review engine's closed reason code crosses the model boundary. Operator prose,
    // rejectedReason, feedback, and transition notes can contain names/phones/handles and are
    // deliberately never selected, even after redaction.
    const reason = promptSafeVideoReviewFewShotReason(text(ledger.reasonCode, 80), label);
    candidates.push({
      submissionId,
      submissionRef: submissionPath(submissionId),
      programId: canonicalProgramId,
      policyConfigHash,
      label,
      reason,
      decidedAtIso: text(ledger.createdAtIso ?? ledger.transitionedAtIso ?? asRecord(ledger.transition).decidedAtIso, 80),
      programMatch: true,
      features,
    });
  }
  return pickProgramScopedVideoReviewFewShotCases(candidates, targetScope, perVerdict);
}

function immutableDecisionRefFromLedger(ledger: Record<string, unknown>): string {
  const raw = text(ledger.decisionRef ?? asRecord(ledger.transition).decisionRef, 500);
  return /^video_review_decisions\/[A-Za-z0-9:._-]+$/.test(raw) ? raw : "";
}

export function pickProgramScopedVideoReviewFewShotCases(
  candidates: VideoReviewFewShotCase[],
  targetScope: Pick<VideoReviewProgramScope, "canonicalProgramId" | "policyConfigHash">,
  perVerdict = VIDEO_REVIEW_FEW_SHOT_PER_VERDICT,
): VideoReviewFewShotCase[] {
  const boundedPerVerdict = Math.max(1, Math.min(5, Math.floor(perVerdict)));
  const sameProgram = candidates.flatMap((item) => {
    const canonicalProgramId = resolveCanonicalProgramId(item.programId);
    if (!canonicalProgramId) return [];
    const candidateScope = item.policyConfigHash
      ? { canonicalProgramId, policyConfigHash: item.policyConfigHash }
      : videoReviewProgramScopeFromTrustedRecords({ submission: { programId: canonicalProgramId } });
    if (!sameVideoReviewProgramScope(candidateScope, targetScope)) return [];
    return [{
      ...item,
      programId: canonicalProgramId,
      policyConfigHash: candidateScope.policyConfigHash,
      programMatch: true,
    }];
  }).sort((left, right) => (
    right.decidedAtIso.localeCompare(left.decidedAtIso)
      || left.submissionId.localeCompare(right.submissionId)
  ));
  const picked: VideoReviewFewShotCase[] = [];
  for (const label of ["approval", "disapproval"] as const) {
    picked.push(...sameProgram.filter((item) => item.label === label).slice(0, boundedPerVerdict));
  }
  return picked.sort((left, right) => (
    left.label !== right.label
      ? left.label === "approval" ? -1 : 1
      : right.decidedAtIso.localeCompare(left.decidedAtIso) || left.submissionId.localeCompare(right.submissionId)
  ));
}

export function hashVideoReviewFewShotCases(cases: VideoReviewFewShotCase[]): string {
  if (!cases.length) return "no-few-shot";
  return sha256(JSON.stringify(cases.map((item) => ({
    submissionId: item.submissionId,
    programId: resolveCanonicalProgramId(item.programId),
    policyConfigHash: item.policyConfigHash,
    label: item.label,
    reason: item.reason,
    features: item.features,
  }))));
}

export function maskSensitiveText(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[phone]")
    .replace(/(^|\s)@[A-Za-z0-9_.-]{2,}/g, "$1[handle]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]")
    .replace(/\b(token|secret|password|authorization|bearer)\s*[:=]\s*[\w.-]+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]");
}

export function promptSafeVideoReviewFewShotReason(
  value: unknown,
  label: VideoReviewFewShotCase["label"] = "disapproval",
): string {
  const reasonCode = text(value, 80).toLowerCase();
  if (VIDEO_REVIEW_FEW_SHOT_REASON_CODES.has(reasonCode)) return reasonCode;
  return label === "approval" ? "approved" : "quality_issue";
}

function videoReviewLabelFromLedger(ledger: Record<string, unknown>): VideoReviewFewShotCase["label"] | null {
  const reviewStatus = canonicalReviewStatus(text(ledger.reviewStatus, 80).toLowerCase());
  const status = canonicalReviewStatus(text(ledger.status, 80).toLowerCase());
  if (reviewStatus === "approved" || status === "approved") return "approval";
  if (reviewStatus === "rejected" || status === "blocked") return "disapproval";
  return null;
}

export function compactFewShotFeatures(features: Record<string, unknown>): Record<string, unknown> {
  return {
    programScope: features.programScope,
    app: features.app,
    contentType: features.contentType,
    hasUploadedFile: features.hasUploadedFile,
    deterministicChecks: features.deterministicChecks,
    urlSignals: Array.isArray(features.urlSignals) ? features.urlSignals.slice(0, 8) : [],
    formResponses: Array.isArray(features.formResponses) ? features.formResponses.slice(0, 8) : [],
  };
}

export function videoReviewPrompt(features: Record<string, unknown>, fewShotCases: VideoReviewFewShotCase[]): string {
  const fewShotBlock = fewShotCases.length
    ? JSON.stringify({
      caseSetHash: hashVideoReviewFewShotCases(fewShotCases),
      instructions: "These are recent human-finalized examples. Use them as calibration only; outcome labels and label counts are intentionally excluded from prompt context.",
      cases: fewShotCases.map((item) => ({
        caseRef: sha256(item.submissionId).slice(0, 12),
        reasonCode: promptSafeVideoReviewFewShotReason(item.reason, item.label),
        programMatch: item.programMatch,
        features: item.features,
      })),
    })
    : "[]";
  return [
    "You are Judge B for Super Creator Partners video review.",
    "Use only the supplied metadata and URL signals. You cannot inspect video pixels/audio, so mark uncertain content as unknown or needs_review.",
    `The complete versioned XP Hero policy ${VIDEO_REVIEW_POLICY_VERSION} (R1-R24) is authoritative; apply only rule-safe evidence and do not import case-level examples.`,
    `Criteria/rulecheck metadata: ${videoReviewCriteriaPromptBlock()}`,
    "Track behavior: uploaded_file has video content but no YouTube description/link metadata at this stage; youtube_link can have posted-video metadata. R2 custom-link and R3 link-validity checks are metadata/rulecheck boundaries, not pixel/audio judgments. checks.customLinkUsed MUST copy deterministicChecks.customLinkUsed exactly; null means unknown and MUST NOT cause disapproval or the reason 커스텀링크 미사용.",
    "R4 must use checks.duplicationOrOriginality. Do not overload contentRelevance, gameplayDepth, or linkValidity for duplication/originality. For text-only Judge B, duplicate/simple-reupload evidence is unknown unless supplied metadata is decisive.",
    "Return an evidence array, but do not repeat server-owned deterministic/metadata rows. This text-only lane should normally return [] because the server completes the final R1-R24 evidence ledger. Never fabricate unavailable evidence.",
    "Human-only rules R14 and R16-R24 can never be failed by this model. Keep them unknown for a human or approved analytics/rights workflow.",
    "Return strict JSON matching the schema. Verdict approval means likely acceptable; disapproval means likely reject; needs_review means human should inspect.",
    "Set disapprovalProbability from 0 to 100 as the estimated rejection probability for the card UI.",
    `Preferred reason vocabulary: ${VIDEO_REVIEW_REASONS.join(", ")}.`,
    "Calibrate with the server-selected recent confirmed cases below when present. The cases are PII-masked and exclude human outcome labels/counts.",
    `Recent confirmed cases: ${fewShotBlock}`,
    "Never include email, submit tokens, prior review status, payment state, review notes, or raw prompt text in the answer.",
    JSON.stringify(videoReviewPromptFeatures(features)),
  ].join("\n");
}

export function videoReviewPromptFeatures(features: Record<string, unknown>): Record<string, unknown> {
  const deterministic = asRecord(features.deterministicChecks);
  const ruleEvidence = Array.isArray(deterministic.ruleEvidence)
    ? deterministic.ruleEvidence.map(asRecord).filter((item) => {
      const applicability = text(item.applicability, 40);
      return applicability !== "not_applicable" && (text(item.status, 40) !== "unknown" || numberValue(item.confidence) > 0);
    }).map((item) => ({
      ruleId: text(item.ruleId, 20),
      status: text(item.status, 20),
      confidence: clampConfidence(item.confidence),
      summary: safeEvidenceText(item.summary, 300),
      observedAtIso: normalizedIsoOrNull(item.observedAtIso),
    }))
    : [];
  return {
    programScope: features.programScope,
    contentType: features.contentType,
    app: features.app,
    hasUploadedFile: features.hasUploadedFile,
    hasSubmitNote: features.hasSubmitNote,
    reviewCriteria: features.reviewCriteria,
    urlSignals: features.urlSignals,
    formResponses: features.formResponses,
    deterministicChecks: {
      customLinkUsed: deterministic.customLinkUsed,
      hasPlayableUrl: deterministic.hasPlayableUrl,
      hasMp4Upload: deterministic.hasMp4Upload,
      hasKnownVideoHost: deterministic.hasKnownVideoHost,
      trackMetadata: deterministic.trackMetadata,
      ruleApplicability: deterministic.ruleApplicability,
      ruleEvidence,
    },
  };
}

export function normalizeVideoReviewVerdict(
  value: unknown,
  features: Record<string, unknown>,
  context: VideoReviewNormalizationContext = {},
): VideoReviewVerdict {
  const record = asRecord(value);
  const checks = asRecord(record.checks);
  const deterministic = asRecord(features.deterministicChecks);
  // The model cannot inspect a YouTube description from video pixels/audio. Ignore its boolean
  // unless server-enriched deterministic metadata has an authoritative true/false value.
  const customLinkUsed = typeof deterministic.customLinkUsed === "boolean" ? deterministic.customLinkUsed : null;
  const rawReasons = stringList(record.reasons).filter((reason) => VIDEO_REVIEW_REASON_SET.has(reason));
  const reasons = rawReasons.filter((reason) => customLinkUsed === false || !isCustomLinkFailureReason(reason));
  const contentRelevance = enumString(checks.contentRelevance, ["strong", "weak", "unknown"], "unknown");
  const gameplayDepth = enumString(checks.gameplayDepth, ["good", "simple", "unknown"], "unknown");
  const linkValidity = enumString(checks.linkValidity, ["valid", "invalid", "unknown"], "unknown");
  const publicAccess = enumString(checks.publicAccess, ["public", "private", "unknown"], "unknown");
  const duplicationOrOriginality = enumString(checks.duplicationOrOriginality, ["original", "duplicate_or_reused", "simple_reupload", "unknown"], "unknown");
  const rawVerdict = record.verdict === "approval" || record.verdict === "disapproval" || record.verdict === "needs_review" ? record.verdict : "needs_review";
  const evidence = normalizeVideoReviewEvidence(record.evidence, deterministic.ruleEvidence, {
    ...context,
    legacyChecks: { contentRelevance, gameplayDepth, duplicationOrOriginality },
  });
  const decisiveFailures = evidence.filter((item) => {
    const descriptor = videoReviewRuleById(item.ruleId);
    return item.applicability !== "not_applicable" && item.status === "failed" && item.confidence >= 0.75 && descriptor?.canAutoReject === true;
  });
  // W107 T3: human_only-flagged rules (R10, R11, R14, R16-R24 -- descriptor.requiresHumanConfirmation)
  // are always unknown/low-confidence by construction (see the human_only branch in
  // normalizeVideoReviewEvidence below and the rule() default in videoReviewCriteria.ts) and can
  // never gather AI evidence. Keeping them in the verdict-override trigger pinned verdict to
  // needs_review on every submission regardless of evidence quality -- W107 T0 receipt: 47/47
  // live-lane decisions landed needs_review, and "AI approval" was a code-level unreachable label.
  // They still appear in humanGate.ruleIds for the operator checklist below; only genuinely
  // AI-judgeable rule uncertainty (unknown / an uncoverable failed / low confidence) now gates
  // the verdict itself. See diagnosis doc "확정 사실 1".
  const humanGateChecklistRuleIds = evidence.flatMap((item) => {
    const descriptor = videoReviewRuleById(item.ruleId);
    return descriptor && item.applicability !== "not_applicable" && descriptor.requiresHumanConfirmation ? [item.ruleId] : [];
  });
  const humanGateTriggerRuleIds = evidence.flatMap((item) => {
    const descriptor = videoReviewRuleById(item.ruleId);
    if (!descriptor || item.applicability === "not_applicable" || descriptor.requiresHumanConfirmation) return [];
    if (item.status === "unknown") return [item.ruleId];
    if (item.status === "failed" && !descriptor.canAutoReject) return [item.ruleId];
    if (item.confidence < 0.75) return [item.ruleId];
    return [];
  });
  const humanGateRuleIds = [...new Set([...humanGateTriggerRuleIds, ...humanGateChecklistRuleIds])];
  const humanGate: VideoReviewHumanGate = {
    required: humanGateTriggerRuleIds.length > 0,
    ruleIds: humanGateRuleIds,
    reasons: [...new Set(humanGateRuleIds.flatMap((ruleId) => {
      const descriptor = videoReviewRuleById(ruleId);
      const item = evidence.find((candidate) => candidate.ruleId === ruleId);
      return descriptor ? [`${ruleId} ${descriptor.name}: ${item?.summary || descriptor.reason}`] : [];
    }))].slice(0, 24),
  };
  const evidenceVerdict: VideoReviewVerdictValue = decisiveFailures.length > 0 ? "disapproval" : rawVerdict;
  const normalizedVerdict: VideoReviewVerdictValue = humanGate.required ? "needs_review" : evidenceVerdict;
  const rawProbability = normalizeDisapprovalProbability(record);
  const failureReasons = decisiveFailures.flatMap((item) => {
    const descriptor = videoReviewRuleById(item.ruleId);
    return descriptor ? [descriptor.reason] : [];
  });
  const normalized: VideoReviewVerdict = {
    verdict: normalizedVerdict,
    // W107 T4: the previous min(50, x)/max(70, x) clamp only ever displayed two probability
    // bands (0-30% / 50-100%), so 31-49% disapproval (51-69% shown "AI 합격 확률") was structurally
    // unreachable -- it drew the human-gate boolean as if it were a probability (diagnosis doc
    // "확정 사실 2"). decisiveFailures already forces the verdict itself to "disapproval"
    // independent of this number, so there is no correctness reason left to distort it; the
    // model's own calibrated estimate is surfaced as-is.
    disapprovalProbability: rawProbability,
    reasons: [...new Set([...failureReasons, ...reasons])].slice(0, 8),
    checks: {
      customLinkUsed,
      contentRelevance,
      gameplayDepth,
      linkValidity,
      publicAccess,
      duplicationOrOriginality,
    },
    policyFlags: canonicalVideoReviewRuleIds(record.policyFlags),
    missingFields: [...new Set([
      ...canonicalVideoReviewRuleIds(record.missingFields),
      ...evidence.filter((item) => item.applicability !== "not_applicable" && item.status === "unknown").map((item) => item.ruleId),
    ])].slice(0, 24),
    policyVersion: VIDEO_REVIEW_POLICY_VERSION,
    evidence,
    humanGate,
  };
  if (!normalized.reasons.length && normalized.verdict !== "approval") normalized.reasons = ["사람 검토 필요"];
  return normalized;
}

function canonicalVideoReviewRuleIds(value: unknown): string[] {
  return stringList(value)
    .map((item) => item.toUpperCase())
    .filter((item) => VIDEO_REVIEW_RULE_ID_SET.has(item));
}

function normalizeVideoReviewEvidence(
  modelValue: unknown,
  serverValue: unknown,
  context: VideoReviewNormalizationContext & { legacyChecks: Pick<VideoReviewChecks, "contentRelevance" | "gameplayDepth" | "duplicationOrOriginality"> },
): VideoReviewRuleEvidence[] {
  const serverRows = Array.isArray(serverValue) ? serverValue.map(asRecord) : [];
  const modelRows = Array.isArray(modelValue) ? modelValue.map(asRecord) : [];
  const serverByRule = new Map(serverRows.map((item) => [text(item.ruleId, 20), item]));
  const modelByRule = new Map(modelRows.map((item) => [text(item.ruleId, 20), item]));
  const modality = context.modality ?? "text";

  return VIDEO_REVIEW_RULES.map((descriptor) => {
    const server = serverByRule.get(descriptor.id);
    const applicability = enumString(server?.applicability, ["applicable", "not_applicable", "unknown"] as const, "applicable");
    const serverStatus = enumString(server?.status, ["observed", "unknown", "failed"] as const, applicability === "not_applicable" ? "observed" : "unknown");
    let evidence = evidenceFromRecord(server, descriptor, {
      applicability,
      status: serverStatus,
      provider: "server",
      modelId: null,
      mediaFingerprint: null,
      observedAtIso: text(server?.observedAtIso, 80) || null,
    });

    if (descriptor.assessment === "human_only") {
      return {
        ...evidence,
        status: "unknown",
        confidence: 0,
        summary: "human/approved analytics or rights evidence required",
        provider: "unknown",
        modelId: null,
      };
    }

    if (descriptor.assessment === "multimodal" && modality === "multimodal") {
      const model = modelByRule.get(descriptor.id) ?? legacyMultimodalEvidence(descriptor.id, context.legacyChecks);
      if (model) {
        const modelStatus = enumString(model.status, ["observed", "unknown", "failed"] as const, "unknown");
        const modelEvidence = evidenceFromRecord(model, descriptor, {
          applicability,
          status: modelStatus,
          provider: context.provider === "vertex" ? "vertex" : "unknown",
          modelId: text(context.modelId, 120) || null,
          mediaFingerprint: text(context.mediaFingerprint, 160) || null,
          observedAtIso: normalizedIsoOrNull(context.observedAtIso),
          summaryOverride: modelStatus === "failed" && !descriptor.canAutoReject
            ? `${safeEvidenceText(model.summary, 220)}; model flag requires human confirmation`
            : undefined,
        });
        // YouTube language metadata is a hint, while the attached media can provide direct
        // spoken/written-language evidence. Never let one silently override the other: a
        // disagreement is an explicit unknown row that forces the human gate.
        if (descriptor.id === "R7" && evidence.status !== "unknown" && modelStatus !== "unknown" && evidence.status !== modelStatus) {
          return {
            ...modelEvidence,
            status: "unknown",
            confidence: 0,
            summary: "conflicting platform metadata and sampled-media language evidence; human confirmation required",
            provider: "unknown",
          };
        }
        if (evidence.status === "unknown") evidence = modelEvidence;
      }
    }
    return evidence;
  });
}

function evidenceFromRecord(
  value: Record<string, unknown> | undefined,
  descriptor: (typeof VIDEO_REVIEW_RULES)[number],
  fallback: {
    applicability: VideoReviewRuleEvidence["applicability"];
    status: VideoReviewRuleEvidenceStatus;
    provider: VideoReviewRuleEvidence["provider"];
    modelId: string | null;
    mediaFingerprint: string | null;
    observedAtIso: string | null;
    summaryOverride?: string;
  },
): VideoReviewRuleEvidence {
  const timestampValue = value?.timestampMs;
  const timestamp = timestampValue === null || timestampValue === undefined || timestampValue === "" ? Number.NaN : Number(timestampValue);
  const timestampMs = Number.isFinite(timestamp) && timestamp >= 0 ? Math.round(timestamp) : null;
  const mediaFingerprint = fallback.provider === "vertex" ? safeMediaFingerprint(fallback.mediaFingerprint) : null;
  return {
    ruleId: descriptor.id,
    ruleKey: descriptor.key,
    ruleName: descriptor.name,
    assessment: descriptor.assessment,
    applicability: fallback.applicability,
    status: fallback.status,
    confidence: clampConfidence(value?.confidence),
    summary: safeEvidenceText(fallback.summaryOverride ?? value?.summary ?? (fallback.status === "unknown" ? "evidence unavailable" : descriptor.statement), 300),
    observedAtIso: fallback.observedAtIso,
    timestampMs,
    frameRef: fallback.provider === "vertex"
      ? boundModelEvidenceRef("frame", value?.frameRef, timestampMs, mediaFingerprint)
      : safeEvidenceRef(value?.frameRef),
    transcriptRef: fallback.provider === "vertex"
      ? boundModelEvidenceRef("transcript", value?.transcriptRef, timestampMs, mediaFingerprint)
      : safeEvidenceRef(value?.transcriptRef),
    mediaFingerprint,
    provider: fallback.provider,
    modelId: fallback.modelId,
    policyVersion: VIDEO_REVIEW_POLICY_VERSION,
  };
}

function safeMediaFingerprint(value: unknown): string | null {
  const fingerprint = text(value, 160).toLowerCase();
  return /^[a-f0-9]{32,128}$/.test(fingerprint) ? fingerprint : null;
}

function boundModelEvidenceRef(
  kind: "frame" | "transcript",
  claimedRef: unknown,
  timestampMs: number | null,
  mediaFingerprint: string | null,
): string | null {
  const safeClaimedRef = safeEvidenceRef(claimedRef);
  if (!safeClaimedRef || timestampMs === null || !mediaFingerprint) return null;
  return `${kind}:${sha256(mediaFingerprint).slice(0, 16)}:${timestampMs}`;
}

function legacyMultimodalEvidence(
  ruleId: string,
  checks: Pick<VideoReviewChecks, "contentRelevance" | "gameplayDepth" | "duplicationOrOriginality">,
): Record<string, unknown> | undefined {
  // W107 T3 (leader report item): this fallback only fires when the model omitted an explicit
  // R1/R4 evidence row and falls back to the older checks.* fields. The 0.7 constant predates the
  // confidence<0.75 human-gate threshold below and sat just under it, so R1/R4 were silently
  // gated on every legacy-shaped response even with a clean "strong"/"good" read. Raised to 0.75
  // (the threshold itself) rather than papering over it with a gate exception: these are decisive
  // legacy classifications (strong/weak, good/simple), not low-confidence guesses, so treating
  // them as gate-clearing is consistent with how the same fields are read elsewhere in this file.
  const LEGACY_CONFIDENCE = 0.75;
  if (ruleId === "R1" && checks.contentRelevance !== "unknown") {
    return {
      status: checks.contentRelevance === "strong" ? "observed" : "failed",
      confidence: LEGACY_CONFIDENCE,
      summary: checks.contentRelevance === "strong" ? "model observed XP Hero as the primary subject" : "model flagged weak XP Hero relevance",
    };
  }
  if (ruleId === "R4") {
    if (checks.duplicationOrOriginality === "original" && checks.gameplayDepth === "good") {
      return { status: "observed", confidence: LEGACY_CONFIDENCE, summary: "model observed creator-added editing/originality" };
    }
    if (["duplicate_or_reused", "simple_reupload"].includes(checks.duplicationOrOriginality) || checks.gameplayDepth === "simple") {
      return { status: "failed", confidence: LEGACY_CONFIDENCE, summary: "model flagged raw, duplicate, or simple-reupload content" };
    }
  }
  return undefined;
}

function clampConfidence(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, Math.round(numeric * 1000) / 1000));
}

function safeEvidenceText(value: unknown, max: number): string {
  return maskSensitiveText(text(value, max))
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, max) || "evidence unavailable";
}

function safeEvidenceRef(value: unknown): string | null {
  const masked = maskSensitiveText(text(value, 160));
  if (/\[(?:email|redacted)\]/i.test(masked)) return null;
  const ref = masked.replace(/[^a-zA-Z0-9_.:+\-]/g, "");
  return ref || null;
}

function normalizedIsoOrNull(value: unknown): string | null {
  const raw = text(value, 80);
  return raw && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
}

function isCustomLinkFailureReason(reason: string): boolean {
  const mentionsLink = /링크|url|uri|onelink|\blink\b|deep\s*link|custom\s*link/i.test(reason);
  const saysMissing = /미사용|미기재|누락|없(?:음|습니다|다)|(?:찾|확인)\S*\s*수\s*없|(?:포함|기재|제공)(?:되어)?\s*있지\s*않|(?:포함|기재|제공)되지\s*않|존재하지\s*않|보이지\s*않|missing|absent|unused|omitt(?:ed|ing)|lacks?|not\s+(?:present|found|included|provided|used)|does\s+not\s+(?:contain|include|provide)|without|no\s+(?:required\s+)?(?:custom\s+)?(?:url|link|onelink)/i.test(reason);
  return mentionsLink && saysMissing;
}

function normalizeDisapprovalProbability(record: Record<string, unknown>): number {
  if (Number.isFinite(Number(record.disapprovalProbability))) {
    return clampNumber(record.disapprovalProbability, 0, 100);
  }
  if (Number.isFinite(Number(record.approvalProbability))) {
    return 100 - clampNumber(record.approvalProbability, 0, 100);
  }
  if (record.verdict === "approval") return 10;
  if (record.verdict === "disapproval") return 90;
  return 50;
}

async function resolveSubmissionInputs(input: VideoReviewJudgeInput): Promise<SubmissionInput[]> {
  // Client-supplied inline submission objects are a dry-run preview affordance
  // only. In a persisting run they are ignored so the judge can never write
  // attacker-controlled status/email/token fields to the ledger (N-2/N-3):
  // authoritative submissions are re-fetched by id below.
  const dryRun = input.dryRun === true;
  const inline = dryRun && Array.isArray(input.submissions) ? input.submissions.map(asRecord) : [];
  const ids = stringArray(input.submissionIds).concat(stringArray(input.submissionRefs).map((ref) => ref.split("/").pop() ?? ""));
  const uniqueIds = [...new Set(ids.map(cleanSubmissionId).filter(Boolean))];
  const fetched: SubmissionInput[] = [];
  for (const id of uniqueIds) {
    const snapshot = await adminDb.collection("submissions").doc(id).get();
    if (snapshot.exists) fetched.push(markAuthoritativeVideoSubmission({ id: snapshot.id, ...snapshot.data() }));
    else fetched.push({ id, missing: true });
  }
  return [...fetched, ...inline].slice(0, 25);
}

function markAuthoritativeVideoSubmission(submission: SubmissionInput): ResolvedSubmissionInput {
  Object.defineProperty(submission, AUTHORITATIVE_VIDEO_SUBMISSION, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return submission as ResolvedSubmissionInput;
}

async function videoReviewProgramScopeForJudgeInput(submission: ResolvedSubmissionInput): Promise<VideoReviewProgramScope> {
  if (submission[AUTHORITATIVE_VIDEO_SUBMISSION] === true) {
    return resolveAuthoritativeVideoReviewProgramScope(submission);
  }

  // Inline records are a non-persisting preview surface. A caller cannot select an
  // arbitrary program (and therefore its policy/few-shot/cache namespace) by posting
  // `programId`. Only the legacy SCP-shaped preview is supported without a stored
  // submission/task/application chain; the program fields themselves are discarded.
  const contentType = text(submission.contentType, 160).toLowerCase();
  const source = text(submission.source ?? submission.sourceType, 160).toLowerCase();
  const legacyScpPreview = contentType.includes("scp")
    || source.startsWith("scp_")
    || source === "google_sheet";
  if (!legacyScpPreview) throw programScopeError("video_review_program_scope_unresolved");
  const trustedLegacySubmission = { ...submission };
  delete trustedLegacySubmission.programId;
  delete trustedLegacySubmission.canonicalProgramId;
  return videoReviewProgramScopeFromTrustedRecords({ submission: trustedLegacySubmission });
}

function videoReviewProgramScopePublicErrorCode(error: unknown): VideoReviewPublicErrorCode | null {
  const code = closedScalarField(error, "code");
  return code === "video_review_program_scope_unresolved"
    || code === "video_review_program_scope_ambiguous"
    || code === "video_review_program_scope_changed"
    ? code
    : null;
}

async function videoReviewCacheLookup(
  cacheKey: string,
  features: Record<string, unknown>,
  scope: VideoReviewProgramScope,
): Promise<CachePayload | null> {
  const snapshot = await adminDb.collection(VIDEO_REVIEW_JUDGE_CACHE_COLLECTION).doc(cacheKey).get();
  if (!snapshot.exists) return null;
  const data = snapshot.data() ?? {};
  const selectedModelId = selectVertexModelForTask(VIDEO_REVIEW_JUDGE_MODEL_TASK);
  // Treat legacy transport-bearing cache documents as misses. The miss path writes
  // the module-owned document with merge:false, removing provider/run/capability
  // fields even when the legacy entry has not expired yet. A cache identity is also
  // usable only when its durable model matches the current allowlisted selection.
  if (hasVideoReviewCacheTransportMetadata(data) || text(data.modelId, 120) !== selectedModelId) return null;
  if (text(data.policyVersion, 120) !== VIDEO_REVIEW_POLICY_VERSION) return null;
  if (text(data.canonicalProgramId, 180) !== scope.canonicalProgramId) return null;
  if (text(data.policyConfigHash, 64) !== scope.policyConfigHash) return null;
  const expiresAtMs = typeof data.expiresAtMs === "number" ? data.expiresAtMs : Number.NaN;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;
  // Re-apply deterministic metadata on cache hits. In particular, authoritative R2
  // true/false/unknown must not collapse to null merely because the model was skipped.
  const verdict = normalizeVideoReviewVerdict(data.verdict, features);
  return {
    verdict,
    modelId: selectedModelId,
    inputTokens: numberValue(data.inputTokens),
    outputTokens: numberValue(data.outputTokens),
    estimatedCostUsd: numberValue(data.estimatedCostUsd),
  };
}

function hasVideoReviewCacheTransportMetadata(data: Record<string, unknown>): boolean {
  return videoReviewJudgeCacheEntryHasTransportMetadata(data);
}

export function videoReviewJudgeCacheEntryHasTransportMetadata(value: unknown): boolean {
  const state = { remaining: 512, seen: new WeakSet<object>() };
  const visit = (candidate: unknown, depth: number): boolean => {
    if (!candidate || typeof candidate !== "object") return false;
    if (depth > 12 || state.remaining <= 0) return true;
    state.remaining -= 1;
    const objectValue = candidate as object;
    if (state.seen.has(objectValue)) return true;
    state.seen.add(objectValue);
    if (Array.isArray(candidate)) return candidate.some((item) => visit(item, depth + 1));
    for (const [field, nested] of Object.entries(candidate as Record<string, unknown>)) {
      const normalizedField = field.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (VIDEO_REVIEW_CACHE_TRANSPORT_FIELDS.has(normalizedField)) return true;
      // The root cache modelId is an independently validated allowlisted identity.
      // Any nested model identity came from an older verdict/provider envelope and
      // must be treated as transport metadata so the entry is recomputed and scrubbed.
      if (depth > 0 && normalizedField === "modelid") return true;
      if (visit(nested, depth + 1)) return true;
    }
    return false;
  };
  return visit(value, 0);
}

export function videoReviewJudgeCacheVerdictForPersistence(
  verdict: VideoReviewVerdict,
): VideoReviewCachedVerdict {
  return {
    verdict: verdict.verdict,
    disapprovalProbability: verdict.disapprovalProbability,
    reasons: [...verdict.reasons],
    checks: { ...verdict.checks },
    policyFlags: [...verdict.policyFlags],
    missingFields: [...verdict.missingFields],
    policyVersion: verdict.policyVersion,
    evidence: verdict.evidence.map((item) => ({
      ruleId: item.ruleId,
      ruleKey: item.ruleKey,
      ruleName: item.ruleName,
      assessment: item.assessment,
      applicability: item.applicability,
      status: item.status,
      confidence: item.confidence,
      summary: item.summary,
      observedAtIso: item.observedAtIso,
      timestampMs: item.timestampMs,
      frameRef: item.frameRef,
      transcriptRef: item.transcriptRef,
      mediaFingerprint: item.mediaFingerprint,
      policyVersion: item.policyVersion,
    })),
    humanGate: {
      required: verdict.humanGate.required,
      ruleIds: [...verdict.humanGate.ruleIds],
      reasons: [...verdict.humanGate.reasons],
    },
  };
}

async function videoReviewCacheStore(
  cacheKey: string,
  submissionFingerprint: string,
  scope: VideoReviewProgramScope,
  payload: CachePayload,
) {
  await adminDb.collection(VIDEO_REVIEW_JUDGE_CACHE_COLLECTION).doc(cacheKey).set({
    verdict: videoReviewJudgeCacheVerdictForPersistence(payload.verdict),
    modelId: payload.modelId,
    inputTokens: payload.inputTokens,
    outputTokens: payload.outputTokens,
    estimatedCostUsd: payload.estimatedCostUsd,
    submissionFingerprint,
    canonicalProgramId: scope.canonicalProgramId,
    policyConfigHash: scope.policyConfigHash,
    programScopeVersion: scope.scopeVersion,
    policyVersion: VIDEO_REVIEW_POLICY_VERSION,
    expiresAtMs: Date.now() + VIDEO_REVIEW_JUDGE_CACHE_TTL_SECONDS * 1000,
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: false });
}

async function writeVideoReviewDecision(input: {
  submissionId: string;
  submissionRef: string;
  decisionRef: FirebaseFirestore.DocumentReference;
  verdict: VideoReviewVerdict;
  finalStatus: VideoReviewFinalStatus;
  finalReason: string | null;
  decidedBy: string;
  decidedAtIso: string;
  mode: string;
  modelId: string;
  cacheHit: boolean;
  scope: VideoReviewProgramScope;
  fewShotFeatures: Record<string, unknown>;
}) {
  const aiRecommendation = {
    ...input.verdict,
    modelId: input.modelId,
    decisionRef: input.decisionRef.path,
    source: "judge_video_review",
    generatedAtIso: input.decidedAtIso,
    canonicalProgramId: input.scope.canonicalProgramId,
    policyConfigHash: input.scope.policyConfigHash,
    programScopeVersion: input.scope.scopeVersion,
    effectiveVideoReviewPolicy: videoReviewEffectiveProgramPolicy(input.scope),
  };
  const submissionRef = adminDb.collection("submissions").doc(input.submissionId);
  await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(submissionRef);
    if (!snapshot.exists) throw programScopeError("video_review_program_scope_changed");
    const currentSubmission: Record<string, unknown> & { id: string } = {
      id: snapshot.id,
      ...(snapshot.data() ?? {}),
    };
    const currentScope = await resolveAuthoritativeVideoReviewProgramScope(currentSubmission, {
      recordReader: async (collection, documentId) => {
        const linked = await transaction.get(adminDb.collection(collection).doc(documentId));
        return linked.exists ? { id: linked.id, ...(linked.data() ?? {}) } : null;
      },
    });
    if (!sameVideoReviewProgramScope(currentScope, input.scope)) {
      throw programScopeError("video_review_program_scope_changed");
    }
    transaction.set(input.decisionRef, {
      id: input.decisionRef.id,
      submissionId: input.submissionId,
      submissionRef: input.submissionRef,
      canonicalProgramId: input.scope.canonicalProgramId,
      policyConfigHash: input.scope.policyConfigHash,
      programScopeVersion: input.scope.scopeVersion,
      effectiveVideoReviewPolicy: videoReviewEffectiveProgramPolicy(input.scope),
      mode: input.mode,
      aiRecommendation,
      policyVersion: VIDEO_REVIEW_POLICY_VERSION,
      reviewCriteria: videoReviewCriteriaMetadata(),
      finalStatus: input.finalStatus,
      finalReason: input.finalReason,
      decidedBy: input.decidedBy,
      decidedAtIso: input.decidedAtIso,
      cacheHit: input.cacheHit,
      fewShotFeatures: input.fewShotFeatures,
      auditRef: "callable:judgeVideoReview",
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: false });
    // Only AI-recommendation outputs and server-derived pointers are written back
    // onto the submission. Client/inline-supplied identity, contact, URL, status,
    // reviewStatus, rejectedReason, token and payment fields are NEVER persisted.
    const scopeKey = videoReviewProgramScopeKey(input.scope);
    const existingScopeProjection = asRecord(asRecord(currentSubmission.videoReviewByScope)[scopeKey]);
    const scopedProjection = {
      ...existingScopeProjection,
      canonicalProgramId: input.scope.canonicalProgramId,
      policyConfigHash: input.scope.policyConfigHash,
      programScopeVersion: input.scope.scopeVersion,
      text: {
        aiRecommendation: { ...aiRecommendation, reviewCriteria: videoReviewCriteriaMetadata() },
        latestVideoReviewDecisionRef: input.decisionRef.path,
        updatedAtIso: input.decidedAtIso,
      },
    };
    transaction.update(submissionRef, videoReviewScopePreservingSubmissionUpdate({
      videoReviewByScope: { [scopeKey]: scopedProjection },
      ...(input.scope.canonicalProgramId === SCP_CANONICAL_PROGRAM_ID ? {
        aiRecommendation: { ...aiRecommendation, reviewCriteria: videoReviewCriteriaMetadata() },
        latestVideoReviewDecisionRef: input.decisionRef.path,
      } : {}),
      updatedAtIso: input.decidedAtIso,
      updatedAt: FieldValue.serverTimestamp(),
    }));
  });
}

// Honest run-mode label: a non-dryRun run reports the environment it actually
// persisted to instead of always claiming "emulator_write" (N-5). Prod/live
// writes are labelled "live_write" so the ledger cannot masquerade as a
// throwaway emulator run.
function persistedWriteMode(): "emulator_write" | "live_write" {
  return process.env.FUNCTIONS_EMULATOR === "true" || process.env.FIRESTORE_EMULATOR_HOST ? "emulator_write" : "live_write";
}

function finalStatusForVerdict(verdict: VideoReviewVerdictValue): VideoReviewFinalStatus {
  if (verdict === "approval") return "approved";
  if (verdict === "disapproval") return "rejected";
  return "needs_review";
}

function decisionDocRef(submissionId: string, scope: VideoReviewProgramScope, now: Date) {
  return adminDb.collection(VIDEO_REVIEW_DECISIONS_COLLECTION).doc(
    videoReviewDecisionDocumentId(submissionId, scope, now.toISOString()),
  );
}

export function videoReviewDecisionDocumentId(
  submissionId: string,
  scope: Pick<VideoReviewProgramScope, "canonicalProgramId" | "policyConfigHash">,
  decidedAtIso: string,
): string {
  return `decision:${videoReviewScopedFingerprint(
    "text-decision",
    scope,
    VIDEO_REVIEW_POLICY_VERSION,
    submissionId,
    decidedAtIso,
  ).slice(0, 48)}`;
}

export function videoReviewCacheKey(
  modelId: string,
  features: Record<string, unknown>,
  fewShotHash: string,
  policyVersion: string = VIDEO_REVIEW_POLICY_VERSION,
  scope?: Pick<VideoReviewProgramScope, "canonicalProgramId" | "policyConfigHash">,
): string {
  const effectiveScope = scope ?? videoReviewScopeFromFeatures(features);
  return videoReviewScopedFingerprint(
    "text-cache",
    effectiveScope,
    policyVersion,
    modelId,
    features.submissionFingerprint,
    fewShotHash,
  );
}

function videoReviewScopeFromFeatures(
  features: Record<string, unknown>,
): Pick<VideoReviewProgramScope, "canonicalProgramId" | "policyConfigHash"> {
  const nested = asRecord(features.programScope);
  const canonicalProgramId = resolveCanonicalProgramId(nested.canonicalProgramId);
  const policyConfigHash = text(nested.policyConfigHash, 64).toLowerCase();
  if (canonicalProgramId && /^[a-f0-9]{64}$/.test(policyConfigHash)) {
    return { canonicalProgramId, policyConfigHash };
  }
  return videoReviewProgramScopeFromTrustedRecords({ submission: features });
}

function submissionPath(submissionId: string): string {
  return `submissions/${submissionId}`;
}

function emptyResult(input: Pick<VideoReviewJudgeResult, "submissionId" | "submissionRef" | "mode" | "humanGateRequired" | "status"> & { boundaryError?: VideoReviewBoundaryError; fewShotContext?: VideoReviewJudgeResult["fewShotContext"] }): VideoReviewJudgeResult {
  const result: VideoReviewJudgeResult = {
    submissionId: input.submissionId,
    submissionRef: input.submissionRef,
    status: input.status,
    cacheHit: false,
    fewShotContext: input.fewShotContext ?? { checked: true, disabled: false, cases: 0, hash: hashVideoReviewFewShotCases([]) },
    humanGateRequired: input.humanGateRequired,
    mode: input.mode,
    aiRecommendation: null,
    finalStatus: null,
    finalReason: null,
    decisionRef: null,
    transitionRef: null,
    ...(input.boundaryError ? input.boundaryError : {}),
  };
  // Existing server-side outbox code reads `result.error`; keep that alias without
  // serializing a third public failure field. Public JSON contains only the stable
  // allowlisted code and its opaque 24-hex correlation hash.
  if (input.boundaryError) {
    Object.defineProperty(result, "error", {
      configurable: false,
      enumerable: false,
      value: input.boundaryError.errorCode,
      writable: false,
    });
  }
  return result;
}

export function videoReviewBoundaryError(
  error: unknown,
  errorCode: VideoReviewPublicErrorCode,
): VideoReviewBoundaryError {
  const rawCode = closedScalarField(error, "code");
  const rawName = closedScalarField(error, "name");
  const rawMessage = closedScalarField(error, "message") || scalarText(error);
  const correlationIdHash = createHash("sha256")
    .update(`${VIDEO_REVIEW_ERROR_HASH_DOMAIN}\0${errorCode}\0${rawCode}\0${rawName}\0${rawMessage}`)
    .digest("hex")
    .slice(0, 24);
  return { errorCode, correlationIdHash };
}

function closedScalarField(value: unknown, field: string): string {
  if (!value || typeof value !== "object") return "";
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor && "value" in descriptor ? scalarText(descriptor.value) : "";
  } catch {
    return "";
  }
}

function scalarText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function stringList(value: unknown, fallback: readonly string[] = []): string[] {
  const source = Array.isArray(value) ? value : [];
  const out = source.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim().slice(0, 200)] : []);
  return [...new Set(out.length ? out : fallback.slice(0, 1))].slice(0, 10);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, max = 1000): string {
  if (typeof value === "string") return value.trim().slice(0, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value).slice(0, max);
  return "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clampNumber(value: unknown, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function enumString<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function parseDate(value: unknown, fallback: Date): Date | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "string") {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
  return fallback;
}

// S6(P6) RT-6/A6 유령 문서 버그 수정 — scoped to this file only. safeDocId(sheetIntakeService.ts)
// 콜론(:)을 하이픈으로 치환하는데, 실제 제출물 문서 ID는 콜론을 포함할 수 있다
// (sheet3SubmissionBridge.ts의 `token:${token}` bridgeKey가 그대로 submissions/{id}가 됨 —
// Firestore 문서 ID는 콜론을 허용하므로 이건 정상). 과거엔 여기서 safeDocId를 거쳐 콜론을
// 하이픈으로 바꿔버려 실문서(`submissions/token:llnwm...`)가 아닌 존재하지 않는 유령 문서
// (`submissions/token-llnwm...`)에 판정을 기록했다(RT-6 프로드 실측 확정). 이 함수는
// videoReviewJudgeService 내부에서만 쓰이므로(safeDocId 자체는 다른 다수 파일이 공유하는
// 전역 유틸이라 건드리지 않는다) 여기서만 최소 치환(경로 구분자 '/'만 제거)으로 바꿔
// 실제 제출물 문서 ID와 정확히 일치시킨다.
function cleanSubmissionId(value: unknown): string {
  const raw = text(value, 200);
  if (!raw) return "";
  const sanitized = raw.replace(/\//g, "-").trim();
  if (!sanitized || sanitized === "." || sanitized === ".." || /^__.*__$/.test(sanitized)) return "";
  return sanitized;
}

function normalizeRole(value: unknown): "super_admin" | "admin" | "manager" {
  return value === "super_admin" || value === "admin" || value === "manager" ? value : "manager";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
