/**
 * PLAN-ORG-MAIL-IDENTITY Slice 2 — Gmail OAuth for mail_accounts of kind "workspace_oauth".
 * See docs/PLAN-ORG-MAIL-IDENTITY.md for the data model, rollout plan, and the 2026-09-10
 * "추가 결정" section (self-service connection: any non-guest may connect their OWN mailbox;
 * connecting or revoking someone else's mailbox stays admin-only).
 *
 * Env this module reads directly from process.env (bound per-callable in functions/index.ts,
 * "bind minimal" — see the comment there):
 *   GOOGLE_OAUTH_CLIENT_ID              existing secret (already used by youtubeOAuthLifecycle.ts).
 *   GOOGLE_OAUTH_CLIENT_SECRET          existing secret (already used by youtubeOAuthLifecycle.ts).
 *   YOUTUBE_OAUTH_CREDENTIAL_ENCRYPTION_KEY
 *                                        existing production secret (base64, 32 bytes). Used by
 *                                        the production mail credential envelope and OAuth state.
 *   FLU_STAGING_MAIL_OAUTH_ENCRYPTION_KEY
 *                                        staging-only base64 32-byte key used for the hosted
 *                                        staging mail credential envelope and OAuth state. The
 *                                        staging facade binds this key instead of the production
 *                                        YouTube key so staging token material remains isolated.
 *   YOUTUBE_POOL_<ID>_OAUTH_CLIENT_ID / _OAUTH_CLIENT_SECRET
 *                                        Flu/Task-49: a non-growth org's own OAuth client
 *                                        (functions/youtubeQuotaPools.ts resolves which secret
 *                                        names to read per pool; growth keeps using the two
 *                                        names above unchanged). Only read when
 *                                        settings/youtube_quota_pools.byOrgId maps the caller's
 *                                        org away from "growth".
 *   MAIL_OAUTH_REDIRECT_URI             NOT a secret (plain function env var), e.g.
 *                                        "https://<functions-host>/mailOAuthCallback". Must be
 *                                        registered on the Google OAuth client — see
 *                                        docs/PLAN-ORG-MAIL-IDENTITY.md "슬라이스 2 셋업".
 *   FLU_APP_ORIGIN                      NOT a secret. Base URL the browser is redirected back
 *                                        to after consent (defaults to https://sc-flu.web.app,
 *                                        same convention as functions/submissionTasks.ts).
 *
 * This module owns:
 *   - beginMailOAuth / revokeMailOAuth / getMailOAuthStatus callables,
 *   - handleMailOAuthCallback, the pure (req, res, deps) body behind the mailOAuthCallback
 *     onRequest endpoint (functions/index.ts),
 *   - getMailOAuthAccessToken, the read/refresh path Slice 3/4 will call for XOAUTH2,
 *   - the encrypted mail_oauth_credentials/{accountId} envelope (AES-256-GCM, same
 *     construction as youtube_oauth_credentials — see functions/oauthCredentialEnvelope.ts)
 *     and the single-use mail_oauth_states/{nonce} CSRF state doc.
 *
 * Never logs or returns a raw token/code (SEC-P0-009) — getMailOAuthStatus returns a
 * projection only, and errors from Google are reduced to short codes. External calls to
 * Google are gated by assertStagingExternalSideEffectAllowed("oauth") (NET-P0-012 / staging
 * safety, functions/stagingSafety.ts).
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { adminDb } from "./firebaseAdmin";
import {
  assertNonGuestAuth,
  asRecord,
  asString,
  makeBehaviorLog,
  type AuthContext,
  type CallableRequestShape,
} from "./shared";
import {
  clearMailAccountResolutionCache,
  isMailAccountIdSlug,
  isPersonalMailConnectAllowedForOrg,
  readMailAccounts,
  readMailRouting,
  resolveMailAccountForEmail,
  resolveMailAccountsDb,
  MAIL_ACCOUNTS_COLLECTION,
  type MailAccount,
  type MailAccountsFirestoreDb,
} from "./mailAccounts";
import { assertStagingExternalSideEffectAllowed } from "./stagingSafety";
import { resolveOAuthClientSecretNames, resolvePoolIdForOrgIds, readYouTubeQuotaPools } from "./youtubeQuotaPools";
import { YOUTUBE_GROWTH_POOL_ID } from "./apiQuota";
import {
  decryptAesGcm,
  encryptAesGcm,
  encryptionKeyVersion,
  parseEncryptionKey,
  stableStringify,
  type AesGcmCiphertext,
  type OAuthEnvelopeError,
} from "./oauthCredentialEnvelope";

export const MAIL_OAUTH_STATES_COLLECTION = "mail_oauth_states";
export const MAIL_OAUTH_CREDENTIALS_COLLECTION = "mail_oauth_credentials";
/** Google OAuth redirect URI for the hosted staging callback rewrite. */
export const STAGING_MAIL_OAUTH_CALLBACK_URL =
  "https://influchat-77db6.web.app/mailOAuthCallback" as const;
/** Safe return origin for the hosted staging callback. */
export const STAGING_MAIL_OAUTH_APP_ORIGIN =
  "https://influchat-77db6.web.app" as const;
export const STAGING_MAIL_OAUTH_ENCRYPTION_KEY_SECRET =
  "FLU_STAGING_MAIL_OAUTH_ENCRYPTION_KEY" as const;
const MAIL_OAUTH_STATE_DOMAIN = "mail-oauth-state-v1";
const MAIL_OAUTH_SCOPE = "https://mail.google.com/ openid email";
// Flu/Task-49 재리뷰 P1-3: growth 풀은 위 MAIL_OAUTH_SCOPE 그대로(바이트 동일 — 기존 연결 계정
// 무영향). 비-growth 풀(드라마 등)만 동의 시 youtube.readonly를 추가로 요청해, 그 풀의 mail_oauth
// 계정으로도 YouTube Data API를 (그 풀 자신의 쿼터로) 호출할 수 있게 한다.
const YOUTUBE_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
function mailOAuthScopeForPool(poolId: string): string {
  return poolId === YOUTUBE_GROWTH_POOL_ID ? MAIL_OAUTH_SCOPE : `${MAIL_OAUTH_SCOPE} ${YOUTUBE_READONLY_SCOPE}`;
}
const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;
// flu.supercent.io never had a DNS record (NXDOMAIN) — an assumed-future custom domain that was
// never provisioned. The real production Hosting site is sc-flu.web.app (mailSignature.ts's
// MAIL_PUBLIC_HOST, deploy-prod smoke target). Keep the default pointed at the live origin so a
// missing FLU_APP_ORIGIN can never strand a completed OAuth browser on a dead domain again.
const DEFAULT_APP_ORIGIN = "https://sc-flu.web.app";
const SUPERCENT_WORKSPACE_DOMAIN = "supercent.io";

export type MailOAuthConfigurationCode =
  | "missing_client_id"
  | "missing_client_secret"
  | "missing_encryption_key"
  | "missing_redirect_uri"
  | "callback_mismatch"
  | "disabled_in_staging";

