import { createHash, randomUUID } from "node:crypto";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { findMailSuppression, mailSuppressionBlocksSend } from "./mailSuppression";
import { resolveCanonicalProgramId, SCP_CANONICAL_PROGRAM_ID } from "./programCanonical";
import { prepareScpResultMail } from "./scpMail";
import { isStrictScpProviderConfirmed } from "./scpResultMailDelivery";
// 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate, codex round-3 adversarial
// review): every public callable in this file has its only client UI in
// src/app/(app)/flu/review/ScpSubmissionNudgePanel.tsx, exclusively rendered inside the
// entitlement-gated /flu/scp page (via ReviewWorkspace.tsx). No internal/scheduler caller of any
// of these handler functions exists — only the scheduler's own SYSTEM_ACTOR-marked
// systemRequest() calls into prepareScpResultMail directly, never through these handlers.
import { assertScpEntitled } from "./mailAccounts";
import {
  normalizeReminderSettings,
  reconcileReminderOffsets,
  reminderDueAtIso,
  reminderOccurrenceId,
  reminderSettingsHash,
  reminderTargetId,
  selectLatestDueOccurrence,
  type ReminderOccurrenceLike,
  type VideoReminderSettings,
} from "./scpVideoSubmissionReminderCore";
import {
  VIDEO_REMINDER_EVENT_COLLECTION,
  VIDEO_REMINDER_OCCURRENCE_COLLECTION,
  VIDEO_REMINDER_SECOND_MAIL_JOBS_COLLECTION,
  VIDEO_REMINDER_SETTINGS_COLLECTION,
  VIDEO_REMINDER_TARGET_COLLECTION,
  VIDEO_REMINDER_TRIGGER_COLLECTION,
  normalizedReminderEmail,
  normalizedReminderEmailHash,
} from "./scpVideoSubmissionReminderStore";
import { safeDocId } from "./sheetIntakeService";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  makeBehaviorLog,
  type AuthContext,
  type CallableRequestShape,
} from "./shared";

const READ_ROLES = ["super_admin", "admin", "manager", "viewer"] as const;
const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;
const MAX_LIST_ROWS = 200;
const MAX_DRAIN_ROWS = 50;
const MAX_ACTIVE_SETTINGS_TARGETS = 25;
const LEASE_MS = 5 * 60 * 1_000;
const MIN_SEND_INTERVAL_MS = 20 * 60 * 60 * 1_000;
const MAX_ATTEMPTS = 5;
const VIDEO_REMINDER_RUNTIME_COLLECTION = "scp_video_submission_reminder_runtime";

type TargetStatus = "due" | "upcoming" | "paused" | "closed";
type OccurrenceStatus =
  | "scheduled"
  | "processing"
  | "awaiting_approval"
  | "paused"
  | "sent"
  | "skipped"
  | "superseded"
  | "cancelled"
  | "failed";

type ProcessOptions = {
  nowIso?: string;
  limit?: unknown;
  processSecondRequests?: boolean;
  processTriggers?: boolean;
  processOccurrences?: boolean;
};

function snapshotRow(doc: FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot): Record<string, unknown> {
  return { id: doc.id, ...(doc.data() ?? {}) } as Record<string, unknown>;
}

const SYSTEM_ACTOR: AuthContext = {
  userId: "scp-video-reminder-scheduler",
  role: "admin",
  team: "scp",
  ip: "0.0.0.0",
  gameId: "scp-automation",
  email: "scp-video-reminder@supercent.io",
  name: "SCP Video Reminder Scheduler",
};

function systemRequest(data: Record<string, unknown>, actor: AuthContext = SYSTEM_ACTOR): CallableRequestShape {
  return {
    // 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate, codex round-3 adversarial
    // review fix): this helper is called from BOTH the genuine scheduler/sweep path (no actor
    // argument, defaults to SYSTEM_ACTOR — trust that) AND from previewVideoSubmissionReminderMail/
    // approveVideoSubmissionReminderMail, which thread the REAL public caller's own `auth` through
    // as `actor` (processOccurrence/processSecondRequestJob's `actor` param). Marking every call
    // trusted regardless of `actor` let a role-permitted but non-entitled manager bypass
    // prepareScpResultMail's assertScpEntitled entirely just by calling those two public
    // callables — only the scheduler's own synthetic identity is ever trusted here.
    ...(actor.userId === SYSTEM_ACTOR.userId ? { internalTrustedInvocation: true } : {}),
    auth: {
      uid: actor.userId,
      token: {
        role: actor.role,
        team: actor.team,
        email: actor.email,
        name: actor.name,
      },
    },
    data,
    rawRequest: { ip: actor.ip },
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nowOr(value: unknown): string {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function boundedLimit(value: unknown, fallback = 50, maximum = MAX_LIST_ROWS): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.trunc(parsed), maximum)) : fallback;
}

function canonicalProgramId(value: unknown): string {
  return resolveCanonicalProgramId(asString(value, SCP_CANONICAL_PROGRAM_ID));
}

function settingsRef(programId: string) {
  return adminDb.collection(VIDEO_REMINDER_SETTINGS_COLLECTION).doc(safeDocId(programId));
}

async function readSettings(programId: string): Promise<{
  settings: VideoReminderSettings;
  version: number;
  hash: string;
  exists: boolean;
}> {
  const snapshot = await settingsRef(programId).get();
  const data = snapshot.data() ?? {};
  const settings = normalizeReminderSettings(data);
  return {
    settings,
    version: Math.max(0, Math.trunc(Number(data.version ?? 0))),
    hash: asString(data.settingsHash, reminderSettingsHash(settings)),
    exists: snapshot.exists,
  };
}

function eventId(targetId: string, action: string, nowIso: string): string {
  return safeDocId(`scp-vsr-event:${hash(`${targetId}\u0000${action}\u0000${nowIso}\u0000${randomUUID()}`).slice(0, 40)}`);
}

function addEvent(
  batch: FirebaseFirestore.WriteBatch,
  input: {
    targetId: string;
    action: string;
    nowIso: string;
    actorUid: string;
    occurrenceId?: string;
    reason?: string;
    details?: Record<string, unknown>;
  },
) {
  const id = eventId(input.targetId, input.action, input.nowIso);
  batch.set(adminDb.collection(VIDEO_REMINDER_EVENT_COLLECTION).doc(id), {
    id,
    targetId: input.targetId,
    targetRef: `${VIDEO_REMINDER_TARGET_COLLECTION}/${input.targetId}`,
    occurrenceId: input.occurrenceId || null,
    action: input.action,
    reason: input.reason || null,
    actorUid: input.actorUid,
    details: input.details ?? {},
    createdAtIso: input.nowIso,
    createdAt: FieldValue.serverTimestamp(),
  });
}

function rowProgram(row: Record<string, unknown>): string {
  return canonicalProgramId(row.canonicalProgramId ?? row.programId);
}

function rowTimestamp(row: Record<string, unknown>): string {
  return asString(
    row.submittedAtIso,
    asString(row.createdAtIso, asString(row.updatedAtIso)),
  );
}

async function querySubmissionField(field: string, value: string): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  if (!value) return [];
  const snapshot = await adminDb.collection("submissions").where(field, "==", value).limit(20).get();
  return snapshot.docs;
}

export async function findMatchingSubmission(input: {
  programId: string;
  token?: string;
  uid?: string;
  creatorId?: string;
  email?: string;
  normalizedEmailHash?: string;
}): Promise<{ ref: string; submittedAtIso: string; matchBasis: string } | null> {
  const programId = canonicalProgramId(input.programId);
  const seen = new Set<string>();
  const checks: Array<[string, string]> = [
    ["token", asString(input.token)],
    ["uid", asString(input.uid)],
    ["creatorId", asString(input.creatorId)],
    ["normalizedEmailHash", asString(input.normalizedEmailHash, normalizedReminderEmailHash(input.email))],
    ["email", normalizedReminderEmail(input.email)],
  ].filter(([, value]) => Boolean(value)) as Array<[string, string]>;
  for (const [field, value] of checks) {
    const docs = await querySubmissionField(field, value);
    for (const doc of docs) {
      if (seen.has(doc.ref.path)) continue;
      seen.add(doc.ref.path);
      const row = doc.data() ?? {};
      if (rowProgram(row) !== programId) continue;
      return { ref: doc.ref.path, submittedAtIso: rowTimestamp(row), matchBasis: field };
    }
  }
  return null;
}

async function targetReplyAfterBaseline(target: Record<string, unknown>): Promise<boolean> {
  if (asRecord(target.settingsSnapshot).pauseOnReply !== true) return false;
  const email = normalizedReminderEmail(target.email);
  if (!email) return false;
  const snapshot = await adminDb.collection("conversations").where("creatorEmail", "==", email).limit(20).get();
  const baseline = Date.parse(asString(target.triggerSentAtIso));
  return snapshot.docs.some((doc) => {
    const data = doc.data() ?? {};
    const inbound = Date.parse(asString(data.lastInboundAtIso));
    return Number.isFinite(inbound) && inbound > baseline;
  });
}

async function targetSuppressionReason(target: Record<string, unknown>): Promise<string> {
  const suppression = await findMailSuppression({
    email: normalizedReminderEmail(target.email),
    handle: asString(target.handle),
    name: asString(target.creatorName),
  });
  return mailSuppressionBlocksSend(suppression) ? asString(suppression.ruleId, suppression.reason) : "";
}

