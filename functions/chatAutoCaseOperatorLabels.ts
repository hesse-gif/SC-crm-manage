// 운영자 정정 라벨 적용 — super_admin 전용 공식 경로 (classification_v1, 2026-10-03).
//
// 운영자가 검토하며 바로잡은 분류(케이스·행위자·의도·처리 방침)를 **공식 경로**로 시스템에 반영한다.
// 이 콜러블은 분류 라벨만 쓴다 — 메일을 보내거나 발송 큐에 넣거나 permit/억제/사람 게이트를 건드리지
// 않는다. 쓰는 것은 세 가지뿐이다:
//   ① 대화 문서의 분류 스탬프(운영자 라벨: labelSource "operator", 행위자 uid 해시, 시각, 계약 버전) +
//      reclassify 요청 시 autoCaseId, no_reply 요청 시 명시적 무발송 처분(autoReplyStatus dismissed_no_reply),
//   ② 메시지 소스의 classification 레코드, ③ chat_auto_case_gold_labels/{해시(messageRef)} (향후 평가용 골드셋).
// 실행당 감사 문서(chat_auto_case_operator_label_runs/{runId}) 하나 — PII 없음(건수·결과 코드만).
//
// 안전 계약:
//   - dryRun 기본(true). 입력은 엄격 검증(최대 100건, 열린 코드값만 — 자유 텍스트 필드 없음).
//   - 적용은 항목마다 트랜잭션으로 **현재 최신 인바운드 messageRef 와 일치**를 재검증한다(stale → skip).
//   - 케이스북이 종결로 취급하는(auto_close) 케이스를 keep/reclassify 로 붙이지 않는다 — 스레드를 닫지 않은 채
//     "닫힌 묶음"에 숨기는 일을 막는다. 무발송은 disposition=no_reply 로만(대기 큐에서 빠지고 예약 잡도 취소).
//   - viewAs 전면 차단, Guest 거부, super_admin 만. 메일 발송·enqueue 경로를 import 하지 않는다.
import { createHash, randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { actorUidHash } from "./autoReplyBacklog";
import { CHAT_CASEBOOK, CHAT_CASEBOOK_CONTENT_HASH, CHAT_CASEBOOK_VERSION, CHAT_CLASSIFICATION_CONTRACT_VERSION } from "./chatCasebook";
import {
  CHAT_INTENT_LABELS_MAX,
  isChatActorType,
  isChatIntentLabel,
  violatesFixedTermsInvariant,
  type ChatActorType,
  type ChatIntentLabel,
} from "./chatClassificationAxes";
import { isMailSourceBoundToConversation } from "./mailConversationAuthorization";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  makeBehaviorLog,
  makeDeniedBehaviorLog,
  type CallableRequestShape,
} from "./shared";

export const CHAT_AUTO_CASE_OPERATOR_LABEL_RUNS_COLLECTION = "chat_auto_case_operator_label_runs";
export const CHAT_AUTO_CASE_GOLD_LABELS_COLLECTION = "chat_auto_case_gold_labels";
export const CHAT_AUTO_CASE_OPERATOR_LABEL_MAX_ITEMS = 100;
export const CHAT_AUTO_CASE_OPERATOR_STAMP_SOURCE = "operator" as const;

const AUDIT_ACTION = "chat_auto_casebook.apply_operator_labels";
const MESSAGE_SOURCE_REF_PATTERN = /^message_sources\/[^/]+$/;
const REASON_CODE_PATTERN = /^[a-z0-9_]{1,48}$/;
const CONVERSATION_ID_PATTERN = /^[^/]{1,200}$/;
const NO_REPLY_DISMISS_REASON = "operator_no_reply" as const;

export const CHAT_AUTO_CASE_OPERATOR_DISPOSITIONS = ["keep", "reclassify", "no_reply"] as const;
export type ChatAutoCaseOperatorDisposition = (typeof CHAT_AUTO_CASE_OPERATOR_DISPOSITIONS)[number];

