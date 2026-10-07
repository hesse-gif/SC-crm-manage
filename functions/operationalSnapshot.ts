import { createHash } from "node:crypto";
import { FieldPath, FieldValue, Timestamp, type Query, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { expireAt180DaysFromDate } from "./firestoreTtl";
import { buildScpIdentityGraph, makeScpAlias, type ScpAliasConflict, type ScpAliasKind } from "./scpLifecycleProjection";
import { isOperationalFixtureRecord } from "./operationalFixtureProvenance";
import { canonicalScpProgramId, isScpProgramId, normalizeScpProgramId } from "./scpProgramAlias";
import { LEGACY_SHEET_PORTAL_PROGRAM_ID } from "./legacySheetContentMigrationProjection";
import {
  confirmedProgramAliasMap,
  confirmedProgramAliasRegistryRevision,
  resolveCanonicalProgramId,
} from "./programCanonical";
import { readConfirmedProgramAliasRegistryState } from "./programAliasRegistry";
import { rowMatchesAccountScope } from "./readScope";
// 발송 판정 정본(허용목록 1종). 프로젝션마다 다시 정의하면 조용히 갈린다.
import { isDeliveredOutboundLogRow } from "./nudgeReportFacts";
import { assertNonGuestAuth, asRecord, asString, makeBehaviorLog, makeCache, type AuthContext, type CallableRequestShape } from "./shared";

const ACTION_GET = "operational_snapshot.get";
const ACTION_REBUILD = "operational_snapshot.rebuild";
const RBAC_ROLES = ["super_admin", "admin", "manager"] as const;
const SNAPSHOT_SCHEMA_VERSION = "operational_snapshot_v2" as const;
const LEGACY_SNAPSHOT_SCHEMA_VERSION = "operational_snapshot_v1" as const;
const AGGREGATE_VERSION = "g006_operational_snapshot_alias_revision_2026_07_12" as const;
const DEFAULT_SURFACE = "flu_dashboard";
const SURFACES = new Set(["flu_dashboard", "programs", "scp_pipeline", "mail_signals", "video_review"]);
const SNAPSHOT_COLLECTION = "operational_snapshots";
const AUDIT_COLLECTION = "operational_snapshot_audits";
const IDEMPOTENCY_COLLECTION = "operational_snapshot_idempotency";
const SOURCE_PAGE_SIZE = 500;
const SOURCE_ROW_CAP = 50_000;
const MANAGER_PAGE_SIZE = 200;
const MANAGER_ROW_CAP = 5_000;
// 픽스처 판정에 쓰이는 필드는 전부 투영해야 한다 — 투영에서 빠지면 판정기가 볼 수 없어
// 시드 행이 KPI 에 그대로 섞인다(seedTag 누락으로 실제 그랬다).
const OPERATIONAL_FIXTURE_PROVENANCE_FIELDS = ["mock", "seedId", "seedTag", "source", "discoverySource"] as const;
// W86-A [SWR 전환 · 근거는 artifacts/W86A-WORKER-REPORT.md]
//   종전 정의: "스윕 주기(30분)의 2배 이상" — 스케줄이 **1차 갱신자**였으므로 실행 1회가 통째로
//   누락돼도 stale 라벨이 뜨지 않게 주기에 연동한 값이었다.
//
//   SWR 에서는 관계가 **뒤집힌다**. 1차 갱신자는 스케줄이 아니라 **사람의 접속**이고, 스케줄은
//   아무도 안 보는 surface 를 위한 저주기 안전망(6시간)일 뿐이다. 그래서 이 값을 주기에 연동하면
//   (2×360분=12시간) 아무 의미가 없다 — 갱신을 유발해야 할 신호가 반나절 동안 뜨지 않는다.
//
//   재정의: **접속 시 갱신을 유발하는 신선도 예산(UX 기준)**. 이 시간이 지난 문서를 관측한 화면은
//   ensureOperationalSnapshotFresh 를 쏘고, 사용자는 기다리지 않고 **현재 문서를 즉시** 본다.
//   값은 30분 — 종전 스케줄 주기와 같다. 즉 **보는 사람이 얻는 신선도는 종전과 동일**하고,
//   달라지는 것은 아무도 안 볼 때 48회/일을 태우지 않는다는 점뿐이다.
//   불변식은 `STALE_MS < 스케줄 주기`로 뒤집혀 pin 에 박혀 있다
//   (tests/operational-snapshot-callable.test.mjs "W86-A").
const STALE_MS = 30 * 60 * 1000;
const PII_KEY_ALLOWLIST = new Set(["canonicalProgramId", "programSummaries", "programs", "activePrograms"]);
const PII_KEY_TOKENS = ["email", "name", "phone", "message", "body", "html", "comment", "raw", "recipient", "address"];

const SCOPE_KEY_BY_COLLECTION: Record<string, string> = {
  program_applications: "programApplications",
  program_sheet_leads: "programSheetLeads",
  creator_links: "creatorLinks",
  submission_tasks: "submissionTasks",
  scp_mail_results: "scpMailResults",
  scp_lifecycle_profiles: "scpLifecycleProfiles",
  scp_identity_aliases: "scpIdentityAliases",
  gem_grants: "gemGrants",
};

export type OperationalSnapshotSurface = "flu_dashboard" | "programs" | "scp_pipeline" | "mail_signals" | "video_review";
export type OperationalSnapshotScope = "global" | `manager:${string}`;

export function operationalSnapshotAliasBindingRequiresRebuild(
  storedAliasRegistryRevision: unknown,
  currentAliasRegistryRevision: string,
  producerAggregateVersion: unknown,
): boolean {
  return asString(storedAliasRegistryRevision) !== currentAliasRegistryRevision
    || asString(producerAggregateVersion) !== AGGREGATE_VERSION;
}

type SourceRow = Record<string, unknown> & { id: string; ref: string };
type ProgramCounts = {
  applications: number;
  sheetLeads: number;
  qualified: number;
  rejected: number;
  coldmailSent: number;
  replies: number;
  videosSubmitted: number;
  videosApproved: number;
  paid: number;
  // Person-unit union of reply ∪ apply signals (includes the portal apply canonical source).
  // `replies` above is kept untouched for observation continuity + old-snapshot fallback.
  respondedOrApplied: number;
  // W26-FIX-1: apply-only (no reply component) union of program_applications ∪ program_sheet_leads
  // ∪ scp_application_management, person-deduped. `applications`/`sheetLeads` stay untouched.
  appliedWithPortal: number;
};

type SourceCompleteness = {
  state: "complete" | "truncated";
  truncatedSources: string[];
  sourceLimit: number | null;
};

type AggregateSourceRead = {
  rows: Record<string, SourceRow[]>;
  completeness: SourceCompleteness;
};

type ProgramSummaryDraft = {
  canonicalProgramId: string;
  title: string;
  slug: string;
  status: string;
  aliases: Set<string>;
  legacyProgramIds: Set<string>;
  visible: boolean;
  counts: ProgramCounts;
  lastActivityAtIso: string;
  metadataRank: number;
};

type EmptyOperationalSnapshot = ReturnType<typeof emptySnapshot>;
type OperationalSnapshotPartialReason = "identity_conflict" | "alias_registry_fence_changed" | "source_truncated";
type OperationalSnapshotConflictSummary = {
  conflictType: string;
  canonicalProgramId: string;
  hashedStrongAlias: string;
  sourceCount: number;
  sourceRefHashes: string[];
};

export type OperationalSnapshotV1 = Omit<EmptyOperationalSnapshot, "producerAggregateVersion" | "build"> & {
  producerAggregateVersion: string;
  build: Omit<EmptyOperationalSnapshot["build"], "aggregateVersion"> & { aggregateVersion: string };
};

export async function getOperationalSnapshot(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, ACTION_GET, ["super_admin", "admin", "manager", "viewer"]);
  const data = asRecord(request.data);
  const surface = parseSurface(data.surface);
  const scope = deriveSharedReadScope(auth, data.scope);
  const nowIso = new Date().toISOString();
  if (!canReadGlobalOperationalSnapshot(auth, data)) {
    const snapshot = emptySnapshot(scope, surface, nowIso);
    const responseSnapshot = acceptsSnapshotV2(data)
      ? publicSnapshotForResponse(snapshot)
      : legacySnapshotForResponse(snapshot);
    return {
      ok: true,
      found: false,
      storedFound: false,
      requiresRebuild: false,
      unavailable: true,
      unavailableReason: "account_scoped_global_snapshot_unavailable",
      scope,
      surface,
      snapshot: responseSnapshot,
      cache: makeCache(`operational_snapshot:${scope}:${surface}:unavailable`, false, 0),
      behaviorLog: makeBehaviorLog(auth, ACTION_GET, "success", scope),
    };
  }
  const ref = snapshotDoc(scope, surface);
  const [doc, aliasRegistry] = await Promise.all([
    ref.get(),
    readConfirmedProgramAliasRegistryState({ bypassCache: true }),
  ]);
  const storedDocumentExists = doc.exists;
  const storedFound = storedDocumentExists && isRecognizedStoredOperationalSnapshot(doc.data(), scope, surface);
  const snapshot = storedFound
    ? sanitizeSnapshot(doc.data(), scope, surface, nowIso, aliasRegistry.aliasMap, aliasRegistry.revision)
    : emptySnapshot(scope, surface, nowIso, aliasRegistry.revision);
  // `found` means a validated materialized document exists. Freshness/completeness is a separate
  // contract: partial or stale snapshots remain useful, explicitly labelled aggregate evidence
  // and must not be collapsed into the same state as a physically missing document.
  const found = storedFound;
  const requiresRebuild = !storedFound || snapshot.requiresRebuild;
  const responseSnapshot = acceptsSnapshotV2(data)
    ? publicSnapshotForResponse(snapshot)
    : legacySnapshotForResponse(snapshot);
  return {
    ok: true,
    found,
    storedFound,
    requiresRebuild,
    scope,
    surface,
    snapshot: responseSnapshot,
    cache: makeCache(`operational_snapshot:${scope}:${surface}`, storedFound, 60),
    behaviorLog: makeBehaviorLog(auth, ACTION_GET, "success", scope),
  };
}

