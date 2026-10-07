// W91 [헤세 · admin-bridge] Operator callables that bridge Flu Manage to the Portal-owned creator
// accounts (scp.flu.admin-bridge.v1). RBAC: manager+ server-side (same OPERATOR_ROLES gate as
// applicationManagementCallables). Both callables compose ./scpAdminBridgeClient exclusively —
// neither this file nor the client ever talks to Firestore collections Portal owns.

import { createHash } from "node:crypto";
import { makeYouTubeDataApiClient, type YouTubeApiClient } from "./youtubeEnrichmentService";
import {
  asRecord,
  asString,
  assertNonGuestAuth,
  makeBehaviorLog,
  type CallableRequestShape,
  type Role,
} from "./shared";
import {
  fetchScpAdminBridgeCreatorsDirectory,
  sendScpAdminBridgeCreatorCommand,
  type ScpAdminBridgeCreatorRow,
} from "./scpAdminBridgeClient";
// 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate): assertScpEntitled adds the same
// explicit-allowlist check getMyOrgContext.scpAccessGranted already gates the client UI on
// (functions/mailAccounts.ts, super_admin bypass included) — applied only to
// scpPortalCreatorCommandHandler below (its only client surface, ScpCreatorDirectoryPanel.tsx, is
// inside the entitlement-gated /flu/scp "creators" tab). listScpPortalCreatorsHandler is NOT
// gated by it — see that function's own comment.
import { assertScpEntitled } from "./mailAccounts";
import { adminDb } from "./firebaseAdmin";
import { SCP_APPLICATION_MANAGEMENT_COLLECTION } from "./applicationManagementStore";
import {
  SCP_LOGIN_APPROVED_MAIL_OUTBOX_COLLECTION,
  loginApprovedMailOutboxDocId,
  loginApprovedMailOutboxRow,
  isLoginRejectedMailReasonCode,
  enqueueLoginRejectedMailOutbox,
  recordLoginRejectedMailEnqueueFailure,
  recordLoginRejectedMailOutboxSlotOccupied,
  type LoginRejectedMailReasonCode,
} from "./scpReceiptMailOutbox";

const OPERATOR_ROLES: readonly Exclude<Role, "guest">[] = ["super_admin", "admin", "manager"];

function invalidArgument(message: string, errorCode = "invalid_argument_unauthorized"): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode });
}

function integerField(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) ? n : Number.NaN;
}

// ---- listScpPortalCreators (P1: read-only directory) -------------------------------------------

// Defensive re-projection through an explicit field allowlist — the bridge client already parses
// the response strictly, but the operator-facing surface should never forward a field it did not
// name here, even if the client's shape ever grows. Raw email never arrives (emailMasked only).
function reprojectAdminBridgeRow(row: ScpAdminBridgeCreatorRow): Record<string, unknown> {
  return {
    id: row.id,
    ...(row.name !== undefined ? { name: row.name } : {}),
    emailMasked: row.emailMasked,
    status: row.status,
    role: row.role,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.lastLoginAt !== undefined ? { lastLoginAt: row.lastLoginAt } : {}),
    ...(row.loginRequestedAt !== undefined ? { loginRequestedAt: row.loginRequestedAt } : {}),
    portalReady: row.portalReady,
    profile: {
      ...(row.profile.displayName !== undefined ? { displayName: row.profile.displayName } : {}),
      ...(row.profile.channelUrl !== undefined ? { channelUrl: row.profile.channelUrl } : {}),
      ...(row.profile.country !== undefined ? { country: row.profile.country } : {}),
      ...(row.profile.language !== undefined ? { language: row.profile.language } : {}),
    },
    ...(row.audienceGeo !== undefined ? { audienceGeo: row.audienceGeo } : {}),
    ...(row.approvalApplicationId !== undefined ? { approvalApplicationId: row.approvalApplicationId } : {}),
    ...(row.approvalApplication
      ? {
          approvalApplication: {
            id: row.approvalApplication.id,
            status: row.approvalApplication.status,
            revision: row.approvalApplication.revision,
            loginRequested: row.approvalApplication.loginRequested,
            ...(row.approvalApplication.programId !== undefined ? { programId: row.approvalApplication.programId } : {}),
          },
        }
      : {}),
    dataLink: {
      ...(row.dataLink.fluCreatorId !== undefined ? { fluCreatorId: row.dataLink.fluCreatorId } : {}),
      ...(row.dataLink.partnerId !== undefined ? { partnerId: row.dataLink.partnerId } : {}),
      enrollmentCount: row.dataLink.enrollmentCount,
    },
  };
}

// Task-52 (2026-09-11, otter Task-23 배포됨 — 커밋 019fc5fb): 구 서버는 heny/hesse/scp@supercent.io
// 슈퍼관리자 3계정을 Firestore 문서 없이 메모리에서 합성해 1페이지 최상단(+total)에 얹어 냈다 — 신
// 서버는 실제 문서만 반환한다. Flu 는 이 콜러블 응답을 어디에도 영속 저장하지 않는다(레포 전수 조사
// 결과: index.ts 배선/data.ts 클라 래퍼/partnerData.ts 주석/이 파일/page.tsx/ScpCreatorDirectoryPanel.tsx
// 뿐 — Firestore write 경로가 없다) — 그러니 "정리"가 아니라 이 read 경로에서 무시하기만 하면 충분
// 하다. 신 서버가 이미 배포됐으므로 지금은 대부분 no-op이다 — 배포 이전 구 서버로 롤백되는 창을
// 방어하는 용도로 남겨둔다(신 서버 안정화가 확인되면 이 필터는 제거해도 된다). rows/total 이 최대
// 3 줄어드는 것은 회귀가 아니다 — PR 본문·테스트에 명기.
const SYNTHETIC_SUPERADMIN_EMAILS = ["heny@supercent.io", "hesse@supercent.io", "scp@supercent.io"] as const;
const SYNTHETIC_SUPERADMIN_ROW_IDS = new Set(
  SYNTHETIC_SUPERADMIN_EMAILS.map(
    (email) => `usr_${createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 18)}`,
  ),
);

