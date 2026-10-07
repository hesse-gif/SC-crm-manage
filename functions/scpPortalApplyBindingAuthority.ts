// USER-AUTHORIZED v3-apply-lane identity-authority engine (G008 recovery, 2026-07-19).
//
// WHY THIS MODULE EXISTS: `scp_portal_creator_bindings` provisioning
// (./scpPortalCreatorBinding.ts) anchors authority on the Sheet-era chain
// (approved `program_applications` + authoritative `creators` + qualified SCP lead).
// Applications born through the Portal Apply v3 intake lane NEVER create those records,
// so no prior normal engine could materialize a binding for them — the frozen
// `application.management.acknowledged` schema then fail-closes forever
// (documented bootstrap deadlock; Portal receipt
// PORTAL_G008_AUTHORITATIVE_ENROLLMENT_TUPLE_ABSENT_20260719T202927Z).
//
// AUTHORIZATION: the user explicitly authorized this engine to CREATE/SOURCE the
// missing Flu-owned enrollment identities (fluCreatorId, partnerId, enrollmentId,
// channelId) with audited provenance for EXACTLY ONE synthetic production pilot
// (receipt PORTAL_G008_V3_AUTHORITY_USER_AUTHORIZATION_20260719T231909Z, sha256
// 31ea0030060f06650a11ea215cb38593f5e9679d2b35b2fc59c463a80c518b7e), under the
// corrected acceptance contract
// PORTAL_G008_V3_AUTHORITY_ACCEPTANCE_CONTRACT_20260719T204009Z_CORRECTED (sha256
// 87b40131e2af3744be9236f108cae5b21610b844ee082b833d77875282db47e9).
//
// EXACT-SCOPE SOURCE AUTHORIZATION (Portal second review item 1): the authorized pilot
// scope is compiled into this module as `PRODUCTION_AUTHORIZED_SCOPE` — the byte content
// of the user-authorization receipt (application, trace, portalCreatorId, program,
// campaign, material event/hash, application revision). The engine refuses ANY request
// outside that scope; nothing is pre-seeded by hand (no settings fence document, no
// direct Firestore arming write). Single-use is enforced by a TRANSACTIONALLY-CREATED
// consumption record (`scp_v3_apply_binding_authorization_consumptions`): a real
// provisioning creates it atomically with the binding (create() fails if present), an
// exact-duplicate replay must byte-match it, and a mismatch fails closed. Tests inject a
// scope via deps; the deployed callable wiring passes no deps, so production is locked
// to the pilot. super_admin only.
//
// AUTHORITY ROOTS (all fail-closed, byte-exact against operator-supplied pins):
//   1. exactly one DONE `scp_creator_pipeline_v3_receipts` intake receipt for the exact
//      event/application/trace/revision/material hash, whose application pointer
//      (`app:` doc) agrees on lastEventId/lastTraceId and whose envelope counter
//      (`lastRevision`) equals the event's own envelope `revision`, and
//   2. exactly one `scp_application_management` record that is classification=managed,
//      reasonCode=operator_assigned, not revoked, at the exact campaign, whose
//      revisions-ledger HEAD is the managed assignment for that exact campaign at the
//      exact sourceRevision (unique head revision, monotonic ledger) and whose
//      sourceRevision equals the intake applicationRevision.
// NO legacy Sheet-era application/creator/lead is read, required, or fabricated.
//
// IDENTITY CREATION: minted identities are not just derivation strings — the engine
// CREATES one canonical authority record per identity in `scp_v3_apply_identity_registry`
// (kind + value + application/trace + derivation + authorization digests),
// transactionally with the binding, plus shared-registry uniqueness keys. Derivation
// (audited, deterministic, digit-free, non-contact):
//   alpha  = hexToAlpha(sha256(`${AV}:${applicationId}:${traceId}`))          (0-9 → g-p)
//   alphaC = hexToAlpha(sha256(`${AV}:${applicationId}:${traceId}:channel`))
//   fluCreatorId = CR.v3.<alpha[0,24)>      partnerId    = partner-<alpha[24,48)>
//   enrollmentId = enrollment-<alpha[48,64)> channelId   = channel.v3.<alphaC[0,16)>
// The minted channelId is a Flu-authority enrollment-channel handle: deliberately NOT
// UC-shaped and never claiming to be a real YouTube channel id. (Recorded follow-up:
// youtubeOAuthHandoff/submission-ingress consumers fail CLOSED for v3-apply bindings
// until they learn this shape — see FLU_READY receipt risk notes.)
//
// DRY-RUN performs ZERO writes and returns only metadata identifiers and booleans.
// Every rejection (tuple collision, occupied key/registry, root mismatch, scope
// mismatch) fails closed WITHOUT any durable mutation (no failure-audit rows — a
// non-durable provider log line only). Real provisioning writes, in ONE transaction:
// the immutable binding, its identity keys, the four identity-registry records, one
// success-audit record, the single-use consumption record, and the fill-only
// management-identity reconciliation (WITHOUT touching the assignment revisions ledger —
// monotonicity preserved; reconciliation lands in a dedicated `identityReconciliation`
// map). The mapping digest covers the management sourceRevision, so revision drift can
// never replay as exact_duplicate.
//
// The management ACK is enqueued only AFTER immutable binding success, through the
// existing fail-closed wiring; the callable reports ok=true ONLY once the queued ACK
// outbox row verifiably exists for the exact application/revision, is in a safe
// delivery state (never dead_letter), byte-matches this binding's identity tuple, and
// carries NO outreachId (the authorized pilot omits it). An exact-duplicate re-run
// safely re-enqueues a missing row; a mismatching existing row is a hard conflict.
//
// PRIVACY P0: only opaque ids/hashes cross into this module or its writes — no raw PII.
import { createHash } from "node:crypto";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { assertNonGuestAuth, asRecord, asString, type CallableRequestShape } from "./shared";
import { youtubeOAuthPortalBindingDocumentId } from "./youtubeOAuthHandoff";
import {
  enqueueManagementAckForApplication,
  deriveManagementAckSourceEventId,
  MANAGEMENT_ACK_WIRING_POLICY_VERSION,
} from "./scpCreatorPipelineV3ManagementAckWiring";

