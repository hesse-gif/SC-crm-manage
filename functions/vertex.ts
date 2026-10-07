import { GoogleGenAI } from "@google/genai";
import {
  assertStagingLlmEgressAllowed,
  isStagingSafetyRuntime,
  resolveStagingLlmMode,
  resolveStagingUploadBucket,
  submissionUploadObjectPrefix,
} from "./stagingSafety";
import {
  executeJevProvider,
  type JevEgressRoute,
  type JevTransportResult,
} from "./modelProviders/jev";
import type { JevRequest } from "./jev/jevTypes";

// Vertex AI (Gemini) 호출 헬퍼 — Infly opsVertex.js 패턴 포팅.
// 인증: 서비스 계정/ADC (vertexai:true) — API key 사용 안 함(SEC-P0-005 내부 Gateway 경유 원칙 준수).
// 단가는 모니터링용 추정치(USD / 1M tokens). 운영 정산은 Vertex billing export가 정본.

export type VertexModelId = "gemini-2.5-flash-lite" | "gemini-3.1-flash-lite" | "gemini-2.5-flash" | "gemini-2.5-pro";

export const DEFAULT_VERTEX_MODEL: VertexModelId = "gemini-2.5-flash";
export const DEFAULT_VERTEX_LOW_COST_MODEL: VertexModelId = "gemini-2.5-flash-lite";
const VERTEX_MODEL_IDS: readonly VertexModelId[] = ["gemini-2.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-2.5-pro"];

// 26-09-24 [헤세 결정]: gemini-2.5-pro는 비용 사유로 전 경로 퇴역. 여전히 VertexModelId 타입·가격표에는
// 남아 있다(과거 cost-log 파싱/표시용) — 그러나 새 호출은 절대 이 모델을 골라선 안 된다. 저장된
// settings/default 라우트(admin에서 과거에 quality 모드로 pro를 저장해 둔 문서 포함)나 integrations/default
// 게이트웨이 오버라이드가 여전히 "gemini-2.5-pro" 문자열을 담고 있어도, 아래 헬퍼를 거치는 모든 런타임
// 선택 지점은 이 모델을 거부하고 안전한 기본값으로 폴백한다.
const RETIRED_VERTEX_MODEL_IDS = new Set<string>(["gemini-2.5-pro"]);

/** 값이 퇴역한 모델 id인가 — 오버라이드/저장값이 이 모델을 다시 불러오려 하면 여기서 걸러낸다. */
export function isRetiredVertexModelId(value: unknown): boolean {
  return typeof value === "string" && RETIRED_VERTEX_MODEL_IDS.has(value);
}

/** 저장된 설정/오버라이드 값이 실제로 "지금 호출해도 되는" 모델인지 — 퇴역 모델은 거부한다(fail-closed). */
export function isSelectableVertexModelId(value: unknown): value is VertexModelId {
  return isVertexModelId(value) && !isRetiredVertexModelId(value);
}

const MODEL_PRICING_USD_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  "gemini-2.5-flash-lite": { input: 0.10, output: 0.40 },
  "gemini-3.1-flash-lite": { input: 0.125, output: 0.75 },
  "gemini-2.5-flash": { input: 0.30, output: 2.50 },
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
};

export type VertexTaskKind =
  | "language"
  | "tagging"
  | "comment_summary"
  | "inbound_summary"
  | "candidate_rerank"
  | "email_draft"
  | "contract_review"
  | "video_analysis"
  | "general";

const LOW_COST_TASKS = new Set<VertexTaskKind>(["language", "tagging", "comment_summary", "inbound_summary"]);

export type VertexModelRoute = {
  costModel?: string;
  currentModel?: string;
  premiumModel?: string;
  mode?: string;
};

export function isVertexModelId(value: unknown): value is VertexModelId {
  return typeof value === "string" && VERTEX_MODEL_IDS.includes(value as VertexModelId);
}

