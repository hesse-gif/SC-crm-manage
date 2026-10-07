"use client";

import type { User } from "firebase/auth";
import { callFluCallable, type Role } from "./data";
import { purgeOrgContextCacheOnSignOut } from "./org-context-cache";
import {
  orgContextAuthIdentityKey,
  readLastKnownAuthIdentityKey,
  writeLastKnownAuthIdentityKey,
} from "./org-context-cache-key";

export type AuthState = {
  user: User | null;
  role: Role | null;
  team?: string | null;
  name?: string;
  email?: string;
  photoURL?: string;
  claimSyncReason?: string | null;
  errorKind?: "configuration";
  errorMessage?: string;
  loading: boolean;
};

type FirebaseAuthModule = typeof import("firebase/auth");
type FirebaseClientModule = typeof import("./firebase");

type TokenClaims = Awaited<ReturnType<User["getIdTokenResult"]>>["claims"];

async function loadAuth(): Promise<[FirebaseAuthModule, FirebaseClientModule]> {
  return Promise.all([import("firebase/auth"), import("./firebase")]);
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function authStateFromToken(user: User, claims: TokenClaims): AuthState {
  const role = normalizeRole(claims.role);
  const team = stringClaim(claims.team) ?? null;
  const claimSyncReason = stringClaim(claims.claimSyncReason) ?? null;
  const name = stringClaim(claims.memberName) ?? stringClaim(claims.name) ?? user.displayName ?? user.email ?? "";
  const email = stringClaim(claims.memberEmail) ?? stringClaim(claims.email) ?? user.email ?? "";
  const photoURL = stringClaim(claims.memberPhotoURL) ?? stringClaim(claims.picture) ?? user.photoURL ?? "";
  return { user, role, team, name, email, photoURL, claimSyncReason, loading: false };
}

function shouldForceClaimRefresh(claims: TokenClaims): boolean {
  const role = normalizeRole(claims.role);
  const team = stringClaim(claims.team);
  const claimSyncReason = stringClaim(claims.claimSyncReason);
  return !role || !team || !claimSyncReason || role === "guest" || team === "pending";
}

// A token callback can fire more than once during a sign-in and forced claim
// refresh. Deduplicate bootstrap per Auth identity while keeping a transport
// failure retryable on the next callback/session.
const membershipBootstrapPromises = new Map<string, Promise<boolean>>();

// codex final-gate follow-up (MEDIUM + LOW) — a module-level (not per-subscription) boundary
// marker for bootstrapAuthMembership's sessionStorage TTL marker guard below. This must be
// module-level, not local to one subscribeAuthState() closure, because signInWithGoogleOrEmulator/
// signInWithEmail call bootstrapAuthMembership directly, outside any subscription's closure — a
// per-subscription generation counter would be invisible to them, leaving their own in-flight
// bootstraps unguarded against a sign-out or account switch that happens elsewhere in the same tab
// while they're still running (reproduced by codex: a direct sign-in's bootstrap could still write
// a departed identity's "recently bootstrapped" marker after the fact). It bumps ONLY on an actual
// identity boundary (a real sign-out, or a genuine cross-user switch) — NOT on every
// onIdTokenChanged dispatch, unlike subscribeAuthState's own per-subscription callbackGeneration:
// bootstrapAuthMembership's own `await user.getIdToken(true)` call is expected to trigger another
// onIdTokenChanged notification for the SAME user, and that must not wrongly suppress this same
// bootstrap's own legitimate marker write (also codex, LOW).
let authSessionEpoch = 0;

// Flu/tab-permission-flash 2026-09-27 — requestAccess({bootstrap:true}) hits Peoply
// (getPerson) and writes members/{uid} + custom claims via a Firestore batch on every call
// (functions/admin.ts bootstrapAuthMembershipForUser). membershipBootstrapPromises above only
// dedupes concurrent callbacks within one page load; prod hosting's hard-navigation bug (every
// client nav becomes a full document reload because RSC payload requests get HTML back — see the
// 2026-09-07 프로드 계측 comments in src/lib/campaign-target-links.ts and src/app/(app)/flu/programs/
// page.tsx) wipes that in-memory Map on every tab click, so this expensive write-heavy callable
// used to re-run on every single click. A short sessionStorage
// marker (same TTL as src/lib/org-context-cache.ts's ORG_CONTEXT_CACHE_TTL_MS, kept as its own
// constant here to avoid a cross-module coupling for one shared number) lets a repeat hard reload
// within the window skip the callable entirely — the previously-synced claims are already in the
// cached ID token, so this restores the once-per-login cadence a normal (non-hard-nav) session
// would already have had for up to the token's ~1h lifetime; it grants nothing new (the server
// claims already in the token remain the only thing any callable actually authorizes against).
const MEMBERSHIP_BOOTSTRAP_TTL_MS = 60_000;
const MEMBERSHIP_BOOTSTRAP_STORAGE_PREFIX = "flu.auth.bootstrap.v1.";

function wasMembershipRecentlyBootstrapped(key: string): boolean {
  try {
    const raw = window.sessionStorage.getItem(`${MEMBERSHIP_BOOTSTRAP_STORAGE_PREFIX}${key}`);
    if (!raw) return false;
    const at = Number(raw);
    return Number.isFinite(at) && Date.now() - at < MEMBERSHIP_BOOTSTRAP_TTL_MS;
  } catch {
    // 프라이빗 모드 등 storage 접근 불가 환경 — 매번 다시 부트스트랩할 뿐 화면은 그대로 동작한다.
    return false;
  }
}

function markMembershipBootstrapped(key: string): void {
  try {
    window.sessionStorage.setItem(`${MEMBERSHIP_BOOTSTRAP_STORAGE_PREFIX}${key}`, String(Date.now()));
  } catch {
    // 위와 같은 이유로 무시 — 다음 하드 리로드에서 다시 부트스트랩하는 것으로 열화된다.
  }
}

/**
 * 2026-09-27 적대 리뷰 MEDIUM-2 (codex) — sessionStorage 마커는 uid+email로 스코프되지만
 * `${user.uid}:${email}`이라는 **같은** uid+email 조합으로 로그아웃 후 TTL(60초) 안에 다시
 * 로그인하면(예: 계정 전환 테스트, 세션 재인증) 새 로그인이 "최근에 부트스트랩됨"으로 오판해
 * membershipBootstrapPromises.clear() 바로 아래 주석("A later login for the same uid must
 * refresh Peoply membership again")이 명시한 불변식을 이 마커가 깬다 — 그 사이 관리자가 멤버십/
 * 역할을 바꿨다면 새 로그인이 그 갱신을 놓친다. 로그아웃 시점에 uid를 모르므로(위 !user 분기)
 * 전체를 지운다 — membershipBootstrapPromises.clear() 와 같은 스코프(전체 초기화)로 맞춘다.
 */
function clearAllMembershipBootstrapMarkers(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const storageKey = window.sessionStorage.key(i);
      if (storageKey?.startsWith(MEMBERSHIP_BOOTSTRAP_STORAGE_PREFIX)) toRemove.push(storageKey);
    }
    toRemove.forEach((storageKey) => window.sessionStorage.removeItem(storageKey));
  } catch {
    // 위와 같은 이유로 무시.
  }
}