function suppressionShouldPause(target: Record<string, unknown>, reason: string): boolean {
  const settings = normalizeReminderSettings(target.settingsSnapshot);
  if (/bounce/i.test(reason)) return settings.pauseOnBounce;
  if (/opt.?out|unsubscribe|complaint|suppressed-contact/i.test(reason)) return settings.pauseOnOptOut;
  return true;
}

const ACTIVE_OCCURRENCE_STATUSES = new Set<OccurrenceStatus>([
  "scheduled",
  "processing",
  "awaiting_approval",
  "paused",
]);

function isActiveOccurrenceStatus(value: unknown): boolean {
  return ACTIVE_OCCURRENCE_STATUSES.has(asString(value) as OccurrenceStatus);
}

function mailPayloadForJob(job: Record<string, unknown>, formLink: string) {
  const id = asString(job.id);
  return {
    leadId: asString(job.leadId, id),
    creatorId: asString(job.creatorId),
    campaignId: asString(job.campaignId),
    email: normalizedReminderEmail(job.email),
    name: asString(job.creatorName),
    programId: canonicalProgramId(job.canonicalProgramId ?? job.programId),
    kind: "gem_paid_submission_request",
    templateKind: "gem_paid_submission_request",
    mailPurpose: "gem_paid_submission_request",
    mode: "send_approved",
    approval: "approved",
    formLink,
    gemGrantRef: asString(job.gemGrantRef),
    secondMailVersion: Math.max(1, Number(job.secondMailVersion ?? 1)),
    draftRef: `scp-vsr-second-draft-${id}`,
    approvalRef: `scp-vsr-second-approval-${id}`,
    trackingId: `scp-vsr-second-track-${id}`,
  };
}

function mailPayloadForOccurrence(
  occurrence: Record<string, unknown>,
  target: Record<string, unknown>,
  settings: VideoReminderSettings,
) {
  const id = asString(occurrence.id);
  return {
    leadId: asString(target.leadId, asString(target.id)),
    creatorId: asString(target.creatorId),
    campaignId: asString(target.campaignId),
    email: normalizedReminderEmail(target.email),
    name: asString(target.creatorName),
    programId: canonicalProgramId(target.canonicalProgramId ?? target.programId),
    kind: "video_submission_reminder",
    templateKind: "video_submission_reminder",
    mailPurpose: "video_submission_reminder",
    mode: "send_approved",
    approval: "approved",
    formLink: asString(target.formLink, settings.submissionFormUrl),
    gemGrantRef: asString(target.gemGrantRef),
    targetRef: `${VIDEO_REMINDER_TARGET_COLLECTION}/${asString(target.id)}`,
    occurrenceRef: `${VIDEO_REMINDER_OCCURRENCE_COLLECTION}/${id}`,
    secondMailVersion: Math.max(1, Number(target.secondMailVersion ?? 1)),
    offsetDays: Number(occurrence.offsetDays ?? 0),
    daysSinceRequest: Number(occurrence.offsetDays ?? 0),
    reminderNumber: Number(occurrence.reminderNumber ?? 0),
    draftRef: `scp-vsr-reminder-draft-${id}`,
    approvalRef: `scp-vsr-reminder-approval-${id}`,
    trackingId: `scp-vsr-reminder-track-${id}`,
  };
}

async function persistDraft(payload: Record<string, unknown>, actor: AuthContext = SYSTEM_ACTOR) {
  return asRecord(await prepareScpResultMail(systemRequest({
    ...payload,
    mode: "draft_only",
    dryRun: false,
    liveSend: false,
  }, actor)));
}

async function sendApprovedMail(payload: Record<string, unknown>, actor: AuthContext = SYSTEM_ACTOR) {
  const preview = asRecord(await prepareScpResultMail(systemRequest({
    ...payload,
    mode: "send_approved",
    approval: "approved",
    dryRun: true,
    liveSend: false,
  }, actor)));
  if (preview.alreadySent === true || asString(preview.status) === "sent") return preview;
  const previewToken = asString(preview.previewToken);
  const previewHash = asString(preview.previewHash);
  if (!previewToken || !previewHash) return preview;
  return asRecord(await prepareScpResultMail(systemRequest({
    ...payload,
    mode: "send_approved",
    approval: "approved",
    previewToken,
    previewHash,
    dryRun: false,
    liveSend: true,
  }, actor)));
}

function occurrenceStatusForDue(dueAtIso: string, nowIso: string): TargetStatus {
  return Date.parse(dueAtIso) <= Date.parse(nowIso) ? "due" : "upcoming";
}

function occurrenceRowsForTarget(input: {
  targetId: string;
  triggerSentAtIso: string;
  secondMailVersion: number;
  settings: VideoReminderSettings;
  settingsVersion: number;
  settingsHash: string;
  nowIso: string;
}) {
  return input.settings.offsets.map((offsetDays, index) => {
    const id = reminderOccurrenceId(input.targetId, input.secondMailVersion, offsetDays);
    return {
      id,
      targetId: input.targetId,
      targetRef: `${VIDEO_REMINDER_TARGET_COLLECTION}/${input.targetId}`,
      status: (input.settings.enabled ? "scheduled" : "paused") as OccurrenceStatus,
      offsetDays,
      reminderNumber: index + 1,
      reminderCount: input.settings.offsets.length,
      dueAtIso: reminderDueAtIso({
        triggerSentAtIso: input.triggerSentAtIso,
        offsetDays,
        timezone: input.settings.timezone,
        sendTime: input.settings.sendTime,
        sendOnWeekends: input.settings.sendOnWeekends,
      }),
      secondMailVersion: input.secondMailVersion,
      settingsVersion: input.settingsVersion,
      settingsHash: input.settingsHash,
      attemptCount: 0,
      createdAtIso: input.nowIso,
      updatedAtIso: input.nowIso,
    };
  });
}

async function processSecondRequestJob(job: Record<string, unknown>, input: {
  nowIso: string;
  forceSend?: boolean;
  actor?: AuthContext;
}) {
  const id = asString(job.id);
  const ref = adminDb.collection(VIDEO_REMINDER_SECOND_MAIL_JOBS_COLLECTION).doc(id);
  const leaseToken = randomUUID();
  const claimed = await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.data() ?? {};
    const status = asString(current.status);
    const leaseExpiry = Date.parse(asString(current.processingLeaseExpiresAtIso));
    const claimable = ["queued", "retry", "awaiting_approval", "waiting_configuration"].includes(status)
      || (status === "processing" && Number.isFinite(leaseExpiry) && leaseExpiry <= Date.parse(input.nowIso));
    if (!snapshot.exists || !claimable) return null;
    transaction.set(ref, {
      status: "processing",
      processingLeaseToken: leaseToken,
      processingLeaseExpiresAtIso: new Date(Date.parse(input.nowIso) + LEASE_MS).toISOString(),
      attemptCount: FieldValue.increment(1),
      updatedAtIso: input.nowIso,
    }, { merge: true });
    return { id: snapshot.id, ...current } as Record<string, unknown>;
  });
  if (!claimed) return { id, outcome: "not_claimed" };
  const settingsEnvelope = await readSettings(canonicalProgramId(claimed.canonicalProgramId ?? claimed.programId));
  const submission = await findMatchingSubmission({
    programId: canonicalProgramId(claimed.canonicalProgramId ?? claimed.programId),
    token: asString(claimed.token),
    uid: asString(claimed.uid),
    creatorId: asString(claimed.creatorId),
    email: asString(claimed.email),
    normalizedEmailHash: asString(claimed.normalizedEmailHash),
  });
  if (submission) {
    await ref.set({
      status: "completed_submission_preexisting",
      matchedSubmissionRef: submission.ref,
      completedAtIso: input.nowIso,
      processingLeaseToken: FieldValue.delete(),
      processingLeaseExpiresAtIso: FieldValue.delete(),
      updatedAtIso: input.nowIso,
    }, { merge: true });
    return { id, outcome: "submission_preexisting" };
  }
  let formLink = asString(claimed.formLink, settingsEnvelope.settings.submissionFormUrl);
  if (!formLink && asString(claimed.leadId)) {
    const leadSnapshot = await adminDb.collection("program_sheet_leads").doc(asString(claimed.leadId)).get();
    formLink = asString(leadSnapshot.data()?.formLink);
    if (formLink) {
      await ref.set({ formLink, updatedAtIso: input.nowIso }, { merge: true });
      claimed.formLink = formLink;
    }
  }
  if (!formLink) {
    await ref.set({
      status: "waiting_configuration",
      blockedReason: "submission_form_url_missing",
      processingLeaseToken: FieldValue.delete(),
      processingLeaseExpiresAtIso: FieldValue.delete(),
      updatedAtIso: input.nowIso,
    }, { merge: true });
    return { id, outcome: "waiting_configuration" };
  }
  const payload = mailPayloadForJob(claimed, formLink);
  // The gem-paid submission request is the second operational mail itself, not a
  // reminder draft. Once gem payment has been confirmed it must enter the real
  // provider path regardless of the later reminder approval mode.
  const result = await sendApprovedMail(payload, input.actor);
  const resultRef = asString(result.resultRef);
  let providerConfirmed = false;
  if (resultRef) {
    const resultSnapshot = await adminDb.doc(resultRef).get();
    providerConfirmed = isStrictScpProviderConfirmed(resultSnapshot.data());
  }
  const nextStatus = providerConfirmed
    ? "sent"
    : (result.blocked === true || asString(result.status) === "blocked" ? "blocked" : "retry");
  await ref.set({
    status: nextStatus,
    resultRef: resultRef || null,
    draftCreatedAtIso: FieldValue.delete(),
    sentAtIso: providerConfirmed ? input.nowIso : FieldValue.delete(),
    blockedReason: nextStatus === "blocked" ? asString(result.status, "mail_blocked") : FieldValue.delete(),
    processingLeaseToken: FieldValue.delete(),
    processingLeaseExpiresAtIso: FieldValue.delete(),
    updatedAtIso: input.nowIso,
  }, { merge: true });
  if (providerConfirmed && asString(claimed.grantId)) {
    await adminDb.collection("gem_grants").doc(asString(claimed.grantId)).set({
      submissionRequestMailState: "sent",
      submissionRequestMailResultRef: resultRef,
      submissionRequestSentAtIso: input.nowIso,
      updatedAtIso: input.nowIso,
    }, { merge: true });
  }
  return { id, outcome: nextStatus, resultRef };
}

