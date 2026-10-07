import { readFile } from "node:fs/promises";

const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "demo-flu";
const firestoreHost = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").replace(/^https?:\/\//, "");
const databaseUrl = `http://${firestoreHost}/v1/projects/${project}/databases/(default)`;
const documentsUrl = `${databaseUrl}/documents`;
const root = new URL("..", import.meta.url);
const bulkMode = process.argv.includes("--bulk") || process.env.ASSERT_BULK === "1";
const ORDERED_QUERY_LIMIT = 1000;
const BULK_MINIMUM_COUNTS = {
  creators: 10000,
  conversations: 10000,
  conversationMessages: 100000,
  programs: 25,
  programApplications: 5000,
};

function valueOf(field) {
  if (!field || typeof field !== "object") return undefined;
  if ("stringValue" in field) return field.stringValue;
  if ("integerValue" in field) return Number(field.integerValue);
  if ("doubleValue" in field) return Number(field.doubleValue);
  if ("booleanValue" in field) return Boolean(field.booleanValue);
  if ("timestampValue" in field) return field.timestampValue;
  if ("nullValue" in field) return null;
  if ("arrayValue" in field) return (field.arrayValue.values ?? []).map(valueOf);
  if ("mapValue" in field) return recordOf(field.mapValue.fields ?? {});
  return undefined;
}

function recordOf(fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, valueOf(value)]));
}

function docId(name) {
  return String(name).split("/").at(-1) ?? "";
}

async function fetchJson(url, init) {
  const response = await fetch(url, { ...init, headers: { Authorization: "Bearer owner", ...(init?.headers ?? {}) } });
  if (!response.ok) throw new Error(`[assert] ${url} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function readCollection(name) {
  return readCollectionPath(name);
}

async function readCollectionPath(path) {
  const rows = [];
  let pageToken = "";
  do {
    const url = new URL(`${documentsUrl}/${path}`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const json = await fetchJson(url);
    for (const doc of json.documents ?? []) rows.push({ id: docId(doc.name), ...recordOf(doc.fields ?? {}) });
    pageToken = json.nextPageToken ?? "";
  } while (pageToken);
  return rows;
}

async function countCollection(name) {
  return countCollectionPath(name);
}

function collectionPathTarget(path) {
  const parts = String(path).split("/").filter(Boolean);
  const collectionId = parts.at(-1);
  if (!collectionId || parts.length % 2 === 0) throw new Error(`[assert] invalid collection path: ${path}`);
  return {
    collectionId,
    parentPath: parts.slice(0, -1).join("/"),
  };
}

async function countCollectionPath(path) {
  const { collectionId, parentPath } = collectionPathTarget(path);
  const url = parentPath ? `${documentsUrl}/${parentPath}:runAggregationQuery` : `${documentsUrl}:runAggregationQuery`;
  const json = await fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      structuredAggregationQuery: {
        structuredQuery: {
          from: [{ collectionId }],
        },
        aggregations: [{ alias: "count", count: {} }],
      },
    }),
  });
  const aggregateField = json.find((row) => row.result)?.result?.aggregateFields?.count;
  const count = valueOf(aggregateField);
  if (!Number.isFinite(count)) throw new Error(`[assert] aggregation count missing for ${path}`);
  return count;
}

async function orderedCollectionCount(collectionId, fieldPath) {
  const json = await fetchJson(`${documentsUrl}:runQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        orderBy: [
          { field: { fieldPath }, direction: "DESCENDING" },
          { field: { fieldPath: "__name__" }, direction: "ASCENDING" },
        ],
        limit: ORDERED_QUERY_LIMIT,
      },
    }),
  });
  return json.filter((row) => row.document).length;
}

function assert(condition, message, failures) {
  if (!condition) failures.push(message);
}

const requiredTelemetryFields = {
  behavior_logs: ["userId", "role", "team", "gameId", "action", "time", "IP", "result", "cost", "callable", "createdAt"],
  cost_logs: ["ledgerRef", "provider", "model", "cacheChecked", "cacheHit", "inputTokens", "outputTokens", "estimatedKRW", "currency", "billable", "loggedAt", "callable", "gameId", "createdAt"],
};

function assertRequiredFields(collectionName, rows, fields, failures) {
  assert(rows.length > 0, `${collectionName} must contain at least one persisted telemetry row`, failures);
  const missing = [];
  for (const row of rows) {
    for (const field of fields) {
      if (!(field in row)) missing.push(`${row.id}.${field}`);
    }
  }
  assert(missing.length === 0, `${collectionName} missing required fields: ${missing.slice(0, 12).join(", ")}`, failures);
}

