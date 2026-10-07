import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { redactKnowledgeText } from "./feedbackKbGovernanceCore";
import {
  CHAT_AUTO_CASEBOOK_PROPOSAL_OUTBOX_COLLECTION,
  CHAT_AUTO_CASE_DECISION_LEDGER_COLLECTION,
  CHAT_AUTO_CASE_EVAL_RUNS_COLLECTION,
  CHAT_AUTO_CASE_EXECUTION_LEDGER_COLLECTION,
  CHAT_AUTO_CASE_INTENTS_COLLECTION,
  CHAT_AUTO_CASE_PERMIT_COLLECTION,
  CHAT_AUTO_PERMIT_SCHEMA_VERSION,
  CHAT_AUTO_MIN_CONSECUTIVE_UNEDITED_APPROVED_SENDS,
  chatAutoCaseIntentId,
  chatAutoCaseLedgerId,
  emptyChatAutoPermitCounters,
  evalEvidencePasses,
  type ChatAutoCasePermitDecision,
  type ChatAutoCasePermitDisarmReason,
  type ChatAutoCasePermitDoc,
  type ChatAutoCasePermitPin,
  type ChatAutoEvalEvidence,
  type ChatAutoLearningDisposition,
  type ChatAutoPermitCaseId,
} from "./chatAutoCasePermit";
import { CHAT_CASEBOOK_CONTENT_HASH, CHAT_CASEBOOK_VERSION } from "./chatCasebook";
import { chatAutoPermitDisarmLedgerFields, createChatAutoPermitDisarmLedgerEntry, notifyChatAutoPermitDisarmed, queueChatAutoPermitDisarmAlertInTransaction } from "./chatAutoPermitDisarmAudit";
import { CHAT_AUTO_CASE_REPLIES_COLLECTION, CHAT_AUTO_CASE_REPLIES_DOC, chatAutoCaseReplyPinFromStoredConfig, hasActiveChatAutoCaseReplyOverride } from "./chatAutoCaseReplies";

export const CHAT_AUTO_CASE_COMMITTED_SENDS_COLLECTION = "chat_auto_case_committed_sends" as const;

export type ChatAutoCommittedSendEvent = {
  conversationId: string;
  messageRef: string;
  messageSourceRef: string;
  outboundLogRef: string;
  caseId: ChatAutoPermitCaseId | null;
  casebookHash: string | null;
  gatewayModelVersion: string | null;
  caseIntentRef: string | null;
  permitDecisionId: string | null;
  sender: "human" | "ai";
  approval: "approved" | "rejected" | "skipped" | "unknown";
  deliveryState: "sent" | "mock_sent" | "blocked" | "failed" | "skipped_duplicate" | "unknown";
  providerConfirmed: boolean;
  acceptedCount: number;
  rejectedCount: number;
  originalDraftHash: string | null;
  sentBodyHash: string | null;
  sentMatchesServerRenderedDraft: boolean;
  bounced: boolean;
  complained: boolean;
  optedOut: boolean;
  suppressed: boolean;
  learningDisposition: ChatAutoLearningDisposition;
  proposalExampleText?: string | null;
  sentAtIso: string;
};

export type ChatAutoCounterPinOptions = { pin: ChatAutoCasePermitPin };

