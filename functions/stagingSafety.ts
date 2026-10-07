import {
  isStagingRuntime,
  resolveRuntimeEnvironment,
  type RuntimeEnvironmentSource,
} from "./runtimeEnvironment";

export type StagingExternalSideEffect =
  | "smtp"
  | "imap"
  | "sheets-write"
  | "appsflyer"
  | "community-write"
  | "storage-default"
  // PLAN-ORG-MAIL-IDENTITY Slice 2: Google OAuth token exchange/refresh/revoke calls
  // (functions/mailOAuth.ts) — hosted staging may reach this lane only with the exact
  // FLU_STAGING_MAIL_OAUTH_MODE=live-e2e opt-in; SMTP/IMAP remain independently blocked.
  | "oauth";

export type StagingLlmMode = "disabled" | "aihub" | "vertex";
// TypeSafe/JEV is a distinct external AI egress lane with its own endpoint + credential, so it gets its
// own staging switch rather than riding on FLU_STAGING_LLM_MODE. `gateway` = via internal AI Hub gateway
// (SEC-P0-005 preferred), `direct` = straight to api.typesafe.ai (explicit opt-in only).
export type StagingJevMode = "disabled" | "gateway" | "direct";
export type StagingYoutubeMode = "disabled" | "live-e2e";
// OAuth is an explicit staging capability lane. Keeping it separate from the
// broad liveIntegrationsEnabled switch means a consent/token exchange can be
// exercised without enabling SMTP/IMAP delivery or any scheduler.
export type StagingMailOAuthMode = "disabled" | "live-e2e";

export const STAGING_YOUTUBE_MAX_RESULTS = 5;
export const STAGING_YOUTUBE_MAX_PAGES = 1;
export const STAGING_YOUTUBE_DAILY_UNIT_CAP = 250;

export type StagingSafetySource = RuntimeEnvironmentSource & {
  FLU_STAGING_LLM_MODE?: string;
  FLU_STAGING_JEV_MODE?: string;
  FLU_STAGING_UPLOAD_BUCKET?: string;
  FLU_STAGING_YOUTUBE_MODE?: string;
  FLU_STAGING_MAIL_OAUTH_MODE?: string;
};

export function isStagingSafetyRuntime(source: StagingSafetySource = process.env): boolean {
  return source === process.env
    ? isStagingRuntime()
    : resolveRuntimeEnvironment(source).runtimeEnvironment === "staging";
}

export function assertStagingExternalSideEffectAllowed(
  effect: StagingExternalSideEffect,
  source: StagingSafetySource = process.env,
): void {
  if (!isStagingSafetyRuntime(source)) return;
  if (effect === "oauth" && resolveStagingMailOAuthMode(source) === "live-e2e") return;
  throw failedPrecondition(`${externalEffectLabel(effect)} is disabled in the staging runtime.`);
}

/**
 * Google OAuth is the only external side-effect lane that staging may opt into.
 * The default remains disabled, and the exact value is intentionally shared by
 * deployment/runtime guards so a broad truthy env value cannot unlock it.
 */
export function resolveStagingMailOAuthMode(
  source: StagingSafetySource = process.env,
): StagingMailOAuthMode {
  if (!isStagingSafetyRuntime(source)) return "disabled";
  const configured = source.FLU_STAGING_MAIL_OAUTH_MODE;
  if (configured === undefined || configured === "" || configured === "disabled") {
    return "disabled";
  }
  if (configured === "live-e2e") return configured;
  throw failedPrecondition(
    `FLU_STAGING_MAIL_OAUTH_MODE must be exactly "disabled" or "live-e2e" in staging; received ${JSON.stringify(configured)}.`,
  );
}

export function resolveStagingLlmMode(source: StagingSafetySource = process.env): StagingLlmMode {
  if (!isStagingSafetyRuntime(source)) return "disabled";
  const configured = source.FLU_STAGING_LLM_MODE;
  if (configured === undefined || configured === "") return "disabled";
  if (configured === "aihub" || configured === "vertex") return configured;
  throw failedPrecondition(
    `FLU_STAGING_LLM_MODE must be exactly "aihub" or "vertex" in staging; received ${JSON.stringify(configured)}.`,
  );
}

