import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  leadIdForGoogleSheetRow,
  normalizeSheetApplicant,
  safeDocId,
  sourceIdForGoogleSheet,
} from "./sheetIntakeService";
import type { ProgramSheetLeadApplicant, ProgramSheetLeadMetrics, SheetRawCells } from "./sheetIntakeTypes";
import { runQualificationJudge } from "./qualificationJudgeService";
import { SCP_AUTOMATION_AUDIT_COLLECTION, SCP_AUTOMATION_SETTINGS_DOC } from "./scpAutomationSettings";
import {
  SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID,
  SCP_QUALIFICATION_REVIEW_TAB_NAME,
  readCanonicalScpQualificationSheetRows,
} from "./scpSheetReviewService";
import { asRecord, asString } from "./shared";

export {
  SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID,
  SCP_QUALIFICATION_REVIEW_TAB_NAME,
};
export const SCP_QUALIFICATION_REVIEW_START_ROW = 1;
export const SHEET2_RANGE_WIDTH = "A:AK";
export const MAX_QUALIFICATION_BACKTEST_ROWS = 500;
export const QUALIFICATION_BACKTEST_RUNS_COLLECTION = "qualification_backtest_runs";

export type QualificationBacktestLabel = "pass" | "fail";
export type QualificationBacktestExcludedLabel = "excluded" | "blank";
export type QualificationBacktestReadMode = "input_rows" | "sheets_api";
export type QualificationBacktestMode = "dry_run" | "emulator_write";

export interface QualificationBacktestInput {
  spreadsheetId?: unknown;
  tabName?: unknown;
  startRow?: unknown;
  rows?: unknown;
  predictions?: unknown;
  dryRun?: unknown;
  judgeMissing?: unknown;
  nowIso?: unknown;
  requestedBy: string;
  minPrecision?: unknown;
  minLabelCount?: unknown;
  minAutoRejectCount?: unknown;
}

export interface QualificationBacktestExample {
  rowNumber: number;
  schemaGeneration: "script_v2" | "manual_v1";
  leadId: string;
  lead: BacktestLead;
  expectedLabel: QualificationBacktestLabel;
  expectedMarker: string;
  humanReason: string;
}

export type BacktestLead = ProgramSheetLeadApplicant & {
  id: string;
  rowNumber: number;
  applicant: ProgramSheetLeadApplicant;
  metrics: Partial<ProgramSheetLeadMetrics>;
};

export interface QualificationBacktestPrediction {
  rowNumber?: number;
  leadId?: string;
  verdict: "pass" | "fail" | "hold";
  rejectionProbability: number;
  reasons: string[];
  policyFlags: string[];
  missingFields: string[];
}

export interface QualificationBacktestResult {
  ok?: true;
  mode: QualificationBacktestMode;
  readMode: QualificationBacktestReadMode;
  spreadsheetId: string;
  tabName: string;
  rowCount: number;
  labeledCount: number;
  passCount: number;
  failCount: number;
  excludedCount: number;
  blankCount: number;
  missingPredictionCount: number;
  metrics: QualificationBacktestMetrics;
  thresholdLock: QualificationThresholdLock;
  examples: Array<Pick<QualificationBacktestExample, "rowNumber" | "schemaGeneration" | "leadId" | "expectedLabel" | "expectedMarker" | "humanReason">>;
  runRef: string | null;
}

export interface QualificationBacktestMetrics {
  confusion: {
    pass: { pass: number; fail: number; hold: number };
    fail: { pass: number; fail: number; hold: number };
  };
  verdictMetrics: {
    failPrecision: number;
    failRecall: number;
    failF1: number;
    passPrecision: number;
    passRecall: number;
    holdRate: number;
  };
  thresholdCandidates: ThresholdCandidate[];
}

export interface ThresholdCandidate {
  threshold: number;
  precision: number;
  recall: number;
  f1: number;
  falsePositiveRate: number;
  autoRejectCount: number;
  trueRejectCount: number;
  falseRejectCount: number;
}

