import { createHash } from "node:crypto";
import {
  confirmedProgramAliasRegistryRevision,
  confirmedProgramIdentitySet,
  PROGRAM_REGISTRY_VERSION,
  resolveCanonicalProgramId,
  uniqueSorted,
} from "./programCanonical";

export const SUBMISSION_REVIEW_COUNT_RECONCILIATION_VERSION = "submission_review_count_reconciliation_v1" as const;
export const SUBMISSION_REVIEW_COUNT_PAGE_SIZE_DEFAULT = 100;
export const SUBMISSION_REVIEW_COUNT_PAGE_SIZE_MAX = 200;
export const SUBMISSION_REVIEW_COUNT_ALIAS_LIMIT = 50;

export type SubmissionReviewStatusBucket = "pending" | "approved" | "rejected" | "needs_review";
export type SubmissionReviewPaymentBucket = "not_payable" | "payable" | "paid" | "hold";

export type SubmissionReviewCounts = {
  statuses: Record<SubmissionReviewStatusBucket, number>;
  payments: Record<SubmissionReviewPaymentBucket, number>;
};

export type SubmissionReviewCountConfirmedProgramScope = {
  canonicalProgramId: string;
  identityProgramIds: string[];
  aliasRegistryRevision: string;
};

export type SubmissionReviewCountAliasScope = {
  canonicalProgramId: string;
  aliases: string[];
  aliasMap: Record<string, string>;
  aliasHash: string;
  aliasRegistryRevision: string;
  resolverVersion: typeof PROGRAM_REGISTRY_VERSION;
};

export type SubmissionReviewCountContribution = {
  kind: "matched" | "unscoped" | "other_program";
  canonicalProgramId?: string;
  status?: SubmissionReviewStatusBucket;
  payment?: SubmissionReviewPaymentBucket;
  fingerprint?: string;
};

