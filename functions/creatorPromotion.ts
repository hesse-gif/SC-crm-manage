// C2 후보 승격: candidate_pool → creators(type=influencer). v0.3.18 갭 — 발견된 후보가 creators로 승격되지
//   않아 activityRefresh가 영상을 수집하지 못해 피드가 갱신되지 않던 문제를 해소한다.
//   멀티컨트리(KR/JP/GB/US/AU/CA) + 급상승(view-velocity) 신호로 랭킹해 상위 후보를 승격한다.
//   승격된 creator는 activityRefresh(type==influencer)가 최근 영상을 수집 → videos → adClassificationPending → 광고분류.
//   클라 직접쓰기 금지(SEC-P0-004) → 콜러블/스케줄러 경유. 외부호출 없음(DB 승격만; 영상 수집은 activityRefresh).
import { createHash } from "node:crypto";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  campaignCandidateRefFor,
  CANDIDATE_SCOPE_VERSION,
  CANDIDATE_SOURCE_PURPOSE,
} from "./candidateScope";
import { isOperationalFixtureRecord } from "./operationalFixtureProvenance";
import { resolveCanonicalProgramId } from "./programCanonical";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";

const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;

// 피드 언어 게이트와 정합: ko/ja + 네이티브 영어권. 우주하마(KR)는 예시일 뿐 — 한국 전용 아님.
export const FEED_TARGET_COUNTRIES = ["KR", "JP", "GB", "US", "AU", "CA"] as const;
const DEFAULT_PROMOTE_LIMIT = 40;
const DEFAULT_MIN_FOLLOWERS = 5000;
const MAX_PROMOTE_LIMIT = 200;
const DEFAULT_RECONCILIATION_PAGE_SIZE = 100;
const MAX_RECONCILIATION_PAGE_SIZE = 200;
const CREATOR_PROMOTION_RECONCILIATION_VERSION = "creator_promotion_reconciliation_v1" as const;
const CREATOR_PROMOTION_STATE_COLLECTION = "creator_promotion_state";
const CREATOR_PROMOTION_RECONCILIATION_STATE_ID = "candidate_pool_reconciliation_v1";
const CREATOR_PROMOTION_RECONCILIATION_SCOPE = {
  sourceCollection: "candidate_pool",
  order: "document_id_asc",
  ownership: "exact_discovery_promotion_candidate",
} as const;
const CREATOR_PROMOTION_RECONCILIATION_SCOPE_HASH = createHash("sha256")
  .update(JSON.stringify(CREATOR_PROMOTION_RECONCILIATION_SCOPE))
  .digest("hex");

export function normalizeCountry(value: unknown): string {
  const s = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(s) ? s : "";
}

// 급상승 신호: 최근 영상들의 조회수 합 / 경과일수(views/day). activityRefresh가 최근 영상을 수집한 뒤 갱신한다.
export function computeViewVelocity(
  recentVideos: ReadonlyArray<{ views?: number; publishedAtIso?: string }>,
  nowMs = Date.now(),
): number {
  let totalViews = 0;
  let oldestMs = nowMs;
  for (const v of recentVideos) {
    const views = typeof v.views === "number" && Number.isFinite(v.views) ? v.views : 0;
    totalViews += views;
    const t = v.publishedAtIso ? Date.parse(v.publishedAtIso) : NaN;
    if (Number.isFinite(t) && t < oldestMs) oldestMs = t;
  }
  if (recentVideos.length === 0) return 0;
  const spanDays = Math.max(1, (nowMs - oldestMs) / (24 * 60 * 60 * 1000));
  return Math.round(totalViews / spanDays);
}

export type PromotionCandidate = {
  id: string;
  region?: string;
  followers?: number;
  matchScore?: number;
  viewVelocity?: number;
  platform?: string;
  type?: string;
  category?: string;
  promotedToCreator?: boolean;
  candidateSourcePurpose?: string;
  candidateSourcePurposeVersion?: string;
  feedDiscoveryCandidate?: boolean;
  programCandidateDiscovered?: boolean;
};

export function isPromotableCandidate(
  c: PromotionCandidate,
  opts: { targetCountries?: readonly string[]; minFollowers?: number } = {},
): boolean {
  if (c.promotedToCreator === true) return false;
  if (c.type === "agency") return false; // 개인 크리에이터만 피드 대상.
  const targets = new Set((opts.targetCountries ?? FEED_TARGET_COUNTRIES).map((x) => x.toUpperCase()));
  const country = normalizeCountry(c.region);
  if (!country || !targets.has(country)) return false;
  const followers = typeof c.followers === "number" ? c.followers : 0;
  if (followers < (opts.minFollowers ?? DEFAULT_MIN_FOLLOWERS)) return false;
  return true;
}

// 랭킹 점수: matchScore(0~100) 주도 + view-velocity 로그 가중(급상승 우대). 결정론적·감사가능.
export function promotionScore(c: PromotionCandidate): number {
  const match = typeof c.matchScore === "number" ? Math.max(0, Math.min(100, c.matchScore)) : 50;
  const velocity = typeof c.viewVelocity === "number" && c.viewVelocity > 0 ? c.viewVelocity : 0;
  const velocityBonus = velocity > 0 ? Math.min(40, Math.log10(velocity + 1) * 8) : 0;
  return Number((match + velocityBonus).toFixed(3));
}

