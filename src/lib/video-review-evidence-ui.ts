import { resolveCanonicalProgramId, SCP_CANONICAL_PROGRAM_ID } from "./program-canonical";

export const VIDEO_REVIEW_EVIDENCE_UI_SCHEMA = "flu-video-review-evidence/v1" as const;
// W107: bumped alongside functions/videoReviewCriteria.ts VIDEO_REVIEW_POLICY_VERSION and the
// new R8 evidence code below. Kept in sync manually -- this client mirror cannot import the
// server-only videoReviewEvidence.ts module.
export const VIDEO_REVIEW_EVIDENCE_UI_POLICY_VERSION = "xp-hero-content-policy/v2.1.0" as const;
export const VIDEO_REVIEW_EVIDENCE_UI_PROGRAM_SCOPE_VERSION = "flu-video-review-program-scope/v2" as const;

const FUTURE_SKEW_MS = 5 * 60 * 1000;
export const VIDEO_REVIEW_EVIDENCE_UI_TTL_MS = 24 * 60 * 60 * 1000;
const HASH_64_PATTERN = /^[a-f0-9]{64}$/;
const OUTBOX_HASH_PATTERN = /^[a-f0-9]{32,64}$/;

export const VIDEO_REVIEW_EVIDENCE_UI_ENVELOPE_KEYS = [
  "schema",
  "policyVersion",
  "programScopeVersion",
  "canonicalProgramId",
  "policyConfigHash",
  "sourceFingerprint",
  "outboxSourceFingerprint",
  "producedAtIso",
  "expiresAtIso",
  "identityFingerprints",
  "facts",
  "producerFailures",
  "integrityHash",
] as const;

export const VIDEO_REVIEW_EVIDENCE_UI_FACT_KEYS = [
  "ruleId",
  "status",
  "confidence",
  "code",
  "provider",
  "observedAtIso",
  "inputFingerprint",
] as const;

export const VIDEO_REVIEW_EVIDENCE_UI_TRUSTED_RULE_IDS = ["R2", "R6", "R8", "R9", "R15"] as const;
type RuleId = typeof VIDEO_REVIEW_EVIDENCE_UI_TRUSTED_RULE_IDS[number];
type EvidenceStatus = "observed" | "unknown" | "failed";
type EvidenceProvider = "youtube_data_api_v3" | "cross_submission_fingerprint_v1";

export const VIDEO_REVIEW_EVIDENCE_UI_CODES_BY_RULE = {
  R2: [
    "r2_assigned_destination_present",
    "r2_assigned_destination_missing",
    "r2_unclassified_store_destination",
    "r2_other_title_destination_present",
    "r2_assignment_unavailable",
    "r2_youtube_metadata_unavailable",
  ],
  R6: ["r6_exact_name_in_metadata", "r6_media_scan_required", "r6_youtube_metadata_unavailable"],
  R8: ["r8_required_hashtags_present", "r8_required_hashtags_not_in_text", "r8_youtube_metadata_unavailable"],
  R9: ["r9_disclosure_in_metadata", "r9_media_scan_required", "r9_youtube_metadata_unavailable"],
  R15: [
    "r15_duplicate_fingerprint_found",
    "r15_no_duplicate_in_complete_index",
    "r15_index_coverage_incomplete",
    "r15_comparable_fingerprint_unavailable",
    "r15_lookup_unavailable",
  ],
} as const satisfies Record<RuleId, readonly string[]>;

export const VIDEO_REVIEW_EVIDENCE_UI_STATUS_BY_CODE: Record<string, EvidenceStatus> = {
  r2_assigned_destination_present: "observed",
  r2_assigned_destination_missing: "failed",
  r2_unclassified_store_destination: "unknown",
  r2_other_title_destination_present: "failed",
  r2_assignment_unavailable: "unknown",
  r2_youtube_metadata_unavailable: "unknown",
  r6_exact_name_in_metadata: "observed",
  r6_media_scan_required: "unknown",
  r6_youtube_metadata_unavailable: "unknown",
  r8_required_hashtags_present: "observed",
  r8_required_hashtags_not_in_text: "unknown",
  r8_youtube_metadata_unavailable: "unknown",
  r9_disclosure_in_metadata: "observed",
  r9_media_scan_required: "unknown",
  r9_youtube_metadata_unavailable: "unknown",
  r15_duplicate_fingerprint_found: "failed",
  r15_no_duplicate_in_complete_index: "observed",
  r15_index_coverage_incomplete: "unknown",
  r15_comparable_fingerprint_unavailable: "unknown",
  r15_lookup_unavailable: "unknown",
};

