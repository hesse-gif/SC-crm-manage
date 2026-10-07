import { adminDb } from "./firebaseAdmin";
import {
  OUTBOUND_ACTIVE_LOCK_REASON,
  OUTBOUND_ACTIVE_LOCK_RULE_ID,
  OUTBOUND_MANUAL_PAUSE_REASON,
  OUTBOUND_MANUAL_PAUSE_RULE_ID,
  readOutboundPolicy,
  readOutboundSafetyBlock,
  readOutboundWeeklyUsage,
  type OutboundSafetyBlock,
} from "./mailOutboundSafety";
import {
  mailIdentityBlockReason,
  mailIdentityBlocksMode,
  type MailIdentitySnapshot,
} from "./mailIdentity";
import { resolveOperationalMailIdentity } from "./mailProfiles";
import { envSecret, getRuntimeIntegration, liveIntegrationsEnabled, publicString, secretReady, type RuntimeIntegration } from "./liveIntegrations";
import { evaluateMailSafety } from "./mailSafetyPolicy";
import type { MailSafetyDecision } from "./mailSafetyShared";
import {
  readMailTransportProbeStatus,
  type MailTransportProbeStatus,
} from "./mailTransportDiagnostics";
import { readSettings } from "./settings";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";

export type MailSafetyLaneStatus = {
  readonly allowed: boolean;
  readonly state: "available" | "blocked" | "degraded";
  readonly code: string;
  readonly message: string;
  readonly blockerCode?: string;
  readonly blockerReason?: string;
  readonly requiresInboundSafety: boolean;
};

export type OutboundQuotaStatus = {
  readonly blocked: boolean;
  readonly blockerCode?: string;
  readonly blockerReason?: string;
  readonly todaySent: number;
  readonly hourSent: number;
  readonly weeklyUsed: number;
  readonly dailyCap: number;
  readonly hourlyCap: number;
  readonly weeklyCap: number;
};

export type MailSafetyOperationalState = {
  readonly manualSend: MailSafetyLaneStatus;
  readonly automatedSend: MailSafetyLaneStatus;
  readonly inboxReceive: MailSafetyLaneStatus;
  readonly inboundDependentAutomation: MailSafetyLaneStatus;
  readonly quota: OutboundQuotaStatus;
};

export type RecipientPolicySummary = {
  readonly activeSuppressionCount: number;
  readonly blockedEmailCount: number;
  readonly blockedDomainCount: number;
  readonly suppressedHandleCount: number;
  readonly recipientSpecificRulesActive: boolean;
  readonly requiresRecipientCheck: true;
};

