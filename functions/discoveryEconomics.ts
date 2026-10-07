/**
 * W115 — **발굴 경제학 정본 (의존 없는 리프 모듈).**
 *
 * 이 파일에는 import 가 하나도 없다. `discoveryJobTypes.ts` 와 같은 이유다: discovery.ts·admin.ts
 * 양쪽이 같은 규칙을 써야 하는데, 어느 한쪽에 두면 다른 쪽이 firebase-admin 을 통째로 끌고 오거나
 * (섀도 프로듀서 순수성 붕괴) 규칙을 복제하게 된다 — 복제된 규칙은 반드시 갈라진다(W112 F-A 실측).
 *
 * ■ 이 모듈이 답하는 질문
 *   A1  hydration 을 몇 명까지 · 몇 유닛까지 볼 것인가
 *   A2  이미 아는 채널을 channels.list **호출 전에** 어떻게 걸러낼 것인가
 *   A3  About 에 이메일이 없는 후보의 설명란을 몇 유닛까지 캘 것인가
 *   A4  같은 hydration 예산으로 **이메일이 있을 확률이 높은 후보를 먼저** 보려면 무엇을 근거로 하는가
 *   C1  암/레인별 "유닛 → 이메일" 수율을 어떻게 귀속할 것인가
 *   C2  저비용 레인을 먼저 소진하면서도 탐사가 0 이 되지 않게 하려면 어떻게 배분할 것인가
 *   C3  100유닛짜리 헛발 검색을 언제 쉬게 할 것인가
 *
 * 전부 **순수 함수**다 — Firestore·네트워크 접촉이 없어 값으로 직접 단위 테스트한다.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 유닛 단가 (YouTube Data API v3 공식 표. 이 숫자는 우리가 정하는 값이 아니다)
// ─────────────────────────────────────────────────────────────────────────────

/** search.list — 한 콜에 최대 50건, **100유닛**. 발굴 비용의 거의 전부가 여기다. */
export const YOUTUBE_SEARCH_UNITS_PER_CALL = 100;
/** channels.list — 한 콜에 최대 50개 채널, **1유닛**. search 대비 100분의 1. */
export const YOUTUBE_CHANNELS_UNITS_PER_CALL = 1;
/** videos.list — 한 콜에 최대 50개 영상, **1유닛**. */
export const YOUTUBE_VIDEOS_UNITS_PER_CALL = 1;

/**
 * C1 수율 리포트의 유닛 척도. 1유닛당 이메일은 소수점 세 자리 아래로 내려가 눈으로 비교가 안 된다 —
 * "1,000유닛당 이메일 몇 개"가 사람이 읽고 판단할 수 있는 단위다(search 콜 10회 = 1,000유닛).
 */
export const DISCOVERY_YIELD_UNIT_SCALE = 1_000;

// ─────────────────────────────────────────────────────────────────────────────
// A2 — known-channel 프리필터
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `emailStatus:"none"` 으로 판정된 채널을 **다시 보기까지의 최소 간격**(기본 30일).
 *
 * 0 이 아닌 이유: About 은 바뀐다(비즈니스 문의 메일을 나중에 다는 채널이 실제로 있다).
 * 30일인 이유: 그보다 짧으면 같은 무이메일 채널이 매 런 hydration 슬롯을 잡아먹고, 그보다 길면
 * 재방문 가치가 사실상 사라진다. 이메일을 **이미 확보한** 채널은 이 창과 무관하게 영구 제외다 —
 * 재발굴이 낳는 것이 merge 뿐이라 유닛만 태운다.
 */
export const KNOWN_CHANNEL_EMAIL_NONE_REVISIT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * W115-R1 [CRITICAL · 적대 리뷰]: 이메일을 **이미 아는** 채널을 다시 보기까지의 간격(90일).
 *
 * 종전에는 이 경우가 **영구 제외**였다. 그 규칙 하나가 잘못 저장된 주소의 자가 교정 경로를 통째로
 * 닫았다: 검색 스니펫(≈160자 절단)에서 캔 `business@mystudio.co`(실주소 `.com` 의 절단)가 한 번
 * 저장되면 그 채널은 다시는 hydration 되지 않아 About 의 진짜 주소를 영원히 못 본다 —
 * 오주소로 콜드메일이 나가고, 그 사실을 시스템이 스스로 알아낼 방법이 없다.
 *
 * 90일인 이유: About 재조회는 채널당 1/50 유닛(channels.list 50개/콜)이라 분기 1회는 사실상 공짜고,
 * 그보다 짧으면 이미 확보한 채널이 hydration 슬롯을 반복 점유해 신규 유입을 밀어낸다.
 * 소스 종류(About/설명란/스니펫)와 무관하게 같은 창을 쓴다 — 스니펫 유래에만 창을 열면 A2 가
 * `emailSourceKind` 가 **없는 레거시 문서**(=전량)를 영구 제외로 되돌린다.
 */
export const KNOWN_CHANNEL_EMAIL_KNOWN_REVISIT_MS = 90 * 24 * 60 * 60 * 1000;

/** A2 프리필터가 한 번에 대조할 candidate_pool 문서 수(Firestore getAll 배치 크기). */
export const KNOWN_CHANNEL_LOOKUP_BATCH_SIZE = 300;

export type KnownChannelRecord = {
  /** 이미 확보한 이메일(있으면 재발굴 불필요). */
  readonly email?: unknown;
  /** 직전 판정. "none" 이면 재방문 창 판정 대상이다. */
  readonly emailStatus?: unknown;
  /** W115-R1: 그 이메일을 **어디서** 캤는가. 재방문 창 판정의 관측축이다(값은 EmailSourceKind). */
  readonly emailSourceKind?: unknown;
  /** 마지막으로 About 을 실제로 본 시각(ISO). hydration 이 매번 갱신하는 축을 그대로 쓴다. */
  readonly sourceFetchedAt?: unknown;
  readonly updatedAtIso?: unknown;
  // A4: 세그먼트 서술자 축. 프리필터가 **이미 읽은** 문서에서 그대로 나오므로 추가 읽기가 0 이다.
  readonly creatorCountry?: unknown;
  readonly region?: unknown;
  readonly category?: unknown;
  readonly followers?: unknown;
};

export type KnownChannelSkipReason = "email_known_within_revisit_window" | "email_none_within_revisit_window";