export const VIDEO_REVIEW_EVIDENCE_UI_PRODUCER_FAILURE_CODES = [
  "creator_assignment_lookup_unavailable",
  "duplicate_lookup_unavailable",
  "youtube_metadata_unavailable",
  "youtube_video_not_found",
] as const;
const PRODUCER_FAILURE_CODES = new Set<string>(VIDEO_REVIEW_EVIDENCE_UI_PRODUCER_FAILURE_CODES);

export type VideoReviewEvidenceUiState = "not_collected" | "collected" | "producer_failed" | "invalid";

export type VideoReviewEvidenceUiClassification = {
  state: VideoReviewEvidenceUiState;
  producerFailures: string[];
  producedAtIso: string;
};

export type VideoReviewEvidenceUiExpectedBinding = {
  canonicalProgramId: unknown;
  policyConfigHash: unknown;
  sourceFingerprint: unknown;
};

/**
 * Projects one exact program/policy scope to the legacy flat fields consumed by the review UI.
 * Binding and envelope are copied independently; a missing binding is never synthesized from
 * the self-described envelope.
 */
export function projectVideoReviewEvidenceUiSubmission(
  value: Record<string, unknown>,
  expectedCanonicalProgramId: unknown,
): Record<string, unknown> {
  const canonicalProgramId = resolveCanonicalProgramId(expectedCanonicalProgramId);
  if (!canonicalProgramId) return { ...value };
  const scoped = isRecord(value.videoReviewByScope) ? value.videoReviewByScope : {};
  const candidates = Object.entries(scoped).flatMap(([scopeKey, candidate]) => {
    if (!isRecord(candidate) || exactCanonicalProgramId(candidate.canonicalProgramId) !== canonicalProgramId) return [];
    return [{ scopeKey, projection: candidate, updatedAtMs: scopeProjectionUpdatedAtMs(candidate) }];
  }).sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.scopeKey.localeCompare(right.scopeKey));
  const selected = candidates[0]?.projection;
  const result = { ...value };
  if (!selected && canonicalProgramId === SCP_CANONICAL_PROGRAM_ID) return result;
  delete result.aiRecommendation;
  delete result.aiRecommendationMultimodal;
  delete result.videoReviewEvidence;
  delete result.videoReviewEvidenceBinding;
  delete result.videoReviewEvidenceIdentityFingerprints;
  if (!selected) return result;
  const textProjection = isRecord(selected.text) ? selected.text : {};
  const multimodalProjection = isRecord(selected.multimodal) ? selected.multimodal : {};
  if (isRecord(textProjection.aiRecommendation)) result.aiRecommendation = textProjection.aiRecommendation;
  if (isRecord(multimodalProjection.aiRecommendation)) {
    result.aiRecommendationMultimodal = multimodalProjection.aiRecommendation;
  }
  if (isRecord(selected.videoReviewEvidence)) result.videoReviewEvidence = selected.videoReviewEvidence;
  if (isRecord(selected.videoReviewEvidenceBinding)) {
    result.videoReviewEvidenceBinding = selected.videoReviewEvidenceBinding;
  }
  if (Array.isArray(selected.videoReviewEvidenceIdentityFingerprints)) {
    result.videoReviewEvidenceIdentityFingerprints = selected.videoReviewEvidenceIdentityFingerprints;
  }
  return result;
}

export function videoReviewEvidenceBindingNeedsRecovery(
  value: Record<string, unknown>,
  expectedCanonicalProgramId: unknown,
): boolean {
  const projected = projectVideoReviewEvidenceUiSubmission(value, expectedCanonicalProgramId);
  return isRecord(projected.videoReviewEvidence)
    && !isRecord(projected.videoReviewEvidenceBinding);
}

