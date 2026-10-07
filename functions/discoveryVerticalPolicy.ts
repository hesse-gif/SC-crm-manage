export const DISCOVERY_VERTICALS = ["game", "ai_drama"] as const;
export type DiscoveryVertical = typeof DISCOVERY_VERTICALS[number];

export const AI_DRAMA_DISCOVERY_KEYWORDS = [
  "ai microdrama",
  "ai micro drama",
  "ai short drama",
  "ai drama series",
  "ai vertical drama",
  "ai animation",
  "ai anime",
  "ai revenge drama",
  "ai rebirth drama",
  "ai fantasy romance",
  "ai romance fantasy",
  "ai romance drama",
  "ai fantasy drama",
  "ai isekai",
  "ai BL",
  "ai yaoi",
] as const;

export const AI_DRAMA_DISCOVERY_COUNTRIES = ["KR", "CN", "US", "JP"] as const;

export const AI_DRAMA_DISCOVERY_CATEGORIES = [
  "AI microdrama",
  "AI short drama",
  "AI vertical drama",
  "AI animation",
  "AI anime",
  "AI romance fantasy",
] as const;

export const AI_DRAMA_DISCOVERY_TAGS = [
  "AI Drama",
  "Microdrama",
  "Vertical",
  "YouTube",
] as const;

export const AI_DRAMA_MIN_QUALIFYING_VIDEO_VIEWS = 50_000;
export const AI_DRAMA_MIN_QUALIFYING_VIDEO_COUNT = 1;

export type QualifyingVideoEvidence = {
  videoId: string;
  title: string;
  viewCount: number;
  publishedAtIso?: string;
  source: "youtube.matched_videos" | "youtube.channel_top_videos" | "youtube.uploads_playlist";
  observedAtIso: string;
  threshold: number;
  tags?: string[];
  categoryId?: string;
  snippetSource?: "youtube.videos.list.snippet";
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? Array.from(new Set(value.map((item) => asString(item) ?? "").filter(Boolean))) : [];
}

function owns(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function normalizeDiscoveryVertical(value: unknown): DiscoveryVertical {
  const text = asString(value)?.toLowerCase().replace(/[\s-]+/g, "_");
  return text === "ai_drama" || text === "aidrama" ? "ai_drama" : "game";
}

export function readOwnedDiscoveryVertical(
  sources: readonly Record<string, unknown>[],
  fallback: DiscoveryVertical = "game",
): DiscoveryVertical {
  for (const source of sources) {
    if (owns(source, "discoveryVertical") || owns(source, "vertical")) {
      return normalizeDiscoveryVertical(source.discoveryVertical ?? source.vertical);
    }
  }
  return fallback;
}

export function readOwnedPositiveInteger(
  sources: readonly Record<string, unknown>[],
  keys: readonly string[],
  fallback: number,
  min: number,
  max: number,
): number {
  for (const source of sources) {
    for (const key of keys) {
      if (!owns(source, key)) continue;
      const number = asNumber(source[key]);
      if (number !== undefined) return Math.max(min, Math.min(Math.trunc(number), max));
    }
  }
  return fallback;
}

export function aiDramaCandidateCriteriaDefaults(input: Record<string, unknown>): Record<string, unknown> {
  const candidateCriteria = { ...input };
  if (normalizeDiscoveryVertical(candidateCriteria.discoveryVertical ?? candidateCriteria.vertical) !== "ai_drama") {
    return candidateCriteria;
  }
  if (!owns(candidateCriteria, "keywords") && !owns(candidateCriteria, "includeKeywords")) {
    candidateCriteria.keywords = [...AI_DRAMA_DISCOVERY_KEYWORDS];
  }
  if (!owns(candidateCriteria, "categories")) {
    candidateCriteria.categories = [...AI_DRAMA_DISCOVERY_CATEGORIES];
  }
  if (!owns(candidateCriteria, "targetCountries") && !owns(candidateCriteria, "countryTargeting")) {
    candidateCriteria.countryTargeting = {
      countryScope: "include",
      includedCountries: [...AI_DRAMA_DISCOVERY_COUNTRIES],
      excludedCountries: [],
    };
    candidateCriteria.targetCountries = [...AI_DRAMA_DISCOVERY_COUNTRIES];
  }
  if (!owns(candidateCriteria, "minVideoViews")) {
    candidateCriteria.minVideoViews = AI_DRAMA_MIN_QUALIFYING_VIDEO_VIEWS;
  }
  if (!owns(candidateCriteria, "minVideoCount")) {
    candidateCriteria.minVideoCount = AI_DRAMA_MIN_QUALIFYING_VIDEO_COUNT;
  }
  candidateCriteria.discoveryVertical = "ai_drama";
  return candidateCriteria;
}

export function aiDramaProgramTags(existing: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of [...existing, ...AI_DRAMA_DISCOVERY_TAGS]) {
    const text = value.trim();
    if (!text) continue;
    if (out.some((prior) => prior.toLowerCase() === text.toLowerCase())) continue;
    out.push(text);
  }
  return out.slice(0, 50);
}

export function qualifyingVideoEvidenceFromRecord(
  value: unknown,
  source: QualifyingVideoEvidence["source"],
  threshold: number,
  observedAtIso: string,
): QualifyingVideoEvidence | null {
  const record = asRecord(value);
  const videoId = asString(record.videoId) ?? asString(record.id);
  const statistics = asRecord(record.statistics);
  const snippet = asRecord(record.snippet);
  const rawViews = record.viewCount ?? statistics.viewCount;
  const viewCount = typeof rawViews === "string" ? Number(rawViews) : asNumber(rawViews);
  if (!videoId || !Number.isFinite(viewCount) || (viewCount as number) < threshold) return null;
  const tags = stringArray(record.tags).length > 0 ? stringArray(record.tags) : stringArray(snippet.tags);
  const categoryId = asString(record.categoryId) ?? asString(snippet.categoryId);
  return {
    videoId,
    title: asString(record.title) ?? asString(snippet.title) ?? "",
    viewCount: Math.trunc(viewCount as number),
    ...(asString(record.publishedAtIso) || asString(snippet.publishedAt)
      ? { publishedAtIso: asString(record.publishedAtIso) ?? asString(snippet.publishedAt) }
      : {}),
    source,
    observedAtIso,
    threshold,
    ...(tags.length > 0 ? { tags, snippetSource: "youtube.videos.list.snippet" as const } : {}),
    ...(categoryId ? { categoryId, snippetSource: "youtube.videos.list.snippet" as const } : {}),
  };
}

export function qualifyingVideoEvidencesFromRecords(
  records: readonly unknown[],
  source: QualifyingVideoEvidence["source"],
  threshold: number,
  observedAtIso: string,
): QualifyingVideoEvidence[] {
  const seen = new Set<string>();
  return records
    .map((record) => qualifyingVideoEvidenceFromRecord(record, source, threshold, observedAtIso))
    .filter((record): record is QualifyingVideoEvidence => Boolean(record))
    .filter((record) => {
      if (seen.has(record.videoId)) return false;
      seen.add(record.videoId);
      return true;
    })
    .sort((left, right) => right.viewCount - left.viewCount);
}

export function bestQualifyingVideoEvidence(
  records: readonly unknown[],
  source: QualifyingVideoEvidence["source"],
  threshold: number,
  observedAtIso: string,
): QualifyingVideoEvidence | null {
  return qualifyingVideoEvidencesFromRecords(records, source, threshold, observedAtIso)[0] ?? null;
}
