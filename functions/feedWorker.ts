import { buildCreatorPaidStatusIndex, enrichCommunityArtifactsWithPaidStatus } from "./communityPaidStatus";
import { isOwnedOfficialIdentity } from "./creatorIdentity";
import {
  aggregateCountryDistribution,
  countryDistributionItemFromYtDlpRecord,
  type CountryDistribution,
} from "./countryDistribution";
import { adminDb } from "./firebaseAdmin";
import {
  createFingerprint,
  increment,
  initialCounters,
  writeCreatorComment,
} from "./feedWorkerPersistence";
import type {
  FirestoreDb,
  FirestoreWriteFence,
  ParsedYtDlpVideo,
  YtDlpIngestCounters,
  YtDlpIngestOptions,
  YtDlpIngestResult,
  YtDlpIngestStatus,
  YtDlpWorkerOptions,
} from "./feedWorkerTypes";
import { normalizeYoutubeCreatorCountryAllowlist } from "./youtubeCreatorCountries";
import { asRecord, parseYtDlpVideo, stringField } from "./ytdlpRecordParser";
import { detectVideoSponsorship, estimateVideoAdSpendUsd, normalizeAdSpendRates } from "./videoSponsorship";
import { enqueueTranscriptRetry, TRANSCRIPT_RETRY_QUEUE_COLLECTION } from "./videoTranscript";

const DISCOVERY_SCOPE_FIELDS = [
  "campaignId",
  "campaignRef",
  "canonicalProgramId",
  "programId",
  "programRef",
] as const;

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function assertAuthoritativeYtDlpScope(db: FirestoreDb, runId: string): Promise<void> {
  const [runSnapshot, jobSnapshot] = await Promise.all([
    db.collection("discovery_runs").doc(runId).get(),
    db.collection("workflow_jobs").doc(runId).get(),
  ]);
  const run = runSnapshot.data() ?? {};
  const job = jobSnapshot.data() ?? {};
  const declaresScope = [run, job].some((record) =>
    DISCOVERY_SCOPE_FIELDS.some((field) => optionalString(record[field])),
  );
  if (!declaresScope) return;
  if (!runSnapshot.exists || !jobSnapshot.exists) {
    throw new Error("failed-precondition: authoritative yt-dlp run/job scope is missing");
  }
  if (optionalString(job.runRef) !== `discovery_runs/${runId}`) {
    throw new Error("failed-precondition: authoritative yt-dlp runRef scope mismatch");
  }
  if (optionalString(run.runRef) && optionalString(run.runRef) !== `discovery_runs/${runId}`) {
    throw new Error("failed-precondition: authoritative yt-dlp discovery runRef scope mismatch");
  }
  if ([run, job].some((record) =>
    DISCOVERY_SCOPE_FIELDS.some((field) => !optionalString(record[field])),
  )) {
    throw new Error("failed-precondition: authoritative yt-dlp run/job scope is incomplete");
  }

  const campaignId = optionalString(run.campaignId);
  const campaignSnapshot = await db.collection("campaigns").doc(campaignId).get();
  if (!campaignSnapshot.exists) {
    throw new Error("failed-precondition: authoritative yt-dlp campaign is missing");
  }
  const campaign = campaignSnapshot.data() ?? {};
  if (optionalString(campaign.id) && optionalString(campaign.id) !== campaignId) {
    throw new Error("failed-precondition: authoritative yt-dlp campaign id scope mismatch");
  }
  const canonicalProgramId = optionalString(campaign.canonicalProgramId);
  if (
    !canonicalProgramId
    || optionalString(campaign.programId) !== canonicalProgramId
    || optionalString(campaign.programRef) !== `programs/${canonicalProgramId}`
  ) {
    throw new Error("failed-precondition: authoritative yt-dlp campaign ownership is ambiguous");
  }
  const expected = {
    campaignId,
    campaignRef: `campaigns/${campaignId}`,
    canonicalProgramId,
    programId: canonicalProgramId,
    programRef: `programs/${canonicalProgramId}`,
  };
  for (const field of DISCOVERY_SCOPE_FIELDS) {
    if (
      optionalString(run[field]) !== expected[field]
      || optionalString(job[field]) !== expected[field]
    ) {
      throw new Error(`failed-precondition: authoritative yt-dlp ${field} scope mismatch`);
    }
  }
}

