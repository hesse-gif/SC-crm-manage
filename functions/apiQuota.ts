// API 쿼터/사용량 집계 — YouTube Data API 유닛(자체 계측) + 메일 발송 쿼터(mailSafetyStatus 재사용).
// super_admin 전용 콘솔(/admin/llm)에서 오늘 소진량을 캡 대비 확인한다.
// (infly 슈퍼어드민 쿼터 뷰의 flu 이식 — AI Hub/LLM은 이미 /admin/llm 사용량에 있으므로 제외.)
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { readMailSafetyStatus } from "./mailSafetyStatus";
import { asRecord, assertNonGuestAuth, makeBehaviorLog, type CallableRequestShape } from "./shared";
import {
  assertStagingYoutubeLiveEgressAllowed,
  isStagingSafetyRuntime,
  STAGING_YOUTUBE_DAILY_UNIT_CAP,
  type StagingSafetySource,
} from "./stagingSafety";

// W9-2 [공식 모델 정정 — 값은 건드리지 않는다]: 아래 표는 **우리 내부 예산 모델**이지 공식 단가표가
// 아니다. 공식 현행(https://developers.google.com/youtube/v3/getting-started, 2026-08-03 확인)은
//   "Projects that enable the YouTube Data API have a default quota allocation of 100 search.list
//    calls, 100 videos.insert calls, and 10,000 units per day combined for all other endpoints."
// 이고 같은 문서가 "A search query costs 1 unit" 이라고 못박는다. 즉 search.list 는 100유닛이
// 아니라 **1유닛 + 별도 콜 버킷(100콜/일/프로젝트)** 이고, 10,000유닛/일은 그 밖의 엔드포인트
// 몫이다. 그럼에도 search:100 을 그대로 두는 이유는 판정 로직 동결이다 — 이 값은 발굴이 검색을
// 남발하지 못하게 막는 보수적 내부 가중치로 계속 쓰이고, 실제 버킷 소진은 아래 v2 섀도 계측
// (youtubeQuotaBucket·youtubeV2UnitCost, R28-3)이 별도로 기록한다. 모델 교체는 별도 릴리스 결정.
// 미지의 operation 은 보수적으로 1.
const YOUTUBE_UNIT_COST: Record<string, number> = {
  search: 100,
  videos: 1,
  channels: 1,
  playlistItems: 1,
  commentThreads: 1,
  comments: 1,
  activities: 1,
  captions: 50,
};
// 아래 캡은 공식 값이 아니라 내부 가드 기준선이다(공식 10,000유닛/일은 **프로젝트** 단위·비검색 합산).
const DEFAULT_YOUTUBE_DAILY_CAP = 10_000;

/**
 * R21-2 [사용자 하드 제약]: "조회수 쿼터는 가장 중요한 쿼터라 메인 키에 항상 룸을 남겨두긴하자."
 * 조회수 추적(videoViewSnapshots)은 CPM 정산 근거(eligibleViews)라, 발굴이 쿼터를 다 털면 정산
 * 측정이 죽는다. 주 키(슬롯 0)에 추적용 예약분을 남기고 **발굴은 그 아래로 내려가지 못한다.**
 *
 * 예약분 산정(실측):
 *  · 크론 5분 주기(every 5 minutes) = 288회/일 (functions/index.ts processVideoViewSnapshotQueueSchedule)
 *  · 배치 `VIDEO_STAT_BATCH_SIZE = 50` → 실행당 ⌈due/50⌉ 콜, `videos.list` = 1유닛/콜
 *  · 현재 실사용: 288 × 1~2콜 ≈ 300~600유닛/일 (index.ts 주석의 실측치와 일치)
 *  · 여유: due 가 350건까지 늘어도(7콜/실행) 288 × 7 = 2,016유닛 → 2,000 으로 잡는다
 *    (일일 캡 10,000 의 20%). 승인 영상이 늘면 이 값을 올려야 하고, 남는 8,000 은 발굴이 쓴다.
 * 추적 자체는 예약분과 무관하게 계속 주 키를 쓸 수 있다 — 막는 것은 **발굴만**이다.
 */
export const YOUTUBE_TRACKING_RESERVED_UNITS = 2_000;

/**
 * R22-3: **키당** 일일 유닛 캡. integrations/default.externalApi.quotaDaily 와 섞으면 안 된다 —
 * 그 필드는 readApiQuotaStatus 가 **전 키 합산 캡**으로 쓰고 /admin/integrations 에서 운영자가 편집할
 * 수 있다. 40,000 같은 합산값이 키당 캡으로 새면 예약분·잔여 추정이 통째로 무력화된다(리뷰어 실측:
 * 현재 운영값 미설정이라 우연히 정합했을 뿐). 키당 캡은 공식 기본값 상수로 고정하고 편집 경로를 끊는다.
 *
 * W9-2 정정: 공식 쿼터는 **프로젝트 단위**이고(위 getting-started 인용, 2026-08-03 확인) "키당"
 * 이라는 단위는 공식 계약에 없다. 이 상수는 여러 키를 additive capacity 로 쓰는 현행 운영 전제
 * 위에서 주 키 예약분을 지키기 위한 **내부 가드**다 — 공식 상한의 재진술이 아니다. 멀티키 동작
 * 자체는 사용자·시몬 결정 사항으로 분리돼 있어 여기서 바꾸지 않는다.
 */
