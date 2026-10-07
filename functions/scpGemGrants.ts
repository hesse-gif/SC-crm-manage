import { createHash } from "crypto";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { enqueueScpLifecycleRefreshEvent, type ScpLifecycleRefreshAliasInput } from "./scpLifecycleProfiles";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type AuthContext, type CallableRequestShape } from "./shared";
import { assertScpEntitled } from "./mailAccounts";
import { safeDocId } from "./sheetIntakeService";
import { resolveCanonicalProgramId, SCP_CANONICAL_PROGRAM_ID } from "./programCanonical";
import { enqueueSecondRequestMailJobInBatch } from "./scpVideoSubmissionReminderStore";

const GEM_GRANTS_COLLECTION = "gem_grants";
const GEM_GRANT_AUDIT_COLLECTION = "gem_grant_audit";
const SCP_AUTOMATION_SETTINGS_DOC = "settings/scp_automation";
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

type GemGrantStatus = "scheduled" | "held" | "failed" | "paid";

type GemGrantRecord = Record<string, unknown> & {
  id: string;
  status: GemGrantStatus;
  profileId?: string;
  leadId?: string;
  creatorId?: string;
  email?: string;
  handle?: string;
  channelId?: string;
  uid?: string;
  scheduledForIso?: string;
  fridayAtIso?: string;
  scheduledAtIso?: string;
  paidAtIso?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function cleanObject<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function pageSize(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(Math.trunc(value), MAX_PAGE_SIZE))
    : DEFAULT_PAGE_SIZE;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []) : [];
}

function lowerList(value: unknown): string[] {
  return stringList(value).map((item) => item.toLowerCase());
}

function nextFridayUtcIso(fromIso: string): string {
  const base = new Date(fromIso);
  const date = Number.isNaN(base.getTime()) ? new Date() : base;
  const daysUntilFriday = (5 - date.getUTCDay() + 7) % 7;
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + daysUntilFriday, 0, 0, 0, 0));
  return target.toISOString();
}

function assertFridayIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getUTCDay() !== 5) {
    const error = new Error("failed-precondition: gem grants must be scheduled on Friday UTC");
    Object.assign(error, { code: "failed-precondition", errorCode: "assert_friday_iso_gem_grants_must_be_scheduled" });
    throw error;
  }
  return date.toISOString();
}

function scheduledFridayIso(data: Record<string, unknown>, updatedAtIso: string): string {
  const explicit = asString(data.fridayAtIso, asString(data.scheduledForIso));
  return explicit ? assertFridayIso(explicit) : nextFridayUtcIso(updatedAtIso);
}

function grantDocId(data: Record<string, unknown>, fridayAtIso: string): string {
  const explicit = asString(data.grantId, asString(data.id));
  if (explicit) return safeDocId(explicit);
  const identity = asString(data.profileId, asString(data.leadId, asString(data.creatorId, asString(data.email, asString(data.uid, "grant")))));
  return safeDocId(`gem:${identity}:${fridayAtIso.slice(0, 10)}`);
}

function grantRef(grantId: string) {
  return adminDb.collection(GEM_GRANTS_COLLECTION).doc(safeDocId(grantId));
}

function grantAliases(record: Record<string, unknown>): ScpLifecycleRefreshAliasInput[] {
  return [
    {
      leadId: record.leadId,
      creatorId: record.creatorId,
      email: record.email,
      handle: record.handle,
      channelId: record.channelId,
      submissionId: record.submissionId,
      videoId: record.videoId,
      trackingId: record.trackingId,
    },
  ];
}

async function enqueueLifecycle(record: Record<string, unknown>, reason: string, updatedAtIso: string): Promise<boolean> {
  const grantId = asString(record.id, asString(record.grantId));
  if (!grantId) return false;
  try {
    await enqueueScpLifecycleRefreshEvent({
      source: "gem_grants",
      sourceRef: `${GEM_GRANTS_COLLECTION}/${grantId}`,
      reason,
      profileId: asString(record.profileId) || undefined,
      aliases: grantAliases(record),
      sourceUpdatedAtIso: updatedAtIso,
    });
    return true;
  } catch (error) {
    await grantRef(grantId).set({
      lifecycleRefreshEnqueueError: errorMessage(error),
      lifecycleRefreshEnqueueFailedAtIso: updatedAtIso,
      updatedAtIso,
    }, { merge: true }).catch(() => undefined);
    return false;
  }
}

