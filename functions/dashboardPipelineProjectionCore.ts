export const DASHBOARD_PIPELINE_DEFAULT_LIMIT = 40;
export const DASHBOARD_PIPELINE_MAX_LIMIT = 100;
export const DASHBOARD_PIPELINE_MAX_SCAN_PAGES = 5;

export type DashboardPipelineProjectionSource = "applications" | "leads" | "creators" | "conversations";

export type DashboardPipelineProjectionPageInfo = {
  limit: number;
  returned: number;
  scanned: number;
  hasMore: boolean;
  truncated: boolean;
  nextCursor: string | null;
};

export type DashboardPipelineProjectionPage<T extends Record<string, unknown> = Record<string, unknown>> = {
  rows: T[];
  pageInfo: DashboardPipelineProjectionPageInfo;
  readStats?: DashboardPipelineProjectionPageReadStats;
};

export type DashboardPipelineProjectionPageReadStats = {
  queryCount: number;
  documentReads: number;
  documentReadUpperBound: number;
};

export type DashboardPipelineProjectionReadRequest = {
  source: DashboardPipelineProjectionSource;
  limit: number;
  cursor?: string;
};

export type DashboardPipelineProjectionPerformance = {
  queryCount: number;
  perRowReads: 0;
  documentReads: number;
  documentReadUpperBound: number;
  durationMs: number;
};

export type DashboardPipelineProjectionScanDocument<T extends Record<string, unknown>> = {
  id: string;
  sortValue: string;
  row: T;
};

export type DashboardPipelineProjectionLaneCursor =
  | {
      source: DashboardPipelineProjectionSource;
      lane: "updated";
      docId: string;
      sortValue: string;
    }
  | {
      source: DashboardPipelineProjectionSource;
      lane: "legacy";
      docId?: string;
    };

type DashboardPipelineProjectionFillInput<T extends Record<string, unknown>> = {
  source: DashboardPipelineProjectionSource;
  limit: number;
  afterDocId?: string;
  afterSortValue?: string;
  maxScanPages?: number;
  readBatch: (request: {
    source: DashboardPipelineProjectionSource;
    limit: number;
    afterDocId?: string;
    afterSortValue?: string;
  }) => Promise<DashboardPipelineProjectionScanDocument<T>[]>;
  isVisible: (document: DashboardPipelineProjectionScanDocument<T>) => boolean;
};

type DashboardPipelineProjectionLegacyFillInput<T extends Record<string, unknown>> = {
  source: DashboardPipelineProjectionSource;
  limit: number;
  cursor?: DashboardPipelineProjectionLaneCursor;
  maxScanPages?: number;
  readUpdatedBatch: (request: {
    source: DashboardPipelineProjectionSource;
    limit: number;
    afterDocId?: string;
    afterSortValue?: string;
  }) => Promise<DashboardPipelineProjectionScanDocument<T>[]>;
  readLegacyBatch: (request: {
    source: DashboardPipelineProjectionSource;
    limit: number;
    afterDocId?: string;
  }) => Promise<DashboardPipelineProjectionScanDocument<T>[]>;
  isUpdated: (document: DashboardPipelineProjectionScanDocument<T>) => boolean;
  isLegacy: (document: DashboardPipelineProjectionScanDocument<T>) => boolean;
  isVisible: (document: DashboardPipelineProjectionScanDocument<T>) => boolean;
};

type DashboardPipelineProjectionLoadInput<
  TApplication extends Record<string, unknown>,
  TLead extends Record<string, unknown>,
  TCreator extends Record<string, unknown>,
  TConversation extends Record<string, unknown>,
> = {
  requestedLimit?: unknown;
  applicationCursor?: string;
  leadCursor?: string;
  creatorCursor?: string;
  conversationCursor?: string;
  readPage: (
    request: DashboardPipelineProjectionReadRequest,
  ) => Promise<
    DashboardPipelineProjectionPage<TApplication>
    | DashboardPipelineProjectionPage<TLead>
    | DashboardPipelineProjectionPage<TCreator>
    | DashboardPipelineProjectionPage<TConversation>
  >;
  clock?: () => number;
};

export function normalizeDashboardPipelineLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DASHBOARD_PIPELINE_DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(value), DASHBOARD_PIPELINE_MAX_LIMIT));
}

