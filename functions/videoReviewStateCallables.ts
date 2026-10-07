// Operator read surface for the canonical v3 review states (G005 joint-E2E gate).
// The canonical `scp_video_review_state` ledger (written by scpVideoRevisionIngress and
// videoReviewTransitionStore) previously had NO operator read path, so the production UI could not
// drive the canonical transition command. This callable lists bounded, PII-free state rows for the
// /flu/review canonical panel; decisions still flow ONLY through transitionVideoReviewDecision.
// RBAC: manager+ server-side. No raw PII returned (subject carries opaque ids only by contract).

import { createHash } from "node:crypto";
import {
  asRecord,
  assertNonGuestAuth,
  makeBehaviorLog,
  maskEmail,
  type CallableRequestShape,
  type Role,
} from "./shared";
import { adminDb } from "./firebaseAdmin";
import { resolveVideoTitleProjection } from "./videoTitleProjection";
import {
  creatorProfileImageSourceInputs,
  resolveCreatorDisplayIdentity,
  resolveProfileImageProjection,
} from "./managementProfileTabsReadModels";
import {
  SCP_VIDEO_DOWNSTREAM_CALLBACK_OUTBOX_COLLECTION,
  SCP_VIDEO_RESULT_MAIL_OUTBOX_COLLECTION,
  SCP_VIDEO_REVIEW_CALLBACK_OUTBOX_COLLECTION,
  SCP_VIDEO_REVIEW_STATE_COLLECTION,
} from "./videoReviewTransitionStore";
import {
  PORTAL_SUBMISSION_PROJECTION_COLLECTION,
  portalSubmissionProjectionDocumentId,
} from "./scpPortalSubmissionIngress";
import { resolveCreatorCountryProjection } from "./creatorCountryProjection";
import { SCP_PARTNER_ACTIVATIONS_COLLECTION } from "./partnerActivationStore";
import { partnerActivationId } from "./partnerActivationCore";
import { SCP_VIDEO_REVISION_INGRESS_RECEIPTS_COLLECTION } from "./scpVideoRevisionIngress";
import { isOperationalFixtureRecord } from "./operationalFixtureProvenance";
import { assertScpEntitled, isCallerScpEntitled } from "./mailAccounts";
import {
  makeYouTubeDataApiClient,
  type YouTubeApiClient,
} from "./youtubeEnrichmentService";
import { fetchVideoStatsBatch } from "./videoViewSnapshots";
import {
  prepareVideoResultMailPreview,
  type RecipientResolver,
} from "./scpOutboxMailWorkers";
import type { VideoReviewMailKind } from "./videoReviewTransitionCore";
import { videoReviewRuleById, videoReviewRuleTagPhrase } from "./videoReviewCriteria";
// 2026-09-05 다타이틀: 검수 큐가 어느 게임 타이틀의 제출인지 밝힌다. 이름은 **레지스트리에서만**
// 온다 — 이 파일에는 게임명 리터럴이 하나도 없다(타이틀 추가 = programTitles.seed.json 항목 1개).
import { requiredHashtagsForTitle, resolveProgramTitle, type ProgramTitleRegistry } from "./programTitles";
import { loadProgramTitleRegistry } from "./programTitlesStore";
import { resolveSubjectGameId, resolveVideoReviewGameFilterIdentity } from "./videoReviewGameFilter";
import { canonicalScpProgramId, scpProgramIdentitySet } from "./scpProgramAlias";
import { resolveCanonicalProgramId } from "./programCanonical";
import {
  createApplicationProgramIdLookup,
  isReviewStatePortalAliasProgramId,
  REVIEW_STATE_PORTAL_PROGRAM_ALIAS_IDS,
  resolveReviewStateProgramId,
} from "./reviewStateProgramResolution";
// W121 [적대 리뷰 M6]: 미리보기와 확정이 **같은 검증기**를 공유한다(정책 갈림 금지).
import { parseVideoReviewReasonTagKeys } from "./videoReviewTransitionCallables";
import {
  currentHeadDecisionRef,
  mergeDeclineReasonCounts,
  summarizeVideoReviewLedger,
  topRepeatedReason,
} from "./videoReviewHistorySummary";
// W123: 반복 조회 캐시. 정책(키·TTL·계측)은 전부 그 모듈에 있고 여기서는 얇게 부르기만 한다.
import {
  cachedRelatedReviewHistory,
  cachedReviewVideoSignals,
  type ReviewCacheAuthScope,
} from "./videoReviewSignalCache";
// Task-53: 배지(9개 count() 집계)·포털 별칭 스플라이스 스캔(최대 1000건) 캐시. 정책은 그 모듈에
// 있고(TTL·무효화 근거), 여기서는 얇게 부르기만 한다(videoReviewSignalCache.ts 와 같은 규율).
import { cachedPortalAliasSpliceSnapshot, cachedReviewQueueCounts } from "./reviewQueueCountsCache";

const OPERATOR_ROLES: readonly Exclude<Role, "guest">[] = [
  "super_admin",
  "admin",
  "manager",
];
const CREATORS_COLLECTION = "creators";
// creators 에서 채널 id 를 담을 수 있는 필드들. 운영 문서마다 이름이 갈려 있어 둘 다 본다.
const CREATOR_CHANNEL_ID_FIELDS = ["channelId", "youtubeChannelId"] as const;
// Firestore `in` 절 상한(30) 과, 한 응답에서 시도할 최대 채널 수.
const CREATOR_CHANNEL_LOOKUP_CHUNK = 30;
const CREATOR_CHANNEL_LOOKUP_CAP = 120;
const CAMPAIGNS_COLLECTION = "campaigns";
const PROGRAMS_COLLECTION = "programs";
const PROGRAM_APPLICATIONS_COLLECTION = "program_applications";
const MAX_PAGE_SIZE = 50;
const MAX_LEDGER_ROWS = 20;
/**
 * W7-1c-fix: bounded scan of Portal-apply-gate-tagged (`view-cpm`) rows when splicing a
 * program-filtered list's first page. Prod measured 229 such rows system-wide (2026-09-05); this
 * cap is generous headroom until the backfill (scripts/backfill-review-state-program.mjs) and the
 * write-path fix (functions/reviewStateProgramResolution.ts) shrink that count toward zero.
 */
const PORTAL_ALIAS_PROGRAM_SPLICE_SCAN_CAP = 1000;
// 다타이틀 서버 필터(task-88/89/90): titleId 필터는 `where` 절이 아니라 커서 순서를 따라가는
// 유계 스캔으로 구현한다. gameId 는 subject.gameId(포털 인그레스 자리)와 최상위 gameId(레거시)
// 두 곳에 있고, 없거나 미등록이면 기본 타이틀로 착지한다 — "필드 없음 OR 미등록 OR 일치"는
// Firestore 술어로 표현할 수 없다(실측 2026-09-05: 원장 221건 중 gameId 보유 0건 → where 절은
// 전부 빈 결과가 된다). 새 where 절을 안 쓰므로 신규 복합 인덱스도 필요 없다. 요청당 최대
// TITLE_FILTER_SCAN_CAP 건만 읽고, nextCursor 는 마지막으로 **평가한** 문서를 가리킨다 —
// "추가 불러오기"가 스캔을 이어 받아 첫 페이지 너머까지 닿고, 전체 컬렉션 스캔은 하지 않는다.
const TITLE_FILTER_SCAN_CHUNK = 100;
const TITLE_FILTER_SCAN_CAP = 500;
const MAX_CLUSTER_MEMBERS = 10;
// W121: 사유 태그 후보 상한. 룰 카탈로그는 24개고 human_only 룰은 대부분 unknown 으로 남으므로,
// 상한이 없으면 칩이 화면을 덮어 정작 확정 실패 룰이 묻힌다(메일 상한은 별도로 5개다).
const MAX_REASON_TAG_CANDIDATES = 12;
// W120: 상세 진입 시에만 도는 이력 조회 상한. 단일 필드 동등 조건만 쓴다(복합 인덱스 요구 금지) —
// videoViewSnapshots 의 youtubeVideoId 조회와 같은 규율이다.
const RELATED_VIDEO_SCAN_LIMIT = 5;
const CREATOR_HISTORY_SCAN_LIMIT = 50;
/**
 * W123: `relatedHistory` 1회가 읽는 문서 수의 상한(두 쿼리의 상한 합 — 아래 loadRelatedReviewHistory).
 * 캐시 히트 1건이 아낀 읽기의 **상한**을 로그에 남기는 데 쓴다. 상한을 상수에서 유도하므로
 * 쿼리 상한이 바뀌면 로그도 같이 바뀐다(값이 드리프트하지 않는다).
 */
const RELATED_HISTORY_MAX_READS = (RELATED_VIDEO_SCAN_LIMIT + 2) + (CREATOR_HISTORY_SCAN_LIMIT + 1);

/**
 * W7-1c-fix (2026-09-06): the confirmed read-identity set for a review-tab program filter —
 * the SAME scope `reviewQueueCounts` and `listScpVideoReviewStatesHandler` must both query, or
 * the badge (count) and the list disagree (2026-09-05 deep-check Q6: badge "전체 1" vs list
 * "0건 표시" on the same screen). Mirrors `programQueryIds()` in scpProgramFunnelAggregate.ts —
 * SCP's legacy alias ("scp") and canonical id ("pg-super-creator-partners") are the one
 * confirmed alias pair in this system today; any other programId is its own sole identity.
 * Deliberately excludes the Portal apply-gate tag (view-cpm) — that tag is not an identity of
 * ANY one program (it is shared by every portal-origin row), so it must never enter an `in`
 * scope naively; unresolved view-cpm rows are recovered separately (see the portal-alias splice
 * in listScpVideoReviewStatesHandler and the honest `countsIncludeUnresolved` flag below).
 * 적대 리뷰 2026-09-11 [LOW]: 이 판정 자체는 scpProgramAlias.ts 의 `scpProgramIdentitySet` 이
 * 유일한 출처다 — reviewQueueCountsCache.ts 의 무효화 스코프도 같은 함수를 쓴다(판정 fork 금지).
 */
function reviewStateIdentityProgramIds(programId: string): readonly string[] {
  return scpProgramIdentitySet(programId);
}

/**
 * 상태별 서버 총계(.count() 집계). 화면 큐 배지의 정본이다 — 첫 페이지 reduce 로 대체하면
 * 실측처럼 승인 124건이 14건으로 보인다(2026-09-05 감사 F1).
 *
 * ⚠️ 알려진 오차 두 가지:
 * 1. 이 집계는 목록이 걸러 내는 시드/픽스처 문서(`isOperationalFixtureRecord`)를 **포함한다**.
 *    컬렉션 스캔 없이 그 술어를 쿼리로 내릴 수 없고(필드 하나로 표현되지 않는다), 오차 방향은
 *    "실제보다 조금 많게"라 백로그를 과소평가하지 않는다. 프로드 실측(221건)에서는 픽스처가
 *    없어 오차가 0이었다.
 * 2. programId 필터가 있을 때, `canonicalProgramId` 가 아직 포털 전역 태그(view-cpm)로 남아
 *    실 프로그램으로 해석되지 않은 행은 **집계에서 빠진다** — count() 집계는 목록처럼 행을
 *    읽어 리졸버로 조인할 수 없다(F-7/W7-1c). `scripts/backfill-review-state-program.mjs` 백필
 *    전까지는 하한이다. `countsIncludeUnresolved: false` 로 이 사실을 명시한다.
 */
async function reviewQueueCounts(programId = "", campaignId = "") {
  let query: FirebaseFirestore.Query = adminDb.collection(SCP_VIDEO_REVIEW_STATE_COLLECTION);
  const identityProgramIds = programId ? reviewStateIdentityProgramIds(programId) : [];
  if (identityProgramIds.length === 1) {
    query = query.where("canonicalProgramId", "==", identityProgramIds[0]);
  } else if (identityProgramIds.length > 1) {
    query = query.where("canonicalProgramId", "in", identityProgramIds);
  }
  if (campaignId) query = query.where("subject.campaignId", "==", campaignId);
  // W102: rejected 를 상태 배지에 합류 — 반려가 카운트 어디에도 안 잡혀 "반려하면 사라진다"는
  // 체감을 키웠다. 데이터는 원래부터 보존돼 있었고, 세는 축이 없었을 뿐이다.
  const states = ["queued", "in_review", "human_review_required", "pending", "needs_review", "changes_requested", "approved", "rejected"];
  const [all, ...counts] = await Promise.all([
    query.count().get(),
    ...states.map((state) => query.where("state", "==", state).count().get()),
  ]);
  return {
    action: counts.slice(0, 5).reduce((sum, snapshot) => sum + snapshot.data().count, 0),
    changes_requested: counts[5].data().count,
    approved: counts[6].data().count,
    rejected: counts[7].data().count,
    all: all.data().count,
    countsIncludeUnresolved: identityProgramIds.length === 0,
  };
}

/**
 * 이 요청 범위의 타이틀 레지스트리. 요청당 1회만 해석한다(programTitlesStore 가 60초 캐시).
 *
 * 검수 원장의 `canonicalProgramId` 는 오늘 실데이터에서 `view-cpm` 같은 **트랙 id** 라 레지스트리
 * 키와 맞지 않는다(실측 2026-09-05: 221건 중 219건이 `view-cpm`). 그때는 루브릭
 * (videoReviewCriteria.videoReviewRubricTitle)과 **같은 폴백**인 SCP 프로그램 레지스트리를 쓴다 —
 * 타이틀별 분기가 아니라 "프로그램 미등록"에 대한 단일 폴백이다.
 */
async function reviewTitleRegistry(programId: string): Promise<ProgramTitleRegistry> {
  const scoped = await loadProgramTitleRegistry(programId);
  if (scoped.titles.length > 0) return scoped;
  return loadProgramTitleRegistry(canonicalScpProgramId);
}

/** 행에 실을 타이틀 배지. 미등록·누락 gameId 는 프로그램 기본 타이틀로 착지한다. */
function reviewRowTitle(
  registry: ProgramTitleRegistry,
  gameId: string,
): { id: string; name: string; storeUrl: string; requiredHashtag: string; requiredHashtags: string[]; driveFolderUrl?: string; guidebookUrl?: string; default?: boolean } | null {
  const title = resolveProgramTitle(registry, gameId);
  return title
    ? {
      id: title.id,
      name: title.name,
      storeUrl: title.storeUrl,
      requiredHashtag: title.requiredHashtag,
      requiredHashtags: requiredHashtagsForTitle(registry, title),
      driveFolderUrl: title.driveFolderUrl,
      ...(title.guidebookUrl ? { guidebookUrl: title.guidebookUrl } : {}),
      ...(title.default === true ? { default: true } : {}),
    }
    : null;
}

/**
 * titleId 필터 술어 — 행 수준 **명시 증거만** 본다(functions/videoReviewGameFilter.ts).
 * state 문서를 있는 그대로 넘긴다: 최상위 `gameId`·game/app/title 별칭과 중첩 `subject.gameId`
 * 가 같은 claim 집합으로 해석되고, subject 와 최상위가 다른 타이틀을 가리키면 헬퍼가 conflict
 * → unknown 으로 본다(끌어올려 덮어쓰면 충돌이 숨는다). strict 전환(task-88/89/90)으로
 * `resolveProgramTitle` 의 기본 타이틀 착지는 폐기됐다 — 명시 증거가 없거나 충돌하는 행은
 * 기본 타이틀 필터에도 걸리지 않는다. 인제스트가 기본 타이틀로 채운 스탬프(`gameIdUnresolved`
 * /`gameIdDefaulted` 마커가 붙은 gameId)도 증거가 아니라 채우기 값이라 claim 집합에서 제외된다 —
 * 선언 없는 행이 기본 타이틀 버킷에 조용히 들어가지 않는다. 레지스트리는 요청 범위에서 이미 해석된 것을 override 로
 * 그대로 주입한다 — 행의 canonicalProgramId 는 view-cpm 같은 트랙 id 라 레지스트리 키로 못
 * 쓴다(190행 부근 주석과 같은 이유).
 */
function reviewStateDocMatchesTitleId(
  registry: ProgramTitleRegistry,
  state: Record<string, unknown>,
  titleId: string,
): boolean {
  const identity = resolveVideoReviewGameFilterIdentity(state, registry.programId, registry);
  return identity.status === "resolved" && identity.gameId === titleId;
}

type MailPreviewTarget = "approved" | "changes_requested" | "rejected";

function mailKindForPreviewTarget(
  value: string,
): VideoReviewMailKind | null {
  if (value === "approved") return "content_approved";
  if (value === "changes_requested") return "content_changes_requested";
  if (value === "rejected") return "content_rejected";
  return null;
}

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), {
    code: "invalid-argument", errorCode: "invalid_argument_unauthorized",
  });
}

function text(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function integerField(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) ? n : NaN;
}


function bool(value: unknown): boolean {
  return value === true;
}

function numberOrNull(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function httpsUrl(value: unknown, max = 1_000): string {
  const raw = text(value, max);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" ? raw : "";
  } catch {
    return "";
  }
}

function iso(value: unknown): string {
  const raw = text(value, 80);
  if (!raw) return "";
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
}

/** Exact ingress producer identity: `evt:${sha256(eventId).slice(0, 48)}`. */
export function ingressReceiptDocumentId(eventId: string): string {
  return `evt:${createHash("sha256").update(eventId, "utf8").digest("hex").slice(0, 48)}`;
}

/** Exact transition-store identity shared by all three review outboxes. */
export function reviewOutboxDocumentId(
  submissionId: string,
  transitionSeq: number,
): string | null {
  if (!Number.isInteger(transitionSeq) || transitionSeq <= 0) return null;
  const safe = submissionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180);
  return safe ? `${safe}__${transitionSeq}` : null;
}

