import { createHash } from "node:crypto";
import type {
  DocumentData,
  Firestore,
  QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { resolveCanonicalProgramId } from "./programCanonical";
import {
  readConfirmedProgramAliasRegistryState,
  readConfirmedProgramAliasRegistryStateInTransaction,
} from "./programAliasRegistry";
import { resolveCampaignOperationalState } from "./campaignControlCore";

export type CampaignPriority = "긴급" | "높음" | "보통";

export type CampaignArbiterConfig = {
  enabled: boolean;
  globalQuota: number;
  leaseSeconds: number;
  agingWindowMinutes: number;
  agingStep: number;
  priorityWeights: Record<CampaignPriority, number>;
  defaultPriority: CampaignPriority;
};

export type CampaignArbiterCandidate = {
  refPath: string;
  campaignId: string;
  programId: string;
  creatorKey: string;
  priority: CampaignPriority;
  operatorPriorityOverride?: CampaignPriority;
  createdAtIso: string;
  sendAfterIso: string;
  deliveryState: string;
  campaignQuota: number;
  campaignUsed: number;
  programQuota: number;
  programUsed: number;
  globalQuota?: number;
  globalUsed?: number;
  contextValid?: boolean;
  campaignActive?: boolean;
  optedOut?: boolean;
  suppressed?: boolean;
  alreadyParticipant?: boolean;
  cooldownUntilIso?: string;
  idempotencyKey?: string;
  aliasRegistryRevision?: string;
  config?: Partial<CampaignArbiterConfig>;
};

export type CampaignArbiterDecision = {
  eligible: boolean;
  reasonCode:
    | "selected"
    | "arbiter_disabled"
    | "not_claimable"
    | "not_due"
    | "campaign_context_missing"
    | "campaign_inactive"
    | "creator_identity_missing"
    | "creator_opted_out"
    | "creator_suppressed"
    | "already_participant"
    | "creator_cooldown_active"
    | "campaign_quota_exhausted"
    | "program_quota_exhausted"
    | "global_quota_exhausted"
    | "creator_contended"
    | "creator_reserved"
    | "reservation_already_sent";
  score: number;
  resolvedPriority: CampaignPriority;
  priorityWeight: number;
  agingBoost: number;
  waitedMinutes: number;
  configHash: string;
  explanation: string;
  winnerCampaignId?: string;
  inventoryPriorityCohort?: string;
  inventoryPriorityReason?: string;
};

export type RankedCampaignArbiterCandidate = {
  candidate: CampaignArbiterCandidate;
  decision: CampaignArbiterDecision;
};

export type CampaignOutreachQueueEntry<T extends QueryDocumentSnapshot<DocumentData> = QueryDocumentSnapshot<DocumentData>> = {
  doc: T;
  candidate: CampaignArbiterCandidate;
  decision: CampaignArbiterDecision;
};

export type CampaignOutreachReservationResult = {
  claimed: boolean;
  idempotent: boolean;
  data: DocumentData | null;
  reservationRef: string;
  decisionRef: string;
  decision: CampaignArbiterDecision;
};

export type CampaignOutreachReservationOutcome = "sent" | "retryable" | "failed" | "blocked";
export type ExistingCampaignReservationDisposition = "new_attempt" | "in_flight" | "recover_expired" | "already_sent";

export type CampaignArbiterProgramScope = {
  campaignId: string;
  programId: string;
  contextValid: boolean;
  reason:
    | "valid"
    | "campaign_context_missing"
    | "campaign_id_mismatch"
    | "campaign_program_missing"
    | "campaign_program_mismatch"
    | "row_program_missing"
    | "row_program_mismatch";
};

export type CampaignArbiterScopedDocumentIds = {
  campaignCounterId: string;
  programCounterId: string;
  globalCounterId: string;
  creatorLeaseId: string;
};

const DEFAULT_CONFIG: CampaignArbiterConfig = {
  enabled: true,
  globalQuota: 0,
  leaseSeconds: 10 * 60,
  agingWindowMinutes: 60,
  agingStep: 10,
  priorityWeights: { "긴급": 300, "높음": 150, "보통": 0 },
  defaultPriority: "보통",
};

const CLAIMABLE_STATES = new Set(["approved", "processing"]);
const TERMINAL_BLOCK_REASONS = new Set<CampaignArbiterDecision["reasonCode"]>([
  "campaign_context_missing",
  "creator_identity_missing",
  "creator_opted_out",
  "creator_suppressed",
  "already_participant",
  "campaign_quota_exhausted",
  "program_quota_exhausted",
  "global_quota_exhausted",
]);

export function isTerminalCampaignArbiterReason(
  reasonCode: CampaignArbiterDecision["reasonCode"],
): boolean {
  return TERMINAL_BLOCK_REASONS.has(reasonCode);
}

export function resolveCampaignArbiterConfig(
  globalValue: unknown = {},
  programValue: unknown = {},
  campaignValue: unknown = {},
): CampaignArbiterConfig {
  const merged = {
    ...asRecord(globalValue),
    ...asRecord(programValue),
    ...asRecord(campaignValue),
  };
  const globalWeights = asRecord(asRecord(globalValue).priorityWeights);
  const programWeights = asRecord(asRecord(programValue).priorityWeights);
  const campaignWeights = asRecord(asRecord(campaignValue).priorityWeights);
  const weights = { ...globalWeights, ...programWeights, ...campaignWeights };
  return {
    enabled: merged.enabled !== false,
    globalQuota: boundedNumber(merged.globalQuota, DEFAULT_CONFIG.globalQuota, 0, 10_000_000),
    leaseSeconds: boundedNumber(merged.leaseSeconds, DEFAULT_CONFIG.leaseSeconds, 30, 3600),
    agingWindowMinutes: boundedNumber(merged.agingWindowMinutes, DEFAULT_CONFIG.agingWindowMinutes, 5, 1440),
    agingStep: boundedNumber(merged.agingStep, DEFAULT_CONFIG.agingStep, 1, 1000),
    priorityWeights: {
      "긴급": boundedNumber(weights["긴급"], DEFAULT_CONFIG.priorityWeights["긴급"], 0, 100_000),
      "높음": boundedNumber(weights["높음"], DEFAULT_CONFIG.priorityWeights["높음"], 0, 100_000),
      "보통": boundedNumber(weights["보통"], DEFAULT_CONFIG.priorityWeights["보통"], 0, 100_000),
    },
    defaultPriority: normalizePriority(merged.defaultPriority, DEFAULT_CONFIG.defaultPriority),
  };
}

export function makeCampaignArbiterDecision(
  candidate: CampaignArbiterCandidate,
  nowIso: string,
  configOverride: Partial<CampaignArbiterConfig> = {},
): CampaignArbiterDecision {
  const config = resolveCampaignArbiterConfig(candidate.config, configOverride);
  const resolvedPriority = normalizePriority(candidate.operatorPriorityOverride, normalizePriority(candidate.priority, config.defaultPriority));
  const dueAtIso = firstIso(candidate.sendAfterIso, candidate.createdAtIso, nowIso);
  const waitedMinutes = Math.max(0, Math.floor((parseIso(nowIso) - parseIso(dueAtIso)) / 60_000));
  const agingBoost = Math.floor(waitedMinutes / config.agingWindowMinutes) * config.agingStep;
  const priorityWeight = config.priorityWeights[resolvedPriority];
  const score = priorityWeight + agingBoost;
  const configHash = stableHash(config);
  const base = { score, resolvedPriority, priorityWeight, agingBoost, waitedMinutes, configHash };

  if (!config.enabled) return blockedDecision(base, "arbiter_disabled", "Campaign arbiter is disabled by resolved settings.");
  if (!CLAIMABLE_STATES.has(candidate.deliveryState)) return blockedDecision(base, "not_claimable", `Outreach state ${candidate.deliveryState || "unknown"} is not claimable.`);
  if (dueAtIso > nowIso) return blockedDecision(base, "not_due", `Outreach is scheduled for ${dueAtIso}.`);
  if (candidate.contextValid === false || !candidate.campaignId || !candidate.programId) return blockedDecision(base, "campaign_context_missing", "Campaign or program context is missing from the reviewed registry.");
  if (!candidate.creatorKey || candidate.creatorKey === "candidate:unknown") return blockedDecision(base, "creator_identity_missing", "Creator identity is insufficient for a safe cross-campaign reservation.");
  if (candidate.campaignActive === false) return blockedDecision(base, "campaign_inactive", "Campaign is outside its active state or window.");
  if (candidate.optedOut === true) return blockedDecision(base, "creator_opted_out", "Creator has an explicit opt-out signal.");
  if (candidate.suppressed === true) return blockedDecision(base, "creator_suppressed", "Creator is suppressed by policy evidence.");
  if (candidate.alreadyParticipant === true) return blockedDecision(base, "already_participant", "Creator is already participating in the program or campaign.");
  if (candidate.cooldownUntilIso && candidate.cooldownUntilIso > nowIso) return blockedDecision(base, "creator_cooldown_active", `Creator cooldown is active until ${candidate.cooldownUntilIso}.`);
  if (candidate.campaignQuota > 0 && candidate.campaignUsed >= candidate.campaignQuota) return blockedDecision(base, "campaign_quota_exhausted", `Campaign quota ${candidate.campaignQuota} is exhausted.`);
  if (candidate.programQuota > 0 && candidate.programUsed >= candidate.programQuota) return blockedDecision(base, "program_quota_exhausted", `Program quota ${candidate.programQuota} is exhausted.`);
  if ((candidate.globalQuota ?? 0) > 0 && (candidate.globalUsed ?? 0) >= (candidate.globalQuota ?? 0)) return blockedDecision(base, "global_quota_exhausted", `Global quota ${candidate.globalQuota} is exhausted.`);

  return {
    eligible: true,
    reasonCode: "selected",
    ...base,
    explanation: `priority=${resolvedPriority} weight=${priorityWeight}; aging=${agingBoost} after ${waitedMinutes}m; deterministic score=${score}`,
  };
}

export function rankCampaignArbiterCandidates(
  candidates: CampaignArbiterCandidate[],
  nowIso: string,
  configOverride: Partial<CampaignArbiterConfig> = {},
): RankedCampaignArbiterCandidate[] {
  const ranked = candidates.map((candidate) => ({
    candidate,
    decision: makeCampaignArbiterDecision(candidate, nowIso, configOverride),
  })).sort(compareRankedCandidates);

  const winnerByCreator = new Map<string, RankedCampaignArbiterCandidate>();
  return ranked.map((entry) => {
    if (!entry.decision.eligible || !entry.candidate.creatorKey) return entry;
    // Creator contact safety is global: the same person cannot win two sends merely
    // because the campaigns belong to different programs.
    const contentionKey = entry.candidate.creatorKey;
    const winner = winnerByCreator.get(contentionKey);
    if (!winner) {
      winnerByCreator.set(contentionKey, entry);
      return entry;
    }
    return {
      candidate: entry.candidate,
      decision: {
        ...entry.decision,
        eligible: false,
        reasonCode: "creator_contended",
        winnerCampaignId: winner.candidate.campaignId,
        explanation: `Creator reservation is awarded to ${winner.candidate.campaignId} by score and deterministic tie-breaker.`,
      },
    };
  });
}

export function reservationIdForCampaignOutreach(candidate: Pick<CampaignArbiterCandidate, "refPath" | "campaignId" | "programId" | "creatorKey" | "idempotencyKey">): string {
  return `car_${stableHash([candidate.programId, candidate.refPath, candidate.campaignId, candidate.creatorKey, candidate.idempotencyKey ?? ""] as unknown as Record<string, unknown>).slice(0, 36)}`;
}

export function resolveCampaignArbiterProgramScope(
  rowValue: unknown,
  campaignValue: unknown,
  aliasMap: Record<string, string> = {},
): CampaignArbiterProgramScope {
  const row = asRecord(rowValue);
  const campaign = asRecord(campaignValue);
  const campaignId = stringValue(row.campaignId);
  if (!campaignId || Object.keys(campaign).length === 0) {
    return { campaignId, programId: "", contextValid: false, reason: "campaign_context_missing" };
  }
  const campaignDocId = stringValue(campaign.id);
  if (campaignDocId && campaignDocId !== campaignId) {
    return { campaignId, programId: "", contextValid: false, reason: "campaign_id_mismatch" };
  }
  const campaignProgramIds = canonicalProgramIds(aliasMap, campaign.canonicalProgramId, campaign.programId);
  if (campaignProgramIds.length === 0) {
    return { campaignId, programId: "", contextValid: false, reason: "campaign_program_missing" };
  }
  const programId = campaignProgramIds[0];
  if (campaignProgramIds.length !== 1) {
    return { campaignId, programId, contextValid: false, reason: "campaign_program_mismatch" };
  }
  const rowProgramIds = canonicalProgramIds(aliasMap, row.canonicalProgramId, row.programId);
  if (rowProgramIds.length === 0) {
    return { campaignId, programId, contextValid: false, reason: "row_program_missing" };
  }
  if (rowProgramIds.some((candidateProgramId) => candidateProgramId !== programId)) {
    return { campaignId, programId, contextValid: false, reason: "row_program_mismatch" };
  }
  return { campaignId, programId, contextValid: true, reason: "valid" };
}

export function campaignArbiterScopedDocumentIds(input: {
  programId: string;
  campaignId: string;
  creatorKey?: string;
  nowIso: string;
  aliasMap?: Record<string, string>;
}): CampaignArbiterScopedDocumentIds {
  const programId = resolveCanonicalProgramId(input.programId, input.aliasMap ?? {});
  const campaignId = stringValue(input.campaignId);
  const creatorKey = stringValue(input.creatorKey);
  return {
    campaignCounterId: `campaign_${stableHash([programId, campaignId] as unknown as Record<string, unknown>).slice(0, 36)}`,
    programCounterId: `program_${stableHash(programId).slice(0, 36)}`,
    globalCounterId: `week_${campaignArbiterWeekKey(input.nowIso).replaceAll("-", "")}`,
    creatorLeaseId: `creator_${stableHash(creatorKey).slice(0, 36)}`,
  };
}

export function campaignArbiterWeekKey(nowIso: string): string {
  const timestamp = Date.parse(nowIso);
  if (!Number.isFinite(timestamp)) throw new Error("invalid-argument: campaign arbiter nowIso must be ISO-8601");
  const date = new Date(timestamp);
  const day = date.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}

export function campaignArbiterConfigHash(config: CampaignArbiterConfig): string {
  return stableHash(config);
}

export function legacyCampaignCompletedUsage(campaign: Record<string, unknown>): number {
  return ["sent", "replied", "negotiating", "contracted", "live"]
    .reduce((total, stage) => total + nonNegativeInteger(campaign[stage]), 0);
}

export function campaignReservationUsage(
  counter: Record<string, unknown>,
  legacyCompleted: unknown,
): number {
  const storedBaseline = counter.baselineCompletedReservations;
  const baseline = typeof storedBaseline === "number" && Number.isFinite(storedBaseline)
    ? nonNegativeInteger(storedBaseline)
    : nonNegativeInteger(legacyCompleted);
  return baseline +
    Math.max(0, numeric(counter.completedReservations)) +
    Math.max(0, numeric(counter.activeReservations));
}

export function existingCampaignReservationDisposition(input: {
  exists: boolean;
  status: string;
  outreachRef: string;
  expectedOutreachRef: string;
  leaseExpiresAtIso: string;
  nowIso: string;
}): ExistingCampaignReservationDisposition {
  if (!input.exists || input.outreachRef !== input.expectedOutreachRef) return "new_attempt";
  if (input.status === "sent") return "already_sent";
  if (input.status !== "selected") return "new_attempt";
  return input.leaseExpiresAtIso > input.nowIso ? "in_flight" : "recover_expired";
}

function campaignInventoryTargetPath(rowValue: unknown): string {
  const row = asRecord(rowValue), programId = stringValue(row.canonicalProgramId) || stringValue(row.programId);
  const targetId = stringValue(row.candidateId) || stringValue(row.creatorId) || stringValue(row.targetId);
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100) || "item";
  return programId && targetId ? `program_campaign_targets/${safe(programId)}__${safe(targetId)}` : "";
}

