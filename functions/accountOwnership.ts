import { asRecord, asString, assertNonGuestAuth, type AuthContext, type CallableRequestShape, type Role } from "./shared";
import {
  resolveMailAccountsDb,
  resolveMailSenderPolicyForEmail,
  type MailAccountsFirestoreDb,
  type MailOrgResolutionStatus,
  type MailSenderPolicy,
} from "./mailAccounts";
import {
  accountOwnershipAuthScopeDiagnostic,
  accountOwnershipAuthVerificationDiagnostic,
  resolveViewAsTarget,
  verifiedAuthEmailForMemberUid,
  type AccountOwnershipAuthVerificationDiagnostic,
} from "./mailAccountCallables";
import { getPeoplyClient, isPeoplyEmployeeActive } from "./peoplyClient";

export const ACCOUNT_OWNERSHIP_SCOPE_VERSION = "account_ownership_v1" as const;
export const ACCOUNT_OWNERSHIP_DIAGNOSTIC_EVENT = "account_ownership_resolution_failed" as const;

type NonGuestRole = Exclude<Role, "guest">;

export type AccountOwnershipScope = {
  readonly version: typeof ACCOUNT_OWNERSHIP_SCOPE_VERSION;
  readonly uid: string;
  readonly email: string;
  readonly authTenantId: string;
  readonly role: NonGuestRole;
  readonly callerUid: string;
  readonly callerRole: NonGuestRole;
  readonly viewAs: boolean;
  readonly orgId: string | null;
  readonly orgResolutionStatus: MailOrgResolutionStatus;
  readonly mailAccountId: string | null;
  readonly mailAccountIds: readonly string[];
  readonly resolvedAtIso: string;
};

export type AccountOwnershipDeps = {
  readonly data?: Record<string, unknown>;
  readonly db?: MailAccountsFirestoreDb;
  readonly now?: () => Date;
  readonly resolveMailSenderPolicyForEmail?: typeof resolveMailSenderPolicyForEmail;
};

export type TrustedLegacyOwnerResolution = {
  ownerUid: string;
  ownerEmail: string;
  ownerOrgId: string;
  ownerMailAccountId: string | null;
  ownerMailAccountIds: readonly string[];
  ownerOrgResolutionStatus: MailOrgResolutionStatus;
};

function normalizedEmail(value: unknown): string {
  return asString(value).toLowerCase();
}

function authTenantIdFromRequest(request: CallableRequestShape): string {
  const token = asRecord(request.auth?.token);
  const firebase = asRecord(token.firebase);
  // The common callable wrapper copies this reserved claim only after the
  // exact runtime tenant boundary accepts the original verified ID token.
  // Do not accept request-level aliases here.
  return asString(firebase.tenant) || "default";
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return Array.from(new Set(values.map((value) => asString(value)).filter(Boolean)));
}

function policyMailAccountIds(policy: MailSenderPolicy): string[] {
  return uniqueStrings([
    policy.defaultAccount?.accountId,
    ...policy.accessibleAccounts.map((account) => account.accountId),
    ...policy.usableSenders.map((account) => account.accountId),
  ]);
}

type AccountOwnershipDiagnosticStage =
  | "auth_email_missing"
  | "auth_lookup_unavailable"
  | "auth_identity_rejected"
  | "strict_org_unresolved"
  | "legacy_row_unresolved";
type AccountOwnershipDiagnosticSdkCode = AccountOwnershipAuthVerificationDiagnostic["authSdkCode"] | "not_checked";
type AccountOwnershipDiagnosticSdkStatus = AccountOwnershipAuthVerificationDiagnostic["authSdkStatus"] | "not_checked";
type AccountOwnershipDiagnosticAuthIdentityRejectionReason = AccountOwnershipAuthVerificationDiagnostic["authIdentityRejectionReason"];
type AccountOwnershipDiagnosticOrgStatus = MailOrgResolutionStatus | "not_checked" | "unknown";

function accountOwnershipDiagnosticOrgStatus(value: unknown): AccountOwnershipDiagnosticOrgStatus {
  return value === "resolved" || value === "unresolved" || value === "directory_unavailable"
    ? value
    : "unknown";
}

