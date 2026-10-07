/**
 * Manual-reply learning capture (Flu ticket: "manual reply learning candidates").
 *
 * Goal: when a human answers a creator directly — either via a Gmail-imported Sent
 * message (functions/mailExternalSentImport.ts) or a free-written reply sent through
 * Flu's own Chat (functions/chat-ai.ts sendEmailInternal, `intent: "chat_manual_reply"`)
 * — capture that reply as a `reviewStatus:"pending"` feedback-KB candidate, tagged
 * `source:"implicit_manual_reply"`, paired with the inbound creator message it answers.
 * A human reviews it once (src/app/(app)/admin/knowledge/page.tsx, the existing
 * `indexFeedbackKb` review surface) before it can ever be retrieved as `kbContext`.
 *
 * This module deliberately does NOT touch the auto-send/permit gates
 * (functions/chatAutoCasePermit*.ts) or the casebook hard-rule list
 * (functions/chatCasebook.ts) — it only READS `caseId`/`casebookHash` metadata that a
 * caller already resolved, purely for KB-candidate context. Casebook hard-rule cases
 * (fixed_terms_inquiry, call_request, settlement_dispute, out_of_scope_request,
 * opt_out_or_legal) remain exactly as gated as before; a human reviewer sees the
 * paired case id on the candidate and rejects it when the reply itself violates a
 * hard rule (e.g. a negotiated price), same as any other feedback-KB entry.
 *
 * "Bulk/templated notice" exclusion: capture requires a positive pairing to a specific
 * inbound `message_sources` doc (`inboundSourceRef`). Cold-outreach/templated sends have
 * no preceding inbound to answer, so they structurally never qualify — no separate
 * bulk-detection heuristic is needed.
 *
 * Feature flag: `settings/manual_reply_learning` (`enabled`, default false) + a
 * `dailyCap` (default 50) enforced via a transactional per-day counter
 * (`manual_reply_learning_daily_counters/{day_YYYY-MM-DD}`), mirroring the ledger
 * pattern functions/mailOutboundSafety.ts uses for outbound send caps.
 */
import { FieldValue, type Transaction } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  makeBehaviorLog,
  makeCache,
  makeCostLog,
  type CallableRequestShape,
} from "./shared";
import { redactKnowledgeRef, redactKnowledgeText } from "./feedbackKbGovernanceCore";
import { submitFeedbackAsSystem, type FeedbackPrincipal } from "./feedback-kb";
import { safeOutboundFailureEvidence } from "./mailSafetyShared";

export const MANUAL_REPLY_LEARNING_SETTINGS_DOC = "settings/manual_reply_learning";
const DAILY_COUNTER_COLLECTION = "manual_reply_learning_daily_counters";
const MESSAGE_SOURCES_COLLECTION = "message_sources";
const READ_ROLES = ["super_admin", "admin", "manager", "viewer"] as const;
const WRITE_ROLES = ["super_admin"] as const;
const BACKFILL_ROLES = ["super_admin"] as const;
const DEFAULT_DAILY_CAP = 50;
const MIN_DAILY_CAP = 1;
const MAX_DAILY_CAP = 500;
const BACKFILL_WINDOW_DAYS = 45;
const BACKFILL_DEFAULT_LIMIT = 200;
const BACKFILL_MAX_LIMIT = 500;

export interface ManualReplyLearningSettings {
  enabled: boolean;
  dailyCap: number;
  updatedAtIso: string | null;
  updatedBy: string | null;
}

export const DEFAULT_MANUAL_REPLY_LEARNING_SETTINGS: ManualReplyLearningSettings = {
  enabled: false,
  dailyCap: DEFAULT_DAILY_CAP,
  updatedAtIso: null,
  updatedBy: null,
};

function settingsDoc() {
  return adminDb.doc(MANUAL_REPLY_LEARNING_SETTINGS_DOC);
}

function normalizeSettings(data: Record<string, unknown>): ManualReplyLearningSettings {
  const rawCap = Number(data.dailyCap);
  const dailyCap = Number.isFinite(rawCap)
    ? Math.min(MAX_DAILY_CAP, Math.max(MIN_DAILY_CAP, Math.trunc(rawCap)))
    : DEFAULT_DAILY_CAP;
  return {
    enabled: data.enabled === true,
    dailyCap,
    updatedAtIso: typeof data.updatedAtIso === "string" ? data.updatedAtIso : null,
    updatedBy: typeof data.updatedBy === "string" ? data.updatedBy : null,
  };
}

