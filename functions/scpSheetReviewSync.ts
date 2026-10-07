// 콘텐츠 검수 시트 판정 → flu 원장 동기화 (sb Flu-15).
//
// 근인: "콘텐츠 검수" 탭(gid 1035597980)은 운영자가 직접 AL 열(판정)·AM 열(반려 사유)을 채워
// 넣는 write-only 미러였다 — flu 원장(`scp_video_review_state`)은 그 판정을 읽어오지 않아
// 영원히 `queued` 로 남았고, 포털 화면은 "심사 대기"를 계속 보여줬다(2026-08-24 CS 이슈).
//
// 이 파일은 그 시트를 15분 주기로 읽어 원장 상태가 `queued` 인 제출 건에 한해 기존 전이 코어
// (videoReviewTransitionStore.transitionVideoReviewDecision)를 직접 호출한다 — 콜러블을 거치지
// 않는다(시트 판정은 사람이 이미 내린 결정이라 재검증할 새 auth 컨텍스트가 없다).
//
// 승인은 partnerActivationStore 의 신원 완전성 게이트를 그대로 통과해야 한다 — 우회하지 않는다
// (identity가 `unclassified:` 센티널이면 `partner_activation_identity_incomplete` 로 fail-closed
// 되는 것이 정상 동작이다). 막힌 승인은 `scp_sheet_review_sync_state` 에 `blocked` 로 기록되고
// 6시간 백오프가 걸린다 — 같은 실패를 매 사이클(15분) 반복 로깅하지 않기 위해서다.
//
// notifyCreator 는 이 파일 전체에서 **리터럴 false 고정**이다. 시트 레인(Apps Script)이 이미
// AN 열(메일 스탬프)을 찍으며 크리에이터에게 통지 메일을 보냈다 — flu 가 다시 보내면 이중 발송이다.

import { adminDb } from "./firebaseAdmin";
import {
  transitionVideoReviewDecision,
  reviewDocId,
  SCP_VIDEO_REVIEW_STATE_COLLECTION,
  type TransitionCommandInput,
} from "./videoReviewTransitionStore";
import { normalizeLegacyReviewState } from "./videoReviewTransitionCore";
import { PartnerActivationError } from "./partnerActivationStore";

// ---- 시트 원천 (스키마 밖 운영자 수기 열은 헤더 이름이 아니라 열 인덱스로 읽는다) --------------

export const SCP_CONTENT_APPROVAL_REVIEW_SPREADSHEET_ID = "1KTpJObX_plEeA_We3-KZiG0yUnB--OA6v8m8w5ZKyrw";
export const SCP_CONTENT_APPROVAL_REVIEW_TAB_NAME = "콘텐츠 검수";
export const SCP_CONTENT_APPROVAL_REVIEW_GID = "1035597980";

// A=submission_id(0) · O=google_email(14) · R=content_url(17) · AL=판정(37) · AM=반려사유(38) ·
// AN=메일스탬프(39). AL/AM/AN 은 스키마 밖(운영자 수기 열) — 헤더 이름에 의존하지 않는다.
const COL_SUBMISSION_ID = 0;
const COL_GOOGLE_EMAIL = 14;
const COL_CONTENT_URL = 17;
const COL_VERDICT = 37;
const COL_REASON = 38;
const COL_MAIL_STAMP = 39;
const SHEET_READ_MAX_ROWS = 20_000;

// ---- 밸브 (settings/scp_integration_event_v2_review_reconcile 과 같은 관례: 문서 부재 = 닫힘) ----

export const SCP_SHEET_REVIEW_SYNC_SETTINGS_DOC = "settings/scp_sheet_review_sync" as const;
export const SCP_SHEET_REVIEW_SYNC_STATE_COLLECTION = "scp_sheet_review_sync_state";
export const SCP_SHEET_REVIEW_SYNC_DEFAULT_SCAN_LIMIT = 25;
export const SCP_SHEET_REVIEW_SYNC_MAX_SCAN_LIMIT = 500;
// 막힌 승인(대부분 partner_activation_identity_incomplete)을 매 15분 사이클 반복 시도·반복
// 로깅하지 않게 링크당 재시도를 최소 6시간 간격으로 묶는다.
export const SCP_SHEET_REVIEW_SYNC_BLOCKED_BACKOFF_MS = 6 * 60 * 60 * 1000;
export const SCP_SHEET_REVIEW_SYNC_ACTOR_ID = "scp_sheet_review_sync_worker";

