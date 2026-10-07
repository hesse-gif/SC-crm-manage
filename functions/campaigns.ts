// Flu Cloud Functions — 외부망/모델 호출·DB 쓰기의 단일 경유점.
// Spark 모드에서는 외부 egress 없이 callable-style mock만 반환한다.
// Blaze 전환 후 이 파일의 handler body를 Firebase onCall wrapper와 Gateway/Admin SDK 구현으로 교체한다.

import { readSettings } from "./settings";
import { adminDb } from "./firebaseAdmin";
import type { Settings } from "./_settings-mock";
import { createHash } from "node:crypto";
import { FieldPath, FieldValue, type DocumentData, type Query } from "firebase-admin/firestore";
import { expireAt180DaysFromIso } from "./firestoreTtl";
import { resolveMailProfile, type MailProfileResolution } from "./mailProfiles";
import {
  campaignArbiterConfigHash,
  resolveCampaignArbiterConfig,
} from "./campaignArbiter";
import {
  confirmedProgramIdentitySet,
  resolveCanonicalProgramId,
  SCP_CANONICAL_PROGRAM_ID,
} from "./programCanonical";
import {
  readConfirmedProgramAliasRegistryState,
  readConfirmedProgramAliasRegistryStateInTransaction,
} from "./programAliasRegistry";
import {
  buildProgramScopedCandidateParticipationWrites,
  campaignCandidateLinkId as scopedCampaignCandidateLinkId,
  globalCandidateIdentityData,
} from "./candidateScope";
import { assertMutationOwner, mutationOwnerUids, type MutationAuthorizationActor } from "./mutationAuthorization";
import {
  accountOwnershipStampForOwnedRecordAsync,
  assertAccountOwnershipForRecordAsync,
  assertWritableAccountOwnershipScope,
  resolveAccountOwnershipScopeForRequest,
} from "./accountOwnership";
import {
  activeCommunityPublicationGeneration,
  COMMUNITY_PUBLICATION_CONTRACT_VERSION,
  communityPublicationPointerId,
} from "./read";
import {
  resolveCampaignOperationalState,
  CAMPAIGN_CANCELLED_OPERATIONAL_STATE,
} from "./campaignControlCore";
import { normalizeIsoAlpha2Country } from "./youtubeCreatorCountries";

export { buildProgramScopedCandidateParticipationWrites } from "./candidateScope";

type Role = "super_admin" | "admin" | "manager" | "viewer" | "guest";

type CallableRequest = {
  auth?: { uid?: string; token?: { role?: Role; team?: string; email?: string; name?: string } };
  data?: unknown;
  rawRequest?: { ip?: string };
};

type BehaviorLog = {
  userId: string;
  role: Role;
  team: string;
  gameId: string;
  action: string;
  time: string;
  IP: string;
  result: "cache_hit" | "mock_success" | "success" | "blocked" | "invalid";
  cost: number;
};

type CostLog = {
  provider: "mock" | "none";
  model: "spark-offline" | "deterministic-arbiter";
  cacheChecked: true;
  cacheHit: boolean;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  costRef: string;
};

type CampaignStage = "candidate_search" | "outreach" | "negotiation" | "contract";
type Priority = "긴급" | "높음" | "보통";

type CampaignEngineMeta = {
  cache: { checked: true; hit: boolean; key: string; ttlSeconds: number };
  costLog: CostLog;
  behaviorLog: BehaviorLog;
};

type OrchestrateCampaignResponse = CampaignEngineMeta & {
  campaignRef: string;
  targetN: number;
  workflow: Array<{ stage: CampaignStage; status: "queued" | "running" | "complete"; count: number; ref: string }>;
  autonomyControls: Record<string, unknown>;
  deliverability: Record<string, unknown>;
  crmHygiene: Record<string, unknown>;
  nextStage: CampaignStage;
  sparkMock: true;
};

type SyncCampaignFunnelResponse = CampaignEngineMeta & {
  campaignRef: string;
  funnelRef: string;
  funnel: {
    candidateSearch: number;
    sent: number;
    replied: number;
    negotiating: number;
    contracted: number;
    live: number;
    queued: number;
    sendRate: number;
    replyRate: number;
    negotiationRate: number;
    contractRate: number;
    applicationEvidence: CampaignApplicationEvidence;
    total: number;
    /**
     * T2-1: 이 pass 가 상한에 걸려 **임의 표본**으로 캡핑됐는지 — true 면 카운터는 근사치다.
     * 26-08-28 [리뷰 정정]: 종전 주석은 "최근 N건"이라 적었으나 사실이 아니다(아래 스캔부 주석 참조).
     */
    truncated: boolean;
    /** T0-2: 이 호출이 실제로 읽은 문서 수(outreach+conversations) — 호출부의 pass 읽기 예산 판정용. */
    scannedDocs: number;
  };
  sparkMock: true;
};

type CampaignFunnelSyncResult = Pick<SyncCampaignFunnelResponse, "campaignRef" | "funnelRef" | "funnel">;

type LearnCampaignPriorityResponse = CampaignEngineMeta & {
  campaignRef: string;
  feedbackRef: string;
  acceptedPriority: Priority;
  queuedFor: "campaign-priority-audit";
  autoAssignmentStatus: "operator_override_persisted";
  priorityVersion: number;
  resolvedConfigHash: string;
  sparkMock: false;
};

type CampaignData = {
  campaignId?: string;
  campaignRef?: string;
  gameId?: string;
  programId?: string;
  targetN?: number;
  priority?: Priority;
  reasonCode?: string;
  expectedVersion?: number;
  sourceRunId?: string;
  sourceRunRef?: string;
  candidates?: unknown;
  cursor?: string;
  pageSize?: number;
};

type CandidateLinkInput = {
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
};

type ImportedCandidateInput = {
  id: string;
  name: string;
  handle: string;
  platform: string;
  email?: string;
  followers?: number;
  region?: string;
  category?: string;
  sourceUrl?: string;
};

export type CampaignProgramOwnership = {
  campaignId: string;
  canonicalProgramId: string;
  valid: boolean;
  reason:
    | "valid"
    | "campaign_missing"
    | "campaign_id_mismatch"
    | "campaign_program_missing"
    | "campaign_program_mismatch"
    | "requested_program_mismatch";
};

export type CampaignCandidateOwnership = {
  valid: boolean;
  reason:
    | "valid"
    | CampaignProgramOwnership["reason"]
    | "candidate_program_mismatch"
    | "candidate_campaign_mismatch"
    | "candidate_identity_mismatch"
    | "campaign_candidate_ref_mismatch"
    | "source_run_missing"
    | "source_run_program_missing"
    | "source_run_program_mismatch"
    | "source_run_campaign_missing"
    | "source_run_campaign_mismatch"
    | "source_run_ref_mismatch"
    | "source_run_unpublished"
    | "source_run_candidate_missing"
    | "publication_pointer_inactive"
    | "publication_generation_mismatch"
    | "publication_candidate_ref_mismatch";
};

type AddCandidatesToCampaignResponse = {
  ok: true;
  campaignId: string;
  campaignRef: string;
  linkedCount: number;
  createdCount: number;
  existingCount: number;
  candidateCount: number;
  behaviorLog: BehaviorLog;
};

const writeRoles = new Set<Role>(["super_admin", "admin", "manager"]);
const readRoles = new Set<Role>(["super_admin", "admin", "manager", "viewer"]);
const cacheStore = new Map<string, unknown>();

function getAuthContext(request: CallableRequest) {
  const role = request.auth?.token?.role ?? "guest";
  return {
    userId: request.auth?.uid ?? "anonymous",
    role,
    team: request.auth?.token?.team ?? "unknown",
    ip: request.rawRequest?.ip ?? "0.0.0.0",
  };
}

function requireWriteRole(request: CallableRequest, action: string, gameId: string) {
  const context = getAuthContext(request);
  if (!request.auth?.uid || !writeRoles.has(context.role)) {
    const behaviorLog = createBehaviorLog(request, action, gameId, "blocked");
    throw Object.assign(new Error(!request.auth?.uid ? "unauthenticated" : "RBAC: super_admin/admin/manager role required"), { code: !request.auth?.uid ? "unauthenticated" : "permission-denied", errorCode: "require_write_role_unauthorized", behaviorLog });
  }
  return context;
}

function requireReadRole(request: CallableRequest, action: string, gameId: string) {
  const context = getAuthContext(request);
  if (!request.auth?.uid || !readRoles.has(context.role)) {
    const behaviorLog = createBehaviorLog(request, action, gameId, "blocked");
    throw Object.assign(new Error(!request.auth?.uid ? "unauthenticated" : "RBAC: signed-in read role required"), { code: !request.auth?.uid ? "unauthenticated" : "permission-denied", errorCode: "require_read_role_unauthorized", behaviorLog });
  }
  return context;
}

function readData(data: unknown): CampaignData {
  return data && typeof data === "object" ? (data as CampaignData) : {};
}

function safeId(value: unknown, fallback: string) {
  return typeof value === "string" && /^[a-zA-Z0-9/_-]{1,80}$/.test(value) ? value : fallback;
}

function safePositiveInt(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 50000 ? value : fallback;
}

const CAMPAIGN_CANDIDATE_PAGE_SIZE = 200;
const CAMPAIGN_CANDIDATE_CURSOR_VERSION = 1;

type CampaignCandidateCursor = {
  version: typeof CAMPAIGN_CANDIDATE_CURSOR_VERSION;
  canonicalProgramId: string;
  campaignId: string;
  afterCandidateLinkId: string;
};

function safeCampaignCandidatePageSize(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, CAMPAIGN_CANDIDATE_PAGE_SIZE)
    : CAMPAIGN_CANDIDATE_PAGE_SIZE;
}

export function encodeCampaignCandidateCursor(input: Omit<CampaignCandidateCursor, "version">): string {
  return Buffer.from(JSON.stringify({
    version: CAMPAIGN_CANDIDATE_CURSOR_VERSION,
    canonicalProgramId: input.canonicalProgramId,
    campaignId: input.campaignId,
    afterCandidateLinkId: input.afterCandidateLinkId,
  }), "utf8").toString("base64url");
}

export function decodeCampaignCandidateCursor(value: unknown): CampaignCandidateCursor | null {
  const encoded = stringOrEmpty(value);
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(encoded)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    const canonicalProgramId = stringOrEmpty(parsed.canonicalProgramId);
    const campaignId = stringOrEmpty(parsed.campaignId);
    const afterCandidateLinkId = stringOrEmpty(parsed.afterCandidateLinkId);
    if (
      parsed.version !== CAMPAIGN_CANDIDATE_CURSOR_VERSION
      || !canonicalProgramId
      || !campaignId
      || !/^[A-Za-z0-9_-]{1,180}$/.test(afterCandidateLinkId)
    ) return null;
    return {
      version: CAMPAIGN_CANDIDATE_CURSOR_VERSION,
      canonicalProgramId,
      campaignId,
      afterCandidateLinkId,
    };
  } catch {
    return null;
  }
}

function safePriority(value: unknown): Priority {
  return value === "긴급" || value === "높음" || value === "보통" ? value : "보통";
}

function createBehaviorLog(request: CallableRequest, action: string, gameId: string, result: BehaviorLog["result"], cost = 0): BehaviorLog {
  const context = getAuthContext(request);
  return {
    userId: context.userId,
    role: context.role,
    team: context.team,
    gameId,
    action,
    time: new Date().toISOString(),
    IP: context.ip,
    result,
    cost,
  };
}

function createMeta(request: CallableRequest, action: string, gameId: string, cacheKey: string, cacheHit: boolean): CampaignEngineMeta {
  const costLog: CostLog = {
    provider: "mock",
    model: "spark-offline",
    cacheChecked: true,
    cacheHit,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    costRef: `cost-logs/${action}/${cacheKey}`,
  };

  return {
    cache: { checked: true, hit: cacheHit, key: cacheKey, ttlSeconds: 600 },
    costLog,
    behaviorLog: createBehaviorLog(request, action, gameId, cacheHit ? "cache_hit" : "mock_success", costLog.estimatedCostUsd),
  };
}

function withCache<T>(cacheKey: string, build: (cacheHit: boolean) => T): T {
  if (cacheStore.has(cacheKey)) {
    return build(true);
  }

  const response = build(false);
  cacheStore.set(cacheKey, response);
  return response;
}

