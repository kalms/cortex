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

/** Fraction of `pairs` (where both endpoints appear in the clustering
 *  AND are non-noise) that landed in the same non-noise cluster.
 *  Returns null if no scorable pair exists. */
export function agreementScore(
  pairs: readonly WeightedPair[],
  fileToCluster: Map<string, number>,
): number | null {
  let scorable = 0;
  let agree = 0;
  for (const p of pairs) {
    const ca = fileToCluster.get(p.a);
    const cb = fileToCluster.get(p.b);
    if (ca === undefined || cb === undefined) continue;
    if (ca === -1 || cb === -1) continue;
    scorable += 1;
    if (ca === cb) agree += 1;
  }
  if (scorable === 0) return null;
  return agree / scorable;
}
