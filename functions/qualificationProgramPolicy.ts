import { createHash } from "node:crypto";
import { resolveCanonicalProgramId } from "./programCanonical";
import { resolveQualificationLanguagePolicy } from "./qualificationLanguagePolicy";

export const QUALIFICATION_PROGRAM_POLICY_SCHEMA = "program_qualification_policy_v1";
export const QUALIFICATION_JUDGE_MODEL_TASK = "scp_qualification_judge";

const AUTOMATION_ACTIONS = [
  "ai_recommendation",
  "final_decision",
  "mail_send",
  "link_issue",
  "status_transition",
] as const;

export function qualificationProgramPolicyHash(
  canonicalProgramId: unknown,
  policySnapshot: Record<string, unknown>,
): string {
  const normalizedProgramId = resolveCanonicalProgramId(canonicalProgramId);
  if (!normalizedProgramId) return "";
  return sha256(JSON.stringify(stableJsonValue({
    schema: QUALIFICATION_PROGRAM_POLICY_SCHEMA,
    canonicalProgramId: normalizedProgramId,
    policy: boundedQualificationPolicyValue(policySnapshot),
  })));
}

export function resolveQualificationProgramPolicySnapshot(input: {
  canonicalProgramId: unknown;
  program: unknown;
  settings: unknown;
  modelId: unknown;
}): Record<string, unknown> {
  const canonicalProgramId = resolveCanonicalProgramId(input.canonicalProgramId);
  const program = asRecord(input.program);
  const programAi = asRecord(program.programAi);
  const qualificationPolicy = asRecord(program.qualificationPolicy);
  const automation = qualificationAutomationPolicySnapshot(input.settings);
  return boundedQualificationPolicyValue({
    schema: QUALIFICATION_PROGRAM_POLICY_SCHEMA,
    canonicalProgramId,
    modelTask: QUALIFICATION_JUDGE_MODEL_TASK,
    modelId: text(input.modelId, 200),
    program: {
      gameTitle: text(program.gameTitle, 160),
      tags: stringArray(program.tags),
      qualificationPolicy,
      qualificationConfig: asRecord(program.qualificationConfig),
      candidateCriteria: asRecord(program.candidateCriteria),
      eligibilityCriteria: asRecord(program.eligibilityCriteria),
      programAiQualification: asRecord(programAi.qualification),
    },
    languageGate: resolveQualificationLanguagePolicy(canonicalProgramId, qualificationPolicy),
    automation,
  }) as Record<string, unknown>;
}

export function qualificationApplicationScopeIdentityHash(input: {
  leadId: unknown;
  applicationId: unknown;
  rawProgramId: unknown;
  canonicalProgramId: unknown;
}): string {
  return sha256(JSON.stringify(stableJsonValue({
    leadId: text(input.leadId, 180),
    applicationId: text(input.applicationId, 180),
    rawProgramId: text(input.rawProgramId, 180),
    canonicalProgramId: resolveCanonicalProgramId(input.canonicalProgramId),
  })));
}

export function defaultLegacyScpProgramPolicySource(): Record<string, unknown> {
  // Legacy SCP language defaults are already normalized into the authoritative
  // `languageGate` snapshot by resolveQualificationLanguagePolicy(). Repeating
  // those defaults in the raw program policy makes an absent programs/scp doc
  // hash differently from an equivalent legacy/minimal document even though the
  // effective policy is identical. Keep the source minimal so materializing the
  // compatibility program cannot create a false policy-drift failure.
  return {
    gameTitle: "WeaponRPG",
    tags: [],
  };
}

function qualificationAutomationPolicySnapshot(value: unknown): Record<string, unknown> {
  const settings = asRecord(value);
  const stages = asRecord(settings.stages);
  const qualificationStage = normalizeStage(stages.qualification);
  return {
    stage: qualificationStage,
    autoPilotEnabled: settings.autoPilotEnabled === true,
    qualificationBacktest: normalizeQualificationBacktest(settings.lastBacktestPassedAt),
    countryConfidenceThreshold: normalizeThreshold(settings.countryConfidenceThreshold),
    countryGateBacktest: normalizeCountryGateBacktest(settings.countryGateBacktestPassedAt),
  };
}