function reviewDocId(submissionId: string): string {
  const safe = submissionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180);
  return safe || submissionId.slice(0, 180);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pickRecord(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> | null {
  const source = record(value);
  const out = Object.fromEntries(
    fields.flatMap((field) =>
      source[field] === undefined ? [] : [[field, source[field]]],
    ),
  );
  return Object.keys(out).length > 0 ? out : null;
}

/** 실제 YouTube 채널 id 형태만 링크로 만든다. `unclassified:channel:…` 같은 센티널은 제외. */
export function youtubeChannelUrl(channelId: unknown): string | null {
  const id = text(channelId, 64);
  return /^UC[A-Za-z0-9_-]{22}$/.test(id) ? `https://www.youtube.com/channel/${id}` : null;
}

type ReviewVideoApi = Pick<YouTubeApiClient, "videosList">;

export type ReviewVideoMetadata = {
  readonly title?: string;
  readonly channel?: string;
  readonly channelId?: string;
  readonly metricsSyncedAtIso: string;
};

/**
 * W120: 링크 가용성. 종전에는 화면의 썸네일 404(`onError`)만이 "영상 확인 불가" 신호였다 —
 * 브라우저까지 가야 알 수 있으니 큐 필터로 못 쓰고, 필터가 없으니 실데이터 반려 1위 유형이
 * 대기열에 섞여 있었다.
 *
 * 새 외부 호출을 만들지 않는다. 이 목록은 이미 매 페이지 `videos.list` 를 부르고 있고
 * (fetchVideoStatsBatch), 그 응답은 **응답에 없는 id = 비공개·삭제**를 이미 구분한다. 지금까지는
 * 그 사실을 버리고 있었을 뿐이다. 청크가 통째로 실패한 id 는 `unknown` 으로 남긴다 —
 * API 장애를 "영상 없음"으로 단정하면 멀쩡한 제출이 반려 후보로 올라간다.
 *
 * 호출은 Functions 안에서만 일어난다(NET-P0-012: 클라이언트 직접 외부 호출 금지).
 */
export type ReviewVideoAvailability = "available" | "unavailable" | "unknown";

export async function fetchReviewVideoSignals(
  api: ReviewVideoApi,
  videoIds: readonly string[],
  observedAtIso: string,
): Promise<{
  metadata: Map<string, ReviewVideoMetadata>;
  availability: Map<string, ReviewVideoAvailability>;
}> {
  const { stats, chunkFailures } = await fetchVideoStatsBatch(api, videoIds);
  const unknownIds = new Set(chunkFailures.flatMap((failure) => failure.videoIds));
  const availability = new Map<string, ReviewVideoAvailability>();
  for (const videoId of new Set(videoIds)) {
    if (!videoId) continue;
    availability.set(
      videoId,
      stats.has(videoId)
        ? "available"
        : unknownIds.has(videoId)
          ? "unknown"
          : "unavailable",
    );
  }
  return { metadata: reviewVideoMetadataFromStats(stats, observedAtIso), availability };
}

/** 검수 목록용 YouTube 메타데이터. videos.list 배치 응답에서 제목과 채널을 함께 읽는다. */
export async function fetchReviewVideoMetadata(
  api: ReviewVideoApi,
  videoIds: readonly string[],
  observedAtIso: string,
): Promise<Map<string, ReviewVideoMetadata>> {
  const { stats } = await fetchVideoStatsBatch(api, videoIds);
  return reviewVideoMetadataFromStats(stats, observedAtIso);
}

function reviewVideoMetadataFromStats(
  stats: Map<string, { title?: string; channelTitle?: string; channelId?: string }>,
  observedAtIso: string,
): Map<string, ReviewVideoMetadata> {
  const syncedAtIso = iso(observedAtIso) || new Date().toISOString();
  const metadata = new Map<string, ReviewVideoMetadata>();
  for (const [videoId, stat] of stats) {
    const title = text(stat.title, 200);
    const channel = text(stat.channelTitle, 80);
    const channelId = youtubeChannelUrl(stat.channelId)
      ? text(stat.channelId, 64)
      : "";
    if (!title && !channel && !channelId) continue;
    metadata.set(videoId, {
      ...(title ? { title } : {}),
      ...(channel ? { channel } : {}),
      ...(channelId ? { channelId } : {}),
      metricsSyncedAtIso: syncedAtIso,
    });
  }
  return metadata;
}

export function creatorProjection(
  value: unknown,
  fallbacks: {
    /** creators 를 channelId 로 찾아낸 문서(문서 id 조인 또는 필드 조회). */
    readonly byChannel?: unknown;
    /** 같은 배치에서 이미 읽은 videos 문서 — 스냅샷 워커가 채널명을 여기에 채운다. */
    readonly video?: unknown;
    /** 원장이 들고 있는 채널 id. */
    readonly channelId?: unknown;
    /** 지원서/creator 조인에서 확인된 연락 이메일. 응답에는 마스킹한 값만 싣는다. */
    readonly email?: unknown;
  } = {},
): ScpVideoReviewStateRow["creator"] {
  const data = record(value);
  // 이름/핸들 규칙의 정본(managementProfileTabsReadModels). 검수 화면도 report·partner 와 같은 값을
  // 봐야 한다 — 여기서 따로 풀던 시절 safeHandle 이 `@해니_나해니` 같은 실제 핸들을 ASCII 검사로
  // 버리고, 대신 접두 없는 문자열에 `@`를 붙여 없는 핸들을 만들어냈다.
  const identity = resolveCreatorDisplayIdentity(data, "");
  const displayName =
    identity.displayName ||
    text(data.creatorName, 80) ||
    text(data.name, 80) ||
    text(data.channelName, 80);
  // 이미지도 정본 해석기(resolveProfileImageProjection)를 그대로 쓴다 — 검증 OAuth > Flu 캐노니컬 >
  // YouTube Data API 순서가 파트너·관리 탭과 같아야 한다.
  const profileImageUrl = httpsUrl(
    resolveProfileImageProjection(
      creatorProfileImageSourceInputs(data),
      identity.displayName,
      typeof data.profileImageRevision === "number" ? data.profileImageRevision : 0,
      text(data.profileImageVerifiedAt, 80) || undefined,
    ).url ?? "",
    700,
  );
  // 국가도 정본 해석기(resolveCreatorCountryProjection)로 수렴시킨다. 이전 구현은 값을 2자로 **절단**해서
  // "GLOBAL" → "GL"(그린란드) 처럼 없는 국가를 만들어냈다 — 형식이 다르면 미확인으로 남긴다.
  const countryCode = resolveCreatorCountryProjection(data).code ?? "";
  const handle =
    identity.handle ??
    resolveCreatorDisplayIdentity({ handle: data.creatorHandle }, "").handle ??
    resolveCreatorDisplayIdentity({ handle: data.channelHandle }, "").handle ??
    "";
  // 폴백 체인 — 각 단계는 실데이터만 쓴다. 지어내지 않는다.
  //  1) creators(fluCreatorId)  2) creators(channelId 로 찾은 문서)  3) videos.channel
  // 셋 다 없으면 채널 링크만이라도 남기고 "채널 미확인"으로 둔다.
  const byChannel = record(fallbacks.byChannel);
  const byChannelIdentity = resolveCreatorDisplayIdentity(byChannel, "");
  const videoData = record(fallbacks.video);
  const videoChannel = text(videoData.channel, 80);
  const resolvedChannelId = [
    fallbacks.channelId,
    data.channelId,
    byChannel.channelId,
    videoData.channelId,
  ]
    .map((candidate) => text(candidate, 64))
    .find((candidate) => youtubeChannelUrl(candidate)) ?? "";
  const channelUrl = youtubeChannelUrl(resolvedChannelId);

  const resolvedName = displayName
    || byChannelIdentity.displayName
    || text(byChannel.creatorName, 80)
    || videoChannel;
  const displayNameSource: "creator" | "channel_match" | "video_channel" = displayName
    ? "creator"
    : (byChannelIdentity.displayName || text(byChannel.creatorName, 80))
      ? "channel_match"
      : "video_channel";
  const resolvedHandle = handle || byChannelIdentity.handle || "";
  const resolvedProfileImage = profileImageUrl
    || httpsUrl(
      resolveProfileImageProjection(
        creatorProfileImageSourceInputs(byChannel),
        byChannelIdentity.displayName,
        typeof byChannel.profileImageRevision === "number" ? byChannel.profileImageRevision : 0,
        text(byChannel.profileImageVerifiedAt, 80) || undefined,
      ).url ?? "",
      700,
    );
  const resolvedCountry = countryCode || resolveCreatorCountryProjection(byChannel).code || "";
  const emailMasked = maskEmail(
    text(data.email, 320) ||
    text(data.creatorEmail, 320) ||
    text(byChannel.email, 320) ||
    text(byChannel.creatorEmail, 320) ||
    text(fallbacks.email, 320) ||
    null,
  );

  if (!resolvedName && !resolvedProfileImage && !resolvedCountry && !resolvedHandle) {
    return {
      available: false,
      unavailableReason: "creator_projection_unavailable",
      channelUrl,
    };
  }
  return {
    available: true,
    displayName: resolvedName || "이름 미확인",
    profileImageUrl: resolvedProfileImage || null,
    countryCode: resolvedCountry || null,
    emailMasked,
    handle: resolvedHandle || null,
    displayNameSource,
    channelUrl,
  };
}

function uintString(value: unknown): string | null {
  if (typeof value === "bigint") return value >= 0n ? value.toString() : null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value).toString();
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  return null;
}

function positiveUintString(value: unknown): string | null {
  const parsed = uintString(value);
  if (parsed === null) return null;
  return BigInt(parsed) > 0n ? parsed : null;
}

function firstIso(...values: unknown[]): string | null {
  for (const value of values) {
    const parsed = iso(value);
    if (parsed) return parsed;
  }
  return null;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const parsed = text(value, 320);
    if (parsed) return parsed;
  }
  return "";
}

function d7ViewsProjection(video: Record<string, unknown>): {
  d7Views: string | null;
  d7ViewsSource: string | null;
} {
  const metrics = record(video.metrics);
  const tracking = record(video.tracking);
  const measurement = record(video.measurement);
  const performance = record(video.performance);
  const fields: Array<[unknown, string]> = [
    [video.d7Views, "videos.d7Views"],
    [video.eligibleD7Views, "videos.eligibleD7Views"],
    [video.d7EligibleViews, "videos.d7EligibleViews"],
    [video.sevenDayViews, "videos.sevenDayViews"],
    [metrics.d7Views, "videos.metrics.d7Views"],
    [metrics.eligibleD7Views, "videos.metrics.eligibleD7Views"],
    [metrics.d7EligibleViews, "videos.metrics.d7EligibleViews"],
    [metrics.sevenDayViews, "videos.metrics.sevenDayViews"],
    [tracking.d7Views, "videos.tracking.d7Views"],
    [tracking.eligibleD7Views, "videos.tracking.eligibleD7Views"],
    [tracking.d7EligibleViews, "videos.tracking.d7EligibleViews"],
    [tracking.sevenDayViews, "videos.tracking.sevenDayViews"],
    [measurement.d7Views, "videos.measurement.d7Views"],
    [measurement.eligibleD7Views, "videos.measurement.eligibleD7Views"],
    [measurement.d7EligibleViews, "videos.measurement.d7EligibleViews"],
    [performance.d7Views, "videos.performance.d7Views"],
    [performance.eligibleD7Views, "videos.performance.eligibleD7Views"],
    [performance.d7EligibleViews, "videos.performance.d7EligibleViews"],
  ];
  for (const [value, source] of fields) {
    const views = uintString(value);
    if (views !== null) return { d7Views: views, d7ViewsSource: source };
  }
  return { d7Views: null, d7ViewsSource: null };
}

function expectedRewardProjection(program: Record<string, unknown>): ScpVideoReviewStateRow["reviewFacts"]["expectedReward"] {
  const reward = record(program.reward);
  const payout = record(program.payout);
  const policy = record(program.videoRewardPolicy ?? program.rewardPolicy);
  const amountMinor =
    positiveUintString(program.expectedRewardAmountMinor) ||
    positiveUintString(program.rewardAmountMinor) ||
    positiveUintString(reward.amountMinor) ||
    positiveUintString(payout.amountMinor) ||
    positiveUintString(policy.amountMinor) ||
    (() => {
      const krw = positiveUintString(program.rewardKRW ?? reward.amountKRW ?? payout.amountKRW ?? policy.amountKRW);
      return krw === null ? null : `${krw}00`;
    })();
  if (amountMinor === null) return null;
  const currency = firstText(
    program.rewardCurrency,
    program.currency,
    reward.currency,
    payout.currency,
    policy.currency,
    program.rewardKRW ?? reward.amountKRW ?? payout.amountKRW ?? policy.amountKRW ? "KRW" : "",
  );
  return {
    amountMinor,
    currency: currency || "KRW",
    source: "program",
  };
}

export function reviewFactsProjection(args: {
  state: Record<string, unknown>;
  subject: Record<string, unknown>;
  portal: Record<string, unknown>;
  application: Record<string, unknown>;
  program: Record<string, unknown>;
  creator: Record<string, unknown>;
  creatorByChannel: Record<string, unknown> | null;
  video: Record<string, unknown>;
}): ScpVideoReviewStateRow["reviewFacts"] {
  const d7 = d7ViewsProjection(args.video);
  const uploadedMedia = record(args.portal.uploadedMedia ?? args.state.uploadedMedia ?? args.video.uploadedMedia);
  const snippet = record(args.video.snippet);
  const emailMasked = maskEmail(
    firstText(
      args.creator.email,
      args.creator.creatorEmail,
      args.application.email,
      args.application.creatorEmail,
      args.application.contactEmail,
      args.portal.email,
      args.portal.creatorEmail,
      args.portal.contactEmail,
      args.creatorByChannel?.email,
      args.creatorByChannel?.creatorEmail,
      args.subject.email,
      args.subject.creatorEmail,
    ) || null,
  );
  return {
    submittedAtIso: firstIso(
      args.state.submittedAtIso,
      args.state.submittedAt,
      args.portal.submittedAtIso,
      args.portal.submittedAt,
    ),
    contentUploadedAtIso: firstIso(
      args.state.contentUploadedAtIso,
      args.state.uploadedAtIso,
      args.state.uploadedAt,
      args.portal.contentUploadedAtIso,
      args.portal.uploadedAtIso,
      args.portal.uploadedAt,
      uploadedMedia.verifiedAtIso,
      uploadedMedia.createdAtIso,
      uploadedMedia.updatedAtIso,
      args.video.contentUploadedAtIso,
      args.video.uploadedAtIso,
      args.video.uploadedAt,
    ),
    contentPublishedAtIso: firstIso(
      args.state.contentPublishedAtIso,
      args.state.publishedAtIso,
      args.state.publishedAt,
      args.portal.contentPublishedAtIso,
      args.portal.publishedAtIso,
      args.portal.publishedAt,
      args.video.contentPublishedAtIso,
      args.video.publishedAtIso,
      args.video.publishedAt,
      snippet.publishedAt,
    ),
    resubmittedAtIso: Number(args.state.revision ?? 0) > 1
      ? firstIso(args.state.updatedAtIso, args.portal.updatedAtIso, args.portal.revisedAtIso, args.portal.resubmittedAtIso)
      : null,
    creatorEmailMasked: emailMasked,
    creatorCountryCode:
      resolveCreatorCountryProjection(args.creator).code ||
      resolveCreatorCountryProjection(args.creatorByChannel ?? {}).code ||
      text(args.application.countryCode, 8) ||
      text(args.application.country, 40) ||
      null,
    d7Views: d7.d7Views,
    d7ViewsSource: d7.d7ViewsSource,
    expectedReward: expectedRewardProjection(args.program),
  };
}

export function attributionContextProjection(args: {
  application: unknown;
  program: unknown;
  campaign: unknown;
  applicationId: string;
  enrollmentId: string;
  programId: string;
  campaignId: string;
}): Record<string, unknown> {
  const application = record(args.application);
  const program = record(args.program);
  const campaign = record(args.campaign);
  return {
    application: {
      id: args.applicationId || null,
      available: Object.keys(application).length > 0,
      name:
        text(
          application.name ?? application.title ?? application.applicantName,
          120,
        ) || null,
    },
    enrollment: {
      id: args.enrollmentId || null,
      available: Boolean(args.enrollmentId),
    },
    program: {
      id: args.programId || null,
      available: Object.keys(program).length > 0,
      name: text(program.name ?? program.title, 120) || null,
    },
    campaign: {
      id: args.campaignId || null,
      available: Object.keys(campaign).length > 0,
      name: text(campaign.name ?? campaign.title, 120) || null,
    },
  };
}

export function canonicalRevisionProjection(args: {
  sourceSubmissionId: string;
  portalProjectionRef: string;
  portal: unknown;
  subject: Record<string, unknown>;
  state: Record<string, unknown>;
}): ScpVideoReviewStateRow["canonicalRevision"] {
  const portal = record(args.portal);
  const sourceSubmissionId =
    args.sourceSubmissionId || text(portal.sourceSubmissionId, 180);
  if (!sourceSubmissionId) {
    return {
      available: false,
      unavailableReason: "source_submission_ref_unavailable",
      portalProjectionRef: null,
      sourceSubmissionId: null,
      revision: numberOrNull(args.state.revision),
      sourceFingerprint: text(args.state.contentFingerprint, 128) || null,
      portalState: null,
    };
  }
  return {
    available: Object.keys(portal).length > 0,
    unavailableReason:
      Object.keys(portal).length > 0 ? null : "portal_projection_unavailable",
    portalProjectionRef: args.portalProjectionRef,
    sourceSubmissionId,
    revision:
      numberOrNull(portal.revision) ?? numberOrNull(args.state.revision),
    sourceFingerprint:
      text(portal.sourceFingerprint, 128) ||
      text(args.state.contentFingerprint, 128) ||
      null,
    portalState: text(portal.state, 60) || null,
    canonicalRefs: {
      applicationId: text(args.subject.applicationId, 180) || null,
      enrollmentId: text(args.subject.enrollmentId, 180) || null,
      programId:
        text(args.subject.programId, 180) ||
        text(args.state.canonicalProgramId, 180) ||
        null,
      campaignId: text(args.subject.campaignId, 180) || null,
      portalCreatorId: text(args.subject.portalCreatorId, 180) || null,
      fluCreatorId: text(args.subject.fluCreatorId, 180) || null,
      partnerId: text(args.subject.partnerId, 180) || null,
    },
    portalProjection: pickRecord(portal, [
      "sourceSubmissionId",
      "revision",
      "sourceFingerprint",
      "state",
      "humanRequiredReasons",
      "submissionId",
    ]),
  };
}