export function encodeDashboardPipelineCursor(
  source: DashboardPipelineProjectionSource,
  docId: string,
  sortValue: string,
): string {
  return Buffer.from(JSON.stringify({ version: 2, source, sortValue, docId }), "utf8").toString("base64url");
}

export function decodeDashboardPipelineCursor(
  value: unknown,
  expectedSource: DashboardPipelineProjectionSource,
): { source: DashboardPipelineProjectionSource; sortValue: string; docId: string } | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const row = decoded as Record<string, unknown>;
    const source = row.source;
    const docId = typeof row.docId === "string" ? row.docId.trim() : "";
    const sortValue = typeof row.sortValue === "string" ? row.sortValue.trim() : "";
    if (
      row.version !== 2
      || source !== expectedSource
      || !sortValue
      || sortValue.length > 120
      || !docId
      || docId.length > 1_500
    ) return null;
    return { source: expectedSource, sortValue, docId };
  } catch {
    return null;
  }
}

function validCursorPart(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength;
}

function validRawSortCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 120;
}

/**
 * Version 3 cursors make the active ordering lane explicit. A legacy-lane cursor
 * intentionally has no timestamp: once the updatedAtIso lane is exhausted, the
 * document-id scan is the only remaining source of rows.
 *
 * Version 2 cursors remain readable as updated-lane cursors so in-flight clients
 * can finish their existing page sequence after a deployment.
 */
