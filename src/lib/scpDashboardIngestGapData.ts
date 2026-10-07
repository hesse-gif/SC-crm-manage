// Flu/Task-37 — listScpApprovedWithoutIngest 콜러블(functions/scpDashboardIngestGapCallables.ts)의
// 타입 계약. 승인됐지만 Flu ingest(대시보드 스냅샷) 성공 이력이 없는 계정 + 마지막 시도 결과.

export const INGEST_GAP_REASON_CODES = [
  "identity_not_provisioned",
  "command_rejected",
  "delivery_retry_exhausted",
  "ingest_never_attempted",
] as const;
export type IngestGapReasonCode = (typeof INGEST_GAP_REASON_CODES)[number];

export type ScpApprovedWithoutIngestLastAttempt = {
  outcome: "accepted" | "duplicate" | "rejected" | "exhausted";
  atIso: string;
  httpStatus: number;
  code: string;
  requestId: string;
} | null;

export type ScpApprovedWithoutIngestRow = {
  applicationId: string;
  fluCreatorId: string;
  portalCreatorId: string | null;
  creatorDisplayName: string | null;
  creatorHandle: string | null;
  approvedAtIso: string | null;
  bindingActive: boolean;
  reasonCode: IngestGapReasonCode;
  suspectedSheetSyncGap: boolean;
  lastAttempt: ScpApprovedWithoutIngestLastAttempt;
};

export type ScpApprovedWithoutIngestEnvelope = {
  rows: ScpApprovedWithoutIngestRow[];
  scanned: number;
  truncated: boolean;
  countsByReason: Record<IngestGapReasonCode, number>;
  generatedAtIso: string;
};
