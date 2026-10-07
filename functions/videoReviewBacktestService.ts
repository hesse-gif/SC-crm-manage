import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { SCP_VIDEO_REVIEW_STATE_COLLECTION } from "./videoReviewTransitionStore";
import type { VideoReviewState } from "./videoReviewTransitionCore";
import { safeDocId } from "./sheetIntakeService";
import { runVideoReviewJudge, type VideoReviewJudgeRunResult, type VideoReviewVerdictValue } from "./videoReviewJudgeService";

export const VIDEO_REVIEW_BACKTEST_RUNS_COLLECTION = "video_review_backtest_runs";
export const MAX_VIDEO_REVIEW_BACKTEST_ROWS = 500;

// W9-6#3: Sheet3 status is retired as the backtest label source. The label cohort now comes ONLY
// from the canonical Portal v3 chain (scpVideoRevisionIngress -> scp_video_review_state ->
// videoReviewTransitionStore's append-only reviewLedger). A ledger entry counts as a label only when
// it (a) matches the doc's CURRENT revision/contentFingerprint (not a stale/superseded revision), (b)
// landed on a terminal state, and (c) was decided by a human actor — auto_ai (actorType:"ai") entries
// are excluded so the AI is never graded against its own decisions.
const VIDEO_REVIEW_LABEL_TERMINAL_STATES: ReadonlySet<VideoReviewState> = new Set<VideoReviewState>([
  "approved",
  "rejected",
  "changes_requested",
]);

// R14-7: `spreadsheetId`/`range` were legacy Sheet3-era output fields with no honest equivalent now
// that the label cohort is a bounded scp_video_review_state collection scan, not a spreadsheet read —
// they were removed rather than left holding a collection name or an "n/a" placeholder. The real
// provenance is reported in full via the `source` field below. `tabName` is kept as a short human
// label for what the ledger join represents.
const VIDEO_REVIEW_LABEL_SOURCE_TAB_NAME = "current_revision_human_ledger";

export type VideoReviewBacktestLabel = "approval" | "disapproval";
export type VideoReviewBacktestPredictionVerdict = VideoReviewVerdictValue;
export type VideoReviewBacktestReadMode = "input_rows" | "review_state_scan";
export type VideoReviewBacktestMode = "dry_run" | "emulator_write";

export interface VideoReviewBacktestInput {
  // Legacy Sheet3 fields. Retained ONLY so functions/videoReviewBacktest.ts (out of this task's edit
  // scope) keeps compiling against this input shape; the label cohort no longer reads a spreadsheet at
  // all, so these are accepted and ignored.
  spreadsheetId?: unknown;
  tabName?: unknown;
  startRow?: unknown;
  // Optional dry-run/test fixture: an array of raw scp_video_review_state records shaped like
  // { id, revision, contentFingerprint, superseded?, withdrawn?, reviewLedger, subject?, ... } — i.e.
  // { id: doc.id, ...doc.data() }. When supplied, bypasses the live Firestore scan (mirrors the old
  // input_rows affordance, now over the canonical review-state shape instead of Sheet3 rows).
  rows?: unknown;
  predictionsBefore?: unknown;
  predictionsAfter?: unknown;
  judgeMissing?: unknown;
  dryRun?: unknown;
  nowIso?: unknown;
  requestedBy: string;
}

export interface VideoReviewBacktestExample {
  rowNumber: number;
  id: string;
  submission: Record<string, unknown>;
  expectedLabel: VideoReviewBacktestLabel;
  expectedMarker: string;
  humanReason: string;
}

export interface VideoReviewBacktestPrediction {
  rowNumber?: number;
  id?: string;
  verdict: VideoReviewBacktestPredictionVerdict;
  disapprovalProbability: number;
  reasons: string[];
}

export interface VideoReviewBacktestMetrics {
  confusion: {
    approval: Record<VideoReviewBacktestPredictionVerdict, number>;
    disapproval: Record<VideoReviewBacktestPredictionVerdict, number>;
  };
  verdictMetrics: {
    accuracy: number;
    approvalPrecision: number;
    approvalRecall: number;
    disapprovalPrecision: number;
    disapprovalRecall: number;
    needsReviewRate: number;
  };
}

export interface VideoReviewBacktestEvaluation {
  label: "before_few_shot" | "with_few_shot";
  predictionCount: number;
  missingPredictionCount: number;
  metrics: VideoReviewBacktestMetrics;
}

