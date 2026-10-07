import { createHash } from "node:crypto";
import { assertMutationOwner, mutationOwnerUids, type MutationAuthorizationActor } from "./mutationAuthorization";
import { resolveCanonicalProgramId } from "./programCanonical";
import { countryTargetingFromLegacy, normalizeCountryTargeting, resolveCountryTargeting, type CountryTargeting } from "./youtubeCreatorCountries";
import { DISCOVERY_VERTICALS, normalizeDiscoveryVertical, type DiscoveryVertical } from "./discoveryVerticalPolicy";

export const CAMPAIGN_CONTROL_PRIORITIES = ["긴급", "높음", "보통"] as const;
export const CAMPAIGN_CONTROL_TARGET_METRICS = ["partners", "sent", "replied", "negotiating", "contracted", "live"] as const;
/** **운영자가 설정할 수 있는** 실행 상태. `cancelled` 는 여기 없다(아래 참조). */
export const CAMPAIGN_OPERATIONAL_STATES = ["active", "paused", "completed"] as const;

/**
 * 취소 실행 상태 — **판정으로만 나오고 운영자가 못 세운다.**
 *
 * 배경(2026-09-05 실측): 프로덕션 `campaigns` 문서에는 타입에 없는 취소 상태가 실제로 들어 있다
 * (`cancelled` 4건 · `cancelled_preapproval_failed` 1건). 이 값들은 외부/레거시 유입이라
 * 서버가 쓰는 경로가 없고, 그래서 `resolveCampaignOperationalState` 가 전부 `active` 로 떨어뜨렸다.
 * 그 결과 취소된 웨이브가 아비터에서 **발송 가능**으로 잡히고(대기열 249명), 퍼널 동기화가
 * `status` 를 `"대기"` 로 덮어써 취소 표식 자체를 지웠다.
 *
 * `completed` 로 접지 않는 이유: 완료와 취소는 처방이 다르다(완료는 성공, 취소는 중단).
 * 운영자 입력 화이트리스트(`CAMPAIGN_OPERATIONAL_STATES`)에 넣지 않는 이유: 취소는 이 콜러블의
 * 정격 조작이 아니고, 넣으면 `campaignControl` 의 status 매핑이 취소를 임의 라벨로 덮어쓴다.
 */
export const CAMPAIGN_CANCELLED_OPERATIONAL_STATE = "cancelled" as const;

export type CampaignControlPriority = typeof CAMPAIGN_CONTROL_PRIORITIES[number];
export type CampaignControlTargetMetric = typeof CAMPAIGN_CONTROL_TARGET_METRICS[number];
export type CampaignOperationalState =
  | typeof CAMPAIGN_OPERATIONAL_STATES[number]
  | typeof CAMPAIGN_CANCELLED_OPERATIONAL_STATE;

export type CampaignControlUpdateInput = {
  programId: string;
  campaignId: string;
  expectedVersion: number;
  targetMetric?: CampaignControlTargetMetric;
  targetValue?: number;
  outreachQuota?: number;
  priority?: CampaignControlPriority;
  operationalState?: CampaignOperationalState;
  name?: string;
  countryTargeting?: CountryTargeting;
  allowInflyOverlap?: boolean;
  /** W41: 보관(archive) 토글. true 면 문서를 남긴 채 목록에서 감추고 실행 상태를 completed 로 닫는다. */
  archived?: boolean;
  /**
   * W100: 캠페인 누적 라이브 발송 상한. 도달 시 발송 워커가 이 캠페인의 라이브 발송을 전량
   * 차단한다(chat-ai.ts liveCampaignWaveCapState → live_wave_cap_reached). 이 필드만 UI·콜러블에
   * 미배선이라 운영자가 콘솔로 우회하다 사고가 났다 — super_admin + 사유 필수로만 연다.
   * 파도별 배치 상한(liveSendBatchCap, autoRefill 이 max(기존, targetValue) 로 자동 래칫)과 다른 축이다.
   */
  liveSendCap?: number;
  liveSendCapReason?: string;
  /**
   * 캠페인 daily-cap-fairness(2026-09-17): 캠페인별 **일일** 발송 상한. 0/미설정 = 전역 캡
   * (settings.automation.maxDailyOutreachSends)만 적용(기존 동작). 두 라이브 캠페인이 전역 캡 하나를
   * 나눠 쓰다가 먼저 도는 캠페인이 하루치를 다 써 뒤 캠페인이 굶은 사고(2026-09-16 야간)의 수리 —
   * 누적 상한(liveSendCap)과 달리 이 값은 KST 달력일마다 리셋된다(chat-ai.ts campaignDailyCapState).
   * manager+ 면 누구나 설정한다(liveSendCap 처럼 super_admin·사유 전용이 아니다).
   */
  dailyCap?: number;
  targetingCriteria?: CampaignControlTargetingCriteriaPatch;
};

export type CampaignControlTargetingCriteriaPatch = {
  values: Record<string, unknown>;
  deleteKeys: string[];
};

export type CampaignOutreachApprovalInput = {
  programId: string;
  campaignId: string;
  expectedVersion: number;
  outreachIds: string[];
  confirmCount: number;
  sendAfterIso?: string;
};

export type CampaignApprovalAtomicAction =
  | { kind: "commit"; nextVersion: number }
  | { kind: "replay"; nextVersion: number };

