import type { MailAccountPublic, MyOrgContextEnvelope } from "@/lib/data";

/**
 * Org policy can change while the app remains open (for example after an OAuth revoke or a
 * routing edit). Keep the shared read cache short-lived so another session can observe those
 * changes after a focus/visibility refresh even when no local mutation emitted the invalidation.
 *
 * 2026-09-27 적대 리뷰 MEDIUM-3 (codex) — 이 TTL은 sessionStorage 하이드레이션에도 그대로
 * 적용된다: 하드 리로드가 이 창(60초) 안에 일어나면 getMyOrgContext 재요청 자체를 건너뛴다(비용
 * 절감이 이 캐시 계층의 목적). 이는 "다른 세션이 프리셋/메일 라우팅을 바꿔도 최대 이 TTL만큼
 * 늦게 반영될 수 있다"는 위 문단의 기존 계약을 하드 리로드 경계까지 넓히는 것뿐 — 새 불변식이
 * 아니다. 이 캐시는 UI 편의 전용이다(각 탭·콜러블은 서버에서 독립적으로 재검증한다 — src/lib/
 * nav.ts, FluTabGate.tsx 주석 참고). 항상 즉시 표시 + 백그라운드 재검증으로 바꾸면 매 하드
 * 리로드마다 다시 네트워크를 타 이 계층이 존재하는 이유(비용 절감)가 없어지므로, 대신 TTL을
 * 늘리지 않고 이 트레이드오프를 문서화해 둔다.
 */
export const ORG_CONTEXT_CACHE_TTL_MS = 60_000;

type CacheEntry = {
  createdAt: number;
  promise: Promise<MyOrgContextEnvelope | null>;
};

const MAX_ORG_CONTEXT_CACHE_SIZE = 8;
const sharedOrgContextEntries = new Map<string, CacheEntry>();
/**
 * 2026-09-27 적대 리뷰 HIGH (round 3, codex) — 세션 영속화 덕에 lazy initializer(useNavPreset.ts)가
 * 하드 리로드 첫 렌더부터 만료된(과거 TTL) 프리셋을 낙관적으로 보여줄 수 있게 됐는데, 그 사이
 * 관리자가 그 조직에 새 탭을 허용했다면 FluTabGate.tsx가 그 **오래된** 프리셋으로
 * isFluTabPathDenied 를 평가해 재검증이 끝나기도 전에 /access-denied 로 리다이렉트해버릴 수
 * 있다 — 하드 리로드로 리다이렉트되는 건 "되돌리기" 개념이 없는 파괴적 동작이라, 값을
 * "이번 페이지 로드에서 실제로 확인됐는지" 와 무관하게 낙관적으로 보여주기만 하는 사이드바
 * 표시(cosmetic)와는 위험도가 다르다. 이 Set은 "이번 모듈 수명(=하드 리로드 이후) 동안 이
 * 스코프의 fetchOrgContextOnce 프라미스가 최소 한 번 settle 됐는가"만 추적한다 — sessionStorage에
 * 영속화하지 않는다(그러면 의미가 없어진다: 매 하드 리로드마다 "이번 로드에서 확인됨"이 다시
 * false 로 시작해야 한다). FluTabGate 같은 **파괴적** 소비자만 이걸로 게이트하고, Sidebar 같은
 * 표시 전용 소비자는 기존처럼 즉시 낙관적 값을 보여준다(비용 절감 효과는 그대로 유지 — 이미
 * settle된/신선한 항목은 캐시 적중이 마이크로태스크 안에 다시 settle 되므로 체감 지연이 없다).
 *
 * 2026-09-27 적대 리뷰 HIGH x2 (round 4, codex, 최종 병합 게이트) — 위 설계에 실제 결함 두 개:
 *   (a) settledScopeKeysThisPageLoad에 값을 넣는 것만으로는 이미 마운트된 React 컴포넌트가
 *       다시 렌더된다는 보장이 없다(이 Set은 React state가 아니다) — 특히 하이드레이션된 신선한
 *       캐시 적중은 lazy initializer가 이미 정확한 값을 읽어 놨으므로 setOrgContext(response)가
 *       *같은 참조*를 다시 넣어 React가 리렌더를 건너뛸 수 있다(Object.is 동일 시 bail-out) —
 *       그러면 confirmed 플래그가 true로 바뀌어도 FluTabGate가 그걸 관찰할 렌더 자체가 없어
 *       (반대 방향으로) 원래 막아야 할 탭이 리다이렉트 없이 계속 보일 수 있다.
 *   (b) 무효화(뮤테이션) 직후 새 요청이 나갔는데, 그 **이전**(이미 대체된) 요청의 프라미스가
 *       뒤늦게 settle 되면 그 낡은 .then이 아무 확인 없이 이 Set에 다시 추가해버려, 실제로는
 *       아직 도착하지 않은 새 응답을 "확인됨"으로 오판할 수 있다(이 기능이 막으려던 바로 그
 *       false-denial 부류가 다른 경로로 재발).
 * 아래 subscribeOrgContextSettlement/notifySettlementListeners로 (a)를(진짜 구독 메커니즘,
 * invalidationListeners와는 별도 채널 — 재검증 effect의 의존 배열에 섞이면 무관한 스코프까지
 * 매 settle마다 재요청되는 부작용이 생긴다), markScopeSettledIfCurrent로 (b)를(rememberResolved
 * OrgContext와 동일한 "아직 현재 프라미스인가" 가드) 고친다.
 */
