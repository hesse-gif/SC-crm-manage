import { computeAutoReplySendAfter } from "./autoReplySendWindow";
import { adminDb } from "./firebaseAdmin";
import { sourceRef, type SourceRef } from "./knowledgeGraph";
import {
  getRuntimeIntegration,
  publicBoolean,
  publicNumber,
  publicString,
  type RuntimeIntegration,
} from "./liveIntegrations";
import {
  resolveMailIdentity,
  type MailIdentitySnapshot,
} from "./mailIdentity";
import type { MailAccount } from "./mailAccounts";
import { resolveImapMailbox } from "./mailImapConfiguration";
import { readMailProviderAttestationProjection } from "./mailProviderAttestation";
import { findMailSuppression, mailSuppressionBlocksSend, allowsTransactionalInflyOverlap } from "./mailSuppression";
import { readSettings } from "./settings";
import { asRecord, asString } from "./shared";

export type MailIntent = "onboarding" | "followup" | "negotiation" | "contract" | "auto_reply" | "campaign_outreach";
export type MailProfileScope = "global" | "project" | "program" | "campaign";

export type MailProfileSnapshot = {
  id: string;
  scope: MailProfileScope;
  sourcePath: string;
  intent: MailIntent;
  enabled: boolean;
  tone: string;
  format: string;
  minReplyDelayMinutes: number;
  maxDailySends: number;
  humanApprovalRequired: boolean;
  dryRun: boolean;
  liveSend: boolean;
  templateRef: string;
  policyVersion: string;
};

export type TemplateSnapshot = {
  ref: string;
  version: string;
  title: string;
  stage: string;
  channel: string;
  body: string;
  updatedAtIso: string;
};

export type MailProfileResolution = {
  resolvedProfileSnapshot: MailProfileSnapshot;
  templateSnapshot: TemplateSnapshot;
  policyVersion: string;
  sourceRefs: SourceRef[];
  sendAfterIso: string;
  dryRun: boolean;
  liveSend: boolean;
  // [적대 리뷰 LOW-2] computeAutoReplySendAfter 가 계산한 실제 지연(분)·영업시간 창으로 미뤄졌는지
  // 여부 — 종전엔 여기서 버려져 auto_reply_queue 문서에서 확인할 방법이 없었다(관측성 공백).
  effectiveDelayMinutes?: number;
  deferredToBusinessWindow?: boolean;
};

export type MailProfileSafetyDecision = {
  allowed: boolean; ruleId: string;
  reason: string;
  liveSendAllowed: boolean;
  matchedKeyword?: string;
};

export type MailProfileSafetyOptions = {
  /**
   * Only server-derived provenance may set this true — never a client/caller-supplied flag.
   * Two independent, additive sources qualify (chat-ai.ts sendAutoReplyJob is the only caller
   * that sets this for a humanApprovalRequired profile):
   *   1. A trusted inbound IMAP mailbox (recheckTrustedInboundAutoReplyAccount +
   *      inboundAutoReplyAllowedMailAccountIds allowlist).
   *   2. auto-reply-approval-bypass (2026-09-25, 헤세 결정 "자동응답만 예외"): the auto_reply lane
   *      only, for a job with complete Permit provenance (casebook_template render + armed
   *      permit + JEV send decision or the interest_next_steps allowlist), gated by the
   *      automation.autoReplyBypassesProfileHumanApproval kill-switch (default true). This
   *      never applies to outbound/campaign mail — no outreach/cold-mail call site sets it.
   */
  allowInboundAutoReplyWithoutHumanApproval?: boolean;
};

export type ResolveMailProfileInput = {
  campaignId?: string;
  programId?: string;
  gameId?: string;
  intent?: MailIntent;
  templateRef?: string;
  baseIso?: string;
  campaignOverride?: Record<string, unknown>;
  programOverride?: Record<string, unknown>;
};

