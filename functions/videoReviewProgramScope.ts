import { createHash } from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import { resolveCanonicalProgramId, SCP_CANONICAL_PROGRAM_ID } from "./programCanonical";
import { VIDEO_REVIEW_POLICY_VERSION } from "./videoReviewCriteria";

export const VIDEO_REVIEW_PROGRAM_SCOPE_VERSION = "flu-video-review-program-scope/v2" as const;

export const VIDEO_REVIEW_PROGRAM_SCOPE_ERROR_CODES = [
  "video_review_program_scope_unresolved",
  "video_review_program_scope_ambiguous",
  "video_review_program_scope_changed",
] as const;

export type VideoReviewProgramScopeErrorCode = typeof VIDEO_REVIEW_PROGRAM_SCOPE_ERROR_CODES[number];

export type VideoReviewProgramScope = {
  scopeVersion: typeof VIDEO_REVIEW_PROGRAM_SCOPE_VERSION;
  canonicalProgramId: string;
  policyVersion: typeof VIDEO_REVIEW_POLICY_VERSION;
  policyConfigHash: string;
  /** Immutable, bounded policy captured on the authoritative submission. */
  policySnapshot: Record<string, unknown>;
  sourceProgramIds: string[];
  sourceRefs: string[];
  legacyScpFallback: boolean;
};

export type VideoReviewEffectiveProgramPolicy = {
  minimumDurationSeconds: number;
};

type TrustedScopeRecords = {
  submission: Record<string, unknown>;
  task?: Record<string, unknown> | null;
  lead?: Record<string, unknown> | null;
  application?: Record<string, unknown> | null;
};

export type VideoReviewProgramScopeRecordReader = (
  collection: string,
  documentId: string,
) => Promise<Record<string, unknown> | null>;

const POLICY_SNAPSHOT_FIELDS = [
  "videoReviewPolicySnapshot",
  "videoReviewPolicy",
  "videoReviewConfig",
  "videoReviewCriteria",
  "contentReviewPolicy",
] as const;

export function videoReviewProgramScopeFromTrustedRecords(
  records: TrustedScopeRecords,
  options: { legacyScpFallback?: boolean } = {},
): VideoReviewProgramScope {
  const sourceRecords = [records.submission, records.task, records.lead, records.application]
    .filter((value): value is Record<string, unknown> => Boolean(value));
  const rawProgramIds = sourceRecords.flatMap(programIdsFromRecord);
  const canonicalIds = [...new Set(rawProgramIds.map((programId) => resolveCanonicalProgramId(programId)).filter(Boolean))].sort();
  if (canonicalIds.length > 1) {
    throw programScopeError("video_review_program_scope_ambiguous");
  }
  const allowLegacyScp = options.legacyScpFallback !== false && legacyScpFallbackEligible(records);
  const canonicalProgramId = canonicalIds[0] || (allowLegacyScp ? SCP_CANONICAL_PROGRAM_ID : "");
  if (!canonicalProgramId) throw programScopeError("video_review_program_scope_unresolved");

  // Program/campaign policy may be snapshotted at any authoritative boundary. Include every
  // allowlisted source in the namespace hash so distinct policies cannot share model state.
  const policySources = policySnapshotsFromTrustedRecords(records);
  const policySnapshot = mergeEffectivePolicySnapshots(policySources);
  const policyConfigHash = sha256(stableJson({
    scopeVersion: VIDEO_REVIEW_PROGRAM_SCOPE_VERSION,
    policyVersion: VIDEO_REVIEW_POLICY_VERSION,
    canonicalProgramId,
    policySources,
  }));
  return {
    scopeVersion: VIDEO_REVIEW_PROGRAM_SCOPE_VERSION,
    canonicalProgramId,
    policyVersion: VIDEO_REVIEW_POLICY_VERSION,
    policyConfigHash,
    policySnapshot,
    sourceProgramIds: [...new Set(rawProgramIds)].sort(),
    sourceRefs: sourceRecords.flatMap(sourceRefsFromRecord).filter((value, index, values) => values.indexOf(value) === index).sort(),
    legacyScpFallback: canonicalIds.length === 0,
  };
}

