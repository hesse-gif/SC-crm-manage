import { createHash } from "node:crypto";
import {
  DEFAULT_HEADER_ALIASES,
  leadIdForGoogleSheetRow,
  normalizeHeaderText,
  normalizeSheetApplicant,
  resolveHeaderMapping,
  rawRowDocId,
  safeDocId,
  sha256AtoZ,
  sourceIdForGoogleSheet,
} from "./sheetIntakeService";
import type { ProgramSheetLeadApplicant, ProgramSheetLeadMetrics, SheetHeaderAliases, SheetHeaderMapping, SheetRawCells } from "./sheetIntakeTypes";
import {
  SCP_CONTENT_REVIEW_GID,
  SCP_CONTENT_REVIEW_SPREADSHEET_ID,
  SCP_CONTENT_REVIEW_TAB_NAME,
  SCP_PARTICIPANT_SELECTION_GID,
  SCP_PARTICIPANT_SELECTION_SPREADSHEET_ID,
  SCP_PARTICIPANT_SELECTION_TAB_NAME,
  knownSheetSourceProfileByKey,
  validateSheetSourceHeaderContract,
  validateSheetSourceTabContract,
  type SheetSourceProfile,
} from "./sheetIntakeRuntime";
import { asRecord, asString } from "./shared";
// 2026-09-05 다타이틀: 시트 행의 게임 값도 같은 레지스트리 해석기를 통과한다(분기 없음).
import { resolveSubmissionGameId } from "./programTitles";
// 2026-09-05 P1 리뷰 수리: 운영 오버라이드(settings/program_titles)가 시트 인제스트에도 닿게
// 한다 — 전에는 코드 시드만 봤다.
import { loadProgramTitleRegistry } from "./programTitlesStore";
import { canonicalScpProgramId } from "./scpProgramAlias";

export const SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID = SCP_PARTICIPANT_SELECTION_SPREADSHEET_ID;
export const SCP_QUALIFICATION_REVIEW_TAB_NAME = SCP_PARTICIPANT_SELECTION_TAB_NAME;
export const SCP_QUALIFICATION_REVIEW_GID = SCP_PARTICIPANT_SELECTION_GID;
export const SCP_VIDEO_REVIEW_SPREADSHEET_ID = SCP_CONTENT_REVIEW_SPREADSHEET_ID;
export const SCP_VIDEO_REVIEW_TAB_NAME = SCP_CONTENT_REVIEW_TAB_NAME;
export const SCP_VIDEO_REVIEW_GID = SCP_CONTENT_REVIEW_GID;
export const SHEET3_RANGE_WIDTH = "A:L";
export const MAX_SCP_SHEET_ROWS = 500;
const SHEET2_HEADER_ALIASES: SheetHeaderAliases = {
  ...DEFAULT_HEADER_ALIASES,
  name: [...(DEFAULT_HEADER_ALIASES.name ?? []), "channel", "channel title", "채널명", "채널 이름", "유튜브 채널명"],
  youtubeUrl: [...(DEFAULT_HEADER_ALIASES.youtubeUrl ?? []), "youtube channel link", "youtube handle", "유튜브 채널 링크", "유튜브 핸들"],
};

const SHEET2_HEADER_SCORE_FIELDS: Array<keyof ProgramSheetLeadApplicant> = ["name", "email", "country", "ageGroup", "youtubeUrl", "token"];

const SHEET3_EXPECTED_HEADERS: Record<string, readonly string[]> = {
  A: ["email", "이메일"],
  B: ["app", "game", "app name", "게임", "게임명"],
  C: ["youtube", "youtube url", "youtube link", "유튜브", "유튜브 링크"],
  D: ["tiktok", "tiktok url", "틱톡"],
  E: ["instagram", "instagram url", "인스타그램", "insta", "insta url", "insta_url"],
  F: ["file", "file url", "uploaded file", "mp4", "업로드 파일"],
  G: ["content type", "content_type", "콘텐츠 타입", "콘텐츠 유형"],
  // "summited at"는 실프로드 Sheet3 헤더의 원본 오타(2026-07-06 fail-closed 검출) — 시트는 읽기 전용이라 코드가 수용한다.
  H: ["submitted at", "submitted_at", "timestamp", "제출일", "제출 시각", "summited at", "summited_at"],
  I: ["token", "토큰"],
  J: ["status", "review status", "검수", "상태", "결과"],
  K: ["rejected reason", "rejected_reason", "reason", "반려 사유", "사유"],
  L: ["mail", "메일"],
  // 2026-09-05 다타이틀: 시트가 타이틀 id 를 직접 실을 수 있는 신규 후행 열. 비어 있으면 B 열
  // (게임명)을 레지스트리로 정규화한다 — 기존 시트는 한 칸도 고치지 않아도 동작이 같다.
  M: ["game id", "game_id", "gameid", "게임 id", "게임 아이디", "타이틀 id"],
};

