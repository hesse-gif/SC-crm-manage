import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { assertScpEntitled } from "./mailAccounts";
import {
  hasVideoReviewMediaCandidate,
  judgeVideoReviewMultimodal,
  videoReviewAllowlistedModelId,
  videoReviewMultimodalPersistencePlan,
} from "./videoReviewMultimodal";
import {
  compactFewShotFeatures,
  runVideoReviewJudge,
  videoReviewDecisionDocumentId,
  videoReviewFeaturesFromSubmission,
  videoReviewRubricTitleFromSubmission,
  VIDEO_REVIEW_DECISIONS_COLLECTION,
  type VideoReviewVerdict,
} from "./videoReviewJudgeService";
import { SCP_CANONICAL_PROGRAM_ID } from "./programCanonical";
import { isImageSubmission, resolveVideoReviewImageFallback } from "./videoReviewImageFallback";
import { recentUploadVideoIds } from "./creatorLanguageGate";
import { makeYouTubeDataApiClient } from "./youtubeEnrichmentService";
import {
  DEFAULT_VIDEO_REVIEW_RUBRIC_TITLE,
  VIDEO_REVIEW_POLICY_VERSION,
  videoReviewCriteriaMetadata,
  type VideoReviewRubricTitle,
} from "./videoReviewCriteria";
import type { VideoLlmCallFn } from "./videoLlm";
import { videoReviewSourceFingerprint } from "./videoReviewMedia";
import {
  produceVideoReviewEvidence,
  type ProduceVideoReviewEvidenceOptions,
  type ProducedVideoReviewEvidence,
  type VideoReviewYouTubeMetadataFacts,
} from "./videoReviewEvidence";
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
  mergeVideoReviewRuleEvidenceLedger,
} from "./videoReviewRuleEvidenceLedger";
import {
  evaluateVideoReviewAutoReject,
  AUTO_REJECT_RULE_TAG_KEYS,
  type VideoReviewAutoRejectDecision,
  type VideoReviewAutoRejectFacts,
  type VideoReviewAutoRejectHashtagsEvidenceCode,
} from "./videoReviewAutoRejectCore";
import { transitionVideoReviewDecision } from "./videoReviewTransitionStore";
import { readSettings } from "./settings";

export const VIDEO_REVIEW_AUTOMATION_OUTBOX_COLLECTION = "video_review_automation_outbox";

const ADMIN_ROLES = ["super_admin", "admin"] as const;
const DEFAULT_BATCH_LIMIT = 10;
const MAX_BATCH_LIMIT = 25;
const DEFAULT_LEASE_MS = 4 * 60 * 1000;

const MAX_ATTEMPTS = 3;
type AutomationKind = "ai_recommendation" | "multimodal";
export type VideoReviewAutomationSourceKind =
  | "legacy_submission"
  | "canonical_review_state";
// S6(P6) RT-6/A6: "no_op"은 "processed"와 별개의 상태다. 예) VERTEX_VIDEO_LANE_APPROVED
// 미설정으로 멀티모달이 아예 실행되지 않은 경우 — 과거엔 이것도 "processed"(성공)로
// 기록되어 자동화가 100% 성공한 것처럼 보이면서 실효 판정은 0이었다(프로드 실측 확정 원인).
type AutomationStatus = "queued" | "processing" | "processed" | "no_op" | "failed" | "dead_letter";
type VideoReviewModelCaller = Parameters<typeof runVideoReviewJudge>[1];
type VideoReviewEvidenceProducer = (
  submission: Record<string, unknown>,
  options?: ProduceVideoReviewEvidenceOptions,
) => Promise<ProducedVideoReviewEvidence>;

type AutomationJob = {
  id: string;
  submissionId: string;
  kind: AutomationKind;
  status: AutomationStatus;
  attempts: number;
  processingLeaseExpiresAtIso: string | null;
  claimToken: string;
  claimVersion: number;
  sourceFingerprint: string;
  canonicalProgramId: string;
  policyConfigHash: string;
  programScopeVersion: string;
  sourceKind: VideoReviewAutomationSourceKind;
  sourceRevision: number;
};

type PreparedDecisionWrite = {
  ref: FirebaseFirestore.DocumentReference;
  data: Record<string, unknown>;
  merge: boolean;
};

// Task-94: the deterministic auto-reject core's output, carried from `processJob` (where the
// evidence/settings facts are available) to the drain loop, which attempts the ACTUAL transition
// only AFTER `finalizeProcessedWithSideEffects` has safely committed the AI recommendation —
// calling transitionVideoReviewDecision any earlier would change the review-state doc's
// updatedAtIso and make finalize's own source-fingerprint check fail (losing the recommendation).
type PreparedAutoReject = {
  decision: VideoReviewAutoRejectDecision;
  facts: VideoReviewAutoRejectFacts;
  evidenceIntegrityHash: string;
  /** settings.automation.videoReview.autoRejectEnabled read AT RECOMMENDATION TIME (1st of 2 reads). */
  eligibleAtRecommendation: boolean;
  sourceKind: VideoReviewAutomationSourceKind;
};

type PreparedAutomationJob = {
  programScope: VideoReviewProgramScope;
  summary: Record<string, unknown>;
  noOp: boolean;
  enqueueMultimodal: boolean;
  submissionPatch?: Record<string, unknown>;
  decisionWrite?: PreparedDecisionWrite;
  autoReject?: PreparedAutoReject;
};

// Task-94: settings.automation.videoReview — deterministic auto-reject toggle + policy threshold.
async function readVideoReviewAutoRejectSettings(): Promise<{ autoRejectEnabled: boolean; minDurationSeconds: number }> {
  const settings = await readSettings();
  const videoReview = asRecord((settings.automation as Record<string, unknown> | undefined)?.videoReview);
  const minDurationSeconds = Number(videoReview.minDurationSeconds);
  return {
    autoRejectEnabled: videoReview.autoRejectEnabled === true,
    minDurationSeconds: Number.isFinite(minDurationSeconds) && minDurationSeconds > 0 ? minDurationSeconds : 20,
  };
}

export type EnqueueVideoReviewAutomationInput = {
  submissionId: string;
  kind?: AutomationKind;
  nowIso?: string;
  source?: Record<string, unknown>;
  sourceFingerprint?: string;
  sourceKind?: VideoReviewAutomationSourceKind;
  sourceRevision?: number;
  /** Server-internal trusted scope. Public callers must not construct this value. */
  programScope?: VideoReviewProgramScope;
};

export type EnqueueVideoReviewAutomationResult = {
  enqueued: boolean;
  docId: string;
  docRef: string;
  status: AutomationStatus;
  canonicalProgramId: string;
  policyConfigHash: string;
};

export type DrainVideoReviewAutomationOutboxOptions = {
  batchLimit?: number;
  nowIso?: string;
  leaseMs?: number;
  modelCaller?: VideoReviewModelCaller;
  multimodalCallFn?: VideoLlmCallFn;
  evidenceProducer?: VideoReviewEvidenceProducer;
};

export type DrainVideoReviewAutomationOutboxResult = {
  scanned: number;
  claimed: number;
  processed: number;
  failed: number;
  deadLettered: number;
  staleClaims: number;
  multimodalEnqueued: number;
  // 후보 0건이라 이번 drain 호출이 아무 것도 하지 않았다는 뜻(claimed===0) — 개별 job의
  // no_op 상태(noOpCount)와는 별개 개념이니 혼동하지 말 것.
  noOp: boolean;
  // "processed"와 구분되는 job 단위 no-op 건수(예: video_lane_not_approved).
  noOpCount: number;
  results: Array<{ docId: string; submissionId: string; kind: AutomationKind; status: "processed" | "no_op" | "failed" | "dead_letter" | "stale"; error?: string }>;
};

export type VideoReviewAutomationScheduleLogSummary = Omit<
  DrainVideoReviewAutomationOutboxResult,
  "results"
> & {
  statusCounts: Record<DrainVideoReviewAutomationOutboxResult["results"][number]["status"], number>;
};

export function videoReviewAutomationScheduleLogSummary(
  result: DrainVideoReviewAutomationOutboxResult,
): VideoReviewAutomationScheduleLogSummary {
  const statusCounts: VideoReviewAutomationScheduleLogSummary["statusCounts"] = {
    processed: 0,
    no_op: 0,
    failed: 0,
    dead_letter: 0,
    stale: 0,
  };
  for (const item of result.results) statusCounts[item.status] += 1;
  return {
    scanned: result.scanned,
    claimed: result.claimed,
    processed: result.processed,
    failed: result.failed,
    deadLettered: result.deadLettered,
    staleClaims: result.staleClaims,
    multimodalEnqueued: result.multimodalEnqueued,
    noOp: result.noOp,
    noOpCount: result.noOpCount,
    statusCounts,
  };
}

export function videoReviewAutomationOutboxDocId(
  submissionId: string,
  kind: AutomationKind = "ai_recommendation",
  programScope?: Pick<VideoReviewProgramScope, "canonicalProgramId" | "policyConfigHash">,
): string {
  const cleanSubmissionId = cleanId(submissionId);
  if (!cleanSubmissionId) throw Object.assign(new Error("invalid-argument: submissionId required"), { code: "invalid-argument", errorCode: "video_review_automation_outbox_doc_id_submission_id_required" });
  return `submission:${cleanSubmissionId}:${kind}${programScope ? `:${videoReviewProgramScopeKey(programScope)}` : ""}`;
}

export async function enqueueVideoReviewAutomationOutbox(input: EnqueueVideoReviewAutomationInput): Promise<EnqueueVideoReviewAutomationResult> {
  const kind = normalizeKind(input.kind);
  const submissionId = cleanId(input.submissionId);
  if (!submissionId) throw Object.assign(new Error("invalid-argument: submissionId required"), { code: "invalid-argument", errorCode: "enqueue_video_review_automation_outbox_submission_id_required" });
  const nowIso = cleanIso(input.nowIso) || new Date().toISOString();
  const sourceKind = normalizeSourceKind(input.sourceKind);
  return adminDb.runTransaction(async (transaction) => {
    const submissionSnapshot = await transaction.get(automationSourceRef(submissionId, sourceKind));
    if (!submissionSnapshot.exists) throw Object.assign(new Error("submission_not_found"), { code: "not-found", errorCode: "enqueue_video_review_automation_outbox_submission_found" });
    const source = { id: submissionSnapshot.id, ...(submissionSnapshot.data() ?? {}) };
    const programScope = await resolveAutomationProgramScope(
      source,
      sourceKind,
      transaction,
    );
    return enqueueVideoReviewAutomationOutboxInTransaction(transaction, {
      submissionId,
      kind,
      nowIso,
      source,
      sourceKind,
      sourceRevision: canonicalSourceRevision(source),
      sourceFingerprint: videoReviewAutomationSourceFingerprint(source, programScope),
      programScope,
    });
  });
}

