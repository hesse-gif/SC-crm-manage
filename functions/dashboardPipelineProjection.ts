import { FieldPath, type Query } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { isOperationalFixtureRecord } from "./operationalFixtureProvenance";
import { asRecord, asString, assertNonGuestAuth, makeBehaviorLog } from "./shared";
import type { AuthContext, CallableRequestShape } from "./shared";
import { lazyConversationMailAccessScope } from "./conversationMailAccessScope";
import { canReadScpConversationRowForOrg, isExplicitScpMailAccountRow } from "./mailConversationAuthorization";
import { resolveViewAsTarget } from "./mailAccountCallables";
import {
  decodeDashboardPipelineLaneCursor,
  fillDashboardPipelineProjectionPageWithLegacy,
  hasUsableDashboardUpdatedAtIso,
  isDashboardPipelineTerminalRow,
  loadDashboardPipelineProjectionPages,
  projectDashboardPipelineDocumentRow,
  type DashboardPipelineProjectionPage,
  type DashboardPipelineProjectionReadRequest,
  type DashboardPipelineProjectionSource,
} from "./dashboardPipelineProjectionCore";

type DashboardProjectionDatasetKey = "programApplications" | "programSheetLeads" | "creators" | "conversations";

type DashboardProjectionSpec = {
  source: DashboardPipelineProjectionSource;
  collection: "program_applications" | "program_sheet_leads" | "creators" | "conversations";
  datasetKey: DashboardProjectionDatasetKey;
  orderField: "updatedAtIso";
  fieldMask: readonly string[];
};

const MIN_UPDATED_AT_ISO = "0000-01-01T00:00:00.000Z";
const MAX_UPDATED_AT_ISO = "9999-12-31T23:59:59.999Z";

const OWNER_SCOPE_FIELD_MASK = [
  "createdBy",
  "createdByUid",
  "ownerUid",
  "ownerUserId",
  "managerUid",
  "managerUserId",
  "assigneeUid",
  "assignedToUid",
  "memberUid",
  "userId",
  "programOwnerUid",
  "campaignOwnerUid",
  "creatorOwnerUid",
  "linkedBy",
  "reviewedBy",
  "ownerUids",
  "managerUids",
  "assigneeUids",
  "assignedToUids",
  "memberUids",
  "programOwnerUids",
  "campaignOwnerUids",
  "authorizedUids",
  "createdByEmail",
  "ownerEmail",
  "managerEmail",
  "assigneeEmail",
  "programOwnerEmail",
  "campaignOwnerEmail",
  "owner",
  "ownerName",
  "manager",
  "managerName",
  "assignee",
  "assignedTo",
  "reviewer",
  "createdByName",
  "programOwnerName",
  "campaignOwnerName",
] as const;

const APPLICATION_FIELD_MASK = [
  "programId",
  "canonicalProgramId",
  "programTitle",
  "status",
  "participationActive",
  "participationStatus",
  "participationStage",
  "participationUpdatedAtIso",
  "submittedAtIso",
  "updatedAtIso",
  "creatorId",
  "conversationId",
  "leadId",
  "leadRef",
  "name",
  "email",
  "handle",
  "youtubeUrl",
  "channelId",
  "platform",
  "followers",
  "avatar",
  ...OWNER_SCOPE_FIELD_MASK,
  "deletedAt",
  "archivedAt",
  "deletedAtIso",
  "archivedAtIso",
  "mock",
  "seedId",
  "discoverySource",
  "source",
] as const;

const LEAD_FIELD_MASK = [
  "programId",
  "canonicalProgramId",
  "bridgedProgramId",
  "program",
  "programSlug",
  "programTitle",
  "programName",
  "bridgedCreatorId",
  "bridgedApplicationRef",
  "applicationId",
  "applicationRef",
  "creatorId",
  "qualificationStatus",
  "finalVerdict",
  "status",
  "createdAtIso",
  "updatedAtIso",
  "name",
  "email",
  "handle",
  "youtubeUrl",
  "channelId",
  "platform",
  "followers",
  "subscribers",
  "avatar",
  "applicant",
  "metrics.subscribers",
  "deletedAt",
  "archivedAt",
  "deletedAtIso",
  "archivedAtIso",
  "mock",
  "seedId",
  "discoverySource",
  "source",
] as const;

