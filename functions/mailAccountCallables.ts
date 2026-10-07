/**
 * Callable handlers for functions/mailAccounts.ts (PLAN-ORG-MAIL-IDENTITY Slice 1).
 *
 * listMailAccounts / resolveMyMailAccount are read-only (manager+ / any non-guest).
 * upsertMailAccount / setMailRouting are admin+ writes; setMemberMailAccountAccess is
 * super_admin-only. All return `behaviorLog` so
 * the shared callable() wrapper in functions/index.ts (persistCallableOutcome) writes
 * it to `behavior_logs` — the same audit mechanism updateIntegration relies on, no
 * separate audit collection needed here.
 *
 * Style mirrors functions/peoplyCallables.ts: RBAC via assertNonGuestAuth, plain
 * invalid-argument throws for bad input (no Peoply upstream involved in writes, so no
 * non-throwing error envelope is needed there). resolveMyMailAccount/getMyOrgContext use the
 * strict verified sender policy; the legacy resolver's concrete default-account fallback remains
 * reserved for infrastructure call sites (see functions/mailAccounts.ts).
 */
import { assertNonGuestAuth, asRecord, asString, isRole, makeBehaviorLog, type AuthContext, type CallableRequestShape, type Role } from "./shared";
import {
  clearMailAccountResolutionCache,
  containsForbiddenPublicConfigField,
  isMailAccountIdSlug,
  isMailAccountKind,
  isMailAccountStatus,
  isPersonalMailConnectAllowedForOrg,
  isValidMailAccountSecretRef,
  normalizeAccountMailbox,
  listAccessibleMailAccountsForEmail,
  readMailAccounts,
  readMailRouting,
  resolveMailAccountForEmail,
  resolveMailSenderPolicyForEmail,
  resolveMailAccountsDb,
  toMailAccountPublic,
  DEFAULT_MAIL_ROUTING_POLICY_VERSION,
  MAIL_ACCOUNTS_COLLECTION,
  MAIL_ACCOUNT_ACCESS_FIELD,
  MAIL_ROUTING_DOC_PATH,
  PERSONAL_MAIL_ACCOUNT_KINDS,
  type MailAccount,
  type MailAccountKind,
  type MailAccountPublicConfig,
  type MailAccountStatus,
  type MailRouting,
} from "./mailAccounts";
import { CANONICAL_OPERATIONAL_MAILBOX_V1 } from "./mailIdentity";
import { MAIL_OAUTH_CREDENTIALS_COLLECTION } from "./mailOAuth";
import { partnerDataSourceFromNavPreset, resolveNavPresetForOrg } from "./orgTabPresets";
import { getPeoplyClient, PeoplyClientError } from "./peoplyClient";
import { readUserPreference } from "./userPreferences";
import { adminApp, adminAuth, adminAuthTenantId, adminRuntimeEnvironment, parentAdminAuth } from "./firebaseAdmin";
import { maybeProbeStagingTenantAuthLookupPermission, type StagingTenantAuthLookupPermissionProbe } from "./stagingTenantAuthLookupPermissionProbe";

type MailAccountGrantAuthUser = {
  readonly uid: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
};

type MailAccountGrantAuthVerifier = {
  getUser(uid: string, authTenantId?: string): Promise<MailAccountGrantAuthUser>;
};

type ParentMailAccountGrantAuthVerifier = MailAccountGrantAuthVerifier & {
  tenantManager?: () => {
    authForTenant?: (tenantId: string) => MailAccountGrantAuthVerifier;
  };
};

type MailAccountGrantAuthRouting = {
  readonly activeAuth: MailAccountGrantAuthVerifier;
  readonly activeTenantId: string | null;
  readonly parentAuth: ParentMailAccountGrantAuthVerifier;
};

type ResolvedMailAccountGrantAuthVerifier = {
  readonly verifier: MailAccountGrantAuthVerifier;
  /** Whether this is the runtime-selected active Auth instance, not a request-claim inference. */
  readonly usesActiveAuth: boolean;
};

type AccountOwnershipAuthDiagnosticStage = "auth_lookup_unavailable" | "auth_identity_rejected";
type AccountOwnershipAuthIdentityRejectionReason =
  | "uid_mismatch"
  | "email_unverified"
  | "email_missing"
  | "email_mismatch"
  | "not_found"
  | "not_checked";
type AccountOwnershipAuthSdkCode =
  | "auth/insufficient-permission"
  | "auth/invalid-credential"
  | "auth/internal-error"
  | "auth/network-request-failed"
  | "auth/operation-not-allowed"
  | "auth/user-not-found"
  | "permission-denied"
  | "unauthenticated"
  | "unavailable"
  | "not-found"
  | "unknown";
type AccountOwnershipAuthSdkStatus = "400" | "401" | "403" | "404" | "409" | "429" | "500" | "503" | "unknown";
type AccountOwnershipAuthScope = "named" | "default";

export type AccountOwnershipAuthVerificationDiagnostic = {
  readonly stage: AccountOwnershipAuthDiagnosticStage;
  readonly authSdkCode: AccountOwnershipAuthSdkCode;
  readonly authSdkStatus: AccountOwnershipAuthSdkStatus;
  readonly authIdentityRejectionReason: AccountOwnershipAuthIdentityRejectionReason;
  readonly requestedAuthScope: AccountOwnershipAuthScope;
  readonly activeAuthScope: AccountOwnershipAuthScope;
  readonly stagingPermissionProbe: StagingTenantAuthLookupPermissionProbe;
};

const ACCOUNT_OWNERSHIP_AUTH_DIAGNOSTIC_FIELD = "accountOwnershipAuthDiagnostic";
const ACCOUNT_OWNERSHIP_AUTH_SDK_CODES = new Set<AccountOwnershipAuthSdkCode>([
  "auth/insufficient-permission",
  "auth/invalid-credential",
  "auth/internal-error",
  "auth/network-request-failed",
  "auth/operation-not-allowed",
  "auth/user-not-found",
  "permission-denied",
  "unauthenticated",
  "unavailable",
  "not-found",
  "unknown",
]);
const ACCOUNT_OWNERSHIP_AUTH_SDK_STATUSES = new Set<AccountOwnershipAuthSdkStatus>([
  "400", "401", "403", "404", "409", "429", "500", "503",
  "unknown",
]);
const ACCOUNT_OWNERSHIP_AUTH_IDENTITY_REJECTION_REASONS = new Set<AccountOwnershipAuthIdentityRejectionReason>([
  "uid_mismatch",
  "email_unverified",
  "email_missing",
  "email_mismatch",
  "not_found",
  "not_checked",
]);
const STAGING_PERMISSION_PROBE_ATTEMPTS = new Set(["not_attempted", "attempted"]);
const STAGING_PERMISSION_PROBE_OUTCOMES = new Set(["not_attempted", "http_response", "timeout", "credential_error", "network_error", "invalid_response"]);
const STAGING_PERMISSION_PROBE_CREDENTIAL_SOURCES = new Set(["not_used", "admin_app"]);
const STAGING_PERMISSION_PROBE_HTTP_STATUSES = new Set(["not_attempted", "200", "400", "401", "403", "404", "429", "500", "503", "other"]);
const STAGING_PERMISSION_PROBE_GOOGLE_STATUSES = new Set(["not_attempted", "PERMISSION_DENIED", "UNAUTHENTICATED", "INVALID_ARGUMENT", "NOT_FOUND", "FAILED_PRECONDITION", "RESOURCE_EXHAUSTED", "INTERNAL", "UNAVAILABLE", "unknown"]);
const STAGING_PERMISSION_PROBE_REASONS = new Set(["not_attempted", "IAM_PERMISSION_DENIED", "USER_PROJECT_DENIED", "SERVICE_DISABLED", "CONSUMER_INVALID", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "unknown"]);
const STAGING_PERMISSION_PROBE_REASON_SOURCES = new Set(["not_attempted", "structured", "message_hint", "unknown"]);
const STAGING_PERMISSION_PROBE_PERMISSIONS = new Set(["not_attempted", "firebaseauth.users.get", "firebaseauth.configs.get", "identitytoolkit.tenants.get", "serviceusage.services.use", "resourcemanager.projects.get", "unknown"]);

