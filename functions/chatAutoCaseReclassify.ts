// 케이스북 미분류 대기 대화 재분류 — super_admin 전용 백필 (casebook-reclassify, 2026-10-01).
//
// 문제: 대기(미답장) 대화 중 다수가 신선한 케이스 스탬프(autoCaseId + autoCaseMessageRef===lastMessageRef)
// 없이 남아 케이스북이 귀속시키지 못한다. 이 콜러블은 **분류만** 복구한다 — 초안 생성/발송/재큐/
// autoReplyStatus 변경/permit 접촉은 전혀 하지 않는다. 쓰는 것은 두 가지뿐이다:
//   ① 대화 문서의 스탬프 필드(autoCaseId/autoCaseClassifiedAtIso/autoCaseMessageRef/autoCaseStampSource)
//      또는 "분류 불가" 마커(autoCaseReclassify*), ② 감사 문서(chat_auto_case_reclassify_runs/{runId}).
//
// 분류는 chat-ai.ts classifyChatAutoCaseViaGateway(runGatewayLive 와 같은 프롬프트·스키마·모델 라우트·
// 캐시 계약, 초안/JEV/게이트 없음)로 한다. 캐시 선행 + reportLlmUsage 비용 로그. 호출 수는 limit(≤25)로
// 하드 캡, 시간 예산이 넘으면 즉시 멈추고 커서를 돌려준다.
//
// CAS: 분류한 메시지(lastMessageRef)와 쓰는 시점의 대화 lastMessageRef 가 다르면(raced) 쓰지 않는다 —
// 옛 분류를 새 메시지에 붙이지 않는다. 모델이 유효 케이스를 못 냈으면(폴백/미지/영수증 미검증)
// 어떤 케이스도 강제로 붙이지 않고 `unclassifiable` 로만 기록한다.
import { createHash, randomUUID } from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import {
  conversationRegistrationGateFilter,
  decodePageCursor,
  scanUnrepliedInboxForScope,
  type UnrepliedInboxScopeScanPolicy,
} from "./read";
import type { ConversationMailAccessScope } from "./conversationMailAccessScope";
import { CANONICAL_SCP_MAIL_ACCOUNT_ID, isMailSourceBoundToConversation } from "./mailConversationAuthorization";
import type { ChatAutoPermitCaseId } from "./chatAutoCasePermit";
import {
  classifyPendingRow,
  toCompactRow,
  type ChatAutoCasebookUnclassifiedReason,
} from "./chatAutoCasebookPendingPrecompute";
import { CHAT_CASEBOOK_CONTENT_HASH, CHAT_CASEBOOK_VERSION } from "./chatCasebook";
import {
  autoCaseClassificationStampFields,
  chatAutoCaseClassifyGatewayReady,
  classifyChatAutoCaseViaGateway,
  type ChatAutoCaseClassification,
  type ChatAutoCaseClassifyInput,
  type ChatAutoCaseUnclassifiableReason,
} from "./chat-ai";
import { actorUidHash } from "./autoReplyBacklog";
import type { ChatClassificationStamp } from "./chatClassificationAxes";
import { classifyInboundRoute, normalizeInboundRoutingFlags, routingFlagsToHeaders } from "./mailInboundRoute";
import { readSettings } from "./settings";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  makeBehaviorLog,
  makeDeniedBehaviorLog,
  type CallableRequestShape,
} from "./shared";

export const CHAT_AUTO_CASE_RECLASSIFY_RUNS_COLLECTION = "chat_auto_case_reclassify_runs";
export const CHAT_AUTO_CASE_RECLASSIFY_DEFAULT_LIMIT = 10;
export const CHAT_AUTO_CASE_RECLASSIFY_MAX_LIMIT = 25;
/** 스캔 페이지당 행 수 — 페이지마다 수동답장 검증 읽기가 따라붙으므로 작게 둔다. */
export const CHAT_AUTO_CASE_RECLASSIFY_SCAN_PAGE_LIMIT = 50;
/** 호출 1회가 훑는 최대 페이지 — 넘으면 커서를 돌려주고 멈춘다(무한 스캔·읽기 폭주 방지). */
export const CHAT_AUTO_CASE_RECLASSIFY_MAX_SCAN_PAGES = 8;
/** 콜러블 timeoutSeconds(300) 안쪽의 소프트 예산 — 넘으면 새 대화를 시작하지 않는다. */
export const CHAT_AUTO_CASE_RECLASSIFY_DEADLINE_MS = 240_000;
/** 연속 모델 실패가 이 횟수에 닿으면 게이트웨이 장애로 보고 멈춘다(비용/호출 낭비 방지). */
export const CHAT_AUTO_CASE_RECLASSIFY_MAX_CONSECUTIVE_FAILURES = 3;
export const CHAT_AUTO_CASE_RECLASSIFY_STAMP_SOURCE = "reclassify" as const;
/** 한 대화(메시지 참조 해시 × 케이스북 해시)당 분류 실패 허용 횟수 — 넘으면 classifier_failed 마커로 건너뛴다. */
export const CHAT_AUTO_CASE_RECLASSIFY_MAX_ROW_ATTEMPTS = 3;
export const CHAT_AUTO_CASE_RECLASSIFY_CLASSIFIER_FAILED_REASON = "classifier_failed" as const;

const AUDIT_ACTION = "chat_auto_casebook.reclassify";
const MESSAGE_SOURCE_REF_PATTERN = /^message_sources\/[^/]+$/;

export type ChatAutoCaseUnclassifiedReason = ChatAutoCasebookUnclassifiedReason;

export type ChatAutoCaseReclassifyCounts = {
  scanned: number;
  candidates: number;
  classified: number;
  unclassifiable: number;
  raced: number;
  skippedNoBody: number;
  skippedMarked: number;
  failed: number;
  modelCalls: number;
  cacheHits: number;
};