export type OperationalMailIdentityContext = {
  readonly identity: MailIdentitySnapshot;
  readonly smtp: {
    readonly config: RuntimeIntegration;
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly authUser: string;
    readonly from: string;
    readonly replyTo: string;
  };
  readonly imap: {
    readonly config: RuntimeIntegration;
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
    readonly authUser: string;
  };
};

type ProfileDraft = Omit<MailProfileSnapshot, "id" | "scope" | "sourcePath" | "policyVersion">;
type ProfileLayer = { scope: MailProfileScope; sourcePath: string; data: Record<string, unknown> };

const DEFAULT_TEMPLATE_BY_INTENT: Record<MailIntent, string> = {
  onboarding: "t1",
  followup: "t1",
  negotiation: "t2",
  contract: "t3",
  auto_reply: "t2",
  campaign_outreach: "t1",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown, fallback: string, maxLength = 500): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, maxLength) : fallback;
}

function cleanNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
}

function cleanBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeList(values: readonly string[]): string[] {
  return values.map(normalizeToken).filter(Boolean);
}

function emailDomain(value: string): string {
  const at = value.lastIndexOf("@");
  return at >= 0 ? value.slice(at + 1) : "";
}

function firstKeywordMatch(text: string, keywords: readonly string[]): string | undefined {
  const normalized = text.toLowerCase();
  return keywords.find((keyword) => keyword && normalized.includes(keyword.toLowerCase()));
}

function profileRecord(record: Record<string, unknown>, intent: MailIntent): Record<string, unknown> {
  const mailProfiles = isRecord(record.mailProfiles) ? record.mailProfiles : {};
  const intentProfile = isRecord(mailProfiles[intent]) ? mailProfiles[intent] : {};
  const mailProfile = isRecord(record.mailProfile) ? record.mailProfile : {};
  const programAi = isRecord(record.programAi) ? record.programAi : {};
  return { ...programAi, ...mailProfile, ...intentProfile };
}

function overlayProfile(base: ProfileDraft, layer: ProfileLayer, intent: MailIntent): ProfileDraft {
  const record = profileRecord(layer.data, intent);
  if (Object.keys(record).length === 0) return base;
  return {
    ...base,
    enabled: cleanBoolean(record.enabled, base.enabled),
    tone: cleanString(record.tone, cleanString(record.defaultTone, base.tone, 180), 180),
    format: cleanString(record.format, cleanString(record.defaultFormat, base.format, 700), 700),
    minReplyDelayMinutes: cleanNumber(record.minReplyDelayMinutes, cleanNumber(record.minProgramReplyDelayMinutes, base.minReplyDelayMinutes)),
    maxDailySends: cleanNumber(record.maxDailySends, cleanNumber(record.maxPerProgramDailySends, base.maxDailySends)),
    humanApprovalRequired: cleanBoolean(record.humanApprovalRequired, base.humanApprovalRequired),
    dryRun: cleanBoolean(record.dryRun, cleanBoolean(record.dryRunDefault, base.dryRun)),
    liveSend: cleanBoolean(record.liveSend, cleanBoolean(record.liveSendEnabled, base.liveSend)),
    templateRef: cleanString(record.templateRef, cleanString(record.templateId, base.templateRef, 160), 160),
  };
}

async function readLayer(scope: MailProfileScope, path: string, override?: Record<string, unknown>): Promise<ProfileLayer | null> {
  if (override) return { scope, sourcePath: path, data: override };
  const snapshot = await adminDb.doc(path).get();
  return snapshot.exists ? { scope, sourcePath: path, data: snapshot.data() ?? {} } : null;
}

async function readProjectLayer(gameId: string): Promise<ProfileLayer | null> {
  if (!gameId) return null;
  const profile = await readLayer("project", `project_mail_profiles/${gameId}`);
  if (profile) return profile;
  return readLayer("project", `games/${gameId}`);
}