export function decodeDashboardPipelineLaneCursor(
  value: unknown,
  expectedSource: DashboardPipelineProjectionSource,
): DashboardPipelineProjectionLaneCursor | null {
  const versionTwo = decodeDashboardPipelineCursor(value, expectedSource);
  if (versionTwo) {
    return {
      source: expectedSource,
      lane: "updated",
      docId: versionTwo.docId,
      sortValue: versionTwo.sortValue,
    };
  }
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const row = decoded as Record<string, unknown>;
    if (row.version !== 3 || row.source !== expectedSource) return null;
    if (row.lane === "updated") {
      if (!validCursorPart(row.docId, 1_500) || !validRawSortCursor(row.sortValue)) return null;
      return {
        source: expectedSource,
        lane: "updated",
        docId: row.docId.trim(),
        sortValue: row.sortValue,
      };
    }
    if (row.lane === "legacy") {
      if (row.docId !== undefined && row.docId !== null && !validCursorPart(row.docId, 1_500)) return null;
      return {
        source: expectedSource,
        lane: "legacy",
        ...(validCursorPart(row.docId, 1_500) ? { docId: row.docId.trim() } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function encodeDashboardPipelineLaneCursor(cursor: DashboardPipelineProjectionLaneCursor): string {
  return Buffer.from(JSON.stringify({ version: 3, ...cursor }), "utf8").toString("base64url");
}

export function hasUsableDashboardUpdatedAtIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  if (normalized !== value) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(normalized)) return false;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === normalized;
}

function applicationIdFromExactReference(value: unknown): string {
  if (typeof value !== "string") return "";
  const parts = value.trim().split("/");
  if (parts.length !== 2 || parts[0] !== "program_applications") return "";
  const id = parts[1]?.trim() ?? "";
  return id && id.length <= 1_500 ? id : "";
}

/**
 * Server-owned projection enrichment. The bridge reference is the authoritative
 * cross-ledger identity written by the qualification bridge, so downstream deep
 * links do not need another Firestore lookup to recover the application id.
 */
export function projectDashboardPipelineDocumentRow<T extends Record<string, unknown>>(
  source: DashboardPipelineProjectionSource,
  id: string,
  row: T,
): T & { id: string; applicationId?: string } {
  const projected = { ...row, id } as T & { id: string; applicationId?: string };
  if (source !== "leads") return projected;
  const bridgedApplicationId = applicationIdFromExactReference(row.bridgedApplicationRef);
  if (bridgedApplicationId) projected.applicationId = bridgedApplicationId;
  return projected;
}

function normalizedStatus(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Terminal failures never materialize on the active dashboard pipeline. Filtering
 * them before the visible cap is filled prevents a backlog of rejected rows from
 * hiding newer actionable work.
 */
export function isDashboardPipelineTerminalRow(
  source: DashboardPipelineProjectionSource,
  row: Record<string, unknown>,
): boolean {
  if (source === "applications") {
    return ["rejected", "failed", "withdrawn", "excluded"].includes(normalizedStatus(row.status));
  }
  if (source === "leads") {
    const status = normalizedStatus(row.qualificationStatus)
      || normalizedStatus(row.finalVerdict)
      || normalizedStatus(row.status);
    return ["fail", "failed", "rejected", "withdrawn", "excluded"].includes(status);
  }
  return false;
}

export async function fillDashboardPipelineProjectionPage<T extends Record<string, unknown>>(
  input: DashboardPipelineProjectionFillInput<T>,
): Promise<DashboardPipelineProjectionPage<T> & { readStats: DashboardPipelineProjectionPageReadStats }> {
  const limit = normalizeDashboardPipelineLimit(input.limit);
  const maxScanPages = Math.max(1, Math.min(
    Math.trunc(input.maxScanPages ?? DASHBOARD_PIPELINE_MAX_SCAN_PAGES),
    DASHBOARD_PIPELINE_MAX_SCAN_PAGES,
  ));
  const queryLimit = limit + 1;
  const rows: T[] = [];
  let afterDocId = input.afterDocId;
  let afterSortValue = input.afterSortValue;
  let scanned = 0;
  let queryCount = 0;
  let documentReads = 0;

  while (rows.length < limit && queryCount < maxScanPages) {
    const batch = await input.readBatch({
      source: input.source,
      limit: queryLimit,
      ...(afterDocId && afterSortValue ? { afterDocId, afterSortValue } : {}),
    });
    queryCount += 1;
    documentReads += batch.length;
    const documents = batch.slice(0, limit);
    const hasExtraDocument = batch.length > limit;

    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index];
      afterDocId = document.id;
      afterSortValue = document.sortValue;
      scanned += 1;
      if (input.isVisible(document)) rows.push(document.row);
      if (rows.length >= limit) {
        const hasMore = index < documents.length - 1 || hasExtraDocument;
        return {
          rows,
          pageInfo: {
            limit,
            returned: rows.length,
            scanned,
            hasMore,
            truncated: hasMore,
            nextCursor: hasMore
              ? encodeDashboardPipelineCursor(input.source, document.id, document.sortValue)
              : null,
          },
          readStats: {
            queryCount,
            documentReads,
            documentReadUpperBound: maxScanPages * queryLimit,
          },
        };
      }
    }

    if (!hasExtraDocument || !afterDocId || !afterSortValue) {
      return {
        rows,
        pageInfo: {
          limit,
          returned: rows.length,
          scanned,
          hasMore: false,
          truncated: false,
          nextCursor: null,
        },
        readStats: {
          queryCount,
          documentReads,
          documentReadUpperBound: maxScanPages * queryLimit,
        },
      };
    }
  }

  const hasMore = Boolean(afterDocId && afterSortValue);
  return {
    rows,
    pageInfo: {
      limit,
      returned: rows.length,
      scanned,
      hasMore,
      truncated: hasMore,
      nextCursor: hasMore && afterDocId && afterSortValue
        ? encodeDashboardPipelineCursor(input.source, afterDocId, afterSortValue)
        : null,
    },
    readStats: {
      queryCount,
      documentReads,
      documentReadUpperBound: maxScanPages * queryLimit,
    },
  };
}

/**
 * Reads the indexed updatedAtIso lane first, then continues with a bounded
 * document-id scan for legacy documents that do not have a usable updatedAtIso.
 * Both lanes share one query budget and one opaque cursor contract.
 */
export async function fillDashboardPipelineProjectionPageWithLegacy<T extends Record<string, unknown>>(
  input: DashboardPipelineProjectionLegacyFillInput<T>,
): Promise<DashboardPipelineProjectionPage<T> & { readStats: DashboardPipelineProjectionPageReadStats }> {
  const limit = normalizeDashboardPipelineLimit(input.limit);
  const maxScanPages = Math.max(1, Math.min(
    Math.trunc(input.maxScanPages ?? DASHBOARD_PIPELINE_MAX_SCAN_PAGES),
    DASHBOARD_PIPELINE_MAX_SCAN_PAGES,
  ));
  const queryLimit = limit + 1;
  const rows: T[] = [];
  const returnedDocumentIds = new Set<string>();
  let lane: DashboardPipelineProjectionLaneCursor["lane"] = input.cursor?.lane ?? "updated";
  let updatedAfterDocId = input.cursor?.lane === "updated" ? input.cursor.docId : undefined;
  let updatedAfterSortValue = input.cursor?.lane === "updated" ? input.cursor.sortValue : undefined;
  let legacyAfterDocId = input.cursor?.lane === "legacy" ? input.cursor.docId : undefined;
  let scanned = 0;
  let queryCount = 0;
  let documentReads = 0;

  const readStats = (): DashboardPipelineProjectionPageReadStats => ({
    queryCount,
    documentReads,
    documentReadUpperBound: maxScanPages * queryLimit,
  });
  const result = (hasMore: boolean): DashboardPipelineProjectionPage<T> & { readStats: DashboardPipelineProjectionPageReadStats } => ({
    rows,
    pageInfo: {
      limit,
      returned: rows.length,
      scanned,
      hasMore,
      truncated: hasMore,
      nextCursor: hasMore
        ? encodeDashboardPipelineLaneCursor(lane === "updated"
          ? {
              source: input.source,
              lane: "updated",
              docId: updatedAfterDocId as string,
              sortValue: updatedAfterSortValue as string,
            }
          : {
              source: input.source,
              lane: "legacy",
              ...(legacyAfterDocId ? { docId: legacyAfterDocId } : {}),
            })
        : null,
    },
    readStats: readStats(),
  });

  while (lane === "updated" && rows.length < limit && queryCount < maxScanPages) {
    const batch = await input.readUpdatedBatch({
      source: input.source,
      limit: queryLimit,
      ...(updatedAfterDocId && updatedAfterSortValue ? {
        afterDocId: updatedAfterDocId,
        afterSortValue: updatedAfterSortValue,
      } : {}),
    });
    queryCount += 1;
    documentReads += batch.length;
    const documents = batch.slice(0, limit);
    const hasExtraDocument = batch.length > limit;

    if (documents.length === 0) {
      lane = "legacy";
      break;
    }
    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index];
      updatedAfterDocId = document.id;
      updatedAfterSortValue = document.sortValue;
      scanned += 1;
      if (
        input.isUpdated(document)
        && input.isVisible(document)
        && !returnedDocumentIds.has(document.id)
      ) {
        returnedDocumentIds.add(document.id);
        rows.push(document.row);
      }
      if (rows.length >= limit) {
        const updatedHasMore = index < documents.length - 1 || hasExtraDocument;
        if (!updatedHasMore) lane = "legacy";
        return result(true);
      }
    }

    if (!hasExtraDocument) lane = "legacy";
  }

  while (lane === "legacy" && rows.length < limit && queryCount < maxScanPages) {
    const batch = await input.readLegacyBatch({
      source: input.source,
      limit: queryLimit,
      ...(legacyAfterDocId ? { afterDocId: legacyAfterDocId } : {}),
    });
    queryCount += 1;
    documentReads += batch.length;
    const documents = batch.slice(0, limit);
    const hasExtraDocument = batch.length > limit;

    if (documents.length === 0) return result(false);
    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index];
      legacyAfterDocId = document.id;
      scanned += 1;
      if (
        input.isLegacy(document)
        && input.isVisible(document)
        && !returnedDocumentIds.has(document.id)
      ) {
        returnedDocumentIds.add(document.id);
        rows.push(document.row);
      }
      if (rows.length >= limit) {
        const legacyHasMore = index < documents.length - 1 || hasExtraDocument;
        return result(legacyHasMore);
      }
    }

    if (!hasExtraDocument) return result(false);
  }

  return result(true);
}

