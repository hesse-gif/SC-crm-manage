/**
 * D1 — Instagram Graph API `business_discovery` 이메일 접점 레인 (스캐폴드).
 *
 * ■ 왜 인스타그램인가
 *   게임 유튜버 후보의 이메일 접점 3사(Twitch/TikTok/Instagram) 중 **공식 API로 열람 가능한** 것은
 *   인스타그램뿐이다 — 비즈니스/크리에이터 계정의 `public_email` 은 Meta Graph API
 *   `business_discovery` 필드로 조회할 수 있다(Advanced Access + 앱 리뷰 + 비즈니스 인증 필요).
 *   수동 승인 절차는 docs/instagram-lane-setup.md 참고 — 승인이 병목이다.
 *
 * ■ 이 모듈의 경계 (NET-P0-012)
 *   Meta Graph API 로 나가는 외부 호출은 **이 모듈 안에서만** 만든다. 다른 레인·클라이언트가
 *   이 API 를 직접 부르지 않고 항상 이 Functions 모듈을 경유한다.
 *
 * ■ 스캐폴드 경계 (Karpathy: 작게)
 *   이번 범위는 클라이언트 함수 + 순수 판정 로직까지다. candidate_pool 배선, 큐/스케줄러/대량
 *   배치 오케스트레이션, functions/index.ts 등록은 후속(통합자) 범위다 — 여기서 만들지 않는다.
 *
 * ■ config 게이트
 *   `INSTAGRAM_GRAPH_ACCESS_TOKEN` / `INSTAGRAM_BUSINESS_ACCOUNT_ID` 가 하나라도 없으면
 *   `not_configured` 를 반환한다 — 배포돼도 무해하다(외부 호출을 시도하지 않는다).
 *
 * ■ 레이트리밋
 *   인스턴스 내 메모리 상태로만 가드한다(Cloud Functions 인스턴스 간 공유 없음 — 보수적 가드일
 *   뿐 정본 쿼터 계측이 아니다). 크로스 인스턴스 계측이 필요해지면 apiQuota.ts /
 *   communityDiscoveryThrottle.ts 컨벤션을 따라 Firestore 상태로 옮기는 게 후속 작업이다.
 */

const GRAPH_API_BASE_URL = "https://graph.facebook.com";
// 2026-08-22 기준 최신 안정 버전. Meta 는 버전을 주기적으로 폐기하므로 실제 배선 시점에
// docs/instagram-lane-setup.md 절차대로 재확인할 것.
const GRAPH_API_VERSION = "v21.0";

const USERNAME_PATTERN = /^[A-Za-z0-9._]{1,30}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// config 게이트
// ---------------------------------------------------------------------------

export type InstagramGraphConfig = {
  readonly accessToken: string;
  readonly businessAccountId: string;
};

export type InstagramGraphConfigStatus =
  | { readonly configured: true; readonly config: InstagramGraphConfig }
  | { readonly configured: false };

/** env 를 인자로 받는 순수 함수 — process.env 를 직접 읽는 건 fetchInstagramBusinessDiscovery 호출부뿐이다. */
export function resolveInstagramGraphConfig(
  env: Readonly<Record<string, string | undefined>>,
): InstagramGraphConfigStatus {
  const accessToken = (env.INSTAGRAM_GRAPH_ACCESS_TOKEN ?? "").trim();
  const businessAccountId = (env.INSTAGRAM_BUSINESS_ACCOUNT_ID ?? "").trim();
  if (!accessToken || !businessAccountId) return { configured: false };
  return { configured: true, config: { accessToken, businessAccountId } };
}

// ---------------------------------------------------------------------------
// 레이트리밋 가드 (보수적 상수 + 순수 판정)
// ---------------------------------------------------------------------------

export const INSTAGRAM_DISCOVERY_RATE_LIMITS = Object.freeze({
  /** 호출 간 최소 간격(ms). Meta 표준 등급 콜 버짓을 넘지 않도록 보수적으로 둔다. */
  minIntervalMs: 2_000,
  /** 시간당 상한. 앱 리뷰로 받는 초기 등급을 가정한 보수치 — 실측 등급이 확정되면 올린다. */
  maxCallsPerHour: 100,
});

