export const DEFAULT_IMAP_MAILBOX = "INBOX" as const;

type ImapPublicConfiguration = {
  readonly public?: Record<string, unknown>;
};

function mailboxCandidate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) return null;
  // A mailbox is a server-side folder path, never an account/email address.
  // Reject control characters and any email-shaped value inherited from the
  // legacy `replyMailbox` UI before it can reach mailboxOpen().
  if (normalized.includes("@") || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  if (normalized === "." || normalized === "..") return null;
  return normalized.toUpperCase() === DEFAULT_IMAP_MAILBOX
    ? DEFAULT_IMAP_MAILBOX
    : normalized;
}

export function isValidImapMailboxFolder(value: unknown): boolean {
  return mailboxCandidate(value) !== null;
}

/**
 * Resolve the single inbound mailbox contract.
 *
 * `mailbox` is authoritative. A legacy `replyMailbox` value is accepted only
 * when it is a valid folder name; old email-address values are ignored. The
 * environment fallback remains useful for immutable deployment configuration.
 */
export function resolveImapMailbox(
  config: ImapPublicConfiguration,
  envMailbox: unknown = process.env.IMAP_MAILBOX,
): string {
  const values = config.public ?? {};
  return mailboxCandidate(values.mailbox)
    ?? mailboxCandidate(values.replyMailbox)
    ?? mailboxCandidate(envMailbox)
    ?? DEFAULT_IMAP_MAILBOX;
}

/**
 * Canonicalize persisted/public integration settings without retaining the
 * misleading legacy field. This is also the read-time migration projection for
 * existing documents; writes persist only `mailbox`.
 */
export function normalizeImapPublicConfiguration(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const { replyMailbox: _legacyReplyMailbox, ...rest } = values;
  return {
    ...rest,
    mailbox: resolveImapMailbox({ public: values }, null),
  };
}

export function safeImapMailboxName(value: unknown): string {
  return mailboxCandidate(value) ?? DEFAULT_IMAP_MAILBOX;
}