export async function resolveAuthoritativeVideoReviewProgramScope(
  authoritativeSubmission: Record<string, unknown> & { id?: string },
  options: { recordReader?: VideoReviewProgramScopeRecordReader } = {},
): Promise<VideoReviewProgramScope> {
  const recordReader = options.recordReader ?? readRecordFromAdminDb;
  const task = await readReferencedRecord(
    "submission_tasks",
    [authoritativeSubmission.taskRef, authoritativeSubmission.submissionTaskRef],
    [authoritativeSubmission.taskId, authoritativeSubmission.submissionTaskId],
    recordReader,
  );
  const lead = await readReferencedRecord(
    "program_sheet_leads",
    [authoritativeSubmission.leadRef, task?.leadRef],
    [authoritativeSubmission.leadId, task?.leadId],
    recordReader,
  );
  const application = await readReferencedRecord(
    "program_applications",
    [
      authoritativeSubmission.applicationRef,
      authoritativeSubmission.programApplicationRef,
      task?.applicationRef,
      task?.programApplicationRef,
      lead?.applicationRef,
      lead?.programApplicationRef,
      lead?.bridgedApplicationRef,
    ],
    [
      authoritativeSubmission.applicationId,
      authoritativeSubmission.programApplicationId,
      task?.applicationId,
      task?.programApplicationId,
      lead?.applicationId,
      lead?.programApplicationId,
      lead?.bridgedApplicationId,
    ],
    recordReader,
  );
  validateAuthoritativeOwnership(authoritativeSubmission, task, lead, application);
  return videoReviewProgramScopeFromTrustedRecords({
    submission: authoritativeSubmission,
    task,
    lead,
    application,
  });
}

export function sameVideoReviewProgramScope(
  left: Pick<VideoReviewProgramScope, "canonicalProgramId" | "policyConfigHash">,
  right: Pick<VideoReviewProgramScope, "canonicalProgramId" | "policyConfigHash">,
): boolean {
  return left.canonicalProgramId === right.canonicalProgramId
    && left.policyConfigHash === right.policyConfigHash;
}

/**
 * Converts the immutable submission snapshot into the small executable policy surface.
 * Program policy may tighten the canonical 20-second floor, but cannot weaken it.
 */
export function videoReviewEffectiveProgramPolicy(
  scope: Pick<VideoReviewProgramScope, "policySnapshot">,
): VideoReviewEffectiveProgramPolicy {
  const merged = mergePolicySnapshotRoots(scope.policySnapshot);
  const rules = asPolicyRecord(merged.rules);
  const durationRule = asPolicyRecord(rules.R5 ?? rules.duration ?? merged.duration);
  const requestedMinimum = firstFinitePolicyNumber(
    merged.minimumDurationSeconds,
    merged.minDurationSeconds,
    merged.durationMinSeconds,
    durationRule.minimumDurationSeconds,
    durationRule.minDurationSeconds,
    durationRule.seconds,
  );
  return {
    minimumDurationSeconds: requestedMinimum === null
      ? 20
      : Math.max(20, Math.min(60 * 60, requestedMinimum)),
  };
}

export function videoReviewScopedFingerprint(
  namespace: string,
  scope: Pick<VideoReviewProgramScope, "canonicalProgramId" | "policyConfigHash">,
  ...identity: unknown[]
): string {
  return sha256(stableJson({
    namespace,
    canonicalProgramId: scope.canonicalProgramId,
    policyConfigHash: scope.policyConfigHash,
    identity,
  }));
}

/** Firestore-safe key for program/policy keyed projections and outbox generations. */
export function videoReviewProgramScopeKey(
  scope: Pick<VideoReviewProgramScope, "canonicalProgramId" | "policyConfigHash">,
): string {
  return `scope_${videoReviewScopedFingerprint("program-scope-key", scope).slice(0, 48)}`;
}

/**
 * Converts a conceptual nested projection into Firestore update paths. Updating
 * `videoReviewByScope` as one map would delete every other program's review state; replacing
 * only the exact scope key preserves sibling programs while fully replacing this module-owned
 * projection for the active program/policy.
 */
export function videoReviewScopePreservingSubmissionUpdate(
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...patch };
  const scoped = result.videoReviewByScope;
  delete result.videoReviewByScope;
  if (scoped === undefined) return result;
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    throw programScopeError("video_review_program_scope_unresolved");
  }
  for (const [scopeKey, projection] of Object.entries(scoped as Record<string, unknown>)) {
    if (!/^scope_[a-f0-9]{48}$/.test(scopeKey)) {
      throw programScopeError("video_review_program_scope_unresolved");
    }
    result[`videoReviewByScope.${scopeKey}`] = projection;
  }
  return result;
}