export interface VideoReviewBacktestComparison {
  accuracyDelta: number;
  disapprovalRecallDelta: number;
  changedCount: number;
  changedRows: Array<{
    rowNumber: number;
    expectedLabel: VideoReviewBacktestLabel;
    before: VideoReviewBacktestPredictionVerdict | "missing";
    after: VideoReviewBacktestPredictionVerdict | "missing";
  }>;
}

// Sample-size/provenance transparency (W9-6#3 anti-fabrication requirement): the exact count scanned
// and, of those, exactly why each excluded doc did not become a label. Persisted on every non-dry-run
// run doc alongside the metrics so a shrinking cohort is visible, never silently repackaged as if it
// were the old Sheet3 numbers.
export interface VideoReviewBacktestLabelSource {
  collection: string;
  scannedCount: number;
  excludedSuperseded: number;
  excludedWithdrawn: number;
  excludedAiOnly: number;
  excludedNotFinalized: number;
}

export interface VideoReviewBacktestResult {
  ok?: true;
  mode: VideoReviewBacktestMode;
  readMode: VideoReviewBacktestReadMode;
  tabName: string;
  rowCount: number;
  labeledCount: number;
  approvalCount: number;
  disapprovalCount: number;
  pendingCount: number;
  missingPredictionCount: number;
  source: VideoReviewBacktestLabelSource;
  before: VideoReviewBacktestEvaluation;
  after: VideoReviewBacktestEvaluation;
  comparison: VideoReviewBacktestComparison;
  examples: Array<Pick<VideoReviewBacktestExample, "rowNumber" | "id" | "expectedLabel" | "expectedMarker" | "humanReason">>;
  report: {
    humanStampRequired: true;
    autoStampWritten: false;
    stampInstruction: string;
  };
  runRef: string | null;
}

type VideoReviewStateRow = { id: string; data: Record<string, unknown> };
type StateReader = (limit: number) => Promise<VideoReviewStateRow[]>;
type JudgeRunner = typeof runVideoReviewJudge;

