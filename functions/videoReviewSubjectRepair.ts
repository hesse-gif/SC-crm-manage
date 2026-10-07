// W122 — operator callable that repairs `unclassified:` identity sentinels in
// `scp_video_review_state` subjects, so that a legitimately approved video can reach
// Partner activation instead of fail-closing on
// `partner_activation_identity_incomplete`.
//
// SCOPE (deliberately tiny):
//   * Reads the review head + the immutable `scp_portal_creator_bindings` registry.
//   * Writes ONLY `subject.<identityField>` leaves plus an additive
//     `subjectRepairEvidence` provenance block. `state`, `revision`,
//     `contentFingerprint`, `reviewLedger`, decision history and AI evidence are never
//     read-modify-written — contrast the resubmission path, which resets state to
//     `queued` and drops AI evidence; that side effect must NOT be reproduced here.
//   * Never mints, infers, or fuzzy-matches identity. All derivation lives in
//     ./videoReviewSubjectRepairCore and is proved by the real activation guard.
//
// SAFETY RAILS:
//   * `dryRun` defaults true; applying needs `dryRun:false` + `actual:true` + the
//     confirmation literal.
//   * Applying is only possible through an explicit `targets` list, each carrying a
//     head CAS anchor (`expectedRevision` + `expectedContentFingerprint`) that is
//     re-checked INSIDE the transaction. There is no blind bulk write.
//   * Idempotent: an already-resolved subject re-runs as `noop`.
//   * Audit (LOG-P0-010): one run row for every invocation + one row per applied
//     document, written in the same transaction as the repair.
//   * SEC-P0-009: only opaque ids and field names are stored/returned/logged — no
//     email, handle, channel title, or prompt/response text.

import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  makeBehaviorLog,
  type AuthContext,
  type CallableRequestShape,
  type Role,
} from "./shared";
import { assertScpEntitled } from "./mailAccounts";
import { partnerActivationId, type PartnerActivationDocument } from "./partnerActivationCore";
import {
  parsePartnerActivationDocument,
  SCP_PARTNER_ACTIVATIONS_COLLECTION,
} from "./partnerActivationStore";
import { SCP_VIDEO_REVIEW_STATE_COLLECTION } from "./videoReviewTransitionStore";
import { reviewDocId } from "./videoReviewSubjectShape";
import {
  headFromReviewStateData,
  parseVideoReviewSubjectRepairInput,
  planVideoReviewSubjectRepair,
  subjectRepairReportRow,
  VIDEO_REVIEW_SUBJECT_REPAIR_CONFIRMATION,
  VIDEO_REVIEW_SUBJECT_REPAIR_SCHEMA_VERSION,
  type PortalCreatorBindingAuthority,
  type VideoReviewSubjectRepairInput,
  type VideoReviewSubjectRepairPlanInputActivation,
  type VideoReviewSubjectRepairPlan,
  type VideoReviewSubjectRepairReportRow,
} from "./videoReviewSubjectRepairCore";

export const VIDEO_REVIEW_SUBJECT_REPAIR_ACTION = "video_review.repair_subject_identity";
export { VIDEO_REVIEW_SUBJECT_REPAIR_CONFIRMATION };
export const VIDEO_REVIEW_SUBJECT_REPAIR_AUDIT_COLLECTION =
  "scp_video_review_subject_repair_audit";
export const PORTAL_CREATOR_BINDINGS_COLLECTION = "scp_portal_creator_bindings";

// Repairs mutate settlement-relevant identity, so the gate is the narrow admin lane used
// by the other repair callables (sheetLeadProgramScopeRepair.ts, candidateScopeRepair.ts),
// not the wider OPERATOR_ROLES used for day-to-day review transitions.
const ADMIN_ROLES: readonly Exclude<Role, "guest">[] = ["super_admin", "admin"];

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Fail-closed resolve-by-application against the immutable binding registry. Query shape
 * is byte-identical to `resolveManagementAckEnrollmentBinding`
 * (scpCreatorPipelineV3ManagementAckWiring.ts:66-101) — `sourceApplicationId ==` +
 * `status == "active"` + `limit(2)` — and `tests/w122-video-review-subject-repair.test.mjs`
 * pins the two against the same fake registry so they can never drift. The only
 * difference is that this one also returns the document id, which the repair needs as
 * the provenance anchor (`collection/docId#field`).
 *
 * A registry read failure propagates: a repair must never mistake an outage for
 * "no binding" and record that as an audited conclusion.
 *
 * Pass `transaction` on the apply lane. The registry rows are as much a CAS input as the
 * review head is: a second active binding appearing between preview and commit is the
 * "ambiguous, therefore disqualified" state, and reusing rows captured outside the
 * transaction would commit against the first binding anyway.
 */