export async function loadDashboardPipelineProjectionPages<
  TApplication extends Record<string, unknown> = Record<string, unknown>,
  TLead extends Record<string, unknown> = Record<string, unknown>,
  TCreator extends Record<string, unknown> = Record<string, unknown>,
  TConversation extends Record<string, unknown> = Record<string, unknown>,
>(input: DashboardPipelineProjectionLoadInput<TApplication, TLead, TCreator, TConversation>): Promise<{
  applications: TApplication[];
  programSheetLeads: TLead[];
  creators: TCreator[];
  conversations: TConversation[];
  pageInfo: {
    applications: DashboardPipelineProjectionPageInfo;
    programSheetLeads: DashboardPipelineProjectionPageInfo;
    creators: DashboardPipelineProjectionPageInfo;
    conversations: DashboardPipelineProjectionPageInfo;
  };
  performance: DashboardPipelineProjectionPerformance;
}> {
  const limit = normalizeDashboardPipelineLimit(input.requestedLimit);
  const clock = input.clock ?? Date.now;
  const startedAt = clock();
  const requests = [
    { source: "applications" as const, cursor: input.applicationCursor },
    { source: "leads" as const, cursor: input.leadCursor },
    { source: "creators" as const, cursor: input.creatorCursor },
    { source: "conversations" as const, cursor: input.conversationCursor },
  ];
  const isContinuation = requests.some((pageRequest) => Boolean(pageRequest.cursor));
  const activeRequests = isContinuation
    ? requests.filter((pageRequest) => Boolean(pageRequest.cursor))
    : requests;
  const pages = new Map<DashboardPipelineProjectionSource, DashboardPipelineProjectionPage<Record<string, unknown>>>();
  await Promise.all(activeRequests.map(async (pageRequest) => {
    const page = await input.readPage({
      source: pageRequest.source,
      limit,
      ...(pageRequest.cursor ? { cursor: pageRequest.cursor } : {}),
    });
    pages.set(pageRequest.source, page);
  }));
  const skippedPage = (): DashboardPipelineProjectionPage<Record<string, unknown>> => ({
    rows: [],
    pageInfo: {
      limit,
      returned: 0,
      scanned: 0,
      hasMore: false,
      truncated: false,
      nextCursor: null,
    },
    readStats: {
      queryCount: 0,
      documentReads: 0,
      documentReadUpperBound: 0,
    },
  });
  const applicationPage = pages.get("applications") ?? skippedPage();
  const leadPage = pages.get("leads") ?? skippedPage();
  const creatorPage = pages.get("creators") ?? skippedPage();
  const conversationPage = pages.get("conversations") ?? skippedPage();
  const durationMs = Math.max(0, Math.round(clock() - startedAt));
  const applicationReadStats = applicationPage.readStats ?? {
    queryCount: 1,
    documentReads: Math.min(limit + 1, applicationPage.pageInfo.scanned + (applicationPage.pageInfo.hasMore ? 1 : 0)),
    documentReadUpperBound: limit + 1,
  };
  const leadReadStats = leadPage.readStats ?? {
    queryCount: 1,
    documentReads: Math.min(limit + 1, leadPage.pageInfo.scanned + (leadPage.pageInfo.hasMore ? 1 : 0)),
    documentReadUpperBound: limit + 1,
  };
  const creatorReadStats = creatorPage.readStats ?? {
    queryCount: 1,
    documentReads: Math.min(limit + 1, creatorPage.pageInfo.scanned + (creatorPage.pageInfo.hasMore ? 1 : 0)),
    documentReadUpperBound: limit + 1,
  };
  const conversationReadStats = conversationPage.readStats ?? {
    queryCount: 1,
    documentReads: Math.min(limit + 1, conversationPage.pageInfo.scanned + (conversationPage.pageInfo.hasMore ? 1 : 0)),
    documentReadUpperBound: limit + 1,
  };
  return {
    applications: applicationPage.rows as TApplication[],
    programSheetLeads: leadPage.rows as TLead[],
    creators: creatorPage.rows as TCreator[],
    conversations: conversationPage.rows as TConversation[],
    pageInfo: {
      applications: applicationPage.pageInfo,
      programSheetLeads: leadPage.pageInfo,
      creators: creatorPage.pageInfo,
      conversations: conversationPage.pageInfo,
    },
    performance: {
      queryCount: applicationReadStats.queryCount + leadReadStats.queryCount + creatorReadStats.queryCount + conversationReadStats.queryCount,
      perRowReads: 0,
      documentReads: applicationReadStats.documentReads + leadReadStats.documentReads + creatorReadStats.documentReads + conversationReadStats.documentReads,
      documentReadUpperBound: applicationReadStats.documentReadUpperBound + leadReadStats.documentReadUpperBound + creatorReadStats.documentReadUpperBound + conversationReadStats.documentReadUpperBound,
      durationMs,
    },
  };
}