function accountOwnershipAuthScope(value: string | null | undefined): AccountOwnershipAuthScope {
  return value && value !== "default" ? "named" : "default";
}

/** A fixed-enum scope descriptor; never exposes a tenant identifier. */
export function accountOwnershipAuthScopeDiagnostic(authTenantId: string): Pick<
  AccountOwnershipAuthVerificationDiagnostic,
  "requestedAuthScope" | "activeAuthScope"
> {
  return {
    requestedAuthScope: accountOwnershipAuthScope(authTenantId),
    activeAuthScope: accountOwnershipAuthScope(adminAuthTenantId),
  };
}

function accountOwnershipAuthSdkCode(error: unknown): AccountOwnershipAuthSdkCode {
  const record = asRecord(error);
  const errorInfo = asRecord(record.errorInfo);
  const candidates = [record.code, record.errorCode, errorInfo.code];
  for (const candidate of candidates) {
    const code = asString(candidate);
    if (ACCOUNT_OWNERSHIP_AUTH_SDK_CODES.has(code as AccountOwnershipAuthSdkCode)) {
      return code as AccountOwnershipAuthSdkCode;
    }
  }
  return "unknown";
}

function accountOwnershipAuthSdkStatus(error: unknown): AccountOwnershipAuthSdkStatus {
  const record = asRecord(error);
  const candidates = [record.httpStatus, record.statusCode, record.status];
  for (const candidate of candidates) {
    const status = typeof candidate === "number" ? String(candidate) : asString(candidate);
    if (ACCOUNT_OWNERSHIP_AUTH_SDK_STATUSES.has(status as AccountOwnershipAuthSdkStatus)) {
      return status as AccountOwnershipAuthSdkStatus;
    }
  }
  return "unknown";
}

function withAccountOwnershipAuthDiagnostic(
  error: Error,
  stage: AccountOwnershipAuthDiagnosticStage,
  authTenantId: string,
  sourceError?: unknown,
  authIdentityRejectionReason: AccountOwnershipAuthIdentityRejectionReason = "not_checked",
  stagingPermissionProbe?: StagingTenantAuthLookupPermissionProbe,
): Error {
  // Deliberately non-enumerable: callable result persistence and the public error boundary
  // cannot serialize this server-only diagnostic. Every field below is a fixed enum.
  Object.defineProperty(error, ACCOUNT_OWNERSHIP_AUTH_DIAGNOSTIC_FIELD, {
    value: {
      stage,
      authSdkCode: accountOwnershipAuthSdkCode(sourceError),
      authSdkStatus: accountOwnershipAuthSdkStatus(sourceError),
      authIdentityRejectionReason,
      ...accountOwnershipAuthScopeDiagnostic(authTenantId),
      stagingPermissionProbe: stagingPermissionProbe ?? {
        attempt: "not_attempted", outcome: "not_attempted", credentialSource: "not_used", httpStatus: "not_attempted",
        googleStatus: "not_attempted", providerReason: "not_attempted", providerReasonSource: "not_attempted", permissionHint: "not_attempted",
      },
    } satisfies AccountOwnershipAuthVerificationDiagnostic,
    enumerable: false,
  });
  return error;
}

export function accountOwnershipAuthVerificationDiagnostic(error: unknown): AccountOwnershipAuthVerificationDiagnostic | null {
  const diagnostic = asRecord(error)[ACCOUNT_OWNERSHIP_AUTH_DIAGNOSTIC_FIELD];
  if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) return null;
  const record = diagnostic as Record<string, unknown>;
  const stage = asString(record.stage);
  const authSdkCode = asString(record.authSdkCode);
  const authSdkStatus = asString(record.authSdkStatus);
  const authIdentityRejectionReason = asString(record.authIdentityRejectionReason);
  const requestedAuthScope = asString(record.requestedAuthScope);
  const activeAuthScope = asString(record.activeAuthScope);
  const stagingPermissionProbe = asRecord(record.stagingPermissionProbe);
  if (
    (stage !== "auth_lookup_unavailable" && stage !== "auth_identity_rejected")
    || !ACCOUNT_OWNERSHIP_AUTH_SDK_CODES.has(authSdkCode as AccountOwnershipAuthSdkCode)
    || !ACCOUNT_OWNERSHIP_AUTH_SDK_STATUSES.has(authSdkStatus as AccountOwnershipAuthSdkStatus)
    || !ACCOUNT_OWNERSHIP_AUTH_IDENTITY_REJECTION_REASONS.has(authIdentityRejectionReason as AccountOwnershipAuthIdentityRejectionReason)
    || (requestedAuthScope !== "named" && requestedAuthScope !== "default")
    || (activeAuthScope !== "named" && activeAuthScope !== "default")
    || !STAGING_PERMISSION_PROBE_ATTEMPTS.has(asString(stagingPermissionProbe.attempt))
    || !STAGING_PERMISSION_PROBE_OUTCOMES.has(asString(stagingPermissionProbe.outcome))
    || !STAGING_PERMISSION_PROBE_CREDENTIAL_SOURCES.has(asString(stagingPermissionProbe.credentialSource))
    || !STAGING_PERMISSION_PROBE_HTTP_STATUSES.has(asString(stagingPermissionProbe.httpStatus))
    || !STAGING_PERMISSION_PROBE_GOOGLE_STATUSES.has(asString(stagingPermissionProbe.googleStatus))
    || !STAGING_PERMISSION_PROBE_REASONS.has(asString(stagingPermissionProbe.providerReason))
    || !STAGING_PERMISSION_PROBE_REASON_SOURCES.has(asString(stagingPermissionProbe.providerReasonSource))
    || !STAGING_PERMISSION_PROBE_PERMISSIONS.has(asString(stagingPermissionProbe.permissionHint))
  ) return null;
  return {
    stage,
    authSdkCode: authSdkCode as AccountOwnershipAuthSdkCode,
    authSdkStatus: authSdkStatus as AccountOwnershipAuthSdkStatus,
    authIdentityRejectionReason: authIdentityRejectionReason as AccountOwnershipAuthIdentityRejectionReason,
    requestedAuthScope: requestedAuthScope as AccountOwnershipAuthScope,
    activeAuthScope: activeAuthScope as AccountOwnershipAuthScope,
    stagingPermissionProbe: {
      attempt: asString(stagingPermissionProbe.attempt) as StagingTenantAuthLookupPermissionProbe["attempt"],
      outcome: asString(stagingPermissionProbe.outcome) as StagingTenantAuthLookupPermissionProbe["outcome"],
      credentialSource: asString(stagingPermissionProbe.credentialSource) as StagingTenantAuthLookupPermissionProbe["credentialSource"],
      httpStatus: asString(stagingPermissionProbe.httpStatus) as StagingTenantAuthLookupPermissionProbe["httpStatus"],
      googleStatus: asString(stagingPermissionProbe.googleStatus) as StagingTenantAuthLookupPermissionProbe["googleStatus"],
      providerReason: asString(stagingPermissionProbe.providerReason) as StagingTenantAuthLookupPermissionProbe["providerReason"],
      providerReasonSource: asString(stagingPermissionProbe.providerReasonSource) as StagingTenantAuthLookupPermissionProbe["providerReasonSource"],
      permissionHint: asString(stagingPermissionProbe.permissionHint) as StagingTenantAuthLookupPermissionProbe["permissionHint"],
    },
  };
}

let mailAccountGrantAuthVerifierForTests: MailAccountGrantAuthVerifier | null = null;

export function setMailAccountGrantAuthVerifierForTests(verifier: MailAccountGrantAuthVerifier | null): void {
  mailAccountGrantAuthVerifierForTests = verifier;
}

const productionMailAccountGrantAuthRouting: MailAccountGrantAuthRouting = {
  activeAuth: adminAuth as unknown as MailAccountGrantAuthVerifier,
  activeTenantId: adminAuthTenantId,
  parentAuth: parentAdminAuth as unknown as ParentMailAccountGrantAuthVerifier,
};

