import { createHash } from "node:crypto";
import { Filter, FieldPath, FieldValue, type DocumentReference, type DocumentSnapshot, type QueryDocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { readSettings } from "./settings";
import { aiDramaCandidateCriteriaDefaults, aiDramaProgramTags, normalizeDiscoveryVertical } from "./discoveryVerticalPolicy";
import { asRecord, assertNonGuestAuth, makeBehaviorLog } from "./shared";
import type { AuthContext, CallableRequestShape } from "./shared";
import { sourceRef as makeSourceRef, writeKnowledgeNode } from "./knowledgeGraph";
import { CANONICAL_HESSE_CREATOR_ID, canonicalConversationDocumentId, canonicalCreatorId, canonicalThreadId, canonicalWorkflowContextKey } from "./creatorIdentity";
import { isOperationalFixtureRecord, isOperationalRecordVisible } from "./operationalFixtureProvenance";
import {
  assertQaProgramRetirementNotRevived,
  isQaProgramRetiredRecord,
} from "./qaProgramRetirement";
import { rowMatchesAccountScope, scopedOwnerFields } from "./readScope";
import {
  accountOwnershipStampForOwnedRecordAsync,
  accountOwnershipStampForScope,
  assertAccountOwnershipForRecordAsync,
  assertWritableAccountOwnershipScope,
  resolveAccountOwnershipScopeForRequest,
  resolveExplicitOwnershipAssignment,
} from "./accountOwnership";
import { assertViewAsReadOnlyPayload } from "./viewAsWriteGuard";
import { resolveCanonicalProgramId, SCP_CANONICAL_PROGRAM_ID } from "./programCanonical";
import {
  confirmedProgramScope,
  readConfirmedProgramAliasRegistryState,
  readConfirmedProgramAliasRegistryStateInTransaction,
} from "./programAliasRegistry";
import {
  identityConflictAutomationError,
  readScpIdentityConflictAutomationGate,
} from "./scpLifecycleProfiles";
import { countryTargetingFromLegacy } from "./youtubeCreatorCountries";

type ProgramStatus = "draft" | "open" | "closed";
type ProgramApplicationStatus = "pending" | "approved" | "rejected" | "hold";
type ProgramKpiMetric = "applicants" | "approved" | "contracted" | "reviewed" | "live";
type ProgramLink = { label: string; url: string };
type MailTemplateTone = "정중" | "간결" | "행사초대형";
type ProgramMailTemplate = { tone: MailTemplateTone; contentTags: string[] };

const VALID_PROGRAM_STATUSES = new Set<ProgramStatus>(["draft", "open", "closed"]);
const VALID_APPLICATION_STATUSES = new Set<ProgramApplicationStatus>(["pending", "approved", "rejected", "hold"]);
const VALID_KPI_METRICS = new Set<ProgramKpiMetric>(["applicants", "approved", "contracted", "reviewed", "live"]);
const VALID_MAIL_TEMPLATE_TONES = new Set<MailTemplateTone>(["정중", "간결", "행사초대형"]);
const DEFAULT_MAIL_TEMPLATE: ProgramMailTemplate = {
  tone: "정중",
  contentTags: ["프로그램명", "참여 혜택", "일정", "다음 액션"],
};
const PROGRAM_WORKFLOW_PAGE_SIZE = 250;
const PROGRAM_WORKFLOW_MAX_PAGE_SIZE = 500;
const PROGRAM_WORKFLOW_MAX_PAGES = 8;
const PROGRAM_APPLICATION_IDENTITY_LIMIT = 5;
const PROGRAM_APPLICATION_IP_LIMIT = 20;
const PROGRAM_APPLICATION_REVIEW_IDENTITY_VERSION = "program-application-review/v2";
const PROGRAM_APPLICATION_CONTRACT_IDENTITY_VERSION = "program-application-contract/v2";
const PROGRAM_WORKFLOW_IDENTITY_MIGRATION_VERSION = "program-application-workflow-migration/v1";
const PROGRAM_CONVERSATION_MEMBERSHIP_VERSION = "program-application-membership/v1";
const PROGRAM_CONVERSATION_MEMBERSHIP_LIMIT = 100;
const PROGRAM_CREATOR_ID_MAX_LENGTH = 140;

type ProgramApplicationRateLimitKind = "identity" | "ip";

type ProgramApplicationRateLimit = {
  readonly kind: ProgramApplicationRateLimitKind;
  readonly ref: DocumentReference;
  readonly key: string;
  readonly seed: string;
  readonly limit: number;
};

function cleanString(value: unknown, fallback: string, maxLength = 180): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, maxLength) : fallback;
}

function numberField(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
}

function booleanField(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function applicationStatus(value: unknown, fallback: ProgramApplicationStatus): ProgramApplicationStatus {
  return VALID_APPLICATION_STATUSES.has(value as ProgramApplicationStatus) ? value as ProgramApplicationStatus : fallback;
}

function programStatus(value: unknown, fallback: ProgramStatus): ProgramStatus {
  return VALID_PROGRAM_STATUSES.has(value as ProgramStatus) ? value as ProgramStatus : fallback;
}

function stringArrayField(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return fallback;
  const values = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 80));
  return values.length > 0 ? values.slice(0, 16) : fallback;
}

function safeProgramUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().slice(0, 500);
  if (!trimmed) return "";
  if (trimmed.startsWith("/")) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
  } catch {
    return "";
  }
  return "";
}

function linkField(value: unknown, fallback?: ProgramLink): ProgramLink | undefined {
  if (!value || typeof value !== "object") return fallback;
  const record = value as { label?: unknown; url?: unknown };
  const url = safeProgramUrl(record.url);
  if (!url) return fallback;
  return {
    label: cleanString(record.label, "링크", 80),
    url,
  };
}

function linkArrayField(value: unknown, fallback: ProgramLink[] = []): ProgramLink[] {
  if (!Array.isArray(value)) return fallback;
  const links = value.flatMap((item) => {
    const link = linkField(item);
    return link ? [link] : [];
  });
  return links.length > 0 ? links.slice(0, 12) : fallback;
}

function mailTemplateTone(value: unknown, fallback: MailTemplateTone): MailTemplateTone {
  return VALID_MAIL_TEMPLATE_TONES.has(value as MailTemplateTone) ? value as MailTemplateTone : fallback;
}

function mailTemplateField(value: unknown, fallback: ProgramMailTemplate): ProgramMailTemplate {
  if (!value || typeof value !== "object") return fallback;
  const record = value as { tone?: unknown; contentTags?: unknown };
  return {
    tone: mailTemplateTone(record.tone, fallback.tone),
    contentTags: stringArrayField(record.contentTags, fallback.contentTags),
  };
}

function programPolicyKeyIsPrivate(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === "uid"
    || normalized === "userid"
    || normalized === "createdby"
    || normalized === "updatedby"
    || normalized === "owner"
    || normalized === "owneruid"
    || normalized === "owneremail"
    || normalized === "ownername"
    || /(?:email|token|secret|credential|credentials|password|apikey|privatekey)$/.test(normalized);
}

function boundedProgramPolicyValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => boundedProgramPolicyValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string") return value.replace(/\s+/g, " ").trim().slice(0, 500);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "boolean" || value === null) return value;
    return null;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !programPolicyKeyIsPrivate(key))
      .slice(0, 100)
      .map(([key, child]) => [key.slice(0, 80), boundedProgramPolicyValue(child, depth + 1)]),
  );
}

function boundedProgramPolicyRecord(value: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  const bounded = boundedProgramPolicyValue(value);
  return bounded && typeof bounded === "object" && !Array.isArray(bounded)
    ? bounded as Record<string, unknown>
    : fallback;
}

function safeDocId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 140) || "item";
}

function programApplicationReviewId(applicationId: string): string {
  return `review-application-${applicationId}`;
}

function programApplicationContractId(applicationId: string): string {
  return `contract-application-${applicationId}`;
}

function programWorkflowIdentityError(message: string): Error {
  return Object.assign(new Error(`failed-precondition: ${message}`), { code: "failed-precondition", errorCode: "program_workflow_identity_error_unauthorized" });
}

function authoritativeProgramRecord(
  data: Record<string, unknown>,
  storageProgramId: string,
  expectedCanonicalProgramId: string,
  programAliasMap: Record<string, string>,
): Record<string, unknown> {
  const declaredIdentities: unknown[] = [storageProgramId];
  for (const field of ["id", "canonicalProgramId"] as const) {
    if (Object.prototype.hasOwnProperty.call(data, field)) declaredIdentities.push(data[field]);
  }
  const canonicalIdentities = declaredIdentities.map((value) => {
    if (typeof value !== "string"
      || value.length === 0
      || value.length > 140
      || value.trim() !== value
      || value.includes("/")) {
      throw programWorkflowIdentityError("authoritative program identity changed");
    }
    return resolveCanonicalProgramId(value, programAliasMap);
  });
  if (canonicalIdentities.some((value) => value !== expectedCanonicalProgramId)) {
    throw programWorkflowIdentityError("authoritative program identity changed");
  }
  return { ...data, id: expectedCanonicalProgramId };
}

function artifactHasExactProgramIdentity(
  artifact: Record<string, unknown>,
  expectedCanonicalProgramId: string,
): boolean {
  const declared = [artifact.programId, artifact.canonicalProgramId]
    .map((value) => cleanString(value, "", 180))
    .filter(Boolean);
  if (declared.length === 0) return false;
  const canonicalIds = [...new Set(declared.map((value) => resolveCanonicalProgramId(value)).filter(Boolean))];
  return canonicalIds.length === 1 && canonicalIds[0] === expectedCanonicalProgramId;
}

function assertProgramApplicationArtifactIdentity(
  artifact: Record<string, unknown>,
  expected: {
    kind: "review" | "contract";
    id: string;
    identityVersion: string;
    applicationId: string;
    applicationRef: string;
    programId: string;
    campaignId: string;
    creatorId: string;
  },
): void {
  const versionField = expected.kind === "review" ? "reviewIdentityVersion" : "contractIdentityVersion";
  const declaredId = cleanString(artifact.id, "", 500);
  if ((declaredId && declaredId !== expected.id)
    || cleanString(artifact[versionField], "", 120) !== expected.identityVersion
    || cleanString(artifact.applicationId, "", 180) !== expected.applicationId
    || cleanString(artifact.applicationRef, "", 500) !== expected.applicationRef
    || !artifactHasExactProgramIdentity(artifact, expected.programId)
    || exactCampaignIdentity(artifact) !== expected.campaignId
    || !hasExactCreatorIdentity(artifact.creatorId, expected.creatorId)
    || cleanString(artifact.source, "", 120) !== "program_application") {
    throw programWorkflowIdentityError(`legacy or ambiguous program ${expected.kind} identity cannot be attributed safely`);
  }
}

type ProgramWorkflowArtifactKind = "review" | "contract";

type ProgramWorkflowIdentityResolution = {
  reviewId: string;
  contractId: string;
  reviewRef: DocumentReference;
  contractRef: DocumentReference;
  review: Record<string, unknown> | null;
  contract: Record<string, unknown> | null;
  reviewExists: boolean;
  contractExists: boolean;
  reviewCreatedByMigration: boolean;
  contractCreatedByMigration: boolean;
  applicationPatch: Record<string, unknown>;
};

function legacyProgramWorkflowArtifactId(
  kind: ProgramWorkflowArtifactKind,
  canonicalProgramId: string,
  creatorId: string,
): string {
  return `${kind}-${canonicalProgramId}-${creatorId}`;
}

function programWorkflowMigrationEvidenceRef(
  applicationId: string,
  kind: ProgramWorkflowArtifactKind,
): DocumentReference {
  const identityHash = createHash("sha256")
    .update(`${applicationId}\0${kind}`)
    .digest("hex")
    .slice(0, 24);
  return adminDb.collection("program_workflow_identity_migrations").doc(
    safeDocId(`${applicationId.slice(0, 100)}-${kind}-${identityHash}`),
  );
}

