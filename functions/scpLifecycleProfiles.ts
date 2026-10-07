import { FieldPath, FieldValue, type Transaction } from "firebase-admin/firestore";
import { createHash } from "crypto";
import { adminDb } from "./firebaseAdmin";
import { asRecord, asString, assertNonGuestAuth, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { assertScpEntitled } from "./mailAccounts";
import {
  DEFAULT_SCP_PROGRAM_ID,
  makeScpAlias,
  projectScpLifecycleProfiles,
  SCP_IDENTITY_CONFLICT_AUTOMATION_REASON_CODE,
  SCP_IDENTITY_CONFLICT_STATE,
  type ScpAliasKind,
  type ScpLifecycleProfile,
  type ScpLifecycleSources,
} from "./scpLifecycleProjection";
import {
  findApplicationManagementRecordForLifecycleFallback,
  type ApplicationManagementLifecycleFallbackProfile,
} from "./applicationManagementStore";
import { resolveCanonicalProgramId } from "./programCanonical";
import {
  readConfirmedProgramAliasRegistryState,
  readConfirmedProgramAliasRegistryStateInTransaction,
} from "./programAliasRegistry";
import { canonicalScpProgramId, normalizeScpProgramId } from "./scpProgramAlias";

const PROFILE_COLLECTION = "scp_lifecycle_profiles";
const ALIAS_COLLECTION = "scp_identity_aliases";
const REFRESH_OUTBOX_COLLECTION = "scp_lifecycle_refresh_outbox";
const VIDEO_HISTORY_COLLECTION = "video_history";
const DEFAULT_SOURCE_LIMIT = 2000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
export const SCP_LIFECYCLE_MATERIALIZED_VERSION = 2;
const MATERIALIZED_VERSION = SCP_LIFECYCLE_MATERIALIZED_VERSION;
const MATERIALIZED_VERSIONS_TO_RECONCILE = [1, MATERIALIZED_VERSION];
// 26-09-05 [작업3]: 스케줄 기본 클레임 배치를 20 → 100(기존 상한 MAX_REFRESH_PROCESS_LIMIT 그대로,
// 새 상한 아님)으로 올린다. 이 배치는 sourceLimit(2000, pass당 1회 고정 비용)과 무관한 문서 단위
// 트랜잭션이라 추가 비용은 무시할 수준이고, retire(20,000/pass)가 처리하는 대량 회수와 달리 이
// 배치만 프로필/별칭 카운트가 실린 "완전한" finalize 를 받는다 — 더 많은 항목이 그 상세를 얻는다.
const DEFAULT_REFRESH_PROCESS_LIMIT = 100;
const MAX_REFRESH_PROCESS_LIMIT = 100;
const REFRESH_RETIRE_PAGE_SIZE = 500;
const MAX_REFRESH_RETIRE_PER_PASS = 20000;
// gRPC FAILED_PRECONDITION — retire 의 lastUpdateTime precondition 이 깨졌다는 뜻.
const FIRESTORE_FAILED_PRECONDITION_CODE = 9;

// W86-B [리프레시 이벤트 입자 · 근거는 artifacts/W86B-WORKER-REPORT-v2.md]
//
// eventId 는 [source, sourceRef, reason, sourceUpdatedAtIso, aliasIds] 해시이고 아웃박스 쓰기는
// merge 다. 즉 **해시가 같으면 같은 문서로 합류하고, 다르면 새 문서가 쌓인다.**
// 그런데 생산자 전원이 `sourceUpdatedAtIso` 로 **밀리초 정밀 타임스탬프**를 넘겨 왔다
// (nowIso / sentAtIso / openedAtIso / receivedAtIso …). 그래서 같은 대상의 같은 종류 변이도
// 호출마다 해시가 달라져 merge 가 한 번도 성사되지 않았다 — 프로드 queued 7,939건이 상시 적체되고,
// 큐가 비지 않으니 매 pass 전역 재구축이 발동한다(일 ~1,000만 읽기의 트리거).
//
// W46 이 `video_view_snapshots`/`video_view_series`(당시 적체의 91%)에서 이미 같은 버그를 고쳤다 —
// 호출부가 **날짜 단위로 안정된 값**을 넘기게 하는 방식이었다(videoViewSnapshots.ts:103-121).
// 여기서는 그 패턴을 **적재 함수 안쪽**으로 옮긴다. 이유:
//   ① 누수 생산자가 6곳이 아니라 20곳이고, 앞으로 추가될 21번째 호출부는 다시 밀리초를 넘긴다.
//      호출부 규율은 강제되지 않지만 여기 한 곳은 우회가 불가능하다.
//   ② W46 호출부가 이미 넘기는 값(`YYYY-MM-DDT00:00:00.000Z`)은 이 절단에 **불변**이라
//      기존 두 소스의 동작이 그대로다(회귀 없음).
//
// 재구축은 전역이라 "이 소스의 이 대상이 (그날) 바뀌었다" 표시면 충분하다. 하루 안의 반복 변이가
// 한 문서로 합류해도 잃는 정보가 없다. 하트비트도 살아 있다: 이미 processed 된 문서에 같은 날
// 새 변이가 오면 merge 가 status 를 다시 "queued" 로 되돌린다(writeRefreshOutboxRecord).
//
// 원문 타임스탬프는 행에 그대로 보존한다(`sourceUpdatedAtIso`). 절단값은 **해시 입력에만** 쓰고
// 진단용으로 `sourceUpdatedGrainIso` 에 함께 남긴다 — 두 이벤트가 왜 합류했는지 사후에 보인다.
export function scpLifecycleRefreshGrainIso(sourceUpdatedAtIso: string): string {
  const parsed = Date.parse(sourceUpdatedAtIso);
  // 파싱 불가 값은 손대지 않는다. 임의로 "오늘"을 채우면 서로 다른 대상이 한 문서로 접히고,
  // 빈 문자열로 만들면 파싱 불가 입력 전부가 한 문서로 접힌다 — 둘 다 절단보다 나쁘다.
  if (!Number.isFinite(parsed)) return sourceUpdatedAtIso;
  return `${new Date(parsed).toISOString().slice(0, 10)}T00:00:00.000Z`;
}

const SOURCE_COLLECTIONS: Record<keyof ScpLifecycleSources, string> = {
  scp_outreach: "scp_outreach",
  scp_coldmail_history: "scp_coldmail_history",
  mail_outbound_log: "mail_outbound_log",
  conversation_replies: "conversation_replies",
  conversations: "conversations",
  program_applications: "program_applications",
  program_sheet_leads: "program_sheet_leads",
  qualification_decisions: "qualification_decisions",
  creator_links: "creator_links",
  scp_mail_results: "scp_mail_results",
  submission_tasks: "submission_tasks",
  submissions: "submissions",
  review_ledger: "review_ledger",
  videos: "videos",
  video_view_series: "video_view_series",
  video_view_snapshots: "video_view_snapshots",
  gem_grants: "gem_grants",
};

const SCP_LIFECYCLE_FAILURE_CODES = {
  invalidSource: "scp_lifecycle_refresh_invalid_source",
  missingSourceRef: "scp_lifecycle_refresh_missing_source_ref",
  enqueue: "scp_lifecycle_refresh_enqueue_failed",
  refresh: "scp_lifecycle_refresh_failed",
  failureRecordWrite: "scp_lifecycle_refresh_failure_record_write_failed",
} as const;

type ScpLifecycleFailureCode =
  typeof SCP_LIFECYCLE_FAILURE_CODES[keyof typeof SCP_LIFECYCLE_FAILURE_CODES];

const SCP_LIFECYCLE_FAILURE_CODE_SET = new Set<string>(
  Object.values(SCP_LIFECYCLE_FAILURE_CODES),
);
const SCP_LIFECYCLE_FAILURE_SOURCE_SET = new Set<string>([
  ...Object.keys(SOURCE_COLLECTIONS),
  "drift_detection",
  "materialized_reconcile",
  "source_refresh_enqueue",
  "refresh_outbox",
  "manual_refresh",
  "lifecycle_refresh",
]);
const SCP_LIFECYCLE_OUTBOX_STATUS_SET = new Set([
  "queued",
  "processing",
  "processed",
  "failed",
  "drift",
  "stale",
]);
const SCP_LIFECYCLE_OUTBOX_EVENT_KIND_SET = new Set([
  "source_changed",
  "refresh_failed",
  "drift_detected",
  "materialized_stale",
]);
const SCP_LIFECYCLE_HASH_RE = /^[a-f0-9]{24}$/;
const SCP_LIFECYCLE_CANONICAL_FAILURE_EVENT_RE = /^(?:source_changed|source_enqueue_failed|refresh_failed)_[a-f0-9]{24}$/;

const ALIAS_KINDS: ScpAliasKind[] = ["leadId", "email", "handle", "channelId", "creatorId", "submissionId", "videoId", "trackingId", "conversationId"];

export type ScpLifecycleProfileNotFoundReason =
  | "not_found"
  | "stale"
  | "not_fresh"
  | "legacy_materialization"
  | "program_mismatch"
  | "invalid_program_scope";

export type ScpIdentityAutomationAliasInput = {
  kind: ScpAliasKind;
  value: unknown;
};

export type ScpIdentityConflictAutomationReceipt = {
  profileId: string;
  programId: string;
  canonicalIdentityHash: string;
  sourceRefs: string[];
  resolutionState: typeof SCP_IDENTITY_CONFLICT_STATE;
  automationBlocked: true;
  reasonCode: typeof SCP_IDENTITY_CONFLICT_AUTOMATION_REASON_CODE;
};

export function scpLifecycleProfileNotFoundReason(
  row: Record<string, unknown>,
  requestedProgramId?: string,
  aliasMap: Record<string, string> = {},
): ScpLifecycleProfileNotFoundReason | null {
  const projectionStatus = asString(row.projectionStatus);
  if (projectionStatus !== "fresh") return projectionStatus === "stale" ? "stale" : "not_fresh";
  if (row.materializedVersion !== MATERIALIZED_VERSION) return "legacy_materialization";

  const declaredProgramId = resolveCanonicalProgramId(row.programId, aliasMap);
  const declaredProgramIds = Array.isArray(row.programIds)
    ? [...new Set(row.programIds.map((value) => resolveCanonicalProgramId(value, aliasMap)).filter(Boolean))]
    : [];
  if (!declaredProgramId || declaredProgramIds.length !== 1 || declaredProgramIds[0] !== declaredProgramId) {
    return "invalid_program_scope";
  }
  const requested = resolveCanonicalProgramId(requestedProgramId, aliasMap);
  return requested && requested !== declaredProgramId ? "program_mismatch" : null;
}

export function scpIdentityConflictAutomationReceipt(
  row: Record<string, unknown>,
  aliasMap: Record<string, string> = {},
): ScpIdentityConflictAutomationReceipt | null {
  const profileId = asString(row.profileId);
  const programId = resolveCanonicalProgramId(row.programId, aliasMap);
  const resolutionState = asString(row.resolutionState);
  const currentState = asString(row.currentState);
  if (!profileId || !programId) return null;
  const declaresIdentityConflict = row.identityConflict === true || row.automationBlocked === true;
  if (
    !declaresIdentityConflict
    && resolutionState !== SCP_IDENTITY_CONFLICT_STATE
    && currentState !== SCP_IDENTITY_CONFLICT_STATE
  ) {
    return null;
  }
  const conflictRefs = Array.isArray(row.identityConflictSourceRefs)
    ? row.identityConflictSourceRefs
    : row.sourceRefs;
  const sourceRefs = Array.isArray(conflictRefs)
    ? [...new Set(conflictRefs.map((value) => asString(value)).filter(Boolean))].sort().slice(0, 100)
    : [];
  return {
    profileId,
    programId,
    canonicalIdentityHash: scpLifecycleValidatedHash(row.canonicalIdentityHash)
      || shortHash(["scp_canonical_identity_v1", profileId].join("\u0000")),
    sourceRefs,
    resolutionState: SCP_IDENTITY_CONFLICT_STATE,
    automationBlocked: true,
    reasonCode: SCP_IDENTITY_CONFLICT_AUTOMATION_REASON_CODE,
  };
}

export async function readScpIdentityConflictAutomationGate(input: {
  programId: unknown;
  aliases?: ScpIdentityAutomationAliasInput[];
  profileId?: unknown;
}, transaction?: Transaction): Promise<ScpIdentityConflictAutomationReceipt | null> {
  const aliasRegistryState = transaction
    ? await readConfirmedProgramAliasRegistryStateInTransaction(transaction)
    : await readConfirmedProgramAliasRegistryState();
  const programId = resolveCanonicalProgramId(
    asString(input.programId, DEFAULT_SCP_PROGRAM_ID),
    aliasRegistryState.aliasMap,
  );
  const profileIds = new Set<string>();
  const explicitProfileId = asString(input.profileId);
  if (explicitProfileId) profileIds.add(explicitProfileId);

  const aliasesById = new Map<string, NonNullable<ReturnType<typeof makeScpAlias>>>();
  for (const inputAlias of input.aliases ?? []) {
    const alias = makeScpAlias(inputAlias.kind, inputAlias.value);
    if (!alias || alias.strength !== "strong") continue;
    aliasesById.set(alias.aliasId, alias);
  }
  for (const alias of aliasesById.values()) {
    const aliasRef = adminDb.collection(ALIAS_COLLECTION).doc(alias.aliasId);
    const aliasSnapshot = transaction ? await transaction.get(aliasRef) : await aliasRef.get();
    if (!aliasSnapshot.exists) continue;
    const aliasRow = aliasSnapshot.data() ?? {};
    if (aliasRow.projectionStatus !== "fresh" || aliasRow.materializedVersion !== MATERIALIZED_VERSION) continue;
    for (const profileId of profileIdsForCanonicalProgram(aliasRow, programId, aliasRegistryState.aliasMap)) {
      profileIds.add(profileId);
    }
  }

  for (const profileId of [...profileIds].sort()) {
    const profileRef = adminDb.collection(PROFILE_COLLECTION).doc(profileId);
    const profileSnapshot = transaction ? await transaction.get(profileRef) : await profileRef.get();
    if (!profileSnapshot.exists) continue;
    const profileRow = { profileId: profileSnapshot.id, ...(profileSnapshot.data() ?? {}) };
    if (scpLifecycleProfileNotFoundReason(profileRow, programId, aliasRegistryState.aliasMap)) continue;
    const receipt = scpIdentityConflictAutomationReceipt(profileRow, aliasRegistryState.aliasMap);
    if (receipt) return receipt;
  }
  return null;
}

export function identityConflictAutomationError(
  receipt: ScpIdentityConflictAutomationReceipt,
): Error {
  return Object.assign(
    new Error(`failed-precondition: ${SCP_IDENTITY_CONFLICT_AUTOMATION_REASON_CODE}`),
    {
      code: "failed-precondition", errorCode: "identity_conflict_automation_error_unauthorized",
      automationGate: receipt,
      ...receipt,
    },
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

type PageCursor = {
  docId: string;
  orderValue?: string;
};

function pageSize(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(Math.trunc(value), MAX_PAGE_SIZE))
    : DEFAULT_PAGE_SIZE;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function scpAliasContentDigest(doc: Record<string, unknown>, excludeKeys: readonly string[] = ["materializedAtIso", "updatedAtIso", "staleAtIso"]): string {
  const rest = Object.fromEntries(Object.entries(doc).filter(([key]) => !excludeKeys.includes(key)));
  const serialized = Object.keys(rest).sort().map((key) => `${key}=${JSON.stringify(rest[key])}`).join("");
  return shortHash(serialized);
}

function scpLifecycleIdentityHash(scope: string, value: unknown): string {
  const candidate = asString(value);
  return candidate
    ? shortHash(["scp_lifecycle_identity_v1", scope, candidate].join("\u0000"))
    : "";
}

function scpLifecycleValidatedHash(value: unknown): string {
  const candidate = asString(value).toLowerCase();
  return SCP_LIFECYCLE_HASH_RE.test(candidate) ? candidate : "";
}

function scpLifecycleHashOrRawHash(
  hashedValue: unknown,
  scope: string,
  rawValue: unknown,
): string {
  return scpLifecycleValidatedHash(hashedValue)
    || scpLifecycleIdentityHash(scope, rawValue);
}

function scpLifecycleAliasIdHashes(row: Record<string, unknown>): string[] {
  const hashes = new Set<string>();
  if (Array.isArray(row.aliasIdHashes)) {
    for (const value of row.aliasIdHashes) {
      const hash = scpLifecycleValidatedHash(value);
      if (hash) hashes.add(hash);
    }
  }
  if (Array.isArray(row.aliasIds)) {
    for (const value of row.aliasIds) {
      const hash = scpLifecycleIdentityHash("alias_id", value);
      if (hash) hashes.add(hash);
    }
  }
  return [...hashes].sort().slice(0, 100);
}

function scpLifecycleIso(value: unknown): string {
  const candidate = asString(value);
  const millis = Date.parse(candidate);
  if (!candidate || !Number.isFinite(millis)) return "";
  try {
    return new Date(millis).toISOString() === candidate ? candidate : "";
  } catch {
    return "";
  }
}

function scpLifecycleNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

function scpLifecycleFailureEventId(value: unknown, seed: string): string {
  const candidate = asString(value);
  return SCP_LIFECYCLE_CANONICAL_FAILURE_EVENT_RE.test(candidate)
    ? candidate
    : `refresh_failed_${shortHash(candidate || seed)}`;
}

function scpLifecycleFailureCode(
  value: unknown,
  fallback: ScpLifecycleFailureCode = SCP_LIFECYCLE_FAILURE_CODES.refresh,
): ScpLifecycleFailureCode {
  const candidate = asString(value);
  return SCP_LIFECYCLE_FAILURE_CODE_SET.has(candidate)
    ? candidate as ScpLifecycleFailureCode
    : fallback;
}

function scpLifecycleFailureSource(value: unknown): string {
  const candidate = asString(value);
  return SCP_LIFECYCLE_FAILURE_SOURCE_SET.has(candidate)
    ? candidate
    : "lifecycle_refresh";
}

function scpLifecycleCorrelationIdHash(value: unknown, seed: string): string {
  return scpLifecycleValidatedHash(value) || shortHash(seed);
}

function safeScpLifecycleError(
  errorCode: ScpLifecycleFailureCode,
  correlationHash: string,
  code: "invalid-argument" | "internal" = "internal",
): Error {
  return Object.assign(new Error(`${code}: ${errorCode}`), {
    code,
    errorCode,
    correlationIdHash: correlationHash,
  });
}

function closedErrorField(error: unknown, field: string): unknown {
  if (!error || typeof error !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, field);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    // Proxies/accessors supplied by a provider are untrusted diagnostics too.
    return undefined;
  }
}

function closedScpLifecycleError(
  error: unknown,
  fallbackCode: ScpLifecycleFailureCode,
  seed: string,
  code: "invalid-argument" | "internal" = "internal",
): Error {
  const errorCode = scpLifecycleFailureCode(
    closedErrorField(error, "errorCode"),
    fallbackCode,
  );
  const correlationHash = scpLifecycleCorrelationIdHash(
    closedErrorField(error, "correlationIdHash"),
    seed,
  );
  return safeScpLifecycleError(errorCode, correlationHash, code);
}

function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: unknown): PageCursor | null {
  const raw = asString(value);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && typeof parsed.docId === "string" ? parsed as PageCursor : null;
  } catch {
    return null;
  }
}