export interface QualificationThresholdLock {
  locked: boolean;
  stage: "qualification";
  action: "auto_reject";
  threshold: number | null;
  criteria: { minPrecision: number; minLabelCount: number; minAutoRejectCount: number };
  metricsAtThreshold: ThresholdCandidate | null;
  reason: string;
  sampleSize: number;
  passCount: number;
  failCount: number;
  lockedAtIso: string | null;
}

type BacktestRow = { rowNumber: number; cells: Record<string, string> };
type JudgeRunner = typeof runQualificationJudge;
type SheetReader = (input: { spreadsheetId: string; tabName: string; startRow: number }) => Promise<BacktestRow[]>;

const LETTER_COLUMNS = makeColumns("AK");
const RAW_A_TO_Z = makeColumns("Z") as Array<keyof SheetRawCells>;

export async function runQualificationBacktest(
  input: QualificationBacktestInput,
  judgeRunner: JudgeRunner = runQualificationJudge,
  sheetReader: SheetReader = readSheet2Rows,
): Promise<QualificationBacktestResult> {
  const spreadsheetId = cleanSpreadsheetId(input.spreadsheetId);
  const tabName = cleanText(input.tabName, SCP_QUALIFICATION_REVIEW_TAB_NAME, 120);
  const startRow = boundedInteger(input.startRow, SCP_QUALIFICATION_REVIEW_START_ROW, 1, 100_000);
  const dryRun = input.dryRun !== false;
  if (!dryRun && !isFirestoreEmulator()) {
    const error = new Error("production qualification backtest writes are disabled; use dryRun or run against demo-flu emulator");
    Object.assign(error, { code: "failed-precondition", errorCode: "run_qualification_backtest_production_qualification_backtest_writes" });
    throw error;
  }

  const inputRows = parseInputRows(input.rows, startRow);
  const readMode: QualificationBacktestReadMode = inputRows ? "input_rows" : "sheets_api";
  const rows = inputRows ?? await sheetReader({ spreadsheetId, tabName, startRow });
  const parsed = parseSheet2QualificationRows(rows, { spreadsheetId });
  const providedPredictions = parsePredictions(input.predictions);
  const predictions = input.judgeMissing === true
    ? await fillMissingPredictions(parsed.examples, providedPredictions, input, judgeRunner)
    : providedPredictions;
  const evaluation = evaluateQualificationBacktest(parsed.examples, predictions, {
    minPrecision: boundedNumber(input.minPrecision, 0.9, 0, 1),
    minLabelCount: boundedInteger(input.minLabelCount, 20, 1, 10_000),
    minAutoRejectCount: boundedInteger(input.minAutoRejectCount, 1, 1, 10_000),
    nowIso: parseDate(input.nowIso, new Date()).toISOString(),
  });
  const result: QualificationBacktestResult = {
    mode: dryRun ? "dry_run" : "emulator_write",
    readMode,
    spreadsheetId,
    tabName,
    rowCount: rows.length,
    labeledCount: parsed.examples.length,
    passCount: parsed.passCount,
    failCount: parsed.failCount,
    excludedCount: parsed.excludedCount,
    blankCount: parsed.blankCount,
    missingPredictionCount: evaluation.missingPredictionCount,
    metrics: evaluation.metrics,
    thresholdLock: evaluation.thresholdLock,
    examples: parsed.examples.map((example) => ({
      rowNumber: example.rowNumber,
      schemaGeneration: example.schemaGeneration,
      leadId: example.leadId,
      expectedLabel: example.expectedLabel,
      expectedMarker: example.expectedMarker,
      humanReason: example.humanReason,
    })),
    runRef: null,
  };

  if (!dryRun) {
    const runRef = adminDb.collection(QUALIFICATION_BACKTEST_RUNS_COLLECTION).doc(safeDocId(`qualification:${evaluation.thresholdLock.lockedAtIso ?? new Date().toISOString()}`));
    await runRef.set({
      ...result,
      id: runRef.id,
      requestedBy: input.requestedBy,
      createdAt: FieldValue.serverTimestamp(),
      source: { spreadsheetId, tabName, range: SHEET2_RANGE_WIDTH },
    }, { merge: true });
    result.runRef = runRef.path;
    // Only a real sheets_api run may issue the auto_ai approval stamp. A run over
    // client-supplied input_rows must never unlock auto_ai (P1-9): a manager could
    // otherwise feed a hand-crafted pass/fail set to forge the gate. The stamp is
    // written per-stage under `qualification` so it can never open videoReview (P0-5).
    if (evaluation.thresholdLock.locked && evaluation.thresholdLock.lockedAtIso && readMode === "sheets_api") {
      const stamp = {
        passedAtIso: evaluation.thresholdLock.lockedAtIso,
        readMode,
        rowCount: rows.length,
        spreadsheetId,
      };
      const batch = adminDb.batch();
      batch.set(adminDb.doc(SCP_AUTOMATION_SETTINGS_DOC), {
        lastBacktestPassedAt: { qualification: stamp },
        updatedAtIso: evaluation.thresholdLock.lockedAtIso,
        updatedBy: input.requestedBy,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      batch.set(adminDb.collection(SCP_AUTOMATION_AUDIT_COLLECTION).doc(), {
        action: "qualification_backtest.auto_ai_gate.locked",
        stage: "qualification",
        readMode,
        rowCount: rows.length,
        spreadsheetId,
        runRef: runRef.path,
        thresholdLock: evaluation.thresholdLock,
        requestedBy: input.requestedBy,
        createdAtIso: evaluation.thresholdLock.lockedAtIso,
        createdAt: FieldValue.serverTimestamp(),
      });
      await batch.commit();
    }
  }

  return result;
}

export function parseSheet2QualificationRows(
  rows: BacktestRow[],
  options: { spreadsheetId?: string } = {},
): { examples: QualificationBacktestExample[]; passCount: number; failCount: number; excludedCount: number; blankCount: number } {
  const sourceId = sourceIdForGoogleSheet(options.spreadsheetId ?? SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID);
  const examples: QualificationBacktestExample[] = [];
  let excludedCount = 0;
  let blankCount = 0;

  for (const row of rows.slice(0, MAX_QUALIFICATION_BACKTEST_ROWS)) {
    if (looksLikeHeader(row.cells)) continue;
    const parsed = parseLabelCells(row.cells);
    if (parsed.kind === "excluded") {
      excludedCount += 1;
      continue;
    }
    if (parsed.kind === "blank") {
      blankCount += 1;
      continue;
    }
    if (parsed.kind !== "pass" && parsed.kind !== "fail") continue;
    const rawAtoZ = toRawAtoZ(row.cells);
    const applicant = normalizeSheetApplicant(rawAtoZ);
    const leadId = leadIdForGoogleSheetRow(applicant, sourceId, row.rowNumber);
    const metrics = normalizeBacktestMetrics(row.cells);
    const lead: BacktestLead = {
      id: leadId,
      rowNumber: row.rowNumber,
      ...applicant,
      applicant,
      metrics,
    };
    examples.push({
      rowNumber: row.rowNumber,
      schemaGeneration: parsed.schemaGeneration,
      leadId,
      lead,
      expectedLabel: parsed.kind,
      expectedMarker: parsed.marker,
      humanReason: parsed.reason,
    });
  }

  return {
    examples,
    passCount: examples.filter((example) => example.expectedLabel === "pass").length,
    failCount: examples.filter((example) => example.expectedLabel === "fail").length,
    excludedCount,
    blankCount,
  };
}

export function evaluateQualificationBacktest(
  examples: QualificationBacktestExample[],
  predictions: QualificationBacktestPrediction[],
  options: { minPrecision?: number; minLabelCount?: number; minAutoRejectCount?: number; nowIso?: string } = {},
): { metrics: QualificationBacktestMetrics; thresholdLock: QualificationThresholdLock; missingPredictionCount: number } {
  const byKey = predictionMap(predictions);
  const confusion = {
    pass: { pass: 0, fail: 0, hold: 0 },
    fail: { pass: 0, fail: 0, hold: 0 },
  };
  let missingPredictionCount = 0;
  const scored: Array<{ actual: QualificationBacktestLabel; prediction: QualificationBacktestPrediction }> = [];

  for (const example of examples) {
    const prediction = byKey.get(String(example.rowNumber)) ?? byKey.get(example.leadId);
    if (!prediction) {
      missingPredictionCount += 1;
      confusion[example.expectedLabel].hold += 1;
      continue;
    }
    const verdict = prediction.verdict === "pass" || prediction.verdict === "fail" ? prediction.verdict : "hold";
    confusion[example.expectedLabel][verdict] += 1;
    scored.push({ actual: example.expectedLabel, prediction });
  }

  const failPrecision = ratio(confusion.fail.fail, confusion.fail.fail + confusion.pass.fail);
  const failRecall = ratio(confusion.fail.fail, confusion.fail.pass + confusion.fail.fail + confusion.fail.hold);
  const passPrecision = ratio(confusion.pass.pass, confusion.pass.pass + confusion.fail.pass);
  const passRecall = ratio(confusion.pass.pass, confusion.pass.pass + confusion.pass.fail + confusion.pass.hold);
  const holdCount = confusion.pass.hold + confusion.fail.hold;
  const total = examples.length;
  const thresholdCandidates = buildThresholdCandidates(scored);
  const thresholdLock = chooseThresholdLock({
    candidates: thresholdCandidates,
    sampleSize: total,
    passCount: examples.filter((example) => example.expectedLabel === "pass").length,
    failCount: examples.filter((example) => example.expectedLabel === "fail").length,
    minPrecision: options.minPrecision ?? 0.9,
    minLabelCount: options.minLabelCount ?? 20,
    minAutoRejectCount: options.minAutoRejectCount ?? 1,
    nowIso: options.nowIso ?? new Date().toISOString(),
  });

  return {
    metrics: {
      confusion,
      verdictMetrics: {
        failPrecision,
        failRecall,
        failF1: f1(failPrecision, failRecall),
        passPrecision,
        passRecall,
        holdRate: ratio(holdCount, total),
      },
      thresholdCandidates,
    },
    thresholdLock,
    missingPredictionCount,
  };
}

async function fillMissingPredictions(
  examples: QualificationBacktestExample[],
  predictions: QualificationBacktestPrediction[],
  input: QualificationBacktestInput,
  judgeRunner: JudgeRunner,
): Promise<QualificationBacktestPrediction[]> {
  const byKey = predictionMap(predictions);
  const filled = [...predictions];
  for (const example of examples) {
    if (byKey.has(String(example.rowNumber)) || byKey.has(example.leadId)) continue;
    const judged = await judgeRunner({
      dryRun: true,
      leads: [example.lead],
      requestedBy: input.requestedBy,
      nowIso: input.nowIso,
    });
    const recommendation = judged.results[0]?.aiRecommendation;
    if (!recommendation) continue;
    filled.push({
      rowNumber: example.rowNumber,
      leadId: example.leadId,
      verdict: recommendation.verdict,
      rejectionProbability: recommendation.rejectionProbability,
      reasons: recommendation.reasons,
      policyFlags: recommendation.policyFlags,
      missingFields: recommendation.missingFields,
    });
  }
  return filled;
}

function parseLabelCells(cells: Record<string, string>): { kind: QualificationBacktestLabel; marker: string; reason: string; schemaGeneration: "script_v2" | "manual_v1" } | { kind: QualificationBacktestExcludedLabel; marker: string } {
  const newMarker = cleanText(cells.AG, "", 200);
  const oldMarker = cleanText(cells.AJ, "", 200);
  const newLabel = parseQualificationLabel(newMarker);
  if (newLabel === "pass" || newLabel === "fail") {
    return { kind: newLabel, marker: newMarker, reason: cleanText(cells.AH, "", 500), schemaGeneration: "script_v2" };
  }
  if (newLabel === "excluded") return { kind: "excluded", marker: newMarker };
  const oldLabel = parseQualificationLabel(oldMarker);
  if (oldLabel === "pass" || oldLabel === "fail") {
    return { kind: oldLabel, marker: oldMarker, reason: cleanText(cells.AK, "", 500), schemaGeneration: "manual_v1" };
  }
  if (oldLabel === "excluded") return { kind: "excluded", marker: oldMarker };
  return { kind: "blank", marker: newMarker || oldMarker };
}

function parseQualificationLabel(value: string): QualificationBacktestLabel | QualificationBacktestExcludedLabel {
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  if (!normalized) return "blank";
  if (["o", "ok", "pass", "passed", "approved", "approval", "합격"].includes(normalized)) return "pass";
  if (["x", "fail", "failed", "reject", "rejected", "disapproved", "불합격"].includes(normalized)) return "fail";
  if (/모집대상아님|대상아님|nottarget|outofscope|n\/a|na/.test(normalized)) return "excluded";
  return "blank";
}

function normalizeBacktestMetrics(cells: Record<string, string>): Partial<ProgramSheetLeadMetrics> {
  const videoCount = parseTriplet(cells.AB);
  const uploadFreq = parseTriplet(cells.AC);
  const longViews = parseStats(cells.AD);
  const shortViews = parseStats(cells.AE);
  const engagement = parseTriplet(cells.AF);
  return {
    subscribers: numberFromText(cells.AA),
    hiddenSubscribers: cleanText(cells.AA, "", 50) === "",
    lookbackDays: 90,
    shortMaxSeconds: 180,
    videoCount,
    uploadFreq,
    longViews,
    shortViews,
    totalViews: {
      median: Math.max(longViews.median, shortViews.median),
      mean: Math.max(longViews.mean, shortViews.mean),
      max: Math.max(longViews.max, shortViews.max),
    },
    engagement,
    source: "youtube_data_api_v3",
  };
}

function parsePredictions(value: unknown): QualificationBacktestPrediction[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_QUALIFICATION_BACKTEST_ROWS).map((item) => {
    const record = asRecord(item);
    const verdict = record.verdict === "pass" || record.verdict === "fail" || record.verdict === "hold" ? record.verdict : "hold";
    return {
      rowNumber: Number.isFinite(Number(record.rowNumber)) ? Number(record.rowNumber) : undefined,
      leadId: typeof record.leadId === "string" ? safeDocId(record.leadId) : undefined,
      verdict,
      rejectionProbability: clampPercent(record.rejectionProbability),
      reasons: stringList(record.reasons),
      policyFlags: stringList(record.policyFlags),
      missingFields: stringList(record.missingFields),
    };
  });
}

function predictionMap(predictions: QualificationBacktestPrediction[]): Map<string, QualificationBacktestPrediction> {
  const map = new Map<string, QualificationBacktestPrediction>();
  for (const prediction of predictions) {
    if (typeof prediction.rowNumber === "number") map.set(String(prediction.rowNumber), prediction);
    if (prediction.leadId) map.set(prediction.leadId, prediction);
  }
  return map;
}

function buildThresholdCandidates(scored: Array<{ actual: QualificationBacktestLabel; prediction: QualificationBacktestPrediction }>): ThresholdCandidate[] {
  const candidates: ThresholdCandidate[] = [];
  for (let threshold = 0; threshold <= 100; threshold += 1) {
    let trueRejectCount = 0;
    let falseRejectCount = 0;
    let actualFailCount = 0;
    let actualPassCount = 0;
    for (const item of scored) {
      if (item.actual === "fail") actualFailCount += 1;
      else actualPassCount += 1;
      const autoReject = item.prediction.rejectionProbability >= threshold;
      if (!autoReject) continue;
      if (item.actual === "fail") trueRejectCount += 1;
      else falseRejectCount += 1;
    }
    const autoRejectCount = trueRejectCount + falseRejectCount;
    const precision = ratio(trueRejectCount, autoRejectCount);
    const recall = ratio(trueRejectCount, actualFailCount);
    candidates.push({
      threshold,
      precision,
      recall,
      f1: f1(precision, recall),
      falsePositiveRate: ratio(falseRejectCount, actualPassCount),
      autoRejectCount,
      trueRejectCount,
      falseRejectCount,
    });
  }
  return candidates;
}

function chooseThresholdLock(input: {
  candidates: ThresholdCandidate[];
  sampleSize: number;
  passCount: number;
  failCount: number;
  minPrecision: number;
  minLabelCount: number;
  minAutoRejectCount: number;
  nowIso: string;
}): QualificationThresholdLock {
  const criteria = {
    minPrecision: input.minPrecision,
    minLabelCount: input.minLabelCount,
    minAutoRejectCount: input.minAutoRejectCount,
  };
  if (input.sampleSize < input.minLabelCount || input.passCount === 0 || input.failCount === 0) {
    return {
      locked: false,
      stage: "qualification",
      action: "auto_reject",
      threshold: null,
      criteria,
      metricsAtThreshold: null,
      reason: "insufficient_labeled_sample",
      sampleSize: input.sampleSize,
      passCount: input.passCount,
      failCount: input.failCount,
      lockedAtIso: null,
    };
  }
  const eligible = input.candidates
    .filter((candidate) => candidate.precision >= input.minPrecision && candidate.autoRejectCount >= input.minAutoRejectCount)
    .sort((a, b) => b.f1 - a.f1 || b.precision - a.precision || b.recall - a.recall || b.threshold - a.threshold);
  const selected = eligible[0] ?? null;
  return {
    locked: Boolean(selected),
    stage: "qualification",
    action: "auto_reject",
    threshold: selected?.threshold ?? null,
    criteria,
    metricsAtThreshold: selected,
    reason: selected ? "precision_threshold_locked" : "no_threshold_met_precision_floor",
    sampleSize: input.sampleSize,
    passCount: input.passCount,
    failCount: input.failCount,
    lockedAtIso: selected ? input.nowIso : null,
  };
}

async function readSheet2Rows(input: { spreadsheetId: string; tabName: string; startRow: number }): Promise<BacktestRow[]> {
  if (
    input.spreadsheetId !== SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID ||
    input.tabName !== SCP_QUALIFICATION_REVIEW_TAB_NAME
  ) {
    const error = new Error(
      "Qualification backtest live reads require the reviewed spreadsheet and tab contract.",
    );
    Object.assign(error, { code: "failed-precondition", errorCode: "read_sheet2_rows_qualification_backtest_live_reads_require" });
    throw error;
  }
  return readCanonicalScpQualificationSheetRows({ startRow: input.startRow });
}

function parseInputRows(value: unknown, startRow: number): BacktestRow[] | null {
  if (!Array.isArray(value)) return null;
  return value.slice(0, MAX_QUALIFICATION_BACKTEST_ROWS).map((row, index) => {
    const record = asRecord(row);
    const explicit = boundedInteger(record.rowNumber, Number.NaN, 1, 100_000);
    const cellsSource = record.cells ?? row;
    return {
      rowNumber: Number.isFinite(explicit) ? explicit : startRow + index,
      cells: cellsToColumns(cellsSource),
    };
  });
}

function cellsToColumns(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(LETTER_COLUMNS.map((column, index) => [column, stringifyCell(value[index])])) as Record<string, string>;
  }
  const record = asRecord(value);
  if (Array.isArray(record.cells) || (record.cells && typeof record.cells === "object")) return cellsToColumns(record.cells);
  return Object.fromEntries(LETTER_COLUMNS.map((column) => [column, stringifyCell(record[column])])) as Record<string, string>;
}

