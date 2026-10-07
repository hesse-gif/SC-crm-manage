import { createHash } from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString } from "./shared";
import {
  leadPath,
  rawRowPath,
  readIntakeSourceConfig,
  writeSheetIntakeRun,
} from "./sheetIntakeRepository";
import {
  RAW_CELL_COLUMNS,
  type IntakeFieldKey,
  type IntakeRowFetchContext,
  type IntakeRowFetchResult,
  type IntakeRowSource,
  type IntakeSourceRecord,
  type PreparedSheetLead,
  type PreparedSheetProjection,
  type PreparedSheetRow,
  type ProgramSheetLeadApplicant,
  type ProgramSheetLeadRecord,
  type RawCellColumn,
  type SheetConflictState,
  type SheetCutoverRecord,
  type SheetCutoverState,
  type SheetHeaderAliases,
  type SheetHeaderMapping,
  type SheetIntakeMode,
  type SheetIntakeReadMode,
  type SheetRawCells,
  type SheetSourceContract,
  type SheetSyncErrorState,
  type SheetSyncRunRecord,
  type SheetSyncStatus,
} from "./sheetIntakeTypes";
import {
  SCP_APPLY_SPREADSHEET_ID,
  SCP_CONTENT_REVIEW_SPREADSHEET_ID,
  SCP_PARTICIPANT_SELECTION_SPREADSHEET_ID,
  canonicalProgramIdForSheetSourceProfile,
  knownSheetSourceProfile,
  resolveKnownSheetSourceProfile,
  resolveSheetIntakeWriteGate,
  validateSheetSourceHeaderContract,
  validateSheetSourceTabContract,
} from "./sheetIntakeRuntime";
import { SCP_CANONICAL_PROGRAM_ID } from "./programCanonical";

export {
  SCP_APPLY_SPREADSHEET_ID,
  SCP_CONTENT_REVIEW_SPREADSHEET_ID,
  SCP_PARTICIPANT_SELECTION_SPREADSHEET_ID,
  knownSheetSourceProfile,
  resolveKnownSheetSourceProfile,
  resolveSheetControlSourceId,
  resolveSheetIntakeWriteGate,
} from "./sheetIntakeRuntime";

export const SCP_APPLY_TAB_NAME = "Super Creator Partners";
// Live tab identity fallback (first-tab gid). Tab renames must not break the
// range read: on 400/404 the gid is resolved back to the current title.
// Override per source via intake_sources.gid or the callable input.
export const SCP_APPLY_GID = "0";
export const SCP_APPLY_START_ROW = 267;
export const MAX_ROWS_PER_SYNC = 250;
export const SHEET_RANGE_WIDTH = "A:Z";
// Fingerprint sentinel used when no header row is available and the parser
// falls back to the legacy positional A:Z mapping.
export const POSITIONAL_SCHEMA_FINGERPRINT = "positional-a-z-v1";

type SheetCaptureFingerprint = {
  spreadsheetId: string;
  tabName: string;
  gid: string | null;
  startRow: number;
  endRow: number;
  rowCount: number;
  headerFingerprint: string;
  rowsFingerprint: string;
  fingerprint: string;
};

function sheetCaptureFingerprint(input: {
  spreadsheetId: string;
  tabName: string;
  gid: string | null;
  startRow: number;
  endRow: number;
  headerFingerprint: string;
  rowHashes: readonly string[];
}): SheetCaptureFingerprint {
  const rowsFingerprint = createHash("sha256").update(input.rowHashes.join("\n")).digest("hex");
  const stable = {
    schemaVersion: "sheet-capture-v1",
    spreadsheetId: input.spreadsheetId,
    tabName: input.tabName,
    gid: input.gid,
    startRow: input.startRow,
    endRow: input.endRow,
    rowCount: input.rowHashes.length,
    headerFingerprint: input.headerFingerprint,
    rowsFingerprint,
  };
  return {
    ...stable,
    fingerprint: createHash("sha256").update(JSON.stringify(stable)).digest("hex"),
  };
}

function assertStableSheetCapture(before: SheetCaptureFingerprint, after: SheetCaptureFingerprint): void {
  if (before.fingerprint === after.fingerprint) return;
  const error = new Error("Google Sheet changed while it was being captured; retry the sync from a new stable snapshot.");
  Object.assign(error, {
    code: "failed-precondition", errorCode: "assert_stable_sheet_capture_google_sheet_changed_it_being",
    expectedFingerprint: before.fingerprint,
    actualFingerprint: after.fingerprint,
  });
  throw error;
}