function actorHash(uid: string, role: string): string {
  return createHash("sha256").update(`${uid}\u0000${role}`).digest("hex").slice(0, 24);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cleanNumber(value: unknown): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

function committedSendEventRecord(input: ChatAutoCommittedSendEvent): Omit<ChatAutoCommittedSendEvent, "proposalExampleText"> {
  const { proposalExampleText: _proposalExampleText, ...event } = input;
  return event;
}

function sanitizedProposalExample(input: ChatAutoCommittedSendEvent): string {
  return redactKnowledgeText(input.proposalExampleText ?? "").slice(0, 1200);
}

function isProposalOutboxEligible(input: ChatAutoCommittedSendEvent): boolean {
  const sanitized = sanitizedProposalExample(input);
  return (
    input.learningDisposition === "proposal_only_counter_reset" &&
    input.sender === "human" &&
    input.approval === "approved" &&
    input.deliveryState === "sent" &&
    input.providerConfirmed &&
    input.acceptedCount > 0 &&
    input.rejectedCount === 0 &&
    input.caseId !== null &&
    input.sentBodyHash !== null &&
    input.originalDraftHash !== null &&
    input.originalDraftHash !== input.sentBodyHash &&
    input.sentMatchesServerRenderedDraft === false &&
    !input.bounced &&
    !input.complained &&
    !input.optedOut &&
    !input.suppressed &&
    sanitized.length > 0
  );
}

function createCommittedSendAndProposalWrites(
  writer: Pick<FirebaseFirestore.WriteBatch | FirebaseFirestore.Transaction, "create">,
  ref: FirebaseFirestore.DocumentReference,
  input: ChatAutoCommittedSendEvent,
): void {
  writer.create(ref, {
    schemaVersion: CHAT_AUTO_PERMIT_SCHEMA_VERSION,
    ...committedSendEventRecord(input),
    createdAtIso: input.sentAtIso,
    createdAt: FieldValue.serverTimestamp(),
    source: "functions.chatAutoCasePermitStore",
  });
  if (isProposalOutboxEligible(input)) {
    const proposalRef = adminDb.collection(CHAT_AUTO_CASEBOOK_PROPOSAL_OUTBOX_COLLECTION).doc(chatAutoCaseProposalOutboxId(input));
    writer.create(proposalRef, {
      schemaVersion: CHAT_AUTO_PERMIT_SCHEMA_VERSION,
      caseId: input.caseId,
      messageRef: input.messageRef,
      messageSourceRef: input.messageSourceRef,
      sentBodyHash: input.sentBodyHash,
      sourceEventRef: ref.path,
      status: "proposal_only",
      sanitizedExampleText: sanitizedProposalExample(input),
      createdAtIso: input.sentAtIso,
      createdAt: FieldValue.serverTimestamp(),
      source: "functions.chatAutoCasePermitStore",
    });
  }
}

export function chatAutoCaseExecutionLedgerId(input: {
  conversationId: string;
  messageSourceId: string;
  caseId: ChatAutoPermitCaseId | null;
  result: "reserved" | "sent" | "skipped" | "duplicate" | "failed";
}): string {
  return chatAutoCaseLedgerId({
    conversationId: input.conversationId,
    messageSourceId: `${input.messageSourceId}:${input.result}`,
    caseId: input.caseId,
    kind: "execution",
  });
}

export function chatAutoDecisionLedgerRecordsMatch(
  existing: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  // [적대 리뷰 MED-1] createdAtIso 는 비교 대상에서 뺀다 — 같은 결정의 정당한 재시도는
  //   생성 시각만 다를 뿐 나머지 필드가 동일하므로 no-op(멱등)이어야 한다. 넣어 두면
  //   재시도마다 "충돌하는 replay" 로 오판해 already-exists 를 던진다.
  const comparableKeys = [
    "schemaVersion",
    "decisionId",
    "conversationId",
    "messageSourceId",
    "caseId",
    "allowed",
    "denyReasons",
    "pin",
    "caseCandidates",
    "clampReasonIds",
    "gatewayCostLog",
    "source",
  ];
  const comparable = (record: Record<string, unknown>) => Object.fromEntries(
    comparableKeys.map((key) => [key, record[key] ?? null]),
  );
  return stableJson(comparable(existing)) === stableJson(comparable(next));
}

export function applyChatAutoCommittedSendEventToCounters(
  current: ChatAutoCasePermitDoc["counters"] | null,
  event: ChatAutoCommittedSendEvent,
  options: ChatAutoCounterPinOptions,
): ChatAutoCasePermitDoc["counters"] {
  const counters = current ? { ...current } : emptyChatAutoPermitCounters();
  const next = summarizeChatAutoPermitCounters([event], options);
  if (next.unavailableEvidenceCount > 0) {
    return {
      ...counters,
      consecutiveHumanUneditedApprovedSent: 0,
      unavailableEvidenceCount: counters.unavailableEvidenceCount + next.unavailableEvidenceCount,
      lastResetAtIso: next.lastResetAtIso,
      lastResetReason: next.lastResetReason,
    };
  }
  if (next.totalHumanUneditedApprovedSent > 0) {
    return {
      ...counters,
      consecutiveHumanUneditedApprovedSent: counters.consecutiveHumanUneditedApprovedSent + next.consecutiveHumanUneditedApprovedSent,
      totalHumanUneditedApprovedSent: counters.totalHumanUneditedApprovedSent + next.totalHumanUneditedApprovedSent,
      lastEligibleMessageRef: next.lastEligibleMessageRef,
    };
  }
  if (next.lastResetReason) {
    return {
      ...counters,
      consecutiveHumanUneditedApprovedSent: 0,
      lastResetAtIso: next.lastResetAtIso,
      lastResetReason: next.lastResetReason,
    };
  }
  return counters;
}

function permitFromSnapshot(snapshot: FirebaseFirestore.DocumentSnapshot): ChatAutoCasePermitDoc | null {
  if (!snapshot.exists) return null;
  const data = snapshot.data() ?? {};
  if (data.caseId !== snapshot.id) return null;
  return data as ChatAutoCasePermitDoc;
}

export async function readChatAutoCasePermit(caseId: ChatAutoPermitCaseId): Promise<ChatAutoCasePermitDoc | null> {
  return permitFromSnapshot(await adminDb.collection(CHAT_AUTO_CASE_PERMIT_COLLECTION).doc(caseId).get());
}

export async function readChatAutoCasePermitMap(
  caseIds?: readonly ChatAutoPermitCaseId[],
): Promise<Map<ChatAutoPermitCaseId, ChatAutoCasePermitDoc>> {
  const ids = caseIds?.length ? [...new Set(caseIds)] : [];
  const snapshots = ids.length
    ? await adminDb.getAll(...ids.map((id) => adminDb.collection(CHAT_AUTO_CASE_PERMIT_COLLECTION).doc(id)))
    : await adminDb.collection(CHAT_AUTO_CASE_PERMIT_COLLECTION).limit(100).get().then((query) => query.docs);
  const result = new Map<ChatAutoPermitCaseId, ChatAutoCasePermitDoc>();
  for (const snapshot of snapshots) {
    const permit = permitFromSnapshot(snapshot);
    if (permit) result.set(permit.caseId, permit);
  }
  return result;
}

export function summarizeChatAutoPermitCounters(
  events: readonly ChatAutoCommittedSendEvent[],
  options: ChatAutoCounterPinOptions,
): ChatAutoCasePermitDoc["counters"] {
  const counters = emptyChatAutoPermitCounters();
  for (const event of [...events].sort((a, b) => a.sentAtIso.localeCompare(b.sentAtIso))) {
    const staleReason =
      event.casebookHash && event.casebookHash !== options.pin.casebookHash
        ? "casebook_hash_changed"
        : event.gatewayModelVersion && event.gatewayModelVersion !== options.pin.modelVersion
          ? "model_version_changed"
          : null;
    if (staleReason) {
      counters.consecutiveHumanUneditedApprovedSent = 0;
      counters.lastResetAtIso = event.sentAtIso;
      counters.lastResetReason = staleReason;
      continue;
    }
    const hasPermitEvidence =
      Boolean(event.caseId) &&
      Boolean(event.casebookHash) &&
      Boolean(event.gatewayModelVersion) &&
      Boolean(event.permitDecisionId) &&
      Boolean(event.originalDraftHash) &&
      Boolean(event.sentBodyHash);
    if (!hasPermitEvidence) {
      counters.consecutiveHumanUneditedApprovedSent = 0;
      counters.unavailableEvidenceCount += 1;
      counters.lastResetAtIso = event.sentAtIso;
      counters.lastResetReason = "case_unresolved_adverse_event";
      continue;
    }
    const adverse = event.bounced || event.complained || event.optedOut || event.suppressed;
    if (adverse) {
      counters.consecutiveHumanUneditedApprovedSent = 0;
      counters.lastResetAtIso = event.sentAtIso;
      counters.lastResetReason = event.complained
        ? "complaint"
        : event.optedOut
          ? "opt_out"
          : event.suppressed
            ? "suppression"
            : "bounce_or_suppression";
      continue;
    }
    const eligible =
      event.learningDisposition === "arming_credit" &&
      event.sender === "human" &&
      event.approval === "approved" &&
      event.deliveryState === "sent" &&
      event.providerConfirmed &&
      event.acceptedCount > 0 &&
      event.rejectedCount === 0 &&
      event.sentMatchesServerRenderedDraft &&
      event.originalDraftHash === event.sentBodyHash;
    if (eligible) {
      counters.consecutiveHumanUneditedApprovedSent += 1;
      counters.totalHumanUneditedApprovedSent += 1;
      counters.lastEligibleMessageRef = event.messageRef;
      continue;
    }
    counters.consecutiveHumanUneditedApprovedSent = 0;
    counters.lastResetAtIso = event.sentAtIso;
    counters.lastResetReason = event.learningDisposition === "proposal_only_counter_reset"
        ? "human_edited"
        : event.approval === "rejected" || event.approval === "skipped"
          ? "human_rejected"
          : event.deliveryState === "failed"
            ? "send_failure"
            : "case_unresolved_adverse_event";
  }
  return counters;
}

export async function deriveChatAutoCaseCounters(
  caseId: ChatAutoPermitCaseId,
  options: { limit?: number; pin: ChatAutoCasePermitPin },
): Promise<ChatAutoCasePermitDoc["counters"]> {
  const limit = Math.min(Math.max(Math.floor(cleanNumber(options.limit ?? 100)), 1), 500);
  const snapshot = await adminDb
    .collection("mail_outbound_log")
    .where("caseId", "==", caseId)
    .orderBy("sentAtIso", "desc")
    .limit(limit)
    .get();
  const events = snapshot.docs
    .map((doc) => ({ id: doc.id, data: doc.data() }))
    .reverse()
    .map(({ id, data }): ChatAutoCommittedSendEvent => ({
      conversationId: String(data.conversationId ?? ""),
      messageRef: String(data.messageRef ?? ""),
      messageSourceRef: String(data.messageSourceRef ?? ""),
      // [적대 리뷰 LOW] doc.id 를 쓴다 — 문서 내부 `id` 필드는 쓰기 경로 실수로 비거나 어긋날 수
      //   있지만 doc.id 는 항상 실제 문서 경로와 일치한다.
      outboundLogRef: `mail_outbound_log/${id}`,
      caseId,
      casebookHash: typeof data.casebookHash === "string" ? data.casebookHash : null,
      gatewayModelVersion: typeof data.gatewayModelVersion === "string" ? data.gatewayModelVersion : null,
      caseIntentRef: typeof data.caseIntentRef === "string" ? data.caseIntentRef : null,
      permitDecisionId: typeof data.permitDecisionId === "string" ? data.permitDecisionId : null,
      sender: data.sender === "human" ? "human" : "ai",
      approval: data.approval === "approved" || data.approval === "rejected" || data.approval === "skipped" ? data.approval : "unknown",
      deliveryState: data.deliveryState === "sent" || data.deliveryState === "mock_sent" || data.deliveryState === "blocked" || data.deliveryState === "failed" || data.deliveryState === "skipped_duplicate" ? data.deliveryState : "unknown",
      providerConfirmed: data.providerConfirmed === true,
      acceptedCount: cleanNumber(data.acceptedCount),
      rejectedCount: cleanNumber(data.rejectedCount),
      originalDraftHash: typeof data.originalDraftHash === "string" ? data.originalDraftHash : null,
      sentBodyHash: typeof data.sentBodyHash === "string" ? data.sentBodyHash : null,
      sentMatchesServerRenderedDraft: data.sentMatchesServerRenderedDraft === true,
      bounced: data.bounced === true,
      complained: data.complained === true,
      optedOut: data.optedOut === true,
      suppressed: data.suppressed === true,
      learningDisposition:
        data.learningDisposition === "arming_credit" ||
        data.learningDisposition === "proposal_only_counter_reset" ||
        data.learningDisposition === "rejected_audit_only" ||
        data.learningDisposition === "adverse_audit_only"
          ? data.learningDisposition
          : "adverse_audit_only",
      sentAtIso: typeof data.sentAtIso === "string" ? data.sentAtIso : new Date(0).toISOString(),
    }));
  return summarizeChatAutoPermitCounters(events, { pin: options.pin });
}

function countersWellFormed(counters: ChatAutoCasePermitDoc["counters"]): boolean {
  return (
    Number.isSafeInteger(counters.consecutiveHumanUneditedApprovedSent) &&
    Number.isSafeInteger(counters.totalHumanUneditedApprovedSent) &&
    Number.isSafeInteger(counters.unavailableEvidenceCount) &&
    counters.totalHumanUneditedApprovedSent >= counters.consecutiveHumanUneditedApprovedSent
  );
}

function countersMeetArmingFloor(counters: ChatAutoCasePermitDoc["counters"]): boolean {
  return (
    countersWellFormed(counters) &&
    counters.consecutiveHumanUneditedApprovedSent >= CHAT_AUTO_MIN_CONSECUTIVE_UNEDITED_APPROVED_SENDS &&
    counters.unavailableEvidenceCount === 0
  );
}

// [적대 리뷰 LOW] 이 함수는 chatAutoCasePermit.ts 의 evalEvidencePasses 와 조건이 완전히 같았다 —
// 이제 그 하나를 공유한다(아래 호출부).

export async function setChatAutoCasePermitFromVerifiedEvidence(input: {
  caseId: ChatAutoPermitCaseId;
  requestedState: "armed" | "disarmed";
  pin: ChatAutoCasePermitPin;
  counters: ChatAutoCasePermitDoc["counters"];
  evalEvidence: ChatAutoEvalEvidence | null;
  actorUid: string;
  actorRole: string;
  nowIso: string;
  // 헤세 정책 결정 2026-09-17: super_admin 강제 arm 경로. "operator_override" 는 20건 연속
  // 카운터 플로어와 unavailableEvidenceCount>0 체크만 건너뛴다 — eval 증거 검증은 그대로다.
  armingSource?: "operator_override" | "counter_floor";
  overrideReason?: string | null;
  // 코덱스 적대 리뷰(2026-09-24, 3회차) BLOCKER 수리: 호출자가 미리 읽은 permit 의 updatedAtIso 를
  //   넘기면, 이 함수는 자신의 **트랜잭션 안에서** 라이브 문서의 updatedAtIso 가 그것과 여전히
  //   같은지 재확인한다(낙관적 동시성 제어) — read-then-write 사이에 다른 쓰기(예: 사람의 수동
  //   disarm, appendChatAutoCasePermitEvent 자동 disarm)가 끼어들면 그 쓰기가 updatedAtIso 를
  //   바꿔 이 트랜잭션이 실패한다. 기존의 "adverse disarm evidence" 가드(바로 아래)는 자동
  //   disarm(lastDisarmReason 있음)만 잡고 수동 disarm(콘솔의 setChatAutoCasePermitArming
  //   action:"disarm", lastDisarmReason 없음)은 놓쳤다 — 이 필드는 그 구멍을 도달 경로 무관하게
  //   닫는다. 생략하면(undefined) 기존 동작 그대로(무조건 통과) — additive, 기존 호출부(운영자
  //   arm 콜러블 등)는 이 인자를 넘기지 않아 회귀가 없다.
  expectedCurrentUpdatedAtIso?: string;
  /** Test seam; production callers use the Admin SDK database. */
  db?: typeof adminDb;
}): Promise<ChatAutoCasePermitDoc> {
  const armed = input.requestedState === "armed";
  const armingSource = input.armingSource ?? "counter_floor";
  const operatorOverride = armed && armingSource === "operator_override";
  if (armed && operatorOverride && !countersWellFormed(input.counters)) {
    throw Object.assign(new Error("failed-precondition: counters are malformed"), { code: "failed-precondition" });
  }
  if (armed && !operatorOverride && !countersMeetArmingFloor(input.counters)) {
    throw Object.assign(new Error("failed-precondition: counter floor not met"), { code: "failed-precondition" });
  }
  if (armed && (!input.evalEvidence || !evalEvidencePasses(input.evalEvidence, input.pin, input.nowIso))) {
    throw Object.assign(new Error("failed-precondition: eval evidence is not current verified evidence"), { code: "failed-precondition" });
  }
  const overrideReason = operatorOverride ? (input.overrideReason ?? undefined) : undefined;
  const overrideActorUidHash = operatorOverride ? actorHash(input.actorUid, input.actorRole) : undefined;
  const overrideAtIso = operatorOverride ? input.nowIso : undefined;
  const doc: ChatAutoCasePermitDoc = {
    schemaVersion: CHAT_AUTO_PERMIT_SCHEMA_VERSION,
    caseId: input.caseId,
    state: armed ? "armed" : "disarmed",
    armed,
    casebookHash: input.pin.casebookHash,
    casebookVersion: input.pin.casebookVersion,
    modelVersion: input.pin.modelVersion,
    counters: input.counters,
    evalEvidence: input.evalEvidence,
    ...(armed ? { armingSource } : {}),
    ...(overrideReason !== undefined ? { overrideReason } : {}),
    ...(overrideActorUidHash !== undefined ? { overrideActorUidHash } : {}),
    ...(overrideAtIso !== undefined ? { overrideAtIso } : {}),
    updatedAtIso: input.nowIso,
    updatedAt: FieldValue.serverTimestamp(),
    updatedByHash: actorHash(input.actorUid, input.actorRole),
    source: "functions.chatAutoCasePermit",
  };
  const db = input.db ?? adminDb;
  let disarmTransition: Parameters<typeof notifyChatAutoPermitDisarmed>[0] | null = null;
  await db.runTransaction(async (transaction) => {
    disarmTransition = null;
    const ref = db.collection(CHAT_AUTO_CASE_PERMIT_COLLECTION).doc(input.caseId);
    const replyConfigRef = db.collection(CHAT_AUTO_CASE_REPLIES_COLLECTION).doc(CHAT_AUTO_CASE_REPLIES_DOC);
    const [existing, replyConfig] = await Promise.all([
      transaction.get(ref),
      armed ? transaction.get(replyConfigRef) : Promise.resolve(null),
    ]);
    const existingData = existing.exists ? existing.data() as Partial<ChatAutoCasePermitDoc> : null;
    // 2026-10-02 (헤세 결정): 운영자 저장본도 arm 가능하다 — 단 super_admin 의 operator_override 경로로만.
    //   바인딩은 바로 아래 핀 검사(저장 revision 해시가 핀에 포함)가 보장한다.
    if (armed && replyConfig && hasActiveChatAutoCaseReplyOverride(replyConfig.data(), input.caseId) && (input.actorRole !== "super_admin" || !operatorOverride)) {
      throw Object.assign(new Error("failed-precondition: operator-edited replies can only be armed by a super_admin through the operator override path"), { code: "failed-precondition", errorCode: "chat_auto_case_reply_override_not_armable" });
    }
    if (armed && chatAutoCaseReplyPinFromStoredConfig(input.caseId, replyConfig?.data()) !== input.pin.casebookHash) {
      throw Object.assign(new Error("failed-precondition: case reply revision changed before arming"), { code: "failed-precondition", errorCode: "chat_auto_case_reply_revision_changed" });
    }
    if (
      input.expectedCurrentUpdatedAtIso !== undefined &&
      (existingData?.updatedAtIso ?? null) !== input.expectedCurrentUpdatedAtIso
    ) {
      throw Object.assign(new Error("failed-precondition: permit changed since it was last read"), { code: "failed-precondition" });
    }
    if (
      armed &&
      existingData?.armed === false &&
      existingData.lastDisarmReason &&
      existingData.updatedAtIso &&
      input.evalEvidence &&
      Date.parse(existingData.updatedAtIso) >= Date.parse(input.evalEvidence.evaluatedAtIso)
    ) {
      throw Object.assign(new Error("failed-precondition: permit has newer adverse disarm evidence"), { code: "failed-precondition" });
    }
    transaction.set(ref, doc, { merge: false });
    if (!armed && existingData?.armed === true) {
      disarmTransition = {
        caseId: input.caseId,
        reason: "operator_disarm",
        actor: actorHash(input.actorUid, input.actorRole),
        nowIso: input.nowIso,
        previousState: existingData.state ?? "armed",
        nextState: "disarmed",
      };
      createChatAutoPermitDisarmLedgerEntry(transaction, db, disarmTransition);
      queueChatAutoPermitDisarmAlertInTransaction(transaction, db, disarmTransition);
    }
    const id = chatAutoCaseLedgerId({
      conversationId: `permit_admin:${input.actorRole}:${input.nowIso}`,
      messageSourceId: actorHash(input.actorUid, input.actorRole),
      caseId: input.caseId,
      kind: "decision",
    });
    transaction.create(db.collection(CHAT_AUTO_CASE_DECISION_LEDGER_COLLECTION).doc(id), {
      schemaVersion: CHAT_AUTO_PERMIT_SCHEMA_VERSION,
      decisionId: id,
      caseId: input.caseId,
      requestedState: input.requestedState,
      actorHash: actorHash(input.actorUid, input.actorRole),
      counters: input.counters,
      evalRunId: input.evalEvidence?.runId ?? null,
      pin: input.pin,
      ...(armed ? { armingSource } : {}),
      ...(overrideReason !== undefined ? { overrideReason } : {}),
      createdAtIso: input.nowIso,
      createdAt: FieldValue.serverTimestamp(),
      source: "functions.chatAutoCasePermitStore",
    });
  });
  if (disarmTransition) await notifyChatAutoPermitDisarmed(disarmTransition, { db });
  return doc;
}

// expectedPin 이 있으면 ledger 신원에 포함한다 — 낡은 pin 의 skip 행이 같은 (sourceRef,reason,caseId) 의
//   "적용된 disarm" 키를 소비해 일치 pin disarm 이 멱등 성공으로 오인되는 것을 막는다.
export function chatAutoPermitEventLedgerId(input: {
  caseId: ChatAutoPermitCaseId | null;
  reason: string;
  sourceRef: string;
  expectedPin?: { casebookHash: string; modelVersion: string };
}): string {
  return chatAutoCaseLedgerId({
    conversationId: input.sourceRef,
    messageSourceId: input.expectedPin ? `${input.reason}|${input.expectedPin.casebookHash}|${input.expectedPin.modelVersion}` : input.reason,
    caseId: input.caseId,
    kind: "execution",
  });
}

export async function appendChatAutoCasePermitEvent(input: {
  caseId: ChatAutoPermitCaseId | null;
  reason: ChatAutoCasePermitDisarmReason;
  sourceRef: string;
  nowIso: string;
  // 지정되면 라이브 permit 의 pin 이 같을 때만 disarm 한다(낡은 pin 근거로 새 permit 을 내리지 않게).
  expectedPin?: { casebookHash: string; modelVersion: string };
}): Promise<{ disarmed: boolean; pinMismatch: boolean }> {
  const id = chatAutoPermitEventLedgerId(input);
  const permitRef = input.caseId !== null
    ? adminDb.collection(CHAT_AUTO_CASE_PERMIT_COLLECTION).doc(input.caseId)
    : null;
  let disarmTransition: Parameters<typeof notifyChatAutoPermitDisarmed>[0] | null = null;
  let observedPinMismatch = false;
  await adminDb.runTransaction(async (transaction) => {
    disarmTransition = null;
    // [적대 리뷰 LOW] 아래 merge 가 이 caseId 의 **첫** permit 문서 쓰기일 수 있다 — 그 경우
    // 필수 shape(schemaVersion/caseId/casebookHash/... /counters/evalEvidence/updatedByHash)이
    // 없는 채로 저장되면 permitFromSnapshot 의 `data.caseId !== snapshot.id` 검사가 이 문서를
    // "없음" 취급해 armed:false/lastDisarmReason 이 죽은 필드가 된다. 기존 문서가 있으면 그
    // 필드들을 건드리지 않는다(merge 로 실제 값을 덮어쓰지 않기 위해 먼저 읽는다).
    const existing = permitRef ? await transaction.get(permitRef) : null;
    const existingPermit = existing?.exists ? existing.data() as Partial<ChatAutoCasePermitDoc> : null;
    const pinMismatch =
      input.expectedPin !== undefined &&
      existingPermit !== null &&
      (existingPermit.casebookHash !== input.expectedPin.casebookHash || existingPermit.modelVersion !== input.expectedPin.modelVersion);
    observedPinMismatch = pinMismatch;
    if (input.caseId !== null && existingPermit?.armed === true && !pinMismatch) {
      disarmTransition = {
        caseId: input.caseId,
        reason: input.reason,
        actor: "system",
        nowIso: input.nowIso,
        previousState: existingPermit.state ?? "armed",
        nextState: "disarmed",
      };
    }
    transaction.create(adminDb.collection(CHAT_AUTO_CASE_EXECUTION_LEDGER_COLLECTION).doc(id), {
      schemaVersion: CHAT_AUTO_PERMIT_SCHEMA_VERSION,
      caseId: input.caseId,
      reason: input.reason,
      sourceRef: input.sourceRef,
      ...(disarmTransition ? chatAutoPermitDisarmLedgerFields(disarmTransition) : {}),
      ...(pinMismatch ? { permitStateUnchanged: "pin_mismatch" } : {}),
      createdAtIso: input.nowIso,
      createdAt: FieldValue.serverTimestamp(),
      source: "functions.chatAutoCasePermitStore",
    });
    if (disarmTransition) queueChatAutoPermitDisarmAlertInTransaction(transaction, adminDb, disarmTransition);
    if (permitRef && !pinMismatch) {
      transaction.set(permitRef, {
        ...(existing?.exists ? {} : {
          schemaVersion: CHAT_AUTO_PERMIT_SCHEMA_VERSION,
          caseId: input.caseId,
          casebookHash: CHAT_CASEBOOK_CONTENT_HASH,
          casebookVersion: CHAT_CASEBOOK_VERSION,
          modelVersion: "",
          counters: emptyChatAutoPermitCounters(),
          evalEvidence: null,
          updatedByHash: "system",
        }),
        state: "disarmed",
        armed: false,
        lastDisarmReason: input.reason,
        updatedAtIso: input.nowIso,
        updatedAt: FieldValue.serverTimestamp(),
        source: "functions.chatAutoCasePermit",
      }, { merge: true });
    }
  });
  if (disarmTransition) await notifyChatAutoPermitDisarmed(disarmTransition);
  // Actual outcome of the LAST (committed) transaction attempt — callers must not claim a disarm that was a pin_mismatch no-op.
  return { disarmed: disarmTransition !== null, pinMismatch: observedPinMismatch };
}

export function writeChatAutoCaseIntentBatch(
  batch: FirebaseFirestore.WriteBatch | FirebaseFirestore.Transaction,
  input: {
    conversationId: string;
    messageSourceId: string;
    caseId: ChatAutoPermitCaseId;
    queueRef: string | FirebaseFirestore.DocumentReference;
    decision: ChatAutoCasePermitDecision;
    nowIso: string;
  },
): FirebaseFirestore.DocumentReference {
  const ref = adminDb.collection(CHAT_AUTO_CASE_INTENTS_COLLECTION).doc(chatAutoCaseIntentId(input.conversationId, input.caseId));
  batch.create(ref, {
    schemaVersion: CHAT_AUTO_PERMIT_SCHEMA_VERSION,
    conversationId: input.conversationId,
    messageSourceId: input.messageSourceId,
    caseId: input.caseId,
    queueRef: typeof input.queueRef === "string" ? input.queueRef : input.queueRef.path,
    permitDecisionId: chatAutoCaseLedgerId({
      conversationId: input.conversationId,
      messageSourceId: input.messageSourceId,
      caseId: input.caseId,
      kind: "decision",
    }),
    allowed: input.decision.allowed,
    createdAtIso: input.nowIso,
    createdAt: FieldValue.serverTimestamp(),
    source: "functions.chatAutoCasePermitStore",
  });
  return ref;
}

export function isChatAutoCaseIntentCreateCollision(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return code === 6 || code === "already-exists" || message.includes("already exists");
}

export async function recordChatAutoDecisionLedger(input: {
  decision: ChatAutoCasePermitDecision;
  conversationId: string;
  messageSourceId: string;
  gatewayCostLog: { provider: string; model: string; transport: string; estimatedCostUsd: number };
  nowIso: string;
}): Promise<void> {
  const id = chatAutoCaseLedgerId({
    conversationId: input.conversationId,
    messageSourceId: input.messageSourceId,
    caseId: input.decision.caseId,
    kind: "decision",
  });
  const record = {
    schemaVersion: CHAT_AUTO_PERMIT_SCHEMA_VERSION,
    decisionId: id,
    conversationId: input.conversationId,
    messageSourceId: input.messageSourceId,
    caseId: input.decision.caseId,
    allowed: input.decision.allowed,
    denyReasons: input.decision.allowed ? [] : input.decision.denyReasons,
    pin: input.decision.pin,
    caseCandidates: input.decision.allowed ? [] : input.decision.caseCandidates,
    clampReasonIds: input.decision.allowed ? [] : input.decision.clampReasonIds,
    gatewayCostLog: {
      provider: input.gatewayCostLog.provider,
      model: input.gatewayCostLog.model,
      transport: input.gatewayCostLog.transport,
      estimatedCostUsd: Number(input.gatewayCostLog.estimatedCostUsd || 0),
    },
    createdAtIso: input.nowIso,
    createdAt: FieldValue.serverTimestamp(),
    source: "functions.chatAutoCasePermitStore",
  };
  const ref = adminDb.collection(CHAT_AUTO_CASE_DECISION_LEDGER_COLLECTION).doc(id);
  await adminDb.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (existing.exists) {
      if (chatAutoDecisionLedgerRecordsMatch(existing.data() ?? {}, record)) return;
      throw Object.assign(
        new Error("already-exists: conflicting chat auto permit decision ledger replay"),
        { code: "already-exists" },
      );
    }
    transaction.create(ref, record);
  });
}

