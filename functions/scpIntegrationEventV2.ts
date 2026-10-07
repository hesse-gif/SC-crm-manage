// scp.integration-event.v2 inbound receiver (Portal -> Flu, signed_event_receiver role).
//
// Versioned adapter layer over the already-deployed Flu engines. The v1 receivers
// (scpFluApplicationCommand / scpFluVideoIntake / scpPortalSubmissionIngress) stay untouched as
// compatibility surfaces for rollback; this module adds the v2 contract without duplicating the
// review / ingress / tracking engines.
//
// Authentication + canonicalization + identity + replay/idempotency/revision/trace semantics come
// from the vendored, byte-identical Portal contract library (./integrationEventV2). This module
// adds the DURABLE (Firestore-backed) receipt ledger and maps accepted events onto the deployed
// engines:
//   - video.submitted            -> canonical scp_video_review_state + canonical-source automation
//   - uid.submitted              -> scp_portal_uid_states (non-blocking UID state; never verified)
//   - application.submitted      -> immutable v2 observation (+ UID-guide outbox handoff: TASK 4)
//   - uid.guide-email.requested  -> immutable v2 observation (+ UID-guide outbox handoff: TASK 4)
//
// Status semantics (Portal durable-receipt contract):
//   accepted 201 | duplicate 200 | invalid/privacy 400 | signature invalid/stale 401 |
//   replay/idempotency/revision/trace conflict 409.

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
// 2026-09-05 다타이틀: 제출이 어느 게임 타이틀인지 레지스트리로 확정한다(타이틀별 분기 없음).
import { resolveSubmissionGameId } from "./programTitles";
import { loadProgramTitleRegistry } from "./programTitlesStore";
import { asRecord, asString } from "./shared";
import {
  IntegrationEventV2Error,
  identitySha256 as computeIdentitySha256,
  integrationEventV2Body,
  integrationEventV2PipelineKey,
  integrationEventV2SubjectKey,
  sha256Hex,
  verifyIntegrationEventV2Request,
  type IntegrationEventV2,
  type IntegrationEventV2KeyRing,
  type IntegrationEventV2Name,
} from "./integrationEventV2";
import {
  materializeApplicationManagementRecord,
  type MaterializeResult,
} from "./applicationManagementStore";
import {
  SCP_CONTENT_SUBMITTED_MAIL_OUTBOX_COLLECTION,
  contentSubmittedMailOutboxDocId,
  contentSubmittedMailOutboxRow,
} from "./scpReceiptMailOutbox";
import { resolveScpReceiptMailTemplate } from "./scpReceiptMailTemplates";
import {
  materializePortalVerifiedCreator,
  parsePortalChannelVerifiedPayload,
} from "./scpPortalChannelVerifiedIngress";
import {
  enqueueVideoReviewAutomationOutbox,
  enqueueVideoReviewAutomationOutboxInTransaction,
  videoReviewAutomationSourceFingerprint,
} from "./videoReviewAutomationOutbox";
import {
  videoReviewProgramScopeFromTrustedRecords,
  type VideoReviewProgramScope,
} from "./videoReviewProgramScope";
import {
  VIDEO_REVIEW_POLICY_VERSION,
} from "./videoReviewCriteria";
import {
  evaluateDuplicateForSubmission,
  upsertVideoFingerprint,
} from "./duplicateDetectionStore";
import {
  initialVideoReviewRuleEvidenceLedger,
} from "./videoReviewRuleEvidenceLedger";
import {
  extractYouTubeVideoIdFromSubmissionUrl,
} from "./scpApprovedFeed";
import {
  transitionVideoReviewDecision,
} from "./videoReviewTransitionStore";
import {
  defaultReviewStateProgramResolutionDeps,
  resolveReviewStateProgramId,
  type ReviewStateProgramResolution,
} from "./reviewStateProgramResolution";
import {
  invalidateReviewQueueCachesForCommittedWriteScopes,
  type ReviewQueueCacheInvalidationScope,
} from "./reviewQueueCountsCache";

export const SCP_INTEGRATION_EVENT_V2_CONTRACT = "scp.integration-event.v2" as const;
export const SCP_INTEGRATION_EVENT_V2_SECRET_ENV = "SCP_INTEGRATION_EVENT_V2_SECRET";
export const SCP_INTEGRATION_EVENT_V2_PREVIOUS_SECRET_ENV = "SCP_INTEGRATION_EVENT_V2_SECRET_PREVIOUS";
export const SCP_INTEGRATION_EVENT_V2_MAX_BODY_BYTES = 16 * 1024;
export const SCP_INTEGRATION_EVENT_V2_MAX_SKEW_SECONDS = 300;

export const INTEGRATION_EVENT_V2_RECEIPTS_COLLECTION = "scp_integration_event_v2_receipts";
export const INTEGRATION_EVENT_V2_SUBJECTS_COLLECTION = "scp_integration_event_v2_subjects";
export const INTEGRATION_EVENT_V2_PIPELINES_COLLECTION = "scp_integration_event_v2_pipelines";
export const INTEGRATION_EVENT_V2_SIGNATURES_COLLECTION = "scp_integration_event_v2_signatures";
export const INTEGRATION_EVENT_V2_OBSERVATIONS_COLLECTION = "scp_integration_event_v2_observations";
export const INTEGRATION_EVENT_V2_UID_STATES_COLLECTION = "scp_portal_uid_states";
// Links a Flu review submission (portal:<videoSubmissionId>) back to its v2 subject + traceId so the
// signed callback producer can reconstruct video.review-status.changed / video.view-snapshot.updated.
export const INTEGRATION_EVENT_V2_VIDEO_LINKS_COLLECTION = "scp_integration_event_v2_video_links";
// Durable UID-guide mail intent from application.submitted / uid.guide-email.requested. Flu owns mail
// delivery; the intent is fail-closed (accumulates as queued) until the approved mail-provider binding
// and the Portal v2 protected-material endpoint contract land (TASK 4). No raw email/URL is stored.
export const INTEGRATION_EVENT_V2_UID_GUIDE_OUTBOX_COLLECTION = "scp_integration_event_v2_uid_guide_outbox";
const BINDINGS_COLLECTION = "scp_portal_creator_bindings";
const CREATORS_COLLECTION = "creators";
const LEGACY_SHEET_CONTROL_RECEIPTS_COLLECTION =
  "scp_portal_command_receipts";

// Only Portal-produced (portal -> flu) events are received here. The flu -> portal callback events
// (video.review-status.changed / video.view-snapshot.updated) are produced by Flu, not received.
//
// Task-94: `video.review.appeal` (creator appeal of an AI-authored `rejected` decision) is NOT in
// this set and NOT in the vendored `integrationEventV2Names` union above — that union is pinned to
// a Portal-signed schema SHA (see integrationEventV2.ts's header: "Do NOT hand-edit... re-vendor
// if the contract SHA changes") and adding an event here without a matching Portal-side change
// would desync the byte-identical contract tests/integration-event-v2-contract.test.mjs pins. The
// contract (wire shape + "on receipt" effect) is defined and ready in ./videoReviewAppeal.ts
// (applyVideoReviewAppeal) instead — wire it into this set + the dispatch switch below once Portal
// implements the sender side and the vendored contract is re-synced to include the event name.
const INBOUND_EVENT_NAMES: ReadonlySet<IntegrationEventV2Name> = new Set([
  "application.submitted",
  "uid.guide-email.requested",
  "uid.submitted",
  "video.submitted",
  "creator.channel-verified",
]);

type V2Error = Error & { code: string };

function v2Error(code: string, message: string): V2Error {
  return Object.assign(new Error(message), { code });
}

function docId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 48);
}

// Map every contract/verification error code to the pinned HTTP status semantics.
export function integrationEventV2ErrorStatus(code: string | undefined): number {
  switch (code) {
    case "signature_stale":
    case "signature_invalid":
      return 401;
    case "replay_rejected":
    case "idempotency_conflict":
    case "revision_not_monotonic":
    case "trace_mismatch":
      return 409;
    case "invalid_event":
    case "sensitive_field_forbidden":
    case "invalid_payload":
    case "unsupported_event":
    case "body_too_large":
      return 400;
    // creator.channel-verified 신원 게이트. 이들은 **사람이 봐야 끝나는** 종결 거절이다 —
    // 재검증 충돌·신원 모호·결정적 ID 충돌·실재하지 않는 채널은 재시도해도 상태가 바뀌지
    // 않는다. 매핑이 없으면 전부 500 으로 떨어져 Portal 이 일시적 네트워크 장애와 똑같이
    // 재시도하다 dead-letter 로 보내고, 모니터링에서 진짜 장애와 구분되지 않는다.
    case "identity_conflict":
    case "identity_ambiguous":
    case "channel_reverification_conflict":
      return 409;
    case "channel_not_found":
    case "invalid_verified_channel_id":
    case "invalid_evidence_timestamp":
    case "missing_policy_version":
    case "invalid_subject":
      return 400;
    // 반대로 이건 진짜 일시 장애다(YouTube 도달 불가·쿼터). 재시도가 맞다.
    case "channel_lookup_unavailable":
      return 503;
    default:
      return 500;
  }
}

export function resolveIntegrationEventV2KeyRing(input: {
  secret?: string;
  previousSecret?: string;
}): IntegrationEventV2KeyRing {
  const currentSecret = input.secret ?? process.env[SCP_INTEGRATION_EVENT_V2_SECRET_ENV] ?? "";
  const previousSecret = input.previousSecret ?? process.env[SCP_INTEGRATION_EVENT_V2_PREVIOUS_SECRET_ENV] ?? "";
  if (currentSecret.length < 32) throw v2Error("signature_invalid", "v2 shared secret is not configured");
  const ring: { current: { keyId: string; secret: string }; previous?: { keyId: string; secret: string } } = {
    current: { keyId: "current", secret: currentSecret },
  };
  if (previousSecret.length >= 32) ring.previous = { keyId: "previous", secret: previousSecret };
  return ring;
}

