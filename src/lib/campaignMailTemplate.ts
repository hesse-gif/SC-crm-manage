export type MarkdownSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; label: string; url: string };

export const DEFAULT_CAMPAIGN_MAIL_SUBJECT =
  "Your content caught our eye 👀 — Apply for Our Game Creator Program!";

export const DEFAULT_CAMPAIGN_MAIL_BODY = `Hello, this is Supercent! 👋



Supercent is a mobile game development and publishing company,

with major titles including Burger Please! (118M+ downloads), Pizza Ready (429M+ downloads), and Snake Clash (219M+ downloads).



If you're a game creator looking for something more than a one-off sponsorship,

We have an ongoing creator program that might be just what you're looking for.

Feel free to check it out and apply!



🎮 Super Creator Partners

Super Creator Partners is an official long-term creator partnership program run by Supercent, a global mobile game publisher.



✅ Who Can Apply

Game creators with 500+ YouTube subscribers



🎥 What You'll Do

Play and create content for Supercent mobile games



🎁 What You Get

Official Channel Exposure — Be featured on Supercent's official YouTube and social media channels, reaching +2.7 million subscribers
Rewards — Earn a monthly Activity Fee, Viral Bonus, Creator Code Fee, Mission Complete Fee, etc.
Additional Benefits — In-game rewards (e.g. No Ads), Partnership Ads opportunities


📋 How to Apply

Apply here: {{apply_link}}

*A YouTube channel is required to participate.

For full details, visit: https://creator.supercent.io/?locale=en&view=guide&track=fixed-cpm



Any questions? Feel free to reply to this email 😊



Best regards,

Supercent`;

const MARKDOWN_LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

export function extractMarkdownLinks(text: string): MarkdownSegment[] {
  const out: MarkdownSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) out.push({ kind: "text", text: text.slice(lastIndex, index) });
    out.push({ kind: "link", label: match[1], url: match[2] });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) out.push({ kind: "text", text: text.slice(lastIndex) });
  return out;
}

export function templateLinkCount(...texts: string[]): number {
  return texts.reduce((count, text) => count + extractMarkdownLinks(text).filter((part) => part.kind === "link").length, 0);
}