type SheetRow = { rowNumber: number; cells: Record<string, string> };
export type ScpQualificationSheetStatus = "pass" | "fail" | "pending" | "excluded";
export type ScpVideoSheetStatus = "approved" | "rejected" | "pending";

export interface ScpQualificationReviewRow {
  id: string;
  leadId: string;
  rowNumber: number;
  sheetUrl: string;
  sourceType: "google_sheet";
  spreadsheetId: string;
  tabName: string;
  schemaGeneration: "script_v2" | "manual_v1" | "pending" | "excluded";
  status: ScpQualificationSheetStatus;
  qualificationStatus: "pass" | "fail" | "unreviewed" | "excluded";
  expectedLabel: "pass" | "fail" | null;
  expectedMarker: string;
  humanReason: string;
  applicant: ProgramSheetLeadApplicant;
  metrics: Partial<ProgramSheetLeadMetrics>;
  updatedAtIso: string;
  priorReasonKnowledge: ScpQualificationReasonKnowledge;
  sourceId?: string;
  sourceRef?: string;
  rowHash?: string;
  rawCells?: Record<string, string>;
}

export interface ScpQualificationReasonKnowledge {
  passCount: number;
  failCount: number;
  pendingCount: number;
  excludedCount: number;
  topFailReasons: Array<{ reason: string; count: number }>;
  topPassReasons: Array<{ reason: string; count: number }>;
  vocabulary: string[];
}

export interface ScpVideoReviewSheetRow {
  id: string;
  rowNumber: number;
  sheetUrl: string;
  sourceType: "google_sheet";
  spreadsheetId: string;
  tabName: string;
  email: string;
  app: string;
  youtubeUrl: string;
  tiktokUrl: string;
  instagramUrl: string;
  uploadedFileUrl: string;
  contentType: string;
  submittedAtIso: string;
  token: string;
  rawStatus: string;
  status: ScpVideoSheetStatus;
  reviewStatus: "approved" | "rejected" | "pending";
  rejectedReason: string;
  mail: string;
  /** 다타이틀 레지스트리 id(B 열 game_name 정규화 — id 또는 표기 둘 다 수용, 없으면 프로그램 기본 타이틀). */
  gameId: string;
  /** 시트가 레지스트리에 없는 타이틀을 선언했음 — 기본 타이틀로 읽되 사람이 확인해야 한다. */
  gameIdUnresolved: boolean;
  /** gameId 가 선언 해석이 아니라 기본값 스탬프(선언 누락·빈 값·미등록 선언) — 필터 증거 아님. */
  gameIdDefaulted: boolean;
  contentUrls: string[];
  rawCells: Record<string, string>;
  updatedAtIso: string;
}

export async function readScpQualificationReviewRows(input: {
  spreadsheetId?: string;
  tabName?: string;
  startRow?: number;
  endRow?: number;
  rows?: unknown;
  includeRaw?: boolean;
} = {}): Promise<ScpQualificationReviewRow[]> {
  const spreadsheetId = cleanSpreadsheetId(input.spreadsheetId, SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID);
  const tabName = cleanText(input.tabName, SCP_QUALIFICATION_REVIEW_TAB_NAME, 120);
  const startRow = boundedInteger(input.startRow, 1, 1, 100_000);
  const endRow = boundedInteger(input.endRow, Math.min(100_000, startRow + MAX_SCP_SHEET_ROWS - 1), startRow, Math.min(100_000, startRow + MAX_SCP_SHEET_ROWS - 1));
  const fixtureRows = parseInputRows(input.rows, startRow, "AK");
  if (spreadsheetId === SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID) {
    assertRequestedTabContract("participant_selection", tabName);
  } else if (!fixtureRows) {
    throw failedPrecondition("Qualification review live reads require the reviewed spreadsheet contract.");
  }
  const live = fixtureRows
    ? { rows: fixtureRows, resolvedTabName: tabName }
    : await readGoogleSheetRows({
        spreadsheetId,
        tabName,
        sheetId: SCP_QUALIFICATION_REVIEW_GID,
        startRow,
        endRow,
        lastColumn: "AK",
        profile: requiredSourceProfile("participant_selection"),
      });
  return buildScpQualificationReviewRows(live.rows, {
    spreadsheetId,
    tabName: live.resolvedTabName,
    includeRaw: input.includeRaw === true,
  });
}

export async function readCanonicalScpQualificationSheetRows(input: {
  startRow?: number;
  endRow?: number;
} = {}): Promise<Array<{ rowNumber: number; cells: Record<string, string> }>> {
  const startRow = boundedInteger(input.startRow, 1, 1, 100_000);
  const endRow = boundedInteger(
    input.endRow,
    Math.min(100_000, startRow + MAX_SCP_SHEET_ROWS - 1),
    startRow,
    Math.min(100_000, startRow + MAX_SCP_SHEET_ROWS - 1),
  );
  const result = await readGoogleSheetRows({
    spreadsheetId: SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID,
    tabName: SCP_QUALIFICATION_REVIEW_TAB_NAME,
    sheetId: SCP_QUALIFICATION_REVIEW_GID,
    startRow,
    endRow,
    lastColumn: "AK",
    profile: requiredSourceProfile("participant_selection"),
  });
  return result.rows;
}