export function campaignInventoryPriority(targetValue: unknown) {
  const target = asRecord(targetValue);
  if (stringValue(target.status) === "ready") return { rank: 0, cohort: "ready", reason: "w30-f1.ready-hard-bounce=1.25pct" };
  if (stringValue(target.blockedReason) === "mail-quality.w14_pending_verification") return { rank: 2, cohort: "w14_held", reason: "w30-f1.w14-held-hard-bounce=9.60pct" };
  return { rank: 1, cohort: "neutral", reason: "w30-f1.inventory-cohort-unresolved" };
}

export async function loadRankedCampaignOutreachQueue<T extends QueryDocumentSnapshot<DocumentData>>(
  db: Firestore,
  docs: T[],
  nowIso: string,
): Promise<CampaignOutreachQueueEntry<T>[]> {
  if (docs.length === 0) return [];
  const [settingsSnapshot, aliasRegistryState] = await Promise.all([
    db.doc("settings/default").get(),
    readConfirmedProgramAliasRegistryState(),
  ]);
  const aliasMap = aliasRegistryState.aliasMap;
  const settings = settingsSnapshot.data() ?? {};
  const globalConfig = asRecord(settings.campaignArbiter);
  const campaignIds = unique(docs.map((doc) => stringValue(doc.data().campaignId)));
  const campaignSnapshots = campaignIds.length > 0
    ? await db.getAll(...campaignIds.map((id) => db.collection("campaigns").doc(id)))
    : [];
  const campaigns = new Map(campaignSnapshots.map((snapshot) => [snapshot.id, { id: snapshot.id, ...(snapshot.data() ?? {}) }]));
  const scopes = new Map(campaignSnapshots.map((snapshot) => {
    const campaign: DocumentData = { id: snapshot.id, ...(snapshot.data() ?? {}) };
    return [snapshot.id, resolveCampaignArbiterProgramScope({
      campaignId: snapshot.id,
      programId: campaign.programId,
      canonicalProgramId: campaign.canonicalProgramId,
    }, campaign, aliasMap)] as const;
  }));
  const programIds = unique(Array.from(scopes.values()).filter((scope) => scope.contextValid).map((scope) => scope.programId));
  const programSnapshots = programIds.length > 0
    ? await db.getAll(...programIds.map((id) => db.collection("programs").doc(id)), {
        fieldMask: ["campaignArbiter", "campaignQuota"],
      })
    : [];
  const programs = new Map(programSnapshots.map((snapshot) => [snapshot.id, { id: snapshot.id, ...(snapshot.data() ?? {}) }]));
  const scopedIds = campaignIds.map((campaignId) => {
    const scope = scopes.get(campaignId);
    return scope?.contextValid
      ? campaignArbiterScopedDocumentIds({ programId: scope.programId, campaignId, nowIso })
      : null;
  }).filter((value): value is CampaignArbiterScopedDocumentIds => Boolean(value));
  const counterPaths = unique([
    ...scopedIds.map((ids) => `campaign_arbiter_campaign_counters/${ids.campaignCounterId}`),
    ...scopedIds.map((ids) => `campaign_arbiter_program_counters/${ids.programCounterId}`),
    ...scopedIds.map((ids) => `campaign_arbiter_global_counters/${ids.globalCounterId}`),
  ]);
  const counterSnapshots = counterPaths.length > 0 ? await db.getAll(...counterPaths.map((path) => db.doc(path))) : [];
  const counters = new Map(counterSnapshots.map((snapshot) => [snapshot.ref.path, snapshot.data() ?? {}]));
  const targetPathByOutreachPath = new Map(docs.map((doc) => [doc.ref.path, campaignInventoryTargetPath(doc.data())]));
  const targetPaths = unique(Array.from(targetPathByOutreachPath.values()));
  const targetSnapshots = targetPaths.length > 0 ? await db.getAll(...targetPaths.map((path) => db.doc(path)), { fieldMask: ["status", "blockedReason"] }) : [];
  const priorityByTargetPath = new Map(targetSnapshots.map((snapshot) => [snapshot.ref.path, campaignInventoryPriority(snapshot.data())]));

  const candidates = docs.map((doc) => {
    const row = doc.data() ?? {};
    const campaignId = stringValue(row.campaignId);
    const campaign: DocumentData = campaigns.get(campaignId) ?? {};
    const scope = resolveCampaignArbiterProgramScope(row, campaign, aliasMap);
    const programId = scope.programId;
    const program: DocumentData = programs.get(programId) ?? {};
    const ids = campaignArbiterScopedDocumentIds({ programId, campaignId, nowIso, aliasMap });
    const campaignCounter = counters.get(`campaign_arbiter_campaign_counters/${ids.campaignCounterId}`) ?? {};
    const programCounter = counters.get(`campaign_arbiter_program_counters/${ids.programCounterId}`) ?? {};
    const globalCounter = counters.get(`campaign_arbiter_global_counters/${ids.globalCounterId}`) ?? {};
    const config = resolveCampaignArbiterConfig(globalConfig, asRecord(program.campaignArbiter), asRecord(campaign.campaignArbiter));
    return candidateFromDocuments(
      doc.ref.path,
      row,
      campaign,
      program,
      campaignCounter,
      programCounter,
      globalCounter,
      config,
      nowIso,
      aliasMap,
      aliasRegistryState.revision,
    );
  });
  const ranked = rankCampaignArbiterCandidates(candidates, nowIso);
  const docByPath = new Map(docs.map((doc) => [doc.ref.path, doc]));
  return ranked.map((entry) => {
    const priority = priorityByTargetPath.get(targetPathByOutreachPath.get(entry.candidate.refPath) ?? "") ?? campaignInventoryPriority({});
    return { ...entry, inventoryRank: priority.rank, decision: { ...entry.decision, inventoryPriorityCohort: priority.cohort, inventoryPriorityReason: priority.reason }, doc: docByPath.get(entry.candidate.refPath)! };
  }).sort((left, right) => left.inventoryRank - right.inventoryRank).map(({ inventoryRank: _inventoryRank, ...entry }) => entry);
}