export function aiRecommendationProjection(
  value: unknown,
): ScpVideoReviewStateRow["aiRecommendation"] {
  const data = record(value);
  if (Object.keys(data).length === 0) return null;
  const policy = pickRecord(data, [
    "policyVersion",
    "policyConfigHash",
    "recommendation",
    "reasonCode",
  ]);
  const frame =
    pickRecord(data.frame ?? data.frameEvidence, [
      "assessment",
      "risk",
      "confidence",
      "summary",
      "evidenceRef",
    ]) ?? pickRecord(data, ["frame", "frameRisk", "frameConfidence"]);
  const brand =
    pickRecord(data.brand ?? data.brandEvidence, [
      "assessment",
      "risk",
      "confidence",
      "summary",
      "evidenceRef",
    ]) ?? pickRecord(data, ["brand", "brandRisk", "brandConfidence"]);
  const engine = {
    engine: text(data.engine, 80) || text(data.provider, 80) || null,
    model: text(data.model, 120) || text(data.modelId, 120) || null,
    version: text(data.version, 80) || text(data.engineVersion, 80) || null,
  };
  return { policy, frame, brand, engine };
}

// W102(헤세): AI 사전판정(멀티모달 judge)의 verdict·확률만 화면에 투영한다.
// SEC-P0-009: 판정 사유·모델 응답 원문은 절대 건너지 않는다 — 파생 수치·메타만.
export function judgeVerdictProjection(
  value: unknown,
  /**
   * W121 [적대 리뷰 M2]: 태그 후보는 **상세 행에서만** 쓴다(칩 UI). 목록 응답은 행마다 최대 12개
   * 튜플을 실어 페이지당 수십 KB 를 더 보내면서 아무도 읽지 않는다 — RELATED_VIDEO_SCAN_LIMIT
   * 계열(:75-76)과 같은 규율로 detail 게이트 뒤에 둔다. 기본값은 "싣지 않음"이다(fail-cheap).
   */
  options: { readonly includeReasonTagCandidates?: boolean } = {},
): ScpVideoReviewStateRow["aiJudge"] {
  const data = record(value);
  const verdict = record(data.verdict);
  const verdictLabel = text(verdict.verdict, 40);
  const probRaw = Number(verdict.disapprovalProbability);
  if (!verdictLabel || !Number.isFinite(probRaw)) return null;
  const disapprovalProbability = Math.max(0, Math.min(100, Math.round(probRaw)));
  // W107 T5: surface which rule(s) forced a decisive rejection next to the probability, so the
  // number on screen has a reason attached instead of reading as an opaque single digit. Mirrors
  // the decisiveFailures gate in normalizeVideoReviewVerdict (videoReviewJudgeService.ts):
  // canAutoReject + failed + confidence>=0.75. SEC-P0-009: only the closed rule-id/key constant
  // vocabulary from videoReviewCriteria.ts crosses this boundary -- never verdict.reasons,
  // verdict.evidence[].summary, or any other model-authored free text.
  const hardFailEvidence = Array.isArray(verdict.evidence) ? verdict.evidence.map(record) : [];
  const hardFailRuleIds: string[] = [];
  const hardFailReasonCodes: string[] = [];
  // W121: 반려 메일 사유 태그의 **후보**. 하드페일(위)보다 넓게 잡는다 — 검수자가 고를 수 있어야
  // 하므로 failed 뿐 아니라 unknown(사람 확인 게이트) 룰도 후보다. 경계는 하나도 완화하지 않았다:
  // closed 카탈로그(videoReviewRuleById)에 있고 **사유 문구 사전에 등록된** 룰만 통과하며, 넘어가는
  // 값은 룰 ID·룰 키·룰명 상수와 파생 수치(confidence)뿐이다. verdict.reasons·evidence[].summary
  // 같은 모델 자유 텍스트는 여전히 절대 미투영(SEC-P0-009).
  const reasonTagCandidates: Array<{
    ruleId: string;
    ruleKey: string;
    ruleName: string;
    status: "failed" | "unknown";
    confidence: number;
  }> = [];
  const seenCandidateRuleIds = new Set<string>();
  for (const item of hardFailEvidence) {
    const ruleId = text(item.ruleId, 20);
    const descriptor = videoReviewRuleById(ruleId);
    if (!descriptor) continue;
    const status = text(item.status, 20);
    if (
      options.includeReasonTagCandidates === true
      && (status === "failed" || status === "unknown")
      && !seenCandidateRuleIds.has(ruleId)
      && videoReviewRuleTagPhrase(descriptor.key)
    ) {
      seenCandidateRuleIds.add(ruleId);
      const confidenceRaw = Number(item.confidence);
      reasonTagCandidates.push({
        ruleId,
        ruleKey: descriptor.key,
        ruleName: descriptor.name,
        status,
        confidence: Number.isFinite(confidenceRaw)
          ? Math.max(0, Math.min(1, confidenceRaw))
          : 0,
      });
    }
    if (descriptor.canAutoReject !== true
      || status !== "failed"
      || !(Number(item.confidence) >= 0.75)) continue;
    hardFailRuleIds.push(ruleId);
    hardFailReasonCodes.push(descriptor.key);
  }
  // 확정 실패가 먼저, 그 안에서는 확신이 높은 순. 정렬이 흔들리면 같은 판정에서 칩 순서가 매번
  // 달라져 운영자가 "왜 순서가 바뀌었나"를 판정 신호로 오해한다(Array.sort 는 안정 정렬이다).
  reasonTagCandidates.sort((left, right) => (
    (left.status === right.status ? 0 : left.status === "failed" ? -1 : 1)
    || right.confidence - left.confidence
  ));
  return {
    verdict: verdictLabel,
    disapprovalProbability,
    approvalProbability: 100 - disapprovalProbability,
    decidedAtIso: text(data.createdAtIso, 40) || null,
    modelId: text(data.modelId, 120) || null,
    policyVersion: text(data.policyVersion, 80) || null,
    hardFailRuleIds,
    hardFailReasonCodes,
    reasonTagCandidates: reasonTagCandidates.slice(0, MAX_REASON_TAG_CANDIDATES),
  };
}

export function duplicateProjection(
  value: unknown,
  fallbackFingerprint: string,
): ScpVideoReviewStateRow["duplicateEvidence"] {
  const source = record(
    record(value).duplicate ?? record(value).duplicateEvidence ?? value,
  );
  const members = Array.isArray(source.members)
    ? source.members
    : Array.isArray(source.clusterMembers)
      ? source.clusterMembers
      : [];
  const safeMembers = members
    .slice(0, MAX_CLUSTER_MEMBERS)
    .flatMap((member) => {
      const rec = record(member);
      const id =
        text(rec.videoSubmissionId, 180) ||
        text(rec.submissionId, 180) ||
        text(member, 180);
      if (!id) return [];
      return [
        {
          videoSubmissionId: id,
          fingerprint:
            text(rec.fingerprint, 128) ||
            text(rec.contentFingerprint, 128) ||
            null,
        },
      ];
    });
  const count =
    numberOrNull(source.count) ??
    numberOrNull(source.clusterCount) ??
    safeMembers.length;
  const fingerprint =
    text(source.fingerprint, 128) ||
    text(source.contentFingerprint, 128) ||
    fallbackFingerprint ||
    null;
  return count || safeMembers.length || fingerprint
    ? { count, members: safeMembers, fingerprint }
    : null;
}

export function voiceProjection(
  value: unknown,
): ScpVideoReviewStateRow["voiceEvidence"] {
  const source = record(
    record(value).voiceAuthenticity ??
      record(value).voiceAuthenticityRisk ??
      record(value).voice ??
      value,
  );
  const authenticity =
    text(source.authenticity, 80) ||
    text(source.assessment, 80) ||
    text(source.risk, 80);
  const language = text(source.language, 40);
  const accent = text(source.accent, 80);
  const confidence = numberOrNull(source.confidence);
  const engine = text(source.engine, 80) || text(source.provider, 80);
  const version = text(source.version, 80) || text(source.engineVersion, 80);
  return authenticity ||
    language ||
    accent ||
    confidence !== null ||
    engine ||
    version
    ? {
        authenticity: authenticity || null,
        accent: accent || null,
        language: language || null,
        confidence,
        engine: engine || null,
        version: version || null,
      }
    : null;
}

function ledgerActorType(value: unknown): "human" | "ai" | null {
  return value === "ai" ? "ai" : value === "human" ? "human" : null;
}

export function ledgerProjection(
  value: unknown,
): ScpVideoReviewStateRow["decisionLedger"] {
  const rows = Array.isArray(value) ? value.slice(-MAX_LEDGER_ROWS) : [];
  return rows.flatMap((entry) => {
    const data = record(entry);
    const out = {
      seq: numberOrNull(data.seq),
      fromState: text(data.fromState, 60) || null,
      toState:
        text(data.toState, 60) ||
        text(data.state, 60) ||
        text(data.decision, 60) ||
        null,
      atIso:
        iso(data.atIso) ||
        iso(data.reviewedAt) ||
        iso(data.createdAtIso) ||
        null,
      revision: numberOrNull(data.revision),
      reasonCode: text(data.reasonCode, 120) || null,
      customerMessageCode: text(data.customerMessageCode, 120) || null,
      // W102 리뷰 NOTE 채택: 편집 문안은 이미 수신자에게 발송된 것 — 재노출 무해하고,
      // 없으면 운영자가 "내가 뭐라고 보냈더라"를 이력에서 확인할 길이 없다.
      operatorMessage: text(data.operatorMessage, 1000) || null,
      decisionRef: text(data.decisionRef, 180) || null,
      // Task-94: the undo button in CanonicalVideoReviewPanel only targets a row whose LAST
      // decision was AI-authored.
      actorType: ledgerActorType(data.actorType),
    };
    return Object.values(out).some((item) => item !== null && item !== "")
      ? [out]
      : [];
  });
}

/** Task-94: review-state 문서의 `appeal` 마커를 슬림 투영한다(videoReviewTransitionStore.ts 가 쓴 값). */
export function appealProjection(value: unknown): ScpVideoReviewStateRow["appeal"] {
  const data = record(value);
  if (data.open !== true) return null;
  return {
    open: true,
    message: text(data.message, 1000) || null,
    submittedAtIso: iso(data.submittedAtIso) || null,
    decisionSeq: numberOrNull(data.decisionSeq),
  };
}

export function outboxStatus(
  doc: FirebaseFirestore.DocumentSnapshot | null,
  expectedDocumentId: string | null,
): ScpVideoReviewStateRow["postDecisionStatus"]["callbackOutbox"] {
  // `queued`, `leased`, and `sent_evidence_pending` are intentionally never
  // collapsed into delivered: only the producer's literal `deliveryState` is shown.
  if (!doc || !doc.exists)
    return {
      state: expectedDocumentId ? "unavailable" : "not_applicable",
      outboxId: expectedDocumentId,
      deliveryState: null,
      attempts: 0,
      nextAttemptAtIso: null,
      deadLetter: false,
      delivered: false,
    };
  const data = doc.data() ?? {};
  const deliveryState = text(data.deliveryState, 80) || "unknown";
  return {
    state: deliveryState,
    outboxId: doc.id,
    deliveryState,
    attempts: numberOrNull(data.attempts) ?? 0,
    nextAttemptAtIso: iso(data.nextAttemptAtIso) || null,
    deadLetter: deliveryState === "dead_letter",
    delivered: deliveryState === "delivered",
    updatedAtIso: iso(data.updatedAtIso) || iso(data.deliveredAtIso) || null,
  };
}

function partnerStatus(
  doc: FirebaseFirestore.DocumentSnapshot | null,
): ScpVideoReviewStateRow["postDecisionStatus"]["partnerActivation"] {
  if (!doc || !doc.exists)
    return { state: "unavailable", activationId: null, active: false };
  const data = doc.data() ?? {};
  return {
    state:
      text(data.status, 80) || (data.active === true ? "active" : "available"),
    activationId: doc.id,
    active: data.active === true || text(data.status, 80) === "active",
    updatedAtIso: iso(data.updatedAtIso) || iso(data.activatedAtIso) || null,
  };
}

type Cursor = { updatedAtIso: string; id: string; titleId?: string };

