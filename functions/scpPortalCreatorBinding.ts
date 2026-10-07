import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { SCP_CANONICAL_PROGRAM_ID } from "./programCanonical";
import { isScpProgramId } from "./scpProgramAlias";
import { assertNonGuestAuth, asRecord, asString, type CallableRequestShape } from "./shared";
import { assertScpEntitled } from "./mailAccounts";
import { youtubeOAuthPortalBindingDocumentId } from "./youtubeOAuthHandoff";
import { FLU_APPLICATION_COMMAND_COLLECTION, fluApplicationApprovalCommandId } from "./scpApprovalOnboarding";
import { normalizeHandle } from "./scpLifecycleProjection";
import { makeYouTubeDataApiClient, resolveYouTubeChannelIdForHandle, type YouTubeApiClient } from "./youtubeEnrichmentService";

const ACTION = "scp_portal_creator_binding.provision";
const PORTAL_PROGRAM_ID = "view-cpm";
const BINDINGS_COLLECTION = "scp_portal_creator_bindings";
const BINDING_KEYS_COLLECTION = "scp_portal_creator_binding_keys";
const AUDIT_COLLECTION = "scp_portal_creator_binding_audit";
const AUTHORITY_VERSION = "scp-approved-workflow-binding/v1";
const ALLOWED_INPUT_KEYS = new Set([
  "channelId",
  "dryRun",
  "enrollmentId",
  "fluCreatorId",
  "partnerId",
  "portalCreatorId",
  "programId",
  "sourceApplicationId",
]);

type ProvisioningStatus = "created" | "dry_run" | "exact_duplicate";

type ProvisioningInput = {
  portalCreatorId: string;
  fluCreatorId: string;
  partnerId: string;
  programId: typeof PORTAL_PROGRAM_ID;
  enrollmentId: string;
  channelId: string;
  sourceApplicationId: string;
  dryRun: boolean;
};

type ProvisioningDeps = {
  db?: Firestore;
  now?: Date;
  // Tier 3 (approved-command path only) dependency injection — tests must never make a real
  // YouTube Data API call; production defaults to makeYouTubeDataApiClient()'s real HTTP path.
  youtubeApi?: Pick<YouTubeApiClient, "channelsList">;
};

type ImmutableBinding = Omit<ProvisioningInput, "dryRun"> & {
  sourceCreatorId: string;
  status: "active";
  sourceApplicationRef: string;
  sourceCreatorRef: string;
  sourceLeadRef: string;
  authorityVersion: typeof AUTHORITY_VERSION;
  mappingHash: string;
};

export async function provisionScpPortalCreatorBinding(
  request: CallableRequestShape,
  deps: ProvisioningDeps = {},
) {
  const auth = assertNonGuestAuth(request, ACTION, ["super_admin", "admin"]);
  // 2026-09-27 codex adversarial review round 2 sweep: an admin (not just super_admin) can call
  // this — no general-purpose UI reaches it.
  await assertScpEntitled(auth, request, ACTION);
  const input = parseInput(request.data);
  const db = deps.db ?? adminDb;
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const bindingRef = db.collection(BINDINGS_COLLECTION).doc(
    youtubeOAuthPortalBindingDocumentId(input.fluCreatorId),
  );
  const auditRef = db.collection(AUDIT_COLLECTION).doc();
  const requestDigest = mappingHash(input);

  try {
    const result = await db.runTransaction(async (transaction) => {
      const applicationRef = db.collection("program_applications").doc(input.sourceApplicationId);
      const creatorRef = db.collection("creators").doc(input.fluCreatorId);
      const [applicationSnapshot, creatorSnapshot] = await Promise.all([
        transaction.get(applicationRef),
        transaction.get(creatorRef),
      ]);
      const application = requireSnapshot(applicationSnapshot, "approved SCP program application is unavailable");
      const creator = requireSnapshot(creatorSnapshot, "authoritative Flu creator is unavailable");
      const leadRef = authoritativeLeadRef(db, application, applicationRef.path);
      const leadSnapshot = await transaction.get(leadRef);
      const lead = requireSnapshot(leadSnapshot, "authoritative SCP lead is unavailable");

      assertApplicationAuthority(application, applicationRef.path, input);
      assertCreatorAuthority(creator, creatorRef.path, applicationRef.path, input);
      assertLeadAuthority(lead, leadRef.path, applicationRef.path, input);
      assertCanonicalChannel(input.channelId, application, creator, lead);

      const immutable: ImmutableBinding = {
        portalCreatorId: input.portalCreatorId,
        fluCreatorId: input.fluCreatorId,
        partnerId: input.partnerId,
        programId: input.programId,
        enrollmentId: input.enrollmentId,
        channelId: input.channelId,
        sourceApplicationId: input.sourceApplicationId,
        sourceCreatorId: input.fluCreatorId,
        status: "active",
        sourceApplicationRef: applicationRef.path,
        sourceCreatorRef: creatorRef.path,
        sourceLeadRef: leadRef.path,
        authorityVersion: AUTHORITY_VERSION,
        mappingHash: requestDigest,
      };

      const existingSnapshot = await transaction.get(bindingRef);
      const identityKeys = bindingIdentityKeys(db, input);
      const identityKeySnapshots = await Promise.all(
        identityKeys.map((key) => transaction.get(key.ref)),
      );
      let status: ProvisioningStatus;
      if (existingSnapshot.exists) {
        assertExactBinding(existingSnapshot.data(), immutable);
        for (let index = 0; index < identityKeys.length; index += 1) {
          assertExactIdentityKey(identityKeySnapshots[index]?.data(), identityKeys[index], bindingRef.path, requestDigest);
        }
        status = "exact_duplicate";
      } else if (input.dryRun) {
        assertIdentityKeysAvailable(identityKeys, identityKeySnapshots);
        status = "dry_run";
      } else {
        assertIdentityKeysAvailable(identityKeys, identityKeySnapshots);
        transaction.create(bindingRef, {
          ...immutable,
          createdAtIso: nowIso,
        });
        for (const key of identityKeys) {
          transaction.create(key.ref, {
            authorityVersion: AUTHORITY_VERSION,
            bindingRef: bindingRef.path,
            keyHash: key.keyHash,
            keyKind: key.kind,
            mappingHash: requestDigest,
            createdAtIso: nowIso,
          });
        }
        status = "created";
      }

      transaction.create(auditRef, {
        action: ACTION,
        authorityVersion: AUTHORITY_VERSION,
        actorUid: auth.userId,
        actorRole: auth.role,
        actorTeam: auth.team,
        bindingRef: bindingRef.path,
        requestDigest,
        sourceApplicationRefHash: sha256(applicationRef.path),
        sourceCreatorRefHash: sha256(creatorRef.path),
        sourceLeadRefHash: sha256(leadRef.path),
        dryRun: input.dryRun,
        result: status,
        createdAtIso: nowIso,
      });
      return status;
    });

    return {
      ok: true,
      status: result,
      bindingRef: bindingRef.path,
      auditRef: auditRef.path,
      requestDigest,
    };
  } catch (error) {
    await writeFailureAudit({
      auditRef,
      action: ACTION,
      authorityVersion: AUTHORITY_VERSION,
      auth: { uid: auth.userId, role: auth.role, team: auth.team },
      bindingRef: bindingRef.path,
      requestDigest,
      dryRun: input.dryRun,
      nowIso,
      error,
    });
    throw error;
  }
}

