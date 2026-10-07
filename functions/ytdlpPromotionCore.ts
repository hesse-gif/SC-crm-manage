/**
 * W75 — yt-dlp 관측 증거를 운영 발굴 인입으로 넘기는 별도 소비자의 순수 계약.
 *
 * 섀도 워커는 계속 observation_only 이고 operationalWritesAllowed:false 다. 이 파일은 그 문서를
 * 읽을 수 있는지, 어느 채널을 한 번만 평가할지, 설정이 코드 천장을 넘지 않는지만 판정한다.
 * Firestore 쓰기와 외부 호출은 ytdlpPromotion.ts / discovery.ts 경계가 소유한다.
 */

import { SHADOW_DISCOVERY_JOB_TYPE, YOUTUBE_CHANNEL_LOOKUP_LIMIT } from "./discoveryJobTypes";

export const YTDLP_PROMOTION_CONFIG_PATH = "settings/ytdlp_promotion";
export const YTDLP_PROMOTION_RECEIPT_COLLECTION = "ytdlp_shadow_promotions";
export const YTDLP_PROMOTION_DAILY_COLLECTION = "ytdlp_promotion_daily";
const SCHEDULED_PROMOTION_TRIGGER = "scheduled_promotion";

/**
 * W77 발굴 스루풋 상향 — **산식을 다시 세운 값이다.** 생산만 올리면 소비가 못 따라가고,
 * 그 순간 열린 receipt 창(50칸)과 TTL 이 서로를 잡아먹는다(R2-P0 가 그 형상이었다).
 *
 * ■ 생산 (하루 최대)
 *   dailyQueries 144 = dailyJobs 12 × queriesPerJob 12   ← 두 축이 일치해야 한다
 *   관측 상한 = 144 쿼리 × itemsPerQuery 50 = **7,200 관측/일**
 *   런당 관측 = queriesPerJob 12 × 50 = 600 → 배치 수 = 600 / channelsPerBatch
 *
 * ■ W80 [2차 상향] queriesPerJob 20 → 12 로 **내린** 이유 (반직관이지만 이게 상향의 조건이다)
 *   프로드 실측(2026-08-14): jobs 5 · queries 60 → **q/job = 12.0**. 키워드 우주가 12개라
 *   20 은 **한 번도 도달하지 못하는 천장**이었다. 그런데 게이트는 천장으로 최악을 계산하므로
 *   존재하지 않는 부하(잡당 1,000 관측)를 근거로 잡 수를 묶어 버렸다:
 *     dailyJobs 12 · queriesPerJob 20 → 생산 120 배치/일 > 소비 96, 최악 대기 30h > TTL 24h.
 *   캡을 실측에 맞추면 최악 = 실제가 되고, 같은 안전 기준에서 **잡을 8 → 12 로 올릴 수 있다.**
 *   ⚠️ **재계산 트리거**: 실제 결합점은 키워드 "우주 크기"가 아니라
 *      `HARVEST_KEYWORD_WINDOW_SIZE`(admin.ts, 현재 12)다 — 한 잡이 실제로 싣는 쿼리 수는
 *      그 창이 정하고, 그 상수는 **밴딧 슬롯(SHORTFALL_SLICE_ARM_TOTAL_SLOTS)과 공유**된다.
 *      즉 슬롯을 늘리려고 그 값을 올리면 잡당 쿼리가 함께 늘어 이 캡을 넘고, 그때는 조용한
 *      절단이 아니라 잡 검증이 `shadow_run_query_cap_exceeded` 로 **런을 통째로 폐기**한다.
 *      두 상수는 반드시 같이 움직여야 한다(계약이 결합을 단언한다).
 *
 * ■ 소비 (하루 최대)
 *   sweep 은 60분마다 돌고 한 번에 runsPerSweep 개의 **배치**를 처리한다.
 *   배치/일 = runsPerSweep × 24
 *   runsPerSweep 은 올리지 않았다: 통합 스윕이 timeoutSeconds 300 인데 R1 리뷰가 이미
 *   "rps 4 에서 직렬 부하 480s" 를 지적했다. 소비축 상향은 그 예산을 더 깨는 방향이다.
 *
 * ■ 왜 이 값들인가 (channelsPerBatch 100 · runsPerSweep 4 · dailyJobs 12 · queriesPerJob 12)
 *   배치/런   = 600 / 100 = 6        ← channelsPerBatch 는 **YOUTUBE_CHANNEL_LOOKUP_LIMIT 를
 *                                       넘길 수 없다**: hydration 이 그 값으로 자르므로 초과분이
 *                                       조용히 버려지고 offset 은 전진해 **영구 소실**된다
 *                                       (R1-P0-7 실측). 숫자를 여기 적지 않는 이유 — W112 F-A 에서
 *                                       100→300 상향 때 이 주석과 아래 기본값만 옛 값에 남았다.
 *                                       channelsPerBatch 100 자체는 그대로 둔다: 상한이 올랐다고
 *                                       배치를 키우면 소비축(runsPerSweep·300s 예산)이 깨진다.
 *   생산/일   = 12런 × 6배치 = 72 배치
 *   소비/일   = 4 × 24     = 96 배치   → 여유율 1.33배 (소비 ≥ 생산)
 *   최악 대기 = 72 배치 / 시간당 4 = **18시간**
 *
 * ■ 안전 경계와의 관계 (여기가 R2-P0 재발 방지선이다)
 *   · receiptOpenTtlMs 24h > 최악 대기 18h → 순번을 기다리는 receipt 가 TTL 에 안 잘린다.
 *     이 부등식이 깨지면 대기 중 관측이 조용히 버려진다 — 아래 게이트가 값으로 강제한다.
 *     (TTL 은 offset 0 · lease 없음일 때만 발동하므로 대기 중 문서가 정확히 그 대상이다.)
 *   · 열린 receipt 동시 최대 ≈ 하루 생성 12건 « 50칸 창 → 기아 여유 4배.
 *   · receiptAbsoluteStallMs 7d » 최악 대기 18h → 정상 진행을 절대 상한이 안 건드린다.
 *   소비축을 안 올렸다면(runsPerSweep 2): 소비 48 < 생산 72 → **매일 적자**가 쌓여 대기가
 *   무한히 늘고 TTL 이 뒤에서부터 관측을 조용히 버린다. 그래서 소비 여유가 필요하고,
 *   아래 게이트가 이 부등식을 **런타임에 값으로** 강제한다(주석만으로는 다음 사람이 또 깬다).
 *
 * ■ 단위 구분 (R3 P1-2)
 *   · plannedObservationCount = 예약 관측량 = queriesPerJob × itemsPerQuery = **600/잡**
 *   · 실측 고유 채널 ≈ **561/잡** (쿼리 간 중복 제거 후, 원시 600 기준 약 93.5%).
 *     두 값은 다른 축이고, 단계 상향 가드는 분자·분모를 **planned 한 축으로만** 비교한다
 *     (R2-P0-A). 환산 계수는 그래서 제거됐다 — 여기 561 은 참고 실측치일 뿐 계산에 안 쓴다.
 *
 * ■ 단계 상향(차단 리스크) — 코드 캡은 천장일 뿐이고, 실제 하루 관측은
 *   observationStepUpFactor 가드가 **직전일의 2배**를 넘지 못하게 따로 막는다.
 */