function decodeCursor(value: unknown): Cursor | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return typeof parsed?.updatedAtIso === "string" &&
      typeof parsed?.id === "string"
      ? {
          updatedAtIso: parsed.updatedAtIso,
          id: parsed.id,
          ...(typeof parsed.titleId === "string" ? { titleId: parsed.titleId } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function boundedReviewStatePageLimit(value: unknown): number {
  const parsed = integerField(value);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_PAGE_SIZE)
    : MAX_PAGE_SIZE;
}

export async function getAllReviewStateRefs(
  db: Pick<FirebaseFirestore.Firestore, "getAll">,
  refs: readonly FirebaseFirestore.DocumentReference[],
): Promise<FirebaseFirestore.DocumentSnapshot[]> {
  return refs.length > 0 ? db.getAll(...refs) : [];
}

export type ScpVideoReviewStateRow = {
  id: string;
  detailHydrated: boolean;
  videoSubmissionId: string;
  state: string;
  revision: number;
  contentFingerprint: string;
  /**
   * W7-1c-fix (2026-09-06): resolved via reviewStateProgramResolution.ts, never the raw stored
   * value verbatim — a row whose Firestore doc still carries the Portal apply-gate tag
   * (view-cpm) is joined through subject.applicationId -> scp_application_management here, so
   * the client's program filter (src/modules/programs/reviewScope.ts) can trust this field.
   */
  canonicalProgramId: string;
  /** The raw Portal apply-gate tag this row carried, when canonicalProgramId above was resolved. */
  portalProgramId: string | null;
  /** True when no real program could be recovered — canonicalProgramId is the preserved raw value. */
  programUnresolved: boolean;
  policyConfigHash: string;
  /**
   * 2026-09-05 다타이틀: 제출이 어느 게임 타이틀인지. 원장에 저장된 원값을 그대로 싣는다
   * (오늘 실데이터에는 이 필드가 0/221건이라 대부분 빈 문자열이다 — 그 경우 `title` 이
   * 프로그램 기본 타이틀로 착지한다).
   */
  gameId: string;
  /**
   * 인제스트가 레지스트리에 없는 gameId 를 받아 기본 타이틀로 착지시킨 행. 제출을 거부하지
   * 않는 대신 이 신호로 사람 게이트가 집는다(포털이 레지스트리보다 먼저 새 타이틀을 보낼 수 있다).
   */
  gameIdUnresolved: boolean;
  /**
   * 인제스트가 선언 없이(또는 미등록 선언으로) 기본 타이틀을 스탬프한 행 — 이 gameId 는
   * 행의 게임 주장이 아니라 채우기 값이라 strict 필터의 증거 집합에서 제외된다.
   */
  gameIdDefaulted: boolean;
  /** 레지스트리로 해석한 표시용 타이틀. 화면 배지·필터가 이 값만 쓴다(게임명 리터럴 금지). */
  title: { id: string; name: string; storeUrl: string; requiredHashtag: string; requiredHashtags: string[] } | null;
  campaignId: string;
  fluCreatorId: string;
  youtubeUrl: string;
  youtubeVideoId: string;
  traceId: string;
  withdrawn: boolean;
  superseded: boolean;
  feedEligible: boolean;
  trackingEligible: boolean;
  lastTransitionSeq: number;
  updatedAtIso: string;
  sourceSubmissionId: string;
  mailPreview: {
    targetStatus: MailPreviewTarget;
    mailKind: VideoReviewMailKind;
    recipientResolved: boolean;
    recipientMasked: string | null;
    subject: string;
    text: string;
    bodyFormat: "html" | "text";
    templateSource: "published" | "fallback";
    correctionLinkAvailable: boolean;
  } | null;
  media: {
    playableUrl: string | null;
    thumbnailUrl: string | null;
    youtubeVideoId: string | null;
    title: string | null;
    // 제목이 YouTube 스냅샷에서 온 것인지 원장 라벨인지 — 화면이 출처를 표시할 수 있게 실어 보낸다.
    titleSource: "youtube_snapshot" | "ledger" | "none";
    // W120: 서버가 확인한 링크 가용성. 목록·상세 모두에 실린다(썸네일 404 폴백보다 앞선 신호).
    availability: ReviewVideoAvailability;
  };
  creator:
    | { available: false; unavailableReason: string; channelUrl: string | null }
    | {
        available: true;
        displayName: string;
        profileImageUrl: string | null;
        countryCode: string | null;
        emailMasked: string | null;
        handle: string | null;
        /** 이름이 어디서 왔는지 — 운영자가 신뢰 수준을 알 수 있게 실어 보낸다. */
        displayNameSource: "creator" | "channel_match" | "video_channel";
        /** 채널 id 가 실제 UC… 일 때만. 이름이 안 붙어도 운영자가 채널로 갈 수 있다. */
        channelUrl: string | null;
      };
  aiRecommendation: {
    policy: Record<string, unknown> | null;
    frame: Record<string, unknown> | null;
    brand: Record<string, unknown> | null;
    engine: {
      engine: string | null;
      model: string | null;
      version: string | null;
    };
  } | null;
  /** W102: AI 사전판정(멀티모달) — verdict·확률·메타만. 사유/원문 없음(SEC-P0-009). */
  aiJudge: {
    verdict: string;
    disapprovalProbability: number;
    approvalProbability: number;
    decidedAtIso: string | null;
    modelId: string | null;
    policyVersion: string | null;
    /** W107 T5: rule IDs that produced a decisive (canAutoReject) hard failure. */
    hardFailRuleIds: string[];
    /** W107 T5: closed rule-key constants for the same failures — never free text. */
    hardFailReasonCodes: string[];
    /**
     * W121: 반려 메일 사유 태그 후보(failed·unknown 룰). closed 카탈로그 상수 + 파생 수치만.
     * confidence 는 **검수자 화면 전용**이다 — 크리에이터 메일에는 퍼센트가 들어가지 않는다.
     */
    reasonTagCandidates: Array<{
      ruleId: string;
      ruleKey: string;
      ruleName: string;
      status: "failed" | "unknown";
      confidence: number;
    }>;
  } | null;
  duplicateEvidence: {
    count: number | null;
    members: Array<{ videoSubmissionId: string; fingerprint: string | null }>;
    fingerprint: string | null;
  } | null;
  voiceEvidence: {
    authenticity: string | null;
    accent: string | null;
    language: string | null;
    confidence: number | null;
    engine: string | null;
    version: string | null;
  } | null;
  attributionContext: Record<string, unknown>;
  reviewFacts: {
    submittedAtIso: string | null;
    contentUploadedAtIso: string | null;
    contentPublishedAtIso: string | null;
    resubmittedAtIso: string | null;
    creatorEmailMasked: string | null;
    creatorCountryCode: string | null;
    d7Views: string | null;
    d7ViewsSource: string | null;
    expectedReward: {
      amountMinor: string;
      currency: string;
      source: string | null;
    } | null;
  };
  canonicalRevision: {
    available: boolean;
    unavailableReason: string | null;
    portalProjectionRef: string | null;
    sourceSubmissionId: string | null;
    revision: number | null;
    sourceFingerprint: string | null;
    portalState: string | null;
    canonicalRefs?: Record<string, string | null>;
    portalProjection?: Record<string, unknown> | null;
  };
  decisionLedger: Array<{
    seq: number | null;
    fromState: string | null;
    toState: string | null;
    atIso: string | null;
    revision: number | null;
    reasonCode: string | null;
    customerMessageCode: string | null;
    /** W102: 그 판정에서 실제 발송된 운영자 편집 문안(있을 때만) — 발송 후 재확인용. */
    operatorMessage: string | null;
    decisionRef: string | null;
    /** Task-94: 마지막 판정의 판정 주체 — AI-authored 행에만 undo 버튼을 띄운다. */
    actorType?: "human" | "ai" | null;
  }>;
  /** Task-94: video.review.appeal 수신 시 서버가 세운다. 열려 있으면 큐에 "이의제기" 배지. */
  appeal?: {
    open: boolean;
    message?: string | null;
    submittedAtIso?: string | null;
    decisionSeq?: number | null;
  } | null;
  postDecisionStatus: {
    callbackOutbox: {
      state: string;
      outboxId: string | null;
      deliveryState: string | null;
      attempts: number;
      nextAttemptAtIso: string | null;
      deadLetter: boolean;
      delivered: boolean;
      updatedAtIso?: string | null;
    };
    resultMailOutbox: {
      state: string;
      outboxId: string | null;
      deliveryState: string | null;
      attempts: number;
      nextAttemptAtIso: string | null;
      deadLetter: boolean;
      delivered: boolean;
      updatedAtIso?: string | null;
    };
    downstreamCallbackOutbox: {
      state: string;
      outboxId: string | null;
      deliveryState: string | null;
      attempts: number;
      nextAttemptAtIso: string | null;
      deadLetter: boolean;
      delivered: boolean;
      updatedAtIso?: string | null;
    };
    /**
     * W126: 결과 메일이 **실패한 채로 남아 있다**는 큐 표면화. `resultMailOutbox` 와 축이 다르다 —
     * 그쪽은 상세 조인 전용이고 **현재 seq 의 행 하나**만 본다(목록에서는 항상 비어 있다).
     * 이 필드는 아웃박스를 역방향으로 한 번 훑어 **어느 seq 든** 실패로 남은 행을 잡는다.
     * 실패가 없으면 null 이다(정상 행에 빈 껍데기를 실어 페이지를 불리지 않는다).
     */
    resultMailAlert: {
      deliveryState: "dead_letter" | "retryable_failed";
      outboxId: string;
    } | null;
    /**
     * Acknowledged dead_letter metadata for this submission. Separate from resultMailOutbox because
     * the acknowledged failed row can belong to an older transition seq than the current canonical
     * resultMailOutbox pointer. Frontend undo must use this outboxId, not resultMailOutbox.outboxId.
     */
    resultMailAcknowledgement: {
      outboxId: string;
      submissionId: string;
      acknowledged: true;
      acknowledgedAtIso: string | null;
      acknowledgedBy: string | null;
      acknowledgedByRole: string | null;
      acknowledgedReason: string | null;
    } | null;
    partnerActivation: {
      state: string;
      activationId: string | null;
      active: boolean;
      updatedAtIso?: string | null;
    };
    auditReceipt: {
      state: string;
      receiptId: string | null;
      eventId: string | null;
    };
  };
  /**
   * W120: 이 제출 자체의 판정 이력 요약(원장에서 센다 — 추가 조회 없음). 목록 행에도 실린다.
   */
  reviewHistorySummary: {
    approvals: number;
    declines: number;
    lastDeclineReasonCode: string | null;
    repeatedReasonCode: string | null;
    repeatedReasonCount: number;
  };
  /**
   * W120: 상세 전용 — 같은 영상(youtubeVideoId)의 다른 제출 반려 이력 + 크리에이터 단위 집계.
   * 목록에서는 null 이다(행마다 조회하면 목록 1회에 50 쿼리가 붙는다).
   */
  relatedHistory: {
    sameVideoDeclines: Array<{
      videoSubmissionId: string;
      state: string;
      reasonCode: string | null;
      atIso: string | null;
    }>;
    creatorApproved: number;
    creatorDeclined: number;
    creatorRepeatedReasonCode: string | null;
    creatorRepeatedReasonCount: number;
    /**
     * W126: 크리에이터 단위 **사유 코드별** 반려 수 — 단, **크리에이터에게 실제로 통지된**
     * 판정만 센다(드레인이 쓰는 축과 같아야 미리보기 = 발송본이 성립한다).
     * `creatorRepeatedReason*` 은 최다 1건만 말하는데, 반복 반려 에스컬레이션은 "지금 고른
     * 사유"가 몇 번째인지를 알아야 한다. 값은 사유 코드 카탈로그 크기로 상한이 잡힌 정수
     * 집계다(식별자·본문 없음).
     */
    creatorNotifiedDeclineReasonCounts: Record<string, number>;
    /**
     * W126 [적대 리뷰 H1]: **이 제출 문서가 크리에이터 표본 창 안에 있었는가.**
     *
     * 두 스캔(여기 · 드레인)은 `where(subject.fluCreatorId).limit(51)` 에 orderBy 가 없어
     * `__name__ ASC` 가 창을 정한다. 크리에이터의 리뷰스테이트가 50건을 넘고 지금 판정하는
     * 문서가 51번째 이후로 정렬되면 **두 스캔 다 그 문서를 못 읽는다** — 그러면 드레인의
     * 계수에는 이번 판정이 안 들어간다. 미리보기가 그걸 모르고 +1 하면, 운영자는 경고 문장을
     * 보는데 크리에이터는 그 문장을 **아예 못 받는다**(W120 C1 부류: 미리보기 ≠ 발송본).
     * 두 창이 같은 쿼리·같은 상한이라 이 불리언이 드레인의 포함 여부를 정확히 예측한다.
     */
    creatorSampleIncludesSelf: boolean;
    /**
     * W120 [적대 리뷰 H4]: 집계는 **무순서 표본**이다(정렬은 복합 인덱스를 요구하므로 만들지 않았다).
     * 표본 크기와 상한 도달 여부를 함께 실어, 화면이 "N건"을 전수인 양 말하지 않게 한다.
     */
    creatorScanned: number;
    creatorTruncated: boolean;
    sameVideoScanned: number;
    sameVideoTruncated: boolean;
  } | null;
  ruleEvidenceLedger: Record<string, unknown>[];
  /** @deprecated kept for older UI callers; use aiRecommendation/duplicateEvidence/voiceEvidence. */
  evidence: Record<string, unknown> | null;
  /** @deprecated kept for older UI callers; use decisionLedger. */
  reviewHistory: Record<string, unknown>[];
  /** @deprecated kept for older UI callers; use canonicalRevision.portalProjection. */
  portalProjection: Record<string, unknown> | null;
};

/**
 * W120: 상세 진입 시 1회만 도는 재제출·이력 조회.
 *
 * 새 중복 탐지 인프라를 만들지 않는다 — 이미 원장에 있는 사실을 두 개의 **단일 필드 동등** 쿼리로
 * 끌어올 뿐이다(복합 인덱스 불필요). 같은 영상 id 는 쿼리 파라미터만 바꾼 재제출을 잡는다
 * (extractYouTubeVideoId 로 정규화된 값이 원장에 저장돼 있다).
 * `unclassified:` 센티널 크리에이터 id 는 조회하지 않는다 — 미분류끼리 뭉쳐 남의 이력이 섞인다.
 */
/** W126: 표본 창 경계(H1)를 에뮬레이터 레인이 직접 확인할 수 있도록 export 한다. */
export async function loadRelatedReviewHistory(item: {
  readonly doc: FirebaseFirestore.DocumentSnapshot;
  readonly state: Record<string, unknown>;
  readonly subject: Record<string, unknown>;
}): Promise<ScpVideoReviewStateRow["relatedHistory"]> {
  const youtubeVideoId = text(item.state.youtubeVideoId, 60);
  const fluCreatorId = text(item.subject.fluCreatorId, 180);
  const creatorScopable = Boolean(fluCreatorId) && !fluCreatorId.startsWith("unclassified:");
  const collection = adminDb.collection(SCP_VIDEO_REVIEW_STATE_COLLECTION);
  // W120 [적대 리뷰 H4]: 자기 문서는 쿼리 전에 뺄 수 없다.
  //   ① 자기 자신이 표본 한 칸을 먹지 않게, ② 자기 자신을 뺀 뒤에도 "상한을 넘겼다"를 판정할 수
  //   있게 — 동일 영상 레인은 상한 **+2** 를 뽑는다(+1 이면 자기 자신을 뺀 순간 경계가 사라진다).
  //   크리에이터 레인은 자기 제출도 집계 대상이라 +1 이면 충분하다.
  const [sameVideo, creatorDocs] = await Promise.all([
    youtubeVideoId
      ? collection.where("youtubeVideoId", "==", youtubeVideoId).limit(RELATED_VIDEO_SCAN_LIMIT + 2).get()
      : Promise.resolve(null),
    creatorScopable
      ? collection.where("subject.fluCreatorId", "==", fluCreatorId).limit(CREATOR_HISTORY_SCAN_LIMIT + 1).get()
      : Promise.resolve(null),
  ]);
  const sameVideoDeclines: NonNullable<
    ScpVideoReviewStateRow["relatedHistory"]
  >["sameVideoDeclines"] = [];
  const sameVideoOthers = (sameVideo?.docs ?? []).filter((doc) => doc.id !== item.doc.id);
  const sameVideoTruncated = sameVideoOthers.length > RELATED_VIDEO_SCAN_LIMIT;
  for (const doc of sameVideoOthers.slice(0, RELATED_VIDEO_SCAN_LIMIT)) {
    const data = record(doc.data());
    const summary = summarizeVideoReviewLedger(data.reviewLedger);
    if (summary.declines === 0) continue;
    const last = (Array.isArray(data.reviewLedger) ? data.reviewLedger : [])
      .map((entry) => record(entry))
      .filter((entry) => text(entry.toState, 60) === "rejected" || text(entry.toState, 60) === "changes_requested")
      .at(-1) ?? {};
    sameVideoDeclines.push({
      videoSubmissionId: text(record(data.subject).videoSubmissionId, 500) || doc.id,
      state: text(last.toState, 60) || text(data.state, 60) || "rejected",
      reasonCode: text(last.reasonCode, 120) || summary.lastDeclineReasonCode,
      atIso: iso(last.atIso) || iso(last.reviewedAt) || null,
    });
  }
  let creatorApproved = 0;
  let creatorDeclined = 0;
  const creatorReasonCounts = new Map<string, number>();
  // W126: 크리에이터 문장(에스컬레이션)이 쓰는 축은 **통지된 판정만** 센다. 운영자 배지가 쓰는
  //   위 맵과 분리한다 — 화면은 "무슨 일이 있었나"를 전부 봐야 하고, 메일은 "우리가 말한 것"만
  //   근거로 삼아야 한다(무메일 백필이 크리에이터 문장에 새면 안 된다).
  const creatorNotifiedReasonCounts = new Map<string, number>();
  const creatorSample = (creatorDocs?.docs ?? []).slice(0, CREATOR_HISTORY_SCAN_LIMIT);
  let creatorSampleIncludesSelf = false;
  for (const doc of creatorSample) {
    if (doc.id === item.doc.id) creatorSampleIncludesSelf = true;
    const data = record(doc.data());
    const summary = summarizeVideoReviewLedger(data.reviewLedger);
    creatorApproved += summary.approvals;
    creatorDeclined += summary.declines;
    // W120 [적대 리뷰 M3]: 문서당 마지막 사유 1건이 아니라 **판정 엔트리 단위**로 합친다 —
    //   한 제출에서 같은 사유로 3번 반려된 사실이 1로 접히면 반복 경고가 늦게 뜬다.
    mergeDeclineReasonCounts(creatorReasonCounts, summary.declineReasonCounts);
    mergeDeclineReasonCounts(
      creatorNotifiedReasonCounts,
      summarizeVideoReviewLedger(data.reviewLedger, { notifiedOnly: true }).declineReasonCounts,
    );
  }
  const creatorRepeated = topRepeatedReason(creatorReasonCounts);
  return {
    sameVideoDeclines,
    creatorApproved,
    creatorDeclined,
    creatorRepeatedReasonCode: creatorRepeated.code,
    creatorRepeatedReasonCount: creatorRepeated.count,
    // W126: 이미 센 Map 을 버리지 않고 그대로 넘긴다 — 추가 조회가 0 이다.
    creatorNotifiedDeclineReasonCounts: Object.fromEntries(creatorNotifiedReasonCounts),
    creatorSampleIncludesSelf,
    creatorScanned: creatorSample.length,
    creatorTruncated: (creatorDocs?.docs.length ?? 0) > CREATOR_HISTORY_SCAN_LIMIT,
    sameVideoScanned: sameVideoOthers.length > RELATED_VIDEO_SCAN_LIMIT
      ? RELATED_VIDEO_SCAN_LIMIT
      : sameVideoOthers.length,
    sameVideoTruncated,
  };
}

/**
 * W126: 결과 메일이 실패로 남은 제출들. **역방향 1쿼리**다 — 행마다 아웃박스를 조인하면 목록
 * 1회에 50 read 가 고정 비용으로 붙는데, 실패 행은 원래 드문 것이라 그쪽이 훨씬 비싸다.
 * 정상 상태에서 이 쿼리가 읽는 문서는 0건에 수렴한다(장애 때만 상한까지 올라간다).
 *
 * 단일 필드 `in` 조건이라 신규 복합 인덱스가 필요 없다(orderBy 를 붙이면 필요해진다 — 붙이지 않는다).
 * `suppressed` 는 실패가 아니라 결정적 차단이라 제외한다(W62e-MAJ-A).
 */
const RESULT_MAIL_ALERT_SCAN_LIMIT = 200;
const RESULT_MAIL_ALERT_SCAN_MAX_PAGES = 10;

export type ResultMailAlert = NonNullable<
  ScpVideoReviewStateRow["postDecisionStatus"]["resultMailAlert"]
>;
export type ResultMailAcknowledgement = NonNullable<
  ScpVideoReviewStateRow["postDecisionStatus"]["resultMailAcknowledgement"]
>;

type ResultMailAlertScanStatus = "ok" | "incomplete" | "unavailable";

export type ResultMailAlertScan = {
  readonly alerts: Map<string, ResultMailAlert>;
  readonly acknowledgements: Map<string, ResultMailAcknowledgement>;
  /**
   * W126 [적대 리뷰 M2]: 쿼리가 **읽은 행 수**. `alerts.size` 와 다르다 — 한 제출이 seq 마다
   * 실패 행을 가질 수 있어(`${reviewDocId}__${seq}`) dedupe 후에는 항상 더 작다. 절단 판정과
   * read 계측을 `alerts.size` 로 하면, 진짜 200행 절단이 `size===180` 으로 착지해 경고가
   * **영원히 발화하지 않고** read 수도 과소보고된다 — 장애 중에 배지·필터가 조용히 실패를
   * 빠뜨리는, 이 기능이 존재하는 바로 그 상황이다.
  */
  readonly scanned: number;
  readonly status: ResultMailAlertScanStatus;
  readonly limit: number;
  readonly pages: number;
  readonly reason?: string;
};

type ResultMailAlertPage = {
  readonly docs: readonly {
    readonly id: string;
    readonly data: Record<string, unknown>;
  }[];
  readonly scanned: number;
  readonly nextCursor: unknown;
};

function emptyResultMailAlertScan(
  status: ResultMailAlertScanStatus,
  reason?: string,
): ResultMailAlertScan {
  return {
    alerts: new Map<string, ResultMailAlert>(),
    acknowledgements: new Map<string, ResultMailAcknowledgement>(),
    scanned: 0,
    status,
    limit: RESULT_MAIL_ALERT_SCAN_LIMIT * RESULT_MAIL_ALERT_SCAN_MAX_PAGES,
    pages: 0,
    ...(reason ? { reason } : {}),
  };
}

function sanitizeScanFailureReason(error: unknown): string {
  return text(record(error).code, 80) || (error instanceof Error ? error.name : typeof error);
}

export async function scanResultMailAlertsSafe(
  fetchPage: (cursor: unknown, pageLimit: number) => Promise<ResultMailAlertPage>,
  options: { readonly pageLimit?: number; readonly maxPages?: number } = {},
): Promise<ResultMailAlertScan> {
  const pageLimit = Math.max(1, Math.min(
    RESULT_MAIL_ALERT_SCAN_LIMIT,
    Math.trunc(options.pageLimit ?? RESULT_MAIL_ALERT_SCAN_LIMIT),
  ));
  const maxPages = Math.max(1, Math.trunc(options.maxPages ?? RESULT_MAIL_ALERT_SCAN_MAX_PAGES));
  const alerts = new Map<string, ResultMailAlert>();
  const acknowledgements = new Map<string, ResultMailAcknowledgement>();
  let scanned = 0;
  let pages = 0;
  let cursor: unknown = null;
  try {
    while (pages < maxPages) {
      const page = await fetchPage(cursor, pageLimit);
      pages += 1;
      scanned += page.scanned;
      for (const doc of page.docs) {
        const data = record(doc.data);
        const submissionId = text(data.submissionId, 500);
        if (!submissionId) continue;
        const rawDeliveryState = text(data.deliveryState, 80);
        if (rawDeliveryState !== "dead_letter" && rawDeliveryState !== "retryable_failed") continue;
        const deliveryState = rawDeliveryState === "dead_letter"
          ? "dead_letter"
          : "retryable_failed";
        if (deliveryState === "dead_letter" && data.deadLetterAcknowledged === true) {
          const acknowledgedAtIso = iso(data.deadLetterAcknowledgedAtIso) || null;
          const candidate: ResultMailAcknowledgement = {
            outboxId: doc.id,
            submissionId,
            acknowledged: true,
            acknowledgedAtIso,
            acknowledgedBy: text(data.deadLetterAcknowledgedBy, 180) || null,
            acknowledgedByRole: text(data.deadLetterAcknowledgedByRole, 80) || null,
            acknowledgedReason: text(data.deadLetterAcknowledgedReason, 500) || null,
          };
          const existingAcknowledgement = acknowledgements.get(submissionId);
          if (
            !existingAcknowledgement
            || (acknowledgedAtIso ?? "") > (existingAcknowledgement.acknowledgedAtIso ?? "")
          ) {
            acknowledgements.set(submissionId, candidate);
          }
          continue;
        }
        // Missing legacy field means unacknowledged. Only explicit true suppresses dead_letter.
        const existing = alerts.get(submissionId);
        // 한 제출에 실패 행이 여럿이면 **더 나쁜 쪽**을 남긴다 — dead_letter 는 재시도가 끝난
        // 상태라 retryable_failed 에 가려지면 안 된다.
        if (existing && (existing.deliveryState === "dead_letter" || deliveryState !== "dead_letter")) {
          continue;
        }
        alerts.set(submissionId, { deliveryState, outboxId: doc.id });
      }
      cursor = page.nextCursor;
      if (!cursor) {
        return {
          alerts,
          acknowledgements,
          scanned,
          status: "ok",
          limit: pageLimit * maxPages,
          pages,
        };
      }
    }
    return {
      alerts,
      acknowledgements,
      scanned,
      status: "incomplete",
      limit: pageLimit * maxPages,
      pages,
      reason: "scan_limit_reached",
    };
  } catch (error) {
    return emptyResultMailAlertScan("unavailable", sanitizeScanFailureReason(error));
  }
}

async function loadResultMailAlerts(): Promise<ResultMailAlertScan> {
  return scanResultMailAlertsSafe(async (cursor, pageLimit) => {
    let query: FirebaseFirestore.Query = adminDb
      .collection(SCP_VIDEO_RESULT_MAIL_OUTBOX_COLLECTION)
      .where("deliveryState", "in", ["dead_letter", "retryable_failed"])
      .select(
        "submissionId",
        "deliveryState",
        "deadLetterAcknowledged",
        "deadLetterAcknowledgedAtIso",
        "deadLetterAcknowledgedBy",
        "deadLetterAcknowledgedByRole",
        "deadLetterAcknowledgedReason",
      )
      .limit(pageLimit);
    if (cursor) query = query.startAfter(cursor as FirebaseFirestore.DocumentSnapshot);
    const snapshot = await query.get();
    return {
      docs: snapshot.docs.map((doc) => ({
        id: doc.id,
        data: record(doc.data()),
      })),
      scanned: snapshot.size,
      nextCursor: snapshot.size === pageLimit ? snapshot.docs.at(-1) ?? null : null,
    };
  });
}

async function loadResultMailAlertsForSubmissionIds(
  submissionIds: readonly string[],
): Promise<ResultMailAlertScan> {
  const uniqueSubmissionIds = [...new Set(submissionIds.map((id) => text(id, 500)).filter(Boolean))].slice(0, 2);
  if (uniqueSubmissionIds.length === 0) return emptyResultMailAlertScan("ok");
  const pageLimit = 50;
  return scanResultMailAlertsSafe(async () => {
    const snapshot = await adminDb
      .collection(SCP_VIDEO_RESULT_MAIL_OUTBOX_COLLECTION)
      .where("submissionId", "in", uniqueSubmissionIds)
      .select(
        "submissionId",
        "deliveryState",
        "deadLetterAcknowledged",
        "deadLetterAcknowledgedAtIso",
        "deadLetterAcknowledgedBy",
        "deadLetterAcknowledgedByRole",
        "deadLetterAcknowledgedReason",
      )
      .limit(pageLimit)
      .get();
    return {
      docs: snapshot.docs.map((doc) => ({
        id: doc.id,
        data: record(doc.data()),
      })),
      scanned: snapshot.size,
      nextCursor: snapshot.size >= pageLimit ? "scan_limit_reached" : null,
    };
  }, { pageLimit, maxPages: 1 });
}

export async function acknowledgeVideoResultMailDeadLetterAlertHandler(
  request: CallableRequestShape,
  options: {
    readonly db?: FirebaseFirestore.Firestore;
    readonly nowIso?: string;
  } = {},
) {
  const action = "video_review.result_mail_dead_letter.acknowledge";
  const auth = assertNonGuestAuth(request, action, OPERATOR_ROLES);
  // 2026-09-27 codex adversarial review FAIL-3: its only reachable UI is
  // VideoResultMailAlertControl.tsx, rendered exclusively inside ReviewWorkspace.tsx/
  // CanonicalVideoReviewPanel.tsx (both only render inside the entitlement-gated /flu/scp page) —
  // a role-permitted but non-entitled manager could otherwise mutate an scp mail outbox
  // acknowledgement by calling this callable directly.
  await assertScpEntitled(auth, request, action);
  const input = asRecord(request.data);
  const outboxId = text(input.outboxId, 220);
  if (!outboxId || outboxId.includes("/")) throw invalidArgument("outboxId is required");
  if (input.acknowledged !== true && input.acknowledged !== false) {
    throw invalidArgument("acknowledged boolean is required");
  }
  const acknowledged = input.acknowledged === true;
  const reason = text(input.reason, 500);
  const db = options.db ?? adminDb;
  const nowIso = iso(options.nowIso) || new Date().toISOString();
  const ref = db.collection(SCP_VIDEO_RESULT_MAIL_OUTBOX_COLLECTION).doc(outboxId);
  const result = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      const error = new Error("not-found: result mail outbox row not found");
      Object.assign(error, { code: "not-found", errorCode: "result_mail_dead_letter_not_found" });
      throw error;
    }
    const data = record(snapshot.data());
    if (text(data.deliveryState, 80) !== "dead_letter") {
      const error = new Error("failed-precondition: only dead_letter rows can be acknowledged");
      Object.assign(error, { code: "failed-precondition", errorCode: "result_mail_ack_requires_dead_letter" });
      throw error;
    }
    const submissionId = text(data.submissionId, 500);
    const patch: Record<string, unknown> = acknowledged
      ? {
          deadLetterAcknowledged: true,
          deadLetterAcknowledgedAtIso: nowIso,
          deadLetterAcknowledgedBy: auth.userId,
          deadLetterAcknowledgedByRole: auth.role,
          deadLetterAcknowledgedReason: reason || null,
        }
      : {
          deadLetterAcknowledged: false,
          deadLetterAcknowledgedAtIso: null,
          deadLetterAcknowledgedBy: null,
          deadLetterAcknowledgedByRole: null,
          deadLetterAcknowledgedReason: null,
        };
    transaction.set(ref, patch, { merge: true });
    return {
      submissionId,
      acknowledgedAtIso: acknowledged ? nowIso : null,
    };
  });
  return {
    ok: true,
    outboxId,
    submissionId: result.submissionId,
    acknowledged,
    acknowledgedAtIso: result.acknowledgedAtIso,
    behaviorLog: makeBehaviorLog(auth, action, "success"),
  };
}