export type ChatAutoCaseOperatorLabelItem = {
  conversationId: string;
  messageRef: string;
  caseId: string;
  actorType: ChatActorType;
  intentLabels: ChatIntentLabel[];
  disposition: ChatAutoCaseOperatorDisposition;
  reasonCode: string;
};

export type ChatAutoCaseOperatorLabelOutcome =
  | "applied"
  /** Applied, but the message's automatic reply had ALREADY reached the SMTP point (in flight or handed over): the label
   *  could not stop it. Audited, never presented as having stopped a send — mail already handed to SMTP cannot be recalled. */
  | "applied_after_send"
  | "would_apply"
  | "stale"
  | "not_found"
  | "source_mismatch"
  | "auto_close_case_requires_no_reply"
  | "keep_requires_current_case";

export type ChatAutoCaseOperatorLabelCounts = {
  requested: number;
  applied: number;
  /** subset of applied: label landed after the reply's SMTP point (residual — see applied_after_send). */
  appliedAfterSend: number;
  wouldApply: number;
  stale: number;
  notFound: number;
  sourceMismatch: number;
  rejected: number;
};

export type ChatAutoCaseOperatorLabelResult = {
  ok: true;
  runId: string;
  dryRun: boolean;
  contractVersion: string;
  counts: ChatAutoCaseOperatorLabelCounts;
  byDisposition: Record<string, number>;
  items: Array<{ index: number; outcome: ChatAutoCaseOperatorLabelOutcome }>;
  auditFinalized: boolean;
  behaviorLog: Record<string, unknown>;
};

export type ChatAutoCaseOperatorLabelTransaction<Ref = unknown> = {
  get: (ref: Ref) => Promise<{
    exists: boolean;
    data: () => Record<string, unknown> | undefined;
    /** present when `ref` is a query: its matching documents */
    docs?: Array<{ id: string; ref: Ref; data: () => Record<string, unknown> | undefined }>;
  }>;
  set: (ref: Ref, data: Record<string, unknown>, options?: { merge?: boolean }) => unknown;
  update: (ref: Ref, data: Record<string, unknown>) => unknown;
};

export type ChatAutoCaseOperatorLabelDeps = {
  now?: () => Date;
  newRunId?: () => string;
  /** One item's validate-and-write (default: Firestore transaction). Tests inject a fake. */
  applyItem?: (item: ChatAutoCaseOperatorLabelItem, ctx: ChatAutoCaseOperatorLabelContext) => Promise<ChatAutoCaseOperatorLabelOutcome>;
  /** no_reply only: block already-scheduled auto-reply jobs for the conversation (never sends or enqueues). */
  cancelPendingAutoReplies?: (conversationId: string, messageRef: string, nowIso: string) => Promise<number>;
  writeAudit?: (runId: string, doc: Record<string, unknown>) => Promise<void>;
};

export type ChatAutoCaseOperatorLabelContext = {
  dryRun: boolean;
  runId: string;
  nowIso: string;
  actorHash: string;
};

function invalidArgument(message: string, errorCode: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode });
}

function viewAsRequested(data: Record<string, unknown>): boolean {
  return (typeof data.viewAsUserId === "string" && data.viewAsUserId.trim().length > 0)
    || (typeof data.viewAsEmail === "string" && data.viewAsEmail.trim().length > 0);
}

const CASEBOOK_CASE_BY_ID = new Map(CHAT_CASEBOOK.map((item) => [item.id as string, item] as const));

