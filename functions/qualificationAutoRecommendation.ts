// SCP qualification scheduler: automatic recommendation with settings-gated finalization.
//
// Periodically scans program_sheet_leads for pending leads (qualificationStatus ===
// "unreviewed") that have never been judged (no latestAiRecommendation yet) and runs
// them through the existing Judge A pipeline (qualificationJudgeService.runQualificationJudge)
// as a scheduler-managed run. Judge A owns the authoritative gate decision: defaults,
// human_assist, required gates, and invalid/missing backtests remain recommendation-only;
// only autoPilotEnabled + auto_ai + gate:off + a valid qualification backtest may finalize
// pass/fail and invoke the existing idempotent downstream engines. The scheduler never
// derives or bypasses those gates itself.
//
// Mirrors the drain-style pattern used by videoReviewAutomationOutbox.ts (bounded scan,
// drain cap 10/25, plain exported core function + admin-gated callable wrapper + a
// separate onSchedule caller). Canonical Sheet2 work uses a short lease and a completed
// source-input hash on the lead document instead of a separate outbox collection.
import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { asRecord, assertNonGuestAuth, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { assertScpEntitled } from "./mailAccounts";
import {
  materializeCanonicalSheet2QualificationRows,
  resolveLegacyScpQualificationPolicyHash,
  runQualificationJudge,
  type CanonicalSheet2QualificationCandidate,
  type CanonicalSheet2QualificationReadRange,
  type QualificationJudgeLeadResult,
  type QualificationSheet2Reader,
} from "./qualificationJudgeService";
import { resolveCanonicalProgramId, SCP_CANONICAL_PROGRAM_ID } from "./programCanonical";
import {
  MAX_SCP_SHEET_ROWS,
  SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID,
  SCP_QUALIFICATION_REVIEW_TAB_NAME,
} from "./scpSheetReviewService";
import { sourceIdForGoogleSheet } from "./sheetIntakeService";
import {
  QUALIFICATION_BOUNDARY_ERROR_CODES,
  qualificationBoundaryError,
  type QualificationBoundaryError,
} from "./qualificationPrivacy";

const ADMIN_ROLES = ["super_admin", "admin"] as const;
const DEFAULT_DRAIN_LIMIT = 10;
const MAX_DRAIN_LIMIT = 25;
// Bounded Firestore scan before in-memory filtering for a missing latestAiRecommendation
// (mirrors backfillVideoReviewAutomationOutbox's BACKFILL_SCAN_LIMIT=500 pattern) — a
// single equality query (qualificationStatus == "unreviewed") needs no composite index.
const SCAN_LIMIT = 500;
const SERVICE_ACTOR = "qualification-auto-recommendation-scheduler";
// PB-4 서킷브레이커 (Opus MAJOR-1): 예외로 실패하는 리드는 latestAiRecommendation을 절대 남기지
// 않으므로 매 tick 다시 선별된다 — 매분 무인 실모델(멀티모달 언어게이트 포함) 재시도가 무한
// 반복되는 비용 폭주 경로다. 연속 실패 N회를 초과하면 선별에서 제외(격리)하고 알림 doc을 남긴다.
// 추천이 한 번이라도 성공하면 카운터는 리셋된다(일시 오류가 영구 격리로 굳지 않도록).
const MAX_AUTO_ATTEMPTS = 3;
const AUTO_ALERT_COLLECTION = "scp_qualification_auto_alerts";
const AUTO_RECOMMENDATION_LEASE_MS = 15 * 60 * 1_000;
const AUTO_STATE_COLLECTION = "scp_qualification_auto_state";
const CANONICAL_SHEET2_POLL_STATE_ID = "canonical_sheet2_poll";
const CANONICAL_SHEET2_MAX_ROW = 100_000;
const COLD_HIGH_WATER_PAGE_SIZE = 100;
const COLD_HIGH_WATER_MAX_PAGES = 5;

type QualificationModelCaller = Parameters<typeof runQualificationJudge>[1];

export type DrainQualificationAutoRecommendationOptions = {
  batchLimit?: number;
  nowIso?: string;
  modelCaller?: QualificationModelCaller;
};

export type ProcessCanonicalSheet2QualificationAutoRecommendationOptions = DrainQualificationAutoRecommendationOptions & {
  sheetReader?: QualificationSheet2Reader;
  highWaterResolver?: () => Promise<number>;
};

type CanonicalSheet2HighWaterStatus = "state" | "firestore" | "sheet_scan" | "unavailable";

type CanonicalSheet2HighWaterResolution = {
  row: number;
  status: CanonicalSheet2HighWaterStatus;
  authoritative: boolean;
};

export type DrainQualificationAutoRecommendationResult = {
  scanned: number;
  candidateCount: number;
  recommendedCount: number;
  finalizedCount: number;
  failedCount: number;
  skippedCount: number;
  cacheHits: number;
  cacheMisses: number;
  quarantinedCount: number;
  noOp: boolean;
  leadKeys: string[];
};

export type ProcessCanonicalSheet2QualificationAutoRecommendationResult = DrainQualificationAutoRecommendationResult & {
  sheetScanned: number;
  materializedCount: number;
  unchangedCount: number;
  canonicalCandidateCount: number;
  pageStartRow: number;
  pageEndRow: number;
  nextStartRow: number;
  observedHighWaterRow: number;
  discoveredMaxRow: number;
  highWaterStatus: CanonicalSheet2HighWaterStatus;
  highWaterAuthoritative: boolean;
  readRangeCount: number;
  cursorWrapped: boolean;
  cursorBusy: boolean;
};

export async function drainQualificationAutoRecommendation(
  options: DrainQualificationAutoRecommendationOptions = {},
): Promise<DrainQualificationAutoRecommendationResult> {
  const nowIso = cleanIso(options.nowIso) || new Date().toISOString();
  const batchLimit = boundedInteger(options.batchLimit, DEFAULT_DRAIN_LIMIT, 1, MAX_DRAIN_LIMIT);
  const qualificationPolicyHash = await resolveLegacyScpQualificationPolicyHash();
  const leadIds = await findPendingLeadIdsWithoutRecommendation(batchLimit, qualificationPolicyHash);
  return recommendQualificationLeadIds({
    targets: leadIds.map((leadId) => ({ leadId, rowNumber: 0, sourceInputHash: "" })),
    nowIso,
    batchLimit,
    modelCaller: options.modelCaller,
    requireCanonicalSheet2: false,
    qualificationPolicyHash,
  });
}

export async function processCanonicalSheet2QualificationAutoRecommendation(
  options: ProcessCanonicalSheet2QualificationAutoRecommendationOptions = {},
): Promise<ProcessCanonicalSheet2QualificationAutoRecommendationResult> {
  const nowIso = cleanIso(options.nowIso) || new Date().toISOString();
  const batchLimit = boundedInteger(options.batchLimit, DEFAULT_DRAIN_LIMIT, 1, MAX_DRAIN_LIMIT);
  const knownHighWater = await canonicalSheet2KnownHighWaterRow(options.highWaterResolver);
  const page = await claimCanonicalSheet2PollPage(nowIso, knownHighWater);
  if (!page) {
    return {
      ...emptyDrainResult(),
      sheetScanned: 0,
      materializedCount: 0,
      unchangedCount: 0,
      canonicalCandidateCount: 0,
      pageStartRow: 0,
      pageEndRow: 0,
      nextStartRow: 0,
      observedHighWaterRow: 0,
      discoveredMaxRow: 0,
      highWaterStatus: knownHighWater.status,
      highWaterAuthoritative: knownHighWater.authoritative,
      readRangeCount: 0,
      cursorWrapped: false,
      cursorBusy: true,
    };
  }
  try {
    const materialization = await materializeCanonicalSheet2QualificationRows(options.sheetReader, {
      startRow: page.startRow,
      endRow: page.endRow,
      readRanges: canonicalSheet2PollReadRanges(page),
    });
    const targeted = await recommendQualificationLeadIds({
      targets: materialization.candidates,
      nowIso,
      batchLimit,
      modelCaller: options.modelCaller,
      requireCanonicalSheet2: true,
    });
    const cursor = await completeCanonicalSheet2PollPage(page, materialization.observedMaxRow, nowIso);
    return {
      ...targeted,
      sheetScanned: materialization.scanned,
      materializedCount: materialization.materializedCount,
      unchangedCount: materialization.unchangedCount,
      canonicalCandidateCount: materialization.candidates.length,
      pageStartRow: page.startRow,
      pageEndRow: page.endRow,
      nextStartRow: cursor.nextStartRow,
      observedHighWaterRow: cursor.observedHighWaterRow,
      discoveredMaxRow: cursor.discoveredMaxRow,
      highWaterStatus: cursor.highWaterStatus,
      highWaterAuthoritative: cursor.highWaterAuthoritative,
      readRangeCount: materialization.readRangeCount,
      cursorWrapped: cursor.wrapped,
      cursorBusy: false,
    };
  } catch (error) {
    await releaseCanonicalSheet2PollPage(page).catch(() => undefined);
    throw error;
  }
}

type CanonicalSheet2PollPageClaim = {
  key: string;
  startRow: number;
  endRow: number;
  observedHighWaterRow: number;
  discoveredMaxRow: number;
  highWaterStatus: CanonicalSheet2HighWaterStatus;
  highWaterAuthoritative: boolean;
};

function canonicalSheet2PollStateRef() {
  return adminDb.collection(AUTO_STATE_COLLECTION).doc(CANONICAL_SHEET2_POLL_STATE_ID);
}

async function canonicalSheet2KnownHighWaterRow(
  resolver: () => Promise<number> = canonicalSheet2MaterializedHighWaterRow,
): Promise<CanonicalSheet2HighWaterResolution> {
  const state = await canonicalSheet2PollStateRef().get();
  const stored = boundedInteger(state.get("observedHighWaterRow"), 0, 0, CANONICAL_SHEET2_MAX_ROW);
  const storedAuthoritative = state.get("observedHighWaterAuthoritative") === true;
  if (stored > 0 && storedAuthoritative) return { row: stored, status: "state", authoritative: true };
  try {
    const row = boundedInteger(await resolver(), 0, 0, CANONICAL_SHEET2_MAX_ROW);
    return row > 0
      ? { row, status: "firestore", authoritative: true }
      : { row: 0, status: "unavailable", authoritative: false };
  } catch {
    // Never replace a failed ordered query with an unordered bounded page: that page
    // cannot prove a maximum. Unknown state safely falls back to leased durable paging.
    return { row: 0, status: "unavailable", authoritative: false };
  }
}

async function canonicalSheet2MaterializedHighWaterRow(): Promise<number> {
  const canonicalSourceId = sourceIdForGoogleSheet(SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID);
  const baseQuery = adminDb.collection("program_sheet_leads")
    .where("sourceType", "==", "google_sheet")
    .where("spreadsheetId", "==", SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID)
    .where("tabName", "==", SCP_QUALIFICATION_REVIEW_TAB_NAME)
    .where("sourceId", "==", canonicalSourceId)
    .orderBy("rowNumber", "desc");
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (let page = 0; page < COLD_HIGH_WATER_MAX_PAGES; page += 1) {
    let orderedPage = baseQuery.limit(COLD_HIGH_WATER_PAGE_SIZE);
    if (cursor) orderedPage = orderedPage.startAfter(cursor);
    const snapshot = await orderedPage.get();
    for (const doc of snapshot.docs) {
      const rowNumber = boundedInteger(doc.get("rowNumber"), 0, 0, CANONICAL_SHEET2_MAX_ROW);
      if (rowNumber > 0
        && /^sheet_raw_rows\/[a-zA-Z0-9_:-]{1,240}$/.test(asString(doc.get("sourceRef")))
        && /^[a-f0-9]{64}$/i.test(asString(doc.get("rowHash")))) return rowNumber;
    }
    if (snapshot.size < COLD_HIGH_WATER_PAGE_SIZE) return 0;
    cursor = snapshot.docs.at(-1) ?? null;
    if (!cursor) return 0;
  }
  // The ordered bounded window contained only malformed source records. Returning zero
  // means "unknown", never a fabricated max; the leased Sheet cursor performs discovery.
  return 0;
}

async function claimCanonicalSheet2PollPage(
  nowIso: string,
  knownHighWater: CanonicalSheet2HighWaterResolution,
): Promise<CanonicalSheet2PollPageClaim | null> {
  const ref = canonicalSheet2PollStateRef();
  const nowMs = Date.parse(nowIso);
  return adminDb.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const activePage = asRecord(snapshot.get("activePage"));
    const leaseUntilIso = asString(activePage.leaseUntilIso);
    if (activePage.status === "processing" && Number.isFinite(Date.parse(leaseUntilIso)) && Date.parse(leaseUntilIso) > nowMs) {
      return null;
    }
    const storedHighWaterCandidate = boundedInteger(snapshot.get("observedHighWaterRow"), 0, 0, CANONICAL_SHEET2_MAX_ROW);
    const storedHighWaterAuthoritative = snapshot.get("observedHighWaterAuthoritative") === true;
    const storedHighWaterRow = storedHighWaterAuthoritative ? storedHighWaterCandidate : 0;
    const discoveredMaxRow = Math.max(
      boundedInteger(snapshot.get("discoveredMaxRow"), 0, 0, CANONICAL_SHEET2_MAX_ROW),
      storedHighWaterAuthoritative ? 0 : storedHighWaterCandidate,
    );
    const observedHighWaterRow = Math.max(storedHighWaterRow, knownHighWater.row);
    const highWaterAuthoritative = observedHighWaterRow > 0 && (storedHighWaterAuthoritative || knownHighWater.authoritative);
    const highWaterStatus: CanonicalSheet2HighWaterStatus = storedHighWaterRow > 0 ? "state" : knownHighWater.status;
    const storedNextStartRow = boundedInteger(snapshot.get("nextStartRow"), 1, 1, CANONICAL_SHEET2_MAX_ROW);
    const startRow = observedHighWaterRow > 0 && storedNextStartRow > observedHighWaterRow ? 1 : storedNextStartRow;
    const endRow = Math.min(CANONICAL_SHEET2_MAX_ROW, startRow + MAX_SCP_SHEET_ROWS - 1);
    const key = `page_${createHash("sha256").update(`${startRow}:${endRow}:${nowIso}`).digest("hex").slice(0, 32)}`;
    tx.set(ref, {
      nextStartRow: startRow,
      observedHighWaterRow,
      discoveredMaxRow,
      highWaterStatus,
      observedHighWaterAuthoritative: highWaterAuthoritative,
      pageSize: MAX_SCP_SHEET_ROWS,
      maxRow: CANONICAL_SHEET2_MAX_ROW,
      activePage: {
        key,
        status: "processing",
        startRow,
        endRow,
        observedHighWaterRow,
        discoveredMaxRow,
        highWaterStatus,
        highWaterAuthoritative,
        claimedAtIso: nowIso,
        leaseUntilIso: new Date(nowMs + AUTO_RECOMMENDATION_LEASE_MS).toISOString(),
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { key, startRow, endRow, observedHighWaterRow, discoveredMaxRow, highWaterStatus, highWaterAuthoritative };
  });
}

function canonicalSheet2PollReadRanges(page: CanonicalSheet2PollPageClaim): CanonicalSheet2QualificationReadRange[] {
  const ranges: CanonicalSheet2QualificationReadRange[] = [
    { startRow: page.startRow, endRow: page.endRow, priority: 2 },
  ];
  // Probe the head every minute so a corrected early row is not delayed behind a
  // long-lived page cursor. The materializer deduplicates this when page 1 is active.
  ranges.push({ startRow: 1, endRow: MAX_SCP_SHEET_ROWS, priority: 1 });
  // Probe after the authoritative tail when available, or after the greatest tentative
  // discovery while an index outage forces a full durable scan. Tentative discoveries
  // improve append coverage but never become a terminal high-water on their own.
  const appendProbeBaseRow = Math.max(page.observedHighWaterRow, page.discoveredMaxRow);
  const appendProbeStartRow = appendProbeBaseRow > 0
    ? appendProbeBaseRow + 1
    : MAX_SCP_SHEET_ROWS + 1;
  if (appendProbeStartRow <= CANONICAL_SHEET2_MAX_ROW) {
    ranges.push({
      startRow: appendProbeStartRow,
      endRow: Math.min(CANONICAL_SHEET2_MAX_ROW, appendProbeStartRow + MAX_SCP_SHEET_ROWS - 1),
      priority: 0,
    });
  }
  return ranges;
}

async function completeCanonicalSheet2PollPage(
  page: CanonicalSheet2PollPageClaim,
  observedMaxRow: number,
  nowIso: string,
): Promise<{
  nextStartRow: number;
  observedHighWaterRow: number;
  discoveredMaxRow: number;
  highWaterStatus: CanonicalSheet2HighWaterStatus;
  highWaterAuthoritative: boolean;
  wrapped: boolean;
}> {
  const ref = canonicalSheet2PollStateRef();
  const observedThisRun = boundedInteger(observedMaxRow, 0, 0, CANONICAL_SHEET2_MAX_ROW);
  const discoveredMaxRow = Math.max(page.discoveredMaxRow, observedThisRun);
  const fullDiscoveryComplete = !page.highWaterAuthoritative && page.endRow >= CANONICAL_SHEET2_MAX_ROW;
  const highWaterAuthoritative = page.highWaterAuthoritative || fullDiscoveryComplete;
  const observedHighWaterRow = page.highWaterAuthoritative
    ? Math.max(page.observedHighWaterRow, observedThisRun)
    : fullDiscoveryComplete
      ? discoveredMaxRow
      : 0;
  const highWaterStatus: CanonicalSheet2HighWaterStatus = page.highWaterAuthoritative && observedThisRun > page.observedHighWaterRow
    ? "sheet_scan"
    : fullDiscoveryComplete
      ? "sheet_scan"
      : page.highWaterStatus;
  const highWaterKnown = highWaterAuthoritative && observedHighWaterRow > 0;
  const wrapped = page.endRow >= CANONICAL_SHEET2_MAX_ROW
    || (highWaterKnown && (page.startRow > observedHighWaterRow || page.endRow >= observedHighWaterRow));
  const nextStartRow = wrapped ? 1 : page.endRow + 1;
  const completed = await adminDb.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (asString(asRecord(snapshot.get("activePage")).key) !== page.key) return false;
    tx.set(ref, {
      nextStartRow,
      observedHighWaterRow,
      discoveredMaxRow,
      highWaterStatus,
      observedHighWaterAuthoritative: highWaterAuthoritative,
      activePage: FieldValue.delete(),
      lastCompletedPage: {
        startRow: page.startRow,
        endRow: page.endRow,
        observedHighWaterRow,
        discoveredMaxRow,
        highWaterStatus,
        highWaterAuthoritative,
        completedAtIso: nowIso,
        wrapped,
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return true;
  });
  if (!completed) throw new Error("qualification Sheet2 poll cursor ownership was lost before completion");
  return { nextStartRow, observedHighWaterRow, discoveredMaxRow, highWaterStatus, highWaterAuthoritative, wrapped };
}

async function releaseCanonicalSheet2PollPage(page: CanonicalSheet2PollPageClaim): Promise<void> {
  const ref = canonicalSheet2PollStateRef();
  await adminDb.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (asString(asRecord(snapshot.get("activePage")).key) !== page.key) return;
    tx.set(ref, { activePage: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
}

type TargetedQualificationRecommendationOptions = {
  targets: Array<Pick<CanonicalSheet2QualificationCandidate, "leadId" | "rowNumber" | "sourceInputHash">>;
  nowIso: string;
  batchLimit: number;
  modelCaller?: QualificationModelCaller;
  requireCanonicalSheet2: boolean;
  qualificationPolicyHash?: string;
};

export async function recommendQualificationLeadIds(
  options: TargetedQualificationRecommendationOptions,
): Promise<DrainQualificationAutoRecommendationResult> {
  const requestedTargets = options.targets;
  if (requestedTargets.length === 0) return emptyDrainResult();
  const canonicalProgramId = SCP_CANONICAL_PROGRAM_ID;
  const qualificationPolicyHash = /^[a-f0-9]{64}$/i.test(asString(options.qualificationPolicyHash))
    ? asString(options.qualificationPolicyHash).toLowerCase()
    : await resolveLegacyScpQualificationPolicyHash();
  const claimed: ClaimedQualificationRecommendation[] = [];
  let scanned = 0;
  for (const target of requestedTargets) {
    if (claimed.length >= options.batchLimit) break;
    scanned += 1;
    const claim = await claimQualificationRecommendation(
      target,
      options.nowIso,
      options.requireCanonicalSheet2,
      canonicalProgramId,
      qualificationPolicyHash,
    );
    if (claim) claimed.push(claim);
  }
  if (claimed.length === 0) {
    return { ...emptyDrainResult(), scanned };
  }

  // Scheduler ownership stays explicit so decision ids/source completion remain
  // idempotent. Judge A re-reads authoritative settings and only relaxes recommendation-
  // only behavior when its existing final_decision gate is genuinely open.
  let result: Awaited<ReturnType<typeof runQualificationJudge>>;
  try {
    const claimedLeadIds = claimed.map((claim) => claim.leadId);
    result = await runQualificationJudge(
      { leadIds: claimedLeadIds, requestedBy: SERVICE_ACTOR, requestedRole: "manager", requestedTeam: "scp", nowIso: options.nowIso },
      options.modelCaller,
      undefined,
      {
        recommendationOnly: true,
        allowConfiguredAutoFinalization: true,
        recommendationIdempotencyKeys: Object.fromEntries(claimed.map((claim) => [claim.leadId, claim.key])),
        recommendationSourceHashes: Object.fromEntries(claimed.map((claim) => [claim.leadId, claim.sourceInputHash])),
        expectedQualificationScopes: Object.fromEntries(claimed.map((claim) => [claim.leadId, {
          canonicalProgramId: claim.canonicalProgramId,
          qualificationPolicyHash: claim.qualificationPolicyHash,
          applicationId: null,
        }])),
      },
    );
  } catch (error) {
    await Promise.allSettled(claimed.map((claim) => releaseQualificationRecommendationClaim(claim.leadId, claim.key)));
    throw error;
  }

  // PB-4: 실패-리드 서킷브레이커 부기 — 성공은 카운터 리셋, 실패는 카운터 증가, N회 초과 시 격리 알림.
  const quarantinedCount = await applyAutoAttemptBookkeeping(result.results, claimed, options.nowIso);
  const outcomeLeadIds = new Set(result.results.map((outcome) => outcome.leadId));
  await Promise.allSettled(
    claimed
      .filter((claim) => !outcomeLeadIds.has(claim.leadId))
      .map((claim) => releaseQualificationRecommendationClaim(claim.leadId, claim.key)),
  );

  return {
    scanned,
    candidateCount: claimed.length,
    recommendedCount: result.recommendedCount,
    finalizedCount: result.results.filter((outcome) => outcome.finalVerdict === "pass" || outcome.finalVerdict === "fail").length,
    failedCount: result.failedCount,
    skippedCount: result.skippedCount,
    cacheHits: result.cache.hits,
    cacheMisses: result.cache.misses,
    quarantinedCount,
    noOp: false,
    leadKeys: claimed.map((claim) => schedulerLeadKey(claim.leadId)),
  };
}

type ClaimedQualificationRecommendation = {
  leadId: string;
  rowNumber: number;
  sourceInputHash: string;
  key: string;
  canonicalProgramId: string;
  qualificationPolicyHash: string;
};

async function claimQualificationRecommendation(
  target: Pick<CanonicalSheet2QualificationCandidate, "leadId" | "rowNumber" | "sourceInputHash">,
  nowIso: string,
  requireCanonicalSheet2: boolean,
  canonicalProgramId: string,
  qualificationPolicyHash: string,
): Promise<ClaimedQualificationRecommendation | null> {
  const leadId = safeSegment(asString(target.leadId));
  if (!leadId) return null;
  const sourceInputHash = /^[a-f0-9]{64}$/i.test(asString(target.sourceInputHash)) ? asString(target.sourceInputHash).toLowerCase() : "";
  const rowNumber = Math.max(0, Math.trunc(Number(target.rowNumber) || 0));
  if (requireCanonicalSheet2 && (!sourceInputHash || rowNumber < 1)) return null;
  const key = qualificationAutoRecommendationKey(
    leadId,
    sourceInputHash || "legacy",
    canonicalProgramId,
    qualificationPolicyHash,
  );
  const attemptScopeHash = qualificationAttemptScopeHash(sourceInputHash || "legacy", canonicalProgramId, qualificationPolicyHash);
  const nowMs = Date.parse(nowIso);
  const leaseUntilIso = new Date(nowMs + AUTO_RECOMMENDATION_LEASE_MS).toISOString();
  const ref = adminDb.collection("program_sheet_leads").doc(leadId);
  const claimed = await adminDb.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists || snapshot.get("qualificationStatus") !== "unreviewed") return false;
    if (requireCanonicalSheet2 && !isCanonicalSheet2LeadForSource(snapshot, rowNumber, sourceInputHash)) return false;
    const storedAttemptScopeHash = asString(snapshot.get("qualificationAutoAttemptsSourceHash"));
    const storedAttempts = Number(snapshot.get("qualificationAutoAttempts")) || 0;
    const sameAttemptScope = storedAttemptScopeHash === attemptScopeHash;
    if (sameAttemptScope && storedAttempts >= MAX_AUTO_ATTEMPTS) return false;
    if (sourceInputHash
      && snapshot.get("qualificationAutoRecommendationSourceHash") === sourceInputHash
      && snapshot.get("qualificationAutoRecommendationPolicyHash") === qualificationPolicyHash
      && snapshot.get("latestAiRecommendation")) return false;

    const activeClaim = asRecord(snapshot.get("qualificationAutoRecommendationClaim"));
    const activeLeaseUntil = asString(activeClaim.leaseUntilIso);
    if (activeClaim.status === "processing" && Number.isFinite(Date.parse(activeLeaseUntil)) && Date.parse(activeLeaseUntil) > nowMs) {
      return false;
    }
    const patch: Record<string, unknown> = {
      qualificationAutoRecommendationClaim: {
        key,
        status: "processing",
        rowNumber: rowNumber || null,
        sourceInputHash: sourceInputHash || null,
        canonicalProgramId,
        qualificationPolicyHash,
        claimedAtIso: nowIso,
        leaseUntilIso,
      },
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!sameAttemptScope && (storedAttempts > 0 || storedAttemptScopeHash)) {
      patch.qualificationAutoAttempts = FieldValue.delete();
      patch.qualificationAutoAttemptsSourceHash = FieldValue.delete();
      patch.qualificationAutoLastError = FieldValue.delete();
      patch.qualificationAutoLastAttemptIso = FieldValue.delete();
      if (storedAttempts >= MAX_AUTO_ATTEMPTS) {
        tx.set(quarantineAlertRef(leadId), {
          status: "resolved",
          leadKey: schedulerLeadKey(leadId),
          resolvedAtIso: nowIso,
          resolution: "source_hash_changed",
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }
    tx.set(ref, patch, { merge: true });
    return true;
  });
  return claimed ? { leadId, rowNumber, sourceInputHash, key, canonicalProgramId, qualificationPolicyHash } : null;
}

function isCanonicalSheet2LeadForSource(
  snapshot: FirebaseFirestore.DocumentSnapshot,
  rowNumber: number,
  sourceInputHash: string,
): boolean {
  return snapshot.get("sourceType") === "google_sheet"
    && snapshot.get("spreadsheetId") === SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID
    && snapshot.get("tabName") === SCP_QUALIFICATION_REVIEW_TAB_NAME
    && Number(snapshot.get("rowNumber")) === rowNumber
    && /^sheet_raw_rows\/[a-zA-Z0-9_:-]{1,240}$/.test(asString(snapshot.get("sourceRef")))
    && /^[a-f0-9]{64}$/i.test(asString(snapshot.get("rowHash")))
    && snapshot.get("qualificationSourceInputHash") === sourceInputHash;
}

export function qualificationAutoRecommendationKey(
  leadId: string,
  sourceInputHash: string,
  canonicalProgramId: string = SCP_CANONICAL_PROGRAM_ID,
  qualificationPolicyHash = "legacy-policy",
): string {
  const normalizedProgramId = resolveCanonicalProgramId(canonicalProgramId);
  const normalizedPolicyHash = qualificationPolicyHash.toLowerCase();
  const programToken = safeSegment(normalizedProgramId).slice(0, 48) || "missing-program";
  const policyToken = safeSegment(normalizedPolicyHash).slice(0, 12) || "missing-policy";
  return `qar_${programToken}_${policyToken}_${createHash("sha256")
    .update(JSON.stringify({ leadId, sourceInputHash, canonicalProgramId: normalizedProgramId, qualificationPolicyHash: normalizedPolicyHash }))
    .digest("hex")
    .slice(0, 32)}`;
}

function qualificationAttemptScopeHash(sourceInputHash: string, canonicalProgramId: string, qualificationPolicyHash: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ sourceInputHash, canonicalProgramId, qualificationPolicyHash }))
    .digest("hex");
}

async function releaseQualificationRecommendationClaim(leadId: string, expectedKey: string): Promise<void> {
  const ref = adminDb.collection("program_sheet_leads").doc(leadId);
  await adminDb.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const claim = asRecord(snapshot.get("qualificationAutoRecommendationClaim"));
    if (claim.key !== expectedKey) return;
    tx.set(ref, { qualificationAutoRecommendationClaim: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
}

function emptyDrainResult(): DrainQualificationAutoRecommendationResult {
  return { scanned: 0, candidateCount: 0, recommendedCount: 0, finalizedCount: 0, failedCount: 0, skippedCount: 0, cacheHits: 0, cacheMisses: 0, quarantinedCount: 0, noOp: true, leadKeys: [] };
}

// Admin-triggerable manual drain — mirrors processVideoReviewAutomationOutbox. Exists so
// operators (and emulator/e2e tests, since Firebase's emulator never fires onSchedule
// automatically — RA-9) can run a drain on demand instead of waiting for the cron tick.
export async function processQualificationAutoRecommendation(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "qualification_auto_recommendation.process", ADMIN_ROLES);
  // 2026-09-27 codex adversarial review round 2 sweep: manual drain of the scp qualification
  // (canonical Sheet2) auto-recommendation queue — the real scheduled worker
  // (processQualificationAutoRecommendationSchedule) calls
  // processCanonicalSheet2QualificationAutoRecommendation directly and never goes through this
  // public callable, so gating it here cannot affect the schedule.
  await assertScpEntitled(auth, request, "qualification_auto_recommendation.process");
  const data = asRecord(request.data);
  const result = await drainQualificationAutoRecommendation({
    batchLimit: boundedInteger(data.batchLimit, DEFAULT_DRAIN_LIMIT, 1, MAX_DRAIN_LIMIT),
    nowIso: asString(data.nowIso) || undefined,
  });
  return {
    ok: true,
    ...result,
    behaviorLog: makeBehaviorLog(auth, "qualification_auto_recommendation.process", "success", "scp-automation"),
  };
}

async function findPendingLeadIdsWithoutRecommendation(batchLimit: number, qualificationPolicyHash: string): Promise<string[]> {
  const snapshot = await adminDb.collection("program_sheet_leads")
    .where("qualificationStatus", "==", "unreviewed")
    .limit(SCAN_LIMIT)
    .get();
  const ids: string[] = [];
  for (const doc of snapshot.docs) {
    if (ids.length >= batchLimit) break;
    if (doc.get("latestAiRecommendation") && doc.get("qualificationAutoRecommendationPolicyHash") === qualificationPolicyHash) continue;
    // PB-4 서킷브레이커: N회 이상 연속 실패로 격리된 리드는 무한 재선별하지 않는다(비용 폭주 차단).
    const attempts = Number(doc.get("qualificationAutoAttempts")) || 0;
    const currentAttemptScopeHash = qualificationAttemptScopeHash("legacy", SCP_CANONICAL_PROGRAM_ID, qualificationPolicyHash);
    if (attempts >= MAX_AUTO_ATTEMPTS && doc.get("qualificationAutoAttemptsSourceHash") === currentAttemptScopeHash) continue;
    ids.push(doc.id);
  }
  return ids;
}

// PB-4: 드레인 1회의 per-lead 결과로 실패 카운터를 유지한다. 성공(추천)은 카운터를 리셋하고,
// 실패는 트랜잭션으로 카운터를 증가시켜 N회 초과 시 격리 알림 doc을 남긴다. 반환값은 이번 드레인에서
// 새로 격리 임계치를 넘긴 리드 수. 이 부기는 무인 auto-recommend 파이프라인(drain/스케줄러)에만
// 적용되고, 사람 주도 judgeQualification callable은 이 경로를 타지 않으므로 영향받지 않는다.
async function applyAutoAttemptBookkeeping(
  results: QualificationJudgeLeadResult[],
  claims: ClaimedQualificationRecommendation[],
  nowIso: string,
): Promise<number> {
  let quarantined = 0;
  const attemptScopeByLeadId = new Map(claims.map((claim) => [
    claim.leadId,
    qualificationAttemptScopeHash(
      claim.sourceInputHash || "legacy",
      claim.canonicalProgramId,
      claim.qualificationPolicyHash,
    ),
  ]));
  for (const outcome of results) {
    const leadId = asString(outcome.leadId);
    if (!leadId) continue;
    const leadKey = schedulerLeadKey(leadId);
    const attemptScopeHash = attemptScopeByLeadId.get(leadId) ?? "legacy";
    const ref = adminDb.collection("program_sheet_leads").doc(leadId);
    if (outcome.status === "recommended") {
      // 추천 성공 → 실패 카운터 리셋(일시 오류가 이후 실패와 합산되어 조기 격리되지 않도록).
      await ref.set({
        qualificationAutoAttempts: FieldValue.delete(),
        qualificationAutoAttemptsSourceHash: FieldValue.delete(),
        qualificationAutoLastError: FieldValue.delete(),
        qualificationAutoLastErrorCorrelationKey: FieldValue.delete(),
        qualificationAutoLastAttemptIso: FieldValue.delete(),
        qualificationAutoRecommendationClaim: FieldValue.delete(),
      }, { merge: true }).catch((err) => {
        const safeResetError = schedulerBoundaryError(err);
        console.error("[qualification-auto] attempt reset failed", { leadKey, error: safeResetError.code, correlationKey: safeResetError.correlationKey });
      });
    } else if (outcome.status === "failed") {
      const safeError = schedulerBoundaryError(outcome.error, outcome.errorCorrelationKey);
      const attempts = await incrementAutoAttempt(ref, safeError, nowIso, attemptScopeHash, leadKey);
      // 임계치에 "도달한 그 드레인"에서만 격리 알림을 1회 남긴다(중복 알림 폭주 방지).
      if (attempts === MAX_AUTO_ATTEMPTS) {
        quarantined += 1;
        await recordAutoQuarantineAlert(leadId, attempts, safeError, nowIso, attemptScopeHash);
      }
    } else {
      await ref.set({ qualificationAutoRecommendationClaim: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => undefined);
    }
  }
  return quarantined;
}

// 실패 카운터를 트랜잭션으로 증가시키고 갱신된 값을 반환한다(격리 판정을 위해 결정적 next 값 필요).
async function incrementAutoAttempt(
  ref: FirebaseFirestore.DocumentReference,
  error: QualificationBoundaryError,
  nowIso: string,
  attemptScopeHash: string,
  leadKey: string,
): Promise<number> {
  try {
    return await adminDb.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const current = asString(snapshot.get("qualificationAutoAttemptsSourceHash")) === attemptScopeHash
        ? Number(snapshot.get("qualificationAutoAttempts")) || 0
        : 0;
      const next = current + 1;
      tx.set(ref, {
        qualificationAutoAttempts: next,
        qualificationAutoAttemptsSourceHash: attemptScopeHash,
        qualificationAutoLastError: error.code,
        qualificationAutoLastErrorCorrelationKey: error.correlationKey,
        qualificationAutoLastAttemptIso: nowIso,
        qualificationAutoRecommendationClaim: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return next;
    });
  } catch (err) {
    const safeError = schedulerBoundaryError(err);
    console.error("[qualification-auto] attempt increment failed", { leadKey, error: safeError.code, correlationKey: safeError.correlationKey });
    return 0;
  }
}

// 격리 시 알림 doc(scp_qualification_auto_alerts) — recordCanaryAlert(chat-ai.ts)와 동형의
// 운영 가시성 마커. 실패해도 부기 흐름을 막지 않는다(로그로만 남김).
async function recordAutoQuarantineAlert(leadId: string, attempts: number, error: QualificationBoundaryError, nowIso: string, sourceHash: string): Promise<void> {
  const leadKey = schedulerLeadKey(leadId);
  const ref = quarantineAlertRef(leadId);
  const id = ref.id;
  try {
    await ref.set({
      id,
      status: "quarantined",
      leadKey,
      sourceHash,
      attempts,
      maxAttempts: MAX_AUTO_ATTEMPTS,
      lastError: error.code,
      errorCorrelationKey: error.correlationKey,
      quarantinedAtIso: nowIso,
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    const safeAlertError = schedulerBoundaryError(err);
    console.error("[qualification-auto] quarantine alert record failed", { leadKey, error: safeAlertError.code, correlationKey: safeAlertError.correlationKey });
  }
  console.warn("[qualification-auto] lead quarantined after repeated auto-recommendation failures", { leadKey, attempts, maxAttempts: MAX_AUTO_ATTEMPTS });
}

function quarantineAlertRef(leadId: string) {
  return adminDb.collection(AUTO_ALERT_COLLECTION).doc(`quarantine-${schedulerLeadKey(leadId)}`);
}

function schedulerLeadKey(leadId: string): string {
  return createHash("sha256").update(leadId).digest("hex").slice(0, 20);
}

function schedulerBoundaryError(error: unknown, suppliedCorrelationKey: unknown = ""): QualificationBoundaryError {
  const fallback = qualificationBoundaryError(error, "qualification_judge_failed");
  const code = asString(error);
  const correlationKey = asString(suppliedCorrelationKey).toLowerCase();
  return {
    code: (QUALIFICATION_BOUNDARY_ERROR_CODES as readonly string[]).includes(code)
      ? code as QualificationBoundaryError["code"]
      : fallback.code,
    correlationKey: /^[a-f0-9]{24}$/.test(correlationKey) ? correlationKey : fallback.correlationKey,
  };
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:@-]+/g, "_").slice(0, 200);
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