export async function loadBindingAuthorityForApplication(
  applicationId: string,
  db: FirebaseFirestore.Firestore = adminDb,
  transaction?: FirebaseFirestore.Transaction,
): Promise<PortalCreatorBindingAuthority[]> {
  if (!applicationId) return [];
  const query = db
    .collection(PORTAL_CREATOR_BINDINGS_COLLECTION)
    .where("sourceApplicationId", "==", applicationId)
    .where("status", "==", "active")
    .limit(2);
  const matches = transaction ? await transaction.get(query) : await query.get();
  return matches.docs.map((doc) => {
    const data = doc.data() ?? {};
    return {
      docId: doc.id,
      sourceApplicationId: asString(data.sourceApplicationId),
      programId: asString(data.programId),
      status: asString(data.status),
      portalCreatorId: asString(data.portalCreatorId),
      fluCreatorId: asString(data.fluCreatorId),
      partnerId: asString(data.partnerId),
      enrollmentId: asString(data.enrollmentId),
      channelId: asString(data.channelId),
    };
  });
}

/** One audit row per (run, submission). Deterministic so a run can never double-log a target. */
/**
 * Reads the `scp_partner_activations` document the guard will branch on. The id derivation
 * is `partnerActivationId` from partnerActivationCore — the SAME one
 * partnerActivationStore.buildPartnerActivationRefs uses — so the repair probes exactly the
 * document the approval will read.
 */
export async function loadPartnerActivation(
  enrollmentId: string,
  db: FirebaseFirestore.Firestore = adminDb,
  transaction?: FirebaseFirestore.Transaction,
): Promise<PartnerActivationDocument | null> {
  if (!enrollmentId) return null;
  // `partnerActivationId` throws when its sanitized result is empty. A scan must degrade to
  // "no activation readable" for such an id rather than abort the page — the plan then stays
  // at `needs_activation_lookup`/`skip` instead of reaching `repair`, which is the safe end.
  let activationDocId: string;
  try {
    activationDocId = partnerActivationId(enrollmentId);
  } catch {
    return null;
  }
  const ref = db
    .collection(SCP_PARTNER_ACTIVATIONS_COLLECTION)
    .doc(activationDocId);
  const snapshot = transaction ? await transaction.get(ref) : await ref.get();
  return parsePartnerActivationDocument(snapshot);
}

function documentAuditRef(
  db: FirebaseFirestore.Firestore,
  runId: string,
  submissionId: string,
): FirebaseFirestore.DocumentReference {
  return db
    .collection(VIDEO_REVIEW_SUBJECT_REPAIR_AUDIT_COLLECTION)
    .doc(`${runId}_${sha256(submissionId).slice(0, 24)}`);
}

function runAuditRecord(
  auth: AuthContext,
  input: VideoReviewSubjectRepairInput,
  rows: VideoReviewSubjectRepairReportRow[],
  appliedCount: number,
  nowIso: string,
  result: "started" | "dry_run" | "applied" | "failed",
) {
  const skipReasons: Record<string, number> = {};
  for (const row of rows) {
    if (row.skipReason) skipReasons[row.skipReason] = (skipReasons[row.skipReason] ?? 0) + 1;
  }
  return {
    schemaVersion: VIDEO_REVIEW_SUBJECT_REPAIR_SCHEMA_VERSION,
    action: VIDEO_REVIEW_SUBJECT_REPAIR_ACTION,
    kind: "run",
    actorUid: auth.userId,
    actorRole: auth.role,
    actorTeam: auth.team,
    dryRun: input.dryRun,
    limit: input.limit,
    cursor: input.cursor || null,
    scannedCount: rows.length,
    repairableCount: rows.filter((row) => row.repairable).length,
    appliedCount,
    noopCount: rows.filter((row) => row.action === "noop").length,
    skippedCount: rows.filter((row) => row.action === "skip").length,
    skipReasons,
    result,
    createdAtIso: nowIso,
    createdAt: FieldValue.serverTimestamp(),
  };
}

