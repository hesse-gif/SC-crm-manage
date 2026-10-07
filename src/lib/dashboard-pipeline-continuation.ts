import type {
  DashboardPipelineProjectionEnvelope,
  DashboardPipelineProjectionPageInfo,
  DashboardPipelineProjectionPayload,
} from "./data";

export const DASHBOARD_PIPELINE_CLIENT_MAX_AUTO_CONTINUATIONS = 4;

type ProjectionState = Pick<
  DashboardPipelineProjectionEnvelope,
  "applications" | "programSheetLeads" | "creators" | "conversations" | "pageInfo" | "performance"
>;

type ProjectionCollectionKey = "applications" | "programSheetLeads" | "creators" | "conversations";
type ProjectionCursorKey = "applicationCursor" | "leadCursor" | "creatorCursor" | "conversationCursor";

type PendingProjectionSource = {
  collectionKey: ProjectionCollectionKey;
  cursorKey: ProjectionCursorKey;
  cursor: string;
};

const PROJECTION_SOURCES: readonly Omit<PendingProjectionSource, "cursor">[] = [
  { collectionKey: "applications", cursorKey: "applicationCursor" },
  { collectionKey: "programSheetLeads", cursorKey: "leadCursor" },
  { collectionKey: "creators", cursorKey: "creatorCursor" },
  { collectionKey: "conversations", cursorKey: "conversationCursor" },
] as const;

function pendingProjectionSources(projection: ProjectionState): PendingProjectionSource[] {
  return PROJECTION_SOURCES.flatMap(({ collectionKey, cursorKey }) => {
    const pageInfo = projection.pageInfo[collectionKey];
    if (
      projection[collectionKey].length >= pageInfo.limit
      || !pageInfo.hasMore
      || !pageInfo.nextCursor
    ) return [];
    return [{ collectionKey, cursorKey, cursor: pageInfo.nextCursor }];
  });
}

function projectionRowId(row: unknown): string {
  if (!row || typeof row !== "object" || !("id" in row)) return "";
  const id = (row as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
}

function mergeRows<T>(current: T[], incoming: T[]): T[] {
  const rows = [...current];
  const indexById = new Map<string, number>();
  rows.forEach((row, index) => {
    const id = projectionRowId(row);
    if (id) indexById.set(id, index);
  });
  for (const row of incoming) {
    const id = projectionRowId(row);
    const existingIndex = id ? indexById.get(id) : undefined;
    if (existingIndex === undefined) {
      if (id) indexById.set(id, rows.length);
      rows.push(row);
    } else {
      rows[existingIndex] = row;
    }
  }
  return rows;
}

function mergePageInfo(
  current: DashboardPipelineProjectionPageInfo,
  incoming: DashboardPipelineProjectionPageInfo,
  returned: number,
): DashboardPipelineProjectionPageInfo {
  return {
    limit: current.limit,
    returned,
    scanned: current.scanned + incoming.scanned,
    hasMore: incoming.hasMore,
    truncated: incoming.hasMore,
    nextCursor: incoming.hasMore ? incoming.nextCursor : null,
  };
}

function mergeContinuation(
  current: ProjectionState,
  incoming: ProjectionState,
  pending: readonly PendingProjectionSource[],
): ProjectionState {
  const pendingKeys = new Set(pending.map((source) => source.collectionKey));
  const applications = pendingKeys.has("applications")
    ? mergeRows(current.applications, incoming.applications)
    : current.applications;
  const programSheetLeads = pendingKeys.has("programSheetLeads")
    ? mergeRows(current.programSheetLeads, incoming.programSheetLeads)
    : current.programSheetLeads;
  const creators = pendingKeys.has("creators")
    ? mergeRows(current.creators, incoming.creators)
    : current.creators;
  const conversations = pendingKeys.has("conversations")
    ? mergeRows(current.conversations, incoming.conversations)
    : current.conversations;

  return {
    applications,
    programSheetLeads,
    creators,
    conversations,
    pageInfo: {
      applications: pendingKeys.has("applications")
        ? mergePageInfo(current.pageInfo.applications, incoming.pageInfo.applications, applications.length)
        : current.pageInfo.applications,
      programSheetLeads: pendingKeys.has("programSheetLeads")
        ? mergePageInfo(current.pageInfo.programSheetLeads, incoming.pageInfo.programSheetLeads, programSheetLeads.length)
        : current.pageInfo.programSheetLeads,
      creators: pendingKeys.has("creators")
        ? mergePageInfo(current.pageInfo.creators, incoming.pageInfo.creators, creators.length)
        : current.pageInfo.creators,
      conversations: pendingKeys.has("conversations")
        ? mergePageInfo(current.pageInfo.conversations, incoming.pageInfo.conversations, conversations.length)
        : current.pageInfo.conversations,
    },
    // Continuations query only cursor-bearing sources. Preserve the exact server
    // evidence from every page so the aggregate remains a truthful upper bound.
    performance: {
      queryCount: current.performance.queryCount + incoming.performance.queryCount,
      perRowReads: 0,
      documentReads: current.performance.documentReads + incoming.performance.documentReads,
      documentReadUpperBound: current.performance.documentReadUpperBound + incoming.performance.documentReadUpperBound,
      durationMs: current.performance.durationMs + incoming.performance.durationMs,
    },
  };
}

export async function continueDashboardPipelineHiddenPages(input: {
  initial: ProjectionState;
  fetchPage: (payload: DashboardPipelineProjectionPayload) => Promise<ProjectionState>;
  onPage?: (projection: ProjectionState) => void;
  shouldContinue?: () => boolean;
  maxContinuations?: number;
}): Promise<ProjectionState> {
  const maxContinuations = Math.max(0, Math.min(
    Math.trunc(input.maxContinuations ?? DASHBOARD_PIPELINE_CLIENT_MAX_AUTO_CONTINUATIONS),
    DASHBOARD_PIPELINE_CLIENT_MAX_AUTO_CONTINUATIONS,
  ));
  let projection = input.initial;
  const stalledSources = new Set<ProjectionCollectionKey>();

  for (let index = 0; index < maxContinuations; index += 1) {
    if (input.shouldContinue && !input.shouldContinue()) break;
    const pending = pendingProjectionSources(projection)
      .filter((source) => !stalledSources.has(source.collectionKey));
    if (pending.length === 0) break;
    const payload: DashboardPipelineProjectionPayload = {
      limit: projection.pageInfo.applications.limit,
    };
    for (const source of pending) payload[source.cursorKey] = source.cursor;
    const page = await input.fetchPage(payload);
    for (const source of pending) {
      const pageInfo = page.pageInfo[source.collectionKey];
      if (pageInfo.hasMore && pageInfo.nextCursor === source.cursor) {
        stalledSources.add(source.collectionKey);
      }
    }
    projection = mergeContinuation(projection, page, pending);
    input.onPage?.(projection);
  }

  return projection;
}