const CREATOR_FIELD_MASK = [
  "name",
  "handle",
  "email",
  "type",
  "avatar",
  "platform",
  "followers",
  "region",
  "category",
  "stage",
  "budgetKRW",
  "guideStatus",
  "aiHandling",
  "lastActivity",
  "updatedAtIso",
  "agencyId",
  "team",
  "youtubeUrl",
  "channelId",
  "profileMatchedEmail",
  "programTitle",
  "campaignId",
  "campaignTitle",
  "protected",
  "humanGate",
  "programId",
  "canonicalProgramId",
  "programIds",
  "applicationId",
  "applicationRef",
  "leadId",
  "leadRef",
  "sourceRef",
  ...OWNER_SCOPE_FIELD_MASK,
  "deletedAt",
  "archivedAt",
  "deletedAtIso",
  "archivedAtIso",
  "mock",
  "seedId",
  "discoverySource",
  "source",
] as const;

const CONVERSATION_FIELD_MASK = [
  "threadId",
  "contextKey",
  "type",
  "creatorId",
  "creatorName",
  "creatorAvatar",
  "creatorEmail",
  "creatorHandle",
  "creatorPlatform",
  "creatorFollowers",
  "programId",
  "canonicalProgramId",
  "programIds",
  "programTitle",
  "campaignId",
  "campaignTitle",
  "discoverySource",
  "source",
  "unread",
  "aiActive",
  "alert",
  "lastMessage",
  "lastMessageFrom",
  "hasCreatorReply",
  "lastMessageAtIso",
  "updatedAtIso",
  "autoReplyStatus",
  "autoReplyBlockedReason",
  "deliveryState",
  "lastDeliveryState",
  "outreachStatus",
  "status",
  "applicationId",
  "applicationRef",
  "participationActive",
  "participationStatus",
  "participationStage",
  "participationUpdatedAtIso",
  "leadId",
  "leadRef",
  "sourceRef",
  "youtubeUrl",
  "channelId",
  // Flu conversation org-filter round 2 (codex adversarial review): visibleProjectionRow below
  // needs both fields to apply the same scp mailbox-entitlement + per-org gate
  // functions/read.ts's list/room/message-source reads already enforce — this dashboard lane read
  // the raw "conversations" collection with no mailbox/org authorization at all.
  "mailAccountId",
  "orgId",
  ...OWNER_SCOPE_FIELD_MASK,
  "deletedAt",
  "archivedAt",
  "deletedAtIso",
  "archivedAtIso",
  "mock",
  "seedId",
] as const;

const PROJECTION_SPECS: Record<DashboardPipelineProjectionSource, DashboardProjectionSpec> = {
  applications: {
    source: "applications",
    collection: "program_applications",
    datasetKey: "programApplications",
    orderField: "updatedAtIso",
    fieldMask: APPLICATION_FIELD_MASK,
  },
  leads: {
    source: "leads",
    collection: "program_sheet_leads",
    datasetKey: "programSheetLeads",
    orderField: "updatedAtIso",
    fieldMask: LEAD_FIELD_MASK,
  },
  creators: {
    source: "creators",
    collection: "creators",
    datasetKey: "creators",
    orderField: "updatedAtIso",
    fieldMask: CREATOR_FIELD_MASK,
  },
  conversations: {
    source: "conversations",
    collection: "conversations",
    datasetKey: "conversations",
    orderField: "updatedAtIso",
    fieldMask: CONVERSATION_FIELD_MASK,
  },
};

function firebaseConfigProjectId(): string {
  const raw = process.env.FIREBASE_CONFIG;
  if (!raw) return "";
  try {
    return asString(asRecord(JSON.parse(raw)).projectId);
  } catch {
    return "";
  }
}

function fixtureRowsVisible(): boolean {
  const projectId = process.env.GCLOUD_PROJECT
    || process.env.GOOGLE_CLOUD_PROJECT
    || process.env.GCP_PROJECT
    || firebaseConfigProjectId();
  return process.env.FUNCTIONS_EMULATOR === "true"
    || Boolean(process.env.FIRESTORE_EMULATOR_HOST)
    || projectId === "demo-flu";
}

type DashboardConversationOrgScope = { viewerOrgId: string | null; isSuperAdmin: boolean; hasScpEntitlement: boolean };

