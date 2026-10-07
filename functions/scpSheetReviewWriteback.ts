// flu 원장 판정 → 콘텐츠 검수 시트 되쓰기 (scpSheetReviewSync.ts 의 반대 방향 짝).
//
// scpSheetReviewSync.ts 는 시트(운영자가 AL/AM 열에 손으로 적은 판정) → flu 원장을 채운다.
// 그런데 flu 포털에서 직접 내린 판정(시트를 전혀 거치지 않은)은 그 반대 방향으로 시트에 반영될
// 길이 없었다 — 시트 쪽 "콘텐츠 검수" 운영 화면은 여전히 판정 전으로 보이고, 시트 레인(Apps
// Script)이 이미 판정된 건에 다시 메일을 보낼 위험이 있었다. 이 파일이 그 간극을 메운다.
//
// 스케줄은 새로 만들지 않는다 — functions/index.ts 의 기존 `scpSheetReviewSyncSchedule` (15분
// 주기) 안에서 스테이지 1(시트→원장) 다음의 스테이지 2로 호출된다. 불변식 게이트가 onSchedule
// 선언 개수를 검사하므로, 이 방향은 반드시 함수 호출로만 얹는다.
//
// 밸브(settings/scp_sheet_review_sync 의 writebackEnabled)는 읽기 방향(enabled)과 독립이다 —
// 부재/오타면 fail-closed. 시트 AL 열에 운영자가 방금 적은 판정이 있을 수 있으므로(시트→원장
// 레인은 원장이 queued 일 때만 적용되니, 이미 판정된 건에는 그 레인이 흐르지 않는다) 그 값이
// 우리 판정과 다르면 절대 덮지 않는다 — conflict 로만 기록한다. 시트에 행 자체가 없으면 새 행을
// 추가하지 않는다(A~AK 열은 다른 레인의 스키마다).

import { FieldPath } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { reviewDocId, SCP_VIDEO_REVIEW_STATE_COLLECTION } from "./videoReviewTransitionStore";
import {
  SCP_CONTENT_APPROVAL_REVIEW_SPREADSHEET_ID,
  SCP_CONTENT_APPROVAL_REVIEW_TAB_NAME,
  SCP_SHEET_REVIEW_SYNC_SETTINGS_DOC,
  SCP_SHEET_REVIEW_SYNC_STATE_COLLECTION,
  selectRotationWindow,
} from "./scpSheetReviewSync";
import { defaultProgramTitle, requiredHashtagsForTitle, resolveProgramTitlesOrDefault } from "./programTitles";

// ---- 밸브 (부재/오타 = 닫힘. 읽기 방향 enabled 와 독립 필드) ------------------------------------

export const SCP_SHEET_REVIEW_WRITEBACK_DEFAULT_LIMIT = 25;
export const SCP_SHEET_REVIEW_WRITEBACK_MAX_LIMIT = 200;
export const SCP_SHEET_REVIEW_WRITEBACK_DEFAULT_STAMP_TEMPLATE = "flu 판정 반영 ({timestamp})";

export type SheetReviewWritebackGate = {
  writebackEnabled: boolean;
  writebackLimit: number;
  stampTemplate: string | null;
  cursor: string | null;
};

export function parseSheetReviewWritebackGate(data: Record<string, unknown> | undefined | null): SheetReviewWritebackGate {
  const rawLimit = Math.trunc(Number(data?.writebackLimit));
  const rawCursor = typeof data?.writebackCursor === "string" ? data.writebackCursor.trim() : "";
  const rawTemplate = typeof data?.writebackStampTemplate === "string" ? data.writebackStampTemplate.trim() : "";
  return {
    writebackEnabled: data?.writebackEnabled === true,
    cursor: rawCursor || null,
    stampTemplate: rawTemplate || null,
    writebackLimit:
      Number.isFinite(rawLimit) && rawLimit >= 1
        ? Math.min(rawLimit, SCP_SHEET_REVIEW_WRITEBACK_MAX_LIMIT)
        : SCP_SHEET_REVIEW_WRITEBACK_DEFAULT_LIMIT,
  };
}

export async function readScpSheetReviewWritebackGate(
  db: FirebaseFirestore.Firestore = adminDb,
): Promise<SheetReviewWritebackGate> {
  const [collection, docId] = SCP_SHEET_REVIEW_SYNC_SETTINGS_DOC.split("/");
  const snapshot = await db.collection(collection).doc(docId).get().catch(() => null);
  return parseSheetReviewWritebackGate(snapshot?.exists ? (snapshot.data() ?? {}) : undefined);
}

