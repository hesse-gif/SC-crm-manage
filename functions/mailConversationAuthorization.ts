import { asString } from "./shared";

/**
 * The conversations collection is the mail history store.  This module deliberately has no
 * Firestore or account-policy imports so both read paths and outbound preflight can use the same
 * row-level decision without creating a dependency cycle.
 */
export const CANONICAL_SCP_MAIL_ACCOUNT_ID = "scp";

export type MailConversationAuthorizationScope = {
  /**
   * Positive account entitlement calculated by the caller from the strict mail-account policy.
   * A missing/empty list means that no mail history is authorized.
   */
  authorizedMailAccountIds: readonly string[];
  /** An optional account-view narrowing. Blank/undefined means no account-view narrowing. */
  requestedMailAccountId?: string | null;
};

type MailConversationRow = Record<string, unknown> & {
  mailAccountId?: unknown;
  orgId?: unknown;
};

type MailSourceRow = {
  conversationId?: unknown;
};

function normalizedAccountId(value: unknown): string {
  // Mail account IDs are Firestore document IDs, not mailbox addresses. Preserve case so a
  // caller cannot turn a distinct ID into another account by applying email normalization.
  return asString(value);
}

/**
 * Resolve the account that owns a persisted mail row.  Before account stamping shipped, all
 * existing SCP rows were intentionally left blank; those rows retain the canonical SCP identity.
 */
export function normalizedMailAccountIdForRead(row: MailConversationRow): string {
  if (row.mailAccountId === undefined || row.mailAccountId === null) {
    return CANONICAL_SCP_MAIL_ACCOUNT_ID;
  }
  // An explicitly present malformed type is not a legacy blank. Keep it outside every valid
  // whitelist so corrupt data cannot be mistaken for canonical SCP history.
  if (typeof row.mailAccountId !== "string") return "";
  return row.mailAccountId.trim() || CANONICAL_SCP_MAIL_ACCOUNT_ID;
}

/** A blank account stamp and an explicit canonical SCP stamp are the same legacy mailbox. */
export function isLegacyCanonicalScpMailRow(row: MailConversationRow): boolean {
  return normalizedMailAccountIdForRead(row) === CANONICAL_SCP_MAIL_ACCOUNT_ID;
}

/**
 * True only for a row EXPLICITLY stamped `mailAccountId === "scp"` (after trimming) — never for
 * the legacy blank/missing stamp that `normalizedMailAccountIdForRead`/`isLegacyCanonicalScpMailRow`
 * above also fold into the canonical scp bucket for account-ENTITLEMENT purposes. Flu conversation
 * org-filter (follow-up to Task/PR#216 "scp mailbox is explicit-allowlist-only"): the per-org
 * narrowing below (`canReadScpConversationRowForOrg`) must only ever apply to rows the scp mailbox
 * itself actually wrote. The ~22,500 pre-stamp legacy rows (98% hesse@supercent.io personal
 * outreach, predating account stamping entirely) have no orgId either, so folding them into the
 * org gate would hide nearly all of them from every non-super_admin caller who can see them today —
 * including their own owner. This split keeps that legacy population governed only by the
 * unchanged entitlement gate above, exactly as it is today.
 */
export function isExplicitScpMailAccountRow(row: MailConversationRow): boolean {
  return typeof row.mailAccountId === "string" && row.mailAccountId.trim() === CANONICAL_SCP_MAIL_ACCOUNT_ID;
}

/**
 * `G005` is a legacy scp orgId label still carried by ~152 production conversations; 헤세
 * confirmed (2026-09-27) it must be treated as the same org as `T056` for every visibility
 * decision, with no data restamp. Add further aliases here if another legacy label surfaces —
 * this is intentionally the single place that folds a legacy label into its canonical org id.
 */
const LEGACY_SCP_ORG_ID_ALIASES: Readonly<Record<string, string>> = { G005: "T056" };

export function canonicalScpOrgId(orgId: unknown): string {
  const trimmed = asString(orgId).trim();
  return LEGACY_SCP_ORG_ID_ALIASES[trimmed] ?? trimmed;
}