// T2-2 실측: where 없는 orderBy(documentId).limit(<=200) 은 이 컬렉션의 대부분을 차지하는 종결
// 상태(sent/processed/completed_submission_preexisting 등)까지 매번 읽어 왔다 — 2 레인 × 1,440틱/일
// 대부분이 버려지는 읽기였다. status(+lease 만료 재수거용 "processing")를 in 필터로 쿼리에 내려
// 후보만 읽는다. 이 in 필터 + orderBy(documentId()) 조합은 이 파일의 listActiveTargetsForSettings
// (canonicalProgramId=="..." + orderBy(documentId()))와 같은 형상이라 복합 색인이 새로 필요 없다
// (단일 필드 자동 색인 + __name__ tie-break 로 충분 — in 은 색인 요건이 ==과 같다).
//
// nextAttemptAtIso 는 재시도 백오프에서만 세팅된다(scpVideoSubmissionReminderStore.ts 의 최초 큐잉
// 코드에는 이 필드가 없다). Firestore 는 orderBy/부등호로 건 필드가 없는 문서를 결과에서 통째로
// 제외하므로, 이 필드를 where/orderBy 로 내리면 attemptCount=0 인 신규 문서가 조회에서 아예 빠진다
// (발송 자체가 멈추는 회귀) — 그래서 이 필드는 계속 status 로 이미 좁혀진 결과 위에서만 메모리로
// 판정한다.
export async function listCandidateDocs(collection: string, statuses: readonly string[], limit: number, nowIso: string) {
  const scanLimit = Math.min(limit * 4, 200);
  const cursorRef = adminDb.collection(VIDEO_REMINDER_RUNTIME_COLLECTION).doc(safeDocId(`cursor:${collection}`));
  const cursorSnapshot = await cursorRef.get();
  const cursorDocumentId = asString(cursorSnapshot.data()?.cursorDocumentId);
  const candidateStatuses = [...new Set([...statuses, "processing"])];
  const baseQuery = () => adminDb.collection(collection)
    .where("status", "in", candidateStatuses)
    .orderBy(FieldPath.documentId())
    .limit(scanLimit);
  let query: FirebaseFirestore.Query = baseQuery();
  if (cursorDocumentId) query = query.startAfter(cursorDocumentId);
  let snapshot = await query.get();
  let wrapped = false;
  if (snapshot.empty && cursorDocumentId) {
    snapshot = await baseQuery().get();
    wrapped = true;
  }
  const lastDocumentId = snapshot.docs.at(-1)?.id ?? "";
  await cursorRef.set({
    collection,
    cursorDocumentId: lastDocumentId || FieldValue.delete(),
    wrapped,
    scannedCount: snapshot.size,
    updatedAtIso: nowIso,
  }, { merge: true });
  return snapshot.docs
    .map(snapshotRow)
    .filter((row) => {
      const status = asString(row.status);
      if (statuses.includes(status)) return true;
      const leaseExpiry = Date.parse(asString(row.processingLeaseExpiresAtIso));
      return status === "processing" && Number.isFinite(leaseExpiry) && leaseExpiry <= Date.parse(nowIso);
    })
    .filter((row) => {
      const nextAttemptAt = Date.parse(asString(row.nextAttemptAtIso));
      return !Number.isFinite(nextAttemptAt) || nextAttemptAt <= Date.parse(nowIso);
    })
    .slice(0, limit);
}

async function processSecondRequestJobs(nowIso: string, limit: number) {
  const jobs = await listCandidateDocs(
    VIDEO_REMINDER_SECOND_MAIL_JOBS_COLLECTION,
    ["queued", "retry", "awaiting_approval", "waiting_configuration"],
    limit,
    nowIso,
  );
  const rows = [];
  for (const job of jobs) {
    try {
      rows.push(await processSecondRequestJob(job, { nowIso }));
    } catch (error) {
      const ref = adminDb.collection(VIDEO_REMINDER_SECOND_MAIL_JOBS_COLLECTION).doc(asString(job.id));
      const attemptCount = Math.max(1, Number(job.attemptCount ?? 0) + 1);
      await ref.set({
        status: attemptCount >= MAX_ATTEMPTS ? "failed" : "retry",
        lastErrorCode: asString((error as { code?: unknown } | null)?.code, "internal"),
        nextAttemptAtIso: new Date(Date.parse(nowIso) + Math.min(60, 2 ** attemptCount) * 60_000).toISOString(),
        processingLeaseToken: FieldValue.delete(),
        processingLeaseExpiresAtIso: FieldValue.delete(),
        updatedAtIso: nowIso,
      }, { merge: true });
      rows.push({ id: asString(job.id), outcome: attemptCount >= MAX_ATTEMPTS ? "failed" : "retry" });
    }
  }
  return rows;
}

async function processReminderTrigger(trigger: Record<string, unknown>, nowIso: string) {
  const id = asString(trigger.id);
  const triggerRef = adminDb.collection(VIDEO_REMINDER_TRIGGER_COLLECTION).doc(id);
  const leaseToken = randomUUID();
  const claimed = await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(triggerRef);
    const current = snapshot.data() ?? {};
    const status = asString(current.status);
    const leaseExpiry = Date.parse(asString(current.processingLeaseExpiresAtIso));
    const claimable = ["queued", "retry"].includes(status)
      || (status === "processing" && Number.isFinite(leaseExpiry) && leaseExpiry <= Date.parse(nowIso));
    if (!snapshot.exists || !claimable) return null;
    transaction.set(triggerRef, {
      status: "processing",
      processingLeaseToken: leaseToken,
      processingLeaseExpiresAtIso: new Date(Date.parse(nowIso) + LEASE_MS).toISOString(),
      attemptCount: FieldValue.increment(1),
      updatedAtIso: nowIso,
    }, { merge: true });
    return { id: snapshot.id, ...current } as Record<string, unknown>;
  });
  if (!claimed) return { id, outcome: "not_claimed" };
  trigger = claimed;
  const resultRef = asString(trigger.resultRef);
  const resultSnapshot = resultRef ? await adminDb.doc(resultRef).get() : null;
  if (!resultSnapshot || !isStrictScpProviderConfirmed(resultSnapshot.data())) {
    await triggerRef.set({
      status: "blocked",
      blockedReason: "strict_provider_result_missing",
      processingLeaseToken: FieldValue.delete(),
      processingLeaseExpiresAtIso: FieldValue.delete(),
      updatedAtIso: nowIso,
    }, { merge: true });
    return { id, outcome: "blocked" };
  }
  const programId = canonicalProgramId(trigger.canonicalProgramId ?? trigger.programId);
  const settingsEnvelope = await readSettings(programId);
  const submission = await findMatchingSubmission({
    programId,
    token: asString(trigger.token),
    uid: asString(trigger.uid),
    creatorId: asString(trigger.creatorId),
    email: asString(trigger.email),
    normalizedEmailHash: asString(trigger.normalizedEmailHash),
  });
  const identityKey = asString(
    trigger.token,
    asString(trigger.uid, asString(trigger.creatorId, asString(trigger.leadId, asString(trigger.normalizedEmailHash, id)))),
  );
  const targetId = reminderTargetId({
    programId,
    identityKey,
    triggerMailResultRef: resultRef,
  });
  const targetRef = adminDb.collection(VIDEO_REMINDER_TARGET_COLLECTION).doc(targetId);
  const secondMailVersion = Math.max(1, Number(trigger.secondMailVersion ?? 1));
  const triggerSentAtIso = asString(trigger.triggerSentAtIso, asString(resultSnapshot?.data()?.sentAtIso));
  const occurrences = occurrenceRowsForTarget({
    targetId,
    triggerSentAtIso,
    secondMailVersion,
    settings: settingsEnvelope.settings,
    settingsVersion: settingsEnvelope.version,
    settingsHash: settingsEnvelope.hash,
    nowIso,
  });
  const nextDueAtIso = occurrences[0]?.dueAtIso ?? "";
  const status: TargetStatus = submission
    ? "closed"
    : !settingsEnvelope.settings.enabled || occurrences.length === 0
      ? "paused"
      : occurrenceStatusForDue(nextDueAtIso, nowIso);
  const batch = adminDb.batch();
  batch.set(targetRef, {
    id: targetId,
    status,
    programId,
    canonicalProgramId: programId,
    leadId: asString(trigger.leadId) || null,
    creatorId: asString(trigger.creatorId) || null,
    creatorName: asString(trigger.creatorName) || null,
    campaignId: asString(trigger.campaignId) || null,
    formLink: asString(trigger.formLink, asString(resultSnapshot?.data()?.formLink, settingsEnvelope.settings.submissionFormUrl)) || null,
    email: normalizedReminderEmail(trigger.email) || null,
    normalizedEmailHash: asString(trigger.normalizedEmailHash, normalizedReminderEmailHash(trigger.email)) || null,
    token: asString(trigger.token) || null,
    uid: asString(trigger.uid) || null,
    gemGrantRef: asString(trigger.gemGrantRef) || null,
    triggerMailResultRef: resultRef,
    triggerSentAtIso,
    secondMailVersion,
    offsetsSnapshot: settingsEnvelope.settings.offsets,
    settingsSnapshot: settingsEnvelope.settings,
    settingsVersion: settingsEnvelope.version,
    settingsHash: settingsEnvelope.hash,
    nextDueAtIso: nextDueAtIso || null,
    nextOccurrenceId: occurrences[0]?.id ?? null,
    pauseReason: status === "paused" ? (!settingsEnvelope.settings.enabled ? "automation_disabled" : "schedule_empty") : FieldValue.delete(),
    closeReason: submission ? "submission_completed" : FieldValue.delete(),
    matchedSubmissionRef: submission?.ref ?? FieldValue.delete(),
    completedAtIso: submission ? nowIso : FieldValue.delete(),
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
  }, { merge: true });
  if (!submission) {
    for (const occurrence of occurrences) {
      batch.set(adminDb.collection(VIDEO_REMINDER_OCCURRENCE_COLLECTION).doc(occurrence.id), occurrence, { merge: true });
    }
  }
  batch.set(triggerRef, {
    status: "processed",
    targetRef: targetRef.path,
    processedAtIso: nowIso,
    processingLeaseToken: FieldValue.delete(),
    processingLeaseExpiresAtIso: FieldValue.delete(),
    updatedAtIso: nowIso,
  }, { merge: true });
  addEvent(batch, {
    targetId,
    action: submission ? "target.closed_submission_preexisting" : "target.created",
    reason: submission?.matchBasis,
    nowIso,
    actorUid: SYSTEM_ACTOR.userId,
    details: { triggerRef: triggerRef.path, occurrenceCount: occurrences.length },
  });
  await batch.commit();
  return { id, outcome: status, targetId, occurrenceCount: occurrences.length };
}

