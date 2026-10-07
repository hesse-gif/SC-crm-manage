/**
 * Flu/Task-49 — org -> YouTube quota pool routing.
 *
 * Each org (Peoply orgId) can be mapped to a "pool": a set of YouTube API key secret names +
 * an OAuth client secret-name pair, backed by its own GCP project(s) (see the ticket's 인프라
 * 진행 section). "growth" (scp) is the pre-existing implicit pool — the 4-key rotation
 * (YOUTUBE_API_KEY + FALLBACK_1~3) functions/apiQuota.ts already tracked before this ticket — and
 * stays the default for every org with no mapping, so a deploy with no settings/youtube_quota_pools
 * doc at all keeps 100% of today's behavior (completion condition: fallback-to-growth, 회귀 0).
 *
 * Mirrors functions/orgTabPresets.ts's shape exactly: a single settings doc, a short process
 * cache (same TTL doctrine as mailAccounts.ts/orgTabPresets.ts), admin-only write via a
 * read-fresh/merge/full-overwrite callable, makeBehaviorLog audit. Reuses the same Firestore
 * seam (resolveMailAccountsDb / setMailAccountsDbForTests) every settings/* doc module in this
 * codebase already shares — no new test seam needed.
 *
 * Secret **names** only ever live in this doc — never a secret value (SEC-P0-009). The two admin
 * callables below enforce that split further: getYouTubeQuotaPools (read) never returns a secret
 * name to the client, only pool ids and the orgId->poolId/crossBorrow shape (completion
 * condition: pool doc/secret names never reach the client). setYouTubeQuotaPools (write) accepts
 * secret names as input (an admin operating Secret Manager already knows them) but the response
 * body is a pool-id list too.
 */
import { randomBytes } from "node:crypto";
import { asRecord, asString, assertNonGuestAuth, makeBehaviorLog, type CallableRequestShape } from "./shared";
import { resolveMailAccountsDb, type MailAccountsFirestoreDb } from "./mailAccounts";
import { YOUTUBE_GROWTH_POOL_ID, youtubePerKeyDailyCap, youtubeSlotUnitsUsed as defaultYoutubeSlotUnitsUsed } from "./apiQuota";

export const YOUTUBE_QUOTA_POOLS_DOC_PATH = "settings/youtube_quota_pools";
export const YOUTUBE_QUOTA_BORROW_LOG_COLLECTION = "youtube_quota_borrow_log";
export const YOUTUBE_QUOTA_BORROW_COUNTERS_COLLECTION = "youtube_quota_borrow_counters";
export const DEFAULT_YOUTUBE_QUOTA_POOLS_POLICY_VERSION = "youtube-quota-pools-v1" as const;
// Same 5-minute doctrine as mailAccounts.ts/orgTabPresets.ts (admin-only, rarely-written doc).
export const YOUTUBE_QUOTA_POOLS_CACHE_TTL_MS = 5 * 60 * 1000;

// Secret env var names an admin may reference from this doc — never anything else, so a typo/
// mistake here can never accidentally point a pool at an unrelated secret (e.g. SMTP_PASSWORD).
const API_KEY_SECRET_NAME_PATTERN = /^(YOUTUBE_API_KEY(_FALLBACK_[1-9][0-9]*)?|YOUTUBE_POOL_[A-Z0-9_]{2,60}_API_KEY)$/;
const OAUTH_CLIENT_ID_SECRET_NAME_PATTERN = /^(GOOGLE_OAUTH_CLIENT_ID|YOUTUBE_POOL_[A-Z0-9_]{2,60}_OAUTH_CLIENT_ID)$/;
const OAUTH_CLIENT_SECRET_SECRET_NAME_PATTERN = /^(GOOGLE_OAUTH_CLIENT_SECRET|YOUTUBE_POOL_[A-Z0-9_]{2,60}_OAUTH_CLIENT_SECRET)$/;
const POOL_ID_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;

export type YoutubeQuotaPoolConfig = {
  readonly apiKeySecretNames: readonly string[];
  readonly oauthClientIdSecretName: string;
  readonly oauthClientSecretSecretName: string;
};

export type YoutubeQuotaCrossBorrowConfig = {
  readonly enabled: boolean;
  /** 0..1 — the lender pool must have at least this fraction of its per-key daily cap left. */
  readonly minLenderRemainingRatio: number;
  readonly lenderPoolId: string;
  /** Max number of borrow grants (not units — the unit cost of the eventual call isn't known
   * yet at key-selection time) a borrower pool may take from the lender per PT day. */
  readonly dailyBorrowCapCalls: number;
};