function rate(numerator: number, denominator: number) {
  return denominator ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

async function countQuery(query: Query): Promise<number> {
  const snapshot = await query.count().get();
  return snapshot.data().count;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function canonicalProgramIds(aliasMap: Readonly<Record<string, string>>, ...values: unknown[]): string[] {
  return Array.from(new Set(values.map((value) => resolveCanonicalProgramId(value, aliasMap)).filter(Boolean)));
}

export function resolveCampaignProgramOwnership(
  campaignIdValue: unknown,
  campaignValue: unknown,
  requestedProgramIdValue: unknown = "",
  aliasMap: Readonly<Record<string, string>> = {},
): CampaignProgramOwnership {
  const campaignId = stringOrEmpty(campaignIdValue);
  const campaign = asRecord(campaignValue);
  if (!campaignId || Object.keys(campaign).length === 0) {
    return { campaignId, canonicalProgramId: "", valid: false, reason: "campaign_missing" };
  }
  const storedCampaignId = stringOrEmpty(campaign.id);
  if (storedCampaignId && storedCampaignId !== campaignId) {
    return { campaignId, canonicalProgramId: "", valid: false, reason: "campaign_id_mismatch" };
  }
  const programIds = canonicalProgramIds(aliasMap, campaign.canonicalProgramId, campaign.programId);
  if (programIds.length === 0) {
    return { campaignId, canonicalProgramId: "", valid: false, reason: "campaign_program_missing" };
  }
  const canonicalProgramId = programIds[0];
  if (programIds.length !== 1) {
    return { campaignId, canonicalProgramId, valid: false, reason: "campaign_program_mismatch" };
  }
  const requestedProgramId = resolveCanonicalProgramId(requestedProgramIdValue, aliasMap);
  if (requestedProgramId && requestedProgramId !== canonicalProgramId) {
    return { campaignId, canonicalProgramId, valid: false, reason: "requested_program_mismatch" };
  }
  return { campaignId, canonicalProgramId, valid: true, reason: "valid" };
}

export function validateCampaignCandidateOwnership(
  scope: CampaignProgramOwnership,
  input: {
    candidate?: unknown;
    sourceRecord?: unknown;
    sourceRun?: unknown;
  },
  aliasMap: Readonly<Record<string, string>> = {},
): CampaignCandidateOwnership {
  if (!scope.valid) return { valid: false, reason: scope.reason };
  const candidate = asRecord(input.candidate);
  const sourceRecord = asRecord(input.sourceRecord);
  for (const record of [candidate, sourceRecord]) {
    const programIds = canonicalProgramIds(aliasMap, record.canonicalProgramId, record.programId);
    if (programIds.some((programId) => programId !== scope.canonicalProgramId)) {
      return { valid: false, reason: "candidate_program_mismatch" };
    }
    const claimedCampaignId = stringOrEmpty(record.campaignId);
    if (claimedCampaignId && claimedCampaignId !== scope.campaignId) {
      return { valid: false, reason: "candidate_campaign_mismatch" };
    }
  }

  const sourceRun = asRecord(input.sourceRun);
  const claimedRunRefs = [
    candidate.sourceRunId,
    candidate.sourceRunRef,
    candidate.runRef,
    sourceRecord.sourceRunId,
    sourceRecord.sourceRunRef,
    sourceRecord.runRef,
  ]
    .map(discoveryRunId)
    .filter(Boolean);
  if (Object.keys(sourceRecord).length === 0 || claimedRunRefs.length === 0) {
    return { valid: false, reason: "source_run_missing" };
  }
  if (new Set(claimedRunRefs).size > 1) {
    return { valid: false, reason: "source_run_ref_mismatch" };
  }
  const sourceRunId = discoveryRunId(sourceRun.id) || discoveryRunId(sourceRun.sourceRunId) || discoveryRunId(sourceRun.runRef);
  if (claimedRunRefs.length > 0 && Object.keys(sourceRun).length === 0) {
    return { valid: false, reason: "source_run_missing" };
  }
  if (sourceRunId && claimedRunRefs.some((runId) => runId !== sourceRunId)) {
    return { valid: false, reason: "source_run_ref_mismatch" };
  }
  if (Object.keys(sourceRun).length > 0) {
    const runProgramIds = canonicalProgramIds(aliasMap, sourceRun.canonicalProgramId, sourceRun.programId);
    if (runProgramIds.length === 0) {
      return { valid: false, reason: "source_run_program_missing" };
    }
    if (runProgramIds.length !== 1 || runProgramIds[0] !== scope.canonicalProgramId) {
      return { valid: false, reason: "source_run_program_mismatch" };
    }
    const runCampaignId = stringOrEmpty(sourceRun.campaignId);
    if (!runCampaignId) {
      return { valid: false, reason: "source_run_campaign_missing" };
    }
    if (runCampaignId !== scope.campaignId) {
      return { valid: false, reason: "source_run_campaign_mismatch" };
    }
    const runStatus = stringOrEmpty(sourceRun.status);
    if (runStatus !== "complete" && runStatus !== "partial") {
      return { valid: false, reason: "source_run_unpublished" };
    }
    const snapshot = Array.isArray(sourceRun.candidateSnapshot) ? sourceRun.candidateSnapshot : null;
    if (!snapshot || !sourceRunContainsCandidate(snapshot, candidate, sourceRecord)) {
      return { valid: false, reason: "source_run_candidate_missing" };
    }
  }
  return { valid: true, reason: "valid" };
}

export function campaignCandidateRunVisible(rowValue: unknown, activeGenerationId: string | null = null): boolean {
  const row = asRecord(rowValue);
  if (row.communityStableHead === true) return false;
  if (row.communityGenerationRow === true) {
    return Boolean(activeGenerationId)
      && stringOrEmpty(row.publicationGenerationId) === activeGenerationId
      && stringOrEmpty(row.publicationGenerationRef) === `community_publication_generations/${activeGenerationId}`
      && stringOrEmpty(row.publicationStatus) === "published"
      && (stringOrEmpty(row.sourceRunStatus) === "complete" || stringOrEmpty(row.sourceRunStatus) === "partial");
  }
  const sourceRunStatus = stringOrEmpty(row.sourceRunStatus);
  if (sourceRunStatus) return sourceRunStatus === "complete" || sourceRunStatus === "partial";
  // Legacy non-community links predate denormalized run publication status and
  // remain readable. Community links created by the queued engine must prove
  // publication; otherwise a processing/failed run could leak into the funnel.
  if (stringOrEmpty(row.source) === "community-discovery" && claimedSourceRunIds(row).length > 0) return false;
  return true;
}

export function resolveCampaignFunnelStage(input: {
  canonicalProgramId: unknown;
  globalCreatorStage?: unknown;
  scopedLinkStage?: unknown;
  applicationStage?: unknown;
  outreachStage?: unknown;
}): string {
  const canonicalProgramId = resolveCanonicalProgramId(input.canonicalProgramId);
  const candidates = [input.scopedLinkStage, input.applicationStage, input.outreachStage];
  if (canonicalProgramId === SCP_CANONICAL_PROGRAM_ID) candidates.push(input.globalCreatorStage);
  return candidates
    .map(normalizeFunnelStage)
    .filter(Boolean)
    .sort((left, right) => funnelStageRank(right) - funnelStageRank(left))[0] ?? "";
}

function discoveryRunId(value: unknown): string {
  const raw = stringOrEmpty(value);
  if (!raw) return "";
  const match = raw.match(/^(?:discovery_runs\/)?([a-zA-Z0-9_-]{1,180})$/);
  return match?.[1] ?? "";
}

function sourceRunContainsCandidate(
  snapshot: unknown[],
  candidate: Record<string, unknown>,
  sourceRecord: Record<string, unknown>,
): boolean {
  const expected = new Set([
    candidate.id,
    candidate.candidateId,
    candidate.candidateRef,
    sourceRecord.id,
    sourceRecord.candidateId,
    sourceRecord.candidateRef,
    sourceRecord.channelRef,
  ].flatMap(candidateIdentityVariants));
  if (expected.size === 0) return false;
  return snapshot.some((value) => {
    const row = asRecord(value);
    return [row.id, row.candidateId, row.candidateRef, row.channelRef, row.creatorId]
      .flatMap(candidateIdentityVariants)
      .some((identity) => expected.has(identity));
  });
}

function candidateIdentityVariants(value: unknown): string[] {
  const identity = stringOrEmpty(value);
  if (!identity) return [];
  const tail = identity.includes("/") ? identity.split("/").filter(Boolean).at(-1) ?? "" : "";
  return Array.from(new Set([identity, tail].filter(Boolean)));
}

function normalizeFunnelStage(value: unknown): string {
  const stage = stringOrEmpty(value).toLowerCase();
  if (["live", "operating", "운영중"].includes(stage)) return "live";
  if (["contract", "contracted", "review", "검수", "계약"].includes(stage)) return "contract";
  if (["negotiation", "negotiating", "협의"].includes(stage)) return "negotiation";
  if (["outreach", "contact", "sent", "replied", "approved", "컨택"].includes(stage)) return "outreach";
  return "";
}

function funnelStageRank(stage: string): number {
  return stage === "live" ? 4 : stage === "contract" ? 3 : stage === "negotiation" ? 2 : stage === "outreach" ? 1 : 0;
}

function normalizedEmail(value: unknown): string {
  const email = stringOrEmpty(value).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
}

function outreachEmail(row: Record<string, unknown>): string {
  return normalizedEmail(row.email)
    || normalizedEmail(row.targetEmail)
    || normalizedEmail(row.recipientEmail)
    || normalizedEmail(row.creatorEmail)
    || normalizedEmail(row.to);
}

async function readSheetLeadEmailsForOutreach(
  outreachRows: Record<string, unknown>[],
  scope: CampaignProgramOwnership,
  aliasMap: Readonly<Record<string, string>>,
): Promise<Set<string>> {
  const emails = Array.from(new Set(outreachRows.map(outreachEmail).filter(Boolean)));
  const matched = new Set<string>();
  const CHUNK_SIZE = 30;
  for (let start = 0; start < emails.length; start += CHUNK_SIZE) {
    const chunk = emails.slice(start, start + CHUNK_SIZE);
    const snapshots = await Promise.all([
      adminDb.collection("program_sheet_leads").where("email", "in", chunk).get(),
      adminDb.collection("program_sheet_leads").where("applicant.email", "in", chunk).get(),
    ]);
    for (const snapshot of snapshots) {
      for (const doc of snapshot.docs) {
        const data = doc.data();
        if (!recordMatchesCampaignScope(data, scope, true, aliasMap)) continue;
        const email = normalizedEmail(data.email) || normalizedEmail((data.applicant as Record<string, unknown> | undefined)?.email);
        if (email) matched.add(email);
      }
    }
  }
  return matched;
}

function recordMatchesCampaignScope(
  value: unknown,
  scope: CampaignProgramOwnership,
  allowLegacyScpUnscoped: boolean,
  aliasMap: Readonly<Record<string, string>> = {},
): boolean {
  if (!scope.valid) return false;
  const record = asRecord(value);
  const claimedCampaignId = stringOrEmpty(record.campaignId);
  if (claimedCampaignId && claimedCampaignId !== scope.campaignId) return false;
  const programIds = canonicalProgramIds(aliasMap, record.canonicalProgramId, record.programId);
  if (programIds.length === 0) {
    return allowLegacyScpUnscoped && scope.canonicalProgramId === SCP_CANONICAL_PROGRAM_ID;
  }
  return programIds.length === 1 && programIds[0] === scope.canonicalProgramId;
}

type ScopedCampaignFunnelEvidence = {
  linkStages: Map<string, string>;
  applicationStages: Map<string, string>;
  applicationEvidence: CampaignApplicationEvidence;
  /**
   * T3-1: 이 호출이 실제로 읽은 문서 수(count() 집계는 제외 — 그건 1,000 엔트리당 1 read 라 별개다).
   * 호출부(syncCampaignFunnelForCampaign)가 pass 읽기 회계 `funnel.scannedDocs` 에 합산한다.
   * 종전에는 이 함수의 읽기가 **회계에 전혀 안 잡혔다** — 상한도 없고 계측도 없는 조합이라
   * 새 1위가 돼도 관측 표면에 안 나타난다.
   */
  scannedDocs: number;
  /** T3-1: 링크 스캔이 상한에 걸려 표본이 됐는지(그 경우 아래 정확도 보정 경로가 돈다). */
  linkScanTruncated: boolean;
};

type CampaignApplicationEvidence = {
  policy: "exact_campaign_application_v1";
  acceptedCount: number;
  unattributedProgramApplicationCount: number;
  invalidTargetApplicationCount: number;
  humanMigrationRequired: boolean;
};

/**
 * T3-1 [읽기 비용 · 2026-09-05]: 링크 스캔 상한. 같은 파일 `FUNNEL_SYNC_ROW_SCAN_LIMIT` 과 같은 값·
 * 같은 규율(count() 로 규모를 먼저 재고, 넘을 때만 문서 ID 순으로 캡핑)이다.
 */
const FUNNEL_EVIDENCE_LINK_SCAN_LIMIT = 5_000;

/** `campaignCandidateRef` 가 이 컬렉션의 단일 문서 경로인지 — 아니면 `adminDb.doc()` 이 throw 한다. */
const CAMPAIGN_CANDIDATE_REF_PATTERN = /^campaign_candidates\/[^/]+$/;

/**
 * T3-1: 링크 스캔이 캡핑됐을 때, **신청서가 실제로 지목한 참여 문서만** 골라 확인한다.
 *
 * 왜 필요한가: `validCampaignCandidateRefs` 는 신청서의 `invalid` 판정 근거다. 스캔을 캡핑한 채로
 * 그 집합을 쓰면, 표본 밖에 있다는 이유만으로 멀쩡한 신청서가 invalid 로 뒤집히고
 * `humanMigrationRequired` 가 거짓 양성이 된다 — 상한을 걸면서 판정을 망가뜨리는 교환이다.
 * 지목된 ref 는 신청서 수만큼이라(캠페인 참여 문서 수와 무관) 읽기가 작다.
 */
async function resolveTruncatedCampaignCandidateRefs(
  refPaths: readonly string[],
  scope: CampaignProgramOwnership,
  aliasMap: Readonly<Record<string, string>>,
  linkStages: Map<string, string>,
  validCampaignCandidateRefs: Set<string>,
): Promise<number> {
  const targets = Array.from(new Set(refPaths.filter((path) => CAMPAIGN_CANDIDATE_REF_PATTERN.test(path))));
  const CHUNK_SIZE = 300;
  let reads = 0;
  for (let start = 0; start < targets.length; start += CHUNK_SIZE) {
    const chunk = targets.slice(start, start + CHUNK_SIZE);
    const snapshots = await adminDb.getAll(...chunk.map((path) => adminDb.doc(path)));
    reads += snapshots.length;
    for (const snapshot of snapshots) {
      if (!snapshot.exists) continue;
      // 판정은 위 전량 스캔 루프와 **한 글자도 다르면 안 된다** — 갈리면 캡핑 여부에 따라 같은
      // 문서가 다르게 분류된다.
      const row: Record<string, unknown> = { ...snapshot.data(), campaignCandidateRef: snapshot.ref.path };
      if (!recordMatchesCampaignScope(row, scope, false, aliasMap)
        || stringOrEmpty(row.campaignId) !== scope.campaignId
        || stringOrEmpty(row.campaignRef) !== `campaigns/${scope.campaignId}`
        || stringOrEmpty(snapshot.data()?.campaignCandidateRef) !== snapshot.ref.path) continue;
      validCampaignCandidateRefs.add(snapshot.ref.path);
      setScopedStage(linkStages, row, explicitFunnelStage(row));
    }
  }
  return reads;
}

async function readScopedCampaignFunnelEvidence(
  scope: CampaignProgramOwnership,
  aliasMap: Readonly<Record<string, string>>,
): Promise<ScopedCampaignFunnelEvidence> {
  const programAliases = confirmedProgramIdentitySet(scope.canonicalProgramId, aliasMap);
  // T3-1 [읽기 비용 · 2026-09-05]: 이 쿼리는 `limit` 이 없었다. 프로드 실측(26-08-28)
  //   `campaign_candidates` 26,331건이 사실상 한 캠페인 것이라 **퍼널 싱크 1회당 약 26,000 read** 다.
  //   T0-2 가 호출부의 시간 예산 의존을 없애 이 함수가 실제로 돌기 시작한 뒤로는 새 1위 후보였고,
  //   위 T2-1 이 outreach/conversations 에 건 상한과 달리 여기만 무제한으로 남아 있었다.
  //   같은 규율을 그대로 적용한다: count() 로 규모를 먼저 재고(집계는 문서 읽기가 아니다),
  //   상한 이하면 종전 전량 스캔을 **그대로** 유지해 정확도를 보존한다.
  const linkBase = adminDb.collection("campaign_candidates").where("campaignId", "==", scope.campaignId);
  const linkTotalCount = Math.max(0, (await linkBase.count().get()).data().count ?? 0);
  const linkScanTruncated = linkTotalCount > FUNNEL_EVIDENCE_LINK_SCAN_LIMIT;
  const linkQuery: Query = linkScanTruncated
    ? linkBase.orderBy(FieldPath.documentId()).limit(FUNNEL_EVIDENCE_LINK_SCAN_LIMIT)
    : linkBase;
  const [linkSnapshot, ...applicationSnapshots] = await Promise.all([
    linkQuery.get(),
    ...(["programId", "canonicalProgramId"] as const).flatMap((field) =>
      programAliases.map((programId) => adminDb.collection("program_applications").where(field, "==", programId).get())),
  ]);
  let scannedDocs = linkSnapshot.size
    + applicationSnapshots.reduce((sum, snapshot) => sum + snapshot.size, 0);
  const linkStages = new Map<string, string>();
  const applicationStages = new Map<string, string>();
  const validCampaignCandidateRefs = new Set<string>();
  for (const doc of linkSnapshot.docs) {
    const row: Record<string, unknown> = { ...doc.data(), campaignCandidateRef: doc.ref.path };
    if (!recordMatchesCampaignScope(row, scope, false, aliasMap)
      || stringOrEmpty(row.campaignId) !== scope.campaignId
      || stringOrEmpty(row.campaignRef) !== `campaigns/${scope.campaignId}`
      || stringOrEmpty(doc.data().campaignCandidateRef) !== doc.ref.path) continue;
    validCampaignCandidateRefs.add(doc.ref.path);
    setScopedStage(linkStages, row, explicitFunnelStage(row));
  }
  const applicationDocs = new Map(applicationSnapshots
    .flatMap((snapshot) => snapshot.docs)
    .map((doc) => [doc.id, doc]));
  if (linkScanTruncated) {
    // 표본 밖 ref 만 콕 집어 확인한다 — 캡핑이 판정을 바꾸지 않게 하는 보정이다.
    const unresolved = Array.from(applicationDocs.values())
      .filter((doc) => stringOrEmpty(doc.data().campaignId) === scope.campaignId)
      .map((doc) => stringOrEmpty(doc.data().campaignCandidateRef))
      .filter((path) => path && !validCampaignCandidateRefs.has(path));
    scannedDocs += await resolveTruncatedCampaignCandidateRefs(
      unresolved,
      scope,
      aliasMap,
      linkStages,
      validCampaignCandidateRefs,
    );
    console.warn("[campaign-funnel-sync] scoped evidence link scan capped at FUNNEL_EVIDENCE_LINK_SCAN_LIMIT", {
      campaignId: scope.campaignId,
      linkTotalCount,
      scanLimit: FUNNEL_EVIDENCE_LINK_SCAN_LIMIT,
      // 중복 포함 "표본 밖이라 확인이 필요했던 지목 수". 실제 읽기는 dedup 후라 이 값 이하다.
      unresolvedApplicationRefs: unresolved.length,
    });
  }
  let acceptedCount = 0;
  let unattributedProgramApplicationCount = 0;
  let invalidTargetApplicationCount = 0;
  for (const doc of applicationDocs.values()) {
    const row = doc.data();
    // Program applications are broader than campaigns. Never infer campaign
    // ownership from a shared email/creator identity: legacy unscoped rows stay in
    // the program funnel until an operator supplies the full scoped provenance.
    const applicationProgramIds = canonicalProgramIds(aliasMap, row.canonicalProgramId, row.programId);
    const exactProgram = applicationProgramIds.length === 1 && applicationProgramIds[0] === scope.canonicalProgramId;
    const claimedCampaignId = stringOrEmpty(row.campaignId);
    if (!claimedCampaignId) {
      if (exactProgram) unattributedProgramApplicationCount += 1;
      continue;
    }
    if (claimedCampaignId !== scope.campaignId) continue;
    const campaignCandidateRef = stringOrEmpty(row.campaignCandidateRef);
    if (!exactProgram
      || stringOrEmpty(row.campaignRef) !== `campaigns/${scope.campaignId}`
      || !validCampaignCandidateRefs.has(campaignCandidateRef)) {
      invalidTargetApplicationCount += 1;
      continue;
    }
    acceptedCount += 1;
    setExactCampaignApplicationStage(applicationStages, campaignCandidateRef, applicationFunnelStage(row));
  }
  const applicationEvidence: CampaignApplicationEvidence = {
    policy: "exact_campaign_application_v1",
    acceptedCount,
    unattributedProgramApplicationCount,
    invalidTargetApplicationCount,
    humanMigrationRequired: unattributedProgramApplicationCount > 0 || invalidTargetApplicationCount > 0,
  };
  return { linkStages, applicationStages, applicationEvidence, scannedDocs, linkScanTruncated };
}

function setExactCampaignApplicationStage(target: Map<string, string>, campaignCandidateRef: string, stageValue: unknown): void {
  const stage = normalizeFunnelStage(stageValue);
  if (!campaignCandidateRef || !stage) return;
  const current = target.get(campaignCandidateRef) ?? "";
  if (funnelStageRank(stage) > funnelStageRank(current)) target.set(campaignCandidateRef, stage);
}

function exactCampaignApplicationStageForRow(stages: Map<string, string>, row: Record<string, unknown>): string {
  const campaignCandidateRef = stringOrEmpty(row.campaignCandidateRef);
  return campaignCandidateRef ? stages.get(campaignCandidateRef) ?? "" : "";
}

function setScopedStage(target: Map<string, string>, row: Record<string, unknown>, stageValue: unknown): void {
  const stage = normalizeFunnelStage(stageValue);
  if (!stage) return;
  for (const key of campaignIdentityKeys(row)) {
    const current = target.get(key) ?? "";
    if (funnelStageRank(stage) > funnelStageRank(current)) target.set(key, stage);
  }
}

function scopedStageForRow(stages: Map<string, string>, row: Record<string, unknown>): string {
  return campaignIdentityKeys(row)
    .map((key) => stages.get(key) ?? "")
    .sort((left, right) => funnelStageRank(right) - funnelStageRank(left))[0] ?? "";
}

function campaignIdentityKeys(row: Record<string, unknown>): string[] {
  const keys = [
    ["creator", stringOrEmpty(row.creatorId)],
    ["candidate", stringOrEmpty(row.candidateId)],
    ["candidate", stringOrEmpty(row.targetId)],
    ["candidate", stringOrEmpty(row.id)],
    ["email", outreachEmail(row)],
    ["email", normalizedEmail(row.email)],
  ].filter((entry) => entry[1]).map(([kind, value]) => `${kind}:${value}`);
  return Array.from(new Set(keys));
}

function explicitFunnelStage(row: Record<string, unknown>): string {
  return resolveCampaignFunnelStage({
    canonicalProgramId: row.canonicalProgramId ?? row.programId,
    scopedLinkStage: row.campaignStage ?? row.programStage ?? row.workflowStage ?? row.stage,
  });
}

function applicationFunnelStage(row: Record<string, unknown>): string {
  const explicit = normalizeFunnelStage(row.campaignStage ?? row.programStage ?? row.workflowStage ?? row.stage);
  if (explicit) return explicit;
  if (row.liveAtIso || row.paidAtIso || stringOrEmpty(row.paymentStatus) === "paid") return "live";
  if (row.contractId || row.contractRef || row.reviewId || row.reviewRef || row.submissionTaskId) return "contract";
  if (row.negotiationId || row.negotiationRef || row.offerId) return "negotiation";
  return "";
}

async function readCreatorStages(creatorIds: string[]): Promise<Map<string, string>> {
  const stages = new Map<string, string>();
  const uniqueIds = Array.from(new Set(creatorIds.filter((id) => id && !id.startsWith("candidate:"))));
  const CHUNK_SIZE = 300;
  for (let start = 0; start < uniqueIds.length; start += CHUNK_SIZE) {
    const refs = uniqueIds.slice(start, start + CHUNK_SIZE).map((id) => adminDb.collection("creators").doc(id));
    const snapshots = await adminDb.getAll(...refs);
    for (const snapshot of snapshots) {
      const stage = stringOrEmpty(snapshot.data()?.stage);
      if (stage) stages.set(snapshot.id, stage);
    }
  }
  return stages;
}

function automationEnabled(settings: Settings) {
  return settings.automation.aiAutomationEnabled && settings.automation.outboundCampaignAutomation;
}

function campaignAutonomyControls(settings: Settings, campaignRef: string, targetN: number, profile: MailProfileResolution) {
  const enabled = automationEnabled(settings) && profile.resolvedProfileSnapshot.enabled;
  const sendCapDaily = Math.max(0, Math.min(profile.resolvedProfileSnapshot.maxDailySends, targetN));
  return {
    killSwitch: enabled ? "available" : "paused_by_settings",
    spendCapKRW: 5000000,
    sendCapDaily,
    liveSendEnabled: profile.liveSend,
    dryRun: profile.dryRun,
    actualSendPolicy: profile.liveSend ? "enabled_after_approval" : "queued_draft_only",
    requiresHumanApproval: settings.automation.humanApprovalRequired || targetN > sendCapDaily,
    minReplyDelayMinutes: profile.resolvedProfileSnapshot.minReplyDelayMinutes,
    profileScope: profile.resolvedProfileSnapshot.scope,
    profilePolicyVersion: profile.policyVersion,
    templateRef: profile.templateSnapshot.ref,
    templateVersion: profile.templateSnapshot.version,
    promptInjectionDefense: "reply_body_isolated_structured_parse",
    negotiationClamp: "settings.negotiationCriteria",
    negotiationFilters: {
      followers: [settings.negotiationCriteria.minFollowers, settings.negotiationCriteria.maxFollowers],
      recentViews: [settings.negotiationCriteria.minRecentViews, settings.negotiationCriteria.maxRecentViews],
      recentViewsDays: settings.negotiationCriteria.recentViewsDays,
      engagementPct: [settings.negotiationCriteria.minEngagementPct, settings.negotiationCriteria.maxEngagementPct],
    },
    auditLog: `${campaignRef}/audit/ai-decisions`,
  };
}

export async function orchestrateCampaign(request: CallableRequest): Promise<OrchestrateCampaignResponse> {
  const data = readData(request.data);
  const campaignId = safeId(data.campaignId, "cp-mock");
  const campaignRef = safeId(data.campaignRef, `campaigns/${campaignId}`);
  const gameId = safeId(data.gameId, "game-mock");
  const programId = safeId(data.programId, "");
  const targetN = safePositiveInt(data.targetN, 100);
  requireWriteRole(request, "campaign.orchestrate", gameId);
  const settings = await readSettings();
  const mailProfile = await resolveMailProfile({ campaignId, programId, gameId, intent: "campaign_outreach" });
  const enabled = automationEnabled(settings) && mailProfile.resolvedProfileSnapshot.enabled;
  const sendCapDaily = Math.max(0, Math.min(mailProfile.resolvedProfileSnapshot.maxDailySends, targetN));

  const cacheKey = [
    "campaign-orchestration",
    campaignId,
    targetN,
    enabled,
    sendCapDaily,
    mailProfile.policyVersion,
    mailProfile.templateSnapshot.ref,
    mailProfile.templateSnapshot.version,
    mailProfile.dryRun ? "dry-run" : "live-send",
  ].join(":");
  return withCache(cacheKey, (cacheHit) => ({
    ...createMeta(request, "campaign.orchestrate", gameId, cacheKey, cacheHit),
    campaignRef,
    targetN,
    workflow: [
      { stage: "candidate_search", status: enabled ? "complete" : "queued", count: Math.ceil(targetN * 6), ref: `${campaignRef}/candidateBatches/mock` },
      { stage: "outreach", status: enabled ? "running" : "queued", count: Math.ceil(targetN * 4), ref: `${campaignRef}/outreachBatches/mock` },
      { stage: "negotiation", status: "queued", count: Math.ceil(targetN * 0.8), ref: `${campaignRef}/negotiations/mock` },
      { stage: "contract", status: "queued", count: targetN, ref: `${campaignRef}/contracts/mock` },
    ],
    autonomyControls: campaignAutonomyControls(settings, campaignRef, targetN, mailProfile),
    resolvedProfileSnapshot: mailProfile.resolvedProfileSnapshot,
    templateSnapshot: mailProfile.templateSnapshot,
    policyVersion: mailProfile.policyVersion,
    sourceRefs: mailProfile.sourceRefs,
    deliverability: {
      spf: "checklist_required",
      dkim: "checklist_required",
      dmarc: "checklist_required",
      warmupDailyLimit: sendCapDaily,
      bounceSuppressionRef: `${campaignRef}/suppression/bounces`,
    },
    crmHygiene: {
      suppressionRef: "suppression/global-do-not-contact",
      duplicatePolicy: "one_channel_touch_per_creator",
      frequencyCapDays: 30,
      existingRelationshipCheck: true,
    },
    nextStage: enabled ? "outreach" : "candidate_search",
    sparkMock: true,
  }));
}

export async function syncCampaignFunnelForCampaign(
  campaignId: string,
  campaignRef = `campaigns/${campaignId}`,
  actor: MutationAuthorizationActor = {
    uid: "system:campaign-funnel-sync",
    role: "super_admin",
    trustedService: true,
  },
): Promise<CampaignFunnelSyncResult> {
  const canonicalCampaignRef = `campaigns/${campaignId}`;
  if (campaignRef !== canonicalCampaignRef) {
    throw Object.assign(new Error("failed-precondition: campaignRef does not match campaignId"), { code: "failed-precondition", errorCode: "sync_campaign_funnel_for_campaign_campaign_ref_match_campaign_id" });
  }
  const campaignDocRef = adminDb.doc(canonicalCampaignRef);
  const campaignSnapshot = await campaignDocRef.get();
  const campaign = campaignSnapshot.exists
    ? { id: campaignSnapshot.id, ...(campaignSnapshot.data() ?? {}) }
    : {};
  const aliasRegistry = await readConfirmedProgramAliasRegistryState({ bypassCache: true });
  const scope = resolveCampaignProgramOwnership(
    campaignId,
    campaign,
    "",
    aliasRegistry.aliasMap,
  );
  if (!scope.valid) {
    throw Object.assign(new Error(`failed-precondition: invalid campaign ownership (${scope.reason})`), { code: "failed-precondition", errorCode: "sync_campaign_funnel_for_campaign_invalid_campaign_ownership" });
  }
  assertMutationOwner(
    actor,
    mutationOwnerUids(campaign, { includeCreatedBy: true }),
    "campaign funnel sync",
  );
  // T2-1 [T0-2 와 반드시 같이 배포 · 8/6 회귀 페어]: 이 함수는 campaign_outreach·conversations 를
  // **둘 다 limit 없이** 스캔했다(캠페인당 약 23,000 읽기). 지금까지 비용이 0으로 보인 이유는
  // 호출부(chat-ai.ts 워커 꼬리 루프)의 시간 예산이 항상 먼저 터져 이 함수가 거의 실행되지 못했기
  // 때문이다(24h 57회 전부 {deferred:1, synced:0}) — T0-2 가 그 시간 예산 의존을 없애는 순간 이
  // 함수가 새 비용 1위가 된다.
  //
  // count() 집계 전환 vs 증분 카운터: 순수 count() 로는 못 바꾼다 — 아래 스테이지 분류
  // (live/contract/negotiation/replied)가 conversations·creators.stage·campaign_candidates·
  // program_sheet_leads 를 **행 단위로 조인**해야 나오므로 Firestore 는 그런 그룹핑 집계를
  // 지원하지 않는다. 증분 카운터도 검토했으나 이 분류에 관여하는 쓰기 지점이 발송 워커·반송 처리·
  // 협상/계약 갱신 등 여러 파일에 흩어져 있어, 전부 놓치지 않고 증분시키는 건 이번 2건 수리의
  // 범위를 크게 벗어난다(누락되면 카운터가 조용히 틀어지는 쪽이 지금의 "안 돈다"보다 나쁘다).
  //
  // 그래서 이 레포의 지배적 관례(admin.ts 전역의 scanLimit·rowLimit 류 — bounded scan)를 따른다:
  // count() 로 규모를 먼저 재고(문서 읽기가 아니라 집계라 비용이 무시할 수준), 상한 이하면 기존
  // 전량 스캔을 **그대로** 유지해 정확도를 보존하고, 상한을 넘는 드문 대형 캠페인만 문서ID 순
  // 상한을 넘으면 캡핑한다. 캡핑된 pass 는 truncated:true 로 명시한다 — 근사치를 정확치로 속이지
  // 않는다(그래도 하루 종일 0으로 얼어붙던 것보다는 낫다 — 부수 효과로 그 정합성 결함도 풀린다).
  const FUNNEL_SYNC_ROW_SCAN_LIMIT = 5_000;
  const [outreachCountSnapshot, conversationsCountSnapshot] = await Promise.all([
    adminDb.collection("campaign_outreach").where("campaignId", "==", campaignId).count().get(),
    adminDb.collection("conversations").where("campaignId", "==", campaignId).count().get(),
  ]);
  const outreachTotalCount = Math.max(0, outreachCountSnapshot.data().count ?? 0);
  const conversationsTotalCount = Math.max(0, conversationsCountSnapshot.data().count ?? 0);
  const outreachTruncated = outreachTotalCount > FUNNEL_SYNC_ROW_SCAN_LIMIT;
  const conversationsTruncated = conversationsTotalCount > FUNNEL_SYNC_ROW_SCAN_LIMIT;
  const truncated = outreachTruncated || conversationsTruncated;
  let outreachQuery: Query = adminDb.collection("campaign_outreach")
    .where("campaignId", "==", campaignId)
    .select(
      "campaignId", "canonicalProgramId", "programId",
      "creatorId", "candidateId", "targetId", "id",
      "email", "targetEmail", "recipientEmail", "creatorEmail", "to",
      "conversationId", "campaignCandidateRef",
      "campaignStage", "programStage", "workflowStage", "stage",
      "deliveryState", "status",
    );
  // ⚠️ 26-08-28 [리뷰 정정 · spurdog-9d]: 이 절단은 **최근 N건이 아니라 임의 표본**이다.
  //   이 컬렉션 문서 ID 는 `<campaignId>_<YouTube 채널 ID>`(예: cp-bd7d1ea7aq4k_UC--7KZh8ytOh7ra3URRWlFw)
  //   라 시간과 무상관이고, documentId 정렬은 채널 ID 사전순일 뿐이다. 시간축 필드로 정렬하려면
  //   복합 색인이 필요해 이번 범위 밖으로 두고, **표본임을 이름과 로그에 명시**하는 쪽을 택한다.
  //   프로드 실측(26-08-28): 주력 캠페인 outreach 9,588 · conversations 9,651 로 **상시 캡핑**이라
  //   카운터는 실제의 약 52% 에 고정된다 — "안정적으로 틀린 수"라서 truncated 표시가 필수다.
  if (outreachTruncated) outreachQuery = outreachQuery.orderBy(FieldPath.documentId()).limit(FUNNEL_SYNC_ROW_SCAN_LIMIT);
  let conversationsQuery: Query = adminDb.collection("conversations").where("campaignId", "==", campaignId);
  if (conversationsTruncated) conversationsQuery = conversationsQuery.orderBy(FieldPath.documentId()).limit(FUNNEL_SYNC_ROW_SCAN_LIMIT);
  if (truncated) {
    console.warn("[campaign-funnel-sync] scan capped at maxDocumentReads — counters are an approximation for this pass", {
      campaignId,
      outreachTotalCount,
      conversationsTotalCount,
      scanLimit: FUNNEL_SYNC_ROW_SCAN_LIMIT,
    });
  }
  const [outreachSnapshot, conversationsSnapshot] = await Promise.all([
    outreachQuery.get(),
    conversationsQuery.get(),
  ]);
  const outreachDocs = outreachSnapshot.docs.filter((doc) => recordMatchesCampaignScope(doc.data(), scope, true, aliasRegistry.aliasMap));
  const conversationDocs = conversationsSnapshot.docs.filter((doc) => recordMatchesCampaignScope(doc.data(), scope, true, aliasRegistry.aliasMap));
  const candidateSearch = outreachDocs.length;

  const conversationsById = new Map<string, Record<string, unknown>>();
  const conversationsByCreatorId = new Map<string, Record<string, unknown>>();
  for (const doc of conversationDocs) {
    const row = doc.data();
    conversationsById.set(doc.id, row);
    const creatorId = stringOrEmpty(row.creatorId);
    if (creatorId) conversationsByCreatorId.set(creatorId, row);
  }
  const creatorIds = outreachDocs
    .map((doc) => stringOrEmpty(doc.data().creatorId))
    .filter(Boolean);
  const outreachRows = outreachDocs.map((doc) => doc.data());
  const [creatorStages, sheetLeadEmails, scopedEvidence] = await Promise.all([
    scope.canonicalProgramId === SCP_CANONICAL_PROGRAM_ID ? readCreatorStages(creatorIds) : Promise.resolve(new Map<string, string>()),
    readSheetLeadEmailsForOutreach(outreachRows, scope, aliasRegistry.aliasMap),
    readScopedCampaignFunnelEvidence(scope, aliasRegistry.aliasMap),
  ]);
  const stageEvidenceSource = scope.canonicalProgramId === SCP_CANONICAL_PROGRAM_ID
    ? "campaign_scoped_evidence+creators.stage_legacy_scp"
    : "campaign_scoped_evidence";

  let queued = 0;
  let sent = 0;
  let replied = 0;
  let negotiating = 0;
  let contracted = 0;
  let live = 0;
  let dropped = 0;
  let bounced = 0;
  let deferred = 0;
  let suppressed = 0;
  for (const doc of outreachDocs) {
    const row = doc.data();
    const deliveryState = stringOrEmpty(row.deliveryState || row.status);
    // drop 폴더: 발송 제외/억제/중복가드(suppressed_duplicate)/반송 — 스킵하지 않고 dropped로 집계.
    if (deliveryState === "blocked" || deliveryState === "failed" || deliveryState === "bounced" || deliveryState === "suppressed" || deliveryState === "suppressed_duplicate") {
      if (deliveryState === "bounced") bounced += 1;
      if (deliveryState === "suppressed" || deliveryState === "suppressed_duplicate" || deliveryState === "blocked") suppressed += 1;
      dropped += 1;
      continue;
    }
    if (deliveryState === "deferred") {
      deferred += 1;
      queued += 1;
      continue;
    }

    const creatorId = stringOrEmpty(row.creatorId);
    const conversationId = stringOrEmpty(row.conversationId);
    const conversation = conversationsById.get(conversationId)
      ?? conversationsByCreatorId.get(creatorId)
      ?? conversationsByCreatorId.get(`candidate:${stringOrEmpty(row.targetId)}`)
      ?? conversationsByCreatorId.get(`candidate:${stringOrEmpty(row.candidateId)}`);
    const stage = resolveCampaignFunnelStage({
      canonicalProgramId: scope.canonicalProgramId,
      globalCreatorStage: creatorId ? creatorStages.get(creatorId) : "",
      scopedLinkStage: scopedStageForRow(scopedEvidence.linkStages, row),
      applicationStage: exactCampaignApplicationStageForRow(scopedEvidence.applicationStages, row),
      outreachStage: row.campaignStage ?? row.programStage ?? row.workflowStage ?? row.stage,
    });
    const sheetSubmitted = sheetLeadEmails.has(outreachEmail(row));

    if (stage === "live") live += 1;
    else if (stage === "contract" || stage === "review") contracted += 1;
    else if (stage === "negotiation") negotiating += 1;
    else if (conversation?.lastMessageFrom === "creator" || sheetSubmitted) replied += 1;
    else if (deliveryState === "sent" || deliveryState === "mock_sent" || deliveryState === "delivered") sent += 1;
    else queued += 1;
  }
  const totalFunnel = queued + sent + replied + negotiating + contracted + live;
  const nowIso = new Date().toISOString();
  const funnel = {
    candidateSearch,
    queued,
    sent,
    replied,
    negotiating,
    contracted,
    live,
    dropped,
    bounced,
    deferred,
    suppressed,
    sendRate: rate(sent, candidateSearch),
    replyRate: rate(replied, sent),
    negotiationRate: rate(negotiating, replied),
    contractRate: rate(contracted, negotiating),
    applicationEvidence: scopedEvidence.applicationEvidence,
    // 폴더 뷰(관리/파트너/프로그램 노출): 발송완료/반응/무반응/제외.
    folders: {
      sent: sent + replied + negotiating + contracted + live, // 발송 받은 전체(대기·제외 제외)
      responded: replied + negotiating + contracted + live,    // 회신 이후 단계 전부
      noResponse: sent,                                         // 발송됐으나 무회신
      dropped,                                                  // 억제/차단/중복/반송
    },
    total: totalFunnel,
    // T2-1: 이 pass 가 상한(FUNNEL_SYNC_ROW_SCAN_LIMIT)에 걸려 임의 표본으로 캡핑됐는지. true 면
    // 위 카운터는 근사치다 — 조용히 부정확한 것보다 명시하는 쪽이 낫다.
    // T3-1: 스코프 증거 링크 스캔의 캡핑도 같은 플래그로 합류시킨다(둘 다 "표본"이라는 같은 뜻).
    truncated: truncated || scopedEvidence.linkScanTruncated,
    // T0-2: 이 호출이 실제로 읽은 문서 수(outreach+conversations, count() 집계는 제외) — 호출부
    // (chat-ai.ts 퍼널 재동기화 꼬리 루프)가 pass 당 읽기 예산을 누적 판정하는 데 쓴다.
    // T3-1: 스코프 증거 조회(campaign_candidates + program_applications)가 여기 **안 잡혀 있었다** —
    // 상한도 계측도 없는 조합이라 pass 비용이 예산에 안 보였다. 이제 합산한다.
    scannedDocs: outreachSnapshot.size + conversationsSnapshot.size + scopedEvidence.scannedDocs,
  };
  await adminDb.runTransaction(async (transaction) => {
    const [currentCampaignSnapshot, currentAliasRegistry] = await Promise.all([
      transaction.get(campaignDocRef),
      readConfirmedProgramAliasRegistryStateInTransaction(transaction),
    ]);
    const currentCampaign: Record<string, unknown> = currentCampaignSnapshot.exists
      ? { id: currentCampaignSnapshot.id, ...(currentCampaignSnapshot.data() ?? {}) }
      : {};
    const currentScope = resolveCampaignProgramOwnership(
      campaignId,
      currentCampaign,
      scope.canonicalProgramId,
      currentAliasRegistry.aliasMap,
    );
    if (
      currentAliasRegistry.revision !== aliasRegistry.revision
      || !currentScope.valid
      || currentScope.canonicalProgramId !== scope.canonicalProgramId
    ) {
      throw Object.assign(new Error(`failed-precondition: campaign ownership changed during funnel sync (${currentScope.reason})`), { code: "failed-precondition", errorCode: "sync_campaign_funnel_for_campaign_campaign_ownership_changed_during" });
    }
    assertMutationOwner(
      actor,
      mutationOwnerUids(currentCampaign, { includeCreatedBy: true }),
      "campaign funnel sync",
    );
    const previousSyncedAtIso = stringOrEmpty(currentCampaignSnapshot.data()?.funnelSyncedAtIso);
    const syncedAtIso = previousSyncedAtIso && previousSyncedAtIso > nowIso ? previousSyncedAtIso : nowIso;
    const sentOrResponded = sent + replied + negotiating + contracted + live;
    const operationalState = resolveCampaignOperationalState(currentCampaign);
    const targetMetric = stringOrEmpty(currentCampaign.targetMetric) || "partners";
    const storedTargetValue = typeof currentCampaign.targetValue === "number" && Number.isFinite(currentCampaign.targetValue)
      ? currentCampaign.targetValue
      : typeof currentCampaign.campaignQuota === "number" && Number.isFinite(currentCampaign.campaignQuota)
        ? currentCampaign.campaignQuota
        : 1;
    const targetValue = Math.max(1, Math.round(storedTargetValue));
    const metricProgress = targetMetric === "sent"
      ? sentOrResponded
      : targetMetric === "replied"
        ? replied + negotiating + contracted + live
        : targetMetric === "negotiating"
          ? negotiating + contracted + live
          : targetMetric === "contracted" || targetMetric === "partners"
            ? contracted + live
            : live;
    // 취소된 캠페인의 `status` 는 **보존한다.** 종전에는 취소가 operationalState=active 로 접혀
    //   `queued>0 && sent==0` 폴백에 걸려 `"대기"` 로 덮였다 — 취소 표식이 문서에서 영구히 지워졌고,
    //   화면은 그 웨이브를 "곧 발송될 캠페인"으로 그렸다(대기열 249명 포함).
    const status = operationalState === CAMPAIGN_CANCELLED_OPERATIONAL_STATE
      ? stringOrEmpty(currentCampaign.status) || CAMPAIGN_CANCELLED_OPERATIONAL_STATE
      : operationalState === "completed"
      ? "완료"
      : operationalState === "paused"
        ? "일시정지"
        : metricProgress >= targetValue
          ? "완료"
          : queued > 0
            ? (sentOrResponded > 0 ? "발송중" : "대기")
            : currentCampaign.autoRefillEnabled === true
              ? "탐색중"
              : dropped > 0
                ? "확인 필요"
                : "대기";
    const counterPatch = {
      status,
      total: totalFunnel,
      queued,
      sent,
      replied,
      negotiating,
      contracted,
      live,
      dropped,
      bounced,
      deferred,
      suppressed,
      counterSource: "syncCampaignFunnel",
      counterRevision: FieldValue.increment(1),
      creatorStageSource: stageEvidenceSource,
      applicationEvidence: scopedEvidence.applicationEvidence,
      funnelSyncedAtIso: syncedAtIso,
      updatedAtIso: syncedAtIso,
      // T2-1: 운영자·감시가 이 캠페인의 최신 카운터가 정확치인지 상한 캡핑 근사치인지 문서만 보고
      // 알 수 있어야 한다.
      funnelSyncTruncated: truncated,
    };
    transaction.set(campaignDocRef, counterPatch, { merge: true });
    transaction.set(campaignDocRef.collection("aggregates").doc("funnel"), {
      id: "funnel",
      ...counterPatch,
      candidateSearch,
      sendRate: funnel.sendRate,
      replyRate: funnel.replyRate,
      negotiationRate: funnel.negotiationRate,
      contractRate: funnel.contractRate,
    }, { merge: true });
  });

  return {
    campaignRef: canonicalCampaignRef,
    funnelRef: `${canonicalCampaignRef}/aggregates/funnel`,
    funnel,
  };
}

export async function syncCampaignFunnel(request: CallableRequest): Promise<SyncCampaignFunnelResponse> {
  const data = readData(request.data);
  const campaignId = safeId(data.campaignId, "cp-mock");
  const campaignRef = safeId(data.campaignRef, `campaigns/${campaignId}`);
  const gameId = safeId(data.gameId, "game-mock");
  const auth = requireWriteRole(request, "campaign.funnel.sync", gameId);

  const cacheKey = `campaign-funnel:${campaignId}`;
  const synced = await syncCampaignFunnelForCampaign(campaignId, campaignRef, {
    uid: auth.userId,
    role: auth.role,
  });

  return {
    ...createMeta(request, "campaign.funnel.sync", gameId, cacheKey, false),
    ...synced,
    sparkMock: true,
  };
}

export async function learnCampaignPriority(request: CallableRequest): Promise<LearnCampaignPriorityResponse> {
  const data = readData(request.data);
  const campaignId = safeId(data.campaignId, "cp-mock");
  const campaignRef = safeId(data.campaignRef, `campaigns/${campaignId}`);
  const gameId = safeId(data.gameId, "game-mock");
  const priority = safePriority(data.priority);
  const reasonCode = safeId(data.reasonCode, "manual_override");
  const auth = requireWriteRole(request, "campaign.priority.learn", gameId);
  const expectedVersion = typeof data.expectedVersion === "number" && Number.isInteger(data.expectedVersion)
    ? data.expectedVersion
    : null;
  const canonicalCampaignRef = `campaigns/${campaignId}`;
  if (campaignRef !== canonicalCampaignRef) {
    throw Object.assign(new Error("failed-precondition: campaignRef does not match campaignId"), { code: "failed-precondition", errorCode: "learn_campaign_priority_campaign_ref_match_campaign_id" });
  }
  const campaignDocRef = adminDb.doc(canonicalCampaignRef);
  const auditRef = adminDb.collection("campaign_priority_audit").doc();
  const nowIso = new Date().toISOString();
  const applied = await adminDb.runTransaction(async (transaction) => {
    const [campaignSnapshot, aliasRegistry] = await Promise.all([
      transaction.get(campaignDocRef),
      readConfirmedProgramAliasRegistryStateInTransaction(transaction),
    ]);
    const current: Record<string, unknown> = campaignSnapshot.exists
      ? { id: campaignSnapshot.id, ...(campaignSnapshot.data() ?? {}) }
      : {};
    const scope = resolveCampaignProgramOwnership(campaignId, current, "", aliasRegistry.aliasMap);
    if (!scope.valid) {
      throw Object.assign(new Error(`failed-precondition: invalid campaign ownership (${scope.reason})`), { code: "failed-precondition", errorCode: "learn_campaign_priority_invalid_campaign_ownership" });
    }
    assertMutationOwner(
      { uid: auth.userId, role: auth.role },
      mutationOwnerUids(current, { includeCreatedBy: true }),
      "campaign priority learning",
    );
    const programId = scope.canonicalProgramId;
    const programRef = adminDb.collection("programs").doc(programId || "missing");
    const [programSnapshot, settingsSnapshot] = await Promise.all([
      transaction.get(programRef),
      transaction.get(adminDb.doc("settings/default")),
    ]);
    const currentVersion = typeof current.priorityVersion === "number" && Number.isInteger(current.priorityVersion)
      ? current.priorityVersion
      : 0;
    if (expectedVersion !== null && expectedVersion !== currentVersion) {
      const error = new Error(`campaign priority version conflict: expected ${expectedVersion}, current ${currentVersion}`);
      Object.assign(error, { code: "aborted", errorCode: "learn_campaign_priority_campaign_priority_version_conflict_expected" });
      throw error;
    }
    const nextVersion = currentVersion + 1;
    const currentArbiter = current.campaignArbiter && typeof current.campaignArbiter === "object"
      ? current.campaignArbiter as Record<string, unknown>
      : {};
    const nextArbiter = {
      ...currentArbiter,
      priorityOverride: priority,
      overrideReasonCode: reasonCode,
      overrideVersion: nextVersion,
      updatedAtIso: nowIso,
      updatedBy: auth.userId,
    };
    const settings = settingsSnapshot.data() ?? {};
    const program = programSnapshot.data() ?? {};
    const resolvedConfig = resolveCampaignArbiterConfig(
      settings.campaignArbiter,
      program.campaignArbiter,
      nextArbiter,
    );
    const resolvedConfigHash = campaignArbiterConfigHash(resolvedConfig);
    transaction.set(campaignDocRef, {
      priority,
      operatorPriorityOverride: priority,
      priorityVersion: nextVersion,
      campaignArbiter: nextArbiter,
      resolvedArbiterConfigHash: resolvedConfigHash,
      priorityUpdatedAtIso: nowIso,
      priorityUpdatedBy: auth.userId,
      updatedAtIso: nowIso,
    }, { merge: true });
    transaction.set(auditRef, {
      id: auditRef.id,
      campaignId,
      campaignRef,
      programId,
      beforePriority: safePriority(current.operatorPriorityOverride ?? current.priority),
      afterPriority: priority,
      reasonCode,
      beforeVersion: currentVersion,
      afterVersion: nextVersion,
      resolvedConfigHash,
      userId: auth.userId,
      role: auth.role,
      team: auth.team,
      createdAtIso: nowIso,
    }, { merge: false });
    return { nextVersion, resolvedConfigHash };
  });

  const cacheKey = `campaign-priority:${campaignId}:${applied.nextVersion}`;
  const meta = createMeta(request, "campaign.priority.learn", gameId, cacheKey, false);
  return {
    ...meta,
    costLog: {
      ...meta.costLog,
      provider: "none",
      model: "deterministic-arbiter",
      costRef: `cost-logs/campaign.priority.learn/${auditRef.id}`,
    },
    behaviorLog: createBehaviorLog(request, "campaign.priority.learn", gameId, "success", 0),
    campaignRef,
    feedbackRef: auditRef.path,
    acceptedPriority: priority,
    queuedFor: "campaign-priority-audit",
    autoAssignmentStatus: "operator_override_persisted",
    priorityVersion: applied.nextVersion,
    resolvedConfigHash: applied.resolvedConfigHash,
    sparkMock: false,
  };
}

function sanitizeCandidateLinks(value: unknown): CandidateLinkInput[] {
  if (!Array.isArray(value)) return [];
  const links: CandidateLinkInput[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (links.length >= 100) break;
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = safeId(record.id, "");
    if (!id || id.includes("/") || seen.has(id)) continue;
    seen.add(id);
    const name = (stringOrEmpty(record.name) || id).slice(0, 200);
    const handle = (stringOrEmpty(record.handle) || `@${id}`).slice(0, 240);
    const platform = (stringOrEmpty(record.platform) || "YouTube").slice(0, 80);
    const campaignCandidateRef = stringOrEmpty(record.campaignCandidateRef);
    if (
      !campaignCandidateRef.startsWith("campaign_candidates/")
      || !/^[A-Za-z0-9_-]{1,180}$/.test(campaignCandidateRef.slice("campaign_candidates/".length))
    ) continue;
    const emailRaw = stringOrEmpty(record.email);
    const email = emailRaw.includes("@") ? emailRaw : undefined;
    const optionalFields = {
      canonicalProgramId: stringOrEmpty(record.canonicalProgramId),
      programId: stringOrEmpty(record.programId),
      campaignId: stringOrEmpty(record.campaignId),
      sourceRunId: stringOrEmpty(record.sourceRunId),
      sourceRunRef: stringOrEmpty(record.sourceRunRef),
      candidateRef: stringOrEmpty(record.candidateRef),
      publicationGenerationId: stringOrEmpty(record.publicationGenerationId),
    };
    const publicationCandidateRef = stringOrEmpty(record.publicationCandidateRef);
    if (
      publicationCandidateRef
      && !/^community_candidate_generations\/community_candidate_[a-f0-9]{48}$/.test(publicationCandidateRef)
    ) continue;
    links.push({
      id,
      name,
      handle,
      platform,
      campaignCandidateRef,
      ...(email ? { email } : {}),
      ...(publicationCandidateRef ? { publicationCandidateRef } : {}),
      ...Object.fromEntries(Object.entries(optionalFields).filter(([, child]) => child)),
    });
  }
  return links;
}

/**
 * W127 — CSV 임포트의 `region` 을 국가 축으로 쓸 수 있는 값으로만 통과시킨다.
 *
 * 왜 필요한가: 이 필드는 화면 표시로만 끝나지 않는다. 초기 오디언스 국가 사다리
 * (applicationInitialAudienceCountry 의 `firstCountryField(candidate, [creatorCountry, country, region])`)
 * 가 **처음 맞은 하나에서 멈추므로**, 여기 들어온 두 글자 값이 그 지원 건의 국가로 굳는다.
 * 종전에는 `slice(0, 80)` 뿐이라 `XX`·`EU` 같은 비ISO 코드가 그대로 국가 집계에 유입됐고,
 * 프로그램 경로가 하는 `UK`→`GB` 매핑도 이 경로에는 없어서 같은 나라가 두 코드로 갈렸다.
 *
 * 규칙:
 *   ① 두 글자 형태면 **실배정 alpha-2 일 때만** 통과시키고 정규 코드(UK→GB)로 저장한다.
 *      아니면 버린다 — 가짜 국가 코드를 남기느니 값이 없는 편이 낫다(추측 금지).
 *   ② 두 글자가 아닌 자유 텍스트("North America" 등)는 종전대로 둔다. 국가 사다리는 형태 검사에서
 *      이미 걸러내므로 국가로 승격될 수 없고, 화면 표시용 정보는 지울 이유가 없다.
 */
function sanitizeImportedRegion(value: unknown): { region: string; dropped: boolean } {
  const raw = stringOrEmpty(value);
  if (!raw) return { region: "", dropped: false };
  if (!/^[A-Za-z]{2}$/.test(raw.trim())) return { region: raw.slice(0, 80), dropped: false };
  const region = normalizeIsoAlpha2Country(raw);
  // W127 [적대 리뷰 LOW]: 조용히 버리지 않는다. 임포터가 `XX`·`EU` 를 넣고 국가가 안 붙은 이유를
  //   알 방법이 없으면 다음 CSV 도 똑같이 만든다 — 버린 사실을 건수로 되돌려준다(값은 싣지 않는다).
  return region ? { region, dropped: false } : { region: "", dropped: true };
}

function sanitizeImportedCandidates(
  value: unknown,
): { candidates: ImportedCandidateInput[]; droppedFields: Record<string, number> } {
  const droppedFields: Record<string, number> = {};
  if (!Array.isArray(value)) return { candidates: [], droppedFields };
  const candidates: ImportedCandidateInput[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (candidates.length >= 100 || !entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = stringOrEmpty(row.id || row.candidateId);
    if (!/^[A-Za-z0-9_-]{1,180}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const email = stringOrEmpty(row.email);
    const followers = typeof row.followers === "number" && Number.isFinite(row.followers)
      ? Math.max(0, Math.round(row.followers))
      : undefined;
    const region = sanitizeImportedRegion(row.region);
    if (region.dropped) droppedFields.region = (droppedFields.region ?? 0) + 1;
    candidates.push({
      id,
      name: (stringOrEmpty(row.name) || stringOrEmpty(row.channelTitle) || id).slice(0, 200),
      handle: (stringOrEmpty(row.handle) || `@${id}`).slice(0, 240),
      platform: (stringOrEmpty(row.platform) || "YouTube").slice(0, 80),
      ...(email.includes("@") ? { email } : {}),
      ...(followers !== undefined ? { followers } : {}),
      ...(region.region ? { region: region.region } : {}),
      ...(stringOrEmpty(row.category) ? { category: stringOrEmpty(row.category).slice(0, 120) } : {}),
      ...(stringOrEmpty(row.sourceUrl) ? { sourceUrl: stringOrEmpty(row.sourceUrl).slice(0, 1000) } : {}),
    });
  }
  return { candidates, droppedFields };
}

export function campaignCandidateLinkId(programId: string, campaignId: string, candidateId: string): string {
  return scopedCampaignCandidateLinkId(programId, campaignId, candidateId);
}

function candidatePoolDocumentId(candidate: CandidateLinkInput): string {
  const candidateRefMatch = /^candidate_pool\/([a-zA-Z0-9_-]{1,180})$/.exec(stringOrEmpty(candidate.candidateRef));
  return candidateRefMatch?.[1] ?? candidate.id;
}

function claimedSourceRunIds(...records: unknown[]): string[] {
  return Array.from(new Set(records.flatMap((value) => {
    const record = asRecord(value);
    return [record.sourceRunId, record.sourceRunRef, record.runRef].map(discoveryRunId).filter(Boolean);
  })));
}

function campaignOwnershipFailure(request: CallableRequest, gameId: string, reason: CampaignCandidateOwnership["reason"]): Error {
  return Object.assign(
    new Error(`failed-precondition: campaign candidate ownership rejected (${reason})`),
    {
      code: "failed-precondition", errorCode: "campaign_ownership_failure_campaign_candidate_ownership_rejected",
      behaviorLog: createBehaviorLog(request, "campaign.candidates.add", gameId, "blocked"),
    },
  );
}

export async function importCandidatesToCampaign(request: CallableRequest) {
  const data = readData(request.data);
  const campaignId = safeId(data.campaignId, "");
  const gameId = safeId(data.gameId, "flu");
  const auth = requireWriteRole(request, "campaign.candidates.import", gameId);
  const accountOwnershipScope = await resolveAccountOwnershipScopeForRequest(request, "campaign.candidates.import", ["super_admin", "admin", "manager"], { data });
  assertWritableAccountOwnershipScope(accountOwnershipScope, "campaign.candidates.import");
  const { candidates, droppedFields } = sanitizeImportedCandidates(data.candidates);
  // W127: 검증에서 버린 필드는 건수로 남긴다. 원문 값은 싣지 않는다(SEC-P0-009) — 비ISO region 이
  //   몇 건이었는지만 알면 임포터가 다음 CSV 를 고칠 수 있다.
  if (Object.keys(droppedFields).length > 0) {
    console.warn("[campaign-candidate-import] dropped invalid fields", {
      campaignId,
      rows: candidates.length,
      droppedFields,
    });
  }
  if (!campaignId || candidates.length === 0) {
    throw Object.assign(
      new Error(!campaignId ? "invalid-argument: campaignId is required" : "invalid-argument: at least one candidate is required"),
      { code: "invalid-argument", errorCode: "import_candidates_to_campaign_unauthorized" },
    );
  }

  const aliasRegistry = await readConfirmedProgramAliasRegistryState({ bypassCache: true });
  const requestedProgramId = resolveCanonicalProgramId(data.programId, aliasRegistry.aliasMap);
  if (!requestedProgramId) {
    throw Object.assign(new Error("invalid-argument: programId is required"), { code: "invalid-argument", errorCode: "import_candidates_to_campaign_program_id_required" });
  }
  const nowIso = new Date().toISOString();
  const campaignRef = adminDb.collection("campaigns").doc(campaignId);
  const runId = `csv_${createHash("sha256")
    .update(JSON.stringify({
      campaignId,
      requestedProgramId,
      actor: auth.userId,
      candidates: candidates.map(({ id, email, handle }) => ({ id, email: email ?? "", handle })),
    }))
    .digest("hex")
    .slice(0, 40)}`;
  const sourceRunRef = adminDb.collection("discovery_runs").doc(runId);

  const applied = await adminDb.runTransaction(async (transaction) => {
    const [campaignSnapshot, currentAliasRegistry] = await Promise.all([
      transaction.get(campaignRef),
      readConfirmedProgramAliasRegistryStateInTransaction(transaction),
    ]);
    if (currentAliasRegistry.revision !== aliasRegistry.revision) {
      throw campaignOwnershipFailure(request, gameId, "campaign_program_mismatch");
    }
    const campaign = campaignSnapshot.exists
      ? { id: campaignSnapshot.id, ...(campaignSnapshot.data() ?? {}) }
      : {};
    const scope = resolveCampaignProgramOwnership(
      campaignId,
      campaign,
      requestedProgramId,
      currentAliasRegistry.aliasMap,
    );
    if (!scope.valid) throw campaignOwnershipFailure(request, gameId, scope.reason);
    assertMutationOwner(
      { uid: auth.userId, role: auth.role },
      mutationOwnerUids(campaign, { includeCreatedBy: true }),
      "campaign candidate import",
    );
    const accountOwnership = await accountOwnershipStampForOwnedRecordAsync(accountOwnershipScope, campaign, "campaign candidate import");

    const writePlans = candidates.map((candidate) => buildProgramScopedCandidateParticipationWrites({
      candidate: {
        ...candidate,
        candidateId: candidate.id,
        candidateRef: `candidate_pool/${candidate.id}`,
        source: "csv",
      },
      canonicalProgramId: scope.canonicalProgramId,
      campaignId,
      sourceRunId: runId,
      sourceRunRef: sourceRunRef.path,
      stage: "contact",
      accountOwnership,
    }));
    const participationRefs = writePlans.map((plan) => adminDb.doc(plan.participationRef));
    const [runSnapshot, participationSnapshots, campaignCandidatesSnapshot] = await Promise.all([
      transaction.get(sourceRunRef),
      transaction.getAll(...participationRefs),
      transaction.get(adminDb.collection("campaign_candidates").where("campaignId", "==", campaignId)),
    ]);
    if (runSnapshot.exists) {
      const stored = runSnapshot.data() ?? {};
      if (
        resolveCanonicalProgramId(stored.canonicalProgramId ?? stored.programId, currentAliasRegistry.aliasMap) !== scope.canonicalProgramId
        || stringOrEmpty(stored.campaignId) !== campaignId
      ) {
        throw campaignOwnershipFailure(request, gameId, "source_run_ref_mismatch");
      }
    }

    const linkedCandidateIds = new Set(
      campaignCandidatesSnapshot.docs
        .map((doc) => doc.data())
        .filter((row) => recordMatchesCampaignScope(row, scope, false, currentAliasRegistry.aliasMap))
        .filter((row) => stringOrEmpty(row.linkedAtIso) || stringOrEmpty(row.linkState) === "linked")
        .map((row) => stringOrEmpty(row.candidateId))
        .filter(Boolean),
    );
    let createdCount = 0;
    let existingCount = 0;
    writePlans.forEach((plan, index) => {
      const prior = participationSnapshots[index]?.data() ?? {};
      const alreadyLinked = stringOrEmpty(prior.linkedAtIso) || stringOrEmpty(prior.linkState) === "linked";
      if (alreadyLinked) existingCount += 1;
      else createdCount += 1;
      const candidate = candidates[index];
      linkedCandidateIds.add(candidate.id);
      const identityRef = adminDb.collection("candidate_pool").doc(candidate.id);
      transaction.set(identityRef, {
        ...globalCandidateIdentityData(plan.identityData),
        updatedAtIso: nowIso,
      }, { merge: true });
      transaction.set(adminDb.doc(plan.participationRef), {
        ...plan.participationData,
        stage: "contact",
        linkState: "linked",
        linkedBy: auth.userId,
        linkedAtIso: stringOrEmpty(prior.linkedAtIso) || nowIso,
        updatedAtIso: nowIso,
      }, { merge: true });
    });
    transaction.set(sourceRunRef, {
      id: runId,
      runRef: sourceRunRef.path,
      sourceRunId: runId,
      sourceRunRef: sourceRunRef.path,
      source: "csv",
      status: "complete",
      canonicalProgramId: scope.canonicalProgramId,
      programId: scope.canonicalProgramId,
      programRef: `programs/${scope.canonicalProgramId}`,
      campaignId,
      campaignRef: campaignRef.path,
      candidateSnapshot: writePlans.map((plan) => ({
        id: stringOrEmpty(plan.participationData.candidateId),
        candidateId: stringOrEmpty(plan.participationData.candidateId),
        candidateRef: plan.identityRef,
        campaignCandidateRef: plan.participationRef,
      })),
      candidateCount: candidates.length,
      createdBy: auth.userId,
      createdAtIso: stringOrEmpty(runSnapshot.data()?.createdAtIso) || nowIso,
      // W2 [LOG-P0-010 180일 TTL]: merge:true라 이미 있던 run 문서면 expireAt을 다시 늘리지
      // 않는다 — 최초 생성 시점 기준으로 한 번만 찍는다(createdAtIso와 같은 보존 규칙).
      expireAt: runSnapshot.data()?.expireAt ?? expireAt180DaysFromIso(stringOrEmpty(runSnapshot.data()?.createdAtIso) || nowIso),
      updatedAtIso: nowIso,
    }, { merge: true });
    transaction.set(campaignRef, {
      candidateCount: linkedCandidateIds.size,
      candidateCountProgramId: scope.canonicalProgramId,
      candidateCountSource: "importCandidatesToCampaign",
      candidateCountRevision: FieldValue.increment(1),
      updatedAtIso: nowIso,
    }, { merge: true });
    return { scope, createdCount, existingCount, candidateCount: linkedCandidateIds.size };
  });

  return {
    ok: true,
    campaignId,
    campaignRef: campaignRef.path,
    programId: applied.scope.canonicalProgramId,
    runId,
    runRef: sourceRunRef.path,
    linkedCount: applied.createdCount,
    createdCount: applied.createdCount,
    existingCount: applied.existingCount,
    candidateCount: applied.candidateCount,
    behaviorLog: createBehaviorLog(request, "campaign.candidates.import", gameId, "success"),
  };
}

export async function listCampaignCandidates(request: CallableRequest) {
  const data = readData(request.data);
  const campaignId = safeId(data.campaignId, "");
  const aliasRegistry = await readConfirmedProgramAliasRegistryState({ bypassCache: true });
  const requestedProgramId = resolveCanonicalProgramId(data.programId, aliasRegistry.aliasMap);
  const pageSize = safeCampaignCandidatePageSize(data.pageSize);
  const gameId = safeId(data.gameId, "flu");
  const accountOwnershipScope = await resolveAccountOwnershipScopeForRequest(request, "campaign.candidates.list", ["super_admin", "admin", "manager", "viewer"], { data });
  requireReadRole(request, "campaign.candidates.list", gameId);
  if (!campaignId || !requestedProgramId) {
    throw Object.assign(new Error("invalid-argument: programId and campaignId are required"), { code: "invalid-argument", errorCode: "list_campaign_candidates_program_id_campaign_id_required" });
  }
  const campaignRef = adminDb.collection("campaigns").doc(campaignId);
  const campaignSnapshot = await campaignRef.get();
  const campaign = campaignSnapshot.exists
    ? { id: campaignSnapshot.id, ...(campaignSnapshot.data() ?? {}) }
    : {};
  const scope = resolveCampaignProgramOwnership(
    campaignId,
    campaign,
    requestedProgramId,
    aliasRegistry.aliasMap,
  );
  if (!scope.valid) throw campaignOwnershipFailure(request, gameId, scope.reason);
  await assertAccountOwnershipForRecordAsync(accountOwnershipScope, campaign, "campaign candidate list");
  const requestedCursor = stringOrEmpty(data.cursor);
  const cursor = requestedCursor ? decodeCampaignCandidateCursor(requestedCursor) : null;
  if (requestedCursor && !cursor) {
    throw Object.assign(new Error("invalid-argument: candidate cursor is invalid"), { code: "invalid-argument", errorCode: "list_campaign_candidates_candidate_cursor_invalid" });
  }
  if (
    cursor
    && (cursor.canonicalProgramId !== scope.canonicalProgramId || cursor.campaignId !== campaignId)
  ) {
    throw Object.assign(
      new Error("failed-precondition: candidate cursor belongs to a different program or campaign"),
      { code: "failed-precondition", errorCode: "list_campaign_candidates_candidate_cursor_belongs_different_program" },
    );
  }

  // SCP production history contains both canonical and legacy alias fields. Query both
  // ownership columns before each bounded read so old real candidates remain visible.
  // Each query uses the same document-id cursor; merging the two sorted windows then
  // advancing by the last scanned link id gives a deterministic union page without
  // allowing another program's rows to consume the bounded scan.
  const scopedProgramIds = confirmedProgramIdentitySet(scope.canonicalProgramId, aliasRegistry.aliasMap);
  const candidateCollection = adminDb.collection("campaign_candidates");
  const activeGenerationId = await activeCommunityPublicationGeneration({
    canonicalProgramId: scope.canonicalProgramId,
    campaignId,
  });
  const baseScanLimit = pageSize + 201;
  const scopedQuery = (field: "canonicalProgramId" | "programId") => {
    let query: Query = candidateCollection
      .where("campaignId", "==", campaignId)
      .where(field, "in", scopedProgramIds)
      .orderBy(FieldPath.documentId());
    if (cursor) query = query.startAfter(cursor.afterCandidateLinkId);
    return query.limit(baseScanLimit);
  };
  const [canonicalSnapshot, legacySnapshot, generationSnapshot] = await Promise.all([
    scopedQuery("canonicalProgramId").get(),
    scopedQuery("programId").get(),
    activeGenerationId
      ? (() => {
        let query: Query = adminDb.collection("community_candidate_generations")
          .where("canonicalProgramId", "==", scope.canonicalProgramId)
          .where("campaignId", "==", campaignId)
          .where("publicationGenerationId", "==", activeGenerationId)
          .orderBy("stableCampaignCandidateId", "asc");
        if (cursor) query = query.startAfter(cursor.afterCandidateLinkId);
        return query.limit(pageSize + 1).get();
      })()
      : Promise.resolve(null),
  ]);
  const candidateRows = new Map<string, Record<string, unknown>>();
  for (const doc of [...canonicalSnapshot.docs, ...legacySnapshot.docs]) {
    const row: Record<string, unknown> = { ...doc.data(), id: doc.id, campaignCandidateRef: doc.ref.path };
    if (row.communityStableHead === true || row.communityGenerationRow === true) continue;
    candidateRows.set(doc.id, row);
  }
  for (const doc of generationSnapshot?.docs ?? []) {
    const row = { ...doc.data() };
    const stableRef = stringOrEmpty(row.campaignCandidateRef);
    const stableId = stableRef.startsWith("campaign_candidates/") ? stableRef.slice("campaign_candidates/".length) : "";
    if (!stableId) continue;
    const activeGenerationRow = {
      ...row,
      id: stableId,
      campaignCandidateRef: stableRef,
      publicationCandidateRef: doc.ref.path,
    };
    const stableRow = candidateRows.get(stableId);
    candidateRows.set(stableId, stableRow && (stringOrEmpty(stableRow.linkedAtIso) || stringOrEmpty(stableRow.linkState) === "linked")
      ? { ...activeGenerationRow, ...stableRow, publicationCandidateRef: doc.ref.path }
      : activeGenerationRow);
  }
  const sortedCandidateRows = Array.from(candidateRows.entries())
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const scannedRows = sortedCandidateRows.slice(0, pageSize);
  const candidates = scannedRows
    .map(([, row]) => row)
    .filter((row) => recordMatchesCampaignScope(row, scope, false, aliasRegistry.aliasMap))
    .filter((row) => campaignCandidateRunVisible(row, activeGenerationId))
    .map((row) => ({
      ...row,
      id: stringOrEmpty(row.candidateId) || stringOrEmpty(row.id),
      canonicalProgramId: scope.canonicalProgramId,
      programId: scope.canonicalProgramId,
      campaignId,
      campaignRef: campaignRef.path,
    }));
  const hasMore = sortedCandidateRows.length > scannedRows.length
    || canonicalSnapshot.size >= baseScanLimit
    || legacySnapshot.size >= baseScanLimit
    || (generationSnapshot?.size ?? 0) > pageSize;
  const lastScannedCandidateLinkId = scannedRows.at(-1)?.[0] ?? "";
  const nextCursor = hasMore && lastScannedCandidateLinkId
    ? encodeCampaignCandidateCursor({
      canonicalProgramId: scope.canonicalProgramId,
      campaignId,
      afterCandidateLinkId: lastScannedCandidateLinkId,
    })
    : null;
  return {
    ok: true,
    programId: scope.canonicalProgramId,
    campaignId,
    candidates,
    count: candidates.length,
    pageSize,
    hasMore,
    nextCursor,
    sort: "campaign_candidate_ref_asc",
  };
}

// Candidate linkage is an ownership-fenced transaction. The campaign document and the
// exact campaign_candidates reference are the only scope authorities. Global identity
// rows are deliberately not consulted because one creator can participate in many
// programs with different eligibility and provenance.
export async function addCandidatesToCampaign(request: CallableRequest): Promise<AddCandidatesToCampaignResponse> {
  const data = readData(request.data);
  const campaignId = safeId(data.campaignId, "");
  const gameId = safeId(data.gameId, "flu");
  const auth = requireWriteRole(request, "campaign.candidates.add", gameId);
  const accountOwnershipScope = await resolveAccountOwnershipScopeForRequest(request, "campaign.candidates.add", ["super_admin", "admin", "manager"], { data });
  assertWritableAccountOwnershipScope(accountOwnershipScope, "campaign.candidates.add");

  const candidates = sanitizeCandidateLinks(data.candidates);
  if (!campaignId) {
    const behaviorLog = createBehaviorLog(request, "campaign.candidates.add", gameId, "invalid");
    throw Object.assign(new Error("invalid-argument: campaignId is required"), { code: "invalid-argument", errorCode: "add_candidates_to_campaign_campaign_id_required", behaviorLog });
  }
  if (candidates.length === 0) {
    const behaviorLog = createBehaviorLog(request, "campaign.candidates.add", gameId, "invalid");
    throw Object.assign(new Error("invalid-argument: at least one candidate is required"), { code: "invalid-argument", errorCode: "add_candidates_to_campaign_at_least_candidate_required", behaviorLog });
  }

  const campaignRef = `campaigns/${campaignId}`;
  const nowIso = new Date().toISOString();
  const collection = adminDb.collection("campaign_candidates");
  const campaignDocRef = adminDb.doc(campaignRef);
  const requestedRun = { sourceRunId: data.sourceRunId, sourceRunRef: data.sourceRunRef };
  const applied = await adminDb.runTransaction(async (transaction) => {
    const [campaignSnapshot, aliasRegistry] = await Promise.all([
      transaction.get(campaignDocRef),
      readConfirmedProgramAliasRegistryStateInTransaction(transaction),
    ]);
    const campaign = campaignSnapshot.exists
      ? { id: campaignSnapshot.id, ...(campaignSnapshot.data() ?? {}) }
      : {};
    const scope = resolveCampaignProgramOwnership(
      campaignId,
      campaign,
      data.programId,
      aliasRegistry.aliasMap,
    );
    if (!scope.valid) throw campaignOwnershipFailure(request, gameId, scope.reason);
    assertMutationOwner(
      { uid: auth.userId, role: auth.role },
      mutationOwnerUids(campaign, { includeCreatedBy: true }),
      "campaign candidate linkage",
    );
    const accountOwnership = await accountOwnershipStampForOwnedRecordAsync(accountOwnershipScope, campaign, "campaign candidate linkage");

    const publicationCandidates = candidates.filter((candidate) => Boolean(candidate.publicationCandidateRef));
    const legacyCandidates = candidates.filter((candidate) => !candidate.publicationCandidateRef);
    const legacyRefs = legacyCandidates.map((candidate) => adminDb.doc(candidate.campaignCandidateRef));
    const pointerRef = publicationCandidates.length > 0
      ? adminDb.collection("community_publication_heads").doc(communityPublicationPointerId({
        canonicalProgramId: scope.canonicalProgramId,
        campaignId,
      }))
      : null;
    const [legacySnapshots, existingLinksSnapshot, pointerSnapshot] = await Promise.all([
      legacyRefs.length > 0 ? transaction.getAll(...legacyRefs) : Promise.resolve([]),
      transaction.get(collection.where("campaignId", "==", campaignId)),
      pointerRef ? transaction.get(pointerRef) : Promise.resolve(null),
    ]);
    const scopedRecords = new Map<string, DocumentData>();
    legacyCandidates.forEach((candidate, index) => {
      const expectedRef = `campaign_candidates/${campaignCandidateLinkId(scope.canonicalProgramId, campaignId, candidate.id)}`;
      if (candidate.campaignCandidateRef !== expectedRef) {
        throw campaignOwnershipFailure(request, gameId, "campaign_candidate_ref_mismatch");
      }
      const snapshot = legacySnapshots[index];
      if (!snapshot?.exists || snapshot.ref.path !== candidate.campaignCandidateRef) {
        throw campaignOwnershipFailure(request, gameId, "campaign_candidate_ref_mismatch");
      }
      const sourceRecord: DocumentData = {
        id: snapshot.id,
        campaignCandidateRef: snapshot.ref.path,
        ...(snapshot.data() ?? {}),
      };
      const storedCandidateId = stringOrEmpty(sourceRecord.candidateId);
      const storedCandidateRef = stringOrEmpty(sourceRecord.candidateRef);
      if (
        storedCandidateId !== candidate.id
        || (stringOrEmpty(candidate.candidateRef) && storedCandidateRef !== candidate.candidateRef)
      ) {
        throw campaignOwnershipFailure(request, gameId, "candidate_identity_mismatch");
      }
      scopedRecords.set(candidate.id, sourceRecord);
    });

    if (publicationCandidates.length > 0) {
      const pointerData = pointerSnapshot?.data() ?? {};
      const activeGenerationId = stringOrEmpty(pointerData.activeGenerationId);
      const activeGenerationRef = stringOrEmpty(pointerData.activeGenerationRef);
      const activeSourceRunId = stringOrEmpty(pointerData.activeSourceRunId);
      if (
        !pointerSnapshot?.exists
        || stringOrEmpty(pointerData.contractVersion) !== COMMUNITY_PUBLICATION_CONTRACT_VERSION
        || stringOrEmpty(pointerData.status) !== "active"
        || resolveCanonicalProgramId(pointerData.canonicalProgramId, aliasRegistry.aliasMap) !== scope.canonicalProgramId
        || stringOrEmpty(pointerData.programRef) !== `programs/${scope.canonicalProgramId}`
        || stringOrEmpty(pointerData.campaignId) !== campaignId
        || stringOrEmpty(pointerData.campaignRef) !== campaignRef
        || !/^community_generation_[a-f0-9]{48}$/.test(activeGenerationId)
        || activeGenerationRef !== `community_publication_generations/${activeGenerationId}`
        || !activeSourceRunId
        || stringOrEmpty(pointerData.activeSourceRunRef) !== `discovery_runs/${activeSourceRunId}`
        || !["complete", "partial"].includes(stringOrEmpty(pointerData.activeSourceRunStatus))
      ) {
        throw campaignOwnershipFailure(request, gameId, "publication_pointer_inactive");
      }
      const generationSnapshot = await transaction.get(adminDb.doc(activeGenerationRef));
      const generationData = generationSnapshot.data() ?? {};
      if (
        !generationSnapshot.exists
        || stringOrEmpty(generationData.contractVersion) !== COMMUNITY_PUBLICATION_CONTRACT_VERSION
        || stringOrEmpty(generationData.status) !== "active"
        || stringOrEmpty(generationData.generationRef) !== activeGenerationRef
        || resolveCanonicalProgramId(generationData.canonicalProgramId, aliasRegistry.aliasMap) !== scope.canonicalProgramId
        || stringOrEmpty(generationData.campaignId) !== campaignId
        || stringOrEmpty(generationData.sourceRunId) !== activeSourceRunId
        || stringOrEmpty(generationData.sourceRunRef) !== `discovery_runs/${activeSourceRunId}`
        || !["complete", "partial"].includes(stringOrEmpty(generationData.sourceRunStatus))
      ) {
        throw campaignOwnershipFailure(request, gameId, "publication_generation_mismatch");
      }
      const publicationRefs = publicationCandidates.map((candidate) => adminDb.doc(candidate.publicationCandidateRef ?? ""));
      const publicationSnapshots = await transaction.getAll(...publicationRefs);
      publicationCandidates.forEach((candidate, index) => {
        const expectedStableRef = `campaign_candidates/${campaignCandidateLinkId(scope.canonicalProgramId, campaignId, candidate.id)}`;
        const snapshot = publicationSnapshots[index];
        const sourceRecord: DocumentData = snapshot?.exists
          ? { id: snapshot.id, publicationCandidateRef: snapshot.ref.path, ...(snapshot.data() ?? {}) }
          : {};
        if (
          !snapshot?.exists
          || snapshot.ref.path !== candidate.publicationCandidateRef
          || candidate.campaignCandidateRef !== expectedStableRef
          || stringOrEmpty(sourceRecord.campaignCandidateRef) !== expectedStableRef
          || sourceRecord.communityGenerationRow !== true
          || stringOrEmpty(sourceRecord.publicationStatus) !== "published"
          || stringOrEmpty(sourceRecord.publicationGenerationId) !== activeGenerationId
          || stringOrEmpty(sourceRecord.publicationGenerationRef) !== activeGenerationRef
          || stringOrEmpty(sourceRecord.publicationContractVersion) !== COMMUNITY_PUBLICATION_CONTRACT_VERSION
          || (candidate.publicationGenerationId && candidate.publicationGenerationId !== activeGenerationId)
          || stringOrEmpty(sourceRecord.candidateId) !== candidate.id
          || stringOrEmpty(sourceRecord.candidateRef) !== `candidate_pool/${candidate.id}`
          || resolveCanonicalProgramId(sourceRecord.canonicalProgramId, aliasRegistry.aliasMap) !== scope.canonicalProgramId
          || stringOrEmpty(sourceRecord.campaignId) !== campaignId
          || !["complete", "partial"].includes(stringOrEmpty(sourceRecord.sourceRunStatus))
        ) {
          throw campaignOwnershipFailure(request, gameId, "publication_candidate_ref_mismatch");
        }
        scopedRecords.set(candidate.id, sourceRecord);
      });
    }

    const sourceRunIdsByCandidate = new Map<string, string>();
    for (const candidate of candidates) {
      const runIds = claimedSourceRunIds(candidate, scopedRecords.get(candidate.id), requestedRun);
      if (runIds.length > 1) throw campaignOwnershipFailure(request, gameId, "source_run_ref_mismatch");
      sourceRunIdsByCandidate.set(candidate.id, runIds[0] ?? "");
    }
    const sourceRunIds = Array.from(new Set(sourceRunIdsByCandidate.values())).filter(Boolean);
    const sourceRunSnapshots = sourceRunIds.length > 0
      ? await transaction.getAll(...sourceRunIds.map((runId) => adminDb.collection("discovery_runs").doc(runId)))
      : [];
    const sourceRuns = new Map(sourceRunSnapshots.map((snapshot) => [
      snapshot.id,
      snapshot.exists ? { id: snapshot.id, ...(snapshot.data() ?? {}) } : {},
    ]));

    const linkedCandidateIds = new Set<string>();
    const existingLinkedRecords = new Map<string, DocumentData>();
    for (const doc of existingLinksSnapshot.docs) {
      const row = doc.data();
      if (!recordMatchesCampaignScope(row, scope, true, aliasRegistry.aliasMap)) continue;
      const candidateId = stringOrEmpty(row.candidateId);
      if (!candidateId) continue;
      if (stringOrEmpty(row.linkedAtIso) || stringOrEmpty(row.linkState) === "linked") {
        linkedCandidateIds.add(candidateId);
        existingLinkedRecords.set(candidateId, row);
      }
    }

    let createdCount = 0;
    let existingCount = 0;
    for (const candidate of candidates) {
      const sourceRecord = scopedRecords.get(candidate.id) ?? {};
      const sourceRunId = sourceRunIdsByCandidate.get(candidate.id) ?? "";
      const sourceRun = sourceRunId ? sourceRuns.get(sourceRunId) ?? {} : {};
      const candidateClaim = sourceRunId
        ? { ...candidate, sourceRunId, sourceRunRef: `discovery_runs/${sourceRunId}` }
        : candidate;
      const ownership = validateCampaignCandidateOwnership(
        scope,
        { candidate: candidateClaim, sourceRecord, sourceRun },
        aliasRegistry.aliasMap,
      );
      if (!ownership.valid) throw campaignOwnershipFailure(request, gameId, ownership.reason);

      const existingLinkedRecord = existingLinkedRecords.get(candidate.id) ?? {};
      const alreadyLinked = Boolean(
        stringOrEmpty(existingLinkedRecord.linkedAtIso)
        || stringOrEmpty(existingLinkedRecord.linkState) === "linked"
        || stringOrEmpty(sourceRecord.linkedAtIso)
        || stringOrEmpty(sourceRecord.linkState) === "linked"
      );
      if (alreadyLinked) existingCount += 1;
      else createdCount += 1;
      const linkRef = adminDb.doc(candidate.campaignCandidateRef);
      const publicationCandidateRef = stringOrEmpty(candidate.publicationCandidateRef);
      if (publicationCandidateRef) {
        const identityRef = adminDb.collection("candidate_pool").doc(candidatePoolDocumentId(candidate));
        if (identityRef.path !== `candidate_pool/${candidate.id}`) {
          throw campaignOwnershipFailure(request, gameId, "candidate_identity_mismatch");
        }
        transaction.set(identityRef, {
          ...globalCandidateIdentityData(sourceRecord),
          id: candidate.id,
          candidateId: candidate.id,
          candidateRef: identityRef.path,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      transaction.set(linkRef, {
        id: linkRef.id,
        campaignCandidateRef: linkRef.path,
        campaignId,
        campaignRef,
        programId: scope.canonicalProgramId,
        canonicalProgramId: scope.canonicalProgramId,
        programRef: `programs/${scope.canonicalProgramId}`,
        candidateId: candidate.id,
        candidateRef: stringOrEmpty(candidate.candidateRef)
          || stringOrEmpty(sourceRecord.candidateRef)
          || `candidate_pool/${candidate.id}`,
        creatorRef: `creators/${candidate.id}`,
        name: candidate.name,
        handle: candidate.handle,
        platform: candidate.platform,
        ...(candidate.email ? { email: candidate.email } : {}),
        ...(sourceRunId ? { sourceRunId, sourceRunRef: `discovery_runs/${sourceRunId}` } : {}),
        source: publicationCandidateRef ? "community-discovery" : "discover",
        ...(publicationCandidateRef ? {
          sourceArtifactRef: stringOrEmpty(sourceRecord.sourceArtifactRef),
          sourceRunStatus: stringOrEmpty(sourceRecord.sourceRunStatus),
          publicationStatus: "activated",
          publicationCandidateRef,
          publicationGenerationId: stringOrEmpty(sourceRecord.publicationGenerationId),
          publicationGenerationRef: stringOrEmpty(sourceRecord.publicationGenerationRef),
          publicationContractVersion: COMMUNITY_PUBLICATION_CONTRACT_VERSION,
          communityActivatedHead: true,
        } : {}),
        stage: "contact",
        linkState: "linked",
        linkedBy: request.auth?.uid ?? "anonymous",
        linkedAtIso: stringOrEmpty(existingLinkedRecord.linkedAtIso) || stringOrEmpty(sourceRecord.linkedAtIso) || nowIso,
        ...accountOwnership,
        updatedAtIso: nowIso,
      }, { merge: true });
      linkedCandidateIds.add(candidate.id);
    }

    const candidateCount = linkedCandidateIds.size;
    transaction.set(campaignDocRef, {
      candidateCount,
      candidateCountProgramId: scope.canonicalProgramId,
      candidateCountSource: "addCandidatesToCampaign",
      candidateCountRevision: FieldValue.increment(1),
      updatedAtIso: nowIso,
    }, { merge: true });
    return { scope, candidateCount, createdCount, existingCount };
  });

  return {
    ok: true,
    campaignId,
    campaignRef,
    linkedCount: applied.createdCount,
    createdCount: applied.createdCount,
    existingCount: applied.existingCount,
    candidateCount: applied.candidateCount,
    behaviorLog: createBehaviorLog(request, "campaign.candidates.add", gameId, "success"),
  };
}