const ACTION = "scp_portal_apply_binding.provision";
// Exported so other engines that mint or classify a Portal-scoped envelope (e.g. the outreach
// landing-link mint, W47 attribution fix) reuse the exact literal instead of re-declaring it.
export const PORTAL_PROGRAM_ID = "view-cpm";
const BINDINGS_COLLECTION = "scp_portal_creator_bindings";
const BINDING_KEYS_COLLECTION = "scp_portal_creator_binding_keys";
const AUDIT_COLLECTION = "scp_portal_creator_binding_audit";
const RECEIPTS_COLLECTION = "scp_creator_pipeline_v3_receipts";
const MANAGEMENT_COLLECTION = "scp_application_management";
const ACK_OUTBOX_COLLECTION = "scp_creator_pipeline_v3_management_ack_outbox";
export const APPLY_IDENTITY_REGISTRY_COLLECTION = "scp_v3_apply_identity_registry";
export const APPLY_AUTHORIZATION_CONSUMPTIONS_COLLECTION =
  "scp_v3_apply_binding_authorization_consumptions";
export const APPLY_AUTHORITY_VERSION = "scp-v3-apply-authority/v1";

export const USER_AUTHORIZATION_SHA256 =
  "31ea0030060f06650a11ea215cb38593f5e9679d2b35b2fc59c463a80c518b7e";
export const ACCEPTANCE_CONTRACT_SHA256 =
  "87b40131e2af3744be9236f108cae5b21610b844ee082b833d77875282db47e9";

export type ApplyAuthorizedScope = Readonly<{
  applicationId: string;
  traceId: string;
  portalCreatorId: string;
  programId: string;
  campaignId: string;
  materialEventId: string;
  materialHash: string;
  applicationRevision: number;
}>;

/**
 * Byte content of the user-authorization receipt (sha256 31ea0030…) + the corrected
 * acceptance contract (sha256 87b40131…): the ONLY production scope this engine will
 * ever provision. Tests inject a synthetic scope via deps; the deployed callable wiring
 * passes no deps, so production is locked to exactly this pilot.
 */
export const PRODUCTION_AUTHORIZED_SCOPE: ApplyAuthorizedScope = {
  applicationId: "b27dbc21-4c96-401f-8759-055f4772cd49",
  traceId: "tr_b27dbc21-4c96-401f-8759-055f4772cd49",
  portalCreatorId: "pc_f0d952d5b9982f5e13775dd3",
  programId: PORTAL_PROGRAM_ID,
  campaignId: "cp-mqzdhxipbmwg",
  materialEventId: "evt_c82c08881313ead6443771937ce58fe0",
  materialHash: "fac36ecd2f46aaf21c960ab8050f24f19f5b1d301d712ff500f19c1bd50dd8a9",
  applicationRevision: 1,
};

const ALLOWED_INPUT_KEYS = new Set([
  "applicationId",
  "campaignId",
  "dryRun",
  "materialEventId",
  "materialHash",
  "portalCreatorId",
  "programId",
  "traceId",
]);

type ProvisioningStatus = "created" | "dry_run" | "exact_duplicate";

type ApplyProvisioningInput = {
  applicationId: string;
  traceId: string;
  portalCreatorId: string;
  programId: typeof PORTAL_PROGRAM_ID;
  campaignId: string;
  materialEventId: string;
  materialHash: string;
  dryRun: boolean;
};

type MintedIdentityTuple = {
  fluCreatorId: string;
  partnerId: string;
  enrollmentId: string;
  channelId: string;
};

type ProvisioningDeps = {
  db?: Firestore;
  now?: Date;
  /** TEST-ONLY scope override; the deployed wiring never sets it. */
  authorizedScope?: ApplyAuthorizedScope;
};

type ImmutableApplyBinding = {
  portalCreatorId: string;
  fluCreatorId: string;
  partnerId: string;
  programId: typeof PORTAL_PROGRAM_ID;
  enrollmentId: string;
  channelId: string;
  campaignId: string;
  sourceApplicationId: string;
  sourceCreatorId: string;
  status: "active";
  sourceIntakeReceiptRef: string;
  sourceManagementRecordRef: string;
  sourceTraceId: string;
  sourceMaterialEventId: string;
  sourceMaterialHash: string;
  sourceManagementRevision: number;
  authorityVersion: typeof APPLY_AUTHORITY_VERSION;
  mintDerivation: string;
  userAuthorizationSha256: typeof USER_AUTHORIZATION_SHA256;
  acceptanceContractSha256: typeof ACCEPTANCE_CONTRACT_SHA256;
  mappingHash: string;
};

/**
 * User-authorized super_admin-only provisioning of a v3-apply-lane enrollment-identity
 * binding. Every operator-supplied pin must byte-match BOTH the compiled authorized
 * scope AND the durable ledgers inside the transaction; single-use is enforced by the
 * transactionally-created consumption record.
 */