const settledScopeKeysThisPageLoad = new Set<string>();
const settlementListeners = new Set<() => void>();

function notifySettlementListeners(): void {
  for (const listener of settlementListeners) listener();
}

/** Subscribe to any settlement/invalidation change (not filtered by key — infrequent, and each
 * mounted useIsActiveOrgScopeConfirmed() consumer just re-reads its own key's current flag). */
export function subscribeOrgContextSettlement(listener: () => void): () => void {
  settlementListeners.add(listener);
  return () => settlementListeners.delete(listener);
}

/** Marks `key` settled only if `settledPromise` is still the entry's current promise — an
 * obsolete (superseded-by-invalidation) request settling later must not resurrect confirmation. */
function markScopeSettledIfCurrent(key: string, settledPromise: Promise<MyOrgContextEnvelope | null>): void {
  if (sharedOrgContextEntries.get(key)?.promise !== settledPromise) return;
  settledScopeKeysThisPageLoad.add(key);
  notifySettlementListeners();
}
/**
 * 스코프별 마지막 확정 투영(성공 응답). 위 entries 와 달리 invalidate 해도 지우지 않는다 —
 *   무효화는 "이 값을 잊어라"가 아니라 "다시 읽어라"는 뜻이라, 재검증이 끝날 때까지 소비자가
 *   이전 값을 계속 그릴 수 있어야 한다(stale-while-revalidate). 이 값이 없으면 TTL 재검증
 *   때마다 useOrgContext 가 null 로 비워져 /chat 목록이 통째로 비었다 차오르는 플래시가 났다.
 * entries 와 같은 상한으로 묶고, 쓰기 시점에 최신 키로 갱신한다(LRU 성격의 삽입 순서).
 */
const lastResolvedOrgContexts = new Map<string, MyOrgContextEnvelope>();
const invalidationListeners = new Set<(revision: number) => void>();
let invalidationRevision = 0;

