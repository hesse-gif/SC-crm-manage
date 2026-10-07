// SCP Creator Portal 대시보드 스냅샷 전달 클라이언트 (P1-FLU-PRODUCER).
//
// 계약: scp-creator-portal `POST /api/internal/flu/v1/dashboard-snapshots`
// - 서명 입력은 정확한 UTF-8 바디 바이트: `<timestamp>\n<idempotency-key>\n<raw-body>`
//   (HMAC-SHA256, 공유 SCP_FLU_INGEST_SECRET, 32자 이상).
// - 하나의 논리적 소스 리비전에는 하나의 idempotency key — 어떤 재시도에서도
//   키를 새로 만들지 않는다(타임아웃 포함).
// - 재시도 가능 코드만 백오프 재시도: ingest_auth_stale(재서명), 429(Retry-After),
//   503 계열(retryable=true). 409 계열은 운영자/소스 수정 대상이며 절대 루프 금지.
// - 로그 allowlist: requestId, code, duplicate, operation 만. 크리에이터/파트너/
//   프로그램/이메일/토큰/서명/키/원문 페이로드는 로그에 남기지 않는다.

import { createHash, createHmac } from "node:crypto";
import type {
  DashboardObservationDeleteWire,
  DashboardObservationUpsertWire,
} from "./scpDashboardSnapshotContract";

export const SCP_DASHBOARD_INGEST_PATH = "/api/internal/flu/v1/dashboard-snapshots";
export const SCP_DASHBOARD_INGEST_SECRET_ENV = "SCP_FLU_INGEST_SECRET";
export const SCP_DASHBOARD_INGEST_MIN_SECRET_BYTES = 32;
export const SCP_DASHBOARD_INGEST_MAX_BODY_BYTES = 512 * 1024;

const RETRYABLE_CODES = new Set([
  "ingest_auth_stale",
  "rate_limit_exceeded",
  "ingest_not_configured",
  "rate_limit_unavailable",
  "dashboard_store_mismatch",
  "dashboard_ingest_unavailable",
]);

export type DashboardObservationWire = DashboardObservationUpsertWire | DashboardObservationDeleteWire;

export type DashboardDeliveryResult =
  | {
      outcome: "accepted" | "duplicate";
      httpStatus: number;
      requestId: string;
      code: "";
      attempts: number;
      idempotencyKey: string;
    }
  | {
      outcome: "rejected" | "exhausted";
      httpStatus: number;
      requestId: string;
      code: string;
      retryable: boolean;
      attempts: number;
      idempotencyKey: string;
    };

export class DashboardDeliveryConfigError extends Error {
  readonly code = "dashboard_delivery_config_invalid";
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// 하나의 논리적 소스 리비전(scope + revision)당 안정적인 재시도 키.
// 전송 재시도/타임아웃은 이 키를 절대 바꾸지 않는다.
export function stableDashboardIdempotencyKey(observation: DashboardObservationWire): string {
  return `flu-dash-${sha256Hex([
    observation.sourceSystem,
    observation.portalCreatorId,
    observation.partnerId,
    observation.programId,
    observation.enrollmentId,
    observation.channelId,
    observation.operation,
    observation.revision,
  ].join("\n")).slice(0, 40)}`;
}

export function signScpIngestRequest(input: {
  rawBody: string;
  idempotencyKey: string;
  secret: string;
  timestampSeconds: number;
}): { "Content-Type": string; "X-SCP-Timestamp": string; "X-SCP-Idempotency-Key": string; "X-SCP-Signature": string } {
  if (Buffer.byteLength(input.secret, "utf8") < SCP_DASHBOARD_INGEST_MIN_SECRET_BYTES) {
    throw new DashboardDeliveryConfigError("ingest secret must be at least 32 bytes");
  }
  if (Buffer.byteLength(input.rawBody, "utf8") > SCP_DASHBOARD_INGEST_MAX_BODY_BYTES) {
    throw new DashboardDeliveryConfigError("request body exceeds the 512 KiB ingest limit");
  }
  if (!Number.isInteger(input.timestampSeconds)) {
    throw new DashboardDeliveryConfigError("timestamp must be integer Unix seconds");
  }
  const timestamp = String(input.timestampSeconds);
  const signature = createHmac("sha256", input.secret)
    .update(`${timestamp}\n${input.idempotencyKey}\n${input.rawBody}`)
    .digest("hex");
  return {
    "Content-Type": "application/json",
    "X-SCP-Timestamp": timestamp,
    "X-SCP-Idempotency-Key": input.idempotencyKey,
    "X-SCP-Signature": `sha256=${signature}`,
  };
}

export type DashboardDeliveryLogEntry = {
  operation: "scp_dashboard_snapshot_delivery";
  requestId: string;
  code: string;
  duplicate: boolean;
  httpStatus: number;
  attempt: number;
};

export type DeliverDashboardObservationOptions = {
  baseUrl: string;
  secret: string;
  observation: DashboardObservationWire;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  log?: (entry: DashboardDeliveryLogEntry) => void;
};

function parsePortalResponse(body: unknown): { requestId: string; code: string; duplicate: boolean; retryable: boolean } {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    requestId: typeof record.requestId === "string" ? record.requestId : "",
    code: typeof record.code === "string" ? record.code : "",
    duplicate: record.duplicate === true,
    retryable: record.retryable === true,
  };
}

