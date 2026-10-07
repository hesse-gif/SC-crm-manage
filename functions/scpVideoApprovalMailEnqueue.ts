// 0.6.109 — enqueueScpVideoApprovalResultMail (super_admin, dryRun default true).
//
// Why: the sheet sync applies approvals with notifyCreator:false and approved→approved transitions are
// invalid, so a creator whose video is already canonically approved but never got the approval result
// mail has no official path to it. This callable re-creates EXACTLY the outbox row
// transitionVideoReviewDecision would have written for that approval (same shared builder:
// buildVideoResultMailOutboxRow) and nothing else. Rendering, template, mail safety, suppression,
// quota, audit and send all stay in the existing drainer (drainVideoResultMailOutbox). No SMTP here.
//
// Guarantees:
//   - recipient is never caller-supplied: resolved through the drain's own defaultRecipientResolver
//     from the review-state subject.applicationId; only a masked address leaves this module and the
//     address is not persisted (the drain resolves it again at send time);
//   - idempotent: the row key is `${reviewDocId}__${ledger seq of the approval decision}` — the same
//     key the transition path uses — and a transaction re-reads the key plus any approval row that
//     already carries this decisionRef, so a repeat call (or a row the transition already wrote)
//     is a skip, never a duplicate;
//   - one transaction per submission; apply re-verifies the decision it planned against.
import { randomUUID } from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import { actorUidHash } from "./autoReplyBacklog";
import {
  defaultRecipientResolver,
  legacyVideoResultMailAllowed,
  type RecipientResolver,
} from "./scpOutboxMailWorkers";
import { INTEGRATION_EVENT_V2_CALLBACK_OUTBOX_COLLECTION } from "./scpIntegrationEventV2Callbacks";
import { reviewDocId } from "./videoReviewSubjectShape";
import {
  buildVideoResultMailOutboxRow,
  SCP_VIDEO_RESULT_MAIL_OUTBOX_COLLECTION,
  SCP_VIDEO_REVIEW_STATE_COLLECTION,
  VIDEO_RESULT_MAIL_ROLLOUT_SETTINGS_DOC,
} from "./videoReviewTransitionStore";
import {
  asRecord,
  asString,
  assertNonGuestAuth,
  makeBehaviorLog,
  makeDeniedBehaviorLog,
  maskEmail,
  type CallableRequestShape,
} from "./shared";

const AUDIT_ACTION = "mail.enqueueScpVideoApprovalResultMail";
export const VIDEO_APPROVAL_MAIL_ENQUEUE_RUNS_COLLECTION = "scp_video_approval_mail_enqueue_runs";
export const MAX_SUBMISSION_IDS = 25;
const MAX_SUBMISSION_ID_LENGTH = 180;
const MIN_REASON_LENGTH = 8;
const MAX_REASON_LENGTH = 500;
const TEMPLATE_KIND = "content_approved";

export type ApprovalMailSkipReason =
  | "invalid_submission_id"
  | "review_state_missing"
  | "not_approved"
  | "revision_not_current"
  | "approval_decision_missing"
  | "historical_import_decision"
  | "ledger_marked_notified_without_row"
  | "approval_mail_row_exists"
  | "application_id_missing"
  | "portal_callback_not_delivered"
  | "recipient_unresolved"
  | "decision_changed";

export type ApprovalMailPlanEntry = {
  submissionId: string;
  action: "would_enqueue" | "enqueued" | "skip";
  skipReason: ApprovalMailSkipReason | null;
  templateKind: typeof TEMPLATE_KIND;
  recipientMasked: string | null;
};

type ApprovalDecision = {
  seq: number;
  entry: Record<string, unknown>;
  decisionRef: string;
  applicationId: string;
};

type Facts = {
  stateData: Record<string, unknown> | null;
  keyRowExists: boolean;
  /** decisionRefs of every approval result-mail row already present for this submission. */
  approvalRowDecisionRefs: string[];
};

type Planned =
  | { ok: true; decision: ApprovalDecision; stateData: Record<string, unknown> }
  | { ok: false; reason: ApprovalMailSkipReason };

