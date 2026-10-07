// G007-L02 — page assembly for the internal video-submissions endpoint.
// Pure over an in-memory row set so it is fully unit-testable; the Firestore fetch is a
// thin adapter that hands rows here. Enforces ordering, inclusive updatedAfter,
// cursor paging, limit bounds, creators[] referential integrity, and watermarking.

import { createHash } from "node:crypto";
import { SCP_VIDEO_SUBMISSIONS_SCHEMA_VERSION, apiError } from "./scpInternalApiErrors";
import {
  compareByPosition,
  decodeCursor,
  encodeCursor,
  isAfterPosition,
  type CursorScope,
} from "./scpInternalApiCursor";
import {
  isTombstoneRow,
  projectCreatorRef,
  projectTombstone,
  projectVideoSubmission,
  type CreatorRef,
  type ProjectionOptions,
  type RawCreatorRow,
  type RawSubmissionRow,
  type VideoSubmissionItem,
  type VideoSubmissionTombstone,
} from "./scpVideoSubmissionsProjection";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
const MAX_COUNTRY_ROWS = 60;
const MAX_PERFORMANCE_DAYS = 28; // REQ-API-016 primary-audience window

export type SubmissionsQuery = {
  updatedAfter: string; // "" means from beginning; inclusive lower bound (REQ-API-008)
  cursor: string;
  limit: number;
  includePerformance: boolean;
};

export type SubmissionsPage = {
  schemaVersion: string;
  partnerId: string;
  programId: string;
  generation: string;
  items: Array<VideoSubmissionItem | VideoSubmissionTombstone>;
  creators: CreatorRef[];
  nextCursor: string | null;
  hasMore: boolean;
  sourceWatermark: string;
};

function positionOf(row: RawSubmissionRow): { sourceUpdatedAt: string; submissionId: string } {
  const record = row as Record<string, unknown>;
  const sourceUpdatedAt =
    [record.sourceUpdatedAt, record.updatedAtIso, record.reviewedAtIso, record.submittedAtIso, record.createdAtIso]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .find(Boolean) ?? "";
  const submissionId =
    [record.submissionId, record.id, record.taskId]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .find(Boolean) ?? "";
  return { sourceUpdatedAt, submissionId };
}

// Audit fingerprint over the full ordered scope (REQ-API-008): not a resume token, just a
// deterministic digest a consumer can log to prove which source state a cycle reflected.
function computeWatermark(scope: CursorScope, ordered: RawSubmissionRow[]): string {
  const hash = createHash("sha256");
  hash.update(`${scope.partnerId}|${scope.programId}|${scope.generation}`);
  for (const row of ordered) {
    const position = positionOf(row);
    hash.update(`\n${position.sourceUpdatedAt}#${position.submissionId}`);
  }
  return hash.digest("hex");
}