export function selectVertexModelForTask(task: VertexTaskKind | string): VertexModelId {
  const normalized = String(task || "general").toLowerCase();
  // 26-09-24 [헤세 결정]: gemini-2.5-pro는 비용 사유로 전 경로 퇴역 — 계약/법무/서명 태스크도
  // 기본 모델(flash)로 라우팅한다. VertexModelId/가격표에는 과거 cost-log 파싱을 위해 남겨둔다.
  if (normalized.includes("contract") || normalized.includes("legal") || normalized.includes("signature")) {
    return DEFAULT_VERTEX_MODEL;
  }
  if (
    LOW_COST_TASKS.has(normalized as VertexTaskKind)
    || normalized.includes("language")
    || normalized.includes("tag")
    || normalized.includes("comment")
    || normalized.includes("summary")
    || normalized.includes("summarize")
    || normalized.includes("inbound-email")
    || normalized.includes("youtube")
    || normalized.includes("shorts")
  ) {
    return DEFAULT_VERTEX_LOW_COST_MODEL;
  }
  if (normalized.includes("draft") || normalized.includes("reply") || normalized.includes("rerank") || normalized.includes("negotiat")) {
    return DEFAULT_VERTEX_MODEL;
  }
  return DEFAULT_VERTEX_MODEL;
}

function modelRouteKeyForTask(task: string): "mail_gateway_triage" | "auto_reply_draft" | "knowledge_ingest" | "candidate_discovery" | undefined {
  const normalized = String(task || "general").toLowerCase();
  if (normalized.includes("knowledge") || normalized.includes("ingest")) return "knowledge_ingest";
  if (normalized.includes("candidate") || normalized.includes("rerank") || normalized.includes("discovery")) return "candidate_discovery";
  if (normalized.includes("draft") || normalized.includes("reply") || normalized.includes("auto_reply")) return "auto_reply_draft";
  if (
    normalized.includes("receiveemail")
    || normalized.includes("receive-email")
    || normalized.includes("gateway")
    || normalized.includes("triage")
    || normalized.includes("inbound")
    || normalized.includes("summary")
  ) return "mail_gateway_triage";
  return undefined;
}

export function selectVertexModelForTaskWithRoutes(
  task: VertexTaskKind | string,
  routes: Partial<Record<string, VertexModelRoute>> | undefined,
): VertexModelId {
  const fallback = selectVertexModelForTask(task);
  const routeKey = modelRouteKeyForTask(String(task || "general"));
  if (!routeKey || !routes) return fallback;
  const route = routes[routeKey];
  if (!route) return fallback;
  const candidate = route.mode === "quality"
    ? route.premiumModel
    : route.costModel ?? route.currentModel;
  // 저장된 settings/default 라우트가 과거에 quality 모드로 pro를 저장해 둔 채로 남아 있어도(운영 문서는
  // 코드 기본값을 덮어써 보존된다), 퇴역 모델은 여기서 거부하고 fallback(항상 flash 계열)으로 내려간다.
  return isSelectableVertexModelId(candidate) ? candidate : fallback;
}

export type VertexUsage = {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};

export type VertexTransport = "ai_hub_gateway" | "vertex_direct";
export type CallModelOptions = { provider?: "configured" | "vertex" };

export type VertexResult<T = unknown> = {
  json: T;
  text: string;
  modelId: string;
  provider: string;
  transport: VertexTransport;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};

export function normalizeModelProvider(value: unknown): string {
  if (typeof value !== "string") return "unverified";
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized) ? normalized : "unverified";
}

export const VERTEX_SDK_RETRY_ATTEMPTS = 3;

let cachedClient: GoogleGenAI | null = null;

function genAiClient(): GoogleGenAI {
  if (cachedClient) return cachedClient;
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "influchat-77db6";
  const location = process.env.OPS_VERTEX_LOCATION || "us-central1";
  cachedClient = new GoogleGenAI({
    vertexai: true,
    project,
    location,
    // @google/genai 2.9.0 enables transport retries only from client-level httpOptions.
    // Three total attempts bounds transient 408/429/5xx recovery to the SDK default 1s + 2s waits.
    httpOptions: { retryOptions: { attempts: VERTEX_SDK_RETRY_ATTEMPTS } },
  });
  return cachedClient;
}