export async function rebuildOperationalSnapshot(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, ACTION_REBUILD, RBAC_ROLES);
  const data = asRecord(request.data);
  const surface = parseSurface(data.surface);
  if (!canReadGlobalOperationalSnapshot(auth, data)) {
    const error = new Error("permission-denied: operational snapshot rebuild requires unscoped super_admin");
    Object.assign(error, {
      code: "permission-denied",
      errorCode: "rebuild_operational_snapshot_requires_unscoped_super_admin",
      behaviorLog: makeBehaviorLog(auth, ACTION_REBUILD, "denied", "global"),
    });
    throw error;
  }
  const scope = deriveRequestedScope(auth, data.scope);
  const dryRun = data.dryRun !== false;
  const actual = data.actual === true;
  const writeRequested = !dryRun && actual;
  if (!dryRun && !actual) {
    const error = new Error("failed-precondition: actual snapshot write requires dryRun:false and actual:true");
    Object.assign(error, { code: "failed-precondition", errorCode: "rebuild_operational_snapshot_actual_snapshot_write_requires_dry", behaviorLog: makeBehaviorLog(auth, ACTION_REBUILD, "denied", scope) });
    throw error;
  }

  const snapshot = await buildOperationalSnapshot(auth, scope, surface);
  const idempotencyKey = snapshotIdempotencyKey(snapshot);
  const auditCreatedAt = new Date();
  const auditBase = {
    action: ACTION_REBUILD,
    scope,
    surface,
    uid: auth.userId,
    role: auth.role,
    dryRun,
    actual,
    idempotencyKey,
    snapshotPath: snapshotDoc(scope, surface).path,
    sourceRowCounts: snapshot.sourceRowCounts,
    sourceWatermarks: snapshot.sourceWatermarks,
    aggregateVersion: AGGREGATE_VERSION,
    createdAtIso: auditCreatedAt.toISOString(),
    createdAt: Timestamp.fromDate(auditCreatedAt),
    expireAt: expireAt180DaysFromDate(auditCreatedAt),
  };

  if (!writeRequested) {
    await adminDb.collection(AUDIT_COLLECTION).doc().set({ ...auditBase, result: "dry_run" });
    return {
      ok: true,
      dryRun: true,
      actual: false,
      written: false,
      idempotencyKey,
      snapshot: publicSnapshotForResponse(snapshot),
      audit: { emitted: true, collection: AUDIT_COLLECTION, result: "dry_run" },
      behaviorLog: makeBehaviorLog(auth, ACTION_REBUILD, "success", scope),
    };
  }

  const idemRef = adminDb.collection(IDEMPOTENCY_COLLECTION).doc(idempotencyKey);
  const snapRef = snapshotDoc(scope, surface);
  const auditRef = adminDb.collection(AUDIT_COLLECTION).doc();
  let noOp = false;
  await adminDb.runTransaction(async (tx) => {
    const existing = await tx.get(idemRef);
    if (existing.exists) {
      noOp = true;
      tx.set(auditRef, { ...auditBase, result: "idempotent_noop", existingSnapshotPath: asString(existing.data()?.snapshotPath, snapRef.path) });
      return;
    }
    tx.set(snapRef, snapshot);
    tx.set(idemRef, {
      idempotencyKey,
      scope,
      surface,
      snapshotPath: snapRef.path,
      aggregateVersion: AGGREGATE_VERSION,
      createdBy: auth.userId,
      createdByRole: auth.role,
      createdAtIso: auditBase.createdAtIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(auditRef, { ...auditBase, result: "written" });
  });

  return {
    ok: true,
    dryRun: false,
    actual: true,
    written: !noOp,
    idempotent: noOp,
    idempotencyKey,
    snapshot: publicSnapshotForResponse(snapshot),
    paths: { snapshot: snapRef.path, idempotency: idemRef.path, audit: auditRef.path },
    behaviorLog: makeBehaviorLog(auth, ACTION_REBUILD, "success", scope),
  };
}

// ── 스케줄 자동 갱신(system lane) ─────────────────────────────────────────────
// /flu·/flu/programs 첫 화면은 materialized global 스냅샷 문서만 읽는다. 이 문서를
// 만드는 경로가 수동 rebuild 콜러블뿐이면 운영에서는 영구 found=false(숫자 없음)로
// 남는다 — 2026-07-10 운영 read-only 진단에서 두 surface 문서 모두 부재 확인.
// 이 sweep이 소스를 1회 읽어 소비 중인 surface 문서를 항상 신선하게 유지한다.
// 콘텐츠가 동일하면 idempotency/audit 문서는 만들지 않되, materialized 문서 자체는
// 매 실행 갱신해 staleAfterIso가 계속 미래를 가리키게 한다(“스냅샷 오래됨” 방지).
export const SNAPSHOT_REFRESH_SURFACES = ["flu_dashboard", "programs"] as const;

const SYSTEM_SNAPSHOT_AUTH: AuthContext = {
  userId: "system-operational-snapshot-scheduler",
  role: "admin",
  team: "system",
  ip: "system",
  gameId: "global",
};

export async function refreshOperationalSnapshotsSweep(now = new Date()) {
  const sources = await readAggregateSources(SYSTEM_SNAPSHOT_AUTH);
  const managerRead = await readActiveManagerSnapshotAuthContexts();
  const targets: Array<{ auth: AuthContext; scope: OperationalSnapshotScope; sources: AggregateSourceRead }> = [
    { auth: SYSTEM_SNAPSHOT_AUTH, scope: "global", sources },
    ...managerRead.auths.map((auth) => ({
      auth,
      scope: managerSnapshotScopeForUser(auth.userId),
      sources: sourceReadForAuth(sources, auth),
    })),
  ];
  const surfaces: Array<{ scope: OperationalSnapshotScope; surface: OperationalSnapshotSurface; written: boolean; idempotencyKey: string }> = [];
  for (const target of targets) {
    for (const surface of SNAPSHOT_REFRESH_SURFACES) {
      surfaces.push(await writeScheduledSnapshot(target.auth, target.scope, surface, target.sources, now));
    }
  }
  return {
    ok: true,
    generatedAtIso: now.toISOString(),
    managers: { materialized: managerRead.auths.length, truncated: managerRead.truncated },
    surfaces,
  };
}

export function sourceReadForAuth(sourceRead: AggregateSourceRead, auth: AuthContext): AggregateSourceRead {
  return {
    rows: Object.fromEntries(Object.entries(sourceRead.rows).map(([collection, rows]) => [
      collection,
      rows.filter((row) => rowMatchesAccountScope(scopeKey(collection), row, auth)),
    ])),
    completeness: sourceRead.completeness,
  };
}

async function readActiveManagerSnapshotAuthContexts(): Promise<{ auths: AuthContext[]; truncated: boolean }> {
  const auths = new Map<string, AuthContext>();
  let cursor: QueryDocumentSnapshot | null = null;
  let scanned = 0;
  while (scanned < MANAGER_ROW_CAP) {
    const pageSize = Math.min(MANAGER_PAGE_SIZE, MANAGER_ROW_CAP - scanned);
    let query: Query = adminDb.collection("members")
      .where("role", "==", "manager")
      .select("uid", "email", "name", "team", "status")
      .orderBy(FieldPath.documentId())
      .limit(pageSize);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (snapshot.empty) return { auths: [...auths.values()], truncated: false };
    scanned += snapshot.size;
    for (const doc of snapshot.docs) {
      const data = doc.data() ?? {};
      const uid = asString(data.uid) || (!doc.id.startsWith("invite-") ? doc.id : "");
      const status = lower(data.status);
      if (!uid || (status && status !== "active")) continue;
      auths.set(uid, {
        userId: uid,
        role: "manager",
        team: asString(data.team, "unassigned"),
        ip: "system",
        gameId: "global",
        ...(asString(data.email) ? { email: asString(data.email) } : {}),
        ...(asString(data.name) ? { name: asString(data.name) } : {}),
      });
    }
    cursor = snapshot.docs.at(-1) ?? null;
    if (snapshot.size < pageSize || !cursor) return { auths: [...auths.values()], truncated: false };
  }
  return { auths: [...auths.values()], truncated: true };
}

async function writeScheduledSnapshot(
  auth: AuthContext,
  scope: OperationalSnapshotScope,
  surface: OperationalSnapshotSurface,
  sources: AggregateSourceRead,
  now: Date,
) {
  const snapshot = await buildOperationalSnapshot(auth, scope, surface, sources);
  const idempotencyKey = snapshotIdempotencyKey(snapshot);
  const snapRef = snapshotDoc(scope, surface);
  const idemRef = adminDb.collection(IDEMPOTENCY_COLLECTION).doc(idempotencyKey);
  let contentChanged = false;
  await adminDb.runTransaction(async (tx) => {
    const existing = await tx.get(idemRef);
    contentChanged = !existing.exists;
    tx.set(snapRef, snapshot);
    if (!existing.exists) {
      tx.set(idemRef, {
        idempotencyKey,
        scope,
        surface,
        snapshotPath: snapRef.path,
        aggregateVersion: AGGREGATE_VERSION,
        createdBy: SYSTEM_SNAPSHOT_AUTH.userId,
        createdByRole: SYSTEM_SNAPSHOT_AUTH.role,
        createdAtIso: now.toISOString(),
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.set(adminDb.collection(AUDIT_COLLECTION).doc(), {
        action: ACTION_REBUILD,
        scope,
        surface,
        uid: SYSTEM_SNAPSHOT_AUTH.userId,
        role: SYSTEM_SNAPSHOT_AUTH.role,
        dryRun: false,
        actual: true,
        idempotencyKey,
        snapshotPath: snapRef.path,
        sourceRowCounts: snapshot.sourceRowCounts,
        sourceWatermarks: snapshot.sourceWatermarks,
        aggregateVersion: AGGREGATE_VERSION,
        createdAtIso: now.toISOString(),
        createdAt: Timestamp.fromDate(now),
        expireAt: expireAt180DaysFromDate(now),
        result: "written",
      });
    }
  });
  return { scope, surface, written: contentChanged, idempotencyKey };
}

// ── W86-A: 접속 시 갱신(SWR) 트리거 ──────────────────────────────────────────
//
// 계약 4개(브리핑 §작업1-1)를 이 한 함수가 전부 진다:
//   (a) 읽기 응답 즉시     — 이 콜러블은 getOperationalSnapshot 과 **별개**다. 화면은 문서를 먼저
//                            그리고, 이 트리거는 await 하지 않고 쏜다(35초 재구축에 사용자를 붙잡지 않는다).
//   (b) single-flight      — 아래 리스. 동시 접속 N명이 재구축을 N번 유발하지 못한다.
//   (c) SEC-P0-004         — 콜러블 경유(클라 직접 쓰기 없음). RBAC 은 **읽기와 동일**해야 한다:
//                            viewer 가 못 쏘면 viewer 만 접속한 시간대에는 영원히 갱신되지 않는다.
//                            대신 표면을 최소화했다 — scope/dryRun/actual 같은 손잡이가 없고
//                            deriveSharedReadScope 가 강제하는 global 만 만진다(rebuild 콜러블은 그대로 보존).
//   (d) stale 게이트       — STALE_MS 안이면 아무것도 하지 않는다.
//
// 리스를 **기존 idempotency 컬렉션**에 두는 이유: 브리핑이 새 컬렉션/인덱스를 금지한다
// (매니페스트 핀). 문서 id 접두사가 달라 콘텐츠 해시 키와 섞이지 않고, 그 컬렉션을 스캔하는
// 코드는 없다(둘 다 `.doc(id).get()` 뿐).
const ACTION_ENSURE = "operational_snapshot.ensure_fresh";
// 리스 TTL = 재구축 실행 예산(5분). 트리거가 중간에 죽어도 이 시간 안에 자가 치유된다.
// **TTL ≤ STALE_MS** 여야 한다 — 죽은 리스가 신선도 예산보다 오래 갱신을 막으면 SWR 이 멈춘다.
// 이 부등식은 pin 이 지킨다(tests/operational-snapshot-callable.test.mjs "W86-A").
const ENSURE_LEASE_TTL_MS = 5 * 60 * 1000;

// 리스 키는 **scope 단위**다(surface 단위가 아니다). 아래 재구축이 소스 1회 읽기로 소비 surface를
//   전부 갱신하므로, surface 별로 리스를 나누면 같은 소스를 두 번 읽는 트리거가 동시에 돈다.
function ensureLeaseDocId(scope: OperationalSnapshotScope): string {
  return `ensure_lease__${createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 40)}`;
}

export async function ensureOperationalSnapshotFresh(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, ACTION_ENSURE, ["super_admin", "admin", "manager", "viewer"]);
  const data = asRecord(request.data);
  const surface = parseSurface(data.surface);
  const scope = deriveSharedReadScope(auth, data.scope);
  const now = new Date();
  const nowIso = now.toISOString();

  if (!canReadGlobalOperationalSnapshot(auth, data)) {
    return {
      ok: true,
      triggered: false,
      reason: "unavailable" as const,
      unavailable: true,
      unavailableReason: "account_scoped_global_snapshot_unavailable",
      scope,
      surface,
      behaviorLog: makeBehaviorLog(auth, ACTION_ENSURE, "success", scope),
    };
  }

  const ref = snapshotDoc(scope, surface);
  const [doc, aliasRegistry] = await Promise.all([
    ref.get(),
    readConfirmedProgramAliasRegistryState({ bypassCache: true }),
  ]);
  const storedFound = doc.exists && isRecognizedStoredOperationalSnapshot(doc.data(), scope, surface);
  // 판정은 읽기 경로와 **같은 함수**를 쓴다. 여기서 따로 계산하면 두 판정이 조용히 갈라져
  // "화면은 stale 이라는데 트리거는 fresh 라고 답하는" 상태가 만들어진다.
  const stale = !storedFound
    || sanitizeSnapshot(doc.data(), scope, surface, nowIso, aliasRegistry.aliasMap, aliasRegistry.revision).requiresRebuild;
  if (!stale) {
    return {
      ok: true,
      triggered: false,
      reason: "fresh" as const,
      scope,
      surface,
      behaviorLog: makeBehaviorLog(auth, ACTION_ENSURE, "success", scope),
    };
  }

  // 리스 획득은 **트랜잭션이 아니라 `create`** 다. 처음엔 runTransaction(read→write)으로 짰는데
  //   동시 접속 6명 테스트에서 **6명 전부 재구축**했다: 존재하지 않는 문서를 읽은 트랜잭션들이
  //   서로의 쓰기를 충돌로 보지 못했다. `create` 는 "이미 있으면 실패"를 저장소가 원자적으로
  //   보장하므로 N개 중 정확히 하나만 성공한다 — 충돌 감지에 기대지 않는다.
  //   (W86-B 아웃박스 입자에서 `set(merge)`→`create` 로 갔던 것과 같은 이유다.)
  const leaseRef = adminDb.collection(IDEMPOTENCY_COLLECTION).doc(ensureLeaseDocId(scope));
  const leasePayload = {
    kind: "ensure_lease",
    scope,
    leaseExpiresAtIso: new Date(now.getTime() + ENSURE_LEASE_TTL_MS).toISOString(),
    acquiredAtIso: nowIso,
    acquiredBy: auth.userId,
    updatedAt: FieldValue.serverTimestamp(),
  };
  let acquired = false;
  // 해제 precondition 용 — 내가 잡은(또는 이어받은) 리스의 쓰기 시각. 이 시각이 아니면 내 리스가
  // 아니다(TTL 초과로 남이 이어받음).
  let leaseWriteTime: FirebaseFirestore.Timestamp | undefined;
  try {
    leaseWriteTime = (await leaseRef.create(leasePayload)).writeTime;
    acquired = true;
  } catch {
    // 이미 누가 잡고 있다. 만료됐으면 이어받는다 — 트리거가 중간에 죽어도 TTL 후 자가 치유된다.
    // 이어받기도 `lastUpdateTime` precondition 이라 동시에 두 명이 이어받지 못한다.
    const held = await leaseRef.get();
    const heldUntilIso = asString(held.data()?.leaseExpiresAtIso);
    if (held.exists && (!heldUntilIso || heldUntilIso <= nowIso)) {
      try {
        leaseWriteTime = (await leaseRef.update(leasePayload, { lastUpdateTime: held.updateTime! })).writeTime;
        acquired = true;
      } catch {
        acquired = false;
      }
    }
  }
  if (!acquired) {
    return {
      ok: true,
      triggered: false,
      reason: "in_flight" as const,
      scope,
      surface,
      behaviorLog: makeBehaviorLog(auth, ACTION_ENSURE, "success", scope),
    };
  }

  try {
    // 이중검사(double-checked locking): 리스를 잡기까지 기다리는 사이 **앞선 트리거가 이미 끝났을
    //   수 있다.** 위쪽 stale 판정은 그 전에 한 것이라 그대로 믿으면 방금 만든 문서를 또 만든다.
    //   리스 안에서 한 번 더 본다 — 이게 없으면 "동시 6명"이 아니라 "연달아 6명"에서 6번 돈다.
    const recheck = await ref.get();
    const recheckIso = new Date().toISOString();
    const recheckFound = recheck.exists && isRecognizedStoredOperationalSnapshot(recheck.data(), scope, surface);
    const stillStale = !recheckFound
      || sanitizeSnapshot(recheck.data(), scope, surface, recheckIso, aliasRegistry.aliasMap, aliasRegistry.revision).requiresRebuild;
    if (!stillStale) {
      return {
        ok: true,
        triggered: false,
        reason: "fresh" as const,
        scope,
        surface,
        behaviorLog: makeBehaviorLog(auth, ACTION_ENSURE, "success", scope),
      };
    }
    // 재구축은 스케줄 스윕과 **같은 쓰기 경로**(writeScheduledSnapshot)를 탄다 — 감사/idempotency
    // 기록 형상이 갈라지지 않는다.
    //
    // ⚠️ **소스 1회 읽기로 소비 surface 를 전부 갱신한다**(요청 surface ∪ SNAPSHOT_REFRESH_SURFACES).
    //   처음엔 "요청된 surface 하나만" 만들었는데, 비용을 다시 계산해 보니 그게 더 나빴다:
    //   비싼 쪽은 문서 쓰기가 아니라 `readAggregateSources`(소스 전량 스캔)이고, surface 별로
    //   따로 트리거하면 같은 창(STALE_MS) 안에서 소스를 surface 수만큼 읽는다.
    //   두 surface 를 계속 보는 최악의 날이면 2×48 = 96회 — **종전 48회 스윕보다 나쁘다.**
    //   묶어서 갱신하면 창당 소스 읽기가 1회로 고정돼 최악이 종전과 같아지고(48), 평시에는
    //   접속한 창에서만 발생해 훨씬 낮다. 뒤이어 다른 surface 를 열어도 이미 fresh 라 no-op 이다.
    const sources = await readAggregateSources(SYSTEM_SNAPSHOT_AUTH);
    const targets = [...new Set<OperationalSnapshotSurface>([surface, ...SNAPSHOT_REFRESH_SURFACES])];
    const results = [];
    for (const target of targets) {
      results.push(await writeScheduledSnapshot(SYSTEM_SNAPSHOT_AUTH, scope, target, sources, now));
    }
    return {
      ok: true,
      triggered: true,
      reason: "rebuilt" as const,
      written: results.some((entry) => entry.written),
      refreshedSurfaces: targets.length,
      scope,
      surface,
      behaviorLog: makeBehaviorLog(auth, ACTION_ENSURE, "success", scope),
    };
  } finally {
    // 성공/실패 어느 쪽이든 즉시 놓는다. 실패했는데 TTL 끝까지 잡고 있으면 그동안 아무도 재시도를
    // 못 하고, 그게 곧 "실패 1회를 흡수하지 못하는" 상태다(W85 원칙 계승).
    // 단 **내 리스일 때만**(lastUpdateTime precondition) — 재구축이 TTL(5분)을 넘겨 남이 정당하게
    // 이어받았으면 그건 이제 남의 활성 리스다. 무조건 지우면 이어받은 쪽이 아직 도는 중에 세 번째
    // 트리거가 또 들어와, 이 기능이 막으려던 동시 재구축이 부하 상황에서 정확히 재현된다.
    await leaseRef.delete({ lastUpdateTime: leaseWriteTime }).catch(() => undefined);
  }
}

export function deriveRequestedScope(auth: Pick<AuthContext, "role" | "userId">, requestedScope: unknown): OperationalSnapshotScope {
  if (auth.role === "manager") {
    const managerScope = managerSnapshotScopeForUser(auth.userId);
    if (requestedScope === undefined || requestedScope === "" || requestedScope === managerScope) return managerScope;
    const error = new Error("permission-denied: managers may only access their own manager scope");
    Object.assign(error, { code: "permission-denied", errorCode: "derive_requested_scope_managers_may_only_access_their" });
    throw error;
  }
  const scope = asString(requestedScope, "global");
  if (scope !== "global") {
    const error = new Error("permission-denied: admin scoped snapshot access must explicitly use global in G003");
    Object.assign(error, { code: "permission-denied", errorCode: "derive_requested_scope_admin_scoped_snapshot_access_must" });
    throw error;
  }
  return "global";
}

export function deriveSharedReadScope(
  _auth: Pick<AuthContext, "role" | "userId">,
  requestedScope: unknown,
): OperationalSnapshotScope {
  const scope = asString(requestedScope, "global");
  if (scope !== "global") {
    const error = new Error("permission-denied: shared snapshot reads use the global scope");
    Object.assign(error, { code: "permission-denied", errorCode: "derive_shared_read_scope_shared_snapshot_reads_use_global" });
    throw error;
  }
  return "global";
}

export function managerSnapshotScopeForUser(userId: string): OperationalSnapshotScope {
  if (!userId) throw new Error("invalid-argument: manager snapshot scope requires a user id");
  const digest = createHash("sha256").update(userId, "utf8").digest("hex");
  return `manager:v2_${digest}`;
}

export function snapshotIdempotencyKey(snapshot: OperationalSnapshotV1): string {
  return hashJson(snapshotIdempotencyPayload(snapshot));
}

function snapshotIdempotencyPayload(snapshot: OperationalSnapshotV1) {
  return {
    scope: snapshot.scope,
    surface: snapshot.surface,
    schemaVersion: snapshot.schemaVersion,
    piiFree: snapshot.piiFree,
    aliasRegistryRevision: snapshot.aliasRegistryRevision,
    producerAggregateVersion: snapshot.producerAggregateVersion,
    sourceCollections: snapshot.sourceCollections,
    sourceRowCounts: snapshot.sourceRowCounts,
    sourceWatermarks: snapshot.sourceWatermarks,
    completeness: snapshot.completeness,
    partialReasons: snapshot.partialReasons,
    conflictSummaries: snapshot.conflictSummaries,
    totals: snapshot.totals,
    programSummaries: snapshot.programSummaries,
    scpFunnel: snapshot.scpFunnel,
    mailSignals: snapshot.mailSignals,
    videoAiHumanMatrix: snapshot.videoAiHumanMatrix,
    build: { aggregateVersion: snapshot.build.aggregateVersion },
  };
}

export async function buildOperationalSnapshot(
  auth: AuthContext,
  scope: OperationalSnapshotScope,
  surface: OperationalSnapshotSurface,
  preloadedSources?: Record<string, SourceRow[]> | AggregateSourceRead,
) {
  const now = new Date();
  const generatedAtIso = now.toISOString();
  const staleAfterIso = new Date(now.getTime() + STALE_MS).toISOString();
  const aliasRegistryBefore = preloadedSources
    ? null
    : await readConfirmedProgramAliasRegistryState({ bypassCache: true });
  const unfilteredSourceRead = preloadedSources
    ? isAggregateSourceRead(preloadedSources)
      ? preloadedSources
      : { rows: preloadedSources, completeness: completeSourceRead() }
    : await readAggregateSources(auth);
  const aliasRegistryAfter = preloadedSources
    ? null
    : await readConfirmedProgramAliasRegistryState({ bypassCache: true });
  const sourceRead = withoutOperationalFixtureRows(unfilteredSourceRead);
  const sources = sourceRead.rows;
  const snapshot = emptySnapshot(scope, surface, generatedAtIso);
  snapshot.snapshotVersion = Number(now.getTime());
  snapshot.status = sourceRead.completeness.state === "complete" ? "fresh" : "partial";
  snapshot.completeness = sourceRead.completeness;
  snapshot.staleAfterIso = staleAfterIso;
  snapshot.sourceCollections = Object.keys(sources).filter((key) => sources[key].length > 0).sort();
  for (const [key, rows] of Object.entries(sources)) {
    snapshot.sourceRowCounts[key] = rows.length;
    snapshot.sourceWatermarks[key] = rows.length > 0 ? (maxIso(rows) || "unknown") : "empty";
  }
  snapshot.lastSourceEventAtIso = maxIso(Object.values(sources).flat()) || generatedAtIso;

  const identity = buildOperationalIdentityContext(sources);
  snapshot.aliasRegistryRevision = confirmedProgramAliasRegistryRevision(identity.aliasMap);
  snapshot.producerAggregateVersion = AGGREGATE_VERSION;
  const registryFenceChanged = Boolean(
    aliasRegistryBefore
    && aliasRegistryAfter
    && (
      aliasRegistryBefore.revision !== aliasRegistryAfter.revision
      || aliasRegistryAfter.revision !== snapshot.aliasRegistryRevision
    )
  );
  const partialReasons = new Set<OperationalSnapshotPartialReason>();
  if (sourceRead.completeness.state === "truncated") partialReasons.add("source_truncated");
  if (identity.conflictCount > 0) partialReasons.add("identity_conflict");
  if (registryFenceChanged) partialReasons.add("alias_registry_fence_changed");
  if (partialReasons.size > 0) snapshot.status = "partial";
  snapshot.partialReasons = [...partialReasons].sort();
  snapshot.conflictSummaries = identity.conflictSummaries;
  const programs = buildProgramDrafts(sources.programs, identity.aliasMap);
  aggregateProgramCounts(programs, sources, identity);
  snapshot.programSummaries = Array.from(programs.values())
    .map((draft) => ({
      canonicalProgramId: draft.canonicalProgramId,
      title: safeTitle(draft.title, draft.canonicalProgramId),
      slug: safeSlug(draft.slug, draft.canonicalProgramId),
      status: safeStatus(draft.status),
      aliases: Array.from(draft.aliases).sort(),
      legacyProgramIds: Array.from(draft.legacyProgramIds).sort(),
      visible: draft.visible,
      counts: { ...draft.counts },
      lastActivityAtIso: draft.lastActivityAtIso || new Date(0).toISOString(),
    }))
    .sort((a, b) => b.counts.sheetLeads + b.counts.coldmailSent + b.counts.videosSubmitted - (a.counts.sheetLeads + a.counts.coldmailSent + a.counts.videosSubmitted));

  snapshot.totals.programs = snapshot.programSummaries.length;
  snapshot.totals.activePrograms = snapshot.programSummaries.filter((item) => item.visible && !["closed", "archived", "deleted", "inactive"].includes(item.status.toLowerCase())).length;
  const totals = canonicalStageMetrics(sources, identity);
  const scpTotals = canonicalStageMetrics(sources, identity, canonicalScpProgramId);
  snapshot.totals.scpLeads = scpTotals.lead;
  snapshot.totals.qualified = totals.qualified;
  snapshot.totals.rejected = totals.rejected;
  snapshot.totals.coldmailSent = totals.coldmailSent;
  snapshot.totals.replies = totals.replied;
  snapshot.totals.clicks = distinctCount(
    sources.mail_outbound_log.filter(hasClickSignal),
    (row) => asString(row.trackingId) || asString(row.messageId) || row.id,
  );
  snapshot.totals.videosSubmitted = totals.videoSubmitted;
  snapshot.totals.videosApproved = totals.approved;
  snapshot.totals.paid = totals.paid;
  snapshot.totals.creators = distinctCreatorCount(sources, identity);
  // W48-3: portal applications whose only program signal is the unresolved "view-cpm" tag (see
  // normalizeProgramId above) land in no program summary. Surface the drop as a single global
  // document count instead of letting it disappear silently.
  snapshot.totals.portalApplicationsUnattributedGlobal = sources.scp_application_management.filter((row) => {
    const projected = identityProjectionRow(row, "scp_application_management");
    return projected.programId === LEGACY_SHEET_PORTAL_PROGRAM_ID && !resolveProgramId(projected, "scp_application_management", identity);
  }).length;
  snapshot.scpFunnel = {
    lead: scpTotals.lead,
    qualified: scpTotals.qualified,
    rejected: scpTotals.rejected,
    contacted: scpTotals.contacted,
    replied: scpTotals.replied,
    videoSubmitted: scpTotals.videoSubmitted,
    approved: scpTotals.approved,
    paid: scpTotals.paid,
  };
  snapshot.mailSignals = {
    sent: snapshot.totals.coldmailSent,
    pixelSignals: distinctCount(
      sources.mail_outbound_log.filter(hasOpenSignal),
      (row) => asString(row.trackingId) || asString(row.messageId) || row.id,
    ),
    replies: snapshot.totals.replies,
    clicks: snapshot.totals.clicks,
  };
  snapshot.videoAiHumanMatrix = buildVideoMatrix(sources.review_ledger);
  snapshot.requiresRebuild = snapshot.status !== "fresh";
  snapshot.contentHash = hashJson(snapshotIdempotencyPayload(snapshot));
  assertPiiSafeSnapshot(snapshot);
  return snapshot;
}

function isAggregateSourceRead(value: Record<string, SourceRow[]> | AggregateSourceRead): value is AggregateSourceRead {
  return "rows" in value && "completeness" in value;
}

function acceptsSnapshotV2(data: Record<string, unknown>): boolean {
  return stringArray(data.acceptedSchemaVersions).includes(SNAPSHOT_SCHEMA_VERSION);
}

export function legacySnapshotForResponse(snapshot: OperationalSnapshotV1) {
  const {
    completeness: _completeness,
    partialReasons: _partialReasons,
    conflictSummaries: _conflictSummaries,
    ...legacySnapshot
  } = publicSnapshotForResponse(snapshot);
  return {
    ...legacySnapshot,
    schemaVersion: LEGACY_SNAPSHOT_SCHEMA_VERSION,
    programSummaries: snapshot.programSummaries.map((summary) => {
      // Old clients requesting the legacy wire never declared acceptance of this field either —
      // keep their contract exactly as frozen (same treatment as qualified/rejected above).
      const { qualified: _qualified, rejected: _rejected, respondedOrApplied: _respondedOrApplied, appliedWithPortal: _appliedWithPortal, ...counts } = summary.counts;
      return { ...summary, counts };
    }),
  };
}

export function publicSnapshotForResponse(snapshot: OperationalSnapshotV1) {
  // These fields fence persisted aggregate revisions and idempotency. They are intentionally not
  // part of the browser's exact, PII-free wire schema; freshness is exposed by the envelope and
  // the public status/completeness fields instead. Keep this as a positive allowlist so a future
  // persistence field cannot silently leak into an exact client schema.
  return {
    schemaVersion: snapshot.schemaVersion,
    snapshotVersion: snapshot.snapshotVersion,
    scope: snapshot.scope,
    surface: snapshot.surface,
    generatedAtIso: snapshot.generatedAtIso,
    lastSourceEventAtIso: snapshot.lastSourceEventAtIso,
    staleAfterIso: snapshot.staleAfterIso,
    status: snapshot.status,
    piiFree: snapshot.piiFree,
    sourceCollections: snapshot.sourceCollections,
    sourceRowCounts: snapshot.sourceRowCounts,
    sourceWatermarks: snapshot.sourceWatermarks,
    completeness: {
      state: snapshot.completeness.state,
      truncatedSources: snapshot.completeness.truncatedSources,
      sourceLimit: snapshot.completeness.sourceLimit,
    },
    partialReasons: snapshot.partialReasons,
    conflictSummaries: snapshot.conflictSummaries,
    totals: {
      programs: snapshot.totals.programs,
      activePrograms: snapshot.totals.activePrograms,
      creators: snapshot.totals.creators,
      scpLeads: snapshot.totals.scpLeads,
      qualified: snapshot.totals.qualified,
      rejected: snapshot.totals.rejected,
      coldmailSent: snapshot.totals.coldmailSent,
      replies: snapshot.totals.replies,
      clicks: snapshot.totals.clicks,
      videosSubmitted: snapshot.totals.videosSubmitted,
      videosApproved: snapshot.totals.videosApproved,
      paid: snapshot.totals.paid,
    },
    programSummaries: snapshot.programSummaries.map((summary) => ({
      canonicalProgramId: summary.canonicalProgramId,
      title: summary.title,
      slug: summary.slug,
      status: summary.status,
      aliases: summary.aliases,
      legacyProgramIds: summary.legacyProgramIds,
      visible: summary.visible,
      counts: {
        applications: summary.counts.applications,
        sheetLeads: summary.counts.sheetLeads,
        qualified: summary.counts.qualified,
        rejected: summary.counts.rejected,
        coldmailSent: summary.counts.coldmailSent,
        replies: summary.counts.replies,
        videosSubmitted: summary.counts.videosSubmitted,
        videosApproved: summary.counts.videosApproved,
        paid: summary.counts.paid,
        respondedOrApplied: summary.counts.respondedOrApplied,
        appliedWithPortal: summary.counts.appliedWithPortal,
      },
      lastActivityAtIso: summary.lastActivityAtIso,
    })),
    scpFunnel: {
      lead: snapshot.scpFunnel.lead,
      qualified: snapshot.scpFunnel.qualified,
      rejected: snapshot.scpFunnel.rejected,
      contacted: snapshot.scpFunnel.contacted,
      replied: snapshot.scpFunnel.replied,
      videoSubmitted: snapshot.scpFunnel.videoSubmitted,
      approved: snapshot.scpFunnel.approved,
      paid: snapshot.scpFunnel.paid,
    },
    mailSignals: {
      sent: snapshot.mailSignals.sent,
      pixelSignals: snapshot.mailSignals.pixelSignals,
      replies: snapshot.mailSignals.replies,
      clicks: snapshot.mailSignals.clicks,
    },
    videoAiHumanMatrix: {
      aiApproveHumanApprove: snapshot.videoAiHumanMatrix.aiApproveHumanApprove,
      aiApproveHumanReject: snapshot.videoAiHumanMatrix.aiApproveHumanReject,
      aiHoldRejectHumanApprove: snapshot.videoAiHumanMatrix.aiHoldRejectHumanApprove,
      aiHoldRejectHumanReject: snapshot.videoAiHumanMatrix.aiHoldRejectHumanReject,
      unknown: snapshot.videoAiHumanMatrix.unknown,
    },
    build: {
      appVersion: snapshot.build.appVersion,
      aggregateVersion: snapshot.build.aggregateVersion,
    },
  };
}

export function isRecognizedStoredOperationalSnapshot(
  data: unknown,
  expectedScope?: OperationalSnapshotScope,
  expectedSurface?: OperationalSnapshotSurface,
): boolean {
  const record = asRecord(data);
  const schemaVersion = asString(record.schemaVersion);
  const isV2 = schemaVersion === SNAPSHOT_SCHEMA_VERSION;
  const scope = asString(record.scope);
  const surface = asString(record.surface);
  const validScope = scope === "global" || /^manager:[A-Za-z0-9_-]{1,160}$/.test(scope);
  const validSurface = SURFACES.has(surface);
  if (
    record.piiFree !== true
    || (!isV2 && schemaVersion !== LEGACY_SNAPSHOT_SCHEMA_VERSION)
    || !validScope
    || !validSurface
    || (expectedScope !== undefined && scope !== expectedScope)
    || (expectedSurface !== undefined && surface !== expectedSurface)
    || !Number.isInteger(record.snapshotVersion)
    || (record.snapshotVersion as number) < 0
    || !isIsoValue(record.generatedAtIso)
    || !isIsoValue(record.lastSourceEventAtIso)
    || !isIsoValue(record.staleAfterIso)
    || !["fresh", "stale", "rebuilding", "partial"].includes(asString(record.status))
    || !isStringArrayValue(record.sourceCollections)
    || !isNumberRecordValue(record.sourceRowCounts)
    || !isStringRecordValue(record.sourceWatermarks)
    || (isV2 && !isCompletenessValue(record.completeness))
    || !hasRequiredNumberFields(record.totals, ["programs", "activePrograms", "creators", "scpLeads", "qualified", "rejected", "coldmailSent", "replies", "clicks", "videosSubmitted", "videosApproved", "paid"])
    || !hasRequiredNumberFields(record.scpFunnel, ["lead", "qualified", "rejected", "contacted", "replied", "videoSubmitted", "approved", "paid"])
    || !hasRequiredNumberFields(record.mailSignals, ["sent", "pixelSignals", "replies", "clicks"])
    || !hasRequiredNumberFields(record.videoAiHumanMatrix, ["aiApproveHumanApprove", "aiApproveHumanReject", "aiHoldRejectHumanApprove", "aiHoldRejectHumanReject", "unknown"])
    || !isStringRecordWithFields(record.build, ["appVersion", "aggregateVersion"])
    || !Array.isArray(record.programSummaries)
  ) return false;
  const countFields = isV2
    ? ["applications", "sheetLeads", "qualified", "rejected", "coldmailSent", "replies", "videosSubmitted", "videosApproved", "paid"]
    : ["applications", "sheetLeads", "coldmailSent", "replies", "videosSubmitted", "videosApproved", "paid"];
  return record.programSummaries.every((value) => {
    const summary = asRecord(value);
    return ["canonicalProgramId", "title", "slug", "status"].every((field) => typeof summary[field] === "string")
      && typeof summary.visible === "boolean"
      && isStringArrayValue(summary.aliases)
      && isStringArrayValue(summary.legacyProgramIds)
      && isIsoValue(summary.lastActivityAtIso)
      && hasRequiredNumberFields(summary.counts, countFields);
  });
}

function isIsoValue(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isStringArrayValue(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNumberRecordValue(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((item) =>
    typeof item === "number" && Number.isFinite(item) && item >= 0);
}

function isStringRecordValue(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");
}

function hasRequiredNumberFields(value: unknown, fields: readonly string[]): boolean {
  const record = asRecord(value);
  return fields.every((field) =>
    typeof record[field] === "number" && Number.isFinite(record[field]) && (record[field] as number) >= 0);
}

function isStringRecordWithFields(value: unknown, fields: readonly string[]): boolean {
  const record = asRecord(value);
  return fields.every((field) => typeof record[field] === "string");
}

function isCompletenessValue(value: unknown): boolean {
  const record = asRecord(value);
  if (!isStringArrayValue(record.truncatedSources)) return false;
  if (record.state === "complete") {
    return record.truncatedSources.length === 0 && record.sourceLimit === null;
  }
  return record.state === "truncated"
    && record.truncatedSources.length > 0
    && Number.isInteger(record.sourceLimit)
    && (record.sourceLimit as number) > 0;
}

function parseSurface(value: unknown): OperationalSnapshotSurface {
  const surface = asString(value, DEFAULT_SURFACE);
  if (SURFACES.has(surface)) return surface as OperationalSnapshotSurface;
  const error = new Error("invalid-argument: unsupported operational snapshot surface");
  Object.assign(error, { code: "invalid-argument", errorCode: "parse_surface_unsupported_operational_snapshot_surface" });
  throw error;
}

function canReadGlobalOperationalSnapshot(auth: Pick<AuthContext, "role">, data: Record<string, unknown>): boolean {
  if (auth.role !== "super_admin") return false;
  return !asString(data.viewAsUserId) && !asString(data.viewAsEmail);
}

function snapshotDoc(scope: OperationalSnapshotScope, surface: OperationalSnapshotSurface) {
  return adminDb.collection(SNAPSHOT_COLLECTION).doc(scope).collection("surfaces").doc(surface);
}

function emptySnapshot(
  scope: OperationalSnapshotScope,
  surface: OperationalSnapshotSurface,
  generatedAtIso = new Date().toISOString(),
  aliasRegistryRevision = confirmedProgramAliasRegistryRevision({}),
) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotVersion: 0,
    scope,
    surface,
    generatedAtIso,
    lastSourceEventAtIso: generatedAtIso,
    staleAfterIso: generatedAtIso,
    status: "stale" as "fresh" | "stale" | "rebuilding" | "partial",
    requiresRebuild: true,
    aliasRegistryRevision,
    producerAggregateVersion: AGGREGATE_VERSION,
    contentHash: "",
    piiFree: true as const,
    sourceCollections: [] as string[],
    sourceRowCounts: {} as Record<string, number>,
    sourceWatermarks: {} as Record<string, string>,
    completeness: completeSourceRead(),
    partialReasons: [] as OperationalSnapshotPartialReason[],
    conflictSummaries: [] as OperationalSnapshotConflictSummary[],
    totals: { programs: 0, activePrograms: 0, creators: 0, scpLeads: 0, qualified: 0, rejected: 0, coldmailSent: 0, replies: 0, clicks: 0, videosSubmitted: 0, videosApproved: 0, paid: 0, portalApplicationsUnattributedGlobal: 0 },
    programSummaries: [] as Array<{ canonicalProgramId: string; title: string; slug: string; status: string; aliases: string[]; legacyProgramIds: string[]; visible: boolean; counts: ProgramCounts; lastActivityAtIso: string }>,
    scpFunnel: { lead: 0, qualified: 0, rejected: 0, contacted: 0, replied: 0, videoSubmitted: 0, approved: 0, paid: 0 },
    mailSignals: { sent: 0, pixelSignals: 0, replies: 0, clicks: 0 },
    videoAiHumanMatrix: { aiApproveHumanApprove: 0, aiApproveHumanReject: 0, aiHoldRejectHumanApprove: 0, aiHoldRejectHumanReject: 0, unknown: 0 },
    build: { appVersion: process.env.FLU_APP_VERSION || process.env.npm_package_version || "unknown", aggregateVersion: AGGREGATE_VERSION },
  };
}

function sanitizeSnapshot(
  data: unknown,
  scope: OperationalSnapshotScope,
  surface: OperationalSnapshotSurface,
  nowIso: string,
  aliasMap: Record<string, string> = confirmedProgramAliasMap([]),
  currentAliasRegistryRevision = confirmedProgramAliasRegistryRevision(aliasMap),
) {
  const record = asRecord(data);
  const schemaVersion = asString(record.schemaVersion);
  if ((schemaVersion !== SNAPSHOT_SCHEMA_VERSION && schemaVersion !== LEGACY_SNAPSHOT_SCHEMA_VERSION) || record.piiFree !== true) {
    return emptySnapshot(scope, surface, nowIso, currentAliasRegistryRevision);
  }
  assertPiiSafeSnapshot(record);
  const fallback = emptySnapshot(scope, surface, nowIso, currentAliasRegistryRevision);
  const sourceCollections = stringArray(record.sourceCollections);
  const completeness = sanitizeCompleteness(record.completeness, sourceCollections);
  const storedStatus = ["fresh", "stale", "rebuilding", "partial"].includes(asString(record.status)) ? asString(record.status) as "fresh" | "stale" | "rebuilding" | "partial" : fallback.status;
  const staleAfterIso = isoOrFallback(record.staleAfterIso, fallback.staleAfterIso);
  const expired = Date.parse(staleAfterIso) <= Date.parse(nowIso);
  const storedAliasRegistryRevision = asString(record.aliasRegistryRevision);
  const storedProducerAggregateVersion = asString(
    record.producerAggregateVersion,
    asString(asRecord(record.build).aggregateVersion),
  );
  const programSummaries = suppressStoredOperationalFixtureProgramSummaries(record.programSummaries, aliasMap);
  const containsNonCanonicalSummary = programSummaries.some((summary) =>
    resolveCanonicalProgramId(summary.canonicalProgramId, aliasMap) !== summary.canonicalProgramId);
  const requiresRebuild = operationalSnapshotAliasBindingRequiresRebuild(
    storedAliasRegistryRevision,
    currentAliasRegistryRevision,
    storedProducerAggregateVersion,
  ) || containsNonCanonicalSummary;
  const status = requiresRebuild
    ? "stale" as const
    : expired && storedStatus !== "rebuilding"
    ? "stale" as const
    : completeness.state === "truncated"
      ? "partial" as const
      : storedStatus;
  const totals = mergeKnownNumbers(fallback.totals, record.totals);
  // An already-materialized snapshot may predate fixture filtering. Recompute
  // the two program cardinalities from the filtered summaries so an exact QA
  // fixture disappears immediately instead of waiting for the next rebuild.
  totals.programs = programSummaries.length;
  totals.activePrograms = programSummaries.filter((item) =>
    item.visible
    && !["closed", "archived", "deleted", "inactive"].includes(item.status.toLowerCase()),
  ).length;
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotVersion: typeof record.snapshotVersion === "number" && Number.isFinite(record.snapshotVersion) ? Math.max(0, Math.trunc(record.snapshotVersion)) : fallback.snapshotVersion,
    scope,
    surface,
    generatedAtIso: isoOrFallback(record.generatedAtIso, fallback.generatedAtIso),
    lastSourceEventAtIso: isoOrFallback(record.lastSourceEventAtIso, fallback.lastSourceEventAtIso),
    staleAfterIso,
    status,
    requiresRebuild: requiresRebuild || status === "stale" || status === "partial",
    aliasRegistryRevision: storedAliasRegistryRevision,
    producerAggregateVersion: storedProducerAggregateVersion,
    contentHash: asString(record.contentHash),
    piiFree: true as const,
    sourceCollections,
    sourceRowCounts: numberRecord(record.sourceRowCounts),
    sourceWatermarks: stringRecord(record.sourceWatermarks),
    completeness,
    partialReasons: sanitizePartialReasons(record.partialReasons, status, completeness),
    conflictSummaries: sanitizeConflictSummaries(record.conflictSummaries),
    totals,
    programSummaries,
    scpFunnel: mergeKnownNumbers(fallback.scpFunnel, record.scpFunnel),
    mailSignals: mergeKnownNumbers(fallback.mailSignals, record.mailSignals),
    videoAiHumanMatrix: mergeKnownNumbers(fallback.videoAiHumanMatrix, record.videoAiHumanMatrix),
    build: {
      appVersion: asString(asRecord(record.build).appVersion, fallback.build.appVersion),
      // Preserve producer provenance. Old snapshots must remain visibly old and
      // stale until rebuilt; sanitization cannot upgrade their semantics.
      aggregateVersion: storedProducerAggregateVersion,
    },
  };
}

export function suppressStoredOperationalFixtureProgramSummaries(
  value: unknown,
  _aliasMap: Record<string, string> = confirmedProgramAliasMap([]),
) {
  const summaries = Array.isArray(value)
    ? value.map(sanitizeProgramSummary).filter(Boolean) as ReturnType<typeof emptySnapshot>["programSummaries"]
    : [];
  const productionSummaries = summaries.filter((summary) => !isOperationalFixtureRecord({
    ...summary,
    id: summary.canonicalProgramId,
  }, "programs"));
  // Read-time aggregate repair cannot know whether two rows are mirrored copies
  // or disjoint populations. Preserve the producer's rows verbatim (after schema
  // and fixture sanitation); revision/version checks above decide freshness.
  return productionSummaries.sort((left, right) =>
    Date.parse(right.lastActivityAtIso) - Date.parse(left.lastActivityAtIso));
}


function sanitizeProgramSummary(value: unknown) {
  const row = asRecord(value);
  if (!row.canonicalProgramId) return null;
  const counts = numberRecord(row.counts);
  return {
    canonicalProgramId: normalizeProgramId(row.canonicalProgramId) || "unknown",
    title: safeTitle(asString(row.title), asString(row.canonicalProgramId)),
    slug: safeSlug(asString(row.slug), asString(row.canonicalProgramId)),
    status: safeStatus(asString(row.status)),
    aliases: stringArray(row.aliases).map((alias) => normalizeProgramId(alias)).filter(Boolean) as string[],
    legacyProgramIds: stringArray(row.legacyProgramIds).sort(),
    visible: row.visible !== false,
    counts: {
      applications: counts.applications ?? 0,
      sheetLeads: counts.sheetLeads ?? 0,
      qualified: counts.qualified ?? 0,
      rejected: counts.rejected ?? 0,
      coldmailSent: counts.coldmailSent ?? 0,
      replies: counts.replies ?? 0,
      videosSubmitted: counts.videosSubmitted ?? 0,
      videosApproved: counts.videosApproved ?? 0,
      paid: counts.paid ?? 0,
      // Old stored snapshot docs predate this field entirely — fall back to replies-only so
      // the screen keeps showing its pre-existing number until the next scheduled rebuild.
      respondedOrApplied: counts.respondedOrApplied ?? counts.replies ?? 0,
      // W26-FIX-1: same treatment — fall back to the pre-existing max(applications, sheetLeads)
      // reading until the next scheduled rebuild recomputes the real portal-inclusive union.
      appliedWithPortal: counts.appliedWithPortal ?? Math.max(counts.applications ?? 0, counts.sheetLeads ?? 0),
    },
    lastActivityAtIso: isoOrFallback(row.lastActivityAtIso, new Date(0).toISOString()),
  };
}

function completeSourceRead(): SourceCompleteness {
  return { state: "complete", truncatedSources: [], sourceLimit: null };
}

function sanitizeCompleteness(value: unknown, legacySources: string[]): SourceCompleteness {
  const row = asRecord(value);
  const state = asString(row.state);
  if (state === "complete") return completeSourceRead();
  if (state === "truncated") {
    const sourceLimit = typeof row.sourceLimit === "number" && Number.isFinite(row.sourceLimit) && row.sourceLimit > 0
      ? Math.trunc(row.sourceLimit)
      : SOURCE_ROW_CAP;
    const truncatedSources = stringArray(row.truncatedSources).sort();
    return { state: "truncated", truncatedSources: truncatedSources.length > 0 ? truncatedSources : ["unknown"], sourceLimit };
  }
  // Legacy v1 documents were built with a silent 5,000-row cap. They cannot be
  // represented as complete with evidence, so fail closed as partial until rebuilt.
  return { state: "truncated", truncatedSources: legacySources.length > 0 ? [...legacySources].sort() : ["legacy_unknown"], sourceLimit: 5_000 };
}

function isoOrFallback(value: unknown, fallback: string): string {
  const text = asString(value);
  return text && !Number.isNaN(Date.parse(text)) ? text : fallback;
}

function numberRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, nested] of Object.entries(asRecord(value))) {
    if (typeof nested === "number" && Number.isFinite(nested) && nested >= 0) out[key] = Math.trunc(nested);
  }
  return out;
}

