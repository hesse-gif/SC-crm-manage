import { createHash } from "node:crypto";
import { FieldPath, FieldValue, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { normalizeEmailAddress, safeMailDocId } from "./mailSafetyShared";
import { assertCanonicalMailIdentityForQuota } from "./mailOutboundSafety";
import { findMailSuppression, mailSuppressionBlocksSend } from "./mailSuppression";
import {
  isHumanGateRequiredFromSettings,
  readScpAutomationSettings,
} from "./scpAutomationSettings";
import {
  readScpIdentityConflictAutomationGate,
  scpLifecycleProfileNotFoundReason,
} from "./scpLifecycleProfiles";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  makeBehaviorLog,
  makeCache,
  makeCostLog,
  maskEmail,
  type CallableRequestShape,
} from "./shared";
// 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate): see scpAutomationSettings.ts.
import { assertScpEntitled } from "./mailAccounts";

const PROFILE_COLLECTION = "scp_lifecycle_profiles";
const RESULT_COLLECTION = "scp_mail_results";
const TEMPLATE_COLLECTION = "scp_mail_templates";
const CADENCE_COLLECTION = "scp_encouragement_cadence";
const READ_ROLES = ["super_admin", "admin", "manager", "viewer"] as const;
const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;
const MATERIALIZED_VERSION = 2;
const MAX_PAGE_SIZE = 500;
const MAX_CARDS = 100;
const DEFAULT_COOLDOWN_DAYS = 7;
const ELIGIBLE_STATES = new Set([
  "onelink_sent",
  "uid_requested",
  "uid_received",
  "gem_scheduled",
  "gem_paid",
  "video_task_issued",
]);

type Eligibility =
  | { eligible: true; mailbox: string; leadId: string; creatorId: string; creatorName: string; handle: string; onelink: string; formLink: string; lastContactAtIso: string | null; waitedDays: number }
  | { eligible: false; reason: string };

function privateHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function publicHash(value: string): string {
  return privateHash(value).slice(0, 24);
}

function cleanPositiveInt(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(Math.trunc(value), max))
    : fallback;
}

function requestedStates(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  const states = raw.map((item) => asString(item)).filter((state) => ELIGIBLE_STATES.has(state));
  return states.length > 0 ? [...new Set(states)] : [...ELIGIBLE_STATES];
}

function isoOrNull(value: unknown): string | null {
  const raw = asString(value);
  return raw && Number.isFinite(Date.parse(raw)) ? raw : null;
}

function waitedDaysSince(value: string | null, nowIso: string): number {
  if (!value) return 0;
  const delta = Date.parse(nowIso) - Date.parse(value);
  return Number.isFinite(delta) ? Math.max(0, Math.floor(delta / 86_400_000)) : 0;
}

function profileRow(snapshot: DocumentSnapshot): Record<string, unknown> {
  return { id: snapshot.id, profileId: snapshot.id, ...(snapshot.data() ?? {}) };
}

function hasFreshCurrentProgramProfile(profile: Record<string, unknown>): boolean {
  return profile.materializedVersion === MATERIALIZED_VERSION &&
    scpLifecycleProfileNotFoundReason(profile) === null;
}

function sourceRefs(profile: Record<string, unknown>): string[] {
  return Array.isArray(profile.sourceRefs)
    ? profile.sourceRefs.map((item) => asString(item)).filter(Boolean)
    : [];
}

function strongAliasIds(profile: Record<string, unknown>): string[] {
  return Array.isArray(profile.aliasIds)
    ? profile.aliasIds.map((item) => asString(item)).filter(Boolean)
    : [];
}

async function readSourceRows(refs: string[]): Promise<Array<{ ref: string; data: Record<string, unknown> }>> {
  const rows: Array<{ ref: string; data: Record<string, unknown> }> = [];
  for (const ref of refs) {
    const [collection, docId] = ref.split("/");
    if (!collection || !docId || ref.split("/").length !== 2) continue;
    const snapshot = await adminDb.collection(collection).doc(docId).get();
    if (snapshot.exists) rows.push({ ref, data: { id: snapshot.id, ...(snapshot.data() ?? {}) } });
  }
  return rows;
}