export async function readManualReplyLearningSettings(): Promise<ManualReplyLearningSettings> {
  const snapshot = await settingsDoc().get();
  if (!snapshot.exists) return { ...DEFAULT_MANUAL_REPLY_LEARNING_SETTINGS };
  return normalizeSettings(snapshot.data() ?? {});
}

/** Fail-closed: a settings-read failure must never silently start capturing. */
export async function isManualReplyLearningEnabled(): Promise<boolean> {
  try {
    return (await readManualReplyLearningSettings()).enabled;
  } catch {
    return false;
  }
}

export async function getManualReplyLearningSettings(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "manual_reply_learning.settings.get", READ_ROLES);
  const settings = await readManualReplyLearningSettings();
  return {
    ok: true,
    settings,
    cache: makeCache("settings:manual_reply_learning", false, 300),
    costLog: makeCostLog("manual_reply_learning.settings.get", "mock-admin", false, 0),
    behaviorLog: makeBehaviorLog(auth, "manual_reply_learning.settings.get", "success"),
  };
}

export async function updateManualReplyLearningSettings(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "manual_reply_learning.settings.update", WRITE_ROLES);
  const data = asRecord(request.data);
  const current = await readManualReplyLearningSettings();
  const updatedAtIso = new Date().toISOString();
  const next = normalizeSettings({
    enabled: typeof data.enabled === "boolean" ? data.enabled : current.enabled,
    dailyCap: data.dailyCap !== undefined ? data.dailyCap : current.dailyCap,
    updatedAtIso,
    updatedBy: auth.userId,
  });
  await settingsDoc().set({ ...next, updatedAtIso: FieldValue.serverTimestamp() }, { merge: true });
  return {
    ok: true,
    settings: next,
    cache: makeCache("settings:manual_reply_learning", false, 300),
    costLog: makeCostLog("manual_reply_learning.settings.update", "mock-admin", false, 0),
    behaviorLog: makeBehaviorLog(auth, "manual_reply_learning.settings.update", "success"),
  };
}

function dayKey(now: Date): string {
  return `day_${now.toISOString().slice(0, 10)}`;
}

/**
 * Transactionally reserves one unit of today's capture capacity. Returns false (no
 * write) once `dailyCap` is reached for the day — callers must skip the capture
 * entirely rather than retry, the same fail-closed default `settings.enabled` uses.
 */
async function reserveDailyCaptureCapacity(cap: number, now: Date): Promise<boolean> {
  const ref = adminDb.collection(DAILY_COUNTER_COLLECTION).doc(dayKey(now));
  return adminDb.runTransaction(async (transaction: Transaction) => {
    const snapshot = await transaction.get(ref);
    const current = Number((snapshot.data() ?? {}).count ?? 0);
    if (current >= cap) return false;
    transaction.set(ref, { count: FieldValue.increment(1), updatedAtIso: now.toISOString() }, { merge: true });
    return true;
  });
}

/**
 * Compensates a reservation the write that followed it never actually consumed (the
 * `submitFeedbackAsSystem` call threw). Without this, a single transient Firestore error
 * permanently burns one unit of today's cap for a candidate that was never captured.
 * Floors at 0 — never goes negative even under concurrent releases.
 */
async function releaseDailyCaptureCapacity(now: Date): Promise<void> {
  const ref = adminDb.collection(DAILY_COUNTER_COLLECTION).doc(dayKey(now));
  await adminDb.runTransaction(async (transaction: Transaction) => {
    const snapshot = await transaction.get(ref);
    const current = Number((snapshot.data() ?? {}).count ?? 0);
    if (current <= 0) return;
    transaction.set(ref, { count: current - 1, updatedAtIso: now.toISOString() }, { merge: true });
  });
}

const SYSTEM_PRINCIPAL: FeedbackPrincipal = {
  uid: "system:manual-reply-learning",
  role: "admin",
  team: "aix",
  gameId: "global",
};