async function templateSnapshot(templateRef: string, fallbackBody: string): Promise<TemplateSnapshot> {
  const ref = templateRef.includes("/") ? templateRef : `templates/${templateRef}`;
  const snapshot = await adminDb.doc(ref).get();
  const data = snapshot.data() ?? {};
  const updatedAtIso = cleanString(data.updatedAtIso, "1970-01-01T00:00:00.000Z", 80);
  return {
    ref,
    version: cleanString(data.version, updatedAtIso || "v1", 120),
    title: cleanString(data.title, "메일 템플릿", 160),
    stage: cleanString(data.stage, "contact", 80),
    channel: cleanString(data.channel, "이메일", 80),
    body: cleanString(data.body, fallbackBody, 5000),
    updatedAtIso,
  };
}

function hashPolicy(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `mail-policy-${hash.toString(36)}`;
}

function fallbackBody(profile: ProfileDraft): string {
  return [
    "{{name}}님,",
    "",
    `Supercent 협업 안내드립니다. 톤: ${profile.tone}`,
    profile.format,
    "",
    "감사합니다.",
    "Supercent Partnerships",
  ].join("\n");
}

function credentialFingerprint(config: RuntimeIntegration): string {
  return asString(asRecord(config.secrets.password).fingerprint, "");
}

/** Resolve the exact public/env SMTP and IMAP inputs used by the live adapters. */
export function resolveOperationalMailIdentityContextFromConfigs(
  smtpConfig: RuntimeIntegration,
  imapConfig: RuntimeIntegration,
  providerSubjectAttested = false,
  canonicalMailboxOverride?: unknown,
  // PLAN-ORG-MAIL-IDENTITY Slice 1: optional, defaults to CANONICAL_OPERATIONAL_MAILBOX_V1
  // inside resolveMailIdentity — every existing caller (all of which omit this) keeps its
  // current byte-identical behavior. Only resolveMailIdentityContextForAccount below
  // supplies a per-account mailbox.
  expectedMailbox?: unknown,
): OperationalMailIdentityContext {
  const smtpPort = publicNumber(smtpConfig, "port", "SMTP_PORT", 587);
  const imapPort = publicNumber(imapConfig, "port", "IMAP_PORT", 993);
  const smtpAuthUser = publicString(smtpConfig, "username", "SMTP_USER", "");
  const smtpFrom = publicString(smtpConfig, "fromAddress", "SMTP_FROM", "");
  const imapAuthUser = publicString(imapConfig, "username", "IMAP_USER", "");
  // sendEmailLive uses the canonical From mailbox as Reply-To. Keep the
  // fingerprint bound to the actual adapter input rather than an unused alias.
  const replyTo = smtpFrom;
  const identity = resolveMailIdentity({
    smtp: {
      host: publicString(smtpConfig, "host", "SMTP_HOST", ""),
      port: smtpPort,
      secure: publicBoolean(smtpConfig, "secure", "SMTP_SECURE", smtpPort === 465),
      authUser: smtpAuthUser,
      from: smtpFrom,
      credentialFingerprint: credentialFingerprint(smtpConfig),
    },
    replyTo,
    imap: {
      host: publicString(imapConfig, "host", "IMAP_HOST", ""),
      port: imapPort,
      secure: publicBoolean(imapConfig, "secure", "IMAP_SECURE", imapPort === 993),
      authUser: imapAuthUser,
      mailbox: resolveImapMailbox(imapConfig),
      credentialFingerprint: credentialFingerprint(imapConfig),
    },
    ...(canonicalMailboxOverride === undefined ? {} : { canonicalMailboxOverride }),
    ...(expectedMailbox === undefined ? {} : { expectedMailbox }),
  }, providerSubjectAttested);
  return {
    identity,
    smtp: {
      config: smtpConfig,
      host: publicString(smtpConfig, "host", "SMTP_HOST", ""),
      port: smtpPort,
      secure: publicBoolean(smtpConfig, "secure", "SMTP_SECURE", smtpPort === 465),
      authUser: smtpAuthUser,
      from: smtpFrom,
      replyTo,
    },
    imap: {
      config: imapConfig,
      host: publicString(imapConfig, "host", "IMAP_HOST", ""),
      port: imapPort,
      secure: publicBoolean(imapConfig, "secure", "IMAP_SECURE", imapPort === 993),
      authUser: imapAuthUser,
    },
  };
}

