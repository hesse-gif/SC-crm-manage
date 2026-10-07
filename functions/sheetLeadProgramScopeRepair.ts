import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { resolveCanonicalProgramId } from "./programCanonical";
import {
  canonicalProgramIdForSheetSourceProfile,
  knownSheetSourceProfileBySourceId,
} from "./sheetIntakeRuntime";
import {
  asRecord,
  assertNonGuestAuth,
  makeBehaviorLog,
  type CallableRequestShape,
} from "./shared";

const ACTION = "sheet_intake.repair_program_sheet_lead_scopes";
const ADMIN_ROLES = ["super_admin", "admin"] as const;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const REPAIR_VERSION = "sheet-source-profile-scope-v1";

export const PROGRAM_SHEET_LEAD_SCOPE_REPAIR_CONFIRMATION =
  "repair-program-sheet-lead-scopes-v1";

type RepairPatch = {
  canonicalProgramId: string;
  programId: string;
};

export type ProgramSheetLeadScopeRepairPlan =
  | {
      status: "repair";
      reason: "reviewed_source_profile_scope";
      canonicalProgramId: string;
      patch: RepairPatch;
    }
  | {
      status: "unchanged";
      reason: "scope_already_canonical";
      canonicalProgramId: string;
    }
  | {
      status: "human_gate";
      reason:
        | "program_scope_blank"
        | "program_scope_conflict"
        | "source_contract_scope_blank"
        | "source_contract_scope_conflict";
    }
  | {
      status: "skipped";
      reason: "unreviewed_source_profile";
    };

type RepairResult = ProgramSheetLeadScopeRepairPlan & { leadId: string };

function hasOwn(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function exactText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sourceProfileForLead(lead: Record<string, unknown>) {
  const profile = knownSheetSourceProfileBySourceId(lead.sourceId);
  if (
    !profile ||
    !profile.syncSupported ||
    profile.projectionStrategy !== "applicant_projection"
  ) {
    return null;
  }
  return profile;
}

export function planProgramSheetLeadScopeRepair(
  lead: Record<string, unknown>,
): ProgramSheetLeadScopeRepairPlan {
  const profile = sourceProfileForLead(lead);
  if (!profile) {
    return { status: "skipped", reason: "unreviewed_source_profile" };
  }
  const expected = canonicalProgramIdForSheetSourceProfile(profile);

  const sourceContract = asRecord(lead.sourceContract);
  if (hasOwn(sourceContract, "canonicalProgramId")) {
    const contractProgramId = exactText(sourceContract.canonicalProgramId);
    if (!contractProgramId) {
      return { status: "human_gate", reason: "source_contract_scope_blank" };
    }
    if (contractProgramId !== expected) {
      return { status: "human_gate", reason: "source_contract_scope_conflict" };
    }
  }

  const declaredFields = ["canonicalProgramId", "programId"] as const;
  const declared: Array<{ field: typeof declaredFields[number]; raw: string; canonical: string }> = [];
  for (const field of declaredFields) {
    if (!hasOwn(lead, field)) continue;
    const raw = exactText(lead[field]);
    if (!raw) return { status: "human_gate", reason: "program_scope_blank" };
    declared.push({ field, raw, canonical: resolveCanonicalProgramId(raw) });
  }

  const canonicalValues = Array.from(new Set(declared.map((item) => item.canonical)));
  if (
    canonicalValues.length > 1 ||
    (canonicalValues.length === 1 && canonicalValues[0] !== expected)
  ) {
    return { status: "human_gate", reason: "program_scope_conflict" };
  }

  const alreadyCanonical = declaredFields.every((field) =>
    declared.some((item) => item.field === field && item.raw === expected),
  );
  if (alreadyCanonical) {
    return {
      status: "unchanged",
      reason: "scope_already_canonical",
      canonicalProgramId: expected,
    };
  }

  return {
    status: "repair",
    reason: "reviewed_source_profile_scope",
    canonicalProgramId: expected,
    patch: { canonicalProgramId: expected, programId: expected },
  };
}

function boundedPageSize(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(value)))
    : DEFAULT_PAGE_SIZE;
}

function cursorId(value: unknown): string {
  const id = exactText(value);
  if (!id) return "";
  if (id.length > 1_500 || id.includes("/")) {
    throw Object.assign(new Error("invalid-argument: afterLeadId is invalid"), {
      code: "invalid-argument", errorCode: "cursor_id_after_lead_id_invalid",
    });
  }
  return id;
}

function resultForLead(
  leadId: string,
  lead: Record<string, unknown>,
): RepairResult {
  return { leadId, ...planProgramSheetLeadScopeRepair(lead) };
}

function summarize(results: RepairResult[]) {
  return {
    scannedCount: results.length,
    repairCount: results.filter((result) => result.status === "repair").length,
    unchangedCount: results.filter((result) => result.status === "unchanged").length,
    humanGateCount: results.filter((result) => result.status === "human_gate").length,
    skippedCount: results.filter((result) => result.status === "skipped").length,
  };
}

export async function repairLegacyProgramSheetLeadScopes(
  request: CallableRequestShape,
) {
  const auth = assertNonGuestAuth(request, ACTION, ADMIN_ROLES);
  const data = asRecord(request.data);
  const limit = boundedPageSize(data.limit);
  const afterLeadId = cursorId(data.afterLeadId);
  const dryRun = data.dryRun !== false;
  if (
    !dryRun &&
    exactText(data.confirm) !== PROGRAM_SHEET_LEAD_SCOPE_REPAIR_CONFIRMATION
  ) {
    throw Object.assign(
      new Error("failed-precondition: apply confirmation is required"),
      { code: "failed-precondition", errorCode: "repair_legacy_program_sheet_lead_scopes_apply_confirmation_required" },
    );
  }

  let query = adminDb
    .collection("program_sheet_leads")
    .orderBy(FieldPath.documentId())
    .limit(limit);
  if (afterLeadId) query = query.startAfter(afterLeadId);
  const page = await query.get();
  let results = page.docs.map((snapshot) =>
    resultForLead(snapshot.id, { id: snapshot.id, ...(snapshot.data() ?? {}) }),
  );

  if (!dryRun && page.size > 0) {
    const nowIso = new Date().toISOString();
    results = await adminDb.runTransaction(async (transaction) => {
      const current = await Promise.all(
        page.docs.map((snapshot) => transaction.get(snapshot.ref)),
      );
      const currentResults = current.map((snapshot) =>
        resultForLead(
          snapshot.id,
          snapshot.exists
            ? { id: snapshot.id, ...(snapshot.data() ?? {}) }
            : { id: snapshot.id },
        ),
      );
      currentResults.forEach((result, index) => {
        if (result.status !== "repair") return;
        transaction.set(
          page.docs[index].ref,
          {
            ...result.patch,
            programScopeSource: "reviewed_sheet_source_profile",
            programScopeRepairVersion: REPAIR_VERSION,
            programScopeRepairedAtIso: nowIso,
            programScopeRepairedBy: auth.userId,
            updatedAtIso: nowIso,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      });
      return currentResults;
    });
  }

  return {
    ok: true,
    dryRun,
    ...summarize(results),
    appliedCount: dryRun
      ? 0
      : results.filter((result) => result.status === "repair").length,
    nextLeadId: page.docs.at(-1)?.id ?? null,
    done: page.size < limit,
    results,
    behaviorLog: makeBehaviorLog(auth, ACTION, "success", "scp-automation"),
  };
}