export type YoutubeQuotaPools = {
  readonly pools: Readonly<Record<string, YoutubeQuotaPoolConfig>>;
  readonly byOrgId: Readonly<Record<string, string>>;
  readonly crossBorrow: YoutubeQuotaCrossBorrowConfig;
  readonly policyVersion: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
};

/** growth's 4-slot rotation — identical to functions/index.ts's YOUTUBE_API_SECRETS literal and
 * functions/mailOAuth.ts's existing GOOGLE_OAUTH_CLIENT_ID/SECRET. Used whenever no doc exists,
 * or a doc exists but never overrides "growth" — the safety net behind completion condition 6. */
export const DEFAULT_GROWTH_POOL_CONFIG: YoutubeQuotaPoolConfig = {
  apiKeySecretNames: [
    "YOUTUBE_API_KEY",
    "YOUTUBE_API_KEY_FALLBACK_1",
    "YOUTUBE_API_KEY_FALLBACK_2",
    "YOUTUBE_API_KEY_FALLBACK_3",
  ],
  oauthClientIdSecretName: "GOOGLE_OAUTH_CLIENT_ID",
  oauthClientSecretSecretName: "GOOGLE_OAUTH_CLIENT_SECRET",
};

export const DEFAULT_CROSS_BORROW_CONFIG: YoutubeQuotaCrossBorrowConfig = {
  enabled: false,
  minLenderRemainingRatio: 0.5,
  lenderPoolId: YOUTUBE_GROWTH_POOL_ID,
  dailyBorrowCapCalls: 200,
};

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) && num >= min && num <= max ? num : fallback;
}

function readStoredPoolConfig(value: unknown): YoutubeQuotaPoolConfig | null {
  const record = asRecord(value);
  const apiKeySecretNames = Array.isArray(record.apiKeySecretNames)
    ? record.apiKeySecretNames.filter((name): name is string => typeof name === "string" && API_KEY_SECRET_NAME_PATTERN.test(name))
    : [];
  const oauthClientIdSecretName = asString(record.oauthClientIdSecretName);
  const oauthClientSecretSecretName = asString(record.oauthClientSecretSecretName);
  if (
    apiKeySecretNames.length === 0
    || !OAUTH_CLIENT_ID_SECRET_NAME_PATTERN.test(oauthClientIdSecretName)
    || !OAUTH_CLIENT_SECRET_SECRET_NAME_PATTERN.test(oauthClientSecretSecretName)
  ) {
    return null;
  }
  return { apiKeySecretNames, oauthClientIdSecretName, oauthClientSecretSecretName };
}

async function readYouTubeQuotaPoolsUncached(db: MailAccountsFirestoreDb): Promise<YoutubeQuotaPools> {
  const snapshot = await db.doc(YOUTUBE_QUOTA_POOLS_DOC_PATH).get();
  const data = snapshot.exists ? asRecord(snapshot.data()) : {};
  const storedPools = asRecord(data.pools);
  const pools: Record<string, YoutubeQuotaPoolConfig> = {};
  for (const [poolId, rawConfig] of Object.entries(storedPools)) {
    if (!POOL_ID_PATTERN.test(poolId)) continue;
    const config = readStoredPoolConfig(rawConfig);
    if (config) pools[poolId] = config;
  }
  // Safety net: "growth" always resolves, even if the stored doc never defined it explicitly.
  if (!pools[YOUTUBE_GROWTH_POOL_ID]) pools[YOUTUBE_GROWTH_POOL_ID] = DEFAULT_GROWTH_POOL_CONFIG;

  const byOrgIdRaw = asRecord(data.byOrgId);
  const byOrgId: Record<string, string> = {};
  for (const [orgId, poolIdValue] of Object.entries(byOrgIdRaw)) {
    const poolId = asString(poolIdValue);
    if (poolId && POOL_ID_PATTERN.test(poolId)) byOrgId[orgId] = poolId;
  }

  const crossBorrowRaw = asRecord(data.crossBorrow);
  const crossBorrow: YoutubeQuotaCrossBorrowConfig = {
    enabled: crossBorrowRaw.enabled === true,
    minLenderRemainingRatio: numberInRange(crossBorrowRaw.minLenderRemainingRatio, DEFAULT_CROSS_BORROW_CONFIG.minLenderRemainingRatio, 0, 1),
    lenderPoolId: (() => {
      const lenderPoolId = asString(crossBorrowRaw.lenderPoolId);
      return lenderPoolId && POOL_ID_PATTERN.test(lenderPoolId) ? lenderPoolId : DEFAULT_CROSS_BORROW_CONFIG.lenderPoolId;
    })(),
    dailyBorrowCapCalls: Math.round(numberInRange(crossBorrowRaw.dailyBorrowCapCalls, DEFAULT_CROSS_BORROW_CONFIG.dailyBorrowCapCalls, 0, 100_000)),
  };

  return {
    pools,
    byOrgId,
    crossBorrow,
    policyVersion: asString(data.policyVersion, DEFAULT_YOUTUBE_QUOTA_POOLS_POLICY_VERSION),
    updatedBy: asString(data.updatedBy, ""),
    updatedAt: asString(data.updatedAt, ""),
  };
}

