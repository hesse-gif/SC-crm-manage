// Flu — B2 운영 모니터링이 읽는 부수 원천 (B2-3, 2026-07-27).
//
// 전부 **결정적 문서 id + `db.getAll` 배치**다. 영상마다 순차 `doc.get()` 을 만들지 않는다
// (114개 영상 순차 조회가 페이지를 25초로 만든 전례 / video-view-series 배치화 회귀 테스트와 같은 규칙).
//
// 제출 시각 정본(P1):
//   ① `scp_video_review_state/{videoSubmissionId}.currentRevisionSubmittedAtIso`
//      — canonical v3 제출 ingress 가 head 를 쓰는 같은 트랜잭션에서 기록한다.
//   ② 그 필드가 없는 기존 행은 `scp_content_submitted_mail_outbox/{docId(submissionId:revision)}`
//      의 `createdAtIso` — 같은 ingress 트랜잭션에서 원자적으로 생성되는 제출 원장이고
//      문서 id 가 (제출 id, 리비전)에서 결정되므로 배치 조회가 된다(문서 삭제 없음).
//   ③ 둘 다 없으면 **null**. `updatedAtIso`·승인 시각·게시 시각을 대체값으로 쓰지 않는다.
//
// 국가 오디언스(P3):
//   declared = `scp_application_management/{applicationId}.declaredPrimaryAudienceCountry`
//   verified = `scp_audience_country_channels/{audienceChannelKey}` current projection
//   (수집기가 아직 없으면 문서가 없고, 그러면 declared 만 표시된다 — 비중을 지어내지 않는다).

import { SCP_CONTENT_SUBMITTED_MAIL_OUTBOX_COLLECTION, contentSubmittedMailOutboxDocId } from "./scpReceiptMailOutbox";
import type { B2AudienceSourceInput } from "./b2OperationalRows";
import { resolveCreatorDisplayIdentity } from "./managementProfileTabsReadModels";
import { isOperationalFixtureRecord } from "./operationalFixtureProvenance";
import { campaignIdBelongsToCampaignScope, programIdBelongsToProgramScope } from "./programScopeJudgment";
import { resolveCanonicalProgramId } from "./programCanonical";
import { SCP_AUDIENCE_COUNTRY_CHANNELS_COLLECTION, audienceChannelKey } from "./audienceCountryChannels";
import { VIDEO_VIEW_MONITORS_COLLECTION } from "./videoViewSnapshots";


export const SCP_VIDEO_REVIEW_STATE_COLLECTION_NAME = "scp_video_review_state" as const;
export const SCP_APPLICATION_MANAGEMENT_COLLECTION_NAME = "scp_application_management" as const;
/** 프로그램 표시명 정본(문서 id = programId). 이름을 코드에 두지 않고 읽는 시점에 조인한다. */
export const PROGRAMS_COLLECTION_NAME = "programs" as const;
/** P3 승인 예외 — 기존에 없던 신규 원천(YouTube Analytics 국가 분포)의 current projection. */
/** R4: 키·컬렉션 정본은 `audienceCountryChannels` 한 벌(writer/reader 공유). */
export const SCP_AUDIENCE_COUNTRY_CHANNELS_COLLECTION_NAME = SCP_AUDIENCE_COUNTRY_CHANNELS_COLLECTION;

const GET_ALL_CHUNK = 300;

/**
 * R4: `fluCreatorId + channelId` 결정적 키. 규칙은 writer 와 **같은 함수**를 재수출한다 —
 * 사본을 두면 writer 가 쓴 문서를 reader 가 영영 못 찾는다.
 */
export { audienceChannelKey };

function text(value: unknown, max = 200): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : "";
}