type MailOAuthEnvironmentSource = {
  readonly FLU_RUNTIME_ENV?: string;
  readonly FLU_FIRESTORE_DATABASE?: string;
  readonly FLU_STAGING_MAIL_OAUTH_MODE?: string;
  readonly FLU_APP_ORIGIN?: string;
  readonly FLU_STAGING_MAIL_OAUTH_ENCRYPTION_KEY?: string;
  readonly MAIL_OAUTH_REDIRECT_URI?: string;
  readonly GOOGLE_OAUTH_CLIENT_ID?: string;
  readonly GOOGLE_OAUTH_CLIENT_SECRET?: string;
  readonly YOUTUBE_OAUTH_CREDENTIAL_ENCRYPTION_KEY?: string;
  readonly YOUTUBE_POOL_DRAMA_1_OAUTH_CLIENT_ID?: string;
  readonly YOUTUBE_POOL_DRAMA_1_OAUTH_CLIENT_SECRET?: string;
};

function isStagingMailOAuthSource(source: MailOAuthEnvironmentSource): boolean {
  // The runtime guard validates the full staging/database pair before any handler runs. This
  // small source-aware check keeps the pure configuration helpers usable in tests and discovery
  // without consulting the module-load snapshot in runtimeEnvironment.ts.
  return source.FLU_RUNTIME_ENV === "staging";
}

function readMailOAuthEncryptionKey(source: MailOAuthEnvironmentSource = process.env): string {
  const value = isStagingMailOAuthSource(source)
    ? source.FLU_STAGING_MAIL_OAUTH_ENCRYPTION_KEY
    : source.YOUTUBE_OAUTH_CREDENTIAL_ENCRYPTION_KEY;
  return value?.trim() ?? "";
}

export function resolveMailOAuthRedirectUri(
  value: unknown = process.env.MAIL_OAUTH_REDIRECT_URI,
  source: MailOAuthEnvironmentSource = process.env,
): { readonly uri: string; readonly code: MailOAuthConfigurationCode | null } {
  const uri = typeof value === "string" ? value.trim() : "";
  if (!uri) return { uri: "", code: "missing_redirect_uri" };
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return { uri, code: "callback_mismatch" };
    }
  } catch {
    return { uri, code: "callback_mismatch" };
  }
  if (isStagingMailOAuthSource(source) && uri !== STAGING_MAIL_OAUTH_CALLBACK_URL) {
    return { uri, code: "callback_mismatch" };
  }
  return { uri, code: null };
}

/**
 * The callback's return origin is a controlled deployment value. In hosted
 * staging, default to the staging Hosting site so an omitted env cannot send
 * a completed OAuth browser to the production app.
 */
export function resolveMailOAuthAppOrigin(
  value: unknown = process.env.FLU_APP_ORIGIN,
  source: MailOAuthEnvironmentSource = process.env,
): string {
  const configured = typeof value === "string" ? value.trim() : "";
  const fallback = isStagingMailOAuthSource(source) ? STAGING_MAIL_OAUTH_APP_ORIGIN : DEFAULT_APP_ORIGIN;
  if (!configured) return fallback;
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return fallback;
    }
    if (isStagingMailOAuthSource(source) && parsed.origin !== STAGING_MAIL_OAUTH_APP_ORIGIN) {
      return fallback;
    }
    return parsed.origin;
  } catch {
    return fallback;
  }
}

/** Safe readiness projection used by getIntegrations; values themselves never leave the server. */
export function readMailOAuthConfiguration(
  source: MailOAuthEnvironmentSource = process.env,
): {
  readonly configured: boolean;
  readonly ready: boolean;
  readonly code: MailOAuthConfigurationCode | null;
  readonly callbackUrl: string | null;
  readonly appOrigin: string;
  readonly appOriginFromEnv: boolean;
} {
  const clientId = source.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? "";
  const clientSecret = source.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? "";
  const encryptionKey = readMailOAuthEncryptionKey(source);
  const dramaClientId = source.YOUTUBE_POOL_DRAMA_1_OAUTH_CLIENT_ID?.trim() ?? "";
  const dramaClientSecret = source.YOUTUBE_POOL_DRAMA_1_OAUTH_CLIENT_SECRET?.trim() ?? "";
  const redirect = resolveMailOAuthRedirectUri(source.MAIL_OAUTH_REDIRECT_URI, source);
  let encryptionKeyValid = false;
  if (encryptionKey) {
    try {
      parseEncryptionKey(encryptionKey);
      encryptionKeyValid = true;
    } catch {
      encryptionKeyValid = false;
    }
  }
  let code: MailOAuthConfigurationCode | null = null;
  if (!clientId || !dramaClientId) code = "missing_client_id";
  else if (!clientSecret || !dramaClientSecret) code = "missing_client_secret";
  else if (!encryptionKeyValid) code = "missing_encryption_key";
  else if (redirect.code) code = redirect.code;
  else if (isStagingMailOAuthSource(source) && source.FLU_STAGING_MAIL_OAUTH_MODE !== "live-e2e") {
    code = "disabled_in_staging";
  }
  const configured = code !== "missing_client_id"
    && code !== "missing_client_secret"
    && code !== "missing_encryption_key"
    && code !== "missing_redirect_uri"
    && code !== "callback_mismatch";
  return {
    configured,
    ready: configured && code === null,
    code,
    callbackUrl: redirect.uri || null,
    // The post-consent browser redirect target. readiness used to hide this entirely, so an
    // unset/dead FLU_APP_ORIGIN reported ready=true while the callback redirected to NXDOMAIN.
    appOrigin: resolveMailOAuthAppOrigin(source.FLU_APP_ORIGIN, source),
    appOriginFromEnv: Boolean(source.FLU_APP_ORIGIN?.trim()),
  };
}

type FetchLike = typeof fetch;

// ---------- errors ----------

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), {
    code: "invalid-argument",
    errorCode: "mail_oauth_invalid_argument",
  });
}

function permissionDenied(message: string): Error {
  return Object.assign(new Error(`permission-denied: ${message}`), {
    code: "permission-denied",
    errorCode: "mail_oauth_permission_denied",
  });
}

/** Internal lifecycle/envelope error for callers of getMailOAuthAccessToken (Slice 3/4). */
export class MailOAuthError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "MailOAuthError";
    this.code = code;
  }
}

// ---------- mail_oauth_states / mail_oauth_credentials Firestore seam ----------
// Separate from mailAccounts.ts's MailAccountsFirestoreDb seam (which only owns
// mail_accounts/settings/mail_routing) because revokeMailOAuth needs to delete a credential
// doc outright, mirroring the "each module owns a minimal seam" pattern already used by
// functions/goldenSet.ts and functions/mailAccounts.ts.

type MailOAuthFirestoreDocSnapshot = {
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
};

type MailOAuthFirestoreDocRef = {
  get(): Promise<MailOAuthFirestoreDocSnapshot>;
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
  delete(): Promise<unknown>;
};

export type MailOAuthFirestoreDb = {
  collection(name: string): { doc(id: string): MailOAuthFirestoreDocRef };
};

let oauthDbOverrideForTests: MailOAuthFirestoreDb | null = null;
let oauthFetchOverrideForTests: FetchLike | null = null;

