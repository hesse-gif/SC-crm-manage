import { asString, type Role } from "./shared";
import { listAccessibleMailAccountsForEmail, readMailAccountsCached } from "./mailAccounts";
import {
  CANONICAL_SCP_MAIL_ACCOUNT_ID,
  canReadMailConversationRow,
  canReadScpConversationRowForOrg,
  type MailConversationAuthorizationScope,
} from "./mailConversationAuthorization";

/**
 * Flu conversation org-filter (follow-up to Task/PR#216 + codex adversarial review round 2, 2026-
 * 09-27): the SINGLE shared resolver + predicate for "may this caller read/act on this
 * conversation row". functions/read.ts's list/room/message-source reads and the scp-only
 * unreplied-inbox queue, functions/dashboardPipelineProjection.ts's conversations lane,
 * functions/chat-ai.ts's gatewayProxy/markConversationRead/setConversationAutoReply, and
 * functions/managementProfileTabsPorts.ts's journey reader all resolve the SAME positive
 * mail-account entitlement (functions/mailAccounts.ts listAccessibleMailAccountsForEmail) plus the
 * SAME scp-per-org narrowing (functions/mailConversationAuthorization.ts
 * canReadScpConversationRowForOrg) through this one module — round 1 of this filter put the
 * predicate only in functions/read.ts's local canReadConversationForAuth, and codex round 2 found
 * four other conversation-reading/-mutating surfaces that never called it. Adding a new
 * conversation-reading surface means importing THIS module, not re-deriving the check.
 */
export type ConversationMailAccessAuth = {
  readonly role: Role;
  readonly email?: string;
  readonly userId?: string;
};

export type ConversationMailAccessScope = {
  /** The caller's own resolved org (null = no confidently-resolved org). */
  readonly viewerOrgId: string | null;
  /** Positive mail-account entitlement set (functions/mailAccounts.ts). */
  readonly authorizedMailAccountIds: readonly string[];
  /** A super_admin's own (non-viewAs) session keeps the full inventory view. */
  readonly isSuperAdmin: boolean;
  /** Whether the caller holds the positive scp mailbox grant — see MailConversationOrgScope's doc
   * comment (functions/mailConversationAuthorization.ts) for why this is required in addition to
   * org match. */
  readonly hasScpEntitlement: boolean;
};

/**
 * 2026-09-28 codex adversarial review round 2 (finding #4): a Peoply/directory outage must never
 * be silently indistinguishable from "this caller confidently has no org / no scp access" — the
 * caller-visible difference is "try again" vs "you don't have access". Every non-super_admin
 * resolution path below throws this (HttpsError-shaped: code "unavailable") the moment the
 * directory itself — not the caller's entitlement — is the reason nothing could be resolved.
 */
export function conversationMailAccessDirectoryUnavailableError(): Error {
  return Object.assign(
    new Error("unavailable: the employee directory is temporarily unavailable — please retry"),
    { code: "unavailable", errorCode: "conversation_mail_access_directory_unavailable" },
  );
}

export async function resolveConversationMailAccessScope(
  auth: ConversationMailAccessAuth,
): Promise<ConversationMailAccessScope> {
  if (auth.role === "super_admin") {
    const accounts = await readMailAccountsCached();
    const accountIds = accounts.map((account) => account.accountId);
    return {
      viewerOrgId: null,
      authorizedMailAccountIds: accountIds,
      isSuperAdmin: true,
      hasScpEntitlement: accountIds.includes(CANONICAL_SCP_MAIL_ACCOUNT_ID),
    };
  }

  const email = asString(auth.email).toLowerCase();
  if (!email) return { viewerOrgId: null, authorizedMailAccountIds: [], isSuperAdmin: false, hasScpEntitlement: false };
  let accessible: Awaited<ReturnType<typeof listAccessibleMailAccountsForEmail>>;
  try {
    accessible = await listAccessibleMailAccountsForEmail(email, { userId: auth.userId });
  } catch {
    // Any failure resolving the caller's mail-account entitlement (directory outage, Firestore
    // hiccup) is indistinguishable from "we don't know" and must surface the same way the explicit
    // directory_unavailable status below does — never as a silent empty grant.
    throw conversationMailAccessDirectoryUnavailableError();
  }
  if (accessible.orgResolutionStatus === "directory_unavailable") {
    throw conversationMailAccessDirectoryUnavailableError();
  }
  return {
    viewerOrgId: accessible.orgId,
    authorizedMailAccountIds: accessible.accounts.map((account) => account.accountId),
    isSuperAdmin: false,
    hasScpEntitlement: accessible.accounts.some((account) => account.accountId === CANONICAL_SCP_MAIL_ACCOUNT_ID),
  };
}