export async function reserveCampaignOutreachForProcessing(
  db: Firestore,
  refPath: string,
  nowIso: string,
  expectedDecision?: CampaignArbiterDecision,
): Promise<CampaignOutreachReservationResult> {
  const rowRef = db.doc(refPath);
  return db.runTransaction(async (transaction) => {
    const rowSnapshot = await transaction.get(rowRef);
    if (!rowSnapshot.exists) return emptyReservationResult("not_claimable", refPath, nowIso);
    const row = rowSnapshot.data() ?? {};
    const aliasRegistryState = await readConfirmedProgramAliasRegistryStateInTransaction(transaction);
    const aliasMap = aliasRegistryState.aliasMap;
    const campaignId = stringValue(row.campaignId);
    const campaignRef = db.collection("campaigns").doc(campaignId || "missing");
    const settingsRef = db.doc("settings/default");
    const [campaignSnapshot, settingsSnapshot] = await Promise.all([
      transaction.get(campaignRef),
      transaction.get(settingsRef),
    ]);
    const campaign: DocumentData = campaignSnapshot.exists ? { id: campaignSnapshot.id, ...(campaignSnapshot.data() ?? {}) } : {};
    if (resolveCampaignOperationalState(campaign) !== "active") {
      return emptyReservationResult("not_claimable", refPath, nowIso);
    }
    const scope = resolveCampaignArbiterProgramScope(row, campaign, aliasMap);
    const programId = scope.programId;
    const programRef = db.collection("programs").doc(programId || "missing");
    const [programSnapshot] = await transaction.getAll(programRef, {
      fieldMask: ["campaignArbiter", "campaignQuota"],
    });
    const program: DocumentData = programSnapshot.exists ? { id: programSnapshot.id, ...(programSnapshot.data() ?? {}) } : {};
    const creatorKey = creatorKeyForRow(row);
    const candidateSeed = candidateFromDocuments(
      refPath,
      row,
      campaign,
      program,
      {},
      {},
      {},
      resolveCampaignArbiterConfig(asRecord(settingsSnapshot.data()?.campaignArbiter), asRecord(program.campaignArbiter), asRecord(campaign.campaignArbiter)),
      nowIso,
      aliasMap,
      aliasRegistryState.revision,
    );
    const reservationId = reservationIdForCampaignOutreach(candidateSeed);
    const reservationRef = db.collection("campaign_outreach_reservations").doc(reservationId);
    const currentScopedIds = campaignArbiterScopedDocumentIds({ programId, campaignId, creatorKey, nowIso, aliasMap });
    const reservationSnapshot = await transaction.get(reservationRef);
    const existingReservation = reservationSnapshot.data() ?? {};
    const reservationDisposition = existingCampaignReservationDisposition({
      exists: reservationSnapshot.exists,
      status: stringValue(existingReservation.status),
      outreachRef: stringValue(existingReservation.outreachRef),
      expectedOutreachRef: refPath,
      leaseExpiresAtIso: stringValue(existingReservation.leaseExpiresAtIso),
      nowIso,
    });
    const scopedIds = {
      ...currentScopedIds,
      globalCounterId: reservationDisposition === "new_attempt"
        ? currentScopedIds.globalCounterId
        : stringValue(existingReservation.globalCounterId) || currentScopedIds.globalCounterId,
      creatorLeaseId: reservationDisposition === "new_attempt"
        ? currentScopedIds.creatorLeaseId
        : stringValue(existingReservation.creatorLeaseId) || currentScopedIds.creatorLeaseId,
    };
    const leaseRef = db.collection("campaign_creator_leases").doc(scopedIds.creatorLeaseId);
    const campaignCounterRef = db.collection("campaign_arbiter_campaign_counters").doc(scopedIds.campaignCounterId);
    const programCounterRef = db.collection("campaign_arbiter_program_counters").doc(scopedIds.programCounterId);
    const globalCounterRef = db.collection("campaign_arbiter_global_counters").doc(scopedIds.globalCounterId);
    const [leaseSnapshot, campaignCounterSnapshot, programCounterSnapshot, globalCounterSnapshot] = await Promise.all([
      transaction.get(leaseRef),
      transaction.get(campaignCounterRef),
      transaction.get(programCounterRef),
      transaction.get(globalCounterRef),
    ]);
    const campaignCounter = campaignCounterSnapshot.data() ?? {};
    const programCounter = programCounterSnapshot.data() ?? {};
    const globalCounter = globalCounterSnapshot.data() ?? {};
    let candidate = candidateFromDocuments(
      refPath,
      row,
      campaign,
      program,
      campaignCounter,
      programCounter,
      globalCounter,
      candidateSeed.config ?? {},
      nowIso,
      aliasMap,
      aliasRegistryState.revision,
    );
    const existingStatus = stringValue(existingReservation.status);
    const existingLease = leaseSnapshot.data() ?? {};
    const leaseActive = stringValue(existingLease.expiresAtIso) > nowIso;
    const existingDisposition = existingCampaignReservationDisposition({
      exists: reservationSnapshot.exists,
      status: existingStatus,
      outreachRef: stringValue(existingReservation.outreachRef),
      expectedOutreachRef: refPath,
      leaseExpiresAtIso: stringValue(existingReservation.leaseExpiresAtIso),
      nowIso,
    });
    // An expired reservation is already represented in each active counter. Exclude that
    // one slot while deciding whether the same deterministic attempt may recover; otherwise
    // a cap of 1 would permanently prevent its own crash recovery.
    if (existingDisposition === "recover_expired") {
      candidate = {
        ...candidate,
        campaignUsed: Math.max(0, candidate.campaignUsed - 1),
        programUsed: Math.max(0, candidate.programUsed - 1),
        globalUsed: Math.max(0, (candidate.globalUsed ?? 0) - 1),
      };
    }
    let decision = makeCampaignArbiterDecision(candidate, nowIso);
    if (expectedDecision?.inventoryPriorityCohort) decision = { ...decision,
      inventoryPriorityCohort: expectedDecision.inventoryPriorityCohort,
      inventoryPriorityReason: expectedDecision.inventoryPriorityReason,
    };
    if (expectedDecision?.reasonCode === "creator_contended") decision = {
      ...decision,
      eligible: false,
      reasonCode: "creator_contended",
      winnerCampaignId: expectedDecision.winnerCampaignId,
      explanation: expectedDecision.explanation,
    };
    const decisionId = `cad_${stableHash([reservationId, nowIso, decision.reasonCode] as unknown as Record<string, unknown>).slice(0, 36)}`;
    const decisionRef = db.collection("campaign_arbiter_decisions").doc(decisionId);

    if (existingDisposition === "already_sent") {
      decision = {
        ...decision,
        eligible: false,
        reasonCode: "reservation_already_sent",
        explanation: "The deterministic outreach reservation is already finalized as sent.",
      };
      transaction.set(rowRef, {
        deliveryState: "sent",
        status: "sent",
        arbiterDecisionRef: decisionRef.path,
        arbiterReasonCode: decision.reasonCode,
        arbiterCheckedAtIso: nowIso,
      }, { merge: true });
      transaction.set(decisionRef, decisionAudit(decisionId, reservationId, refPath, candidate, decision, nowIso, true), { merge: false });
      return { claimed: false, idempotent: true, data: null, reservationRef: reservationRef.path, decisionRef: decisionRef.path, decision };
    }

    if (existingDisposition === "in_flight") {
      decision = {
        ...decision,
        eligible: false,
        reasonCode: "creator_reserved",
        explanation: "This deterministic outreach reservation is already in flight under a non-expired lease.",
      };
      transaction.set(decisionRef, decisionAudit(decisionId, reservationId, refPath, candidate, decision, nowIso, true), { merge: false });
      return { claimed: false, idempotent: true, data: null, reservationRef: reservationRef.path, decisionRef: decisionRef.path, decision };
    }

    if (existingDisposition === "recover_expired" && decision.eligible) {
      const leaseExpiresAtIso = new Date(parseIso(nowIso) + resolveCampaignArbiterConfig(candidate.config).leaseSeconds * 1000).toISOString();
      transaction.set(rowRef, processingPatch(nowIso, leaseExpiresAtIso, reservationRef.path, decision), { merge: true });
      transaction.set(leaseRef, leasePatch(reservationId, refPath, campaignId, programId, nowIso, leaseExpiresAtIso), { merge: true });
      transaction.set(reservationRef, {
        status: "selected",
        selectedAtIso: nowIso,
        leaseExpiresAtIso,
        decisionRef: decisionRef.path,
        configHash: decision.configHash,
        aliasRegistryRevision: aliasRegistryState.revision,
        campaignCounterId: scopedIds.campaignCounterId,
        programCounterId: scopedIds.programCounterId,
        attempt: numeric(existingReservation.attempt) + 1,
        updatedAtIso: nowIso,
      }, { merge: true });
      transaction.set(decisionRef, decisionAudit(decisionId, reservationId, refPath, candidate, decision, nowIso, true), { merge: false });
      return { claimed: true, idempotent: true, data: row, reservationRef: reservationRef.path, decisionRef: decisionRef.path, decision };
    }

    if (leaseActive && stringValue(existingLease.reservationId) !== reservationId) {
      decision = {
        ...decision,
        eligible: false,
        reasonCode: "creator_reserved",
        explanation: "A non-expired creator lease is owned by another outreach reservation.",
      };
    }

    if (!decision.eligible) {
      const patch: DocumentData = {
        arbiterDecisionRef: decisionRef.path,
        arbiterReasonCode: decision.reasonCode,
        arbiterConfigHash: decision.configHash,
        arbiterCheckedAtIso: nowIso,
      };
      if (decision.reasonCode === "creator_cooldown_active" && candidate.cooldownUntilIso) patch.sendAfterIso = candidate.cooldownUntilIso;
      if (isTerminalCampaignArbiterReason(decision.reasonCode)) Object.assign(patch, {
        deliveryState: "blocked",
        status: "blocked",
        humanGate: "blocked",
        blockedReason: `campaign_arbiter_${decision.reasonCode}`,
        blockedAtIso: nowIso,
      });
      if (existingDisposition === "recover_expired") {
        const staleOutcome = isTerminalCampaignArbiterReason(decision.reasonCode) ? "blocked" : "retryable";
        transaction.set(reservationRef, {
          status: staleOutcome,
          finalizedAtIso: nowIso,
          leaseExpiresAtIso: nowIso,
          updatedAtIso: nowIso,
        }, { merge: true });
        transaction.set(campaignCounterRef, finalizedCounter(campaignCounter, 0, nowIso), { merge: true });
        transaction.set(programCounterRef, finalizedCounter(programCounter, 0, nowIso), { merge: true });
        transaction.set(globalCounterRef, finalizedCounter(globalCounter, 0, nowIso), { merge: true });
        transaction.set(leaseRef, { expiresAtIso: nowIso, releasedAtIso: nowIso, outcome: staleOutcome, updatedAtIso: nowIso }, { merge: true });
      }
      transaction.set(rowRef, patch, { merge: true });
      transaction.set(decisionRef, decisionAudit(decisionId, reservationId, refPath, candidate, decision, nowIso, false), { merge: false });
      return { claimed: false, idempotent: false, data: null, reservationRef: reservationRef.path, decisionRef: decisionRef.path, decision };
    }

    const leaseExpiresAtIso = new Date(parseIso(nowIso) + resolveCampaignArbiterConfig(candidate.config).leaseSeconds * 1000).toISOString();
    transaction.set(rowRef, processingPatch(nowIso, leaseExpiresAtIso, reservationRef.path, decision), { merge: true });
    transaction.set(leaseRef, leasePatch(reservationId, refPath, campaignId, programId, nowIso, leaseExpiresAtIso), { merge: true });
    transaction.set(reservationRef, {
      id: reservationId,
      outreachRef: refPath,
      campaignId,
      programId,
      canonicalProgramId: programId,
      aliasRegistryRevision: aliasRegistryState.revision,
      creatorKeyHash: stableHash(creatorKey),
      creatorKey,
      creatorLeaseId: scopedIds.creatorLeaseId,
      globalCounterId: scopedIds.globalCounterId,
      campaignCounterId: scopedIds.campaignCounterId,
      programCounterId: scopedIds.programCounterId,
      status: "selected",
      selectedAtIso: nowIso,
      leaseExpiresAtIso,
      decisionRef: decisionRef.path,
      configHash: decision.configHash,
      idempotencyKeyHash: stableHash(candidate.idempotencyKey ?? refPath),
      attempt: numeric(existingReservation.attempt) + 1,
      updatedAtIso: nowIso,
    }, { merge: true });
    transaction.set(
      campaignCounterRef,
      incrementedCounter(campaignCounter, campaignId, nowIso, legacyCampaignCompletedUsage(campaign)),
      { merge: true },
    );
    transaction.set(programCounterRef, incrementedCounter(programCounter, programId, nowIso), { merge: true });
    transaction.set(globalCounterRef, incrementedCounter(globalCounter, "default", nowIso), { merge: true });
    transaction.set(decisionRef, decisionAudit(decisionId, reservationId, refPath, candidate, decision, nowIso, false), { merge: false });
    return { claimed: true, idempotent: false, data: row, reservationRef: reservationRef.path, decisionRef: decisionRef.path, decision };
  });
}