let cachedPools: { expiresAt: number; value: YoutubeQuotaPools } | null = null;

export async function readYouTubeQuotaPools(
  deps: { db?: MailAccountsFirestoreDb; now?: () => number } = {},
): Promise<YoutubeQuotaPools> {
  const now = deps.now ?? (() => Date.now());
  if (!deps.db && cachedPools && cachedPools.expiresAt > now()) return cachedPools.value;
  const db = resolveMailAccountsDb(deps.db);
  const value = await readYouTubeQuotaPoolsUncached(db);
  if (!deps.db) cachedPools = { expiresAt: now() + YOUTUBE_QUOTA_POOLS_CACHE_TTL_MS, value };
  return value;
}

/** Clears the process-local cache. Call after a settings/youtube_quota_pools write. */
export function clearYouTubeQuotaPoolsCache(): void {
  cachedPools = null;
}

/** orgId -> poolId. No mapping (or no orgId) resolves to "growth" — the zero-behavior-change
 * default this ticket's completion conditions require. */
export async function resolvePoolIdForOrg(
  orgId: string | null | undefined,
  deps: { db?: MailAccountsFirestoreDb } = {},
): Promise<string> {
  if (!orgId) return YOUTUBE_GROWTH_POOL_ID;
  const pools = await readYouTubeQuotaPools(deps);
  return pools.byOrgId[orgId] ?? YOUTUBE_GROWTH_POOL_ID;
}

/** Same as resolvePoolIdForOrg, but for a mail_accounts-style multi-org account
 * (MailAccount.orgIds) — the first orgId with a pool mapping wins; no match falls back to
 * growth. Used by functions/mailOAuth.ts (a workspace_oauth account already carries orgIds). */
export async function resolvePoolIdForOrgIds(
  orgIds: readonly string[] | null | undefined,
  deps: { db?: MailAccountsFirestoreDb } = {},
): Promise<string> {
  if (!orgIds || orgIds.length === 0) return YOUTUBE_GROWTH_POOL_ID;
  const pools = await readYouTubeQuotaPools(deps);
  for (const orgId of orgIds) {
    const poolId = pools.byOrgId[orgId];
    if (poolId) return poolId;
  }
  return YOUTUBE_GROWTH_POOL_ID;
}

export function resolveOAuthClientSecretNames(
  pools: YoutubeQuotaPools,
  poolId: string,
): { readonly poolId: string; readonly clientIdSecretName: string; readonly clientSecretSecretName: string } {
  const config = pools.pools[poolId] ?? DEFAULT_GROWTH_POOL_CONFIG;
  const effectivePoolId = pools.pools[poolId] ? poolId : YOUTUBE_GROWTH_POOL_ID;
  return {
    poolId: effectivePoolId,
    clientIdSecretName: config.oauthClientIdSecretName,
    clientSecretSecretName: config.oauthClientSecretSecretName,
  };
}

export class YoutubeQuotaPoolExhaustedError extends Error {
  readonly code = "resource-exhausted";
  readonly errorCode = "youtube_quota_pool_exhausted";
  readonly poolId: string;
  constructor(poolId: string) {
    super(`YouTube quota pool "${poolId}" is exhausted for today`);
    this.name = "YoutubeQuotaPoolExhaustedError";
    this.poolId = poolId;
  }
}

export type YoutubeKeySelection = {
  readonly apiKey: string;
  readonly slotIndex: number;
  /** The pool the ledger write for this call must be recorded against. */
  readonly poolId: string;
  /** Present only when the key actually came from a cross-pool borrow. */
  readonly borrowedFromPoolId?: string;
};

