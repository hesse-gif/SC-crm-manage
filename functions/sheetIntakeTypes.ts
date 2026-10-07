export type SheetIntakeSourceType = "google_sheet";
export type IntakeSourceFormat = "google_sheet" | "xlsx" | "csv";
export type SheetIntakeMode =
  | "dry_run"
  | "emulator_write"
  | "staging_write"
  | "production_write";
export type SheetIntakeReadMode = "input_rows" | "sheets_api";
export type SheetSyncStatus = "success" | "blocked" | "error" | "conflict";
export type SheetSourceDomain =
  | "scp_apply"
  | "participant_selection"
  | "participant_registry"
  | "content_review"
  | "staging_fixture";
export type SheetProjectionStrategy =
  | "applicant_projection"
  | "participant_registry_projection"
  | "video_submission_bridge";
export type RawCellColumn =
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "K"
  | "L"
  | "M"
  | "N"
  | "O"
  | "P"
  | "Q"
  | "R"
  | "S"
  | "T"
  | "U"
  | "V"
  | "W"
  | "X"
  | "Y"
  | "Z";

export const RAW_CELL_COLUMNS: readonly RawCellColumn[] = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z",
] as const;

export type SheetRawCells = Record<RawCellColumn, string>;

/**
 * Normalized header-name → field mapping keys. Applicant fields come from
 * Sheet1 A:Z; metric/judgement fields cover both Sheet2 header generations
 * (script_v2 and manual_v1) so drift and mapping share one vocabulary.
 */
export type IntakeFieldKey =
  | keyof ProgramSheetLeadApplicant
  | "consent"
  | "subscribers"
  | "videoCount"
  | "uploadFreq"
  | "longViews"
  | "shortViews"
  | "totalViews"
  | "engagement"
  | "verdict"
  | "reason"
  | "customLink"
  | "mail";

export type SheetHeaderAliases = Partial<
  Record<IntakeFieldKey, readonly string[]>
>;

export interface SheetHeaderMapping {
  byField: Partial<Record<IntakeFieldKey, RawCellColumn>>;
  unmappedHeaders: string[];
  mappedFieldCount: number;
  // Opt-in hybrid mode (Sheet2 hotfix): fields left unmapped by the header
  // (or all fields when no header row exists) resolve via
  // POSITIONAL_APPLICANT_COLUMNS instead of staying blank. Value-level guards
  // (sanitizeApplicantName TRUE/FALSE/numeric) still apply. Sheet1's default
  // path is unaffected when this flag is absent/false.
  positionalFallback?: boolean;
}

export interface SheetSyncErrorState {
  code: "schema_drift" | "unmapped_required_headers";
  message: string;
  expectedFingerprint: string | null;
  actualFingerprint: string;
  unmappedHeaders: string[];
  missingFields: string[];
}

export interface SheetConflictState {
  code: "duplicate_logical_identity" | "current_revision_conflict";
  message: string;
  masked: {
    count: number;
    logicalIds: string[];
  };
}

export interface SheetSourceContract {
  sourceId: string;
  spreadsheetId: string;
  sheetId: string | null;
  gid: string | null;
  resolvedTabName: string;
  schemaFingerprint: string;
  domain: SheetSourceDomain;
  projectionStrategy: SheetProjectionStrategy;
  canonicalProgramId: string;
}

export interface SheetIntakeCursor {
  startRow: number;
  rowCount: number;
  nextRow: number;
  lastRunId: string;
  status: SheetSyncStatus;
}

export type SheetCutoverState =
  | "shadow"
  | "dual_read"
  | "primary"
  | "rollbackable_primary"
  | "retired";

export interface SheetCutoverRecord {
  state: SheetCutoverState;
  version: number;
  owner: string;
  enteredAtIso: string;
  updatedAtIso: string;
  targetExitAt: string | null;
  rollbackCheckpoint: SheetCutoverState | null;
  lastRollbackAtIso: string | null;
}

export interface IntakeSourceRecord {
  id: string;
  sourceType: SheetIntakeSourceType;
  spreadsheetId: string;
  tabName: string;
  firstTabPolicy: "metadata_order";
  startRow: number;
  status: "active";
  syncMode: "poll";
  gid: string | null;
  tabNamePattern: string | null;
  headerAliases: Record<string, string[]> | null;
  lastSchemaFingerprint: string | null;
  sourceContract?: SheetSourceContract;
  cursor?: SheetIntakeCursor;
  cutover?: SheetCutoverRecord;
  sourceVersion?: number;
  projectionRevision?: number;
  publicProjections?: Partial<Record<
    "scpQualificationRows" | "scpVideoRows",
    {
      schemaVersion: string;
      datasetKey: string;
      sourceId: string;
      generation: number;
      rowCount: number;
      canonicalFingerprint: string;
      sourceVersion: number;
      cutoverVersion: number;
      projectionRevision: number;
      completedAtIso: string;
    }
  >>;
  reconciliationVersion?: number;
  lastReconciliationRef?: string | null;
  lastSyncRunId?: string | null;
  lastOperationalSync?: {
    operationId: string;
    runId: string;
    sourceVersion: number;
    originFingerprint: string;
  } | null;
  lastSyncStatus?: SheetSyncStatus | null;
  lastSyncAtIso?: string | null;
  updatedAtIso: string;
  updatedBy: string;
}

