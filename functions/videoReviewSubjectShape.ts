// Canonical shape helpers for the `scp_video_review_state` collection: the document-id
// derivation and the review-subject normalizer.
//
// These lived as private functions inside ./videoReviewTransitionStore. They were extracted
// (verbatim) so that the WRITE path (videoReviewTransitionStore) and the repair lane
// (videoReviewSubjectRepair*) share ONE definition instead of a copy. The module stays pure
// — no firebase-admin import — so the node test lane can pin it without touching a backend.
//
// NOT yet the single definition for the whole repo: private copies still live in
// videoReviewStateCallables.ts:184, scpIntegrationEventV2Callbacks.ts and
// scpVideoRevisionIngress.ts. They are NOT all identical — the read-path copy in
// videoReviewStateCallables deliberately FALLS BACK (`safe || submissionId.slice(0,180)`)
// where this one throws, because a scan/read surface must not abort on a degenerate id.
// Consolidating them is out of W122's scope; callers must not assume this module is the
// only derivation in the codebase.

import type { VideoReviewSubject } from "./partnerActivationCore";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The ONLY way a `scp_video_review_state` document id is derived from a submission id.
 * Every writer and reader must use it — a caller that hits the collection with the raw
 * submission id silently misses any document whose id contains `.` or `:` (both are legal
 * in a submission id and both are sanitized to `_` here).
 */
export function reviewDocId(submissionId: string): string {
  const safe = String(submissionId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180);
  if (!safe) throw new Error("invalid-argument: submissionId is required");
  return safe;
}

// Builds the partnerActivationCore VideoReviewSubject from the review-state doc's `subject` bag.
// P3#8 fix: videoRevision/contentFingerprint are NEVER echoed from the already-CAS-validated review
// head into a legacy/incomplete subject — a subject that omits its own videoRevision/contentFingerprint
// is itself incomplete evidence (never structurally repaired by the caller) and MUST fail closed to
// `partner_activation_identity_incomplete` (migration quarantine), never silently proceed with
// borrowed values. videoRevision missing => NaN (never a valid revision number); contentFingerprint
// missing => "" (never satisfies the required-field check below). Every other field (enrollmentId,
// applicationId, programId, campaignId, portalCreatorId, fluCreatorId, partnerId, policyVersion) is
// taken as-is — missing/blank values fail closed via planPartnerActivation's identity-completeness
// guard, never inferred.
export function subjectFromReviewStateData(raw: unknown): VideoReviewSubject {
  const rec: Record<string, unknown> = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const optStr = (value: unknown): string | undefined => (isNonEmptyString(value) ? value : undefined);
  return {
    enrollmentId: str(rec.enrollmentId),
    applicationId: str(rec.applicationId),
    programId: str(rec.programId),
    campaignId: str(rec.campaignId),
    outreachId: optStr(rec.outreachId),
    portalCreatorId: str(rec.portalCreatorId),
    fluCreatorId: str(rec.fluCreatorId),
    partnerId: str(rec.partnerId),
    videoSubmissionId: str(rec.videoSubmissionId),
    videoRevision: typeof rec.videoRevision === "number" ? rec.videoRevision : Number.NaN,
    contentFingerprint: str(rec.contentFingerprint),
    policyVersion: str(rec.policyVersion),
    settlementCreatorCode: optStr(rec.settlementCreatorCode),
    channelId: optStr(rec.channelId),
    // 2026-09-05 다타이틀 표시 사실(활성화 신원 아님). 없으면 undefined 로 남고, 읽는 쪽이
    // 프로그램 기본 타이틀로 해석한다 — 기존 원장(gameId 0건)의 동작이 그대로 유지된다.
    gameId: optStr(rec.gameId),
    ...(rec.gameIdUnresolved === true ? { gameIdUnresolved: true } : {}),
    // 인제스트 기본값 스탬프 마커 — gameId 가 행의 선언이 아니라 폴백 채우기일 때만 존재한다.
    ...(rec.gameIdDefaulted === true ? { gameIdDefaulted: true } : {}),
  };
}