function parseInput(value: unknown): ProvisioningInput {
  const data = asRecord(value);
  const unexpectedKeys = Object.keys(data).filter((key) => !ALLOWED_INPUT_KEYS.has(key));
  if (unexpectedKeys.length > 0) {
    throw invalidArgument("payload schema contains unsupported fields");
  }
  const programId = requiredIdentifier(data.programId, "programId");
  if (programId !== PORTAL_PROGRAM_ID) {
    throw invalidArgument("programId must be view-cpm");
  }
  const channelId = requiredIdentifier(data.channelId, "channelId");
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
    throw invalidArgument("channelId must be a canonical YouTube channel id");
  }
  if (data.dryRun !== undefined && typeof data.dryRun !== "boolean") {
    throw invalidArgument("dryRun must be boolean");
  }
  return {
    portalCreatorId: requiredIdentifier(data.portalCreatorId, "portalCreatorId"),
    fluCreatorId: requiredIdentifier(data.fluCreatorId, "fluCreatorId"),
    partnerId: requiredIdentifier(data.partnerId, "partnerId"),
    programId: PORTAL_PROGRAM_ID,
    enrollmentId: requiredIdentifier(data.enrollmentId, "enrollmentId"),
    channelId,
    sourceApplicationId: requiredIdentifier(data.sourceApplicationId, "sourceApplicationId"),
    dryRun: data.dryRun !== false,
  };
}

function authoritativeLeadRef(db: Firestore, application: Record<string, unknown>, applicationRef: string) {
  const leadId = requiredIdentifier(application.leadId, "authoritative application leadId");
  const expectedLeadRef = `program_sheet_leads/${leadId}`;
  if (asString(application.leadRef) !== expectedLeadRef) {
    throw failedPrecondition("authoritative application lead relation changed");
  }
  if (asString(application.id, applicationRef.split("/").at(-1) ?? "") !== applicationRef.split("/").at(-1)) {
    throw failedPrecondition("authoritative application identity changed");
  }
  return db.collection("program_sheet_leads").doc(leadId);
}

function assertApplicationAuthority(
  application: Record<string, unknown>,
  applicationRef: string,
  input: ProvisioningInput,
): void {
  if (application.status !== "approved") {
    throw failedPrecondition("source application is not approved");
  }
  if (application.source !== "scp") {
    throw failedPrecondition("source application is not an SCP application");
  }
  if (!isScpProgramId(application.programId)
    || asString(application.canonicalProgramId) !== SCP_CANONICAL_PROGRAM_ID) {
    throw failedPrecondition("source application is outside the canonical SCP program");
  }
  if (!validIso(application.workflowSyncedAtIso)) {
    throw failedPrecondition("source application workflow is not synchronized");
  }
  if (asString(application.creatorId) !== input.fluCreatorId) {
    throw failedPrecondition("source application creator relation changed");
  }
  if (applicationRef !== `program_applications/${input.sourceApplicationId}`) {
    throw failedPrecondition("source application identity changed");
  }
}