function resolveMailAccountGrantAuthVerifierSelection(
  authTenantId = "default",
  routing: MailAccountGrantAuthRouting = productionMailAccountGrantAuthRouting,
): ResolvedMailAccountGrantAuthVerifier {
  if (mailAccountGrantAuthVerifierForTests) return { verifier: mailAccountGrantAuthVerifierForTests, usesActiveAuth: false };
  if (authTenantId && authTenantId !== "default") {
    // firebaseAdmin selects this exact tenant for staging. Reuse that
    // TenantAwareAuth directly: it intentionally has no tenantManager().
    if (routing.activeTenantId === authTenantId) return { verifier: routing.activeAuth, usesActiveAuth: true };
    const tenantAuth = routing.parentAuth.tenantManager?.().authForTenant?.(authTenantId);
    if (tenantAuth) return { verifier: tenantAuth, usesActiveAuth: false };
    throw invalidArgument("tenant auth verifier is unavailable");
  }
  return { verifier: routing.activeAuth, usesActiveAuth: true };
}

function resolveMailAccountGrantAuthVerifier(
  authTenantId = "default",
  routing: MailAccountGrantAuthRouting = productionMailAccountGrantAuthRouting,
): MailAccountGrantAuthVerifier {
  return resolveMailAccountGrantAuthVerifierSelection(authTenantId, routing).verifier;
}

/** Test seam for root-vs-tenant Auth routing; production callers use the resolver above. */
export function __testResolveMailAccountGrantAuthVerifier(
  authTenantId: string,
  routing: MailAccountGrantAuthRouting,
): MailAccountGrantAuthVerifier {
  return resolveMailAccountGrantAuthVerifier(authTenantId, routing);
}

/** Test seam proving whether routing selected the configured active Auth instance. */
export function __testResolveMailAccountGrantAuthVerifierSelection(
  authTenantId: string,
  routing: MailAccountGrantAuthRouting,
): Pick<ResolvedMailAccountGrantAuthVerifier, "usesActiveAuth"> {
  const selection = resolveMailAccountGrantAuthVerifierSelection(authTenantId, routing);
  return { usesActiveAuth: selection.usesActiveAuth };
}

function permissionDenied(message: string): Error {
  return Object.assign(new Error(`permission-denied: ${message}`), {
    code: "permission-denied",
    errorCode: "mail_accounts_permission_denied",
  });
}

function authTenantIdFromRequest(request: CallableRequestShape): string {
  const token = asRecord(request.auth?.token);
  const firebase = asRecord(token.firebase);
  return asString(token.tenant) || asString(token.tenantId) || asString(firebase.tenant) || "default";
}

async function verifiedAuthUserForMemberUid(uid: string, memberEmail: string, authTenantId = "default"): Promise<MailAccountGrantAuthUser> {
  const authSelection = resolveMailAccountGrantAuthVerifierSelection(authTenantId);
  let authUser: MailAccountGrantAuthUser;
  try {
    authUser = await authSelection.verifier.getUser(uid, authTenantId);
  } catch (error) {
    const err = asRecord(error);
    const code = asString(err.code) || asString(err.errorCode);
    if (code === "auth/user-not-found" || code === "user-not-found" || code === "not-found") {
      throw withAccountOwnershipAuthDiagnostic(
        invalidArgument("member auth user does not exist"),
        "auth_identity_rejected",
        authTenantId,
        error,
        "not_found",
      );
    }
    const stagingPermissionProbe = code === "auth/insufficient-permission" && authSelection.usesActiveAuth
      ? await maybeProbeStagingTenantAuthLookupPermission({
        uid,
        activeTenantId: adminAuthTenantId,
        activeApp: adminApp,
        environment: process.env,
        runtimeEnvironment: adminRuntimeEnvironment.runtimeEnvironment,
      })
      : undefined;
    throw withAccountOwnershipAuthDiagnostic(Object.assign(new Error("failed-precondition: member auth verification is unavailable"), {
      code: "failed-precondition",
      errorCode: "mail_accounts_auth_verification_unavailable",
    }), "auth_lookup_unavailable", authTenantId, error, "not_checked", stagingPermissionProbe);
  }
  const authEmail = asString(authUser.email).toLowerCase();
  const authIdentityRejectionReason = authUser.uid !== uid
    ? "uid_mismatch"
    : !authUser.emailVerified
      ? "email_unverified"
      : !authEmail
        ? "email_missing"
        : authEmail !== memberEmail
          ? "email_mismatch"
          : null;
  if (authIdentityRejectionReason) {
    throw withAccountOwnershipAuthDiagnostic(
      invalidArgument("member auth user must have a verified email matching the member document"),
      "auth_identity_rejected",
      authTenantId,
      undefined,
      authIdentityRejectionReason,
    );
  }
  return authUser;
}

export async function verifiedAuthEmailForMemberUid(uid: string, memberEmail: string, authTenantId = "default"): Promise<string> {
  const authUser = await verifiedAuthUserForMemberUid(uid, memberEmail, authTenantId);
  return asString(authUser.email).toLowerCase();
}

async function assertActiveSuperAdminMember(auth: AuthContext, db: ReturnType<typeof resolveMailAccountsDb>): Promise<void> {
  const snapshot = await db.collection("members").doc(auth.userId).get();
  if (!snapshot.exists) throw permissionDenied("super_admin member record is required");
  const member = asRecord(snapshot.data());
  if (asString(member.uid) !== auth.userId || asString(member.email).toLowerCase() !== asString(auth.email).toLowerCase()) {
    throw permissionDenied("super_admin member identity must match the authenticated user");
  }
  if (member.status !== "active" || member.role !== "super_admin") {
    throw permissionDenied("super_admin member record must be active");
  }
  await verifiedAuthUserForMemberUid(auth.userId, asString(member.email).toLowerCase());
}

function invalidArgument(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), {
    code: "invalid-argument",
    errorCode: "mail_accounts_invalid_argument",
  });
}

/**
 * Chat 지연 분해 계측(feat/chat-latency-instrument): Promise.all 안에서 병렬로 도는
 * 하위 단계도 각자의 실제 소요 ms 를 잰다 — 반환된 ms 들은 서로 겹칠 수 있으므로
 * 합계가 아니라 "그 단계의 레이턴시"로 읽는다. SEC-P0-009: 숫자만, 내용은 담지 않는다.
 */
async function timedMs<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  return { value: await work, ms: Date.now() - started };
}

/** 2026-09-10 adversarial review CRITICAL-1: distinct errorCode for a rejected secretRef shape,
 * so callers/tests can distinguish this from a generic invalid-argument. */
function invalidSecretRef(message: string): Error {
  return Object.assign(new Error(`invalid-argument: ${message}`), {
    code: "invalid-argument",
    errorCode: "mail_account_secret_ref_invalid",
  });
}

function sanitizeWritablePublicConfig(value: unknown, fieldLabel: string): MailAccountPublicConfig {
  if (value === undefined) return {};
  if (containsForbiddenPublicConfigField(value)) {
    throw invalidArgument(`${fieldLabel} config cannot contain a password/token/secret-looking field`);
  }
  const record = asRecord(value);
  const result: MailAccountPublicConfig = {};
  for (const [key, val] of Object.entries(record)) {
    if (typeof val === "string") result[key] = val.trim().slice(0, 255);
    else if (typeof val === "number" && Number.isFinite(val)) result[key] = val;
    else if (typeof val === "boolean") result[key] = val;
  }
  return result;
}

function asOrgIdArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

function normalizedOrgIdArray(value: unknown): string[] {
  return [...new Set(asOrgIdArray(value).map((id) => id.trim()).filter(Boolean))];
}

/**
 * Flu/Task-48 적대 리뷰 P0-2: setMailRouting 호출마다 현재 active 개인 계정 전부를 새 정책과
 * 대조하는 병렬 상한. 같은 레포 videoViewSnapshots.ts MONITOR_REGISTER_CONCURRENCY 와 같은 값
 * 산정 원칙(검증된 상한) — 여기서는 admin 콘솔의 수동 트리거라 그보다 낮게 잡는다.
 */
const DISABLE_REVOKED_ORGS_CONCURRENCY = 5;

/** 유계 병렬 map — mailAccounts.ts/chat-ai.ts 를 거치지 않으려고 여기 둔다(의존 0), 같은 레포
 * functions/videoViewSnapshots.ts mapWithBoundedConcurrency 와 동형. */