// db.doc(path)/collection(name).doc(id) 의 반환 타입 — MailAccountsFirestoreDb 가 이미 그 모양을
// 쓰므로 ReturnType 으로 재사용한다(새 공개 타입을 안 늘린다).
type FirestoreDocRefLike = ReturnType<MailAccountsFirestoreDb["doc"]>;
// 인시던트 2026-09-29 Codex 리뷰 라운드4 #4: 차용 admission(상한 확인 + 카운터 증가)을 원자적으로
// 묶으려면 실제 Firestore 트랜잭션이 필요하다 — MailAccountsFirestoreDb 의 좁은 인터페이스는
// runTransaction 을 선언하지 않지만, resolveMailAccountsDb() 의 실제 프로덕션 객체(진짜
// firebase-admin Firestore 인스턴스)는 이미 이 메서드를 갖고 있다. 이 타입은 그 사실을 **드러낼**
// 뿐이다(새 런타임 동작 없음) — 테스트 페이크만 이 메서드를 새로 구현하면 된다.
export type TransactionCapableFirestoreDb = MailAccountsFirestoreDb & {
  runTransaction<T>(
    updateFunction: (transaction: {
      get(ref: FirestoreDocRefLike): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
      set(ref: FirestoreDocRefLike, data: Record<string, unknown>, options?: { merge?: boolean }): void;
    }) => Promise<T>,
  ): Promise<T>;
};

/**
 * 재리뷰 P1-1(원래 발견): 예전엔 읽기(readBorrowGrantsToday)와 쓰기(FieldValue.increment)가
 * 분리돼 있어 두 동시 차용이 같은 currentGrants 를 읽고 둘 다 grants:N+1 을 써서 하나가 유실됐다
 * (lost update) — increment 자체는 최종 카운터 값은 맞혔지만, **상한 판정**(grantsToday >= cap)
 * 은 여전히 그 증가와 분리된 스냅샷이라 상한 근처에서 두 요청이 동시에 통과할 수 있었다.
 * 인시던트 2026-09-29 Codex 리뷰 라운드4 #4: 판정과 증가를 **하나의 트랜잭션**으로 묶는다 —
 * Firestore 트랜잭션은 이 문서를 읽은 두 동시 시도 중 하나를 자동 재시도시키므로, 상한을 넘는
 * grants 는 원자적으로 절대 기록될 수 없다.
 */
async function admitBorrowGrant(
  db: TransactionCapableFirestoreDb,
  lenderPoolId: string,
  dayKey: string,
  dailyBorrowCapCalls: number,
): Promise<boolean> {
  const counterRef = db.collection(YOUTUBE_QUOTA_BORROW_COUNTERS_COLLECTION).doc(`${lenderPoolId}_${dayKey}`);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(counterRef);
    const current = asRecord(snapshot.exists ? snapshot.data() : undefined);
    const grantsValue = Number(current.grants);
    const currentGrants = Number.isFinite(grantsValue) && grantsValue >= 0 ? grantsValue : 0;
    if (currentGrants >= dailyBorrowCapCalls) return false;
    transaction.set(counterRef, {
      lenderPoolId, dayKey, grants: currentGrants + 1, updatedAtIso: new Date().toISOString(),
    }, { merge: true });
    return true;
  });
}

async function recordBorrowAttempt(
  db: MailAccountsFirestoreDb,
  input: {
    borrowerPoolId: string;
    lenderPoolId: string;
    orgId: string | null;
    allowed: boolean;
    reason: "ok" | "lender_below_threshold" | "daily_cap_reached";
    lenderRemainingRatio: number;
    dayKey: string;
  },
): Promise<void> {
  const id = `${input.dayKey}_${input.borrowerPoolId}_${randomBytes(6).toString("hex")}`;
  await db.collection(YOUTUBE_QUOTA_BORROW_LOG_COLLECTION).doc(id).set({
    borrowerPoolId: input.borrowerPoolId,
    lenderPoolId: input.lenderPoolId,
    orgId: input.orgId,
    allowed: input.allowed,
    reason: input.reason,
    lenderRemainingRatio: input.lenderRemainingRatio,
    dayKey: input.dayKey,
    createdAtIso: new Date().toISOString(),
  });
}