export async function provisionScpPortalApplyBinding(
  request: CallableRequestShape,
  deps: ProvisioningDeps = {},
) {
  const auth = assertNonGuestAuth(request, ACTION, ["super_admin"]);
  const input = parseInput(request.data);
  const scope = deps.authorizedScope ?? PRODUCTION_AUTHORIZED_SCOPE;
  assertAuthorizedScope(input, scope);
  const db = deps.db ?? adminDb;
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();

  const minted = mintIdentityTuple(input);
  const bindingRef = db.collection(BINDINGS_COLLECTION).doc(
    youtubeOAuthPortalBindingDocumentId(minted.fluCreatorId),
  );
  const auditRef = db.collection(AUDIT_COLLECTION).doc();

  let result: { status: ProvisioningStatus; sourceRevision: number; requestDigest: string };
  try {
    result = await db.runTransaction(async (transaction) => {
      const consumptionRef = db
        .collection(APPLY_AUTHORIZATION_CONSUMPTIONS_COLLECTION)
        .doc(receiptsDocId(input.applicationId));
      // The authorized revision is compiled into the scope, so the deterministic ack
      // outbox row can be read INSIDE this transaction — a pre-existing conflicting row
      // must fail closed BEFORE any durable authority write.
      const ackOutboxRef = db
        .collection(ACK_OUTBOX_COLLECTION)
        .doc(receiptsDocId(`${input.applicationId}:${scope.applicationRevision}`));
      const eventRef = db.collection(RECEIPTS_COLLECTION).doc(`evt:${receiptsDocId(input.materialEventId)}`);
      const appPointerRef = db.collection(RECEIPTS_COLLECTION).doc(`app:${receiptsDocId(input.applicationId)}`);
      const managementRef = db.collection(MANAGEMENT_COLLECTION).doc(managementRecordDocId(input.applicationId));
      const activeBindingsQuery = db
        .collection(BINDINGS_COLLECTION)
        .where("sourceApplicationId", "==", input.applicationId)
        .limit(2);
      const identityKeys = applyBindingIdentityKeys(db, input, minted);
      const registryEntries = applyIdentityRegistryEntries(db, minted);

      const [
        consumptionSnapshot,
        ackOutboxSnapshot,
        eventSnapshot,
        appPointerSnapshot,
        managementSnapshot,
        existingBindingSnapshot,
        activeBindingsSnapshot,
        ...keyAndRegistrySnapshots
      ] = await Promise.all([
        transaction.get(consumptionRef),
        transaction.get(ackOutboxRef),
        transaction.get(eventRef),
        transaction.get(appPointerRef),
        transaction.get(managementRef),
        transaction.get(bindingRef),
        transaction.get(activeBindingsQuery),
        ...identityKeys.map((key) => transaction.get(key.ref)),
        ...registryEntries.map((entry) => transaction.get(entry.ref)),
      ]);
      const identityKeySnapshots = keyAndRegistrySnapshots.slice(0, identityKeys.length);
      const registrySnapshots = keyAndRegistrySnapshots.slice(identityKeys.length);

      const event = requireSnapshot(eventSnapshot, "v3 intake receipt is unavailable");
      const appPointer = requireSnapshot(appPointerSnapshot, "v3 intake application pointer is unavailable");
      const management = requireSnapshot(managementSnapshot, "application management record is unavailable");

      const intakeFacts = assertIntakeAuthority(event, appPointer, input, scope);
      const managementFacts = assertManagementAuthority(management, input, minted, intakeFacts);
      const requestDigest = applyMappingHash(input, minted, managementFacts.sourceRevision);
      // Pre-write ACK validation: any existing outbox row for this application/revision
      // must already byte-match the tuple this transaction would bind — otherwise fail
      // closed with ZERO durable mutation (Portal final-review blocker 4).
      if (ackOutboxSnapshot.exists) {
        assertAckOutboxMatchesBinding(
          asRecord(ackOutboxSnapshot.data()),
          input,
          minted,
          managementFacts.sourceRevision,
        );
      }

      const immutable: ImmutableApplyBinding = {
        portalCreatorId: input.portalCreatorId,
        fluCreatorId: minted.fluCreatorId,
        partnerId: minted.partnerId,
        programId: PORTAL_PROGRAM_ID,
        enrollmentId: minted.enrollmentId,
        channelId: minted.channelId,
        campaignId: input.campaignId,
        sourceApplicationId: input.applicationId,
        sourceCreatorId: minted.fluCreatorId,
        status: "active",
        sourceIntakeReceiptRef: eventRef.path,
        sourceManagementRecordRef: managementRef.path,
        sourceTraceId: input.traceId,
        sourceMaterialEventId: input.materialEventId,
        sourceMaterialHash: input.materialHash,
        sourceManagementRevision: managementFacts.sourceRevision,
        authorityVersion: APPLY_AUTHORITY_VERSION,
        mintDerivation: MINT_DERIVATION,
        userAuthorizationSha256: USER_AUTHORIZATION_SHA256,
        acceptanceContractSha256: ACCEPTANCE_CONTRACT_SHA256,
        mappingHash: requestDigest,
      };
      const consumptionRecord = {
        action: ACTION,
        authorityVersion: APPLY_AUTHORITY_VERSION,
        applicationId: input.applicationId,
        traceId: input.traceId,
        portalCreatorId: input.portalCreatorId,
        programId: input.programId,
        campaignId: input.campaignId,
        materialEventId: input.materialEventId,
        materialHash: input.materialHash,
        sourceManagementRevision: managementFacts.sourceRevision,
        bindingRef: bindingRef.path,
        requestDigest,
        userAuthorizationSha256: USER_AUTHORIZATION_SHA256,
        acceptanceContractSha256: ACCEPTANCE_CONTRACT_SHA256,
      };

      // "Same tuple is idempotent; any different tuple for the application is a hard conflict."
      // The registry is shared with the Sheet-era engine, so ANY other binding row naming this
      // application (active or not) is a conflict — never a candidate for silent coexistence.
      const foreignBindings = activeBindingsSnapshot.docs.filter((doc) => doc.ref.path !== bindingRef.path);
      if (foreignBindings.length > 0) {
        throw failedPrecondition("immutable binding conflict: sourceApplicationId");
      }

      let status: ProvisioningStatus;
      if (existingBindingSnapshot.exists) {
        assertExactBinding(existingBindingSnapshot.data(), immutable);
        for (let index = 0; index < identityKeys.length; index += 1) {
          assertExactIdentityKey(
            identityKeySnapshots[index]?.data(),
            identityKeys[index],
            bindingRef.path,
            requestDigest,
          );
        }
        for (let index = 0; index < registryEntries.length; index += 1) {
          assertExactRegistryEntry(
            registrySnapshots[index]?.data(),
            registryEntries[index],
            bindingRef.path,
            input,
          );
        }
        // Single-use authorization: an existing binding must be the one that consumed it.
        assertExactConsumption(consumptionSnapshot, consumptionRecord);
        status = "exact_duplicate";
      } else if (input.dryRun) {
        // ZERO writes: not the binding, keys, registry, audit, consumption, or management.
        assertIdentityKeysAvailable(identityKeys, identityKeySnapshots);
        assertRegistryAvailable(registryEntries, registrySnapshots);
        if (consumptionSnapshot.exists) {
          throw failedPrecondition("apply-binding authorization is already consumed");
        }
        status = "dry_run";
      } else {
        assertIdentityKeysAvailable(identityKeys, identityKeySnapshots);
        assertRegistryAvailable(registryEntries, registrySnapshots);
        if (consumptionSnapshot.exists) {
          throw failedPrecondition("apply-binding authorization is already consumed");
        }
        transaction.create(bindingRef, { ...immutable, createdAtIso: nowIso });
        for (const key of identityKeys) {
          transaction.create(key.ref, {
            authorityVersion: APPLY_AUTHORITY_VERSION,
            bindingRef: bindingRef.path,
            keyHash: key.keyHash,
            keyKind: key.kind,
            mappingHash: requestDigest,
            createdAtIso: nowIso,
          });
        }
        // Canonical authority records for the four minted identities.
        for (const entry of registryEntries) {
          transaction.create(entry.ref, {
            kind: entry.kind,
            value: entry.value,
            applicationId: input.applicationId,
            traceId: input.traceId,
            bindingRef: bindingRef.path,
            authorityVersion: APPLY_AUTHORITY_VERSION,
            mintDerivation: MINT_DERIVATION,
            userAuthorizationSha256: USER_AUTHORIZATION_SHA256,
            acceptanceContractSha256: ACCEPTANCE_CONTRACT_SHA256,
            createdAtIso: nowIso,
          });
        }
        transaction.create(auditRef, {
          action: ACTION,
          authorityVersion: APPLY_AUTHORITY_VERSION,
          actorUid: auth.userId,
          actorRole: auth.role,
          actorTeam: auth.team,
          bindingRef: bindingRef.path,
          requestDigest,
          sourceIntakeReceiptRefHash: sha256(eventRef.path),
          sourceManagementRecordRefHash: sha256(managementRef.path),
          mintDerivation: MINT_DERIVATION,
          userAuthorizationSha256: USER_AUTHORIZATION_SHA256,
          acceptanceContractSha256: ACCEPTANCE_CONTRACT_SHA256,
          dryRun: false,
          result: "created",
          createdAtIso: nowIso,
        });
        // Single-use source authorization: consumed transactionally with the binding.
        // transaction.create fails the whole transaction if a concurrent consumption won.
        transaction.create(consumptionRef, {
          ...consumptionRecord,
          consumedBy: auth.userId,
          consumedAtIso: nowIso,
        });
        // Fill-only management-identity reconciliation. The assignment revisions ledger is
        // NOT touched — reconciliation is recorded in its own dedicated map.
        transaction.update(managementRef, {
          "identity.portalCreatorId": input.portalCreatorId,
          "identity.fluCreatorId": minted.fluCreatorId,
          "identity.enrollmentId": minted.enrollmentId,
          "identity.channelId": minted.channelId,
          currentProgramId: PORTAL_PROGRAM_ID,
          updatedAtIso: nowIso,
          updatedAt: FieldValue.serverTimestamp(),
          identityReconciliation: {
            atIso: nowIso,
            actor: auth.userId,
            authorityVersion: APPLY_AUTHORITY_VERSION,
            bindingRef: bindingRef.path,
            userAuthorizationSha256: USER_AUTHORIZATION_SHA256,
          },
        });
        status = "created";
      }
      return { status, sourceRevision: managementFacts.sourceRevision, requestDigest };
    });
  } catch (error) {
    // Fail closed WITHOUT durable mutation: rejections must not write audit/ledger rows.
    // Non-durable provider log only — opaque code, no identifiers.
    console.warn(`[${ACTION}] rejected`, {
      code: asString(asRecord(error).code, "internal"),
      dryRun: input.dryRun,
    });
    throw error;
  }

  // Management ACK: enqueued only AFTER immutable binding success (post-commit), and the
  // callable reports ok=true only once the queued row verifiably exists for the exact
  // application/revision, is in a safe delivery state, byte-matches this binding's
  // identity tuple, and omits outreachId.
  let ackQueued = false;
  let ackEnqueue: { enqueued: boolean; reason?: string } | null = null;
  if (!input.dryRun && (result.status === "created" || result.status === "exact_duplicate")) {
    const outboxRef = db
      .collection(ACK_OUTBOX_COLLECTION)
      .doc(receiptsDocId(`${input.applicationId}:${result.sourceRevision}`));
    let outboxSnapshot = await outboxRef.get();
    if (!outboxSnapshot.exists) {
      ackEnqueue = await enqueueManagementAckForApplication(input.applicationId, { firestore: db });
      outboxSnapshot = await outboxRef.get();
    }
    if (outboxSnapshot.exists) {
      assertAckOutboxMatchesBinding(
        asRecord(outboxSnapshot.data()),
        input,
        minted,
        result.sourceRevision,
      );
      ackQueued = true;
    }
  }

  const ok = input.dryRun ? true : ackQueued;
  return {
    ok,
    status: result.status,
    ackQueued,
    tuple: {
      fluCreatorId: minted.fluCreatorId,
      partnerId: minted.partnerId,
      enrollmentId: minted.enrollmentId,
      channelId: minted.channelId,
      portalCreatorId: input.portalCreatorId,
      programId: PORTAL_PROGRAM_ID,
      campaignId: input.campaignId,
    },
    appliedScope: { applicationId: input.applicationId, traceId: input.traceId },
    bindingRef: bindingRef.path,
    auditRef: result.status === "created" ? auditRef.path : null,
    requestDigest: result.requestDigest,
    ackEnqueue,
  };
}