export type MailSafetyStatus = {
  readonly identity: MailIdentitySnapshot;
  readonly transportProbe?: MailTransportProbeStatus;
  /** @deprecated Legacy alias for automatedSendLocked. */
  readonly outboundLocked: boolean;
  readonly automatedSendLocked: boolean;
  readonly allOutboundLocked: boolean;
  readonly manualSendAllowed: boolean;
  readonly lockedReason?: string;
  readonly lockedRuleId?: string;
  readonly unlockTimeIso?: string;
  readonly todaySent: number;
  readonly hourSent: number;
  readonly bounced: number;
  readonly deferred: number;
  readonly suppressed: number;
  readonly policy: {
    readonly hourlyCap: number;
    readonly dailyCap: number;
    readonly burstCap: number;
    readonly uniqueRecipientDailyCap: number;
    readonly weeklyTotalCap: number;
    readonly reputationStatus: string;
  };
  // A3(RT-3)/S3: 동일-tx rollup — reserveOutboundQuota가 쓰는 global weekly ledger를
  // 그대로 읽은 값(별도 카운터 아님). 설정 UI "현재 주 사용량" 표시용.
  readonly weeklyOutbound: {
    readonly weekKey: string;
    readonly used: number;
    readonly cap: number;
  };
  readonly imapConfiguration: {
    readonly liveEnabled: boolean;
    readonly configured: boolean;
    readonly missingFields: readonly string[];
    readonly operationalReady: boolean;
    readonly operationalMissingFields: readonly string[];
    readonly hostConfigured: boolean;
    readonly usernameConfigured: boolean;
    readonly credentialConfigured: boolean;
    readonly runtimeSecretBound: boolean;
    readonly passwordReferenceConfigured: boolean;
  };
  readonly imapLastSync?: {
    readonly runId: string;
    readonly status: string;
    readonly finishedAtIso?: string;
    readonly fetched: number;
    readonly matched: number;
    readonly bounced: number;
    readonly errors: number;
  };
  readonly imapLastSuccess?: {
    readonly runId: string;
    readonly status: string;
    readonly finishedAtIso?: string;
    readonly fetched: number;
    readonly matched: number;
    readonly bounced: number;
    readonly errors: number;
  };
  // ingest / quarantine operator visibility (P-H4)
  readonly imapLastSyncIso?: string;
  readonly imapLastResult?: "ok" | "error";
  readonly ingestBacklogQueued: number;
  readonly ingestErrors: number;
  readonly ingestUnresolvedErrors: number;
  readonly quarantineCount: number;
  readonly operational: MailSafetyOperationalState;
  readonly controls: {
    readonly emergencyShutdown: {
      readonly active: boolean;
      readonly blockerCode: "mail-safety.emergency-shutdown";
      readonly blockerReason: string;
    };
    readonly manualPause: {
      readonly active: boolean;
      readonly blockerCode: typeof OUTBOUND_MANUAL_PAUSE_RULE_ID;
      readonly blockerReason: typeof OUTBOUND_MANUAL_PAUSE_REASON;
    };
    readonly activeOutboundLock: {
      readonly active: boolean;
      readonly blockerCode: typeof OUTBOUND_ACTIVE_LOCK_RULE_ID;
      readonly blockerReason: typeof OUTBOUND_ACTIVE_LOCK_REASON;
      readonly unlockTimeIso?: string;
    };
    readonly quota: OutboundQuotaStatus;
    readonly recipientPolicy: RecipientPolicySummary;
  };
  readonly recipientCheck?: {
    readonly evaluated: true;
    readonly manualSend: MailSafetyLaneStatus;
    readonly automatedSend: MailSafetyLaneStatus;
  };
};

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

const EMERGENCY_BLOCKER = {
  code: "mail-safety.emergency-shutdown",
  message: "긴급 메일 셧다운이 켜져 있어 모든 자동·수동 발송을 차단합니다.",
} as const;

export const IMAP_RECENT_SUCCESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SAFE_RECIPIENT_BLOCKERS: Readonly<Record<string, string>> = {
  identity_ok_unverified_subject: "정규 메일함 문자열은 일치하지만 공급자 인증 주체가 검증되지 않아 발송을 차단합니다.",
  identity_mismatch: "SMTP/IMAP 메일함 설정이 정규 운영 메일함과 일치하지 않아 발송을 차단합니다.",
  identity_unknown: "SMTP/IMAP 메일함 신원을 확인할 수 없어 발송을 차단합니다.",
  probe_stale_config_changed: "메일 설정 변경 후 연결 진단이 다시 실행되지 않아 이전 진단 결과를 사용하지 않습니다.",
  "mail-safety.emergency-shutdown": EMERGENCY_BLOCKER.message,
  [OUTBOUND_ACTIVE_LOCK_RULE_ID]: OUTBOUND_ACTIVE_LOCK_REASON,
  [OUTBOUND_MANUAL_PAUSE_RULE_ID]: OUTBOUND_MANUAL_PAUSE_REASON,
  "mail-safety.blocked-email": "블랙리스트 이메일과 일치하여 발송을 차단합니다.",
  "mail-safety.blocked-domain": "블랙리스트 도메인과 일치하여 발송을 차단합니다.",
  "mail-safety.disposable-domain": "일회용 메일 도메인으로 판단되어 발송을 차단합니다.",
  "mail-safety.role-account": "역할 계정 주소로 판단되어 콜드메일 발송을 차단합니다.",
  "mail-safety.suppressed-contact": "기존 억제 목록과 일치하여 발송을 차단합니다.",
  "mail-safety.suppressed-handle": "블랙리스트 핸들과 일치하여 발송을 차단합니다.",
  "mail-safety.complaint-keyword": "수신거부·법적 조치 신호가 감지되어 자동회신을 중단합니다.",
  "mail-safety.game-company-blacklist": "기존 억제 목록과 일치하여 발송을 차단합니다.",
  "mail-safety.infly-overlap": "기존 억제 목록과 일치하여 발송을 차단합니다.",
  "automation.ai-disabled": "AI 자동화 마스터가 꺼져 있어 자동 발송을 중단합니다.",
  "automation.auto-reply-disabled": "채팅 자동응답 발송이 꺼져 있어 자동 발송을 중단합니다.",
  "program-ai.disabled": "프로그램 AI 운영이 꺼져 있어 프로그램 자동 발송을 중단합니다.",
};

