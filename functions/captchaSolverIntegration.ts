/**
 * AI-DRAMA-DISCOVERY-METAPROMPT W6 — Apify 캡챠 우회 연동 (헤세 결정: T049 이메일 확보는 Apify만).
 *
 * 이 리포에서 캡챠 리스크가 있는 외부 호출은 두 곳이다: functions/discovery.ts의
 * fetchPublicYoutubeChannelText(/about 페이지 이메일 채굴, 이 모듈이 아닌 곳에서 직접 호출)와 이
 * 모듈의 callApifyChannelEmailActor(actor `dataovercoffee/youtube-channel-business-email-scraper`,
 * PAY_PER_EVENT $0.12/email). 그 외(댓글·조회수·메타)는 전부 공식 YouTube Data API라 캡챠 문제가
 * 없다(PLAN-ai-drama-discovery-captcha.md §④). "T049(모수가 작은 org)는 About 스크레이핑을 아예
 * 스킵하고 Apify만 쓴다"는 헤세 결정(2026-09-24)에 따라, discovery.ts는 ownerOrgId가 이 모듈의
 * allowedOrgIds에 있으면 publicWebBackfillExistingCandidateEmails 안에서 About 경로를 완전히
 * 건너뛰고 이 모듈의 actor 호출만 탄다(그 반대: 다른 org는 이 모듈의 actor 호출부를 절대 타지
 * 않는다 — isApifyExclusiveOrg 가드).
 *
 * config 스키마 + org fail-closed 게이트 + 일일 호출/USD/잡당 캡 + TTL 캐시 + 호출당 비용 로그는
 * W6에서 이미 갖췄다. enabled:false 로 머지되므로(코드 기본값) 시크릿 미바인딩·allowedOrgIds 미설정
 * 배포에서도 무해하다 — 실제 T049 가동은 배포 후 관리자 카드에서 enabled:true + allowedOrgIds:
 * ["T049"] + actorId + APIFY_API_KEY 시크릿 바인딩까지 마쳐야 시작된다.
 *
 * 문서: integrations/captcha_solver — functions/youtubeQuotaPools.ts/functions/orgTabPresets.ts와
 * 동일한 doctrine(단일 설정 문서, 5분 프로세스 캐시, admin 전용 read/merge/write 콜러블,
 * makeBehaviorLog 감사, resolveMailAccountsDb/setMailAccountsDbForTests Firestore seam 재사용 —
 * 새 테스트 seam 불필요).
 */
import { randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { asRecord, asString, assertNonGuestAuth, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { resolveMailAccountsDb, type MailAccountsFirestoreDb } from "./mailAccounts";
import { envSecret, authHeader, timeoutSignal } from "./liveIntegrations";

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export const CAPTCHA_SOLVER_INTEGRATION_DOC_PATH = "integrations/captcha_solver";
export const CAPTCHA_SOLVER_USAGE_COLLECTION = "captcha_solver_usage";
export const CAPTCHA_SOLVER_CALL_LOG_COLLECTION = "captcha_solver_call_log";
export const CAPTCHA_SOLVER_CACHE_COLLECTION = "captcha_solver_cache";
// Same 5-minute doctrine as mailAccounts.ts/orgTabPresets.ts/youtubeQuotaPools.ts (admin-only,
// rarely-written doc).
export const CAPTCHA_SOLVER_CACHE_TTL_MS = 5 * 60 * 1000;
// APIFY_API_KEY is the only secret this integration will ever read (future actor-call code) — a
// literal, not a settings-doc field, matching youtubeQuotaPools.ts's secret-name-allowlist doctrine
// (secret names/values never live outside Secret Manager + this constant).
const APIFY_API_KEY_SECRET_NAME = "APIFY_API_KEY";

export type CaptchaSolverIntegration = {
  readonly provider: "apify";
  readonly enabled: boolean;
  /** Fail-closed allowlist — even enabled:true never authorizes an org absent from this list. */
  readonly allowedOrgIds: readonly string[];
  readonly actorId: string;
  readonly dailyCallCap: number;
  readonly dailyBudgetUsd: number;
  /** Per-discovery-job cap — enforced by the (future) caller using this value, not here. */
  readonly perJobCallCap: number;
  readonly cacheTtlHours: number;
  readonly updatedBy: string;
  readonly updatedAt: string;
};

const DEFAULT_CAPTCHA_SOLVER_INTEGRATION: CaptchaSolverIntegration = {
  provider: "apify",
  enabled: false,
  allowedOrgIds: [],
  actorId: "",
  dailyCallCap: 100,
  dailyBudgetUsd: 5,
  perJobCallCap: 30,
  cacheTtlHours: 24,
  updatedBy: "",
  updatedAt: "",
};

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) && num >= min && num <= max ? num : fallback;
}

function normalizeOrgIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => /^[A-Za-z0-9_-]{1,40}$/.test(item)))]
    .sort();
}

async function readCaptchaSolverIntegrationUncached(db: MailAccountsFirestoreDb): Promise<CaptchaSolverIntegration> {
  const snapshot = await db.doc(CAPTCHA_SOLVER_INTEGRATION_DOC_PATH).get();
  const data = snapshot.exists ? asRecord(snapshot.data()) : {};
  return {
    provider: "apify",
    enabled: data.enabled === true,
    allowedOrgIds: normalizeOrgIds(data.allowedOrgIds),
    actorId: asString(data.actorId),
    dailyCallCap: Math.round(numberInRange(data.dailyCallCap, DEFAULT_CAPTCHA_SOLVER_INTEGRATION.dailyCallCap, 0, 100_000)),
    dailyBudgetUsd: numberInRange(data.dailyBudgetUsd, DEFAULT_CAPTCHA_SOLVER_INTEGRATION.dailyBudgetUsd, 0, 10_000),
    perJobCallCap: Math.round(numberInRange(data.perJobCallCap, DEFAULT_CAPTCHA_SOLVER_INTEGRATION.perJobCallCap, 0, 10_000)),
    cacheTtlHours: numberInRange(data.cacheTtlHours, DEFAULT_CAPTCHA_SOLVER_INTEGRATION.cacheTtlHours, 0, 24 * 30),
    updatedBy: asString(data.updatedBy),
    updatedAt: asString(data.updatedAt),
  };
}

let cached: { expiresAt: number; value: CaptchaSolverIntegration } | null = null;

export async function readCaptchaSolverIntegration(
  deps: { db?: MailAccountsFirestoreDb; now?: () => number } = {},
): Promise<CaptchaSolverIntegration> {
  const now = deps.now ?? (() => Date.now());
  if (!deps.db && cached && cached.expiresAt > now()) return cached.value;
  const db = resolveMailAccountsDb(deps.db);
  const value = await readCaptchaSolverIntegrationUncached(db);
  if (!deps.db) cached = { expiresAt: now() + CAPTCHA_SOLVER_CACHE_TTL_MS, value };
  return value;
}

/** Clears the process-local cache. Call after an integrations/captcha_solver write. */
export function clearCaptchaSolverIntegrationCache(): void {
  cached = null;
}

export type CaptchaSolverGateResult = {
  readonly allowed: boolean;
  readonly reason?: "disabled" | "org_not_allowed" | "secret_unbound" | "daily_call_cap_reached" | "daily_budget_reached";
};

// envSecret() (functions/liveIntegrations.ts) always reads process.env directly and takes no
// override — this wrapper lets tests inject a fake env without touching the real process.env.
function apifyApiKeyBound(env?: Record<string, string | undefined>): boolean {
  const value = env ? env[APIFY_API_KEY_SECRET_NAME] ?? "" : envSecret(APIFY_API_KEY_SECRET_NAME);
  return value.trim().length > 0;
}