async function processReminderTriggers(nowIso: string, limit: number) {
  const triggers = await listCandidateDocs(VIDEO_REMINDER_TRIGGER_COLLECTION, ["queued", "retry"], limit, nowIso);
  const rows = [];
  for (const trigger of triggers) {
    try {
      rows.push(await processReminderTrigger(trigger, nowIso));
    } catch (error) {
      const attemptCount = Math.max(1, Number(trigger.attemptCount ?? 0) + 1);
      await adminDb.collection(VIDEO_REMINDER_TRIGGER_COLLECTION).doc(asString(trigger.id)).set({
        status: attemptCount >= MAX_ATTEMPTS ? "failed" : "retry",
        attemptCount,
        lastErrorCode: asString((error as { code?: unknown } | null)?.code, "internal"),
        nextAttemptAtIso: attemptCount >= MAX_ATTEMPTS
          ? FieldValue.delete()
          : new Date(Date.parse(nowIso) + Math.min(60, 2 ** attemptCount) * 60_000).toISOString(),
        processingLeaseToken: FieldValue.delete(),
        processingLeaseExpiresAtIso: FieldValue.delete(),
        updatedAtIso: nowIso,
      }, { merge: true });
      rows.push({ id: asString(trigger.id), outcome: attemptCount >= MAX_ATTEMPTS ? "failed" : "retry" });
    }
  }
  return rows;
}

async function closeTargetForSubmission(target: Record<string, unknown>, submission: { ref: string; matchBasis: string }, nowIso: string) {
  const targetId = asString(target.id);
  const occurrences = await adminDb.collection(VIDEO_REMINDER_OCCURRENCE_COLLECTION).where("targetId", "==", targetId).get();
  const batch = adminDb.batch();
  batch.set(adminDb.collection(VIDEO_REMINDER_TARGET_COLLECTION).doc(targetId), {
      status: "closed",
      closeReason: "submission_completed",
      matchedSubmissionRef: submission.ref,
      completedAtIso: nowIso,
      nextDueAtIso: FieldValue.delete(),
      nextOccurrenceId: FieldValue.delete(),
    updatedAtIso: nowIso,
  }, { merge: true });
  for (const doc of occurrences.docs) {
    const status = asString(doc.data().status);
    if (["sent", "skipped", "superseded", "cancelled"].includes(status)) continue;
    batch.set(doc.ref, { status: "cancelled", cancelReason: "submission_completed", updatedAtIso: nowIso }, { merge: true });
  }
  addEvent(batch, {
    targetId,
    action: "target.closed_submission_completed",
    reason: submission.matchBasis,
    nowIso,
    actorUid: SYSTEM_ACTOR.userId,
  });
  await batch.commit();
}

async function advanceTargetAfterOccurrence(target: Record<string, unknown>, occurrence: Record<string, unknown>, nowIso: string) {
  const targetId = asString(target.id);
  const snapshot = await adminDb.collection(VIDEO_REMINDER_OCCURRENCE_COLLECTION).where("targetId", "==", targetId).get();
  const future = snapshot.docs
    .map(snapshotRow)
    .filter((row) => asString(row.status) === "scheduled")
    .sort((left, right) => Date.parse(asString(left.dueAtIso)) - Date.parse(asString(right.dueAtIso)));
  const next = future[0];
  const patch = next
    ? {
      status: occurrenceStatusForDue(asString(next.dueAtIso), nowIso),
      nextDueAtIso: asString(next.dueAtIso),
      nextOccurrenceId: asString(next.id),
      closeReason: FieldValue.delete(),
      }
    : {
      status: "closed",
      nextDueAtIso: FieldValue.delete(),
      nextOccurrenceId: FieldValue.delete(),
      closeReason: "schedule_exhausted_unsubmitted",
        completedAtIso: nowIso,
      };
  await adminDb.collection(VIDEO_REMINDER_TARGET_COLLECTION).doc(targetId).set({
    ...patch,
    lastReminderAtIso: asString(occurrence.sentAtIso, nowIso),
    lastReminderOffsetDays: Number(occurrence.offsetDays ?? 0),
    updatedAtIso: nowIso,
  }, { merge: true });
}

