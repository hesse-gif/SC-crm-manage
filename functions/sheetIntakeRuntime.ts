import { createHash } from "node:crypto";
import {
  DEFAULT_FIRESTORE_DATABASE,
  STAGING_FIRESTORE_DATABASE,
  resolveRuntimeEnvironment,
  type RuntimeEnvironmentSource,
} from "./runtimeEnvironment";
import {
  resolveCanonicalProgramId,
  SCP_CANONICAL_PROGRAM_ID,
} from "./programCanonical";
import type {
  SheetIntakeMode,
  SheetProjectionStrategy,
  SheetSourceDomain,
} from "./sheetIntakeTypes";

export const FLU_PROJECT_ID = "influchat-77db6";
export const SCP_APPLY_SPREADSHEET_ID =
  "1BilKwPoEI9coUK6dGI4u6cgKd8xzo3uN35Vf53tqb3I";
export const SCP_PARTICIPANT_SELECTION_SPREADSHEET_ID =
  "1WiA2JqYHAdJ8j9xbpW_mbovIBfH4JsYTtpWsZ2pfWCo";
export const SCP_CONTENT_REVIEW_SPREADSHEET_ID =
  "1KTpJObX_plEeA_We3-KZiG0yUnB--OA6v8m8w5ZKyrw";
export const SCP_PARTICIPANT_SELECTION_TAB_NAME = "지원자_260514~";
export const SCP_PARTICIPANT_SELECTION_GID = "1194967263";
export const SCP_PARTICIPANT_REGISTRY_TAB_NAME = "참가자";
export const SCP_PARTICIPANT_REGISTRY_GID = "53632951";
export const SCP_CONTENT_REVIEW_TAB_NAME = "콘텐츠메일송부";
export const SCP_CONTENT_REVIEW_GID = "1346750620";
export const SHEET_HEADER_BLANK_OR_MAIL = "[blank-or-mail]";

export type SheetIntakeWriteAction =
  | "sync"
  | "reconcile"
  | "cutover"
  | "participant_roster_sync";
export type SheetSourceKey =
  | "scp_apply"
  | "participant_selection"
  | "participant_registry"
  | "content_review"
  | "staging_fixture";

export interface LegacySheetSource {
  spreadsheetId: string;
  tabName: string;
  gid: string;
  role: "parity_rollback_only";
}

export interface SheetSourceProfile {
  key: SheetSourceKey;
  displayName: string;
  spreadsheetId: string;
  sourceId: string;
  domain: SheetSourceDomain;
  projectionStrategy: SheetProjectionStrategy;
  canonicalProgramId: string;
  tabName: string;
  tabNamePattern: string;
  gid: string;
  headerContract: Readonly<Record<string, string>>;
  legacySource?: LegacySheetSource;
  startRow: number;
  syncSupported: boolean;
}

export interface SheetSourceContractValidation {
  valid: boolean;
  expectedFingerprint: string;
  actualFingerprint: string;
  mismatchedColumns: string[];
  missingColumns: string[];
}

export type SheetRuntimeEnvironment = RuntimeEnvironmentSource & {
  GCLOUD_PROJECT?: string;
  GOOGLE_CLOUD_PROJECT?: string;
  FIREBASE_CONFIG?: string;
  FLU_SHEET_INTAKE_LIVE_WRITE_MODE?: string;
  FLU_SHEET_INTAKE_ALLOWED_SPREADSHEET_IDS?: string;
};

export interface SheetIntakeWriteGate {
  mode: Exclude<SheetIntakeMode, "dry_run">;
  runtime: "emulator" | "staging" | "production";
  projectId: string;
  databaseId: string;
  canonicalProgramId: string;
  sourceProfile: SheetSourceProfile | null;
}