/**
 * codex final-gate follow-up (MEDIUM, then a further MEDIUM + LOW round) — `isStillCurrent`
 * defaults to checking authSessionEpoch (captured the moment this function is called) against its
 * live value, so EVERY caller — the direct signInWithGoogleOrEmulator/signInWithEmail call sites
 * (outside any subscribeAuthState() closure) as well as subscribeAuthState's own onIdTokenChanged
 * handler (which does not need to pass anything special anymore) — is guarded the same way. This
 * promise's own network calls (callFluCallable/getIdToken) can still be resolving well after a
 * sign-out or a direct switch to a different user has happened elsewhere in the same tab —
 * reproduced by codex: markMembershipBootstrapped(key) writing unconditionally in that window let
 * a LATER login for the SAME uid wrongly see "recently bootstrapped" and skip its own real Peoply
 * refresh, violating the invariant membershipBootstrapPromises.clear()'s own comment states ("A
 * later login for the same uid must refresh Peoply membership again") — and this leak previously
 * reached the marker via the direct call sites too, since they used an always-true default with no
 * boundary awareness at all. authSessionEpoch only bumps on an actual identity boundary (never on
 * a same-user token-refresh notification, which this call's own getIdToken(true) can itself
 * trigger), so a still-current bootstrap's marker write is never wrongly suppressed either. Only
 * the marker write needs guarding — the callable/getIdToken calls themselves are harmless to let
 * finish (the server side already did the work; a discarded local marker just costs one extra
 * callable next login).
 */