function isoMs(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

function hasEmail(value: unknown): boolean {
  return typeof value === "string" && value.includes("@");
}

/** 마지막 관측 시각. 두 축을 각각 한 번씩만 파싱한다(같은 문자열을 세 번 Date.parse 하지 않는다). */
function lastSeenMs(record: KnownChannelRecord): number {
  const fetched = isoMs(record.sourceFetchedAt);
  return Number.isFinite(fetched) ? fetched : isoMs(record.updatedAtIso);
}

/**
 * 이 채널을 이번 런에서 **다시 조회할 것인가**를 판정한다.
 *
 * 문서가 없으면(=처음 보는 채널) 언제나 조회한다 — 프리필터의 목적은 신규 유입을 막는 게 아니라
 * 이미 값을 아는 채널에 유닛을 다시 쓰지 않는 것이다.
 *
 * **영구 제외는 없다.** 두 갈래 모두 창 기반이다(이메일 보유 90일 · none 30일) — 영구 제외는
 * 잘못 저장된 값의 교정 경로를 닫아 통계를 동결시킨다(W115-R1 CRITICAL).
 */
export function knownChannelSkipReason(
  record: KnownChannelRecord | null | undefined,
  nowMs: number,
  revisitMs: number = KNOWN_CHANNEL_EMAIL_NONE_REVISIT_MS,
  knownEmailRevisitMs: number = KNOWN_CHANNEL_EMAIL_KNOWN_REVISIT_MS,
): KnownChannelSkipReason | null {
  if (!record) return null;
  const seenMs = lastSeenMs(record);
  if (hasEmail(record.email)) {
    // 언제 봤는지 모르면 재조회한다 — 모름을 "최근에 봤다"로 취급하면 그 채널이 영구히 묻힌다.
    if (!Number.isFinite(seenMs)) return null;
    return nowMs - seenMs < knownEmailRevisitMs ? "email_known_within_revisit_window" : null;
  }
  if (record.emailStatus !== "none") return null;
  if (!Number.isFinite(seenMs)) return null;
  return nowMs - seenMs < revisitMs ? "email_none_within_revisit_window" : null;
}

export type HydrationPrefilterResult = {
  /** 실제로 channels.list 를 부를 대상(관측 순서 보존 — 인터리브 계약을 깨지 않는다). */
  readonly hydratable: string[];
  /** 프리필터가 제외한 채널 수. */
  readonly skipped: number;
  readonly skippedByReason: Readonly<Record<KnownChannelSkipReason, number>>;
};

/**
 * 관측된 채널 목록에서 **이미 아는 채널을 걷어낸다**(순수).
 *
 * ⚠️ **순서를 절대 바꾸지 않는다.** 뒤의 hydration 은 암별 인터리브로 상한을 공평히 나누는데,
 *   여기서 순서가 흔들리면 그 공평성 계약이 조용히 깨진다. 필터링만 한다.
 */
export function partitionHydrationTargets(
  channelIds: readonly string[],
  knownById: ReadonlyMap<string, KnownChannelRecord | null>,
  nowMs: number,
  revisitMs: number = KNOWN_CHANNEL_EMAIL_NONE_REVISIT_MS,
): HydrationPrefilterResult {
  const skippedByReason: Record<KnownChannelSkipReason, number> = {
    email_known_within_revisit_window: 0,
    email_none_within_revisit_window: 0,
  };
  const hydratable: string[] = [];
  for (const channelId of channelIds) {
    const reason = knownChannelSkipReason(knownById.get(channelId), nowMs, revisitMs);
    if (reason) {
      skippedByReason[reason] += 1;
      continue;
    }
    hydratable.push(channelId);
  }
  return { hydratable, skipped: channelIds.length - hydratable.length, skippedByReason };
}

// ─────────────────────────────────────────────────────────────────────────────
// A3 — 설명란 이메일 추출 예산
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 한 런에서 설명란 백필(videos.list)에 쓸 수 있는 **최대 유닛**.
 *
 * videos.list 는 50영상/콜·1유닛이므로 10유닛 = 최대 500영상이다. W84 실측(2026-08-15)에서
 * 보유 videoId 설명란 마이닝은 **이메일 1개당 0.42유닛**이었다 — 같은 이메일을 About 재검색으로
 * 얻으려면 100유닛짜리 search 를 다시 태워야 한다. 예산을 두는 이유는 비용이 아니라 **상한의
 * 명시성**이다: 예산 없는 백필은 후보 수에 비례해 조용히 커진다.
 */
export const VIDEO_DESCRIPTION_BACKFILL_UNIT_BUDGET_PER_RUN = 10;

/** 채널당 설명란을 볼 최신 영상 수. 더 보면 유닛만 늘고 수율은 거의 안 오른다(W84 [B] 실측). */
export const VIDEO_DESCRIPTION_SAMPLE_PER_CHANNEL = 3;

/**
 * 후보 문서에 남기는 이메일 출처 — A4 가 노출률 기여를 측정할 때 읽는 축이다.
 *
 * W115-R1: `search_snippet` 을 `video_description` 에서 **분리**한다. 둘 다 "영상 설명란"이지만
 * 전자는 search.list 가 준 ≈160자 절단본이고 후자는 videos.list 전문이다 — 절단본에서 나온 주소는
 * 마지막 매치가 잘렸을 수 있어 `verified` 로 승격될 자격이 없다(CRITICAL). 두 값을 한 라벨로 묶으면
 * 그 자격 차이를 문서에서 되읽을 수 없다.
 */
// Flu/AI-Drama Apify: T049(and any future org listed in integrations/captcha_solver's
// allowedOrgIds) 는 About 스크레이핑을 아예 타지 않고 Apify actor 로만 이메일을 얻는다 — 그 결과의
// 관측축. 재방문 창 판정(아래)은 소스 종류와 무관하게 같은 창을 쓰므로 새 값을 추가해도 기존 로직이
// 갈라지지 않는다.
// email-digging: `link_in_bio` = 설명란이 직접 링크한 allowlist 링크인바이오 페이지(linktr.ee 등)에서,
// `cross_source` = 같은 채널의 다른 문서(타 프로그램·candidate_pool)가 이미 가진 주소를 재사용한 것.
export type EmailSourceKind =
  | "about"
  | "video_description"
  | "search_snippet"
  | "public_scrape"
  | "apify"
  | "link_in_bio"
  | "cross_source"
  | "upload_description_sample"
  | "none";

/**
 * 백필 예산 안에서 실제로 조회할 videoId 를 고른다(순수).
 *
 * 채널당 상한을 먼저 적용하고, 그 다음 전체 유닛 예산으로 자른다 — 순서가 반대면 앞쪽 채널이
 * 예산을 독식해 뒤쪽 채널이 통째로 굶는다.
 */
export function planVideoDescriptionBackfill(
  targets: readonly { readonly channelId: string; readonly videoIds: readonly string[] }[],
  options: {
    readonly unitBudget?: number;
    readonly perChannelSample?: number;
    readonly batchSize?: number;
    readonly alreadyKnownVideoIds?: ReadonlySet<string>;
  } = {},
): { videoIds: string[]; plannedCalls: number; plannedUnits: number } {
  const unitBudget = Math.max(0, Math.trunc(options.unitBudget ?? VIDEO_DESCRIPTION_BACKFILL_UNIT_BUDGET_PER_RUN));
  const perChannel = Math.max(1, Math.trunc(options.perChannelSample ?? VIDEO_DESCRIPTION_SAMPLE_PER_CHANNEL));
  const batchSize = Math.max(1, Math.trunc(options.batchSize ?? 50));
  const known = options.alreadyKnownVideoIds;
  const selected: string[] = [];
  const seen = new Set<string>();
  // 라운드로빈: 채널마다 한 개씩 돌아가며 담는다. 예산이 모자라도 앞쪽 채널만 채워지지 않는다.
  for (let round = 0; round < perChannel; round += 1) {
    for (const target of targets) {
      const videoId = target.videoIds[round];
      if (!videoId || seen.has(videoId)) continue;
      if (known?.has(videoId)) continue;
      seen.add(videoId);
      selected.push(videoId);
    }
  }
  const maxVideos = unitBudget * batchSize;
  const videoIds = selected.slice(0, maxVideos);
  const plannedCalls = Math.ceil(videoIds.length / batchSize);
  return { videoIds, plannedCalls, plannedUnits: plannedCalls * YOUTUBE_VIDEOS_UNITS_PER_CALL };
}

// ─────────────────────────────────────────────────────────────────────────────
// C1 — 레인별 비용·수율 귀속
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 비용·수율을 귀속하는 **레인**의 정본. 검색 3암과 저비용 보조 2레인이 같은 척도 위에 올라야
 * "search 100유닛 vs 그래프 1유닛"을 비교할 수 있다 — 종전에는 보조 레인이 아예 계측 밖이었다.
 */
export const DISCOVERY_COST_LANES = ["keyword", "broad", "topic", "channel_graph", "most_popular"] as const;
export type DiscoveryCostLane = (typeof DISCOVERY_COST_LANES)[number];

/** 검색 암(=search.list 100유닛/콜)만 추린 부분집합. 보조 레인과 예산 규칙이 다르다. */
export const DISCOVERY_SEARCH_LANES = ["keyword", "broad", "topic"] as const;
export type DiscoverySearchLane = (typeof DISCOVERY_SEARCH_LANES)[number];

export type LaneCostYield = {
  /** 이 레인이 직접 태운 유닛(search/그래프/차트 호출). */
  readonly directUnits: number;
  /** hydration·설명란 백필처럼 여러 레인이 나눠 쓴 유닛 중 이 레인 몫(비례 배분). */
  readonly sharedUnits: number;
  readonly units: number;
  /** 이 레인이 관측한 고유 채널 수(hydration 이전). */
  readonly channelsObserved: number;
  /** 실제로 channels.list 응답을 받은 수. */
  readonly channelsHydrated: number;
  /** 이메일을 확보한 수(About + 설명란 합). */
  readonly emails: number;
  /** 유닛 대비 이메일 — DISCOVERY_YIELD_UNIT_SCALE(1,000)유닛당. 0유닛이면 0. */
  readonly emailsPerUnitScaled: number;
};

export type LaneObservation = {
  readonly lane: DiscoveryCostLane;
  /** 이 레인이 직접 발사한 호출 수. */
  readonly calls: number;
  /** 콜당 유닛 단가. search 는 100, 보조 레인은 1. */
  readonly unitsPerCall: number;
  readonly channelsObserved: number;
  readonly channelsHydrated: number;
  readonly emails: number;
};

/**
 * 런 하나의 레인별 비용·수율을 계산한다(순수).
 *
 * 공유 비용(hydration channels.list · 설명란 videos.list)은 **hydrate 된 채널 수에 비례**해
 * 나눈다. 균등 배분이 아닌 이유: 100명을 hydrate 한 레인과 3명을 hydrate 한 레인이 같은 몫을
 * 지면 저비용 레인의 유닛/이메일이 실제보다 나쁘게 보이고, C2 의 판단이 통째로 뒤집힌다.
 * hydrate 총합이 0 이면 공유 비용은 어느 레인에도 싣지 않는다(분모가 없다).
 */
export function attributeLaneCostYield(
  observations: readonly LaneObservation[],
  sharedUnits: number = 0,
): Record<string, LaneCostYield> {
  const totalHydrated = observations.reduce((sum, item) => sum + Math.max(0, item.channelsHydrated), 0);
  const shared = Math.max(0, sharedUnits);
  const result: Record<string, LaneCostYield> = {};
  for (const item of observations) {
    const directUnits = Math.max(0, Math.trunc(item.calls)) * Math.max(0, Math.trunc(item.unitsPerCall));
    const laneShared = totalHydrated > 0
      ? (shared * Math.max(0, item.channelsHydrated)) / totalHydrated
      : 0;
    const units = directUnits + laneShared;
    const emails = Math.max(0, Math.trunc(item.emails));
    result[item.lane] = {
      directUnits,
      sharedUnits: Number(laneShared.toFixed(3)),
      units: Number(units.toFixed(3)),
      channelsObserved: Math.max(0, Math.trunc(item.channelsObserved)),
      channelsHydrated: Math.max(0, Math.trunc(item.channelsHydrated)),
      emails,
      emailsPerUnitScaled: units > 0 ? Number(((emails / units) * DISCOVERY_YIELD_UNIT_SCALE).toFixed(3)) : 0,
    };
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// C2 — 비용 정규화 배분 + 최소 탐사 비율
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 어떤 암도 이 비율 아래로는 내려가지 않는다 — 비용 정규화가 승자를 하나로 몰아 **탐사가 0**이
 * 되는 것을 막는 안전장치다. 밴딧의 존재 이유가 탐사이므로 이건 성능 손실이 아니라 계약이다.
 */
export const DISCOVERY_MIN_ARM_EXPLORATION_SHARE = 0.1;

export type ArmCostLedgerEntry = {
  /** 이 암의 누적 이메일 수. */
  readonly emails?: unknown;
  /** 이 암이 태운 누적 유닛. */
  readonly units?: unknown;
};

function positiveNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * 암별 **비용 정규화 가중치**(이메일/유닛)를 만든다(순수).
 *
 * 관측이 없는 암은 `null` 이 아니라 **관측된 암들의 평균**을 받는다 — 0 을 주면 그 암이 다시는
 * 안 뽑혀 영구 미탐색이 되고, 그건 밴딧이 아니라 고정 배분이다(allocateSliceArmSlots 가 EWMA 에
 * 같은 규칙을 쓰는 이유와 정확히 같다). 전 암이 미관측이면 전원 1(=균등)이다.
 */
export function costNormalizedArmWeights(
  costLedger: Readonly<Record<string, ArmCostLedgerEntry | undefined>>,
  lanes: readonly string[] = DISCOVERY_SEARCH_LANES,
): Record<string, number> {
  const observed = new Map<string, number>();
  for (const lane of lanes) {
    const entry = costLedger[lane];
    if (!entry) continue;
    const units = positiveNumber(entry.units);
    if (units <= 0) continue;
    observed.set(lane, Math.max(0, Number(entry.emails) || 0) / units);
  }
  const values = [...observed.values()];
  const mean = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 1;
  const weights: Record<string, number> = {};
  for (const lane of lanes) weights[lane] = observed.get(lane) ?? mean;
  return weights;
}

/**
 * C2 — 저비용 레인을 **먼저 소진**하고 search 암은 잔여 예산 안에서만 태우는 계획(순수).
 *
 * 저비용 레인(채널그래프 1-hop · 지역 인기차트)은 콜당 1유닛이라 사실상 공짜다. 그런데 종전에는
 * 이 레인들이 검색 **뒤에** 붙어 있어, 검색이 예산을 다 태운 런에서는 함께 죽었다.
 * 예산 계획을 값으로 분리해 "싼 것부터"를 호출부가 지킬 수 있게 한다.
 */
/**
 * 저비용 레인이 한 런에서 태울 수 있는 유닛의 상한(예약분).
 *
 * 산식: 채널그래프 = 시드 ≤10콜 + 이웃 hydrate 1콜 = **11유닛**, 지역 인기차트 = region ≤20콜 =
 * **20유닛**. 합 31. 이 값은 검색 1콜(100유닛)의 3분의 1도 안 되므로 예약이 검색을 굶기지 않는다 —
 * 그런데 예약이 없으면 잔여가 100 근처일 때 검색이 마지막 1콜을 가져가 두 레인이 통째로 죽는다.
 */
export const DISCOVERY_LOW_COST_LANE_UNIT_RESERVE = 11 + 20;

export function planLaneBudget(input: {
  /** 이번 런에 쓸 수 있는 총 유닛(쿼터 잔여에서 호출부가 이미 예약분을 뺀 값). */
  readonly availableUnits: number;
  /**
   * 저비용 레인 몫을 **예약할 것인가**. 이름이 "켜져 있는가"가 아니라 "예약하는가"인 이유:
   * 레인의 on/off 는 런타임 설정이고 여기서는 알 수 없다. 예약분이 안 쓰이면 그냥 잔여로 남는다 —
   * 그러니 이 인자는 사실 주장이 아니라 **의사결정**이어야 한다(호출부가 무엇을 아는지에 안 기댄다).
   */
  readonly reserveLowCostLanes: boolean;
  /** 저비용 레인이 태울 것으로 보는 유닛(그래프 ≤11 + 차트 ≤20 의 상한). */
  readonly lowCostUnitEstimate: number;
  /** search 콜 하나의 단가. 기본 100. */
  readonly searchUnitsPerCall?: number;
}): { lowCostUnits: number; searchUnits: number; fundedSearchCalls: number } {
  const available = Math.max(0, Math.trunc(input.availableUnits));
  const perCall = Math.max(1, Math.trunc(input.searchUnitsPerCall ?? YOUTUBE_SEARCH_UNITS_PER_CALL));
  const lowCostUnits = input.reserveLowCostLanes
    ? Math.min(available, Math.max(0, Math.trunc(input.lowCostUnitEstimate)))
    : 0;
  const searchUnits = Math.max(0, available - lowCostUnits);
  return { lowCostUnits, searchUnits, fundedSearchCalls: Math.floor(searchUnits / perCall) };
}

// ─────────────────────────────────────────────────────────────────────────────
// C3 — search 쿼리 위생 (암 단위 쿨다운)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 신규 채널 0 이 **연속 몇 번**이면 그 암을 쉬게 할 것인가. 1 회는 노이즈다(쿼터 절단·리전 회전으로
 * 우연히 0 이 나올 수 있다). 3 회 연속이면 그 암은 이 캠페인의 현재 우주에서 고갈된 것이다.
 */
export const DISCOVERY_ARM_DEAD_STREAK_THRESHOLD = 3;

/**
 * 쿨다운 길이. 슬라이스 쿨다운(7일)보다 짧게 잡는다 — 암은 슬라이스보다 넓은 축이라 7일을 쉬면
 * 그 암의 EWMA 자체가 낡는다. 3일이면 키워드 자가확장(일 최대 8개)이 우주를 바꿔 놓기에 충분하다.
 */
export const DISCOVERY_ARM_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

export type ArmYieldLedgerEntry = {
  /** 신규 채널 0 이 연속으로 몇 번 나왔는가. */
  readonly zeroStreak: number;
  /** 마지막으로 이 암이 실제로 검색을 발사한 시각. */
  readonly lastFiredAtIso: string;
};

export type ArmYieldLedger = Readonly<Record<string, ArmYieldLedgerEntry | undefined>>;

/**
 * 완료된 잡 하나의 관측으로 암 수율 원장을 갱신한다(순수).
 *
 * **실제로 응답을 받은 암만** 갱신한다(successfulSearchCalls > 0).
 *
 * W115-R1 [HIGH · 적대 리뷰]: 종전에는 분모가 `attemptedSearchCalls` 였다 — 시도에는 403(쿼터
 * 소진)·5xx 처럼 **응답을 한 건도 못 받은** 콜이 포함된다. 쿼터가 마른 날 세 암이 각각 시도만 하고
 * 전부 0채널로 기록되면 3연속이면 멀쩡한 암이 3일 은퇴한다 — 쿼터 소진은 암의 품질 신호가 아니다.
 * 성공 콜을 분모로 쓰면 "쏘고도 못 찾았다"만 스트릭에 남는다. (EWMA 는 R28-1 의 이유로 계속 시도를
 * 분모로 쓴다 — 그쪽은 예산 절단 하에서의 **배분 공정성** 축이고, 여기는 **은퇴 판정** 축이다.)
 */
export function applyArmYieldLedgerUpdate(
  prior: ArmYieldLedger,
  observation: {
    readonly successfulCallsByArm: Readonly<Record<string, number>>;
    readonly newUniqueByArm: Readonly<Record<string, number>>;
    readonly nowIso: string;
  },
  lanes: readonly string[] = DISCOVERY_SEARCH_LANES,
): Record<string, ArmYieldLedgerEntry> {
  const next: Record<string, ArmYieldLedgerEntry> = {};
  for (const lane of lanes) {
    const existing = prior[lane];
    if (existing) next[lane] = existing;
  }
  for (const lane of lanes) {
    const succeeded = Math.max(0, Math.trunc(Number(observation.successfulCallsByArm[lane]) || 0));
    if (succeeded <= 0) continue;
    const newUnique = Math.max(0, Math.trunc(Number(observation.newUniqueByArm[lane]) || 0));
    const priorStreak = Math.max(0, Math.trunc(Number(prior[lane]?.zeroStreak) || 0));
    next[lane] = {
      zeroStreak: newUnique > 0 ? 0 : priorStreak + 1,
      lastFiredAtIso: observation.nowIso,
    };
  }
  return next;
}

/**
 * 이 암이 지금 쿨다운 중인가(순수).
 *
 * 임계 미만이면 쿨다운이 아니고, 임계를 넘겨도 마지막 발사로부터 쿨다운 창을 지났으면 다시 연다 —
 * 은퇴가 아니라 **휴식**이다(영구 은퇴는 밴딧의 탐사를 죽인다).
 */
export function isArmInCooldown(
  entry: ArmYieldLedgerEntry | undefined,
  nowMs: number,
  options: { readonly streakThreshold?: number; readonly cooldownMs?: number } = {},
): boolean {
  if (!entry) return false;
  const threshold = Math.max(1, Math.trunc(options.streakThreshold ?? DISCOVERY_ARM_DEAD_STREAK_THRESHOLD));
  if (Math.max(0, Math.trunc(Number(entry.zeroStreak) || 0)) < threshold) return false;
  const lastMs = Date.parse(entry.lastFiredAtIso ?? "");
  if (!Number.isFinite(lastMs)) return false;
  return nowMs - lastMs < Math.max(0, options.cooldownMs ?? DISCOVERY_ARM_COOLDOWN_MS);
}

/**
 * 쿨다운을 슬롯 배분에 적용한다(순수).
 *
 * ⚠️ **전 암을 동시에 끄지 않는다.** 모두 쿨다운이면 원본 배분을 그대로 돌려준다 — 위생 게이트가
 *   발굴 자체를 정지시키면 그건 위생이 아니라 장애다(BLOCKER-2(ii) 가 슬라이스 쿨다운에서 겪은
 *   바로 그 형상: 목표 미달 캠페인이 쿨다운에 막혀 6 tick 연속 잡 0건).
 *   회수된 슬롯은 살아 있는 암에 **최대나머지법**으로 재배분한다 — 총합(=검색 예산)은 보존된다.
 */
export function applyArmCooldownToSlots(
  slots: Readonly<Record<string, number>>,
  ledger: ArmYieldLedger,
  nowMs: number,
  options: { readonly streakThreshold?: number; readonly cooldownMs?: number; readonly lanes?: readonly string[] } = {},
): { slots: Record<string, number>; cooledDown: string[] } {
  const lanes = options.lanes ?? DISCOVERY_SEARCH_LANES;
  const cooledDown = lanes.filter((lane) => isArmInCooldown(ledger[lane], nowMs, options));
  const alive = lanes.filter((lane) => !cooledDown.includes(lane));
  const next: Record<string, number> = {};
  for (const lane of lanes) next[lane] = Math.max(0, Math.trunc(Number(slots[lane]) || 0));
  if (cooledDown.length === 0 || alive.length === 0) return { slots: next, cooledDown: [] };

  const reclaimed = cooledDown.reduce((sum, lane) => sum + next[lane], 0);
  for (const lane of cooledDown) next[lane] = 0;
  if (reclaimed === 0) return { slots: next, cooledDown };
  const base = Math.floor(reclaimed / alive.length);
  let remainder = reclaimed - base * alive.length;
  for (const lane of alive) {
    next[lane] += base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  }
  return { slots: next, cooledDown };
}

// ─────────────────────────────────────────────────────────────────────────────
// 10k 상시가동 — 재고 기반 큐잉 계획
// ─────────────────────────────────────────────────────────────────────────────

/** 재고 스케줄러가 한 pass 에 측정할 캠페인 수 상한(count() 집계 3회/캠페인). */
export const INVENTORY_FLOOR_SCAN_LIMIT = 25;
/** 한 pass 에 큐잉할 발굴 잡 수 상한. 기존 캠페인별 레이트리밋(1시간·활성 잡 dedup)이 추가로 조인다. */
export const INVENTORY_FLOOR_ENQUEUE_LIMIT_PER_PASS = 3;
/**
 * 목표의 이 비율을 넘으면 **감속**한다(큐잉 상한 1건). 목표 직전에 전속력으로 밀면 초과 수확이
 * 그대로 미발송 재고로 쌓이고, 그건 유닛을 태워 재고를 사 두는 것과 같다.
 */
export const INVENTORY_FLOOR_SLOWDOWN_RATIO = 0.9;

export type InventoryFloorPlan = {
  /** 이번 pass 에 큐잉을 시도할 잡 수. 0 이면 목표 도달(자동 정지). */
  readonly enqueueBudget: number;
  readonly state: "harvesting" | "slowing_down" | "target_reached" | "quota_exhausted";
  readonly progress: number;
};

/**
 * 재고 대비 이번 pass 의 큐잉 예산을 정한다(순수).
 *
 * 자동 정지·자동 재개가 **상태 저장 없이** 성립한다: 매 pass 지금 재고를 재고 그 값만으로 결정하므로
 * 표류할 상태가 없다(ytdlpInventoryCounter 가 같은 이유로 증분 원장을 버렸다).
 */
export function planInventoryFloorQueue(input: {
  readonly sendableEstimate: number;
  readonly target: number;
  readonly quotaExhausted: boolean;
  readonly enqueueLimit?: number;
  readonly slowdownRatio?: number;
}): InventoryFloorPlan {
  const target = Math.max(1, Math.trunc(input.target));
  const sendable = Math.max(0, Math.trunc(input.sendableEstimate));
  const progress = Math.min(1, sendable / target);
  const limit = Math.max(0, Math.trunc(input.enqueueLimit ?? INVENTORY_FLOOR_ENQUEUE_LIMIT_PER_PASS));
  const slowdownRatio = input.slowdownRatio ?? INVENTORY_FLOOR_SLOWDOWN_RATIO;
  if (sendable >= target) return { enqueueBudget: 0, state: "target_reached", progress };
  // 쿼터 소진은 재고와 무관한 전역 사유다 — 목표 미달이어도 큐잉하지 않는다(태울 유닛이 없다).
  if (input.quotaExhausted) return { enqueueBudget: 0, state: "quota_exhausted", progress };
  if (progress >= slowdownRatio) return { enqueueBudget: Math.min(1, limit), state: "slowing_down", progress };
  return { enqueueBudget: limit, state: "harvesting", progress };
}

/**
 * W115-R1 [Stage 1-a · 적대 리뷰]: **전역 부족분을 캠페인 하한으로 환산한다**(순수).
 *
 * 왜 필요한가 — 종전 스윕은 목표를 **전역 10,000** 으로 판단하는데, 액추에이터
 * (`enqueueShortfallDiscoveryJob`)는 캠페인마다 `candidatePoolFloor`(기본 750)로만 판단했다.
 * 그래서 활성 캠페인이 14개 미만이면(750 × 13 = 9,750 < 10,000) 전 캠페인이 자기 하한을 채운
 * 시점에 `inventoryShortfall <= 0` 이 되어 잡이 **0건**이 되고, 전역 재고는 10k 에 닿지 못한 채
 * 영구 정지한다 — 스윕의 센서와 액추에이터가 서로 다른 목표를 보고 있었다.
 *
 * 산식: `기본하한 + ⌈전역 부족분 / 활성 캠페인 수⌉`. 전역 부족분이 0 이면 기본 하한 그대로다
 * (=종전 계약 불변). 기존 shortfall 레인(캠페인 부족분)은 이 값을 아예 보지 않는다.
 */
export function inventoryFloorPerCampaignFloor(input: {
  readonly baseFloor: number;
  readonly target: number;
  readonly sendableEstimate: number;
  readonly activeCampaigns: number;
}): number {
  const baseFloor = Math.max(0, Math.trunc(input.baseFloor));
  const deficit = Math.max(0, Math.trunc(input.target) - Math.trunc(input.sendableEstimate));
  if (deficit <= 0) return baseFloor;
  const campaigns = Math.max(1, Math.trunc(input.activeCampaigns));
  return baseFloor + Math.ceil(deficit / campaigns);
}

/**
 * W115-R1 [MEDIUM · 적대 리뷰]: 한 pass 가 큐잉하는 잡들이 **같은 쿼터 스냅샷**으로 각각 최대치를
 * 산정하던 문제의 정본(순수).
 *
 * 실측 형상: pass 당 잡 3건이 모두 `remainingUnits` 를 그대로 보고 각자 최대 검색 콜을 계획하면
 * 실제 잔여의 최대 3배를 약속한다(리뷰 재현 2.85×). 워커가 나중에 돌 때 쿼터 원장은 이미 마르고,
 * 그 초과분은 403 으로 나타난다 — 그리고 403 은 다시 암 은퇴·유닛 과청구로 번진다(HIGH 2·3).
 *
 * 해법은 원장 왕복이 아니라 **pass 로컬 차감**이다: 같은 pass 안에서 앞선 잡이 계획한 유닛을
 * 뒤 잡의 가용치에서 뺀다. 원장은 워커가 실제로 태울 때 정본으로 갱신된다.
 */
export function passLocalAvailableUnits(remainingUnits: number, reservedUnits: number): number {
  return Math.max(0, Math.trunc(remainingUnits) - Math.max(0, Math.trunc(reservedUnits)));
}

// ─────────────────────────────────────────────────────────────────────────────
// A4 — 세그먼트 이메일 노출률 기반 hydration 사전 랭킹
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A4 가 답하는 질문은 A1 과 다르다. A1 은 "몇 명을 볼 것인가"(예산)이고 A4 는 **"같은 예산이면
 * 누구를 먼저 볼 것인가"**(순서)다. 예산에 걸려 잘리는 후보가 존재하는 한, 순서는 곧 수확이다.
 *
 * ■ 근거는 이미 쌓여 있다
 *   candidate_pool 문서에 `emailStatus`·`creatorCountry`·`category`·`followers` 가 영속돼 있어
 *   "이 세그먼트를 hydrate 하면 이메일이 나올 확률"을 **역사적 실측**으로 계산할 수 있다.
 *   새 API 콜이 아니라 이미 산 데이터를 다시 읽는 것이다.
 *
 * ■ 왜 세 개의 특이도 티어인가 (가장 중요한 설계 판단)
 *   랭킹 시점은 channels.list **이전**이다 — 그 시점에 신규 채널의 국가·구독자 수는 **알 수 없다**
 *   (그게 바로 channels.list 가 파는 값이다). 그래서 티어를 나눈다:
 *     T3 `국가 × 카테고리 × 밴드`  — 이미 문서가 있는 재관측 채널(프리필터가 이미 읽었다).
 *     T2 `국가 × 카테고리`         — 국가만 아는 경우.
 *     T1 `카테고리`                — 신규 채널. 매칭 검색어는 hydration 전에 이미 안다.
 *   집계는 문서 하나마다 세 티어를 **모두** 올린다(문서당 카운터 3개). 조회는 가장 구체적인
 *   티어부터 내려오며 표본이 찬 첫 티어를 쓴다.
 *
 *   ⚠️ 검색 쿼리의 `regionCode` 를 국가로 쓰지 않는다. YouTube 문서와 이 파일의 검색 URL 빌더가
 *     명시하듯 regionCode 는 **영상의 시청 가능 지역**이지 크리에이터의 국가가 아니다 — 그 둘을
 *     같은 축으로 묶으면 집계(크리에이터 국가)와 조회(쿼리 지역)가 서로 다른 분포를 보게 되고,
 *     표는 맞는데 판단만 조용히 틀리는 형상이 된다. 모르면 T1 로 내려간다.
 *
 * ■ 탐사 보존 — 미지 세그먼트는 **패널티가 아니라 평균**이다
 *   표본 미달(N < 30)·처음 보는 세그먼트·카테고리 미상은 전부 `globalRate` 를 받는다. 0 을 주면
 *   그 세그먼트는 영원히 예산 꼬리에 몰려 표본이 늘지 않고, 그건 랭킹이 아니라 **자기실현적 봉인**이다
 *   (costNormalizedArmWeights 가 미관측 암에 평균을 주는 것과 정확히 같은 이유).
 */

/** 세그먼트 하나가 자기 노출률을 주장하려면 필요한 최소 표본. 이하는 전역 평균으로 접는다. */
export const SEGMENT_EMAIL_RATE_MIN_SAMPLE = 30;
/**
 * 집계 상태 문서가 들고 다닐 세그먼트 키 수의 상한(문서 크기·쓰기 비용 가드).
 * 상한을 넘긴 뒤 처음 보는 키는 버린다 — 버려진 키는 "미지 세그먼트"가 되어 전역 평균을 받는다.
 * 즉 이 가드는 **정확도를 잃을 뿐 후보를 벌하지 않는다**. 스캔 순서가 문서 ID 순(=세그먼트와 무관)
 * 이라 거래량이 큰 세그먼트일수록 상한 전에 들어온다.
 */
export const SEGMENT_EMAIL_RATE_MAX_SEGMENTS = 400;
/** 세그먼트 키 스키마 버전. 정규화 규칙이 바뀌면 올린다 — 구 키 원장을 이어받으면 조회가 전역 폴백으로
 *  떨어지고(matchedKey null) 구 키가 cap 슬롯을 먹어, "A4 를 고치는 배포"가 최대 두 사이클(~22h)
 *  동안 A4 를 무력화한다(A4-R2 리뷰 재현). 버전 불일치 시 원장·표를 리셋하는 쪽이 싸다. */
export const SEGMENT_EMAIL_RATE_KEY_VERSION = 2;
/** 한 집계 pass 가 읽는 candidate_pool 문서 수의 상한(COST-P0-006 — 읽기 비용은 이 값이 정본이다). */
export const SEGMENT_EMAIL_RATE_SCAN_PAGE_LIMIT = 500;
/**
 * 집계 pass 사이의 최소 간격. 5분 워커에 편승하되(신규 스케줄 0) 매 tick 읽지는 않는다 —
 * 노출률은 시간 단위로 움직이는 값이 아니라 계절 단위로 움직이는 값이다.
 * 상한 500문서 × 하루 48pass = 24,000 읽기/일 이 이 레인의 비용 천장이다.
 */
export const SEGMENT_EMAIL_RATE_SCAN_INTERVAL_MS = 30 * 60 * 1000;

/** 구독자 밴드. 경계는 하한 포함·상한 배제다(10,000 은 `10k_100k`). */
export const SEGMENT_FOLLOWER_BANDS = ["lt_10k", "10k_100k", "100k_1m", "gte_1m"] as const;
export type SegmentFollowerBand = (typeof SEGMENT_FOLLOWER_BANDS)[number];

/** 구독자 수 → 밴드. **모르면 null** 이다 — 0 으로 접으면 미상이 `lt_10k` 로 위조된다. */
export function segmentFollowerBand(followers: unknown): SegmentFollowerBand | null {
  if (typeof followers !== "number" && (typeof followers !== "string" || followers.trim() === "")) return null;
  const parsed = Number(followers);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  if (parsed < 10_000) return "lt_10k";
  if (parsed < 100_000) return "10k_100k";
  if (parsed < 1_000_000) return "100k_1m";
  return "gte_1m";
}

function normalizeSegmentCountry(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(text) ? text : null;
}

/**
 * 카테고리 대분류 키. 집계와 조회가 **같은 정규화**를 통과해야 두 축이 만난다.
 * 유니코드 문자·숫자만 남기고 나머지는 `_` 로 접는다 — 한국어 카테고리("퍼즐 게임")를 통째로
 * 날리지 않으면서, Firestore 맵 키에서 문제를 일으키는 문자(`.` 등)를 원천 배제한다.
 */
function normalizeSegmentCategory(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // A4-R1 실측(distinct 1,931/10,754): 저장된 category 에 같은 토픽 집합의 **순열 변형**이 다수다
  // ("Role-playing_video_game Action_game …" 4종 ~1,026건). 토큰을 정렬해 순열을 한 세그먼트로
  // 붕괴시킨다 — 집계·조회 양축이 이 함수를 공유하므로 여기 한 곳이면 축이 갈라지지 않는다.
  // 토큰별로 문장부호를 접은 **뒤** 정렬한다 — 원시 토큰을 정렬하면 "a_b" vs "a-b" 처럼
  // 같은 정규화 결과가 문장부호 코드포인트 차이로 다른 순서를 얻는다(A4-R2 리뷰).
  const tokens = value.trim().toLowerCase().split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}]+/gu, "_"))
    .filter(Boolean)
    .sort();
  const slug = tokens.join("_").replace(/^_+|_+$/g, "").slice(0, 48);
  return slug.length > 0 ? slug : null;
}