export async function markChatAutoCaseExecution(input: {
  conversationId: string;
  messageSourceId: string;
  caseId: ChatAutoPermitCaseId | null;
  queueRef: string;
  result: "reserved" | "sent" | "skipped" | "duplicate" | "failed";
  reason?: string;
  nowIso: string;
}): Promise<void> {
  const id = chatAutoCaseExecutionLedgerId(input);
  await adminDb.collection(CHAT_AUTO_CASE_EXECUTION_LEDGER_COLLECTION).doc(id).create({
    schemaVersion: CHAT_AUTO_PERMIT_SCHEMA_VERSION,
    ...input,
    createdAt: FieldValue.serverTimestamp(),
    source: "functions.chatAutoCasePermitStore",
  });
}

export async function writeChatAutoCaseEvalRun(evidence: ChatAutoEvalEvidence): Promise<void> {
  await adminDb.collection(CHAT_AUTO_CASE_EVAL_RUNS_COLLECTION).doc(evidence.runId).create({
    schemaVersion: CHAT_AUTO_PERMIT_SCHEMA_VERSION,
    ...evidence,
    createdAt: FieldValue.serverTimestamp(),
    source: "functions.chatAutoCasePermitStore",
  });
}

export function chatAutoCommittedSendEventId(input: Pick<ChatAutoCommittedSendEvent, "conversationId" | "messageRef" | "messageSourceRef" | "outboundLogRef" | "caseId">): string {
  return createHash("sha256")
    .update(JSON.stringify(["chat_auto_committed_send", input.conversationId, input.messageRef, input.messageSourceRef, input.outboundLogRef, input.caseId ?? "null"]))
    .digest("hex")
    .slice(0, 48);
}

