import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { ACCENT_PROMPT_VERSION } from "./creatorLanguageGate";
import {
  assertNonGuestAuth,
  asRecord,
  makeBehaviorLog,
  makeCache,
  makeCostLog,
  type BehaviorLog,
  type CallableRequestShape,
} from "./shared";
// 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate): READ_ROLES here includes
// viewer, but a viewer/manager/admin without an explicit scp grant must still not read/write
// this program's automation config — same explicit-allowlist source as
// getMyOrgContext.scpAccessGranted (functions/mailAccounts.ts), super_admin bypass included.
import { assertScpEntitled } from "./mailAccounts";

export const SCP_AUTOMATION_SETTINGS_DOC = "settings/scp_automation";
export const SCP_AUTOMATION_AUDIT_COLLECTION = "scp_automation_audit";
export const SCP_AUTOMATION_STAGES = ["qualification", "encouragement", "videoReview"] as const;
export const SCP_AUTOMATION_ACTIONS = [
  "ai_recommendation",
  "final_decision",
  "mail_send",
  "link_issue",
  "status_transition",
] as const;

export type ScpAutomationMode = "human_assist" | "ai_assist" | "auto_ai";
export type ScpAutomationGate = "required" | "off";
export type ScpAutomationStage = (typeof SCP_AUTOMATION_STAGES)[number];
export type ScpAutomationAction = (typeof SCP_AUTOMATION_ACTIONS)[number];

export interface ScpAutomationActionGate {
  gate: ScpAutomationGate;
}

export interface ScpAutomationStageSettings {
  mode: ScpAutomationMode;
  gate: ScpAutomationGate;
  actions: Partial<Record<ScpAutomationAction, ScpAutomationActionGate>>;
}

// A stage may only be read as backtest-approved when a real sheets_api backtest
// issued the stamp. input_rows-derived stamps (client-supplied rows) never grant
// approval — enforced on write (qualificationBacktestService) and re-checked here.
export type ScpAutomationBacktestReadMode = "input_rows" | "sheets_api";

export interface ScpAutomationBacktestStamp {
  passedAtIso: string | null;
  readMode: ScpAutomationBacktestReadMode | null;
  rowCount: number | null;
  spreadsheetId: string | null;
}

// Per-stage provenance stamps. A single stage's stamp must never unlock another
// stage (P0-5): the qualification backtest can only stamp `qualification`.
// `videoReview` stays unstamped until a dedicated Sheet3 report is reviewed and
// a human-owned approval stamp is applied outside the report generator.
export type ScpAutomationBacktestApprovals = Record<ScpAutomationStage, ScpAutomationBacktestStamp | null>;

// Red-team fix(S5 P5-a): a DEDICATED stamp for the country-confidence hard gate. The
// generic per-stage `lastBacktestPassedAt.qualification` stamp above (issued by
// qualificationBacktestService) only ever measures rejectionProbability threshold
// precision — it never exercises countryConfidence/countryGate at all. The hard gate's
// automatic-final-fail path must never trust that stamp; it requires this one instead.
// gateVersion/threshold are recorded at attestation time so a later accent-prompt change
// (ACCENT_PROMPT_VERSION bump) or a threshold edit silently invalidates the stamp
// (hasCountryGateBacktestApproval) rather than leaving a stale approval active.
export interface ScpCountryGateBacktestStamp {
  passedAtIso: string;
  gateVersion: number;
  threshold: number;
}

export interface ScpAutomationSettings {
  stages: Record<ScpAutomationStage, ScpAutomationStageSettings>;
  autoPilotEnabled: boolean;
  // Backtest-owned provenance stamps. Do not accept from settings update patches;
  // qualificationBacktestService is the only writer after thresholdLock.locked=true.
  lastBacktestPassedAt: ScpAutomationBacktestApprovals;
  // S5(P5) 인터뷰 #3 확정 hard gate threshold. 0..1, 기본 0.8. countryConfidence(accent
  // 가중 집계, creatorLanguageGate.ts)가 이 값 미만이면 자동 탈락. super_admin write만
  // 허용(SUPER_ADMIN_ONLY 게이트 재사용) — 오탈락 폭증 시 즉시 낮춰 완화 가능하도록 외부화.
  countryConfidenceThreshold: number;
  // Red-team fix(S5 P5-a). No automated writer exists yet (mirrors how videoReview's
  // generic stamp also has none) — a super_admin sets this manually via
  // updateScpAutomationSettings after reviewing an offline false-reject-rate analysis of
  // the country/accent gate. See hasCountryGateBacktestApproval for the validity check.
  countryGateBacktestPassedAt: ScpCountryGateBacktestStamp | null;
  updatedAtIso: string | null;
  updatedBy: string | null;
}