function cleanObject<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

async function readSourceCollection(collection: string, pageLimit: number): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  while (true) {
    let query = adminDb.collection(collection).orderBy(FieldPath.documentId()).limit(pageLimit);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    for (const doc of snapshot.docs) rows.push({ id: doc.id, ...doc.data() });
    if (snapshot.docs.length < pageLimit) break;
    cursor = snapshot.docs.at(-1)?.id ?? null;
    if (!cursor) break;
  }
  return rows;
}

export async function readScpLifecycleSources(limit = DEFAULT_SOURCE_LIMIT): Promise<ScpLifecycleSources> {
  const entries = await Promise.all(
    Object.entries(SOURCE_COLLECTIONS).map(async ([source, collection]) => {
      const rows = await readSourceCollection(collection, limit);
      return [source, rows] as const;
    }),
  );
  return Object.fromEntries(entries) as ScpLifecycleSources;
}

async function deleteVideoHistory(profileId: string): Promise<void> {
  while (true) {
    const snapshot = await adminDb.collection(PROFILE_COLLECTION).doc(profileId).collection(VIDEO_HISTORY_COLLECTION).limit(400).get();
    if (snapshot.empty) return;
    const batch = adminDb.batch();
    for (const doc of snapshot.docs) batch.delete(doc.ref);
    await batch.commit();
  }
}

async function writeVideoHistory(profileId: string, rows: Array<Record<string, unknown>>, updatedAtIso: string): Promise<number> {
  await deleteVideoHistory(profileId);
  let batch = adminDb.batch();
  let count = 0;
  let written = 0;
  for (const [index, row] of rows.entries()) {
    const sourceRef = asString(row.sourceRef, `history-${index}`);
    const statusAtIso = asString(row.statusAtIso, asString(row.updatedAtIso, ""));
    const id = `vh_${shortHash(`${sourceRef}:${statusAtIso}:${index}`)}`;
    batch.set(adminDb.collection(PROFILE_COLLECTION).doc(profileId).collection(VIDEO_HISTORY_COLLECTION).doc(id), {
      id,
      profileId,
      ...row,
      statusAtIso: statusAtIso || asString(row.updatedAtIso, updatedAtIso),
      materializedAtIso: updatedAtIso,
      updatedAtIso,
    });
    count += 1;
    written += 1;
    if (count >= 400) {
      await batch.commit();
      batch = adminDb.batch();
      count = 0;
    }
  }
  if (count > 0) await batch.commit();
  return written;
}