export type SheetReviewSyncGate = { enabled: boolean; scanLimit: number; cursor: string | null };

/** 순수 파서 — settings 문서가 없거나(undefined) 필드가 이상해도 fail-closed(enabled:false)다. */
export function parseSheetReviewSyncGate(data: Record<string, unknown> | undefined | null): SheetReviewSyncGate {
  const rawLimit = Math.trunc(Number(data?.scanLimit));
  const rawCursor = typeof data?.cursor === "string" ? data.cursor.trim() : "";
  return {
    enabled: data?.enabled === true,
    cursor: rawCursor || null,
    scanLimit:
      Number.isFinite(rawLimit) && rawLimit >= 1
        ? Math.min(rawLimit, SCP_SHEET_REVIEW_SYNC_MAX_SCAN_LIMIT)
        : SCP_SHEET_REVIEW_SYNC_DEFAULT_SCAN_LIMIT,
  };
}

export async function readScpSheetReviewSyncGate(
  db: FirebaseFirestore.Firestore = adminDb,
): Promise<SheetReviewSyncGate> {
  const [collection, docId] = SCP_SHEET_REVIEW_SYNC_SETTINGS_DOC.split("/");
  const snapshot = await db.collection(collection).doc(docId).get().catch(() => null);
  return parseSheetReviewSyncGate(snapshot?.exists ? (snapshot.data() ?? {}) : undefined);
}

// ---- 행 파싱 (순수) ------------------------------------------------------------------------------

export type SheetReviewSyncVerdict = "approval" | "disapproval";

export type SheetReviewSyncRow = {
  submissionId: string;
  googleEmail: string;
  contentUrl: string;
  verdict: SheetReviewSyncVerdict | null;
  reasonRaw: string;
  mailStamp: string;
};

function cleanCell(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/** AL 열의 정확한 두 값만 인정한다 — 그 외(공란 포함)는 아직 판정 전으로 보고 skip 한다. */
export function parseSheetVerdict(raw: string): SheetReviewSyncVerdict | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "approval") return "approval";
  if (normalized === "disapproval") return "disapproval";
  return null;
}

export function parseSheetReviewSyncRow(rawRow: unknown[]): SheetReviewSyncRow | null {
  const submissionId = cleanCell(rawRow[COL_SUBMISSION_ID]);
  if (!submissionId) return null;
  return {
    submissionId,
    googleEmail: cleanCell(rawRow[COL_GOOGLE_EMAIL]).toLowerCase(),
    contentUrl: cleanCell(rawRow[COL_CONTENT_URL]),
    verdict: parseSheetVerdict(cleanCell(rawRow[COL_VERDICT])),
    reasonRaw: cleanCell(rawRow[COL_REASON]),
    mailStamp: cleanCell(rawRow[COL_MAIL_STAMP]),
  };
}

// ---- 반려 사유 매핑 (순수) ------------------------------------------------------------------------

// 정확 일치 전용 — 시트 자유 문구를 서버 reasonCode 로 접는다. 미매칭은 other_documented(fail-closed
// 이 아니라 "모른다"를 정직하게 표시하는 값 — core 는 reasonCode 자체는 진리값만 본다).
const SHEET_REASON_TEXT_TO_CODE: ReadonlyMap<string, string> = new Map([
  ["The video at the provided link is unavailable", "video_unavailable"],
  ["Duplicate videos are not allowed", "duplicate_content"],
  ["Simple walkthrough videos are not accepted", "content_quality"],
  // 시트 드롭다운 원문의 오타("T" 누락)와, 운영자가 그 오타를 고쳤을 때의 교정본을 둘 다 명시한다.
  // 퍼지 매칭이 아니라 알려진 값 두 개를 열거하는 것이다 — 오타 수정이 조용한 분류 열화가 되지 않게.
  ["he audio and visuals do not match at all, making the content's purpose unclear", "metadata_mismatch"],
  ["The audio and visuals do not match at all, making the content's purpose unclear", "metadata_mismatch"],
]);
export const SHEET_REASON_FALLBACK_CODE = "other_documented";

