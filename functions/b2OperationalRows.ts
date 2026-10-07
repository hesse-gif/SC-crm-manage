// Flu — B2 운영 모니터링 view-model 투영 (B2-3, 2026-07-27). 순수 함수만.
//
// 계약 정본: artifacts/figma-scp-monitoring-20260727/B2-CODE-REUSE-PLUMBING-REVIEW.md,
// B2-AUDIENCE-INGRESS-DATA-CONTRACT.md, CMUX-HANDOFF.md §2·§4·§5.
//
// 강제 규칙:
//  - **CPM 숫자·역산 가능한 예상/계산 금액을 이 view-model 에 담지 않는다(P2).** 정책 적용 여부만
//    `cpmPolicyApplied` + `cpmDisplay: "CPM 비공개"` 로 나간다. `cpmMicrosPerThousand`,
//    `estimatedAmountMinor`, `fluCalculatedAmountMinor`, `portalFinalAmountMinor` 는 입력에서만
//    읽고(정책 적용 판정) 출력에는 넣지 않는다. 리포트>영상 성과의 금액 표시는 그대로 유지된다.
//  - **null 은 0 이 아니다.** 수집 전 메트릭은 null 로 두고 0 으로 위조하지 않는다.
//  - `dailySeries` 는 실측 `video_view_series.points[]` 만 쓴다. 없는 날짜를 UI 에서 만들어
//    `+0` 으로 채우지 않는다(호출자가 이미 배치로 읽은 seriesDocs 를 그대로 매핑한다).
//  - 마감 분류는 `kstSettlementWindow`(제출일 KST + 7일 23:59:59.999) 만 쓴다.
//    `measurementEndExclusive`(= publishedAt + 168h)는 이 분류에 재사용하지 않는다(P1).
//  - 국가 오디언스는 `verified ?? declared` 표시 계산일 뿐 저장 overwrite 가 아니다(P3).

// ⚠️ 런타임 import 없음(순수 모듈) — 노드 테스트 레인이 이 파일을 그대로 import 할 수 있어야 한다.
// KST 마감 창은 `./kstSettlementWindow` 가 계산해서 넘겨준다(포트 계층이 배선).

export type OperationsBucket = "active" | "settled" | "unclassified";

/** `kstSettlementWindow.resolveKstSettlementWindow` 결과의 구조적 계약. */
export interface B2SettlementWindowInput {
  readonly submittedAtIso: string | null;
  readonly cutoffAtIso: string | null;
  readonly settledFromIso: string | null;
  readonly bucket: OperationsBucket;
}

type UIntString = string;

const UINT_RE = /^\d+$/;

export type B2AudienceAuthority = "declared" | "youtube_verified";

export type B2AudienceState =
  | "declared_only"
  | "collecting"
  | "verified"
  | "stale"
  | "reauth_required"
  | "failed"
  /**
   * W63(리더 L2026-0810-42 결정 1): 신고값이 없어 **발굴 시점 관측값**을 대신 보여 주는 상태.
   * declared 와 같은 칸에 같은 모양으로 쓰지 않는다 — 출처 라벨이 항상 함께 나가야 한다.
   */
  | "initial_observed"
  /**
   * W63(결정 2): 신고값이 영원히 오지 않고(결정적 실패) 관측 원천도 없다.
   * "확인 대기"가 아니라 **미확인(원천 없음)** 이다 — 기다릴 것이 없다는 사실을 말해야 한다.
   */
  | "unresolved_no_source"
  | "unavailable";

export interface B2AudienceCountryShare {
  readonly countryCode: string;
  readonly views: UIntString;
  readonly shareBps: UIntString;
}