export function estimateCostUsd(modelId: string, inputTokens: number, outputTokens: number): number {
  const price = MODEL_PRICING_USD_PER_1M_TOKENS[modelId] ?? { input: 0, output: 0 };
  const cost = (Number(inputTokens || 0) / 1_000_000 * price.input)
    + (Number(outputTokens || 0) / 1_000_000 * price.output);
  return Number(cost.toFixed(8));
}

type UsageMetadata = { promptTokenCount?: number; candidatesTokenCount?: number };

function usageFromResponse(modelId: string, usageMetadata: UsageMetadata | undefined): VertexUsage {
  const inputTokens = Number(usageMetadata?.promptTokenCount ?? 0);
  const outputTokens = Number(usageMetadata?.candidatesTokenCount ?? 0);
  return {
    inputTokens,
    outputTokens,
    estimatedCostUsd: estimateCostUsd(modelId, inputTokens, outputTokens),
  };
}


const SDK_RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const SDK_RETRYABLE_HTTP_STATUS_TEXT: Record<string, number> = {
  "request timeout": 408,
  "too many requests": 429,
  "internal server error": 500,
  "bad gateway": 502,
  "service unavailable": 503,
  "gateway timeout": 504,
};

function sdkRetryableStatusFromErrorMessage(message: string): number | null {
  const prefix = "Retryable HTTP Error:";
  if (!message.startsWith(prefix)) return null;
  const reason = message.slice(prefix.length).trim();
  const numeric = /^(\d{3})(?:\b|$)/.exec(reason);
  if (numeric) {
    const status = Number(numeric[1]);
    return SDK_RETRYABLE_HTTP_STATUSES.has(status) ? status : null;
  }
  return SDK_RETRYABLE_HTTP_STATUS_TEXT[reason.toLowerCase()] ?? null;
}

function preserveSdkRetryableStatus(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const record = error as Error & { status?: unknown };
  if (typeof record.status === "number") return error;
  const status = sdkRetryableStatusFromErrorMessage(error.message);
  if (!status) return error;
  Object.defineProperty(error, "status", {
    value: status,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return error;
}

function responseText(response: { text?: string; candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }): string {
  if (typeof response.text === "string" && response.text.trim()) return response.text.trim();
  const parts = response.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => part?.text ?? "").filter(Boolean).join("\n").trim();
}

function stripJsonFence(text: string): string {
  const trimmed = String(text || "").trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  return start >= 0 && end >= start ? unfenced.slice(start, end + 1) : unfenced;
}

export async function generateJson<T = unknown>(
  modelId: string,
  responseSchema: unknown,
  promptText: string,
): Promise<VertexResult<T>> {
  assertStagingLlmEgressAllowed("vertex");
  let response: Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>;
  try {
    response = await genAiClient().models.generateContent({
      model: modelId,
      contents: promptText,
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema as never,
      },
    });
  } catch (error) {
    throw preserveSdkRetryableStatus(error);
  }

  const text = responseText(response as never);
  if (!text) {
    throw Object.assign(new Error("Vertex returned an empty response."), { code: "failed-precondition", errorCode: "generate_json_vertex_returned_empty_response" });
  }
  let json: T;
  try {
    json = JSON.parse(stripJsonFence(text)) as T;
  } catch {
    throw Object.assign(new Error("Vertex returned an unparseable JSON response."), { code: "failed-precondition", errorCode: "generate_json_vertex_returned_unparseable_json_response" });
  }

  const usage = usageFromResponse(modelId, (response as { usageMetadata?: UsageMetadata }).usageMetadata);
  return {
    json,
    text,
    modelId,
    provider: "vertex",
    transport: "vertex_direct",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedCostUsd: usage.estimatedCostUsd,
  };
}