export type SegmentDescriptor = {
  readonly country?: unknown;
  readonly category?: unknown;
  readonly followers?: unknown;
};

/**
 * 이 후보/문서가 속하는 세그먼트 키를 **가장 구체적인 티어부터** 돌려준다(순수).
 *
 * 카테고리가 없으면 빈 배열이다 — 세 티어가 모두 카테고리를 포함하므로, 카테고리 미상은
 * 어느 티어에도 속하지 않고 곧장 전역 평균으로 간다.
 */
export function segmentTierKeys(descriptor: SegmentDescriptor): string[] {
  const category = normalizeSegmentCategory(descriptor.category);
  if (!category) return [];
  const country = normalizeSegmentCountry(descriptor.country);
  const band = segmentFollowerBand(descriptor.followers);
  const keys: string[] = [];
  if (country && band) keys.push(`c=${country}|g=${category}|b=${band}`);
  if (country) keys.push(`c=${country}|g=${category}`);
  keys.push(`g=${category}`);
  return keys;
}

export type SegmentSampleCount = { readonly total: number; readonly withEmail: number };

/** 회전 스캔이 누적하는 원장. 한 바퀴가 끝나야 표로 승격된다(부분 스캔은 표가 아니다). */
export type SegmentEmailCounts = {
  readonly total: number;
  readonly withEmail: number;
  readonly segments: Readonly<Record<string, SegmentSampleCount>>;
};