type FirestoreDocRef = {
  get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
  set(data: Record<string, unknown>, options: { merge: boolean }): Promise<unknown>;
};
type FirestoreDocSnapshot = {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
};
type FirestoreQueryDoc = {
  id: string;
  ref: FirestoreDocRef;
  data(): Record<string, unknown> | undefined;
};
type FirestoreQuery = {
  limit(count: number): FirestoreQuery;
  where(field: string, operation: "in", values: readonly string[]): FirestoreQuery;
  orderBy(field: unknown, direction?: "asc" | "desc"): FirestoreQuery;
  startAfter(value: string): FirestoreQuery;
  get(): Promise<{ docs: FirestoreQueryDoc[] }>;
};
type FirestoreTransaction = {
  get(ref: FirestoreDocRef): Promise<FirestoreDocSnapshot>;
  get(query: FirestoreQuery): Promise<{ docs: FirestoreQueryDoc[] }>;
  set(ref: FirestoreDocRef, data: Record<string, unknown>, options: { merge: boolean }): void;
};
type FirestoreDb = {
  collection(name: string): FirestoreQuery & { doc(id: string): FirestoreDocRef };
  runTransaction<T>(handler: (transaction: FirestoreTransaction) => Promise<T>): Promise<T>;
};

export type PromoteOptions = {
  db?: FirestoreDb;
  limit?: number;
  scanLimit?: number;
  minFollowers?: number;
  targetCountries?: readonly string[];
  nowIso?: string;
  reconciliationPageSize?: number;
};

export type PromotionReconciliationResult = {
  schemaVersion: typeof CREATOR_PROMOTION_RECONCILIATION_VERSION;
  scopeHash: string;
  revision: number;
  cycle: number;
  status: "active" | "complete";
  cursor: string | null;
  pageSize: number;
  scanned: number;
  ownedCandidates: number;
  qualityEligible: number;
  promotable: number;
  promoted: number;
  skippedExisting: number;
  reconciledExisting: number;
  blockedKnownProgram: number;
  quarantinedUnknown: number;
  revokedExisting: number;
  byCountry: Record<string, number>;
};

export type PromoteResult = {
  ok: true;
  scanned: number;
  promotable: number;
  promoted: number;
  skippedExisting: number;
  reconciledExisting: number;
  blockedProgramScope: number;
  blockedKnownProgram: number;
  quarantinedUnknown: number;
  revokedExisting: number;
  reconciliation: PromotionReconciliationResult;
  byCountry: Record<string, number>;
};

function promotionDb(options: PromoteOptions): FirestoreDb {
  return (options.db as FirestoreDb) ?? (adminDb as unknown as FirestoreDb);
}

type PromotionParticipation = {
  participationRef: string;
  programId: string;
  campaignId: string;
  approvalMode: "policy_pass" | "human_approval" | null;
};

type FeedPromotionProof = "candidate_scope_v3" | "legacy_feed_ledger";

type PromotionCandidateRow = {
  id: string;
  ref: FirestoreDocRef;
  data: Record<string, unknown>;
  candidate: PromotionCandidate;
};

type PromotionDecision = {
  row: PromotionCandidateRow;
  status: "promotable" | "blocked_program" | "quarantine";
};

type PromotionEvaluation = {
  decisions: PromotionDecision[];
  promotionEvidence: Map<string, PromotionParticipation[]>;
  feedPromotionProof: Map<string, FeedPromotionProof>;
};

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function validIso(value: unknown): boolean {
  const text = asString(value);
  return Boolean(text) && Number.isFinite(Date.parse(text));
}

function hasProgramPolicyEvidence(row: Record<string, unknown>): boolean {
  const eligibility = recordValue(row.eligibility);
  const scopeEvidence = recordValue(row.programScopeEvidence);
  return Boolean(
    asString(row.criteriaHash)
    || asString(row.policyHash)
    || asString(eligibility.criteriaHash)
    || asString(eligibility.policyHash)
    || asString(scopeEvidence.programPolicyRef)
    || asString(scopeEvidence.criteriaHash)
    || asString(scopeEvidence.policyHash)
    || Object.keys(recordValue(scopeEvidence.candidateCriteriaSnapshot)).length > 0
    || Object.keys(recordValue(scopeEvidence.eligibilityCriteriaSnapshot)).length > 0
  );
}

function hasExplicitHumanApproval(row: Record<string, unknown>): boolean {
  if (
    asString(row.linkState).toLowerCase() === "linked"
    && asString(row.linkedBy)
    && validIso(row.linkedAtIso)
  ) return true;
  const scopeEvidence = recordValue(row.programScopeEvidence);
  for (const value of [
    row.promotionApproval,
    row.humanApproval,
    scopeEvidence.promotionApproval,
    scopeEvidence.humanApproval,
  ]) {
    const approval = recordValue(value);
    const decision = asString(approval.status, asString(approval.decision)).toLowerCase();
    const actor = asString(approval.approvedBy, asString(approval.decidedBy));
    const decidedAt = approval.approvedAtIso ?? approval.decidedAtIso;
    if (["approved", "approve", "pass", "passed"].includes(decision) && actor && validIso(decidedAt)) return true;
  }
  return false;
}

function exactPromotionParticipation(
  candidateId: string,
  row: Record<string, unknown>,
  fallbackRef: string,
): PromotionParticipation | null {
  const canonicalProgramId = resolveCanonicalProgramId(row.canonicalProgramId ?? row.programId);
  const programId = resolveCanonicalProgramId(row.programId);
  const campaignId = asString(row.campaignId);
  const candidateRef = asString(row.candidateRef);
  const participationRef = asString(row.campaignCandidateRef, fallbackRef);
  if (
    !canonicalProgramId
    || programId !== canonicalProgramId
    || !campaignId
    || asString(row.programRef) !== `programs/${canonicalProgramId}`
    || asString(row.campaignRef) !== `campaigns/${campaignId}`
    || asString(row.candidateId) !== candidateId
    || candidateRef !== `candidate_pool/${candidateId}`
    || participationRef !== fallbackRef
    || participationRef !== campaignCandidateRefFor(canonicalProgramId, campaignId, candidateId)
  ) return null;

  if (hasExplicitHumanApproval(row)) {
    return { participationRef, programId: canonicalProgramId, campaignId, approvalMode: "human_approval" };
  }

  const eligibility = recordValue(row.eligibility);
  const verdict = asString(eligibility.verdict).toLowerCase();
  const stage = asString(row.stage).toLowerCase();
  const sourceRunId = asString(row.sourceRunId);
  const sourceRunRef = asString(row.sourceRunRef);
  const exactRun = Boolean(sourceRunId) && sourceRunRef === `discovery_runs/${sourceRunId}`;
  const passStage = ["pass", "passed", "qualified", "approved", "eligible"].includes(stage);
  if (["pass", "passed", "approved"].includes(verdict) && passStage && exactRun && hasProgramPolicyEvidence(row)) {
    return { participationRef, programId: canonicalProgramId, campaignId, approvalMode: "policy_pass" };
  }
  return { participationRef, programId: canonicalProgramId, campaignId, approvalMode: null };
}