export type SelectYoutubeApiKeyInput = {
  readonly orgId?: string | null;
  /** Bypasses orgId->pool resolution — used by callers that already resolved a poolId. */
  readonly poolIdOverride?: string;
  readonly now?: Date;
  readonly env?: Record<string, string | undefined>;
  readonly db?: MailAccountsFirestoreDb;
  /** Injectable so tests never need the Firestore emulator to exercise pool exhaustion/borrow
   * without touching functions/apiQuota.ts's own (non-injectable) adminDb wiring. Defaults to
   * the real functions/apiQuota.ts ledger read. */
  readonly readSlotUnitsUsed?: typeof defaultYoutubeSlotUnitsUsed;
  /** Codex 적대 리뷰 수리(functions/creatorCommentSentiment.ts sweep): true면 요청 풀 자체가
   * 소진됐을 때 crossBorrow로 빠지지 않고 즉시 YoutubeQuotaPoolExhaustedError를 던진다. 빌리는
   * 것 자체가 recordBorrowGrant로 lender의 일일 borrow 카운터를 소비하는 부작용이 있어서, "빌린
   * 키를 받고 나서 호출부가 쓰지 않기로 거부"하는 패턴(예: org 격리 재확인 후 거부)은 실제로 쓰지도
   * 않은 빌림 grant를 매번 낭비한다 — 이 플래그는 그 낭비 자체를 막는다(선택 시점에 미리 차단).
   */
  readonly disallowCrossBorrow?: boolean;
  /** 인시던트 2026-09-29 Codex 리뷰 #3: 호출부가 **실제 라이브 429** 로 이 풀의 현재 키가 소진됐음을
   * 이미 확인했을 때 true 로 넘긴다 — 아래 own-pool 재선택 루프(원장 스냅샷 기준)를 건너뛰고 곧장
   * crossBorrow 판정으로 간다. 이 인시던트의 정확한 증상(원장은 "룸 있음"인데 구글 실제 쿼터는
   * 소진)에서, 원장을 다시 믿고 같은 own-pool 키를 또 고르면 차용을 영영 시도하지 못한다. 기본
   * false — 사전 판정(호출 전 확인) 경로는 그대로다.
   */
  readonly ownPoolConfirmedExhausted?: boolean;
  /** 인시던트 2026-09-29 Codex 리뷰 라운드4 #4: 이번에 실제로 나갈 호출의 예상 유닛 비용 — lender
   * 잔여율 판정이 "지금까지 쓴 양"이 아니라 "이 호출까지 쓰고 난 뒤" 기준이 되게 한다(리뷰어 실측:
   * 4,999/10,000 사용 중 100유닛짜리 검색을 승인하면 그 호출 자체가 잔여율을 50% 밑으로 떨어뜨린다).
   * 기본 1(가장 보수적인 비검색 가정) — 호출부가 모르면 과소평가보다 과대평가가 안전하다. */
  readonly estimatedUnitCost?: number;
};

/**
 * Picks the first slot in the resolved pool that has both a configured secret value and
 * remaining daily quota. Growth-pool exhaustion still throws (unchanged from the implicit
 * behavior every existing growth-only call site already relies on: no key => the call can't
 * happen). A non-growth pool that's fully exhausted never touches growth's ledger — it either
 * borrows (if crossBorrow.enabled and the lender clears the remaining-ratio + daily-cap gates,
 * logging the attempt either way) or throws YoutubeQuotaPoolExhaustedError.
 */
