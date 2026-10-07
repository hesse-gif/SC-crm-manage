import { adminDb } from "./firebaseAdmin";
import { FieldValue } from "firebase-admin/firestore";

export type Role = "super_admin" | "admin" | "manager" | "viewer" | "guest";
type Stage = "contact" | "negotiation" | "contract" | "review" | "live";
type GuideStatus = "within" | "near" | "over";
type Platform = "YouTube" | "Instagram" | "TikTok" | "X";

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
  result: "allow" | "deny" | "mock";
  cost: number;
};

type CreatorRecord = {
  id: string;
  name: string;
  handle: string;
  avatar: string;
  email?: string;
  type: "influencer" | "agency";
  platform: Platform;
  followers?: number;
  region: string;
  category: string;
  stage: Stage;
  owner: string;
  budgetKRW: number;
  guideStatus: GuideStatus;
  aiHandling: boolean;
  agencyId?: string;
  team: string;
  lastActivity?: string;
  primaryPlatform?: Platform;
  profileMatchedEmail?: string;
  youtubeUrl?: string;
  channelId?: string;
  sourceNote?: string;
  sourceTag?: string;
  discoverySource?: string;
  protected?: boolean;
};

type ChannelMetric = {
  creatorRef: string;
  channelRef: string;
  avgViews: number;
  recentViews: number;
  engagement: number;
  longAvgViews: number;
  metricSource: "infly.long_avg_views";
};

type CacheMeta = {
  key: string;
  hit: boolean;
  ttlSeconds: number;
};

type CostLog = {
  service: "mock-crm";
  operation: string;
  tokensIn: number;
  tokensOut: number;
  costKRW: number;
};

const WRITER_ROLES: Role[] = ["super_admin", "admin", "manager"];
const STAGE_FLOW: Record<Stage, Stage[]> = {
  contact: ["negotiation"],
  negotiation: ["contract"],
  contract: ["review"],
  review: ["live"],
  live: [],
};

const nowIso = () => new Date().toISOString();

function roleFrom(request: CallableRequest): Role {
  return request.auth?.token?.role ?? "guest";
}

function behaviorLog(request: CallableRequest, action: string, result: BehaviorLog["result"], cost = 0): BehaviorLog {
  return {
    userId: request.auth?.uid ?? "anonymous",
    role: roleFrom(request),
    team: request.auth?.token?.team ?? "unassigned",
    gameId: "flu",
    action,
    time: nowIso(),
    IP: request.rawRequest?.ip ?? "0.0.0.0",
    result,
    cost,
  };
}