function safeFeedbackIdSegment(value: string): string {
  const normalized = value
    .replace(/^message_sources\//, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .slice(0, 120);
  return normalized || "reply";
}

/** Redacts then bounds a stored excerpt — generous enough for the review screen's
 * side-by-side inbound/reply view (unlike submitFeedback's own 240-char excerpt cap,
 * which is for a compact single-line summary, not a paired-message review). */
function redactedExcerpt(value: string, maxLength = 2000): string {
  return redactKnowledgeText(value).slice(0, maxLength);
}

export type ManualReplyKind = "gmail_import" | "flu_chat_reply";

export type ManualReplyLearningCaptureInput = {
  /** `message_sources/{id}` path of the human reply being captured. */
  replySourceRef: string;
  replyBody: string;
  replySubject: string;
  replyKind: ManualReplyKind;
  mailAccountId?: string | null;
  /** `message_sources/{id}` path of the paired inbound creator message this replies to. */
  inboundSourceRef: string;
  inboundBody: string;
  inboundSubject: string;
  /** Casebook classification of the paired inbound, if any — metadata only, never a gate. */
  caseId?: string | null;
  casebookHash?: string | null;
  casebookVersion?: string | null;
};

export type ManualReplyLearningCaptureOutcome =
  | { status: "captured"; feedbackRef: string }
  | { status: "skipped"; reason: "disabled" | "daily_cap_reached" | "already_captured" | "missing_pairing" }
  | { status: "error"; reason: string };

type CaptureOptions = {
  /** Backfill is an explicit, human-triggered, `limit`-bounded one-shot — it bypasses the
   * `enabled`/`dailyCap` live-flow gate (but never the idempotent "already captured" check). */
  bypassLiveGate?: boolean;
};

async function captureManualReplyLearningCandidateInternal(
  input: ManualReplyLearningCaptureInput,
  options: CaptureOptions,
): Promise<ManualReplyLearningCaptureOutcome> {
  if (!input.replySourceRef || !input.inboundSourceRef) {
    return { status: "skipped", reason: "missing_pairing" };
  }

  // Settings check comes first (and only for the live-gated path) so the common
  // flag-off case costs one cheap doc read instead of two.
  let dailyCap = 0;
  if (!options.bypassLiveGate) {
    const settings = await readManualReplyLearningSettings();
    if (!settings.enabled) return { status: "skipped", reason: "disabled" };
    dailyCap = settings.dailyCap;
  }

  const feedbackId = `manual-reply-${safeFeedbackIdSegment(input.replySourceRef)}`;
  const feedbackRefPath = `feedback/${feedbackId}`;
  const existing = await adminDb.doc(feedbackRefPath).get();
  if (existing.exists) return { status: "skipped", reason: "already_captured" };

  if (!options.bypassLiveGate) {
    const reserved = await reserveDailyCaptureCapacity(dailyCap, new Date());
    if (!reserved) return { status: "skipped", reason: "daily_cap_reached" };
  }

  try {
    const result = await submitFeedbackAsSystem(
      SYSTEM_PRINCIPAL,
      {
        target: "mail",
        pipelineDomain: "mail",
        rating: "up",
        artifactRef: input.replySourceRef,
        feedbackRef: feedbackRefPath,
        excerpt: redactedExcerpt(input.replyBody, 240),
        note: redactedExcerpt(input.inboundBody, 240),
        model: "human-operator",
        globalScope: "global",
        // Matches the existing target:"mail" global-scope convention
        // (src/app/(app)/chat/templates/page.tsx uses the same locale for mail feedback).
        locale: "und",
      },
      {
        source: "implicit_manual_reply",
        extraTags: ["implicit_manual_reply", input.replyKind],
        extraFields: {
          replyKind: input.replyKind,
          replySubject: redactedExcerpt(input.replySubject, 300),
          // Adversarial review (2026-09-24): replySourceRef/inboundSourceRef ultimately trace
          // back to a caller-suppliable `messageRef` on the chat-send path (functions/chat-ai.ts
          // sendEmailInternal reads `data.messageRef` from the request). redactKnowledgeRef is
          // the same sanitizer submitFeedbackCore already applies to `artifactRef` — a clean
          // internal `message_sources/{id}` path passes through unchanged, anything PII-shaped
          // (e.g. an email embedded in a malformed ref) is hashed instead of stored raw.
          pairedReplyMessageRef: redactKnowledgeRef(input.replySourceRef, "message_sources/redacted"),
          pairedInboundMessageRef: redactKnowledgeRef(input.inboundSourceRef, "message_sources/redacted"),
          pairedReplyExcerpt: redactedExcerpt(input.replyBody, 2000),
          pairedInboundExcerpt: redactedExcerpt(input.inboundBody, 2000),
          pairedInboundSubject: redactedExcerpt(input.inboundSubject, 300),
          pairedInboundCaseId: input.caseId || null,
          pairedInboundCasebookHash: input.casebookHash || null,
          pairedInboundCasebookVersion: input.casebookVersion || null,
          ...(input.mailAccountId ? { mailAccountId: input.mailAccountId } : {}),
        },
      },
    );
    return { status: "captured", feedbackRef: result.feedbackRef };
  } catch (error) {
    // Adversarial review (2026-09-24): a reservation already happened above (unless
    // bypassLiveGate) — release it so a transient write failure doesn't permanently burn a
    // unit of today's cap for a candidate that was never actually captured.
    if (!options.bypassLiveGate) {
      await releaseDailyCaptureCapacity(new Date()).catch(() => undefined);
    }
    const evidence = safeOutboundFailureEvidence(error, "manual-reply-learning:capture");
    console.warn("[manual-reply-learning]", JSON.stringify({
      event: "capture_failed",
      errorCode: evidence.errorCode,
      replyKind: input.replyKind,
    }));
    return { status: "error", reason: evidence.errorCode };
  }
}

/** Live-flow entry point — gated by `settings/manual_reply_learning` + the daily cap. */
export async function captureManualReplyLearningCandidate(
  input: ManualReplyLearningCaptureInput,
): Promise<ManualReplyLearningCaptureOutcome> {
  return captureManualReplyLearningCandidateInternal(input, { bypassLiveGate: false });
}

// ---------- Gmail-import path (functions/mailExternalSentImport.ts) ----------

/**
 * A reply row functions/mailExternalSentImport.ts just imported and paired to an
 * inbound message in the same transaction (`kind: "manual_reply"` +
 * `pairedInboundMessageSourceId` both set). This function re-reads the two
 * `message_sources` docs (cheap — bounded by the scheduled tick's own import limit,
 * normally ≤50/tick) and captures a candidate for each, isolated per-row so one
 * failure never blocks the rest of the scheduled tick.
 */
export type ImportedReplyCandidateRef = {
  sourceId: string;
  mailAccountId: string;
};

export async function captureManualReplyLearningCandidatesForImportedReplies(
  candidates: readonly ImportedReplyCandidateRef[],
): Promise<{ captured: number; skipped: number; errored: number }> {
  let captured = 0;
  let skipped = 0;
  let errored = 0;
  for (const candidate of candidates) {
    try {
      const replySnapshot = await adminDb.collection(MESSAGE_SOURCES_COLLECTION).doc(candidate.sourceId).get();
      if (!replySnapshot.exists) { skipped += 1; continue; }
      const reply = replySnapshot.data() ?? {};
      const pairedInboundMessageSourceId = asString(reply.pairedInboundMessageSourceId, "");
      if (asString(reply.kind, "") !== "manual_reply" || !pairedInboundMessageSourceId) {
        skipped += 1;
        continue;
      }
      const inboundSnapshot = await adminDb.collection(MESSAGE_SOURCES_COLLECTION)
        .doc(pairedInboundMessageSourceId).get();
      if (!inboundSnapshot.exists) { skipped += 1; continue; }
      const inbound = inboundSnapshot.data() ?? {};
      const outcome = await captureManualReplyLearningCandidate({
        replySourceRef: replySnapshot.ref.path,
        replyBody: asString(reply.body, ""),
        replySubject: asString(reply.subject, ""),
        replyKind: "gmail_import",
        mailAccountId: asString(reply.mailAccountId, "") || null,
        inboundSourceRef: inboundSnapshot.ref.path,
        inboundBody: asString(inbound.body, ""),
        inboundSubject: asString(inbound.subject, ""),
        caseId: asString(inbound.caseId, "") || null,
        casebookHash: asString(inbound.casebookHash, "") || null,
        casebookVersion: asString(inbound.casebookVersion, "") || null,
      });
      if (outcome.status === "captured") captured += 1;
      else if (outcome.status === "error") errored += 1;
      else skipped += 1;
    } catch (error) {
      errored += 1;
      const evidence = safeOutboundFailureEvidence(error, "manual-reply-learning:gmail-import-capture");
      console.warn("[manual-reply-learning]", JSON.stringify({
        event: "gmail_import_capture_row_failed",
        errorCode: evidence.errorCode,
      }));
    }
  }
  return { captured, skipped, errored };
}

// ---------- Flu-internal Chat reply path (functions/chat-ai.ts sendEmailInternal) ----------

export type ChatManualReplyCaptureInput = {
  replyMessageRef: string;
  replyBody: string;
  replySubject: string;
  replyToMessageRef: string;
  caseId?: string | null;
  casebookHash?: string | null;
  casebookVersion?: string | null;
};

/**
 * Called from functions/chat-ai.ts sendEmailInternal right after a successful send,
 * only when: `fromRole==="human"`, the send was a verified reply to a specific inbound
 * (`replyToMessageRef` set by `enrichChatManualReplyData`), and no server draft existed
 * for that inbound (`originalDraftHash` absent) — i.e. the operator wrote the reply
 * freely rather than editing/approving an AI-rendered draft.
 */
export async function captureManualReplyLearningCandidateForChatSend(
  input: ChatManualReplyCaptureInput,
): Promise<ManualReplyLearningCaptureOutcome> {
  if (!input.replyToMessageRef) return { status: "skipped", reason: "missing_pairing" };
  const inboundSnapshot = await adminDb.doc(input.replyToMessageRef).get();
  if (!inboundSnapshot.exists) return { status: "skipped", reason: "missing_pairing" };
  const inbound = inboundSnapshot.data() ?? {};
  return captureManualReplyLearningCandidate({
    replySourceRef: input.replyMessageRef,
    replyBody: input.replyBody,
    replySubject: input.replySubject,
    replyKind: "flu_chat_reply",
    inboundSourceRef: inboundSnapshot.ref.path,
    inboundBody: asString(inbound.body, ""),
    inboundSubject: asString(inbound.subject, ""),
    caseId: input.caseId ?? asString(inbound.caseId, "") ?? null,
    casebookHash: input.casebookHash ?? asString(inbound.casebookHash, "") ?? null,
    casebookVersion: input.casebookVersion ?? asString(inbound.casebookVersion, "") ?? null,
  });
}

// ---------- One-shot backfill (super_admin, dryRun default true) ----------

/**
 * Retroactively pairs a historical Gmail-imported Sent row to the inbound message it
 * likely answers. Historical rows predate this feature and never captured raw MIME
 * headers (In-Reply-To/References), so — unlike the live path above, which pairs by
 * exact header match — this uses a best-effort proximity match: the nearest inbound
 * message from the same creator (`fromHash === reply.toHash`) received strictly before
 * the reply was sent. Equality-only filters, no new composite index required.
 *
 * Adversarial review (2026-09-24): a creator can correspond with more than one internal
 * mailbox/org (PLAN-ORG-MAIL-IDENTITY — inbound rows carry `mailAccountId`/`orgId` per
 * event). Matching on `fromHash` alone could pair a reply to the nearest-by-time inbound
 * from a DIFFERENT mailbox/org than the one it actually answered. When the reply carries
 * a `mailAccountId` (it always does — every Gmail-import row is stamped with one), only
 * inbound rows from that SAME account are eligible; unstamped legacy inbound rows (no
 * `mailAccountId` field, pre-dating PLAN-ORG-MAIL-IDENTITY) are still considered, since
 * they predate the multi-account split and were all on the single canonical scp mailbox.
 */
async function findLikelyPairedInbound(reply: Record<string, unknown>): Promise<{
  id: string;
  path: string;
  data: Record<string, unknown>;
} | null> {
  const toHash = asString(reply.toHash, "");
  const sentAtIso = asString(reply.sentAtIso, "");
  if (!toHash || !sentAtIso) return null;
  const replyMailAccountId = asString(reply.mailAccountId, "");
  const snapshot = await adminDb.collection(MESSAGE_SOURCES_COLLECTION)
    .where("direction", "==", "inbound")
    .where("fromHash", "==", toHash)
    .limit(200)
    .get();
  let best: { id: string; path: string; data: Record<string, unknown>; receivedAtIso: string } | null = null;
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const receivedAtIso = asString(data.receivedAtIso, asString(data.mailEventAtIso, ""));
    if (!receivedAtIso || receivedAtIso >= sentAtIso) continue;
    const inboundMailAccountId = asString(data.mailAccountId, "");
    if (replyMailAccountId && inboundMailAccountId && inboundMailAccountId !== replyMailAccountId) continue;
    if (!best || receivedAtIso > best.receivedAtIso) {
      best = { id: doc.id, path: doc.ref.path, data, receivedAtIso };
    }
  }
  return best ? { id: best.id, path: best.path, data: best.data } : null;
}