// SEC-P0-005: 모델 호출 단일 chokepoint. 게이트웨이 경로는 vertex.generateJson 을 직접 부르지 말고
// 이 함수를 거친다 → AI_HUB_GATEWAY_URL 이 설정돼 있으면 내부 AI Hub 엔드포인트로 라우팅하고,
// 운영에서는 없으면 기존 Vertex(ADC) 경로로 폴백한다. staging은 명시한
// FLU_STAGING_LLM_MODE 한 경로만 허용하며 Vertex 암묵 폴백을 금지한다.
//   ⚠️ INFRA: 내부 AI Hub 엔드포인트(+키) 프로비저닝은 인프라 영역(티코/시몬). 여기서 엔드포인트를
//   하드코딩하거나 가짜 게이트웨이를 만들지 않는다 — 운영에서만 AI_HUB_GATEWAY_URL 미설정 시 Vertex 폴백이 정상 동작.
//   엔드포인트는 generateJson 과 동일한 구조화 JSON 계약(VertexResult<T>)을 반환해야 한다.
export function aiHubGatewayUrl(): string {
  return process.env.AI_HUB_GATEWAY_URL?.trim() ?? "";
}

/**
 * AI Hub 게이트웨이 왕복 상한(ms).
 *
 * ■ 왜 필요한가 (W119 리뷰 M5)
 *   `fetch` 는 기본 타임아웃이 없다. 게이트웨이가 응답하지 않으면 호출자는 **함수 상한(300s)까지**
 *   매달린다. 배치 레인(요약 백필·스케줄 편승)에서는 그 한 통이 회차 예산을 통째로 먹어, 같은 틱의
 *   뒤 단계(대화 물질화 등)가 굶는다. 바운드가 있어야 실패가 **실패로** 드러나고 다음 회차가 잇는다.
 *
 * ■ 왜 30s 가 아니라 60s 기본인가
 *   이 초크포인트는 트리아지·초안·번역·키워드 확장·댓글 배치 분석·심사 판정을 **전부** 태운다.
 *   그중 배치 분석 계열은 30s 를 넘길 수 있어, 그 값으로 고정하면 기존 레인을 새로 깨뜨린다.
 *   60s 는 함수 상한의 1/5 이라 굶김을 막으면서 기존 호출을 자르지 않는다. 재배포 없이 조정할 수
 *   있게 env 로 연다(비정상 값은 기본값으로 폴백 — 설정 실수로 0/음수가 들어와도 즉시 실패하지 않는다).
 */
const AI_HUB_GATEWAY_DEFAULT_TIMEOUT_MS = 60_000;

export function aiHubGatewayTimeoutMs(): number {
  const configured = Math.trunc(Number(process.env.AI_HUB_GATEWAY_TIMEOUT_MS));
  return Number.isFinite(configured) && configured > 0
    ? configured
    : AI_HUB_GATEWAY_DEFAULT_TIMEOUT_MS;
}

type AiHubGatewaySafeErrorFields = {
  status?: number;
  statusCode?: number;
  name?: "AbortError" | "TimeoutError";
};

function aiHubGatewayError(
  message: string,
  errorCode: string,
  safeFields: AiHubGatewaySafeErrorFields = {},
): Error & { code: string; errorCode: string } & AiHubGatewaySafeErrorFields {
  return Object.assign(new Error(message), {
    code: "failed-precondition",
    errorCode,
    ...safeFields,
  });
}

function safeAiHubGatewayHttpStatus(status: number): number {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
}

function aiHubGatewayJsonUnparseableError(): Error & { code: string; errorCode: string } {
  return aiHubGatewayError(
    "AI Hub gateway returned an unparseable JSON response.",
    "call_ai_hub_gateway_ai_hub_gateway_returned_unparseable",
  );
}

