/**
 * PLAN-ORG-MAIL-IDENTITY Slice 3 — outbound account selection.
 * See docs/PLAN-ORG-MAIL-IDENTITY.md for the data model and rollout plan.
 *
 * Pure selection logic used by chat-ai.ts's live SMTP send gate to pick which
 * mail_accounts/{accountId} a given outbound message goes out from:
 *   ① conversation.mailAccountId, when present and that account is ACTIVE.
 *   ② resolveMailAccountForEmail(senderEmail) (functions/mailAccounts.ts — itself
 *      ① self-linked → ② Peoply org mapping → ③ routing default), when a
 *      senderEmail is available.
 *   ③ the routing default account, when neither of the above applies.
 * No side effects beyond the reads readMailAccounts/readMailRouting/
 * resolveMailAccountForEmail already perform — this module does not fetch the
 * conversation doc itself, callers pass in whatever they already loaded.
 */
import {
  isMailAccountIdSlug,
  readMailAccounts,
  readMailRouting,
  resolveMailAccountForEmail,
  type MailAccount,
  type MailAccountsDeps,
} from "./mailAccounts";
import { CANONICAL_OPERATIONAL_MAILBOX_V1 } from "./mailIdentity";
import type { PeoplyClient } from "./peoplyClient";
import { asString } from "./shared";

export type SelectOutboundMailAccountDeps = MailAccountsDeps & {
  readonly peoplyClient?: PeoplyClient;
  readonly now?: () => number;
};

export type SelectOutboundMailAccountSource = "conversation_pinned" | "email_resolved" | "default";

export type SelectOutboundMailAccountInput = {
  /** The already-loaded conversation record (or a projection of it), if any. */
  readonly conversation?: { readonly mailAccountId?: unknown } | null;
  readonly senderEmail?: string;
  readonly deps?: SelectOutboundMailAccountDeps;
};

export type SelectOutboundMailAccountResult = {
  readonly account: MailAccount;
  readonly source: SelectOutboundMailAccountSource;
};

export function assertCanonicalScpOutboundMailAccount(
  account: MailAccount | null | undefined,
): asserts account is MailAccount {
  if (
    !account ||
    account.accountId !== "scp" ||
    account.kind !== "canonical_scp" ||
    account.status !== "active" ||
    account.mailbox.trim().toLowerCase() !== CANONICAL_OPERATIONAL_MAILBOX_V1
  ) {
    throw new Error("failed-precondition: canonical SCP sender is unavailable");
  }
}

/**
 * Resolve the sole server-owned SCP sender for transactional SCP worker mail.
 *
 * This deliberately does not take an account id or mailbox from a caller.  The
 * synthesized `scp` record is re-read for each send so a worker cannot drift to
 * routing's default account (or keep using a revoked external account).
 */
export async function selectCanonicalScpOutboundMailAccount(
  deps: SelectOutboundMailAccountDeps = {},
): Promise<MailAccount> {
  const account = (await readMailAccounts(deps)).find(
    (candidate) => candidate.accountId === "scp",
  );
  assertCanonicalScpOutboundMailAccount(account);
  return account;
}

export async function selectOutboundMailAccount(
  input: SelectOutboundMailAccountInput,
): Promise<SelectOutboundMailAccountResult> {
  const deps = input.deps ?? {};
  const accounts = await readMailAccounts(deps);

  const pinnedAccountId = asString(input.conversation?.mailAccountId, "");
  if (pinnedAccountId && isMailAccountIdSlug(pinnedAccountId)) {
    const pinned = accounts.find(
      (account) => account.accountId === pinnedAccountId && account.status === "active",
    );
    if (pinned) return { account: pinned, source: "conversation_pinned" };
  }

  const senderEmail = (input.senderEmail ?? "").trim();
  if (senderEmail) {
    const resolved = await resolveMailAccountForEmail(senderEmail, deps);
    return { account: resolved.account, source: "email_resolved" };
  }

  const routing = await readMailRouting({ db: deps.db });
  const accountsById = new Map(accounts.map((account) => [account.accountId, account]));
  const defaultAccount = accountsById.get(routing.defaultAccountId) ?? accountsById.get("scp");
  if (!defaultAccount) {
    throw new Error("mail routing default account could not be resolved (no scp account)");
  }
  return { account: defaultAccount, source: "default" };
}