/** Test-only seam for mail_oauth_states/mail_oauth_credentials (mirrors setMailAccountsDbForTests). */
export function setMailOAuthDbForTests(db: MailOAuthFirestoreDb | null): void {
  oauthDbOverrideForTests = db;
}

/** Test-only seam for the Google HTTP calls this module makes (mirrors setPeoplyClientForTests). */
export function setMailOAuthFetchForTests(fetchImpl: FetchLike | null): void {
  oauthFetchOverrideForTests = fetchImpl;
}

function resolveMailOAuthDb(explicit?: MailOAuthFirestoreDb): MailOAuthFirestoreDb {
  return explicit ?? oauthDbOverrideForTests ?? (adminDb as unknown as MailOAuthFirestoreDb);
}

type MailOAuthStateConsumeOutcome = "ok" | "not_found" | "reused" | "mismatch";

/**
 * 2026-09-10 adversarial review MEDIUM-6: consumes (marks usedAt on) the state doc atomically
 * when the underlying Firestore client supports transactions — always true for the real adminDb
 * (resolveMailOAuthDb's fallback), so two concurrent callback requests replaying the same state
 * token can never both pass the "not yet used" check; the loser gets a distinct "reused" outcome
 * instead of silently racing to exchange the same authorization code twice. Test doubles
 * injected via setMailOAuthDbForTests don't implement runTransaction (no concurrency to guard
 * there either) and fall back to the previous non-atomic get-then-set, unchanged.
 */
async function consumeMailOAuthState(
  oauthDb: MailOAuthFirestoreDb,
  stateRef: MailOAuthFirestoreDocRef,
  state: MailOAuthState,
  nowIso: string,
): Promise<MailOAuthStateConsumeOutcome> {
  const evaluate = (record: Record<string, unknown>): MailOAuthStateConsumeOutcome => {
    const alreadyUsed = record.usedAt !== null && record.usedAt !== undefined;
    if (alreadyUsed) return "reused";
    if (asString(record.accountId) !== state.accountId || asString(record.uid) !== state.uid) return "mismatch";
    return "ok";
  };
  const transactional = oauthDb as unknown as {
    runTransaction?<T>(fn: (transaction: {
      get(ref: unknown): Promise<MailOAuthFirestoreDocSnapshot>;
      set(ref: unknown, data: Record<string, unknown>, options?: { merge?: boolean }): unknown;
    }) => Promise<T>): Promise<T>;
  };
  if (typeof transactional.runTransaction === "function") {
    return transactional.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(stateRef);
      if (!snapshot.exists) return "not_found";
      const outcome = evaluate(asRecord(snapshot.data()));
      if (outcome === "ok") transaction.set(stateRef, { usedAt: nowIso }, { merge: true });
      return outcome;
    });
  }
  const snapshot = await stateRef.get();
  if (!snapshot.exists) return "not_found";
  const outcome = evaluate(asRecord(snapshot.data()));
  if (outcome === "ok") await stateRef.set({ usedAt: nowIso }, { merge: true });
  return outcome;
}

function resolveMailOAuthFetch(explicit?: FetchLike): FetchLike {
  return explicit ?? oauthFetchOverrideForTests ?? fetch;
}

// ---------- mail_oauth_credentials envelope (own AAD, shared crypto primitives) ----------

export type MailOAuthCredential = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly scopes: string[];
  readonly tokenType: string;
};

export type MailOAuthCredentialEnvelope = {
  readonly version: 1;
  readonly algorithm: "AES-256-GCM";
  readonly keyVersion: string;
  readonly keyEncryption: AesGcmCiphertext;
  readonly payloadEncryption: AesGcmCiphertext;
};

function envelopeAad(prefix: string, accountId: string): Buffer {
  return Buffer.from(`${prefix}:${accountId}`, "utf8");
}

export function encryptMailOAuthCredentialEnvelope(input: {
  credential: MailOAuthCredential;
  encryptionKey: string;
  accountId: string;
}): MailOAuthCredentialEnvelope {
  const keyEncryptionKey = parseEncryptionKey(input.encryptionKey);
  const dataEncryptionKey = randomBytes(32);
  return {
    version: 1,
    algorithm: "AES-256-GCM",
    keyVersion: encryptionKeyVersion(keyEncryptionKey),
    keyEncryption: encryptAesGcm(
      keyEncryptionKey,
      dataEncryptionKey,
      envelopeAad("mail-oauth-key.v1", input.accountId),
    ),
    payloadEncryption: encryptAesGcm(
      dataEncryptionKey,
      Buffer.from(stableStringify(input.credential), "utf8"),
      envelopeAad("mail-oauth-payload.v1", input.accountId),
    ),
  };
}

export function decryptMailOAuthCredentialEnvelope(input: {
  envelope: MailOAuthCredentialEnvelope;
  encryptionKey: string;
  accountId: string;
}): MailOAuthCredential {
  try {
    if (input.envelope.version !== 1 || input.envelope.algorithm !== "AES-256-GCM") {
      throw new Error("unsupported envelope");
    }
    const keyEncryptionKey = parseEncryptionKey(input.encryptionKey);
    if (input.envelope.keyVersion !== encryptionKeyVersion(keyEncryptionKey)) {
      throw new Error("encryption key version mismatch");
    }
    const dataEncryptionKey = decryptAesGcm(
      keyEncryptionKey,
      input.envelope.keyEncryption,
      envelopeAad("mail-oauth-key.v1", input.accountId),
    );
    if (dataEncryptionKey.length !== 32) throw new Error("invalid data key");
    const plaintext = decryptAesGcm(
      dataEncryptionKey,
      input.envelope.payloadEncryption,
      envelopeAad("mail-oauth-payload.v1", input.accountId),
    );
    return normalizeMailOAuthCredential(JSON.parse(plaintext.toString("utf8")));
  } catch (error) {
    if ((error as OAuthEnvelopeError)?.code === "encryption_unavailable") throw error;
    throw new MailOAuthError("credential_decrypt_failed", "credential decrypt failed");
  }
}

function normalizeMailOAuthCredential(value: unknown): MailOAuthCredential {
  const record = asRecord(value);
  const accessToken = asString(record.accessToken);
  const refreshToken = asString(record.refreshToken);
  const expiresAt = asString(record.expiresAt);
  const tokenType = asString(record.tokenType);
  const scopes = Array.isArray(record.scopes)
    ? record.scopes.filter((item): item is string => typeof item === "string")
    : null;
  if (!accessToken || !refreshToken || !expiresAt || !tokenType || !scopes) {
    throw new MailOAuthError("credential_decrypt_failed", "credential decrypt failed");
  }
  return { accessToken, refreshToken, expiresAt, scopes, tokenType };
}

// ---------- OAuth `state` param: HMAC-signed, single-use, domain-separated ----------

type MailOAuthState = {
  readonly accountId: string;
  readonly uid: string;
  readonly nonce: string;
  readonly exp: number; // unix seconds
};