export interface B2AudienceProjection {
  readonly authority: B2AudienceAuthority;
  readonly declaredCountryCode: string | null;
  /**
   * W62-6 [헤세 · ops 국가 미표시]: 신고 국가 **투영 시도 횟수**(실패 마커의 attempts).
   * 0 = 아직 시도 전 / 1 이상 = 시도했고 실패했다.
   *
   * 왜 필요한가: 종전 화면은 국가가 없으면 무조건 "확인 대기"로 그렸다. 그런데 백필이 **반복 실패**한
   * 행도 똑같이 "대기"로 보인다 — 운영자는 기다리면 채워질 줄 알고 영원히 기다린다.
   * **화면이 실패를 대기라고 말하고 있었다.** W62-3(A2) 에서 차단을 mock 으로 오표기해 밤을 태운
   * 것과 같은 종류다(틀린 사유는 없는 사유보다 비싸다) — 이건 그 레슨의 화면판이다.
   */
  readonly declaredCountryAttempts: number;
  /**
   * W63(결정 1): **관측** 초기 국가. 신고값이 아니다 — 발송 국가 하드 게이트에는 쓰지 않는다.
   * 값이 있으면 출처(`initialCountrySource`)도 반드시 함께 있다(라벨 없는 관측값 금지).
   */
  readonly initialCountryCode: string | null;
  readonly initialCountrySource: string | null;
  readonly verifiedObservationRef: string | null;
  readonly verifiedPrimaryCountryCode: string | null;
  /** verified 일 때만 채운다. declared 한 국가를 100% 로 바꾸지 않는다. */
  readonly countries: readonly B2AudienceCountryShare[];
  readonly window: { readonly startDate: string; readonly endDate: string } | null;
  readonly collectedAtIso: string | null;
  readonly status: B2AudienceState;
}

export interface B2DailySeriesPoint {
  readonly date: string;
  readonly totalViews: UIntString;
  readonly dailyDeltaViews: UIntString;
}

export interface B2OperationalRow {
  readonly rowId: string;
  readonly reviewStage: string | null;
  readonly trackingStage: string;
  readonly program: { readonly id: string; readonly name: string };
  readonly campaign: { readonly id: string | null; readonly name: string | null };
  readonly creator: {
    readonly id: string;
    readonly displayName: string;
    readonly handle: string;
    readonly profileImageUrl: string | null;
  };
  readonly video: {
    readonly submissionId: string;
    readonly youtubeVideoId: string;
    readonly title: string;
    readonly url: string;
    readonly thumbnailUrl: string | null;
  };
  readonly submittedAtIso: string | null;
  readonly cutoffAtIso: string | null;
  readonly settledFromIso: string | null;
  readonly remainingMs: number | null;
  readonly listBucket: OperationsBucket;
  readonly metrics: {
    readonly totalViews: UIntString | null;
    readonly eligibleViews: UIntString | null;
    readonly latestDailyDeltaViews: UIntString | null;
    readonly sevenDayDeltaViews: UIntString | null;
    readonly dailySeries: readonly B2DailySeriesPoint[];
    readonly freshnessWatermarkIso: string | null;
  };
  readonly collectionState: "not_started" | "healthy" | "missing_today" | "stalled_48h";
  readonly audience: B2AudienceProjection;
  readonly cpmPolicyApplied: boolean;
  readonly cpmDisplay: "CPM 비공개";
}

export interface B2SeriesPointInput {
  readonly date?: unknown;
  readonly views?: unknown;
  readonly dailyDeltaViews?: unknown;
}

export interface B2SeriesDocInput {
  readonly videoId: string;
  readonly updatedAtIso?: unknown;
  readonly points?: readonly B2SeriesPointInput[];
}

/** `listTrackedVideoObservations` 가 이미 만든 행에서 B2 가 읽는 부분만 구조적으로 받는다. */
export interface B2SourceRow {
  readonly rowId: string;
  readonly creator: { fluCreatorId: string; displayName: string; handle: string; profileImageUrl?: string };
  readonly scope: { programId: string; programName: string; campaignId?: string; campaignName?: string };
  readonly video: {
    videoSubmissionId: string;
    youtubeVideoId: string;
    canonicalUrl: string;
    title: string;
    thumbnailUrl?: string;
  };
  readonly metrics: {
    totalViews?: unknown;
    eligibleViews?: unknown;
    lastObservedAt?: unknown;
  };
  readonly rate?: { cpmMicrosPerThousand?: unknown } | null;
  readonly trackingState?: unknown;
  readonly reviewStage?: unknown;
  /** head-only 행의 video_view_series가 이 제출 id에 실제 연결됐는지 여부. */
  readonly seriesLinkedToSubmission?: boolean;
}

const UNCLASSIFIED_WINDOW: B2SettlementWindowInput = {
  submittedAtIso: null,
  cutoffAtIso: null,
  settledFromIso: null,
  bucket: "unclassified",
};

/** 남은 시간(ms). 마감이 지났거나 분류 불가면 null — 음수를 만들어 보여주지 않는다. */
function remainingMsUntil(settledFromIso: string | null, nowIso: string): number | null {
  if (!settledFromIso) return null;
  const settledMs = Date.parse(settledFromIso);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(settledMs) || !Number.isFinite(nowMs)) return null;
  const remaining = settledMs - nowMs;
  return remaining > 0 ? remaining : null;
}