async function writeRefreshOutboxRecord(id: string, record: Record<string, unknown>, updatedAtIso: string): Promise<void> {
  await adminDb.collection(REFRESH_OUTBOX_COLLECTION).doc(id).set(cleanObject({
    id,
    eventId: id,
    createdAtIso: updatedAtIso,
    updatedAtIso,
    ...record,
  }), { merge: true });
}

async function reconcileStaleMaterializedDocs(freshProfileIds: Set<string>, freshAliasIds: Set<string>, updatedAtIso: string): Promise<{ staleProfileCount: number; staleAliasCount: number }> {
  let staleProfileCount = 0;
  let staleAliasCount = 0;

  const profileSnapshot = await adminDb.collection(PROFILE_COLLECTION)
    .where("materializedVersion", "in", MATERIALIZED_VERSIONS_TO_RECONCILE)
    .get();
  for (const doc of profileSnapshot.docs) {
    if (freshProfileIds.has(doc.id)) continue;
    staleProfileCount += 1;
    // Already in the target state; re-stamping ~1.8k profiles per pass ate the 540s budget.
    if (doc.get("projectionStatus") === "stale" && doc.get("retiredByMaterializedVersion") === MATERIALIZED_VERSION) continue;
    await doc.ref.set({
      projectionStatus: "stale",
      staleAtIso: updatedAtIso,
      retiredAtIso: updatedAtIso,
      retiredByMaterializedVersion: MATERIALIZED_VERSION,
      lastRefreshError: "Profile absent from latest lifecycle projection.",
      updatedAtIso,
    }, { merge: true });
    await writeRefreshOutboxRecord(`stale_profile_${doc.id}`, {
      profileId: doc.id,
      source: "materialized_reconcile",
      status: "stale",
      reason: "materialized profile absent from latest projection",
    }, updatedAtIso);
  }

  const aliasSnapshot = await adminDb.collection(ALIAS_COLLECTION)
    .where("materializedVersion", "in", MATERIALIZED_VERSIONS_TO_RECONCILE)
    .get();
  for (const doc of aliasSnapshot.docs) {
    if (freshAliasIds.has(doc.id)) continue;
    staleAliasCount += 1;
    if (doc.get("projectionStatus") === "stale" && doc.get("retiredByMaterializedVersion") === MATERIALIZED_VERSION) continue;
    await doc.ref.set({
      projectionStatus: "stale",
      staleAtIso: updatedAtIso,
      retiredAtIso: updatedAtIso,
      retiredByMaterializedVersion: MATERIALIZED_VERSION,
      updatedAtIso,
    }, { merge: true });
    await writeRefreshOutboxRecord(`stale_alias_${shortHash(doc.id)}`, {
      aliasId: doc.id,
      source: "materialized_reconcile",
      status: "stale",
      reason: "materialized alias absent from latest projection",
    }, updatedAtIso);
  }

  return { staleProfileCount, staleAliasCount };
}

export type ScpLifecycleRefreshSource = keyof ScpLifecycleSources;

export type ScpLifecycleRefreshAliasInput =
  | Partial<Record<ScpAliasKind, unknown>>
  | { kind: ScpAliasKind; value: unknown };

export type ScpLifecycleRefreshEventInput = {
  source: ScpLifecycleRefreshSource;
  sourceRef: string;
  reason?: string;
  profileId?: string;
  aliases?: ScpLifecycleRefreshAliasInput[];
  sourceUpdatedAtIso?: string;
  nowIso?: string;
};

function aliasIdsForRefresh(inputs: ScpLifecycleRefreshAliasInput[] = []): string[] {
  const aliasIds = new Set<string>();
  const addAlias = (kind: ScpAliasKind, value: unknown) => {
    const alias = makeScpAlias(kind, value);
    if (alias) aliasIds.add(alias.aliasId);
  };
  for (const input of inputs) {
    const record = asRecord(input);
    const explicitKind = asString(record.kind) as ScpAliasKind;
    if (ALIAS_KINDS.includes(explicitKind) && record.value !== undefined) addAlias(explicitKind, record.value);
    for (const kind of ALIAS_KINDS) {
      if (record[kind] !== undefined) addAlias(kind, record[kind]);
    }
  }
  return [...aliasIds].sort();
}

export async function enqueueScpLifecycleRefreshEvent(input: ScpLifecycleRefreshEventInput): Promise<{ eventId: string; aliasIds: string[] }> {
  const updatedAtIso = input.nowIso ?? nowIso();
  const source = input.source;
  const sourceRef = asString(input.sourceRef);
  const reason = asString(input.reason, "source_changed");
  // W86-B: 실패 행도 같은 누수였다 — 같은 source/ref 의 반복 실패가 밀리초 때문에 매번 새 문서가
  //   됐다. status 가 "failed" 라 queued 적체에는 안 잡히지만 같은 컬렉션을 무한히 불린다.
  const failureEventId = `source_enqueue_failed_${shortHash([String(source), sourceRef || "missing-source-ref", reason, scpLifecycleRefreshGrainIso(updatedAtIso)].join("\u0000"))}`;
  const correlationHash = scpLifecycleCorrelationIdHash(
    "",
    ["scp_lifecycle_enqueue", String(source), sourceRef, reason, updatedAtIso].join("\u0000"),
  );
  const failClosed = async (
    errorCode: ScpLifecycleFailureCode,
    code: "invalid-argument" | "internal",
  ): Promise<never> => {
    await recordScpLifecycleRefreshFailure({
      eventId: failureEventId,
      profileId: asString(input.profileId) || undefined,
      source: Object.prototype.hasOwnProperty.call(SOURCE_COLLECTIONS, source)
        ? String(source)
        : "source_refresh_enqueue",
      error: null,
      errorCode,
      correlationIdHash: correlationHash,
      computedAtIso: updatedAtIso,
    }).catch(() => undefined);
    throw safeScpLifecycleError(errorCode, correlationHash, code);
  };

  if (!Object.prototype.hasOwnProperty.call(SOURCE_COLLECTIONS, source)) {
    return failClosed(SCP_LIFECYCLE_FAILURE_CODES.invalidSource, "invalid-argument");
  }
  if (!sourceRef) {
    return failClosed(SCP_LIFECYCLE_FAILURE_CODES.missingSourceRef, "invalid-argument");
  }
  try {
    const sourceUpdatedAtIso = asString(input.sourceUpdatedAtIso, updatedAtIso);
    // W86-B: 해시 입력만 날짜 입자로 절단한다(위 scpLifecycleRefreshGrainIso 주석의 근거).
    //   행에는 원문 타임스탬프를 그대로 남긴다 — 마지막 실제 변이 시각은 진단에 필요하다.
    const sourceUpdatedGrainIso = scpLifecycleRefreshGrainIso(sourceUpdatedAtIso);
    const aliasIds = aliasIdsForRefresh(input.aliases);
    const eventId = `source_changed_${shortHash([source, sourceRef, reason, sourceUpdatedGrainIso, aliasIds.join(",")].join("\u0000"))}`;
    await writeRefreshOutboxRecord(eventId, {
      eventKind: "source_changed",
      source,
      sourceRef,
      status: "queued",
      reason,
      profileId: asString(input.profileId) || undefined,
      aliasIds,
      aliasCount: aliasIds.length,
      sourceUpdatedAtIso,
      sourceUpdatedGrainIso,
      attempts: 0,
    }, updatedAtIso);
    return { eventId, aliasIds };
  } catch {
    return failClosed(SCP_LIFECYCLE_FAILURE_CODES.enqueue, "internal");
  }
}

function sourceCounts(sources: ScpLifecycleSources): Record<string, number> {
  return Object.fromEntries(Object.keys(SOURCE_COLLECTIONS).map((source) => [source, sources[source as keyof ScpLifecycleSources]?.length ?? 0]));
}

function profileDoc(profile: ScpLifecycleProfile, aliasIds: string[], conflictRefs: string[], updatedAtIso: string): Record<string, unknown> {
  return cleanObject({
    ...profile,
    aliasIds,
    conflictRefs,
    materializedVersion: MATERIALIZED_VERSION,
    projectionStatus: "fresh",
    lastRefreshError: null,
    lastRefreshErrorCode: null,
    lastRefreshErrorCorrelationIdHash: null,
    lastProjectedAtIso: profile.computedAtIso,
    materializedAtIso: updatedAtIso,
    updatedAtIso,
  });
}