function mergeKnownNumbers<T extends Record<string, number>>(defaults: T, value: unknown): T {
  const incoming = numberRecord(value);
  return Object.fromEntries(
    Object.keys(defaults).map((key) => [key, incoming[key] ?? defaults[key]]),
  ) as T;
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, nested] of Object.entries(asRecord(value))) {
    const text = asString(nested);
    if (text) out[key] = text;
  }
  return out;
}

async function readAggregateSources(auth: AuthContext): Promise<AggregateSourceRead> {
  const sourceFields: Record<string, string[]> = {
    programs: ["canonicalProgramId", "title", "slug", "status", "aliases", "legacyProgramIds", "visible", "deletedAt", "archivedAt", "updatedAtIso", "createdAtIso", "ownerUid", "ownerEmail", "ownerName", "createdBy"],
    program_aliases: ["alias", "canonicalProgramId", "reason", "confirmationStatus", "evidenceType", "sourceRefs", "sourceRevisionHash", "confirmedAtIso", "confirmedBy", "confirmedByRole", "registryVersion"],
    program_applications: ["programId", "leadId", "creatorId", "status", "createdAtIso", "updatedAtIso", "ownerUid", "ownerEmail", "ownerName", "programOwnerUid", "programOwnerEmail", "programOwnerName"],
    program_sheet_leads: ["programId", "program", "programSlug", "bridgedProgramId", "qualificationStatus", "status", "finalVerdict", "createdAtIso", "updatedAtIso", "submittedAtIso", "qualifiedAtIso", "creatorId", "bridgedCreatorId"],
    scp_coldmail_history: ["programId", "leadId", "creatorId", "outreachId", "mailResultId", "trackingId", "providerMessageId", "providerMessageIdHash", "gmailMessageId", "messageId", "sourceRef", "mailOutboxRef", "deliveryState", "status", "hasReply", "replyReceivedAtIso", "repliedAtIso", "lastReplyAtIso", "sentAtIso", "createdAtIso", "updatedAtIso"],
    scp_outreach: ["programId", "leadId", "creatorId", "outreachId", "mailResultId", "trackingId", "providerMessageId", "providerMessageIdHash", "gmailMessageId", "messageId", "sourceRef", "mailOutboxRef", "status", "hasReply", "replyReceivedAtIso", "repliedAtIso", "lastReplyAtIso", "coldSentAtIso", "sentAtIso", "createdAtIso", "updatedAtIso", "leadRef"],
    conversations: ["programId", "campaignId", "leadId", "creatorId", "unread", "aiActive", "outreachId", "trackingId", "hasCreatorReply", "lastInboundAtIso", "lastMessageFrom", "lastMessageAtIso", "updatedAtIso", "createdAtIso", "ownerUid", "ownerEmail", "ownerName", "programOwnerUid", "programOwnerEmail", "programOwnerName"],
    qualification_decisions: ["programId", "leadId", "creatorId", "finalVerdict", "decision", "status", "result", "aiRecommendation", "decidedAtIso", "createdAtIso", "updatedAtIso"],
    scp_mail_results: ["programId", "leadId", "creatorId", "outreachId", "mailResultId", "trackingId", "providerMessageId", "gmailMessageId", "messageId", "status", "result", "sentAtIso", "createdAtIso", "updatedAtIso", "templateKind", "kind"],
    submission_tasks: ["programId", "leadId", "creatorId", "taskStatus", "issuedAtIso", "createdAtIso", "updatedAtIso"],
    submissions: ["programId", "leadId", "creatorId", "submissionId", "videoId", "youtubeVideoId", "title", "reviewReasonCode", "reviewStatus", "status", "source", "contentType", "submittedAtIso", "createdAtIso", "updatedAtIso", "paymentStatus", "payableStatus", "paid", "paidAtIso"],
    review_ledger: ["programId", "submissionId", "videoId", "youtubeVideoId", "leadId", "creatorId", "status", "reviewStatus", "canonicalStatus", "toStatus", "aiDecision", "humanDecision", "decidedAtIso", "updatedAtIso", "createdAtIso", "paidAtIso"],
    mail_outbound_log: ["programId", "leadId", "creatorId", "outreachId", "mailResultId", "trackingId", "providerMessageIdHash", "gmailMessageId", "messageId", "conversationId", "sourceRef", "mailOutboxRef", "mailType", "kind", "stage", "source", "gameId", "deliveryState", "status", "hasReply", "replyReceivedAtIso", "repliedAtIso", "lastReplyAtIso", "openedAtIso", "openCount", "clickCount", "clickedAtIso", "sentAtIso", "createdAtIso", "updatedAtIso"],
    // Portal Apply → Flu management canonical record. Program/creator identity lives nested under
    // `identity` (never top-level) — see identityProjectionRow. This was previously absent from the
    // snapshot source list, so portal-only applies (no program_applications/program_sheet_leads row)
    // never counted anywhere.
    scp_application_management: ["identity", "submittedAtIso", "createdAtIso", "updatedAtIso"],
    // W27-F1: the v3/portal video review terminal state — previously absent, so the portal pipeline's
    // real submit/approve activity (verified prod: view-cpm-tagged, `state` field not `status`) never
    // counted anywhere. `submissions`/`review_ledger` are the legacy sheet-pipeline equivalents.
    scp_video_review_state: ["programId", "canonicalProgramId", "submissionId", "videoId", "youtubeVideoId", "state", "submittedAtIso", "createdAtIso", "updatedAtIso", "subject.applicationId", "subject.fluCreatorId"],
  };
  const entries = await Promise.all(Object.entries(sourceFields).map(async ([collection, fields]) => [collection, await readRows(collection, fields, auth)] as const));
  const rows = Object.fromEntries(entries.map(([collection, result]) => [collection, result.rows]));
  const truncatedSources = entries.filter(([, result]) => !result.complete).map(([collection]) => collection).sort();
  return {
    rows,
    completeness: truncatedSources.length > 0
      ? { state: "truncated", truncatedSources, sourceLimit: SOURCE_ROW_CAP }
      : completeSourceRead(),
  };
}