// Header-name synonym dictionary (P0-3). Sheet1 A:Z applicant headers plus
// both Sheet2 metric/judgement header generations (script_v2 "비고"/"사유" and
// manual_v1 markers) share one vocabulary. Matching is exact after
// normalization — low-confidence headers stay unmapped instead of guessing.
export const DEFAULT_HEADER_ALIASES: SheetHeaderAliases = {
  consent: ["동의", "개인정보 동의", "개인정보 수집 동의", "consent", "agreement"],
  name: ["name", "full name", "creator name", "channel name", "youtube channel name", "이름", "성함", "크리에이터 이름", "채널명", "채널 이름", "유튜브 채널명"],
  email: [
    "email",
    "e-mail",
    "email address",
    "google email",
    "이메일",
    "이메일 주소",
    "구글 이메일",
  ],
  country: ["country", "국가", "거주 국가", "활동 국가"],
  ageGroup: ["age", "age group", "나이", "연령", "연령대"],
  tiktokUrl: ["tiktok", "tiktok url", "tiktok link", "틱톡", "틱톡 링크"],
  instagramUrl: [
    "instagram",
    "instagram url",
    "instagram link",
    "인스타그램",
    "인스타그램 링크",
  ],
  mostViewedUrl: [
    "most viewed",
    "most viewed url",
    "most viewed video",
    "최다 조회 영상",
    "대표 영상",
  ],
  sponsoredCount: [
    "sponsored count",
    "sponsored videos",
    "광고 영상 수",
    "스폰서 영상 수",
    "유료 광고 경험",
  ],
  category: ["category", "content category", "카테고리", "콘텐츠 카테고리", "장르"],
  format: ["format", "content format", "포맷", "콘텐츠 형식", "영상 형식"],
  language: ["language", "언어", "콘텐츠 언어"],
  motivation: ["motivation", "지원 동기", "지원동기", "각오", "하고 싶은 말"],
  youtubeUrl: [
    "youtube",
    "youtube url",
    "youtube link",
    "youtube channel",
    "youtube channel url",
    "channel url",
    "channel link",
    "handle",
    "youtube handle",
    "유튜브",
    "유튜브 url",
    "유튜브 링크",
    "유튜브 채널",
    "채널 url",
    "채널 링크",
    "핸들",
    "유튜브 핸들",
  ],
  submittedAt: ["submitted at", "timestamp", "타임스탬프", "제출 시각", "제출일"],
  token: ["token", "토큰"],
  subscribers: ["subscribers", "subscriber count", "구독자", "구독자 수"],
  videoCount: [
    "video count",
    "영상 수",
    "영상 수 롱/숏/전체",
    "영상수(롱/숏/전체)",
  ],
  uploadFreq: [
    "upload freq",
    "upload frequency",
    "업로드 빈도",
    "업로드빈도",
    "월평균 업로드",
  ],
  longViews: ["long views", "롱폼 조회수", "조회수(롱)"],
  shortViews: ["short views", "숏폼 조회수", "조회수(숏)"],
  totalViews: ["total views", "전체 조회수", "조회수(전체)"],
  engagement: ["engagement", "인게이지먼트", "참여율"],
  verdict: ["verdict", "비고", "판정", "합불", "결과"],
  reason: ["reason", "사유", "불합 사유"],
  customLink: ["custom link", "커스텀 링크", "커스텀링크"],
  mail: ["mail", "메일", "메일 발송", "mail 발송"],
};

// When a header row exists, these fields must resolve or normalization is
// held (허위 매핑 금지 — never silently fall back to positional guessing).
const REQUIRED_HEADER_FIELDS: readonly IntakeFieldKey[] = ["email"];
const SOURCE_OWNED_APPLICANT_FIELDS = [
  "email",
  "name",
  "country",
  "ageGroup",
  "youtubeUrl",
  "tiktokUrl",
  "instagramUrl",
  "mostViewedUrl",
  "sponsoredCount",
  "category",
  "format",
  "language",
  "motivation",
  "submittedAt",
  "token",
] as const satisfies readonly (keyof ProgramSheetLeadApplicant)[];
const WRITEBACK_OUTPUT_FIELDS = [
  "verdict",
  "reason",
  "customLink",
  "mail",
  "metrics",
  "qualificationStatus",
  "latestDecisionRef",
  "finalDecision",
] as const;

const POSITIONAL_APPLICANT_COLUMNS: Record<
  keyof ProgramSheetLeadApplicant,
  RawCellColumn
> = {
  name: "B",
  email: "D",
  country: "E",
  ageGroup: "F",
  tiktokUrl: "G",
  instagramUrl: "H",
  mostViewedUrl: "I",
  sponsoredCount: "J",
  category: "K",
  format: "L",
  language: "M",
  motivation: "N",
  youtubeUrl: "R",
  submittedAt: "Y",
  token: "Z",
};

type RowWithNumber = { rowNumber?: number; cells: SheetRawCells };

export interface SheetIntakeSyncInput {
  sourceKey?: unknown;
  spreadsheetId?: unknown;
  tabName?: unknown;
  gid?: unknown;
  startRow?: unknown;
  rows?: unknown;
  headerRow?: unknown;
  acceptNewSchema?: unknown;
  dryRun?: unknown;
  operationalPreview?: unknown;
  expectedSourceVersion?: unknown;
  expectedOriginFingerprint?: unknown;
  operationId?: unknown;
  requestedBy: string;
}

export interface SheetIntakeSyncResult {
  sourceId: string;
  runId: string;
  mode: SheetIntakeMode;
  readMode: SheetIntakeReadMode;
  status: SheetSyncStatus;
  spreadsheetId: string;
  tabName: string;
  startRow: number;
  rowCount: number;
  sourceVersion: number;
  originFingerprint: string;
  schemaFingerprint: string;
  sourceContract: SheetSourceContract;
  errorState: SheetSyncErrorState | null;
  conflictState: SheetConflictState | null;
  unmappedHeaders: string[];
  insertedRawRows: number;
  duplicateRawRows: number;
  normalizedLeadCount: number;
  rawRowRefs: string[];
  leadRefs: string[];
  recoveredOperation?: boolean;
}