/** The safe default for a surface that must fail closed for explicit-scp rows only, never throw —
 * see lazyConversationMailAccessScope below. No confidently-resolved org or grant, so
 * canReadScpConversationRowForOrg denies any row it actually narrows; every other row is
 * unaffected regardless (its own first branch already returns true before this is consulted). */
const DIRECTORY_UNAVAILABLE_SCP_ONLY_FALLBACK_SCOPE: ConversationMailAccessScope = {
  viewerOrgId: null,
  authorizedMailAccountIds: [],
  isSuperAdmin: false,
  hasScpEntitlement: false,
};

/**
 * Flu conversation org-filter round 22 (codex adversarial review round 22, finding #2): a handful
 * of surfaces (functions/dashboardPipelineProjection.ts's conversations lane,
 * functions/managementProfileTabsPorts.ts's journey reader, functions/mailSignature.ts's outbox
 * pager) mix scp and non-scp/personal rows in the SAME read and must not let a Peoply/directory
 * outage fail the WHOLE read just because resolveConversationMailAccessScope's own fail-closed
 * throw (see its doc comment above) is the right behavior for a mailbox-SPECIFIC surface (Chat
 * list/messages/send) but the wrong one here — those non-scp rows worked on origin/main and must
 * keep working during an outage. Returns a resolver that:
 *   - never calls resolveConversationMailAccessScope until first invoked (the caller decides WHEN
 *     that is — typically "a row I'm looking at right now is actually explicit-scp");
 *   - memoizes the result (success or the fallback below) so a scan touching many rows only ever
 *     attempts the lookup once;
 *   - on failure, resolves to DIRECTORY_UNAVAILABLE_SCP_ONLY_FALLBACK_SCOPE instead of rejecting —
 *     denies explicit-scp rows for the rest of this read, never throws past the caller.
 * super_admin still never calls Peoply at all here (resolveConversationMailAccessScope's own
 * super_admin short-circuit runs first and cannot fail this way).
 */
export function lazyConversationMailAccessScope(
  auth: ConversationMailAccessAuth,
  onFailure?: (err: unknown) => void,
): () => Promise<ConversationMailAccessScope> {
  let resolution: Promise<ConversationMailAccessScope> | null = null;
  return () => {
    resolution ??= resolveConversationMailAccessScope(auth).catch((err) => {
      onFailure?.(err);
      return DIRECTORY_UNAVAILABLE_SCP_ONLY_FALLBACK_SCOPE;
    });
    return resolution;
  };
}

/**
 * The row-level predicate every caller above applies after resolving its scope once. Combines the
 * PR#216 positive mail-account allowlist with the scp-per-org narrowing — see
 * functions/mailConversationAuthorization.ts's canReadMailConversationRow/
 * canReadScpConversationRowForOrg doc comments for exactly what each half does and why the legacy
 * blank-mailAccountId population is exempt from the org half.
 */
export function canReadConversationRowForScope(
  row: Record<string, unknown>,
  scope: ConversationMailAccessScope,
  requestedMailAccountId = "",
): boolean {
  const authScope: MailConversationAuthorizationScope = {
    authorizedMailAccountIds: scope.authorizedMailAccountIds,
    requestedMailAccountId,
  };
  if (!canReadMailConversationRow(row, authScope)) return false;
  return canReadScpConversationRowForOrg(row, {
    viewerOrgId: scope.viewerOrgId,
    isSuperAdmin: scope.isSuperAdmin,
    hasScpEntitlement: scope.hasScpEntitlement,
  });
}