async function processOccurrence(occurrence: Record<string, unknown>, input: {
  nowIso: string;
  forceSend?: boolean;
  actor?: AuthContext;
}) {
  const id = asString(occurrence.id);
  const occurrenceRef = adminDb.collection(VIDEO_REMINDER_OCCURRENCE_COLLECTION).doc(id);
  const targetId = asString(occurrence.targetId);
  const targetRef = adminDb.collection(VIDEO_REMINDER_TARGET_COLLECTION).doc(targetId);
  const leaseToken = randomUUID();
  const claim = await adminDb.runTransaction(async (transaction) => {
    const [occurrenceSnapshot, targetSnapshot] = await Promise.all([
      transaction.get(occurrenceRef),
      transaction.get(targetRef),
    ]);
    const currentOccurrence = occurrenceSnapshot.data() ?? {};
    const target = targetSnapshot.data() ?? {};
    const status = asString(currentOccurrence.status);
    const leaseExpiry = Date.parse(asString(currentOccurrence.processingLeaseExpiresAtIso));
    const claimable = ["scheduled", "awaiting_approval"].includes(status)
      || (status === "processing" && Number.isFinite(leaseExpiry) && leaseExpiry <= Date.parse(input.nowIso));
    if (!occurrenceSnapshot.exists || !targetSnapshot.exists || !claimable) return null;
    if (["paused", "closed"].includes(asString(target.status))) return null;
    transaction.set(occurrenceRef, {
      status: "processing",
      processingLeaseToken: leaseToken,
      processingLeaseExpiresAtIso: new Date(Date.parse(input.nowIso) + LEASE_MS).toISOString(),
      attemptCount: FieldValue.increment(1),
      updatedAtIso: input.nowIso,
    }, { merge: true });
    return {
      occurrence: { id: occurrenceSnapshot.id, ...currentOccurrence } as Record<string, unknown>,
      target: { id: targetSnapshot.id, ...target } as Record<string, unknown>,
    };
  });
  if (!claim) return { id, outcome: "not_claimed" };
  const { target } = claim;
  const submission = await findMatchingSubmission({
    programId: canonicalProgramId(target.canonicalProgramId ?? target.programId),
    token: asString(target.token),
    uid: asString(target.uid),
    creatorId: asString(target.creatorId),
    email: asString(target.email),
    normalizedEmailHash: asString(target.normalizedEmailHash),
  });
  if (submission) {
    await closeTargetForSubmission(target, submission, input.nowIso);
    return { id, outcome: "submission_completed" };
  }
  const suppressionReason = await targetSuppressionReason(target);
  const replied = await targetReplyAfterBaseline(target);
  if (suppressionReason || replied) {
    const reason = suppressionReason || "creator_replied";
    const shouldPause = replied || suppressionShouldPause(target, reason);
    const targetOccurrences = await adminDb.collection(VIDEO_REMINDER_OCCURRENCE_COLLECTION)
      .where("targetId", "==", targetId)
      .get();
    const batch = adminDb.batch();
    for (const occurrenceSnapshot of targetOccurrences.docs) {
      if (!isActiveOccurrenceStatus(occurrenceSnapshot.data().status)) continue;
      batch.set(occurrenceSnapshot.ref, {
        status: shouldPause ? "paused" : "cancelled",
        cancelReason: shouldPause ? FieldValue.delete() : reason,
        processingLeaseToken: FieldValue.delete(),
        processingLeaseExpiresAtIso: FieldValue.delete(),
        updatedAtIso: input.nowIso,
      }, { merge: true });
    }
    batch.set(targetRef, {
      status: shouldPause ? "paused" : "closed",
      pauseReason: shouldPause ? reason : FieldValue.delete(),
      closeReason: shouldPause ? FieldValue.delete() : `mail_suppressed:${reason}`,
      pausedAtIso: shouldPause ? input.nowIso : FieldValue.delete(),
      completedAtIso: shouldPause ? FieldValue.delete() : input.nowIso,
      nextDueAtIso: shouldPause ? asString(target.nextDueAtIso) : FieldValue.delete(),
      nextOccurrenceId: shouldPause ? asString(target.nextOccurrenceId) : FieldValue.delete(),
      updatedAtIso: input.nowIso,
    }, { merge: true });
    addEvent(batch, {
      targetId,
      occurrenceId: id,
      action: shouldPause ? "target.paused" : "target.closed_mail_suppressed",
      reason,
      nowIso: input.nowIso,
      actorUid: SYSTEM_ACTOR.userId,
    });
    await batch.commit();
    return { id, outcome: shouldPause ? "paused" : "closed", reason };
  }
  const lastReminderAt = Date.parse(asString(target.lastReminderAtIso));
  if (Number.isFinite(lastReminderAt) && Date.parse(input.nowIso) - lastReminderAt < MIN_SEND_INTERVAL_MS) {
    await occurrenceRef.set({
      status: "scheduled",
      dueAtIso: new Date(lastReminderAt + MIN_SEND_INTERVAL_MS).toISOString(),
      deferredReason: "minimum_send_interval",
      processingLeaseToken: FieldValue.delete(),
      processingLeaseExpiresAtIso: FieldValue.delete(),
      updatedAtIso: input.nowIso,
    }, { merge: true });
    return { id, outcome: "deferred" };
  }
  const settings = normalizeReminderSettings(target.settingsSnapshot);
  const shouldSend = input.forceSend === true || settings.deliveryMode === "auto_send";
  const payload = mailPayloadForOccurrence(claim.occurrence, target, settings);
  if (!shouldSend) {
    const draft = await persistDraft(payload, input.actor);
    await occurrenceRef.set({
      status: "awaiting_approval",
      draftResultRef: asString(draft.resultRef) || null,
      processingLeaseToken: FieldValue.delete(),
      processingLeaseExpiresAtIso: FieldValue.delete(),
      updatedAtIso: input.nowIso,
    }, { merge: true });
    return { id, outcome: "awaiting_approval", resultRef: asString(draft.resultRef) };
  }
  // Keep this explicit ordering: the submission truth is checked above immediately
  // before any provider preview/apply, closing the submit-vs-send race window.
  const finalSubmission = await findMatchingSubmission({
    programId: canonicalProgramId(target.canonicalProgramId ?? target.programId),
    token: asString(target.token),
    uid: asString(target.uid),
    creatorId: asString(target.creatorId),
    email: asString(target.email),
    normalizedEmailHash: asString(target.normalizedEmailHash),
  });
  if (finalSubmission) {
    await closeTargetForSubmission(target, finalSubmission, input.nowIso);
    return { id, outcome: "submission_completed_before_send" };
  }
  const finalTargetSnapshot = await targetRef.get();
  const finalTargetStatus = asString(finalTargetSnapshot.data()?.status);
  if (["paused", "closed"].includes(finalTargetStatus)) {
    await occurrenceRef.set({
      status: finalTargetStatus === "paused" ? "paused" : "cancelled",
      cancelReason: finalTargetStatus === "closed" ? "target_closed_before_send" : FieldValue.delete(),
      processingLeaseToken: FieldValue.delete(),
      processingLeaseExpiresAtIso: FieldValue.delete(),
      updatedAtIso: input.nowIso,
    }, { merge: true });
    return { id, outcome: `target_${finalTargetStatus}` };
  }
  const result = await sendReminderMail(payload, input.actor);
  const resultRef = asString(result.resultRef);
  const resultSnapshot = resultRef ? await adminDb.doc(resultRef).get() : null;
  const providerConfirmed = Boolean(resultSnapshot && isStrictScpProviderConfirmed(resultSnapshot.data()));
  if (!providerConfirmed) {
    const attemptCount = Math.max(1, Number(claim.occurrence.attemptCount ?? 0) + 1);
    await occurrenceRef.set({
      status: attemptCount >= MAX_ATTEMPTS ? "failed" : "scheduled",
      resultRef: resultRef || null,
      lastFailureCode: asString(result.status, "provider_unconfirmed"),
      dueAtIso: attemptCount >= MAX_ATTEMPTS
        ? asString(claim.occurrence.dueAtIso)
        : new Date(Date.parse(input.nowIso) + Math.min(60, 2 ** attemptCount) * 60_000).toISOString(),
      processingLeaseToken: FieldValue.delete(),
      processingLeaseExpiresAtIso: FieldValue.delete(),
      updatedAtIso: input.nowIso,
    }, { merge: true });
    return { id, outcome: attemptCount >= MAX_ATTEMPTS ? "failed" : "retry", resultRef };
  }
  const batch = adminDb.batch();
  batch.set(occurrenceRef, {
    status: "sent",
    resultRef,
    sentAtIso: input.nowIso,
    providerConfirmed: true,
    processingLeaseToken: FieldValue.delete(),
    processingLeaseExpiresAtIso: FieldValue.delete(),
    updatedAtIso: input.nowIso,
  }, { merge: true });
  addEvent(batch, {
    targetId,
    occurrenceId: id,
    action: "occurrence.sent",
    nowIso: input.nowIso,
    actorUid: input.actor?.userId ?? SYSTEM_ACTOR.userId,
    details: { offsetDays: Number(claim.occurrence.offsetDays ?? 0), resultRef },
  });
  await batch.commit();
  await advanceTargetAfterOccurrence(target, { ...claim.occurrence, sentAtIso: input.nowIso }, input.nowIso);
  return { id, outcome: "sent", resultRef };
}

export async function sendReminderMail(payload: Record<string, unknown>, actor?: AuthContext) {
  return sendApprovedMail(payload, actor);
}

async function processDueOccurrences(nowIso: string, limit: number) {
  const scanLimit = Math.min(limit * 4, 200);
  const cursorRef = adminDb.collection(VIDEO_REMINDER_RUNTIME_COLLECTION).doc("cursor-occurrences-due");
  const cursorSnapshot = await cursorRef.get();
  const cursorDueAtIso = asString(cursorSnapshot.data()?.cursorDueAtIso);
  const cursorDocumentId = asString(cursorSnapshot.data()?.cursorDocumentId);
  const baseQuery = () => adminDb.collection(VIDEO_REMINDER_OCCURRENCE_COLLECTION)
    .where("status", "==", "scheduled")
    .where("dueAtIso", "<=", nowIso)
    .orderBy("dueAtIso", "asc")
    .orderBy(FieldPath.documentId(), "asc")
    .limit(scanLimit);
  let query: FirebaseFirestore.Query = baseQuery();
  if (cursorDueAtIso && cursorDocumentId) query = query.startAfter(cursorDueAtIso, cursorDocumentId);
  let snapshot = await query.get();
  let wrapped = false;
  if (snapshot.empty && cursorDueAtIso && cursorDocumentId) {
    snapshot = await baseQuery().get();
    wrapped = true;
  }
  const lastScheduled = snapshot.docs.at(-1);
  await cursorRef.set({
    cursorDueAtIso: lastScheduled ? asString(lastScheduled.data().dueAtIso) : FieldValue.delete(),
    cursorDocumentId: lastScheduled?.id ?? FieldValue.delete(),
    wrapped,
    scannedCount: snapshot.size,
    updatedAtIso: nowIso,
  }, { merge: true });

  const expiredProcessing = await adminDb.collection(VIDEO_REMINDER_OCCURRENCE_COLLECTION)
    .where("status", "==", "processing")
    .where("processingLeaseExpiresAtIso", "<=", nowIso)
    .orderBy("processingLeaseExpiresAtIso", "asc")
    .orderBy(FieldPath.documentId(), "asc")
    .limit(scanLimit)
    .get();
  const groups = new Map<string, ReminderOccurrenceLike[]>();
  const byId = new Map<string, Record<string, unknown>>();
  for (const doc of [...snapshot.docs, ...expiredProcessing.docs]) {
    const row = { id: doc.id, ...doc.data() } as ReminderOccurrenceLike & Record<string, unknown>;
    if (byId.has(row.id)) continue;
    byId.set(row.id, row);
    const targetId = asString(row.targetId);
    const current = groups.get(targetId) ?? [];
    current.push(asString(row.status) === "processing" ? { ...row, status: "scheduled" } : row);
    groups.set(targetId, current);
  }
  const selectedRows: Array<Record<string, unknown>> = [];
  for (const rows of groups.values()) {
    const selection = selectLatestDueOccurrence(rows, nowIso);
    if (selection.superseded.length > 0) {
      const batch = adminDb.batch();
      for (const superseded of selection.superseded) {
        batch.set(adminDb.collection(VIDEO_REMINDER_OCCURRENCE_COLLECTION).doc(superseded.id), {
          status: "superseded",
          supersededByOccurrenceId: selection.selected?.id ?? null,
          supersededAtIso: nowIso,
          updatedAtIso: nowIso,
        }, { merge: true });
      }
      await batch.commit();
    }
    if (selection.selected) selectedRows.push(byId.get(selection.selected.id) ?? selection.selected as unknown as Record<string, unknown>);
    if (selectedRows.length >= limit) break;
  }
  const results = [];
  for (const occurrence of selectedRows) {
    try {
      results.push(await processOccurrence(occurrence, { nowIso }));
    } catch (error) {
      const attemptCount = Math.max(1, Number(occurrence.attemptCount ?? 0) + 1);
      await adminDb.collection(VIDEO_REMINDER_OCCURRENCE_COLLECTION).doc(asString(occurrence.id)).set({
        status: attemptCount >= MAX_ATTEMPTS ? "failed" : "scheduled",
        attemptCount,
        lastFailureCode: asString((error as { code?: unknown } | null)?.code, "internal"),
        dueAtIso: attemptCount >= MAX_ATTEMPTS
          ? asString(occurrence.dueAtIso)
          : new Date(Date.parse(nowIso) + Math.min(60, 2 ** attemptCount) * 60_000).toISOString(),
        processingLeaseToken: FieldValue.delete(),
        processingLeaseExpiresAtIso: FieldValue.delete(),
        updatedAtIso: nowIso,
      }, { merge: true });
      results.push({ id: asString(occurrence.id), outcome: attemptCount >= MAX_ATTEMPTS ? "failed" : "retry" });
    }
  }
  return results;
}

