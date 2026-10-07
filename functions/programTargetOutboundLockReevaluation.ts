// 0.6.110 — reevaluateOutboundLockBlockedTargets (super_admin, dryRun default true).
//
// Why: createCampaign.liveSafetyPrecheck quarantines program targets as status:"blocked" /
// blockedReason:"mail-safety.outbound-lock" while the global outbound lock is active. The lock is
// transient but the quarantine is permanent: the only auto-release is mail-quality.email_missing, and no
// admin path exists, so a lock that lasted minutes (Snake Clash 2026-09-22 04:44) left hundreds of
// targets blocked after it cleared. This callable re-runs the SAME live safety precheck NOW (mail profile +
// hard mail safety, incl. the current outbound lock) plus the per-target eligibility checks the refill
// applies (suppression/bounce/opt-out/no-mx/role-account/complaint/blacklist via mail safety, cached
// undeliverable, prior contact within the program) and releases only targets that pass.
//
// Guarantees:
//   - never sends and never writes outreach/message docs: a released target simply becomes status:"ready"
//     again and the normal refill/send pipeline (static criteria, suppression, dedup, precheck, human gate,
//     quotas) decides everything afterwards;
//   - only targets whose ONLY block is the outbound-lock precheck are touched (status blocked +
//     blockedReason outbound-lock + blockedSource createCampaign.liveSafetyPrecheck);
//   - targets that still fail are left blocked; when the failure is a new definite reason it is recorded
//     on the doc, when the lock is still active they are left untouched;
//   - one transaction per target: compare-and-set on the FULL eligibility input read at plan time (identity,
//     scope and block fields + doc updateTime) and a re-read of the authoritative outbound lock inside the
//     transaction, so a stale verdict can never release a target;
//   - counts-only response and audit doc (no recipient data).
import { randomUUID } from "node:crypto";
import { FieldPath, FieldValue, type DocumentReference, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  campaignAllowsInflyOverlap,
  campaignTargetFromProgramTargetDoc,
  combineCampaignTargetSafety,
  filterUntouchedCampaignTargets,
  prepareCampaignOutreachDraft,
  sanitizeCampaignColdMail,
  validEmailField,
  type CampaignTarget,
} from "./admin";
import { actorUidHash } from "./autoReplyBacklog";
import { readCachedMailDeliverabilityStatuses, type MailDeliverabilityStatus } from "./mailDeliverabilityVerification";
import { OUTBOUND_ACTIVE_LOCK_RULE_ID, OUTBOUND_SAFETY_STATE_PATH, resolveOutboundSafetyBlock } from "./mailOutboundSafety";
import { resolveMailProfile } from "./mailProfiles";
import { resolveCanonicalProgramId } from "./programCanonical";
import {
  asRecord,
  asString,
  assertNonGuestAuth,
  makeBehaviorLog,
  makeDeniedBehaviorLog,
  type CallableRequestShape,
} from "./shared";

const AUDIT_ACTION = "campaign.reevaluateOutboundLockBlockedTargets";
export const OUTBOUND_LOCK_REEVALUATION_RUNS_COLLECTION = "program_target_outbound_lock_reevaluation_runs";
export const PROGRAM_CAMPAIGN_TARGETS_COLLECTION = "program_campaign_targets";
export const OUTBOUND_LOCK_PRECHECK_SOURCE = "createCampaign.liveSafetyPrecheck";
export const OUTBOUND_LOCK_REEVALUATION_SOURCE = "reevaluateOutboundLockBlockedTargets";
export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 500;
const MIN_REASON_LENGTH = 8;
const MAX_REASON_LENGTH = 500;
const HUMAN_APPROVAL_RULE_ID = "mail-safety.human-approval-required";
// Only deterministic, recipient-level verdicts are ever persisted as a new block. Everything else (emergency
// shutdown, disabled profile / live-send gate, identity or landing-link configuration, content keyword matches,
// unknown rules) is transient or deployment state: the target stays exactly as it was.
const PERSISTABLE_RECIPIENT_RULE_IDS: ReadonlySet<string> = new Set([
  "mail-safety.hard-bounce", "mail-safety.reply-optout", "mail-safety.no-mx", "mail-safety.role-account",
  "mail-safety.game-company-blacklist", "mail-safety.blocked-email", "mail-safety.blocked-domain",
  "mail-safety.suppressed-handle", "mail-safety.suppressed-contact", "mail-safety.disposable-domain",
  "mail-safety.infly-overlap",
]);
export const UNDELIVERABLE_BLOCK_REASON = "mail-quality.undeliverable_cached";
export const ALREADY_CONTACTED_BLOCK_REASON = "program-dedup.already_contacted";