export async function syncSheetIntake(
  input: SheetIntakeSyncInput,
): Promise<SheetIntakeSyncResult> {
  const profileByKey = input.sourceKey !== undefined && input.sourceKey !== null
    ? resolveKnownSheetSourceProfile({ sourceKey: input.sourceKey })
    : null;
  const spreadsheetId = cleanSpreadsheetId(
    input.spreadsheetId ?? profileByKey?.spreadsheetId,
  );
  const dryRun = input.dryRun === true;
  const knownProfile = resolveKnownSheetSourceProfile({
    sourceKey: input.sourceKey,
    spreadsheetId,
  });
  const sourceId = knownProfile?.sourceId ?? sourceIdForGoogleSheet(spreadsheetId);
  if (knownProfile && !knownProfile.syncSupported) {
    const error = new Error(
      `${knownProfile.displayName} must use its dedicated projection engine; applicant intake sync is disabled for this source.`,
    );
    Object.assign(error, { code: "failed-precondition", errorCode: "sync_sheet_intake_must_use_its_dedicated_projection" });
    throw error;
  }
  const writeGate = dryRun
    ? null
    : resolveSheetIntakeWriteGate({
        action: "sync",
        spreadsheetId,
        sourceId,
        sourceKey: knownProfile?.key ?? input.sourceKey,
      });
  // Ordinary fixture dry-runs stay offline. Operational previews intentionally
  // read the source control document so the later apply can CAS the exact
  // source version and cursor that the operator reviewed.
  const operationalPreview = dryRun && input.operationalPreview === true;
  const operationId = internalOperationId(input.operationId);
  const config = dryRun && !operationalPreview
    ? null
    : await readIntakeSourceConfig(sourceId);
  const sourceVersion = boundedInteger(
    config?.sourceVersion,
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (!dryRun && input.expectedSourceVersion !== undefined) {
    const expectedSourceVersion = exactNonNegativeInteger(
      input.expectedSourceVersion,
      "expectedSourceVersion",
    );
    if (expectedSourceVersion !== sourceVersion) {
      if (operationId) {
        const recovered = await recoverOperationalSyncResult({
          sourceId,
          operationId,
          config,
        });
        if (recovered) return recovered;
      }
      throw failedPrecondition(
        "Sheet intake source changed after preview; create a new preview.",
      );
    }
  }
  const authoritativeProgramId = knownProfile
    ? canonicalProgramIdForSheetSourceProfile(knownProfile)
    : writeGate?.canonicalProgramId ?? SCP_CANONICAL_PROGRAM_ID;
  assertConfiguredSourceProgramScope(config?.sourceContract, authoritativeProgramId);
  const tabName = cleanSheetText(
    input.tabName,
    asString(config?.tabName, knownProfile?.tabName ?? SCP_APPLY_TAB_NAME),
    120,
  );
  if (knownProfile && !validateSheetSourceTabContract(knownProfile, tabName).valid) {
    throw failedPrecondition(
      `Sheet tab does not match the reviewed ${knownProfile.key} source contract.`,
    );
  }
  const configCursor = asRecord(config?.cursor);
  const configuredStartRow = boundedInteger(
    config?.startRow,
    knownProfile?.startRow ?? SCP_APPLY_START_ROW,
    1,
    100_000,
  );
  const cursorNextRow = boundedInteger(configCursor.nextRow, Number.NaN, 1, 100_000);
  const defaultStartRow = Number.isFinite(cursorNextRow) ? cursorNextRow : configuredStartRow;
  const startRow = boundedInteger(input.startRow, defaultStartRow, 1, 100_000);
  const gid = cleanGid(input.gid) || cleanGid(config?.gid) || knownProfile?.gid || SCP_APPLY_GID;
  const tabNamePattern = cleanSheetText(
    config?.tabNamePattern,
    knownProfile?.tabNamePattern ?? "",
    200,
  ) || null;
  const aliases = mergeHeaderAliases(config?.headerAliases ?? null);
  const acceptNewSchema = input.acceptNewSchema === true;

  const inputRows = parseInputRows(input.rows);
  const readMode: SheetIntakeReadMode = inputRows ? "input_rows" : "sheets_api";
  let rows: RowWithNumber[];
  let headerCells: SheetRawCells | null;
  let resolvedTabName = tabName;
  if (inputRows) {
    rows = inputRows;
    headerCells = parseHeaderRow(input.headerRow);
  } else {
    const fetched = await googleSheetRowSource.fetchRows({
      sourceKey: knownProfile?.key,
      spreadsheetId,
      tabName,
      gid,
      startRow,
      tabNamePattern,
    });
    rows = fetched.rows;
    headerCells = fetched.headerCells;
    resolvedTabName = fetched.resolvedTabName;
  }

  // Schema drift detection (P0-4/P1-27): fingerprint the normalized header
  // set, compare against the last accepted fingerprint, and hold
  // normalization on mismatch while raw capture continues.
  const headerMapping = headerCells
    ? resolveHeaderMapping(headerCells, aliases)
    : null;
  const schemaFingerprint = headerCells
    ? schemaFingerprintForHeaders(headerCells)
    : POSITIONAL_SCHEMA_FINGERPRINT;
  const lastAcceptedFingerprint = config?.lastSchemaFingerprint;
  const previousFingerprint =
    typeof lastAcceptedFingerprint === "string" && lastAcceptedFingerprint
      ? lastAcceptedFingerprint
      : null;
  const unmappedHeaders = headerMapping?.unmappedHeaders ?? [];
  const missingFields = headerMapping
    ? REQUIRED_HEADER_FIELDS.filter((field) => !headerMapping.byField[field])
    : [];
  let errorState: SheetSyncErrorState | null = null;
  if (headerMapping && missingFields.length > 0) {
    errorState = {
      code: "unmapped_required_headers",
      message: `required header fields are unmapped (${missingFields.join(", ")}); normalization held, raw rows still captured`,
      expectedFingerprint: previousFingerprint,
      actualFingerprint: schemaFingerprint,
      unmappedHeaders,
      missingFields: [...missingFields],
    };
  } else if (
    previousFingerprint &&
    previousFingerprint !== schemaFingerprint &&
    !acceptNewSchema
  ) {
    errorState = {
      code: "schema_drift",
      message:
        "header set changed since the last accepted sync; normalization held, raw rows still captured. Review the sheet and re-run with acceptNewSchema to adopt the new schema",
      expectedFingerprint: previousFingerprint,
      actualFingerprint: schemaFingerprint,
      unmappedHeaders,
      missingFields: [],
    };
  }

  const nowIso = new Date().toISOString();
  const runId = operationId || adminDb.collection("sheet_sync_runs").doc().id;
  const preparedRows = prepareSheetRows({ sourceId, startRow, rows });
  const sourceContract: SheetSourceContract = {
    sourceId,
    spreadsheetId,
    sheetId: gid || null,
    gid: gid || null,
    resolvedTabName,
    schemaFingerprint,
    domain: knownProfile?.domain ?? "staging_fixture",
    projectionStrategy: knownProfile?.projectionStrategy ?? "applicant_projection",
    canonicalProgramId: authoritativeProgramId,
  };
  const originFingerprint = createHash("sha256").update(JSON.stringify({
    sourceId,
    sourceVersion,
    spreadsheetId,
    gid: gid || null,
    resolvedTabName,
    startRow,
    schemaFingerprint,
    rows: preparedRows.map((row) => ({
      rowNumber: row.rowNumber,
      rowHash: row.rowHash,
    })),
  })).digest("hex");
  if (
    input.expectedOriginFingerprint !== undefined &&
    cleanHash(input.expectedOriginFingerprint) !== originFingerprint
  ) {
    throw failedPrecondition(
      "Google Sheet rows changed after preview; create a new preview.",
    );
  }
  const preparedLeads = errorState
    ? []
    : preparedRows.map((row) =>
        prepareLead(sourceId, row, nowIso, headerMapping, sourceContract),
      );
  const duplicateConflict = errorState ? null : duplicateLogicalIdentityConflict(preparedLeads);
  const conflictState = duplicateConflict;
  const status: SheetSyncStatus = errorState
    ? "error"
    : conflictState
      ? "conflict"
      : "success";
  const writableLeads = status === "success" ? preparedLeads : [];
  const preparedProjections = status === "success"
    ? preparedRows.map((row, index) =>
        prepareProjection(writableLeads[index], row, nowIso, headerMapping, sourceContract),
      )
    : [];
  const rawRowRefs = preparedRows.map((row) => rawRowPath(row.rawDocId));
  const leadRefs = writableLeads.map((lead) => leadPath(lead.docId));

  if (dryRun) {
    return {
      sourceId,
      runId: "dry-run",
      mode: "dry_run",
      readMode,
      status,
      spreadsheetId,
      tabName: resolvedTabName,
      startRow,
      rowCount: rows.length,
      sourceVersion,
      originFingerprint,
      schemaFingerprint,
      sourceContract,
      errorState,
      conflictState,
      unmappedHeaders,
      insertedRawRows: 0,
      duplicateRawRows: 0,
      normalizedLeadCount: writableLeads.length,
      rawRowRefs,
      leadRefs,
    };
  }

  const source: IntakeSourceRecord = {
    id: sourceId,
    sourceType: "google_sheet",
    spreadsheetId,
    tabName: resolvedTabName,
    firstTabPolicy: "metadata_order",
    startRow,
    status: "active",
    syncMode: "poll",
    gid: gid || null,
    tabNamePattern,
    headerAliases: config?.headerAliases ?? null,
    // The fingerprint baseline only advances on success so a drifted schema
    // keeps failing until it is explicitly accepted.
    lastSchemaFingerprint: errorState
      ? previousFingerprint
      : schemaFingerprint,
    sourceContract,
    // Optimistic concurrency token captured before the Sheet read. The
    // repository rejects the write if a newer sync/cutover committed while
    // this run was parsing rows.
    sourceVersion,
    ...(status === "success"
      ? {
          cursor: {
            startRow,
            rowCount: rows.length,
            nextRow: startRow + rows.length,
            lastRunId: runId,
            status,
          },
        }
      : {}),
    cutover: parseCutoverRecord(config?.cutover, nowIso),
    updatedAtIso: nowIso,
    updatedBy: input.requestedBy,
  };
  const run: SheetSyncRunRecord = {
    id: runId,
    sourceId,
    spreadsheetId,
    tabName: resolvedTabName,
    cursor: {
      startRow,
      rowCount: rows.length,
      nextRow: startRow + rows.length,
    },
    rowCount: rows.length,
    status,
    mode: writeGate!.mode,
    readMode,
    schemaFingerprint,
    originFingerprint,
    operationId,
    sourceContract,
    errorState,
    conflictState,
    unmappedHeaders,
    insertedRawRows: 0,
    duplicateRawRows: 0,
    normalizedLeadCount: writableLeads.length,
    rawRowRefs,
    leadRefs,
    startedAtIso: nowIso,
    finishedAtIso: nowIso,
    requestedBy: input.requestedBy,
  };
  const write = await writeSheetIntakeRun({
    source,
    run,
    preparedRows,
    preparedLeads: writableLeads,
    preparedProjections,
    conflictState,
    operationId,
  });
  // writeSheetIntakeRun commits the source CAS from N to N+1. Returning the
  // committed value keeps normal applies identical to operation recovery and
  // gives downstream projection engines the exact current version to fence.
  const committedSourceVersion = sourceVersion + 1;

  return {
    sourceId,
    runId: write.runId,
    mode: writeGate!.mode,
    readMode,
    status,
    spreadsheetId,
    tabName: resolvedTabName,
    startRow,
    rowCount: rows.length,
    sourceVersion: committedSourceVersion,
    originFingerprint,
    schemaFingerprint,
    sourceContract,
    errorState,
    conflictState,
    unmappedHeaders,
    insertedRawRows: write.insertedRawRows,
    duplicateRawRows: write.duplicateRawRows,
    normalizedLeadCount: writableLeads.length,
    rawRowRefs: write.rawRowRefs,
    leadRefs: write.leadRefs,
  };
}

export function prepareSheetRows(input: {
  sourceId: string;
  startRow: number;
  rows: RowWithNumber[];
}): PreparedSheetRow[] {
  return input.rows.slice(0, MAX_ROWS_PER_SYNC).map((row, index) => {
    const rowNumber = row.rowNumber ?? input.startRow + index;
    const rowHash = sha256AtoZ(row.cells);
    return {
      rowNumber,
      rowHash,
      rawDocId: rawRowDocId(input.sourceId, rowNumber, rowHash),
      rawCells: row.cells,
    };
  });
}

export function normalizeHeaderText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .replace(/[*:]+$/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function mergeHeaderAliases(
  overrides: Record<string, string[]> | null | undefined,
): SheetHeaderAliases {
  if (!overrides) return DEFAULT_HEADER_ALIASES;
  const merged: Record<string, readonly string[]> = {
    ...(DEFAULT_HEADER_ALIASES as Record<string, readonly string[]>),
  };
  for (const [field, names] of Object.entries(overrides)) {
    if (!Array.isArray(names)) continue;
    const extra = names.filter((name) => typeof name === "string");
    merged[field] = [...(merged[field] ?? []), ...extra];
  }
  return merged as SheetHeaderAliases;
}

export function resolveHeaderMapping(
  headerCells: SheetRawCells,
  aliases: SheetHeaderAliases = DEFAULT_HEADER_ALIASES,
): SheetHeaderMapping {
  const index = buildAliasIndex(aliases);
  const byField: Partial<Record<IntakeFieldKey, RawCellColumn>> = {};
  const unmappedHeaders: string[] = [];
  for (const column of RAW_CELL_COLUMNS) {
    const rawHeader = (headerCells[column] ?? "").trim();
    if (!rawHeader) continue;
    const normalized = normalizeHeaderText(rawHeader);
    const field =
      index.get(normalized) ?? index.get(normalized.replace(/\s+/g, ""));
    // Exact alias hits only; unknown headers and duplicate field claims are
    // surfaced instead of being force-mapped.
    if (!field || byField[field]) {
      unmappedHeaders.push(`${column}:${rawHeader.slice(0, 80)}`);
      continue;
    }
    byField[field] = column;
  }
  return {
    byField,
    unmappedHeaders,
    mappedFieldCount: Object.keys(byField).length,
  };
}

// Fingerprint of the normalized header *set* (sorted): column reorders are
// absorbed by header mapping, while renames/additions/removals flag drift.
export function schemaFingerprintForHeaders(
  headerCells: SheetRawCells,
): string {
  const normalized = RAW_CELL_COLUMNS.map((column) =>
    normalizeHeaderText(headerCells[column] ?? ""),
  )
    .filter(Boolean)
    .sort();
  return createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

export function normalizeSheetApplicant(
  rawCells: SheetRawCells,
  mapping?: SheetHeaderMapping | null,
): ProgramSheetLeadApplicant {
  const value = (field: keyof ProgramSheetLeadApplicant): string => {
    const column = mapping
      ? (mapping.byField[field] ??
        (mapping.positionalFallback ? POSITIONAL_APPLICANT_COLUMNS[field] : null))
      : POSITIONAL_APPLICANT_COLUMNS[field];
    return column ? (rawCells[column] ?? "") : "";
  };
  return {
    name: sanitizeApplicantName(value("name")) as string,
    email: value("email").toLowerCase(),
    country: value("country"),
    ageGroup: value("ageGroup"),
    tiktokUrl: value("tiktokUrl"),
    instagramUrl: value("instagramUrl"),
    mostViewedUrl: value("mostViewedUrl"),
    sponsoredCount: value("sponsoredCount"),
    category: value("category"),
    format: value("format"),
    language: value("language"),
    motivation: value("motivation"),
    youtubeUrl: value("youtubeUrl"),
    submittedAt: value("submittedAt"),
    token: value("token"),
  };
}

export function sanitizeApplicantName(value: unknown): string | null {
  const text = cleanSheetText(value, "", 240);
  if (!text) return null;
  const guardText = text.normalize("NFKC").replace(/\s+/g, "");
  if (/^(true|false)$/i.test(guardText)) return null;
  if (/^[0-9]+$/.test(guardText)) return null;
  return text;
}

export function cellsAtoZ(row: unknown): SheetRawCells {
  if (Array.isArray(row)) {
    return Object.fromEntries(
      RAW_CELL_COLUMNS.map((column, index) => [
        column,
        stringifyCell(row[index]),
      ]),
    ) as SheetRawCells;
  }
  const record = asRecord(row);
  if (Array.isArray(record.cells)) return cellsAtoZ(record.cells);
  if (record.cells && typeof record.cells === "object")
    return cellsAtoZ(record.cells);
  return Object.fromEntries(
    RAW_CELL_COLUMNS.map((column) => [column, stringifyCell(record[column])]),
  ) as SheetRawCells;
}

export function sha256AtoZ(rawCells: Record<string, string>): string {
  const stablePayload = JSON.stringify(
    RAW_CELL_COLUMNS.map((column) => rawCells[column] ?? ""),
  );
  return createHash("sha256").update(stablePayload).digest("hex");
}

export function sourceIdForGoogleSheet(spreadsheetId: string): string {
  return safeDocId(`google_sheet:${spreadsheetId}`);
}

// Doc id intentionally excludes tabName (P1-16): a tab rename must keep
// row idempotency intact. Legacy tabName-keyed docs are deduplicated by a
// rowHash lookup in the repository.
export function rawRowDocId(
  sourceId: string,
  rowNumber: number,
  rowHash: string,
): string {
  return safeDocId(`${sourceId}:${rowNumber}:${rowHash.slice(0, 24)}`);
}

export function leadIdForGoogleSheetRow(
  applicant: ProgramSheetLeadApplicant,
  sourceId: string,
  rowNumber: number,
): string {
  const identitySeed =
    applicant.email ||
    applicant.tiktokUrl ||
    applicant.instagramUrl ||
    applicant.youtubeUrl ||
    applicant.name ||
    `${sourceId}:${rowNumber}`;
  return safeDocId(`google_sheet:${identitySeed.toLowerCase()}`);
}

export function safeDocId(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 180) || "item"
  );
}

// IntakeRowSource implementation #1: Google Sheets (P1-15). xlsx/csv
// adapters plug into the same interface (tracked in docs/GAPS.md).
export const googleSheetRowSource: IntakeRowSource = {
  format: "google_sheet",
  fetchRows: readGoogleSheetRowsAtoZ,
};

async function readGoogleSheetRowsAtoZ(
  context: IntakeRowFetchContext,
): Promise<IntakeRowFetchResult> {
  const credentials = sheetCredentials();
  const profile = resolveKnownSheetSourceProfile({
    sourceKey: context.sourceKey,
    spreadsheetId: context.spreadsheetId,
  });
  let resolvedTabName = context.tabName;
  if (context.gid) {
    resolvedTabName = await resolveSheetTitleByGid({
      spreadsheetId: context.spreadsheetId,
      gid: context.gid,
      ...credentials,
    });
    if (!resolvedTabName) {
      throw failedPrecondition(
        `Google Sheets metadata did not resolve reviewed gid ${context.gid}.`,
      );
    }
  }
  if (
    profile &&
    (!validateSheetSourceTabContract(profile, resolvedTabName).valid || context.gid !== profile.gid)
  ) {
    throw failedPrecondition(
      `Google Sheets metadata does not match the reviewed ${profile.key} gid/tab contract.`,
    );
  }
  if (
    context.tabNamePattern &&
    !matchesTabNamePattern(context.tabNamePattern, resolvedTabName)
  ) {
    throw failedPrecondition(
      `gid ${context.gid ?? "none"} resolved tab does not match intake_sources.tabNamePattern`,
    );
  }
  const fetched = await fetchSheetHeaderAndRows({
    spreadsheetId: context.spreadsheetId,
    tabName: resolvedTabName,
    gid: context.gid,
    startRow: context.startRow,
    ...credentials,
  });
  if (!fetched.ok) throwSheetReadError(fetched.status);
  // A second bounded read is the stability fence. It intentionally compares
  // only topology, header, bounds, and row content; timestamps are excluded.
  const confirmation = await fetchSheetHeaderAndRows({
    spreadsheetId: context.spreadsheetId,
    tabName: resolvedTabName,
    gid: context.gid,
    startRow: context.startRow,
    ...credentials,
  });
  if (!confirmation.ok) throwSheetReadError(confirmation.status);
  assertStableSheetCapture(fetched.capture, confirmation.capture);
  if (profile && fetched.headerCells && headerContractFitsAtoZ(profile.headerContract)) {
    const validation = validateSheetSourceHeaderContract(profile, fetched.headerCells);
    if (!validation.valid) {
      throw failedPrecondition(
        `Google Sheets header contract drifted at columns ${[
          ...validation.missingColumns,
          ...validation.mismatchedColumns,
        ].join(",") || "unknown"}.`,
      );
    }
  }
  return {
    headerCells: fetched.headerCells,
    rows: fetched.rows,
    resolvedTabName,
    captureFingerprint: fetched.capture.fingerprint,
  };
}

function sheetCredentials(): { accessToken: string; apiKey: string } {
  const accessToken =
    envString("GOOGLE_SHEETS_ACCESS_TOKEN") || envString("SHEETS_ACCESS_TOKEN");
  const apiKey =
    envString("GOOGLE_SHEETS_API_KEY") || envString("SHEETS_API_KEY");
  if (!accessToken && !apiKey) {
    const error = new Error(
      "Google Sheets credentials are not configured; provide rows in emulator tests or bind GOOGLE_SHEETS_ACCESS_TOKEN/SHEETS_API_KEY",
    );
    Object.assign(error, { code: "failed-precondition", errorCode: "sheet_credentials_google_sheets_credentials_configured_provide" });
    throw error;
  }
  return { accessToken, apiKey };
}

async function fetchSheetHeaderAndRows(input: {
  spreadsheetId: string;
  tabName: string;
  gid: string | null;
  startRow: number;
  accessToken: string;
  apiKey: string;
}): Promise<
  | {
      ok: true;
      headerCells: SheetRawCells | null;
      rows: Array<{ rowNumber: number; cells: SheetRawCells }>;
      capture: ReturnType<typeof sheetCaptureFingerprint>;
    }
  | { ok: false; status: number }
> {
  const headerRange = `${input.tabName}!A1:Z1`;
  const dataRange = `${input.tabName}!A${input.startRow}:Z`;
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values:batchGet`,
  );
  url.searchParams.append("ranges", headerRange);
  url.searchParams.append("ranges", dataRange);
  url.searchParams.set("majorDimension", "ROWS");
  if (input.apiKey && !input.accessToken)
    url.searchParams.set("key", input.apiKey);

  const response = await fetch(url, {
    headers: input.accessToken
      ? { Authorization: `Bearer ${input.accessToken}` }
      : undefined,
  });
  if (!response.ok) return { ok: false, status: response.status };

  const body = (await response.json()) as {
    valueRanges?: Array<{ values?: unknown[] }>;
  };
  const valueRanges = Array.isArray(body.valueRanges) ? body.valueRanges : [];
  const rawHeaderValues = valueRanges[0]?.values;
  const rawDataValues = valueRanges[1]?.values;
  const headerValues = Array.isArray(rawHeaderValues) ? rawHeaderValues : [];
  const dataValues = Array.isArray(rawDataValues) ? rawDataValues : [];
  const headerCells = headerValues.length
    ? parseHeaderRow(headerValues[0])
    : null;
  const rows = dataValues.slice(0, MAX_ROWS_PER_SYNC).map((row, index) => ({
    rowNumber: input.startRow + index,
    cells: cellsAtoZ(row),
  }));
  return {
    ok: true,
    headerCells,
    rows,
    capture: sheetCaptureFingerprint({
      spreadsheetId: input.spreadsheetId,
      tabName: input.tabName,
      gid: input.gid,
      startRow: input.startRow,
      endRow: rows.length ? rows[rows.length - 1].rowNumber : input.startRow - 1,
      headerFingerprint: sha256AtoZ(headerCells ?? cellsAtoZ([])),
      rowHashes: rows.map((row) => sha256AtoZ(row.cells)),
    }),
  };
}

// Mirrors scpSheetReviewService.resolveSheetTitleById (not exported there);
// consolidation into a shared util is tracked in docs/GAPS.md.
async function resolveSheetTitleByGid(input: {
  spreadsheetId: string;
  gid: string;
  accessToken: string;
  apiKey: string;
}): Promise<string> {
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}`,
  );
  url.searchParams.set("includeGridData", "false");
  url.searchParams.set("fields", "sheets.properties(sheetId,title)");
  if (input.apiKey && !input.accessToken)
    url.searchParams.set("key", input.apiKey);
  const response = await fetch(url, {
    headers: input.accessToken
      ? { Authorization: `Bearer ${input.accessToken}` }
      : undefined,
  });
  if (!response.ok) return "";
  const body = (await response.json()) as {
    sheets?: Array<{ properties?: { sheetId?: unknown; title?: unknown } }>;
  };
  const expected = Number(input.gid);
  const match = Array.isArray(body.sheets)
    ? body.sheets.find((sheet) => Number(sheet.properties?.sheetId) === expected)
    : undefined;
  return cleanSheetText(match?.properties?.title, "", 120);
}