function assertCreatorAuthority(
  creator: Record<string, unknown>,
  creatorRef: string,
  applicationRef: string,
  input: ProvisioningInput,
): void {
  if (creatorRef !== `creators/${input.fluCreatorId}`
    || asString(creator.id, input.fluCreatorId) !== input.fluCreatorId) {
    throw failedPrecondition("authoritative Flu creator identity changed");
  }
  if (creator.source !== "program_application") {
    throw failedPrecondition("authoritative Flu creator application relation changed");
  }
  // Current production creators predate profileSourceRef. Their application
  // relation is still proved twice by application.creatorId and the qualified
  // lead bridge. If either newer profile field is present, require the full
  // exact pair so a partial or conflicting migration fails closed.
  const profileSource = asString(creator.profileSource);
  const profileSourceRef = asString(creator.profileSourceRef);
  if ((profileSource || profileSourceRef)
    && (profileSource !== "program_application" || profileSourceRef !== applicationRef)) {
    throw failedPrecondition("authoritative Flu creator application relation changed");
  }
  if (!profileSource && !profileSourceRef && !isScpProgramId(creator.programId)) {
    throw failedPrecondition("authoritative Flu creator program relation changed");
  }
}

function assertLeadAuthority(
  lead: Record<string, unknown>,
  leadRef: string,
  applicationRef: string,
  input: ProvisioningInput,
): void {
  if (asString(lead.id, leadRef.split("/").at(-1) ?? "") !== leadRef.split("/").at(-1)) {
    throw failedPrecondition("authoritative SCP lead identity changed");
  }
  if (lead.qualificationStatus !== "pass") {
    throw failedPrecondition("authoritative SCP lead is not qualified");
  }
  if (asString(lead.bridgedApplicationRef) !== applicationRef
    || asString(lead.bridgedCreatorId) !== input.fluCreatorId) {
    throw failedPrecondition("authoritative SCP bridge relation changed");
  }
}

function assertCanonicalChannel(
  requestedChannelId: string,
  application: Record<string, unknown>,
  creator: Record<string, unknown>,
  lead: Record<string, unknown>,
): void {
  const candidates = new Set<string>();
  for (const value of [
    application.channelId,
    application.youtubeChannelId,
    creator.channelId,
    creator.youtubeChannelId,
    asRecord(lead.metrics).channelId,
    asRecord(lead.channel).id,
    asRecord(lead.channel).channelId,
    channelIdFromUrl(application.youtubeUrl),
    channelIdFromUrl(creator.youtubeUrl),
    channelIdFromUrl(lead.youtubeUrl),
    channelIdFromUrl(asRecord(lead.applicant).youtubeUrl),
  ]) {
    const channelId = asString(value);
    if (channelId) candidates.add(channelId);
  }
  if (candidates.size !== 1 || !candidates.has(requestedChannelId)) {
    throw failedPrecondition("canonical channel authority conflicts with requested channelId");
  }
}

