import { adminDb } from "./firebaseAdmin";
import type { FirestoreDb } from "./feedWorkerTypes";
import { runGooglePlaySimilarGamesScraper, type GooglePlaySimilarGamesRunnerOptions } from "./similarGamesGooglePlayRunner";

export const DEFAULT_SIMILAR_GAME_PROPOSAL_LIMIT = 25;

export type SimilarGamesSeed = {
  readonly ownedAppIds: readonly string[];
  readonly ownedGameTags: readonly string[];
  readonly similarGameTags?: readonly string[];
};

export type StoreGameScraperResult = {
  readonly appId?: unknown;
  readonly title?: unknown;
  readonly genre?: unknown;
  readonly developer?: unknown;
  readonly sourceAppId?: unknown;
};

export type SimilarGamesRunnerGroups = {
  readonly similarApps?: readonly StoreGameScraperResult[];
  readonly moreByDeveloper?: readonly StoreGameScraperResult[];
};

export type SimilarGamesRunnerOutput = readonly StoreGameScraperResult[] | SimilarGamesRunnerGroups;

export type SimilarGamesRunner = (seed: SimilarGamesSeed) => Promise<SimilarGamesRunnerOutput>;

export type SimilarGameProposal = {
  readonly appId: string;
  readonly title: string;
  readonly tag: string;
  readonly genre: string;
  readonly developer: string;
  readonly sourceAppId: string;
  readonly source: "similar_app" | "more_by_developer";
  readonly reason: string;
  readonly status: "pending_review";
};

export type SimilarGamesDiscoveryCounters = {
  readonly rawReceived: number;
  readonly droppedByGenre: number;
  readonly droppedByDedupe: number;
  readonly droppedByCap: number;
  readonly proposalsWritten: number;
};

export type SimilarGamesDiscoveryResult = {
  readonly runId: string;
  readonly status: "pending_review" | "skipped";
  readonly proposals: readonly SimilarGameProposal[];
  readonly counters: SimilarGamesDiscoveryCounters;
  readonly skipReason?: string;
  readonly scraperError?: string;
};

export type SimilarGamesDiscoveryOptions = {
  readonly db?: FirestoreDb;
  readonly runId?: string;
  readonly nowIso?: string;
  readonly runner?: SimilarGamesRunner;
  readonly allowInjectedRunner?: boolean;
  readonly maxProposals?: number;
  readonly similarGamesAutoDiscover?: boolean;
  readonly googlePlay?: GooglePlaySimilarGamesRunnerOptions;
};

type CandidateSource = SimilarGameProposal["source"];

type Candidate = {
  readonly source: CandidateSource;
  readonly appId: string;
  readonly title: string;
  readonly genre: string;
  readonly developer: string;
  readonly sourceAppId: string;
};

type MutableCounters = {
  rawReceived: number;
  droppedByGenre: number;
  droppedByDedupe: number;
  droppedByCap: number;
  proposalsWritten: number;
};

const RELEVANT_GENRE_PATTERN = /\b(idle|casual|hyper\s*casual|role\s*playing|rpg|arcade|puzzle|simulation|simulator|strategy|games?)\b/i;

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalizeTag(title: string): string {
  return title
    .replace(/[™®]/g, "")
    .replace(/\s*[-–—|:]\s*(mobile\s+)?(idle|rpg|casual|simulation|simulator|games?)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").replace(/\s+/g, " ").trim();
}

function maxProposalCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : DEFAULT_SIMILAR_GAME_PROPOSAL_LIMIT;
}

function candidatesFromGroup(items: readonly StoreGameScraperResult[] | undefined, source: CandidateSource): Candidate[] {
  return (items ?? []).map((item) => ({
    source,
    appId: text(item.appId),
    title: text(item.title),
    genre: text(item.genre),
    developer: text(item.developer),
    sourceAppId: text(item.sourceAppId),
  })).filter((item) => item.appId && item.title);
}

function isRunnerGroups(output: SimilarGamesRunnerOutput): output is SimilarGamesRunnerGroups {
  return !Array.isArray(output);
}

function flattenRunnerOutput(output: SimilarGamesRunnerOutput): Candidate[] {
  if (!isRunnerGroups(output)) return candidatesFromGroup(output, "similar_app");
  return [
    ...candidatesFromGroup(output.similarApps, "similar_app"),
    ...candidatesFromGroup(output.moreByDeveloper, "more_by_developer"),
  ];
}