export function buildScpQualificationReviewRows(rows: SheetRow[], input: {
  spreadsheetId?: string;
  tabName?: string;
  includeRaw?: boolean;
} = {}): ScpQualificationReviewRow[] {
  const spreadsheetId = cleanSpreadsheetId(input.spreadsheetId, SCP_QUALIFICATION_REVIEW_SPREADSHEET_ID);
  const tabName = cleanText(input.tabName, SCP_QUALIFICATION_REVIEW_TAB_NAME, 120);
  const sourceId = sourceIdForGoogleSheet(spreadsheetId);
  const parsedRows: ScpQualificationReviewRow[] = [];
  const nowIso = new Date().toISOString();
  const sheet2HeaderMapping = resolveSheet2ApplicantHeaderMapping(rows);
  if (!sheet2HeaderMapping) {
    console.warn("[scp-sheet2] header row not found; positional fallback");
  }
  const sheet2ApplicantMapping: SheetHeaderMapping = {
    byField: sheet2HeaderMapping?.byField ?? {},
    unmappedHeaders: sheet2HeaderMapping?.unmappedHeaders ?? [],
    mappedFieldCount: sheet2HeaderMapping?.mappedFieldCount ?? 0,
    positionalFallback: true,
  };
  for (const row of rows.slice(0, MAX_SCP_SHEET_ROWS)) {
    if (isSheet2HeaderRow(row.cells)) continue;
    const label = parseQualificationDecision(row.cells);
    const rawAtoZ = toRawAtoZ(row.cells);
    const applicant = normalizeSheet2Applicant(rawAtoZ, sheet2ApplicantMapping);
    const metrics = normalizeSheet2Metrics(row.cells);
    const leadId = leadIdForGoogleSheetRow(applicant, sourceId, row.rowNumber);
    const expectedLabel = label.status === "pass" || label.status === "fail" ? label.status : null;
    const rowHash = sha256AtoZ(rawAtoZ);
    const rawDocId = rawRowDocId(sourceId, row.rowNumber, rowHash);
    parsedRows.push({
      id: safeDocId(`sheet2:${spreadsheetId}:${row.rowNumber}:${hashRow(row.cells).slice(0, 16)}`),
      leadId,
      rowNumber: row.rowNumber,
      sheetUrl: googleSheetUrl(spreadsheetId, SCP_QUALIFICATION_REVIEW_GID, row.rowNumber),
      sourceType: "google_sheet",
      spreadsheetId,
      tabName,
      schemaGeneration: label.schemaGeneration,
      status: label.status,
      qualificationStatus: label.status === "pass" ? "pass" : label.status === "fail" ? "fail" : label.status === "excluded" ? "excluded" : "unreviewed",
      expectedLabel,
      expectedMarker: label.marker,
      humanReason: label.reason,
      applicant,
      ...applicant,
      metrics,
      updatedAtIso: nowIso,
      priorReasonKnowledge: emptyReasonKnowledge(),
      ...(input.includeRaw ? {
        sourceId,
        sourceRef: `sheet_raw_rows/${rawDocId}`,
        rowHash,
        rawCells: rawAtoZ,
      } : {}),
    });
  }
  const knowledge = buildReasonKnowledge(parsedRows);
  return parsedRows.map((row) => ({ ...row, priorReasonKnowledge: knowledge }));
}

function normalizeSheet2Applicant(
  rawAtoZ: SheetRawCells,
  mapping: SheetHeaderMapping,
): ProgramSheetLeadApplicant {
  const base = normalizeSheetApplicant(rawAtoZ, mapping);
  const mappedNameColumn = mapping.byField.name;
  const columnsClaimedByOtherFields = new Set(
    Object.entries(mapping.byField)
      .filter(([field]) => field !== "name")
      .map(([, column]) => column),
  );
  const name = mappedNameColumn
    ? cleanApplicantName(rawAtoZ[mappedNameColumn])
    : (!columnsClaimedByOtherFields.has("B")
        ? cleanApplicantName(rawAtoZ.B)
        : null) ??
      (!columnsClaimedByOtherFields.has("C")
        ? cleanApplicantName(rawAtoZ.C)
        : null);
  const youtubeUrl = cleanUrl(rawAtoZ.R) || cleanUrl(base.youtubeUrl) || cleanUrl(rawAtoZ.S);
  const instagramUrl = cleanUrl(rawAtoZ.U) || cleanUrl(base.instagramUrl) || cleanUrl(rawAtoZ.W);
  const tiktokUrl = cleanUrl(rawAtoZ.V) || cleanUrl(base.tiktokUrl) || cleanUrl(rawAtoZ.X);
  const mostViewedUrl = cleanUrl(rawAtoZ.S) || cleanUrl(base.mostViewedUrl) || cleanUrl(rawAtoZ.W) || cleanUrl(rawAtoZ.X);
  return {
    ...base,
    name: name as string,
    email: (base.email || cleanText(rawAtoZ.D, "", 240)).toLowerCase(),
    country: base.country || cleanText(rawAtoZ.E, "", 120),
    ageGroup: base.ageGroup || cleanText(rawAtoZ.F, "", 80),
    sponsoredCount: cleanText(rawAtoZ.M, "", 120) || base.sponsoredCount,
    category: cleanText(rawAtoZ.N, "", 120) || base.category,
    format: cleanText(rawAtoZ.O, "", 120) || base.format,
    motivation: cleanText(rawAtoZ.Q, "", 500) || base.motivation,
    youtubeUrl,
    language: cleanText(rawAtoZ.T, "", 120) || base.language,
    instagramUrl,
    tiktokUrl,
    mostViewedUrl,
    submittedAt: base.submittedAt || cleanText(rawAtoZ.Y, "", 120),
    token: base.token || cleanText(rawAtoZ.Z, "", 160),
  };
}