export function assertStagingLlmEgressAllowed(
  route: Exclude<StagingLlmMode, "disabled">,
  source: StagingSafetySource = process.env,
): void {
  if (!isStagingSafetyRuntime(source)) return;
  const configured = resolveStagingLlmMode(source);
  if (configured === route) return;
  throw failedPrecondition(
    `Staging LLM egress through ${route} is disabled; set FLU_STAGING_LLM_MODE=${route} explicitly to allow this route.`,
  );
}

/**
 * TypeSafe/JEV egress is disabled in staging unless FLU_STAGING_JEV_MODE names the exact route.
 * Mirrors resolveStagingLlmMode: an unknown value is a hard failure, never a silent default.
 */
export function resolveStagingJevMode(
  source: StagingSafetySource = process.env,
): StagingJevMode {
  if (!isStagingSafetyRuntime(source)) return "disabled";
  const configured = source.FLU_STAGING_JEV_MODE;
  if (configured === undefined || configured === "" || configured === "disabled") {
    return "disabled";
  }
  if (configured === "gateway" || configured === "direct") return configured;
  throw failedPrecondition(
    `FLU_STAGING_JEV_MODE must be exactly "disabled", "gateway", or "direct" in staging; received ${JSON.stringify(configured)}.`,
  );
}

export function assertStagingJevEgressAllowed(
  route: Exclude<StagingJevMode, "disabled">,
  source: StagingSafetySource = process.env,
): void {
  if (!isStagingSafetyRuntime(source)) return;
  const configured = resolveStagingJevMode(source);
  if (configured === route) return;
  throw failedPrecondition(
    `Staging JEV egress through ${route} is disabled; set FLU_STAGING_JEV_MODE=${route} explicitly to allow this route.`,
  );
}

export function resolveStagingYoutubeMode(
  source: StagingSafetySource = process.env,
): StagingYoutubeMode {
  if (!isStagingSafetyRuntime(source)) return "disabled";
  const configured = source.FLU_STAGING_YOUTUBE_MODE;
  if (configured === undefined || configured === "" || configured === "disabled") {
    return "disabled";
  }
  if (configured === "live-e2e") return configured;
  throw failedPrecondition(
    `FLU_STAGING_YOUTUBE_MODE must be exactly "disabled" or "live-e2e" in staging; received ${JSON.stringify(configured)}.`,
  );
}

export function assertStagingYoutubeLiveEgressAllowed(
  source: StagingSafetySource = process.env,
): void {
  if (!isStagingSafetyRuntime(source)) return;
  if (resolveStagingYoutubeMode(source) === "live-e2e") return;
  throw failedPrecondition(
    "Staging YouTube egress is disabled; set FLU_STAGING_YOUTUBE_MODE=live-e2e explicitly to allow the bounded real-engine lane.",
  );
}

export function submissionUploadObjectPrefix(source: StagingSafetySource = process.env): string {
  return isStagingSafetyRuntime(source) ? "staging/scp-submissions/" : "scp-submissions/";
}

export function resolveStagingUploadBucket(source: StagingSafetySource = process.env): string {
  const candidate = source.FLU_STAGING_UPLOAD_BUCKET?.trim().toLowerCase() ?? "";
  if (!candidate || !validStorageBucketName(candidate)) {
    throw failedPrecondition(
      "FLU_STAGING_UPLOAD_BUCKET must name an explicit valid staging-only Storage bucket; default bucket selection is disabled in staging.",
    );
  }
  return candidate;
}

function externalEffectLabel(effect: StagingExternalSideEffect): string {
  switch (effect) {
    case "smtp": return "SMTP delivery";
    case "imap": return "IMAP ingestion";
    case "sheets-write": return "Google Sheet writes";
    case "appsflyer": return "AppsFlyer API calls";
    case "community-write": return "community writes";
    case "storage-default": return "default Storage bucket selection";
    case "oauth": return "Google OAuth token exchange";
  }
}

function validStorageBucketName(value: string): boolean {
  return value.length >= 3
    && value.length <= 222
    && /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(value)
    && !value.includes("..")
    && !value.startsWith("goog");
}

function failedPrecondition(message: string): Error {
  return Object.assign(new Error(message), { code: "failed-precondition", errorCode: "failed_precondition_unauthorized" });
}