export async function resolveOperationalMailIdentityContext(
  canonicalMailboxOverride?: unknown,
): Promise<OperationalMailIdentityContext> {
  const [smtpConfig, imapConfig] = await Promise.all([
    getRuntimeIntegration("mailSmtp"),
    getRuntimeIntegration("mailImap"),
  ]);
  const baseContext = resolveOperationalMailIdentityContextFromConfigs(
    smtpConfig,
    imapConfig,
    false,
    canonicalMailboxOverride,
  );
  const attestation = await readMailProviderAttestationProjection(baseContext.identity);
  return resolveOperationalMailIdentityContextFromConfigs(
    smtpConfig,
    imapConfig,
    attestation.providerSubjectVerified,
    canonicalMailboxOverride,
  );
}

/**
 * Same context shape as resolveOperationalMailIdentityContext, but keyed off a MailAccount.
 * The canonical_scp account resolves through the exact same code path as
 * resolveOperationalMailIdentityContext above (so scp callers stay byte-identical — and this
 * source-contract-tested function's body is never duplicated); other kinds use the account's
 * own public smtp/imap config (secret-bound transport wiring for those lands in later slices).
 */
export async function resolveMailIdentityContextForAccount(
  account: MailAccount,
  canonicalMailboxOverride?: unknown,
): Promise<OperationalMailIdentityContext> {
  if (account.kind === "canonical_scp") {
    return resolveOperationalMailIdentityContext(canonicalMailboxOverride);
  }
  const smtpConfig: RuntimeIntegration = { key: "mailSmtp", public: account.smtp, secrets: {} };
  const imapConfig: RuntimeIntegration = { key: "mailImap", public: account.imap, secrets: {} };
  const baseContext = resolveOperationalMailIdentityContextFromConfigs(
    smtpConfig,
    imapConfig,
    false,
    canonicalMailboxOverride,
    account.mailbox,
  );
  const attestation = await readMailProviderAttestationProjection(baseContext.identity);
  return resolveOperationalMailIdentityContextFromConfigs(
    smtpConfig,
    imapConfig,
    attestation.providerSubjectVerified,
    canonicalMailboxOverride,
    account.mailbox,
  );
}

export async function resolveOperationalMailIdentity(): Promise<MailIdentitySnapshot> {
  return (await resolveOperationalMailIdentityContext()).identity;
}

