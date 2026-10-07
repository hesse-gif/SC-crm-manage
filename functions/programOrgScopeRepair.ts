import { FieldPath, FieldValue, type DocumentReference, type DocumentSnapshot, type Timestamp } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  accountOwnershipStampForTrustedLegacyOwnerRecord,
  resolveExplicitOwnershipAssignment,
  type ExplicitOwnershipAssignmentStamp,
} from "./accountOwnership";
import {
  asRecord,
  asString,
  assertNonGuestAuth,
  makeBehaviorLog,
  type CallableRequestShape,
  type Role,
} from "./shared";

export const PROGRAM_ORG_SCOPE_REPAIR_ACTION = "maintenance.repair_program_org_scopes";
export const PROGRAM_ORG_SCOPE_REPAIR_AUDIT_COLLECTION = "program_org_scope_repair_audit";
export const PROGRAM_ORG_SCOPE_REPAIR_CONFIRMATION = "repair-program-org-scopes-v1" as const;

const OPERATOR_ROLES: readonly Exclude<Role, "guest">[] = ["super_admin", "admin"];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_ASSIGNMENTS = 100;

type ProgramAssignment = {
  docId: string;
  orgId: string;
};

type ValidatedProgramAssignment = ProgramAssignment & {
  explicit: ExplicitOwnershipAssignmentStamp;
};

type RepairPlan = {
  docId: string;
  ref: DocumentReference;
  status: "stamp" | "assignment" | "unresolved" | "skipped";
  reason: string;
  patch?: Record<string, unknown>;
  ownerSignature?: string;
  targetOrgId?: string;
  sourceUpdateTime?: Timestamp;
};

type RepairResult = Pick<RepairPlan, "docId" | "targetOrgId"> & {
  status: RepairPlan["status"] | "conflict";
  reason: string;
};

function boundedLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value)))
    : DEFAULT_LIMIT;
}

function cursorId(value: unknown): string {
  const id = asString(value);
  if (!id) return "";
  if (id.length > 180 || id.includes("/")) {
    throw Object.assign(new Error("invalid-argument: afterProgramId is invalid"), {
      code: "invalid-argument",
      errorCode: "program_org_scope_repair_cursor_invalid",
    });
  }
  return id;
}

function hasOwnerOrgStamp(row: Record<string, unknown>): boolean {
  return Boolean(
    asString(row.ownerOrgId)
    || asString(row.accountOwnerOrgId)
    || asString(row.programOwnerOrgId)
    || asString(row.campaignOwnerOrgId),
  );
}

function currentOwnerOrgId(row: Record<string, unknown>): string | null {
  return asString(row.ownerOrgId)
    || asString(row.accountOwnerOrgId)
    || asString(row.programOwnerOrgId)
    || asString(row.campaignOwnerOrgId)
    || null;
}

function sourceUpdateTimeMatches(expected: Timestamp | undefined, fresh: DocumentSnapshot): boolean {
  return Boolean(expected && fresh.updateTime && expected.isEqual(fresh.updateTime));
}

function resultForPlan(plan: RepairPlan): RepairResult {
  return {
    docId: plan.docId,
    status: plan.status,
    reason: plan.reason,
    ...(plan.targetOrgId ? { targetOrgId: plan.targetOrgId } : {}),
  };
}

function legacyOwnerSignature(row: Record<string, unknown>): string {
  return JSON.stringify([
    asString(row.ownerUid),
    asString(row.createdBy),
    asString(row.accountOwnerUid),
    asString(row.programOwnerUid),
    asString(row.campaignOwnerUid),
    asString(row.ownerEmail).toLowerCase(),
    asString(row.createdByEmail).toLowerCase(),
    asString(row.accountOwnerEmail).toLowerCase(),
    asString(row.programOwnerEmail).toLowerCase(),
    asString(row.campaignOwnerEmail).toLowerCase(),
    asString(row.ownerOrgId),
    asString(row.accountOwnerOrgId),
    asString(row.programOwnerOrgId),
    asString(row.campaignOwnerOrgId),
  ]);
}

function parseAssignments(value: unknown): ProgramAssignment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ASSIGNMENTS) {
    throw Object.assign(new Error("invalid-argument: assignments must be a bounded array"), {
      code: "invalid-argument",
      errorCode: "program_org_scope_repair_assignments_invalid",
    });
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const source = asRecord(item);
    const collection = asString(source.collection) || "programs";
    const docId = asString(source.docId);
    const orgId = asString(source.orgId);
    if (collection !== "programs" || !docId || docId.length > 180 || docId.includes("/") || !orgId) {
      throw Object.assign(new Error("invalid-argument: assignments only accept programs/{docId} with orgId"), {
        code: "invalid-argument",
        errorCode: "program_org_scope_repair_assignment_invalid",
      });
    }
    if (seen.has(docId)) {
      throw Object.assign(new Error("invalid-argument: duplicate assignment docId"), {
        code: "invalid-argument",
        errorCode: "program_org_scope_repair_assignment_duplicate",
      });
    }
    seen.add(docId);
    return { docId, orgId };
  });
}