export const YOUTUBE_PER_KEY_DAILY_UNIT_CAP = 10_000;

/** 어떤 경로로 값이 들어와도 키당 캡은 공식 상한을 넘지 못한다(넘으면 예약분이 무의미해진다). */
export function youtubePerKeyDailyCap(configured?: number): number {
  const raw = Number.isFinite(configured) ? Math.round(configured as number) : YOUTUBE_PER_KEY_DAILY_UNIT_CAP;
  return Math.max(1, Math.min(YOUTUBE_PER_KEY_DAILY_UNIT_CAP, raw));
}
/** 발굴이 주 키를 쓸 수 있는지 판정을 이 시간만 캐시한다(호출마다 Firestore 읽기를 만들지 않는다). */
const PRIMARY_GUARD_CACHE_MS = 60_000;

export function youtubeUnitCost(operation: string): number {
  return YOUTUBE_UNIT_COST[operation] ?? 1;
}

// URL(…/youtube/v3/<operation>) 또는 bare path에서 operation 이름만 뽑는다.
export function youtubeOperationFromUrl(url: URL | string): string {
  const pathname = typeof url === "string" ? url : url.pathname;
  return pathname.split("?")[0].split("/").filter(Boolean).pop() ?? "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

// Asia/Seoul 달력일(YouTube 쿼터 리셋은 PT이지만, 운영 가시성은 메일 카운터와 동일하게 KST 일자로 묶는다).
export function seoulDayKey(now = new Date()): string {
  return calendarDayKey("Asia/Seoul", now);
}

function calendarDayKey(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function youtubeQuotaDayKey(now = new Date()): string {
  return calendarDayKey("America/Los_Angeles", now);
}

type StagingYoutubeQuotaSnapshot = {
  exists: boolean;
  data(): unknown;
};

type StagingYoutubeQuotaTransaction = {
  get(reference: unknown): Promise<StagingYoutubeQuotaSnapshot>;
  set(
    reference: unknown,
    data: Record<string, unknown>,
    options: { merge: boolean },
  ): void;
};

export type StagingYoutubeQuotaDb = {
  collection(name: string): { doc(id: string): unknown };
  runTransaction<T>(
    update: (transaction: StagingYoutubeQuotaTransaction) => Promise<T>,
  ): Promise<T>;
};

export type StagingYoutubeQuotaReservation = {
  readonly reserved: boolean;
  readonly operation: string;
  readonly units: number;
  readonly reservedUnits: number;
  readonly dailyCap: number;
  readonly dayKey?: string;
};

function resourceExhausted(message: string): Error {
  return Object.assign(new Error(message), { code: "resource-exhausted", errorCode: "resource_exhausted_unauthorized" });
}

function invalidStagingYoutubeBudget(message: string): Error {
  return Object.assign(new Error(`Invalid staging YouTube budget state: ${message}`), {
    code: "failed-precondition", errorCode: "invalid_staging_youtube_budget_invalid_staging_you_tube_budget",
  });
}

function exactStoredCount(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw invalidStagingYoutubeBudget(`${field} must be a non-negative integer.`);
  }
  return value as number;
}

function readStagingYoutubeBudgetState(
  value: unknown,
  dayKey: string,
): { reservedUnits: number; calls: number; byOperation: Record<string, unknown> } {
  const record = asRecord(value);
  if (
    record.provider !== "youtube" ||
    record.lane !== "staging-live-e2e" ||
    record.dayKey !== dayKey ||
    record.dailyCap !== STAGING_YOUTUBE_DAILY_UNIT_CAP
  ) {
    throw invalidStagingYoutubeBudget("identity, day, or hard-cap metadata drifted.");
  }
  if (!record.byOperation || typeof record.byOperation !== "object" || Array.isArray(record.byOperation)) {
    throw invalidStagingYoutubeBudget("byOperation must be an object.");
  }
  return {
    reservedUnits: exactStoredCount(record, "reservedUnits"),
    calls: exactStoredCount(record, "calls"),
    byOperation: asRecord(record.byOperation),
  };
}

export function nextStagingYoutubeReservedUnits(
  currentUnits: number,
  operation: string,
  dailyCap = STAGING_YOUTUBE_DAILY_UNIT_CAP,
): number {
  const safeCurrent = numberValue(currentUnits);
  const units = youtubeUnitCost(operation);
  const next = safeCurrent + units;
  if (next > dailyCap) {
    throw resourceExhausted(
      `Staging YouTube daily hard cap exceeded (${safeCurrent}+${units}>${dailyCap} units).`,
    );
  }
  return next;
}

export async function reserveStagingYoutubeApiUnitsWithDb(
  db: StagingYoutubeQuotaDb,
  operation: string,
  now = new Date(),
  source: StagingSafetySource = process.env,
): Promise<StagingYoutubeQuotaReservation> {
  if (!isStagingSafetyRuntime(source)) {
    return {
      reserved: false,
      operation,
      units: youtubeUnitCost(operation),
      reservedUnits: 0,
      dailyCap: STAGING_YOUTUBE_DAILY_UNIT_CAP,
    };
  }

  assertStagingYoutubeLiveEgressAllowed(source);
  const dayKey = youtubeQuotaDayKey(now);
  const reference = db.collection("staging_api_budgets").doc(`youtube_${dayKey}`);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const previous = snapshot.exists
      ? readStagingYoutubeBudgetState(snapshot.data(), dayKey)
      : { reservedUnits: 0, calls: 0, byOperation: {} };
    const reservedUnits = nextStagingYoutubeReservedUnits(
      previous.reservedUnits,
      operation,
    );
    const calls = previous.calls + 1;
    const previousByOperation = previous.byOperation;
    const byOperation = {
      ...previousByOperation,
      [operation]: numberValue(previousByOperation[operation]) + youtubeUnitCost(operation),
    };

    transaction.set(reference, {
      provider: "youtube",
      lane: "staging-live-e2e",
      dayKey,
      dailyCap: STAGING_YOUTUBE_DAILY_UNIT_CAP,
      reservedUnits,
      calls,
      byOperation,
      updatedAtIso: now.toISOString(),
    }, { merge: true });

    return {
      reserved: true,
      operation,
      units: youtubeUnitCost(operation),
      reservedUnits,
      dailyCap: STAGING_YOUTUBE_DAILY_UNIT_CAP,
      dayKey,
    };
  });
}

