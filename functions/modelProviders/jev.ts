import {
  assertStagingJevEgressAllowed,
  isStagingSafetyRuntime,
  resolveStagingJevMode,
} from "../stagingSafety";
import { normalizeLlmProvider } from "../aiHubReport";
import {
  JEV_DEFAULT_ENDPOINT,
  JEV_MODEL_ID,
  JEV_PROVIDER,
  parseJevResponse,
  type JevRequest,
  type JevResponse,
} from "../jev/jevTypes";

// TypeSafe/JEV egress chokepoint.
//   Compliance: external calls go through Functions callables (NET-P0-012); external AI must use the
//   internal AI Hub gateway outside staging unless direct JEV egress is explicitly opted in (SEC-P0-005):
//     - `FLU_JEV_GATEWAY_URL` set -> route the JEV request through the dedicated gateway.
//     - `FLU_JEV_ENABLED` + `AI_HUB_GATEWAY_URL` -> route through the explicitly opted-in shared gateway.
//     - `FLU_JEV_MODE=direct` + `FLU_JEV_ENABLED` -> route through the approved TypeSafe callModel adapter.
//     - `FLU_STAGING_JEV_MODE=direct` -> route through the approved TypeSafe callModel adapter in staging.
//   Staging NEVER falls through implicitly: FLU_STAGING_JEV_MODE must name `gateway` or `direct`.
//   Direct mode is explicit only; a failed direct call must never fall back to the gateway.
//   Missing credential / malformed envelope / transport error are all hard failures. The decision
//   layer above converts any failure into "hold" (fail-closed) — an unavailable JEV can never
//   authorize a send.

export type JevEgressRoute = "gateway" | "direct";

export type JevTransportName = "ai_hub_gateway" | "typesafe_direct";

export type JevTransportResult = {
  response: JevResponse;
  transport: JevTransportName;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  cacheHit?: boolean;
};

export type JevTransport = (request: JevRequest, route: JevEgressRoute) => Promise<JevTransportResult>;

export const JEV_RETRY_ATTEMPTS = 3;
const JEV_RETRY_BASE_DELAY_MS = 500;
const JEV_DEFAULT_TIMEOUT_MS = 60_000;

// TypeSafe/JEV primary pricing (System One models + JEV, published 2026-09-15):
//   input $0.042 per million tokens; output is free.
//   Source: https://typesafe.ai/blog/introducing-system-one-models-and-jev
//   Verified 2026-09-21. Output tokens therefore contribute no cost.
export const JEV_INPUT_USD_PER_MILLION = 0.042;

// Docs: 401/422/429/529 are retryable with backoff; we also retry transient 5xx.
const JEV_RETRYABLE_STATUSES = new Set([401, 408, 422, 429, 500, 502, 503, 504, 529]);

export class JevEgressError extends Error {
  readonly errorCode: string;
  readonly status: number;
  constructor(message: string, errorCode: string, status = 0) {
    super(message);
    this.name = "JevEgressError";
    this.errorCode = errorCode;
    this.status = status;
    Object.assign(this, { code: "failed-precondition" });
  }
}

// Fixed, sanitized failed-attempt telemetry. Only the event name, route, attempt index, HTTP status
// and a stable errorCode are emitted — never raw error messages/objects, URLs, headers, payloads or
// credentials. Transport exceptions carry status 0; unparseable/malformed successes carry the HTTP
// status of the offending response.
const JEV_FAILED_ATTEMPT_EVENT = "jev_provider_failed_attempt";

function logJevFailedAttempt(input: {
  route: JevEgressRoute;
  attempt: number;
  status: number;
  errorCode: string;
}): void {
  console.warn(
    JSON.stringify({
      event: JEV_FAILED_ATTEMPT_EVENT,
      route: input.route,
      attempt: input.attempt,
      status: input.status,
      errorCode: input.errorCode,
    }),
  );
}

export function jevEndpoint(): string {
  return process.env.JEV_API_URL?.trim() || JEV_DEFAULT_ENDPOINT;
}

function jevTimeoutMs(): number {
  const configured = Math.trunc(Number(process.env.JEV_TIMEOUT_MS));
  return Number.isFinite(configured) && configured > 0 ? configured : JEV_DEFAULT_TIMEOUT_MS;
}

