import type { SimilarCreatorResult } from "./similar-types.ts";

type DiversityCaps = {
  readonly platform: number;
  readonly category: number;
  readonly region: number;
  readonly cluster: number;
};

const STRICT_DIVERSITY_CAPS: DiversityCaps = {
  platform: 3,
  category: 3,
  region: 4,
  cluster: 3,
};

const CREATOR_CLUSTER_STOPWORDS = new Set(["channel", "creator", "game", "games", "gaming", "official", "plays", "tv"]);

function normalizeDiversityKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/^@/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function similarClusterKey(candidate: SimilarCreatorResult): string {
  const tokens = normalizeDiversityKey(`${candidate.handle} ${candidate.name}`)
    .replace(/\d+/g, "")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !CREATOR_CLUSTER_STOPWORDS.has(token));
  return tokens[0] ?? normalizeDiversityKey(candidate.name);
}

function selectedCount(selected: readonly SimilarCreatorResult[], value: string, selector: (candidate: SimilarCreatorResult) => string): number {
  return value ? selected.reduce((count, candidate) => count + (selector(candidate) === value ? 1 : 0), 0) : 0;
}

function candidateDiversityKeys(candidate: SimilarCreatorResult): Record<keyof DiversityCaps, string> {
  return {
    platform: normalizeDiversityKey(candidate.platform),
    category: normalizeDiversityKey(candidate.category),
    region: normalizeDiversityKey(candidate.region),
    cluster: similarClusterKey(candidate),
  };
}

function respectsDiversityCaps(candidate: SimilarCreatorResult, selected: readonly SimilarCreatorResult[], caps: DiversityCaps): boolean {
  const keys = candidateDiversityKeys(candidate);
  return (
    selectedCount(selected, keys.platform, (item) => candidateDiversityKeys(item).platform) < caps.platform
    && selectedCount(selected, keys.category, (item) => candidateDiversityKeys(item).category) < caps.category
    && selectedCount(selected, keys.region, (item) => candidateDiversityKeys(item).region) < caps.region
    && selectedCount(selected, keys.cluster, (item) => candidateDiversityKeys(item).cluster) < caps.cluster
  );
}

function relaxationPenalty(candidate: SimilarCreatorResult, selected: readonly SimilarCreatorResult[], caps: DiversityCaps): number {
  const keys = candidateDiversityKeys(candidate);
  const platformOverage = Math.max(0, selectedCount(selected, keys.platform, (item) => candidateDiversityKeys(item).platform) - caps.platform + 1);
  const categoryOverage = Math.max(0, selectedCount(selected, keys.category, (item) => candidateDiversityKeys(item).category) - caps.category + 1);
  const regionOverage = Math.max(0, selectedCount(selected, keys.region, (item) => candidateDiversityKeys(item).region) - caps.region + 1);
  const clusterOverage = Math.max(0, selectedCount(selected, keys.cluster, (item) => candidateDiversityKeys(item).cluster) - caps.cluster + 1);
  return platformOverage * 14 + categoryOverage * 16 + regionOverage * 14 + clusterOverage * 18;
}

function compareByScore(left: SimilarCreatorResult, right: SimilarCreatorResult): number {
  return right.score - left.score || left.name.localeCompare(right.name);
}

function takeAt(candidates: SimilarCreatorResult[], index: number): SimilarCreatorResult | undefined {
  const [candidate] = candidates.splice(index, 1);
  return candidate;
}

export function diversifySimilarResults(sorted: readonly SimilarCreatorResult[], limit: number): SimilarCreatorResult[] {
  const remaining = [...sorted].sort(compareByScore);
  const selected: SimilarCreatorResult[] = [];

  while (selected.length < limit && remaining.length > 0) {
    const strictIndex = remaining.findIndex((candidate) => respectsDiversityCaps(candidate, selected, STRICT_DIVERSITY_CAPS));
    if (strictIndex < 0) break;
    const next = takeAt(remaining, strictIndex);
    if (!next) break;
    selected.push(next);
  }

  while (selected.length < limit && remaining.length > 0) {
    remaining.sort((left, right) => {
      const adjusted = (right.score - relaxationPenalty(right, selected, STRICT_DIVERSITY_CAPS)) - (left.score - relaxationPenalty(left, selected, STRICT_DIVERSITY_CAPS));
      return adjusted || compareByScore(left, right);
    });
    const next = takeAt(remaining, 0);
    if (!next) break;
    selected.push(next);
  }

  return selected;
}