export type ReevaluationOutcome =
  | "released"
  | "still_outbound_lock"
  | "blocked_other_safety"
  | "blocked_undeliverable"
  | "blocked_already_contacted"
  | "blocked_no_email"
  | "skipped_other_program"
  | "skipped_not_outbound_lock_only"
  | "cas_conflict";

export type SafetyVerdict = { allowed: boolean; ruleId?: string; reason?: string };

export type ReevaluationDeps = {
  db?: FirebaseFirestore.Firestore;
  now?: () => Date;
  newRunId?: () => string;
  /** Resolves the campaign whose mail profile / infly flag the live precheck uses. */
  loadCampaign?: (programId: string, campaignId: string) => Promise<{ id: string; data: Record<string, unknown> }>;
  /** Builds the live safety precheck for this campaign (default: the real mail-profile + hard mail safety stack). */
  buildSafetyPrecheck?: (input: { programId: string; campaign: { id: string; data: Record<string, unknown> }; nowIso: string }) => Promise<(target: CampaignTarget) => Promise<SafetyVerdict>>;
  /** Campaign policy document read INSIDE the release transaction (default: campaigns/{id}). */
  readCampaignInTx?: (tx: FirebaseFirestore.Transaction, campaignId: string) => Promise<Record<string, unknown> | null>;
  /** Authoritative global outbound lock, read INSIDE the release transaction (true = locked). */
  readOutboundLockInTx?: (tx: FirebaseFirestore.Transaction, nowIso: string) => Promise<boolean>;
  /** dryRun guard: true when settings/default and settings/policy_cache already exist (no lazy initialization). */
  settingsInitialized?: () => Promise<boolean>;
  readDeliverability?: (emails: readonly string[]) => Promise<ReadonlyMap<string, MailDeliverabilityStatus>>;
  filterUntouched?: (targets: CampaignTarget[], ctx: { programId: string; allowResendInProgram: boolean }) => Promise<{ targets: CampaignTarget[]; skipped: number }>;
  writeAudit?: (runId: string, doc: Record<string, unknown>) => Promise<void>;
};

export type ReevaluateOutboundLockBlockedTargetsResult = {
  ok: true;
  runId: string;
  dryRun: boolean;
  programId: string;
  campaignId: string;
  scanned: number;
  considered: number;
  wouldRelease: number;
  released: number;
  stillOutboundLock: number;
  blockedOtherSafety: number;
  blockedUndeliverable: number;
  blockedAlreadyContacted: number;
  blockedNoEmail: number;
  skippedOtherProgram: number;
  skippedNotOutboundLockOnly: number;
  casConflicts: number;
  lockReactivated: number;
  precheckErrors: number;
  newBlockReasonCounts: Record<string, number>;
  nextCursor: string | null;
  truncated: boolean;
  auditFinalized: boolean;
  behaviorLog: ReturnType<typeof makeBehaviorLog>;
};

/** The reason is persisted verbatim in the audit doc: refuse email addresses and phone-number-like digit runs. */
export function reasonContainsPersonalData(reason: string): boolean {
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(reason)) return true;
  return (reason.match(/\+?\d[\d\s().-]*\d/g) ?? []).some((run) => run.replace(/\D/g, "").length >= 9);
}

function viewAsRequested(data: Record<string, unknown>): boolean {
  return (typeof data.viewAsUserId === "string" && data.viewAsUserId.trim().length > 0)
    || (typeof data.viewAsEmail === "string" && data.viewAsEmail.trim().length > 0);
}

function invalidArgument(message: string, errorCode: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode });
}

