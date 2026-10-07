// SCP lifecycle flow config — program-level presentation/gate configuration for the
// canonical SCP lifecycle. Canonical state IDs and projection semantics stay immutable
// (functions/scpLifecycleProjection.ts). This module owns only the mutable presentation
// layer: step order, visibility (disable), soft-delete/restore, label/description/tone,
// and per-step human-gate pins.
//
// Storage: scp_lifecycle_flow/{programId|default} — a sibling collection, deliberately
// NOT inside settings/scp_automation (avoids automation-gate coupling, settings-doc
// hot-spotting, and clobbering by the stage-merge patch path). All reads are direct
// doc reads (no ordered queries → no composite index requirement). Reads never create
// documents; only updateScpLifecycleFlowConfig writes, transactionally, with
// expectedVersion optimistic concurrency and a before/after audit row in
// scp_lifecycle_flow_audit.
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  makeBehaviorLog,
  makeCache,
  makeCostLog,
  type CallableRequestShape,
} from "./shared";
// 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate): see scpAutomationSettings.ts.
import { assertScpEntitled } from "./mailAccounts";
import { SCP_LIFECYCLE_STATES, type ScpLifecycleState } from "./scpLifecycleProjection";

export const SCP_LIFECYCLE_FLOW_COLLECTION = "scp_lifecycle_flow";
export const SCP_LIFECYCLE_FLOW_AUDIT_COLLECTION = "scp_lifecycle_flow_audit";
export const SCP_LIFECYCLE_FLOW_DEFAULT_PROGRAM = "default";

const READ_ROLES = ["super_admin", "admin", "manager"] as const;
const WRITE_ROLES = ["super_admin", "admin"] as const;
const CACHE_TTL_SECONDS = 300;
const PREVIEW_PROFILE_SCAN_LIMIT = 2000;
const MAX_LABEL_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_PROGRAM_ID_LENGTH = 64;

export const SCP_LIFECYCLE_FLOW_TONES = ["neutral", "info", "accent", "warn", "ai", "ok", "danger"] as const;
export type ScpLifecycleFlowTone = (typeof SCP_LIFECYCLE_FLOW_TONES)[number];

export type ScpLifecycleStepConfig = {
  id: ScpLifecycleState;
  label: string;
  description: string;
  order: number;
  enabled: boolean;
  deletedAtIso: string | null;
  terminal: boolean;
  humanGateRequired: boolean;
  tone: ScpLifecycleFlowTone;
};

export type ScpLifecycleFlowConfig = {
  version: number;
  programId: string;
  steps: ScpLifecycleStepConfig[];
  updatedAtIso: string;
  updatedBy: string;
};

// Terminal/failure states — config may never convert these into success states
// (terminal flag locked, tone "ok" rejected). Matches the dashboard KPI terminal set.
export const SCP_LIFECYCLE_TERMINAL_STATES: readonly ScpLifecycleState[] = [
  "qualification_failed",
  "video_rejected",
  "done_failed",
];

// Human gates that guard mail sending and review decisions. These are hard safety
// stops (draft-only mail + human approval, review decisions): they cannot be
// disabled, deleted, or un-pinned via flow config. Replacement-gate configuration is
// intentionally NOT supported — a locked pin is strictly safer than a swappable one.
export const SCP_LIFECYCLE_LOCKED_GATE_STATES: readonly ScpLifecycleState[] = [
  "qualification_pending",
  "pass_mail_pending",
  "fail_mail_pending",
  "video_review_pending",
  "needs_resubmission",
];

// Default human-gate pins = union of the dashboard/profile-detail hardcoded sets that
// this config layer replaces (parity fix: the two surfaces had drifted).
const DEFAULT_HUMAN_GATE_STATES: readonly ScpLifecycleState[] = [
  "qualification_pending",
  "pass_mail_pending",
  "fail_mail_pending",
  "uid_requested",
  "gem_scheduled",
  "video_review_pending",
  "video_rejected",
  "needs_resubmission",
];