function channelIdFromUrl(value: unknown): string {
  const match = /(?:youtube\.com\/channel\/)(UC[A-Za-z0-9_-]{22})(?:[/?#]|$)/i.exec(asString(value));
  return match?.[1] ?? "";
}

function assertExactBinding<T extends Record<string, unknown>>(value: unknown, expected: T): void {
  const stored = asRecord(value);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (stored[key] !== expectedValue) {
      throw failedPrecondition(`immutable binding conflict: ${key}`);
    }
  }
}

function bindingIdentityKeys(
  db: Firestore,
  input: Pick<ProvisioningInput, "portalCreatorId" | "programId" | "enrollmentId" | "channelId">,
) {
  const definitions = [
    { kind: "portal_creator" as const, value: input.portalCreatorId },
    { kind: "portal_enrollment" as const, value: `${input.programId}\0${input.enrollmentId}` },
    { kind: "youtube_channel" as const, value: input.channelId },
  ];
  return definitions.map(({ kind, value }) => {
    const keyHash = sha256(value);
    return {
      kind,
      keyHash,
      ref: db.collection(BINDING_KEYS_COLLECTION).doc(`${kind}_${keyHash.slice(0, 40)}`),
    };
  });
}

function assertIdentityKeysAvailable(
  keys: ReturnType<typeof bindingIdentityKeys>,
  snapshots: FirebaseFirestore.DocumentSnapshot[],
): void {
  const occupied = snapshots.findIndex((snapshot) => snapshot.exists);
  if (occupied >= 0) {
    throw failedPrecondition(`immutable binding conflict: ${keys[occupied]?.kind ?? "identity"}`);
  }
}

function assertExactIdentityKey(
  value: unknown,
  key: ReturnType<typeof bindingIdentityKeys>[number] | undefined,
  bindingRef: string,
  expectedMappingHash: string,
  authorityVersion: string = AUTHORITY_VERSION,
): void {
  const stored = asRecord(value);
  if (!key
    || stored.authorityVersion !== authorityVersion
    || stored.bindingRef !== bindingRef
    || stored.keyHash !== key.keyHash
    || stored.keyKind !== key.kind
    || stored.mappingHash !== expectedMappingHash) {
    throw failedPrecondition(`immutable binding key conflict: ${key?.kind ?? "identity"}`);
  }
}

async function writeFailureAudit(
  input: {
    auditRef: FirebaseFirestore.DocumentReference;
    action: string;
    authorityVersion: string;
    auth: { uid: string; role: string; team: string };
    bindingRef: string;
    requestDigest: string;
    dryRun: boolean;
    nowIso: string;
    error: unknown;
  },
): Promise<void> {
  const errorRecord = asRecord(input.error);
  await input.auditRef.create({
    action: input.action,
    authorityVersion: input.authorityVersion,
    actorUid: input.auth.uid,
    actorRole: input.auth.role,
    actorTeam: input.auth.team,
    bindingRef: input.bindingRef,
    requestDigest: input.requestDigest,
    dryRun: input.dryRun,
    result: "rejected",
    errorCode: asString(errorRecord.code, "internal"),
    createdAtIso: input.nowIso,
  });
}

function requireSnapshot(
  snapshot: FirebaseFirestore.DocumentSnapshot,
  message: string,
): Record<string, unknown> {
  if (!snapshot.exists) throw failedPrecondition(message);
  return asRecord(snapshot.data());
}

function mappingHash(value: Omit<ProvisioningInput, "dryRun"> | ProvisioningInput): string {
  return sha256(JSON.stringify({
    channelId: value.channelId,
    enrollmentId: value.enrollmentId,
    fluCreatorId: value.fluCreatorId,
    partnerId: value.partnerId,
    portalCreatorId: value.portalCreatorId,
    programId: value.programId,
    sourceApplicationId: value.sourceApplicationId,
  }));
}

function requiredIdentifier(value: unknown, field: string): string {
  const result = asString(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(result)) {
    throw invalidArgument(`${field} is invalid`);
  }
  return result;
}

function validIso(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode: "invalid_argument_unauthorized" });
}

function failedPrecondition(message: string): Error {
  return Object.assign(new Error(`failed-precondition: ${message}`), { code: "failed-precondition", errorCode: "failed_precondition_unauthorized" });
}

// ---- Portal-approved-command authority path (v2 lineage) ------------------------------------
//
// WHY THIS PATH EXISTS: the Sheet-era authority above requires an approved `program_applications`
// doc + a qualified `program_sheet_leads` bridge. Applications born through the Portal lineage
// never create those records, so approved Portal applications sit behind
// `partner_activation_identity_incomplete` forever (`scp_video_review_state.subject` stays an
// `unclassified:` sentinel — partnerActivationCore.ts's isResolvedIdentityString fails closed on
// it) with no engine able to materialize a binding for them.
//
// AUTHORITY ROOT: Portal's approval command contract v2 (`scp.flu.application-command.v2`,
// accepted by scpFluApplicationCommand.ts) now carries `portalCreatorId` on the immutable
// `scp_flu_application_commands/flu_application_approval_command_<applicationId>_...` document,
// alongside the server-stamped `approvedByActorId`/`approvedAtIso` attribution
// (scpApprovalOnboarding.ts already treats this document as authoritative for onboarding). This
// path reuses exactly that document as its identity root — every field is read from Firestore and
// byte-compared; the operator only supplies the ids to verify, never asserts identity outright:
//   1. the approval command exists, is on the v2 contract, and its stored `portalCreatorId` is
//      non-empty, non-sentinel, and byte-equal to the requested `portalCreatorId`; its approval
//      attribution (`approvedByActorId`/`approvedAtIso`) is present (LOG-P0-010);
//   2. `scp_application_management/{applicationId}` exists (classification is READ nowhere here —
//      touching it would enqueue a parked onboarding mail, which is explicitly out of scope);
//   3. `creators/{fluCreatorId}` exists and its `youtubeChannelId` (falling back to `channelId`)
//      is byte-equal to the requested `channelId` — the guard against binding the wrong creator.
//
// DERIVATION (audited, deterministic, no operator-suppliable partnerId/enrollmentId): mirrors
// scpPortalApplyBindingAuthority.ts's `hexToAlpha(sha256(...))` digit-free-alphabet style so both
// engines share one auditable derivation shape. The "-pa-" infix (portal-approved) keeps this
// lineage's ids namespace-distinct from the v3-apply engine's `partner-<alpha>`/`enrollment-<alpha>`
// ids — same input always produces the same output, recorded verbatim in the binding doc's
// `mintDerivation` field and in this comment.
//
// WRITE PATH: unchanged — the immutable binding document, its three identity keys, and the audit
// trail all go through the exact same collections, doc-id scheme, and transaction/idempotency
// shape as the Sheet-era path above (`assertExactBinding`/`bindingIdentityKeys`/
// `assertIdentityKeysAvailable`/`assertExactIdentityKey`/`writeFailureAudit`, all reused verbatim
// or widened, never re-implemented). `scp_application_management.classification` is never written.

