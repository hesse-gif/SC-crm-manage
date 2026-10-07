import { createHash } from "node:crypto";
import type { ExactWindowMetricProvider, ExactWindowMetricUnavailable } from "./videoPerformanceObservationStore";

export const YOUTUBE_EXACT_168H_READINESS_SCHEMA_VERSION = "youtube.exact168h.readiness.v1" as const;
export const YOUTUBE_EXACT_168H_OFFICIAL_DOCS = [
  "https://developers.google.com/youtube/v3/docs/videos#statistics.viewCount",
  "https://developers.google.com/youtube/analytics/reference/reports/query#parameters",
  "https://developers.google.com/youtube/analytics/dimensions#time-periods",
] as const;

export type YouTubeExact168hBlockerCode =
  | "youtube_api_key_missing"
  | "youtube_analytics_oauth_missing"
  | "youtube_current_cumulative_not_exact_window"
  | "youtube_analytics_daily_not_exact_window"
  | "youtube_exact_boundary_source_unavailable";

export type YouTubeExact168hCredentialHealth = Readonly<{
  youtubeDataApiKeyConfigured: boolean;
  youtubeAnalyticsOAuthClientConfigured: boolean;
  youtubeOAuthCredentialEncryptionConfigured: boolean;
  youtubeAnalyticsCredentialExternalState: "not_inspected" | "unavailable" | "available_unverified";
}>;

export type YouTubeExact168hReadinessReceipt = Readonly<{
  schemaVersion: typeof YOUTUBE_EXACT_168H_READINESS_SCHEMA_VERSION;
  receiptId: string;
  exact168hOperational: false;
  source: "youtube_data_api" | "youtube_analytics" | "youtube_exact_window_provider";
  sourceCapability: "current_cumulative" | "daily_owner_analytics";
  sourceProvesExactBoundary: false;
  metricKey: string;
  youtubeVideoId: string;
  measurementStartAt: string;
  measurementEndExclusive: string;
  assessedAtIso: string;
  createdAtIso: string;
  credentialHealth: YouTubeExact168hCredentialHealth;
  blockerCodes: YouTubeExact168hBlockerCode[];
  missingProof: string[];
  officialDocs: readonly string[];
}>;

