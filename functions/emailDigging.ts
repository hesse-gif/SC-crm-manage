/**
 * email-digging (2026-10-02, owner: Hesse) — **무이메일 후보의 이메일 보충 스윕.**
 *
 * ■ 왜 (프로드 실측 2026-10-02)
 *   XP 채널 28,902 중 15,833(54.8%)이 이메일이 없다. 저장된 설명란 재파싱은 난독화 보강 후에도 4건뿐이라
 *   텍스트 파서는 포화다. 남은 **공식·허용 경로**는 셋이다:
 *     ① 설명란 재파싱(오프라인, 파서가 바뀐 뒤 재시도)             — 네트워크 0
 *     ② 같은 채널의 다른 문서가 이미 가진 주소 재사용(cross_source)  — Firestore 읽기만
 *     ③ 설명란이 **직접 링크한** allowlist 링크인바이오 페이지(linktr.ee 등)의 공개 mailto/텍스트
 *   YouTube About 탭 이메일은 캡차 뒤라 여기서 건드리지 않는다(Apify 경로는 T049 org 한정 헤세 결정).
 *
 * ■ ③ 은 **기본 꺼짐**이다 (ToS 검토 2026-10-02, Astra Ultra 자문)
 *   Linktree 이용약관 §13 은 자동화된 프로필 수집을 금지하고 robots.txt 도 `User-agent: * / Disallow: /` 이며,
 *   Beacons 약관도 스크레이핑을 금지한다. "공개 페이지"는 허락이 아니다. 그래서 수집기·SSRF/robots 가드는
 *   갖추되 **승인된 호스트 집합(LINK_IN_BIO_APPROVED_HOSTS)이 비어 있어** 어떤 URL 도 선택되지 않는다.
 *   호스트를 켜려면 그 제공자의 약관/허락을 검토한 뒤 코드로 추가해야 한다(요청 파라미터로는 못 켠다).
 *
 * ■ 경계 (AGENTS.md P0)
 *   · NET-P0-012: 외부 호출은 이 Functions 모듈 안에서만 — 클라이언트는 callable 만 부른다.
 *   · SSRF: https 만, 포트 없음, 자격증명 없음, **정확한 호스트 allowlist**(IP 리터럴·임의 도메인 불가),
 *     리다이렉트는 수동으로 따라가며 **매 홉마다 allowlist 재검증**(최대 2홉), DNS 해석 결과가
 *     사설/루프백/링크로컬이면 거부.
 *   · ToS: robots.txt 를 **페이지보다 먼저** 읽고(5xx·네트워크 오류 = 전면 불허, 4xx = 제한 없음 — RFC 9309)
 *     Disallow 면 가져오지 않는다. 식별 가능한 UA, 호스트당 간격, 호출 상한, 본문 512KB 상한.
 *   · COST: 유료 API 0(YouTube 유닛 0). 가져온 요청 수를 감사 문서·응답 costLog 로 남긴다. URL 별 결과
 *     캐시(7일)로 같은 페이지를 되풀이해 치지 않는다.
 *   · SEC-P0-009: 감사/로그/응답에 이메일 원문·설명 원문을 싣지 않는다 — 건수와 사유 코드만.
 *   · 이 스윕은 **메일을 보내지 않는다.** 후보 문서의 이메일 필드와 시도 마커만 쓴다. 발송 게이트
 *     (draft_only·human gate·억제·역할계정)는 그대로 뒤에서 다시 막는다.
 *
 * ■ 재개/안전
 *   · 커서(`email_digging_state/*`)는 **처리한 마지막 문서 id** — 한도에서 멈춰도 다음 호출이 이어간다.
 *   · 시도 마커 `emailDiggingVersion` + `emailDiggingAttemptedAtIso` — 파서/소스가 개선되어 VERSION 이 오르면
 *     전부 다시 대상이 되고, 같은 VERSION 은 RETRY 간격 안에서 건너뛴다(쿼리 축이 아니라 판정 필드).
 *   · apply 는 단일 비행 리스. 신규 문서는 절대 만들지 않는다(update 만 — 없는 문서는 실패 = 안전).
 */
import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebaseAdmin";
import { createEmailSourceGate, filterByEmailSource, type SourceGateReason } from "./emailSourceGate";
import { extractEmailsBoundarySafe, extractEmailsDeep, extractEmailsForDiscovery, foldStyledEmailText, isBusinessEmail } from "./discovery";
import type { EmailSourceKind } from "./discoveryEconomics";
import { findMailSuppression } from "./mailSuppression";
import { ROLE_ACCOUNT_PREFIXES, rolePrefix } from "./mailSafetyPolicy";
import { actorUidHash } from "./autoReplyBacklog";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  makeBehaviorLog,
  makeDeniedBehaviorLog,
  type CallableRequestShape,
} from "./shared";

export const EMAIL_DIGGING_VERSION = 1;
export const EMAIL_DIGGING_RUNS_COLLECTION = "email_digging_runs";
export const EMAIL_DIGGING_STATE_COLLECTION = "email_digging_state";
export const EMAIL_DIGGING_URL_CACHE_COLLECTION = "email_digging_url_cache";
const AUDIT_ACTION = "email_digging.backfill";

export const EMAIL_DIGGING_LIMITS = Object.freeze({
  defaultLimit: 100,
  maxLimit: 300,
  scanPageSize: 300,
  maxScanPages: 6,
  defaultMaxFetches: 40,
  maxFetchesCap: 100,
  deadlineMs: 240_000,
  retryAfterMs: 14 * 24 * 60 * 60 * 1000,
  urlCacheTtlMs: 7 * 24 * 60 * 60 * 1000,
  fetchTimeoutMs: 3_000,
  maxBodyBytes: 512 * 1024,
  maxRedirects: 2,
  hostGapMs: 5_000,
  leaseMs: 300_000,
  maxLinksPerChannel: 2,
});

// ---------------------------------------------------------------------------
// ③ 링크인바이오: URL 선택 + SSRF 가드
// ---------------------------------------------------------------------------

/**
 * **검토 대상 후보** 호스트(승인 아님). 음악 스마트링크(lnk.to·fanlink.to)는 이메일이 없어 뺀다.
 * 실제로 가져오는 호스트는 아래 LINK_IN_BIO_APPROVED_HOSTS 에 **명시적으로** 넣은 것뿐이다.
 */
export const LINK_IN_BIO_HOSTS: readonly string[] = [
  "linktr.ee", "beacons.ai", "bio.link", "lnk.bio", "lit.link", "solo.to", "stan.store", "campsite.bio",
  "allmylinks.com", "taplink.cc", "hoo.be", "direct.me", "bio.site", "linkbio.co", "heylink.me", "potofu.me",
];
/** `*.<suffix>` 서브도메인 개인 페이지(후보). */
export const LINK_IN_BIO_SUFFIX_HOSTS: readonly string[] = ["carrd.co"];
/**
 * 약관·허락 검토를 통과해 **가져와도 되는** 호스트. 기본은 비어 있다(위 ToS 메모) — 비어 있으면 ③ 은
 * 아무 URL 도 고르지 않고 네트워크 호출이 0이다. 값은 LINK_IN_BIO_HOSTS 의 정확 일치 호스트 또는
 * `*.carrd.co` 형 접미사 표기(`.carrd.co`)만 허용한다.
 */
export const LINK_IN_BIO_APPROVED_HOSTS: readonly string[] = [];
/** 이 도메인의 주소는 크리에이터 것이 아니라 플랫폼/계측 것이다. */
const PLATFORM_NOISE_DOMAINS: readonly string[] = [
  ...LINK_IN_BIO_HOSTS, ...LINK_IN_BIO_SUFFIX_HOSTS, "linktree.com", "sentry.io", "wixpress.com",
  "cloudfront.net", "amazonaws.com", "w3.org", "schema.org", "googleapis.com", "gstatic.com",
];

const URL_IN_TEXT_PATTERN = /(?:https?:\/\/|(?<![\w@.-]))(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"'`)\]]*)?/gi;

export function isAllowedLinkInBioHost(hostname: string, approved: readonly string[] = LINK_IN_BIO_APPROVED_HOSTS): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || isIP(host) !== 0 || host.includes(":")) return false;
  if (LINK_IN_BIO_HOSTS.includes(host) && approved.includes(host)) return true;
  return LINK_IN_BIO_SUFFIX_HOSTS.some((suffix) =>
    approved.includes(`.${suffix}`) && host.endsWith(`.${suffix}`) && host.length > suffix.length + 1);
}

/** 안전한 https 링크인바이오 URL 만 돌려준다(아니면 null). 리다이렉트 홉마다 다시 호출된다. */
export function parseSafeLinkInBioUrl(raw: string, approved: readonly string[] = LINK_IN_BIO_APPROVED_HOSTS): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  if (!isAllowedLinkInBioHost(url.hostname, approved)) return null;
  if (url.href.length > 300) return null;
  url.hash = "";
  return url;
}

/** 설명란에서 링크인바이오 URL 을 고른다(채널당 상한, 중복 제거, 스킴 없는 표기는 https 로). */
export function selectLinkInBioUrls(
  description: string,
  approved: readonly string[] = LINK_IN_BIO_APPROVED_HOSTS,
  max = EMAIL_DIGGING_LIMITS.maxLinksPerChannel,
): string[] {
  const picked: string[] = [];
  if (approved.length === 0) return picked;
  for (const match of description.matchAll(URL_IN_TEXT_PATTERN)) {
    const raw = match[0].replace(/[.,;:!?]+$/, "");
    const url = parseSafeLinkInBioUrl(/^https?:\/\//i.test(raw) ? raw.replace(/^http:\/\//i, "https://") : `https://${raw}`, approved);
    if (!url) continue;
    // 프로필 경로가 없는 루트(https://linktr.ee/)는 페이지가 아니다(carrd 서브도메인은 루트가 페이지).
    if (url.pathname === "/" && !url.hostname.endsWith(".carrd.co")) continue;
    if (!picked.includes(url.href)) picked.push(url.href);
    if (picked.length >= max) break;
  }
  return picked;
}

/** IPv6 문자열을 8개 16비트 그룹으로 푼다(`::` 압축·내장 IPv4 포함). 형식이 틀리면 null. */
function expandIpv6(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const embedded = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) {
    const octets = embedded[2].split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    text = `${embedded[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a >= 224) return false;
    return true;
  }
  if (family === 6) {
    const groups = expandIpv6(address);
    if (!groups) return false;
    // IPv4-mapped(::ffff:a.b.c.d / ::ffff:aabb:ccdd) 는 내장 IPv4 로 판정한다 — 16진 표기도 같은 주소다.
    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
      return isPublicIpAddress(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`);
    }
    // 글로벌 유니캐스트(2000::/3)만 인정한다. 루프백·ULA·링크로컬·멀티캐스트·NAT64·IPv4-호환은 전부 여기서 걸러진다.
    if (groups[0] < 0x2000 || groups[0] > 0x3fff) return false;
    if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false; // 문서용
    if (groups[0] === 0x2002) return false; // 6to4 — 내장 IPv4 를 신뢰하지 않는다
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// robots.txt (RFC 9309 의 필요한 부분만)
// ---------------------------------------------------------------------------

