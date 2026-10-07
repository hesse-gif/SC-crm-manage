import { reportLlmUsage } from "../aiHubReport";
import { callModel } from "../vertex";
import {
  jevEndpoint,
  jevGatewayEndpoint,
  resolveJevEgressRoute,
  type JevEgressRoute,
  type JevTransport,
  type JevTransportName,
  type JevTransportResult,
} from "../modelProviders/jev";
import { cacheableJevResult, JEV_CACHE_TTL_MS, jevCacheKey } from "./jevCache";
import type { JevCacheScope, JevCacheStore } from "./jevCache";
import { JEV_MODEL_ID, type JevRequest } from "./jevTypes";

export * from "../modelProviders/jev";

export type JevCallOptions = { cacheScope?: JevCacheScope; cacheStore?: JevCacheStore; bypassCache?: boolean; now?: () => number };

type JevCacheEntry = { version: 1; route: JevEgressRoute; expiresAtMs: number; payload: JevTransportResult };

const defaultJevCacheStore: JevCacheStore = {
  async get(key) {
    const { adminDb } = await import("../firebaseAdmin");
    return (await adminDb.collection("jev_decision_cache").doc(key).get()).data();
  },
  async set(key, value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const { adminDb } = await import("../firebaseAdmin");
    await adminDb.collection("jev_decision_cache").doc(key).set(value as Record<string, unknown>);
  },
};

function isJevCacheEntry(value: unknown): value is JevCacheEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return entry.version === 1 && (entry.route === "gateway" || entry.route === "direct") &&
    typeof entry.expiresAtMs === "number" && !!entry.payload && typeof entry.payload === "object";
}

export const httpJevTransport: JevTransport = (request, route) =>
  callModel({ provider: "typesafe", request, route });

export async function callJev(
  request: JevRequest,
  transport: JevTransport = httpJevTransport,
  options: JevCallOptions = {},
): Promise<JevTransportResult> {
  const route = resolveJevEgressRoute();
  const now = options.now ?? Date.now;
  const cacheStore = options.cacheStore ?? defaultJevCacheStore;
  const cacheKey =
    !options.bypassCache && options.cacheScope
      ? jevCacheKey(
          request,
          route,
          route === "gateway" ? jevGatewayEndpoint() : jevEndpoint(),
          options.cacheScope,
        )
      : "";

  if (cacheKey) {
    try {
      const entry = await cacheStore.get(cacheKey);
      if (isJevCacheEntry(entry)) {
        const payload = cacheableJevResult(request, entry.payload);
        const expectedTransport: JevTransportName =
          route === "gateway" ? "ai_hub_gateway" : "typesafe_direct";
        if (
          Number.isFinite(entry.expiresAtMs) &&
          entry.expiresAtMs > now() &&
          entry.route === route &&
          entry.payload.transport === expectedTransport &&
          payload
        ) {
          const hit = { ...payload, cacheHit: true };
          try {
            await reportLlmUsage({ modelId: hit.response.model || JEV_MODEL_ID, provider: hit.provider, transport: "cache", inputTokens: 0, outputTokens: 0, totalCostUsd: 0 });
          } catch {
            // Monitoring must not break the decision path.
          }
          return hit;
        }
      }
    } catch {
      // Cache lookup failure is a miss.
    }
  }

  const result = { ...(await transport(request, route)), cacheHit: false };
  if (cacheKey) {
    const normalized = cacheableJevResult(request, result);
    if (normalized) {
      try {
        await cacheStore.set(cacheKey, { version: 1, route, expiresAtMs: now() + JEV_CACHE_TTL_MS, payload: normalized } satisfies JevCacheEntry);
      } catch {
        // Cache writes are best-effort and must never gate the decision.
      }
    }
  }
  // COST-P0: token/usage log on every real call. Fire-and-forget; never gates the decision.
  try {
    await reportLlmUsage({
      modelId: result.response.model || JEV_MODEL_ID,
      provider: result.provider,
      transport: result.transport,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalCostUsd: result.estimatedCostUsd,
    });
  } catch {
    // Monitoring must not break the decision path; failures are already canonical-coded upstream.
  }
  return result;
}