async function mapWithBoundedConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(items.length, Math.trunc(concurrency) || 1));
  let nextIndex = 0;
  const run = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => run()));
}

/**
 * Flu/Task-48 (추가 요구사항) + 2026-09-11 적대 리뷰 P0-2 수리 — "허용을 나중에 끄면 기존 연결
 * 계정은 status disabled로 전환". Level-triggered: setMailRouting 호출마다 현재 active인 개인
 * (PERSONAL_MAIL_ACCOUNT_KINDS: workspace_oauth/external_smtp_imap) 계정 전부를 NEXT 정책 하나와
 * 대조한다(previous→next diff 의존 제거 — 어느 한 번의 setMailRouting 호출이 Peoply 오류로 한
 * 계정을 건너뛰어도, 다음 호출이 같은 계정을 처음부터 다시 평가해 뒤늦게라도 닫는다). 각 계정의
 * 소유자 org를 Peoply로 해석해(resolveMailAccountForEmail이 쓰는 것과 같은 조회) next가 허용하지
 * 않는 org면 비활성화한다. Peoply 조회 실패(또는 org 미확인)는 절대 비활성화하지 않고 건너뛴다 —
 * 그 계정은 매니저를 일시적 디렉터리 장애로 걸어 잠그는 대신 다음 성공 조회까지 기존 접근을
 * 유지한다. 건너뛴 계정은 skippedAccountIds 로 호출부에 보고한다. 동시성은
 * DISABLE_REVOKED_ORGS_CONCURRENCY 로 바운드된다. 저장 형식(status/updatedBy/updatedAt merge)은
 * upsertMailAccount와 동일해 status === "active" 게이트에 이미 의존하는 모든 읽기 경로
 * (resolveMailAccountForEmail ①, listAccessibleMailAccountsForEmail, chat-ai.ts
 * selectOutboundMailAccount)가 별도 권한 체크 없이 그대로 닫힌다.
 */
async function disableAccountsForRevokedOrgs(
  next: readonly string[] | null,
  accounts: readonly MailAccount[],
  db: ReturnType<typeof resolveMailAccountsDb>,
  updatedBy: string,
): Promise<{ disabledAccountIds: string[]; skippedAccountIds: string[] }> {
  if (next === null) return { disabledAccountIds: [], skippedAccountIds: [] }; // fail-open again, nothing to revoke
  const disabledAccountIds: string[] = [];
  const skippedAccountIds: string[] = [];
  const personalAccounts = accounts.filter(
    (account) => PERSONAL_MAIL_ACCOUNT_KINDS.has(account.kind) && account.status === "active" && account.ownerEmail,
  );
  await mapWithBoundedConcurrency(personalAccounts, DISABLE_REVOKED_ORGS_CONCURRENCY, async (account) => {
    let orgId: string | null = null;
    try {
      const person = await getPeoplyClient().getPerson(account.ownerEmail);
      orgId = person.employee.primaryMembership || null;
    } catch {
      skippedAccountIds.push(account.accountId);
      return;
    }
    if (!orgId || isPersonalMailConnectAllowedForOrg({ personalMailAllowedOrgIds: next }, orgId)) return;
    await db.collection(MAIL_ACCOUNTS_COLLECTION).doc(account.accountId).set(
      { status: "disabled", updatedBy, updatedAt: new Date().toISOString() },
      { merge: true },
    );
    disabledAccountIds.push(account.accountId);
  });
  return { disabledAccountIds, skippedAccountIds };
}

export async function listMailAccounts(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "mail_accounts.list", ["super_admin", "admin", "manager"]);
  const [accounts, routing] = await Promise.all([readMailAccounts(), readMailRouting()]);
  // Flu/Task-51 P1-2 (적대 리뷰): scpAllowedOrgIds는 setMailRouting이 이미 super_admin 전용 쓰기로
  // 게이트한 필드다 — manager에게는 읽기 응답에서도 제거한다(super_admin/admin은 그대로 받는다;
  // admin은 이 필드를 쓸 수 없어도 운영상 현재 배정 목록은 볼 수 있어야 한다).
  // 2026-09-27 security fix round 2 (codex adversarial review, medium finding #4): admin/super_admin
  // keep the full administrative inventory (they configure byOrgId/upsertMailAccount, which needs
  // visibility into every account regardless of personal entitlement). A manager is not an account
  // administrator — this callable was returning every account's public config (label, mailbox
  // address, status) to any manager unconditionally, including scp for a manager whose org has no
  // scp grant at all. Narrow a manager's own accounts list to the SAME entitled set
  // listAccessibleMailAccountsForEmail already computes for their mailbox-view/sender UI, so a
  // manager can never learn the scp mailbox exists by calling this callable directly.
  let visibleAccounts = accounts;
  let visibleRouting: Record<string, unknown> = routing;
  if (auth.role === "manager") {
    const email = asString(auth.email).toLowerCase();
    const accessible = email
      ? await listAccessibleMailAccountsForEmail(email, { userId: auth.userId })
      : { accounts: [] };
    const accessibleIds = new Set(accessible.accounts.map((account) => account.accountId));
    visibleAccounts = accounts.filter((account) => accessibleIds.has(account.accountId));
    // round 2 follow-up (codex adversarial review round2, medium finding #3): narrowing only the
    // accounts array left defaultAccountId/byOrgId in the routing envelope untouched — an
    // unentitled manager could still read the literal string "scp" straight off
    // routing.defaultAccountId or routing.byOrgId, defeating the no-discovery boundary the
    // accounts filter above exists for. Redact both down to only what this manager is entitled to
    // (scpAllowedOrgIds was already stripped for manager before this fix and remains stripped).
    // scpAllowedOrgIds is destructured out entirely (not set to null) — the pre-existing
    // Task-51 contract is that a manager must not see even the field key, not just a redacted
    // value (see "scpAllowedOrgIds is stripped ... manager must not see even the field key" test).
    const { scpAllowedOrgIds: _managerHiddenScpAllowedOrgIds, defaultAccountId, byOrgId, ...restRouting } = routing;
    visibleRouting = {
      ...restRouting,
      defaultAccountId: accessibleIds.has(defaultAccountId) ? defaultAccountId : "",
      byOrgId: Object.fromEntries(
        Object.entries(byOrgId).filter(([, mappedAccountId]) => accessibleIds.has(mappedAccountId)),
      ),
    };
  }
  return {
    ok: true,
    accounts: visibleAccounts.map(toMailAccountPublic),
    routing: visibleRouting,
    behaviorLog: makeBehaviorLog(auth, "mail_accounts.list", "success", "global", 0),
  };
}