function requiredIsoDocs(collectionName, rows, failures) {
  const missing = rows.filter((row) => typeof row.updatedAtIso !== "string" || !row.updatedAtIso);
  assert(missing.length === 0, `${collectionName} missing updatedAtIso: ${missing.map((row) => row.id).join(", ")}`, failures);
}

function assertVisibleCollectionCount(label, visible, stored, failures) {
  if (!bulkMode) {
    assert(visible === stored, `${label} visibility mismatch: ordered=${visible}, stored=${stored}`, failures);
    return;
  }
  const expectedVisible = Math.min(stored, ORDERED_QUERY_LIMIT);
  assert(visible === expectedVisible, `${label} bulk visibility mismatch: ordered=${visible}, expected=${expectedVisible}, stored=${stored}`, failures);
}

function assertBulkStressCounts(counts, failures) {
  if (!bulkMode) return;
  for (const [key, minimum] of Object.entries(BULK_MINIMUM_COUNTS)) {
    assert(counts[key] >= minimum, `bulk stress expected ${key} >= ${minimum}, got ${counts[key]}`, failures);
  }
  assert(counts.callableRuns >= 1, `bulk stress expected callableRuns >= 1, got ${counts.callableRuns}`, failures);
}

function assertProtectedHesse(collections, failures) {
  const creator = collections.creators.find((row) => row.id === "rc-hesse");
  const conversation = collections.conversations.find((row) => row.id === "v-hesse");
  assert(Boolean(creator), "protected creator rc-hesse must exist", failures);
  assert(creator?.protected === true && creator?.seedWrite === false, "rc-hesse must keep protected:true and seedWrite:false", failures);
  assert(Boolean(conversation), "protected conversation v-hesse must exist", failures);
  assert(conversation?.protected === true && conversation?.seedWrite === false, "v-hesse must keep protected:true and seedWrite:false", failures);
}

function campaignCounterFailures(campaigns) {
  return campaigns
    .filter((row) => row.counterSource !== "syncCampaignFunnel")
    .map((row) => `${row.id}: counterSource=${row.counterSource ?? "missing"}`);
}

function assertCampaignTotals(campaigns, failures) {
  const stale = campaignCounterFailures(campaigns);
  assert(stale.length === 0, `campaign counters must be written only by syncCampaignFunnel: ${stale.join(", ")}`, failures);
  const mismatched = campaigns.filter((row) => {
    const sum = Number(row.queued ?? 0) + Number(row.sent ?? 0) + Number(row.replied ?? 0) +
      Number(row.negotiating ?? 0) + Number(row.contracted ?? 0) + Number(row.live ?? 0);
    return Number(row.total ?? 0) !== sum;
  });
  assert(mismatched.length === 0, `campaign total must equal summed funnel states: ${mismatched.map((row) => row.id).join(", ")}`, failures);
}

function assertProgramApplicationCounters(programs, applications, failures) {
  const mismatched = [];
  for (const program of programs) {
    const rows = applications.filter((row) => row.programId === program.id);
    if (rows.length === 0) continue;
    const expected = {
      applicationCount: rows.length,
      approvedCount: rows.filter((row) => row.status === "approved").length,
      contractCount: rows.filter((row) => typeof row.contractId === "string" && row.contractId).length,
      reviewCount: rows.filter((row) => typeof row.reviewId === "string" && row.reviewId).length,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (Number(program[key] ?? 0) !== value) mismatched.push(`${program.id}.${key}: stored=${program[key] ?? 0} expected=${value}`);
    }
  }
  assert(mismatched.length === 0, `program counters must match applications: ${mismatched.slice(0, 12).join(", ")}`, failures);
}