function officialCreator(video: ParsedYtDlpVideo, officialChannels: readonly string[]): boolean {
  return isOwnedOfficialIdentity({
    channelId: video.channelId,
    handle: video.handle,
    creatorHandle: video.handle,
    name: video.channelTitle,
    creatorName: video.channelTitle,
    youtubeUrl: video.channelUrl || video.sourceUrl,
  }, officialChannels);
}

async function writeCountryDistribution(
  db: FirestoreDb,
  runId: string,
  nowIso: string,
  countryDistribution: CountryDistribution,
  assertWriteAllowed: FirestoreWriteFence,
): Promise<void> {
  await assertWriteAllowed();
  await db.collection("feed_country_distribution").doc(runId).set({
    id: runId,
    runId,
    scope: "run",
    source: "yt-dlp",
    byViews: countryDistribution.byViews,
    byVideoCount: countryDistribution.byVideoCount,
    totals: countryDistribution.totals,
    unknown: countryDistribution.unknown,
    updatedAtIso: nowIso,
  }, { merge: true });
}

async function writeVideo(
  db: FirestoreDb,
  video: ParsedYtDlpVideo,
  runId: string,
  nowIso: string,
  paidStatusIndex: Awaited<ReturnType<typeof buildCreatorPaidStatusIndex>>,
  adSpendRates: ReturnType<typeof normalizeAdSpendRates>,
  assertWriteAllowed: FirestoreWriteFence,
): Promise<void> {
  const sponsorship = detectVideoSponsorship({
    title: video.title,
    description: video.description,
    hashtags: video.hashtags,
    sourceUrl: video.sourceUrl,
  });
  const adSpend = estimateVideoAdSpendUsd({
    sourceUrl: video.sourceUrl,
    durationSeconds: video.durationSeconds,
    viewCount: video.viewCount,
    sponsorship,
  }, adSpendRates);
  const [enriched] = await enrichCommunityArtifactsWithPaidStatus([{
    id: video.videoId,
    videoId: video.videoId,
    channelId: video.channelId,
    channelRef: `yt_channel_${video.channelId}`,
    title: video.title,
    description: video.description,
    creatorName: video.channelTitle,
    author: video.handle || video.channelTitle,
    handle: video.handle,
    sourceUrl: video.sourceUrl,
    youtubeUrl: video.channelUrl,
    url: video.sourceUrl,
    platform: "YouTube",
    source: "yt-dlp",
    creatorCountry: video.creatorCountry,
    countryFilterReason: "country_allowed",
    viewCount: video.viewCount,
    likeCount: video.likeCount,
    commentCount: video.commentCount,
    durationSeconds: video.durationSeconds,
    isSponsored: sponsorship.isSponsored,
    sponsorSignals: sponsorship.sponsorSignals,
    sponsorConfidence: sponsorship.sponsorConfidence,
    estimatedAdSpendUsd: adSpend.estimatedSpendUsd,
    estimatedAdSpendModel: adSpend.model,
    estimatedAdSpendBasis: adSpend.basis,
    publishedAt: video.publishedAt,
    fetchedAt: nowIso,
    discoveryRunId: runId,
    transcript: video.transcript,
    classificationPending: true,
  }], paidStatusIndex);
  await assertWriteAllowed();
  await db.collection("youtube_videos").doc(video.videoId).set(enriched, { merge: true });

  if (video.transcript.status === "fetch_failed") {
    const retry = enqueueTranscriptRetry(video.videoId, video.transcript.attempts || 1, nowIso);
    await assertWriteAllowed();
    await db.collection(TRANSCRIPT_RETRY_QUEUE_COLLECTION).doc(video.videoId).set({
      videoId: retry.videoId,
      attempts: retry.attempts,
      nextAttemptAtIso: retry.nextAttemptAtIso,
      status: retry.status,
      updatedAtIso: nowIso,
    }, { merge: true });
  }
}

async function writeComments(
  db: FirestoreDb,
  video: ParsedYtDlpVideo,
  runId: string,
  nowIso: string,
  counters: YtDlpIngestCounters,
  assertWriteAllowed: FirestoreWriteFence,
): Promise<YtDlpIngestCounters> {
  let nextCounters = counters;
  for (const comment of video.comments) {
    const commentId = stringField(comment, ["id", "comment_id", "commentId"]);
    const text = stringField(comment, ["text", "comment", "content"]);
    if (!commentId || !text) {
      nextCounters = increment(nextCounters, "malformedComments");
      continue;
    }
    const commentKey = `${video.videoId}:${commentId}`;
    if (!await createFingerprint(db, "comment", commentKey, runId, nowIso, assertWriteAllowed)) {
      nextCounters = increment(nextCounters, "skippedByDedupe");
      continue;
    }
    nextCounters = increment(nextCounters, "fingerprintsCreated");
    await writeCreatorComment(db, video, comment, commentId, text, runId, nowIso, assertWriteAllowed);
    nextCounters = increment(nextCounters, "commentsWritten");
  }
  return nextCounters;
}

