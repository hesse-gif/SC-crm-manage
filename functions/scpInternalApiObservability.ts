// G007-L04 — internal API SLO observability (REQ-TEST-002 / SLO-API-*).
// Emits a structured, privacy-safe measurement record per request and compares it to the
// frozen SLO budgets from docs/scp-slo-contract.json. Pure logic; the caller decides how
// to sink the record (structured log / metric). No bodies, tokens, PII in the record.

export type SloBudget = {
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  maxResponseBytes: number;
  maxBacklog: number;
};

// Budgets transcribed from the frozen SLO targets. includePerformance changes the latency
// envelope (SLO-API-LAT-002 vs SLO-API-PERF-LAT-003).
export const SLO_BUDGET_STANDARD: SloBudget = {
  latencyP50Ms: 150,
  latencyP95Ms: 500,
  latencyP99Ms: 900,
  maxResponseBytes: 1_000_000,
  maxBacklog: 5,
};

export const SLO_BUDGET_PERFORMANCE: SloBudget = {
  latencyP50Ms: 250,
  latencyP95Ms: 900,
  latencyP99Ms: 1500,
  maxResponseBytes: 2_000_000,
  maxBacklog: 5,
};

export function budgetFor(includePerformance: boolean): SloBudget {
  return includePerformance ? SLO_BUDGET_PERFORMANCE : SLO_BUDGET_STANDARD;
}

export type RequestMeasurement = {
  runId: string;
  environment: string;
  route: string; // e.g. /internal/scp/v1/partners/{partnerId}/programs/{programId}/video-submissions
  operation: string; // e.g. list_video_submissions
  source: string; // e.g. firestore_serving_read_model
  status: number; // final HTTP status
  latencyMs: number;
  responseBytes: number;
  readCount: number;
  backlog: number; // pending ready cycles not yet drained
  includePerformance: boolean;
};

export type SloObservation = {
  record: RequestMeasurement & {
    schemaVersion: "flu.scp-internal-api-observation.v1";
    withinSlo: boolean;
    breaches: string[];
    qualityFlags: string[];
  };
  withinSlo: boolean;
  breaches: string[];
};

const REQUIRED_DIMENSIONS: Array<keyof RequestMeasurement> = [
  "runId",
  "environment",
  "route",
  "operation",
  "source",
  "status",
];

export function buildObservation(measurement: RequestMeasurement): SloObservation {
  const budget = budgetFor(measurement.includePerformance);
  const breaches: string[] = [];
  const qualityFlags: string[] = [];

  for (const dimension of REQUIRED_DIMENSIONS) {
    const value = measurement[dimension];
    if (value === undefined || value === null || value === "") {
      qualityFlags.push(`missing_dimension:${dimension}`);
    }
  }

  // Single-request latency is judged against the p99 ceiling; percentile aggregation happens
  // at the sink, but a single request exceeding p99 is always a breach signal.
  if (measurement.latencyMs > budget.latencyP99Ms) breaches.push("latency_p99");
  if (measurement.responseBytes > budget.maxResponseBytes) breaches.push("response_bytes");
  if (measurement.backlog > budget.maxBacklog) breaches.push("backlog");
  if (measurement.status >= 500) breaches.push("unexpected_5xx");
  if (!Number.isFinite(measurement.readCount) || measurement.readCount < 0) qualityFlags.push("invalid_read_count");

  const withinSlo = breaches.length === 0;
  return {
    record: {
      schemaVersion: "flu.scp-internal-api-observation.v1",
      ...measurement,
      withinSlo,
      breaches,
      qualityFlags,
    },
    withinSlo,
    breaches,
  };
}