function throwSheetReadError(status: number): never {
  const error = new Error(`Google Sheets read failed with HTTP ${status}`);
  Object.assign(error, { code: "failed-precondition", errorCode: "throw_sheet_read_error_google_sheets_read_with_http" });
  throw error;
}

function matchesTabNamePattern(pattern: string, tabName: string): boolean {
  try {
    return new RegExp(pattern).test(tabName);
  } catch {
    return false;
  }
}

function headerContractFitsAtoZ(contract: Readonly<Record<string, string>>): boolean {
  const columns = Object.keys(contract);
  return columns.length > 0 && columns.every((column) => RAW_CELL_COLUMNS.includes(column as RawCellColumn));
}

function failedPrecondition(message: string): Error {
  return Object.assign(new Error(message), { code: "failed-precondition", errorCode: "failed_precondition_unauthorized" });
}

function parseHeaderRow(value: unknown): SheetRawCells | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) && typeof value !== "object") return null;
  const cells = cellsAtoZ(value);
  return Object.values(cells).some((cell) => cell) ? cells : null;
}

function parseInputRows(value: unknown): RowWithNumber[] | null {
  if (!Array.isArray(value)) return null;
  return value.slice(0, MAX_ROWS_PER_SYNC).map((row) => {
    const record = asRecord(row);
    const explicitRowNumber = boundedInteger(
      record.rowNumber,
      Number.NaN,
      1,
      100_000,
    );
    return {
      rowNumber: Number.isFinite(explicitRowNumber)
        ? explicitRowNumber
        : undefined,
      cells: cellsAtoZ(row),
    };
  });
}

