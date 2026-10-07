// ── 커뮤니티 반응 (Revi 연동, Reddit 기준) ──────────────────
export type Sentiment = "positive" | "neutral" | "negative";
export const SENTIMENT: Record<Sentiment, { label: string; tone: "ok" | "info" | "danger" }> = {
  positive: { label: "긍정", tone: "ok" },
  neutral: { label: "중립", tone: "info" },
  negative: { label: "부정", tone: "danger" },
};
export interface CommunityPost {
  id: string;
  source: "Reddit" | "Discord" | "X" | "Web" | "Steam";
  subreddit: string;
  title: string;
  sentiment: Sentiment;
  score: number;
  comments: number;
  time: string;
  createdAtIso?: string;
  sourceUrl?: string;
  game: string;
  matchedGame?: string;
  ugcMatched?: boolean;
  archivedAt?: string;
  deletedAt?: string;
  humanGate?: "needs_review" | "resolved";
  manualIntervention?: {
    requestedAt?: string;
    requestedBy?: string;
    reason?: string;
    status?: "open" | "resolved";
  };
}
export const COMMUNITY_POSTS: CommunityPost[] = [
  { id: "p-xphero-reddit", source: "Reddit", subreddit: "r/XPHero", title: "XPHERO creator clips and gameplay feedback thread", sentiment: "positive", score: 184, comments: 37, time: "오늘", createdAtIso: "2026-06-27T18:42:50.118Z", game: "XPHERO", matchedGame: "XPHERO", sourceUrl: "https://www.reddit.com/r/XPHero/search/?q=XPHERO%20creator%20clips%20gameplay&restrict_sr=1&sort=new" },
  { id: "p1", source: "Reddit", subreddit: "r/AndroidGaming", title: "Pizza Ready gameplay loop is surprisingly polished", sentiment: "positive", score: 312, comments: 48, time: "2시간 전", createdAtIso: "2026-06-27T07:00:00.000Z", game: "Pizza Ready", sourceUrl: "https://www.reddit.com/r/AndroidGaming/search/?q=Pizza%20Ready%20Supercent" },
  { id: "p2", source: "Reddit", subreddit: "r/iosgaming", title: "Burger Please has too many ads after level 10", sentiment: "negative", score: 87, comments: 63, time: "5시간 전", createdAtIso: "2026-06-27T04:00:00.000Z", game: "Burger Please", sourceUrl: "https://www.reddit.com/r/iosgaming/search/?q=Burger%20Please%20Supercent" },
  { id: "p3", source: "Reddit", subreddit: "r/puzzlegames", title: "Anyone else hooked on Snake Clash puzzle runs?", sentiment: "positive", score: 201, comments: 29, time: "어제", createdAtIso: "2026-06-26T10:00:00.000Z", game: "Snake Clash", sourceUrl: "https://www.reddit.com/r/puzzlegames/search/?q=Snake%20Clash%20Supercent" },
  { id: "p4", source: "Discord", subreddit: "discord.gg/supercent-creators", title: "Creator asking for XPHERO sponsorship slots this week", sentiment: "positive", score: 42, comments: 11, time: "오늘", createdAtIso: "2026-06-27T08:40:00.000Z", game: "XPHERO", sourceUrl: "https://discord.gg/supercent-creators" },
  { id: "p5", source: "X", subreddit: "@SupercentCreators", title: "Shorts creators comparing XPHERO with new casual boss fight clips", sentiment: "neutral", score: 96, comments: 21, time: "오늘", createdAtIso: "2026-06-27T06:50:00.000Z", game: "XPHERO", sourceUrl: "https://x.com/search?q=XPHERO%20Supercent%20creator%20clips&f=live" },
  { id: "p6", source: "Web", subreddit: "creator-news", title: "Mobile game reviewers are rotating into Dinosaur Universe clips", sentiment: "neutral", score: 18, comments: 4, time: "2일 전", createdAtIso: "2026-06-25T12:30:00.000Z", game: "Dinosaur Universe", sourceUrl: "https://www.supercent.io/" },
];