export function recoverVideoReviewEvidenceBindingFromOutbox(
  value: Record<string, unknown>,
  expectedCanonicalProgramId: unknown,
  entries: unknown,
): Record<string, unknown> {
  const canonicalProgramId = resolveCanonicalProgramId(expectedCanonicalProgramId);
  const submissionId = cleanSubmissionId(value.id) || cleanSubmissionId(value.submissionId);
  if (!canonicalProgramId
    || !submissionId
    || !videoReviewEvidenceBindingNeedsRecovery(value, canonicalProgramId)
    || !Array.isArray(entries)) {
    return value;
  }
  const candidate = entries.flatMap((item) => isRecord(item) ? [item] : [])
    .filter((item) => item.kind === "ai_recommendation" && item.status === "processed")
    .sort((left, right) => isoMillis(right.processedAtIso) - isoMillis(left.processedAtIso))
    .find((item) => {
      const result = isRecord(item.lastResult) ? item.lastResult : {};
      return cleanSubmissionId(item.submissionId) === submissionId
        && item.canonicalProgramId === canonicalProgramId
        && item.policyConfigHash === result.policyConfigHash
        && result.canonicalProgramId === canonicalProgramId
        && isHash64(result.policyConfigHash)
        && isHash64(result.evidenceSourceFingerprint);
    });
  if (!candidate) return value;
  const lastResult = candidate.lastResult as Record<string, unknown>;
  const binding = Object.freeze({
    canonicalProgramId,
    policyConfigHash: lastResult.policyConfigHash as string,
    sourceFingerprint: lastResult.evidenceSourceFingerprint as string,
  });
  const scoped = isRecord(value.videoReviewByScope) ? value.videoReviewByScope : {};
  let scopedRecovered = false;
  const recoveredScopes = Object.fromEntries(Object.entries(scoped).map(([key, item]) => {
    if (!isRecord(item)
      || item.canonicalProgramId !== binding.canonicalProgramId
      || item.policyConfigHash !== binding.policyConfigHash
      || !isRecord(item.videoReviewEvidence)) return [key, item];
    scopedRecovered = true;
    return [key, { ...item, videoReviewEvidenceBinding: binding }];
  }));
  if (scopedRecovered) return { ...value, videoReviewByScope: recoveredScopes };
  if (canonicalProgramId === SCP_CANONICAL_PROGRAM_ID && isRecord(value.videoReviewEvidence)) {
    return { ...value, videoReviewEvidenceBinding: binding };
  }
  return value;
}

/**
 * Classifies the server evidence envelope for display only.
 *
 * The client can reject malformed envelopes, but cannot prove the integrity binding because
 * the authoritative source fingerprint and policy scope inputs stay on the server. Callers
 * must therefore describe `collected` as a server ledger being present, not as trusted proof.
 */
export function classifyVideoReviewEvidence(
  value: unknown,
  expected: VideoReviewEvidenceUiExpectedBinding,
  nowMs: number = Date.now(),
): VideoReviewEvidenceUiClassification {
  if (isEmptyEvidence(value)) return classification("not_collected");
  if (!isRecord(value) || !hasExactKeys(value, VIDEO_REVIEW_EVIDENCE_UI_ENVELOPE_KEYS)) return classification("invalid");

  if (value.schema !== VIDEO_REVIEW_EVIDENCE_UI_SCHEMA
    || value.policyVersion !== VIDEO_REVIEW_EVIDENCE_UI_POLICY_VERSION
    || value.programScopeVersion !== VIDEO_REVIEW_EVIDENCE_UI_PROGRAM_SCOPE_VERSION) {
    return classification("invalid");
  }

  const canonicalProgramId = exactCanonicalProgramId(value.canonicalProgramId);
  const expectedCanonicalProgramId = exactCanonicalProgramId(expected.canonicalProgramId);
  const expectedPolicyConfigHash = isHash64(expected.policyConfigHash) ? expected.policyConfigHash : "";
  const expectedSourceFingerprint = isHash64(expected.sourceFingerprint) ? expected.sourceFingerprint : "";
  if (!canonicalProgramId
    || !expectedCanonicalProgramId
    || canonicalProgramId !== expectedCanonicalProgramId
    || !isHash64(value.policyConfigHash)
    || !expectedPolicyConfigHash
    || value.policyConfigHash !== expectedPolicyConfigHash
    || !isHash64(value.sourceFingerprint)
    || !expectedSourceFingerprint
    || value.sourceFingerprint !== expectedSourceFingerprint
    || !isHash64(value.integrityHash)) {
    return classification("invalid");
  }

  if (value.outboxSourceFingerprint !== null
    && (typeof value.outboxSourceFingerprint !== "string"
      || !OUTBOX_HASH_PATTERN.test(value.outboxSourceFingerprint))) {
    return classification("invalid");
  }

  const producedAtIso = strictIso(value.producedAtIso);
  const expiresAtIso = strictIso(value.expiresAtIso);
  const effectiveNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!producedAtIso || !expiresAtIso) return classification("invalid");
  const producedAtMs = Date.parse(producedAtIso);
  const expiresAtMs = Date.parse(expiresAtIso);
  if (producedAtMs > effectiveNowMs + FUTURE_SKEW_MS
    || expiresAtMs <= effectiveNowMs
    || expiresAtMs <= producedAtMs
    || expiresAtMs - producedAtMs > VIDEO_REVIEW_EVIDENCE_UI_TTL_MS) {
    return classification("invalid");
  }

  if (!isUniqueHashArray(value.identityFingerprints)) return classification("invalid");
  if (!isProducerFailureArray(value.producerFailures)) return classification("invalid");
  if (!isExactFactSet(value.facts, producedAtIso)) return classification("invalid");

  const producerFailures = [...value.producerFailures];
  return {
    state: producerFailures.length > 0 ? "producer_failed" : "collected",
    producerFailures,
    producedAtIso,
  };
}