export async function readScpVideoReviewSheetRows(input: {
  spreadsheetId?: string;
  tabName?: string;
  startRow?: number;
  endRow?: number;
  rows?: unknown;
} = {}): Promise<ScpVideoReviewSheetRow[]> {
  const spreadsheetId = cleanSpreadsheetId(input.spreadsheetId, SCP_VIDEO_REVIEW_SPREADSHEET_ID);
  const tabName = cleanText(input.tabName, SCP_VIDEO_REVIEW_TAB_NAME, 120);
  const startRow = boundedInteger(input.startRow, 1, 1, 100_000);
  const endRow = boundedInteger(input.endRow, Math.min(100_000, startRow + MAX_SCP_SHEET_ROWS - 1), startRow, Math.min(100_000, startRow + MAX_SCP_SHEET_ROWS - 1));
  const fixtureRows = parseInputRows(input.rows, startRow, "L");
  if (spreadsheetId === SCP_VIDEO_REVIEW_SPREADSHEET_ID) {
    assertRequestedTabContract("content_review", tabName);
  } else if (!fixtureRows) {
    throw failedPrecondition("Video review live reads require the reviewed spreadsheet contract.");
  }
  const live = fixtureRows
    ? { rows: fixtureRows, resolvedTabName: tabName }
    : await readGoogleSheetRows({
        spreadsheetId,
        tabName,
        sheetId: SCP_VIDEO_REVIEW_GID,
        startRow,
        endRow,
        lastColumn: "L",
        profile: requiredSourceProfile("content_review"),
      });
  // 이 파일의 유일한 프로그램은 SCP 다(캐노니컬 id 하드코딩은 위 resolveSubmissionGameId 호출과
  // 같은 전제) — 60s 캐시라 행마다 다시 읽지 않는다.
  const registryOverride = await loadProgramTitleRegistry(canonicalScpProgramId);
  return buildScpVideoReviewSheetRows(live.rows, {
    spreadsheetId,
    tabName: live.resolvedTabName,
    registryOverride,
  });
}

