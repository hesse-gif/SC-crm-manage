import { adminDb } from "./firebaseAdmin";
import { leadPath } from "./sheetIntakeRepository";
import { safeDocId } from "./sheetIntakeService";
import type { ProgramSheetLeadMetrics, ProgramSheetLeadRecord } from "./sheetIntakeTypes";
import { recordYoutubeApiAttempt, recordYoutubeApiUnits } from "./apiQuota";

export const YOUTUBE_LOOKBACK_DAYS = 90;
export const YOUTUBE_SHORT_MAX_SECONDS = 180;
export const YOUTUBE_PLAYLIST_PAGE_SIZE = 50;
const MAX_PLAYLIST_PAGES = 10;

type ChannelResolveKind = "channel_id" | "handle" | "custom_or_user" | "search_fallback";
type YouTubeListParams = Record<string, string | number | undefined>;

export interface YouTubeChannelItem {
  id?: string;
  snippet?: { title?: string; customUrl?: string; country?: string };
  statistics?: { subscriberCount?: string; videoCount?: string; hiddenSubscriberCount?: boolean };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

export interface YouTubePlaylistItem {
  snippet?: { publishedAt?: string; resourceId?: { videoId?: string } };
}

export interface YouTubeVideoItem {
  id?: string;
  snippet?: { publishedAt?: string };
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}

// Task-52 (적대적 리뷰 P1-1): channelsList에만 옵션 2번째 인자로 타임아웃을 열어 준다 — 기존
// 호출부(resolveYouTubeChannel 등, options 없이 호출)는 그대로 무제한 fetch로 남아 회귀가 없다.
export interface YouTubeListOptions {
  timeoutMs?: number;
}
export interface YouTubeApiClient {
  channelsList(params: YouTubeListParams, options?: YouTubeListOptions): Promise<{ items?: YouTubeChannelItem[] }>;
  playlistItemsList(params: YouTubeListParams): Promise<{ items?: YouTubePlaylistItem[]; nextPageToken?: string }>;
  videosList(params: YouTubeListParams): Promise<{ items?: YouTubeVideoItem[] }>;
  searchList(params: YouTubeListParams): Promise<{ items?: Array<{ id?: { channelId?: string }; snippet?: { channelId?: string } }> }>;
}

export interface EnrichableLeadInput {
  id?: string;
  youtubeUrl?: string;
  sourceRef?: string;
  [key: string]: unknown;
}

export interface YouTubeEnrichmentInput {
  leadIds?: unknown;
  leadRefs?: unknown;
  leads?: unknown;
  dryRun?: unknown;
  nowIso?: unknown;
  requestedBy: string;
  youtubeApi?: YouTubeApiClient;
}

export interface YouTubeLeadEnrichmentResult {
  leadId: string;
  leadRef: string;
  status: "enriched" | "skipped" | "failed";
  youtubeUrl: string;
  channelId: string | null;
  resolveKind: ChannelResolveKind | null;
  metrics: ProgramSheetLeadMetrics | null;
  error?: string;
}

export interface YouTubeEnrichmentResult {
  mode: "dry_run" | "emulator_write";
  requestedLeadCount: number;
  enrichedCount: number;
  failedCount: number;
  skippedCount: number;
  writeCount: number;
  results: YouTubeLeadEnrichmentResult[];
}

export async function enrichProgramSheetLeadYouTubeMetrics(input: YouTubeEnrichmentInput): Promise<YouTubeEnrichmentResult> {
  const dryRun = input.dryRun === true;
  if (!dryRun && !isFirestoreEmulator()) {
    const error = new Error("production YouTube enrichment writes are disabled; use dryRun or run against demo-flu emulator");
    Object.assign(error, { code: "failed-precondition", errorCode: "enrich_program_sheet_lead_you_tube_metrics_production_you_tube" });
    throw error;
  }

  const now = parseDate(input.nowIso, new Date()) ?? new Date();
  const leads = await resolveLeadInputs(input);
  if (leads.length === 0) {
    return {
      mode: dryRun ? "dry_run" : "emulator_write",
      requestedLeadCount: 0,
      enrichedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      writeCount: 0,
      results: [],
    };
  }

  const api = input.youtubeApi ?? makeYouTubeDataApiClient();
  const results: YouTubeLeadEnrichmentResult[] = [];

  for (const lead of leads) {
    const leadId = cleanLeadId(lead.id);
    const leadRef = leadPath(leadId);
    const youtubeUrl = typeof lead.youtubeUrl === "string" ? lead.youtubeUrl.trim() : "";
    if (!leadId || !youtubeUrl) {
      results.push({ leadId, leadRef, status: "skipped", youtubeUrl, channelId: null, resolveKind: null, metrics: null, error: "missing lead id or youtubeUrl" });
      continue;
    }

    try {
      const resolved = await resolveYouTubeChannel(api, youtubeUrl);
      const metrics = await collectChannelMetrics(api, resolved.channel, now);
      results.push({ leadId, leadRef, status: "enriched", youtubeUrl, channelId: resolved.channel.id ?? null, resolveKind: resolved.kind, metrics });
    } catch (error) {
      results.push({
        leadId,
        leadRef,
        status: "failed",
        youtubeUrl,
        channelId: null,
        resolveKind: null,
        metrics: null,
        error: error instanceof Error ? error.message : "unknown YouTube enrichment failure",
      });
    }
  }

  if (!dryRun) {
    const batch = adminDb.batch();
    let writeCount = 0;
    results.filter((result) => result.leadId).forEach((result) => {
      const update: Record<string, unknown> = {
        youtubeEnrichment: {
          status: result.status === "enriched" ? "success" : result.status,
          channelId: result.channelId,
          resolveKind: result.resolveKind,
          error: result.error ?? null,
          updatedAtIso: now.toISOString(),
          updatedBy: input.requestedBy,
        },
        updatedAtIso: now.toISOString(),
      };
      if (result.status === "enriched" && result.metrics) update.metrics = result.metrics;
      batch.set(adminDb.collection("program_sheet_leads").doc(result.leadId), update, { merge: true });
      writeCount += 1;
    });
    if (writeCount > 0) await batch.commit();
  }

  return {
    mode: dryRun ? "dry_run" : "emulator_write",
    requestedLeadCount: leads.length,
    enrichedCount: results.filter((result) => result.status === "enriched").length,
    failedCount: results.filter((result) => result.status === "failed").length,
    skippedCount: results.filter((result) => result.status === "skipped").length,
    writeCount: dryRun ? 0 : results.filter((result) => result.leadId).length,
    results,
  };
}

export async function resolveYouTubeChannel(api: YouTubeApiClient, youtubeUrl: string): Promise<{ channel: YouTubeChannelItem; kind: ChannelResolveKind }> {
  const hint = parseYouTubeChannelHint(youtubeUrl);
  if (hint.channelId) {
    const channel = await firstChannel(api.channelsList({ part: "snippet,statistics,contentDetails", id: hint.channelId }));
    if (channel) return { channel, kind: "channel_id" };
  }
  if (hint.handle) {
    const channel = await firstChannel(api.channelsList({ part: "snippet,statistics,contentDetails", forHandle: hint.handle.replace(/^@/, "") }));
    if (channel) return { channel, kind: "handle" };
  }
  if (hint.customName) {
    const channelId = await searchChannelId(api, hint.customName);
    if (channelId) {
      const channel = await firstChannel(api.channelsList({ part: "snippet,statistics,contentDetails", id: channelId }));
      if (channel) return { channel, kind: "custom_or_user" };
    }
  }
  const channelId = await searchChannelId(api, hint.searchQuery || youtubeUrl);
  if (channelId) {
    const channel = await firstChannel(api.channelsList({ part: "snippet,statistics,contentDetails", id: channelId }));
    if (channel) return { channel, kind: "search_fallback" };
  }
  throw new Error("YouTube channel could not be resolved");
}

/**
 * Exact-only variant of `resolveYouTubeChannel` — same URL hint ladder (channel id → forHandle)
 * but deliberately stops before any `search.list` fallback: fuzzy ranking is not proof that the
 * resolved channel is the one the applicant declared (scpPortalCreatorBinding.ts tier-3 rationale),
 * and `search` costs a separate, much larger quota bucket than `channels.list`. Callers that only
 * need "the exact channel this URL points at, if any" (e.g. the application-eligibility judge's
 * declaredIdentity fallback) use this and treat `null` as "cannot prove" — never as an error.
 */
export async function resolveYouTubeChannelExact(
  api: Pick<YouTubeApiClient, "channelsList">,
  youtubeUrl: string,
  options?: YouTubeListOptions,
): Promise<{ channel: YouTubeChannelItem; kind: "channel_id" | "handle" } | null> {
  const hint = parseYouTubeChannelHint(youtubeUrl);
  if (hint.channelId) {
    const channel = await firstChannel(api.channelsList({ part: "snippet,statistics,contentDetails", id: hint.channelId }, options));
    if (channel) return { channel, kind: "channel_id" };
  }
  if (hint.handle) {
    const channel = await firstChannel(api.channelsList({ part: "snippet,statistics,contentDetails", forHandle: hint.handle.replace(/^@/, "") }, options));
    if (channel) return { channel, kind: "handle" };
  }
  return null;
}

export interface YouTubeHandleOwnershipLookup {
  channelId: string | null;
  candidateCount: number;
}

/**
 * Exact `forHandle` channel-ownership lookup — deliberately narrower than `resolveYouTubeChannel`
 * above, which falls through to `search.list` (fuzzy ranking, wrong-candidate risk, separate
 * quota bucket) when an exact lookup misses. Authority checks that need proof of *current*
 * YouTube handle ownership (see scpPortalCreatorBinding.ts tier 3) must never accept a search
 * fallback's best-guess result, so this function only ever performs the one exact `channels.list
 * forHandle` call and reports how many candidates it found — it does not itself decide
 * pass/fail; the caller applies its own fail-closed rules to `candidateCount`/`channelId`.
 */
export async function resolveYouTubeChannelIdForHandle(
  api: Pick<YouTubeApiClient, "channelsList">,
  handle: string,
  options?: YouTubeListOptions,
): Promise<YouTubeHandleOwnershipLookup> {
  const normalizedHandle = handle.trim().replace(/^@/, "");
  const response = await api.channelsList({ part: "snippet", forHandle: normalizedHandle }, options);
  const items = response.items ?? [];
  const candidateCount = items.length;
  const channelId = candidateCount === 1 && typeof items[0]?.id === "string" ? items[0].id : null;
  return { channelId, candidateCount };
}

export type YouTubeChannelIdentityLookup = Readonly<{
  /** Channel display title as YouTube itself reports it. Null when the channel does not exist. */
  title: string | null;
  /** True only when YouTube returned exactly one channel for this id. */
  exists: boolean;
}>;

/**
 * Exact channel lookup by canonical channel id, used to (a) prove a `UC…`-shaped string is a
 * channel that really exists and (b) take the display name from YouTube rather than from an
 * applicant's self-reported handle (which is a typo axis — prod case `@codic3-g` does not
 * resolve, while the same creator's real handle `@codiceg` does).
 *
 * Transport failures (quota, network, 5xx) are deliberately allowed to throw: the caller must
 * distinguish "YouTube says this channel does not exist" (definitive, fail closed) from "we could
 * not ask YouTube right now" (retry the event) and must never materialise identity on the latter.
 */
export async function resolveYouTubeChannelById(
  api: Pick<YouTubeApiClient, "channelsList">,
  channelId: string,
): Promise<YouTubeChannelIdentityLookup> {
  const response = await api.channelsList({ part: "snippet", id: channelId });
  const items = response.items ?? [];
  if (items.length !== 1) return { title: null, exists: false };
  const title = items[0]?.snippet?.title;
  return { title: typeof title === "string" && title.trim() ? title.trim() : null, exists: true };
}

export async function collectChannelMetrics(api: YouTubeApiClient, channel: YouTubeChannelItem, now: Date): Promise<ProgramSheetLeadMetrics> {
  const channelId = channel.id ?? "";
  const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!channelId || !uploadsPlaylistId) throw new Error("resolved channel is missing uploads playlist");