// --- sessionStorage persistence (탭 permission flash fix, 2026-09-27) ---
// 프로드 호스팅이 RSC 페이로드 요청(?_rsc=)에 HTML을 돌려줘 라우트 전환마다 문서 전체가 다시
// 로드된다(2026-09-07 프로드 계측 — src/lib/campaign-target-links.ts, src/app/(app)/flu/programs/
// page.tsx의 같은 코멘트 참고). 이 모듈의 두 Map은 순수 인메모리라 그때마다
// 통째로 비고, getMyOrgContext 왕복이 끝나기 전까지 navPreset이 null(=프리셋 없음, 아래
// filterNavByPreset/isFluTabPathDenied 계약상 "제한 없음"과 동일하게 fail-open) 이라 사이드바가
// 잠깐 무제한 탭을 보여줬다 실제 프리셋으로 좁히는 플래시가 났다 — "대신 보기"로 제한된 조직을
// 보는 중일 때 가장 두드러진다.
// sessionStorage는 하드 리로드에도 살아남으므로, 두 Map과 같은 내용을 여기 함께 적어 두면 모듈이
// 다시 평가될 때(=매 하드 내비게이션) 첫 effect가 돌기 전부터 이미 채워져 있다. 두 Map을 건드리는
// 모든 지점(rememberResolvedOrgContext/invalidateOrgContextCache)에서 스토리지도 함께
// 갱신해 항상 같은 키 집합을 유지한다. 로그아웃·viewAs 전환·uid 변경은 authIdentityKey/viewAs가
// 키에 들어 있어(org-context-cache-key.ts) 다른 사용자·타깃과 절대 섞이지 않고, 같은 세션 안에서
// 스코프가 바뀌면 useNavPreset.ts의 effect가 떠나는 스코프를 invalidateOrgContextCache(key)로
// 불러 그 스코프의 sessionStorage 항목도 함께 지운다.
const SESSION_STORAGE_PREFIX = "flu.orgContext.v1.";

type PersistedOrgContextEntry = { value: MyOrgContextEnvelope; createdAt: number };

