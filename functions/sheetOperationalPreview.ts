import { createHash, randomBytes } from "node:crypto";
import {
  FieldValue,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString, type AuthContext } from "./shared";

const PREVIEW_COLLECTION = "sheet_source_operation_previews";
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const APPLY_LEASE_MS = 5 * 60 * 1000;
const APPLY_RECOVERY_RETENTION_MS = 24 * 60 * 60 * 1000;
const FAILED_RETENTION_MS = 24 * 60 * 60 * 1000;
const COMPLETED_REPLAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type PreviewStatus = "pending" | "applying" | "completed" | "failed";

export interface SheetOperationPreviewIdentity {
  tokenVersion: string;
  operation: string;
  sourceKey: string;
  sourceId: string;
  actor: Pick<AuthContext, "userId" | "role" | "team">;
}

export interface SheetOperationPreviewClaim {
  previewToken: string;
  previewExpiresAtIso: string;
  sourceVersion: number;
  originFingerprint: string;
  planFingerprint: string;
  summary: Record<string, unknown>;
}

export async function createSheetOperationPreview(input: SheetOperationPreviewIdentity & {
  sourceVersion: number;
  originFingerprint: string;
  planFingerprint: string;
  summary: Record<string, unknown>;
  nowIso?: string;
  db?: Firestore;
}): Promise<SheetOperationPreviewClaim> {
  const nowMs = effectiveNowMs(input.nowIso);
  const issuedAtIso = new Date(nowMs).toISOString();
  const previewExpiresAtIso = new Date(nowMs + PREVIEW_TTL_MS).toISOString();
  const previewToken = capabilityToken(input.tokenVersion);
  const sourceVersion = nonNegativeInteger(input.sourceVersion, "sourceVersion");
  const originFingerprint = requiredFingerprint(input.originFingerprint, "originFingerprint");
  const planFingerprint = requiredFingerprint(input.planFingerprint, "planFingerprint");
  const summary = maskedSummary(input.summary);
  await previewDocument(previewToken, input.db).create({
    schemaVersion: "sheet-source-operation-preview-v1",
    tokenVersion: requiredTokenVersion(input.tokenVersion),
    operation: requiredLabel(input.operation, "operation"),
    status: "pending" satisfies PreviewStatus,
    actorHash: actorHash(input.actor),
    sourceKey: requiredLabel(input.sourceKey, "sourceKey"),
    sourceId: requiredLabel(input.sourceId, "sourceId"),
    sourceVersion,
    originFingerprint,
    planFingerprint,
    summary,
    issuedAtIso,
    expiresAtIso: previewExpiresAtIso,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return {
    previewToken,
    previewExpiresAtIso,
    sourceVersion,
    originFingerprint,
    planFingerprint,
    summary,
  };
}

export async function inspectSheetOperationPreview(
  input: SheetOperationPreviewIdentity & { previewToken: unknown; nowIso?: string; db?: Firestore },
): Promise<SheetOperationPreviewClaim & {
  status: PreviewStatus;
  completedResult: Record<string, unknown> | null;
}> {
  const { previewToken } = parseCapability(input.previewToken, input.tokenVersion);
  const snapshot = await previewDocument(previewToken, input.db).get();
  const claim = validateClaim(snapshot.exists ? snapshot.data() : null, input, effectiveNowMs(input.nowIso));
  return publicClaim(previewToken, claim);
}

export async function beginSheetOperationApply(input: SheetOperationPreviewIdentity & {
  previewToken: unknown;
  sourceVersion: number;
  originFingerprint: string;
  planFingerprint: string;
  nowIso?: string;
  db?: Firestore;
}): Promise<
  | { kind: "apply"; previewToken: string; resumed: boolean }
  | { kind: "replay"; previewToken: string; result: Record<string, unknown> }
> {
  const previewToken = requiredPreviewCapability(input.previewToken, input.tokenVersion);
  const sourceVersion = nonNegativeInteger(input.sourceVersion, "sourceVersion");
  const originFingerprint = requiredFingerprint(input.originFingerprint, "originFingerprint");
  const planFingerprint = requiredFingerprint(input.planFingerprint, "planFingerprint");
  const nowMs = effectiveNowMs(input.nowIso);
  const nowIso = new Date(nowMs).toISOString();
  const attemptId = randomBytes(16).toString("hex");
  const executionToken = `${previewToken}.${attemptId}`;
  const applyingAttemptHash = executionAttemptHash(attemptId);
  const db = input.db ?? adminDb;
  return db.runTransaction(async (transaction) => {
    const ref = previewDocument(previewToken, db);
    const snapshot = await transaction.get(ref);
    const claim = validateClaim(snapshot.exists ? snapshot.data() : null, input, nowMs);
    const status = previewStatus(claim.status);
    if (status === "completed") {
      return {
        kind: "replay" as const,
        previewToken,
        result: asRecord(claim.completedResult),
      };
    }
    if (status !== "pending" && status !== "applying" && status !== "failed") {
      throw previewMismatch();
    }
    if (
      nonNegativeInteger(claim.sourceVersion, "sourceVersion") !== sourceVersion ||
      asString(claim.originFingerprint) !== originFingerprint ||
      asString(claim.planFingerprint) !== planFingerprint
    ) {
      throw previewDrift();
    }
    if (status === "applying") {
      if (applyingLeaseExpiresAtMs(claim) > nowMs) throw previewApplying();
    }
    transaction.update(ref, {
      status: "applying" satisfies PreviewStatus,
      applyingAtIso: status === "applying" ? asString(claim.applyingAtIso) : nowIso,
      attemptStartedAtIso: nowIso,
      applyingAttemptHash,
      applyLeaseExpiresAtIso: new Date(nowMs + APPLY_LEASE_MS).toISOString(),
      applyingRetentionExpiresAtIso: new Date(nowMs + APPLY_RECOVERY_RETENTION_MS).toISOString(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      kind: "apply" as const,
      previewToken: executionToken,
      resumed: status !== "pending",
    };
  });
}

export async function completeSheetOperationApply(input: {
  previewToken: string;
  tokenVersion: string;
  result: Record<string, unknown>;
  nowIso?: string;
  db?: Firestore;
}): Promise<void> {
  const capability = requiredExecutionCapability(input.previewToken, input.tokenVersion);
  const nowMs = effectiveNowMs(input.nowIso);
  const nowIso = new Date(nowMs).toISOString();
  const db = input.db ?? adminDb;
  await db.runTransaction(async (transaction) => {
    const ref = previewDocument(capability.previewToken, db);
    const snapshot = await transaction.get(ref);
    const claim = asRecord(snapshot.data());
    if (!snapshot.exists || asString(claim.tokenVersion) !== input.tokenVersion) throw previewMismatch();
    if (previewStatus(claim.status) === "completed") {
      if (
        asString(claim.completedAttemptHash) !== executionAttemptHash(capability.attemptId) ||
        completedRetentionExpiresAtMs(claim) <= nowMs
      ) {
        throw previewMismatch();
      }
      return;
    }
    if (previewStatus(claim.status) !== "applying") throw previewMismatch();
    assertApplyingAttempt(claim, capability.attemptId, nowMs);
    transaction.update(ref, {
      status: "completed" satisfies PreviewStatus,
      completedResult: maskedSummary(input.result),
      completedAttemptHash: executionAttemptHash(capability.attemptId),
      completedAtIso: nowIso,
      completedRetentionExpiresAtIso: new Date(nowMs + COMPLETED_REPLAY_RETENTION_MS).toISOString(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

export function sheetOperationPreviewReference(input: {
  previewToken: unknown;
  tokenVersion: string;
  db?: Firestore;
}) {
  const { previewToken } = parseCapability(input.previewToken, input.tokenVersion);
  return previewDocument(previewToken, input.db);
}

export function completeSheetOperationApplyInTransaction(
  input: SheetOperationPreviewIdentity & {
    transaction: Transaction;
    snapshot: DocumentSnapshot;
    previewToken: unknown;
    result: Record<string, unknown>;
    nowIso?: string;
  },
): void {
  const capability = requiredExecutionCapability(input.previewToken, input.tokenVersion);
  const nowMs = effectiveNowMs(input.nowIso);
  const expectedId = previewDocumentId(capability.previewToken);
  const expectedPath = `${PREVIEW_COLLECTION}/${expectedId}`;
  if (
    input.snapshot.id !== expectedId ||
    input.snapshot.ref.id !== expectedId ||
    input.snapshot.ref.path !== expectedPath
  ) {
    throw previewMismatch();
  }
  const claim = validateClaim(
    input.snapshot.exists ? input.snapshot.data() : null,
    input,
    nowMs,
  );
  if (previewStatus(claim.status) !== "applying") throw previewMismatch();
  assertApplyingAttempt(claim, capability.attemptId, nowMs);
  input.transaction.update(input.snapshot.ref, {
    status: "completed" satisfies PreviewStatus,
    completedResult: maskedSummary(input.result),
    completedAttemptHash: executionAttemptHash(capability.attemptId),
    completedAtIso: new Date(nowMs).toISOString(),
    completedRetentionExpiresAtIso: new Date(nowMs + COMPLETED_REPLAY_RETENTION_MS).toISOString(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function failSheetOperationApply(input: {
  previewToken: string;
  tokenVersion: string;
  failureCode?: string;
  nowIso?: string;
  db?: Firestore;
}): Promise<void> {
  const capability = requiredExecutionCapability(input.previewToken, input.tokenVersion);
  const nowMs = effectiveNowMs(input.nowIso);
  const nowIso = new Date(nowMs).toISOString();
  const db = input.db ?? adminDb;
  const ref = previewDocument(capability.previewToken, db);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const claim = asRecord(snapshot.data());
    if (!snapshot.exists || asString(claim.tokenVersion) !== input.tokenVersion) return;
    if (previewStatus(claim.status) !== "applying") return;
    if (
      asString(claim.applyingAttemptHash) !== executionAttemptHash(capability.attemptId) ||
      applyingRetentionExpiresAtMs(claim) <= nowMs
    ) {
      return;
    }
    transaction.update(ref, {
      status: "failed" satisfies PreviewStatus,
      failureCode: safeFailureCode(input.failureCode),
      failedAtIso: nowIso,
      failedRetentionExpiresAtIso: new Date(nowMs + FAILED_RETENTION_MS).toISOString(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

export function sheetOperationFingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function publicClaim(previewToken: string, claim: Record<string, unknown>) {
  return {
    previewToken,
    previewExpiresAtIso: asString(claim.expiresAtIso),
    sourceVersion: nonNegativeInteger(claim.sourceVersion, "sourceVersion"),
    originFingerprint: requiredFingerprint(claim.originFingerprint, "originFingerprint"),
    planFingerprint: requiredFingerprint(claim.planFingerprint, "planFingerprint"),
    summary: maskedSummary(asRecord(claim.summary)),
    status: previewStatus(claim.status),
    completedResult: previewStatus(claim.status) === "completed"
      ? maskedSummary(asRecord(claim.completedResult))
      : null,
  };
}

function validateClaim(
  value: unknown,
  identity: SheetOperationPreviewIdentity,
  nowMs: number,
): Record<string, unknown> {
  const claim = asRecord(value);
  const status = previewStatus(claim.status);
  if (
    claim.schemaVersion !== "sheet-source-operation-preview-v1" ||
    asString(claim.tokenVersion) !== identity.tokenVersion ||
    asString(claim.operation) !== identity.operation ||
    asString(claim.actorHash) !== actorHash(identity.actor) ||
    asString(claim.sourceKey) !== identity.sourceKey ||
    asString(claim.sourceId) !== identity.sourceId ||
    !status
  ) {
    throw previewMismatch();
  }
  if (status === "pending" && previewStartExpiresAtMs(claim) <= nowMs) throw previewMismatch();
  if (status === "applying" && applyingRetentionExpiresAtMs(claim) <= nowMs) throw previewMismatch();
  if (status === "completed" && completedRetentionExpiresAtMs(claim) <= nowMs) throw previewMismatch();
  if (status === "failed" && failedRetentionExpiresAtMs(claim) <= nowMs) throw previewMismatch();
  return claim;
}

function previewDocument(previewToken: string, database?: Firestore) {
  return (database ?? adminDb).collection(PREVIEW_COLLECTION).doc(previewDocumentId(previewToken));
}

function previewDocumentId(previewToken: string): string {
  return `claim-${createHash("sha256").update(previewToken).digest("hex").slice(0, 40)}`;
}

function capabilityToken(version: string): string {
  return `${requiredTokenVersion(version)}.${randomBytes(16).toString("hex")}`;
}

function parseCapability(value: unknown, version: string): {
  previewToken: string;
  attemptId: string | null;
} {
  const token = asString(value);
  const tokenVersion = requiredTokenVersion(version);
  const escaped = tokenVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = token.match(new RegExp(`^${escaped}\\.([a-f0-9]{32})(?:\\.([a-f0-9]{32}))?$`));
  if (!match) throw previewMismatch();
  return {
    previewToken: `${tokenVersion}.${match[1]}`,
    attemptId: match[2] ?? null,
  };
}

function requiredPreviewCapability(value: unknown, version: string): string {
  const capability = parseCapability(value, version);
  if (capability.attemptId) throw previewMismatch();
  return capability.previewToken;
}

function requiredExecutionCapability(value: unknown, version: string): {
  previewToken: string;
  attemptId: string;
} {
  const capability = parseCapability(value, version);
  if (!capability.attemptId) throw previewMismatch();
  return { previewToken: capability.previewToken, attemptId: capability.attemptId };
}

function executionAttemptHash(attemptId: string): string {
  return createHash("sha256").update(attemptId).digest("hex");
}

function assertApplyingAttempt(
  claim: Record<string, unknown>,
  attemptId: string,
  nowMs: number,
): void {
  if (
    asString(claim.applyingAttemptHash) !== executionAttemptHash(attemptId) ||
    applyingRetentionExpiresAtMs(claim) <= nowMs
  ) {
    throw previewMismatch();
  }
}

function previewStartExpiresAtMs(claim: Record<string, unknown>): number {
  return requiredFutureBoundary(claim.expiresAtIso);
}

function applyingLeaseExpiresAtMs(claim: Record<string, unknown>): number {
  const explicit = Date.parse(asString(claim.applyLeaseExpiresAtIso));
  if (Number.isFinite(explicit)) return explicit;
  return requiredStateBoundary(claim.applyingAtIso, APPLY_LEASE_MS);
}

function applyingRetentionExpiresAtMs(claim: Record<string, unknown>): number {
  const explicit = Date.parse(asString(claim.applyingRetentionExpiresAtIso));
  if (Number.isFinite(explicit)) return explicit;
  return requiredStateBoundary(claim.applyingAtIso, APPLY_RECOVERY_RETENTION_MS);
}

function completedRetentionExpiresAtMs(claim: Record<string, unknown>): number {
  const explicit = Date.parse(asString(claim.completedRetentionExpiresAtIso));
  if (Number.isFinite(explicit)) return explicit;
  return requiredStateBoundary(claim.completedAtIso, COMPLETED_REPLAY_RETENTION_MS);
}

function failedRetentionExpiresAtMs(claim: Record<string, unknown>): number {
  const explicit = Date.parse(asString(claim.failedRetentionExpiresAtIso));
  if (Number.isFinite(explicit)) return explicit;
  return requiredStateBoundary(
    asString(claim.failedAtIso) || asString(claim.applyingAtIso),
    FAILED_RETENTION_MS,
  );
}

function requiredFutureBoundary(value: unknown): number {
  const boundary = Date.parse(asString(value));
  if (!Number.isFinite(boundary)) throw previewMismatch();
  return boundary;
}

function requiredStateBoundary(value: unknown, retentionMs: number): number {
  const stateAtMs = Date.parse(asString(value));
  if (!Number.isFinite(stateAtMs)) throw previewMismatch();
  return stateAtMs + retentionMs;
}

function requiredTokenVersion(value: unknown): string {
  const normalized = asString(value).trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,80}$/.test(normalized)) throw invalidArgument("preview token version is invalid");
  return normalized;
}

function requiredLabel(value: unknown, field: string): string {
  const normalized = asString(value).trim();
  if (!/^[a-zA-Z0-9._:-]{2,180}$/.test(normalized)) throw invalidArgument(`${field} is invalid`);
  return normalized;
}

function requiredFingerprint(value: unknown, field: string): string {
  const fingerprint = asString(value).trim();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw invalidArgument(`${field} is invalid`);
  return fingerprint;
}

function actorHash(actor: Pick<AuthContext, "userId" | "role" | "team">): string {
  return createHash("sha256").update(stableJson({
    userId: actor.userId,
    role: actor.role,
    team: actor.team,
  })).digest("hex").slice(0, 40);
}

function previewStatus(value: unknown): PreviewStatus {
  if (value === "pending" || value === "applying" || value === "completed" || value === "failed") return value;
  throw previewMismatch();
}

function maskedSummary(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) continue;
    const sanitized = sanitizePublicValue(raw, 0);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function sanitizePublicValue(value: unknown, depth: number): unknown {
  if (depth > 5 || value === null) return value === null ? null : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    if (
      value.length > 240 ||
      value.includes("@") ||
      /^https?:/i.test(value) ||
      /^projects\//i.test(value)
    ) {
      return undefined;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((entry) => sanitizePublicValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (!value || typeof value !== "object") return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) continue;
    const sanitized = sanitizePublicValue(raw, depth + 1);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function safeFailureCode(value: unknown): string {
  const normalized = asString(value).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return normalized || "operation_failed";
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw invalidArgument(`${field} must be a non-negative integer`);
  return parsed;
}

function effectiveNowMs(value: unknown): number {
  const raw = asString(value);
  const parsed = raw ? Date.parse(raw) : Date.now();
  if (!Number.isFinite(parsed)) throw invalidArgument("nowIso is invalid");
  return parsed;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function invalidArgument(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid-argument", errorCode: "invalid_argument_unauthorized" });
}

function previewMismatch(): Error {
  return Object.assign(new Error("Sheet operation preview is missing, expired, consumed, or belongs to another actor/source."), {
    code: "failed-precondition", errorCode: "preview_mismatch_sheet_operation_preview_missing_expired",
  });
}

function previewDrift(): Error {
  return Object.assign(new Error("Sheet operation preview drifted; refresh and create a new preview."), {
    code: "failed-precondition", errorCode: "preview_drift_sheet_operation_preview_drifted_refresh",
  });
}

function previewApplying(): Error {
  return Object.assign(new Error("Sheet operation preview is already being applied by another attempt."), {
    code: "failed-precondition", errorCode: "preview_applying_sheet_operation_preview_already_being",
  });
}