const DEFAULT_STEP_PRESENTATION: Record<ScpLifecycleState, { label: string; description: string; tone: ScpLifecycleFlowTone }> = {
  coldmail_sent: { label: "콜드메일", description: "초기 아웃리치 발송", tone: "info" },
  reply_received: { label: "답장", description: "크리에이터 답장 수신", tone: "ai" },
  form_submitted: { label: "폼 제출", description: "Typeform 지원서 제출", tone: "accent" },
  qualification_pending: { label: "자격 대기", description: "자격 판정 입력 대기", tone: "warn" },
  qualification_passed: { label: "자격 통과", description: "자격 판정 통과", tone: "ok" },
  qualification_failed: { label: "자격 실패", description: "자격 판정 탈락", tone: "danger" },
  pass_mail_pending: { label: "합격 메일 대기", description: "통과 메일 사람 승인 대기", tone: "warn" },
  fail_mail_pending: { label: "불합격 메일 대기", description: "탈락 메일 사람 승인 대기", tone: "warn" },
  onelink_sent: { label: "OneLink 발송", description: "OneLink 안내 발송", tone: "accent" },
  uid_requested: { label: "UID 요청", description: "게임 UID 요청", tone: "ai" },
  uid_received: { label: "UID 수신", description: "게임 UID 수신 완료", tone: "ok" },
  gem_scheduled: { label: "젬 예약", description: "젬 지급 예약", tone: "accent" },
  gem_paid: { label: "젬 지급", description: "젬 지급 완료", tone: "ok" },
  video_task_issued: { label: "영상 과제", description: "영상 과제 발급", tone: "info" },
  video_submitted: { label: "영상 제출", description: "영상 제출 완료", tone: "ai" },
  video_review_pending: { label: "영상 검수", description: "영상 검수 결정 대기", tone: "warn" },
  video_approved: { label: "영상 승인", description: "영상 검수 승인", tone: "ok" },
  video_rejected: { label: "영상 반려", description: "영상 검수 반려", tone: "danger" },
  needs_resubmission: { label: "재제출 필요", description: "재제출 요청/확인 필요", tone: "danger" },
  live_tracking: { label: "라이브 추적", description: "조회수 추적 진행", tone: "ok" },
  done_failed: { label: "종료 실패", description: "종료/실패 처리", tone: "danger" },
};

const CANONICAL_STATE_SET = new Set<string>(SCP_LIFECYCLE_STATES);
const TERMINAL_STATE_SET = new Set<ScpLifecycleState>(SCP_LIFECYCLE_TERMINAL_STATES);
const LOCKED_GATE_STATE_SET = new Set<ScpLifecycleState>(SCP_LIFECYCLE_LOCKED_GATE_STATES);
const DEFAULT_GATE_STATE_SET = new Set<ScpLifecycleState>(DEFAULT_HUMAN_GATE_STATES);

export function buildDefaultScpLifecycleFlowSteps(): ScpLifecycleStepConfig[] {
  return SCP_LIFECYCLE_STATES.map((state, index) => ({
    id: state,
    label: DEFAULT_STEP_PRESENTATION[state].label,
    description: DEFAULT_STEP_PRESENTATION[state].description,
    order: index,
    enabled: true,
    deletedAtIso: null,
    terminal: TERMINAL_STATE_SET.has(state),
    humanGateRequired: DEFAULT_GATE_STATE_SET.has(state),
    tone: DEFAULT_STEP_PRESENTATION[state].tone,
  }));
}

export function buildDefaultScpLifecycleFlowConfig(programId = SCP_LIFECYCLE_FLOW_DEFAULT_PROGRAM): ScpLifecycleFlowConfig {
  return {
    version: 0,
    programId,
    steps: buildDefaultScpLifecycleFlowSteps(),
    updatedAtIso: "",
    updatedBy: "",
  };
}

export type ScpLifecycleFlowValidation = {
  ok: boolean;
  errors: string[];
};

