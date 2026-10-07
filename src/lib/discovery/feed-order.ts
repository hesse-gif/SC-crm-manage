/**
 * Pure recency-dominant ordering for feed items.
 * Zero external imports — directly importable by Node tests without path-alias resolution.
 *
 * Algorithm:
 *  - Sort candidates by recency DESC (newest first).
 *  - Greedily emit the next candidate whose source has not exceeded the
 *    per-window cap in the last `maxPerSource` consecutive positions.
 *  - When only one source remains (all others exhausted), relax the cap.
 *
 * This preserves recency as the dominant signal while preventing long
 * consecutive runs from a single source.
 */

export function recencyDominantOrder<T>(
  /** Items already filtered to the "selected" set (no overflow). Must be sorted newest-first. */
  items: T[],
  options: {
    maxPerSource: number;
    sourceKey: (item: T) => string;
    dateMs: (item: T) => number;
  },
): T[] {
  if (items.length === 0) return [];

  const { maxPerSource, sourceKey, dateMs } = options;

  // Sort by recency DESC (stable copy — do not mutate input).
  const pool = [...items].sort((a, b) => dateMs(b) - dateMs(a));

  const result: T[] = [];
  // Track how many times each source has appeared in the last `maxPerSource` slots.
  // We use a sliding window of the last `maxPerSource` results.
  const window: string[] = [];

  while (pool.length > 0) {
    // Count source occurrences in the current window.
    const windowCounts = new Map<string, number>();
    for (const src of window) {
      windowCounts.set(src, (windowCounts.get(src) ?? 0) + 1);
    }

    // Determine distinct sources still available.
    const availableSources = new Set(pool.map(sourceKey));

    // Find the first (newest) item in pool whose source hasn't hit the cap,
    // or — if all remaining sources are at cap — relax and just take the newest.
    let picked = -1;
    for (let i = 0; i < pool.length; i++) {
      const src = sourceKey(pool[i]);
      const count = windowCounts.get(src) ?? 0;
      if (count < maxPerSource) {
        picked = i;
        break;
      }
    }

    if (picked === -1) {
      // All remaining sources are at cap in this window — relax: take newest.
      picked = 0;
    }

    const item = pool.splice(picked, 1)[0];
    result.push(item);

    // Advance window.
    window.push(sourceKey(item));
    if (window.length > maxPerSource) window.shift();
  }

  return result;
}