export function mapSheetReasonToReasonCode(reasonRaw: string): string {
  // 시트 드롭다운 원문은 사람이 편집하는 값이라 대소문자·공백이 흔들린다(원문 오타 "he audio..."도
  // 그대로 키로 들어 있다). 정확일치만 보면 조용히 other_documented 로 열화되므로 정규화해서 맞춘다.
  const normalized = reasonRaw.trim().replace(/\s+/g, " ").toLowerCase();
  for (const [text, code] of SHEET_REASON_TEXT_TO_CODE) {
    if (text.trim().replace(/\s+/g, " ").toLowerCase() === normalized) return code;
  }
  return SHEET_REASON_FALLBACK_CODE;
}

const OPERATOR_MESSAGE_MIN = 5;
const OPERATOR_MESSAGE_MAX = 1000;
const OPERATOR_MESSAGE_BLANK_PLACEHOLDER = '(시트 사유 공란)';

/**
 * transitionVideoReviewDecision 자체는 operatorMessage 길이를 검증하지 않지만(그 검증은 콜러블
 * 계층 videoReviewTransitionCallables.parseVideoReviewOperatorMessage 소관이고 우리는 콜러블을
 * 거치지 않는다), 운영 관례상 5자 미만 문안은 다른 판정 문안과 나란히 뜰 때 잘려 보인다. 원문을
 * 지어내지 않고 인용으로 보존해 5자 이상을 만든다.
 */
export function buildSheetOperatorMessage(reasonRaw: string): string {
  const trimmed = reasonRaw.trim();
  if (!trimmed) return OPERATOR_MESSAGE_BLANK_PLACEHOLDER;
  const bounded = trimmed.length > OPERATOR_MESSAGE_MAX ? trimmed.slice(0, OPERATOR_MESSAGE_MAX) : trimmed;
  if (bounded.length >= OPERATOR_MESSAGE_MIN) return bounded;
  return `시트 원문: "${bounded}"`;
}

// ---- 원장 head (CAS 앵커) -------------------------------------------------------------------------

export type SheetReviewSyncLedgerHead = {
  state: string;
  revision: number;
  contentFingerprint: string;
  canonicalProgramId: string;
  policyConfigHash: string;
  /** W127-critical 재제출 가드: reviewLedger 에 사람이 이미 내린 판정 흔적이 있는지. */
  hasJudgedHistory: boolean;
};

// W127-critical: scpIntegrationEventV2.ts 의 재제출(supersedesPriorRevision) 분기는 state 를
// "queued" 로 리셋하고 revision 을 올리지만 reviewLedger 는 지우지 않는다 — 그래서 사람이 아직
// 보지 않은 새 리비전인데도 시트에 남은 옛 판정이 "queued 니까 적용해도 된다"로 통과해버렸다.
// 필드명은 toState 가 정본(videoReviewTransitionStore.ledgerEntry.toState)이지만, 레거시/외부
// 경로가 다른 이름을 남겼을 가능성을 방어적으로 함께 본다.
const JUDGED_LEDGER_ENTRY_STATES = new Set(["approved", "rejected", "changes_requested"]);

export function reviewLedgerHasJudgedEntry(reviewLedger: unknown): boolean {
  if (!Array.isArray(reviewLedger)) return false;
  return reviewLedger.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    const candidate = record.toState ?? record.state ?? record.decision;
    return typeof candidate === "string" && JUDGED_LEDGER_ENTRY_STATES.has(candidate);
  });
}