function appliedEvidenceRef(rows: Array<{ ref: string; data: Record<string, unknown> }>): string {
  return rows.find((row) => row.ref.startsWith("program_sheet_leads/") || row.ref.startsWith("program_applications/"))?.ref ?? "";
}

function latestTimestamp(rows: Array<{ data: Record<string, unknown> }>): string | null {
  const timestamps: string[] = [];
  for (const row of rows) {
    for (const key of ["sentAtIso", "deliveredAtIso", "updatedAtIso", "createdAtIso", "submittedAtIso", "issuedAtIso"]) {
      const timestamp = isoOrNull(row.data[key]);
      if (timestamp) timestamps.push(timestamp);
    }
  }
  return timestamps.sort().at(-1) ?? null;
}

function fieldValue(rows: Array<{ data: Record<string, unknown> }>, keys: string[]): string {
  for (const row of rows) {
    for (const key of keys) {
      const value = asString(row.data[key]);
      if (value) return value;
    }
  }
  return "";
}

function onelinkFromRows(rows: Array<{ data: Record<string, unknown> }>): string {
  return fieldValue(rows, ["appsflyerOneLink", "onelinkUrl", "oneLinkUrl", "onelink", "oneLink"]);
}

function completedTaskInRows(rows: Array<{ ref: string; data: Record<string, unknown> }>): boolean {
  return rows.some((row) => {
    if (row.ref.startsWith("submissions/")) return true;
    if (!row.ref.startsWith("submission_tasks/")) return false;
    const status = asString(row.data.status).toLowerCase();
    return ["submitted", "completed", "done", "video_submitted"].includes(status) ||
      Boolean(row.data.completedAtIso || row.data.submittedAtIso);
  });
}

async function liveSubmissionExists(input: {
  leadId: string;
  creatorId: string;
  mailbox: string;
  programId: string;
}): Promise<boolean> {
  const checks: Array<Promise<FirebaseFirestore.QuerySnapshot>> = [];
  if (input.leadId) checks.push(adminDb.collection("submissions").where("leadId", "==", input.leadId).limit(1).get());
  if (input.creatorId) checks.push(adminDb.collection("submissions").where("creatorId", "==", input.creatorId).limit(1).get());
  if (input.mailbox) checks.push(adminDb.collection("submissions").where("email", "==", input.mailbox).limit(1).get());
  const snapshots = await Promise.all(checks);
  return snapshots.some((snapshot) => snapshot.docs.some((doc) => {
    const row = doc.data() ?? {};
    const rowProgram = asString(row.canonicalProgramId, asString(row.programId));
    return !rowProgram || rowProgram === input.programId;
  }));
}