export const EMPTY_SEGMENT_EMAIL_COUNTS: SegmentEmailCounts = { total: 0, withEmail: 0, segments: {} };

export type SegmentSample = SegmentDescriptor & {
  readonly email?: unknown;
};

function positiveCount(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * 스캔 페이지 하나를 원장에 누적한다(순수). 문서 하나가 자기 세 티어를 **모두** 올린다.
 *
 * 분자는 `hasEmail(email)` 이다 — `emailStatus` 가 아니라 실제 주소의 존재로 센다. 상태 라벨은
 * verified/guessed 로 갈리지만 A4 가 예측하려는 것은 "hydrate 하면 **주소가 나오는가**"이므로
 * 라벨 승격 규칙(W115-R1 CRITICAL)이 바뀌어도 이 통계의 의미는 흔들리지 않는다.
 */
export function accumulateSegmentEmailCounts(
  prior: SegmentEmailCounts | null | undefined,
  samples: readonly SegmentSample[],
  maxSegments: number = SEGMENT_EMAIL_RATE_MAX_SEGMENTS,
): SegmentEmailCounts {
  const segments = new Map<string, { total: number; withEmail: number }>();
  for (const [key, value] of Object.entries(prior?.segments ?? {})) {
    const total = positiveCount((value as SegmentSampleCount | undefined)?.total);
    if (total <= 0) continue;
    segments.set(key, { total, withEmail: Math.min(total, positiveCount((value as SegmentSampleCount | undefined)?.withEmail)) });
  }
  const cap = Math.max(1, Math.trunc(maxSegments));
  let total = positiveCount(prior?.total);
  let withEmail = Math.min(total, positiveCount(prior?.withEmail));
  for (const sample of samples) {
    const gotEmail = hasEmail(sample.email);
    total += 1;
    if (gotEmail) withEmail += 1;
    // 리뷰(A4-R1 HIGH): 상한 admit 는 거친 티어부터 — segmentTierKeys 는 [T3,T2,T1] 순이라 그대로
    // 돌면 카디널리티 최대인 T3 가 cap(400)을 선점하고, 신규 채널이 유일하게 매칭 가능한 T1 이
    // 굶는다(카테고리 150개 시점에 published 3/150 실측). 역순으로 돌아 T1 을 먼저 admit 한다 —
    // 이미 admit 된 키의 카운트 갱신(위 entry 분기)은 순서와 무관하다.
    for (const key of segmentTierKeys(sample).slice().reverse()) {
      const entry = segments.get(key);
      if (entry) {
        entry.total += 1;
        if (gotEmail) entry.withEmail += 1;
        continue;
      }
      if (segments.size >= cap) continue;
      segments.set(key, { total: 1, withEmail: gotEmail ? 1 : 0 });
    }
  }
  return { total, withEmail, segments: Object.fromEntries(segments) };
}

export type SegmentEmailRateTable = {
  /** 전 pool 평균 노출률. 미지·표본 미달 세그먼트가 받는 값이다(패널티 없음). */
  readonly globalRate: number;
  /** 전역 평균의 표본 크기. 0 이면 표 자체가 근거 없음이다. */
  readonly sampleSize: number;
  /** 표본을 채운 세그먼트만. 여기 **없다는 것**이 곧 "전역 평균으로 폴백"이다. */
  readonly segments: Readonly<Record<string, number>>;
};

/**
 * 한 바퀴를 돈 원장을 조회용 표로 승격한다(순수). 표본 미달 세그먼트는 **싣지 않는다** —
 * 0.0 으로 싣는 것과 다르다: 싣지 않으면 조회가 다음 티어(결국 전역 평균)로 내려간다.
 */
export function publishSegmentEmailRates(
  counts: SegmentEmailCounts | null | undefined,
  minSample: number = SEGMENT_EMAIL_RATE_MIN_SAMPLE,
): SegmentEmailRateTable {
  const total = positiveCount(counts?.total);
  const withEmail = Math.min(total, positiveCount(counts?.withEmail));
  const threshold = Math.max(1, Math.trunc(minSample));
  const segments: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts?.segments ?? {})) {
    const segmentTotal = positiveCount((value as SegmentSampleCount | undefined)?.total);
    if (segmentTotal < threshold) continue;
    const segmentEmails = Math.min(segmentTotal, positiveCount((value as SegmentSampleCount | undefined)?.withEmail));
    segments[key] = Number((segmentEmails / segmentTotal).toFixed(4));
  }
  return {
    globalRate: total > 0 ? Number((withEmail / total).toFixed(4)) : 0,
    sampleSize: total,
    segments,
  };
}