export const EMAIL_DIGGING_USER_AGENT = "FluContactDiscovery/1.0 (+https://sc-flu.web.app; creator-contact-lookup)";
const ROBOTS_PRODUCT_TOKEN = "flucontactdiscovery";

/** RFC 9309 §2.2.2: 비예약 문자의 퍼센트 인코딩은 풀고, 나머지 16진수는 대문자로 맞춘다(`/%70rivate` == `/private`). */
export function canonicalRobotsPath(value: string): string {
  return value.replace(/%([0-9a-fA-F]{2})/g, (_whole, hex: string) => {
    const code = parseInt(hex, 16);
    const ch = String.fromCharCode(code);
    return /[A-Za-z0-9\-._~]/.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
}

function robotsPatternToRegExp(pattern: string): RegExp {
  const canonical = canonicalRobotsPath(pattern);
  const anchored = canonical.endsWith("$");
  const body = (anchored ? canonical.slice(0, -1) : canonical)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** robots.txt 본문과 경로(+쿼리)로 허용 여부를 판정한다. 가장 긴 매치가 이기고 동률이면 Allow. */
export function isPathAllowedByRobots(robotsTxt: string, rawPathWithQuery: string): boolean {
  const pathWithQuery = canonicalRobotsPath(rawPathWithQuery);
  type Group = { agents: string[]; rules: Array<{ allow: boolean; pattern: string }> };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow") current.rules.push({ allow: true, pattern: value });
    else if (field === "disallow") current.rules.push({ allow: false, pattern: value });
  }
  const specific = groups.filter((group) => group.agents.some((agent) => agent !== "*" && ROBOTS_PRODUCT_TOKEN.includes(agent)));
  const chosen = specific.length > 0 ? specific : groups.filter((group) => group.agents.includes("*"));
  let best: { allow: boolean; length: number } | null = null;
  for (const group of chosen) {
    for (const rule of group.rules) {
      if (!rule.pattern) continue; // 빈 Disallow = 제한 없음
      if (!robotsPatternToRegExp(rule.pattern).test(pathWithQuery)) continue;
      const length = rule.pattern.length;
      if (!best || length > best.length || (length === best.length && rule.allow)) best = { allow: rule.allow, length };
    }
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------------------
// 페이지 가져오기
// ---------------------------------------------------------------------------

export type LinkPageOutcome =
  | "ok"
  | "no_email"
  | "unsafe_url"
  | "blocked_robots"
  | "unsafe_address"
  | "http_error"
  | "not_html"
  | "too_large"
  | "fetch_error";

export type PinnedFetchInit = RequestInit & {
  /** 검증을 통과한 주소 — 전송 계층이 **이 주소로만** 연결한다(DNS 재해석·리바인딩 차단). */
  readonly pinnedAddress?: string;
};

export type LinkPageFetchDeps = {
  readonly fetchImpl: (input: string, init: PinnedFetchInit) => Promise<Response>;
  readonly resolveHost: (hostname: string) => Promise<readonly string[]>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** 가져와도 되는 호스트(기본 LINK_IN_BIO_APPROVED_HOSTS = 비어 있음). 홉마다 재검증에 쓴다. */
  readonly approvedHosts?: readonly string[];
};

/**
 * 검증된 주소로 **고정 연결**하는 HTTPS GET. 전역 fetch 는 호스트명을 다시 해석하므로 검증과 연결 사이에
 * DNS 리바인딩 틈이 생긴다 — 여기서는 `lookup` 을 고정 주소로 덮어 TLS SNI/인증서 검증은 URL 호스트명으로
 * 유지하면서 연결 대상만 고정한다. 압축 협상은 끄고(identity) 본문 상한은 호출부가 스트림에서 센다.
 */
export function pinnedHttpsFetch(input: string, init: PinnedFetchInit = {}): Promise<Response> {
  const url = new URL(input);
  const pinned = init.pinnedAddress;
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = { "accept-encoding": "identity" };
    new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    const request = https.request(url, {
      method: init.method ?? "GET",
      headers,
      ...(init.signal ? { signal: init.signal } : {}),
      ...(pinned
        ? {
          lookup: ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
            if (options?.all) callback(null, [{ address: pinned, family: isIP(pinned) }]);
            else callback(null, pinned, isIP(pinned));
          }) as never,
        }
        : {}),
    }, (res) => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value !== undefined) responseHeaders.append(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const status = res.statusCode ?? 0;
      const bodyless = status === 204 || status === 205 || status === 304;
      if (bodyless) res.resume();
      resolve(new Response(bodyless ? null : (Readable.toWeb(res) as unknown as ReadableStream), { status, headers: responseHeaders }));
    });
    request.on("error", reject);
    request.end();
  });
}