export const YTDLP_PROMOTION_CODE_CAPS = Object.freeze({
  dailyJobs: 12,
  dailyQueries: 144,
  queriesPerJob: 12,
  itemsPerQuery: 50,
  runsPerSweep: 4,
  channelsPerBatch: 100,
  receiptAttempts: 3,
  receiptLeaseMs: 10 * 60 * 1000,
  /**
   * W75-R1 P1-2 (W77 재검산): 열린 receipt 가 이 시간을 넘겨 **아무 진전 없이** 있으면
   *   (offset 0 · lease 없음) 자리를 비운다.
   *   새 산식 기준 최악 대기는 20시간이므로 24시간은 그보다 1.2배 여유다 —
   *   순번을 기다리는 정상 receipt 는 잘리지 않고, 진짜 정지분만 회수된다.
   *   ⚠️ 생산을 더 올리면서 소비를 안 올리면 최악 대기가 24h 를 넘어 **대기 중 관측이
   *      조용히 버려진다.** 캡을 만질 때는 위 산식을 반드시 다시 계산하라.
   */
  receiptOpenTtlMs: 24 * 60 * 60 * 1000,
  /**
   * W75-R1 P1-6: 잡을 이만큼 깨웠는데도 계속 queued 면 소비자(claim 어댑터)가 없다고 본다.
   *   60분 sweep 기준 3회 헛발까지는 봐주고 그 다음부터 신호를 멈춘다 — 일시적 워커 지연과
   *   "어댑터가 아예 없다"를 가르는 선이다.
   */
  workerUnconsumedBackoffMs: 3 * 60 * 60 * 1000,
  /**
   * R2-P0 (W77 재검산): **사유 불문 절대 상한.** 진행 중 보호(offset>0 · 유효 lease)가
   *   영생이 되지 않게 막는 마지막 선이다. 열린 receipt 창은 50칸뿐이라 불멸 문서 하나가
   *   맨 앞을 점유하면 신규 런이 영원히 안 읽힌다(단조 래칫).
   *   새 산식에서 정상 런은 **10배치 · 최악 20시간**이므로 7일은 8배 여유다.
   */
  receiptAbsoluteStallMs: 7 * 24 * 60 * 60 * 1000,
  /**
   * W77-③ **단계 상향 가드.** yt-dlp 라 쿼터 제약은 없지만 차단 리스크가 있어, 하루 관측이
   *   직전일의 이 배수를 넘지 못하게 막는다. 코드 캡(10,000/일)은 천장이고 이 값이 경사다.
   */
  observationStepUpFactor: 2,
  /**
   * W77-③ 부트스트랩 바닥. 직전일이 0(첫날·중단 후 재개)이면 배수 규칙만으로는 영원히
   *   0 이므로, 한 잡 분량(queriesPerJob × itemsPerQuery = 1,000)은 항상 허용한다.
   */
  // R3 배포 전제 ③ (리뷰어 처방 1줄): 배포 첫날 전일 분모가 0(신설 필드)이라 floor 가 곧 첫날
  //   허용량이다. 1000 이면 1~2일차가 1잡·2잡으로 W77 이전(3잡)보다 낮아진다 — 3000 은 첫날부터
  //   기존 기준선(3잡)을 넘기면서 상향 경사를 유지한다.
  //   R1-P2-1 실측 정정: 새 캡(잡 12 · planned 600/잡)에서 실제 경사는 **[5, 10, 12]** 다
  //   (첫날 3000/600 = 5잡 → 이튿날 6000 → 10잡 → 사흘째 천장). 옛 주석의 [3,6,8,…] 은
  //   queriesPerJob 20 시절 수치라 더 이상 맞지 않는다 — 계약(tests/w80-cap-raise)이 이 수열을 못박는다.
  observationStepUpFloor: 3000,
});

const RECEIPT_QUERY_CAP = YTDLP_PROMOTION_CODE_CAPS.queriesPerJob;
const RECEIPT_QUERY_CHANNEL_SET_CAP = YTDLP_PROMOTION_CODE_CAPS.itemsPerQuery;

/**
 * 헤세 결정(2026-09-27) "AI Drama만 상시 허용" — 이 스케줄 프로모션 파이프라인(`scheduled_promotion`
 * 트리거, 시간당 크론)을 discoveryVertical === "ai_drama" 캠페인의 **기본(primary) 키워드 검색**으로
 * 승격한다. `ytdlpShadowDiscovery.ts`의 SHADOW_PROHIBITED_TRIGGERS(quota_exhausted 등)는 그대로
 * 둔다 — 이건 이미 허용된 `scheduled_promotion` 트리거를 **어느 캠페인에 적용할 수 있는가**를 좁히는
 * 별도의 구조적 게이트이지, 트리거 화이트리스트를 여는 게 아니다.
 *
 * settings/ytdlp_promotion 문서의 `primaryLaneApprovalRef` 가 이 값과 정확히 일치하고, 대상
 * 캠페인의 버티컬이 아래 허용 목록에 있을 때만 "primary" 취급을 받는다(캠페인 검증은 호출부
 * — enqueueNextShadowJob / searchYouTubeLive — 가 실제 캠페인/프로그램 문서를 읽고 수행한다).
 * 필드가 비어 있으면(기본값) 아무것도 바뀌지 않는다 — opt-in, 화이트리스트 하나, 사유 문자열 하나,
 * "다른 프로그램은 그대로 금지"를 코드로 못박는다(사람이 campaignId만 바꿔서 우회할 수 없다).
 */