export async function ingestYtDlpRecords(
  records: readonly unknown[],
  runId: string,
  options: YtDlpIngestOptions = {},
): Promise<YtDlpIngestResult> {
  const db = options.db ?? adminDb;
  const nowIso = options.nowIso ?? new Date().toISOString();
  await assertAuthoritativeYtDlpScope(db, runId);
  const assertWriteAllowed = () => assertAuthoritativeYtDlpScope(db, runId);
  const allowlist = normalizeYoutubeCreatorCountryAllowlist(options.youtubeCreatorCountries);
  const adSpendRates = normalizeAdSpendRates(options.adSpendRates);
  const paidStatusIndex = options.paidStatusIndex ?? await buildCreatorPaidStatusIndex();
  const countryDistributionItems = records
    .map(countryDistributionItemFromYtDlpRecord)
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const countryDistribution = aggregateCountryDistribution(countryDistributionItems);
  const errors: Array<{ index: number; reason: string }> = [];
  let counters = initialCounters(records.length);

  for (const [index, raw] of records.entries()) {
    const record = asRecord(raw);
    const video = record ? parseYtDlpVideo(record, allowlist) : null;
    if (!video) {
      counters = increment(counters, "malformedRecords");
      errors.push({ index, reason: "missing_video_or_channel_id" });
      continue;
    }
    if ("excluded" in video) {
      counters = increment(counters, "excludedByCountry");
      continue;
    }
    if (officialCreator(video, options.officialChannels ?? [])) {
      counters = increment(counters, "excludedOfficial");
      continue;
    }

    if (await createFingerprint(db, "channel", video.channelId, runId, nowIso, assertWriteAllowed)) counters = increment(counters, "fingerprintsCreated");
    else counters = increment(counters, "knownChannels");

    if (await createFingerprint(db, "video", video.videoId, runId, nowIso, assertWriteAllowed)) {
      counters = increment(counters, "fingerprintsCreated");
      await writeVideo(db, video, runId, nowIso, paidStatusIndex, adSpendRates, assertWriteAllowed);
      counters = increment(counters, "videosWritten");
    } else {
      // W-G006-1 자가치유: 청크 커밋 경계에서 크래시하면 fingerprint만 남고
      // youtube_videos 문서가 좌초될 수 있다. dedupe는 fingerprint가 아니라
      // 실제 문서 존재로 최종 판정해 좌초분을 재기록한다(멱등 set).
      const existingVideo = await db.collection("youtube_videos").doc(video.videoId).get();
      if (!existingVideo.exists) {
        await writeVideo(db, video, runId, nowIso, paidStatusIndex, adSpendRates, assertWriteAllowed);
        counters = increment(counters, "videosWritten");
      } else {
        counters = increment(counters, "skippedByDedupe");
      }
    }
    counters = await writeComments(db, video, runId, nowIso, counters, assertWriteAllowed);
  }

  const status: YtDlpIngestStatus = errors.length > 0 ? "partial_failure" : "complete";
  await writeCountryDistribution(db, runId, nowIso, countryDistribution, assertWriteAllowed);
  await assertWriteAllowed();
  await db.collection("discovery_runs").doc(runId).set({
    id: runId,
    engine: "yt-dlp",
    status,
    counters,
    errors,
    countryDistribution,
    completedAtIso: nowIso,
    updatedAtIso: nowIso,
  }, { merge: true });

  return { ok: true, runId, status, counters, errors };
}

export async function runYtDlp(): Promise<never> {
  throw new Error("INFRA GATE: enable in Cloud Run worker with an injected yt-dlp runner");
}

export async function runYtDlpWorker(options: YtDlpWorkerOptions): Promise<YtDlpIngestResult> {
  if (!options.runner || options.allowInjectedRunner !== true) {
    return runYtDlp();
  }
  await assertAuthoritativeYtDlpScope(options.db ?? adminDb, options.runId);
  const records = await options.runner(options.query);
  return ingestYtDlpRecords(records, options.runId, options);
}