// ---- 원장 판정 → 시트 판정 매핑 (순수) -----------------------------------------------------------

export type SheetReviewWritebackVerdict = "approval" | "disapproval";

// W127-critical(리뷰): changes_requested 는 재제출을 기다리는 상태다. 시트에 "판정 완료 + 메일
// 스탬프"로 찍으면 아직 안 끝난 건이 끝난 것처럼 오표시된다 — 되쓰기 대상에서 완전히 뺀다(어느
// 칸도 쓰지 않는다). approved/rejected 만 시트에 되쓴다.
/** approved 는 approval, rejected 는 disapproval. changes_requested 를 포함한 그 외는 미판정. */
export function verdictFromLedgerState(state: string): SheetReviewWritebackVerdict | null {
  if (state === "approved") return "approval";
  if (state === "rejected") return "disapproval";
  return null;
}

/** reviewLedger 배열의 마지막(HEAD) 엔트리 — 순번이 아니라 배열 끝이 최신 판정이다. */
export function ledgerHeadEntry(reviewLedger: unknown): Record<string, unknown> | null {
  if (!Array.isArray(reviewLedger) || reviewLedger.length === 0) return null;
  const last = reviewLedger[reviewLedger.length - 1];
  return last && typeof last === "object" && !Array.isArray(last) ? (last as Record<string, unknown>) : null;
}

// ---- AM 사유 문안 매핑 (순수) ---------------------------------------------------------------------
//
// 2026-09-17 헤세: 해니/샘이 실제로 적어 온 AM 문구(prod 표본 112건 반려)를 정본으로 삼는다 —
// 종전에는 operatorMessage 가 없으면 원장의 기계 reasonCode(예: "content_quality")를 그대로
// AM 에 적어, 자동화 판정(대개 operatorMessage 가 없다)이 시트에 코드 값으로 노출됐다.
//
// Task-94 자동반려 3룰(videoReviewAutoRejectCore.ts 의 r3_video_unavailable/r5_duration_below_min/
// r8_required_hashtags_absent)은 reasonCode 로 도달하지 않는다 — r5·r8 은 둘 다 reasonCode
// "policy_gate_failed" 를 공유하고(RULE_REASON_CODE), r3 는 "video_unavailable" 하나로 "영상
// 안 열림"과 "비공개/미등록"을 모두 묶는다. 룰별 구분은 reasonTagKeys(AUTO_REJECT_RULE_TAG_KEYS
// 가 싣는 videoReviewCriteria.ts 룰 키)로만 가능하므로, 이 매퍼는 reasonCode 보다 먼저
// reasonTagKeys 를 확인한다.

export type SheetReasonMessageDecisionInput = {
  reasonCode: string | null;
  /** 카탈로그 밖 값이 other_documented 로 강등됐을 때의 원래 문자열(normalizeVideoReviewReasonCode). */
  reasonCodeRaw?: string | null;
  operatorMessage: string | null;
  /** videoReviewCriteria.ts VideoReviewRuleKey 값 — 위반한 룰의 태그(W121 반려 불릿과 동일 축). */
  reasonTagKeys?: readonly string[] | null;
  /** subject.gameId 로 해석된 타이틀명(예: "XP Hero") — 없으면 제네릭 문구로 떨어진다. */
  gameName?: string | null;
  /** requiredHashtagsForTitle 을 공백으로 join 한 문자열(예: "#SuperCreatorPartners #Supercent #XPHero"). */
  requiredHashtagsText?: string | null;
};

const SHEET_REASON_GENERIC_MESSAGE = "Your submission did not meet the campaign content policy.";
const SHEET_REASON_STORE_LINK_MISSING_MESSAGE = "Game store link is missing";
const SHEET_REASON_FALLBACK_HASHTAGS = "#SuperCreatorPartners #Supercent";

/** REVIEW_REASON_CODES(videoReviewReasonCodeCatalog.ts) 값 → AM 문구. 여기 없는 코드는 제네릭. */
const SHEET_REASON_CODE_MESSAGES: Readonly<Record<string, string>> = {
  content_quality: "Simple walkthrough videos are not accepted",
  video_unavailable: "The video at the provided link is unavailable",
  duplicate_content: "Duplicate videos are not allowed",
  wrong_video: "The link pointed to a different video than the one registered",
};