const SOURCE_PROFILES: readonly SheetSourceProfile[] = [
  {
    key: "scp_apply",
    displayName: "SCP 지원 원본",
    spreadsheetId: SCP_APPLY_SPREADSHEET_ID,
    sourceId: canonicalSourceId(SCP_APPLY_SPREADSHEET_ID),
    domain: "scp_apply",
    projectionStrategy: "applicant_projection",
    canonicalProgramId: SCP_CANONICAL_PROGRAM_ID,
    tabName: "Super Creator Partners",
    tabNamePattern: "^Super Creator Partners$",
    gid: "0",
    headerContract: {},
    startRow: 267,
    syncSupported: true,
  },
  {
    key: "participant_selection",
    displayName: "참가자 선발 · 지원자",
    spreadsheetId: SCP_PARTICIPANT_SELECTION_SPREADSHEET_ID,
    sourceId: canonicalSourceId(SCP_PARTICIPANT_SELECTION_SPREADSHEET_ID),
    domain: "participant_selection",
    projectionStrategy: "applicant_projection",
    canonicalProgramId: SCP_CANONICAL_PROGRAM_ID,
    tabName: SCP_PARTICIPANT_SELECTION_TAB_NAME,
    tabNamePattern: "^지원자_260514~$",
    gid: SCP_PARTICIPANT_SELECTION_GID,
    headerContract: { AG: "비고", AH: "사유" },
    startRow: 1,
    syncSupported: true,
  },
  {
    key: "participant_registry",
    displayName: "참가자 명부",
    spreadsheetId: SCP_PARTICIPANT_SELECTION_SPREADSHEET_ID,
    sourceId: semanticSourceId(
      "participant_registry",
      SCP_PARTICIPANT_SELECTION_SPREADSHEET_ID,
      SCP_PARTICIPANT_REGISTRY_GID,
    ),
    domain: "participant_registry",
    projectionStrategy: "participant_registry_projection",
    canonicalProgramId: SCP_CANONICAL_PROGRAM_ID,
    tabName: SCP_PARTICIPANT_REGISTRY_TAB_NAME,
    tabNamePattern: "^참가자$",
    gid: SCP_PARTICIPANT_REGISTRY_GID,
    headerContract: {
      A: "creator_id",
      B: "이메일",
      C: "이메일 아이디",
      D: "채널명",
      E: "채널링크",
      F: "국가",
      G: "커스텀링크(adjust)",
      H: "커스텀링크(appsflyer)",
      I: "User ID",
      J: "커스텀링크 campaign",
      K: "활동시작일(일괄,월별구분용)",
      L: "비고",
      M: "프로그램",
      N: "캠페인",
    },
    legacySource: {
      spreadsheetId: SCP_CONTENT_REVIEW_SPREADSHEET_ID,
      tabName: "참가자리스트",
      gid: "0",
      role: "parity_rollback_only",
    },
    startRow: 2,
    syncSupported: false,
  },
  {
    key: "content_review",
    displayName: "콘텐츠 검수",
    spreadsheetId: SCP_CONTENT_REVIEW_SPREADSHEET_ID,
    sourceId: canonicalSourceId(SCP_CONTENT_REVIEW_SPREADSHEET_ID),
    domain: "content_review",
    projectionStrategy: "video_submission_bridge",
    canonicalProgramId: SCP_CANONICAL_PROGRAM_ID,
    tabName: SCP_CONTENT_REVIEW_TAB_NAME,
    tabNamePattern: "^콘텐츠메일송부$",
    gid: SCP_CONTENT_REVIEW_GID,
    headerContract: {
      A: "email",
      B: "app",
      C: "youtube_url",
      D: "tiktok_url",
      E: "insta_url",
      F: "uploaded_file",
      G: "content_type",
      H: "summited_at",
      I: "token",
      J: "status",
      K: "rejected reason",
      L: SHEET_HEADER_BLANK_OR_MAIL,
    },
    startRow: 1,
    syncSupported: false,
  },
] as const;

export function knownSheetSourceProfile(
  spreadsheetId: unknown,
): SheetSourceProfile | null {
  const normalized = cleanSpreadsheetId(spreadsheetId);
  const matches = SOURCE_PROFILES.filter((profile) => profile.spreadsheetId === normalized);
  return matches.length === 1 ? matches[0] : null;
}

