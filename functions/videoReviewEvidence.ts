import { createHash } from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import { resolveCanonicalProgramId } from "./programCanonical";
import {
  defaultProgramTitle,
  otherProgramTitles,
  requiredHashtagsForTitle,
  resolveProgramTitle,
  resolveProgramTitlesOrDefault,
  type ProgramTitle,
} from "./programTitles";
import { makeYouTubeDataApiClient } from "./youtubeEnrichmentService";
import { parseYouTubeDurationSecondsOrNull } from "./youtubeDurationParse";
import { VIDEO_REVIEW_POLICY_VERSION, type VideoReviewRuleEvidenceStatus } from "./videoReviewCriteria";
import { videoReviewMediaCandidate } from "./videoReviewMedia";
import {
  resolveAuthoritativeVideoReviewProgramScope,
  sameVideoReviewProgramScope,
  VIDEO_REVIEW_PROGRAM_SCOPE_VERSION,
  videoReviewProgramScopeFromTrustedRecords,
  videoReviewScopedFingerprint,
  type VideoReviewProgramScope,
} from "./videoReviewProgramScope";
import { asRecord, asString } from "./shared";

export const VIDEO_REVIEW_EVIDENCE_SCHEMA = "flu-video-review-evidence/v1" as const;
export const VIDEO_REVIEW_EVIDENCE_IDENTITY_FIELD = "videoReviewEvidenceIdentityFingerprints" as const;
export const VIDEO_REVIEW_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;
export const VIDEO_REVIEW_EVIDENCE_POLICY_VERSION = VIDEO_REVIEW_POLICY_VERSION;
export const VIDEO_REVIEW_EVIDENCE_PROGRAM_SCOPE_VERSION = VIDEO_REVIEW_PROGRAM_SCOPE_VERSION;
export const VIDEO_REVIEW_EVIDENCE_ENVELOPE_KEYS = [
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
export const VIDEO_REVIEW_EVIDENCE_FACT_KEYS = [
  "ruleId",
  "status",
  "confidence",
  "code",
  "provider",
  "observedAtIso",
  "inputFingerprint",
] as const;

const FUTURE_SKEW_MS = 5 * 60 * 1000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
export const VIDEO_REVIEW_EVIDENCE_TRUSTED_RULE_IDS = ["R2", "R6", "R8", "R9", "R15"] as const;
export const VIDEO_REVIEW_EVIDENCE_PRODUCER_FAILURE_CODES = [
  "creator_assignment_lookup_unavailable",
  "duplicate_lookup_unavailable",
  "youtube_metadata_unavailable",
  "youtube_video_not_found",
] as const;
const PRODUCER_FAILURE_CODES = new Set<string>(VIDEO_REVIEW_EVIDENCE_PRODUCER_FAILURE_CODES);

export type VideoReviewEvidenceRuleId = typeof VIDEO_REVIEW_EVIDENCE_TRUSTED_RULE_IDS[number];
export type VideoReviewEvidenceProvider = "youtube_data_api_v3" | "cross_submission_fingerprint_v1";
export type VideoReviewEvidenceCode =
  | "r2_assigned_destination_present"
  | "r2_assigned_destination_missing"
  | "r2_unclassified_store_destination"
  | "r2_other_title_destination_present"
  | "r2_assignment_unavailable"
  | "r2_youtube_metadata_unavailable"
  | "r6_exact_name_in_metadata"
  | "r6_media_scan_required"
  | "r6_youtube_metadata_unavailable"
  | "r8_required_hashtags_present"
  // W107 T1: text absence is no longer a hard fail. The portal guide allows the required
  // hashtags "in the video or description" (on-screen tags), which a deterministic text parser
  // can never rule out — see functions/videoReviewJudgeService.ts normalizeVideoReviewEvidence
  // and the leader diagnosis at llm-wiki/wiki/projects/flu/scp-video-review-judge-diagnosis-2026-08-18.md.
  | "r8_required_hashtags_not_in_text"
  | "r8_youtube_metadata_unavailable"
  | "r9_disclosure_in_metadata"
  | "r9_media_scan_required"
  | "r9_youtube_metadata_unavailable"
  | "r15_duplicate_fingerprint_found"
  | "r15_no_duplicate_in_complete_index"
  | "r15_index_coverage_incomplete"
  | "r15_comparable_fingerprint_unavailable"
  | "r15_lookup_unavailable";

export interface VideoReviewTrustedEvidenceFact {
  ruleId: VideoReviewEvidenceRuleId;
  status: VideoReviewRuleEvidenceStatus;
  confidence: number;
  code: VideoReviewEvidenceCode;
  provider: VideoReviewEvidenceProvider;
  observedAtIso: string;
  inputFingerprint: string;
}

export interface VideoReviewEvidenceEnvelope {
  schema: typeof VIDEO_REVIEW_EVIDENCE_SCHEMA;
  policyVersion: typeof VIDEO_REVIEW_POLICY_VERSION;
  programScopeVersion: VideoReviewProgramScope["scopeVersion"];
  canonicalProgramId: string;
  policyConfigHash: string;
  sourceFingerprint: string;
  outboxSourceFingerprint: string | null;
  producedAtIso: string;
  expiresAtIso: string;
  identityFingerprints: string[];
  facts: VideoReviewTrustedEvidenceFact[];
  producerFailures: string[];
  integrityHash: string;
}

export interface VideoReviewEvidenceBinding {
  readonly canonicalProgramId: string;
  readonly policyConfigHash: string;
  readonly sourceFingerprint: string;
}

export interface VideoReviewEvidenceYouTubeItem {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    // Task-94 갭①: "live"|"upcoming"|"none". R5(live-stream VOD 제외) 판정의 원문 신호.
    liveBroadcastContent?: string;
  };
  // Task-94 갭①: 지금까지 videosList 가 요청은 해놓고(part=snippet,status,contentDetails)
  // 실제로는 snippet.title/description 만 소비했다 — status/contentDetails 는 버려졌다. R3/R5 는
  // 이 필드들을 요구하는데 채우는 producer 가 없어 항상 unknown 이었다(Task-94 스펙 갭②).
  status?: {
    privacyStatus?: string;
  };
  contentDetails?: {
    duration?: string;
    regionRestriction?: {
      allowed?: string[];
      blocked?: string[];
    };
  };
}

