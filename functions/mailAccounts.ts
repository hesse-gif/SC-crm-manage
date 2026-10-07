/**
 * PLAN-ORG-MAIL-IDENTITY Slice 1 — org-aware mail account foundation.
 * See docs/PLAN-ORG-MAIL-IDENTITY.md for the data model and rollout plan.
 *
 * This module owns:
 *   - the `mail_accounts/{accountId}` + `settings/mail_routing` schemas,
 *   - a synthesized `scp` account (kind: canonical_scp) that is always present even
 *     when no `mail_accounts/scp` doc exists, so this slice ships with zero behavior
 *     change for the 8 existing call sites that resolve the operational mail identity
 *     (they still only ever see the canonical scp mailbox),
 *   - the legacy org -> account resolver used by inbound/queue infrastructure (fail-open to the
 *     default account on Peoply errors or unmapped orgs, with a short in-memory cache), and
 *   - the strict authenticated sender policy used by end-user sendEmail/getMyOrgContext. The
 *     strict policy never treats that operational fallback as a user send-as entitlement.
 *
 * Nothing here performs a live SMTP/IMAP send or read yet (Slice 3/4). Nothing here
 * ever stores or returns a secret value — `smtp`/`imap` are public config only and
 * `secretRef` is a reference name, never a credential (SEC-P0-009).
 */
import { adminDb } from "./firebaseAdmin";
import { getRuntimeIntegration as defaultGetRuntimeIntegration, type RuntimeIntegration } from "./liveIntegrations";
import { CANONICAL_OPERATIONAL_MAILBOX_V1 } from "./mailIdentity";
import { canonicalScpOrgId } from "./mailConversationAuthorization";
import {
  getPeoplyClient,
  verifiedPeoplyPrimaryMembershipForEmail,
  type PeoplyClient,
} from "./peoplyClient";
import { getCachedOrLivePeoplyPerson, type PeoplyOrgAncestryLink } from "./peoplyDirectoryCache";
import { asRecord, asString, makeDeniedBehaviorLog, type AuthContext, type CallableRequestShape } from "./shared";

export const MAIL_ACCOUNTS_COLLECTION = "mail_accounts";
export const MAIL_ROUTING_DOC_PATH = "settings/mail_routing";
/** Member-owned, server-written grants for additional mailbox views. */
export const MAIL_ACCOUNT_ACCESS_FIELD = "mailAccountIds" as const;
export const DEFAULT_MAIL_ROUTING_POLICY_VERSION = "mail-routing-v1" as const;
export const MAIL_ACCOUNT_RESOLUTION_CACHE_TTL_MS = 5 * 60 * 1000;

export const MAIL_ACCOUNT_KINDS = ["canonical_scp", "workspace_oauth", "external_smtp_imap"] as const;
export type MailAccountKind = typeof MAIL_ACCOUNT_KINDS[number];

// 2026-09-11 second adversarial review (LOW): single hoisted definition of "personal (non-scp)
// mail account" — chat-ai.ts's persistReceivedEmail and candidateRematch.ts's backfill_legacy
// mode each used to keep their own copy of this same two-kind set.
export const PERSONAL_MAIL_ACCOUNT_KINDS: ReadonlySet<MailAccountKind> = new Set([
  "workspace_oauth",
  "external_smtp_imap",
]);

export const MAIL_ACCOUNT_STATUSES = ["active", "disabled", "pending_auth"] as const;
export type MailAccountStatus = typeof MAIL_ACCOUNT_STATUSES[number];

export type MailAccountPublicConfig = Record<string, unknown>;

export type MailAccount = {
  readonly accountId: string;
  readonly label: string;
  readonly mailbox: string;
  readonly kind: MailAccountKind;
  readonly status: MailAccountStatus;
  readonly ownerEmail: string;
  readonly orgIds: readonly string[];
  readonly smtp: MailAccountPublicConfig;
  readonly imap: MailAccountPublicConfig;
  readonly secretRef: string;
  /** true when the stored secretRef does not match the shape isValidMailAccountSecretRef
   * requires for this account's kind — readMailAccounts forces status "disabled" whenever this
   * is true (2026-09-10 adversarial review CRITICAL-1), so a mis-shaped secretRef is never used
   * to build a transport/IMAP connection. */
  readonly configError: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
};

/** Public projection: secretRef is reduced to its prefix label (env/oauth/none). */
export type MailAccountPublic = Omit<MailAccount, "secretRef"> & {
  readonly secretRefKind: "env" | "oauth" | "none";
};

export type MailRouting = {
  readonly defaultAccountId: string;
  readonly byOrgId: Readonly<Record<string, string>>;
  /**
   * Flu/Task-48 (조직별 개인 메일 연결 허용): `null` means "not yet configured" — fail-open, the
   * same "absence has no restriction" doctrine functions/orgTabPresets.ts already uses for its
   * byOrgId map, so this ships with zero behavior change for every org (including AI Drama's
   * already-live self-service connections) until an admin explicitly sets it. A configured
   * (non-null) array is a strict allowlist: an org NOT in it may not self-connect a personal
   * mailbox at all — beginMailOAuth's self-service branch, the "메일 연결(선택)" banner, and the
   * Chat account-view toggle all stay closed for it (see isPersonalMailConnectAllowedForOrg).
   */
  readonly personalMailAllowedOrgIds: readonly string[] | null;
  /**
   * Flu/Task-48: orgs whose Chat first-time default view is the caller's own connected mailbox
   * instead of the org account (e.g. AI Drama) — only takes effect when the caller actually has
   * an active linked account AND personalMailAllowedOrgIds permits it. Absence/empty = every org
   * still defaults to the org account, the pre-Task-48 behavior (matches Growth's requirement).
   */
  readonly chatPersonalViewDefaultOrgIds: readonly string[];
  /**
   * (scp 계정 배정 허용) `null` means "not yet configured" — fail-open, the same doctrine as
   * personalMailAllowedOrgIds above: every org may still resolve the canonical scp account as
   * its org/default identity (today's behavior, zero change). A configured (non-null) array is
   * a strict operational allowlist ONLY the super_admin role may write (see
   * mailAccountCallables.ts setMailRouting). It continues to govern the legacy operational
   * resolver's fallback and infrastructure queue paths. The authenticated mailbox-view/sender
   * policy uses the positive byOrgId mapping as its entitlement and does not let this legacy
   * allowlist revoke an explicit team route or grant an unmapped caller a default SCP view.
   * See isScpAssignedToOrg's doc comment for the fail-open-on-unresolved-org doctrine this list
   * uses (deliberately the OPPOSITE default from personalMailAllowedOrgIds for an unresolved
   * org — mail delivery must keep flowing through scp when Peoply itself is down, so only a
   * CONFIDENTLY known, excluded org is ever blocked).
   */
  readonly scpAllowedOrgIds: readonly string[] | null;
  readonly policyVersion: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
};

export type ResolveMailAccountSource = "user_linked" | "peoply" | "fallback";

/**
 * Status of the verified email -> Peoply primary-team lookup. This is deliberately kept
 * separate from MailAccount.status: an active row only describes stored configuration, not
 * provider health or whether the directory was reachable for this request.
 */
export type MailOrgResolutionStatus = "resolved" | "unresolved" | "directory_unavailable";

/**
 * (scp 계정 배정 허용) ResolveMailAccountResult.reason value used when the legacy operational
 * resolver would have resolved to the canonical scp account but the caller's confidently-known
 * org is excluded from settings/mail_routing.scpAllowedOrgIds. This is shared as a named export
 * for infrastructure/queue callers; the authenticated mailbox-view/sender policy follows an
 * explicit byOrgId route independently of this legacy reason.
 */
export const SCP_ORG_NOT_ASSIGNED_REASON = "scp_org_not_assigned" as const;

export type ResolveMailAccountResult = {
  readonly account: MailAccount;
  readonly orgId: string | null;
  readonly source: ResolveMailAccountSource;
  readonly reason: string;
  readonly orgResolutionStatus: MailOrgResolutionStatus;
};

// ---------- minimal Firestore seam (same pattern as functions/goldenSet.ts FirestoreDb) ----------

type FirestoreDocSnapshot = {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
};

type FirestoreDocRef = {
  get(): Promise<FirestoreDocSnapshot>;
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
};

type FirestoreCollectionRef = {
  doc(id: string): FirestoreDocRef;
  get(): Promise<{ docs: readonly FirestoreDocSnapshot[] }>;
};

export type MailAccountsFirestoreDb = {
  collection(name: string): FirestoreCollectionRef;
  doc(path: string): FirestoreDocRef;
};

type RuntimeIntegrationFetcher = (key: "mailSmtp" | "mailImap") => Promise<RuntimeIntegration>;