export const AI_DRAMA_YTDLP_PRIMARY_LANE_APPROVAL_REF = "hesse_decision_2026-09-27_ai_drama_ytdlp_primary";
export const YTDLP_PROMOTION_PRIMARY_LANE_ALLOWED_VERTICALS: readonly string[] = Object.freeze(["ai_drama"]);

export type YtdlpPromotionConfig = {
  readonly enabled: true;
  readonly activationId: string;
  readonly campaignId: string;
  readonly consumeAfterIso: string;
  /** "" 면 primary-lane 승격 미신청 — 종전 동작과 바이트 단위로 같다. */
  readonly primaryLaneApprovalRef: string;
  readonly dailyJobCap: number;
  readonly dailyQueryCap: number;
  readonly queriesPerJob: number;
  readonly maxItemsPerQuery: number;
  readonly runsPerSweep: number;
  readonly channelsPerBatch: number;
};

export type YtdlpPromotionConfigResolution =
  | { readonly enabled: false; readonly reasonCode: string }
  | { readonly enabled: true; readonly config: YtdlpPromotionConfig };

export type ShadowObservation = {
  readonly channelId: string;
  readonly channelUrl: string;
  readonly title: string;
  readonly queries: readonly string[];
  readonly videoIds: readonly string[];
};

export type PromotableShadowRun = {
  readonly id: string;
  readonly finishedAtIso: string;
  readonly sourceRunRef: string;
  readonly canonicalProgramId: string;
  readonly queryPlan: readonly string[];
  readonly observations: readonly ShadowObservation[];
  readonly rawObservationCount: number;
  readonly queryCount: number;
};

export type ShadowRunResolution =
  | { readonly ok: false; readonly reasonCode: string }
  | { readonly ok: true; readonly run: PromotableShadowRun };

export type ShadowPromotionScope = {
  readonly campaignId: string;
  readonly activationId: string;
};

export type QueryPromotionMetric = {
  readonly query: string;
  readonly observedUnique: number;
  readonly eligibleUnique: number;
  readonly promotedCandidates: number;
  readonly emailResolved: number;
};

export type QueryPromotionChannelSets = {
  readonly observedChannelIds: readonly string[];
  readonly eligibleChannelIds: readonly string[];
  readonly promotedChannelIds: readonly string[];
  readonly emailResolvedChannelIds: readonly string[];
};

export type PromotionCandidateEvidence = {
  readonly candidateId: string;
  readonly sourceRunId: string;
  readonly persistOutcome: string;
  readonly email: string;
};

/**
 * 후보 transaction은 성공했지만 receipt 마감 전에 프로세스가 끊긴 경우만 재개 가능한 created로 본다.
 * 같은 sourceRunId라도 기존 문서를 merge한 증거는 신규 전환으로 되살리지 않는다.
 */
export function classifyPromotionCandidateEvidence(input: {
  candidateIds: readonly string[];
  globallyExistingChannelIds: ReadonlySet<string>;
  participationRecords: readonly PromotionCandidateEvidence[];
  promotionRunId: string;
}): {
  priorChannelIds: Set<string>;
  recoveredCreatedChannelIds: Set<string>;
  recoveredEmailResolvedChannelIds: Set<string>;
} {
  const requested = new Set(input.candidateIds);
  const priorChannelIds = new Set(
    [...input.globallyExistingChannelIds].filter((channelId) => requested.has(channelId)),
  );
  const recoveredCreatedChannelIds = new Set<string>();
  const recoveredEmailResolvedChannelIds = new Set<string>();
  for (const item of input.participationRecords) {
    if (!requested.has(item.candidateId)) continue;
    const isRecoverableCreated = item.sourceRunId === input.promotionRunId && item.persistOutcome === "created";
    if (!isRecoverableCreated) {
      priorChannelIds.add(item.candidateId);
      recoveredCreatedChannelIds.delete(item.candidateId);
      recoveredEmailResolvedChannelIds.delete(item.candidateId);
      continue;
    }
    if (priorChannelIds.has(item.candidateId)) continue;
    recoveredCreatedChannelIds.add(item.candidateId);
    if (item.email.trim()) recoveredEmailResolvedChannelIds.add(item.candidateId);
  }
  return { priorChannelIds, recoveredCreatedChannelIds, recoveredEmailResolvedChannelIds };
}

/**
 * W84: `existingChannelIds` 로 빠지는 채널 중 **이메일이 없는 것**을 따로 들고 나온다.
 *
 * 실측(2026-08-15)이 이 함수를 지목했다:
 *   고유 관측 채널 1,166 · 이미 이메일 보유 33 · **증분 대상 1,133**
 *   설명란 마이닝 잠재력 7.6%(보유 videoId 기준, 250채널당 8유닛)인데 프로드 실적은 1.8%.
 *   갭의 정체는 `dedupExistingCandidate`(실측 391) 다 — 이미 pool 에 있는 채널은 여기서
 *   탈락하고, **이메일이 없어도** 다시는 마이닝 기회를 못 얻는다. 재발굴돼도 매번 같은 자리에서
 *   떨어지므로 무이메일 상태가 영구 고착된다.
 *
 * 승격(신규 후보 생성) 대상에는 여전히 넣지 않는다 — 그건 중복 생성이다. 대신
 * **이메일 보충 대상**으로만 분리한다. 관측이 videoId 를 이미 들고 있으므로 추가 조회는 0이고,
 * 스코프 컨텍스트가 살아있는 hydration 시점에서 처리한다(W77-④가 별도 레인으로 풀려다 실패한
 * 문제의 정답 위치).
 */
export function selectEligiblePromotionObservations(input: {
  observations: readonly ShadowObservation[];
  existingChannelIds: ReadonlySet<string>;
  contactedChannelIds: ReadonlySet<string>;
  /** 이메일을 이미 가진 기존 채널. 보충 대상에서 뺀다(있는 걸 또 캐지 않는다). */
  existingEmailChannelIds?: ReadonlySet<string>;
}): {
  eligible: ShadowObservation[];
  /** W84: 기존 후보이지만 이메일이 없어 **설명란 보충 대상**인 관측. */
  emailBackfillTargets: ShadowObservation[];
  dedupExisting: number;
  dedupContacted: number;
} {
  let dedupExisting = 0;
  let dedupContacted = 0;
  const eligible: ShadowObservation[] = [];
  const emailBackfillTargets: ShadowObservation[] = [];
  const backfillSeen = new Set<string>();
  for (const observation of input.observations) {
    if (input.existingChannelIds.has(observation.channelId)) {
      dedupExisting += 1;
      // 이미 이메일이 있으면 보충할 게 없다. 없을 때만, 채널당 한 번만 담는다.
      if (
        !input.existingEmailChannelIds?.has(observation.channelId)
        && !backfillSeen.has(observation.channelId)
      ) {
        backfillSeen.add(observation.channelId);
        emailBackfillTargets.push(observation);
      }
      continue;
    }
    if (input.contactedChannelIds.has(observation.channelId)) {
      dedupContacted += 1;
      continue;
    }
    eligible.push(observation);
  }
  return { eligible, emailBackfillTargets, dedupExisting, dedupContacted };
}

