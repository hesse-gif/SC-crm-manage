export type StableId = string;
export type Rfc3339DateTime = string;
export type Sha256Hex = string;
export type TraceId = `tr_${string}`;
export type EventId = `evt_${string}`;

export type VideoReviewSubject = Readonly<{
  videoSubmissionId: StableId;
  videoRevision: number;
  applicationId: StableId;
  programId: StableId;
  portalCreatorId: StableId;
  fluCreatorId: StableId;
  partnerId: StableId;
  campaignId: StableId;
  outreachId?: StableId;
  enrollmentId: StableId;
  /** Explicit Portal projection identity. Absent for legacy revisions; never inferred. */
  sourceSubmissionId?: StableId;
  settlementCreatorCode?: StableId;
  channelId?: StableId;
  contentFingerprint: Sha256Hex;
  policyVersion: StableId;
}>;

type PortalVideoRevisionEventBase = Readonly<{
  schemaVersion: "scp.video-submission-review.v3";
  eventId: EventId;
  occurredAt: Rfc3339DateTime;
  source: "portal";
  traceId: TraceId;
  revision: number;
  subject: VideoReviewSubject;
}>;

export type PortalVideoRevisionSubmittedEvent = PortalVideoRevisionEventBase & Readonly<{
  eventName: "video.revision.submitted";
  payload: Readonly<{
    operation: "upsert" | "replace";
    correctionReasonCode: StableId;
    sourceUpdatedAt: Rfc3339DateTime;
    payloadHash: Sha256Hex;
    canonicalVideoUrl: string;
    youtubeVideoId: string;
    publishedAt: Rfc3339DateTime;
    contentType: "short" | "long_form" | "live";
    invalidatesApprovedRevision?: number;
  }>;
}>;

export type PortalVideoRevisionWithdrawnEvent = PortalVideoRevisionEventBase & Readonly<{
  eventName: "video.revision.withdrawn";
  payload: Readonly<{
    operation: "withdraw";
    correctionReasonCode: StableId;
    sourceUpdatedAt: Rfc3339DateTime;
    payloadHash: Sha256Hex;
    invalidatesApprovedRevision?: number;
  }>;
}>;

export type PortalVideoRevisionEvent =
  | PortalVideoRevisionSubmittedEvent
  | PortalVideoRevisionWithdrawnEvent;

export type ScpAutomationReviewStatus =
  | "queued"
  | "in_review"
  | "approved"
  | "changes_requested"
  | "human_review_required"
  | "rejected";

export type ScpAutomationReviewCallbackEvent = Readonly<{
  schemaVersion: "scp.video-review-callback.v3";
  eventId: EventId;
  eventName: "video.review.status_observed";
  occurredAt: Rfc3339DateTime;
  source: "scp_automation";
  traceId: TraceId;
  revision: number;
  subject: VideoReviewSubject;
  payload: Readonly<{
    reviewId: StableId;
    status: ScpAutomationReviewStatus;
    policyVersion: StableId;
    reviewedAt: Rfc3339DateTime;
    publicReasonCode?: StableId;
  }>;
}>;

export type FluDownstreamProjectionCallbackEvent = Readonly<{
  schemaVersion: "scp.video-downstream-callback.v3";
  eventId: EventId;
  eventName: "video.downstream.status_observed";
  occurredAt: Rfc3339DateTime;
  source: "flu";
  traceId: TraceId;
  revision: number;
  subject: VideoReviewSubject;
  payload: Readonly<{
    projectionId: StableId;
    status: "eligible";
    policyVersion: StableId;
    projectedAt: Rfc3339DateTime;
    trackingEligible: true;
    settlementEligible: true;
  }>;
}>;

export type ScpAutomationReceipt = Readonly<{
  schemaVersion: "scp.video-submission-review.receipt.v1";
  receiver: "scp_automation";
  status: "received";
  eventId: EventId;
  videoSubmissionId: StableId;
  videoRevision: number;
  contentFingerprint: Sha256Hex;
  receivedAt: Rfc3339DateTime;
}>;

export type VideoSubmissionReviewV3WireEvent =
  | PortalVideoRevisionEvent
  | ScpAutomationReviewCallbackEvent
  | FluDownstreamProjectionCallbackEvent;
