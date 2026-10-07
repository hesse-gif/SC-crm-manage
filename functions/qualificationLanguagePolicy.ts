import { resolveCanonicalProgramId, SCP_CANONICAL_PROGRAM_ID } from "./programCanonical";

export const QUALIFICATION_LANGUAGE_POLICY_SCHEMA = "qualification_language_policy_v1" as const;

export const QUALIFICATION_LANGUAGE_CODES = [
  "en", "ko", "de", "ja", "zh", "fr", "it", "no", "da", "is", "nl", "sv",
  "ru", "he", "es", "fi", "pt", "th", "tr", "tl", "vi", "id", "hi", "ar",
  // Detectable languages that are not in the XP Hero default allow-list. A different
  // program may explicitly allow them, while XP Hero may confidently reject them.
  "bn", "ur", "ta", "te",
] as const;

export type QualificationLanguageCode = typeof QUALIFICATION_LANGUAGE_CODES[number];

// XP Hero policy supplied by the operator. Order is stable so the resolved policy/hash
// is deterministic across runs and program A/B comparisons.
export const XP_HERO_ALLOWED_LANGUAGE_CODES: readonly QualificationLanguageCode[] = [
  "en", "ko", "de", "ja", "zh", "fr", "it", "no", "da", "is", "nl", "sv",
  "ru", "he", "es", "fi", "pt", "th", "tr", "tl", "vi", "id", "hi", "ar",
] as const;

export type QualificationLanguagePolicySource =
  | "program_policy"
  | "legacy_scp_default"
  | "missing_program_policy"
  | "invalid_program_policy";

export interface QualificationLanguagePolicySnapshot {
  schema: typeof QUALIFICATION_LANGUAGE_POLICY_SCHEMA;
  configured: boolean;
  source: QualificationLanguagePolicySource;
  allowedLanguages: QualificationLanguageCode[];
  musicOnlyDisposition: "human_gate";
  uncertainEvidenceDisposition: "human_gate";
}

const LANGUAGE_CODE_SET = new Set<string>(QUALIFICATION_LANGUAGE_CODES);
const XP_HERO_ALLOWED_SET = new Set<string>(XP_HERO_ALLOWED_LANGUAGE_CODES);

const LANGUAGE_ALIASES: Readonly<Record<string, QualificationLanguageCode>> = {
  english: "en",
  korean: "ko",
  german: "de",
  japanese: "ja",
  chinese: "zh",
  mandarin: "zh",
  cantonese: "zh",
  "zh-cn": "zh",
  "zh-tw": "zh",
  french: "fr",
  italian: "it",
  norwegian: "no",
  nb: "no",
  nn: "no",
  danish: "da",
  icelandic: "is",
  dutch: "nl",
  swedish: "sv",
  russian: "ru",
  hebrew: "he",
  iw: "he",
  spanish: "es",
  finnish: "fi",
  portuguese: "pt",
  thai: "th",
  turkish: "tr",
  filipino: "tl",
  tagalog: "tl",
  fil: "tl",
  vietnamese: "vi",
  indonesian: "id",
  in: "id",
  hindi: "hi",
  arabic: "ar",
  bengali: "bn",
  urdu: "ur",
  tamil: "ta",
  telugu: "te",
};

export function normalizeQualificationLanguageCode(value: unknown): QualificationLanguageCode | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return null;
  if (LANGUAGE_CODE_SET.has(normalized)) return normalized as QualificationLanguageCode;
  return LANGUAGE_ALIASES[normalized] ?? null;
}