function auditRow(auth: AuthContext, grantId: string, action: string, beforeStatus: unknown, afterStatus: GemGrantStatus, data: Record<string, unknown>, updatedAtIso: string) {
  return cleanObject({
    grantId,
    action,
    beforeStatus: asString(beforeStatus) || null,
    afterStatus,
    reason: asString(data.reason, asString(data.holdReason, asString(data.failureReason))),
    paymentRef: asString(data.paymentRef) || undefined,
    actorUid: auth.userId,
    actorRole: auth.role,
    actorEmail: auth.email,
    team: auth.team,
    gameId: auth.gameId,
    createdAtIso: updatedAtIso,
  });
}

function addAudit(batch: FirebaseFirestore.WriteBatch, auth: AuthContext, grantId: string, action: string, beforeStatus: unknown, afterStatus: GemGrantStatus, data: Record<string, unknown>, updatedAtIso: string) {
  const row = auditRow(auth, grantId, action, beforeStatus, afterStatus, data, updatedAtIso);
  const auditId = safeDocId(`${grantId}:${action}:${updatedAtIso}:${shortHash(`${auth.userId}:${JSON.stringify(row)}`)}`);
  const auditRef = adminDb.collection(GEM_GRANT_AUDIT_COLLECTION).doc(auditId);
  batch.set(auditRef, { id: auditId, ...row });
  return { auditId, auditRef: `${GEM_GRANT_AUDIT_COLLECTION}/${auditId}`, row };
}

async function assertFinanceAuth(request: CallableRequestShape): Promise<AuthContext> {
  const auth = assertNonGuestAuth(request, "gemGrants.markPaid", ["super_admin", "admin", "manager"]);
  if (auth.role === "super_admin" || auth.role === "admin") return auth;

  const snapshot = await adminDb.doc(SCP_AUTOMATION_SETTINGS_DOC).get();
  const settings = asRecord(snapshot.data());
  const token = asRecord(request.auth?.token);
  const finance = asRecord(settings.gemGrantFinance);
  const configuredRoles = new Set([
    ...stringList(settings.gemGrantFinanceRoles),
    ...stringList(finance.roles),
  ]);
  const configuredEmails = new Set([
    ...lowerList(settings.gemGrantFinanceEmails),
    ...lowerList(finance.emails),
  ]);
  const tokenFinanceRole = asString(token.financeRole, asString(token.scpFinanceRole, asString(token.finance_role)));
  const email = asString(auth.email).toLowerCase();
  if ((tokenFinanceRole && configuredRoles.has(tokenFinanceRole)) || (email && configuredEmails.has(email))) return auth;

  const error = new Error("permission-denied: gem grant payment requires admin, super_admin, or configured finance role");
  Object.assign(error, {
    code: "permission-denied", errorCode: "assert_finance_auth_gem_grant_payment_requires_admin",
    behaviorLog: makeBehaviorLog(auth, "gemGrants.markPaid", "denied"),
  });
  throw error;
}