/** Strict parse. Any malformed item rejects the whole request — nothing is applied from a partly-invalid batch. */
export function parseChatAutoCaseOperatorLabelItems(value: unknown): ChatAutoCaseOperatorLabelItem[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidArgument("items must be a non-empty array", "chat_auto_case_operator_labels_items_invalid");
  }
  if (value.length > CHAT_AUTO_CASE_OPERATOR_LABEL_MAX_ITEMS) {
    throw invalidArgument(`items must be at most ${CHAT_AUTO_CASE_OPERATOR_LABEL_MAX_ITEMS}`, "chat_auto_case_operator_labels_too_many_items");
  }
  const seenConversations = new Set<string>();
  return value.map((raw, index) => {
    const entry = asRecord(raw);
    const bad = (field: string): Error =>
      invalidArgument(`items[${index}].${field} is invalid`, `chat_auto_case_operator_labels_${field}_invalid`);
    const conversationId = asString(entry.conversationId, "");
    if (!CONVERSATION_ID_PATTERN.test(conversationId)) throw bad("conversationId");
    if (seenConversations.has(conversationId)) {
      throw invalidArgument(`items[${index}] repeats a conversationId`, "chat_auto_case_operator_labels_conversation_duplicate");
    }
    seenConversations.add(conversationId);
    const messageRef = asString(entry.messageRef, "");
    if (!MESSAGE_SOURCE_REF_PATTERN.test(messageRef)) throw bad("messageRef");
    const caseId = asString(entry.caseId, "");
    if (!CASEBOOK_CASE_BY_ID.has(caseId)) throw bad("caseId");
    if (!isChatActorType(entry.actorType)) throw bad("actorType");
    if (!Array.isArray(entry.intentLabels) || entry.intentLabels.length > CHAT_INTENT_LABELS_MAX) throw bad("intentLabels");
    const intentLabels: ChatIntentLabel[] = [];
    for (const label of entry.intentLabels) {
      if (!isChatIntentLabel(label)) throw bad("intentLabels");
      if (!intentLabels.includes(label)) intentLabels.push(label);
    }
    // The same invariant the model path enforces: fixed_terms_inquiry only with custom_terms_proposal. An operator
    // truth that contradicts it would poison the gold set — the whole request is rejected, nothing is written.
    if (violatesFixedTermsInvariant(caseId, intentLabels)) throw bad("caseId");
    const disposition = entry.disposition;
    if (typeof disposition !== "string" || !(CHAT_AUTO_CASE_OPERATOR_DISPOSITIONS as readonly string[]).includes(disposition)) {
      throw bad("disposition");
    }
    const reasonCode = asString(entry.reasonCode, "");
    if (!REASON_CODE_PATTERN.test(reasonCode)) throw bad("reasonCode");
    return {
      conversationId,
      messageRef,
      caseId,
      actorType: entry.actorType,
      intentLabels,
      disposition: disposition as ChatAutoCaseOperatorDisposition,
      reasonCode,
    };
  });
}

/** Gold-label doc id: hash of the message ref (the ref itself can carry sender-derived tokens). */
export function chatAutoCaseGoldLabelId(messageRef: string): string {
  return createHash("sha256").update(`chat-auto-case-gold:${messageRef}`).digest("hex").slice(0, 32);
}