export function buildSubmissionsPage(input: {
  rows: RawSubmissionRow[];
  creators: RawCreatorRow[];
  query: SubmissionsQuery;
  scope: { partnerId: string; programId: string; generation: string };
  secret: string;
  nowMs?: number;
}): SubmissionsPage {
  const { rows, creators, query, scope, secret } = input;
  const nowMs = input.nowMs ?? Date.now();

  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_LIMIT) {
    throw apiError.invalidRequest([{ field: "limit", reason: `limit must be an integer in [1, ${MAX_LIMIT}]` }]);
  }

  const cursorScope: CursorScope = {
    partnerId: scope.partnerId,
    programId: scope.programId,
    updatedAfter: query.updatedAfter,
    includePerformance: query.includePerformance,
    generation: scope.generation,
  };

  // Deterministic total order over the entire scoped set (REQ-API-007).
  const ordered = [...rows].sort((a, b) => compareByPosition(positionOf(a), positionOf(b)));

  // Inclusive updatedAfter lower bound (REQ-API-008).
  const afterFiltered = query.updatedAfter
    ? ordered.filter((row) => positionOf(row).sourceUpdatedAt >= query.updatedAfter)
    : ordered;

  // Cursor is an exclusive "start after" marker within the already-scoped order.
  let windowRows = afterFiltered;
  if (query.cursor) {
    const position = decodeCursor(query.cursor, cursorScope, secret, { nowMs });
    windowRows = afterFiltered.filter((row) => isAfterPosition(positionOf(row), position));
  }

  const pageRows = windowRows.slice(0, query.limit);
  const hasMore = windowRows.length > query.limit;

  const projectionOptions: ProjectionOptions = {
    partnerId: scope.partnerId,
    programId: scope.programId,
    includePerformance: query.includePerformance,
    maxCountryRows: MAX_COUNTRY_ROWS,
    maxPerformanceDays: MAX_PERFORMANCE_DAYS,
  };

  const items: Array<VideoSubmissionItem | VideoSubmissionTombstone> = pageRows.map((row) =>
    isTombstoneRow(row) ? projectTombstone(row, projectionOptions) : projectVideoSubmission(row, projectionOptions),
  );

  // Page-local creators[] referential integrity (REQ-API-010): only creators referenced by a
  // live item on this page are attached, and every live item must resolve.
  const creatorsById = new Map<string, CreatorRef>();
  for (const raw of creators) {
    const ref = projectCreatorRef(raw);
    if (ref.portalCreatorId) creatorsById.set(ref.portalCreatorId, ref);
  }
  const referenced: CreatorRef[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.removed) continue;
    const ref = creatorsById.get(item.portalCreatorId);
    if (!ref) {
      throw apiError.unprocessableSource([
        { field: "creators", reason: `active submission references unknown creator ${item.portalCreatorId}` },
      ]);
    }
    if (!seen.has(ref.portalCreatorId)) {
      seen.add(ref.portalCreatorId);
      referenced.push(ref);
    }
  }

  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const lastPosition = positionOf(pageRows[pageRows.length - 1]);
    nextCursor = encodeCursor(cursorScope, lastPosition, secret, { nowMs });
  }

  return {
    schemaVersion: SCP_VIDEO_SUBMISSIONS_SCHEMA_VERSION,
    partnerId: scope.partnerId,
    programId: scope.programId,
    generation: scope.generation,
    items,
    creators: referenced,
    nextCursor,
    hasMore,
    sourceWatermark: computeWatermark(cursorScope, ordered),
  };
}

// Strict query parser (REQ-API-006): only updatedAfter, cursor, limit, includePerformance;
// unknown/duplicate/malformed params fail typed. `raw` mirrors URLSearchParams semantics
// where repeated keys collapse to arrays.
export function parseSubmissionsQuery(raw: Record<string, string | string[] | undefined>): SubmissionsQuery {
  const allowed = new Set(["updatedAfter", "cursor", "limit", "includePerformance"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw apiError.invalidRequest([{ field: key, reason: "unsupported query parameter" }]);
    if (Array.isArray(raw[key])) throw apiError.invalidRequest([{ field: key, reason: "duplicate query parameter" }]);
  }
  const single = (key: string): string => (typeof raw[key] === "string" ? (raw[key] as string) : "");

  const updatedAfterRaw = single("updatedAfter");
  if (updatedAfterRaw) {
    const parsed = new Date(updatedAfterRaw);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== updatedAfterRaw) {
      throw apiError.invalidRequest([{ field: "updatedAfter", reason: "must be a canonical ISO-8601 UTC timestamp" }]);
    }
  }

  let limit = DEFAULT_LIMIT;
  const limitRaw = single("limit");
  if (limitRaw) {
    if (!/^\d+$/.test(limitRaw)) throw apiError.invalidRequest([{ field: "limit", reason: "must be a positive integer" }]);
    limit = Number(limitRaw);
  }

  const perfRaw = single("includePerformance");
  if (perfRaw && perfRaw !== "true" && perfRaw !== "false") {
    throw apiError.invalidRequest([{ field: "includePerformance", reason: "must be 'true' or 'false'" }]);
  }

  return {
    updatedAfter: updatedAfterRaw,
    cursor: single("cursor"),
    limit,
    includePerformance: perfRaw === "true",
  };
}