export type MailAccountsDeps = {
  readonly db?: MailAccountsFirestoreDb;
  readonly getRuntimeIntegration?: RuntimeIntegrationFetcher;
  /** Auth UID for resolving explicit per-user mailbox grants. */
  readonly userId?: string;
};

let dbOverrideForTests: MailAccountsFirestoreDb | null = null;
let runtimeIntegrationOverrideForTests: RuntimeIntegrationFetcher | null = null;

/** Test-only seam (mirrors setPeoplyClientForTests in functions/peoplyClient.ts). */
export function setMailAccountsDbForTests(db: MailAccountsFirestoreDb | null): void {
  dbOverrideForTests = db;
}

/** Test-only seam: override the getRuntimeIntegration lookup used for scp synthesis. */
export function setMailAccountsRuntimeIntegrationForTests(fetcher: RuntimeIntegrationFetcher | null): void {
  runtimeIntegrationOverrideForTests = fetcher;
}

export function resolveMailAccountsDb(explicit?: MailAccountsFirestoreDb): MailAccountsFirestoreDb {
  return explicit ?? dbOverrideForTests ?? (adminDb as unknown as MailAccountsFirestoreDb);
}

function resolveRuntimeIntegrationFetcher(explicit?: RuntimeIntegrationFetcher): RuntimeIntegrationFetcher {
  return explicit ?? runtimeIntegrationOverrideForTests ?? defaultGetRuntimeIntegration;
}

// ---------- validation helpers ----------

const MAIL_ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;
const ACCOUNT_MAILBOX_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Mirrors functions/mailTransport.ts's exported MAIL_EXT_SECRET_NAME_PATTERN — duplicated as a
// literal (not imported) because functions/mailOAuth.ts already imports value bindings from this
// module and mailTransport.ts imports from mailOAuth.ts, so importing mailTransport.ts here would
// create a runtime require cycle (mailAccounts -> mailTransport -> mailOAuth -> mailAccounts).
const MAIL_EXT_SECRET_NAME_PATTERN = /^MAIL_EXT_[A-Z0-9_]{3,50}$/;
// Mirrors functions/mailOAuth.ts's exported MAIL_OAUTH_CREDENTIALS_COLLECTION value, duplicated
// for the same reason.
const MAIL_OAUTH_CREDENTIALS_COLLECTION_NAME = "mail_oauth_credentials";

/**
 * 2026-09-10 adversarial review CRITICAL-1: whether `secretRef` is a shape this account's
 * `kind` is allowed to reference — canonical_scp never reads it from the stored doc at all
 * (buildScpAccount below always hardcodes by kind), workspace_oauth must name exactly the one
 * encrypted credential doc functions/mailOAuth.ts owns for this accountId, and
 * external_smtp_imap must be "env:MAIL_EXT_<NAME>". Enforced here at read time
 * (parseMailAccountDoc forces status "disabled" + configError:true on a mismatch, so a
 * malformed/tampered stored doc is never used to send or receive) and at write time in
 * mailAccountCallables.ts upsertMailAccount.
 */
export function isValidMailAccountSecretRef(kind: MailAccountKind, accountId: string, secretRef: string): boolean {
  if (kind === "canonical_scp") return true;
  if (kind === "workspace_oauth") {
    return secretRef === `oauth:${MAIL_OAUTH_CREDENTIALS_COLLECTION_NAME}/${accountId}`;
  }
  const separatorIndex = secretRef.indexOf(":");
  const prefix = separatorIndex > 0 ? secretRef.slice(0, separatorIndex) : "";
  const name = separatorIndex > 0 ? secretRef.slice(separatorIndex + 1) : "";
  return prefix === "env" && MAIL_EXT_SECRET_NAME_PATTERN.test(name);
}
// "no secrets in public config": reject any field whose name looks like a credential.
// refreshToken matches via the `token` alternative already; listed for auditability.
const FORBIDDEN_PUBLIC_CONFIG_FIELD_PATTERN = /password|token|secret|refreshtoken/i;

export function isMailAccountIdSlug(value: unknown): value is string {
  return typeof value === "string" && MAIL_ACCOUNT_ID_PATTERN.test(value);
}

export function isMailAccountKind(value: unknown): value is MailAccountKind {
  return typeof value === "string" && (MAIL_ACCOUNT_KINDS as readonly string[]).includes(value);
}

export function isMailAccountStatus(value: unknown): value is MailAccountStatus {
  return typeof value === "string" && (MAIL_ACCOUNT_STATUSES as readonly string[]).includes(value);
}

/** Lowercases and validates a mailbox; returns "" (falsy) when invalid. */
export function normalizeAccountMailbox(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  return ACCOUNT_MAILBOX_PATTERN.test(normalized) ? normalized : "";
}

export function containsForbiddenPublicConfigField(value: unknown): boolean {
  return Object.keys(asRecord(value)).some((key) => FORBIDDEN_PUBLIC_CONFIG_FIELD_PATTERN.test(key));
}

function sanitizePublicConfig(value: unknown): MailAccountPublicConfig {
  const record = asRecord(value);
  const result: MailAccountPublicConfig = {};
  for (const [key, val] of Object.entries(record)) {
    if (FORBIDDEN_PUBLIC_CONFIG_FIELD_PATTERN.test(key)) continue;
    if (typeof val === "string") result[key] = val.trim().slice(0, 255);
    else if (typeof val === "number" && Number.isFinite(val)) result[key] = val;
    else if (typeof val === "boolean") result[key] = val;
  }
  return result;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Reduces a secretRef ("env:SMTP_PASSWORD" / "oauth:mail_oauth_credentials/x") to its prefix. */
export function toMailAccountPublic(account: MailAccount): MailAccountPublic {
  const { secretRef, ...rest } = account;
  const separatorIndex = secretRef.indexOf(":");
  const prefix = separatorIndex > 0 ? secretRef.slice(0, separatorIndex) : "";
  const secretRefKind: MailAccountPublic["secretRefKind"] = prefix === "env" || prefix === "oauth" ? prefix : "none";
  return { ...rest, secretRefKind };
}

/**
 * Reads the only per-user mailbox entitlement beyond a personal account or verified org route.
 * The member document is keyed by the authenticated UID and its stored email must still match
 * the email used for policy resolution; this prevents an email-only or cross-member lookup from
 * becoming a mailbox grant. Unknown account IDs are filtered by the caller after account inventory
 * is loaded. Missing/malformed grants fail closed.
 */
export async function readExplicitMailAccountIds(
  userId: string | undefined,
  email: string,
  db: MailAccountsFirestoreDb,
): Promise<readonly string[]> {
  const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalizedUserId || !normalizedEmail) return [];
  // A mailbox grant is an exception for a shared corporate identity, not a domain bypass. Keep
  // the same domain boundary as Auth bootstrap (with the emulator-only fixture domain allowed for
  // local tests); callers still enforce the non-guest Auth role before exposing mail data.
  const allowedDomain = normalizedEmail.endsWith("@supercent.io")
    || (process.env.FUNCTIONS_EMULATOR === "true" && normalizedEmail.endsWith("@demo-flu"));
  if (!allowedDomain) return [];
  let snapshot: FirestoreDocSnapshot;
  try {
    snapshot = await db.collection("members").doc(normalizedUserId).get();
  } catch {
    // A grant read is an entitlement check, not an availability fallback. If the member
    // document cannot be read, return no grant and remain fail-closed.
    return [];
  }
  if (!snapshot.exists) return [];
  const member = asRecord(snapshot.data());
  const memberUid = asString(member.uid);
  if (memberUid !== normalizedUserId) {
    // LOG-P0-008: without this, "no grant" and "grant misconfigured (member doc uid
    // missing/mismatched)" are indistinguishable from the outside. No raw uid/email — doc id,
    // a missing-vs-mismatched flag, and a count are enough to triage without exposing identity.
    console.warn("[mail-accounts]", JSON.stringify({
      event: "mail_account_grant_uid_mismatch",
      memberDocId: normalizedUserId,
      uidMissing: memberUid === "",
      accountIds: asStringArray(member[MAIL_ACCOUNT_ACCESS_FIELD]).length,
    }));
    return [];
  }
  const memberEmail = asString(member.email).toLowerCase();
  if (!memberEmail || memberEmail !== normalizedEmail) return [];
  // A grant must never turn a pending/Guest member into a mailbox identity. Claims are checked
  // at the callable boundary too, but the server-owned member projection is the durable gate.
  if (member.status !== "active" || asString(member.role) === "guest") return [];
  const rawIds = member[MAIL_ACCOUNT_ACCESS_FIELD];
  if (!Array.isArray(rawIds)) return [];
  const normalizedIds = [...new Set(rawIds
    .filter((accountId): accountId is string => isMailAccountIdSlug(accountId))
    .map((accountId) => accountId.trim()))];
  // The public operational identity is not an employee, team, or domain identity. It can only
  // receive the canonical SCP account, never an arbitrary shared/provider account.
  return normalizedEmail === CANONICAL_OPERATIONAL_MAILBOX_V1
    ? normalizedIds.filter((accountId) => accountId === "scp")
    : normalizedIds;
}