export async function finalizeCampaignOutreachReservation(
  db: Firestore,
  reservationPath: string,
  outcome: CampaignOutreachReservationOutcome,
  nowIso: string,
): Promise<void> {
  if (!reservationPath) return;
  const reservationRef = db.doc(reservationPath);
  await db.runTransaction(async (transaction) => {
    const reservationSnapshot = await transaction.get(reservationRef);
    if (!reservationSnapshot.exists) return;
    const reservation = reservationSnapshot.data() ?? {};
    if (stringValue(reservation.status) !== "selected") return;
    const campaignId = stringValue(reservation.campaignId);
    const programId = resolveCanonicalProgramId(reservation.canonicalProgramId ?? reservation.programId);
    if (!campaignId || !programId) return;
    const scopedIds = campaignArbiterScopedDocumentIds({
      programId,
      campaignId,
      creatorKey: stringValue(reservation.creatorKey),
      nowIso,
    });
    const campaignCounterRef = db.collection("campaign_arbiter_campaign_counters").doc(scopedIds.campaignCounterId);
    const programCounterRef = db.collection("campaign_arbiter_program_counters").doc(scopedIds.programCounterId);
    const globalCounterRef = db.collection("campaign_arbiter_global_counters").doc(
      stringValue(reservation.globalCounterId) || scopedIds.globalCounterId,
    );
    const storedLeaseId = stringValue(reservation.creatorLeaseId);
    const leaseRef = db.collection("campaign_creator_leases").doc(storedLeaseId || scopedIds.creatorLeaseId);
    const [campaignCounterSnapshot, programCounterSnapshot, globalCounterSnapshot, leaseSnapshot] = await Promise.all([
      transaction.get(campaignCounterRef),
      transaction.get(programCounterRef),
      transaction.get(globalCounterRef),
      transaction.get(leaseRef),
    ]);
    const completedDelta = outcome === "sent" ? 1 : 0;
    transaction.set(reservationRef, {
      status: outcome,
      finalizedAtIso: nowIso,
      leaseExpiresAtIso: nowIso,
      updatedAtIso: nowIso,
    }, { merge: true });
    transaction.set(campaignCounterRef, finalizedCounter(campaignCounterSnapshot.data() ?? {}, completedDelta, nowIso), { merge: true });
    transaction.set(programCounterRef, finalizedCounter(programCounterSnapshot.data() ?? {}, completedDelta, nowIso), { merge: true });
    transaction.set(globalCounterRef, finalizedCounter(globalCounterSnapshot.data() ?? {}, completedDelta, nowIso), { merge: true });
    if (stringValue(leaseSnapshot.data()?.reservationId) === reservationSnapshot.id) {
      transaction.set(leaseRef, { expiresAtIso: nowIso, releasedAtIso: nowIso, outcome, updatedAtIso: nowIso }, { merge: true });
    }
  });
}