/**
 * 이 후보의 기대 노출률(순수). 가장 구체적인 티어부터 내려오며 표에 **실려 있는** 첫 티어를 쓰고,
 * 어디에도 없으면 전역 평균이다. `matchedKey === null` 이 곧 폴백의 정의다.
 */
export function resolveSegmentEmailRate(
  table: SegmentEmailRateTable | null | undefined,
  descriptor: SegmentDescriptor,
): { rate: number; matchedKey: string | null } {
  const globalRate = Math.max(0, Number(table?.globalRate) || 0);
  if (!table) return { rate: globalRate, matchedKey: null };
  for (const key of segmentTierKeys(descriptor)) {
    const rate = Number(table.segments?.[key]);
    if (Number.isFinite(rate) && rate >= 0) return { rate, matchedKey: key };
  }
  return { rate: globalRate, matchedKey: null };
}

export type HydrationRankingItem = {
  readonly channelId: string;
  /**
   * 인터리브 그룹(=검색 암 또는 보조 레인). **이 값이 같은 후보들 사이에서만** 재정렬한다 —
   * 그룹별 슬롯 수도, 슬롯의 위치도 그대로다.
   */
  readonly group: string;
  readonly segment?: SegmentDescriptor;
};

export type HydrationRankingResult = {
  readonly channelIds: string[];
  /** 표가 없거나 비어 있으면 false — 그때 이 함수는 항등이다(입력 순서 그대로). */
  readonly applied: boolean;
  /** 표가 아는 세그먼트 수(표 크기). 계측 축이지 후보 수가 아니다. */
  readonly segmentsKnown: number;
  /** 전역 평균으로 폴백한 후보의 비율. 1 에 가까우면 표가 이 런에 사실상 무력했다는 뜻이다. */
  readonly fallbackShare: number;
  /** 이번 랭킹으로 위치가 실제 바뀐 후보 비율. 0 이면 표가 있어도 순서 무변(전원 동률·단일 그룹 등). */
  readonly reorderedShare: number;
};