function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfterSeconds = Number(retryAfterHeader);
  if (retryAfterHeader !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1_000, 60_000);
  }
  const base = Math.min(1_000 * 2 ** (attempt - 1), 30_000);
  return base + Math.floor(Math.random() * 250);
}

// 관측 1건을 포털 ingest 엔드포인트로 전달한다. 바디 바이트는 첫 직렬화 그대로
// 고정되고(재직렬화 금지), stale-signature 재시도만 timestamp/서명을 갱신한다.
export async function deliverDashboardObservation(
  options: DeliverDashboardObservationOptions,
): Promise<DashboardDeliveryResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? 5;
  const log = options.log ?? (() => {});
  let endpoint: URL;
  try {
    endpoint = new URL(SCP_DASHBOARD_INGEST_PATH, options.baseUrl);
  } catch {
    throw new DashboardDeliveryConfigError("portal base URL is invalid");
  }
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost") {
    throw new DashboardDeliveryConfigError("portal base URL must use HTTPS outside loopback test hosts");
  }

  const rawBody = JSON.stringify(options.observation);
  const idempotencyKey = stableDashboardIdempotencyKey(options.observation);

  let lastStatus = 0;
  let lastCode = "";
  let lastRequestId = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const headers = signScpIngestRequest({
      rawBody,
      idempotencyKey,
      secret: options.secret,
      timestampSeconds: Math.floor(now() / 1_000),
    });
    const response = await fetchImpl(endpoint, { method: "POST", headers, body: rawBody });
    const parsed = parsePortalResponse(await response.json().catch(() => ({})));
    lastStatus = response.status;
    lastCode = parsed.code;
    lastRequestId = parsed.requestId;
    log({
      operation: "scp_dashboard_snapshot_delivery",
      requestId: parsed.requestId,
      code: parsed.code,
      duplicate: parsed.duplicate,
      httpStatus: response.status,
      attempt,
    });

    if (response.status === 201) {
      return { outcome: "accepted", httpStatus: 201, requestId: parsed.requestId, code: "", attempts: attempt, idempotencyKey };
    }
    if (response.status === 200) {
      return { outcome: "duplicate", httpStatus: 200, requestId: parsed.requestId, code: "", attempts: attempt, idempotencyKey };
    }
    const retryable = RETRYABLE_CODES.has(parsed.code) || (parsed.retryable && response.status !== 409);
    if (!retryable) {
      return {
        outcome: "rejected",
        httpStatus: response.status,
        requestId: parsed.requestId,
        code: parsed.code || `http_${response.status}`,
        retryable: false,
        attempts: attempt,
        idempotencyKey,
      };
    }
    if (attempt < maxAttempts) {
      // ingest_auth_stale 은 즉시 재서명 재시도(같은 키/같은 바디), 그 외는 백오프.
      if (parsed.code !== "ingest_auth_stale") {
        await sleep(retryDelayMs(attempt, response.headers.get("Retry-After")));
      }
    }
  }
  return {
    outcome: "exhausted",
    httpStatus: lastStatus,
    requestId: lastRequestId,
    code: lastCode || `http_${lastStatus}`,
    retryable: true,
    attempts: maxAttempts,
    idempotencyKey,
  };
}