export async function reserveStagingYoutubeApiUnits(
  operation: string,
): Promise<StagingYoutubeQuotaReservation> {
  return reserveStagingYoutubeApiUnitsWithDb(
    adminDb as unknown as StagingYoutubeQuotaDb,
    operation,
  );
}

/**
 * Flu/Task-49 — YouTube quota **pool** axis. "growth" is the pre-existing implicit single pool
 * (YOUTUBE_API_KEY + FALLBACK_1~3, the 4-project rotation this file already tracked before this
 * ticket). Every doc-id helper and ledger primitive below takes an optional trailing `poolId`
 * that defaults to this constant, so a caller that never passes it (every call site in this repo
 * as of this ticket) keeps writing the exact same doc ids/fields as before — zero regression
 * (completion condition: growth doc ids + exhaustion order byte-identical). A non-growth poolId
 * gets its own doc id (`youtube_pool_<poolId>_...`) so a new org's pool can never read or
 * decrement growth's ledger.
 */
export const YOUTUBE_GROWTH_POOL_ID = "growth";

export function youtubeUsageDocId(dayKey: string, poolId: string = YOUTUBE_GROWTH_POOL_ID): string {
  return poolId === YOUTUBE_GROWTH_POOL_ID ? `youtube_${dayKey}` : `youtube_pool_${poolId}_${dayKey}`;
}

/**
 * R22-1 [BLOCKER 수리]: 슬롯별 계측은 **PT 일자** 문서에 쌓는다. 예약분·잔여 판정의 기준일이 실제
 * 쿼터 리셋(PT 자정 = 16:00 KST)과 어긋나면 두 방향으로 다 틀린다 —
 *  · 00:00~16:00 KST: KST 문서가 이미 0 이라 계측이 리셋된 것처럼 보여 **예약분이 무효**가 된다.
 *  · 16:00~24:00 KST: PT 로는 리셋됐는데 KST 오전 소진량을 들고 있어 멀쩡한 쿼터로 **발굴을 동결**한다.
 * 운영 가시성용 KST 집계 문서(readApiQuotaStatus)는 그대로 두고 슬롯 계측만 분리한다(같은 컬렉션 =
 * 새 컬렉션 0).
 */
export function youtubeSlotUsageDocId(now = new Date(), poolId: string = YOUTUBE_GROWTH_POOL_ID): string {
  return poolId === YOUTUBE_GROWTH_POOL_ID
    ? `youtube_pt_${youtubeQuotaDayKey(now)}`
    : `youtube_pool_${poolId}_pt_${youtubeQuotaDayKey(now)}`;
}

// 호출당 유닛을 오늘 카운터에 누적한다. 실사용 계측은 조회/발송 경로를 절대 막으면 안 되므로
// fire-and-forget + 모든 에러 흡수(계측 실패가 실제 API 호출을 깨뜨리지 않는다).
export async function recordYoutubeApiUnits(
  operation: string,
  calls = 1,
  slotIndex?: number,
  poolId: string = YOUTUBE_GROWTH_POOL_ID,
): Promise<void> {
  try {
    const safeCalls = Math.max(1, Math.round(Number.isFinite(calls) ? calls : 1));
    const units = youtubeUnitCost(operation) * safeCalls;
    const dayKey = seoulDayKey();
    // R21-2: 쿼터는 **키마다 따로** 10,000 인데 계측은 전 키를 하나로 합산하고 있었다 — 그 상태로는
    // "주 키에 룸이 남았나" 를 답할 수 없다. 같은 문서에 슬롯별 필드를 붙인다(새 컬렉션 금지).
    // ⚠️ 슬롯 **인덱스**만 남긴다 — 키 원문·지문 금지(SEC-P0-009).
    const slotKey = Number.isInteger(slotIndex) && (slotIndex as number) >= 0 ? String(slotIndex) : null;
    await adminDb.collection("api_usage").doc(youtubeUsageDocId(dayKey, poolId)).set({
      provider: "youtube",
      dayKey,
      // growth 문서는 poolId 필드를 절대 얻지 않는다 — 기존 필드 구성 바이트 동일(회귀 0).
      ...(poolId !== YOUTUBE_GROWTH_POOL_ID ? { poolId } : {}),
      units: FieldValue.increment(units),
      calls: FieldValue.increment(safeCalls),
      // 중첩 객체 + merge:true 는 byOperation.<op> 를 딥머지 증가시킨다. (dotted key를 set에 쓰면
      // Firestore가 "byOperation.op" 리터럴 필드로 오인하므로 반드시 중첩 객체로 준다.)
      byOperation: { [operation]: FieldValue.increment(units) },
      updatedAtIso: new Date().toISOString(),
    }, { merge: true });
    // R22-1: 슬롯 계측은 PT 일자 문서에 따로 쌓는다(리셋 경계 일치).
    if (slotKey) {
      await adminDb.collection("api_usage").doc(youtubeSlotUsageDocId(undefined, poolId)).set({
        provider: "youtube",
        quotaDayKey: youtubeQuotaDayKey(),
        ...(poolId !== YOUTUBE_GROWTH_POOL_ID ? { poolId } : {}),
        bySlot: { [slotKey]: FieldValue.increment(units) },
        updatedAtIso: new Date().toISOString(),
      }, { merge: true });
    }
  } catch {
    // 계측 실패는 무시 — 실제 API 호출/발송 경로는 불변.
  }
}