/**
 * A4 — 인터리브 결과를 **그룹 내부에서만** 노출률 순으로 다시 세운다(순수).
 *
 * 정렬 키는 `그룹(고정) → 노출률 내림차순 → 원래 관측 순서`다. 즉 **암 공정성은 정의상 보존된다**:
 * 그룹 g 가 점유하던 위치 집합은 그대로 g 가 점유하고, 그 안에서 어느 채널이 앞에 오는지만 바뀐다.
 * 그래서 뒤따르는 예산 절단(접두 자르기)이 각 암에 주는 슬롯 수는 랭킹 전후가 **완전히 같다**.
 *
 * ⚠️ 이 함수는 순열이다 — 길이도, 원소 집합도 바꾸지 않는다. hydration 상한 fail-closed 불변식이
 *   이 결과의 길이를 그대로 검사하므로, 여기서 원소를 걸러내면 그 불변식의 의미가 바뀐다.
 *   거르는 일은 A2 프리필터의 몫이고, 여기는 **순서만** 만진다.
 */
export function rankHydrationTargetsBySegment(
  items: readonly HydrationRankingItem[],
  table: SegmentEmailRateTable | null | undefined,
): HydrationRankingResult {
  const channelIds = items.map((item) => item.channelId);
  const segmentsKnown = Object.keys(table?.segments ?? {}).length;
  if (!table || segmentsKnown === 0 || items.length === 0) {
    return { channelIds, applied: false, segmentsKnown, fallbackShare: 0, reorderedShare: 0 };
  }
  const positionsByGroup = new Map<string, number[]>();
  const rates: number[] = [];
  let fallbacks = 0;
  items.forEach((item, index) => {
    const { rate, matchedKey } = resolveSegmentEmailRate(table, item.segment ?? {});
    rates.push(rate);
    if (matchedKey === null) fallbacks += 1;
    const positions = positionsByGroup.get(item.group);
    if (positions) positions.push(index);
    else positionsByGroup.set(item.group, [index]);
  });
  const next = channelIds.slice();
  for (const positions of positionsByGroup.values()) {
    // 원래 관측 순서(index 오름차순)로 들어온 위치 목록을 정렬 키로만 다시 세운다.
    const ordered = positions.slice().sort((left, right) => (rates[right] - rates[left]) || (left - right));
    positions.forEach((position, slot) => { next[position] = channelIds[ordered[slot]]; });
  }
  let reordered = 0;
  for (let index = 0; index < next.length; index += 1) {
    if (next[index] !== channelIds[index]) reordered += 1;
  }
  return {
    channelIds: next,
    applied: true,
    segmentsKnown,
    fallbackShare: Number((fallbacks / items.length).toFixed(3)),
    // 리뷰(A4-R1): applied:true + reorderedShare 0 = "표는 맞았지만 순서를 못 바꿈"(전원 동률) —
    // fallbackShare 만으로는 이 제3의 무연산을 관측할 수 없다.
    reorderedShare: Number((reordered / items.length).toFixed(3)),
  };
}