// ---- input + scope --------------------------------------------------------------------------------

function parseInput(value: unknown): ApplyProvisioningInput {
  const data = asRecord(value);
  const unexpectedKeys = Object.keys(data).filter((key) => !ALLOWED_INPUT_KEYS.has(key));
  if (unexpectedKeys.length > 0) {
    throw invalidArgument("payload schema contains unsupported fields");
  }
  const applicationId = requiredIdentifier(data.applicationId, "applicationId");
  const traceId = requiredIdentifier(data.traceId, "traceId");
  if (traceId !== `tr_${applicationId}`) {
    throw invalidArgument("traceId must be the application trace");
  }
  const programId = requiredIdentifier(data.programId, "programId");
  if (programId !== PORTAL_PROGRAM_ID) {
    throw invalidArgument("programId must be view-cpm");
  }
  const portalCreatorId = requiredIdentifier(data.portalCreatorId, "portalCreatorId");
  if (!/^pc_[a-z0-9]{24}$/.test(portalCreatorId)) {
    throw invalidArgument("portalCreatorId must be a canonical Portal creator id");
  }
  const materialEventId = requiredIdentifier(data.materialEventId, "materialEventId");
  if (!/^evt_[a-f0-9]{32}$/.test(materialEventId)) {
    throw invalidArgument("materialEventId must be a canonical v3 event id");
  }
  const materialHash = asString(data.materialHash);
  if (!/^[a-f0-9]{64}$/.test(materialHash)) {
    throw invalidArgument("materialHash must be a sha256 hex digest");
  }
  if (data.dryRun !== undefined && typeof data.dryRun !== "boolean") {
    throw invalidArgument("dryRun must be boolean");
  }
  return {
    applicationId,
    traceId,
    portalCreatorId,
    programId: PORTAL_PROGRAM_ID,
    campaignId: requiredIdentifier(data.campaignId, "campaignId", true),
    materialEventId,
    materialHash,
    dryRun: data.dryRun !== false,
  };
}