export function chatAutoCaseProposalOutboxId(input: Pick<ChatAutoCommittedSendEvent, "caseId" | "messageRef" | "messageSourceRef" | "sentBodyHash">): string {
  return createHash("sha256")
    .update(JSON.stringify(["chat_auto_casebook_proposal", input.caseId ?? "null", input.messageRef, input.messageSourceRef, input.sentBodyHash ?? "null"]))
    .digest("hex")
    .slice(0, 48);
}

export function writeChatAutoCommittedSendEventBatch(
  batch: FirebaseFirestore.WriteBatch,
  input: ChatAutoCommittedSendEvent,
): FirebaseFirestore.DocumentReference {
  const ref = adminDb.collection(CHAT_AUTO_CASE_COMMITTED_SENDS_COLLECTION).doc(chatAutoCommittedSendEventId(input));
  createCommittedSendAndProposalWrites(batch, ref, input);
  return ref;
}

export async function recordChatAutoCommittedSendEvent(
  input: ChatAutoCommittedSendEvent,
  options: ChatAutoCounterPinOptions,
): Promise<FirebaseFirestore.DocumentReference> {
  const ref = adminDb.collection(CHAT_AUTO_CASE_COMMITTED_SENDS_COLLECTION).doc(chatAutoCommittedSendEventId(input));
  let disarmTransition: Parameters<typeof notifyChatAutoPermitDisarmed>[0] | null = null;
  await adminDb.runTransaction(async (transaction) => {
    disarmTransition = null;
    const permitRef =
      input.caseId !== null && input.casebookHash !== null && input.gatewayModelVersion !== null
        ? adminDb.collection(CHAT_AUTO_CASE_PERMIT_COLLECTION).doc(input.caseId)
        : null;
    const snapshot = permitRef ? await transaction.get(permitRef) : null;
    const existing = snapshot?.exists ? snapshot.data() as Partial<ChatAutoCasePermitDoc> : null;
    createCommittedSendAndProposalWrites(transaction, ref, input);
    if (permitRef === null || input.caseId === null || input.casebookHash === null || input.gatewayModelVersion === null) return;
    // 2026-10-02 silent-disarm 수리: 커밋 발송 이벤트는 permit 의 armed/state/lastDisarmReason/pin 을
    //   절대 바꾸지 않는다 — counters 만 갱신한다. 이벤트의 pin 이 현재 pin 과 다르거나(낡은 draft) 저장된
    //   permit pin 이 현재 pin 과 다르면 카운터에 반영하지 않고 감사 기록만 남긴다.
    const eventStale =
      input.casebookHash !== options.pin.casebookHash || input.gatewayModelVersion !== options.pin.modelVersion;
    const existingSamePin =
      existing?.casebookHash === options.pin.casebookHash &&
      existing?.casebookVersion === options.pin.casebookVersion &&
      existing?.modelVersion === options.pin.modelVersion;
    if (eventStale || (existing && !existingSamePin)) {
      transaction.set(adminDb.collection(CHAT_AUTO_CASE_EXECUTION_LEDGER_COLLECTION).doc(
        chatAutoCaseLedgerId({ conversationId: ref.id, messageSourceId: "stale_pin_committed_send", caseId: input.caseId, kind: "execution" }),
      ), {
        schemaVersion: CHAT_AUTO_PERMIT_SCHEMA_VERSION,
        caseId: input.caseId,
        reason: eventStale ? "stale_pin_committed_send" : "permit_pin_mismatch_committed_send",
        sourceRef: ref.path,
        createdAtIso: input.sentAtIso,
        createdAt: FieldValue.serverTimestamp(),
        source: "functions.chatAutoCasePermitStore",
      });
      return;
    }
    const counters = applyChatAutoCommittedSendEventToCounters(existing?.counters ?? null, input, options);
    if (existing) {
      // 같은 pin 의 차단/억제 발송은 이 트랜잭션 안에서(= pin 검증과 원자적으로) 명시 disarm 한다 —
      //   별도 트랜잭션 append 는 사이에 permit 이 바뀌거나 실패해 disarm 이 유실/오발될 수 있었다.
      if (input.suppressed && existing.armed === true) {
        const transitionInput: Parameters<typeof notifyChatAutoPermitDisarmed>[0] = {
          caseId: input.caseId,
          reason: "mail_safety_denied",
          actor: "system",
          nowIso: input.sentAtIso,
          previousState: existing.state ?? "armed",
          nextState: "disarmed",
        };
        disarmTransition = transitionInput;
        createChatAutoPermitDisarmLedgerEntry(transaction, adminDb, transitionInput);
        queueChatAutoPermitDisarmAlertInTransaction(transaction, adminDb, transitionInput);
        transaction.set(permitRef, {
          counters,
          state: "disarmed",
          armed: false,
          lastDisarmReason: "mail_safety_denied",
          updatedAtIso: input.sentAtIso,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return;
      }
      // counter_floor permit 이 리셋으로 floor 아래로 떨어지면 armed 표시는 남아도 dispatch 가
      //   counter_floor_not_met 로 거부한다 — 조용한 정지를 막기 위해 disarm 과 같은 급으로 기록+알림.
      if (
        existing.armed === true &&
        existing.armingSource !== "operator_override" &&
        existing.counters &&
        countersMeetArmingFloor(existing.counters) &&
        !countersMeetArmingFloor(counters)
      ) {
        const transitionInput: Parameters<typeof notifyChatAutoPermitDisarmed>[0] = {
          caseId: input.caseId,
          reason: counters.lastResetReason ?? "counter_floor_lost",
          actor: "system",
          nowIso: input.sentAtIso,
          previousState: existing.state ?? "armed",
          nextState: existing.state ?? "armed",
          effect: "inert",
        };
        disarmTransition = transitionInput;
        createChatAutoPermitDisarmLedgerEntry(transaction, adminDb, transitionInput);
        queueChatAutoPermitDisarmAlertInTransaction(transaction, adminDb, transitionInput);
      }
      // updatedAtIso 를 올려 refresh/arm 의 낙관적 동시성 검사가 카운터 변경을 감지하게 한다.
      transaction.set(permitRef, { counters, updatedAtIso: input.sentAtIso, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return;
    }
    transaction.set(permitRef, {
      schemaVersion: CHAT_AUTO_PERMIT_SCHEMA_VERSION,
      caseId: input.caseId,
      state: "candidate",
      armed: false,
      casebookHash: options.pin.casebookHash,
      casebookVersion: options.pin.casebookVersion,
      modelVersion: options.pin.modelVersion,
      counters,
      evalEvidence: null,
      updatedAtIso: input.sentAtIso,
      updatedAt: FieldValue.serverTimestamp(),
      updatedByHash: "server_committed_send",
      source: "functions.chatAutoCasePermit",
    }, { merge: true });
  });
  if (disarmTransition) await notifyChatAutoPermitDisarmed(disarmTransition);
  return ref;
}