export interface VideoReviewEvidenceYouTubeApi {
  videosList(params: Record<string, string | number | undefined>): Promise<{ items?: VideoReviewEvidenceYouTubeItem[] }>;
}

export interface VideoReviewAssignedLinks {
  available: boolean;
  links: string[];
}

export interface VideoReviewDuplicateLookupResult {
  duplicateFound: boolean;
  coverageComplete: boolean;
}

export interface ProduceVideoReviewEvidenceOptions {
  nowIso?: string;
  outboxSourceFingerprint?: string;
  /** Resolved from authoritative server-side records by the outbox/engine. */
  programScope?: VideoReviewProgramScope;
  /**
   * Raw `settings/program_titles` override document value for this program (same shape consumed
   * by `resolveProgramTitlesOrDefault`). Omitted in production today — the live outbox producer
   * resolves R2/R6/R8 from the code seed only; this exists so tests can exercise the same registry
   * resolution the seed uses without duplicating it.
   */
  registryOverride?: unknown;
  youtubeApi?: VideoReviewEvidenceYouTubeApi;
  resolveAssignedLinks?: (submission: Record<string, unknown>) => Promise<VideoReviewAssignedLinks>;
  lookupDuplicate?: (input: {
    submissionId: string;
    identityFingerprints: string[];
    canonicalProgramId: string;
    policyConfigHash: string;
  }) => Promise<VideoReviewDuplicateLookupResult>;
}

/**
 * Task-94 갭②: R3(공개 상태)/R5(최소 길이)가 읽는 서명되지 않은(트러스트 envelope 밖) 제출
 * facts — `videoReviewJudgeService.serverVideoReviewEvidenceFromSubmission` 이 이미
 * `submission.youtubeMetadata.*` 를 읽는데, 지금까지 이 필드를 쓰는 producer 가 없어서 두 룰이
 * 항상 unknown 이었다. R2/R6/R8/R9/R15 처럼 integrityHash 로 봉인된 신뢰 envelope 에는 넣지
 * 않는다 — envelope 스키마는 closed(facts.length·hasOnlyKeys 고정)라 룰을 추가하려면 서명 계약
 * 자체를 바꿔야 하고, 그건 이 티켓의 최소 변경 범위를 넘는다. 대신 기존 판정 경로가 이미 보는
 * 평문 필드를 채우는 최소 변경으로 갭을 막는다.
 */
export interface VideoReviewYouTubeMetadataFacts {
  privacyStatus: string | null;
  durationSeconds: number | null;
  regionRestriction: { allowed: string[]; blocked: string[] } | null;
  liveBroadcastContent: string | null;
  /** liveBroadcastContent 가 "none" 이 아니면 true 인 파생값 — 기존 판정 경로가 읽는 형태. */
  isLiveContent: boolean | null;
  fetchedAtIso: string;
}

export interface ProducedVideoReviewEvidence {
  envelope: VideoReviewEvidenceEnvelope;
  binding: VideoReviewEvidenceBinding;
  submissionPatch: {
    videoReviewEvidence: VideoReviewEvidenceEnvelope;
    videoReviewEvidenceBinding: VideoReviewEvidenceBinding;
    videoReviewEvidenceIdentityFingerprints: string[];
    youtubeMetadata?: VideoReviewYouTubeMetadataFacts;
  };
}

const SUMMARY_BY_CODE: Record<VideoReviewEvidenceCode, string> = {
  r2_assigned_destination_present: "the assigned title store destination is present and no unclassified store destination was found",
  r2_assigned_destination_missing: "the assigned title store destination is absent from the authoritative YouTube description",
  r2_unclassified_store_destination: "assigned destination is present, but an additional store destination could not be classified",
  r2_other_title_destination_present: "the description includes a store destination for another title in this program",
  r2_assignment_unavailable: "the creator-assigned title store destination is unavailable",
  r2_youtube_metadata_unavailable: "authoritative YouTube description metadata is unavailable",
  r6_exact_name_in_metadata: "the exact game name is present in authoritative title or description metadata",
  r6_media_scan_required: "the exact game name was not found in metadata; transcript or on-screen scan is still required",
  r6_youtube_metadata_unavailable: "authoritative YouTube title and description metadata is unavailable",
  r8_required_hashtags_present: "all required hashtags are present in the authoritative title or description text",
  r8_required_hashtags_not_in_text: "one or more required hashtags are absent from title/description text; on-screen placement cannot be ruled out by a text parser",
  r8_youtube_metadata_unavailable: "authoritative YouTube description metadata is unavailable",
  r9_disclosure_in_metadata: "program participation and sponsorship disclosure are present in authoritative metadata",
  r9_media_scan_required: "complete sponsorship disclosure was not found in metadata; transcript or on-screen scan is still required",
  r9_youtube_metadata_unavailable: "authoritative YouTube description metadata is unavailable",
  r15_duplicate_fingerprint_found: "a prior submission shares a comparable server-derived media fingerprint",
  r15_no_duplicate_in_complete_index: "the complete fingerprint index found no prior matching submission",
  r15_index_coverage_incomplete: "no duplicate was found, but historical fingerprint coverage is incomplete",
  r15_comparable_fingerprint_unavailable: "no comparable server-derived media fingerprint is available",
  r15_lookup_unavailable: "cross-submission fingerprint lookup is unavailable",
};

export const VIDEO_REVIEW_EVIDENCE_CODES_BY_RULE: Record<VideoReviewEvidenceRuleId, readonly VideoReviewEvidenceCode[]> = {
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
};