/** True only for a target whose sole block is the outbound-lock live precheck. */
export function isOutboundLockPrecheckBlock(data: Record<string, unknown>): boolean {
  return asString(data.status) === "blocked"
    && asString(data.blockedReason) === OUTBOUND_ACTIVE_LOCK_RULE_ID
    && asString(data.blockedSource) === OUTBOUND_LOCK_PRECHECK_SOURCE;
}

async function defaultLoadCampaign(
  db: FirebaseFirestore.Firestore,
  programId: string,
  campaignId: string,
): Promise<{ id: string; data: Record<string, unknown> }> {
  if (campaignId) {
    const snap = await db.collection("campaigns").doc(campaignId).get();
    const data = snap.exists ? asRecord(snap.data()) : null;
    if (!data) throw Object.assign(new Error("not-found: campaign not found"), { code: "not-found", errorCode: "outbound_lock_reevaluation_campaign_not_found" });
    if (resolveCanonicalProgramId(asString(data.programId)) !== programId) {
      throw invalidArgument("campaign does not belong to this program", "outbound_lock_reevaluation_campaign_program_mismatch");
    }
    return { id: campaignId, data };
  }
  const snap = await db.collection("campaigns").where("programId", "==", programId).limit(5).get();
  if (snap.docs.length !== 1) {
    throw invalidArgument(
      `campaignId is required when the program does not have exactly one campaign (found ${snap.docs.length})`,
      "outbound_lock_reevaluation_campaign_required",
    );
  }
  return { id: snap.docs[0].id, data: asRecord(snap.docs[0].data()) };
}

/**
 * The same rendered-draft precheck createCampaign.liveSafetyPrecheck runs: prepareCampaignOutreachDraft with the
 * campaign's own cold-mail template, mail profile and infly flag (so content-based checks such as complaint /
 * emergency keywords see the text this campaign would really send).
 */
async function defaultBuildSafetyPrecheck(input: {
  programId: string;
  campaign: { id: string; data: Record<string, unknown> };
  nowIso: string;
}): Promise<(target: CampaignTarget) => Promise<SafetyVerdict>> {
  const { campaign, programId, nowIso } = input;
  const data = campaign.data;
  const gameId = asString(data.gameId, programId);
  const owner = asString(data.owner, asString(data.ownerName, "—"));
  const programSnap = await adminDb.collection("programs").doc(programId).get();
  const program = programSnap.exists ? asRecord(programSnap.data()) : {};
  const programColdMail = Object.keys(asRecord(program.coldMail)).length > 0 ? asRecord(program.coldMail) : null;
  const profileResolution = await resolveMailProfile({
    campaignId: campaign.id,
    programId,
    gameId,
    intent: "campaign_outreach",
    baseIso: nowIso,
    campaignOverride: {
      id: campaign.id,
      programId,
      gameId,
      ...(Object.keys(asRecord(data.mailProfile)).length > 0 ? { mailProfile: asRecord(data.mailProfile) } : {}),
      ...(Object.keys(asRecord(data.mailProfiles)).length > 0 ? { mailProfiles: asRecord(data.mailProfiles) } : {}),
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    },
  });
  const ctx = {
    campaignId: campaign.id,
    campaignName: asString(data.name, "자동 캠페인"),
    owner,
    gameId,
    senderName: asString(data.senderName, owner),
    campaignColdMail: sanitizeCampaignColdMail(data.coldMail, nowIso),
    programColdMail,
    profileResolution,
    allowInflyOverlap: campaignAllowsInflyOverlap(data),
  };
  return async (target) => {
    const draft = await prepareCampaignOutreachDraft(ctx, target);
    // Same queueability rule as the live precheck: a human-approval requirement is queueable, not a block.
    const safety = draft.safety;
    return {
      allowed: safety.allowed || safety.ruleId === HUMAN_APPROVAL_RULE_ID,
      ruleId: safety.ruleId,
      reason: safety.reason,
    };
  };
}