function collectCandidateParticipations(
  target: Map<string, Array<{ ref: string; data: Record<string, unknown> }>>,
  docs: readonly FirestoreQueryDoc[],
  allowedCandidateIds: readonly string[],
): void {
  for (const doc of docs) {
    const data = doc.data() ?? {};
    const candidateId = asString(data.candidateId);
    if (!candidateId || !allowedCandidateIds.includes(candidateId)) continue;
    const rows = target.get(candidateId) ?? [];
    rows.push({ ref: `campaign_candidates/${doc.id}`, data });
    target.set(candidateId, rows);
  }
}

function hasV3FeedPurpose(candidate: PromotionCandidate): boolean {
  return candidate.candidateSourcePurposeVersion === CANDIDATE_SCOPE_VERSION
    && candidate.feedDiscoveryCandidate === true
    && [
      CANDIDATE_SOURCE_PURPOSE.FEED_DISCOVERY,
      CANDIDATE_SOURCE_PURPOSE.IDENTITY_ENRICHMENT,
    ].includes(candidate.candidateSourcePurpose as typeof CANDIDATE_SOURCE_PURPOSE.FEED_DISCOVERY);
}

function hasV3ProgramPurpose(candidate: PromotionCandidate): boolean {
  return candidate.candidateSourcePurposeVersion === CANDIDATE_SCOPE_VERSION
    && candidate.programCandidateDiscovered === true
    && [
      CANDIDATE_SOURCE_PURPOSE.PROGRAM_CANDIDATE,
      CANDIDATE_SOURCE_PURPOSE.IDENTITY_ENRICHMENT,
    ].includes(candidate.candidateSourcePurpose as typeof CANDIDATE_SOURCE_PURPOSE.PROGRAM_CANDIDATE);
}

type LegacyFeedPointer = {
  sourceRunId: string;
  sourceRunRef: string;
};

function legacyFeedPointer(candidate: Record<string, unknown>): LegacyFeedPointer | null {
  const nested = [
    recordValue(candidate.legacyFeedProvenance),
    recordValue(candidate.discoveryProvenance),
    recordValue(candidate.candidateProvenance),
  ].find((value) => Object.keys(value).length > 0) ?? {};
  const claimedPurpose = asString(
    nested.candidateSourcePurpose,
    asString(nested.discoveryPurpose, asString(nested.purpose, asString(candidate.candidateSourcePurpose))),
  );
  const explicitlyFeed = claimedPurpose === CANDIDATE_SOURCE_PURPOSE.FEED_DISCOVERY
    || (candidate.feedDiscoveryCandidate === true && claimedPurpose !== CANDIDATE_SOURCE_PURPOSE.PROGRAM_CANDIDATE);
  if (!explicitlyFeed) return null;
  const sourceRunId = asString(nested.sourceRunId, asString(candidate.sourceRunId));
  const sourceRunRef = asString(nested.sourceRunRef, asString(candidate.sourceRunRef));
  if (!sourceRunId || sourceRunRef !== `discovery_runs/${sourceRunId}`) return null;
  return { sourceRunId, sourceRunRef };
}

const PROGRAM_SCOPE_DECLARATION_FIELDS = [
  "canonicalProgramId",
  "programId",
  "programRef",
  "campaignId",
  "sourceCampaignId",
  "campaignRef",
] as const;

function recordHasProgramScope(record: Record<string, unknown>): boolean {
  if (
    record.programCandidateDiscovered === true
    || asString(record.candidateSourcePurpose) === CANDIDATE_SOURCE_PURPOSE.PROGRAM_CANDIDATE
  ) return true;
  if (PROGRAM_SCOPE_DECLARATION_FIELDS.some((field) => Boolean(asString(record[field])))) return true;
  const nestedRecords = [
    record.programScopeEvidence,
    record.scopedContext,
    record.scope,
    record.context,
    record.candidateProvenance,
    record.discoveryProvenance,
    record.legacyFeedProvenance,
  ].map(recordValue);
  if (Object.keys(recordValue(record.programScopeEvidence)).length > 0) return true;
  return nestedRecords.some((nested) => (
    nested.programCandidateDiscovered === true
    || asString(nested.candidateSourcePurpose) === CANDIDATE_SOURCE_PURPOSE.PROGRAM_CANDIDATE
    || Object.keys(recordValue(nested.programScopeEvidence)).length > 0
    || PROGRAM_SCOPE_DECLARATION_FIELDS.some((field) => Boolean(asString(nested[field])))
  ));
}

function snapshotMatchesCandidate(row: Record<string, unknown>, candidateId: string, candidateRef: string): boolean {
  const rowCandidateRef = asString(row.candidateRef);
  const rowCandidateId = asString(row.candidateId, asString(row.id));
  if (rowCandidateRef && rowCandidateRef !== candidateRef) return false;
  if (rowCandidateId && rowCandidateId !== candidateId) return false;
  return rowCandidateRef === candidateRef || rowCandidateId === candidateId;
}