export type ChatAutoCaseReclassifyResult = {
  ok: true;
  runId: string;
  dryRun: boolean;
  counts: ChatAutoCaseReclassifyCounts;
  /** dryRun=true 면 "스탬프할 케이스", false 면 실제로 스탬프된 케이스. */
  byCase: Record<string, number>;
  byUnclassifiableReason: Record<string, number>;
  nextCursor: string | null;
  exhausted: boolean;
  /**
   * "retryable_failures": 스캔은 끝까지 갔지만 재시도할 분류 실패 행이 남아 있다 — exhausted=false 이고
   * nextCursor 는 가장 이른 실패 행 바로 앞(없으면 null = 처음부터)이다.
   */
  /** "caught_up": sweep 전용(notAfterIso) — 남은 행이 전부 아직 너무 최근이다. exhausted=true 와 같이 커서는 처음(null)으로. */
  stoppedReason: "limit" | "deadline" | "page_cap" | "consecutive_failures" | "retryable_failures" | "exhausted" | "caught_up";
  auditFinalized: boolean;
  behaviorLog: Record<string, unknown>;
};

/** The same routing inputs receiveEmail feeds to classifyInboundRoute, re-read from the stored message source. */
export type ChatAutoCaseInboundRouting = {
  from: string;
  headers: Record<string, unknown>;
  hasOutboundMatch: boolean;
  outboundMatchBasis: string;
};

export type ChatAutoCaseInboundMessage = {
  subject: string;
  body: string;
  hasInboundAttachments?: boolean;
  /** Absent when the source carries no routing evidence (pre-classification_v1 rows) — behaves as before. */
  routing?: ChatAutoCaseInboundRouting;
};

export type ChatAutoCaseStampCommit = {
  conversationId: string;
  expectedLastMessageRef: string;
  caseId: ChatAutoPermitCaseId;
  /** classification_v1 axes from the model (absent for legacy responses → stamp fields cleared). */
  classification?: ChatClassificationStamp;
  nowIso: string;
};

export type ChatAutoCaseMarkerCommit = {
  conversationId: string;
  expectedLastMessageRef: string;
  messageRefHash: string;
  reason: ChatAutoCaseUnclassifiableReason | typeof CHAT_AUTO_CASE_RECLASSIFY_CLASSIFIER_FAILED_REASON;
  nowIso: string;
};

/** 분류기 실패 1회 기록 — 행 단위 시도 카운터를 마커 필드에 남긴다(dryRun 은 쓰지 않는다). */
export type ChatAutoCaseFailureCommit = {
  conversationId: string;
  expectedLastMessageRef: string;
  messageRefHash: string;
  nowIso: string;
};
export type ChatAutoCaseFailureOutcome = {
  /** retry: 시도 횟수만 올렸다(다음 호출이 다시 시도). finalized: 상한 도달 → unclassifiable/classifier_failed 마커.
   *  raced: 그 사이 대화가 바뀌었거나 이미 분류됨 — 아무것도 쓰지 않았고 재시도할 것도 없다. */
  outcome: "retry" | "finalized" | "raced";
  attempts: number;
};

export type ChatAutoCaseReclassifyDeps = {
  now?: () => Date;
  nowMs?: () => number;
  newRunId?: () => string;
  /** 시작 시점 기준 상대 예산(ms). */
  deadlineMs?: number;
  gatewayReady?: () => boolean;
  scan?: typeof scanUnrepliedInboxForScope;
  readInboundMessage?: (messageRef: string, conversationId: string) => Promise<ChatAutoCaseInboundMessage | null>;
  classify?: (input: ChatAutoCaseClassifyInput) => Promise<ChatAutoCaseClassification>;
  commitStamp?: (input: ChatAutoCaseStampCommit) => Promise<"stamped" | "raced">;
  commitMarker?: (input: ChatAutoCaseMarkerCommit) => Promise<"marked" | "raced">;
  commitFailure?: (input: ChatAutoCaseFailureCommit) => Promise<ChatAutoCaseFailureOutcome>;
  writeAudit?: (runId: string, doc: Record<string, unknown>) => Promise<void>;
};

function invalidArgument(message: string, errorCode: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode });
}

function viewAsRequested(data: Record<string, unknown>): boolean {
  return (typeof data.viewAsUserId === "string" && data.viewAsUserId.trim().length > 0)
    || (typeof data.viewAsEmail === "string" && data.viewAsEmail.trim().length > 0);
}