function buildAliasIndex(
  aliases: SheetHeaderAliases,
): Map<string, IntakeFieldKey> {
  const index = new Map<string, IntakeFieldKey>();
  for (const [field, names] of Object.entries(aliases) as Array<
    [IntakeFieldKey, readonly string[] | undefined]
  >) {
    for (const name of names ?? []) {
      const normalized = normalizeHeaderText(name);
      if (!normalized) continue;
      if (!index.has(normalized)) index.set(normalized, field);
      const compact = normalized.replace(/\s+/g, "");
      if (compact && !index.has(compact)) index.set(compact, field);
    }
  }
  return index;
}

function prepareLead(
  sourceId: string,
  row: PreparedSheetRow,
  nowIso: string,
  mapping: SheetHeaderMapping | null,
  sourceContract: SheetSourceContract,
): PreparedSheetLead {
  const applicant = normalizeSheetApplicant(row.rawCells, mapping);
  const docId = leadIdForGoogleSheetRow(applicant, sourceId, row.rowNumber);
  const sourceRevision = rawRowPath(row.rawDocId);
  const record: ProgramSheetLeadRecord = {
    id: docId,
    canonicalProgramId: sourceContract.canonicalProgramId,
    programId: sourceContract.canonicalProgramId,
    sourceType: "google_sheet",
    sourceId,
    sourceRef: sourceRevision,
    sourceContract,
    rowNumber: row.rowNumber,
    rowHash: row.rowHash,
    sourceRevision,
    sourceFingerprint: row.rowHash,
    importedAt: nowIso,
    lastSeenAt: nowIso,
    lastReconciledAt: null,
    ...applicant,
    applicant,
    metrics: null,
    qualificationStatus: "unreviewed",
    latestDecisionRef: null,
    updatedAtIso: nowIso,
  };
  return { docId, record };
}