/** Pure planner: decides from the canonical review state + existing outbox rows only. */
export function planApprovalMailFromFacts(submissionId: string, facts: Facts): Planned {
  const data = facts.stateData;
  if (!data) return { ok: false, reason: "review_state_missing" };
  if (asString(data.state) !== "approved") return { ok: false, reason: "not_approved" };
  const revision = Number(data.revision ?? 0);
  if (data.superseded === true || data.withdrawn === true || !Number.isInteger(revision) || revision <= 0) {
    return { ok: false, reason: "revision_not_current" };
  }
  const ledger = Array.isArray(data.reviewLedger) ? (data.reviewLedger as unknown[]) : [];
  const entry = asRecord(ledger[ledger.length - 1]);
  const decisionRef = asString(entry.decisionRef);
  if (
    ledger.length === 0
    || asString(entry.toState) !== "approved"
    || Number(entry.revision) !== revision
    || !decisionRef
  ) {
    return { ok: false, reason: "approval_decision_missing" };
  }
  if (asString(entry.deliveryMode) === "historical_import") {
    return { ok: false, reason: "historical_import_decision" };
  }
  if (facts.keyRowExists || facts.approvalRowDecisionRefs.includes(decisionRef)) {
    return { ok: false, reason: "approval_mail_row_exists" };
  }
  // A transition that WAS meant to notify but left no row is an anomaly (row swept/never written) —
  // never guess; only decisions the ledger itself marks notifyCreator:false are eligible.
  if (entry.notifyCreator !== false) return { ok: false, reason: "ledger_marked_notified_without_row" };
  const applicationId = asString(asRecord(data.subject).applicationId);
  if (!applicationId) return { ok: false, reason: "application_id_missing" };
  return { ok: true, decision: { seq: ledger.length, entry, decisionRef, applicationId }, stateData: data };
}

export type Reader = {
  doc(ref: FirebaseFirestore.DocumentReference): Promise<FirebaseFirestore.DocumentSnapshot>;
  query(query: FirebaseFirestore.Query): Promise<FirebaseFirestore.QuerySnapshot>;
};

async function readFacts(db: FirebaseFirestore.Firestore, read: Reader, submissionId: string): Promise<Facts> {
  const docId = reviewDocId(submissionId);
  const stateSnap = await read.doc(db.collection(SCP_VIDEO_REVIEW_STATE_COLLECTION).doc(docId));
  const stateData = stateSnap.exists ? asRecord(stateSnap.data()) : null;
  const ledgerLength = Array.isArray(stateData?.reviewLedger) ? (stateData.reviewLedger as unknown[]).length : 0;
  const outbox = db.collection(SCP_VIDEO_RESULT_MAIL_OUTBOX_COLLECTION);
  const keySnap = await read.doc(outbox.doc(`${docId}__${Math.max(ledgerLength, 1)}`));
  const rows = await read.query(
    outbox.where("submissionId", "==", submissionId).where("mailKind", "==", TEMPLATE_KIND).limit(50),
  );
  return {
    stateData,
    keyRowExists: keySnap.exists,
    approvalRowDecisionRefs: rows.docs.map((doc) => asString(doc.data()?.decisionRef)).filter(Boolean),
  };
}

function buildRowForDecision(submissionId: string, data: Record<string, unknown>, decision: ApprovalDecision, nowIso: string) {
  const entry = decision.entry;
  return buildVideoResultMailOutboxRow({
    submissionId,
    mailKind: TEMPLATE_KIND,
    decisionRef: decision.decisionRef,
    actorType: asString(entry.actorType) === "ai" ? "ai" : "human",
    reasonCode: asString(entry.reasonCode) || null,
    customerMessageCode: asString(entry.customerMessageCode) || null,
    operatorMessage: asString(entry.operatorMessage) || null,
    reasonTagKeys: Array.isArray(entry.reasonTagKeys) ? (entry.reasonTagKeys as string[]) : null,
    reviewedAt: asString(entry.reviewedAt) || asString(entry.atIso),
    policyVersion: asString(entry.policyVersion),
    contentFingerprint: asString(entry.contentFingerprint) || asString(data.contentFingerprint),
    currentRevision: entry.currentRevision,
    evidence: entry.evidence,
    evidencePacket: entry.evidencePacket,
    nowIso,
  });
}

