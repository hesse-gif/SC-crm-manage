// GAP-B read callable for the descriptive video-tracking surface (report-only tracked videos).
// Additive: a NEW callable (`listTrackedVideoObservations`) alongside the frozen settlement callables in
// ./videoPerformanceReportPorts.ts. Same auth gate (manager+), same bounded-fetch-then-in-memory-paginate
// discipline, but reads the descriptive rows (`descriptive == true`, always `reportEligible == false`) so
// the report can show real tracked-video numbers WITHOUT ever touching the settlement ledger/summary.
import type { CallableRequest } from "firebase-functions/v2/https";
import { onCall } from "firebase-functions/v2/https";
import { adminDb } from "./firebaseAdmin";
import { toCallableResponse, toHttpsError } from "./callableErrorBoundary";
import { assertCanReadVideoPerformance } from "./videoPerformanceReportProjection";
import type { ManagementRole } from "./managementProfileTabsReadModels";
import {
  buildVideoPerformanceTrendFromSeries,
  listDescriptiveTrackingRows,
  summarizeDescriptiveTracking,
  type DescriptiveTrackingSummary,
  type VideoPerformanceTrendEnvelope,
} from "./videoPerformanceTrackingProjection";
import { fetchDescriptiveRows, fetchReportEligibleRowsForTrend, fetchVideoViewSeriesTrendDocs } from "./videoPerformanceTrackingStore";
import type { CursorPage } from "./managementProfileTabsReadModels";
import { clampPeriodToMaxWindow, type VideoPerformanceLedgerFilter, type VideoPerformanceReportRow } from "./videoPerformanceReportProjection";
import { buildB2OperationalRows, type B2AudienceSourceInput, type B2OperationalRow } from "./b2OperationalRows";
import { resolveKstSettlementWindow } from "./kstSettlementWindow";
import { resolveCanonicalProgramId } from "./programCanonical";
import {
  audienceChannelKey,
  fetchB2DeclaredCountries,
  fetchB2IngressSubmittedAt,
  fetchB2ProgramNames,
  fetchB2ReviewHeadUniverse,
  fetchB2ReviewHeads,
  fetchB2VideoMonitorSubmissionIds,
  fetchB2VerifiedAudience,
  type B2HeadUniverseRow,
  type B2ReviewHead,
} from "./b2OperationalSources";
import {
  makeYouTubeDataApiClient,
  type YouTubeApiClient,
} from "./youtubeEnrichmentService";
import {
  fetchVideoStatsBatch,
  type YouTubeVideoStat,
} from "./videoViewSnapshots";

function resolveRole(request: CallableRequest<unknown>): ManagementRole | null {
  const token = request.auth?.token as Record<string, unknown> | undefined;
  const raw = token?.role;
  return raw === "manager" || raw === "admin" || raw === "super_admin" ? (raw as ManagementRole) : null;
}


function parsePeriod(record: Record<string, unknown>): { fromIso: string; toIso: string } {
  const period = (record.period && typeof record.period === "object" ? record.period : {}) as Record<string, unknown>;
  const from = typeof period.from === "string" ? period.from : new Date(0).toISOString();
  const to = typeof period.to === "string" ? period.to : new Date().toISOString();
  const resolved = clampPeriodToMaxWindow({ fromIso: from, toIso: to });
  return { fromIso: resolved.fromIso, toIso: resolved.toIso };
}

function parseFilter(record: Record<string, unknown>): VideoPerformanceLedgerFilter {
  return (record.filter && typeof record.filter === "object" ? (record.filter as VideoPerformanceLedgerFilter) : {}) ?? {};
}

function countryForBasis(row: VideoPerformanceReportRow, basis: "declared" | "verified" | "effective"): string | undefined {
  if (basis === "declared") return row.country.declared;
  if (basis === "verified") return row.country.verified;
  return row.country.effective ?? row.country.declared;
}

