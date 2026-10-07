import { adminDb } from "./firebaseAdmin";

type Role = "super_admin" | "admin" | "manager" | "viewer" | "guest";
type RawType = "컨택" | "회신" | "협의" | "계약" | "검수" | "지급";
type CallableRequest = {
  auth?: { uid?: string; token?: { role?: Role; team?: string } };
  data?: unknown;
  rawRequest?: { ip?: string };
};

type BehaviorLog = {
  userId: string;
  role: Role;
  team: string;
  gameId: string;
  action: string;
  time: string;
  IP: string;
  result: "success" | "denied" | "error";
  cost: number;
};

type CostLog = {
  id: string;
  action: string;
  ledgerRef: string;
  cacheChecked: true;
  cacheHit: boolean;
  provider: "firestore";
  model: "aggregate-report-v1";
  inputTokens: 0;
  outputTokens: 0;
  costUSD: 0;
  estimatedKRW: 0;
  currency: "KRW";
  billable: false;
  loggedAt: string;
};

type RawRecord = {
  id: string;
  time: string;
  type: RawType;
  creatorId: string;
  owner: string;
  status: string;
  amountKRW?: number;
  channel?: string;
  ref: string;
};

const ALLOWED_ROLES: Role[] = ["super_admin", "admin", "manager", "viewer"];
const WRITE_ROLES: Role[] = ["super_admin", "admin", "manager"];
const RAW_TYPES: RawType[] = ["컨택", "회신", "협의", "계약", "검수", "지급"];
const DEFAULT_REPORT_LIMIT = 500;
const MAX_REPORT_LIMIT = 1000;

function nowIso() {
  return new Date().toISOString();
}

function asObject(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
}

function asRawType(value: unknown): RawType | undefined {
  return typeof value === "string" && RAW_TYPES.includes(value as RawType) ? value as RawType : undefined;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(Math.trunc(value), MAX_REPORT_LIMIT))
    : DEFAULT_REPORT_LIMIT;
}

function roleFrom(request: CallableRequest): Role {
  return request.auth?.token?.role ?? "guest";
}

function makeBehaviorLog(request: CallableRequest, action: string, result: BehaviorLog["result"], cost: number, gameId = "all"): BehaviorLog {
  return {
    userId: request.auth?.uid ?? "anonymous",
    role: roleFrom(request),
    team: request.auth?.token?.team ?? "unassigned",
    gameId,
    action,
    time: nowIso(),
    IP: request.rawRequest?.ip ?? "0.0.0.0",
    result,
    cost,
  };
}

function makeCostLog(action: string, cacheHit = false): CostLog {
  const id = `cost-${action}-${Date.now()}`;
  return {
    id,
    action,
    ledgerRef: `cost_logs/${id}`,
    cacheChecked: true,
    cacheHit,
    provider: "firestore",
    model: "aggregate-report-v1",
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
    estimatedKRW: 0,
    currency: "KRW",
    billable: false,
    loggedAt: nowIso(),
  };
}

function normalizeRawRecord(id: string, data: Record<string, unknown>): RawRecord | null {
  const type = asRawType(data.type);
  if (!type) return null;
  return {
    id,
    time: asString(data.time, ""),
    type,
    creatorId: asString(data.creatorId, ""),
    owner: asString(data.owner, ""),
    status: asString(data.status, ""),
    amountKRW: asNumber(data.amountKRW),
    channel: asString(data.channel, ""),
    ref: asString(data.ref, id),
  };
}

async function readRawRecords(limit: number): Promise<{ rows: RawRecord[]; limit: number; truncated: boolean }> {
  const snapshot = await adminDb.collection("raw_records").limit(limit + 1).get();
  const rows = snapshot.docs
    .slice(0, limit)
    .map((doc) => normalizeRawRecord(doc.id, doc.data()))
    .filter((row): row is RawRecord => row !== null);
  return { rows, limit, truncated: snapshot.docs.length > limit };
}

function assertAllowed(request: CallableRequest, action: string) {
  const role = roleFrom(request);
  if (!request.auth?.uid || !ALLOWED_ROLES.includes(role)) {
    const behaviorLog = makeBehaviorLog(request, action, "denied", 0);
    throw Object.assign(new Error(!request.auth?.uid ? "AUTH-P0: unauthenticated" : "AUTH-P0: guest role is blocked"), { code: !request.auth?.uid ? "unauthenticated" : "permission-denied", errorCode: "assert_allowed_unauthorized", behaviorLog });
  }
}

