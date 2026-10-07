import { normalizeYoutubeCreatorCountry } from "./youtubeCreatorCountries";
import { asRecord, numberField, stringField } from "./ytdlpRecordParser";

export type CountryDistributionItem = {
  readonly country?: unknown;
  readonly views?: unknown;
};

export type CountryViewsDistributionEntry = {
  readonly country: string;
  readonly views: number;
  readonly sharePct: number;
};

export type CountryVideoCountDistributionEntry = {
  readonly country: string;
  readonly count: number;
  readonly sharePct: number;
};

export type CountryDistribution = {
  readonly byViews: readonly CountryViewsDistributionEntry[];
  readonly byVideoCount: readonly CountryVideoCountDistributionEntry[];
  readonly totals: {
    readonly views: number;
    readonly videos: number;
  };
  readonly unknown: {
    readonly views: number;
    readonly videos: number;
  };
};

type CountryBucket = {
  country: string;
  views: number;
  count: number;
};

function nonNegativeInteger(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.trunc(parsed));
  }
  return 0;
}

function sharePct(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 10000) / 100;
}

function sortedBuckets(buckets: ReadonlyMap<string, CountryBucket>, key: "views" | "count"): CountryBucket[] {
  return Array.from(buckets.values()).sort((left, right) => {
    const byMetric = right[key] - left[key];
    return byMetric !== 0 ? byMetric : left.country.localeCompare(right.country);
  });
}

export function countryDistributionItemFromYtDlpRecord(raw: unknown): CountryDistributionItem | null {
  const record = asRecord(raw);
  if (!record) return null;
  const videoId = stringField(record, ["id", "video_id", "videoId"]);
  const channelId = stringField(record, ["channel_id", "channelId"]);
  if (!videoId || !channelId) return null;
  return {
    country: stringField(record, ["channel_country", "channelCountry", "creatorCountry", "country"]),
    views: numberField(record, ["view_count", "viewCount", "views"]),
  };
}

export function aggregateCountryDistribution(items: readonly CountryDistributionItem[]): CountryDistribution {
  const buckets = new Map<string, CountryBucket>();
  let unknownViews = 0;
  let unknownVideos = 0;

  for (const item of items) {
    const views = nonNegativeInteger(item.views);
    const country = normalizeYoutubeCreatorCountry(item.country);
    if (!country) {
      unknownViews += views;
      unknownVideos += 1;
      continue;
    }
    const bucket = buckets.get(country);
    if (bucket) {
      bucket.views += views;
      bucket.count += 1;
    } else {
      buckets.set(country, { country, views, count: 1 });
    }
  }

  const totalViews = Array.from(buckets.values()).reduce((sum, bucket) => sum + bucket.views, 0);
  const totalVideos = Array.from(buckets.values()).reduce((sum, bucket) => sum + bucket.count, 0);

  return {
    byViews: sortedBuckets(buckets, "views").map((bucket) => ({
      country: bucket.country,
      views: bucket.views,
      sharePct: sharePct(bucket.views, totalViews),
    })),
    byVideoCount: sortedBuckets(buckets, "count").map((bucket) => ({
      country: bucket.country,
      count: bucket.count,
      sharePct: sharePct(bucket.count, totalVideos),
    })),
    totals: { views: totalViews, videos: totalVideos },
    unknown: { views: unknownViews, videos: unknownVideos },
  };
}