async function validateAssignments(
  request: CallableRequestShape,
  auth: ReturnType<typeof assertNonGuestAuth>,
  assignments: ProgramAssignment[],
): Promise<Map<string, ValidatedProgramAssignment>> {
  if (assignments.length === 0) return new Map();
  if (auth.role !== "super_admin") {
    throw Object.assign(new Error("permission-denied: explicit program org assignments require super_admin"), {
      code: "permission-denied",
      errorCode: "program_org_scope_repair_assignments_super_admin_required",
    });
  }
  const validated = await Promise.all(assignments.map(async (assignment) => {
    // Reuse the canonical assignment validator: official Peoply organization
    // validation is mandatory even for a super_admin, and viewAs is rejected.
    const explicit = await resolveExplicitOwnershipAssignment(auth, {
      ...request,
      data: { ownershipAssignment: { orgId: assignment.orgId } },
    });
    if (!explicit) throw new Error("program org assignment validation unexpectedly returned empty");
    return [assignment.docId, { ...assignment, explicit }] as const;
  }));
  return new Map(validated);
}

function classifyLegacyStampError(error: unknown): "unresolved" | "skipped" {
  const code = asString(asRecord(error).errorCode);
  return code === "account_ownership_legacy_scope_unavailable" || code === "account_ownership_legacy_unverified"
    ? "unresolved"
    : "skipped";
}

async function planRepair(
  snapshot: DocumentSnapshot,
  assignment: ValidatedProgramAssignment | undefined,
): Promise<RepairPlan> {
  const row = snapshot.exists ? asRecord(snapshot.data()) : {};
  if (!snapshot.exists) return { docId: snapshot.id, ref: snapshot.ref, status: "skipped", reason: "program_not_found" };
  if (assignment) {
    return {
      docId: snapshot.id,
      ref: snapshot.ref,
      status: "assignment",
      reason: "explicit_super_admin_assignment",
      targetOrgId: assignment.orgId,
      patch: {
        ...assignment.explicit.stamp,
        ownershipAssignment: assignment.explicit.assignment,
      },
      sourceUpdateTime: snapshot.updateTime,
    };
  }
  if (hasOwnerOrgStamp(row)) {
    return { docId: snapshot.id, ref: snapshot.ref, status: "skipped", reason: "owner_org_already_stamped" };
  }
  try {
    const stamp = await accountOwnershipStampForTrustedLegacyOwnerRecord(row, "program org scope repair");
    if (!stamp) {
      return { docId: snapshot.id, ref: snapshot.ref, status: "skipped", reason: "legacy_owner_missing" };
    }
    return {
      docId: snapshot.id,
      ref: snapshot.ref,
      status: "stamp",
      reason: "trusted_legacy_owner_resolved",
      targetOrgId: asString(stamp.ownerOrgId),
      patch: stamp,
      ownerSignature: legacyOwnerSignature(row),
      sourceUpdateTime: snapshot.updateTime,
    };
  } catch (error) {
    const status = classifyLegacyStampError(error);
    return {
      docId: snapshot.id,
      ref: snapshot.ref,
      status,
      reason: status === "unresolved" ? "legacy_owner_org_unresolved" : "legacy_owner_resolution_failed",
    };
  }
}

function summarize(plans: readonly RepairPlan[]) {
  const count = (status: RepairPlan["status"]) => plans.filter((plan) => plan.status === status).length;
  return {
    scanned: plans.length,
    matched: count("stamp") + count("assignment"),
    stamped: count("stamp"),
    assigned: count("assignment"),
    unresolved: count("unresolved"),
    skipped: count("skipped"),
    byCollection: {
      programs: {
        scanned: plans.length,
        matched: count("stamp") + count("assignment"),
        stamped: count("stamp"),
        assigned: count("assignment"),
        unresolved: count("unresolved"),
        skipped: count("skipped"),
      },
    },
  };
}

