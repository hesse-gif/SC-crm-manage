/**
 * One-shot, staging-only side-channel for a Firebase Auth permission denial.
 * It deliberately does not influence the Auth result or return data to callers.
 */
import type { Credential } from "firebase-admin/app";

export const STAGING_AUTH_LOOKUP_PROJECT_ID = "influchat-77db6" as const;
export const STAGING_AUTH_LOOKUP_TENANT_ID = "FLU-Staging-arla5" as const;
const PROBE_ENV = "FLU_STAGING_AUTH_LOOKUP_PERMISSION_PROBE";
const MAX_RESPONSE_BYTES = 8 * 1024;
const PROBE_TIMEOUT_MS = 2_000;

export type StagingTenantAuthLookupPermissionProbe = {
  readonly attempt: "not_attempted" | "attempted";
  readonly outcome: "not_attempted" | "http_response" | "timeout" | "credential_error" | "network_error" | "invalid_response";
  readonly credentialSource: "not_used" | "admin_app";
  readonly httpStatus: "not_attempted" | "200" | "400" | "401" | "403" | "404" | "429" | "500" | "503" | "other";
  readonly googleStatus: "not_attempted" | "PERMISSION_DENIED" | "UNAUTHENTICATED" | "INVALID_ARGUMENT" | "NOT_FOUND" | "FAILED_PRECONDITION" | "RESOURCE_EXHAUSTED" | "INTERNAL" | "UNAVAILABLE" | "unknown";
  readonly providerReason: "not_attempted" | "IAM_PERMISSION_DENIED" | "USER_PROJECT_DENIED" | "SERVICE_DISABLED" | "CONSUMER_INVALID" | "ACCESS_TOKEN_SCOPE_INSUFFICIENT" | "unknown";
  readonly providerReasonSource: "not_attempted" | "structured" | "message_hint" | "unknown";
  readonly permissionHint: "not_attempted" | "firebaseauth.users.get" | "firebaseauth.configs.get" | "identitytoolkit.tenants.get" | "serviceusage.services.use" | "resourcemanager.projects.get" | "unknown";
};

type ProbeCredential = Pick<Credential, "getAccessToken">;
type ProbeResponse = Pick<Response, "ok" | "status" | "body">;
type ProbeFetch = (input: string, init: RequestInit) => Promise<ProbeResponse>;
type ProbeEnvironment = Record<string, string | undefined>;

export type StagingTenantAuthLookupPermissionProbeInput = {
  readonly uid: string;
  readonly activeTenantId: string | null;
  readonly activeApp: { readonly options: { readonly credential?: ProbeCredential } };
  readonly environment: ProbeEnvironment;
  readonly runtimeEnvironment: "production" | "staging" | "emulator";
};

export type StagingTenantAuthLookupPermissionProbeDependencies = {
  readonly fetch?: ProbeFetch;
  /** Test-only override; production callers never supply it. */
  readonly timeoutMs?: number;
};

const NOT_ATTEMPTED: StagingTenantAuthLookupPermissionProbe = Object.freeze({
  attempt: "not_attempted", outcome: "not_attempted", credentialSource: "not_used", httpStatus: "not_attempted",
  googleStatus: "not_attempted", providerReason: "not_attempted", providerReasonSource: "not_attempted", permissionHint: "not_attempted",
});
let probeStarted = false;

function result(overrides: Partial<StagingTenantAuthLookupPermissionProbe>): StagingTenantAuthLookupPermissionProbe {
  return { ...NOT_ATTEMPTED, attempt: "attempted", credentialSource: "admin_app", ...overrides };
}

function validUid(uid: string): boolean {
  return typeof uid === "string" && uid.length > 0 && uid.length <= 128 && !/[\u0000-\u001f\u007f]/.test(uid);
}

function eligible(input: StagingTenantAuthLookupPermissionProbeInput): boolean {
  const projectIds = [input.activeApp.options as { projectId?: unknown }, input.environment].flatMap((source) => [
    typeof source.projectId === "string" ? source.projectId : undefined,
    typeof (source as ProbeEnvironment).GCLOUD_PROJECT === "string" ? (source as ProbeEnvironment).GCLOUD_PROJECT : undefined,
    typeof (source as ProbeEnvironment).GOOGLE_CLOUD_PROJECT === "string" ? (source as ProbeEnvironment).GOOGLE_CLOUD_PROJECT : undefined,
  ]).filter((value): value is string => Boolean(value));
  return input.environment[PROBE_ENV] === "enabled"
    && input.runtimeEnvironment === "staging"
    && input.activeTenantId === STAGING_AUTH_LOOKUP_TENANT_ID
    && projectIds.length > 0 && projectIds.every((projectId) => projectId === STAGING_AUTH_LOOKUP_PROJECT_ID)
    && validUid(input.uid)
    && typeof input.activeApp.options.credential?.getAccessToken === "function";
}