function rowMatchesReportFilter(row: VideoPerformanceReportRow, filter: VideoPerformanceLedgerFilter): boolean {
  if (filter.enrollmentId && row.scope.enrollmentId !== filter.enrollmentId) return false;
  if (filter.programId && row.scope.programId !== filter.programId) return false;
  if (filter.campaignId && row.scope.campaignId !== filter.campaignId) return false;
  if (filter.countryCode) {
    const basis = filter.countryBasis ?? "effective";
    if (countryForBasis(row, basis) !== filter.countryCode) return false;
  }
  if (filter.trackingStates && filter.trackingStates.length > 0 && !filter.trackingStates.includes(row.trackingState)) return false;
  if (filter.settlementStates && filter.settlementStates.length > 0 && !filter.settlementStates.includes(row.settlement.state)) return false;
  return true;
}

export interface ListTrackedVideoObservationsConfig {
  readonly db?: FirebaseFirestore.Firestore;
  readonly youtubeApi?: Pick<YouTubeApiClient, "videosList">;
}


/** head-only 행의 rowId — performance rowId 와 충돌하지 않게 접두를 붙인다. */
function headOnlyRowId(row: B2HeadUniverseRow): string {
  return `review_state:${row.head.videoSubmissionId}:rev${row.head.revision ?? 0}`;
}

/**
 * 제출은 됐지만 performance row 가 없는 행. 메트릭 전부 null(0 위조 금지)이고 추적 단계는
 * 조회수 수집은 검수 상태와 분리한다. canonical monitor 가 제출 id 를 연결했으면 active,
 * 아직 5분 등록 패스를 기다리면 registration_pending 이다. 승인/downstream 은 정산 자격만 정한다.
 *
 * W7-1a: `programName` 은 `programs` 문서에서 조인한 이름만 쓴다. 예전에는 canonicalProgramId 를
 * 이름 자리에 에코해서 화면에 "view-cpm" 같은 id 가 프로그램 이름처럼 떴다(미해석 id 노출).
 * 조인이 비면 이름을 지어내지 않고 미지정으로 남긴다 — id 는 `program.id` 로 그대로 간다.
 */
function headOnlySourceRow(
  row: B2HeadUniverseRow,
  programName: string,
  seriesLinkedToSubmission: boolean,
  videoMetadata?: YouTubeVideoStat,
) {
  return {
    rowId: headOnlyRowId(row),
    creator: {
      fluCreatorId: row.head.fluCreatorId ?? "",
      displayName:
        row.creatorDisplayName ||
        videoMetadata?.channelTitle ||
        "이름 미확인",
      handle: row.creatorHandle,
      ...(row.creatorProfileImageUrl ? { profileImageUrl: row.creatorProfileImageUrl } : {}),
    },
    scope: {
      programId: row.canonicalProgramId,
      programName: programName || "프로그램 미지정",
      ...(row.campaignId ? { campaignId: row.campaignId } : {}),
    },
    video: {
      videoSubmissionId: row.head.videoSubmissionId,
      youtubeVideoId: row.youtubeVideoId,
      canonicalUrl: row.youtubeUrl,
      // 승인 전에는 videos 문서가 아직 없으므로 같은 videos.list 배치에서 확인한 공개 제목을
      // 표시한다. API 응답이 없거나 실패하면 기존 미확인 폴백을 그대로 유지한다.
      title: videoMetadata?.title || "(제목 미확인)",
      // W7-4b: 썸네일은 videoId 에서 결정되는 YouTube 정적 URL 이다(검수 패널과 같은 유도 규칙).
      // 값을 지어내는 게 아니라 id 로부터 계산되는 주소이고, 로드 실패는 화면이 배지로 처리한다.
      ...(row.youtubeVideoId
        ? { thumbnailUrl: `https://img.youtube.com/vi/${encodeURIComponent(row.youtubeVideoId)}/hqdefault.jpg` }
        : {}),
    },
    metrics: { totalViews: null, eligibleViews: null, lastObservedAt: null },
    rate: null,
    trackingState: seriesLinkedToSubmission ? "active" : "registration_pending",
    reviewStage: row.head.state,
    seriesLinkedToSubmission,
  };
}