function visibleProjectionRow(
  _key: DashboardProjectionDatasetKey,
  row: Record<string, unknown>,
  _auth: AuthContext,
  collection: DashboardProjectionSpec["collection"],
  source: DashboardPipelineProjectionSource,
  conversationOrgScope: DashboardConversationOrgScope | null,
): boolean {
  if (row.deletedAt || row.archivedAt || row.deletedAtIso || row.archivedAtIso) return false;
  if (isDashboardPipelineTerminalRow(source, row)) return false;
  if (!fixtureRowsVisible() && isOperationalFixtureRecord(row, collection)) return false;
  // Flu conversation org-filter round 4 (codex adversarial review round 2, 2026-09-28 owner scope
  // decision): this lane reads the raw "conversations" collection directly and previously applied
  // no scp authorization at all. Only the scp gate is applied here (not the broader PR#216
  // mailbox-entitlement check for EVERY mailAccountId — this dashboard lane never gated on that,
  // and retrofitting it would hide every legacy blank-mailAccountId conversation from non-scp
  // managers, well beyond this fix's scope). The gate is a no-op for any row that isn't explicitly
  // mailAccountId:"scp"; for one that is, it now requires BOTH the positive scp grant and org match
  // (round 2 finding #1 — org match alone let any org member read the org's own scp projection).
  if (source === "conversations" && conversationOrgScope && !canReadScpConversationRowForOrg(row, conversationOrgScope)) {
    return false;
  }
  return true;
}

function invalidCursorError(auth: AuthContext, source: DashboardPipelineProjectionSource): Error {
  const error = new Error(`invalid-argument: invalid ${source} cursor`);
  Object.assign(error, {
    code: "invalid-argument", errorCode: "invalid_cursor_error_invalid_cursor",
    behaviorLog: makeBehaviorLog(auth, "data.dashboardPipelineProjection.read", "error"),
  });
  return error;
}

async function readDashboardProjectionPage(
  request: DashboardPipelineProjectionReadRequest,
  auth: AuthContext,
  // Flu conversation org-filter round 4 (codex adversarial review round 2, finding #3): the
  // viewAs-derived identity used ONLY for the conversations lane's scp scope resolution — a
  // super_admin viewing as a restricted member must get that member's real (narrower) scp scope,
  // not their own super_admin bypass. `auth` above stays the REAL caller for every
  // behaviorLog/cursor-error audit trail, matching functions/read.ts effectiveConversationAuth's
  // identical split.
  conversationScopeAuth: AuthContext,
): Promise<DashboardPipelineProjectionPage> {
  const spec = PROJECTION_SPECS[request.source];
  const rawCursor = asString(request.cursor);
  const decodedCursor = rawCursor
    ? decodeDashboardPipelineLaneCursor(rawCursor, request.source)
    : null;
  if (rawCursor && !decodedCursor) throw invalidCursorError(auth, request.source);
  // Flu conversation org-filter round 22 (codex adversarial review round 22, finding #2): only the
  // conversations lane ever needs the scp scope, and even then only when a fetched batch actually
  // contains an explicit-scp row (isExplicitScpMailAccountRow no-ops canReadScpConversationRowForOrg
  // for every other row regardless of scope). Resolving it EAGERLY here — before a single row was
  // even read — meant a Peoply/directory outage rejected this whole lane immediately, which then
  // failed the ENTIRE dashboard (all four lanes share one Promise.all in
  // dashboardPipelineProjectionCore.ts's loadDashboardPipelineProjectionPages), even though
  // applications/leads/creators and every non-scp conversation never depended on Peoply at all.
  // Resolved lazily instead — at most once, memoized across every batch this page reads — the
  // first time a batch actually contains an explicit-scp row. A lookup failure denies ONLY
  // explicit-scp rows for the rest of this read (canReadScpConversationRowForOrg's own fail-closed
  // shape: no confidently-resolved org/grant), never the lane or the dashboard. Super_admin never
  // calls Peoply here at all (resolveConversationMailAccessScope's own super_admin short-circuit),
  // so this failure path never applies to a super_admin caller.
  let conversationOrgScope: DashboardConversationOrgScope | null = null;
  const resolveLazyConversationOrgScope = lazyConversationMailAccessScope(
    conversationScopeAuth,
    (err) => console.warn("[dashboard-pipeline-projection] conversation_org_scope_lookup_failed", {
      source: request.source,
      message: err instanceof Error ? err.message : String(err),
    }),
  );
  const ensureConversationOrgScope = async (
    documents: readonly { row: Record<string, unknown> }[],
  ): Promise<void> => {
    if (request.source !== "conversations" || conversationOrgScope) return;
    if (!documents.some(({ row }) => isExplicitScpMailAccountRow(row))) return;
    conversationOrgScope = await resolveLazyConversationOrgScope();
  };

  const projectSnapshot = (snapshot: FirebaseFirestore.QuerySnapshot) => snapshot.docs.map((doc) => {
    const row = projectDashboardPipelineDocumentRow(request.source, doc.id, doc.data());
    return {
      id: doc.id,
      sortValue: typeof row[spec.orderField] === "string" ? row[spec.orderField] : "",
      row,
    };
  });

  return fillDashboardPipelineProjectionPageWithLegacy({
    source: request.source,
    limit: request.limit,
    ...(decodedCursor ? { cursor: decodedCursor } : {}),
    readUpdatedBatch: async (batchRequest) => {
      let query: Query = adminDb.collection(spec.collection)
        .where(spec.orderField, ">=", MIN_UPDATED_AT_ISO)
        .where(spec.orderField, "<=", MAX_UPDATED_AT_ISO)
        .orderBy(spec.orderField, "desc")
        .orderBy(FieldPath.documentId(), "asc")
        .select(...spec.fieldMask);
      if (batchRequest.afterDocId && batchRequest.afterSortValue) {
        query = query.startAfter(batchRequest.afterSortValue, batchRequest.afterDocId);
      }
      const snapshot = await query.limit(batchRequest.limit).get();
      const documents = projectSnapshot(snapshot);
      await ensureConversationOrgScope(documents);
      return documents;
    },
    readLegacyBatch: async (batchRequest) => {
      let query: Query = adminDb.collection(spec.collection)
        .orderBy(FieldPath.documentId(), "asc")
        .select(...spec.fieldMask);
      if (batchRequest.afterDocId) query = query.startAfter(batchRequest.afterDocId);
      const snapshot = await query.limit(batchRequest.limit).get();
      const documents = projectSnapshot(snapshot);
      await ensureConversationOrgScope(documents);
      return documents;
    },
    isUpdated: ({ row }) => hasUsableDashboardUpdatedAtIso(row[spec.orderField]),
    isLegacy: ({ row }) => !hasUsableDashboardUpdatedAtIso(row[spec.orderField]),
    isVisible: ({ row }) => visibleProjectionRow(spec.datasetKey, row, auth, spec.collection, spec.source, conversationOrgScope),
  });
}

