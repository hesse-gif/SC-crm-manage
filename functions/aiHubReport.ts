import { createHash, randomUUID } from "crypto";
import { assertNonGuestAuth, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { isStagingRuntime } from "./runtimeEnvironment";

// AI Hub LLM 모니터링 보고 (Supercent 사내 모니터링 — sc-ai-hub). Infly aiHub.js 포팅.
//   - reportLlmSession(start/end) + reportLlmUsage(토큰/비용) Full Integration.
//   - 호출부가 Promise를 await해 Cloud Function 생명주기 안에서 로컬 집계와 외부 실패 증거를 끝낸다.
//     AI_HUB_ENABLED!=="true" 또는 키/엔드포인트/projectId 공백이면 외부 보고만 no-op이다.
//   - 멀티테넌트 서버라 sessionId 는 호출부가 "요청 1건당 1개" 로 생성·전달(전역 싱글톤 금지).
//   - 컴플라이언스: 서버측(Functions)에서만 호출(NET-P0-012 — 클라 직접 호출 아님).
//     프롬프트/응답 원문은 절대 싣지 않음 — 토큰 수·비용·모델·식별자만(SEC-P0-009).

// ── llm_usage 정본 스키마(S12 A5) ─────────────────────────────────────────
//   persistLlmUsageLocal(아래)이 유일한 정본 writer(admin.ts recordLlmUsage 콜러블은 deprecated 호환 유지).
//   콜드메일 등 per-event 원가 로그는 이 컬렉션에 섞지 않는다 — llm_usage_events로 분리(admin.ts).
export const LLM_USAGE_SCHEMA_VERSION = "llm-usage-v2" as const;
export type LlmUsageTransport =
  | "ai_hub_gateway"
  | "vertex_direct"
  | "typesafe_direct"
  | "cache"
  | "unverified";

export interface LlmUsageDoc {
  id: string;
  schemaVersion: typeof LLM_USAGE_SCHEMA_VERSION;
  aggregationIdentity: string;
  model: string;
  tier: "빠른" | "품질";
  provider: string;
  transport: LlmUsageTransport;
  calls: number;
  tokensK: number;
  costMilliKRW: number;
  costKRW: number;
  byTool: Record<string, { calls: number; tokensK: number; costMilliKRW: number }>;
  lastToolId: string;
  updatedAtIso: string;
  source: string;
}

// ── llm_usage_daily(W89 A2): llm_usage와 하위호환 스키마 + UTC 일자 축 하나만 추가한 별도
//   컬렉션. llm_usage(정본, 일자 없음)는 그대로 두고, 같은 increment 패턴을 (조합 키 + UTC 날짜)
//   문서에도 병행 기록해 콘솔 없이 원가 추세를 재구성할 수 있게 한다. 문서 수 상한 = 조합 수 × 일수라
//   저렴하다(판정 볼륨이 큰 레인엔 llm_usage_events처럼 event-per-row를 쓰지 않는 이유).
export const LLM_USAGE_DAILY_SCHEMA_VERSION = "llm-usage-daily-v1" as const;

export interface LlmUsageDailyDoc {
  id: string;
  schemaVersion: typeof LLM_USAGE_DAILY_SCHEMA_VERSION;
  aggregationIdentity: string;
  dateUtc: string;
  model: string;
  tier: "빠른" | "품질";
  provider: string;
  transport: LlmUsageTransport;
  calls: number;
  tokensK: number;
  costMilliKRW: number;
  costKRW: number;
  byTool: Record<string, { calls: number; tokensK: number; costMilliKRW: number }>;
  lastToolId: string;
  updatedAtIso: string;
  source: string;
}

export type SessionAction = "start" | "end";

export type ReportLlmSessionOpts = {
  sessionId?: string;
  userId?: string;
  userEmail?: string;
  toolId?: string;
  timestamp?: string;
  team?: string;
  organization?: string;
  department?: string;
};

export type ReportLlmUsageOpts = {
  projectId?: string;
  toolId?: string;
  userId?: string;
  sessionId?: string;
  modelId?: string;
  provider?: string;
  transport?: LlmUsageTransport;
  modelName?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  latencyMs?: number;
  actionId?: string;
  isStreaming?: boolean;
};

function aiHubEnabled(): boolean {
  return !isStagingRuntime() && process.env.AI_HUB_ENABLED === "true";
}

// 요청 1건당 1개. LLM 호출마다 재생성하지 말 것(접속/분석 단위).
export function newSessionId(): string {
  return randomUUID();
}

// ── 로컬 llm_usage 영속화(C3 모니터링): 실제 모델 호출 usage를 model+tier로 집계해 llm_usage 컬렉션에 기록.
//   외부 AI Hub 보고(reportLlmUsage POST)와 독립 — 내부 게이트웨이/외부 리포팅이 없어도 모니터링 탭은 실사용을 반영한다.
//   런타임 가드: Cloud Functions(K_SERVICE/FUNCTION_TARGET) 또는 에뮬레이터(FUNCTIONS_EMULATOR) 또는 명시 플래그일 때만 기록
//   → 순수 단위테스트(bare node)에서는 미기록(프로덕션 쓰기 방지). 실패는 canonical 코드만 로깅한다.
const USD_TO_KRW = 1380; // 모니터링 추정 환율(정산 정본은 Vertex billing export).
declare const require: ((id: string) => unknown) | undefined;

function shouldPersistLlmUsageLocal(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true"
    || Boolean(process.env.K_SERVICE) || Boolean(process.env.FUNCTION_TARGET)
    || process.env.LLM_USAGE_LOCAL_PERSIST === "true";
}

function llmUsageTier(modelId: string): "빠른" | "품질" {
  return /lite/i.test(modelId) ? "빠른" : "품질";
}

export function normalizeLlmProvider(value: unknown): string {
  if (typeof value !== "string") return "unverified";
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized) ? normalized : "unverified";
}