function status(value: number): StagingTenantAuthLookupPermissionProbe["httpStatus"] {
  return value === 200 || value === 400 || value === 401 || value === 403 || value === 404 || value === 429 || value === 500 || value === 503 ? String(value) as StagingTenantAuthLookupPermissionProbe["httpStatus"] : "other";
}
const GOOGLE_STATUSES = new Set<StagingTenantAuthLookupPermissionProbe["googleStatus"]>(["PERMISSION_DENIED", "UNAUTHENTICATED", "INVALID_ARGUMENT", "NOT_FOUND", "FAILED_PRECONDITION", "RESOURCE_EXHAUSTED", "INTERNAL", "UNAVAILABLE"]);
const PROVIDER_REASONS = new Set<StagingTenantAuthLookupPermissionProbe["providerReason"]>(["IAM_PERMISSION_DENIED", "USER_PROJECT_DENIED", "SERVICE_DISABLED", "CONSUMER_INVALID", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"]);
const PERMISSIONS = new Set<Exclude<StagingTenantAuthLookupPermissionProbe["permissionHint"], "not_attempted" | "unknown">>(["firebaseauth.users.get", "firebaseauth.configs.get", "identitytoolkit.tenants.get", "serviceusage.services.use", "resourcemanager.projects.get"]);

async function discard(response: ProbeResponse): Promise<void> {
  try { await response.body?.cancel(); } catch { /* intentionally ignored */ }
}

async function boundedJson(response: ProbeResponse, signal: AbortSignal): Promise<{ value: Record<string, unknown> | null; state: "ok" | "malformed" | "oversized" | "timeout" }> {
  const reader = response.body?.getReader();
  if (!reader) return { value: null, state: "malformed" };
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const next = await Promise.race([
        reader.read().then((value) => ({ kind: "read" as const, value }), () => ({ kind: "failed" as const })),
        new Promise<{ kind: "timeout" }>((resolve) => signal.addEventListener("abort", () => resolve({ kind: "timeout" }), { once: true })),
      ]);
      if (next.kind === "timeout") { void reader.cancel().catch(() => undefined); return { value: null, state: "timeout" }; }
      if (next.kind === "failed") return { value: null, state: "malformed" };
      const chunk = next.value;
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) { void reader.cancel().catch(() => undefined); return { value: null, state: "oversized" }; }
      chunks.push(chunk.value);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { value: parsed as Record<string, unknown>, state: "ok" } : { value: null, state: "malformed" };
  } catch { return { value: null, state: "malformed" }; }
  finally { void reader.cancel().catch(() => undefined); }
}

function mappedError(value: Record<string, unknown>): Pick<StagingTenantAuthLookupPermissionProbe, "googleStatus" | "providerReason" | "providerReasonSource" | "permissionHint"> {
  const error = value.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return { googleStatus: "unknown", providerReason: "unknown", providerReasonSource: "unknown", permissionHint: "unknown" };
  const record = error as Record<string, unknown>;
  const googleStatus = typeof record.status === "string" && GOOGLE_STATUSES.has(record.status as StagingTenantAuthLookupPermissionProbe["googleStatus"]) ? record.status as StagingTenantAuthLookupPermissionProbe["googleStatus"] : "unknown";
  let providerReason: StagingTenantAuthLookupPermissionProbe["providerReason"] = "unknown";
  let providerReasonSource: StagingTenantAuthLookupPermissionProbe["providerReasonSource"] = "unknown";
  let permissionHint: StagingTenantAuthLookupPermissionProbe["permissionHint"] = "unknown";
  const details = Array.isArray(record.details) ? record.details : [];
  for (const detail of details) {
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) continue;
    const item = detail as Record<string, unknown>;
    if (item["@type"] !== "type.googleapis.com/google.rpc.ErrorInfo") continue;
    if (typeof item.reason === "string" && PROVIDER_REASONS.has(item.reason as StagingTenantAuthLookupPermissionProbe["providerReason"])) { providerReason = item.reason as StagingTenantAuthLookupPermissionProbe["providerReason"]; providerReasonSource = "structured"; }
    const metadata = item.metadata;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && typeof (metadata as Record<string, unknown>).permission === "string" && PERMISSIONS.has((metadata as Record<string, unknown>).permission as Exclude<StagingTenantAuthLookupPermissionProbe["permissionHint"], "not_attempted" | "unknown">)) permissionHint = (metadata as Record<string, unknown>).permission as StagingTenantAuthLookupPermissionProbe["permissionHint"];
  }
  if (providerReason === "unknown" && typeof record.message === "string" && PROVIDER_REASONS.has(record.message as StagingTenantAuthLookupPermissionProbe["providerReason"])) { providerReason = record.message as StagingTenantAuthLookupPermissionProbe["providerReason"]; providerReasonSource = "message_hint"; }
  return { googleStatus, providerReason, providerReasonSource, permissionHint };
}