export async function runVideoReviewBacktest(
  input: VideoReviewBacktestInput,
  judgeRunner: JudgeRunner = runVideoReviewJudge,
  stateReader: StateReader = readCurrentVideoReviewStateRows,
): Promise<VideoReviewBacktestResult> {
  const dryRun = input.dryRun !== false;
  if (!dryRun && !isFirestoreEmulator()) {
    const error = new Error("production video review backtest writes are disabled; use dryRun or run against demo-flu emulator");
    Object.assign(error, { code: "failed-precondition", errorCode: "run_video_review_backtest_production_video_review_backtest_writes" });
    throw error;
  }

  const inputRows = Array.isArray(input.rows) ? input.rows : null;
  const readMode: VideoReviewBacktestReadMode = inputRows ? "input_rows" : "review_state_scan";
  const stateRows = inputRows
    ? parseInlineVideoReviewStateRows(inputRows)
    : await stateReader(MAX_VIDEO_REVIEW_BACKTEST_ROWS);
  const parsed = buildVideoReviewLabelCohort(stateRows);
  const beforePredictions = input.judgeMissing === true
    ? await fillMissingPredictions(parsed.examples, parsePredictions(input.predictionsBefore), input, judgeRunner, true)
    : parsePredictions(input.predictionsBefore);
  const afterPredictions = input.judgeMissing === true
    ? await fillMissingPredictions(parsed.examples, parsePredictions(input.predictionsAfter), input, judgeRunner, false)
    : parsePredictions(input.predictionsAfter);

  const before = evaluateVideoReviewBacktest("before_few_shot", parsed.examples, beforePredictions);
  const after = evaluateVideoReviewBacktest("with_few_shot", parsed.examples, afterPredictions);
  const nowIso = parseDate(input.nowIso, new Date()).toISOString();
  const result: VideoReviewBacktestResult = {
    mode: dryRun ? "dry_run" : "emulator_write",
    readMode,
    tabName: VIDEO_REVIEW_LABEL_SOURCE_TAB_NAME,
    rowCount: parsed.scannedCount,
    labeledCount: parsed.examples.length,
    approvalCount: parsed.examples.filter((example) => example.expectedLabel === "approval").length,
    disapprovalCount: parsed.examples.filter((example) => example.expectedLabel === "disapproval").length,
    pendingCount: parsed.excludedNotFinalized,
    missingPredictionCount: before.missingPredictionCount + after.missingPredictionCount,
    source: {
      collection: SCP_VIDEO_REVIEW_STATE_COLLECTION,
      scannedCount: parsed.scannedCount,
      excludedSuperseded: parsed.excludedSuperseded,
      excludedWithdrawn: parsed.excludedWithdrawn,
      excludedAiOnly: parsed.excludedAiOnly,
      excludedNotFinalized: parsed.excludedNotFinalized,
    },
    before,
    after,
    comparison: compareVideoReviewBacktest(parsed.examples, beforePredictions, afterPredictions, before.metrics, after.metrics),
    examples: parsed.examples.map((example) => ({
      rowNumber: example.rowNumber,
      id: example.id,
      expectedLabel: example.expectedLabel,
      expectedMarker: example.expectedMarker,
      humanReason: example.humanReason,
    })),
    report: {
      humanStampRequired: true,
      autoStampWritten: false,
      stampInstruction: "Do not write lastBacktestPassedAt.videoReview here. Hesse must review this report and apply any approval stamp manually.",
    },
    runRef: null,
  };

  if (!dryRun) {
    const runRef = adminDb.collection(VIDEO_REVIEW_BACKTEST_RUNS_COLLECTION).doc(safeDocId(`videoReview:${nowIso}`));
    await runRef.set({
      ...result,
      id: runRef.id,
      requestedBy: input.requestedBy,
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    result.runRef = runRef.path;
  }

  return result;
}

interface VideoReviewLabelCohort {
  examples: VideoReviewBacktestExample[];
  scannedCount: number;
  excludedSuperseded: number;
  excludedWithdrawn: number;
  excludedAiOnly: number;
  excludedNotFinalized: number;
}

// Joins each canonical review-state head's OWN current revision/contentFingerprint against its
// append-only reviewLedger (videoReviewTransitionStore.ts). No second collection read is needed: the
// join key (current revision/fingerprint) and the ledger entries it must match both live on the same
// scp_video_review_state document, so this is a single bounded collection scan — never a per-doc
// doc.get() loop.
function buildVideoReviewLabelCohort(rows: VideoReviewStateRow[]): VideoReviewLabelCohort {
  const examples: VideoReviewBacktestExample[] = [];
  let excludedSuperseded = 0;
  let excludedWithdrawn = 0;
  let excludedAiOnly = 0;
  let excludedNotFinalized = 0;

  for (const { id, data } of rows.slice(0, MAX_VIDEO_REVIEW_BACKTEST_ROWS)) {
    if (data.superseded === true) {
      excludedSuperseded += 1;
      continue;
    }
    if (data.withdrawn === true) {
      excludedWithdrawn += 1;
      continue;
    }
    const currentRevision = Number(data.revision);
    const currentFingerprint = typeof data.contentFingerprint === "string" ? data.contentFingerprint : "";
    if (!Number.isInteger(currentRevision) || !currentFingerprint) {
      excludedNotFinalized += 1;
      continue;
    }
    const decisionEntry = currentHumanDecisionEntry(data.reviewLedger, currentRevision, currentFingerprint);
    if (!decisionEntry) {
      excludedNotFinalized += 1;
      continue;
    }
    if (decisionEntry.actorType !== "human") {
      excludedAiOnly += 1;
      continue;
    }
    const expectedLabel: VideoReviewBacktestLabel = decisionEntry.toState === "approved" ? "approval" : "disapproval";
    const subject = data.subject && typeof data.subject === "object" && !Array.isArray(data.subject)
      ? data.subject as Record<string, unknown>
      : {};
    examples.push({
      rowNumber: examples.length + 1,
      id,
      submission: {
        id,
        videoSubmissionId: subject.videoSubmissionId ?? id,
        youtubeUrl: data.youtubeUrl,
        canonicalProgramId: data.canonicalProgramId,
        policyConfigHash: data.policyConfigHash,
        programId: subject.programId,
        campaignId: subject.campaignId,
        portalCreatorId: subject.portalCreatorId,
        fluCreatorId: subject.fluCreatorId,
        revision: currentRevision,
        contentFingerprint: currentFingerprint,
      },
      expectedLabel,
      expectedMarker: decisionEntry.toState,
      humanReason: cleanText(decisionEntry.reasonCode ?? decisionEntry.customerMessageCode, "", 500),
    });
  }

  return {
    examples,
    scannedCount: rows.length,
    excludedSuperseded,
    excludedWithdrawn,
    excludedAiOnly,
    excludedNotFinalized,
  };
}

type VideoReviewCurrentDecisionEntry = {
  toState: string;
  actorType: unknown;
  reasonCode: unknown;
  customerMessageCode: unknown;
};

// Only a ledger entry whose (revision, contentFingerprint) matches the doc's CURRENT head AND landed on
// a terminal state (approved/rejected/changes_requested) is a candidate decision. Stale entries from a
// superseded prior revision, or non-terminal in-flight entries (queued/in_review/human_review_required),
// never qualify. When multiple terminal entries share the current revision (should not normally happen —
// terminal states have no ALLOWED_NEXT transitions — but defended anyway), the highest `seq` wins.
function currentHumanDecisionEntry(
  ledger: unknown,
  currentRevision: number,
  currentFingerprint: string,
): VideoReviewCurrentDecisionEntry | null {
  if (!Array.isArray(ledger)) return null;
  let latest: (VideoReviewCurrentDecisionEntry & { seq: number }) | null = null;
  for (const raw of ledger) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (Number(entry.revision) !== currentRevision) continue;
    const entryFingerprint = typeof entry.contentFingerprint === "string"
      ? entry.contentFingerprint
      : typeof entry.fingerprint === "string" ? entry.fingerprint : "";
    if (entryFingerprint !== currentFingerprint) continue;
    const toState = typeof entry.toState === "string" ? entry.toState : "";
    if (!VIDEO_REVIEW_LABEL_TERMINAL_STATES.has(toState as VideoReviewState)) continue;
    const seq = Number(entry.seq ?? 0);
    if (!latest || seq >= latest.seq) {
      latest = {
        toState,
        actorType: entry.actorType,
        reasonCode: entry.reasonCode,
        customerMessageCode: entry.customerMessageCode,
        seq,
      };
    }
  }
  return latest;
}

export function evaluateVideoReviewBacktest(
  label: VideoReviewBacktestEvaluation["label"],
  examples: VideoReviewBacktestExample[],
  predictions: VideoReviewBacktestPrediction[],
): VideoReviewBacktestEvaluation {
  const byKey = predictionMap(predictions);
  const confusion = emptyConfusion();
  let missingPredictionCount = 0;
  for (const example of examples) {
    const prediction = byKey.get(String(example.rowNumber)) ?? byKey.get(example.id);
    const verdict = prediction?.verdict ?? "needs_review";
    if (!prediction) missingPredictionCount += 1;
    confusion[example.expectedLabel][verdict] += 1;
  }
  const approvalCorrect = confusion.approval.approval;
  const disapprovalCorrect = confusion.disapproval.disapproval;
  const total = examples.length;
  const needsReviewCount = confusion.approval.needs_review + confusion.disapproval.needs_review;
  return {
    label,
    predictionCount: predictions.length,
    missingPredictionCount,
    metrics: {
      confusion,
      verdictMetrics: {
        accuracy: ratio(approvalCorrect + disapprovalCorrect, total),
        approvalPrecision: ratio(confusion.approval.approval, confusion.approval.approval + confusion.disapproval.approval),
        approvalRecall: ratio(confusion.approval.approval, confusion.approval.approval + confusion.approval.disapproval + confusion.approval.needs_review),
        disapprovalPrecision: ratio(confusion.disapproval.disapproval, confusion.disapproval.disapproval + confusion.approval.disapproval),
        disapprovalRecall: ratio(confusion.disapproval.disapproval, confusion.disapproval.approval + confusion.disapproval.disapproval + confusion.disapproval.needs_review),
        needsReviewRate: ratio(needsReviewCount, total),
      },
    },
  };
}

export function compareVideoReviewBacktest(
  examples: VideoReviewBacktestExample[],
  beforePredictions: VideoReviewBacktestPrediction[],
  afterPredictions: VideoReviewBacktestPrediction[],
  beforeMetrics: VideoReviewBacktestMetrics,
  afterMetrics: VideoReviewBacktestMetrics,
): VideoReviewBacktestComparison {
  const before = predictionMap(beforePredictions);
  const after = predictionMap(afterPredictions);
  const changedRows: VideoReviewBacktestComparison["changedRows"] = examples.flatMap((example) => {
    const beforeVerdict = before.get(String(example.rowNumber))?.verdict ?? before.get(example.id)?.verdict ?? "missing";
    const afterVerdict = after.get(String(example.rowNumber))?.verdict ?? after.get(example.id)?.verdict ?? "missing";
    return beforeVerdict === afterVerdict ? [] : [{ rowNumber: example.rowNumber, expectedLabel: example.expectedLabel, before: beforeVerdict, after: afterVerdict }];
  });
  return {
    accuracyDelta: roundMetric(afterMetrics.verdictMetrics.accuracy - beforeMetrics.verdictMetrics.accuracy),
    disapprovalRecallDelta: roundMetric(afterMetrics.verdictMetrics.disapprovalRecall - beforeMetrics.verdictMetrics.disapprovalRecall),
    changedCount: changedRows.length,
    changedRows,
  };
}

export function hashVideoReviewBacktestExamples(examples: VideoReviewBacktestExample[]): string {
  return createHash("sha256").update(JSON.stringify(examples.map((example) => ({ rowNumber: example.rowNumber, id: example.id, expectedLabel: example.expectedLabel })))).digest("hex");
}

async function fillMissingPredictions(
  examples: VideoReviewBacktestExample[],
  predictions: VideoReviewBacktestPrediction[],
  input: VideoReviewBacktestInput,
  judgeRunner: JudgeRunner,
  disableFewShot: boolean,
): Promise<VideoReviewBacktestPrediction[]> {
  const byKey = predictionMap(predictions);
  const filled = [...predictions];
  for (const example of examples) {
    if (byKey.has(String(example.rowNumber)) || byKey.has(example.id)) continue;
    const judged: VideoReviewJudgeRunResult = await judgeRunner({
      dryRun: true,
      disableFewShot,
      submissions: [example.submission],
      requestedBy: input.requestedBy,
      nowIso: input.nowIso,
    });
    const recommendation = judged.results[0]?.aiRecommendation;
    if (!recommendation) continue;
    filled.push({
      rowNumber: example.rowNumber,
      id: example.id,
      verdict: recommendation.verdict,
      disapprovalProbability: recommendation.disapprovalProbability,
      reasons: recommendation.reasons,
    });
  }
  return filled;
}

async function readCurrentVideoReviewStateRows(limit: number): Promise<VideoReviewStateRow[]> {
  const snapshot = await adminDb
    .collection(SCP_VIDEO_REVIEW_STATE_COLLECTION)
    .orderBy("updatedAtIso", "desc")
    .limit(limit)
    .get();
  return snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() ?? {} }));
}

