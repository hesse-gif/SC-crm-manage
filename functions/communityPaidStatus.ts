export type CreatorPaidStatus = "organic" | "contacted" | "paid";
export type PaidStatusConfidence = "exact" | "fuzzy_review";

export const CRM_IDENTITY_INDEX_READ_LIMIT = 500;

type CrmRow = Record<string, unknown>;

export type CreatorPaidStatusIndexRows = {
  candidatePool?: CrmRow[];
  recCandidates?: CrmRow[];
  creators?: CrmRow[];
  conversations?: CrmRow[];
  campaignOutreach?: CrmRow[];
  messageSources?: CrmRow[];
  contracts?: CrmRow[];
  reviews?: CrmRow[];
  submissions?: CrmRow[];
  reviewLedger?: CrmRow[];
  rawRecords?: CrmRow[];
};

type RowSource = keyof CreatorPaidStatusIndexRows;

type CreatorIdentityModule = {
  normalizeIdentityToken: (value: unknown) => string;
  canonicalCreatorId: (input: CrmRow) => string;
  identityTokenVariants: (value: unknown) => string[];
};

type FirestoreDoc = {
  id: string;
  data(): CrmRow | undefined;
};

type FirestoreQuery = {
  get(): Promise<{ docs: FirestoreDoc[] }>;
};

type FirestoreDb = {
  collection(name: string): {
    limit(value: number): FirestoreQuery;
  };
};

type ExactIndexEntry = {
  status: Exclude<CreatorPaidStatus, "organic">;
  creatorId: string;
  source: string;
};

type FuzzyIndexEntry = {
  creatorId: string;
  source: string;
};

type MutableCreatorRecord = {
  creatorId: string;
  exactKeys: Set<string>;
  fuzzyNames: Set<string>;
  status: CreatorPaidStatus;
  source: string;
};

export type CreatorPaidStatusIndex = {
  exact: Map<string, ExactIndexEntry>;
  fuzzyNames: Map<string, FuzzyIndexEntry>;
  readCounts: Record<string, number>;
  readLimit: number;
};

declare const require: ((id: string) => unknown) | undefined;

const STATUS_RANK: Record<CreatorPaidStatus, number> = { organic: 0, contacted: 1, paid: 2 };
const CONTACTED_STAGES = new Set(["contact", "negotiation", "contract", "review", "live"]);
const CONTRACT_PAID_STATUSES = new Set(["signed", "active", "live", "completed", "complete", "paid"]);
const BLOCKED_OUTREACH_STATUSES = new Set(["blocked", "failed", "bounced", "suppressed", "suppressed_duplicate", "cancelled"]);
const GENERIC_LOCAL_PARTS = new Set(["admin", "business", "collab", "contact", "hello", "info", "mail", "team", "work"]);

const FIRESTORE_SOURCES: Array<{ key: RowSource; collection: string }> = [
  { key: "candidatePool", collection: "candidate_pool" },
  { key: "recCandidates", collection: "rec_candidates" },
  { key: "creators", collection: "creators" },
  { key: "conversations", collection: "conversations" },
  { key: "campaignOutreach", collection: "campaign_outreach" },
  { key: "messageSources", collection: "message_sources" },
  { key: "contracts", collection: "contracts" },
  { key: "reviews", collection: "reviews" },
  { key: "submissions", collection: "submissions" },
  { key: "reviewLedger", collection: "review_ledger" },
  { key: "rawRecords", collection: "raw_records" },
];

function asRequireModule<T>(moduleName: string): T | null {
  if (typeof require !== "function") return null;
  return require(moduleName) as T;
}

function adminDbModule(): { adminDb: FirestoreDb } | null {
  return asRequireModule<{ adminDb: FirestoreDb }>("./firebaseAdmin");
}

async function creatorIdentityModule(): Promise<CreatorIdentityModule> {
  if (typeof require === "function") return require("./creatorIdentity") as CreatorIdentityModule;
  const tsExtension = ".ts";
  return import(`./creatorIdentity${tsExtension}`) as Promise<CreatorIdentityModule>;
}

function readString(row: CrmRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value.trim() : "";
}

function firstString(row: CrmRow, keys: readonly string[]): string {
  for (const key of keys) {
    const value = readString(row, key);
    if (value) return value;
  }
  return "";
}

