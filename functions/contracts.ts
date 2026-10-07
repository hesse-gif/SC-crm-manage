// Flu Cloud Functions — 외부망/모델 호출·DB 쓰기의 단일 경유점.
// Spark 현재 상태에서는 외부 AI/이메일/YouTube/Revi 호출을 하지 않고 callable-style mock만 반환한다.

import { readSettings } from "./settings";
import type { Settings } from "./_settings-mock";
import { adminDb } from "./firebaseAdmin";
import { sourceRef as makeSourceRef, ingestKnowledgeNode, type SourceRef } from "./knowledgeGraph";
import { makeBehaviorLog, makeDeniedBehaviorLog, type AuthContext, type BehaviorLog as SharedBehaviorLog } from "./shared";

export type Role = "super_admin" | "admin" | "manager" | "viewer" | "guest";

export interface CallableRequest {
  auth?: { uid?: string; token?: { role?: Role; team?: string; gameId?: string } };
  data?: unknown;
  rawRequest?: { ip?: string };
}

type WriteRole = Extract<Role, "super_admin" | "admin" | "manager">;
type ContractResultStatus = "ok" | "blocked" | "escalated";
type BehaviorLog = SharedBehaviorLog;

interface CostLog {
  provider: "mock-gateway";
  model: "spark-mock";
  cacheChecked: true;
  cacheHit: boolean;
  inputTokens: number;
  outputTokens: number;
  estimatedKRW: number;
  billable: false;
}

interface CacheMeta {
  key: string;
  checked: true;
  hit: boolean;
  ttlSeconds: number;
}

interface GatewayMeta {
  mode: "mock";
  route: "internal-ai-gateway";
  externalEgress: false;
}

interface ContractPayload {
  contractRef: string;
  creatorId?: string;
  templateRef?: string;
  capKRW: number;
  requestedKRW?: number;
  round: number;
  gameId: string;
  templateFileName?: string;
  templateFileRef?: string;
  pdfText?: string;
  pdfFileName?: string;
  followers?: number;
  recentViews?: number;
  engagementPct?: number;
}

const WRITE_ROLES = new Set<Role>(["super_admin", "admin", "manager"]);

type NegotiationGuide = {
  startRatio: number;
  targetRatio: number;
  maxRounds: number;
  cadenceDays: number;
  walkAwayPct: number;
  nearGuidePct: number;
  exclusivityDays: number;
  payTermDays: number;
  minFollowers: number;
  maxFollowers: number;
  recentViewsDays: number;
  minRecentViews: number;
  maxRecentViews: number;
  minEngagementPct: number;
  maxEngagementPct: number;
  allowedTemplateRefs: string[];
};

function roleFrom(request: CallableRequest): Role {
  return request.auth?.token?.role ?? "guest";
}

function requireWriteRole(request: CallableRequest, action: string): { role: WriteRole; baseLog: Omit<BehaviorLog, "result" | "cost">; auth: AuthContext } {
  const role = roleFrom(request);
  const record = dataRecord(request.data);
  const gameId = stringField(record, "gameId", request.auth?.token?.gameId ?? "unknown");
  const team = request.auth?.token?.team ?? "unassigned";
  const ip = request.rawRequest?.ip ?? "0.0.0.0";
  const baseLog = {
    userId: request.auth?.uid ?? "anonymous",
    role,
    team,
    gameId,
    action,
    time: new Date().toISOString(),
    IP: ip,
  };

  if (!request.auth?.uid || !WRITE_ROLES.has(role)) {
    const error = new Error(!request.auth?.uid ? "unauthenticated" : "permission-denied: super_admin/admin/manager role required");
    Object.assign(error, {
      code: !request.auth?.uid ? "unauthenticated" : "permission-denied", errorCode: "require_write_role_unauthorized",
      behaviorLog: makeDeniedBehaviorLog(request, action, gameId),
    });
    throw error;
  }

  return { role: role as WriteRole, baseLog, auth: { userId: request.auth.uid, role: role as WriteRole, team, gameId, ip } };
}

function dataRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function numberField(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseContractPayload(data: unknown): ContractPayload {
  const record = dataRecord(data);
  return {
    contractRef: stringField(record, "contractRef", "contracts/mock"),
    creatorId: typeof record.creatorId === "string" ? record.creatorId : undefined,
    templateRef: typeof record.templateRef === "string" ? record.templateRef : undefined,
    capKRW: Math.max(1, Math.round(numberField(record, "capKRW", 3000000))),
    requestedKRW: typeof record.requestedKRW === "number" && Number.isFinite(record.requestedKRW) ? Math.max(0, Math.round(record.requestedKRW)) : undefined,
    round: Math.max(1, Math.round(numberField(record, "round", 1))),
    gameId: stringField(record, "gameId", "unknown"),
    templateFileName: typeof record.templateFileName === "string" ? record.templateFileName : undefined,
    templateFileRef: typeof record.templateFileRef === "string" ? record.templateFileRef : undefined,
    pdfText: typeof record.pdfText === "string" ? record.pdfText : undefined,
    pdfFileName: typeof record.pdfFileName === "string" ? record.pdfFileName : undefined,
    followers: typeof record.followers === "number" && Number.isFinite(record.followers) ? Math.max(0, Math.round(record.followers)) : undefined,
    recentViews: typeof record.recentViews === "number" && Number.isFinite(record.recentViews) ? Math.max(0, Math.round(record.recentViews)) : undefined,
    engagementPct: typeof record.engagementPct === "number" && Number.isFinite(record.engagementPct) ? Math.max(0, record.engagementPct) : undefined,
  };
}

function cacheFor(action: string, contractRef: string): CacheMeta {
  return { key: `${action}:${contractRef}`, checked: true, hit: false, ttlSeconds: 600 };
}

function costLog(cacheHit = false): CostLog {
  return {
    provider: "mock-gateway",
    model: "spark-mock",
    cacheChecked: true,
    cacheHit,
    inputTokens: 0,
    outputTokens: 0,
    estimatedKRW: 0,
    billable: false,
  };
}

function gateway(): GatewayMeta {
  return { mode: "mock", route: "internal-ai-gateway", externalEgress: false };
}

function behaviorLog(auth: AuthContext, action: string, result: ContractResultStatus): BehaviorLog {
  const logResult = result === "blocked" ? "blocked" : "success";
  return makeBehaviorLog(auth, action, logResult);
}

function negotiationGuideFrom(settings: Settings): NegotiationGuide {
  return {
    startRatio: settings.contract.startRatio,
    targetRatio: settings.contract.targetRatio,
    maxRounds: settings.negotiationCriteria.maxRounds,
    cadenceDays: settings.negotiationCriteria.cadenceDays,
    walkAwayPct: settings.negotiationCriteria.walkAwayPct,
    nearGuidePct: settings.negotiationCriteria.nearGuidePct,
    exclusivityDays: settings.contract.exclusivityDays,
    payTermDays: settings.contract.payTermDays,
    minFollowers: settings.negotiationCriteria.minFollowers,
    maxFollowers: settings.negotiationCriteria.maxFollowers,
    recentViewsDays: settings.negotiationCriteria.recentViewsDays,
    minRecentViews: settings.negotiationCriteria.minRecentViews,
    maxRecentViews: settings.negotiationCriteria.maxRecentViews,
    minEngagementPct: settings.negotiationCriteria.minEngagementPct,
    maxEngagementPct: settings.negotiationCriteria.maxEngagementPct,
    allowedTemplateRefs: [...settings.negotiationCriteria.allowedTemplateRefs],
  };
}

function automationGate(settings: Settings, scope: "negotiation" | "contractDraft") {
  const enabled =
    settings.automation.aiAutomationEnabled &&
    (scope === "negotiation" ? settings.automation.negotiationAutomation : settings.automation.contractDraftAutomation);
  return {
    scope,
    status: enabled ? "enabled" : "disabled",
    reason: enabled ? "settings_allow_automation" : "settings_disabled_ai_automation",
    humanApprovalRequired: settings.automation.humanApprovalRequired,
    minReplyDelayMinutes: settings.automation.minReplyDelayMinutes,
    liveSendEnabled: settings.automation.liveSendEnabled,
  };
}

function metricStatus(value: number | undefined, min: number, max: number) {
  if (value === undefined) return "missing";
  if (value < min) return "below";
  if (value > max) return "above";
  return "pass";
}

function criteriaGate(payload: ContractPayload, guide: NegotiationGuide) {
  const checks = [
    { key: "followers", label: "구독자수", value: payload.followers, min: guide.minFollowers, max: guide.maxFollowers },
    { key: "recentViews", label: `최근 ${guide.recentViewsDays}일 조회수`, value: payload.recentViews, min: guide.minRecentViews, max: guide.maxRecentViews },
    { key: "engagementPct", label: "참여율", value: payload.engagementPct, min: guide.minEngagementPct, max: guide.maxEngagementPct },
  ].map((check) => ({ ...check, status: metricStatus(check.value, check.min, check.max) }));
  const outOfRange = checks.filter((check) => check.status === "below" || check.status === "above");
  const missing = checks.filter((check) => check.status === "missing");
  const status = outOfRange.length ? "needs_review" : missing.length === checks.length ? "unchecked" : "pass";

  return {
    status,
    checks,
    manualReviewRecommended: status !== "pass",
    reason:
      status === "pass"
        ? "creator_metrics_match_negotiation_filters"
        : status === "unchecked"
          ? "creator_metrics_not_provided"
          : "creator_metrics_outside_negotiation_filters",
  };
}

function guideDelta(payload: ContractPayload, guide: NegotiationGuide) {
  const requestedPct = payload.requestedKRW ? Math.round((payload.requestedKRW / payload.capKRW) * 100) : undefined;
  return {
    startPct: guide.startRatio,
    targetPct: guide.targetRatio,
    requestedPct,
    walkAwayPct: guide.walkAwayPct,
    nearGuidePct: guide.nearGuidePct,
    round: payload.round,
    maxRounds: guide.maxRounds,
    cadenceDays: guide.cadenceDays,
  };
}

function templateGate(payload: ContractPayload, guide: NegotiationGuide) {
  const templateAllowed = Boolean(payload.templateRef && guide.allowedTemplateRefs.includes(payload.templateRef));
  const fileAttached = Boolean(payload.templateFileRef || payload.templateFileName);
  const attached = templateAllowed && fileAttached;
  return {
    required: true,
    status: attached ? "attached" : "blocked",
    templateRef: templateAllowed ? payload.templateRef : undefined,
    templateFileRef: payload.templateFileRef,
    templateFileName: payload.templateFileName,
    allowedTemplateRefs: [...guide.allowedTemplateRefs],
    reason: attached
      ? "standard_template_file_attached"
      : !templateAllowed
        ? "approved_template_ref_required"
        : "standard_template_file_required_before_signature",
  };
}

function inspectPdfText(payload: ContractPayload, terms: ReturnType<typeof structuredTerms>, guide: NegotiationGuide) {
  const text = payload.pdfText?.trim();
  if (!text) {
    return {
      checked: false,
      parser: "pdf-parse",
      status: "not_provided",
      fileName: payload.pdfFileName,
      missing: [],
      risks: [],
      summary: "PDF 텍스트가 아직 추출되지 않았습니다. worker에서 pdf-parse로 본문을 추출해 pdfText로 넘기면 조항 검증을 수행합니다.",
    };
  }

  const lower = text.toLowerCase();
  const clauses = [
    { key: "deliverables", label: "산출물", ok: /deliverable|video|shorts|콘텐츠|영상|숏폼|산출물/.test(lower) },
    { key: "payment", label: "지급 조건", ok: /payment|fee|net\s*\d+|지급|금액|수수료/.test(lower) },
    { key: "usage", label: "사용권", ok: /license|usage|rights|사용권|활용|게재/.test(lower) },
    { key: "termination", label: "해지", ok: /termination|cancel|해지|취소/.test(lower) },
    { key: "signature", label: "서명", ok: /signature|signed|서명|날인/.test(lower) },
  ];
  const missing = clauses.filter((clause) => !clause.ok).map((clause) => clause.label);
  const risks: string[] = [];
  if (/perpetual|영구/.test(lower)) risks.push("영구 사용권 문구 확인 필요");
  if (/exclusive|독점/.test(lower) && !new RegExp(`${terms.dueDays}|${guide.cadenceDays}`).test(lower)) risks.push("독점 기간 수치 확인 필요");
  if (/penalty|위약금/.test(lower)) risks.push("위약금 조항 확인 필요");
  const status = missing.length || risks.length ? "needs_review" : "pass";
  return {
    checked: true,
    parser: "pdf-parse",
    status,
    fileName: payload.pdfFileName,
    missing,
    risks,
    summary: status === "pass" ? "필수 조항을 확인했습니다." : "사람 검토가 필요한 조항이 있습니다.",
  };
}

function nextOfferKRW(payload: ContractPayload, guide: NegotiationGuide): number {
  if (payload.round <= 1) return Math.round((payload.capKRW * guide.startRatio) / 100);
  const span = Math.max(1, guide.maxRounds - 1);
  const ratio = Math.min(
    guide.targetRatio,
    Math.round(guide.startRatio + ((guide.targetRatio - guide.startRatio) * (payload.round - 1)) / span),
  );
  return Math.round((payload.capKRW * ratio) / 100);
}

function structuredTerms(payload: ContractPayload, guide: NegotiationGuide) {
  const feeKRW = payload.requestedKRW && payload.requestedKRW <= payload.capKRW ? payload.requestedKRW : nextOfferKRW(payload, guide);
  return {
    feeKRW,
    deliverables: { videos: 1, shorts: 2, platform: "YouTube" },
    dueDays: guide.exclusivityDays,
    currency: "KRW",
    jurisdiction: "KR",
    payment: { milestone: "manual-signature", netDays: guide.payTermDays },
  };
}

function pdfDraft(payload: ContractPayload, terms: ReturnType<typeof structuredTerms>) {
  const safeRef = payload.contractRef.replace(/[^a-zA-Z0-9_-]/g, "-");
  return {
    pdfRef: `contracts/${safeRef}/generated/standard-template.pdf`,
    fileName: `${safeRef}-standard-template.pdf`,
    sourceTemplateFile: payload.templateFileRef ?? payload.templateFileName,
    replacements: {
      "{{feeKRW}}": terms.feeKRW,
      "{{videos}}": terms.deliverables.videos,
      "{{shorts}}": terms.deliverables.shorts,
      "{{dueDays}}": terms.dueDays,
      "{{currency}}": terms.currency,
    },
    signatureMode: "manual_upload",
  };
}

function negotiationSourceRefs(payload: ContractPayload) {
  return [
    makeSourceRef("settings/negotiationCriteria", "settings", "negotiation guide settings"),
    makeSourceRef(payload.contractRef, "contract", "contract negotiation context"),
    ...(payload.templateFileRef ? [makeSourceRef(payload.templateFileRef, "artifact", "standard contract template")] : []),
    ...(payload.templateRef ? [makeSourceRef(`templates/${payload.templateRef}`, "artifact", "contract template metadata")] : []),
  ];
}

function negotiationDocId(action: string, contractRef: string): string {
  const safeRef = contractRef.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 120);
  return `${action}-${safeRef}-${Date.now().toString(36)}`;
}