function availableLane(code: string, message: string, requiresInboundSafety = false): MailSafetyLaneStatus {
  return { allowed: true, state: "available", code, message, requiresInboundSafety };
}

function degradedLane(code: string, message: string, allowed: boolean, requiresInboundSafety: boolean): MailSafetyLaneStatus {
  return {
    allowed,
    state: "degraded",
    code,
    message,
    ...(allowed ? {} : { blockerCode: code, blockerReason: message }),
    requiresInboundSafety,
  };
}

function blockedLane(code: string, message: string, requiresInboundSafety = false): MailSafetyLaneStatus {
  return {
    allowed: false,
    state: "blocked",
    code,
    message,
    blockerCode: code,
    blockerReason: message,
    requiresInboundSafety,
  };
}

function outboundBlockLane(block: OutboundSafetyBlock, requiresInboundSafety = false): MailSafetyLaneStatus | null {
  if (!block.blocked) return null;
  const code = block.ruleId === OUTBOUND_MANUAL_PAUSE_RULE_ID
    ? OUTBOUND_MANUAL_PAUSE_RULE_ID
    : OUTBOUND_ACTIVE_LOCK_RULE_ID;
  const message = code === OUTBOUND_MANUAL_PAUSE_RULE_ID
    ? OUTBOUND_MANUAL_PAUSE_REASON
    : OUTBOUND_ACTIVE_LOCK_REASON;
  return blockedLane(code, message, requiresInboundSafety);
}

export function resolveOutboundQuotaStatus(input: {
  readonly todaySent: number;
  readonly hourSent: number;
  readonly weeklyUsed: number;
  readonly dailyCap: number;
  readonly hourlyCap: number;
  readonly weeklyCap: number;
}): OutboundQuotaStatus {
  const normalized = {
    todaySent: numberValue(input.todaySent),
    hourSent: numberValue(input.hourSent),
    weeklyUsed: numberValue(input.weeklyUsed),
    dailyCap: numberValue(input.dailyCap),
    hourlyCap: numberValue(input.hourlyCap),
    weeklyCap: numberValue(input.weeklyCap),
  };
  if (normalized.hourlyCap <= 0 || normalized.hourSent >= normalized.hourlyCap) {
    return {
      ...normalized,
      blocked: true,
      blockerCode: "mail-safety.quota-hourly",
      blockerReason: "시간당 메일 발송 한도에 도달했습니다.",
    };
  }
  if (normalized.dailyCap <= 0 || normalized.todaySent >= normalized.dailyCap) {
    return {
      ...normalized,
      blocked: true,
      blockerCode: "mail-safety.quota-daily",
      blockerReason: "일일 메일 발송 한도에 도달했습니다.",
    };
  }
  // weeklyTotalCap=0 is the existing policy's explicit no-weekly-cap value.
  if (normalized.weeklyCap > 0 && normalized.weeklyUsed >= normalized.weeklyCap) {
    return {
      ...normalized,
      blocked: true,
      blockerCode: "mail-safety.quota-weekly",
      blockerReason: "주간 메일 발송 한도에 도달했습니다.",
    };
  }
  return { ...normalized, blocked: false };
}

function inboxLane(
  configuration: MailSafetyStatus["imapConfiguration"],
  lastResult?: "ok" | "error",
): MailSafetyLaneStatus {
  if (!configuration.liveEnabled) {
    return blockedLane(
      "mail-safety.imap-live-disabled",
      "IMAP 실시간 수신이 비활성화되어 있습니다.",
      true,
    );
  }
  if (!configuration.configured) {
    return blockedLane(
      "mail-safety.imap-not-configured",
      "IMAP 필수 설정이 완료되지 않았습니다.",
      true,
    );
  }
  if (!configuration.operationalReady) {
    return blockedLane(
      "mail-safety.imap-runtime-not-ready",
      "IMAP 설정은 저장되었지만 런타임 Secret 바인딩이 준비되지 않았습니다.",
      true,
    );
  }
  if (lastResult === "error") {
    return degradedLane(
      "mail-safety.imap-last-sync-error",
      "최근 IMAP 수신 동기화가 실패했습니다.",
      false,
      true,
    );
  }
  if (!lastResult) {
    return degradedLane(
      "mail-safety.imap-no-sync-history",
      "IMAP 설정은 완료되었지만 아직 동기화 이력이 없습니다.",
      true,
      true,
    );
  }
  return availableLane("mail-safety.inbox-receive-ok", "IMAP 수신 경로가 정상입니다.", true);
}