export function selectEmailDedupedPromotionCandidates<T>(input: {
  candidates: readonly T[];
  emailOf(candidate: T): string;
  existingEmails: ReadonlySet<string>;
  contactedEmails: ReadonlySet<string>;
}): {
  eligible: T[];
  dedupExistingEmail: number;
  dedupContactedEmail: number;
  dedupDuplicateEmail: number;
} {
  let dedupExistingEmail = 0;
  let dedupContactedEmail = 0;
  let dedupDuplicateEmail = 0;
  const selectedEmails = new Set<string>();
  const eligible: T[] = [];
  for (const candidate of input.candidates) {
    const email = input.emailOf(candidate).trim().toLowerCase();
    if (email && input.existingEmails.has(email)) {
      dedupExistingEmail += 1;
      continue;
    }
    if (email && input.contactedEmails.has(email)) {
      dedupContactedEmail += 1;
      continue;
    }
    if (email && selectedEmails.has(email)) {
      dedupDuplicateEmail += 1;
      continue;
    }
    if (email) selectedEmails.add(email);
    eligible.push(candidate);
  }
  return { eligible, dedupExistingEmail, dedupContactedEmail, dedupDuplicateEmail };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, max = 300): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function strictInt(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function validIso(value: unknown): string {
  const resolved = text(value, 80);
  return resolved && Number.isFinite(Date.parse(resolved)) ? resolved : "";
}

/**
 * R2-P1-C: 캡 산식 게이트를 **설정 해석 시점에** 실행한다. 함수만 만들어 두고 호출자가 0이면
 *   게이트가 아니라 문서다(리뷰 지적).
 *
 * R1-P1-2 정정: 이 함수는 **깎지 않는다.** 위반을 구조화 로그로 드러낼 뿐이고 설정은 그대로
 *   통과한다(void). 종전 주석이 "깎아서 반환한다"고 썼는데 구현과 달랐다 — 읽는 사람이
 *   "게이트가 알아서 막아준다"고 오해하면 그게 더 위험하다.
 *   거절로 승격하지 않는 이유: 이 경로는 잡 예약 전체의 관문이라, 캡 조합이 어긋난 순간
 *   발굴이 **통째로 멈춘다**(P0-1 이 정확히 그 사고였다). 관측으로 드러내고 사람이 고치는 쪽이
 *   같은 사고를 반복하지 않는다.
 */
function assertThroughputBudget(effective: {
  dailyJobs: number; dailyQueries: number; queriesPerJob: number;
  itemsPerQuery: number; runsPerSweep: number; channelsPerBatch: number;
}): void {
  // **실효값**으로 검사한다. 코드 캡은 천장일 뿐이고 실제로 도는 값은 config 다 —
  //   천장만 검사하면 config 가 부등식을 깨도 게이트가 조용하다.
  const budget = evaluateThroughputBudget({ ...YTDLP_PROMOTION_CODE_CAPS, ...effective });
  if (budget.violations.length === 0) return;
  console.warn(JSON.stringify({
    event: "ytdlp_promotion.throughput_budget_violation",
    violations: budget.violations,
    producedBatchesPerDay: budget.producedBatchesPerDay,
    drainedBatchesPerDay: budget.drainedBatchesPerDay,
    worstCaseWaitHours: budget.worstCaseWaitHours,
  }));
}

export function resolveYtdlpPromotionConfig(value: unknown): YtdlpPromotionConfigResolution {
  const input = record(value);
  if (input.enabled !== true) return { enabled: false, reasonCode: "ytdlp_promotion_disabled" };
  const activationId = text(input.activationId, 160);
  const campaignId = text(input.campaignId, 160);
  const consumeAfterIso = validIso(input.consumeAfterIso);
  if (!activationId) return { enabled: false, reasonCode: "ytdlp_promotion_activation_missing" };
  if (!campaignId) return { enabled: false, reasonCode: "ytdlp_promotion_campaign_missing" };
  if (!consumeAfterIso) return { enabled: false, reasonCode: "ytdlp_promotion_consume_after_invalid" };
  // 정확한 매칭·버티컬 검증은 이 문서가 어느 캠페인/버티컬을 가리키는지 아는 호출부
  // (enqueueNextShadowJob·searchYouTubeLive)의 몫이다 — 이 함수는 여느 문자열 필드처럼 그대로 읽어
  // 넘기기만 한다(캡 산식 게이트라는 이 파일의 계약을 넓히지 않는다).
  // 코덱스 라운드1 LOW 수리: 여기서만은 `text()`(트림·비문자열→"" 변환)를 안 쓴다 — "정확히 일치"라는
  // 계약을 이 필드가 스스로 지켜야 한다. 비어 있지 않은데 문자열이 아니면 설정 문서 전체를 거절한다
  // (다른 필드가 code cap 초과일 때와 같은 fail-closed 취급 — 조용히 ""로 바뀌어 "미신청"으로
  // 오인되면 안 된다).
  if (input.primaryLaneApprovalRef !== undefined && typeof input.primaryLaneApprovalRef !== "string") {
    return { enabled: false, reasonCode: "ytdlp_promotion_primary_lane_approval_malformed" };
  }
  const primaryLaneApprovalRef = typeof input.primaryLaneApprovalRef === "string"
    ? input.primaryLaneApprovalRef.slice(0, 200)
    : "";

  const dailyJobCap = strictInt(input.dailyJobCap, 3, 1, YTDLP_PROMOTION_CODE_CAPS.dailyJobs);
  const dailyQueryCap = strictInt(input.dailyQueryCap, 60, 1, YTDLP_PROMOTION_CODE_CAPS.dailyQueries);
  // R1-P1-1: fallback 은 **캡 이하**여야 한다. 20 은 새 캡 12 를 넘는데 strictInt 의 min/max
  //   검사는 입력값에만 걸리므로, 필드를 생략하면 20 이 그대로 통과해 최악 대기 30h(>TTL 24h)가
  //   되살아난다. 기본값도 캡을 따라가야 한다 — 아래 계약이 "모든 기본값 ≤ 캡"을 단언한다.
  const queriesPerJob = strictInt(
    input.queriesPerJob, YTDLP_PROMOTION_CODE_CAPS.queriesPerJob, 1, YTDLP_PROMOTION_CODE_CAPS.queriesPerJob,
  );
  const maxItemsPerQuery = strictInt(input.maxItemsPerQuery, 50, 1, YTDLP_PROMOTION_CODE_CAPS.itemsPerQuery);
  const runsPerSweep = strictInt(input.runsPerSweep, 1, 1, YTDLP_PROMOTION_CODE_CAPS.runsPerSweep);
  const channelsPerBatch = strictInt(input.channelsPerBatch, 100, 1, YTDLP_PROMOTION_CODE_CAPS.channelsPerBatch);
  if ([dailyJobCap, dailyQueryCap, queriesPerJob, maxItemsPerQuery, runsPerSweep, channelsPerBatch].some((item) => item === null)) {
    return { enabled: false, reasonCode: "ytdlp_promotion_config_over_code_cap" };
  }
  assertThroughputBudget({
    dailyJobs: dailyJobCap!,
    dailyQueries: dailyQueryCap!,
    queriesPerJob: queriesPerJob!,
    itemsPerQuery: maxItemsPerQuery!,
    runsPerSweep: runsPerSweep!,
    channelsPerBatch: channelsPerBatch!,
  });
  if (queriesPerJob! > dailyQueryCap!) {
    return { enabled: false, reasonCode: "ytdlp_promotion_query_caps_inconsistent" };
  }
  return {
    enabled: true,
    config: {
      enabled: true,
      activationId,
      campaignId,
      consumeAfterIso,
      primaryLaneApprovalRef,
      dailyJobCap: dailyJobCap!,
      dailyQueryCap: dailyQueryCap!,
      queriesPerJob: queriesPerJob!,
      maxItemsPerQuery: maxItemsPerQuery!,
      runsPerSweep: runsPerSweep!,
      channelsPerBatch: channelsPerBatch!,
    },
  };
}

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const SHADOW_RUN_ID = /^ytdlp_shadow_[a-f0-9]{40}$/;

/** complete·무드리프트·무운영쓰기인 저장 증거만 읽는다. 잘린 증거는 전환률 분모가 거짓이라 거절한다. */
function resolvePromotableShadowRunDocument(id: string, value: unknown): ShadowRunResolution {
  const input = record(value);
  if (!SHADOW_RUN_ID.test(id)) return { ok: false, reasonCode: "shadow_run_identity_invalid" };
  if (input.status !== "complete") return { ok: false, reasonCode: "shadow_run_not_complete" };
  if (input.mode !== "observation_only" || input.operationalWritesAllowed !== false) {
    return { ok: false, reasonCode: "shadow_run_boundary_invalid" };
  }
  if (input.operationalWrites !== 0) return { ok: false, reasonCode: "shadow_run_operational_writes_nonzero" };
  if (input.schemaDrift !== 0) return { ok: false, reasonCode: "shadow_run_schema_drift" };
  if (input.evidenceTruncated !== false) return { ok: false, reasonCode: "shadow_run_evidence_truncated" };
  if (input.promotionEligible !== false) return { ok: false, reasonCode: "shadow_run_promotion_boundary_invalid" };
  const finishedAtIso = validIso(input.finishedAtIso);
  if (!finishedAtIso) return { ok: false, reasonCode: "shadow_run_finished_at_invalid" };

  const byChannel = new Map<string, { channelUrl: string; title: string; queries: Set<string>; videoIds: Set<string> }>();
  let rawObservationCount = 0;
  const queryNames: string[] = [];
  const batches = Array.isArray(input.observationBatches) ? input.observationBatches : [];
  if (batches.length === 0 || batches.length > YTDLP_PROMOTION_CODE_CAPS.queriesPerJob) {
    return { ok: false, reasonCode: "shadow_run_query_cap_exceeded" };
  }
  for (const [batchIndex, rawBatch] of batches.entries()) {
    const batch = record(rawBatch);
    const rawQuery = text(batch.query, 501);
    if (
      rawQuery.length === 0
      || rawQuery.length > 500
      || batch.queryIndex !== batchIndex
      || queryNames.includes(rawQuery)
    ) return { ok: false, reasonCode: "shadow_run_query_invalid" };
    const query = rawQuery;
    queryNames.push(query);
    const observations = Array.isArray(batch.observations) ? batch.observations : [];
    if (observations.length > YTDLP_PROMOTION_CODE_CAPS.itemsPerQuery) {
      return { ok: false, reasonCode: "shadow_run_items_per_query_cap_exceeded" };
    }
    for (const rawObservation of observations) {
      rawObservationCount += 1;
      if (rawObservationCount > YTDLP_PROMOTION_CODE_CAPS.queriesPerJob * YTDLP_PROMOTION_CODE_CAPS.itemsPerQuery) {
        return { ok: false, reasonCode: "shadow_run_observation_cap_exceeded" };
      }
      const observation = record(rawObservation);
      const channelId = text(observation.channelId, 120);
      const videoId = text(observation.videoId, 32);
      const claimedChannelUrl = text(observation.channelUrl, 500);
      const channelUrl = `https://www.youtube.com/channel/${channelId}`;
      const title = text(observation.title, 300);
      if (!CHANNEL_ID.test(channelId) || !VIDEO_ID.test(videoId) || claimedChannelUrl !== channelUrl || !title) {
        return { ok: false, reasonCode: "shadow_run_observation_identity_invalid" };
      }
      const prior = byChannel.get(channelId) ?? {
        channelUrl,
        title,
        queries: new Set<string>(),
        videoIds: new Set<string>(),
      };
      prior.queries.add(query);
      prior.videoIds.add(videoId);
      byChannel.set(channelId, prior);
    }
  }
  if (byChannel.size === 0) return { ok: false, reasonCode: "shadow_run_observations_empty" };
  const observations = [...byChannel.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([channelId, item]) => ({
      channelId,
      channelUrl: item.channelUrl,
      title: item.title,
      queries: [...item.queries].sort(),
      videoIds: [...item.videoIds].sort(),
    }));
  return {
    ok: true,
    run: {
      id,
      finishedAtIso,
      sourceRunRef: text(input.sourceRunRef, 300),
      canonicalProgramId: "",
      queryPlan: queryNames,
      observations,
      rawObservationCount,
      queryCount: queryNames.length,
    },
  };
}

/**
 * run 문서 단독 신뢰 금지: 같은 ID의 producer/worker 잡과 campaign·program·activation·queryPlan을
 * 정확히 대조한다. 섀도 summary 자체에는 scope가 없으므로 이 조인이 교차-program 승격 방지선이다.
 */
export function resolvePromotableShadowRun(
  id: string,
  runValue: unknown,
  jobValue: unknown,
  expectedScope: ShadowPromotionScope,
): ShadowRunResolution {
  const resolved = resolvePromotableShadowRunDocument(id, runValue);
  if (!resolved.ok) return resolved;
  const run = record(runValue);
  const job = record(jobValue);
  const campaignId = text(job.campaignId, 180);
  const programId = text(job.programId, 180);
  const canonicalProgramId = text(job.canonicalProgramId, 180);
  const activationId = text(job.activationId, 180);
  const logicalRunId = text(job.runId, 180);
  const rawJobQueries = Array.isArray(job.queryPlan) ? job.queryPlan : [];
  const jobQueries = rawJobQueries.map((item) => text(item, 501));
  const runQueries = [...resolved.run.queryPlan];
  const exactQueryPlan = jobQueries.length === rawJobQueries.length
    && jobQueries.length === resolved.run.queryCount
    && jobQueries.length > 0
    && jobQueries.length <= YTDLP_PROMOTION_CODE_CAPS.queriesPerJob
    && jobQueries.every((query, index) => (
      query.length > 0
      && query.length <= 500
      && query === runQueries[index]
      && jobQueries.indexOf(query) === index
    ));
  if (
    text(job.idempotencyKey, 180) !== id
    || text(job.type, 100) !== SHADOW_DISCOVERY_JOB_TYPE
    || text(job.status, 40) !== "complete"
    || text(job.shadowRunStatus, 40) !== "complete"
    || text(job.shadowRunRef, 240) !== `discovery_shadow_runs/${id}`
    || text(job.trigger, 80) !== SCHEDULED_PROMOTION_TRIGGER
    || !/^w75_[A-Za-z0-9_-]+$/.test(logicalRunId)
    || !/^ytdlp_promotion_daily\/\d{4}-\d{2}-\d{2}$/.test(text(job.sourceRunRef, 300))
    || text(job.environment, 40) !== "production"
    || job.operationalWritesAllowed !== false
    || job.promotionEligible !== false
  ) return { ok: false, reasonCode: "shadow_job_evidence_invalid" };
  if (
    text(run.jobId, 180) !== id
    || text(run.runId, 180) !== logicalRunId
    || text(run.jobType, 100) !== SHADOW_DISCOVERY_JOB_TYPE
    || text(run.evidenceObject, 260) !== `firestore://discovery_shadow_runs/${id}`
    || text(run.provider, 40) !== "yt-dlp"
    || run.schemaVersion !== 1
    || text(run.environment, 40) !== "production"
    || !Array.isArray(run.failureReasons)
    || run.failureReasons.length !== 0
  ) return { ok: false, reasonCode: "shadow_run_evidence_identity_invalid" };
  if (
    campaignId !== expectedScope.campaignId
    || !programId
    || canonicalProgramId !== programId
  ) return { ok: false, reasonCode: "shadow_run_scope_mismatch" };
  if (
    activationId !== expectedScope.activationId
    || text(run.activationId, 180) !== activationId
  ) return { ok: false, reasonCode: "shadow_run_activation_mismatch" };
  if (
    text(run.sourceRunRef, 300) !== text(job.sourceRunRef, 300)
    || text(run.queryPlanHash, 100) !== text(job.queryPlanHash, 100)
    || !exactQueryPlan
  ) return { ok: false, reasonCode: "shadow_run_plan_mismatch" };
  if (
    run.rawObservations !== resolved.run.rawObservationCount
    || run.uniqueChannels !== resolved.run.observations.length
    || run.evidenceStoredObservations !== resolved.run.rawObservationCount
  ) return { ok: false, reasonCode: "shadow_run_count_mismatch" };
  return { ok: true, run: { ...resolved.run, canonicalProgramId } };
}

/**
 * W77 [R1-P1] — **소비 ≥ 생산 게이트.**
 *
 * 캡 산식은 주석으로만 지켜지지 않는다(리뷰가 실측으로 증명했다: channelsPerBatch 를 200 으로
 * 올리는 순간 hydration 상한 100 을 넘겨 초과분이 조용히 버려졌고, 그래도 테스트는 34/0 이었다).
 * 그래서 부등식을 **값으로** 검사한다. 하나라도 깨지면 설정이 잘못된 것이다.
 *
 *   · 배치/런 = ceil(런당 관측 / channelsPerBatch)
 *   · 생산/일 = dailyJobs × 배치/런     · 소비/일 = runsPerSweep × 24
 *   · 최악 대기 = 생산/일 ÷ runsPerSweep (시간)  <  receiptOpenTtlMs
 *   · channelsPerBatch ≤ hydration 조회 상한(초과분은 조용히 버려진다)
 */
export function evaluateThroughputBudget(
  caps: {
    readonly dailyJobs: number; readonly dailyQueries: number; readonly queriesPerJob: number;
    readonly itemsPerQuery: number; readonly runsPerSweep: number; readonly channelsPerBatch: number;
    readonly receiptOpenTtlMs: number;
  } = YTDLP_PROMOTION_CODE_CAPS,
  // W112 F-A: 종전에는 여기 100 이 하드코딩돼 있었다. 상한을 300 으로 올렸을 때 이 파일만
  //   옛 값에 남아 "상수 하나가 절단 전부를 통제한다"는 단정이 조용히 거짓이 됐다 —
  //   적대 리뷰가 실행으로 잡았다(channelsPerBatch=200 이 100 기준 위반, 300 기준 합법).
  //   기본값을 정본에 묶어 드리프트를 구조적으로 없앤다.
  hydrationLookupLimit: number = YOUTUBE_CHANNEL_LOOKUP_LIMIT,
): {
  readonly batchesPerRun: number;
  readonly producedBatchesPerDay: number;
  readonly drainedBatchesPerDay: number;
  readonly worstCaseWaitHours: number;
  readonly violations: string[];
} {
  const observationsPerRun = caps.queriesPerJob * caps.itemsPerQuery;
  const batchesPerRun = Math.ceil(observationsPerRun / caps.channelsPerBatch);
  const producedBatchesPerDay = caps.dailyJobs * batchesPerRun;
  const drainedBatchesPerDay = caps.runsPerSweep * 24;
  const worstCaseWaitHours = producedBatchesPerDay / caps.runsPerSweep;
  const violations: string[] = [];
  if (caps.dailyQueries !== caps.dailyJobs * caps.queriesPerJob) {
    violations.push("daily_query_cap_mismatch");
  }
  if (caps.channelsPerBatch > hydrationLookupLimit) {
    // 넘기면 초과분이 hydration 에서 잘려 나가는데 offset 은 전진한다 = 영구 소실.
    violations.push("channels_per_batch_exceeds_hydration_lookup_limit");
  }
  if (drainedBatchesPerDay < producedBatchesPerDay) {
    violations.push("consumption_below_production");
  }
  if (worstCaseWaitHours * 60 * 60 * 1000 >= caps.receiptOpenTtlMs) {
    violations.push("worst_case_wait_exceeds_receipt_ttl");
  }
  return { batchesPerRun, producedBatchesPerDay, drainedBatchesPerDay, worstCaseWaitHours, violations };
}

/**
 * W77-③ — **하루 관측 볼륨 단계 상향 가드.**
 *
 * yt-dlp 는 YouTube 쿼터를 쓰지 않으니 코드 캡을 크게 올려도 회계상 문제는 없다. 문제는
 * **차단 리스크**다. 어제 400건 보던 곳이 오늘 갑자기 10,000건을 긁으면 그 자체가 신호다.
 * 그래서 코드 캡(천장)과 별개로, 하루 관측이 **직전일의 배수**를 넘지 못하게 경사를 둔다.
 *
 * 순수 함수다 — 잡을 하나 더 예약해도 되는지를 값으로만 판단한다(호출부가 트랜잭션 안에서 쓴다).
 */
export function withinObservationStepUp(input: {
  /** 오늘 이미 예약된 관측량(plannedObservationCount). 분모와 **같은 필드**여야 한다. */
  readonly observedToday: number;
  /** 직전일 예약 관측량(plannedObservationCount). 실측 필드와 섞으면 데드락이 난다(R2-P0-A). */
  readonly observedYesterday: number;
  /** 이번 잡이 추가로 예약할 관측량(같은 필드 단위). */
  readonly projected: number;
},
  /**
   * W80: 캡 주입 이음매. 경사(floor·factor)는 캡이 정하는데 인자로 못 받으면 "가드가 실제로
   *   경사를 만드는가"를 값으로 확인할 수 없다 — evaluateThroughputBudget 와 같은 관례로 연다.
   *   프로덕션 호출부는 인자를 안 넘기므로 기본값(코드 캡) 그대로다.
   */
  caps: { readonly observationStepUpFloor: number; readonly observationStepUpFactor: number } =
    YTDLP_PROMOTION_CODE_CAPS,
): { readonly allowed: boolean; readonly limit: number; readonly wouldBe: number } {
  const today = Math.max(0, Math.trunc(Number(input.observedToday) || 0));
  const yesterday = Math.max(0, Math.trunc(Number(input.observedYesterday) || 0));
  const projected = Math.max(0, Math.trunc(Number(input.projected) || 0));
  // 직전일이 0 이면 배수 규칙만으로는 영원히 0 이다(첫날·중단 후 재개). 바닥을 깔아 부트스트랩한다.
  const limit = Math.max(caps.observationStepUpFloor, yesterday * caps.observationStepUpFactor);
  const wouldBe = today + projected;
  // R1-P0-8: **잡 1개는 항상 통과시킨다.** 분자(예약 원시 관측)와 분모(실측 고유 채널)의 단위가
  //   어긋나 있던 시절, 하루 1잡만 예약되고 그 다음이 영구히 막히는 데드락이 실측됐다
  //   (8일 시뮬레이션: 스루풋이 W77 이전보다 하락). 단위를 고유 채널로 통일했지만,
  //   경사 규칙이 **전진을 0으로 만드는 상태**는 어떤 경우에도 만들지 않는다.
  if (today === 0) return { allowed: true, limit, wouldBe };
  return { allowed: wouldBe <= limit, limit, wouldBe };
}

export function promotionObservationBatch(
  run: PromotableShadowRun,
  offset: number,
  limit: number,
): { readonly items: readonly ShadowObservation[]; readonly nextOffset: number; readonly complete: boolean } {
  const start = Number.isSafeInteger(offset) && offset >= 0 ? Math.min(offset, run.observations.length) : 0;
  const size = Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, YTDLP_PROMOTION_CODE_CAPS.channelsPerBatch)
    : YTDLP_PROMOTION_CODE_CAPS.channelsPerBatch;
  const items = run.observations.slice(start, start + size);
  const nextOffset = start + items.length;
  return { items, nextOffset, complete: nextOffset >= run.observations.length };
}