function candidateFromDocuments(
  refPath: string,
  row: DocumentData,
  campaign: DocumentData,
  program: DocumentData,
  campaignCounter: DocumentData,
  programCounter: DocumentData,
  globalCounter: DocumentData,
  config: Partial<CampaignArbiterConfig>,
  nowIso: string,
  aliasMap: Record<string, string> = {},
  aliasRegistryRevision = "",
): CampaignArbiterCandidate {
  const scope = resolveCampaignArbiterProgramScope(row, campaign, aliasMap);
  const campaignId = scope.campaignId;
  const programId = scope.programId;
  const campaignQuota = firstPositive(campaign.campaignQuota, campaign.quota, asRecord(campaign.campaignArbiter).quota, campaign.targetN);
  const programQuota = firstPositive(asRecord(program.campaignArbiter).quota, program.campaignQuota);
  const globalQuota = resolveCampaignArbiterConfig(config).globalQuota;
  const programCompleted = numeric(programCounter.completedReservations);
  const globalCompleted = numeric(globalCounter.completedReservations);
  const status = stringValue(campaign.status).toLowerCase();
  const activeStatuses = new Set(["", "active", "open", "running", "발송중", "대기", "탐색중"]);
  const startsAtIso = firstIso(stringValue(campaign.startsAtIso), stringValue(campaign.startAtIso), "");
  const endsAtIso = firstIso(stringValue(campaign.endsAtIso), stringValue(campaign.endAtIso), "");
  const campaignActive = activeStatuses.has(status)
    && (!startsAtIso || startsAtIso <= nowIso)
    && (!endsAtIso || endsAtIso >= nowIso);
  return {
    refPath,
    campaignId,
    programId,
    creatorKey: creatorKeyForRow(row),
    priority: normalizePriority(campaign.priority, normalizePriority(asRecord(program.campaignArbiter).priority, resolveCampaignArbiterConfig(config).defaultPriority)),
    operatorPriorityOverride: normalizeOptionalPriority(campaign.operatorPriorityOverride ?? asRecord(campaign.campaignArbiter).priorityOverride ?? row.operatorPriorityOverride),
    createdAtIso: firstIso(stringValue(row.createdAtIso), stringValue(row.queuedAtIso), nowIso),
    sendAfterIso: firstIso(stringValue(row.sendAfterIso), stringValue(row.createdAtIso), nowIso),
    deliveryState: stringValue(row.deliveryState) || stringValue(row.status),
    campaignQuota,
    campaignUsed: campaignReservationUsage(campaignCounter, legacyCampaignCompletedUsage(campaign)),
    programQuota,
    programUsed: programCompleted + numeric(programCounter.activeReservations),
    globalQuota,
    globalUsed: globalCompleted + numeric(globalCounter.activeReservations),
    contextValid: Boolean(
      scope.contextValid &&
      Object.keys(program).length > 0
    ),
    campaignActive,
    optedOut: row.optedOut === true || row.unsubscribed === true || stringValue(row.consentStatus) === "opted_out",
    suppressed: row.suppressed === true || row.blacklisted === true,
    alreadyParticipant: row.alreadyParticipant === true || row.participant === true,
    cooldownUntilIso: stringValue(row.cooldownUntilIso) || stringValue(row.nextContactAtIso),
    idempotencyKey: stringValue(row.idempotencyKey) || stringValue(row.trackingId) || refPath,
    aliasRegistryRevision,
    config,
  };
}