export type InstagramDiscoveryRateLimitState = {
  readonly lastCallAtMs: number | null;
  readonly windowStartMs: number | null;
  readonly callsInWindow: number;
};

export const INITIAL_INSTAGRAM_DISCOVERY_RATE_LIMIT_STATE: InstagramDiscoveryRateLimitState = Object.freeze({
  lastCallAtMs: null,
  windowStartMs: null,
  callsInWindow: 0,
});

export type InstagramDiscoveryRateLimitDecision = {
  readonly allowed: boolean;
  readonly reason?: "min_interval" | "hourly_cap";
  readonly retryAfterMs: number;
};

function currentRateLimitWindow(
  state: InstagramDiscoveryRateLimitState,
  nowMs: number,
): { readonly windowStartMs: number; readonly callsInWindow: number } {
  if (state.windowStartMs !== null && nowMs - state.windowStartMs < RATE_LIMIT_WINDOW_MS) {
    return { windowStartMs: state.windowStartMs, callsInWindow: state.callsInWindow };
  }
  return { windowStartMs: nowMs, callsInWindow: 0 };
}

/** 호출을 지금 해도 되는지 판정한다(순수 함수 — Firestore/네트워크 없음). */
export function decideInstagramDiscoveryRateLimit(
  state: InstagramDiscoveryRateLimitState,
  nowMs: number,
  limits: typeof INSTAGRAM_DISCOVERY_RATE_LIMITS = INSTAGRAM_DISCOVERY_RATE_LIMITS,
): InstagramDiscoveryRateLimitDecision {
  if (state.lastCallAtMs !== null) {
    const sinceLastMs = nowMs - state.lastCallAtMs;
    if (sinceLastMs < limits.minIntervalMs) {
      return { allowed: false, reason: "min_interval", retryAfterMs: limits.minIntervalMs - sinceLastMs };
    }
  }
  const window = currentRateLimitWindow(state, nowMs);
  if (window.callsInWindow >= limits.maxCallsPerHour) {
    return {
      allowed: false,
      reason: "hourly_cap",
      retryAfterMs: Math.max(0, window.windowStartMs + RATE_LIMIT_WINDOW_MS - nowMs),
    };
  }
  return { allowed: true, retryAfterMs: 0 };
}

/** 호출 1건을 상태에 반영한다(순수 함수 — 호출부가 반환값을 다음 상태로 들고 다닌다). */
export function recordInstagramDiscoveryCall(
  state: InstagramDiscoveryRateLimitState,
  nowMs: number,
): InstagramDiscoveryRateLimitState {
  const window = currentRateLimitWindow(state, nowMs);
  return { lastCallAtMs: nowMs, windowStartMs: window.windowStartMs, callsInWindow: window.callsInWindow + 1 };
}

/** deps.rateLimitState 를 안 넘긴 기본 호출 경로가 쓰는 인스턴스 내 상태(위 "레이트리밋" 절 참고). */
let moduleRateLimitState: InstagramDiscoveryRateLimitState = INITIAL_INSTAGRAM_DISCOVERY_RATE_LIMIT_STATE;

// ---------------------------------------------------------------------------
// 이메일 정제 — discovery.ts plausibleEmail 과 같은 층위의 최소 재구현이다(import 아님).
// ---------------------------------------------------------------------------
// discovery.ts 는 이번 작업 수정 금지 대상이고 초대형 모듈이라, 여기서 import 하면 불필요한
// 결합·순환 위험만 생긴다. business_discovery 응답은 Meta 가 이미 비즈니스 계정으로 검증한
// 값이라 discovery.ts 급의 오염 방어(TLD 절단, 난독화 복원 등)까지는 필요 없다 — 최소
// 플레이스홀더 거르기 + 형태 검증만 한다.