/**
 * Fail-closed by construction: every early return is `allowed:false`. Never throws — a caller
 * that cannot resolve this gate should treat "not allowed" as the safe default, same as
 * YoutubeQuotaPoolExhaustedError's callers in functions/youtubeQuotaPools.ts.
 */
export async function isCaptchaSolverAllowedForOrg(
  orgId: string | null | undefined,
  deps: { db?: MailAccountsFirestoreDb; env?: Record<string, string | undefined>; now?: Date } = {},
): Promise<CaptchaSolverGateResult> {
  const trimmedOrgId = (orgId ?? "").trim();
  if (!trimmedOrgId) return { allowed: false, reason: "org_not_allowed" };
  const integration = await readCaptchaSolverIntegration({ db: deps.db });
  if (!integration.enabled) return { allowed: false, reason: "disabled" };
  if (!integration.allowedOrgIds.includes(trimmedOrgId)) return { allowed: false, reason: "org_not_allowed" };
  if (!apifyApiKeyBound(deps.env)) return { allowed: false, reason: "secret_unbound" };
  const usage = await readCaptchaSolverUsageToday({ db: deps.db, now: deps.now });
  // Codex 적대 리뷰 수리: cap<=0을 "체크 생략(=무제한)"으로 잘못 읽었었다 — 이 모듈은 전부
  // fail-closed가 원칙이므로, 캡을 0(또는 UI가 빈 입력을 변환한 0)으로 두면 오히려 "이 조직은 오늘
  // 호출 불가"를 뜻해야 한다. 양수 캡만 실제 사용량과 비교한다.
  if (integration.dailyCallCap <= 0 || usage.callCount >= integration.dailyCallCap) {
    return { allowed: false, reason: "daily_call_cap_reached" };
  }
  if (integration.dailyBudgetUsd <= 0 || usage.costUsd >= integration.dailyBudgetUsd) {
    return { allowed: false, reason: "daily_budget_reached" };
  }
  return { allowed: true };
}

// ---------- 일일 호출/비용 캡 (COST-P0) ----------