function prepareProjection(
  lead: PreparedSheetLead,
  row: PreparedSheetRow,
  nowIso: string,
  mapping: SheetHeaderMapping | null,
  sourceContract: SheetSourceContract,
): PreparedSheetProjection {
  const sourceRevision = rawRowPath(row.rawDocId);
  const fieldProvenance = Object.fromEntries(
    SOURCE_OWNED_APPLICANT_FIELDS.map((field) => {
      const column = mapping
        ? (mapping.byField[field] ??
          (mapping.positionalFallback ? POSITIONAL_APPLICANT_COLUMNS[field] : null))
        : POSITIONAL_APPLICANT_COLUMNS[field];
      return [
        field,
        {
          field,
          sourceRevision,
          sourceFingerprint: row.rowHash,
          sourceHash: row.rowHash,
          rowNumber: row.rowNumber,
          column,
          importedAt: nowIso,
        },
      ];
    }),
  );
  return {
    docId: lead.docId,
    record: {
      id: lead.docId,
      canonicalProgramId: sourceContract.canonicalProgramId,
      programId: sourceContract.canonicalProgramId,
      sourceId: lead.record.sourceId,
      logicalId: lead.docId,
      sourceContract,
      sourceRevision,
      sourceFingerprint: row.rowHash,
      sourceHash: row.rowHash,
      applicant: lead.record.applicant,
      rowProvenance: {
        previous: null,
        current: { rowNumber: row.rowNumber, sourceRevision },
      },
      fieldProvenance,
      sourceOwnedFields: [...SOURCE_OWNED_APPLICANT_FIELDS],
      sourceOwnership: {
        owner: "sheet_intake",
        sourceHash: row.rowHash,
        writebackLoopPrevention: true,
        ignoredOutputFields: [...WRITEBACK_OUTPUT_FIELDS],
      },
      status: "current",
      importedAt: nowIso,
      lastSeenAt: nowIso,
      lastReconciledAt: null,
    },
  };
}

