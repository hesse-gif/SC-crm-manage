import { createHash } from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import { safeDocId } from "./sheetIntakeService";

export const VIDEO_REMINDER_SETTINGS_COLLECTION = "scp_video_submission_reminder_settings";
export const VIDEO_REMINDER_SECOND_MAIL_JOBS_COLLECTION = "scp_video_submission_second_mail_jobs";
export const VIDEO_REMINDER_TRIGGER_COLLECTION = "scp_video_submission_reminder_triggers";
export const VIDEO_REMINDER_TARGET_COLLECTION = "scp_video_submission_reminder_targets";
export const VIDEO_REMINDER_OCCURRENCE_COLLECTION = "scp_video_submission_reminder_occurrences";
export const VIDEO_REMINDER_EVENT_COLLECTION = "scp_video_submission_reminder_events";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizedReminderEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase().slice(0, 240) : "";
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
}

export function normalizedReminderEmailHash(value: unknown): string {
  const email = normalizedReminderEmail(value);
  return email ? hash(email) : "";
}

export function secondRequestJobId(grantId: string, version = 1): string {
  return safeDocId(`scp-vsr-second:${hash(`${grantId}\u0000${version}`).slice(0, 40)}`);
}

export function enqueueSecondRequestMailJobInBatch(
  batch: FirebaseFirestore.WriteBatch,
  input: {
    grantId: string;
    programId: string;
    leadId?: string;
    creatorId?: string;
    profileId?: string;
    email?: string;
    uid?: string;
    token?: string;
    creatorName?: string;
    campaignId?: string;
    formLink?: string;
    paidAtIso: string;
    version?: number;
    requestedBy: string;
  },
): string {
  const version = Math.max(1, Math.trunc(input.version ?? 1));
  const id = secondRequestJobId(input.grantId, version);
  const ref = adminDb.collection(VIDEO_REMINDER_SECOND_MAIL_JOBS_COLLECTION).doc(id);
  const email = normalizedReminderEmail(input.email);
  batch.set(ref, {
    id,
    status: "queued",
    programId: input.programId,
    canonicalProgramId: input.programId,
    grantId: input.grantId,
    gemGrantRef: `gem_grants/${input.grantId}`,
    leadId: input.leadId || null,
    creatorId: input.creatorId || null,
    profileId: input.profileId || null,
    email: email || null,
    normalizedEmailHash: normalizedReminderEmailHash(email) || null,
    uid: input.uid || null,
    token: input.token || null,
    creatorName: input.creatorName || null,
    campaignId: input.campaignId || null,
    formLink: input.formLink || null,
    paidAtIso: input.paidAtIso,
    secondMailVersion: version,
    requestedBy: input.requestedBy,
    attemptCount: 0,
    createdAtIso: input.paidAtIso,
    updatedAtIso: input.paidAtIso,
  }, { merge: true });
  return ref.path;
}

export function enqueueProviderConfirmedReminderTriggerInBatch(
  batch: FirebaseFirestore.WriteBatch,
  input: {
    resultRef: string;
    programId: string;
    leadId?: string;
    creatorId?: string;
    email?: string;
    uid?: string;
    token?: string;
    creatorName?: string;
    campaignId?: string;
    formLink?: string;
    gemGrantRef?: string;
    sentAtIso: string;
    secondMailVersion: number;
  },
): string {
  const id = safeDocId(`scp-vsr-trigger:${hash(input.resultRef).slice(0, 40)}`);
  const ref = adminDb.collection(VIDEO_REMINDER_TRIGGER_COLLECTION).doc(id);
  const email = normalizedReminderEmail(input.email);
  batch.set(ref, {
    id,
    status: "queued",
    resultRef: input.resultRef,
    triggerMailResultRef: input.resultRef,
    programId: input.programId,
    canonicalProgramId: input.programId,
    leadId: input.leadId || null,
    creatorId: input.creatorId || null,
    uid: input.uid || null,
    token: input.token || null,
    creatorName: input.creatorName || null,
    campaignId: input.campaignId || null,
    formLink: input.formLink || null,
    email: email || null,
    normalizedEmailHash: normalizedReminderEmailHash(email) || null,
    gemGrantRef: input.gemGrantRef || null,
    triggerSentAtIso: input.sentAtIso,
    secondMailVersion: Math.max(1, Math.trunc(input.secondMailVersion || 1)),
    attemptCount: 0,
    createdAtIso: input.sentAtIso,
    updatedAtIso: input.sentAtIso,
  }, { merge: true });
  return ref.path;
}