export async function getDashboardPipelineProjection(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(
    request,
    "data.dashboardPipelineProjection.read",
    ["super_admin", "admin", "manager", "viewer"],
  );
  const data = asRecord(request.data);
  // Flu conversation org-filter round 4 (codex adversarial review round 2, finding #3): resolve
  // viewAs the same way functions/read.ts effectiveConversationAuth does — the original `auth`
  // (real caller) stays in every audit trail below; this derived identity feeds ONLY the
  // conversations lane's scp scope resolution inside readDashboardProjectionPage.
  const viewAsTarget = await resolveViewAsTarget(auth, data);
  const conversationScopeAuth: AuthContext = viewAsTarget
    ? { ...auth, role: viewAsTarget.role ?? "viewer", userId: viewAsTarget.uid, email: viewAsTarget.email }
    : auth;
  const projection = await loadDashboardPipelineProjectionPages({
    requestedLimit: data.limit,
    applicationCursor: asString(data.applicationCursor),
    leadCursor: asString(data.leadCursor),
    creatorCursor: asString(data.creatorCursor),
    conversationCursor: asString(data.conversationCursor),
    readPage: (pageRequest) => readDashboardProjectionPage(pageRequest, auth, conversationScopeAuth),
  });
  const generatedAtIso = new Date().toISOString();
  console.info(JSON.stringify({
    event: "dashboard.pipeline_projection.read",
    role: auth.role,
    durationMs: projection.performance.durationMs,
    queryCount: projection.performance.queryCount,
    perRowReads: projection.performance.perRowReads,
    documentReads: projection.performance.documentReads,
    documentReadUpperBound: projection.performance.documentReadUpperBound,
    returned: {
      applications: projection.applications.length,
      programSheetLeads: projection.programSheetLeads.length,
      creators: projection.creators.length,
      conversations: projection.conversations.length,
    },
    truncated: {
      applications: projection.pageInfo.applications.truncated,
      programSheetLeads: projection.pageInfo.programSheetLeads.truncated,
      creators: projection.pageInfo.creators.truncated,
      conversations: projection.pageInfo.conversations.truncated,
    },
  }));
  return {
    ok: true as const,
    generatedAtIso,
    ordering: "updated_at_iso_desc_document_id_asc" as const,
    orderingLanes: {
      updated: "updated_at_iso_desc_document_id_asc" as const,
      legacy: "missing_updated_at_iso_document_id_asc" as const,
      cursorVersion: 3 as const,
    },
    ...projection,
    behaviorLog: makeBehaviorLog(auth, "data.dashboardPipelineProjection.read", "success"),
  };
}