export function buildScpVideoReviewSheetRows(rows: SheetRow[], input: {
  spreadsheetId?: string;
  tabName?: string;
  registryOverride?: unknown;
} = {}): ScpVideoReviewSheetRow[] {
  const spreadsheetId = cleanSpreadsheetId(input.spreadsheetId, SCP_VIDEO_REVIEW_SPREADSHEET_ID);
  const tabName = cleanText(input.tabName, SCP_VIDEO_REVIEW_TAB_NAME, 120);
  const out: ScpVideoReviewSheetRow[] = [];
  const headerValidation = validateSheet3Header(rows, { spreadsheetId, tabName });
  for (const row of rows.slice(0, MAX_SCP_SHEET_ROWS)) {
    if (looksLikeVideoHeader(row.cells)) continue;
    if (headerValidation && !headerValidation.valid && row.rowNumber > headerValidation.rowNumber) continue;
    const email = cleanText(row.cells.A, "", 240).toLowerCase();
    const app = cleanText(row.cells.B, "", 120);
    const youtubeUrl = cleanUrl(row.cells.C);
    const tiktokUrl = cleanUrl(row.cells.D);
    const instagramUrl = cleanUrl(row.cells.E);
    const uploadedFileUrl = cleanUrl(row.cells.F);
    const contentType = cleanText(row.cells.G, "", 120);
    const submittedAtIso = normalizeDate(row.cells.H);
    const token = cleanText(row.cells.I, "", 160);
    const rawStatus = cleanText(row.cells.J, "", 80);
    const status = parseVideoStatus(rawStatus);
    const rejectedReason = cleanText(row.cells.K, "", 500);
    const mail = cleanText(row.cells.L, "", 500);
    // 다타이틀 해석(2026-09-05 포털 계약 정정): 시트 쓰기는 헤더 A:AK 정확 일치를 강제하므로
    // 별도 game_id 열은 생기지 않는다 — B 열(game_name)이 정본이고, 레지스트리 id 를 직접
    // ("snake-clash") 담거나 사람이 적은 표기("XP Hero" 등)를 담는다. M 열은 이 시트 읽기가
    // lastColumn:"L" 로 바운드돼 있어 실제로는 절대 채워지지 않는 죽은 자리지만, 값이 있으면
    // 공짜로 우선한다(무비용 선택 경로 — 이 값에 의존하는 계약·테스트는 없다).
    // 미등록 값은 거부하지 않고 프로그램 기본 타이틀로 착지시키며 gameIdUnresolved 로
    // 사람 게이트에 남긴다. 선언 누락·빈 값도 기본 타이틀로 착지하지만 그 gameId 는 행의
    // 주장이 아니라 스탬프라 gameIdDefaulted 로 표시한다 — strict 필터가 기본 타이틀
    // 버킷으로 세지 않게.
    const { gameId, gameIdUnresolved, gameIdDefaulted } = resolveSubmissionGameId(
      canonicalScpProgramId,
      cleanText(row.cells.M, "", 64) || app,
      input.registryOverride,
    );
    const contentUrls = [youtubeUrl, tiktokUrl, instagramUrl, uploadedFileUrl].filter(Boolean);
    if (!email && !app && contentUrls.length === 0 && !token) continue;
    out.push({
      id: safeDocId(`sheet3:${spreadsheetId}:${row.rowNumber}:${hashRow(row.cells).slice(0, 16)}`),
      rowNumber: row.rowNumber,
      sheetUrl: googleSheetUrl(spreadsheetId, SCP_VIDEO_REVIEW_GID, row.rowNumber),
      sourceType: "google_sheet",
      spreadsheetId,
      tabName,
      email,
      app,
      youtubeUrl,
      tiktokUrl,
      instagramUrl,
      uploadedFileUrl,
      contentType,
      submittedAtIso,
      token,
      rawStatus,
      status,
      reviewStatus: status,
      rejectedReason,
      mail,
      gameId,
      gameIdUnresolved,
      gameIdDefaulted,
      contentUrls,
      rawCells: { ...row.cells },
      // A Sheet value read has no independent observation timestamp. Reusing the
      // source submission timestamp keeps repeated reads of unchanged A:L data
      // byte-stable for checkpoints and migration manifests.
      updatedAtIso: submittedAtIso,
    });
  }
  return out;
}

export function buildReasonKnowledge(rows: ScpQualificationReviewRow[]): ScpQualificationReasonKnowledge {
  const failReasons = new Map<string, number>();
  const passReasons = new Map<string, number>();
  let passCount = 0;
  let failCount = 0;
  let pendingCount = 0;
  let excludedCount = 0;
  for (const row of rows) {
    if (row.status === "pass") passCount += 1;
    else if (row.status === "fail") failCount += 1;
    else if (row.status === "excluded") excludedCount += 1;
    else pendingCount += 1;
    const target = row.status === "fail" ? failReasons : row.status === "pass" ? passReasons : null;
    if (!target) continue;
    for (const reason of splitReasons(row.humanReason)) {
      target.set(reason, (target.get(reason) ?? 0) + 1);
    }
  }
  const top = (m: Map<string, number>) => Array.from(m.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([reason, count]) => ({ reason, count }));
  return {
    passCount,
    failCount,
    pendingCount,
    excludedCount,
    topFailReasons: top(failReasons),
    topPassReasons: top(passReasons),
    vocabulary: ["장르불일치", "저티어국가", "구독자1K미만", "업로드빈도", "인게이지먼트", "중복지원", "유튜브없음"],
  };
}

function emptyReasonKnowledge(): ScpQualificationReasonKnowledge {
  return { passCount: 0, failCount: 0, pendingCount: 0, excludedCount: 0, topFailReasons: [], topPassReasons: [], vocabulary: [] };
}

