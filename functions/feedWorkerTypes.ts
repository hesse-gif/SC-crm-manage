import type { CreatorPaidStatusIndex } from "./communityPaidStatus";
import type { AdSpendRatesInput } from "./videoSponsorship";
import type { TranscriptState } from "./videoTranscript";

export type FirestoreSetOptions = { readonly merge?: boolean };
export type FirestoreDocSnapshot = {
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
};
export type FirestoreDocRef = {
  readonly path?: string;
  create(data: Record<string, unknown>): Promise<unknown>;
  set(data: Record<string, unknown>, options?: FirestoreSetOptions): Promise<unknown>;
  get(): Promise<FirestoreDocSnapshot>;
};
export type FirestoreDb = {
  collection(name: string): {
    doc(id?: string): FirestoreDocRef;
  };
};
export type FirestoreWriteFence = () => Promise<void>;

export type YtDlpIngestCounters = {
  readonly recordsReceived: number;
  readonly videosWritten: number;
  readonly commentsWritten: number;
  readonly fingerprintsCreated: number;
  readonly skippedByDedupe: number;
  readonly knownChannels: number;
  readonly excludedByCountry: number;
  readonly excludedOfficial: number;
  readonly malformedRecords: number;
  readonly malformedComments: number;
};

export type YtDlpIngestStatus = "complete" | "partial_failure";
export type YtDlpIngestResult = {
  readonly ok: true;
  readonly runId: string;
  readonly status: YtDlpIngestStatus;
  readonly counters: YtDlpIngestCounters;
  readonly errors: Array<{ readonly index: number; readonly reason: string }>;
};

export type YtDlpIngestOptions = {
  readonly db?: FirestoreDb;
  readonly nowIso?: string;
  readonly youtubeCreatorCountries?: readonly string[];
  readonly officialChannels?: readonly string[];
  readonly paidStatusIndex?: CreatorPaidStatusIndex;
  readonly adSpendRates?: AdSpendRatesInput;
};
export type YtDlpRunner = (query: string) => Promise<readonly unknown[]>;
export type YtDlpWorkerOptions = YtDlpIngestOptions & {
  readonly runId: string;
  readonly query: string;
  readonly runner?: YtDlpRunner;
  readonly allowInjectedRunner?: boolean;
};

export type ParsedYtDlpVideo = {
  readonly videoId: string;
  readonly channelId: string;
  readonly channelTitle: string;
  readonly handle: string;
  readonly channelUrl: string;
  readonly sourceUrl: string;
  readonly title: string;
  readonly description: string;
  readonly hashtags: readonly string[];
  readonly creatorCountry: string;
  readonly viewCount: number;
  readonly likeCount: number;
  readonly commentCount: number;
  readonly durationSeconds: number | null;
  readonly publishedAt: string | null;
  readonly comments: readonly Record<string, unknown>[];
  readonly transcript: TranscriptState;
};