// ---------- mail_accounts ----------

async function buildScpAccount(
  storedDoc: Record<string, unknown> | undefined,
  fetchRuntimeIntegration: RuntimeIntegrationFetcher,
): Promise<MailAccount> {
  const [smtpConfig, imapConfig] = await Promise.all([
    fetchRuntimeIntegration("mailSmtp"),
    fetchRuntimeIntegration("mailImap"),
  ]);
  const nowIso = new Date().toISOString();
  // A stored mail_accounts/scp doc can only ever override label/orgIds — mailbox, kind,
  // status, smtp/imap and secretRef are always synthesized fresh from the live SMTP/IMAP
  // integration so this account can never drift from the actual operational mailbox.
  const label = storedDoc && typeof storedDoc.label === "string" && storedDoc.label.trim()
    ? storedDoc.label.trim().slice(0, 160)
    : "SCP 정본 사서함";
  const orgIds = storedDoc ? asStringArray(storedDoc.orgIds) : [];
  return {
    accountId: "scp",
    label,
    mailbox: CANONICAL_OPERATIONAL_MAILBOX_V1,
    kind: "canonical_scp",
    status: "active",
    ownerEmail: "",
    orgIds,
    smtp: asRecord(smtpConfig.public),
    imap: asRecord(imapConfig.public),
    secretRef: "env:SMTP_PASSWORD,IMAP_PASSWORD",
    configError: false,
    createdBy: "system",
    createdAt: nowIso,
    updatedBy: "system",
    updatedAt: nowIso,
  };
}

function parseMailAccountDoc(accountId: string, raw: unknown): MailAccount | null {
  if (!isMailAccountIdSlug(accountId)) return null;
  const data = asRecord(raw);
  const mailbox = normalizeAccountMailbox(data.mailbox);
  if (!mailbox || !isMailAccountKind(data.kind) || !isMailAccountStatus(data.status)) return null;
  const secretRef = asString(data.secretRef, "");
  const secretRefValid = isValidMailAccountSecretRef(data.kind, accountId, secretRef);
  return {
    accountId,
    label: asString(data.label, accountId),
    mailbox,
    kind: data.kind,
    // A mis-shaped secretRef is never used — forcing "disabled" here (rather than trusting the
    // stored status) closes the read path the same way the write path closes it in
    // mailAccountCallables.ts upsertMailAccount.
    status: secretRefValid ? data.status : "disabled",
    ownerEmail: asString(data.ownerEmail, "").toLowerCase(),
    orgIds: asStringArray(data.orgIds),
    smtp: sanitizePublicConfig(data.smtp),
    imap: sanitizePublicConfig(data.imap),
    secretRef,
    configError: !secretRefValid,
    createdBy: asString(data.createdBy, ""),
    createdAt: asString(data.createdAt, ""),
    updatedBy: asString(data.updatedBy, ""),
    updatedAt: asString(data.updatedAt, ""),
  };
}

/** Reads every mail_accounts doc; always includes a synthesized `scp` account. */
export async function readMailAccounts(deps: MailAccountsDeps = {}): Promise<MailAccount[]> {
  const db = resolveMailAccountsDb(deps.db);
  const fetchRuntimeIntegration = resolveRuntimeIntegrationFetcher(deps.getRuntimeIntegration);
  const snapshot = await db.collection(MAIL_ACCOUNTS_COLLECTION).get();
  const accounts = new Map<string, MailAccount>();
  let storedScpDoc: Record<string, unknown> | undefined;
  for (const doc of snapshot.docs) {
    if (doc.id === "scp") {
      storedScpDoc = asRecord(doc.data());
      continue;
    }
    const account = parseMailAccountDoc(doc.id, doc.data());
    if (account) accounts.set(doc.id, account);
  }
  accounts.set("scp", await buildScpAccount(storedScpDoc, fetchRuntimeIntegration));
  return [...accounts.values()].sort((a, b) => a.accountId.localeCompare(b.accountId));
}

let mailAccountsCacheEntry: { expiresAt: number; value: Promise<MailAccount[]> } | null = null;

/**
 * 2026-09-11 second adversarial review (P1): short-TTL memoization of readMailAccounts() for
 * hot read-only call sites that run it on every request (chat-ai.ts's
 * resolveIsPersonalMailAccount runs once per inbound message — including scp traffic, which
 * never paid for a mail_accounts read before PLAN-ORG-MAIL-IDENTITY Task-47). Reuses
 * MAIL_ACCOUNT_RESOLUTION_CACHE_TTL_MS, the same 5-minute window resolveMailAccountForEmail's
 * own cache already uses below, and is invalidated together with it by
 * clearMailAccountResolutionCache — a mail_accounts/mail_routing write becomes visible here
 * within the same staleness window that function already promises callers. A failed read is
 * never memoized (the next call retries instead of replaying the same rejection for the rest of
 * the TTL). Callers that need guaranteed-fresh data (writes, or a read immediately following
 * one) must call readMailAccounts() directly instead.
 */
export function readMailAccountsCached(
  deps: MailAccountsDeps = {},
  now: () => number = () => Date.now(),
): Promise<MailAccount[]> {
  if (mailAccountsCacheEntry && mailAccountsCacheEntry.expiresAt > now()) {
    return mailAccountsCacheEntry.value;
  }
  const value = readMailAccounts(deps);
  const entry = { expiresAt: now() + MAIL_ACCOUNT_RESOLUTION_CACHE_TTL_MS, value };
  mailAccountsCacheEntry = entry;
  value.catch(() => {
    if (mailAccountsCacheEntry === entry) mailAccountsCacheEntry = null;
  });
  return value;
}

// ---------- settings/mail_routing ----------

export async function readMailRouting(deps: { db?: MailAccountsFirestoreDb } = {}): Promise<MailRouting> {
  const db = resolveMailAccountsDb(deps.db);
  const snapshot = await db.doc(MAIL_ROUTING_DOC_PATH).get();
  const data = snapshot.exists ? asRecord(snapshot.data()) : {};
  const byOrgIdRaw = asRecord(data.byOrgId);
  const byOrgId: Record<string, string> = {};
  for (const [orgId, accountId] of Object.entries(byOrgIdRaw)) {
    if (typeof accountId === "string" && accountId.trim()) byOrgId[orgId] = accountId.trim();
  }
  // Flu/Task-48: an array (even an explicitly empty one) means an admin has configured the
  // allowlist; anything else (field absent, or a malformed non-array value) means "not yet
  // configured" — null, fail-open. See the MailRouting.personalMailAllowedOrgIds doc comment.
  const personalMailAllowedOrgIdsRaw = data.personalMailAllowedOrgIds;
  const personalMailAllowedOrgIds = Array.isArray(personalMailAllowedOrgIdsRaw)
    ? personalMailAllowedOrgIdsRaw.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : null;
  // (scp 계정 배정 허용) same "an array — even empty — means configured, anything else means
  // not-yet-configured (null, fail-open)" parsing as personalMailAllowedOrgIds above.
  const scpAllowedOrgIdsRaw = data.scpAllowedOrgIds;
  const scpAllowedOrgIds = Array.isArray(scpAllowedOrgIdsRaw)
    ? scpAllowedOrgIdsRaw.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : null;
  return {
    defaultAccountId: asString(data.defaultAccountId, "scp"),
    byOrgId,
    personalMailAllowedOrgIds,
    chatPersonalViewDefaultOrgIds: asStringArray(data.chatPersonalViewDefaultOrgIds),
    scpAllowedOrgIds,
    policyVersion: asString(data.policyVersion, DEFAULT_MAIL_ROUTING_POLICY_VERSION),
    updatedBy: asString(data.updatedBy, ""),
    updatedAt: asString(data.updatedAt, ""),
  };
}

let mailRoutingCacheEntry: { expiresAt: number; value: Promise<MailRouting> } | null = null;

/**
 * Flu/Task-51 P2 (적대 리뷰 — 프로드 지연 이슈 진행 중): readMailAccountsCached와 동일한
 * 짧은-TTL memoization을 settings/mail_routing에도 적용한다. selectOutboundMailAccountForData의
 * scp org-allowlist 게이트(P0-1/기존 callerCtx 게이트 모두)가 scp로 향하는 거의 모든 발신마다
 * readMailRouting()을 매번 라이브로 호출하고 있었다 — mail_routing은 admin 콘솔에서만 바뀌는
 * 저빈도 쓰기 문서라 5분 staleness는 이미 readMailAccountsCached가 감수하는 것과 같은 수준이다.
 * clearMailAccountResolutionCache가 이 항목도 함께 무효화한다(setMailRouting이 이미 쓰기 직후
 * 그 함수를 호출한다).
 */
