import { adminDb } from "./firebaseAdmin";
import { asRecord, asString } from "./shared";
import { isStagingRuntime } from "./runtimeEnvironment";
import { resolveStagingLlmMode, resolveStagingYoutubeMode } from "./stagingSafety";

export type IntegrationKey = "mailSmtp" | "mailImap" | "gateway" | "externalApi" | "aiHub";

export type RuntimeIntegration = {
  key: IntegrationKey;
  public: Record<string, unknown>;
  secrets: Record<string, unknown>;
};

// 라이브 전환은 feature 단위 게이트 (티코 승인 완료, influchat-77db6 Blaze).
// 에뮬레이터(로컬)는 항상 mock 유지. 켜진 feature만 live 어댑터를 탄다.
// gateway(AI 모델 호출)=SEC-P0-005 내부 Gateway 엔드포인트 확보 전까지 OFF.
// email(파인더)/revi=크레덴셜 미확보로 OFF. → youtube/smtp/imap/aihub만 라이브.
const LIVE_FEATURES = new Set(["youtube", "smtp", "imap", "aihub", "gateway", "email", "community"]);
export function liveIntegrationsEnabled(feature?: string): boolean {
  if (process.env.FUNCTIONS_EMULATOR === "true") return false;
  if (isStagingRuntime()) {
    if (feature === "youtube") return resolveStagingYoutubeMode() === "live-e2e";
    if (feature === "gateway") {
      const llmMode = resolveStagingLlmMode();
      return llmMode === "vertex"
        || (llmMode === "aihub" && Boolean(process.env.AI_HUB_GATEWAY_URL?.trim()));
    }
    if (feature === "aihub") {
      // Generic AI Hub integrations include fine-tune and reporting surfaces.
      // Staging may route the model chokepoint through AI Hub via `gateway`,
      // but must never enable the broader integration family.
      return false;
    }
    // Staging must never inherit production mail, community, finder, or generic
    // external-API switches merely because their credentials exist project-wide.
    return false;
  }
  return feature ? LIVE_FEATURES.has(feature) : LIVE_FEATURES.size > 0;
}

export async function getRuntimeIntegration(key: IntegrationKey): Promise<RuntimeIntegration> {
  const snapshot = await adminDb.collection("integrations").doc("default").get();
  const root = snapshot.exists ? asRecord(snapshot.data()) : {};
  const stored = asRecord(root[key]);
  return {
    key,
    public: asRecord(stored.public),
    secrets: asRecord(stored.secrets),
  };
}

export function publicString(config: RuntimeIntegration, field: string, envName: string, fallback = ""): string {
  return asString(config.public[field], process.env[envName] ?? fallback);
}

export function publicNumber(config: RuntimeIntegration, field: string, envName: string, fallback: number): number {
  const value = config.public[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  const envValue = process.env[envName];
  if (envValue && Number.isFinite(Number(envValue))) return Number(envValue);
  return fallback;
}

export function publicBoolean(config: RuntimeIntegration, field: string, envName: string, fallback: boolean): boolean {
  const value = config.public[field];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true" || value === "1";
  const envValue = process.env[envName];
  if (envValue) return envValue.toLowerCase() === "true" || envValue === "1";
  return fallback;
}

export function envSecret(envName: string): string {
  return process.env[envName]?.trim() ?? "";
}

export function secretReady(config: RuntimeIntegration, field: string, envName: string): boolean {
  return envSecret(envName).length > 0 || asString(asRecord(config.secrets[field]).fingerprint).length > 0;
}

export function requireEnvSecret(envName: string, label: string): string {
  const value = envSecret(envName);
  if (!value) {
    const error = new Error(`${label} secret is not configured. Set ${envName} in Functions environment/Secret Manager.`);
    Object.assign(error, { code: "failed-precondition", errorCode: "require_env_secret_secret_configured_set_in_functions" });
    throw error;
  }
  return value;
}

export function authHeader(apiKey: string): Record<string, string> {
  if (!apiKey) return {};
  return apiKey.toLowerCase().startsWith("bearer ") ? { Authorization: apiKey } : { Authorization: `Bearer ${apiKey}` };
}

export function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") return undefined;
  return AbortSignal.timeout(Math.max(1000, timeoutMs));
}