async function readRows(collection: string, fields: string[], auth: AuthContext): Promise<{ rows: SourceRow[]; complete: boolean }> {
  const rows: SourceRow[] = [];
  let scanned = 0;
  let cursor: QueryDocumentSnapshot | null = null;

  while (scanned < SOURCE_ROW_CAP) {
    const remaining = SOURCE_ROW_CAP - scanned;
    const pageSize = Math.min(SOURCE_PAGE_SIZE, remaining);
    let query: Query = adminDb.collection(collection)
      .select(...operationalSnapshotProjectionFields(fields))
      .orderBy(FieldPath.documentId())
      .limit(pageSize);
    if (cursor) query = query.startAfter(cursor);
    const snap = await query.get();
    if (snap.empty) return { rows, complete: true };
    scanned += snap.size;
    rows.push(...snap.docs
      .map((doc) => rowFromDoc(doc))
      .filter((row) => !isOperationalFixtureRecord(row, collection) && rowMatchesAccountScope(scopeKey(collection), row, auth)));
    cursor = snap.docs.at(-1) ?? null;
    if (snap.size < pageSize || !cursor) return { rows, complete: true };
  }

  if (!cursor) return { rows, complete: true };
  const overflow = await adminDb.collection(collection)
    .orderBy(FieldPath.documentId())
    .startAfter(cursor)
    .limit(1)
    .get();
  return { rows, complete: overflow.empty };
}