export function resolveKnownSheetSourceProfile(input: {
  sourceKey?: unknown;
  spreadsheetId?: unknown;
}): SheetSourceProfile | null {
  const spreadsheetId = cleanSpreadsheetId(input.spreadsheetId);
  const requestedKey = cleanSourceKey(input.sourceKey);
  if (input.sourceKey !== undefined && input.sourceKey !== null && !requestedKey) {
    throw failedPrecondition("Sheet source key is not in the reviewed Sheet topology.");
  }
  if (requestedKey) {
    const profile = knownSheetSourceProfileByKey(requestedKey);
    if (!profile) return null;
    if (spreadsheetId && profile.spreadsheetId !== spreadsheetId) {
      throw failedPrecondition("Sheet source key does not match spreadsheetId.");
    }
    return profile;
  }
  if (!spreadsheetId) return null;
  const matches = SOURCE_PROFILES.filter((profile) => profile.spreadsheetId === spreadsheetId);
  if (matches.length > 1) {
    throw failedPrecondition(
      "This spreadsheet contains multiple reviewed sources; a semantic source key is required.",
    );
  }
  return matches[0] ?? null;
}

export function knownSheetSourceProfileBySourceId(
  sourceId: unknown,
): SheetSourceProfile | null {
  const normalized = cleanSourceId(sourceId);
  return SOURCE_PROFILES.find((profile) => profile.sourceId === normalized) ?? null;
}

export function knownSheetSourceProfileByKey(
  key: unknown,
): SheetSourceProfile | null {
  const normalized = cleanSourceKey(key);
  return SOURCE_PROFILES.find((profile) => profile.key === normalized) ?? null;
}

export function reviewedSheetSourceProfiles(): readonly SheetSourceProfile[] {
  return SOURCE_PROFILES;
}

export function validateSheetSourceTabContract(
  profile: SheetSourceProfile | null | undefined,
  actualTabName: unknown,
): { valid: boolean; expectedTabName: string; actualTabName: string } {
  const actual = normalizeContractText(actualTabName);
  const expected = normalizeContractText(profile?.tabName);
  return {
    valid: Boolean(profile && actual && actual === expected && safePatternMatch(profile.tabNamePattern, actual)),
    expectedTabName: profile?.tabName ?? "",
    actualTabName: typeof actualTabName === "string" ? actualTabName.trim() : "",
  };
}

export function validateSheetSourceHeaderContract(
  profile: SheetSourceProfile | null | undefined,
  actualHeaders: Readonly<Record<string, unknown>>,
): SheetSourceContractValidation {
  const expectedHeaders = profile?.headerContract ?? {};
  const columns = Object.keys(expectedHeaders).sort(compareSheetColumns);
  const expectedEntries = columns.map((column) => [
    column,
    normalizeHeaderContractValue(expectedHeaders[column]),
  ] as const);
  const actualEntries = columns.map((column) => [
    column,
    normalizeActualHeaderContractValue(
      expectedHeaders[column],
      actualHeaders[column],
    ),
  ] as const);
  const missingColumns = actualEntries
    .filter(([, value]) => !value)
    .map(([column]) => column);
  const mismatchedColumns = actualEntries
    .filter(([column, value]) => value && value !== normalizeHeaderContractValue(expectedHeaders[column]))
    .map(([column]) => column);
  const fingerprint = (entries: readonly (readonly [string, string])[]) =>
    createHash("sha256")
      .update(entries.map(([column, value]) => `${column}:${value}`).join("\n"))
      .digest("hex");
  return {
    valid: Boolean(profile) && missingColumns.length === 0 && mismatchedColumns.length === 0,
    expectedFingerprint: fingerprint(expectedEntries),
    actualFingerprint: fingerprint(actualEntries),
    mismatchedColumns,
    missingColumns,
  };
}