// Full validation contract (metaprompt §Validation rules):
// - unknown/duplicate state IDs rejected; steps must cover every canonical state
//   (soft-delete keeps the step row — nothing is ever physically removed).
// - at least one enabled, non-deleted, non-terminal operational step.
// - terminal/failure semantics are locked: terminal flag must match canonical,
//   terminal/failure states may not take tone "ok".
// - locked human-gate states cannot be disabled, deleted, or un-pinned.
export function validateScpLifecycleFlowSteps(input: unknown): ScpLifecycleFlowValidation {
  const errors: string[] = [];
  if (!Array.isArray(input)) return { ok: false, errors: ["steps must be an array"] };
  const seen = new Set<string>();
  const orders = new Set<number>();
  for (const raw of input) {
    const step = asRecord(raw);
    const id = asString(step.id);
    if (!CANONICAL_STATE_SET.has(id)) {
      errors.push(`unknown state id: ${id || "(empty)"}`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`duplicate state id: ${id}`);
      continue;
    }
    seen.add(id);
    const state = id as ScpLifecycleState;
    const label = typeof step.label === "string" ? step.label.trim() : "";
    if (!label) errors.push(`${id}: label is required`);
    if (label.length > MAX_LABEL_LENGTH) errors.push(`${id}: label exceeds ${MAX_LABEL_LENGTH} chars`);
    if (typeof step.description !== "string") errors.push(`${id}: description must be a string`);
    else if (step.description.length > MAX_DESCRIPTION_LENGTH) errors.push(`${id}: description exceeds ${MAX_DESCRIPTION_LENGTH} chars`);
    if (typeof step.order !== "number" || !Number.isFinite(step.order)) errors.push(`${id}: order must be a finite number`);
    else if (orders.has(step.order)) errors.push(`${id}: duplicate order ${step.order}`);
    else orders.add(step.order);
    if (typeof step.enabled !== "boolean") errors.push(`${id}: enabled must be boolean`);
    if (step.deletedAtIso !== null && (typeof step.deletedAtIso !== "string" || Number.isNaN(Date.parse(step.deletedAtIso)))) {
      errors.push(`${id}: deletedAtIso must be null or an ISO timestamp`);
    }
    if (typeof step.terminal !== "boolean") errors.push(`${id}: terminal must be boolean`);
    else if (step.terminal !== TERMINAL_STATE_SET.has(state)) {
      errors.push(`${id}: terminal flag is locked to canonical semantics and cannot be ${step.terminal}`);
    }
    if (typeof step.humanGateRequired !== "boolean") errors.push(`${id}: humanGateRequired must be boolean`);
    const tone = asString(step.tone);
    if (!SCP_LIFECYCLE_FLOW_TONES.includes(tone as ScpLifecycleFlowTone)) errors.push(`${id}: invalid tone ${tone || "(empty)"}`);
    if (TERMINAL_STATE_SET.has(state) && tone === "ok") {
      errors.push(`${id}: terminal/failure state cannot present success tone "ok"`);
    }
    if (LOCKED_GATE_STATE_SET.has(state)) {
      if (step.enabled !== true) errors.push(`${id}: locked human-gate step cannot be disabled`);
      if (step.deletedAtIso !== null) errors.push(`${id}: locked human-gate step cannot be deleted`);
      if (step.humanGateRequired !== true) errors.push(`${id}: locked human-gate step cannot un-pin humanGateRequired`);
    }
  }
  for (const state of SCP_LIFECYCLE_STATES) {
    if (!seen.has(state)) errors.push(`missing canonical state: ${state} (soft-delete instead of removing)`);
  }
  if (Array.isArray(input) && errors.length === 0) {
    const hasOperationalStep = input.some((raw) => {
      const step = asRecord(raw);
      const state = asString(step.id) as ScpLifecycleState;
      return step.enabled === true && step.deletedAtIso === null && !TERMINAL_STATE_SET.has(state);
    });
    if (!hasOperationalStep) errors.push("at least one enabled non-terminal operational step is required");
  }
  return { ok: errors.length === 0, errors };
}