export function resolveMailSafetyOperationalState(input: {
  readonly emergencyShutdownEnabled: boolean;
  readonly automationEnabled: boolean;
  readonly manualOutboundBlock: OutboundSafetyBlock;
  readonly automatedOutboundBlock: OutboundSafetyBlock;
  readonly quota: {
    readonly todaySent: number;
    readonly hourSent: number;
    readonly weeklyUsed: number;
    readonly dailyCap: number;
    readonly hourlyCap: number;
    readonly weeklyCap: number;
  };
  readonly imapConfiguration: MailSafetyStatus["imapConfiguration"];
  readonly imapLastResult?: "ok" | "error";
  readonly imapLastSyncIso?: string;
  readonly ingestUnresolvedErrors?: number;
  readonly nowIso?: string;
  readonly identity?: MailIdentitySnapshot;
  readonly transportProbe?: MailTransportProbeStatus | null;
}): MailSafetyOperationalState {
  const quota = resolveOutboundQuotaStatus(input.quota);
  const identityOutboundBlock = input.identity && mailIdentityBlocksMode(input.identity, "manual_send")
    ? blockedLane(
      input.identity.identityCode,
      SAFE_RECIPIENT_BLOCKERS[input.identity.identityCode] ?? mailIdentityBlockReason(input.identity),
    )
    : null;
  const identityInboundBlock = input.identity && mailIdentityBlocksMode(input.identity, "receive")
    ? blockedLane(
      input.identity.identityCode,
      SAFE_RECIPIENT_BLOCKERS[input.identity.identityCode] ?? mailIdentityBlockReason(input.identity),
      true,
    )
    : null;
  const staleProbeBlock = input.transportProbe?.probeState === "probe_stale_config_changed"
    || input.transportProbe?.smtp.code === "probe_stale_config_changed"
    || input.transportProbe?.imap.code === "probe_stale_config_changed"
    ? blockedLane(
      "probe_stale_config_changed",
      SAFE_RECIPIENT_BLOCKERS.probe_stale_config_changed,
      true,
    )
    : null;
  const emergency = input.emergencyShutdownEnabled
    ? blockedLane(EMERGENCY_BLOCKER.code, EMERGENCY_BLOCKER.message)
    : null;
  const manualPolicyBlock = identityOutboundBlock
    ?? emergency
    ?? outboundBlockLane(input.manualOutboundBlock);
  const automatedPolicyBlock = identityOutboundBlock
    ?? emergency
    ?? outboundBlockLane(input.automatedOutboundBlock)
    ?? (!input.automationEnabled
      ? blockedLane("automation.ai-disabled", SAFE_RECIPIENT_BLOCKERS["automation.ai-disabled"] ?? "자동 발송이 비활성화되어 있습니다.")
      : null);
  const quotaLane = quota.blocked
    ? blockedLane(quota.blockerCode ?? "mail-safety.quota", quota.blockerReason ?? "메일 발송 한도에 도달했습니다.")
    : null;
  const manualSend = manualPolicyBlock
    ?? quotaLane
    ?? availableLane("mail-safety.manual-send-ok", "수동 1:1 발송 안전 게이트를 통과했습니다.");
  const automatedSend = automatedPolicyBlock
    ?? quotaLane
    ?? availableLane("mail-safety.automated-send-ok", "자동 발송 안전 게이트를 통과했습니다.");
  const unresolvedIngestBlock = (input.ingestUnresolvedErrors ?? 0) > 0
    ? blockedLane(
      "mail-safety.imap-unresolved-ingest-errors",
      `처리되지 않은 받은 메일 오류가 ${input.ingestUnresolvedErrors}건 있습니다. 복구 전까지 수신 상태를 정상으로 표시하지 않습니다.`,
      true,
    )
    : null;
  const inboxReceive = identityInboundBlock
    ?? staleProbeBlock
    ?? unresolvedIngestBlock
    ?? inboxLane(input.imapConfiguration, input.imapLastResult);
  const nowMs = Date.parse(input.nowIso ?? new Date().toISOString());
  const lastSuccessfulSyncMs = input.imapLastResult === "ok"
    ? Date.parse(input.imapLastSyncIso ?? "")
    : Number.NaN;
  const hasRecentSuccessfulSync = Number.isFinite(nowMs)
    && Number.isFinite(lastSuccessfulSyncMs)
    && lastSuccessfulSyncMs <= nowMs + 5 * 60 * 1000
    && nowMs - lastSuccessfulSyncMs <= IMAP_RECENT_SUCCESS_MAX_AGE_MS;
  const inboundSyncBlock = !Number.isFinite(lastSuccessfulSyncMs)
    ? blockedLane(
      "mail-safety.imap-no-recent-success",
      "최근 성공한 IMAP 수신 동기화 이력이 없어 수신 기반 자동화를 차단합니다.",
      true,
    )
    : !hasRecentSuccessfulSync
      ? blockedLane(
        "mail-safety.imap-success-stale",
        "최근 성공한 IMAP 수신 동기화가 오래되어 수신 기반 자동화를 차단합니다.",
        true,
      )
      : null;
  const inboundDependentAutomation = !automatedSend.allowed
    ? { ...automatedSend, requiresInboundSafety: true }
    : !inboxReceive.allowed
      ? { ...inboxReceive, requiresInboundSafety: true }
      : inboundSyncBlock
        ? inboundSyncBlock
        : availableLane(
          "mail-safety.inbound-automation-ok",
          "수신 안전성이 필요한 자동화 경로가 정상입니다.",
          true,
        );
  return { manualSend, automatedSend, inboxReceive, inboundDependentAutomation, quota };
}