export function resolveQualificationLanguagePolicy(
  canonicalProgramId: unknown,
  qualificationPolicy: unknown,
): QualificationLanguagePolicySnapshot {
  const programId = resolveCanonicalProgramId(canonicalProgramId);
  const policy = asRecord(qualificationPolicy);
  const hasExplicitAllowedLanguages = Object.prototype.hasOwnProperty.call(policy, "allowedLanguages");

  if (hasExplicitAllowedLanguages) {
    const raw = policy.allowedLanguages;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) return invalidPolicy();
    const normalized = raw.map(normalizeQualificationLanguageCode);
    // Never partially accept a typo-filled policy: dropping only the unknown entries can
    // silently widen or narrow the operator's intent and turn an uncertain case into fail.
    if (normalized.some((language) => language === null)) return invalidPolicy();
    const allowedLanguages = uniqueSorted(normalized as QualificationLanguageCode[]);
    if (allowedLanguages.length === 0) return invalidPolicy();
    // The supplied XP Hero list is the broad legacy ceiling. A persisted SCP policy may
    // intentionally be narrower, but may not silently broaden it with an unrelated code.
    if (programId === SCP_CANONICAL_PROGRAM_ID && allowedLanguages.some((language) => !XP_HERO_ALLOWED_SET.has(language))) {
      return invalidPolicy();
    }
    return snapshot(true, "program_policy", allowedLanguages);
  }

  if (programId === SCP_CANONICAL_PROGRAM_ID) {
    return snapshot(true, "legacy_scp_default", [...XP_HERO_ALLOWED_LANGUAGE_CODES]);
  }
  // A non-SCP program without an exact allow-list is not allowed to borrow SCP policy.
  // Its audio evidence remains a human gate until the program is configured.
  return snapshot(false, "missing_program_policy", []);
}

export function qualificationLanguagePolicyFromResolvedSnapshot(
  policySnapshot: unknown,
): QualificationLanguagePolicySnapshot {
  const raw = asRecord(asRecord(policySnapshot).languageGate);
  if (raw.schema !== QUALIFICATION_LANGUAGE_POLICY_SCHEMA
    || raw.musicOnlyDisposition !== "human_gate"
    || raw.uncertainEvidenceDisposition !== "human_gate"
    || typeof raw.configured !== "boolean") {
    return invalidPolicy();
  }
  const source = raw.source;
  if (source !== "program_policy"
    && source !== "legacy_scp_default"
    && source !== "missing_program_policy"
    && source !== "invalid_program_policy") {
    return invalidPolicy();
  }
  if (!Array.isArray(raw.allowedLanguages)) return invalidPolicy();
  const normalized = raw.allowedLanguages.map(normalizeQualificationLanguageCode);
  if (normalized.some((language) => language === null)) return invalidPolicy();
  const allowedLanguages = uniqueSorted(normalized as QualificationLanguageCode[]);
  if (raw.configured && allowedLanguages.length === 0) return invalidPolicy();
  if (!raw.configured && allowedLanguages.length > 0) return invalidPolicy();
  if (source === "program_policy" && !raw.configured) return invalidPolicy();
  if (source === "legacy_scp_default"
    && (!raw.configured || !sameLanguageSet(allowedLanguages, XP_HERO_ALLOWED_LANGUAGE_CODES))) {
    return invalidPolicy();
  }
  if ((source === "missing_program_policy" || source === "invalid_program_policy") && raw.configured) {
    return invalidPolicy();
  }
  return snapshot(raw.configured, source, allowedLanguages);
}

function invalidPolicy(): QualificationLanguagePolicySnapshot {
  return snapshot(false, "invalid_program_policy", []);
}

function snapshot(
  configured: boolean,
  source: QualificationLanguagePolicySource,
  allowedLanguages: QualificationLanguageCode[],
): QualificationLanguagePolicySnapshot {
  return {
    schema: QUALIFICATION_LANGUAGE_POLICY_SCHEMA,
    configured,
    source,
    allowedLanguages,
    musicOnlyDisposition: "human_gate",
    uncertainEvidenceDisposition: "human_gate",
  };
}

function uniqueSorted(values: QualificationLanguageCode[]): QualificationLanguageCode[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameLanguageSet(
  left: readonly QualificationLanguageCode[],
  right: readonly QualificationLanguageCode[],
): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