/**
 * R28-3 (P0-A): 쿼터 v2 **섀도 계측** — 행동 불변이 계약이다.
 *
 * 감사 확정 사실: 공식 현행 모델은 search.list 가 **1유닛 + 별도 searchQueries 버킷(100콜/일/프로젝트)**
 * 이고, 그 외 호출은 10,000유닛/일/프로젝트 풀을 쓴다.
 * W9-2 근거 재확인(2026-08-03): https://developers.google.com/youtube/v3/getting-started 의
 * "default quota allocation of 100 search.list calls, 100 videos.insert calls, and 10,000 units
 * per day combined for all other endpoints" + "A search query costs 1 unit". 버킷 분리는 공식
 * 계약이 맞으므로 이 lane 은 REJECT 가 아니다. 다만 분리 계측 자체는 R28-3 에서 이미 구현·테스트
 * 되어 있어(ALREADY_FIXED) W9-2 는 사실 정정 주석만 남긴다. 우리 코드 모델(search=100유닛·키당 10k)은
 * 그대로 두고(판정 로직 무변경 — youtubeDiscoveryQuotaBudget·discoveryMayUsePrimaryYoutubeKey 는
 * 이 함수들을 읽지 않는다), 실제 소진을 두 모델로 **병행 기록**해 콘솔 실측(A9/A10)과 대조할 근거를
 * 남긴다. 모델 교체는 그 대조가 끝난 뒤 별도 릴리스의 결정이다.
 */
export function youtubeQuotaBucket(operation: string): "searchQueries" | "otherUnits" {
  return operation === "search" ? "searchQueries" : "otherUnits";
}

/** v2 모델의 호출당 유닛 — search 만 1(별도 콜 버킷으로 따로 센다), 나머지는 기존 표 그대로. */
export function youtubeV2UnitCost(operation: string): number {
  return operation === "search" ? 1 : youtubeUnitCost(operation);
}

/** Firestore 맵 키로 안전한 사유 토큰만 남긴다(키 원문·PII 유입 차단, SEC-P0-009). */
function safeErrorReasonKey(errorReason?: string, httpStatus?: number): string {
  const normalized = (errorReason ?? "").trim().replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 40);
  if (normalized) return normalized;
  return Number.isInteger(httpStatus) ? `http_${httpStatus}` : "unknown";
}

export type YoutubeApiAttemptOutcome = "attempted" | "success" | "failure";

/**
 * R28-3: 호출 **시도**를 선기록하고, 성공/실패로 완결한다. 현행 recordYoutubeApiUnits 는 성공만
 * 기록하고 실패 사유를 폐기해 "쿼터가 실제로 어디서 타는지"를 사후에 알 수 없었다(403 quotaExceeded
 * 로 태운 콜은 계측에 흔적이 없다). 기존 PT 일자 문서(api_usage/youtube_pt_<PT일자>)에 v2 필드만
 * 붙인다 — 새 컬렉션 0, 기존 필드(bySlot·units·calls·byOperation) 무접촉.
 * ⚠️ 슬롯 **인덱스**만 남긴다 — 키 원문·지문 금지(SEC-P0-009).
 * 계측 실패는 절대 실제 API 경로를 깨뜨리지 않는다(fire-and-forget + 전 에러 흡수).
 */