export function resolveMailSafetyLockSummary(operational: MailSafetyOperationalState): {
  /** @deprecated Legacy alias retained for existing consumers. */
  readonly outboundLocked: boolean;
  readonly automatedSendLocked: boolean;
  readonly allOutboundLocked: boolean;
  readonly manualSendAllowed: boolean;
} {
  const manualSendAllowed = operational.manualSend.allowed;
  const automatedSendLocked = !operational.automatedSend.allowed;
  return {
    outboundLocked: automatedSendLocked,
    automatedSendLocked,
    allOutboundLocked: automatedSendLocked && !manualSendAllowed,
    manualSendAllowed,
  };
}

function blockerPriority(code: string): number {
  if (code.startsWith("identity_")) return 110;
  if (code === "mail-safety.emergency-shutdown") return 100;
  if (code === "probe_stale_config_changed") return 95;
  if (code === OUTBOUND_ACTIVE_LOCK_RULE_ID) return 90;
  if (
    code.startsWith("mail-safety.blocked-")
    || code.includes("suppressed")
    || code === "mail-safety.complaint-keyword"
    || code === "mail-safety.game-company-blacklist"
    || code === "mail-safety.infly-overlap"
    || code === "mail-safety.disposable-domain"
    || code === "mail-safety.role-account"
  ) return 80;
  if (code === OUTBOUND_MANUAL_PAUSE_RULE_ID || code.startsWith("automation.") || code.startsWith("program-ai.")) return 70;
  if (code.startsWith("mail-safety.quota")) return 60;
  return 50;
}

/** Merge the recipient policy decision with the global operational lane in send-order. */
export function resolveRecipientSafetyLane(
  operational: MailSafetyLaneStatus,
  decision: MailSafetyDecision,
): MailSafetyLaneStatus {
  if (decision.allowed) return operational;
  const rawRuleId = asString(decision.ruleId, "");
  const blockerCode = SAFE_RECIPIENT_BLOCKERS[rawRuleId]
    ? rawRuleId
    : "mail-safety.recipient-blocked";
  const blockerReason = SAFE_RECIPIENT_BLOCKERS[blockerCode]
    ?? "수신자 안전 정책에 따라 발송을 차단합니다.";
  if (!operational.allowed && blockerPriority(operational.code) >= blockerPriority(blockerCode)) return operational;
  return blockedLane(blockerCode, blockerReason, operational.requiresInboundSafety);
}

function dayKey(now: Date): string {
  return `day_${now.toISOString().slice(0, 10)}`;
}

function hourKey(now: Date): string {
  return `hour_${now.toISOString().slice(0, 13)}`;
}