/** Returns a single timeout delay that re-renders the mounted UI just after expiry. */
export function videoReviewEvidenceExpiryRefreshDelay(value: unknown, nowMs: number = Date.now()): number | null {
  if (!isRecord(value)) return null;
  const expiresAtIso = strictIso(value.expiresAtIso);
  if (!expiresAtIso || !Number.isFinite(nowMs)) return null;
  const remainingMs = Date.parse(expiresAtIso) - nowMs;
  return remainingMs > 0 && remainingMs <= VIDEO_REVIEW_EVIDENCE_UI_TTL_MS + FUTURE_SKEW_MS
    ? remainingMs + 1
    : null;
}

function classification(state: VideoReviewEvidenceUiState): VideoReviewEvidenceUiClassification {
  return { state, producerFailures: [], producedAtIso: "" };
}

function scopeProjectionUpdatedAtMs(projection: Record<string, unknown>): number {
  const text = isRecord(projection.text) ? projection.text : {};
  const multimodal = isRecord(projection.multimodal) ? projection.multimodal : {};
  const evidence = isRecord(projection.videoReviewEvidence) ? projection.videoReviewEvidence : {};
  return [text.updatedAtIso, multimodal.updatedAtIso, evidence.producedAtIso]
    .map((candidate) => strictIso(candidate))
    .filter(Boolean)
    .reduce((latest, candidate) => Math.max(latest, Date.parse(candidate)), 0);
}

function isoMillis(value: unknown): number {
  const iso = strictIso(value);
  return iso ? Date.parse(iso) : 0;
}

function cleanSubmissionId(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/^submissions\//, "") : "";
}

function isEmptyEvidence(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expected.length) return false;
  const allowlist = new Set(expected);
  return keys.every((key) => allowlist.has(key));
}

function isHash64(value: unknown): value is string {
  return typeof value === "string" && HASH_64_PATTERN.test(value);
}

function exactCanonicalProgramId(value: unknown): string {
  if (typeof value !== "string" || !value || value !== value.trim()) return "";
  return resolveCanonicalProgramId(value) === value ? value : "";
}

function strictIso(value: unknown): string {
  if (typeof value !== "string") return "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : "";
}

function isUniqueHashArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(isHash64)
    && new Set(value).size === value.length;
}

function isProducerFailureArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((failure) => typeof failure === "string" && PRODUCER_FAILURE_CODES.has(failure))
    && new Set(value).size === value.length;
}

function isExactFactSet(value: unknown, producedAtIso: string): boolean {
  if (!Array.isArray(value) || value.length !== VIDEO_REVIEW_EVIDENCE_UI_TRUSTED_RULE_IDS.length) return false;
  const seenRules = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, VIDEO_REVIEW_EVIDENCE_UI_FACT_KEYS)) return false;
    const ruleId = candidate.ruleId;
    if (typeof ruleId !== "string" || !VIDEO_REVIEW_EVIDENCE_UI_TRUSTED_RULE_IDS.includes(ruleId as RuleId) || seenRules.has(ruleId)) return false;
    const code = candidate.code;
    const status = candidate.status;
    const provider = candidate.provider;
    const expectedProvider: EvidenceProvider = ruleId === "R15"
      ? "cross_submission_fingerprint_v1"
      : "youtube_data_api_v3";
    if (typeof code !== "string"
      || !VIDEO_REVIEW_EVIDENCE_UI_CODES_BY_RULE[ruleId as RuleId].includes(code as never)
      || VIDEO_REVIEW_EVIDENCE_UI_STATUS_BY_CODE[code] !== status
      || provider !== expectedProvider
      || candidate.observedAtIso !== producedAtIso
      || typeof candidate.confidence !== "number"
      || !Number.isFinite(candidate.confidence)
      || candidate.confidence < 0
      || candidate.confidence > 1
      || !isHash64(candidate.inputFingerprint)) {
      return false;
    }
    seenRules.add(ruleId);
  }
  return VIDEO_REVIEW_EVIDENCE_UI_TRUSTED_RULE_IDS.every((ruleId) => seenRules.has(ruleId));
}