function logAccountOwnershipResolutionFailure(
  stage: AccountOwnershipDiagnosticStage,
  authTenantId: string,
  options: {
    authSdkCode?: AccountOwnershipDiagnosticSdkCode;
    authSdkStatus?: AccountOwnershipDiagnosticSdkStatus;
    authIdentityRejectionReason?: AccountOwnershipDiagnosticAuthIdentityRejectionReason;
    stagingPermissionProbe?: AccountOwnershipAuthVerificationDiagnostic["stagingPermissionProbe"];
    orgResolutionStatus?: AccountOwnershipDiagnosticOrgStatus;
  } = {},
): void {
  const authScopes = accountOwnershipAuthScopeDiagnostic(authTenantId);
  // Fixed categories only: this server log cannot contain a user/member/document/tenant
  // identifier, raw error message, token, or stack.
  console.error(JSON.stringify({
    event: ACCOUNT_OWNERSHIP_DIAGNOSTIC_EVENT,
    stage,
    authSdkCode: options.authSdkCode ?? "not_checked",
    authSdkStatus: options.authSdkStatus ?? "not_checked",
    authIdentityRejectionReason: options.authIdentityRejectionReason ?? "not_checked",
    stagingPermissionProbe: options.stagingPermissionProbe ?? { attempt: "not_attempted", outcome: "not_attempted", credentialSource: "not_used", httpStatus: "not_attempted", googleStatus: "not_attempted", providerReason: "not_attempted", providerReasonSource: "not_attempted", permissionHint: "not_attempted" },
    orgResolutionStatus: options.orgResolutionStatus ?? "not_checked",
    ...authScopes,
  }));
}

async function verifiedAuthEmailForAccountOwnership(uid: string, email: string, subject: string, authTenantId: string): Promise<string> {
  try {
    return await verifiedAuthEmailForMemberUid(uid, email, authTenantId);
  } catch (error) {
    const diagnostic = accountOwnershipAuthVerificationDiagnostic(error);
    logAccountOwnershipResolutionFailure(
      diagnostic?.stage ?? "auth_identity_rejected",
      authTenantId,
      {
        authSdkCode: diagnostic?.authSdkCode ?? "unknown",
        authSdkStatus: diagnostic?.authSdkStatus ?? "unknown",
        authIdentityRejectionReason: diagnostic?.authIdentityRejectionReason ?? "not_checked",
        stagingPermissionProbe: diagnostic?.stagingPermissionProbe,
      },
    );
    const errorCode = asString(asRecord(error).errorCode);
    if (errorCode === "mail_accounts_auth_verification_unavailable") {
      throw Object.assign(new Error(`failed-precondition: account ownership ${subject} identity verification is unavailable`), {
        code: "failed-precondition",
        errorCode: "account_ownership_identity_verification_unavailable",
      });
    }
    throw Object.assign(new Error(`permission-denied: account ownership ${subject} requires a verified auth email binding`), {
      code: "permission-denied",
      errorCode: "account_ownership_verified_email_required",
    });
  }
}

type SignedSelfIdentityRejectionReason = "uid_mismatch" | "email_unverified" | "email_missing";

function signedSelfIdentityError(reason: SignedSelfIdentityRejectionReason): Error {
  return Object.assign(new Error("signed callable identity is not usable for account ownership"), {
    code: "permission-denied",
    errorCode: "account_ownership_signed_identity_required",
    authIdentityRejectionReason: reason,
  });
}

/**
 * Uses only the callable runtime's verified Firebase ID-token projection for
 * a caller acting as themself. It deliberately does not read request data or
 * memberEmail: Peoply proves employment/org for this signed email, while the
 * Firebase token proves the caller controls its UID/email until token expiry.
 *
 * This is not a fresh Auth profile, disabled-account, or revocation lookup.
 * Those properties require an Auth backend request and remain fail-closed on
 * viewAs and legacy-owner paths below.
 */
function verifiedSignedSelfEmail(
  auth: AuthContext,
  request: CallableRequestShape,
): string {
  if (request.auth?.uid !== auth.userId) throw signedSelfIdentityError("uid_mismatch");
  const token = request.auth?.token;
  const email = normalizedEmail(token?.email);
  if (!email) throw signedSelfIdentityError("email_missing");
  if (token?.emailVerified !== true) throw signedSelfIdentityError("email_unverified");
  return email;
}

function signedSelfIdentityRejectionReason(error: unknown): SignedSelfIdentityRejectionReason | null {
  const reason = asString(asRecord(error).authIdentityRejectionReason);
  return reason === "uid_mismatch" || reason === "email_unverified" || reason === "email_missing"
    ? reason
    : null;
}