function uintOrNull(value: unknown): UIntString | null {
  if (typeof value === "string" && UINT_RE.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function textOrNull(value: unknown, max = 300): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function isoOrNull(value: unknown): string | null {
  const text = textOrNull(value, 40);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** 실측점만 남기고 날짜 오름차순으로. 없는 날짜를 만들지 않는다. */
export function normalizeB2SeriesPoints(
  doc: B2SeriesDocInput | undefined,
  options: { readonly toDate: string; readonly days: number },
): B2DailySeriesPoint[] {
  const points = Array.isArray(doc?.points) ? doc.points : [];
  const fromDate = new Date(Date.parse(`${options.toDate}T00:00:00.000Z`) - (options.days - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const normalized: B2DailySeriesPoint[] = [];
  for (const point of points) {
    const date = typeof point?.date === "string" ? point.date.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (date < fromDate || date > options.toDate) continue;
    const totalViews = uintOrNull(point?.views);
    const dailyDeltaViews = uintOrNull(point?.dailyDeltaViews);
    if (totalViews === null && dailyDeltaViews === null) continue;
    normalized.push({
      date,
      totalViews: totalViews ?? "0",
      dailyDeltaViews: dailyDeltaViews ?? "0",
    });
  }
  return normalized.sort((left, right) => left.date.localeCompare(right.date));
}

function sumDeltas(points: readonly B2DailySeriesPoint[]): UIntString | null {
  if (points.length === 0) return null;
  let total = 0n;
  for (const point of points) total += BigInt(point.dailyDeltaViews);
  return total.toString();
}

/**
 * 수집 상태 칩. 실측점이 하나도 없으면 `not_started`(추적 전) — 0 위조 금지.
 * 오늘(KST 아님, 수집 기준 UTC 날짜) 점이 없으면 `missing_today`,
 * 마지막 두 날의 증가가 모두 0이면 `stalled_48h`.
 */
export function resolveCollectionState(
  points: readonly B2DailySeriesPoint[],
  todayDate: string,
): B2OperationalRow["collectionState"] {
  if (points.length === 0) return "not_started";
  const last = points[points.length - 1];
  const recent = points.slice(-2);
  if (recent.length === 2 && recent.every((point) => point.dailyDeltaViews === "0")) return "stalled_48h";
  if (last.date !== todayDate) return "missing_today";
  return "healthy";
}

export const DECLARED_ONLY_AUDIENCE: B2AudienceProjection = {
  authority: "declared",
  declaredCountryCode: null,
  declaredCountryAttempts: 0,
  initialCountryCode: null,
  initialCountrySource: null,
  verifiedObservationRef: null,
  verifiedPrimaryCountryCode: null,
  countries: [],
  window: null,
  collectedAtIso: null,
  status: "unavailable",
};

export interface B2AudienceSourceInput {
  /** Apply 신고 국가(현재 projection). 비중을 붙이지 않는다. */
  readonly declaredCountryCode?: string | null;
  /** W62-6: 투영 실패 마커의 attempts. 같은 문서에서 함께 읽는다(조인을 넓히지 않는다). */
  readonly declaredCountryAttempts?: number;
  /**
   * W63(결정 1·2): 관측 초기 국가와 그 출처, 그리고 신고 백필이 **종결**됐는지.
   * 셋 다 관리 문서의 같은 스냅샷에서 함께 읽는다 — 조인을 넓히지 않는다.
   */
  readonly initialCountryCode?: string | null;
  readonly initialCountrySource?: string | null;
  readonly declaredCountryTerminal?: boolean;
  /** Studio 채널 current aggregate. 없으면 declared 만 표시한다. */
  readonly verified?: {
    readonly status?: unknown;
    readonly mappingMatches?: boolean;
    readonly isFresh?: boolean;
    readonly currentObservationId?: unknown;
    readonly primaryCountryCode?: unknown;
    readonly countries?: readonly { countryCode?: unknown; views?: unknown }[];
    readonly totalViews?: unknown;
    readonly window?: { startDate?: unknown; endDate?: unknown } | null;
    readonly collectedAtIso?: unknown;
  } | null;
}

function countryCodeOrNull(value: unknown): string | null {
  const text = textOrNull(value, 4);
  if (!text) return null;
  const upper = text.toUpperCase();
  // ZZ(미상)·비 ISO 값은 신원으로 승격하지 않는다.
  return /^[A-Z]{2}$/.test(upper) && upper !== "ZZ" ? upper : null;
}

/** 비중은 BigInt basis point 로만 계산한다 — 브라우저 부동소수점 합산 금지. */
export function resolveB2Audience(input: B2AudienceSourceInput): B2AudienceProjection {
  const declaredCountryCode = countryCodeOrNull(input.declaredCountryCode);
  // 음수·소수·NaN 이 화면 문구를 만들지 않게 여기서 한 번만 정규화한다.
  const declaredCountryAttempts = Number.isFinite(input.declaredCountryAttempts)
    ? Math.max(0, Math.trunc(input.declaredCountryAttempts as number))
    : 0;
  // W63(결정 1): 관측 초기 국가는 **출처가 함께 있을 때만** 값으로 인정한다. 출처 없는 관측값은
  //   화면에서 신고값과 구분되지 않고, 구분되지 않는 순간 하드 게이트로 새어 나간다.
  const initialCountrySource = textOrNull(input.initialCountrySource, 40);
  const initialCountryCode = initialCountrySource ? countryCodeOrNull(input.initialCountryCode) : null;
  const verified = input.verified ?? null;
  const verifiedStatus = textOrNull(verified?.status, 40);
  const declaredFallback: B2AudienceProjection = {
    ...DECLARED_ONLY_AUDIENCE,
    declaredCountryCode,
    declaredCountryAttempts,
    initialCountryCode,
    initialCountrySource,
    status: declaredCountryCode
      ? verifiedStatus === "collecting"
        ? "collecting"
        : verifiedStatus === "stale"
          ? "stale"
          : verifiedStatus === "reauth_required"
            ? "reauth_required"
            : verifiedStatus === "failed"
              ? "failed"
              : "declared_only"
      : verifiedStatus === "collecting"
        ? "collecting"
        // 신고값이 없을 때: 관측값이 있으면 그 사실을 말하고(출처 라벨 필수),
        // 신고 백필이 종결됐는데 관측값도 없으면 "대기"가 아니라 **원천 없음**이다.
        : initialCountryCode
          ? "initial_observed"
          : input.declaredCountryTerminal === true
            ? "unresolved_no_source"
            : "unavailable",
  };

  if (!verified) return declaredFallback;
  if (verifiedStatus !== "verified" || verified.mappingMatches !== true || verified.isFresh !== true) {
    // stale/failed/reauth 는 마지막 verified 비중을 조용히 current 처럼 쓰지 않는다.
    return declaredFallback;
  }

  const totalViews = uintOrNull(verified.totalViews);
  const rawCountries = Array.isArray(verified.countries) ? verified.countries : [];
  const countries: B2AudienceCountryShare[] = [];
  const totalBig = totalViews ? BigInt(totalViews) : 0n;
  for (const entry of rawCountries) {
    const countryCode = countryCodeOrNull(entry?.countryCode);
    const views = uintOrNull(entry?.views);
    if (!countryCode || views === null) continue;
    const shareBps = totalBig > 0n ? (BigInt(views) * 10_000n) / totalBig : 0n;
    countries.push({ countryCode, views, shareBps: shareBps.toString() });
  }
  if (countries.length === 0) return declaredFallback;

  return {
    authority: "youtube_verified",
    declaredCountryCode,
    declaredCountryAttempts,
    // 검증값이 있어도 관측 초기 국가를 지우지 않는다 — 세 축(신고·관측·검증)은 서로를 덮지 않는다.
    initialCountryCode,
    initialCountrySource,
    verifiedObservationRef: textOrNull(verified.currentObservationId, 200),
    verifiedPrimaryCountryCode: countryCodeOrNull(verified.primaryCountryCode),
    countries: countries.sort((left, right) => (BigInt(right.views) > BigInt(left.views) ? 1 : -1)),
    window:
      textOrNull(verified.window?.startDate, 10) && textOrNull(verified.window?.endDate, 10)
        ? {
            startDate: String(verified.window?.startDate).slice(0, 10),
            endDate: String(verified.window?.endDate).slice(0, 10),
          }
        : null,
    collectedAtIso: isoOrNull(verified.collectedAtIso),
    status: "verified",
  };
}

export interface BuildB2OperationalRowsInput {
  readonly rows: readonly B2SourceRow[];
  readonly seriesDocs: readonly B2SeriesDocInput[];
  /** rowId → KST 캘린더 마감 창(`resolveKstSettlementWindow` 결과). 없으면 분류 불가로 둔다. */
  readonly windowByRowId: Readonly<Record<string, B2SettlementWindowInput>>;
  /** rowId → 국가 오디언스 원천(Apply declared + Studio verified). */
  readonly audienceByRowId: Readonly<Record<string, B2AudienceSourceInput>>;
  readonly nowIso: string;
  readonly days?: number;
}

// R25-D [운영 실측: 영상 Xs_dWBBGWpo, 06:2x KST 에 "추적 전"/"검수 대기 · 수집 준비" 로 표시되며
// 조회수가 화면에서 사라짐] — `toDate`(옛: input.nowIso.slice(0,10))가 **UTC** 캘린더 날짜였다.
// 스냅샷 라이터의 point.date 는 **KST** 캘린더다(06:00 KST 수집이 date:"오늘"). KST 00:00~08:59
// 동안은 UTC 날짜가 아직 전날이라 오늘자 KST 포인트가 normalizeB2SeriesPoints 의 `date >
// options.toDate`(미래) 판정에 걸려 매일 이 9시간 동안 dailySeries=[] → collectionState:
// "not_started" 로 떨어졌다. KST 는 UTC+09:00 고정 오프셋(서머타임 없음) — kstSettlementWindow.ts
// 의 같은 상수·유도 방식을 재사용한다(이 파일은 순수 모듈이라 import 대신 같은 계산을 복제한다 —
// 파일 상단 "런타임 import 없음" 규칙).
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function buildB2OperationalRows(input: BuildB2OperationalRowsInput): B2OperationalRow[] {
  const days = input.days && input.days > 0 ? Math.min(input.days, 31) : 7;
  const toDate = new Date(Date.parse(input.nowIso) + KST_OFFSET_MS).toISOString().slice(0, 10);
  const seriesByVideoId = new Map(input.seriesDocs.map((doc) => [doc.videoId, doc]));

  return input.rows.map((row) => {
    const seriesDoc = row.seriesLinkedToSubmission === false
      ? undefined
      : seriesByVideoId.get(row.video.youtubeVideoId);
    const points = normalizeB2SeriesPoints(seriesDoc, { toDate, days });
    const window = input.windowByRowId[row.rowId] ?? UNCLASSIFIED_WINDOW;
    const sourceTotalViews = uintOrNull(row.metrics.totalViews);
    const latestPoint = points.length > 0 ? points[points.length - 1] : null;
    return {
      rowId: row.rowId,
      reviewStage: textOrNull(row.reviewStage, 40),
      trackingStage: textOrNull(row.trackingState, 40) ?? "not_started",
      program: { id: row.scope.programId, name: row.scope.programName || row.scope.programId },
      campaign: { id: row.scope.campaignId ?? null, name: row.scope.campaignName ?? null },
      creator: {
        id: row.creator.fluCreatorId,
        displayName: row.creator.displayName,
        handle: row.creator.handle,
        profileImageUrl: row.creator.profileImageUrl ?? null,
      },
      video: {
        submissionId: row.video.videoSubmissionId,
        youtubeVideoId: row.video.youtubeVideoId,
        title: row.video.title,
        url: row.video.canonicalUrl,
        thumbnailUrl: row.video.thumbnailUrl ?? null,
      },
      submittedAtIso: window.submittedAtIso,
      cutoffAtIso: window.cutoffAtIso,
      settledFromIso: window.settledFromIso,
      remainingMs: remainingMsUntil(window.settledFromIso, input.nowIso),
      listBucket: window.bucket,
      metrics: {
        // 수집 전이면 null — 0 으로 위조하지 않는다.
        // head-only 행은 performance row 가 없어도 같은 제출에 연결된 series 의 최신 누적값을 쓴다.
        totalViews:
          points.length === 0 && sourceTotalViews === "0"
            ? null
            : sourceTotalViews ?? latestPoint?.totalViews ?? null,
        eligibleViews: uintOrNull(row.metrics.eligibleViews),
        latestDailyDeltaViews: latestPoint ? latestPoint.dailyDeltaViews : null,
        sevenDayDeltaViews: sumDeltas(points),
        dailySeries: points,
        freshnessWatermarkIso:
          isoOrNull(seriesDoc?.updatedAtIso) ?? isoOrNull(row.metrics.lastObservedAt),
      },
      collectionState: resolveCollectionState(points, toDate),
      audience: resolveB2Audience(input.audienceByRowId[row.rowId] ?? {}),
      // CPM 은 정책 적용 여부만. 숫자와 역산 가능한 금액은 이 view-model 에 담지 않는다.
      cpmPolicyApplied: uintOrNull(row.rate?.cpmMicrosPerThousand) !== null,
      cpmDisplay: "CPM 비공개" as const,
    };
  });
}