export const VIDEO_REVIEW_EVIDENCE_STATUS_BY_CODE: Record<VideoReviewEvidenceCode, VideoReviewRuleEvidenceStatus> = {
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

export async function produceVideoReviewEvidence(
  submission: Record<string, unknown>,
  options: ProduceVideoReviewEvidenceOptions = {},
): Promise<ProducedVideoReviewEvidence> {
  const nowIso = validIso(options.nowIso) || new Date().toISOString();
  const producedAtMs = Date.parse(nowIso);
  const programScope = options.programScope ?? videoReviewProgramScopeFromTrustedRecords({ submission });
  const identityFingerprints = videoReviewEvidenceIdentityFingerprints(submission);
  const sourceFingerprint = videoReviewEvidenceSourceFingerprint(submission, programScope);
  const facts: VideoReviewTrustedEvidenceFact[] = [];
  const failures = new Set<string>();
  const youtubeCandidate = videoReviewMediaCandidate(submission);
  const titleContext = resolveEvidenceTitleContext(programScope.canonicalProgramId, submission.gameId, options.registryOverride);
  // Task-94 갭①②: R3/R5 가 읽는 privacyStatus/duration/liveBroadcastContent 는 트러스트
  // envelope 밖의 평문 facts 라 아래에서 별도로 캡처한다(readYouTubeEvidenceInputs 결과 보존).
  let youtubeMetadataFacts: YouTubeEvidenceInputs | null = null;

  if (youtubeCandidate?.source === "youtube" && youtubeCandidate.videoId) {
    const youtubeInput = await readYouTubeEvidenceInputs(
      submission,
      youtubeCandidate.videoId,
      titleContext,
      options.youtubeApi,
      options.resolveAssignedLinks,
    );
    youtubeMetadataFacts = youtubeInput;
    youtubeInput.failures.forEach((failure) => failures.add(failure));
    facts.push(...youtubeFacts(youtubeInput, nowIso));
  } else {
    const inputFingerprint = sha256("youtube_target_unavailable");
    facts.push(
      fact("R2", "unknown", 0, "r2_youtube_metadata_unavailable", "youtube_data_api_v3", nowIso, inputFingerprint),
      fact("R6", "unknown", 0, "r6_youtube_metadata_unavailable", "youtube_data_api_v3", nowIso, inputFingerprint),
      fact("R8", "unknown", 0, "r8_youtube_metadata_unavailable", "youtube_data_api_v3", nowIso, inputFingerprint),
      fact("R9", "unknown", 0, "r9_youtube_metadata_unavailable", "youtube_data_api_v3", nowIso, inputFingerprint),
    );
  }

  try {
    const duplicate = identityFingerprints.length > 0
      ? await (options.lookupDuplicate ?? defaultDuplicateLookup)({
        submissionId: cleanSubmissionId(submission.id ?? submission.submissionId),
        identityFingerprints,
        canonicalProgramId: programScope.canonicalProgramId,
        policyConfigHash: programScope.policyConfigHash,
      })
      : null;
    const inputFingerprint = duplicateLookupInputFingerprint(programScope, identityFingerprints);
    if (!duplicate) {
      facts.push(fact("R15", "unknown", 0, "r15_comparable_fingerprint_unavailable", "cross_submission_fingerprint_v1", nowIso, inputFingerprint));
    } else if (duplicate.duplicateFound) {
      facts.push(fact("R15", "failed", 1, "r15_duplicate_fingerprint_found", "cross_submission_fingerprint_v1", nowIso, inputFingerprint));
    } else if (duplicate.coverageComplete) {
      facts.push(fact("R15", "observed", 1, "r15_no_duplicate_in_complete_index", "cross_submission_fingerprint_v1", nowIso, inputFingerprint));
    } else {
      facts.push(fact("R15", "unknown", 0.7, "r15_index_coverage_incomplete", "cross_submission_fingerprint_v1", nowIso, inputFingerprint));
    }
  } catch {
    failures.add("duplicate_lookup_unavailable");
    facts.push(fact(
      "R15",
      "unknown",
      0,
      "r15_lookup_unavailable",
      "cross_submission_fingerprint_v1",
      nowIso,
      duplicateLookupInputFingerprint(programScope, identityFingerprints),
    ));
  }

  const unsigned = canonicalUnsignedEnvelope({
    schema: VIDEO_REVIEW_EVIDENCE_SCHEMA,
    policyVersion: VIDEO_REVIEW_POLICY_VERSION,
    programScopeVersion: programScope.scopeVersion,
    canonicalProgramId: programScope.canonicalProgramId,
    policyConfigHash: programScope.policyConfigHash,
    sourceFingerprint,
    outboxSourceFingerprint: cleanOutboxFingerprint(options.outboxSourceFingerprint) || null,
    producedAtIso: nowIso,
    expiresAtIso: new Date(producedAtMs + VIDEO_REVIEW_EVIDENCE_TTL_MS).toISOString(),
    identityFingerprints,
    facts,
    producerFailures: [...failures].sort(),
  });
  const envelope: VideoReviewEvidenceEnvelope = {
    ...unsigned,
    integrityHash: sha256(JSON.stringify(unsigned)),
  };
  const binding: VideoReviewEvidenceBinding = Object.freeze({
    canonicalProgramId: programScope.canonicalProgramId,
    policyConfigHash: programScope.policyConfigHash,
    sourceFingerprint,
  });
  // Task-94 갭①②: 메타데이터를 실제로 읽어온(metadataAvailable) 경우에만 채운다 — 부재/실패를
  // "모든 필드 null" 이 아니라 필드 자체를 안 실어 구분한다(호출부가 존재 유무로 unknown 을 판정).
  const youtubeMetadataPatch = youtubeMetadataFacts?.metadataAvailable
    ? {
        youtubeMetadata: {
          privacyStatus: youtubeMetadataFacts.privacyStatus || null,
          durationSeconds: youtubeMetadataFacts.durationSeconds,
          regionRestriction: youtubeMetadataFacts.regionRestriction,
          liveBroadcastContent: youtubeMetadataFacts.liveBroadcastContent || null,
          isLiveContent: youtubeMetadataFacts.liveBroadcastContent
            ? youtubeMetadataFacts.liveBroadcastContent !== "none"
            : null,
          fetchedAtIso: nowIso,
        } satisfies VideoReviewYouTubeMetadataFacts,
      }
    : {};

  return {
    envelope,
    binding,
    submissionPatch: {
      videoReviewEvidence: envelope,
      videoReviewEvidenceBinding: binding,
      videoReviewEvidenceIdentityFingerprints: identityFingerprints,
      ...youtubeMetadataPatch,
    },
  };
}

export function trustedVideoReviewEvidenceEnvelope(
  submission: Record<string, unknown>,
  options: { programScope?: VideoReviewProgramScope; nowIso?: string } = {},
): VideoReviewEvidenceEnvelope | null {
  let programScope: VideoReviewProgramScope;
  try {
    programScope = options.programScope ?? videoReviewProgramScopeFromTrustedRecords({ submission });
  } catch {
    return null;
  }
  return validateVideoReviewEvidenceEnvelope(submission.videoReviewEvidence, {
    sourceFingerprint: videoReviewEvidenceSourceFingerprint(submission, programScope),
    identityFingerprints: videoReviewEvidenceIdentityFingerprints(submission),
    canonicalProgramId: programScope.canonicalProgramId,
    policyConfigHash: programScope.policyConfigHash,
    nowIso: options.nowIso,
  });
}

export function validateVideoReviewEvidenceEnvelope(
  value: unknown,
  input: {
    sourceFingerprint: string;
    identityFingerprints?: string[];
    canonicalProgramId?: string;
    policyConfigHash?: string;
    nowIso?: string;
  },
): VideoReviewEvidenceEnvelope | null {
  const raw = asRecord(value);
  if (!hasOnlyKeys(raw, VIDEO_REVIEW_EVIDENCE_ENVELOPE_KEYS)) return null;
  if (raw.schema !== VIDEO_REVIEW_EVIDENCE_SCHEMA || raw.policyVersion !== VIDEO_REVIEW_POLICY_VERSION) return null;
  if (raw.programScopeVersion !== VIDEO_REVIEW_PROGRAM_SCOPE_VERSION) return null;
  const canonicalProgramId = cleanCanonicalProgramId(raw.canonicalProgramId);
  if (!canonicalProgramId || canonicalProgramId !== raw.canonicalProgramId) return null;
  const expectedCanonicalProgramId = cleanCanonicalProgramId(input.canonicalProgramId);
  if (input.canonicalProgramId !== undefined && !expectedCanonicalProgramId) return null;
  if (expectedCanonicalProgramId && canonicalProgramId !== expectedCanonicalProgramId) return null;
  const policyConfigHash = cleanHash(raw.policyConfigHash);
  if (!policyConfigHash) return null;
  const expectedPolicyConfigHash = cleanHash(input.policyConfigHash);
  if (input.policyConfigHash !== undefined && !expectedPolicyConfigHash) return null;
  if (expectedPolicyConfigHash && policyConfigHash !== expectedPolicyConfigHash) return null;
  const sourceFingerprint = cleanHash(raw.sourceFingerprint);
  const expectedSourceFingerprint = cleanHash(input.sourceFingerprint);
  if (!sourceFingerprint || sourceFingerprint !== expectedSourceFingerprint) return null;
  const producedAtIso = strictIso(raw.producedAtIso);
  const expiresAtIso = strictIso(raw.expiresAtIso);
  const now = Date.parse(validIso(input.nowIso) || new Date().toISOString());
  if (!producedAtIso || !expiresAtIso) return null;
  if (Date.parse(producedAtIso) > now + FUTURE_SKEW_MS || Date.parse(expiresAtIso) <= now) return null;
  if (Date.parse(expiresAtIso) <= Date.parse(producedAtIso)) return null;
  if (Date.parse(expiresAtIso) - Date.parse(producedAtIso) > VIDEO_REVIEW_EVIDENCE_TTL_MS) return null;

  if (!Array.isArray(raw.identityFingerprints) || raw.identityFingerprints.some((item) => typeof item !== "string")) return null;
  const rawIdentityFingerprints = raw.identityFingerprints;
  const identityFingerprints = rawIdentityFingerprints.map(cleanHash).filter(Boolean);
  if (identityFingerprints.length !== rawIdentityFingerprints.length) return null;
  if (identityFingerprints.some((fingerprint) => !HASH_PATTERN.test(fingerprint))) return null;
  if (new Set(identityFingerprints).size !== identityFingerprints.length) return null;
  const expectedIdentityFingerprints = input.identityFingerprints?.map(cleanHash).filter(Boolean).sort();
  if (expectedIdentityFingerprints && JSON.stringify([...identityFingerprints].sort()) !== JSON.stringify(expectedIdentityFingerprints)) return null;
  if (!Array.isArray(raw.producerFailures) || raw.producerFailures.some((item) => typeof item !== "string")) return null;
  const producerFailures = raw.producerFailures;
  if (producerFailures.some((failure) => !PRODUCER_FAILURE_CODES.has(failure))) return null;
  if (new Set(producerFailures).size !== producerFailures.length) return null;
  const facts = parseFacts(raw.facts);
  if (!facts || new Set(facts.map((item) => item.ruleId)).size !== facts.length) return null;
  if (facts.length !== VIDEO_REVIEW_EVIDENCE_TRUSTED_RULE_IDS.length) return null;
  if (facts.some((item) => item.observedAtIso !== producedAtIso)) return null;

  const rawOutboxSourceFingerprint = raw.outboxSourceFingerprint;
  if (rawOutboxSourceFingerprint !== null
    && (typeof rawOutboxSourceFingerprint !== "string" || !cleanOutboxFingerprint(rawOutboxSourceFingerprint))) return null;

  const unsigned = canonicalUnsignedEnvelope({
    schema: VIDEO_REVIEW_EVIDENCE_SCHEMA,
    policyVersion: VIDEO_REVIEW_POLICY_VERSION,
    programScopeVersion: VIDEO_REVIEW_PROGRAM_SCOPE_VERSION,
    canonicalProgramId,
    policyConfigHash,
    sourceFingerprint,
    outboxSourceFingerprint: cleanOutboxFingerprint(rawOutboxSourceFingerprint) || null,
    producedAtIso,
    expiresAtIso,
    identityFingerprints,
    facts,
    producerFailures,
  });
  const integrityHash = cleanHash(raw.integrityHash);
  if (!integrityHash || integrityHash !== sha256(JSON.stringify(unsigned))) return null;
  return { ...unsigned, integrityHash };
}

export function videoReviewEvidenceIdentityFingerprints(submission: Record<string, unknown>): string[] {
  const fingerprints = new Set<string>();
  const candidate = videoReviewMediaCandidate(submission);
  if (candidate?.source === "youtube" && candidate.videoId) {
    fingerprints.add(sha256(`youtube-video:${candidate.videoId}`));
  }
  const media = asRecord(submission.uploadedMedia);
  const md5Hash = asString(media.md5Hash).trim();
  if (md5Hash) fingerprints.add(sha256(`gcs-md5:${md5Hash}`));
  const sha256Hash = asString(media.sha256Hash).trim();
  if (sha256Hash) fingerprints.add(sha256(`gcs-sha256:${sha256Hash}`));
  const verifiedFingerprint = cleanHash(media.fingerprint);
  if (verifiedFingerprint) fingerprints.add(sha256(`verified-media:${verifiedFingerprint}`));
  if (candidate?.source === "gcs" && candidate.candidateFingerprint) {
    fingerprints.add(sha256(`gcs-object:${candidate.candidateFingerprint}:${asString(candidate.generation)}`));
  }
  return [...fingerprints].sort();
}

export function videoReviewEvidenceSourceFingerprint(
  submission: Record<string, unknown>,
  programScope: VideoReviewProgramScope = videoReviewProgramScopeFromTrustedRecords({ submission }),
): string {
  const creatorLinkRef = asString(submission.creatorLinkRef).trim();
  const payload = {
    identityFingerprints: videoReviewEvidenceIdentityFingerprints(submission),
    creatorLinkRefFingerprint: creatorLinkRef ? sha256(`creator-link-ref:${creatorLinkRef}`) : "",
    submittedAtIso: validIso(submission.submittedAtIso) || "",
    resubmissionCount: nonNegativeInteger(submission.resubmissionCount),
  };
  return videoReviewScopedFingerprint("evidence-source", programScope, payload);
}

export function videoReviewEvidenceSummary(code: unknown): string {
  return typeof code === "string" && code in SUMMARY_BY_CODE
    ? SUMMARY_BY_CODE[code as VideoReviewEvidenceCode]
    : "trusted evidence unavailable";
}

function youtubeFacts(input: YouTubeEvidenceInputs, nowIso: string): VideoReviewTrustedEvidenceFact[] {
  if (!input.metadataAvailable) {
    return [
      fact("R2", "unknown", 0, "r2_youtube_metadata_unavailable", "youtube_data_api_v3", nowIso, input.inputFingerprint),
      fact("R6", "unknown", 0, "r6_youtube_metadata_unavailable", "youtube_data_api_v3", nowIso, input.inputFingerprint),
      fact("R8", "unknown", 0, "r8_youtube_metadata_unavailable", "youtube_data_api_v3", nowIso, input.inputFingerprint),
      fact("R9", "unknown", 0, "r9_youtube_metadata_unavailable", "youtube_data_api_v3", nowIso, input.inputFingerprint),
    ];
  }

  const facts: VideoReviewTrustedEvidenceFact[] = [];
  if (!input.assignmentAvailable) {
    facts.push(fact("R2", "unknown", 0, "r2_assignment_unavailable", "youtube_data_api_v3", nowIso, input.inputFingerprint));
  } else if (input.hasOtherTitleDestination) {
    // Multi-title program (2026-09-05): a description that links another registered title's
    // store/branded destination is a decisive R2 violation regardless of whether this title's own
    // assigned link is also present — cross-promoting a sibling title's store link is exactly the
    // "must not include a store destination for any other title in this program" rule text.
    facts.push(fact("R2", "failed", 1, "r2_other_title_destination_present", "youtube_data_api_v3", nowIso, input.inputFingerprint));
  } else if (!input.assignedDestinationPresent) {
    // W107 T2: the guide only requires "the target game's store link", not the specific
    // OneLink/Adjust tracking destination — requiring an exact assigned-link match is a
    // documented rule/guide drift (diagnosis doc R2 section). A creator who followed the guide
    // and posted a plain Play/App Store link (or any other store-like link) is demoted to
    // unknown rather than hard-failed; only a genuinely link-free description stays failed.
    facts.push(input.hasUnclassifiedStoreDestination
      ? fact("R2", "unknown", 0.7, "r2_unclassified_store_destination", "youtube_data_api_v3", nowIso, input.inputFingerprint)
      : fact("R2", "failed", 1, "r2_assigned_destination_missing", "youtube_data_api_v3", nowIso, input.inputFingerprint));
  } else if (input.hasUnclassifiedStoreDestination) {
    facts.push(fact("R2", "unknown", 0.7, "r2_unclassified_store_destination", "youtube_data_api_v3", nowIso, input.inputFingerprint));
  } else {
    facts.push(fact("R2", "observed", 1, "r2_assigned_destination_present", "youtube_data_api_v3", nowIso, input.inputFingerprint));
  }

  facts.push(input.exactNamePresent
    ? fact("R6", "observed", 1, "r6_exact_name_in_metadata", "youtube_data_api_v3", nowIso, input.inputFingerprint)
    : fact("R6", "unknown", 0.6, "r6_media_scan_required", "youtube_data_api_v3", nowIso, input.inputFingerprint));
  // W107 T1: a text-parser miss is never a hard fail — the guide accepts the hashtags "in the
  // video or description" and on-screen placement is invisible to this deterministic parser.
  // Only a confirmed text match yields a decisive "observed"; absence demotes to "unknown" and
  // routes to the human gate instead of an automatic rejection (see diagnosis doc R8 section).
  facts.push(input.requiredHashtagsPresent
    ? fact("R8", "observed", 1, "r8_required_hashtags_present", "youtube_data_api_v3", nowIso, input.inputFingerprint)
    : fact("R8", "unknown", 0.6, "r8_required_hashtags_not_in_text", "youtube_data_api_v3", nowIso, input.inputFingerprint));
  facts.push(input.disclosurePresent
    ? fact("R9", "observed", 1, "r9_disclosure_in_metadata", "youtube_data_api_v3", nowIso, input.inputFingerprint)
    : fact("R9", "unknown", 0.6, "r9_media_scan_required", "youtube_data_api_v3", nowIso, input.inputFingerprint));
  return facts;
}

type YouTubeEvidenceInputs = {
  metadataAvailable: boolean;
  assignmentAvailable: boolean;
  assignedDestinationPresent: boolean;
  hasUnclassifiedStoreDestination: boolean;
  hasOtherTitleDestination: boolean;
  exactNamePresent: boolean;
  requiredHashtagsPresent: boolean;
  disclosurePresent: boolean;
  inputFingerprint: string;
  failures: string[];
  // Task-94 갭①②: R3/R5 가 읽는 평문 facts(트러스트 envelope 밖).
  privacyStatus: string;
  durationSeconds: number | null;
  regionRestriction: { allowed: string[]; blocked: string[] } | null;
  liveBroadcastContent: string;
};

/**
 * The submission's resolved program title plus everything R2/R6/R8 need to judge it — resolved
 * once per `produceVideoReviewEvidence` call from the program title registry (seed, or the
 * Firestore override where already loaded upstream). Adding a title is one seed entry; nothing
 * here branches on a title id or name.
 */
type EvidenceTitleContext = {
  ownTitle: ProgramTitle;
  otherTitles: readonly ProgramTitle[];
  requiredHashtags: readonly string[];
};

function resolveEvidenceTitleContext(
  canonicalProgramId: unknown,
  declaredGameId: unknown,
  registryOverride?: unknown,
): EvidenceTitleContext {
  const registry = resolveProgramTitlesOrDefault(canonicalProgramId, registryOverride);
  // resolveProgramTitlesOrDefault always falls back to the SCP registry (>=1 title, xp-hero
  // default) when the resolved program has none registered, so `ownTitle` is never actually
  // undefined here — the `registry.titles[0]` disjunct only guards a hypothetically empty seed.
  const ownTitle = resolveProgramTitle(registry, declaredGameId) ?? defaultProgramTitle(registry) ?? registry.titles[0];
  return {
    ownTitle,
    otherTitles: otherProgramTitles(registry, ownTitle.id),
    requiredHashtags: requiredHashtagsForTitle(registry, ownTitle).map((tag) => tag.replace(/^#/, "").toLowerCase()),
  };
}

async function readYouTubeEvidenceInputs(
  submission: Record<string, unknown>,
  videoId: string,
  title: EvidenceTitleContext,
  apiOverride?: VideoReviewEvidenceYouTubeApi,
  assignedLinksOverride?: ProduceVideoReviewEvidenceOptions["resolveAssignedLinks"],
): Promise<YouTubeEvidenceInputs> {
  const failures = new Set<string>();
  let videoTitle = "";
  let description = "";
  let metadataAvailable = false;
  // Task-94 갭①②: videosList 가 status/contentDetails 를 요청해 놓고 지금까지 아무도 소비하지
  // 않던 필드들 — R3(공개 상태)/R5(최소 길이)의 유일한 producer 다.
  let privacyStatus = "";
  let durationSeconds: number | null = null;
  let regionRestriction: { allowed: string[]; blocked: string[] } | null = null;
  let liveBroadcastContent = "";
  try {
    const api = apiOverride ?? makeYouTubeDataApiClient();
    const response = await api.videosList({ part: "snippet,status,contentDetails", id: videoId, maxResults: 1 });
    const item = response.items?.find((candidate) => asString(candidate.id) === videoId) as VideoReviewEvidenceYouTubeItem | undefined;
    if (item) {
      videoTitle = boundedText(item.snippet?.title, 10_000);
      description = boundedText(item.snippet?.description, 100_000);
      privacyStatus = boundedText(item.status?.privacyStatus, 40).toLowerCase();
      durationSeconds = parseYouTubeDurationSecondsOrNull(item.contentDetails?.duration);
      const allowed = item.contentDetails?.regionRestriction?.allowed;
      const blocked = item.contentDetails?.regionRestriction?.blocked;
      regionRestriction = Array.isArray(allowed) || Array.isArray(blocked)
        ? {
          allowed: Array.isArray(allowed) ? allowed.filter((code): code is string => typeof code === "string") : [],
          blocked: Array.isArray(blocked) ? blocked.filter((code): code is string => typeof code === "string") : [],
        }
        : null;
      liveBroadcastContent = boundedText(item.snippet?.liveBroadcastContent, 20).toLowerCase();
      metadataAvailable = true;
    } else {
      failures.add("youtube_video_not_found");
    }
  } catch {
    failures.add("youtube_metadata_unavailable");
  }

  let assignment: VideoReviewAssignedLinks = { available: false, links: [] };
  try {
    assignment = await (assignedLinksOverride ?? defaultAssignedLinksResolver)(submission);
  } catch {
    failures.add("creator_assignment_lookup_unavailable");
  }
  const normalizedAssignedLinks = assignment.links.map(canonicalDestination).filter(Boolean);
  const descriptionLinks = extractDescriptionLinks(description);
  const assignedDestinationPresent = normalizedAssignedLinks.some((link) => descriptionLinks.includes(link));
  // Multi-title program (2026-09-05): classify every store-like link in the description against
  // this submission's own title and every OTHER registered title, instead of a single hardcoded
  // "XP Hero branded domain" allowlist. Raw (non-search-stripped) links are used here \u2014 unlike
  // `descriptionLinks` above, which strips query strings to dedup per-share OneLink/Adjust
  // parameters \u2014 because Play/App Store links from different titles share the same host
  // (play.google.com) and are only distinguishable by their app-id query/path (see
  // `canonicalStoreDestination`).
  const rawStoreLikeLinks = extractRawStoreLikeLinks(description);
  const notAssigned = (link: string) => !normalizedAssignedLinks.includes(canonicalDestination(link));
  const hasOtherTitleDestination = rawStoreLikeLinks.some((link) => (
    notAssigned(link)
    && !linkBelongsToTitle(link, title.ownTitle)
    && title.otherTitles.some((other) => linkBelongsToTitle(link, other))
  ));
  const hasUnclassifiedStoreDestination = rawStoreLikeLinks.some((link) => (
    notAssigned(link)
    && !linkBelongsToTitle(link, title.ownTitle)
    && !title.otherTitles.some((other) => linkBelongsToTitle(link, other))
  ));
  const exactNamePresent = titleNamePattern(title.ownTitle.name).test(`${videoTitle}\n${description}`);
  // W107 T1: hashtags can be posted in the title as well as the description (the guide says
  // "video or description"), so R8 must scan combinedText, not description alone. The R6 exact-
  // name check above already reads combinedText and left R8 on a narrower, asymmetric source.
  // The full-width hash character U+FF03 is a common mobile-IME substitute for "#" and is
  // normalized so it is not silently missed. Token matching stays an exact match (no prefix
  // relaxation) so a near-miss like "#supercentgames" is not counted as "#supercent".
  const hashtagSourceText = `${videoTitle}\n${description}`.replace(/\uff03/g, "#");
  const hashtags = new Set([...hashtagSourceText.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((match) => match[1].toLowerCase()));
  const requiredHashtagsPresent = title.requiredHashtags.every((hashtag) => hashtags.has(hashtag));
  const programMention = hashtags.has("supercreatorpartners")
    || /super\s*creator\s*partners|\bscp\s+(?:program|partner|campaign)/iu.test(description);
  const sponsorshipMention = /(?:^|[^\p{L}\p{N}_])#(?:ad|ads|sponsored|sponsorship|advertisement)(?=$|[^\p{L}\p{N}_])|paid\s+(?:promotion|partnership)|sponsored\s+by|advertis(?:ement|ing)|광고|협찬|유료\s*프로모션|werbung|publicit[ée]|sponsoris[ée]|pubblicit[aà]|patrocinad[oa]|publicidad|реклама|โฆษณา|quảng\s*cáo|bersponsor|إعلان/iu.test(description);
  const disclosurePresent = programMention && sponsorshipMention;
  const inputFingerprint = sha256(JSON.stringify({
    video: sha256(`youtube-video:${videoId}`),
    title: sha256(videoTitle),
    description: sha256(description),
    assignments: normalizedAssignedLinks.map((link) => sha256(link)).sort(),
  }));
  return {
    metadataAvailable,
    assignmentAvailable: assignment.available && normalizedAssignedLinks.length > 0,
    assignedDestinationPresent,
    hasUnclassifiedStoreDestination,
    hasOtherTitleDestination,
    exactNamePresent,
    requiredHashtagsPresent,
    disclosurePresent,
    inputFingerprint,
    failures: [...failures].sort(),
    privacyStatus,
    durationSeconds,
    regionRestriction,
    liveBroadcastContent,
  };
}

async function defaultAssignedLinksResolver(submission: Record<string, unknown>): Promise<VideoReviewAssignedLinks> {
  const ref = asString(submission.creatorLinkRef).trim();
  const match = /^creator_links\/([^/]+)$/.exec(ref);
  if (!match) return { available: false, links: [] };
  const snapshot = await adminDb.collection("creator_links").doc(match[1]).get();
  if (!snapshot.exists || asString(snapshot.get("status"), "active") !== "active") return { available: false, links: [] };
  return {
    available: true,
    links: [snapshot.get("appsflyerOneLink"), snapshot.get("adjustLink")]
      .map((value) => asString(value).trim())
      .filter(Boolean),
  };
}

async function defaultDuplicateLookup(input: {
  submissionId: string;
  identityFingerprints: string[];
  canonicalProgramId: string;
  policyConfigHash: string;
}): Promise<VideoReviewDuplicateLookupResult> {
  for (const fingerprint of input.identityFingerprints) {
    const snapshot = await adminDb.collection("submissions")
      .where(VIDEO_REVIEW_EVIDENCE_IDENTITY_FIELD, "array-contains", fingerprint)
      .limit(25)
      .get();
    for (const doc of snapshot.docs) {
      if (doc.id === input.submissionId) continue;
      const candidateScope = await resolveAuthoritativeVideoReviewProgramScope({
        id: doc.id,
        ...(doc.data() ?? {}),
      });
      if (sameVideoReviewProgramScope(candidateScope, input)) {
        return { duplicateFound: true, coverageComplete: false };
      }
    }
  }
  // Existing historical submissions are not assumed to be backfilled. A clean lookup is
  // therefore unknown rather than a synthetic "not duplicate" observation.
  return { duplicateFound: false, coverageComplete: false };
}

function fact(
  ruleId: VideoReviewEvidenceRuleId,
  status: VideoReviewRuleEvidenceStatus,
  confidence: number,
  code: VideoReviewEvidenceCode,
  provider: VideoReviewEvidenceProvider,
  observedAtIso: string,
  inputFingerprint: string,
): VideoReviewTrustedEvidenceFact {
  return { ruleId, status, confidence, code, provider, observedAtIso, inputFingerprint };
}

function canonicalUnsignedEnvelope(input: Omit<VideoReviewEvidenceEnvelope, "integrityHash">): Omit<VideoReviewEvidenceEnvelope, "integrityHash"> {
  return {
    schema: VIDEO_REVIEW_EVIDENCE_SCHEMA,
    policyVersion: VIDEO_REVIEW_POLICY_VERSION,
    programScopeVersion: input.programScopeVersion,
    canonicalProgramId: input.canonicalProgramId,
    policyConfigHash: input.policyConfigHash,
    sourceFingerprint: input.sourceFingerprint,
    outboxSourceFingerprint: input.outboxSourceFingerprint,
    producedAtIso: input.producedAtIso,
    expiresAtIso: input.expiresAtIso,
    identityFingerprints: [...input.identityFingerprints].sort(),
    facts: [...input.facts]
      .map((item) => ({ ...item }))
      .sort((left, right) => left.ruleId.localeCompare(right.ruleId)),
    producerFailures: [...input.producerFailures].sort(),
  };
}

function parseFacts(value: unknown): VideoReviewTrustedEvidenceFact[] | null {
  if (!Array.isArray(value)) return null;
  const facts: VideoReviewTrustedEvidenceFact[] = [];
  for (const candidate of value) {
    const row = asRecord(candidate);
    if (!hasOnlyKeys(row, VIDEO_REVIEW_EVIDENCE_FACT_KEYS)) return null;
    const ruleId = asString(row.ruleId) as VideoReviewEvidenceRuleId;
    const status = asString(row.status) as VideoReviewRuleEvidenceStatus;
    const code = asString(row.code) as VideoReviewEvidenceCode;
    const provider = asString(row.provider) as VideoReviewEvidenceProvider;
    const observedAtIso = validIso(row.observedAtIso);
    const inputFingerprint = cleanHash(row.inputFingerprint);
    const confidence = Number(row.confidence);
    if (!(VIDEO_REVIEW_EVIDENCE_TRUSTED_RULE_IDS as readonly string[]).includes(ruleId)) return null;
    if (!VIDEO_REVIEW_EVIDENCE_CODES_BY_RULE[ruleId].includes(code)) return null;
    if (!(["observed", "unknown", "failed"] as const).includes(status)) return null;
    if (VIDEO_REVIEW_EVIDENCE_STATUS_BY_CODE[code] !== status) return null;
    if (provider !== (ruleId === "R15" ? "cross_submission_fingerprint_v1" : "youtube_data_api_v3")) return null;
    if (!observedAtIso || !inputFingerprint || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
    facts.push({ ruleId, status, confidence, code, provider, observedAtIso, inputFingerprint });
  }
  return facts;
}

function rawDescriptionLinks(value: string): string[] {
  const matches = value.match(/https?:\/\/[^\s<>"'()[\]{}]+/giu) ?? [];
  return [...new Set(matches.map((match) => match.replace(/[.,!?;:]+$/g, "")))];
}

function extractDescriptionLinks(value: string): string[] {
  return [...new Set(rawDescriptionLinks(value).map(canonicalDestination).filter(Boolean))].sort();
}

/** Raw (query preserved), store-like links only — the input to per-title destination matching. */
function extractRawStoreLikeLinks(value: string): string[] {
  return rawDescriptionLinks(value).filter(storeLikeDestination);
}

function canonicalDestination(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) return "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";
    parsed.search = "";
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.origin}${path}`;
  } catch {
    return "";
  }
}

// Multi-title program (2026-09-05): unlike canonicalDestination (which strips the query string to
// dedup per-share OneLink/Adjust tracking parameters), this keeps the store's own app-id query
// (Play Store `?id=`) so titles that share a generic app-store host (every Android title resolves
// through play.google.com) remain distinguishable by which app they actually point at. App Store
// links encode the app id in the path already, so the query-less fallback below covers them too.
function canonicalStoreDestination(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) return "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    const id = parsed.searchParams.get("id");
    return id ? `${parsed.origin}${path}?id=${id.toLowerCase()}` : `${parsed.origin}${path}`;
  } catch {
    return "";
  }
}

function hostnameOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function storeLikeDestination(value: string): boolean {
  const host = hostnameOf(value);
  if (!host) return false;
  return host === "play.google.com"
    || host === "apps.apple.com"
    || host === "app.appsflyer.com"
    || host === "onelink.me"
    || host.endsWith(".onelink.me")
    || host === "go.link"
    || host.endsWith(".go.link");
}

/**
 * Does `link` belong to `programTitle`? Matches either an explicit branded domain (a known
 * OneLink/Adjust-style subdomain unique to the title, e.g. `xphero.onelink.me`) or the title's own
 * store URL (compared with the app id preserved — see `canonicalStoreDestination` — since a bare
 * hostname like `play.google.com` is shared by every title and cannot distinguish them).
 */
function linkBelongsToTitle(link: string, programTitle: ProgramTitle): boolean {
  const host = hostnameOf(link);
  if (host && (programTitle.brandedDomains ?? []).includes(host)) return true;
  const storeDestination = canonicalStoreDestination(programTitle.storeUrl);
  return Boolean(storeDestination) && canonicalStoreDestination(link) === storeDestination;
}

// Builds the R6 exact-name matcher from the resolved title's display name instead of a hardcoded
// "XP Hero" literal, so adding a title to functions/programTitles.seed.json is enough for its
// exact-name check to work — no per-title branch lives in this file.
function titleNamePattern(name: string): RegExp {
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const words = name.trim().split(/\s+/).filter(Boolean);
  const body = words.length > 0 ? words.map(escape).join("[\\s\\u00a0]+") : escape(name);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${body}(?=$|[^\\p{L}\\p{N}])`, "iu");
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowlist = new Set(allowed);
  return Object.keys(value).every((key) => allowlist.has(key));
}

function boundedText(value: unknown, max: number): string {
  return asString(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, max);
}

function cleanSubmissionId(value: unknown): string {
  return asString(value).replace(/^submissions\//, "").trim().split("/")[0];
}

function cleanHash(value: unknown): string {
  const normalized = asString(value).trim().toLowerCase();
  return HASH_PATTERN.test(normalized) ? normalized : "";
}

function cleanCanonicalProgramId(value: unknown): string {
  const raw = asString(value).trim();
  return raw ? resolveCanonicalProgramId(raw) : "";
}

function cleanOutboxFingerprint(value: unknown): string {
  const normalized = asString(value).trim().toLowerCase();
  return /^[a-f0-9]{32,64}$/.test(normalized) ? normalized : "";
}

function validIso(value: unknown): string {
  const raw = asString(value).trim();
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function strictIso(value: unknown): string {
  return typeof value === "string" && value === validIso(value) ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function nonNegativeInteger(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function duplicateLookupInputFingerprint(
  programScope: Pick<VideoReviewProgramScope, "canonicalProgramId" | "policyConfigHash">,
  identityFingerprints: string[],
): string {
  return videoReviewScopedFingerprint("evidence-duplicate-lookup", programScope, [...identityFingerprints].sort());
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