export function defaultLinkPageFetchDeps(): LinkPageFetchDeps {
  return {
    fetchImpl: pinnedHttpsFetch,
    resolveHost: async (hostname) => (await dns.lookup(hostname, { all: true })).map((entry) => entry.address),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

type RobotsEntry = { readonly text: string | null; readonly denyAll: boolean };

export type LinkPageFetcher = {
  fetchPage(rawUrl: string): Promise<{ outcome: LinkPageOutcome; html: string; host: string }>;
  /** 실제로 나간 HTTP 요청 수(robots·리다이렉트 홉 포함) — costLog/감사용. */
  readonly requests: () => number;
  /** 페이지(robots 제외) 시도 수 — 호출 상한 판정용. */
  readonly pageFetches: () => number;
};

async function readBodyCapped(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) {
    const whole = await response.text();
    return { text: whole.slice(0, maxBytes), truncated: whole.length > maxBytes };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let received = 0;
  let text = "";
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (received > maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return { text: (text + decoder.decode()).slice(0, maxBytes), truncated };
}

export function createLinkPageFetcher(deps: LinkPageFetchDeps = defaultLinkPageFetchDeps()): LinkPageFetcher {
  const approved = deps.approvedHosts ?? LINK_IN_BIO_APPROVED_HOSTS;
  const robotsByHost = new Map<string, RobotsEntry>();
  const lastRequestAtByHost = new Map<string, number>();
  let requestCount = 0;
  let pageCount = 0;

  type GuardedResult =
    | { kind: "response"; response: Response; finalUrl: URL; release: () => void }
    | { kind: "unsafe_url" | "unsafe_address" | "fetch_error" | "blocked_robots" };

  /**
   * 홉마다: allowlist → robots(요청 시) → DNS 해석·공개 주소 검증 → 호스트 간격 → **고정 주소**로 요청.
   * 타임아웃은 본문을 다 읽을 때까지 유지된다(`release()` 가 끌 때까지) — 느린 본문이 무한정 매달리지 못한다.
   */
  async function guardedGet(start: URL, accept: string, robotsAllows?: (url: URL) => Promise<boolean>): Promise<GuardedResult> {
    let url = start;
    for (let hop = 0; hop <= EMAIL_DIGGING_LIMITS.maxRedirects; hop += 1) {
      const safe = parseSafeLinkInBioUrl(url.href, approved);
      if (!safe) return { kind: "unsafe_url" };
      if (robotsAllows && !(await robotsAllows(safe))) return { kind: "blocked_robots" };
      let addresses: readonly string[];
      try {
        // DNS 도 fetch 와 같은 시간 예산 안이다 — 멈춘 리졸버가 실행 마감 검사까지 붙잡지 못한다.
        addresses = await Promise.race([
          deps.resolveHost(safe.hostname),
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("dns_timeout")), EMAIL_DIGGING_LIMITS.fetchTimeoutMs)),
        ]);
      } catch {
        return { kind: "fetch_error" };
      }
      if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address))) return { kind: "unsafe_address" };
      const wait = (lastRequestAtByHost.get(safe.hostname) ?? 0) + EMAIL_DIGGING_LIMITS.hostGapMs - deps.now();
      if (wait > 0) await deps.sleep(wait);
      lastRequestAtByHost.set(safe.hostname, deps.now());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), EMAIL_DIGGING_LIMITS.fetchTimeoutMs);
      const release = () => clearTimeout(timer);
      try {
        requestCount += 1;
        const response = await deps.fetchImpl(safe.href, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { accept, "user-agent": EMAIL_DIGGING_USER_AGENT },
          pinnedAddress: addresses[0],
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel().catch(() => undefined);
          release();
          if (!location) return { kind: "fetch_error" };
          try {
            url = new URL(location, safe);
          } catch {
            return { kind: "unsafe_url" };
          }
          continue; // 다음 홉에서 allowlist·robots·주소 검증을 처음부터 다시 한다
        }
        return { kind: "response", response, finalUrl: safe, release };
      } catch {
        release();
        return { kind: "fetch_error" };
      }
    }
    return { kind: "fetch_error" };
  }

  async function robotsFor(origin: URL): Promise<RobotsEntry> {
    const cached = robotsByHost.get(origin.hostname);
    if (cached) return cached;
    const result = await guardedGet(new URL("/robots.txt", origin), "text/plain");
    let entry: RobotsEntry;
    if (result.kind !== "response") {
      entry = { text: null, denyAll: true }; // 읽을 수 없으면 보수적으로 불허
    } else {
      try {
        if (result.response.status >= 500) {
          await result.response.body?.cancel().catch(() => undefined);
          entry = { text: null, denyAll: true };
        } else if (result.response.status >= 400) {
          await result.response.body?.cancel().catch(() => undefined);
          entry = { text: "", denyAll: false }; // 4xx = robots 없음 = 제한 없음
        } else {
          const robotsBody = await readBodyCapped(result.response, 128 * 1024).catch(() => null);
          // 읽다 만 robots 는 신뢰하지 않는다 — 보수적으로 불허.
          entry = robotsBody && !robotsBody.truncated ? { text: robotsBody.text, denyAll: false } : { text: null, denyAll: true };
        }
      } finally {
        result.release();
      }
    }
    robotsByHost.set(origin.hostname, entry);
    return entry;
  }

  const robotsAllows = async (url: URL): Promise<boolean> => {
    const robots = await robotsFor(url);
    return !(robots.denyAll || (robots.text !== null && !isPathAllowedByRobots(robots.text, `${url.pathname}${url.search}`)));
  };

  return {
    requests: () => requestCount,
    pageFetches: () => pageCount,
    async fetchPage(rawUrl) {
      const url = parseSafeLinkInBioUrl(rawUrl, approved);
      if (!url) return { outcome: "unsafe_url", html: "", host: "" };
      pageCount += 1;
      // robots 는 **요청하는 모든 홉**(같은 호스트 리다이렉트 포함)의 경로 기준으로 먼저 확인한다.
      const result = await guardedGet(url, "text/html,application/xhtml+xml", robotsAllows);
      if (result.kind === "blocked_robots") return { outcome: "blocked_robots", html: "", host: url.hostname };
      if (result.kind !== "response") return { outcome: result.kind, html: "", host: url.hostname };
      const { response, finalUrl, release } = result;
      try {
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return { outcome: "http_error", html: "", host: finalUrl.hostname };
        }
        const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
        if (contentType && !contentType.includes("html") && !contentType.includes("xml")) {
          await response.body?.cancel().catch(() => undefined);
          return { outcome: "not_html", html: "", host: finalUrl.hostname };
        }
        // 상한에서 잘린 페이지는 "이메일 없음"의 근거가 못 된다 — 성공으로 취급하지 않는다.
        const body = await readBodyCapped(response, EMAIL_DIGGING_LIMITS.maxBodyBytes);
        if (body.truncated) return { outcome: "too_large", html: "", host: finalUrl.hostname };
        return { outcome: "ok", html: body.text, host: finalUrl.hostname };
      } catch {
        return { outcome: "fetch_error", html: "", host: finalUrl.hostname };
      } finally {
        release();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 페이지 → 이메일
// ---------------------------------------------------------------------------

function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

function isPlatformNoiseEmail(email: string): boolean {
  const domain = emailDomain(email);
  return PLATFORM_NOISE_DOMAINS.some((noise) => domain === noise || domain.endsWith(`.${noise}`));
}

/**
 * 링크인바이오 HTML 에서 이메일 후보를 뽑는다(순수). 공개 `mailto:` 링크와 가시 텍스트만 본다.
 * 계측·번들 스크립트(sentry DSN 등)는 버리되 Next.js 데이터 JSON(`__NEXT_DATA__`)과 ld+json 은 본다.
 */
const MAILTO_GATE_CAP = 50;

export function emailsFromLinkPageHtml(html: string, onGateReject?: (reason: SourceGateReason) => void): string[] {
  if (!html) return [];
  const unescaped = html
    .replace(/\\u0040/gi, "@")
    .replace(/\\u002e/gi, ".")
    .replace(/\\\//g, "/")
    .replace(/&#64;|&#x40;|&commat;/gi, "@")
    .replace(/&amp;/g, "&");
  const found: string[] = [];
  let mailtoSeen = 0;
  for (const match of unescaped.matchAll(/mailto:([^"'\s<>?&\\]+)/gi)) {
    let decoded = match[1] ?? "";
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // 퍼센트 인코딩이 깨졌으면 원문을 그대로 검증에 맡긴다
    }
    // 쓰기 게이트: 속성값이 공백/`&` 에서 잘린 뒤의 이어짐(`mailto:a@gmail.com dot vn`, `…&#46;vn`)이 보이도록 **뒤쪽 원문 전체**를
    // 붙여 정규화·대조한다(미리 자르지 않는다). 한 페이지에서 서로 다른 mailto 는 MAILTO_GATE_CAP 개까지만 본다.
    const attrEnd = (match.index ?? 0) + match[0].length;
    const mailtoCandidates = extractEmailsBoundarySafe(decoded);
    if (mailtoCandidates.length === 0 || ++mailtoSeen > MAILTO_GATE_CAP) continue;
    found.push(...filterByEmailSource(mailtoCandidates, createEmailSourceGate(`${decoded}${unescaped.slice(attrEnd)}`), onGateReject));
  }
  const keptData: string[] = [];
  const withoutScripts = unescaped.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_whole, attrs: string, body: string) => {
    if (/id=["']__NEXT_DATA__["']|application\/ld\+json/i.test(attrs)) keptData.push(body);
    return " ";
  });
  const visible = `${withoutScripts.replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")}\n${keptData.join("\n")}`;
  found.push(...filterByEmailSource(extractEmailsBoundarySafe(visible), createEmailSourceGate(visible), onGateReject));
  const unique: string[] = [];
  for (const email of found) {
    if (isPlatformNoiseEmail(email) || unique.includes(email)) continue;
    unique.push(email);
  }
  return unique;
}

/** 크리에이터 본인에게 연락하라는 단서(같은 줄 또는 바로 앞줄). */
const CONTACT_CUE_PATTERN = /business|inquir|enquir|collab|contact|e-?mail|mail me|booking|management|sponsor(?:ship)?s? (?:inquir|enquir|contact)|promo(?:tion)?s?\b|partnership|press|biz\b|contato|negocio|comercial|parceria|contacto|colaboraci|문의|제휴|협업|협찬|비즈니스|이메일|お仕事|依頼|お問い合わせ|ご連絡|メール|商务|合作|联系|邮箱/i;
/** 제3자(음악·편집·스폰서·협찬 표기) 크레딧 단서 — 같은 줄에 있으면 그 주소는 크리에이터 연락처가 아니다. */
const THIRD_PARTY_CUE_PATTERN = /music by|music in this video|music:|song by|song:|track by|track:|artist:|soundtrack|\bbgm\b|\bost\b|featuring|\bfeat\.|\bft\.|beat by|produced by|prod\.? by|edit(?:ed)? by|editor|thumbnail by|art by|artwork|logo by|credits?\b|sponsored by|presented by|powered by|courtesy|footage|intro by|outro by|licen[sc]e|royalty|copyright|©|designed by|animated by|voice (?:by|actor)|narrated by|cover by|original by|remix|mixed by|mastered by|composer|songwriter|label\b|음악|브금|배경음악|작곡|曲|音楽|作曲/i;

/** 주소 표기(평문·대소문자 무관·`[at]`/`(at)`/`at … dot` 난독화)를 문장에서 걷어낸다 — 단서 판정 전용. */
function stripAddressText(text: string): string {
  // **주소 구간만** 가린다 — 주변 단어·구두점("Music by:")은 보존한다. 평문, `[at]`/`(at)` 난독화(다중 `[dot]`), 공백형
  // `name at host dot tld dot tld`, 공백 낀 `name @ host` 를 각각의 토크나이저와 같은 모양으로 가린다.
  return text
    .replace(/[a-z0-9._%+-]+\s*[\[\(\{<]\s*(?:at|@)\s*[\]\)\}>]\s*[a-z0-9-]+(?:\s*(?:[\[\(\{<]\s*(?:dot|\.)\s*[\]\)\}>]|\.)\s*[a-z0-9-]+)*/gi, " ")
    .replace(/[a-z0-9._%+-]+\s+at\s+[a-z0-9-]+(?:\s+dot\s+[a-z0-9-]+)+/gi, " ")
    .replace(/[a-z0-9._%+-]+\s+@\s+[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi, " ")
    // 심층 추출의 추가 표기: 일본어 アットマーク, 공백으로 떨어진 `@`/`at`.
    .replace(/[a-z0-9._%+-]+\s*[\[\(\{<]?\s*(?:アットマーク|アット|あっとまーく)\s*[\]\)\}>]?\s*[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi, " ")
    .replace(/[a-z0-9._%+-]+\s+(?:@|at)\s+[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi, " ")
    .replace(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*(?:\.[a-z]{2,})?/gi, " ");
}

/** 1인칭 단서 — 엄격 모드에서 주소를 풀 수 있는 유일한 신호(business·booking·contact 같은 일반 단어는 해당 없음). */
const FIRST_PERSON_CUE_PATTERN = /\b(?:me|my|our|myself|mine|i['’]m|i am|i['’]ll|i['’]ve|i['’]d|(?:email|e-mail|contact|reach|message|dm|write|write to|talk to|work with) us)\b|(?<![가-힣])(?:저희|저의|저는|저|제가|제|내|나의|나는|나|우리)(?![가-힣])|私|わたし|僕|ぼく|当方|弊社/i;
/**
 * 소유격 1인칭(my/our …) 바로 뒤 1~2 토큰 안에 **제3자 관계 명사**(friend·brother·producer·artist·dj …)가 오면 그 소유격은 본인 연락처 단서가
 * 아니다(`contact my friend Alice: …`). manager·agent·management·team·business·booking·PR·assistant 같은 크리에이터 쪽 사업 연락처는 풀어 준다.
 */
const THIRD_PARTY_RELATION_NOUNS = "friends?|buddy|buddies|bro|homies?|roommates?|brothers?|sisters?|cousins?|mom|mum|mother|dad|father|wife|husband|girlfriend|boyfriend|sons?|daughters?|family|collaborators?|collab partners?|producers?|artists?|composers?|musicians?|singers?|rappers?|djs?|editors?|designers?|animators?|illustrators?|voice actors?|guests?";
const REFERRAL_POSSESSIVE_PATTERN = new RegExp(
  `\\b(?:my|our)\\s+(?:[\\p{L}']+\\s+)?(?:${THIRD_PARTY_RELATION_NOUNS})\\b|(?<![가-힣])(?:저의|제|내|나의|우리)\\s*(?:친구|가족|동생|형|누나|오빠|언니|프로듀서|작곡가|아티스트|가수)|私の(?:友達|友人|家族|兄|姉|弟|妹)`,
  "giu",
);
const creditDocumentCache = new WeakMap<readonly string[], boolean>();

const PROSE_EDGE_PUNCTUATION = /^[,;:!?()\[\]{}"'«»…|–—.]+|[,;:!?()\[\]{}"'«»…|–—.]+$/gu;
const PROSE_TOKEN = /^[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*$/u;

/**
 * **산문 토큰만** 남긴다(구조적 판정): 공백으로 쪼갠 뒤 양끝 구두점을 뗀 토큰이 오직 글자(모든 문자 체계) + 내부 아포스트로피로만
 * 이뤄졌을 때만 산문이다. `/ . @ # : ? & = _ ~ % +`·숫자·기타 기호가 남은 토큰(URL 경로·도메인·핸들·주소 조각)은 버린다.
 * 단서 패턴(`Music by`·`I'm`·`contact us` …)은 이 산문 토큰을 공백으로 이은 문자열에서만 돈다. 남기는 토큰은 원문 그대로(구두점 포함)다.
 */
export function proseTokensOnly(text: string): string {
  return text.split(" ").filter((token) => token !== "" && PROSE_TOKEN.test(token.replace(PROSE_EDGE_PUNCTUATION, ""))).join(" ");
}

/**
 * 한 줄의 주소가 **크리에이터 본인 연락처**인지 판정하는 단서(공용 — 업로드 샘플링·설명란 재파싱이 같은 규칙을 쓴다).
 * 단서는 **주소 표기를 뺀** 문맥에서만 찾는다(주소 속 `collab`·`contact` — 대문자·`[at]`/`[dot]` 난독화 포함 — 가 단서가
 * 되면 안 된다). 제3자 크레딧은 같은 줄이 기본이고, 이 줄에 자체 연락 단서가 없고 앞줄 단서에만 기대는 경우에는
 * 앞줄의 크레딧 단서("Music by / contact:")도 이 주소를 제3자로 만든다.
 */
export function classifyEmailLine(lines: readonly string[], index: number): { contactCue: boolean; thirdParty: boolean; strictRejected: boolean } {
  // 모든 유니코드 공백(NBSP·탭·다중 공백)을 한 칸으로 접어 `Music\u00a0by` 같은 변형이 단서를 못 피하게 한다.
  const norm = (text: string) => foldStyledEmailText(text).normalize("NFKC").replace(/\s+/gu, " ");
  // 심층 추출이 접는 표기(전각 `＠`·수학 글꼴·엔티티)도 주소로 가려야 주소 속 키워드(business)가 단서가 되지 않는다.
  // 단서(1인칭·크레딧)는 **산문 단어**에서만 찾는다: URL·`label.tld` 형 도메인(t.me·bio.me·my.site·linktr.ee)·@핸들·#해시태그는 중립 자리표시자로 가린다.
  const clean = (text: string) => stripAddressText(norm(text))
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\b/gi, " ")
    .replace(/[@#][\w.]+/g, " ");
  // 크레딧·1인칭 단서는 산문 토큰에서만 찾는다(`proseTokensOnly`). 연락 단서(contact·e-mail …)는 종전대로 가린 줄 전체에서 본다.
  const hereLine = clean(lines[index] ?? "");
  const beforeLine = index > 0 ? clean(lines[index - 1] ?? "") : "";
  const here = hereLine;
  const before = beforeLine;
  const creditIn = (cleaned: string) => THIRD_PARTY_CUE_PATTERN.test(proseTokensOnly(cleaned)) || cleaned.includes("©");
  const firstPersonIn = (cleaned: string) => FIRST_PERSON_CUE_PATTERN.test(proseTokensOnly(cleaned).replace(REFERRAL_POSSESSIVE_PATTERN, " "));
  const contactCue = CONTACT_CUE_PATTERN.test(here) || CONTACT_CUE_PATTERN.test(before);
  // 앞줄 크레딧 단서에 기대는 판정은 문서 단위 엄격 모드가 대신한다(앞줄에 크레딧이 있으면 문서에 크레딧이 있다) — 이 줄 자체의 크레딧만 본다.
  const lineThirdParty = creditIn(here);
  if (lineThirdParty) return { contactCue, thirdParty: true, strictRejected: false };
  // 문서 단위 **엄격 모드**: 문서 어디에든 크레딧/제3자 단서가 있으면, 주소는 자기 줄이나 자기 블록의 머리 줄에 **1인칭 단서**가 있을 때만
  // 채택한다. 일반 사업 단어(booking·inquiries·business·collab·contact·email)는 단독으로 풀지 못한다. 크레딧이 있는 설명에서의 재현율
  // 손실은 의도된 정밀도 거래다(오귀속 쓰기 < 누락).
  let hasCredit = creditDocumentCache.get(lines);
  if (hasCredit === undefined) {
    hasCredit = lines.some((line) => creditIn(clean(line)));
    creditDocumentCache.set(lines, hasCredit);
  }
  if (!hasCredit || firstPersonIn(here)) return { contactCue, thirdParty: false, strictRejected: false };
  // 직전 **비어 있지 않은** 한 줄만 본다(더 거슬러 올라가지 않는다): 그 줄에 1인칭 단서가 있고 크레딧 단서가 없을 때만 이 주소를 푼다.
  let previousIndex = index - 1;
  while (previousIndex >= 0 && norm(lines[previousIndex] ?? "").trim() === "") previousIndex -= 1;
  if (previousIndex >= 0) {
    const previous = clean(lines[previousIndex] ?? "");
    if (firstPersonIn(previous) && !creditIn(previous)) return { contactCue, thirdParty: false, strictRejected: false };
  }
  return { contactCue, thirdParty: true, strictRejected: true };
}

/**
 * 설명란 텍스트에서 후보 주소를 줄 단위로 뽑는다 — **제3자 크레딧 줄의 주소는 버린다**(`Music by x@y.com`). 연락 단서는 요구하지
 * 않는다(채널 about 의 단독 주소는 본인 것이 기본). 모든 추출은 출처 경계(도메인 이어짐·왼쪽 잔재) 거부를 거친다.
 * `deep` 이면 줄 단위로 심층 추출을 쓴다(여러 줄에 걸친 표기는 지원하지 않는다 — 누락 < 오주소).
 */
export function extractCreatorDescriptionEmails(
  description: string,
  deep: boolean,
  onGateReject?: (reason: SourceGateReason) => void,
  /** 제3자/크레딧 판정으로 버린 주소 수 — `strict` 는 문서 단위 엄격 모드(1인칭 단서 없음)로 버린 것. */
  onThirdParty?: (count: number, strict: boolean) => void,
): string[] {
  const lines = description.split(/\r?\n/);
  // 출처 경계는 **전체 설명**에서 판정한다(줄바꿈 뒤로 이어지는 `\n[dot]vn` 같은 꼬리도 보이도록). 줄 단위 결과는 이 허용 집합에 있을 때만 채택.
  const allowed = new Set(deep ? extractEmailsDeep(description) : extractEmailsBoundarySafe(description));
  // 쓰기 게이트: 최종 주소가 전체 정규화 원문에 독립 토큰으로 실재해야 한다(신원을 바꾸는 정리·꼬리 이어짐 거부).
  const gate = createEmailSourceGate(description);
  const out: string[] = [];
  lines.forEach((line, index) => {
    const safe = deep ? extractEmailsDeep(line) : extractEmailsBoundarySafe(line);
    if (safe.length > 0) {
      const verdict = classifyEmailLine(lines, index);
      if (verdict.thirdParty) { onThirdParty?.(safe.length, verdict.strictRejected); return; }
    }
    // 출처 경계 필터가 먼저 버린 주소(조각)도 쓰기 게이트 거부로 센다 — 계측이 거부 수를 숨기지 않게.
    if (!deep) for (const email of extractEmailsForDiscovery(line)) if (!safe.includes(email)) onGateReject?.("right_continuation");
    const picked = safe.filter((email) => allowed.has(email) && !out.includes(email));
    out.push(...filterByEmailSource(picked, gate, onGateReject));
  });
  return out;
}

/**
 * cross_source donor 검증: 직접 재파싱과 **같은 규칙**을 donor 원문/행 설명에 적용한다 — 5,000자 상한에 닿은 절단본은 쓰지 않고,
 * 게이트(독립 토큰)를 통과한 뒤 제3자 크레딧 줄이면 거부한다.
 */
export function verifyDonorAgainstText(email: string, text: string | undefined): "verified" | "third_party" | "unverified" {
  if (!text || text.length >= STORED_DESCRIPTION_CAP) return "unverified";
  if (createEmailSourceGate(text).check(email) !== null) return "unverified";
  return extractCreatorDescriptionEmails(text, true).includes(email) ? "verified" : "third_party";
}

function preferBusiness(emails: readonly string[]): string[] {
  return [...emails].sort((a, b) => Number(isBusinessEmail(b)) - Number(isBusinessEmail(a)));
}

// ---------------------------------------------------------------------------
// 검증
// ---------------------------------------------------------------------------

export type DiggedEmailRejection = "invalid" | "role_account" | "suppressed" | "no_mx" | "duplicate";

export type EmailValidationDeps = {
  readonly isSuppressed: (email: string, handle: string) => Promise<boolean>;
  /** 도메인 단위 확정 답만 돌려준다. 리졸버 자체 장애는 `transient: true` 에러로 던진다(실행 중단 사유). */
  readonly hasMx: (domain: string) => Promise<boolean>;
  /** 같은 프로그램의 **다른 채널**이 이미 이 주소를 갖고 있는가. */
  readonly emailInUseByOtherChannel: (email: string, candidateId: string) => Promise<boolean>;
};

const STRICT_LOCAL_PATTERN = /^[a-z0-9_%+-](?:[a-z0-9._%+-]{0,62}[a-z0-9_%+-])?$/;
const STRICT_DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

/** 추출기 위생과 별개의 엄격한 문법 검사 — `.a@x.com`, `a..b@x.com`, `a@-x.com` 같은 오형은 MX 가 실존해도 거부한다. */
export function isStrictEmailSyntax(email: string): boolean {
  if (email.length > 254) return false;
  const at = email.lastIndexOf("@");
  if (at <= 0 || email.indexOf("@") !== at) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return STRICT_LOCAL_PATTERN.test(local) && !local.includes("..") && STRICT_DOMAIN_PATTERN.test(domain);
}

/** I/O 없는 사전 검사(문법·추출기 위생·역할계정). 비용이 큰 검증(억제·중복·MX)보다 먼저, 주소 전부에 건다. */
export function precheckDiggedEmail(email: string): DiggedEmailRejection | null {
  const normalized = email.trim().toLowerCase();
  // 추출기 위생(자리표시자·no-reply·유효 TLD)을 그대로 통과해야 한다 — 규칙 복제 금지.
  const reextracted = extractEmailsForDiscovery(normalized);
  if (reextracted.length !== 1 || reextracted[0] !== normalized || !isStrictEmailSyntax(normalized)) return "invalid";
  if (ROLE_ACCOUNT_PREFIXES.has(rolePrefix(normalized))) return "role_account";
  return null;
}

export async function validateDiggedEmail(
  email: string,
  context: { readonly candidateId: string; readonly handle: string },
  deps: EmailValidationDeps,
): Promise<{ ok: true } | { ok: false; reason: DiggedEmailRejection }> {
  const normalized = email.trim().toLowerCase();
  const pre = precheckDiggedEmail(normalized);
  if (pre) return { ok: false, reason: pre };
  if (await deps.isSuppressed(normalized, context.handle)) return { ok: false, reason: "suppressed" };
  if (await deps.emailInUseByOtherChannel(normalized, context.candidateId)) return { ok: false, reason: "duplicate" };
  if (!(await deps.hasMx(emailDomain(normalized)))) return { ok: false, reason: "no_mx" };
  return { ok: true };
}

/** 일시 오류 — `scope: "resolver"` 는 로컬 장애(실행 중단), `"domain"` 은 이 도메인만(행을 미루고 다음 주기에 재시도). */
function transientError(message: string, scope: "resolver" | "domain"): Error {
  return Object.assign(new Error(message), { transient: true, scope });
}

const SUPPRESSION_LOOKUP_TIMEOUT_MS = 8_000;
const SIBLING_PROBE_LIMIT = 20;
/** 같은 채널 매치를 읽는 창 — 가득 차면 "더 있을 수 있다"이므로 유일성을 증명하지 못한 것으로 본다. */
const DUPLICATE_PROBE_LIMIT = 10;

export function defaultEmailValidationDeps(programId: string): EmailValidationDeps {
  const mxByDomain = new Map<string, boolean>();
  const transientDomains = new Set<string>();
  return {
    async isSuppressed(email, handle) {
      // findMailSuppression 은 페이지를 끝까지 훑을 수 있다 — 한 번의 조회가 실행 마감을 넘기지 못하게 시간으로 끊는다.
      const hit = await Promise.race([
        findMailSuppression({ email, handle }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(transientError("suppression_lookup_timeout", "resolver")), SUPPRESSION_LOOKUP_TIMEOUT_MS)),
      ]);
      return hit.blocked === true;
    },
    async hasMx(domain) {
      const cached = mxByDomain.get(domain);
      if (cached !== undefined) return cached;
      if (transientDomains.has(domain)) throw transientError("mx_lookup_transient", "domain");
      const lookup = async (): Promise<boolean> => {
        const records = await Promise.race([
          dns.resolveMx(domain),
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(Object.assign(new Error("mx_timeout"), { code: "ETIMEOUT" })), 3_000)),
        ]);
        // Null MX(".")는 "메일을 받지 않는다"는 선언이다.
        return records.some((record) => record.exchange && record.exchange !== ".");
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const ok = await lookup();
          mxByDomain.set(domain, ok);
          return ok;
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (code === "ENOTFOUND" || code === "ENODATA") { mxByDomain.set(domain, false); return false; } // 확정: 도메인/MX 없음
          if (code === "EAI_AGAIN" || code === "ECONNREFUSED" || code === "EAI_FAIL") throw transientError("dns_resolver_unavailable", "resolver");
          // 타임아웃·SERVFAIL 은 "없음"의 증거가 아니다 — 한 번 더 시도하고, 그래도 안 되면 부정 결과로 **굳히지 않고**
          // 이 행을 시도 표시 없이 미룬다(다음 전체 주기에 다시 본다).
        }
      }
      transientDomains.add(domain);
      throw transientError("mx_lookup_transient", "domain");
    },
    async emailInUseByOtherChannel(email, candidateId) {
      const snapshot = await adminDb.collection("campaign_candidates")
        .where("canonicalProgramId", "==", programId)
        .where("email", "==", email)
        .select("candidateId")
        .limit(DUPLICATE_PROBE_LIMIT)
        .get();
      if (snapshot.docs.some((doc) => doc.get("candidateId") !== candidateId)) return true;
      // 창이 가득 찼는데 전부 같은 채널이면 다른 채널 문서가 창 밖에 있을 수 있다 — 보수적으로 중복으로 본다.
      return snapshot.size >= DUPLICATE_PROBE_LIMIT;
    },
  };
}

// ---------------------------------------------------------------------------
// 스윕 코어 (저장소 주입 — 노드 테스트는 메모리 구현으로 돈다)
// ---------------------------------------------------------------------------

export type EmailDiggingRow = {
  readonly docId: string;
  readonly candidateId: string;
  readonly handle: string;
  readonly description: string;
  readonly email: string;
  readonly platform: string;
  readonly diggingVersion: number;
  readonly diggingAttemptedAtIso: string;
};

export type EmailDiggingFoundWrite = {
  readonly docId: string;
  readonly candidateId: string;
  readonly email: string;
  readonly emailStatus: "verified" | "guessed";
  readonly emailSource: string;
  readonly emailSourceKind: EmailSourceKind;
  readonly sourceHost: string | null;
  /** cross_source 일 때 donor 가 어느 컬렉션이었는지(출처 보존). */
  readonly donorOrigin: string | null;
};

/**
 * cross_source donor. `provenance`: `vendor` = 벤더 임포트(원문 추출이 아님 — 그대로 재사용 가능), `extracted` = 설명란/링크 등에서 **추출된**
 * 주소(과거 오파싱이 전파될 수 있다 — 원문 게이트를 통과해야만 재사용). `sourceText` = donor 문서가 저장한 원문(있을 때).
 */
export type EmailDiggingDonor = {
  readonly email: string;
  readonly origin: string;
  readonly provenance: "vendor" | "extracted";
  readonly sourceText?: string;
};

export type EmailDiggingStore = {
  readState(programId: string): Promise<{ cursor: string | null }>;
  /** 리스를 잡는다. 이미 다른 실행이 잡고 있으면 false. */
  acquireLease(programId: string, runId: string, nowMs: number, ttlMs: number): Promise<boolean>;
  /** `cursor: undefined` 는 저장된 커서를 건드리지 않는다(상태를 읽지 못한 실행이 진행 상황을 지우지 않게). */
  releaseLease(programId: string, runId: string, state: { cursor: string | null | undefined; completed: boolean; nowIso: string }): Promise<void>;
  /** `rawCount`/`lastDocId` 는 **필터 전** 페이지 기준이다 — 끝 판정과 커서는 이 값으로 한다. */
  scanPage(programId: string, afterDocId: string | null, pageSize: number): Promise<{ rows: EmailDiggingRow[]; rawCount: number; lastDocId: string | null }>;
  /** 같은 **채널 id** 의 다른 문서가 가진 주소와 출처(donor). T049 Apify·절단 스니펫 유래는 제외한 것이다. */
  lookupKnownEmails(candidateId: string, handle: string): Promise<{
    readonly donors: readonly EmailDiggingDonor[];
    /** 읽기 창이 가득 차 donor 집합이 완전하다고 증명할 수 없다 — 재사용하지 않는다. */
    readonly indeterminate?: boolean;
  }>;
  readUrlCache(urlHash: string, nowMs: number): Promise<LinkPageOutcome | null>;
  writeUrlCache(urlHash: string, outcome: LinkPageOutcome, nowIso: string): Promise<void>;
  /** 문서가 아직 존재하고 아직 이메일이 없을 때만 쓰고 true. 그사이 다른 경로가 채웠으면 아무것도 쓰지 않고 false. */
  applyFound(write: EmailDiggingFoundWrite, nowIso: string, runId: string): Promise<boolean>;
  markAttempt(docId: string, nowIso: string): Promise<void>;
  writeAudit(runId: string, doc: Record<string, unknown>): Promise<void>;
};

export type EmailDiggingRunInput = {
  readonly programId: string;
  readonly dryRun: boolean;
  readonly limit: number;
  readonly maxFetches: number;
  readonly cursor: string | null;
  readonly runId: string;
  readonly auditActor: Record<string, unknown>;
};

export type EmailDiggingRunDeps = {
  readonly store: EmailDiggingStore;
  readonly validation: EmailValidationDeps;
  readonly fetcher: LinkPageFetcher;
  readonly now?: () => number;
  /** 가져와도 되는 링크인바이오 호스트(기본 = LINK_IN_BIO_APPROVED_HOSTS = 비어 있음 → ③ 꺼짐). */
  readonly approvedHosts?: readonly string[];
  /**
   * 심층 추출(전각·장식 글꼴·엔티티·제로폭·일본어·공백 @/at 접기) 사용 여부. **기본 꺼짐**: 긴 꼬리의 유니코드 변형에서
   * 조각 주소를 만들 위험이 완전히 닫히지 않았으므로(적대 리뷰 7라운드) 운영자가 dryRun 으로 결과를 눈으로 확인한 뒤에만 켠다.
   */
  readonly deepExtraction?: boolean;
};

export type EmailDiggingCounters = {
  scanned: number;
  eligible: number;
  examined: number;
  skippedByMarker: number;
  found: number;
  foundByDescriptionReparse: number;
  foundByCrossSource: number;
  foundByLinkInBio: number;
  /** 쓰려는 순간 이미 다른 경로가 채워 둔 행 수(덮어쓰지 않았다). */
  skippedAlreadyFilled: number;
  /** donor 가 서로 다른 주소를 가져 어느 쪽도 고르지 않은 채널 수. */
  crossSourceConflicts: number;
  /** 도메인 DNS 일시 오류로 시도 표시 없이 미룬 행 수(다음 전체 주기에 다시 본다). */
  retryable: number;
  /** 유효 주소가 행당 검증 상한(25)을 넘겨 일부를 못 본 행 수 — 주소 스팸형 설명으로 보고 소진 처리한다(표시 남김). */
  incomplete: number;
  /** 이번 실행이 수행한 주소 검증 수(읽기·DNS 증폭 계측). */
  validations: number;
  linkPageAttempts: number;
  linkPageOutcomes: Record<string, number>;
  rejected: Record<DiggedEmailRejection, number>;
  attemptsMarked: number;
  /** 쓰기 게이트(최종 주소가 전체 정규화 원문에 독립 토큰으로 실재) 거부 수 — 사유별. */
  sourceGateRejected: Record<SourceGateReason, number>;
  /** 출처를 원문으로 검증할 수 없어 재사용하지 않은 cross_source donor 주소 수. */
  skippedUnverifiedDonor: number;
  /** 원문에서 제3자 크레딧 줄의 주소라 재사용하지 않은 cross_source donor 주소 수. */
  skippedThirdPartyDonor: number;
  /** 설명란 재파싱에서 제3자/크레딧 판정으로 버린 주소 수(donor 는 skippedThirdPartyDonor). */
  thirdPartyRejected: number;
  /** 위 중 문서 단위 엄격 모드(크레딧 단서 + 1인칭 단서 없음)로 버린 수. */
  strictModeRejected: number;
};

export type EmailDiggingRunResult = {
  readonly ok: true;
  readonly runId: string;
  readonly programId: string;
  readonly dryRun: boolean;
  readonly counters: EmailDiggingCounters;
  readonly nextCursor: string | null;
  readonly completed: boolean;
  readonly stoppedBy: "end_of_collection" | "limit" | "fetch_cap" | "deadline" | "scan_pages" | "dependency_unavailable";
  readonly costLog: {
    readonly provider: "public-web";
    readonly model: "email-digging-link-in-bio";
    readonly httpRequests: number;
    readonly youtubeUnits: 0;
    readonly estimatedUsd: 0;
  };
};

function emptyCounters(): EmailDiggingCounters {
  return {
    scanned: 0, eligible: 0, examined: 0, skippedByMarker: 0, found: 0,
    foundByDescriptionReparse: 0, foundByCrossSource: 0, foundByLinkInBio: 0, skippedAlreadyFilled: 0, crossSourceConflicts: 0, retryable: 0, incomplete: 0, validations: 0,
    linkPageAttempts: 0, linkPageOutcomes: {},
    rejected: { invalid: 0, role_account: 0, suppressed: 0, no_mx: 0, duplicate: 0 },
    attemptsMarked: 0,
    sourceGateRejected: { absent: 0, left_boundary: 0, right_continuation: 0 },
    skippedUnverifiedDonor: 0,
    skippedThirdPartyDonor: 0,
    thirdPartyRejected: 0,
    strictModeRejected: 0,
  };
}

export function isEmailDiggingEligible(
  row: EmailDiggingRow,
  nowMs: number,
  version = EMAIL_DIGGING_VERSION,
  retryAfterMs: number = EMAIL_DIGGING_LIMITS.retryAfterMs,
): "eligible" | "has_email" | "marker" | "not_youtube" {
  if (row.email.includes("@")) return "has_email";
  if (row.platform && row.platform.toLowerCase() !== "youtube") return "not_youtube";
  if (row.diggingVersion >= version) {
    const last = Date.parse(row.diggingAttemptedAtIso);
    if (Number.isFinite(last) && nowMs - last < retryAfterMs) return "marker";
  }
  return "eligible";
}

const sha = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 32);

type DigOutcome =
  | { kind: "found"; write: EmailDiggingFoundWrite }
  | { kind: "none" }
  /** 예산(호출 상한/시간) 때문에 이 행을 **시도 표시 없이** 미룬다 — 실행을 여기서 멈춘다. */
  | { kind: "deferred"; reason: "fetch_cap" | "deadline" }
  /** 로컬 DNS 리졸버/억제 조회 장애 — 이 행은 판정하지 못했다. 실행을 멈추고 커서를 이 행 앞에 둔다. */
  | { kind: "resolver_down" }
  /** 도메인 DNS 일시 오류 — 시도 표시 없이 지나간다(커서는 전진, 다음 전체 주기에 재시도). */
  | { kind: "retry_later"; why: "dns" };

/** 행당 검증할 주소 상한 / 실행당 검증 상한(읽기·DNS 증폭 방지). */
/** discovery 가 candidate 문서에 저장하는 설명 상한(`description.slice(0, 5_000)`). 이 길이면 절단본이다. */
const STORED_DESCRIPTION_CAP = 5_000;
const MAX_ADDRESSES_PER_ROW = 25;
const MAX_VALIDATIONS_PER_RUN = 1_500;

export class BudgetExhausted extends Error {
  constructor(readonly reason: "deadline" | "validations") {
    super(`email-digging budget exhausted: ${reason}`);
  }
}

export async function runEmailDiggingBackfill(input: EmailDiggingRunInput, deps: EmailDiggingRunDeps): Promise<EmailDiggingRunResult> {
  const clock = deps.now ?? Date.now;
  const startedMs = clock();
  const startedIso = new Date(startedMs).toISOString();
  const counters = emptyCounters();
  const limit = Math.max(1, Math.min(Math.floor(input.limit), EMAIL_DIGGING_LIMITS.maxLimit));
  const maxFetches = Math.max(0, Math.min(Math.floor(input.maxFetches), EMAIL_DIGGING_LIMITS.maxFetchesCap));

  if (!input.dryRun) {
    const leased = await deps.store.acquireLease(input.programId, input.runId, startedMs, EMAIL_DIGGING_LIMITS.leaseMs);
    if (!leased) {
      throw Object.assign(new Error("failed-precondition: another email-digging run holds the lease"), {
        code: "failed-precondition",
        errorCode: "email_digging_lease_held",
      });
    }
  }

  let cursor: string | null = input.cursor;
  let cursorBefore: string | null = input.cursor;
  // 저장된 커서를 읽는 데 성공했을 때만 릴리스가 커서를 덮어쓴다 — 읽기에 실패한 실행이 진행 상황을 null 로 지우지 않는다.
  let cursorKnown = input.cursor !== null || input.dryRun;
  let completed = false;
  let stoppedBy: EmailDiggingRunResult["stoppedBy"] = "scan_pages";
  const foundByChannel = new Map<string, EmailDiggingFoundWrite>();
  const budget: DigBudget = { startedMs, clock, validations: 0 };

  try {
    // 리스를 잡은 뒤의 **모든** 작업(상태 읽기 포함)은 이 블록 안이다 — 실패해도 감사·리스 해제가 일어난다.
    if (cursor === null && !input.dryRun) cursor = (await deps.store.readState(input.programId)).cursor;
    cursorKnown = true;
    cursorBefore = cursor;
    scan: for (let page = 0; page < EMAIL_DIGGING_LIMITS.maxScanPages; page += 1) {
      const scanned = await deps.store.scanPage(input.programId, cursor, EMAIL_DIGGING_LIMITS.scanPageSize);
      if (scanned.rawCount === 0) { completed = true; stoppedBy = "end_of_collection"; break; }
      for (const row of scanned.rows) {
        if (clock() - startedMs > EMAIL_DIGGING_LIMITS.deadlineMs) { stoppedBy = "deadline"; break scan; }
        if (counters.examined >= limit) { stoppedBy = "limit"; break scan; }
        counters.scanned += 1;
        const eligibility = isEmailDiggingEligible(row, clock());
        if (eligibility === "marker") counters.skippedByMarker += 1;
        if (eligibility !== "eligible") { cursor = row.docId; continue; }
        counters.eligible += 1;

        // 같은 채널의 형제 문서(다른 캠페인)가 이번 실행에서 이미 **적용된** 결과는 그대로 재사용한다.
        const sibling = foundByChannel.get(row.candidateId);
        if (sibling) {
          if (!input.dryRun && !(await deps.store.applyFound({ ...sibling, docId: row.docId }, startedIso, input.runId))) {
            counters.skippedAlreadyFilled += 1;
          }
          counters.examined += 1;
          cursor = row.docId;
          continue;
        }

        const outcome = await digOne(row, deps, counters, maxFetches, input.dryRun, budget);
        if (outcome.kind === "deferred") { stoppedBy = outcome.reason; break scan; }
        if (outcome.kind === "resolver_down") { stoppedBy = "dependency_unavailable"; break scan; }
        counters.examined += 1;
        if (outcome.kind === "retry_later") {
          counters.retryable += 1;
        } else if (outcome.kind === "found") {
          const write = outcome.write;
          const applied = input.dryRun ? true : await deps.store.applyFound(write, startedIso, input.runId);
          if (applied) {
            counters.found += 1;
            // 형제 재사용은 **적용에 성공한** 결과만 캐시한다(거절된 제안이 형제로 새지 않게).
            foundByChannel.set(row.candidateId, write);
            if (write.emailSourceKind === "about") counters.foundByDescriptionReparse += 1;
            else if (write.emailSourceKind === "cross_source") counters.foundByCrossSource += 1;
            else counters.foundByLinkInBio += 1;
          } else {
            counters.skippedAlreadyFilled += 1;
          }
        } else if (!input.dryRun) {
          await deps.store.markAttempt(row.docId, startedIso);
          counters.attemptsMarked += 1;
        }
        cursor = row.docId;
      }
      // 끝 판정·커서는 **필터 전** 페이지 기준이다(문서 하나가 걸러졌다고 컬렉션이 끝난 것이 아니다).
      cursor = scanned.lastDocId ?? cursor;
      if (scanned.rawCount < EMAIL_DIGGING_LIMITS.scanPageSize) { completed = true; stoppedBy = "end_of_collection"; break; }
    }
  } finally {
    const nextCursor = completed ? null : cursor;
    counters.validations = budget.validations;
    // 감사: 이메일·설명 원문 없음(SEC-P0-009) — 건수·사유·커서만. 감사가 실패해도 리스는 반드시 푼다.
    try {
      await deps.store.writeAudit(input.runId, {
        ...input.auditActor,
        runId: input.runId,
        programId: input.programId,
        version: EMAIL_DIGGING_VERSION,
        dryRun: input.dryRun,
        deepExtraction: deps.deepExtraction === true,
        startedAtIso: startedIso,
        finishedAtIso: new Date(clock()).toISOString(),
        cursorBefore,
        cursorAfter: nextCursor,
        completed,
        stoppedBy,
        counters,
        costLog: { provider: "public-web", httpRequests: deps.fetcher.requests(), youtubeUnits: 0, estimatedUsd: 0 },
      });
    } finally {
      if (!input.dryRun) {
        await deps.store.releaseLease(input.programId, input.runId, { cursor: cursorKnown ? nextCursor : undefined, completed, nowIso: new Date(clock()).toISOString() });
      }
    }
  }

  return {
    ok: true,
    runId: input.runId,
    programId: input.programId,
    dryRun: input.dryRun,
    counters,
    nextCursor: completed ? null : cursor,
    completed,
    stoppedBy,
    costLog: { provider: "public-web", model: "email-digging-link-in-bio", httpRequests: deps.fetcher.requests(), youtubeUnits: 0, estimatedUsd: 0 },
  };
}

export type DigBudget = { readonly startedMs: number; readonly clock: () => number; validations: number };

export type FirstValid = { email: string | null; resolverDown: boolean; retryLater: boolean; incomplete: boolean };

export async function firstValid(
  emails: readonly string[],
  row: Pick<EmailDiggingRow, "candidateId" | "handle">,
  deps: { readonly validation: EmailValidationDeps },
  counters: { readonly rejected: Record<DiggedEmailRejection, number> },
  budget: DigBudget,
): Promise<FirstValid> {
  // 1) I/O 없는 사전 검사를 **전부**에 건다 — 걸러질 주소가 검증 상한을 먹어 뒤의 유효 주소를 가리지 않게.
  const survivors: string[] = [];
  for (const email of preferBusiness(emails)) {
    const reason = precheckDiggedEmail(email);
    if (reason) counters.rejected[reason] += 1;
    else survivors.push(email.trim().toLowerCase());
  }
  let retryLater = false;
  // 2) 비용이 큰 검증(억제·중복·MX)은 행당 상한까지만.
  for (const email of survivors.slice(0, MAX_ADDRESSES_PER_ROW)) {
    // 시간·검증 예산은 **검증 하나하나 앞에서** 확인한다(주소가 많은 한 행이 마감을 넘기지 못하게).
    if (budget.clock() - budget.startedMs > EMAIL_DIGGING_LIMITS.deadlineMs) throw new BudgetExhausted("deadline");
    if (budget.validations >= MAX_VALIDATIONS_PER_RUN) throw new BudgetExhausted("validations");
    budget.validations += 1;
    try {
      const verdict = await validateDiggedEmail(email, { candidateId: row.candidateId, handle: row.handle }, deps.validation);
      if (verdict.ok) return { email, resolverDown: false, retryLater: false, incomplete: false };
      counters.rejected[verdict.reason] += 1;
    } catch (error) {
      const transient = error as { transient?: unknown; scope?: unknown } | null;
      if (transient?.transient !== true) throw error;
      if (transient.scope === "domain") { retryLater = true; continue; }
      return { email: null, resolverDown: true, retryLater: false, incomplete: false };
    }
  }
  return { email: null, resolverDown: false, retryLater, incomplete: survivors.length > MAX_ADDRESSES_PER_ROW };
}

function toWrite(
  row: EmailDiggingRow,
  email: string,
  kind: EmailSourceKind,
  source: string,
  host: string | null,
  donorOrigin: string | null = null,
): DigOutcome {
  return {
    kind: "found",
    write: {
      docId: row.docId,
      candidateId: row.candidateId,
      email,
      emailStatus: isBusinessEmail(email) ? "verified" : "guessed",
      emailSource: source,
      emailSourceKind: kind,
      sourceHost: host,
      donorOrigin,
    },
  };
}

async function digOne(
  row: EmailDiggingRow,
  deps: EmailDiggingRunDeps,
  counters: EmailDiggingCounters,
  maxFetches: number,
  dryRun: boolean,
  budget: DigBudget,
): Promise<DigOutcome> {
  let retryLater = false;
  let incomplete = false;
  const absorb = (result: FirstValid) => {
    retryLater = retryLater || result.retryLater;
    incomplete = incomplete || result.incomplete;
  };
  try {
    // ① 설명란 재파싱(네트워크 0) — 심층 추출(접힌 표기·추가 난독화).
    // 저장된 설명은 5,000자에서 잘려 있다(discovery 가 그 상한으로 저장한다). 상한에 닿은 텍스트는 **절단본**이라
    // 끝 근처의 주소가 잘린 도메인일 수 있고(`x@gmail.com.museum` → `x@gmail.com`, 끝에서 먼 곳의 `[dot]` 꼬리 포함) 경계 보호창
    // 몇 글자로는 다 못 막는다 — 그래서 절단본은 설명란 재파싱을 **건너뛴다**(②·③ 소스는 그대로 돈다). 누락 비용 < 오주소 비용.
    const truncated = row.description.length >= STORED_DESCRIPTION_CAP;
    const reparsed = await firstValid(
      truncated ? [] : extractCreatorDescriptionEmails(row.description, deps.deepExtraction === true, (reason) => { counters.sourceGateRejected[reason] += 1; }, (count, strict) => { counters.thirdPartyRejected += count; if (strict) counters.strictModeRejected += count; }),
      row, deps, counters, budget,
    );
    if (reparsed.resolverDown) return { kind: "resolver_down" };
    if (reparsed.email) return toWrite(row, reparsed.email, "about", "description_reparse", null);
    absorb(reparsed);

    // ② 같은 채널 id 의 다른 문서가 가진 주소 — donor 들이 서로 다른 주소이거나 donor 집합이 완전하다고 증명할 수
    //    없으면(읽기 창이 가득 참) 아무것도 고르지 않는다.
    const known = await deps.store.lookupKnownEmails(row.candidateId, row.handle);
    const distinct = [...new Set(known.donors.map((donor) => donor.email))];
    if (distinct.length > 1 || (known.indeterminate === true && distinct.length > 0)) {
      counters.crossSourceConflicts += 1;
    } else if (distinct.length === 1) {
      // 쓰기 게이트: 추출 유래 donor 주소는 donor 자신의 저장 원문 또는 이 행의 설명(같은 채널)에 독립 토큰으로 실재할 때만 재사용한다.
      //   벤더 임포트 donor 는 원문이 없으므로 그대로 쓴다. 검증 못 하면 건너뛰고 센다(과거 오파싱 전파 차단).
      const donorEmail = distinct[0];
      let verified = false;
      let credited = false;
      for (const donor of known.donors) {
        if (donor.email !== donorEmail) continue;
        if (donor.provenance === "vendor") { verified = true; break; }
        for (const text of [donor.sourceText, row.description]) {
          const outcome = verifyDonorAgainstText(donorEmail, text);
          if (outcome === "verified") verified = true;
          else if (outcome === "third_party") credited = true;
        }
      }
      if (!verified) {
        if (credited) counters.skippedThirdPartyDonor += 1;
        else counters.skippedUnverifiedDonor += 1;
      } else {
        const reused = await firstValid(distinct, row, deps, counters, budget);
        if (reused.resolverDown) return { kind: "resolver_down" };
        if (reused.email) {
          return toWrite(row, reused.email, "cross_source", "cross_source", null, known.donors.find((donor) => donor.email === reused.email)?.origin ?? null);
        }
        absorb(reused);
      }
    }

    // ③ 링크인바이오 — 승인 호스트가 없으면(기본) 후보 URL 이 0개라 여기서 끝난다.
    // 호출 상한/시간 예산이 없으면 이 행은 **시도 표시 없이** 미룬다(다음 실행 대상으로 남는다).
    for (const url of selectLinkInBioUrls(row.description, deps.approvedHosts)) {
      const urlHash = sha(url);
      const cached = await deps.store.readUrlCache(urlHash, budget.clock());
      if (cached) {
        counters.linkPageOutcomes[`cache_${cached}`] = (counters.linkPageOutcomes[`cache_${cached}`] ?? 0) + 1;
        continue;
      }
      if (deps.fetcher.pageFetches() >= maxFetches) return { kind: "deferred", reason: "fetch_cap" };
      if (budget.clock() - budget.startedMs > EMAIL_DIGGING_LIMITS.deadlineMs) return { kind: "deferred", reason: "deadline" };
      const page = await deps.fetcher.fetchPage(url);
      counters.linkPageAttempts += 1;
      counters.linkPageOutcomes[page.outcome] = (counters.linkPageOutcomes[page.outcome] ?? 0) + 1;
      // dryRun 은 캐시를 쓰지 않는다 — 점검 실행이 7일짜리 실패 캐시로 실제 실행을 막으면 안 된다.
      const remember = async (outcome: LinkPageOutcome) => {
        if (!dryRun) await deps.store.writeUrlCache(urlHash, outcome, new Date(budget.clock()).toISOString());
      };
      if (page.outcome !== "ok") {
        await remember(page.outcome);
        continue;
      }
      const linked = await firstValid(emailsFromLinkPageHtml(page.html, (reason) => { counters.sourceGateRejected[reason] += 1; }), row, deps, counters, budget);
      if (linked.resolverDown) return { kind: "resolver_down" };
      if (linked.email) return toWrite(row, linked.email, "link_in_bio", "link_in_bio", page.host);
      absorb(linked);
      await remember("no_email");
    }
    if (retryLater) return { kind: "retry_later", why: "dns" };
    if (incomplete) counters.incomplete += 1;
    return { kind: "none" };
  } catch (error) {
    if (error instanceof BudgetExhausted) return { kind: "deferred", reason: "deadline" };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Firestore 저장소
// ---------------------------------------------------------------------------

function str(value: unknown, max = 5_000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * donor 문서 → 재사용 후보(순수). T049 Apify 유래·절단 스니펫 유래는 donor 가 될 수 없다 — 제한/불확실 출처를
 * `cross_source` 로 세탁하지 않는다.
 */
/** 출처가 **확인되는** 종류. 이 집합 밖이거나 비어 있으면 벤더 임포트 출처로만 인정한다. */
const TRUSTED_DONOR_KINDS = new Set(["about", "video_description", "public_scrape", "link_in_bio", "cross_source"]);
/** 벤더 제공 연락처 임포트 — 출처 종류 필드가 없던 시절의 문서가 여기에 속한다. */
const TRUSTED_VENDOR_DISCOVERY_SOURCES = new Set(["infly_import", "heepsy_import", "infly.globalCreatorContacts+youtube.channels.list"]);

export function donorFromFields(
  origin: string,
  fields: { readonly email?: unknown; readonly emailSourceKind?: unknown; readonly emailSource?: unknown; readonly discoverySource?: unknown },
): { email: string; origin: string } | null {
  const email = str(fields.email, 320).toLowerCase();
  if (!email.includes("@")) return null;
  const kind = str(fields.emailSourceKind, 40);
  const discoverySource = str(fields.discoverySource, 80).toLowerCase();
  const labels = `${str(fields.emailSource, 80)} ${discoverySource}`.toLowerCase();
  if (kind === "apify" || kind === "search_snippet" || labels.includes("apify")) return null;
  // **긍정적 출처**가 있어야 한다: 신뢰하는 종류이거나, 종류 없이 벤더 임포트 출처. 승격/이관은 이메일을 복사하면서
  // 출처 필드를 버리므로("알 수 없음")는 donor 로 못 쓴다 — 제한/불확실 출처 세탁 방지.
  const trusted = kind ? TRUSTED_DONOR_KINDS.has(kind) : TRUSTED_VENDOR_DISCOVERY_SOURCES.has(discoverySource);
  return trusted ? { email, origin } : null;
}

export type EmailDiggingStoreOptions = {
  /** 시도 마커 필드 접두(기본 `emailDigging`). 업로드 샘플링 레인은 자기 마커를 써서 서로 간섭하지 않는다. */
  readonly markerPrefix?: string;
  readonly version?: number;
  /** 상태(커서·리스) 문서 네임스페이스 — 기본 빈 문자열(기존 문서 id 불변). */
  readonly stateNamespace?: string;
};

export function firestoreEmailDiggingStore(options: EmailDiggingStoreOptions = {}): EmailDiggingStore {
  const markerPrefix = options.markerPrefix ?? "emailDigging";
  const versionField = `${markerPrefix}Version`;
  const attemptedField = `${markerPrefix}AttemptedAtIso`;
  const laneVersion = options.version ?? EMAIL_DIGGING_VERSION;
  const stateRef = (programId: string) => adminDb.collection(EMAIL_DIGGING_STATE_COLLECTION).doc(sha(`${options.stateNamespace ?? ""}${programId}`));
  return {
    async readState(programId) {
      const snap = await stateRef(programId).get();
      const cursor = snap.exists ? snap.get("cursor") : null;
      return { cursor: typeof cursor === "string" && cursor ? cursor : null };
    },
    async acquireLease(programId, runId, nowMs, ttlMs) {
      return adminDb.runTransaction(async (tx) => {
        const ref = stateRef(programId);
        const snap = await tx.get(ref);
        const leaseUntil = snap.exists ? Date.parse(str(snap.get("leaseUntilIso"), 40)) : NaN;
        if (Number.isFinite(leaseUntil) && leaseUntil > nowMs) return false;
        tx.set(ref, { programId, leaseRunId: runId, leaseUntilIso: new Date(nowMs + ttlMs).toISOString() }, { merge: true });
        return true;
      });
    },
    async releaseLease(programId, runId, state) {
      // 소유권 확인: 이 실행이 잡은 리스일 때만 푼다. 만료된 실행의 뒤늦은 정리가 새 소유자의 리스·커서를 지우지 않는다.
      await adminDb.runTransaction(async (tx) => {
        const ref = stateRef(programId);
        const snap = await tx.get(ref);
        if (!snap.exists || str(snap.get("leaseRunId"), 80) !== runId) return;
        tx.set(ref, {
          programId,
          ...(state.cursor !== undefined ? { cursor: state.cursor } : {}),
          version: laneVersion,
          leaseRunId: FieldValue.delete(),
          leaseUntilIso: FieldValue.delete(),
          lastRunId: runId,
          updatedAtIso: state.nowIso,
          ...(state.completed ? { lastCompletedAtIso: state.nowIso } : {}),
        }, { merge: true });
      });
    },
    async scanPage(programId, afterDocId, pageSize) {
      let query = adminDb.collection("campaign_candidates")
        .where("canonicalProgramId", "==", programId)
        .orderBy(FieldPath.documentId())
        .select("email", "candidateId", "handle", "publicDescription", "platform", versionField, attemptedField)
        .limit(pageSize);
      if (afterDocId) query = query.startAfter(afterDocId);
      const snapshot = await query.get();
      const rows = snapshot.docs.map((doc) => ({
        docId: doc.id,
        candidateId: str(doc.get("candidateId"), 120),
        handle: str(doc.get("handle"), 120),
        description: str(doc.get("publicDescription")),
        email: str(doc.get("email"), 320),
        platform: str(doc.get("platform"), 40),
        diggingVersion: Number(doc.get(versionField)) || 0,
        diggingAttemptedAtIso: str(doc.get(attemptedField), 40),
      })).filter((row) => row.candidateId.length > 0);
      return { rows, rawCount: snapshot.size, lastDocId: snapshot.size > 0 ? snapshot.docs[snapshot.size - 1].id : null };
    },
    async lookupKnownEmails(candidateId) {
      // 채널 id 일치만 근거로 쓴다 — handle 문자열 일치는 동명이인 오귀속 위험이라 쓰지 않는다.
      // **출처가 확인되는** donor 만 쓴다: T049 Apify 유래·절단 스니펫 유래는 제외하고, `creators` 문서는
      // (승격이 이메일을 복사하면서 출처 필드를 버리므로) donor 가 될 수 없다 — 제한/불확실 출처 세탁 방지.
      const donors: EmailDiggingDonor[] = [];
      const take = (origin: string, doc: FirebaseFirestore.DocumentSnapshot) => {
        const donor = donorFromFields(origin, {
          email: doc.get("email"), emailSourceKind: doc.get("emailSourceKind"),
          emailSource: doc.get("emailSource"), discoverySource: doc.get("discoverySource"),
        });
        if (!donor) return;
        // 출처 종류가 있으면(about/video_description/…) 추출 유래다 — 종류 없이 신뢰되는 donor 는 벤더 임포트뿐이다(donorFromFields 계약).
        const kind = str(doc.get("emailSourceKind"), 40);
        const sourceText = str(doc.get("publicDescription"));
        donors.push({ ...donor, provenance: kind ? "extracted" : "vendor", ...(sourceText ? { sourceText } : {}) });
      };
      const pool = await adminDb.collection("candidate_pool").doc(candidateId).get();
      if (pool.exists) take("candidate_pool", pool);
      const siblings = await adminDb.collection("campaign_candidates").where("candidateId", "==", candidateId)
        .select("email", "emailSourceKind", "emailSource", "discoverySource", "publicDescription").limit(SIBLING_PROBE_LIMIT).get();
      for (const doc of siblings.docs) take("campaign_candidates", doc);
      return { donors, indeterminate: siblings.size >= SIBLING_PROBE_LIMIT };
    },
    async readUrlCache(urlHash, nowMs) {
      const snap = await adminDb.collection(EMAIL_DIGGING_URL_CACHE_COLLECTION).doc(urlHash).get();
      if (!snap.exists) return null;
      const at = Date.parse(str(snap.get("cachedAtIso"), 40));
      if (!Number.isFinite(at) || nowMs - at >= EMAIL_DIGGING_LIMITS.urlCacheTtlMs) return null;
      return str(snap.get("outcome"), 40) as LinkPageOutcome;
    },
    async writeUrlCache(urlHash, outcome, nowIso) {
      await adminDb.collection(EMAIL_DIGGING_URL_CACHE_COLLECTION).doc(urlHash).set({ outcome, cachedAtIso: nowIso, version: EMAIL_DIGGING_VERSION });
    },
    async applyFound(write, nowIso, runId) {
      const fields = {
        email: write.email,
        emailStatus: write.emailStatus,
        emailSource: write.emailSource,
        emailSourceKind: write.emailSourceKind,
        emailDigging: {
          version: laneVersion, source: write.emailSourceKind, host: write.sourceHost,
          ...(write.donorOrigin ? { donorOrigin: write.donorOrigin } : {}), foundAtIso: nowIso, runId,
        },
        [versionField]: laneVersion,
        [attemptedField]: nowIso,
        updatedAtIso: nowIso,
      };
      // **한 트랜잭션**으로 두 문서를 함께 읽고(읽기 먼저) 함께 쓴다: 후보 문서가 아직 존재하고 아직 이메일이 없을
      // 때만 쓰고, 풀 문서는 존재하고 이메일이 없을 때만 같은 값으로 쓴다. 후보 문서를 다른 경로가 먼저 채웠다면
      // 풀 문서도 건드리지 않는다(거절된 제안이 풀로 새지 않는다). 문서를 새로 만들지 않는다(스텁 오염 방지).
      return adminDb.runTransaction(async (tx) => {
        const ref = adminDb.collection("campaign_candidates").doc(write.docId);
        const poolRef = adminDb.collection("candidate_pool").doc(write.candidateId);
        const [snap, poolSnap] = await Promise.all([tx.get(ref), tx.get(poolRef)]);
        if (!snap.exists || str(snap.get("email"), 320).includes("@")) return false;
        tx.update(ref, fields);
        if (poolSnap.exists && !str(poolSnap.get("email"), 320).includes("@")) tx.update(poolRef, fields);
        return true;
      });
    },
    async markAttempt(docId, nowIso) {
      await adminDb.collection("campaign_candidates").doc(docId).update({
        [versionField]: laneVersion,
        [attemptedField]: nowIso,
      });
    },
    async writeAudit(runId, doc) {
      await adminDb.collection(EMAIL_DIGGING_RUNS_COLLECTION).doc(runId).set({ ...doc, createdAt: FieldValue.serverTimestamp() }, { merge: true });
    },
  };
}

// ---------------------------------------------------------------------------
// callable (super_admin 전용, dryRun 기본)
// ---------------------------------------------------------------------------

function invalidArgument(message: string, errorCode: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), { code: "invalid-argument", errorCode });
}

export type EmailDiggingCallableDeps = {
  readonly store?: EmailDiggingStore;
  readonly validation?: EmailValidationDeps;
  readonly fetcher?: LinkPageFetcher;
  readonly runId?: string;
};

export async function emailDiggingBackfill(request: CallableRequestShape, deps: EmailDiggingCallableDeps = {}) {
  const auth = assertNonGuestAuth(request, AUDIT_ACTION, ["super_admin"]);
  const data = asRecord(request.data);
  if ((typeof data.viewAsUserId === "string" && data.viewAsUserId.trim()) || (typeof data.viewAsEmail === "string" && data.viewAsEmail.trim())) {
    throw Object.assign(new Error("permission-denied: this console does not support viewAs preview"), {
      code: "permission-denied",
      errorCode: "email_digging_view_as_unsupported",
      behaviorLog: makeDeniedBehaviorLog(request, AUDIT_ACTION, auth.gameId),
    });
  }
  const programId = asString(data.programId, "").trim();
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(programId)) throw invalidArgument("programId is required", "email_digging_program_invalid");
  if (data.dryRun !== undefined && typeof data.dryRun !== "boolean") throw invalidArgument("dryRun must be a boolean", "email_digging_dry_run_invalid");
  const dryRun = data.dryRun !== false;
  const num = (value: unknown, fallback: number): number => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
  };
  const limit = Math.min(Math.max(num(data.limit, EMAIL_DIGGING_LIMITS.defaultLimit), 1), EMAIL_DIGGING_LIMITS.maxLimit);
  const maxFetches = Math.min(num(data.maxFetches, EMAIL_DIGGING_LIMITS.defaultMaxFetches), EMAIL_DIGGING_LIMITS.maxFetchesCap);
  if (data.deepExtraction !== undefined && typeof data.deepExtraction !== "boolean") throw invalidArgument("deepExtraction must be a boolean", "email_digging_deep_invalid");
  const deepExtraction = data.deepExtraction === true;
  const cursor = typeof data.cursor === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(data.cursor) ? data.cursor : null;
  const runId = deps.runId ?? `edig_${Date.now().toString(36)}_${sha(`${auth.userId}:${Math.random()}`).slice(0, 8)}`;
  const result = await runEmailDiggingBackfill(
    {
      programId, dryRun, limit, maxFetches, cursor, runId,
      auditActor: { action: AUDIT_ACTION, actorUidHash: actorUidHash(auth.userId), actorRole: auth.role },
    },
    {
      store: deps.store ?? firestoreEmailDiggingStore(),
      validation: deps.validation ?? defaultEmailValidationDeps(programId),
      fetcher: deps.fetcher ?? createLinkPageFetcher(),
      deepExtraction,
    },
  );
  return { ...result, behaviorLog: makeBehaviorLog(auth, AUDIT_ACTION, "success") };
}