function verifiesLegacyFeedLedger(
  candidateId: string,
  candidate: Record<string, unknown>,
  run: Record<string, unknown> | undefined,
): boolean {
  const pointer = legacyFeedPointer(candidate);
  if (!pointer || recordHasProgramScope(candidate) || !run) return false;
  const storedRunId = asString(run.id, asString(run.runId, pointer.sourceRunId));
  const storedRunRef = asString(run.runRef, pointer.sourceRunRef);
  const status = asString(run.status).toLowerCase();
  if (
    storedRunId !== pointer.sourceRunId
    || storedRunRef !== pointer.sourceRunRef
    || !["complete", "partial"].includes(status)
    || recordHasProgramScope(run)
  ) return false;

  const candidateRef = `candidate_pool/${candidateId}`;
  const candidateSnapshot = Array.isArray(run.candidateSnapshot) ? run.candidateSnapshot : [];
  const matchingSnapshot = candidateSnapshot
    .map(recordValue)
    .find((row) => snapshotMatchesCandidate(row, candidateId, candidateRef));
  if (!matchingSnapshot || recordHasProgramScope(matchingSnapshot)) return false;
  const ledgerPurpose = asString(
    matchingSnapshot.candidateSourcePurpose,
    asString(run.candidateSourcePurpose, asString(run.discoveryPurpose)),
  );
  return ledgerPurpose === CANDIDATE_SOURCE_PURPOSE.FEED_DISCOVERY;
}

function promotionCandidateRows(docs: readonly FirestoreQueryDoc[]): PromotionCandidateRow[] {
  return docs
    .map((doc) => ({ id: doc.id, ref: doc.ref, data: doc.data() ?? {} }))
    .map((row) => ({
      ...row,
      candidate: {
        id: row.id,
        region: row.data.region as string,
        followers: row.data.followers as number,
        matchScore: row.data.matchScore as number,
        viewVelocity: row.data.viewVelocity as number,
        platform: row.data.platform as string,
        type: row.data.type as string,
        category: row.data.category as string,
        promotedToCreator: row.data.promotedToCreator === true,
        candidateSourcePurpose: asString(row.data.candidateSourcePurpose),
        candidateSourcePurposeVersion: asString(row.data.candidateSourcePurposeVersion),
        feedDiscoveryCandidate: row.data.feedDiscoveryCandidate === true,
        programCandidateDiscovered: row.data.programCandidateDiscovered === true,
      } as PromotionCandidate,
    }));
}

function qualityEligiblePromotionRows(
  rows: readonly PromotionCandidateRow[],
  options: Pick<PromoteOptions, "targetCountries" | "minFollowers">,
): PromotionCandidateRow[] {
  return rows.filter((row) => isPromotableCandidate(
    { ...row.candidate, promotedToCreator: false },
    { targetCountries: options.targetCountries, minFollowers: options.minFollowers },
  ));
}

function buildPromotionEvaluation(
  rows: readonly PromotionCandidateRow[],
  participationsByCandidate: ReadonlyMap<string, Array<{ ref: string; data: Record<string, unknown> }>>,
  verifiedLegacyFeedCandidates: ReadonlySet<string>,
): PromotionEvaluation {
  const promotionEvidence = new Map<string, PromotionParticipation[]>();
  const feedPromotionProof = new Map<string, FeedPromotionProof>();
  const decisions = rows.map((row): PromotionDecision => {
    const scopedRows = participationsByCandidate.get(row.id) ?? [];
    const exactParticipations = scopedRows
      .map((participation) => exactPromotionParticipation(row.id, participation.data, participation.ref))
      .filter((value): value is PromotionParticipation => value !== null);
    const approved = exactParticipations.filter((value) => value.approvalMode !== null);
    promotionEvidence.set(row.id, approved);
    let feedProof: FeedPromotionProof | null = null;
    if (hasV3FeedPurpose(row.candidate)) {
      feedProof = "candidate_scope_v3";
    } else if (verifiedLegacyFeedCandidates.has(row.id)) {
      feedProof = "legacy_feed_ledger";
    }
    if (feedProof) feedPromotionProof.set(row.id, feedProof);
    const knownProgram = hasV3ProgramPurpose(row.candidate) || exactParticipations.length > 0;
    const promotable = Boolean(feedProof) || approved.length > 0;
    return {
      row,
      status: promotable ? "promotable" : knownProgram ? "blocked_program" : "quarantine",
    };
  });
  return { decisions, promotionEvidence, feedPromotionProof };
}