function isSyntheticSuperadminRow(row: Record<string, unknown>): boolean {
  return typeof row.id === "string" && SYNTHETIC_SUPERADMIN_ROW_IDS.has(row.id);
}

// One bridge page never holds more than this many rows (functions/scpAdminBridgeClient.ts's own
// ADMIN_BRIDGE_MAX_LIMIT clamp — duplicated as a literal here rather than imported, since that file's
// request/response contract with the Portal is frozen for Task-52 and must not gain a new export for
// this). Only decides whether collectPortalCreatorPages below keeps chaining; a mismatch just means an
// extra (harmless) round trip, not a correctness bug — the loop still stops on `!nextCursor` either way.
const PORTAL_CREATORS_SINGLE_PAGE_CAP = 100;
const PORTAL_CREATORS_MAX_PAGES = 5; // 500-row cap ÷ 100/page.

type PortalCreatorsFetcher = typeof fetchScpAdminBridgeCreatorsDirectory;

type PortalCreatorsPageResult =
  | { configured: false }
  | {
      configured: true;
      rows: Record<string, unknown>[];
      nextCursor?: string;
      generatedAtIso: string;
      truncated: boolean;
      // Task-52 (적대적 리뷰 P1-2): "capped"(500행 상한에 닿음 — 정상, 더 볼 필요 없음)와
      // "bridge_error"(페이지 도중 브리지가 실패해 일부만 모음 — 새로고침하면 나머지가 보일 수
      // 있음)는 운영자에게 다른 다음 행동을 시사한다. truncated:true일 때만 채운다.
      truncatedReason?: "cap" | "bridge_error";
    };

// Task-52: src/app/(app)/flu/partners/page.tsx used to walk this callable's cursor itself, up to 5
// sequential round trips (500 rows ÷ 100/page) — each one *also* paying the channel-stats N+1 below.
// A caller that asks for more rows than a single bridge page holds (limit > PORTAL_CREATORS_SINGLE_
// PAGE_CAP) now gets that chaining done here instead, so the browser needs exactly one round trip.
// Callers that ask for <= one page's worth (both ScpCreatorDirectoryPanel.tsx call sites: limit:100)
// always take the passthrough branch below — byte-for-byte the same single bridge call as before.
export async function collectPortalCreatorPages(
  params: { cursor?: string; limit?: number; updatedSince?: string },
  fetchPage: PortalCreatorsFetcher = fetchScpAdminBridgeCreatorsDirectory,
): Promise<PortalCreatorsPageResult> {
  const { cursor, limit, updatedSince } = params;
  const filterAndReproject = (rows: readonly ScpAdminBridgeCreatorRow[]) =>
    rows.map(reprojectAdminBridgeRow).filter((row) => !isSyntheticSuperadminRow(row));

  if (limit === undefined || limit <= PORTAL_CREATORS_SINGLE_PAGE_CAP) {
    const result = await fetchPage({ cursor, limit, updatedSince });
    if (!result) return { configured: false };
    return {
      configured: true,
      rows: filterAndReproject(result.rows),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      generatedAtIso: result.generatedAt,
      truncated: false,
    };
  }

  const collected: Record<string, unknown>[] = [];
  let pageCursor = cursor;
  let generatedAtIso = new Date().toISOString();
  let hasMore = false;
  let incomplete = false;
  for (let page = 0; page < PORTAL_CREATORS_MAX_PAGES && collected.length < limit; page += 1) {
    const result = await fetchPage({ cursor: pageCursor, limit, updatedSince });
    if (!result) {
      if (collected.length === 0) return { configured: false };
      // Bridge failed partway through the walk — degrade to what already succeeded instead of
      // throwing every already-collected page away (strictly better than the old client loop, which
      // discarded everything on any page failure and fell back to the read-only P0 directory). We
      // genuinely don't know if more rows exist beyond this point, so treat it as truncated.
      incomplete = true;
      break;
    }
    generatedAtIso = result.generatedAt;
    collected.push(...filterAndReproject(result.rows));
    hasMore = Boolean(result.nextCursor);
    if (!hasMore) break;
    pageCursor = result.nextCursor;
  }
  const rows = collected.slice(0, limit);
  const cappedWithMore = hasMore || collected.length > limit;
  const truncated = incomplete || cappedWithMore;
  const truncatedReason: "cap" | "bridge_error" | undefined = incomplete ? "bridge_error" : cappedWithMore ? "cap" : undefined;
  return { configured: true, rows, generatedAtIso, truncated, ...(truncatedReason ? { truncatedReason } : {}) };
}

export async function listScpPortalCreatorsHandler(request: CallableRequestShape) {
  // 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate): NOT gated by
  // assertScpEntitled — this read-only directory is also the P0 fallback source for the
  // general-purpose Partners page (src/app/(app)/flu/partners/page.tsx's GrowthPartnersPanel,
  // reachable by every org regardless of scp mailbox entitlement), not exclusive to the /flu/scp
  // creators tab. OPERATOR_ROLES (manager+) remains the only gate here.
  const auth = assertNonGuestAuth(request, "scp_admin_bridge.creators.list", OPERATOR_ROLES);
  const data = asRecord(request.data);
  const cursor = asString(data.cursor) || undefined;
  const limitField = integerField(data.limit);
  const limit = Number.isInteger(limitField) && limitField > 0 ? limitField : undefined;
  const updatedSince = asString(data.updatedSince) || undefined;

  const page = await collectPortalCreatorPages({ cursor, limit, updatedSince });
  if (!page.configured) {
    // Unconfigured (or transport/schema-drifted) bridge — NOT an error: the UI falls back to the
    // read-only P0 directory. The client cannot distinguish "unconfigured" from "drifted" and
    // deliberately does not try to (both are equally fail-closed from Flu's perspective).
    return {
      configured: false,
      rows: [] as Record<string, unknown>[],
      behaviorLog: makeBehaviorLog(auth, "scp_admin_bridge.creators.list", "success"),
    };
  }
  const handles = [...new Set(
    page.rows
      .map((row) => directoryHandleFromChannelUrl((row.profile as Record<string, unknown> | undefined)?.channelUrl))
      .filter((value): value is string => Boolean(value)),
  )];
  const statsByHandle = await directoryChannelStatsByHandle(handles, new Date());
  for (const row of page.rows) {
    const handle = directoryHandleFromChannelUrl((row.profile as Record<string, unknown> | undefined)?.channelUrl);
    const stats = handle ? statsByHandle.get(handle) : undefined;
    if (stats) row.channelStats = stats;
  }
  return {
    configured: true,
    rows: page.rows,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(page.truncated ? { truncated: true } : {}),
    ...(page.truncatedReason ? { truncatedReason: page.truncatedReason } : {}),
    generatedAtIso: page.generatedAtIso,
    behaviorLog: makeBehaviorLog(auth, "scp_admin_bridge.creators.list", "success"),
  };
}