export const DEFAULT_COUNTRY_CONFIDENCE_THRESHOLD = 0.8;

type ScpAutomationStageSettingsPatch = Partial<Omit<ScpAutomationStageSettings, "actions">> & {
  actions?: Partial<Record<ScpAutomationAction, Partial<ScpAutomationActionGate>>>;
};

type ScpAutomationSettingsPatch = {
  stages?: Partial<Record<ScpAutomationStage, ScpAutomationStageSettingsPatch>>;
  autoPilotEnabled?: boolean;
  countryConfidenceThreshold?: number;
  countryGateBacktestPassedAt?: ScpCountryGateBacktestStamp | null;
};

export interface ScpGateDecision {
  stage: ScpAutomationStage | "unknown";
  action: ScpAutomationAction | "unknown";
  required: boolean;
  reason: string;
  mode: ScpAutomationMode;
  gate: ScpAutomationGate;
  backtestPassed: boolean;
}

export const DEFAULT_SCP_AUTOMATION_SETTINGS: ScpAutomationSettings = {
  stages: {
    qualification: { mode: "human_assist", gate: "required", actions: {} },
    encouragement: { mode: "human_assist", gate: "required", actions: {} },
    videoReview: { mode: "human_assist", gate: "required", actions: {} },
  },
  autoPilotEnabled: false,
  lastBacktestPassedAt: { qualification: null, encouragement: null, videoReview: null },
  countryConfidenceThreshold: DEFAULT_COUNTRY_CONFIDENCE_THRESHOLD,
  countryGateBacktestPassedAt: null,
  updatedAtIso: null,
  updatedBy: null,
};

const READ_ROLES = ["super_admin", "admin", "manager", "viewer"] as const;
const SUPER_ADMIN_ONLY = ["super_admin"] as const;
const CACHE_TTL_SECONDS = 600;

export async function getScpAutomationSettings(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_automation.settings.get", READ_ROLES);
  await assertScpEntitled(auth, request, "scp_automation.settings.get");
  const settings = await readScpAutomationSettings();
  return {
    ok: true,
    settings,
    // Red-team fix(S5 P5-c): expose the server-computed validity of the dedicated
    // country-gate stamp so the settings UI never has to re-derive it (and never
    // mis-renders a merely-truthy container object as "passed" again).
    countryGateBacktestValid: hasCountryGateBacktestApproval(settings),
    cache: makeCache("settings:scp_automation", false, CACHE_TTL_SECONDS),
    costLog: makeCostLog("scp_automation.settings.get", "mock-admin", false, 0),
    behaviorLog: makeBehaviorLog(auth, "scp_automation.settings.get", "success"),
  };
}