export async function resolveAccountOwnershipScopeForAuth(
  auth: AuthContext,
  request: CallableRequestShape,
  deps: AccountOwnershipDeps = {},
): Promise<AccountOwnershipScope> {
  const data = deps.data ?? asRecord(request.data);
  const authTenantId = authTenantIdFromRequest(request);
  const viewAsTarget = await resolveViewAsTarget(auth, data, authTenantId);
  const targetUid = viewAsTarget?.uid ?? auth.userId;
  const targetRole = viewAsTarget?.role ?? auth.role;
  let verifiedTargetEmail: string;
  if (viewAsTarget) {
    verifiedTargetEmail = await verifiedAuthEmailForAccountOwnership(
      targetUid,
      normalizedEmail(viewAsTarget.email),
      "viewAs target",
      authTenantId,
    );
  } else {
    try {
      verifiedTargetEmail = verifiedSignedSelfEmail(auth, request);
    } catch (error) {
      const reason = signedSelfIdentityRejectionReason(error);
      if (reason) {
        logAccountOwnershipResolutionFailure("auth_identity_rejected", authTenantId, {
          authIdentityRejectionReason: reason,
        });
        throw Object.assign(new Error("permission-denied: account ownership requires a verified signed auth email"), {
          code: "permission-denied",
          errorCode: "account_ownership_verified_email_required",
        });
      }
      throw error;
    }
  }
  const doResolveMailSenderPolicy = deps.resolveMailSenderPolicyForEmail ?? resolveMailSenderPolicyForEmail;
  const policy = await doResolveMailSenderPolicy(verifiedTargetEmail, { db: deps.db, userId: targetUid });
  if (!policy.orgId || policy.orgResolutionStatus !== "resolved") {
    logAccountOwnershipResolutionFailure("strict_org_unresolved", authTenantId, {
      orgResolutionStatus: accountOwnershipDiagnosticOrgStatus(policy.orgResolutionStatus),
    });
  }
  return {
    version: ACCOUNT_OWNERSHIP_SCOPE_VERSION,
    uid: targetUid,
    email: policy.email || verifiedTargetEmail,
    authTenantId,
    role: targetRole,
    callerUid: auth.userId,
    callerRole: auth.role,
    viewAs: Boolean(viewAsTarget),
    orgId: policy.orgId,
    orgResolutionStatus: policy.orgResolutionStatus,
    mailAccountId: policy.defaultSenderId ?? policy.defaultAccount?.accountId ?? null,
    mailAccountIds: policyMailAccountIds(policy),
    resolvedAtIso: (deps.now?.() ?? new Date()).toISOString(),
  };
}

export async function resolveAccountOwnershipScopeForRequest(
  request: CallableRequestShape,
  action: string,
  allowedRoles: readonly NonGuestRole[] = ["super_admin", "admin", "manager", "viewer"],
  deps: AccountOwnershipDeps = {},
): Promise<AccountOwnershipScope> {
  const auth = assertNonGuestAuth(request, action, allowedRoles);
  return resolveAccountOwnershipScopeForAuth(auth, request, deps);
}

export function assertResolvedAccountOwnershipScope(scope: AccountOwnershipScope, resource: string): void {
  if (scope.orgId && scope.orgResolutionStatus === "resolved") return;
  throw Object.assign(new Error(`failed-precondition: ${resource} account ownership is unavailable`), {
    code: "failed-precondition",
    errorCode: "account_ownership_scope_unavailable",
    details: { orgResolutionStatus: scope.orgResolutionStatus },
  });
}

export function canBypassAccountOwnership(scope: AccountOwnershipScope): boolean {
  return !scope.viewAs && scope.role === "super_admin";
}


export function assertWritableAccountOwnershipScope(scope: AccountOwnershipScope, resource: string): void {
  if (!scope.viewAs) return;
  throw Object.assign(new Error(`permission-denied: ${resource} cannot be mutated while using viewAs`), {
    code: "permission-denied",
    errorCode: "account_ownership_view_as_write_forbidden",
  });
}


export type ExplicitOwnershipAssignmentStamp = {
  stamp: Record<string, unknown>;
  assignment: Record<string, unknown>;
};

