import { createHash } from "node:crypto";
import { SCP_REWARD_GUIDELINE_STATEMENT } from "./chatCasebook";
import { REPLY_LINK_APPLY, REPLY_LINK_GUIDE, REPLY_LINK_SAMPLE, REPLY_LINK_SUBMIT } from "./mailReplyLinks";

// Single source of truth for casebook {{TOKEN}} → canonical link resolution. It lives in its own
// light module (moved verbatim out of chat-ai.ts, which re-exports substituteCasebookLinks) so the
// reply callables (chatAutoCaseReplies.ts — imported BY chat-ai.ts, so it cannot import chat-ai back)
// and the dispatch path resolve tokens through the very same anchors: no duplicated URLs/labels.
//
// W96(링크 치환): 모델은 URL 을 직접 쓰지 않고 {{TOKEN}} 만 쓴다 — 서버가 정본 마크다운
//   앵커 [라벨](정본URL) 로 치환한다 (mailCompiler 가 HTML 앵커로 렌더 → raw URL 비노출).
//   모델이 그래도 URL 을 직접 쳤으면: 정본 4개는 앵커로 정규화, 그 외 URL·잔여 토큰은
//   "발명"으로 간주해 fail-closed(사람 검토 강등) 신호를 돌려준다 (closed-world 의 URL 판).
export const CASEBOOK_LINK_DEFINITIONS = {
  APPLY_LINK: { label: "Apply to Super Creator Partners", url: REPLY_LINK_APPLY },
  GUIDE_LINK: { label: "Super Creator Partners Guide", url: REPLY_LINK_GUIDE },
  SUBMIT_LINK: { label: "Submit your video", url: REPLY_LINK_SUBMIT },
  SAMPLE_LINK: { label: "Sample videos (Google Drive)", url: REPLY_LINK_SAMPLE },
} as const;

export type CasebookCatalogLinkToken = keyof typeof CASEBOOK_LINK_DEFINITIONS;
export type CasebookLinkCatalogEntry = { token: CasebookCatalogLinkToken; label: string; url: string };

const CASEBOOK_LINK_ANCHORS: Record<string, string> = Object.fromEntries(
  Object.entries(CASEBOOK_LINK_DEFINITIONS).map(([token, { label, url }]) => [token, `[${label}](${url})`]),
);

// v7 (2026-09-24, counter_offer_guideline_reply): 링크가 아닌 "사실(factual) 텍스트" 토큰 —
//   {{GUIDELINE_AMOUNT}} 는 URL 앵커가 아니라 chatCasebook.SCP_REWARD_GUIDELINE_STATEMENT(정본
//   공개 요율표 문장)로 치환된다. CASEBOOK_LINK_ANCHORS 와 별도 맵으로 둔다 — 아래 "모델이 직접
//   친 URL → 앵커 정규화" 루프는 각 값을 `[라벨](URL)` 형태로 가정하고 URL 부분을 파싱하므로,
//   URL이 아닌 값을 그 맵에 섞으면 그 루프가 깨진 정규식으로 임의 부분문자열을 치환할 위험이 있다.
const CASEBOOK_FACT_TOKEN_VALUES: Record<string, string> = {
  GUIDELINE_AMOUNT: SCP_REWARD_GUIDELINE_STATEMENT,
};

/** The reviewed link tokens with their canonical label + URL (fact tokens such as GUIDELINE_AMOUNT excluded). */
export function casebookLinkCatalog(): CasebookLinkCatalogEntry[] {
  return (Object.keys(CASEBOOK_LINK_DEFINITIONS) as CasebookCatalogLinkToken[]).map((token) => ({
    token,
    label: CASEBOOK_LINK_DEFINITIONS[token].label,
    url: CASEBOOK_LINK_DEFINITIONS[token].url,
  }));
}

/** Stable fingerprint of the catalog; changes whenever a token, label, or URL changes. */
export function casebookLinkCatalogHash(): string {
  return createHash("sha256")
    .update(JSON.stringify(casebookLinkCatalog().map(({ token, label, url }) => [token, label, url])))
    .digest("hex");
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function substituteCasebookLinks(draft: string): {
  text: string;
  leftoverToken: boolean;
  inventedUrl: boolean;
} {
  let text = String(draft ?? "");
  for (const [token, anchor] of Object.entries(CASEBOOK_LINK_ANCHORS)) {
    text = text.split(`{{${token}}}`).join(anchor);
  }
  for (const [token, value] of Object.entries(CASEBOOK_FACT_TOKEN_VALUES)) {
    text = text.split(`{{${token}}}`).join(value);
  }
  // 모델이 직접 친 정본 URL(앵커 밖) → 앵커로 정규화
  for (const anchor of Object.values(CASEBOOK_LINK_ANCHORS)) {
    const url = anchor.slice(anchor.indexOf("](") + 2, -1);
    text = text.replace(new RegExp(`(?<!\\]\\()<?${escapeRegExpLiteral(url)}>?`, "g"), anchor);
  }
  const leftoverToken = /\{\{[A-Z0-9_]+\}\}/.test(text);
  // 앵커 "](" 뒤가 아닌 위치의 잔여 URL = 모델이 발명한 링크
  const inventedUrl = /(?<!\]\()https?:\/\//.test(text);
  return { text, leftoverToken, inventedUrl };
}