export async function recordYoutubeApiAttempt(input: {
  operation: string;
  slotIndex?: number;
  outcome: YoutubeApiAttemptOutcome;
  httpStatus?: number;
  errorReason?: string;
  /**
   * W59c-M3: 이 실패가 **403 일일 소진**임을 호출부가 판정해 넘긴다(429·rateLimitExceeded 제외).
   * errorReason 을 재활용하지 않는 이유: byErrorReason 원장은 기존 계약(quotaExceeded 키)이 있고
   * 그 키를 쪼개면 기존 모니터·테스트의 집계 축이 조용히 갈라진다. 래치 축만 따로 세운다.
   */
  searchDailyExhausted?: boolean;
  /** Flu/Task-49: defaults to the growth pool — see YOUTUBE_GROWTH_POOL_ID doc comment. */
  poolId?: string;
}): Promise<void> {
  try {
    const poolId = input.poolId ?? YOUTUBE_GROWTH_POOL_ID;
    const bucket = youtubeQuotaBucket(input.operation);
    const units = youtubeV2UnitCost(input.operation);
    const slotKey = Number.isInteger(input.slotIndex) && (input.slotIndex as number) >= 0 ? String(input.slotIndex) : null;
    const v2: Record<string, unknown> = { updatedAtIso: new Date().toISOString() };
    if (input.outcome === "attempted") {
      v2.byBucket = bucket === "searchQueries"
        ? { searchQueries: { attemptedCalls: FieldValue.increment(1) } }
        : { otherUnits: { attemptedUnits: FieldValue.increment(units) } };
      // 시도 기준 슬롯 분포(콜 수) — 실패까지 포함해야 "어느 키가 태웠나"를 답할 수 있다.
      if (slotKey) v2.bySlotAttempted = { [slotKey]: FieldValue.increment(1) };
    } else if (input.outcome === "success") {
      v2.byBucket = bucket === "searchQueries"
        ? { searchQueries: { successfulCalls: FieldValue.increment(1) } }
        : { otherUnits: { successfulUnits: FieldValue.increment(units) } };
      // W59-6: byBucket 은 **전 슬롯 합산**이라 "어느 프로젝트의 100 이 남았나"를 답하지 못한다.
      // Search Queries 는 프로젝트(=키 슬롯)마다 별개 버킷이므로 슬롯 축을 따로 남긴다 — 이 필드가
      // 다음 pass 의 슬롯 회전 원장(youtubeSearchSlotBudgets)의 정본이다.
      if (slotKey && bucket === "searchQueries") {
        v2.bySlotSearchCalls = { [slotKey]: FieldValue.increment(1) };
      }
    } else {
      v2.byErrorReason = { [safeErrorReasonKey(input.errorReason, input.httpStatus)]: FieldValue.increment(1) };
      // W59-6 관측: 슬롯별 429/403 소진. 어느 프로젝트 버킷이 먼저 마르는지가 회전이 도는지의 증거다.
      // ⚠️ 이 필드는 **래치 근거가 아니다** — youtubeQuotaLimited 계열(429·rateLimitExceeded 포함)이
      // 전부 quotaExceeded 로 접혀 들어오므로 "오늘 하루 닫는다"의 판정에는 쓸 수 없다.
      if (slotKey && bucket === "searchQueries" && input.errorReason === "quotaExceeded") {
        v2.bySlotSearchQuotaBlocked = { [slotKey]: FieldValue.increment(1) };
      }
      // W59c-M3 [독립 리뷰 · MAJOR]: **403 일일 소진 전용** durable 필드. 호출부가
      // youtubeSearchDailyQuotaExhausted(403 quotaExceeded/dailyLimitExceeded)로 판정했을 때만 선다.
      // 프로세스 Map 래치는 인스턴스가 죽으면 사라지므로, 다음 인스턴스가 같은 마른 슬롯을 다시
      // 고르지 않으려면 이 축이 durable 이어야 한다(refreshSearchBucketLedger 가 읽어 래치한다).
      if (slotKey && bucket === "searchQueries" && input.searchDailyExhausted === true) {
        v2.bySlotSearchDailyExhausted = { [slotKey]: FieldValue.increment(1) };
      }
    }
    await adminDb.collection("api_usage").doc(youtubeSlotUsageDocId(undefined, poolId)).set({
      provider: "youtube",
      quotaDayKey: youtubeQuotaDayKey(),
      ...(poolId !== YOUTUBE_GROWTH_POOL_ID ? { poolId } : {}),
      v2,
    }, { merge: true });
  } catch {
    // 계측 실패는 무시 — 실제 API 호출 경로는 불변.
  }
}

let primaryGuardCache: { atMs: number; allowed: boolean } | null = null;

/** 테스트·스윕 경계에서 캐시를 비운다(캐시 때문에 가드가 한 박자 늦게 걸리면 예약분이 침범된다). */
export function resetYoutubePrimaryGuardCache(): void {
  primaryGuardCache = null;
}

/** 슬롯별 오늘 소진 유닛. 계측이 없으면 0(=아직 안 씀)으로 본다. */
export async function youtubeSlotUnitsUsed(
  slotIndex: number,
  now = new Date(),
  poolId: string = YOUTUBE_GROWTH_POOL_ID,
): Promise<number> {
  const snapshot = await adminDb.collection("api_usage").doc(youtubeSlotUsageDocId(now, poolId)).get();
  return numberValue(asRecord(asRecord(snapshot.data()).bySlot)[String(slotIndex)]);
}

/**
 * R21-2: 발굴이 주 키(슬롯 0)를 쓸 수 있는가. 주 키 잔여가 추적 예약분에 닿으면 false.
 * ⚠️ fail-closed: 계측을 읽을 수 없으면 **발굴을 막는다**(모르면 정산 쿼터를 지키는 쪽으로).
 */
export async function discoveryMayUsePrimaryYoutubeKey(now = new Date()): Promise<boolean> {
  const cached = primaryGuardCache;
  if (cached && now.getTime() - cached.atMs < PRIMARY_GUARD_CACHE_MS) return cached.allowed;
  try {
    // R22-3: 키당 캡은 운영자 편집 필드가 아니라 전용 상수다.
    const cap = youtubePerKeyDailyCap();
    const used = await youtubeSlotUnitsUsed(0, now);
    const allowed = cap - used > YOUTUBE_TRACKING_RESERVED_UNITS;
    primaryGuardCache = { atMs: now.getTime(), allowed };
    return allowed;
  } catch {
    primaryGuardCache = { atMs: now.getTime(), allowed: false };
    return false;
  }
}