/**
 * 2026-09-29 (peoply-directory-cache) SCOPE DECISION: the two live client.getPerson/getOrganization
 * calls below are deliberately NOT routed through functions/peoplyDirectoryCache.ts's cache-first
 * getCachedOrLivePeoplyPerson. This callable exists specifically so a super_admin can verify a NEW
 * org assignment against Peoply's CURRENT truth at the moment they make it ("someone changes org" —
 * design point 3 of the directory-cache rollout) — a snapshot up to 24h stale would defeat the very
 * purpose of this explicit verification step. Every OTHER Peoply-dependent org lookup in this repo
 * (login bootstrap, mail routing) is a background/automatic resolution and does read the cache
 * first; this one stays live intentionally.
 */

export async function resolveExplicitOwnershipAssignment(
  auth: AuthContext,
  request: CallableRequestShape,
  deps: AccountOwnershipDeps = {},
): Promise<ExplicitOwnershipAssignmentStamp | null> {
  const data = deps.data ?? asRecord(request.data);
  const assignment = asRecord(data.ownershipAssignment);
  if (Object.keys(assignment).length === 0) return null;
  if (auth.role !== "super_admin") {
    throw Object.assign(new Error("permission-denied: ownershipAssignment requires super_admin"), {
      code: "permission-denied",
      errorCode: "ownership_assignment_super_admin_required",
    });
  }
  if (asString(data.viewAsUserId) || asString(data.viewAsEmail)) {
    throw Object.assign(new Error("permission-denied: ownershipAssignment cannot be used with viewAs"), {
      code: "permission-denied",
      errorCode: "ownership_assignment_view_as_forbidden",
    });
  }
  const orgId = asString(assignment.orgId);
  if (!orgId) {
    throw Object.assign(new Error("invalid-argument: ownershipAssignment.orgId is required"), {
      code: "invalid-argument",
      errorCode: "ownership_assignment_org_required",
    });
  }
  const client = getPeoplyClient();
  const organization = await client.getOrganization(orgId, { membershipView: "official" });
  if (asString(organization.id) !== orgId) {
    throw Object.assign(new Error("failed-precondition: ownershipAssignment org mismatch"), {
      code: "failed-precondition",
      errorCode: "ownership_assignment_org_mismatch",
    });
  }
  const personEmail = normalizedEmail(assignment.personEmail ?? assignment.email);
  let ownerEmail = "";
  let peoplyPersonId = "";
  if (personEmail) {
    const person = await client.getPerson(personEmail, { membershipView: "official" });
    if (!isPeoplyEmployeeActive(person.employee.status)) {
      throw Object.assign(new Error("failed-precondition: ownershipAssignment person is not active"), {
        code: "failed-precondition",
        errorCode: "ownership_assignment_person_inactive",
      });
    }
    const primaryOrgId = asString(person.employee.primaryMembership)
      || asString(person.memberships.find((membership) => membership.primary)?.orgId);
    const employeeEmail = normalizedEmail(person.employee.email);
    if (employeeEmail !== personEmail || primaryOrgId !== orgId) {
      throw Object.assign(new Error("failed-precondition: ownershipAssignment person/org binding mismatch"), {
        code: "failed-precondition",
        errorCode: "ownership_assignment_person_org_mismatch",
      });
    }
    ownerEmail = employeeEmail;
    peoplyPersonId = asString(person.employee.id);
  }
  return {
    stamp: {
      accountScopeVersion: ACCOUNT_OWNERSHIP_SCOPE_VERSION,
      ownerAuthTenantId: authTenantIdFromRequest(request),
      ownerOrgId: orgId,
      ownerOrgResolutionStatus: "resolved",
      ...(ownerEmail ? { ownerEmail } : {}),
      ...(peoplyPersonId ? { ownerPeoplyPersonId: peoplyPersonId } : {}),
    },
    assignment: {
      source: "ownershipAssignment",
      orgId,
      ...(peoplyPersonId ? { peoplyPersonId } : {}),
      assignedBy: auth.userId,
      assignedAtIso: (deps.now?.() ?? new Date()).toISOString(),
    },
  };
}

export function accountOwnershipStampForScope(scope: AccountOwnershipScope): Record<string, unknown> {
  assertResolvedAccountOwnershipScope(scope, "server stamp");
  return {
    accountScopeVersion: ACCOUNT_OWNERSHIP_SCOPE_VERSION,
    ownerUid: scope.uid,
    ownerEmail: scope.email,
    ownerAuthTenantId: scope.authTenantId,
    ownerOrgId: scope.orgId,
    ownerMailAccountId: scope.mailAccountId,
    ownerMailAccountIds: scope.mailAccountIds,
    ownerOrgResolutionStatus: scope.orgResolutionStatus,
  };
}