function scopeKey(collection: string): string {
  return SCOPE_KEY_BY_COLLECTION[collection] ?? collection;
}

function operationalSnapshotProjectionFields(fields: readonly string[]): string[] {
  return [...new Set([...fields, ...OPERATIONAL_FIXTURE_PROVENANCE_FIELDS])];
}

function withoutOperationalFixtureRows(sourceRead: AggregateSourceRead): AggregateSourceRead {
  return {
    ...sourceRead,
    rows: Object.fromEntries(Object.entries(sourceRead.rows).map(([collection, rows]) => [
      collection,
      rows.filter((row) => !isOperationalFixtureRecord(row, collection)),
    ])),
  };
}

function rowFromDoc(doc: QueryDocumentSnapshot): SourceRow {
  return { ...(doc.data() ?? {}), id: doc.id, ref: doc.ref.path };
}

function buildProgramDrafts(programRows: SourceRow[], aliasMap: Record<string, string>): Map<string, ProgramSummaryDraft> {
  const map = new Map<string, ProgramSummaryDraft>();
  for (const row of programRows) {
    const rawId = asString(row.id);
    const mappedRawId = normalizeProgramId(rawId, aliasMap);
    const declaredCanonical = normalizeProgramId(row.canonicalProgramId, aliasMap);
    // A contradictory denormalized field is evidence of drift, not merge
    // authority. Keep the source row isolated under its exact document ID.
    const canonical = declaredCanonical && declaredCanonical !== mappedRawId
      ? rawId
      : (declaredCanonical || mappedRawId);
    if (!canonical) continue;
    const draft = ensureProgramDraft(map, canonical);
    const metadataRank = rawId === canonical ? 2 : 1;
    draft.aliases.add(canonical);
    if (rawId && rawId !== canonical) draft.aliases.add(rawId);
    if (rawId && rawId !== canonical) draft.legacyProgramIds.add(rawId);
    for (const alias of stringArray(row.aliases)) {
      const normalizedAlias = normalizeProgramId(alias, aliasMap);
      if (normalizedAlias === canonical) draft.aliases.add(alias);
    }
    for (const legacy of stringArray(row.legacyProgramIds)) {
      if (normalizeProgramId(legacy, aliasMap) === canonical) draft.legacyProgramIds.add(legacy);
    }
    if (metadataRank >= draft.metadataRank) {
      draft.title = safeText(row.title, draft.title || titleFallback(canonical), 120);
      draft.slug = safeText(row.slug, draft.slug || slugFallback(canonical), 120);
      draft.status = safeText(row.status, draft.status || "unknown", 60);
      draft.visible = row.visible !== false && !row.deletedAt && !row.archivedAt;
      draft.metadataRank = metadataRank;
    }
    draft.lastActivityAtIso = maxIsoValue(draft.lastActivityAtIso, timestampOf(row));
  }
  return map;
}