async function bootstrapAuthMembership(user: User, isStillCurrent?: () => boolean): Promise<void> {
  const epochAtStart = authSessionEpoch;
  const stillCurrent = isStillCurrent ?? (() => authSessionEpoch === epochAtStart);

  const email = user.email?.trim().toLowerCase() ?? "";
  if (process.env.NEXT_PUBLIC_USE_EMULATOR === "1" && email === "test-admin@demo-flu") {
    return;
  }
  const key = `${user.uid}:${email}`;
  const existing = membershipBootstrapPromises.get(key);
  if (existing) {
    await existing;
    return;
  }
  if (wasMembershipRecentlyBootstrapped(key)) return;

  const promise = (async () => {
    try {
      await callFluCallable("requestAccess", { bootstrap: true });
      // The callable writes merged custom claims. Refresh the local token so
      // AuthGate observes the mapped role/team in the same login session.
      await user.getIdToken(true);
      if (stillCurrent()) markMembershipBootstrapped(key);
      return true;
    } catch {
      // A missing Peoply binding or transient callable failure must not turn a
      // valid Auth login into a client-side dead end. The next token callback
      // can retry because the failed promise is removed below.
      return false;
    }
  })();
  membershipBootstrapPromises.set(key, promise);
  const succeeded = await promise;
  if (!succeeded && membershipBootstrapPromises.get(key) === promise) {
    membershipBootstrapPromises.delete(key);
  }
}

function emptyAuthState(loading = false): AuthState {
  return {
    user: null,
    role: null,
    team: null,
    name: "",
    email: "",
    photoURL: "",
    claimSyncReason: null,
    loading,
  };
}

export function configurationAuthState(error?: unknown): AuthState {
  // 운영자가 원인을 바로 고칠 수 있도록 실제 설정 오류 메시지를 함께 노출한다
  // (환경 계약 위반 설명일 뿐 비밀값이 아니다). 일반 로그아웃과는 계속 구분된다.
  const detail = error instanceof Error && error.message.trim().length > 0
    ? ` 원인: ${error.message.trim()}`
    : "";
  return {
    ...emptyAuthState(false),
    errorKind: "configuration",
    errorMessage: `Flu 연결 설정을 확인할 수 없습니다. 배포 설정을 점검한 뒤 다시 시도해 주세요.${detail}`,
  };
}

async function validateSignedInUserRealm(
  user: User,
  authModule: FirebaseAuthModule,
  firebaseClient: FirebaseClientModule,
): Promise<User> {
  try {
    firebaseClient.assertFluAuthUserTenant(
      user.tenantId,
      firebaseClient.fluAuthTenantId,
    );
    return user;
  } catch (error) {
    await authModule.signOut(firebaseClient.auth).catch(() => undefined);
    throw error;
  }
}