const APPROVED_ACTION = "scp_portal_creator_binding.provision_approved";
const APPROVED_COMMAND_CONTRACT_VERSION = "scp.flu.application-command.v2" as const;
const APPROVED_AUTHORITY_VERSION = "scp-portal-approved-command-binding/v1" as const;
const APPROVED_AUTHORITY_KIND = "portal_approved_command_v2" as const;
const APPROVED_IDENTITY_SENTINELS = new Set(["unclassified", "unknown", "none", "null"]);
const MANAGEMENT_COLLECTION = "scp_application_management";

const APPROVED_ALLOWED_INPUT_KEYS = new Set([
  "applicationId",
  "channelId",
  "dryRun",
  "fluCreatorId",
  "portalCreatorId",
]);

type ApprovedProvisioningInput = {
  applicationId: string;
  portalCreatorId: string;
  fluCreatorId: string;
  channelId: string;
  partnerId: string;
  enrollmentId: string;
  programId: typeof PORTAL_PROGRAM_ID;
  dryRun: boolean;
};

type ImmutableApprovedBinding = {
  portalCreatorId: string;
  fluCreatorId: string;
  partnerId: string;
  programId: typeof PORTAL_PROGRAM_ID;
  enrollmentId: string;
  channelId: string;
  sourceApplicationId: string;
  sourceCreatorId: string;
  status: "active";
  authorityKind: typeof APPROVED_AUTHORITY_KIND;
  authorityCommandRef: string;
  authorityBodyHash: string;
  authorityVersion: typeof APPROVED_AUTHORITY_VERSION;
  mintDerivation: string;
  mappingHash: string;
};

// alpha=hexToAlpha(sha256(`${APPROVED_AUTHORITY_VERSION}:${applicationId}:${portalCreatorId}`));
// digits 0-9 -> g-p (digit-free, non-contact, one-way). partnerId=partner-pa-<alpha[0,24)>,
// enrollmentId=enrollment-pa-<alpha[24,48)>.
const APPROVED_MINT_DERIVATION =
  "alpha=hexToAlpha(sha256(`${APPROVED_AUTHORITY_VERSION}:${applicationId}:${portalCreatorId}`)); " +
  "digits 0-9 -> g-p; partnerId=partner-pa-<alpha[0,24)>, enrollmentId=enrollment-pa-<alpha[24,48)>";

function approvedHexToAlpha(hex: string): string {
  return hex.replace(/[0-9]/g, (digit) => "ghijklmnop"[Number(digit)]);
}

function deriveApprovedIdentityTuple(
  applicationId: string,
  portalCreatorId: string,
): { partnerId: string; enrollmentId: string } {
  const alpha = approvedHexToAlpha(sha256(`${APPROVED_AUTHORITY_VERSION}:${applicationId}:${portalCreatorId}`));
  return {
    partnerId: `partner-pa-${alpha.slice(0, 24)}`,
    enrollmentId: `enrollment-pa-${alpha.slice(24, 48)}`,
  };
}

/**
 * Server-verified alternate authority: mints a `scp_portal_creator_bindings` row from a Portal
 * v2 approval command instead of the Sheet-era application/creator/lead chain. Reuses the write
 * path above verbatim (same collections, doc-id scheme, identity-key/audit/idempotency
 * mechanics) — only the authority verification differs.
 */