  const cutoffMs = now.getTime() - YOUTUBE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const videoIds: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PLAYLIST_PAGES; page += 1) {
    const response = await api.playlistItemsList({
      part: "snippet",
      playlistId: uploadsPlaylistId,
      maxResults: YOUTUBE_PLAYLIST_PAGE_SIZE,
      pageToken,
    });
    const items = response.items ?? [];
    for (const item of items) {
      const publishedAt = parseDate(item.snippet?.publishedAt, null);
      if (publishedAt && publishedAt.getTime() < cutoffMs) continue;
      const videoId = item.snippet?.resourceId?.videoId;
      if (videoId) videoIds.push(videoId);
    }
    pageToken = response.nextPageToken;
    if (!pageToken) break;
  }

  const videos: YouTubeVideoItem[] = [];
  for (const chunk of chunks(videoIds, 50)) {
    const response = await api.videosList({ part: "snippet,contentDetails,statistics", id: chunk.join(",") });
    videos.push(...(response.items ?? []));
  }

  const recentVideos = videos.filter((video) => {
    const publishedAt = parseDate(video.snippet?.publishedAt, null);
    return !publishedAt || publishedAt.getTime() >= cutoffMs;
  });
  const shortVideos = recentVideos.filter((video) => parseIso8601DurationSeconds(video.contentDetails?.duration ?? "") <= YOUTUBE_SHORT_MAX_SECONDS);
  const longVideos = recentVideos.filter((video) => parseIso8601DurationSeconds(video.contentDetails?.duration ?? "") > YOUTUBE_SHORT_MAX_SECONDS);

  const longViews = viewStats(longVideos);
  const shortViews = viewStats(shortVideos);
  const totalViews = viewStats(recentVideos);
  const engagement = {
    long: engagementRate(longVideos),
    short: engagementRate(shortVideos),
    total: engagementRate(recentVideos),
  };

  return {
    subscribers: numberFromString(channel.statistics?.subscriberCount),
    hiddenSubscribers: channel.statistics?.hiddenSubscriberCount === true,
    channelId,
    uploadsPlaylistId,
    lookbackDays: YOUTUBE_LOOKBACK_DAYS,
    shortMaxSeconds: YOUTUBE_SHORT_MAX_SECONDS,
    videoCount: { long: longVideos.length, short: shortVideos.length, total: recentVideos.length },
    uploadFreq: {
      long: monthlyAverage(longVideos.length),
      short: monthlyAverage(shortVideos.length),
      total: monthlyAverage(recentVideos.length),
    },
    longViews,
    shortViews,
    totalViews,
    engagement,
    collectedAtIso: now.toISOString(),
    source: "youtube_data_api_v3",
  };
}