export function ledgerHeadFromData(data: Record<string, unknown> | undefined): SheetReviewSyncLedgerHead {
  const record = data ?? {};
  return {
    state: normalizeLegacyReviewState(String(record.state ?? "queued")),
    revision: Number(record.revision ?? 0),
    contentFingerprint: String(record.contentFingerprint ?? ""),
    canonicalProgramId: String(record.canonicalProgramId ?? ""),
    policyConfigHash: String(record.policyConfigHash ?? ""),
    hasJudgedHistory: reviewLedgerHasJudgedEntry(record.reviewLedger),
  };
}

// ---- 결과 원장 (scp_sheet_review_sync_state) — 순수 ------------------------------------------------

export type SheetReviewSyncOutcome =
  | "applied"
  | "skipped_already_decided"
  | "skipped_stale_after_resubmission"
  | "blocked"
  | "failed";

export type SheetReviewSyncOutcomeState = {
  lastAttemptAtIso?: string | null;
  lastOutcome?: SheetReviewSyncOutcome | null;
  blockedReasonCode?: string | null;
  attemptCount?: number | null;
  sheetVerdict?: SheetReviewSyncVerdict | null;
  appliedDecisionRef?: string | null;
};

export function nextSheetReviewSyncOutcome(input: {
  previous: SheetReviewSyncOutcomeState | null;
  outcome: SheetReviewSyncOutcome;
  sheetVerdict: SheetReviewSyncVerdict;
  decisionRef: string | null;
  blockedReasonCode?: string | null;
  nowIso: string;
}): Required<SheetReviewSyncOutcomeState> {
  const rawPrevAttempts = Math.trunc(Number(input.previous?.attemptCount ?? 0));
  const prevAttempts = Number.isFinite(rawPrevAttempts) ? Math.max(0, rawPrevAttempts) : 0;
  return {
    lastAttemptAtIso: input.nowIso,
    lastOutcome: input.outcome,
    blockedReasonCode: input.outcome === "blocked" ? (input.blockedReasonCode ?? "unknown") : null,
    attemptCount: prevAttempts + 1,
    sheetVerdict: input.sheetVerdict,
    appliedDecisionRef: input.outcome === "applied" ? input.decisionRef : null,
  };
}

/** 막힌 건의 유효 백오프 여부. lastAttemptAtIso 파싱 불가/부재는 창 밖(=재시도 허용)으로 본다. */
export function isWithinBlockedBackoff(
  syncState: SheetReviewSyncOutcomeState | null,
  nowMs: number,
  currentVerdict?: SheetReviewSyncVerdict | null,
): boolean {
  if (!syncState || syncState.lastOutcome !== "blocked") return false;
  // 백오프는 "같은 판정을 또 시도해봐야 같은 이유로 막힌다"는 뜻이다. 운영자가 판정을 바꾸면
  // (승인 차단 → 반려로 정정) 그건 다른 시도이므로 막지 않는다 — 반려는 신원 게이트를 타지 않아
  // 곧바로 적용돼야 하는데, 건 단위 백오프는 그 정정을 최대 6시간 묶어둔다.
  if (currentVerdict && syncState.sheetVerdict && syncState.sheetVerdict !== currentVerdict) return false;
  const lastAttemptMs = Date.parse(syncState.lastAttemptAtIso ?? "");
  if (!Number.isFinite(lastAttemptMs)) return false;
  return nowMs - lastAttemptMs < SCP_SHEET_REVIEW_SYNC_BLOCKED_BACKOFF_MS;
}

// ---- 회전 커서 (순수) ------------------------------------------------------------------------------