function iso(value: unknown): string | null {
  const raw = text(value, 40);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function getAllChunked(
  db: FirebaseFirestore.Firestore,
  refs: readonly FirebaseFirestore.DocumentReference[],
): Promise<FirebaseFirestore.DocumentSnapshot[]> {
  const snapshots: FirebaseFirestore.DocumentSnapshot[] = [];
  for (let index = 0; index < refs.length; index += GET_ALL_CHUNK) {
    const chunk = refs.slice(index, index + GET_ALL_CHUNK);
    if (chunk.length === 0) continue;
    snapshots.push(...(await db.getAll(...chunk)));
  }
  return snapshots;
}

export interface B2ReviewHead {
  readonly videoSubmissionId: string;
  readonly revision: number | null;
  readonly state: string | null;
  readonly submittedAtIso: string | null;
  readonly applicationId: string | null;
  readonly fluCreatorId: string | null;
  readonly channelId: string | null;
}

/** 제출 id 목록 → 캐노니컬 검수 head 배치 조회(1회 getAll). */
export async function fetchB2ReviewHeads(
  db: FirebaseFirestore.Firestore,
  videoSubmissionIds: readonly string[],
): Promise<Map<string, B2ReviewHead>> {
  const ids = [...new Set(videoSubmissionIds.map((id) => text(id, 180)).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const refs = ids.map((id) => db.collection(SCP_VIDEO_REVIEW_STATE_COLLECTION_NAME).doc(id));
  const snapshots = await getAllChunked(db, refs);
  const heads = new Map<string, B2ReviewHead>();
  for (const snapshot of snapshots) {
    if (!snapshot.exists) continue;
    const data = snapshot.data() ?? {};
    const subject = record(data.subject);
    heads.set(snapshot.id, {
      videoSubmissionId: snapshot.id,
      revision: typeof data.revision === "number" && Number.isFinite(data.revision) ? data.revision : null,
      state: text(data.state, 40) || null,
      submittedAtIso: iso(data.currentRevisionSubmittedAtIso),
      applicationId: text(subject.applicationId, 180) || null,
      fluCreatorId: text(subject.fluCreatorId, 180) || text(data.fluCreatorId, 180) || null,
      channelId: text(subject.channelId, 180) || null,
    });
  }
  return heads;
}

/**
 * videoId별 모니터가 실제로 소유한 제출 id. 시계열 문서는 videoId 키 하나뿐이므로 이 계보를
 * 확인하지 않으면 과거 seed/다른 제출의 수치가 현재 head에 붙는다.
 */
export async function fetchB2VideoMonitorSubmissionIds(
  db: FirebaseFirestore.Firestore,
  videoIds: readonly string[],
): Promise<Map<string, ReadonlySet<string>>> {
  const ids = [...new Set(
    videoIds
      .map((id) => text(id, 60))
      .filter((id) => Boolean(id) && !id.includes("/")),
  )];
  if (ids.length === 0) return new Map();
  const refs = ids.map((id) => db.collection(VIDEO_VIEW_MONITORS_COLLECTION).doc(id));
  const snapshots = await getAllChunked(db, refs);
  const links = new Map<string, ReadonlySet<string>>();
  snapshots.forEach((snapshot, index) => {
    if (!snapshot.exists) return;
    const data = snapshot.data() ?? {};
    const submissionIds = new Set(
      [
        ...(Array.isArray(data.submissionIds) ? data.submissionIds : []),
        data.primarySubmissionId,
      ]
        .map((id) => text(id, 180))
        .filter(Boolean),
    );
    links.set(ids[index], submissionIds);
  });
  return links;
}

/**
 * head 에 제출 시각이 없는 건만 content-submitted 제출 원장에서 배치로 보충한다.
 * 리비전을 모르면 조회하지 않는다(문서 id 가 리비전으로 결정되므로 추측하면 다른 리비전을 읽게 된다).
 */
export async function fetchB2IngressSubmittedAt(
  db: FirebaseFirestore.Firestore,
  heads: ReadonlyMap<string, B2ReviewHead>,
): Promise<Map<string, string>> {
  const pending = [...heads.values()].filter((head) => !head.submittedAtIso && head.revision !== null);
  if (pending.length === 0) return new Map();
  const refs = pending.map((head) =>
    db
      .collection(SCP_CONTENT_SUBMITTED_MAIL_OUTBOX_COLLECTION)
      .doc(contentSubmittedMailOutboxDocId(head.videoSubmissionId, head.revision as number)),
  );
  const snapshots = await getAllChunked(db, refs);
  const resolved = new Map<string, string>();
  snapshots.forEach((snapshot, index) => {
    if (!snapshot.exists) return;
    const createdAtIso = iso(snapshot.data()?.createdAtIso);
    if (!createdAtIso) return;
    resolved.set(pending[index].videoSubmissionId, createdAtIso);
  });
  return resolved;
}

/** Apply 신고 국가 current projection 배치 조회. */
export type B2DeclaredCountryFact = {
  readonly code: string | null;
  /**
   * W62-6: 투영 실패 마커의 attempts. **같은 스냅샷에서 함께 읽는다** — 조인을 넓히는 게 아니라
   * 이미 읽고 있는 문서의 다른 필드를 하나 더 보는 것이다(리더 L2026-0810-11 승인 범위).
   * 국가 값을 다른 필드에서 찾아 헤매지는 않는다: 관리 문서에 그 값은 애초에 없다(실측).
   * 고칠 곳은 투영이지 조인이 아니다.
   */
  readonly attempts: number;
  /**
   * W63(리더 L2026-0810-42): **관측** 초기 국가와 그 출처, 그리고 신고 백필 종결 여부.
   * 셋 다 같은 문서의 다른 필드다(조인 무변경). 관측값은 신고값이 아니므로 **출처 없이는 쓰지 않는다**.
   */
  readonly initialCode: string | null;
  readonly initialSource: string | null;
  readonly terminal: boolean;
};

export async function fetchB2DeclaredCountries(
  db: FirebaseFirestore.Firestore,
  applicationIds: readonly string[],
): Promise<Map<string, B2DeclaredCountryFact>> {
  const ids = [...new Set(applicationIds.map((id) => text(id, 180)).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const refs = ids.map((id) => db.collection(SCP_APPLICATION_MANAGEMENT_COLLECTION_NAME).doc(id));
  const snapshots = await getAllChunked(db, refs);
  const declared = new Map<string, B2DeclaredCountryFact>();
  for (const snapshot of snapshots) {
    if (!snapshot.exists) continue;
    const data = snapshot.data() ?? {};
    const code = text(data.declaredPrimaryAudienceCountry, 4).toUpperCase();
    const attemptRecord = data.declaredAudienceCountryAttempt;
    const rawAttempts = attemptRecord && typeof attemptRecord === "object"
      ? (attemptRecord as Record<string, unknown>).attempts
      : undefined;
    const attempts = typeof rawAttempts === "number" && Number.isFinite(rawAttempts) && rawAttempts > 0
      ? Math.trunc(rawAttempts)
      // 마커가 있는데 attempts 가 없으면(구 형상) 최소 1회는 시도한 것이다 — 0 으로 접으면
      // 화면이 다시 "대기"라고 말한다.
      : attemptRecord
        ? 1
        : 0;
    // W63: 같은 스냅샷에서 관측 초기 국가·출처·종결 여부를 함께 읽는다(조인 무변경).
    const attemptFields = attemptRecord && typeof attemptRecord === "object"
      ? (attemptRecord as Record<string, unknown>)
      : {};
    const evidence = data.initialAudienceCountryEvidence;
    const initialSource = evidence && typeof evidence === "object"
      ? text((evidence as Record<string, unknown>).source, 40)
      : "";
    const initialRaw = text(data.initialAudienceCountry, 4).toUpperCase();
    // 출처 없는 관측값은 값으로 치지 않는다 — 라벨 없이 화면에 오르면 신고값과 구분되지 않는다.
    const initialCode = initialSource && /^[A-Z]{2}$/.test(initialRaw) && initialRaw !== "ZZ" ? initialRaw : null;
    const terminal = attemptFields.terminal === true;
    const fact: B2DeclaredCountryFact = {
      code: /^[A-Z]{2}$/.test(code) ? code : null,
      attempts,
      initialCode,
      initialSource: initialCode ? initialSource : null,
      terminal,
    };
    // 아무 사실도 없으면 담지 않는다(호출부가 "미지정"으로 남긴다).
    if (fact.code || fact.attempts > 0 || fact.initialCode || fact.terminal) declared.set(snapshot.id, fact);
  }
  return declared;
}

/**
 * W7-1a: 프로그램 표시명 배치 조회. head-only 행이 `programName` 자리에 **programId 를 에코**하던
 * 자리를 메우기 위한 조인이다. 보통은 `programs` 문서의 표시명을 쓰고, Portal 정본 id
 * `view-cpm`의 카운터 전용 문서만 기존 Portal 표시명 계약으로 해석한다.
 * 다른 문서가 없거나 title/name/gameTitle 이 모두 비면 넣지 않는다(호출부가 미지정으로 남긴다).
 */
export async function fetchB2ProgramNames(
  db: FirebaseFirestore.Firestore,
  programIds: readonly string[],
): Promise<Map<string, string>> {
  // 센티널(`unclassified:program:…`)도 문서 id 로 읽을 수는 있지만, 슬래시가 들어오면 `.doc()` 이
  // 던져 호출 전체가 죽는다 — 검수 채널 조인과 같은 가드를 여기에도 적용한다.
  const ids = [...new Set(programIds.map((id) => text(id, 180)).filter((id) => Boolean(id) && !id.includes("/")))];
  if (ids.length === 0) return new Map();
  const refs = ids.map((id) => db.collection(PROGRAMS_COLLECTION_NAME).doc(id));
  const snapshots = await getAllChunked(db, refs);
  const names = new Map<string, string>();
  for (const snapshot of snapshots) {
    if (!snapshot.exists) continue;
    const data = record(snapshot.data());
    const name = text(data.title, 120)
      || text(data.name, 120)
      || text(data.gameTitle, 120)
      || (snapshot.id === "view-cpm" ? "Super Creator Partners" : "");
    if (name) names.set(snapshot.id, name);
  }
  return names;
}

export interface B2VerifiedAudienceDoc {
  readonly audienceChannelKey: string;
  readonly fluCreatorId: string;
  readonly channelId: string;
  readonly verified: NonNullable<B2AudienceSourceInput["verified"]>;
}

/**
 * Studio 채널 current aggregate 배치 조회. 문서의 mapping tuple(fluCreatorId+channelId)이 요청한
 * 튜플과 정확히 같을 때만 verified 후보로 쓴다 — 같은 채널을 다른 creator 에 붙이지 않는다.
 * freshness 는 `collectedAtIso` 가 요청 시점 기준 `freshWindowHours` 안일 때만 true.
 */
export async function fetchB2VerifiedAudience(
  db: FirebaseFirestore.Firestore,
  mappings: readonly { readonly fluCreatorId: string; readonly channelId: string }[],
  options: { readonly nowIso: string; readonly freshWindowHours?: number },
): Promise<Map<string, B2VerifiedAudienceDoc>> {
  const unique = new Map<string, { fluCreatorId: string; channelId: string }>();
  for (const mapping of mappings) {
    const fluCreatorId = text(mapping.fluCreatorId, 180);
    const channelId = text(mapping.channelId, 180);
    if (!fluCreatorId || !channelId) continue;
    unique.set(audienceChannelKey(fluCreatorId, channelId), { fluCreatorId, channelId });
  }
  if (unique.size === 0) return new Map();
  const keys = [...unique.keys()];
  const refs = keys.map((key) => db.collection(SCP_AUDIENCE_COUNTRY_CHANNELS_COLLECTION_NAME).doc(key));
  const snapshots = await getAllChunked(db, refs);
  const nowMs = Date.parse(options.nowIso);
  const freshWindowMs = (options.freshWindowHours ?? 48) * 3_600_000;
  const resolved = new Map<string, B2VerifiedAudienceDoc>();
  snapshots.forEach((snapshot, index) => {
    if (!snapshot.exists) return;
    const key = keys[index];
    const expected = unique.get(key);
    if (!expected) return;
    const data = snapshot.data() ?? {};
    const mappingMatches =
      text(data.fluCreatorId, 180) === expected.fluCreatorId && text(data.channelId, 180) === expected.channelId;
    const collectedAtIso = iso(data.collectedAtIso);
    const collectedMs = collectedAtIso ? Date.parse(collectedAtIso) : Number.NaN;
    const isFresh =
      Number.isFinite(nowMs) && Number.isFinite(collectedMs) && nowMs - collectedMs <= freshWindowMs;
    const rawCountries = Array.isArray(data.countries) ? data.countries : [];
    resolved.set(key, {
      audienceChannelKey: key,
      fluCreatorId: expected.fluCreatorId,
      channelId: expected.channelId,
      verified: {
        status: text(data.status, 40) || null,
        mappingMatches,
        isFresh,
        currentObservationId: text(data.currentObservationId, 200) || null,
        primaryCountryCode: text(data.primaryCountryCode, 4) || null,
        countries: rawCountries.map((entry) => {
          const row = record(entry);
          return { countryCode: text(row.countryCode, 4), views: text(row.views, 40) };
        }),
        totalViews: text(data.totalViews, 40) || null,
        window: data.window
          ? {
              startDate: text(record(data.window).startDate, 10),
              endDate: text(record(data.window).endDate, 10),
            }
          : null,
        collectedAtIso,
      },
    });
  });
  return resolved;
}

// ---- B2-8: universe = scp_video_review_state current heads (left join) --------------------------
//
// B2 목록을 performance row 만으로 만들면 **승인 전·수집 전 제출이 사라진다**. universe 를 캐노니컬
// 검수 head 에서 시작하고 performance/series 를 left join 한다(계약: CMUX-HANDOFF §8).
// 정렬은 단일 필드(updatedAtIso desc)만 써서 복합 인덱스를 요구하지 않는다.

export interface B2HeadUniverseRow {
  readonly head: B2ReviewHead;
  readonly youtubeVideoId: string;
  readonly youtubeUrl: string;
  readonly canonicalProgramId: string;
  readonly campaignId: string;
  readonly creatorDisplayName: string;
  readonly creatorHandle: string;
  readonly creatorProfileImageUrl: string | null;
  readonly downstreamProjectionConfirmed: boolean;
  readonly trackingEligible: boolean;
}

export async function fetchB2ReviewHeadUniverse(
  db: FirebaseFirestore.Firestore,
  options: {
    readonly limit?: number;
    /** R3①: 서버측 범위 필터. U8 공용 판정과 같은 규칙(programScopeJudgment)으로 적용한다. */
    readonly programId?: string | null;
    readonly campaignId?: string | null;
  } = {},
): Promise<{ rows: B2HeadUniverseRow[]; truncated: boolean; limit: number; scanned: number }> {
  const cap = Math.max(1, Math.min(options.limit ?? 200, 500));
  // R3③: 범위 필터가 있으면 필터 통과분 cap 개를 확보하기 위해 스캔 창을 넓힌다(최대 500).
  // 넓혀도 모자라면 truncated 로 정직하게 알린다 — UI 가 "전체"인 척하지 않는다.
  const scanCap = options.programId || options.campaignId ? Math.min(cap * 2, 500) : cap;
  // 한 건 더 읽어 "정확한" 절단 판정을 만든다 — 상한과 데이터 수가 우연히 같을 때 거짓 절단 배너를
  // 띄우지 않고, 진짜로 더 있을 때만 truncated 를 세운다.
  const snap = await db
    .collection(SCP_VIDEO_REVIEW_STATE_COLLECTION_NAME)
    .orderBy("updatedAtIso", "desc")
    .limit(scanCap + 1)
    .get();
  const allDocs = snap.docs ?? [];
  // 영상 검수 목록과 운영 모니터링은 같은 current-head 집합을 써야 한다. 검수 쪽에서 숨긴
  // seedTag 픽스처를 B2가 다시 살려내면 가짜 미확인 행과 수집 실패처럼 보인다.
  const operationalDocs = allDocs.filter((doc) => !isOperationalFixtureRecord(
    { id: doc.id, ...(doc.data() ?? {}) },
    SCP_VIDEO_REVIEW_STATE_COLLECTION_NAME,
  ));
  // R3①: 타 program/campaign 행 혼입 0. head 는 canonicalProgramId 를 들고 있고, 판정은 U8 규칙이다.
  // F6(e): 요청 programId 도 캐노니컬로 정규화한다(read.ts 의 프로그램 스코프 해석과 같은 결).
  // 별칭(scp / pg-super-creator-partners)으로 조회하면 head 의 canonicalProgramId 와 문자열이 달라
  // 0행이 나오던 함정을 없앤다.
  const requestedProgramId = options.programId ? resolveCanonicalProgramId(options.programId) || options.programId : null;
  const scopedDocs = operationalDocs.filter((doc) => {
    const data = doc.data() ?? {};
    const candidate = text(data.canonicalProgramId, 180) || text(data.programId, 180);
    const canonicalCandidate = candidate ? resolveCanonicalProgramId(candidate) || candidate : "";
    return (
      (programIdBelongsToProgramScope(candidate, requestedProgramId)
        || programIdBelongsToProgramScope(canonicalCandidate, requestedProgramId))
      && campaignIdBelongsToCampaignScope(text(data.campaignId, 180), options.campaignId)
    );
  });
  const docs = scopedDocs.slice(0, cap);
  if (docs.length === 0) {
    return {
      rows: [],
      truncated: scopedDocs.length > cap || allDocs.length > scanCap,
      limit: cap,
      scanned: allDocs.length,
    };
  }

  const heads = docs.map((doc) => {
    const data = doc.data() ?? {};
    const subject = record(data.subject);
    return {
      docId: doc.id,
      data,
      head: {
        videoSubmissionId: text(data.videoSubmissionId, 180) || doc.id,
        revision: typeof data.revision === "number" && Number.isFinite(data.revision) ? data.revision : null,
        state: text(data.state, 40) || null,
        submittedAtIso: iso(data.currentRevisionSubmittedAtIso),
        applicationId: text(subject.applicationId, 180) || null,
        fluCreatorId: text(subject.fluCreatorId, 180) || text(data.fluCreatorId, 180) || null,
        channelId: text(subject.channelId, 180) || null,
      } satisfies B2ReviewHead,
    };
  });

  // 표시 신원은 정본 해석기 한 벌로만 — 배치 조회(getAll), 순차 조회 금지.
  const creatorIds = [...new Set(heads.map((entry) => entry.head.fluCreatorId).filter((id): id is string => Boolean(id)))];
  const creatorById = new Map<string, Record<string, unknown>>();
  if (creatorIds.length > 0) {
    const creatorSnaps = await getAllChunked(
      db,
      creatorIds.map((id) => db.collection("creators").doc(id)),
    );
    for (const creatorSnap of creatorSnaps) {
      if (creatorSnap.exists) creatorById.set(creatorSnap.id, creatorSnap.data() ?? {});
    }
  }

  const rows = heads.map((entry) => {
    const creator = entry.head.fluCreatorId ? creatorById.get(entry.head.fluCreatorId) : undefined;
    const identity = creator
      ? resolveCreatorDisplayIdentity(creator, entry.head.fluCreatorId ?? "")
      : { displayName: "", handle: "" };
    return {
      head: entry.head,
      youtubeVideoId: text(entry.data.youtubeVideoId, 40),
      youtubeUrl: text(entry.data.youtubeUrl, 400),
      canonicalProgramId: text(entry.data.canonicalProgramId, 180),
      campaignId: text(entry.data.campaignId, 180),
      // 붙지 않으면 이름을 지어내지 않는다 — "이름 미확인" 은 호출자가 표시한다.
      creatorDisplayName: text(identity.displayName, 200),
      creatorHandle: text(identity.handle, 120),
      creatorProfileImageUrl: text(record(creator).profileImageUrl, 500) || null,
      downstreamProjectionConfirmed: entry.data.downstreamProjectionConfirmed === true,
      trackingEligible: entry.data.trackingEligible === true,
    } satisfies B2HeadUniverseRow;
  });
  return {
    rows,
    // 상한에 닿았거나 스캔 창을 다 썼으면 뒤에 더 있을 수 있다 — 조용히 숨기지 않는다.
    truncated: scopedDocs.length > cap || allDocs.length > scanCap,
    limit: cap,
    scanned: allDocs.length,
  };
}