export type SubmissionReviewCountPassState = {
  cursor: string | null;
  scannedRows: number;
  matchedRows: number;
  unscopedRows: number;
  otherProgramRows: number;
  counts: SubmissionReviewCounts;
  fingerprint: string;
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorWithCode(code: string): Error {
  return Object.assign(new Error(code), { code: "failed-precondition", errorCode: "error_with_code_unauthorized", reasonCode: code });
}

export function stableSubmissionReviewCountHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function emptySubmissionReviewCounts(): SubmissionReviewCounts {
  return {
    statuses: { pending: 0, approved: 0, rejected: 0, needs_review: 0 },
    payments: { not_payable: 0, payable: 0, paid: 0, hold: 0 },
  };
}

export function emptySubmissionReviewCountPass(): SubmissionReviewCountPassState {
  return {
    cursor: null,
    scannedRows: 0,
    matchedRows: 0,
    unscopedRows: 0,
    otherProgramRows: 0,
    counts: emptySubmissionReviewCounts(),
    fingerprint: stableSubmissionReviewCountHash(SUBMISSION_REVIEW_COUNT_RECONCILIATION_VERSION),
  };
}

export function buildSubmissionReviewCountAliasScope(
  confirmedScope: SubmissionReviewCountConfirmedProgramScope,
  confirmedAliasMap: Record<string, string>,
): SubmissionReviewCountAliasScope {
  const canonicalProgramId = resolveCanonicalProgramId(confirmedScope.canonicalProgramId, confirmedAliasMap);
  if (!canonicalProgramId || canonicalProgramId !== confirmedScope.canonicalProgramId) {
    throw errorWithCode("program_identity_unresolved");
  }
  const aliases = uniqueSorted(confirmedScope.identityProgramIds);
  if (aliases.length > SUBMISSION_REVIEW_COUNT_ALIAS_LIMIT) {
    throw errorWithCode("program_alias_limit_exceeded");
  }
  const expectedAliases = confirmedProgramIdentitySet(
    canonicalProgramId,
    confirmedAliasMap,
    SUBMISSION_REVIEW_COUNT_ALIAS_LIMIT,
  );
  const aliasRegistryRevision = confirmedProgramAliasRegistryRevision(confirmedAliasMap);
  if (
    aliases.length === 0
    || aliases.length !== expectedAliases.length
    || aliases.some((alias, index) => alias !== expectedAliases[index])
    || confirmedScope.aliasRegistryRevision !== aliasRegistryRevision
  ) {
    throw errorWithCode("program_alias_scope_drift");
  }

  const aliasMap: Record<string, string> = {};
  for (const alias of aliases) {
    aliasMap[alias] = canonicalProgramId;
  }
  return {
    canonicalProgramId,
    aliases,
    aliasMap,
    aliasHash: stableSubmissionReviewCountHash({
      canonicalProgramId,
      aliases,
      aliasRegistryRevision,
      resolverVersion: PROGRAM_REGISTRY_VERSION,
    }),
    aliasRegistryRevision,
    resolverVersion: PROGRAM_REGISTRY_VERSION,
  };
}

export function submissionReviewCountContribution(
  submissionId: string,
  row: Record<string, unknown>,
  scope: SubmissionReviewCountAliasScope,
): SubmissionReviewCountContribution {
  const declaredProgramIds = uniqueSorted([
    row.programId,
    row.canonicalProgramId,
    row.programIdAlias,
  ]);
  if (declaredProgramIds.length === 0) return { kind: "unscoped" };

  const resolvedProgramIds = uniqueSorted(
    declaredProgramIds.map((programId) => resolveCanonicalProgramId(programId, scope.aliasMap)),
  );
  if (resolvedProgramIds.length !== 1) {
    const touchesTarget = resolvedProgramIds.includes(scope.canonicalProgramId)
      || declaredProgramIds.some((programId) => scope.aliases.includes(programId));
    if (touchesTarget) throw errorWithCode(`program_scope_conflict:${safeFingerprintId(submissionId)}`);
    return { kind: "other_program" };
  }

  const canonicalProgramId = resolvedProgramIds[0];
  if (canonicalProgramId !== scope.canonicalProgramId) {
    return { kind: "other_program", canonicalProgramId };
  }

  const status = normalizeSubmissionReviewStatus(row.reviewStatus ?? row.status, submissionId);
  const payment = normalizeSubmissionReviewPayment(row, submissionId);
  return {
    kind: "matched",
    canonicalProgramId,
    status,
    payment,
    fingerprint: stableSubmissionReviewCountHash({
      submissionId,
      canonicalProgramId,
      declaredProgramIds,
      status,
      payment,
    }),
  };
}

export function accumulateSubmissionReviewCountPage(
  current: SubmissionReviewCountPassState,
  rows: Array<{ id: string; data: Record<string, unknown> }>,
  scope: SubmissionReviewCountAliasScope,
): SubmissionReviewCountPassState {
  const next: SubmissionReviewCountPassState = {
    cursor: current.cursor,
    scannedRows: current.scannedRows,
    matchedRows: current.matchedRows,
    unscopedRows: current.unscopedRows,
    otherProgramRows: current.otherProgramRows,
    counts: {
      statuses: { ...current.counts.statuses },
      payments: { ...current.counts.payments },
    },
    fingerprint: current.fingerprint,
  };

  for (const row of rows) {
    next.scannedRows += 1;
    next.cursor = row.id;
    const contribution = submissionReviewCountContribution(row.id, row.data, scope);
    if (contribution.kind === "unscoped") {
      next.unscopedRows += 1;
      continue;
    }
    if (contribution.kind === "other_program") {
      next.otherProgramRows += 1;
      continue;
    }
    next.matchedRows += 1;
    next.counts.statuses[contribution.status!] += 1;
    next.counts.payments[contribution.payment!] += 1;
    next.fingerprint = stableSubmissionReviewCountHash({
      previous: next.fingerprint,
      row: contribution.fingerprint,
    });
  }
  return next;
}

export function submissionReviewCountPassesMatch(
  first: SubmissionReviewCountPassState,
  second: SubmissionReviewCountPassState,
): boolean {
  return first.matchedRows === second.matchedRows
    && first.fingerprint === second.fingerprint
    && stableSubmissionReviewCountHash(first.counts) === stableSubmissionReviewCountHash(second.counts);
}

export function aggregateDocumentFingerprint(input: {
  exists: boolean;
  data: Record<string, unknown> | null;
  updateToken: string | null;
}): string {
  return stableSubmissionReviewCountHash(input);
}

function normalizeSubmissionReviewStatus(value: unknown, submissionId: string): SubmissionReviewStatusBucket {
  const normalized = clean(value).toLowerCase();
  if (normalized === "pending" || normalized === "review_pending") return "pending";
  if (normalized === "approved" || normalized === "pass" || normalized === "passed") return "approved";
  if (normalized === "rejected" || normalized === "fail" || normalized === "failed" || normalized === "blocked" || normalized === "denied") return "rejected";
  if (normalized === "needs_review" || normalized === "revise" || normalized === "needs_resubmission" || normalized === "resubmission_requested") return "needs_review";
  throw errorWithCode(`submission_review_status_unknown:${safeFingerprintId(submissionId)}`);
}

function normalizeSubmissionReviewPayment(
  row: Record<string, unknown>,
  submissionId: string,
): SubmissionReviewPaymentBucket {
  const payment = row.payment && typeof row.payment === "object" && !Array.isArray(row.payment)
    ? row.payment as Record<string, unknown>
    : {};
  const rawValues = [payment.payStatus, row.payableStatus, row.paymentStatus]
    .map(clean)
    .filter(Boolean);
  if (row.paid === true) rawValues.push("paid");
  if (rawValues.length === 0) return "not_payable";

  const normalized = uniqueSorted(rawValues.map((value) => normalizePaymentBucket(value, submissionId)));
  if (normalized.length !== 1) {
    throw errorWithCode(`submission_payment_scope_conflict:${safeFingerprintId(submissionId)}`);
  }
  return normalized[0] as SubmissionReviewPaymentBucket;
}

function normalizePaymentBucket(value: string, submissionId: string): SubmissionReviewPaymentBucket {
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "not_payable" || normalized === "none" || normalized === "unpaid") return "not_payable";
  if (normalized === "payable" || normalized === "ready") return "payable";
  if (normalized === "paid" || normalized === "complete" || normalized === "completed") return "paid";
  if (normalized === "hold" || normalized === "held") return "hold";
  throw errorWithCode(`submission_payment_status_unknown:${safeFingerprintId(submissionId)}`);
}

function safeFingerprintId(value: string): string {
  return stableSubmissionReviewCountHash(value).slice(0, 16);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return { __dateIso: value.toISOString() };
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object") {
    const record = value as Record<string, unknown> & { toDate?: () => Date };
    if (typeof record.toDate === "function") {
      try {
        return { __timestampIso: record.toDate().toISOString() };
      } catch {
        return { __timestamp: "invalid" };
      }
    }
    return Object.fromEntries(
      Object.entries(record)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return String(value);
}