async function readGoogleSheetRows(input: {
  spreadsheetId: string;
  tabName: string;
  sheetId?: string;
  startRow: number;
  endRow: number;
  lastColumn: "L" | "AK";
  profile: SheetSourceProfile;
}): Promise<{ rows: SheetRow[]; resolvedTabName: string }> {
  const accessToken = envString("GOOGLE_SHEETS_ACCESS_TOKEN") || envString("SHEETS_ACCESS_TOKEN") || await metadataAccessToken();
  const apiKey = envString("GOOGLE_SHEETS_API_KEY") || envString("SHEETS_API_KEY");
  if (!accessToken && !apiKey) {
    const error = new Error("Google Sheets credentials are not configured; bind GOOGLE_SHEETS_ACCESS_TOKEN/SHEETS_ACCESS_TOKEN, GOOGLE_SHEETS_API_KEY/SHEETS_API_KEY, or share the Sheet with the deployed Functions service account");
    Object.assign(error, { code: "failed-precondition", errorCode: "read_google_sheet_rows_google_sheets_credentials_configured_bind" });
    throw error;
  }
  if (input.sheetId !== input.profile.gid) {
    throw failedPrecondition("Google Sheets review gid does not match the reviewed source contract.");
  }
  const resolvedSheet = await resolveSheetPropertiesById({
    spreadsheetId: input.spreadsheetId,
    sheetId: input.sheetId,
    accessToken,
    apiKey,
  });
  const resolvedTabName = resolvedSheet.title;
  if (!validateSheetSourceTabContract(input.profile, resolvedTabName).valid) {
    throw failedPrecondition(
      `Google Sheets gid ${input.sheetId} resolved outside the reviewed ${input.profile.key} tab contract.`,
    );
  }
  const header = await fetchSheetValues({
    spreadsheetId: input.spreadsheetId,
    tabName: resolvedTabName,
    startRow: 1,
    endRow: 1,
    lastColumn: input.lastColumn,
    accessToken,
    apiKey,
  });
  if (!header.ok) throwReadError(header.status);
  const headerContract = validateSheetSourceHeaderContract(
    input.profile,
    header.rows[0]?.cells ?? {},
  );
  if (!headerContract.valid) {
    throw failedPrecondition(
      `Google Sheets ${input.profile.key} header contract drifted at columns ${[
        ...headerContract.missingColumns,
        ...headerContract.mismatchedColumns,
      ].join(",") || "unknown"}.`,
    );
  }
  if (input.startRow === 1 && input.endRow === 1) {
    return { rows: header.rows, resolvedTabName };
  }
  if (resolvedSheet.rowCount > 0 && input.startRow > resolvedSheet.rowCount) {
    return { rows: [], resolvedTabName };
  }
  const data = await fetchSheetValues({
    spreadsheetId: input.spreadsheetId,
    tabName: resolvedTabName,
    startRow: input.startRow,
    endRow: resolvedSheet.rowCount > 0 ? Math.min(input.endRow, resolvedSheet.rowCount) : input.endRow,
    lastColumn: input.lastColumn,
    accessToken,
    apiKey,
  });
  if (!data.ok) throwReadError(data.status);
  return { rows: data.rows, resolvedTabName };
}

async function fetchSheetValues(input: {
  spreadsheetId: string;
  tabName: string;
  startRow: number;
  endRow: number;
  lastColumn: "L" | "AK";
  accessToken: string;
  apiKey: string;
}): Promise<{ ok: true; rows: SheetRow[] } | { ok: false; status: number }> {
  const range = `${input.tabName}!A${input.startRow}:${input.lastColumn}${input.endRow}`;
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(range)}`);
  url.searchParams.set("majorDimension", "ROWS");
  if (input.apiKey && !input.accessToken) url.searchParams.set("key", input.apiKey);
  const response = await fetch(url, { headers: input.accessToken ? { Authorization: `Bearer ${input.accessToken}` } : undefined });
  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  const body = await response.json() as { values?: unknown[] };
  return { ok: true, rows: parseInputRows(Array.isArray(body.values) ? body.values : [], input.startRow, input.lastColumn) ?? [] };
}

async function resolveSheetPropertiesById(input: {
  spreadsheetId: string;
  sheetId: string;
  accessToken: string;
  apiKey: string;
}): Promise<{ title: string; rowCount: number }> {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}`);
  url.searchParams.set("includeGridData", "false");
  url.searchParams.set("fields", "sheets.properties(sheetId,title,gridProperties.rowCount)");
  if (input.apiKey && !input.accessToken) url.searchParams.set("key", input.apiKey);
  const response = await fetch(url, { headers: input.accessToken ? { Authorization: `Bearer ${input.accessToken}` } : undefined });
  if (!response.ok) return { title: "", rowCount: 0 };
  const body = await response.json() as {
    sheets?: Array<{ properties?: { sheetId?: unknown; title?: unknown; gridProperties?: { rowCount?: unknown } } }>;
  };
  const expected = Number(input.sheetId);
  const match = Array.isArray(body.sheets)
    ? body.sheets.find((sheet) => Number(sheet.properties?.sheetId) === expected)
    : undefined;
  return {
    title: cleanText(match?.properties?.title, "", 120),
    rowCount: boundedInteger(match?.properties?.gridProperties?.rowCount, 0, 0, 100_000),
  };
}

function throwReadError(status: number): never {
  const error = new Error(`Google Sheets SCP review read failed with HTTP ${status}`);
  Object.assign(error, { code: "failed-precondition", errorCode: "throw_read_error_google_sheets_scp_review_read" });
  throw error;
}

function requiredSourceProfile(
  key: "participant_selection" | "content_review",
): SheetSourceProfile {
  const profile = knownSheetSourceProfileByKey(key);
  if (!profile) {
    throw failedPrecondition(`Reviewed Sheet source profile ${key} is unavailable.`);
  }
  return profile;
}

function assertRequestedTabContract(
  key: "participant_selection" | "content_review",
  tabName: string,
): void {
  const profile = requiredSourceProfile(key);
  if (!validateSheetSourceTabContract(profile, tabName).valid) {
    throw failedPrecondition(
      `Requested tab does not match the reviewed ${key} source contract.`,
    );
  }
}