// Persist a negotiation/escalation outcome so it is queryable, AND ingest a
// "negotiation_guide" knowledge node (conflict/duplicate-aware) so the outcome
// feeds the KB. Returns the persisted refs + the KB ingest outcome for the
// callable response. KB ingest failures must not lose the persisted record.
async function persistNegotiationOutcome(args: {
  action: string;
  contractRef: string;
  creatorId?: string;
  gameId: string;
  actorUid: string;
  actorRole: string;
  team: string;
  result: ContractResultStatus;
  guide: NegotiationGuide;
  guideDelta: ReturnType<typeof guideDelta>;
  sourceRefs: SourceRef[];
  summary: string;
}): Promise<{ negotiationRef: string; knowledgeNodeRef?: string; kbIngestStatus: string }> {
  const nowIso = new Date().toISOString();
  const docId = negotiationDocId(args.action, args.contractRef);
  const negotiationRef = `negotiations/${docId}`;
  await adminDb.collection("negotiations").doc(docId).set({
    id: docId,
    negotiationRef,
    action: args.action,
    contractRef: args.contractRef,
    creatorId: args.creatorId ?? null,
    gameId: args.gameId,
    result: args.result,
    guide: args.guide,
    guideDelta: args.guideDelta,
    sourceRefs: args.sourceRefs,
    actor: { uid: args.actorUid, role: args.actorRole, team: args.team },
    artifactPolicy: "server-ref-only",
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
  }, { merge: true });

  const ingest = await ingestKnowledgeNode({
    id: `negotiation-guide-${docId}`,
    type: "negotiation_guide",
    title: `${args.action}:${args.contractRef}`,
    summary: args.summary,
    sourceRefs: [makeSourceRef(negotiationRef, "contract", args.summary), ...args.sourceRefs],
    entityRefs: [args.contractRef, ...(args.creatorId ? [args.creatorId] : [])],
    createdAtIso: nowIso,
  });

  return {
    negotiationRef,
    knowledgeNodeRef: ingest.status === "conflict" ? undefined : ingest.nodePath,
    kbIngestStatus: ingest.status,
  };
}