function assertAuthorizedScope(input: ApplyProvisioningInput, scope: ApplyAuthorizedScope): void {
  if (input.applicationId !== scope.applicationId
    || input.traceId !== scope.traceId
    || input.portalCreatorId !== scope.portalCreatorId
    || input.programId !== scope.programId
    || input.campaignId !== scope.campaignId
    || input.materialEventId !== scope.materialEventId
    || input.materialHash !== scope.materialHash) {
    throw failedPrecondition("request is outside the user-authorized scope");
  }
}

// ---- identity minting -----------------------------------------------------------------------------

const MINT_DERIVATION =
  "alpha=hexToAlpha(sha256(`${authorityVersion}:${applicationId}:${traceId}`)); " +
  "alphaC=hexToAlpha(sha256(`${authorityVersion}:${applicationId}:${traceId}:channel`)); digits 0-9 mapped to g-p; " +
  "fluCreatorId=CR.v3.<alpha[0,24)>, partnerId=partner-<alpha[24,48)>, enrollmentId=enrollment-<alpha[48,64)>, " +
  "channelId=channel.v3.<alphaC[0,16)> (Flu-authority enrollment-channel handle; deliberately not UC-shaped)";

/**
 * Deterministic, digit-free identity minting. The digit-free alphabet (hex digits 0-9
 * mapped to letters g-p) guarantees the minted identifiers can never contain a numeric
 * sequence, can never be email-shaped, and carry no contact/UID/token material — they
 * are pure one-way derivations of the (authorityVersion, applicationId, traceId) triple.
 */
export function mintIdentityTuple(
  input: Pick<ApplyProvisioningInput, "applicationId" | "traceId">,
): MintedIdentityTuple {
  const alpha = hexToAlpha(sha256(`${APPLY_AUTHORITY_VERSION}:${input.applicationId}:${input.traceId}`));
  const alphaChannel = hexToAlpha(sha256(`${APPLY_AUTHORITY_VERSION}:${input.applicationId}:${input.traceId}:channel`));
  return {
    fluCreatorId: `CR.v3.${alpha.slice(0, 24)}`,
    partnerId: `partner-${alpha.slice(24, 48)}`,
    enrollmentId: `enrollment-${alpha.slice(48, 64)}`,
    channelId: `channel.v3.${alphaChannel.slice(0, 16)}`,
  };
}