export async function enqueueVideoReviewAutomationOutboxInTransaction(
  transaction: FirebaseFirestore.Transaction,
  input: EnqueueVideoReviewAutomationInput & { programScope: VideoReviewProgramScope },
): Promise<EnqueueVideoReviewAutomationResult> {
  const kind = normalizeKind(input.kind);
  const submissionId = cleanId(input.submissionId);
  if (!submissionId) throw Object.assign(new Error("invalid-argument: submissionId required"), { code: "invalid-argument", errorCode: "enqueue_video_review_automation_outbox_in_transaction_submission_id" });
  const nowIso = cleanIso(input.nowIso) || new Date().toISOString();
  const programScope = trustedEnqueueProgramScope(input);
  const scopedRef = adminDb.collection(VIDEO_REVIEW_AUTOMATION_OUTBOX_COLLECTION)
    .doc(videoReviewAutomationOutboxDocId(submissionId, kind, programScope));
  const scopedSnapshot = await transaction.get(scopedRef);
  const legacyRef = adminDb.collection(VIDEO_REVIEW_AUTOMATION_OUTBOX_COLLECTION)
    .doc(videoReviewAutomationOutboxDocId(submissionId, kind));
  const legacySnapshot = scopedSnapshot.exists ? null : await transaction.get(legacyRef);
  const legacyData = legacySnapshot?.data() ?? {};
  const useLegacy = Boolean(legacySnapshot?.exists) && (
    !cleanProgramScopeValue(legacyData.canonicalProgramId)
    || storedProgramScopeMatches(legacyData, programScope)
  );
  const ref = useLegacy ? legacyRef : scopedRef;
  const snapshot = useLegacy && legacySnapshot ? legacySnapshot : scopedSnapshot;
  const existing = snapshot.data() ?? {};
  const sourceFingerprint = cleanFingerprint(input.sourceFingerprint)
    || (input.source ? videoReviewAutomationSourceFingerprint(input.source, programScope) : "");
  const existingStatus = snapshot.exists ? normalizeStatus(existing.status) : "queued";
  const existingFingerprint = cleanFingerprint(existing.sourceFingerprint);
  const fingerprintChanged = Boolean(sourceFingerprint && sourceFingerprint !== existingFingerprint);
  const policyChanged = snapshot.exists && asString(existing.policyVersion) !== VIDEO_REVIEW_POLICY_VERSION;
  const hasStoredProgramScope = Boolean(
    cleanProgramScopeValue(existing.canonicalProgramId)
    && cleanFingerprint(existing.policyConfigHash)
    && asString(existing.programScopeVersion),
  );
  const programScopeChanged = snapshot.exists && hasStoredProgramScope && !storedProgramScopeMatches(existing, programScope);
  const writeBase = {
    submissionId,
    kind,
    sourceKind: normalizeSourceKind(input.sourceKind),
    sourceRevision: Math.max(
      0,
      Math.trunc(Number(input.sourceRevision ?? input.source?.revision ?? 0)),
    ),
    policyVersion: VIDEO_REVIEW_POLICY_VERSION,
    canonicalProgramId: programScope.canonicalProgramId,
    policyConfigHash: programScope.policyConfigHash,
    programScopeVersion: programScope.scopeVersion,
    ...(sourceFingerprint ? { sourceFingerprint } : {}),
    processingLeaseExpiresAtIso: null,
    updatedAtIso: nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (!snapshot.exists) {
    transaction.create(ref, {
      id: ref.id,
      ...writeBase,
      status: "queued",
      attempts: 0,
      claimToken: null,
      claimVersion: 0,
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    return {
      enqueued: true,
      docId: ref.id,
      docRef: ref.path,
      status: "queued",
      canonicalProgramId: programScope.canonicalProgramId,
      policyConfigHash: programScope.policyConfigHash,
    };
  }

  // Legacy jobs predate the program fence. Add the current authoritative scope in place;
  // a source/policy change still takes the reset branch below, while a same-source terminal
  // job keeps its established idempotency semantics.
  if (!hasStoredProgramScope) {
    transaction.set(ref, {
      canonicalProgramId: programScope.canonicalProgramId,
      policyConfigHash: programScope.policyConfigHash,
      programScopeVersion: programScope.scopeVersion,
      programScopeMigratedAtIso: nowIso,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  // A changed authoritative source starts a new generation regardless of the previous
  // queued/active/terminal state. This must precede same-source failed/no_op retries so a
  // resubmission gets a fresh attempt budget and dead-letter jobs cannot remain stranded.
  if (fingerprintChanged || policyChanged) {
    transaction.set(ref, {
      ...writeBase,
      status: "queued",
      attempts: 0,
      processedAtIso: null,
      deadLetteredAtIso: null,
      lastResult: null,
      lastError: null,
      claimToken: null,
      claimedSourceFingerprint: null,
      claimedCanonicalProgramId: null,
      claimedPolicyConfigHash: null,
      requeuedAtIso: nowIso,
      sourceGeneration: FieldValue.increment(1),
      ...(policyChanged ? { policyRequeuedAtIso: nowIso } : {}),
    }, { merge: true });
    return {
      enqueued: true,
      docId: ref.id,
      docRef: ref.path,
      status: "queued",
      canonicalProgramId: programScope.canonicalProgramId,
      policyConfigHash: programScope.policyConfigHash,
    };
  }

  if (programScopeChanged) {
    transaction.set(ref, {
      ...writeBase,
      status: "queued",
      attempts: 0,
      processedAtIso: null,
      deadLetteredAtIso: null,
      lastResult: null,
      lastError: null,
      claimToken: null,
      claimedSourceFingerprint: null,
      claimedCanonicalProgramId: null,
      claimedPolicyConfigHash: null,
      requeuedAtIso: nowIso,
      sourceGeneration: FieldValue.increment(1),
      programScopeRequeuedAtIso: nowIso,
    }, { merge: true });
    return {
      enqueued: true,
      docId: ref.id,
      docRef: ref.path,
      status: "queued",
      canonicalProgramId: programScope.canonicalProgramId,
      policyConfigHash: programScope.policyConfigHash,
    };
  }

  // "failed"와 동일하게 "no_op"도 재시도 대상이다(예: env parity 수정 후 no_op으로 멈춰
  // 있던 멀티모달 job을 다시 큐로 되돌려야 함) — S6(P6) acceptance (d). Same-source
  // retries preserve attempts; only a new authoritative fingerprint resets the budget above.
  if (existingStatus === "failed" || existingStatus === "no_op") {
    transaction.set(ref, {
      ...writeBase,
      status: "queued",
      claimToken: null,
      requeuedAtIso: nowIso,
    }, { merge: true });
    return {
      enqueued: true,
      docId: ref.id,
      docRef: ref.path,
      status: "queued",
      canonicalProgramId: programScope.canonicalProgramId,
      policyConfigHash: programScope.policyConfigHash,
    };
  }

  return {
    enqueued: false,
    docId: ref.id,
    docRef: ref.path,
    status: existingStatus,
    canonicalProgramId: programScope.canonicalProgramId,
    policyConfigHash: programScope.policyConfigHash,
  };
}

/**
 * Task-94: the actual auto-reject action — called ONLY after the AI recommendation has already
 * committed. Re-reads the toggle (2nd of 2 reads, "at drain") and the review-state doc fresh so the
 * CAS fields reflect what finalize just wrote, then calls the canonical transition with
 * actorType:"ai" + aiAutoPilotEnabled:true + evidenceRisk:"low" — the SAME low-risk AI-finalize
 * path videoReviewTransitionCore.ts already gates (never a new bypass). notifyCreator:true so the
 * reject mail queues (and, per mailOutboundLanes.ts, counts toward the outbound cap).
 */
async function attemptVideoReviewAutoRejectTransition(
  job: AutomationJob,
  autoReject: PreparedAutoReject,
  nowIso: string,
): Promise<void> {
  const settings = await readVideoReviewAutoRejectSettings();
  if (!settings.autoRejectEnabled) return;
  const ref = automationSourceRef(job.submissionId, job.sourceKind);
  const snapshot = await ref.get();
  if (!snapshot.exists) return;
  const data = snapshot.data() ?? {};
  // Already terminal (a human or an earlier pass already decided) — nothing to do, and calling the
  // transition again would just fail CAS/invalid_transition noisily.
  if (asString(data.state) !== "queued" && asString(data.state) !== "in_review") return;
  const reasonTagKeys = autoReject.decision.ruleKeys.map((ruleKey) => AUTO_REJECT_RULE_TAG_KEYS[ruleKey]);
  await transitionVideoReviewDecision(
    {
      submissionId: job.submissionId,
      targetStatus: "rejected",
      expectedRevision: Number(data.revision ?? 0),
      expectedContentFingerprint: asString(data.contentFingerprint),
      expectedCanonicalProgramId: asString(data.canonicalProgramId),
      expectedPolicyConfigHash: asString(data.policyConfigHash),
      // Deterministic per (submission, evidence source) — a retried drain pass over the same
      // unchanged evidence is idempotent instead of reprocessed.
      decisionRef: `auto_reject:${job.submissionId}:${autoReject.evidenceIntegrityHash.slice(0, 24)}`,
      reasonCode: autoReject.decision.reasonCode,
      reasonTagKeys,
      actorType: "ai",
      actorId: "video-review-auto-reject-core",
      aiAutoPilotEnabled: true,
      evidenceRisk: "low",
      notifyCreator: true,
      autoRejectEvidence: {
        minDurationSeconds: autoReject.facts.minDurationSeconds,
        measuredDurationSeconds: autoReject.facts.durationSeconds ?? "unknown",
        measuredPrivacyStatus: autoReject.facts.privacyStatus ?? "unknown",
        videoNotFound: autoReject.facts.videoNotFound,
        hashtagsEvidenceCode: autoReject.facts.hashtagsEvidenceCode ?? "unknown",
        ruleKeys: autoReject.decision.ruleKeys.join(","),
        evidenceIntegrityHash: autoReject.evidenceIntegrityHash,
      },
    },
    new Date(Number.isFinite(Date.parse(nowIso)) ? Date.parse(nowIso) : Date.now()),
  );
}

export async function drainVideoReviewAutomationOutbox(options: DrainVideoReviewAutomationOutboxOptions = {}): Promise<DrainVideoReviewAutomationOutboxResult> {
  const nowIso = cleanIso(options.nowIso) || new Date().toISOString();
  const batchLimit = boundedInteger(options.batchLimit, DEFAULT_BATCH_LIMIT, 1, MAX_BATCH_LIMIT);
  const leaseMs = boundedInteger(options.leaseMs, DEFAULT_LEASE_MS, 30_000, 15 * 60 * 1000);
  const refs = await findDrainCandidateRefs(batchLimit, nowIso);
  const result: DrainVideoReviewAutomationOutboxResult = {
    scanned: refs.length,
    claimed: 0,
    processed: 0,
    failed: 0,
    deadLettered: 0,
    staleClaims: 0,
    multimodalEnqueued: 0,
    noOp: refs.length === 0,
    noOpCount: 0,
    results: [],
  };
  if (refs.length === 0) return result;

  for (const ref of refs) {
    const job = await claimJob(ref, nowIso, leaseMs);
    if (!job) continue;
    result.claimed += 1;
    try {
      const prepared = await processJob(
        job,
        nowIso,
        options.modelCaller,
        options.multimodalCallFn,
        options.evidenceProducer,
      );
      if (prepared.noOp) {
        // S6(P6) RT-6/A6: no-op(예: video_lane_not_approved)은 "processed"(성공)와 구분되는
        // 별도 상태로 기록한다 — silent no-op이 성공으로 위장되던 프로드 실측 원인 수정.
        const finalized = await markNoOp(ref, job, nowIso, prepared);
        if (!finalized) {
          result.staleClaims += 1;
          result.results.push({ docId: job.id, submissionId: job.submissionId, kind: job.kind, status: "stale" });
          continue;
        }
        result.noOpCount += 1;
        result.results.push({ docId: job.id, submissionId: job.submissionId, kind: job.kind, status: "no_op" });
      } else {
        const finalized = await finalizeProcessedWithSideEffects(ref, job, nowIso, prepared);
        if (!finalized.finalized) {
          result.staleClaims += 1;
          result.results.push({ docId: job.id, submissionId: job.submissionId, kind: job.kind, status: "stale" });
          continue;
        }
        if (finalized.multimodalEnqueued) result.multimodalEnqueued += 1;
        result.processed += 1;
        result.results.push({ docId: job.id, submissionId: job.submissionId, kind: job.kind, status: "processed" });
        // Task-94: attempt the actual auto-reject transition only AFTER the recommendation above
        // is safely committed (see PreparedAutoReject doc comment for why the ordering matters).
        // A failure here (stale CAS, toggle flipped off mid-flight, etc.) never turns this job's
        // own "processed" outcome into a failure — the recommendation is already durable.
        if (prepared.autoReject?.decision.verdict === "auto_reject"
          && prepared.autoReject.eligibleAtRecommendation
          && prepared.autoReject.sourceKind === "canonical_review_state") {
          await attemptVideoReviewAutoRejectTransition(job, prepared.autoReject, nowIso).catch((error) => {
            console.error("[video-review-auto-reject] transition attempt failed", {
              submissionId: job.submissionId,
              error: sanitizeVideoReviewAutomationError(error),
            });
          });
        }
      }
    } catch (error) {
      const message = sanitizeVideoReviewAutomationError(error);
      const failedStatus = await markFailed(ref, job, nowIso, message);
      if (!failedStatus) {
        result.staleClaims += 1;
        result.results.push({ docId: job.id, submissionId: job.submissionId, kind: job.kind, status: "stale" });
        continue;
      }
      result.failed += 1;
      if (failedStatus === "dead_letter") result.deadLettered += 1;
      result.results.push({ docId: job.id, submissionId: job.submissionId, kind: job.kind, status: failedStatus, error: message });
    }
  }

  result.noOp = result.claimed === 0;
  return result;
}

export async function processVideoReviewAutomationOutbox(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "video_review_automation_outbox.process", ADMIN_ROLES);
  // 2026-09-27 codex adversarial review round 4 FAIL-2: scp-only review automation admin tool —
  // role alone let a non-entitled admin invoke it directly. The recurring scheduler
  // (processVideoReviewAutomationOutboxSchedule) calls drainVideoReviewAutomationOutbox (the core
  // function) directly, never this public callable, so it is unaffected.
  await assertScpEntitled(auth, request, "video_review_automation_outbox.process");
  const data = asRecord(request.data);
  const result = await drainVideoReviewAutomationOutbox({
    batchLimit: boundedInteger(data.batchLimit, DEFAULT_BATCH_LIMIT, 1, MAX_BATCH_LIMIT),
    nowIso: asString(data.nowIso),
  });
  return {
    ok: true,
    ...result,
    behaviorLog: makeBehaviorLog(auth, "video_review_automation_outbox.process", "success", "scp-automation"),
  };
}

// S6(P6) acceptance (c): 레거시(outbox 도입 전) 제출물 백필 enqueue. 이 함수는 ENQUEUE만
// 한다 — LLM 실행은 하지 않는다(Codex L1: UI/백필은 enqueue/status만, 실행은 서버 drain
// 상한 10/25 안에서만, PM-2 비용 방어). 스캔 자체도 배치 상한을 둔다(무제한 컬렉션 스캔 방지).
const BACKFILL_SCAN_LIMIT = 500;

export type BackfillVideoReviewAutomationOutboxOptions = {
  batchLimit?: number;
  dryRun?: boolean;
};

export type BackfillVideoReviewAutomationOutboxResult = {
  scanned: number;
  candidateCount: number;
  enqueuedCount: number;
  dryRun: boolean;
  submissionIds: string[];
};

export async function backfillVideoReviewAutomationOutbox(
  options: BackfillVideoReviewAutomationOutboxOptions = {},
): Promise<BackfillVideoReviewAutomationOutboxResult> {
  const batchLimit = boundedInteger(options.batchLimit, DEFAULT_BATCH_LIMIT, 1, MAX_BATCH_LIMIT);
  const dryRun = options.dryRun !== false;
  const submissionsSnapshot = await adminDb.collection("submissions").limit(BACKFILL_SCAN_LIMIT).get();
  const candidateIds: string[] = [];
  for (const doc of submissionsSnapshot.docs) {
    if (candidateIds.length >= batchLimit) break;
    let scope: VideoReviewProgramScope;
    try {
      scope = await resolveAuthoritativeVideoReviewProgramScope({ id: doc.id, ...(doc.data() ?? {}) });
    } catch {
      continue;
    }
    const outboxRef = adminDb.collection(VIDEO_REVIEW_AUTOMATION_OUTBOX_COLLECTION)
      .doc(videoReviewAutomationOutboxDocId(doc.id, "ai_recommendation", scope));
    const outboxSnapshot = await outboxRef.get();
    if (!outboxSnapshot.exists
      || asString(outboxSnapshot.get("policyVersion")) !== VIDEO_REVIEW_POLICY_VERSION
      || !cleanProgramScopeValue(outboxSnapshot.get("canonicalProgramId"))
      || !cleanFingerprint(outboxSnapshot.get("policyConfigHash"))) {
      candidateIds.push(doc.id);
    }
  }

  let enqueuedCount = 0;
  if (!dryRun) {
    for (const submissionId of candidateIds) {
      const result = await enqueueVideoReviewAutomationOutbox({ submissionId, kind: "ai_recommendation" });
      if (result.enqueued) enqueuedCount += 1;
    }
  }

  return {
    scanned: submissionsSnapshot.size,
    candidateCount: candidateIds.length,
    enqueuedCount,
    dryRun,
    submissionIds: candidateIds,
  };
}

export async function backfillVideoReviewAutomationOutboxCallable(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "video_review_automation_outbox.backfill", ADMIN_ROLES);
  // 2026-09-27 codex adversarial review round 4 sweep: scp-only migration/maintenance tool with no
  // general-purpose UI (same bucket as process/force_redrain/status below).
  await assertScpEntitled(auth, request, "video_review_automation_outbox.backfill");
  const data = asRecord(request.data);
  const result = await backfillVideoReviewAutomationOutbox({
    batchLimit: boundedInteger(data.batchLimit, DEFAULT_BATCH_LIMIT, 1, MAX_BATCH_LIMIT),
    dryRun: data.dryRun !== false,
  });
  return {
    ok: true,
    ...result,
    behaviorLog: makeBehaviorLog(auth, "video_review_automation_outbox.backfill", "success", "scp-automation"),
  };
}

// RA-8 (R5-I): a "processed" ai_recommendation outbox job whose submission was never
// actually judged (a ghost — e.g. the legacy colon/hyphen submissionId bug, or any other
// path that left a job stuck "processed" without a real aiRecommendation) is invisible to
// BOTH normal re-drain paths: enqueueVideoReviewAutomationOutboxInTransaction only
// re-queues a "processed" job when its sourceFingerprint changed (see the
// `existingStatus === "processed" && fingerprintChanged` branch above), and
// backfillVideoReviewAutomationOutbox only considers submissions with NO outbox doc at
// all (see its `!outboxSnapshot.exists` check above) — a ghost job's outbox doc already
// exists. forceRedrain is a migration-only path (never wired into the recurring cron
// sweep — the operator invokes it once to clear a known backlog) that explicitly
// re-queues those ghost jobs, bypassing the fingerprint-changed condition entirely.
//
// dryRun (default true) performs zero writes and reports EVERY scanned "processed" job
// with an explicit wouldRequeue verdict + reason — including the ones that will NOT be
// re-queued (already has a real aiRecommendation, or the batch cap was reached first) —
// so a dry-run report can never silently hide an "enqueued:false" case.
const FORCE_REDRAIN_SCAN_LIMIT = 500;

export type ForceRedrainReason =
  | "ghost_processed_missing_ai_recommendation"
  | "already_has_ai_recommendation"
  | "submission_not_found"
  | "batch_limit_reached";

export type ForceRedrainVideoReviewAutomationOutboxOptions = {
  batchLimit?: number;
  dryRun?: boolean;
  nowIso?: string;
};

export type ForceRedrainCandidate = {
  docId: string;
  submissionId: string;
  wouldRequeue: boolean;
  reason: ForceRedrainReason;
};

export type ForceRedrainVideoReviewAutomationOutboxResult = {
  scanned: number;
  ghostCount: number;
  requeuedCount: number;
  dryRun: boolean;
  candidates: ForceRedrainCandidate[];
};

export async function forceRedrainVideoReviewAutomationOutbox(
  options: ForceRedrainVideoReviewAutomationOutboxOptions = {},
): Promise<ForceRedrainVideoReviewAutomationOutboxResult> {
  const nowIso = cleanIso(options.nowIso) || new Date().toISOString();
  // Same drain cap (10/25) as the recurring sweep — PM-2 cost defense applies here too.
  const batchLimit = boundedInteger(options.batchLimit, DEFAULT_BATCH_LIMIT, 1, MAX_BATCH_LIMIT);
  const dryRun = options.dryRun !== false;

  const processedSnapshot = await adminDb.collection(VIDEO_REVIEW_AUTOMATION_OUTBOX_COLLECTION)
    .where("status", "==", "processed")
    .where("kind", "==", "ai_recommendation")
    .limit(FORCE_REDRAIN_SCAN_LIMIT)
    .get();

  const candidates: ForceRedrainCandidate[] = [];
  let ghostCount = 0;
  for (const doc of processedSnapshot.docs) {
    const submissionId = cleanId(doc.get("submissionId"));
    if (!submissionId) continue;
    const submissionSnapshot = await adminDb.collection("submissions").doc(submissionId).get();
    if (!submissionSnapshot.exists) {
      candidates.push({ docId: doc.id, submissionId, wouldRequeue: false, reason: "submission_not_found" });
      continue;
    }
    if (submissionSnapshot.get("aiRecommendation")) {
      candidates.push({ docId: doc.id, submissionId, wouldRequeue: false, reason: "already_has_ai_recommendation" });
      continue;
    }
    const withinBatchCap = ghostCount < batchLimit;
    candidates.push({
      docId: doc.id,
      submissionId,
      wouldRequeue: withinBatchCap,
      reason: withinBatchCap ? "ghost_processed_missing_ai_recommendation" : "batch_limit_reached",
    });
    ghostCount += 1;
  }

  let requeuedCount = 0;
  if (!dryRun) {
    for (const candidate of candidates) {
      if (!candidate.wouldRequeue) continue;
      await adminDb.collection(VIDEO_REVIEW_AUTOMATION_OUTBOX_COLLECTION).doc(candidate.docId).set({
        status: "queued",
        attempts: 0,
        processingLeaseExpiresAtIso: null,
        processedAtIso: null,
        lastResult: null,
        lastError: null,
        requeuedAtIso: nowIso,
        forceRedrainAtIso: nowIso,
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      requeuedCount += 1;
    }
  }

  return {
    scanned: processedSnapshot.size,
    ghostCount,
    requeuedCount,
    dryRun,
    candidates,
  };
}

export async function forceRedrainVideoReviewAutomationOutboxCallable(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "video_review_automation_outbox.force_redrain", ADMIN_ROLES);
  // 2026-09-27 codex adversarial review round 4 sweep: scp-only migration-only maintenance tool
  // (never wired into the recurring cron sweep) with no general-purpose UI.
  await assertScpEntitled(auth, request, "video_review_automation_outbox.force_redrain");
  const data = asRecord(request.data);
  const result = await forceRedrainVideoReviewAutomationOutbox({
    batchLimit: boundedInteger(data.batchLimit, DEFAULT_BATCH_LIMIT, 1, MAX_BATCH_LIMIT),
    dryRun: data.dryRun !== false,
  });
  return {
    ok: true,
    ...result,
    behaviorLog: makeBehaviorLog(auth, "video_review_automation_outbox.force_redrain", "success", "scp-automation"),
  };
}

// S6(P6) acceptance (e): UI가 outbox 상태(queued/processing/processed/no_op/failed/dead_letter)를
// 읽기만 하는 경량 콜러블 — 기존 대용량 getDataset 파이프라인(read.ts)과 별개로 둔다(다른
// 워커가 read.ts를 동시 편집 중이라 스코프 충돌 방지, 응답도 가벼움: submissionId당 최대 2
// job(ai_recommendation/multimodal)만 조회).
const STATUS_READ_MAX_IDS = 100;

export type VideoReviewAutomationOutboxStatusEntry = {
  submissionId: string;
  kind: AutomationKind;
  canonicalProgramId: string;
  policyConfigHash: string;
  status: AutomationStatus;
  attempts: number;
  lastError: string | null;
  lastResult: Record<string, unknown> | null;
  processedAtIso: string | null;
};

const PUBLIC_OUTBOX_RESULT_BOOLEAN_FIELDS = [
  "humanGateRequired",
  "ok",
  "cacheHit",
  "multimodalEnqueued",
] as const;

const PUBLIC_OUTBOX_RESULT_COUNT_FIELDS = [
  "recommendedCount",
  "failedCount",
  "skippedCount",
  "writeCount",
  "transitionedCount",
] as const;

const PUBLIC_OUTBOX_RESULT_REASON_CODES = new Set([
  "already_has_ai_recommendation",
  "batch_limit_reached",
  "failed_precondition",
  "gcs_bucket_not_allowed",
  "gcs_media_unavailable",
  "ghost_processed_missing_ai_recommendation",
  "invalid_uploaded_media",
  "invalid_video_media",
  "no_video_media",
  "not_non_file_youtube",
  "provider_timeout",
  "provider_unavailable",
  "submission_not_found",
  "unsupported_media_mime",
  "uploaded_media_generation_invalid",
  "uploaded_media_generation_mismatch",
  "uploaded_media_size_invalid",
  "video_lane_not_approved",
  "video_media_metadata_lookup_failed",
  "video_review_automation_failed",
  "video_review_program_scope_ambiguous",
  "video_review_program_scope_changed",
  "video_review_program_scope_unresolved",
]);

const PUBLIC_OUTBOX_EVIDENCE_FAILURE_CODES = new Set([
  "creator_assignment_lookup_unavailable",
  "duplicate_lookup_unavailable",
  "youtube_metadata_unavailable",
  "youtube_video_not_found",
]);

function publicOutboxResultReason(value: unknown): string | null {
  const reason = asString(value);
  return PUBLIC_OUTBOX_RESULT_REASON_CODES.has(reason) ? reason : null;
}

/**
 * Closed client projection for legacy and current outbox result documents.
 * Older rows may contain provider responses, run identifiers, capability flags,
 * or raw exception objects. None of those fields are needed by the review UI.
 */
export function projectVideoReviewAutomationOutboxLastResult(
  value: unknown,
): Record<string, unknown> | null {
  const raw = asRecord(value);
  if (Object.keys(raw).length === 0) return null;
  const projected: Record<string, unknown> = {};
  const kind = normalizeKind(raw.kind);
  if (raw.kind === "ai_recommendation" || raw.kind === "multimodal") projected.kind = kind;
  const policyVersion = asString(raw.policyVersion);
  if (/^[a-zA-Z0-9._/-]{1,120}$/.test(policyVersion)) projected.policyVersion = policyVersion;
  const canonicalProgramId = asString(raw.canonicalProgramId);
  if (/^[a-zA-Z0-9._:-]{1,180}$/.test(canonicalProgramId)) projected.canonicalProgramId = canonicalProgramId;
  const programScopeVersion = asString(raw.programScopeVersion);
  if (/^[a-zA-Z0-9._/-]{1,120}$/.test(programScopeVersion)) projected.programScopeVersion = programScopeVersion;
  const mode = asString(raw.mode);
  if (["auto_ai", "human_assist", "manual"].includes(mode)) projected.mode = mode;
  const policyConfigHash = cleanFingerprint(raw.policyConfigHash);
  if (/^[a-f0-9]{64}$/.test(policyConfigHash)) projected.policyConfigHash = policyConfigHash;
  const evidenceSourceFingerprint = cleanFingerprint(raw.evidenceSourceFingerprint);
  if (/^[a-f0-9]{64}$/.test(evidenceSourceFingerprint)) projected.evidenceSourceFingerprint = evidenceSourceFingerprint;
  for (const field of PUBLIC_OUTBOX_RESULT_BOOLEAN_FIELDS) {
    if (typeof raw[field] === "boolean") projected[field] = raw[field];
  }
  for (const field of PUBLIC_OUTBOX_RESULT_COUNT_FIELDS) {
    if (typeof raw[field] === "number" && Number.isFinite(raw[field])) {
      projected[field] = nonNegativeInteger(raw[field]);
    }
  }
  const reason = publicOutboxResultReason(raw.reason);
  if (reason) projected.reason = reason;
  if (Array.isArray(raw.evidenceProducerFailures)) {
    const failures = [...new Set(raw.evidenceProducerFailures.flatMap((item) => {
      const code = asString(item);
      return PUBLIC_OUTBOX_EVIDENCE_FAILURE_CODES.has(code) ? [code] : [];
    }))].slice(0, 20);
    if (failures.length > 0) projected.evidenceProducerFailures = failures;
  }
  return Object.keys(projected).length > 0 ? projected : null;
}

export async function getVideoReviewAutomationOutboxStatusCallable(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "video_review_automation_outbox.status", ["super_admin", "admin", "manager"] as const);
  // 2026-09-27 codex adversarial review round 4 FAIL-2: this status read backs the /flu/scp review
  // workspace only — role alone let a non-entitled manager/admin read outbox status directly.
  await assertScpEntitled(auth, request, "video_review_automation_outbox.status");
  const data = asRecord(request.data);
  const submissionIds = [...new Set(stringArray(data.submissionIds).map(cleanId).filter(Boolean))].slice(0, STATUS_READ_MAX_IDS);
  const entries: VideoReviewAutomationOutboxStatusEntry[] = [];
  for (let index = 0; index < submissionIds.length; index += 30) {
    const ids = submissionIds.slice(index, index + 30);
    if (!ids.length) continue;
    const snapshots = await adminDb.collection(VIDEO_REVIEW_AUTOMATION_OUTBOX_COLLECTION)
      .where("submissionId", "in", ids)
      .get();
    for (const snapshot of snapshots.docs) {
      const d = snapshot.data() ?? {};
      entries.push({
        submissionId: asString(d.submissionId),
        kind: normalizeKind(d.kind),
        canonicalProgramId: cleanProgramScopeValue(d.canonicalProgramId),
        policyConfigHash: cleanFingerprint(d.policyConfigHash),
        status: normalizeStatus(d.status),
        attempts: nonNegativeInteger(d.attempts),
        lastError: typeof d.lastError === "string" ? sanitizeVideoReviewAutomationError(d.lastError) : null,
        lastResult: projectVideoReviewAutomationOutboxLastResult(d.lastResult),
        processedAtIso: typeof d.processedAtIso === "string" ? d.processedAtIso : null,
      });
    }
  }
  return {
    ok: true,
    entries,
    behaviorLog: makeBehaviorLog(auth, "video_review_automation_outbox.status", "success", "scp-automation"),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

async function findDrainCandidateRefs(batchLimit: number, nowIso: string): Promise<FirebaseFirestore.DocumentReference[]> {
  const collection = adminDb.collection(VIDEO_REVIEW_AUTOMATION_OUTBOX_COLLECTION);
  const queued = await collection
    .where("status", "==", "queued")
    .orderBy("createdAtIso", "asc")
    .limit(batchLimit)
    .get();
  const refs = queued.docs.map((doc) => doc.ref);
  const seen = new Set(refs.map((ref) => ref.path));
  let remaining = batchLimit - refs.length;
  if (remaining <= 0) return refs;

  const expired = await collection
    .where("status", "==", "processing")
    .where("processingLeaseExpiresAtIso", "<=", nowIso)
    .orderBy("processingLeaseExpiresAtIso", "asc")
    .limit(remaining)
    .get();
  for (const doc of expired.docs) {
    if (!seen.has(doc.ref.path)) {
      refs.push(doc.ref);
      seen.add(doc.ref.path);
    }
  }
  remaining = batchLimit - refs.length;
  if (remaining <= 0) return refs;

  const failed = await collection
    .where("status", "==", "failed")
    .limit(remaining)
    .get();
  for (const doc of failed.docs) {
    const attempts = nonNegativeInteger(doc.get("attempts"));
    if (attempts >= MAX_ATTEMPTS) {
      await markDeadLetter(doc.ref, nowIso, asString(doc.get("lastError"), "max attempts exceeded"));
      continue;
    }
    if (!seen.has(doc.ref.path)) refs.push(doc.ref);
  }
  return refs;
}

async function claimJob(ref: FirebaseFirestore.DocumentReference, nowIso: string, leaseMs: number): Promise<AutomationJob | null> {
  return adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return null;
    const data = snapshot.data() ?? {};
    const status = normalizeStatus(data.status);
    const leaseIso = asString(data.processingLeaseExpiresAtIso);
    const attemptsSoFar = nonNegativeInteger(data.attempts);
    if (status === "failed" && attemptsSoFar >= MAX_ATTEMPTS) {
      transaction.set(ref, deadLetterPatch(nowIso, asString(data.lastError, "max attempts exceeded")), { merge: true });
      return null;
    }
    const claimable = status === "queued" || status === "failed" || (status === "processing" && leaseIso !== "" && leaseIso <= nowIso);
    if (!claimable) return null;
    const submissionId = cleanId(data.submissionId);
    if (!submissionId) return null;
    const kind = normalizeKind(data.kind);
    let sourceFingerprint = cleanFingerprint(data.sourceFingerprint);
    let canonicalProgramId = cleanProgramScopeValue(data.canonicalProgramId);
    let policyConfigHash = cleanFingerprint(data.policyConfigHash);
    let programScopeVersion = asString(data.programScopeVersion);
    const sourceKind = normalizeSourceKind(data.sourceKind);
    const sourceRevision = Math.max(
      0,
      Math.trunc(Number(data.sourceRevision ?? 0)),
    );
    const submissionRef = automationSourceRef(submissionId, sourceKind);
    const submissionSnapshot = await transaction.get(submissionRef);
    if (submissionSnapshot.exists) {
      const authoritativeSubmission = { id: submissionSnapshot.id, ...(submissionSnapshot.data() ?? {}) };
      let liveScope: VideoReviewProgramScope;
      try {
        liveScope = await resolveAutomationProgramScope(
          authoritativeSubmission,
          sourceKind,
          transaction,
        );
      } catch (error) {
        transaction.set(ref, {
          status: "failed",
          processingLeaseExpiresAtIso: null,
          lastError: sanitizeVideoReviewAutomationError(error),
          claimToken: null,
          claimedSourceFingerprint: null,
          claimedCanonicalProgramId: null,
          claimedPolicyConfigHash: null,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return null;
      }
      const liveSourceFingerprint = videoReviewAutomationSourceFingerprint(authoritativeSubmission, liveScope);
      const storedScopePresent = Boolean(canonicalProgramId && policyConfigHash && programScopeVersion);
      if (storedScopePresent && (!sameVideoReviewProgramScope({ canonicalProgramId, policyConfigHash }, liveScope)
        || programScopeVersion !== liveScope.scopeVersion
        || sourceFingerprint !== liveSourceFingerprint)) {
        transaction.set(ref, {
          status: "queued",
          attempts: 0,
          sourceFingerprint: liveSourceFingerprint,
          canonicalProgramId: liveScope.canonicalProgramId,
          policyConfigHash: liveScope.policyConfigHash,
          programScopeVersion: liveScope.scopeVersion,
          processingLeaseExpiresAtIso: null,
          claimToken: null,
          claimedSourceFingerprint: null,
          claimedCanonicalProgramId: null,
          claimedPolicyConfigHash: null,
          requeuedAtIso: nowIso,
          programScopeRequeuedAtIso: nowIso,
          sourceGeneration: FieldValue.increment(1),
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return null;
      }
      sourceFingerprint = liveSourceFingerprint;
      canonicalProgramId = liveScope.canonicalProgramId;
      policyConfigHash = liveScope.policyConfigHash;
      programScopeVersion = liveScope.scopeVersion;
    }
    const attempts = attemptsSoFar + 1;
    const leaseUntilIso = new Date(Date.parse(nowIso) + leaseMs).toISOString();
    const claimToken = randomUUID();
    const claimVersion = nonNegativeInteger(data.claimVersion) + 1;
    if (!canonicalProgramId || !policyConfigHash || !programScopeVersion) {
      transaction.set(ref, {
        status: "failed",
        processingLeaseExpiresAtIso: null,
        lastError: "video_review_program_scope_unresolved",
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return null;
    }
    transaction.set(ref, {
      status: "processing",
      attempts,
      processingLeaseExpiresAtIso: leaseUntilIso,
      claimToken,
      claimVersion,
      claimedSourceFingerprint: sourceFingerprint,
      claimedCanonicalProgramId: canonicalProgramId,
      claimedPolicyConfigHash: policyConfigHash,
      sourceFingerprint,
      canonicalProgramId,
      policyConfigHash,
      programScopeVersion,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return {
      id: ref.id,
      submissionId,
      kind,
      status: "processing" as const,
      attempts,
      processingLeaseExpiresAtIso: leaseUntilIso,
      claimToken,
      claimVersion,
      sourceFingerprint,
      canonicalProgramId,
      policyConfigHash,
      programScopeVersion,
      sourceKind,
      sourceRevision:
        sourceKind === "canonical_review_state"
          ? canonicalSourceRevision(submissionSnapshot.data() ?? {})
          : sourceRevision,
    };
  });
}

async function processJob(
  job: AutomationJob,
  nowIso: string,
  modelCaller?: VideoReviewModelCaller,
  multimodalCallFn?: VideoLlmCallFn,
  evidenceProducer: VideoReviewEvidenceProducer = produceVideoReviewEvidence,
): Promise<PreparedAutomationJob> {
  const submissionSnapshot = await automationSourceRef(
    job.submissionId,
    job.sourceKind,
  ).get();
  if (!submissionSnapshot.exists) throw new Error("submission_not_found");
  const submission: Record<string, unknown> & { id: string } = { id: submissionSnapshot.id, ...(submissionSnapshot.data() ?? {}) };
  const programScope = await resolveAutomationProgramScope(
    submission,
    job.sourceKind,
  );
  assertJobProgramScope(job, programScope);
  if (videoReviewAutomationSourceFingerprint(submission, programScope) !== job.sourceFingerprint) {
    throw programScopeError("video_review_program_scope_changed");
  }

  if (job.kind === "ai_recommendation") {
    const producedEvidence = await evidenceProducer(submission, {
      nowIso,
      outboxSourceFingerprint: job.sourceFingerprint,
      programScope,
    } as ProduceVideoReviewEvidenceOptions & { programScope: VideoReviewProgramScope });
    const evidenceBackedSubmission = { ...submission, ...producedEvidence.submissionPatch };
    const judgeResult = await runVideoReviewJudge({
      submissions: [evidenceBackedSubmission],
      dryRun: true,
      requestedBy: "video-review-automation-outbox",
      requestedRole: "manager",
      requestedTeam: "scp",
      nowIso,
    }, modelCaller, {
      authoritativeScopes: new Map([[job.submissionId, programScope]]),
    });
    const failed = judgeResult.results.find((item) => item.status === "failed");
    if (failed && judgeResult.recommendedCount === 0) throw new Error(failed.error || "video review judge failed");
    const recommendation = judgeResult.results.find((item) => item.status === "recommended" && item.aiRecommendation);
    if (!recommendation?.aiRecommendation) throw new Error("video review judge produced no recommendation");
    const decisionWrite = prepareTextDecisionWrite({
      submissionId: job.submissionId,
      verdict: recommendation.aiRecommendation,
      modelId: judgeResult.costLog.model,
      mode: recommendation.mode,
      cacheHit: recommendation.cacheHit,
      nowIso,
      programScope,
      sourceKind: job.sourceKind,
      fewShotFeatures: compactFewShotFeatures(videoReviewFeaturesFromSubmission(evidenceBackedSubmission, programScope)),
      // 판정 원장에 "어느 타이틀의 루브릭으로 봤는지"를 함께 남긴다(제출의 gameId 기준).
      rubricTitle: videoReviewRubricTitleFromSubmission(evidenceBackedSubmission, programScope),
    });
    let submissionPatch = videoReviewEvidencePersistencePatch(
      decisionWrite.submissionPatch,
      producedEvidence,
      programScope,
    );
    submissionPatch = {
      ...submissionPatch,
      ruleEvidenceLedger: mergeVideoReviewRuleEvidenceLedger(
        submission.ruleEvidenceLedger,
        [
          ...producedEvidence.envelope.facts,
          ...evidenceRows(recommendation.aiRecommendation),
        ],
        nowIso,
      ),
    };
    let enqueueMultimodal = hasVideoReviewMediaCandidate(evidenceBackedSubmission);
    let imageFallback: Record<string, unknown> | null = null;
    if (!enqueueMultimodal && isImageSubmission({ uploadedFileUrl: asString(submission.uploadedFileUrl), contentType: asString(submission.contentType) })) {
      // S6(P6) 인터뷰 #4 확정 fallback 체인: sheet column C(youtubeUrl) → 채널 최신 영상
      // 1건(비용 상한) → 없으면 exhausted(silent no-op 금지, submission에 사유를 기록).
      const fallback = await prepareImageFallback(submission, nowIso);
      imageFallback = fallback.result;
      submissionPatch = { ...submissionPatch, ...fallback.submissionPatch };
      enqueueMultimodal = fallback.result.status === "video_found";
    }

    // Task-94: deterministic auto-reject core. Runs for EVERY new submission (no LLM, no extra
    // I/O — reuses the evidence this call already produced) and its recommendation is ALWAYS
    // recorded, whether or not the toggle is on; only the actual transition (below, in the drain
    // loop, after this recommendation is safely committed) is gated by the toggle.
    const autoRejectSettings = await readVideoReviewAutoRejectSettings(); // 1st of 2 reads ("at outbox creation").
    const youtubeMetadata = (producedEvidence.submissionPatch as { youtubeMetadata?: VideoReviewYouTubeMetadataFacts }).youtubeMetadata;
    const r8Fact = producedEvidence.envelope.facts.find((item) => item.ruleId === "R8");
    const autoRejectFacts: VideoReviewAutoRejectFacts = {
      durationSeconds: youtubeMetadata?.durationSeconds ?? null,
      minDurationSeconds: autoRejectSettings.minDurationSeconds,
      privacyStatus: youtubeMetadata?.privacyStatus ?? null,
      videoNotFound: producedEvidence.envelope.producerFailures.includes("youtube_video_not_found"),
      hashtagsEvidenceCode: (r8Fact?.code as VideoReviewAutoRejectHashtagsEvidenceCode | undefined) ?? null,
    };
    const autoRejectDecision = evaluateVideoReviewAutoReject(autoRejectFacts);
    const autoRejectRecommendation = {
      verdict: autoRejectDecision.verdict,
      ruleKeys: autoRejectDecision.ruleKeys,
      reasonCode: autoRejectDecision.reasonCode,
      evidenceRefs: autoRejectDecision.evidenceRefs,
      minDurationSeconds: autoRejectFacts.minDurationSeconds,
      measuredDurationSeconds: autoRejectFacts.durationSeconds,
      measuredPrivacyStatus: autoRejectFacts.privacyStatus,
      videoNotFound: autoRejectFacts.videoNotFound,
      hashtagsEvidenceCode: autoRejectFacts.hashtagsEvidenceCode,
      autoRejectEnabledAtRecommendation: autoRejectSettings.autoRejectEnabled,
      policyVersion: VIDEO_REVIEW_POLICY_VERSION,
      generatedAtIso: nowIso,
      evidenceIntegrityHash: producedEvidence.envelope.integrityHash,
    };
    const autoRejectScopeKey = videoReviewProgramScopeKey(programScope);
    const autoRejectScoped = asRecord(submissionPatch.videoReviewByScope);
    submissionPatch = {
      ...submissionPatch,
      videoReviewByScope: {
        ...autoRejectScoped,
        [autoRejectScopeKey]: {
          ...asRecord(autoRejectScoped[autoRejectScopeKey]),
          autoRejectRecommendation,
        },
      },
      ...(programScope.canonicalProgramId === SCP_CANONICAL_PROGRAM_ID ? { autoRejectRecommendation } : {}),
    };

    return {
      programScope,
      noOp: false,
      enqueueMultimodal,
      decisionWrite: { ref: decisionWrite.ref, data: decisionWrite.data, merge: false },
      submissionPatch,
      autoReject: {
        decision: autoRejectDecision,
        facts: autoRejectFacts,
        evidenceIntegrityHash: producedEvidence.envelope.integrityHash,
        eligibleAtRecommendation: autoRejectSettings.autoRejectEnabled,
        sourceKind: job.sourceKind,
      },
      summary: {
        kind: job.kind,
        policyVersion: VIDEO_REVIEW_POLICY_VERSION,
        canonicalProgramId: programScope.canonicalProgramId,
        policyConfigHash: programScope.policyConfigHash,
        programScopeVersion: programScope.scopeVersion,
        humanGateRequired: recommendation.aiRecommendation.humanGate.required,
        mode: recommendation.mode,
        recommendedCount: judgeResult.recommendedCount,
        failedCount: judgeResult.failedCount,
        skippedCount: judgeResult.skippedCount,
        writeCount: 1,
        transitionedCount: 0,
        evidenceProducerFailures: producedEvidence.envelope.producerFailures,
        evidenceSourceFingerprint: producedEvidence.binding.sourceFingerprint,
        autoReject: { verdict: autoRejectDecision.verdict, ruleKeys: autoRejectDecision.ruleKeys },
        ...(imageFallback ? { imageFallback } : {}),
      },
    };
  }

  const multimodalResult = await judgeVideoReviewMultimodal(submission, { write: false, callFn: multimodalCallFn,
    programScope,
  } as Parameters<typeof judgeVideoReviewMultimodal>[1] & { programScope: VideoReviewProgramScope });
  // S6(P6) RT-6/A6: ok:false(예: video_lane_not_approved)는 "processed"(성공)가 아니라
  // no_op 상태로 기록해야 한다 — 과거엔 여기서 ok:false를 구분하지 않고 항상 processed로
  // 기록해 자동화가 100% 성공한 것처럼 보였다(프로드 실측 확정 원인).
  if (!multimodalResult.ok) {
    return {
      programScope,
      noOp: true,
      enqueueMultimodal: false,
      summary: {
        kind: job.kind,
        canonicalProgramId: programScope.canonicalProgramId,
        policyConfigHash: programScope.policyConfigHash,
        programScopeVersion: programScope.scopeVersion,
        ok: false,
        reason: multimodalResult.reason ?? null,
        cacheHit: multimodalResult.cacheHit ?? null,
        source: multimodalResult.source ?? null,
      },
    };
  }
  const plan = videoReviewMultimodalPersistencePlan(submission, multimodalResult, nowIso, programScope);
  if (!plan) throw new Error("multimodal persistence plan unavailable");
  const scopedPlan = scopePreparedMultimodalPlan(plan, programScope);
  return {
    programScope,
    noOp: false,
    enqueueMultimodal: false,
    decisionWrite: { ref: scopedPlan.decisionRef, data: scopedPlan.decisionData, merge: false },
    submissionPatch: {
      ...scopedPlan.submissionPatch,
      ruleEvidenceLedger: mergeVideoReviewRuleEvidenceLedger(
        submission.ruleEvidenceLedger,
        evidenceRows(multimodalResult.verdict),
        nowIso,
      ),
    },
    summary: {
      kind: job.kind,
      policyVersion: VIDEO_REVIEW_POLICY_VERSION,
      canonicalProgramId: programScope.canonicalProgramId,
      policyConfigHash: programScope.policyConfigHash,
      programScopeVersion: programScope.scopeVersion,
      humanGateRequired: multimodalResult.verdict?.humanGate.required ?? true,
      ok: true,
      reason: null,
      cacheHit: multimodalResult.cacheHit ?? null,
      source: multimodalResult.source ?? null,
    },
  };
}

export function videoReviewEvidencePersistencePatch(
  baseSubmissionPatch: Record<string, unknown>,
  producedEvidence: ProducedVideoReviewEvidence,
  programScope: VideoReviewProgramScope,
): Record<string, unknown> {
  const binding = producedEvidence.binding;
  if (binding.canonicalProgramId !== programScope.canonicalProgramId
    || binding.policyConfigHash !== programScope.policyConfigHash
    || binding.sourceFingerprint !== producedEvidence.envelope.sourceFingerprint
    || producedEvidence.envelope.canonicalProgramId !== programScope.canonicalProgramId
    || producedEvidence.envelope.policyConfigHash !== programScope.policyConfigHash) {
    throw programScopeError("video_review_program_scope_changed");
  }
  const scopeKey = videoReviewProgramScopeKey(programScope);
  const scoped = asRecord(baseSubmissionPatch.videoReviewByScope);
  const currentProjection = asRecord(scoped[scopeKey]);
  const patch = {
    ...baseSubmissionPatch,
    videoReviewByScope: {
      ...scoped,
      [scopeKey]: {
        ...currentProjection,
        videoReviewEvidence: producedEvidence.envelope,
        videoReviewEvidenceBinding: binding,
        videoReviewEvidenceIdentityFingerprints: [...producedEvidence.envelope.identityFingerprints],
      },
    },
  };
  return programScope.canonicalProgramId === SCP_CANONICAL_PROGRAM_ID
    ? { ...patch, ...producedEvidence.submissionPatch }
    : patch;
}

function prepareTextDecisionWrite(input: {
  submissionId: string;
  verdict: VideoReviewVerdict;
  modelId: string;
  mode: string;
  cacheHit: boolean;
  nowIso: string;
  programScope: VideoReviewProgramScope;
  sourceKind: VideoReviewAutomationSourceKind;
  fewShotFeatures: Record<string, unknown>;
  /** 2026-09-05 다타이틀: 이 판정에 실제로 적용된 루브릭 타이틀. 미지정이면 프로그램 기본 타이틀. */
  rubricTitle?: VideoReviewRubricTitle;
}): { ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown>; submissionPatch: Record<string, unknown> } {
  const ref = adminDb.collection(VIDEO_REVIEW_DECISIONS_COLLECTION)
    .doc(videoReviewDecisionDocumentId(input.submissionId, input.programScope, input.nowIso));
  const reviewCriteria = videoReviewCriteriaMetadata(input.rubricTitle ?? DEFAULT_VIDEO_REVIEW_RUBRIC_TITLE);
  const modelId = videoReviewAllowlistedModelId(input.modelId);
  // This path is server-generated and intentionally retained: the authorized review UI uses it
  // to distinguish a persisted ledger recommendation from a dry-run recommendation. Arbitrary
  // provider references never enter this field.
  const aiRecommendation = {
    ...input.verdict,
    modelId,
    decisionRef: ref.path,
    source: "outbox_text_judge",
    generatedAtIso: input.nowIso,
    canonicalProgramId: input.programScope.canonicalProgramId,
    policyConfigHash: input.programScope.policyConfigHash,
    programScopeVersion: input.programScope.scopeVersion,
    effectiveVideoReviewPolicy: videoReviewEffectiveProgramPolicy(input.programScope),
  };
  return {
    ref,
    data: {
      id: ref.id,
      submissionId: input.submissionId,
      submissionRef: automationSourceRef(
        input.submissionId,
        input.sourceKind,
      ).path,
      canonicalProgramId: input.programScope.canonicalProgramId,
      policyConfigHash: input.programScope.policyConfigHash,
      programScopeVersion: input.programScope.scopeVersion,
      effectiveVideoReviewPolicy: videoReviewEffectiveProgramPolicy(input.programScope),
      mode: input.mode,
      aiRecommendation,
      policyVersion: VIDEO_REVIEW_POLICY_VERSION,
      reviewCriteria,
      // Outbox automation only persists an assistive recommendation. A review/payable
      // transition remains a separately authorized human-gated operation.
      finalStatus: null,
      finalReason: null,
      decidedBy: "video-review-automation-outbox",
      decidedAtIso: input.nowIso,
      cacheHit: input.cacheHit,
      fewShotFeatures: input.fewShotFeatures,
      auditRef: "outbox:video-review-automation",
      createdAt: FieldValue.serverTimestamp(),
    },
    submissionPatch: {
      videoReviewByScope: {
        [videoReviewProgramScopeKey(input.programScope)]: {
          canonicalProgramId: input.programScope.canonicalProgramId,
          policyConfigHash: input.programScope.policyConfigHash,
          programScopeVersion: input.programScope.scopeVersion,
          text: {
            aiRecommendation: { ...aiRecommendation, reviewCriteria },
            latestVideoReviewDecisionRef: ref.path,
            updatedAtIso: input.nowIso,
          },
        },
      },
      ...(input.programScope.canonicalProgramId === SCP_CANONICAL_PROGRAM_ID ? {
        aiRecommendation: { ...aiRecommendation, reviewCriteria },
        latestVideoReviewDecisionRef: ref.path,
      } : {}),
      updatedAtIso: input.nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    },
  };
}

// Image fallback lookup is compute-only. Its patch joins the recommendation, decision, and
// terminal outbox write only after the claim is revalidated in one transaction.
// 채널 조회는 submission.email로 program_sheet_leads의 applicant.youtubeUrl을 역참조한다
// (creatorLanguageGate.ts의 채널 게이트와 동일한 유일한 채널 레퍼런스 소스).
async function prepareImageFallback(
  submission: Record<string, unknown>,
  nowIso: string,
): Promise<{ result: Record<string, unknown>; submissionPatch: Record<string, unknown> }> {
  const channelYoutubeUrl = await resolveKnownChannelYoutubeUrl(submission);
  const fallback = await resolveVideoReviewImageFallback({
    sheetColumnCUrl: asString(submission.youtubeUrl) || null,
    channelYoutubeUrl,
    youtubeApi: channelYoutubeUrl ? makeYouTubeDataApiClient() : undefined,
    recentUploadFetcher: recentUploadVideoIds,
  });
  const patch = fallback.status === "video_found"
    ? {
      imageFallbackTarget: { videoId: fallback.videoId, youtubeUrl: fallback.youtubeUrl, source: fallback.source },
      imageFallbackReason: null,
      imageFallbackStatus: "resolved",
    }
    : {
      imageFallbackTarget: null,
      imageFallbackReason: fallback.reason ?? "image_fallback_exhausted",
      imageFallbackStatus: "exhausted",
    };
  return {
    result: { ...fallback },
    submissionPatch: {
      ...patch,
      imageFallbackCheckedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    },
  };
}

async function resolveKnownChannelYoutubeUrl(submission: Record<string, unknown>): Promise<string | null> {
  const email = asString(submission.email).trim().toLowerCase();
  if (!email) return null;
  try {
    const snapshot = await adminDb.collection("program_sheet_leads").where("email", "==", email).limit(1).get();
    const doc = snapshot.docs[0]?.data() ?? null;
    const applicant = asRecord(doc?.applicant);
    const url = asString(applicant.youtubeUrl) || asString(doc?.youtubeUrl);
    return url || null;
  } catch {
    return null;
  }
}

async function finalizeProcessedWithSideEffects(
  ref: FirebaseFirestore.DocumentReference,
  job: AutomationJob,
  nowIso: string,
  prepared: PreparedAutomationJob,
): Promise<{ finalized: boolean; multimodalEnqueued: boolean }> {
  return adminDb.runTransaction(async (transaction) => {
    // All reads happen before any write. Neither model lane persists its recommendation or
    // decision until claim token/version/source ownership and the live submission fingerprint
    // are confirmed here.
    const claimSnapshot = await transaction.get(ref);
    if (!claimSnapshot.exists || !ownsClaim(claimSnapshot.data() ?? {}, job)) {
      return { finalized: false, multimodalEnqueued: false };
    }
    const submissionRef = automationSourceRef(job.submissionId, job.sourceKind);
    const submissionSnapshot = await transaction.get(submissionRef);
    if (!submissionSnapshot.exists) return { finalized: false, multimodalEnqueued: false };
    const currentSubmission = { id: submissionSnapshot.id, ...(submissionSnapshot.data() ?? {}) };
    const transactionProgramScope = await resolveAutomationProgramScope(
      currentSubmission,
      job.sourceKind,
      transaction,
    );
    const currentSourceFingerprint = videoReviewAutomationSourceFingerprint(currentSubmission, transactionProgramScope);
    if (!sameVideoReviewProgramScope(transactionProgramScope, job)
      || !sameVideoReviewProgramScope(transactionProgramScope, prepared.programScope)
      || currentSourceFingerprint !== job.sourceFingerprint) {
      return { finalized: false, multimodalEnqueued: false };
    }

    let multimodalEnqueued = false;
    if (prepared.enqueueMultimodal) {
      const effectiveSubmission = { ...currentSubmission, ...(prepared.submissionPatch ?? {}), id: job.submissionId };
      const enqueueResult = await enqueueVideoReviewAutomationOutboxInTransaction(transaction, {
        submissionId: job.submissionId,
        kind: "multimodal",
        nowIso,
        source: effectiveSubmission,
        sourceKind: job.sourceKind,
        sourceRevision: canonicalSourceRevision(effectiveSubmission),
        sourceFingerprint: videoReviewAutomationSourceFingerprint(effectiveSubmission, transactionProgramScope),
        programScope: transactionProgramScope,
      });
      multimodalEnqueued = enqueueResult.enqueued;
    }

    if (prepared.decisionWrite) {
      if (prepared.decisionWrite.merge) transaction.set(prepared.decisionWrite.ref, prepared.decisionWrite.data, { merge: true });
      else transaction.set(prepared.decisionWrite.ref, prepared.decisionWrite.data);
    }
    // update() replaces each supplied top-level map (including aiRecommendation), preventing
    // omitted legacy transport/capability metadata from surviving a merge into the new schema.
    if (prepared.submissionPatch) {
      transaction.update(
        submissionRef,
        videoReviewScopePreservingSubmissionUpdate(prepared.submissionPatch),
      );
    }
    transaction.set(ref, {
      status: "processed",
      processingLeaseExpiresAtIso: null,
      processedAtIso: nowIso,
      lastResult: { ...prepared.summary, multimodalEnqueued },
      lastError: null,
      claimToken: null,
      claimedSourceFingerprint: null,
      claimedCanonicalProgramId: null,
      claimedPolicyConfigHash: null,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { finalized: true, multimodalEnqueued };
  });
}

// S6(P6) RT-6/A6: "processed"와 구분되는 no-op 상태 — job은 정상 완료됐지만 실효 판정이
// 없었음(예: video_lane_not_approved)을 명시적으로 남긴다. no_op은 findDrainCandidateRefs가
// 다시 안 집는다 — env parity 수정 후에는 enqueue의 "no_op → 재큐잉" 경로로만 재시도된다.
async function markNoOp(
  ref: FirebaseFirestore.DocumentReference,
  job: AutomationJob,
  nowIso: string,
  prepared: PreparedAutomationJob,
): Promise<boolean> {
  return adminDb.runTransaction(async (transaction) => {
    const claimSnapshot = await transaction.get(ref);
    if (!claimSnapshot.exists || !ownsClaim(claimSnapshot.data() ?? {}, job)) return false;
    const submissionSnapshot = await transaction.get(
      automationSourceRef(job.submissionId, job.sourceKind),
    );
    if (!submissionSnapshot.exists) return false;
    const currentSubmission = { id: submissionSnapshot.id, ...(submissionSnapshot.data() ?? {}) };
    const currentScope = await resolveAutomationProgramScope(
      currentSubmission,
      job.sourceKind,
      transaction,
    );
    const currentSourceFingerprint = videoReviewAutomationSourceFingerprint(currentSubmission, currentScope);
    if (!sameVideoReviewProgramScope(currentScope, job)
      || !sameVideoReviewProgramScope(currentScope, prepared.programScope)
      || currentSourceFingerprint !== job.sourceFingerprint) return false;
    transaction.set(ref, {
      status: "no_op",
      processingLeaseExpiresAtIso: null,
      processedAtIso: nowIso,
      lastResult: prepared.summary,
      lastError: null,
      claimToken: null,
      claimedSourceFingerprint: null,
      claimedCanonicalProgramId: null,
      claimedPolicyConfigHash: null,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return true;
  });
}

async function markFailed(ref: FirebaseFirestore.DocumentReference, job: AutomationJob, nowIso: string, error: string): Promise<"failed" | "dead_letter" | null> {
  const status = job.attempts >= MAX_ATTEMPTS ? "dead_letter" : "failed";
  const finalized = await finalizeOwnedClaim(ref, job, {
    status,
    processingLeaseExpiresAtIso: null,
    lastError: sanitizeVideoReviewAutomationError(error),
    ...(status === "dead_letter" ? { deadLetteredAtIso: nowIso } : {}),
    updatedAtIso: nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return finalized ? status : null;
}

async function finalizeOwnedClaim(
  ref: FirebaseFirestore.DocumentReference,
  job: AutomationJob,
  patch: Record<string, unknown>,
): Promise<boolean> {
  return adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return false;
    const data = snapshot.data() ?? {};
    if (!ownsClaim(data, job)) return false;
    transaction.set(ref, {
      ...patch,
      claimToken: null,
      claimedSourceFingerprint: null,
      claimedCanonicalProgramId: null,
      claimedPolicyConfigHash: null,
    }, { merge: true });
    return true;
  });
}

function ownsClaim(data: Record<string, unknown>, job: AutomationJob): boolean {
  return normalizeStatus(data.status) === "processing"
    && asString(data.claimToken) === job.claimToken
    && nonNegativeInteger(data.claimVersion) === job.claimVersion
    && cleanFingerprint(data.sourceFingerprint) === job.sourceFingerprint
    && cleanFingerprint(data.claimedSourceFingerprint) === job.sourceFingerprint
    && cleanProgramScopeValue(data.canonicalProgramId) === job.canonicalProgramId
    && cleanFingerprint(data.policyConfigHash) === job.policyConfigHash
    && cleanProgramScopeValue(data.claimedCanonicalProgramId) === job.canonicalProgramId
    && cleanFingerprint(data.claimedPolicyConfigHash) === job.policyConfigHash;
}

async function markDeadLetter(ref: FirebaseFirestore.DocumentReference, nowIso: string, error: string) {
  await ref.set(deadLetterPatch(nowIso, error), { merge: true });
}

function deadLetterPatch(nowIso: string, error: string): Record<string, unknown> {
  return {
    status: "dead_letter",
    processingLeaseExpiresAtIso: null,
    lastError: sanitizeVideoReviewAutomationError(error || "max attempts exceeded"),
    deadLetteredAtIso: nowIso,
    updatedAtIso: nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function trustedEnqueueProgramScope(
  input: EnqueueVideoReviewAutomationInput & { programScope: VideoReviewProgramScope },
): VideoReviewProgramScope {
  if (input.source && hasExplicitProgramScope(input.source)) {
    const sourceScope = videoReviewProgramScopeFromTrustedRecords({ submission: input.source });
    // `programScope` is a server-internal value resolved from the authoritative
    // submission+task+lead+application graph. Re-deriving the policy hash from the flattened
    // submission alone moves every linked-record policy into the submission bucket and thus
    // produces a different (synthetic) provenance hash. The explicit source still fences the
    // canonical program; the authoritative resolver owns the policy provenance/hash.
    if (sourceScope.canonicalProgramId !== input.programScope.canonicalProgramId) {
      throw programScopeError("video_review_program_scope_ambiguous");
    }
  }
  return input.programScope;
}

function storedProgramScopeMatches(
  stored: Record<string, unknown>,
  scope: Pick<VideoReviewProgramScope, "canonicalProgramId" | "policyConfigHash" | "scopeVersion">,
): boolean {
  return cleanProgramScopeValue(stored.canonicalProgramId) === scope.canonicalProgramId
    && cleanFingerprint(stored.policyConfigHash) === scope.policyConfigHash
    && asString(stored.programScopeVersion) === scope.scopeVersion;
}

function assertJobProgramScope(job: AutomationJob, scope: VideoReviewProgramScope): void {
  if (!sameVideoReviewProgramScope(job, scope) || job.programScopeVersion !== scope.scopeVersion) {
    throw programScopeError("video_review_program_scope_changed");
  }
}

function transactionProgramScopeRecordReader(transaction: FirebaseFirestore.Transaction) {
  return async (collection: string, documentId: string): Promise<Record<string, unknown> | null> => {
    const snapshot = await transaction.get(adminDb.collection(collection).doc(documentId));
    return snapshot.exists ? { id: snapshot.id, ...(snapshot.data() ?? {}) } : null;
  };
}

function scopePreparedMultimodalPlan(
  plan: NonNullable<ReturnType<typeof videoReviewMultimodalPersistencePlan>>,
  scope: VideoReviewProgramScope,
): NonNullable<ReturnType<typeof videoReviewMultimodalPersistencePlan>> {
  const scopeFields = {
    canonicalProgramId: scope.canonicalProgramId,
    policyConfigHash: scope.policyConfigHash,
    programScopeVersion: scope.scopeVersion,
    effectiveVideoReviewPolicy: videoReviewEffectiveProgramPolicy(scope),
  };
  const submissionPatch = { ...plan.submissionPatch };
  const recommendation = asRecord(submissionPatch.aiRecommendation);
  if (Object.keys(recommendation).length > 0) {
    submissionPatch.aiRecommendation = { ...recommendation, ...scopeFields };
  }
  const multimodalRecommendation = asRecord(submissionPatch.aiRecommendationMultimodal);
  if (Object.keys(multimodalRecommendation).length > 0) {
    submissionPatch.aiRecommendationMultimodal = { ...multimodalRecommendation, ...scopeFields };
  }
  return {
    ...plan,
    decisionData: { ...plan.decisionData, ...scopeFields },
    submissionPatch,
  };
}

function hasExplicitProgramScope(source: Record<string, unknown>): boolean {
  return Boolean(cleanProgramScopeValue(source.canonicalProgramId) || cleanProgramScopeValue(source.programId));
}

export function videoReviewAutomationSourceFingerprint(
  source: Record<string, unknown>,
  programScope: VideoReviewProgramScope = videoReviewProgramScopeFromTrustedRecords({ submission: source }),
): string {
  return videoReviewScopedFingerprint(
    "automation-source",
    programScope,
    videoReviewSourceFingerprint(source),
  );
}

export function sanitizeVideoReviewAutomationError(error: unknown): string {
  const record = asRecord(error);
  const raw = error instanceof Error ? error.message : asString(error);
  const code = asString(record.code).toLowerCase();
  const message = `${code} ${raw}`.toLowerCase();
  if (message.includes("submission_not_found") || message.includes("submission not found")) return "submission_not_found";
  if (message.includes("video_review_program_scope_ambiguous")) return "video_review_program_scope_ambiguous";
  if (message.includes("video_review_program_scope_changed")) return "video_review_program_scope_changed";
  if (message.includes("video_review_program_scope_unresolved")) return "video_review_program_scope_unresolved";
  if (message.includes("video_media_metadata_lookup_failed")) return "video_media_metadata_lookup_failed";
  if (message.includes("video_lane_not_approved")) return "video_lane_not_approved";
  if (message.includes("invalid_uploaded_media") || message.includes("invalid or unsupported media")) return "invalid_video_media";
  if (message.includes("deadline") || message.includes("timeout") || message.includes("timed out")) return "provider_timeout";
  if (message.includes("unavailable") || message.includes("resource-exhausted") || /\b(?:429|500|502|503|504)\b/.test(message)) return "provider_unavailable";
  if (message.includes("failed-precondition")) return "failed_precondition";
  if (message.includes("max attempts exceeded")) return "max_attempts_exceeded";
  return "video_review_automation_failed";
}

function cleanFingerprint(value: unknown): string {
  return asString(value).trim().replace(/[^a-f0-9]/gi, "").slice(0, 64);
}

function cleanProgramScopeValue(value: unknown): string {
  return asString(value).trim().slice(0, 180);
}
function normalizeKind(value: unknown): AutomationKind {
  return value === "multimodal" ? "multimodal" : "ai_recommendation";
}

function evidenceRows(value: unknown): Record<string, unknown>[] {
  const evidence = asRecord(value).evidence;
  return Array.isArray(evidence)
    ? evidence
        .filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
        .slice(0, 48)
    : [];
}

function normalizeSourceKind(value: unknown): VideoReviewAutomationSourceKind {
  return value === "canonical_review_state"
    ? "canonical_review_state"
    : "legacy_submission";
}

// Sanitizer copy — MUST stay byte-identical to `videoReviewStateDocId` in
// ./scpVideoRevisionIngress.ts and the private `reviewDocId` in ./videoReviewTransitionStore.ts
// (not exported there). Canonical review-state docs live under this sanitized id, so a caller
// passing a raw videoSubmissionId containing "." / ":" must still resolve the same document.
function canonicalReviewStateDocId(videoSubmissionId: string): string {
  return String(videoSubmissionId)
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 180);
}

function automationSourceRef(
  submissionId: string,
  sourceKind: VideoReviewAutomationSourceKind,
): FirebaseFirestore.DocumentReference {
  return adminDb
    .collection(
      sourceKind === "canonical_review_state"
        ? "scp_video_review_state"
        : "submissions",
    )
    .doc(sourceKind === "canonical_review_state" ? canonicalReviewStateDocId(submissionId) : submissionId);
}

function canonicalSourceRevision(source: Record<string, unknown>): number {
  const revision = Number(source.revision ?? source.videoRevision ?? 0);
  return Number.isFinite(revision) ? Math.max(0, Math.trunc(revision)) : 0;
}

async function resolveAutomationProgramScope(
  source: Record<string, unknown> & { id?: string },
  sourceKind: VideoReviewAutomationSourceKind,
  transaction?: FirebaseFirestore.Transaction,
): Promise<VideoReviewProgramScope> {
  if (sourceKind === "legacy_submission") {
    return resolveAuthoritativeVideoReviewProgramScope(source, {
      ...(transaction
        ? { recordReader: transactionProgramScopeRecordReader(transaction) }
        : {}),
    });
  }
  const scope = videoReviewProgramScopeFromTrustedRecords(
    { submission: source },
    { legacyScpFallback: false },
  );
  const storedProgramId = cleanProgramScopeValue(
    source.canonicalProgramId ?? source.programId,
  );
  const storedPolicyConfigHash = cleanFingerprint(source.policyConfigHash);
  const storedScopeVersion = asString(source.programScopeVersion);
  if (
    !storedProgramId ||
    storedProgramId !== scope.canonicalProgramId ||
    !storedPolicyConfigHash ||
    storedPolicyConfigHash !== scope.policyConfigHash ||
    (storedScopeVersion && storedScopeVersion !== scope.scopeVersion)
  ) {
    throw programScopeError("video_review_program_scope_changed");
  }
  return scope;
}

function normalizeStatus(value: unknown): AutomationStatus {
  if (value === "processing" || value === "processed" || value === "no_op" || value === "failed" || value === "dead_letter") return value;
  return "queued";
}

function cleanId(value: unknown): string {
  return asString(value).replace(/^submissions\//, "").trim();
}

function cleanIso(value: unknown): string {
  const text = asString(value);
  return Number.isFinite(Date.parse(text)) ? new Date(Date.parse(text)).toISOString() : "";
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