/** AM 에 쓸 사유 문안 — operatorMessage(사람 문구) 가 항상 최우선이다. */
export function sheetReasonMessageForDecision(input: SheetReasonMessageDecisionInput): string {
  const operatorMessage = (input.operatorMessage ?? "").trim();
  if (operatorMessage) return operatorMessage;

  const reasonCode = (input.reasonCode ?? "").trim();
  const tagKeys = new Set((input.reasonTagKeys ?? []).filter((key): key is string => typeof key === "string"));

  if (tagKeys.has("duration_min_20s")) return "The video is shorter than 20 seconds";
  if (tagKeys.has("required_hashtags")) {
    const hashtags = (input.requiredHashtagsText ?? "").trim();
    return `Required hashtags are missing (${hashtags || SHEET_REASON_FALLBACK_HASHTAGS})`;
  }
  if (tagKeys.has("xp_hero_store_link")) return SHEET_REASON_STORE_LINK_MISSING_MESSAGE;
  // r3 는 reasonCode "video_unavailable" 하나로 도달한다(위 주석) — 그 코드 전용 문구가 이미
  // "안 열림/비공개" 둘 다 커버하므로, "not public" 문구는 reasonCode 가 그게 아닐 때만 쓴다
  // (사람이 policy_gate_failed 같은 다른 코드에 이 태그만 골랐을 때를 위한 대비).
  if (tagKeys.has("public_visibility") && reasonCode !== "video_unavailable") return "The video is not public";

  if (reasonCode === "metadata_mismatch") {
    const gameName = (input.gameName ?? "").trim();
    return gameName ? `Not ${gameName} content` : "Not the campaign game content";
  }
  const mapped = SHEET_REASON_CODE_MESSAGES[reasonCode];
  if (mapped) return mapped;

  return SHEET_REASON_GENERIC_MESSAGE;
}

export type SheetReasonMessageGameContext = { gameName: string | null; requiredHashtagsText: string | null };

/** AM 에 쓸 사유 문안 — 원장 헤드 엔트리에서 필드를 뽑아 sheetReasonMessageForDecision 에 위임한다. */
export function reasonMessageFromLedgerHead(
  head: Record<string, unknown> | null,
  gameContext?: SheetReasonMessageGameContext | null,
): string {
  const operatorMessage = typeof head?.operatorMessage === "string" ? head.operatorMessage.trim() : "";
  const reasonCode = typeof head?.reasonCode === "string" ? head.reasonCode.trim() : "";
  const reasonCodeRaw = typeof head?.reasonCodeRaw === "string" ? head.reasonCodeRaw.trim() : "";
  const reasonTagKeys = Array.isArray(head?.reasonTagKeys)
    ? (head!.reasonTagKeys as unknown[]).filter((key): key is string => typeof key === "string")
    : null;
  return sheetReasonMessageForDecision({
    operatorMessage: operatorMessage || null,
    reasonCode: reasonCode || null,
    reasonCodeRaw: reasonCodeRaw || null,
    reasonTagKeys,
    gameName: gameContext?.gameName ?? null,
    requiredHashtagsText: gameContext?.requiredHashtagsText ?? null,
  });
}

/**
 * subject.gameId/canonicalProgramId → 타이틀명 + 필수 해시태그 문구. 레지스트리 조회는
 * programTitles.ts SEEDED_PROGRAM_TITLE_REGISTRIES 인메모리 조회라 I/O 가 없다(순수).
 * gameId 가 레지스트리에 없으면(미등록/기본값 스탬프 등) 프로그램 기본 타이틀로 떨어진다 —
 * "정확한 제출 타이틀"이 아니라 최선의 근사값이다고 주석에 남긴다.
 */
export function resolveWritebackGameContext(
  canonicalProgramId: string | null | undefined,
  gameId: string | null | undefined,
): SheetReasonMessageGameContext {
  if (!canonicalProgramId) return { gameName: null, requiredHashtagsText: null };
  const registry = resolveProgramTitlesOrDefault(canonicalProgramId);
  const title = (gameId && registry.titles.find((candidate) => candidate.id === gameId)) || defaultProgramTitle(registry);
  if (!title) return { gameName: null, requiredHashtagsText: null };
  return { gameName: title.name, requiredHashtagsText: requiredHashtagsForTitle(registry, title).join(" ") };
}