// 리뷰 처방: 로컬파트 단독 블록리스트("test" 등)는 test@somecompany.com 같은 실계정을 과차단했다.
// discovery.ts plausibleEmail 관례대로 완전한 플레이스홀더 이메일 문자열 집합 + 도메인 단위로 거른다.
const PLACEHOLDER_EMAILS = new Set([
  "example@example.com", "test@test.com", "test@example.com", "name@email.com",
  "your@email.com", "someone@example.com", "user@domain.com", "email@example.com",
  "info@yourdomain.com", "yourname@email.com", "youremail@email.com", "me@me.com",
  "admin@admin.com",
]);
const PLACEHOLDER_EMAIL_DOMAINS = new Set([
  "example.com", "email.com", "yourdomain.com", "domain.com", "test.com", "mail.com",
]);

export function sanitizeInstagramPublicEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1 || email.indexOf("@", at + 1) !== -1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return null;
  if (PLACEHOLDER_EMAILS.has(email) || PLACEHOLDER_EMAIL_DOMAINS.has(domain)) return null;
  if (!/^[a-z0-9._%+-]+$/.test(local)) return null;
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (!/^[a-z]{2,24}$/.test(tld)) return null;
  return email;
}

// ---------------------------------------------------------------------------
// 응답 파싱
// ---------------------------------------------------------------------------

export type InstagramBusinessDiscoveryProfile = {
  readonly username: string;
  readonly website: string | null;
  readonly email: string | null;
  readonly followersCount: number | null;
  readonly mediaCount: number | null;
};

/**
 * `GET /{ig-user-id}?fields=business_discovery.username({username}){...}` 응답 바디를 파싱한다.
 * 기대 형태: `{ business_discovery: { username, website?, public_email?, followers_count?, media_count? } }`.
 */
export function parseInstagramBusinessDiscoveryResponse(body: unknown): InstagramBusinessDiscoveryProfile | null {
  if (!body || typeof body !== "object") return null;
  const discovery = (body as Record<string, unknown>).business_discovery;
  if (!discovery || typeof discovery !== "object") return null;
  const record = discovery as Record<string, unknown>;
  const username = typeof record.username === "string" && record.username.trim() ? record.username.trim() : null;
  if (!username) return null;
  return {
    username,
    website: typeof record.website === "string" && record.website.trim() ? record.website.trim() : null,
    email: sanitizeInstagramPublicEmail(record.public_email),
    followersCount:
      typeof record.followers_count === "number" && Number.isFinite(record.followers_count)
        ? record.followers_count
        : null,
    mediaCount:
      typeof record.media_count === "number" && Number.isFinite(record.media_count) ? record.media_count : null,
  };
}

// ---------------------------------------------------------------------------
// 호출 URL 빌더
// ---------------------------------------------------------------------------

/** Instagram 사용자명 문자셋(영숫자·점·언더스코어)만 허용 — fields 표현식에 직접 삽입되므로 검증이 곧 방어다. */
export function isValidInstagramUsername(value: string): boolean {
  return USERNAME_PATTERN.test(value);
}