async function callAiHubGateway<T = unknown>(
  modelId: string,
  responseSchema: unknown,
  promptText: string,
  endpoint: string,
): Promise<VertexResult<T>> {
  assertStagingLlmEgressAllowed("aihub");
  const apiKey = process.env.AI_HUB_GATEWAY_API_KEY?.trim() ?? "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = apiKey.toLowerCase().startsWith("bearer ") ? apiKey : `Bearer ${apiKey}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ modelId, responseSchema, promptText }),
      // 무기한 대기 금지 — 초과분은 AbortError 로 아래 catch 에 떨어져 기존 실패 계약을 그대로 탄다.
      signal: AbortSignal.timeout(aiHubGatewayTimeoutMs()),
    });
  } catch (err) {
    const name = err instanceof Error && err.name === "AbortError" ? "AbortError" : undefined;
    throw aiHubGatewayError(
      `AI Hub gateway call failed: ${err instanceof Error ? err.message : "unknown"}`,
      "call_ai_hub_gateway_ai_hub_gateway_call_err",
      name ? { name } : {},
    );
  }
  if (!response.ok) {
    const status = safeAiHubGatewayHttpStatus(response.status);
    throw aiHubGatewayError(
      `AI Hub gateway returned ${response.status}`,
      "call_ai_hub_gateway_ai_hub_gateway_returned",
      { status, statusCode: status },
    );
  }
  let payload: Partial<VertexResult<T>> & { json?: T };
  try {
    payload = await response.json() as Partial<VertexResult<T>> & { json?: T };
  } catch {
    throw aiHubGatewayJsonUnparseableError();
  }
  if (!payload || typeof payload.json !== "object") {
    throw aiHubGatewayJsonUnparseableError();
  }
  return {
    json: payload.json as T,
    text: typeof payload.text === "string" ? payload.text : "",
    modelId,
    provider: normalizeModelProvider(payload.provider),
    transport: "ai_hub_gateway",
    inputTokens: Number(payload.inputTokens ?? 0),
    outputTokens: Number(payload.outputTokens ?? 0),
    estimatedCostUsd: Number(payload.estimatedCostUsd ?? estimateCostUsd(modelId, Number(payload.inputTokens ?? 0), Number(payload.outputTokens ?? 0))),
  };
}

// 게이트웨이 경로가 호출하는 단일 진입점. config-gate(AI_HUB_GATEWAY_URL)로 분기.
//   Vertex 폴백은 모듈 export(generateJson)를 통해 호출한다 — 동일 모듈 인스턴스에서 export 를
//   교체(테스트 스파이)해도 chokepoint 가 이를 그대로 관측하도록 하기 위함(CJS module.exports 경유).
export type TypesafeModelCall = {
  provider: "typesafe";
  request: JevRequest;
  route: JevEgressRoute;
};

export async function callModel(
  call: TypesafeModelCall,
  responseSchema?: unknown,
  promptText?: string,
): Promise<JevTransportResult>;
export async function callModel<T = unknown>(
  modelId: string,
  responseSchema: unknown,
  promptText: string,
  options?: CallModelOptions,
): Promise<VertexResult<T>>;
export async function callModel<T = unknown>(
  modelIdOrCall: string | TypesafeModelCall,
  responseSchema?: unknown,
  promptText?: string,
  options: CallModelOptions = {},
): Promise<VertexResult<T> | JevTransportResult> {
  if (typeof modelIdOrCall !== "string") {
    if (modelIdOrCall.provider !== "typesafe") {
      throw Object.assign(new Error("Unsupported model provider"), {
        code: "invalid-argument",
        errorCode: "call_model_unsupported_provider",
      });
    }
    return executeJevProvider(modelIdOrCall.request, modelIdOrCall.route);
  }
  const modelId = modelIdOrCall;
  promptText ??= "";
  if (options.provider === "vertex") {
    if (isStagingSafetyRuntime()) {
      if (resolveStagingLlmMode() !== "vertex") {
        throw Object.assign(new Error("Vertex provider selection requires FLU_STAGING_LLM_MODE=vertex in staging."), {
          code: "failed-precondition",
          errorCode: "call_model_vertex_provider_not_approved_in_staging",
        });
      }
      assertStagingLlmEgressAllowed("vertex");
    }
    const vertexGenerateJson = (module.exports as { generateJson: typeof generateJson }).generateJson;
    return vertexGenerateJson<T>(modelId, responseSchema, promptText);
  }
  const endpoint = aiHubGatewayUrl();
  if (isStagingSafetyRuntime()) {
    const mode = resolveStagingLlmMode();
    if (mode === "aihub") {
      assertStagingLlmEgressAllowed("aihub");
      if (!endpoint) {
        throw Object.assign(
          new Error("AI_HUB_GATEWAY_URL is required when FLU_STAGING_LLM_MODE=aihub; Vertex fallback is disabled in staging."),
          { code: "failed-precondition", errorCode: "call_model_ai_hub_gateway_url_required" },
        );
      }
      return callAiHubGateway<T>(modelId, responseSchema, promptText, endpoint);
    }
    if (mode === "vertex") {
      assertStagingLlmEgressAllowed("vertex");
      const vertexGenerateJson = (module.exports as { generateJson: typeof generateJson }).generateJson;
      return vertexGenerateJson<T>(modelId, responseSchema, promptText);
    }
    assertStagingLlmEgressAllowed("aihub");
  }
  if (endpoint) return callAiHubGateway<T>(modelId, responseSchema, promptText, endpoint);
  const vertexGenerateJson = (module.exports as { generateJson: typeof generateJson }).generateJson;
  return vertexGenerateJson<T>(modelId, responseSchema, promptText);
}