// 형제 레인(scpIntegrationEventV2Callbacks)이 이미 진단한 결함: limit() 만 두고 항상 앞에서부터
// 자르면, 앞쪽에 이미 처리된 행이 한도보다 많이 쌓인 순간 **뒤쪽 신규 판정은 영원히 스캔조차
// 되지 않는다**. 그런데 로그는 scanned=N, skipped=N 으로 건강해 보인다 — 이 레인이 고치려는
// 증상(판정해도 원장이 조용히 안 움직인다) 그 자체다. 그래서 문서 id 순 회전 커서를 쓴다.
export function selectRotationWindow<T extends { submissionId: string }>(
  rows: readonly T[],
  cursor: string | null,
  scanLimit: number,
): { window: T[]; nextCursor: string | null; wrapped: boolean } {
  const ordered = [...rows].sort((a, b) => (a.submissionId < b.submissionId ? -1 : a.submissionId > b.submissionId ? 1 : 0));
  if (ordered.length === 0) return { window: [], nextCursor: null, wrapped: false };
  const startIndex = cursor ? ordered.findIndex((row) => row.submissionId > cursor) : 0;
  const from = startIndex < 0 ? 0 : startIndex;
  const wrapped = startIndex < 0 || from + scanLimit >= ordered.length;
  const window = ordered.slice(from, from + scanLimit);
  // 한 바퀴를 돌면 커서를 비워 다음 사이클이 처음부터 다시 돈다(이미 결정된 건은 skip 이라 저렴하다).
  const last = window.at(-1);
  const nextCursor = wrapped || !last ? null : last.submissionId;
  return { window, nextCursor, wrapped };
}

// ---- 판정 계획 (순수) ------------------------------------------------------------------------------

export type SheetReviewSyncPlan =
  | { action: "skip"; reason: "no_verdict" | "ledger_missing" | "not_queued" | "stale_after_resubmission" | "blocked_backoff" }
  | {
      action: "apply";
      target: "approved" | "rejected";
      decisionRef: string;
      reasonCode: string | null;
      operatorMessage: string | null;
      evidence: Record<string, unknown>[];
    };

function buildSheetSyncEvidence(target: "approved" | "rejected"): Record<string, unknown>[] {
  // kind/ruleId/verdict/historicalAttribution 은 videoReviewTransitionStore 의 evidence
  // 화이트리스트에 이미 있는 필드다(sanitizeDecisionEvidenceItem) — 이 판정이 흘러가는
  // Portal 콜백 아웃박스(scp_video_review_callback_outbox)에 원문 텍스트를 새로 열지 않기 위해
  // 반려 사유 원문은 여기 담지 않는다(운영자 편집 문안은 ledger 내부 전용 필드인 operatorMessage
  // 로만 보존한다 — 그 필드는 콜백 아웃박스로 나가지 않고, 메일 아웃박스는 notifyCreator 가 항상
  // 거짓이라 애초에 만들어지지 않는다. SEC-P0-009).
  return [
    {
      kind: "legacy_sheet_human_decision",
      ruleId: "content_review_tab",
      verdict: target,
      historicalAttribution: true,
    },
  ];
}

export function sheetSyncDecisionRef(submissionId: string, expectedRevision: number, target: "approved" | "rejected"): string {
  return `sheet_sync:${submissionId}:rev${expectedRevision}:${target}`;
}

export function planSheetReviewSyncRow(input: {
  row: SheetReviewSyncRow;
  ledger: SheetReviewSyncLedgerHead | null;
  syncState: SheetReviewSyncOutcomeState | null;
  nowMs: number;
}): SheetReviewSyncPlan {
  const { row, ledger, syncState, nowMs } = input;
  if (!row.verdict) return { action: "skip", reason: "no_verdict" };
  if (!ledger) return { action: "skip", reason: "ledger_missing" };
  if (ledger.state !== "queued") return { action: "skip", reason: "not_queued" };
  // W127-critical: "queued" 는 첫 심사만이 아니라 재제출(state 리셋·revision 증가, reviewLedger 는
  // 보존됨)도 만든다. 이미 판정 이력이 있거나 리비전이 1 이 아닌 채로 queued 인 문서는 "사람이
  // 아직 보지 않은 새 리비전" — 시트에 남은 옛 판정을 자동으로 재적용하면 안 된다. 재제출 건은
  // flu 검수 탭에서 새로 판정하는 것이 정본이다.
  if (ledger.hasJudgedHistory || ledger.revision !== 1) {
    return { action: "skip", reason: "stale_after_resubmission" };
  }
  if (isWithinBlockedBackoff(syncState, nowMs, row.verdict)) return { action: "skip", reason: "blocked_backoff" };

  const target: "approved" | "rejected" = row.verdict === "approval" ? "approved" : "rejected";
  const decisionRef = sheetSyncDecisionRef(row.submissionId, ledger.revision, target);
  const evidence = buildSheetSyncEvidence(target);

  if (target === "approved") {
    return { action: "apply", target, decisionRef, reasonCode: null, operatorMessage: null, evidence };
  }
  return {
    action: "apply",
    target,
    decisionRef,
    reasonCode: mapSheetReasonToReasonCode(row.reasonRaw),
    operatorMessage: buildSheetOperatorMessage(row.reasonRaw),
    evidence,
  };
}