export function aiHubGatewayUrl(): string {
  return process.env.AI_HUB_GATEWAY_URL?.trim() ?? "";
}

/**
 * F4 (adversarial review, MEDIUM): a JEV-specific gateway URL. The generic `AI_HUB_GATEWAY_URL`
 * is shared with vertex.ts, so it must never be the only thing that turns the JEV lane on.
 */
export function jevGatewayUrl(): string {
  return process.env.FLU_JEV_GATEWAY_URL?.trim() ?? "";
}

/**
 * Explicit JEV opt-in flag. Required before the shared AI Hub gateway URL may enable the lane.
 */
export function isJevEnabled(): boolean {
  const flag = process.env.FLU_JEV_ENABLED?.trim().toLowerCase();
  return flag === "true" || flag === "1" || flag === "yes";
}

/**
 * The single endpoint the gateway route posts to: a JEV-specific URL wins, otherwise the shared
 * AI Hub gateway URL. `isJevConfigured()` separately requires `FLU_JEV_ENABLED` before the shared
 * URL counts as a non-staging opt-in.
 */
export function jevGatewayEndpoint(): string {
  return jevGatewayUrl() || aiHubGatewayUrl();
}

/**
 * Resolves the single allowed egress route. Outside staging the lane defaults to the gateway, but an
 * explicit `FLU_JEV_MODE=direct` + `FLU_JEV_ENABLED` opt-in now selects the approved TypeSafe
 * callModel adapter; a missing gateway URL without that opt-in is a hard failure, never an implicit
 * direct fallback. Staging throws (fail-closed) unless it explicitly opts in; there is no implicit
 * direct egress from staging.
 */
export function resolveJevEgressRoute(): JevEgressRoute {
  const endpoint = jevGatewayEndpoint();
  if (isStagingSafetyRuntime()) {
    const mode = resolveStagingJevMode();
    if (mode === "gateway") {
      assertStagingJevEgressAllowed("gateway");
      if (!endpoint) {
        throw new JevEgressError(
          "FLU_JEV_GATEWAY_URL or AI_HUB_GATEWAY_URL is required when FLU_STAGING_JEV_MODE=gateway; direct JEV fallback is disabled in staging.",
          "jev_gateway_url_required",
        );
      }
      return "gateway";
    }
    if (mode === "direct") {
      assertStagingJevEgressAllowed("direct");
      return "direct";
    }
    throw new JevEgressError(
      "JEV egress is disabled in the staging runtime; set FLU_STAGING_JEV_MODE explicitly to allow it.",
      "jev_egress_disabled_in_staging",
    );
  }
  const mode = process.env.FLU_JEV_MODE?.trim();
  if (mode === "direct") {
    if (!isJevEnabled()) {
      throw new JevEgressError(
        "FLU_JEV_MODE=direct requires the explicit FLU_JEV_ENABLED opt-in outside staging.",
        "jev_direct_opt_in_required",
      );
    }
    return "direct";
  }
  if (mode && mode !== "gateway") {
    throw new JevEgressError(
      "FLU_JEV_MODE must be `gateway` or `direct` when set outside staging.",
      "jev_mode_invalid",
    );
  }
  if (!endpoint) {
    throw new JevEgressError(
      "FLU_JEV_GATEWAY_URL or AI_HUB_GATEWAY_URL is required; direct JEV fallback is disabled outside staging.",
      "jev_gateway_url_required",
    );
  }
  if (jevGatewayUrl().length === 0 && !isJevEnabled()) {
    throw new JevEgressError(
      "AI_HUB_GATEWAY_URL requires FLU_JEV_ENABLED before JEV can use the shared gateway.",
      "jev_disabled",
    );
  }
  return "gateway";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * True when the JEV lane is explicitly configured for this runtime.
 *   - staging: only when FLU_STAGING_JEV_MODE names `gateway` or `direct` (no implicit egress).
 *   - otherwise: explicit `FLU_JEV_MODE=direct` with `FLU_JEV_ENABLED`, a dedicated JEV gateway URL,
 *     or the shared AI Hub gateway URL with the explicit `FLU_JEV_ENABLED` opt-in.
 *     Direct TypeSafe credentials alone do not enable JEV outside staging — `FLU_JEV_MODE=direct`
 *     must be set explicitly (with `FLU_JEV_ENABLED`) to opt into the approved callModel adapter.
 * Callers use this to decide whether to CONSULT JEV at all. An unconfigured lane leaves existing
 * behavior byte-for-byte unchanged; a configured-but-unavailable lane resolves to a fail-closed hold.
 */
export function isJevConfigured(): boolean {
  if (isStagingSafetyRuntime()) {
    const mode = process.env.FLU_STAGING_JEV_MODE?.trim();
    return mode === "gateway" || mode === "direct";
  }
  const mode = process.env.FLU_JEV_MODE?.trim();
  if (mode === "direct") return isJevEnabled();
  if (mode && mode !== "gateway") return false;
  // A JEV-specific gateway URL is likewise an explicit opt-in.
  if (jevGatewayUrl().length > 0) return true;
  // The SHARED AI Hub gateway switch must never implicitly enable JEV — otherwise turning the
  //   general LLM gateway on for triage/draft calls would silently turn this lane on, and a gateway
  //   that does not serve `jev-latest` would hold every auto_reply. Require the explicit flag.
  return isJevEnabled() && aiHubGatewayUrl().length > 0;
}

function retryDelayMs(attempt: number): number {
  return JEV_RETRY_BASE_DELAY_MS * (2 ** attempt);
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(jevTimeoutMs()),
  });
}