function promotionScopeMetadata(
  candidateId: string,
  promotionEvidence: ReadonlyMap<string, PromotionParticipation[]>,
  feedPromotionProof: ReadonlyMap<string, FeedPromotionProof>,
  nowIso: string,
): Record<string, unknown> {
  const approvedParticipations = promotionEvidence.get(candidateId) ?? [];
  const feedPurpose = feedPromotionProof.has(candidateId);
  return {
    promotionSourcePurpose: feedPurpose
      ? CANDIDATE_SOURCE_PURPOSE.FEED_DISCOVERY
      : CANDIDATE_SOURCE_PURPOSE.PROGRAM_CANDIDATE,
    promotionProgramIds: [...new Set(approvedParticipations.map((row) => row.programId))].sort(),
    promotionCampaignIds: [...new Set(approvedParticipations.map((row) => row.campaignId))].sort(),
    promotionParticipationRefs: [...new Set(approvedParticipations.map((row) => row.participationRef))].sort(),
    programStageAuthority: "campaign_candidates",
    promotionFeedProof: feedPromotionProof.get(candidateId) ?? null,
    promotionEvidenceVersion: "creator_promotion_scope_v2",
    updatedAtIso: nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

function isOwnedDiscoveryPromotionCreator(current: Record<string, unknown>, candidateId: string): boolean {
  return asString(current.source) === "discovery-promotion"
    && asString(current.promotedFromCandidate) === candidateId;
}

type PromotionReconciliationCheckpoint = {
  schemaVersion: typeof CREATOR_PROMOTION_RECONCILIATION_VERSION;
  scopeHash: string;
  sourceCollection: typeof CREATOR_PROMOTION_RECONCILIATION_SCOPE.sourceCollection;
  order: typeof CREATOR_PROMOTION_RECONCILIATION_SCOPE.order;
  ownership: typeof CREATOR_PROMOTION_RECONCILIATION_SCOPE.ownership;
  revision: number;
  cycle: number;
  status: "active" | "complete";
  cursor: string | null;
  pageSize: number;
  pagesProcessedInCycle: number;
  startedAtIso: string;
  completedAtIso: string | null;
  updatedAtIso: string;
};

function reconciliationCheckpointDrift(reason: string): Error {
  const error = new Error(`creator_promotion_reconciliation_checkpoint_drift:${reason}`);
  Object.assign(error, { code: "failed-precondition", errorCode: "reconciliation_checkpoint_drift_creator_promotion_reconciliation" });
  return error;
}

function validDocumentCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_500 && !value.includes("/");
}

function parseReconciliationCheckpoint(data: Record<string, unknown>): PromotionReconciliationCheckpoint {
  if (data.schemaVersion !== CREATOR_PROMOTION_RECONCILIATION_VERSION) {
    throw reconciliationCheckpointDrift("schema_version");
  }
  if (data.scopeHash !== CREATOR_PROMOTION_RECONCILIATION_SCOPE_HASH) {
    throw reconciliationCheckpointDrift("scope_hash");
  }
  for (const field of ["sourceCollection", "order", "ownership"] as const) {
    if (data[field] !== CREATOR_PROMOTION_RECONCILIATION_SCOPE[field]) {
      throw reconciliationCheckpointDrift(`scope_${field}`);
    }
  }
  const revision = data.revision;
  const cycle = data.cycle;
  const pageSize = data.pageSize;
  const pagesProcessedInCycle = data.pagesProcessedInCycle;
  const status = data.status;
  const cursor = data.cursor;
  const startedAtIso = asString(data.startedAtIso);
  const completedAtIso = data.completedAtIso === null ? null : asString(data.completedAtIso);
  const updatedAtIso = asString(data.updatedAtIso);
  if (!Number.isInteger(revision) || (revision as number) < 0) throw reconciliationCheckpointDrift("revision");
  if (!Number.isInteger(cycle) || (cycle as number) < 1) throw reconciliationCheckpointDrift("cycle");
  if (!Number.isInteger(pageSize) || (pageSize as number) < 1 || (pageSize as number) > MAX_RECONCILIATION_PAGE_SIZE) {
    throw reconciliationCheckpointDrift("page_size");
  }
  if (!Number.isInteger(pagesProcessedInCycle) || (pagesProcessedInCycle as number) < 0) {
    throw reconciliationCheckpointDrift("pages_processed");
  }
  if (status !== "active" && status !== "complete") throw reconciliationCheckpointDrift("status");
  if (!validIso(startedAtIso) || !validIso(updatedAtIso)) throw reconciliationCheckpointDrift("timestamps");
  if (status === "active") {
    if (cursor !== null && !validDocumentCursor(cursor)) throw reconciliationCheckpointDrift("cursor");
    if (completedAtIso !== null) throw reconciliationCheckpointDrift("active_completion");
  } else if (cursor !== null || !completedAtIso || !validIso(completedAtIso)) {
    throw reconciliationCheckpointDrift("complete_state");
  }
  return {
    schemaVersion: CREATOR_PROMOTION_RECONCILIATION_VERSION,
    scopeHash: CREATOR_PROMOTION_RECONCILIATION_SCOPE_HASH,
    sourceCollection: CREATOR_PROMOTION_RECONCILIATION_SCOPE.sourceCollection,
    order: CREATOR_PROMOTION_RECONCILIATION_SCOPE.order,
    ownership: CREATOR_PROMOTION_RECONCILIATION_SCOPE.ownership,
    revision: revision as number,
    cycle: cycle as number,
    status,
    cursor: cursor as string | null,
    pageSize: pageSize as number,
    pagesProcessedInCycle: pagesProcessedInCycle as number,
    startedAtIso,
    completedAtIso,
    updatedAtIso,
  };
}

function sameCheckpointRevision(left: PromotionReconciliationCheckpoint, right: PromotionReconciliationCheckpoint): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.scopeHash === right.scopeHash
    && left.revision === right.revision
    && left.cycle === right.cycle
    && left.status === right.status
    && left.cursor === right.cursor
    && left.pageSize === right.pageSize
    && left.pagesProcessedInCycle === right.pagesProcessedInCycle;
}

type TransactionalPromotionEvaluation = {
  rows: readonly PromotionCandidateRow[];
  ownedCandidates: number;
  qualityEligible: number;
  fixtureCandidateIds: ReadonlySet<string>;
  qualityEligibleIds: ReadonlySet<string>;
  evaluation: PromotionEvaluation;
  creatorRefs: ReadonlyMap<string, FirestoreDocRef>;
  creatorSnapshots: ReadonlyMap<string, FirestoreDocSnapshot>;
};