export type IngestScpIntegrationEventV2Input = {
  rawBody: string;
  headers: Readonly<Record<string, string | undefined>>;
  isHttps: boolean;
  hasBearerOrCookie: boolean;
  now?: Date;
  secret?: string;
  previousSecret?: string;
  /** Test-only override of the video-review UID gate policy shim (defaults to non-blocking for v2). */
  videoUidGatePolicy?: "v1_fail_closed" | "v2_non_blocking";
  /** Test-only binding resolver override used to prove lookup failures remain retryable. */
  resolveVideoCreator?: (
    programId: string,
    applicationId: string,
  ) => Promise<Record<string, string>>;
};

export type IngestScpIntegrationEventV2Result = {
  status: 200 | 201;
  duplicate: boolean;
  eventId: string;
  eventName: IntegrationEventV2Name;
  effect: Record<string, unknown>;
  receipt: {
    schemaVersion: "scp.integration-event-v2.flu-receipt.v1";
    receiver: "flu";
    status: "accepted";
    eventId: string;
    identitySha256: string;
    bodySha256: string;
    acceptedAt: string;
  };
};

type LedgerDecision = {
  decision: "accepted" | "duplicate";
  runEffect: boolean;
  receiptRef: FirebaseFirestore.DocumentReference;
  committedReviewStateScopes?: ReviewQueueCacheInvalidationScope[];
};

type CanonicalVideoGraph = {
  source: Record<string, unknown>;
  programScope: VideoReviewProgramScope;
  contentFingerprint: string;
};

type HistoricalReviewEvidence = {
  sourceManifestId: string;
  sourceRowNumber: number;
  rawStatus: string;
  decidedAt: string;
  decisionRef: string;
  verifiedYoutubeChannelId?: string;
  rosterCreatorId?: string;
};

type LegacySheetEventPolicy = HistoricalReviewEvidence & {
  eventId: string;
  submissionId: string;
  youtubeVideoId: string;
  applicationId: string;
  targetStatus: "approved" | "rejected" | "human_review_required";
};

function isLegacySheetVideoEvent(event: IntegrationEventV2): boolean {
  return event.eventName === "video.submitted" &&
    asString(event.subject.videoSubmissionId).startsWith("legacy_sheet_");
}

function canonicalUnclassifiedId(
  kind: "portalCreator" | "fluCreator" | "partner" | "enrollment" | "channel",
  event: IntegrationEventV2,
): string {
  return `unclassified:${kind}:${docId(
    `${event.subject.applicationId}|${event.subject.videoSubmissionId ?? ""}`,
  ).slice(0, 24)}`;
}

function canonicalVideoGraph(
  event: IntegrationEventV2,
  resolvedCreator: Record<string, string> | null,
  nowIso: string,
  legacyPolicy: LegacySheetEventPolicy | null = null,
  // 2026-09-05 P1 리뷰 수리: 운영 오버라이드(settings/program_titles). 이 함수는 동기라 직접
  // 로드하지 못한다 — 양쪽 호출부(ensureCanonicalVideoGraphInTransaction·dispatchVideoSubmitted)의
  // 진입부인 ingestScpIntegrationEventV2 가 한 번 로드해 그대로 넘긴다.
  registryOverride?: unknown,
  // 2026-09-06 program-resolution 수리: 포털은 모든 신청에 같은 apply-gate 태그(view-cpm)를
  // 서명해 보낸다 — 실 프로그램이 아니다. `ingestScpIntegrationEventV2` 가 트랜잭션 밖에서 한 번
  // 해석해(reviewStateProgramResolution.ts) 넘긴다. 생략 시(레거시 호출부·기존 테스트) 원본
  // `subject.programId` 를 그대로 쓴다 — 동작 불변.
  programResolution?: ReviewStateProgramResolution,
): CanonicalVideoGraph {
  const payload = event.payload as {
    canonicalVideoUrl: string;
    youtubeVideoId: string;
    reportedViews: number;
    contentType: string;
    publishedAt: string;
    deliveryMode?: "live" | "historical_import";
    title?: string;
    /** 선택 키(계약 v2). 레지스트리 타이틀 id — 없으면 프로그램 기본 타이틀. */
    gameId?: string;
  };
  const subject = event.subject;
  const contentFingerprint = sha256Hex(
    `${payload.canonicalVideoUrl}|${subject.videoSubmissionId}`,
  );
  const creator = resolvedCreator ?? {};
  const resolved = (value: unknown): string => {
    const candidate = asString(value);
    return /^(?:portal-unresolved|CR_UNRESOLVED|partner-unresolved|enrollment-unresolved|channel-unresolved)$/.test(
      candidate,
    )
      ? ""
      : candidate;
  };
  // W7-1c-fix (2026-09-06): the resolved id, never the raw Portal apply-gate tag. programId and
  // canonicalProgramId MUST agree (videoReviewProgramScopeFromTrustedRecords below throws
  // "ambiguous" otherwise) — the raw tag survives unconditionally in portalProgramId.
  const resolvedProgramId = programResolution?.programId || subject.programId;
  const source: Record<string, unknown> = {
    id: subject.videoSubmissionId,
    videoSubmissionId: subject.videoSubmissionId,
    submissionId: subject.videoSubmissionId,
    revision: event.revision,
    programId: resolvedProgramId,
    canonicalProgramId: resolvedProgramId,
    portalProgramId: subject.programId,
    applicationId: subject.applicationId,
    campaignId: subject.campaignId ?? "unclassified",
    outreachId: subject.outreachId ?? null,
    portalCreatorId:
      resolved(creator.portalCreatorId) ||
      canonicalUnclassifiedId("portalCreator", event),
    fluCreatorId:
      resolved(creator.fluCreatorId) ||
      canonicalUnclassifiedId("fluCreator", event),
    partnerId:
      resolved(creator.partnerId) || canonicalUnclassifiedId("partner", event),
    enrollmentId:
      resolved(creator.enrollmentId) ||
      canonicalUnclassifiedId("enrollment", event),
    channelId:
      resolved(creator.channelId) || canonicalUnclassifiedId("channel", event),
    sourceSubmissionId: subject.videoSubmissionId,
    sourceContract: SCP_INTEGRATION_EVENT_V2_CONTRACT,
    sourceEventId: event.eventId,
    traceId: event.traceId,
    contentFingerprint,
    youtubeUrl: payload.canonicalVideoUrl,
    youtubeVideoId: payload.youtubeVideoId,
    reportedViews: payload.reportedViews,
    contentType: payload.contentType,
    ...(payload.title ? { title: payload.title } : {}),
    publishedAtIso: payload.publishedAt,
    submittedAtIso: event.occurredAt,
    deliveryMode: legacyPolicy ? "historical_import" : "live",
    historicalImport: Boolean(legacyPolicy),
    // The canonical automation fingerprint includes resubmissionCount. This makes a legitimate
    // monotonic revision a new automation generation even when the YouTube URL/timestamp are
    // otherwise unchanged.
    resubmissionCount: Math.max(0, event.revision - 1),
    // 다타이틀 프로그램: 선택 키 payload.gameId 를 레지스트리 id 로 확정한다. 없으면 프로그램
    // 기본 타이틀(오늘 동작), 미등록 값이면 기본 타이틀 + gameIdUnresolved 로 사람 게이트행.
    // 두 폴백 모두 gameIdDefaulted: true 를 함께 싣는다 — 스탬프된 gameId 는 행의 게임 증거가
    // 아니라는 strict 필터 신호다.
    ...resolveSubmissionGameId(subject.programId, payload.gameId, registryOverride),
    policyVersion: VIDEO_REVIEW_POLICY_VERSION,
  };
  const programScope = videoReviewProgramScopeFromTrustedRecords(
    { submission: source },
    { legacyScpFallback: false },
  );
  return {
    source: {
      ...source,
      policyConfigHash: programScope.policyConfigHash,
      programScopeVersion: programScope.scopeVersion,
    },
    programScope,
    contentFingerprint,
  };
}