function hexToAlpha(hex: string): string {
  return hex.replace(/[0-9]/g, (digit) => "ghijklmnop"[Number(digit)]);
}

// ---- authority asserts ------------------------------------------------------------------------------

type IntakeFacts = { applicationRevision: number };

function assertIntakeAuthority(
  event: Record<string, unknown>,
  appPointer: Record<string, unknown>,
  input: ApplyProvisioningInput,
  scope: ApplyAuthorizedScope,
): IntakeFacts {
  if (asString(event.kind) !== "receipt"
    || asString(event.eventName) !== "application.intake.recorded") {
    throw failedPrecondition("v3 intake receipt kind changed");
  }
  if (asString(event.effectState) !== "done") {
    throw failedPrecondition("v3 intake effect is not done");
  }
  if (asString(event.eventId) !== input.materialEventId) {
    throw failedPrecondition("v3 intake event identity changed");
  }
  if (asString(event.applicationId) !== input.applicationId
    || asString(event.traceId) !== input.traceId) {
    throw failedPrecondition("v3 intake application identity changed");
  }
  const receipt = asRecord(event.receipt);
  if (asString(receipt.eventId) !== input.materialEventId) {
    throw failedPrecondition("v3 intake receipt event changed");
  }
  if (asString(receipt.materialHash) !== input.materialHash) {
    throw failedPrecondition("v3 intake material hash changed");
  }
  if (asString(receipt.applicationId) !== input.applicationId) {
    throw failedPrecondition("v3 intake receipt application changed");
  }
  // BOTH revision counters must be PRESENT, positive safe integers, EQUAL to each other,
  // and pinned to the compiled scope — a missing counter on either side is itself a
  // fail-closed condition (Portal verifier residual 1; no `??` coalescing, no
  // single-present acceptance).
  const receiptRevisionPresent = receipt.applicationRevision !== undefined && receipt.applicationRevision !== null;
  const eventRevisionPresent = event.applicationRevision !== undefined && event.applicationRevision !== null;
  if (!receiptRevisionPresent || !eventRevisionPresent) {
    throw failedPrecondition("v3 intake application revision is missing");
  }
  const receiptRevision = integerOf(receipt.applicationRevision);
  const eventRevision = integerOf(event.applicationRevision);
  for (const candidate of [receiptRevision, eventRevision]) {
    if (!Number.isSafeInteger(candidate) || candidate < 1) {
      throw failedPrecondition("v3 intake application revision is invalid");
    }
  }
  if (receiptRevision !== eventRevision) {
    throw failedPrecondition("v3 intake application revision disagrees between receipt and envelope");
  }
  const applicationRevision = receiptRevision;
  if (applicationRevision !== scope.applicationRevision) {
    throw failedPrecondition("v3 intake application revision is outside the user-authorized scope");
  }
  // Exactly-one-done root: the application pointer must name this exact event/trace as its
  // latest, and its ENVELOPE counter must equal the event's own envelope revision
  // (envelope-to-envelope — a newer intake event supersedes this root, stale root fails closed).
  if (asString(appPointer.applicationId) !== input.applicationId
    || asString(appPointer.lastEventId) !== input.materialEventId
    || asString(appPointer.lastTraceId) !== input.traceId) {
    throw failedPrecondition("v3 intake application pointer disagrees");
  }
  const eventEnvelopeRevision = integerOf(event.revision);
  const lastRevision = integerOf(appPointer.lastRevision);
  if (!Number.isSafeInteger(eventEnvelopeRevision) || lastRevision !== eventEnvelopeRevision) {
    throw failedPrecondition("v3 intake application pointer revision disagrees");
  }
  return { applicationRevision };
}

function assertManagementAuthority(
  management: Record<string, unknown>,
  input: ApplyProvisioningInput,
  minted: MintedIdentityTuple,
  intake: IntakeFacts,
): { sourceRevision: number } {
  if (asString(management.classification) !== "managed") {
    throw failedPrecondition("application is not managed");
  }
  if (asString(management.reasonCode) !== "operator_assigned") {
    throw failedPrecondition("application management is not operator-assigned");
  }
  if (management.revoked === true) {
    throw failedPrecondition("application management is revoked");
  }
  if (asString(management.currentCampaignId) !== input.campaignId) {
    throw failedPrecondition("application campaign assignment changed");
  }
  if (asString(management.traceId) !== input.traceId) {
    throw failedPrecondition("application management trace changed");
  }
  const identity = asRecord(management.identity);
  if (asString(identity.applicationId) !== input.applicationId) {
    throw failedPrecondition("application management identity changed");
  }
  if (asString(identity.programId) !== input.programId) {
    throw failedPrecondition("application management program changed");
  }
  const sourceRevision = integerOf(management.sourceRevision);
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1) {
    throw failedPrecondition("application management revision is invalid");
  }
  if (sourceRevision !== intake.applicationRevision) {
    throw failedPrecondition("application management revision disagrees with intake");
  }
  // Assignment-ledger HEAD must be the managed assignment for the exact campaign at the
  // exact sourceRevision, the head revision must be UNIQUE in the ledger, and the ledger
  // must be monotonic (stale/duplicate-revision roots fail closed).
  const revisions = Array.isArray(management.revisions) ? management.revisions : [];
  if (revisions.length === 0) {
    throw failedPrecondition("application management ledger is empty");
  }
  const head = asRecord(revisions[revisions.length - 1]);
  if (asString(head.classification) !== "managed" || asString(head.campaignId) !== input.campaignId) {
    throw failedPrecondition("application management ledger head changed");
  }
  const headRevision = integerOf(head.revision);
  if (headRevision !== sourceRevision) {
    throw failedPrecondition("application management ledger head revision disagrees");
  }
  let previous = 0;
  let headRevisionCount = 0;
  for (const entryRaw of revisions) {
    const entryRevision = integerOf(asRecord(entryRaw).revision);
    if (!Number.isSafeInteger(entryRevision) || entryRevision <= previous) {
      throw failedPrecondition("application management ledger is not monotonic");
    }
    previous = entryRevision;
    if (entryRevision === headRevision) headRevisionCount += 1;
  }
  if (headRevisionCount !== 1) {
    throw failedPrecondition("application management ledger head revision is not unique");
  }
  // Reconciliation may only FILL null identity facts — any non-null disagreement is a
  // hard conflict (never silently overwritten in either direction).
  assertNullOrEqual(identity.portalCreatorId, input.portalCreatorId, "portalCreatorId");
  assertNullOrEqual(identity.fluCreatorId, minted.fluCreatorId, "fluCreatorId");
  assertNullOrEqual(identity.enrollmentId, minted.enrollmentId, "enrollmentId");
  assertNullOrEqual(identity.channelId, minted.channelId, "channelId");
  assertNullOrEqual(management.currentProgramId, input.programId, "currentProgramId");

  return { sourceRevision };
}