export function readMailRoutingCached(
  deps: { db?: MailAccountsFirestoreDb } = {},
  now: () => number = () => Date.now(),
): Promise<MailRouting> {
  if (mailRoutingCacheEntry && mailRoutingCacheEntry.expiresAt > now()) {
    return mailRoutingCacheEntry.value;
  }
  const value = readMailRouting(deps);
  const entry = { expiresAt: now() + MAIL_ACCOUNT_RESOLUTION_CACHE_TTL_MS, value };
  mailRoutingCacheEntry = entry;
  value.catch(() => {
    if (mailRoutingCacheEntry === entry) mailRoutingCacheEntry = null;
  });
  return value;
}

/**
 * auto-reply-org-controls (2026-09-24, Codex 적대 리뷰 2회차 BLOCKER 1·3 수리): T049(AI Drama) 등
 * 공유-사서함 예외 판정(mailHumanGate.disabledOrgSharesMailAccount) 전용 조회 — readMailRoutingCached
 * 는 쓸 수 없다. 프로세스-로컬 5분 TTL이라, 관리자가 방금 `T049 → scp` 를 mail_routing에 추가해도
 * clearMailAccountResolutionCache는 그 콜을 처리한 인스턴스만 무효화한다 — 이미 warm 한 다른
 * 인스턴스는 옛 맵을 최대 5분간 계속 본다(라운드 2 BLOCKER 1, 여러 인스턴스에 걸친 캐시 신선도는
 * 이 안전-critical 판정에는 못 받아들일 리스크). 그래서 항상 readMailRouting()으로 라이브 조회한다.
 * 동시에 이 조회 실패(에뮬레이터 없음·일시 Firestore 오류)가 T049 와 무관한 발송까지 막으면
 * 안 되므로(라운드 2 BLOCKER 3 — 새 Promise.all 조회 실패가 sendAutoReplyJob 전체를 실패로
 * 떨어뜨려 Permit 을 disarm 할 위험) fail-open으로 빈 맵을 반환한다 — 이 값의 유일한 용도는
 * disabledOrgSharesMailAccount 의 "추가 hold 신호"뿐이다: 못 읽으면 그 신호가 0이 될 뿐, 주 판정
 * (isAutoReplyOrgExcluded, orgId/mailAccountId 기반)은 이 함수와 무관하게 그대로 적용된다.
 */
export async function readByOrgIdForAutoReplyOrgExclusion(
  deps: { db?: MailAccountsFirestoreDb } = {},
): Promise<Readonly<Record<string, string>>> {
  try {
    return (await readMailRouting(deps)).byOrgId;
  } catch {
    return {};
  }
}

/**
 * (scp 계정 배정 허용) whether `orgId` may have the canonical scp account resolved as its
 * org-mapped or routing-default identity under the current policy.
 *
 * Deliberately the OPPOSITE fail-open direction from isPersonalMailConnectAllowedForOrg's
 * unresolved-org case: an unresolved orgId (Peoply outage, no primary membership, or any other
 * "we could not confidently determine this caller's org" outcome) always returns true here, even
 * once a non-null allowlist is configured — scp is the operational mailbox every org falls back
 * to today, and a directory outage must never additionally black out mail delivery for orgs that
 * were never meant to be restricted. Only a CONFIDENTLY known orgId that is missing from a
 * configured allowlist is ever refused.
 */
// Flu conversation org-filter round 2 (codex adversarial review): compares through
// canonicalScpOrgId on both sides so a configured allowlist entry and a caller's Peoply-resolved
// orgId that are simply the G005/T056 alias of each other never produce a conditional lockout —
// same alias functions/mailConversationAuthorization.ts's canReadScpConversationRowForOrg applies.
function scpAllowedOrgIdsIncludes(scpAllowedOrgIds: readonly string[], orgId: string): boolean {
  const canonicalOrgId = canonicalScpOrgId(orgId);
  return scpAllowedOrgIds.some((allowed) => canonicalScpOrgId(allowed) === canonicalOrgId);
}

export function isScpAssignedToOrg(
  routing: Pick<MailRouting, "scpAllowedOrgIds">,
  orgId: string | null,
): boolean {
  if (routing.scpAllowedOrgIds === null) return true;
  if (!orgId) return true;
  return scpAllowedOrgIdsIncludes(routing.scpAllowedOrgIds, orgId);
}

/**
 * 2026-09-27 security fix (killua/T049 scp leak): the end-user entitlement functions below
 * (listAccessibleMailAccountsForEmail, resolveMailSenderPolicyForEmail) resolve a caller's
 * org-mapped mail account by climbing byOrgId ancestors (resolveConfiguredMailAccountForOrgHierarchy),
 * which historically let ANY descendant of an ancestor org mapped to "scp" (e.g. a group-level
 * default) silently inherit the shared scp mailbox — isScpAssignedToOrg/scpAllowedOrgIds was only
 * ever wired into the queue/infra send gate (assertScpAssignedForOutboundOrg in chat-ai.ts), never
 * into interactive mailbox-view/sender entitlement. This closes that gap for the canonical scp
 * account specifically: a resolved org-mapped route is only honored when it is scp AND the
 * caller's OWN confidently-resolved orgId (never the ancestor org whose byOrgId entry actually
 * matched) is on the configured allowlist, or the caller is a super_admin. Any other mail account
 * kind (a future non-scp shared team mailbox) keeps the existing hierarchy-mapping behavior
 * unchanged — this gate is deliberately scp-specific, matching 헤세's explicit-grant-only policy
 * for the scp mailbox.
 */
function gateMappedAccountForScpEntitlement(
  mappedAccount: MailAccount | null | undefined,
  routing: Pick<MailRouting, "scpAllowedOrgIds">,
  orgId: string | null,
  isSuperAdmin: boolean,
): MailAccount | null | undefined {
  if (!mappedAccount || mappedAccount.accountId !== "scp") return mappedAccount;
  if (isSuperAdmin || isScpExplicitlyGrantedForOrg(routing, orgId)) return mappedAccount;
  return undefined;
}

/**
 * 2026-09-27 security fix round 2 (codex adversarial review, blocker finding #1): unlike
 * isScpAssignedToOrg (which stays fail-open on an unconfigured/unresolved scpAllowedOrgIds — used
 * by the queue/infra send gate, assertScpAssignedForOutboundOrg in chat-ai.ts, AND by the legacy
 * operational resolver's own diagnostic-reason tagging in resolveMailAccountForEmail below, where
 * that fail-open behavior is a deliberate, unrelated operational-continuity decision this fix does
 * not touch — round-2 review correction: isScpAssignedToOrg is not queue-gate-only, but neither of
 * its two call sites is an interactive entitlement path), the INTERACTIVE entitlement gate above
 * must fail CLOSED: 헤세's policy is "scp access must be granted explicitly ... no ancestor
 * inheritance, no defaultAccountId fallback", an unconditional statement, not "unless
 * scpAllowedOrgIds happens to be unset". A super_admin resetting scpAllowedOrgIds back to null
 * (setMailRouting explicitly allows this) must not silently re-open every ancestor-inherited or
 * directly-mapped scp route to every non-super_admin caller.
 */
function isScpExplicitlyGrantedForOrg(
  routing: Pick<MailRouting, "scpAllowedOrgIds">,
  orgId: string | null,
): boolean {
  if (!orgId) return false;
  if (routing.scpAllowedOrgIds === null) return false;
  return scpAllowedOrgIdsIncludes(routing.scpAllowedOrgIds, orgId);
}

/**
 * A super_admin's own (non-viewAs) session sees every configured mailbox, including scp, for
 * VIEWING/history purposes — but never another individual's personally-owned mailbox (any account
 * with an ownerEmail that is not the caller's own: a workspace_oauth or personal external_smtp_imap
 * connection) as a SEND-AS grant. 2026-09-27 security fix round 2 (codex adversarial review, high
 * finding #2): a shared/canonical account (ownerEmail blank — canonical_scp and an org-shared
 * external_smtp_imap identity) is always included; an owned account is included only when its
 * owner IS this caller (round-2 review follow-up, codex medium finding #4: the caller's own
 * `linkedAccount`/`personalAccount` lookup elsewhere only matches kind "workspace_oauth", so a
 * super_admin whose own personal mailbox is `external_smtp_imap` would otherwise lose visibility
 * into it entirely once this filter excludes every owner-marked account outright). `isSuperAdmin`
 * must already reflect the viewAs-resolved EFFECTIVE role (see ResolveMailAccountDeps.isSuperAdmin)
 * so a super_admin "대신 보기" as a restricted member still sees only that member's real,
 * restricted grant set.
 */