/**
 * B2 운영 모니터링 행 조립. 검수 head → (제출 시각 보충 · Apply 신고 국가 · Studio verified) 를
 * 전부 결정적 문서 id 배치(`db.getAll`)로 읽는다. 영상별 순차 조회 없음.
 */
async function buildOperationsRows(
  db: FirebaseFirestore.Firestore,
  pageRows: readonly VideoPerformanceReportRow[],
  seriesDocs: Awaited<ReturnType<typeof fetchVideoViewSeriesTrendDocs>>,
  nowIso: string,
  options: {
    readonly programId?: string | null;
    readonly campaignId?: string | null;
    /** R3②: 커서 페이지(2페이지 이상)에서는 head-only 행을 다시 붙이지 않는다(병합 중복 방지). */
    readonly attachHeadOnly: boolean;
    readonly youtubeApi?: Pick<YouTubeApiClient, "videosList">;
  },
): Promise<{ rows: B2OperationalRow[]; universeTruncated: boolean; universeLimit: number; universeScanned: number }> {
  // B2-8: universe 는 performance row 가 아니라 **캐노니컬 검수 current head** 에서 시작한다.
  // performance row / video_view_series / audience 는 left join — 승인 전·수집 전 행을 버리지 않는다.
  // R3①: 범위 필터는 서버에서 U8 공용 판정과 같은 규칙으로 적용한다(타 program 행 혼입 0).
  const universe = await fetchB2ReviewHeadUniverse(db, {
    limit: 200,
    programId: options.programId ?? null,
    campaignId: options.campaignId ?? null,
  });
  const universeMeta = {
    universeTruncated: universe.truncated,
    universeLimit: universe.limit,
    universeScanned: universe.scanned,
  };
  const performanceBySubmissionId = new Map(pageRows.map((row) => [row.video.videoSubmissionId, row]));
  const headOnly = options.attachHeadOnly
    ? universe.rows.filter((row) => !performanceBySubmissionId.has(row.head.videoSubmissionId))
    : [];
  if (pageRows.length === 0 && headOnly.length === 0) return { rows: [], ...universeMeta };
  const universeHeads = new Map<string, B2ReviewHead>(
    universe.rows.map((row) => [row.head.videoSubmissionId, row.head]),
  );
  const missingHeadIds = pageRows
    .map((row) => row.video.videoSubmissionId)
    .filter((id) => !universeHeads.has(id));
  const heads = missingHeadIds.length > 0
    ? new Map([...universeHeads, ...(await fetchB2ReviewHeads(db, missingHeadIds))])
    : universeHeads;
  const mappings = [...heads.values()]
    .filter((head: B2ReviewHead) => head.fluCreatorId && head.channelId)
    .map((head: B2ReviewHead) => ({ fluCreatorId: head.fluCreatorId as string, channelId: head.channelId as string }));
  const [
    ingressSubmittedAt,
    declaredCountries,
    verifiedAudience,
    headOnlyProgramNames,
    monitorSubmissionIds,
    headOnlyVideoMetadata,
  ] = await Promise.all([
    fetchB2IngressSubmittedAt(db, heads),
    fetchB2DeclaredCountries(db, [...heads.values()].map((head: B2ReviewHead) => head.applicationId ?? "")),
    fetchB2VerifiedAudience(db, mappings, { nowIso }),
    // 같은 배치 라운드에서 프로그램 이름도 결정적 문서 id 로 읽는다(행별 순차 조회 없음).
    // F5①: 별칭 정규화 후의 id 도 함께 조회한다 — 운영 실측상 legacy `scp` 행의 이름은
    // `programs/pg-super-creator-partners` 문서에만 있다(같은 파일 :294 의 canonical 결과 사용).
    fetchB2ProgramNames(db, headOnly.flatMap((row) => [
      row.canonicalProgramId,
      resolveCanonicalProgramId(row.canonicalProgramId),
    ])),
    fetchB2VideoMonitorSubmissionIds(db, headOnly.map((row) => row.youtubeVideoId)),
    (async () => {
      const videoIds = headOnly.map((row) => row.youtubeVideoId).filter(Boolean);
      if (videoIds.length === 0) return new Map<string, YouTubeVideoStat>();
      try {
        const api = options.youtubeApi ?? makeYouTubeDataApiClient();
        return (await fetchVideoStatsBatch(api, videoIds)).stats;
      } catch (error) {
        console.warn("[b2-operations] YouTube metadata enrichment unavailable", {
          videoCount: new Set(videoIds).size,
          message: error instanceof Error ? error.message : String(error),
        });
        return new Map<string, YouTubeVideoStat>();
      }
    })(),
  ]);

  const windowByRowId: Record<string, ReturnType<typeof resolveKstSettlementWindow>> = {};
  const audienceByRowId: Record<string, B2AudienceSourceInput> = {};
  for (const row of pageRows) {
    const head = heads.get(row.video.videoSubmissionId) ?? null;
    // 제출 시각 정본 ① head 필드 ② 제출 ingress 원장 ③ null. updatedAtIso 대체 없음.
    const submittedAtIso = head?.submittedAtIso ?? ingressSubmittedAt.get(row.video.videoSubmissionId) ?? null;
    // 마감 분류는 KST 캘린더 순수 함수만 — measurementEndExclusive(168h)는 쓰지 않는다(P1).
    windowByRowId[row.rowId] = resolveKstSettlementWindow(submittedAtIso, nowIso);
    const verified =
      head?.fluCreatorId && head.channelId
        ? verifiedAudience.get(audienceChannelKey(head.fluCreatorId, head.channelId))?.verified ?? null
        : null;
    const declaredFact = head?.applicationId ? declaredCountries.get(head.applicationId) : undefined;
    audienceByRowId[row.rowId] = {
      // Apply 신고 국가는 management projection 이 정본. 성과 행의 country.declared 는 대체값이 아니다.
      declaredCountryCode: declaredFact?.code ?? null,
      // W62-6: 투영이 **시도했다 실패했는지**를 함께 싣는다 — 화면이 실패를 "대기"로 말하지 않게.
      declaredCountryAttempts: declaredFact?.attempts ?? 0,
      // W63: 관측 초기 국가는 신고값을 대체하지 않고 **출처와 함께** 별도 축으로 간다.
      initialCountryCode: declaredFact?.initialCode ?? null,
      initialCountrySource: declaredFact?.initialSource ?? null,
      declaredCountryTerminal: declaredFact?.terminal === true,
      verified,
    };
  }

  // head-only 행(제출됐지만 performance row 가 아직 없음)을 같은 view-model 로 만든다.
  // 메트릭은 전부 null — 0 으로 위조하지 않는다. 행 identity 는 videoSubmissionId + 현재 revision.
  //
  // F5③: 이름 해석 3다리 — ①programs 문서(정규화 전/후 id) ②같은 페이지에 **이미 로드된**
  // performance row 들이 들고 있는 stored `scope.programName`(추가 read 0) ③그래도 없으면 미지정.
  // ②는 리포트 화면이 이미 보여주는 이름과 같은 값이라, 같은 프로그램인데 head-only 행만 "미지정"
  // 으로 남는 비대칭을 없앤다. 코드에 사람 이름을 새로 넣지 않는다.
  const storedProgramNames = new Map<string, string>();
  for (const row of pageRows) {
    const programId = (row.scope.programId ?? "").trim();
    const programName = (row.scope.programName ?? "").trim();
    if (!programId || !programName || programName === programId) continue;
    if (!storedProgramNames.has(programId)) storedProgramNames.set(programId, programName);
  }
  const resolveProgramName = (programId: string): string => {
    const canonicalId = resolveCanonicalProgramId(programId);
    return headOnlyProgramNames.get(programId)
      ?? headOnlyProgramNames.get(canonicalId)
      ?? storedProgramNames.get(programId)
      ?? storedProgramNames.get(canonicalId)
      ?? "";
  };
  const seriesLinkedToSubmission = (row: B2HeadUniverseRow): boolean =>
    monitorSubmissionIds
      .get(row.youtubeVideoId)
      ?.has(row.head.videoSubmissionId) === true;
  const headOnlySourceRows = headOnly.map((row) => headOnlySourceRow(
    row,
    resolveProgramName(row.canonicalProgramId),
    seriesLinkedToSubmission(row),
    headOnlyVideoMetadata.get(row.youtubeVideoId),
  ));
  for (const row of headOnly) {
    const submittedAtIso = row.head.submittedAtIso
      ?? ingressSubmittedAt.get(row.head.videoSubmissionId)
      ?? null;
    windowByRowId[headOnlyRowId(row)] = resolveKstSettlementWindow(submittedAtIso, nowIso);
    const verified = row.head.fluCreatorId && row.head.channelId
      ? verifiedAudience.get(audienceChannelKey(row.head.fluCreatorId, row.head.channelId))?.verified ?? null
      : null;
    const headDeclaredFact = row.head.applicationId ? declaredCountries.get(row.head.applicationId) : undefined;
    audienceByRowId[headOnlyRowId(row)] = {
      declaredCountryCode: headDeclaredFact?.code ?? null,
      declaredCountryAttempts: headDeclaredFact?.attempts ?? 0,
      initialCountryCode: headDeclaredFact?.initialCode ?? null,
      initialCountrySource: headDeclaredFact?.initialSource ?? null,
      declaredCountryTerminal: headDeclaredFact?.terminal === true,
      verified,
    };
  }

  // W7-4a 근인 수리: 시계열(`video_view_series`)은 호출부가 **performance row 의 videoId 로만**
  // 배치 조회해 왔다. head-only 행(승인됐지만 performance row 가 아직 없는 영상)은 그 목록에 없어서,
  // 모니터가 실제로 수집한 일별 조회수가 있어도 화면에서 항상 null 로 보였다 — 수집 문제가 아니라
  // **읽기 경로 조인 갭**이다. 같은 배치 헬퍼로 빠진 videoId 만 한 번 더 읽어 붙인다(순차 조회 없음).
  const seriesVideoIds = new Set(seriesDocs.map((doc) => doc.videoId));
  const missingSeriesVideoIds = [...new Set(
    headOnly
      .filter(seriesLinkedToSubmission)
      .map((row) => row.youtubeVideoId)
      .filter((videoId) => Boolean(videoId) && !seriesVideoIds.has(videoId)),
  )];
  const headOnlySeriesDocs = missingSeriesVideoIds.length > 0
    ? await fetchVideoViewSeriesTrendDocs(db, missingSeriesVideoIds)
    : [];

  return { rows: buildB2OperationalRows({
    seriesDocs: [...seriesDocs, ...headOnlySeriesDocs],
    rows: [
      ...pageRows.map((row) => ({
        ...row,
        reviewStage: heads.get(row.video.videoSubmissionId)?.state ?? null,
      })),
      ...headOnlySourceRows,
    ],
    windowByRowId,
    audienceByRowId,
    nowIso,
  }), ...universeMeta };
}