export async function selectYoutubeApiKey(input: SelectYoutubeApiKeyInput = {}): Promise<YoutubeKeySelection> {
  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  const readSlotUnitsUsed = input.readSlotUnitsUsed ?? defaultYoutubeSlotUnitsUsed;
  const pools = await readYouTubeQuotaPools({ db: input.db });
  const requestedPoolId = input.poolIdOverride ?? (input.orgId ? pools.byOrgId[input.orgId] : undefined) ?? YOUTUBE_GROWTH_POOL_ID;
  const poolId = pools.pools[requestedPoolId] ? requestedPoolId : YOUTUBE_GROWTH_POOL_ID;
  const poolConfig = pools.pools[poolId] ?? DEFAULT_GROWTH_POOL_CONFIG;
  const cap = youtubePerKeyDailyCap();

  if (!input.ownPoolConfirmedExhausted) {
    for (let slot = 0; slot < poolConfig.apiKeySecretNames.length; slot += 1) {
      const apiKey = env[poolConfig.apiKeySecretNames[slot]]?.trim();
      if (!apiKey) continue;
      const used = await readSlotUnitsUsed(slot, now, poolId);
      if (used < cap) return { apiKey, slotIndex: slot, poolId };
    }
  }

  if (poolId === YOUTUBE_GROWTH_POOL_ID || !pools.crossBorrow.enabled || input.disallowCrossBorrow) {
    throw new YoutubeQuotaPoolExhaustedError(poolId);
  }

  // Cross-borrow: only ever reads the lender pool's usage to decide, then (if allowed) uses the
  // lender's own key — the borrower's ledger is never written by this path, so a rejected/absent
  // borrow can never look like the borrower itself made progress.
  const lenderPoolId = pools.pools[pools.crossBorrow.lenderPoolId] ? pools.crossBorrow.lenderPoolId : YOUTUBE_GROWTH_POOL_ID;
  const lenderConfig = pools.pools[lenderPoolId] ?? DEFAULT_GROWTH_POOL_CONFIG;
  const dayKey = youtubeQuotaDayKeyForBorrowLog(now);
  const db = resolveMailAccountsDb(input.db) as TransactionCapableFirestoreDb;
  const estimatedUnitCost = Math.max(0, Math.trunc(input.estimatedUnitCost ?? 1));

  // Consider every configured lender key. A nearly exhausted first key must not hide a healthy
  // later project: each candidate has its own daily quota ledger and donor reserve.
  const lenderSlotCandidates = lenderConfig.apiKeySecretNames.map((name, slot) => ({ name, slot }));
  let lenderSlot: { apiKey: string; slot: number; remainingRatio: number } | null = null;
  let lenderRemainingRatio = 0;
  for (const candidate of lenderSlotCandidates) {
    const apiKey = env[candidate.name]?.trim();
    if (!apiKey) continue;
    const lenderUsed = await readSlotUnitsUsed(candidate.slot, now, lenderPoolId);
    // The donor reserve must include the cost of the call we are about to make.
    const remainingRatio = cap > 0 ? Math.max(0, cap - lenderUsed - estimatedUnitCost) / cap : 0;
    lenderRemainingRatio = Math.max(lenderRemainingRatio, remainingRatio);
    if (remainingRatio >= pools.crossBorrow.minLenderRemainingRatio) {
      lenderSlot = { apiKey, slot: candidate.slot, remainingRatio };
      break;
    }
  }
  if (!lenderSlot) {
    await recordBorrowAttempt(db, {
      borrowerPoolId: poolId, lenderPoolId, orgId: input.orgId ?? null, allowed: false,
      reason: "lender_below_threshold", lenderRemainingRatio, dayKey,
    });
    throw new YoutubeQuotaPoolExhaustedError(poolId);
  }
  lenderRemainingRatio = lenderSlot.remainingRatio;

  // 인시던트 2026-09-29 Codex 리뷰 라운드4 #4: 상한 확인 + 카운터 증가를 한 트랜잭션으로 묶는다 —
  // 분리돼 있으면 두 동시 차용이 같은 grantsToday 를 읽고 둘 다 통과할 수 있다(TOCTOU).
  const admitted = await admitBorrowGrant(db, lenderPoolId, dayKey, pools.crossBorrow.dailyBorrowCapCalls);
  if (!admitted) {
    await recordBorrowAttempt(db, {
      borrowerPoolId: poolId, lenderPoolId, orgId: input.orgId ?? null, allowed: false,
      reason: "daily_cap_reached", lenderRemainingRatio, dayKey,
    });
    throw new YoutubeQuotaPoolExhaustedError(poolId);
  }

  try {
    await recordBorrowAttempt(db, {
      borrowerPoolId: poolId, lenderPoolId, orgId: input.orgId ?? null, allowed: true,
      reason: "ok", lenderRemainingRatio, dayKey,
    });
  } catch (error) {
    // The transactional counter is the authoritative admission record. A separate audit write
    // failure must not strand its grant before the already-approved API call can use it.
    const rawErrorCode = (error as { errorCode?: unknown } | null)?.errorCode;
    console.warn("[youtube-quota-pools] admitted borrow audit log failed", {
      borrowerPoolId: poolId,
      lenderPoolId,
      errorCode: typeof rawErrorCode === "string" && /^[a-z0-9_-]{1,40}$/i.test(rawErrorCode) ? rawErrorCode : "unknown",
    });
  }

  return { apiKey: lenderSlot.apiKey, slotIndex: lenderSlot.slot, poolId: lenderPoolId, borrowedFromPoolId: lenderPoolId };
}

// PT calendar day (mirrors functions/apiQuota.ts's youtubeQuotaDayKey — duplicated as a tiny
// pure function rather than imported, since apiQuota.ts doesn't export it and this file already
// receives the daily-cap/slot-usage primitives it needs from there via DI).
function youtubeQuotaDayKeyForBorrowLog(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// ---------- admin callables ----------

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), {
    code: "invalid-argument",
    errorCode: "youtube_quota_pools_invalid_argument",
  });
}

/** Client-safe projection — pool ids and org mapping only, never a secret name (SEC-P0-009 /
 * completion condition: pool doc + secret names never reach the client). */