function explicitGrantAccountsForEntitlement(
  explicitMailAccountIds: readonly string[],
  accountsById: ReadonlyMap<string, MailAccount>,
  allAccounts: readonly MailAccount[],
  isSuperAdmin: boolean,
  callerEmail: string,
): readonly MailAccount[] {
  if (isSuperAdmin) {
    return allAccounts.filter((account) => !account.ownerEmail || account.ownerEmail === callerEmail);
  }
  return explicitMailAccountIds
    .map((accountId) => accountsById.get(accountId))
    .filter((account): account is MailAccount => Boolean(account));
}

/**
 * Flu/Task-48: whether `orgId` may self-connect a personal mailbox under the current routing
 * policy. See the MailRouting.personalMailAllowedOrgIds doc comment for the fail-open-until-
 * configured / strict-allowlist-once-configured doctrine.
 */
export function isPersonalMailConnectAllowedForOrg(
  routing: Pick<MailRouting, "personalMailAllowedOrgIds">,
  orgId: string | null,
): boolean {
  if (routing.personalMailAllowedOrgIds === null) return true;
  if (!orgId) return false;
  return routing.personalMailAllowedOrgIds.includes(orgId);
}

// ---------- org -> account resolution ----------

type ResolveMailAccountDeps = MailAccountsDeps & {
  readonly peoplyClient?: PeoplyClient;
  readonly now?: () => number;
  /**
   * The caller's EFFECTIVE role (already downgraded to a viewAs target's real role by the
   * caller, when "대신 보기" is active — see functions/mailAccountCallables.ts
   * resolveViewAsTarget). A super_admin's own session sees every configured mailbox, including
   * scp, regardless of org mapping or explicit per-user grants (2026-09-27 security decision);
   * omit this for infra/queue callers, which never get the super_admin bypass.
   */
  readonly isSuperAdmin?: boolean;
};

const resolutionCache = new Map<string, { expiresAt: number; value: ResolveMailAccountResult }>();
type StrictMailOrgResolution = {
  readonly orgId: string | null;
  readonly orgResolutionStatus: MailOrgResolutionStatus;
  /** Self-then-ancestors chain for the resolved org, precomputed by the Peoply directory cache
   * sync. `undefined` when there is no resolved org OR the org came from a cache-miss live
   * fallback (see getCachedOrLivePeoplyPerson) — resolveConfiguredMailAccountForOrgHierarchy
   * treats `undefined` as "do the original live walk for this one request" rather than "no
   * ancestors", so a brand-new user's very first request still resolves ancestor-mapped routing
   * correctly instead of silently missing it. */
  readonly orgAncestry: readonly PeoplyOrgAncestryLink[] | undefined;
};
const strictOrgResolutionCache = new Map<string, { expiresAt: number; value: StrictMailOrgResolution }>();

/**
 * Strict caller org lookup. The legacy resolver below intentionally remains fail-open for
 * infrastructure, but authenticated mailbox views/senders require a Peoply detail that proves
 * the requested email, active employee status, and matching official primary membership row.
 *
 * 2026-09-29 (peoply-directory-cache): the live Peoply call below now goes through
 * getCachedOrLivePeoplyPerson, which reads the daily-synced peoply_directory_cache Firestore
 * snapshot first. A cache hit within PEOPLY_DIRECTORY_CACHE_STALE_TOLERANCE_MS (30 days) never
 * touches Peoply, so a short Peoply outage no longer breaks org resolution for users this app
 * recently verified. Stale rows and genuinely uncached emails still depend on a live call here,
 * matching the existing catch-block fail-closed "directory_unavailable" behavior for those cases.
 */
async function resolveVerifiedMailOrgForEmail(
  email: string,
  deps: ResolveMailAccountDeps = {},
): Promise<StrictMailOrgResolution> {
  const now = deps.now ?? (() => Date.now());
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const cached = strictOrgResolutionCache.get(normalizedEmail);
  if (cached && cached.expiresAt > now()) return cached.value;

  const store = (value: StrictMailOrgResolution): StrictMailOrgResolution => {
    strictOrgResolutionCache.set(normalizedEmail, {
      expiresAt: now() + MAIL_ACCOUNT_RESOLUTION_CACHE_TTL_MS,
      value,
    });
    return value;
  };
  if (!normalizedEmail.includes("@")) {
    return store({ orgId: null, orgResolutionStatus: "unresolved", orgAncestry: undefined });
  }

  // `scp@supercent.io` is a public mailbox identity, not a Peoply employee. Never ask the
  // employee directory to bootstrap or route it; an explicit member mailbox grant is evaluated
  // independently below.
  if (normalizedEmail === CANONICAL_OPERATIONAL_MAILBOX_V1) {
    return store({ orgId: null, orgResolutionStatus: "unresolved", orgAncestry: undefined });
  }

  try {
    // resolveMailAccountsDb applies the same test-seam fallback (setMailAccountsDbForTests) every
    // other Firestore read in this file already goes through — most callers of
    // resolveVerifiedMailOrgForEmail never pass deps.db explicitly (they rely on that seam), and
    // passing deps.db straight through here would silently fall back to the REAL adminDb instead.
    const { detail, orgAncestry } = await getCachedOrLivePeoplyPerson(
      normalizedEmail,
      { membershipView: "official" },
      { ...deps, db: resolveMailAccountsDb(deps.db) },
    );
    const primaryMembership = verifiedPeoplyPrimaryMembershipForEmail(detail, normalizedEmail);
    return store({
      orgId: primaryMembership?.orgId.trim() || null,
      orgResolutionStatus: primaryMembership ? "resolved" : "unresolved",
      orgAncestry: primaryMembership ? orgAncestry : undefined,
    });
  } catch {
    return store({ orgId: null, orgResolutionStatus: "directory_unavailable", orgAncestry: undefined });
  }
}

/**
 * 2026-09-27 scp surface entitlement gate (fix/scp-surface-gate): shared server-side check for
 * scp-specific callables OUTSIDE the mail-account surface (mailAccounts.ts/
 * mailAccountCallables.ts already enforce this for mailbox access via
 * gateMappedAccountForScpEntitlement/explicitGrantAccountsForEntitlement/getMyOrgContext's
 * scpAccessGranted). 2026-09-27 codex adversarial review fix: this must compute the EXACT same
 * projection getMyOrgContext.scpAccessGranted does (resolveMailSenderPolicyForEmail's
 * accessibleAccounts, which folds in per-user explicit mailAccountIds grants alongside the org
 * allowlist) rather than checking settings/mail_routing.scpAllowedOrgIds alone — an
 * org-allowlist-only check would wrongly deny a caller with an explicit per-user "scp" grant
 * whose org isn't allowlisted, and wrongly allow an allowlisted org's caller who has no scp
 * account actually configured/mapped. Pass deps.userId (the caller's own uid) so the per-user
 * grant lookup resolves; pass the caller's EFFECTIVE role's super_admin-ness (already
 * viewAs-downgraded by the caller, same contract as ResolveMailAccountDeps.isSuperAdmin) — never
 * a raw unverified auth.role.
 */
export async function isCallerScpEntitled(
  email: string,
  isSuperAdmin: boolean,
  deps: ResolveMailAccountDeps = {},
): Promise<boolean> {
  if (isSuperAdmin) return true;
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalizedEmail) return false;
  const policy = await resolveMailSenderPolicyForEmail(normalizedEmail, deps);
  return policy.accessibleAccounts.some((account) => account.accountId === "scp");
}

/**
 * SCOPE DECISION (owner 헤세, 2026-09-27, fix/scp-surface-gate rounds 1-3): this gate protects the
 * scp@ mailbox itself (its conversations, sending, auto-reply, mail settings/templates/results)
 * plus /flu/scp, its review screens, and scp-only admin tools (gem grants, the nudge cadence/
 * sequence-mapping branch, qualification Sheet2 tooling, lifecycle maintenance callables with no
 * general UI, etc.). It deliberately does NOT extend to general scp-*program* data that
 * general-purpose pages also read/write on role alone — creator directories
 * (listScpCreatorDirectoryHandler/listScpPortalCreatorsHandler), funnel aggregates
 * (aggregateScpProgramFunnel), lifecycle profiles/history/flow config
 * (getScpLifecycleProfile/getScpLifecycleVideoHistory/getScpLifecycleFlowConfig,
 * read.ts's listScpLifecycleProfiles — backs the general Influencer list page, and the
 * getDataset scpLifecycleProfiles dataset key it shares the same reasoning with; a round-2
 * finding gated both, a round-5 finding reverted them for this exact reason), the nudge
 * sequence config READ (getScpNudgeSequenceConfig — its totalDailyCapOnly save branch stays
 * ungated too, shared with the general Admin workspace), the Campaign Outreach family
 * (approveCampaignOutreach/listCampaignOutreachApprovalQueue/auditCampaignOutreachWave/
 * reconcileCampaignOutreachMailLedgers/processCampaignOutreachQueue), judgeQualification,
 * updateProgramColdMail, and the programSheetLeads/creatorLinks/submissionTasks dataset keys all
 * stay role-only by design — a codex adversarial review round-3 finding recommending gating those
 * too was not adopted. The one deliberate exception: sendCandidateColdMail (a general candidate
 * action) DOES require scp entitlement, but only when the mailbox it predicts it will actually
 * send from resolves to "scp" (including the routing-default fallback) — a non-scp resolved
 * mailbox is unaffected. Future reviewers: widening this gate to the general items above is a
 * scope change, not a bug fix — confirm with 헤세 first.
 *
 * 2026-09-27 scp surface entitlement gate: throwing counterpart of isCallerScpEntitled, matching
 * the assert-and-throw permission-denied shape functions/shared.ts's assertNonGuestAuth already
 * uses — an scp-specific callable calls this immediately after its own assertNonGuestAuth(
 * request, action, OPERATOR_ROLES)-style role gate so a role-permitted but non-entitled caller
 * (e.g. a manager in an org not on scpAllowedOrgIds) is still rejected, fail-closed, server-side
 * — never relying on the client having hidden the surface.
 */