export type MailConversationOrgScope = {
  /** The caller's own resolved org (functions/mailAccounts.ts listAccessibleMailAccountsForEmail). Null = no confidently-resolved org. */
  readonly viewerOrgId: string | null;
  /** A super_admin's own (non-viewAs) session keeps the full scp inventory view. */
  readonly isSuperAdmin: boolean;
  /**
   * Whether the caller holds the positive scp mailbox grant (CANONICAL_SCP_MAIL_ACCOUNT_ID in
   * their authorizedMailAccountIds — functions/mailAccounts.ts listAccessibleMailAccountsForEmail).
   * 2026-09-28 owner scope decision (codex adversarial review round 2): the scp@ mailbox gate is
   * BOTH a positive grant AND an org match, not org match alone — an org-mate with no explicit scp
   * grant must not read/act on the org's own scp conversations just by being in the same org.
   */
  readonly hasScpEntitlement: boolean;
};

/**
 * Flu conversation org-filter (follow-up to Task/PR#216): being on the scp mailbox's explicit
 * allowlist is entitlement to the SHARED MAILBOX, not to every org's history inside it. A
 * super_admin's own session keeps the full inventory view; every other role (admin/manager/
 * viewer) must hold BOTH the positive scp grant AND belong to the row's own org (`G005` folds into
 * `T056` via `canonicalScpOrgId` above) — 2026-09-28 owner scope decision (codex adversarial review
 * round 2): an org match alone let any org member read/act on the org's scp conversations even
 * without ever being granted scp access. A row whose orgId is missing/unmatched, or a viewer with
 * no confidently-resolved org, cannot be proven in-scope and is denied — this policy is fail-closed
 * by design (헤세, 2026-09-27/28 approved).
 *
 * This only ever narrows rows `isExplicitScpMailAccountRow` identifies as scp-written; every other
 * row (including the legacy blank-mailAccountId population) passes through unchanged, exactly as
 * it did before this filter shipped.
 */
export function canReadScpConversationRowForOrg(
  row: MailConversationRow,
  scope: MailConversationOrgScope,
): boolean {
  if (scope.isSuperAdmin) return true;
  if (!isExplicitScpMailAccountRow(row)) return true;
  if (!scope.hasScpEntitlement) return false;
  if (!scope.viewerOrgId) return false;
  return canonicalScpOrgId(row.orgId) === canonicalScpOrgId(scope.viewerOrgId);
}

function normalizedAuthorizedAccountIds(scope: MailConversationAuthorizationScope): Set<string> {
  return new Set(
    scope.authorizedMailAccountIds
      .map((accountId) => normalizedAccountId(accountId))
      .filter(Boolean),
  );
}

/**
 * Decide whether a conversation row belongs to the caller's mail-account view.
 *
 * The account whitelist is the positive authorization boundary.  It prevents a missing
 * `mailAccountId` on a room/source request from becoming a wildcard for an arbitrary shared or
 * personal mailbox. Historical rows may have stale or absent org metadata; that metadata must not
 * revoke an explicitly entitled account's history. Upstream scope resolution owns role/org
 * inventory decisions; this helper intentionally has no role-based bypass.
 */
export function canReadMailConversationRow(
  row: MailConversationRow,
  scope: MailConversationAuthorizationScope,
): boolean {
  const authorized = normalizedAuthorizedAccountIds(scope);
  const rowAccountId = normalizedMailAccountIdForRead(row);
  if (!authorized.has(rowAccountId)) return false;

  const requestedAccountId = normalizedAccountId(scope.requestedMailAccountId);
  if (requestedAccountId && rowAccountId !== requestedAccountId) return false;
  return true;
}

/** Require a source to identify the exact conversation whose authorization was already checked. */
export function isMailSourceBoundToConversation(
  source: MailSourceRow,
  conversationId: string,
): boolean {
  const sourceConversationId = asString(source.conversationId);
  const expectedConversationId = asString(conversationId);
  return Boolean(sourceConversationId && expectedConversationId && sourceConversationId === expectedConversationId);
}