export type YoutubeQuotaPoolsPublic = {
  readonly pools: ReadonlyArray<{ readonly poolId: string; readonly apiKeySlotCount: number; readonly hasOauthClient: boolean }>;
  readonly byOrgId: Readonly<Record<string, string>>;
  readonly crossBorrow: YoutubeQuotaCrossBorrowConfig;
  readonly policyVersion: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
};

function toPublic(pools: YoutubeQuotaPools): YoutubeQuotaPoolsPublic {
  return {
    pools: Object.entries(pools.pools).map(([poolId, config]) => ({
      poolId,
      apiKeySlotCount: config.apiKeySecretNames.length,
      hasOauthClient: Boolean(config.oauthClientIdSecretName && config.oauthClientSecretSecretName),
    })),
    byOrgId: pools.byOrgId,
    crossBorrow: pools.crossBorrow,
    policyVersion: pools.policyVersion,
    updatedBy: pools.updatedBy,
    updatedAt: pools.updatedAt,
  };
}

export async function getYouTubeQuotaPools(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "youtube_quota_pools.list", ["super_admin", "admin"]);
  const pools = await readYouTubeQuotaPools();
  return {
    ok: true,
    pools: toPublic(pools),
    behaviorLog: makeBehaviorLog(auth, "youtube_quota_pools.list", "success", "global", 0),
  };
}

function poolConfigSecretNames(config: YoutubeQuotaPoolConfig): readonly string[] {
  return [...config.apiKeySecretNames, config.oauthClientIdSecretName, config.oauthClientSecretSecretName];
}

/**
 * 재리뷰 P1-2: 같은 시크릿 이름을 서로 다른 poolId가 공유하면, 한 풀 소속으로 believe하고 쓴 트래픽이
 * 실제로는 다른 풀의 GCP 프로젝트 쿼터를 조용히 소모한다(관리자 오타로 가장 발생하기 쉬운 사고 — 이미
 * 등록된 이름을 복붙). secretNameOwners는 "이 호출 시작 시점의 현재 문서" 기준으로 시작해, 같은 호출
 * 안에서 처리된 풀도 즉시 반영한다(같은 배치 안 두 신규 풀의 충돌도 잡는다). poolId 자신이 자기
 * 이름을 재사용하는 것(그대로 갱신)은 당연히 허용한다.
 */
function parseWritablePoolConfig(
  poolId: string,
  value: unknown,
  secretNameOwners: ReadonlyMap<string, string>,
): YoutubeQuotaPoolConfig {
  const record = asRecord(value);
  const apiKeySecretNames = Array.isArray(record.apiKeySecretNames) ? record.apiKeySecretNames : [];
  if (apiKeySecretNames.length === 0) {
    throw invalidArgument(`pools.${poolId}.apiKeySecretNames must be a non-empty array`);
  }
  const names: string[] = [];
  for (const name of apiKeySecretNames) {
    if (typeof name !== "string" || !API_KEY_SECRET_NAME_PATTERN.test(name)) {
      throw invalidArgument(`pools.${poolId}.apiKeySecretNames contains an unrecognized secret name: ${JSON.stringify(name)}`);
    }
    names.push(name);
  }
  const oauthClientIdSecretName = asString(record.oauthClientIdSecretName);
  const oauthClientSecretSecretName = asString(record.oauthClientSecretSecretName);
  if (!OAUTH_CLIENT_ID_SECRET_NAME_PATTERN.test(oauthClientIdSecretName)) {
    throw invalidArgument(`pools.${poolId}.oauthClientIdSecretName must match the allowed naming pattern`);
  }
  if (!OAUTH_CLIENT_SECRET_SECRET_NAME_PATTERN.test(oauthClientSecretSecretName)) {
    throw invalidArgument(`pools.${poolId}.oauthClientSecretSecretName must match the allowed naming pattern`);
  }
  const config: YoutubeQuotaPoolConfig = { apiKeySecretNames: names, oauthClientIdSecretName, oauthClientSecretSecretName };
  for (const name of poolConfigSecretNames(config)) {
    const owner = secretNameOwners.get(name);
    if (owner && owner !== poolId) {
      throw invalidArgument(`secret name ${JSON.stringify(name)} is already used by pool ${JSON.stringify(owner)}`);
    }
  }
  return config;
}