async function evaluatePromotionEvidenceInTransaction(
  db: FirestoreDb,
  transaction: FirestoreTransaction,
  rows: readonly PromotionCandidateRow[],
): Promise<PromotionEvaluation> {
  const participationsByCandidate = new Map<string, Array<{ ref: string; data: Record<string, unknown> }>>();
  for (let offset = 0; offset < rows.length; offset += 30) {
    const candidateIds = rows.slice(offset, offset + 30).map((row) => row.id);
    if (candidateIds.length === 0) continue;
    const participationQuery = db.collection("campaign_candidates").where("candidateId", "in", candidateIds);
    const participationSnapshot = await transaction.get(participationQuery);
    collectCandidateParticipations(participationsByCandidate, participationSnapshot.docs, candidateIds);
  }
  const legacyPointers = new Map<string, LegacyFeedPointer>();
  for (const row of rows) {
    const pointer = legacyFeedPointer(row.data);
    if (pointer && !recordHasProgramScope(row.data)) legacyPointers.set(row.id, pointer);
  }
  const runIds = [...new Set([...legacyPointers.values()].map((pointer) => pointer.sourceRunId))];
  const runSnapshots = await Promise.all(runIds.map((runId) => (
    transaction.get(db.collection("discovery_runs").doc(runId))
  )));
  const runsById = new Map(runIds.map((runId, index) => [
    runId,
    runSnapshots[index].exists ? runSnapshots[index].data() : undefined,
  ]));
  const verifiedLegacyFeedCandidates = new Set<string>();
  for (const row of rows) {
    const pointer = legacyPointers.get(row.id);
    if (pointer && verifiesLegacyFeedLedger(row.id, row.data, runsById.get(pointer.sourceRunId))) {
      verifiedLegacyFeedCandidates.add(row.id);
    }
  }
  return buildPromotionEvaluation(rows, participationsByCandidate, verifiedLegacyFeedCandidates);
}

async function evaluatePromotionPageInTransaction(
  db: FirestoreDb,
  transaction: FirestoreTransaction,
  pageDocs: readonly FirestoreQueryDoc[],
  options: Pick<PromoteOptions, "targetCountries" | "minFollowers">,
): Promise<TransactionalPromotionEvaluation> {
  const creatorRefs = new Map(pageDocs.map((doc) => [doc.id, db.collection("creators").doc(doc.id)]));
  const [candidateSnapshots, creatorSnapshotRows] = await Promise.all([
    Promise.all(pageDocs.map((doc) => transaction.get(doc.ref))),
    Promise.all(pageDocs.map((doc) => transaction.get(creatorRefs.get(doc.id)!))),
  ]);
  const authoritativeDocs = pageDocs.flatMap((doc, index): FirestoreQueryDoc[] => {
    const candidateSnapshot = candidateSnapshots[index];
    return candidateSnapshot.exists
      ? [{ id: doc.id, ref: doc.ref, data: () => candidateSnapshot.data() }]
      : [];
  });
  const rows = promotionCandidateRows(authoritativeDocs);
  const creatorSnapshots = new Map(pageDocs.map((doc, index) => [doc.id, creatorSnapshotRows[index]]));
  const owned = rows.filter((row) => {
    const creator = creatorSnapshots.get(row.id);
    return creator?.exists === true && isOwnedDiscoveryPromotionCreator(creator.data() ?? {}, row.id);
  });
  const fixtureCandidateIds = new Set(rows
    .filter((row) => isOperationalFixtureRecord({ ...row.data, id: row.id }, "candidate_pool"))
    .map((row) => row.id));
  const qualityEligible = qualityEligiblePromotionRows(
    rows.filter((row) => !fixtureCandidateIds.has(row.id)),
    options,
  );
  return {
    rows,
    ownedCandidates: owned.length,
    qualityEligible: qualityEligible.length,
    fixtureCandidateIds,
    qualityEligibleIds: new Set(qualityEligible.map((row) => row.id)),
    evaluation: await evaluatePromotionEvidenceInTransaction(db, transaction, qualityEligible),
    creatorRefs,
    creatorSnapshots,
  };
}

