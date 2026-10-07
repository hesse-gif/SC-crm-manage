import { createHash, randomBytes } from "node:crypto";
import { FieldValue, type Transaction } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { assertMutationOwner, mutationOwnerUids } from "./mutationAuthorization";
import { resolveCanonicalProgramId } from "./programCanonical";
import {
  asRecord,
  asString,
  assertNonGuestAuth,
  type AuthContext,
  type CallableRequestShape,
} from "./shared";

const OUTBOX_COLLECTION = "mail_outbound_log";
const MESSAGE_SOURCES_COLLECTION = "message_sources";
const PROVIDER_UNIQUENESS_COLLECTION = "mail_provider_message_uniqueness";
const RECIPIENT_INBOUND_LOCKS_COLLECTION = "mail_recipient_inbound_locks";
const PREVIEW_CLAIMS_COLLECTION = "sent_only_attribution_preview_claims";
const AUDIT_COLLECTION = "sent_only_attribution_audits";
const IMPORT_SOURCE = "external_sent_mail_import";
const IMPORT_MAIL_TYPE = "manual_external_gmail";
const IMPORT_RECEIPT_SCHEMA_VERSION = "mail-provider-message-uniqueness-v2";
const ATTRIBUTION_AUDIT_SCHEMA_VERSION = "sent-only-attribution-audit-v2";
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_IDENTITIES = 20;
const WRITE_ROLES = ["super_admin", "admin", "manager"] as const;

export const SENT_ONLY_ATTRIBUTION_CONFIRMATION_VERSION =
  "sent-only-attribution-v1" as const;
export const SENT_ONLY_ATTRIBUTION_PROJECTION_VERSION =
  "sent-only-attribution-projection-v1" as const;

type AttributionAction = "assign" | "supersede" | "remove";
type AttributionStatus = "active" | "removed";

type ExactSentIdentity = {
  outboxRef: string;
  messageSourceRef: string;
  trackingId: string;
  providerMessageIdHash: string;
  expectedAttributionVersion: number;
  supersedesAuditRef: string;
};

type NormalizedRequest = {
  action: AttributionAction;
  programId: string;
  campaignId: string;
  reason: string;
  identities: ExactSentIdentity[];
};

type StoredProjection = {
  schemaVersion: typeof SENT_ONLY_ATTRIBUTION_PROJECTION_VERSION;
  version: number;
  status: AttributionStatus;
  action: AttributionAction;
  programId: string;
  campaignId: string;
  programOwnerUid: string;
  auditRef: string;
  supersedesAuditRef: string;
  sourceProvenanceHash: string;
  decidedAtIso: string;
};

type TargetEvidence = {
  programId: string;
  campaignId: string;
  ownerUid: string;
  stateFingerprint: string;
};

type CanonicalImportReceiptEvidence = {
  schemaVersion: typeof IMPORT_RECEIPT_SCHEMA_VERSION;
  receiptRef: string;
  receiptHash: string;
  providerMessageIdHash: string;
  canonicalProviderMessageIdHash: string;
  recipientHash: string;
  trackingId: string;
  outboxRef: string;
  messageSourceRef: string;
  source: typeof IMPORT_SOURCE;
  accountUidHash: string;
  sourceProvenanceHash: string;
};

type PriorAuditReceiptEvidence = {
  schemaVersion: typeof ATTRIBUTION_AUDIT_SCHEMA_VERSION;
  auditRef: string;
  receiptHash: string;
  version: number;
  status: AttributionStatus;
  programId: string;
  campaignId: string;
  accountUidHash: string;
  lineageDepth: number;
};

type RecipientInboundLockAbsenceEvidence = {
  schemaVersion: "mail-recipient-inbound-lock-absence-v1";
  lockRef: string;
  recipientHash: string;
  exists: false;
  stateFingerprint: string;
};

type PlannedItem = {
  identity: ExactSentIdentity;
  sourceProvenanceHash: string;
  before: StoredProjection | null;
  after: StoredProjection;
  sourceStateFingerprint: string;
  outboxStateFingerprint: string;
  ambiguityFingerprint: string;
  importReceipt: CanonicalImportReceiptEvidence;
  priorAuditReceipt: PriorAuditReceiptEvidence | null;
  recipientInboundLock: RecipientInboundLockAbsenceEvidence;
};

type AttributionPlan = {
  requestFingerprint: string;
  planFingerprint: string;
  action: AttributionAction;
  programId: string;
  campaignId: string;
  reason: string;
  items: PlannedItem[];
  targetEvidence: TargetEvidence[];
};

function operationError(
  code: "invalid-argument" | "failed-precondition" | "not-found",
  message: string,
): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function invalidArgument(message: string): Error {
  return operationError("invalid-argument", message);
}

function failedPrecondition(message: string): Error {
  return operationError("failed-precondition", message);
}

function notFound(message: string): Error {
  return operationError("not-found", message);
}

function hashHex(value: string, length = 64): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function stableValue(value: unknown): unknown {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object") {
    const timestamp = value as { toMillis?: () => number };
    if (typeof timestamp.toMillis === "function") return timestamp.toMillis();
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return String(value);
}

function stableHash(value: unknown, length = 64): string {
  return hashHex(JSON.stringify(stableValue(value)), length);
}

function safeId(value: string, fallback = "id"): string {
  const normalized = value
    .replace(/[<>]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140);
  return normalized || fallback;
}

function exactDocumentPath(value: unknown, collection: string, label: string): string {
  const path = asString(value);
  const prefix = `${collection}/`;
  if (
    !path.startsWith(prefix)
    || path.slice(prefix.length).length === 0
    || path.slice(prefix.length).includes("/")
    || path.length > 500
  ) {
    throw invalidArgument(`${label} must be an exact ${collection} document path`);
  }
  return path;
}