async function assertSourceGates(failures) {
  const liveSource = await readFile(new URL("src/lib/live.tsx", root), "utf8");
  const virtualListSource = await readFile(new URL("src/components/ui/VirtualList.tsx", root), "utf8");
  const readSource = await readFile(new URL("functions/read.ts", root), "utf8");
  const crmSource = await readFile(new URL("functions/crm.ts", root), "utf8");
  const campaignsSource = await readFile(new URL("functions/campaigns.ts", root), "utf8");
  const chatAiSource = await readFile(new URL("functions/chat-ai.ts", root), "utf8");
  const seedSource = await readFile(new URL("scripts/seed-emulator.mjs", root), "utf8");
  const seedProdSource = await readFile(new URL("scripts/seed-prod.mjs", root), "utf8");
  const backfillSource = await readFile(new URL("scripts/backfill-prod-iso-fields.mjs", root), "utf8");
  const programsSource = await readFile(new URL("functions/programs.ts", root), "utf8");
  const programsPageSource = await readFile(new URL("src/app/(app)/flu/programs/page.tsx", root), "utf8");
  const publicApplySource = await readFile(new URL("src/app/programs/[slug]/apply/page.tsx", root), "utf8");
  const firebaseSource = await readFile(new URL("src/lib/firebase.ts", root), "utf8");
  const chatNormalizationSource = await readFile(new URL("src/lib/chat-normalization.ts", root), "utf8");
  const chunkReloaderSource = await readFile(new URL("src/components/shell/ChunkErrorReloader.tsx", root), "utf8");
  const workflowActionMenuSource = await readFile(new URL("src/components/ui/WorkflowActionMenu.tsx", root), "utf8");
  const influencerSource = await readFile(new URL("src/app/(app)/flu/influencers/page.tsx", root), "utf8");
  const contentSource = await readFile(new URL("src/app/(app)/flu/content/page.tsx", root), "utf8");
  const chatSource = await readFile(new URL("src/app/(app)/chat/page.tsx", root), "utf8");
  const accountViewFirstPageStart = chatSource.indexOf("void revalidateConversationListCache(cacheKey, () =>");
  const accountViewFirstPageEnd = chatSource.indexOf("\n      .then((next)", accountViewFirstPageStart);
  const accountViewFirstPageSource = accountViewFirstPageStart >= 0 && accountViewFirstPageEnd > accountViewFirstPageStart
    ? chatSource.slice(accountViewFirstPageStart, accountViewFirstPageEnd)
    : "";
  const accountViewLoadMoreStart = chatSource.indexOf("const handleLoadOlderAccountViewConversations = useCallback(async () => {");
  const accountViewLoadMoreEnd = chatSource.indexOf("\n  // 명시적 클릭(personKey)", accountViewLoadMoreStart);
  const accountViewLoadMoreSource = accountViewLoadMoreStart >= 0 && accountViewLoadMoreEnd > accountViewLoadMoreStart
    ? chatSource.slice(accountViewLoadMoreStart, accountViewLoadMoreEnd)
    : "";
  const getPublicProgramSource = programsSource.slice(
    programsSource.indexOf("export async function getPublicProgram"),
    programsSource.indexOf("export async function submitProgramApplication"),
  );
  const submitProgramApplicationSource = programsSource.slice(
    programsSource.indexOf("export async function submitProgramApplication"),
    programsSource.indexOf("export async function reviewProgramApplication"),
  );
  const reviewProgramApplicationSource = programsSource.slice(
    programsSource.indexOf("export async function reviewProgramApplication"),
    programsSource.indexOf("export async function syncProgramWorkflow"),
  );
  const programCreatorWriteSource = programsSource.match(/batch\.set\(creatorRef,[\s\S]*?(?=batch\.set\(conversationRef,)/)?.[0] ?? "";

  assert(/loadMore\s*=\s*useCallback/.test(liveSource), "LiveDataProvider must expose loadMore(key)", failures);
  assert(/onEndReached/.test(virtualListSource), "VirtualList must expose an onEndReached trigger", failures);
  assert(/updatedAtIso:\s*nowIso(?:Value)?/.test(crmSource), "upsertCreator must write updatedAtIso", failures);
  assert(/createdAtIso:\s*existingCreatorCreatedAtIso/.test(crmSource), "upsertCreator must preserve/write createdAtIso", failures);
  assert(/updatedAtIso/.test(seedSource) && /createdAtIso/.test(seedSource), "emulator seed writes must stamp updatedAtIso/createdAtIso", failures);
  assert(/BULK_DEFAULTS/.test(seedSource) && /flu-emulator-bulk/.test(seedSource), "emulator seed must expose explicit bulk stress data", failures);
  assert(/process\.argv\.includes\("--apply"\)/.test(seedProdSource), "prod seed script must require explicit --apply", failures);
  assert(
    /const mode = process\.argv\[2\] === "delete" \? "delete" : "help"/.test(seedProdSource)
      && /if \(mode === "help" \|\| !apply\)\s*\{\s*printUsage\(\);\s*process\.exit\(mode === "help" \? 2 : 1\);/.test(seedProdSource),
    "prod seed cleanup must require the explicit delete command and --apply",
    failures,
  );
  assert(/loadMore\("creators"\)/.test(influencerSource), "influencers page must call loadMore(\"creators\")", failures);
  assert(/loadMore\("videos"\)/.test(contentSource), "content page must call loadMore(\"videos\")", failures);
  assert(
    /listConversations\(\{\s*mailAccountId:\s*selectedViewMailAccountId,[\s\S]*?\.\.\.viewAsParams,\s*\}\)/.test(accountViewFirstPageSource)
      && !/\b(?:cursor|limit)\s*:/.test(accountViewFirstPageSource)
      && /const limit = typeof requestData\.limit === "number" \? pageSize\(requestData\.limit\) : DEFAULT_PAGE_SIZE;/.test(readSource)
      && /const pageInfo = \(result as \{ pageInfo\?: \{ nextCursor\?: unknown \} \}\)\.pageInfo;/.test(chatSource)
      && /nextCursor:\s*typeof pageInfo\?\.nextCursor === "string" \? pageInfo\.nextCursor : null/.test(chatSource)
      && /const accountViewNextCursor = accountViewPageLoaded \? accountViewPageSource\?\.nextCursor \?\? null : null;/.test(chatSource)
      && /listConversations\(\{\s*cursor:\s*accountViewNextCursor,\s*mailAccountId:\s*selectedViewMailAccountId,[\s\S]*?\.\.\.viewAsParams,\s*\}\)/.test(accountViewLoadMoreSource)
      && /const knownIds = new Set\(current\.rows\.map\(\(row\) => String\(row\.id\)\)\);/.test(chatSource)
      && /rows\.filter\(\(row\) => \{[\s\S]*?knownIds\.has\(id\)[\s\S]*?knownIds\.add\(id\)[\s\S]*?return true;[\s\S]*?\}\)/.test(chatSource)
      && /data-testid="chat-load-older-conversations"/.test(chatSource),
    "chat page must use selected mailbox scope for a bounded first page, manual cursor load-more, viewAs, and append dedupe",
    failures,
  );
  assert(/listPrograms/.test(readSource), "read layer must expose paged listPrograms", failures);
  assert(/listProgramApplications/.test(readSource), "read layer must expose paged listProgramApplications", failures);
  assert(/programs: listPrograms/.test(liveSource), "LiveDataProvider must page programs through listPrograms", failures);
  assert(/programApplications: listProgramApplications/.test(liveSource), "LiveDataProvider must page programApplications through listProgramApplications", failures);
  assert(/loadMore\("programs"\)/.test(programsPageSource), "programs page must call loadMore(\"programs\")", failures);
  assert(/loadMore\("programApplications"\)/.test(programsPageSource), "programs page must call loadMore(\"programApplications\")", failures);
  assert(/VirtualList/.test(programsPageSource), "programs page must virtualize large program/application lists", failures);
  assert(/optimisticReview/.test(programsPageSource) && /rollback/.test(programsPageSource), "program review actions must be optimistic with rollback", failures);
  assert(!/\.limit\(100\)/.test(programsSource), "syncProgramWorkflow must not cap approved applications at 100", failures);
  assert(/processApprovedApplicationsPage/.test(programsSource), "syncProgramWorkflow must process approved applications by page", failures);
  assert(/adminDb\.runTransaction/.test(reviewProgramApplicationSource), "reviewProgramApplication must update application review state transactionally", failures);
  assert(/approvedDelta/.test(reviewProgramApplicationSource), "reviewProgramApplication must maintain approvedCount deltas", failures);
  assert(/contractCount\s*=\s*FieldValue\.increment/.test(reviewProgramApplicationSource), "reviewProgramApplication must maintain contractCount when workflow links are created", failures);
  assert(/reviewCount\s*=\s*FieldValue\.increment/.test(reviewProgramApplicationSource), "reviewProgramApplication must maintain reviewCount when workflow links are created", failures);
  assert(/canonicalCreatorId/.test(programsPageSource) && /isProtectedHesseIdentity/.test(programsPageSource), "program application profile hrefs must use the shared creator identity resolver", failures);
  assert(/profileString/.test(chatNormalizationSource), "chat profile derivation must sanitize live creator strings", failures);
  assert(/isNextStaticChunkUrl/.test(chunkReloaderSource), "chunk recovery must detect failed /_next/static script and CSS URLs", failures);
  assert(/runTransaction/.test(campaignsSource), "syncCampaignFunnel must correct counters transactionally", failures);
  assert(/creatorStageSource/.test(campaignsSource), "syncCampaignFunnel must document canonical creator-stage source", failures);
  assert(/total:\s*totalFunnel/.test(campaignsSource), "campaign total must be derived from summed funnel states", failures);
  assert(/recoverStaleAutoReplyJobs/.test(chatAiSource), "auto reply queue must recover stale processing jobs", failures);
  assert(/sendIntentKey/.test(chatAiSource) && /idempotencyKey/.test(chatAiSource), "auto reply live send must use idempotent send intent keys", failures);
  assert(/auth\.role === "super_admin"/.test(readSource), "getMessageSource raw fields must be super_admin-only", failures);
  assert(/maskEmail/.test(readSource), "getMessageSource must mask email fields for non-super-admin roles", failures);
  assert(!/cleanString\(data\.id/.test(submitProgramApplicationSource), "submitProgramApplication must not accept client-provided ids", failures);
  assert(/initializeAppCheck/.test(firebaseSource) && /ReCaptchaV3Provider/.test(firebaseSource), "client Firebase must initialize App Check for public callables", failures);
  assert(/NEXT_PUBLIC_FIREBASE_APPCHECK_SITE_KEY/.test(firebaseSource), "client App Check must be configured by explicit public site key", failures);
  assert(/assertPublicAppCheck\(request\)/.test(getPublicProgramSource), "getPublicProgram must require App Check outside emulator", failures);
  assert(/assertPublicAppCheck\(request\)/.test(submitProgramApplicationSource), "submitProgramApplication must require App Check outside emulator", failures);
  assert(/enforceAppCheck/.test(await readFile(new URL("functions/index.ts", root), "utf8")), "public program callables must enable runtime App Check enforcement outside emulator", failures);
  assert(!/@\/lib\/mock\/programs/.test(publicApplySource) && !/allPrograms/.test(publicApplySource), "public apply route must not mask backend failures with mock programs", failures);
  assert(/PROGRAM_APPLICATION_IDENTITY_LIMIT/.test(programsSource) && /PROGRAM_APPLICATION_IP_LIMIT/.test(programsSource), "public program applications must rate-limit identity and IP independently", failures);
  assert(/kind: "identity"/.test(programsSource) && /kind: "ip"/.test(programsSource), "rate-limit buckets must keep separate identity and IP documents", failures);
  assert(/programSnapshot/.test(submitProgramApplicationSource) && /status !== "open"/.test(submitProgramApplicationSource), "submitProgramApplication must reject non-open programs transactionally", failures);
  assert(/canonicalCreatorId/.test(programsSource) && /resolveProgramApplicationCreatorId/.test(programsSource), "program approval must resolve protected Hesse applications through the shared identity resolver", failures);
  assert(
    /const creatorSnapshot = await transaction\.get\(creatorRef\)/.test(programsSource)
      && /const creatorProtected = existingCreator\.protected === true\s*\|\| application\.protected === true\s*\|\| creatorId === CANONICAL_HESSE_CREATOR_ID/.test(programsSource)
      && /protected: creatorProtected/.test(programsSource)
      && /creatorProtected \? \{ seedWrite: false \} : \{\}/.test(programsSource)
      && /\}, \{ merge: true \}\);/.test(programCreatorWriteSource),
    "program approval must merge-preserve creator fields and protect the canonical Hesse alias from seed writes",
    failures,
  );
  assert(/enforceProgramApplicationRateLimit/.test(programsSource), "submitProgramApplication must rate-limit public applications", failures);
  assert(/runTransaction/.test(programsSource), "submitProgramApplication must deny unsafe overwrites transactionally", failures);
  assert(/PROTECTED_DOC_KEYS/.test(backfillSource), "prod ISO backfill must include protected doc keys", failures);
  assert(/skippedProtected/.test(backfillSource), "prod ISO backfill must report protected skips", failures);
  assert(/seedWrite\s*===\s*false/.test(backfillSource), "prod ISO backfill must skip seedWrite:false docs", failures);
  assert(/createPortal/.test(workflowActionMenuSource), "WorkflowActionMenu must render popup through a portal", failures);
}

// 결과 가드: 어떤 코드 경로가 썼든 영속된 정체성만 보고 판정한다. 좋은 조인 함수를 하나 더 만드는 걸로는
// 재발이 안 막혔다 — resolveProfileInputs 라는 올바른 조인이 이미 있었는데 tracking store 가 그걸 안 써서
// 운영 승인 행 97개에 "CR00037" 이 박제됐다. 그래서 판정을 값에 건다.
function assertPersistedCreatorIdentity(reportRows, creators, failures) {
  const creatorById = new Map(creators.map((creator) => [creator.id, creator]));
  const offenders = [];
  for (const row of reportRows) {
    const identity = row.creator;
    if (!identity || typeof identity !== "object") continue;
    const violations = creatorIdentityViolations(identity, creatorById.get(identity.fluCreatorId));
    if (violations.length > 0) offenders.push(`${row.id}: ${violations.join("+")}`);
  }
  assert(
    offenders.length === 0,
    `video_performance_report_rows leaked creator identity: ${offenders.slice(0, 12).join(", ")}`,
    failures,
  );
}

const { creatorIdentityViolations } = await import(
  new URL("functions/lib/managementProfileTabsReadModels.js", root)
);

const failures = [];
const collections = {
  creators: await readCollection("creators"),
  videoPerformanceReportRows: await readCollection("video_performance_report_rows"),
  conversations: await readCollection("conversations"),
  submissions: await readCollection("submissions"),
  campaigns: await readCollection("campaigns"),
  programs: await readCollection("programs"),
  programApplications: await readCollection("program_applications"),
  behaviorLogs: await readCollection("behavior_logs"),
  costLogs: await readCollection("cost_logs"),
};
const counts = {
  callableRuns: await countCollection("callableRuns"),
  engineSnapshots: await countCollection("engineSnapshots"),
  behaviorLogs: await countCollection("behavior_logs"),
  costLogs: await countCollection("cost_logs"),
  creators: collections.creators.length,
  visibleCreators: await orderedCollectionCount("creators", "updatedAtIso"),
  conversations: collections.conversations.length,
  conversationMessages: bulkMode ? await countCollectionPath("conversations/bulk-long-thread/messages") : 0,
  visibleConversations: await orderedCollectionCount("conversations", "updatedAtIso"),
  submissions: collections.submissions.length,
  visibleSubmissions: await orderedCollectionCount("submissions", "updatedAtIso"),
  programs: collections.programs.length,
  visiblePrograms: await orderedCollectionCount("programs", "updatedAtIso"),
  programApplications: collections.programApplications.length,
  visibleProgramApplications: await orderedCollectionCount("program_applications", "updatedAtIso"),
};

requiredIsoDocs("creators", collections.creators, failures);
requiredIsoDocs("conversations", collections.conversations, failures);
requiredIsoDocs("submissions", collections.submissions, failures);
requiredIsoDocs("programs", collections.programs, failures);
requiredIsoDocs("program_applications", collections.programApplications, failures);
assertVisibleCollectionCount("listCreators", counts.visibleCreators, counts.creators, failures);
assertVisibleCollectionCount("listConversations", counts.visibleConversations, counts.conversations, failures);
assertVisibleCollectionCount("listSubmissions", counts.visibleSubmissions, counts.submissions, failures);
assertVisibleCollectionCount("listPrograms", counts.visiblePrograms, counts.programs, failures);
assertVisibleCollectionCount("listProgramApplications", counts.visibleProgramApplications, counts.programApplications, failures);
if (!bulkMode) {
  assertProtectedHesse(collections, failures);
  assertCampaignTotals(collections.campaigns, failures);
}
assertProgramApplicationCounters(collections.programs, collections.programApplications, failures);
assertPersistedCreatorIdentity(collections.videoPerformanceReportRows, collections.creators, failures);
if (!bulkMode) {
  assertRequiredFields("behavior_logs", collections.behaviorLogs, requiredTelemetryFields.behavior_logs, failures);
  assertRequiredFields("cost_logs", collections.costLogs, requiredTelemetryFields.cost_logs, failures);
}
await assertSourceGates(failures);

console.log(`[assert] Firestore hardening ${bulkMode ? "bulk " : ""}gate ${JSON.stringify(counts)}`);

if (bulkMode) {
  assertBulkStressCounts(counts, failures);
} else {
  assert(counts.callableRuns >= 32, `expected at least 32 callableRuns, got ${counts.callableRuns}`, failures);
  assert(counts.engineSnapshots >= 32, `expected at least 32 engineSnapshots, got ${counts.engineSnapshots}`, failures);
  assert(counts.behaviorLogs >= 1, "expected behavior_logs to be persisted", failures);
  assert(counts.costLogs >= 1, "expected cost_logs to be persisted", failures);
}

if (failures.length > 0) {
  throw new Error(`[assert] hardening gate failed:\n- ${failures.join("\n- ")}`);
}