export function candidateParticipationOwnershipForScope(scope: AccountOwnershipScope): Record<string, unknown> {
  return accountOwnershipStampForScope(scope);
}

function recordHasScalar(record: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.some((field) => asString(record[field]).length > 0);
}

function recordScalarMatches(record: Record<string, unknown>, fields: readonly string[], expected: string, options: { caseSensitive?: boolean } = {}): boolean {
  const normalizedExpected = options.caseSensitive ? expected : expected.toLowerCase();
  return fields.some((field) => {
    const value = asString(record[field]);
    if (!value) return false;
    return (options.caseSensitive ? value : value.toLowerCase()) === normalizedExpected;
  });
}

function recordArrayMatches(record: Record<string, unknown>, fields: readonly string[], expected: string): boolean {
  return fields.some((field) => Array.isArray(record[field]) && (record[field] as unknown[]).some((value) => asString(value) === expected));
}

function recordAccountIntersects(record: Record<string, unknown>, scope: AccountOwnershipScope): boolean {
  const recordAccountIds = uniqueStrings([
    record.ownerMailAccountId,
    record.accountOwnerMailAccountId,
    record.programOwnerMailAccountId,
    record.campaignOwnerMailAccountId,
    ...(Array.isArray(record.ownerMailAccountIds) ? record.ownerMailAccountIds : []),
    ...(Array.isArray(record.accountOwnerMailAccountIds) ? record.accountOwnerMailAccountIds : []),
  ]);
  if (recordAccountIds.length === 0) return true;
  const scopeAccounts = new Set(scope.mailAccountIds);
  if (scope.mailAccountId) scopeAccounts.add(scope.mailAccountId);
  return recordAccountIds.some((accountId) => scopeAccounts.has(accountId));
}

const LEGACY_OWNER_UID_FIELDS = ["ownerUid", "createdBy", "accountOwnerUid", "programOwnerUid", "campaignOwnerUid"] as const;
const LEGACY_OWNER_UID_ARRAY_FIELDS = ["ownerUids", "accountOwnerUids", "programOwnerUids", "campaignOwnerUids"] as const;
const LEGACY_OWNER_EMAIL_FIELDS = ["ownerEmail", "createdByEmail", "accountOwnerEmail", "programOwnerEmail", "campaignOwnerEmail"] as const;

function inactiveRecordError(resource: string): Error {
  return Object.assign(new Error(`failed-precondition: ${resource} is not active`), {
    code: "failed-precondition",
    errorCode: "account_ownership_record_inactive",
  });
}

function tenantMismatchError(resource: string): Error {
  return Object.assign(new Error(`permission-denied: ${resource} belongs to another tenant`), {
    code: "permission-denied",
    errorCode: "account_ownership_tenant_mismatch",
  });
}

function scopeMismatchError(resource: string): Error {
  return Object.assign(new Error(`permission-denied: ${resource} belongs to another account`), {
    code: "permission-denied",
    errorCode: "account_ownership_scope_mismatch",
  });
}

function unverifiedOwnershipError(resource: string): Error {
  return Object.assign(new Error(`permission-denied: ${resource} ownership is not verified`), {
    code: "permission-denied",
    errorCode: "account_ownership_unverified",
  });
}

function assertAccountRecordActiveAndTenant(scope: AccountOwnershipScope, record: Record<string, unknown>, resource: string): void {
  const deletedAt = asString(record.deletedAt);
  const archivedAt = asString(record.archivedAt);
  const status = asString(record.status).toLowerCase();
  if (deletedAt || archivedAt || status === "deleted" || status === "archived") {
    throw inactiveRecordError(resource);
  }
  const recordTenantId = asString(record.ownerAuthTenantId) || asString(record.accountOwnerAuthTenantId);
  if (recordTenantId && recordTenantId !== scope.authTenantId) {
    throw tenantMismatchError(resource);
  }
}

function recordOwnerOrgId(record: Record<string, unknown>): string {
  return asString(record.ownerOrgId) || asString(record.accountOwnerOrgId) || asString(record.programOwnerOrgId) || asString(record.campaignOwnerOrgId);
}