/**
 * 2026-09-10 adversarial review MEDIUM-6: derives a key dedicated to state-HMAC via HKDF-SHA256
 * from the envelope encryption key (info-separated by MAIL_OAUTH_STATE_DOMAIN) instead of
 * reusing that raw key directly for a second cryptographic purpose (AES-GCM envelope encryption
 * elsewhere in this module vs. HMAC here). The message-level domain prefix
 * (`${MAIL_OAUTH_STATE_DOMAIN}\n${payload}`) below is kept as a second, independent layer.
 */
function deriveMailOAuthStateKey(envelopeKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", envelopeKey, Buffer.alloc(0), MAIL_OAUTH_STATE_DOMAIN, 32));
}

function signMailOAuthState(state: MailOAuthState, key: Buffer): string {
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  const signature = createHmac("sha256", key)
    .update(`${MAIL_OAUTH_STATE_DOMAIN}\n${payload}`)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function verifyMailOAuthState(token: string, key: Buffer, now: Date): MailOAuthState | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expected = createHmac("sha256", key)
    .update(`${MAIL_OAUTH_STATE_DOMAIN}\n${payload}`)
    .digest("base64url");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(signature, "utf8");
  if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const record = asRecord(decoded);
  const accountId = asString(record.accountId);
  const uid = asString(record.uid);
  const nonce = asString(record.nonce);
  const exp = Number(record.exp);
  if (!accountId || !uid || !nonce || !Number.isInteger(exp)) return null;
  if (exp < Math.floor(now.getTime() / 1000)) return null;
  return { accountId, uid, nonce, exp };
}

// ---------- self-service account slug allocation ----------

function slugifyLocalPart(email: string): string {
  const local = (email.split("@")[0] ?? "").toLowerCase();
  let slug = local.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) slug = "user";
  while (slug.length < 2) slug += "0";
  return slug.slice(0, 41);
}