function exactAuditRef(value: unknown, required: boolean): string {
  const ref = asString(value);
  if (!ref && !required) return "";
  return exactDocumentPath(ref, AUDIT_COLLECTION, "supersedesAuditRef");
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw invalidArgument(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function normalizeIdentity(value: unknown, action: AttributionAction): ExactSentIdentity {
  const record = asRecord(value);
  const outboxRef = exactDocumentPath(record.outboxRef, OUTBOX_COLLECTION, "outboxRef");
  const sourceRefCandidates = [
    asString(record.messageSourceRef),
    asString(record.sourceRef),
    asString(record.messageRef),
  ].filter(Boolean);
  if (new Set(sourceRefCandidates).size > 1) {
    throw invalidArgument("messageSourceRef/sourceRef identity is conflicting");
  }
  const messageSourceRef = exactDocumentPath(
    sourceRefCandidates[0],
    MESSAGE_SOURCES_COLLECTION,
    "messageSourceRef",
  );
  const trackingId = asString(record.trackingId);
  if (!/^[A-Za-z0-9_-]{4,120}$/.test(trackingId)) {
    throw invalidArgument("trackingId is invalid");
  }
  if (outboxRef !== `${OUTBOX_COLLECTION}/${trackingId}`) {
    throw invalidArgument("outboxRef must identify the exact trackingId document");
  }
  if (messageSourceRef !== `${MESSAGE_SOURCES_COLLECTION}/${safeId(`external-sent-${trackingId}`)}`) {
    throw invalidArgument("messageSourceRef must identify the canonical imported source document");
  }
  const providerMessageIdHash = asString(record.providerMessageIdHash).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(providerMessageIdHash)) {
    throw invalidArgument("providerMessageIdHash must be the exact canonical 64-hex identity");
  }
  return {
    outboxRef,
    messageSourceRef,
    trackingId,
    providerMessageIdHash,
    expectedAttributionVersion: nonNegativeInteger(
      record.expectedAttributionVersion,
      "expectedAttributionVersion",
    ),
    supersedesAuditRef: exactAuditRef(
      record.supersedesAuditRef,
      action === "supersede" || action === "remove",
    ),
  };
}

function normalizeRequest(data: Record<string, unknown>): NormalizedRequest {
  const action = asString(data.action, "assign") as AttributionAction;
  if (!(["assign", "supersede", "remove"] as string[]).includes(action)) {
    throw invalidArgument("action must be assign, supersede, or remove");
  }
  const programId = resolveCanonicalProgramId(data.programId);
  const campaignId = asString(data.campaignId);
  if (programId.includes("/") || programId.length > 300) {
    throw invalidArgument("programId is invalid");
  }
  if (campaignId.includes("/") || campaignId.length > 300) {
    throw invalidArgument("campaignId is invalid");
  }
  if (action === "remove") {
    if (programId || campaignId) throw invalidArgument("remove must not declare a new program or campaign");
  } else if (!programId) {
    throw invalidArgument("programId is required for sent-only attribution");
  }
  const reason = asString(data.reason).replace(/\s+/g, " ").slice(0, 500);
  if (reason.length < 8) throw invalidArgument("a concrete attribution reason is required");
  if (!Array.isArray(data.identities) || data.identities.length < 1 || data.identities.length > MAX_IDENTITIES) {
    throw invalidArgument(`identities must contain 1-${MAX_IDENTITIES} exact imported message identities`);
  }
  const identities = data.identities.map((identity) => normalizeIdentity(identity, action));
  const duplicateKeys = new Set<string>();
  for (const identity of identities) {
    for (const key of [identity.outboxRef, identity.messageSourceRef, identity.trackingId, identity.providerMessageIdHash]) {
      if (duplicateKeys.has(key)) throw invalidArgument("identities contain a duplicate outbox/message/source identity");
      duplicateKeys.add(key);
    }
    if (action === "assign" && identity.supersedesAuditRef) {
      throw invalidArgument("assign cannot supersede an existing attribution audit");
    }
  }
  return { action, programId, campaignId, reason, identities };
}

function actorFingerprint(auth: AuthContext): Record<string, unknown> {
  return {
    uidHash: hashHex(auth.userId, 32),
    role: auth.role,
    teamHash: hashHex(auth.team, 24),
  };
}

function requestFingerprint(auth: AuthContext, request: NormalizedRequest): string {
  return stableHash({
    confirmationVersion: SENT_ONLY_ATTRIBUTION_CONFIRMATION_VERSION,
    actor: actorFingerprint(auth),
    request,
  });
}

function previewToken(): string {
  return `${SENT_ONLY_ATTRIBUTION_CONFIRMATION_VERSION}.${randomBytes(20).toString("hex")}`;
}

function validPreviewToken(value: string): boolean {
  return new RegExp(`^${SENT_ONLY_ATTRIBUTION_CONFIRMATION_VERSION}\\.[a-f0-9]{40}$`).test(value);
}

function previewClaimRef(token: string) {
  return adminDb.collection(PREVIEW_CLAIMS_COLLECTION).doc(`claim-${hashHex(token, 40)}`);
}

function auditRefForToken(token: string) {
  return adminDb.collection(AUDIT_COLLECTION).doc(`audit-${hashHex(token, 40)}`);
}

function projectionFromRecord(record: Record<string, unknown>): StoredProjection | null {
  const raw = asRecord(record.sentOnlyAttribution);
  if (Object.keys(raw).length === 0) return null;
  const schemaVersion = asString(raw.schemaVersion);
  const version = Number(raw.version);
  const status = asString(raw.status) as AttributionStatus;
  const action = asString(raw.action) as AttributionAction;
  const auditRef = asString(raw.auditRef);
  const sourceProvenanceHash = asString(raw.sourceProvenanceHash);
  const programId = resolveCanonicalProgramId(raw.programId);
  const campaignId = asString(raw.campaignId);
  const programOwnerUid = asString(raw.programOwnerUid);
  const supersedesAuditRef = asString(raw.supersedesAuditRef);
  const decidedAtIso = asString(raw.decidedAtIso);
  if (
    schemaVersion !== SENT_ONLY_ATTRIBUTION_PROJECTION_VERSION
    || !Number.isInteger(version)
    || version < 1
    || !(["active", "removed"] as string[]).includes(status)
    || !(["assign", "supersede", "remove"] as string[]).includes(action)
    || !new RegExp(`^${AUDIT_COLLECTION}\\/[^/]+$`).test(auditRef)
    || !/^[a-f0-9]{64}$/.test(sourceProvenanceHash)
    || !Number.isFinite(Date.parse(decidedAtIso))
  ) {
    throw failedPrecondition("existing sent-only attribution projection is malformed");
  }
  if (status === "active" && (!programId || !programOwnerUid)) {
    throw failedPrecondition("active sent-only attribution is missing its exact program owner scope");
  }
  if (status === "removed" && (programId || campaignId || programOwnerUid)) {
    throw failedPrecondition("removed sent-only attribution retains an active target");
  }
  return {
    schemaVersion: SENT_ONLY_ATTRIBUTION_PROJECTION_VERSION,
    version,
    status,
    action,
    programId,
    campaignId,
    programOwnerUid,
    auditRef,
    supersedesAuditRef,
    sourceProvenanceHash,
    decidedAtIso,
  };
}

function originalSourceProvenance(
  source: Record<string, unknown>,
  outbox: Record<string, unknown>,
): Record<string, unknown> {
  return {
    source: {
      id: asString(source.id),
      direction: asString(source.direction),
      source: asString(source.source),
      mailType: asString(source.mailType),
      trackingId: asString(source.trackingId),
      externalTrackingId: asString(source.externalTrackingId),
      providerMessageIdHash: asString(source.providerMessageIdHash),
      extractedPixelTrackingId: asString(source.extractedPixelTrackingId),
      toMasked: asString(source.toMasked),
      toHash: asString(source.toHash),
      fromHash: asString(source.fromHash),
      subject: asString(source.subject),
      subjectHash: asString(source.subjectHash),
      bodyHash: asString(source.bodyHash),
      htmlHash: asString(source.htmlHash),
      sentAtIso: asString(source.sentAtIso),
      importedAtIso: asString(source.importedAtIso),
      importRunId: asString(source.importRunId),
      idempotencyKey: asString(source.idempotencyKey),
      createdBy: asString(source.createdBy),
    },
    outbox: {
      trackingId: asString(outbox.trackingId),
      source: asString(outbox.source),
      sourceRef: asString(outbox.sourceRef),
      mailType: asString(outbox.mailType),
      providerMessageIdHash: asString(outbox.providerMessageIdHash),
      to: asString(outbox.to),
      toMasked: asString(outbox.toMasked),
      toHash: asString(outbox.toHash),
      fromHash: asString(outbox.fromHash),
      subject: asString(outbox.subject),
      sentAtIso: asString(outbox.sentAtIso),
      sentByUserId: asString(outbox.sentByUserId),
      sentByRole: asString(outbox.sentByRole),
      deliveryState: asString(outbox.deliveryState),
      draftRef: asString(outbox.draftRef),
      gameId: asString(outbox.gameId),
    },
  };
}

function routingState(record: Record<string, unknown>): Record<string, unknown> {
  return {
    programId: resolveCanonicalProgramId(record.programId),
    canonicalProgramId: resolveCanonicalProgramId(record.canonicalProgramId),
    campaignId: asString(record.campaignId),
    programOwnerUid: asString(record.programOwnerUid),
    type: asString(record.type),
    lastSentOnlyAttributionAuditRef: asString(record.lastSentOnlyAttributionAuditRef),
    sentOnlyAttribution: asRecord(record.sentOnlyAttribution),
    conversationId: asString(record.conversationId),
    conversationRef: asString(record.conversationRef),
    hasReply: record.hasReply === true,
    replyCount: Math.max(0, Number(record.replyCount) || 0),
    lastReplyAtIso: asString(record.lastReplyAtIso),
  };
}

function assertNoReplyOrConversation(
  source: Record<string, unknown>,
  outbox: Record<string, unknown>,
  inboundMatchCount: number,
): void {
  const states = [routingState(source), routingState(outbox)];
  if (
    inboundMatchCount > 0
    || states.some((state) =>
      Boolean(state.conversationId)
      || Boolean(state.conversationRef)
      || state.hasReply === true
      || Number(state.replyCount) > 0
      || Boolean(state.lastReplyAtIso))
  ) {
    throw failedPrecondition("sent-only attribution requires an imported message with no reply conversation");
  }
}

function assertImportedLedgerIdentity(
  identity: ExactSentIdentity,
  source: Record<string, unknown>,
  outbox: Record<string, unknown>,
): string {
  const sourceId = identity.messageSourceRef.slice(`${MESSAGE_SOURCES_COLLECTION}/`.length);
  if (
    asString(source.id) !== sourceId
    || asString(source.direction) !== "outbound"
    || asString(source.source) !== IMPORT_SOURCE
    || asString(source.mailType) !== IMPORT_MAIL_TYPE
    || asString(source.trackingId) !== identity.trackingId
    || asString(source.externalTrackingId) !== identity.trackingId
    || asString(source.providerMessageIdHash).toLowerCase() !== identity.providerMessageIdHash
    || asString(source.deliveryState) !== "sent"
  ) {
    throw failedPrecondition("messageSourceRef is not the exact imported Gmail sent-only source");
  }
  if (
    asString(outbox.trackingId) !== identity.trackingId
    || asString(outbox.source) !== IMPORT_SOURCE
    || asString(outbox.mailType) !== IMPORT_MAIL_TYPE
    || asString(outbox.sourceRef) !== identity.messageSourceRef
    || asString(outbox.providerMessageIdHash).toLowerCase() !== identity.providerMessageIdHash
    || asString(outbox.deliveryState) !== "sent"
  ) {
    throw failedPrecondition("outboxRef is not the exact imported Gmail sent-only receipt");
  }
  for (const field of ["toHash", "fromHash", "subject", "sentAtIso"] as const) {
    const left = asString(source[field]);
    const right = asString(outbox[field]);
    if (!left || !right || left !== right) {
      throw failedPrecondition(`imported source/outbox ${field} identity is ambiguous`);
    }
  }
  const sourceOwner = asString(source.createdBy);
  const outboxOwner = asString(outbox.sentByUserId);
  if (!sourceOwner || !outboxOwner || sourceOwner !== outboxOwner) {
    throw failedPrecondition("imported source account ownership is missing or ambiguous");
  }
  return sourceOwner;
}

function assertProjectionConsistency(
  source: Record<string, unknown>,
  outbox: Record<string, unknown>,
  sourceProvenanceHash: string,
): StoredProjection | null {
  const sourceProjection = projectionFromRecord(source);
  const outboxProjection = projectionFromRecord(outbox);
  if (Boolean(sourceProjection) !== Boolean(outboxProjection)) {
    throw failedPrecondition("sent-only attribution projections are split across source and outbox");
  }
  if (!sourceProjection || !outboxProjection) {
    const legacyRouting = [routingState(source), routingState(outbox)];
    if (legacyRouting.some((state) =>
      Boolean(state.programId)
      || Boolean(state.canonicalProgramId)
      || Boolean(state.campaignId)
      || Boolean(state.programOwnerUid)
      || state.type === "program"
      || state.type === "campaign"
      || Boolean(state.lastSentOnlyAttributionAuditRef))) {
      throw failedPrecondition("imported sent-only record already has untracked program attribution");
    }
    return null;
  }
  if (stableHash(sourceProjection) !== stableHash(outboxProjection)) {
    throw failedPrecondition("sent-only attribution source/outbox projections disagree");
  }
  if (sourceProjection.sourceProvenanceHash !== sourceProvenanceHash) {
    throw failedPrecondition("immutable imported source provenance changed after attribution");
  }
  for (const record of [source, outbox]) {
    const state = routingState(record);
    if (state.lastSentOnlyAttributionAuditRef !== sourceProjection.auditRef) {
      throw failedPrecondition("sent-only attribution audit lineage is inconsistent");
    }
    if (sourceProjection.status === "active") {
      if (
        state.programId !== sourceProjection.programId
        || state.canonicalProgramId !== sourceProjection.programId
        || state.campaignId !== sourceProjection.campaignId
        || state.programOwnerUid !== sourceProjection.programOwnerUid
        || state.type !== (sourceProjection.campaignId ? "campaign" : "program")
      ) {
        throw failedPrecondition("sent-only attribution projection routing drifted from its audit");
      }
    } else if (
      state.programId
      || state.canonicalProgramId
      || state.campaignId
      || state.programOwnerUid
      || state.type === "program"
      || state.type === "campaign"
    ) {
      throw failedPrecondition("removed sent-only attribution still routes to a program");
    }
  }
  return sourceProjection;
}

type TransactionDocumentCache = Map<
  string,
  Promise<FirebaseFirestore.DocumentSnapshot>
>;

function transactionDocument(
  transaction: Transaction,
  path: string,
  cache: TransactionDocumentCache,
): Promise<FirebaseFirestore.DocumentSnapshot> {
  const existing = cache.get(path);
  if (existing) return existing;
  const pending = transaction.get(adminDb.doc(path));
  cache.set(path, pending);
  return pending;
}

function importReceiptPath(identity: ExactSentIdentity): string {
  return `${PROVIDER_UNIQUENESS_COLLECTION}/provider-${identity.providerMessageIdHash.slice(0, 40)}`;
}

function verifyCanonicalImportReceipt(
  snapshot: FirebaseFirestore.DocumentSnapshot,
  identity: ExactSentIdentity,
  source: Record<string, unknown>,
  outbox: Record<string, unknown>,
  sourceOwnerUid: string,
  sourceProvenanceHash: string,
): CanonicalImportReceiptEvidence {
  const expectedPath = importReceiptPath(identity);
  if (!snapshot.exists || snapshot.ref.path !== expectedPath) {
    throw failedPrecondition("canonical imported provider uniqueness receipt is missing");
  }
  const receipt = asRecord(snapshot.data());
  const recipientHash = asString(source.toHash);
  if (
    asString(receipt.schemaVersion) !== IMPORT_RECEIPT_SCHEMA_VERSION
    || asString(receipt.providerMessageIdHash).toLowerCase() !== identity.providerMessageIdHash.slice(0, 40)
    || !recipientHash
    || asString(outbox.toHash) !== recipientHash
    || asString(receipt.recipientHash) !== recipientHash
    || asString(receipt.trackingId) !== identity.trackingId
    || asString(receipt.outboxRef) !== identity.outboxRef
    || asString(receipt.messageSourceRef) !== identity.messageSourceRef
    || asString(receipt.source) !== IMPORT_SOURCE
    || asString(receipt.providerMessageId)
    || asString(receipt.providerMessageIdNormalized)
  ) {
    throw failedPrecondition("canonical imported provider uniqueness receipt is incomplete, foreign, or tampered");
  }
  const canonical = {
    schemaVersion: IMPORT_RECEIPT_SCHEMA_VERSION,
    receiptRef: expectedPath,
    providerMessageIdHash: identity.providerMessageIdHash.slice(0, 40),
    canonicalProviderMessageIdHash: identity.providerMessageIdHash,
    recipientHash,
    trackingId: identity.trackingId,
    outboxRef: identity.outboxRef,
    messageSourceRef: identity.messageSourceRef,
    source: IMPORT_SOURCE,
    accountUidHash: hashHex(sourceOwnerUid, 32),
    sourceProvenanceHash,
  } as const;
  return {
    ...canonical,
    receiptHash: stableHash(canonical),
  };
}

function recipientInboundLockPath(recipientHash: string): string {
  return `${RECIPIENT_INBOUND_LOCKS_COLLECTION}/${recipientHash}`;
}

function canonicalRecipientInboundLockAbsence(
  recipientHash: string,
): RecipientInboundLockAbsenceEvidence {
  const canonical = {
    schemaVersion: "mail-recipient-inbound-lock-absence-v1" as const,
    lockRef: recipientInboundLockPath(recipientHash),
    recipientHash,
    exists: false as const,
  };
  return { ...canonical, stateFingerprint: stableHash(canonical) };
}

function requireRecipientInboundLockAbsent(
  snapshot: FirebaseFirestore.DocumentSnapshot,
  recipientHash: string,
): RecipientInboundLockAbsenceEvidence {
  if (!/^[a-f0-9]{24}$/.test(recipientHash)) {
    throw failedPrecondition("imported recipient hash is missing or non-canonical");
  }
  const expectedPath = recipientInboundLockPath(recipientHash);
  if (snapshot.ref.path !== expectedPath) {
    throw failedPrecondition("recipient inbound lock reference is not exact");
  }
  if (!snapshot.exists) return canonicalRecipientInboundLockAbsence(recipientHash);
  const lock = asRecord(snapshot.data());
  const updatedAt = lock.updatedAt as { toMillis?: () => number } | undefined;
  if (
    asString(lock.id) !== recipientHash
    || asString(lock.schemaVersion) !== "mail-recipient-inbound-lock-v1"
    || asString(lock.recipientHash) !== recipientHash
    || lock.hasReply !== true
    || !Number.isFinite(Date.parse(asString(lock.lastReplyAtIso)))
    || !/^[a-f0-9]{32}$/.test(asString(lock.lastInboundMessageRefHash))
    || !/^[a-f0-9]{32}$/.test(asString(lock.conversationHash))
    || !(["reply_header", "tracking_id", "from_address", "headerless"] as string[])
      .includes(asString(lock.matchBasis))
    || typeof lock.ambiguous !== "boolean"
    || !Number.isFinite(Date.parse(asString(lock.updatedAtIso)))
    || typeof updatedAt?.toMillis !== "function"
  ) {
    throw failedPrecondition("recipient inbound lock is incomplete, foreign, or tampered");
  }
  throw failedPrecondition(
    "reclassification-required: recipient already has inbound conversation history",
  );
}

function projectionFromAuditItem(value: unknown, label: string): StoredProjection {
  const projection = projectionFromRecord({ sentOnlyAttribution: value });
  if (!projection) throw failedPrecondition(`${label} attribution projection is missing`);
  return projection;
}

function validateAuditReceiptEnvelope(
  audit: Record<string, unknown>,
  expectedAuditRef: string,
): {
  material: Record<string, unknown>;
  receiptHash: string;
  confirmationTokenHash: string;
} {
  const material = asRecord(audit.receiptMaterial);
  const receiptHash = asString(audit.receiptHash);
  const confirmationTokenHash = asString(audit.confirmationTokenHash);
  const claimRef = asString(material.claimRef);
  const items = Array.isArray(material.items) ? material.items : [];
  const counts = asRecord(material.counts);
  const actor = asRecord(material.actor);
  const createdAt = audit.createdAt as { toMillis?: () => number } | undefined;
  if (
    asString(material.schemaVersion) !== ATTRIBUTION_AUDIT_SCHEMA_VERSION
    || asString(material.receiptVersion) !== SENT_ONLY_ATTRIBUTION_CONFIRMATION_VERSION
    || asString(material.status) !== "completed"
    || asString(material.auditRef) !== expectedAuditRef
    || !new RegExp(`^${PREVIEW_CLAIMS_COLLECTION}\/[^/]+$`).test(claimRef)
    || !/^[a-f0-9]{64}$/.test(asString(material.requestFingerprint))
    || !/^[a-f0-9]{64}$/.test(asString(material.planFingerprint))
    || !Number.isFinite(Date.parse(asString(material.createdAtIso)))
    || !asString(actor.uid)
    || !asString(actor.role)
    || !asString(actor.team)
    || items.length < 1
    || Number(counts.identityCount) !== items.length
    || Number(counts.messageSourceProjections) !== items.length
    || Number(counts.outboxProjections) !== items.length
    || Number(counts.auditWrites) !== 1
    || Number(counts.mailSends) !== 0
    || Number(counts.coldmailWrites) !== 0
    || Number(counts.resultMailWrites) !== 0
    || !/^[a-f0-9]{64}$/.test(receiptHash)
    || stableHash(material) !== receiptHash
    || !/^[a-f0-9]{64}$/.test(confirmationTokenHash)
    || typeof createdAt?.toMillis !== "function"
  ) {
    throw failedPrecondition("sent-only attribution audit receipt is incomplete or tampered");
  }
  for (const field of [
    "schemaVersion",
    "receiptVersion",
    "status",
    "action",
    "actor",
    "target",
    "reason",
    "requestFingerprint",
    "planFingerprint",
    "claimRef",
    "auditRef",
    "items",
    "counts",
    "sideEffects",
    "createdAtIso",
  ]) {
    if (stableHash(audit[field]) !== stableHash(material[field])) {
      throw failedPrecondition("sent-only attribution audit envelope diverged from its canonical receipt");
    }
  }
  return { material, receiptHash, confirmationTokenHash };
}

function validateAuditReceiptClaim(
  claim: Record<string, unknown>,
  material: Record<string, unknown>,
  receiptHash: string,
  confirmationTokenHash: string,
): void {
  const actor = asRecord(material.actor);
  const counts = asRecord(material.counts);
  const tokenHash = asString(claim.tokenHash);
  const claimRef = asString(material.claimRef);
  const auditRef = asString(material.auditRef);
  const issuedAtIso = asString(claim.issuedAtIso);
  const expiresAtIso = asString(claim.expiresAtIso);
  const createdAt = claim.createdAt as { toMillis?: () => number } | undefined;
  const completedAt = claim.completedAt as { toMillis?: () => number } | undefined;
  if (
    asString(claim.schemaVersion) !== "sent-only-attribution-preview-claim-v1"
    || asString(claim.confirmationVersion) !== SENT_ONLY_ATTRIBUTION_CONFIRMATION_VERSION
    || asString(claim.status) !== "completed"
    || tokenHash !== confirmationTokenHash
    || claimRef !== `${PREVIEW_CLAIMS_COLLECTION}/claim-${tokenHash.slice(0, 40)}`
    || auditRef !== `${AUDIT_COLLECTION}/audit-${tokenHash.slice(0, 40)}`
    || asString(claim.auditRef) !== auditRef
    || asString(claim.receiptHash) !== receiptHash
    || asString(claim.action) !== asString(material.action)
    || stableHash(claim.target) !== stableHash(material.target)
    || asString(claim.requestFingerprint) !== asString(material.requestFingerprint)
    || asString(claim.planFingerprint) !== asString(material.planFingerprint)
    || Number(claim.identityCount) !== Number(counts.identityCount)
    || asString(claim.actorUidHash) !== hashHex(asString(actor.uid), 32)
    || asString(claim.actorRole) !== asString(actor.role)
    || asString(claim.actorTeamHash) !== hashHex(asString(actor.team), 24)
    || !Number.isFinite(Date.parse(issuedAtIso))
    || issuedAtIso !== asString(material.createdAtIso)
    || !Number.isFinite(Date.parse(expiresAtIso))
    || Date.parse(expiresAtIso) <= Date.parse(issuedAtIso)
    || typeof createdAt?.toMillis !== "function"
    || typeof completedAt?.toMillis !== "function"
  ) {
    throw failedPrecondition("sent-only attribution audit claim anchor is missing, foreign, or tampered");
  }
}

function exactAuditItem(
  material: Record<string, unknown>,
  identity: ExactSentIdentity,
): Record<string, unknown> {
  const items = Array.isArray(material.items) ? material.items.map(asRecord) : [];
  const matches = items.filter((item) =>
    asString(item.outboxRef) === identity.outboxRef
    && asString(item.messageSourceRef) === identity.messageSourceRef
    && asString(item.trackingIdHash) === hashHex(identity.trackingId, 32)
    && asString(item.providerMessageIdHash) === identity.providerMessageIdHash);
  if (matches.length !== 1) {
    throw failedPrecondition("sent-only attribution audit does not contain the exact imported identity once");
  }
  return matches[0];
}

async function verifyAuditReceiptLineage(
  transaction: Transaction,
  cache: TransactionDocumentCache,
  expectedProjection: StoredProjection,
  identity: ExactSentIdentity,
  importReceipt: CanonicalImportReceiptEvidence,
  sourceOwnerUid: string,
  visited: ReadonlySet<string> = new Set(),
  lineageAuditRefs?: Set<string>,
): Promise<PriorAuditReceiptEvidence> {
  if (visited.has(expectedProjection.auditRef)) {
    throw failedPrecondition("sent-only attribution audit lineage contains a cycle");
  }
  const nextVisited = new Set(visited).add(expectedProjection.auditRef);
  lineageAuditRefs?.add(expectedProjection.auditRef);
  const auditSnapshot = await transactionDocument(
    transaction,
    expectedProjection.auditRef,
    cache,
  );
  if (!auditSnapshot.exists) {
    throw failedPrecondition("prior sent-only attribution audit receipt is missing");
  }
  const audit = asRecord(auditSnapshot.data());
  const { material, receiptHash, confirmationTokenHash } = validateAuditReceiptEnvelope(
    audit,
    expectedProjection.auditRef,
  );
  const claimRef = asString(material.claimRef);
  const claimSnapshot = await transactionDocument(transaction, claimRef, cache);
  if (!claimSnapshot.exists) {
    throw failedPrecondition("prior sent-only attribution claim anchor is missing");
  }
  validateAuditReceiptClaim(
    asRecord(claimSnapshot.data()),
    material,
    receiptHash,
    confirmationTokenHash,
  );
  const item = exactAuditItem(material, identity);
  const after = projectionFromAuditItem(item.after, "audit after");
  if (
    stableHash(after) !== stableHash(expectedProjection)
    || asString(item.sourceProvenanceHash) !== expectedProjection.sourceProvenanceHash
    || stableHash(item.importReceipt) !== stableHash(importReceipt)
    || stableHash(item.recipientInboundLock) !== stableHash(
      canonicalRecipientInboundLockAbsence(importReceipt.recipientHash)
    )
    || asString(material.action) !== after.action
  ) {
    throw failedPrecondition("sent-only attribution audit target, version, or import receipt is inconsistent");
  }
  const before = item.before == null
    ? null
    : projectionFromAuditItem(item.before, "audit before");
  const target = asRecord(material.target);
  const expectedTargetProgramId = after.status === "active" ? after.programId : "";
  const expectedTargetCampaignId = after.status === "active" ? after.campaignId : "";
  const accountUid = after.programOwnerUid || before?.programOwnerUid || "";
  if (
    asString(target.programId) !== expectedTargetProgramId
    || asString(target.campaignId) !== expectedTargetCampaignId
    || !accountUid
    || accountUid !== sourceOwnerUid
    || after.sourceProvenanceHash !== importReceipt.sourceProvenanceHash
  ) {
    throw failedPrecondition("sent-only attribution audit target or account is foreign or mismatched");
  }

  let lineageDepth = 1;
  if (!before) {
    if (
      after.version !== 1
      || after.action !== "assign"
      || after.supersedesAuditRef
      || item.priorAuditReceipt != null
      || item.supersedesAuditRef != null
    ) {
      throw failedPrecondition("initial sent-only attribution audit lineage is incomplete");
    }
  } else {
    if (
      after.version !== before.version + 1
      || after.action === "assign"
      || after.supersedesAuditRef !== before.auditRef
      || asString(item.supersedesAuditRef) !== before.auditRef
      || before.sourceProvenanceHash !== after.sourceProvenanceHash
    ) {
      throw failedPrecondition("superseding sent-only attribution audit lineage is inconsistent");
    }
    const verifiedPrior = await verifyAuditReceiptLineage(
      transaction,
      cache,
      before,
      identity,
      importReceipt,
      sourceOwnerUid,
      nextVisited,
      lineageAuditRefs,
    );
    if (stableHash(item.priorAuditReceipt) !== stableHash(verifiedPrior)) {
      throw failedPrecondition("superseding sent-only attribution prior receipt hash is inconsistent");
    }
    lineageDepth = verifiedPrior.lineageDepth + 1;
  }

  return {
    schemaVersion: ATTRIBUTION_AUDIT_SCHEMA_VERSION,
    auditRef: expectedProjection.auditRef,
    receiptHash,
    version: after.version,
    status: after.status,
    programId: after.programId,
    campaignId: after.campaignId,
    accountUidHash: hashHex(accountUid, 32),
    lineageDepth,
  };
}

function exactQueryFingerprint(
  snapshots: FirebaseFirestore.QuerySnapshot[],
): string {
  return stableHash(snapshots.map((snapshot) => snapshot.docs.map((doc) => ({
    path: doc.ref.path,
    source: asString(doc.get("source")),
    mailType: asString(doc.get("mailType")),
    direction: asString(doc.get("direction")),
    trackingId: asString(doc.get("trackingId")),
    providerMessageIdHash: asString(doc.get("providerMessageIdHash")),
    matchedOutboundRef: asString(doc.get("matchedOutboundRef")),
  }))));
}

function requireUniqueExactQuery(
  snapshot: FirebaseFirestore.QuerySnapshot,
  exactPath: string,
  label: string,
): void {
  if (snapshot.size !== 1 || snapshot.docs[0]?.ref.path !== exactPath) {
    throw failedPrecondition(`${label} is missing or ambiguous`);
  }
}

function targetKey(programId: string, campaignId: string): string {
  return `${programId}|${campaignId}`;
}

function targetIdentityFingerprint(
  programId: string,
  campaignId: string,
  program: Record<string, unknown>,
  campaign: Record<string, unknown> | null,
  ownerUid: string,
): string {
  return stableHash({
    programId,
    campaignId,
    ownerUidHash: hashHex(ownerUid, 32),
    programIdentity: {
      id: asString(program.id),
      programId: resolveCanonicalProgramId(program.programId),
      canonicalProgramId: resolveCanonicalProgramId(program.canonicalProgramId),
      owners: mutationOwnerUids(program, { includeCreatedBy: true }),
    },
    campaignIdentity: campaign
      ? {
          id: asString(campaign.id),
          programId: resolveCanonicalProgramId(campaign.programId),
          canonicalProgramId: resolveCanonicalProgramId(campaign.canonicalProgramId),
          owners: mutationOwnerUids(campaign, { includeCreatedBy: true }),
        }
      : null,
  });
}

function validateTarget(
  auth: AuthContext,
  programId: string,
  campaignId: string,
  programSnapshot: FirebaseFirestore.DocumentSnapshot,
  campaignSnapshot: FirebaseFirestore.DocumentSnapshot | null,
): TargetEvidence {
  if (!programSnapshot.exists) throw notFound(`target program ${programId} was not found`);
  const program = asRecord(programSnapshot.data());
  const declaredProgramIds = [
    programSnapshot.id,
    asString(program.id),
    asString(program.programId),
    asString(program.canonicalProgramId),
  ].map((value) => resolveCanonicalProgramId(value)).filter(Boolean);
  if (declaredProgramIds.some((value) => value !== programId)) {
    throw failedPrecondition("target program identity is ambiguous or cross-program");
  }
  const programOwners = mutationOwnerUids(program, { includeCreatedBy: true });
  if (programOwners.length !== 1) {
    throw failedPrecondition("target program ownership is missing or ambiguous");
  }
  assertMutationOwner(
    { uid: auth.userId, role: auth.role },
    programOwners,
    "sent-only attribution target program",
  );
  let campaign: Record<string, unknown> | null = null;
  if (campaignId) {
    if (!campaignSnapshot?.exists) throw notFound(`target campaign ${campaignId} was not found`);
    campaign = asRecord(campaignSnapshot.data());
    if (asString(campaign.id) && asString(campaign.id) !== campaignId) {
      throw failedPrecondition("target campaign document identity is ambiguous");
    }
    const campaignProgramIds = [campaign.programId, campaign.canonicalProgramId]
      .map((value) => resolveCanonicalProgramId(value))
      .filter(Boolean);
    if (campaignProgramIds.length < 1 || campaignProgramIds.some((value) => value !== programId)) {
      throw failedPrecondition("target campaign does not belong to the exact selected program");
    }
    const campaignOwners = mutationOwnerUids(campaign, { includeCreatedBy: true });
    if (campaignOwners.length !== 1 || campaignOwners[0] !== programOwners[0]) {
      throw failedPrecondition("target campaign ownership is missing, ambiguous, or cross-account");
    }
    assertMutationOwner(
      { uid: auth.userId, role: auth.role },
      campaignOwners,
      "sent-only attribution target campaign",
    );
  }
  return {
    programId,
    campaignId,
    ownerUid: programOwners[0],
    stateFingerprint: targetIdentityFingerprint(
      programId,
      campaignId,
      program,
      campaign,
      programOwners[0],
    ),
  };
}

function assertActionTransition(
  request: NormalizedRequest,
  identity: ExactSentIdentity,
  current: StoredProjection | null,
): void {
  const currentVersion = current?.version ?? 0;
  if (identity.expectedAttributionVersion !== currentVersion) {
    throw failedPrecondition(
      `sent-only attribution version changed (expected ${identity.expectedAttributionVersion}, actual ${currentVersion})`,
    );
  }
  if (request.action === "assign") {
    if (current) throw failedPrecondition("existing attribution requires an explicit supersede action");
    return;
  }
  if (!current || identity.supersedesAuditRef !== current.auditRef) {
    throw failedPrecondition("superseding attribution must name the current exact audit receipt");
  }
  if (request.action === "remove") {
    if (current.status !== "active") throw failedPrecondition("only an active attribution can be removed");
    return;
  }
  if (
    current.status === "active"
    && current.programId === request.programId
    && current.campaignId === request.campaignId
  ) {
    throw failedPrecondition("supersede must correct the target instead of restating it");
  }
}

async function buildPlan(
  transaction: Transaction,
  auth: AuthContext,
  request: NormalizedRequest,
  decidedAtIso: string,
  auditRef: string,
): Promise<AttributionPlan> {
  const documentCache: TransactionDocumentCache = new Map();
  const provisional: Array<{
    identity: ExactSentIdentity;
    source: Record<string, unknown>;
    outbox: Record<string, unknown>;
    sourceOwnerUid: string;
    sourceProvenanceHash: string;
    before: StoredProjection | null;
    sourceStateFingerprint: string;
    outboxStateFingerprint: string;
    ambiguityFingerprint: string;
    importReceipt: CanonicalImportReceiptEvidence;
    priorAuditReceipt: PriorAuditReceiptEvidence | null;
    recipientInboundLock: RecipientInboundLockAbsenceEvidence;
  }> = [];

  for (const identity of request.identities) {
    const sourceRef = adminDb.doc(identity.messageSourceRef);
    const outboxRef = adminDb.doc(identity.outboxRef);
    const [
      sourceSnapshot,
      outboxSnapshot,
      importReceiptSnapshot,
      sourceHashQuery,
      outboxHashQuery,
      sourceTrackingQuery,
      outboxTrackingQuery,
      inboundMatchQuery,
    ] = await Promise.all([
      transaction.get(sourceRef),
      transaction.get(outboxRef),
      transactionDocument(transaction, importReceiptPath(identity), documentCache),
      transaction.get(adminDb.collection(MESSAGE_SOURCES_COLLECTION)
        .where("providerMessageIdHash", "==", identity.providerMessageIdHash).limit(3)),
      transaction.get(adminDb.collection(OUTBOX_COLLECTION)
        .where("providerMessageIdHash", "==", identity.providerMessageIdHash).limit(3)),
      transaction.get(adminDb.collection(MESSAGE_SOURCES_COLLECTION)
        .where("trackingId", "==", identity.trackingId).limit(3)),
      transaction.get(adminDb.collection(OUTBOX_COLLECTION)
        .where("trackingId", "==", identity.trackingId).limit(3)),
      transaction.get(adminDb.collection(MESSAGE_SOURCES_COLLECTION)
        .where("matchedOutboundRef", "==", identity.messageSourceRef).limit(2)),
    ]);
    if (!sourceSnapshot.exists) throw notFound(`message source ${identity.messageSourceRef} was not found`);
    if (!outboxSnapshot.exists) throw notFound(`outbox receipt ${identity.outboxRef} was not found`);
    requireUniqueExactQuery(sourceHashQuery, identity.messageSourceRef, "provider message source identity");
    requireUniqueExactQuery(outboxHashQuery, identity.outboxRef, "provider outbox identity");
    requireUniqueExactQuery(sourceTrackingQuery, identity.messageSourceRef, "tracking message source identity");
    requireUniqueExactQuery(outboxTrackingQuery, identity.outboxRef, "tracking outbox identity");
    const source = asRecord(sourceSnapshot.data());
    const outbox = asRecord(outboxSnapshot.data());
    assertNoReplyOrConversation(source, outbox, inboundMatchQuery.size);
    const sourceOwnerUid = assertImportedLedgerIdentity(identity, source, outbox);
    assertMutationOwner(
      { uid: auth.userId, role: auth.role },
      [sourceOwnerUid],
      "imported Gmail sent-only source",
    );
    const sourceProvenanceHash = stableHash(originalSourceProvenance(source, outbox));
    const before = assertProjectionConsistency(source, outbox, sourceProvenanceHash);
    assertActionTransition(request, identity, before);
    const importReceipt = verifyCanonicalImportReceipt(
      importReceiptSnapshot,
      identity,
      source,
      outbox,
      sourceOwnerUid,
      sourceProvenanceHash,
    );
    const recipientInboundLock = requireRecipientInboundLockAbsent(
      await transactionDocument(
        transaction,
        recipientInboundLockPath(importReceipt.recipientHash),
        documentCache,
      ),
      importReceipt.recipientHash,
    );
    const priorAuditReceipt = before
      ? await verifyAuditReceiptLineage(
          transaction,
          documentCache,
          before,
          identity,
          importReceipt,
          sourceOwnerUid,
        )
      : null;
    provisional.push({
      identity,
      source,
      outbox,
      sourceOwnerUid,
      sourceProvenanceHash,
      before,
      sourceStateFingerprint: stableHash({
        provenance: originalSourceProvenance(source, outbox).source,
        routing: routingState(source),
      }),
      outboxStateFingerprint: stableHash({
        provenance: originalSourceProvenance(source, outbox).outbox,
        routing: routingState(outbox),
      }),
      ambiguityFingerprint: exactQueryFingerprint([
        sourceHashQuery,
        outboxHashQuery,
        sourceTrackingQuery,
        outboxTrackingQuery,
        inboundMatchQuery,
      ]),
      importReceipt,
      priorAuditReceipt,
      recipientInboundLock,
    });
  }

  const targetPairs = new Map<string, { programId: string; campaignId: string }>();
  if (request.programId) {
    targetPairs.set(targetKey(request.programId, request.campaignId), {
      programId: request.programId,
      campaignId: request.campaignId,
    });
  }
  for (const item of provisional) {
    if (item.before?.status === "active") {
      targetPairs.set(targetKey(item.before.programId, item.before.campaignId), {
        programId: item.before.programId,
        campaignId: item.before.campaignId,
      });
    }
  }
  const pairs = [...targetPairs.values()].sort((left, right) =>
    targetKey(left.programId, left.campaignId).localeCompare(targetKey(right.programId, right.campaignId)));
  const programRefs = [...new Set(pairs.map((pair) => pair.programId))]
    .map((programId) => adminDb.collection("programs").doc(programId));
  const campaignRefs = [...new Set(pairs.map((pair) => pair.campaignId).filter(Boolean))]
    .map((campaignId) => adminDb.collection("campaigns").doc(campaignId));
  const [programSnapshots, campaignSnapshots] = await Promise.all([
    programRefs.length ? transaction.getAll(...programRefs) : Promise.resolve([]),
    campaignRefs.length ? transaction.getAll(...campaignRefs) : Promise.resolve([]),
  ]);
  const programs = new Map(programSnapshots.map((snapshot) => [snapshot.id, snapshot]));
  const campaigns = new Map(campaignSnapshots.map((snapshot) => [snapshot.id, snapshot]));
  const targetEvidence = pairs.map((pair) => {
    const programSnapshot = programs.get(pair.programId);
    if (!programSnapshot) {
      throw failedPrecondition(`target program ${pair.programId} could not be resolved`);
    }
    return validateTarget(
      auth,
      pair.programId,
      pair.campaignId,
      programSnapshot,
      pair.campaignId ? campaigns.get(pair.campaignId) ?? null : null,
    );
  });
  const targetEvidenceByKey = new Map(targetEvidence.map((evidence) => [
    targetKey(evidence.programId, evidence.campaignId),
    evidence,
  ]));
  const nextTarget = request.programId
    ? targetEvidenceByKey.get(targetKey(request.programId, request.campaignId))
    : undefined;
  if (request.action !== "remove" && !nextTarget) {
    throw failedPrecondition("target ownership evidence was not resolved");
  }
  for (const item of provisional) {
    if (nextTarget && nextTarget.ownerUid !== item.sourceOwnerUid) {
      throw failedPrecondition("selected attribution target is cross-account with the imported source");
    }
    if (item.before?.status === "active") {
      const previousTarget = targetEvidenceByKey.get(
        targetKey(item.before.programId, item.before.campaignId),
      );
      if (!previousTarget || previousTarget.ownerUid !== item.sourceOwnerUid) {
        throw failedPrecondition("existing attribution target is cross-account with the imported source");
      }
    }
  }

  const items: PlannedItem[] = provisional.map((item) => {
    const beforeVersion = item.before?.version ?? 0;
    const after: StoredProjection = {
      schemaVersion: SENT_ONLY_ATTRIBUTION_PROJECTION_VERSION,
      version: beforeVersion + 1,
      status: request.action === "remove" ? "removed" : "active",
      action: request.action,
      programId: request.action === "remove" ? "" : request.programId,
      campaignId: request.action === "remove" ? "" : request.campaignId,
      programOwnerUid: request.action === "remove" ? "" : nextTarget?.ownerUid ?? "",
      auditRef,
      supersedesAuditRef: item.before?.auditRef ?? "",
      sourceProvenanceHash: item.sourceProvenanceHash,
      decidedAtIso,
    };
    return {
      identity: item.identity,
      sourceProvenanceHash: item.sourceProvenanceHash,
      before: item.before,
      after,
      sourceStateFingerprint: item.sourceStateFingerprint,
      outboxStateFingerprint: item.outboxStateFingerprint,
      ambiguityFingerprint: item.ambiguityFingerprint,
      importReceipt: item.importReceipt,
      priorAuditReceipt: item.priorAuditReceipt,
      recipientInboundLock: item.recipientInboundLock,
    };
  });
  const requestHash = requestFingerprint(auth, request);
  const planMaterial = {
    confirmationVersion: SENT_ONLY_ATTRIBUTION_CONFIRMATION_VERSION,
    requestFingerprint: requestHash,
    auditRef,
    decidedAtIso,
    action: request.action,
    programId: request.programId,
    campaignId: request.campaignId,
    reasonHash: hashHex(request.reason, 64),
    targets: targetEvidence.map((evidence) => ({
      programId: evidence.programId,
      campaignId: evidence.campaignId,
      ownerUidHash: hashHex(evidence.ownerUid, 32),
      stateFingerprint: evidence.stateFingerprint,
    })),
    items: items.map((item) => ({
      identity: item.identity,
      sourceProvenanceHash: item.sourceProvenanceHash,
      before: item.before,
      after: item.after,
      sourceStateFingerprint: item.sourceStateFingerprint,
      outboxStateFingerprint: item.outboxStateFingerprint,
      ambiguityFingerprint: item.ambiguityFingerprint,
      importReceipt: item.importReceipt,
      priorAuditReceipt: item.priorAuditReceipt,
      recipientInboundLock: item.recipientInboundLock,
    })),
  };
  return {
    requestFingerprint: requestHash,
    planFingerprint: stableHash(planMaterial),
    action: request.action,
    programId: request.programId,
    campaignId: request.campaignId,
    reason: request.reason,
    items,
    targetEvidence,
  };
}

function projectionPatch(after: StoredProjection): Record<string, unknown> {
  const active = after.status === "active";
  return {
    sentOnlyAttribution: after,
    sentOnlyAttributionStatus: after.status,
    sentOnlyAttributionUpdatedAtIso: after.decidedAtIso,
    lastSentOnlyAttributionAuditRef: after.auditRef,
    programId: active ? after.programId : FieldValue.delete(),
    canonicalProgramId: active ? after.programId : FieldValue.delete(),
    campaignId: active && after.campaignId ? after.campaignId : FieldValue.delete(),
    programOwnerUid: active ? after.programOwnerUid : FieldValue.delete(),
    type: active ? (after.campaignId ? "campaign" : "program") : FieldValue.delete(),
    programTitle: FieldValue.delete(),
    campaignTitle: FieldValue.delete(),
  };
}

function publicPlan(plan: AttributionPlan) {
  return {
    action: plan.action,
    programId: plan.programId || null,
    campaignId: plan.campaignId || null,
    identityCount: plan.items.length,
    projectionWriteCount: plan.items.length * 2,
    rows: plan.items.map((item) => ({
      outboxRef: item.identity.outboxRef,
      messageSourceRef: item.identity.messageSourceRef,
      trackingIdMasked: item.identity.trackingId.length > 10
        ? `${item.identity.trackingId.slice(0, 6)}…${item.identity.trackingId.slice(-4)}`
        : `${item.identity.trackingId.slice(0, 3)}…`,
      providerMessageIdHashPrefix: item.identity.providerMessageIdHash.slice(0, 16),
      versionBefore: item.before?.version ?? 0,
      versionAfter: item.after.version,
      statusAfter: item.after.status,
      supersedesAuditRef: item.after.supersedesAuditRef || null,
      sourceProvenanceHash: item.sourceProvenanceHash,
    })),
  };
}

function receiptMaterialForPlan(
  auth: AuthContext,
  plan: AttributionPlan,
  claimRef: string,
  auditRef: string,
  createdAtIso: string,
): Record<string, unknown> {
  return {
    schemaVersion: ATTRIBUTION_AUDIT_SCHEMA_VERSION,
    receiptVersion: SENT_ONLY_ATTRIBUTION_CONFIRMATION_VERSION,
    status: "completed",
    action: plan.action,
    actor: { uid: auth.userId, role: auth.role, team: auth.team },
    target: {
      programId: plan.programId || null,
      campaignId: plan.campaignId || null,
    },
    reason: plan.reason,
    requestFingerprint: plan.requestFingerprint,
    planFingerprint: plan.planFingerprint,
    claimRef,
    auditRef,
    items: plan.items.map((item) => ({
      outboxRef: item.identity.outboxRef,
      messageSourceRef: item.identity.messageSourceRef,
      trackingIdHash: hashHex(item.identity.trackingId, 32),
      providerMessageIdHash: item.identity.providerMessageIdHash,
      sourceProvenanceHash: item.sourceProvenanceHash,
      before: item.before,
      after: item.after,
      supersedesAuditRef: item.before?.auditRef ?? null,
      importReceipt: item.importReceipt,
      priorAuditReceipt: item.priorAuditReceipt,
      recipientInboundLock: item.recipientInboundLock,
    })),
    counts: {
      identityCount: plan.items.length,
      messageSourceProjections: plan.items.length,
      outboxProjections: plan.items.length,
      auditWrites: 1,
      mailSends: 0,
      coldmailWrites: 0,
      resultMailWrites: 0,
    },
    sideEffects: [
      MESSAGE_SOURCES_COLLECTION,
      OUTBOX_COLLECTION,
      AUDIT_COLLECTION,
      `${PREVIEW_CLAIMS_COLLECTION}:status`,
    ],
    createdAtIso,
  };
}

function validateClaim(
  claim: Record<string, unknown>,
  auth: AuthContext,
  requestHash: string,
  token: string,
): void {
  if (
    asString(claim.schemaVersion) !== "sent-only-attribution-preview-claim-v1"
    || asString(claim.confirmationVersion) !== SENT_ONLY_ATTRIBUTION_CONFIRMATION_VERSION
    || asString(claim.actorUidHash) !== hashHex(auth.userId, 32)
    || asString(claim.actorRole) !== auth.role
    || asString(claim.actorTeamHash) !== hashHex(auth.team, 24)
    || asString(claim.requestFingerprint) !== requestHash
    || asString(claim.tokenHash) !== hashHex(token, 64)
  ) {
    throw failedPrecondition("sent-only attribution confirmation token does not match this actor or request");
  }
}

function validateCompletedReceipt(
  claim: Record<string, unknown>,
  audit: Record<string, unknown>,
  claimRef: string,
  auditRef: string,
): { receiptHash: string; identityCount: number; receiptMaterial: Record<string, unknown> } {
  const {
    material: receiptMaterial,
    receiptHash,
    confirmationTokenHash,
  } = validateAuditReceiptEnvelope(audit, auditRef);
  const counts = asRecord(receiptMaterial.counts);
  const identityCount = Number(counts.identityCount);
  if (
    asString(receiptMaterial.claimRef) !== claimRef
    || asString(receiptMaterial.auditRef) !== auditRef
    || !Number.isInteger(identityCount)
    || identityCount < 1
  ) {
    throw failedPrecondition("completed sent-only attribution receipt is inconsistent");
  }
  validateAuditReceiptClaim(
    claim,
    receiptMaterial,
    receiptHash,
    confirmationTokenHash,
  );
  return { receiptHash, identityCount, receiptMaterial };
}

async function verifyCompletedReplayLineage(
  transaction: Transaction,
  auth: AuthContext,
  request: NormalizedRequest,
  auditRef: string,
  receiptMaterial: Record<string, unknown>,
  cache: TransactionDocumentCache,
): Promise<void> {
  const receiptTarget = asRecord(receiptMaterial.target);
  const receiptItems = Array.isArray(receiptMaterial.items)
    ? receiptMaterial.items
    : [];
  if (
    asString(receiptMaterial.action) !== request.action
    || asString(receiptTarget.programId) !== request.programId
    || asString(receiptTarget.campaignId) !== request.campaignId
    || receiptItems.length !== request.identities.length
  ) {
    throw failedPrecondition(
      "completed sent-only attribution receipt is foreign to the original request",
    );
  }
  for (const identity of request.identities) {
    const [sourceSnapshot, outboxSnapshot, importReceiptSnapshot] = await Promise.all([
      transactionDocument(transaction, identity.messageSourceRef, cache),
      transactionDocument(transaction, identity.outboxRef, cache),
      transactionDocument(transaction, importReceiptPath(identity), cache),
    ]);
    if (!sourceSnapshot.exists || !outboxSnapshot.exists) {
      throw failedPrecondition("completed sent-only attribution ledger projection is missing");
    }
    const source = asRecord(sourceSnapshot.data());
    const outbox = asRecord(outboxSnapshot.data());
    const sourceOwnerUid = assertImportedLedgerIdentity(identity, source, outbox);
    assertMutationOwner(
      { uid: auth.userId, role: auth.role },
      [sourceOwnerUid],
      "imported Gmail sent-only source",
    );
    const sourceProvenanceHash = stableHash(originalSourceProvenance(source, outbox));
    const current = assertProjectionConsistency(source, outbox, sourceProvenanceHash);
    if (!current) {
      throw failedPrecondition("completed sent-only attribution projection is missing");
    }
    const importReceipt = verifyCanonicalImportReceipt(
      importReceiptSnapshot,
      identity,
      source,
      outbox,
      sourceOwnerUid,
      sourceProvenanceHash,
    );
    const originalItem = exactAuditItem(receiptMaterial, identity);
    const originalBefore = originalItem.before == null
      ? null
      : projectionFromAuditItem(originalItem.before, "completed audit before");
    const originalAfter = projectionFromAuditItem(
      originalItem.after,
      "completed audit after",
    );
    if (
      (originalBefore?.version ?? 0) !== identity.expectedAttributionVersion
      || (originalBefore?.auditRef ?? "") !== identity.supersedesAuditRef
      || originalAfter.auditRef !== auditRef
      || originalAfter.version !== identity.expectedAttributionVersion + 1
      || originalAfter.action !== request.action
      || originalAfter.status !== (request.action === "remove" ? "removed" : "active")
      || originalAfter.programId !== request.programId
      || originalAfter.campaignId !== request.campaignId
      || originalAfter.supersedesAuditRef !== identity.supersedesAuditRef
      || originalAfter.sourceProvenanceHash !== sourceProvenanceHash
      || asString(originalItem.sourceProvenanceHash) !== sourceProvenanceHash
      || stableHash(originalItem.importReceipt) !== stableHash(importReceipt)
    ) {
      throw failedPrecondition(
        "completed sent-only attribution receipt does not match its original projection",
      );
    }
    const lineageAuditRefs = new Set<string>();
    await verifyAuditReceiptLineage(
      transaction,
      cache,
      current,
      identity,
      importReceipt,
      sourceOwnerUid,
      new Set(),
      lineageAuditRefs,
    );
    if (!lineageAuditRefs.has(auditRef)) {
      throw failedPrecondition(
        "completed sent-only attribution receipt is not in the current verified lineage",
      );
    }
  }
}

export async function attributeImportedSentOnlyHistory(
  callableRequest: CallableRequestShape,
) {
  const auth = assertNonGuestAuth(
    callableRequest,
    "mail_external_sent_only_attribution.run",
    WRITE_ROLES,
  );
  const data = asRecord(callableRequest.data);
  const request = normalizeRequest(data);
  const dryRun = data.dryRun !== false;
  const requestHash = requestFingerprint(auth, request);

  if (dryRun) {
    const token = previewToken();
    const claimRef = previewClaimRef(token);
    const auditRef = auditRefForToken(token);
    const issuedAtIso = new Date().toISOString();
    const expiresAtIso = new Date(Date.parse(issuedAtIso) + PREVIEW_TTL_MS).toISOString();
    const plan = await adminDb.runTransaction(async (transaction) => {
      const resolved = await buildPlan(
        transaction,
        auth,
        request,
        issuedAtIso,
        auditRef.path,
      );
      transaction.create(claimRef, {
        schemaVersion: "sent-only-attribution-preview-claim-v1",
        confirmationVersion: SENT_ONLY_ATTRIBUTION_CONFIRMATION_VERSION,
        status: "pending",
        tokenHash: hashHex(token, 64),
        actorUidHash: hashHex(auth.userId, 32),
        actorRole: auth.role,
        actorTeamHash: hashHex(auth.team, 24),
        requestFingerprint: requestHash,
        planFingerprint: resolved.planFingerprint,
        action: resolved.action,
        target: {
          programId: resolved.programId || null,
          campaignId: resolved.campaignId || null,
        },
        identityCount: resolved.items.length,
        auditRef: auditRef.path,
        issuedAtIso,
        expiresAtIso,
        createdAt: FieldValue.serverTimestamp(),
      });
      return resolved;
    });
    return {
      ok: true,
      dryRun: true,
      mode: "dry_run",
      confirmationToken: token,
      confirmationVersion: SENT_ONLY_ATTRIBUTION_CONFIRMATION_VERSION,
      expiresAtIso,
      planFingerprint: plan.planFingerprint,
      ...publicPlan(plan),
      pendingWriteCount: plan.items.length * 2,
      previewStateful: true,
      sideEffects: ["preview_claim"],
      businessWritesApplied: false,
      idempotentReplay: false,
    };
  }

  if (data.actual !== true || data.confirm !== true) {
    throw invalidArgument("actual:true and confirm:true are required after dry-run");
  }
  const confirmationVersion = asString(data.confirmationVersion);
  if (confirmationVersion !== SENT_ONLY_ATTRIBUTION_CONFIRMATION_VERSION) {
    throw failedPrecondition("sent-only attribution confirmation version mismatch");
  }
  const token = asString(data.confirmationToken);
  if (!validPreviewToken(token)) {
    throw failedPrecondition("a valid sent-only attribution confirmation token is required");
  }
  const claimRef = previewClaimRef(token);
  const auditRef = auditRefForToken(token);
  const applied = await adminDb.runTransaction(async (transaction) => {
    const [claimSnapshot, auditSnapshot] = await Promise.all([
      transaction.get(claimRef),
      transaction.get(auditRef),
    ]);
    const replayDocumentCache: TransactionDocumentCache = new Map([
      [claimRef.path, Promise.resolve(claimSnapshot)],
      [auditRef.path, Promise.resolve(auditSnapshot)],
    ]);
    if (!claimSnapshot.exists) throw failedPrecondition("sent-only attribution preview claim was not found");
    const claim = asRecord(claimSnapshot.data());
    validateClaim(claim, auth, requestHash, token);
    if (asString(claim.auditRef) !== auditRef.path) {
      throw failedPrecondition("sent-only attribution audit target does not match the preview");
    }
    if (asString(claim.status) === "completed") {
      if (!auditSnapshot.exists) throw failedPrecondition("completed attribution claim has no audit receipt");
      const replay = validateCompletedReceipt(
        claim,
        asRecord(auditSnapshot.data()),
        claimRef.path,
        auditRef.path,
      );
      await verifyCompletedReplayLineage(
        transaction,
        auth,
        request,
        auditRef.path,
        replay.receiptMaterial,
        replayDocumentCache,
      );
      return {
        idempotentReplay: true,
        receiptHash: replay.receiptHash,
        identityCount: replay.identityCount,
        plan: null as AttributionPlan | null,
      };
    }
    if (asString(claim.status) !== "pending" || auditSnapshot.exists) {
      throw failedPrecondition("sent-only attribution preview claim is not pending");
    }
    const expiresAt = Date.parse(asString(claim.expiresAtIso));
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
      throw failedPrecondition("sent-only attribution confirmation token expired");
    }
    const issuedAtIso = asString(claim.issuedAtIso);
    if (!Number.isFinite(Date.parse(issuedAtIso))) {
      throw failedPrecondition("sent-only attribution preview issuance is invalid");
    }
    const plan = await buildPlan(
      transaction,
      auth,
      request,
      issuedAtIso,
      auditRef.path,
    );
    if (
      plan.requestFingerprint !== requestHash
      || plan.planFingerprint !== asString(claim.planFingerprint)
      || plan.items.length !== Number(claim.identityCount)
    ) {
      throw failedPrecondition("sent-only attribution source, target, owner, or version changed after preview");
    }
    for (const item of plan.items) {
      const patch = projectionPatch(item.after);
      transaction.set(adminDb.doc(item.identity.messageSourceRef), patch, { merge: true });
      transaction.set(adminDb.doc(item.identity.outboxRef), patch, { merge: true });
    }
    const receiptMaterial = receiptMaterialForPlan(
      auth,
      plan,
      claimRef.path,
      auditRef.path,
      issuedAtIso,
    );
    const receiptHash = stableHash(receiptMaterial);
    transaction.create(auditRef, {
      ...receiptMaterial,
      receiptMaterial,
      receiptHash,
      confirmationTokenHash: hashHex(token, 64),
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.update(claimRef, {
      status: "completed",
      auditRef: auditRef.path,
      receiptHash,
      completedAt: FieldValue.serverTimestamp(),
    });
    return {
      idempotentReplay: false,
      receiptHash,
      identityCount: plan.items.length,
      plan,
    };
  });

  return {
    ok: true,
    dryRun: false,
    mode: "actual",
    confirmationVersion: SENT_ONLY_ATTRIBUTION_CONFIRMATION_VERSION,
    action: request.action,
    programId: request.programId || null,
    campaignId: request.campaignId || null,
    identityCount: applied.identityCount,
    projectionWriteCount: applied.idempotentReplay ? 0 : applied.identityCount * 2,
    pendingWriteCount: 0,
    auditRef: auditRef.path,
    receiptHash: applied.receiptHash,
    rows: applied.plan ? publicPlan(applied.plan).rows : [],
    sideEffects: applied.idempotentReplay
      ? []
      : [
          MESSAGE_SOURCES_COLLECTION,
          OUTBOX_COLLECTION,
          AUDIT_COLLECTION,
          `${PREVIEW_CLAIMS_COLLECTION}:status`,
        ],
    businessWritesApplied: !applied.idempotentReplay,
    idempotentReplay: applied.idempotentReplay,
    mailSent: false,
  };
}