/**
 * 기존 YouTube 검색 경로의 publishedAfter(recentActivityDays)와 같은 의미를 관측 주입에도 적용한다.
 * videos.list 응답이 없거나 날짜가 손상된 채널은 최근 활동을 증명하지 못했으므로 fail-closed 제외한다.
 *
 * ⚠️ 26-08-27 [헤세 지시 "버리는 애들 없게"] — **기본값이 게이트에서 신호로 바뀌었다.**
 *
 * 전제가 깨져 있었다: 이 판정은 "샘플 영상의 최신 게시일 = 채널의 최신 활동"을 가정하는데,
 * 워커 검색이 `ytsearch`(**관련도** 정렬)라 활발한 채널에서도 몇 년 전 영상이 샘플로 잡힌다.
 * 그러면 활동 중인 채널이 "증명 실패"로 탈락한다 — 실측(영수증 25건): eligible 5,313 중
 * **4,700(88.5%)이 이 필터에서 탈락**했고, 정책 탈락은 38(0.7%)뿐이었다. 즉 버려진 물량의
 * 거의 전부가 이 거짓 탈락이다.
 *
 * 그래서 `dropStale:true` 를 **명시**할 때만 종전처럼 잘라내고, 기본은 전량 통과시킨다.
 * 통과분은 뒤의 candidate_pool 프리필터·이메일 추출을 그대로 지나므로 판정이 사라지는 게 아니라
 * **더 정확한 단계로 미뤄질 뿐**이다. 하이드레이션 쿼터는 실측상 전체의 1%(channels 399유닛/일)라
 * 전량 통과해도 여유가 크다. `staleObserved` 로 몇 건이 예전 기준이었는지는 계속 센다.
 */