function toRawAtoZ(cells: Record<string, string>): SheetRawCells {
  return Object.fromEntries(RAW_A_TO_Z.map((column) => [column, cells[column] ?? ""])) as SheetRawCells;
}

function looksLikeHeader(cells: Record<string, string>): boolean {
  return (
    /비고/i.test(cells.AG ?? "") ||
    /비고/i.test(cells.AJ ?? "") ||
    /사유/i.test(cells.AH ?? "") ||
    /사유/i.test(cells.AK ?? "") ||
    /구독자/i.test(cells.AA ?? "") ||
    /업로드빈도/i.test(cells.AC ?? "") ||
    /커스텀링크/i.test(cells.AI ?? "")
  );
}

function parseTriplet(value: unknown): { long: number; short: number; total: number } {
  const numbers = numbersFromText(value);
  if (numbers.length >= 3) return { long: numbers[0], short: numbers[1], total: numbers[2] };
  if (numbers.length === 2) return { long: numbers[0], short: numbers[1], total: numbers[0] + numbers[1] };
  const single = numbers[0] ?? 0;
  return { long: 0, short: 0, total: single };
}

function parseStats(value: unknown): { median: number; mean: number; max: number } {
  const numbers = numbersFromText(value);
  if (numbers.length >= 3) return { median: numbers[0], mean: numbers[1], max: numbers[2] };
  const single = numbers[0] ?? 0;
  return { median: single, mean: single, max: single };
}