async function eligibilityForProfile(profile: Record<string, unknown>, nowIso: string): Promise<Eligibility> {
  if (!hasFreshCurrentProgramProfile(profile)) return { eligible: false, reason: "profile_not_fresh_current_version" };
  const programIds = Array.isArray(profile.programIds) ? profile.programIds.map((item) => asString(item)).filter(Boolean) : [];
  if (programIds.length !== 1) return { eligible: false, reason: "program_scope_not_canonical_singleton" };
  const currentState = asString(profile.currentState);
  if (!ELIGIBLE_STATES.has(currentState)) return { eligible: false, reason: "state_not_eligible" };
  if (profile.resolutionState !== "resolved" || profile.automationBlocked === true) return { eligible: false, reason: "identity_resolution_blocked" };
  if (Number(asRecord(profile.counts).submissions ?? 0) !== 0) return { eligible: false, reason: "submission_count_nonzero" };
  if (profile.onelinkProviderConfirmed !== true) return { eligible: false, reason: "onelink_provider_unconfirmed" };
  if (strongAliasIds(profile).length === 0) return { eligible: false, reason: "missing_strong_alias" };

  const programId = asString(profile.programId);
  const rows = await readSourceRows(sourceRefs(profile));
  if (!appliedEvidenceRef(rows)) return { eligible: false, reason: "missing_applied_evidence" };
  if (completedTaskInRows(rows)) return { eligible: false, reason: "submission_or_task_completed" };

  const mailbox = normalizeEmailAddress(fieldValue(rows, ["email", "creatorEmail", "mail", "recipientEmail"]));
  if (!mailbox) return { eligible: false, reason: "missing_deliverable_mailbox" };
  const leadId = fieldValue(rows, ["leadId", "id"]);
  const creatorId = fieldValue(rows, ["creatorId"]);
  const handle = fieldValue(rows, ["handle", "creatorHandle", "channelHandle"]);
  const creatorName = fieldValue(rows, ["name", "creatorName", "channelName"]) || mailbox;
  const onelink = onelinkFromRows(rows);
  // No dead-domain fallback: a bare flu.supercent.io/scp/submit here was doubly broken (NXDOMAIN
  // and tokenless). With no real link the render reports form_link missing and the send is
  // blocked (required_placeholders_missing) — fail-closed instead of shipping a dead link.
  const formLink = fieldValue(rows, ["formLink", "submissionFormUrl", "submissionFormLink"]);
  if (!onelink) return { eligible: false, reason: "missing_onelink" };

  const conflictGate = await readScpIdentityConflictAutomationGate({
    programId,
    profileId: asString(profile.profileId, asString(profile.id)),
    aliases: [
      { kind: "email", value: mailbox },
      { kind: "leadId", value: leadId },
      { kind: "creatorId", value: creatorId },
    ],
  });
  if (conflictGate) return { eligible: false, reason: "identity_conflict" };
  if (await liveSubmissionExists({ leadId, creatorId, mailbox, programId })) {
    return { eligible: false, reason: "live_submission_exists" };
  }
  const suppression = await findMailSuppression({ email: mailbox, handle, name: creatorName });
  if (mailSuppressionBlocksSend(suppression)) return { eligible: false, reason: "mail_suppressed" };

  const lastContactAtIso = latestTimestamp(rows);
  return {
    eligible: true,
    mailbox,
    leadId,
    creatorId,
    creatorName,
    handle,
    onelink,
    formLink,
    lastContactAtIso,
    waitedDays: waitedDaysSince(lastContactAtIso, nowIso),
  };
}

async function readEligibleProfile(profileId: string, nowIso: string, transaction?: Transaction) {
  const ref = adminDb.collection(PROFILE_COLLECTION).doc(profileId);
  const snapshot = transaction ? await transaction.get(ref) : await ref.get();
  if (!snapshot.exists) return { profile: null, eligibility: { eligible: false, reason: "profile_not_found" } as Eligibility };
  const profile = profileRow(snapshot);
  const eligibility = await eligibilityForProfile(profile, nowIso);
  return { profile, eligibility };
}

async function readEncouragementTemplate() {
  const fallback = {
    subject: "[Supercent] Super Creator Partners 제출 안내",
    body: [
      "Hi {{name}},",
      "",
      "Just checking in on your Super Creator Partners next steps.",
      "",
      "OneLink: {{onelink}}",
      "Submission form: {{form_link}}",
      "",
      "If you already submitted, please ignore this message.",
      "",
      "Best,",
      "Supercent Partnerships",
    ].join("\n"),
  };
  const snapshot = await adminDb.collection(TEMPLATE_COLLECTION).doc("encouragement").get();
  const data = snapshot.data() ?? {};
  return {
    subject: asString(data.subject, fallback.subject),
    body: asString(data.body, fallback.body),
  };
}

function renderTemplate(template: { subject: string; body: string }, values: Record<string, string>) {
  const render = (text: string) => Object.entries(values).reduce(
    (body, [key, value]) => body.replaceAll(`{{${key}}}`, value),
    text,
  );
  const subject = render(template.subject);
  const body = render(template.body);
  const missingPlaceholders = [...new Set([...subject.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g), ...body.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)].map((match) => match[1] ?? ""))].filter(Boolean);
  return {
    subject,
    body,
    preview: body.slice(0, 240),
    missingPlaceholders,
    values,
  };
}

function cadenceDocId(programId: string, identityHash: string, stage: string, slot: string): string {
  return safeMailDocId("scp_encouragement", [programId, identityHash, stage, slot].join(":"));
}

function resultDocId(programId: string, identityHash: string, stage: string, slot: string): string {
  return privateHash(["scp_encouragement_result_v1", programId, identityHash, stage, slot].join("\u0000"));
}

function addDaysIso(nowIso: string, days: number): string {
  return new Date(Date.parse(nowIso) + days * 86_400_000).toISOString();
}

