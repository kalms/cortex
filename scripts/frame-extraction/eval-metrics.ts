// scripts/frame-extraction/eval-metrics.ts
import type { ClusterAssignment, FilePair, ImportEdge } from "./types.js";

/** A pair-shape that's compatible with both FilePair (co-change) and
 *  ImportEdge (CALLS). The agreementScore function consumes either. */
type WeightedPair = { a: string; b: string };

/** Maps every file in a clustering to its cluster_id (including the
 *  noise cluster, which is `-1`). Files appearing in multiple clusters
 *  (shouldn't happen but defensively the LAST cluster wins) are last-
 *  write-wins. */
export function buildFileToClusterMap(clusters: ClusterAssignment[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of clusters) {
    for (const path of c.member_paths) {
      m.set(path, c.cluster_id);
    }
  }
  return m;
}

export function clusterCount(clusters: ClusterAssignment[]): number {
  return clusters.filter((c) => c.cluster_id !== -1).length;
}

export function noiseRate(clusters: ClusterAssignment[]): number {
  let total = 0;
  let noise = 0;
  for (const c of clusters) {
    total += c.member_paths.length;
    if (c.cluster_id === -1) noise += c.member_paths.length;
  }
  return total === 0 ? 0 : noise / total;
}

/** Two scoring rules for the agreement metric — both supported because
 *  they answer different questions:
 *
 *  - "strict" — drop pairs where either endpoint is in the noise cluster.
 *    The denominator is "of the pairs the algorithm was confident about,
 *    how many agreed?" Scores well on small clean cores even when most
 *    files are noise. Combine with `noise_rate` to interpret.
 *
 *  - "lenient" — count noise-touching pairs in the denominator but never
 *    in the numerator. The denominator is "of all frequently-coupled
 *    pairs, how many agreed?" A high `noise_rate` drags this down even
 *    if the clustered cores are clean. Closer to the spec's plain reading
 *    of "fraction of frequently-co-changing pairs landing in the same
 *    cluster" (a noise file does NOT land in a cluster). */
export type AgreementMode = "strict" | "lenient";

/** Fraction of `pairs` that landed in the same non-noise cluster.
 *  See `AgreementMode` for the two interpretations. Returns null if no
 *  scorable pair exists. */
export function agreementScore(
  pairs: readonly WeightedPair[],
  fileToCluster: Map<string, number>,
  mode: AgreementMode = "strict",
): number | null {
  let scorable = 0;
  let agree = 0;
  for (const p of pairs) {
    const ca = fileToCluster.get(p.a);
    const cb = fileToCluster.get(p.b);
    if (ca === undefined || cb === undefined) continue;
    if (ca === -1 || cb === -1) {
      if (mode === "lenient") scorable += 1;
      continue;
    }
    scorable += 1;
    if (ca === cb) agree += 1;
  }
  if (scorable === 0) return null;
  return agree / scorable;
}