function parseInlineVideoReviewStateRows(rows: unknown[]): VideoReviewStateRow[] {
  return rows.slice(0, MAX_VIDEO_REVIEW_BACKTEST_ROWS).flatMap((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const record = row as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) return [];
    const { id: _drop, ...data } = record;
    return [{ id, data }];
  });
}

function parsePredictions(value: unknown): VideoReviewBacktestPrediction[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_VIDEO_REVIEW_BACKTEST_ROWS).map((item) => {
    const record = asRecord(item);
    const verdict = record.verdict === "approval" || record.verdict === "disapproval" || record.verdict === "needs_review" ? record.verdict : "needs_review";
    return {
      rowNumber: Number.isFinite(Number(record.rowNumber)) ? Number(record.rowNumber) : undefined,
      id: typeof record.id === "string" ? safeDocId(record.id) : undefined,
      verdict,
      disapprovalProbability: clampPercent(record.disapprovalProbability),
      reasons: stringList(record.reasons),
    };
  });
}

function predictionMap(predictions: VideoReviewBacktestPrediction[]): Map<string, VideoReviewBacktestPrediction> {
  const map = new Map<string, VideoReviewBacktestPrediction>();
  for (const prediction of predictions) {
    if (typeof prediction.rowNumber === "number") map.set(String(prediction.rowNumber), prediction);
    if (prediction.id) map.set(prediction.id, prediction);
  }
  return map;
}

function emptyConfusion(): VideoReviewBacktestMetrics["confusion"] {
  return {
    approval: { approval: 0, disapproval: 0, needs_review: 0 },
    disapproval: { approval: 0, disapproval: 0, needs_review: 0 },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 200)) : [];
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  const raw = typeof value === "string" ? value : value === null || value === undefined ? fallback : String(value);
  return raw.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function clampPercent(value: unknown): number {
  return Math.max(0, Math.min(100, boundedNumber(value, 0, 0, 100)));
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? roundMetric(numerator / denominator) : 0;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function parseDate(value: unknown, fallback: Date): Date {
  if (typeof value !== "string") return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function isFirestoreEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true" || Boolean(process.env.FIRESTORE_EMULATOR_HOST);
}