function normalized(identity: CreatorIdentityModule, value: unknown): string {
  return identity.normalizeIdentityToken(value).replace(/^@/, "");
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function statusRank(status: CreatorPaidStatus): number {
  return STATUS_RANK[status] ?? 0;
}

function tokenKey(value: string): string {
  return `token:${value}`;
}

function idKey(value: string): string {
  return `id:${value}`;
}

function exactTokenKeys(identity: CreatorIdentityModule, value: unknown): string[] {
  const tokens = identity.identityTokenVariants(value)
    .map((token) => normalized(identity, token))
    .filter((token) => token.length >= 3 && !GENERIC_LOCAL_PARTS.has(token));
  return unique(tokens.map(tokenKey));
}

function emailTokenKeys(identity: CreatorIdentityModule, value: unknown): string[] {
  const email = identity.normalizeIdentityToken(value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return [];
  const local = email.split("@")[0];
  const keys = [`email:${email}`];
  if (local.length >= 4 && !GENERIC_LOCAL_PARTS.has(local)) keys.push(tokenKey(local));
  return keys;
}

function channelTokenKeys(identity: CreatorIdentityModule, value: unknown): string[] {
  const token = normalized(identity, value);
  if (!token || token.length < 4) return [];
  return [`channel:${token}`, tokenKey(token)];
}

function urlTokenKeys(identity: CreatorIdentityModule, value: unknown): string[] {
  const text = readUrlText(value);
  if (!text) return [];
  try {
    const url = new URL(text.startsWith("http") ? text : `https://${text}`);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);
    const keys: string[] = [];
    if (host.endsWith("youtube.com")) {
      const handlePart = parts.find((part) => part.startsWith("@"));
      if (handlePart) keys.push(...exactTokenKeys(identity, handlePart));
      const channelIndex = parts.indexOf("channel");
      if (channelIndex >= 0 && parts[channelIndex + 1]) keys.push(...channelTokenKeys(identity, parts[channelIndex + 1]));
    }
    if (host === "x.com" || host === "twitter.com") {
      const handle = parts[0] && parts[0] !== "search" ? parts[0] : "";
      if (handle) keys.push(...exactTokenKeys(identity, `@${handle}`));
    }
    if (host.endsWith("reddit.com")) {
      const userIndex = parts.findIndex((part) => part === "u" || part === "user");
      if (userIndex >= 0 && parts[userIndex + 1]) keys.push(...exactTokenKeys(identity, `@${parts[userIndex + 1]}`));
    }
    return unique(keys);
  } catch {
    return [];
  }
}

function readUrlText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function exactIdKeys(identity: CreatorIdentityModule, row: CrmRow, keys: readonly string[]): string[] {
  return unique(keys.map((key) => normalized(identity, row[key])).filter(Boolean).map(idKey));
}

function exactKeysForRow(identity: CreatorIdentityModule, row: CrmRow, source: RowSource): string[] {
  const includeDocId = source === "candidatePool" || source === "recCandidates" || source === "creators";
  const idFields = includeDocId ? ["creatorId", "candidateId", "targetId", "id"] : ["creatorId", "candidateId", "targetId"];
  const emailFields = source === "campaignOutreach"
    ? ["email", "creatorEmail", "profileMatchedEmail", "to"]
    : ["email", "creatorEmail", "profileMatchedEmail"];
  return unique([
    ...exactIdKeys(identity, row, idFields),
    ...exactTokenKeys(identity, firstString(row, ["handle", "creatorHandle"])),
    ...emailTokenKeys(identity, firstString(row, emailFields)),
    ...channelTokenKeys(identity, firstString(row, ["channelId", "channelRef"])),
    ...urlTokenKeys(identity, firstString(row, ["youtubeUrl", "profileUrl", "sourceUrl", "externalProfileUrl"])),
  ]);
}

function fuzzyNameForValue(identity: CreatorIdentityModule, value: unknown): string {
  const token = identity.normalizeIdentityToken(value).replace(/^@/, "");
  if (!token || token.includes("@")) return "";
  const compact = token.replace(/[^a-z0-9\uac00-\ud7a3]+/gi, "");
  return compact.length >= 5 ? compact : "";
}

function fuzzyNamesForRow(identity: CreatorIdentityModule, row: CrmRow): string[] {
  return unique([
    fuzzyNameForValue(identity, row.name),
    fuzzyNameForValue(identity, row.creatorName),
    fuzzyNameForValue(identity, row.channelTitle),
  ]);
}

function rowCreatorId(identity: CreatorIdentityModule, row: CrmRow, source: RowSource): string {
  const includeDocId = source === "candidatePool" || source === "recCandidates" || source === "creators";
  const explicit = firstString(row, includeDocId ? ["creatorId", "candidateId", "targetId", "id"] : ["creatorId", "candidateId", "targetId"]);
  if (explicit) return explicit.replace(/^candidate:/, "");
  return identity.canonicalCreatorId({
    creatorId: row.creatorId,
    candidateId: row.candidateId,
    email: row.email,
    creatorEmail: row.creatorEmail,
    handle: row.handle,
    creatorHandle: row.creatorHandle,
    name: row.name,
    creatorName: row.creatorName,
    channelId: row.channelId,
    youtubeUrl: row.youtubeUrl,
  });
}

function hasAnyIdentity(row: CrmRow): boolean {
  return Boolean(firstString(row, [
    "creatorId", "candidateId", "targetId", "handle", "creatorHandle", "email", "creatorEmail", "channelId", "youtubeUrl",
  ]));
}

function rowHasPaidSignal(row: CrmRow, source: RowSource): boolean {
  const payableStatus = readString(row, "payableStatus").toLowerCase();
  const paymentStatus = readString(row, "paymentStatus").toLowerCase();
  const status = readString(row, "status").toLowerCase();
  const type = readString(row, "type").toLowerCase();
  if (payableStatus === "paid" || paymentStatus === "paid" || row.paid === true || readString(row, "paidAt")) return true;
  if (source === "contracts" && CONTRACT_PAID_STATUSES.has(status)) return true;
  if (source === "rawRecords" && status === "paid" && (type === "payment" || type === "payout" || type === "\uc9c0\uae09")) return true;
  if (source === "rawRecords" && status === "signed" && (type === "contract" || type === "\uacc4\uc57d")) return true;
  return false;
}

function rowHasContactSignal(row: CrmRow, source: RowSource): boolean {
  if (!hasAnyIdentity(row)) return false;
  if (source === "conversations" || source === "messageSources" || source === "contracts") return true;
  if (source === "campaignOutreach") {
    const state = (readString(row, "deliveryState") || readString(row, "status")).toLowerCase();
    return !BLOCKED_OUTREACH_STATUSES.has(state);
  }
  if (source === "creators") return CONTACTED_STAGES.has(readString(row, "stage").toLowerCase());
  if (source === "rawRecords") {
    const type = readString(row, "type").toLowerCase();
    return type === "contact" || type === "outreach" || type === "reply" || type === "negotiation"
      || type === "\ucee8\ud0dd" || type === "\ud68c\uc2e0" || type === "\ud611\uc758";
  }
  return false;
}

function rowStatus(row: CrmRow, source: RowSource): CreatorPaidStatus {
  if (rowHasPaidSignal(row, source)) return "paid";
  if (rowHasContactSignal(row, source)) return "contacted";
  return "organic";
}

function mergeRecord(records: Map<string, MutableCreatorRecord>, input: {
  creatorId: string;
  exactKeys: string[];
  fuzzyNames: string[];
  status: CreatorPaidStatus;
  source: string;
}) {
  if (!input.creatorId) return;
  const record = records.get(input.creatorId) ?? {
    creatorId: input.creatorId,
    exactKeys: new Set<string>(),
    fuzzyNames: new Set<string>(),
    status: "organic" as CreatorPaidStatus,
    source: input.source,
  };
  for (const key of input.exactKeys) record.exactKeys.add(key);
  for (const name of input.fuzzyNames) record.fuzzyNames.add(name);
  if (statusRank(input.status) > statusRank(record.status)) {
    record.status = input.status;
    record.source = input.source;
  }
  records.set(input.creatorId, record);
}

function addExactEntry(map: Map<string, ExactIndexEntry>, key: string, entry: ExactIndexEntry) {
  const existing = map.get(key);
  if (!existing || statusRank(entry.status) > statusRank(existing.status)) map.set(key, entry);
}

function exactKeysForArtifact(identity: CreatorIdentityModule, artifact: CrmRow): string[] {
  const author = firstString(artifact, ["author", "byline"]);
  const handleishAuthor = author.startsWith("@") || author.includes("@") ? author : "";
  return unique([
    ...exactIdKeys(identity, artifact, ["creatorId", "candidateId"]),
    ...exactTokenKeys(identity, firstString(artifact, ["handle", "creatorHandle"])),
    ...exactTokenKeys(identity, handleishAuthor),
    ...emailTokenKeys(identity, firstString(artifact, ["email", "creatorEmail", "author"])),
    ...channelTokenKeys(identity, firstString(artifact, ["channelId", "channelRef"])),
    ...urlTokenKeys(identity, firstString(artifact, ["youtubeUrl", "sourceUrl", "externalProfileUrl"])),
  ]);
}

function fuzzyTextForArtifact(identity: CreatorIdentityModule, artifact: CrmRow): string {
  return [
    artifact.name,
    artifact.creatorName,
    artifact.author,
    artifact.title,
    artifact.excerpt,
  ]
    .map((value) => identity.normalizeIdentityToken(value).replace(/[^a-z0-9\uac00-\ud7a3]+/gi, ""))
    .join(" ");
}

function applyPaidStatus<T extends CrmRow>(artifact: T, patch: CrmRow): T {
  return { ...artifact, ...patch };
}

async function readCollectionRows(collection: string, limit: number): Promise<CrmRow[]> {
  const module = adminDbModule();
  if (!module) return [];
  try {
    const snapshot = await module.adminDb.collection(collection).limit(limit).get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() ?? {}) }));
  } catch (error) {
    console.warn("community paidStatus CRM read failed", {
      collection,
      reason: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function buildCreatorPaidStatusIndexFromRows(
  rows: CreatorPaidStatusIndexRows,
  readLimit = CRM_IDENTITY_INDEX_READ_LIMIT,
): Promise<CreatorPaidStatusIndex> {
  const identity = await creatorIdentityModule();
  const records = new Map<string, MutableCreatorRecord>();
  const readCounts: Record<string, number> = {};

  for (const { key } of FIRESTORE_SOURCES) {
    const sourceRows = rows[key] ?? [];
    readCounts[key] = sourceRows.length;
    for (const row of sourceRows.slice(0, readLimit)) {
      mergeRecord(records, {
        creatorId: rowCreatorId(identity, row, key),
        exactKeys: exactKeysForRow(identity, row, key),
        fuzzyNames: fuzzyNamesForRow(identity, row),
        status: rowStatus(row, key),
        source: key,
      });
    }
  }

  const exact = new Map<string, ExactIndexEntry>();
  const fuzzyNames = new Map<string, FuzzyIndexEntry>();
  for (const record of records.values()) {
    if (record.status !== "organic") {
      for (const key of record.exactKeys) {
        addExactEntry(exact, key, { status: record.status, creatorId: record.creatorId, source: record.source });
      }
    }
    for (const name of record.fuzzyNames) {
      if (!fuzzyNames.has(name)) fuzzyNames.set(name, { creatorId: record.creatorId, source: record.source });
    }
  }

  return { exact, fuzzyNames, readCounts, readLimit };
}

export async function buildCreatorPaidStatusIndex(
  readLimit = CRM_IDENTITY_INDEX_READ_LIMIT,
): Promise<CreatorPaidStatusIndex> {
  const pairs = await Promise.all(
    FIRESTORE_SOURCES.map(async ({ key, collection }) => [key, await readCollectionRows(collection, readLimit)] as const),
  );
  return buildCreatorPaidStatusIndexFromRows(Object.fromEntries(pairs) as CreatorPaidStatusIndexRows, readLimit);
}

export async function enrichCommunityArtifactsWithPaidStatus<T extends CrmRow>(
  artifacts: readonly T[],
  index: CreatorPaidStatusIndex,
): Promise<T[]> {
  const identity = await creatorIdentityModule();
  return artifacts.map((artifact) => {
    for (const key of exactKeysForArtifact(identity, artifact)) {
      const match = index.exact.get(key);
      if (match) {
        return applyPaidStatus(artifact, {
          paidStatus: match.status,
          paidStatusConfidence: "exact",
          paidStatusCandidateId: match.creatorId,
        });
      }
    }

    const fuzzyText = fuzzyTextForArtifact(identity, artifact);
    for (const [name, match] of index.fuzzyNames) {
      if (fuzzyText.includes(name)) {
        return applyPaidStatus(artifact, {
          paidStatus: "organic",
          paidStatusReview: true,
          paidStatusCandidateId: match.creatorId,
          paidStatusConfidence: "fuzzy_review",
        });
      }
    }

    return applyPaidStatus(artifact, { paidStatus: "organic" });
  });
}