function initialDedupeKeys(seed: SimilarGamesSeed): Set<string> {
  return new Set([
    ...seed.ownedGameTags,
    ...(seed.similarGameTags ?? []),
  ].map(dedupeKey).filter(Boolean));
}

function proposalFromCandidate(candidate: Candidate, tag: string): SimilarGameProposal {
  return {
    appId: candidate.appId,
    title: candidate.title,
    tag,
    genre: candidate.genre,
    developer: candidate.developer,
    sourceAppId: candidate.sourceAppId,
    source: candidate.source,
    reason: `matched relevant game genre: ${candidate.genre}`,
    status: "pending_review",
  };
}

function buildProposals(seed: SimilarGamesSeed, output: SimilarGamesRunnerOutput, maxProposals: number): {
  readonly proposals: readonly SimilarGameProposal[];
  readonly counters: SimilarGamesDiscoveryCounters;
} {
  const candidates = flattenRunnerOutput(output);
  const seenTags = initialDedupeKeys(seed);
  const seenAppIds = new Set(seed.ownedAppIds.map(dedupeKey).filter(Boolean));
  const proposals: SimilarGameProposal[] = [];
  const counters: MutableCounters = {
    rawReceived: candidates.length,
    droppedByGenre: 0,
    droppedByDedupe: 0,
    droppedByCap: 0,
    proposalsWritten: 0,
  };

  for (const candidate of candidates) {
    const tag = normalizeTag(candidate.title);
    const tagKey = dedupeKey(tag);
    const appKey = dedupeKey(candidate.appId);
    if (!RELEVANT_GENRE_PATTERN.test(candidate.genre)) {
      counters.droppedByGenre += 1;
      continue;
    }
    if (!tagKey || seenTags.has(tagKey) || seenAppIds.has(appKey)) {
      counters.droppedByDedupe += 1;
      continue;
    }
    seenTags.add(tagKey);
    seenAppIds.add(appKey);
    if (proposals.length >= maxProposals) {
      counters.droppedByCap += 1;
      continue;
    }
    proposals.push(proposalFromCandidate(candidate, tag));
  }

  counters.proposalsWritten = proposals.length;
  return { proposals, counters };
}

function emptyCounters(): SimilarGamesDiscoveryCounters {
  return {
    rawReceived: 0,
    droppedByGenre: 0,
    droppedByDedupe: 0,
    droppedByCap: 0,
    proposalsWritten: 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runSimilarGamesScraper(
  seed: SimilarGamesSeed,
  options: SimilarGamesDiscoveryOptions = {},
): Promise<SimilarGamesRunnerOutput> {
  if (options.runner) {
    if (options.allowInjectedRunner !== true) {
      throw new Error("Injected similar-games runner requires allowInjectedRunner=true");
    }
    return options.runner(seed);
  }
  return runGooglePlaySimilarGamesScraper(seed, options.googlePlay);
}

export async function discoverSimilarGames(
  seed: SimilarGamesSeed,
  options: SimilarGamesDiscoveryOptions = {},
): Promise<SimilarGamesDiscoveryResult> {
  const runId = options.runId ?? `similar-games-${Date.now()}`;
  const nowIso = options.nowIso ?? new Date().toISOString();
  if (options.similarGamesAutoDiscover !== true) {
    return {
      runId,
      status: "skipped",
      proposals: [],
      counters: emptyCounters(),
      skipReason: "similar_games_auto_discover_disabled",
    };
  }
  let scraperError: string | undefined;
  let output: SimilarGamesRunnerOutput = [];
  try {
    output = await runSimilarGamesScraper(seed, options);
  } catch (error) {
    scraperError = errorMessage(error);
    console.warn(JSON.stringify({
      event: "similar_games_scraper_failed",
      runId,
      reason: scraperError,
    }));
  }
  const { proposals, counters } = buildProposals(seed, output, maxProposalCount(options.maxProposals));
  const db = options.db ?? adminDb;

  await db.collection("similar_games_proposals").doc(runId).set({
    id: runId,
    runId,
    status: "pending_review",
    approvalRequired: true,
    seed: {
      ownedAppIds: [...seed.ownedAppIds],
      ownedGameTags: [...seed.ownedGameTags],
      similarGameTags: [...(seed.similarGameTags ?? [])],
    },
    proposals,
    counters,
    scraperError: scraperError ?? null,
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
  }, { merge: true });

  return { runId, status: "pending_review", proposals, counters, scraperError };
}