export async function processVideoSubmissionRemindersCore(options: ProcessOptions = {}) {
  const nowIso = nowOr(options.nowIso);
  const limit = boundedLimit(options.limit, 25, MAX_DRAIN_ROWS);
  const secondRequests = options.processSecondRequests === false ? [] : await processSecondRequestJobs(nowIso, limit);
  const triggers = options.processTriggers === false ? [] : await processReminderTriggers(nowIso, limit);
  const occurrences = options.processOccurrences === false ? [] : await processDueOccurrences(nowIso, limit);
  return {
    ok: true,
    nowIso,
    counts: {
      secondRequests: secondRequests.length,
      triggers: triggers.length,
      occurrences: occurrences.length,
    },
    secondRequests,
    triggers,
    occurrences,
  };
}

export async function processVideoSubmissionReminders(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_video_reminders.process", WRITE_ROLES);
  await assertScpEntitled(auth, request, "scp_video_reminders.process");
  const data = asRecord(request.data);
  const result = await processVideoSubmissionRemindersCore({
    limit: data.limit,
    processSecondRequests: data.processSecondRequests !== false,
    processTriggers: data.processTriggers !== false,
    processOccurrences: data.processOccurrences !== false,
  });
  return { ...result, behaviorLog: makeBehaviorLog(auth, "scp_video_reminders.process", "success") };
}

export async function getVideoSubmissionReminderSettings(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_video_reminders.settings.get", READ_ROLES);
  await assertScpEntitled(auth, request, "scp_video_reminders.settings.get");
  const data = asRecord(request.data);
  const programId = canonicalProgramId(data.programId);
  const envelope = await readSettings(programId);
  const defaultsSnapshot = await adminDb.doc("settings/scp_video_submission_reminder_defaults").get();
  const suggestedOffsets = Array.isArray(defaultsSnapshot.data()?.suggestedOffsets)
    ? defaultsSnapshot.data()?.suggestedOffsets
    : [];
  return {
    ok: true,
    programId,
    ...envelope,
    suggestedOffsets,
    behaviorLog: makeBehaviorLog(auth, "scp_video_reminders.settings.get", "success"),
  };
}

async function listActiveTargetsForSettings(programId: string) {
  const active: Record<string, unknown>[] = [];
  let cursorDocumentId = "";
  while (active.length <= MAX_ACTIVE_SETTINGS_TARGETS) {
    let query: FirebaseFirestore.Query = adminDb.collection(VIDEO_REMINDER_TARGET_COLLECTION)
      .where("canonicalProgramId", "==", programId)
      .orderBy(FieldPath.documentId())
      .limit(200);
    if (cursorDocumentId) query = query.startAfter(cursorDocumentId);
    const snapshot = await query.get();
    for (const doc of snapshot.docs) {
      const row = snapshotRow(doc);
      if (["due", "upcoming", "paused"].includes(asString(row.status))) active.push(row);
      if (active.length > MAX_ACTIVE_SETTINGS_TARGETS) break;
    }
    cursorDocumentId = snapshot.docs.at(-1)?.id ?? "";
    if (active.length > MAX_ACTIVE_SETTINGS_TARGETS || snapshot.size < 200) break;
  }
  return {
    rows: active.slice(0, MAX_ACTIVE_SETTINGS_TARGETS),
    truncated: active.length > MAX_ACTIVE_SETTINGS_TARGETS,
  };
}

async function previewSettingsImpact(programId: string, next: VideoReminderSettings, nowIso: string) {
  const active = await listActiveTargetsForSettings(programId);
  const changes = [];
  for (const target of active.rows) {
    const occurrences = await adminDb.collection(VIDEO_REMINDER_OCCURRENCE_COLLECTION).where("targetId", "==", asString(target.id)).get();
    const rows = occurrences.docs.map(snapshotRow);
    const sentOffsets = rows.filter((row) => asString(row.status) === "sent").map((row) => Number(row.offsetDays));
    const diff = reconcileReminderOffsets({
      previousOffsets: target.offsetsSnapshot,
      nextOffsets: next.offsets,
      sentOffsets,
      triggerSentAtIso: asString(target.triggerSentAtIso),
      nowIso,
      settings: next,
    });
    const reschedule = rows
      .filter((row) => isActiveOccurrenceStatus(row.status) && next.offsets.includes(Number(row.offsetDays)))
      .map((row) => ({
        occurrenceId: asString(row.id),
        offsetDays: Number(row.offsetDays),
        previousDueAtIso: asString(row.dueAtIso),
        nextDueAtIso: reminderDueAtIso({
          triggerSentAtIso: asString(target.triggerSentAtIso),
          offsetDays: Number(row.offsetDays),
          timezone: next.timezone,
          sendTime: next.sendTime,
          sendOnWeekends: next.sendOnWeekends,
        }),
      }));
    changes.push({ targetId: asString(target.id), ...diff, reschedule });
  }
  return { changes, truncated: active.truncated };
}

async function refreshTargetScheduleAfterSettings(
  target: Record<string, unknown>,
  settings: VideoReminderSettings,
  nowIso: string,
) {
  const targetId = asString(target.id);
  const occurrenceSnapshot = await adminDb.collection(VIDEO_REMINDER_OCCURRENCE_COLLECTION)
    .where("targetId", "==", targetId)
    .get();
  const next = occurrenceSnapshot.docs
    .map(snapshotRow)
    .filter((row) => isActiveOccurrenceStatus(row.status))
    .sort((left, right) => Date.parse(asString(left.dueAtIso)) - Date.parse(asString(right.dueAtIso)))[0];
  const currentPauseReason = asString(target.pauseReason);
  const operatorPause = asString(target.status) === "paused"
    && currentPauseReason
    && !["automation_disabled", "schedule_empty"].includes(currentPauseReason);
  const patch = !next
    ? {
      status: "closed",
      closeReason: "schedule_exhausted_unsubmitted",
      completedAtIso: nowIso,
      nextDueAtIso: FieldValue.delete(),
      nextOccurrenceId: FieldValue.delete(),
      pauseReason: FieldValue.delete(),
    }
    : !settings.enabled
      ? {
        status: "paused",
        pauseReason: "automation_disabled",
        closeReason: FieldValue.delete(),
        completedAtIso: FieldValue.delete(),
        nextDueAtIso: asString(next.dueAtIso),
        nextOccurrenceId: asString(next.id),
      }
      : operatorPause
        ? {
          status: "paused",
          closeReason: FieldValue.delete(),
          completedAtIso: FieldValue.delete(),
          nextDueAtIso: asString(next.dueAtIso),
          nextOccurrenceId: asString(next.id),
        }
        : {
          status: occurrenceStatusForDue(asString(next.dueAtIso), nowIso),
          pauseReason: FieldValue.delete(),
          closeReason: FieldValue.delete(),
          completedAtIso: FieldValue.delete(),
          nextDueAtIso: asString(next.dueAtIso),
          nextOccurrenceId: asString(next.id),
        };
  await adminDb.collection(VIDEO_REMINDER_TARGET_COLLECTION).doc(targetId).set({
    ...patch,
    updatedAtIso: nowIso,
  }, { merge: true });
}