export async function upsertMailAccount(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "mail_accounts.upsert", ["super_admin", "admin"]);
  const data = asRecord(request.data);
  const accountId = asString(data.accountId);
  if (!isMailAccountIdSlug(accountId)) {
    throw invalidArgument("accountId must match ^[a-z0-9][a-z0-9-]{1,40}$");
  }

  const isScp = accountId === "scp";
  if (isScp && data.mailbox !== undefined && normalizeAccountMailbox(data.mailbox) !== CANONICAL_OPERATIONAL_MAILBOX_V1) {
    throw invalidArgument("the scp account mailbox cannot be changed");
  }
  if (isScp && data.kind !== undefined && data.kind !== "canonical_scp") {
    throw invalidArgument("the scp account kind cannot be changed");
  }

  const db = resolveMailAccountsDb();
  const docRef = db.collection(MAIL_ACCOUNTS_COLLECTION).doc(accountId);
  const snapshot = await docRef.get();
  const existing = snapshot.exists ? asRecord(snapshot.data()) : {};

  const mailbox = isScp
    ? CANONICAL_OPERATIONAL_MAILBOX_V1
    : normalizeAccountMailbox(data.mailbox ?? existing.mailbox);
  if (!mailbox) throw invalidArgument("mailbox must be a lowercase email address");

  const kind: MailAccountKind | undefined = isScp
    ? "canonical_scp"
    : (isMailAccountKind(data.kind) ? data.kind : (isMailAccountKind(existing.kind) ? existing.kind : undefined));
  if (!kind) throw invalidArgument("kind must be one of canonical_scp, workspace_oauth, external_smtp_imap");

  const status: MailAccountStatus | undefined = isMailAccountStatus(data.status)
    ? data.status
    : (isMailAccountStatus(existing.status) ? existing.status : "pending_auth");
  if (!status) throw invalidArgument("status must be one of active, disabled, pending_auth");

  const smtp = data.smtp !== undefined ? sanitizeWritablePublicConfig(data.smtp, "smtp") : asRecord(existing.smtp);
  const imap = data.imap !== undefined ? sanitizeWritablePublicConfig(data.imap, "imap") : asRecord(existing.imap);
  const orgIds = data.orgIds !== undefined ? asOrgIdArray(data.orgIds) : asOrgIdArray(existing.orgIds);

  // 2026-09-10 adversarial review CRITICAL-1: secretRef is never trusted verbatim from the
  // admin payload for a workspace_oauth account — it always names the one encrypted credential
  // doc functions/mailOAuth.ts owns for this accountId, so any admin-supplied value is ignored
  // outright rather than merely validated (mirrors how isScp already forces mailbox/kind above).
  // For an external_smtp_imap account, a non-empty value IS admin-supplied (it must name a
  // Secret Manager env var Ops actually bound) but must match MAIL_EXT_SECRET_NAME_PATTERN — see
  // functions/mailAccounts.ts isValidMailAccountSecretRef / functions/mailTransport.ts's
  // exported pattern. scp never persists a secretRef at all (docPayload below omits it) — its
  // real value is always synthesized fresh by mailAccounts.ts buildScpAccount.
  const resolvedSecretRef = isScp
    ? ""
    : kind === "workspace_oauth"
      ? `oauth:${MAIL_OAUTH_CREDENTIALS_COLLECTION}/${accountId}`
      : asString(data.secretRef, asString(existing.secretRef, ""));
  if (!isScp && resolvedSecretRef && !isValidMailAccountSecretRef(kind, accountId, resolvedSecretRef)) {
    throw invalidSecretRef(
      kind === "external_smtp_imap"
        ? `secretRef for an external_smtp_imap account must be env:MAIL_EXT_<NAME> (got "${resolvedSecretRef}")`
        : `secretRef is invalid for account ${accountId}`,
    );
  }

  const nowIso = new Date().toISOString();
  const nextAccount: MailAccount = {
    accountId,
    label: asString(data.label, asString(existing.label, accountId)),
    mailbox,
    kind,
    status,
    ownerEmail: asString(data.ownerEmail, asString(existing.ownerEmail, "")).toLowerCase(),
    orgIds,
    smtp,
    imap,
    secretRef: resolvedSecretRef,
    configError: false,
    createdBy: asString(existing.createdBy, auth.userId),
    createdAt: asString(existing.createdAt, nowIso),
    updatedBy: auth.userId,
    updatedAt: nowIso,
  };

  // The scp account is always synthesized fresh from the live SMTP/IMAP integration
  // (mailAccounts.ts buildScpAccount) — only label/orgIds are ever read back from a stored
  // mail_accounts/scp doc, so that's all we persist here; writing the rest would be silent,
  // never-read drift. Non-scp accounts are fully authoritative from their stored doc.
  const docPayload: Record<string, unknown> = isScp
    ? { label: nextAccount.label, orgIds: nextAccount.orgIds }
    : nextAccount;
  await docRef.set(docPayload, { merge: false });
  // Other instances converge within MAIL_ACCOUNT_RESOLUTION_CACHE_TTL_MS (5 min) on their own.
  clearMailAccountResolutionCache();

  return {
    ok: true,
    account: toMailAccountPublic(nextAccount),
    behaviorLog: makeBehaviorLog(auth, "mail_accounts.upsert", "success", "global", 0),
  };
}

export async function setMailRouting(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "mail_routing.update", ["super_admin", "admin"]);
  const data = asRecord(request.data);
  // (scp 계정 배정 허용) scpAllowedOrgIds is the one mail_routing field only a super_admin may
  // change — every other field on this callable stays admin+ as before. Checked before any read
  // so an admin's attempt never has a side effect, and denial still carries an audit trail
  // (behaviorLog) the same way assertNonGuestAuth's own denial does above.
  if (data.scpAllowedOrgIds !== undefined && auth.role !== "super_admin") {
    const error = new Error("permission-denied: scpAllowedOrgIds can only be changed by a super_admin");
    Object.assign(error, {
      code: "permission-denied",
      errorCode: "set_mail_routing_scp_allowed_org_ids_requires_super_admin",
      behaviorLog: makeBehaviorLog(auth, "mail_routing.update_scp_allowed_org_ids", "error", "global", 0),
    });
    throw error;
  }
  // This is a partial-update callable (the caller may send only a single byOrgId entry to
  // add/remove), so the current routing is read first and merged — never blind-overwritten
  // from just the incoming payload, or every other admin's mapping would be silently dropped.
  const [accounts, currentRouting] = await Promise.all([readMailAccounts(), readMailRouting()]);
  const accountsById = new Map(accounts.map((account) => [account.accountId, account]));

  const defaultAccountId = asString(data.defaultAccountId, currentRouting.defaultAccountId);
  const defaultAccount = accountsById.get(defaultAccountId);
  if (!defaultAccount || defaultAccount.status !== "active") {
    throw invalidArgument(`defaultAccountId must reference an active mail account: ${defaultAccountId}`);
  }

  // Merge: {...current, ...incoming}. A `null` incoming value removes that org's mapping
  // (reverting it to the default account) instead of requiring the caller to resend every
  // other org's existing mapping.
  const byOrgId: Record<string, string> = { ...currentRouting.byOrgId };
  const byOrgIdInput = asRecord(data.byOrgId);
  for (const [orgId, accountIdValue] of Object.entries(byOrgIdInput)) {
    if (accountIdValue === null) {
      delete byOrgId[orgId];
      continue;
    }
    const targetAccountId = asString(accountIdValue);
    const targetAccount = accountsById.get(targetAccountId);
    if (!targetAccount || targetAccount.status !== "active") {
      throw invalidArgument(`byOrgId.${orgId} must reference an active mail account`);
    }
    byOrgId[orgId] = targetAccountId;
  }

  // Flu/Task-48: undefined -> keep the current value unchanged; null -> explicitly reset to
  // "not configured" (fail-open); an array (possibly empty) -> the new allowlist. Mirrors
  // defaultAccountId's own "omit to keep current" partial-update doctrine above.
  const personalMailAllowedOrgIds: readonly string[] | null =
    data.personalMailAllowedOrgIds === undefined
      ? currentRouting.personalMailAllowedOrgIds
      : data.personalMailAllowedOrgIds === null
        ? null
        : normalizedOrgIdArray(data.personalMailAllowedOrgIds);
  const chatPersonalViewDefaultOrgIds: readonly string[] =
    data.chatPersonalViewDefaultOrgIds === undefined
      ? currentRouting.chatPersonalViewDefaultOrgIds
      : normalizedOrgIdArray(data.chatPersonalViewDefaultOrgIds);

  // (scp 계정 배정 허용) same "omit to keep current; null resets to not-configured (fail-open);
  // an array (possibly empty) sets the strict allowlist" partial-update doctrine as
  // personalMailAllowedOrgIds above. The super_admin-only RBAC gate already ran above.
  const scpAllowedOrgIds: readonly string[] | null =
    data.scpAllowedOrgIds === undefined
      ? currentRouting.scpAllowedOrgIds
      : data.scpAllowedOrgIds === null
        ? null
        : normalizedOrgIdArray(data.scpAllowedOrgIds);

  const nowIso = new Date().toISOString();
  const next: MailRouting = {
    defaultAccountId,
    byOrgId,
    personalMailAllowedOrgIds,
    chatPersonalViewDefaultOrgIds,
    scpAllowedOrgIds,
    policyVersion: DEFAULT_MAIL_ROUTING_POLICY_VERSION,
    updatedBy: auth.userId,
    updatedAt: nowIso,
  };
  const db = resolveMailAccountsDb();
  const { disabledAccountIds, skippedAccountIds } = await disableAccountsForRevokedOrgs(
    personalMailAllowedOrgIds,
    accounts,
    db,
    auth.userId,
  );
  // `next` is the fully merged desired state (not the raw partial payload), so a full
  // overwrite here is correct and keeps the document free of stale/orphaned keys.
  await db.doc(MAIL_ROUTING_DOC_PATH).set(next, { merge: false });
  // Other instances converge within MAIL_ACCOUNT_RESOLUTION_CACHE_TTL_MS (5 min) on their own.
  clearMailAccountResolutionCache();

  return {
    ok: true,
    routing: next,
    ...(disabledAccountIds.length > 0 ? { disabledAccountIds } : {}),
    // Flu/Task-48 적대 리뷰 P0-2: Peoply 조회 실패로 이번 호출에서 평가하지 못한 개인 계정 —
    // level-triggered라 다음 setMailRouting 호출에서 처음부터 다시 평가된다.
    ...(skippedAccountIds.length > 0 ? { skippedAccountIds } : {}),
    behaviorLog: makeBehaviorLog(auth, "mail_routing.update", "success", "global", 0),
  };
}