/**
 * W126: 미리보기의 에스컬레이션 계수. 판정 전이라 이번 1건을 더한 값이 드레인의 계수와 같다.
 * 승인은 사유 축이 없고, 사유 코드가 없으면 "같은 사유"가 정의되지 않으므로 둘 다 0 이다.
 */
export function mailPreviewEscalationBaseCount(
  relatedHistory: ScpVideoReviewStateRow["relatedHistory"],
  reasonCode: string,
  mailKind: string,
): number {
  if (!relatedHistory || !reasonCode || mailKind === "content_approved") return 0;
  // W126 [적대 리뷰 H1]: **+1 은 "드레인이 이번 판정을 셀 것"이라는 예측**이다. 이 문서가
  //   표본 창 밖이면 드레인도 못 읽으므로 그 예측이 틀린다 — 그때는 더하지 않는다.
  //   (안 더하면 미리보기 계수가 드레인과 같아지고, 임계 미만이면 양쪽 다 문장이 없다.)
  // W126 [적대 리뷰 H1-R1]: "안 더하기" 는 `trunc(prior)` 다 — **0 이 아니다.** 직전 라운드는
  //   `!creatorSampleIncludesSelf` 에서 바로 `return 0` 을 내려, 창 밖 문서가 이미 통지받은
  //   반려 이력(prior)까지 통째로 지워버렸다 — prior=50 이어도 미리보기=0·드레인=50 이 되어
  //   원래 결함(운영자만 봄)보다 나쁜 방향(크리에이터만 받음)으로 WYSIWYG 를 깼다. prior 를
  //   먼저 계산하고, self 포함 여부는 이번 판정의 +1 여부만 좌우한다.
  const prior = Number(relatedHistory.creatorNotifiedDeclineReasonCounts?.[reasonCode] ?? 0);
  if (!Number.isFinite(prior) || prior <= 0) return 0;
  return relatedHistory.creatorSampleIncludesSelf ? Math.trunc(prior) + 1 : Math.trunc(prior);
}

export function slimReviewStateProjection(
  row: ScpVideoReviewStateRow,
): ScpVideoReviewStateRow {
  return {
    ...row,
    detailHydrated: false,
    aiRecommendation: null,
    aiJudge: null,
    duplicateEvidence: null,
    voiceEvidence: null,
    ruleEvidenceLedger: [],
    decisionLedger: [],
    // W120: reviewHistorySummary·media.availability 는 슬림 응답에도 남는다 — 추가 조회가 없고,
    // 큐 배지·필터가 그 값을 쓴다. relatedHistory 만 상세 전용이라 여기서 지운다.
    // W126: postDecisionStatus 도 같은 이유로 남는다 — resultMailAlert 가 큐 필터·배지의 출처다.
    relatedHistory: null,
    evidence: null,
    reviewHistory: [],
    portalProjection: null,
    mailPreview: null,
    canonicalRevision: {
      ...row.canonicalRevision,
      available: false,
      unavailableReason: row.sourceSubmissionId
        ? "detail_not_loaded"
        : "source_submission_ref_unavailable",
      portalProjection: null,
    },
  };
}

/**
 * 2026-09-27 codex adversarial review round 1 FAIL-3, revised in round 2: this callable's rich
 * row (media, ai judge, postDecisionStatus incl. resultMailAlert, reviewHistorySummary, etc.) is
 * scp review-state content, not general-purpose data. Round 1 shipped an allowlist down-projection
 * (partnersSafeReviewStateProjection) for the general-purpose Partners page (src/app/(app)/flu/
 * partners/page.tsx's loadReviewStateSubmitters), reusing this handler's already-computed rows
 * instead of duplicating its heavy cross-collection enrichment in a second callable — round 2
 * adversarial review found that projection still leaked scp review ids/states/creator ids and the
 * unfiltered attributionContext (which can carry application names/ids) to a non-entitled caller.
 * "non-granted never see scp" means zero scp rows, not a smaller scp row — see
 * listScpVideoReviewStatesHandler's final return below, which now returns an empty list instead.
 * Partners' band 2 section is already a union of this list and the legacy `submissions` source
 * (src/app/(app)/flu/partners/page.tsx's mergeSubmissionBandRows), so an empty list here just
 * means that union degrades to the legacy-only rows — no separate "hide the section" UI change
 * needed.
 */