export function normalizeScpLifecycleFlowSteps(input: unknown[]): ScpLifecycleStepConfig[] {
  const rows = input.map((raw) => asRecord(raw));
  rows.sort((left, right) => Number(left.order) - Number(right.order));
  return rows.map((step, index) => ({
    id: asString(step.id) as ScpLifecycleState,
    label: asString(step.label).slice(0, MAX_LABEL_LENGTH),
    description: (typeof step.description === "string" ? step.description : "").slice(0, MAX_DESCRIPTION_LENGTH),
    order: index,
    enabled: step.enabled === true,
    deletedAtIso: typeof step.deletedAtIso === "string" ? step.deletedAtIso : null,
    terminal: step.terminal === true,
    humanGateRequired: step.humanGateRequired === true,
    tone: asString(step.tone) as ScpLifecycleFlowTone,
  }));
}

function normalizeProgramId(value: unknown): string {
  const raw = asString(value, SCP_LIFECYCLE_FLOW_DEFAULT_PROGRAM).toLowerCase();
  const safe = raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_PROGRAM_ID_LENGTH);
  return safe || SCP_LIFECYCLE_FLOW_DEFAULT_PROGRAM;
}

function flowDoc(programId: string) {
  return adminDb.collection(SCP_LIFECYCLE_FLOW_COLLECTION).doc(programId);
}

function normalizeStoredConfig(programId: string, data: Record<string, unknown> | undefined): ScpLifecycleFlowConfig | null {
  if (!data) return null;
  const steps = Array.isArray(data.steps) ? data.steps : null;
  if (!steps) return null;
  const validation = validateScpLifecycleFlowSteps(steps);
  if (!validation.ok) return null;
  return {
    version: typeof data.version === "number" && Number.isFinite(data.version) ? data.version : 0,
    programId,
    steps: normalizeScpLifecycleFlowSteps(steps),
    updatedAtIso: asString(data.updatedAtIso),
    updatedBy: asString(data.updatedBy),
  };
}

// Read-only resolution: program doc → default doc → canonical fallback. Never writes;
// a corrupt/absent doc degrades safely to canonical order (source tells the client
// whether it may trust the version for optimistic concurrency).
export async function resolveScpLifecycleFlowConfig(programIdInput: unknown): Promise<{
  config: ScpLifecycleFlowConfig;
  source: "program" | "default" | "canonical";
}> {
  const programId = normalizeProgramId(programIdInput);
  const snapshot = await flowDoc(programId).get();
  const programConfig = snapshot.exists ? normalizeStoredConfig(programId, snapshot.data()) : null;
  if (programConfig) return { config: programConfig, source: "program" };
  if (programId !== SCP_LIFECYCLE_FLOW_DEFAULT_PROGRAM) {
    const defaultSnapshot = await flowDoc(SCP_LIFECYCLE_FLOW_DEFAULT_PROGRAM).get();
    const defaultConfig = defaultSnapshot.exists ? normalizeStoredConfig(SCP_LIFECYCLE_FLOW_DEFAULT_PROGRAM, defaultSnapshot.data()) : null;
    if (defaultConfig) return { config: defaultConfig, source: "default" };
  }
  return { config: buildDefaultScpLifecycleFlowConfig(programId), source: "canonical" };
}