// ── P5 추가(additive-only): 영상 멀티모달(Gemini) 2차 분석 ───────────────────────────
// VertexContentPart: generateContent의 contents[].parts 요소 — 텍스트 또는 승인된 영상 fileUri 참조.
export type VertexContentPart =
  | { text: string }
  | { fileData: { fileUri: string; mimeType: string } };

// generateJson과 동일 계약(JSON 파싱/usage 집계 재사용)의 멀티파트 변형. generateJson의 promptText 대신
// parts 배열(텍스트+fileData)을 단일 user 턴으로 전송한다. opts.mediaResolution은 영상 프레임 샘플링
// 해상도 힌트(Gemini video understanding) — 미지정 시 모델 기본값.
export async function generateJsonFromParts<T = unknown>(
  modelId: string,
  responseSchema: unknown,
  parts: VertexContentPart[],
  opts?: { mediaResolution?: string },
): Promise<VertexResult<T>> {
  assertStagingLlmEgressAllowed("vertex");
  let response: Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>;
  try {
    response = await genAiClient().models.generateContent({
      model: modelId,
      contents: [{ role: "user", parts }],
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema as never,
        ...(opts?.mediaResolution ? { mediaResolution: opts.mediaResolution as never } : {}),
      },
    });
  } catch (error) {
    throw preserveSdkRetryableStatus(error);
  }

  const text = responseText(response as never);
  if (!text) {
    throw Object.assign(new Error("Vertex returned an empty response."), { code: "failed-precondition", errorCode: "generate_json_from_parts_vertex_returned_empty_response" });
  }
  let json: T;
  try {
    json = JSON.parse(stripJsonFence(text)) as T;
  } catch {
    throw Object.assign(new Error("Vertex returned an unparseable JSON response."), { code: "failed-precondition", errorCode: "generate_json_from_parts_vertex_returned_unparseable_json_response" });
  }

  const usage = usageFromResponse(modelId, (response as { usageMetadata?: UsageMetadata }).usageMetadata);
  return {
    json,
    text,
    modelId,
    provider: "vertex",
    transport: "vertex_direct",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    estimatedCostUsd: usage.estimatedCostUsd,
  };
}

export type VertexVideoResult<T = unknown> = VertexResult<T> & {
  gatewayBypassed: "video_multimodal_sec_p0_005_exception";
};

