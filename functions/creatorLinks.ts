import {
  FieldValue,
  type DocumentReference,
  type DocumentSnapshot,
} from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { assertMutationOwner, mutationOwnerUids } from "./mutationAuthorization";
import {
  isHumanGateRequiredFromSettings,
  readScpAutomationSettings,
  type ScpGateDecision,
} from "./scpAutomationSettings";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { safeDocId } from "./sheetIntakeService";
import { enqueueScpLifecycleRefreshEvent } from "./scpLifecycleProfiles";
import { assertStagingExternalSideEffectAllowed, isStagingSafetyRuntime } from "./stagingSafety";
import { resolveCanonicalProgramId, SCP_CANONICAL_PROGRAM_ID } from "./programCanonical";
import {
  confirmedProgramScope,
  readConfirmedProgramAliasRegistryState,
  readConfirmedProgramAliasRegistryStateInTransaction,
  type ConfirmedProgramAliasRegistryState,
} from "./programAliasRegistry";

type CreatorLinkSource = "manual" | "api" | "composed";
type CreatorLinkStatus = "active" | "failed" | "rolled_back";

type CreatorLinkRecord = {
  id: string;
  creatorId: string;
  programId: string;
  canonicalProgramId: string;
  programRef: string;
  rawProgramIdAlias: string | null;
  aliasRegistryRevision: string;
  applicationId: string | null;
  applicationRef: string | null;
  leadId: string | null;
  email: string;
  channelName: string;
  country: string;
  provider: "appsflyer";
  pid: "Flu";
  appsflyerOneLink: string;
  adjustLink: string;
  campaign: string;
  oneLinkId: string | null;
  templateId: "Rh1Y";
  domain: "xphero.onelink.me";
  params: Record<string, string>;
  source: CreatorLinkSource;
  mode: "manual_fallback" | "api" | "composed_url";
  status: CreatorLinkStatus;
  createdAtIso: string;
  createdBy: string;
  updatedAtIso: string;
  updatedBy: string;
};

type CreatorLinkInput = {
  leadId: string | null;
  creatorId: string;
  requestedCreatorId: string | null;
  programId: string;
  canonicalProgramId: string;
  programRef: string;
  rawProgramIdAlias: string;
  aliasRegistryRevision: string;
  identityProgramIds: string[];
  applicationId: string | null;
  applicationRef: string | null;
  email: string;
  channelName: string;
  country: string;
  appsflyerOneLink: string;
  adjustLink: string;
  campaign: string;
  source: CreatorLinkSource;
  status: CreatorLinkStatus;
  nowIso: string;
};

const ACTION = "creator_links.upsert";
const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;
const PROVIDER = "appsflyer" as const;
const PID = "Flu" as const;
const TEMPLATE_ID = "Rh1Y" as const;
const ONELINK_DOMAIN = "xphero.onelink.me" as const;
const API_ENABLED_ENV = "APPSFLYER_ONELINK_API_ENABLED";
const API_TOKEN_ENV = "APPSFLYER_ONELINK_TOKEN";

function creatorLinkProgramScope(
  rawProgramId: unknown,
  aliasRegistry: ConfirmedProgramAliasRegistryState,
  auth: ReturnType<typeof assertNonGuestAuth>,
): ReturnType<typeof confirmedProgramScope> {
  const programId = cleanId(rawProgramId);
  if (!programId) {
    throw withCallableError("failed-precondition", "creator link program scope is missing", auth);
  }
  try {
    return confirmedProgramScope(programId, aliasRegistry);
  } catch {
    throw withCallableError("failed-precondition", "creator link program scope is unresolved or ambiguous", auth);
  }
}

function confirmedCreatorLinkProgramIds(
  values: unknown[],
  aliasRegistry: ConfirmedProgramAliasRegistryState,
  auth: ReturnType<typeof assertNonGuestAuth>,
  label: string,
): string[] {
  const rawIds = [...new Set(values.map(cleanId).filter(Boolean))];
  try {
    return [...new Set(rawIds.map((programId) => confirmedProgramScope(programId, aliasRegistry).canonicalProgramId))];
  } catch {
    throw withCallableError("failed-precondition", `creator link ${label} scope is unresolved or ambiguous`, auth);
  }
}