function compareRankedCandidates(left: RankedCampaignArbiterCandidate, right: RankedCampaignArbiterCandidate): number {
  if (left.decision.eligible !== right.decision.eligible) return left.decision.eligible ? -1 : 1;
  if (left.decision.score !== right.decision.score) return right.decision.score - left.decision.score;
  if (left.decision.waitedMinutes !== right.decision.waitedMinutes) return right.decision.waitedMinutes - left.decision.waitedMinutes;
  const campaignOrder = left.candidate.campaignId.localeCompare(right.candidate.campaignId, "en");
  return campaignOrder || left.candidate.refPath.localeCompare(right.candidate.refPath, "en");
}

function blockedDecision(
  base: Pick<CampaignArbiterDecision, "score" | "resolvedPriority" | "priorityWeight" | "agingBoost" | "waitedMinutes" | "configHash">,
  reasonCode: Exclude<CampaignArbiterDecision["reasonCode"], "selected" | "creator_contended" | "creator_reserved" | "reservation_already_sent">,
  explanation: string,
): CampaignArbiterDecision {
  return { eligible: false, reasonCode, ...base, explanation };
}

function processingPatch(nowIso: string, leaseExpiresAtIso: string, reservationRef: string, decision: CampaignArbiterDecision): DocumentData {
  return {
    deliveryState: "processing",
    status: "processing",
    processingStartedAtIso: nowIso,
    processingLeaseExpiresAtIso: leaseExpiresAtIso,
    arbiterReservationRef: reservationRef,
    arbiterReasonCode: decision.reasonCode,
    arbiterScore: decision.score,
    arbiterConfigHash: decision.configHash,
    arbiterExplanation: decision.explanation,
    inventoryPriorityCohort: decision.inventoryPriorityCohort ?? "neutral",
    inventoryPriorityReason: decision.inventoryPriorityReason ?? "w30-f1.inventory-cohort-unresolved",
    updatedAtIso: nowIso,
  };
}