/**
 * W59-6 [헤세 최우선 — 4-프로젝트 쿼터 활용]
 *
 * 확정 사실(리더 2026-08-09, 헤세 확인): 등록된 YouTube 키 4개(YOUTUBE_API_KEY + FALLBACK_1~3)는
 * **서로 다른 4개 GCP 프로젝트** 소속이다. 공식 모델에서 Search Queries 버킷은
 * **100콜/일/프로젝트**이므로, 이 배치의 실제 검색 천장은 100 이 아니라 **슬롯마다 100** = 400콜/일이다.
 * 종전 코드에는 이 버킷을 슬롯 축으로 세는 원장이 없었다 — v2 섀도 계측(R28-3)의 byBucket.searchQueries
 * 는 **전 슬롯 합산**이라 "어느 프로젝트의 100 이 남았나"를 답하지 못했다. 그래서 검색은 슬롯 1 을
 * 계속 때리다 구글이 403 quotaExceeded 를 줄 때에만 다음 키로 넘어갔고, 그 실패 응답 자체가
 * pass 예산을 먹었다.
 *
 * 이 원장은 그 축을 슬롯별로 쪼갠다(같은 PT 일자 문서, 새 컬렉션 0).
 *  · 정본은 Firestore(교차 인스턴스 합산), 프로세스 로컬 증가분과 **max** 로 합친다 —
 *    fire-and-forget 쓰기가 아직 안 닿았을 때 로컬이 앞서고, 다른 인스턴스가 태웠으면 Firestore 가 앞선다.
 *  · 구글이 실제로 429/403 quotaExceeded 를 주면 그 슬롯은 **즉시** 소진으로 못박는다(그게 정본 신호다).
 *  · 읽기 실패는 **fail-open** 이다. 여기서 fail-closed 로 가면 계측 장애가 검색 레인 전면 정지가 된다 —
 *    종전에는 이 게이트 자체가 없었으므로 fail-open 이 곧 종전 동작이고, 초과분은 구글이 403 으로
 *    돌려보내며 그 경로는 이미 R21-4 인계로 처리된다. 주 키의 정산 예약분(R21-2, 유닛 축)은 이
 *    원장과 무관하게 그대로 fail-closed 다.
 */
export const YOUTUBE_SEARCH_QUERIES_DAILY_CAP_PER_SLOT = 100;

/** 슬롯 원장 재적재 주기 — 주 키 가드(PRIMARY_GUARD_CACHE_MS)와 같은 이유·같은 값이다. */
const SEARCH_BUCKET_CACHE_MS = 60_000;

type SearchBucketLedger = {
  quotaDayKey: string;
  loadedAtMs: number;
  used: Map<number, number>;
};

let searchBucketLedger: SearchBucketLedger | null = null;

/** 테스트·pass 경계에서 원장을 비운다(슬롯 상태가 남으면 다음 측정이 오염된다). */
export function resetYoutubeSearchBucketLedger(): void {
  searchBucketLedger = null;
}

function activeSearchBucketLedger(now: Date): SearchBucketLedger {
  const quotaDayKey = youtubeQuotaDayKey(now);
  // PT 자정을 넘으면 버킷도 리셋된다 — 어제 소진분을 오늘 천장으로 들고 가면 검색이 하루 더 멎는다.
  if (!searchBucketLedger || searchBucketLedger.quotaDayKey !== quotaDayKey) {
    searchBucketLedger = { quotaDayKey, loadedAtMs: 0, used: new Map() };
  }
  return searchBucketLedger;
}

/** 성공한 search 콜 1건을 슬롯 버킷에서 즉시 차감한다(Firestore 쓰기가 닿기 전에도 정확하도록). */
export function noteYoutubeSearchCallConsumed(slotIndex: number, now = new Date()): void {
  if (!Number.isInteger(slotIndex) || slotIndex < 0) return;
  const ledger = activeSearchBucketLedger(now);
  ledger.used.set(slotIndex, (ledger.used.get(slotIndex) ?? 0) + 1);
}

/** 구글이 그 슬롯의 Search Queries 버킷 소진을 알려 왔다 — 남은 판정과 무관하게 오늘은 닫는다. */
export function noteYoutubeSearchSlotQuotaBlocked(slotIndex: number, now = new Date()): void {
  if (!Number.isInteger(slotIndex) || slotIndex < 0) return;
  const ledger = activeSearchBucketLedger(now);
  ledger.used.set(slotIndex, YOUTUBE_SEARCH_QUERIES_DAILY_CAP_PER_SLOT);
}

/**
 * 슬롯별 오늘(PT) search 원장. 두 축을 함께 돌려준다.
 *  · calls          — 성공한 search 콜 수(버킷 소모량)
 *  · dailyExhausted — **403 일일 소진** 관측 수(W59c-M3). 429 는 절대 섞이지 않는다.
 * 계측이 없으면 0(=아직 안 씀).
 */