export function normalizeLlmUsageTransport(value: unknown): LlmUsageTransport {
  return value === "ai_hub_gateway"
    || value === "vertex_direct"
    || value === "typesafe_direct"
    || value === "cache"
    ? value
    : "unverified";
}

type LlmUsageAggregationInput = {
  modelId: string;
  tier: string;
  provider?: string;
  transport?: LlmUsageTransport;
};

export function llmUsageAggregationIdentity(input: LlmUsageAggregationInput): string {
  return [
    input.modelId.trim(),
    input.tier.trim(),
    normalizeLlmProvider(input.provider),
    normalizeLlmUsageTransport(input.transport),
  ].join("|");
}

export function llmUsageDocumentId(input: LlmUsageAggregationInput): string {
  const provider = normalizeLlmProvider(input.provider);
  const transport = normalizeLlmUsageTransport(input.transport);
  const digest = createHash("sha256")
    .update(llmUsageAggregationIdentity({ ...input, provider, transport }))
    .digest("hex")
    .slice(0, 12);
  const slug = `${input.modelId}-${input.tier}-${provider}-${transport}`
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .toLowerCase()
    .slice(0, 120);
  return `${slug}-${digest}`;
}

// UTC 날짜(YYYY-MM-DD) — Date#toISOString()의 앞 10자는 항상 UTC 표기다.
export function llmUsageDailyDateUtc(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

// llm_usage_daily 문서 키 = 기존 조합 키(llmUsageDocumentId) + UTC 날짜.
export function llmUsageDailyDocumentId(input: LlmUsageAggregationInput, dateUtc: string): string {
  return `${llmUsageDocumentId(input)}-${dateUtc}`;
}

type LlmUsageDb = { collection(name: string): { doc(id: string): { set(data: Record<string, unknown>, options: { merge: boolean }): Promise<unknown> } } };

async function persistLlmUsageLocal(opts: ReportLlmUsageOpts): Promise<void> {
  if (!shouldPersistLlmUsageLocal()) return;
  const modelId = opts.modelId;
  if (!modelId || typeof require !== "function") return;
  try {
    const admin = require("./firebaseAdmin") as { adminDb?: LlmUsageDb } | null;
    const fs = require("firebase-admin/firestore") as { FieldValue: { increment(n: number): unknown } };
    const db = admin?.adminDb;
    if (!db) return;
    const tier = llmUsageTier(modelId);
    const provider = normalizeLlmProvider(opts.provider);
    const transport = normalizeLlmUsageTransport(opts.transport);
    const aggregationIdentity = llmUsageAggregationIdentity({ modelId, tier, provider, transport });
    const tokensK = Math.round(((Number(opts.inputTokens || 0) + Number(opts.outputTokens || 0)) / 1000) * 1000) / 1000;
    const costMilliKRW = Math.max(0, Math.round(Number(opts.totalCostUsd || 0) * USD_TO_KRW * 1000));
    const docId = llmUsageDocumentId({ modelId, tier, provider, transport });
    const toolId = opts.toolId || "unknown";
    const toolKey = toolId.replace(/[^a-zA-Z0-9_]/g, "_");
    const inc = (n: number) => fs.FieldValue.increment(n);
    const nowIso = new Date().toISOString();
    const dateUtc = llmUsageDailyDateUtc(new Date(nowIso));
    const dailyDocId = llmUsageDailyDocumentId({ modelId, tier, provider, transport }, dateUtc);
    const writes = [
      db.collection("llm_usage").doc(docId).set({
        id: docId,
        schemaVersion: LLM_USAGE_SCHEMA_VERSION,
        aggregationIdentity,
        model: modelId,
        tier,
        provider,
        transport,
        calls: inc(1),
        tokensK: inc(tokensK),
        costMilliKRW: inc(costMilliKRW),
        costKRW: inc(Math.round(costMilliKRW / 1000)),
        byTool: { [toolKey]: { calls: inc(1), tokensK: inc(tokensK), costMilliKRW: inc(costMilliKRW) } },
        lastToolId: toolId,
        updatedAtIso: nowIso,
        source: "gateway-reportLlmUsage",
      }, { merge: true }),
      // W89 A2: llm_usage와 완전히 같은 increment 패턴을 (조합 키 + UTC 날짜) 문서에 병행 기록한다.
      // llm_usage 정본 스키마·문서는 건드리지 않는다(하위호환) — persistLlmUsageLocal 호출자 전원이
      // 별도 배선 없이 이 지점 하나에서 일자 축을 자동으로 얻는다.
      db.collection("llm_usage_daily").doc(dailyDocId).set({
        id: dailyDocId,
        schemaVersion: LLM_USAGE_DAILY_SCHEMA_VERSION,
        aggregationIdentity,
        dateUtc,
        model: modelId,
        tier,
        provider,
        transport,
        calls: inc(1),
        tokensK: inc(tokensK),
        costMilliKRW: inc(costMilliKRW),
        costKRW: inc(Math.round(costMilliKRW / 1000)),
        byTool: { [toolKey]: { calls: inc(1), tokensK: inc(tokensK), costMilliKRW: inc(costMilliKRW) } },
        lastToolId: toolId,
        updatedAtIso: nowIso,
        source: "gateway-reportLlmUsage",
      }, { merge: true }),
    ] as const;
    // W89 리뷰 처방: 정본(llm_usage)과 미러(llm_usage_daily)의 실패를 구분한다 — 한 catch 로 합치면
    // 미러 단독 장애가 정본 장애로 위장돼 과금 관측의 건강 신호가 희석된다. 미러는 관측 데이터라
    // 재시도 없이 떨어뜨려도 되지만, 어느 쪽이 죽었는지는 이름으로 남아야 한다.
    const [canonical, daily] = await Promise.allSettled(writes);
    if (canonical.status === "rejected") warnCanonicalFailure("local_usage_persist_failed", "local", null);
    if (daily.status === "rejected") warnCanonicalFailure("local_usage_daily_persist_failed", "local", null);
  } catch {
    warnCanonicalFailure("local_usage_persist_failed", "local", null);
  }
}

function postJson(endpoint: string, apiKey: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
}

// ── 실패 영속화(S12 A5): 외부 POST 실패를 canonical 집계 증거로만 남긴다.
//   응답 본문, apiKey, prompt, raw exception/message, user identifier는 읽거나 저장하지 않는다.
const AI_HUB_REPORT_STATUS_COLLECTION = "ai_hub_report_status";
const AI_HUB_REPORT_STATUS_DOC_ID = "status";
type AiHubStatusDb = { collection(name: string): { doc(id: string): { set(data: Record<string, unknown>, options: { merge: boolean }): Promise<unknown>; get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }> } } };