export async function assertScpEntitled(
  auth: AuthContext,
  request: CallableRequestShape,
  action: string,
): Promise<void> {
  const entitled = await isCallerScpEntitled(auth.email ?? "", auth.role === "super_admin", { userId: auth.userId });
  if (entitled) return;
  const error = new Error("permission-denied: scp entitlement required");
  Object.assign(error, {
    code: "permission-denied",
    errorCode: "scp_entitlement_required",
    behaviorLog: makeDeniedBehaviorLog(request, action, auth.gameId ?? "global"),
  });
  throw error;
}

/**
 * Resolution order (PLAN-ORG-MAIL-IDENTITY "추가 결정", 2026-09-10):
 *   ① an ACTIVE workspace_oauth account this email itself owns (self-connected via
 *      functions/mailOAuth.ts beginMailOAuth) — source "user_linked". A pending_auth (not
 *      yet completed) or disabled self-owned account is skipped, not treated as a match.
 *   ② email -> Peoply getPerson -> employee.primaryMembership (orgId) -> mail_routing.byOrgId.
 *   ③ the routing default account.
 * Any Peoply error, missing membership, or unmapped org falls back to the routing default
 * account (fail-open — queue/inbound infrastructure must keep operating even if Peoply is down).
 * Authenticated end-user sender selection uses resolveMailSenderPolicyForEmail below instead, so
 * this concrete operational fallback is never surfaced as a user send-as grant. Cached in-memory
 * for 5 minutes per email (all three outcomes, including ①, share the same cache).
 */
export async function resolveMailAccountForEmail(
  email: string,
  deps: ResolveMailAccountDeps = {},
): Promise<ResolveMailAccountResult> {
  const now = deps.now ?? (() => Date.now());
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const cached = resolutionCache.get(normalizedEmail);
  if (cached && cached.expiresAt > now()) return cached.value;

  const [accounts, routing] = await Promise.all([
    readMailAccounts({ db: deps.db, getRuntimeIntegration: deps.getRuntimeIntegration }),
    readMailRouting({ db: deps.db }),
  ]);
  const accountsById = new Map(accounts.map((account) => [account.accountId, account]));
  const defaultAccount = accountsById.get(routing.defaultAccountId) ?? accountsById.get("scp");
  if (!defaultAccount) {
    throw new Error("mail routing default account could not be resolved (no scp account)");
  }

  const store = (result: ResolveMailAccountResult): ResolveMailAccountResult => {
    resolutionCache.set(normalizedEmail, { expiresAt: now() + MAIL_ACCOUNT_RESOLUTION_CACHE_TTL_MS, value: result });
    return result;
  };
  // Fail-open, never throws: if the default account itself is not active, we still return
  // it (there is nothing safer to fall back to) but the reason says so explicitly instead
  // of silently reusing whatever reason triggered the fallback.
  //
  // (scp 계정 배정 허용) still returns the scp account object itself in this case — every
  // caller of this function (inbound ingest, candidate-org lookups, mailAccountSelection.ts,
  // etc.) depends on `.account` never being empty for infrastructure reasons outside this
  // policy's scope — but the `reason` is overridden to "scp_org_not_assigned" whenever the
  // account this fallback would have used IS the canonical scp account and the caller's org is
  // CONFIDENTLY known (non-null) and excluded from settings/mail_routing.scpAllowedOrgIds. The
  // The actual user-facing enforcement (Chat visibility/sending) uses the positive policy at
  // listAccessibleMailAccountsForEmail, getMyOrgContext, functions/read.ts, and the caller-aware
  // branch of functions/chat-ai.ts. The legacy reason and isScpAssignedToOrg remain for this
  // resolver and server-owned queue/operational paths.
  const fallback = (
    reason: string,
    orgId: string | null,
    orgResolutionStatus: MailOrgResolutionStatus = orgId ? "resolved" : "unresolved",
  ) => {
    const scpOrgNotAssigned = defaultAccount.accountId === "scp" && !isScpAssignedToOrg(routing, orgId);
    return store({
      account: defaultAccount,
      orgId,
      source: "fallback",
      reason: defaultAccount.status !== "active"
        ? "default_account_inactive"
        : scpOrgNotAssigned ? SCP_ORG_NOT_ASSIGNED_REASON : reason,
      orgResolutionStatus,
    });
  };

  if (!normalizedEmail.includes("@")) return fallback("invalid_email", null);

  // 2026-09-10 adversarial review HIGH-4: resolve the Peoply org FIRST, regardless of which
  // account ends up selected below — functions/read.ts's resolveViewerOrgIdForConversationRead
  // needs a self-linked (workspace_oauth) caller's real orgId too, and branch ① used to return
  // orgId:null unconditionally, silently blanking that caller's org read-scope for Chat. Peoply's
  // own getPerson call is itself cached (PEOPLY_DIRECTORY_CACHE_TTL_MS, peoplyClient.ts), and
  // this function's own resolutionCache below caches the WHOLE result for
  // MAIL_ACCOUNT_RESOLUTION_CACHE_TTL_MS — so this adds no new steady-state Peoply traffic once
  // warm. A Peoply failure here still means "unknown org" (orgId stays null), not a thrown error
  // — mail routing must keep flowing even when the directory is unavailable.
  // 2026-09-29 (peoply-directory-cache): goes through getCachedOrLivePeoplyPerson so a known
  // email resolves from the daily-synced snapshot during a Peoply outage instead of falling
  // through to orgId:null.
  let orgId: string | null = null;
  let peoplyFailed = false;
  try {
    const { detail: person } = await getCachedOrLivePeoplyPerson(
      normalizedEmail,
      { membershipView: "official" },
      { ...deps, db: resolveMailAccountsDb(deps.db) },
    );
    orgId = person.employee.primaryMembership || null;
  } catch {
    peoplyFailed = true;
  }

  const orgResolutionStatus: MailOrgResolutionStatus = peoplyFailed
    ? "directory_unavailable"
    : orgId
      ? "resolved"
      : "unresolved";

  // ① self-linked account takes precedence over org routing entirely — a user who connected
  // their own mailbox always wants their own mailbox, regardless of which org they belong to —
  // but still carries their real (Peoply-resolved) orgId now, not a hardcoded null.
  const linkedAccount = accounts.find(
    (account) => account.kind === "workspace_oauth"
      && account.status === "active"
      && account.ownerEmail === normalizedEmail,
  );
  if (linkedAccount) {
    return store({
      account: linkedAccount,
      orgId,
      source: "user_linked",
      reason: "user_linked_account",
      orgResolutionStatus,
    });
  }

  if (peoplyFailed) return fallback("peoply_error", null, orgResolutionStatus);
  if (!orgId) return fallback("no_primary_membership", null, orgResolutionStatus);
  const mappedAccountId = routing.byOrgId[orgId];
  if (!mappedAccountId) return fallback("org_unmapped", orgId);
  const mappedAccount = accountsById.get(mappedAccountId);
  if (!mappedAccount) return fallback("org_account_missing", orgId);
  if (mappedAccount.status !== "active") return fallback("org_account_disabled", orgId);
  // Flu/Task-51 P1-1 (적대 리뷰): keep the legacy resolver's operational diagnostic when an admin
  // maps byOrgId[orgId] straight to "scp" but excludes that org from scpAllowedOrgIds. This
  // resolver is still used by infrastructure paths; authenticated mailbox views/senders use the
  // separate positive byOrgId policy below and do not consume this diagnostic as an entitlement
  // gate. Still return the real mappedAccount object (rather than substituting the routing default).
  if (mappedAccount.accountId === "scp" && !isScpAssignedToOrg(routing, orgId)) {
    return store({
      account: mappedAccount,
      orgId,
      source: "peoply",
      reason: SCP_ORG_NOT_ASSIGNED_REASON,
      orgResolutionStatus,
    });
  }
  return store({
    account: mappedAccount,
    orgId,
    source: "peoply",
    reason: "org_mapped",
    orgResolutionStatus,
  });
}