export async function youtubeSearchSlotLedger(now = new Date()): Promise<{
  calls: Record<string, number>;
  dailyExhausted: Record<string, number>;
}> {
  const snapshot = await adminDb.collection("api_usage").doc(youtubeSlotUsageDocId(now)).get();
  const v2 = asRecord(asRecord(snapshot.data()).v2);
  const readCounters = (value: unknown): Record<string, number> => {
    const stored = asRecord(value);
    const result: Record<string, number> = {};
    for (const [slotKey, raw] of Object.entries(stored)) result[slotKey] = numberValue(raw);
    return result;
  };
  return {
    calls: readCounters(v2.bySlotSearchCalls),
    dailyExhausted: readCounters(v2.bySlotSearchDailyExhausted),
  };
}

/** 슬롯별 오늘(PT) 성공 search 콜 수. 계측이 없으면 0(=아직 안 씀). */
export async function youtubeSearchSlotCallsUsed(now = new Date()): Promise<Record<string, number>> {
  return (await youtubeSearchSlotLedger(now)).calls;
}

async function refreshSearchBucketLedger(ledger: SearchBucketLedger, now: Date): Promise<void> {
  if (now.getTime() - ledger.loadedAtMs < SEARCH_BUCKET_CACHE_MS) return;
  try {
    const stored = await youtubeSearchSlotLedger(now);
    for (const [slotKey, storedCalls] of Object.entries(stored.calls)) {
      const slot = Number(slotKey);
      if (!Number.isInteger(slot) || slot < 0) continue;
      // 로컬이 앞설 수도(쓰기 지연) 다른 인스턴스가 앞설 수도(교차 합산) 있으므로 큰 쪽을 믿는다.
      ledger.used.set(slot, Math.max(ledger.used.get(slot) ?? 0, storedCalls));
    }
    // W59c-M3 [독립 리뷰 · MAJOR]: durable 래치. 프로세스 Map 래치만으로는 인스턴스가 죽는 순간
    // 사라져 다음 인스턴스가 같은 마른 슬롯을 다시 고른다(W59-6 이 없애려던 403 낭비의 재발).
    // 구글이 **403 일일 소진**을 준 슬롯은 오늘(PT) 내내 닫는다 — 콜 수 추정과 무관하게 확정 사실이다.
    for (const [slotKey, exhaustedCount] of Object.entries(stored.dailyExhausted)) {
      const slot = Number(slotKey);
      if (!Number.isInteger(slot) || slot < 0 || exhaustedCount <= 0) continue;
      ledger.used.set(slot, YOUTUBE_SEARCH_QUERIES_DAILY_CAP_PER_SLOT);
    }
    ledger.loadedAtMs = now.getTime();
  } catch {
    // fail-open: 읽지 못하면 거르지 않는다(종전 동작). 초과분은 구글 403 → R21-4 인계가 받는다.
    ledger.loadedAtMs = now.getTime();
  }
}

export type YoutubeSearchSlotBudget = {
  readonly slot: number;
  readonly usedCalls: number;
  readonly remainingCalls: number;
};

/**
 * W59-6: 주어진 슬롯들의 Search Queries 잔여를 슬롯별로 돌려준다(호출부 순서 보존).
 * 순서를 재정렬하지 않는 것이 계약이다 — 레인 순서(폴백 우선, 주 키 최후)는 R21-2 사용자 제약이라
 * 이 버킷 판정이 뒤집으면 안 된다. 여기서는 **거르기만** 한다.
 */
export async function youtubeSearchSlotBudgets(
  slots: readonly number[],
  now = new Date(),
): Promise<YoutubeSearchSlotBudget[]> {
  const ledger = activeSearchBucketLedger(now);
  await refreshSearchBucketLedger(ledger, now);
  return slots.map((slot) => {
    const usedCalls = Math.max(0, ledger.used.get(slot) ?? 0);
    return {
      slot,
      usedCalls,
      remainingCalls: Math.max(0, YOUTUBE_SEARCH_QUERIES_DAILY_CAP_PER_SLOT - usedCalls),
    };
  });
}

/**
 * R21-3: search.list 는 **페이지당 100유닛**이고 페이지당 최대 50건이다(공식 표 + 리더 실측:
 * 키워드당 20페이지=1,000건=2,000유닛). 잔여 유닛에서 뽑을 수 있는 결과 수를 역산하는 데 쓴다.
 */
export const YOUTUBE_SEARCH_UNITS_PER_PAGE = 100;
export const YOUTUBE_SEARCH_PAGE_SIZE = 50;

/**
 * 다음 쿼터 리셋 시각. 근거: YouTube Data API 일일 쿼터는 **태평양시(PT) 자정**에 리셋된다 —
 * 이 파일의 youtubeQuotaDayKey() 가 America/Los_Angeles 달력일을 쓰는 이유가 그것이다(계측 집계는
 * 운영 가시성 때문에 KST 일자를 쓰지만, **리셋 판단은 PT** 여야 한다).
 * DST 경계에서 ±1시간 오차가 날 수 있다 — 대기 재개 판단에는 무해하다(다음 tick 이 다시 본다).
 */
export function youtubeQuotaNextResetIso(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour12: false,
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const secondsSinceLocalMidnight = (get("hour") % 24) * 3_600 + get("minute") * 60 + get("second");
  return new Date(now.getTime() + (86_400 - secondsSinceLocalMidnight) * 1_000).toISOString();
}

export type YoutubeDiscoveryQuotaBudget = {
  /** 발굴이 지금 쓸 수 있는 유닛 추정(폴백 키 잔여 + 예약분 위 주 키 잔여). */
  readonly remainingUnits: number;
  /** 발굴 몫이 남지 않았다 = 다음 리셋까지 대기해야 한다. */
  readonly exhausted: boolean;
  readonly nextResetIso: string;
  /** 잔여로 감당할 수 있는 최대 결과 수(동적 잡 크기 상한). */
  readonly maxResultLimit: number;
};