type AiHubFailureKind = "session" | "usage";
type AiHubFailureCode =
  | "external_http_4xx"
  | "external_http_5xx"
  | "external_http_other"
  | "external_network_error";

function failureCorrelationIdHash(
  kind: AiHubFailureKind,
  code: AiHubFailureCode,
  httpStatus: number | null,
): string {
  return createHash("sha256")
    .update(`${kind}:${code}:${httpStatus ?? 0}:${Date.now()}:${randomUUID()}`)
    .digest("hex")
    .slice(0, 24);
}

function warnCanonicalFailure(
  code: AiHubFailureCode | "local_usage_persist_failed" | "local_usage_daily_persist_failed" | "failure_status_persist_failed",
  kind: AiHubFailureKind | "local",
  httpStatus: number | null,
  correlationIdHash = createHash("sha256")
    .update(`${kind}:${code}:${httpStatus ?? 0}:${Date.now()}:${randomUUID()}`)
    .digest("hex")
    .slice(0, 24),
): void {
  console.warn("[ai-hub] canonical failure", {
    code,
    kind,
    ...(httpStatus == null ? {} : { httpStatus }),
    correlationIdHash,
  });
}

function requireAdminDb(): AiHubStatusDb | null {
  if (typeof require !== "function") return null;
  try {
    const admin = require("./firebaseAdmin") as { adminDb?: AiHubStatusDb } | null;
    return admin?.adminDb ?? null;
  } catch {
    return null;
  }
}