function assertLegacyProgramApplicationArtifactIdentity(
  artifact: Record<string, unknown>,
  expected: {
    kind: ProgramWorkflowArtifactKind;
    id: string;
    applicationId: string;
    applicationRef: string;
    programId: string;
    campaignId: string;
    creatorId: string;
  },
): void {
  const versionField = expected.kind === "review" ? "reviewIdentityVersion" : "contractIdentityVersion";
  const declaredId = cleanString(artifact.id, "", 500);
  if ((declaredId && declaredId !== expected.id)
    || cleanString(artifact[versionField], "", 120)
    || cleanString(artifact.source, "", 120) !== "program_application"
    || cleanString(artifact.applicationId, "", 180) !== expected.applicationId
    || cleanString(artifact.applicationRef, "", 500) !== expected.applicationRef
    || !artifactHasExactProgramIdentity(artifact, expected.programId)
    || exactCampaignIdentity(artifact) !== expected.campaignId
    || !hasExactCreatorIdentity(artifact.creatorId, expected.creatorId)) {
    throw programWorkflowIdentityError(`legacy program ${expected.kind} identity cannot be attributed safely`);
  }
}

// Identity fields are proved independently by the strict source/application/
// program/campaign/creator assertions above. Only fields that necessarily
// change during identity migration, plus three volatile write timestamps, are
// excluded from the lossless payload hash. Stable audit timestamps such as
// signedAt, paidAt, reviewedAt, and createdAt remain in the hash.
const PROGRAM_ARTIFACT_PAYLOAD_HASH_EXCLUDED_FIELDS = new Set([
  "id",
  "source",
  "applicationId",
  "applicationRef",
  "programId",
  "canonicalProgramId",
  "campaignId",
  "creatorId",
  "reviewIdentityVersion",
  "contractIdentityVersion",
  "migratedFromRef",
  "migrationEvidenceRef",
  "workflowIdentityMigrationVersion",
  "identityMigratedAtIso",
  "workflowIdentityStatus",
  "supersededByRef",
  "supersededAtIso",
  "artifactActionable",
  "updatedAt",
  "updatedAtIso",
  "transitionedAt",
]);

function canonicalProgramArtifactValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { $number: "NaN" };
    if (value === Number.POSITIVE_INFINITY) return { $number: "Infinity" };
    if (value === Number.NEGATIVE_INFINITY) return { $number: "-Infinity" };
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Buffer.isBuffer(value)) return { $bytes: value.toString("base64") };
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(canonicalProgramArtifactValue);
  if (!value || typeof value !== "object") return String(value);

  const candidate = value as {
    constructor?: { name?: string };
    seconds?: unknown;
    nanoseconds?: unknown;
    latitude?: unknown;
    longitude?: unknown;
    path?: unknown;
  };
  if (candidate.constructor?.name === "Timestamp"
    && typeof candidate.seconds === "number"
    && typeof candidate.nanoseconds === "number") {
    return { $timestamp: [candidate.seconds, candidate.nanoseconds] };
  }
  if (candidate.constructor?.name === "GeoPoint"
    && typeof candidate.latitude === "number"
    && typeof candidate.longitude === "number") {
    return { $geoPoint: [candidate.latitude, candidate.longitude] };
  }
  if (candidate.constructor?.name === "DocumentReference" && typeof candidate.path === "string") {
    return { $documentReference: candidate.path };
  }

  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, canonicalProgramArtifactValue((value as Record<string, unknown>)[key])]),
  );
}

function programArtifactPreservedPayloadHash(record: Record<string, unknown>): string {
  const preservedPayload = Object.fromEntries(
    Object.keys(record)
      .filter((key) => !PROGRAM_ARTIFACT_PAYLOAD_HASH_EXCLUDED_FIELDS.has(key))
      .sort()
      .map((key) => [key, canonicalProgramArtifactValue(record[key])]),
  );
  return createHash("sha256").update(JSON.stringify(preservedPayload)).digest("hex");
}

function applyProgramArtifactCreatePatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  const deleteSentinel = FieldValue.delete();
  for (const [key, value] of Object.entries(patch)) {
    if (value instanceof FieldValue && value.isEqual(deleteSentinel)) delete target[key];
    else target[key] = value;
  }
}

/**
 * Resolve the application-owned review/contract identities inside the caller's
 * transaction. A legacy program+creator identity is migrated only when the
 * application link, artifact source/scope, and reverse reference query prove
 * that exactly one application owns it. The caller must perform every other
 * transaction read before invoking this helper because a successful migration
 * queues writes before returning.
 */
export async function resolveProgramApplicationWorkflowIdentityInTransaction(
  transaction: Transaction,
  input: {
    applicationRef: DocumentReference;
    application: Record<string, unknown>;
    canonicalProgramId: string;
    creatorId: string;
    nowIso: string;
    reviewPatchOnMigration?: Record<string, unknown>;
    contractPatchOnMigration?: Record<string, unknown>;
  },
): Promise<ProgramWorkflowIdentityResolution> {
  const applicationId = input.applicationRef.id;
  const applicationRefPath = input.applicationRef.path;
  const campaignId = cleanString(input.application.campaignId, "", 180);
  const expectedReviewId = programApplicationReviewId(applicationId);
  const expectedContractId = programApplicationContractId(applicationId);
  const reviewRef = adminDb.collection("reviews").doc(expectedReviewId);
  const contractRef = adminDb.collection("contracts").doc(expectedContractId);
  const declaredReviewId = cleanString(input.application.reviewId, "", 500);
  const declaredContractId = cleanString(input.application.contractId, "", 500);
  const declaredReviewVersion = cleanString(input.application.reviewIdentityVersion, "", 120);
  const declaredContractVersion = cleanString(input.application.contractIdentityVersion, "", 120);
  const expected = [
    {
      kind: "review" as const,
      collection: "reviews",
      expectedId: expectedReviewId,
      expectedVersion: PROGRAM_APPLICATION_REVIEW_IDENTITY_VERSION,
      declaredId: declaredReviewId,
      declaredVersion: declaredReviewVersion,
      targetRef: reviewRef,
    },
    {
      kind: "contract" as const,
      collection: "contracts",
      expectedId: expectedContractId,
      expectedVersion: PROGRAM_APPLICATION_CONTRACT_IDENTITY_VERSION,
      declaredId: declaredContractId,
      declaredVersion: declaredContractVersion,
      targetRef: contractRef,
    },
  ];

  const targetSnapshots = new Map<ProgramWorkflowArtifactKind, DocumentSnapshot>();
  const legacyCandidates: Array<{
    descriptor: typeof expected[number];
    legacyRef: DocumentReference;
    legacySnapshot: DocumentSnapshot;
  }> = [];

  for (const descriptor of expected) {
    const targetSnapshot = await transaction.get(descriptor.targetRef);
    targetSnapshots.set(descriptor.kind, targetSnapshot);
    if (!descriptor.declaredId || descriptor.declaredId === descriptor.expectedId) {
      if (descriptor.declaredId === descriptor.expectedId
        && descriptor.declaredVersion !== descriptor.expectedVersion) {
        throw programWorkflowIdentityError(`program ${descriptor.kind} identity version is missing or invalid`);
      }
      if (targetSnapshot.exists) {
        assertProgramApplicationArtifactIdentity(targetSnapshot.data() ?? {}, {
          kind: descriptor.kind,
          id: descriptor.expectedId,
          identityVersion: descriptor.expectedVersion,
          applicationId,
          applicationRef: applicationRefPath,
          programId: input.canonicalProgramId,
          campaignId,
          creatorId: input.creatorId,
        });
      }
      continue;
    }

    if (descriptor.declaredId.includes("/")
      || descriptor.declaredVersion
      || descriptor.declaredId !== legacyProgramWorkflowArtifactId(
        descriptor.kind,
        input.canonicalProgramId,
        input.creatorId,
      )) {
      throw programWorkflowIdentityError(`legacy or ambiguous application ${descriptor.kind} link cannot be migrated`);
    }
    const legacyRef = adminDb.collection(descriptor.collection).doc(descriptor.declaredId);
    const [legacySnapshot, reverseSnapshot] = await Promise.all([
      transaction.get(legacyRef),
      transaction.get(
        adminDb.collection("program_applications")
          .where(`${descriptor.kind}Id`, "==", descriptor.declaredId)
          .limit(2),
      ),
    ]);
    if (!legacySnapshot.exists
      || reverseSnapshot.size !== 1
      || reverseSnapshot.docs[0]?.id !== applicationId) {
      throw programWorkflowIdentityError(`legacy program ${descriptor.kind} ownership is missing or ambiguous`);
    }
    const legacy = legacySnapshot.data() ?? {};
    assertLegacyProgramApplicationArtifactIdentity(legacy, {
      kind: descriptor.kind,
      id: descriptor.declaredId,
      applicationId,
      applicationRef: applicationRefPath,
      programId: input.canonicalProgramId,
      campaignId,
      creatorId: input.creatorId,
    });
    if (targetSnapshot.exists) {
      const target = targetSnapshot.data() ?? {};
      assertProgramApplicationArtifactIdentity(target, {
        kind: descriptor.kind,
        id: descriptor.expectedId,
        identityVersion: descriptor.expectedVersion,
        applicationId,
        applicationRef: applicationRefPath,
        programId: input.canonicalProgramId,
        campaignId,
        creatorId: input.creatorId,
      });
      if (cleanString(target.migratedFromRef, "", 500) !== legacyRef.path
        || programArtifactPreservedPayloadHash(target) !== programArtifactPreservedPayloadHash(legacy)) {
        throw programWorkflowIdentityError(`program ${descriptor.kind} v2 target collides with legacy state`);
      }
    }
    legacyCandidates.push({ descriptor, legacyRef, legacySnapshot });
  }

  const applicationPatch: Record<string, unknown> = {
    reviewId: expectedReviewId,
    reviewIdentityVersion: PROGRAM_APPLICATION_REVIEW_IDENTITY_VERSION,
    contractId: expectedContractId,
    contractIdentityVersion: PROGRAM_APPLICATION_CONTRACT_IDENTITY_VERSION,
  };
  const migratedKinds: ProgramWorkflowArtifactKind[] = [];
  const migratedData = new Map<ProgramWorkflowArtifactKind, Record<string, unknown>>();
  for (const candidate of legacyCandidates) {
    const { descriptor, legacyRef, legacySnapshot } = candidate;
    const legacy = legacySnapshot.data() ?? {};
    const evidenceRef = programWorkflowMigrationEvidenceRef(applicationId, descriptor.kind);
    const targetSnapshot = targetSnapshots.get(descriptor.kind);
    const targetData: Record<string, unknown> = {
      ...legacy,
      id: descriptor.expectedId,
      ...(descriptor.kind === "review"
        ? { reviewIdentityVersion: descriptor.expectedVersion }
        : { contractIdentityVersion: descriptor.expectedVersion }),
      applicationId,
      applicationRef: applicationRefPath,
      programId: input.canonicalProgramId,
      canonicalProgramId: input.canonicalProgramId,
      campaignId,
      source: "program_application",
      migratedFromRef: legacyRef.path,
      workflowIdentityMigrationVersion: PROGRAM_WORKFLOW_IDENTITY_MIGRATION_VERSION,
      migrationEvidenceRef: evidenceRef.path,
      identityMigratedAtIso: input.nowIso,
    };
    applyProgramArtifactCreatePatch(
      targetData,
      descriptor.kind === "review"
        ? (input.reviewPatchOnMigration ?? {})
        : (input.contractPatchOnMigration ?? {}),
    );
    if (!targetSnapshot?.exists) transaction.create(descriptor.targetRef, targetData);
    const supersededPatch: Record<string, unknown> = {
      workflowIdentityStatus: "superseded",
      artifactActionable: false,
      supersededByRef: descriptor.targetRef.path,
      migrationEvidenceRef: evidenceRef.path,
      workflowIdentityMigrationVersion: PROGRAM_WORKFLOW_IDENTITY_MIGRATION_VERSION,
      supersededAtIso: input.nowIso,
      updatedAtIso: input.nowIso,
      ...(descriptor.kind === "review"
        ? { reviewActionable: false, reviewLifecycleStatus: "superseded" }
        : { contractActionable: false, contractLifecycleStatus: "superseded" }),
    };
    transaction.set(legacyRef, supersededPatch, { merge: true });
    transaction.set(evidenceRef, {
      id: evidenceRef.id,
      type: "human_migration_evidence",
      status: "migrated",
      requiresHumanReview: false,
      reasonCode: "single_application_legacy_identity_proven",
      artifactKind: descriptor.kind,
      applicationId,
      applicationRef: applicationRefPath,
      sourceRef: legacyRef.path,
      targetRef: descriptor.targetRef.path,
      canonicalProgramId: input.canonicalProgramId,
      creatorId: input.creatorId,
      migrationVersion: PROGRAM_WORKFLOW_IDENTITY_MIGRATION_VERSION,
      createdAtIso: input.nowIso,
      updatedAtIso: input.nowIso,
    }, { merge: true });
    applicationPatch[`${descriptor.kind}MigrationEvidenceRef`] = evidenceRef.path;
    migratedKinds.push(descriptor.kind);
    migratedData.set(
      descriptor.kind,
      targetSnapshot?.exists ? (targetSnapshot.data() ?? {}) : targetData,
    );
  }
  if (migratedKinds.length > 0) {
    applicationPatch.workflowIdentityMigrationVersion = PROGRAM_WORKFLOW_IDENTITY_MIGRATION_VERSION;
    applicationPatch.workflowIdentityMigratedAtIso = input.nowIso;
    applicationPatch.workflowIdentityMigratedKinds = migratedKinds.sort();
  }

  const reviewSnapshot = targetSnapshots.get("review");
  const contractSnapshot = targetSnapshots.get("contract");
  return {
    reviewId: expectedReviewId,
    contractId: expectedContractId,
    reviewRef,
    contractRef,
    review: migratedData.get("review") ?? (reviewSnapshot?.exists ? (reviewSnapshot.data() ?? {}) : null),
    contract: migratedData.get("contract") ?? (contractSnapshot?.exists ? (contractSnapshot.data() ?? {}) : null),
    reviewExists: Boolean(reviewSnapshot?.exists || migratedData.has("review")),
    contractExists: Boolean(contractSnapshot?.exists || migratedData.has("contract")),
    reviewCreatedByMigration: migratedData.has("review") && !reviewSnapshot?.exists,
    contractCreatedByMigration: migratedData.has("contract") && !contractSnapshot?.exists,
    applicationPatch,
  };
}