export function filterPromotionObservationsByRecentVideo(input: {
  observations: readonly ShadowObservation[];
  publishedAtByVideoId: ReadonlyMap<string, string>;
  recentActivityDays: number;
  nowMs: number;
  /** true 면 종전 게이트(오래된 채널 제외). 생략하면 전량 통과 + 계측만. */
  dropStale?: boolean;
}): {
  eligible: ShadowObservation[];
  latestPublishedAtByChannelId: Map<string, string>;
  dropped: number;
  /** 종전 기준이었다면 잘렸을 관측 수. dropStale:true 면 dropped 와 같다. */
  staleObserved: number;
} {
  const days = Math.max(1, Math.min(90, Math.trunc(input.recentActivityDays)));
  const cutoffMs = input.nowMs - days * 24 * 60 * 60 * 1000;
  const eligible: ShadowObservation[] = [];
  const latestPublishedAtByChannelId = new Map<string, string>();
  let dropped = 0;
  let staleObserved = 0;
  for (const observation of input.observations) {
    let latestIso = "";
    let latestMs = Number.NEGATIVE_INFINITY;
    for (const videoId of observation.videoIds) {
      const publishedAtIso = input.publishedAtByVideoId.get(videoId) ?? "";
      const publishedAtMs = Date.parse(publishedAtIso);
      if (Number.isFinite(publishedAtMs) && publishedAtMs > latestMs) {
        latestMs = publishedAtMs;
        latestIso = publishedAtIso;
      }
    }
    const stale = !latestIso || latestMs < cutoffMs;
    if (stale) {
      staleObserved += 1;
      // 게이트 모드에서만 실제로 버린다. 기본 모드는 계측만 하고 통과시킨다 —
      // 날짜를 못 구한 채널도 마찬가지다(관련도 정렬 샘플의 한계이지 채널의 결격이 아니다).
      if (input.dropStale === true) {
        dropped += 1;
        continue;
      }
    }
    // 날짜를 실제로 구한 경우에만 최신값을 싣는다(없는 값을 지어내지 않는다).
    if (latestIso) latestPublishedAtByChannelId.set(observation.channelId, latestIso);
    eligible.push(observation);
  }
  return { eligible, latestPublishedAtByChannelId, dropped, staleObserved };
}