export async function setYouTubeQuotaPools(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "youtube_quota_pools.update", ["super_admin", "admin"]);
  const data = asRecord(request.data);
  const db = resolveMailAccountsDb();
  // Fresh (uncached) read-modify-write — same doctrine as functions/orgTabPresets.ts
  // setOrgTabPresets: the merge base must never be the process-local cache, or a concurrent
  // admin/instance's write within the last YOUTUBE_QUOTA_POOLS_CACHE_TTL_MS would be silently
  // dropped by this callable's full overwrite below.
  const current = await readYouTubeQuotaPoolsUncached(db);

  const pools: Record<string, YoutubeQuotaPoolConfig> = { ...current.pools };
  // 재리뷰 P1-2: 시크릿 이름 소유자 맵 — 처음엔 현재 저장된 풀들로 채우고, 이 호출 안에서 풀이
  // 성공적으로 파싱/삭제될 때마다 갱신한다(같은 배치의 두 번째 풀도 첫 번째 풀이 방금 등록한 이름과
  // 충돌하면 막힌다; 삭제된 풀의 이름은 즉시 재사용 가능해진다).
  const secretNameOwners = new Map<string, string>();
  for (const [existingPoolId, existingConfig] of Object.entries(current.pools)) {
    for (const name of poolConfigSecretNames(existingConfig)) secretNameOwners.set(name, existingPoolId);
  }
  const poolsInput = asRecord(data.pools);
  for (const [poolId, poolValue] of Object.entries(poolsInput)) {
    if (!POOL_ID_PATTERN.test(poolId)) throw invalidArgument(`invalid pool id: ${JSON.stringify(poolId)}`);
    if (poolValue === null) {
      if (poolId === YOUTUBE_GROWTH_POOL_ID) throw invalidArgument("the growth pool can never be deleted");
      delete pools[poolId];
      for (const [name, owner] of secretNameOwners) if (owner === poolId) secretNameOwners.delete(name);
      continue;
    }
    const config = parseWritablePoolConfig(poolId, poolValue, secretNameOwners);
    for (const name of poolConfigSecretNames(config)) secretNameOwners.set(name, poolId);
    pools[poolId] = config;
  }

  const byOrgId: Record<string, string> = { ...current.byOrgId };
  const byOrgIdInput = asRecord(data.byOrgId);
  for (const [orgId, poolIdValue] of Object.entries(byOrgIdInput)) {
    const trimmedOrgId = orgId.trim();
    if (!trimmedOrgId) throw invalidArgument("byOrgId keys must be non-empty org ids");
    if (poolIdValue === null) {
      delete byOrgId[trimmedOrgId];
      continue;
    }
    const poolId = asString(poolIdValue);
    if (!poolId || !(poolId in pools)) {
      throw invalidArgument(`byOrgId.${trimmedOrgId} must reference an existing pool id`);
    }
    byOrgId[trimmedOrgId] = poolId;
  }

  let crossBorrow = current.crossBorrow;
  if (data.crossBorrow !== undefined) {
    const crossBorrowInput = asRecord(data.crossBorrow);
    const lenderPoolId = asString(crossBorrowInput.lenderPoolId, current.crossBorrow.lenderPoolId);
    if (!(lenderPoolId in pools)) throw invalidArgument("crossBorrow.lenderPoolId must reference an existing pool id");
    crossBorrow = {
      enabled: crossBorrowInput.enabled === true,
      minLenderRemainingRatio: numberInRange(crossBorrowInput.minLenderRemainingRatio, current.crossBorrow.minLenderRemainingRatio, 0, 1),
      lenderPoolId,
      dailyBorrowCapCalls: Math.round(numberInRange(crossBorrowInput.dailyBorrowCapCalls, current.crossBorrow.dailyBorrowCapCalls, 0, 100_000)),
    };
  }

  const nowIso = new Date().toISOString();
  const next: YoutubeQuotaPools = {
    pools, byOrgId, crossBorrow,
    policyVersion: DEFAULT_YOUTUBE_QUOTA_POOLS_POLICY_VERSION,
    updatedBy: auth.userId,
    updatedAt: nowIso,
  };
  await db.doc(YOUTUBE_QUOTA_POOLS_DOC_PATH).set(
    {
      pools: Object.fromEntries(Object.entries(pools).map(([poolId, config]) => [poolId, { ...config }])),
      byOrgId,
      crossBorrow,
      policyVersion: next.policyVersion,
      updatedBy: next.updatedBy,
      updatedAt: next.updatedAt,
    },
    { merge: false },
  );
  clearYouTubeQuotaPoolsCache();

  return {
    ok: true,
    pools: toPublic(next),
    behaviorLog: makeBehaviorLog(auth, "youtube_quota_pools.update", "success", "global", 0),
  };
}