type OperationalIdentityContext = {
  profileForAlias: Record<string, string>;
  programsByParticipant: Map<string, Set<string>>;
  conflictCount: number;
  conflictSummaries: OperationalSnapshotConflictSummary[];
  aliasMap: Record<string, string>;
  currentRoundApplicationIds: ReadonlySet<string>;
};

type CanonicalStageMetrics = {
  lead: number;
  qualified: number;
  rejected: number;
  coldmailSent: number;
  contacted: number;
  replied: number;
  videoSubmitted: number;
  approved: number;
  paid: number;
  respondedOrApplied: number;
  appliedWithPortal: number;
};

function buildOperationalIdentityContext(sources: Record<string, SourceRow[]>): OperationalIdentityContext {
  const aliasMap = confirmedProgramAliasMap(sources.program_aliases ?? []);
  const currentRoundApplicationIds = new Set(sources.scp_application_management.map((row) => asString(row.id)).filter(Boolean));
  const graph = buildScpIdentityGraph({
    scp_outreach: sources.scp_outreach.map((row) => identityProjectionRow(row, "scp_outreach")),
    scp_coldmail_history: sources.scp_coldmail_history.map((row) => identityProjectionRow(row, "scp_coldmail_history")),
    mail_outbound_log: sources.mail_outbound_log.map((row) => identityProjectionRow(row, "mail_outbound_log")),
    conversations: sources.conversations,
    program_applications: sources.program_applications,
    program_sheet_leads: sources.program_sheet_leads,
    qualification_decisions: sources.qualification_decisions,
    scp_mail_results: sources.scp_mail_results,
    submission_tasks: sources.submission_tasks,
    submissions: sources.submissions,
    review_ledger: sources.review_ledger,
  });
  const context: OperationalIdentityContext = {
    profileForAlias: graph.profileForAlias,
    programsByParticipant: new Map(),
    conflictCount: graph.conflicts.length,
    conflictSummaries: summarizeOperationalIdentityConflicts(graph.conflicts, sources, aliasMap, currentRoundApplicationIds),
    aliasMap,
    currentRoundApplicationIds,
  };
  for (const [source, rows] of Object.entries(sources)) {
    for (const row of rows) {
      const programId = resolvedProgramIdFrom(row, aliasMap, source, currentRoundApplicationIds);
      if (!programId) continue;
      const participant = participantIdentity(row, source, context);
      const programs = context.programsByParticipant.get(participant) ?? new Set<string>();
      programs.add(programId);
      context.programsByParticipant.set(participant, programs);
    }
  }
  return context;
}

function summarizeOperationalIdentityConflicts(
  conflicts: ScpAliasConflict[],
  sources: Record<string, SourceRow[]>,
  aliasMap: Record<string, string>,
  currentRoundApplicationIds: ReadonlySet<string>,
): OperationalSnapshotConflictSummary[] {
  const rowsByLifecycleRef = new Map<string, SourceRow>();
  for (const [source, rows] of Object.entries(sources)) {
    for (const row of rows) {
      rowsByLifecycleRef.set(`${source}/${row.id}`, row);
    }
  }
  return conflicts.slice(0, 20).map((conflict) => {
    const programs = new Set<string>();
    for (const ref of conflict.sourceRefs) {
      const row = rowsByLifecycleRef.get(ref);
      const programId = row ? resolvedProgramIdFrom(row, aliasMap, ref.split("/")[0], currentRoundApplicationIds) : "";
      if (programId) programs.add(programId);
    }
    return {
      conflictType: conflict.type,
      canonicalProgramId: programs.size === 1 ? [...programs][0] : "mixed_or_unresolved",
      hashedStrongAlias: hashJson(conflict.aliasId).slice(0, 24),
      sourceCount: conflict.sourceRefs.length,
      sourceRefHashes: conflict.sourceRefs.map((ref) => hashJson(ref).slice(0, 24)).sort().slice(0, 20),
    };
  });
}

function sanitizePartialReasons(
  value: unknown,
  status: "fresh" | "stale" | "rebuilding" | "partial",
  completeness: SourceCompleteness,
): OperationalSnapshotPartialReason[] {
  const allowed = new Set<OperationalSnapshotPartialReason>([
    "identity_conflict",
    "alias_registry_fence_changed",
    "source_truncated",
  ]);
  const reasons = stringArray(value)
    .filter((item): item is OperationalSnapshotPartialReason => allowed.has(item as OperationalSnapshotPartialReason));
  if (reasons.length > 0) return [...new Set(reasons)].sort();
  if (completeness.state === "truncated") return ["source_truncated"];
  return status === "partial" ? ["identity_conflict"] : [];
}

function sanitizeConflictSummaries(value: unknown): OperationalSnapshotConflictSummary[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((item): OperationalSnapshotConflictSummary[] => {
    const row = asRecord(item);
    const conflictType = asString(row.conflictType);
    const canonicalProgramId = asString(row.canonicalProgramId);
    const hashedStrongAlias = asString(row.hashedStrongAlias).toLowerCase();
    const sourceCount = typeof row.sourceCount === "number" && Number.isFinite(row.sourceCount)
      ? Math.max(0, Math.trunc(row.sourceCount))
      : 0;
    const sourceRefHashes = stringArray(row.sourceRefHashes)
      .map((hash) => hash.toLowerCase())
      .filter((hash) => /^[a-f0-9]{8,40}$/.test(hash))
      .slice(0, 20);
    if (!conflictType || !canonicalProgramId || !/^[a-f0-9]{8,40}$/.test(hashedStrongAlias)) return [];
    return [{ conflictType, canonicalProgramId, hashedStrongAlias, sourceCount, sourceRefHashes }];
  });
}

function identityProjectionRow(row: SourceRow, source: string): SourceRow {
  const sourceOutreachId = documentIdFromRef(row.sourceRef, "scp_outreach");
  const outboxTrackingId = documentIdFromRef(row.mailOutboxRef, "mail_outbound_log")
    || documentIdFromRef(row.sourceRef, "mail_outbound_log");
  // scp_application_management never carries programId/creatorId/outreachId at the top level
  // (privacy-by-construction — see applicationManagementAttributionCore.ts). Flatten the nested
  // `identity` map so the generic resolveProgramId/participantIdentity readers can see it, the same
  // way seriesId/viewSeriesId are synthesized for the mail sources above.
  const managementIdentity = source === "scp_application_management" ? asRecord(row.identity) : null;
  return {
    ...row,
    ...(source === "scp_outreach" ? { seriesId: row.id } : {}),
    ...(sourceOutreachId ? { seriesId: sourceOutreachId } : {}),
    ...(outboxTrackingId ? { viewSeriesId: outboxTrackingId } : {}),
    ...(managementIdentity ? {
      programId: asString(managementIdentity.programId),
      creatorId: asString(managementIdentity.fluCreatorId) || asString(managementIdentity.portalCreatorId),
      outreachId: asString(managementIdentity.outreachId),
    } : {}),
    // scp_video_review_state's terminal decision lives in `state` ("queued"/"approved"/"rejected"),
    // not any of the field names isVideoApproved/isVideoRejected already check. Project it onto
    // canonicalStatus (an existing checked name) rather than widening those shared predicates, which
    // also serve submissions/review_ledger rows that must not start matching on a stray `state` field.
    ...(source === "scp_video_review_state" ? { canonicalStatus: asString(row.state) } : {}),
  };
}

function aggregateProgramCounts(
  programs: Map<string, ProgramSummaryDraft>,
  sources: Record<string, SourceRow[]>,
  identity: OperationalIdentityContext,
): void {
  const programIds = new Set(programs.keys());
  for (const [source, rows] of Object.entries(sources)) {
    for (const row of rows) {
      const programId = resolveProgramId(row, source, identity);
      if (programId) programIds.add(programId);
    }
  }

  for (const programId of programIds) {
    const draft = ensureProgramDraft(programs, programId);
    const metrics = canonicalStageMetrics(sources, identity, programId);
    const applications = distinctCount(
      sources.program_applications.filter((row) => resolveProgramId(row, "program_applications", identity) === programId),
      (row) => participantIdentity(row, "program_applications", identity),
    );
    const sheetLeads = distinctCount(
      sources.program_sheet_leads.filter((row) => resolveProgramId(row, "program_sheet_leads", identity) === programId),
      (row) => participantIdentity(row, "program_sheet_leads", identity),
    );
    draft.counts = {
      applications,
      sheetLeads,
      qualified: metrics.qualified,
      rejected: metrics.rejected,
      coldmailSent: metrics.coldmailSent,
      replies: metrics.replied,
      videosSubmitted: metrics.videoSubmitted,
      videosApproved: metrics.approved,
      paid: metrics.paid,
      respondedOrApplied: metrics.respondedOrApplied,
      appliedWithPortal: metrics.appliedWithPortal,
    };
    const programRows = Object.entries(sources).flatMap(([source, rows]) => (
      rows.filter((row) => resolveProgramId(row, source, identity) === programId)
    ));
    draft.lastActivityAtIso = maxIsoValue(draft.lastActivityAtIso, maxIso(programRows));
  }
}