function leasePatch(reservationId: string, refPath: string, campaignId: string, programId: string, nowIso: string, expiresAtIso: string): DocumentData {
  return { reservationId, outreachRef: refPath, campaignId, programId, acquiredAtIso: nowIso, expiresAtIso, updatedAtIso: nowIso };
}

function decisionAudit(
  id: string,
  reservationId: string,
  refPath: string,
  candidate: CampaignArbiterCandidate,
  decision: CampaignArbiterDecision,
  nowIso: string,
  idempotent: boolean,
): DocumentData {
  return {
    id,
    reservationId,
    outreachRef: refPath,
    campaignId: candidate.campaignId,
    programId: candidate.programId,
    aliasRegistryRevision: candidate.aliasRegistryRevision ?? "",
    creatorKeyHash: stableHash(candidate.creatorKey),
    eligible: decision.eligible,
    reasonCode: decision.reasonCode,
    score: decision.score,
    resolvedPriority: decision.resolvedPriority,
    priorityWeight: decision.priorityWeight,
    agingBoost: decision.agingBoost,
    waitedMinutes: decision.waitedMinutes,
    configHash: decision.configHash,
    explanation: decision.explanation,
    winnerCampaignId: decision.winnerCampaignId ?? "",
    idempotent,
    createdAtIso: nowIso,
  };
}