export function instagramBusinessDiscoveryUrl(config: InstagramGraphConfig, username: string): string | null {
  if (!isValidInstagramUsername(username)) return null;
  const fields = `business_discovery.username(${username}){username,website,public_email,followers_count,media_count}`;
  const params = new URLSearchParams({ fields, access_token: config.accessToken });
  return `${GRAPH_API_BASE_URL}/${GRAPH_API_VERSION}/${config.businessAccountId}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// 호출·결과 로그 (COST-P0-006 결: 호출 수·성공/실패 카운트)
// ---------------------------------------------------------------------------

export type InstagramDiscoveryCallOutcome =
  | "success"
  | "not_configured"
  | "invalid_username"
  | "rate_limited"
  | "http_error"
  | "timeout"
  | "parse_error";

export type InstagramDiscoveryCallLogEntry = {
  readonly outcome: InstagramDiscoveryCallOutcome;
  readonly atIso: string;
};

export function summarizeInstagramDiscoveryCallLogs(entries: readonly InstagramDiscoveryCallLogEntry[]): {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly byOutcome: Record<InstagramDiscoveryCallOutcome, number>;
} {
  const byOutcome: Record<InstagramDiscoveryCallOutcome, number> = {
    success: 0,
    not_configured: 0,
    invalid_username: 0,
    rate_limited: 0,
    http_error: 0,
    timeout: 0,
    parse_error: 0,
  };
  for (const entry of entries) byOutcome[entry.outcome] += 1;
  const total = entries.length;
  return { total, succeeded: byOutcome.success, failed: total - byOutcome.success, byOutcome };
}

function logInstagramDiscoveryCall(outcome: InstagramDiscoveryCallOutcome, message?: string): void {
  console.log("[instagram-business-discovery] call", {
    outcome,
    atIso: new Date().toISOString(),
    ...(message ? { message } : {}),
  });
}

// ---------------------------------------------------------------------------
// 메인 엔트리 포인트 (네트워크 호출 — 테스트는 fetchImpl 을 주입해 실제 호출 없이 검증한다)
// ---------------------------------------------------------------------------

export type InstagramBusinessDiscoveryDeps = {
  readonly fetchImpl?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly nowMs?: number;
  readonly rateLimitState?: InstagramDiscoveryRateLimitState;
  readonly timeoutMs?: number;
};

export type InstagramBusinessDiscoveryResult =
  | { readonly status: "not_configured" }
  | { readonly status: "invalid_username" }
  | { readonly status: "rate_limited"; readonly retryAfterMs: number }
  | { readonly status: "http_error"; readonly httpStatus: number }
  | { readonly status: "parse_error" }
  | { readonly status: "success"; readonly profile: InstagramBusinessDiscoveryProfile };

/**
 * 인스타그램 비즈니스/크리에이터 계정의 business_discovery 를 조회한다.
 * config 가 없으면 즉시 not_configured 다 — 배포돼도 무해하다.
 * deps 를 넘기지 않으면 process.env / 전역 fetch / 모듈 레이트리밋 상태(인스턴스 내 메모리)를 쓴다.
 */
export async function fetchInstagramBusinessDiscovery(
  username: string,
  deps: InstagramBusinessDiscoveryDeps = {},
): Promise<InstagramBusinessDiscoveryResult> {
  const configStatus = resolveInstagramGraphConfig(deps.env ?? process.env);
  if (!configStatus.configured) {
    logInstagramDiscoveryCall("not_configured");
    return { status: "not_configured" };
  }

  const url = instagramBusinessDiscoveryUrl(configStatus.config, username);
  if (!url) {
    logInstagramDiscoveryCall("invalid_username");
    return { status: "invalid_username" };
  }

  const nowMs = deps.nowMs ?? Date.now();
  const usingSharedState = deps.rateLimitState === undefined;
  const rateLimitState = deps.rateLimitState ?? moduleRateLimitState;
  const decision = decideInstagramDiscoveryRateLimit(rateLimitState, nowMs);
  if (!decision.allowed) {
    logInstagramDiscoveryCall("rate_limited");
    return { status: "rate_limited", retryAfterMs: decision.retryAfterMs };
  }
  if (usingSharedState) moduleRateLimitState = recordInstagramDiscoveryCall(rateLimitState, nowMs);

  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      logInstagramDiscoveryCall("http_error");
      return { status: "http_error", httpStatus: response.status };
    }
    const body = await response.json();
    const profile = parseInstagramBusinessDiscoveryResponse(body);
    if (!profile) {
      logInstagramDiscoveryCall("parse_error");
      return { status: "parse_error" };
    }
    logInstagramDiscoveryCall("success");
    return { status: "success", profile };
  } catch (err) {
    // 리뷰 처방: 타임아웃(위 AbortController)이 다른 네트워크 오류와 같은 outcome으로 뭉개져
    // 있었다 — AbortError 는 별도 outcome으로 로그하고 err.message 를 남긴다.
    if (err instanceof Error && err.name === "AbortError") {
      logInstagramDiscoveryCall("timeout", err.message);
    } else {
      logInstagramDiscoveryCall("http_error");
    }
    return { status: "http_error", httpStatus: 0 };
  } finally {
    clearTimeout(timer);
  }
}