export type CampaignControlSafeFields = {
  targetMetric: CampaignControlTargetMetric;
  targetValue: number;
  outreachQuota: number;
  priority: CampaignControlPriority;
  operationalState: CampaignOperationalState;
  name: string;
  countryTargeting: CountryTargeting;
  effectiveCountryTargeting: CountryTargeting;
  allowInflyOverlap: boolean;
  /** W100: 0 = 미설정(무상한). 양수면 누적 라이브 발송이 이 값에 도달할 때 전량 차단. */
  liveSendCap: number;
  /** daily-cap-fairness: 0 = 미설정(전역 캡만). 양수면 이 캠페인의 KST 하루 발송이 이 값에서 멎는다. */
  dailyCap: number;
  controlVersion: number;
};

export type CampaignCountryControlProjection = {
  countryTargeting: CountryTargeting;
  effectiveCountryTargeting: CountryTargeting;
  targetCountries?: string[];
  excludedCountries: string[];
  regions: string[];
};

export type ProgramCampaignCandidateCriteria = {
  keywords: string[];
  excludeKeywords: string[];
  regions: string[];
  categories: string[];
  minFollowers: number;
  maxFollowers: number;
};

export type ProgramCampaignCandidateEligibility = {
  eligible: boolean;
  reason:
    | "eligible"
    | "program_scope_mismatch"
    | "program_scope_ambiguous"
    | "unscoped_without_exact_reevaluation"
    | "country_mismatch"
    | "category_mismatch"
    | "keyword_mismatch"
    | "excluded_keyword"
    | "followers_missing"
    | "followers_below_minimum"
    | "followers_above_maximum";
  canonicalProgramId: string;
  evidenceMode: "scoped_candidate_provenance" | "exact_program_re_evaluation";
  criteriaHash: string;
  /** True only when an explicit per-call keywordGateBypass let this candidate pass despite a
   * keyword/category mismatch (see keywordGateBypass input above). Never a campaign-wide setting. */
  keywordGateBypassed: boolean;
};

type CampaignControlValidationInput = {
  input: CampaignControlUpdateInput | Record<string, unknown>;
  actor: MutationAuthorizationActor;
  program: Record<string, unknown>;
  campaign: Record<string, unknown>;
  committedCount: number;
  aliasMap?: Record<string, string>;
  allowAccountScopedCriteriaEdit?: boolean;
  /** daily-cap-fairness: dailyCap 상한값(settings.automation.maxDailyOutreachSends). 생략하면
   * DEFAULT_DAILY_CAP_CEILING(테스트 편의 — 실제 호출부는 항상 넘긴다). */
  dailyCapCeiling?: number;
};

// R36: `code` 는 gRPC 클래스라 사유를 구분하지 못한다(failed-precondition 이 8곳에서 나온다).
// 고유 `errorCode` 를 함께 실어 로그·캠페인 문서가 어느 사전조건인지 말하게 한다.
function campaignControlError(code: string, message: string, errorCode?: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code, ...(errorCode ? { errorCode } : {}) });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function countryPolicy(recordValue: Record<string, unknown>): CountryTargeting {
  let resolved = { countryScope: "all", includedCountries: [], excludedCountries: [] } as CountryTargeting;
  for (const source of [record(recordValue.eligibilityCriteria), record(recordValue.candidateCriteria)]) {
    resolved = resolveCountryTargeting(countryTargetingFromLegacy(source), resolved);
  }
  return resolveCountryTargeting(countryTargetingFromLegacy(recordValue), resolved);
}

function parseCountryTargeting(value: unknown): CountryTargeting {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw campaignControlError("invalid-argument", "countryTargeting must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.countryScope !== "string" || !CAMPAIGN_COUNTRY_SCOPES.has(raw.countryScope)) {
    throw campaignControlError("invalid-argument", "countryTargeting.countryScope is unsupported");
  }
  for (const key of ["includedCountries", "excludedCountries"] as const) {
    if (!Array.isArray(raw[key]) || raw[key].length > 40 || raw[key].some((code) => typeof code !== "string" || !/^[A-Za-z]{2}$/.test(code.trim()))) {
      throw campaignControlError("invalid-argument", `countryTargeting.${key} must contain ISO-2 codes`);
    }
  }
  const normalized = normalizeCountryTargeting(raw);
  if (normalized.countryScope === "include" && normalized.includedCountries.length === 0) {
    throw campaignControlError("invalid-argument", "include country targeting requires at least one country");
  }
  return normalized;
}

const CAMPAIGN_COUNTRY_SCOPES = new Set(["inherit", "all", "include"]);

export function campaignCountryControlProjection(
  requested: CountryTargeting,
  program: Record<string, unknown>,
): CampaignCountryControlProjection {
  const countryTargeting = normalizeCountryTargeting(requested);
  const effectiveCountryTargeting = resolveCountryTargeting(countryTargeting, countryPolicy(program));
  return {
    countryTargeting,
    effectiveCountryTargeting,
    ...(countryTargeting.countryScope === "inherit" ? {} : {
      targetCountries: countryTargeting.countryScope === "include" ? countryTargeting.includedCountries : [],
    }),
    excludedCountries: countryTargeting.excludedCountries,
    regions: effectiveCountryTargeting.countryScope === "include" ? effectiveCountryTargeting.includedCountries : [],
  };
}