export async function updateScpAutomationSettings(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_automation.settings.update", SUPER_ADMIN_ONLY);
  await assertScpEntitled(auth, request, "scp_automation.settings.update");
  const patch = extractScpAutomationSettingsPatch(request.data);
  const current = await readScpAutomationSettings();
  const next = mergeScpAutomationSettings(current, patch, auth.userId);
  const updatedKeys = Object.keys(patch);
  const autoAiGate = validateAutoAiBacktestGate(next);

  if (!autoAiGate.allowed) {
    await adminDb.collection(SCP_AUTOMATION_AUDIT_COLLECTION).doc().set({
      action: "scp_automation.settings.update.blocked",
      reason: autoAiGate.reason,
      changedKeys: updatedKeys,
      before: current,
      after: next,
      updatedBy: auth.userId,
      role: auth.role,
      team: auth.team,
      gameId: auth.gameId,
      createdAtIso: next.updatedAtIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    const error = new Error(`failed-precondition: ${autoAiGate.reason}`);
    Object.assign(error, {
      code: "failed-precondition", errorCode: "update_scp_automation_settings_unauthorized",
      behaviorLog: makeBehaviorLog(auth, "scp_automation.settings.update", "blocked"),
      scpAutoAiGate: autoAiGate,
    });
    throw error;
  }

  await scpSettingsDoc().set({
    ...next,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: auth.userId,
  }, { merge: true });

  await adminDb.collection(SCP_AUTOMATION_AUDIT_COLLECTION).doc().set({
    action: "scp_automation.settings.update",
    changedKeys: updatedKeys,
    before: current,
    after: next,
    updatedBy: auth.userId,
    role: auth.role,
    team: auth.team,
    gameId: auth.gameId,
    createdAtIso: next.updatedAtIso,
    createdAt: FieldValue.serverTimestamp(),
  });

  return {
    ok: true,
    settings: next,
    countryGateBacktestValid: hasCountryGateBacktestApproval(next),
    updatedKeys,
    cache: makeCache("settings:scp_automation", false, CACHE_TTL_SECONDS),
    costLog: makeCostLog("scp_automation.settings.update", "mock-admin", false, 0),
    behaviorLog: makeBehaviorLog(auth, "scp_automation.settings.update", "success"),
  };
}

export async function readScpAutomationSettings(): Promise<ScpAutomationSettings> {
  const snapshot = await scpSettingsDoc().get();
  if (!snapshot.exists) {
    const initial = clone(DEFAULT_SCP_AUTOMATION_SETTINGS);
    await scpSettingsDoc().set({
      ...initial,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return initial;
  }
  return normalizeScpAutomationSettings(snapshot.data() ?? {});
}

export async function isHumanGateRequired(
  stage: unknown,
  action: unknown = "final_decision",
  settings?: ScpAutomationSettings | null,
): Promise<boolean> {
  try {
    const resolved = settings ?? await readScpAutomationSettings();
    return isHumanGateRequiredFromSettings(stage, action, resolved).required;
  } catch {
    return true;
  }
}

export function isHumanGateRequiredFromSettings(
  stage: unknown,
  action: unknown = "final_decision",
  settings: ScpAutomationSettings | null = DEFAULT_SCP_AUTOMATION_SETTINGS,
): ScpGateDecision {
  const normalized = normalizeScpAutomationSettings(settings ?? {});
  const validStage = toStage(stage);
  const validAction = toAction(action);
  if (!validStage || !validAction) {
    return {
      stage: validStage ?? "unknown",
      action: validAction ?? "unknown",
      required: true,
      reason: "invalid_stage_or_action_fail_safe_required",
      mode: "human_assist",
      gate: "required",
      backtestPassed: false,
    };
  }

  const stageConfig = normalized.stages[validStage];
  const gate = stageConfig.actions[validAction]?.gate ?? stageConfig.gate;
  const autoRequested = normalized.autoPilotEnabled === true && stageConfig.mode === "auto_ai" && gate === "off";
  const backtestPassed = hasScpAutomationBacktestApproval(validStage, normalized);
  const autoAllowed = autoRequested && backtestPassed;
  return {
    stage: validStage,
    action: validAction,
    required: !autoAllowed,
    reason: autoAllowed ? "auto_ai_gate_off_backtest_passed" : autoRequested ? "backtest_required_for_auto_ai" : "human_gate_required_fail_safe",
    mode: stageConfig.mode,
    gate,
    backtestPassed,
  };
}

export async function assertScpAutomationGateOff(
  request: CallableRequestShape,
  stage: unknown,
  action: unknown = "final_decision",
): Promise<ScpGateDecision> {
  const auth = assertNonGuestAuth(request, "scp_automation.gate.consume", ["super_admin", "admin", "manager"] as const);
  const settings = await readScpAutomationSettings();
  const decision = isHumanGateRequiredFromSettings(stage, action, settings);
  if (decision.required) {
    const behaviorLog: BehaviorLog = makeBehaviorLog(auth, "scp_automation.gate.consume", "blocked");
    const error = new Error(`failed-precondition: human gate required for ${decision.stage}/${decision.action}`);
    Object.assign(error, { code: "failed-precondition", errorCode: "assert_scp_automation_gate_off_human_gate_required", behaviorLog, scpGate: decision });
    throw error;
  }
  return decision;
}

function scpSettingsDoc() {
  return adminDb.doc(SCP_AUTOMATION_SETTINGS_DOC);
}

// Per-stage backtest approval. `settings` is optional so a caller that has not
// loaded settings (or passes an undefined context) fails safe to "not approved"
// — the gate then requires a human, which is the safe direction. A stamp only
// counts when it carries a passedAtIso and was NOT issued from client input_rows.
export function hasScpAutomationBacktestApproval(
  stage: ScpAutomationStage,
  settings?: ScpAutomationSettings | null,
): boolean {
  if (!settings) return false;
  const stamp = normalizeScpAutomationSettings(settings).lastBacktestPassedAt[stage] ?? null;
  return Boolean(stamp?.passedAtIso) && stamp?.readMode !== "input_rows";
}

// Red-team fix(S5 P5-a): the country-confidence hard gate's automatic-final-fail path
// must never rely on hasScpAutomationBacktestApproval — that one never measures
// countryConfidence/countryGate accuracy. This dedicated stamp only counts as valid
// when it exists AND its recorded gateVersion/threshold still match the live accent-gate
// prompt version and the currently configured countryConfidenceThreshold — so bumping
// ACCENT_PROMPT_VERSION or editing the threshold silently revokes approval (fail-safe:
// callers must fall back to human review) until a super_admin re-attests.
export function hasCountryGateBacktestApproval(settings: ScpAutomationSettings | null | undefined): boolean {
  const stamp = settings?.countryGateBacktestPassedAt ?? null;
  if (!stamp || !stamp.passedAtIso) return false;
  return stamp.gateVersion === ACCENT_PROMPT_VERSION && stamp.threshold === settings?.countryConfidenceThreshold;
}

export function validateAutoAiBacktestGate(settings: ScpAutomationSettings): { allowed: boolean; reason: string; blockedStages: string[] } {
  const normalized = normalizeScpAutomationSettings(settings);
  if (!normalized.autoPilotEnabled) return { allowed: true, reason: "auto_pilot_disabled", blockedStages: [] };
  const autoAiStages = SCP_AUTOMATION_STAGES.filter((stage) => {
    const stageConfig = normalized.stages[stage];
    const stageGateOff = stageConfig.mode === "auto_ai" && stageConfig.gate === "off";
    const actionGateOff = stageConfig.mode === "auto_ai" && Object.entries(stageConfig.actions)
      .some(([, action]) => action?.gate === "off");
    return stageGateOff || actionGateOff;
  });
  if (!autoAiStages.length) return { allowed: true, reason: "no_auto_ai_gate_off", blockedStages: [] };
  // Each auto_ai stage must carry ITS OWN backtest approval — one stage's stamp
  // can never satisfy another (P0-5). The videoReview report generator
  // deliberately does not stamp; enabling videoReview auto_ai stays blocked
  // until a human-reviewed videoReview stamp exists.
  const unapprovedStages = autoAiStages.filter((stage) => !hasScpAutomationBacktestApproval(stage, normalized));
  if (unapprovedStages.length) return { allowed: false, reason: "backtest_required_for_auto_ai", blockedStages: unapprovedStages };
  return { allowed: true, reason: "backtest_passed", blockedStages: autoAiStages };
}

function extractScpAutomationSettingsPatch(data: unknown): ScpAutomationSettingsPatch {
  const root = asRecord(data);
  const patchSource = asRecord(root.patch ?? root.settings ?? root);
  const patch: ScpAutomationSettingsPatch = {};

  if (Object.prototype.hasOwnProperty.call(patchSource, "stages")) {
    patch.stages = parseStagePatches(asRecord(patchSource.stages));
  }
  if (typeof patchSource.autoPilotEnabled === "boolean") patch.autoPilotEnabled = patchSource.autoPilotEnabled;
  const threshold = toCountryConfidenceThreshold(patchSource.countryConfidenceThreshold);
  if (threshold !== null) patch.countryConfidenceThreshold = threshold;
  // super_admin-only manual attestation (see ScpCountryGateBacktestStamp doc comment).
  // Sending `null` explicitly clears/revokes a prior stamp; omitting the key leaves it
  // untouched — same hasOwnProperty convention as `stages` above.
  if (Object.prototype.hasOwnProperty.call(patchSource, "countryGateBacktestPassedAt")) {
    patch.countryGateBacktestPassedAt = normalizeCountryGateBacktestStamp(patchSource.countryGateBacktestPassedAt);
  }

  return patch;
}

function mergeScpAutomationSettings(
  current: ScpAutomationSettings,
  patch: ScpAutomationSettingsPatch,
  updatedBy: string,
): ScpAutomationSettings {
  const nowIso = new Date().toISOString();
  return normalizeScpAutomationSettings({
    ...current,
    ...patch,
    stages: mergeStages(current.stages, patch.stages),
    updatedAtIso: nowIso,
    updatedBy,
  });
}

function normalizeScpAutomationSettings(value: unknown): ScpAutomationSettings {
  const record = asRecord(value);
  return {
    stages: mergeStages(DEFAULT_SCP_AUTOMATION_SETTINGS.stages, parseStagePatches(asRecord(record.stages))),
    autoPilotEnabled: typeof record.autoPilotEnabled === "boolean" ? record.autoPilotEnabled : false,
    lastBacktestPassedAt: normalizeBacktestApprovals(record.lastBacktestPassedAt),
    countryConfidenceThreshold: toCountryConfidenceThreshold(record.countryConfidenceThreshold) ?? DEFAULT_COUNTRY_CONFIDENCE_THRESHOLD,
    countryGateBacktestPassedAt: normalizeCountryGateBacktestStamp(record.countryGateBacktestPassedAt),
    updatedAtIso: asNullableIso(record.updatedAtIso),
    updatedBy: typeof record.updatedBy === "string" && record.updatedBy.trim() ? record.updatedBy.trim() : null,
  };
}

// 0..1 클램프. 범위를 벗어나거나 숫자가 아니면 null(패치에서 무시 / 정규화에서 기본값 사용).
function toCountryConfidenceThreshold(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

function mergeStages(
  current: Record<ScpAutomationStage, ScpAutomationStageSettings>,
  patch?: Partial<Record<ScpAutomationStage, ScpAutomationStageSettingsPatch>>,
): Record<ScpAutomationStage, ScpAutomationStageSettings> {
  return {
    qualification: mergeStage(current.qualification, patch?.qualification),
    encouragement: mergeStage(current.encouragement, patch?.encouragement),
    videoReview: mergeStage(current.videoReview, patch?.videoReview),
  };
}

function mergeStage(
  current: ScpAutomationStageSettings,
  patch?: ScpAutomationStageSettingsPatch,
): ScpAutomationStageSettings {
  return normalizeStage({
    ...current,
    ...(patch ?? {}),
    actions: { ...current.actions, ...(patch?.actions ?? {}) },
  });
}

function parseStagePatches(record: Record<string, unknown>): Partial<Record<ScpAutomationStage, ScpAutomationStageSettingsPatch>> {
  const stages: Partial<Record<ScpAutomationStage, ScpAutomationStageSettingsPatch>> = {};
  for (const stage of SCP_AUTOMATION_STAGES) {
    if (Object.prototype.hasOwnProperty.call(record, stage)) stages[stage] = parseStagePatch(record[stage]);
  }
  return stages;
}

function parseStagePatch(value: unknown): ScpAutomationStageSettingsPatch {
  const record = asRecord(value);
  const patch: ScpAutomationStageSettingsPatch = {};
  const mode = toMode(record.mode);
  const gate = toGate(record.gate);
  const actions = parseActionPatches(asRecord(record.actions));
  if (mode) patch.mode = mode;
  if (gate) patch.gate = gate;
  if (Object.keys(actions).length > 0) patch.actions = actions;
  return patch;
}

function normalizeStage(value: unknown): ScpAutomationStageSettings {
  const record = asRecord(value);
  return {
    mode: toMode(record.mode) ?? "human_assist",
    gate: toGate(record.gate) ?? "required",
    actions: normalizeActions(asRecord(record.actions)),
  };
}

function normalizeActions(record: Record<string, unknown>): Partial<Record<ScpAutomationAction, ScpAutomationActionGate>> {
  const actions: Partial<Record<ScpAutomationAction, ScpAutomationActionGate>> = {};
  for (const action of SCP_AUTOMATION_ACTIONS) {
    const actionRecord = asRecord(record[action]);
    const gate = toGate(actionRecord.gate);
    if (gate) actions[action] = { gate };
  }
  return actions;
}

function parseActionPatches(record: Record<string, unknown>): Partial<Record<ScpAutomationAction, Partial<ScpAutomationActionGate>>> {
  const actions: Partial<Record<ScpAutomationAction, Partial<ScpAutomationActionGate>>> = {};
  for (const action of SCP_AUTOMATION_ACTIONS) {
    const gate = toGate(asRecord(record[action]).gate);
    if (gate) actions[action] = { gate };
  }
  return actions;
}

function toStage(value: unknown): ScpAutomationStage | null {
  return SCP_AUTOMATION_STAGES.includes(value as ScpAutomationStage) ? value as ScpAutomationStage : null;
}

function toAction(value: unknown): ScpAutomationAction | null {
  return SCP_AUTOMATION_ACTIONS.includes(value as ScpAutomationAction) ? value as ScpAutomationAction : null;
}

function toMode(value: unknown): ScpAutomationMode | null {
  return value === "human_assist" || value === "ai_assist" || value === "auto_ai" ? value : null;
}

function toGate(value: unknown): ScpAutomationGate | null {
  return value === "required" || value === "off" ? value : null;
}

function normalizeBacktestApprovals(value: unknown): ScpAutomationBacktestApprovals {
  // Legacy single-string stamp coerces to `qualification` ONLY. A pre-existing
  // global flag must never retroactively unlock videoReview (P0-5 fail-safe).
  if (typeof value === "string") {
    const iso = asNullableIso(value);
    return {
      qualification: iso ? { passedAtIso: iso, readMode: null, rowCount: null, spreadsheetId: null } : null,
      encouragement: null,
      videoReview: null,
    };
  }
  const record = asRecord(value);
  return {
    qualification: normalizeBacktestStamp(record.qualification),
    encouragement: normalizeBacktestStamp(record.encouragement),
    videoReview: normalizeBacktestStamp(record.videoReview),
  };
}

function normalizeBacktestStamp(value: unknown): ScpAutomationBacktestStamp | null {
  const record = asRecord(value);
  const passedAtIso = asNullableIso(record.passedAtIso);
  if (!passedAtIso) return null;
  const rowCount = typeof record.rowCount === "number" && Number.isFinite(record.rowCount)
    ? Math.max(0, Math.floor(record.rowCount))
    : null;
  return {
    passedAtIso,
    readMode: record.readMode === "input_rows" || record.readMode === "sheets_api" ? record.readMode : null,
    rowCount,
    spreadsheetId: typeof record.spreadsheetId === "string" && record.spreadsheetId.trim()
      ? record.spreadsheetId.trim().slice(0, 200)
      : null,
  };
}

// Incomplete stamps (missing gateVersion/threshold, or an unparseable passedAtIso) are
// treated as absent (return null) rather than partially trusted — fail-safe.
function normalizeCountryGateBacktestStamp(value: unknown): ScpCountryGateBacktestStamp | null {
  const record = asRecord(value);
  const passedAtIso = asNullableIso(record.passedAtIso);
  const gateVersion = typeof record.gateVersion === "number" && Number.isFinite(record.gateVersion) ? record.gateVersion : null;
  const threshold = toCountryConfidenceThreshold(record.threshold);
  if (!passedAtIso || gateVersion === null || threshold === null) return null;
  return { passedAtIso, gateVersion, threshold };
}

function asNullableIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