async function ensureCanonicalVideoGraphInTransaction(
  transaction: FirebaseFirestore.Transaction,
  event: IntegrationEventV2,
  resolvedCreator: Record<string, string> | null,
  reviewStateSnapshot: FirebaseFirestore.DocumentSnapshot,
  nowIso: string,
  legacyPolicy: LegacySheetEventPolicy | null = null,
  registryOverride?: unknown,
  programResolution?: ReviewStateProgramResolution,
): Promise<{
  reviewState: string;
  outboxEnqueued: boolean;
  submissionId: string;
  committedReviewStateScopes: ReviewQueueCacheInvalidationScope[];
}> {
  if (event.eventName !== "video.submitted" || !event.subject.videoSubmissionId) {
    throw v2Error("invalid_payload", "canonical video identity is unavailable");
  }
  const graph = canonicalVideoGraph(event, resolvedCreator, nowIso, legacyPolicy, registryOverride, programResolution);
  const decisionPolicyVersion = legacyPolicy
    ? graph.programScope.policyConfigHash
    : VIDEO_REVIEW_POLICY_VERSION;
  const reviewRef = reviewStateSnapshot.ref;
  const prior = reviewStateSnapshot.data() ?? {};
  const priorSubject = asRecord(prior.subject);
  const priorInvalidationScope = reviewStateSnapshot.exists
    ? {
        canonicalProgramId:
          asString(prior.canonicalProgramId) ||
          asString(priorSubject.programId) ||
          asString(prior.programId),
        campaignId:
          asString(priorSubject.campaignId) ||
          asString(prior.campaignId),
      }
    : null;
  const nextInvalidationScope = {
    canonicalProgramId: asString(graph.source.canonicalProgramId),
    campaignId: event.subject.campaignId ?? "unclassified",
  };
  const priorRevision = Number(prior.revision ?? 0);
  const supersedesPriorRevision =
    reviewStateSnapshot.exists && event.revision > priorRevision;
  const priorVideoId = supersedesPriorRevision
    ? (
      extractYouTubeVideoIdFromSubmissionUrl(prior.youtubeVideoId)
      ?? extractYouTubeVideoIdFromSubmissionUrl(prior.youtubeUrl)
    )
    : null;
  const priorFeedRef = priorVideoId
    ? adminDb.collection("videos").doc(priorVideoId)
    : null;
  // Read the prior Feed projection before enqueueVideoReviewAutomationOutboxInTransaction starts
  // writing. Firestore transactions require every read to precede every write.
  const priorFeedSnapshot = priorFeedRef
    ? await transaction.get(priorFeedRef)
    : null;
  if (reviewStateSnapshot.exists) {
    if (event.revision < priorRevision) {
      throw new IntegrationEventV2Error("revision_not_monotonic");
    }
    // 2026-09-06 program-resolution 수리: canonicalProgramId/subject.programId 는 이제 해석된 실
    // 프로그램 id 를 담을 수 있어 포털이 매번 보내는 원시 태그(view-cpm)와 달라질 수 있다 —
    // portalProgramId(있으면)가 "이 헤드가 원래 어떤 포털 태그였나"의 정본이다. 없으면(백필 전
    // 레거시 문서) 예전과 동일하게 subject/canonicalProgramId/programId 원시값으로 폴백한다.
    const priorPortalProgramId =
      asString(priorSubject.portalProgramId) ||
      asString(prior.portalProgramId) ||
      asString(priorSubject.programId) ||
      asString(prior.canonicalProgramId) ||
      asString(prior.programId);
    const lineageConflict =
      asString(prior.traceId) !== event.traceId ||
      priorPortalProgramId !== event.subject.programId ||
      (asString(priorSubject.applicationId) ||
        asString(prior.applicationId)) !==
        event.subject.applicationId;
    const sameRevisionConflict =
      event.revision === priorRevision &&
      asString(prior.contentFingerprint) !== graph.contentFingerprint;
    if (lineageConflict || sameRevisionConflict) {
      throw new IntegrationEventV2Error("idempotency_conflict");
    }
  }
  const automationSource = supersedesPriorRevision
    ? graph.source
    : reviewStateSnapshot.exists
      ? { id: reviewStateSnapshot.id, ...prior }
      : graph.source;
  const outbox = legacyPolicy
    ? { enqueued: false, status: "historical_human_decision" }
    : await enqueueVideoReviewAutomationOutboxInTransaction(
        transaction,
        {
          submissionId: event.subject.videoSubmissionId,
          kind: "ai_recommendation",
          nowIso,
          source: automationSource,
          sourceKind: "canonical_review_state",
          sourceRevision: event.revision,
          sourceFingerprint: videoReviewAutomationSourceFingerprint(
            automationSource,
            graph.programScope,
          ),
          programScope: graph.programScope,
        },
      );
  if (
    supersedesPriorRevision
    && priorFeedRef
    && priorFeedSnapshot?.exists
    && (
      asString(prior.state) === "approved"
      || prior.feedEligible === true
    )
  ) {
    const priorFeed = priorFeedSnapshot.data() ?? {};
    const priorFeedMeta = asRecord(priorFeed.scpReviewMeta);
    const priorFeedSubmissionId = asString(priorFeedMeta.submissionId);
    const isScpProjection =
      priorFeed.source === "scpReviewPass"
      || priorFeed.scpReviewPass === true
      || priorFeedMeta.source === "scpReviewPass";
    if (
      isScpProjection
      && (
        !priorFeedSubmissionId
        || priorFeedSubmissionId === event.subject.videoSubmissionId
      )
    ) {
      transaction.set(
        priorFeedRef,
        {
          scpReviewPass: false,
          archivedAt: nowIso,
          archiveReason: "scp_revision_superseded",
          scpReviewMeta: {
            ...priorFeedMeta,
            reviewStatus: "queued",
            supersededRevision: priorRevision,
            supersededByRevision: event.revision,
            supersededAtIso: nowIso,
          },
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
  }
  if (!reviewStateSnapshot.exists) {
    transaction.create(reviewRef, {
      ...graph.source,
      subject: {
        applicationId: event.subject.applicationId,
        // Resolved value (agrees with the doc-root canonicalProgramId above) — the raw Portal
        // apply-gate tag survives in portalProgramId, never lost.
        programId: graph.source.canonicalProgramId,
        portalProgramId: event.subject.programId,
        campaignId: event.subject.campaignId ?? "unclassified",
        outreachId: event.subject.outreachId ?? null,
        portalCreatorId: graph.source.portalCreatorId,
        fluCreatorId: graph.source.fluCreatorId,
        partnerId: graph.source.partnerId,
        enrollmentId: graph.source.enrollmentId,
        channelId: graph.source.channelId,
        videoSubmissionId: event.subject.videoSubmissionId,
        videoRevision: event.revision,
        sourceSubmissionId: event.subject.videoSubmissionId,
        contentFingerprint: graph.contentFingerprint,
        gameId: graph.source.gameId,
        gameIdUnresolved: graph.source.gameIdUnresolved,
        // 기본값 스탬프 마커 — 명시 boolean 으로 싣는다(merge 쓰기에서 키 누락은 stale true 잔존).
        gameIdDefaulted: graph.source.gameIdDefaulted === true,
        policyVersion: decisionPolicyVersion,
      },
      state: "queued",
      reviewId: `review_${event.subject.videoSubmissionId}`,
      withdrawn: false,
      superseded: false,
      feedEligible: false,
      reportEligible: false,
      trackingEligible: false,
      settlementEligible: false,
      downstreamProjectionConfirmed: false,
      ruleEvidenceLedger: initialVideoReviewRuleEvidenceLedger(nowIso),
      reviewLedger: [],
      appliedDecisionRefs: [],
      lastEventId: event.eventId,
      lastEventName: event.eventName,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } else if (supersedesPriorRevision) {
    // scp_video_review_state is the single current head. A higher revision replaces that head,
    // re-enters review, and clears revision-scoped evidence/eligibility. Immutable event
    // observations and receipts retain the prior revision's audit trail.
    transaction.set(
      reviewRef,
      {
        ...graph.source,
        subject: {
          applicationId: event.subject.applicationId,
          // Resolved value (agrees with the doc-root canonicalProgramId above) — the raw Portal
          // apply-gate tag survives in portalProgramId, never lost.
          programId: graph.source.canonicalProgramId,
          portalProgramId: event.subject.programId,
          campaignId: event.subject.campaignId ?? "unclassified",
          outreachId: event.subject.outreachId ?? null,
          portalCreatorId: graph.source.portalCreatorId,
          fluCreatorId: graph.source.fluCreatorId,
          partnerId: graph.source.partnerId,
          enrollmentId: graph.source.enrollmentId,
          channelId: graph.source.channelId,
          videoSubmissionId: event.subject.videoSubmissionId,
          videoRevision: event.revision,
          sourceSubmissionId: event.subject.videoSubmissionId,
          contentFingerprint: graph.contentFingerprint,
          gameId: graph.source.gameId,
          gameIdUnresolved: graph.source.gameIdUnresolved,
          // 기본값 스탬프 마커 — 명시 boolean 으로 싣는다(merge 쓰기에서 키 누락은 stale true 잔존).
          gameIdDefaulted: graph.source.gameIdDefaulted === true,
          policyVersion: decisionPolicyVersion,
        },
        state: "queued",
        withdrawn: false,
        // This flag describes the current head. The new head is current, not itself superseded.
        superseded: false,
        feedEligible: false,
        reportEligible: false,
        trackingEligible: false,
        settlementEligible: false,
        downstreamProjectionConfirmed: false,
        ruleEvidenceLedger: initialVideoReviewRuleEvidenceLedger(nowIso),
        aiRecommendation: FieldValue.delete(),
        aiRecommendationMultimodal: FieldValue.delete(),
        videoReviewByScope: FieldValue.delete(),
        latestVideoReviewDecisionRef: FieldValue.delete(),
        lastDecisionEvidence: FieldValue.delete(),
        lastReviewEvidence: FieldValue.delete(),
        videoReviewEvidence: FieldValue.delete(),
        analysisEvidence: FieldValue.delete(),
        // The analysis drain's terminal-skip marker is keyed to (revision, mediaKey) — a
        // superseding revision drops it so the new head is evaluated fresh.
        analysisSkip: FieldValue.delete(),
        // Same rationale — the media-retry backoff marker is keyed to (revision, mediaKey)
        // too, and a superseding revision must not carry a stale attempt/backoff count over
        // to the new head.
        analysisMediaRetry: FieldValue.delete(),
        previousRevision: priorRevision,
        previousContentFingerprint:
          asString(prior.contentFingerprint) || null,
        revisionSupersededAtIso: nowIso,
        lastEventId: event.eventId,
        lastEventName: event.eventName,
        updatedAtIso: nowIso,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
  const committedReviewStateScopes = !reviewStateSnapshot.exists || supersedesPriorRevision
    ? [
        ...(priorInvalidationScope ? [priorInvalidationScope] : []),
        nextInvalidationScope,
      ]
    : [];
  return {
    reviewState: supersedesPriorRevision
      ? "queued"
      : asString(prior.state) || "queued",
    outboxEnqueued: outbox.enqueued,
    submissionId: event.subject.videoSubmissionId,
    committedReviewStateScopes,
  };
}

// Durable receipt ledger: mirrors the in-memory reference ledger semantics against Firestore in a
// single reserve transaction, then finalizes effect completion out of band for crash recovery.
async function reserveIntegrationEventV2Receipt(
  event: IntegrationEventV2,
  signatureHeader: string,
  eventIdentitySha256: string,
  bodySha256: string,
  now: Date,
  videoCreator: Record<string, string> | null,
  legacyPolicy: LegacySheetEventPolicy | null,
  registryOverride?: unknown,
  programResolution?: ReviewStateProgramResolution,
): Promise<LedgerDecision> {
  const subjectKey = integrationEventV2SubjectKey(event);
  const pipelineKey = integrationEventV2PipelineKey(event);
  const receiptRef = adminDb.collection(INTEGRATION_EVENT_V2_RECEIPTS_COLLECTION).doc(docId(event.eventId));
  const subjectRef = adminDb.collection(INTEGRATION_EVENT_V2_SUBJECTS_COLLECTION).doc(docId(subjectKey));
  const pipelineRef = adminDb.collection(INTEGRATION_EVENT_V2_PIPELINES_COLLECTION).doc(docId(pipelineKey));
  const signatureRef = adminDb.collection(INTEGRATION_EVENT_V2_SIGNATURES_COLLECTION).doc(docId(signatureHeader));
  const observationRef = adminDb.collection(INTEGRATION_EVENT_V2_OBSERVATIONS_COLLECTION).doc(docId(event.eventId));
  const contentMailRef =
    event.eventName === "video.submitted" &&
    event.subject.videoSubmissionId &&
    !legacyPolicy
      ? adminDb
          .collection(SCP_CONTENT_SUBMITTED_MAIL_OUTBOX_COLLECTION)
          .doc(
            contentSubmittedMailOutboxDocId(
              event.subject.videoSubmissionId,
              event.revision,
            ),
          )
      : null;
  const reviewStateRef =
    event.eventName === "video.submitted" && event.subject.videoSubmissionId
      ? adminDb
          .collection("scp_video_review_state")
          .doc(event.subject.videoSubmissionId)
      : null;
  const nowIso = now.toISOString();
  const contentMailTemplate =
    event.eventName === "video.submitted" && event.subject.videoSubmissionId
      ? await resolveScpReceiptMailTemplate("content_submitted", {
          application_id: event.subject.applicationId,
          program_name: event.subject.programId,
          video_submission_id: event.subject.videoSubmissionId,
          video_revision: String(event.revision),
        })
      : null;

  return adminDb.runTransaction<LedgerDecision>(async (transaction) => {
    const [
      receiptSnap,
      signatureSnap,
      subjectSnap,
      pipelineSnap,
      contentMailSnap,
      reviewStateSnap,
    ] = await Promise.all([
      transaction.get(receiptRef),
      transaction.get(signatureRef),
      transaction.get(subjectRef),
      transaction.get(pipelineRef),
      contentMailRef ? transaction.get(contentMailRef) : Promise.resolve(null),
      reviewStateRef
        ? transaction.get(reviewStateRef)
        : Promise.resolve(null),
    ]);

    // (3) authenticated signature replay guard — before any effect.
    if (signatureSnap.exists) {
      const sig = signatureSnap.data() ?? {};
      const exactAcceptedRetry = sig.accepted === true
        && asString(sig.eventId) === event.eventId
        && asString(sig.identitySha256) === eventIdentitySha256
        && asString(sig.bodySha256) === bodySha256;
      if (!exactAcceptedRetry) throw new IntegrationEventV2Error("replay_rejected");
      const currentSubjectRevision = Number(
        subjectSnap.data()?.revision ?? event.revision,
      );
      const canonicalRepairNeeded =
        event.eventName === "video.submitted" &&
        event.revision === currentSubjectRevision &&
        Boolean(reviewStateSnap && !reviewStateSnap.exists);
      let committedReviewStateScopes: ReviewQueueCacheInvalidationScope[] = [];
      if (
        event.eventName === "video.submitted" &&
        reviewStateSnap &&
        event.revision >= Number(reviewStateSnap.data()?.revision ?? 0) &&
        event.revision === currentSubjectRevision
      ) {
        const canonicalGraph = await ensureCanonicalVideoGraphInTransaction(
          transaction,
          event,
          videoCreator,
          reviewStateSnap,
          nowIso,
          legacyPolicy,
          registryOverride,
          programResolution,
        );
        committedReviewStateScopes = canonicalGraph.committedReviewStateScopes;
      }
      const runEffect =
        canonicalRepairNeeded ||
        !receiptSnap.exists ||
        asString(receiptSnap.data()?.effectState) !== "done";
      return { decision: "duplicate", runEffect, receiptRef, committedReviewStateScopes };
    }

    // (4) global eventId idempotency + logical identity equality.
    if (receiptSnap.exists) {
      const receipt = receiptSnap.data() ?? {};
      if (asString(receipt.identitySha256) !== eventIdentitySha256) {
        throw new IntegrationEventV2Error("idempotency_conflict");
      }
      const currentSubjectRevision = Number(
        subjectSnap.data()?.revision ?? event.revision,
      );
      const canonicalRepairNeeded =
        event.eventName === "video.submitted" &&
        event.revision === currentSubjectRevision &&
        Boolean(reviewStateSnap && !reviewStateSnap.exists);
      let committedReviewStateScopes: ReviewQueueCacheInvalidationScope[] = [];
      if (
        event.eventName === "video.submitted" &&
        reviewStateSnap &&
        event.revision >= Number(reviewStateSnap.data()?.revision ?? 0) &&
        event.revision === currentSubjectRevision
      ) {
        const canonicalGraph = await ensureCanonicalVideoGraphInTransaction(
          transaction,
          event,
          videoCreator,
          reviewStateSnap,
          nowIso,
          legacyPolicy,
          registryOverride,
          programResolution,
        );
        committedReviewStateScopes = canonicalGraph.committedReviewStateScopes;
      }
      // Same eventId + same identity, new signature (e.g. re-emitted occurredAt) -> duplicate success.
      transaction.set(signatureRef, {
        eventId: event.eventId,
        identitySha256: eventIdentitySha256,
        bodySha256,
        accepted: true,
        createdAtIso: nowIso,
        createdAt: FieldValue.serverTimestamp(),
      });
      return {
        decision: "duplicate",
        runEffect:
          canonicalRepairNeeded || asString(receipt.effectState) !== "done",
        receiptRef,
        committedReviewStateScopes,
      };
    }

    // (5) cross-event pipeline trace continuity.
    if (pipelineSnap.exists && asString(pipelineSnap.data()?.traceId) !== event.traceId) {
      throw new IntegrationEventV2Error("trace_mismatch");
    }
    // (6) event-scoped revision monotonicity.
    if (subjectSnap.exists && event.revision <= Number(subjectSnap.data()?.revision ?? 0)) {
      throw new IntegrationEventV2Error("revision_not_monotonic");
    }
    let committedReviewStateScopes: ReviewQueueCacheInvalidationScope[] = [];
    if (event.eventName === "video.submitted" && reviewStateSnap) {
      const canonicalGraph = await ensureCanonicalVideoGraphInTransaction(
        transaction,
        event,
        videoCreator,
        reviewStateSnap,
        nowIso,
        legacyPolicy,
        registryOverride,
        programResolution,
      );
      committedReviewStateScopes = canonicalGraph.committedReviewStateScopes;
    }

    // (7) persist the accepted receipt (+ subject/pipeline/signature/observation) before any effect.
    transaction.set(receiptRef, {
      eventId: event.eventId,
      eventName: event.eventName,
      identitySha256: eventIdentitySha256,
      bodySha256,
      revision: event.revision,
      subjectKey,
      pipelineKey,
      traceId: event.traceId,
      effectState: "pending",
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.set(subjectRef, {
      subjectKey,
      revision: event.revision,
      eventId: event.eventId,
      updatedAtIso: nowIso,
    });
    if (!pipelineSnap.exists) {
      transaction.set(pipelineRef, { pipelineKey, traceId: event.traceId, createdAtIso: nowIso });
    }
    transaction.set(signatureRef, {
      eventId: event.eventId,
      identitySha256: eventIdentitySha256,
      bodySha256,
      accepted: true,
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    // Immutable observation — retained audit of the exact accepted event identity (no raw PII per contract).
    transaction.set(observationRef, {
      eventId: event.eventId,
      eventName: event.eventName,
      identitySha256: eventIdentitySha256,
      bodySha256,
      subjectKey,
      pipelineKey,
      traceId: event.traceId,
      revision: event.revision,
      subject: event.subject,
      occurredAt: event.occurredAt,
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    if (
      contentMailRef &&
      !contentMailSnap?.exists &&
      event.eventName === "video.submitted" &&
      event.subject.videoSubmissionId
    ) {
      const payload = event.payload as { canonicalVideoUrl: string };
      transaction.create(
        contentMailRef,
        contentSubmittedMailOutboxRow({
          applicationId: event.subject.applicationId,
          programId: event.subject.programId,
          ...(event.subject.campaignId
            ? { campaignId: event.subject.campaignId }
            : {}),
          ...(event.subject.outreachId
            ? { outreachId: event.subject.outreachId }
            : {}),
          ...(videoCreator?.portalCreatorId
            ? { portalCreatorId: videoCreator.portalCreatorId }
            : {}),
          ...(videoCreator?.fluCreatorId
            ? { fluCreatorId: videoCreator.fluCreatorId }
            : {}),
          ...(videoCreator?.partnerId
            ? { partnerId: videoCreator.partnerId }
            : {}),
          ...(videoCreator?.enrollmentId
            ? { enrollmentId: videoCreator.enrollmentId }
            : {}),
          videoSubmissionId: event.subject.videoSubmissionId,
          videoRevision: event.revision,
          contentFingerprint: sha256Hex(
            `${payload.canonicalVideoUrl}|${event.subject.videoSubmissionId}`,
          ),
          policyVersion: SCP_INTEGRATION_EVENT_V2_CONTRACT,
          eventId: event.eventId,
          traceId: event.traceId,
          sourceContract: SCP_INTEGRATION_EVENT_V2_CONTRACT,
          templateSnapshot: contentMailTemplate ?? undefined,
          nowIso,
        }),
      );
    }
    return { decision: "accepted", runEffect: true, receiptRef, committedReviewStateScopes };
  });
}

// Authority binding resolution from the 6-ID binding registry. Portal does not know Flu internal
// IDs; we resolve by applicationId. A missing/ambiguous binding yields a placeholder tuple so the
// deployed engine's binding gate records the event and routes it to human_required (never discard).
async function resolveCreatorTupleByApplication(programId: string, applicationId: string): Promise<Record<string, string>> {
  const unresolved = {
    portalCreatorId: "portal-unresolved",
    fluCreatorId: "CR_UNRESOLVED",
    partnerId: "partner-unresolved",
    programId,
    enrollmentId: "enrollment-unresolved",
    channelId: "channel-unresolved",
  };
  try {
    const matches = await adminDb.collection(BINDINGS_COLLECTION)
      .where("sourceApplicationId", "==", applicationId)
      .limit(2)
      .get();
    if (matches.size !== 1) {
      // Ambiguous/missing binding: operational signal (no PII — applicationId/programId are binding
      // keys, never email/UID). The engine still routes to human_required downstream.
      console.warn("[integration-event-v2] binding_unresolved", JSON.stringify({ programId, applicationId, matches: matches.size }));
      return unresolved;
    }
    const binding = matches.docs[0].data() ?? {};
    return {
      portalCreatorId: asString(binding.portalCreatorId) || unresolved.portalCreatorId,
      fluCreatorId: asString(binding.fluCreatorId) || unresolved.fluCreatorId,
      partnerId: asString(binding.partnerId) || unresolved.partnerId,
      programId: asString(binding.programId) || programId,
      enrollmentId: asString(binding.enrollmentId) || unresolved.enrollmentId,
      channelId: asString(binding.channelId) || unresolved.channelId,
    };
  } catch (error) {
    // A registry outage is not the same as a genuine zero/ambiguous binding result. It must fail
    // before the durable receipt/canonical head is reserved so an exact retry can resolve the real
    // tuple instead of permanently freezing placeholder identity into the review graph.
    console.warn("[integration-event-v2] binding_lookup_failed", JSON.stringify({ programId, applicationId, code: asString(asRecord(error).code) || "unknown" }));
    throw v2Error(
      "binding_lookup_failed",
      "creator binding registry lookup failed; retry the exact event",
    );
  }
}

type HistoricalCreatorResolution = {
  creator: Record<string, string>;
  evidence: HistoricalReviewEvidence;
  identityResolved: boolean;
  identitySource: "verified_youtube_channel_id" | "creator_id" | "human_review";
  bindingWrite: { docId: string; data: Record<string, unknown> } | null;
  creatorWrite: { docId: string; data: Record<string, unknown> } | null;
};

function validateLegacySheetPolicy(
  event: IntegrationEventV2,
  evidence: Record<string, unknown>,
): LegacySheetEventPolicy {
  if (event.eventName !== "video.submitted") {
    throw v2Error("legacy_policy_mismatch", "legacy policy event mismatch");
  }
  const eventId = asString(evidence.eventId);
  const submissionId = asString(evidence.submissionId);
  const youtubeVideoId = asString(evidence.youtubeVideoId);
  const applicationId = asString(evidence.applicationId);
  const rawStatus = asString(evidence.rawStatus);
  const targetStatus = asString(evidence.targetStatus);
  const decidedAt = asString(evidence.decidedAt);
  const sourceManifestId = asString(evidence.sourceManifestId);
  const sourceRowNumber = Number(evidence.sourceRowNumber);
  const decisionRef = asString(evidence.decisionRef);
  if (
    eventId !== event.eventId ||
    submissionId !== event.subject.videoSubmissionId ||
    youtubeVideoId !== event.subject.youtubeVideoId ||
    applicationId !== event.subject.applicationId ||
    decidedAt !== event.occurredAt ||
    !sourceManifestId ||
    !Number.isSafeInteger(sourceRowNumber) ||
    sourceRowNumber < 1 ||
    rawStatus.length > 64 ||
    !decisionRef ||
    !["approved", "rejected", "human_review_required"].includes(targetStatus)
  ) {
    throw v2Error("legacy_policy_mismatch", "legacy policy does not match event identity");
  }
  return {
    eventId,
    submissionId,
    youtubeVideoId,
    applicationId,
    sourceManifestId,
    sourceRowNumber,
    rawStatus,
    targetStatus: targetStatus as LegacySheetEventPolicy["targetStatus"],
    decidedAt,
    decisionRef,
    ...(asString(evidence.verifiedYoutubeChannelId)
      ? {
          verifiedYoutubeChannelId: asString(
            evidence.verifiedYoutubeChannelId,
          ),
        }
      : {}),
    ...(asString(evidence.rosterCreatorId)
      ? { rosterCreatorId: asString(evidence.rosterCreatorId) }
      : {}),
  };
}

async function legacySheetPolicyForEvent(
  event: IntegrationEventV2,
): Promise<LegacySheetEventPolicy | null> {
  if (!isLegacySheetVideoEvent(event)) return null;
  const snapshot = await adminDb
    .collection(LEGACY_SHEET_CONTROL_RECEIPTS_COLLECTION)
    .where("legacyEventIds", "array-contains", event.eventId)
    .limit(10)
    .get();
  if (snapshot.empty) {
    throw v2Error(
      "legacy_policy_missing",
      "legacy Sheet event policy is unavailable",
    );
  }
  const releasedControls = snapshot.docs
    .map((document) => document.data() ?? {})
    .filter((control) =>
      ["partially_released", "released"].includes(asString(control.status)),
    );
  if (!releasedControls.length) {
    throw v2Error(
      "legacy_policy_missing",
      "legacy Sheet control receipt is not released",
    );
  }
  const releasedPath = `scp_integration_event_v2_outbox/${event.eventId}`;
  const authorizingControls = releasedControls.filter((control) => {
    const releasedWritePaths = Array.isArray(control.releasedWritePaths)
      ? control.releasedWritePaths.map((value) => asString(value))
      : [];
    return releasedWritePaths.includes(releasedPath);
  });
  if (!authorizingControls.length) {
    throw v2Error(
      "legacy_policy_missing",
      "legacy Sheet event is not in the released ledger",
    );
  }
  const policies = authorizingControls.map((control) => {
    const byEventId = asRecord(control.legacyEventPoliciesByEventId);
    return validateLegacySheetPolicy(
      event,
      asRecord(byEventId[event.eventId]),
    );
  });
  const canonicalPolicy = JSON.stringify(policies[0]);
  if (
    policies.some((policy) => JSON.stringify(policy) !== canonicalPolicy)
  ) {
    throw v2Error(
      "legacy_policy_mismatch",
      "released legacy Sheet controls disagree for the event",
    );
  }
  return policies[0];
}

function unresolvedCreatorTuple(
  programId: string,
): Record<string, string> {
  return {
    portalCreatorId: "portal-unresolved",
    fluCreatorId: "CR_UNRESOLVED",
    partnerId: "partner-unresolved",
    programId,
    enrollmentId: "enrollment-unresolved",
    channelId: "channel-unresolved",
  };
}

function creatorTupleFromBinding(
  binding: Record<string, unknown>,
  programId: string,
): Record<string, string> {
  const unresolved = unresolvedCreatorTuple(programId);
  return {
    portalCreatorId:
      asString(binding.portalCreatorId) || unresolved.portalCreatorId,
    fluCreatorId:
      asString(binding.fluCreatorId) || unresolved.fluCreatorId,
    partnerId: asString(binding.partnerId) || unresolved.partnerId,
    programId: asString(binding.programId) || programId,
    enrollmentId:
      asString(binding.enrollmentId) || unresolved.enrollmentId,
    channelId: asString(binding.channelId) || unresolved.channelId,
  };
}

function historicalIdentitySuffix(kind: string, value: string): string {
  return createHash("sha256")
    .update(`legacy-sheet:${kind}:${value}`)
    .digest("hex")
    .slice(0, 24);
}

function historicalIdentityResolved(
  creator: Record<string, string>,
): boolean {
  return ![
    creator.portalCreatorId,
    creator.fluCreatorId,
    creator.partnerId,
    creator.enrollmentId,
  ].some((value) =>
    [
      "",
      "portal-unresolved",
      "CR_UNRESOLVED",
      "partner-unresolved",
      "enrollment-unresolved",
  ].includes(value));
}

async function creatorIdsForVerifiedChannel(
  channelId: string,
): Promise<Set<string>> {
  const [youtubeMatches, channelMatches] = await Promise.all([
    adminDb.collection(CREATORS_COLLECTION)
      .where("youtubeChannelId", "==", channelId)
      .limit(3)
      .get(),
    adminDb.collection(CREATORS_COLLECTION)
      .where("channelId", "==", channelId)
      .limit(3)
      .get(),
  ]);
  return new Set([
    ...youtubeMatches.docs.map((document) => document.id),
    ...channelMatches.docs.map((document) => document.id),
  ]);
}

async function resolveHistoricalCreator(
  event: IntegrationEventV2,
  legacyPolicy: LegacySheetEventPolicy,
): Promise<HistoricalCreatorResolution | null> {
  const evidence = legacyPolicy;
  if (event.eventName !== "video.submitted") return null;
  const programId = event.subject.programId;
  const channelId = evidence.verifiedYoutubeChannelId ?? "";
  const rosterCreatorId = evidence.rosterCreatorId ?? "";
  const identitySource = channelId
    ? "verified_youtube_channel_id" as const
    : rosterCreatorId
      ? "creator_id" as const
      : "human_review" as const;
  if (identitySource === "human_review") {
    return {
      creator: unresolvedCreatorTuple(programId),
      evidence,
      identityResolved: false,
      identitySource,
      bindingWrite: null,
      creatorWrite: null,
    };
  }

  const applicationBindings = await adminDb
    .collection(BINDINGS_COLLECTION)
    .where("sourceApplicationId", "==", event.subject.applicationId)
    .limit(3)
    .get();
  if (applicationBindings.size > 1) {
    return {
      creator: unresolvedCreatorTuple(programId),
      evidence,
      identityResolved: false,
      identitySource: "human_review",
      bindingWrite: null,
      creatorWrite: null,
    };
  }
  if (applicationBindings.size === 1) {
    const document = applicationBindings.docs[0];
    const binding = document.data() ?? {};
    const existingChannelId = asString(binding.channelId);
    const existingCreatorId = asString(binding.fluCreatorId);
    const verifiedChannelOwnerIds =
      channelId && !existingChannelId
        ? await creatorIdsForVerifiedChannel(channelId)
        : new Set<string>();
    const conflicts =
      (channelId && existingChannelId && existingChannelId !== channelId) ||
      (
        channelId &&
        !existingChannelId &&
        (
          verifiedChannelOwnerIds.size > 1 ||
          (
            verifiedChannelOwnerIds.size === 1 &&
            !verifiedChannelOwnerIds.has(existingCreatorId)
          )
        )
      ) ||
      (!channelId && rosterCreatorId && existingCreatorId !== rosterCreatorId);
    if (conflicts) {
      return {
        creator: unresolvedCreatorTuple(programId),
        evidence,
        identityResolved: false,
        identitySource: "human_review",
        bindingWrite: null,
        creatorWrite: null,
      };
    }
    const creator: Record<string, string> = {
      ...creatorTupleFromBinding(binding, programId),
      ...(channelId ? { channelId } : {}),
    };
    const creatorSnapshot = await adminDb
      .collection(CREATORS_COLLECTION)
      .doc(creator.fluCreatorId)
      .get();
    const approved = evidence.rawStatus.trim().toLowerCase() === "approval";
    return {
      creator,
      evidence,
      identityResolved: historicalIdentityResolved(creator),
      identitySource,
      bindingWrite:
        channelId && !existingChannelId
          ? {
              docId: document.id,
              data: {
                ...binding,
                channelId,
              },
            }
          : null,
      creatorWrite:
        approved && (
          !creatorSnapshot.exists ||
          (
            channelId &&
            !asString(creatorSnapshot.data()?.youtubeChannelId) &&
            !asString(creatorSnapshot.data()?.channelId)
          )
        )
          ? {
              docId: creator.fluCreatorId,
              data: {
                schemaVersion: "flu.legacy-sheet-creator.v1",
                id: creator.fluCreatorId,
                ...(channelId
                  ? { channelId, youtubeChannelId: channelId }
                  : {}),
                canonicalProgramId: programId,
                programId,
                source: "legacy_sheet_content_migration",
                identitySource,
                legacyImported: true,
              },
            }
          : null,
    };
  }

  const bindingSnapshots = channelId
    ? await adminDb.collection(BINDINGS_COLLECTION)
      .where("channelId", "==", channelId)
      .limit(3)
      .get()
    : await adminDb.collection(BINDINGS_COLLECTION)
      .where("fluCreatorId", "==", rosterCreatorId)
      .limit(3)
      .get();
  if (bindingSnapshots.size > 1) {
    return {
      creator: unresolvedCreatorTuple(programId),
      evidence,
      identityResolved: false,
      identitySource: "human_review",
      bindingWrite: null,
      creatorWrite: null,
    };
  }
  if (bindingSnapshots.size === 1) {
    const binding = bindingSnapshots.docs[0].data() ?? {};
    const creator = creatorTupleFromBinding(binding, programId);
    if (
      (channelId && asString(binding.channelId) !== channelId) ||
      (
        !channelId &&
        rosterCreatorId &&
        asString(binding.fluCreatorId) !== rosterCreatorId
      )
    ) {
      return {
        creator: unresolvedCreatorTuple(programId),
        evidence,
        identityResolved: false,
        identitySource: "human_review",
        bindingWrite: null,
        creatorWrite: null,
      };
    }
    const creatorRef = adminDb.collection(CREATORS_COLLECTION)
      .doc(creator.fluCreatorId);
    const creatorSnapshot = await creatorRef.get();
    const approved = evidence.rawStatus.trim().toLowerCase() === "approval";
    return {
      creator,
      evidence,
      identityResolved: historicalIdentityResolved(creator),
      identitySource,
      bindingWrite: null,
      creatorWrite:
        approved && !creatorSnapshot.exists
          ? {
              docId: creator.fluCreatorId,
              data: {
                schemaVersion: "flu.legacy-sheet-creator.v1",
                id: creator.fluCreatorId,
                ...(channelId
                  ? { channelId, youtubeChannelId: channelId }
                  : {}),
                canonicalProgramId: programId,
                programId,
                source: "legacy_sheet_content_migration",
                identitySource,
                legacyImported: true,
              },
            }
          : null,
    };
  }

  let fluCreatorId = rosterCreatorId;
  if (channelId) {
    const ids = await creatorIdsForVerifiedChannel(channelId);
    if (ids.size > 1) {
      return {
        creator: unresolvedCreatorTuple(programId),
        evidence,
        identityResolved: false,
        identitySource: "human_review",
        bindingWrite: null,
        creatorWrite: null,
      };
    }
    fluCreatorId =
      ([...ids][0] ?? rosterCreatorId) ||
      `CR_legacy_youtube_${historicalIdentitySuffix("channel", channelId)}`;
  } else {
    const creatorSnapshot = await adminDb.collection(CREATORS_COLLECTION)
      .doc(rosterCreatorId)
      .get();
    if (creatorSnapshot.exists && creatorSnapshot.id !== rosterCreatorId) {
      return {
        creator: unresolvedCreatorTuple(programId),
        evidence,
        identityResolved: false,
        identitySource: "human_review",
        bindingWrite: null,
        creatorWrite: null,
      };
    }
  }

  const identityValue = channelId || rosterCreatorId;
  const suffix = historicalIdentitySuffix(identitySource, identityValue);
  const creator = {
    portalCreatorId: `legacy_sheet_subject_${suffix}`,
    fluCreatorId,
    partnerId: "scp_integration_scope",
    programId,
    enrollmentId: `legacy_sheet_enrollment_${suffix}`,
    channelId: channelId || "",
  };
  const approved = evidence.rawStatus.trim().toLowerCase() === "approval";
  return {
    creator,
    evidence,
    identityResolved: true,
    identitySource,
    bindingWrite: {
      docId: `legacy_sheet_binding_${historicalIdentitySuffix(
        "application",
        event.subject.applicationId,
      )}`,
      data: {
        schemaVersion: "scp.portal-creator-binding.v1",
        authorityVersion: "flu.legacy-sheet-channel-binding.v1",
        sourceApplicationId: event.subject.applicationId,
        portalCreatorId: creator.portalCreatorId,
        fluCreatorId: creator.fluCreatorId,
        partnerId: creator.partnerId,
        programId: creator.programId,
        enrollmentId: creator.enrollmentId,
        channelId: creator.channelId,
        status: "active",
        sourceManifestId: evidence.sourceManifestId,
        identitySource,
      },
    },
    creatorWrite: approved
      ? {
          docId: creator.fluCreatorId,
          data: {
            schemaVersion: "flu.legacy-sheet-creator.v1",
            id: creator.fluCreatorId,
            ...(channelId
              ? { channelId, youtubeChannelId: channelId }
              : {}),
            canonicalProgramId: programId,
            programId,
            source: "legacy_sheet_content_migration",
            identitySource,
            legacyImported: true,
          },
        }
      : null,
  };
}

async function materializeHistoricalCreator(
  resolution: HistoricalCreatorResolution,
  now: Date,
): Promise<void> {
  if (!resolution.identityResolved) return;
  const creatorRef = resolution.creatorWrite
    ? adminDb.collection(CREATORS_COLLECTION)
      .doc(resolution.creatorWrite.docId)
    : null;
  const bindingRef = resolution.bindingWrite
    ? adminDb.collection(BINDINGS_COLLECTION)
      .doc(resolution.bindingWrite.docId)
    : null;
  if (!creatorRef && !bindingRef) return;
  await adminDb.runTransaction(async (transaction) => {
    const [creatorSnapshot, bindingSnapshot] = await Promise.all([
      creatorRef ? transaction.get(creatorRef) : Promise.resolve(null),
      bindingRef ? transaction.get(bindingRef) : Promise.resolve(null),
    ]);
    if (creatorRef && resolution.creatorWrite) {
      if (creatorSnapshot?.exists) {
        const existing = creatorSnapshot.data() ?? {};
        const expectedChannel = asString(
          resolution.creatorWrite.data.youtubeChannelId,
        );
        const existingChannel =
          asString(existing.youtubeChannelId) || asString(existing.channelId);
        if (
          expectedChannel &&
          existingChannel &&
          existingChannel !== expectedChannel
        ) {
          throw v2Error(
            "identity_conflict",
            "legacy creator channel identity conflicts",
          );
        }
        if (expectedChannel && !existingChannel) {
          transaction.set(
            creatorRef,
            {
              channelId: expectedChannel,
              youtubeChannelId: expectedChannel,
              updatedAtIso: now.toISOString(),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
        }
      } else {
        // 생성 시점에도 updatedAtIso 를 심는다. 관리 화면 데이터셋은 creators 를
        // orderBy("updatedAtIso") 로 읽는데, Firestore 는 정렬 필드가 없는 문서를 결과에서
        // 아예 빼기 때문에 이 필드 없이 만들어진 크리에이터는 화면 도달이 영구 불가였다
        // (프로드 2026-07-26: legacy_sheet_content_migration 유입 15건이 이 상태). 위 merge
        // 분기는 이미 같은 쌍을 쓰고 있었고, create 분기만 빠져 있던 비대칭이다.
        transaction.create(creatorRef, {
          ...resolution.creatorWrite.data,
          createdAtIso: now.toISOString(),
          createdAt: FieldValue.serverTimestamp(),
          updatedAtIso: now.toISOString(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }
    if (bindingRef && resolution.bindingWrite) {
      if (bindingSnapshot?.exists) {
        const existing = bindingSnapshot.data() ?? {};
        for (const key of [
          "sourceApplicationId",
          "portalCreatorId",
          "fluCreatorId",
          "partnerId",
          "programId",
          "enrollmentId",
          "channelId",
          "identitySource",
        ]) {
          if (
            key === "channelId" &&
            !asString(existing[key]) &&
            asString(resolution.bindingWrite.data[key])
          ) {
            continue;
          }
          if (existing[key] !== resolution.bindingWrite.data[key]) {
            throw v2Error(
              "identity_conflict",
              `legacy binding conflicts:${key}`,
            );
          }
        }
        if (
          !asString(existing.channelId) &&
          asString(resolution.bindingWrite.data.channelId)
        ) {
          transaction.set(
            bindingRef,
            {
              channelId: resolution.bindingWrite.data.channelId,
              updatedAtIso: now.toISOString(),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
        }
      } else {
        transaction.create(bindingRef, {
          ...resolution.bindingWrite.data,
          createdAtIso: now.toISOString(),
          createdAt: FieldValue.serverTimestamp(),
        });
      }
    }
  });
}

async function dispatchVideoSubmitted(
  event: IntegrationEventV2,
  now: Date,
  _uidGatePolicy: "v1_fail_closed" | "v2_non_blocking",
  resolvedCreator?: Record<string, string> | null,
  legacyPolicy: LegacySheetEventPolicy | null = null,
  registryOverride?: unknown,
): Promise<Record<string, unknown>> {
  const payload = event.payload as {
    canonicalVideoUrl: string;
    youtubeVideoId: string;
    reportedViews: number;
    contentType: string;
    publishedAt: string;
    title?: string;
  };
  const subject = event.subject;
  const creator =
    resolvedCreator ??
    (await resolveCreatorTupleByApplication(
      subject.programId,
      subject.applicationId,
    ));
  const graph = canonicalVideoGraph(event, creator, now.toISOString(), legacyPolicy, registryOverride);
  // Reserve-time creation is atomic with the canonical review state, while this post-reserve
  // idempotent enqueue is the crash-repair fence. An older accepted receipt may have survived after
  // its state/outbox was lost; exact replay must restore BOTH, not just the state document.
  const historicalReview = legacyPolicy;
  const canonicalOutbox = historicalReview
    ? null
    : await enqueueVideoReviewAutomationOutbox({
        submissionId: subject.videoSubmissionId!,
        kind: "ai_recommendation",
        nowIso: now.toISOString(),
        sourceKind: "canonical_review_state",
        sourceRevision: event.revision,
      });
  let duplicateEvidenceState = "available";
  try {
    await upsertVideoFingerprint(
      {
        videoSubmissionId: subject.videoSubmissionId!,
        youtubeVideoId: payload.youtubeVideoId,
        fileHash: null,
        pHash: null,
        transcriptMinHash: null,
        revision: event.revision,
        canonicalProgramId: subject.programId,
      },
      now,
    );
    await evaluateDuplicateForSubmission(
      subject.videoSubmissionId!,
      {},
      now,
    );
  } catch (error) {
    duplicateEvidenceState = `pending:${asString(asRecord(error).code) || "unavailable"}`;
  }
  // Persist the v2 subject linkage so the signed callback producer can later emit
  // video.review-status.changed / video.view-snapshot.updated for this submission (merge-safe).
  await adminDb.collection(INTEGRATION_EVENT_V2_VIDEO_LINKS_COLLECTION).doc(subject.videoSubmissionId!).set({
    videoSubmissionId: subject.videoSubmissionId,
    programId: subject.programId,
    applicationId: subject.applicationId,
    youtubeVideoId: subject.youtubeVideoId,
    traceId: event.traceId,
    ...(subject.campaignId ? { campaignId: subject.campaignId } : {}),
    ...(subject.outreachId ? { outreachId: subject.outreachId } : {}),
    fluSubmissionId: `portal:${subject.videoSubmissionId}`,
    // 이 링크의 `reviewId` 는 포털 v2 리뷰 콜백 subject 의 **유일 정본**이다. 포털은 같은
    // videoSubmissionId 의 첫 수용 이벤트가 쓴 원문을 저장하고 이후 정확 일치만 요구하므로
    // (review_id_mismatch), 발신 이력이 생긴 뒤에는 이 값을 바꾸면 안 된다.
    reviewId: `review_${subject.videoSubmissionId}`,
    trackingId: `tracking_${subject.videoSubmissionId}`,
    // ⚠️ 인입 시점 스냅샷 전용이다 — 이후 판정이 나도 갱신되지 않는다. 심사 상태의 정본은
    // `scp_video_review_state.state` 다. (W125: 틀린 필드를 원장으로 읽은 것이 그 사고의 전부였다.)
    reviewState: "queued",
    deliveryMode: historicalReview ? "historical_import" : "live",
    historicalImport: Boolean(historicalReview),
    updatedAtIso: now.toISOString(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  let historicalDecision:
    | {
        status: "applied" | "idempotent" | "human_review_required";
        targetStatus?: "approved" | "rejected";
        partnerActivationStatus?: string | null;
      }
    | null = null;
  if (historicalReview) {
    const hasTrustedIdentity =
      Boolean(
        historicalReview.verifiedYoutubeChannelId ||
        historicalReview.rosterCreatorId,
      ) && historicalIdentityResolved(creator);
    if (!hasTrustedIdentity) {
      const decisionAt = new Date(historicalReview.decidedAt);
      const transition = await transitionVideoReviewDecision(
        {
          submissionId: subject.videoSubmissionId!,
          targetStatus: "human_review_required",
          reasonCode: "legacy_sheet_identity_human_review",
          customerMessageCode: null,
          expectedRevision: event.revision,
          expectedContentFingerprint: graph.contentFingerprint,
          expectedCanonicalProgramId: subject.programId,
          expectedPolicyConfigHash: graph.programScope.policyConfigHash,
          decisionRef: `${historicalReview.decisionRef}:identity_review`,
          actorType: "human",
          actorId: "legacy_sheet_human_decision_import",
          notifyCreator: false,
          deliveryMode: "historical_import",
          evidence: [
            {
              kind: "legacy_sheet_identity_review",
              verdict: "human_review_required",
              historicalAttribution: true,
              videoId: payload.youtubeVideoId,
            },
          ],
        },
        decisionAt,
      );
      historicalDecision = {
        status: transition.idempotent
          ? "idempotent"
          : "human_review_required",
      };
    } else {
      const targetStatus =
        historicalReview.rawStatus.trim().toLowerCase() === "approval"
          ? "approved"
          : "rejected";
      const decisionAt = new Date(historicalReview.decidedAt);
      const transition = await transitionVideoReviewDecision(
        {
          submissionId: subject.videoSubmissionId!,
          targetStatus,
          reasonCode:
            targetStatus === "approved"
              ? "legacy_sheet_approval"
              : "legacy_sheet_rejection",
          customerMessageCode: null,
          expectedRevision: event.revision,
          expectedContentFingerprint: graph.contentFingerprint,
          expectedCanonicalProgramId: subject.programId,
          expectedPolicyConfigHash: graph.programScope.policyConfigHash,
          decisionRef: historicalReview.decisionRef,
          actorType: "human",
          actorId: "legacy_sheet_human_decision_import",
          notifyCreator: false,
          deliveryMode: "historical_import",
          evidence: [
            {
              kind: "legacy_sheet_human_decision",
              verdict: targetStatus,
              historicalAttribution: true,
              videoId: payload.youtubeVideoId,
              ...(historicalReview.verifiedYoutubeChannelId
                ? {
                    channelId:
                      historicalReview.verifiedYoutubeChannelId,
                  }
                : {}),
            },
          ],
        },
        decisionAt,
      );
      historicalDecision = {
        status: transition.idempotent ? "idempotent" : "applied",
        targetStatus,
        partnerActivationStatus:
          transition.partnerActivation?.status ?? null,
      };
    }
  }
  return {
    engine: "canonical_video_review_state",
    reviewState:
      historicalDecision?.targetStatus ??
      (historicalDecision?.status === "human_review_required"
        ? "human_review_required"
        : "queued"),
    outboxEnqueued:
      canonicalOutbox
        ? canonicalOutbox.enqueued || canonicalOutbox.status === "queued"
        : false,
    submissionId: subject.videoSubmissionId,
    sourceKind: "canonical_review_state",
    policyConfigHash: graph.programScope.policyConfigHash,
    contentFingerprint: graph.contentFingerprint,
    duplicateEvidenceState,
    ...(historicalDecision ? { historicalDecision } : {}),
  };
}

// uid.submitted: record UID operational state. Non-blocking; the Portal-provided validationStatus is
// stored verbatim and NEVER elevated to "verified" by Flu. Only maskedUid + lookup HMAC exist on the
// wire (raw UID is contractually impossible), so nothing sensitive is persisted.
async function dispatchUidSubmitted(event: IntegrationEventV2, now: Date): Promise<Record<string, unknown>> {
  const subject = event.subject;
  const payload = event.payload as { maskedUid: string; uidLookupHmac: string; validationStatus: string };
  const stateId = docId(`${subject.programId}|${subject.applicationId}|${subject.uidGrantId}`);
  const ref = adminDb.collection(INTEGRATION_EVENT_V2_UID_STATES_COLLECTION).doc(stateId);
  const nowIso = now.toISOString();
  await adminDb.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const priorRevision = snap.exists ? Number(snap.data()?.revision ?? 0) : 0;
    if (event.revision < priorRevision) return; // stale state update: keep the newer state.
    transaction.set(ref, {
      programId: subject.programId,
      applicationId: subject.applicationId,
      uidGrantId: subject.uidGrantId,
      uidSubmissionId: subject.uidSubmissionId,
      maskedUid: payload.maskedUid,
      uidLookupHmac: payload.uidLookupHmac,
      validationStatus: payload.validationStatus,
      uidPolicy: "required_before_gem",
      // Flu never asserts verification on the creator's behalf; Gem gating is out of scope this release.
      fluVerifiedByFlu: false,
      traceId: event.traceId,
      lastEventId: event.eventId,
      revision: event.revision,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  return { engine: "uid_state", validationStatus: payload.validationStatus, blocksVideo: false };
}

// application.submitted / uid.guide-email.requested: the immutable v2 observation is already retained
// by the ledger. The UID-guide mail delivery (TASK 4) is a distinct fail-closed outbox handoff wired
// separately; here we enqueue a DURABLE fail-closed UID-guide mail intent (accumulates as "queued")
// so this is a real consumer action, not a no-op — the intent is drained/sent once the approved mail
// provider + Portal v2 protected-material endpoint contract land (TASK 4). No raw email/URL is stored.
async function dispatchApplicationEvent(event: IntegrationEventV2, now: Date): Promise<Record<string, unknown>> {
  const subject = event.subject;
  const payload = event.payload as { locale?: string; deliveryReason?: string };
  const deliveryReason = event.eventName === "uid.guide-email.requested"
    ? (payload.deliveryReason === "resend" ? "resend" : "initial")
    : "initial";
  const intentId = docId(`${subject.applicationId}|${subject.uidGrantId}`);
  const ref = adminDb.collection(INTEGRATION_EVENT_V2_UID_GUIDE_OUTBOX_COLLECTION).doc(intentId);
  const nowIso = now.toISOString();
  await adminDb.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const prior = snap.exists ? (snap.data() ?? {}) : null;
    // Idempotent + resend-aware: skip a stale revision for the same reason; a "resend" re-queues.
    if (prior && Number(prior.revision ?? 0) >= event.revision && asString(prior.lastDeliveryReason) === deliveryReason) {
      return;
    }
    transaction.set(ref, {
      programId: subject.programId,
      applicationId: subject.applicationId,
      uidGrantId: subject.uidGrantId,
      locale: payload.locale ?? null,
      lastDeliveryReason: deliveryReason,
      resendCount: Number(prior?.resendCount ?? 0) + (deliveryReason === "resend" ? 1 : 0),
      traceId: event.traceId,
      lastEventId: event.eventId,
      revision: event.revision,
      // Fail-closed: Flu owns delivery; the drain/send is TASK 4 (provider binding + Portal v2 material
      // endpoint). Until then this stays queued (never a fake "sent").
      deliveryState: "queued",
      transport: "unconfigured",
      attempts: Number(prior?.attempts ?? 0),
      createdAtIso: asString(prior?.createdAtIso) || nowIso,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  // Fail-closed Manage materialization (spec B §2-3): application.submitted materializes a durable
  // Flu application-management record. With no signed attribution in the current event it classifies
  // unclassified/token_absent and routes to the Manage inbox (never auto-managed). Additive; the
  // materialization never blocks the receiver ack.
  let manage: MaterializeResult | null = null;
  if (event.eventName === "application.submitted") {
    manage = await materializeApplicationManagementRecord({
      applicationId: subject.applicationId,
      programId: subject.programId ?? null,
      campaignId: subject.campaignId ?? null,
      outreachId: subject.outreachId ?? null,
      portalCreatorId: subject.portalCreatorId ?? null,
      channelId: subject.channelId ?? null,
      submittedAtIso: event.occurredAt,
      traceId: event.traceId,
      eventId: event.eventId,
      revision: event.revision,
      sourceContract: SCP_INTEGRATION_EVENT_V2_CONTRACT,
    }, now);
  }
  return {
    engine: "application_command_uid_guide",
    uidGuideIntent: "queued",
    deliveryReason,
    transport: "unconfigured",
    ...(manage ? { manageClassification: manage.classification, manageReasonCode: manage.reasonCode, manageInbox: manage.manageInbox } : {}),
  };
}

/**
 * Materialise the Flu creator that a portal-verified channel identifies, then leave the rest of
 * the approval chain to the paths that already own it. This is the missing receiving end for the
 * portal's OAuth verification: before it, no inbound contract could put a channel id onto a
 * `creators` document, so portal-approved applicants who had never been through Flu's own
 * outreach pipeline could never satisfy the binding authority root.
 */
async function dispatchCreatorChannelVerified(
  event: IntegrationEventV2,
  now: Date,
): Promise<Record<string, unknown>> {
  const payload = parsePortalChannelVerifiedPayload(
    (event as { payload?: unknown }).payload,
  );
  const subject = event.subject;
  const portalCreatorId = asString(subject.portalCreatorId);
  if (!portalCreatorId) {
    throw v2Error("invalid_subject", "creator.channel-verified requires subject.portalCreatorId");
  }
  const outcome = await materializePortalVerifiedCreator(
    {
      applicationId: subject.applicationId,
      portalCreatorId,
      programId: asString(subject.programId),
    },
    payload,
    now,
  );
  return {
    engine: "portal_channel_verified_identity",
    action: outcome.action,
    fluCreatorId: outcome.fluCreatorId,
  };
}

async function dispatchIntegrationEventV2(
  event: IntegrationEventV2,
  now: Date,
  videoUidGatePolicy: "v1_fail_closed" | "v2_non_blocking",
  videoCreator?: Record<string, string> | null,
  legacyPolicy: LegacySheetEventPolicy | null = null,
  registryOverride?: unknown,
): Promise<Record<string, unknown>> {
  switch (event.eventName) {
    case "video.submitted":
      return dispatchVideoSubmitted(
        event,
        now,
        videoUidGatePolicy,
        videoCreator,
        legacyPolicy,
        registryOverride,
      );
    case "uid.submitted":
      return dispatchUidSubmitted(event, now);
    case "application.submitted":
    case "uid.guide-email.requested":
      return dispatchApplicationEvent(event, now);
    case "creator.channel-verified":
      return dispatchCreatorChannelVerified(event, now);
    default:
      throw v2Error("unsupported_event", `event ${event.eventName} is not an inbound portal->flu event`);
  }
}

export async function ingestScpIntegrationEventV2(
  input: IngestScpIntegrationEventV2Input,
): Promise<IngestScpIntegrationEventV2Result> {
  if (!input.isHttps) throw v2Error("signature_invalid", "https required");
  if (input.hasBearerOrCookie) throw v2Error("signature_invalid", "service auth is HMAC only");
  if (Buffer.byteLength(input.rawBody, "utf8") > SCP_INTEGRATION_EVENT_V2_MAX_BODY_BYTES) {
    throw v2Error("body_too_large", "v2 event body exceeds the maximum size");
  }
  const now = input.now ?? new Date();
  const keys = resolveIntegrationEventV2KeyRing({ secret: input.secret, previousSecret: input.previousSecret });

  // (1)+(2) authenticate content hash / timestamp / key id / HMAC, then parse + validate canonical body.
  const verified = verifyIntegrationEventV2Request({
    body: input.rawBody,
    headers: input.headers,
    keys,
    now,
    maxSkewSeconds: SCP_INTEGRATION_EVENT_V2_MAX_SKEW_SECONDS,
  });
  const event = verified.event;
  if (!INBOUND_EVENT_NAMES.has(event.eventName)) {
    throw new IntegrationEventV2Error("invalid_event");
  }
  // 2026-09-05 P1 리뷰 수리: 운영 오버라이드를 요청 진입부에서 한 번 로드해 예약(트랜잭션 내
  // 리페어 경로 3곳)과 dispatch(신규 경로) 양쪽에 같은 값을 넘긴다 — video.submitted 가 아니면
  // 조회하지 않는다.
  const registryOverride = event.eventName === "video.submitted"
    ? await loadProgramTitleRegistry(event.subject.programId)
    : undefined;

  const signatureHeader = String(input.headers["x-scp-signature"] ?? input.headers["X-SCP-Signature"] ?? "");
  const eventIdentitySha256 = verified.identitySha256;
  const bodySha256 = verified.bodySha256;
  let videoCreator: Record<string, string> | null = null;
  let historicalCreatorResolution: HistoricalCreatorResolution | null = null;
  const legacyPolicy = await legacySheetPolicyForEvent(event);
  if (event.eventName === "video.submitted") {
    try {
      if (!input.resolveVideoCreator && legacyPolicy) {
        historicalCreatorResolution = await resolveHistoricalCreator(
          event,
          legacyPolicy,
        );
        videoCreator =
          historicalCreatorResolution?.creator ??
          unresolvedCreatorTuple(event.subject.programId);
      } else {
        videoCreator = await (
          input.resolveVideoCreator ?? resolveCreatorTupleByApplication
        )(
          event.subject.programId,
          event.subject.applicationId,
        );
      }
    } catch (error) {
      if (asString(asRecord(error).code) === "binding_lookup_failed") throw error;
      console.warn(
        "[integration-event-v2] binding_lookup_failed",
        JSON.stringify({
          programId: event.subject.programId,
          applicationId: event.subject.applicationId,
          code: asString(asRecord(error).code) || "unknown",
        }),
      );
      throw v2Error(
        "binding_lookup_failed",
        "creator binding registry lookup failed; retry the exact event",
      );
    }
  }

  // 2026-09-06: resolve the real program BEFORE the transaction (same discipline as videoCreator
  // above) — the Portal signs every event with its single apply-gate tag (view-cpm), never a real
  // program (reviewStateProgramResolution.ts header). Resolved once per event; a stale
  // application->program mapping mid-flight is the same acceptable race videoCreator already has.
  const programResolution = event.eventName === "video.submitted"
    ? await resolveReviewStateProgramId(
      {
        canonicalProgramId: event.subject.programId,
        subject: {
          applicationId: event.subject.applicationId,
          programId: event.subject.programId,
          campaignId: event.subject.campaignId,
        },
      },
      defaultReviewStateProgramResolutionDeps(),
    )
    : undefined;

  const decision = await reserveIntegrationEventV2Receipt(
    event,
    signatureHeader,
    eventIdentitySha256,
    bodySha256,
    now,
    videoCreator,
    legacyPolicy,
    registryOverride,
    programResolution,
  );
  if (decision.committedReviewStateScopes?.length) {
    invalidateReviewQueueCachesForCommittedWriteScopes(
      decision.committedReviewStateScopes,
    );
  }

  let effect: Record<string, unknown> = { skipped: true };
  if (decision.runEffect) {
    if (historicalCreatorResolution) {
      await materializeHistoricalCreator(historicalCreatorResolution, now);
    }
    effect = await dispatchIntegrationEventV2(
      event,
      now,
      input.videoUidGatePolicy ?? "v2_non_blocking",
      videoCreator,
      legacyPolicy,
      registryOverride,
    );
    await decision.receiptRef.set(
      { effectState: "done", effect, effectAtIso: now.toISOString() },
      { merge: true },
    );
  } else {
    const receiptSnap = await decision.receiptRef.get();
    effect = asRecord(receiptSnap.data()?.effect);
  }
  const durableReceipt = await decision.receiptRef.get();
  const acceptedAt = asString(durableReceipt.data()?.createdAtIso);
  if (
    !durableReceipt.exists ||
    asString(durableReceipt.data()?.eventId) !== event.eventId ||
    asString(durableReceipt.data()?.identitySha256) !== eventIdentitySha256 ||
    asString(durableReceipt.data()?.bodySha256) !== bodySha256 ||
    !acceptedAt
  ) {
    throw v2Error("invalid_payload", "durable receipt is unavailable");
  }

  return {
    status: decision.decision === "accepted" ? 201 : 200,
    duplicate: decision.decision === "duplicate",
    eventId: event.eventId,
    eventName: event.eventName,
    effect,
    receipt: {
      schemaVersion: "scp.integration-event-v2.flu-receipt.v1",
      receiver: "flu",
      status: "accepted",
      eventId: event.eventId,
      identitySha256: eventIdentitySha256,
      bodySha256,
      acceptedAt,
    },
  };
}