export function subscribeAuthState(callback: (state: AuthState) => void): () => void {
  let active = true;
  let unsubscribe: (() => void) | undefined;
  let forcedClaimRefresh = false;
  // Post-merge review (PR #210 follow-up, codex confirmatory round, HIGH) — tracks the uid/tenant
  // identity onIdTokenChanged most recently confirmed, so a direct A→B identity change (see below)
  // can be told apart from a token refresh of the same user.
  let previousAuthIdentityKey: string | null = null;
  // Post-merge review (PR #210 follow-up, codex final gate, HIGH) — onIdTokenChanged's callback is
  // async, and Firebase does not wait for one invocation's promise to settle before delivering the
  // next: a same-tab "다른 계정으로 로그인" (A→B, no intervening null event) can fire this callback
  // for B while A's own invocation is still mid-flight (e.g. a slow bootstrapAuthMembership network
  // call). If the identity comparison ran only after awaits, A's late-resolving invocation could
  // read a previousAuthIdentityKey already advanced to B by B's faster invocation and misfire, and
  // A could then publish its own stale AuthState *after* B's already ran — the reverse of what the
  // identity-switch purge exists to prevent. callbackGeneration fences both problems: every
  // dispatch captures its own generation before any await, so (a) the identity comparison/reset
  // below also runs before any await (synchronous callback dispatches cannot interleave with each
  // other, so delivery order is preserved for that decision), and (b) any callback(...) reached
  // after an await is skipped once a newer dispatch has started, so only the truly-latest
  // identity's state is ever published.
  let callbackGeneration = 0;

  callback(emptyAuthState(true));

  void loadAuth().then(async ([authModule, firebaseClient]) => {
    if (!active) return;
    const { onIdTokenChanged } = authModule;
    const { auth } = firebaseClient;
    unsubscribe = onIdTokenChanged(auth, async (user) => {
      const myGeneration = ++callbackGeneration;

      if (!user) {
        forcedClaimRefresh = false;
        previousAuthIdentityKey = null;
        // codex final-gate follow-up (MEDIUM + LOW) — a real sign-out is an identity boundary:
        // bump the shared authSessionEpoch so any bootstrapAuthMembership promise still in flight
        // (started by this subscription OR by a direct signInWithGoogleOrEmulator/signInWithEmail
        // call elsewhere) knows not to write its "recently bootstrapped" marker once it resolves.
        authSessionEpoch += 1;
        // A later login for the same uid must refresh Peoply membership again.
        membershipBootstrapPromises.clear();
        clearAllMembershipBootstrapMarkers();
        // 2026-09-27 적대 리뷰 HIGH (round 5, codex, 최종 병합 게이트) — org-context-cache-key.ts의
        // "마지막으로 확인된 uid" 힌트는 원래 useNavPreset.ts의 useOrgContext effect(authIdentityKey
        // 변화 시 기록/해제)에서만 지워졌는데, 그 훅은 AuthGate가 realOk일 때만 마운트된다.
        // 로그아웃 시 AuthGate 자신의 구독이 RoleProvider의 구독보다 먼저 실감지하면, RoleProvider의
        // authUser가 아직 null로 안 바뀐 채로 AuthGate가 children(=그 훅이 든 컴포넌트들)을
        // 언마운트해버릴 수 있어 그 정리 코드가 아예 못 돈다 — 남은 힌트를 같은 탭에서 곧바로
        // 로그인한 다른 사용자가(그 사람 쪽 RoleProvider가 아직 안 따라잡았을 때) 낙관적 첫 렌더에
        // 잘못 물려받을 수 있었다(교차 사용자 UI 노출 — 실 데이터는 서버가 여전히 막지만, 캐시
        // 격리 요구사항 위반). onIdTokenChanged의 이 분기는 컴포넌트 마운트 상태와 무관하게 실제
        // 로그아웃 이벤트마다 반드시 돈다 — 여기서 지우는 게 유일하게 신뢰할 수 있는 지점이다.
        writeLastKnownAuthIdentityKey(null);
        // Post-merge review (PR #208 follow-up, HIGH) — AuthGate can unmount useOrgContext
        // consumers before useNavPreset.ts's own scope-change effect observes this sign-out, so
        // this onIdTokenChanged branch (which always runs on a real logout, regardless of mount
        // state — same reasoning as writeLastKnownAuthIdentityKey(null) above) is the only
        // reliable place to purge the previous identity's org context (emails, orgId, navPreset)
        // out of sessionStorage and the in-memory SWR display map before the next identity can
        // optimistically read it in the same tab.
        purgeOrgContextCacheOnSignOut();
        callback(emptyAuthState());
        return;
      }

      // Post-merge review (PR #210 follow-up, codex confirmatory + final-gate rounds, HIGH) —
      // onIdTokenChanged does not always transition through the `!user` branch above between two
      // different signed-in identities: calling a sign-in method (e.g. "다른 계정으로 로그인" on
      // /access-denied — a plain client-side navigation Link to /login with no prior signOut())
      // while a DIFFERENT user is already authenticated makes Firebase replace the current user
      // directly, firing this callback once with the new user and never with null in between. The
      // `!user` branch's purge would then never run for the departing identity, leaving its cached
      // org context (emails, orgId, navPreset) available to the incoming identity's first
      // optimistic render in the same tab — the exact cross-user leak this PR exists to close, via
      // a different transition path. Detect a genuine uid/tenant change here (not a token refresh
      // of the same identity, which keeps the same key) and purge before adopting the new one.
      //
      // This runs BEFORE any await (unlike an earlier version of this fix) specifically because of
      // the callbackGeneration comment above: doing it after an await let a slower earlier
      // invocation read a previousAuthIdentityKey a faster later invocation had already advanced,
      // producing the wrong purge decision. A direct switch also resets the same per-login
      // bootstrap state the `!user` branch resets on an explicit sign-out — otherwise B could
      // inherit A's already-consumed forced-claim-refresh flag or a stale/in-flight Peoply
      // bootstrap dedupe entry for A still sitting in membershipBootstrapPromises.
      const newAuthIdentityKey = orgContextAuthIdentityKey(user);
      // codex final-gate round 8 (HIGH) — previousAuthIdentityKey starts null on every fresh
      // module evaluation (a hard reload — this app's prod hosting turns every client navigation
      // into one, per the extensive hard-navigation comments elsewhere in this file/repo), so the
      // FIRST callback after a reload could never hit the switch-purge above even when the
      // Firebase-persisted identity genuinely changed since this tab was last open — e.g. another
      // tab in the same browser signed out A and signed in B, and A's org context is still sitting
      // in THIS tab's sessionStorage from before the reload. readLastKnownAuthIdentityKey() is the
      // one piece of that prior identity that survives a hard reload (useNavPreset.ts writes it
      // while mounted); fall back to it only when there is no in-memory value yet — once a real
      // callback has run in this module's lifetime, previousAuthIdentityKey always takes
      // precedence, matching the existing in-session behavior exactly.
      const priorIdentityKeyForSwitchCheck = previousAuthIdentityKey ?? readLastKnownAuthIdentityKey();
      if (priorIdentityKeyForSwitchCheck && newAuthIdentityKey && priorIdentityKeyForSwitchCheck !== newAuthIdentityKey) {
        forcedClaimRefresh = false;
        // codex final-gate follow-up (MEDIUM + LOW) — a genuine cross-user switch is also an
        // identity boundary for authSessionEpoch, same reasoning as the `!user` branch above.
        authSessionEpoch += 1;
        membershipBootstrapPromises.clear();
        clearAllMembershipBootstrapMarkers();
        purgeOrgContextCacheOnSignOut();
      }
      previousAuthIdentityKey = newAuthIdentityKey;

      try {
        await validateSignedInUserRealm(user, authModule, firebaseClient);
        // codex final-gate follow-up (MEDIUM) — cheap early exit: a superseded invocation
        // (outpaced during the realm check above) has no reason to start a whole bootstrap flow
        // for an identity that is no longer current. bootstrapAuthMembership's own default
        // isStillCurrent (based on the shared authSessionEpoch, not this per-dispatch
        // callbackGeneration) is the real fence against its one side effect that could actually
        // corrupt a later login's bootstrap decision — see its doc comment.
        if (myGeneration === callbackGeneration) {
          await bootstrapAuthMembership(user);
        }
      } catch {
        // codex final-gate follow-up (MEDIUM) — forcedClaimRefresh is shared closure state, not
        // per-invocation: an unconditional reset here from a superseded (no-longer-current)
        // invocation could flip a newer, still-in-flight invocation's already-`true` flag back to
        // `false` mid-flight, corrupting a decision that invocation makes below. Only the current
        // generation may touch it (or publish emptyAuthState()).
        if (myGeneration === callbackGeneration) {
          forcedClaimRefresh = false;
          if (active) callback(emptyAuthState());
        }
        return;
      }

      // codex final-gate follow-up (MEDIUM) — the callbackGeneration check right before the final
      // callback(...) below is not enough by itself: forcedClaimRefresh is read AND written before
      // that point, and each `await` here is itself a window where a newer, faster invocation
      // (e.g. a direct identity switch) can run its own synchronous prefix and reset/consume the
      // SAME shared flag. Concretely: a slow superseded invocation could still set
      // forcedClaimRefresh = true for its own (stale, about-to-be-discarded) reasons after a newer
      // invocation already reset it to false, making that newer invocation wrongly skip a forced
      // refresh it genuinely needed (and then publish stale guest/pending claims as if they were
      // final) — or the reverse, wasting an extra refresh. Re-checking the generation immediately
      // after every await that precedes a read/write of forcedClaimRefresh (not just once at the
      // very end) keeps a superseded invocation from touching it at all past that point.
      if (myGeneration !== callbackGeneration) return;

      // 캐시 토큰을 기본으로 쓰되, 신규/승격 직후 자주 남는 stale 상태
      // (role/team/claimSyncReason 누락, guest, pending team)는 구독 1회에 한해 강제 갱신한다.
      let token = await user.getIdTokenResult();
      if (myGeneration !== callbackGeneration) return;
      if (!forcedClaimRefresh && shouldForceClaimRefresh(token.claims)) {
        forcedClaimRefresh = true;
        token = await user.getIdTokenResult(true);
        if (myGeneration !== callbackGeneration) return;
      }
      if (!active) return;
      callback(authStateFromToken(user, token.claims));
    });
  }).catch((error) => {
    // firebase.ts는 잘못된 hosted 설정(NEXT_PUBLIC_FLU_RUNTIME_ENV 부재 등)에서 import
    // 시점에 throw한다(fail-closed). catch가 없으면 이 rejection이 삼켜져 AuthGate가
    // "권한 확인 중…"에 영구 고착된다(2026-07-10 운영 장애). 비로그인 상태로 확정해
    // 게이트가 일반 로그아웃과 배포 설정 오류를 구분해 정직하게 설명하게 한다.
    if (active) callback(configurationAuthState(error));
  });

  return () => {
    active = false;
    unsubscribe?.();
  };
}

