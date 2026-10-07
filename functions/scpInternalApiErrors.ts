// G007-L01 — Creator Portal internal API error contract (REQ-API-014).
// Self-contained pure logic so contract tests can exercise it without the emulator.
// Every failure the internal video-submissions API can produce maps to exactly one
// typed error with a stable machine code, HTTP status, retryability, and redacted body.

export const SCP_VIDEO_SUBMISSIONS_SCHEMA_VERSION = "scp-video-submissions.v1";

export type ApiErrorCode =
  | "invalid_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "method_not_allowed"
  | "not_acceptable"
  | "cursor_conflict"
  | "unprocessable_source"
  | "rate_limited"
  | "internal"
  | "unavailable";

type ErrorSpec = { httpStatus: number; retryable: boolean; message: string };

// Closed table — REQ-API-014 requires 400/401/403/404/405/406/409/422/429/500/503.
export const API_ERROR_TABLE: Readonly<Record<ApiErrorCode, ErrorSpec>> = Object.freeze({
  invalid_request: { httpStatus: 400, retryable: false, message: "Request is malformed or uses unsupported parameters." },
  unauthenticated: { httpStatus: 401, retryable: false, message: "A valid Portal workload OIDC identity token is required." },
  forbidden: { httpStatus: 403, retryable: false, message: "Caller is not entitled to this partner or program scope." },
  not_found: { httpStatus: 404, retryable: false, message: "The partner or program was not found within the caller scope." },
  method_not_allowed: { httpStatus: 405, retryable: false, message: "Only GET is supported on this endpoint." },
  not_acceptable: { httpStatus: 406, retryable: false, message: "Only application/json responses are available." },
  cursor_conflict: { httpStatus: 409, retryable: false, message: "The cursor does not match the current scope, filter, or generation." },
  unprocessable_source: { httpStatus: 422, retryable: false, message: "A required source mapping is missing; no fabricated values are returned." },
  rate_limited: { httpStatus: 429, retryable: true, message: "Too many requests; retry after the indicated delay." },
  internal: { httpStatus: 500, retryable: true, message: "An internal error occurred." },
  unavailable: { httpStatus: 503, retryable: true, message: "The read model is temporarily unavailable." },
});

export type ApiErrorDetail = { field?: string; reason: string };

export class ScpInternalApiError extends Error {
  readonly code: ApiErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details: ApiErrorDetail[];
  readonly retryAfterSeconds: number | null;

  constructor(
    code: ApiErrorCode,
    options: { message?: string; details?: ApiErrorDetail[]; retryAfterSeconds?: number | null } = {},
  ) {
    const spec = API_ERROR_TABLE[code];
    super(options.message ?? spec.message);
    this.name = "ScpInternalApiError";
    this.code = code;
    this.httpStatus = spec.httpStatus;
    this.retryable = spec.retryable;
    this.details = (options.details ?? []).map((detail) => ({
      ...(detail.field ? { field: detail.field } : {}),
      reason: detail.reason,
    }));
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export function isApiError(value: unknown): value is ScpInternalApiError {
  return value instanceof ScpInternalApiError;
}

// Factories keep call sites terse and prevent ad-hoc status codes.
export const apiError = {
  invalidRequest: (details: ApiErrorDetail[] = [], message?: string) => new ScpInternalApiError("invalid_request", { details, message }),
  unauthenticated: (reason: string) => new ScpInternalApiError("unauthenticated", { details: [{ reason }] }),
  forbidden: (reason: string) => new ScpInternalApiError("forbidden", { details: [{ reason }] }),
  notFound: (reason: string) => new ScpInternalApiError("not_found", { details: [{ reason }] }),
  methodNotAllowed: () => new ScpInternalApiError("method_not_allowed"),
  notAcceptable: () => new ScpInternalApiError("not_acceptable"),
  cursorConflict: (reason: string) => new ScpInternalApiError("cursor_conflict", { details: [{ reason }] }),
  unprocessableSource: (details: ApiErrorDetail[]) => new ScpInternalApiError("unprocessable_source", { details }),
  rateLimited: (retryAfterSeconds: number) => new ScpInternalApiError("rate_limited", { retryAfterSeconds }),
  internal: () => new ScpInternalApiError("internal"),
  unavailable: (retryAfterSeconds: number | null = null) => new ScpInternalApiError("unavailable", { retryAfterSeconds }),
};

export type ErrorResponse = {
  status: number;
  headers: Record<string, string>;
  body: {
    schemaVersion: string;
    error: {
      code: ApiErrorCode;
      message: string;
      retryable: boolean;
      requestId: string;
      details: ApiErrorDetail[];
    };
  };
};

// Redaction: only the closed detail list is echoed. Raw tokens, PII, and internal
// document paths never appear because callers can only attach {field, reason} strings,
// and we defensively strip anything that looks like an email, bearer token, or path.
const REDACT_RE = /([\w.+-]+@[\w.-]+)|(Bearer\s+[A-Za-z0-9._~+/=-]+)|(\/[A-Za-z0-9_./-]{12,})/g;

function redact(value: string): string {
  return value.replace(REDACT_RE, "[redacted]").slice(0, 400);
}

export function toErrorResponse(error: unknown, requestId: string): ErrorResponse {
  const apiErr = isApiError(error) ? error : apiError.internal();
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-request-id": requestId,
    "x-error-retryable": apiErr.retryable ? "true" : "false",
  };
  if (apiErr.code === "rate_limited" || apiErr.code === "unavailable") {
    // Deterministic default so retry storms stay bounded even when unset.
    headers["retry-after"] = String(apiErr.retryAfterSeconds ?? 30);
  }
  if (apiErr.code === "method_not_allowed") headers.allow = "GET";
  return {
    status: apiErr.httpStatus,
    headers,
    body: {
      schemaVersion: SCP_VIDEO_SUBMISSIONS_SCHEMA_VERSION,
      error: {
        code: apiErr.code,
        message: redact(apiErr.message),
        retryable: apiErr.retryable,
        requestId,
        details: apiErr.details.map((detail) => ({
          ...(detail.field ? { field: detail.field } : {}),
          reason: redact(detail.reason),
        })),
      },
    },
  };
}