/**
 * R21-3: 잔여 쿼터 추정. 쿼터는 **키마다 따로** 이므로 슬롯별 계측(bySlot)에서 각 키의 잔여를 더한다.
 * 등록되지 않은 슬롯을 만석으로 세면 과대추정이 되므로 실제 키 개수를 호출부가 넘긴다.
 * 주 키(슬롯 0)는 R21-2 예약분 위쪽만 발굴 몫으로 센다 — 정산 추적 몫을 발굴 예산에 넣지 않는다.
 */
export async function youtubeDiscoveryQuotaBudget(input: {
  slotCount: number;
  now?: Date;
}): Promise<YoutubeDiscoveryQuotaBudget> {
  const now = input.now ?? new Date();
  const nextResetIso = youtubeQuotaNextResetIso(now);
  const slotCount = Math.max(0, Math.min(16, Math.round(input.slotCount)));
  if (slotCount === 0) return { remainingUnits: 0, exhausted: true, nextResetIso, maxResultLimit: 0 };
  try {
    const cap = youtubePerKeyDailyCap();
    const used = await Promise.all(
      Array.from({ length: slotCount }, (_unused, slot) => youtubeSlotUnitsUsed(slot, now)),
    );
    const remainingUnits = used.reduce((total, slotUsed, slot) => {
      const reserved = slot === 0 ? YOUTUBE_TRACKING_RESERVED_UNITS : 0;
      return total + Math.max(0, cap - slotUsed - reserved);
    }, 0);
    const maxResultLimit = Math.floor(remainingUnits / YOUTUBE_SEARCH_UNITS_PER_PAGE) * YOUTUBE_SEARCH_PAGE_SIZE;
    return { remainingUnits, exhausted: maxResultLimit <= 0, nextResetIso, maxResultLimit };
  } catch {
    // fail-closed: 잔여를 모르면 발굴을 밀지 않는다(어제처럼 한 번에 태우는 쪽이 더 비싸다).
    return { remainingUnits: 0, exhausted: true, nextResetIso, maxResultLimit: 0 };
  }
}

async function readYoutubeDailyCap(): Promise<number> {
  try {
    const snapshot = await adminDb.collection("integrations").doc("default").get();
    const external = asRecord(asRecord(snapshot.data()).externalApi);
    const raw = Number(external.quotaDaily);
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_YOUTUBE_DAILY_CAP;
  } catch {
    return DEFAULT_YOUTUBE_DAILY_CAP;
  }
}

export type ApiQuotaStatus = {
  readonly dayKey: string;
  readonly youtube: {
    readonly unitsUsed: number;
    readonly dailyCap: number;
    readonly remaining: number;
    readonly percentUsed: number;
    readonly calls: number;
    readonly byOperation: Record<string, number>;
  };
  readonly mail: {
    readonly todaySent: number;
    readonly dailyCap: number;
    readonly hourSent: number;
    readonly hourlyCap: number;
    readonly burstCap: number;
    readonly bounced: number;
    readonly deferred: number;
    readonly suppressed: number;
    readonly outboundLocked: boolean;
    readonly lockedReason?: string;
    readonly reputationStatus: string;
  };
};

export async function readApiQuotaStatus(now = new Date()): Promise<ApiQuotaStatus> {
  const dayKey = seoulDayKey(now);
  const [usageSnap, cap, mail] = await Promise.all([
    adminDb.collection("api_usage").doc(youtubeUsageDocId(dayKey)).get(),
    readYoutubeDailyCap(),
    readMailSafetyStatus(now),
  ]);
  const usage = asRecord(usageSnap.data());
  const unitsUsed = numberValue(usage.units);
  const rawByOperation = asRecord(usage.byOperation);
  const byOperation: Record<string, number> = {};
  for (const [operation, value] of Object.entries(rawByOperation)) {
    byOperation[operation] = numberValue(value);
  }
  return {
    dayKey,
    youtube: {
      unitsUsed,
      dailyCap: cap,
      remaining: Math.max(0, cap - unitsUsed),
      percentUsed: cap > 0 ? Math.min(100, Math.round((unitsUsed / cap) * 100)) : 0,
      calls: numberValue(usage.calls),
      byOperation,
    },
    mail: {
      todaySent: mail.todaySent,
      dailyCap: mail.policy.dailyCap,
      hourSent: mail.hourSent,
      hourlyCap: mail.policy.hourlyCap,
      burstCap: mail.policy.burstCap,
      bounced: mail.bounced,
      deferred: mail.deferred,
      suppressed: mail.suppressed,
      outboundLocked: mail.outboundLocked,
      ...(mail.lockedReason ? { lockedReason: mail.lockedReason } : {}),
      reputationStatus: mail.policy.reputationStatus,
    },
  };
}

// super_admin 전용 — 외부 API 쿼터 소진 현황은 운영 민감정보라 최상위 권한만 조회.
export async function getApiQuotaStatus(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "apiQuota.read", ["super_admin"]);
  const status = await readApiQuotaStatus();
  return {
    ok: true,
    status,
    behaviorLog: makeBehaviorLog(auth, "apiQuota.read", "success", "global", 0),
  };
}