type ProgramConversationMembership = {
  applicationRefs: string[];
  activeApplicationRefs: string[];
  projection: Record<string, unknown>;
};

function exactCampaignIdentity(record: Record<string, unknown>): string | null {
  const rawCampaignId = record.campaignId;
  const campaignId = rawCampaignId === undefined || rawCampaignId === null || rawCampaignId === ""
    ? ""
    : typeof rawCampaignId === "string" && rawCampaignId.trim() === rawCampaignId && rawCampaignId.length <= 180
      ? rawCampaignId
      : null;
  if (campaignId === null) return null;
  const rawCampaignRef = record.campaignRef;
  if (rawCampaignRef === undefined || rawCampaignRef === null || rawCampaignRef === "") return campaignId;
  if (typeof rawCampaignRef !== "string" || !campaignId || rawCampaignRef !== `campaigns/${campaignId}`) return null;
  return campaignId;
}

function hasExactCreatorIdentity(value: unknown, expectedCreatorId: string): boolean {
  return typeof value === "string"
    && value.length > 0
    && value.length <= PROGRAM_CREATOR_ID_MAX_LENGTH
    && value.trim() === value
    && value === expectedCreatorId;
}

function assertOptionalApplicationCreatorIdentity(application: Record<string, unknown>): void {
  if (!Object.prototype.hasOwnProperty.call(application, "creatorId")) return;
  const creatorId = application.creatorId;
  if (typeof creatorId !== "string"
    || creatorId.length === 0
    || creatorId.length > PROGRAM_CREATOR_ID_MAX_LENGTH
    || creatorId.trim() !== creatorId
    || canonicalCreatorId({ creatorId }) !== creatorId
    || creatorId === "."
    || creatorId === ".."
    || creatorId.includes("/")
    || /^__.*__$/.test(creatorId)
    || Buffer.byteLength(creatorId, "utf8") > 1_500) {
    throw programWorkflowIdentityError("application creator identity is contaminated or ambiguous");
  }
}

function exactCanonicalProgramIdentities(
  record: Record<string, unknown>,
  programAliasMap: Record<string, string>,
): string[] {
  return [...new Set(
    [record.canonicalProgramId, record.programId]
      .map((value) => resolveCanonicalProgramId(value, programAliasMap))
      .filter(Boolean),
  )];
}

async function programConversationMembershipInTransaction(
  transaction: Transaction,
  input: {
    conversationId: string;
    currentApplicationId: string;
    currentApplication: Record<string, unknown>;
    currentStatus: ProgramApplicationStatus;
    canonicalProgramId: string;
    campaignId: string;
    creatorId: string;
    conversation: Record<string, unknown> | null;
    programAliasMap: Record<string, string>;
  },
): Promise<ProgramConversationMembership> {
  if (input.conversation) {
    const conversationProgramIds = exactCanonicalProgramIdentities(input.conversation, input.programAliasMap);
    const conversationCampaignId = exactCampaignIdentity(input.conversation);
    if (conversationProgramIds.length !== 1
      || conversationProgramIds[0] !== input.canonicalProgramId
      || conversationCampaignId !== input.campaignId
      || !hasExactCreatorIdentity(input.conversation.creatorId, input.creatorId)) {
      throw programWorkflowIdentityError("program conversation identity is contaminated or ambiguous");
    }
  }
  const snapshot = await transaction.get(
    adminDb.collection("program_applications")
      .where("conversationId", "==", input.conversationId)
      .limit(PROGRAM_CONVERSATION_MEMBERSHIP_LIMIT + 1),
  );
  const byId = new Map<string, Record<string, unknown>>(
    snapshot.docs.map((doc) => [doc.id, { id: doc.id, ...(doc.data() ?? {}) }]),
  );
  const current = byId.get(input.currentApplicationId) ?? {};
  const mergedCurrent = { ...input.currentApplication, ...current };
  byId.set(input.currentApplicationId, {
    ...mergedCurrent,
    id: input.currentApplicationId,
    conversationId: input.conversationId,
    creatorId: Object.prototype.hasOwnProperty.call(mergedCurrent, "creatorId")
      ? mergedCurrent.creatorId
      : input.creatorId,
    status: input.currentStatus,
  });
  if (byId.size > PROGRAM_CONVERSATION_MEMBERSHIP_LIMIT) {
    throw programWorkflowIdentityError("program conversation application membership exceeds the bounded limit");
  }
  for (const application of byId.values()) {
    const declaredConversationId = cleanString(application.conversationId, input.conversationId, 500);
    const canonicalIds = exactCanonicalProgramIdentities(application, input.programAliasMap);
    const campaignId = exactCampaignIdentity(application);
    if (declaredConversationId !== input.conversationId
      || !hasExactCreatorIdentity(application.creatorId, input.creatorId)
      || canonicalIds.length !== 1
      || canonicalIds[0] !== input.canonicalProgramId
      || campaignId !== input.campaignId) {
      throw programWorkflowIdentityError("program conversation application membership is contaminated or ambiguous");
    }
  }
  const applicationRefs = [...byId.keys()].sort().map((id) => `program_applications/${id}`);
  const activeApplicationRefs = [...byId.entries()]
    .filter(([, application]) => applicationStatus(application.status, "pending") === "approved")
    .map(([id]) => `program_applications/${id}`)
    .sort();
  const primaryRef = activeApplicationRefs[0] ?? `program_applications/${input.currentApplicationId}`;
  const primaryId = primaryRef.split("/").at(-1) ?? input.currentApplicationId;
  const active = activeApplicationRefs.length > 0;
  return {
    applicationRefs,
    activeApplicationRefs,
    projection: {
      programApplicationMembershipVersion: PROGRAM_CONVERSATION_MEMBERSHIP_VERSION,
      programApplicationRefs: applicationRefs,
      activeProgramApplicationRefs: activeApplicationRefs,
      activeProgramApplicationCount: activeApplicationRefs.length,
      applicationId: primaryId,
      applicationRef: primaryRef,
      participationActive: active,
      participationStatus: active ? "active" : "retracted",
      participationStage: active ? "contract" : "contact",
    },
  };
}

function slugify(value: string): string {
  return safeDocId(value.toLowerCase().replace(/[^a-z0-9가-힣]+/gi, "-").replace(/^-+|-+$/g, "")).toLowerCase() || "program";
}

function isSoftHiddenProgram(record: Record<string, unknown>): boolean {
  return Boolean(
    record.deletedAt
    || record.archivedAt
    || record.deletedAtIso
    || record.archivedAtIso
    || isQaProgramRetiredRecord(record),
  );
}

async function existingProgramIdForSlug(slug: string, auth?: AuthContext): Promise<string | null> {
  const snapshot = await adminDb.collection("programs").where("slug", "==", slug).limit(50).get();
  if (snapshot.empty) return null;
  const scopedDocs = snapshot.docs.filter((doc) => {
    const row = { id: doc.id, ...(doc.data() ?? {}) };
    return rowMatchesAccountScope("programs", row, auth);
  });
  const visible = scopedDocs.find((doc) => {
    const row = { id: doc.id, ...(doc.data() ?? {}) };
    return !isSoftHiddenProgram(row);
  });
  return (visible ?? scopedDocs[0])?.id ?? null;
}

async function slugExistsForAnotherAccount(slug: string, auth: AuthContext): Promise<boolean> {
  if (auth.role !== "manager") return false;
  const snapshot = await adminDb.collection("programs").where("slug", "==", slug).limit(50).get();
  return snapshot.docs.some((doc) => {
    const row = { id: doc.id, ...(doc.data() ?? {}) };
    return !isSoftHiddenProgram(row) && !rowMatchesAccountScope("programs", row, auth);
  });
}

async function uniqueProgramSlugForAccount(baseSlug: string, auth: AuthContext): Promise<string> {
  if (!(await slugExistsForAnotherAccount(baseSlug, auth))) return baseSlug;
  const suffix = safeDocId(auth.userId).slice(0, 12) || Date.now().toString(36);
  for (let index = 1; index <= 20; index += 1) {
    const candidate = safeDocId(index === 1 ? `${baseSlug}-${suffix}` : `${baseSlug}-${suffix}-${index}`).toLowerCase();
    if (!(await slugExistsForAnotherAccount(candidate, auth)) && !(await existingProgramIdForSlug(candidate, auth))) return candidate;
  }
  return safeDocId(`${baseSlug}-${suffix}-${Date.now().toString(36)}`).toLowerCase();
}

/**
 * F5(b): 생성 폼 경로 전용 — 제목에서 유도한 slug 가 **누구의 것이든** 이미 있으면 재사용하지 않고
 * 새 문서를 만든다. `uniqueProgramSlugForAccount` 는 같은 계정 충돌을 의도적으로 재사용하므로
 * (명시 slug 재사용·soft-delete 복구 계약), 폼 경로에는 쓸 수 없다.
 */
async function freshProgramSlugForAccount(baseSlug: string, auth: AuthContext): Promise<string> {
  const taken = async (candidate: string): Promise<boolean> => {
    if (await existingProgramIdForSlug(candidate, auth)) return true;
    if (await slugExistsForAnotherAccount(candidate, auth)) return true;
    return (await adminDb.collection("programs").doc(`pg-${candidate}`).get()).exists;
  };
  if (!(await taken(baseSlug))) return baseSlug;
  for (let index = 2; index <= 20; index += 1) {
    const candidate = safeDocId(`${baseSlug}-${index}`).toLowerCase();
    if (!(await taken(candidate))) return candidate;
  }
  const suffix = safeDocId(auth.userId).slice(0, 12) || "op";
  return safeDocId(`${baseSlug}-${suffix}-${Date.now().toString(36)}`).toLowerCase();
}

async function uniqueProgramIdForAccount(baseId: string, auth: AuthContext): Promise<string> {
  const snapshot = await adminDb.collection("programs").doc(baseId).get();
  if (!snapshot.exists) return baseId;
  if (rowMatchesAccountScope("programs", { id: snapshot.id, ...(snapshot.data() ?? {}) }, auth)) return baseId;

  const suffix = safeDocId(auth.userId).slice(0, 12) || Date.now().toString(36);
  for (let index = 1; index <= 20; index += 1) {
    const candidate = index === 1 ? `${baseId}-${suffix}` : `${baseId}-${suffix}-${index}`;
    const candidateSnapshot = await adminDb.collection("programs").doc(candidate).get();
    if (!candidateSnapshot.exists) return candidate;
    if (rowMatchesAccountScope("programs", { id: candidateSnapshot.id, ...(candidateSnapshot.data() ?? {}) }, auth)) return candidate;
  }
  return `${baseId}-${suffix}-${Date.now().toString(36)}`;
}

function applicationDocId(programId: string, seed: string): string {
  return safeDocId(`${programId}-${seed.toLowerCase()}`);
}

function resolveProgramApplicationCreatorId(application: Record<string, unknown>, email: string, handle: string, name: string, fallback: string): string {
  return canonicalCreatorId({
    creatorId: cleanString(application.creatorId, "", 140),
    email,
    handle,
    name,
    youtubeUrl: cleanString(application.youtubeUrl, "", 300),
  }) || fallback;
}

