import { createHash, randomUUID } from "node:crypto";
import { FieldValue, type DocumentReference, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { resolveCanonicalProgramId, SCP_CANONICAL_PROGRAM_ID } from "./programCanonical";
import { readConfirmedProgramAliasRegistryStateInTransaction } from "./programAliasRegistry";
import { ensureApprovedWorkflow } from "./programs";
import {
  defaultLegacyScpProgramPolicySource,
  qualificationApplicationScopeIdentityHash,
  qualificationProgramPolicyHash,
  resolveQualificationProgramPolicySnapshot,
} from "./qualificationProgramPolicy";
import { scopedOwnerFields } from "./readScope";
import { SCP_AUTOMATION_SETTINGS_DOC } from "./scpAutomationSettings";
import { safeDocId } from "./sheetIntakeService";
import { asRecord, asString, assertNonGuestAuth, makeBehaviorLog } from "./shared";
import type { AuthContext, CallableRequestShape } from "./shared";

// SCP §9.1 — organic connection of the SCP qualification pipeline into the live
// program workflow. A confirmed-pass SCP lead (program_sheet_leads) is projected
// into a `source: "scp"` program_applications record and then run through the
// EXISTING ensureApprovedWorkflow (programs.ts) so creators/{creatorId},
// conversations, contracts and reviews all materialize exactly like a native
// program approval. This is strictly additive: the native submit/review/rate-limit
// paths are untouched; the SCP branch lives entirely in this module.
//
// creatorId follows the existing derivation convention so it stays consistent with
// creator_links (see creatorLinks.ts derivedCreatorId): if the lead already carries
// a server-written creatorId (e.g. from an issued OneLink) it is reused verbatim,
// otherwise the same `CR_<seed>` shape is derived. Unifying creatorId across every
// SCP stage is explicitly out of scope (docs/GAPS.md).

const ACTION = "scp_program_bridge.bridge_qualified_lead";
const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;
export const SCP_PROGRAM_ID = "scp";
export const PROGRAM_QUALIFICATION_ASSESSMENTS_COLLECTION = "program_qualification_assessments";
const SCP_PROGRAM_TITLE = "Super Creator Partners";
const SCP_PROGRAM_GAME_TITLE = "WeaponRPG";

export type ScpBridgeMode = "dry_run" | "bridged" | "already_bridged" | "skipped";

export interface ScpBridgeResult {
  ok: true;
  mode: ScpBridgeMode;
  leadId: string;
  programId: string;
  applicationId: string | null;
  creatorId: string | null;
  conversationId: string | null;
  contractId: string | null;
  reviewId: string | null;
  reason: string | null;
}

interface BridgeCoreParams {
  leadId: string;
  auth: AuthContext;
  dryRun: boolean;
  nowIso: string;
  applicationId?: string | null;
  canonicalProgramId?: string | null;
  qualificationPolicyHash?: string | null;
}

type LegacyScpQualificationAuthority = {
  lead: Record<string, unknown> & { id: string };
  assessmentRef: DocumentReference;
  policyHash: string;
  modelId: string;
  applicationIdentityHash: string;
  programRef: string;
  program: Record<string, unknown>;
};

function assertLegacyScpQualificationAuthority(input: {
  leadId: string;
  leadSnapshot: DocumentSnapshot;
  assessmentSnapshot: DocumentSnapshot;
  settingsSnapshot: DocumentSnapshot;
  canonicalProgramSnapshot: DocumentSnapshot;
  legacyProgramSnapshot: DocumentSnapshot;
  requestedPolicyHash?: string | null;
}): LegacyScpQualificationAuthority {
  if (!input.leadSnapshot.exists) throw failedPrecondition("authoritative SCP qualification lead not found");
  const lead = { id: input.leadSnapshot.id, ...(input.leadSnapshot.data() ?? {}) } as Record<string, unknown> & { id: string };
  if (lead.qualificationStatus !== "pass") throw failedPrecondition("legacy SCP qualificationStatus is not pass");
  const policyHash = cleanPolicyHash(lead.qualificationPolicyHash);
  if (!policyHash || (input.requestedPolicyHash && input.requestedPolicyHash !== policyHash)) {
    throw failedPrecondition("legacy SCP qualification policy hash is missing or changed");
  }
  const assessmentRef = adminDb.collection(PROGRAM_QUALIFICATION_ASSESSMENTS_COLLECTION).doc(
    programQualificationAssessmentId(SCP_CANONICAL_PROGRAM_ID, input.leadId, policyHash, null),
  );
  if (asString(lead.qualificationAssessmentRef, "") !== assessmentRef.path
    || input.assessmentSnapshot.ref.path !== assessmentRef.path
    || !input.assessmentSnapshot.exists) {
    throw failedPrecondition("legacy SCP qualification assessment is missing or changed");
  }
  if (!input.settingsSnapshot.exists) throw failedPrecondition("authoritative qualification settings not found");

  const programSnapshot = input.canonicalProgramSnapshot.exists
    ? input.canonicalProgramSnapshot
    : input.legacyProgramSnapshot.exists
      ? input.legacyProgramSnapshot
      : null;
  const programRef = programSnapshot?.ref.path ?? `programs/${SCP_PROGRAM_ID}`;
  const program = programSnapshot
    ? { id: programSnapshot.id, ...(programSnapshot.data() ?? {}) }
    : defaultLegacyScpProgramPolicySource();
  const assessment = input.assessmentSnapshot;
  const applicationIdentityHash = qualificationApplicationScopeIdentityHash({
    leadId: input.leadId,
    applicationId: null,
    rawProgramId: SCP_PROGRAM_ID,
    canonicalProgramId: SCP_CANONICAL_PROGRAM_ID,
  });
  const modelId = asString(assessment.get("qualificationPolicyModelId"), "");
  if (resolveCanonicalProgramId(assessment.get("canonicalProgramId") ?? assessment.get("programId")) !== SCP_CANONICAL_PROGRAM_ID
    || asString(assessment.get("applicationId"), "")
    || asString(assessment.get("qualificationPolicyHash"), "").toLowerCase() !== policyHash
    || asString(assessment.get("qualificationApplicationIdentityHash"), "") !== applicationIdentityHash
    || asString(assessment.get("programRef"), "") !== programRef
    || assessment.get("qualificationStatus") !== "pass"
    || !modelId) {
    throw failedPrecondition("legacy SCP qualification assessment scope changed before bridge");
  }
  const currentPolicySnapshot = resolveQualificationProgramPolicySnapshot({
    canonicalProgramId: SCP_CANONICAL_PROGRAM_ID,
    program,
    settings: input.settingsSnapshot.data() ?? {},
    modelId,
  });
  if (qualificationProgramPolicyHash(SCP_CANONICAL_PROGRAM_ID, currentPolicySnapshot) !== policyHash) {
    throw failedPrecondition("legacy SCP qualification program policy changed before bridge");
  }
  return { lead, assessmentRef, policyHash, modelId, applicationIdentityHash, programRef, program };
}

async function readLegacyScpQualificationAuthority(
  leadId: string,
  requestedPolicyHash?: string | null,
): Promise<LegacyScpQualificationAuthority> {
  const leadSnapshot = await adminDb.collection("program_sheet_leads").doc(leadId).get();
  const policyHash = cleanPolicyHash(leadSnapshot.get("qualificationPolicyHash"));
  const assessmentRef = adminDb.collection(PROGRAM_QUALIFICATION_ASSESSMENTS_COLLECTION).doc(
    programQualificationAssessmentId(SCP_CANONICAL_PROGRAM_ID, leadId, policyHash, null),
  );
  const [assessmentSnapshot, settingsSnapshot, canonicalProgramSnapshot, legacyProgramSnapshot] = await adminDb.getAll(
    assessmentRef,
    adminDb.doc(SCP_AUTOMATION_SETTINGS_DOC),
    adminDb.collection("programs").doc(SCP_CANONICAL_PROGRAM_ID),
    adminDb.collection("programs").doc(SCP_PROGRAM_ID),
  );
  return assertLegacyScpQualificationAuthority({
    leadId,
    leadSnapshot,
    assessmentSnapshot,
    settingsSnapshot,
    canonicalProgramSnapshot,
    legacyProgramSnapshot,
    requestedPolicyHash,
  });
}

async function readLegacyScpQualificationAuthorityInTransaction(
  transaction: Transaction,
  leadId: string,
  requestedPolicyHash?: string | null,
): Promise<LegacyScpQualificationAuthority> {
  const leadSnapshot = await transaction.get(adminDb.collection("program_sheet_leads").doc(leadId));
  const policyHash = cleanPolicyHash(leadSnapshot.get("qualificationPolicyHash"));
  const assessmentRef = adminDb.collection(PROGRAM_QUALIFICATION_ASSESSMENTS_COLLECTION).doc(
    programQualificationAssessmentId(SCP_CANONICAL_PROGRAM_ID, leadId, policyHash, null),
  );
  const [assessmentSnapshot, settingsSnapshot, canonicalProgramSnapshot, legacyProgramSnapshot] = await transaction.getAll(
    assessmentRef,
    adminDb.doc(SCP_AUTOMATION_SETTINGS_DOC),
    adminDb.collection("programs").doc(SCP_CANONICAL_PROGRAM_ID),
    adminDb.collection("programs").doc(SCP_PROGRAM_ID),
  );
  return assertLegacyScpQualificationAuthority({
    leadId,
    leadSnapshot,
    assessmentSnapshot,
    settingsSnapshot,
    canonicalProgramSnapshot,
    legacyProgramSnapshot,
    requestedPolicyHash,
  });
}

export function programQualificationAssessmentId(
  canonicalProgramId: unknown,
  leadId: unknown,
  qualificationPolicyHash: unknown,
  applicationId?: unknown,
): string {
  const normalizedProgramId = resolveCanonicalProgramId(canonicalProgramId);
  const cleanLeadId = safeDocId(asString(leadId, ""));
  const policyHash = asString(qualificationPolicyHash, "").toLowerCase();
  const normalizedApplicationId = cleanOptionalDocId(applicationId);
  const programToken = safeDocId(normalizedProgramId).slice(0, 48) || "missing-program";
  const digest = createHash("sha256")
    .update(JSON.stringify({
      canonicalProgramId: normalizedProgramId,
      leadId: cleanLeadId,
      applicationId: normalizedApplicationId,
      qualificationPolicyHash: policyHash,
    }))
    .digest("hex")
    .slice(0, 48);
  return safeDocId(`pqa_${programToken}_${digest}`);
}

/**
 * Callable-shaped entry point. Manager+ gated. Also invoked internally by the
 * qualification judge's confirmed-pass hook via a constructed request shape
 * (mirroring how videoReviewJudgeService calls updateReviewStatus).
 */
export async function bridgeScpQualifiedLead(request: CallableRequestShape): Promise<ScpBridgeResult & { behaviorLog: ReturnType<typeof makeBehaviorLog> }> {
  const auth = assertNonGuestAuth(request, ACTION, WRITE_ROLES);
  try {
    const data = asRecord(request.data);
    const leadId = safeDocId(asString(data.leadId ?? data.id, ""));
    if (!leadId) {
      throw Object.assign(new Error("invalid-argument: leadId required"), {
        code: "invalid-argument", errorCode: "bridge_scp_qualified_lead_lead_id_required",
        behaviorLog: makeBehaviorLog(auth, ACTION, "error", "scp-automation"),
      });
    }
    const result = await bridgeQualifiedLeadToWorkflow({
      leadId,
      auth,
      dryRun: data.dryRun === true,
      nowIso: parseNowIso(data.nowIso),
      applicationId: cleanOptionalDocId(data.applicationId),
      canonicalProgramId: asString(data.canonicalProgramId, "") || null,
      qualificationPolicyHash: cleanPolicyHash(data.qualificationPolicyHash),
    });
    return { ...result, behaviorLog: makeBehaviorLog(auth, ACTION, "success", "scp-automation") };
  } catch (error) {
    if (error && typeof error === "object" && !("behaviorLog" in error)) {
      Object.assign(error, { behaviorLog: makeBehaviorLog(auth, ACTION, "blocked", "scp-automation") });
    }
    throw error;
  }
}

/**
 * Core bridge. Loads the authoritative lead, verifies it is a confirmed pass,
 * ensures the shared `programs/scp` document, projects a `source: "scp"`
 * program_application, and reuses ensureApprovedWorkflow. Deterministic doc ids
 * make a re-confirmation an idempotent no-op.
 */
export async function bridgeQualifiedLeadToWorkflow(params: BridgeCoreParams): Promise<ScpBridgeResult> {
  const requestedCanonicalProgramId = resolveCanonicalProgramId(params.canonicalProgramId);
  if (params.applicationId || (requestedCanonicalProgramId && requestedCanonicalProgramId !== SCP_CANONICAL_PROGRAM_ID)) {
    return bridgeProgramQualifiedLeadToWorkflow(params);
  }
  const { leadId, auth, dryRun, nowIso } = params;
  const applicationId = scpApplicationId(leadId);

  const leadSnapshot = await adminDb.collection("program_sheet_leads").doc(leadId).get();
  if (!leadSnapshot.exists) {
    return skipped(leadId, applicationId, "lead not found");
  }
  const lead = { id: leadSnapshot.id, ...(leadSnapshot.data() ?? {}) } as Record<string, unknown> & { id: string };

  // Gate: only a server-confirmed pass may enter the workflow. A pending/hold/fail
  // (or unconfirmed human_assist recommendation) must never fan out into creators
  // or contracts. This is defence-in-depth on top of the judge-side finalVerdict
  // check so a manual bridge call cannot promote a non-passed lead either.
  if (asString(lead.qualificationStatus, "") !== "pass") {
    return skipped(leadId, applicationId, `qualificationStatus is not "pass"`);
  }

  // A flat status mirror is not approval authority. Resolve the immutable
  // assessment and recompute its policy against current settings/program state.
  const initialAuthority = await readLegacyScpQualificationAuthority(
    leadId,
    cleanPolicyHash(params.qualificationPolicyHash),
  );

  const creatorId = deriveScpCreatorId(initialAuthority.lead, leadId);

  // Idempotency short-circuit: a prior successful bridge stamps workflowSyncedAtIso
  // on the projected application. Re-confirmation resolves to the same doc id and
  // returns the existing pointers without re-running the fan-out.
  const existingApp = await adminDb.collection("program_applications").doc(applicationId).get();
  if (existingApp.exists && asString(existingApp.get("workflowSyncedAtIso"), "")) {
    return {
      ok: true,
      mode: "already_bridged",
      leadId,
      programId: SCP_PROGRAM_ID,
      applicationId,
      creatorId: asString(existingApp.get("creatorId"), creatorId),
      conversationId: asString(existingApp.get("conversationId"), "") || null,
      contractId: asString(existingApp.get("contractId"), "") || null,
      reviewId: asString(existingApp.get("reviewId"), "") || null,
      reason: null,
    };
  }

  const program = await ensureScpProgram(auth, dryRun, nowIso);
  const application = buildScpApplication({ lead: initialAuthority.lead, leadId, applicationId, creatorId, program, auth, nowIso });

  if (dryRun) {
    // Preview only — never touch Firestore on a dry run.
    return {
      ok: true,
      mode: "dry_run",
      leadId,
      programId: SCP_PROGRAM_ID,
      applicationId,
      creatorId,
      conversationId: null,
      contractId: null,
      reviewId: null,
      reason: null,
    };
  }

  const applicationRef = adminDb.collection("program_applications").doc(applicationId);
  const claimToken = randomUUID();
  const claimKey = qualificationBridgeClaimKey({
    canonicalProgramId: SCP_CANONICAL_PROGRAM_ID,
    leadId,
    applicationId,
    policyHash: initialAuthority.policyHash,
    applicationIdentityHash: initialAuthority.applicationIdentityHash,
  });
  const claimExpiresAtIso = new Date(Date.now() + 5 * 60_000).toISOString();
  await adminDb.runTransaction(async (transaction) => {
    const authority = await readLegacyScpQualificationAuthorityInTransaction(
      transaction,
      leadId,
      initialAuthority.policyHash,
    );
    const applicationSnapshot = await transaction.get(applicationRef);
    const existingClaim = asRecord(applicationSnapshot.get("qualificationBridgeClaim"));
    const existingClaimExpiresAt = Date.parse(asString(existingClaim.expiresAtIso, ""));
    if (existingClaim.status === "processing" && Number.isFinite(existingClaimExpiresAt) && existingClaimExpiresAt > Date.now()) {
      throw failedPrecondition("legacy SCP qualification bridge is already processing");
    }
    const qualificationBridgeClaim = {
      key: claimKey,
      token: claimToken,
      status: "processing",
      canonicalProgramId: SCP_CANONICAL_PROGRAM_ID,
      applicationId,
      leadId,
      qualificationPolicyHash: authority.policyHash,
      applicationIdentityHash: authority.applicationIdentityHash,
      programRef: authority.programRef,
      assessmentRef: authority.assessmentRef.path,
      startedAtIso: nowIso,
      expiresAtIso: claimExpiresAtIso,
    };
    transaction.set(applicationRef, {
      ...buildScpApplication({
        lead: authority.lead,
        leadId,
        applicationId,
        creatorId: deriveScpCreatorId(authority.lead, leadId),
        program,
        auth,
        nowIso,
      }),
      canonicalProgramId: SCP_CANONICAL_PROGRAM_ID,
      qualificationStatus: "pass",
      qualificationAssessmentRef: authority.assessmentRef.path,
      qualificationPolicyHash: authority.policyHash,
      qualificationPolicyModelId: authority.modelId,
      qualificationApplicationIdentityHash: authority.applicationIdentityHash,
      qualificationProgramRef: authority.programRef,
      qualificationBridgeClaim,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  let workflow: Awaited<ReturnType<typeof ensureApprovedWorkflow>>;
  try {
    workflow = await ensureApprovedWorkflow(application, program, auth, {
      authorize: async ({ transaction, application: authoritativeApplication }) => {
        const authority = await readLegacyScpQualificationAuthorityInTransaction(
          transaction,
          leadId,
          initialAuthority.policyHash,
        );
        const claim = asRecord(authoritativeApplication.qualificationBridgeClaim);
        if (asString(claim.key, "") !== claimKey
          || asString(claim.token, "") !== claimToken
          || asString(claim.status, "") !== "processing"
          || asString(authoritativeApplication.qualificationAssessmentRef, "") !== authority.assessmentRef.path
          || asString(authoritativeApplication.qualificationPolicyHash, "").toLowerCase() !== authority.policyHash
          || asString(authoritativeApplication.qualificationApplicationIdentityHash, "") !== authority.applicationIdentityHash
          || asString(authoritativeApplication.qualificationProgramRef, "") !== authority.programRef
          || authoritativeApplication.qualificationStatus !== "pass") {
          throw failedPrecondition("legacy SCP qualification authority changed before workflow fan-out");
        }
      },
      complete: ({ transaction, application: completedApplication }) => {
        const claim = asRecord(completedApplication.qualificationBridgeClaim);
        const completedClaim = {
          ...claim,
          status: "completed",
          completedAtIso: nowIso,
          expiresAtIso: nowIso,
        };
        const crossLinks = qualificationBridgeCrossLinks(
          applicationRef.path,
          SCP_CANONICAL_PROGRAM_ID,
          completedApplication,
          nowIso,
        );
        transaction.set(initialAuthority.assessmentRef, crossLinks, { merge: true });
        transaction.set(adminDb.collection("program_sheet_leads").doc(leadId), crossLinks, { merge: true });
        return { qualificationBridgeClaim: completedClaim, updatedAt: FieldValue.serverTimestamp() };
      },
    });
  } catch (error) {
    await markQualificationBridgeClaimFailed(applicationRef, claimKey, claimToken, nowIso, error);
    throw error;
  }

  return {
    ok: true,
    mode: "bridged",
    leadId,
    programId: SCP_PROGRAM_ID,
    applicationId,
    creatorId: workflow.creatorId,
    conversationId: workflow.conversationId,
    contractId: workflow.contractId,
    reviewId: workflow.reviewId,
    reason: null,
  };
}

async function bridgeProgramQualifiedLeadToWorkflow(params: BridgeCoreParams): Promise<ScpBridgeResult> {
  const { leadId, auth, dryRun, nowIso } = params;
  const applicationId = cleanOptionalDocId(params.applicationId);
  const policyHash = cleanPolicyHash(params.qualificationPolicyHash);
  if (!applicationId || !policyHash) {
    throw failedPrecondition("program-scoped qualification bridge requires applicationId and qualificationPolicyHash");
  }
  const applicationRef = adminDb.collection("program_applications").doc(applicationId);
  const claimToken = randomUUID();
  const claimExpiresAtIso = new Date(Date.now() + 5 * 60_000).toISOString();

  // This is the last authoritative boundary before workflow fan-out. The model may
  // have returned against an application/program/policy snapshot that changed while
  // it was running, so approval and the bridge lease are reserved only after every
  // identity is re-read and the current policy hash is recomputed in one transaction.
  const reservation = await adminDb.runTransaction(async (transaction) => {
    const applicationSnapshot = await transaction.get(applicationRef);
    if (!applicationSnapshot.exists) throw failedPrecondition("authoritative program application not found");
    const application = { id: applicationSnapshot.id, ...(applicationSnapshot.data() ?? {}) } as Record<string, unknown> & { id: string };
    const rawApplicationLeadId = asString(application.leadId, "") || asString(application.leadRef, "").split("/").at(-1) || "";
    const applicationLeadId = rawApplicationLeadId ? safeDocId(rawApplicationLeadId) : "";
    if (!applicationLeadId || applicationLeadId !== leadId) {
      throw failedPrecondition("program application does not belong to qualification lead");
    }

    const rawProgramId = asString(application.programId, "");
    if (!rawProgramId) throw failedPrecondition("program application is missing programId");
    const aliasRegistry = await readConfirmedProgramAliasRegistryStateInTransaction(transaction);
    const canonicalProgramId = resolveCanonicalProgramId(rawProgramId, aliasRegistry.aliasMap);
    const requestedProgramId = resolveCanonicalProgramId(params.canonicalProgramId, aliasRegistry.aliasMap);
    if (!canonicalProgramId || (requestedProgramId && requestedProgramId !== canonicalProgramId)) {
      throw failedPrecondition("requested program scope does not match authoritative application");
    }

    const canonicalProgramRef = adminDb.collection("programs").doc(safeDocId(canonicalProgramId));
    const canonicalProgramSnapshot = await transaction.get(canonicalProgramRef);
    const rawProgramRef = safeDocId(rawProgramId) === canonicalProgramRef.id
      ? canonicalProgramRef
      : adminDb.collection("programs").doc(safeDocId(rawProgramId));
    const rawProgramSnapshot = rawProgramRef.path === canonicalProgramRef.path
      ? canonicalProgramSnapshot
      : await transaction.get(rawProgramRef);
    const legacyScpProgramRef = adminDb.collection("programs").doc(SCP_PROGRAM_ID);
    const legacyScpProgramSnapshot = canonicalProgramId === SCP_CANONICAL_PROGRAM_ID
      && legacyScpProgramRef.path !== canonicalProgramRef.path
      && legacyScpProgramRef.path !== rawProgramRef.path
      ? await transaction.get(legacyScpProgramRef)
      : null;
    const programSnapshot = canonicalProgramSnapshot.exists
      ? canonicalProgramSnapshot
      : rawProgramSnapshot.exists
        ? rawProgramSnapshot
        : legacyScpProgramSnapshot;
    if (!programSnapshot?.exists) throw failedPrecondition("authoritative program configuration not found");
    const program = { id: programSnapshot.id, ...(programSnapshot.data() ?? {}) } as Record<string, unknown> & { id: string };

    const assessmentId = programQualificationAssessmentId(canonicalProgramId, leadId, policyHash, applicationId);
    const assessmentRef = adminDb.collection(PROGRAM_QUALIFICATION_ASSESSMENTS_COLLECTION).doc(assessmentId);
    const assessment = await transaction.get(assessmentRef);
    const settings = await transaction.get(adminDb.doc(SCP_AUTOMATION_SETTINGS_DOC));
    if (!settings.exists) throw failedPrecondition("authoritative qualification settings not found");
    if (!assessment.exists || assessment.get("qualificationStatus") !== "pass") {
      return {
        kind: "result" as const,
        result: scopedSkipped(leadId, canonicalProgramId, applicationId, "program-scoped qualificationStatus is not pass"),
      };
    }

    const applicationIdentityHash = qualificationApplicationScopeIdentityHash({
      leadId: applicationLeadId,
      applicationId,
      rawProgramId,
      canonicalProgramId,
    });
    const assessmentProgramId = resolveCanonicalProgramId(assessment.get("canonicalProgramId") ?? assessment.get("programId"));
    const assessmentApplicationIdentityHash = asString(assessment.get("qualificationApplicationIdentityHash"), "");
    const assessmentProgramRef = asString(assessment.get("programRef"), "");
    const qualificationPolicyModelId = asString(assessment.get("qualificationPolicyModelId"), "");
    if (assessmentProgramId !== canonicalProgramId
      || asString(assessment.get("applicationId"), "") !== applicationId
      || asString(assessment.get("qualificationPolicyHash"), "").toLowerCase() !== policyHash
      || assessmentApplicationIdentityHash !== applicationIdentityHash
      || assessmentProgramRef !== programSnapshot.ref.path
      || !qualificationPolicyModelId) {
      throw failedPrecondition("qualification assessment scope changed before bridge");
    }
    if (asString(application.qualificationAssessmentRef, "") !== assessmentRef.path
      || asString(application.qualificationPolicyHash, "").toLowerCase() !== policyHash
      || asString(application.qualificationApplicationIdentityHash, "") !== applicationIdentityHash
      || asString(application.qualificationProgramRef, "") !== programSnapshot.ref.path
      || application.qualificationStatus !== "pass") {
      throw failedPrecondition("program application qualification evidence changed before bridge");
    }

    const currentPolicySnapshot = resolveQualificationProgramPolicySnapshot({
      canonicalProgramId,
      program,
      settings: settings.data() ?? {},
      modelId: qualificationPolicyModelId,
    });
    const currentPolicyHash = qualificationProgramPolicyHash(canonicalProgramId, currentPolicySnapshot);
    if (currentPolicyHash !== policyHash) {
      throw failedPrecondition("qualification program policy changed before bridge");
    }

    const claimKey = qualificationBridgeClaimKey({ canonicalProgramId, leadId, applicationId, policyHash, applicationIdentityHash });
    const existingClaim = asRecord(application.qualificationBridgeClaim);
    const workflowResult = existingWorkflowResult(application, leadId, canonicalProgramId, applicationId);
    if (workflowResult) {
      if (!dryRun) {
        const completedClaim = {
          ...existingClaim,
          key: claimKey,
          status: "completed",
          canonicalProgramId,
          applicationId,
          leadId,
          qualificationPolicyHash: policyHash,
          applicationIdentityHash,
          completedAtIso: nowIso,
        };
        transaction.set(applicationRef, { qualificationBridgeClaim: completedClaim, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        const crossLinks = qualificationBridgeCrossLinks(applicationRef.path, canonicalProgramId, application, nowIso);
        transaction.set(assessmentRef, crossLinks, { merge: true });
        if (canonicalProgramId === SCP_CANONICAL_PROGRAM_ID) {
          transaction.set(adminDb.collection("program_sheet_leads").doc(leadId), crossLinks, { merge: true });
        }
      }
      return { kind: "result" as const, result: workflowResult };
    }

    if (dryRun) {
      return {
        kind: "result" as const,
        result: {
          ok: true as const,
          mode: "dry_run" as const,
          leadId,
          programId: canonicalProgramId,
          applicationId,
          creatorId: asString(application.creatorId, "") || deriveScpCreatorId(application, leadId),
          conversationId: null,
          contractId: null,
          reviewId: null,
          reason: null,
        },
      };
    }

    const existingClaimExpiresAt = Date.parse(asString(existingClaim.expiresAtIso, ""));
    if (existingClaim.status === "processing" && Number.isFinite(existingClaimExpiresAt) && existingClaimExpiresAt > Date.now()) {
      return {
        kind: "result" as const,
        result: scopedSkipped(leadId, canonicalProgramId, applicationId, "program qualification bridge is already processing"),
      };
    }

    const qualificationBridgeClaim = {
      key: claimKey,
      token: claimToken,
      status: "processing",
      canonicalProgramId,
      applicationId,
      leadId,
      qualificationPolicyHash: policyHash,
      applicationIdentityHash,
      programRef: programSnapshot.ref.path,
      startedAtIso: nowIso,
      expiresAtIso: claimExpiresAtIso,
    };
    transaction.set(applicationRef, {
      status: "approved",
      canonicalProgramId,
      qualificationAssessmentRef: assessmentRef.path,
      qualificationPolicyHash: policyHash,
      qualificationPolicyModelId,
      qualificationApplicationIdentityHash: applicationIdentityHash,
      qualificationProgramRef: programSnapshot.ref.path,
      qualificationApprovedAtIso: nowIso,
      qualificationBridgeClaim,
      updatedAtIso: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return {
      kind: "reserved" as const,
      application: {
        ...application,
        id: applicationId,
        programId: rawProgramId,
        status: "approved",
        canonicalProgramId,
        qualificationAssessmentRef: assessmentRef.path,
        qualificationPolicyHash: policyHash,
        qualificationPolicyModelId,
        qualificationApplicationIdentityHash: applicationIdentityHash,
        qualificationProgramRef: programSnapshot.ref.path,
        qualificationApprovedAtIso: nowIso,
        qualificationBridgeClaim,
        updatedAtIso: nowIso,
      },
      program,
      canonicalProgramId,
      assessmentRef,
      claimKey,
    };
  });

  if (reservation.kind === "result") return reservation.result;

  let workflow: Awaited<ReturnType<typeof ensureApprovedWorkflow>>;
  try {
    workflow = await ensureApprovedWorkflow(reservation.application, reservation.program, auth, {
      authorize: async ({ transaction, application }) => {
        const claim = asRecord(application.qualificationBridgeClaim);
        if (asString(claim.key, "") !== reservation.claimKey
          || asString(claim.token, "") !== claimToken
          || asString(claim.status, "") !== "processing") {
          throw failedPrecondition("qualification bridge claim changed before workflow fan-out");
        }
        const currentLeadId = asString(application.leadId, "")
          || asString(application.leadRef, "").split("/").at(-1)
          || "";
        if (safeDocId(currentLeadId) !== leadId
          || asString(application.qualificationAssessmentRef, "") !== reservation.assessmentRef.path
          || asString(application.qualificationPolicyHash, "").toLowerCase() !== policyHash
          || asString(application.qualificationApplicationIdentityHash, "") !== asString(claim.applicationIdentityHash, "")
          || asString(application.qualificationProgramRef, "") !== asString(claim.programRef, "")
          || application.qualificationStatus !== "pass") {
          throw failedPrecondition("program application qualification evidence changed before workflow fan-out");
        }

        const programRefPath = asString(claim.programRef, "");
        const qualificationPolicyModelId = asString(application.qualificationPolicyModelId, "");
        if (!programRefPath || !qualificationPolicyModelId) {
          throw failedPrecondition("qualification workflow authorization is incomplete");
        }
        const rawProgramId = asString(application.programId, "");
        const aliasRegistry = await readConfirmedProgramAliasRegistryStateInTransaction(transaction);
        const currentCanonicalProgramId = resolveCanonicalProgramId(rawProgramId, aliasRegistry.aliasMap);
        if (!currentCanonicalProgramId || currentCanonicalProgramId !== reservation.canonicalProgramId) {
          throw failedPrecondition("authoritative program alias changed before workflow fan-out");
        }
        const canonicalProgramRef = adminDb.collection("programs").doc(safeDocId(currentCanonicalProgramId));
        const rawProgramRef = adminDb.collection("programs").doc(safeDocId(rawProgramId));
        const legacyProgramRef = adminDb.collection("programs").doc(SCP_PROGRAM_ID);
        const [assessment, canonicalProgramSnapshot, rawProgramSnapshot, legacyProgramSnapshot, settings] = await Promise.all([
          transaction.get(reservation.assessmentRef),
          transaction.get(canonicalProgramRef),
          transaction.get(rawProgramRef),
          transaction.get(legacyProgramRef),
          transaction.get(adminDb.doc(SCP_AUTOMATION_SETTINGS_DOC)),
        ]);
        const programSnapshot = canonicalProgramSnapshot.exists
          ? canonicalProgramSnapshot
          : rawProgramSnapshot.exists
            ? rawProgramSnapshot
            : currentCanonicalProgramId === SCP_CANONICAL_PROGRAM_ID && legacyProgramSnapshot.exists
              ? legacyProgramSnapshot
              : null;
        if (!assessment.exists || !programSnapshot || !settings.exists) {
          throw failedPrecondition("qualification assessment changed before workflow fan-out");
        }
        if (assessment.get("qualificationStatus") !== "pass"
          || asString(assessment.get("qualificationPolicyHash"), "").toLowerCase() !== policyHash
          || asString(assessment.get("qualificationApplicationIdentityHash"), "") !== asString(claim.applicationIdentityHash, "")
          || asString(assessment.get("programRef"), "") !== programSnapshot.ref.path
          || asString(assessment.get("applicationId"), "") !== applicationId) {
          throw failedPrecondition("qualification assessment changed before workflow fan-out");
        }
        const currentPolicySnapshot = resolveQualificationProgramPolicySnapshot({
          canonicalProgramId: currentCanonicalProgramId,
          program: { id: programSnapshot.id, ...(programSnapshot.data() ?? {}) },
          settings: settings.data() ?? {},
          modelId: qualificationPolicyModelId,
        });
        if (qualificationProgramPolicyHash(reservation.canonicalProgramId, currentPolicySnapshot) !== policyHash) {
          throw failedPrecondition("qualification program policy changed before workflow fan-out");
        }
      },
      complete: ({ transaction, application }) => {
        const claim = asRecord(application.qualificationBridgeClaim);
        const completedClaim = {
          ...claim,
          status: "completed",
          completedAtIso: nowIso,
          expiresAtIso: nowIso,
        };
        const crossLinks = qualificationBridgeCrossLinks(applicationRef.path, reservation.canonicalProgramId, application, nowIso);
        transaction.set(reservation.assessmentRef, crossLinks, { merge: true });
        if (reservation.canonicalProgramId === SCP_CANONICAL_PROGRAM_ID) {
          transaction.set(adminDb.collection("program_sheet_leads").doc(leadId), crossLinks, { merge: true });
        }
        return { qualificationBridgeClaim: completedClaim, updatedAt: FieldValue.serverTimestamp() };
      },
    });
  } catch (error) {
    await markQualificationBridgeClaimFailed(applicationRef, reservation.claimKey, claimToken, nowIso, error);
    throw error;
  }

  return {
    ok: true,
    mode: "bridged",
    leadId,
    programId: reservation.canonicalProgramId,
    applicationId,
    creatorId: workflow.creatorId,
    conversationId: workflow.conversationId,
    contractId: workflow.contractId,
    reviewId: workflow.reviewId,
    reason: null,
  };
}

function qualificationBridgeClaimKey(input: {
  canonicalProgramId: string;
  leadId: string;
  applicationId: string;
  policyHash: string;
  applicationIdentityHash: string;
}): string {
  return `qbc_${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 48)}`;
}

function existingWorkflowResult(
  application: Record<string, unknown>,
  leadId: string,
  canonicalProgramId: string,
  applicationId: string,
): ScpBridgeResult | null {
  if (!asString(application.workflowSyncedAtIso, "")) return null;
  return {
    ok: true,
    mode: "already_bridged",
    leadId,
    programId: canonicalProgramId,
    applicationId,
    creatorId: asString(application.creatorId, "") || null,
    conversationId: asString(application.conversationId, "") || null,
    contractId: asString(application.contractId, "") || null,
    reviewId: asString(application.reviewId, "") || null,
    reason: null,
  };
}

function qualificationBridgeCrossLinks(
  applicationRef: string,
  canonicalProgramId: string,
  application: Record<string, unknown>,
  nowIso: string,
): Record<string, unknown> {
  return {
    bridgedApplicationRef: applicationRef,
    bridgedCreatorId: asString(application.creatorId, ""),
    bridgedProgramId: canonicalProgramId,
    workflowBridgedAtIso: nowIso,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

async function markQualificationBridgeClaimFailed(
  applicationRef: FirebaseFirestore.DocumentReference,
  claimKey: string,
  claimToken: string,
  nowIso: string,
  error: unknown,
): Promise<void> {
  await adminDb.runTransaction(async (transaction) => {
    const application = await transaction.get(applicationRef);
    if (!application.exists || asString(application.get("workflowSyncedAtIso"), "")) return;
    const claim = asRecord(application.get("qualificationBridgeClaim"));
    if (asString(claim.key, "") !== claimKey || asString(claim.token, "") !== claimToken) return;
    const errorRecord = asRecord(error);
    transaction.set(applicationRef, {
      qualificationBridgeClaim: {
        ...claim,
        status: "failed",
        failedAtIso: nowIso,
        expiresAtIso: nowIso,
        errorCode: asString(errorRecord.code ?? errorRecord.name, "internal") || "internal",
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }).catch(() => undefined);
}

function scopedSkipped(leadId: string, programId: string, applicationId: string, reason: string): ScpBridgeResult {
  return {
    ok: true,
    mode: "skipped",
    leadId,
    programId,
    applicationId,
    creatorId: null,
    conversationId: null,
    contractId: null,
    reviewId: null,
    reason,
  };
}

function skipped(leadId: string, applicationId: string, reason: string): ScpBridgeResult {
  return {
    ok: true,
    mode: "skipped",
    leadId,
    programId: SCP_PROGRAM_ID,
    applicationId,
    creatorId: null,
    conversationId: null,
    contractId: null,
    reviewId: null,
    reason,
  };
}

function scpApplicationId(leadId: string): string {
  return safeDocId(`scp-${leadId}`);
}

// Mirrors creatorLinks.derivedCreatorId so the bridged creators/{creatorId} stays
// consistent with any issued creator_links row. A server-written lead.creatorId
// (set by upsertCreatorLink) wins so the two never diverge.
function deriveScpCreatorId(lead: Record<string, unknown>, leadId: string): string {
  // Only reuse a server-written creatorId when the lead actually carries one.
  // safeDocId("") returns its non-empty "item" fallback, so guarding on the raw
  // value (not safeDocId's output) is required — otherwise every lead without a
  // creatorId would collapse to the shared "item" id.
  const rawCreatorId = asString(lead.creatorId, "");
  const existing = rawCreatorId ? safeDocId(rawCreatorId) : "";
  if (existing) return existing;
  const applicant = asRecord(lead.applicant);
  const email = cleanEmail(applicant.email ?? lead.email);
  const channelName = asString(applicant.name ?? lead.name, "");
  const seed = email || channelName || leadId || "scp-creator";
  return `CR_${safeDocId(seed).slice(0, 64) || "scp"}`;
}

async function ensureScpProgram(auth: AuthContext, dryRun: boolean, nowIso: string): Promise<Record<string, unknown>> {
  const programRef = adminDb.collection("programs").doc(SCP_PROGRAM_ID);
  const snapshot = await programRef.get();
  if (snapshot.exists) return { id: snapshot.id, ...(snapshot.data() ?? {}) };

  const ownerName = auth.name || auth.userId;
  const program: Record<string, unknown> = {
    // The first bridge may create programs/scp after Judge A has already committed
    // against the legacy fallback. Seed the exact same minimal source; normalized
    // languageGate defaults live in the policy snapshot, so creating the authoritative
    // document cannot change the effective policy hash mid-bridge.
    ...defaultLegacyScpProgramPolicySource(),
    id: SCP_PROGRAM_ID,
    slug: SCP_PROGRAM_ID,
    title: SCP_PROGRAM_TITLE,
    status: "open",
    brief: "Super Creator Partners 합격자를 계약·검수 워크플로우로 연결합니다.",
    gameTitle: SCP_PROGRAM_GAME_TITLE,
    rewardKRW: 0,
    kpiMetric: "approved",
    source: "scp_bridge",
    owner: ownerName,
    ...scopedOwnerFields(auth, ownerName),
    team: auth.team,
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
  };
  // dryRun never writes; return the in-memory default so a preview still resolves
  // a coherent program shape.
  if (!dryRun) await programRef.set(program, { merge: true });
  return program;
}

function buildScpApplication(input: {
  lead: Record<string, unknown>;
  leadId: string;
  applicationId: string;
  creatorId: string;
  program: Record<string, unknown>;
  auth: AuthContext;
  nowIso: string;
}): Record<string, unknown> {
  const { lead, leadId, applicationId, creatorId, program, auth, nowIso } = input;
  const applicant = asRecord(lead.applicant);
  const metrics = asRecord(lead.metrics);
  const email = cleanEmail(applicant.email ?? lead.email);
  const name = asString(applicant.name ?? lead.name, asString(lead.name, "SCP 신청자"));
  const youtubeUrl = asString(applicant.youtubeUrl ?? lead.youtubeUrl, "");
  const handle = asString(applicant.handle ?? lead.handle, "");
  const country = asString(applicant.country ?? lead.country, "KR");
  const category = asString(applicant.category ?? lead.category, asString(program.gameTitle, "Program"));
  const followers = nonNegativeInt(metrics.subscribers);
  const ownerName = asString(program.owner, auth.name || auth.userId);

  return {
    id: applicationId,
    programId: SCP_PROGRAM_ID,
    programSlug: asString(program.slug, SCP_PROGRAM_ID),
    programTitle: asString(program.title, SCP_PROGRAM_TITLE),
    status: "approved",
    source: "scp",
    leadId,
    leadRef: `program_sheet_leads/${leadId}`,
    creatorId,
    name,
    email,
    handle,
    youtubeUrl,
    platform: "YouTube",
    followers,
    region: country,
    category,
    protected: email === "hesse@supercent.io",
    // Owner scope so the bridged application is visible to the SCP operators under
    // the same manager account-scope rules the live program surface uses.
    ...scopedOwnerFields(auth, ownerName),
    ...(asString(program.ownerUid, "") ? { programOwnerUid: asString(program.ownerUid, "") } : {}),
    ...(asString(program.ownerEmail, "") ? { programOwnerEmail: asString(program.ownerEmail, "") } : {}),
    ...(asString(program.ownerName ?? program.owner, "") ? { programOwnerName: asString(program.ownerName ?? program.owner, "") } : {}),
    submittedAtIso: asString(applicant.submittedAt ?? lead.updatedAtIso, nowIso),
    updatedAtIso: nowIso,
  };
}

function cleanEmail(value: unknown): string {
  const raw = asString(value, "").toLowerCase().slice(0, 180);
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw) ? raw : "";
}

function nonNegativeInt(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : 0;
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function cleanOptionalDocId(value: unknown): string | null {
  const raw = asString(value, "");
  return raw ? safeDocId(raw.split("/").at(-1) ?? raw) : null;
}

function cleanPolicyHash(value: unknown): string | null {
  const raw = asString(value, "").toLowerCase();
  return /^[a-f0-9]{64}$/.test(raw) ? raw : null;
}

function failedPrecondition(message: string): Error {
  return Object.assign(new Error(`failed-precondition: ${message}`), { code: "failed-precondition", errorCode: "failed_precondition_unauthorized" });
}

function parseNowIso(value: unknown): string {
  const raw = asString(value, "");
  const date = raw ? new Date(raw) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}