export async function maybeProbeStagingTenantAuthLookupPermission(input: StagingTenantAuthLookupPermissionProbeInput, dependencies: StagingTenantAuthLookupPermissionProbeDependencies = {}): Promise<StagingTenantAuthLookupPermissionProbe> {
  if (!eligible(input) || probeStarted) return NOT_ATTEMPTED;
  probeStarted = true; // Set before any asynchronous operation: concurrent failures never retry.
  const controller = new AbortController();
  const timeoutMs = dependencies.timeoutMs ?? PROBE_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const credential = input.activeApp.options.credential!;
    const credentialResult = await Promise.race([
      credential.getAccessToken().then((value) => ({ kind: "value" as const, value }), () => ({ kind: "error" as const })),
      new Promise<{ kind: "timeout" }>((resolve) => controller.signal.addEventListener("abort", () => resolve({ kind: "timeout" }), { once: true })),
    ]);
    if (credentialResult.kind === "timeout" || timedOut) return result({ outcome: "timeout", httpStatus: "other", googleStatus: "unknown", providerReason: "unknown", providerReasonSource: "unknown", permissionHint: "unknown" });
    if (credentialResult.kind === "error" || !credentialResult.value.access_token) return result({ outcome: "credential_error", httpStatus: "other", googleStatus: "unknown", providerReason: "unknown", providerReasonSource: "unknown", permissionHint: "unknown" });
    const fetcher = dependencies.fetch ?? (globalThis.fetch as ProbeFetch | undefined);
    if (!fetcher) return result({ outcome: "network_error", httpStatus: "other", googleStatus: "unknown", providerReason: "unknown", providerReasonSource: "unknown", permissionHint: "unknown" });
    const fetchResult = await Promise.race([
      fetcher(`https://identitytoolkit.googleapis.com/v1/projects/${STAGING_AUTH_LOOKUP_PROJECT_ID}/tenants/${STAGING_AUTH_LOOKUP_TENANT_ID}/accounts:lookup`, { method: "POST", signal: controller.signal, headers: { Authorization: `Bearer ${credentialResult.value.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ localId: [input.uid] }) }).then(
        (response) => { if (controller.signal.aborted) void discard(response); return { kind: "response" as const, response }; },
        () => ({ kind: "failed" as const }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => controller.signal.addEventListener("abort", () => resolve({ kind: "timeout" }), { once: true })),
    ]);
    if (fetchResult.kind === "timeout" || timedOut) return result({ outcome: "timeout", httpStatus: "other", googleStatus: "unknown", providerReason: "unknown", providerReasonSource: "unknown", permissionHint: "unknown" });
    if (fetchResult.kind === "failed") return result({ outcome: "network_error", httpStatus: "other", googleStatus: "unknown", providerReason: "unknown", providerReasonSource: "unknown", permissionHint: "unknown" });
    const response = fetchResult.response;
    if (timedOut) { void discard(response); return result({ outcome: "timeout", httpStatus: "other", googleStatus: "unknown", providerReason: "unknown", providerReasonSource: "unknown", permissionHint: "unknown" }); }
    if (response.ok) { void discard(response); return result({ outcome: "http_response", httpStatus: status(response.status), googleStatus: "unknown", providerReason: "unknown", providerReasonSource: "unknown", permissionHint: "unknown" }); }
    const body = await boundedJson(response, controller.signal);
    if (timedOut || body.state === "timeout") return result({ outcome: "timeout", httpStatus: "other", googleStatus: "unknown", providerReason: "unknown", providerReasonSource: "unknown", permissionHint: "unknown" });
    if (!body.value) return result({ outcome: "invalid_response", httpStatus: status(response.status), googleStatus: "unknown", providerReason: "unknown", providerReasonSource: "unknown", permissionHint: "unknown" });
    return result({ outcome: "http_response", httpStatus: status(response.status), ...mappedError(body.value) });
  } catch {
    return result({ outcome: timedOut ? "timeout" : "network_error", httpStatus: "other", googleStatus: "unknown", providerReason: "unknown", providerReasonSource: "unknown", permissionHint: "unknown" });
  } finally { clearTimeout(timer); }
}

/** Test-only reset for process-latch coverage. */
export function __resetStagingTenantAuthLookupPermissionProbeForTests(): void { probeStarted = false; }