export function programScopeError(code: VideoReviewProgramScopeErrorCode): Error & { code: VideoReviewProgramScopeErrorCode } {
  return Object.assign(new Error(code), { code });
}

function programIdsFromRecord(record: Record<string, unknown>): string[] {
  return [record.canonicalProgramId, record.programId]
    .map(cleanProgramId)
    .filter(Boolean);
}

function sourceRefsFromRecord(record: Record<string, unknown>): string[] {
  return [
    record.taskRef,
    record.submissionTaskRef,
    record.leadRef,
    record.applicationRef,
    record.programApplicationRef,
    record.bridgedApplicationRef,
  ].map(cleanRef).filter(Boolean);
}

type PolicySnapshotSources = {
  application: Record<string, unknown>;
  lead: Record<string, unknown>;
  task: Record<string, unknown>;
  submission: Record<string, unknown>;
};

function policySnapshotsFromTrustedRecords(records: TrustedScopeRecords): PolicySnapshotSources {
  return {
    application: policySnapshotFromRecord(records.application),
    lead: policySnapshotFromRecord(records.lead),
    task: policySnapshotFromRecord(records.task),
    submission: policySnapshotFromRecord(records.submission),
  };
}

function policySnapshotFromRecord(record: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!record) return result;
  for (const field of POLICY_SNAPSHOT_FIELDS) {
    if (!(field in record)) continue;
    result[field] = stablePolicyValue(record[field], 0);
  }
  return result;
}

function mergeEffectivePolicySnapshots(sources: PolicySnapshotSources): Record<string, unknown> {
  const effectivePolicy: Record<string, unknown> = {};
  // Normalize every authoritative record before applying record precedence. Otherwise an
  // application's preferred alias (videoReviewPolicySnapshot) can outrank a submission's
  // compatibility alias (contentReviewPolicy) later when roots are merged, even though the
  // submission is the nearest immutable source.
  for (const source of [sources.application, sources.lead, sources.task, sources.submission]) {
    for (const [field, value] of Object.entries(mergePolicySnapshotRoots(source))) {
      effectivePolicy[field] = value;
    }
  }
  return Object.keys(effectivePolicy).length
    ? { videoReviewPolicySnapshot: effectivePolicy }
    : {};
}

function mergePolicySnapshotRoots(snapshot: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  // Earlier fields are more authoritative: the immutable snapshot must win over legacy
  // compatibility aliases if both survived a migration.
  for (const field of [...POLICY_SNAPSHOT_FIELDS].reverse()) {
    const value = asPolicyRecord(snapshot[field]);
    for (const [key, child] of Object.entries(value)) merged[key] = child;
  }
  return merged;
}

function asPolicyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstFinitePolicyNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || (typeof value === "string" && !value.trim())) continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return null;
}

function stablePolicyValue(value: unknown, depth: number): unknown {
  if (depth > 12) throw programScopeError("video_review_program_scope_unresolved");
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 100_000) throw programScopeError("video_review_program_scope_unresolved");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw programScopeError("video_review_program_scope_unresolved");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw programScopeError("video_review_program_scope_unresolved");
    return value.map((item) => stablePolicyValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") throw programScopeError("video_review_program_scope_unresolved");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw programScopeError("video_review_program_scope_unresolved");
  }
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 1_000) throw programScopeError("video_review_program_scope_unresolved");
  for (const [key, child] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(key)) {
      throw programScopeError("video_review_program_scope_unresolved");
    }
    // Identity/credential metadata is not executable policy and must not enter a durable hash.
    if (privatePolicyKey(key)) continue;
    result[key] = stablePolicyValue(child, depth + 1);
  }
  return result;
}

function privatePolicyKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return [
    "authorization",
    "credential",
    "email",
    "owneremail",
    "owneruid",
    "password",
    "secret",
    "token",
    "userid",
    "useruid",
    "webhook",
  ].some((fragment) => normalized.includes(fragment));
}

function legacyScpFallbackEligible(records: TrustedScopeRecords): boolean {
  if (records.task || records.lead || records.application) return false;
  const declaredFields = [
    "canonicalProgramId", "programId",
    "taskRef", "taskId", "submissionTaskRef", "submissionTaskId",
    "leadRef", "leadId",
    "applicationRef", "applicationId", "programApplicationRef", "programApplicationId",
    "bridgedApplicationRef", "bridgedApplicationId",
  ];
  return !declaredFields.some((field) => declaredValue(records.submission[field]));
}