function firstRecordOwnerUid(record: Record<string, unknown>): string {
  for (const field of LEGACY_OWNER_UID_FIELDS) {
    const value = asString(record[field]);
    if (value) return value;
  }
  for (const field of LEGACY_OWNER_UID_ARRAY_FIELDS) {
    const values = Array.isArray(record[field]) ? record[field] as unknown[] : [];
    const value = values.map((item) => asString(item)).find(Boolean);
    if (value) return value;
  }
  return "";
}

export function assertAccountOwnershipForRecord(
  scope: AccountOwnershipScope,
  row: unknown,
  resource: string,
): void {
  const record = asRecord(row);
  assertAccountRecordActiveAndTenant(scope, record, resource);
  if (canBypassAccountOwnership(scope)) return;
  assertResolvedAccountOwnershipScope(scope, resource);
  const recordOrgId = recordOwnerOrgId(record);
  if (recordOrgId) {
    if (recordOrgId === scope.orgId && recordAccountIntersects(record, scope)) return;
    throw scopeMismatchError(resource);
  }

  const uidMatches = recordScalarMatches(record, LEGACY_OWNER_UID_FIELDS, scope.uid, { caseSensitive: true })
    || recordArrayMatches(record, LEGACY_OWNER_UID_ARRAY_FIELDS, scope.uid);
  if (uidMatches) {
    if (!recordHasScalar(record, LEGACY_OWNER_EMAIL_FIELDS) || recordScalarMatches(record, LEGACY_OWNER_EMAIL_FIELDS, scope.email)) return;
  }

  throw unverifiedOwnershipError(resource);
}

async function trustedMemberEmailForUid(uid: string, authTenantId: string, deps: AccountOwnershipDeps = {}): Promise<string> {
  if (!uid) return "";
  const db = resolveMailAccountsDb(deps.db);
  const snapshot = await db.collection("members").doc(uid).get();
  const member = snapshot.exists ? asRecord(snapshot.data()) : {};
  const storedUid = asString(member.uid);
  if (storedUid && storedUid !== uid) return "";
  const memberEmail = normalizedEmail(member.email);
  if (!memberEmail) return "";
  try {
    return await verifiedAuthEmailForMemberUid(uid, memberEmail, authTenantId);
  } catch (error) {
    const errorCode = asString(asRecord(error).errorCode);
    if (errorCode === "mail_accounts_auth_verification_unavailable") {
      throw Object.assign(new Error("failed-precondition: legacy owner auth verification is unavailable"), {
        code: "failed-precondition",
        errorCode: "account_ownership_legacy_scope_unavailable",
        details: { reason: "auth_verification_unavailable" },
      });
    }
    return "";
  }
}

export async function resolveTrustedLegacyOwnerForRecord(
  scope: AccountOwnershipScope,
  row: unknown,
  resource: string,
  deps: AccountOwnershipDeps = {},
): Promise<TrustedLegacyOwnerResolution | null> {
  const record = asRecord(row);
  assertAccountRecordActiveAndTenant(scope, record, resource);
  if (recordOwnerOrgId(record)) return null;
  if (canBypassAccountOwnership(scope)) return null;
  assertResolvedAccountOwnershipScope(scope, resource);
  const ownerUid = firstRecordOwnerUid(record);
  if (!ownerUid) return null;
  const ownerEmail = await trustedMemberEmailForUid(ownerUid, scope.authTenantId, deps);
  if (!ownerEmail) return null;
  const doResolveMailSenderPolicy = deps.resolveMailSenderPolicyForEmail ?? resolveMailSenderPolicyForEmail;
  const policy = await doResolveMailSenderPolicy(ownerEmail, { db: deps.db, userId: ownerUid });
  if (policy.orgResolutionStatus !== "resolved" || !policy.orgId) {
    throw Object.assign(new Error(`failed-precondition: ${resource} legacy ownership is unavailable`), {
      code: "failed-precondition",
      errorCode: "account_ownership_legacy_scope_unavailable",
      details: { orgResolutionStatus: policy.orgResolutionStatus },
    });
  }
  if (policy.orgId !== scope.orgId) throw scopeMismatchError(resource);
  return {
    ownerUid,
    ownerEmail: policy.email || ownerEmail,
    ownerOrgId: policy.orgId,
    ownerMailAccountId: policy.defaultSenderId ?? policy.defaultAccount?.accountId ?? null,
    ownerMailAccountIds: policyMailAccountIds(policy),
    ownerOrgResolutionStatus: policy.orgResolutionStatus,
  };
}

