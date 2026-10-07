export const DEFAULT_AD_SPEND_RATES = {
  cpvByFormat: {
    dedicated: 0.20,
    preRoll: 0.04,
    shorts: 0.04,
  },
  cpmUsd: 20,
} as const;

export type VideoAdFormat = "dedicated" | "preRoll" | "shorts";
export type AdSpendRates = {
  readonly cpvByFormat: Record<VideoAdFormat, number>;
  readonly cpmUsd: number;
};
export type AdSpendRatesInput = {
  readonly cpvByFormat?: Partial<Record<VideoAdFormat, unknown>>;
  readonly cpmUsd?: unknown;
};
export type SponsorshipDetection = {
  readonly isSponsored: boolean;
  readonly sponsorSignals: string[];
  readonly sponsorConfidence: number;
};
export type VideoSponsorshipInput = {
  readonly title?: unknown;
  readonly description?: unknown;
  readonly hashtags?: readonly unknown[];
  readonly sourceUrl?: unknown;
};
export type VideoAdSpendInput = {
  readonly sourceUrl?: unknown;
  readonly durationSeconds?: unknown;
  readonly viewCount?: unknown;
  readonly sponsorship?: SponsorshipDetection;
};
export type VideoAdSpendEstimate = {
  readonly estimatedSpendUsd: number | null;
  readonly model: "cpv" | "cpm";
  readonly basis: {
    readonly format: VideoAdFormat;
    readonly views: number | null;
    readonly rate: number;
    readonly reason?: string;
  };
};

const SPONSOR_MARKERS: Array<{ readonly signal: string; readonly pattern: RegExp }> = [
  { signal: "#ad", pattern: /(^|[\s,.;:!()[\]{}])#ad(?=$|[\s,.;:!()[\]{}])/i },
  { signal: "#sponsored", pattern: /(^|[\s,.;:!()[\]{}])#sponsored(?=$|video\b|[\s,.;:!()[\]{}])/i },
  { signal: "#sponsoredvideo", pattern: /(^|[\s,.;:!()[\]{}])#sponsoredvideo(?=$|[\s,.;:!()[\]{}])/i },
  { signal: "#pr", pattern: /(^|[\s,.;:!()[\]{}])#pr(?=$|[\s,.;:!()[\]{}])/i },
  { signal: "#promotion", pattern: /(^|[\s,.;:!()[\]{}])#promotion(?=$|[\s,.;:!()[\]{}])/i },
  { signal: "#광고", pattern: /(^|[\s,.;:!()[\]{}])#광고(?=$|[\s,.;:!()[\]{}])/i },
  { signal: "#유료광고", pattern: /(^|[\s,.;:!()[\]{}])#유료광고(?=$|[\s,.;:!()[\]{}])/i },
  { signal: "#협찬", pattern: /(^|[\s,.;:!()[\]{}])#협찬(?=$|[\s,.;:!()[\]{}])/i },
  { signal: "paid promotion", pattern: /\b(?:includes\s+)?paid\s+promotion\b/i },
  { signal: "sponsored by", pattern: /\bsponsored\s+by\b/i },
  { signal: "in partnership with", pattern: /\bin\s+partnership\s+with\b/i },
  { signal: "paid partnership", pattern: /\bpaid\s+partnership\b/i },
  { signal: "affiliate disclosure", pattern: /\b(?:affiliate\s+link|affiliate\s+links|commission\s+may\s+be\s+earned)\b/i },
  { signal: "광고", pattern: /(^|[\s,.;:!()[\]{}])광고(?=$|[\s,.;:!()[\]{}])/i },
  { signal: "유료광고", pattern: /유료\s*광고/i },
  { signal: "협찬", pattern: /협찬/i },
];
const TRACKING_LINK_PATTERN = /\bhttps?:\/\/\S*(?:utm_(?:source|campaign|medium)=|[?&](?:ref|aff(?:iliate)?_?id|clickid|fbclid|gclid)=)/i;

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  }
  return null;
}

function positiveRate(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

export function normalizeAdSpendRates(input: AdSpendRatesInput | undefined): AdSpendRates {
  const cpv = input?.cpvByFormat ?? {};
  return {
    cpvByFormat: {
      dedicated: positiveRate(cpv.dedicated, DEFAULT_AD_SPEND_RATES.cpvByFormat.dedicated),
      preRoll: positiveRate(cpv.preRoll, DEFAULT_AD_SPEND_RATES.cpvByFormat.preRoll),
      shorts: positiveRate(cpv.shorts, DEFAULT_AD_SPEND_RATES.cpvByFormat.shorts),
    },
    cpmUsd: positiveRate(input?.cpmUsd, DEFAULT_AD_SPEND_RATES.cpmUsd),
  };
}

export function detectVideoSponsorship(video: VideoSponsorshipInput): SponsorshipDetection {
  const hashtagText = (video.hashtags ?? []).map(textValue).filter(Boolean).join(" ");
  const searchable = [video.title, video.description, hashtagText, video.sourceUrl].map(textValue).join("\n");
  const sponsorSignals = unique(SPONSOR_MARKERS
    .filter((marker) => marker.pattern.test(searchable))
    .map((marker) => marker.signal));

  if (sponsorSignals.length > 0 && TRACKING_LINK_PATTERN.test(searchable)) sponsorSignals.push("tracking link");
  const isSponsored = sponsorSignals.some((signal) => signal !== "tracking link");
  if (!isSponsored) return { isSponsored: false, sponsorSignals: [], sponsorConfidence: 0 };
  return {
    isSponsored,
    sponsorSignals: unique(sponsorSignals),
    sponsorConfidence: Math.min(0.95, 0.65 + sponsorSignals.length * 0.08),
  };
}

function videoFormat(video: VideoAdSpendInput): VideoAdFormat {
  const url = textValue(video.sourceUrl).toLowerCase();
  const duration = numberValue(video.durationSeconds);
  if (url.includes("/shorts/") || (duration !== null && duration <= 60)) return "shorts";
  return "dedicated";
}

export function estimateVideoAdSpendUsd(video: VideoAdSpendInput, ratesInput?: AdSpendRatesInput): VideoAdSpendEstimate {
  const rates = normalizeAdSpendRates(ratesInput);
  const format = videoFormat(video);
  const views = numberValue(video.viewCount);
  const sponsored = video.sponsorship?.isSponsored === true;
  const cpv = rates.cpvByFormat[format];
  if (!sponsored) return { estimatedSpendUsd: null, model: "cpv", basis: { format, views, rate: cpv, reason: "not_sponsored" } };
  if (views === null) return { estimatedSpendUsd: null, model: "cpv", basis: { format, views, rate: cpv, reason: "views_unknown" } };
  return {
    estimatedSpendUsd: Math.round(views * cpv * 100) / 100,
    model: "cpv",
    basis: { format, views, rate: cpv },
  };
}