async function transitionGrant(request: CallableRequestShape, status: GemGrantStatus, action: string, extra: (data: Record<string, unknown>, updatedAtIso: string) => Record<string, unknown>, roles: readonly ["super_admin", "admin", "manager"] | readonly ["super_admin", "admin"] = ["super_admin", "admin", "manager"]) {
  const auth = action === "gem_grant.paid" ? await assertFinanceAuth(request) : assertNonGuestAuth(request, action, roles);
  // 2026-09-27 codex adversarial review round 2 FAIL-3: gem grants are scp creator-submission
  // rewards — shared choke point for holdGemGrant/failGemGrant/markGemGrantPaid (all delegate
  // here), same pattern as scpOutreach.ts's actorFromRequest.
  await assertScpEntitled(auth, request, action);
  const data = asRecord(request.data);
  const rawGrantId = asString(data.grantId, asString(data.id));
  if (!rawGrantId) {
    const error = new Error("invalid-argument: grantId is required");
    Object.assign(error, { code: "invalid-argument", errorCode: "transition_grant_grant_id_required", behaviorLog: makeBehaviorLog(auth, action, "error") });
    throw error;
  }
  const grantId = safeDocId(rawGrantId);
  const ref = grantRef(grantId);
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    const error = new Error("not-found: gem grant not found");
    Object.assign(error, { code: "not-found", errorCode: "transition_grant_gem_grant_found", behaviorLog: makeBehaviorLog(auth, action, "error") });
    throw error;
  }
  const before = { id: snapshot.id, ...snapshot.data() } as GemGrantRecord;
  const updatedAtIso = nowIso();
  const batch = adminDb.batch();
  const audit = addAudit(batch, auth, grantId, action, before.status, status, data, updatedAtIso);
  const patch = cleanObject({
    status,
    ...extra(data, updatedAtIso),
    updatedAtIso,
    updatedBy: auth.userId,
    latestAuditRef: audit.auditRef,
    auditTrail: FieldValue.arrayUnion(audit.row),
    lifecycleRefreshEnqueueError: null,
    lifecycleRefreshEnqueueFailedAtIso: null,
  });
  batch.set(ref, patch, { merge: true });
  let submissionRequestJobRef = "";
  if (action === "gem_grant.paid") {
    const paidAtIso = asString(data.paidAtIso, updatedAtIso);
    const programId = resolveCanonicalProgramId(
      asString(data.programId, asString(before.canonicalProgramId, asString(before.programId, SCP_CANONICAL_PROGRAM_ID))),
    );
    submissionRequestJobRef = enqueueSecondRequestMailJobInBatch(batch, {
      grantId,
      programId,
      leadId: asString(before.leadId, asString(data.leadId)) || undefined,
      creatorId: asString(before.creatorId, asString(data.creatorId)) || undefined,
      profileId: asString(before.profileId, asString(data.profileId)) || undefined,
      email: asString(before.email, asString(data.email)) || undefined,
      uid: asString(before.uid, asString(data.uid)) || undefined,
      token: asString(before.token, asString(data.token)) || undefined,
      creatorName: asString(before.creatorName, asString(before.name, asString(data.creatorName, asString(data.name)))) || undefined,
      campaignId: asString(before.campaignId, asString(data.campaignId)) || undefined,
      formLink: asString(before.formLink, asString(data.formLink)) || undefined,
      paidAtIso,
      version: 1,
      requestedBy: auth.userId,
    });
    batch.set(ref, {
      programId,
      canonicalProgramId: programId,
      submissionRequestMailState: "queued",
      submissionRequestJobRef,
      submissionRequestQueuedAtIso: updatedAtIso,
    }, { merge: true });
  }
  await batch.commit();
  const afterSnapshot = await ref.get();
  const after = { id: afterSnapshot.id, ...afterSnapshot.data() };
  const lifecycleRefreshEnqueued = await enqueueLifecycle(after, action, updatedAtIso);
  return {
    ok: true,
    grantId,
    grant: after,
    auditRef: audit.auditRef,
    submissionRequestJobRef: submissionRequestJobRef || undefined,
    lifecycleRefreshEnqueued,
    behaviorLog: makeBehaviorLog(auth, action, "success"),
  };
}