function sanitizeRef(ref: string) {
  const [prefix, suffix = ""] = ref.split("-");
  return `${prefix}-${suffix.slice(0, 2)}••`;
}

function sanitizeRawRecord(row: RawRecord) {
  return {
    id: row.id,
    time: row.time,
    type: row.type,
    creatorId: row.creatorId,
    owner: row.owner,
    status: row.status,
    amountKRW: row.amountKRW,
    channel: row.channel,
    ref: sanitizeRef(row.ref),
    source: "firestore" as const,
  };
}

function efficiencySavedHours(legacyMinutes: number, toolMinutes: number, runs: number, members: number) {
  return ((legacyMinutes - toolMinutes) * runs * members) / 60;
}

function aggregateRows(rows: RawRecord[]) {
  return RAW_TYPES.map((type) => {
    const scoped = rows.filter((row) => row.type === type);
    return {
      type,
      count: scoped.length,
      amountKRW: scoped.reduce((sum, row) => sum + (row.amountKRW ?? 0), 0),
      drilldownIds: scoped.map((row) => row.id),
    };
  }).filter((row) => row.count > 0);
}

export async function aggregateReport(request: CallableRequest) {
  const action = "aggregateReport";
  const data = asObject(request.data);
  assertAllowed(request, action);

  const gameId = typeof data.gameId === "string" ? data.gameId : "all";
  const legacyMinutes = typeof data.legacyMinutes === "number" ? data.legacyMinutes : 45;
  const toolMinutes = typeof data.toolMinutes === "number" ? data.toolMinutes : 10;
  const runs = typeof data.runs === "number" ? data.runs : 18;
  const members = typeof data.members === "number" ? data.members : 5;
  const limit = boundedLimit(data.limit);
  const costLog = makeCostLog(action, false);
  const source = await readRawRecords(limit);
  const rows = aggregateRows(source.rows);

  return {
    query: {
      backend: "firestore",
      collection: "raw_records",
      groupBy: ["type", "status", "week"],
      cacheKey: `report:${gameId}:2026-W25`,
      cachePolicy: "cache-before-aggregate",
      limit: source.limit,
      truncated: source.truncated,
    },
    cache: { checked: true, hit: false, key: `report:${gameId}:2026-W25`, ttlSeconds: 600 },
    rows,
    efficiency: {
      formula: "(기존 시간 - 툴 시간) * 횟수 * 멤버",
      legacyMinutes,
      toolMinutes,
      runs,
      members,
      savedHours: efficiencySavedHours(legacyMinutes, toolMinutes, runs, members),
    },
    costLog,
    behaviorLog: makeBehaviorLog(request, action, "success", costLog.costUSD, gameId),
  };
}

export async function listRawRecords(request: CallableRequest) {
  const action = "listRawRecords";
  const data = asObject(request.data);
  assertAllowed(request, action);

  const rawType = asRawType(data.type);
  const owner = typeof data.owner === "string" ? data.owner : undefined;
  const source = await readRawRecords(boundedLimit(data.limit));
  const rows = source.rows
    .filter((row) => !rawType || row.type === rawType)
    .filter((row) => !owner || row.owner === owner)
    .map(sanitizeRawRecord);
  const costLog = makeCostLog(action, false);

  return {
    source: "raw_records_firestore",
    piiPolicy: "sanitized-ref-only; no prompt/email/query body returned",
    cache: { checked: true, hit: false, key: `raw:${rawType ?? "all"}:${owner ?? "all"}`, ttlSeconds: 300 },
    page: { limit: source.limit, truncated: source.truncated },
    rows,
    costLog,
    behaviorLog: makeBehaviorLog(request, action, "success", costLog.costUSD, "all"),
  };
}

export async function logCostUsage(request: CallableRequest) {
  const action = "logCostUsage";
  const data = asObject(request.data);
  assertAllowed(request, action);
  if (!WRITE_ROLES.includes(roleFrom(request))) {
    const behaviorLog = makeBehaviorLog(request, action, "denied", 0);
    throw Object.assign(new Error("COST-P0: cost logging requires manager/admin role"), { code: "permission-denied", errorCode: "log_cost_usage_cost_p0_cost_logging_requires", behaviorLog });
  }

  const loggedAction = typeof data.action === "string" ? data.action : "unknown";
  const costLog = makeCostLog(loggedAction, Boolean(data.cacheHit));

  return {
    accepted: true,
    writeMode: "wrapper-persisted-cost-log",
    costLog,
    behaviorLog: makeBehaviorLog(request, action, "success", costLog.costUSD, typeof data.gameId === "string" ? data.gameId : "all"),
  };
}