// ---- 디렉터리 구독자 수 보강 (헤세 요청 26-08-27) ----------------------------------------------
//
// 승인 판단에 필요한 채널 규모를 목록에서 바로 보여준다. 조회는 비검색 쿼터(channels.list,
// 1유닛/콜)이고 24시간 캐시로 재조회를 누른다. **fail-open**: 보강 실패는 행을 지우거나 목록을
// 실패시키지 않는다 — stats 없는 행으로 그대로 나간다(승인 흐름이 조회 장애에 볼모잡히지 않게).
const DIRECTORY_STATS_CACHE_COLLECTION = "discovery_cache";
const DIRECTORY_STATS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function directoryHandleFromChannelUrl(channelUrl: unknown): string | null {
  const match = /youtube\.com\/@([^/?#]+)/i.exec(asString(channelUrl));
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

// Task-52 (적대적 리뷰 P2 정정): getAll은 Firestore의 "in" 쿼리가 아니라 배치 문서 조회
// (BatchGetDocuments)라 30개 상한이 없다 — 청크 크기 30은 순전히 청크당 동시 발사하는 YouTube
// channels.list 호출 수를 제한하기 위한 값이다(쿼터/레이트 폭주 방지 목적, Firestore 제약 아님).
const DIRECTORY_STATS_CHUNK_SIZE = 30;

function directoryStatsCacheId(handle: string): string {
  return `portal_dir_stats_${createHash("sha256").update(handle.toLowerCase()).digest("hex").slice(0, 40)}`;
}

export interface DirectoryStatsFirestoreLike {
  collection(name: string): {
    doc(id: string): DirectoryStatsDocRefLike;
  };
  getAll(...refs: DirectoryStatsDocRefLike[]): Promise<DirectoryStatsDocSnapshotLike[]>;
  batch(): {
    set(ref: DirectoryStatsDocRefLike, data: Record<string, unknown>): void;
    commit(): Promise<unknown>;
  };
}
export interface DirectoryStatsDocRefLike {
  get(): Promise<DirectoryStatsDocSnapshotLike>;
}
export interface DirectoryStatsDocSnapshotLike {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

// Task-52: previously N sequential `await`s per handle (cache get → possible YouTube call → cache
// set) — for a 100-handle page that is up to 100 round trips end to end, the dominant share of the
// observed 8~10s load. Now: batch-read the cache in chunks of 30 (one getAll round trip per chunk
// instead of 30 individual .get()s), resolve every cache miss in that chunk concurrently
// (Promise.all — YouTube's forHandle lookup only accepts one handle per call, so this is the
// available parallelism), then batch-write the refreshed cache entries in one commit. Chunks
// themselves stay sequential so a 500-handle aggregate page never fires >30 concurrent YouTube
// calls at once. fail-open throughout: any read/lookup/write failure skips enrichment for just the
// affected handle(s), never the whole response (unchanged from the prior per-handle try/catch).
export async function directoryChannelStatsByHandle(
  handles: readonly string[],
  now: Date,
  deps: { db?: DirectoryStatsFirestoreLike; youtubeApi?: YouTubeApiClient } = {},
): Promise<Map<string, { subscriberCount: number; channelTitle?: string; channelCountry?: string }>> {
  const out = new Map<string, { subscriberCount: number; channelTitle?: string; channelCountry?: string }>();
  if (!handles.length) return out;
  const db = deps.db ?? (adminDb as unknown as DirectoryStatsFirestoreLike);
  let api: YouTubeApiClient | undefined = deps.youtubeApi;
  let apiInitFailed = false;

  for (let start = 0; start < handles.length; start += DIRECTORY_STATS_CHUNK_SIZE) {
    const chunk = handles.slice(start, start + DIRECTORY_STATS_CHUNK_SIZE);
    const refs = chunk.map((handle) => db.collection(DIRECTORY_STATS_CACHE_COLLECTION).doc(directoryStatsCacheId(handle)));

    let cachedDocs: DirectoryStatsDocSnapshotLike[];
    try {
      cachedDocs = await db.getAll(...refs);
    } catch {
      cachedDocs = chunk.map(() => ({ exists: false, data: () => undefined }));
    }

    const misses: string[] = [];
    cachedDocs.forEach((doc, index) => {
      const handle = chunk[index];
      const data = doc.exists ? doc.data() : undefined;
      if (data && Date.parse(asString(data.fetchedAtIso)) > now.getTime() - DIRECTORY_STATS_CACHE_TTL_MS) {
        if (typeof data.subscriberCount === "number") {
          out.set(handle, {
            subscriberCount: data.subscriberCount,
            ...(asString(data.channelTitle) ? { channelTitle: asString(data.channelTitle) } : {}),
            ...(asString(data.channelCountry) ? { channelCountry: asString(data.channelCountry) } : {}),
          });
        }
        // 캐시된 "미해석"(subscriberCount 부재)도 TTL 동안 재조회하지 않는다.
        return;
      }
      misses.push(handle);
    });
    if (!misses.length) continue;

    // Task-52 (적대적 리뷰 P0): makeYouTubeDataApiClient()는 YOUTUBE_API_KEY 미설정 시 동기적으로
    // throw한다(functions/youtubeEnrichmentService.ts) — 원래 코드는 핸들별 try/catch 안에서 이
    // 호출까지 함께 감쌌지만, 청크 단위로 끌어올리며 try/catch 밖으로 새 나갔다(실측: 키 미설정
    // 시 listScpPortalCreatorsHandler 전체가 그대로 죽었다). 팩토리 실패는 이 청크의(그리고
    // apiInitFailed로 다시 시도하지 않으므로 이후 모든 청크의) 보강만 건너뛰고, 이미 캐시로 찾은
    // stats는 그대로 유지한다 — fail-open 계약 복원.
    if (!api && !apiInitFailed) {
      try {
        api = makeYouTubeDataApiClient();
      } catch {
        apiInitFailed = true;
      }
    }
    if (!api) continue;
    const resolvedApi = api;
    const lookups = await Promise.all(misses.map(async (handle) => {
      try {
        // Task-52 (적대적 리뷰 P1-1): 5페이지 순차 체인(최악 500핸들 ÷ 30 = 17청크) 예산 안에서
        // 한 핸들 조회가 무기한 매달리지 않게 4초 상한을 건다 — Cloud Function 자체 타임아웃은
        // functions/index.ts의 listScpPortalCreators에 120초로 명시(17청크 × 4초 ≈ 68초 + 브리지
        // 5페이지 여유를 더해도 120초 안에 들어온다).
        const response = await resolvedApi.channelsList({ part: "snippet,statistics", forHandle: handle }, { timeoutMs: 4000 });
        const item = (response.items ?? [])[0];
        const raw = Number(item?.statistics?.subscriberCount);
        const stats = item && Number.isFinite(raw)
          ? {
              subscriberCount: raw,
              ...(asString(item.snippet?.title) ? { channelTitle: asString(item.snippet?.title) } : {}),
              ...(asString(item.snippet?.country) ? { channelCountry: asString(item.snippet?.country) } : {}),
            }
          : null;
        return { handle, stats };
      } catch {
        return { handle, stats: null };
      }
    }));

    try {
      const batch = db.batch();
      for (const { handle, stats } of lookups) {
        if (stats) out.set(handle, stats);
        batch.set(db.collection(DIRECTORY_STATS_CACHE_COLLECTION).doc(directoryStatsCacheId(handle)), {
          kind: "portal_dir_stats",
          handle,
          ...(stats ?? {}),
          fetchedAtIso: now.toISOString(),
        });
      }
      await batch.commit();
    } catch {
      // 배치 커밋 실패 — 이번 조회 결과(out)는 이미 반영됐으니 응답엔 영향 없다. 다음 호출이 재시도.
    }
  }
  return out;
}

// ---- scpPortalCreatorCommand (P2: operator-attributed CAS command) -----------------------------

// W91 정정(적대적 리뷰 MEDIUM-2): 커맨드별 최소 역할. 포털 원래 creator.data-link 라우트는
// superadmin+manage_pii 였다 — Flu 도 admin/super_admin 만 허용해 방어심층을 맞춘다(manager 거부).
// 나머지 5개는 기존 OPERATOR_ROLES(manager+) 그대로.
const ELEVATED_ROLES: readonly Exclude<Role, "guest">[] = ["super_admin", "admin"];
const COMMAND_MIN_ROLES: ReadonlyMap<string, readonly Exclude<Role, "guest">[]> = new Map([
  ["application.start-review", OPERATOR_ROLES],
  ["application.approve", OPERATOR_ROLES],
  ["application.reject", OPERATOR_ROLES],
  ["creator.set-status", OPERATOR_ROLES],
  ["creator.set-notes", OPERATOR_ROLES],
  ["creator.data-link", ELEVATED_ROLES],
]);

// W91 정정(포털 구현 대조): params 는 커맨드별 **정확 키 집합**만 허용한다 — 여분 키가 있으면
// 포털이 invalid_body 로 거부한다. 호출부(UI)가 무엇을 보내든, 여기서 커맨드별 화이트리스트로
// 다시 지어서 보낸다(원문 그대로 전달하지 않는다) — 이 재구성이 유일한 방어선이다.
const STABLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROGRAM_ENROLLMENT_STATUSES: ReadonlySet<string> = new Set(["invited", "active", "paused", "ended"]);

// W91 정정(적대적 리뷰 LOW): 각 enrollment 필드 검증 실패마다 고유 errorCode 를 등록해 편집기가
// "무엇이 틀렸는지" 필드 힌트를 보여줄 수 있게 한다(callableErrorBoundary.CALLABLE_DETAIL_ERROR_CODES
// + src/lib/live.tsx PUBLIC_BUSINESS_ERROR_MESSAGES 에 짝을 등록 — 기존 mail_template_* 등록 패턴).
const ENROLLMENT_ERROR_CODES = {
  empty: "scp_admin_bridge_enrollment_empty",
  id: "scp_admin_bridge_enrollment_id_invalid",
  programId: "scp_admin_bridge_enrollment_program_id_invalid",
  guideReleaseId: "scp_admin_bridge_enrollment_guide_release_id_invalid",
  policyVersion: "scp_admin_bridge_enrollment_policy_version_invalid",
  status: "scp_admin_bridge_enrollment_status_invalid",
  validFrom: "scp_admin_bridge_enrollment_valid_from_invalid",
  validTo: "scp_admin_bridge_enrollment_valid_to_invalid",
  duplicatePair: "scp_admin_bridge_enrollment_duplicate_pair",
  duplicateActiveProgram: "scp_admin_bridge_enrollment_duplicate_active_program",
  defaultConflict: "scp_admin_bridge_enrollment_default_conflict",
  defaultRequiresActive: "scp_admin_bridge_enrollment_default_requires_active",
} as const;

type ProgramEnrollmentBody = {
  id: string;
  programId: string;
  guideReleaseId: string;
  policyVersion: string;
  status: "invited" | "active" | "paused" | "ended";
  validFrom: string;
  validTo?: string;
  isDefault?: true;
};

/**
 * 포털 정본 스키마(creator.data-link programEnrollments): id/programId/guideReleaseId/policyVersion
 * 은 전부 안정 식별자, status 는 4값 열거, validTo 는 validFrom 이후, (programId,id) 중복 금지,
 * active 상태 programId 중복 금지, isDefault 는 active 중 최대 1개.
 */
function validateProgramEnrollments(raw: unknown): ProgramEnrollmentBody[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalidArgument("programEnrollments must be a non-empty array", ENROLLMENT_ERROR_CODES.empty);
  }
  const enrollments: ProgramEnrollmentBody[] = raw.map((item, index) => {
    const record = asRecord(item);
    const id = asString(record.id);
    const programId = asString(record.programId);
    const guideReleaseId = asString(record.guideReleaseId);
    const policyVersion = asString(record.policyVersion);
    const status = asString(record.status);
    const validFrom = asString(record.validFrom);
    const validTo = asString(record.validTo) || undefined;
    const isDefault = record.isDefault === true;
    if (!STABLE_IDENTIFIER_PATTERN.test(id)) throw invalidArgument(`programEnrollments[${index}].id is invalid`, ENROLLMENT_ERROR_CODES.id);
    if (!STABLE_IDENTIFIER_PATTERN.test(programId)) throw invalidArgument(`programEnrollments[${index}].programId is invalid`, ENROLLMENT_ERROR_CODES.programId);
    if (!STABLE_IDENTIFIER_PATTERN.test(guideReleaseId)) throw invalidArgument(`programEnrollments[${index}].guideReleaseId is invalid`, ENROLLMENT_ERROR_CODES.guideReleaseId);
    if (!STABLE_IDENTIFIER_PATTERN.test(policyVersion)) throw invalidArgument(`programEnrollments[${index}].policyVersion is invalid`, ENROLLMENT_ERROR_CODES.policyVersion);
    if (!PROGRAM_ENROLLMENT_STATUSES.has(status)) throw invalidArgument(`programEnrollments[${index}].status is invalid`, ENROLLMENT_ERROR_CODES.status);
    if (!validFrom || Number.isNaN(Date.parse(validFrom))) throw invalidArgument(`programEnrollments[${index}].validFrom is required`, ENROLLMENT_ERROR_CODES.validFrom);
    if (validTo !== undefined && (Number.isNaN(Date.parse(validTo)) || Date.parse(validTo) <= Date.parse(validFrom))) {
      throw invalidArgument(`programEnrollments[${index}].validTo must be a valid date after validFrom`, ENROLLMENT_ERROR_CODES.validTo);
    }
    return {
      id,
      programId,
      guideReleaseId,
      policyVersion,
      status: status as ProgramEnrollmentBody["status"],
      validFrom,
      ...(validTo !== undefined ? { validTo } : {}),
      ...(isDefault ? { isDefault: true as const } : {}),
    };
  });
  const pairKeys = new Set<string>();
  const activeProgramIds = new Set<string>();
  let activeDefaultCount = 0;
  for (const enrollment of enrollments) {
    const pairKey = `${enrollment.programId}::${enrollment.id}`;
    if (pairKeys.has(pairKey)) throw invalidArgument("duplicate programEnrollments (programId,id) pair", ENROLLMENT_ERROR_CODES.duplicatePair);
    pairKeys.add(pairKey);
    if (enrollment.status === "active") {
      if (activeProgramIds.has(enrollment.programId)) throw invalidArgument("duplicate active programId in programEnrollments", ENROLLMENT_ERROR_CODES.duplicateActiveProgram);
      activeProgramIds.add(enrollment.programId);
      if (enrollment.isDefault) activeDefaultCount += 1;
    } else if (enrollment.isDefault) {
      throw invalidArgument("isDefault programEnrollment must be active", ENROLLMENT_ERROR_CODES.defaultRequiresActive);
    }
  }
  if (activeDefaultCount > 1) throw invalidArgument("at most one active programEnrollment can be isDefault", ENROLLMENT_ERROR_CODES.defaultConflict);
  return enrollments;
}

/** 커맨드별 정확 키 집합으로 params 를 다시 짓는다. 호출부 원문(raw)은 소스로만 쓰인다. */
function buildCommandParams(command: string, raw: Record<string, unknown>): Record<string, unknown> | undefined {
  switch (command) {
    case "application.start-review":
    case "application.approve":
      return undefined;
    case "application.reject": {
      const reasonCode = asString(raw.reasonCode);
      if (!reasonCode) throw invalidArgument("reasonCode is required");
      return { reasonCode };
    }
    case "creator.set-status": {
      const status = asString(raw.status);
      if (!status) throw invalidArgument("status is required");
      return { status };
    }
    case "creator.set-notes": {
      return { notes: asString(raw.notes) };
    }
    case "creator.data-link": {
      const fluCreatorId = asString(raw.fluCreatorId);
      const partnerId = asString(raw.partnerId);
      const programEnrollments = validateProgramEnrollments(raw.programEnrollments);
      return { fluCreatorId, partnerId, programEnrollments };
    }
    default:
      return undefined;
  }
}

// Portal error-code -> stable public mapping (assignApplicationManagementHandler's mapping pattern).
// Anything outside these two sets collapses to "internal" — never surfaces a raw/unmapped code.
const FAILED_PRECONDITION_BRIDGE_ERROR_CODES: ReadonlySet<string> = new Set([
  "stale_revision",
  "receipt_conflict",
  "application_workflow_required",
  "flu_creator_mapping_conflict",
]);
const PERMISSION_DENIED_BRIDGE_ERROR_CODES: ReadonlySet<string> = new Set([
  "superadmin_required",
  // W91 정정(포털측 적대적 리뷰): 포털 정본 코드는 program_scope_required 가 아니라 program_forbidden.
  "program_forbidden",
]);

// 포털 정본 마스킹 패턴: `^[^\s@]{0,2}\*\*\*@[^\s@]+\.[^\s@]+$` — 로컬파트 앞 0~2자 + "***" +
// "@" + 도메인(점 포함). 아래 두 상수 모두 이 패턴을 통과해야 한다.
const OPERATOR_EMAIL_MASK_PATTERN = /^[^\s@]{0,2}\*\*\*@[^\s@]+\.[^\s@]+$/;
const OPERATOR_EMAIL_UNKNOWN_FALLBACK = "un***@flu.internal";

/**
 * 로컬파트 첫 글자 + `***` + `@` + 도메인(포털 emailMasked 스타일). auth 클레임에 이메일이 없거나
 * 도메인에 점이 없어 포털 패턴을 통과하지 못하면 고정 폴백을 쓴다 — raw email 은 절대 브리지
 * 본문에 싣지 않는다.
 */
function maskFluOperatorEmail(email: string | undefined): string {
  const trimmed = (email ?? "").trim();
  const at = trimmed.indexOf("@");
  const local = at > 0 ? trimmed.slice(0, at) : "";
  const domain = at > 0 && at < trimmed.length - 1 ? trimmed.slice(at + 1) : "";
  if (!local || !domain) return OPERATOR_EMAIL_UNKNOWN_FALLBACK;
  const masked = `${local[0]}***@${domain}`;
  return OPERATOR_EMAIL_MASK_PATTERN.test(masked) ? masked : OPERATOR_EMAIL_UNKNOWN_FALLBACK;
}

// W91 정정(적대적 리뷰 MEDIUM-1): enqueue 가 조용히 유실되지 않도록 hash-only 감사만 남긴다
// (applicationId/eventId 는 이미 opaque 내부 id 라 PII 가 아니다 — raw 이메일 등은 절대 싣지 않는다).
// 재큐잉 스윕(이 컬렉션을 읽어 자동 재시도하는 것)은 이번 범위 밖이다 — 후속 작업.
const SCP_LOGIN_APPROVED_MAIL_ENQUEUE_FAILURES_COLLECTION = "scp_login_approved_mail_enqueue_failures";

function enqueueFailureCode(error: unknown): string {
  const code = asString((error as { code?: unknown } | null)?.code);
  return code || "unknown_error";
}

async function recordLoginApprovedMailEnqueueFailure(applicationId: string, eventId: string, error: unknown, now: Date): Promise<void> {
  try {
    await adminDb.collection(SCP_LOGIN_APPROVED_MAIL_ENQUEUE_FAILURES_COLLECTION).add({
      applicationId,
      eventId,
      code: enqueueFailureCode(error),
      atIso: now.toISOString(),
    });
  } catch (auditError) {
    console.warn("[scpPortalCreatorCommand] login_approved enqueue failure audit write failed", {
      applicationId,
      message: auditError instanceof Error ? auditError.message : String(auditError),
    });
  }
}

// W91 정정(적대적 리뷰 HIGH-①): 이미 delivered/sending/suppressed/dead_letter 인 기존 행을 재승인이
// 조용히 덮어써 재발송(또는 delivered 필드가 stale 상태로 남는 상황)을 만들지 않는다. 문서가 없거나
// 아직 queued 일 때만 쓴다 — 그 외 상태는 트랜잭션 안에서 아무것도 하지 않고 조용히 넘어간다
// (드레인이 이미 처리 중/처리 완료한 행을 이 경로가 되돌리면 안 된다).
// 불변 의존(재검증 리뷰 LOW): queued 재-set 이 row 의 attempts:0 을 다시 쓰는 게 안전한 이유는
// 이 컬렉션에서 deliveryState==="queued" && attempts>0 인 행을 만드는 코드 경로가 없기 때문이다
// (releaseClaim 은 클레임 전 상태 복원, reclaimStaleSendingOutboxRows 는 sending→retryable_failed 만).
// 드레인에 "queued 로 복귀" 경로를 새로 만들면 이 가정이 깨진다 — 그때는 attempts 보존으로 바꿀 것.
async function writeLoginApprovedMailOutboxIfSafe(
  applicationId: string,
  row: Record<string, unknown>,
): Promise<boolean> {
  const outboxRef = adminDb
    .collection(SCP_LOGIN_APPROVED_MAIL_OUTBOX_COLLECTION)
    .doc(loginApprovedMailOutboxDocId(applicationId));
  return adminDb.runTransaction(async (tx) => {
    const existing = await tx.get(outboxRef);
    if (existing.exists) {
      const state = asString(existing.data()?.deliveryState);
      if (state !== "queued") return false;
    }
    tx.set(outboxRef, row, { merge: true });
    return true;
  });
}

/**
 * 포털 승인 커맨드(applicationApproved v2) 계보의 login_approved 적재 (자동화 배선).
 *
 * 재료 키는 포털과 계약된 **결정적 파생**을 쓴다:
 *   sourceEventId = "req_" + sha256("login_approved_resend_" + applicationId).hex[0:32]
 * 포털의 정규 approve 플로우가 같은 식으로 영수증을 생성하므로, 어느 쪽이 먼저 실행돼도
 * material 회수가 같은 키에서 만난다. salt 의 "resend" 는 26-08-26 최초 발급(백필 재발송)
 * 맥락의 흔적이며, 기존 키 7건과의 재파생 일관성을 위해 문자열을 바꾸지 않고 계약화했다
 * (26-08-27, 어제 실키 7/7 대조로 확정).
 *
 * fire-and-forget: 실패는 커맨드 수락을 뒤집지 않고 hash-only 감사에만 남는다 — 기존
 * enqueueLoginApprovedMail 과 같은 계약이다.
 */
export function loginApprovedMaterialEventId(applicationId: string): string {
  return `req_${createHash("sha256").update(`login_approved_resend_${applicationId}`).digest("hex").slice(0, 32)}`;
}

export async function enqueueLoginApprovedMailFromApprovalCommand(
  applicationId: string,
  programId: string,
  now: Date,
): Promise<void> {
  const eventId = loginApprovedMaterialEventId(applicationId);
  try {
    const row = loginApprovedMailOutboxRow({
      applicationId,
      programId,
      eventId,
      sourceContract: "scp.flu.admin-bridge.v1",
      nowIso: now.toISOString(),
    });
    const wrote = await writeLoginApprovedMailOutboxIfSafe(applicationId, row);
    if (!wrote) {
      console.warn("[scpFluApplicationCommand] login_approved enqueue skipped: existing outbox row is past queued", { applicationId });
    }
  } catch (error) {
    console.warn("[scpFluApplicationCommand] login_approved enqueue failed", {
      applicationId,
      message: error instanceof Error ? error.message : String(error),
    });
    await recordLoginApprovedMailEnqueueFailure(applicationId, eventId, error, now);
  }
}

/**
 * `application.approve` 성공 시 login_approved 메일 outbox 를 적재한다. 문서 id 가 결정적
 * (`login_approved_<applicationId>`)이라 재시도해도 문서가 하나로 수렴한다. Portal 커맨드는 이미
 * 성공했으므로, 여기서 실패해도 커맨드 자체를 실패로 되돌리지 않는다(운영자에게 "승인 실패"로
 * 오도하지 않기 위함) — 대신 hash-only 감사 컬렉션에 남긴다(위 recordLoginApprovedMailEnqueueFailure).
 */
async function enqueueLoginApprovedMail(applicationId: string, now: Date): Promise<void> {
  // 계약 정정(26-08-27, 포털 검수): material 의 sourceEventId 는 커맨드의 attempt-scoped
  // eventId 를 echo 하지 않고 **결정적 파생식**으로 계산한다. 포털 정규 approve 가 승인
  // 트랜잭션 안에서 같은 파생 id 로 provenance 영수증을 민팅하므로, 어느 쪽 승인이든 회수가
  // 같은 키에서 만난다. (커맨드 idempotency 키는 계속 attempt-scoped 랜덤 — 재사용하면 포털
  // 영수증과 충돌해 "approve 성공인데 409" 사고가 난다.)
  const eventId = loginApprovedMaterialEventId(applicationId);
  const snapshot = await adminDb.collection(SCP_APPLICATION_MANAGEMENT_COLLECTION).doc(applicationId).get();
  if (!snapshot.exists) {
    console.warn("[scpPortalCreatorCommand] login_approved enqueue skipped: no application-management record", { applicationId });
    return;
  }
  const record = asRecord(snapshot.data());
  const identity = asRecord(record.identity);
  // 26-08-27 실사고 수리: material 요청의 programId 는 **포털 네임스페이스**(identity.programId,
  // 지원 커맨드가 실어온 값 — 예: view-cpm)여야 한다. 포털 게이트가 application.programId 와
  // 바이트 등가 비교하므로 flu 내부 프로그램 id(currentProgramId, pg-…)를 앞세우면 403 —
  // flu 매핑이 잡힌 지원자만 조용히 영구 스톨했다(승인 10건·반려 1건 실측, 데이터 수리로 해소).
  const programId = asString(identity.programId) || asString(record.currentProgramId);
  if (!programId) {
    console.warn("[scpPortalCreatorCommand] login_approved enqueue skipped: no program id", { applicationId });
    return;
  }
  const nowIso = now.toISOString();
  const row = loginApprovedMailOutboxRow({
    applicationId,
    programId,
    eventId,
    sourceContract: "scp.flu.admin-bridge.v1",
    nowIso,
    ...(asString(identity.portalCreatorId) ? { portalCreatorId: asString(identity.portalCreatorId) } : {}),
    ...(asString(identity.fluCreatorId) ? { fluCreatorId: asString(identity.fluCreatorId) } : {}),
  });
  const wrote = await writeLoginApprovedMailOutboxIfSafe(applicationId, row);
  if (!wrote) {
    console.warn("[scpPortalCreatorCommand] login_approved enqueue skipped: existing outbox row is past queued", { applicationId });
  }
}

/**
 * `application.reject` 성공 시(메일 대상 사유 2종만) login_rejected 메일 outbox 를 적재한다.
 * enqueueLoginApprovedMail 의 대칭 — 결정적 docId(`login_rejected_<applicationId>`)라 재반려가
 * 몇 번 와도 문서 하나로 수렴하고(1반려 1통), delivered 이후 상태는 writeIfSafe 가 덮지 않는다.
 * fire-and-forget: 실패는 커맨드 수락을 뒤집지 않고 hash-only 감사에만 남는다.
 *
 * 포털은 reasonCode 를 검증 후 버린다(포털 실측 26-08-27) — 사유와 판단 근거(구독자 미달 반려
 * 시점의 subscriberCount)의 기록 정본이 이 행이다.
 */
export async function enqueueLoginRejectedMail(
  applicationId: string,
  reasonCode: LoginRejectedMailReasonCode,
  subscriberCountAtRejection: number | undefined,
  now: Date,
  options: { publicReasonText?: string; sourceEventId?: string; sourceContract?: string } = {},
): Promise<void> {
  const snapshot = await adminDb.collection(SCP_APPLICATION_MANAGEMENT_COLLECTION).doc(applicationId).get();
  if (!snapshot.exists) {
    console.warn("[scpPortalCreatorCommand] login_rejected enqueue skipped: no application-management record", { applicationId });
    return;
  }
  const record = asRecord(snapshot.data());
  const identity = asRecord(record.identity);
  // 26-08-27 실사고 수리: material 요청의 programId 는 **포털 네임스페이스**(identity.programId,
  // 지원 커맨드가 실어온 값 — 예: view-cpm)여야 한다. 포털 게이트가 application.programId 와
  // 바이트 등가 비교하므로 flu 내부 프로그램 id(currentProgramId, pg-…)를 앞세우면 403 —
  // flu 매핑이 잡힌 지원자만 조용히 영구 스톨했다(승인 10건·반려 1건 실측, 데이터 수리로 해소).
  const programId = asString(identity.programId) || asString(record.currentProgramId);
  if (!programId) {
    console.warn("[scpPortalCreatorCommand] login_rejected enqueue skipped: no program id", { applicationId });
    return;
  }
  const outcome = await enqueueLoginRejectedMailOutbox({
    applicationId,
    programId,
    reasonCode,
    sourceContract: options.sourceContract ?? "scp.flu.admin-bridge.v1",
    nowIso: now.toISOString(),
    ...(options.sourceEventId ? { sourceEventId: options.sourceEventId } : {}),
    ...(options.publicReasonText ? { publicReasonText: options.publicReasonText } : {}),
    ...(subscriberCountAtRejection !== undefined ? { subscriberCountAtRejection } : {}),
    ...(asString(identity.portalCreatorId) ? { portalCreatorId: asString(identity.portalCreatorId) } : {}),
    ...(asString(identity.fluCreatorId) ? { fluCreatorId: asString(identity.fluCreatorId) } : {}),
  });
  if (!outcome.wrote) {
    await recordLoginRejectedMailOutboxSlotOccupied({
      applicationId,
      reasonCode,
      existingDeliveryState: outcome.existingDeliveryState,
      now,
      source: "scp_admin_bridge",
    });
  }
}

/** 반려 시점 UI 가 보던 구독자 수(감사 증거). 음이 아닌 안전 정수만 인정, 그 외엔 미저장. */
function rejectSubscriberCountEvidence(raw: Record<string, unknown>): number | undefined {
  const value = Number(raw.subscriberCount);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export async function scpPortalCreatorCommandHandler(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "scp_admin_bridge.creator_command", OPERATOR_ROLES);
  await assertScpEntitled(auth, request, "scp_admin_bridge.creator_command");
  const data = asRecord(request.data);
  const command = asString(data.command);
  const targetId = asString(data.targetId);
  const allowedRoles = COMMAND_MIN_ROLES.get(command);
  if (!allowedRoles) throw invalidArgument("command is not recognized");
  // W91 정정(MEDIUM-2): 커맨드별 최소 역할. creator.data-link 는 admin/super_admin 만 — manager 는
  // 여기서 permission-denied 로 거부된다(방어심층, 포털 원래 라우트의 superadmin+manage_pii 요건).
  if (!allowedRoles.includes(auth.role)) {
    throw Object.assign(new Error(`permission-denied: ${command} requires an elevated role`), {
      code: "permission-denied",
      errorCode: "scp_admin_bridge_command_role_forbidden",
    });
  }
  if (!targetId) throw invalidArgument("targetId is required");

  let expectedRevision: number | undefined;
  if (data.expectedRevision !== undefined) {
    expectedRevision = integerField(data.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw invalidArgument("expectedRevision must be a non-negative integer");
    }
  }
  const expectedUpdatedAt = asString(data.expectedUpdatedAt) || undefined;
  const params = buildCommandParams(command, asRecord(data.params));

  const operator = {
    fluUid: auth.userId,
    role: auth.role,
    emailMasked: maskFluOperatorEmail(auth.email),
  };

  const outcome = await sendScpAdminBridgeCreatorCommand({
    operator,
    command,
    targetId,
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
    ...(params ? { params } : {}),
  });

  if (!outcome) {
    // Transport failure or envelope drift — never distinguishable from here, always fail-closed.
    throw Object.assign(new Error("internal: admin bridge command transport failed"), {
      code: "internal",
      errorCode: "scp_admin_bridge_command_unavailable",
    });
  }

  if (!outcome.ok) {
    // W91 하드 룰: 로그에는 code/command/targetId 만 — params 원문은 절대 남기지 않는다.
    console.warn("[scpPortalCreatorCommand] rejected", { code: outcome.error, command, targetId });
    if (FAILED_PRECONDITION_BRIDGE_ERROR_CODES.has(outcome.error)) {
      throw Object.assign(new Error(`failed-precondition: ${outcome.error}`), { code: "failed-precondition", errorCode: outcome.error });
    }
    if (PERMISSION_DENIED_BRIDGE_ERROR_CODES.has(outcome.error)) {
      throw Object.assign(new Error(`permission-denied: ${outcome.error}`), { code: "permission-denied", errorCode: outcome.error });
    }
    throw Object.assign(new Error("internal: admin bridge command rejected"), { code: "internal", errorCode: "scp_admin_bridge_command_rejected" });
  }

  if (command === "application.approve") {
    try {
      await enqueueLoginApprovedMail(targetId, new Date());
    } catch (error) {
      console.warn("[scpPortalCreatorCommand] login_approved enqueue failed", {
        command,
        targetId,
        message: error instanceof Error ? error.message : String(error),
      });
      await recordLoginApprovedMailEnqueueFailure(targetId, loginApprovedMaterialEventId(targetId), error, new Date());
    }
  }

  // 반려 안내 메일(헤세 확정 카피 2종, 26-08-27): 메일 대상 사유일 때만 적재한다 — not_eligible
  // (기타)은 종전대로 메일 없이 반려만 된다. 포털측 admin 반려는 flu 로 커맨드가 오지 않으므로
  // (포털 실측 26-08-27, applicationRejected 아웃바운드 없음) 이 훅이 유일한 트리거다 —
  // 포털 화면에서 반려하면 메일이 나가지 않는다(알려진 갭, 운영 흐름은 flu 화면 반려).
  // Task-35 수리: not_eligible 도 isLoginRejectedMailReasonCode 에 들어 있어(94ee6624) 이 게이트만
  // 으론 "메일 없음"이 보장되지 않는다 — 공개 문구 없이 enqueue 하면 드레인이 즉시 dead_letter 하고,
  // 결정적 docId 라 이후 Portal 정식 반려가 와도 점유된 슬롯을 되찾지 못해 정식 메일이 영구 누락된다.
  if (command === "application.reject") {
    // 메일 게이트의 reasonCode 는 buildCommandParams 가 만든 정본(포털로 나간 그 값)을 재사용한다 —
    // 별도 파싱하면 훗날 정규화 로직이 생겼을 때 두 값이 소리 없이 갈린다. 판단 근거(subscriberCount)는
    // buildCommandParams 가 걸러내 브리지로 나가지 않으므로 원문 params 에서만 읽어 감사에 남긴다.
    const rawParams = asRecord(data.params);
    const reasonCode = asString(params?.reasonCode);
    if (isLoginRejectedMailReasonCode(reasonCode)) {
      const publicMessage = asString(rawParams.publicMessage);
      // not_eligible("기타")은 Flu 화면에 문구 입력 계약이 없으면 진짜 "메일 없음" 사유다.
      const canSendMail = reasonCode !== "not_eligible" || Boolean(publicMessage);
      if (canSendMail) {
        try {
          await enqueueLoginRejectedMail(
            targetId,
            reasonCode,
            rejectSubscriberCountEvidence(rawParams),
            new Date(),
            publicMessage ? { publicReasonText: publicMessage } : {},
          );
        } catch (error) {
          console.warn("[scpPortalCreatorCommand] login_rejected enqueue failed", {
            command,
            targetId,
            message: error instanceof Error ? error.message : String(error),
          });
          await recordLoginRejectedMailEnqueueFailure({
            applicationId: targetId,
            reasonCode,
            error,
            now: new Date(),
            source: "scp_admin_bridge",
          });
        }
      }
    }
  }

  return {
    result: outcome.result,
    behaviorLog: makeBehaviorLog(auth, "scp_admin_bridge.creator_command", "success"),
  };
}