function normalizeStage(value: unknown): Record<string, unknown> {
  const stage = asRecord(value);
  const actions = asRecord(stage.actions);
  const normalizedActions: Record<string, unknown> = {};
  for (const action of AUTOMATION_ACTIONS) {
    const gate = normalizeGate(asRecord(actions[action]).gate);
    if (gate) normalizedActions[action] = { gate };
  }
  return {
    mode: normalizeMode(stage.mode) ?? "human_assist",
    gate: normalizeGate(stage.gate) ?? "required",
    actions: normalizedActions,
  };
}

function normalizeQualificationBacktest(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const passedAtIso = normalizeIso(value);
    return passedAtIso ? { passedAtIso, readMode: null, rowCount: null, spreadsheetId: null } : null;
  }
  const stamp = asRecord(asRecord(value).qualification);
  const passedAtIso = normalizeIso(stamp.passedAtIso);
  if (!passedAtIso) return null;
  return {
    passedAtIso,
    readMode: stamp.readMode === "input_rows" || stamp.readMode === "sheets_api" ? stamp.readMode : null,
    rowCount: typeof stamp.rowCount === "number" && Number.isFinite(stamp.rowCount)
      ? Math.max(0, Math.floor(stamp.rowCount))
      : null,
    spreadsheetId: typeof stamp.spreadsheetId === "string" && stamp.spreadsheetId.trim()
      ? stamp.spreadsheetId.trim().slice(0, 200)
      : null,
  };
}

function normalizeCountryGateBacktest(value: unknown): Record<string, unknown> | null {
  const stamp = asRecord(value);
  const passedAtIso = normalizeIso(stamp.passedAtIso);
  const gateVersion = typeof stamp.gateVersion === "number" && Number.isFinite(stamp.gateVersion) ? stamp.gateVersion : null;
  const threshold = normalizeOptionalThreshold(stamp.threshold);
  return passedAtIso && gateVersion !== null && threshold !== null
    ? { passedAtIso, gateVersion, threshold }
    : null;
}

function normalizeMode(value: unknown): "human_assist" | "ai_assist" | "auto_ai" | null {
  return value === "human_assist" || value === "ai_assist" || value === "auto_ai" ? value : null;
}

function normalizeGate(value: unknown): "required" | "off" | null {
  return value === "required" || value === "off" ? value : null;
}

function normalizeThreshold(value: unknown): number {
  return normalizeOptionalThreshold(value) ?? 0.8;
}

function normalizeOptionalThreshold(value: unknown): number | null {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
}

function normalizeIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function boundedQualificationPolicyValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return null;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => boundedQualificationPolicyValue(item, depth + 1));
  if (!value || typeof value !== "object") {
    if (typeof value === "string") return value.replace(/\s+/g, " ").trim().slice(0, 500);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "boolean" || value === null) return value;
    return null;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !qualificationPolicyKeyIsPrivate(key))
      .slice(0, 100)
      .map(([key, child]) => [key.slice(0, 80), boundedQualificationPolicyValue(child, depth + 1)]),
  );
}

function qualificationPolicyKeyIsPrivate(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === "uid"
    || normalized === "userid"
    || normalized === "createdby"
    || normalized === "updatedby"
    || normalized === "owner"
    || normalized === "owneruid"
    || normalized === "owneremail"
    || normalized === "ownername"
    || normalized === "contactemail"
    || normalized === "contactname"
    || /(?:email|token|secret|credential|credentials|password|apikey|privatekey)$/.test(normalized);
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableJsonValue(child)]),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean).slice(0, 100) : [];
}

function text(value: unknown, max = 300): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