function boundedWorkflowPageSize(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(Math.trunc(value), PROGRAM_WORKFLOW_MAX_PAGE_SIZE))
    : PROGRAM_WORKFLOW_PAGE_SIZE;
}

function boundedWorkflowPages(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(Math.trunc(value), PROGRAM_WORKFLOW_MAX_PAGES))
    : PROGRAM_WORKFLOW_MAX_PAGES;
}

function encodeWorkflowCursor(docId: string): string {
  return Buffer.from(JSON.stringify({ docId }), "utf8").toString("base64url");
}

function decodeWorkflowCursor(value: unknown): string {
  const raw = cleanString(value, "", 240);
  if (!raw) return "";
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    const record = asRecord(parsed);
    return cleanString(record.docId, "", 160);
  } catch {
    return "";
  }
}

function publicAuthContext(request?: CallableRequestShape): AuthContext {
  return {
    userId: "public-apply",
    role: "viewer",
    team: "public",
    ip: request?.rawRequest?.ip ?? "0.0.0.0",
    gameId: "flu-program",
  };
}

function isEmulatorRuntime(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true" || Boolean(process.env.FIRESTORE_EMULATOR_HOST);
}

function assertPublicAppCheck(request: CallableRequestShape) {
  if (isEmulatorRuntime()) return;
  if (request.app?.appId) return;
  const error = new Error("failed-precondition: App Check required for public program callables");
  Object.assign(error, { code: "failed-precondition", errorCode: "assert_public_app_check_app_check_required_public_program", behaviorLog: makeBehaviorLog(publicAuthContext(request), "program.apply.appCheck", "denied", "flu-program") });
  throw error;
}

function programApplicationRateLimits(
  request: CallableRequestShape,
  programId: string,
  identitySeed: string,
  nowIso: string,
) {
  const auth = publicAuthContext(request);
  const bucket = nowIso.slice(0, 13);
  const identityKey = safeDocId(`${programId}-identity-${identitySeed || "anonymous"}-${bucket}`);
  const ipKey = safeDocId(`${programId}-ip-${auth.ip}-${bucket}`);
  const collection = adminDb.collection("program_application_rate_limits");
  return {
    auth,
    bucket,
    entries: [
      { kind: "identity", ref: collection.doc(identityKey), key: identityKey, seed: identitySeed || "anonymous", limit: PROGRAM_APPLICATION_IDENTITY_LIMIT },
      { kind: "ip", ref: collection.doc(ipKey), key: ipKey, seed: auth.ip, limit: PROGRAM_APPLICATION_IP_LIMIT },
    ] satisfies readonly ProgramApplicationRateLimit[],
  };
}

async function enforceProgramApplicationRateLimit(
  transaction: Transaction,
  auth: AuthContext,
  programId: string,
  bucket: string,
  entries: readonly ProgramApplicationRateLimit[],
  nowIso: string,
): Promise<Record<ProgramApplicationRateLimitKind, string>> {
  const paths = { identity: "", ip: "" };
  const snapshots = [];
  for (const entry of entries) {
    snapshots.push({ entry, snapshot: await transaction.get(entry.ref) });
  }
  for (const { entry, snapshot } of snapshots) {
    const currentData = snapshot.data() ?? {};
    const current = typeof currentData.count === "number" ? currentData.count : 0;
    if (current >= entry.limit) {
      const error = new Error("resource-exhausted: program application rate limit");
      Object.assign(error, { code: "resource-exhausted", errorCode: "enforce_program_application_rate_limit_resource_exhausted_program", behaviorLog: makeBehaviorLog(auth, "program.apply.rateLimit", "denied", "flu-program") });
      throw error;
    }
  }
  for (const { entry, snapshot } of snapshots) {
    const currentData = snapshot.data() ?? {};
    transaction.set(entry.ref, {
      id: entry.key,
      programId,
      kind: entry.kind,
      ...(entry.kind === "identity" ? { identitySeed: entry.seed } : { ip: entry.seed }),
      bucket,
      limit: entry.limit,
      count: FieldValue.increment(1),
      updatedAtIso: nowIso,
      createdAtIso: snapshot.exists ? currentData.createdAtIso ?? nowIso : nowIso,
    }, { merge: true });
    paths[entry.kind] = entry.ref.path;
  }
  return paths;
}

type LoadedProgram = {
  id: string;
  data: Record<string, unknown>;
  identityProgramIds: string[];
  aliasRegistryRevision: string;
};

function visibleProgramSnapshot(snapshot: DocumentSnapshot): boolean {
  if (!snapshot.exists) return false;
  const data = snapshot.data() ?? {};
  return !isSoftHiddenProgram(data)
    && isOperationalRecordVisible({ ...data, id: snapshot.id }, "programs", isEmulatorRuntime());
}

async function loadProgram(programId: string, slug: string): Promise<LoadedProgram | null> {
  const aliasRegistry = await readConfirmedProgramAliasRegistryState({ bypassCache: true });
  const loadConfirmedScope = async (rawProgramId: string): Promise<LoadedProgram | null> => {
    const scope = confirmedProgramScope(rawProgramId, aliasRegistry);
    const snapshots = await adminDb.getAll(...scope.identityProgramIds.map((id) => adminDb.collection("programs").doc(id)));
    const canonicalSnapshot = snapshots.find((item) => item.id === scope.canonicalProgramId && visibleProgramSnapshot(item));
    if (!canonicalSnapshot) return null;
    const data = canonicalSnapshot.data() ?? {};
    const declaredCanonical = resolveCanonicalProgramId(data.canonicalProgramId, aliasRegistry.aliasMap);
    if (declaredCanonical && declaredCanonical !== scope.canonicalProgramId) return null;
    return {
      id: scope.canonicalProgramId,
      data,
      identityProgramIds: scope.identityProgramIds,
      aliasRegistryRevision: scope.aliasRegistryRevision,
    };
  };
  if (programId) return loadConfirmedScope(programId);
  if (slug) {
    const snapshot = await adminDb.collection("programs").where("slug", "==", slug).limit(51).get();
    if (snapshot.size > 50) throw Object.assign(new Error("failed-precondition: program slug lookup exceeds bounded contract"), { code: "failed-precondition", errorCode: "load_program_program_slug_lookup_exceeds_bounded" });
    const canonicalIds = [...new Set(snapshot.docs
      .filter(visibleProgramSnapshot)
      .map((item) => resolveCanonicalProgramId(item.id, aliasRegistry.aliasMap))
      .filter(Boolean))];
    if (canonicalIds.length > 1) {
      throw Object.assign(new Error("failed-precondition: program slug is ambiguous across canonical programs"), { code: "failed-precondition", errorCode: "load_program_program_slug_ambiguous_across_canonical" });
    }
    const requestedProgramId = canonicalIds[0] ?? "";
    if (requestedProgramId) return loadConfirmedScope(requestedProgramId);
  }
  return null;
}

// Exported so the SCP bridge (functions/scpProgramBridge.ts) can reuse the exact
// same approved-application → identity plus program-scoped participation fan-out
// as the live program review flow.
export type ApprovedWorkflowAuthorization = (context: {
  transaction: Transaction;
  applicationRef: DocumentReference;
  applicationSnapshot: DocumentSnapshot;
  application: Record<string, unknown>;
  canonicalProgramId: string;
  programAliasMap: Record<string, string>;
  programRef: DocumentReference;
  program: Record<string, unknown>;
}) => Promise<void>;

export type ApprovedWorkflowCompletion = (context: {
  transaction: Transaction;
  applicationRef: DocumentReference;
  application: Record<string, unknown>;
  sourceApplication: Record<string, unknown>;
  workflow: { creatorId: string; conversationId: string; contractId: string; reviewId: string };
  canonicalProgramId: string;
  programRef: DocumentReference;
  program: Record<string, unknown>;
  nowIso: string;
}) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