function usageDayKey(now: Date): string {
  // KST calendar day — matches this repo's other daily-cap doctrines (functions/apiQuota.ts
  // seoulDayKey), so an operator reading multiple daily counters side by side sees the same day
  // boundary everywhere.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export type CaptchaSolverUsageToday = { readonly callCount: number; readonly costUsd: number };

export async function readCaptchaSolverUsageToday(
  deps: { db?: MailAccountsFirestoreDb; now?: Date } = {},
): Promise<CaptchaSolverUsageToday> {
  const db = resolveMailAccountsDb(deps.db);
  const dayKey = usageDayKey(deps.now ?? new Date());
  const snapshot = await db.collection(CAPTCHA_SOLVER_USAGE_COLLECTION).doc(dayKey).get();
  const data = snapshot.exists ? asRecord(snapshot.data()) : {};
  const callCount = Number(data.callCount);
  const costUsd = Number(data.costUsd);
  return {
    callCount: Number.isFinite(callCount) && callCount >= 0 ? callCount : 0,
    costUsd: Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : 0,
  };
}

/**
 * COST-P0-006/007: 호출당 비용 로그. 일일 집계 카운터(캡 판정용, 저비용 조회)와 개별 호출 감사
 * 로그(추적용)를 함께 남긴다.
 *
 * `reservedCallSlot`: 실제 actor 호출부(아래 enrichCandidatesViaApify 등 discovery.ts 호출자)는
 * 호출 **전에** reserveCaptchaSolverCallSlots로 callCount를 이미 원자적으로 선점한다 — 그 경로가
 * 여기서 다시 callCount를 올리면 이중 계상이다. reservedCallSlot:true는 costUsd 증가·감사 로그만
 * 남기고 callCount 증가를 건너뛴다. 기본값 false(생략 시)는 예전 계약과 100% 동일하다(직접
 * recordCaptchaSolverCall만 부르는 기존 호출자·테스트는 회귀 0).
 */
export async function recordCaptchaSolverCall(
  input: { orgId: string; channelId: string; costUsd: number; cacheHit: boolean; reservedCallSlot?: boolean },
  deps: { db?: MailAccountsFirestoreDb; now?: Date } = {},
): Promise<void> {
  const db = resolveMailAccountsDb(deps.db);
  const now = deps.now ?? new Date();
  const dayKey = usageDayKey(now);
  const safeCostUsd = Number.isFinite(input.costUsd) && input.costUsd >= 0 ? input.costUsd : 0;
  await Promise.all([
    db.collection(CAPTCHA_SOLVER_USAGE_COLLECTION).doc(dayKey).set({
      dayKey,
      ...(input.reservedCallSlot === true ? {} : { callCount: FieldValue.increment(1) }),
      costUsd: FieldValue.increment(safeCostUsd),
      updatedAtIso: now.toISOString(),
    }, { merge: true }),
    // MailAccountsFirestoreDb (mailAccounts.ts's Firestore seam) exposes only doc()/get()/set() —
    // no .add() — so this mints its own id, mirroring youtubeQuotaPools.ts's recordBorrowAttempt.
    db.collection(CAPTCHA_SOLVER_CALL_LOG_COLLECTION).doc(`${dayKey}_${randomBytes(6).toString("hex")}`).set({
      orgId: input.orgId,
      // Channel id only — never the scraped page text/URL query params (SEC-P0-009).
      channelId: input.channelId,
      costUsd: safeCostUsd,
      cacheHit: input.cacheHit,
      createdAtIso: now.toISOString(),
    }),
  ]);
}

/**
 * Codex 적대 리뷰 수리(이제 actor 호출부가 생겨 실제로 도달 가능해졌다): 예전에는
 * isCaptchaSolverAllowedForOrg의 "usage 읽기"와 recordCaptchaSolverCall의 "usage 증가"가 분리된
 * 두 단계라, 동시에 여러 호출이 들어오면 cap을 살짝 넘길 수 있었다(read-then-increment race).
 *
 * 이 함수는 그 둘을 하나로 합친다 — MailAccountsFirestoreDb 시드(youtubeQuotaPools.ts와 동일,
 * doc()/get()/set()만 있고 runTransaction은 없다)에서도 원자성을 얻기 위해, Firestore의 단일 문서
 * 필드 변환(FieldValue.increment)이 동시 writer 사이에서도 원자적이라는 보장을 이용한다:
 *   1) callCount를 먼저 `count`만큼 원자적으로 올린다(reserve).
 *   2) 올라간 뒤의 값을 다시 읽어 dailyCallCap을 넘었는지 본다.
 *   3) 넘었으면 초과분만큼 되돌린다(decrement) — 그 초과분은 "승인되지 않은" 것으로 간주해
 *      호출자에게 돌려준다(반환값 = 실제로 승인된 슬롯 수, count 이하).
 * 두 동시 요청이 딱 캡 근처에서 경합해도, 한쪽의 reserve→readback→rollback 사이에 다른 쪽이 끼어
 * 들 수는 있지만(아주 짧은 창), 최종적으로 callCount가 dailyCallCap을 영구히 넘는 상태로 안착하지는
 * 않는다 — 매 reserve 호출이 자기 몫을 직접 롤백하므로 초과분은 반드시 되돌아온다.
 */
export async function reserveCaptchaSolverCallSlots(
  count: number,
  deps: { db?: MailAccountsFirestoreDb; now?: Date; dailyCallCap?: number } = {},
): Promise<number> {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  if (safeCount === 0) return 0;
  const db = resolveMailAccountsDb(deps.db);
  const now = deps.now ?? new Date();
  const dayKey = usageDayKey(now);
  const dailyCallCap = deps.dailyCallCap ?? (await readCaptchaSolverIntegration({ db: deps.db })).dailyCallCap;
  if (dailyCallCap <= 0) return 0;
  const ref = db.collection(CAPTCHA_SOLVER_USAGE_COLLECTION).doc(dayKey);
  await ref.set({ dayKey, callCount: FieldValue.increment(safeCount), updatedAtIso: now.toISOString() }, { merge: true });
  const snapshot = await ref.get();
  const rawCallCount = Number(asRecord(snapshot.data()).callCount);
  const callCountAfterReserve = Number.isFinite(rawCallCount) ? rawCallCount : safeCount;
  const overshoot = Math.max(0, Math.min(safeCount, callCountAfterReserve - dailyCallCap));
  if (overshoot > 0) {
    await ref.set({ callCount: FieldValue.increment(-overshoot), updatedAtIso: now.toISOString() }, { merge: true });
  }
  return safeCount - overshoot;
}

// ---------- TTL 캐시(조직×채널당) — 같은 orgId+channelId 는 TTL 안에서 재수집 스킵 ----------

// Codex 적대 리뷰 수리: 캐시 문서 id를 orgId로 네임스페이스한다 — channelId 하나만 키로 쓰면
// T049가 저장한 결과를 다른(allowlisted) org의 잡이 그대로 받아버리는 구조가 된다. org 경계는
// actor 호출부(아래)가 실제로 쓰기 전부터 잡아 둔다.
function captchaSolverCacheDocId(orgId: string, channelId: string): string {
  return `${orgId}::${channelId}`;
}

export async function captchaSolverCacheLookup(
  orgId: string,
  channelId: string,
  ttlHours: number,
  deps: { db?: MailAccountsFirestoreDb; now?: Date } = {},
): Promise<{ status: "hit"; value: Record<string, unknown> } | { status: "miss" }> {
  const db = resolveMailAccountsDb(deps.db);
  const now = deps.now ?? new Date();
  const snapshot = await db.collection(CAPTCHA_SOLVER_CACHE_COLLECTION).doc(captchaSolverCacheDocId(orgId, channelId)).get();
  if (!snapshot.exists) return { status: "miss" };
  const data = asRecord(snapshot.data());
  const updatedAtIso = asString(data.updatedAtIso);
  const updatedAtMs = updatedAtIso ? Date.parse(updatedAtIso) : NaN;
  const boundedTtlHours = Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : DEFAULT_CAPTCHA_SOLVER_INTEGRATION.cacheTtlHours;
  // Codex 적대 리뷰 수리: 저장 시점에 쓴 ttlHours(expiresAtIso)가 아니라, "이번 조회가 요청한"
  // ttlHours를 age 판정에 직접 쓴다 — 예전에는 24시간으로 저장해 두면 나중에 1시간 TTL로 조회해도
  // 계속 hit였다(호출자가 원하는 신선도를 무시). updatedAtIso(생성/갱신 시각) 기준 age만 본다.
  // 라운드2 수리: Number.isNaN 가드 — updatedAtIso가 비어있거나 파싱 불가면 Date.parse가 NaN을
  // 반환하고, `now - NaN > threshold`는 JS에서 항상 false라 miss 판정을 영원히 건너뛰어 "깨진
  // 타임스탬프가 영구 hit"가 되는 버그였다. 파싱 실패는 명시적으로 miss로 처리한다.
  if (!updatedAtIso || Number.isNaN(updatedAtMs) || now.getTime() - updatedAtMs > boundedTtlHours * 60 * 60 * 1000) {
    return { status: "miss" };
  }
  const value = asRecord(data.value);
  return { status: "hit", value };
}

export async function captchaSolverCacheStore(
  orgId: string,
  channelId: string,
  value: Record<string, unknown>,
  ttlHours: number,
  deps: { db?: MailAccountsFirestoreDb; now?: Date } = {},
): Promise<void> {
  const db = resolveMailAccountsDb(deps.db);
  const now = deps.now ?? new Date();
  const boundedTtlHours = Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : DEFAULT_CAPTCHA_SOLVER_INTEGRATION.cacheTtlHours;
  await db.collection(CAPTCHA_SOLVER_CACHE_COLLECTION).doc(captchaSolverCacheDocId(orgId, channelId)).set({
    orgId,
    channelId,
    value,
    expiresAtIso: new Date(now.getTime() + boundedTtlHours * 60 * 60 * 1000).toISOString(),
    updatedAtIso: now.toISOString(),
  }, { merge: true });
}

// ---------- org 배타 라우팅 게이트 ----------

/**
 * 헤세 결정: 이 함수가 true를 반환하는 org는 discovery.ts의
 * publicWebBackfillExistingCandidateEmails에서 About 스크레이핑을 **절대** 타지 않는다 — Apify가
 * enabled:false거나 일일 캡/예산이 소진돼 이번 pass에서 실제로 호출을 못 하더라도, About로 폴백하지
 * 않는다(그 org는 이번 pass에 이메일을 못 얻고 다음 pass를 기다린다). 반대로 이 함수가 false인 org는
 * (allowedOrgIds에 없으므로) isCaptchaSolverAllowedForOrg가 무엇을 반환하든 이 모듈의 actor 호출부를
 * 절대 타지 않는다 — allowedOrgIds 멤버십이 "이 org가 Apify 전용인가"의 유일한 판정 기준이다
 * (enabled/캡/시크릿 상태와 무관 — 그것들은 "지금 실제로 호출해도 되는가"라는 별개의 질문이다).
 */
export async function isApifyExclusiveOrg(
  orgId: string | null | undefined,
  deps: { db?: MailAccountsFirestoreDb } = {},
): Promise<boolean> {
  const trimmedOrgId = (orgId ?? "").trim();
  if (!trimmedOrgId) return false;
  const integration = await readCaptchaSolverIntegration({ db: deps.db });
  return integration.allowedOrgIds.includes(trimmedOrgId);
}

// ---------- Apify actor 호출 (dataovercoffee/youtube-channel-business-email-scraper) ----------

/**
 * 실측(2026-09-24, 헤세 실험): 5채널 배치 1콜 = 245s(채널당 평균 ~49s) — run-sync-get-dataset-items
 * 는 actor 실행이 끝날 때까지 HTTP 응답을 블로킹한다. 이 상수들은 그 실측을 근거로 한다.
 */
// PAY_PER_EVENT 가격표(actor_info.json pricingInfos, 2026-09-24 조회): 이벤트 "apify-default-
// dataset-item"(=응답에 실린 이메일 1건) 당 $0.12. 채널을 넘겼다고 다 과금되는 게 아니라 실제로
// 데이터셋에 실린 항목만 과금이라, 아래 콜러가 응답 파싱 후 "실제로 이메일이 있었던 건수"로만
// 비용을 계산한다(COST-P0-006/007 "실제 사용량").
export const APIFY_EMAIL_EVENT_PRICE_USD = 0.12;
// 채널당 ~49s 실측 기준, 한 콜에 이보다 많이 태우면 Cloud Functions 타임아웃/discovery.ts 쪽
// deadlineMs 예산을 넘기기 쉽다 — 관리자가 올리는 perJobCallCap(잡당 상한)과는 별개의, 지연시간
// 기반 코드 레벨 안전판이다.
export const APIFY_BATCH_SIZE_MAX = 5;
// 5채널 245s 실측에 여유를 더한 상한 — 이보다 짧게 남은 예산에서는 아예 시도하지 않는다(아래
// discovery.ts 호출부가 deadlineMs 잔여로 판단).
export const APIFY_CALL_TIMEOUT_MS_MAX = 5 * 60 * 1000;
export const APIFY_CALL_MIN_BUDGET_MS = 60_000;

function apifyActorRunSyncUrl(actorId: string): string {
  // "dataovercoffee/youtube-channel-business-email-scraper" -> ".../acts/dataovercoffee~youtube-.../run-sync-get-dataset-items"
  const actorPath = actorId.trim().replace(/\//g, "~");
  return `https://api.apify.com/v2/acts/${encodeURIComponent(actorPath)}/run-sync-get-dataset-items`;
}

export type ApifyChannelEmailItem = {
  readonly query: string;
  readonly channelId: string;
  readonly email: string | null;
  readonly status: string;
  readonly channelHandle: string;
  readonly subscriberCount: number | null;
  readonly country: string;
  readonly totalViews: number | null;
};

/** actor 응답(JSON 배열) 파서 — 순수 함수, 네트워크 없이 단위 테스트 가능(고정 fixture로 검증). */
export function parseApifyChannelEmailItems(body: unknown): ApifyChannelEmailItem[] {
  if (!Array.isArray(body)) return [];
  const items: ApifyChannelEmailItem[] = [];
  for (const raw of body) {
    const record = asRecord(raw);
    const query = asString(record.Query);
    if (!query) continue;
    const status = asString(record.Status, "UNKNOWN") ?? "UNKNOWN";
    const email = status === "EMAIL_AVAILABLE" ? asString(record.Email) ?? null : null;
    const subscriberCount = typeof record.SubscriberCount === "number" && Number.isFinite(record.SubscriberCount) ? record.SubscriberCount : null;
    const totalViews = typeof record.TotalViews === "number" && Number.isFinite(record.TotalViews) ? record.TotalViews : null;
    items.push({
      query,
      channelId: asString(record.ChannelId, "") ?? "",
      email,
      status,
      channelHandle: asString(record.ChannelHandle, "") ?? "",
      subscriberCount,
      country: asString(record.Country, "") ?? "",
      totalViews,
    });
  }
  return items;
}

export type CallApifyChannelEmailActorResult =
  | { readonly status: "success"; readonly items: readonly ApifyChannelEmailItem[] }
  | { readonly status: "not_configured" }
  | { readonly status: "http_error"; readonly httpStatus: number }
  | { readonly status: "timeout" }
  | { readonly status: "parse_error" };

export type CallApifyChannelEmailActorDeps = {
  readonly fetchImpl?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
};

/**
 * NET-P0-012/SEC-P0-005: 이 함수가 이 리포에서 dataovercoffee actor를 부르는 **유일한** 지점이다
 * (discovery.ts는 이 함수를 통해서만 호출한다). SEC-P0-009: 채널 URL/id·구독자수 등 actor가 이미
 * 공개적으로 산출한 채널 메타만 다루고, discovery.ts 쪽 caller도 감사 로그에는 channelId만 남긴다
 * (본문·쿼리 파라미터 원문 없음 — recordCaptchaSolverCall 참고).
 */
export async function callApifyChannelEmailActor(
  channels: readonly string[],
  input: { actorId: string },
  deps: CallApifyChannelEmailActorDeps = {},
): Promise<CallApifyChannelEmailActorResult> {
  const actorId = input.actorId.trim();
  const apiKey = deps.env ? (deps.env.APIFY_API_KEY ?? "").trim() : envSecret("APIFY_API_KEY");
  if (!actorId || !apiKey || channels.length === 0) return { status: "not_configured" };

  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = Math.min(APIFY_CALL_TIMEOUT_MS_MAX, Math.max(1_000, deps.timeoutMs ?? APIFY_CALL_TIMEOUT_MS_MAX));
  let response: Response;
  try {
    response = await fetchImpl(apifyActorRunSyncUrl(actorId), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...authHeader(apiKey) },
      body: JSON.stringify({ channels: [...channels], scrape_fresh_emails: false }),
      signal: timeoutSignal(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { status: "timeout" };
    return { status: "http_error", httpStatus: 0 };
  }
  if (!response.ok) return { status: "http_error", httpStatus: response.status };
  try {
    const body = await response.json();
    return { status: "success", items: parseApifyChannelEmailItems(body) };
  } catch {
    return { status: "parse_error" };
  }
}

// ---------- admin 콜러블 ----------

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), {
    code: "invalid-argument",
    errorCode: "captcha_solver_integration_invalid_argument",
  });
}