function failedPrecondition(message: string): Error {
  return Object.assign(new Error(message), { code: "failed-precondition", errorCode: "failed_precondition_unauthorized" });
}

async function metadataAccessToken(): Promise<string> {
  if (process.env.FUNCTIONS_EMULATOR === "true" || process.env.FIRESTORE_EMULATOR_HOST) return "";
  if (!process.env.K_SERVICE && !process.env.FUNCTION_TARGET && !process.env.FUNCTION_NAME) return "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
      headers: { "Metadata-Flavor": "Google" },
      signal: controller.signal,
    });
    if (!response.ok) return "";
    const body = await response.json() as { access_token?: unknown };
    return cleanText(body.access_token, "", 4096);
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function parseInputRows(value: unknown, startRow: number, lastColumn: "L" | "AK"): SheetRow[] | null {
  if (!Array.isArray(value)) return null;
  const columns = makeColumns(lastColumn);
  return value.slice(0, MAX_SCP_SHEET_ROWS).map((row, index) => {
    const record = asRecord(row);
    const explicit = boundedInteger(record.rowNumber, Number.NaN, 1, 100_000);
    const cellsSource = record.cells ?? row;
    return {
      rowNumber: Number.isFinite(explicit) ? explicit : startRow + index,
      cells: cellsToColumns(cellsSource, columns),
    };
  });
}

function cellsToColumns(value: unknown, columns: string[]): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(columns.map((column, index) => [column, stringifyCell(value[index])])) as Record<string, string>;
  }
  const record = asRecord(value);
  if (Array.isArray(record.cells) || (record.cells && typeof record.cells === "object")) return cellsToColumns(record.cells, columns);
  return Object.fromEntries(columns.map((column) => [column, stringifyCell(record[column])])) as Record<string, string>;
}

function parseQualificationDecision(cells: Record<string, string>): { status: ScpQualificationSheetStatus; marker: string; reason: string; schemaGeneration: ScpQualificationReviewRow["schemaGeneration"] } {
  const newMarker = cleanText(cells.AG, "", 200);
  const oldMarker = cleanText(cells.AJ, "", 200);
  const newLabel = parseQualificationLabel(newMarker);
  if (newLabel === "pass" || newLabel === "fail") return { status: newLabel, marker: newMarker, reason: cleanText(cells.AH, "", 500), schemaGeneration: "script_v2" };
  if (newLabel === "excluded") return { status: "excluded", marker: newMarker, reason: "", schemaGeneration: "excluded" };
  const oldLabel = parseQualificationLabel(oldMarker);
  if (oldLabel === "pass" || oldLabel === "fail") return { status: oldLabel, marker: oldMarker, reason: cleanText(cells.AK, "", 500), schemaGeneration: "manual_v1" };
  if (oldLabel === "excluded") return { status: "excluded", marker: oldMarker, reason: "", schemaGeneration: "excluded" };
  return { status: "pending", marker: newMarker || oldMarker, reason: "", schemaGeneration: "pending" };
}

function parseQualificationLabel(value: string): ScpQualificationSheetStatus | "blank" {
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  if (!normalized) return "blank";
  if (["o", "ok", "pass", "passed", "approved", "approval", "합격"].includes(normalized)) return "pass";
  if (["x", "fail", "failed", "reject", "rejected", "disapproved", "불합격"].includes(normalized)) return "fail";
  if (/모집대상아님|대상아님|nottarget|outofscope|n\/a|na/.test(normalized)) return "excluded";
  return "blank";
}

function parseVideoStatus(value: unknown): ScpVideoSheetStatus {
  const normalized = cleanText(value, "", 80).replace(/\s+/g, "").toLowerCase();
  if (["approval", "approved", "approve", "합격", "승인", "o"].includes(normalized)) return "approved";
  if (["disapproval", "disapproved", "reject", "rejected", "불합격", "반려", "x"].includes(normalized)) return "rejected";
  return "pending";
}