export async function ensureApprovedWorkflow(
  applicationInput: Record<string, unknown>,
  program: Record<string, unknown>,
  auth: AuthContext,
  options: {
    authorize?: ApprovedWorkflowAuthorization;
    complete?: ApprovedWorkflowCompletion;
    approvalTransitionFrom?: ProgramApplicationStatus;
    humanDecision?: boolean;
  } = {},
) {
  const nowIso = new Date().toISOString();
  const appId = cleanString(applicationInput.id, "application", 140);
  const applicationRef = adminDb.collection("program_applications").doc(appId);
  const settings = await readSettings();
  return adminDb.runTransaction(async (transaction) => {
    const applicationSnapshot = await transaction.get(applicationRef);
    const currentApplicationStatus = applicationStatus(applicationSnapshot.data()?.status, "pending");
    const mayTransitionToApproved = options.approvalTransitionFrom !== undefined
      && currentApplicationStatus === options.approvalTransitionFrom;
    if (!applicationSnapshot.exists || (currentApplicationStatus !== "approved" && !mayTransitionToApproved)) {
      const error = new Error("failed-precondition: application is no longer approved");
      Object.assign(error, { code: "failed-precondition", errorCode: "ensure_approved_workflow_application_longer_approved" });
      throw error;
    }
    const application: Record<string, unknown> = { ...applicationInput, id: appId, ...(applicationSnapshot.data() ?? {}) };
    const aliasRegistry = await readConfirmedProgramAliasRegistryStateInTransaction(transaction);
    const applicationProgramIds = [application.canonicalProgramId, application.programId]
      .map((value) => resolveCanonicalProgramId(value, aliasRegistry.aliasMap))
      .filter(Boolean);
    const canonicalApplicationProgramIds = [...new Set(applicationProgramIds)];
    const canonicalProgramId = resolveCanonicalProgramId(program.id, aliasRegistry.aliasMap);
    if (!canonicalProgramId || canonicalApplicationProgramIds.length !== 1 || canonicalApplicationProgramIds[0] !== canonicalProgramId) {
      throw Object.assign(new Error("failed-precondition: approved application program scope changed"), { code: "failed-precondition", errorCode: "ensure_approved_workflow_approved_application_program_scope_changed" });
    }
    let authoritativeProgramRef = adminDb.collection("programs").doc(canonicalProgramId);
    let authoritativeProgramSnapshot = await transaction.get(authoritativeProgramRef);
    if (!authoritativeProgramSnapshot.exists && canonicalProgramId === SCP_CANONICAL_PROGRAM_ID) {
      const legacyProgramRef = adminDb.collection("programs").doc("scp");
      const legacyProgramSnapshot = await transaction.get(legacyProgramRef);
      if (legacyProgramSnapshot.exists) {
        authoritativeProgramRef = legacyProgramRef;
        authoritativeProgramSnapshot = legacyProgramSnapshot;
      }
    }
    if (!authoritativeProgramSnapshot.exists) {
      throw programWorkflowIdentityError("authoritative program identity changed");
    }
    const authoritativeProgram = authoritativeProgramRecord(
      authoritativeProgramSnapshot.data() ?? {},
      authoritativeProgramSnapshot.id,
      canonicalProgramId,
      aliasRegistry.aliasMap,
    );
    if (!rowMatchesAccountScope("programs", authoritativeProgram, auth)) {
      const error = new Error("permission-denied: program belongs to another account");
      Object.assign(error, {
        code: "permission-denied", errorCode: "ensure_approved_workflow_program_belongs_another_account",
        behaviorLog: makeBehaviorLog(auth, "program.workflow.sync", "denied", auth.gameId),
      });
      throw error;
    }
    if (options.authorize) {
      await options.authorize({
        transaction,
        applicationRef,
        applicationSnapshot,
        application,
        canonicalProgramId,
        programAliasMap: aliasRegistry.aliasMap,
        programRef: authoritativeProgramRef,
        program: authoritativeProgram,
      });
    }
    if (!options.humanDecision) {
      const identityConflictGate = await readScpIdentityConflictAutomationGate({
        programId: canonicalProgramId,
        aliases: [
          { kind: "leadId", value: application.leadId },
          { kind: "leadId", value: cleanString(application.leadRef, "", 500).split("/").at(-1) },
          { kind: "creatorId", value: application.creatorId },
          { kind: "channelId", value: application.channelId },
          { kind: "channelId", value: application.youtubeChannelId },
          { kind: "email", value: application.email },
          { kind: "conversationId", value: application.conversationId },
        ],
      }, transaction);
      if (identityConflictGate) throw identityConflictAutomationError(identityConflictGate);
    }
    assertOptionalApplicationCreatorIdentity(application);
  const programId = canonicalProgramId;
  const title = cleanString(authoritativeProgram.title, "프로그램", 120);
  const campaignId = cleanString(application.campaignId, "", 140);
  const campaignTitle = cleanString(application.campaignTitle, "", 120);
  const name = cleanString(application.name, cleanString(application.handle, "프로그램 신청자", 120), 120);
  const handle = cleanString(application.handle, `@${safeDocId(name).toLowerCase()}`, 120);
  const email = cleanString(application.email, "", 180).toLowerCase();
  const platform = cleanString(application.platform, "YouTube", 40);
  const region = cleanString(application.region, "KR", 40);
  const category = cleanString(application.category, cleanString(authoritativeProgram.gameTitle, "Program", 120), 160);
  const followers = numberField(application.followers, 0);
  const programOwnerUid = cleanString(authoritativeProgram.ownerUid ?? authoritativeProgram.createdBy ?? application.programOwnerUid, "", 160);
  const programOwnerEmail = cleanString(authoritativeProgram.ownerEmail ?? authoritativeProgram.createdByEmail ?? application.programOwnerEmail, "", 180);
  const programOwnerName = cleanString(authoritativeProgram.ownerName ?? authoritativeProgram.owner ?? application.programOwnerName, "", 120);
  const derivedCreatorId = cleanString(application.creatorId, applicationDocId("program", email || handle || appId), 140);
  const creatorId = resolveProgramApplicationCreatorId(application, email, handle, name, derivedCreatorId);
  const threadId = canonicalThreadId({ conversationId: `program-${creatorId}`, creatorId, email, handle, name, youtubeUrl: application.youtubeUrl }) || `thread-${creatorId}`;
  const conversationSeed = campaignId ? `campaign-${campaignId}-${creatorId}` : `program-${programId}-${creatorId}`;
  const conversationId = canonicalConversationDocumentId({
    conversationId: conversationSeed,
    threadId,
    creatorId,
    email,
    handle,
    name,
    youtubeUrl: application.youtubeUrl,
    programId,
    campaignId,
    type: "program",
    source: "program_application",
  }) || conversationSeed;
  const contextKey = canonicalWorkflowContextKey({ conversationId, threadId, creatorId, email, handle, name, programId, campaignId, type: "program" });
  const contractId = programApplicationContractId(appId);
  const reviewId = programApplicationReviewId(appId);
  const avatar = cleanString(application.avatar, name.slice(0, 1).toUpperCase(), 240);
  const batch = transaction;
  const conversationRef = adminDb.collection("conversations").doc(conversationId);
  const messageId = `program-approval-${appId}`;
  const messageRef = `program_applications/${appId}`;
  const summary = `${title} 참여 신청이 승인되어 계약서 초안과 검수 대기가 생성됨`;
  const sourceRefs = [
    makeSourceRef(messageRef, "program_application", summary),
    makeSourceRef(`programs/${programId}`, "program", title),
    ...(campaignId ? [makeSourceRef(`campaigns/${campaignId}`, "campaign", campaignTitle || "캠페인")] : []),
  ];
  const creatorRef = adminDb.collection("creators").doc(creatorId);
  // A canonical creator can predate this program application (notably protected
  // operational fixtures such as rc-hesse). Approval may enrich that identity,
  // but must never downgrade its protection flags from application-local input.
  const creatorSnapshot = await transaction.get(creatorRef);
  const existingCreator = creatorSnapshot.exists ? (creatorSnapshot.data() ?? {}) : {};
  const conversationSnapshot = await transaction.get(conversationRef);
  const conversationMembership = await programConversationMembershipInTransaction(transaction, {
    conversationId,
    currentApplicationId: appId,
    currentApplication: application,
    currentStatus: "approved",
    canonicalProgramId: programId,
    campaignId,
    creatorId,
    conversation: conversationSnapshot.exists ? (conversationSnapshot.data() ?? {}) : null,
    programAliasMap: aliasRegistry.aliasMap,
  });
  const activeParticipation = {
    participationActive: true,
    participationStatus: "active",
    participationStage: "contract",
    participationUpdatedAtIso: nowIso,
    retractedAtIso: FieldValue.delete(),
    updatedAtIso: nowIso,
  };
  const workflowIdentity = await resolveProgramApplicationWorkflowIdentityInTransaction(transaction, {
    applicationRef,
    application,
    canonicalProgramId: programId,
    creatorId,
    nowIso,
    reviewPatchOnMigration: {
      ...activeParticipation,
      reviewActionable: true,
      reviewLifecycleStatus: "active",
      reviewSupersededAtIso: FieldValue.delete(),
      reviewSupersededReason: FieldValue.delete(),
    },
    contractPatchOnMigration: activeParticipation,
  });
  const { contractRef, reviewRef } = workflowIdentity;

  const creatorProtected = existingCreator.protected === true
    || application.protected === true
    || creatorId === CANONICAL_HESSE_CREATOR_ID;
  batch.set(creatorRef, {
    id: creatorId,
    name,
    handle,
    type: "influencer",
    avatar,
    email,
    platform,
    primaryPlatform: platform,
    followers,
    region,
    category,
    ownerUid: programOwnerUid || auth.userId,
    ...(programOwnerEmail ? { ownerEmail: programOwnerEmail } : {}),
    ...(programOwnerName ? { ownerName: programOwnerName } : {}),
    team: auth.team,
    programId: FieldValue.delete(),
    canonicalProgramId: FieldValue.delete(),
    programTitle: FieldValue.delete(),
    campaignId: FieldValue.delete(),
    campaignTitle: FieldValue.delete(),
    applicationId: FieldValue.delete(),
    applicationRef: FieldValue.delete(),
    programOwnerUid: FieldValue.delete(),
    source: "program_application",
    profileSource: "program_application",
    profileSourceRef: messageRef,
    protected: creatorProtected,
    ...(creatorProtected ? { seedWrite: false } : {}),
    updatedAtIso: nowIso,
  }, { merge: true });

  batch.set(conversationRef, {
    id: conversationId,
    threadId,
    contextKey,
    type: "program",
    programId,
    programTitle: title,
    ...(campaignId ? { campaignId, campaignTitle } : {}),
    ...conversationMembership.projection,
    participationUpdatedAtIso: nowIso,
    ...(programOwnerUid ? { programOwnerUid } : {}),
    ...(programOwnerEmail ? { programOwnerEmail } : {}),
    ...(programOwnerName ? { programOwnerName } : {}),
    creatorId,
    creatorName: name,
    creatorAvatar: avatar,
    creatorEmail: email,
    creatorHandle: handle,
    creatorPlatform: platform,
    creatorFollowers: followers,
    unread: 1,
    // 새 대화의 **대화별** 자동응답 스위치. 전역 게이트를 여기에 굳혀 넣으면 전역 OFF 중에
    // 만들어진 대화가 전역을 다시 켜도 영영 꺼진 채로 남는다 — 발사 시점에 전역과 AND 한다.
    aiActive: true,
    lastMessage: summary,
    lastMessageAtIso: nowIso,
    lastMessageRef: messageRef,
    lastMessageFrom: "ai",
    sourceRefs,
    updatedAtIso: nowIso,
  }, { merge: true });
  batch.set(conversationRef.collection("messages").doc(messageId), {
    id: messageId,
    from: "ai",
    label: "AI 요약",
    text: summary,
    summaryKr: summary,
    time: "방금",
    createdAtIso: nowIso,
    messageRef,
    sourceRefs,
  }, { merge: true });
  writeKnowledgeNode(batch, {
    id: `program-approval-${appId}`,
    type: "program_knowledge",
    title,
    summary,
    sourceRefs,
    entityRefs: [conversationRef.path, `contracts/${contractId}`, `reviews/${reviewId}`],
    createdAtIso: nowIso,
  });
  const reviewReason = "프로그램 신청 승인 후 계약·콘텐츠 제출·지급 가능 여부를 사람이 검수해야 합니다.";
  const recommendedResponse = "신청자 정보와 계약 생성 상태를 확인하고, 제출물이 도착하면 프로그램 가이드 기준에 따라 통과 또는 수정 요청을 기록하세요.";
  writeKnowledgeNode(batch, {
    id: `program-review-guidance-${reviewId}`,
    type: "human_review_guidance",
    title: `프로그램 검수 가이드: ${name}`,
    summary: `검수 사유: ${reviewReason} 권장 대응: ${recommendedResponse}`,
    sourceRefs: [...sourceRefs, makeSourceRef(`reviews/${reviewId}`, "review", "프로그램 승인 검수 대기")],
    entityRefs: [conversationRef.path, `contracts/${contractId}`, `reviews/${reviewId}`],
    createdAtIso: nowIso,
  });

  if (!workflowIdentity.contractExists) batch.create(contractRef, {
    id: contractId,
    contractIdentityVersion: PROGRAM_APPLICATION_CONTRACT_IDENTITY_VERSION,
    creatorId,
    creatorName: name,
    programId,
    programTitle: title,
    ...(campaignId ? { campaignId, campaignTitle } : {}),
    applicationId: appId,
    applicationRef: messageRef,
    participationActive: true,
    participationStatus: "active",
    participationStage: "contract",
    participationUpdatedAtIso: nowIso,
    ...(programOwnerUid ? { programOwnerUid } : {}),
    ...(programOwnerEmail ? { programOwnerEmail } : {}),
    ...(programOwnerName ? { programOwnerName } : {}),
    status: "draft",
    valueKRW: numberField(authoritativeProgram.rewardKRW, 0),
    signed: false,
    source: "program_application",
    sourceRefs,
    updatedAtIso: nowIso,
  });

  if (!workflowIdentity.reviewExists) batch.create(reviewRef, {
    id: reviewId,
    reviewIdentityVersion: PROGRAM_APPLICATION_REVIEW_IDENTITY_VERSION,
    creatorId,
    creatorName: name,
    programId,
    programTitle: title,
    ...(campaignId ? { campaignId, campaignTitle } : {}),
    applicationId: appId,
    applicationRef: messageRef,
    participationActive: true,
    participationStatus: "active",
    participationStage: "contract",
    participationUpdatedAtIso: nowIso,
    reviewActionable: true,
    reviewLifecycleStatus: "active",
    ...(programOwnerUid ? { programOwnerUid } : {}),
    ...(programOwnerEmail ? { programOwnerEmail } : {}),
    ...(programOwnerName ? { programOwnerName } : {}),
    status: "pending",
    result: "대기",
    source: "program_application",
    reviewTrigger: "program_approval",
    reason: reviewReason,
    reasonCode: "program_application_approved",
    actionReason: reviewReason,
    recommendedResponse,
    deliverable: `${title} 프로그램 제출물 검수`,
    title: `${name} 프로그램 신청 승인 검수`,
    submittedAt: "방금",
    reviewer: "미지정",
    checks: [
      { label: "신청자 프로필과 프로그램 조건 확인", ok: false },
      { label: "계약 초안 생성 여부 확인", ok: false },
      { label: "콘텐츠 제출 후 가이드 기준 검수", ok: false },
    ],
    sourceRefs,
    updatedAtIso: nowIso,
  });

    const workflow = { creatorId, conversationId, contractId, reviewId };
    const completionPatch = options.complete
      ? await options.complete({
        transaction,
        applicationRef,
        application: { ...application, ...workflow, workflowSyncedAtIso: nowIso, updatedAtIso: nowIso },
        sourceApplication: application,
        workflow,
        canonicalProgramId,
        programRef: authoritativeProgramRef,
        program: authoritativeProgram,
        nowIso,
      })
      : undefined;
  batch.update(applicationRef, {
    ...(completionPatch ?? {}),
    ...workflowIdentity.applicationPatch,
    creatorId,
    conversationId,
    applicationRef: messageRef,
    participationActive: true,
    participationStatus: "active",
    participationStage: "contract",
    participationUpdatedAtIso: nowIso,
    ...(programOwnerUid ? { programOwnerUid } : {}),
    ...(programOwnerEmail ? { programOwnerEmail } : {}),
    ...(programOwnerName ? { programOwnerName } : {}),
    workflowSyncedAtIso: nowIso,
    updatedAtIso: nowIso,
  });

    return workflow;
  });
}

function applicationMatchesConfirmedProgram(
  application: Record<string, unknown>,
  canonicalProgramId: string,
  aliasMap: Record<string, string>,
): boolean {
  const identities = [application.canonicalProgramId, application.programId]
    .map((value) => resolveCanonicalProgramId(value, aliasMap))
    .filter(Boolean);
  const canonicalIdentities = [...new Set(identities)];
  return canonicalIdentities.length === 1 && canonicalIdentities[0] === canonicalProgramId;
}

