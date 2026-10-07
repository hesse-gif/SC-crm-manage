// P5 영상 2차 멀티모달 분석 공용 LLM 러너 — communitySearch.ts/videoClassifier.ts LLM 호출 규범
//   (캐시 선행 → callFn(chokepoint) → usage 로그) 을 텍스트 레인과 동일한 형태로 영상 멀티모달 레인에
//   적용한다(COST-P0). callFn 기본값은 vertex.callVideoModel(SEC-P0-005 B2 예외, gatewayBypassed 마커).
// 프롬프트 원문은 usage 로그에 싣지 않는다(SEC-P0-009).

import type { VertexContentPart, VertexVideoResult } from "./vertex";

export type VideoLlmKind = "video_deep_analysis" | "video_review_judge";

export type VideoLlmCacheMetadata = {
  readonly modelId: string;
  readonly provider: string;
  readonly runId: string;
  readonly gatewayBypassed?: string;
};

export type VideoLlmCache<T> = {
  get(key: string): Promise<T | null>;
  set(key: string, value: T, metadata: VideoLlmCacheMetadata): Promise<void>;
};

export type VideoLlmCallFn = <T = unknown>(
  modelId: string,
  responseSchema: unknown,
  parts: VertexContentPart[],
  opts?: { mediaResolution?: string },
) => Promise<VertexVideoResult<T>>;

export type RunVideoLlmOptions<T> = {
  readonly cacheKey: string;
  readonly cache?: VideoLlmCache<T>;
  readonly modelId: string;
  readonly responseSchema: unknown;
  readonly parts: VertexContentPart[];
  readonly mediaResolution?: string;
  readonly callFn?: VideoLlmCallFn;
  readonly runId?: string;
  readonly actionId?: string;
  readonly normalize: (json: unknown) => T;
};

export type RunVideoLlmResult<T> = {
  readonly value: T;
  readonly modelId: string;
  readonly cacheHit: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly gatewayBypassed?: string;
};

type VertexModule = {
  callVideoModel: VideoLlmCallFn;
};

type AiHubReportModule = {
  newSessionId: () => string;
  reportLlmUsage: (opts?: Record<string, unknown>) => Promise<void>;
};

declare const require: ((id: string) => unknown) | undefined;

function asRequireModule<T>(moduleName: string): T | null {
  if (typeof require !== "function") return null;
  try {
    return require(moduleName) as T;
  } catch {
    return null;
  }
}

function vertexModule(): VertexModule | null {
  return asRequireModule<VertexModule>("./vertex");
}

function aiHubReportModule(): AiHubReportModule | null {
  return asRequireModule<AiHubReportModule>("./aiHubReport");
}

async function defaultCallFn<T = unknown>(
  modelId: string,
  responseSchema: unknown,
  parts: VertexContentPart[],
  opts?: { mediaResolution?: string },
): Promise<VertexVideoResult<T>> {
  const vertex = vertexModule();
  if (!vertex) throw new Error("vertex callVideoModel module is unavailable");
  return vertex.callVideoModel<T>(modelId, responseSchema, parts, opts);
}

async function logVideoLlmUsage(
  kind: VideoLlmKind,
  runId: string,
  actionId: string | undefined,
  modelId: string,
  provider: string,
  transport: "ai_hub_gateway" | "vertex_direct" | undefined,
  inputTokens: number,
  outputTokens: number,
  estimatedCostUsd: number,
  cacheHit: boolean,
  gatewayBypassed: string | undefined,
  latencyMs: number,
): Promise<void> {
  const usage = {
    event: `${kind}_llm_usage`,
    runId,
    modelId,
    provider,
    transport: cacheHit ? "cache" : transport ?? "unverified",
    inputTokens: cacheHit ? 0 : inputTokens,
    outputTokens: cacheHit ? 0 : outputTokens,
    estimatedCostUsd: cacheHit ? 0 : estimatedCostUsd,
    cacheHit,
    ...(gatewayBypassed ? { gatewayBypassed } : {}),
    latencyMs,
  };
  console.info("[video-llm]", usage);
  const aiHub = aiHubReportModule();
  if (!aiHub) return;
  await aiHub.reportLlmUsage({
    sessionId: aiHub.newSessionId(),
    toolId: `video.${kind}`,
    modelId,
    provider,
    transport: cacheHit ? "cache" : transport ?? "unverified",
    inputTokens: cacheHit ? 0 : inputTokens,
    outputTokens: cacheHit ? 0 : outputTokens,
    totalCostUsd: cacheHit ? 0 : estimatedCostUsd,
    latencyMs,
    actionId: actionId ?? runId,
  });
}

// 공용 캐시 선행 + callFn(chokepoint) 경유 + usage 로그 러너. 텍스트 레인(communitySearch.ts
// enrichCommunityPostSentiments, videoClassifier.classifyVideoTierOne)과 동형 구조를 영상 멀티모달
// 레인(callFn=vertex.callVideoModel)에 적용한다. cache.get()이 히트하면 callFn을 전혀 호출하지 않는다
// (COST-P0-011). 미스 시 callFn 호출 결과를 normalize()로 정규화해 캐시에 저장하고 usage를 로깅한다.
export async function runVideoLlm<T>(
  kind: VideoLlmKind,
  options: RunVideoLlmOptions<T>,
): Promise<RunVideoLlmResult<T>> {
  const runId = options.runId ?? `${kind}-${Date.now()}`;
  const startedAt = Date.now();

  if (options.cache) {
    const cached = await options.cache.get(options.cacheKey);
    if (cached !== null) {
      await logVideoLlmUsage(kind, runId, options.actionId, options.modelId, "unverified", undefined, 0, 0, 0, true, undefined, Date.now() - startedAt);
      return { value: cached, modelId: options.modelId, cacheHit: true, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
    }
  }

  const callFn = options.callFn ?? defaultCallFn;
  const result = await callFn<unknown>(options.modelId, options.responseSchema, options.parts, {
    ...(options.mediaResolution ? { mediaResolution: options.mediaResolution } : {}),
  });
  const value = options.normalize(result.json);

  if (options.cache) {
    await options.cache.set(options.cacheKey, value, {
      modelId: result.modelId,
      provider: result.provider,
      runId,
      gatewayBypassed: result.gatewayBypassed,
    });
  }

  await logVideoLlmUsage(
    kind,
    runId,
    options.actionId,
    result.modelId,
    result.provider,
    result.transport,
    result.inputTokens,
    result.outputTokens,
    result.estimatedCostUsd,
    false,
    result.gatewayBypassed,
    Date.now() - startedAt,
  );

  return {
    value,
    modelId: result.modelId,
    cacheHit: false,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCostUsd: result.estimatedCostUsd,
    gatewayBypassed: result.gatewayBypassed,
  };
}