/**
 * `transitionVideoReviewDecision` 에 넘길 커맨드를 조립한다. notifyCreator 는 항상 리터럴 false —
 * plan 이나 호출부의 어떤 값으로도 뒤집을 수 없다(계약 테스트 대상, 소스 grep 으로도 고정한다).
 */
export function buildSheetSyncTransitionInput(input: {
  submissionId: string;
  plan: Extract<SheetReviewSyncPlan, { action: "apply" }>;
  ledger: SheetReviewSyncLedgerHead;
}): TransitionCommandInput {
  return {
    submissionId: input.submissionId,
    targetStatus: input.plan.target,
    reasonCode: input.plan.reasonCode,
    customerMessageCode: null,
    operatorMessage: input.plan.operatorMessage,
    expectedRevision: input.ledger.revision,
    expectedContentFingerprint: input.ledger.contentFingerprint,
    expectedCanonicalProgramId: input.ledger.canonicalProgramId,
    expectedPolicyConfigHash: input.ledger.policyConfigHash,
    decisionRef: input.plan.decisionRef,
    actorType: "human",
    actorId: SCP_SHEET_REVIEW_SYNC_ACTOR_ID,
    notifyCreator: false,
    evidence: input.plan.evidence,
  };
}

// ---- I/O: 시트 읽기 --------------------------------------------------------------------------------

function failedPrecondition(message: string): Error {
  return Object.assign(new Error(message), { code: "failed-precondition", errorCode: "scp_sheet_review_sync_failed_precondition" });
}

// scpSheetReviewService.ts:572(metadataAccessToken) 과 같은 방식 — Functions 런타임 SA 의 메타데이터
// 서버 토큰을 그대로 쓴다. 새 자격증명을 들이지 않는다(이 파일 전용 사본; 이 레포의 기존 관례대로
// 파일별 소사본을 둔다 — 예: sheetIntakeService.resolveSheetTitleByGid 헤더 주석 참고).
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

