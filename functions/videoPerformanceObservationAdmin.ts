import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { assessYouTubeExact168hOperationalReadiness } from "./videoPerformanceYouTubeProvider";

const ROLES = ["super_admin", "admin", "manager"] as const;

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = asString(record[key]);
  if (!value) throw Object.assign(new Error(`${key} required`), { code: "invalid-argument", errorCode: "required_string_required" });
  return value;
}

export async function getVideoMetricExact168hReadiness(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "video_metric_exact168h.readiness", ROLES);
  const data = asRecord(request.data);
  const receipt = assessYouTubeExact168hOperationalReadiness({
    metricKey: requiredString(data, "metricKey"),
    youtubeVideoId: requiredString(data, "youtubeVideoId"),
    measurementStartAt: requiredString(data, "measurementStartAt"),
    measurementEndExclusive: requiredString(data, "measurementEndExclusive"),
  });
  return {
    ok: true as const,
    exact168hOperational: receipt.exact168hOperational,
    receipt,
    behaviorLog: makeBehaviorLog(auth, "video_metric_exact168h.readiness", "blocked", "scp-automation"),
  };
}