export function resolveSheetControlSourceId(input: {
  sourceKey?: unknown;
  sourceId?: unknown;
}): string {
  const requestedSourceId = cleanSourceId(input.sourceId);
  const profile = knownSheetSourceProfileByKey(input.sourceKey);
  if (input.sourceKey !== undefined && input.sourceKey !== null && !profile) {
    throw failedPrecondition("Sheet source key is not in the reviewed Sheet topology.");
  }
  if (!profile) return requestedSourceId;
  if (requestedSourceId && requestedSourceId !== profile.sourceId) {
    throw failedPrecondition("Sheet source key does not match sourceId.");
  }
  return profile.sourceId;
}

export function sheetSourceProfileForOperation(input: {
  spreadsheetId: unknown;
  sourceId: unknown;
  sourceKey?: unknown;
  environment?: SheetRuntimeEnvironment;
}): SheetSourceProfile {
  const spreadsheetId = cleanSpreadsheetId(input.spreadsheetId);
  const sourceId = cleanSourceId(input.sourceId);
  const profileBySourceId = knownSheetSourceProfileBySourceId(sourceId);
  const known = input.sourceKey !== undefined && input.sourceKey !== null
    ? resolveKnownSheetSourceProfile({ sourceKey: input.sourceKey, spreadsheetId })
    : profileBySourceId?.spreadsheetId === spreadsheetId
      ? profileBySourceId
      : resolveKnownSheetSourceProfile({ spreadsheetId });
  if (known) {
    if (sourceId !== known.sourceId) {
      throw failedPrecondition("Sheet sourceId does not match its reviewed spreadsheet contract.");
    }
    return known;
  }
  const environment = input.environment ?? process.env;
  if (
    spreadsheetId.startsWith("staging_fixture_") &&
    sourceId === canonicalSourceId(spreadsheetId)
  ) {
    return {
      key: "staging_fixture",
      displayName: "Staging fixture",
      spreadsheetId,
      sourceId,
      domain: "staging_fixture",
      projectionStrategy: "applicant_projection",
      canonicalProgramId: SCP_CANONICAL_PROGRAM_ID,
      tabName: "fixture",
      tabNamePattern: "^fixture$",
      gid: "0",
      headerContract: {},
      startRow: 1,
      syncSupported: true,
    };
  }
  if (hasLoopbackFirestoreEmulator(environment)) {
    return {
      key: "staging_fixture",
      displayName: "Emulator fixture",
      spreadsheetId,
      sourceId,
      domain: "staging_fixture",
      projectionStrategy: "applicant_projection",
      canonicalProgramId: SCP_CANONICAL_PROGRAM_ID,
      tabName: "fixture",
      tabNamePattern: "^fixture$",
      gid: "0",
      headerContract: {},
      startRow: 1,
      syncSupported: true,
    };
  }
  throw failedPrecondition("Sheet source is not in the reviewed Sheet topology.");
}