// chatAutoCasebookPendingPrecompute.ts superAdminAccess() 와 같은 스코프 — 그 모듈은 export 하지 않는다.
function superAdminAccess(): ConversationMailAccessScope {
  return {
    viewerOrgId: null,
    authorizedMailAccountIds: [CANONICAL_SCP_MAIL_ACCOUNT_ID],
    isSuperAdmin: true,
    hasScpEntitlement: true,
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 메시지 참조(PII 파생 id 를 포함할 수 있음)는 해시로만 다룬다 — 모델 입력·캐시 키·마커에 원문 금지. */
export function chatAutoCaseMessageRefHash(messageRef: string): string {
  return sha256Hex(`chat-auto-case-reclassify:${messageRef}`).slice(0, 32);
}

/**
 * 미분류 사유 — 스냅샷 카운터·미분류 목록 콜러블과 같은 단일 규칙(classifyPendingRow,
 * chatAutoCasebookPendingPrecompute.ts)을 그대로 쓴다. 우선순위 never_classified > unknown_case >
 * stale_stamp. null 이면 신선한 스탬프(managed/closed — 미분류 아님).
 */
export function chatAutoCaseUnclassifiedReason(row: Record<string, unknown>): ChatAutoCaseUnclassifiedReason | null {
  const bucket = classifyPendingRow(toCompactRow(row));
  return bucket.kind === "unclassified" ? bucket.reason : null;
}

function hasCurrentUnclassifiableMarker(row: Record<string, unknown>, lastMessageRef: string): boolean {
  return row.autoCaseReclassifyOutcome === "unclassifiable"
    && row.autoCaseReclassifyMessageRefHash === chatAutoCaseMessageRefHash(lastMessageRef)
    && row.autoCaseReclassifyCasebookHash === CHAT_CASEBOOK_CONTENT_HASH;
}

// ── Firestore CAS (트랜잭션 본문은 순수하게 분리해 에뮬레이터 없이 직접 잠근다) ─────────────────────────

export type ChatAutoCaseReclassifyTransaction<Ref = unknown> = {
  get: (ref: Ref) => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
  update: (ref: Ref, data: Record<string, unknown>) => unknown;
};

function currentConversationMatches(
  current: Record<string, unknown>,
  expectedLastMessageRef: string,
): boolean {
  return asString(current.lastMessageRef, "") === expectedLastMessageRef && current.lastMessageFrom === "creator";
}

/** 분류한 메시지가 아직 대화의 최신 인바운드일 때만 스탬프한다. 아니면 "raced"(쓰지 않음). */
export async function stampConversationCaseInTransaction<Ref>(
  transaction: ChatAutoCaseReclassifyTransaction<Ref>,
  ref: Ref,
  input: Pick<ChatAutoCaseStampCommit, "expectedLastMessageRef" | "caseId" | "nowIso" | "classification">,
): Promise<"stamped" | "raced"> {
  const snapshot = await transaction.get(ref);
  if (!snapshot.exists) return "raced";
  const current = snapshot.data() ?? {};
  if (!currentConversationMatches(current, input.expectedLastMessageRef)) return "raced";
  // 그 사이 다른 경로가 같은 메시지에 신선한 스탬프를 이미 붙였으면 덮어쓰지 않는다(멱등).
  if (chatAutoCaseUnclassifiedReason(current) === null) return "raced";
  transaction.update(ref, {
    autoCaseId: input.caseId,
    autoCaseClassifiedAtIso: input.nowIso,
    autoCaseMessageRef: input.expectedLastMessageRef,
    autoCaseStampSource: CHAT_AUTO_CASE_RECLASSIFY_STAMP_SOURCE,
    ...autoCaseClassificationStampFields(input.classification),
  });
  return "stamped";
}

export async function markConversationUnclassifiableInTransaction<Ref>(
  transaction: ChatAutoCaseReclassifyTransaction<Ref>,
  ref: Ref,
  input: Pick<ChatAutoCaseMarkerCommit, "expectedLastMessageRef" | "messageRefHash" | "reason" | "nowIso">,
): Promise<"marked" | "raced"> {
  const snapshot = await transaction.get(ref);
  if (!snapshot.exists) return "raced";
  const current = snapshot.data() ?? {};
  if (!currentConversationMatches(current, input.expectedLastMessageRef)) return "raced";
  if (chatAutoCaseUnclassifiedReason(current) === null) return "raced";
  transaction.update(ref, {
    autoCaseReclassifyOutcome: "unclassifiable",
    autoCaseReclassifyReason: input.reason,
    autoCaseReclassifyMessageRefHash: input.messageRefHash,
    autoCaseReclassifyCasebookHash: CHAT_CASEBOOK_CONTENT_HASH,
    autoCaseReclassifyAtIso: input.nowIso,
  });
  return "marked";
}

/**
 * 분류기 실패를 행 단위로 센다 — 영구 실패 행이 sweep 커서를 영원히 붙잡지 않도록. 카운터는 마커 필드에
 * 남고 (메시지 참조 해시 × 케이스북 해시) 범위로만 유효하다(새 인바운드/케이스북 변경이면 0부터).
 * 상한(CHAT_AUTO_CASE_RECLASSIFY_MAX_ROW_ATTEMPTS) 도달 시 unclassifiable/classifier_failed 마커로 확정한다 —
 * 케이스를 강제로 붙이지 않고, hasCurrentUnclassifiableMarker 가 이후 sweep 에서 건너뛰게 한다.
 */
export async function recordClassificationFailureInTransaction<Ref>(
  transaction: ChatAutoCaseReclassifyTransaction<Ref>,
  ref: Ref,
  input: Pick<ChatAutoCaseFailureCommit, "expectedLastMessageRef" | "messageRefHash" | "nowIso">,
): Promise<ChatAutoCaseFailureOutcome> {
  const snapshot = await transaction.get(ref);
  if (!snapshot.exists) return { outcome: "raced", attempts: 0 };
  const current = snapshot.data() ?? {};
  if (!currentConversationMatches(current, input.expectedLastMessageRef)) return { outcome: "raced", attempts: 0 };
  if (chatAutoCaseUnclassifiedReason(current) === null) return { outcome: "raced", attempts: 0 };
  const sameScope = current.autoCaseReclassifyMessageRefHash === input.messageRefHash
    && current.autoCaseReclassifyCasebookHash === CHAT_CASEBOOK_CONTENT_HASH;
  const stored = current.autoCaseReclassifyFailedAttempts;
  const prior = sameScope && typeof stored === "number" && Number.isInteger(stored) && stored > 0 ? stored : 0;
  const attempts = prior + 1;
  const finalized = attempts >= CHAT_AUTO_CASE_RECLASSIFY_MAX_ROW_ATTEMPTS;
  transaction.update(ref, {
    autoCaseReclassifyOutcome: finalized ? "unclassifiable" : "failed_retryable",
    autoCaseReclassifyReason: CHAT_AUTO_CASE_RECLASSIFY_CLASSIFIER_FAILED_REASON,
    autoCaseReclassifyFailedAttempts: attempts,
    autoCaseReclassifyMessageRefHash: input.messageRefHash,
    autoCaseReclassifyCasebookHash: CHAT_CASEBOOK_CONTENT_HASH,
    autoCaseReclassifyAtIso: input.nowIso,
  });
  return { outcome: finalized ? "finalized" : "retry", attempts };
}

async function defaultCommitFailure(input: ChatAutoCaseFailureCommit): Promise<ChatAutoCaseFailureOutcome> {
  const ref = adminDb.collection("conversations").doc(input.conversationId);
  return adminDb.runTransaction((transaction) => recordClassificationFailureInTransaction(
    transaction as unknown as ChatAutoCaseReclassifyTransaction,
    ref,
    input,
  ));
}

async function defaultCommitStamp(input: ChatAutoCaseStampCommit): Promise<"stamped" | "raced"> {
  const ref = adminDb.collection("conversations").doc(input.conversationId);
  return adminDb.runTransaction((transaction) => stampConversationCaseInTransaction(
    transaction as unknown as ChatAutoCaseReclassifyTransaction,
    ref,
    input,
  ));
}

async function defaultCommitMarker(input: ChatAutoCaseMarkerCommit): Promise<"marked" | "raced"> {
  const ref = adminDb.collection("conversations").doc(input.conversationId);
  return adminDb.runTransaction((transaction) => markConversationUnclassifiableInTransaction(
    transaction as unknown as ChatAutoCaseReclassifyTransaction,
    ref,
    input,
  ));
}

async function defaultReadInboundMessage(
  messageRef: string,
  conversationId: string,
): Promise<ChatAutoCaseInboundMessage | null> {
  // 호출자가 이미 message_sources/<id> 형태만 넘기도록 걸러 임의 경로 읽기를 막는다.
  const snapshot = await adminDb.doc(messageRef).get();
  if (!snapshot.exists) return null;
  const source = snapshot.data() ?? {};
  if (source.direction !== "inbound") return null;
  // 소스가 이미 권한 확인된 바로 그 대화에 묶여 있어야 한다(없거나 다르면 읽지 않은 것으로 취급).
  if (!isMailSourceBoundToConversation(source, conversationId)) return null;
  const matchedOutboundRef = asString(source.matchedOutboundRef, "");
  const routingFlags = normalizeInboundRoutingFlags(source.inboundRoutingHeaders);
  return {
    subject: asString(source.subject, ""),
    body: asString(source.body, ""),
    ...(typeof source.hasInboundAttachments === "boolean" ? { hasInboundAttachments: source.hasInboundAttachments } : {}),
    // Same inputs receiveEmail used (creatorEmail = the routed From address; stored flags; outbound match + basis).
    // Sources written before classification_v1 carry no flags and no basis → route is creator_reply as before.
    routing: {
      // The address the ingest route verdict used (wrapper address on moonio/heepsy relays); rows written before
      // classification_v1 only have creatorEmail.
      from: asString(source.inboundRouteFrom, "") || asString(source.creatorEmail, ""),
      headers: routingFlagsToHeaders(routingFlags),
      hasOutboundMatch: matchedOutboundRef.length > 0,
      outboundMatchBasis: asString(source.matchedOutboundMatchBasis, ""),
    },
  };
}

async function defaultWriteAudit(runId: string, doc: Record<string, unknown>): Promise<void> {
  await adminDb.collection(CHAT_AUTO_CASE_RECLASSIFY_RUNS_COLLECTION).doc(runId).set(doc, { merge: true });
}

// scan.ts 의 encodePageCursor 와 같은 코덱(decodePageCursor 가 읽는 모양) — 그쪽은 export 하지 않는다.
function encodeScanCursor(cursor: { docId: string; orderValue: string }): string {
  return Buffer.from(JSON.stringify({ docId: cursor.docId, orderValue: cursor.orderValue }), "utf8").toString("base64url");
}

function readRequest(data: Record<string, unknown>): {
  dryRun: boolean;
  limit: number;
  cursor: { docId: string; orderValue: string } | null;
} {
  if (data.dryRun !== undefined && typeof data.dryRun !== "boolean") {
    throw invalidArgument("dryRun must be a boolean", "chat_auto_casebook_reclassify_dry_run_invalid");
  }
  const dryRun = data.dryRun !== false;
  const rawLimit = typeof data.limit === "number" ? data.limit : Number(data.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1
    ? Math.min(Math.floor(rawLimit), CHAT_AUTO_CASE_RECLASSIFY_MAX_LIMIT)
    : CHAT_AUTO_CASE_RECLASSIFY_DEFAULT_LIMIT;
  let cursor: { docId: string; orderValue: string } | null = null;
  if (data.cursor !== undefined && data.cursor !== null && data.cursor !== "") {
    const decoded = typeof data.cursor === "string" ? decodePageCursor(data.cursor) : null;
    if (!decoded) throw invalidArgument("cursor is not a valid reclassify cursor", "chat_auto_casebook_reclassify_cursor_invalid");
    cursor = { docId: decoded.docId, orderValue: asString(decoded.orderValue, "") };
  }
  return { dryRun, limit, cursor };
}

function emptyCounts(): ChatAutoCaseReclassifyCounts {
  return {
    scanned: 0,
    candidates: 0,
    classified: 0,
    unclassifiable: 0,
    raced: 0,
    skippedNoBody: 0,
    skippedMarked: 0,
    failed: 0,
    modelCalls: 0,
    cacheHits: 0,
  };
}

export async function reclassifyChatAutoCasebookUnclassified(
  request: CallableRequestShape,
  deps: ChatAutoCaseReclassifyDeps = {},
): Promise<ChatAutoCaseReclassifyResult> {
  const auth = assertNonGuestAuth(request, AUDIT_ACTION, ["super_admin"]);
  const data = asRecord(request.data);
  // viewAs 전면 차단 — 이 백필은 프로그램 전체 데이터에 쓰는 운영자 도구라 "대신 보기" 미리보기가 성립하지
  // 않는다(조용히 무시하면 운영자가 남의 화면을 보는 줄 알고 실제 데이터에 쓰게 된다).
  if (viewAsRequested(data)) {
    throw Object.assign(new Error("permission-denied: this console does not support viewAs preview"), {
      code: "permission-denied",
      errorCode: "chat_auto_casebook_reclassify_view_as_unsupported",
      behaviorLog: makeDeniedBehaviorLog(request, AUDIT_ACTION, auth.gameId),
    });
  }
  const { dryRun, limit, cursor: requestCursor } = readRequest(data);
  const core = await runChatAutoCaseReclassifyCore(
    {
      dryRun,
      limit,
      cursor: requestCursor,
      auditActor: { action: AUDIT_ACTION, actorUidHash: actorUidHash(auth.userId), actorRole: auth.role },
    },
    deps,
  );
  const { skippedTooRecent: _skippedTooRecent, ...result } = core;
  return { ...result, behaviorLog: { ...makeBehaviorLog(auth, AUDIT_ACTION, "success") } };
}

/** 재분류 코어 입력 — 콜러블(사람 super_admin)과 스케줄 sweep(시스템 행위자)이 공유한다. */
export type ChatAutoCaseReclassifyCoreInput = {
  dryRun: boolean;
  limit: number;
  cursor: { docId: string; orderValue: string } | null;
  /** 감사 시작 문서에 그대로 펼친다 — 콜러블은 {action, actorUidHash, actorRole}, sweep 은 {action, actor:"system:schedule", actorRole:"system"}. */
  auditActor: Record<string, unknown>;
  /**
   * sweep 전용: lastInboundAtIso 가 이 시각보다 늦은 행은 아직 인바운드 파이프라인이 처리 중일 수 있어 건드리지 않는다.
   * 스캔은 lastInboundAtIso 오름차순이라 첫 "너무 최근" 행에서 패스를 끝낸다(caught_up = 지금 처리할 것 없음, 커서 처음으로).
   */
  notAfterIso?: string;
};

export type ChatAutoCaseReclassifyCoreResult = Omit<ChatAutoCaseReclassifyResult, "behaviorLog"> & {
  /** notAfterIso 로 건너뛴(시각을 읽을 수 없는) 행 수 — 콜러블 응답에는 싣지 않는다. */
  skippedTooRecent: number;
};

export async function runChatAutoCaseReclassifyCore(
  input: ChatAutoCaseReclassifyCoreInput,
  deps: ChatAutoCaseReclassifyDeps = {},
): Promise<ChatAutoCaseReclassifyCoreResult> {
  const { dryRun, limit, cursor: requestCursor, auditActor, notAfterIso } = input;
  const notAfterMs = notAfterIso === undefined ? null : Date.parse(notAfterIso);

  const now = deps.now ?? (() => new Date());
  const nowMs = deps.nowMs ?? (() => Date.now());
  const startedMs = nowMs();
  const deadlineAtMs = startedMs + (deps.deadlineMs ?? CHAT_AUTO_CASE_RECLASSIFY_DEADLINE_MS);
  const startedAtIso = now().toISOString();
  const runId = (deps.newRunId ?? (() => `rcl_${randomUUID()}`))();
  const scan = deps.scan ?? scanUnrepliedInboxForScope;
  const readInboundMessage = deps.readInboundMessage ?? defaultReadInboundMessage;
  const classify = deps.classify ?? classifyChatAutoCaseViaGateway;
  const commitStamp = deps.commitStamp ?? defaultCommitStamp;
  const commitMarker = deps.commitMarker ?? defaultCommitMarker;
  const commitFailure = deps.commitFailure ?? defaultCommitFailure;
  const writeAudit = deps.writeAudit ?? defaultWriteAudit;

  // 감사 문서를 먼저 남긴다 — 실패하면 어떤 쓰기도 하기 전에 중단(감사 없는 변경 금지).
  await writeAudit(runId, {
    runId,
    status: "started",
    ...auditActor,
    startedAtIso,
    dryRun,
    limit,
    resumedFromCursor: Boolean(requestCursor),
    ...(notAfterIso !== undefined ? { notAfterIso } : {}),
    casebook: { version: CHAT_CASEBOOK_VERSION, contentHash: CHAT_CASEBOOK_CONTENT_HASH },
  });

  const counts = emptyCounts();
  const byCase: Record<string, number> = {};
  const byUnclassifiableReason: Record<string, number> = {};
  const cost = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  let resumeCursor = requestCursor;
  let exhausted = false;
  let stoppedReason: ChatAutoCaseReclassifyResult["stoppedReason"] = "exhausted";
  let attempts = 0;
  let skippedTooRecent = 0;
  let consecutiveFailures = 0;
  let scanPolicy: UnrepliedInboxScopeScanPolicy | undefined;
  let failure: unknown = null;
  // 가장 이른 "재시도할" 분류 실패 행 바로 앞의 위치 — 반환 커서는 절대 이보다 앞으로 가지 않는다(성공한 뒤쪽 행이
  // 있어도). 뒤쪽 행은 이미 스탬프/마커가 있어 재개 시 모델 호출 없이 건너뛴다. cursor=null 은 "처음부터".
  let retryFrom: { cursor: { docId: string; orderValue: string } | null } | null = null;

  try {
    if (!(deps.gatewayReady ?? chatAutoCaseClassifyGatewayReady)()) {
      throw Object.assign(new Error("failed-precondition: gateway classification is unavailable"), {
        code: "failed-precondition",
        errorCode: "chat_auto_casebook_reclassify_gateway_unavailable",
      });
    }
    const registrationGate = conversationRegistrationGateFilter("super_admin", false);
    let pages = 0;
    scanLoop:
    while (true) {
      const page = await scan({
        access: superAdminAccess(),
        mailAccountId: CANONICAL_SCP_MAIL_ACCOUNT_ID,
        limit: CHAT_AUTO_CASE_RECLASSIFY_SCAN_PAGE_LIMIT,
        cursor: resumeCursor,
        ...(scanPolicy ? { policy: scanPolicy } : {}),
        policyFailureMode: "fail_closed",
        registrationGate,
        shouldContinue: () => nowMs() < deadlineAtMs,
      });
      scanPolicy = page.policy;
      for (const row of page.rows) {
        if (nowMs() >= deadlineAtMs) {
          stoppedReason = "deadline";
          break scanLoop;
        }
        const conversationId = asString(row.id, "");
        const lastMessageRef = asString(row.lastMessageRef, "");
        const rowCursor = { docId: conversationId, orderValue: asString(row.lastInboundAtIso, "") };
        if (notAfterMs !== null) {
          const inboundMs = Date.parse(asString(row.lastInboundAtIso, ""));
          if (!Number.isFinite(inboundMs)) {
            // 시각을 읽을 수 없는 행은 나이를 증명할 수 없다 — 건드리지 않고 지나간다.
            counts.scanned += 1;
            skippedTooRecent += 1;
            resumeCursor = rowCursor;
            continue;
          }
          if (!Number.isFinite(notAfterMs) || inboundMs > notAfterMs) {
            // 오름차순 스캔: 이 행부터 끝까지 전부 너무 최근이다. 이 행은 세지 않고 패스를 끝낸다.
            exhausted = true;
            resumeCursor = null;
            stoppedReason = "caught_up";
            break scanLoop;
          }
        }
        if (!conversationId || chatAutoCaseUnclassifiedReason(row) === null) {
          counts.scanned += 1;
          resumeCursor = rowCursor;
          continue;
        }
        if (hasCurrentUnclassifiableMarker(row, lastMessageRef)) {
          counts.scanned += 1;
          counts.skippedMarked += 1;
          resumeCursor = rowCursor;
          continue;
        }
        if (attempts >= limit) {
          // 이 행은 아직 건드리지 않았다 — resumeCursor 는 직전 행에 남아 다음 호출이 여기서 시작한다.
          stoppedReason = "limit";
          break scanLoop;
        }
        counts.scanned += 1;
        counts.candidates += 1;
        const message = MESSAGE_SOURCE_REF_PATTERN.test(lastMessageRef)
          ? await readInboundMessage(lastMessageRef, conversationId)
          : null;
        if (!message || (!message.subject && !message.body)) {
          counts.skippedNoBody += 1;
          resumeCursor = rowCursor;
          continue;
        }
        const messageRefHash = chatAutoCaseMessageRefHash(lastMessageRef);
        // Same routing verdict receiveEmail uses (classifyInboundRoute): a notification/bulk/vendor route is not
        // a creator message — no model call, no case. Marked unclassifiable (classification only: this sweep never
        // changes thread/queue state; the no-reply disposition itself is applied at ingest or by the operator).
        if (message.routing) {
          const route = classifyInboundRoute({
            from: message.routing.from,
            subject: message.subject,
            body: message.body,
            headers: message.routing.headers,
            hasOutboundMatch: message.routing.hasOutboundMatch,
            outboundMatchBasis: message.routing.outboundMatchBasis,
          });
          if (!route.allowChat) {
            counts.unclassifiable += 1;
            byUnclassifiableReason.notification_route = (byUnclassifiableReason.notification_route ?? 0) + 1;
            if (!dryRun) {
              await commitMarker({
                conversationId,
                expectedLastMessageRef: lastMessageRef,
                messageRefHash,
                reason: "notification_route",
                nowIso: now().toISOString(),
              });
            }
            resumeCursor = rowCursor;
            continue;
          }
        }
        attempts += 1;
        let classification: ChatAutoCaseClassification;
        try {
          classification = await classify({
            conversationId,
            messageRefHash,
            subject: message.subject,
            body: message.body,
            ...(asString(row.creatorId, "") ? { creatorId: asString(row.creatorId, "") } : {}),
            creatorFollowers: finiteNumber(row.creatorFollowers),
            creatorRecentViews: finiteNumber(row.creatorRecentViews),
            creatorEngagementPct: finiteNumber(row.creatorEngagementPct),
            ...(typeof message.hasInboundAttachments === "boolean" ? { hasInboundAttachments: message.hasInboundAttachments } : {}),
          });
        } catch (error) {
          console.error("[reclassifyChatAutoCasebookUnclassified] classification failed", {
            errorCode: asString(asRecord(error).errorCode, "classify_failed"),
          });
          classification = { status: "gateway_unavailable" };
        }
        if (classification.status === "gateway_unavailable") {
          counts.failed += 1;
          consecutiveFailures += 1;
          // 실제 실행은 실패 횟수를 행 마커에 남긴다. 상한에 닿으면 classifier_failed 로 확정해 sweep 이
          // 이 행을 지나가게 한다(케이스 강제 부여 없음). dryRun 은 아무것도 쓰지 않으므로 실패 행은 늘 재시도 대상이다.
          let settled = false;
          if (!dryRun) {
            const recorded = await commitFailure({
              conversationId,
              expectedLastMessageRef: lastMessageRef,
              messageRefHash,
              nowIso: now().toISOString(),
            });
            if (recorded.outcome === "finalized") {
              settled = true;
              counts.unclassifiable += 1;
              byUnclassifiableReason[CHAT_AUTO_CASE_RECLASSIFY_CLASSIFIER_FAILED_REASON] = (byUnclassifiableReason[CHAT_AUTO_CASE_RECLASSIFY_CLASSIFIER_FAILED_REASON] ?? 0) + 1;
            } else if (recorded.outcome === "raced") {
              settled = true;
              counts.raced += 1;
            }
          }
          // 재시도할 행이면 반환 커서는 이 행 앞(지금의 resumeCursor)에 고정된다 — 첫 실패만 기록한다.
          if (!settled && retryFrom === null) retryFrom = { cursor: resumeCursor };
          resumeCursor = rowCursor;
          if (consecutiveFailures >= CHAT_AUTO_CASE_RECLASSIFY_MAX_CONSECUTIVE_FAILURES) {
            stoppedReason = "consecutive_failures";
            break scanLoop;
          }
          continue;
        }
        consecutiveFailures = 0;
        if (classification.cacheHit) counts.cacheHits += 1;
        else counts.modelCalls += 1;
        cost.inputTokens += classification.usage.inputTokens;
        cost.outputTokens += classification.usage.outputTokens;
        cost.estimatedCostUsd += classification.usage.estimatedCostUsd;

        if (classification.status === "classified") {
          if (dryRun) {
            counts.classified += 1;
            byCase[classification.caseId] = (byCase[classification.caseId] ?? 0) + 1;
          } else {
            const outcome = await commitStamp({
              conversationId,
              expectedLastMessageRef: lastMessageRef,
              caseId: classification.caseId,
              ...(classification.classification ? { classification: classification.classification } : {}),
              nowIso: now().toISOString(),
            });
            if (outcome === "stamped") {
              counts.classified += 1;
              byCase[classification.caseId] = (byCase[classification.caseId] ?? 0) + 1;
            } else {
              counts.raced += 1;
            }
          }
        } else {
          counts.unclassifiable += 1;
          byUnclassifiableReason[classification.reason] = (byUnclassifiableReason[classification.reason] ?? 0) + 1;
          if (!dryRun) {
            await commitMarker({
              conversationId,
              expectedLastMessageRef: lastMessageRef,
              messageRefHash,
              reason: classification.reason,
              nowIso: now().toISOString(),
            });
          }
        }
        resumeCursor = rowCursor;
      }
      if (!page.nextCursor) {
        if (nowMs() >= deadlineAtMs) {
          // 마감이 지난 뒤의 빈 스캔 결과는 "끝"이 아니라 "중단"일 수 있다(shouldContinue 로 일찍 멈춘 스캔은
          // 재개 커서 없이 빈 페이지를 돌려줄 수 있다) — 완료로 속이지 않고 커서를 그대로 둔다.
          stoppedReason = "deadline";
          break;
        }
        if (page.truncated) {
          // 더 있다고 하면서 재개 커서가 없으면 완료로 속이지 않는다.
          throw Object.assign(new Error("failed-precondition: scan reported more rows without a resumable cursor"), {
            code: "failed-precondition",
            errorCode: "chat_auto_casebook_reclassify_scan_cursor_missing",
          });
        }
        exhausted = true;
        resumeCursor = null;
        stoppedReason = "exhausted";
        break;
      }
      const decoded = decodePageCursor(page.nextCursor);
      if (!decoded) {
        throw Object.assign(new Error("failed-precondition: scan returned an unreadable cursor"), {
          code: "failed-precondition",
          errorCode: "chat_auto_casebook_reclassify_scan_cursor_missing",
        });
      }
      resumeCursor = { docId: decoded.docId, orderValue: asString(decoded.orderValue, "") };
      pages += 1;
      if (nowMs() >= deadlineAtMs) {
        stoppedReason = "deadline";
        break;
      }
      if (pages >= CHAT_AUTO_CASE_RECLASSIFY_MAX_SCAN_PAGES) {
        stoppedReason = "page_cap";
        break;
      }
    }
  } catch (error) {
    failure = error;
  }

  // 재시도할 실패 행이 남아 있으면 끝까지 스캔했더라도 "완료"가 아니고, 커서는 가장 이른 실패 행 앞에 머문다.
  if (!failure && retryFrom !== null) {
    exhausted = false;
    if (stoppedReason === "exhausted" || stoppedReason === "caught_up") stoppedReason = "retryable_failures";
  }
  const effectiveCursor = retryFrom !== null ? retryFrom.cursor : resumeCursor;
  const finishedAtIso = now().toISOString();
  const nextCursor = exhausted || !effectiveCursor ? null : encodeScanCursor(effectiveCursor);
  let auditFinalized = true;
  try {
    await writeAudit(runId, {
      status: failure ? "failed" : "completed",
      ...(failure ? { errorCode: asString(asRecord(failure).errorCode, "reclassify_failed") } : {}),
      finishedAtIso,
      durationMs: nowMs() - startedMs,
      counts,
      byCase,
      byUnclassifiableReason,
      cost,
      exhausted,
      stoppedReason: failure ? "failed" : stoppedReason,
      hasNextCursor: nextCursor !== null,
      ...(notAfterIso !== undefined ? { skippedTooRecent } : {}),
    });
  } catch (error) {
    auditFinalized = false;
    console.error("[reclassifyChatAutoCasebookUnclassified] failed to finalize audit", {
      runId,
      errorCode: asString(asRecord(error).errorCode, "audit_finalize_failed"),
    });
  }
  if (failure) throw failure;

  return {
    ok: true,
    runId,
    dryRun,
    counts,
    byCase,
    byUnclassifiableReason,
    nextCursor,
    exhausted,
    stoppedReason,
    auditFinalized,
    skippedTooRecent,
  };
}

// ── 자동 재분류 sweep (casebook 0.6.105, 2026-10-01) ──────────────────────────────────────────────
//
// 30분마다 도는 시스템 스케줄(chatAutoCaseReclassifySweepSchedule). 수신 시 스탬프에 실패해 미분류로 남은 대기
// 대화를 위 코어로 **분류만** 복구한다 — 초안/발송/재큐/autoReplyStatus/permit 은 손대지 않는다. 쓰는 것:
// 스탬프·마커(코어), 감사 문서(코어, actor "system:schedule"), 그리고 커서·리스 상태 문서 한 장.
// 사람 신원을 흉내 내지 않는다(actorUidHash 없음). 킬스위치: settings/default →
// automation.casebookReclassifySweep.enabled (없으면 true, 명시적 false 만 끈다).
export const CHAT_AUTO_CASE_RECLASSIFY_SWEEP_STATE_PATH = "chat_auto_case_reclassify_sweep/state";
export const CHAT_AUTO_CASE_RECLASSIFY_SWEEP_AUDIT_ACTION = "chat_auto_casebook.reclassify_sweep";
export const CHAT_AUTO_CASE_RECLASSIFY_SWEEP_ACTOR = "system:schedule";
export const CHAT_AUTO_CASE_RECLASSIFY_SWEEP_LIMIT = 10;
/** 수신 파이프라인(수신 시 스탬프)이 먼저 끝나도록 마지막 인바운드 후 15분은 건드리지 않는다. */
export const CHAT_AUTO_CASE_RECLASSIFY_SWEEP_MIN_INBOUND_AGE_MS = 15 * 60_000;
// scripts/verify-invariant-gates.mjs 의 락 쌍 규칙(TIME_BUDGET < LOCK_TTL ≤ 스케줄 주기 30분)에 등재된다.
// 리스는 함수 하드 타임아웃(300s)보다 길어야 겹침이 없다 — 죽은 실행의 리스는 TTL 뒤 자연 만료.
const CHAT_AUTO_CASE_RECLASSIFY_SWEEP_WORKER_TIME_BUDGET_MS = 240_000;
const CHAT_AUTO_CASE_RECLASSIFY_SWEEP_WORKER_LOCK_TTL_MS = 360_000;
export const CHAT_AUTO_CASE_RECLASSIFY_SWEEP_TIME_BUDGET_MS = CHAT_AUTO_CASE_RECLASSIFY_SWEEP_WORKER_TIME_BUDGET_MS;
export const CHAT_AUTO_CASE_RECLASSIFY_SWEEP_LEASE_MS = CHAT_AUTO_CASE_RECLASSIFY_SWEEP_WORKER_LOCK_TTL_MS;

export type ChatAutoCaseReclassifySweepState = {
  cursor?: string | null;
  leaseId?: string | null;
  leaseUntilIso?: string | null;
  [key: string]: unknown;
};

/** 상태 문서 한 장 위의 트랜잭션 — 기본 구현은 Firestore, 테스트는 메모리 저장소. */
export type ChatAutoCaseReclassifySweepStateTransaction = {
  get: () => Promise<ChatAutoCaseReclassifySweepState | null>;
  set: (data: ChatAutoCaseReclassifySweepState) => void;
};

export type ChatAutoCaseReclassifySweepDeps = ChatAutoCaseReclassifyDeps & {
  readEnabled?: () => Promise<boolean>;
  runStateTransaction?: <T>(fn: (transaction: ChatAutoCaseReclassifySweepStateTransaction) => Promise<T>) => Promise<T>;
  newLeaseId?: () => string;
};

export type ChatAutoCaseReclassifySweepResult =
  | { status: "disabled" }
  | { status: "leased" }
  | { status: "completed"; runId: string; counts: ChatAutoCaseReclassifyCounts; stoppedReason: ChatAutoCaseReclassifyResult["stoppedReason"]; exhausted: boolean; cursorReset: boolean; skippedTooRecent: number }
  | { status: "failed"; errorCode: string };

/** 킬스위치 해석 — 명시적 false 만 끈다(필드가 없거나 다른 타입이면 켜짐). */
export function chatAutoCaseReclassifySweepEnabledFromSettings(automation: unknown): boolean {
  const sweep = asRecord(asRecord(automation).casebookReclassifySweep);
  return sweep.enabled !== false;
}

async function defaultReadSweepEnabled(): Promise<boolean> {
  // 기존 설정 리더 — mergeSettingValue 가 스키마에 없는 하위 필드를 보존하므로 여기서 그대로 읽힌다.
  const settings = await readSettings();
  return chatAutoCaseReclassifySweepEnabledFromSettings(settings.automation);
}

async function defaultRunStateTransaction<T>(
  fn: (transaction: ChatAutoCaseReclassifySweepStateTransaction) => Promise<T>,
): Promise<T> {
  const ref = adminDb.doc(CHAT_AUTO_CASE_RECLASSIFY_SWEEP_STATE_PATH);
  return adminDb.runTransaction(async (transaction) => fn({
    get: async () => {
      const snapshot = await transaction.get(ref);
      return snapshot.exists ? (snapshot.data() ?? {}) as ChatAutoCaseReclassifySweepState : null;
    },
    set: (data) => { transaction.set(ref, data, { merge: true }); },
  }));
}

function decodeSweepCursor(value: unknown): { docId: string; orderValue: string } | null {
  const decoded = typeof value === "string" && value ? decodePageCursor(value) : null;
  return decoded ? { docId: decoded.docId, orderValue: asString(decoded.orderValue, "") } : null;
}

export async function runChatAutoCaseReclassifySweep(
  deps: ChatAutoCaseReclassifySweepDeps = {},
): Promise<ChatAutoCaseReclassifySweepResult> {
  const readEnabled = deps.readEnabled ?? defaultReadSweepEnabled;
  // 킬스위치 OFF → 리스·커서·감사 어느 것도 쓰지 않는 완전한 no-op.
  if (!(await readEnabled())) return { status: "disabled" };

  const now = deps.now ?? (() => new Date());
  const runStateTransaction = deps.runStateTransaction ?? defaultRunStateTransaction;
  const leaseId = (deps.newLeaseId ?? (() => randomUUID()))();

  // single-flight: 살아 있는 리스가 있으면 이번 틱은 아무것도 하지 않는다.
  const claimed = await runStateTransaction(async (transaction) => {
    const current = await transaction.get();
    const nowDate = now();
    const heldUntil = Date.parse(asString(current?.leaseUntilIso, ""));
    if (current?.leaseId && Number.isFinite(heldUntil) && heldUntil > nowDate.getTime()) return null;
    transaction.set({
      leaseId,
      leaseUntilIso: new Date(nowDate.getTime() + CHAT_AUTO_CASE_RECLASSIFY_SWEEP_LEASE_MS).toISOString(),
      leaseAcquiredAtIso: nowDate.toISOString(),
    });
    return { cursor: decodeSweepCursor(current?.cursor) };
  });
  if (!claimed) return { status: "leased" };

  let outcome: ChatAutoCaseReclassifySweepResult;
  let nextCursor: string | null | undefined;
  let lastRun: Record<string, unknown>;
  try {
    const startedMs = now().getTime();
    const core = await runChatAutoCaseReclassifyCore(
      {
        dryRun: false,
        limit: CHAT_AUTO_CASE_RECLASSIFY_SWEEP_LIMIT,
        cursor: claimed.cursor,
        auditActor: {
          action: CHAT_AUTO_CASE_RECLASSIFY_SWEEP_AUDIT_ACTION,
          actor: CHAT_AUTO_CASE_RECLASSIFY_SWEEP_ACTOR,
          actorRole: "system",
        },
        notAfterIso: new Date(startedMs - CHAT_AUTO_CASE_RECLASSIFY_SWEEP_MIN_INBOUND_AGE_MS).toISOString(),
      },
      { deadlineMs: CHAT_AUTO_CASE_RECLASSIFY_SWEEP_TIME_BUDGET_MS, ...deps },
    );
    // 끝까지 갔거나 따라잡았으면 커서는 처음(null)부터 — 다음 틱이 새로 생긴 미분류를 다시 훑는다.
    nextCursor = core.exhausted ? null : core.nextCursor;
    outcome = {
      status: "completed",
      runId: core.runId,
      counts: core.counts,
      stoppedReason: core.stoppedReason,
      exhausted: core.exhausted,
      cursorReset: nextCursor === null,
      skippedTooRecent: core.skippedTooRecent,
    };
    lastRun = { runId: core.runId, status: "completed", stoppedReason: core.stoppedReason, classified: core.counts.classified };
  } catch (error) {
    // 실패하면 커서는 그대로 둔다(같은 자리에서 다음 틱이 재시도). 코어가 이미 감사 문서를 failed 로 마감했다.
    const errorCode = asString(asRecord(error).errorCode, "reclassify_sweep_failed");
    outcome = { status: "failed", errorCode };
    nextCursor = undefined;
    lastRun = { status: "failed", errorCode };
  }

  // 리스 반납 + 커서 저장 — 아직 내 리스일 때만(만료 후 다른 실행이 잡았으면 그 실행의 상태를 덮지 않는다).
  await runStateTransaction(async (transaction) => {
    const current = await transaction.get();
    if (current?.leaseId !== leaseId) return;
    transaction.set({
      ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
      leaseId: null,
      leaseUntilIso: null,
      lastRun: { ...lastRun, finishedAtIso: now().toISOString() },
    });
  });
  return outcome;
}