export async function negotiateContract(request: CallableRequest) {
  const { baseLog, auth } = requireWriteRole(request, "negotiateContract");
  const payload = parseContractPayload(request.data);
  const settings = await readSettings();
  const sourceRefs = negotiationSourceRefs(payload);
  const guide = negotiationGuideFrom(settings);
  const autoGate = automationGate(settings, "negotiation");
  const delta = guideDelta(payload, guide);
  const requestedPct = delta.requestedPct ?? 0;
  const gate = templateGate(payload, guide);
  const metricGate = criteriaGate(payload, guide);
  if (autoGate.status !== "enabled") {
    return {
      ok: true,
      contractRef: payload.contractRef,
      creatorId: payload.creatorId,
      action: "manual_review",
      reason: "automation_disabled_by_settings",
      guideDelta: delta,
      sourceRefs,
      automationGate: autoGate,
      criteriaGate: metricGate,
      templateGate: gate,
      cache: cacheFor("negotiateContract", payload.contractRef),
      gateway: gateway(),
      costLog: costLog(true),
      behaviorLog: behaviorLog(auth, "negotiateContract", "blocked"),
    };
  }
  const outsideGuide = requestedPct > guide.walkAwayPct || payload.round > guide.maxRounds || metricGate.status === "needs_review";
  if (gate.status !== "attached") {
    return {
      ok: false,
      contractRef: payload.contractRef,
      creatorId: payload.creatorId,
      action: "blocked",
      reason: "standard_template_required",
      guideDelta: delta,
      sourceRefs,
      automationGate: autoGate,
      criteriaGate: metricGate,
      templateGate: gate,
      cache: cacheFor("negotiateContract", payload.contractRef),
      gateway: gateway(),
      costLog: costLog(true),
      behaviorLog: behaviorLog(auth, "negotiateContract", "blocked"),
    };
  }
  const accepted = Boolean(payload.requestedKRW && requestedPct <= guide.targetRatio && gate.status === "attached" && metricGate.status !== "needs_review");
  const status: ContractResultStatus = outsideGuide ? "escalated" : "ok";
  const terms = structuredTerms(payload, guide);
  const action = outsideGuide ? "escalate" : accepted ? "accept" : "counter_offer";
  const persisted = await persistNegotiationOutcome({
    action,
    contractRef: payload.contractRef,
    creatorId: payload.creatorId,
    gameId: payload.gameId,
    actorUid: baseLog.userId,
    actorRole: baseLog.role,
    team: baseLog.team,
    result: status,
    guide,
    guideDelta: delta,
    sourceRefs,
    summary: `negotiation ${action} round ${payload.round}/${guide.maxRounds} requested ${requestedPct}% of cap`,
  });

  return {
    contractRef: payload.contractRef,
    creatorId: payload.creatorId,
    action,
    proposedKRW: outsideGuide ? undefined : accepted ? payload.requestedKRW : terms.feeKRW,
    nextCadenceDays: outsideGuide || accepted ? undefined : guide.cadenceDays,
    negotiationRef: persisted.negotiationRef,
    knowledgeNodeRef: persisted.knowledgeNodeRef,
    kbIngestStatus: persisted.kbIngestStatus,
    guideDelta: delta,
    sourceRefs,
    automationGate: autoGate,
    criteriaGate: metricGate,
    templateGate: gate,
    terms,
    pdf: pdfDraft(payload, terms),
    escalation: outsideGuide
      ? {
          escalationRef: `escalations/${payload.contractRef.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
          reason: metricGate.status === "needs_review"
            ? "creator_metrics_outside_negotiation_filters"
            : requestedPct > guide.walkAwayPct
              ? "walk_away_threshold_exceeded"
              : "max_rounds_exceeded",
        }
      : undefined,
    cache: cacheFor("negotiateContract", payload.contractRef),
    gateway: gateway(),
    costLog: costLog(),
    behaviorLog: behaviorLog(auth, "negotiateContract", status),
  };
}

export async function createEscalation(request: CallableRequest) {
  const { baseLog, auth } = requireWriteRole(request, "createEscalation");
  const payload = parseContractPayload(request.data);
  const settings = await readSettings();
  const sourceRefs = negotiationSourceRefs(payload);
  const guide = negotiationGuideFrom(settings);
  const delta = guideDelta(payload, guide);
  const metricGate = criteriaGate(payload, guide);
  const requestedPct = delta.requestedPct ?? 0;
  const reason = metricGate.status === "needs_review"
    ? "creator_metrics_outside_negotiation_filters"
    : requestedPct > guide.walkAwayPct
      ? "walk_away_threshold_exceeded"
      : "manual_review_required";
  const persisted = await persistNegotiationOutcome({
    action: "escalate",
    contractRef: payload.contractRef,
    creatorId: payload.creatorId,
    gameId: payload.gameId,
    actorUid: baseLog.userId,
    actorRole: baseLog.role,
    team: baseLog.team,
    result: "escalated",
    guide,
    guideDelta: delta,
    sourceRefs,
    summary: `escalation ${reason} requested ${requestedPct}% of cap`,
  });

  return {
    escalationRef: `escalations/${payload.contractRef.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    contractRef: payload.contractRef,
    creatorId: payload.creatorId,
    reason,
    requestedKRW: payload.requestedKRW,
    guideMaxKRW: payload.capKRW,
    overPct: requestedPct ? requestedPct - 100 : 0,
    negotiationRef: persisted.negotiationRef,
    knowledgeNodeRef: persisted.knowledgeNodeRef,
    kbIngestStatus: persisted.kbIngestStatus,
    guideDelta: delta,
    sourceRefs,
    criteriaGate: metricGate,
    cache: cacheFor("createEscalation", payload.contractRef),
    gateway: gateway(),
    costLog: costLog(),
    behaviorLog: behaviorLog(auth, "createEscalation", "escalated"),
  };
}

export async function validateContractTemplate(request: CallableRequest) {
  const { baseLog, auth } = requireWriteRole(request, "validateContractTemplate");
  const payload = parseContractPayload(request.data);
  const settings = await readSettings();
  const sourceRefs = negotiationSourceRefs(payload);
  const guide = negotiationGuideFrom(settings);
  const autoGate = automationGate(settings, "contractDraft");
  const gate = templateGate(payload, guide);
  const terms = structuredTerms(payload, guide);
  const pdfInspection = inspectPdfText(payload, terms, guide);
  const result: ContractResultStatus = autoGate.status === "enabled" && gate.status === "attached" && pdfInspection.status !== "needs_review" ? "ok" : "blocked";

  return {
    contractRef: payload.contractRef,
    automationGate: autoGate,
    templateGate: gate,
    sourceRefs,
    pdfInspection,
    canProceedToSignature: autoGate.status === "enabled" && gate.status === "attached" && pdfInspection.status !== "needs_review",
    terms,
    pdf: gate.status === "attached" ? pdfDraft(payload, terms) : undefined,
    cache: cacheFor("validateContractTemplate", payload.contractRef),
    gateway: gateway(),
    costLog: costLog(true),
    behaviorLog: behaviorLog(auth, "validateContractTemplate", result),
  };
}