export type AccessibleMailAccountsResult = {
  /**
   * Deduped entitled mailbox views, in personal-then-explicit-org order. The routing default is
   * deliberately absent: it is an infrastructure fallback, never a caller entitlement.
   * Accounts remain eligible views while disabled/pending_auth so existing history can still be
   * addressed; sendEmail separately uses MailSenderPolicy.usableSenders for active senders.
   */
  readonly accounts: readonly MailAccount[];
  readonly orgId: string | null;
  readonly personalMailConnectAllowed: boolean;
  /** Flu/Task-48: which Chat account-view this caller should land on before they have ever made
   * an explicit choice — an entitled personal-only view defaults to "personal"; when an explicit
   * org view exists, only a linked account whose resolved org is listed in
   * MailRouting.chatPersonalViewDefaultOrgIds (e.g. AI Drama) defaults to "personal". */
  readonly defaultView: "personal" | "org";
  /**
   * 2026-09-28 codex adversarial review round 2 (finding #4): "unresolved" (no primary
   * membership — a real, confident answer) and "directory_unavailable" (Peoply itself failed —
   * we simply don't know) both surface here as `orgId: null`, but callers that gate scp-mailbox
   * visibility on `orgId` must tell them apart: a directory outage must read as a retryable error,
   * never as "this caller has no org / no scp access" (functions/conversationMailAccessScope.ts).
   */
  readonly orgResolutionStatus: MailOrgResolutionStatus;
};

function dedupeMailAccounts(accounts: readonly (MailAccount | null | undefined)[]): MailAccount[] {
  const seen = new Set<string>();
  const deduped: MailAccount[] = [];
  for (const account of accounts) {
    if (!account || seen.has(account.accountId)) continue;
    seen.add(account.accountId);
    deduped.push(account);
  }
  return deduped;
}

function sharedGrantProjectionAccount(
  mappedAccount: MailAccount | null | undefined,
  grantedAccounts: readonly MailAccount[],
  routing: Pick<MailRouting, "defaultAccountId">,
): MailAccount | null {
  if (mappedAccount) return mappedAccount;
  const configuredDefaultGrant = grantedAccounts.find((account) => account.accountId === routing.defaultAccountId);
  if (configuredDefaultGrant) return configuredDefaultGrant;
  const stableActiveGrant = [...grantedAccounts]
    .filter((account) => account.status === "active")
    .sort((left, right) => left.accountId.localeCompare(right.accountId))[0];
  if (stableActiveGrant) return stableActiveGrant;
  return [...grantedAccounts].sort((left, right) => left.accountId.localeCompare(right.accountId))[0] ?? null;
}

/**
 * Flu/Task-48 — the entitled mailbox-view set behind the Chat account-view toggle. It includes
 * only the caller's own linked account and an explicitly mapped account for the verified primary
 * organization or a Peoply-proven ancestor. It never includes routing.defaultAccountId, because
 * that value is an operational fallback and must not grant a user access to another team's
 * mailbox. A disabled/pending account may remain a view so its existing history is not hidden;
 * the strict sender policy filters those rows out of usableSenders.
 */
export async function listAccessibleMailAccountsForEmail(
  email: string,
  deps: ResolveMailAccountDeps = {},
): Promise<AccessibleMailAccountsResult> {
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const [resolution, accounts, routing] = await Promise.all([
    resolveVerifiedMailOrgForEmail(normalizedEmail, deps),
    readMailAccountsCached({ db: deps.db, getRuntimeIntegration: deps.getRuntimeIntegration }),
    readMailRouting({ db: deps.db }),
  ]);
  const explicitMailAccountIds = await readExplicitMailAccountIds(
    deps.userId,
    normalizedEmail,
    resolveMailAccountsDb(deps.db),
  );
  const accountsById = new Map(accounts.map((account) => [account.accountId, account]));
  const linkedAccount = accounts.find(
    (account) => account.kind === "workspace_oauth" && account.ownerEmail === normalizedEmail,
  );
  const configuredRoute = await resolveConfiguredMailAccountForOrgHierarchy(
    resolution.orgId,
    routing,
    deps.peoplyClient ?? getPeoplyClient(),
    resolution.orgAncestry,
  );
  const isSuperAdmin = deps.isSuperAdmin === true;
  const mappedAccount = gateMappedAccountForScpEntitlement(
    configuredRoute ? accountsById.get(configuredRoute.accountId) : undefined,
    routing,
    resolution.orgId,
    isSuperAdmin,
  );
  const explicitlyGrantedAccounts = explicitGrantAccountsForEntitlement(
    explicitMailAccountIds,
    accountsById,
    accounts,
    isSuperAdmin,
    normalizedEmail,
  );

  const personalMailConnectAllowed = isPersonalMailConnectAllowedForOrg(routing, resolution.orgId);
  // A directory outage or a user with no primary membership cannot prove a team-level personal
  // allowlist decision. Preserve an already-owned personal mailbox view in that case; the strict
  // sender policy still filters it to active rows, while a new connection remains controlled by
  // personalMailConnectAllowed.
  const personalViewAllowed = resolution.orgId === null || personalMailConnectAllowed;
  // An explicit byOrgId route is the positive org/team entitlement. A member grant is also a
  // positive UID-bound entitlement, but it must be projected deterministically: the configured
  // default wins only when it was already granted, otherwise the first active grant by account id
  // is the shared view. The routing default alone is never an entitlement.
  const orgAccount = sharedGrantProjectionAccount(mappedAccount, explicitlyGrantedAccounts, routing);
  const dedupedAccounts = dedupeMailAccounts([
    // A revoked personal-connect allowlist removes the personal view once the caller's org is
    // confidently known. Unknown/directory-failure callers retain their own existing view.
    linkedAccount && personalViewAllowed ? linkedAccount : undefined,
    orgAccount,
    ...explicitlyGrantedAccounts,
  ]);

  const defaultView: "personal" | "org" =
    linkedAccount
    && personalViewAllowed
    && (!orgAccount
      || (resolution.orgId !== null && routing.chatPersonalViewDefaultOrgIds.includes(resolution.orgId)))
      ? "personal"
      : "org";

  return {
    accounts: dedupedAccounts,
    orgId: resolution.orgId,
    personalMailConnectAllowed,
    defaultView,
    orgResolutionStatus: resolution.orgResolutionStatus,
  };
}

/**
 * The end-user sender entitlement. This intentionally does not reuse the legacy resolver's
 * routing fallback: that resolver is still used by inbound/queue infrastructure which needs a
 * concrete account object, while an authenticated user's sender set must be empty when Peoply
 * cannot establish a team or when their team has no explicit shared account.
 *
 * Entitlement is derived from the verified auth email, a validated official Peoply primary
 * membership, and the explicit settings/mail_routing.byOrgId mapping. The routing default is
 * never a user sender entitlement. A linked personal OAuth account belongs only to its owner; an
 * account mapped by byOrgId is a team identity even if its kind happens to be workspace_oauth or
 * external_smtp_imap.
 */
export type MailSenderBlockedReason =
  | "personal_connection_required"
  | "org_mail_account_unavailable";

export type MailSenderPolicy = {
  readonly email: string;
  readonly orgId: string | null;
  readonly orgResolutionStatus: MailOrgResolutionStatus;
  /** Entitled mailbox views; status may be pending_auth/disabled for history access. */
  readonly personalAccount: MailAccount | null;
  /** Entitled explicit team mailbox view; status may be pending_auth/disabled for history access. */
  readonly orgAccount: MailAccount | null;
  /** Active accounts from the two entitled views that can currently be selected for sending. */
  readonly usableSenders: readonly MailAccount[];
  /** Active default sender, or null when the caller must connect personal mail. */
  readonly defaultAccount: MailAccount | null;
  readonly defaultSenderId: string | null;
  readonly senderBlockedReason: MailSenderBlockedReason | null;
  readonly personalMailConnectAllowed: boolean;
  readonly defaultView: "personal" | "org";
  /** All entitled mailbox views, including explicit per-user grants. */
  readonly accessibleAccounts: readonly MailAccount[];
  /** Mailbox views granted directly on the authenticated member record. */
  readonly memberAccounts: readonly MailAccount[];
};

/**
 * Finds an explicit routing entry for the verified primary organization or one of its
 * authoritative Peoply parents. Parent traversal is bounded and follows only `parentId` values
 * returned by Peoply; organization names, auth claims, and mailbox domains are never used for
 * routing. A child mapping always wins over an ancestor mapping.
 */