export async function provisionScpPortalApprovedCreatorBinding(
  request: CallableRequestShape,
  deps: ProvisioningDeps = {},
) {
  const auth = assertNonGuestAuth(request, APPROVED_ACTION, ["super_admin"]);
  const input = parseApprovedInput(request.data);
  const db = deps.db ?? adminDb;
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const youtubeApi = deps.youtubeApi ?? makeYouTubeDataApiClient();
  const bindingRef = db.collection(BINDINGS_COLLECTION).doc(
    youtubeOAuthPortalBindingDocumentId(input.fluCreatorId),
  );
  const auditRef = db.collection(AUDIT_COLLECTION).doc();
  const requestDigest = approvedMappingHash(input);

  try {
    const result = await db.runTransaction(async (transaction) => {
      const commandRef = db
        .collection(FLU_APPLICATION_COMMAND_COLLECTION)
        .doc(fluApplicationApprovalCommandId(input.applicationId));
      const managementRef = db.collection(MANAGEMENT_COLLECTION).doc(input.applicationId);
      const creatorRef = db.collection("creators").doc(input.fluCreatorId);
      const [commandSnapshot, managementSnapshot, creatorSnapshot] = await Promise.all([
        transaction.get(commandRef),
        transaction.get(managementRef),
        transaction.get(creatorRef),
      ]);

      const commandFacts = assertApprovalCommandAuthority(commandSnapshot, input);
      const management = requireSnapshot(managementSnapshot, "application management record is unavailable");
      const creator = requireSnapshot(creatorSnapshot, "authoritative Flu creator is unavailable");
      assertApprovedCreatorChannelConsistency(creator, input);
      // Adversarial-review fix (BLOCK, reproduced): the self-consistency check above only proves
      // the operator's own two inputs agree with each other — it does NOT prove `fluCreatorId` has
      // anything to do with THIS application. An operator could otherwise bind any unrelated
      // creator whose own channelId happens to be typed into the request. This ties the creator
      // back to the application using data the SERVER already holds, never the operator's say-so.
      const authorityChannelResolution = await assertApplicationCreatorLinkage(
        management,
        creator,
        input,
        { youtubeApi, nowIso },
      );

      const immutable: ImmutableApprovedBinding = {
        portalCreatorId: input.portalCreatorId,
        fluCreatorId: input.fluCreatorId,
        partnerId: input.partnerId,
        programId: input.programId,
        enrollmentId: input.enrollmentId,
        channelId: input.channelId,
        sourceApplicationId: input.applicationId,
        sourceCreatorId: input.fluCreatorId,
        status: "active",
        authorityKind: APPROVED_AUTHORITY_KIND,
        authorityCommandRef: commandRef.path,
        authorityBodyHash: commandFacts.bodyHash,
        authorityVersion: APPROVED_AUTHORITY_VERSION,
        mintDerivation: APPROVED_MINT_DERIVATION,
        mappingHash: requestDigest,
      };

      const existingSnapshot = await transaction.get(bindingRef);
      const identityKeys = bindingIdentityKeys(db, input);
      const identityKeySnapshots = await Promise.all(
        identityKeys.map((key) => transaction.get(key.ref)),
      );

      let status: ProvisioningStatus;
      if (existingSnapshot.exists) {
        assertExactBinding(existingSnapshot.data(), immutable);
        for (let index = 0; index < identityKeys.length; index += 1) {
          assertExactIdentityKey(
            identityKeySnapshots[index]?.data(),
            identityKeys[index],
            bindingRef.path,
            requestDigest,
            APPROVED_AUTHORITY_VERSION,
          );
        }
        status = "exact_duplicate";
      } else if (input.dryRun) {
        // A dry run proves authority without creating the binding or its identity keys — but it
        // still leaves an audit row below (Review MEDIUM fix), so "dry run" is not "silent".
        assertIdentityKeysAvailable(identityKeys, identityKeySnapshots);
        status = "dry_run";
      } else {
        assertIdentityKeysAvailable(identityKeys, identityKeySnapshots);
        transaction.create(bindingRef, {
          ...immutable,
          createdAtIso: nowIso,
          // Not part of `immutable` on purpose: it must never participate in the
          // assertExactBinding idempotency comparison above (its resolvedAtIso would make a
          // legitimate duplicate re-submission look like a conflicting change).
          authorityChannelResolution,
        });
        for (const key of identityKeys) {
          transaction.create(key.ref, {
            authorityVersion: APPROVED_AUTHORITY_VERSION,
            bindingRef: bindingRef.path,
            keyHash: key.keyHash,
            keyKind: key.kind,
            mappingHash: requestDigest,
            createdAtIso: nowIso,
          });
        }
        status = "created";
      }
      // Review MEDIUM fix: an engine that materializes settlement-relevant identity must leave a
      // trace for every VALID outcome, not just "created" — a valid-but-inert dry-run or replay is
      // itself an auditable fact (LOG-P0-010). Written unconditionally, mirroring the Sheet-era
      // path's own audit symmetry above.
      transaction.create(auditRef, {
        action: APPROVED_ACTION,
        authorityVersion: APPROVED_AUTHORITY_VERSION,
        actorUid: auth.userId,
        actorRole: auth.role,
        actorTeam: auth.team,
        bindingRef: bindingRef.path,
        requestDigest,
        authorityCommandRefHash: sha256(commandRef.path),
        authorityBodyHash: commandFacts.bodyHash,
        // LOG-P0-010: records why tier 3 passed (or that tier 1 short-circuited it, when null) —
        // a human auditing this row can see the exact handle/channelId the YouTube API verified.
        authorityChannelResolution,
        dryRun: input.dryRun,
        result: status,
        createdAtIso: nowIso,
      });
      return status;
    });

    return {
      ok: true,
      status: result,
      bindingRef: bindingRef.path,
      auditRef: auditRef.path,
      requestDigest,
      partnerId: input.partnerId,
      enrollmentId: input.enrollmentId,
    };
  } catch (error) {
    await writeFailureAudit({
      auditRef,
      action: APPROVED_ACTION,
      authorityVersion: APPROVED_AUTHORITY_VERSION,
      auth: { uid: auth.userId, role: auth.role, team: auth.team },
      bindingRef: bindingRef.path,
      requestDigest,
      dryRun: input.dryRun,
      nowIso,
      error,
    });
    throw error;
  }
}