function uniqueAccountIdSlug(email: string, takenIds: ReadonlySet<string>): string {
  const base = slugifyLocalPart(email);
  if (!takenIds.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`.slice(0, 41);
    if (!takenIds.has(candidate)) return candidate;
  }
  throw invalidArgument("could not allocate a unique mail account id");
}

function isAlreadyExistsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === 6 || code === "already-exists";
}

const SELF_SERVICE_ACCOUNT_CREATE_ATTEMPTS = 5;

/** Finds the caller's own active-or-pending workspace_oauth account, or provisions one. */
async function findOrCreateOwnWorkspaceOAuthAccount(
  callerEmail: string,
  uid: string,
  displayName?: string,
): Promise<MailAccount> {
  const db = resolveMailAccountsDb();
  for (let attempt = 0; attempt < SELF_SERVICE_ACCOUNT_CREATE_ATTEMPTS; attempt += 1) {
    const accounts = await readMailAccounts();
    const existing = accounts.find(
      (account) => account.kind === "workspace_oauth" && account.ownerEmail === callerEmail,
    );
    if (existing) return existing;

    const accountId = uniqueAccountIdSlug(callerEmail, new Set(accounts.map((account) => account.accountId)));
    const nowIso = new Date().toISOString();
    const docRef = db.collection(MAIL_ACCOUNTS_COLLECTION).doc(accountId);
    const payload = {
      label: displayName?.trim() || callerEmail,
      mailbox: callerEmail,
      kind: "workspace_oauth",
      status: "pending_auth",
      ownerEmail: callerEmail,
      orgIds: [],
      smtp: {},
      imap: {},
      secretRef: `oauth:${MAIL_OAUTH_CREDENTIALS_COLLECTION}/${accountId}`,
      createdBy: uid,
      createdAt: nowIso,
      updatedBy: uid,
      updatedAt: nowIso,
    };
    // 2026-09-10 adversarial review MEDIUM-6: "create only if absent" — a plain .set() would
    // silently overwrite a doc a concurrent self-service connect for the SAME email just
    // created for the same slug (lost update). Real Firestore's DocumentReference.create()
    // fails atomically instead of clobbering; on that collision, loop back to a fresh
    // readMailAccounts() (which will now find the just-created doc via `existing`, or compute a
    // different free slug if it was a different email that happened to collide). Test doubles
    // that don't implement .create() (no concurrency to guard against there) fall back to
    // .set(), unchanged from before.
    const createFn = (docRef as unknown as { create?: (data: Record<string, unknown>) => Promise<unknown> }).create;
    try {
      if (typeof createFn === "function") await createFn.call(docRef, payload);
      else await docRef.set(payload);
    } catch (error) {
      if (isAlreadyExistsError(error)) continue;
      throw error;
    }
    clearMailAccountResolutionCache();

    const refreshed = await readMailAccounts();
    const created = refreshed.find((account) => account.accountId === accountId);
    if (!created) throw new Error("mail account self-provisioning failed to persist");
    return created;
  }
  throw new Error("mail account self-provisioning could not allocate a unique account id after retries");
}

// ---------- consent URL ----------

function buildConsentUrl(input: { clientId: string; redirectUri: string; mailbox: string; state: string; scope?: string }): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scope ?? MAIL_OAUTH_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("hd", SUPERCENT_WORKSPACE_DOMAIN);
  url.searchParams.set("login_hint", input.mailbox);
  url.searchParams.set("state", input.state);
  return url.toString();
}

// ---------- beginMailOAuth ----------

export async function beginMailOAuth(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "mail_oauth.begin");
  const data = asRecord(request.data);
  const requestedAccountId = asString(data.accountId);
  const selfService = data.self === true || !requestedAccountId;

  let account: MailAccount;
  if (selfService) {
    const callerEmail = asString(auth.email).toLowerCase();
    if (!callerEmail) throw invalidArgument("caller auth token has no email claim");
    if (!callerEmail.endsWith(`@${SUPERCENT_WORKSPACE_DOMAIN}`)) {
      throw invalidArgument("self-service mail connection requires a supercent.io Workspace address");
    }
    // Flu/Task-48 (조직별 개인 메일 연결 허용): a self-service connect is gated on the caller's
    // org before any mail_accounts doc is created/reused — an org an admin has NOT opted into
    // personalMailAllowedOrgIds (e.g. Growth, until explicitly granted) may never self-connect at
    // all. resolveMailAccountForEmail is used only for its orgId resolution here (fail-open on a
    // Peoply error, same as everywhere else this lookup runs); it is safe to call even before the
    // account exists.
    const [{ orgId: callerOrgId }, routing] = await Promise.all([
      resolveMailAccountForEmail(callerEmail),
      readMailRouting(),
    ]);
    if (!isPersonalMailConnectAllowedForOrg(routing, callerOrgId)) {
      throw permissionDenied("personal mail connection is not allowed for this caller's organization");
    }
    account = await findOrCreateOwnWorkspaceOAuthAccount(callerEmail, auth.userId, auth.name);
  } else {
    if (!isMailAccountIdSlug(requestedAccountId)) {
      throw invalidArgument("accountId must match ^[a-z0-9][a-z0-9-]{1,40}$");
    }
    const accounts = await readMailAccounts();
    const found = accounts.find((item) => item.accountId === requestedAccountId);
    if (!found) throw invalidArgument(`unknown accountId: ${requestedAccountId}`);
    const callerEmail = asString(auth.email).toLowerCase();
    const isOwner = Boolean(callerEmail) && found.ownerEmail === callerEmail;
    const isAdmin = auth.role === "super_admin" || auth.role === "admin";
    if (!isOwner && !isAdmin) {
      throw permissionDenied("only the account owner or an admin may connect this mailbox");
    }
    // Flu/Task-48 adversarial fix P0-1: an owner reconnecting their OWN already-provisioned
    // account (accountId explicit, not the `self` shortcut) must be gated by the same
    // personalMailAllowedOrgIds allowlist the self-service branch above enforces — otherwise a
    // caller whose org lost the allowance could still reconnect via a stale accountId/UI state.
    // admin stays ungated (matches every other admin bypass in this module).
    if (isOwner && !isAdmin) {
      const [{ orgId: ownerOrgId }, routing] = await Promise.all([
        resolveMailAccountForEmail(callerEmail),
        readMailRouting(),
      ]);
      if (!isPersonalMailConnectAllowedForOrg(routing, ownerOrgId)) {
        throw permissionDenied("personal mail connection is not allowed for this caller's organization");
      }
    }
    account = found;
  }

  if (account.kind !== "workspace_oauth") {
    throw invalidArgument(`mail account ${account.accountId} is not a workspace_oauth account`);
  }

  // Flu/Task-49: the OAuth client belongs to the mailbox's own pool (growth's names are
  // GOOGLE_OAUTH_CLIENT_ID/SECRET, unchanged — a non-growth org gets its own client so its
  // consent + later youtube.readonly calls are attributable to that org's GCP project/quota).
  const poolId = await resolvePoolIdForOrgIds(account.orgIds);
  const pools = await readYouTubeQuotaPools();
  const oauthClient = resolveOAuthClientSecretNames(pools, poolId);
  const clientId = process.env[oauthClient.clientIdSecretName]?.trim() ?? "";
  const redirect = resolveMailOAuthRedirectUri();
  const encryptionKeyRaw = readMailOAuthEncryptionKey();
  let configurationCode: MailOAuthConfigurationCode | null = null;
  if (!clientId) configurationCode = "missing_client_id";
  else if (!encryptionKeyRaw) configurationCode = "missing_encryption_key";
  else if (redirect.code) configurationCode = redirect.code;
  if (configurationCode) {
    return {
      ok: false,
      error: { kind: "not_configured", code: configurationCode },
      behaviorLog: makeBehaviorLog(auth, "mail_oauth.begin", "error", "global", 0),
    };
  }
  try {
    // Consent is an external OAuth lane too: do not issue a state/URL while hosted staging is
    // disabled, otherwise the browser could reach Google even though the callback is closed.
    assertStagingExternalSideEffectAllowed("oauth");
  } catch {
    return {
      ok: false,
      error: { kind: "not_configured", code: "disabled_in_staging" },
      behaviorLog: makeBehaviorLog(auth, "mail_oauth.begin", "error", "global", 0),
    };
  }

  const now = Date.now();
  const state: MailOAuthState = {
    accountId: account.accountId,
    uid: auth.userId,
    nonce: randomBytes(16).toString("hex"),
    exp: Math.floor((now + STATE_TTL_MS) / 1000),
  };
  let signedState: string;
  try {
    signedState = signMailOAuthState(state, deriveMailOAuthStateKey(parseEncryptionKey(encryptionKeyRaw)));
  } catch {
    return {
      ok: false,
      error: { kind: "not_configured", code: "missing_encryption_key" },
      behaviorLog: makeBehaviorLog(auth, "mail_oauth.begin", "error", "global", 0),
    };
  }

  const oauthDb = resolveMailOAuthDb();
  await oauthDb.collection(MAIL_OAUTH_STATES_COLLECTION).doc(state.nonce).set({
    accountId: state.accountId,
    uid: state.uid,
    nonce: state.nonce,
    exp: state.exp,
    createdAtIso: new Date(now).toISOString(),
    usedAt: null,
  });

  const consentUrl = buildConsentUrl({
    clientId, redirectUri: redirect.uri, mailbox: account.mailbox, state: signedState,
    scope: mailOAuthScopeForPool(poolId),
  });

  return {
    ok: true,
    consentUrl,
    accountId: account.accountId,
    expiresAtIso: new Date(now + STATE_TTL_MS).toISOString(),
    behaviorLog: makeBehaviorLog(auth, "mail_oauth.begin", "success", "global", 0),
  };
}

// ---------- revokeMailOAuth ----------

export async function revokeMailOAuth(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "mail_oauth.revoke");
  const data = asRecord(request.data);
  const accountId = asString(data.accountId);
  if (!isMailAccountIdSlug(accountId)) throw invalidArgument("accountId must match ^[a-z0-9][a-z0-9-]{1,40}$");

  const accounts = await readMailAccounts();
  const account = accounts.find((item) => item.accountId === accountId);
  if (!account) throw invalidArgument(`unknown accountId: ${accountId}`);
  const callerEmail = asString(auth.email).toLowerCase();
  const isOwner = Boolean(callerEmail) && account.ownerEmail === callerEmail;
  const isAdmin = auth.role === "super_admin" || auth.role === "admin";
  if (!isOwner && !isAdmin) {
    throw permissionDenied("only the account owner or an admin may revoke this mailbox connection");
  }

  const oauthDb = resolveMailOAuthDb();
  const credentialRef = oauthDb.collection(MAIL_OAUTH_CREDENTIALS_COLLECTION).doc(accountId);
  const snapshot = await credentialRef.get();
  if (snapshot.exists) {
    await bestEffortRevokeUpstreamToken(asRecord(snapshot.data()), accountId);
    await credentialRef.delete();
  }

  const db = resolveMailAccountsDb();
  await db.collection(MAIL_ACCOUNTS_COLLECTION).doc(accountId).set(
    { status: "pending_auth", updatedBy: auth.userId, updatedAt: new Date().toISOString() },
    { merge: true },
  );
  clearMailAccountResolutionCache();

  return {
    ok: true,
    accountId,
    behaviorLog: makeBehaviorLog(auth, "mail_oauth.revoke", "success", "global", 0),
  };
}

async function bestEffortRevokeUpstreamToken(record: Record<string, unknown>, accountId: string): Promise<void> {
  const encryptionKeyRaw = readMailOAuthEncryptionKey();
  if (!encryptionKeyRaw || !record.envelope) return;
  try {
    const credential = decryptMailOAuthCredentialEnvelope({
      envelope: record.envelope as MailOAuthCredentialEnvelope,
      encryptionKey: encryptionKeyRaw,
      accountId,
    });
    assertStagingExternalSideEffectAllowed("oauth");
    const fetchImpl = resolveMailOAuthFetch();
    await fetchImpl("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: credential.refreshToken }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Best-effort only: local revocation (credential doc delete + pending_auth) proceeds
    // regardless of whether Google's revoke endpoint succeeds, is unreachable, or is
    // disabled in staging (assertStagingExternalSideEffectAllowed above).
  }
}

// ---------- getMailOAuthStatus ----------

export type MailOAuthConnectionCheckStatus = "verified" | "reauth_required" | "unavailable";

export type MailOAuthConnectionCheck = {
  readonly status: MailOAuthConnectionCheckStatus;
  readonly checkedAt: string;
  readonly reason?: string;
};

/**
 * Explicit connection verification is a self-service operation only. The normal status read is
 * still allowed to inspect an explicitly selected account for manager+ callers, but that scope can
 * never be upgraded into a provider check. Any client-supplied identity/tenant selector is also
 * rejected before reading a credential so a super-admin viewAs payload cannot turn this into an
 * impersonated OAuth check.
 */
function hasMailOAuthVerificationScopeOverride(data: Record<string, unknown>): boolean {
  return [
    "accountId",
    "mailAccountId",
    "sharedAccountId",
    "viewAsUserId",
    "viewAsEmail",
    "tenantId",
    "firebaseTenantId",
    "organizationId",
    "orgId",
    "userId",
    "uid",
    "email",
    "ownerEmail",
  ].some((key) => asString(data[key]) !== "");
}

function mailOAuthConnectionCheck(
  status: MailOAuthConnectionCheckStatus,
  reason?: string,
): MailOAuthConnectionCheck {
  return {
    status,
    checkedAt: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  };
}

function safeMailOAuthVerificationFailure(error: unknown): MailOAuthConnectionCheck {
  // Only fixed, internal lifecycle codes may cross this projection. Never pass through a provider
  // response, fetch error, or decrypt message: those can contain credentials or request details.
  const code = error instanceof MailOAuthError ? error.code : "";
  if (code === "revoked") return mailOAuthConnectionCheck("reauth_required", "invalid_grant");
  if (code === "not_linked") return mailOAuthConnectionCheck("reauth_required", "not_linked");
  if (code === "not_configured") return mailOAuthConnectionCheck("unavailable", "not_configured");
  if (code === "refresh_failed") return mailOAuthConnectionCheck("unavailable", "provider_unavailable");
  if (code === "credential_decrypt_failed") return mailOAuthConnectionCheck("unavailable", "credential_unavailable");
  return mailOAuthConnectionCheck("unavailable", "provider_unavailable");
}

function projectMailOAuthStatus(
  auth: AuthContext,
  accountId: string | null,
  record: Record<string, unknown> | null,
  connectionCheck?: MailOAuthConnectionCheck,
) {
  if (!record) {
    return {
      ok: true,
      accountId,
      linked: false,
      subjectEmail: null as string | null,
      scopes: [] as string[],
      linkedAt: null as string | null,
      expiresAt: null as string | null,
      status: null as string | null,
      ...(connectionCheck ? { connectionCheck } : {}),
      behaviorLog: makeBehaviorLog(auth, "mail_oauth.status", "success", "global", 0),
    };
  }

  const status = asString(record.status) || null;
  return {
    ok: true,
    accountId,
    linked: status === "active",
    subjectEmail: asString(record.subjectEmail) || null,
    scopes: Array.isArray(record.scopes)
      ? record.scopes.filter((item): item is string => typeof item === "string")
      : [],
    linkedAt: asString(record.linkedAt) || null,
    expiresAt: asString(record.expiresAt) || null,
    status,
    ...(connectionCheck ? { connectionCheck } : {}),
    behaviorLog: makeBehaviorLog(auth, "mail_oauth.status", "success", "global", 0),
  };
}

export async function getMailOAuthStatus(request: CallableRequestShape) {
  const data = asRecord(request.data);
  const self = data.self === true;
  const requestedAccountId = asString(data.accountId);
  const verifyConnection = data.verifyConnection === true;

  let auth: AuthContext | undefined;
  let accountId: string | null;

  // Authenticate before evaluating the verification scope so unauthenticated callers do not get
  // a different error merely by setting verifyConnection. This gate runs before any account or
  // credential read for explicit accounts, viewAs, shared-account, or tenant selector payloads.
  if (verifyConnection) {
    auth = assertNonGuestAuth(request, "mail_oauth.status.verify");
    if (hasMailOAuthVerificationScopeOverride(data)) {
      throw permissionDenied("connection verification is limited to the caller's own personal mailbox");
    }
  }

  if (self || !requestedAccountId) {
    auth ??= assertNonGuestAuth(request, "mail_oauth.status.self");
    const callerEmail = asString(auth.email).toLowerCase();
    if (!callerEmail) throw invalidArgument("caller auth token has no email claim");
    const accounts = await readMailAccounts();
    const own = accounts.find((item) => item.kind === "workspace_oauth" && item.ownerEmail === callerEmail);
    accountId = own?.accountId ?? null;
  } else {
    auth ??= assertNonGuestAuth(request, "mail_oauth.status", ["super_admin", "admin", "manager"]);
    if (!isMailAccountIdSlug(requestedAccountId)) {
      throw invalidArgument("accountId must match ^[a-z0-9][a-z0-9-]{1,40}$");
    }
    accountId = requestedAccountId;
  }

  if (!auth) throw new Error("mail OAuth status auth context was not initialized");
  if (!accountId) {
    return projectMailOAuthStatus(
      auth,
      accountId,
      null,
      verifyConnection ? mailOAuthConnectionCheck("reauth_required", "not_linked") : undefined,
    );
  }

  // Explicit verification reaches this point only through the self branch above, with an
  // account selected from the current auth email and kind workspace_oauth. The accountId check
  // above rejects all explicit/shared/tenant/viewAs selectors before this credential read.
  if (verifyConnection) {
    const callerEmail = asString(auth.email).toLowerCase();
    const accounts = await readMailAccounts();
    const own = accounts.find(
      (item) => item.kind === "workspace_oauth"
        && item.ownerEmail === callerEmail
        && item.accountId === accountId,
    );
    if (!own) {
      throw permissionDenied("connection verification is limited to the caller's own personal mailbox");
    }
  }

  const oauthDb = resolveMailOAuthDb();
  const snapshot = await oauthDb.collection(MAIL_OAUTH_CREDENTIALS_COLLECTION).doc(accountId).get();
  if (!snapshot.exists) {
    return projectMailOAuthStatus(
      auth,
      accountId,
      null,
      verifyConnection ? mailOAuthConnectionCheck("reauth_required", "not_linked") : undefined,
    );
  }

  const record = asRecord(snapshot.data());
  if (!verifyConnection) return projectMailOAuthStatus(auth, accountId, record);

  try {
    // Force the existing refresh path even when the cached access token has an hour left. A
    // cached token only proves local metadata is present; the refresh-token exchange is the
    // explicit provider health check. The returned token is intentionally used only inside this
    // function and never projected, logged, or attached to the behavior log.
    const refreshed = await getMailOAuthAccessToken(accountId, { forceRefresh: true });
    const refreshedSnapshot = await oauthDb.collection(MAIL_OAUTH_CREDENTIALS_COLLECTION).doc(accountId).get().catch(() => null);
    const refreshedRecord = refreshedSnapshot?.exists
      ? asRecord(refreshedSnapshot.data())
      : { ...record, expiresAt: refreshed.expiresAt, status: "active" };
    return projectMailOAuthStatus(
      auth,
      accountId,
      refreshedRecord,
      mailOAuthConnectionCheck("verified"),
    );
  } catch (error) {
    // invalid_grant has already gone through getMailOAuthAccessToken's existing revoked +
    // pending_auth transition. Re-read only safe metadata so the UI receives the updated status;
    // all other provider/config/network failures remain an unavailable check and leave metadata
    // untouched.
    const latestSnapshot = await oauthDb.collection(MAIL_OAUTH_CREDENTIALS_COLLECTION).doc(accountId).get().catch(() => null);
    const latestRecord = latestSnapshot?.exists
      ? asRecord(latestSnapshot.data())
      : error instanceof MailOAuthError && error.code === "revoked"
        ? { ...record, status: "revoked" }
        : record;
    return projectMailOAuthStatus(
      auth,
      accountId,
      latestRecord,
      safeMailOAuthVerificationFailure(error),
    );
  }
}

// ---------- getMailOAuthAccessToken (Slice 3/4 consumer path — not a callable) ----------

export type GetMailOAuthAccessTokenDeps = {
  db?: MailAccountsFirestoreDb;
  oauthDb?: MailOAuthFirestoreDb;
  fetchImpl?: FetchLike;
  now?: Date;
  encryptionKey?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  /** Internal explicit-health-check override; normal transport calls retain cached-token behavior. */
  forceRefresh?: boolean;
};

export type MailOAuthAccessToken = {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly subjectEmail: string;
  // Flu/Task-49 재리뷰 P1-3: 이 자격증명이 연결될 때 쓴 풀(consent 시점 handleMailOAuthCallback이
  // 저장) — fetchYouTubeWithMailOAuth(functions/youtubeReadonlyOAuth.ts)가 그 풀의 원장에 유닛을
  // 기록하는 데 쓴다. growth로 연결된 계정은 항상 "growth".
  readonly poolId: string;
};

export async function getMailOAuthAccessToken(
  accountId: string,
  deps: GetMailOAuthAccessTokenDeps = {},
): Promise<MailOAuthAccessToken> {
  const now = deps.now ?? new Date();
  const encryptionKey = deps.encryptionKey ?? readMailOAuthEncryptionKey();
  const oauthDb = resolveMailOAuthDb(deps.oauthDb);
  const credentialRef = oauthDb.collection(MAIL_OAUTH_CREDENTIALS_COLLECTION).doc(accountId);
  const snapshot = await credentialRef.get();
  if (!snapshot.exists) throw new MailOAuthError("not_linked", "no mail OAuth credential is linked for this account");
  const data = asRecord(snapshot.data());
  if (data.status !== "active") throw new MailOAuthError("revoked", "mail OAuth credential is not active");
  const subjectEmail = asString(data.subjectEmail);
  // Flu/Task-49: reuse the pool the credential was originally linked under (stored at consent
  // time in handleMailOAuthCallback below), not a fresh account.orgIds lookup — a refresh token
  // minted by pool X's client can only ever be exchanged against pool X's client secret. Read
  // unconditionally (not just on the refresh branch below) so both return paths carry it.
  const poolId = asString(data.poolId, YOUTUBE_GROWTH_POOL_ID);

  const credential = decryptMailOAuthCredentialEnvelope({
    envelope: data.envelope as MailOAuthCredentialEnvelope,
    encryptionKey,
    accountId,
  });

  const expiresAtMs = Date.parse(credential.expiresAt);
  if (!deps.forceRefresh && Number.isFinite(expiresAtMs) && expiresAtMs - now.getTime() > REFRESH_SKEW_MS) {
    return { accessToken: credential.accessToken, expiresAt: credential.expiresAt, subjectEmail, poolId };
  }

  const pools = await readYouTubeQuotaPools();
  const oauthClient = resolveOAuthClientSecretNames(pools, poolId);
  const googleClientId = deps.googleClientId ?? process.env[oauthClient.clientIdSecretName] ?? "";
  const googleClientSecret = deps.googleClientSecret ?? process.env[oauthClient.clientSecretSecretName] ?? "";
  if (!googleClientId || !googleClientSecret) {
    throw new MailOAuthError("not_configured", "Google OAuth client is not configured");
  }
  assertStagingExternalSideEffectAllowed("oauth");

  const fetchImpl = resolveMailOAuthFetch(deps.fetchImpl);
  const tokenResponse = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: googleClientId,
      client_secret: googleClientSecret,
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const tokenBody = await boundedJson(tokenResponse, 32 * 1024);
  if (!tokenResponse.ok) {
    if (tokenResponse.status === 400 && asString(tokenBody.error) === "invalid_grant") {
      const nowIso = now.toISOString();
      await credentialRef.set({ status: "revoked", updatedAtIso: nowIso }, { merge: true });
      const db = resolveMailAccountsDb(deps.db);
      await db.collection(MAIL_ACCOUNTS_COLLECTION).doc(accountId).set(
        { status: "pending_auth", updatedAt: nowIso },
        { merge: true },
      );
      clearMailAccountResolutionCache();
      throw new MailOAuthError("revoked");
    }
    throw new MailOAuthError("refresh_failed", "mail OAuth token refresh failed");
  }

  const accessToken = asString(tokenBody.access_token);
  const expiresIn = Number(tokenBody.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn < 60) {
    throw new MailOAuthError("refresh_failed", "mail OAuth token refresh returned an invalid response");
  }
  const refreshedCredential: MailOAuthCredential = {
    accessToken,
    refreshToken: credential.refreshToken,
    expiresAt: new Date(now.getTime() + Math.floor(expiresIn * 1000)).toISOString(),
    scopes: credential.scopes,
    tokenType: asString(tokenBody.token_type, credential.tokenType),
  };
  const envelope = encryptMailOAuthCredentialEnvelope({ credential: refreshedCredential, encryptionKey, accountId });
  await credentialRef.set({
    envelope,
    expiresAt: refreshedCredential.expiresAt,
    scopes: refreshedCredential.scopes,
    updatedAtIso: now.toISOString(),
  }, { merge: true });

  return { accessToken: refreshedCredential.accessToken, expiresAt: refreshedCredential.expiresAt, subjectEmail, poolId };
}

// ---------- mailOAuthCallback (onRequest handler body) ----------

export type MailOAuthCallbackRequestLike = {
  readonly method: string;
  readonly query?: Record<string, unknown>;
};

export type MailOAuthCallbackResponseLike = {
  set(key: string, value: string): unknown;
  status(code: number): unknown;
  redirect(url: string): unknown;
  send(body?: unknown): unknown;
};

export type MailOAuthCallbackDeps = {
  db?: MailAccountsFirestoreDb;
  oauthDb?: MailOAuthFirestoreDb;
  fetchImpl?: FetchLike;
  now?: Date;
  encryptionKey?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  redirectUri?: string;
  appOrigin?: string;
};

export async function handleMailOAuthCallback(
  req: MailOAuthCallbackRequestLike,
  res: MailOAuthCallbackResponseLike,
  deps: MailOAuthCallbackDeps = {},
): Promise<void> {
  res.set("Cache-Control", "no-store");
  res.set("X-Content-Type-Options", "nosniff");

  const appOrigin = resolveMailOAuthAppOrigin(deps.appOrigin);
  const redirectTo = (code: string, extra: Record<string, string> = {}): void => {
    const url = new URL("/admin/integrations", appOrigin);
    url.searchParams.set("mailOAuth", code);
    for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
    res.redirect(url.toString());
  };

  if (req.method !== "GET") {
    res.status(405);
    res.send();
    return;
  }

  const now = deps.now ?? new Date();
  const query = req.query ?? {};
  const stateToken = asString(query.state);
  const code = asString(query.code);
  const errorParam = asString(query.error);

  const encryptionKeyRaw = deps.encryptionKey ?? readMailOAuthEncryptionKey();
  let key: Buffer;
  try {
    key = parseEncryptionKey(encryptionKeyRaw);
  } catch {
    redirectTo("error");
    return;
  }

  const state = stateToken ? verifyMailOAuthState(stateToken, deriveMailOAuthStateKey(key), now) : null;
  if (!state) {
    redirectTo("denied");
    return;
  }

  const oauthDb = resolveMailOAuthDb(deps.oauthDb);
  const stateRef = oauthDb.collection(MAIL_OAUTH_STATES_COLLECTION).doc(state.nonce);
  // Single-use: consumed atomically (real Firestore) before doing anything else, denied-consent
  // included, so a replayed state (this same link opened twice, or two concurrent requests
  // racing the same token) can never be exchanged twice — see consumeMailOAuthState.
  const consumeOutcome = await consumeMailOAuthState(oauthDb, stateRef, state, now.toISOString());
  if (consumeOutcome === "not_found" || consumeOutcome === "mismatch") {
    redirectTo("denied");
    return;
  }
  if (consumeOutcome === "reused") {
    redirectTo("state_reused");
    return;
  }

  if (errorParam) {
    redirectTo("denied");
    return;
  }
  if (!code) {
    redirectTo("error");
    return;
  }

  const db = resolveMailAccountsDb(deps.db);
  const accounts = await readMailAccounts({ db });
  const account = accounts.find((item) => item.accountId === state.accountId);
  if (!account || account.kind !== "workspace_oauth") {
    redirectTo("error");
    return;
  }

  // Flu/Task-49: same pool resolution as beginMailOAuth (fresh, independent lookup — this handler
  // never trusts a client-supplied poolId, only account.orgIds resolved server-side here).
  const poolId = await resolvePoolIdForOrgIds(account.orgIds);
  const pools = await readYouTubeQuotaPools();
  const oauthClient = resolveOAuthClientSecretNames(pools, poolId);
  const googleClientId = (deps.googleClientId ?? process.env[oauthClient.clientIdSecretName] ?? "").trim();
  const googleClientSecret = (deps.googleClientSecret ?? process.env[oauthClient.clientSecretSecretName] ?? "").trim();
  const redirect = resolveMailOAuthRedirectUri(deps.redirectUri);
  if (!googleClientId || !googleClientSecret || redirect.code) {
    redirectTo("error");
    return;
  }

  try {
    assertStagingExternalSideEffectAllowed("oauth");
  } catch {
    redirectTo("error");
    return;
  }

  const fetchImpl = resolveMailOAuthFetch(deps.fetchImpl);
  let tokenBody: Record<string, unknown>;
  try {
    const tokenResponse = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        redirect_uri: redirect.uri,
        grant_type: "authorization_code",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    tokenBody = await boundedJson(tokenResponse, 32 * 1024);
    if (!tokenResponse.ok) {
      redirectTo("error");
      return;
    }
  } catch {
    redirectTo("error");
    return;
  }

  const accessToken = asString(tokenBody.access_token);
  const refreshToken = asString(tokenBody.refresh_token);
  const idToken = asString(tokenBody.id_token);
  const expiresIn = Number(tokenBody.expires_in);
  if (!accessToken || !refreshToken || !idToken || !Number.isFinite(expiresIn) || expiresIn < 60) {
    redirectTo("error");
    return;
  }

  // id_token came directly from Google's token endpoint over TLS, in exchange for a code
  // this handler itself just sent — no third party could have substituted it in transit, so
  // no JWT signature verification is needed here (unlike an ID token a browser hands us).
  const idTokenPayload = decodeIdTokenPayload(idToken);
  // 2026-09-10 adversarial review MEDIUM-6: verify this id_token actually came from Google's own
  // issuer and was minted for OUR OAuth client, before trusting any of its claims — an id_token
  // without a matching iss/aud is not one Google's token endpoint could have legitimately issued
  // for this exchange, so store nothing and stop here rather than falling through to the
  // mailbox/hd checks below.
  const iss = asString(idTokenPayload?.iss);
  const aud = asString(idTokenPayload?.aud);
  if ((iss !== "https://accounts.google.com" && iss !== "accounts.google.com") || aud !== googleClientId) {
    redirectTo("token_invalid");
    return;
  }
  const claimedEmail = asString(idTokenPayload?.email).toLowerCase();
  const emailVerified = idTokenPayload?.email_verified === true || idTokenPayload?.email_verified === "true";
  const hd = asString(idTokenPayload?.hd).toLowerCase();
  if (!claimedEmail || claimedEmail !== account.mailbox || !emailVerified || hd !== SUPERCENT_WORKSPACE_DOMAIN) {
    redirectTo("mailbox_mismatch");
    return;
  }

  const scopes = asString(tokenBody.scope).split(/\s+/).filter(Boolean);
  const credential: MailOAuthCredential = {
    accessToken,
    refreshToken,
    expiresAt: new Date(now.getTime() + Math.floor(expiresIn * 1000)).toISOString(),
    scopes,
    tokenType: asString(tokenBody.token_type, "Bearer"),
  };
  const envelope = encryptMailOAuthCredentialEnvelope({
    credential,
    encryptionKey: encryptionKeyRaw,
    accountId: account.accountId,
  });
  const nowIso = now.toISOString();

  await oauthDb.collection(MAIL_OAUTH_CREDENTIALS_COLLECTION).doc(account.accountId).set({
    provider: "google_mail",
    envelope,
    subjectEmail: claimedEmail,
    scopes,
    expiresAt: credential.expiresAt,
    status: "active",
    linkedBy: state.uid,
    linkedAt: nowIso,
    updatedAtIso: nowIso,
    // Flu/Task-49: which pool's OAuth client this consent used — getMailOAuthAccessToken reads
    // this back (not account.orgIds again) so a later org remapping can never change which
    // client a refresh uses for an already-linked credential (SEC-P0-004 style pinning).
    poolId,
  });
  await db.collection(MAIL_ACCOUNTS_COLLECTION).doc(account.accountId).set(
    { status: "active", updatedBy: state.uid, updatedAt: nowIso },
    { merge: true },
  );
  clearMailAccountResolutionCache();

  redirectTo("ok", { accountId: account.accountId });
}

function decodeIdTokenPayload(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    return asRecord(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

async function boundedJson(response: Response, maximumBytes: number): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maximumBytes) return {};
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return {};
  }
}