function sessionStorageKeyFor(key: string): string {
  return `${SESSION_STORAGE_PREFIX}${key}`;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * The subset of MailAccountPublic (src/lib/data.ts) that this codebase actually dereferences off a
 * persisted accessibleAccounts/usableSenders element without a type guard:
 *   - useNavPreset.ts's authoritativeOrgContextScopeKey does
 *     `` `${account.accountId}:${account.status}` `` and mail-sender-policy.ts's
 *     usableMailSenders does `account.status === "active"` — both throw on a non-object element
 *     (e.g. `null`).
 *   - codex confirmatory-round follow-up (MEDIUM) — mailSenderDisplayName's `account.label ||
 *     account.mailbox` is rendered directly as a JSX child in src/app/(app)/chat/page.tsx (the
 *     sender <option> label and the "selectedSender.mailbox" helper text). A prior version of this
 *     comment claimed plain property access on label/mailbox "cannot throw on a wrong type" — true
 *     for the property read itself, but React throws "Objects are not valid as a React child" when
 *     a truthy non-string result is *rendered*, the same class of mistake orgName's shape check
 *     fixed above. label/mailbox are therefore validated too, not just accountId/status.
 * Every other MailAccountPublic field on a cached element (kind, ownerEmail, orgIds, smtp/imap,
 * etc.) is neither method-called nor rendered raw by any consumer of the cached org context, so
 * this intentionally does not validate the full MailAccountPublic shape — just the fields a
 * malformed element could actually crash a real caller on.
 */
function isPlausibleMailAccountElement(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MailAccountPublic>;
  return (
    typeof candidate.accountId === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.label === "string" &&
    typeof candidate.mailbox === "string"
  );
}

/**
 * Post-merge review (PR #208 follow-up, LOW; then four codex re-review rounds, each finding a
 * new consumer this guard hadn't accounted for) — sessionStorage is a plain string store any
 * script in this origin can write (a stale schema from a previous app version, or hand-edited
 * during debugging). A malformed persisted value must degrade to a cache miss, not be handed to
 * consumers as if it were a real org context:
 *   - round 1: src/lib/nav.ts's filterNavByPreset throws on a truthy non-array navPreset (`{}`
 *     passes a naive `!!navPreset` check but has no `.includes`).
 *   - round 2: the same class of crash for usableSenders (`.filter()` in mail-sender-policy.ts)
 *     and defaultSenderId/viewMailAccountId (both `?.trim()`-called — optional chaining only
 *     guards null/undefined, not "wrong type"; a persisted number still throws "x.trim is not a
 *     function").
 *   - round 3: (a) an array field can itself be well-shaped (a real array) while containing a
 *     malformed *element* — `accessibleAccounts: [null]` still crashes useNavPreset.ts's
 *     `account.accountId` (see isPlausibleMailAccountElement above); (b) this function's own prior
 *     comment claimed orgName was "safe, only ever plain-property-accessed" — wrong: src/app/(app)/
 *     chat/page.tsx renders `{orgContext.orgName || ...}` directly as a JSX child, and React throws
 *     "Objects are not valid as a React child" for a truthy non-string/non-number/non-element value
 *     there (property access on it elsewhere doesn't throw, but *rendering* it does — the earlier
 *     "plain property access is always safe" reasoning only accounted for further property/method
 *     chaining, not direct JSX embedding).
 *   - round 4 (codex confirmatory gate): personalAccount/orgAccount (the singular MailAccountPublic
 *     fields, not the arrays) feed the exact same rendering path — src/app/(app)/chat/page.tsx
 *     derives `personalMailAccount`/`orgMailAccount` directly from these two fields, and
 *     `viewingMailAccountLabel` (`account.label || account.mailbox`) is rendered as a raw JSX child
 *     (`보기 · {viewingMailAccountLabel}`) — so a malformed personalAccount/orgAccount crashes
 *     exactly like a malformed accessibleAccounts/usableSenders element would.
 * Given four rounds each found a gap in "only validate what I already saw a consumer break on",
 * this is validated by grepping every field actually reachable from a mounted component (JSX
 * `{orgContext.X}`) or a method call chained off one (`.filter`/`.map`/`.trim`/etc.), not by
 * reacting to each new report in isolation — see git history for the exact searches per round.
 */
function isPlausibleOrgContextShape(value: unknown): value is MyOrgContextEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MyOrgContextEnvelope>;
  return (
    isNullableString(candidate.orgId) &&
    isNullableString(candidate.orgName) &&
    Array.isArray(candidate.accessibleAccounts) &&
    candidate.accessibleAccounts.every(isPlausibleMailAccountElement) &&
    (candidate.navPreset === null ||
      (Array.isArray(candidate.navPreset) && candidate.navPreset.every((item) => typeof item === "string"))) &&
    (candidate.usableSenders === undefined ||
      (Array.isArray(candidate.usableSenders) && candidate.usableSenders.every(isPlausibleMailAccountElement))) &&
    (candidate.personalAccount === undefined ||
      candidate.personalAccount === null ||
      isPlausibleMailAccountElement(candidate.personalAccount)) &&
    (candidate.orgAccount === undefined ||
      candidate.orgAccount === null ||
      isPlausibleMailAccountElement(candidate.orgAccount)) &&
    (candidate.defaultSenderId === undefined || isNullableString(candidate.defaultSenderId)) &&
    isNullableString(candidate.viewMailAccountId)
  );
}

function readPersistedOrgContext(key: string): PersistedOrgContextEntry | null {
  try {
    const raw = window.sessionStorage.getItem(sessionStorageKeyFor(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedOrgContextEntry> | null;
    if (
      !parsed ||
      typeof parsed.createdAt !== "number" ||
      !parsed.value ||
      typeof parsed.value !== "object" ||
      !isPlausibleOrgContextShape(parsed.value)
    ) {
      return null;
    }
    return { value: parsed.value, createdAt: parsed.createdAt };
  } catch {
    // 프라이빗 모드 등 storage 접근 불가 환경 — 하드 리로드 사이 캐시가 못 버틸 뿐, 이후 정상
    // fetch 경로로 동작한다(기존 in-memory-only 상태와 같은 열화).
    return null;
  }
}

/**
 * 2026-09-27 적대 리뷰 MEDIUM-1 (codex) — MailAccountPublic(personalAccount/orgAccount/
 * accessibleAccounts/usableSenders)의 smtp/imap 필드는 secretRef는 빠졌지만 host/port/username 등
 * 인프라 메타데이터를 담을 수 있다(functions/mailAccounts.ts toMailAccountPublic). 이 값은 원래도
 * getMyOrgContext 응답으로 이미 클라이언트에 오고 인메모리(lastResolvedOrgContexts)에도 남지만,
 * 이 파일이 새로 추가하는 것은 그것을 **sessionStorage에 로그아웃 이후에도 남게** 만드는 것이다 —
 * 이 훅의 어떤 소비자도 .smtp/.imap을 읽지 않는다(grep 확인: src 전체에서 useOrgContext 소비자
 * 쪽 참조 없음, admin/integrations는 listMailAccounts라는 별도 콜러블의 응답을 쓴다) 그러니
 * sessionStorage로 나가는 사본에서만 지운다 — 인메모리 값(lastResolvedOrgContexts, 이 함수의
 * `value` 인자 원본)은 그대로 둬 어떤 소비자 동작도 바꾸지 않는다. 나중에 실제로 이 필드를 읽는
 * 소비자가 생기면 이 redaction 을 그 소비자 기준으로 다시 검토해야 한다.
 */
function redactMailAccountForStorage(account: MailAccountPublic): MailAccountPublic {
  return { ...account, smtp: {}, imap: {} };
}

function redactOrgContextForStorage(value: MyOrgContextEnvelope): MyOrgContextEnvelope {
  return {
    ...value,
    personalAccount: value.personalAccount ? redactMailAccountForStorage(value.personalAccount) : value.personalAccount,
    orgAccount: value.orgAccount ? redactMailAccountForStorage(value.orgAccount) : value.orgAccount,
    // 방어적으로 배열 폴백(?? []) — 타입상 accessibleAccounts는 항상 배열이지만, 이 함수는
    // writePersistedOrgContext의 try/catch 안에서 돌기 때문에 여기서 던지면 저장 자체가 조용히
    // 스킵된다(캐시 미스로 열화, 앱은 정상 동작) — 그래도 불완전한 값 하나 때문에 정상적인
    // 나머지 필드까지 저장에 실패하지 않도록 방어한다.
    accessibleAccounts: (value.accessibleAccounts ?? []).map(redactMailAccountForStorage),
    usableSenders: value.usableSenders?.map(redactMailAccountForStorage),
  };
}

function writePersistedOrgContext(key: string, value: MyOrgContextEnvelope, createdAt: number): void {
  try {
    const redacted = redactOrgContextForStorage(value);
    window.sessionStorage.setItem(sessionStorageKeyFor(key), JSON.stringify({ value: redacted, createdAt }));
  } catch {
    // 위와 같은 이유로 무시 — 쓰기 실패는 캐시 미스로만 이어진다.
  }
}

function removePersistedOrgContext(key: string): void {
  try {
    window.sessionStorage.removeItem(sessionStorageKeyFor(key));
  } catch {
    // 위와 같은 이유로 무시.
  }
}

function removeAllPersistedOrgContexts(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const storageKey = window.sessionStorage.key(i);
      if (storageKey?.startsWith(SESSION_STORAGE_PREFIX)) toRemove.push(storageKey);
    }
    toRemove.forEach((storageKey) => window.sessionStorage.removeItem(storageKey));
  } catch {
    // 위와 같은 이유로 무시.
  }
}

/**
 * 모듈이 처음 평가될 때(=매 하드 내비게이션마다) 한 번, 이전에 남겨둔 sessionStorage 값으로 두
 * Map을 미리 채운다. SWR 표시값(lastResolvedOrgContexts)은 나이와 무관하게 되살린다 — 기존
 * in-memory 계약과 동일하게, 백그라운드 재검증은 아래 신선도 판정과 무관하게 항상 다시 돈다.
 * 신선(ORG_CONTEXT_CACHE_TTL_MS 이내)한 항목만 "이미 응답 받음"으로 표시해 재요청 자체를
 * 건너뛴다(비용 절감) — 그 외에는 기존과 동일하게 새 fetch가 발생한다. SSR/테스트(window 없음)
 * 에서는 건너뛴다.
 */
function hydrateOrgContextCacheFromSessionStorage(): void {
  if (typeof window === "undefined") return;
  try {
    const now = Date.now();
    const keys: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const storageKey = window.sessionStorage.key(i);
      if (storageKey?.startsWith(SESSION_STORAGE_PREFIX)) keys.push(storageKey);
    }
    for (const storageKey of keys) {
      const key = storageKey.slice(SESSION_STORAGE_PREFIX.length);
      const persisted = readPersistedOrgContext(key);
      if (!persisted) {
        window.sessionStorage.removeItem(storageKey);
        continue;
      }
      lastResolvedOrgContexts.set(key, persisted.value);
      if (now - persisted.createdAt < ORG_CONTEXT_CACHE_TTL_MS) {
        sharedOrgContextEntries.set(key, {
          createdAt: persisted.createdAt,
          promise: Promise.resolve(persisted.value),
        });
      }
    }
  } catch {
    // 스토리지 열거 자체가 막힌 환경 — 하이드레이션을 건너뛸 뿐 이후 정상 요청 경로로 동작한다.
  }
}

hydrateOrgContextCacheFromSessionStorage();

function capOrgContextCache(): void {
  while (sharedOrgContextEntries.size > MAX_ORG_CONTEXT_CACHE_SIZE) {
    const oldestKey = sharedOrgContextEntries.keys().next().value;
    if (oldestKey === undefined) break;
    sharedOrgContextEntries.delete(oldestKey);
  }
}

function rememberResolvedOrgContext(key: string, value: MyOrgContextEnvelope, createdAt: number): void {
  lastResolvedOrgContexts.delete(key);
  lastResolvedOrgContexts.set(key, value);
  writePersistedOrgContext(key, value, createdAt);
  while (lastResolvedOrgContexts.size > MAX_ORG_CONTEXT_CACHE_SIZE) {
    const oldestKey = lastResolvedOrgContexts.keys().next().value;
    if (oldestKey === undefined) break;
    lastResolvedOrgContexts.delete(oldestKey);
    removePersistedOrgContext(oldestKey);
  }
}

/** Return the current invalidation revision for initializing a newly mounted hook. */
export function orgContextCacheRevision(): number {
  return invalidationRevision;
}

/** Subscribe a mounted useOrgContext consumer to successful mailbox policy mutations. */
export function subscribeOrgContextInvalidation(listener: (revision: number) => void): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

/**
 * A fresh entry may still be an in-flight request. Treating it as fresh prevents a focus event
 * from replacing an active request; callers use invalidateOrgContextCache when it is stale.
 */
export function hasFreshOrgContextCache(key: string, now = Date.now()): boolean {
  const entry = sharedOrgContextEntries.get(key);
  return Boolean(entry && now - entry.createdAt < ORG_CONTEXT_CACHE_TTL_MS);
}

/**
 * True once this scope's read has settled (success or failure) at least once during this page
 * load — see settledScopeKeysThisPageLoad's comment above. A destructive consumer (a redirect,
 * unlike a passive display) must wait for this before trusting the value it reads.
 */
export function hasScopeSettledThisPageLoad(key: string): boolean {
  return settledScopeKeysThisPageLoad.has(key);
}

/**
 * TTL·무효화와 무관하게 이 스코프의 마지막 확정 투영을 돌려준다(SWR 표시용). 한 번도 성공
 * 응답을 받지 못한 스코프(첫 로드, 다른 계정·viewAs 스코프)는 null — 그 경우 소비자는
 * 기존과 같이 비워진 상태로 시작한다. 무효화 이전에 시작돼 뒤늦게 resolve 된 응답은
 * remember 되지 않으므로, 여기서 읽히는 값은 항상 "마지막으로 현재 세대였던" 투영이다.
 */
export function getStaleOrgContext(key: string): MyOrgContextEnvelope | null {
  return lastResolvedOrgContexts.get(key) ?? null;
}

/**
 * Drop one scope, or every scope when no key is provided, and wake mounted hooks. Clearing the
 * entry is not enough by itself: a hook may still hold an older resolved projection, so listeners
 * force a new request generation before that projection can be rendered again.
 *
 * Also drops the matching sessionStorage-persisted entry (see hydrateOrgContextCacheFromSessionStorage
 * above) so a hard reload that happens right after a mutation (e.g. admin/integrations calling this
 * after updateIntegration/setMailRouting) cannot rehydrate the pre-mutation snapshot as "fresh" and
 * skip the refetch that must observe the mutation. lastResolvedOrgContexts (the ageless SWR display
 * map) is deliberately left alone, same as before this persistence layer existed — only the
 * freshness/skip-fetch signal needs busting.
 */
export function invalidateOrgContextCache(key?: string): void {
  if (key) {
    sharedOrgContextEntries.delete(key);
    removePersistedOrgContext(key);
    // 무효화된 스코프는 다음 값이 다시 settle 될 때까지 "이번 로드에서 확인됨"을 잃는다 — 그래야
    // 그 사이 misfire할 수 있는 파괴적 소비자(FluTabGate)가 재확인을 기다린다.
    settledScopeKeysThisPageLoad.delete(key);
  } else {
    sharedOrgContextEntries.clear();
    removeAllPersistedOrgContexts();
    settledScopeKeysThisPageLoad.clear();
  }
  invalidationRevision += 1;
  for (const listener of invalidationListeners) listener(invalidationRevision);
  // confirmed==false로 바뀐 것도 관찰 가능해야 한다(위 settlement 채널 코멘트 (a) 참고) — 그래야
  // 이미 confirmed==true를 읽고 있던 소비자가 무효화 직후에도 재확인 전까지는 낡은 true를 계속
  // 들고 있지 않는다.
  notifySettlementListeners();
}

/**
 * Post-merge review (PR #208 follow-up, HIGH) — invalidateOrgContextCache() alone does not fully
 * purge a signed-out identity: as its own doc comment above explains, it deliberately leaves
 * lastResolvedOrgContexts (the ageless SWR display map) populated so a same-user mutation
 * (admin/integrations calling the bare invalidateOrgContextCache() after updateIntegration/
 * setMailRouting) can keep showing the outgoing value while its own re-fetch is in flight. A
 * sign-out has no such follow-up fetch for that identity — leaving its projection (emails, orgId,
 * navPreset) behind would let the next signed-in identity's optimistic first render in the same
 * tab (before its own fetch settles) show a stranger's org context. This is why sign-out gets its
 * own function instead of changing invalidateOrgContextCache()'s existing (and still correct for
 * mutations) semantics: it does everything invalidateOrgContextCache() does — sessionStorage
 * `flu.orgContext.v1.*` keys, the fresh/skip-fetch cache, and this-page-load settlement — plus
 * forgetting the stale-while-revalidate projection that invalidateOrgContextCache() intentionally
 * keeps.
 */
export function purgeOrgContextCacheOnSignOut(): void {
  invalidateOrgContextCache();
  lastResolvedOrgContexts.clear();
}

/**
 * Share only in-flight/fresh requests. A rejected request removes itself only if it is still the
 * current entry; an invalidated old promise must never delete a newer request for the same scope.
 */
export function fetchOrgContextOnce(
  key: string,
  load: () => Promise<MyOrgContextEnvelope>,
): Promise<MyOrgContextEnvelope | null> {
  const now = Date.now();
  const cached = sharedOrgContextEntries.get(key);
  if (cached && now - cached.createdAt < ORG_CONTEXT_CACHE_TTL_MS) {
    // 하이드레이션으로 이미 resolve된 프라미스(org-context-cache.ts 상단)일 수 있다 — 그 경우 이
    // .then은 마이크로태스크 안에 돈다(체감 지연 없음). 실제 진행 중인 요청이면 그 응답이 도착할
    // 때 settle 로 표시된다. markScopeSettledIfCurrent가 "그 사이 무효화로 대체되지 않았는지"도
    // 확인한다(round 4 적대 리뷰 HIGH-2).
    void cached.promise.then(() => markScopeSettledIfCurrent(key, cached.promise));
    return cached.promise;
  }
  if (cached) sharedOrgContextEntries.delete(key);

  let promise: Promise<MyOrgContextEnvelope | null>;
  promise = load()
    .then((response) => {
      // 성공 응답은 마지막 확정 투영으로 남긴다 — 단 이 요청이 아직 현재 세대일 때만. 무효화나
      //   교체로 지난 세대가 된 요청(예: 뮤테이션 직전에 시작된 읽기)이 resolve 되어도 새 값을
      //   덮어쓰지 않아야 뮤테이션 이전 스냅샷이 "마지막 정상 값"으로 되살아나지 않는다.
      if (response && sharedOrgContextEntries.get(key)?.promise === promise) {
        rememberResolvedOrgContext(key, response, now);
      }
      return response;
    })
    .catch(() => {
      if (sharedOrgContextEntries.get(key)?.promise === promise) sharedOrgContextEntries.delete(key);
      return null;
    });
  void promise.then(() => markScopeSettledIfCurrent(key, promise));
  sharedOrgContextEntries.set(key, { createdAt: now, promise });
  capOrgContextCache();
  return promise;
}