/**
 * Grants or revokes specific mailbox views for one existing member. This is deliberately a
 * member-owned allowlist rather than a role/domain switch: it can authorize the canonical SCP
 * mailbox for a non-Peoply mailbox identity without making that identity an employee or opening a
 * global SCP fallback. The target member doc must be keyed by the same UID it stores, so this
 * write cannot migrate, clone, or reassign access across legacy member aliases. Account status is
 * not required to be active here because disabled/pending accounts remain valid history views;
 * sender readiness still filters to active accounts and guest tokens are blocked by read/send
 * callables before this grant is considered.
 */
export async function setMemberMailAccountAccess(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "mail_accounts.member_access.update", ["super_admin"]);
  const data = asRecord(request.data);
  const requestedUid = asString(data.uid, asString(data.memberId));
  if (!requestedUid) throw invalidArgument("uid or memberId is required");
  if (!Array.isArray(data.mailAccountIds)) throw invalidArgument("mailAccountIds must be an array");

  if (data.mailAccountIds.some((accountId) => !isMailAccountIdSlug(accountId))) {
    throw invalidArgument("mailAccountIds contains an invalid account id");
  }
  const accountIds = [...new Set(data.mailAccountIds.map((accountId) => accountId.trim()))];

  const db = resolveMailAccountsDb();
  await assertActiveSuperAdminMember(auth, db);

  const memberSnapshot = await db.collection("members").doc(requestedUid).get();
  if (!memberSnapshot.exists) throw invalidArgument("member does not exist");
  const member = asRecord(memberSnapshot.data());
  const targetUid = asString(member.uid);
  if (targetUid !== requestedUid) {
    throw invalidArgument("member uid must match the requested member document id");
  }
  const memberEmail = asString(member.email).toLowerCase();
  if (!memberEmail) throw invalidArgument("member email is required");
  await verifiedAuthUserForMemberUid(requestedUid, memberEmail);
  if (memberEmail === CANONICAL_OPERATIONAL_MAILBOX_V1 && accountIds.some((accountId) => accountId !== "scp")) {
    throw invalidArgument("the public SCP identity may only receive the canonical scp mailbox");
  }
  const accounts = await readMailAccounts();
  const knownAccountIds = new Set(accounts.map((account) => account.accountId));
  if (accountIds.some((accountId) => !knownAccountIds.has(accountId))) {
    throw invalidArgument("mailAccountIds contains an unknown mail account");
  }

  const payload = {
    [MAIL_ACCOUNT_ACCESS_FIELD]: accountIds,
    mailAccountAccessUpdatedBy: auth.userId,
    mailAccountAccessUpdatedAtIso: new Date().toISOString(),
  };
  await db.collection("members").doc(requestedUid).set(payload, { merge: true });
  clearMailAccountResolutionCache();
  return {
    ok: true,
    uid: targetUid,
    mailAccountIds: accountIds,
    behaviorLog: makeBehaviorLog(auth, "mail_accounts.member_access.update", "success", "global", 0),
  };
}

export async function resolveMyMailAccount(request: CallableRequestShape) {
  const auth = assertNonGuestAuth(request, "mail_accounts.resolve_mine");
  const email = asString(auth.email).toLowerCase();
  if (!email) throw invalidArgument("caller auth token has no email claim");

  const policy = await resolveMailSenderPolicyForEmail(email, {
    userId: auth.userId,
    isSuperAdmin: auth.role === "super_admin",
  });
  return {
    ok: true,
    // `account` is retained for backwards compatibility, but now follows the same strict
    // end-user sender policy. It is null when the caller has neither an owned personal sender
    // nor an explicitly mapped team sender; the legacy resolver's SCP fallback is never exposed
    // as a user entitlement.
    account: policy.defaultAccount ? toMailAccountPublic(policy.defaultAccount) : null,
    orgId: policy.orgId,
    source: policy.defaultAccount
      ? policy.personalAccount && policy.defaultAccount.accountId === policy.personalAccount.accountId
        ? "user_linked"
        : "peoply"
      : "fallback",
    personalAccount: policy.personalAccount ? toMailAccountPublic(policy.personalAccount) : null,
    orgAccount: policy.orgAccount ? toMailAccountPublic(policy.orgAccount) : null,
    usableSenders: policy.usableSenders.map(toMailAccountPublic),
    defaultSenderId: policy.defaultSenderId,
    senderBlockedReason: policy.senderBlockedReason,
    orgResolutionStatus: policy.orgResolutionStatus,
    behaviorLog: makeBehaviorLog(auth, "mail_accounts.resolve_mine", "success", "global", 0),
  };
}

/**
 * Flu/Task-50 — 슈퍼어드민 쉐도우 로그인("대신 보기"). getMyOrgContext(및 그 소비자인
 * Sidebar/FluTabGate/Chat/파트너 탭 — 전부 src/lib/useNavPreset.ts의 memoized useOrgContext를
 * 공유한다)를 다른 사용자 시점으로 읽기 전용 재계산하는 유일한 통로다. 실제 Firebase Auth
 * 토큰/세션은 전혀 건드리지 않는다 — auth(호출자 자신의 검증된 클레임)는 그대로 두고, 이후의
 * email 기반 해석(resolveMailAccountForEmail 등)에만 대상자의 이메일을 흘려보낸다.
 *
 * viewAsUserId/viewAsEmail 은 반드시 함께 와야 한다(클라이언트의 멤버 선택 UI가 항상 둘 다 쥐고
 * 있다 — src/lib/mock/admin.ts Member.id/email). AUTH-P0-003: caller.role은 매 호출마다(세션/
 * 클레임 caching에 의존하지 않고) 여기서 재검증한다 — admin도 거부 대상이다(privileged role
 * mutation과 달리 이건 admin에게도 안 열어준다).
 */
async function assertViewAsAllowed(auth: AuthContext, targetUserId: string): Promise<void> {
  if (auth.role === "super_admin") return;
  const error = new Error("permission-denied: viewAs requires super_admin");
  Object.assign(error, {
    code: "permission-denied",
    errorCode: "view_as_forbidden",
    behaviorLog: makeBehaviorLog(auth, `viewAs.denied(${targetUserId})`, "denied", "global", 0),
  });
  throw error;
}

/**
 * Flu/Task-50 적대 리뷰 P0-1 — viewAsUserId/viewAsEmail 을 클라이언트가 보낸 그대로 신뢰하지
 * 않는다: members 컬렉션(Topbar "대신 보기" 선택 UI·functions/admin.ts가 멤버 문서를 쓸 때 쓰는
 * 것과 같은 정본 — 문서id=uid, uid/email 필드)에서 대상자를 재조회해 검증한다. 문서가 없거나
 * 저장된 email이 viewAsEmail과 (대소문자 무시) 다르면(또는 uid 필드가 있는데 요청한
 * viewAsUserId와 다르면) permission-denied와 구분되는 invalid-argument로 거부하고, 같은
 * viewAs.denied 감사 action을 남긴다 — 존재하지 않는 uid를 스캔하는 것과 "권한이 없다"를 감사
 * 로그만으로 구분하지 못하게 한다는 뜻은 아니고, 단지 두 실패 모두 이 함수 밖으로는 "거부됐다"만
 * 드러난다는 뜻이다.
 *
 * 반환값의 email/role은 클라이언트가 보낸 값이 아니라 이 조회로 확인된 값이다 — 호출자는 이후의
 * 모든 계산(선호값 조회 대상, org 스코프, 감사 action)에 **이 반환값만** 써야 한다. 두 파라미터가
 * 모두 비어 있으면(viewAs 미요청) null을 반환하고 호출자는 자기 자신의 시점으로 계속 진행한다.
 */