export type ApprovalMailEnqueueDeps = {
  db?: FirebaseFirestore.Firestore;
  now?: () => Date;
  newRunId?: () => string;
  recipientResolver?: RecipientResolver;
  /** Optional Portal v2 callback evidence for this approval. Default reads the callback outbox. */
  /**
   * Must be true only for a delivered `approved` callback emitted at/after `sinceIso` (the CURRENT approval
   * decision's reviewedAt) — a delivered callback from an earlier revision never counts. `read` lets the
   * default run its query inside the enqueue transaction.
   */
  readCallbackDelivered?: (submissionId: string, sinceIso: string, read?: Reader) => Promise<boolean>;
  readRolloutConfig?: () => Promise<Record<string, unknown> | null>;
  writeAudit?: (runId: string, doc: Record<string, unknown>) => Promise<void>;
};

export type EnqueueScpVideoApprovalResultMailResult = {
  ok: true;
  runId: string;
  dryRun: boolean;
  requested: number;
  wouldEnqueue: number;
  enqueued: number;
  skipped: number;
  skipReasonCounts: Record<string, number>;
  plan: ApprovalMailPlanEntry[];
  auditFinalized: boolean;
  behaviorLog: ReturnType<typeof makeBehaviorLog>;
};

function viewAsRequested(data: Record<string, unknown>): boolean {
  return (typeof data.viewAsUserId === "string" && data.viewAsUserId.trim().length > 0)
    || (typeof data.viewAsEmail === "string" && data.viewAsEmail.trim().length > 0);
}

function invalidArgument(message: string, errorCode: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode });
}

async function defaultReadCallbackDelivered(
  db: FirebaseFirestore.Firestore,
  submissionId: string,
  sinceIso: string,
  read?: Reader,
): Promise<boolean> {
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs)) return false;
  const query = db
    .collection(INTEGRATION_EVENT_V2_CALLBACK_OUTBOX_COLLECTION)
    .where("event.subject.videoSubmissionId", "==", submissionId)
    .limit(50);
  const snap = await (read ? read.query(query) : query.get());
  return snap.docs.some((doc) => {
    const row = asRecord(doc.data());
    const event = asRecord(row.event);
    const occurredMs = Date.parse(asString(event.occurredAt));
    return asString(row.eventName) === "video.review-status.changed"
      && asString(asRecord(event.payload).reviewStatus) === "approved"
      && asString(row.deliveryState) === "delivered"
      && Number.isFinite(occurredMs)
      && occurredMs >= sinceMs;
  });
}

const FIRESTORE_ALREADY_EXISTS_CODE = 6;

