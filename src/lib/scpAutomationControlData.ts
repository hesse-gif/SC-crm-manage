// SCP automation real-operations read model — typed client contract for the
// getScpAutomationControl read callable (functions/scpAutomationControl.ts).
// Reads go through the Functions callable (SEC-P0-004: no client Firestore direct read).
//
// The UI treats every field except `present` as optional because the server aggregation can return
// bounded/partial data. Missing values render as unavailable/provenance-needed states instead of
// fabricated zeroes or frozen mockup copy. The legacy card/pipeline arrays remain supported as a
// compatibility escape hatch for v0.5.40-era snapshots while the real read model is canonical.
export type ScpControlTone = "green" | "blue" | "amber" | "red" | "purple";

export interface ScpAutomationReadModelSource {
  schemaVersion?: string | null;
  generatedAt?: string | null;
  dataAsOf?: string | null;
  sourceWatermark?: string | null;
  completeness?: "complete" | "partial" | "stale" | "blocked" | "unknown" | null;
  provenance?: string[];
}

export interface ScpControlCard {
  key?: string;
  label?: string;
  tone?: ScpControlTone;
  statusLabel?: string;
  value?: number | null;
  sub?: string;
}
export interface ScpControlPipelineStep {
  step?: string;
  desc?: string;
  tone?: ScpControlTone;
  count?: number | null;
}
export interface ScpControlWorker {
  key?: string;
  ok?: boolean | null;
  status?: string;
}
export interface ScpControlFailure {
  code?: string;
  count?: string | number | null;
  tone?: ScpControlTone;
  action?: string;
  hint?: string;
}
export interface ScpControlChip {
  tone?: ScpControlTone;
  label?: string;
}
export interface ScpControlHumanReview {
  total?: number | null;
  chips?: ScpControlChip[];
  note?: string;
  cta?: string;
}

export interface ScpControlTrendSample {
  timestamp: string;
  views: string;
  dailyDeltaViews: string;
}

export interface ScpControlPilotRow {
  id: string;
  review: {
    statePath: string;
    videoSubmissionId: string;
    state: string;
    revision: number;
    isCurrentRevision: boolean;
    contentFingerprint: string;
    policyVersion: string;
    policyConfigHash: string;
    decisionRef: string;
    reviewedAt: string;
    reasonCode: string | null;
    currentRevisionEvidence: "review_state_head";
  };
  application: {
    applicationId: string;
    sourcePath: string;
    status: string;
    submittedAtIso: string;
    managementPath: string;
    classification: string;
  };
  program: { programId: string; sourcePath: string; title: string; status: string };
  campaign: { campaignId: string; sourcePath: string; title: string; status: string };
  creator: { fluCreatorId: string; sourcePath: string; displayName: string; handle: string };
  profile: { profileId: string; sourcePath: string; currentState: string; activeServing: boolean };
  country: { sourcePath: string; declared: string; verified: string; effective: string; state: string };
  video: {
    sourcePath: string;
    exists: boolean;
    youtubeVideoId: string;
    url: string;
    title: string;
    publishedAt: string;
    reportRowPath: string;
    reportRowExists: boolean;
    reportEligible: boolean;
    trackingState: string;
    settlementState: string;
  };
  trend: {
    sourcePath: string;
    exists: boolean;
    watermarkIso: string;
    totalViews: string;
    pointCount: number;
    points: ScpControlTrendSample[];
  };
  provenance: {
    applicationExists: boolean;
    managementExists: boolean;
    programExists: boolean;
    campaignExists: boolean;
    creatorExists: boolean;
    profileExists: boolean;
    countryEvidenceExists: boolean;
    videoExists: boolean;
    trendExists: boolean;
    fullyAttributed: boolean;
    attributionGapReasons: string[];
  };
}

export interface ScpControlTrendPoint {
  rowId: string;
  youtubeVideoId: string;
  sourcePath: string;
  watermarkIso: string;
  totalViews: string;
  pointCount: number;
  points: ScpControlTrendSample[];
  exists: boolean;
}