function canonicalStageMetrics(
  sources: Record<string, SourceRow[]>,
  identity: OperationalIdentityContext,
  programId?: string,
): CanonicalStageMetrics {
  const inProgram = (row: SourceRow, source: string) => !programId || resolveProgramId(row, source, identity) === programId;
  const leadRows = sources.program_sheet_leads.filter((row) => inProgram(row, "program_sheet_leads"));
  const qualificationRows = [
    ...sources.program_sheet_leads.map((row) => ({ row, source: "program_sheet_leads", authority: 1 })),
    ...sources.qualification_decisions.map((row) => ({ row, source: "qualification_decisions", authority: 2 })),
  ].filter(({ row, source }) => inProgram(row, source));
  const qualification = new Map<string, { state: "qualified" | "rejected"; authority: number; at: string }>();
  for (const candidate of qualificationRows) {
    const state = isRejected(candidate.row) ? "rejected" : isQualified(candidate.row) ? "qualified" : null;
    if (!state) continue;
    const key = participantIdentity(candidate.row, candidate.source, identity);
    const next: { state: "qualified" | "rejected"; authority: number; at: string } = {
      state,
      authority: candidate.authority,
      at: timestampOf(candidate.row),
    };
    const current = qualification.get(key);
    if (!current || terminalCandidateWins(next, current, true)) qualification.set(key, next);
  }

  const sentRows = [
    ...sources.scp_coldmail_history.map((row) => ({ row, source: "scp_coldmail_history" })),
    ...sources.scp_outreach.map((row) => ({ row, source: "scp_outreach" })),
    ...sources.mail_outbound_log
      .filter(isInitialOutreachMail)
      .map((row) => ({ row, source: "mail_outbound_log" })),
  ].filter(({ row, source }) => outboundRowCountsAsSent(row, source) && inProgram(row, source));
  const replyRows = [
    ...sources.scp_coldmail_history.map((row) => ({ row, source: "scp_coldmail_history", reply: hasReply(row) })),
    ...sources.scp_outreach.map((row) => ({ row, source: "scp_outreach", reply: hasReply(row) })),
    ...sources.mail_outbound_log
      .filter(isInitialOutreachMail)
      .map((row) => ({ row, source: "mail_outbound_log", reply: hasReply(row) })),
    ...sources.conversations.map((row) => ({ row, source: "conversations", reply: hasConversationReply(row) })),
  ].filter(({ row, source, reply }) => reply && inProgram(row, source));

  // Person-unit union of reply ∪ apply (§F-1: 반응 = 회신 + apply 신청). `program_applications`/
  // `program_sheet_leads` are the pre-existing apply sources; `scp_application_management` is the
  // portal apply canonical source that was previously missing from this pipeline entirely.
  const appliedRows = [
    ...sources.program_applications.map((row) => ({ row, source: "program_applications" })),
    ...sources.program_sheet_leads.map((row) => ({ row, source: "program_sheet_leads" })),
    ...sources.scp_application_management.map((row) => ({
      row: identityProjectionRow(row, "scp_application_management"),
      source: "scp_application_management",
    })),
  ].filter(({ row, source }) => inProgram(row, source));
  const respondedOrApplied = distinctCount(
    [...replyRows, ...appliedRows],
    ({ row, source }) => participantIdentity(row, source, identity),
  );
  // W26-FIX-1: apply-only (no reply) — this is the "신청" stage denominator, distinct from
  // respondedOrApplied above (which is "반응" = reply ∪ apply and must not be reused here).
  const appliedWithPortal = distinctCount(
    appliedRows,
    ({ row, source }) => participantIdentity(row, source, identity),
  );

  const videoRows = [
    ...sources.submissions.map((row) => ({ row, source: "submissions", authority: 1 })),
    ...sources.review_ledger.map((row) => ({ row, source: "review_ledger", authority: 2 })),
    // v3/portal pipeline's terminal video state — the review_ledger equivalent for view-cpm-sourced
    // videos (review_ledger itself is currently empty in prod for this program).
    ...sources.scp_video_review_state.map((row) => ({
      row: identityProjectionRow(row, "scp_video_review_state"),
      source: "scp_video_review_state",
      authority: 2,
    })),
  ].filter(({ row, source }) => inProgram(row, source));
  const videos = new Map<string, { submitted: boolean; paid: boolean; review: "approved" | "rejected" | null; authority: number; at: string }>();
  for (const candidate of videoRows) {
    const key = submissionIdentity(candidate.row, candidate.source);
    const current = videos.get(key) ?? { submitted: false, paid: false, review: null, authority: 0, at: "" };
    current.submitted ||= candidate.source === "review_ledger" || isVideoSubmitted(candidate.row);
    current.paid ||= isPaid(candidate.row);
    const review = isVideoApproved(candidate.row) ? "approved" : isVideoRejected(candidate.row) ? "rejected" : null;
    if (review) {
      const next = { state: review, authority: candidate.authority, at: timestampOf(candidate.row) };
      const previous = current.review ? { state: current.review, authority: current.authority, at: current.at } : null;
      if (!previous || terminalCandidateWins(next, previous, false)) {
        current.review = review;
        current.authority = candidate.authority;
        current.at = next.at;
      }
    }
    videos.set(key, current);
  }

  return {
    lead: distinctCount(leadRows, (row) => participantIdentity(row, "program_sheet_leads", identity)),
    qualified: [...qualification.values()].filter((row) => row.state === "qualified").length,
    rejected: [...qualification.values()].filter((row) => row.state === "rejected").length,
    respondedOrApplied,
    appliedWithPortal,
    coldmailSent: distinctSentEventCount(sentRows, identity),
    contacted: distinctCount(sentRows, ({ row, source }) => participantIdentity(row, source, identity)),
    replied: distinctCount(replyRows, ({ row, source }) => participantIdentity(row, source, identity)),
    videoSubmitted: [...videos.values()].filter((row) => row.submitted).length,
    approved: [...videos.values()].filter((row) => row.review === "approved").length,
    paid: [...videos.values()].filter((row) => row.paid).length,
  };
}

function terminalCandidateWins(
  next: { state: string; authority: number; at: string },
  current: { state: string; authority: number; at: string },
  authorityFirst: boolean,
): boolean {
  if (authorityFirst && next.authority !== current.authority) return next.authority > current.authority;
  const nextTime = Date.parse(next.at) || 0;
  const currentTime = Date.parse(current.at) || 0;
  if (nextTime !== currentTime) return nextTime > currentTime;
  if (!authorityFirst && next.authority !== current.authority) return next.authority > current.authority;
  const terminalRank = (state: string) => state === "rejected" ? 2 : 1;
  return terminalRank(next.state) >= terminalRank(current.state);
}

function distinctCount<T>(rows: T[], keyFor: (row: T) => string): number {
  return new Set(rows.map(keyFor).filter(Boolean)).size;
}

function participantIdentity(row: SourceRow, source: string, identity: OperationalIdentityContext): string {
  for (const alias of aliasesForOperationalRow(row, source)) {
    const profile = identity.profileForAlias[alias];
    if (profile) return profile;
  }
  const lead = leadIdFrom(row, source);
  if (lead) return `lead:${lead}`;
  const creator = asString(row.creatorId) || asString(row.bridgedCreatorId);
  if (creator) return `creator:${creator}`;
  return `row:${row.ref}`;
}

function aliasesForOperationalRow(row: SourceRow, source: string): string[] {
  const values: Array<[ScpAliasKind, unknown]> = [
    ["leadId", leadIdFrom(row, source)],
    ["creatorId", row.creatorId],
    ["creatorId", row.bridgedCreatorId],
    ["submissionId", submissionIdFrom(row, source)],
    ["trackingId", row.trackingId],
    ["trackingId", row.outreachId],
    ["trackingId", row.mailResultId],
    ["conversationId", row.conversationId],
  ];
  if (source === "scp_outreach") values.push(["trackingId", row.id]);
  if (source === "conversations") values.push(["conversationId", row.id]);
  const sourceOutreachId = documentIdFromRef(row.sourceRef, "scp_outreach");
  if (sourceOutreachId) values.push(["trackingId", sourceOutreachId]);
  const outboxTrackingId = documentIdFromRef(row.mailOutboxRef, "mail_outbound_log")
    || documentIdFromRef(row.sourceRef, "mail_outbound_log");
  if (outboxTrackingId) values.push(["trackingId", outboxTrackingId]);
  return values.flatMap(([kind, value]) => {
    const alias = makeScpAlias(kind, value);
    return alias ? [alias.aliasId] : [];
  });
}

function documentIdFromRef(value: unknown, collection: string): string {
  const parts = asString(value).split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== collection) return "";
  return parts[1] ?? "";
}

function leadIdFrom(row: SourceRow, source: string): string {
  const explicit = asString(row.leadId) || asString(row.lead_id);
  if (explicit) return explicit;
  const leadRef = asString(row.leadRef);
  if (leadRef) return leadRef.split("/").filter(Boolean).at(-1) ?? "";
  return source === "program_sheet_leads" ? row.id : "";
}

function submissionIdFrom(row: SourceRow, source: string): string {
  return asString(row.submissionId) || asString(row.submission_id) || (source === "submissions" ? row.id : "");
}

function submissionIdentity(row: SourceRow, source: string): string {
  const submissionId = submissionIdFrom(row, source);
  if (submissionId) return `submission:${submissionId}`;
  const videoId = asString(row.videoId) || asString(row.youtubeVideoId);
  if (videoId) return `video:${videoId}`;
  // Without a submission/video identifier there is no safe basis for merging two review
  // events from the same creator; participant-level merging silently under-counts creators
  // who submitted more than one video.
  return `unlinked:${row.ref}`;
}

function distinctSentEventCount(
  rows: Array<{ row: SourceRow; source: string }>,
  identity: OperationalIdentityContext,
): number {
  const parent = rows.map((_, index) => index);
  const find = (value: number): number => {
    const next = parent[value];
    if (next === value) return value;
    const root = find(next);
    parent[value] = root;
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[leftRoot] = rightRoot;
  };
  const firstRowByAlias = new Map<string, number>();
  rows.forEach(({ row, source }, index) => {
    for (const alias of sentEventAliases(row, source, identity)) {
      const first = firstRowByAlias.get(alias);
      if (first === undefined) firstRowByAlias.set(alias, index);
      else union(index, first);
    }
  });
  return new Set(rows.map((_, index) => find(index))).size;
}

function sentEventAliases(row: SourceRow, source: string, identity: OperationalIdentityContext): string[] {
  const aliases: string[] = [];
  for (const field of ["providerMessageId", "gmailMessageId", "messageId"] as const) {
    const value = asString(row[field]);
    if (value) aliases.push(`message:${value}`);
  }
  for (const field of ["trackingId", "mailResultId", "outreachId"] as const) {
    const value = asString(row[field]);
    if (value) aliases.push(`${field.replace(/Id$/, "")}:${value}`);
  }
  const providerHash = asString(row.providerMessageIdHash).toLowerCase();
  if (/^[a-f0-9]{32,128}$/.test(providerHash)) aliases.push(`message-hash:${providerHash}`);
  const sourceOutreachId = documentIdFromRef(row.sourceRef, "scp_outreach");
  if (sourceOutreachId) aliases.push(`outreach:${sourceOutreachId}`);
  const outboxTrackingId = documentIdFromRef(row.mailOutboxRef, "mail_outbound_log")
    || documentIdFromRef(row.sourceRef, "mail_outbound_log");
  if (outboxTrackingId) aliases.push(`tracking:${outboxTrackingId}`);
  if (source === "scp_outreach") aliases.push(`outreach:${row.id}`);
  if (aliases.length > 0) return [...new Set(aliases)];
  const timestamp = asString(row.sentAtIso) || asString(row.coldSentAtIso);
  return [`participant:${participantIdentity(row, source, identity)}:${timestamp || row.id}`];
}

function resolveProgramId(row: SourceRow, source: string, identity: OperationalIdentityContext): string {
  const explicit = resolvedProgramIdFrom(row, identity.aliasMap, source, identity.currentRoundApplicationIds);
  if (explicit) return explicit;
  const participant = participantIdentity(row, source, identity);
  const programs = identity.programsByParticipant.get(participant);
  return programs?.size === 1 ? [...programs][0] : "";
}

function ensureProgramDraft(map: Map<string, ProgramSummaryDraft>, canonicalProgramId: string): ProgramSummaryDraft {
  const canonical = canonicalProgramId || "unknown";
  let draft = map.get(canonical);
  if (!draft) {
    draft = { canonicalProgramId: canonical, title: titleFallback(canonical), slug: slugFallback(canonical), status: "unknown", aliases: new Set([canonical]), legacyProgramIds: new Set(), visible: true, counts: { applications: 0, sheetLeads: 0, qualified: 0, rejected: 0, coldmailSent: 0, replies: 0, videosSubmitted: 0, videosApproved: 0, paid: 0, respondedOrApplied: 0, appliedWithPortal: 0 }, lastActivityAtIso: "", metadataRank: 0 };
    if (canonical === canonicalScpProgramId) {
      draft.aliases.add("scp");
      draft.legacyProgramIds.add("scp");
      draft.title = "Super Creator Partners";
      draft.slug = "super-creator-partners";
      draft.status = "open";
    }
    map.set(canonical, draft);
  }
  return draft;
}