async function persistDryRunDocumentAudits(
  runRef: DocumentReference,
  auth: ReturnType<typeof assertNonGuestAuth>,
  plans: readonly RepairPlan[],
  nowIso: string,
): Promise<void> {
  // The scan limit is capped at 200, so this is a bounded audit trail rather
  // than a second unbounded result store. Deliberately persist only IDs,
  // classifications, and org IDs: no legacy owner fields or other PII.
  const batch = adminDb.batch();
  for (const plan of plans) {
    batch.create(adminDb.collection(PROGRAM_ORG_SCOPE_REPAIR_AUDIT_COLLECTION).doc(), {
      action: PROGRAM_ORG_SCOPE_REPAIR_ACTION,
      kind: "document_plan",
      runRef: runRef.path,
      dryRun: true,
      actorUid: auth.userId,
      actorRole: auth.role,
      collection: "programs",
      docId: plan.docId,
      status: plan.status,
      reason: plan.reason,
      targetOrgId: plan.targetOrgId ?? null,
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  if (plans.length > 0) await batch.commit();
}

async function persistApplyTerminalPlanAudits(
  runRef: DocumentReference,
  auth: ReturnType<typeof assertNonGuestAuth>,
  plans: readonly RepairPlan[],
  nowIso: string,
): Promise<number> {
  // Only skipped/unresolved plans reach this batch. Mutation plans write their
  // one terminal outcome in the same transaction as the change/conflict audit.
  const terminalPlans = plans.filter((plan) => plan.status === "skipped" || plan.status === "unresolved");
  const batch = adminDb.batch();
  for (const plan of terminalPlans) {
    batch.create(adminDb.collection(PROGRAM_ORG_SCOPE_REPAIR_AUDIT_COLLECTION).doc(), {
      action: PROGRAM_ORG_SCOPE_REPAIR_ACTION,
      kind: "document_outcome",
      runRef: runRef.path,
      dryRun: false,
      actorUid: auth.userId,
      actorRole: auth.role,
      collection: "programs",
      docId: plan.docId,
      status: plan.status,
      reason: plan.reason,
      targetOrgId: plan.targetOrgId ?? null,
      createdAtIso: nowIso,
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  if (terminalPlans.length > 0) await batch.commit();
  return terminalPlans.length;
}

export async function repairProgramOrgScopes(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, PROGRAM_ORG_SCOPE_REPAIR_ACTION, OPERATOR_ROLES);
  const data = asRecord(request.data);
  if (asString(data.viewAsUserId) || asString(data.viewAsEmail)) {
    throw Object.assign(new Error("permission-denied: program org scope repair cannot run with viewAs"), {
      code: "permission-denied",
      errorCode: "account_ownership_view_as_write_forbidden",
    });
  }
  const dryRun = data.dryRun !== false;
  if (!dryRun && asString(data.confirm) !== PROGRAM_ORG_SCOPE_REPAIR_CONFIRMATION) {
    throw Object.assign(new Error("failed-precondition: apply confirmation is required"), {
      code: "failed-precondition",
      errorCode: "program_org_scope_repair_confirmation_required",
    });
  }
  const limit = boundedLimit(data.limit);
  const afterProgramId = cursorId(data.afterProgramId);
  const assignments = parseAssignments(data.assignments);
  const validatedAssignments = await validateAssignments(request, auth, assignments);
  const nowIso = new Date().toISOString();
  const runRef = adminDb.collection(PROGRAM_ORG_SCOPE_REPAIR_AUDIT_COLLECTION).doc();

  await runRef.create({
    action: PROGRAM_ORG_SCOPE_REPAIR_ACTION,
    kind: "run",
    actorUid: auth.userId,
    actorRole: auth.role,
    dryRun,
    limit,
    afterProgramId: afterProgramId || null,
    assignmentCount: assignments.length,
    result: "started",
    createdAtIso: nowIso,
    createdAt: FieldValue.serverTimestamp(),
  });

  try {
    let query = adminDb.collection("programs").orderBy(FieldPath.documentId()).limit(limit);
    if (afterProgramId) query = query.startAfter(afterProgramId);
    const page = await query.get();
    const snapshots = new Map<string, DocumentSnapshot>(page.docs.map((snapshot) => [snapshot.id, snapshot]));
    const missingAssignmentRefs = [...validatedAssignments.keys()]
      .filter((docId) => !snapshots.has(docId))
      .map((docId) => adminDb.collection("programs").doc(docId));
    if (missingAssignmentRefs.length > 0) {
      const extra = await adminDb.getAll(...missingAssignmentRefs);
      extra.forEach((snapshot) => snapshots.set(snapshot.id, snapshot));
    }
    const plans = await Promise.all([...snapshots.values()].map((snapshot) =>
      planRepair(snapshot, validatedAssignments.get(snapshot.id)),
    ));
    if (dryRun) await persistDryRunDocumentAudits(runRef, auth, plans, nowIso);
    let applied = 0;
    let conflicted = 0;
    let documentOutcomeAuditCount = dryRun ? plans.length : await persistApplyTerminalPlanAudits(runRef, auth, plans, nowIso);
    let results = plans.map(resultForPlan);
    if (!dryRun) {
      for (const plan of plans) {
        if ((plan.status !== "stamp" && plan.status !== "assignment") || !plan.patch) continue;
        const patch = plan.patch;
        const auditRef = adminDb.collection(PROGRAM_ORG_SCOPE_REPAIR_AUDIT_COLLECTION).doc();
        const outcomeAuditRef = adminDb.collection(PROGRAM_ORG_SCOPE_REPAIR_AUDIT_COLLECTION).doc();
        const outcome = await adminDb.runTransaction(async (transaction) => {
          const fresh = await transaction.get(plan.ref);
          if (!fresh.exists || !sourceUpdateTimeMatches(plan.sourceUpdateTime, fresh)) {
            transaction.create(auditRef, {
              action: PROGRAM_ORG_SCOPE_REPAIR_ACTION,
              kind: "document_conflict",
              runRef: runRef.path,
              actorUid: auth.userId,
              actorRole: auth.role,
              collection: "programs",
              docId: plan.docId,
              changeType: plan.status,
              reason: fresh.exists ? "document_changed_since_plan" : "program_not_found_since_plan",
              previousOrgId: fresh.exists ? currentOwnerOrgId(asRecord(fresh.data())) : null,
              targetOrgId: plan.targetOrgId ?? null,
              createdAtIso: nowIso,
              createdAt: FieldValue.serverTimestamp(),
            });
            transaction.create(outcomeAuditRef, {
              action: PROGRAM_ORG_SCOPE_REPAIR_ACTION,
              kind: "document_outcome",
              runRef: runRef.path,
              dryRun: false,
              actorUid: auth.userId,
              actorRole: auth.role,
              collection: "programs",
              docId: plan.docId,
              status: "conflict",
              reason: fresh.exists ? "document_changed_since_plan" : "program_not_found_since_plan",
              targetOrgId: plan.targetOrgId ?? null,
              createdAtIso: nowIso,
              createdAt: FieldValue.serverTimestamp(),
            });
            return {
              applied: false,
              reason: fresh.exists ? "document_changed_since_plan" : "program_not_found_since_plan",
            };
          }
          const freshRow = asRecord(fresh.data());
          transaction.set(plan.ref, {
            ...patch,
            programOrgScopeRepairVersion: "program_org_scope_repair_v1",
            programOrgScopeRepairedAtIso: nowIso,
            programOrgScopeRepairedBy: auth.userId,
            updatedAtIso: nowIso,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          transaction.create(auditRef, {
            action: PROGRAM_ORG_SCOPE_REPAIR_ACTION,
            kind: "document_change",
            runRef: runRef.path,
            actorUid: auth.userId,
            actorRole: auth.role,
            collection: "programs",
            docId: plan.docId,
            changeType: plan.status,
            previousOrgId: currentOwnerOrgId(freshRow),
            targetOrgId: plan.targetOrgId ?? null,
            changedFields: Object.keys(patch).sort(),
            createdAtIso: nowIso,
            createdAt: FieldValue.serverTimestamp(),
          });
          transaction.create(outcomeAuditRef, {
            action: PROGRAM_ORG_SCOPE_REPAIR_ACTION,
            kind: "document_outcome",
            runRef: runRef.path,
            dryRun: false,
            actorUid: auth.userId,
            actorRole: auth.role,
            collection: "programs",
            docId: plan.docId,
            status: "applied",
            reason: "applied",
            targetOrgId: plan.targetOrgId ?? null,
            createdAtIso: nowIso,
            createdAt: FieldValue.serverTimestamp(),
          });
          return { applied: true, reason: "applied" };
        });
        if (outcome.applied) {
          applied += 1;
        } else {
          conflicted += 1;
          results = results.map((result) => result.docId === plan.docId
            ? { ...result, status: "conflict", reason: outcome.reason }
            : result);
        }
        documentOutcomeAuditCount += 1;
      }
    }
    const summary = summarize(plans);
    await runRef.set({
      result: "success",
      completedAtIso: new Date().toISOString(),
      ...summary,
      applied,
      conflicted,
      documentAuditCount: documentOutcomeAuditCount,
    }, { merge: true });
    return {
      ok: true,
      dryRun,
      ...summary,
      applied,
      conflicted,
      documentAuditCount: documentOutcomeAuditCount,
      auditRunId: runRef.id,
      nextProgramId: page.docs.at(-1)?.id ?? null,
      done: page.size < limit,
      results,
      behaviorLog: makeBehaviorLog(auth, PROGRAM_ORG_SCOPE_REPAIR_ACTION, "success", "scp-automation"),
    };
  } catch (error) {
    await runRef.set({ result: "error", completedAtIso: new Date().toISOString() }, { merge: true }).catch(() => undefined);
    throw error;
  }
}
