/** Server-derived authorization for the narrow inbound auto-reply approval exception. */
export type InboundAutoReplyAccount = {
  accountId: string;
  mailbox: string;
  status: string;
};

export function isTrustedInboundAutoReplyAccount(input: {
  allowedAccountIds: unknown;
  accountId: unknown;
  accountMailbox: unknown;
  account: InboundAutoReplyAccount | null;
}): boolean {
  if (!Array.isArray(input.allowedAccountIds)) return false;
  if (typeof input.accountId !== "string" || typeof input.accountMailbox !== "string") return false;
  const accountId = input.accountId.trim().toLowerCase();
  const mailbox = input.accountMailbox.trim().toLowerCase();
  const account = input.account;
  return Boolean(
    accountId && mailbox && account
    && account.status === "active"
    && account.accountId === accountId
    && account.mailbox.trim().toLowerCase() === mailbox
    && input.allowedAccountIds.some((value) => typeof value === "string" && value.trim().toLowerCase() === accountId),
  );
}