function documentAuditRecord(
  auth: AuthContext,
  plan: VideoReviewSubjectRepairPlan,
  beforeValues: Record<string, string>,
  result: string,
  nowIso: string,
  /** The id the operator asked for. May differ from the document id (reviewDocId sanitizes). */
  requestedSubmissionId?: string,
) {
  return {
    schemaVersion: VIDEO_REVIEW_SUBJECT_REPAIR_SCHEMA_VERSION,
    action: VIDEO_REVIEW_SUBJECT_REPAIR_ACTION,
    kind: "document",
    actorUid: auth.userId,
    actorRole: auth.role,
    actorTeam: auth.team,
    submissionId: requestedSubmissionId ?? plan.submissionId,
    // The document actually read/written. Recorded separately because a submission id may
    // contain characters that reviewDocId sanitizes.
    reviewDocId: plan.submissionId,
    applicationId: plan.applicationId,
    result,
    skipReason: plan.skipReason,
    candidateEnrollmentId: plan.candidateEnrollmentId,
    activationOutcome: plan.activationOutcome,
    // Field names + the opaque ids on each side. No email/handle/title ever reaches here.
    beforeFields: beforeValues,
    afterFields: Object.fromEntries(
      Object.entries(plan.updates).map(([path, value]) => [path.replace(/^subject\./, ""), value]),
    ),
    evidence: plan.evidence ? plan.evidence.fields : [],
    authorityDocId: plan.evidence ? plan.evidence.authorityDocId : null,
    guardVerified: plan.guardVerified,
    expectedRevision: plan.observedRevision,
    expectedContentFingerprint: plan.observedContentFingerprint,
    createdAtIso: nowIso,
    createdAt: FieldValue.serverTimestamp(),
  };
}

/**
 * Two-pass planning. Pass 1 derives the candidate identity and reports which activation
 * document the guard needs; pass 2 re-plans with that document loaded. A plan can never
 * reach `repair` on pass 1, so "forgot to read the activation" is a structural
 * impossibility rather than a review finding.
 */
async function planWithActivation(
  submissionId: string,
  head: ReturnType<typeof headFromReviewStateData>,
  storedSubject: unknown,
  bindings: PortalCreatorBindingAuthority[],
  expected: { revision: number; contentFingerprint: string } | null,
  db: FirebaseFirestore.Firestore,
  transaction?: FirebaseFirestore.Transaction,
): Promise<VideoReviewSubjectRepairPlan> {
  const base = { submissionId, head, subject: storedSubject, bindings, expected };
  const firstPass = planVideoReviewSubjectRepair(base);
  if (firstPass.action !== "needs_activation_lookup") return firstPass;
  // Never synthesize the lookup. If pass 1 could not name an enrollment there is no document
  // to read, and passing `{ activation: null }` anyway would assert "no activation exists"
  // on evidence nobody gathered — exactly what the core's contract forbids. Returning the
  // first-pass plan keeps the outcome honest (`needs_activation_lookup`, never `repair`).
  if (!firstPass.candidateEnrollmentId) return firstPass;
  const activation = await loadPartnerActivation(
    firstPass.candidateEnrollmentId,
    db,
    transaction,
  );
  return planVideoReviewSubjectRepair({ ...base, activationLookup: { activation } });
}