async function persistAiHubReportFailure(
  kind: AiHubFailureKind,
  code: AiHubFailureCode,
  httpStatus: number | null,
  correlationIdHash: string,
): Promise<void> {
  if (!shouldPersistLlmUsageLocal()) return;
  if (typeof require !== "function") return;
  try {
    const db = requireAdminDb();
    if (!db) return;
    const fs = require("firebase-admin/firestore") as {
      FieldValue: { increment(n: number): unknown; delete(): unknown };
    };
    await db.collection(AI_HUB_REPORT_STATUS_COLLECTION).doc(AI_HUB_REPORT_STATUS_DOC_ID).set({
      failureCount: fs.FieldValue.increment(1),
      lastFailureKind: kind,
      lastFailureCode: code,
      lastHttpStatus: httpStatus,
      lastCorrelationIdHash: correlationIdHash,
      // Remove any pre-hardening raw provider reason left by a legacy merge write.
      lastFailureReason: fs.FieldValue.delete(),
      lastFailureAtIso: new Date().toISOString(),
    }, { merge: true });
  } catch {
    warnCanonicalFailure("failure_status_persist_failed", kind, null);
  }
}

function httpFailureCode(status: number): AiHubFailureCode {
  if (status >= 400 && status < 500) return "external_http_4xx";
  if (status >= 500 && status < 600) return "external_http_5xx";
  return "external_http_other";
}

async function recordExternalFailure(
  kind: AiHubFailureKind,
  code: AiHubFailureCode,
  httpStatus: number | null,
): Promise<void> {
  const correlationIdHash = failureCorrelationIdHash(kind, code, httpStatus);
  warnCanonicalFailure(code, kind, httpStatus, correlationIdHash);
  await persistAiHubReportFailure(kind, code, httpStatus, correlationIdHash);
}

// 세션 start/end 보고. projectId·sessionId·userId 필수(없으면 no-op).
export async function reportLlmSession(action: SessionAction, opts: ReportLlmSessionOpts = {}): Promise<void> {
  const apiKey = process.env.AI_HUB_LLM_API_KEY;
  const endpoint = process.env.AI_HUB_LLM_SESSION_ENDPOINT;
  const projectId = process.env.AI_HUB_LLM_PROJECT_ID;
  const { sessionId, userId, userEmail, toolId, timestamp, team, organization, department } = opts;
  if (!aiHubEnabled() || !apiKey || !endpoint || !projectId || !sessionId || !userId) return;
  const body: Record<string, unknown> = { projectId, toolId: toolId || projectId, userId, sessionId, action };
  if (userEmail) body.userEmail = userEmail;
  if (timestamp) body.timestamp = timestamp;
  if (team) body.team = team;
  if (organization) body.organization = organization;
  if (department) body.department = department;
  try {
    const response = await postJson(endpoint, apiKey, body);
    if (!response.ok) {
      await recordExternalFailure("session", httpFailureCode(response.status), response.status);
    }
  } catch {
    await recordExternalFailure("session", "external_network_error", null);
  }
}

// LLM usage(토큰·비용) 보고. 프롬프트/응답 원문 금지 — 수치·모델·식별자만(SEC-P0-009).
// projectId·modelId·provider 필수(없으면 no-op).
export async function reportLlmUsage(opts: ReportLlmUsageOpts = {}): Promise<void> {
  const localPersistence = persistLlmUsageLocal(opts);
  const externalReporting = reportLlmUsageExternal(opts);
  await Promise.all([localPersistence, externalReporting]);
}

async function reportLlmUsageExternal(opts: ReportLlmUsageOpts): Promise<void> {
  const apiKey = process.env.AI_HUB_LLM_API_KEY;
  const endpoint = process.env.AI_HUB_LLM_REPORT_ENDPOINT;
  const projectId = process.env.AI_HUB_LLM_PROJECT_ID ?? opts.projectId;
  const {
    sessionId, userId, toolId, modelId, provider: rawProvider, transport: rawTransport, modelName,
    inputTokens, outputTokens, totalCostUsd, latencyMs, actionId, isStreaming,
  } = opts;
  if (!aiHubEnabled() || !apiKey || !endpoint || !projectId || !modelId || !rawProvider) return;
  const provider = normalizeLlmProvider(rawProvider);
  const transport = normalizeLlmUsageTransport(rawTransport);
  const body: Record<string, unknown> = {
    projectId,
    toolId: toolId || projectId,
    userId: userId || null,
    sessionId: sessionId || null,
    modelId,
    provider,
    transport,
    inputTokens: Number(inputTokens || 0),
    outputTokens: Number(outputTokens || 0),
    totalCostUsd: Number(totalCostUsd || 0),
  };
  if (modelName) body.modelName = modelName;
  if (latencyMs != null) body.latencyMs = Number(latencyMs);
  if (actionId) body.actionId = actionId;
  if (isStreaming != null) body.isStreaming = !!isStreaming;
  try {
    const response = await postJson(endpoint, apiKey, body);
    if (!response.ok) {
      await recordExternalFailure("usage", httpFailureCode(response.status), response.status);
    }
  } catch {
    await recordExternalFailure("usage", "external_network_error", null);
  }
}