function normalizeSheet2Metrics(cells: Record<string, string>): Partial<ProgramSheetLeadMetrics> {
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

function splitReasons(value: string): string[] {
  return value
    .split(/[;,/|·\n]+|\s{2,}/g)
    .map((item) => cleanText(item, "", 80))
    .filter(Boolean)
    .slice(0, 20);
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

function toRawAtoZ(cells: Record<string, string>): SheetRawCells {
  const columns = makeColumns("Z") as Array<keyof SheetRawCells>;
  return Object.fromEntries(columns.map((column) => [column, cleanText(cells[column], "", 2_000)])) as SheetRawCells;
}

function resolveSheet2ApplicantHeaderMapping(rows: SheetRow[]): SheetHeaderMapping | null {
  for (const row of rows.slice(0, MAX_SCP_SHEET_ROWS)) {
    if (!isSheet2HeaderRow(row.cells)) continue;
    return resolveHeaderMapping(toRawAtoZ(row.cells), SHEET2_HEADER_ALIASES);
  }
  return null;
}

function isSheet2HeaderRow(cells: Record<string, string>): boolean {
  return looksLikeQualificationHeader(cells) || sheet2HeaderScore(cells) >= 2;
}

function sheet2HeaderScore(cells: Record<string, string>): number {
  const mapping = resolveHeaderMapping(toRawAtoZ(cells), SHEET2_HEADER_ALIASES);
  return SHEET2_HEADER_SCORE_FIELDS.filter((field) => Boolean(mapping.byField[field])).length;
}

function looksLikeQualificationHeader(cells: Record<string, string>): boolean {
  return /비고/i.test(cells.AG ?? "") || /비고/i.test(cells.AJ ?? "") || /사유/i.test(cells.AH ?? "") || /사유/i.test(cells.AK ?? "") || /구독자/i.test(cells.AA ?? "") || /업로드빈도/i.test(cells.AC ?? "") || /커스텀링크/i.test(cells.AI ?? "");
}

function looksLikeVideoHeader(cells: Record<string, string>): boolean {
  const normalized = [cells.A, cells.B, cells.C, cells.D, cells.E, cells.F, cells.G, cells.H, cells.I, cells.J, cells.K, cells.L]
    .map((cell) => cleanText(cell, "", 80).replace(/\s+/g, "_").toLowerCase());
  const headerWords = new Set([
    "email",
    "이메일",
    "app",
    "youtube",
    "tiktok",
    "instagram",
    "file",
    "mp4",
    "content_type",
    "submitted_at",
    "token",
    "status",
    "rejected_reason",
    "mail",
    "메일",
  ]);
  const score = normalized.filter((cell) => headerWords.has(cell)).length;
  return score >= 3 && (headerWords.has(normalized[0]) || headerWords.has(normalized[9]));
}

function validateSheet3Header(rows: SheetRow[], input: { spreadsheetId: string; tabName: string }): { valid: boolean; rowNumber: number } | null {
  const header = rows.slice(0, MAX_SCP_SHEET_ROWS).find((row) => looksLikeVideoHeader(row.cells));
  if (!header) return null;
  const mismatches: string[] = [];
  for (const [column, aliases] of Object.entries(SHEET3_EXPECTED_HEADERS)) {
    const rawHeader = cleanText(header.cells[column], "", 120);
    if (!rawHeader) continue;
    if (!matchesHeaderAlias(rawHeader, aliases)) mismatches.push(`${column}:${rawHeader}`);
  }
  if (mismatches.length === 0) return { valid: true, rowNumber: header.rowNumber };
  console.warn("[scp-sheet3] header mismatch; video rows held fail-closed", {
    spreadsheetId: input.spreadsheetId,
    tabName: input.tabName,
    rowNumber: header.rowNumber,
    mismatches,
  });
  return { valid: false, rowNumber: header.rowNumber };
}

function matchesHeaderAlias(value: string, aliases: readonly string[]): boolean {
  const normalized = normalizeHeaderText(value);
  const compact = normalized.replace(/[\s_]+/g, "");
  return aliases.some((alias) => {
    const candidate = normalizeHeaderText(alias);
    return normalized === candidate || compact === candidate.replace(/[\s_]+/g, "");
  });
}

function cleanSpreadsheetId(value: unknown, fallback: string): string {
  const raw = asString(value, fallback);
  return raw.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 160) || fallback;
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  const raw = typeof value === "string" ? value : value === null || value === undefined ? fallback : String(value);
  return raw.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanApplicantName(value: unknown): string | null {
  const text = cleanText(value, "", 240);
  const guardText = text.normalize("NFKC").replace(/\s+/g, "");
  if (!text || /^(true|false)$/i.test(guardText) || /^[0-9]+$/.test(guardText)) return null;
  return text;
}

function cleanUrl(value: unknown): string {
  const text = cleanText(value, "", 1_000);
  if (!text) return "";
  return /^https?:\/\//i.test(text) ? text : "";
}

function normalizeDate(value: unknown): string {
  const text = cleanText(value, "", 120);
  const date = text ? new Date(text) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : text;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim().slice(0, 2_000);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value).slice(0, 2_000);
}

function makeColumns(lastColumn: "L" | "Z" | "AK"): string[] {
  const columns: string[] = [];
  const firstCount = lastColumn === "L" ? 12 : 26;
  for (let index = 0; index < firstCount; index += 1) columns.push(String.fromCharCode("A".charCodeAt(0) + index));
  if (lastColumn === "AK") {
    for (let index = 0; index <= 10; index += 1) columns.push(`A${String.fromCharCode("A".charCodeAt(0) + index)}`);
  }
  return columns;
}

function hashRow(cells: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify(Object.keys(cells).sort().map((key) => cells[key] ?? ""))).digest("hex");
}

function googleSheetUrl(spreadsheetId: string, gid: string, rowNumber: number): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit#gid=${encodeURIComponent(gid)}&range=A${rowNumber}`;
}

function envString(name: string): string {
  return typeof process.env[name] === "string" ? process.env[name]?.trim() ?? "" : "";
}