async function recentFailureCounts(now: Date): Promise<{ readonly bounced: number; readonly deferred: number }> {
  const since = now.getTime() - 24 * 60 * 60 * 1000;
  const snapshot = await adminDb.collection("mail_delivery_failures").where("createdAtMs", ">=", since).limit(500).get();
  let bounced = 0;
  let deferred = 0;
  for (const doc of snapshot.docs) {
    const kind = asString(doc.data().kind, "");
    if (kind === "hard_bounce" || kind === "invalid_recipient" || kind === "no_mx") bounced += 1;
    if (kind === "deferred" || kind === "rate_limit" || kind === "temporary") deferred += 1;
  }
  return { bounced, deferred };
}

async function activeSuppressionCount(): Promise<number> {
  const snapshot = await adminDb.collection("mail_suppressions").limit(500).get();
  return snapshot.docs.filter((doc) => {
    const status = asString(doc.data().status, "active");
    return status !== "inactive" && status !== "resolved" && status !== "expired";
  }).length;
}

function uniquePolicyCount(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)).size;
}

function recipientInput(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const nested = asRecord(data.recipient);
  const candidate = {
    ...nested,
    to: asString(nested.to, asString(data.to, asString(data.creatorEmail, ""))),
    creatorEmail: asString(nested.creatorEmail, asString(data.creatorEmail, "")),
    creatorHandle: asString(nested.creatorHandle, asString(data.creatorHandle, asString(data.handle, ""))),
    creatorName: asString(nested.creatorName, asString(data.creatorName, asString(data.name, ""))),
    creatorCategory: asString(nested.creatorCategory, asString(data.creatorCategory, "")),
    creatorPlatform: asString(nested.creatorPlatform, asString(data.creatorPlatform, "")),
  };
  return Object.values(candidate).some((value) => typeof value === "string" && value.trim())
    ? candidate
    : undefined;
}


export function evaluateImapConfigurationStatus(config: Pick<RuntimeIntegration, "public" | "secrets">, liveEnabled = liveIntegrationsEnabled("imap")): MailSafetyStatus["imapConfiguration"] {
  const runtimeConfig: RuntimeIntegration = { key: "mailImap", public: config.public, secrets: config.secrets };
  const hostConfigured = publicString(runtimeConfig, "host", "IMAP_HOST", "").trim().length > 0;
  const usernameConfigured = publicString(runtimeConfig, "username", "IMAP_USER", "").trim().length > 0;
  const credentialConfigured = asString(asRecord(config.secrets.password).fingerprint, "").length > 0;
  const runtimeSecretBound = envSecret("IMAP_PASSWORD").length > 0;
  const passwordReferenceConfigured = secretReady(runtimeConfig, "password", "IMAP_PASSWORD");
  const missingFields = [
    ...(hostConfigured ? [] : ["host"]),
    ...(usernameConfigured ? [] : ["username"]),
    ...(passwordReferenceConfigured ? [] : ["password"]),
  ];
  const operationalMissingFields = [
    ...(hostConfigured ? [] : ["host"]),
    ...(usernameConfigured ? [] : ["username"]),
    ...(runtimeSecretBound ? [] : ["runtime_password"]),
  ];
  return {
    liveEnabled,
    configured: missingFields.length === 0,
    missingFields,
    operationalReady: liveEnabled && operationalMissingFields.length === 0,
    operationalMissingFields,
    hostConfigured,
    usernameConfigured,
    credentialConfigured,
    runtimeSecretBound,
    passwordReferenceConfigured,
  };
}

async function imapConfigurationStatus(): Promise<MailSafetyStatus["imapConfiguration"]> {
  const config = await getRuntimeIntegration("mailImap");
  return evaluateImapConfigurationStatus(config);
}

type ImapRunSummary = NonNullable<MailSafetyStatus["imapLastSync"]>;

function summarizeImapRun(doc: { id: string; data(): Record<string, unknown> } | undefined): ImapRunSummary | undefined {
  if (!doc) return undefined;
  const data = doc.data();
  return {
    runId: asString(data.runId, doc.id),
    status: asString(data.status, "unknown"),
    ...(asString(data.finishedAtIso, "") ? { finishedAtIso: asString(data.finishedAtIso, "") } : {}),
    fetched: numberValue(data.fetched),
    matched: numberValue(data.matched),
    bounced: numberValue(data.bounced),
    errors: numberValue(data.errors),
  };
}

