import { CANONICAL_OPERATIONAL_MAILBOX_V1, normalizeMailboxAddress } from "./mailIdentity";

// conv_13ioeao (2026-09-27, 헤세 지시): a creator can reply from a DIFFERENT address than the
// one we emailed (personal Gmail/web.de vs the program inbox we actually sent to) while their
// mail client still quotes the original message's header block inline — e.g. Outlook's
// German "Von:/Gesendet:/An:/Betreff:" block, the English "From:/Sent:/To:/Subject:" block, or a
// Korean "발신/보낸 날짜/수신/제목" block, each usually preceded by a "-----Original Message-----"
// (or localized) separator line. When In-Reply-To/References are missing (new thread, forward, or
// a client that drops them) and the SMTP envelope From doesn't match anything we sent to, that
// quoted block is often the ONLY remaining signal tying the reply back to our outreach.
//
// This module extracts JUST the quoted original recipient (the quoted To/An address) — and ONLY
// when the quoted original sender (From/Von) is verifiably our own canonical scp@ mailbox. Any
// other quoted sender returns null: a creator quoting an unrelated third-party thread must never
// manufacture an attribution signal. The caller (functions/conversationAttribution.ts) still has
// to find a REAL outbound record addressed to that recipient before this becomes evidence — this
// module only answers "does the raw text claim scp@ sent to X", never "did scp@ actually send to X".
//
// Must run on the RAW email body — BEFORE any quote-stripping (mailImapLive.ts's
// stripQuotedReply) removes the header block this depends on.

const EMAIL_TOKEN_PATTERN = /[^\s<>"'()]+@[^\s<>"'()]+\.[^\s<>"'()]+/;

// From/Von (German)/De (French)/발신 (Korean).
const FROM_LABELS = ["from", "von", "de", "발신"] as const;
// To/An (German)/À (French)/수신 (Korean).
const TO_LABELS = ["to", "an", "à", "수신"] as const;

// How many lines after a matched From/Von/발신 line to look for the paired To/An/수신 line — the
// quoted header block's fields (From, Sent/Date, To, Subject) all sit together at the top of the
// quoted message, in either order depending on the mail client.
const HEADER_BLOCK_WINDOW = 8;
const MAX_SCANNED_LINES = 4000;

function labelLinePattern(labels: readonly string[]): RegExp {
  const alternation = labels
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(`^\\s*(?:${alternation})\\s*[:：]\\s*(.*)$`, "i");
}

const FROM_LINE = labelLinePattern(FROM_LABELS);
const TO_LINE = labelLinePattern(TO_LABELS);

function extractEmailToken(value: string): string {
  const match = EMAIL_TOKEN_PATTERN.exec(value);
  return match ? normalizeMailboxAddress(match[0]) : "";
}

/**
 * Returns the quoted original recipient email (the quoted To/An address) from a raw inbound
 * email body, but ONLY when the quoted From/Von sender normalizes to
 * CANONICAL_OPERATIONAL_MAILBOX_V1 ("scp@supercent.io"). Returns null when no such header block
 * is found (e.g. a Gmail-style "On ... wrote:" quote with no separate To: line) or when the
 * quoted sender is anyone else.
 */
export function extractQuotedOriginalRecipientEmail(rawText: string): string | null {
  if (!rawText) return null;
  const lines = rawText.replace(/\r\n?/g, "\n").split("\n").slice(0, MAX_SCANNED_LINES);
  for (let i = 0; i < lines.length; i += 1) {
    const fromMatch = FROM_LINE.exec(lines[i]);
    if (!fromMatch) continue;
    const fromEmail = extractEmailToken(fromMatch[1]);
    if (!fromEmail || fromEmail !== CANONICAL_OPERATIONAL_MAILBOX_V1) continue;
    const windowEnd = Math.min(lines.length, i + 1 + HEADER_BLOCK_WINDOW);
    for (let j = i + 1; j < windowEnd; j += 1) {
      const toMatch = TO_LINE.exec(lines[j]);
      if (!toMatch) continue;
      const toEmail = extractEmailToken(toMatch[1]);
      if (toEmail) return toEmail;
    }
  }
  return null;
}