// ── key/env 설정 상태 조회(S12 acceptance d) — super_admin 전용, boolean만 반환(SEC-P0-009/G-SECRET).
//   실제 secret 값은 절대 응답에 담지 않는다. AI_HUB_GATEWAY_API_KEY는 vertex.ts 게이트웨이 경로용 별도 secret.
export interface AiHubKeyStatus {
  enabled: boolean;
  hasProjectId: boolean;
  hasApiKey: boolean;
  hasSessionEndpoint: boolean;
  hasReportEndpoint: boolean;
  hasGatewayApiKey: boolean;
}
export interface AiHubFailureStatus {
  failureCount: number;
  lastFailureKind: string | null;
  lastFailureCode: string | null;
  lastHttpStatus: number | null;
  lastCorrelationIdHash: string | null;
  lastFailureAtIso: string | null;
}

function readAiHubKeyStatus(): AiHubKeyStatus {
  return {
    enabled: aiHubEnabled(),
    hasProjectId: Boolean(process.env.AI_HUB_LLM_PROJECT_ID),
    hasApiKey: Boolean(process.env.AI_HUB_LLM_API_KEY),
    hasSessionEndpoint: Boolean(process.env.AI_HUB_LLM_SESSION_ENDPOINT),
    hasReportEndpoint: Boolean(process.env.AI_HUB_LLM_REPORT_ENDPOINT),
    hasGatewayApiKey: Boolean(process.env.AI_HUB_GATEWAY_API_KEY),
  };
}

async function readAiHubFailureStatus(): Promise<AiHubFailureStatus | null> {
  const db = requireAdminDb();
  if (!db) return null;
  try {
    const snapshot = await db.collection(AI_HUB_REPORT_STATUS_COLLECTION).doc(AI_HUB_REPORT_STATUS_DOC_ID).get();
    if (!snapshot.exists) return null;
    const data = snapshot.data() ?? {};
    const lastFailureKind = data.lastFailureKind === "session" || data.lastFailureKind === "usage"
      ? data.lastFailureKind
      : null;
    const lastFailureCode = [
      "external_http_4xx",
      "external_http_5xx",
      "external_http_other",
      "external_network_error",
    ].includes(String(data.lastFailureCode ?? ""))
      ? String(data.lastFailureCode)
      : null;
    const lastHttpStatus = typeof data.lastHttpStatus === "number"
      && Number.isInteger(data.lastHttpStatus)
      && data.lastHttpStatus >= 100
      && data.lastHttpStatus <= 599
      ? data.lastHttpStatus
      : null;
    const failureAtMs = typeof data.lastFailureAtIso === "string"
      ? Date.parse(data.lastFailureAtIso)
      : Number.NaN;
    return {
      failureCount: typeof data.failureCount === "number" && Number.isFinite(data.failureCount)
        ? Math.max(0, Math.trunc(data.failureCount))
        : 0,
      lastFailureKind,
      lastFailureCode,
      lastHttpStatus,
      lastCorrelationIdHash:
        typeof data.lastCorrelationIdHash === "string" && /^[a-f0-9]{24}$/.test(data.lastCorrelationIdHash)
          ? data.lastCorrelationIdHash
          : null,
      lastFailureAtIso: Number.isFinite(failureAtMs)
        ? new Date(failureAtMs).toISOString()
        : null,
    };
  } catch {
    return null;
  }
}

export async function getAiHubKeyStatus(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "aiHub.keyStatus.read", ["super_admin"]);
  const [keyStatus, failureStatus] = await Promise.all([
    Promise.resolve(readAiHubKeyStatus()),
    readAiHubFailureStatus(),
  ]);
  return {
    ok: true,
    keyStatus,
    failureStatus,
    behaviorLog: makeBehaviorLog(auth, "aiHub.keyStatus.read", "success", "global", 0),
  };
}