export interface SheetSyncRunRecord {
  id: string;
  sourceId: string;
  spreadsheetId: string;
  tabName: string;
  cursor: { startRow: number; rowCount: number; nextRow: number };
  rowCount: number;
  status: SheetSyncStatus;
  mode: SheetIntakeMode;
  readMode: SheetIntakeReadMode;
  schemaFingerprint: string;
  originFingerprint?: string;
  operationId?: string | null;
  sourceContract?: SheetSourceContract;
  errorState: SheetSyncErrorState | null;
  conflictState?: SheetConflictState | null;
  unmappedHeaders: string[];
  insertedRawRows: number;
  duplicateRawRows: number;
  normalizedLeadCount: number;
  rawRowRefs: string[];
  leadRefs: string[];
  startedAtIso: string;
  finishedAtIso: string;
  requestedBy: string;
}

export interface IntakeRowFetchContext {
  sourceKey?: string;
  spreadsheetId: string;
  tabName: string;
  gid: string | null;
  startRow: number;
  tabNamePattern: string | null;
}

export interface IntakeRowFetchResult {
  headerCells: SheetRawCells | null;
  rows: Array<{ rowNumber: number; cells: SheetRawCells }>;
  resolvedTabName: string;
  captureFingerprint?: string;
}

/**
 * Source-format adapter: every intake format (Google Sheets, uploaded xlsx,
 * csv) resolves to the same header + A:Z row shape so the normalizer stays
 * format-agnostic. Google Sheets is the first implementation; xlsx/csv
 * adapters are tracked in docs/GAPS.md.
 */
export interface IntakeRowSource {
  format: IntakeSourceFormat;
  fetchRows(context: IntakeRowFetchContext): Promise<IntakeRowFetchResult>;
}

export interface SheetRawRowRecord {
  id: string;
  sourceId: string;
  syncRunId: string;
  spreadsheetId: string;
  tabName: string;
  rowNumber: number;
  rowHash: string;
  rawCells: SheetRawCells;
  capturedAtIso: string;
  immutable: true;
  sourceType: SheetIntakeSourceType;
}

export interface SourceFieldProvenance {
  field: keyof ProgramSheetLeadApplicant;
  sourceRevision: string;
  sourceFingerprint: string;
  sourceHash: string;
  rowNumber: number;
  column: RawCellColumn | null;
  importedAt: string;
}

export interface ProgramSheetLeadApplicant {
  email: string;
  name: string;
  country: string;
  ageGroup: string;
  youtubeUrl: string;
  tiktokUrl: string;
  instagramUrl: string;
  mostViewedUrl: string;
  sponsoredCount: string;
  category: string;
  format: string;
  language: string;
  motivation: string;
  submittedAt: string;
  token: string;
}

export interface ProgramSheetLeadMetricStats {
  median: number;
  mean: number;
  max: number;
}

export interface ProgramSheetLeadMetrics {
  subscribers: number;
  hiddenSubscribers: boolean;
  channelId: string;
  uploadsPlaylistId: string;
  lookbackDays: 90;
  shortMaxSeconds: 180;
  videoCount: { long: number; short: number; total: number };
  uploadFreq: { long: number; short: number; total: number };
  longViews: ProgramSheetLeadMetricStats;
  shortViews: ProgramSheetLeadMetricStats;
  totalViews: ProgramSheetLeadMetricStats;
  engagement: { long: number; short: number; total: number };
  collectedAtIso: string;
  source: "youtube_data_api_v3";
}

export interface ProgramSheetLeadRecord extends ProgramSheetLeadApplicant {
  id: string;
  canonicalProgramId: string;
  programId: string;
  sourceType: SheetIntakeSourceType;
  sourceId: string;
  sourceRef: string;
  sourceContract: SheetSourceContract;
  rowNumber: number;
  rowHash: string;
  sourceRevision?: string;
  sourceFingerprint?: string;
  importedAt?: string;
  lastSeenAt?: string;
  lastReconciledAt?: string | null;
  applicant: ProgramSheetLeadApplicant;
  metrics: ProgramSheetLeadMetrics | null;
  qualificationStatus: "unreviewed";
  latestDecisionRef: null;
  updatedAtIso: string;
}

export interface SheetSourceRowProjectionRecord {
  id: string;
  canonicalProgramId: string;
  programId: string;
  sourceId: string;
  logicalId: string;
  sourceContract: SheetSourceContract;
  sourceRevision: string;
  sourceFingerprint: string;
  sourceHash: string;
  applicant: ProgramSheetLeadApplicant;
  rowProvenance: {
    previous: { rowNumber: number; sourceRevision: string } | null;
    current: { rowNumber: number; sourceRevision: string };
  };
  fieldProvenance: Partial<Record<keyof ProgramSheetLeadApplicant, SourceFieldProvenance>>;
  sourceOwnedFields: Array<keyof ProgramSheetLeadApplicant>;
  sourceOwnership: {
    owner: "sheet_intake";
    sourceHash: string;
    writebackLoopPrevention: true;
    ignoredOutputFields: string[];
  };
  status: "current" | "conflict";
  importedAt: string;
  lastSeenAt: string;
  lastReconciledAt: string | null;
}

export interface PreparedSheetRow {
  rowNumber: number;
  rowHash: string;
  rawDocId: string;
  rawCells: SheetRawCells;
}

export interface PreparedSheetLead {
  docId: string;
  record: ProgramSheetLeadRecord;
}

export interface PreparedSheetProjection {
  docId: string;
  record: SheetSourceRowProjectionRecord;
}