export async function resolveViewAsTarget(
  auth: AuthContext,
  data: Record<string, unknown>,
  authTenantId = "default",
): Promise<{ uid: string; email: string; role?: Exclude<Role, "guest"> } | null> {
  const viewAsUserId = asString(data.viewAsUserId);
  const viewAsEmailInput = asString(data.viewAsEmail).toLowerCase();
  const viewAsRequested = Boolean(viewAsUserId || viewAsEmailInput);
  if (!viewAsRequested) return null;
  await assertViewAsAllowed(auth, viewAsUserId || viewAsEmailInput);
  if (!viewAsUserId || !viewAsEmailInput) {
    throw invalidArgument("viewAsUserId and viewAsEmail must both be provided together");
  }

  const db = resolveMailAccountsDb();
  const snapshot = await db.collection("members").doc(viewAsUserId).get();
  const member = snapshot.exists ? asRecord(snapshot.data()) : null;
  const storedEmail = member ? asString(member.email).toLowerCase() : "";
  const storedUid = member ? asString(member.uid) : "";
  const identityVerified = Boolean(member) && storedEmail === viewAsEmailInput && (!storedUid || storedUid === viewAsUserId);
  if (!identityVerified) {
    const error = new Error("invalid-argument: viewAs target does not match a known member");
    Object.assign(error, {
      code: "invalid-argument",
      errorCode: "view_as_target_mismatch",
      behaviorLog: makeBehaviorLog(auth, `viewAs.denied(${viewAsUserId})`, "denied", "global", 0),
    });
    throw error;
  }

  const verifiedEmail = await verifiedAuthEmailForMemberUid(viewAsUserId, storedEmail, authTenantId);
  const storedRole = member ? member.role : undefined;
  if (!isRole(storedRole) || storedRole === "guest") {
    const error = new Error("permission-denied: viewAs target requires an active member role");
    Object.assign(error, {
      code: "permission-denied",
      errorCode: "view_as_target_role_invalid",
      behaviorLog: makeBehaviorLog(auth, `viewAs.denied(${viewAsUserId})`, "denied", "global", 0),
    });
    throw error;
  }
  return {
    uid: viewAsUserId,
    email: verifiedEmail,
    role: storedRole,
  };
}

/**
 * PLAN-ORG-MAIL-IDENTITY Slice 5 — one small projection the app shell/Chat need: the caller's
 * org (name resolved via Peoply, degrading to null rather than throwing if Peoply is down or
 * the key lacks scope — this must never block Chat/the shell from rendering), which account
 * currently handles their mail, whether that account is one they personally connected, and
 * whether they already dismissed the "메일 연결(선택)" banner (functions/userPreferences.ts).
 * Deliberately returns no token/secret — accountMailbox/accountLabel are the only account
 * fields surfaced (SEC-P0-009).
 *
 * Flu/Task-42: also returns `navPreset` (functions/orgTabPresets.ts) — the FLU_NAV keys the
 * caller's org is restricted to, or null when unrestricted (no admin-set preset for this org,
 * or no resolved org at all). This is a UI convenience only; it opens no new server data path.
 *
 * Flu/Task-50: optional viewAsUserId+viewAsEmail, verified against the members collection by
 * resolveViewAsTarget above, recompute this same projection for another user.
 */
// Perf/cost 2026-09-24: the org-name Peoply lookup below is a pure function of orgId - no
// caller/viewAs identity in it at all - unlike resolveMailSenderPolicyForEmail (already cached,
// 5min TTL, see MAIL_ACCOUNT_RESOLUTION_CACHE_TTL_MS in functions/mailAccounts.ts) and
// resolveNavPresetForOrg (already cached, ORG_TAB_PRESETS_CACHE_TTL_MS in
// functions/orgTabPresets.ts). This was the one remaining uncached Peoply round-trip on every
// getMyOrgContext/getAppBootstrap call. Short TTL (matches the client's own
// ORG_CONTEXT_CACHE_TTL_MS in src/lib/org-context-cache.ts) since an org rename should surface
// quickly and the lookup is cheap to repeat - no correctness risk either way, since the wrapper
// below still fails open to orgName:null on any error, cached or not.
const ORG_NAME_CACHE_TTL_MS = 60_000;
const MAX_ORG_NAME_CACHE_SIZE = 50;
const orgNameCache = new Map<string, { expiresAt: number; value: Promise<string | null> }>();

function getOrgNameCached(orgId: string): Promise<string | null> {
  const now = Date.now();
  const cached = orgNameCache.get(orgId);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = getPeoplyClient().getOrganization(orgId).then((organization) => organization.name || null);
  orgNameCache.delete(orgId);
  orgNameCache.set(orgId, { expiresAt: now + ORG_NAME_CACHE_TTL_MS, value });
  value.catch(() => {
    if (orgNameCache.get(orgId)?.value === value) orgNameCache.delete(orgId);
  });
  while (orgNameCache.size > MAX_ORG_NAME_CACHE_SIZE) {
    const oldestKey = orgNameCache.keys().next().value;
    if (oldestKey === undefined) break;
    orgNameCache.delete(oldestKey);
  }
  return value;
}

/** Test-only: same reset seam as clearMailAccountResolutionCache/clearOrgTabPresetsCache — tests
 * that mock getOrganization differently per orgId across test() blocks must clear this between
 * them (same process, same module state) or a later test can observe an earlier test's cached
 * name. */
export function clearOrgNameCacheForTests(): void {
  orgNameCache.clear();
}

/** Test-only: exercises getOrgNameCached in isolation, since getMyOrgContext's own
 * resolveMailSenderPolicyForEmail call also calls Peoply getOrganization for an unrelated reason
 * (org-hierarchy walk), which would confound a call-count assertion made through the full
 * callable. */
export function __getOrgNameCachedForTests(orgId: string): Promise<string | null> {
  return getOrgNameCached(orgId);
}

