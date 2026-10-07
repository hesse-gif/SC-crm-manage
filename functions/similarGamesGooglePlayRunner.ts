import type { SimilarGamesRunnerOutput, SimilarGamesSeed, StoreGameScraperResult } from "./similarGamesDiscovery";

export const GOOGLE_PLAY_SEED_LIMIT = 5;
export const GOOGLE_PLAY_SIMILAR_RESULT_LIMIT = 25;
export const GOOGLE_PLAY_REQUEST_TIMEOUT_MS = 10_000;
export const GOOGLE_PLAY_THROTTLE_MS = 300;

export type GooglePlaySimilarGamesRunnerOptions = {
  readonly seedLimit?: number;
  readonly similarLimit?: number;
  readonly requestTimeoutMs?: number;
  readonly throttleMs?: number;
  readonly country?: string;
  readonly lang?: string;
};

type GooglePlayGame = {
  readonly appId?: string;
  readonly title?: string;
  readonly genre?: string;
  readonly developer?: string;
};

type GooglePlaySearchOptions = {
  readonly term: string;
  readonly num: number;
  readonly country: string;
  readonly lang: string;
};

type GooglePlaySimilarOptions = {
  readonly appId: string;
  readonly num: number;
  readonly fullDetail: boolean;
  readonly country: string;
  readonly lang: string;
};

type GooglePlaySearch = (options: GooglePlaySearchOptions) => Promise<readonly GooglePlayGame[]>;
type GooglePlaySimilar = (options: GooglePlaySimilarOptions) => Promise<readonly GooglePlayGame[]>;

type GooglePlayScraperModule = {
  readonly search: GooglePlaySearch;
  readonly similar: GooglePlaySimilar;
};

const dynamicImporter = Function("specifier", "return import(specifier)");

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function text(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function logScraperWarning(event: string, fields: Record<string, string | number>): void {
  console.warn(JSON.stringify({
    event,
    source: "google-play-scraper",
    ...fields,
  }));
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function toStoreResult(item: GooglePlayGame, sourceAppId: string): StoreGameScraperResult {
  return {
    appId: text(item.appId),
    title: text(item.title),
    genre: text(item.genre),
    developer: text(item.developer),
    sourceAppId,
  };
}

function runnerCountry(options: GooglePlaySimilarGamesRunnerOptions): string {
  return text(options.country) || "us";
}

function runnerLang(options: GooglePlaySimilarGamesRunnerOptions): string {
  return text(options.lang) || "en";
}

function isGooglePlayScraperModule(value: unknown): value is GooglePlayScraperModule {
  return typeof value === "object"
    && value !== null
    && "search" in value
    && typeof value.search === "function"
    && "similar" in value
    && typeof value.similar === "function";
}

async function loadGooglePlayScraper(): Promise<GooglePlayScraperModule> {
  const imported: unknown = await dynamicImporter("google-play-scraper");
  if (isGooglePlayScraperModule(imported)) return imported;
  throw new Error("google-play-scraper module shape is invalid");
}

async function resolveSeedAppId(seedName: string, options: GooglePlaySimilarGamesRunnerOptions): Promise<string> {
  const timeoutMs = positiveInt(options.requestTimeoutMs, GOOGLE_PLAY_REQUEST_TIMEOUT_MS);
  const googlePlay = await loadGooglePlayScraper();
  const results = await withTimeout(googlePlay.search({
    term: seedName,
    num: 1,
    country: runnerCountry(options),
    lang: runnerLang(options),
  }), timeoutMs, `google-play search ${seedName}`);
  return text(results[0]?.appId);
}

async function similarAppsForSeed(appId: string, options: GooglePlaySimilarGamesRunnerOptions): Promise<readonly StoreGameScraperResult[]> {
  const timeoutMs = positiveInt(options.requestTimeoutMs, GOOGLE_PLAY_REQUEST_TIMEOUT_MS);
  const similarLimit = positiveInt(options.similarLimit, GOOGLE_PLAY_SIMILAR_RESULT_LIMIT);
  const googlePlay = await loadGooglePlayScraper();
  const results = await withTimeout(googlePlay.similar({
    appId,
    num: similarLimit,
    fullDetail: true,
    country: runnerCountry(options),
    lang: runnerLang(options),
  }), timeoutMs, `google-play similar ${appId}`);
  return results.map((item) => toStoreResult(item, appId));
}

// Tier C server-side Google Play scraping: proposal-only, pending human review, never auto-applies similarGameTags.
export async function runGooglePlaySimilarGamesScraper(
  seed: SimilarGamesSeed,
  options: GooglePlaySimilarGamesRunnerOptions = {},
): Promise<SimilarGamesRunnerOutput> {
  const seedLimit = positiveInt(options.seedLimit, GOOGLE_PLAY_SEED_LIMIT);
  const throttleMs = positiveInt(options.throttleMs, GOOGLE_PLAY_THROTTLE_MS);
  const seedNames = seed.ownedGameTags.map((item) => item.trim()).filter(Boolean).slice(0, seedLimit);
  const similarApps: StoreGameScraperResult[] = [];

  for (const seedName of seedNames) {
    try {
      const appId = await resolveSeedAppId(seedName, options);
      await sleep(throttleMs);
      if (!appId) {
        logScraperWarning("similar_games_seed_not_found", { seedName });
        continue;
      }
      similarApps.push(...await similarAppsForSeed(appId, options));
      await sleep(throttleMs);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logScraperWarning("similar_games_seed_failed", { seedName, reason });
    }
  }

  return { similarApps };
}