// ---- AN 스탬프 (선기입 — 시트 레인이 이 행을 발송 대상에서 빼도록 항상 비어있지 않게) -----------

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** KST(UTC+9, DST 없음) 기준 "yyyy-MM-dd HH:mm". */
export function formatKstTimestamp(date: Date): string {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = pad2(kst.getUTCMonth() + 1);
  const dd = pad2(kst.getUTCDate());
  const HH = pad2(kst.getUTCHours());
  const MI = pad2(kst.getUTCMinutes());
  return `${yyyy}-${mm}-${dd} ${HH}:${MI}`;
}

/** settings 의 writebackStampTemplate 이 있으면 그걸, 없으면 기본 문안을 쓴다. {timestamp} 를 치환한다. */
export function buildWritebackStamp(template: string | null, now: Date): string {
  const ts = formatKstTimestamp(now);
  const tpl = template && template.trim() ? template.trim() : SCP_SHEET_REVIEW_WRITEBACK_DEFAULT_STAMP_TEMPLATE;
  return tpl.includes("{timestamp}") ? tpl.split("{timestamp}").join(ts) : tpl;
}

// ---- 행 단위 되쓰기 계획 (순수) ------------------------------------------------------------------

export type SheetReviewWritebackCells = { al?: string; am?: string; an: string };

export type SheetReviewWritebackPlan =
  | { kind: "row_missing" }
  | { kind: "conflict" }
  | { kind: "skip_same" }
  | { kind: "write"; rowNumber: number; cells: SheetReviewWritebackCells };

export function planSheetReviewWritebackRow(input: {
  ledgerVerdict: SheetReviewWritebackVerdict;
  reasonMessage: string;
  stampValue: string;
  sheetRow: { rowNumber: number; verdictRaw: string; reasonRaw: string; mailStampRaw: string } | null;
}): SheetReviewWritebackPlan {
  if (!input.sheetRow) return { kind: "row_missing" };
  const { rowNumber, verdictRaw, reasonRaw, mailStampRaw } = input.sheetRow;
  const normalizedCurrent = verdictRaw.trim().toLowerCase();
  const target = input.ledgerVerdict;

  // AL 에 이미 값이 있고 우리 판정과 다르면 절대 덮지 않는다 — 운영자가 시트에 방금 적은 판정일
  // 수 있다(사람 의사를 지우지 않는다).
  if (normalizedCurrent && normalizedCurrent !== target) {
    return { kind: "conflict" };
  }

  if (normalizedCurrent === target) {
    // 멱등: AL 은 이미 맞다. AN 스탬프가 비어 있을 때만 채운다(AM 은 손대지 않는다).
    if (mailStampRaw.trim()) return { kind: "skip_same" };
    return { kind: "write", rowNumber, cells: { an: input.stampValue } };
  }

  // AL 공란 — AL/AN 은 항상 쓴다. AM 은 비어 있을 때만 쓴다(리뷰 MEDIUM: 운영자가 AM 에 이미
  // 메모를 남겨 놨으면 그 메모를 지우지 않는다 — 비어 있지 않으면 AL/AN 만 쓴다).
  const cells: SheetReviewWritebackCells = { al: target, an: input.stampValue };
  if (!reasonRaw.trim()) cells.am = input.reasonMessage;
  return { kind: "write", rowNumber, cells };
}

// ---- 시트 원시 행 인덱싱 (순수) ------------------------------------------------------------------

// A=submission_id(0)·AL=판정(37)·AM=반려사유(38)·AN=메일스탬프(39) — scpSheetReviewSync.ts 와
// 동일한 스키마 밖 열 인덱스(파일 로컬 사본; 이 레포 관례대로 열 인덱스는 헤더 이름에 의존하지
// 않는다).
const COL_SUBMISSION_ID = 0;
const COL_VERDICT = 37;
const COL_REASON = 38;
const COL_MAIL_STAMP = 39;
const SHEET_READ_MAX_ROWS = 20_000;

export type SheetReviewWritebackSheetRow = {
  rowNumber: number;
  submissionId: string;
  verdictRaw: string;
  reasonRaw: string;
  mailStampRaw: string;
};