export async function getMyOrgContext(request: CallableRequestShape) {
  // chat-latency 계측 t0 — 구간별 벽시계 ms 는 응답의 timing 블록으로 실어 보낸다(additive).
  const t0 = Date.now();
  const auth = assertNonGuestAuth(request, "mail_accounts.my_org_context");
  const data = asRecord(request.data);
  // Flu/Task-50 적대 리뷰 P0-1: email/uid는 클라이언트가 보낸 값이 아니라 resolveViewAsTarget이
  // members 컬렉션에서 재조회·검증한 값이다 — 아래 전부 이 반환값만 쓴다.
  const tViewAs = Date.now();
  const viewAsTarget = await resolveViewAsTarget(auth, data, authTenantIdFromRequest(request));
  const viewAsMs = Date.now() - tViewAs;
  const viewAsRequested = viewAsTarget !== null;

  const email = viewAsRequested ? viewAsTarget.email : asString(auth.email).toLowerCase();
  if (!email) throw invalidArgument(viewAsRequested ? "viewAsEmail is invalid" : "caller auth token has no email claim");
  // 대상자 본인의 저장된 선호값(메일 배너 dismiss, Chat 계정 보기)을 읽어야 "그 사용자가 보는
  // 화면"이 재현된다 — 슈퍼어드민 자신의 선호값을 섞으면 안 된다(읽기 전용, 쓰기는 여전히 없음).
  const preferenceUserId = viewAsRequested ? viewAsTarget.uid : auth.userId;
  // 2026-09-27 security fix: the scp mailbox is only ever visible to a super_admin's OWN
  // session. "대신 보기"로 다른 사람을 볼 때는 그 대상자의 실제(제한된) role을 써야 한다 — 헤세가
  // super_admin이라고 해서 viewAs 대상자에게 scp가 보이면 안 된다.
  const effectiveRole = viewAsRequested ? (viewAsTarget.role ?? "viewer") : auth.role;
  const isSuperAdmin = effectiveRole === "super_admin";

  // sender 정책과 두 선호값 조회는 병렬 — timedMs 가 각 단계의 ms 를 따로 재므로 아래
  // senderPolicyMs/preferencesMs 는 서로 겹치는 구간 레이턴시다(합산 ≠ 벽시계).
  const [policyResult, dismissedAtResult, chatMailAccountViewPreferenceResult] = await Promise.all([
    timedMs(resolveMailSenderPolicyForEmail(email, { userId: preferenceUserId, isSuperAdmin })),
    timedMs(readUserPreference(preferenceUserId, "mailConnectNoticeDismissedAt")),
    timedMs(readUserPreference(preferenceUserId, "chatMailAccountView")),
  ]);
  const policy = policyResult.value;
  const dismissedAt = dismissedAtResult.value;
  const chatMailAccountViewPreference = chatMailAccountViewPreferenceResult.value;
  const senderPolicyMs = policyResult.ms;
  const preferencesMs = Math.max(dismissedAtResult.ms, chatMailAccountViewPreferenceResult.ms);
  // Flu/Task-48: the account-view toggle exists when both personal and explicitly mapped org
  // mailbox views are entitled. A disabled/pending sender can still expose its existing history;
  // `usableSenders` remains the active-only compose set. A personal-only team is represented
  // directly by the personal sender and never made to look like an org/SCP account.
  const linkedAccount = policy.personalAccount;
  const orgAccount = policy.orgAccount;
  const personalMailConnectAllowed = policy.personalMailConnectAllowed;
  const canToggleMailAccountView = Boolean(
    linkedAccount && policy.accessibleAccounts.some((account) => account.accountId !== linkedAccount.accountId),
  );
  const chatMailAccountView: "personal" | "org" = !linkedAccount
    ? "org"
    : !orgAccount
      ? "personal"
      : !canToggleMailAccountView
        ? "org"
        : chatMailAccountViewPreference === "personal" || chatMailAccountViewPreference === "org"
          ? chatMailAccountViewPreference
          : policy.defaultView;
  const orgAccountAssigned = Boolean(orgAccount);
  const viewMailAccountId = chatMailAccountView === "personal"
    ? linkedAccount?.accountId ?? null
    : orgAccount?.accountId ?? linkedAccount?.accountId ?? null;
  // chat-latency 계측: navPreset/orgName 은 서로 독립적인 조회라 luna 의 Promise.all 병렬
  // 구조를 유지하고, 각 IIFE 를 timedMs 로 감싸 겹치는 두 구간을 개별로 잰다(합계 ≠ 벽시계,
  // senderPolicyMs/preferencesMs 와 같은 규약).
  const [navPresetResult, orgNameResult] = await Promise.all([
    timedMs(
      (async (): Promise<readonly string[] | null> => {
        // 2026-09-10 adversarial review MEDIUM: fail-open like the org-name lookup right below — a
        // Firestore read failure here (settings/org_tab_presets) must degrade to "no restriction"
        // rather than fail the whole callable, or a transient read error would block the entire app
        // shell/Chat from rendering for every caller.
        try {
          return await resolveNavPresetForOrg(policy.orgId);
        } catch {
          return null;
        }
      })(),
    ),
    timedMs(
      (async (): Promise<string | null> => {
        if (!policy.orgId) return null;
        try {
          return await getOrgNameCached(policy.orgId);
        } catch (error) {
          // Peoply forbidden/rate-limited/down: degrade to no name rather than fail the whole
          // callable — the org chip/filter just shows the raw orgId when this happens.
          if (!(error instanceof PeoplyClientError)) throw error;
          return null;
        }
      })(),
    ),
  ]);
  const navPreset = navPresetResult.value;
  const orgName = orgNameResult.value;
  const navPresetMs = navPresetResult.ms;
  const orgNameMs = orgNameResult.ms;

  // accountLabel/accountMailbox degrade to null when there is no entitled default sender. An
  // explicit byOrgId route to the canonical SCP account is a real user entitlement and may be
  // shown here; an operational fallback is never surfaced to the caller. orgAccountAssigned:false
  // lets the client show a neutral "no org account assigned" notice without naming a fallback
  // mailbox (SEC-P0-009 안내 문구 비노출).
  return {
    ok: true,
    orgId: policy.orgId,
    orgName,
    accountLabel: policy.defaultAccount?.label ?? null,
    accountMailbox: policy.defaultAccount?.mailbox ?? null,
    orgAccountAssigned,
    // 2026-09-27 security fix: explicit server-computed flag for the client to gate scp-specific
    // UI (mailbox selector entries, sender options, scp tabs) on — never re-derive this from
    // role/orgId/navPreset client-side (SEC-P0-009 doctrine: server is the entitlement source of
    // truth). True only for an entitled scp mailbox view (explicit org grant, explicit per-user
    // grant, or this caller's own super_admin session — never a viewAs preview of someone else).
    scpAccessGranted: policy.accessibleAccounts.some((account) => account.accountId === "scp"),
    linked: Boolean(linkedAccount),
    mailConnectNoticeDismissed: dismissedAt.length > 0,
    navPreset,
    // Flu/Task-46 적대 리뷰 MEDIUM-1: 파트너 탭이 클라이언트의 navPreset.includes("scp") 문자열
    // 검사 대신 읽는 서버 판정값(functions/orgTabPresets.ts partnerDataSourceFromNavPreset) —
    // 위에서 이미 읽은 navPreset을 재사용해 추가 Firestore 조회 없이 계산한다.
    partnerDataSource: partnerDataSourceFromNavPreset(navPreset),
    // Flu/Task-48: [Chat 계정 보기] 토글 + 조직별 개인 메일 연결 허용. accessibleAccounts is the
    // token/secret-free entitled mailbox-view set, not the sender picker and not admin inventory.
    // A configured mailbox can remain a view while its stored OAuth/transport status is pending
    // or disabled so existing history is not hidden; usableSenders below remains the active-only
    // set the compose picker and sendEmail may select from.
    accessibleAccounts: policy.accessibleAccounts.map(toMailAccountPublic),
    personalMailConnectAllowed,
    // Strict sender contract. The UI must use these account ids as the only valid sender
    // choices; the server validates the same set again on sendEmail.
    personalAccount: linkedAccount ? toMailAccountPublic(linkedAccount) : null,
    orgAccount: orgAccount ? toMailAccountPublic(orgAccount) : null,
    usableSenders: policy.usableSenders.map(toMailAccountPublic),
    defaultSenderId: policy.defaultSenderId,
    senderBlockedReason: policy.senderBlockedReason,
    orgResolutionStatus: policy.orgResolutionStatus,
    chatMailAccountView,
    viewMailAccountId,
    // Flu/Task-50: present only when this response was computed for another user — the client
    // banner ("OOO로 보는 중") and every guard that must not silently forget a preview is active
    // reads this instead of re-deriving it from local viewAs state (server is the source of truth
    // for "was this call actually honored as a viewAs read").
    viewingAs: viewAsTarget ? { userId: viewAsTarget.uid, email, orgName } : null,
    // chat-latency 계측: 구간별 벽시계 ms(additive — SEC-P0-009 숫자만). senderPolicyMs 와
    // preferencesMs 는 위 Promise.all 에서 병렬로 겹쳐 잰 값이므로 합계가 totalMs 를 넘을 수 있다.
    timing: {
      totalMs: Date.now() - t0,
      authMs: tViewAs - t0,
      viewAsMs,
      senderPolicyMs,
      preferencesMs,
      navPresetMs,
      orgNameMs,
    },
    // Flu/Task-50 LOG-P0-010: a viewAs read is audited under its own action name (replacing the
    // generic one) so `behavior_logs` lets 오남용 추적(누가/언제/누구를 봤는지) — every distinct
    // (target) getMyOrgContext call logs one success row here; the client logs a matching
    // `viewAs.end(...)` row via the existing logBehavior callable when 종료 is clicked (no server
    // round trip needed to end a read-only preview, but the audit trail still needs a stop event).
    behaviorLog: makeBehaviorLog(
      auth,
      viewAsTarget ? `viewAs(${viewAsTarget.uid})` : "mail_accounts.my_org_context",
      "success",
      "global",
      0,
    ),
  };
}