export async function resolveMailProfile(input: ResolveMailProfileInput): Promise<MailProfileResolution> {
  const intent = input.intent ?? "auto_reply";
  const settings = await readSettings();
  const base: ProfileDraft = {
    intent,
    enabled: settings.automation.aiAutomationEnabled && settings.programAi.enabled,
    tone: settings.programAi.defaultTone || settings.mail.tone,
    format: settings.programAi.defaultFormat,
    minReplyDelayMinutes: input.programId ? settings.programAi.minProgramReplyDelayMinutes : settings.automation.minReplyDelayMinutes,
    maxDailySends: input.programId ? settings.programAi.maxPerProgramDailySends : settings.automation.maxDailyAutoSends,
    humanApprovalRequired: settings.automation.humanApprovalRequired,
    dryRun: settings.programAi.dryRunDefault,
    liveSend: settings.automation.liveSendEnabled,
    templateRef: input.templateRef ?? DEFAULT_TEMPLATE_BY_INTENT[intent],
  };

  const layers = (await Promise.all([
    readProjectLayer(input.gameId ?? ""),
    input.programId ? readLayer("program", `programs/${input.programId}`, input.programOverride) : Promise.resolve(null),
    input.campaignId ? readLayer("campaign", `campaigns/${input.campaignId}`, input.campaignOverride) : Promise.resolve(null),
  ])).filter((layer): layer is ProfileLayer => layer !== null);
  const draft = layers.reduce((profile, layer) => overlayProfile(profile, layer, intent), base);
  const topLayer = layers.at(-1) ?? { scope: "global" as const, sourcePath: "settings/default", data: {} };
  const template = await templateSnapshot(draft.templateRef, fallbackBody(draft));
  const policyVersion = hashPolicy({ intent, draft, template, sourcePaths: layers.map((layer) => layer.sourcePath) });
  const profile: MailProfileSnapshot = {
    ...draft,
    id: `${topLayer.scope}:${topLayer.sourcePath}:${intent}`,
    scope: topLayer.scope,
    sourcePath: topLayer.sourcePath,
    policyVersion,
  };
  const sourceRefs = [
    sourceRef("settings/default", "settings", "global mail defaults"),
    ...layers.map((layer) => sourceRef(layer.sourcePath, layer.scope === "program" ? "program" : "settings", `${layer.scope} mail profile`)),
    sourceRef(template.ref, "settings", "mail template snapshot"),
  ];
  const dryRun = profile.dryRun || !profile.liveSend;
  const liveSend = profile.liveSend && !dryRun && profile.enabled;
  // F-3: 고정 오프셋 대신 지터 + KST 영업시간 창으로 sendAfterIso 를 정한다(§D).
  const sendWindow = computeAutoReplySendAfter({
    baseIso: input.baseIso ?? new Date().toISOString(),
    minDelayMinutes: profile.minReplyDelayMinutes,
    jitterMaxMinutes: settings.automation.autoReplyJitterMaxMinutes,
    businessHours: settings.automation.autoReplyBusinessHoursKst,
    // auto-reply-pacing (2026-09-17): 고정 90분 몰림 방지 스프레드를 설정 가능하게 뺐다(기본 150).
    burstSpreadMinutes: settings.automation.autoReplyBurstSpreadMinutes,
  });
  return {
    resolvedProfileSnapshot: profile,
    templateSnapshot: template,
    policyVersion,
    sourceRefs,
    sendAfterIso: sendWindow.sendAfterIso,
    dryRun,
    liveSend,
    effectiveDelayMinutes: sendWindow.delayMinutes,
    deferredToBusinessWindow: sendWindow.deferredToBusinessWindow,
  };
}

export function renderMailTemplate(template: TemplateSnapshot, values: Record<string, string>): string {
  return Object.entries(values).reduce((body, [key, value]) => body.replaceAll(`{{${key}}}`, value), template.body);
}