/** Same derivation as chat-ai.ts safeMessageSourceId(`auto-reply-send-${jobId}`) — the send-intent doc id of a job. */
function autoReplySendIntentKey(jobId: string): string {
  const normalized = `auto-reply-send-${jobId}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 140);
  return normalized || "message";
}

function isAutoCloseCase(caseId: string): boolean {
  return CASEBOOK_CASE_BY_ID.get(caseId)?.escalation === "auto_close";
}

/**
 * One item's re-validation + write, pure over a transaction so it is locked without an emulator. Reads both
 * documents first (Firestore rule), validates, then writes. Returns the outcome; nothing is written unless
 * every check passes and `ctx.dryRun` is false.
 */
export async function applyOperatorLabelInTransaction<Ref>(
  transaction: ChatAutoCaseOperatorLabelTransaction<Ref>,
  refs: {
    conversation: Ref;
    source: Ref;
    gold: Ref;
    /** How to find the message's queued auto-reply jobs INSIDE this transaction (so a retry sees jobs created after the
     *  label started): the query by source message ref, plus resolvers for a job doc by path and its send-intent /
     *  dispatch-claim docs. Optional (older callers/tests). */
    jobs?: {
      query: Ref;
      jobByPath: (path: string) => Ref;
      intent: (intentKey: string) => Ref;
      claim: (caseId: string) => Ref;
      intentKey: (jobId: string) => string;
    };
  },
  item: ChatAutoCaseOperatorLabelItem,
  ctx: ChatAutoCaseOperatorLabelContext,
): Promise<ChatAutoCaseOperatorLabelOutcome> {
  const conversationSnapshot = await transaction.get(refs.conversation);
  const sourceSnapshot = await transaction.get(refs.source);
  const goldSnapshot = await transaction.get(refs.gold);
  // Was this message's automatic reply already past the SMTP point when the label landed? (read in this transaction)
  let afterSend = false;
  if (refs.jobs && conversationSnapshot.exists) {
    // Discovered INSIDE the transaction: (a) every queue job whose sourceRef is this message, (b) the job the conversation
    // currently points at (autoReplyQueueRef) when it is for this message. A job created after the label began is seen on
    // the retry Firestore forces when it commits before our read.
    const found = new Map<string, { id: string; data: Record<string, unknown>; ref: Ref }>();
    const querySnapshot = await transaction.get(refs.jobs.query);
    for (const doc of querySnapshot.docs ?? []) found.set(doc.id, { id: doc.id, data: doc.data() ?? {}, ref: doc.ref });
    const queuePath = asString(conversationSnapshot.data()?.autoReplyQueueRef, "");
    if (/^auto_reply_queue\/[^/]+$/.test(queuePath) && !found.has(queuePath.split("/")[1])) {
      const pointed = await transaction.get(refs.jobs.jobByPath(queuePath));
      const pointedData = pointed.data() ?? {};
      if (pointed.exists && asString(pointedData.sourceRef, "") === item.messageRef) {
        found.set(queuePath.split("/")[1], { id: queuePath.split("/")[1], data: pointedData, ref: pointed as unknown as Ref });
      }
    }
    for (const entry of found.values()) {
      const intentKey = refs.jobs.intentKey(entry.id);
      const [intentSnapshot, claimSnapshot] = await Promise.all([
        transaction.get(refs.jobs.intent(intentKey)),
        transaction.get(refs.jobs.claim(asString(entry.data.caseId, "none"))),
      ]);
      const jobStatus = asString(entry.data.status, "");
      // Irreversible marker written in the SMTP-start transaction itself — survives claim release and a failed delivery.
      if (asString(entry.data.smtpStartedAtIso, "") !== "") afterSend = true;
      const intentStatus = asString(intentSnapshot.data()?.status, "");
      const claimData = claimSnapshot.data() ?? {};
      if (
        ["sent", "sent_evidence_pending", "mock_sent"].includes(jobStatus) ||
        ["sent", "mock_sent", "acceptance_unknown"].includes(intentStatus) ||
        (claimData.phase === "smtp_started" && claimData.sendIntentKey === intentKey)
      ) afterSend = true;
    }
  }
  if (!conversationSnapshot.exists) return "not_found";
  const conversation = conversationSnapshot.data() ?? {};
  // The operator labeled a specific message: it must STILL be the conversation's latest inbound, from the creator.
  if (asString(conversation.lastMessageRef, "") !== item.messageRef || conversation.lastMessageFrom !== "creator") return "stale";
  const source = sourceSnapshot.exists ? (sourceSnapshot.data() ?? {}) : null;
  if (!source || source.direction !== "inbound" || !isMailSourceBoundToConversation(source, item.conversationId)) {
    return "source_mismatch";
  }
  if (item.disposition !== "no_reply" && isAutoCloseCase(item.caseId)) return "auto_close_case_requires_no_reply";
  // keep leaves autoCaseId alone, so the (case, intents) pair that gets stamped/recorded must be the one actually
  // live: keep is only valid when the message's CURRENT stamp is exactly the case the operator labeled. Anything
  // else would pair the operator's intents with a different live case (and break the fixed_terms invariant).
  if (
    item.disposition === "keep"
    && (asString(conversation.autoCaseMessageRef, "") !== item.messageRef || asString(conversation.autoCaseId, "") !== item.caseId)
  ) {
    return "keep_requires_current_case";
  }
  if (ctx.dryRun) return "would_apply";

  const labelFields = {
    autoCaseActorType: item.actorType,
    autoCaseIntentLabels: item.intentLabels,
    autoCaseContractVersion: CHAT_CLASSIFICATION_CONTRACT_VERSION,
    autoCaseLabelSource: CHAT_AUTO_CASE_OPERATOR_STAMP_SOURCE,
    autoCaseLabeledAtIso: ctx.nowIso,
    autoCaseLabeledByHash: ctx.actorHash,
    autoCaseLabelReasonCode: item.reasonCode,
    autoCaseLabelMessageRef: item.messageRef,
  };
  const conversationUpdate: Record<string, unknown> = { ...labelFields };
  if (item.disposition === "reclassify" || item.disposition === "no_reply") {
    // Works for already-cased rows (the unclassified-only reclassify refuses those): the operator's case wins.
    conversationUpdate.autoCaseId = item.caseId;
    conversationUpdate.autoCaseClassifiedAtIso = ctx.nowIso;
    conversationUpdate.autoCaseMessageRef = item.messageRef;
    conversationUpdate.autoCaseStampSource = CHAT_AUTO_CASE_OPERATOR_STAMP_SOURCE;
    conversationUpdate.autoCaseGuardedFromCaseId = FieldValue.delete();
    conversationUpdate.autoCaseReclassifyOutcome = FieldValue.delete();
    conversationUpdate.autoCaseReclassifyReason = FieldValue.delete();
    conversationUpdate.autoCaseReclassifyMessageRefHash = FieldValue.delete();
    conversationUpdate.autoCaseReclassifyCasebookHash = FieldValue.delete();
    conversationUpdate.autoCaseReclassifyFailedAttempts = FieldValue.delete();
    conversationUpdate.autoCaseReclassifyAtIso = FieldValue.delete();
  }
  // A non-creator actor correction hands a still-scheduled reply back to human review (the callable also cancels this
  // message's scheduled job after the transaction). no_reply sets its own status below.
  if (
    item.disposition !== "no_reply" &&
    (item.actorType === "agency_mcn" || item.actorType === "vendor_or_notification") &&
    conversation.autoReplyStatus === "scheduled"
  ) {
    conversationUpdate.autoReplyStatus = "waiting_for_human";
    conversationUpdate.autoReplyBlockedReason = "operator_actor_hold";
    conversationUpdate.nextAutoReplyAtIso = FieldValue.delete();
    conversationUpdate.autoReplyQueueRef = FieldValue.delete();
    conversationUpdate.autoReplyDraftText = FieldValue.delete();
  }
  if (item.disposition === "no_reply") {
    // Explicit no-reply disposition (same shape as the ingest dismiss): leaves the pending queue (statuses
    // waiting_for_human/draft_only only), clears any draft/queue pointers. Reversible: one field. NEVER sends.
    conversationUpdate.autoReplyStatus = "dismissed_no_reply";
    conversationUpdate.dismissedNoReplyReason = NO_REPLY_DISMISS_REASON;
    conversationUpdate.dismissedAtIso = ctx.nowIso;
    conversationUpdate.noReplyDisposition = {
      source: CHAT_AUTO_CASE_OPERATOR_STAMP_SOURCE,
      reasonCode: item.reasonCode,
      atIso: ctx.nowIso,
      actorHash: ctx.actorHash,
      contractVersion: CHAT_CLASSIFICATION_CONTRACT_VERSION,
    };
    conversationUpdate.nextAutoReplyAtIso = FieldValue.delete();
    conversationUpdate.autoReplyDraftText = FieldValue.delete();
    conversationUpdate.autoReplyQueueRef = FieldValue.delete();
    conversationUpdate.humanDraftSuggestion = FieldValue.delete();
    conversationUpdate.humanDraftSuggestionKr = FieldValue.delete();
  }
  transaction.update(refs.conversation, conversationUpdate);
  transaction.set(refs.source, {
    // The send path enforces a no-reply disposition from THIS message source (independent of the mutable
    // conversation status): set for no_reply, cleared when the operator later labels the message otherwise.
    // An operator actor correction to a non-creator (agency_mcn / vendor_or_notification) is enforced from this source at
    // claim AND send exactly like no_reply: such a sender must never receive an automatic reply.
    operatorActorHold: item.actorType === "agency_mcn" || item.actorType === "vendor_or_notification"
      ? {
          source: CHAT_AUTO_CASE_OPERATOR_STAMP_SOURCE,
          actorType: item.actorType,
          atIso: ctx.nowIso,
          actorHash: ctx.actorHash,
          contractVersion: CHAT_CLASSIFICATION_CONTRACT_VERSION,
        }
      : FieldValue.delete(),
    operatorNoReplyDisposition: item.disposition === "no_reply"
      ? {
          source: CHAT_AUTO_CASE_OPERATOR_STAMP_SOURCE,
          reasonCode: item.reasonCode,
          atIso: ctx.nowIso,
          actorHash: ctx.actorHash,
          contractVersion: CHAT_CLASSIFICATION_CONTRACT_VERSION,
        }
      : FieldValue.delete(),
    classification: {
      actorType: item.actorType,
      intentLabels: item.intentLabels,
      contractVersion: CHAT_CLASSIFICATION_CONTRACT_VERSION,
      labelSource: CHAT_AUTO_CASE_OPERATOR_STAMP_SOURCE,
      caseId: item.caseId,
      disposition: item.disposition,
      reasonCode: item.reasonCode,
      labeledAtIso: ctx.nowIso,
      labeledByHash: ctx.actorHash,
    },
  }, { merge: true });
  // Gold set row: the operator truth next to what the SYSTEM (model) had stamped, for a future eval. No mail text.
  // The system baseline is captured once: a repeated correction of the same message must not replace the original
  // model stamp with the previous operator label, so an existing baseline is kept and an operator-sourced stamp is
  // never recorded as "system".
  const existingGold = goldSnapshot.exists ? (goldSnapshot.data() ?? {}) : null;
  const hasBaseline = existingGold !== null && "system" in existingGold;
  const hadModelStamp = asString(conversation.autoCaseMessageRef, "") === item.messageRef
    && asString(conversation.autoCaseLabelSource, "model") !== CHAT_AUTO_CASE_OPERATOR_STAMP_SOURCE;
  // Only the hash of the message ref goes into the (PII-free) gold dataset: raw refs derive from sender Message-IDs and
  // keep identifying name/domain tokens. The operational ref stays on the conversation/source docs, outside the dataset.
  transaction.set(refs.gold, {
    messageRefHash: chatAutoCaseGoldLabelId(item.messageRef),
    // A row written before hash-only storage may still carry the raw ref: the merge removes it explicitly.
    messageRef: FieldValue.delete(),
    caseId: item.caseId,
    actorType: item.actorType,
    intentLabels: item.intentLabels,
    disposition: item.disposition,
    reasonCode: item.reasonCode,
    contractVersion: CHAT_CLASSIFICATION_CONTRACT_VERSION,
    casebookVersion: CHAT_CASEBOOK_VERSION,
    casebookHash: CHAT_CASEBOOK_CONTENT_HASH,
    labelSource: CHAT_AUTO_CASE_OPERATOR_STAMP_SOURCE,
    labeledAtIso: ctx.nowIso,
    labeledByHash: ctx.actorHash,
    runId: ctx.runId,
    ...(hasBaseline
      ? {}
      : {
          system: hadModelStamp
            ? {
                caseId: asString(conversation.autoCaseId, "") || null,
                actorType: asString(conversation.autoCaseActorType, "") || null,
                intentLabels: Array.isArray(conversation.autoCaseIntentLabels) ? conversation.autoCaseIntentLabels : null,
                contractVersion: asString(conversation.autoCaseContractVersion, "") || null,
              }
            : null,
        }),
  }, { merge: true });
  // Serialization note: this transaction writes the message source; the SMTP-start transaction READS that same source
  // (markChatAutoCaseReplyDispatchSmtpStarted + sourceGuard), so the label and the send authorization cannot both
  // commit unseen by each other. Residual: if the reply already passed the SMTP point, this label is recorded as
  // applied_after_send (audit) — it cannot recall mail already handed to SMTP.
  if (afterSend) {
    transaction.set(refs.source, { operatorLabelAfterSend: { atIso: ctx.nowIso, actorHash: ctx.actorHash, disposition: item.disposition } }, { merge: true });
    return "applied_after_send";
  }
  return "applied";
}

async function defaultApplyItem(
  item: ChatAutoCaseOperatorLabelItem,
  ctx: ChatAutoCaseOperatorLabelContext,
): Promise<ChatAutoCaseOperatorLabelOutcome> {
  // Jobs are discovered INSIDE the transaction (query + conversation.autoReplyQueueRef), never frozen beforehand.
  const jobs = {
    query: adminDb.collection("auto_reply_queue").where("sourceRef", "==", item.messageRef).limit(5),
    jobByPath: (path: string) => adminDb.doc(path),
    intent: (intentKey: string) => adminDb.collection("auto_reply_send_intents").doc(intentKey),
    claim: (caseId: string) => adminDb.collection("chat_auto_case_reply_dispatch_claims").doc(caseId),
    intentKey: autoReplySendIntentKey,
  };
  const refs = {
    conversation: adminDb.collection("conversations").doc(item.conversationId),
    source: adminDb.doc(item.messageRef),
    gold: adminDb.collection(CHAT_AUTO_CASE_GOLD_LABELS_COLLECTION).doc(chatAutoCaseGoldLabelId(item.messageRef)),
    jobs,
  };
  return adminDb.runTransaction((transaction) => applyOperatorLabelInTransaction(
    transaction as unknown as ChatAutoCaseOperatorLabelTransaction,
    refs,
    item,
    ctx,
  ));
}

async function defaultCancelPendingAutoReplies(conversationId: string, messageRef: string, nowIso: string): Promise<number> {
  // Lazy import: chat-ai.ts is large and this module must stay import-light for the handler's pure paths.
  const { cancelPendingAutoRepliesForConversation } = await import("./chat-ai");
  // Scoped to jobs bound to THIS inbound: a newer message's queued reply must never be cancelled by it.
  return cancelPendingAutoRepliesForConversation({ conversationId }, conversationId, messageRef, NO_REPLY_DISMISS_REASON, nowIso, messageRef);
}

async function defaultWriteAudit(runId: string, doc: Record<string, unknown>): Promise<void> {
  await adminDb.collection(CHAT_AUTO_CASE_OPERATOR_LABEL_RUNS_COLLECTION).doc(runId).set(doc, { merge: true });
}

export async function applyChatAutoCaseOperatorLabels(
  request: CallableRequestShape,
  deps: ChatAutoCaseOperatorLabelDeps = {},
): Promise<ChatAutoCaseOperatorLabelResult> {
  const auth = assertNonGuestAuth(request, AUDIT_ACTION, ["super_admin"]);
  const data = asRecord(request.data);
  if (viewAsRequested(data)) {
    throw Object.assign(new Error("permission-denied: this console does not support viewAs preview"), {
      code: "permission-denied",
      errorCode: "chat_auto_case_operator_labels_view_as_unsupported",
      behaviorLog: makeDeniedBehaviorLog(request, AUDIT_ACTION, auth.gameId),
    });
  }
  if (data.dryRun !== undefined && typeof data.dryRun !== "boolean") {
    throw invalidArgument("dryRun must be a boolean", "chat_auto_case_operator_labels_dry_run_invalid");
  }
  const dryRun = data.dryRun !== false;
  const items = parseChatAutoCaseOperatorLabelItems(data.items);

  const now = deps.now ?? (() => new Date());
  const runId = (deps.newRunId ?? (() => `opl_${randomUUID()}`))();
  const applyItem = deps.applyItem ?? defaultApplyItem;
  const cancelPending = deps.cancelPendingAutoReplies ?? defaultCancelPendingAutoReplies;
  const writeAudit = deps.writeAudit ?? defaultWriteAudit;
  const startedAtIso = now().toISOString();
  const ctx: ChatAutoCaseOperatorLabelContext = { dryRun, runId, nowIso: startedAtIso, actorHash: actorUidHash(auth.userId) };

  // Audit first: a run with no audit record must not change anything.
  await writeAudit(runId, {
    runId,
    status: "started",
    action: AUDIT_ACTION,
    actorUidHash: ctx.actorHash,
    actorRole: auth.role,
    startedAtIso,
    dryRun,
    requested: items.length,
    contractVersion: CHAT_CLASSIFICATION_CONTRACT_VERSION,
    casebook: { version: CHAT_CASEBOOK_VERSION, contentHash: CHAT_CASEBOOK_CONTENT_HASH },
  });

  const counts: ChatAutoCaseOperatorLabelCounts = {
    requested: items.length,
    applied: 0,
    appliedAfterSend: 0,
    wouldApply: 0,
    stale: 0,
    notFound: 0,
    sourceMismatch: 0,
    rejected: 0,
  };
  const byDisposition: Record<string, number> = {};
  const results: ChatAutoCaseOperatorLabelResult["items"] = [];
  let failure: unknown = null;
  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const outcome = await applyItem(item, ctx);
      results.push({ index, outcome });
      if (outcome === "applied" || outcome === "applied_after_send") {
        counts.applied += 1;
        if (outcome === "applied_after_send") counts.appliedAfterSend += 1;
        byDisposition[item.disposition] = (byDisposition[item.disposition] ?? 0) + 1;
        if (item.disposition === "no_reply" || item.actorType === "agency_mcn" || item.actorType === "vendor_or_notification") {
          await cancelPending(item.conversationId, item.messageRef, ctx.nowIso);
        }
      } else if (outcome === "would_apply") {
        counts.wouldApply += 1;
        byDisposition[item.disposition] = (byDisposition[item.disposition] ?? 0) + 1;
      } else if (outcome === "stale") counts.stale += 1;
      else if (outcome === "not_found") counts.notFound += 1;
      else if (outcome === "source_mismatch") counts.sourceMismatch += 1;
      else counts.rejected += 1;
    }
  } catch (error) {
    failure = error;
  }

  let auditFinalized = true;
  try {
    await writeAudit(runId, {
      status: failure ? "failed" : "completed",
      ...(failure ? { errorCode: asString(asRecord(failure).errorCode, "apply_operator_labels_failed") } : {}),
      finishedAtIso: now().toISOString(),
      counts,
      byDisposition,
    });
  } catch {
    auditFinalized = false;
  }
  if (failure) throw failure;
  return {
    ok: true,
    runId,
    dryRun,
    contractVersion: CHAT_CLASSIFICATION_CONTRACT_VERSION,
    counts,
    byDisposition,
    items: results,
    auditFinalized,
    behaviorLog: { ...makeBehaviorLog(auth, AUDIT_ACTION, "success") },
  };
}