function assertConfiguredSourceProgramScope(
  storedContract: SheetSourceContract | undefined,
  expectedCanonicalProgramId: string,
): void {
  if (!storedContract || !("canonicalProgramId" in storedContract)) return;
  const raw = typeof storedContract.canonicalProgramId === "string"
    ? storedContract.canonicalProgramId.trim()
    : "";
  if (!raw) {
    throw failedPrecondition(
      "Stored Sheet source contract has a blank canonical programId.",
    );
  }
  if (raw !== expectedCanonicalProgramId) {
    throw failedPrecondition(
      "Stored Sheet source contract conflicts with the reviewed source profile program scope.",
    );
  }
}

function duplicateLogicalIdentityConflict(
  leads: PreparedSheetLead[],
): SheetConflictState | null {
  const counts = new Map<string, number>();
  leads.forEach((lead) => counts.set(lead.docId, (counts.get(lead.docId) ?? 0) + 1));
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([docId]) => docId)
    .sort();
  if (duplicates.length === 0) return null;
  return {
    code: "duplicate_logical_identity",
    message:
      "batch contains duplicate logical applicant identities; normalization held and conflict quarantined",
    masked: {
      count: leads.length,
      logicalIds: duplicates.map(maskStableId),
    },
  };
}

function maskStableId(value: string): string {
  return `id_${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function parseCutoverRecord(value: unknown, nowIso: string): SheetCutoverRecord {
  const record = asRecord(value);
  const state = parseCutoverState(record.state) ?? "shadow";
  const checkpoint = parseCutoverState(record.rollbackCheckpoint);
  const version = boundedInteger(record.version, 0, 0, 1_000_000);
  const updatedAtIso = asString(record.updatedAtIso, nowIso);
  return {
    state,
    version,
    owner: asString(record.owner, "system"),
    enteredAtIso: asString(record.enteredAtIso, updatedAtIso),
    updatedAtIso,
    targetExitAt: asString(record.targetExitAt, "") || null,
    rollbackCheckpoint: checkpoint,
    lastRollbackAtIso: asString(record.lastRollbackAtIso, "") || null,
  };
}

function parseCutoverState(value: unknown): SheetCutoverState | null {
  return value === "shadow" ||
    value === "dual_read" ||
    value === "primary" ||
    value === "rollbackable_primary" ||
    value === "retired"
    ? value
    : null;
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim().slice(0, 2_000);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value).slice(0, 2_000);
}

function cleanSpreadsheetId(value: unknown): string {
  const raw = asString(value, SCP_APPLY_SPREADSHEET_ID);
  return (
    raw.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 160) || SCP_APPLY_SPREADSHEET_ID
  );
}

function cleanSheetText(
  value: unknown,
  fallback: string,
  maxLength: number,
): string {
  const raw = asString(value, fallback);
  return (
    raw.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maxLength) || fallback
  );
}

function cleanGid(value: unknown): string {
  const raw = asString(value, "");
  return raw.replace(/[^0-9]/g, "").slice(0, 20);
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.trunc(value)))
    : fallback;
}

function exactNonNegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw failedPrecondition(`${field} must be a non-negative integer.`);
  }
  return parsed;
}

async function recoverOperationalSyncResult(input: {
  sourceId: string;
  operationId: string;
  config: Partial<IntakeSourceRecord> | null;
}): Promise<SheetIntakeSyncResult | null> {
  const marker = asRecord(input.config?.lastOperationalSync);
  if (asString(marker.operationId) !== input.operationId) return null;
  const runId = asString(marker.runId);
  if (runId !== input.operationId) {
    throw failedPrecondition("Sheet intake operational recovery marker is invalid.");
  }
  const snapshot = await adminDb.collection("sheet_sync_runs").doc(runId).get();
  if (!snapshot.exists) {
    throw failedPrecondition("Sheet intake operational run evidence is missing.");
  }
  const run = asRecord(snapshot.data());
  if (
    asString(run.id) !== runId ||
    asString(run.sourceId) !== input.sourceId ||
    asString(run.operationId) !== input.operationId
  ) {
    throw failedPrecondition("Sheet intake operational run evidence does not match its marker.");
  }
  const originFingerprint = cleanHash(marker.originFingerprint);
  if (!originFingerprint || cleanHash(run.originFingerprint) !== originFingerprint) {
    throw failedPrecondition("Sheet intake operational origin evidence is invalid.");
  }
  const cursor = asRecord(run.cursor);
  const rawRowRefs = stringArray(run.rawRowRefs);
  const leadRefs = stringArray(run.leadRefs);
  return {
    sourceId: input.sourceId,
    runId,
    mode: sheetIntakeMode(run.mode),
    readMode: sheetReadMode(run.readMode),
    status: sheetSyncStatus(run.status),
    spreadsheetId: asString(run.spreadsheetId),
    tabName: asString(run.tabName),
    startRow: boundedInteger(cursor.startRow, 1, 1, Number.MAX_SAFE_INTEGER),
    rowCount: boundedInteger(run.rowCount, 0, 0, MAX_ROWS_PER_SYNC),
    sourceVersion: exactNonNegativeInteger(marker.sourceVersion, "recovered sourceVersion"),
    originFingerprint,
    schemaFingerprint: cleanHash(run.schemaFingerprint) || POSITIONAL_SCHEMA_FINGERPRINT,
    sourceContract: asRecord(run.sourceContract) as unknown as SheetSourceContract,
    errorState: (run.errorState ?? null) as SheetSyncErrorState | null,
    conflictState: (run.conflictState ?? null) as SheetConflictState | null,
    unmappedHeaders: stringArray(run.unmappedHeaders),
    insertedRawRows: boundedInteger(run.insertedRawRows, 0, 0, MAX_ROWS_PER_SYNC),
    duplicateRawRows: boundedInteger(run.duplicateRawRows, 0, 0, MAX_ROWS_PER_SYNC),
    normalizedLeadCount: boundedInteger(run.normalizedLeadCount, 0, 0, MAX_ROWS_PER_SYNC),
    rawRowRefs,
    leadRefs,
    recoveredOperation: true,
  };
}

function internalOperationId(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const normalized = asString(value);
  if (!/^sheet-source-sync-[a-f0-9]{40}$/.test(normalized)) {
    throw failedPrecondition("Internal Sheet intake operationId is invalid.");
  }
  return normalized;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").slice(0, MAX_ROWS_PER_SYNC)
    : [];
}

function sheetIntakeMode(value: unknown): SheetIntakeMode {
  if (
    value === "dry_run" ||
    value === "emulator_write" ||
    value === "staging_write" ||
    value === "production_write"
  ) return value;
  throw failedPrecondition("Recovered Sheet intake mode is invalid.");
}

function sheetReadMode(value: unknown): SheetIntakeReadMode {
  if (value === "input_rows" || value === "sheets_api") return value;
  throw failedPrecondition("Recovered Sheet intake read mode is invalid.");
}

function sheetSyncStatus(value: unknown): SheetSyncStatus {
  if (value === "success" || value === "blocked" || value === "error" || value === "conflict") {
    return value;
  }
  throw failedPrecondition("Recovered Sheet intake status is invalid.");
}

function cleanHash(value: unknown): string {
  const normalized = asString(value).trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
}

function envString(name: string): string {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "";
}