export interface ScpControlRealReadModel {
  version: string;
  generatedAtIso: string;
  sourceWatermarkIso: string | null;
  bounded: {
    requestedLimit: number;
    effectiveLimit: number;
    maxLimit: number;
    queryCount: number;
    documentReadUpperBound: number;
    sourceReads: Record<string, number>;
    indexBackedQueries: string[];
  };
  aggregates: {
    totalRows: number;
    queued: number;
    inReview: number;
    humanReviewRequired: number;
    changesRequested: number;
    approvedCurrent: number;
    rejected: number;
    reportEligible: number;
    trackingEligible: number;
    settlementEligible: number;
    partnerActivationReady: number;
    fullyAttributed: number;
    missingAuthority: number;
  };
  rows: ScpControlPilotRow[];
  operationalReadiness: {
    exact168hOperational: false;
    sourcePath: string;
    blockerCode: string;
    checkedAtIso: string;
  };
  /** 보낼 때가 됐는데 워커가 한 번도 집지 않은 메일 큐 행. 0이면 lanes 가 비어 있다. */
  mailQueue?: {
    checkedAtIso: string;
    lanes: ScpMailQueueLaneStall[];
    totalStalled: number;
    totalAwaitingPortalMaterial: number;
    unavailableLaneCount: number;
    /** W127 [적대 리뷰 N3]: 게이트는 행 히스토그램이 아니라 설정 상태다 — 사유 카운트가 유일한
     *  운반자면 잔여 0(전 행에 행 사유가 붙은 경우)에서 통째로 사라진다. */
    uidGuideRolloutGate?: "open" | "closed" | "unknown";
    queryCount: number;
    documentReadUpperBound: number;
  };
}

export interface ScpMailQueueLaneStall {
  lane: string;
  label: string;
  collection: string;
  stalled: number;
  /** W127 종결(`closedReason`)된 채 큐에 되살아난 행. 대기가 아니므로 stalled 와 별도 축이다. */
  closedWithoutSend?: number;
  /** W127 그 종결 행들이 언제부터 큐에 있었는가(건수만으로는 적체를 못 가른다). */
  oldestClosedSinceIso?: string | null;
  /** W127 위 시계가 서버 임계를 넘었다. 임계 정책은 read model 소유다. */
  closedWithoutSendStale?: boolean;
  /** W127 이 레인은 totalStalled 합계에서 빠진다(발송 레인이 아닌 원장). */
  excludedFromTotals?: boolean;
  awaitingPortalMaterial: number;
  /** W4 비PII skip 사유 코드별 현재 대기 건수. */
  skipReasonCounts?: Record<string, number>;
  oldestWaitingSinceIso: string | null;
  /** 대기 후보가 조회 상한을 넘겼다 — 표시된 수는 하한이다. */
  truncated: boolean;
  /** 이 레인을 읽지 못했다. 0건과 같지 않다. */
  unavailable: boolean;
}

export interface ScpAutomationControlSnapshot {
  present: boolean;
  source?: ScpAutomationReadModelSource;
  badge?: string;
  subtitle?: string;
  cards?: ScpControlCard[];
  pipeline?: ScpControlPipelineStep[];
  workers?: ScpControlWorker[];
  failures?: ScpControlFailure[];
  humanReview?: ScpControlHumanReview;
  footerNote?: string;
  updatedAt?: string | null;
  readModel?: ScpControlRealReadModel;
  realRows?: ScpControlPilotRow[];
  trends?: ScpControlTrendPoint[];
  fullyAttributedPilot?: ScpControlPilotRow | null;
  demoSeed?: false;
  creatorId?: string;
  programId?: string;
  campaignId?: string;
  countryCode?: string;
  youtubeVideoId?: string;
}
export interface ScpAutomationControlEnvelope {
  ok: boolean;
  snapshot: ScpAutomationControlSnapshot;
}