export async function accountOwnershipStampForTrustedLegacyOwnerRecord(
  row: unknown,
  resource: string,
  deps: AccountOwnershipDeps = {},
): Promise<Record<string, unknown> | null> {
  const record = asRecord(row);
  if (recordOwnerOrgId(record)) return null;
  const ownerUid = firstRecordOwnerUid(record);
  if (!ownerUid) return null;
  const authTenantId = asString(record.ownerAuthTenantId) || asString(record.accountOwnerAuthTenantId) || "default";
  const ownerEmail = await trustedMemberEmailForUid(ownerUid, authTenantId, deps);
  if (!ownerEmail) {
    throw Object.assign(new Error(`permission-denied: ${resource} legacy ownership is not verified`), {
      code: "permission-denied",
      errorCode: "account_ownership_legacy_unverified",
    });
  }
  const doResolveMailSenderPolicy = deps.resolveMailSenderPolicyForEmail ?? resolveMailSenderPolicyForEmail;
  const policy = await doResolveMailSenderPolicy(ownerEmail, { db: deps.db, userId: ownerUid });
  if (policy.orgResolutionStatus !== "resolved" || !policy.orgId) {
    throw Object.assign(new Error(`failed-precondition: ${resource} legacy ownership is unavailable`), {
      code: "failed-precondition",
      errorCode: "account_ownership_legacy_scope_unavailable",
      details: { orgResolutionStatus: policy.orgResolutionStatus },
    });
  }
  const ownerMailAccountIds = policyMailAccountIds(policy);
  const ownerMailAccountId = policy.defaultSenderId ?? policy.defaultAccount?.accountId ?? ownerMailAccountIds[0] ?? null;
  return {
    accountScopeVersion: ACCOUNT_OWNERSHIP_SCOPE_VERSION,
    ownerUid,
    ownerEmail: policy.email || ownerEmail,
    ownerAuthTenantId: authTenantId,
    ownerOrgId: policy.orgId,
    ...(ownerMailAccountId ? { ownerMailAccountId } : {}),
    ...(ownerMailAccountIds.length > 0 ? { ownerMailAccountIds } : {}),
    ownerOrgResolutionStatus: policy.orgResolutionStatus,
  };
}

export async function assertAccountOwnershipForRecordAsync(
  scope: AccountOwnershipScope,
  row: unknown,
  resource: string,
  deps: AccountOwnershipDeps = {},
): Promise<TrustedLegacyOwnerResolution | null> {
  try {
    assertAccountOwnershipForRecord(scope, row, resource);
    return null;
  } catch (error) {
    const code = asString(asRecord(error).errorCode);
    if (code !== "account_ownership_unverified") throw error;
  }
  const legacy = await resolveTrustedLegacyOwnerForRecord(scope, row, resource, deps);
  if (legacy) return legacy;
  throw unverifiedOwnershipError(resource);
}


function ownerArray(record: Record<string, unknown>, fields: readonly string[]): string[] {
  for (const field of fields) {
    const raw = record[field];
    if (Array.isArray(raw)) return uniqueStrings(raw);
  }
  return [];
}

function firstOwnerScalar(record: Record<string, unknown>, fields: readonly string[]): string {
  for (const field of fields) {
    const value = asString(record[field]);
    if (value) return value;
  }
  return "";
}

function firstOwnerEmail(record: Record<string, unknown>, fields: readonly string[]): string {
  for (const field of fields) {
    const value = normalizedEmail(record[field]);
    if (value) return value;
  }
  return "";
}