function incrementedCounter(
  current: DocumentData,
  scopeId: string,
  nowIso: string,
  legacyCompleted = 0,
): DocumentData {
  const storedBaseline = current.baselineCompletedReservations;
  const baselineCompletedReservations = typeof storedBaseline === "number" && Number.isFinite(storedBaseline)
    ? nonNegativeInteger(storedBaseline)
    : nonNegativeInteger(legacyCompleted);
  return {
    scopeId,
    baselineCompletedReservations,
    activeReservations: numeric(current.activeReservations) + 1,
    completedReservations: numeric(current.completedReservations),
    totalReservationAttempts: numeric(current.totalReservationAttempts) + 1,
    updatedAtIso: nowIso,
  };
}

function finalizedCounter(current: DocumentData, completedDelta: number, nowIso: string): DocumentData {
  return {
    activeReservations: Math.max(0, numeric(current.activeReservations) - 1),
    completedReservations: numeric(current.completedReservations) + completedDelta,
    updatedAtIso: nowIso,
  };
}

function emptyReservationResult(reasonCode: "not_claimable", refPath: string, nowIso: string): CampaignOutreachReservationResult {
  const candidate: CampaignArbiterCandidate = {
    refPath,
    campaignId: "",
    programId: "",
    creatorKey: "",
    priority: "보통",
    createdAtIso: nowIso,
    sendAfterIso: nowIso,
    deliveryState: "",
    campaignQuota: 0,
    campaignUsed: 0,
    programQuota: 0,
    programUsed: 0,
  };
  const decision = makeCampaignArbiterDecision(candidate, nowIso);
  return { claimed: false, idempotent: false, data: null, reservationRef: "", decisionRef: "", decision: { ...decision, reasonCode } };
}

function creatorKeyForRow(row: DocumentData): string {
  const creatorId = stringValue(row.creatorId);
  if (creatorId) return `creator:${creatorId}`;
  const email = stringValue(row.creatorEmail || row.targetEmail || row.to).toLowerCase();
  if (email) return `email:${stableHash(email)}`;
  return `candidate:${stringValue(row.targetId || row.candidateId || row.id) || "unknown"}`;
}

function normalizePriority(value: unknown, fallback: CampaignPriority): CampaignPriority {
  return value === "긴급" || value === "높음" || value === "보통" ? value : fallback;
}

function normalizeOptionalPriority(value: unknown): CampaignPriority | undefined {
  return value === "긴급" || value === "높음" || value === "보통" ? value : undefined;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

function firstPositive(...values: unknown[]): number {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
  }
  return 0;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nonNegativeInteger(value: unknown): number {
  return Math.max(0, Math.floor(numeric(value)));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 240) : "";
}

function firstIso(...values: string[]): string {
  for (const value of values) if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return "";
}

function parseIso(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function canonicalProgramIds(aliasMap: Record<string, string>, ...values: unknown[]): string[] {
  return unique(values.map((value) => resolveCanonicalProgramId(value, aliasMap)));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