/**
 * 배치 재개 시 동일 채널이 다른 query/batch에 다시 나타나도 분모·분자가 중복 합산되지 않게 한다.
 * receipt에는 channelId 집합만 남기며 개인정보/설명/이메일 원문은 저장하지 않는다.
 */
export function queryPromotionChannelSets(input: {
  observations: readonly ShadowObservation[];
  eligibleChannelIds: ReadonlySet<string>;
  promotedChannelIds: ReadonlySet<string>;
  emailResolvedChannelIds: ReadonlySet<string>;
}): Record<string, QueryPromotionChannelSets> {
  const sets = new Map<string, { observed: Set<string>; eligible: Set<string>; promoted: Set<string>; email: Set<string> }>();
  for (const observation of input.observations) {
    for (const query of observation.queries) {
      const current = sets.get(query) ?? { observed: new Set(), eligible: new Set(), promoted: new Set(), email: new Set() };
      current.observed.add(observation.channelId);
      if (input.eligibleChannelIds.has(observation.channelId)) current.eligible.add(observation.channelId);
      if (input.promotedChannelIds.has(observation.channelId)) current.promoted.add(observation.channelId);
      if (input.emailResolvedChannelIds.has(observation.channelId)) current.email.add(observation.channelId);
      sets.set(query, current);
    }
  }
  return Object.fromEntries([...sets.entries()].map(([query, value]) => [query, {
    observedChannelIds: [...value.observed].sort(),
    eligibleChannelIds: [...value.eligible].sort(),
    promotedChannelIds: [...value.promoted].sort(),
    emailResolvedChannelIds: [...value.email].sort(),
  }]));
}