export async function evaluateMailProfileSafety(
  data: Record<string, unknown>,
  source: string,
  resolution: MailProfileResolution,
  options: MailProfileSafetyOptions = {},
): Promise<MailProfileSafetyDecision> {
  const settings = await readSettings();
  const targetEmail = normalizeToken(cleanString(data.to, cleanString(data.creatorEmail, cleanString(data.from, ""), 240), 240));
  const handle = normalizeToken(cleanString(data.creatorHandle, cleanString(data.handle, ""), 160));
  const domain = emailDomain(targetEmail);
  const blockedEmails = new Set(normalizeList(settings.mailSafety.blockedEmails));
  const blockedDomains = new Set(normalizeList(settings.mailSafety.blockedDomains));
  const suppressedHandles = new Set(normalizeList(settings.mailSafety.suppressedHandles));
  const text = [data.subject, data.body, data.text, data.summaryKr, data.creatorName, data.to, data.from]
    .map((value) => typeof value === "string" ? value : "")
    .join(" ");
  const matchedKeyword = firstKeywordMatch(text, settings.mailSafety.emergencyKeywords);

  if (settings.mailSafety.emergencyShutdownEnabled) {
    return { allowed: false, liveSendAllowed: false, ruleId: "mail-safety.emergency-shutdown", reason: "긴급 메일 셧다운이 켜져 있습니다." };
  }
  if (targetEmail && blockedEmails.has(targetEmail)) {
    return { allowed: false, liveSendAllowed: false, ruleId: "mail-safety.blocked-email", reason: "블랙리스트 이메일과 일치합니다." };
  }
  if (domain && blockedDomains.has(domain)) {
    return { allowed: false, liveSendAllowed: false, ruleId: "mail-safety.blocked-domain", reason: "블랙리스트 도메인과 일치합니다." };
  }
  if (handle && suppressedHandles.has(handle)) {
    return { allowed: false, liveSendAllowed: false, ruleId: "mail-safety.suppressed-handle", reason: "블랙리스트 핸들과 일치합니다." };
  }
  const suppression = await findMailSuppression({
    email: targetEmail,
    handle,
    name: cleanString(data.creatorName, "", 240),
    category: cleanString(data.creatorCategory, cleanString(data.category, ""), 240),
    platform: cleanString(data.creatorPlatform, cleanString(data.platform, ""), 120),
    text: [data.creatorName, data.creatorHandle, data.creatorCategory, data.creatorPlatform, data.text, targetEmail]
      .map((value) => typeof value === "string" ? value : "")
      .join(" "),
  });
  // W62d-D: 위와 같은 규칙 — 거래성 purpose 만 infly-overlap 을 비켜 간다.
  if (mailSuppressionBlocksSend(suppression, {
    allowInflyOverlap: data.allowInflyOverlap === true || allowsTransactionalInflyOverlap(data),
  })) {
    return {
      allowed: false,
      liveSendAllowed: false,
      ruleId: suppression.ruleId ?? "mail-safety.suppressed-contact",
      reason: suppression.reason ?? "기존 억제 목록과 일치합니다.",
    };
  }
  if (matchedKeyword) {
    return { allowed: false, liveSendAllowed: false, ruleId: "mail-safety.complaint-keyword", reason: "수신거부·법적 조치 신호가 감지되었습니다.", matchedKeyword };
  }
  if (!resolution.resolvedProfileSnapshot.enabled) {
    return { allowed: false, liveSendAllowed: false, ruleId: "mail-profile.disabled", reason: "해석된 메일 프로필이 비활성화되어 있습니다." };
  }
  // RT-2/A2 (pre-G-SEND 필수 검증): humanApprovalRequired는 자동 발송의 hard gate여야 한다.
  // resolveMailProfile()의 dryRun/liveSend 파생 로직(위 224-225행)은 humanApprovalRequired를
  // 전혀 반영하지 않으므로, 프로필이 사람 승인을 요구하는데도 liveSend가 true로 해석되면
  // 여기서 강제 차단한다. evaluateMailProfileSafety의 호출부는 전부 자동 경로뿐이라
  // (mailProfileResolver/autoReplyQueue/campaign target resolution) 사람이 직접 보내는
  // 수동 발송(sendEmail, 이 함수를 거치지 않음)에는 영향이 없다.
  if (
    resolution.resolvedProfileSnapshot.humanApprovalRequired
    && resolution.liveSend
    && options.allowInboundAutoReplyWithoutHumanApproval !== true
  ) {
    return {
      allowed: false,
      liveSendAllowed: false,
      ruleId: "mail-safety.human-approval-required",
      reason: "이 메일 프로필은 사람 승인이 필요합니다 — 자동 라이브 발송이 차단되었습니다.",
    };
  }
  if (resolution.liveSend && !settings.automation.liveSendEnabled) {
    return { allowed: false, liveSendAllowed: false, ruleId: "mail-safety.live-send-gate", reason: "전역 live-send gate가 꺼져 있습니다." };
  }
  return { allowed: true, liveSendAllowed: resolution.liveSend, ruleId: `mail-safety.${source}.ok`, reason: "메일 프로필 안전 정책 통과" };
}