function declaredValue(value: unknown): boolean {
  return value !== null && value !== undefined && (typeof value !== "string" || value.trim() !== "");
}

function validateAuthoritativeOwnership(
  submission: Record<string, unknown> & { id?: string },
  task: Record<string, unknown> | null,
  lead: Record<string, unknown> | null,
  application: Record<string, unknown> | null,
): void {
  const submissionId = cleanDocId(submission.id);
  const taskId = cleanDocId(task?.id);
  const leadId = cleanDocId(lead?.id);
  const applicationId = cleanDocId(application?.id);

  assertOptionalOwnership("submissions", submissionId, [task?.submissionRef], [task?.submissionId]);
  assertOptionalOwnership("submission_tasks", taskId, [lead?.submissionTaskRef, lead?.taskRef], [lead?.submissionTaskId, lead?.taskId]);
  assertOptionalOwnership("program_sheet_leads", leadId, [application?.leadRef], [application?.leadId]);
  assertOptionalOwnership(
    "program_applications",
    applicationId,
    [lead?.applicationRef, lead?.programApplicationRef, lead?.bridgedApplicationRef],
    [lead?.applicationId, lead?.programApplicationId, lead?.bridgedApplicationId],
  );
}

function assertOptionalOwnership(
  collection: string,
  expectedId: string,
  refValues: unknown[],
  idValues: unknown[],
): void {
  const declaredIds: string[] = [];
  for (const value of refValues) {
    const raw = rawString(value);
    if (!raw) continue;
    const id = referencedId(collection, raw);
    if (!id) throw programScopeError("video_review_program_scope_unresolved");
    declaredIds.push(id);
  }
  for (const value of idValues) {
    if (!declaredValue(value)) continue;
    const id = cleanDocId(value);
    if (!id) throw programScopeError("video_review_program_scope_unresolved");
    declaredIds.push(id);
  }
  if (!declaredIds.length) return;
  const distinct = [...new Set(declaredIds)];
  if (distinct.length > 1 || !expectedId || distinct[0] !== expectedId) {
    throw programScopeError("video_review_program_scope_ambiguous");
  }
}

async function readReferencedRecord(
  collection: string,
  refValues: unknown[],
  idValues: unknown[],
  reader: VideoReviewProgramScopeRecordReader,
): Promise<Record<string, unknown> | null> {
  const candidateIds: string[] = [];
  let declared = false;
  for (const value of refValues) {
    if (!declaredValue(value)) continue;
    declared = true;
    const raw = rawString(value);
    if (!raw) throw programScopeError("video_review_program_scope_unresolved");
    const id = referencedId(collection, raw);
    if (!id) throw programScopeError("video_review_program_scope_unresolved");
    candidateIds.push(id);
  }
  for (const value of idValues) {
    if (!declaredValue(value)) continue;
    declared = true;
    const raw = rawString(value);
    if (!raw) throw programScopeError("video_review_program_scope_unresolved");
    const id = cleanDocId(raw);
    if (!id) throw programScopeError("video_review_program_scope_unresolved");
    candidateIds.push(id);
  }
  const distinctIds = [...new Set(candidateIds)];
  if (distinctIds.length > 1) throw programScopeError("video_review_program_scope_ambiguous");
  if (!declared) return null;
  if (!distinctIds[0]) throw programScopeError("video_review_program_scope_unresolved");
  const record = await reader(collection, distinctIds[0]);
  if (!record) throw programScopeError("video_review_program_scope_unresolved");
  return record;
}

async function readRecordFromAdminDb(collection: string, refId: string): Promise<Record<string, unknown> | null> {
  const snapshot = await adminDb.collection(collection).doc(refId).get();
  return snapshot.exists ? { id: snapshot.id, ...(snapshot.data() ?? {}) } : null;
}

function referencedId(collection: string, value: unknown): string {
  const ref = cleanRef(value);
  const match = new RegExp(`^${collection}/([^/]+)$`).exec(ref);
  return match ? cleanDocId(match[1]) : "";
}

function cleanProgramId(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 180) : "";
}

function cleanDocId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw && !raw.includes("/") ? raw.slice(0, 500) : "";
}

function cleanRef(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]+\/[A-Za-z0-9_.:-]+$/.test(value.trim())
    ? value.trim().slice(0, 1000)
    : "";
}

function rawString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) {
    result[key] = sortValue(child);
  }
  return result;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