function isSuccessfulImapRun(status: string): boolean {
  return status === "ok" || status === "done" || status === "success" || status === "completed";
}

function latestImapSuccess<T extends { data(): Record<string, unknown> }>(docs: readonly T[]): T | undefined {
  return docs.find((doc) => isSuccessfulImapRun(asString(doc.data().status, "")));
}

async function imapRuntimeHealth(): Promise<{
  imapLastSync?: ImapRunSummary;
  imapLastSuccess?: ImapRunSummary;
  imapLastSyncIso?: string;
  imapLastResult?: "ok" | "error";
  ingestBacklogQueued: number;
  ingestErrors: number;
  ingestUnresolvedErrors: number;
  quarantineCount: number;
}> {
  const [runsSnap, backlogSnap, errorsSnap, quarantineSnap] = await Promise.all([
    adminDb.collection("mail_ingest_runs").orderBy("startedAtIso", "desc").limit(50).get(),
    adminDb.collection("mail_ingest_queue").where("status", "==", "queued").limit(500).get(),
    adminDb.collection("mail_ingest_errors").orderBy("createdAtIso", "desc").limit(100).get(),
    adminDb.collection("mail_inbound_quarantine").where("reviewStatus", "==", "pending").limit(500).get(),
  ]);

  const runDoc = runsSnap.docs[0];
  const successDoc = latestImapSuccess(runsSnap.docs);
  const imapLastSync = summarizeImapRun(runDoc);
  const imapLastSuccess = summarizeImapRun(successDoc);
  let imapLastSyncIso: string | undefined;
  let imapLastResult: "ok" | "error" | undefined;
  if (runDoc) {
    const finishedAt = asString(runDoc.data().finishedAtIso, "");
    if (finishedAt) imapLastSyncIso = finishedAt;
    const runStatus = asString(runDoc.data().status, "");
    if (isSuccessfulImapRun(runStatus)) imapLastResult = "ok";
    else if (runStatus) imapLastResult = "error";
  }

  const ingestUnresolvedErrors = errorsSnap.docs.filter((doc) => {
    const row = doc.data();
    const status = asString(row.status, "");
    return status === "retry_pending" || (status === "dead_letter" && row.deadLetterAcknowledged !== true);
  }).length;

  return {
    ...(imapLastSync ? { imapLastSync } : {}),
    ...(imapLastSuccess ? { imapLastSuccess } : {}),
    ...(imapLastSyncIso !== undefined ? { imapLastSyncIso } : {}),
    ...(imapLastResult !== undefined ? { imapLastResult } : {}),
    ingestBacklogQueued: backlogSnap.size,
    ingestErrors: errorsSnap.size,
    ingestUnresolvedErrors,
    quarantineCount: quarantineSnap.size,
  };
}