export async function getScpLifecycleFlowConfig(request: CallableRequestShape) {
  // 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate): NOT gated by
  // assertScpEntitled — this lifecycle flow config read also backs the general-purpose
  // Influencer detail page (src/app/(app)/flu/influencers/[id]/page.tsx, via
  // src/lib/scp-lifecycle-flow.ts) and the settings page's unconditional operational prefetch,
  // reachable by every org regardless of scp mailbox entitlement. READ_ROLES (manager+) remains
  // the only gate. updateScpLifecycleFlowConfig/previewScpLifecycleFlowConfig below ARE gated —
  // their only reachable UI is ScpLifecycleFlowPanel.tsx, which only renders inside the
  // entitlement-gated /flu/settings "SCP 운영" section.
  const auth = assertNonGuestAuth(request, "scp_lifecycle_flow.get", READ_ROLES);
  const data = asRecord(request.data);
  const resolved = await resolveScpLifecycleFlowConfig(data.programId);
  return {
    ok: true,
    config: resolved.config,
    source: resolved.source,
    lockedGateStates: [...SCP_LIFECYCLE_LOCKED_GATE_STATES],
    terminalStates: [...SCP_LIFECYCLE_TERMINAL_STATES],
    cache: makeCache(`scp_lifecycle_flow:${resolved.config.programId}`, false, CACHE_TTL_SECONDS),
    costLog: makeCostLog("scp_lifecycle_flow.get", "mock-admin", false, 0),
    behaviorLog: makeBehaviorLog(auth, "scp_lifecycle_flow.get", "success"),
  };
}