export async function materializeScpLifecycleProjection(sources: ScpLifecycleSources, options: { computedAtIso?: string } = {}) {
  const updatedAtIso = options.computedAtIso ?? nowIso();
  const projection = projectScpLifecycleProfiles(sources, { computedAtIso: updatedAtIso });
  const profileIds = new Set(projection.profiles.map((profile) => profile.profileId));
  const profilesByIdentityProfileId = new Map<string, ScpLifecycleProfile[]>();
  for (const profile of projection.profiles) {
    const identityProfileId = projection.identityProfileIdByProfile[profile.profileId];
    if (!identityProfileId) continue;
    const profiles = profilesByIdentityProfileId.get(identityProfileId) ?? [];
    profiles.push(profile);
    profilesByIdentityProfileId.set(identityProfileId, profiles);
  }
  for (const profiles of profilesByIdentityProfileId.values()) {
    profiles.sort((left, right) => {
      if (left.programId === canonicalScpProgramId) return -1;
      if (right.programId === canonicalScpProgramId) return 1;
      return left.programId.localeCompare(right.programId) || left.profileId.localeCompare(right.profileId);
    });
  }
  const freshAliasIds = new Set<string>();
  let batch = adminDb.batch();
  let count = 0;
  const commitIfNeeded = async () => {
    if (count < 400) return;
    await batch.commit();
    batch = adminDb.batch();
    count = 0;
  };

  const existingProfileContentHashById = new Map<string, string>();
  try {
    for (const doc of (await adminDb.collection(PROFILE_COLLECTION).select("contentHash", "projectionStatus").get()).docs) {
      if (doc.get("projectionStatus") === "fresh" && typeof doc.get("contentHash") === "string") existingProfileContentHashById.set(doc.id, doc.get("contentHash")); // stale/absent must always rewrite
    }
  } catch { existingProfileContentHashById.clear(); }

  let profileWritesSkipped = 0;
  for (const profile of projection.profiles) {
    const identityProfileId = projection.identityProfileIdByProfile[profile.profileId];
    const component = projection.graph.components.find((candidate) => candidate.profileId === identityProfileId);
    const aliasIds = component?.aliasIds.filter((aliasId) => projection.graph.aliases.find((alias) => alias.aliasId === aliasId)?.strength === "strong") ?? [];
    const conflictRefs = projection.graph.conflicts
      .filter((conflict) => conflict.sourceRefs.some((ref) => profile.sourceRefs.includes(ref)))
      .map((conflict) => conflict.aliasId);
    const doc = profileDoc(profile, aliasIds, conflictRefs, updatedAtIso); // computedAtIso mirrors lastProjectedAtIso and changes every pass — exclude both.
    const contentHash = (() => { try { return scpAliasContentDigest(doc, ["materializedAtIso", "updatedAtIso", "lastProjectedAtIso", "staleAtIso", "computedAtIso"]); } catch { return ""; } })();
    if (contentHash && existingProfileContentHashById.get(profile.profileId) === contentHash) { profileWritesSkipped += 1; continue; }
    batch.set(adminDb.collection(PROFILE_COLLECTION).doc(profile.profileId), contentHash ? { ...doc, contentHash } : doc);
    count += 1;
    await commitIfNeeded();
  }

  // Fail-open: empty map on prefetch failure makes every alias below write unconditionally.
  const existingAliasContentHashById = new Map<string, string>();
  try {
    const existingAliasSnapshot = await adminDb.collection(ALIAS_COLLECTION).select("contentHash", "projectionStatus").get();
    for (const doc of existingAliasSnapshot.docs) {
      if (doc.get("projectionStatus") !== "fresh") continue; // stale/absent must always rewrite to recover.
      const hash = doc.get("contentHash");
      if (typeof hash === "string" && hash) existingAliasContentHashById.set(doc.id, hash);
    }
  } catch {
    existingAliasContentHashById.clear();
  }

  let aliasWritesSkipped = 0;
  for (const alias of projection.graph.aliases) {
    if (alias.strength !== "strong") continue;
    const identityProfileId = projection.graph.profileForAlias[alias.aliasId];
    const profiles = identityProfileId ? profilesByIdentityProfileId.get(identityProfileId) ?? [] : [];
    if (profiles.length === 0) continue;
    const profileId = profiles[0]?.profileId;
    if (!profileId) continue;
    const profileIdsByProgram = Object.fromEntries(profiles.map((profile) => [profile.programId, profile.profileId]));
    freshAliasIds.add(alias.aliasId);
    const aliasDoc = cleanObject({
      id: alias.aliasId,
      aliasId: alias.aliasId,
      kind: alias.kind,
      profileId,
      profileIdsByProgram,
      strength: alias.strength,
      piiMinimized: alias.piiMinimized,
      normalized: alias.piiMinimized ? undefined : alias.normalized,
      materializedVersion: MATERIALIZED_VERSION,
      projectionStatus: "fresh",
      staleAtIso: null,
      materializedAtIso: updatedAtIso,
      updatedAtIso,
    });
    let contentHash: string | undefined;
    try {
      contentHash = scpAliasContentDigest(aliasDoc);
    } catch {
      contentHash = undefined;
    }
    if (contentHash && existingAliasContentHashById.get(alias.aliasId) === contentHash) {
      aliasWritesSkipped += 1;
      continue;
    }
    batch.set(adminDb.collection(ALIAS_COLLECTION).doc(alias.aliasId), contentHash ? { ...aliasDoc, contentHash } : aliasDoc);
    count += 1;
    await commitIfNeeded();
  }
  if (count > 0) await batch.commit();
  const stale = await reconcileStaleMaterializedDocs(profileIds, freshAliasIds, updatedAtIso);

  let videoHistoryWritten = 0;
  for (const profile of projection.profiles) {
    videoHistoryWritten += await writeVideoHistory(profile.profileId, projection.videoHistoryByProfile[profile.profileId] ?? [], updatedAtIso);
  }

  return {
    projection,
    profileCount: projection.profiles.length,
    aliasCount: projection.graph.aliases.filter((alias) => {
      const identityProfileId = projection.graph.profileForAlias[alias.aliasId];
      return alias.strength === "strong" && Boolean(identityProfileId && profilesByIdentityProfileId.has(identityProfileId));
    }).length,
    videoHistoryWritten,
    staleProfileCount: stale.staleProfileCount,
    staleAliasCount: stale.staleAliasCount,
    profileWritesSkipped,
    aliasWritesSkipped,
    sourceCounts: sourceCounts(sources),
    updatedAtIso,
  };
}

export async function recordScpLifecycleRefreshFailure(input: {
  eventId?: string;
  profileId?: string;
  source?: string;
  error: unknown;
  errorCode?: unknown;
  correlationIdHash?: unknown;
  computedAtIso?: string;
}): Promise<{
  eventId: string;
  errorCode: ScpLifecycleFailureCode;
  correlationIdHash: string;
}> {
  const updatedAtIso = scpLifecycleIso(input.computedAtIso) || nowIso();
  // Keep the legacy `error` parameter for call-site compatibility, but never
  // inspect it: provider Error objects can carry raw messages, tokens, or
  // accessor-backed payloads. Only explicit, validated diagnostics cross this
  // persistence boundary.
  const errorCode = scpLifecycleFailureCode(input.errorCode);
  const source = scpLifecycleFailureSource(input.source ?? "manual_refresh");
  const eventId = scpLifecycleFailureEventId(
    input.eventId,
    [input.profileId ?? "all", source, updatedAtIso, errorCode].join("\u0000"),
  );
  const correlationHash = scpLifecycleCorrelationIdHash(
    input.correlationIdHash,
    ["scp_lifecycle_failure", eventId, input.profileId ?? "all", source, updatedAtIso].join("\u0000"),
  );
  try {
    const failureRef = adminDb.collection(REFRESH_OUTBOX_COLLECTION).doc(eventId);
    await adminDb.runTransaction(async (transaction) => {
      const existingSnapshot = await transaction.get(failureRef);
      const existing = existingSnapshot.data() ?? {};
      const profileIdHash = scpLifecycleHashOrRawHash(
        existing.profileIdHash,
        "profile_id",
        input.profileId ?? existing.profileId,
      );
      const sourceRefHash = scpLifecycleHashOrRawHash(
        existing.sourceRefHash,
        "source_ref",
        existing.sourceRef,
      );
      const reasonHash = scpLifecycleHashOrRawHash(
        existing.reasonHash,
        "reason",
        existing.reason,
      );
      const aliasIdHashes = scpLifecycleAliasIdHashes(existing);
      const aliasCount = aliasIdHashes.length > 0
        ? aliasIdHashes.length
        : scpLifecycleNonNegativeInteger(existing.aliasCount);
      // Replace the document with a closed schema instead of merging. This
      // preserves retry state while guaranteeing that raw source/profile/alias
      // references and any unrecognized producer fields are removed.
      transaction.set(failureRef, cleanObject({
        schemaVersion: 2,
        eventKind: "refresh_failed",
        eventIdHash: scpLifecycleIdentityHash("event_id", eventId),
        source,
        status: "failed",
        errorCode,
        correlationIdHash: correlationHash,
        profileIdHash: profileIdHash || undefined,
        sourceRefHash: sourceRefHash || undefined,
        reasonHash: reasonHash || undefined,
        aliasIdHashes: aliasIdHashes.length > 0 ? aliasIdHashes : undefined,
        aliasCount,
        attempts: scpLifecycleNonNegativeInteger(existing.attempts),
        processingStartedAtIso: scpLifecycleIso(existing.processingStartedAtIso) || undefined,
        processingLeaseExpiresAtIso: scpLifecycleIso(existing.processingLeaseExpiresAtIso) || undefined,
        sourceUpdatedAtIso: scpLifecycleIso(existing.sourceUpdatedAtIso) || undefined,
        createdAtIso: scpLifecycleIso(existing.createdAtIso) || updatedAtIso,
        updatedAtIso,
      }));
    });
    if (input.profileId) {
      await adminDb.collection(PROFILE_COLLECTION).doc(input.profileId).set({
        projectionStatus: "failed",
        lastRefreshError: errorCode,
        lastRefreshErrorCode: errorCode,
        lastRefreshErrorCorrelationIdHash: correlationHash,
        lastRefreshErrorMessage: FieldValue.delete(),
        staleAtIso: updatedAtIso,
        updatedAtIso,
      }, { merge: true });
    }
  } catch {
    throw safeScpLifecycleError(
      SCP_LIFECYCLE_FAILURE_CODES.failureRecordWrite,
      scpLifecycleCorrelationIdHash(
        "",
        ["scp_lifecycle_failure_record_write", eventId, correlationHash].join("\u0000"),
      ),
    );
  }
  return { eventId, errorCode, correlationIdHash: correlationHash };
}

function profileSummary(profile: Record<string, unknown>): Record<string, unknown> {
  return {
    currentState: profile.currentState,
    stateEnteredAt: profile.stateEnteredAt,
    videoHistoryCount: profile.videoHistoryCount,
    identityConflict: profile.identityConflict,
  };
}

export async function detectScpLifecycleDrift(sources: ScpLifecycleSources, options: { computedAtIso?: string } = {}) {
  const computedAtIso = options.computedAtIso ?? nowIso();
  const projection = projectScpLifecycleProfiles(sources, { computedAtIso });
  const driftRecords: Record<string, unknown>[] = [];
  for (const profile of projection.profiles) {
    const snapshot = await adminDb.collection(PROFILE_COLLECTION).doc(profile.profileId).get();
    const current = snapshot.exists ? snapshot.data() ?? {} : null;
    if (!current ||
      current.currentState !== profile.currentState ||
      current.stateEnteredAt !== profile.stateEnteredAt ||
      current.videoHistoryCount !== profile.videoHistoryCount ||
      current.identityConflict !== profile.identityConflict) {
      const id = `drift_${profile.profileId}`;
      const drift = cleanObject({
        id,
        eventId: id,
        profileId: profile.profileId,
        source: "drift_detection",
        status: "drift",
        expected: profileSummary(profile as unknown as Record<string, unknown>),
        current: current ? profileSummary(current) : null,
        createdAtIso: computedAtIso,
        updatedAtIso: computedAtIso,
      });
      await adminDb.collection(REFRESH_OUTBOX_COLLECTION).doc(id).set(drift, { merge: true });
      driftRecords.push(drift);
    }
  }

  const existingSnapshot = await adminDb.collection(PROFILE_COLLECTION)
    .where("materializedVersion", "in", MATERIALIZED_VERSIONS_TO_RECONCILE)
    .get();
  const freshProfileIds = new Set(projection.profiles.map((profile) => profile.profileId));
  for (const doc of existingSnapshot.docs) {
    if (freshProfileIds.has(doc.id)) continue;
    const id = `drift_stale_${doc.id}`;
    const drift = cleanObject({
      id,
      eventId: id,
      profileId: doc.id,
      source: "drift_detection",
      status: "drift",
      expected: null,
      current: profileSummary(doc.data() ?? {}),
      reason: "materialized profile absent from current projection",
      createdAtIso: computedAtIso,
      updatedAtIso: computedAtIso,
    });
    await adminDb.collection(REFRESH_OUTBOX_COLLECTION).doc(id).set(drift, { merge: true });
    driftRecords.push(drift);
  }
  return { projection, driftRecords, computedAtIso };
}