export async function upsertCreatorLink(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, ACTION, WRITE_ROLES);
  try {
    const normalizedInput = normalizeCreatorLinkInput(request.data, new Date().toISOString());
    const dryRun = asRecord(request.data).dryRun === true;
    if (normalizedInput.source === "api") {
      // This environment gate is a pure fail-closed check, not an API side effect.
      // Run it before Firestore resolution so staging probes cannot accidentally depend
      // on production-shaped authority fixtures. AppsFlyer remains unreachable until the
      // exact program/lead/application scope below has been authorized.
      assertStagingExternalSideEffectAllowed("appsflyer");
    }
    const aliasRegistry = await readConfirmedProgramAliasRegistryState();
    const input = await resolveAuthoritativeCreatorLinkScope(normalizedInput, auth, aliasRegistry);

    // P1-7: OneLink issuance (link_issue) is a gated qualification action. The manual admin
    // path is the human-approval path and stays allowed; the automated API path must not run
    // while a human gate is required. Only the actual write is gated — dry-run previews are safe.
    if (!dryRun && input.source === "api") {
      const gate = isHumanGateRequiredFromSettings(
        "qualification",
        "link_issue",
        await readScpAutomationSettings(),
      );
      if (gate.required) {
        throw withGateError(auth, gate);
      }
    }

    const record = input.source === "api"
      ? await buildDormantApiCreatorLink(input, auth.userId)
      : input.source === "composed"
        ? buildComposedCreatorLink(input, auth.userId)
        : buildManualCreatorLink(input, auth.userId);
    const creatorLinkRef = adminDb.collection("creator_links").doc(record.id);

    if (dryRun) {
      return {
        ok: true,
        mode: "dry_run" as const,
        creatorLinkRef: creatorLinkRef.path,
        creatorLink: record,
        duplicatePrevented: false,
        behaviorLog: makeBehaviorLog(auth, ACTION, "success", "scp-automation"),
      };
    }

    if (!isFirestoreEmulator() && !isStagingSafetyRuntime()) {
      throw withCallableError(
        "failed-precondition",
        "production creator link writes are disabled; use demo-flu emulator or dryRun until live link issuance is approved",
        auth,
      );
    }

    let duplicatePrevented = false;
    await adminDb.runTransaction(async (transaction) => {
      // The direct read above prevents a foreign manager from reaching AppsFlyer or a
      // dry-run preview. Re-read the exact application + authoritative program here so
      // an ownership/scope change between preview and commit aborts the write. Firestore
      // retries this callback when either authority document changes before commit.
      const transactionAliasRegistry = await readConfirmedProgramAliasRegistryStateInTransaction(transaction);
      const transactionInput = await resolveAuthoritativeCreatorLinkScope(
        normalizedInput,
        auth,
        transactionAliasRegistry,
        (ref) => transaction.get(ref),
      );
      assertCreatorLinkScopeUnchanged(input, transactionInput, auth);

      const existingSnapshot = await transaction.get(creatorLinkRef);
      // One active OneLink is allowed per exact program/application/lead identity. The same
      // creator may legitimately participate in multiple programs, so another program's link
      // is not a duplicate. A legacy or corrupt document in the same exact scope still blocks.
      if (record.leadId) {
        const leadLinks = await transaction.get(
          adminDb.collection("creator_links").where("leadId", "==", record.leadId).limit(20),
        );
        const conflictingActive = leadLinks.docs.find(
          (doc) => doc.id !== creatorLinkRef.id
            && asString(doc.get("status"), "active") === "active"
            && sameCreatorLinkScope(doc.data() ?? {}, record, transactionAliasRegistry),
        );
        if (conflictingActive) {
          throw withCallableError(
            "failed-precondition",
            "an active creator link already exists for this exact program/application scope; refusing duplicate OneLink issuance",
            auth,
          );
        }
      }
      if (existingSnapshot.exists) {
        duplicatePrevented = true;
        assertNoLedgerConflict(existingSnapshot.data() ?? {}, record, auth, transactionAliasRegistry);
      }
      const existing = existingSnapshot.exists ? existingSnapshot.data() ?? {} : {};
      transaction.set(creatorLinkRef, {
        ...record,
        createdAtIso: asString(existing.createdAtIso, record.createdAtIso),
        createdBy: asString(existing.createdBy, record.createdBy),
        updatedAtIso: record.updatedAtIso,
        updatedBy: record.updatedBy,
        createdAt: existingSnapshot.exists ? existing.createdAt ?? FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      if (record.leadId) {
        transaction.set(adminDb.collection("program_sheet_leads").doc(record.leadId), {
          creatorId: record.creatorId,
          programId: record.canonicalProgramId,
          canonicalProgramId: record.canonicalProgramId,
          programRef: record.programRef,
          aliasRegistryRevision: record.aliasRegistryRevision,
          creatorLinkRef: creatorLinkRef.path,
          creatorLinkStatus: record.status,
          creatorLinkCampaign: record.campaign,
          latestCreatorLink: {
            ref: creatorLinkRef.path,
            campaign: record.campaign,
            source: record.source,
            status: record.status,
          },
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtIso: record.updatedAtIso,
        }, { merge: true });
      }
      if (record.applicationId && record.applicationRef) {
        transaction.set(adminDb.collection("program_applications").doc(record.applicationId), {
          creatorId: record.creatorId,
          programId: record.canonicalProgramId,
          canonicalProgramId: record.canonicalProgramId,
          programRef: record.programRef,
          aliasRegistryRevision: record.aliasRegistryRevision,
          creatorLinkRef: creatorLinkRef.path,
          creatorLinkStatus: record.status,
          creatorLinkCampaign: record.campaign,
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtIso: record.updatedAtIso,
        }, { merge: true });
      }
    });
    await enqueueScpLifecycleRefreshEvent({
      source: "creator_links",
      sourceRef: creatorLinkRef.path,
      reason: "creator_link_upserted",
      aliases: [{ leadId: record.leadId, creatorId: record.creatorId, email: record.email }],
      sourceUpdatedAtIso: record.updatedAtIso,
    });
    if (record.leadId) {
      await enqueueScpLifecycleRefreshEvent({
        source: "program_sheet_leads",
        sourceRef: `program_sheet_leads/${record.leadId}`,
        reason: "creator_link_ref_updated",
        aliases: [{ leadId: record.leadId, creatorId: record.creatorId, email: record.email }],
        sourceUpdatedAtIso: record.updatedAtIso,
      });
    }

    return {
      ok: true,
      mode: isStagingSafetyRuntime() ? "staging_write" as const : "emulator_write" as const,
      creatorLinkRef: creatorLinkRef.path,
      creatorLink: record,
      duplicatePrevented,
      behaviorLog: makeBehaviorLog(auth, ACTION, "success", "scp-automation"),
    };
  } catch (error) {
    if (error && typeof error === "object" && !("behaviorLog" in error)) {
      Object.assign(error, { behaviorLog: makeBehaviorLog(auth, ACTION, "blocked", "scp-automation") });
    }
    throw error;
  }
}

function normalizeCreatorLinkInput(value: unknown, fallbackNowIso: string): CreatorLinkInput {
  const data = asRecord(value);
  const source: CreatorLinkSource = data.source === "api" ? "api" : data.source === "composed" ? "composed" : "manual";
  const status = data.status === "failed" || data.status === "rolled_back" ? data.status : "active";
  const leadId = cleanId(data.leadId) || null;
  const email = cleanEmail(data.email);
  const channelName = text(data.channelName, text(data.name, ""));
  const country = text(data.country, "");
  const requestedCreatorId = cleanId(data.creatorId) || null;
  const creatorId = requestedCreatorId || derivedCreatorId(email || channelName || leadId || "scp-creator");
  const rawProgramIdAlias = cleanId(data.programId);
  const canonicalProgramId = resolveCanonicalProgramId(rawProgramIdAlias);
  const applicationId = cleanId(data.applicationId) || null;
  // P0-8: campaign is derived server-side from the stable identity. Admin-supplied campaign
  // strings are NOT trusted as an idempotency key — that is exactly what enabled a second
  // OneLink to be issued for the same lead just by changing the campaign text.
  const campaign = deterministicCampaign({ canonicalProgramId, applicationId, leadId, creatorId });
  const appsflyerOneLink = cleanUrl(data.appsflyerOneLink, ["xphero.onelink.me", "onelink.me"], source !== "manual");
  const adjustLink = cleanUrl(data.adjustLink, ["xphero.go.link", "go.link"], true);
  const nowIso = parseIso(data.nowIso, fallbackNowIso);

  if (source === "manual" && !appsflyerOneLink) {
    throw Object.assign(new Error("invalid-argument: AppsFlyer OneLink URL is required"), { code: "invalid-argument", errorCode: "normalize_creator_link_input_apps_flyer_link_url_required" });
  }

  return {
    leadId,
    creatorId,
    requestedCreatorId,
    programId: canonicalProgramId,
    canonicalProgramId,
    programRef: canonicalProgramId ? `programs/${canonicalProgramId}` : "",
    rawProgramIdAlias,
    aliasRegistryRevision: "",
    identityProgramIds: canonicalProgramId ? [canonicalProgramId] : [],
    applicationId,
    applicationRef: applicationId ? `program_applications/${applicationId}` : null,
    email,
    channelName,
    country,
    appsflyerOneLink,
    adjustLink,
    campaign,
    source,
    status,
    nowIso,
  };
}

async function resolveAuthoritativeCreatorLinkScope(
  input: CreatorLinkInput,
  auth: ReturnType<typeof assertNonGuestAuth>,
  aliasRegistry: ConfirmedProgramAliasRegistryState,
  readDocument: CreatorLinkScopeDocumentReader = (ref) => ref.get(),
): Promise<CreatorLinkInput> {
  if (!input.applicationId) {
    const programScope = creatorLinkProgramScope(
      input.rawProgramIdAlias || input.programId || SCP_CANONICAL_PROGRAM_ID,
      aliasRegistry,
      auth,
    );
    const { canonicalProgramId } = programScope;
    if (canonicalProgramId !== SCP_CANONICAL_PROGRAM_ID) {
      throw withCallableError("failed-precondition", "non-SCP creator links require an exact application scope", auth);
    }
    const programSnapshot = await readAuthoritativeCreatorLinkProgram(
      programScope,
      aliasRegistry,
      readDocument,
      auth,
    );
    const leadSnapshot = await readAuthoritativeCreatorLinkLead(input.leadId, readDocument, auth);
    const lead = leadSnapshot.data() ?? {};
    assertCreatorLinkLeadScope({
      lead,
      leadId: leadSnapshot.id,
      canonicalProgramId,
      applicationId: null,
      applicationRef: null,
      applicationCreatorId: null,
      requestedCreatorId: input.requestedCreatorId,
      aliasRegistry,
      auth,
      allowLegacyProgramlessLead: true,
    });
    assertCreatorLinkMutationAuthorized(auth, programSnapshot.data() ?? {}, null, lead);
    const creatorId = creatorLinkLeadCreatorId(lead, auth) || input.creatorId;
    return {
      ...input,
      leadId: leadSnapshot.id,
      creatorId,
      programId: canonicalProgramId,
      canonicalProgramId,
      programRef: programSnapshot.ref.path,
      aliasRegistryRevision: programScope.aliasRegistryRevision,
      identityProgramIds: programScope.identityProgramIds,
      campaign: deterministicCampaign({ ...input, canonicalProgramId, leadId: leadSnapshot.id, creatorId }),
    };
  }

  const applicationSnapshot = await readDocument(adminDb.collection("program_applications").doc(input.applicationId));
  if (!applicationSnapshot.exists) {
    throw withCallableError("failed-precondition", "creator link application scope does not exist", auth);
  }
  const application = applicationSnapshot.data() ?? {};
  const storedApplicationId = exactCreatorLinkAuthorityId(application.id, "application", auth);
  if (storedApplicationId && storedApplicationId !== input.applicationId) {
    throw withCallableError("failed-precondition", "creator link application identity mismatch", auth);
  }
  const rawApplicationProgramRef = asString(application.programRef, "");
  const applicationProgramRefId = idFromDocumentRef(rawApplicationProgramRef, "programs");
  if (rawApplicationProgramRef && !applicationProgramRefId) {
    throw withCallableError("failed-precondition", "creator link application program scope is unresolved or ambiguous", auth);
  }
  const applicationProgramIds = [
    application.canonicalProgramId,
    application.programId,
    applicationProgramRefId,
  ];
  const canonicalProgramIds = confirmedCreatorLinkProgramIds(
    applicationProgramIds,
    aliasRegistry,
    auth,
    "application program",
  );
  if (canonicalProgramIds.length !== 1) {
    throw withCallableError("failed-precondition", "creator link application program scope is unresolved or ambiguous", auth);
  }
  const canonicalProgramId = canonicalProgramIds[0];
  const requestedProgramId = input.rawProgramIdAlias || input.programId;
  const requestedCanonicalProgramId = requestedProgramId
    ? creatorLinkProgramScope(requestedProgramId, aliasRegistry, auth).canonicalProgramId
    : "";
  if (requestedCanonicalProgramId && requestedCanonicalProgramId !== canonicalProgramId) {
    throw withCallableError("failed-precondition", "creator link scope mismatch: requested program does not match application", auth);
  }

  const programScope = creatorLinkProgramScope(canonicalProgramId, aliasRegistry, auth);

  const programSnapshot = await readAuthoritativeCreatorLinkProgram(
    programScope,
    aliasRegistry,
    readDocument,
    auth,
  );

  const rawApplicationLeadRef = asString(application.leadRef, "");
  const applicationLeadRefId = idFromDocumentRef(rawApplicationLeadRef, "program_sheet_leads");
  if (rawApplicationLeadRef && !applicationLeadRefId) {
    throw withCallableError("failed-precondition", "creator link application lead scope is unresolved or ambiguous", auth);
  }
  const applicationLeadIds = [...new Set([
    exactCreatorLinkAuthorityId(application.leadId, "application lead", auth),
    applicationLeadRefId,
  ].filter(Boolean))];
  if (applicationLeadIds.length !== 1) {
    throw withCallableError("failed-precondition", "creator link application lead scope is unresolved or ambiguous", auth);
  }
  const leadId = applicationLeadIds[0];
  if (input.leadId && input.leadId !== leadId) {
    throw withCallableError("failed-precondition", "creator link scope mismatch: requested lead does not match application", auth);
  }
  const leadSnapshot = await readAuthoritativeCreatorLinkLead(leadId, readDocument, auth);
  const lead = leadSnapshot.data() ?? {};

  const applicationCreatorId = exactCreatorLinkAuthorityId(application.creatorId, "application creator", auth);
  if (!applicationCreatorId) {
    throw withCallableError("failed-precondition", "creator link application creator scope is missing", auth);
  }
  if (input.requestedCreatorId && applicationCreatorId !== input.requestedCreatorId) {
    throw withCallableError("failed-precondition", "creator link scope mismatch: requested creator does not match application", auth);
  }
  const expectedApplicationRef = `program_applications/${input.applicationId}`;
  const storedApplicationRef = asString(application.applicationRef, "");
  if (storedApplicationRef && storedApplicationRef !== expectedApplicationRef) {
    throw withCallableError("failed-precondition", "creator link application reference does not match", auth);
  }
  assertCreatorLinkLeadScope({
    lead,
    leadId,
    canonicalProgramId,
    applicationId: input.applicationId,
    applicationRef: expectedApplicationRef,
    applicationCreatorId,
    requestedCreatorId: input.requestedCreatorId,
    aliasRegistry,
    auth,
    allowLegacyProgramlessLead: false,
  });
  assertCreatorLinkMutationAuthorized(auth, programSnapshot.data() ?? {}, application, lead);
  const creatorId = applicationCreatorId;
  return {
    ...input,
    leadId,
    creatorId,
    programId: canonicalProgramId,
    canonicalProgramId,
    programRef: programSnapshot.ref.path,
    rawProgramIdAlias: input.rawProgramIdAlias || exactCreatorLinkAuthorityId(application.programId, "application program", auth),
    aliasRegistryRevision: programScope.aliasRegistryRevision,
    identityProgramIds: programScope.identityProgramIds,
    applicationRef: expectedApplicationRef,
    campaign: deterministicCampaign({
      canonicalProgramId,
      applicationId: input.applicationId,
      leadId,
      creatorId,
    }),
  };
}

type CreatorLinkScopeDocumentReader = (
  ref: DocumentReference,
) => Promise<DocumentSnapshot>;

async function readAuthoritativeCreatorLinkProgram(
  scope: ReturnType<typeof confirmedProgramScope>,
  aliasRegistry: ConfirmedProgramAliasRegistryState,
  readDocument: CreatorLinkScopeDocumentReader,
  auth: ReturnType<typeof assertNonGuestAuth>,
): Promise<DocumentSnapshot> {
  // Generic confirmed aliases authorize only their canonical document. SCP keeps
  // its explicit compatibility identities during cutover, but canonical remains
  // the first read. A proposed/malformed generic alias therefore stays a distinct
  // program and can never borrow another program's owner/configuration document.
  const { canonicalProgramId } = scope;
  const candidateIds = [...new Set([
    canonicalProgramId,
    ...(canonicalProgramId === SCP_CANONICAL_PROGRAM_ID ? scope.identityProgramIds : []),
  ].filter(Boolean))];

  for (const candidateId of candidateIds) {
    const snapshot = await readDocument(adminDb.collection("programs").doc(candidateId));
    if (!snapshot.exists) continue;
    const program = snapshot.data() ?? {};
    const identityCandidates = [...new Set([
      snapshot.id,
      exactCreatorLinkAuthorityId(program.id, "program", auth),
      exactCreatorLinkAuthorityId(program.canonicalProgramId, "program canonical", auth),
      exactCreatorLinkAuthorityId(program.programId, "program declared", auth),
    ].filter(Boolean).map((id) => creatorLinkProgramScope(id, aliasRegistry, auth).canonicalProgramId))];
    if (identityCandidates.length !== 1 || identityCandidates[0] !== canonicalProgramId) {
      throw withCallableError(
        "failed-precondition",
        "creator link program scope is unresolved or ambiguous",
        auth,
      );
    }
    return snapshot;
  }

  throw withCallableError("failed-precondition", "creator link program scope does not exist", auth);
}

async function readAuthoritativeCreatorLinkLead(
  leadId: string | null,
  readDocument: CreatorLinkScopeDocumentReader,
  auth: ReturnType<typeof assertNonGuestAuth>,
): Promise<DocumentSnapshot> {
  if (!leadId) {
    throw withCallableError("failed-precondition", "creator link requires an exact lead scope", auth);
  }
  const snapshot = await readDocument(adminDb.collection("program_sheet_leads").doc(leadId));
  if (!snapshot.exists) {
    throw withCallableError("failed-precondition", "creator link lead scope does not exist", auth);
  }
  const lead = snapshot.data() ?? {};
  const declaredLeadIds = [...new Set([
    exactCreatorLinkAuthorityId(lead.id, "lead", auth),
    exactCreatorLinkAuthorityId(lead.leadId, "lead", auth),
  ].filter(Boolean))];
  if (declaredLeadIds.some((declaredLeadId) => declaredLeadId !== snapshot.id)) {
    throw withCallableError("failed-precondition", "creator link lead identity is unresolved or ambiguous", auth);
  }
  return snapshot;
}

function assertCreatorLinkLeadScope(input: {
  lead: Record<string, unknown>;
  leadId: string;
  canonicalProgramId: string;
  applicationId: string | null;
  applicationRef: string | null;
  applicationCreatorId: string | null;
  requestedCreatorId: string | null;
  aliasRegistry: ConfirmedProgramAliasRegistryState;
  auth: ReturnType<typeof assertNonGuestAuth>;
  allowLegacyProgramlessLead: boolean;
}): void {
  const rawLeadProgramRef = asString(input.lead.programRef, "");
  const leadProgramRefId = idFromDocumentRef(rawLeadProgramRef, "programs");
  if (rawLeadProgramRef && !leadProgramRefId) {
    throw withCallableError("failed-precondition", "creator link lead program scope is unresolved or ambiguous", input.auth);
  }
  const leadProgramIds = confirmedCreatorLinkProgramIds([
    input.lead.canonicalProgramId,
    input.lead.programId,
    input.lead.bridgedProgramId,
    leadProgramRefId,
  ], input.aliasRegistry, input.auth, "lead program");
  if (leadProgramIds.length > 1
    || (leadProgramIds[0] && leadProgramIds[0] !== input.canonicalProgramId)
    || (!input.allowLegacyProgramlessLead && leadProgramIds.length !== 1)) {
    throw withCallableError("failed-precondition", "creator link lead program scope does not match the application", input.auth);
  }

  if (input.applicationId && input.applicationRef) {
    const rawLeadApplicationRef = asString(input.lead.applicationRef, "");
    const leadApplicationRefId = idFromDocumentRef(rawLeadApplicationRef, "program_applications");
    if (rawLeadApplicationRef && !leadApplicationRefId) {
      throw withCallableError("failed-precondition", "creator link lead application scope is unresolved or ambiguous", input.auth);
    }
    const rawBridgedApplicationRef = asString(input.lead.bridgedApplicationRef, "");
    const bridgedApplicationRefId = idFromDocumentRef(rawBridgedApplicationRef, "program_applications");
    if (rawBridgedApplicationRef && !bridgedApplicationRefId) {
      throw withCallableError("failed-precondition", "creator link bridged lead application scope is unresolved or ambiguous", input.auth);
    }
    const leadApplicationIds = [...new Set([
      exactCreatorLinkAuthorityId(input.lead.applicationId, "lead application", input.auth),
      leadApplicationRefId,
      bridgedApplicationRefId,
    ].filter(Boolean))];
    if (leadApplicationIds.length !== 1 || leadApplicationIds[0] !== input.applicationId) {
      throw withCallableError("failed-precondition", "creator link lead does not belong to the exact application", input.auth);
    }
  }

  const leadCreatorId = creatorLinkLeadCreatorId(input.lead, input.auth);
  if (input.applicationId && !leadCreatorId) {
    throw withCallableError("failed-precondition", "creator link lead creator scope is missing", input.auth);
  }
  if (input.applicationCreatorId && leadCreatorId && leadCreatorId !== input.applicationCreatorId) {
    throw withCallableError("failed-precondition", "creator link application and lead creator scopes do not match", input.auth);
  }
  const authoritativeCreatorId = input.applicationCreatorId || leadCreatorId;
  if (input.requestedCreatorId && authoritativeCreatorId && input.requestedCreatorId !== authoritativeCreatorId) {
    throw withCallableError("failed-precondition", "creator link requested creator does not match the authoritative lead", input.auth);
  }
}

function creatorLinkLeadCreatorId(
  lead: Record<string, unknown>,
  auth: ReturnType<typeof assertNonGuestAuth>,
): string {
  const creatorIds = [...new Set([
    exactCreatorLinkAuthorityId(lead.creatorId, "lead creator", auth),
    exactCreatorLinkAuthorityId(lead.bridgedCreatorId, "lead bridged creator", auth),
  ].filter(Boolean))];
  if (creatorIds.length > 1) {
    throw withCallableError("failed-precondition", "creator link lead creator scope is unresolved or ambiguous", auth);
  }
  return creatorIds[0] ?? "";
}

function assertCreatorLinkMutationAuthorized(
  auth: ReturnType<typeof assertNonGuestAuth>,
  program: Record<string, unknown>,
  application: Record<string, unknown> | null,
  lead: Record<string, unknown>,
): void {
  const actor = { uid: auth.userId, role: auth.role };
  const programOwners = mutationOwnerUids(program, { includeCreatedBy: true });
  const applicationOwners = mutationOwnerUids(application, { includeCreatedBy: true });
  const leadOwners = mutationOwnerUids(lead, { includeCreatedBy: true });
  assertMutationOwner(actor, programOwners, "creator link program");
  if (application) assertMutationOwner(actor, applicationOwners, "creator link application");
  if (leadOwners.length) assertMutationOwner(actor, leadOwners, "creator link lead");
  assertMutationOwner(actor, [...programOwners, ...applicationOwners, ...leadOwners], "creator link program/application/lead");
}

function assertCreatorLinkScopeUnchanged(
  before: CreatorLinkInput,
  after: CreatorLinkInput,
  auth: ReturnType<typeof assertNonGuestAuth>,
): void {
  const stableFields = [
    "canonicalProgramId",
    "programRef",
    "aliasRegistryRevision",
    "applicationId",
    "applicationRef",
    "leadId",
    "creatorId",
    "campaign",
  ] as const;
  if (stableFields.some((field) => before[field] !== after[field])
    || before.identityProgramIds.join("\u0000") !== after.identityProgramIds.join("\u0000")) {
    throw withCallableError(
      "failed-precondition",
      "creator link authoritative scope changed during issuance",
      auth,
    );
  }
}

function buildManualCreatorLink(input: CreatorLinkInput, userId: string): CreatorLinkRecord {
  return baseCreatorLinkRecord(input, userId, {
    mode: "manual_fallback",
    oneLinkId: null,
    source: "manual",
    appsflyerOneLink: input.appsflyerOneLink,
    adjustLink: input.adjustLink,
  });
}

// OneLink long URL은 API 토큰 없이도 유효한 어트리뷰션 링크다 — 템플릿 도메인 +
// 파라미터 조합(pid 필수)만으로 만들며, AppsFlyer 공식 가이드도 대량 캠페인에서
// 스프레드시트 수식 조합을 지원한다. API(v2)는 "단축링크"가 필요할 때만 쓴다.
// 사람이 버튼으로 실행하는 human-approval 경로라 link_issue 자동화 게이트 대상이 아니다.
function composedOneLinkUrl(input: CreatorLinkInput): string {
  const params = new URLSearchParams({
    pid: PID,
    c: input.campaign,
    deep_link_value: input.creatorId,
    af_channel: "scp",
    af_adset: input.programId,
    ...(input.leadId ? { af_sub1: input.leadId } : {}),
  });
  return `https://${ONELINK_DOMAIN}/${TEMPLATE_ID}?${params.toString()}`;
}

function buildComposedCreatorLink(input: CreatorLinkInput, userId: string): CreatorLinkRecord {
  return baseCreatorLinkRecord(input, userId, {
    mode: "composed_url",
    oneLinkId: null,
    source: "composed",
    appsflyerOneLink: composedOneLinkUrl(input),
    adjustLink: input.adjustLink,
  });
}

async function buildDormantApiCreatorLink(input: CreatorLinkInput, userId: string): Promise<CreatorLinkRecord> {
  assertStagingExternalSideEffectAllowed("appsflyer");
  if (process.env[API_ENABLED_ENV] !== "1") {
    throw Object.assign(new Error("failed-precondition: AppsFlyer OneLink API mode is dormant; use manual source"), { code: "failed-precondition", errorCode: "build_dormant_api_creator_link_apps_flyer_link_api_mode" });
  }
  const token = asString(process.env[API_TOKEN_ENV], "");
  if (!token) {
    throw Object.assign(new Error("failed-precondition: APPSFLYER_ONELINK_TOKEN is not configured"), { code: "failed-precondition", errorCode: "build_dormant_api_creator_link_appsflyer_onelink_token_configured" });
  }
  const payload = {
    data: {
      pid: PID,
      c: input.campaign,
      deep_link_value: input.creatorId,
      af_channel: "scp",
      af_adset: input.programId,
    },
  };
  const response = await fetch(`https://onelink.appsflyer.com/shortlink/v2/${ONELINK_DOMAIN}/${TEMPLATE_ID}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  if (response.status === 429) {
    throw Object.assign(new Error("resource-exhausted: AppsFlyer OneLink rate or monthly quota exceeded"), { code: "resource-exhausted", errorCode: "build_dormant_api_creator_link_resource_exhausted_apps_flyer_link" });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`failed-precondition: AppsFlyer OneLink API failed (${response.status})`), { code: "failed-precondition", errorCode: "build_dormant_api_creator_link_apps_flyer_link_api" });
  }
  const body = await response.json().catch(() => ({}));
  const bodyRecord = asRecord(body);
  const shortUrl = cleanUrl(bodyRecord.shortUrl ?? bodyRecord.shortlink ?? bodyRecord.short_url ?? bodyRecord.url, ["xphero.onelink.me", "onelink.me"]);
  const oneLinkId = text(bodyRecord.oneLinkId ?? bodyRecord.id, "");
  return baseCreatorLinkRecord(input, userId, {
    mode: "api",
    oneLinkId,
    source: "api",
    appsflyerOneLink: shortUrl || input.appsflyerOneLink,
    adjustLink: input.adjustLink,
  });
}

function baseCreatorLinkRecord(
  input: CreatorLinkInput,
  userId: string,
  apiFields: {
    mode: CreatorLinkRecord["mode"];
    oneLinkId: string | null;
    source: CreatorLinkSource;
    appsflyerOneLink: string;
    adjustLink: string;
  },
): CreatorLinkRecord {
  const id = creatorLinkDocId(input);
  return {
    id,
    creatorId: input.creatorId,
    programId: input.canonicalProgramId,
    canonicalProgramId: input.canonicalProgramId,
    programRef: input.programRef,
    rawProgramIdAlias: input.rawProgramIdAlias || null,
    aliasRegistryRevision: input.aliasRegistryRevision,
    applicationId: input.applicationId,
    applicationRef: input.applicationRef,
    leadId: input.leadId,
    email: input.email,
    channelName: input.channelName,
    country: input.country,
    provider: PROVIDER,
    pid: PID,
    appsflyerOneLink: apiFields.appsflyerOneLink,
    adjustLink: apiFields.adjustLink,
    campaign: input.campaign,
    oneLinkId: apiFields.oneLinkId,
    templateId: TEMPLATE_ID,
    domain: ONELINK_DOMAIN,
    params: {
      c: input.campaign,
      deep_link_value: input.creatorId,
      af_channel: "scp",
      af_adset: input.canonicalProgramId,
      ...(input.applicationId ? { af_sub2: input.applicationId } : {}),
    },
    source: apiFields.source,
    mode: apiFields.mode,
    status: input.status,
    createdAtIso: input.nowIso,
    createdBy: userId,
    updatedAtIso: input.nowIso,
    updatedBy: userId,
  };
}

function assertNoLedgerConflict(
  existing: Record<string, unknown>,
  next: CreatorLinkRecord,
  auth: ReturnType<typeof assertNonGuestAuth>,
  aliasRegistry: ConfirmedProgramAliasRegistryState,
) {
  const existingLeadId = asString(existing.leadId, "");
  const existingCreatorId = asString(existing.creatorId, "");
  const existingProgramId = resolveCanonicalProgramId(
    existing.canonicalProgramId || existing.programId,
    aliasRegistry.aliasMap,
  );
  const existingApplicationId = cleanId(existing.applicationId);
  if ((existingLeadId && next.leadId && existingLeadId !== next.leadId)
    || (existingCreatorId && existingCreatorId !== next.creatorId)
    || (existingProgramId && existingProgramId !== next.canonicalProgramId)
    || (existingApplicationId !== (next.applicationId || ""))) {
    throw withCallableError("failed-precondition", "creator link campaign is already assigned to a different creator/program", auth);
  }
}

function sameCreatorLinkScope(
  existing: Record<string, unknown>,
  next: CreatorLinkRecord,
  aliasRegistry: ConfirmedProgramAliasRegistryState,
): boolean {
  return resolveCanonicalProgramId(
    existing.canonicalProgramId || existing.programId,
    aliasRegistry.aliasMap,
  ) === next.canonicalProgramId
    && cleanId(existing.applicationId) === (next.applicationId || "")
    && cleanId(existing.leadId) === (next.leadId || "");
}

function cleanId(value: unknown): string {
  const raw = asString(value, "").trim();
  return raw ? safeDocId(raw) : "";
}

function exactCreatorLinkAuthorityId(
  value: unknown,
  label: string,
  auth: ReturnType<typeof assertNonGuestAuth>,
): string {
  const raw = asString(value, "").trim();
  if (!raw) return "";
  const id = cleanId(raw);
  if (!id || id !== raw) {
    throw withCallableError("failed-precondition", `creator link ${label} identity is invalid`, auth);
  }
  return id;
}

function derivedCreatorId(seed: string): string {
  return `CR_${safeDocId(seed).slice(0, 64) || "scp"}`;
}

function cleanEmail(value: unknown): string {
  const raw = asString(value, "").toLowerCase().slice(0, 180);
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw) ? raw : "";
}

// Server-deterministic campaign. Keyed off the stable identity (lead first, else creator) so
// the same lead always resolves to the same campaign regardless of admin-supplied text.
function deterministicCampaign(input: Pick<CreatorLinkInput, "canonicalProgramId" | "applicationId" | "leadId" | "creatorId">): string {
  const subject = input.leadId || input.creatorId || "creator";
  if (input.canonicalProgramId === SCP_CANONICAL_PROGRAM_ID && !input.applicationId) {
    return `weaponrpg_scp_${safeDocId(subject).slice(0, 96) || "creator"}`;
  }
  return `program_${safeDocId(input.canonicalProgramId)}_${safeDocId(input.applicationId || "legacy")}_${safeDocId(subject)}`.slice(0, 180);
}

// Idempotency key for a creator link. Derived from the stable identity, never from the
// client-supplied campaign, so repeat issuance for the same lead maps to the same document.
export function creatorLinkIdentityDocId(input: Pick<CreatorLinkInput, "canonicalProgramId" | "applicationId" | "leadId" | "creatorId">): string {
  const subject = input.leadId ? `lead:${input.leadId}` : `creator:${input.creatorId}`;
  if (input.canonicalProgramId === SCP_CANONICAL_PROGRAM_ID && !input.applicationId) {
    return safeDocId(subject);
  }
  return safeDocId(`creator-link:${input.canonicalProgramId}:${input.applicationId || "legacy"}:${subject}`);
}

function creatorLinkDocId(input: CreatorLinkInput): string {
  return creatorLinkIdentityDocId(input);
}

function idFromDocumentRef(value: unknown, collection: string): string {
  const raw = asString(value, "").trim();
  const match = new RegExp(`^${collection}/([^/]+)$`).exec(raw);
  if (!match) return "";
  const id = cleanId(match[1]);
  return id && id === match[1] ? id : "";
}

function cleanUrl(value: unknown, allowedHosts: string[], optional = false): string {
  const raw = asString(value, "").slice(0, 600);
  if (!raw) return optional ? "" : "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase();
    if (!allowedHosts.some((allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`))) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function text(value: unknown, fallback: string): string {
  return asString(value, fallback).replace(/\s+/g, " ").trim().slice(0, 180);
}

function parseIso(value: unknown, fallback: string): string {
  const raw = asString(value, "");
  const date = raw ? new Date(raw) : new Date(fallback);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function isFirestoreEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true" || Boolean(process.env.FIRESTORE_EMULATOR_HOST);
}

function withCallableError(code: string, message: string, auth: ReturnType<typeof assertNonGuestAuth>) {
  return Object.assign(new Error(message), {
    code,
    behaviorLog: makeBehaviorLog(auth, ACTION, "blocked", "scp-automation"),
  });
}

function withGateError(auth: ReturnType<typeof assertNonGuestAuth>, gate: ScpGateDecision) {
  return Object.assign(
    new Error(`failed-precondition: human approval gate required before automated OneLink issuance (${gate.reason})`),
    {
      code: "failed-precondition", errorCode: "with_gate_error_human_approval_gate_required_before",
      behaviorLog: makeBehaviorLog(auth, ACTION, "blocked", "scp-automation"),
      scpGate: gate,
    },
  );
}