function cleanCell(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/** rawRows[i] 는 시트 행 (i+2) 다(범위가 A2 부터 시작하므로). 중복 submission_id 는 첫 occurrence 를 쓴다. */
export function indexWritebackSheetRows(rawRows: readonly unknown[][]): Map<string, SheetReviewWritebackSheetRow> {
  const map = new Map<string, SheetReviewWritebackSheetRow>();
  rawRows.forEach((rawRow, index) => {
    const submissionId = cleanCell((rawRow as unknown[])[COL_SUBMISSION_ID]);
    if (!submissionId || map.has(submissionId)) return;
    map.set(submissionId, {
      rowNumber: index + 2,
      submissionId,
      verdictRaw: cleanCell((rawRow as unknown[])[COL_VERDICT]),
      reasonRaw: cleanCell((rawRow as unknown[])[COL_REASON]),
      mailStampRaw: cleanCell((rawRow as unknown[])[COL_MAIL_STAMP]),
    });
  });
  return map;
}

// ---- 결과 원장 병기 (scp_sheet_review_sync_state — 기존 시트→flu 필드와 섞지 않는다) ------------

export type SheetReviewWritebackOutcome = "written" | "skipped_same" | "conflict" | "row_missing" | "failed";

export type SheetReviewWritebackOutcomeState = {
  writebackLastOutcome?: SheetReviewWritebackOutcome | null;
  writebackAtIso?: string | null;
  writebackSheetVerdictSeen?: SheetReviewWritebackVerdict | null;
};

export function nextSheetReviewWritebackOutcome(input: {
  outcome: SheetReviewWritebackOutcome;
  verdictSeen: SheetReviewWritebackVerdict;
  nowIso: string;
}): Required<SheetReviewWritebackOutcomeState> {
  return {
    writebackLastOutcome: input.outcome,
    writebackAtIso: input.nowIso,
    writebackSheetVerdictSeen: input.verdictSeen,
  };
}

// ---- I/O: 시트 원시 값 읽기 (scpSheetReviewSync.ts 의 파일 로컬 사본 관례를 그대로 따른다 — 새
//      자격증명을 들이지 않는다. metadataAccessToken 은 그 파일의 사본과 동일하다) ----------------

function failedPrecondition(message: string): Error {
  return Object.assign(new Error(message), { code: "failed-precondition", errorCode: "scp_sheet_review_writeback_failed_precondition" });
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
    const body = (await response.json()) as { access_token?: unknown };
    return typeof body.access_token === "string" ? body.access_token.slice(0, 4096) : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

async function sheetsAccessToken(): Promise<string> {
  const env = process.env.GOOGLE_SHEETS_ACCESS_TOKEN || process.env.SHEETS_ACCESS_TOKEN || "";
  if (env) return env.trim();
  const metadata = await metadataAccessToken();
  if (metadata) return metadata;
  throw failedPrecondition("Google Sheets bearer credentials are not configured for the content-review writeback lane.");
}

function quoteSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

export async function readSheetReviewWritebackRawRows(input: {
  spreadsheetId?: string;
  tabName?: string;
  /** 테스트/도구 주입용 — 주어지면 네트워크를 타지 않는다. */
  rows?: unknown[][];
} = {}): Promise<unknown[][]> {
  if (input.rows) return input.rows;
  const spreadsheetId = input.spreadsheetId ?? SCP_CONTENT_APPROVAL_REVIEW_SPREADSHEET_ID;
  const tabName = input.tabName ?? SCP_CONTENT_APPROVAL_REVIEW_TAB_NAME;
  const accessToken = process.env.GOOGLE_SHEETS_ACCESS_TOKEN || process.env.SHEETS_ACCESS_TOKEN || (await metadataAccessToken());
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY || process.env.SHEETS_API_KEY || "";
  if (!accessToken && !apiKey) {
    throw failedPrecondition("Google Sheets credentials are not configured for the content-review writeback lane.");
  }
  const range = `${tabName}!A2:AN${SHEET_READ_MAX_ROWS + 1}`;
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
  );
  url.searchParams.set("majorDimension", "ROWS");
  if (apiKey && !accessToken) url.searchParams.set("key", apiKey);
  const response = await fetch(url, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined });
  if (!response.ok) {
    throw failedPrecondition(`Google Sheets content-review writeback read failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { values?: unknown[][] };
  return Array.isArray(body.values) ? body.values : [];
}

// ---- I/O: 시트에 3셀만 쓴다 (values.batchUpdate, 행 단위) -----------------------------------------

export type SheetReviewWritebackCellUpdate = { rowNumber: number; al?: string; am?: string; an: string };

function singleCellRangeData(quotedTab: string, column: "AL" | "AM" | "AN", rowNumber: number, value: string) {
  return {
    range: `${quotedTab}!${column}${rowNumber}:${column}${rowNumber}`,
    majorDimension: "ROWS",
    values: [[value]],
  };
}

/**
 * 후보(al/am 이 있으면 쓰고, 없으면 그 칸은 건드리지 않는다 — 리뷰 MEDIUM: AM 에 운영자 메모가
 * 있으면 그 칸 자체를 payload 에 넣지 않아야 "보존"이 맞다. 같은 값을 다시 써도 값은 안 바뀌지만
 * 시트 변경 이력엔 손댄 것으로 남는다). AN 은 쓰기 대상이면 항상 채운다. 열마다 단일 셀 range 라
 * 최대 3개까지지만("행 단위 3셀만"), 실제로는 AM 이 비어있지 않으면 AL/AN 2개만 나간다.
 */
function buildWritebackRowData(quotedTab: string, update: SheetReviewWritebackCellUpdate) {
  const data: ReturnType<typeof singleCellRangeData>[] = [];
  if (update.al !== undefined) data.push(singleCellRangeData(quotedTab, "AL", update.rowNumber, update.al));
  if (update.am !== undefined) data.push(singleCellRangeData(quotedTab, "AM", update.rowNumber, update.am));
  data.push(singleCellRangeData(quotedTab, "AN", update.rowNumber, update.an));
  return data;
}

// 리뷰 LOW: 후보 1건마다 별도 batchUpdate 호출을 하지 않는다 — 호출부(runScpSheetReviewWriteback)
// 가 사이클에서 쓸 후보를 전부 모아 이 함수를 사이클당 정확히 한 번만 부른다(최대 writebackLimit
// 건이라도 API 호출은 1회).
export async function writeSheetReviewWritebackCells(input: {
  spreadsheetId?: string;
  tabName?: string;
  updates: SheetReviewWritebackCellUpdate[];
}): Promise<void> {
  if (input.updates.length === 0) return;
  const spreadsheetId = input.spreadsheetId ?? SCP_CONTENT_APPROVAL_REVIEW_SPREADSHEET_ID;
  const tabName = input.tabName ?? SCP_CONTENT_APPROVAL_REVIEW_TAB_NAME;
  const accessToken = await sheetsAccessToken();
  const quotedTab = quoteSheetName(tabName);
  const data = input.updates.flatMap((update) => buildWritebackRowData(quotedTab, update));
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
    },
  );
  if (!response.ok) {
    throw failedPrecondition(`Google Sheets writeback batchUpdate failed with HTTP ${response.status}`);
  }
}

// ---- I/O: 원장에서 판정 완료 후보를 가져온다 (회전 커서) ------------------------------------------

// changes_requested 는 뺀다 — verdictFromLedgerState 와 동일한 이유(재제출 대기 상태를 완료로
// 오표시하지 않는다). 실 쿼리가 애초에 그 상태의 문서를 가져오지 않게 한다.
const JUDGED_STATES = ["approved", "rejected"] as const;

export type WritebackLedgerCandidate = {
  submissionId: string;
  state: string;
  reviewLedger?: unknown;
  /** AM 문구의 게임명/해시태그 해석용(resolveWritebackGameContext) — 없으면 제네릭 문구로 떨어진다. */
  canonicalProgramId?: string | null;
  gameId?: string | null;
};

async function fetchJudgedLedgerCandidates(
  db: FirebaseFirestore.Firestore,
  cursor: string | null,
  limit: number,
): Promise<{ candidates: WritebackLedgerCandidate[]; cursorWrapped: boolean; nextCursor: string | null }> {
  let query = db
    .collection(SCP_VIDEO_REVIEW_STATE_COLLECTION)
    .where("state", "in", [...JUDGED_STATES])
    .orderBy(FieldPath.documentId());
  if (cursor) query = query.startAfter(cursor);
  const snapshot = await query.limit(limit).get();
  const docs = snapshot.docs;
  const candidates: WritebackLedgerCandidate[] = docs.map((doc) => {
    const data = doc.data() as Record<string, unknown>;
    const subject = data.subject && typeof data.subject === "object" ? (data.subject as Record<string, unknown>) : {};
    const submissionId =
      typeof subject.videoSubmissionId === "string" && subject.videoSubmissionId ? subject.videoSubmissionId : doc.id;
    return {
      submissionId,
      state: String(data.state ?? "queued"),
      reviewLedger: data.reviewLedger,
      canonicalProgramId: typeof data.canonicalProgramId === "string" ? data.canonicalProgramId : null,
      gameId: typeof subject.gameId === "string" ? subject.gameId : null,
    };
  });
  const wrapped = docs.length < limit;
  const last = docs.at(-1);
  return { candidates, cursorWrapped: wrapped, nextCursor: wrapped || !last ? null : last.id };
}

// ---- I/O: 사이클 오케스트레이션 --------------------------------------------------------------------

export type ScpSheetReviewWritebackCycleResult = {
  enabled: boolean;
  writebackLimit: number;
  scanned: number;
  written: number;
  skippedSame: number;
  conflict: number;
  rowMissing: number;
  failed: number;
  corpus: number;
  cursorWrapped: boolean;
  nextCursor: string | null;
};

function emptyWritebackResult(gate: SheetReviewWritebackGate): ScpSheetReviewWritebackCycleResult {
  return {
    enabled: gate.writebackEnabled,
    writebackLimit: gate.writebackLimit,
    scanned: 0,
    written: 0,
    skippedSame: 0,
    conflict: 0,
    rowMissing: 0,
    failed: 0,
    corpus: 0,
    cursorWrapped: false,
    nextCursor: null,
  };
}

async function safeRecordOutcome(
  db: FirebaseFirestore.Firestore,
  submissionId: string,
  patch: Required<SheetReviewWritebackOutcomeState>,
): Promise<void> {
  try {
    await db.collection(SCP_SHEET_REVIEW_SYNC_STATE_COLLECTION).doc(reviewDocId(submissionId)).set(patch, { merge: true });
  } catch (error) {
    console.warn("[sheet-review-writeback] outcome_write_failed", JSON.stringify({
      code: (error as { code?: unknown })?.code ?? "unknown_error",
    }));
  }
}

async function persistWritebackCursor(db: FirebaseFirestore.Firestore, nextCursor: string | null): Promise<void> {
  const [collection, docId] = SCP_SHEET_REVIEW_SYNC_SETTINGS_DOC.split("/");
  try {
    await db.collection(collection).doc(docId).set(
      { writebackCursor: nextCursor, writebackLastRunAtIso: new Date().toISOString() },
      { merge: true },
    );
  } catch (error) {
    console.warn("[sheet-review-writeback] cursor_persist_failed", JSON.stringify({
      code: (error as { code?: unknown })?.code ?? "unknown_error",
    }));
  }
}

export async function runScpSheetReviewWriteback(
  opts: {
    now?: Date;
    db?: FirebaseFirestore.Firestore;
    gate?: SheetReviewWritebackGate;
    /** 테스트/도구 주입용 원시 시트 행(값 배열). 생략하면 실제 Sheets API 를 읽는다. */
    sheetRows?: unknown[][];
    /**
     * 테스트/도구 주입용 원장 판정 후보(회전 커서 우회). 생략하면 실제 Firestore 쿼리로
     * `scp_video_review_state` 에서 판정 완료 건을 가져온다.
     */
    ledgerCandidates?: WritebackLedgerCandidate[];
    /** 테스트/도구 주입용 시트 쓰기 — 주어지면 실제 Sheets API 를 타지 않는다. */
    writeCells?: (updates: SheetReviewWritebackCellUpdate[]) => Promise<void>;
  } = {},
): Promise<ScpSheetReviewWritebackCycleResult> {
  const db = opts.db ?? adminDb;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const gate = opts.gate ?? (await readScpSheetReviewWritebackGate(db));
  if (!gate.writebackEnabled) return emptyWritebackResult(gate);

  const rawSheetRows = await readSheetReviewWritebackRawRows({ rows: opts.sheetRows });
  const sheetIndex = indexWritebackSheetRows(rawSheetRows);
  const stampValue = buildWritebackStamp(gate.stampTemplate, now);

  const result = emptyWritebackResult(gate);

  let candidates: WritebackLedgerCandidate[];
  let cursorWrapped: boolean;
  let nextCursor: string | null;
  if (opts.ledgerCandidates) {
    const rotation = selectRotationWindow(opts.ledgerCandidates, gate.cursor, gate.writebackLimit);
    candidates = rotation.window;
    cursorWrapped = rotation.wrapped;
    nextCursor = rotation.nextCursor;
    result.corpus = opts.ledgerCandidates.length;
  } else {
    const fetched = await fetchJudgedLedgerCandidates(db, gate.cursor, gate.writebackLimit);
    candidates = fetched.candidates;
    cursorWrapped = fetched.cursorWrapped;
    nextCursor = fetched.nextCursor;
    // 실 쿼리 경로에서는 전체 코퍼스 크기를 별도 count 쿼리 없이는 알 수 없다 — corpus 는 이번
    // 사이클 스캔 창 크기로 대체 보고한다(비용 이유로 매 사이클 집계 쿼리를 추가하지 않는다).
    result.corpus = candidates.length;
  }
  result.cursorWrapped = cursorWrapped;
  result.nextCursor = nextCursor;
  result.scanned = candidates.length;

  const writeCells = opts.writeCells ?? ((updates) => writeSheetReviewWritebackCells({ updates }));

  if (candidates.length === 0) {
    await persistWritebackCursor(db, nextCursor);
    return result;
  }

  // 리뷰 LOW: 후보별로 즉시 batchUpdate 를 부르지 않는다 — 쓰기 대상만 모아 사이클 끝에 한 번만
  // 보낸다(최대 writebackLimit 건이라도 Sheets API 호출은 1회). 한 번의 호출이 실패하면 이번
  // 사이클에서 모인 쓰기 대상 전부를 failed 로 기록한다(부분 성공을 가정하지 않는다).
  const pendingWrites: Array<{ submissionId: string; verdict: SheetReviewWritebackVerdict; update: SheetReviewWritebackCellUpdate }> = [];

  for (const candidate of candidates) {
    const verdict = verdictFromLedgerState(candidate.state);
    if (!verdict) continue; // 판정 완료가 아닌 후보(changes_requested 포함) — 방어적, 어떤 칸도 안 쓴다

    const head = ledgerHeadEntry(candidate.reviewLedger);
    // 승인 건은 AM 을 절대 건드리지 않는다(기존 계약) — reasonMessage 자체를 계산하지 않아,
    // 레거시 시트 수입 등에서 approved 인데 reasonCode 가 실려 있는 예외 케이스가 있어도 AM 에
    // 반려 문구가 새는 일이 없다.
    const reasonMessage =
      verdict === "disapproval"
        ? reasonMessageFromLedgerHead(head, resolveWritebackGameContext(candidate.canonicalProgramId, candidate.gameId))
        : "";
    const sheetRow = sheetIndex.get(candidate.submissionId) ?? null;
    const plan = planSheetReviewWritebackRow({
      ledgerVerdict: verdict,
      reasonMessage,
      stampValue,
      sheetRow: sheetRow
        ? {
            rowNumber: sheetRow.rowNumber,
            verdictRaw: sheetRow.verdictRaw,
            reasonRaw: sheetRow.reasonRaw,
            mailStampRaw: sheetRow.mailStampRaw,
          }
        : null,
    });

    if (plan.kind === "row_missing") {
      result.rowMissing += 1;
      await safeRecordOutcome(db, candidate.submissionId, nextSheetReviewWritebackOutcome({ outcome: "row_missing", verdictSeen: verdict, nowIso }));
      continue;
    }
    if (plan.kind === "conflict") {
      result.conflict += 1;
      await safeRecordOutcome(db, candidate.submissionId, nextSheetReviewWritebackOutcome({ outcome: "conflict", verdictSeen: verdict, nowIso }));
      continue;
    }
    if (plan.kind === "skip_same") {
      result.skippedSame += 1;
      await safeRecordOutcome(db, candidate.submissionId, nextSheetReviewWritebackOutcome({ outcome: "skipped_same", verdictSeen: verdict, nowIso }));
      continue;
    }

    // plan.kind === "write" — 이번 사이클 배치에 모은다.
    pendingWrites.push({
      submissionId: candidate.submissionId,
      verdict,
      update: { rowNumber: plan.rowNumber, ...plan.cells },
    });
  }

  if (pendingWrites.length > 0) {
    try {
      await writeCells(pendingWrites.map((pending) => pending.update));
      for (const pending of pendingWrites) {
        result.written += 1;
        await safeRecordOutcome(db, pending.submissionId, nextSheetReviewWritebackOutcome({ outcome: "written", verdictSeen: pending.verdict, nowIso }));
      }
    } catch {
      for (const pending of pendingWrites) {
        result.failed += 1;
        await safeRecordOutcome(db, pending.submissionId, nextSheetReviewWritebackOutcome({ outcome: "failed", verdictSeen: pending.verdict, nowIso }));
      }
    }
  }

  await persistWritebackCursor(db, nextCursor);
  return result;
}