export async function readSheetReviewSyncRows(input: {
  spreadsheetId?: string;
  tabName?: string;
  /** 테스트/도구 주입용 — 주어지면 네트워크를 타지 않는다. */
  rows?: unknown[][];
} = {}): Promise<SheetReviewSyncRow[]> {
  if (input.rows) {
    return input.rows.map(parseSheetReviewSyncRow).filter((row): row is SheetReviewSyncRow => row !== null);
  }
  const spreadsheetId = input.spreadsheetId ?? SCP_CONTENT_APPROVAL_REVIEW_SPREADSHEET_ID;
  const tabName = input.tabName ?? SCP_CONTENT_APPROVAL_REVIEW_TAB_NAME;
  const accessToken =
    process.env.GOOGLE_SHEETS_ACCESS_TOKEN || process.env.SHEETS_ACCESS_TOKEN || (await metadataAccessToken());
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY || process.env.SHEETS_API_KEY || "";
  if (!accessToken && !apiKey) {
    throw failedPrecondition("Google Sheets credentials are not configured for the content-review sync lane.");
  }
  const range = `${tabName}!A2:AN${SHEET_READ_MAX_ROWS + 1}`;
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
  );
  url.searchParams.set("majorDimension", "ROWS");
  if (apiKey && !accessToken) url.searchParams.set("key", apiKey);
  const response = await fetch(url, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined });
  if (!response.ok) {
    throw failedPrecondition(`Google Sheets content-review sync read failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { values?: unknown[][] };
  const values = Array.isArray(body.values) ? body.values : [];
  return values.map(parseSheetReviewSyncRow).filter((row): row is SheetReviewSyncRow => row !== null);
}

// ---- I/O: 사이클 오케스트레이션 --------------------------------------------------------------------

async function getAllChunked(
  db: FirebaseFirestore.Firestore,
  refs: FirebaseFirestore.DocumentReference[],
): Promise<FirebaseFirestore.DocumentSnapshot[]> {
  const out: FirebaseFirestore.DocumentSnapshot[] = [];
  for (let index = 0; index < refs.length; index += 100) {
    const chunk = refs.slice(index, index + 100);
    if (chunk.length === 0) continue;
    out.push(...(await db.getAll(...chunk)));
  }
  return out;
}

export type ScpSheetReviewSyncCycleResult = {
  enabled: boolean;
  scanLimit: number;
  scanned: number;
  applied: number;
  skipped: number;
  blocked: number;
  failed: number;
  blockedByReason: Record<string, number>;
  corpus: number;
  cursorWrapped: boolean;
  nextCursor: string | null;
};

// 커서는 밸브 문서에 쓴다(형제 레인과 같은 자리). 실패해도 사이클을 죽이지 않는다 — 다음 사이클이
// 같은 창을 다시 보는 것은 멱등이라 안전하고, 커서 쓰기 실패로 판정 적용이 막히면 그게 더 나쁘다.
async function safeSet(ref: FirebaseFirestore.DocumentReference, data: Record<string, unknown>): Promise<void> {
  try {
    await ref.set(data, { merge: true });
  } catch (error) {
    console.warn("[sheet-review-sync] sync_state_write_failed", JSON.stringify({
      code: (error as { code?: unknown })?.code ?? "unknown_error",
    }));
  }
}

async function persistRotationCursor(db: FirebaseFirestore.Firestore, nextCursor: string | null): Promise<void> {
  const [collection, docId] = SCP_SHEET_REVIEW_SYNC_SETTINGS_DOC.split("/");
  try {
    await db.collection(collection).doc(docId).set(
      { cursor: nextCursor, lastRunAtIso: new Date().toISOString() },
      { merge: true },
    );
  } catch (error) {
    console.warn("[sheet-review-sync] cursor_persist_failed", JSON.stringify({
      code: (error as { code?: unknown })?.code ?? "unknown_error",
    }));
  }
}

function emptyCycleResult(gate: SheetReviewSyncGate): ScpSheetReviewSyncCycleResult {
  return {
    enabled: gate.enabled,
    scanLimit: gate.scanLimit,
    scanned: 0,
    applied: 0,
    skipped: 0,
    corpus: 0,
    cursorWrapped: false,
    nextCursor: null,
    blocked: 0,
    failed: 0,
    blockedByReason: {},
  };
}

export async function runScpSheetReviewSync(
  opts: {
    now?: Date;
    db?: FirebaseFirestore.Firestore;
    gate?: SheetReviewSyncGate;
    /** 테스트/도구 주입용 원시 시트 행(값 배열). 생략하면 실제 Sheets API 를 읽는다. */
    rows?: unknown[][];
  } = {},
): Promise<ScpSheetReviewSyncCycleResult> {
  const db = opts.db ?? adminDb;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const gate = opts.gate ?? (await readScpSheetReviewSyncGate(db));
  if (!gate.enabled) return emptyCycleResult(gate);

  const allRows = await readSheetReviewSyncRows({ rows: opts.rows });
  const judged = allRows.filter((row) => row.verdict !== null);
  const rotation = selectRotationWindow(judged, gate.cursor, gate.scanLimit);
  const candidates = rotation.window;

  const result = emptyCycleResult(gate);
  result.corpus = judged.length;
  result.cursorWrapped = rotation.wrapped;
  result.nextCursor = rotation.nextCursor;
  if (candidates.length === 0) {
    await persistRotationCursor(db, rotation.nextCursor);
    return result;
  }
  result.scanned = candidates.length;

  const stateRefs = candidates.map((row) => db.collection(SCP_VIDEO_REVIEW_STATE_COLLECTION).doc(reviewDocId(row.submissionId)));
  const syncRefs = candidates.map((row) => db.collection(SCP_SHEET_REVIEW_SYNC_STATE_COLLECTION).doc(reviewDocId(row.submissionId)));
  const [stateSnaps, syncSnaps] = await Promise.all([getAllChunked(db, stateRefs), getAllChunked(db, syncRefs)]);

  for (let index = 0; index < candidates.length; index += 1) {
    const row = candidates[index];
    if (!row.verdict) continue; // narrows for TS; already filtered above
    const stateSnap = stateSnaps[index];
    const ledger = stateSnap.exists ? ledgerHeadFromData(stateSnap.data() as Record<string, unknown>) : null;
    const syncSnap = syncSnaps[index];
    const syncState = syncSnap.exists ? (syncSnap.data() as SheetReviewSyncOutcomeState) : null;

    const plan = planSheetReviewSyncRow({ row, ledger, syncState, nowMs: now.getTime() });

    if (plan.action === "skip") {
      result.skipped += 1;
      // W127-critical: 재제출 스테일 스킵은 백오프 대상이 아니고, 운영자가 볼 수 있어야 하므로
      // (전에 시도한 적이 있든 없든) 매 사이클 기록한다 — 아래의 조건부 정리 스킵과는 분리한다.
      if (plan.reason === "stale_after_resubmission") {
        await syncRefs[index].set(
          nextSheetReviewSyncOutcome({
            previous: syncState,
            outcome: "skipped_stale_after_resubmission",
            sheetVerdict: row.verdict,
            decisionRef: null,
            nowIso,
          }),
          { merge: true },
        );
        continue;
      }
      // 재시도할 게 없는 pending/backoff 스킵에는 쓰지 않는다(비용) — 우리가 전에 시도했던 건만
      // (syncSnap.exists) "이제는 이미 결정됐다"로 갱신해 stale blocked 상태를 정리한다.
      if ((plan.reason === "not_queued" || plan.reason === "ledger_missing") && syncSnap.exists) {
        await syncRefs[index].set(
          nextSheetReviewSyncOutcome({
            previous: syncState,
            outcome: "skipped_already_decided",
            sheetVerdict: row.verdict,
            decisionRef: null,
            nowIso,
          }),
          { merge: true },
        );
      }
      continue;
    }

    try {
      await transitionVideoReviewDecision(
        buildSheetSyncTransitionInput({ submissionId: row.submissionId, plan, ledger: ledger! }),
        now,
        { firestore: db },
      );
      result.applied += 1;
      // 원장 전이는 이미 커밋됐다. 여기서 던지면 같은 catch 로 떨어져 applied 와 failed 가 동시에
      // 세어지고(로그가 거짓말한다) 사이클의 남은 후보가 통째로 날아간다 — 분리해서 삼킨다.
      await safeSet(syncRefs[index], nextSheetReviewSyncOutcome({
        previous: syncState,
        outcome: "applied",
        sheetVerdict: row.verdict,
        decisionRef: plan.decisionRef,
        nowIso,
      }));
    } catch (error) {
      if (error instanceof PartnerActivationError) {
        result.blocked += 1;
        result.blockedByReason[error.code] = (result.blockedByReason[error.code] ?? 0) + 1;
        await safeSet(syncRefs[index], nextSheetReviewSyncOutcome({
          previous: syncState,
          outcome: "blocked",
          sheetVerdict: row.verdict,
          decisionRef: null,
          blockedReasonCode: error.code,
          nowIso,
        }));
        continue;
      }
      result.failed += 1;
      await safeSet(syncRefs[index], nextSheetReviewSyncOutcome({
        previous: syncState,
        outcome: "failed",
        sheetVerdict: row.verdict,
        decisionRef: null,
        nowIso,
      }));
    }
  }

  await persistRotationCursor(db, rotation.nextCursor);

  return result;
}