export type MailOrgAccountRoute = {
  readonly accountId: string;
  /** The exact org id whose explicit byOrgId entry matched. */
  readonly mappedOrgId: string;
};

/**
 * Resolves the explicit shared-mail route for a verified primary organization. This is shared by
 * sender and mailbox-view entitlement: callers must not replace it with routing.defaultAccountId
 * or a name/domain heuristic. A child route wins over an ancestor route; an ancestor is followed
 * only through Peoply's authoritative parentId response.
 *
 * 2026-09-29 (peoply-directory-cache): when the caller passes `precomputedAncestry` (the same
 * self-then-ancestors chain StrictMailOrgResolution.orgAncestry carries, sourced from the daily
 * Peoply directory cache sync), the walk is purely in-memory over that array — no live
 * client.getOrganization calls at all, so a Peoply outage can never block this step for a user
 * who is already in the cache. Passing `undefined` (every pre-existing caller/test) keeps the
 * exact original live-walk behavior unchanged.
 */
export async function resolveConfiguredMailAccountForOrgHierarchy(
  primaryOrgId: string | null,
  routing: Pick<MailRouting, "byOrgId">,
  client: PeoplyClient,
  precomputedAncestry?: readonly PeoplyOrgAncestryLink[] | null,
): Promise<MailOrgAccountRoute | null> {
  if (!primaryOrgId) return null;

  if (precomputedAncestry !== undefined) {
    for (const link of precomputedAncestry ?? []) {
      const directMapping = routing.byOrgId[link.orgId] ?? routing.byOrgId[canonicalScpOrgId(link.orgId)];
      if (directMapping) return { accountId: directMapping, mappedOrgId: link.orgId };
    }
    return null;
  }

  const visited = new Set<string>();
  let currentOrgId: string | null = primaryOrgId;
  for (let depth = 0; currentOrgId && depth < 32; depth += 1) {
    if (visited.has(currentOrgId)) return null;
    visited.add(currentOrgId);
    // Flu conversation org-filter round 3 (codex adversarial review round 3, finding #7):
    // byOrgId is a raw, manually-curated ops map — canonicalScpOrgId's G005->T056 alias already
    // governs the scp allowlist check and every row/viewer org match, but this direct lookup only
    // ever compared the UNaliased org id, so a primary-G005 caller got no routed account at all
    // unless an admin separately duplicated T056's byOrgId entry under "G005" too. Try the raw key
    // first (preserves any existing config that already keys byOrgId by "G005" directly, e.g. an
    // ancestor-mapping entry), then fall back to the canonical key — canonicalScpOrgId is the
    // identity function for every org id that isn't G005, so this changes nothing for any other org.
    const directMapping = routing.byOrgId[currentOrgId] ?? routing.byOrgId[canonicalScpOrgId(currentOrgId)];
    if (directMapping) return { accountId: directMapping, mappedOrgId: currentOrgId };
    if (typeof client.getOrganization !== "function") return null;
    let organization: Awaited<ReturnType<PeoplyClient["getOrganization"]>>;
    try {
      organization = await client.getOrganization(currentOrgId, { membershipView: "official" });
    } catch {
      // A failed ancestor lookup is treated as no shared sender. The caller can still use an
      // already linked personal sender, but must never be sent through the routing default.
      return null;
    }
    const parentId = typeof organization.parentId === "string" ? organization.parentId.trim() : "";
    currentOrgId = parentId || null;
  }
  return null;
}

/**
 * Resolves the strict sender policy for a verified caller. `personalAccount`/`orgAccount` are
 * entitled mailbox views and may retain a pending/disabled stored status for history access;
 * `usableSenders` and `defaultAccount` contain only active configuration rows. `status: "active"`
 * is not reported as live provider health.
 */
export async function resolveMailSenderPolicyForEmail(
  email: string,
  deps: ResolveMailAccountDeps = {},
): Promise<MailSenderPolicy> {
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const [resolution, accounts, routing] = await Promise.all([
    resolveVerifiedMailOrgForEmail(normalizedEmail, deps),
    readMailAccountsCached({ db: deps.db, getRuntimeIntegration: deps.getRuntimeIntegration }),
    readMailRouting({ db: deps.db }),
  ]);
  const explicitMailAccountIds = await readExplicitMailAccountIds(
    deps.userId,
    normalizedEmail,
    resolveMailAccountsDb(deps.db),
  );
  const accountsById = new Map(accounts.map((account) => [account.accountId, account]));
  const linkedAccount = accounts.find(
    (account) => account.kind === "workspace_oauth"
      && account.ownerEmail === normalizedEmail,
  ) ?? null;

  const personalMailConnectAllowed = isPersonalMailConnectAllowedForOrg(routing, resolution.orgId);

  // An existing owned account remains usable while the directory is unavailable or does not
  // return a primary team. Once a primary team is known, the explicit personal allowlist still
  // applies; this preserves the existing admin revocation control without letting a directory
  // outage silently force the caller onto a shared mailbox.
  // Keep an owned account as a mailbox view while it is pending/disabled so its history remains
  // addressable. A known personal-mail allowlist denial still removes that view; an unresolved
  // or unavailable directory result cannot safely evaluate that allowlist and preserves it.
  const personalViewAllowed = resolution.orgId === null || personalMailConnectAllowed;
  const personalAccount = linkedAccount
    && personalViewAllowed
      ? linkedAccount
      : null;

  const configuredRoute = await resolveConfiguredMailAccountForOrgHierarchy(
    resolution.orgId,
    routing,
    deps.peoplyClient ?? getPeoplyClient(),
    resolution.orgAncestry,
  );
  const isSuperAdmin = deps.isSuperAdmin === true;
  const mappedAccountId = configuredRoute?.accountId ?? null;
  const mappedAccount = gateMappedAccountForScpEntitlement(
    mappedAccountId ? accountsById.get(mappedAccountId) ?? null : null,
    routing,
    resolution.orgId,
    isSuperAdmin,
  ) ?? null;
  const explicitlyGrantedAccounts = explicitGrantAccountsForEntitlement(
    explicitMailAccountIds,
    accountsById,
    accounts,
    isSuperAdmin,
    normalizedEmail,
  );
  // Keep user sender entitlement positive: a verified explicit byOrgId route or a server-owned
  // per-user mailbox grant is sufficient even when the legacy scpAllowedOrgIds list is absent.
  // For multiple direct grants, prefer the configured default only if already granted; otherwise
  // pick a stable active account id. The routing default by itself remains non-authorizing.
  const orgAccount = sharedGrantProjectionAccount(mappedAccount, explicitlyGrantedAccounts, routing);
  const accessibleAccounts = dedupeMailAccounts([personalAccount, orgAccount, ...explicitlyGrantedAccounts]);

  const usableSenders: MailAccount[] = [];
  for (const candidate of accessibleAccounts) {
    if (candidate
      && candidate.status === "active"
      && !usableSenders.some((account) => account.accountId === candidate.accountId)) {
      usableSenders.push(candidate);
    }
  }
  const activeOrgAccount = orgAccount?.status === "active" ? orgAccount : null;
  const activePersonalAccount = personalAccount?.status === "active" ? personalAccount : null;
  const defaultAccount = activeOrgAccount ?? activePersonalAccount;
  const senderBlockedReason: MailSenderBlockedReason | null = defaultAccount
    ? null
    : mappedAccountId || orgAccount
      ? "org_mail_account_unavailable"
      : "personal_connection_required";
  const defaultView: "personal" | "org" = orgAccount
    ? personalAccount
      && personalMailConnectAllowed
      && resolution.orgId !== null
      && routing.chatPersonalViewDefaultOrgIds.includes(resolution.orgId)
      ? "personal"
      : "org"
    : personalAccount
      ? "personal"
      : "org";

  return {
    email: normalizedEmail,
    orgId: resolution.orgId,
    orgResolutionStatus: resolution.orgResolutionStatus,
    personalAccount,
    orgAccount,
    usableSenders,
    defaultAccount,
    defaultSenderId: defaultAccount?.accountId ?? null,
    senderBlockedReason,
    personalMailConnectAllowed,
    defaultView,
    accessibleAccounts,
    memberAccounts: explicitlyGrantedAccounts,
  };
}

/**
 * Clears the process-local resolution cache. Call after a mail_accounts/mail_routing write
 * so this instance sees the change immediately; other instances converge within
 * MAIL_ACCOUNT_RESOLUTION_CACHE_TTL_MS (5 min) as their own cache entries expire. Also clears
 * readMailAccountsCached's and readMailRoutingCached's own memoization (same TTL, same
 * staleness contract).
 */
export function clearMailAccountResolutionCache(): void {
  resolutionCache.clear();
  strictOrgResolutionCache.clear();
  mailAccountsCacheEntry = null;
  mailRoutingCacheEntry = null;
}