function numbersFromText(value: unknown): number[] {
  const text = cleanText(value, "", 2_000).replace(/,/g, "");
  const matches = text.match(/\d+(?:\.\d+)?\s*[kKmM]?/g) ?? [];
  return matches.map(numberFromText).filter((number) => Number.isFinite(number));
}

function numberFromText(value: unknown): number {
  const text = cleanText(value, "", 100).replace(/,/g, "").trim();
  const match = text.match(/(\d+(?:\.\d+)?)(\s*[kKmM])?/);
  if (!match) return 0;
  const multiplier = match[2]?.trim().toLowerCase() === "m" ? 1_000_000 : match[2]?.trim().toLowerCase() === "k" ? 1_000 : 1;
  return Number(match[1]) * multiplier;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function clampPercent(value: unknown): number {
  return Math.max(0, Math.min(100, boundedNumber(value, 0, 0, 100)));
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : 0;
}

function f1(precision: number, recall: number): number {
  return precision + recall > 0 ? Number(((2 * precision * recall) / (precision + recall)).toFixed(6)) : 0;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 120)) : [];
}

function cleanSpreadsheetId(value: unknown): string {
  const raw = asString(value, SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID);
  return raw.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 160) || SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID;
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  const raw = typeof value === "string" ? value : value === null || value === undefined ? fallback : String(value);
  return raw.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim().slice(0, 2_000);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value).slice(0, 2_000);
}

function makeColumns(lastColumn: "Z" | "AK"): string[] {
  const columns: string[] = [];
  for (let index = 0; index < 26; index += 1) columns.push(String.fromCharCode("A".charCodeAt(0) + index));
  if (lastColumn === "AK") {
    for (let index = 0; index <= 10; index += 1) columns.push(`A${String.fromCharCode("A".charCodeAt(0) + index)}`);
  }
  return columns;
}

function parseDate(value: unknown, fallback: Date): Date {
  if (typeof value !== "string") return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function isFirestoreEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true" || Boolean(process.env.FIRESTORE_EMULATOR_HOST);
}

export function hashBacktestExamples(examples: QualificationBacktestExample[]): string {
  return createHash("sha256").update(JSON.stringify(examples.map((example) => ({ rowNumber: example.rowNumber, leadId: example.leadId, expectedLabel: example.expectedLabel })))).digest("hex");
}