export function resolveSheetIntakeWriteGate(input: {
  action: SheetIntakeWriteAction;
  spreadsheetId: unknown;
  sourceId: unknown;
  sourceKey?: unknown;
  environment?: SheetRuntimeEnvironment;
}): SheetIntakeWriteGate {
  const environment = input.environment ?? process.env;
  const spreadsheetId = cleanSpreadsheetId(input.spreadsheetId);
  const sourceId = cleanSourceId(input.sourceId);

  if (
    !hasLoopbackFirestoreEmulator(environment) &&
    environment.FLU_RUNTIME_ENV === undefined
  ) {
    throw failedPrecondition(
      "Sheet engine requires explicit FLU_RUNTIME_ENV=production for production writes.",
    );
  }

  if (!hasLoopbackFirestoreEmulator(environment) && environment.FLU_RUNTIME_ENV === "emulator") {
    throw failedPrecondition(
      "Sheet engine emulator writes require an explicit loopback Firestore emulator endpoint.",
    );
  }

  let resolution;
  try {
    resolution = resolveRuntimeEnvironment(environment);
  } catch (error) {
    if (environment.FLU_RUNTIME_ENV === "staging") {
      throw failedPrecondition(
        `Sheet engine staging runtime contract is invalid: ${safeErrorMessage(error)}`,
      );
    }
    throw error;
  }

  if (hasLoopbackFirestoreEmulator(environment)) {
    const sourceProfile = sheetSourceProfileForOperation({
      spreadsheetId,
      sourceId,
      sourceKey: input.sourceKey,
      environment,
    });
    assertSyncSupported(input.action, sourceProfile);
    return {
      mode: "emulator_write",
      runtime: "emulator",
      projectId: exactProjectId(environment) || "demo-flu",
      databaseId: resolution.databaseId,
      canonicalProgramId: canonicalProgramIdForSheetSourceProfile(sourceProfile),
      sourceProfile: sourceProfile.domain === "staging_fixture" ? null : sourceProfile,
    };
  }

  const sourceProfile = sheetSourceProfileForOperation({
    spreadsheetId,
    sourceId,
    sourceKey: input.sourceKey,
    environment,
  });
  assertSyncSupported(input.action, sourceProfile);
  const projectId = exactProjectId(environment);
  if (projectId !== FLU_PROJECT_ID) {
    throw failedPrecondition(
      `Sheet engine writes require the exact project ${FLU_PROJECT_ID}; received ${projectId || "none"}.`,
    );
  }

  if (resolution.runtimeEnvironment === "staging") {
    if (
      resolution.databaseId !== STAGING_FIRESTORE_DATABASE ||
      environment.FLU_FUNCTIONS_CODEBASE !== "staging"
    ) {
      throw failedPrecondition(
        "Sheet engine staging runtime contract requires codebase=staging and database=flu-staging.",
      );
    }
    return {
      mode: "staging_write",
      runtime: "staging",
      projectId,
      databaseId: resolution.databaseId,
      canonicalProgramId: canonicalProgramIdForSheetSourceProfile(sourceProfile),
      sourceProfile: sourceProfile.domain === "staging_fixture" ? null : sourceProfile,
    };
  }

  if (
    resolution.runtimeEnvironment !== "production" ||
    resolution.databaseId !== DEFAULT_FIRESTORE_DATABASE ||
    environment.FLU_FUNCTIONS_CODEBASE !== "default"
  ) {
    throw failedPrecondition(
      "Sheet engine production runtime contract requires codebase=default and database=(default).",
    );
  }
  if (environment.FLU_SHEET_INTAKE_LIVE_WRITE_MODE !== "enabled-v1") {
    throw failedPrecondition("Sheet engine production write gate is disabled.");
  }
  const allowedSpreadsheetIds = parseAllowlist(
    environment.FLU_SHEET_INTAKE_ALLOWED_SPREADSHEET_IDS,
  );
  if (!allowedSpreadsheetIds.has(spreadsheetId)) {
    throw failedPrecondition(
      "Sheet engine production source is not in FLU_SHEET_INTAKE_ALLOWED_SPREADSHEET_IDS.",
    );
  }
  if (sourceProfile.domain === "staging_fixture") {
    throw failedPrecondition("Sheet source is not in the reviewed Sheet topology.");
  }
  return {
    mode: "production_write",
    runtime: "production",
    projectId,
    databaseId: resolution.databaseId,
    canonicalProgramId: canonicalProgramIdForSheetSourceProfile(sourceProfile),
    sourceProfile,
  };
}

export function canonicalProgramIdForSheetSourceProfile(
  profile: Pick<SheetSourceProfile, "canonicalProgramId">,
): string {
  const raw = typeof profile.canonicalProgramId === "string"
    ? profile.canonicalProgramId.trim()
    : "";
  const canonical = resolveCanonicalProgramId(raw);
  if (!raw || canonical !== raw) {
    throw failedPrecondition(
      "Sheet source profile must declare one exact canonical programId.",
    );
  }
  return canonical;
}