// A pass rebuilds the whole projection, so it also covers every event queued before it began.
// Retiring only the claimed 20 grew the queue without bound (prod 2026-08-05: 58,410 queued).
//
// W86-B [회수 순회 결정화]: 종전에는 `where(status==queued).limit(500)` 을 **커서 없이** 반복했다.
//   orderBy 가 없으면 Firestore 는 `__name__` 순으로 준다. 그런데 문서 id 는 `source_changed_<해시>`
//   라 사실상 무작위 순이고, 회수 대상(cutoff 이전)과 살려둘 것(cutoff 이후)이 그 안에 뒤섞인다.
//   그래서 한 페이지 500건이 **전부 cutoff 이후**면 `pageCount === 0` 으로 조기 break 했다 —
//   뒤쪽 페이지에 남아 있던 **오래된 queued 가 그 pass 에서 통째로 누락**되고 다음 pass 로 밀린다.
//   적체가 클수록 이 확률이 커져서, 회수가 유입을 못 따라가는 쪽으로 편향된다(적체의 지속 원인).
//
//   `__name__` 오름차순 + `startAfter` 커서로 바꾼다. 커서가 핵심이다 — **건너뛴 문서를 지나갈
//   수단**이 없어서 조기 break 가 필요했던 것이다(회수한 문서는 status 가 바뀌어 결과집합에서
//   빠지지만, 건너뛴 cutoff 이후 문서는 계속 queued 라 다음 질의에 또 나온다). 커서로 전진하면
//   조기 break 자체가 사라지고, 페이지가 전부 cutoff 이후여도 **뒤쪽의 오래된 queued 까지 끝까지
//   순회**한다. 순회 총량은 아래 maxPages 로 묶는다.
//
//   ■ `createdAtIso` 오름차순을 쓰지 않은 이유 (판단 기록):
//     정렬을 createdAtIso 로 두면 "첫 cutoff 초과 문서 = 이후 전부 초과"라 조기 종료가 증명
//     가능해져 더 우아하다. 그런데 그 질의는 복합 인덱스(status ASC, createdAtIso ASC)를 요구하고,
//     `firestore.indexes.json` 은 `PRODUCTION_INDEX_MANIFEST_SHA256`(scripts/prod-index-control-plane.mjs)
//     으로 **내용 고정**돼 있다 — 한 줄만 바꿔도 배포 가드 31건이 깨지고, 그 핀을 다시 박는 것은
//     릴리스 게이트가 걸린 리더 소관 행위다. 결함(오래된 queued 누락)은 커서만으로 완전히 닫히므로,
//     릴리스 표면을 건드리지 않는 쪽을 택했다. 인덱스 변형은 보고서에 후속안으로 남긴다.
//     비용: 조기 종료를 못 해 queued 전량을 훑는다. 다만 작업 1의 입자 수리로 queued 자체가
//     급감하고, maxPages 로 상한이 걸려 있어 pass 예산 안이다.
// W86-B R1 [적대 리뷰 CRITICAL · lost update 봉인]
//   종전(그리고 이 함수의 원본)은 페이지를 read 해 두고 **나중에 batch 를 blind commit** 했다.
//   read 와 commit 사이에는 재검증이 없다. 밀리초 eventId 시절엔 같은 문서를 두 주체가 동시에
//   만질 확률이 사실상 0이라 이 창이 드러나지 않았는데, **작업 1 의 day-grain 이 그 경합을
//   일상화**시켰다(같은 대상의 그날 재변이가 *같은 문서*로 온다). 하필 최고빈도 소스
//   (오픈 픽셀·대화)에서 가장 잘 터진다. 리뷰어 재현 60회 중 9~10회.
//
//   깨지는 방식: 페이지 read 시점엔 `createdAtIso <= cutoff` 라 회수 대상이었는데, commit 전에
//   cutoff **이후** 재변이가 merge 로 도착한다(status 를 다시 queued 로, createdAtIso 를 미래로).
//   그 뒤 도착한 retire batch 가 그것을 모른 채 `processed` 로 덮는다 → 재구축이 덮지 못한 변경이
//   "처리됨"으로 마감되고, 문서는 `status:"processed"` + `createdAtIso > cutoff` 라는 모순 상태로 남는다.
//   그날의 마지막 변이가 물리면 **영구 소실**이다(후속 변이가 오면 우연히 복구될 뿐 보장이 없다).
//
//   봉인: batch 를 버리고 **문서별 `lastUpdateTime` precondition** 으로 쓴다. 기준 시각은 이 페이지
//   스냅샷이 본 `doc.updateTime` 이다 — 그 사이 누가 한 번이라도 썼으면 precondition 이 깨진다.
//   깨지면 **조용히 skip** 한다(queued 유지 → 다음 pass 가 커버). 이게 "재변이가 이긴다" 계약이다.
//   batch 는 전부-성공/전부-실패라 이 계약을 표현할 수 없어서 부적합하다. BulkWriter 를 쓰는 이유는
//   개별 실패를 허용하면서도 내부적으로 BatchWrite 로 묶어 주기 때문이다(문서당 RPC 1회가 아니다).
// W86-B: 회귀 pin 이 이 함수만 직접 부를 수 있게 export 한다. 종전처럼 드레인 코어를 통해서만
//   확인하려면 테스트가 **전역 재구축**을 돌려야 하는데, 그러면 같은 에뮬레이터를 병렬로 쓰는
//   형제 테스트 파일의 프로필 타임스탬프·클레임 순번까지 흔들려 무관한 실패가 난다(실측).
/**
 * @returns `retired` = 실제로 processed 로 마감한 수, `skipped` = precondition 이 깨져 건너뛴 수.
 *   skip 은 오류가 아니라 정상 결과지만 **세지 않으면 보이지 않는다** — 경합이 치솟는 것을
 *   운영이 알아야 하므로 호출자에게 올린다.
 *
 * @param hooks W86-B R3 전용 주입 지점. **테스트에서만 넘긴다.** 경합은 read 와 write 사이의
 *   창에서만 일어나므로, 그 창을 실제 타이머로 노리면 테스트가 확률적이 된다(재현 스크립트가
 *   60회를 도는 이유다). `onPageRead` 로 그 창을 결정적으로 연다. 넘기지 않으면
 *   (프로덕션 호출부 전부) 아래 분기는 undefined 라 실행 자체가 없다.
 */