function assertNullOrEqual(stored: unknown, expected: string, field: string): void {
  if (stored !== null && stored !== undefined && stored !== "" && stored !== expected) {
    throw failedPrecondition(`application management identity conflict: ${field}`);
  }
}

// ---- single-use consumption ---------------------------------------------------------------------------

function assertExactConsumption(
  snapshot: FirebaseFirestore.DocumentSnapshot,
  expected: Record<string, unknown>,
): void {
  if (!snapshot.exists) {
    throw failedPrecondition("apply-binding authorization consumption record is missing");
  }
  const stored = asRecord(snapshot.data());
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (stored[key] !== expectedValue) {
      throw failedPrecondition(`apply-binding authorization consumption conflict: ${key}`);
    }
  }
}

// ---- ack outbox verification ------------------------------------------------------------------------

function assertAckOutboxMatchesBinding(
  outbox: Record<string, unknown>,
  input: ApplyProvisioningInput,
  minted: MintedIdentityTuple,
  sourceRevision: number,
): void {
  if (asString(outbox.applicationId) !== input.applicationId) {
    throw failedPrecondition("management ack outbox conflict: applicationId");
  }
  if (integerOf(outbox.sourceRevision) !== sourceRevision) {
    throw failedPrecondition("management ack outbox conflict: sourceRevision");
  }
  const deliveryState = asString(outbox.deliveryState);
  if (deliveryState === "dead_letter") {
    throw failedPrecondition("management ack outbox conflict: dead_letter");
  }
  if (!["queued", "leased", "delivered", "retryable_failed"].includes(deliveryState)) {
    throw failedPrecondition("management ack outbox conflict: deliveryState");
  }
  const snapshot = asRecord(outbox.snapshot);
  const expectations: Array<[string, unknown]> = [
    ["applicationId", input.applicationId],
    ["traceId", input.traceId],
    ["revision", sourceRevision],
    ["applicationRevision", sourceRevision],
    ["materialEventId", input.materialEventId],
    ["materialHash", input.materialHash],
    ["portalCreatorId", input.portalCreatorId],
    ["programId", input.programId],
    ["campaignId", input.campaignId],
    ["assignmentMode", "operator_assigned"],
    ["policyVersion", MANAGEMENT_ACK_WIRING_POLICY_VERSION],
    ["sourceEventId", deriveManagementAckSourceEventId(input.applicationId, sourceRevision)],
    ["fluCreatorId", minted.fluCreatorId],
    ["partnerId", minted.partnerId],
    ["enrollmentId", minted.enrollmentId],
    ["channelId", minted.channelId],
    ["status", "active"],
  ];
  for (const [field, expected] of expectations) {
    if (snapshot[field] !== expected) {
      throw failedPrecondition(`management ack snapshot conflict: ${field}`);
    }
  }
  // The authorized pilot has NO outreach and NO settlement code: presence is a conflict.
  if (snapshot.outreachId !== undefined && snapshot.outreachId !== null) {
    throw failedPrecondition("management ack snapshot conflict: outreachId");
  }
  if (snapshot.settlementCreatorCode !== undefined && snapshot.settlementCreatorCode !== null) {
    throw failedPrecondition("management ack snapshot conflict: settlementCreatorCode");
  }
  // Pinned acknowledgedAt semantics (P2#1): the enqueue-time ISO must be present and
  // valid so the drain's deterministic eventId is byte-stable across every retry.
  const acknowledgedAtIso = asString(snapshot.acknowledgedAtIso);
  if (!acknowledgedAtIso || !Number.isFinite(Date.parse(acknowledgedAtIso))) {
    throw failedPrecondition("management ack snapshot conflict: acknowledgedAtIso");
  }
}

// ---- immutability + identity keys + registry ------------------------------------------------------------

function assertExactBinding(value: unknown, expected: ImmutableApplyBinding): void {
  const stored = asRecord(value);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (stored[key] !== expectedValue) {
      throw failedPrecondition(`immutable binding conflict: ${key}`);
    }
  }
}