/** Everything the verdict was computed from; compared again inside the release transaction. */
const ELIGIBILITY_INPUT_FIELDS = [
  "programId", "status", "email", "candidateId", "creatorId", "name", "handle", "platform", "region", "category",
  "blockedReason", "blockedSource", "blockedAtIso", "updatedAtIso", "campaignId", "sourceCampaignId", "canonicalProgramId",
] as const;

export function eligibilityInputFingerprint(data: Record<string, unknown>): string {
  return JSON.stringify(ELIGIBILITY_INPUT_FIELDS.map((field) => data[field] ?? null));
}

/** The campaign policy inputs the precheck was built from (infly flag, profile, template, identity of the send). */
const CAMPAIGN_POLICY_FIELDS = [
  "programId", "gameId", "name", "owner", "ownerName", "senderName", "allowInflyOverlap", "mailProfile", "mailProfiles",
  "coldMail", "targetingCriteria",
] as const;

export function campaignPolicyFingerprint(data: Record<string, unknown>): string {
  return JSON.stringify(CAMPAIGN_POLICY_FIELDS.map((field) => data[field] ?? null));
}

async function defaultReadCampaignInTx(tx: FirebaseFirestore.Transaction, campaignId: string): Promise<Record<string, unknown> | null> {
  const snap = await tx.get(adminDb.collection("campaigns").doc(campaignId));
  return snap.exists ? asRecord(snap.data()) : null;
}

async function defaultReadOutboundLockInTx(tx: FirebaseFirestore.Transaction, nowIso: string): Promise<boolean> {
  const snap = await tx.get(adminDb.doc(OUTBOUND_SAFETY_STATE_PATH));
  return resolveOutboundSafetyBlock(asRecord(snap.data()), nowIso, "manual_send", "outreach").blocked;
}

type Verdict = { outcome: ReevaluationOutcome; newReason?: string; newDetail?: string };

async function planTarget(
  target: CampaignTarget,
  precheck: (target: CampaignTarget) => Promise<SafetyVerdict>,
  deliverability: ReadonlyMap<string, MailDeliverabilityStatus>,
  touched: ReadonlySet<CampaignTarget>,
): Promise<Verdict> {
  if (!validEmailField(target.email)) return { outcome: "blocked_no_email", newReason: "mail-quality.email_missing", newDetail: "no valid recipient email" };
  const safety = await precheck(target);
  if (!safety.allowed) {
    if (safety.ruleId === OUTBOUND_ACTIVE_LOCK_RULE_ID) return { outcome: "still_outbound_lock" };
    // Anything that is not a deterministic recipient-level verdict is not a fact about the target: never persist it.
    if (!PERSISTABLE_RECIPIENT_RULE_IDS.has(safety.ruleId ?? "")) throw new Error(`precheck inconclusive: ${safety.ruleId ?? "unknown"}`);
    return { outcome: "blocked_other_safety", newReason: safety.ruleId ?? "mail-safety.preflight-blocked", newDetail: safety.reason };
  }
  if (deliverability.get(validEmailField(target.email)) === "undeliverable") {
    return { outcome: "blocked_undeliverable", newReason: UNDELIVERABLE_BLOCK_REASON, newDetail: "cached deliverability verdict is undeliverable" };
  }
  if (!touched.has(target)) {
    return { outcome: "blocked_already_contacted", newReason: ALREADY_CONTACTED_BLOCK_REASON, newDetail: "recipient already contacted within this program" };
  }
  return { outcome: "released" };
}