async function inspect(
  id: string,
  expected: { revision: number; contentFingerprint: string } | null,
  db: FirebaseFirestore.Firestore,
): Promise<{
  plan: VideoReviewSubjectRepairPlan;
  storedSubject: unknown;
  bindings: PortalCreatorBindingAuthority[];
}> {
  // reviewDocId, never the raw submission id: the document id is the sanitized form, so a
  // raw lookup would miss any submission id containing `.` or `:`.
  const snapshot = await db.collection(SCP_VIDEO_REVIEW_STATE_COLLECTION).doc(reviewDocId(id)).get();
  if (!snapshot.exists) {
    return {
      plan: planVideoReviewSubjectRepair({ submissionId: id, head: null, subject: null, bindings: [] }),
      storedSubject: null,
      bindings: [],
    };
  }
  const data = snapshot.data() ?? {};
  const storedSubject = data.subject;
  const applicationId = asString(asRecord(storedSubject).applicationId);
  const bindings = applicationId ? await loadBindingAuthorityForApplication(applicationId, db) : [];
  return {
    plan: await planWithActivation(
      snapshot.id,
      headFromReviewStateData(data),
      storedSubject,
      bindings,
      expected,
      db,
    ),
    storedSubject,
    bindings,
  };
}

export async function repairVideoReviewSubjectIdentitiesHandler(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, VIDEO_REVIEW_SUBJECT_REPAIR_ACTION, ADMIN_ROLES);
  // 2026-09-27 codex adversarial review round 4 FAIL-4: scp-only review-state repair/maintenance
  // tool that can apply mutations — role alone let a non-entitled admin invoke it directly.
  await assertScpEntitled(auth, request, VIDEO_REVIEW_SUBJECT_REPAIR_ACTION);
  const input = parseVideoReviewSubjectRepairInput(request.data);
  const db = adminDb;
  const nowIso = new Date().toISOString();
  const runRef = db.collection(VIDEO_REVIEW_SUBJECT_REPAIR_AUDIT_COLLECTION).doc();

  const rows: VideoReviewSubjectRepairReportRow[] = [];
  let appliedCount = 0;
  let nextCursor = "";
  let done = true;

  // LOG-P0-010: the run row is opened BEFORE any document is touched. Closing it at the end
  // only would mean a mid-loop throw or a timeout leaves committed repairs and orphaned
  // per-document rows with no record of who started the run or under what parameters.
  await runRef.create(runAuditRecord(auth, input, [], 0, nowIso, "started"));

  try {
  if (!input.dryRun) {
    // ---- APPLY LANE: explicit, CAS-pinned targets only. ----
    const applyTargets = [
      ...new Map(input.targets.map((target) => [target.submissionId, target])).values(),
    ];
    for (const target of applyTargets) {
      const ref = db
        .collection(SCP_VIDEO_REVIEW_STATE_COLLECTION)
        .doc(reviewDocId(target.submissionId));
      const preview = await inspect(
        target.submissionId,
        { revision: target.expectedRevision, contentFingerprint: target.expectedContentFingerprint },
        db,
      );
      if (preview.plan.action !== "repair") {
        rows.push(subjectRepairReportRow(preview.plan, preview.storedSubject));
        await documentAuditRef(db, runRef.id, target.submissionId).create(
          documentAuditRecord(auth, preview.plan, {}, preview.plan.action, nowIso, target.submissionId),
        );
        continue;
      }
      // The preview only decides whether to open a transaction. Everything the decision
      // rests on — the review head, the authority rows, and the existing activation — is
      // re-read INSIDE the transaction so the commit is pinned to all three.
      const applied = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) {
          return planVideoReviewSubjectRepair({
            submissionId: target.submissionId,
            head: null,
            subject: null,
            bindings: [],
          });
        }
        const data = snapshot.data() ?? {};
        const applicationId = asString(asRecord(data.subject).applicationId);
        const bindings = applicationId
          ? await loadBindingAuthorityForApplication(applicationId, db, transaction)
          : [];
        const plan = await planWithActivation(
          snapshot.id,
          headFromReviewStateData(data),
          data.subject,
          bindings,
          {
            revision: target.expectedRevision,
            contentFingerprint: target.expectedContentFingerprint,
          },
          db,
          transaction,
        );
        if (plan.action !== "repair" || !plan.evidence) return plan;

        const storedSubject = asRecord(data.subject);
        const beforeValues = Object.fromEntries(
          plan.repairedFields.map((field) => [field, asString(storedSubject[field])]),
        );
        // Dotted leaf paths only: state / revision / contentFingerprint / reviewLedger /
        // decision evidence are untouched by construction.
        transaction.update(ref, {
          ...plan.updates,
          subjectRepairEvidence: plan.evidence,
          subjectRepairedAtIso: nowIso,
          subjectRepairedBy: auth.userId,
        });
        transaction.create(
          documentAuditRef(db, runRef.id, target.submissionId),
          documentAuditRecord(auth, plan, beforeValues, "repaired", nowIso, target.submissionId),
        );
        return plan;
      });
      if (applied.action === "repair") {
        appliedCount += 1;
      } else {
        // A refused apply is an operator action with an outcome — LOG-P0-010 records it too.
        await documentAuditRef(db, runRef.id, target.submissionId).create(
          documentAuditRecord(auth, applied, {}, applied.action, nowIso, target.submissionId),
        );
      }
      rows.push(subjectRepairReportRow(applied, preview.storedSubject));
    }
  } else if (input.submissionIds.length > 0 || input.targets.length > 0) {
    // ---- TARGETED DRY RUN ----
    const seen = new Set<string>();
    const targeted: { id: string; expected: { revision: number; contentFingerprint: string } | null }[] = [];
    for (const target of input.targets) {
      if (seen.has(target.submissionId)) continue;
      seen.add(target.submissionId);
      targeted.push({
        id: target.submissionId,
        expected: {
          revision: target.expectedRevision,
          contentFingerprint: target.expectedContentFingerprint,
        },
      });
    }
    for (const id of input.submissionIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      targeted.push({ id, expected: null });
    }
    for (const entry of targeted.slice(0, input.limit)) {
      const result = await inspect(entry.id, entry.expected, db);
      rows.push(subjectRepairReportRow(result.plan, result.storedSubject));
    }
  } else {
    // ---- CURSOR SCAN DRY RUN ---- documentId ordering only (no composite index).
    let query = db
      .collection(SCP_VIDEO_REVIEW_STATE_COLLECTION)
      .orderBy(FieldPath.documentId())
      .limit(input.limit);
    if (input.cursor) query = query.startAfter(input.cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      const data = doc.data() ?? {};
      const applicationId = asString(asRecord(data.subject).applicationId);
      const bindings = applicationId
        ? await loadBindingAuthorityForApplication(applicationId, db)
        : [];
      const plan = await planWithActivation(
        doc.id,
        headFromReviewStateData(data),
        data.subject,
        bindings,
        null,
        db,
      );
      rows.push(subjectRepairReportRow(plan, data.subject));
    }
    done = page.size < input.limit;
    nextCursor = done ? "" : (page.docs.at(-1)?.id ?? "");
  }

  } catch (error) {
    // The failure audit is best-effort: if IT fails too, the ORIGINAL error is what the
    // operator needs, so it must still be the one that propagates.
    try {
      await runRef.update({
        ...runAuditRecord(auth, input, rows, appliedCount, nowIso, "failed"),
        errorCode: asString(asRecord(error).code, "internal"),
        closedAtIso: new Date().toISOString(),
      });
    } catch (auditError) {
      console.warn(
        "[video-review-subject-repair] run_audit_close_failed",
        JSON.stringify({ runId: runRef.id, code: asString(asRecord(auditError).code, "unknown") }),
      );
    }
    throw error;
  }

  await runRef.update({
    ...runAuditRecord(auth, input, rows, appliedCount, nowIso, input.dryRun ? "dry_run" : "applied"),
    closedAtIso: new Date().toISOString(),
  });

  const skipReasons: Record<string, number> = {};
  for (const row of rows) {
    if (row.skipReason) skipReasons[row.skipReason] = (skipReasons[row.skipReason] ?? 0) + 1;
  }

  return {
    ok: true,
    dryRun: input.dryRun,
    mode: input.dryRun ? "dry_run" : "actual",
    scannedCount: rows.length,
    repairableCount: rows.filter((row) => row.repairable).length,
    appliedCount,
    noopCount: rows.filter((row) => row.action === "noop").length,
    skippedCount: rows.filter((row) => row.action === "skip").length,
    skipReasons,
    rows,
    auditRef: runRef.path,
    cursor: input.cursor || null,
    nextCursor: nextCursor || null,
    done,
    behaviorLog: makeBehaviorLog(auth, VIDEO_REVIEW_SUBJECT_REPAIR_ACTION, "success", "scp-automation"),
  };
}