export type YouTubeExact168hReadinessInput = Readonly<{
  metricKey: string;
  youtubeVideoId: string;
  measurementStartAt: string;
  measurementEndExclusive: string;
  now?: Date;
  env?: Record<string, string | undefined>;
  /** Flu/Task-49: which secret env names to check. Defaults to growth's — see credentialHealth. */
  credentialNames?: YouTubeExact168hCredentialNames;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function configured(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

// Flu/Task-49: which env names count as "configured" for this readiness check. Defaults to
// growth's names (unchanged behavior for every existing caller, which never passes this). A
// future pool-aware caller can pass e.g. { apiKeyNames: ["YOUTUBE_POOL_DRAMA_1_API_KEY"],
// oauthClientIdName: "YOUTUBE_POOL_DRAMA_1_OAUTH_CLIENT_ID", oauthClientSecretName:
// "YOUTUBE_POOL_DRAMA_1_OAUTH_CLIENT_SECRET" } to assess a non-growth pool's readiness instead.
export type YouTubeExact168hCredentialNames = Readonly<{
  apiKeyNames: readonly string[];
  oauthClientIdName: string;
  oauthClientSecretName: string;
}>;

const DEFAULT_GROWTH_CREDENTIAL_NAMES: YouTubeExact168hCredentialNames = {
  apiKeyNames: ["YOUTUBE_API_KEY", "YOUTUBE_API_KEY_FALLBACK_1"],
  oauthClientIdName: "GOOGLE_OAUTH_CLIENT_ID",
  oauthClientSecretName: "GOOGLE_OAUTH_CLIENT_SECRET",
};

function credentialHealth(
  env: Record<string, string | undefined>,
  credentialNames: YouTubeExact168hCredentialNames = DEFAULT_GROWTH_CREDENTIAL_NAMES,
): YouTubeExact168hCredentialHealth {
  const youtubeAnalyticsOAuthClientConfigured = configured(env[credentialNames.oauthClientIdName]) && configured(env[credentialNames.oauthClientSecretName]);
  return {
    youtubeDataApiKeyConfigured: credentialNames.apiKeyNames.some((name) => configured(env[name])),
    youtubeAnalyticsOAuthClientConfigured,
    youtubeOAuthCredentialEncryptionConfigured: configured(env.YOUTUBE_OAUTH_CREDENTIAL_ENCRYPTION_KEY),
    // This readiness model deliberately does not decrypt creator OAuth rows or inspect Firestore from inside
    // a measurement finalization transaction. The exact 168h proof remains unavailable until an external
    // operational path can prove an instant-level cutoff source, not merely that credentials exist.
    youtubeAnalyticsCredentialExternalState: youtubeAnalyticsOAuthClientConfigured ? "available_unverified" : "not_inspected",
  };
}

export function assessYouTubeExact168hOperationalReadiness(
  input: YouTubeExact168hReadinessInput,
): YouTubeExact168hReadinessReceipt {
  const env = input.env ?? process.env;
  const assessedAtIso = (input.now ?? new Date()).toISOString();
  const health = credentialHealth(env, input.credentialNames);
  const blockerCodes: YouTubeExact168hBlockerCode[] = [];
  if (!health.youtubeDataApiKeyConfigured) blockerCodes.push("youtube_api_key_missing");
  if (!health.youtubeAnalyticsOAuthClientConfigured || !health.youtubeOAuthCredentialEncryptionConfigured) {
    blockerCodes.push("youtube_analytics_oauth_missing");
  }
  blockerCodes.push(
    "youtube_current_cumulative_not_exact_window",
    "youtube_analytics_daily_not_exact_window",
    "youtube_exact_boundary_source_unavailable",
  );

  const material = JSON.stringify({
    v: YOUTUBE_EXACT_168H_READINESS_SCHEMA_VERSION,
    metricKey: input.metricKey,
    youtubeVideoId: input.youtubeVideoId,
    measurementStartAt: input.measurementStartAt,
    measurementEndExclusive: input.measurementEndExclusive,
    blockerCodes,
  });

  return {
    schemaVersion: YOUTUBE_EXACT_168H_READINESS_SCHEMA_VERSION,
    receiptId: `yt168h_${sha256(material).slice(0, 40)}`,
    exact168hOperational: false,
    source: "youtube_exact_window_provider",
    sourceCapability: "current_cumulative",
    sourceProvesExactBoundary: false,
    metricKey: input.metricKey,
    youtubeVideoId: input.youtubeVideoId,
    measurementStartAt: input.measurementStartAt,
    measurementEndExclusive: input.measurementEndExclusive,
    assessedAtIso,
    createdAtIso: assessedAtIso,
    credentialHealth: health,
    blockerCodes,
    missingProof: [
      "No YouTube API response in this codebase proves viewCount as of the exact millisecond measurementEndExclusive=publishedAt+168h.",
      "YouTube Data API videos.list exposes current cumulative statistics.viewCount, not a historical as-of boundary read.",
      "YouTube Analytics reports.query is date-bounded (YYYY-MM-DD) and day/month dimensions aggregate Pacific-time periods, not arbitrary publishedAt+168h instants.",
      "Creator OAuth credential presence and a successful live Analytics query for the specific channel/video/cutoff have not been proven in this runtime.",
    ],
    officialDocs: YOUTUBE_EXACT_168H_OFFICIAL_DOCS,
  };
}

export function readinessReceiptToUnavailableResult(
  receipt: YouTubeExact168hReadinessReceipt,
): ExactWindowMetricUnavailable {
  return {
    sourceCapability: receipt.sourceCapability,
    sourceProvesExactBoundary: false,
    exact168hOperational: false,
    blockerCode: "video_metric_exact_source_unavailable",
    readinessReceipt: receipt,
  };
}

export function createFailClosedYouTubeExactWindowProvider(options: {
  env?: Record<string, string | undefined>;
  now?: () => Date;
} = {}): ExactWindowMetricProvider {
  return {
    async fetchExactWindowMetric(input) {
      const receipt = assessYouTubeExact168hOperationalReadiness({
        ...input,
        env: options.env,
        now: options.now ? options.now() : undefined,
      });
      return readinessReceiptToUnavailableResult(receipt);
    },
  };
}