export async function reevaluateOutboundLockBlockedTargets(
  request: CallableRequestShape,
  deps: ReevaluationDeps = {},
): Promise<ReevaluateOutboundLockBlockedTargetsResult> {
  const auth = assertNonGuestAuth(request, AUDIT_ACTION, ["super_admin"]);
  const data = asRecord(request.data);
  if (viewAsRequested(data)) {
    throw Object.assign(new Error("permission-denied: this tool does not support viewAs"), {
      code: "permission-denied",
      errorCode: "outbound_lock_reevaluation_view_as_unsupported",
      behaviorLog: makeDeniedBehaviorLog(request, AUDIT_ACTION, auth.gameId),
    });
  }
  if (data.dryRun !== undefined && typeof data.dryRun !== "boolean") {
    throw invalidArgument("dryRun must be a boolean", "outbound_lock_reevaluation_invalid_dry_run");
  }
  const dryRun = data.dryRun !== false;
  const rawProgramId = typeof data.programId === "string" ? data.programId.trim() : "";
  if (!rawProgramId) throw invalidArgument("programId is required", "outbound_lock_reevaluation_program_required");
  const programId = resolveCanonicalProgramId(rawProgramId);
  const campaignIdArg = typeof data.campaignId === "string" ? data.campaignId.trim() : "";
  if (data.campaignId !== undefined && typeof data.campaignId !== "string") {
    throw invalidArgument("campaignId must be a string", "outbound_lock_reevaluation_invalid_campaign");
  }
  let limit = DEFAULT_LIMIT;
  if (data.limit !== undefined) {
    if (typeof data.limit !== "number" || !Number.isInteger(data.limit) || data.limit < 1 || data.limit > MAX_LIMIT) {
      throw invalidArgument(`limit must be an integer 1..${MAX_LIMIT}`, "outbound_lock_reevaluation_invalid_limit");
    }
    limit = data.limit;
  }
  if (data.cursor !== undefined && data.cursor !== null && typeof data.cursor !== "string") {
    throw invalidArgument("cursor must be a string", "outbound_lock_reevaluation_invalid_cursor");
  }
  const cursor = typeof data.cursor === "string" ? data.cursor.trim() : "";
  const reason = typeof data.reason === "string" ? data.reason.trim() : "";
  if (reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) {
    throw invalidArgument(`reason is required (${MIN_REASON_LENGTH}-${MAX_REASON_LENGTH} chars)`, "outbound_lock_reevaluation_invalid_reason");
  }
  if (reasonContainsPersonalData(reason)) {
    throw invalidArgument("reason must not contain email addresses or phone numbers", "outbound_lock_reevaluation_reason_contains_pii");
  }

  const db = deps.db ?? adminDb;
  const now = deps.now ?? (() => new Date());
  const runId = (deps.newRunId ?? (() => `olr_${randomUUID()}`))();
  const loadCampaign = deps.loadCampaign ?? ((p: string, c: string) => defaultLoadCampaign(db, p, c));
  const buildSafetyPrecheck = deps.buildSafetyPrecheck ?? defaultBuildSafetyPrecheck;
  const readCampaignInTx = deps.readCampaignInTx ?? defaultReadCampaignInTx;
  const readOutboundLockInTx = deps.readOutboundLockInTx ?? defaultReadOutboundLockInTx;
  const readDeliverability = deps.readDeliverability ?? ((emails: readonly string[]) => readCachedMailDeliverabilityStatuses(emails, { db }));
  const filterUntouched = deps.filterUntouched ?? filterUntouchedCampaignTargets;
  const writeAudit = deps.writeAudit
    ?? (async (id: string, doc: Record<string, unknown>) => {
      await db.collection(OUTBOUND_LOCK_REEVALUATION_RUNS_COLLECTION).doc(id).set(doc, { merge: true });
    });

  if (dryRun) {
    // resolveMailProfile/readSettings lazily create settings/policy_cache when missing; a dry run must not.
    const initialized = deps.settingsInitialized
      ? await deps.settingsInitialized()
      : (await Promise.all([db.doc("settings/default").get(), db.doc("settings/policy_cache").get()])).every((snap) => snap.exists);
    if (!initialized) {
      throw Object.assign(new Error("failed-precondition: settings are not initialized; a dry run would have to create them"), {
        code: "failed-precondition", errorCode: "outbound_lock_reevaluation_settings_uninitialized",
      });
    }
  }
  const campaign = await loadCampaign(programId, campaignIdArg);
  const nowIso = now().toISOString();

  // Audit before any target write; failing here aborts with zero mutations.
  await writeAudit(runId, {
    runId,
    status: "started",
    action: AUDIT_ACTION,
    actorUid: auth.userId,
    actorUidHash: actorUidHash(auth.userId),
    actorRole: auth.role,
    startedAtIso: nowIso,
    dryRun,
    programId,
    campaignId: campaign.id,
    limit,
    cursor,
    reason,
  });

  const counts = {
    scanned: 0, considered: 0, wouldRelease: 0, released: 0, stillOutboundLock: 0, blockedOtherSafety: 0,
    blockedUndeliverable: 0, blockedAlreadyContacted: 0, blockedNoEmail: 0, skippedOtherProgram: 0,
    skippedNotOutboundLockOnly: 0, casConflicts: 0, lockReactivated: 0, precheckErrors: 0,
  };
  const newBlockReasonCounts: Record<string, number> = {};
  let nextCursor: string | null = null;
  let truncated = false;
  let failure: unknown = null;

  try {
    // Single-field equality + documentId order needs no composite index (programId/status are filtered below).
    let query = db.collection(PROGRAM_CAMPAIGN_TARGETS_COLLECTION)
      .where("blockedReason", "==", OUTBOUND_ACTIVE_LOCK_RULE_ID)
      .orderBy(FieldPath.documentId())
      .limit(limit);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    counts.scanned = page.docs.length;
    truncated = page.docs.length >= limit;
    nextCursor = truncated && page.docs.length > 0 ? page.docs[page.docs.length - 1].id : null;

    const candidates: Array<{ doc: QueryDocumentSnapshot; target: CampaignTarget }> = [];
    for (const doc of page.docs) {
      const docData = asRecord(doc.data());
      if (resolveCanonicalProgramId(asString(docData.programId)) !== programId) { counts.skippedOtherProgram += 1; continue; }
      if (!isOutboundLockPrecheckBlock(docData)) { counts.skippedNotOutboundLockOnly += 1; continue; }
      candidates.push({ doc, target: campaignTargetFromProgramTargetDoc(doc) });
    }
    counts.considered = candidates.length;

    if (candidates.length > 0) {
      const targets = candidates.map((item) => item.target);
      const precheck = await buildSafetyPrecheck({ programId, campaign, nowIso });
      const deliverability = await readDeliverability(targets.map((target) => target.email ?? ""));
      // Strict dedup: any prior contact in this program keeps the target out (allowResendInProgram=false).
      const untouched = await filterUntouched(targets, { programId, allowResendInProgram: false });
      const untouchedSet = new Set(untouched.targets);

      for (const { doc, target } of candidates) {
        let verdict: Verdict;
        try {
          verdict = await planTarget(target, precheck, deliverability, untouchedSet);
        } catch {
          // A precheck that cannot be evaluated leaves the target blocked and untouched (fail closed).
          counts.precheckErrors += 1;
          continue;
        }
        const before = asRecord(doc.data());
        const outcome = verdict.outcome;
        if (outcome === "still_outbound_lock") { counts.stillOutboundLock += 1; continue; }
        if (verdict.newReason) newBlockReasonCounts[verdict.newReason] = (newBlockReasonCounts[verdict.newReason] ?? 0) + 1;
        const tally = () => {
          if (outcome === "blocked_other_safety") counts.blockedOtherSafety += 1;
          else if (outcome === "blocked_undeliverable") counts.blockedUndeliverable += 1;
          else if (outcome === "blocked_already_contacted") counts.blockedAlreadyContacted += 1;
          else if (outcome === "blocked_no_email") counts.blockedNoEmail += 1;
        };
        if (dryRun) {
          if (outcome === "released") counts.wouldRelease += 1; else tally();
          continue;
        }
        const wrote = await db.runTransaction(async (tx): Promise<"written" | "raced" | "locked"> => {
          const fresh = await tx.get(doc.ref as DocumentReference);
          const freshData = fresh.exists ? asRecord(fresh.data()) : null;
          if (
            !freshData
            || !isOutboundLockPrecheckBlock(freshData)
            || eligibilityInputFingerprint(freshData) !== eligibilityInputFingerprint(before)
            || (doc.updateTime && fresh.updateTime && !doc.updateTime.isEqual(fresh.updateTime))
          ) return "raced";
          if (outcome === "released") {
            // The verdict was computed outside this transaction; refuse to release if the global lock is active now.
            if (await readOutboundLockInTx(tx, now().toISOString())) return "locked";
            // The precheck was built from the campaign policy read at plan time; refuse if it changed since.
            const freshCampaign = await readCampaignInTx(tx, campaign.id);
            if (!freshCampaign || campaignPolicyFingerprint(freshCampaign) !== campaignPolicyFingerprint(campaign.data)) return "raced";
            // Re-derive the whole verdict (suppression/safety, deliverability, prior contact) right before the
            // commit, inside the transaction callback, so the window between evaluation and write is milliseconds.
            // These external reads are not transactional; the send path re-checks all of them again.
            const recheckDeliverability = await readDeliverability([target.email ?? ""]);
            const recheckUntouched = await filterUntouched([target], { programId, allowResendInProgram: false });
            const recheck = await planTarget(target, precheck, recheckDeliverability, new Set(recheckUntouched.targets));
            if (recheck.outcome !== "released") return "raced";
            tx.update(doc.ref as DocumentReference, {
              status: "ready",
              blockedReason: FieldValue.delete(),
              blockedDetail: FieldValue.delete(),
              blockedSource: FieldValue.delete(),
              blockedAtIso: FieldValue.delete(),
              unblockedAtIso: nowIso,
              unblockedSource: OUTBOUND_LOCK_REEVALUATION_SOURCE,
              unblockedRunId: runId,
              previousBlock: {
                reason: asString(freshData.blockedReason),
                source: asString(freshData.blockedSource),
                atIso: asString(freshData.blockedAtIso),
              },
              updatedAtIso: nowIso,
              updatedAt: FieldValue.serverTimestamp(),
            });
          } else {
            tx.update(doc.ref as DocumentReference, {
              blockedReason: verdict.newReason ?? "mail-safety.preflight-blocked",
              blockedDetail: verdict.newDetail ?? "",
              blockedSource: OUTBOUND_LOCK_REEVALUATION_SOURCE,
              blockedAtIso: nowIso,
              reevaluatedRunId: runId,
              updatedAtIso: nowIso,
              updatedAt: FieldValue.serverTimestamp(),
            });
          }
          return "written";
        });
        if (wrote === "locked") { counts.lockReactivated += 1; continue; }
        if (wrote === "raced") { counts.casConflicts += 1; continue; }
        if (outcome === "released") counts.released += 1; else tally();
      }
    }
  } catch (error) {
    failure = error;
  }

  let auditFinalized = true;
  try {
    await writeAudit(runId, {
      status: failure ? "failed" : "completed",
      ...(failure ? { errorCode: asString(asRecord(failure).errorCode, "outbound_lock_reevaluation_failed") } : {}),
      finishedAtIso: now().toISOString(),
      counts: { ...counts, newBlockReasonCounts },
      nextCursor,
      truncated,
    });
  } catch (error) {
    auditFinalized = false;
    console.error("[reevaluateOutboundLockBlockedTargets] failed to finalize audit", {
      runId,
      errorCode: asString(asRecord(error).errorCode, "audit_finalize_failed"),
    });
  }
  if (failure) throw failure;

  return {
    ok: true,
    runId,
    dryRun,
    programId,
    campaignId: campaign.id,
    scanned: counts.scanned,
    considered: counts.considered,
    wouldRelease: counts.wouldRelease,
    released: counts.released,
    stillOutboundLock: counts.stillOutboundLock,
    blockedOtherSafety: counts.blockedOtherSafety,
    blockedUndeliverable: counts.blockedUndeliverable,
    blockedAlreadyContacted: counts.blockedAlreadyContacted,
    blockedNoEmail: counts.blockedNoEmail,
    skippedOtherProgram: counts.skippedOtherProgram,
    skippedNotOutboundLockOnly: counts.skippedNotOutboundLockOnly,
    casConflicts: counts.casConflicts,
    lockReactivated: counts.lockReactivated,
    precheckErrors: counts.precheckErrors,
    newBlockReasonCounts,
    nextCursor,
    truncated,
    auditFinalized,
    behaviorLog: makeBehaviorLog(auth, AUDIT_ACTION, "success"),
  };
}