function parseApprovedInput(value: unknown): ApprovedProvisioningInput {
  const data = asRecord(value);
  const unexpectedKeys = Object.keys(data).filter((key) => !APPROVED_ALLOWED_INPUT_KEYS.has(key));
  if (unexpectedKeys.length > 0) {
    throw invalidArgument("payload schema contains unsupported fields");
  }
  const applicationId = requiredIdentifier(data.applicationId, "applicationId");
  const portalCreatorId = requiredIdentifier(data.portalCreatorId, "portalCreatorId");
  const fluCreatorId = requiredIdentifier(data.fluCreatorId, "fluCreatorId");
  const channelId = requiredIdentifier(data.channelId, "channelId");
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
    throw invalidArgument("channelId must be a canonical YouTube channel id");
  }
  if (data.dryRun !== undefined && typeof data.dryRun !== "boolean") {
    throw invalidArgument("dryRun must be boolean");
  }
  const derived = deriveApprovedIdentityTuple(applicationId, portalCreatorId);
  return {
    applicationId,
    portalCreatorId,
    fluCreatorId,
    channelId,
    partnerId: derived.partnerId,
    enrollmentId: derived.enrollmentId,
    programId: PORTAL_PROGRAM_ID,
    dryRun: data.dryRun !== false,
  };
}

// Authority root 1: the Portal v2 approval command. Every field consumed here is read from
// Firestore and byte-compared against the request — an operator can never assert identity, only
// point at ids for the server to verify.
function assertApprovalCommandAuthority(
  commandSnapshot: FirebaseFirestore.DocumentSnapshot,
  input: ApprovedProvisioningInput,
): { bodyHash: string } {
  if (!commandSnapshot.exists) {
    throw failedPrecondition("portal approval command is unavailable");
  }
  const record = asRecord(commandSnapshot.data());
  if (record.contractVersion !== APPROVED_COMMAND_CONTRACT_VERSION) {
    throw failedPrecondition("portal approval command is not on the v2 contract");
  }
  const commandPortalCreatorId = asString(record.portalCreatorId);
  if (!commandPortalCreatorId || APPROVED_IDENTITY_SENTINELS.has(commandPortalCreatorId.toLowerCase())) {
    throw failedPrecondition("portal approval command portalCreatorId is unresolved");
  }
  if (commandPortalCreatorId !== input.portalCreatorId) {
    throw failedPrecondition("portal approval command portalCreatorId does not match the requested identity");
  }
  if (!asString(record.approvedByActorId) || !asString(record.approvedAtIso)) {
    throw failedPrecondition("portal approval command is missing approval attribution");
  }
  const bodyHash = asString(record.bodyHash);
  if (!bodyHash) {
    throw failedPrecondition("portal approval command is missing a body hash");
  }
  return { bodyHash };
}

// Authority root 3 (input self-consistency only — see assertApplicationCreatorLinkage below for
// the check that actually ties `fluCreatorId` to THIS application). `creatorRef` is always
// `creators/{input.fluCreatorId}` by construction (the caller built it from that exact id), so a
// `creatorRef !== ...` comparison here would be unreachable dead code — deleted (adversarial
// review, BLOCK).
function assertApprovedCreatorChannelConsistency(
  creator: Record<string, unknown>,
  input: ApprovedProvisioningInput,
): void {
  // 적대 리뷰 3라운드 BLOCK: `creators.channelId` 는 upsertCreator(crm.ts:185, WRITER_ROLES 에
  // super_admin 포함)로 자유 텍스트 덮어쓰기가 가능하다 — 폴백으로 받으면 운영자가 증거를 심을 수
  // 있다(2콜로 재현됨). 위조 불가능한 `youtubeChannelId`(쓰기 경로가 HMAC 인그레스뿐) 만 본다.
  const creatorChannelId = asString(creator.youtubeChannelId);
  if (!creatorChannelId || creatorChannelId !== input.channelId) {
    throw failedPrecondition("authoritative Flu creator channel does not match the requested channelId");
  }
}

type AuthorityChannelResolution = {
  forHandle: string;
  resolvedChannelId: string;
  resolvedAtIso: string;
};