/** Client-safe projection — never the secret value, only whether it's bound (SEC-P0-009). */
export type CaptchaSolverIntegrationPublic = CaptchaSolverIntegration & {
  readonly runtimeSecretBound: boolean;
  readonly requiredEnv: string;
  readonly usageToday: CaptchaSolverUsageToday;
};

async function toPublic(integration: CaptchaSolverIntegration): Promise<CaptchaSolverIntegrationPublic> {
  return {
    ...integration,
    runtimeSecretBound: apifyApiKeyBound(),
    requiredEnv: APIFY_API_KEY_SECRET_NAME,
    usageToday: await readCaptchaSolverUsageToday(),
  };
}

export async function getCaptchaSolverIntegration(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "captcha_solver_integration.read", ["super_admin", "admin"]);
  const integration = await readCaptchaSolverIntegration();
  return {
    ok: true,
    integration: await toPublic(integration),
    behaviorLog: makeBehaviorLog(auth, "captcha_solver_integration.read", "success", "global", 0),
  };
}

export async function setCaptchaSolverIntegration(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "captcha_solver_integration.update", ["super_admin", "admin"]);
  const data = asRecord(request.data);
  const db = resolveMailAccountsDb();
  // Fresh (uncached) read-modify-write — same doctrine as youtubeQuotaPools.ts setYouTubeQuotaPools/
  // orgTabPresets.ts setOrgTabPresets: the merge base must never be the process-local cache.
  const current = await readCaptchaSolverIntegrationUncached(db);

  const allowedOrgIds = data.allowedOrgIds === undefined ? current.allowedOrgIds : normalizeOrgIds(data.allowedOrgIds);
  const actorId = data.actorId === undefined ? current.actorId : asString(data.actorId).trim().slice(0, 200);
  const nextEnabled = data.enabled === undefined ? current.enabled : asBoolean(data.enabled, current.enabled);
  // Codex 적대 리뷰 라운드3 수리: 원래는 "이번 요청이 명시적으로 enabled:true를 보냈는지"만
  // 봤다 — 이미 enabled:true인 상태에서 enabled 필드 없이 actorId만 ""로 지우는 요청은 검증을
  // 안 타고 그대로 저장돼, "계속 켜진 채로 actorId가 빈" 상태가 만들어졌다. 이 요청 이후 실제로
  // enabled로 남는(resolved) 상태 기준으로 검증한다.
  if (nextEnabled && (allowedOrgIds.length === 0 || !actorId)) {
    throw invalidArgument("enabled:true requires at least one allowedOrgIds entry and a non-empty actorId");
  }

  const next: CaptchaSolverIntegration = {
    provider: "apify",
    enabled: nextEnabled,
    allowedOrgIds,
    actorId,
    dailyCallCap: data.dailyCallCap === undefined ? current.dailyCallCap : Math.round(numberInRange(data.dailyCallCap, current.dailyCallCap, 0, 100_000)),
    dailyBudgetUsd: data.dailyBudgetUsd === undefined ? current.dailyBudgetUsd : numberInRange(data.dailyBudgetUsd, current.dailyBudgetUsd, 0, 10_000),
    perJobCallCap: data.perJobCallCap === undefined ? current.perJobCallCap : Math.round(numberInRange(data.perJobCallCap, current.perJobCallCap, 0, 10_000)),
    cacheTtlHours: data.cacheTtlHours === undefined ? current.cacheTtlHours : numberInRange(data.cacheTtlHours, current.cacheTtlHours, 0, 24 * 30),
    updatedBy: auth.userId,
    updatedAt: new Date().toISOString(),
  };

  await db.doc(CAPTCHA_SOLVER_INTEGRATION_DOC_PATH).set({ ...next }, { merge: false });
  clearCaptchaSolverIntegrationCache();

  return {
    ok: true,
    integration: await toPublic(next),
    behaviorLog: makeBehaviorLog(auth, "captcha_solver_integration.update", "success", "global", 0),
  };
}