// W27-F1 (superseded by W48-3): this used to hardcode the portal's one tag ("view-cpm") to
// `pg-scp-cpm-2608-2`, on the premise that since the portal only ever knows one program, that tag
// must mean CPM. Judgment since (the 3rd correction below, and W47/83aff97 moving application
// minting to portal scope) refuted the premise: the portal sending one tag means it CANNOT
// distinguish programs, not that the program is CPM. A prod check found 34 `identity.programId`
// rows tagged "view-cpm" that are not all CPM applications. Real attribution belongs to the signed
// outreach token's campaignId (applicationManagementAttributionCore.ts), not this tag — so the
// portal alias resolves to unattributed here. No ghost bucket results: aggregateProgramCounts only
// adds a programId to its draft set `if (programId)` (see the guard right above its loop), and an
// empty return already has precedent in this function (the scp_video_review_state non-current-round
// branch below).
function normalizeProgramId(value: unknown, aliasMap: Record<string, string> = {}): string {
  const raw = asString(value);
  if (!raw) return "";
  const scpNormalized = isScpProgramId(raw) ? normalizeScpProgramId(raw) : raw;
  if (scpNormalized === LEGACY_SHEET_PORTAL_PROGRAM_ID) return "";
  return resolveCanonicalProgramId(scpNormalized, aliasMap);
}

function resolvedProgramIdFrom(row: SourceRow, aliasMap: Record<string, string> = {}, source?: string, currentRoundApplicationIds?: ReadonlySet<string>): string {
  const declaredCanonical = asString(row.canonicalProgramId);
  const raw = asString(row.programId) || asString(row.program) || asString(row.programSlug) || asString(row.bridgedProgramId) || (isScpProgramId(row.id) ? asString(row.id) : "");
  // W27-F1 (3rd correction, see artifacts/W27-ADDENDUM-attribution-by-join-not-by-tag.md): the
  // "view-cpm" tag on scp_video_review_state mixes real current-round v3 submissions with
  // legacy-sheet-migrated history in the SAME collection — neither blanket-including nor
  // blanket-excluding the tag is correct. Judge per row by join, not by tag: a row is current-round
  // only if its applicationId exists in scp_application_management or its fluCreatorId carries the v3
  // ingestion's own unresolved-identity prefix; legacy rows carry old CR00xxx roster numbers instead.
  if (source === "scp_video_review_state" && (declaredCanonical === LEGACY_SHEET_PORTAL_PROGRAM_ID || raw === LEGACY_SHEET_PORTAL_PROGRAM_ID)) {
    const subject = asRecord(row.subject);
    const applicationId = asString(subject.applicationId);
    const isCurrentRound = (applicationId && currentRoundApplicationIds?.has(applicationId)) || /^(CR\.v3\.|unclassified:)/.test(asString(subject.fluCreatorId));
    if (!isCurrentRound) return "";
  }
  const canonicalCandidates = [...new Set([declaredCanonical, raw].filter(Boolean).map((value) => normalizeProgramId(value, aliasMap)).filter(Boolean))];
  return canonicalCandidates.length === 1 ? canonicalCandidates[0] : "";
}

/**
 * W118 [헤세 장애 보고 2026-09-05] — **명시적 미발송 상태는 폴백으로 되살아나면 안 된다.**
 * `recordMailOutboundLog` 는 차단 행에도 `sentAtIso` 를 찍었다(mailSignature.ts). 그래서 아래
 * `Boolean(row.sentAtIso)` 폴백이 `deliveryState:"blocked"` 행까지 발송으로 세고 있었다 —
 * 아웃리치 수동 정지 기간(2026-09-03~) 동안 하루 수천 건이 그 경로로 들어왔다.
 *
 * 2026-09-05 적대 리뷰 P1 보강: 종전 거부 목록은 3종뿐이라
 * `suppressed` · `bounced` · `failed` · `retryable_failed` · `dead_letter` · `queued` · `sending` 등이
 * 전부 `sentAtIso` 폴백으로 되살아났다. 실제로 쓰이는 deliveryState 값 전수(24종)를 기준으로 닫는다.
 */
const NOT_DELIVERED_ROW_STATES: ReadonlySet<string> = new Set([
  "blocked",
  "skipped",
  "skipped_duplicate",
  "suppressed",
  "suppressed_duplicate",
  "bounced",
  "deferred",
  "failed",
  "retryable_failed",
  "dead_letter",
  "cancelled",
  "canceled",
  "delivery_unknown",
  "recipient_pending",
  "queued",
  "queued_for_review",
  "sending",
  "processing",
  "leased",
  "sent_evidence_pending",
]);

/**
 * 이 행이 **실제 발송**인가.
 *
 * `mail_outbound_log` 는 `recordMailOutboundLog` 가 항상 정규화된 `deliveryState` 를 싣는 정본
 * 원장이다 — 그러므로 술어는 **허용목록 1종**(`sent`)이고 폴백이 없다
 * (`nudgeReportFacts.isDeliveredOutboundLogRow` 와 같은 정본을 쓴다. `mock_sent` ·
 * `sent_evidence_pending` · `retryable_failed` · 상태 결측은 발송이 아니다).
 *
 * 폴백이 남는 곳은 **레거시 두 컬렉션뿐**이다:
 *   · `scp_coldmail_history` — 초기 판본이 `deliveryState` 없이 `sentAtIso` 만 찍었다.
 *   · `scp_outreach` — 한국어 `status` 와 `coldSentAtIso` 만 있는 행이 남아 있다.
 * 그쪽도 명시적 미발송 상태는 되살리지 않고, 판정 우선순위는 `deliveryState` 가 먼저다
 * (종전에는 `status` 가 먼저라 `status` 가 있으면 `deliveryState:"blocked"` 를 아예 안 봤다).
 */
export function outboundRowCountsAsSent(row: SourceRow, source: string): boolean {
  if (source === "mail_outbound_log") return isDeliveredOutboundLogRow(row);
  const status = lower(row.deliveryState || row.status || row.result);
  if (NOT_DELIVERED_ROW_STATES.has(status)) return false;
  return ["sent", "mock_sent", "delivered", "success", "contacted", "approved"].includes(status) || Boolean(row.sentAtIso || row.coldSentAtIso);
}

function isInitialOutreachMail(row: SourceRow): boolean {
  const kind = lower(row.mailType || row.kind || row.stage);
  const source = lower(row.source);
  return kind.includes("cold")
    || kind.includes("outreach")
    || kind === "manual_external_gmail"
    || source === "external_sent_mail_import"
    || source === "campaign_outreach_reconcile";
}
function hasReply(row: SourceRow): boolean {
  return row.hasReply === true ||
    [row.replyReceivedAtIso, row.repliedAtIso, row.replyAtIso, row.lastReplyAtIso].some(hasParseableIso) ||
    ["replied", "responded"].includes(lower(row.status));
}

function hasConversationReply(row: SourceRow): boolean {
  return row.hasCreatorReply === true || lower(row.lastMessageFrom) === "creator" || hasParseableIso(row.lastInboundAtIso);
}

function hasParseableIso(value: unknown): boolean {
  const text = asString(value);
  return Boolean(text) && Number.isFinite(Date.parse(text));
}

function isQualified(row: SourceRow): boolean {
  const text = lower(row.finalVerdict || row.qualificationStatus || row.status || row.decision || row.result || asRecord(row.aiRecommendation).verdict);
  return ["pass", "passed", "qualified", "approved", "accept"].includes(text);
}

function isRejected(row: SourceRow): boolean {
  const text = lower(row.finalVerdict || row.qualificationStatus || row.status || row.decision || row.result || asRecord(row.aiRecommendation).verdict);
  return ["fail", "failed", "reject", "rejected", "denied"].includes(text);
}

function isVideoSubmitted(row: SourceRow): boolean {
  return Boolean(row.submittedAtIso) || ["submitted", "pending", "approved", "rejected", "paid"].includes(lower(row.status || row.reviewStatus));
}

function isVideoApproved(row: SourceRow): boolean {
  return ["approved", "approve", "pass", "passed"].includes(lower(row.humanDecision || row.toStatus || row.reviewStatus || row.canonicalStatus || row.status));
}

function isVideoRejected(row: SourceRow): boolean {
  return ["rejected", "reject", "fail", "failed", "denied", "blocked"].includes(lower(row.humanDecision || row.toStatus || row.reviewStatus || row.canonicalStatus || row.status));
}

function isPaid(row: SourceRow): boolean {
  return row.paid === true ||
    Boolean(row.paidAtIso || row.paidAt) ||
    ["paid", "complete", "completed"].includes(lower(row.paymentStatus || row.payableStatus || row.status || row.canonicalStatus));
}

function hasOpenSignal(row: SourceRow): boolean {
  return Boolean(row.openedAtIso) || positiveNumber(row.openCount);
}

function hasClickSignal(row: SourceRow): boolean {
  return Boolean(row.clickedAtIso) || positiveNumber(row.clickCount);
}

function buildVideoMatrix(rows: SourceRow[]) {
  const matrix = { aiApproveHumanApprove: 0, aiApproveHumanReject: 0, aiHoldRejectHumanApprove: 0, aiHoldRejectHumanReject: 0, unknown: 0 };
  const decisions = new Map<string, { ai: string; aiAt: number; human: string; humanAt: number }>();
  for (const row of rows) {
    const key = submissionIdentity(row, "review_ledger");
    const at = Date.parse(timestampOf(row)) || 0;
    const current = decisions.get(key) ?? { ai: "", aiAt: -1, human: "", humanAt: -1 };
    const ai = lower(row.aiDecision || asRecord(row.aiRecommendation).verdict || asRecord(row.aiRecommendation).decision);
    const human = lower(row.humanDecision || row.toStatus || row.reviewStatus || row.canonicalStatus || row.status);
    if (ai && at >= current.aiAt) {
      current.ai = ai;
      current.aiAt = at;
    }
    if (human && at >= current.humanAt) {
      current.human = human;
      current.humanAt = at;
    }
    decisions.set(key, current);
  }
  for (const { ai, human } of decisions.values()) {
    const aiApprove = ["approve", "approved", "pass", "passed"].includes(ai);
    const aiHoldReject = ["hold", "reject", "rejected", "fail", "failed"].includes(ai);
    const humanApprove = ["approve", "approved", "pass", "passed"].includes(human);
    const humanReject = ["reject", "rejected", "fail", "failed"].includes(human);
    if (aiApprove && humanApprove) matrix.aiApproveHumanApprove += 1;
    else if (aiApprove && humanReject) matrix.aiApproveHumanReject += 1;
    else if (aiHoldReject && humanApprove) matrix.aiHoldRejectHumanApprove += 1;
    else if (aiHoldReject && humanReject) matrix.aiHoldRejectHumanReject += 1;
    else matrix.unknown += 1;
  }
  return matrix;
}

function distinctCreatorCount(sources: Record<string, SourceRow[]>, identity: OperationalIdentityContext): number {
  const ids = new Set<string>();
  for (const [source, rows] of Object.entries(sources)) {
    for (const row of rows) {
      const hasParticipantEvidence = Boolean(
        asString(row.creatorId)
        || asString(row.bridgedCreatorId)
        || leadIdFrom(row, source),
      );
      if (hasParticipantEvidence) ids.add(participantIdentity(row, source, identity));
    }
  }
  return ids.size;
}

function timestampOf(row: SourceRow): string {
  return maxIso([
    row.updatedAtIso,
    row.createdAtIso,
    row.submittedAtIso,
    row.sentAtIso,
    row.coldSentAtIso,
    row.decidedAtIso,
    row.issuedAtIso,
    row.lastInboundAtIso,
    row.lastMessageAtIso,
    row.paidAtIso,
  ]);
}
function maxIso(rows: SourceRow[] | unknown[]): string {
  return (rows as unknown[])
    .map((row) => {
      if (typeof row === "string") return Number.isNaN(Date.parse(row)) ? "" : row;
      if (row && typeof row === "object") return timestampOf(row as SourceRow);
      return "";
    })
    .filter(Boolean)
    .sort()
    .at(-1) ?? "";
}
function maxIsoValue(a: string, b: string): string {
  return [a, b].filter(Boolean).sort().at(-1) ?? "";
}

function lower(value: unknown): string {
  return asString(value).toLowerCase();
}

function positiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => asString(item)).filter(Boolean) : [];
}

function safeText(value: unknown, fallback: string, max: number): string {
  return asString(value, fallback).replace(/[\r\n\t]+/g, " ").slice(0, max);
}

function safeTitle(value: string, fallback: string): string {
  return safeText(value, titleFallback(fallback), 120);
}

function safeSlug(value: string, fallback: string): string {
  return safeText(value, slugFallback(fallback), 120).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || slugFallback(fallback);
}

function safeStatus(value: string): string {
  return safeText(value, "unknown", 60);
}

function titleFallback(programId: string): string {
  return programId === canonicalScpProgramId ? "Super Creator Partners" : programId;
}

function slugFallback(programId: string): string {
  return programId === canonicalScpProgramId
    ? "super-creator-partners"
    : programId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 40);
}
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertPiiSafeSnapshot(value: unknown, path = "snapshot"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPiiSafeSnapshot(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z]/gi, "").toLowerCase();
    if (!PII_KEY_ALLOWLIST.has(key) && PII_KEY_TOKENS.some((token) => normalized.includes(token))) {
      throw new Error(`internal: PII-bearing key rejected at ${path}.${key}`);
    }
    assertPiiSafeSnapshot(nested, `${path}.${key}`);
  }
}