export async function enqueueScpVideoApprovalResultMail(
  request: CallableRequestShape,
  deps: ApprovalMailEnqueueDeps = {},
): Promise<EnqueueScpVideoApprovalResultMailResult> {
  const auth = assertNonGuestAuth(request, AUDIT_ACTION, ["super_admin"]);
  const data = asRecord(request.data);
  if (viewAsRequested(data)) {
    throw Object.assign(new Error("permission-denied: this tool does not support viewAs"), {
      code: "permission-denied",
      errorCode: "scp_video_approval_mail_view_as_unsupported",
      behaviorLog: makeDeniedBehaviorLog(request, AUDIT_ACTION, auth.gameId),
    });
  }
  if (data.dryRun !== undefined && typeof data.dryRun !== "boolean") {
    throw invalidArgument("dryRun must be a boolean", "scp_video_approval_mail_invalid_dry_run");
  }
  const dryRun = data.dryRun !== false;
  const requireCallback = data.requirePortalCallbackDelivered === true;
  if (data.requirePortalCallbackDelivered !== undefined && typeof data.requirePortalCallbackDelivered !== "boolean") {
    throw invalidArgument("requirePortalCallbackDelivered must be a boolean", "scp_video_approval_mail_invalid_callback_flag");
  }
  const reason = typeof data.reason === "string" ? data.reason.trim() : "";
  if (reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) {
    throw invalidArgument(
      `reason is required (${MIN_REASON_LENGTH}-${MAX_REASON_LENGTH} chars)`,
      "scp_video_approval_mail_invalid_reason",
    );
  }
  if (!Array.isArray(data.submissionIds) || data.submissionIds.length < 1 || data.submissionIds.length > MAX_SUBMISSION_IDS) {
    throw invalidArgument(`submissionIds must have 1..${MAX_SUBMISSION_IDS} entries`, "scp_video_approval_mail_invalid_submission_ids");
  }
  if (!data.submissionIds.every((id) => typeof id === "string")) {
    throw invalidArgument("submissionIds must be strings", "scp_video_approval_mail_invalid_submission_ids");
  }
  const submissionIds = [...new Set((data.submissionIds as string[]).map((id) => id.trim()))];

  const db = deps.db ?? adminDb;
  const now = deps.now ?? (() => new Date());
  const runId = (deps.newRunId ?? (() => `vam_${randomUUID()}`))();
  const recipientResolver = deps.recipientResolver ?? defaultRecipientResolver;
  const readCallbackDelivered = deps.readCallbackDelivered
    ?? ((id: string, since: string, read?: Reader) => defaultReadCallbackDelivered(db, id, since, read));
  const writeAudit = deps.writeAudit
    ?? (async (id: string, doc: Record<string, unknown>) => {
      await db.collection(VIDEO_APPROVAL_MAIL_ENQUEUE_RUNS_COLLECTION).doc(id).set(doc, { merge: true });
    });

  // Rollout config exactly as the drain reads it (fail-closed null) — only feeds the legacy-resolution predicate.
  let rolloutConfig: Record<string, unknown> | null = null;
  try {
    rolloutConfig = deps.readRolloutConfig
      ? await deps.readRolloutConfig()
      : await (async () => {
          const [collection, docId] = VIDEO_RESULT_MAIL_ROLLOUT_SETTINGS_DOC.split("/");
          const snap = await db.collection(collection).doc(docId).get();
          return snap.exists ? asRecord(snap.data()) : null;
        })();
  } catch {
    rolloutConfig = null;
  }

  // Audit before any write; failing here aborts with zero outbox mutations.
  await writeAudit(runId, {
    runId,
    status: "started",
    action: AUDIT_ACTION,
    actorUid: auth.userId,
    actorUidHash: actorUidHash(auth.userId),
    actorRole: auth.role,
    startedAtIso: now().toISOString(),
    dryRun,
    requirePortalCallbackDelivered: requireCallback,
    reason,
    submissionIds,
  });

  const plan: ApprovalMailPlanEntry[] = [];
  const skipReasonCounts: Record<string, number> = {};
  const entry = (
    submissionId: string,
    action: ApprovalMailPlanEntry["action"],
    skipReason: ApprovalMailSkipReason | null,
    recipientMasked: string | null = null,
  ) => {
    plan.push({ submissionId, action, skipReason, templateKind: TEMPLATE_KIND, recipientMasked });
    if (skipReason) skipReasonCounts[skipReason] = (skipReasonCounts[skipReason] ?? 0) + 1;
  };

  let failure: unknown = null;
  try {
    for (const submissionId of submissionIds) {
      if (
        !submissionId
        || submissionId.length > MAX_SUBMISSION_ID_LENGTH
        || reviewDocId(submissionId) !== submissionId
      ) {
        entry(submissionId.slice(0, MAX_SUBMISSION_ID_LENGTH), "skip", "invalid_submission_id");
        continue;
      }
      const nowIso = now().toISOString();
      const plainReader: Reader = { doc: (ref) => ref.get(), query: (q) => q.get() };
      const planned = planApprovalMailFromFacts(submissionId, await readFacts(db, plainReader, submissionId));
      if (!planned.ok) {
        entry(submissionId, "skip", planned.reason);
        continue;
      }
      const { decision, stateData } = planned;
      if (requireCallback && !(await readCallbackDelivered(submissionId, asString(decision.entry.reviewedAt), plainReader))) {
        entry(submissionId, "skip", "portal_callback_not_delivered");
        continue;
      }
      // Rollout semantics: approval is never gated by rejectionMailEnabled (flu-only lane); the legacy
      // cutover predicate is evaluated below on the exact row the drain would see.
      const candidateRow = buildRowForDecision(submissionId, stateData, decision, nowIso);
      let recipient: Awaited<ReturnType<RecipientResolver>> = null;
      try {
        recipient = await recipientResolver({
          applicationId: decision.applicationId,
          kind: TEMPLATE_KIND,
          allowLegacyVideoResultMail: legacyVideoResultMailAllowed(candidateRow, rolloutConfig, now()),
        });
      } catch {
        recipient = null;
      }
      if (!recipient?.email) {
        entry(submissionId, "skip", "recipient_unresolved");
        continue;
      }
      const recipientMasked = maskEmail(recipient.email);
      if (dryRun) {
        entry(submissionId, "would_enqueue", null, recipientMasked);
        continue;
      }

      const outcome = await db.runTransaction(async (tx): Promise<ApprovalMailSkipReason | "enqueued"> => {
        const txReader: Reader = { doc: (ref) => tx.get(ref), query: (q) => tx.get(q) };
        const fresh = planApprovalMailFromFacts(submissionId, await readFacts(db, txReader, submissionId));
        if (!fresh.ok) return fresh.reason;
        if (fresh.decision.decisionRef !== decision.decisionRef || fresh.decision.seq !== decision.seq) {
          return "decision_changed";
        }
        if (requireCallback && !(await readCallbackDelivered(submissionId, asString(fresh.decision.entry.reviewedAt), txReader))) {
          return "portal_callback_not_delivered";
        }
        tx.create(
          db.collection(SCP_VIDEO_RESULT_MAIL_OUTBOX_COLLECTION).doc(`${reviewDocId(submissionId)}__${decision.seq}`),
          buildRowForDecision(submissionId, fresh.stateData, fresh.decision, nowIso),
        );
        return "enqueued";
      }).catch((error: unknown) => {
        const record = asRecord(error);
        if (record.code === FIRESTORE_ALREADY_EXISTS_CODE || /already exists/i.test(asString(record.message))) {
          return "approval_mail_row_exists" as const;
        }
        throw error;
      });
      if (outcome === "enqueued") entry(submissionId, "enqueued", null, recipientMasked);
      else entry(submissionId, "skip", outcome);
    }
  } catch (error) {
    failure = error;
  }

  const wouldEnqueue = plan.filter((p) => p.action === "would_enqueue").length;
  const enqueued = plan.filter((p) => p.action === "enqueued").length;
  const skipped = plan.filter((p) => p.action === "skip").length;
  let auditFinalized = true;
  try {
    await writeAudit(runId, {
      status: failure ? "failed" : "completed",
      ...(failure ? { errorCode: asString(asRecord(failure).errorCode, "approval_mail_enqueue_failed") } : {}),
      finishedAtIso: now().toISOString(),
      counts: { requested: submissionIds.length, wouldEnqueue, enqueued, skipped, skipReasonCounts },
      results: plan,
    });
  } catch (error) {
    auditFinalized = false;
    console.error("[enqueueScpVideoApprovalResultMail] failed to finalize audit", {
      runId,
      errorCode: asString(asRecord(error).errorCode, "audit_finalize_failed"),
    });
  }
  if (failure) throw failure;

  return {
    ok: true,
    runId,
    dryRun,
    requested: submissionIds.length,
    wouldEnqueue,
    enqueued,
    skipped,
    skipReasonCounts,
    plan,
    auditFinalized,
    behaviorLog: makeBehaviorLog(auth, AUDIT_ACTION, "success"),
  };
}