export async function updateVideoSubmissionReminderSettings(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_video_reminders.settings.update", WRITE_ROLES);
  await assertScpEntitled(auth, request, "scp_video_reminders.settings.update");
  const data = asRecord(request.data);
  const programId = canonicalProgramId(data.programId);
  const next = normalizeReminderSettings(data.settings ?? data);
  if (next.enabled && (next.offsets.length === 0 || !next.submissionFormUrl)) {
    const error = new Error("failed-precondition: enabled video reminders require offsets and submissionFormUrl");
    Object.assign(error, { code: "failed-precondition", errorCode: "update_video_submission_reminder_settings_enabled_video_reminders" });
    throw error;
  }
  const nowIso = new Date().toISOString();
  const current = await readSettings(programId);
  const impact = data.applyMode === "active_targets"
    ? await previewSettingsImpact(programId, next, nowIso)
    : { changes: [], truncated: false };
  const previewHash = hash(JSON.stringify({ programId, currentHash: current.hash, next, impact }));
  if (data.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      programId,
      settings: next,
      previewHash,
      impact,
      behaviorLog: makeBehaviorLog(auth, "scp_video_reminders.settings.update", "mock"),
    };
  }
  if (data.applyMode === "active_targets" && asString(data.previewHash) !== previewHash) {
    const error = new Error("failed-precondition: active target settings preview is missing or stale");
    Object.assign(error, { code: "failed-precondition", errorCode: "update_video_submission_reminder_settings_active_target_settings" });
    throw error;
  }
  if (data.applyMode === "active_targets" && impact.truncated) {
    const error = new Error(`failed-precondition: active target count exceeds ${MAX_ACTIVE_SETTINGS_TARGETS}; settings were not changed`);
    Object.assign(error, { code: "failed-precondition", errorCode: "update_video_submission_reminder_settings_active_target_settings_2" });
    throw error;
  }
  const nextVersion = current.version + 1;
  const nextHash = reminderSettingsHash(next);
  const createFields = current.exists
    ? {}
    : { createdAtIso: nowIso, createdAt: FieldValue.serverTimestamp() };
  await settingsRef(programId).set({
    ...next,
    programId,
    canonicalProgramId: programId,
    version: nextVersion,
    settingsHash: nextHash,
    updatedAtIso: nowIso,
    updatedBy: auth.userId,
    ...createFields,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  if (data.applyMode === "active_targets") {
    for (const change of impact.changes) {
      const targetRef = adminDb.collection(VIDEO_REMINDER_TARGET_COLLECTION).doc(change.targetId);
      const targetSnapshot = await targetRef.get();
      const target = { id: targetSnapshot.id, ...targetSnapshot.data() } as Record<string, unknown>;
      const occurrenceSnapshot = await adminDb.collection(VIDEO_REMINDER_OCCURRENCE_COLLECTION)
        .where("targetId", "==", change.targetId)
        .get();
      const existingByOffset = new Map<number, FirebaseFirestore.QueryDocumentSnapshot>();
      for (const occurrence of occurrenceSnapshot.docs) {
        existingByOffset.set(Number(occurrence.data().offsetDays), occurrence);
      }
      const currentPauseReason = asString(target.pauseReason);
      const operatorPause = asString(target.status) === "paused"
        && currentPauseReason
        && !["automation_disabled", "schedule_empty"].includes(currentPauseReason);
      const futureOffsets = next.offsets.filter((offset) => Date.parse(reminderDueAtIso({
        triggerSentAtIso: asString(target.triggerSentAtIso),
        offsetDays: offset,
        timezone: next.timezone,
        sendTime: next.sendTime,
        sendOnWeekends: next.sendOnWeekends,
      })) > Date.parse(nowIso));
      const batch = adminDb.batch();
      for (const occurrence of occurrenceSnapshot.docs) {
        const row = occurrence.data() ?? {};
        if (!isActiveOccurrenceStatus(row.status)) continue;
        const offset = Number(row.offsetDays);
        const dueAtIso = next.offsets.includes(offset)
          ? reminderDueAtIso({
            triggerSentAtIso: asString(target.triggerSentAtIso),
            offsetDays: offset,
            timezone: next.timezone,
            sendTime: next.sendTime,
            sendOnWeekends: next.sendOnWeekends,
          })
          : "";
        if (!dueAtIso || Date.parse(dueAtIso) <= Date.parse(nowIso)) {
          batch.set(occurrence.ref, {
            status: "cancelled",
            cancelReason: dueAtIso ? "settings_recalculated_step_is_past" : "settings_removed_step",
            processingLeaseToken: FieldValue.delete(),
            processingLeaseExpiresAtIso: FieldValue.delete(),
            updatedAtIso: nowIso,
          }, { merge: true });
          continue;
        }
        batch.set(occurrence.ref, {
          status: !next.enabled || operatorPause ? "paused" : "scheduled",
          dueAtIso,
          reminderNumber: futureOffsets.indexOf(offset) + 1,
          reminderCount: futureOffsets.length,
          settingsVersion: nextVersion,
          settingsHash: nextHash,
          processingLeaseToken: FieldValue.delete(),
          processingLeaseExpiresAtIso: FieldValue.delete(),
          cancelReason: FieldValue.delete(),
          updatedAtIso: nowIso,
        }, { merge: true });
      }
      for (const offset of futureOffsets) {
        const existing = existingByOffset.get(offset);
        if (existing && (existing.data().status === "sent" || isActiveOccurrenceStatus(existing.data().status))) continue;
        const occurrenceId = reminderOccurrenceId(change.targetId, Number(target.secondMailVersion ?? 1), offset);
        batch.set(adminDb.collection(VIDEO_REMINDER_OCCURRENCE_COLLECTION).doc(occurrenceId), {
          id: occurrenceId,
          targetId: change.targetId,
          targetRef: targetRef.path,
          status: !next.enabled || operatorPause ? "paused" : "scheduled",
          offsetDays: offset,
          reminderNumber: futureOffsets.indexOf(offset) + 1,
          reminderCount: futureOffsets.length,
          dueAtIso: reminderDueAtIso({
            triggerSentAtIso: asString(target.triggerSentAtIso),
            offsetDays: offset,
            timezone: next.timezone,
            sendTime: next.sendTime,
            sendOnWeekends: next.sendOnWeekends,
          }),
          secondMailVersion: Number(target.secondMailVersion ?? 1),
          settingsVersion: nextVersion,
          settingsHash: nextHash,
          createdAtIso: nowIso,
          updatedAtIso: nowIso,
        }, { merge: true });
      }
      batch.set(targetRef, {
        offsetsSnapshot: next.offsets,
        settingsSnapshot: next,
        settingsVersion: nextVersion,
        settingsHash: nextHash,
        updatedAtIso: nowIso,
      }, { merge: true });
      addEvent(batch, {
        targetId: change.targetId,
        action: "target.settings_applied",
        nowIso,
        actorUid: auth.userId,
        details: change,
      });
      await batch.commit();
      const refreshedTarget = await targetRef.get();
      await refreshTargetScheduleAfterSettings({ id: refreshedTarget.id, ...refreshedTarget.data() }, next, nowIso);
    }
  }
  return {
    ok: true,
    programId,
    settings: next,
    version: nextVersion,
    hash: nextHash,
    impact,
    behaviorLog: makeBehaviorLog(auth, "scp_video_reminders.settings.update", "success"),
  };
}

export async function listVideoSubmissionReminderTargets(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_video_reminders.targets.list", READ_ROLES);
  await assertScpEntitled(auth, request, "scp_video_reminders.targets.list");
  const data = asRecord(request.data);
  const programId = canonicalProgramId(data.programId);
  const limit = boundedLimit(data.limit);
  const snapshot = await adminDb.collection(VIDEO_REMINDER_TARGET_COLLECTION)
    .where("canonicalProgramId", "==", programId)
    .limit(Math.min(limit * 4, MAX_LIST_ROWS))
    .get();
  const requestedStatus = asString(data.status);
  const baseRows = snapshot.docs
    .map(snapshotRow)
    .filter((row) => !requestedStatus || asString(row.status) === requestedStatus)
    .sort((left, right) => asString(left.nextDueAtIso, "9999").localeCompare(asString(right.nextDueAtIso, "9999")))
    .slice(0, limit);
  const occurrenceRefs = baseRows
    .map((row) => asString(row.nextOccurrenceId))
    .filter(Boolean)
    .map((id) => adminDb.collection(VIDEO_REMINDER_OCCURRENCE_COLLECTION).doc(id));
  const occurrenceSnapshots = occurrenceRefs.length > 0 ? await adminDb.getAll(...occurrenceRefs) : [];
  const occurrenceStatusById = new Map(occurrenceSnapshots.map((doc) => [doc.id, asString(doc.data()?.status)]));
  const rows = baseRows.map((row) => ({
    ...row,
    nextOccurrenceStatus: occurrenceStatusById.get(asString(row.nextOccurrenceId)) || null,
  }));
  const counts = { due: 0, upcoming: 0, paused: 0, closed: 0 };
  for (const row of snapshot.docs.map((doc) => doc.data() ?? {})) {
    const status = asString(row.status) as keyof typeof counts;
    if (status in counts) counts[status] += 1;
  }
  return {
    ok: true,
    programId,
    rows,
    counts,
    pageInfo: { limit, truncated: rows.length >= limit, nextCursor: null },
    behaviorLog: makeBehaviorLog(auth, "scp_video_reminders.targets.list", "success"),
  };
}

export async function previewVideoSubmissionReminderMail(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_video_reminders.mail.preview", READ_ROLES);
  await assertScpEntitled(auth, request, "scp_video_reminders.mail.preview");
  const data = asRecord(request.data);
  const kind = asString(data.kind, "reminder");
  if (kind === "second_request") {
    const jobSnapshot = await adminDb.collection(VIDEO_REMINDER_SECOND_MAIL_JOBS_COLLECTION).doc(safeDocId(asString(data.jobId))).get();
    if (!jobSnapshot.exists) throw Object.assign(new Error("not-found: second request job"), { code: "not-found", errorCode: "preview_video_submission_reminder_mail_second_request_job" });
    const job = { id: jobSnapshot.id, ...jobSnapshot.data() } as Record<string, unknown>;
    const settings = (await readSettings(canonicalProgramId(job.canonicalProgramId ?? job.programId))).settings;
    const result = await prepareScpResultMail(systemRequest({
      ...mailPayloadForJob(job, asString(job.formLink, settings.submissionFormUrl)),
      mode: "draft_only",
      dryRun: true,
      liveSend: false,
    }, auth));
    return { ...asRecord(result), behaviorLog: makeBehaviorLog(auth, "scp_video_reminders.mail.preview", "success") };
  }
  const occurrenceSnapshot = await adminDb.collection(VIDEO_REMINDER_OCCURRENCE_COLLECTION).doc(safeDocId(asString(data.occurrenceId))).get();
  if (!occurrenceSnapshot.exists) throw Object.assign(new Error("not-found: reminder occurrence"), { code: "not-found", errorCode: "preview_video_submission_reminder_mail_reminder_occurrence" });
  const occurrence = { id: occurrenceSnapshot.id, ...occurrenceSnapshot.data() } as Record<string, unknown>;
  const targetSnapshot = await adminDb.collection(VIDEO_REMINDER_TARGET_COLLECTION).doc(asString(occurrence.targetId)).get();
  const target = { id: targetSnapshot.id, ...targetSnapshot.data() } as Record<string, unknown>;
  const result = await prepareScpResultMail(systemRequest({
    ...mailPayloadForOccurrence(occurrence, target, normalizeReminderSettings(target.settingsSnapshot)),
    mode: "draft_only",
    dryRun: true,
    liveSend: false,
  }, auth));
  return { ...asRecord(result), behaviorLog: makeBehaviorLog(auth, "scp_video_reminders.mail.preview", "success") };
}

export async function approveVideoSubmissionReminderMail(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_video_reminders.mail.approve", WRITE_ROLES);
  await assertScpEntitled(auth, request, "scp_video_reminders.mail.approve");
  const data = asRecord(request.data);
  const nowIso = new Date().toISOString();
  if (asString(data.kind, "reminder") === "second_request") {
    const snapshot = await adminDb.collection(VIDEO_REMINDER_SECOND_MAIL_JOBS_COLLECTION).doc(safeDocId(asString(data.jobId))).get();
    if (!snapshot.exists) throw Object.assign(new Error("not-found: second request job"), { code: "not-found", errorCode: "approve_video_submission_reminder_mail_second_request_job" });
    const result = await processSecondRequestJob({ id: snapshot.id, ...snapshot.data() }, { nowIso, forceSend: true, actor: auth });
    return { ok: true, result, behaviorLog: makeBehaviorLog(auth, "scp_video_reminders.mail.approve", "success") };
  }
  const snapshot = await adminDb.collection(VIDEO_REMINDER_OCCURRENCE_COLLECTION).doc(safeDocId(asString(data.occurrenceId))).get();
  if (!snapshot.exists) throw Object.assign(new Error("not-found: reminder occurrence"), { code: "not-found", errorCode: "approve_video_submission_reminder_mail_reminder_occurrence" });
  const occurrence = snapshot.data() ?? {};
  if (asString(occurrence.status) !== "awaiting_approval" || Date.parse(asString(occurrence.dueAtIso)) > Date.parse(nowIso)) {
    throw Object.assign(
      new Error("failed-precondition: only a due awaiting-approval reminder can be approved"),
      { code: "failed-precondition", errorCode: "approve_video_submission_reminder_mail_only_due_awaiting_approval" },
    );
  }
  const result = await processOccurrence({ id: snapshot.id, ...snapshot.data() }, { nowIso, forceSend: true, actor: auth });
  return { ok: true, result, behaviorLog: makeBehaviorLog(auth, "scp_video_reminders.mail.approve", "success") };
}

export async function updateVideoSubmissionReminderTarget(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_video_reminders.target.update", WRITE_ROLES);
  await assertScpEntitled(auth, request, "scp_video_reminders.target.update");
  const data = asRecord(request.data);
  const targetId = safeDocId(asString(data.targetId));
  const action = asString(data.action);
  const nowIso = new Date().toISOString();
  const targetRef = adminDb.collection(VIDEO_REMINDER_TARGET_COLLECTION).doc(targetId);
  const snapshot = await targetRef.get();
  if (!snapshot.exists) throw Object.assign(new Error("not-found: reminder target"), { code: "not-found", errorCode: "update_video_submission_reminder_target_reminder_target" });
  const target = { id: snapshot.id, ...snapshot.data() } as Record<string, unknown>;
  const occurrenceSnapshot = ["pause", "resume", "close"].includes(action)
    ? await adminDb.collection(VIDEO_REMINDER_OCCURRENCE_COLLECTION).where("targetId", "==", targetId).get()
    : null;
  const batch = adminDb.batch();
  let skippedOccurrence: Record<string, unknown> | null = null;
  if (action === "pause") {
    batch.set(targetRef, { status: "paused", pauseReason: asString(data.reason, "operator_paused"), pausedAtIso: nowIso, updatedAtIso: nowIso }, { merge: true });
    for (const occurrence of occurrenceSnapshot?.docs ?? []) {
      if (!isActiveOccurrenceStatus(occurrence.data().status)) continue;
      batch.set(occurrence.ref, {
        status: "paused",
        processingLeaseToken: FieldValue.delete(),
        processingLeaseExpiresAtIso: FieldValue.delete(),
        updatedAtIso: nowIso,
      }, { merge: true });
    }
  } else if (action === "resume") {
    const nextDueAtIso = asString(target.nextDueAtIso);
    batch.set(targetRef, {
      status: nextDueAtIso ? occurrenceStatusForDue(nextDueAtIso, nowIso) : "closed",
      pauseReason: FieldValue.delete(),
      resumedAtIso: nowIso,
      updatedAtIso: nowIso,
    }, { merge: true });
    for (const occurrence of occurrenceSnapshot?.docs ?? []) {
      if (asString(occurrence.data().status) !== "paused") continue;
      batch.set(occurrence.ref, { status: "scheduled", updatedAtIso: nowIso }, { merge: true });
    }
  } else if (action === "close") {
    batch.set(targetRef, { status: "closed", closeReason: asString(data.reason, "operator_closed"), completedAtIso: nowIso, nextDueAtIso: FieldValue.delete(), nextOccurrenceId: FieldValue.delete(), updatedAtIso: nowIso }, { merge: true });
    for (const occurrence of occurrenceSnapshot?.docs ?? []) {
      if (!isActiveOccurrenceStatus(occurrence.data().status)) continue;
      batch.set(occurrence.ref, {
        status: "cancelled",
        cancelReason: asString(data.reason, "operator_closed"),
        processingLeaseToken: FieldValue.delete(),
        processingLeaseExpiresAtIso: FieldValue.delete(),
        updatedAtIso: nowIso,
      }, { merge: true });
    }
  } else if (action === "skip") {
    const occurrenceId = safeDocId(asString(data.occurrenceId));
    if (!occurrenceId) throw Object.assign(new Error("invalid-argument: occurrenceId is required"), { code: "invalid-argument", errorCode: "update_video_submission_reminder_target_occurrence_id_required" });
    const occurrenceRef = adminDb.collection(VIDEO_REMINDER_OCCURRENCE_COLLECTION).doc(occurrenceId);
    const occurrenceSnapshot = await occurrenceRef.get();
    if (!occurrenceSnapshot.exists || asString(occurrenceSnapshot.data()?.targetId) !== targetId) {
      throw Object.assign(new Error("not-found: reminder occurrence"), { code: "not-found", errorCode: "update_video_submission_reminder_target_reminder_occurrence" });
    }
    skippedOccurrence = { id: occurrenceSnapshot.id, ...occurrenceSnapshot.data() } as Record<string, unknown>;
    batch.set(occurrenceRef, { status: "skipped", skipReason: asString(data.reason, "operator_skipped"), skippedAtIso: nowIso, updatedAtIso: nowIso }, { merge: true });
  } else {
    throw Object.assign(new Error("invalid-argument: unsupported reminder target action"), { code: "invalid-argument", errorCode: "update_video_submission_reminder_target_unsupported_reminder_target" });
  }
  addEvent(batch, { targetId, occurrenceId: asString(data.occurrenceId), action: `target.${action}`, reason: asString(data.reason), nowIso, actorUid: auth.userId });
  await batch.commit();
  if (action === "skip" && skippedOccurrence) {
    await advanceTargetAfterOccurrence(target, { ...skippedOccurrence, sentAtIso: nowIso }, nowIso);
  }
  return { ok: true, targetId, action, behaviorLog: makeBehaviorLog(auth, "scp_video_reminders.target.update", "success") };
}

export async function listVideoSubmissionReminderHistory(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_video_reminders.history.list", READ_ROLES);
  await assertScpEntitled(auth, request, "scp_video_reminders.history.list");
  const data = asRecord(request.data);
  const targetId = safeDocId(asString(data.targetId));
  const limit = boundedLimit(data.limit, 50);
  const snapshot = await adminDb.collection(VIDEO_REMINDER_EVENT_COLLECTION).where("targetId", "==", targetId).limit(limit).get();
  const rows = snapshot.docs.map(snapshotRow)
    .sort((left, right) => asString(right.createdAtIso).localeCompare(asString(left.createdAtIso)));
  return { ok: true, targetId, rows, behaviorLog: makeBehaviorLog(auth, "scp_video_reminders.history.list", "success") };
}