function text(value: unknown, max = 120): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function exactId(value: unknown, field: string, max = 120): string {
  const id = text(value, max);
  if (!id || !new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`).test(id)) {
    throw campaignControlError("invalid-argument", `${field} must be an exact document id`);
  }
  return id;
}


function stringArray(value: unknown, field: string, maxItems = 60): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw campaignControlError("invalid-argument", `${field} must be an array`);
  }
  return Array.from(new Set(value.map((item) => {
    if (typeof item !== "string") throw campaignControlError("invalid-argument", `${field} must contain strings`);
    return item.trim();
  }).filter(Boolean))).slice(0, maxItems);
}

function parseCampaignTargetingCriteriaPatch(value: unknown): CampaignControlTargetingCriteriaPatch {
  const input = record(value);
  if (Object.keys(input).length === 0 && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw campaignControlError("invalid-argument", "targetingCriteria must be an object");
  }
  const values: Record<string, unknown> = {};
  const deleteKeys: string[] = [];
  const readArray = (key: string, maxItems = 60) => {
    if (!Object.prototype.hasOwnProperty.call(input, key)) return;
    if (input[key] === null) { deleteKeys.push(key); return; }
    values[key] = stringArray(input[key], `targetingCriteria.${key}`, maxItems);
  };
  const readInteger = (key: string, min: number, max: number) => {
    if (!Object.prototype.hasOwnProperty.call(input, key)) return;
    if (input[key] === null) { deleteKeys.push(key); return; }
    values[key] = boundedInteger(input[key], `targetingCriteria.${key}`, min, max);
  };
  readArray("includeKeywords", 80);
  readArray("excludeKeywords", 80);
  readArray("categories", 80);
  readArray("regions", 80);
  readInteger("minFollowers", 0, 100_000_000);
  readInteger("maxFollowers", 0, 100_000_000);
  readInteger("recentActivityDays", 0, 3650);
  readInteger("minVideoViews", 0, 100_000_000);
  readInteger("minVideoCount", 0, 100);
  if (Object.prototype.hasOwnProperty.call(input, "discoveryVertical")) {
    if (input.discoveryVertical === null) deleteKeys.push("discoveryVertical");
    else {
      const vertical = normalizeDiscoveryVertical(input.discoveryVertical);
      if (!DISCOVERY_VERTICALS.includes(vertical as DiscoveryVertical)) {
        throw campaignControlError("invalid-argument", "targetingCriteria.discoveryVertical is unsupported");
      }
      values.discoveryVertical = vertical;
    }
  }
  for (const key of Object.keys(input)) {
    if (!["includeKeywords", "excludeKeywords", "categories", "regions", "minFollowers", "maxFollowers", "recentActivityDays", "minVideoViews", "minVideoCount", "discoveryVertical"].includes(key)) {
      throw campaignControlError("invalid-argument", `targetingCriteria.${key} is unsupported`);
    }
  }
  return { values, deleteKeys };
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw campaignControlError("invalid-argument", `${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function optionalStoredInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function priority(value: unknown, fallback: CampaignControlPriority = "보통"): CampaignControlPriority {
  return CAMPAIGN_CONTROL_PRIORITIES.includes(value as CampaignControlPriority)
    ? value as CampaignControlPriority
    : fallback;
}

function targetMetric(value: unknown, fallback: CampaignControlTargetMetric = "partners"): CampaignControlTargetMetric {
  return CAMPAIGN_CONTROL_TARGET_METRICS.includes(value as CampaignControlTargetMetric)
    ? value as CampaignControlTargetMetric
    : fallback;
}

/**
 * 캠페인 "취소" 상태 판정 **서버 정본**. `src/lib/campaign-status.ts` 의 클라 판정과 같은 규칙이어야
 * 한다(`functions/` 는 `src/` 를 import 할 수 없다 — functions/tsconfig 의 `rootDir:"."` 제약).
 *
 * 접두 판정을 쓰는 이유: 취소 계열 값이 한 벌이 아니다 —
 * `cancelled` · `canceled` · `cancelling` · `cancelled_preapproval_failed` (프로드 실측),
 * 그리고 한국어 라벨 `취소*`.
 */
export function isCancelledCampaignStatus(status: unknown): boolean {
  const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (!normalized) return false;
  return normalized.startsWith("cancel") || normalized.startsWith("취소");
}

export function resolveCampaignOperationalState(
  campaign: Record<string, unknown>,
): CampaignOperationalState {
  // 취소는 **가장 먼저** 본다. 취소 문서에는 operationalState 가 없어서 아래 폴백이 `active` 로
  // 떨어뜨렸고, 그게 아비터 발송 게이트와 퍼널 동기화를 통과시킨 근인이다.
  // 클라 `campaignStatusLabel` 도 같은 우선순위다(취소가 operationalState 폴백보다 앞).
  if (
    isCancelledCampaignStatus(campaign.status)
    || campaign.operationalState === CAMPAIGN_CANCELLED_OPERATIONAL_STATE
  ) {
    return CAMPAIGN_CANCELLED_OPERATIONAL_STATE;
  }
  if (CAMPAIGN_OPERATIONAL_STATES.includes(campaign.operationalState as typeof CAMPAIGN_OPERATIONAL_STATES[number])) {
    return campaign.operationalState as CampaignOperationalState;
  }
  const legacyStatus = typeof campaign.status === "string" ? campaign.status.trim().toLowerCase() : "";
  if (legacyStatus === "완료" || legacyStatus === "completed" || legacyStatus === "complete") {
    return "completed";
  }
  if (legacyStatus === "일시정지" || legacyStatus === "paused" || legacyStatus === "pause") {
    return "paused";
  }
  return "active";
}

/**
 * daily-cap-fairness: dailyCap 은 상한이 설정값(automation.maxDailyOutreachSends)에 종속된다.
 * 이 함수는 순수(파이어스토어 미접근)라 실제 호출부(campaignControl.ts)가 readSettings() 로 읽은
 * 값을 매개변수로 넘긴다 — 안 넘기면(테스트 등) 이 기본 상한을 쓴다(liveSendCap 과 같은 자리수).
 */
const DEFAULT_DAILY_CAP_CEILING = 1_000_000;

export function parseCampaignControlUpdateInput(
  value: unknown,
  dailyCapCeiling: number = DEFAULT_DAILY_CAP_CEILING,
): CampaignControlUpdateInput {
  const data = record(value);
  const parsed: CampaignControlUpdateInput = {
    programId: exactId(data.programId, "programId"),
    campaignId: exactId(data.campaignId, "campaignId"),
    expectedVersion: boundedInteger(data.expectedVersion, "expectedVersion", 0, 1_000_000_000),
  };
  if (data.targetMetric !== undefined) {
    if (!CAMPAIGN_CONTROL_TARGET_METRICS.includes(data.targetMetric as CampaignControlTargetMetric)) {
      throw campaignControlError("invalid-argument", "targetMetric is unsupported");
    }
    parsed.targetMetric = data.targetMetric as CampaignControlTargetMetric;
  }
  if (data.targetValue !== undefined) parsed.targetValue = boundedInteger(data.targetValue, "targetValue", 1, 1_000_000);
  if (data.outreachQuota !== undefined) parsed.outreachQuota = boundedInteger(data.outreachQuota, "outreachQuota", 1, 50_000);
  if (data.priority !== undefined) {
    if (!CAMPAIGN_CONTROL_PRIORITIES.includes(data.priority as CampaignControlPriority)) {
      throw campaignControlError("invalid-argument", "priority is unsupported");
    }
    parsed.priority = data.priority as CampaignControlPriority;
  }
  if (data.operationalState !== undefined) {
    // 화이트리스트는 **운영자 설정 가능한 3종**이다 — `cancelled` 는 판정 전용이라 여기서 거부된다.
    if (!CAMPAIGN_OPERATIONAL_STATES.includes(data.operationalState as typeof CAMPAIGN_OPERATIONAL_STATES[number])) {
      throw campaignControlError("invalid-argument", "operationalState is unsupported");
    }
    parsed.operationalState = data.operationalState as CampaignOperationalState;
  }
  if (data.name !== undefined) {
    if (typeof data.name !== "string" || !data.name.trim() || data.name.trim().length > 120) {
      throw campaignControlError("invalid-argument", "name must be 1-120 characters");
    }
    parsed.name = data.name.trim();
  }
  if (data.countryTargeting !== undefined) parsed.countryTargeting = parseCountryTargeting(data.countryTargeting);
  if (data.targetingCriteria !== undefined) parsed.targetingCriteria = parseCampaignTargetingCriteriaPatch(data.targetingCriteria);
  if (data.allowInflyOverlap !== undefined) {
    if (typeof data.allowInflyOverlap !== "boolean") {
      throw campaignControlError("invalid-argument", "allowInflyOverlap must be boolean");
    }
    parsed.allowInflyOverlap = data.allowInflyOverlap;
  }
  if (data.archived !== undefined) {
    if (typeof data.archived !== "boolean") {
      throw campaignControlError("invalid-argument", "archived must be boolean");
    }
    parsed.archived = data.archived;
  }
  if (data.liveSendCap !== undefined) {
    parsed.liveSendCap = boundedInteger(data.liveSendCap, "liveSendCap", 1, 1_000_000);
    const reason = typeof data.liveSendCapReason === "string" ? data.liveSendCapReason.trim() : "";
    if (reason.length < 5 || reason.length > 180) {
      throw campaignControlError("invalid-argument", "liveSendCapReason is required (5-180 chars)", "campaign_control_live_send_cap_reason_required");
    }
    parsed.liveSendCapReason = reason;
  } else if (data.liveSendCapReason !== undefined) {
    throw campaignControlError("invalid-argument", "liveSendCapReason requires liveSendCap", "campaign_control_live_send_cap_reason_orphan");
  }
  // daily-cap-fairness: 0 = "전역 캡만"(무상한이 아니다 — liveSendCap 과 표기는 같지만 뜻이 다르다).
  // 상한은 전역 일일 캡을 넘지 못한다 — 캠페인별 상한이 전역보다 커봤자 전역에서 어차피 막힌다.
  if (data.dailyCap !== undefined) {
    parsed.dailyCap = boundedInteger(data.dailyCap, "dailyCap", 0, Math.max(0, Math.round(dailyCapCeiling)));
  }
  if (
    parsed.targetMetric === undefined
    && parsed.targetValue === undefined
    && parsed.outreachQuota === undefined
    && parsed.priority === undefined
    && parsed.operationalState === undefined
    && parsed.name === undefined
    && parsed.countryTargeting === undefined
    && parsed.targetingCriteria === undefined
    && parsed.allowInflyOverlap === undefined
    && parsed.archived === undefined
    && parsed.liveSendCap === undefined
    && parsed.dailyCap === undefined
  ) {
    throw campaignControlError("invalid-argument", "at least one campaign control field is required");
  }
  return parsed;
}

export function parseCampaignOutreachApprovalInput(value: unknown): CampaignOutreachApprovalInput {
  const data = record(value);
  const rawIds = Array.isArray(data.outreachIds) ? data.outreachIds : [];
  if (rawIds.length < 1 || rawIds.length > 5) {
    throw campaignControlError("invalid-argument", "outreachIds must contain 1-5 selected rows");
  }
  const outreachIds = rawIds.map((id) => exactId(id, "outreachId", 180));
  if (new Set(outreachIds).size !== outreachIds.length) {
    throw campaignControlError("invalid-argument", "outreachIds must be unique");
  }
  const confirmCount = boundedInteger(data.confirmCount, "confirmCount", 1, 5);
  if (confirmCount !== outreachIds.length) {
    throw campaignControlError("failed-precondition", "confirmCount must exactly match selected outreachIds", "campaign_approval_confirm_count_mismatch");
  }
  const parsed: CampaignOutreachApprovalInput = {
    programId: exactId(data.programId, "programId"),
    campaignId: exactId(data.campaignId, "campaignId"),
    expectedVersion: boundedInteger(data.expectedVersion, "expectedVersion", 0, 1_000_000_000),
    outreachIds,
    confirmCount,
  };
  if (data.sendAfterIso !== undefined) {
    const sendAfterIso = text(data.sendAfterIso, 40);
    if (!sendAfterIso || Number.isNaN(Date.parse(sendAfterIso))) {
      throw campaignControlError("invalid-argument", "sendAfterIso must be an ISO timestamp");
    }
    parsed.sendAfterIso = new Date(sendAfterIso).toISOString();
  }
  return parsed;
}

export function campaignApprovalSelectionFingerprint(
  input: CampaignOutreachApprovalInput,
  actorUserIdHash: string,
  aliasMap: Record<string, string> = {},
): string {
  return createHash("sha256").update(JSON.stringify({
    programId: resolveCanonicalProgramId(input.programId, aliasMap),
    campaignId: input.campaignId,
    expectedVersion: input.expectedVersion,
    outreachIds: [...input.outreachIds].sort(),
    confirmCount: input.confirmCount,
    sendAfterIso: input.sendAfterIso ?? "",
    actorUserIdHash,
  })).digest("hex").slice(0, 32);
}

export function resolveCampaignApprovalAtomicAction(input: {
  expectedVersion: number;
  currentVersion: number;
  selectionFingerprint: string;
  actorUserIdHash: string;
  existingClaim?: Record<string, unknown> | null;
  approvedCount: number;
  committedCount: number;
  effectiveCap: number;
}): CampaignApprovalAtomicAction {
  const existingClaim = record(input.existingClaim);
  if (Object.keys(existingClaim).length > 0) {
    if (text(existingClaim.status, 40) !== "committed"
      || text(existingClaim.selectionFingerprint, 64) !== input.selectionFingerprint
      || text(existingClaim.actorUserIdHash, 64) !== input.actorUserIdHash) {
      throw campaignControlError("aborted", "approval selection claim conflict", "campaign_approval_selection_claim_conflict");
    }
    return {
      kind: "replay",
      nextVersion: boundedInteger(existingClaim.controlVersionAfter, "controlVersionAfter", 0, 1_000_000_000),
    };
  }
  if (input.currentVersion !== input.expectedVersion) {
    throw campaignControlError(
      "aborted",
      `campaign control version conflict: expected ${input.expectedVersion}, current ${input.currentVersion}`,
      "campaign_approval_control_version_conflict",
    );
  }
  for (const [field, value] of [
    ["approvedCount", input.approvedCount],
    ["committedCount", input.committedCount],
    ["effectiveCap", input.effectiveCap],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw campaignControlError("failed-precondition", `${field} must be a non-negative integer`, "campaign_approval_count_not_integer");
    }
  }
  if (input.approvedCount > 0 && input.committedCount + input.approvedCount > input.effectiveCap) {
    throw campaignControlError(
      "failed-precondition",
      `selected approval exceeds campaign cap ${input.effectiveCap}; committed ${input.committedCount}, selected ${input.approvedCount}`,
      "campaign_approval_exceeds_effective_cap",
    );
  }
  return { kind: "commit", nextVersion: input.currentVersion + 1 };
}

/**
 * R18: 승인 상한을 **하나의 식**으로 모은다. 준비 상한(admin.ts 의 kpiClampsTotal)과 승인 상한이
 * 서로 다른 자리에서 각자 KPI 를 적용하던 것이 R17-4 회귀의 원인이었다 — 준비만 열리고 승인이
 * 막히면 준비된 행이 매 tick failed-precondition 으로 튕기고, 스윕이 break 하며, queued_for_review
 * 가 보충 카운트에 잡혀 remaining=0 이 되어 보충까지 멈춘다(자가 회복 없는 영구 잼).
 *
 * `automaticRefillLane` 은 admin.ts 의 isAutomaticCampaignLane(호출자 uid)와 **같은 판정**이 들어오고,
 * 준비 상한(kpiClampsTotal)도 같은 함수의 같은 인자로 결정된다. R18 은 이 축을 캠페인 문서의
 * campaignQuota>0 으로 뒀는데, createCampaign 이 모든 캠페인에 campaignQuota 를 쓰므로 사실상 전 캠페인이
 * 면제 대상이 되어 **운영자 수동 승인의 KPI 상한까지 사라졌다**(R19-1).
 * 자동 보충 레인이면 프로그램 KPI 를 상한 목록에서 뺀다 — 상한은 outreachQuota·targetValue·liveSendCap
 * 이 그대로 유지하고, KPI 정지 축은 refill 의 campaign_targets_kpi_filled 가 담당한다.
 */
export function campaignApprovalEffectiveCap(input: {
  targetMetric: CampaignControlTargetMetric;
  outreachQuota: number;
  targetValue: number;
  liveSendCap?: number;
  programKpiTarget: number;
  programRemainingKpi: number;
  automaticRefillLane: boolean;
}): number {
  const caps = [input.outreachQuota, input.targetValue];
  const liveCap = Math.max(0, Math.round(input.liveSendCap ?? 0));
  if (liveCap > 0) caps.push(liveCap);
  const usesProgramKpi = input.targetMetric !== "sent" && !input.automaticRefillLane;
  if (usesProgramKpi && input.programKpiTarget > 0) caps.push(input.programRemainingKpi);
  return Math.max(0, Math.min(...caps));
}

export function campaignControlSafeFields(
  campaign: Record<string, unknown>,
  program: Record<string, unknown> = {},
): CampaignControlSafeFields {
  const targetingCriteria = record(campaign.targetingCriteria);
  const mailProfile = record(campaign.mailProfile);
  const countryProjection = campaignCountryControlProjection(countryTargetingFromLegacy(campaign), program);
  return {
    targetMetric: targetMetric(campaign.targetMetric),
    targetValue: optionalStoredInteger(campaign.targetValue, optionalStoredInteger(campaign.total, 1, 1, 1_000_000), 1, 1_000_000),
    outreachQuota: optionalStoredInteger(
      campaign.campaignQuota,
      optionalStoredInteger(campaign.liveSendCap, optionalStoredInteger(campaign.total, 1, 1, 50_000), 1, 50_000),
      1,
      50_000,
    ),
    priority: priority(campaign.operatorPriorityOverride, priority(campaign.priority)),
    operationalState: resolveCampaignOperationalState(campaign),
    name: text(campaign.name, 120) || "이름 없는 캠페인",
    countryTargeting: countryProjection.countryTargeting,
    effectiveCountryTargeting: countryProjection.effectiveCountryTargeting,
    allowInflyOverlap: campaign.allowInflyOverlap === true
      || targetingCriteria.allowInflyOverlap === true
      || mailProfile.allowInflyOverlap === true,
    liveSendCap: optionalStoredInteger(campaign.liveSendCap, 0, 0, 1_000_000),
    dailyCap: optionalStoredInteger(campaign.dailyCap, 0, 0, 1_000_000),
    controlVersion: optionalStoredInteger(campaign.controlVersion, 0, 0, 1_000_000_000),
  };
}

function canonicalIdentity(value: unknown, aliasMap: Record<string, string> = {}): string {
  return resolveCanonicalProgramId(text(value, 160), aliasMap);
}

const GAME_CATEGORY_EQUIVALENCE: Readonly<Record<string, string>> = Object.freeze({
  "하이퍼캐주얼": "hyper-casual",
  hypercasual: "hyper-casual",
  "퍼즐": "puzzle",
  puzzle: "puzzle",
  "캐주얼": "casual",
  casual: "casual",
  "머지": "merge",
  merge: "merge",
  "시뮬레이션": "simulation",
  simulation: "simulation",
  "방치형": "idle",
  "키우기": "idle",
  idle: "idle",
  "타이쿤": "tycoon",
  tycoon: "tycoon",
});

export function gameCategoryEquivalenceKey(value: string): string | null {
  const alias = value.normalize("NFKC").toLowerCase().replace(/[\s_-]+/g, "");
  return Object.prototype.hasOwnProperty.call(GAME_CATEGORY_EQUIVALENCE, alias)
    ? GAME_CATEGORY_EQUIVALENCE[alias] ?? null
    : null;
}

function normalizedCandidateCriteria(value: ProgramCampaignCandidateCriteria): ProgramCampaignCandidateCriteria {
  const strings = (items: unknown[], uppercase = false) => Array.from(new Set(items
    .filter((item): item is string => typeof item === "string")
    .map((item) => (uppercase ? item.trim().toUpperCase() : item.trim().toLowerCase()))
    .filter(Boolean)))
    .sort();
  return {
    keywords: strings(value.keywords),
    excludeKeywords: strings(value.excludeKeywords),
    regions: strings(value.regions, true),
    categories: strings(value.categories),
    minFollowers: optionalStoredInteger(value.minFollowers, 0, 0, 100_000_000),
    maxFollowers: optionalStoredInteger(value.maxFollowers, 0, 0, 100_000_000),
  };
}

function candidateCriteriaHash(criteria: ProgramCampaignCandidateCriteria): string {
  return createHash("sha256").update(JSON.stringify(criteria)).digest("hex").slice(0, 24);
}

export function evaluateProgramCampaignCandidateEligibility(input: {
  programId: string;
  candidate: Record<string, unknown>;
  criteria: ProgramCampaignCandidateCriteria;
  aliasMap?: Record<string, string>;
  /**
   * 헤세 결정 2026-09-16 [outreachDedupScope==="program"일 때만 true로 넘어온다]: 다른 프로그램이
   * 이미 클레임(candidate.canonicalProgramId/programId)한 후보를 거부하지 않고, 그 후보가 **이
   * 프로그램 기준으로 처음부터 다시 평가**했을 때 통과하는지만 본다(exact_program_re_evaluation로
   * 강제 — 다른 프로그램의 provenance는 신뢰하지 않는다). 기본 false = 기존 동작(program_scope_mismatch
   * 로 거부) 그대로.
   */
  crossProgramCandidatesAllowed?: boolean;
  /**
   * P0-1 [XP→Snake 후보 이주 · 2026-09-26]: true 면 키워드/카테고리 불일치만 통과시킨다(그 외 모든
   * 게이트 — 국가·exclude keyword·팔로워·프로그램 스코프 — 는 그대로 적용). 호출부가 **명시적으로
   * 승인한 건별 이주**(campaignCandidateMigration.ts 의 `bypassKeywordGate` 입력)에서만 true 로
   * 들어온다 — 캠페인의 `targetingCriteria.eligibilityKeywordGate` 설정(eligibilityKeywordGateEnabled)
   * 자체는 건드리지 않으므로 그 캠페인의 유기적 발굴·다른 후보의 키워드 타게팅은 무영향이다.
   */
  keywordGateBypass?: boolean;
}): ProgramCampaignCandidateEligibility {
  const aliasMap = input.aliasMap ?? {};
  const canonicalProgramId = canonicalIdentity(input.programId, aliasMap);
  const criteria = normalizedCandidateCriteria(input.criteria);
  const criteriaHash = candidateCriteriaHash(criteria);
  const claimedScopes = Array.from(new Set([
    canonicalIdentity(input.candidate.canonicalProgramId, aliasMap),
    canonicalIdentity(input.candidate.programId, aliasMap),
  ].filter(Boolean)));
  // 다른 프로그램 한 곳에만 귀속된 클레임(모호하지 않음)일 때만 재사용 후보다 — ambiguous(2곳 이상)는
  // 여전히 program_scope_ambiguous로 거부한다(아래, 변경 없음).
  const crossProgramReuse = Boolean(input.crossProgramCandidatesAllowed)
    && claimedScopes.length === 1
    && claimedScopes[0] !== canonicalProgramId;
  const evidenceMode = crossProgramReuse || claimedScopes.length === 0
    ? "exact_program_re_evaluation"
    : "scoped_candidate_provenance";
  const result = (
    eligible: boolean,
    reason: ProgramCampaignCandidateEligibility["reason"],
    keywordGateBypassed = false,
  ): ProgramCampaignCandidateEligibility => ({ eligible, reason, canonicalProgramId, evidenceMode, criteriaHash, keywordGateBypassed });

  if (!canonicalProgramId) return result(false, "program_scope_mismatch");
  if (!crossProgramReuse && claimedScopes.some((scope) => scope !== canonicalProgramId)) {
    return result(false, "program_scope_mismatch");
  }
  if (claimedScopes.length > 1) return result(false, "program_scope_ambiguous");
  const hasExactReevaluation = criteria.regions.length > 0
    || criteria.categories.length > 0
    || criteria.keywords.length > 0
    || criteria.excludeKeywords.length > 0
    || criteria.minFollowers > 0
    || criteria.maxFollowers > 0;
  // crossProgramReuse도 unscoped(claimedScopes.length===0)와 같은 요구를 진다 — 다른 프로그램의
  // provenance를 신뢰하지 않으므로 이 프로그램의 명시적 기준(criteria) 없이는 통과시키지 않는다.
  if ((claimedScopes.length === 0 || crossProgramReuse) && !hasExactReevaluation) {
    return result(false, "unscoped_without_exact_reevaluation");
  }

  const country = text(input.candidate.region || input.candidate.country || input.candidate.creatorCountry, 8).toUpperCase();
  if (criteria.regions.length > 0 && (!country || !criteria.regions.includes(country))) {
    return result(false, "country_mismatch");
  }
  const searchText = [
    input.candidate.name,
    input.candidate.channelTitle,
    input.candidate.handle,
    input.candidate.platform,
    input.candidate.category,
    input.candidate.publicDescription,
    ...(Array.isArray(input.candidate.matchedSearchTerms) ? input.candidate.matchedSearchTerms : []),
  ].map((value) => text(value, 5_000).toLowerCase()).filter(Boolean).join(" ");
  if (criteria.excludeKeywords.some((keyword) => searchText.includes(keyword))) {
    return result(false, "excluded_keyword");
  }
  // Category labels and include keywords are multilingual alternatives for the
  // same discovery intent. A Korean, Japanese, or English signal may satisfy the
  // include gate; requiring category AND keyword rejects equivalent labels.
  // W8-2 equivalence is comparison-only and runs after criteriaHash is computed. Stored criteria,
  // cache keys, and audit hashes therefore remain byte-for-byte stable.
  const candidateCategoryKey = gameCategoryEquivalenceKey(text(input.candidate.category, 5_000));
  const categoryMatched = criteria.categories.some((category) => {
    const criteriaCategoryKey = gameCategoryEquivalenceKey(category);
    return searchText.includes(category)
      || (criteriaCategoryKey !== null && criteriaCategoryKey === candidateCategoryKey);
  });
  const keywordMatched = criteria.keywords.some((keyword) => searchText.includes(keyword));
  let keywordGateBypassed = false;
  if (
    (criteria.categories.length > 0 || criteria.keywords.length > 0)
    && !categoryMatched
    && !keywordMatched
  ) {
    if (!input.keywordGateBypass) {
      return result(false, criteria.keywords.length > 0 ? "keyword_mismatch" : "category_mismatch");
    }
    // Bypass requested and used — keep evaluating the remaining gates (followers etc.) below;
    // only the keyword/category rejection itself is skipped.
    keywordGateBypassed = true;
  }
  const followers = typeof input.candidate.followers === "number" && Number.isFinite(input.candidate.followers)
    ? Math.max(0, Math.round(input.candidate.followers))
    : null;
  if ((criteria.minFollowers > 0 || criteria.maxFollowers > 0) && followers === null) {
    return result(false, "followers_missing");
  }
  if (followers !== null && criteria.minFollowers > 0 && followers < criteria.minFollowers) {
    return result(false, "followers_below_minimum");
  }
  if (followers !== null && criteria.maxFollowers > 0 && followers > criteria.maxFollowers) {
    return result(false, "followers_above_maximum");
  }
  return result(true, "eligible", keywordGateBypassed);
}

export function assertCampaignControlIdentity(input: {
  requestedProgramId: string;
  requestedCampaignId: string;
  program: Record<string, unknown>;
  campaign: Record<string, unknown>;
  aliasMap?: Record<string, string>;
}): string {
  const campaignId = text(input.campaign.id, 120);
  if (!campaignId || campaignId !== input.requestedCampaignId) {
    throw campaignControlError("failed-precondition", "campaign identity mismatch", "campaign_control_identity_mismatch");
  }
  const aliasMap = input.aliasMap ?? {};
  const requestedCanonical = canonicalIdentity(input.requestedProgramId, aliasMap);
  const declaredCampaignScopes = Array.from(new Set([
    canonicalIdentity(input.campaign.canonicalProgramId, aliasMap),
    canonicalIdentity(input.campaign.programId, aliasMap),
  ].filter(Boolean)));
  const declaredProgramScopes = Array.from(new Set([
    canonicalIdentity(input.program.id, aliasMap),
    canonicalIdentity(input.program.canonicalProgramId, aliasMap),
  ].filter(Boolean)));
  if (
    !requestedCanonical
    || declaredCampaignScopes.length !== 1
    || declaredProgramScopes.length !== 1
    || declaredCampaignScopes[0] !== requestedCanonical
    || declaredProgramScopes[0] !== requestedCanonical
  ) {
    throw campaignControlError("failed-precondition", "canonical program mismatch", "campaign_control_canonical_program_mismatch");
  }
  const campaignProgramRef = text(input.campaign.programRef, 240);
  if (campaignProgramRef) {
    const match = /^programs\/([^/]+)$/.exec(campaignProgramRef);
    if (!match || canonicalIdentity(match[1], aliasMap) !== requestedCanonical) {
      throw campaignControlError("failed-precondition", "campaign programRef mismatch", "campaign_control_program_ref_mismatch");
    }
  }
  return requestedCanonical;
}

export function assertCampaignControlActor(
  actor: MutationAuthorizationActor,
  program: Record<string, unknown>,
  campaign: Record<string, unknown>,
): void {
  assertMutationOwner(actor, mutationOwnerUids(program, { includeCreatedBy: true }), "campaign control program");
  assertMutationOwner(actor, mutationOwnerUids(campaign, { includeCreatedBy: true }), "campaign control campaign");
}

function isAccountScopedCriteriaOnlyUpdate(parsed: CampaignControlUpdateInput): boolean {
  return (parsed.targetingCriteria !== undefined || parsed.countryTargeting !== undefined)
    && parsed.targetMetric === undefined
    && parsed.targetValue === undefined
    && parsed.outreachQuota === undefined
    && parsed.priority === undefined
    && parsed.operationalState === undefined
    && parsed.name === undefined
    && parsed.allowInflyOverlap === undefined
    && parsed.archived === undefined
    && parsed.liveSendCap === undefined
    && parsed.dailyCap === undefined;
}

export function validateCampaignControlMutation(input: CampaignControlValidationInput): {
  parsed: CampaignControlUpdateInput;
  canonicalProgramId: string;
  before: CampaignControlSafeFields;
  after: CampaignControlSafeFields;
  countryProjection: CampaignCountryControlProjection | null;
  nextVersion: number;
} {
  const parsed = parseCampaignControlUpdateInput(input.input, input.dailyCapCeiling);
  const canonicalProgramId = assertCampaignControlIdentity({
    requestedProgramId: parsed.programId,
    requestedCampaignId: parsed.campaignId,
    program: input.program,
    campaign: input.campaign,
    aliasMap: input.aliasMap,
  });
  if (!input.allowAccountScopedCriteriaEdit || !isAccountScopedCriteriaOnlyUpdate(parsed)) {
    assertCampaignControlActor(input.actor, input.program, input.campaign);
  }
  const before = campaignControlSafeFields(input.campaign, input.program);
  if (parsed.expectedVersion !== before.controlVersion) {
    throw campaignControlError("aborted", `campaign control version conflict: expected ${parsed.expectedVersion}, current ${before.controlVersion}`, "campaign_control_version_conflict");
  }
  const committedCount = boundedInteger(input.committedCount, "committedCount", 0, 50_000_000);
  if (parsed.targetValue !== undefined && parsed.targetValue < committedCount) {
    throw campaignControlError("failed-precondition", `targetValue cannot be below committed count ${committedCount}`, "campaign_control_target_value_below_committed");
  }
  if (parsed.outreachQuota !== undefined && parsed.outreachQuota < committedCount) {
    throw campaignControlError("failed-precondition", `outreachQuota cannot be below committed count ${committedCount}`, "campaign_control_quota_below_committed");
  }
  if (parsed.liveSendCap !== undefined) {
    // W100 하드 제약: 도달 시 전량 차단하는 축이라 super_admin 만 만진다. 커밋 수 아래로 내리면
    // "조용한 영구 차단" 상태(이번 사고의 형상)를 즉석에서 만들므로 막는다 — 발송을 멈추려면
    // operationalState=paused 가 정격 경로다.
    if (input.actor.role !== "super_admin") {
      throw campaignControlError("permission-denied", "liveSendCap requires super_admin", "campaign_control_live_send_cap_super_admin_only");
    }
    if (parsed.liveSendCap < committedCount) {
      throw campaignControlError("failed-precondition", `liveSendCap cannot be below committed count ${committedCount}`, "campaign_control_live_send_cap_below_committed");
    }
  }
  const nextVersion = before.controlVersion + 1;
  const countryProjection = parsed.countryTargeting
    ? campaignCountryControlProjection(parsed.countryTargeting, input.program)
    : null;
  const after: CampaignControlSafeFields = {
    targetMetric: parsed.targetMetric ?? before.targetMetric,
    targetValue: parsed.targetValue ?? before.targetValue,
    outreachQuota: parsed.outreachQuota ?? before.outreachQuota,
    priority: parsed.priority ?? before.priority,
    operationalState: parsed.operationalState ?? before.operationalState,
    name: parsed.name ?? before.name,
    countryTargeting: countryProjection?.countryTargeting ?? before.countryTargeting,
    effectiveCountryTargeting: countryProjection?.effectiveCountryTargeting ?? before.effectiveCountryTargeting,
    allowInflyOverlap: parsed.allowInflyOverlap ?? before.allowInflyOverlap,
    liveSendCap: parsed.liveSendCap ?? before.liveSendCap,
    dailyCap: parsed.dailyCap ?? before.dailyCap,
    controlVersion: nextVersion,
  };
  return { parsed, canonicalProgramId, before, after, countryProjection, nextVersion };
}