function assertSyncSupported(
  action: SheetIntakeWriteAction,
  profile: SheetSourceProfile,
): void {
  if (action === "participant_roster_sync") {
    if (profile.key === "participant_registry") return;
    throw failedPrecondition(
      "Participant-roster projection writes are restricted to the reviewed participant registry source.",
    );
  }
  if (profile.key === "participant_registry") {
    throw failedPrecondition(
      "Participant-registry Sheet operations are blocked until the dedicated participant registry projection engine is activated.",
    );
  }
  if (action !== "sync" || profile.syncSupported) return;
  throw failedPrecondition(
    "Content-review Sheet ingestion must use the sheet3_submission_bridge engine; applicant intake sync is disabled for this source.",
  );
}

function cleanSpreadsheetId(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 160)
    : "";
}

function cleanSourceId(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 180)
    : "";
}

function cleanSourceKey(value: unknown): SheetSourceKey | "" {
  return value === "scp_apply" || value === "participant_selection" || value === "participant_registry" || value === "content_review" || value === "staging_fixture"
    ? value
    : "";
}

function canonicalSourceId(spreadsheetId: string): string {
  return cleanSourceId(`google_sheet:${spreadsheetId}`);
}

function semanticSourceId(
  key: Exclude<SheetSourceKey, "staging_fixture">,
  spreadsheetId: string,
  gid: string,
): string {
  return cleanSourceId(`google_sheet:${key}:${spreadsheetId}:${gid}`);
}

function normalizeContractText(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/g, " ")
    : "";
}

function normalizeHeaderContractValue(value: unknown): string {
  return normalizeContractText(value).toLocaleLowerCase("en-US");
}

function normalizeActualHeaderContractValue(
  expected: unknown,
  actual: unknown,
): string {
  const expectedValue = normalizeHeaderContractValue(expected);
  const actualValue = normalizeHeaderContractValue(actual);
  if (
    expectedValue === normalizeHeaderContractValue(SHEET_HEADER_BLANK_OR_MAIL) &&
    (actualValue === "" || actualValue === "mail")
  ) {
    return expectedValue;
  }
  return actualValue;
}

function safePatternMatch(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, "u").test(value);
  } catch {
    return false;
  }
}

function compareSheetColumns(left: string, right: string): number {
  return columnIndex(left) - columnIndex(right) || left.localeCompare(right);
}

function columnIndex(value: string): number {
  return [...value.toUpperCase()].reduce(
    (total, character) => total * 26 + character.charCodeAt(0) - 64,
    0,
  );
}

function parseAllowlist(value: unknown): Set<string> {
  if (typeof value !== "string") return new Set();
  return new Set(
    value
      .split(",")
      .map((entry) => cleanSpreadsheetId(entry.trim()))
      .filter(Boolean),
  );
}

function exactProjectId(environment: SheetRuntimeEnvironment): string {
  const candidates = [
    environment.GCLOUD_PROJECT,
    environment.GOOGLE_CLOUD_PROJECT,
    projectIdFromFirebaseConfig(environment.FIREBASE_CONFIG),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : "";
}

function projectIdFromFirebaseConfig(value: unknown): string {
  if (typeof value !== "string" || !value.trim().startsWith("{")) return "";
  try {
    const parsed = JSON.parse(value) as { projectId?: unknown };
    return typeof parsed.projectId === "string" ? parsed.projectId : "";
  } catch {
    return "";
  }
}

function hasLoopbackFirestoreEmulator(environment: SheetRuntimeEnvironment): boolean {
  const value = environment.FIRESTORE_EMULATOR_HOST;
  if (typeof value !== "string" || !value || value !== value.trim()) return false;
  try {
    const parsed = new URL(`http://${value}`);
    const hostname = parsed.hostname;
    const octets = hostname.split(".");
    const loopbackIpv4 =
      octets.length === 4 &&
      octets[0] === "127" &&
      octets.every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255);
    const loopback = hostname === "localhost" || hostname === "[::1]" || loopbackIpv4;
    return loopback &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      /^\d+$/.test(parsed.port) &&
      Number(parsed.port) > 0 &&
      Number(parsed.port) <= 65535;
  } catch {
    return false;
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : "invalid runtime";
}

function failedPrecondition(message: string): Error {
  return Object.assign(new Error(message), { code: "failed-precondition", errorCode: "failed_precondition_unauthorized" });
}
