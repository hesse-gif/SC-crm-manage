// Pure core for duplicate detection at scale (handoff §6). Deterministic, no I/O.
// Invariants encoded here:
//  - exact gates: identical youtubeVideoId or verified fileHash are hard duplicates.
//  - near-duplicate ranking is query-vs-candidates only (O(candidates)); NEVER all-pairs (O(n^2)).
//    The caller supplies a bounded candidate set from indexed buckets/ANN; this ranks + bounds top-K.
//  - versioned fingerprints; reviewer-facing per-signal explanation; cluster id for grouping.

export const DUPLICATE_DETECTION_VERSION = "duplicate_detection.v1" as const;
export const DEFAULT_TOP_K = 20;
export const DEFAULT_NEAR_DUP_THRESHOLD = 0.85;

const NIBBLE_POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

// Hamming distance between two equal-length hex-encoded perceptual hashes (bit count).
export function hammingDistanceHex(a: string, b: string): number {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  let d = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number.parseInt(a[i] as string, 16);
    const y = Number.parseInt(b[i] as string, 16);
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.POSITIVE_INFINITY;
    d += NIBBLE_POPCOUNT[(x ^ y) & 0xf] as number;
  }
  return d;
}

export function pHashSimilarity(a: string, b: string): number {
  const bits = a.length * 4;
  const d = hammingDistanceHex(a, b);
  return Number.isFinite(d) && bits > 0 ? 1 - d / bits : 0;
}

// MinHash signature Jaccard estimate: fraction of equal signature positions.
export function minHashJaccard(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let eq = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] === b[i]) eq += 1;
  return eq / a.length;
}

export type VideoFingerprint = {
  videoSubmissionId: string;
  youtubeVideoId?: string | null;
  fileHash?: string | null;
  pHash?: string | null;
  transcriptMinHash?: number[] | null;
};

export type ExactDuplicateHit = { videoSubmissionId: string; kind: "youtube_video_id" | "file_hash" };

export function detectExactDuplicate(query: VideoFingerprint, candidates: readonly VideoFingerprint[]): ExactDuplicateHit | null {
  for (const c of candidates) {
    if (c.videoSubmissionId === query.videoSubmissionId) continue;
    if (query.youtubeVideoId && c.youtubeVideoId && query.youtubeVideoId === c.youtubeVideoId) {
      return { videoSubmissionId: c.videoSubmissionId, kind: "youtube_video_id" };
    }
    if (query.fileHash && c.fileHash && query.fileHash === c.fileHash) {
      return { videoSubmissionId: c.videoSubmissionId, kind: "file_hash" };
    }
  }
  return null;
}

export type NearDuplicateCandidate = {
  videoSubmissionId: string;
  similarity: number;
  signals: { pHash: number; transcript: number };
};

export type NearDuplicateResult = {
  version: typeof DUPLICATE_DETECTION_VERSION;
  topK: NearDuplicateCandidate[];
  scanned: number;
  clusterId: string | null;
};

export function rankNearDuplicateCandidates(
  query: VideoFingerprint,
  candidates: readonly VideoFingerprint[],
  opts: { topK?: number; threshold?: number } = {},
): NearDuplicateResult {
  const topK = Math.max(1, Math.trunc(opts.topK ?? DEFAULT_TOP_K));
  const threshold = opts.threshold ?? DEFAULT_NEAR_DUP_THRESHOLD;
  const scored: NearDuplicateCandidate[] = [];
  // O(candidates), not O(n^2): only the pre-filtered candidate bucket is compared against the query.
  for (const c of candidates) {
    if (c.videoSubmissionId === query.videoSubmissionId) continue;
    const pHash = query.pHash && c.pHash ? pHashSimilarity(query.pHash, c.pHash) : 0;
    const transcript = query.transcriptMinHash && c.transcriptMinHash ? minHashJaccard(query.transcriptMinHash, c.transcriptMinHash) : 0;
    scored.push({ videoSubmissionId: c.videoSubmissionId, similarity: Math.max(pHash, transcript), signals: { pHash, transcript } });
  }
  scored.sort((a, b) => (b.similarity - a.similarity) || a.videoSubmissionId.localeCompare(b.videoSubmissionId));
  const bounded = scored.slice(0, topK);
  const clusterMembers = bounded.filter((s) => s.similarity >= threshold).map((s) => s.videoSubmissionId);
  const clusterId = clusterMembers.length
    ? `dupcluster_${[query.videoSubmissionId, ...clusterMembers].sort()[0]}`
    : null;
  return { version: DUPLICATE_DETECTION_VERSION, topK: bounded, scanned: candidates.length, clusterId };
}