export function parseIso8601DurationSeconds(duration: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(duration.trim());
  if (!match) return 0;
  const [, days, hours, minutes, seconds] = match;
  return Math.round(
    (Number(days ?? 0) * 24 * 60 * 60) +
    (Number(hours ?? 0) * 60 * 60) +
    (Number(minutes ?? 0) * 60) +
    Number(seconds ?? 0),
  );
}

function parseYouTubeChannelHint(value: string): { channelId?: string; handle?: string; customName?: string; searchQuery: string } {
  const raw = value.trim();
  const channelMatch = raw.match(/\/channel\/(UC[\w-]+)/i) ?? raw.match(/^(UC[\w-]{8,})$/i);
  const handleMatch = raw.match(/(?:youtube\.com\/)?(@[\w.-]+)/i) ?? raw.match(/^@([\w.-]+)$/i);
  const customMatch = raw.match(/\/(?:c|user)\/([^/?#]+)/i);
  return {
    channelId: channelMatch?.[1],
    handle: handleMatch?.[1] ? (handleMatch[1].startsWith("@") ? handleMatch[1] : `@${handleMatch[1]}`) : undefined,
    customName: customMatch?.[1],
    searchQuery: customMatch?.[1] ?? handleMatch?.[1] ?? raw,
  };
}

async function searchChannelId(api: YouTubeApiClient, query: string): Promise<string | null> {
  const response = await api.searchList({ part: "snippet", q: query.replace(/^@/, ""), type: "channel", maxResults: 1 });
  const first = response.items?.[0];
  return first?.id?.channelId ?? first?.snippet?.channelId ?? null;
}

async function firstChannel(promise: Promise<{ items?: YouTubeChannelItem[] }>): Promise<YouTubeChannelItem | null> {
  const response = await promise;
  return response.items?.[0] ?? null;
}

async function resolveLeadInputs(input: YouTubeEnrichmentInput): Promise<EnrichableLeadInput[]> {
  const inline = parseInlineLeads(input.leads);
  if (inline.length > 0) return inline;

  const ids = [...stringArray(input.leadIds), ...stringArray(input.leadRefs).map((ref) => ref.split("/").at(-1) ?? "")]
    .map(cleanLeadId)
    .filter(Boolean);
  if (ids.length === 0) return [];

  const snapshots = await Promise.all(ids.map((id) => adminDb.collection("program_sheet_leads").doc(id).get()));
  return snapshots
    .filter((snapshot) => snapshot.exists)
    .map((snapshot) => ({ ...(snapshot.data() as ProgramSheetLeadRecord), id: snapshot.id }));
}

function parseInlineLeads(value: unknown): EnrichableLeadInput[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item, index) => {
    const record = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    return {
      ...record,
      id: cleanLeadId(record.id) || cleanLeadId(record.leadId) || safeDocId(`inline:${index}`),
      youtubeUrl: typeof record.youtubeUrl === "string" ? record.youtubeUrl : "",
    };
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 100) : [];
}

function cleanLeadId(value: unknown): string {
  return typeof value === "string" ? safeDocId(value.split("/").at(-1) ?? value) : "";
}

function viewStats(videos: YouTubeVideoItem[]): { median: number; mean: number; max: number } {
  const views = videos.map((video) => numberFromString(video.statistics?.viewCount)).sort((a, b) => a - b);
  if (views.length === 0) return { median: 0, mean: 0, max: 0 };
  const mid = Math.floor(views.length / 2);
  const median = views.length % 2 ? views[mid] : Math.round((views[mid - 1] + views[mid]) / 2);
  const mean = Math.round(views.reduce((sum, item) => sum + item, 0) / views.length);
  return { median, mean, max: views.at(-1) ?? 0 };
}

function engagementRate(videos: YouTubeVideoItem[]): number {
  const totals = videos.reduce((acc, video) => {
    const views = numberFromString(video.statistics?.viewCount);
    return {
      views: acc.views + views,
      engagements: acc.engagements + numberFromString(video.statistics?.likeCount) + numberFromString(video.statistics?.commentCount),
    };
  }, { views: 0, engagements: 0 });
  return totals.views > 0 ? Number(((totals.engagements / totals.views) * 100).toFixed(2)) : 0;
}

function numberFromString(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value !== "string") return 0;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function monthlyAverage(count: number): number {
  return Number((count / 3).toFixed(2));
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function parseDate(value: unknown, fallback: Date | null): Date | null {
  if (typeof value !== "string") return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

export function makeYouTubeDataApiClient(): YouTubeApiClient { const apiKey = process.env.YOUTUBE_API_KEY;
if (!apiKey && isFirestoreEmulator()) return makeMockYouTubeDataApiClient();
if (!apiKey) {
  const error = new Error("YOUTUBE_API_KEY is not configured for server-side YouTube enrichment");
  Object.assign(error, { code: "failed-precondition", errorCode: "make_you_tube_data_api_client_youtube_api_key_configured_server" });
  throw error;
}
return {
  channelsList: (params, options) => youtubeGet("channels", params, apiKey, options),
  playlistItemsList: (params) => youtubeGet("playlistItems", params, apiKey),
  videosList: (params) => youtubeGet("videos", params, apiKey),
  searchList: (params) => youtubeGet("search", params, apiKey),
}; }

function makeMockYouTubeDataApiClient(): YouTubeApiClient {
  return {
    async channelsList(params) {
      const id = typeof params.id === "string" && params.id ? params.id : `UCmock${safeDocId(String(params.forHandle ?? "channel"))}`;
      return { items: [{
        id,
        statistics: { subscriberCount: "0", videoCount: "0" },
        contentDetails: { relatedPlaylists: { uploads: `UU${id.replace(/^UC/, "")}` } },
      }] };
    },
    async playlistItemsList() {
      return { items: [] };
    },
    async videosList() {
      return { items: [] };
    },
    async searchList(params) {
      return { items: [{ id: { channelId: `UCmock${safeDocId(String(params.q ?? "search"))}` } }] };
    },
  };
}

async function youtubeGet<T>(
  resource: string,
  params: YouTubeListParams,
  apiKey: string,
  options?: YouTubeListOptions,
): Promise<T> {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  });
  url.searchParams.set("key", apiKey);
  // R28-3 (P0-A): 이 경로도 fetch 직전에 시도를 선기록하고 실패를 완결한다 — 현행은 성공만 남겨
  // (아래 recordYoutubeApiUnits) 403/429 로 태운 콜이 계측에서 통째로 사라졌다.
  void recordYoutubeApiAttempt({ operation: resource, slotIndex: 0, outcome: "attempted" });
  // Task-52 (적대적 리뷰 P1-1): 이 fetch에는 원래 타임아웃이 없었다 — options.timeoutMs를 넘긴
  // 호출(현재는 directoryChannelStatsByHandle 청크 보강 경로뿐)만 AbortSignal로 상한을 건다.
  // 옵션을 안 넘기는 기존 호출부는 전과 동일하게 무제한으로 남는다(회귀 0).
  const response = await fetch(url, options?.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : undefined);
  if (!response.ok) {
    void recordYoutubeApiAttempt({ operation: resource, slotIndex: 0, outcome: "failure", httpStatus: response.status });
    throw new Error(`YouTube Data API ${resource}.list failed with HTTP ${response.status}`);
  }
  // R21-2: 이 클라이언트는 process.env.YOUTUBE_API_KEY(=슬롯 0, 주 키)만 쓴다. 슬롯을 명시해야
  // 주 키 잔여 계산에 추적·보강 사용량이 포함된다(빠지면 가드가 잔여를 과대평가해 예약분이 뚫린다).
  void recordYoutubeApiUnits(resource, 1, 0);
  void recordYoutubeApiAttempt({ operation: resource, slotIndex: 0, outcome: "success" });
  return await response.json() as T;
}

function isFirestoreEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === "true" || Boolean(process.env.FIRESTORE_EMULATOR_HOST);
}