async function approvedApplicationDocsForProgram(
  program: LoadedProgram,
  cursor = "",
  perLegLimit?: number,
): Promise<QueryDocumentSnapshot[]> {
  const reads = program.identityProgramIds.flatMap((programId) => (
    (["programId", "canonicalProgramId"] as const).map(async (field) => {
      let query = adminDb.collection("program_applications")
        .where(field, "==", programId)
        .where("status", "==", "approved")
        .orderBy(FieldPath.documentId());
      if (cursor) query = query.startAfter(cursor);
      if (perLegLimit) query = query.limit(perLegLimit);
      return (await query.get()).docs;
    })
  ));
  const docs = new Map<string, QueryDocumentSnapshot>();
  for (const doc of (await Promise.all(reads)).flat()) {
    const row = doc.data() ?? {};
    if (applicationMatchesConfirmedProgram(row, program.id, aliasMapForLoadedProgram(program))) docs.set(doc.id, doc);
  }
  return [...docs.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function aliasMapForLoadedProgram(program: LoadedProgram): Record<string, string> {
  // `identityProgramIds` is the complete confirmed graph captured by loadProgram;
  // reconstructing this bounded star is sufficient for row conflict checks and
  // avoids a second registry read inside every union leg.
  return Object.fromEntries(program.identityProgramIds
    .filter((programId) => programId !== program.id)
    .map((programId) => [programId, program.id]));
}

async function countApprovedApplications(program: LoadedProgram): Promise<number> {
  const programIdFilter = program.identityProgramIds.length === 1
    ? Filter.where("programId", "==", program.identityProgramIds[0])
    : Filter.where("programId", "in", program.identityProgramIds);
  const canonicalProgramIdFilter = program.identityProgramIds.length === 1
    ? Filter.where("canonicalProgramId", "==", program.identityProgramIds[0])
    : Filter.where("canonicalProgramId", "in", program.identityProgramIds);
  const aggregate = await adminDb.collection("program_applications")
    .where(Filter.or(programIdFilter, canonicalProgramIdFilter))
    .where("status", "==", "approved")
    .count()
    .get();
  return aggregate.data().count;
}

async function processApprovedApplicationsPage(
  program: LoadedProgram,
  auth: AuthContext,
  cursor: string,
  limit: number,
) {
  const decodedCursor = decodeWorkflowCursor(cursor);
  const unionDocs = await approvedApplicationDocsForProgram(program, decodedCursor, limit + 1);
  const docs = unionDocs.slice(0, limit);
  const results = [];
  for (const doc of docs) {
    results.push(await ensureApprovedWorkflow({ id: doc.id, ...doc.data() }, { id: program.id, ...program.data }, auth));
  }
  const lastDoc = docs.at(-1);
  return {
    synced: results.length,
    results,
    nextCursor: unionDocs.length > limit && lastDoc ? encodeWorkflowCursor(lastDoc.id) : null,
  };
}

export async function createProgram(request: CallableRequestShape) {
  assertViewAsReadOnlyPayload("createProgram", request.data);
  const auth = assertNonGuestAuth(request, "program.create", ["super_admin", "admin", "manager"]);
  const data = asRecord(request.data);
  const accountScope = await resolveAccountOwnershipScopeForRequest(request, "program.create", ["super_admin", "admin", "manager"], { data });
  assertWritableAccountOwnershipScope(accountScope, "program.create");
  const explicitOwnershipAssignment = await resolveExplicitOwnershipAssignment(auth, request, { data });
  const title = cleanString(data.title, "새 프로그램", 120);
  const requestedSlug = cleanString(data.slug, "", 120);
  let slug = slugify(requestedSlug || title);
  const requestedId = cleanString(data.id, "", 120);
  let id = requestedId || `pg-${slug}`;
  const ownerName = cleanString(data.owner, auth.name || auth.userId, 80);
  if (!requestedId) {
    // F5(b): 명시 slug 요청은 기존 slug 재사용·soft-delete 복구 계약을 그대로 유지한다
    // (program-create-soft-delete-behavior 계약). 반면 생성 폼은 slug 를 보내지 않고 제목에서
    // 유도하므로, 제목이 겹치면 남의 문서를 merge-set 으로 덮어쓰고 카운터를 0 으로 리셋해 버린다 —
    // 그 경로에서는 재사용하지 않고 접미사로 새 문서를 만든다.
    const existingId = requestedSlug ? await existingProgramIdForSlug(slug, auth) : null;
    if (existingId) {
      id = existingId;
    } else if (!requestedSlug) {
      // 폼 경로: 제목 충돌이 남의 문서를 덮고 카운터를 리셋하지 못하게 새 slug/문서를 잡는다.
      slug = await freshProgramSlugForAccount(slug, auth);
      id = `pg-${slug}`;
    } else {
      slug = await uniqueProgramSlugForAccount(slug, auth);
      id = await uniqueProgramIdForAccount(`pg-${slug}`, auth);
    }
  }
  const existingProgramSnapshot = await adminDb.collection("programs").doc(id).get();
  const existingProgramRecord: Record<string, unknown> | null = existingProgramSnapshot.exists
    ? { id: existingProgramSnapshot.id, ...(existingProgramSnapshot.data() ?? {}) }
    : null;
  if (existingProgramSnapshot.exists) {
    // QA fixture retirement is intentionally one-way here. Restoring one needs
    // a separate engine with its own exact preview/CAS/audit contract; the
    // general create/upsert surface must never clear the archive implicitly.
    assertQaProgramRetirementNotRevived(existingProgramSnapshot.data());
  }
  const kpiMetric = VALID_KPI_METRICS.has(data.kpiMetric as ProgramKpiMetric) ? data.kpiMetric as ProgramKpiMetric : "approved";
  const nowIso = new Date().toISOString();
  const settings = await readSettings();
  const programAiInput = asRecord(data.programAi);
  const qualificationPolicy = boundedProgramPolicyRecord(data.qualificationPolicy, { musicOnlyDisposition: "human_gate" });
  const qualificationConfig = boundedProgramPolicyRecord(data.qualificationConfig);
  const rawCandidateCriteria = boundedProgramPolicyRecord(data.candidateCriteria);
  const candidateCriteria = aiDramaCandidateCriteriaDefaults(rawCandidateCriteria);
  const discoveryVertical = normalizeDiscoveryVertical(data.discoveryVertical ?? candidateCriteria.discoveryVertical);
  const status = programStatus(data.status, discoveryVertical === "ai_drama" ? "draft" : "open");
  const eligibilityCriteria = boundedProgramPolicyRecord(data.eligibilityCriteria);
  const countryTargeting = countryTargetingFromLegacy(data);
  const legacyTargetCountries = countryTargeting.countryScope === "inherit"
    ? undefined
    : countryTargeting.countryScope === "all"
      ? []
      : countryTargeting.includedCountries;
  const videoReviewPolicy = boundedProgramPolicyRecord(data.videoReviewPolicy, { minimumDurationSeconds: 20 });
  const videoReviewConfig = boundedProgramPolicyRecord(data.videoReviewConfig);
  const accountOwnership = explicitOwnershipAssignment?.stamp ?? (existingProgramSnapshot.exists
    ? await accountOwnershipStampForOwnedRecordAsync(
        accountScope,
        existingProgramRecord ?? {},
        "program",
      )
    : accountOwnershipStampForScope(accountScope));
  const defaultOwnerFields = scopedOwnerFields(auth, ownerName);
  const existingCreatorAuditFields = existingProgramRecord
    ? Object.fromEntries([
        "createdBy",
        "createdByRole",
        "createdByEmail",
        "createdByName",
        "createdAtIso",
      ].flatMap((key) => existingProgramRecord[key] === undefined ? [] : [[key, existingProgramRecord[key]]]))
    : {};
  const actorAuditFields = existingProgramRecord
    ? {
        ...existingCreatorAuditFields,
        updatedBy: auth.userId,
        updatedByRole: auth.role,
        ...(auth.email ? { updatedByEmail: auth.email } : {}),
        ...(auth.name ? { updatedByName: auth.name } : {}),
      }
    : explicitOwnershipAssignment
      ? {
          createdBy: auth.userId,
          createdByRole: auth.role,
          ...(auth.email ? { createdByEmail: auth.email } : {}),
          ...(auth.name || ownerName ? { createdByName: auth.name || ownerName } : {}),
        }
      : defaultOwnerFields;
  const explicitAssignmentLegacyOwnerClears = explicitOwnershipAssignment
    ? {
        ownerUid: FieldValue.delete(),
        ownerUids: FieldValue.delete(),
        accountOwnerUid: FieldValue.delete(),
        accountOwnerUids: FieldValue.delete(),
        programOwnerUid: FieldValue.delete(),
        programOwnerUids: FieldValue.delete(),
        campaignOwnerUid: FieldValue.delete(),
        campaignOwnerUids: FieldValue.delete(),
        ...(Object.prototype.hasOwnProperty.call(accountOwnership, "ownerEmail") ? {} : { ownerEmail: FieldValue.delete() }),
      }
    : {};
  const sourceRefs = [makeSourceRef("settings/program-ai", "settings", "program AI defaults")];
  const publicApplyPath = `/programs/${slug}/apply`;
  const programLinks = {
    requiredLinks: linkArrayField(data.requiredLinks, [{ label: "공개 신청", url: publicApplyPath }]),
    assetLinks: linkArrayField(data.assetLinks, []),
    submissionEndpoint: linkField(data.submissionEndpoint),
    applicationEndpoint: linkField(data.applicationEndpoint, { label: "공개 신청", url: publicApplyPath }),
  };
  const imageUrl = safeProgramUrl(data.imageUrl);
  const mailTemplate = mailTemplateField(data.mailTemplate, DEFAULT_MAIL_TEMPLATE);
  const program = {
    id,
    slug,
    title,
    status,
    brief: cleanString(data.brief, "참여 신청을 받고 승인 후 계약·검수로 연결합니다.", 2000),
    gameTitle: cleanString(data.gameTitle, "게임 미지정", 120),
    owner: ownerName,
    ...actorAuditFields,
    ...accountOwnership,
    ...(explicitOwnershipAssignment ? { ownershipAssignment: explicitOwnershipAssignment.assignment } : {}),
    team: auth.team,
    ...(imageUrl ? { imageUrl } : {}),
    mailTemplate,
    discoveryVertical,
    countryTargeting,
    excludedCountries: countryTargeting.excludedCountries,
    ...(legacyTargetCountries === undefined ? {} : { targetCountries: legacyTargetCountries }),
    rewardKRW: numberField(data.rewardKRW, 0),
    kpiMetric,
    kpiTarget: numberField(data.kpiTarget, 20),
    tags: discoveryVertical === "ai_drama"
      ? aiDramaProgramTags(stringArrayField(data.tags, []))
      : stringArrayField(data.tags, []),
    requiredLinks: programLinks.requiredLinks,
    assetLinks: programLinks.assetLinks,
    ...(programLinks.submissionEndpoint ? { submissionEndpoint: programLinks.submissionEndpoint } : {}),
    applicationEndpoint: programLinks.applicationEndpoint,
    qualificationPolicy,
    qualificationConfig,
    candidateCriteria,
    eligibilityCriteria,
    videoReviewPolicy,
    videoReviewConfig,
    programAi: {
      enabled: booleanField(programAiInput.enabled, settings.programAi.enabled),
      dryRunDefault: booleanField(programAiInput.dryRunDefault, settings.programAi.dryRunDefault),
      defaultTone: cleanString(programAiInput.defaultTone, settings.programAi.defaultTone, 160),
      defaultFormat: cleanString(programAiInput.defaultFormat, settings.programAi.defaultFormat, 500),
      toneTags: stringArrayField(programAiInput.toneTags, stringArrayField(programAiInput.defaultToneTags, [cleanString(programAiInput.defaultTone, settings.programAi.defaultTone, 160)])),
      formatTags: stringArrayField(programAiInput.formatTags, stringArrayField(programAiInput.defaultFormatTags, [cleanString(programAiInput.defaultFormat, settings.programAi.defaultFormat, 500)])),
      learningTags: stringArrayField(programAiInput.learningTags, settings.programAi.learningTags),
      maxPerProgramDailySends: numberField(programAiInput.maxPerProgramDailySends, settings.programAi.maxPerProgramDailySends),
      minProgramReplyDelayMinutes: numberField(programAiInput.minProgramReplyDelayMinutes, settings.programAi.minProgramReplyDelayMinutes),
      programTemplateNotes: stringArrayField(programAiInput.programTemplateNotes, settings.programAi.programTemplateNotes),
      qualification: boundedProgramPolicyRecord(programAiInput.qualification),
      sourceRefs,
    },
    ...(existingProgramRecord ? {} : {
      applicationCount: numberField(data.applicationCount, 0),
      approvedCount: numberField(data.approvedCount, 0),
      contractCount: numberField(data.contractCount, 0),
      reviewCount: numberField(data.reviewCount, 0),
    }),
    publicApplyPath,
    createdAtIso: cleanString(existingProgramRecord?.createdAtIso, nowIso, 80),
    updatedAtIso: nowIso,
    sourceRefs,
  };
  const batch = adminDb.batch();
  batch.set(adminDb.collection("programs").doc(id), {
    ...program,
    ...explicitAssignmentLegacyOwnerClears,
    deletedAt: FieldValue.delete(),
    archivedAt: FieldValue.delete(),
  }, { merge: true });
  writeKnowledgeNode(batch, {
    id: `program-knowledge-${id}`,
    type: "program_knowledge",
    title,
    summary: cleanString(program.brief, title, 500),
    sourceRefs: [...sourceRefs, makeSourceRef(`programs/${id}`, "program", title)],
    entityRefs: [`programs/${id}`],
    createdAtIso: nowIso,
  });
  await batch.commit();
  return { ok: true, program, behaviorLog: makeBehaviorLog(auth, `program.create(${id})`, "success", auth.gameId) };
}

export async function getPublicProgram(request: CallableRequestShape) {
  const data = asRecord(request.data);
  assertPublicAppCheck(request);
  const program = await loadProgram(cleanString(data.programId ?? data.id, "", 120), cleanString(data.slug, "", 120));
  const auth = publicAuthContext(request);
  if (!program) {
    const error = new Error("not-found: program");
    Object.assign(error, { code: "invalid-argument", errorCode: "get_public_program_program", behaviorLog: makeBehaviorLog(auth, "program.public.read", "error", "flu-program") });
    throw error;
  }
  const record = program.data;
  const slug = cleanString(record.slug, slugify(cleanString(record.title, "program", 120)), 120);
  return {
    ok: true,
    program: {
      id: program.id,
      slug,
      title: cleanString(record.title, "프로그램", 120),
      status: programStatus(record.status, "draft"),
      brief: cleanString(record.brief, "참여 신청을 받고 승인 후 계약·검수로 연결합니다.", 2000),
      gameTitle: cleanString(record.gameTitle, "XPHERO", 120),
      rewardKRW: numberField(record.rewardKRW, 0),
      kpiMetric: VALID_KPI_METRICS.has(record.kpiMetric as ProgramKpiMetric) ? record.kpiMetric as ProgramKpiMetric : "approved",
      kpiTarget: numberField(record.kpiTarget, 20),
      tags: stringArrayField(record.tags, ["UGC", "YouTube"]),
      publicApplyPath: cleanString(record.publicApplyPath, `/programs/${slug}/apply`, 240),
      requiredLinks: linkArrayField(record.requiredLinks, []),
      assetLinks: linkArrayField(record.assetLinks, []),
      ...(linkField(record.submissionEndpoint) ? { submissionEndpoint: linkField(record.submissionEndpoint) } : {}),
      ...(linkField(record.applicationEndpoint) ? { applicationEndpoint: linkField(record.applicationEndpoint) } : {}),
      ...(safeProgramUrl(record.imageUrl) ? { imageUrl: safeProgramUrl(record.imageUrl) } : {}),
      mailTemplate: mailTemplateField(record.mailTemplate, DEFAULT_MAIL_TEMPLATE),
    },
    behaviorLog: makeBehaviorLog(auth, `program.public.read(${program.id})`, "success", "flu-program"),
  };
}

export async function submitProgramApplication(request: CallableRequestShape) {
  const data = asRecord(request.data);
  assertPublicAppCheck(request);
  const requestedProgramId = cleanString(data.programId, "", 120);
  const program = await loadProgram(requestedProgramId, cleanString(data.slug, "", 120));
  if (!program) {
    const error = new Error("not-found: program");
    Object.assign(error, { code: "invalid-argument", errorCode: "submit_program_application_program", behaviorLog: makeBehaviorLog(publicAuthContext(request), "program.apply", "error", "flu-program") });
    throw error;
  }
  const email = cleanString(data.email, "", 180).toLowerCase();
  const handle = cleanString(data.handle, "", 120);
  const name = cleanString(data.name, cleanString(handle, "프로그램 신청자", 120), 120);
  const nowIso = new Date().toISOString();
  const identitySeed = email || handle || cleanString(data.youtubeUrl, "", 300) || name;
  const id = applicationDocId(program.id, identitySeed);
  const rateLimits = programApplicationRateLimits(request, program.id, identitySeed, nowIso);
  const appRef = adminDb.collection("program_applications").doc(id);
  const programRef = adminDb.collection("programs").doc(program.id);
  const application = await adminDb.runTransaction(async (transaction) => {
    const programSnapshot = await transaction.get(programRef);
    if (!programSnapshot.exists) {
      const error = new Error("not-found: program");
      Object.assign(error, { code: "invalid-argument", errorCode: "submit_program_application_program_2", behaviorLog: makeBehaviorLog(publicAuthContext(request), "program.apply", "error", "flu-program") });
      throw error;
    }
    const programSnapshotData = programSnapshot.data() ?? {};
    const aliasRegistry = await readConfirmedProgramAliasRegistryStateInTransaction(transaction);
    const currentCanonicalProgramId = resolveCanonicalProgramId(requestedProgramId || program.id, aliasRegistry.aliasMap);
    if (
      currentCanonicalProgramId !== program.id
      || aliasRegistry.revision !== program.aliasRegistryRevision
      || resolveCanonicalProgramId(programSnapshotData.canonicalProgramId || programSnapshot.id, aliasRegistry.aliasMap) !== program.id
    ) {
      const error = new Error("aborted: authoritative program alias registry changed before application write");
      Object.assign(error, { code: "aborted", errorCode: "submit_program_application_authoritative_program_alias_registry" });
      throw error;
    }
    if (!isEmulatorRuntime() && isOperationalFixtureRecord(programSnapshotData, "programs")) {
      const error = new Error("not-found: program");
      Object.assign(error, { code: "invalid-argument", errorCode: "submit_program_application_authoritative_program_alias_registry_2", behaviorLog: makeBehaviorLog(publicAuthContext(request), "program.apply", "error", "flu-program") });
      throw error;
    }
    const status = programStatus(programSnapshotData.status, "draft");
    if (status !== "open") {
      const error = new Error("failed-precondition: program is not open");
      Object.assign(error, { code: "failed-precondition", errorCode: "submit_program_application_program_open", behaviorLog: makeBehaviorLog(publicAuthContext(request), `program.apply.closed(${program.id})`, "denied", "flu-program") });
      throw error;
    }
    const appSnapshot = await transaction.get(appRef);
    if (appSnapshot.exists) {
      const error = new Error("already-exists: program application");
      Object.assign(error, { code: "already-exists", errorCode: "submit_program_application_already_exists_program_application", behaviorLog: makeBehaviorLog(publicAuthContext(request), `program.apply(${id})`, "denied", "flu-program") });
      throw error;
    }
    const rateLimitRefs = await enforceProgramApplicationRateLimit(transaction, rateLimits.auth, program.id, rateLimits.bucket, rateLimits.entries, nowIso);
    const programOwnerUid = cleanString(programSnapshotData.ownerUid ?? programSnapshotData.createdBy, "", 160);
    const programOwnerEmail = cleanString(programSnapshotData.ownerEmail ?? programSnapshotData.createdByEmail, "", 180);
    const programOwnerName = cleanString(programSnapshotData.ownerName ?? programSnapshotData.owner, "", 120);
    const leadId = safeDocId(`lead-${id}`);
    const leadRef = adminDb.collection("program_sheet_leads").doc(leadId);
    const applicationRef = appRef.path;
    const qualificationPolicySnapshot = boundedProgramPolicyRecord(programSnapshotData.qualificationPolicy);
    const videoReviewPolicySnapshot = boundedProgramPolicyRecord(
      Object.keys(boundedProgramPolicyRecord(programSnapshotData.videoReviewPolicy)).length > 0
        ? programSnapshotData.videoReviewPolicy
        : programSnapshotData.videoReviewConfig,
      { minimumDurationSeconds: 20 },
    );
    const createdApplication = {
      id,
      programId: program.id,
      canonicalProgramId: program.id,
      ...(requestedProgramId && requestedProgramId !== program.id ? { rawProgramIdAlias: requestedProgramId } : {}),
      leadId,
      leadRef: leadRef.path,
      applicationRef,
      programSlug: cleanString(programSnapshotData.slug, "", 120),
      programTitle: cleanString(programSnapshotData.title, "프로그램", 120),
      status: "pending" as ProgramApplicationStatus,
      name,
      email,
      handle,
      youtubeUrl: cleanString(data.youtubeUrl, "", 300),
      platform: cleanString(data.platform, "YouTube", 40),
      followers: numberField(data.followers, 0),
      region: cleanString(data.region, "KR", 40),
      category: cleanString(data.category, cleanString(programSnapshotData.gameTitle, "Program", 120), 160),
      pitch: cleanString(data.pitch, "", 3000),
      avatar: cleanString(data.avatar, name.slice(0, 1).toUpperCase(), 240),
      qualificationPolicySnapshot,
      videoReviewPolicySnapshot,
      ...(programOwnerUid ? { ownerUid: programOwnerUid, programOwnerUid } : {}),
      ...(programOwnerEmail ? { programOwnerEmail } : {}),
      ...(programOwnerName ? { programOwnerName } : {}),
      submittedAtIso: nowIso,
      updatedAtIso: nowIso,
      rateLimitRef: rateLimitRefs.identity,
      rateLimitRefs,
    };
    transaction.create(appRef, createdApplication);
    transaction.create(leadRef, {
      id: leadId,
      leadId,
      programId: program.id,
      canonicalProgramId: program.id,
      ...(requestedProgramId && requestedProgramId !== program.id ? { rawProgramIdAlias: requestedProgramId } : {}),
      applicationId: id,
      applicationRef,
      sourceType: "program_application",
      sourceId: id,
      sourceRef: applicationRef,
      applicant: {
        name,
        email,
        handle,
        youtubeUrl: cleanString(data.youtubeUrl, "", 300),
        platform: cleanString(data.platform, "YouTube", 40),
        country: cleanString(data.region, "KR", 40),
        category: cleanString(data.category, cleanString(programSnapshotData.gameTitle, "Program", 120), 160),
        submittedAt: nowIso,
      },
      metrics: {
        subscribers: numberField(data.followers, 0),
      },
      qualificationPolicySnapshot,
      videoReviewPolicySnapshot,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    });
    transaction.set(programRef, {
      id: program.id,
      applicationCount: FieldValue.increment(1),
      updatedAtIso: nowIso,
    }, { merge: true });
    return createdApplication;
  });
  return { ok: true, application, behaviorLog: makeBehaviorLog(publicAuthContext(request), `program.apply(${id})`, "success", "flu-program") };
}

export async function reviewProgramApplication(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "program.application.review", ["super_admin", "admin", "manager"]);
  const data = asRecord(request.data);
  const applicationId = cleanString(data.applicationId ?? data.id, "", 160);
  const status = applicationStatus(data.status, "approved");
  if (!applicationId) {
    const error = new Error("invalid-argument: applicationId required");
    Object.assign(error, { code: "invalid-argument", errorCode: "review_program_application_application_id_required", behaviorLog: makeBehaviorLog(auth, "program.application.review", "error", auth.gameId) });
    throw error;
  }
  const appRef = adminDb.collection("program_applications").doc(applicationId);
  const nowIso = new Date().toISOString();
  const reason = cleanString(data.reason, "", 500);
  const reviewed = await adminDb.runTransaction(async (transaction) => {
    const appSnapshot = await transaction.get(appRef);
    if (!appSnapshot.exists) {
      const error = new Error("not-found: application");
      Object.assign(error, { code: "invalid-argument", errorCode: "review_program_application_application", behaviorLog: makeBehaviorLog(auth, "program.application.review", "error", auth.gameId) });
      throw error;
    }
    const application = { id: appSnapshot.id, ...(appSnapshot.data() ?? {}) } as Record<string, unknown> & { id: string };
    const aliasRegistry = await readConfirmedProgramAliasRegistryStateInTransaction(transaction);
    const applicationProgramIds = [application.canonicalProgramId, application.programId]
      .map((value) => resolveCanonicalProgramId(value, aliasRegistry.aliasMap))
      .filter(Boolean);
    const canonicalProgramIds = [...new Set(applicationProgramIds)];
    if (canonicalProgramIds.length !== 1) {
      const error = new Error("failed-precondition: application program identity is missing or contradictory");
      Object.assign(error, { code: "failed-precondition", errorCode: "review_program_application_application_program_identity_missing" });
      throw error;
    }
    const canonicalProgramId = canonicalProgramIds[0];
    let programRef: DocumentReference | null = adminDb.collection("programs").doc(canonicalProgramId);
    const canonicalProgramSnapshot = await transaction.get(programRef);
    let program = canonicalProgramSnapshot.exists
      ? { id: canonicalProgramSnapshot.id, data: canonicalProgramSnapshot.data() ?? {} }
      : null as { id: string; data: Record<string, unknown> } | null;
    if (!program && canonicalProgramId === SCP_CANONICAL_PROGRAM_ID) {
      const legacySnapshot = await transaction.get(adminDb.collection("programs").doc("scp"));
      if (legacySnapshot.exists) {
        programRef = legacySnapshot.ref;
        program = { id: canonicalProgramId, data: legacySnapshot.data() ?? {} };
      }
    }
    if (!program || !programRef) {
      const error = new Error("not-found: program");
      Object.assign(error, { code: "invalid-argument", errorCode: "review_program_application_program", behaviorLog: makeBehaviorLog(auth, "program.application.review", "error", auth.gameId) });
      throw error;
    }
    const authoritativeProgram = authoritativeProgramRecord(
      program.data,
      programRef.id,
      canonicalProgramId,
      aliasRegistry.aliasMap,
    );
    program = { id: canonicalProgramId, data: authoritativeProgram };
    if (!rowMatchesAccountScope("programs", authoritativeProgram, auth)) {
      const error = new Error("permission-denied: program belongs to another account");
      Object.assign(error, { code: "permission-denied", errorCode: "review_program_application_program_belongs_another_account", behaviorLog: makeBehaviorLog(auth, "program.application.review", "denied", auth.gameId) });
      throw error;
    }
    const accountScope = await resolveAccountOwnershipScopeForRequest(request, "program.application.review", ["super_admin", "admin", "manager"]);
    await assertAccountOwnershipForRecordAsync(accountScope, authoritativeProgram, "program");
    assertOptionalApplicationCreatorIdentity(application);

    const previousStatus = applicationStatus(application.status, "pending");
    const approvedDelta = (status === "approved" ? 1 : 0) - (previousStatus === "approved" ? 1 : 0);
    const hasConversation = Boolean(cleanString(application.conversationId, "", 180));
    const hasContract = Boolean(cleanString(application.contractId, "", 180));
    const hasReview = Boolean(cleanString(application.reviewId, "", 180));
    const workflowAlreadyLinked = hasConversation && hasContract && hasReview;
    const shouldCreateWorkflow = status === "approved" && !workflowAlreadyLinked;
    if (shouldCreateWorkflow) {
      return {
        application,
        program,
        previousStatus,
        shouldCreateWorkflow: true,
      };
    }
    const programCounterPatch: Record<string, unknown> = { updatedAtIso: nowIso };
    if (approvedDelta !== 0) programCounterPatch.approvedCount = FieldValue.increment(approvedDelta);
    if (status === "approved" && !hasContract) programCounterPatch.contractCount = FieldValue.increment(1);
    if (status === "approved" && !hasReview) programCounterPatch.reviewCount = FieldValue.increment(1);
    let linkedWorkflowApplicationPatch: Record<string, unknown> = {};

    if (workflowAlreadyLinked) {
      const conversationId = cleanString(application.conversationId, "", 500);
      const conversationRef = adminDb.collection("conversations").doc(conversationId);
      const conversationSnapshot = await transaction.get(conversationRef);
      if (!conversationSnapshot.exists) throw programWorkflowIdentityError("linked workflow conversation is missing");
      const creatorId = cleanString(application.creatorId, "", 180);
      if (!creatorId) throw programWorkflowIdentityError("linked workflow creator identity is missing");
      const conversationMembership = await programConversationMembershipInTransaction(transaction, {
        conversationId,
        currentApplicationId: applicationId,
        currentApplication: application,
        currentStatus: status,
        canonicalProgramId,
        campaignId: cleanString(application.campaignId, "", 180),
        creatorId,
        conversation: conversationSnapshot.data() ?? {},
        programAliasMap: aliasRegistry.aliasMap,
      });
      const applicationParticipation = status === "approved"
        ? {
          participationActive: true,
          participationStatus: "active",
          participationStage: "contract",
          participationUpdatedAtIso: nowIso,
          retractedAtIso: FieldValue.delete(),
          updatedAtIso: nowIso,
        }
        : {
          participationActive: false,
          participationStatus: "retracted",
          participationStage: "contact",
          participationUpdatedAtIso: nowIso,
          retractedAtIso: nowIso,
          updatedAtIso: nowIso,
        };
      const reviewParticipation = status === "approved"
        ? {
          ...applicationParticipation,
          reviewActionable: true,
          reviewLifecycleStatus: "active",
          reviewSupersededAtIso: FieldValue.delete(),
          reviewSupersededReason: FieldValue.delete(),
        }
        : {
          ...applicationParticipation,
          reviewActionable: false,
          reviewLifecycleStatus: "superseded",
          reviewSupersededAtIso: nowIso,
          reviewSupersededReason: "program_application_retracted",
        };
      const workflowIdentity = await resolveProgramApplicationWorkflowIdentityInTransaction(transaction, {
        applicationRef: appRef,
        application,
        canonicalProgramId,
        creatorId,
        nowIso,
        reviewPatchOnMigration: reviewParticipation,
        contractPatchOnMigration: applicationParticipation,
      });
      if (!workflowIdentity.reviewExists || !workflowIdentity.contractExists) {
        throw programWorkflowIdentityError("linked workflow artifact is missing");
      }
      transaction.set(conversationRef, {
        ...conversationMembership.projection,
        participationUpdatedAtIso: nowIso,
        retractedAtIso: conversationMembership.activeApplicationRefs.length > 0
          ? FieldValue.delete()
          : nowIso,
        updatedAtIso: nowIso,
      }, { merge: true });
      if (!workflowIdentity.contractCreatedByMigration) {
        transaction.set(workflowIdentity.contractRef, applicationParticipation, { merge: true });
      }
      if (!workflowIdentity.reviewCreatedByMigration
        && (status !== "approved" || previousStatus !== "approved")) {
        transaction.set(workflowIdentity.reviewRef, reviewParticipation, { merge: true });
      }
      linkedWorkflowApplicationPatch = workflowIdentity.applicationPatch;
    }

    transaction.set(appRef, {
      ...linkedWorkflowApplicationPatch,
      programId: canonicalProgramId,
      canonicalProgramId,
      status,
      reason,
      participationActive: status === "approved",
      participationStatus: status === "approved" ? "active" : status === "rejected" ? "retracted" : status,
      participationStage: status === "approved" ? "contract" : "contact",
      participationUpdatedAtIso: nowIso,
      reviewedBy: auth.userId,
      reviewedAtIso: nowIso,
      updatedAtIso: nowIso,
    }, { merge: true });
    transaction.set(programRef, programCounterPatch, { merge: true });
    return {
      application,
      program,
      previousStatus,
      shouldCreateWorkflow: false,
    };
  });
  let workflow: Awaited<ReturnType<typeof ensureApprovedWorkflow>> | null = null;
  if (reviewed.shouldCreateWorkflow) {
    workflow = await ensureApprovedWorkflow(
      { id: applicationId },
      { id: reviewed.program.id },
      auth,
      {
        approvalTransitionFrom: reviewed.previousStatus,
        humanDecision: true,
        complete: ({
          transaction,
          sourceApplication,
          canonicalProgramId,
          programRef,
          nowIso: workflowNowIso,
        }) => {
          const currentPreviousStatus = applicationStatus(sourceApplication.status, "pending");
          const approvedDelta = 1 - (currentPreviousStatus === "approved" ? 1 : 0);
          const hadContract = Boolean(cleanString(sourceApplication.contractId, "", 180));
          const hadReview = Boolean(cleanString(sourceApplication.reviewId, "", 180));
          const programCounterPatch: Record<string, unknown> = { updatedAtIso: workflowNowIso };
          if (approvedDelta !== 0) programCounterPatch.approvedCount = FieldValue.increment(approvedDelta);
          if (!hadContract) programCounterPatch.contractCount = FieldValue.increment(1);
          if (!hadReview) programCounterPatch.reviewCount = FieldValue.increment(1);
          transaction.set(programRef, programCounterPatch, { merge: true });
          return {
            programId: canonicalProgramId,
            canonicalProgramId,
            status: "approved",
            reason,
            participationActive: true,
            participationStatus: "active",
            participationStage: "contract",
            participationUpdatedAtIso: workflowNowIso,
            reviewedBy: auth.userId,
            reviewedAtIso: workflowNowIso,
            updatedAtIso: workflowNowIso,
          };
        },
      },
    );
  }
  return {
    ok: true,
    applicationId,
    status,
    workflow,
    behaviorLog: makeBehaviorLog(auth, `program.application.${status}`, "success", auth.gameId),
  };
}

export async function syncProgramWorkflow(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "program.workflow.sync", ["super_admin", "admin", "manager"]);
  const data = asRecord(request.data);
  const program = await loadProgram(cleanString(data.programId ?? data.id, "", 120), cleanString(data.slug, "", 120));
  if (!program) {
    const error = new Error("not-found: program");
    Object.assign(error, { code: "invalid-argument", errorCode: "sync_program_workflow_program", behaviorLog: makeBehaviorLog(auth, "program.workflow.sync", "error", auth.gameId) });
    throw error;
  }
  if (!rowMatchesAccountScope("programs", { id: program.id, ...program.data }, auth)) {
    const error = new Error("permission-denied: program belongs to another account");
    Object.assign(error, { code: "permission-denied", errorCode: "sync_program_workflow_program_2", behaviorLog: makeBehaviorLog(auth, "program.workflow.sync", "denied", auth.gameId) });
    throw error;
  }
  const accountScope = await resolveAccountOwnershipScopeForRequest(request, "program.workflow.sync", ["super_admin", "admin", "manager"]);
  await assertAccountOwnershipForRecordAsync(accountScope, { id: program.id, ...program.data }, "program");
  const limit = boundedWorkflowPageSize(data.limit);
  const maxPages = boundedWorkflowPages(data.maxPages);
  let nextCursor = cleanString(data.cursor, "", 240);
  let synced = 0;
  let pages = 0;
  const results = [];

  do {
    const page = await processApprovedApplicationsPage(program, auth, nextCursor, limit);
    pages += 1;
    synced += page.synced;
    results.push(...page.results);
    nextCursor = page.nextCursor ?? "";
  } while (nextCursor && pages < maxPages);

  const approvedCount = await countApprovedApplications(program);
  const nowIso = new Date().toISOString();
  const programRef = adminDb.collection("programs").doc(program.id);
  await adminDb.runTransaction(async (transaction) => {
    const [programSnapshot, aliasRegistry] = await Promise.all([
      transaction.get(programRef),
      readConfirmedProgramAliasRegistryStateInTransaction(transaction),
    ]);
    const row = programSnapshot.data() ?? {};
    if (
      !programSnapshot.exists
      || aliasRegistry.revision !== program.aliasRegistryRevision
      || resolveCanonicalProgramId(row.canonicalProgramId || programSnapshot.id, aliasRegistry.aliasMap) !== program.id
    ) {
      throw Object.assign(new Error("aborted: authoritative program alias registry changed during workflow sync"), { code: "aborted", errorCode: "sync_program_workflow_authoritative_program_alias_registry_changed" });
    }
    transaction.set(programRef, {
      approvedCount,
      updatedAtIso: nowIso,
      lastWorkflowSyncedAtIso: nowIso,
      lastWorkflowSyncCount: synced,
      lastWorkflowSyncPages: pages,
      lastWorkflowSyncCursor: nextCursor || null,
      workflowSyncComplete: !nextCursor,
    }, { merge: true });
  });
  return {
    ok: true,
    programId: program.id,
    synced,
    approvedCount,
    pages,
    nextCursor: nextCursor || null,
    complete: !nextCursor,
    results: results.slice(0, 50),
    behaviorLog: makeBehaviorLog(auth, `program.workflow.sync(${program.id})`, "success", auth.gameId),
  };
}