function applyBindingIdentityKeys(
  db: Firestore,
  input: ApplyProvisioningInput,
  minted: MintedIdentityTuple,
) {
  // Same doc-id convention as the Sheet-era engine (shared registry). The channel key kind
  // is `enrollment_channel` — the minted handle is NOT a YouTube channel id and must never
  // occupy or collide with the `youtube_channel` key namespace.
  const definitions = [
    { kind: "portal_creator" as const, value: input.portalCreatorId },
    { kind: "portal_enrollment" as const, value: `${input.programId}\0${minted.enrollmentId}` },
    { kind: "enrollment_channel" as const, value: minted.channelId },
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

function applyIdentityRegistryEntries(db: Firestore, minted: MintedIdentityTuple) {
  const definitions = [
    { kind: "flu_creator" as const, value: minted.fluCreatorId },
    { kind: "partner" as const, value: minted.partnerId },
    { kind: "enrollment" as const, value: minted.enrollmentId },
    { kind: "channel" as const, value: minted.channelId },
  ];
  return definitions.map(({ kind, value }) => ({
    kind,
    value,
    ref: db.collection(APPLY_IDENTITY_REGISTRY_COLLECTION).doc(`${kind}_${sha256(value).slice(0, 40)}`),
  }));
}

function assertIdentityKeysAvailable(
  keys: ReturnType<typeof applyBindingIdentityKeys>,
  snapshots: FirebaseFirestore.DocumentSnapshot[],
): void {
  const occupied = snapshots.findIndex((snapshot) => snapshot.exists);
  if (occupied >= 0) {
    throw failedPrecondition(`immutable binding conflict: ${keys[occupied]?.kind ?? "identity"}`);
  }
}

function assertRegistryAvailable(
  entries: ReturnType<typeof applyIdentityRegistryEntries>,
  snapshots: FirebaseFirestore.DocumentSnapshot[],
): void {
  const occupied = snapshots.findIndex((snapshot) => snapshot.exists);
  if (occupied >= 0) {
    throw failedPrecondition(`identity registry conflict: ${entries[occupied]?.kind ?? "identity"}`);
  }
}

function assertExactIdentityKey(
  value: unknown,
  key: ReturnType<typeof applyBindingIdentityKeys>[number] | undefined,
  bindingRef: string,
  expectedMappingHash: string,
): void {
  const stored = asRecord(value);
  if (!key
    || stored.authorityVersion !== APPLY_AUTHORITY_VERSION
    || stored.bindingRef !== bindingRef
    || stored.keyHash !== key.keyHash
    || stored.keyKind !== key.kind
    || stored.mappingHash !== expectedMappingHash) {
    throw failedPrecondition(`immutable binding key conflict: ${key?.kind ?? "identity"}`);
  }
}

function assertExactRegistryEntry(
  value: unknown,
  entry: ReturnType<typeof applyIdentityRegistryEntries>[number] | undefined,
  bindingRef: string,
  input: ApplyProvisioningInput,
): void {
  const stored = asRecord(value);
  if (!entry
    || stored.kind !== entry.kind
    || stored.value !== entry.value
    || stored.bindingRef !== bindingRef
    || stored.authorityVersion !== APPLY_AUTHORITY_VERSION
    || stored.applicationId !== input.applicationId
    || stored.traceId !== input.traceId
    || stored.mintDerivation !== MINT_DERIVATION
    || stored.userAuthorizationSha256 !== USER_AUTHORIZATION_SHA256
    || stored.acceptanceContractSha256 !== ACCEPTANCE_CONTRACT_SHA256) {
    throw failedPrecondition(`identity registry conflict: ${entry?.kind ?? "identity"}`);
  }
}

// ---- helpers -------------------------------------------------------------------------------------------

function receiptsDocId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 48);
}

function managementRecordDocId(applicationId: string): string {
  return String(applicationId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180);
}

function requireSnapshot(
  snapshot: FirebaseFirestore.DocumentSnapshot,
  message: string,
): Record<string, unknown> {
  if (!snapshot.exists) throw failedPrecondition(message);
  return asRecord(snapshot.data());
}

function integerOf(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : NaN;
}

function applyMappingHash(
  input: ApplyProvisioningInput,
  minted: MintedIdentityTuple,
  sourceManagementRevision: number,
): string {
  return sha256(JSON.stringify({
    applicationId: input.applicationId,
    campaignId: input.campaignId,
    channelId: minted.channelId,
    enrollmentId: minted.enrollmentId,
    fluCreatorId: minted.fluCreatorId,
    materialEventId: input.materialEventId,
    materialHash: input.materialHash,
    partnerId: minted.partnerId,
    portalCreatorId: input.portalCreatorId,
    programId: input.programId,
    sourceManagementRevision,
    traceId: input.traceId,
  }));
}

/**
 * Portal-aligned identifier gate: max 128 chars
 * (^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ — inherently excludes email-shaped strings).
 * `digitRunGuard` additionally rejects long digit runs (8+) so contact/UID/token-looking
 * numeric material can never enter a FREE-FORM identity field. The guard applies only to
 * non-exempt fields (Portal semantics): campaignId is operator free-form and guarded;
 * applicationId/traceId/materialEventId/materialHash/portalCreatorId are byte-verified
 * against durable ledgers or locked to hex/`pc_` formats, where digit runs are legitimate
 * hash material and fabrication is impossible.
 */
function requiredIdentifier(value: unknown, field: string, digitRunGuard = false): string {
  const result = asString(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) {
    throw invalidArgument(`${field} is invalid`);
  }
  if (digitRunGuard && /\d{8,}/.test(result)) {
    throw invalidArgument(`${field} must not contain long digit sequences`);
  }
  return result;
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