export async function scheduleGemGrant(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "gemGrants.schedule", ["super_admin", "admin", "manager"]);
  // 2026-09-27 codex adversarial review round 2 FAIL-3: a role-permitted but non-entitled manager
  // must not be able to schedule a gem grant for an scp creator submission.
  await assertScpEntitled(auth, request, "gemGrants.schedule");
  const data = asRecord(request.data);
  const updatedAtIso = nowIso();
  const fridayAtIso = scheduledFridayIso(data, updatedAtIso);
  const grantId = grantDocId(data, fridayAtIso);
  const ref = grantRef(grantId);
  const snapshot = await ref.get();
  const beforeStatus = snapshot.exists ? snapshot.data()?.status : null;
  const batch = adminDb.batch();
  const audit = addAudit(batch, auth, grantId, "gem_grant.scheduled", beforeStatus, "scheduled", data, updatedAtIso);
  const record = cleanObject({
    id: grantId,
    grantId,
    status: "scheduled" as const,
    programId: resolveCanonicalProgramId(asString(data.programId, SCP_CANONICAL_PROGRAM_ID)),
    canonicalProgramId: resolveCanonicalProgramId(asString(data.programId, SCP_CANONICAL_PROGRAM_ID)),
    profileId: asString(data.profileId) || undefined,
    leadId: asString(data.leadId) || undefined,
    creatorId: asString(data.creatorId) || undefined,
    email: asString(data.email) || undefined,
    handle: asString(data.handle) || undefined,
    channelId: asString(data.channelId) || undefined,
    uid: asString(data.uid) || undefined,
    submissionId: asString(data.submissionId) || undefined,
    videoId: asString(data.videoId) || undefined,
    trackingId: asString(data.trackingId) || undefined,
    amountGems: typeof data.amountGems === "number" ? Math.max(0, Math.trunc(data.amountGems)) : undefined,
    reason: asString(data.reason) || undefined,
    fridayAtIso,
    scheduledForIso: fridayAtIso,
    fridayKey: fridayAtIso.slice(0, 10),
    scheduledAtIso: updatedAtIso,
    createdAtIso: snapshot.exists ? snapshot.data()?.createdAtIso : updatedAtIso,
    createdBy: snapshot.exists ? snapshot.data()?.createdBy : auth.userId,
    updatedAtIso,
    updatedBy: auth.userId,
    latestAuditRef: audit.auditRef,
    auditTrail: FieldValue.arrayUnion(audit.row),
    lifecycleRefreshEnqueueError: null,
    lifecycleRefreshEnqueueFailedAtIso: null,
  });
  batch.set(ref, record, { merge: true });
  await batch.commit();
  const lifecycleRefreshEnqueued = await enqueueLifecycle(record, "gem_grant.scheduled", updatedAtIso);
  const grant = { ...record, auditTrail: [audit.row] };
  return {
    ok: true,
    grantId,
    grant,
    auditRef: audit.auditRef,
    lifecycleRefreshEnqueued,
    behaviorLog: makeBehaviorLog(auth, "gemGrants.schedule", "success"),
  };
}

export async function holdGemGrant(request: CallableRequestShape) {
  return transitionGrant(request, "held", "gem_grant.held", (data, updatedAtIso) => ({
    heldAtIso: updatedAtIso,
    holdReason: asString(data.reason, asString(data.holdReason, "hold_requested")),
  }));
}

export async function failGemGrant(request: CallableRequestShape) {
  return transitionGrant(request, "failed", "gem_grant.failed", (data, updatedAtIso) => ({
    failedAtIso: updatedAtIso,
    failureReason: asString(data.reason, asString(data.failureReason, "grant_failed")),
  }));
}

export async function markGemGrantPaid(request: CallableRequestShape) {
  return transitionGrant(request, "paid", "gem_grant.paid", (data, updatedAtIso) => ({
    paidAtIso: asString(data.paidAtIso, updatedAtIso),
    paymentRef: asString(data.paymentRef, asString(data.receiptRef, "manual-audit")),
    paidNote: asString(data.reason, asString(data.note)) || undefined,
  }));
}

export async function listGemGrants(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "gemGrants.list", ["super_admin", "admin", "manager"]);
  // 2026-09-27 codex adversarial review round 2 FAIL-3: gem grant rows are scp creator-submission
  // reward data — no general-purpose UI reads this list.
  await assertScpEntitled(auth, request, "gemGrants.list");
  const data = asRecord(request.data);
  const limit = pageSize(data.limit);
  const status = asString(data.status) as GemGrantStatus;
  let query: FirebaseFirestore.Query = adminDb.collection(GEM_GRANTS_COLLECTION);
  if (["scheduled", "held", "failed", "paid"].includes(status)) query = query.where("status", "==", status);
  query = query.orderBy("scheduledForIso", "asc").orderBy(FieldPath.documentId()).limit(limit);
  const snapshot = await query.get();
  return {
    ok: true,
    rows: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    pageInfo: { limit, truncated: false, nextCursor: null },
    behaviorLog: makeBehaviorLog(auth, "gemGrants.list", "success"),
  };
}