// SEC-P0-005 B2 예외(사용자 승인, 2026-07-03) — 사람 승인 원장에 기록됨. AI Hub Gateway가
// fileData/parts 멀티모달 페이로드를 아직 지원하지 않는 동안, 영상 2차 분석은 게이트웨이를 우회하고
// Vertex(ADC) 직행으로만 호출한다. 게이트웨이가 parts 지원을 확보하면 이 예외는 제거하고 callModel과
// 동일하게 게이트웨이 우선 라우팅으로 통합해야 한다(추적: docs/PROMPT-REVISION-BACKLOG.md).
//   (1) VERTEX_VIDEO_LANE_APPROVED !== 'true' 면 failed-precondition 거부 — 이 레인은 별도 사람 승인 게이트.
//   (2) AI_HUB_GATEWAY_URL 이 설정돼 있어도 무시하고 Vertex(ADC) 직행 + 결과에
//       gatewayBypassed:'video_multimodal_sec_p0_005_exception' 마커를 남겨 감사 가능하게 한다(usage 로그에도 전파).
//   (3) fileUri 는 YouTube 또는 ADC가 읽을 수 있고 상위 레이어에서 metadata 검증된 approved-bucket
//       canonical gs:// 영상 1개만 허용한다. 임의 HTTPS MP4는 허용하지 않는다. Storage metadata 검증은 videoReviewMultimodal.ts가 담당하고,
//       이 chokepoint는 protocol/host/mime/shape를 다시 검증한다.
export async function callVideoModel<T = unknown>(
  modelId: string,
  responseSchema: unknown,
  parts: VertexContentPart[],
  opts?: { mediaResolution?: string },
): Promise<VertexVideoResult<T>> {
  assertStagingLlmEgressAllowed("vertex");
  if (process.env.VERTEX_VIDEO_LANE_APPROVED !== "true") {
    throw Object.assign(
      new Error("Video multimodal lane requires VERTEX_VIDEO_LANE_APPROVED=true (human-approved SEC-P0-005 B2 exception gate)."),
      { code: "failed-precondition", errorCode: "call_video_model_video_multimodal_lane_requires_vertex" },
    );
  }
  validateVertexVideoParts(parts);
  // 동일 모듈 인스턴스에서 export를 교체(테스트 스파이)해도 chokepoint가 이를 그대로 관측하도록
  // module.exports 경유(CJS)로 호출한다 — callModel의 기존 스파이 패턴과 동형.
  const vertexGenerateJsonFromParts = (module.exports as { generateJsonFromParts: typeof generateJsonFromParts }).generateJsonFromParts;
  const result = await vertexGenerateJsonFromParts<T>(modelId, responseSchema, parts, opts);
  return { ...result, gatewayBypassed: "video_multimodal_sec_p0_005_exception" };
}

export function validateVertexVideoParts(parts: VertexContentPart[]): void {
  const files = parts.flatMap((part) => "fileData" in part ? [part.fileData] : []);
  if (files.length !== 1) throw invalidVideoMediaError();
  const file = files[0];
  if (file.mimeType !== "video/mp4") throw invalidVideoMediaError();
  if (!safeVertexVideoUri(file.fileUri)) throw invalidVideoMediaError();
}

function safeVertexVideoUri(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "gs:") {
      if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return false;
      const bucket = parsed.hostname.toLowerCase();
      const objectPath = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
      return /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)
        && allowedVertexVideoBuckets().has(bucket)
        && objectPath.startsWith(submissionUploadObjectPrefix())
        && /\.mp4$/i.test(objectPath)
        && !/[\u0000-\u001f\u007f]/.test(objectPath)
        && !objectPath.split("/").some((segment) => !segment || segment === "." || segment === "..")
        && canonicalVertexGcsUri(bucket, objectPath) === value;
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) return false;
    const host = parsed.hostname.toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false;
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function canonicalVertexGcsUri(bucket: string, objectPath: string): string {
  return `gs://${bucket}/${objectPath.split("/").map(encodeURIComponent).join("/")}`;
}

function allowedVertexVideoBuckets(): Set<string> {
  if (isStagingSafetyRuntime()) return new Set([resolveStagingUploadBucket()]);
  const buckets = new Set<string>();
  const projectId = (process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "").trim().toLowerCase();
  if (projectId) {
    buckets.add(`${projectId}.appspot.com`);
    buckets.add(`${projectId}.firebasestorage.app`);
  }
  try {
    const config = JSON.parse(process.env.FIREBASE_CONFIG || "{}") as { storageBucket?: unknown };
    if (typeof config.storageBucket === "string" && config.storageBucket.trim()) buckets.add(config.storageBucket.trim().toLowerCase());
  } catch {
    // Invalid runtime config yields an empty allowlist and therefore a fail-closed descriptor.
  }
  return buckets;
}

function invalidVideoMediaError(): Error {
  return Object.assign(new Error("Video multimodal request contains an invalid or unsupported media descriptor."), { code: "invalid-argument", errorCode: "invalid_video_media_error_video_multimodal_request_contains_invalid" });
}