function requireWriter(request: CallableRequest, action: string): BehaviorLog | undefined {
  const role = roleFrom(request);
  if (request.auth?.uid && WRITER_ROLES.includes(role)) return undefined;
  return behaviorLog(request, action, "deny");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStage(value: unknown): value is Stage {
  return value === "contact" || value === "negotiation" || value === "contract" || value === "review" || value === "live";
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function emailValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim();
  return email.includes("@") ? email : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function platformValue(value: unknown): Platform {
  return value === "Instagram" || value === "TikTok" || value === "X" ? value : "YouTube";
}

function guideStatusValue(value: unknown): GuideStatus {
  return value === "near" || value === "over" ? value : "within";
}

function creatorTypeValue(value: unknown): CreatorRecord["type"] {
  return value === "agency" ? "agency" : "influencer";
}

function sanitizeCreator(input: unknown): CreatorRecord {
  const data = isRecord(input) ? input : {};
  const id = stringValue(data.id, `creator-${Date.now()}`);
  const team = stringValue(data.team, "flu");

  return {
    id,
    name: stringValue(data.name, "Unnamed creator"),
    handle: stringValue(data.handle, `@${id}`),
    avatar: stringValue(data.avatar, stringValue(data.name, id).slice(0, 1).toUpperCase()),
    ...(emailValue(data.email) ? { email: emailValue(data.email) } : {}),
    type: creatorTypeValue(data.type),
    platform: platformValue(data.platform),
    ...(typeof data.followers === "number" && Number.isFinite(data.followers) && data.followers >= 0
      ? { followers: data.followers }
      : {}),
    region: stringValue(data.region, "unknown"),
    category: stringValue(data.category, "uncategorized"),
    stage: isStage(data.stage) ? data.stage : "contact",
    owner: stringValue(data.owner, "unassigned"),
    budgetKRW: numberValue(data.budgetKRW, 0),
    guideStatus: guideStatusValue(data.guideStatus),
    aiHandling: boolValue(data.aiHandling, false),
    ...(optionalString(data.agencyId) ? { agencyId: optionalString(data.agencyId) } : {}),
    ...(optionalString(data.lastActivity) ? { lastActivity: optionalString(data.lastActivity) } : {}),
    ...(platformValue(data.primaryPlatform) ? { primaryPlatform: platformValue(data.primaryPlatform) } : {}),
    ...(emailValue(data.profileMatchedEmail) ? { profileMatchedEmail: emailValue(data.profileMatchedEmail) } : {}),
    ...(optionalString(data.youtubeUrl) ? { youtubeUrl: optionalString(data.youtubeUrl) } : {}),
    ...(optionalString(data.channelId) ? { channelId: optionalString(data.channelId) } : {}),
    ...(optionalString(data.sourceNote) ? { sourceNote: optionalString(data.sourceNote) } : {}),
    ...(optionalString(data.sourceTag) ? { sourceTag: optionalString(data.sourceTag) } : {}),
    ...(optionalString(data.discoverySource) ? { discoverySource: optionalString(data.discoverySource) } : {}),
    ...(typeof data.protected === "boolean" ? { protected: data.protected } : {}),
    team,
  };
}

const REC_COLLECTIONS = ["candidate_pool", "rec_candidates"] as const;

function deleteCandidateQueries(collection: (typeof REC_COLLECTIONS)[number], creator: CreatorRecord): Promise<unknown>[] {
  const queries: Promise<unknown>[] = [
    adminDb.collection(collection).doc(creator.id).delete(),
  ];
  const filters = [
    ["id", creator.id],
    ["handle", creator.handle],
    ["name", creator.name],
  ] as const;

  for (const [field, value] of filters) {
    queries.push(
      adminDb.collection(collection).where(field, "==", value).limit(25).get().then((snapshot) =>
        Promise.all(snapshot.docs.map((doc) => doc.ref.delete())),
      ),
    );
  }

  return queries;
}

async function removeRecommendationCandidate(creator: CreatorRecord): Promise<void> {
  await Promise.allSettled(REC_COLLECTIONS.flatMap((collection) => deleteCandidateQueries(collection, creator)));
}

function parseCreatorRef(data: unknown): string {
  if (!isRecord(data)) return "creators/unknown";
  const explicitRef = typeof data.creatorRef === "string" ? data.creatorRef.trim() : "";
  if (explicitRef.startsWith("creators/")) return explicitRef;
  const creatorId = stringValue(data.creatorId, "unknown");
  return `creators/${creatorId}`;
}

function sanitizeMetrics(data: unknown): ChannelMetric {
  const record = isRecord(data) ? data : {};
  const creatorRef = parseCreatorRef(record);
  const channelId = stringValue(record.channelId, creatorRef.split("/").at(-1) ?? "unknown");
  const longAvgViews = numberValue(record.longAvgViews, numberValue(record.avgViews, 0));
  const recentViews = numberValue(record.recentViews, Math.round(longAvgViews * 0.9));
  const engagement = numberValue(record.engagement, 0);

  return {
    creatorRef,
    channelRef: `channels/${channelId}`,
    avgViews: longAvgViews,
    recentViews,
    engagement,
    longAvgViews,
    metricSource: "infly.long_avg_views",
  };
}

function costLog(operation: string, costKRW = 0): CostLog {
  return {
    service: "mock-crm",
    operation,
    tokensIn: 0,
    tokensOut: 0,
    costKRW,
  };
}

export async function upsertCreator(request: CallableRequest) {
  const deniedLog = requireWriter(request, "crm.creator.upsert");
  if (deniedLog) {
    throw Object.assign(new Error("permission-denied: creator upsert requires manager/admin role"), {
      code: "permission-denied", errorCode: "upsert_creator_creator_upsert_requires_manager_admin",
      behaviorLog: deniedLog,
    });
  }

  const creator = sanitizeCreator(request.data);
  const creatorRef = `creators/${creator.id}`;
  const agencyRef = creator.agencyId ? `agencies/${creator.agencyId}` : undefined;

  try {
    const nowIsoValue = nowIso();
    const existingCreatorSnapshot = await adminDb.collection("creators").doc(creator.id).get();
    const existingCreatorData = existingCreatorSnapshot.exists ? existingCreatorSnapshot.data() ?? {} : {};
    const existingCreatorCreatedAtIso = typeof existingCreatorData.createdAtIso === "string" && existingCreatorData.createdAtIso
      ? existingCreatorData.createdAtIso
      : nowIsoValue;

    await adminDb.collection("creators").doc(creator.id).set({
      ...creator,
      firestorePath: `creators/${creator.id}`,
      createdAtIso: existingCreatorCreatedAtIso,
      updatedAt: nowIsoValue,
      updatedAtIso: nowIsoValue,
    }, { merge: true });

    // Best-effort: persist channel metrics when the payload carries them. Absent metrics must
    // not fail the whole creator upsert.
    const data = isRecord(request.data) ? request.data : {};
    const hasMetrics = ["followers", "avgViews", "recentViews", "engagement"].some(
      (field) => typeof data[field] === "number" && Number.isFinite(data[field]),
    );
    if (hasMetrics) {
      const metrics = sanitizeMetrics(request.data);
      try {
        await adminDb.collection("channel_stats").doc(creator.id).set({
          id: creator.id,
          avgViews: metrics.avgViews,
          recentViews: metrics.recentViews,
          engagement: metrics.engagement,
          updatedAt: nowIsoValue,
          updatedAtIso: nowIsoValue,
        }, { merge: true });
      } catch {
        // metrics write is best-effort — ignore.
      }
    }

    await removeRecommendationCandidate(creator);

    return {
      ok: true,
      mode: "live",
      persisted: true,
      creatorRef,
      agencyRef,
      creator,
      behaviorLog: behaviorLog(request, "crm.creator.upsert", "allow"),
    };
  } catch (error) {
    const failureLog = behaviorLog(request, "crm.creator.upsert", "deny");
    throw Object.assign(new Error(error instanceof Error ? error.message : "creator-upsert-failed"), {
      code: "failed-precondition", errorCode: "upsert_creator_unauthorized",
      behaviorLog: failureLog,
    });
  }
}

export async function transitionCreatorStage(request: CallableRequest) {
  const deniedLog = requireWriter(request, "crm.stage.transition");
  if (deniedLog) {
    return { ok: false, error: "permission-denied", behaviorLog: deniedLog };
  }

  const data = isRecord(request.data) ? request.data : {};
  const from = isStage(data.from) ? data.from : undefined;
  const to = isStage(data.to) ? data.to : undefined;
  const creatorRef = parseCreatorRef(data);

  if (!from || !to || !STAGE_FLOW[from].includes(to)) {
    return {
      ok: false,
      error: "invalid-stage-transition",
      creatorRef,
      allowedNextStages: from ? STAGE_FLOW[from] : [],
      behaviorLog: behaviorLog(request, "crm.stage.transition", "deny"),
    };
  }

  const now = nowIso();
  try {
    await adminDb.doc(creatorRef).set({
      stage: to,
      updatedAt: now,
      updatedAtIso: now,
      lastActivity: `단계 전환: ${from} → ${to}`,
      stageTimeline: FieldValue.arrayUnion({
        from,
        to,
        at: now,
        source: "transitionCreatorStage",
        actor: request.auth?.uid ?? "system",
      }),
    }, { merge: true });
    return {
      ok: true,
      mode: "live",
      persisted: true,
      creatorRef,
      transition: { from, to },
      behaviorLog: behaviorLog(request, "crm.stage.transition", "allow"),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "stage-transition-write-failed",
      creatorRef,
      transition: { from, to },
      behaviorLog: behaviorLog(request, "crm.stage.transition", "deny"),
    };
  }
}

export async function syncChannelStats(request: CallableRequest) {
  const deniedLog = requireWriter(request, "crm.channel.sync");
  if (deniedLog) {
    return { ok: false, error: "permission-denied", behaviorLog: deniedLog };
  }

  const metrics = sanitizeMetrics(request.data);
  const cache: CacheMeta = {
    key: `crm:channel:${metrics.channelRef}:long_avg_views`,
    hit: true,
    ttlSeconds: 3600,
  };
  const cost = costLog("syncChannelStats");

  return {
    ok: true,
    mode: "mock-spark",
    metrics,
    cache,
    costLog: cost,
    behaviorLog: behaviorLog(request, "crm.channel.sync", "mock", cost.costKRW),
  };
}