export async function listScpVideoReviewStatesHandler(
  request: CallableRequestShape,
  options: {
    readonly youtubeApi?: ReviewVideoApi;
    readonly nowIso?: string;
    readonly recipientResolver?: RecipientResolver;
    // 테스트 심(에뮬레이터 전용): 필터 스캔 상한을 **아래로만** 낮출 수 있다(프로드 상한 초과 불가).
    readonly titleFilterScanCap?: number;
    readonly titleFilterScanChunk?: number;
  } = {},
) {
  const auth = assertNonGuestAuth(
    request,
    "video_review.states.list",
    OPERATOR_ROLES,
  );
  // 2026-09-27 codex adversarial review (rounds 1-2): computed once, used at the end to decide
  // between the full/slim scp review-state row (entitled) and an empty list (not entitled) — see
  // the comment above this function for why the general-purpose Partners page still needs a
  // (now scp-empty) response from this same callable rather than a hard denial.
  const scpEntitled = await isCallerScpEntitled(auth.email ?? "", auth.role === "super_admin", { userId: auth.userId });
  const data = asRecord(request.data);
  const detailId = text(data.detailId, 180);
  const mailPreviewTarget = text(data.mailPreviewTarget, 40);
  const mailPreviewKind = mailKindForPreviewTarget(mailPreviewTarget);
  if (mailPreviewTarget && (!detailId || !mailPreviewKind)) {
    throw invalidArgument(
      "mailPreviewTarget requires a detailId and a supported decision target",
    );
  }
  const limit = boundedReviewStatePageLimit(data.limit);
  const cursor = decodeCursor(data.cursor);
  const programIdFilter = text(data.programId, 180);
  const campaignIdFilter = text(data.campaignId, 180);
  // Task-53: 배지는 TTL 캐시를 거친다(reviewQueueCountsCache.ts — 필터 있는 버킷 5분, 무필터
  // 버킷 20초) — 판정/수집이 실제로 상태를 바꾸면(videoReviewTransitionStore.ts·
  // scpVideoRevisionIngress.ts) 그 즉시 비워지므로 상세 화면과의 체감 지연은 없다.
  const countsCacheRequest = detailId
    ? null
    : cachedReviewQueueCounts(
      programIdFilter,
      campaignIdFilter,
      () => reviewQueueCounts(programIdFilter, campaignIdFilter),
    );
  const countsPromise = countsCacheRequest ? countsCacheRequest.value : Promise.resolve(null);
  // 다타이틀 배지·필터의 유일한 이름 출처. 상세 요청도 배지를 그려야 하므로 항상 해석한다
  // (문서 1건 읽기 + 60초 프로세스 캐시).
  const titleRegistry = await reviewTitleRegistry(programIdFilter);
  // 사내 라벨 판정에 넘길 등록 타이틀 이름들 — "Snake Clash content" 같은 새 라벨도 진짜 제목으로
  // 승격되지 않는다(videoTitleProjection 은 의존성이 없어야 해서 이름을 인자로 받는다).
  const titleNames = titleRegistry.titles.map((title) => title.name);
  // W7-1c-fix (2026-09-06): reviewQueueCounts 위의 identityProgramIds 와 **같은 스코프**를 목록
  // 쿼리에도 건다 — 배지(count)와 목록이 서로 다른 쿼리를 쓰던 것(Q6, 2026-09-05 딥체크)이
  // "전체 1 / 목록 0건" 의 근본 원인이었다.
  const identityProgramIds = programIdFilter ? reviewStateIdentityProgramIds(programIdFilter) : [];
  let query: FirebaseFirestore.Query = adminDb.collection(SCP_VIDEO_REVIEW_STATE_COLLECTION);
  if (identityProgramIds.length === 1) {
    query = query.where("canonicalProgramId", "==", identityProgramIds[0]);
  } else if (identityProgramIds.length > 1) {
    query = query.where("canonicalProgramId", "in", identityProgramIds);
  }
  query = query.orderBy("updatedAtIso", "desc").orderBy("__name__", "desc");

  // 다타이틀 서버 필터(task-88/89/90). titleId 가 오면 `where` 절이 아니라 위 쿼리 모양 그대로를
  //   커서 순서로 훑는 유계 스캔으로 걸러낸다 — 상수 주석(TITLE_FILTER_SCAN_CHUNK) 참조.
  const titleIdFilter = text(data.titleId, 120);
  const titleFilterActive = Boolean(titleIdFilter) && !detailId;
  // 커서는 발급된 필터 스코프에 묶인다 — 다른 titleId(또는 무필터)로 발급된 커서를 이 요청에
  //   재사용하면 스캔 위치는 맞아도 앞쪽 일치 행을 건너뛴다. 스코프가 다르면 거부한다.
  if (cursor && (cursor.titleId ?? "") !== (titleFilterActive ? titleIdFilter : "")) {
    throw invalidArgument("cursor was minted for a different titleId filter scope");
  }
  // 레지스트리에 없는 titleId 는 어떤 행으로도 해석될 수 없다(strict 헬퍼의 resolved 출력은
  //   항상 레지스트리 id 다) — 스캔을 생략하고 빈 페이지를 돌려준다(registered:false 로 밝힌다).
  const titleFilterRegistered =
    titleFilterActive && titleRegistry.titles.some((title) => title.id === titleIdFilter);
  const titleFilterScanCap = Math.min(
    Math.trunc(Number(options.titleFilterScanCap)) > 0
      ? Math.trunc(Number(options.titleFilterScanCap))
      : TITLE_FILTER_SCAN_CAP,
    TITLE_FILTER_SCAN_CAP,
  );
  const titleFilterScanChunk = Math.min(
    Math.trunc(Number(options.titleFilterScanChunk)) > 0
      ? Math.trunc(Number(options.titleFilterScanChunk))
      : TITLE_FILTER_SCAN_CHUNK,
    TITLE_FILTER_SCAN_CHUNK,
  );
  let filteredDocs: FirebaseFirestore.QueryDocumentSnapshot[] | null = null;
  // nextCursor 앵커 후보 둘 — 마지막 **평가** 문서(lastEvaluated)와 마지막 **수집** 문서
  //   (lastCollected). 이미 읽은 청크 안에서 페이지가 찬 뒤 매치가 더 나오면(droppedMatch)
  //   커서를 lastCollected 로 되돌려 다음 요청이 그 잉여 매치부터 이어 받는다 — 버려지는
  //   매치 없음. 아니면 lastEvaluated 로 진행해 평가 끝난 문서를 다시 읽지 않는다.
  let titleFilterLastEvaluated: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  let titleFilterLastCollected: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  let titleFilterDroppedMatch = false;
  let titleFilterScanned = 0;
  let titleFilterExhausted = false;
  if (titleFilterActive) {
    filteredDocs = [];
    if (!titleFilterRegistered) {
      titleFilterExhausted = true;
    } else {
      let scanCursor = cursor;
      while (
        filteredDocs.length < limit
        && !titleFilterDroppedMatch
        && titleFilterScanned < titleFilterScanCap
      ) {
        const chunkLimit = Math.min(titleFilterScanChunk, titleFilterScanCap - titleFilterScanned);
        const page = await (scanCursor
          ? query.startAfter(scanCursor.updatedAtIso, scanCursor.id)
          : query
        ).limit(chunkLimit).get();
        titleFilterScanned += page.size;
        for (const doc of page.docs) {
          titleFilterLastEvaluated = doc;
          const docData = doc.data() ?? {};
          if (isOperationalFixtureRecord(
            { id: doc.id, ...docData },
            SCP_VIDEO_REVIEW_STATE_COLLECTION,
          )) continue;
          if (!reviewStateDocMatchesTitleId(titleRegistry, docData, titleIdFilter)) continue;
          if (filteredDocs.length >= limit) {
            titleFilterDroppedMatch = true;
            break;
          }
          filteredDocs.push(doc);
          titleFilterLastCollected = doc;
        }
        if (page.size < chunkLimit) {
          titleFilterExhausted = true;
          break;
        }
        if (titleFilterLastEvaluated) {
          scanCursor = {
            updatedAtIso: text(titleFilterLastEvaluated.data()?.updatedAtIso, 80),
            id: titleFilterLastEvaluated.id,
          };
        }
      }
    }
  }
  const snapshot = detailId
    ? { docs: [await adminDb.collection(SCP_VIDEO_REVIEW_STATE_COLLECTION).doc(detailId).get()].filter((doc) => doc.exists), size: 1 }
    : filteredDocs
      ? { docs: filteredDocs, size: filteredDocs.length }
      : await (cursor ? query.startAfter(cursor.updatedAtIso, cursor.id) : query).limit(limit).get();

  // 시드/픽스처 제출은 검수 대기 목록에 실제 제출처럼 섞이면 안 된다(파트너 목록과 같은 규칙).
  // 붙는 creators 문서도 없어서 이름 자리에 raw seed id 가 뜨던 행이 여기서 걸러진다.
  let visibleDocs = snapshot.docs.filter(
    (doc) => !isOperationalFixtureRecord(
      { id: doc.id, ...(doc.data() ?? {}) },
      SCP_VIDEO_REVIEW_STATE_COLLECTION,
    ),
  );

  const applicationProgramIdLookup = createApplicationProgramIdLookup();

  // E2 (2026-09-06 Aside 게이트 후속): 배지(reviewQueueCounts)는 이 조인을 못 해서
  // countsIncludeUnresolved:false 로만 "하한"임을 알렸지만, 화면에는 그 사실을 보여줄 숫자가
  // 없었다(실측: 배지 "전체 1" vs 목록 2건). 아래에서 실제로 조인·합류된 행 수를 세어 응답에
  // 실으면, 화면이 "배지는 하한값 — 프로그램 미해석 행 N건은 목록에만 포함"을 말할 수 있다.
  let portalAliasSplicedRowCount = 0;
  // Task-53 [COST-P0-006]: 스플라이스 스캔 캐시 히트 여부. 로그에만 쓴다(응답 스키마는 불변).
  let portalAliasSpliceCacheHit = false;

  // W7-1c-fix: 백필 전까지 CPM 등 진짜 프로그램의 행은 대부분 포털 전역 태그(view-cpm)로만
  // 남아 있어(2026-09-05 딥체크: 229/231건), 위의 identityProgramIds 쿼리만으로는 첫 페이지가
  // 텅 빈다. 첫 페이지(cursor 없음)에 한해 view-cpm 태그 행을 유계로 더 훑어 리졸버로 실
  // 프로그램을 조인하고, 요청된 프로그램과 일치하는 것만 합류시킨다. 목록 전용 보정이라
  // reviewQueueCounts(배지)는 이 조인을 하지 않는다 — count() 집계는 행 본문을 못 읽으므로
  // 조인이 불가능하다(그래서 배지는 countsIncludeUnresolved:false 로 하한임을 알린다).
  if (programIdFilter && !detailId && !cursor) {
    const requestedCanonicalProgramId = resolveCanonicalProgramId(programIdFilter);
    // Task-53: 이 최대 1000건 스캔 자체가 요청당 비용이다(리졸버 조인은 이미 배치돼 있다) — 원본
    // 스캔 결과만 5분 TTL 캐시한다. programId 로 갈리지 않는다(스캔은 프로그램 무관, 매칭은 매
    // 요청에서 신선한 applicationProgramIdLookup 으로 한다 — 아래 그대로).
    const portalAliasSpliceRequest = cachedPortalAliasSpliceSnapshot(
      () => adminDb
        .collection(SCP_VIDEO_REVIEW_STATE_COLLECTION)
        .where("canonicalProgramId", "==", REVIEW_STATE_PORTAL_PROGRAM_ALIAS_IDS[0])
        .orderBy("updatedAtIso", "desc")
        .orderBy("__name__", "desc")
        .limit(PORTAL_ALIAS_PROGRAM_SPLICE_SCAN_CAP)
        .get()
        .then((snapshot) => snapshot.docs),
    );
    portalAliasSpliceCacheHit = portalAliasSpliceRequest.cacheHit;
    const portalAliasDocs = await portalAliasSpliceRequest.value;
    const existingIds = new Set(visibleDocs.map((doc) => doc.id));
    const candidates = portalAliasDocs.filter(
      (doc) => !existingIds.has(doc.id)
        && !isOperationalFixtureRecord({ id: doc.id, ...(doc.data() ?? {}) }, SCP_VIDEO_REVIEW_STATE_COLLECTION)
        // titleId 필터가 걸려 있으면 스플라이스도 같은 술어를 거친다 — 필터된 첫 페이지에
        //   다른 타이틀의 포털 별칭 행이 섞이면 안 된다.
        && (!titleFilterActive || reviewStateDocMatchesTitleId(titleRegistry, doc.data() ?? {}, titleIdFilter)),
    );
    await applicationProgramIdLookup.prime(
      candidates.map((doc) => text(record(record(doc.data()).subject).applicationId, 180)),
    );
    const resolvedMatches = await Promise.all(candidates.map(async (doc) => {
      const rowData = doc.data() ?? {};
      const resolution = await resolveReviewStateProgramId(
        { canonicalProgramId: rowData.canonicalProgramId, subject: record(rowData.subject) },
        applicationProgramIdLookup,
      );
      return resolution.programId === requestedCanonicalProgramId ? doc : null;
    }));
    const matchedDocs = resolvedMatches.filter((doc): doc is FirebaseFirestore.QueryDocumentSnapshot => Boolean(doc));
    if (matchedDocs.length > 0) {
      const matchedIds = new Set(matchedDocs.map((doc) => doc.id));
      visibleDocs = [...visibleDocs, ...matchedDocs]
        .sort((left, right) => (
          text(right.data()?.updatedAtIso, 80).localeCompare(text(left.data()?.updatedAtIso, 80))
          || right.id.localeCompare(left.id)
        ))
        .slice(0, limit);
      // slice(0, limit) 뒤에도 살아남은 행만 센다 — 잘려나간 매치는 이번 응답에 안 실리니
      // "목록에만 포함된 N건"이 아니다.
      portalAliasSplicedRowCount = visibleDocs.filter((doc) => matchedIds.has(doc.id)).length;
    }
  }

  const stateRecords = visibleDocs.map((doc) => {
    const state = doc.data() ?? {};
    const subject = record(state.subject);
    const sourceSubmissionId = text(subject.sourceSubmissionId, 180);
    const portalProjectionId = sourceSubmissionId
      ? portalSubmissionProjectionDocumentId(sourceSubmissionId)
      : "";
    const videoSubmissionId = text(subject.videoSubmissionId, 500) || doc.id;
    const transitionSeq = Number(
      state.lastTransitionSeq ??
        (Array.isArray(state.reviewLedger) ? state.reviewLedger.length : 0),
    );
    const outboxId = reviewOutboxDocumentId(videoSubmissionId, transitionSeq);
    return {
      doc,
      state,
      subject,
      sourceSubmissionId,
      portalProjectionId,
      videoSubmissionId,
      transitionSeq,
      outboxId,
    };
  });

  // W7-1c-fix: every row whose canonicalProgramId is still empty or the Portal's shared
  // apply-gate tag gets resolved before any downstream join/output — `programs/${...}` joins
  // below and the client's program filter (src/modules/programs/reviewScope.ts) both must see
  // the real program. Rows already carrying a real id (the common case once the write-path fix
  // and the backfill land) never reach this: the length check below skips the extra Firestore
  // round trip entirely, so this page costs nothing beyond what it already cost.
  const rowsNeedingProgramResolution = stateRecords.filter((item) => {
    const raw = text(item.state.canonicalProgramId, 180);
    return !raw || isReviewStatePortalAliasProgramId(raw);
  });
  if (rowsNeedingProgramResolution.length > 0) {
    await applicationProgramIdLookup.prime(
      rowsNeedingProgramResolution.map((item) => text(item.subject.applicationId, 180)),
    );
    await Promise.all(rowsNeedingProgramResolution.map(async (item) => {
      const resolution = await resolveReviewStateProgramId(
        { canonicalProgramId: item.state.canonicalProgramId, subject: item.subject },
        applicationProgramIdLookup,
      );
      item.state.canonicalProgramId = resolution.programId;
      item.state.portalProgramId = resolution.portalProgramId;
      item.state.programUnresolved = resolution.programUnresolved;
    }));
  }

  // 목록은 상세 조인(`videos`)을 하지 않으므로 제출 직후 영상의 채널명이 비어 있었다.
  // 최대 50개인 페이지의 videoId를 videos.list 한 번에 넣고, 실패하면 기존 투영으로 정상 폴백한다.
  let reviewVideoMetadata = new Map<string, ReviewVideoMetadata>();
  // W120: 같은 응답에서 링크 가용성도 받는다(추가 호출 없음). 목록이면 페이지 전체,
  // 상세면 그 한 건 — 즉 **검수 진입 시점에 재검증이 한 번 더 돈다**.
  // W123 적대 리뷰 H3: 이 재검증 계약이 캐시보다 우선한다. 상세(`detailId`) 요청은 가용성 캐시를
  //   **우회**한다 — 아래 `bypassCache` 참조. 전이 콜러블에는 서버측 가용성 확인이 없어 이 배지가
  //   유일한 방어선이고, 배지는 available 이면 아무것도 렌더하지 않는다. 5분짜리 캐시를 태우면
  //   "삭제된 영상을 승인하는 창"이 정확히 그 TTL 만큼 열린다.
  let reviewVideoAvailability = new Map<string, ReviewVideoAvailability>();
  const reviewVideoIds = stateRecords
    .map((item) => text(item.state.youtubeVideoId, 60))
    .filter(Boolean);
  // W123: videoId 단위 짧은 TTL 캐시를 통과한다. 목록에서 받아 둔 id 를 상세에서 다시 열면
  //   외부 호출이 0 이 된다(미스가 없으면 `load` 자체를 부르지 않는다). 정책은 캐시 모듈에 있다.
  const cacheScope: ReviewCacheAuthScope = {
    userId: auth.userId,
    role: auth.role,
    gameId: auth.gameId,
  };
  let videoSignalHits = 0;
  let videoSignalMisses = 0;
  // §4.11: 상세 진입은 **정책상** 캐시를 안 읽는다(H3 우회). 그것을 미스로 세면 누적 스냅샷의
  //   히트율이 구조적으로 낮게 나와 "캐시가 안 듣는다"로 오독된다 — 칸을 나눠 센다.
  let videoSignalBypasses = 0;
  let youtubeApiCalls = 0;
  if (reviewVideoIds.length > 0) {
    try {
      const signals = await cachedReviewVideoSignals<ReviewVideoMetadata, ReviewVideoAvailability>({
        scope: cacheScope,
        videoIds: reviewVideoIds,
        // H3: 상세 진입은 재검증이 계약이라 캐시를 읽지 않는다(그래도 결과는 담아 목록 배치가
        //   쓰게 한다). 상세는 페이지당 1건이라 외부 호출 1회가 늘 뿐이고, 목록 50건 배치 절감은
        //   그대로 남는다 — 안전이 훨씬 싸다.
        bypassCache: Boolean(detailId),
        // API 장애로 못 본 id(`unknown`)는 담지 않는다 — 담으면 TTL 동안 복구를 못 본다.
        isCacheable: (availability) => availability !== "unknown",
        fallbackAvailability: "unknown",
        load: (missing) => fetchReviewVideoSignals(
          options.youtubeApi ?? makeYouTubeDataApiClient(),
          missing,
          options.nowIso ?? new Date().toISOString(),
        ),
      });
      reviewVideoMetadata = signals.metadata;
      reviewVideoAvailability = signals.availability;
      videoSignalHits = signals.hits;
      videoSignalMisses = signals.misses;
      videoSignalBypasses = signals.bypasses;
      youtubeApiCalls = signals.apiCalls;
    } catch (error) {
      console.warn("[video-review-list] YouTube metadata enrichment unavailable", {
        videoCount: new Set(reviewVideoIds).size,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // W120: 재제출·이력은 상세 진입에서만 조회한다(목록 1회에 50 쿼리가 붙지 않게).
  // W123: 미리보기 전용 콜러블이 없어 같은 상세가 클릭마다 통째로 다시 도는 구조라, 같은 세대의
  //   같은 제출이면 그 2쿼리(≤58 read)를 다시 돌지 않는다. 이 제출이 바뀌면 세대값이 갈려 즉시 무효다.
  // L2: 세대값 두 축이 **둘 다** 없으면 무효화 신호가 하나도 없다(상수 키가 되어 TTL 이 끝날
  //   때까지 절대 갈리지 않는다). 그런 행은 캐시를 태우지 않는다 — 못 믿을 키로 담느니 안 담는다.
  const relatedHistoryGeneration = detailId && stateRecords.length > 0
    ? `${text(stateRecords[0].state.updatedAtIso, 80)}#${stateRecords[0].transitionSeq || ""}`
    : "";
  const relatedHistoryCacheable = relatedHistoryGeneration !== "#";
  const relatedHistoryRequest = detailId && stateRecords.length > 0 && relatedHistoryCacheable
    ? cachedRelatedReviewHistory({
      scope: cacheScope,
      detailId,
      generation: relatedHistoryGeneration,
      load: () => loadRelatedReviewHistory(stateRecords[0]),
    })
    : detailId && stateRecords.length > 0
      ? { value: loadRelatedReviewHistory(stateRecords[0]), cacheHit: false }
      : null;
  const relatedHistory = relatedHistoryRequest
    ? await relatedHistoryRequest.value.catch((error: unknown) => {
      console.warn("[video-review-list] related review history unavailable", {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    })
    : null;
  // W126: 메일 실패 표면화는 **큐 목록에서만** 돈다. 상세는 이미 현재 seq 의 아웃박스 행을
  //   조인해 실제 deliveryState 를 들고 있고, 필터가 사는 곳도 큐다.
  //   실패는 스캔이 아니라 값이다 — 조회가 죽으면 상태를 응답에 싣고 목록은 그대로 나간다.
  const resultMailAlertScan = detailId
    ? await loadResultMailAlertsForSubmissionIds(stateRecords.flatMap((item) => [
        item.videoSubmissionId,
        item.doc.id,
      ]))
    : await loadResultMailAlerts();
  const resultMailAlerts = resultMailAlertScan.alerts;
  const resultMailAcknowledgements = resultMailAlertScan.acknowledgements;
  if (resultMailAlertScan.status === "unavailable") {
    console.warn("[video-review-list]", JSON.stringify({
      outcome: "result_mail_alerts_unavailable",
      reason: resultMailAlertScan.reason ?? null,
    }));
  }
  // COST-P0-006: 캐시 히트/미스와 그것이 아낀 외부호출·읽기를 **건수로만** 남긴다.
  //   식별자(videoId·제출 id)도 본문도 싣지 않는다(SEC-P0-009).
  // L4: 로깅도 비용이다(구조화 로그 1줄이 read 1건보다 비싸다). **말할 것이 있을 때만** 남긴다 —
  //   전량 히트한 목록 회차(0 미스·0 외부호출·이력 없음)는 새 정보가 없으므로 조용히 지나간다.
  // Task-53: 배지(9개 count() 집계)·포털 별칭 스플라이스(최대 1000건 스캔) 캐시 미스도 같은 L4
  //   규율로 — 미스는 Firestore 왕복이 실제로 나갔다는 뜻이라 새 정보다.
  const queueCountsCacheMiss = countsCacheRequest ? !countsCacheRequest.cacheHit : false;
  const portalAliasSpliceCacheMiss = programIdFilter && !detailId && !cursor && !portalAliasSpliceCacheHit;
  // 다타이틀: 필터 스캔은 실제 Firestore 읽기라 새 정보다 — 스캔이 한 건도 안 나간
  //   회차(필터 없음·미등록 titleId 숏서킷·이미 고갈)는 scanned=0 이라 조용히 지나간다.
  if (videoSignalMisses > 0 || videoSignalBypasses > 0 || youtubeApiCalls > 0 || relatedHistoryRequest || queueCountsCacheMiss || portalAliasSpliceCacheMiss || titleFilterScanned > 0) console.log("[video-review-list]", JSON.stringify({
    outcome: "cache",
    detail: Boolean(detailId),
    videoSignalHits,
    videoSignalMisses,
    videoSignalBypasses,
    youtubeApiCalls,
    titleFilterScanned,
    relatedHistoryCacheHit: relatedHistoryRequest?.cacheHit ?? false,
    relatedHistoryReadsAvoidedMax: relatedHistoryRequest?.cacheHit ? RELATED_HISTORY_MAX_READS : 0,
    queueCountsCacheHit: countsCacheRequest?.cacheHit ?? null,
    portalAliasSpliceCacheHit: (programIdFilter && !detailId && !cursor) ? portalAliasSpliceCacheHit : null,
    // W126 [COST-P0-006]: 메일 실패 스캔이 읽은 행 수. **게이트가 아니라 칸**으로 넣는다 —
    //   조건식에 이 값을 더하면 위 L4 규율이 무력화된다. dead_letter 는 종결 상태라(드레인 후보
    //   쿼리가 queued·leased·retryable_failed 만 집는다) 한 번 생기면 컬렉션에 영구히 남고
    //   — 프로드에 이미 2건이 그렇게 있다 — 그 순간 조건이 **상시 참**이 돼 전량 캐시 히트한
    //   회차까지 매번 로그가 나간다. 별도 줄로 빼도 결과는 같다.
    resultMailAlertReads: resultMailAlertScan.scanned,
  }));
  // W126 [적대 리뷰 M3] 계측 범위 — **명시적 결정**이다(부수효과 아님):
  //   목록 요청은 relatedHistoryRequest 가 항상 null 이라, 웜캐시 회차에서는 위 줄 전체가
  //   억제된다 → 그 회차의 스캔 read 는 로그에 남지 않는다. 그래도 매 회차 로그를 켜지 않는
  //   이유는 (a) 상한이 코드 상수(RESULT_MAIL_ALERT_SCAN_LIMIT)로 못박혀 최악 비용이 이미
  //   알려져 있고, (b) 변동분은 곧 dead_letter·retryable_failed 행 수인데 그 값은 Slack 일일
  //   리포트의 dead_letter 칸이 매일 보고하며, (c) 상시 참인 조건으로 줄을 내면 로깅 비용이
  //   절감한 read 를 되돌려주기 때문이다(W123 L4). **절단만 예외**로 경고를 낸다 — 그때는
  //   배지·필터가 실패 행을 조용히 빠뜨리는 정확도 결함이라 새 정보다.
  if (resultMailAlertScan.status === "incomplete") {
    console.warn("[video-review-list]", JSON.stringify({
      outcome: "result_mail_alert_scan_truncated",
      resultMailAlertReads: resultMailAlertScan.scanned,
      resultMailAlertScanLimit: resultMailAlertScan.limit,
      resultMailAlertScanPages: resultMailAlertScan.pages,
    }));
  }

  const refs: FirebaseFirestore.DocumentReference[] = [];
  const refKeys: string[] = [];
  for (const item of detailId ? stateRecords : []) {
    if (item.sourceSubmissionId) {
      refs.push(
        adminDb
          .collection(PORTAL_SUBMISSION_PROJECTION_COLLECTION)
          .doc(item.portalProjectionId),
      );
      refKeys.push(`portal:${item.doc.id}`);
    }
    const fluCreatorId = text(item.subject.fluCreatorId, 180);
    if (fluCreatorId) {
      refs.push(adminDb.collection(CREATORS_COLLECTION).doc(fluCreatorId));
      refKeys.push(`creator:${item.doc.id}`);
    }
    // 신원 폴백 1단계: creators 문서가 channelId 를 문서 id 로 쓰는 경우(운영 실측 존재).
    // 같은 배치에 넣으므로 추가 왕복은 없다.
    const subjectChannelId = text(item.subject.channelId, 64) || text(item.state.channelId, 64);
    // ⚠️ 문서 id 조인 전에 반드시 UC 형태를 확인한다. 원장에 채널 URL 이나 센티널
    // (`unclassified:channel:…`)이 들어오면 슬래시·콜론 때문에 .doc() 이 던져서 목록 콜러블
    // 전체가 죽는다. 2단계 필드 조회와 같은 가드를 여기에도 적용한다.
    if (subjectChannelId && subjectChannelId !== fluCreatorId && youtubeChannelUrl(subjectChannelId)) {
      refs.push(adminDb.collection(CREATORS_COLLECTION).doc(subjectChannelId));
      refKeys.push(`creatorByChannelDoc:${item.doc.id}`);
    }
    const campaignId = text(item.subject.campaignId, 180);
    if (campaignId) {
      refs.push(adminDb.collection(CAMPAIGNS_COLLECTION).doc(campaignId));
      refKeys.push(`campaign:${item.doc.id}`);
    }
    // W7-1c: 프로그램 ref 가 배치에 아예 없어서 `attributionContext.program.name` 이 **모든 행에서
    // null** 이었다(근거 표에 "program id: view-cpm · name: (빈값)"으로 보이던 자리). 캠페인 블록과
    // 같은 결정적 문서 id 조인이며 detail 요청에서만 돈다 — 목록 왕복은 늘지 않는다.
    const programId = text(item.subject.programId, 180) || text(item.state.canonicalProgramId, 180);
    // 센티널(`unclassified:program:…`)에 슬래시가 섞이면 `.doc()` 이 던져 콜러블 전체가 죽는다.
    if (programId && !programId.includes("/")) {
      refs.push(adminDb.collection(PROGRAMS_COLLECTION).doc(programId));
      refKeys.push(`program:${item.doc.id}`);
    }
    // F6: `application:` refKey 는 아래(:919 부근)에서 읽히는데 **루프가 push 한 적이 없어**
    // attributionContext.application.name 이 영구 null 이었다(빈값 필터는 증상만 가렸다).
    // 캠페인/프로그램 블록과 같은 결정적 문서 id 조인이며 detail 요청에서만 돈다.
    const applicationId = text(item.subject.applicationId, 180);
    if (applicationId && !applicationId.includes("/")) {
      refs.push(adminDb.collection(PROGRAM_APPLICATIONS_COLLECTION).doc(applicationId));
      refKeys.push(`application:${item.doc.id}`);
    }
    if (item.outboxId) {
      refs.push(
        adminDb
          .collection(SCP_VIDEO_REVIEW_CALLBACK_OUTBOX_COLLECTION)
          .doc(item.outboxId),
      );
      refKeys.push(`callback:${item.doc.id}`);
      refs.push(
        adminDb
          .collection(SCP_VIDEO_RESULT_MAIL_OUTBOX_COLLECTION)
          .doc(item.outboxId),
      );
      refKeys.push(`mail:${item.doc.id}`);
      refs.push(
        adminDb
          .collection(SCP_VIDEO_DOWNSTREAM_CALLBACK_OUTBOX_COLLECTION)
          .doc(item.outboxId),
      );
      refKeys.push(`downstream:${item.doc.id}`);
    }
    refs.push(
      adminDb.collection("scp_video_dedup_results").doc(item.videoSubmissionId),
    );
    refKeys.push(`dedup:${item.doc.id}`);
    // 표시용 영상 제목의 정본은 `videos` 다. 검수 원장(`scp_video_review_state.title`)에 저장된 값은
    // 등록 시점의 사내 라벨("Legacy XP Hero content" 등)이라 운영 118건이 전부 라벨이었다.
    // 복사해 두면 원본이 갱신될 때 또 어긋나므로 읽는 시점에 조인한다.
    const reviewVideoId = text(item.state.youtubeVideoId, 60);
    if (reviewVideoId) {
      refs.push(adminDb.collection("videos").doc(reviewVideoId));
      refKeys.push(`video:${item.doc.id}`);
    }
    const enrollmentId = text(item.subject.enrollmentId, 180);
    if (enrollmentId) {
      refs.push(
        adminDb
          .collection(SCP_PARTNER_ACTIVATIONS_COLLECTION)
          .doc(partnerActivationId(enrollmentId)),
      );
      refKeys.push(`partner:${item.doc.id}`);
    }
    const lastEventId = text(item.state.lastEventId, 180);
    if (lastEventId) {
      refs.push(
        adminDb
          .collection(SCP_VIDEO_REVISION_INGRESS_RECEIPTS_COLLECTION)
          .doc(ingressReceiptDocumentId(lastEventId)),
      );
      refKeys.push(`audit:${item.doc.id}`);
    }
  }
  const snapshots = await getAllReviewStateRefs(adminDb, refs);
  const joined = new Map<string, FirebaseFirestore.DocumentSnapshot>();
  snapshots.forEach((doc, index) => joined.set(refKeys[index], doc));

  // 신원 폴백 2단계: creators 를 channelId **필드**로 찾는다. 원장 fluCreatorId 로도, 문서 id
  // 조인(1단계)으로도 안 붙은 행만 대상으로 하고 실제 UC… 형태만 조회한다(센티널 제외).
  // `in` 쿼리를 30개씩 끊어 배치로 돌린다 — 행마다 개별 조회하지 않는다.
  const creatorByChannel = new Map<string, Record<string, unknown>>();
  const pendingChannelIds = new Map<string, string[]>();
  for (const item of stateRecords) {
    const resolvedCreator = joined.get(`creator:${item.doc.id}`);
    const byChannelDoc = joined.get(`creatorByChannelDoc:${item.doc.id}`);
    if (resolvedCreator?.exists) continue;
    if (byChannelDoc?.exists) {
      creatorByChannel.set(item.doc.id, record(byChannelDoc.data()));
      continue;
    }
    const channelId = text(item.subject.channelId, 64) || text(item.state.channelId, 64);
    if (!youtubeChannelUrl(channelId)) continue;
    const rowIds = pendingChannelIds.get(channelId) ?? [];
    rowIds.push(item.doc.id);
    pendingChannelIds.set(channelId, rowIds);
  }
  if (pendingChannelIds.size > 0) {
    const channelIds = [...pendingChannelIds.keys()].slice(0, CREATOR_CHANNEL_LOOKUP_CAP);
    for (let index = 0; index < channelIds.length; index += CREATOR_CHANNEL_LOOKUP_CHUNK) {
      const chunk = channelIds.slice(index, index + CREATOR_CHANNEL_LOOKUP_CHUNK);
      for (const field of CREATOR_CHANNEL_ID_FIELDS) {
        const found = await adminDb
          .collection(CREATORS_COLLECTION)
          .where(field, "in", chunk)
          .limit(chunk.length)
          .get()
          .catch(() => null);
        if (!found) continue;
        for (const doc of found.docs) {
          const data = record(doc.data());
          for (const rowId of pendingChannelIds.get(text(data[field], 64)) ?? []) {
            if (!creatorByChannel.has(rowId)) creatorByChannel.set(rowId, data);
          }
        }
      }
    }
  }

  // W102: AI 사전판정 조인 — 결정 문서는 자체 id 로 저장되고 submissionId 필드가 검수 원장
  // 문서 id(V3) 또는 videoSubmissionId 를 가리킨다. 상세 요청에서만 돈다(목록 왕복 불변),
  // 같은 제출에 여러 판정이 있으면 최신(createdAtIso) 1건만 채택한다.
  const judgeBySubmission = new Map<string, Record<string, unknown>>();
  if (detailId && stateRecords.length > 0) {
    const judgeIds = [
      ...new Set(stateRecords.flatMap((item) => [item.doc.id, item.videoSubmissionId].filter(Boolean))),
    ].slice(0, CREATOR_CHANNEL_LOOKUP_CHUNK);
    const found = await adminDb
      .collection("video_review_multimodal_decisions")
      .where("submissionId", "in", judgeIds)
      .get()
      .catch(() => null);
    for (const doc of found?.docs ?? []) {
      const data = record(doc.data());
      const key = text(data.submissionId, 500);
      const previous = judgeBySubmission.get(key);
      if (!previous || text(data.createdAtIso, 40) > text(previous.createdAtIso, 40)) {
        judgeBySubmission.set(key, data);
      }
    }
  }

  const states: ScpVideoReviewStateRow[] = stateRecords.map((item) => {
    const evidenceSource = {
      ...record(item.state.lastDecisionEvidence),
      ...record(item.state.lastReviewEvidence),
      ...record(item.state.videoReviewEvidence),
      ...record(item.state.analysisEvidence),
      ...pickRecord(item.state, [
        "aiRecommendation",
        "aiRecommendationMultimodal",
        "videoReviewByScope",
      ]),
    };
    const portalSnap = joined.get(`portal:${item.doc.id}`);
    const creatorSnap = joined.get(`creator:${item.doc.id}`);
    const applicationSnap = joined.get(`application:${item.doc.id}`) ?? null;
    const programSnap = joined.get(`program:${item.doc.id}`) ?? null;
    const campaignSnap = joined.get(`campaign:${item.doc.id}`) ?? null;
    const callbackSnap = joined.get(`callback:${item.doc.id}`) ?? null;
    const mailSnap = joined.get(`mail:${item.doc.id}`) ?? null;
    const downstreamSnap = joined.get(`downstream:${item.doc.id}`) ?? null;
    const partnerSnap = joined.get(`partner:${item.doc.id}`) ?? null;
    const auditSnap = joined.get(`audit:${item.doc.id}`) ?? null;
    const dedupSnap = joined.get(`dedup:${item.doc.id}`) ?? null;
    const youtubeUrl = httpsUrl(item.state.youtubeUrl, 700);
    const youtubeVideoId = text(item.state.youtubeVideoId, 60);
    // 다타이틀: 포털 인그레스가 subject 에 싣는 자리를 먼저 보고, 레거시 원장 필드로 폴백한다.
    // B-2: subject.gameId 뿐 아니라 같은 우선순위의 game/app 별칭까지 보는 정본 헬퍼를 쓴다 —
    // 그래야 judge(videoReviewAnalysisJudge.ts)가 별칭으로 해석한 행이 여기서만 gameId 없는
    // 행으로 갈리지 않는다.
    const rowGameId = text(resolveSubjectGameId(item.subject), 60) || text(item.state.gameId, 60);
    const thumbnailUrl = youtubeVideoId
      ? `https://img.youtube.com/vi/${encodeURIComponent(youtubeVideoId)}/hqdefault.jpg`
      : null;
    const videoSnap = joined.get(`video:${item.doc.id}`) ?? null;
    const videoData = {
      ...(videoSnap?.exists ? record(videoSnap.data()) : {}),
      ...(reviewVideoMetadata.get(youtubeVideoId) ?? {}),
    };
    const reviewTitle = resolveVideoTitleProjection(
      item.state.title,
      Object.keys(videoData).length > 0 ? videoData : null,
      titleNames,
    );
    const canonicalRevision = canonicalRevisionProjection({
      sourceSubmissionId: item.sourceSubmissionId,
      portalProjectionRef: item.sourceSubmissionId
        ? `${PORTAL_SUBMISSION_PROJECTION_COLLECTION}/${item.portalProjectionId}`
        : "",
      portal: portalSnap?.exists ? portalSnap.data() : null,
      subject: item.subject,
      state: item.state,
    });
    const decisionLedger = ledgerProjection(item.state.reviewLedger);
    // W120 [적대 리뷰 M4]: 배지는 발송된 메일의 `prior_rejection_count` 와 같은 수를 말해야 한다 —
    //   현재 헤드를 만든 판정 1건만 제외하고 나머지는 그대로 센다(이전 rev 반려는 계속 보인다).
    const ledgerSummary = summarizeVideoReviewLedger(item.state.reviewLedger, {
      excludeDecisionRef: currentHeadDecisionRef(
        item.state.reviewLedger,
        text(item.state.state, 60) || "queued",
        Number(item.state.revision ?? 0),
      ),
    });
    const applicationData = record(
      applicationSnap?.exists ? applicationSnap.data() : null,
    );
    const programData = record(programSnap?.exists ? programSnap.data() : null);
    const campaignData = record(
      campaignSnap?.exists ? campaignSnap.data() : null,
    );
    const attributionContext = attributionContextProjection({
      application: applicationData,
      program: programData,
      campaign: campaignData,
      applicationId: text(item.subject.applicationId, 180),
      enrollmentId: text(item.subject.enrollmentId, 180),
      programId:
        text(item.subject.programId, 180) ||
        text(item.state.canonicalProgramId, 180),
      campaignId: text(item.subject.campaignId, 180),
    });
    const legacyEvidence = pickRecord(evidenceSource, [
      "policyVersion",
      "engine",
      "model",
      "version",
      "recommendation",
      "duplicate",
      "voiceAuthenticityRisk",
      "language",
      "frame",
      "brand",
    ]);
    return {
      id: item.doc.id,
      detailHydrated: Boolean(detailId),
      videoSubmissionId: item.videoSubmissionId,
      state: text(item.state.state, 60) || "queued",
      revision: Number(item.state.revision ?? 0),
      contentFingerprint: text(item.state.contentFingerprint, 256),
      canonicalProgramId: text(item.state.canonicalProgramId, 180),
      portalProgramId: item.state.portalProgramId ? text(item.state.portalProgramId, 180) : null,
      programUnresolved: bool(item.state.programUnresolved),
      policyConfigHash: text(item.state.policyConfigHash, 128),
      // 2026-09-05 다타이틀. gameId 원값은 subject(포털 인그레스가 싣는 자리) → state 순으로 본다.
      gameId: rowGameId,
      gameIdUnresolved: bool(item.subject.gameIdUnresolved) || bool(item.state.gameIdUnresolved),
      gameIdDefaulted: bool(item.subject.gameIdDefaulted) || bool(item.state.gameIdDefaulted),
      title: reviewRowTitle(titleRegistry, rowGameId),
      campaignId: text(item.subject.campaignId, 180),
      fluCreatorId: text(item.subject.fluCreatorId, 180),
      youtubeUrl,
      youtubeVideoId,
      traceId: text(item.state.traceId, 180),
      withdrawn: bool(item.state.withdrawn),
      superseded: bool(item.state.superseded),
      feedEligible: bool(item.state.feedEligible),
      trackingEligible: bool(item.state.trackingEligible),
      lastTransitionSeq: item.transitionSeq,
      updatedAtIso: text(item.state.updatedAtIso, 80),
      sourceSubmissionId: item.sourceSubmissionId,
      mailPreview: null,
      media: {
        playableUrl: youtubeUrl || null,
        thumbnailUrl,
        youtubeVideoId: youtubeVideoId || null,
        // 제목은 원장 값이 아니라 정본 해석기를 거친다. 원장의 118건은 전부 사내 라벨이었고
        // 진짜 제목은 `videos` 에 이미 들어와 있었다(2026-07-26 실측: 조인으로 77건 즉시 확보).
        title: reviewTitle.title,
        titleSource: reviewTitle.source,
        availability: youtubeVideoId
          ? reviewVideoAvailability.get(youtubeVideoId) ?? "unknown"
          : "unknown",
      },
      creator: creatorProjection(
        creatorSnap?.exists ? creatorSnap.data() : null,
        {
          byChannel: creatorByChannel.get(item.doc.id) ?? null,
          video: Object.keys(videoData).length > 0 ? videoData : null,
          channelId: text(item.subject.channelId, 64) || text(item.state.channelId, 64),
          email:
            text(applicationData.email, 320) ||
            text(applicationData.creatorEmail, 320) ||
            text(applicationData.contactEmail, 320),
        },
      ),
      aiRecommendation: aiRecommendationProjection(evidenceSource),
      aiJudge: judgeVerdictProjection(
        judgeBySubmission.get(item.doc.id) ?? judgeBySubmission.get(item.videoSubmissionId),
        // W121 [적대 리뷰 M2]: 태그 후보는 상세 조회에서만 실린다(목록 응답은 슬림 투영이 aiJudge
        //   자체를 지우지만, 그 전에 행마다 만들어 들고 다니는 비용도 지지 않는다).
        { includeReasonTagCandidates: Boolean(detailId) },
      ),
      duplicateEvidence: duplicateProjection(
        dedupSnap?.exists ? dedupSnap.data() : evidenceSource,
        text(item.state.contentFingerprint, 128),
      ),
      voiceEvidence: voiceProjection(evidenceSource),
      attributionContext,
      reviewFacts: reviewFactsProjection({
        state: item.state,
        subject: item.subject,
        portal: portalSnap?.exists ? record(portalSnap.data()) : {},
        application: applicationData,
        program: programData,
        creator: creatorSnap?.exists ? record(creatorSnap.data()) : {},
        creatorByChannel: creatorByChannel.get(item.doc.id) ?? null,
        video: videoData,
      }),
      canonicalRevision,
      decisionLedger,
      appeal: appealProjection(item.state.appeal),
      postDecisionStatus: {
        callbackOutbox: outboxStatus(callbackSnap, item.outboxId),
        resultMailOutbox: outboxStatus(mailSnap, item.outboxId),
        downstreamCallbackOutbox: outboxStatus(downstreamSnap, item.outboxId),
        resultMailAlert: resultMailAlerts.get(item.videoSubmissionId)
          ?? resultMailAlerts.get(item.doc.id)
          ?? null,
        resultMailAcknowledgement: resultMailAcknowledgements.get(item.videoSubmissionId)
          ?? resultMailAcknowledgements.get(item.doc.id)
          ?? null,
        partnerActivation: partnerStatus(partnerSnap),
        auditReceipt: auditSnap?.exists
          ? {
              state: "available",
              receiptId: auditSnap.id,
              eventId:
                text(auditSnap.data()?.eventId, 180) ||
                text(item.state.lastEventId, 180) ||
                null,
            }
          : {
              state: text(item.state.lastEventId, 180)
                ? "unavailable"
                : "not_applicable",
              receiptId: null,
              eventId: text(item.state.lastEventId, 180) || null,
            },
      },
      ruleEvidenceLedger: Array.isArray(item.state.ruleEvidenceLedger)
        ? item.state.ruleEvidenceLedger
            .slice(-24)
            .map((entry) => pickRecord(record(entry), [
              "ruleId",
              "rubricVersion",
              "verdict",
              "confidence",
              "evidence",
              "requiresHumanConfirmation",
              "humanConfirmation",
              "updatedAtIso",
            ]))
            .filter(
              (entry): entry is Record<string, unknown> => entry !== null,
            )
        : [],
      evidence: legacyEvidence,
      reviewHistory: decisionLedger as unknown as Record<string, unknown>[],
      // W120: 이 제출의 판정 이력 요약 — 원장을 세는 것뿐이라 목록에서도 공짜다.
      reviewHistorySummary: {
        approvals: ledgerSummary.approvals,
        declines: ledgerSummary.declines,
        lastDeclineReasonCode: ledgerSummary.lastDeclineReasonCode,
        repeatedReasonCode: ledgerSummary.repeatedReasonCode,
        repeatedReasonCount: ledgerSummary.repeatedReasonCount,
      },
      relatedHistory,
      portalProjection: canonicalRevision.portalProjection ?? null,
    };
  });
  if (detailId && mailPreviewKind && states.length > 0) {
    const item = stateRecords[0];
    const previewVideoSnap = joined.get(`video:${item.doc.id}`) ?? null;
    const previewTitle = resolveVideoTitleProjection(
      item.state.title,
      previewVideoSnap?.exists ? record(previewVideoSnap.data()) : null,
      // 위 목록 투영과 **같은 판정**을 써야 미리보기 제목이 발송본과 갈리지 않는다.
      titleNames,
    );
    const previewReferenceTitle =
      previewTitle.source === "youtube_snapshot" ? previewTitle.title ?? "" : "";
    const preview = await prepareVideoResultMailPreview({
      applicationId: text(item.subject.applicationId, 180),
      mailKind: mailPreviewKind,
      // 다타이틀: 드레인(drainVideoResultMailOutbox)이 넘기는 것과 **같은 두 값**을 넘긴다.
      //   빠뜨리면 미리보기만 프로그램 기본 타이틀로 렌더돼 발송본과 게임명이 갈린다.
      programId: text(item.subject.programId, 180) || text(item.state.canonicalProgramId, 180),
      // B-2: same field-priority helper as the list projection above (subject.gameId, then
      // the game/app aliases, then the legacy top-level field) — a preview must never
      // disagree with the drain it is meant to mirror.
      gameId: text(resolveSubjectGameId(item.subject), 60) || text(item.state.gameId, 60),
      reasonCode: text(data.mailPreviewReasonCode, 120) || null,
      customerMessageCode:
        text(data.mailPreviewCustomerMessageCode, 120) || null,
      // W102: 운영자 편집 문안 실시간 미리보기 — 발송과 같은 렌더러를 read-only 로 통과한다.
      operatorMessage: text(data.mailPreviewMessage, 1000) || null,
      // W121 [적대 리뷰 M6]: 미리보기도 **확정과 같은 파서**를 탄다. 종전에는 여기서 미등록 키를
      //   조용히 버리고 6개째를 잘라 냈는데, 확정(transitionVideoReviewDecision)은 같은 입력을
      //   거부한다 — 미리보기가 통과시킨 태그로 확정을 누르면 실패하는 정반대 정책이었다.
      //   이제 걸릴 입력은 미리보기 단계에서 같은 invalid-argument 로 걸린다.
      reasonTagKeys: parseVideoReviewReasonTagKeys(
        data.mailPreviewReasonTagKeys,
        mailPreviewTarget,
      ) ?? [],
      // W120: 발송본과 같은 제출 참조를 미리보기에도 넣는다. 판정 전이므로 판정일은 오늘이고,
      // 이전 반려 수는 지금까지 원장에 쌓인 값이다(이번 판정은 아직 없다).
      reference: {
        // W120 [적대 리뷰 H2 · R1]: 미리보기 = 발송본. 드레인과 **같은 입력**(원장 title + 저장된
        //   `videos` 문서)으로 계산한다 — 화면 투영(`media.title`)은 이 응답에서만 도는 라이브
        //   videos.list 결과까지 병합하므로, 그 값을 쓰면 드레인이 볼 수 없는 제목을 미리보기가
        //   약속하게 된다. 사내 라벨은 양쪽 모두에서 중립 문구로 떨어진다.
        videoTitle: previewReferenceTitle,
        youtubeUrl: text(item.state.youtubeUrl, 700),
        submissionRef: Number(item.state.revision ?? 0) > 0
          ? `${item.videoSubmissionId} - rev ${Math.trunc(Number(item.state.revision))}`
          : item.videoSubmissionId,
        decidedDate: (options.nowIso ?? new Date().toISOString()).slice(0, 10),
        priorRejectionCount: summarizeVideoReviewLedger(item.state.reviewLedger, {
          excludeDecisionRef: currentHeadDecisionRef(
            item.state.reviewLedger,
            text(item.state.state, 60) || "queued",
            Number(item.state.revision ?? 0),
          ),
        }).declines,
        // W126: 드레인이 세는 값과 **같은 수**여야 미리보기가 발송본을 약속한다. 드레인은 판정
        //   **후**에 세므로 이번 판정이 이미 원장에 있고, 여기는 판정 **전**이라 아직 없다 —
        //   그래서 확정될 이번 1건을 더한다. 추가 조회는 없다(relatedHistory 가 이미 센 값이다).
        //   미분류 센티널이라 크리에이터 스코프가 없으면 relatedHistory 자체가 0 이고, 드레인도
        //   같은 조건에서 0 을 낸다.
        sameReasonDeclineCount: mailPreviewEscalationBaseCount(
          relatedHistory,
          text(data.mailPreviewReasonCode, 120),
          mailPreviewKind,
        ),
      },
      ...(options.recipientResolver
        ? { recipientResolver: options.recipientResolver }
        : {}),
    });
    states[0] = {
      ...states[0],
      mailPreview: {
        targetStatus: mailPreviewTarget as MailPreviewTarget,
        ...preview,
      },
    };
  }
  const last = snapshot.docs.at(-1);
  // 필터 스캔의 커서는 **스캔 위치**다 — 페이지가 덜 차 있어도 스캔이 더 남았으면 커서를
  //   돌려줘 다음 요청이 이어서 훑는다. 스트림이 끝났고(exhausted) 버려진 매치도 없으면,
  //   평가할 문서가 하나도 없었으면(미등록 titleId 숏서킷·빈 컬렉션) 더 이어갈 게 없다.
  const titleFilterCursorAnchor = titleFilterDroppedMatch
    ? titleFilterLastCollected
    : titleFilterLastEvaluated;
  const nextCursor = filteredDocs
    ? (titleFilterExhausted && !titleFilterDroppedMatch) || !titleFilterCursorAnchor
      ? null
      : encodeCursor({
          updatedAtIso: text(titleFilterCursorAnchor.data()?.updatedAtIso, 80),
          id: titleFilterCursorAnchor.id,
          // 필터 스코프에 묶인다 — 이 커서를 다른 titleId 요청에 넣으면 invalid-argument.
          titleId: titleIdFilter,
        })
    : snapshot.size === limit && last
      ? encodeCursor({
          updatedAtIso: text(last.data()?.updatedAtIso, 80),
          id: last.id,
        })
      : null;
  const resolvedCounts = await countsPromise;
  // 2026-09-27 codex adversarial review round 2 FAIL-4: round 1's down-projection
  // (partnersSafeReviewStateProjection) still returned scp review ids/states/creator ids and the
  // unfiltered attributionContext (which can carry application names/ids) to a non-entitled
  // caller — "non-granted never see scp" means zero scp rows, not a smaller scp row. A
  // non-entitled caller (e.g. the general-purpose Partners page) now gets an empty list — not a
  // subset — regardless of detailId (a detail request from a non-entitled caller is not a
  // legitimate case: ReviewWorkspace/CanonicalVideoReviewPanel, the only detailId callers, are
  // gated behind /flu/scp). nextCursor is also nulled so a paginating caller stops after one call
  // instead of looping on an always-empty page.
  const projectedStates = scpEntitled ? (detailId ? states : states.map(slimReviewStateProjection)) : [];
  return {
    states: projectedStates,
    nextCursor: scpEntitled ? (detailId ? null : nextCursor) : null,
    // E2: portalAliasSplicedRowCount 는 위 카운트(count() 집계)와 무관하게 계산되므로
    // 여기서 합친다 — detailId 요청(counts=null)이면 그대로 null.
    // 2026-09-27 codex adversarial review round 3 FAIL-2: states is emptied for a non-entitled
    // caller above, but counts/portalAliasSplicedRowCount are scp review totals computed
    // regardless of entitlement — leaking them here defeated the point of emptying states. Null
    // them out too for a non-entitled caller (same as the detailId=null-counts contract already
    // does for a detail request).
    counts: scpEntitled && resolvedCounts
      ? {
          ...resolvedCounts,
          portalAliasSplicedRowCount,
          // 타이틀 필터가 걸려도 이 집계는 필터 스코프를 모른다(프로그램/캠페인 총계) —
          //   titleFiltered:false 로 화면이 "필터된 총계" 인 양 표시하지 않게 한다.
          ...(titleFilterActive ? { titleFiltered: false } : {}),
        }
      : null,
    // 화면의 타이틀 필터 선택지. 레지스트리 순서를 그대로 싣는다 — 클라이언트는 게임명을
    // 알지 못하고 이 목록만 그린다(타이틀 추가가 클라 코드 변경 없이 반영된다).
    // 2026-09-27 codex adversarial review round 4 FAIL-1: titleOptions/titleFilter/
    // resultMailAlertScan are all review metadata computed regardless of entitlement (same class
    // of leak as counts above, round 3 FAIL-2) — a non-entitled caller must get a fully empty/null
    // envelope for every review-metadata field, not just states/counts. A detailId request from a
    // non-entitled caller (not a legitimate case — ReviewWorkspace/CanonicalVideoReviewPanel are
    // gated behind /flu/scp) must not leak resultMailAlertScan's scan status either, which would
    // otherwise reveal whether that submission has result-mail outbox rows.
    titleOptions: scpEntitled
      ? titleRegistry.titles.map((title) => ({
          id: title.id,
          name: title.name,
          storeUrl: title.storeUrl,
          requiredHashtag: title.requiredHashtag,
          requiredHashtags: requiredHashtagsForTitle(titleRegistry, title),
          driveFolderUrl: title.driveFolderUrl,
          ...(title.guidebookUrl ? { guidebookUrl: title.guidebookUrl } : {}),
          ...(title.default === true ? { default: true } : {}),
        }))
      : [],
    // 다타이틀: 서버 필터의 스캔 계측 — 건수뿐, 식별자는 싣지 않는다(SEC-P0-009).
    //   capped=true 면 읽기 상한에서 멈춘 것이고 nextCursor 로 이어서 더 훑을 수 있다.
    //   counts(큐 배지)는 타이틀 스코프를 모르는 프로그램/캠페인 스코프 총계 그대로다 —
    //   필터된 총계를 지어내지 않는다.
    titleFilter: scpEntitled && titleFilterActive
      ? {
          titleId: titleIdFilter,
          registered: titleFilterRegistered,
          scanned: titleFilterScanned,
          capped: !titleFilterExhausted && titleFilterScanned >= titleFilterScanCap,
          // 유계 스캔은 페이지만 낸다 — 이 필터의 정확한 총계는 서버가 만들지 않는다.
          countsExact: false,
        }
      : null,
    resultMailAlertScan: scpEntitled
      ? {
          status: resultMailAlertScan.status,
          scanned: resultMailAlertScan.scanned,
          limit: resultMailAlertScan.limit,
          pages: resultMailAlertScan.pages,
          ...(resultMailAlertScan.reason ? { reason: resultMailAlertScan.reason } : {}),
        }
      : null,
    behaviorLog: makeBehaviorLog(auth, "video_review.states.list", "success"),
  };
}