export function accountOwnershipStampForOwnedRecord(
  scope: AccountOwnershipScope,
  row: unknown,
  resource: string,
): Record<string, unknown> {
  assertAccountOwnershipForRecord(scope, row, resource);
  const record = asRecord(row);
  const ownerOrgId = asString(record.ownerOrgId) || asString(record.accountOwnerOrgId) || asString(record.programOwnerOrgId) || asString(record.campaignOwnerOrgId);
  if (!ownerOrgId) return accountOwnershipStampForScope(scope);
  const ownerMailAccountIds = ownerArray(record, ["ownerMailAccountIds", "accountOwnerMailAccountIds"]);
  const ownerMailAccountId = asString(record.ownerMailAccountId)
    || asString(record.accountOwnerMailAccountId)
    || asString(record.programOwnerMailAccountId)
    || asString(record.campaignOwnerMailAccountId)
    || ownerMailAccountIds[0];
  const ownerUid = firstOwnerScalar(record, ["ownerUid", "accountOwnerUid", "programOwnerUid", "campaignOwnerUid"]);
  const ownerEmail = firstOwnerEmail(record, ["ownerEmail", "accountOwnerEmail", "programOwnerEmail", "campaignOwnerEmail"]);
  const stamp: Record<string, unknown> = {
    accountScopeVersion: asString(record.accountScopeVersion) || ACCOUNT_OWNERSHIP_SCOPE_VERSION,
    ownerAuthTenantId: asString(record.ownerAuthTenantId) || asString(record.accountOwnerAuthTenantId) || scope.authTenantId,
    ownerOrgId,
    ownerOrgResolutionStatus: asString(record.ownerOrgResolutionStatus) || scope.orgResolutionStatus,
  };
  if (ownerUid) stamp.ownerUid = ownerUid;
  if (ownerEmail) stamp.ownerEmail = ownerEmail;
  if (ownerMailAccountId) stamp.ownerMailAccountId = ownerMailAccountId;
  if (ownerMailAccountIds.length > 0) stamp.ownerMailAccountIds = ownerMailAccountIds;
  return stamp;
}

export async function accountOwnershipStampForOwnedRecordAsync(
  scope: AccountOwnershipScope,
  row: unknown,
  resource: string,
  deps: AccountOwnershipDeps = {},
): Promise<Record<string, unknown>> {
  const legacy = await assertAccountOwnershipForRecordAsync(scope, row, resource, deps);
  if (legacy) {
    return {
      accountScopeVersion: ACCOUNT_OWNERSHIP_SCOPE_VERSION,
      ownerUid: legacy.ownerUid,
      ownerEmail: legacy.ownerEmail,
      ownerAuthTenantId: scope.authTenantId,
      ownerOrgId: legacy.ownerOrgId,
      ownerMailAccountId: legacy.ownerMailAccountId,
      ownerMailAccountIds: legacy.ownerMailAccountIds,
      ownerOrgResolutionStatus: legacy.ownerOrgResolutionStatus,
    };
  }
  const record = asRecord(row);
  if (!recordOwnerOrgId(record) && firstRecordOwnerUid(record)) {
    const trustedLegacy = await accountOwnershipStampForTrustedLegacyOwnerRecord(row, resource, deps);
    if (trustedLegacy) return trustedLegacy;
  }
  return accountOwnershipStampForOwnedRecord(scope, row, resource);
}

export function accountOwnedRowMatchesScope(scope: AccountOwnershipScope, row: unknown): boolean {
  try {
    assertAccountOwnershipForRecord(scope, row, "candidate row");
    return true;
  } catch (error) {
    const errorCode = asString(asRecord(error).errorCode);
    if (errorCode === "account_ownership_scope_unavailable" || errorCode === "account_ownership_legacy_scope_unavailable") {
      throw error;
    }
    return false;
  }
}

export async function accountOwnedRowMatchesScopeAsync(
  scope: AccountOwnershipScope,
  row: unknown,
  deps: AccountOwnershipDeps = {},
  options: { excludeLegacyScopeUnavailable?: boolean } = {},
): Promise<boolean> {
  try {
    await assertAccountOwnershipForRecordAsync(scope, row, "candidate row", deps);
    return true;
  } catch (error) {
    const errorCode = asString(asRecord(error).errorCode);
    if (errorCode === "account_ownership_scope_unavailable") {
      throw error;
    }
    if (errorCode === "account_ownership_legacy_scope_unavailable") {
      if (!options.excludeLegacyScopeUnavailable) throw error;
      // A legacy owner that cannot be resolved is never allowed to widen a
      // listing. Excluding only this row keeps a shared mailbox such as scp@
      // from turning every manager's list into a failed-precondition outage.
      // The diagnostic intentionally contains fixed categories only.
      logAccountOwnershipResolutionFailure("legacy_row_unresolved", scope.authTenantId, {
        orgResolutionStatus: accountOwnershipDiagnosticOrgStatus(
          asRecord(asRecord(error).details).orgResolutionStatus,
        ),
      });
      return false;
    }
    return false;
  }
}