export async function readMailSafetyStatus(
  now = new Date(),
  recipient?: Record<string, unknown>,
): Promise<MailSafetyStatus> {
  const identity = await resolveOperationalMailIdentity();
  const [settings, policy, manualBlock, automatedBlock, dayRollup, hourRollup, failures, suppressed, imapConfig, imapHealth, weeklyUsage, transportProbe] = await Promise.all([
    readSettings(),
    readOutboundPolicy(),
    readOutboundSafetyBlock(now.toISOString(), "manual_send"),
    readOutboundSafetyBlock(now.toISOString(), "auto_send"),
    adminDb.collection("mail_quota_rollups").doc(dayKey(now)).get(),
    adminDb.collection("mail_quota_rollups").doc(hourKey(now)).get(),
    recentFailureCounts(now),
    activeSuppressionCount(),
    imapConfigurationStatus(),
    imapRuntimeHealth(),
    readOutboundWeeklyUsage(now),
    readMailTransportProbeStatus(identity),
  ]);
  const todaySent = numberValue(dayRollup.data()?.sent);
  const hourSent = numberValue(hourRollup.data()?.sent);
  const operational = resolveMailSafetyOperationalState({
    emergencyShutdownEnabled: settings.mailSafety.emergencyShutdownEnabled === true,
    automationEnabled: settings.automation.aiAutomationEnabled === true,
    manualOutboundBlock: manualBlock,
    automatedOutboundBlock: automatedBlock,
    quota: {
      todaySent,
      hourSent,
      weeklyUsed: weeklyUsage.used,
      dailyCap: policy.dailyCap,
      hourlyCap: policy.hourlyCap,
      weeklyCap: policy.weeklyTotalCap,
    },
    imapConfiguration: imapConfig,
    imapLastResult: imapHealth.imapLastResult,
    imapLastSyncIso: imapHealth.imapLastSyncIso,
    ingestUnresolvedErrors: imapHealth.ingestUnresolvedErrors,
    nowIso: now.toISOString(),
    identity,
    transportProbe,
  });
  const blockedEmailCount = uniquePolicyCount(settings.mailSafety.blockedEmails);
  const blockedDomainCount = uniquePolicyCount(settings.mailSafety.blockedDomains);
  const suppressedHandleCount = uniquePolicyCount(settings.mailSafety.suppressedHandles);
  const recipientPolicy: RecipientPolicySummary = {
    activeSuppressionCount: suppressed,
    blockedEmailCount,
    blockedDomainCount,
    suppressedHandleCount,
    recipientSpecificRulesActive: suppressed + blockedEmailCount + blockedDomainCount + suppressedHandleCount > 0,
    requiresRecipientCheck: true,
  };
  const recipientDecisions = recipient
    ? await Promise.all([
      evaluateMailSafety(recipient, "status-recipient-manual", "manual_send"),
      evaluateMailSafety(recipient, "status-recipient-automated", "auto_send"),
    ])
    : undefined;
  const legacyLane = operational.automatedSend;
  const lockSummary = resolveMailSafetyLockSummary(operational);
  return {
    identity,
    ...(transportProbe ? { transportProbe } : {}),
    ...lockSummary,
    ...(!legacyLane.allowed ? { lockedReason: legacyLane.blockerReason, lockedRuleId: legacyLane.blockerCode } : {}),
    ...(manualBlock.blockedUntilIso ? { unlockTimeIso: manualBlock.blockedUntilIso } : {}),
    todaySent,
    hourSent,
    bounced: failures.bounced,
    deferred: failures.deferred,
    suppressed,
    policy: {
      hourlyCap: policy.hourlyCap,
      dailyCap: policy.dailyCap,
      burstCap: policy.burstCap,
      uniqueRecipientDailyCap: policy.uniqueRecipientDailyCap,
      weeklyTotalCap: policy.weeklyTotalCap,
      reputationStatus: policy.reputationStatus,
    },
    weeklyOutbound: weeklyUsage,
    imapConfiguration: imapConfig,
    ...imapHealth,
    operational,
    controls: {
      emergencyShutdown: {
        active: settings.mailSafety.emergencyShutdownEnabled === true,
        blockerCode: EMERGENCY_BLOCKER.code,
        blockerReason: EMERGENCY_BLOCKER.message,
      },
      manualPause: {
        active: automatedBlock.ruleId === OUTBOUND_MANUAL_PAUSE_RULE_ID,
        blockerCode: OUTBOUND_MANUAL_PAUSE_RULE_ID,
        blockerReason: OUTBOUND_MANUAL_PAUSE_REASON,
      },
      activeOutboundLock: {
        active: manualBlock.ruleId === OUTBOUND_ACTIVE_LOCK_RULE_ID,
        blockerCode: OUTBOUND_ACTIVE_LOCK_RULE_ID,
        blockerReason: OUTBOUND_ACTIVE_LOCK_REASON,
        ...(manualBlock.blockedUntilIso ? { unlockTimeIso: manualBlock.blockedUntilIso } : {}),
      },
      quota: operational.quota,
      recipientPolicy,
    },
    ...(recipientDecisions ? {
      recipientCheck: {
        evaluated: true as const,
        manualSend: resolveRecipientSafetyLane(operational.manualSend, recipientDecisions[0]),
        automatedSend: resolveRecipientSafetyLane(operational.automatedSend, recipientDecisions[1]),
      },
    } : {}),
  };
}

export async function getMailSafetyStatus(request: CallableRequestShape) {
  const ctx = assertNonGuestAuth(request, "getMailSafetyStatus");
  const status = await readMailSafetyStatus(new Date(), recipientInput(asRecord(request.data)));
  return {
    ok: true,
    status,
    behaviorLog: makeBehaviorLog(ctx, "getMailSafetyStatus", "success", ctx.gameId),
  };
}