async function reconcileDurablePromotionPage(
  db: FirestoreDb,
  options: PromoteOptions,
  nowIso: string,
): Promise<PromotionReconciliationResult> {
  const promotionLimit = Number.isFinite(options.limit)
    ? Math.max(0, Math.min(MAX_PROMOTE_LIMIT, Math.floor(options.limit as number)))
    : DEFAULT_PROMOTE_LIMIT;
  const requestedPageSize = Number.isFinite(options.reconciliationPageSize)
    ? Math.max(1, Math.min(MAX_RECONCILIATION_PAGE_SIZE, Math.floor(options.reconciliationPageSize as number)))
    : DEFAULT_RECONCILIATION_PAGE_SIZE;
  const stateRef = db.collection(CREATOR_PROMOTION_STATE_COLLECTION).doc(CREATOR_PROMOTION_RECONCILIATION_STATE_ID);
  const stateSnapshot = await stateRef.get();
  const expected = stateSnapshot.exists ? parseReconciliationCheckpoint(stateSnapshot.data() ?? {}) : null;
  if (expected?.status === "active" && expected.pageSize !== requestedPageSize) {
    throw reconciliationCheckpointDrift("active_page_size_change");
  }
  const cycle = expected?.status === "complete" ? expected.cycle + 1 : expected?.cycle ?? 1;
  const cursor = expected?.status === "active" ? expected.cursor : null;
  const pageSize = expected?.status === "active" ? expected.pageSize : requestedPageSize;
  const startedAtIso = expected?.status === "active" ? expected.startedAtIso : nowIso;
  const pagesProcessedInCycle = expected?.status === "active" ? expected.pagesProcessedInCycle : 0;

  let query = db.collection("candidate_pool").orderBy(FieldPath.documentId(), "asc").limit(pageSize + 1);
  if (cursor !== null) query = query.startAfter(cursor);
  const snapshot = await query.get();
  const pageDocs = snapshot.docs.slice(0, pageSize);
  const hasMore = snapshot.docs.length > pageSize;
  const nextCursor = hasMore ? pageDocs.at(-1)?.id ?? null : null;
  if (hasMore && !validDocumentCursor(nextCursor)) throw reconciliationCheckpointDrift("next_cursor");
  const nextStatus = hasMore ? "active" as const : "complete" as const;
  const nextCheckpoint: PromotionReconciliationCheckpoint = {
    schemaVersion: CREATOR_PROMOTION_RECONCILIATION_VERSION,
    scopeHash: CREATOR_PROMOTION_RECONCILIATION_SCOPE_HASH,
    sourceCollection: CREATOR_PROMOTION_RECONCILIATION_SCOPE.sourceCollection,
    order: CREATOR_PROMOTION_RECONCILIATION_SCOPE.order,
    ownership: CREATOR_PROMOTION_RECONCILIATION_SCOPE.ownership,
    revision: (expected?.revision ?? 0) + 1,
    cycle,
    status: nextStatus,
    cursor: nextCursor,
    pageSize,
    pagesProcessedInCycle: pagesProcessedInCycle + 1,
    startedAtIso,
    completedAtIso: nextStatus === "complete" ? nowIso : null,
    updatedAtIso: nowIso,
  };
  const reconciled = await db.runTransaction(async (transaction) => {
    const currentSnapshot = await transaction.get(stateRef);
    if (!expected) {
      if (currentSnapshot.exists) throw reconciliationCheckpointDrift("concurrent_initialization");
    } else {
      if (!currentSnapshot.exists) throw reconciliationCheckpointDrift("checkpoint_deleted");
      const current = parseReconciliationCheckpoint(currentSnapshot.data() ?? {});
      if (!sameCheckpointRevision(expected, current)) throw reconciliationCheckpointDrift("concurrent_revision");
    }

    const prepared = await evaluatePromotionPageInTransaction(db, transaction, pageDocs, options);

    // The page is capped at 200 rows, so candidate + creator writes (400)
    // plus the checkpoint (1) remain within Firestore's 500-write limit.
    // Reading every creator before the first write also preserves transaction ordering.
    const decisions = new Map(prepared.evaluation.decisions.map((decision) => [decision.row.id, decision]));
    const newPromotionWinnerIds = new Set(prepared.evaluation.decisions
      .filter((decision) => (
        decision.status === "promotable"
        && prepared.creatorSnapshots.get(decision.row.id)?.exists !== true
      ))
      .sort((left, right) => {
        const scoreDifference = promotionScore(right.row.candidate) - promotionScore(left.row.candidate);
        if (scoreDifference !== 0) return scoreDifference;
        return left.row.id < right.row.id ? -1 : left.row.id > right.row.id ? 1 : 0;
      })
      .slice(0, promotionLimit)
      .map((decision) => decision.row.id));
    const byCountry: Record<string, number> = {};
    let promotable = 0;
    let promoted = 0;
    let skippedExisting = 0;
    let reconciledExisting = 0;
    let blockedKnownProgram = 0;
    let quarantinedUnknown = 0;
    let revokedExisting = 0;
    for (const row of prepared.rows) {
      const creatorRef = prepared.creatorRefs.get(row.id)!;
      const creatorSnapshot = prepared.creatorSnapshots.get(row.id);
      const creatorExists = creatorSnapshot?.exists === true;
      const ownedCreator = creatorExists
        && isOwnedDiscoveryPromotionCreator(creatorSnapshot.data() ?? {}, row.id);
      const fixture = prepared.fixtureCandidateIds.has(row.id);
      const qualityEligible = prepared.qualityEligibleIds.has(row.id);
      const decision = decisions.get(row.id);
      const decisionStatus = fixture
        ? "revoked_fixture" as const
        : !qualityEligible
          ? "revoked_ineligible" as const
          : decision?.status ?? "quarantine";

      if (decisionStatus === "promotable") {
        promotable += 1;
        const feedPurpose = prepared.evaluation.feedPromotionProof.has(row.id);
        if (ownedCreator) {
          const currentCreator = creatorSnapshot.data() ?? {};
          const alreadyAuthorizedFeed = feedPurpose
            && asString(currentCreator.promotionAuthorizationState) === "authorized"
            && asString(currentCreator.promotionFeedProof) === prepared.evaluation.feedPromotionProof.get(row.id);
          transaction.set(creatorRef, {
            ...promotionScopeMetadata(
              row.id,
              prepared.evaluation.promotionEvidence,
              prepared.evaluation.feedPromotionProof,
              nowIso,
            ),
            promotionAuthorizationState: "authorized",
            promotionAuthorizationRevokedAtIso: FieldValue.delete(),
            ...(!feedPurpose
              ? { stage: FieldValue.delete() }
              : alreadyAuthorizedFeed
                ? {}
                : { stage: "contact" }),
          }, { merge: true });
          transaction.set(row.ref, {
            promotedToCreator: true,
            creatorRef: `creators/${row.id}`,
            promotionAuthority: "campaign_candidates_or_feed_purpose",
            promotionEvidenceVersion: "creator_promotion_scope_v2",
            promotionEligibilityStatus: "eligible",
            promotionBlockedReason: "",
            humanMigrationRequired: false,
            promotionEvaluatedAtIso: nowIso,
          }, { merge: true });
          reconciledExisting += 1;
          continue;
        }

        if (creatorExists) {
          transaction.set(row.ref, {
            promotionEligibilityStatus: "eligible",
            promotionBlockedReason: "",
            humanMigrationRequired: false,
            promotionEvidenceVersion: "creator_promotion_scope_v2",
            promotionEvaluatedAtIso: nowIso,
          }, { merge: true });
          skippedExisting += 1;
          continue;
        }

        if (newPromotionWinnerIds.has(row.id)) {
          const data = row.data;
          const country = normalizeCountry(data.region);
          const channelId = asString(data.channelId, /^UC[\w-]{20,}$/.test(row.id) ? row.id : "");
          transaction.set(creatorRef, {
            id: row.id,
            name: asString(data.name, row.id),
            handle: asString(data.handle),
            type: "influencer",
            avatar: asString(data.avatar),
            platform: asString(data.platform, "YouTube"),
            followers: typeof data.followers === "number" ? data.followers : 0,
            region: country || asString(data.region),
            category: asString(data.category, "Casual"),
            stage: feedPurpose ? "contact" : FieldValue.delete(),
            owner: "ai-discovery",
            ...(channelId ? { channelId } : {}),
            ...(asString(data.channelRef) ? { channelRef: asString(data.channelRef) } : {}),
            email: asString(data.email),
            viewVelocity: typeof data.viewVelocity === "number" ? data.viewVelocity : 0,
            adCandidate: true,
            promotedFromCandidate: row.id,
            promotedAtIso: nowIso,
            source: "discovery-promotion",
            team: "flu",
            ...promotionScopeMetadata(
              row.id,
              prepared.evaluation.promotionEvidence,
              prepared.evaluation.feedPromotionProof,
              nowIso,
            ),
            promotionAuthorizationState: "authorized",
            promotionAuthorizationRevokedAtIso: FieldValue.delete(),
          }, { merge: true });
          transaction.set(row.ref, {
            promotedToCreator: true,
            creatorRef: `creators/${row.id}`,
            promotedAtIso: nowIso,
            promotionAuthority: "campaign_candidates_or_feed_purpose",
            promotionEvidenceVersion: "creator_promotion_scope_v2",
            promotionEligibilityStatus: "eligible",
            promotionBlockedReason: "",
            humanMigrationRequired: false,
            promotionEvaluatedAtIso: nowIso,
          }, { merge: true });
          byCountry[country] = (byCountry[country] ?? 0) + 1;
          promoted += 1;
          continue;
        }

        transaction.set(row.ref, {
          promotedToCreator: false,
          creatorRef: FieldValue.delete(),
          promotionAuthority: FieldValue.delete(),
          promotionEvidenceVersion: "creator_promotion_scope_v2",
          promotionEligibilityStatus: "eligible",
          promotionBlockedReason: "promotion_limit_reached",
          humanMigrationRequired: false,
          promotionEvaluatedAtIso: nowIso,
        }, { merge: true });
        continue;
      }

      const blockedProgram = decisionStatus === "blocked_program";
      const quarantine = decisionStatus === "quarantine";
      if (blockedProgram) blockedKnownProgram += 1;
      if (quarantine) quarantinedUnknown += 1;
      transaction.set(row.ref, {
        promotionEligibilityStatus: blockedProgram
          ? "blocked_program_policy"
          : quarantine
            ? "quarantine"
            : decisionStatus,
        promotionBlockedReason: blockedProgram
          ? "program_participation_not_approved"
          : quarantine
            ? "source_purpose_unverified"
            : fixture
              ? "operational_fixture"
              : "quality_ineligible",
        humanMigrationRequired: quarantine,
        promotedToCreator: false,
        creatorRef: FieldValue.delete(),
        promotionAuthority: FieldValue.delete(),
        promotionEvidenceVersion: "creator_promotion_scope_v2",
        promotionEvaluatedAtIso: nowIso,
      }, { merge: true });
      if (ownedCreator) {
        transaction.set(creatorRef, {
          promotionProgramIds: [],
          promotionCampaignIds: [],
          promotionParticipationRefs: [],
          promotionSourcePurpose: FieldValue.delete(),
          promotionFeedProof: FieldValue.delete(),
          programStageAuthority: "campaign_candidates",
          stage: FieldValue.delete(),
          promotionAuthorizationState: blockedProgram ? "blocked_program_policy" : decisionStatus,
          promotionAuthorizationRevokedAtIso: nowIso,
          promotionEvidenceVersion: "creator_promotion_scope_v2",
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        revokedExisting += 1;
      } else if (creatorExists) {
        skippedExisting += 1;
      }
    }
    transaction.set(stateRef, { ...nextCheckpoint, updatedAt: FieldValue.serverTimestamp() }, { merge: false });
    return {
      scanned: prepared.rows.length,
      ownedCandidates: prepared.ownedCandidates,
      qualityEligible: prepared.qualityEligible,
      promotable,
      promoted,
      skippedExisting,
      reconciledExisting,
      blockedKnownProgram,
      quarantinedUnknown,
      revokedExisting,
      byCountry,
    };
  });
  return {
    schemaVersion: nextCheckpoint.schemaVersion,
    scopeHash: nextCheckpoint.scopeHash,
    revision: nextCheckpoint.revision,
    cycle: nextCheckpoint.cycle,
    status: nextCheckpoint.status,
    cursor: nextCheckpoint.cursor,
    pageSize: nextCheckpoint.pageSize,
    ...reconciled,
  };
}

// 문서 ID 커서 페이지 안에서 분류·정산·권한 회수/복구·신규 승격·체크포인트를 원자적으로 처리한다.
export async function promoteCandidatesToCreators(options: PromoteOptions = {}): Promise<PromoteResult> {
  const db = promotionDb(options);
  const nowIso = options.nowIso ?? new Date().toISOString();
  const reconciliation = await reconcileDurablePromotionPage(db, options, nowIso);

  return {
    ok: true,
    scanned: reconciliation.scanned,
    promotable: reconciliation.promotable,
    promoted: reconciliation.promoted,
    skippedExisting: reconciliation.skippedExisting,
    reconciledExisting: reconciliation.reconciledExisting,
    blockedProgramScope: reconciliation.blockedKnownProgram + reconciliation.quarantinedUnknown,
    blockedKnownProgram: reconciliation.blockedKnownProgram,
    quarantinedUnknown: reconciliation.quarantinedUnknown,
    revokedExisting: reconciliation.revokedExisting,
    reconciliation,
    byCountry: reconciliation.byCountry,
  };
}

// 콜러블(수동/admin verify) + 스케줄러가 공유하는 진입점.
export async function promoteDiscoveredCreators(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "creator_promotion.run", WRITE_ROLES);
  const data = asRecord(request.data);
  const limit = typeof data.limit === "number" ? Math.max(1, Math.min(200, data.limit)) : undefined;
  const minFollowers = typeof data.minFollowers === "number" ? Math.max(0, data.minFollowers) : undefined;
  const result = await promoteCandidatesToCreators({ limit, minFollowers });
  return { ...result, behaviorLog: makeBehaviorLog(auth, "creator_promotion.run", "success") };
}