export async function updateScpLifecycleFlowConfig(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_lifecycle_flow.update", WRITE_ROLES);
  await assertScpEntitled(auth, request, "scp_lifecycle_flow.update");
  const data = asRecord(request.data);
  const programId = normalizeProgramId(data.programId);
  const expectedVersion = data.expectedVersion;
  if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw callableError("invalid-argument", "expectedVersion must be a non-negative integer", auth, "scp_lifecycle_flow.update");
  }
  const validation = validateScpLifecycleFlowSteps(data.steps);
  if (!validation.ok) {
    throw callableError("invalid-argument", `invalid lifecycle flow steps: ${validation.errors.join("; ")}`, auth, "scp_lifecycle_flow.update", {
      validationErrors: validation.errors,
    });
  }
  const steps = normalizeScpLifecycleFlowSteps(data.steps as unknown[]);
  const updatedAtIso = new Date().toISOString();
  const auditRef = adminDb.collection(SCP_LIFECYCLE_FLOW_AUDIT_COLLECTION).doc();

  const next = await adminDb.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(flowDoc(programId));
    const currentStored = snapshot.exists ? normalizeStoredConfig(programId, snapshot.data()) : null;
    const currentVersion = currentStored?.version ?? 0;
    if (expectedVersion !== currentVersion) {
      throw callableError(
        "failed-precondition",
        `version_conflict: expected ${expectedVersion} but current is ${currentVersion}`,
        auth,
        "scp_lifecycle_flow.update",
        { currentVersion },
      );
    }
    const before = currentStored ?? buildDefaultScpLifecycleFlowConfig(programId);
    const nextConfig: ScpLifecycleFlowConfig = {
      version: currentVersion + 1,
      programId,
      steps,
      updatedAtIso,
      updatedBy: auth.userId,
    };
    transaction.set(flowDoc(programId), {
      ...nextConfig,
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.set(auditRef, {
      action: "scp_lifecycle_flow.update",
      programId,
      expectedVersion,
      versionBefore: currentVersion,
      versionAfter: nextConfig.version,
      before,
      after: nextConfig,
      changedStepIds: changedStepIds(before.steps, steps),
      updatedBy: auth.userId,
      role: auth.role,
      team: auth.team,
      gameId: auth.gameId,
      createdAtIso: updatedAtIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    return nextConfig;
  });

  return {
    ok: true,
    config: next,
    auditRef: auditRef.path,
    cache: makeCache(`scp_lifecycle_flow:${programId}`, false, CACHE_TTL_SECONDS),
    costLog: makeCostLog("scp_lifecycle_flow.update", "mock-admin", false, 0),
    behaviorLog: makeBehaviorLog(auth, "scp_lifecycle_flow.update", "success"),
  };
}

// Read-only impact analysis before save. Scans materialized profiles WITHOUT an
// orderBy (no composite index dependency) and never writes.
export async function previewScpLifecycleFlowConfig(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_lifecycle_flow.preview", READ_ROLES);
  await assertScpEntitled(auth, request, "scp_lifecycle_flow.preview");
  const data = asRecord(request.data);
  const programId = normalizeProgramId(data.programId);
  const validation = validateScpLifecycleFlowSteps(data.steps);
  const current = await resolveScpLifecycleFlowConfig(programId);

  let impact: Record<string, unknown> | null = null;
  if (validation.ok) {
    const steps = normalizeScpLifecycleFlowSteps(data.steps as unknown[]);
    const snapshot = await adminDb
      .collection("scp_lifecycle_profiles")
      .select("currentState")
      .limit(PREVIEW_PROFILE_SCAN_LIMIT)
      .get();
    const byState: Record<string, number> = {};
    for (const doc of snapshot.docs) {
      const state = asString(asRecord(doc.data()).currentState);
      if (state) byState[state] = (byState[state] ?? 0) + 1;
    }
    const hiddenStates = steps.filter((step) => !step.enabled || step.deletedAtIso !== null).map((step) => step.id);
    const deletedStates = steps.filter((step) => step.deletedAtIso !== null).map((step) => step.id);
    const disabledStates = steps.filter((step) => !step.enabled && step.deletedAtIso === null).map((step) => step.id);
    const hiddenProfileCount = hiddenStates.reduce((sum, state) => sum + (byState[state] ?? 0), 0);
    const currentOrder = current.config.steps.map((step) => step.id).join(",");
    const nextOrder = steps.map((step) => step.id).join(",");
    const gateAdded = steps.filter((step) => step.humanGateRequired && !current.config.steps.find((c) => c.id === step.id)?.humanGateRequired).map((step) => step.id);
    const gateRemoved = steps.filter((step) => !step.humanGateRequired && current.config.steps.find((c) => c.id === step.id)?.humanGateRequired).map((step) => step.id);
    impact = {
      profilesScanned: snapshot.size,
      profilesScanTruncated: snapshot.size >= PREVIEW_PROFILE_SCAN_LIMIT,
      profilesByState: byState,
      hiddenStates,
      disabledStates,
      deletedStates,
      hiddenProfileCount,
      terminalStates: [...SCP_LIFECYCLE_TERMINAL_STATES],
      orderChanged: currentOrder !== nextOrder,
      humanGateAdded: gateAdded,
      humanGateRemoved: gateRemoved,
      // Profiles are not program-scoped yet (see docs/GAPS.md); the scan covers all
      // materialized profiles regardless of programId.
      programScoped: false,
      // Config reads are direct doc gets and the preview scan is unordered: no new
      // composite index is required by this feature.
      indexNotes: [],
    };
  }

  return {
    ok: true,
    valid: validation.ok,
    validationErrors: validation.errors,
    currentVersion: current.config.version,
    source: current.source,
    impact,
    cache: makeCache(`scp_lifecycle_flow_preview:${programId}`, false, 0),
    costLog: makeCostLog("scp_lifecycle_flow.preview", "mock-admin", false, 0),
    behaviorLog: makeBehaviorLog(auth, "scp_lifecycle_flow.preview", "success"),
  };
}

function changedStepIds(before: ScpLifecycleStepConfig[], after: ScpLifecycleStepConfig[]): string[] {
  const beforeById = new Map(before.map((step) => [step.id, JSON.stringify({ ...step })]));
  return after
    .filter((step) => beforeById.get(step.id) !== JSON.stringify({ ...step }))
    .map((step) => step.id);
}

function callableError(
  code: string,
  message: string,
  auth: ReturnType<typeof assertNonGuestAuth>,
  action: string,
  extra: Record<string, unknown> = {},
): Error {
  const error = new Error(`${code}: ${message}`);
  Object.assign(error, {
    code,
    behaviorLog: makeBehaviorLog(auth, action, code === "failed-precondition" ? "blocked" : "error"),
    ...extra,
  });
  return error;
}