export async function retireRebuildCoveredRefreshEvents(
  cutoffIso: string,
  updatedAtIso: string,
  hooks: { onPageRead?: () => Promise<void> } = {},
): Promise<{ retired: number; skipped: number }> {
  let retired = 0;
  let skipped = 0;
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  // 한 pass 가 읽을 수 있는 페이지 상한. 회수 상한과 같은 예산에서 나온다 — 건너뛰기만 하는
  // 페이지가 이어져도 순회가 무한정 길어지지 않는다.
  const maxPages = Math.max(1, Math.ceil(MAX_REFRESH_RETIRE_PER_PASS / REFRESH_RETIRE_PAGE_SIZE));
  for (let page = 0; page < maxPages && retired < MAX_REFRESH_RETIRE_PER_PASS; page += 1) {
    let query = adminDb.collection(REFRESH_OUTBOX_COLLECTION)
      .where("status", "==", "queued")
      .orderBy(FieldPath.documentId(), "asc")
      .limit(REFRESH_RETIRE_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (snapshot.empty) break;
    // W86-B R3: read 와 write 사이의 창(= 결함이 살던 자리). 테스트만 이 훅을 넘긴다.
    if (hooks.onPageRead) await hooks.onPageRead();
    cursor = snapshot.docs[snapshot.docs.length - 1] ?? null;
    // W86-B R1: 개별 실패를 허용해야 하므로 batch(원자 전체)가 아니라 BulkWriter 다.
    const writer = adminDb.bulkWriter();
    // precondition 실패는 "재변이가 이겼다"는 정상 결과라 즉시 포기한다. 그 외(순단 등)는
    // 유한 재시도 — precondition 은 서버가 매 시도마다 다시 검사하므로 재시도해도 안전하다.
    writer.onWriteError((error) =>
      error.code !== FIRESTORE_FAILED_PRECONDITION_CODE && error.failedAttempts < 3);
    const pending: Array<Promise<void>> = [];
    let pageCount = 0;
    for (const doc of snapshot.docs) {
      // Retire only events provably enqueued before this pass started reading sources.
      // 건너뛴 문서는 커서가 이미 지나갔으므로 다음 페이지를 막지 않는다.
      const createdAtIso = asString(doc.get("createdAtIso"));
      if (createdAtIso && createdAtIso > cutoffIso) continue;
      pending.push(
        writer
          .update(doc.ref, {
            status: "processed",
            processedAtIso: updatedAtIso,
            coveredByRebuild: true,
            processingLeaseExpiresAtIso: null,
            updatedAtIso,
          }, { lastUpdateTime: doc.updateTime })
          .then(() => {
            pageCount += 1;
          })
          .catch((error: unknown) => {
            const code = (error as { code?: number }).code;
            if (code === FIRESTORE_FAILED_PRECONDITION_CODE) {
              // 이 문서는 read 이후에 다시 쓰였다(재변이 도착 또는 삭제). queued 를 존중하고 지나간다.
              skipped += 1;
              return;
            }
            // 진짜 실패(권한·순단 재시도 소진) — queued 로 남아 다음 pass 가 재시도한다.
            // 경합(skipped)과 섞지 않고 별도로 관측 가능하게 남긴다.
            console.error("[lifecycle-retire] non-precondition write failure", code, error);
          }),
      );
    }
    if (pending.length > 0) {
      await writer.close();
      await Promise.all(pending);
      retired += pageCount;
    } else {
      await writer.close();
    }
    if (snapshot.size < REFRESH_RETIRE_PAGE_SIZE) break;
  }
  return { retired, skipped };
}

// 코어(무인증): 콜러블과 스케줄러가 공유하는 outbox 드레인 본체.
// queued/만료 리스 이벤트를 트랜잭션 클레임 → 전량 재계산(materialize) → processed 마킹 →
// 그 재계산이 덮은 queued 이벤트 회수. queued 0건이면 재계산 없이 즉시 no-op이므로 주기 실행 유휴 비용이 없다.
// W86-B R3: `onClaimed` 는 **테스트 전용** 주입 지점이다. 클레임과 마감 사이(= 소스 read +
//   materialize 구간)에 재변이가 도착하는 상황을 결정적으로 만든다. 콜러블/스케줄러 호출부는
//   넘기지 않으므로 프로덕션 경로에는 undefined 이고 분기 자체가 실행되지 않는다.
export async function processScpLifecycleRefreshOutboxCore(
  options: { limit?: number; sourceLimit?: number; onClaimed?: () => Promise<void> } = {},
) {
  const limit = typeof options.limit === "number"
    ? Math.max(1, Math.min(Math.trunc(options.limit), MAX_REFRESH_PROCESS_LIMIT))
    : DEFAULT_REFRESH_PROCESS_LIMIT;
  const sourceLimit = typeof options.sourceLimit === "number"
    ? Math.max(1, Math.min(Math.trunc(options.sourceLimit), DEFAULT_SOURCE_LIMIT))
    : DEFAULT_SOURCE_LIMIT;
  const processingAtIso = nowIso();
  const expiredProcessingSnapshot = await adminDb.collection(REFRESH_OUTBOX_COLLECTION)
    .where("status", "==", "processing")
    .where("processingLeaseExpiresAtIso", "<=", processingAtIso)
    .orderBy("processingLeaseExpiresAtIso", "asc")
    .limit(limit)
    .get();
  const queuedSnapshot = await adminDb.collection(REFRESH_OUTBOX_COLLECTION)
    .where("status", "==", "queued")
    .limit(Math.max(1, limit - expiredProcessingSnapshot.docs.length))
    .get();
  const candidateDocs = [
    ...expiredProcessingSnapshot.docs,
    ...queuedSnapshot.docs,
  ].slice(0, limit);

  if (candidateDocs.length === 0) {
    return { ok: true, processedCount: 0, eventIds: [] as string[] };
  }

  const processingLeaseExpiresAtIso = new Date(Date.parse(processingAtIso) + 10 * 60 * 1000).toISOString();
  const claimedDocs: Array<{ id: string; ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> = [];
  for (const doc of candidateDocs) {
    const claimed = await adminDb.runTransaction(async (transaction) => {
      const fresh = await transaction.get(doc.ref);
      const row = fresh.data() ?? {};
      const status = asString(row.status);
      const leaseExpiresAtIso = asString(row.processingLeaseExpiresAtIso);
      const claimable = status === "queued" || (status === "processing" && leaseExpiresAtIso && leaseExpiresAtIso <= processingAtIso);
      if (!claimable) return null;
      transaction.set(doc.ref, {
        status: "processing",
        processingStartedAtIso: processingAtIso,
        processingLeaseExpiresAtIso,
        attempts: FieldValue.increment(1),
        updatedAtIso: processingAtIso,
      }, { merge: true });
      return { id: doc.id, ref: doc.ref, data: row };
    });
    if (claimed) claimedDocs.push(claimed);
  }

  if (claimedDocs.length === 0) {
    return { ok: true, processedCount: 0, eventIds: [] as string[] };
  }

  try {
    // W86-B R3: 클레임과 마감 사이의 창(= R2 결함이 살던 자리). 테스트만 이 훅을 넘긴다.
    if (options.onClaimed) await options.onClaimed();
    const sources = await readScpLifecycleSources(sourceLimit);
    const result = await materializeScpLifecycleProjection(sources);
    // W86-B R2 [적대 리뷰 CRITICAL · 마감은 이 pass 가 여전히 소유한 문서에만]
    //   여기가 retire 보다 더 무방비였다. 클레임은 트랜잭션인데, 마감 batch 는 소스 read +
    //   materialize **전 구간(수 초~수십 초)** 이 지난 뒤 재검증 없이 덮었다. cutoff 검사조차 없다.
    //   그 사이 같은 문서로 재변이가 도착하면(day-grain 이라 같은 eventId 다) merge 가 status 를
    //   queued 로 되돌리는데, 뒤늦은 마감이 그것을 processed 로 덮어 **재구축이 보지 못한 변경이
    //   처리됨으로 마감**된다.
    //
    //   계약: "재변이가 이긴다." 클레임이 남긴 두 표식이 **그대로**일 때만 마감한다.
    //     · status === "processing"                  ← 재변이가 왔으면 "queued" 로 바뀌어 있다
    //     · processingStartedAtIso === processingAtIso ← 다른 pass 가 리스를 가져갔으면 다르다
    //   하나라도 어긋나면 마감을 건너뛰고 문서를 그대로 둔다(다음 pass 가 커버한다).
    //   문서별 트랜잭션이지만 claim 상한이 20건이라 비용은 무시할 수준이고, 판정이 코드에서
    //   그대로 읽힌다 — precondition 시각 비교보다 의도가 분명하다.
    const finalizePatch = {
      status: "processed",
      processedAtIso: result.updatedAtIso,
      processingLeaseExpiresAtIso: null,
      profileCount: result.profileCount,
      aliasCount: result.aliasCount,
      videoHistoryWritten: result.videoHistoryWritten,
      staleProfileCount: result.staleProfileCount,
      staleAliasCount: result.staleAliasCount,
      updatedAtIso: result.updatedAtIso,
    };
    const finalizedIds: string[] = [];
    let finalizeSkippedCount = 0;
    for (const doc of claimedDocs) {
      const finalized = await adminDb.runTransaction(async (transaction) => {
        const fresh = await transaction.get(doc.ref);
        if (!fresh.exists) return false;
        const row = fresh.data() ?? {};
        if (asString(row.status) !== "processing") return false;
        if (asString(row.processingStartedAtIso) !== processingAtIso) return false;
        transaction.set(doc.ref, finalizePatch, { merge: true });
        return true;
      });
      if (finalized) finalizedIds.push(doc.id);
      else finalizeSkippedCount += 1;
    }
    const retireOutcome = await retireRebuildCoveredRefreshEvents(processingAtIso, result.updatedAtIso);
    return {
      ok: true,
      processedCount: finalizedIds.length,
      finalizeSkippedCount,
      retiredCount: retireOutcome.retired,
      retireSkippedCount: retireOutcome.skipped,
      eventIds: finalizedIds,
      profileCount: result.profileCount,
      aliasCount: result.aliasCount,
      videoHistoryWritten: result.videoHistoryWritten,
      updatedAtIso: result.updatedAtIso,
    };
  } catch (error) {
    const failedAtIso = nowIso();
    const correlationHash = scpLifecycleCorrelationIdHash(
      undefined,
      [
        "scp_lifecycle_refresh_process",
        claimedDocs.map((doc) => doc.id).sort().join(","),
        failedAtIso,
      ].join("\u0000"),
    );
    await Promise.all(claimedDocs.map((doc) => recordScpLifecycleRefreshFailure({
      eventId: doc.id,
      profileId: asString(doc.data.profileId) || undefined,
      source: asString(doc.data.source, "refresh_outbox"),
      error,
      errorCode: SCP_LIFECYCLE_FAILURE_CODES.refresh,
      correlationIdHash: correlationHash,
      computedAtIso: failedAtIso,
    })));
    throw safeScpLifecycleError(
      SCP_LIFECYCLE_FAILURE_CODES.refresh,
      correlationHash,
    );
  }
}

export async function processScpLifecycleRefreshOutbox(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scpLifecycleProfiles.processOutbox", ["super_admin", "admin"]);
  // 2026-09-27 codex adversarial review round 2 sweep: no general-purpose UI reaches this
  // maintenance/diagnostic tool (unlike getScpLifecycleProfile/getScpLifecycleVideoHistory above).
  await assertScpEntitled(auth, request, "scpLifecycleProfiles.processOutbox");
  const data = asRecord(request.data);
  try {
    const result = await processScpLifecycleRefreshOutboxCore({
      limit: typeof data.limit === "number" ? data.limit : undefined,
      sourceLimit: typeof data.sourceLimit === "number" ? data.sourceLimit : undefined,
    });
    return {
      ...result,
      behaviorLog: makeBehaviorLog(auth, "scpLifecycleProfiles.processOutbox", "success"),
    };
  } catch (error) {
    const wrapped = closedScpLifecycleError(
      error,
      SCP_LIFECYCLE_FAILURE_CODES.refresh,
      ["scp_lifecycle_refresh_process_callable", auth.userId, nowIso()].join("\u0000"),
    );
    Object.assign(wrapped, {
      behaviorLog: makeBehaviorLog(auth, "scpLifecycleProfiles.processOutbox", "error"),
    });
    throw wrapped;
  }
}

function profileIdsForCanonicalProgram(
  aliasData: Record<string, unknown>,
  programId: string,
  aliasMap: Record<string, string>,
): string[] {
  if (aliasData.projectionStatus !== "fresh" || aliasData.materializedVersion !== MATERIALIZED_VERSION) return [];
  const profileIdsByProgram = asRecord(aliasData.profileIdsByProgram);
  const canonicalProgramId = resolveCanonicalProgramId(programId, aliasMap);
  return [...new Set(Object.entries(profileIdsByProgram)
    .filter(([candidateProgramId]) => resolveCanonicalProgramId(candidateProgramId, aliasMap) === canonicalProgramId)
    .map(([, profileId]) => asString(profileId))
    .filter(Boolean))].sort();
}

type ScpLifecycleProfileResolution = {
  profileId: string;
  profile: Record<string, unknown> | null;
  notFoundReason: ScpLifecycleProfileNotFoundReason | null;
};

async function validateScpLifecycleProfileId(
  profileId: string,
  programId: string,
  aliasMap: Record<string, string>,
): Promise<ScpLifecycleProfileResolution> {
  if (!profileId) return { profileId: "", profile: null, notFoundReason: "not_found" };
  const snapshot = await adminDb.collection(PROFILE_COLLECTION).doc(profileId).get();
  if (!snapshot.exists) return { profileId, profile: null, notFoundReason: "not_found" };
  const profile = { id: snapshot.id, ...(snapshot.data() ?? {}) };
  const notFoundReason = scpLifecycleProfileNotFoundReason(profile, programId, aliasMap);
  return notFoundReason
    ? { profileId, profile: null, notFoundReason }
    : { profileId, profile, notFoundReason: null };
}

// Additive last-resort source (P2, FLU-0540): Portal Apply v2/v3 intake never creates a
// scp_lifecycle_profiles / scp_identity_aliases row — it only ever materializes a
// scp_application_management record (./applicationManagementStore.ts). Without this, a portal-origin
// creator's every alias/profileId lookup above legitimately misses, and getScpLifecycleProfile returns
// found:false forever (the "프로필 불러오는 중" lockup). Only ever consulted after every existing source
// above has already missed — it never overrides a real lifecycle profile.
const SCP_APPLICATION_MANAGEMENT_FALLBACK_SOURCE = "scp_application_management" as const;

function applicationManagementFallbackCandidates(data: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  const push = (value: unknown) => {
    const candidate = asString(value);
    if (candidate) candidates.push(candidate);
  };
  push(data.profileId);
  push(data.creatorId);
  push(data.leadId);
  if (asString(data.kind)) push(data.value);
  return candidates;
}

// Truncates an opaque applicationId into a short label for display when no portal-application display
// name is available (scp_application_management never stores one — PRIVACY: no raw PII/email/handle is
// ever written there, see applicationManagementStore.ts header). applicationId itself is already an
// opaque Portal-issued identifier, never a raw contact detail.
function truncateApplicationIdForDisplay(applicationId: string): string {
  return applicationId.length > 12 ? `${applicationId.slice(0, 8)}…` : applicationId;
}

/**
 * B2-7: management-only Apply → lifecycle profile 투영(순수). 상세 경로와 목록 경로가 **같은** 한 벌을
 * 쓰도록 분리했다. 여기서 만드는 상태는 `form_submitted` 하나뿐이며(그 컬렉션이 보증하는 유일한 사실),
 * 표시 이름은 opaque applicationId 축약뿐이다 — 이름/단계를 지어내지 않는다.
 */
/**
 * 폴백 행이 alias 매칭에 실을 신원 alias id.
 *
 * W104-2 중복계상 수리: 폴백 행이 aliasIds 를 안 실으면 src/lib/scp-management-buckets.ts 의
 * scpProfileRef 가 null 을 돌려(배열이 아니므로) 이 행은 크리에이터와 **절대** alias 매칭되지
 * 않는다 → lifecycle 프로필이 없는 manual_non_scp 크리에이터와 같은 사람이 칩 카운트에 두 번 셈된다.
 * 관리 문서가 실제로 들고 있는 강한 신원(identity.fluCreatorId / identity.channelId)만 alias 로 올린다.
 *
 * 목록 dedup(read.ts partitionApplicationManagementFallbackWindow)과 행 투영이 **같은 계산**을 쓰도록
 * 여기 한 곳에서만 만든다 — 갈라지면 사전 dedup 이 사문화된다.
 */
export function applicationManagementFallbackAliasIds(
  record: Pick<ApplicationManagementLifecycleFallbackProfile, "fluCreatorId" | "channelId">,
): string[] {
  return [
    makeScpAlias("creatorId", record.fluCreatorId)?.aliasId,
    makeScpAlias("channelId", record.channelId)?.aliasId,
  ].filter((aliasId): aliasId is string => Boolean(aliasId));
}

export function applicationManagementFallbackProfileRow(
  record: ApplicationManagementLifecycleFallbackProfile,
  computedAtIso: string,
): Record<string, unknown> {
  const profileId = record.matchedIdentifier;
  // 근거가 하나도 없으면 필드 자체를 생략한다 — 빈 배열은 scpProfileRef 를 통과시켜(배열이므로) 이
  // 행을 "alias 는 없지만 매칭 가능한 프로필"로 바꿔버리므로 현행 유지가 더 안전하다.
  const aliasIds = applicationManagementFallbackAliasIds(record);
  return cleanObject({
    profileId,
    id: profileId,
    aliasIds: aliasIds.length > 0 ? aliasIds : undefined,
    programId: record.programId ?? "",
    programIds: record.programId ? [record.programId] : [],
    // "form_submitted" is the one canonical SCP_LIFECYCLE_STATES value that always holds true for
    // every scp_application_management record: it only ever exists because an application.submitted
    // event materialized it (./applicationManagementStore.ts). No later lifecycle stage (qualification/
    // uid/gem/video) is tracked by this collection, so asserting anything past this would be a guess.
    currentState: "form_submitted",
    stateEnteredAt: record.submittedAtIso || computedAtIso,
    nextRequiredAction: "",
    blockingReason: null,
    counts: {},
    latestVideoStatus: [],
    videoHistoryCount: 0,
    videoHistoryTruncated: false,
    projectionStatus: "fresh",
    identityConflict: false,
    sourceRefs: [`${SCP_APPLICATION_MANAGEMENT_FALLBACK_SOURCE}/${record.applicationId}`],
    computedAtIso,
    submittedAtIso: record.submittedAtIso || undefined,
    source: SCP_APPLICATION_MANAGEMENT_FALLBACK_SOURCE,
    applicationId: record.applicationId,
    campaignId: record.campaignId ?? undefined,
    outreachId: record.outreachId ?? undefined,
    outreachName: record.outreachName,
    outreachHandle: record.outreachHandle,
    outreachPlatform: record.outreachPlatform,
    outreachCountry: record.outreachCountry,
    outreachCategory: record.outreachCategory,
    declaredHandle: record.declaredHandle,
    declaredName: record.declaredName,
    declaredCountry: record.declaredCountry,
    declaredCategory: record.declaredCategory,
    campaignName: record.campaignName,
    classification: record.classification,
    manageInbox: record.manageInbox,
    reasonCode: record.reasonCode,
    displayName: truncateApplicationIdForDisplay(record.applicationId),
  });
}

async function resolvePortalApplicationManagementFallback(
  data: Record<string, unknown>,
): Promise<ScpLifecycleProfileResolution | null> {
  const candidates = applicationManagementFallbackCandidates(data);
  if (candidates.length === 0) return null;
  const record = await findApplicationManagementRecordForLifecycleFallback(candidates);
  if (!record) return null;
  const profile = applicationManagementFallbackProfileRow(record, nowIso());
  return { profileId: record.matchedIdentifier, profile, notFoundReason: null };
}

async function resolveScpLifecycleProfileData(data: Record<string, unknown>): Promise<ScpLifecycleProfileResolution> {
  const aliasRegistryState = await readConfirmedProgramAliasRegistryState();
  const programId = resolveCanonicalProgramId(
    asString(data.programId, DEFAULT_SCP_PROGRAM_ID),
    aliasRegistryState.aliasMap,
  );
  const direct = asString(data.profileId);
  if (direct) {
    const resolved = await validateScpLifecycleProfileId(direct, programId, aliasRegistryState.aliasMap);
    if (resolved.profile) return resolved;
    return (await resolvePortalApplicationManagementFallback(data)) ?? resolved;
  }
  let rejected: ScpLifecycleProfileResolution | null = null;
  const aliasId = asString(data.aliasId);
  if (aliasId) {
    const snapshot = await adminDb.collection(ALIAS_COLLECTION).doc(aliasId).get();
    const aliasData = snapshot.data() ?? {};
    for (const profileId of profileIdsForCanonicalProgram(aliasData, programId, aliasRegistryState.aliasMap)) {
      const resolved = await validateScpLifecycleProfileId(profileId, programId, aliasRegistryState.aliasMap);
      if (resolved.profile) return resolved;
      rejected = resolved;
    }
  }
  const explicitKind = asString(data.kind) as ScpAliasKind;
  const aliasInputs: Array<[ScpAliasKind, unknown]> = [];
  if (explicitKind && data.value !== undefined) aliasInputs.push([explicitKind, data.value]);
  aliasInputs.push(
    ["email", data.email],
    ["leadId", data.leadId],
    ["creatorId", data.creatorId],
    ["submissionId", data.submissionId],
    ["videoId", data.videoId],
    ["channelId", data.channelId],
    ["trackingId", data.trackingId],
  );
  for (const [kind, value] of aliasInputs) {
    const alias = makeScpAlias(kind, value);
    if (!alias) continue;
    const snapshot = await adminDb.collection(ALIAS_COLLECTION).doc(alias.aliasId).get();
    const aliasData = snapshot.data() ?? {};
    for (const profileId of profileIdsForCanonicalProgram(aliasData, programId, aliasRegistryState.aliasMap)) {
      const resolved = await validateScpLifecycleProfileId(profileId, programId, aliasRegistryState.aliasMap);
      if (resolved.profile) return resolved;
      rejected ??= resolved;
    }
  }
  const notFound = rejected ?? { profileId: "", profile: null, notFoundReason: "not_found" as const };
  return (await resolvePortalApplicationManagementFallback(data)) ?? notFound;
}

export async function refreshScpLifecycleProfiles(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scpLifecycleProfiles.refresh", ["super_admin", "admin"]);
  // 2026-09-27 codex adversarial review round 2 sweep: no general-purpose UI reaches this
  // maintenance/diagnostic tool.
  await assertScpEntitled(auth, request, "scpLifecycleProfiles.refresh");
  const data = asRecord(request.data);
  const limit = typeof data.limit === "number" ? Math.max(1, Math.min(Math.trunc(data.limit), DEFAULT_SOURCE_LIMIT)) : DEFAULT_SOURCE_LIMIT;
  try {
    const sources = await readScpLifecycleSources(limit);
    const result = await materializeScpLifecycleProjection(sources);
    return {
      ok: true,
      profileCount: result.profileCount,
      aliasCount: result.aliasCount,
      videoHistoryWritten: result.videoHistoryWritten,
      sourceCounts: result.sourceCounts,
      updatedAtIso: result.updatedAtIso,
      behaviorLog: makeBehaviorLog(auth, "scpLifecycleProfiles.refresh", "success"),
    };
  } catch (error) {
    const failedAtIso = nowIso();
    const correlationHash = scpLifecycleCorrelationIdHash(
      undefined,
      ["scp_lifecycle_manual_refresh", auth.userId, failedAtIso].join("\u0000"),
    );
    let boundaryError: unknown = safeScpLifecycleError(
      SCP_LIFECYCLE_FAILURE_CODES.refresh,
      correlationHash,
    );
    try {
      await recordScpLifecycleRefreshFailure({
        source: "manual_refresh",
        error,
        errorCode: SCP_LIFECYCLE_FAILURE_CODES.refresh,
        correlationIdHash: correlationHash,
        computedAtIso: failedAtIso,
      });
    } catch (failureRecordError) {
      boundaryError = failureRecordError;
    }
    const wrapped = closedScpLifecycleError(
      boundaryError,
      SCP_LIFECYCLE_FAILURE_CODES.refresh,
      ["scp_lifecycle_manual_refresh_callable", auth.userId, failedAtIso].join("\u0000"),
    );
    Object.assign(wrapped, {
      behaviorLog: makeBehaviorLog(auth, "scpLifecycleProfiles.refresh", "error"),
    });
    throw wrapped;
  }
}

export async function diffScpLifecycleProfiles(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scpLifecycleProfiles.diff", ["super_admin", "admin"]);
  // 2026-09-27 codex adversarial review round 2 sweep: no general-purpose UI reaches this
  // maintenance/diagnostic tool.
  await assertScpEntitled(auth, request, "scpLifecycleProfiles.diff");
  const data = asRecord(request.data);
  const limit = typeof data.limit === "number" ? Math.max(1, Math.min(Math.trunc(data.limit), DEFAULT_SOURCE_LIMIT)) : DEFAULT_SOURCE_LIMIT;
  const sources = await readScpLifecycleSources(limit);
  const result = await detectScpLifecycleDrift(sources);
  return {
    ok: true,
    driftCount: result.driftRecords.length,
    driftRecords: result.driftRecords,
    behaviorLog: makeBehaviorLog(auth, "scpLifecycleProfiles.diff", "success"),
  };
}

export async function getScpLifecycleProfile(request: CallableRequestShape) {
  // 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate): NOT gated by
  // assertScpEntitled — this creator lifecycle profile read also backs the general-purpose
  // Influencer detail page (src/app/(app)/flu/influencers/[id]/page.tsx), reachable by every org
  // regardless of scp mailbox entitlement. The role list above (manager+) remains the only gate.
  const auth = assertNonGuestAuth(request, "scpLifecycleProfiles.get", ["super_admin", "admin", "manager"]);
  const resolved = await resolveScpLifecycleProfileData(asRecord(request.data));
  if (!resolved.profile) {
    return {
      ok: true,
      found: false,
      profileId: resolved.profileId,
      notFoundReason: resolved.notFoundReason,
      behaviorLog: makeBehaviorLog(auth, "scpLifecycleProfiles.get", "success"),
    };
  }
  return {
    ok: true,
    found: true,
    profileId: resolved.profileId,
    profile: resolved.profile,
    behaviorLog: makeBehaviorLog(auth, "scpLifecycleProfiles.get", "success"),
  };
}

export async function getScpLifecycleVideoHistory(request: CallableRequestShape) {
  // 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate): NOT gated by
  // assertScpEntitled — same reachability as getScpLifecycleProfile above (Influencer detail
  // page, not exclusive to /flu/scp).
  const auth = assertNonGuestAuth(request, "scpLifecycleProfiles.videoHistory", ["super_admin", "admin", "manager"]);
  const data = asRecord(request.data);
  const resolved = await resolveScpLifecycleProfileData(data);
  const profileId = resolved.profileId;
  const limit = pageSize(data.limit);
  if (!resolved.profile) {
    return {
      ok: true,
      found: false,
      profileId,
      notFoundReason: resolved.notFoundReason,
      rows: [],
      pageInfo: { limit, truncated: false, nextCursor: null },
      behaviorLog: makeBehaviorLog(auth, "scpLifecycleProfiles.videoHistory", "success"),
    };
  }
  const decodedCursor = decodeCursor(data.cursor);
  let query = adminDb.collection(PROFILE_COLLECTION).doc(profileId).collection(VIDEO_HISTORY_COLLECTION)
    .orderBy("statusAtIso", "desc")
    .orderBy(FieldPath.documentId());
  if (decodedCursor) query = query.startAfter(decodedCursor.orderValue ?? null, decodedCursor.docId);
  const snapshot = await query.limit(limit + 1).get();
  const docs = snapshot.docs.slice(0, limit);
  const rows = docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const lastDoc = docs.at(-1);
  const nextCursor = snapshot.docs.length > limit && lastDoc
    ? encodeCursor({ docId: lastDoc.id, orderValue: asString(lastDoc.data().statusAtIso) || undefined })
    : null;
  return {
    ok: true,
    found: true,
    profileId,
    rows,
    pageInfo: { limit, truncated: snapshot.docs.length > limit, nextCursor },
    behaviorLog: makeBehaviorLog(auth, "scpLifecycleProfiles.videoHistory", "success"),
  };
}

export async function resolveScpLifecycleProfile(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scpLifecycleProfiles.resolve", ["super_admin", "admin", "manager"]);
  // 2026-09-27 codex adversarial review round 2 sweep: unlike getScpLifecycleProfile above (which
  // backs the general-purpose Influencer detail page), no client UI reaches this one.
  await assertScpEntitled(auth, request, "scpLifecycleProfiles.resolve");
  const resolved = await resolveScpLifecycleProfileData(asRecord(request.data));
  return {
    ok: true,
    found: Boolean(resolved.profile),
    profileId: resolved.profileId,
    notFoundReason: resolved.notFoundReason,
    behaviorLog: makeBehaviorLog(auth, "scpLifecycleProfiles.resolve", "success"),
  };
}

function scpLifecycleOutboxProjection(
  doc: FirebaseFirestore.QueryDocumentSnapshot,
): Record<string, unknown> {
  const row = doc.data() ?? {};
  const rawStatus = asString(row.status);
  const status = SCP_LIFECYCLE_OUTBOX_STATUS_SET.has(rawStatus)
    ? rawStatus
    : "unknown";
  const rawEventKind = asString(row.eventKind);
  const inferredEventKind = status === "failed"
    ? "refresh_failed"
    : status === "drift"
      ? "drift_detected"
      : status === "stale"
        ? "materialized_stale"
        : "source_changed";
  const eventKind = SCP_LIFECYCLE_OUTBOX_EVENT_KIND_SET.has(rawEventKind)
    ? rawEventKind
    : inferredEventKind;
  const rawErrorCode = asString(row.errorCode);
  const errorCode = SCP_LIFECYCLE_FAILURE_CODE_SET.has(rawErrorCode)
    ? rawErrorCode
    : undefined;
  const aliasIdHashes = scpLifecycleAliasIdHashes(row);
  const aliasCount = aliasIdHashes.length > 0
    ? aliasIdHashes.length
    : scpLifecycleNonNegativeInteger(row.aliasCount);
  return cleanObject({
    schemaVersion: 2,
    eventKind,
    eventIdHash: scpLifecycleHashOrRawHash(
      row.eventIdHash,
      "event_id",
      asString(row.eventId, doc.id),
    ),
    source: scpLifecycleFailureSource(row.source),
    status,
    errorCode,
    correlationIdHash: scpLifecycleValidatedHash(row.correlationIdHash) || undefined,
    profileIdHash: scpLifecycleHashOrRawHash(
      row.profileIdHash,
      "profile_id",
      row.profileId,
    ) || undefined,
    sourceRefHash: scpLifecycleHashOrRawHash(
      row.sourceRefHash,
      "source_ref",
      row.sourceRef,
    ) || undefined,
    reasonHash: scpLifecycleHashOrRawHash(
      row.reasonHash,
      "reason",
      row.reason,
    ) || undefined,
    aliasIdHashes: aliasIdHashes.length > 0 ? aliasIdHashes : undefined,
    aliasCount,
    attempts: scpLifecycleNonNegativeInteger(row.attempts),
    processingStartedAtIso: scpLifecycleIso(row.processingStartedAtIso) || undefined,
    processingLeaseExpiresAtIso: scpLifecycleIso(row.processingLeaseExpiresAtIso) || undefined,
    sourceUpdatedAtIso: scpLifecycleIso(row.sourceUpdatedAtIso) || undefined,
    processedAtIso: scpLifecycleIso(row.processedAtIso) || undefined,
    createdAtIso: scpLifecycleIso(row.createdAtIso) || undefined,
    updatedAtIso: scpLifecycleIso(row.updatedAtIso) || undefined,
    profileCount: scpLifecycleNonNegativeInteger(row.profileCount),
    videoHistoryWritten: scpLifecycleNonNegativeInteger(row.videoHistoryWritten),
    staleProfileCount: scpLifecycleNonNegativeInteger(row.staleProfileCount),
    staleAliasCount: scpLifecycleNonNegativeInteger(row.staleAliasCount),
  });
}

// W86-A: 목록 응답에 **드레인 힌트**를 싣는다. 어드민이 이 표면에 들어오면 화면이 힌트를 보고
//   processScpLifecycleRefreshOutbox 를 (await 없이) 쏜다 = "접속 시 갱신".
//   힌트를 서버가 계산하는 이유: 목록은 `limit` 로 잘린 최근 행만 주므로 클라가 queued 총량을
//   알 수 없다. count() 집계는 status 단일 필드 색인으로 처리돼 **새 인덱스가 필요 없다**
//   (브리핑 제약: 새 컬렉션/인덱스 금지).
//
//   게이트가 두 겹인 이유:
//     · queued > 0        — 큐가 비면 코어가 어차피 no-op 이지만 그 no-op 도 왕복 1회다.
//     · 마지막 pass 경과   — 드레인 1회는 **전역 재계산**이라 비싸다. 어드민 두 명이 연달아
//                            들어왔다고 재계산을 두 번 돌리면 안 된다. 코어의 클레임 리스는
//                            동시성만 막고 **순차 연타**는 못 막으므로 여기서 쿨다운을 건다.
const LIFECYCLE_DRAIN_COOLDOWN_MS = 10 * 60 * 1000;

export async function listScpLifecycleRefreshOutbox(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scpLifecycleProfiles.outbox", ["super_admin", "admin"]);
  // 2026-09-27 codex adversarial review round 2 sweep: no general-purpose UI reaches this
  // maintenance/diagnostic tool.
  await assertScpEntitled(auth, request, "scpLifecycleProfiles.outbox");
  const limit = pageSize(asRecord(request.data).limit);
  const collection = adminDb.collection(REFRESH_OUTBOX_COLLECTION);
  const [snapshot, queuedAggregate] = await Promise.all([
    collection.orderBy("updatedAtIso", "desc").orderBy(FieldPath.documentId()).limit(limit).get(),
    collection.where("status", "==", "queued").count().get(),
  ]);
  const queuedCount = Number(queuedAggregate.data().count ?? 0);
  // 마지막 pass 시각은 별도 문서를 두지 않고 **아웃박스 자신**에서 읽는다(새 컬렉션 금지).
  // 가져온 최근 행 중 processed 흔적의 최대값이면 충분하다 — 없으면 "오래됐다"로 본다.
  const lastPassAtIso = snapshot.docs.reduce((latest, doc) => {
    const processedAtIso = asString(doc.get("processedAtIso"));
    return processedAtIso > latest ? processedAtIso : latest;
  }, "");
  const lastPassMs = lastPassAtIso ? Date.parse(lastPassAtIso) : Number.NaN;
  const passIsStale = !Number.isFinite(lastPassMs) || Date.now() - lastPassMs >= LIFECYCLE_DRAIN_COOLDOWN_MS;
  return {
    ok: true,
    rows: snapshot.docs.map(scpLifecycleOutboxProjection),
    // 하위호환: 기존 소비자는 rows 만 읽는다. 아래는 **추가 필드**이고 내부 인프라명을 담지 않는다.
    drainHint: {
      queuedCount,
      lastPassAtIso: lastPassAtIso || null,
      shouldDrain: queuedCount > 0 && passIsStale,
      cooldownMs: LIFECYCLE_DRAIN_COOLDOWN_MS,
    },
    behaviorLog: makeBehaviorLog(auth, "scpLifecycleProfiles.outbox", "success"),
  };
}
