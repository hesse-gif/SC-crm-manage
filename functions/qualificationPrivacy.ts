import { createHash } from "node:crypto";

export const QUALIFICATION_BOUNDARY_ERROR_CODES = [
  "missing_lead_id",
  "qualification_bridge_failed",
  "qualification_judge_failed",
  "qualification_lifecycle_enqueue_failed",
  "qualification_sheet_identity_changed",
  "qualification_sheet_source_contract_failed",
  "qualification_sheet_reread_failed",
  "qualification_sheet_audit_finalize_failed",
  "qualification_sheet_audit_prepare_failed",
  "qualification_sheet_update_failed",
  "qualification_sheet_update_unknown",
  "qualification_sheet_verify_failed",
  "qualification_sheet_writeback_failed",
  "qualification_sheet_writeback_lease_lost",
  "qualification_sheet_writeback_no_terminal_status",
] as const;

export type QualificationBoundaryErrorCode = typeof QUALIFICATION_BOUNDARY_ERROR_CODES[number];

export type QualificationBoundaryError = {
  code: QualificationBoundaryErrorCode;
  correlationKey: string;
};

const HASH_DOMAIN = "scp-qualification-boundary:v1";

export function qualificationIdentityHash(kind: string, value: unknown): string {
  const normalized = typeof value === "string"
    ? value.normalize("NFKC").trim()
    : value === null || value === undefined
      ? ""
      : String(value).normalize("NFKC").trim();
  return createHash("sha256")
    .update(`${HASH_DOMAIN}\0identity\0${kind}\0${normalized}`)
    .digest("hex");
}

export function qualificationBoundaryError(
  error: unknown,
  code: QualificationBoundaryErrorCode,
): QualificationBoundaryError {
  const record = error && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
  const rawCode = scalarText(record.code);
  const name = error instanceof Error ? error.name : scalarText(record.name);
  const message = error instanceof Error ? error.message : scalarText(error);
  const correlationKey = createHash("sha256")
    .update(`${HASH_DOMAIN}\0error\0${code}\0${rawCode}\0${name}\0${message}`)
    .digest("hex")
    .slice(0, 24);
  return { code, correlationKey };
}

export function qualificationBoundaryException(
  error: unknown,
  code: QualificationBoundaryErrorCode,
  transportCode = "failed-precondition",
): Error {
  const safe = qualificationBoundaryError(error, code);
  return Object.assign(
    new Error(`${transportCode}: ${safe.code}; correlation=${safe.correlationKey}`),
    { code: transportCode, errorCode: safe.code, correlationKey: safe.correlationKey },
  );
}

function scalarText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}