function isReplyShapedSubject(subject: string): boolean {
  return /^re[:：]/i.test(subject.trim());
}

export async function backfillManualReplyLearningCandidates(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "manual_reply_learning.backfill", BACKFILL_ROLES);
  const data = asRecord(request.data);
  const dryRun = data.dryRun !== false;
  const limit = Math.min(BACKFILL_MAX_LIMIT, Math.max(1, Number(data.limit) || BACKFILL_DEFAULT_LIMIT));
  const cutoffIso = new Date(Date.now() - BACKFILL_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const snapshot = await adminDb.collection(MESSAGE_SOURCES_COLLECTION)
    .where("source", "==", "external_sent_mail_import")
    .where("sentAtIso", ">=", cutoffIso)
    .orderBy("sentAtIso", "desc")
    .limit(limit)
    .get();

  let scanned = 0;
  let alreadyPaired = 0;
  let notReplyShaped = 0;
  let noInboundMatch = 0;
  let captured = 0;
  let skipped = 0;
  let errored = 0;
  const preview: Array<{ sourceId: string; inboundSourceId: string }> = [];

  for (const doc of snapshot.docs) {
    scanned += 1;
    const reply = doc.data();
    if (asString(reply.pairedInboundMessageSourceId, "")) { alreadyPaired += 1; continue; }
    const inReplyTo = asString(reply.inReplyTo, "");
    if (!inReplyTo && !isReplyShapedSubject(asString(reply.subject, ""))) { notReplyShaped += 1; continue; }
    const paired = await findLikelyPairedInbound(reply);
    if (!paired) { noInboundMatch += 1; continue; }
    if (preview.length < 50) preview.push({ sourceId: doc.id, inboundSourceId: paired.id });

    if (dryRun) continue;

    // Adversarial review (2026-09-24): capture BEFORE marking the row paired, not after.
    // Marking first meant a transient capture failure left the row's
    // pairedInboundMessageSourceId set, so the next backfill run's `alreadyPaired` check
    // above would skip it forever with no feedback candidate ever created. Only mark the
    // row once the outcome is not itself a failure — "captured" and every "skipped" reason
    // (already_captured, disabled, daily_cap_reached) all correctly resolve the pairing and
    // need no rediscovery; only "error" must remain retryable on the next run.
    const outcome = await captureManualReplyLearningCandidateInternal({
      replySourceRef: doc.ref.path,
      replyBody: asString(reply.body, ""),
      replySubject: asString(reply.subject, ""),
      replyKind: "gmail_import",
      mailAccountId: asString(reply.mailAccountId, "") || null,
      inboundSourceRef: paired.path,
      inboundBody: asString(paired.data.body, ""),
      inboundSubject: asString(paired.data.subject, ""),
      caseId: asString(paired.data.caseId, "") || null,
      casebookHash: asString(paired.data.casebookHash, "") || null,
      casebookVersion: asString(paired.data.casebookVersion, "") || null,
    }, { bypassLiveGate: true });
    if (outcome.status === "captured") captured += 1;
    else if (outcome.status === "error") errored += 1;
    else skipped += 1;
    if (outcome.status !== "error") {
      await doc.ref.set({
        kind: "manual_reply",
        pairedInboundMessageSourceId: paired.id,
      }, { merge: true }).catch(() => undefined);
    }
  }

  return {
    ok: true,
    dryRun,
    windowDays: BACKFILL_WINDOW_DAYS,
    limit,
    counts: { scanned, alreadyPaired, notReplyShaped, noInboundMatch, captured, skipped, errored },
    preview,
    behaviorLog: makeBehaviorLog(auth, "manual_reply_learning.backfill", "success"),
  };
}