export function createListTrackedVideoObservationsHandler(
  config: ListTrackedVideoObservationsConfig = {},
): (request: CallableRequest<unknown>) => Promise<
  {
    ok: true;
    summary: DescriptiveTrackingSummary;
    globalFetchTruncated: boolean;
    trend: VideoPerformanceTrendEnvelope;
    /** B2 운영 모니터링 전용 additive 투영. CPM 숫자·역산 가능한 금액은 여기 없다(P2). */
    operations: {
      generatedAtIso: string;
      rows: B2OperationalRow[];
      universeTruncated: boolean;
      limits: { universe: number; universeScanned: number; performancePage: number };
    };
  } & CursorPage<VideoPerformanceReportRow>
> {
  const db = config.db ?? adminDb;
  return async (request) => {
    try {
      assertCanReadVideoPerformance(resolveRole(request));
      const record = (request.data ?? {}) as Record<string, unknown>;
      const filter = parseFilter(record);
      const enrollmentId = typeof record.enrollmentId === "string" && record.enrollmentId ? record.enrollmentId : filter.enrollmentId;
      const cursor = typeof record.cursor === "string" ? record.cursor : null;
      const pageSize = typeof record.pageSize === "number" ? record.pageSize : undefined;
      const period = parsePeriod(record);
      const [{ rows: rawDescriptiveRows, truncated: descriptiveTruncated }, { rows: rawRecognizedRows, truncated: recognizedTruncated }] = await Promise.all([
        fetchDescriptiveRows(db, { enrollmentId }),
        fetchReportEligibleRowsForTrend(db, { enrollmentId }),
      ]);
      const rows = rawDescriptiveRows.filter((row) => rowMatchesReportFilter(row, filter));
      const recognizedRows = rawRecognizedRows.filter((row) => rowMatchesReportFilter(row, filter));
      const summary = summarizeDescriptiveTracking(rows);
      const page = listDescriptiveTrackingRows(rows, { cursor, limit: pageSize });
      const videoIds = [...rows, ...recognizedRows].map((row) => row.video.youtubeVideoId);
      const seriesDocs = await fetchVideoViewSeriesTrendDocs(db, videoIds);
      const trend = buildVideoPerformanceTrendFromSeries({
        descriptiveRows: rows,
        recognizedRows,
        seriesDocs,
        periodFrom: period.fromIso,
        periodTo: period.toIso,
      });
      // B2 운영 모니터링(additive): 이미 배치로 읽은 seriesDocs 를 그대로 재사용해 선택 페이지 행의
      // 일별 시계열을 만들고, 제출 시각·국가 오디언스는 결정적 문서 id 배치 조회로만 붙인다.
      // 새 컬렉션 조회는 승인된 audience aggregate 하나뿐이고, 영상별 순차 조회는 없다.
      const nowIso = new Date().toISOString();
      const operations = await buildOperationsRows(db, page.rows, seriesDocs, nowIso, {
        programId: filter.programId ?? null,
        campaignId: filter.campaignId ?? null,
        // R3②: 첫 페이지에서만 head-only 행을 병합한다 — 커서 페이지마다 다시 붙이면 같은 행이
        // 페이지를 넘나들며 중복된다. performance 행은 기존 커서 계약대로 페이지된다.
        attachHeadOnly: !cursor,
        ...(config.youtubeApi ? { youtubeApi: config.youtubeApi } : {}),
      });
      return toCallableResponse({
        ok: true as const,
        summary,
        // R3③: universe 상한 절단도 전체 절단으로 전파한다 — 화면이 "전체"인 척하지 않는다.
        globalFetchTruncated: descriptiveTruncated || recognizedTruncated || operations.universeTruncated,
        trend,
        operations: {
          generatedAtIso: nowIso,
          rows: operations.rows,
          universeTruncated: operations.universeTruncated,
          // 조인 양쪽 한도 대조용(리뷰 요구): universe 상한/스캔량 + performance 페이지 크기.
          limits: {
            universe: operations.universeLimit,
            universeScanned: operations.universeScanned,
            performancePage: page.rows.length,
          },
        },
        ...page,
      });
    } catch (err) {
      throw toHttpsError(err);
    }
  };
}

export function createListTrackedVideoObservationsCallable(config: ListTrackedVideoObservationsConfig = {}) {
  return onCall(
    // 2026-09-07 프로드 실측(Aside): 기본 256MiB 에서 "Memory limit of 256 MiB exceeded with 259 MiB used" 로
    // 죽어 /flu/scp?tab=ops 가 "요청을 처리하지 못했습니다" 만 보였다(9/1·9/5에도 동일). 읽는 데이터는
    // video_view_series 225건·0.9MB 뿐이라 번들 기본 점유 + YouTube 클라이언트가 원인 — 다른 콜러블 29개와 같은 512MiB.
    { memory: "512MiB", secrets: ["YOUTUBE_API_KEY", "YOUTUBE_API_KEY_FALLBACK_1"] },
    createListTrackedVideoObservationsHandler(config),
  );
}
