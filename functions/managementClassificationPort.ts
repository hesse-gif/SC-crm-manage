// GAP-C (FLU-0538 completion): per-creator management-classification signal used to promote the
// management detail seven-tab clone to the DEFAULT view for MANAGED creators (no ?view=management gate —
// slop #1 fix). Read-only, manager+; strict bounded nested-identity fallback is shared with the
// application detail/lifecycle readers, and classification remains an in-memory policy decision.
//
// This is intentionally NARROW: only creators that actually have a non-revoked Management-owned
// (`qualified` or `managed`) scp_application_management record return managed=true. Legacy creators (no such record) return false and
// keep the legacy detail view unchanged, so the broad legacy /flu/influencers/{id} e2e suite is untouched.
import type { CallableRequest } from "firebase-functions/v2/https";
import { onCall } from "firebase-functions/v2/https";
import { adminDb } from "./firebaseAdmin";
import { toCallableResponse, toHttpsError } from "./callableErrorBoundary";
import {
  MANAGEMENT_CREATOR_IDENTITY_MATCH,
  ManagementReadModelError,
  assertCreatorIdentityMatch,
  assertRoleAtLeast,
  type CreatorIdentityScopedRecord,
  type ManagementCreatorIdentityMatchedBy,
  type ManagementRole,
} from "./managementProfileTabsReadModels";
import {
  SCP_APPLICATION_MANAGEMENT_COLLECTION,
  findApplicationManagementRecordsByIdentityFallback,
} from "./applicationManagementStore";

const LOOKUP_LIMIT = 5;

function resolveRole(request: CallableRequest<unknown>): ManagementRole | null {
  const token = request.auth?.token as Record<string, unknown> | undefined;
  const raw = token?.role;
  return raw === "manager" || raw === "admin" || raw === "super_admin" ? (raw as ManagementRole) : null;
}

export interface CreatorManagementClassificationScope {
  readonly programId: string;
  readonly campaignId?: string;
  readonly enrollmentId?: string;
}

export interface CreatorManagementClassificationResult {
  readonly ok: true;
  readonly managed: boolean;
  readonly recordCount: number;
  readonly scopes: readonly CreatorManagementClassificationScope[];
}

function readText(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function classificationIdentityRecord(
  applicationId: string,
  record: Record<string, unknown>,
  matchedBy?: ManagementCreatorIdentityMatchedBy,
): CreatorIdentityScopedRecord {
  const identity = record.identity && typeof record.identity === "object"
    ? record.identity as Record<string, unknown>
    : {};
  return {
    applicationId,
    fluCreatorId: readText(identity, "fluCreatorId") || readText(record, "fluCreatorId"),
    portalCreatorId: readText(identity, "portalCreatorId") || readText(record, "portalCreatorId") || undefined,
    channelId: readText(identity, "channelId") || readText(record, "channelId") || undefined,
    ...(matchedBy ? { [MANAGEMENT_CREATOR_IDENTITY_MATCH]: { matchedBy } } : {}),
  };
}

function managementScopeForRecord(record: Record<string, unknown>): CreatorManagementClassificationScope | null {
  const identity = record.identity && typeof record.identity === "object"
    ? record.identity as Record<string, unknown>
    : {};
  const programId = readText(identity, "programId") || readText(record, "currentProgramId") || readText(record, "programId");
  if (!programId) return null;
  const campaignId = readText(identity, "campaignId") || readText(record, "currentCampaignId") || readText(record, "campaignId");
  const enrollmentId = readText(identity, "enrollmentId") || readText(record, "enrollmentId");
  return { programId, ...(campaignId ? { campaignId } : {}), ...(enrollmentId ? { enrollmentId } : {}) };
}

export function createGetCreatorManagementClassificationHandler(
  config: { db?: FirebaseFirestore.Firestore } = {},
): (request: CallableRequest<unknown>) => Promise<CreatorManagementClassificationResult> {
  const db = config.db ?? adminDb;
  return async (request) => {
    try {
      assertRoleAtLeast(resolveRole(request), "manager");
      const data = (request.data ?? {}) as Record<string, unknown>;
      const fluCreatorId = typeof data.fluCreatorId === "string" ? data.fluCreatorId.trim() : "";
      if (!fluCreatorId) {
        throw new ManagementReadModelError("invalid-argument", "fluCreatorId is required", false);
      }
      // Canonical rows are resolved in strict identity.fluCreatorId → identity.portalCreatorId →
      // identity.channelId order. The flat-key query remains additive read compatibility for pre-v3
      // materializations; it never replaces or reorders the canonical fallback.
      const canonicalMatch = await findApplicationManagementRecordsByIdentityFallback(fluCreatorId, {
        db,
        limit: LOOKUP_LIMIT,
        includeApplicationId: false,
      });
      const legacySnap = await db
        .collection(SCP_APPLICATION_MANAGEMENT_COLLECTION)
        .where("fluCreatorId", "==", fluCreatorId)
        .limit(LOOKUP_LIMIT)
        .get();
      const candidates = new Map<string, {
        applicationId: string;
        data: Record<string, unknown>;
        matchedBy?: ManagementCreatorIdentityMatchedBy;
      }>();
      for (const record of canonicalMatch?.records ?? []) {
        candidates.set(record.applicationId, {
          applicationId: record.applicationId,
          data: record.data,
          matchedBy: canonicalMatch?.matchedBy,
        });
      }
      for (const doc of legacySnap.docs) {
        if (!candidates.has(doc.id)) {
          candidates.set(doc.id, {
            applicationId: doc.id,
            data: doc.data() as Record<string, unknown>,
          });
        }
      }
      const records = [...candidates.values()]
        .filter((candidate) => {
          try {
            assertCreatorIdentityMatch(
              fluCreatorId,
              classificationIdentityRecord(candidate.applicationId, candidate.data, candidate.matchedBy),
            );
            return true;
          } catch {
            return false;
          }
        })
        .map((candidate) => candidate.data);
      const managedRecords = records.filter((record) =>
        (record.classification === "qualified" || record.classification === "managed") && record.revoked !== true,
      );
      const scopes = Array.from(new Map(
        managedRecords
          .map(managementScopeForRecord)
          .filter((scope): scope is CreatorManagementClassificationScope => scope !== null)
          .map((scope) => [`${scope.programId}:${scope.campaignId ?? ""}:${scope.enrollmentId ?? ""}`, scope]),
      ).values());
      return toCallableResponse({ ok: true as const, managed: managedRecords.length > 0, recordCount: records.length, scopes });
    } catch (err) {
      throw toHttpsError(err);
    }
  };
}

export function createGetCreatorManagementClassificationCallable(config: { db?: FirebaseFirestore.Firestore } = {}) {
  return onCall(createGetCreatorManagementClassificationHandler(config));
}