export async function signInWithGoogleOrEmulator(emulatorTestAccountId = "admin"): Promise<User> {
  const [authModule, firebaseClient] = await loadAuth();
  const { GoogleAuthProvider, signInWithEmailAndPassword, signInWithPopup } = authModule;
  const { auth } = firebaseClient;

  if (process.env.NEXT_PUBLIC_USE_EMULATOR === "1") {
    // Flu/Task-61: 에뮬레이터 로그인은 항상 이 고정 계정 하나뿐이었다 — QA가 Growth/AI Drama
    // 조직 스코프를 실 로그인으로 검증할 방법이 없었던 근본 원인. scripts/seed-emulator.mjs가
    // Auth 에뮬레이터에 실제로 만드는 계정과 정확히 같은 email/password여야 한다(둘 다 바꿀 땐
    // 함께). 적대 리뷰(LOW): 이 맵을 분기 안으로 옮겨 "NEXT_PUBLIC_USE_EMULATOR!=='1'이라 절대
    // 안 불린다"는 런타임 분기 하나에만 기대지 않는다 — Next.js는 이 값을 빌드 타임에 리터럴로
    // 인라인하므로(.env.production 등 NEXT_PUBLIC_USE_EMULATOR가 "1"이 아닌 빌드) 번들러가 이
    // if 블록 전체를 죽은 코드로 제거해 테스트 계정 이메일 문자열 자체가 프로덕션 번들에
    // 실리지 않는다 — production 경로(signInWithPopup, 이 if 밖)는 이 맵을 전혀 참조하지
    // 않는다.
    const emulatorTestAccounts: Readonly<Record<string, { email: string; password: string }>> = {
      admin: { email: "test-admin@demo-flu", password: "test1234" },
      "growth-manager": { email: "test-growth-manager@demo-flu", password: "test1234" },
      "drama-manager": { email: "test-drama-manager@demo-flu", password: "test1234" },
      "unmapped-viewer": { email: "test-unmapped-viewer@demo-flu", password: "test1234" },
    };
    const account = emulatorTestAccounts[emulatorTestAccountId] ?? emulatorTestAccounts.admin;
    const credential = await signInWithEmailAndPassword(auth, account.email, account.password);
    const user = await validateSignedInUserRealm(credential.user, authModule, firebaseClient);
    await bootstrapAuthMembership(user);
    return user;
  }

  const googleProvider = new GoogleAuthProvider();
  googleProvider.setCustomParameters({ hd: "supercent.io" });
  const credential = await signInWithPopup(auth, googleProvider);
  const user = await validateSignedInUserRealm(credential.user, authModule, firebaseClient);
  await bootstrapAuthMembership(user);
  return user;
}

export async function signInWithEmail(email: string, password: string): Promise<User> {
  const [authModule, firebaseClient] = await loadAuth();
  const { signInWithEmailAndPassword } = authModule;
  const { auth } = firebaseClient;
  const credential = await signInWithEmailAndPassword(auth, email, password);
  const user = await validateSignedInUserRealm(credential.user, authModule, firebaseClient);
  await bootstrapAuthMembership(user);
  return user;
}

export async function signOutCurrentUser(): Promise<void> {
  const [{ signOut }, { auth }] = await loadAuth();
  await signOut(auth);
}

export function normalizeRole(value: unknown): Role | null {
  return value === "super_admin" || value === "admin" || value === "manager" || value === "viewer" || value === "guest"
    ? value
    : null;
}