/**
 * Default HTTP transport. Bounded retry/backoff on the documented retryable statuses. Every failure
 * surfaces as JevEgressError — never a synthesized/empty success.
 */
export const executeJevProvider: JevTransport = async (request, route) => {
  const resolvedRoute = resolveJevEgressRoute();
  if (route !== resolvedRoute) {
    throw new JevEgressError(
      `JEV provider route mismatch: received "${route}" but resolved "${resolvedRoute}".`,
      "jev_route_mismatch",
    );
  }

  if (route === "gateway") {
    const endpoint = jevGatewayEndpoint();
    if (!endpoint) {
      throw new JevEgressError(
        "FLU_JEV_GATEWAY_URL or AI_HUB_GATEWAY_URL is not configured.",
        "jev_gateway_url_missing",
      );
    }
    const apiKey = process.env.AI_HUB_GATEWAY_API_KEY?.trim() ?? "";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = apiKey.toLowerCase().startsWith("bearer ") ? apiKey : `Bearer ${apiKey}`;
    const payload = { modelId: JEV_MODEL_ID, responseSchema: null, promptText: JSON.stringify(request) };
    let lastStatus = 0;
    for (let attempt = 0; attempt < JEV_RETRY_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await postJson(endpoint, headers, payload);
      } catch {
        logJevFailedAttempt({
          route: "gateway",
          attempt,
          status: 0,
          errorCode: "jev_gateway_call_err",
        });
        if (attempt === JEV_RETRY_ATTEMPTS - 1) {
          throw new JevEgressError("JEV gateway call failed.", "jev_gateway_call_err");
        }
        await sleep(retryDelayMs(attempt));
        continue;
      }
      lastStatus = response.status;
      if (response.ok) {
        let body: Record<string, unknown>;
        try {
          body = (await response.json()) as Record<string, unknown>;
        } catch {
          logJevFailedAttempt({
            route: "gateway",
            attempt,
            status: response.status,
            errorCode: "jev_gateway_unparseable",
          });
          throw new JevEgressError("JEV gateway returned an unparseable JSON response.", "jev_gateway_unparseable");
        }
        const parsed = parseJevResponse(body.json);
        if (!parsed) {
          logJevFailedAttempt({
            route: "gateway",
            attempt,
            status: response.status,
            errorCode: "jev_gateway_malformed",
          });
          throw new JevEgressError("JEV gateway returned a malformed answer envelope.", "jev_gateway_malformed");
        }
        const inputTokens = Number(body.inputTokens ?? parsed.usage.input_tokens ?? 0) || 0;
        const outputTokens = Number(body.outputTokens ?? parsed.usage.output_tokens ?? 0) || 0;
        return {
          response: parsed,
          transport: "ai_hub_gateway",
          provider: normalizeLlmProvider(body.provider ?? JEV_PROVIDER),
          inputTokens,
          outputTokens,
          estimatedCostUsd: Number(body.estimatedCostUsd ?? 0) || 0,
        };
      }
      logJevFailedAttempt({
        route: "gateway",
        attempt,
        status: response.status,
        errorCode: "jev_gateway_returned_error",
      });
      if (!JEV_RETRYABLE_STATUSES.has(response.status) || attempt === JEV_RETRY_ATTEMPTS - 1) break;
      await sleep(retryDelayMs(attempt));
    }
    throw new JevEgressError(
      `JEV gateway returned ${lastStatus || "no response"}.`,
      "jev_gateway_returned_error",
      lastStatus,
    );
  }

  // Direct TypeSafe lane — reachable in staging when the staging resolver selects it, or outside
  // staging via the explicit `FLU_JEV_MODE=direct` + `FLU_JEV_ENABLED` opt-in. Never an implicit
  // fallback: direct credentials alone do not enable production JEV.
  // Staging uses ONLY the staging-scoped credential; the shared JEV_API_KEY/TYPESAFE_API_KEY
  // plaintext secrets are never read in the staging runtime.
  const apiKey = isStagingSafetyRuntime()
    ? process.env.FLU_STAGING_JEV_API_KEY?.trim() || ""
    : process.env.JEV_API_KEY?.trim() || process.env.TYPESAFE_API_KEY?.trim() || "";
  if (!apiKey) {
    throw new JevEgressError(
      "JEV_API_KEY is not configured; direct TypeSafe egress is unavailable.",
      "jev_api_key_missing",
    );
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: apiKey.toLowerCase().startsWith("bearer ") ? apiKey : `Bearer ${apiKey}`,
  };
  let lastStatus = 0;
  for (let attempt = 0; attempt < JEV_RETRY_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await postJson(jevEndpoint(), headers, request);
    } catch {
      logJevFailedAttempt({
        route: "direct",
        attempt,
        status: 0,
        errorCode: "jev_direct_call_err",
      });
      if (attempt === JEV_RETRY_ATTEMPTS - 1) {
        throw new JevEgressError("TypeSafe direct call failed.", "jev_direct_call_err");
      }
      await sleep(retryDelayMs(attempt));
      continue;
    }
    lastStatus = response.status;
    if (response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        logJevFailedAttempt({
          route: "direct",
          attempt,
          status: response.status,
          errorCode: "jev_direct_unparseable",
        });
        throw new JevEgressError("TypeSafe returned an unparseable JSON response.", "jev_direct_unparseable");
      }
      const parsed = parseJevResponse(body);
      if (!parsed) {
        logJevFailedAttempt({
          route: "direct",
          attempt,
          status: response.status,
          errorCode: "jev_direct_malformed",
        });
        throw new JevEgressError("TypeSafe returned a malformed answer envelope.", "jev_direct_malformed");
      }
      const inputTokens = Number(parsed.usage.input_tokens);
      const safeInputTokens = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
      return {
        response: parsed,
        transport: "typesafe_direct",
        provider: JEV_PROVIDER,
        inputTokens: parsed.usage.input_tokens,
        outputTokens: parsed.usage.output_tokens,
        // Input-only estimate: output is free under TypeSafe's published JEV pricing.
        estimatedCostUsd: (safeInputTokens * JEV_INPUT_USD_PER_MILLION) / 1_000_000,
      };
    }
    logJevFailedAttempt({
      route: "direct",
      attempt,
      status: response.status,
      errorCode: "jev_direct_returned_error",
    });
    if (!JEV_RETRYABLE_STATUSES.has(response.status) || attempt === JEV_RETRY_ATTEMPTS - 1) break;
    await sleep(retryDelayMs(attempt));
  }
  throw new JevEgressError(
    `TypeSafe returned ${lastStatus || "no response"}.`,
    "jev_direct_returned_error",
    lastStatus,
  );
};