export async function listScpEncouragementCandidates(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_encouragement.candidates.list", READ_ROLES);
  await assertScpEntitled(auth, request, "scp_encouragement.candidates.list");
  const data = asRecord(request.data);
  const nowIso = isoOrNull(data.nowIso) ?? new Date().toISOString();
  const states = requestedStates(data.states);
  const cardLimit = cleanPositiveInt(data.limit, 50, MAX_CARDS);
  const queryPageSize = cleanPositiveInt(data.pageSize, MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  const cards: Array<Record<string, unknown>> = [];
  const stateCounts: Record<string, number> = {};
  const ineligibleCounts: Record<string, number> = {};
  let scanned = 0;
  let totalEligible = 0;
  let cursor: DocumentSnapshot | null = null;

  do {
    let query = adminDb.collection(PROFILE_COLLECTION).orderBy(FieldPath.documentId()).limit(queryPageSize);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (snapshot.empty) break;
    cursor = snapshot.docs.at(-1) ?? null;
    for (const doc of snapshot.docs) {
      const profile = profileRow(doc);
      scanned += 1;
      if (!states.includes(asString(profile.currentState))) continue;
      const eligibility = await eligibilityForProfile(profile, nowIso);
      if (!eligibility.eligible) {
        ineligibleCounts[eligibility.reason] = (ineligibleCounts[eligibility.reason] ?? 0) + 1;
        continue;
      }
      totalEligible += 1;
      const state = asString(profile.currentState);
      stateCounts[state] = (stateCounts[state] ?? 0) + 1;
      if (cards.length < cardLimit) {
        cards.push({
          profileId: doc.id,
          programTag: asString(profile.programId),
          identityHash: asString(profile.canonicalIdentityHash),
          state,
          waitedDays: eligibility.waitedDays,
          lastContactAtIso: eligibility.lastContactAtIso,
        });
      }
    }
  } while (cursor);

  return {
    ok: true,
    states,
    scanned,
    counts: {
      eligible: totalEligible,
      states: stateCounts,
      ineligible: ineligibleCounts,
    },
    cards,
    pageInfo: { limit: cardLimit, truncated: totalEligible > cards.length, nextCursor: null },
    cache: makeCache("scp_encouragement:candidates", false, 120),
    costLog: makeCostLog("scp_encouragement.candidates.list", "mock-admin", false, scanned),
    behaviorLog: makeBehaviorLog(auth, "scp_encouragement.candidates.list", "success", "scp-automation"),
  };
}

export async function prepareScpEncouragementMail(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_encouragement.prepare_mail", WRITE_ROLES);
  await assertScpEntitled(auth, request, "scp_encouragement.prepare_mail");
  const data = asRecord(request.data);
  const nowIso = isoOrNull(data.nowIso) ?? new Date().toISOString();
  const profileId = asString(data.profileId);
  if (!profileId) {
    const error = new Error("invalid-argument: profileId is required");
    Object.assign(error, { code: "invalid-argument", errorCode: "prepare_scp_encouragement_mail_profile_id_required" });
    throw error;
  }
  const mode = data.mode === "send_approved" ? "send_approved" : "draft_only";
  if (mode !== "draft_only") {
    await assertCanonicalMailIdentityForQuota("auto_send");
    const error = new Error("failed-precondition: encouragement mail supports draft_only only");
    Object.assign(error, { code: "failed-precondition", errorCode: "prepare_scp_encouragement_mail_encouragement_mail_supports_draft_only" });
    throw error;
  }

  const stage = asString(data.encouragementStage, "initial");
  const cadenceSlot = asString(data.cadenceSlot, nowIso.slice(0, 10));
  const cooldownDays = cleanPositiveInt(data.cooldownDays, DEFAULT_COOLDOWN_DAYS, 90);
  const template = await readEncouragementTemplate();
  const settings = await readScpAutomationSettings();
  const scpGate = isHumanGateRequiredFromSettings("encouragement", "mail_send", settings);

  const transactionResult = await adminDb.runTransaction(async (transaction) => {
    const { profile, eligibility } = await readEligibleProfile(profileId, nowIso, transaction);
    if (!profile || !eligibility.eligible) {
      return {
        ok: false,
        blocked: true,
        status: "blocked" as const,
        blockedReason: eligibility.eligible ? "profile_not_found" : eligibility.reason,
      };
    }
    const programId = asString(profile.programId);
    const identityHash = asString(profile.canonicalIdentityHash);
    const cadenceRef = adminDb.collection(CADENCE_COLLECTION).doc(cadenceDocId(programId, identityHash, stage, cadenceSlot));
    const resultRef = adminDb.collection(RESULT_COLLECTION).doc(resultDocId(programId, identityHash, stage, cadenceSlot));
    const cadenceSnapshot = await transaction.get(cadenceRef);
    const cadence = cadenceSnapshot.data() ?? {};
    const nextEligibleAt = isoOrNull(cadence.nextEligibleAt);
    if (nextEligibleAt && nextEligibleAt > nowIso) {
      return {
        ok: true,
        skipped: true,
        status: "skipped" as const,
        skippedReason: "cadence_cooldown",
        nextEligibleAt,
        cadenceRef: cadenceRef.path,
        resultRef: resultRef.path,
      };
    }
    const rendered = renderTemplate(template, {
      name: eligibility.creatorName,
      email: eligibility.mailbox,
      onelink: eligibility.onelink,
      form_link: eligibility.formLink,
      adjust_link: "",
      campaign: programId,
    });
    const missingRequired = rendered.missingPlaceholders.filter((placeholder) => ["name", "onelink", "form_link"].includes(placeholder));
    if (missingRequired.length > 0) {
      return {
        ok: false,
        blocked: true,
        status: "blocked" as const,
        blockedReason: "required_placeholders_missing",
        missingRequired,
        resultRef: resultRef.path,
      };
    }
    const draftRef = `scp-encouragement-draft-${publicHash(resultRef.path)}`;
    const approvalRef = `scp-encouragement-approval-${publicHash(`${resultRef.path}:approval`)}`;
    const trackingId = `scp-encouragement-${publicHash(`${draftRef}:${approvalRef}`)}`;
    const next = addDaysIso(nowIso, cooldownDays);
    const sourceProfileVersion = Number(profile.materializedVersion ?? 0);
    transaction.set(cadenceRef, {
      id: cadenceRef.id,
      canonicalProgramId: programId,
      canonicalIdentityHash: identityHash,
      encouragementStage: stage,
      cadenceSlot,
      lastSentAt: null,
      nextEligibleAt: next,
      providerReceiptRef: null,
      sourceProfileVersion,
      lastDraftResultRef: resultRef.path,
      claimedAtIso: nowIso,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(resultRef, {
      id: resultRef.id,
      profileId,
      canonicalProgramId: programId,
      canonicalIdentityHash: identityHash,
      emailMasked: maskEmail(eligibility.mailbox),
      templateKind: "encouragement",
      templateRef: `${TEMPLATE_COLLECTION}/encouragement`,
      mode: "draft_only",
      status: "draft_only",
      source: "scp_encouragement_mail",
      draftRefHash: privateHash(draftRef),
      approvalRefHash: privateHash(approvalRef),
      trackingIdHash: privateHash(trackingId),
      subject: rendered.subject,
      bodyPreview: rendered.preview,
      missingPlaceholders: rendered.missingPlaceholders,
      scpGate,
      deliveryTruth: {
        providerConfirmed: false,
        state: "draft_only",
        reason: "draft_persisted_without_send",
      },
      cadenceRef: cadenceRef.path,
      sourceProfileVersion,
      updatedBy: auth.userId,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return {
      ok: true,
      status: "draft_only" as const,
      draft: rendered,
      resultRef: resultRef.path,
      cadenceRef: cadenceRef.path,
      scpGate,
      mailSafety: { allowed: true, severity: "ok", ruleId: "mail-safety.scp_encouragement.ok" },
      nextEligibleAt: next,
    };
  });

  return {
    ...transactionResult,
    cache: makeCache(`scp_encouragement:${publicHash(profileId)}`, false),
    costLog: makeCostLog("scp_encouragement.prepare_mail", "mock-email", false, 0),
    behaviorLog: makeBehaviorLog(
      auth,
      "scp_encouragement.prepare_mail",
      transactionResult.ok ? "success" : "blocked",
      "scp-automation",
    ),
  };
}