// Authority root 4 (adversarial-review fix, BLOCK reproduced twice): proves `fluCreatorId`
// actually belongs to THIS application — everything compared here is data the SERVER already
// holds (or independently verifies against YouTube), never an operator assertion. Without this,
// an operator could bind any unrelated creator whose own channelId happened to match the request
// (self-consistency alone is tautological — see assertApprovedCreatorChannelConsistency).
//
// Preference order:
//   1. `identity.portalCreatorId`, when present, must byte-match the request — but does NOT by
//      itself return early. Round 2 of adversarial review reproduced a bypass through exactly
//      that shortcut: `identity:{portalCreatorId: P, channelId: null}` plus an unrelated creator
//      passed, because a matching portalCreatorId only proves two Portal-side documents about the
//      SAME applicationId agree with each other — it says nothing about which flu creator the
//      application belongs to.
//   2. `identity.channelId`, when present, must byte-match the request, and is the ONLY field
//      allowed to short-circuit below — Flu only ever fills it in from a prior verified
//      binding/materialize step, never from operator input.
//   3. When `identity.channelId` is absent (the exact shape of the Portal-lineage applications
//      this whole path exists for — real prod check: both null), fall back to a live YouTube
//      Data API *ownership* proof: resolve the application's declared handle
//      (`declaredIdentity.handle`, or a handle parsed out of `declaredIdentity.channelUrl`) to its
//      CURRENT owning channel via an exact `channels.list forHandle` lookup (never `search.list` —
//      fuzzy ranking is not proof), and require that resolved channelId to exactly match both the
//      requested `channelId` and the authoritative creator's `youtubeChannelId`.
//      `creators.handle` is NEVER compared here (round 1 of adversarial review reproduced identity
//      substitution through exactly that field in 2 calls: `upsertCreator` in crm.ts lets any
//      WRITER_ROLES actor — including super_admin — overwrite it as free text). `.youtubeChannelId`
//      has no such operator-reachable write path; its only writer is the HMAC-signed ingress in
//      scpIntegrationEventV2.ts.
//   4. If none of the above yields any evidence at all, fail closed. An operator can never assert
//      the application/creator link on their own — only stored data or a live YouTube ownership
//      check can prove it.
async function assertApplicationCreatorLinkage(
  management: Record<string, unknown>,
  creator: Record<string, unknown>,
  input: ApprovedProvisioningInput,
  deps: { youtubeApi: Pick<YouTubeApiClient, "channelsList">; nowIso: string },
): Promise<AuthorityChannelResolution | null> {
  const identity = asRecord(management.identity);
  const identityPortalCreatorId = asString(identity.portalCreatorId);
  if (identityPortalCreatorId && identityPortalCreatorId !== input.portalCreatorId) {
    throw failedPrecondition("application management identity.portalCreatorId does not match the requested identity");
  }
  const identityChannelId = asString(identity.channelId);
  if (identityChannelId && identityChannelId !== input.channelId) {
    throw failedPrecondition("application management identity.channelId does not match the requested channelId");
  }
  if (identityChannelId) {
    // 적대 리뷰 3라운드 BLOCK 의 근인은 `assertApprovedCreatorChannelConsistency` 가 위조 가능한
    // `creators.channelId` 를 폴백으로 받은 것이었고(운영자가 upsertCreator 로 심을 수 있다),
    // 그 폴백은 제거했다. 여기 검사는 그 위에 얹는 **다중 방어**다: 지금은 앞선 두 검사
    // (identity.channelId == input.channelId, creator.youtubeChannelId == input.channelId)가
    // 조합으로 같은 성질을 함의하므로 도달 불가에 가깝지만, 그 둘 중 하나가 완화되는 순간
    // 조기 반환이 무방비가 된다. 조기 반환은 외부 검증(tier 3)을 통째로 건너뛰는 경로라
    // 한 겹에 의존하지 않는다. (뮤테이션으로 이 줄만 죽여도 스위트가 green 인 이유가 이것이다 —
    // 도달 불가라서지 검사가 무의미해서가 아니다.)
    const creatorChannelId = asString(creator.youtubeChannelId);
    if (!creatorChannelId || creatorChannelId !== identityChannelId) {
      throw failedPrecondition(
        "authoritative Flu creator youtubeChannelId does not match the application's recorded channelId",
      );
    }
    return null;
  }

  const declared = asRecord(management.declaredIdentity);
  const declaredHandle = normalizeHandle(declared.handle) ?? normalizeHandle(declared.channelUrl);
  if (!declaredHandle) {
    throw failedPrecondition("application has no verifiable identity evidence to link the requested creator");
  }

  let lookup: { channelId: string | null; candidateCount: number };
  try {
    lookup = await resolveYouTubeChannelIdForHandle(deps.youtubeApi, declaredHandle);
  } catch (error) {
    // Covers network errors, non-2xx HTTP responses, and quota exhaustion alike — the underlying
    // YouTubeApiClient throws for all of these; none may pass silently (fail-closed).
    throw failedPrecondition(
      `YouTube channel ownership lookup for the declared handle failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (lookup.candidateCount === 0) {
    throw failedPrecondition("YouTube channel ownership lookup found no channel for the declared handle");
  }
  if (lookup.candidateCount > 1) {
    throw failedPrecondition("YouTube channel ownership lookup found multiple channels for the declared handle");
  }
  const resolvedChannelId = lookup.channelId;
  const creatorChannelId = asString(creator.youtubeChannelId);
  if (!resolvedChannelId || resolvedChannelId !== input.channelId || resolvedChannelId !== creatorChannelId) {
    throw failedPrecondition("YouTube channel ownership lookup does not match the requested channelId");
  }

  return { forHandle: declaredHandle, resolvedChannelId, resolvedAtIso: deps.nowIso };
}

function approvedMappingHash(input: Omit<ApprovedProvisioningInput, "dryRun">): string {
  return sha256(JSON.stringify({
    applicationId: input.applicationId,
    channelId: input.channelId,
    enrollmentId: input.enrollmentId,
    fluCreatorId: input.fluCreatorId,
    partnerId: input.partnerId,
    portalCreatorId: input.portalCreatorId,
    programId: input.programId,
  }));
}