export function mergeQueryPromotionChannelSets(
  prior: Record<string, QueryPromotionChannelSets>,
  next: Record<string, QueryPromotionChannelSets>,
): Record<string, QueryPromotionChannelSets> {
  const merged: Record<string, QueryPromotionChannelSets> = {};
  for (const query of Array.from(new Set([...Object.keys(prior), ...Object.keys(next)])).sort().slice(0, RECEIPT_QUERY_CAP)) {
    const left = prior[query];
    const right = next[query];
    merged[query] = {
      observedChannelIds: [...new Set([...(left?.observedChannelIds ?? []), ...(right?.observedChannelIds ?? [])])]
        .sort().slice(0, RECEIPT_QUERY_CHANNEL_SET_CAP),
      eligibleChannelIds: [...new Set([...(left?.eligibleChannelIds ?? []), ...(right?.eligibleChannelIds ?? [])])]
        .sort().slice(0, RECEIPT_QUERY_CHANNEL_SET_CAP),
      promotedChannelIds: [...new Set([...(left?.promotedChannelIds ?? []), ...(right?.promotedChannelIds ?? [])])]
        .sort().slice(0, RECEIPT_QUERY_CHANNEL_SET_CAP),
      emailResolvedChannelIds: [...new Set([...(left?.emailResolvedChannelIds ?? []), ...(right?.emailResolvedChannelIds ?? [])])]
        .sort().slice(0, RECEIPT_QUERY_CHANNEL_SET_CAP),
    };
  }
  return merged;
}

export function metricsFromQueryPromotionChannelSets(
  sets: Record<string, QueryPromotionChannelSets>,
): QueryPromotionMetric[] {
  return Object.entries(sets).sort(([left], [right]) => left.localeCompare(right)).map(([query, value]) => ({
    query,
    observedUnique: value.observedChannelIds.length,
    eligibleUnique: value.eligibleChannelIds.length,
    promotedCandidates: value.promotedChannelIds.length,
    emailResolved: value.emailResolvedChannelIds.length,
  }));
}

export function seoulDayKey(nowMs = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

/** 완료 receipt가 앞에 누적돼도 sweep 처리 예산은 실제 claim 성공 건에만 쓴다. */
export async function claimRunsWithinBudget<T, C>(input: {
  runs: readonly T[];
  budget: number;
  claim(run: T): Promise<C | null>;
}): Promise<C[]> {
  const limit = Math.max(0, Math.trunc(input.budget));
  const claims: C[] = [];
  for (const run of input.runs) {
    if (claims.length >= limit) break;
    const claim = await input.claim(run);
    if (claim !== null) claims.push(claim);
  }
  return claims;
}
