// src/frame-extraction/frame-reclamation.ts
/**
 * Graph reclamation: assign HDBSCAN noise files to the topical cluster they are
 * most connected to via CALLS/USAGE/IMPORTS edges. The tf-idf token space leaves
 * ~30% of code files as noise even tuned aggressively, but those files carry rich
 * call/import structure into the clustered code (frame-coverage spec). This pass
 * rolls up symbol-level edges to the file level, sums per-cluster weight for each
 * noise file, and assigns it to the argmax cluster above a threshold. Reclaimed
 * files are tracked in `reclaimed_paths` so the ranker can keep nameability scored
 * on the topical core.
 *
 * PURE — no I/O.
 */
import type { NodeRow, EdgeRow } from "../graph/store.js";
import type { ClusterResult, ClusterAssignment } from "./types.js";

const RECLAIM_RELATIONS = new Set(["CALLS", "USAGE", "IMPORTS"]);
const DEFAULT_MIN_EDGES = 2;

export interface ReclaimOptions {
  /** Minimum rolled-up edge count to a cluster to reclaim a noise file. */
  minEdges?: number;
  /** Edge relations counted. Defaults to CALLS/USAGE/IMPORTS. */
  relations?: Iterable<string>;
}

export function reclaimNoise(
  cluster: ClusterResult,
  nodes: readonly NodeRow[],
  edges: readonly EdgeRow[],
  opts: ReclaimOptions = {},
): ClusterResult {
  const minEdges = opts.minEdges ?? DEFAULT_MIN_EDGES;
  const relations = new Set(opts.relations ?? RECLAIM_RELATIONS);

  const noise = cluster.clusters.find((c) => c.cluster_id === -1);
  if (!noise || noise.member_paths.length === 0) return cluster;
  const noiseSet = new Set(noise.member_paths);

  // file_path -> non-noise cluster id
  const clusterByPath = new Map<string, number>();
  for (const c of cluster.clusters) {
    if (c.cluster_id === -1) continue;
    for (const p of c.member_paths) clusterByPath.set(p, c.cluster_id);
  }

  // node id -> file_path
  const pathById = new Map<string, string>();
  for (const n of nodes) if (n.file_path) pathById.set(n.id, n.file_path);

  // noise file_path -> (cluster_id -> summed edge weight)
  const weights = new Map<string, Map<number, number>>();
  const bump = (noisePath: string, cid: number) => {
    let m = weights.get(noisePath);
    if (!m) { m = new Map(); weights.set(noisePath, m); }
    m.set(cid, (m.get(cid) ?? 0) + 1);
  };
  for (const e of edges) {
    if (!relations.has(e.relation)) continue;
    const pa = pathById.get(e.source_id);
    const pb = pathById.get(e.target_id);
    if (!pa || !pb || pa === pb) continue;
    const aNoise = noiseSet.has(pa);
    const bNoise = noiseSet.has(pb);
    if (aNoise && !bNoise) {
      const cid = clusterByPath.get(pb);
      if (cid !== undefined) bump(pa, cid);
    } else if (bNoise && !aNoise) {
      const cid = clusterByPath.get(pa);
      if (cid !== undefined) bump(pb, cid);
    }
  }

  // Decide assignments. argmax weight; tie-break lowest cluster_id.
  const reclaimedByCluster = new Map<number, string[]>();
  const stillNoise: string[] = [];
  for (const p of noise.member_paths) {
    const m = weights.get(p);
    if (!m) { stillNoise.push(p); continue; }
    let bestCid = -1;
    let bestW = -1;
    for (const [cid, w] of m) {
      if (w > bestW || (w === bestW && cid < bestCid)) { bestW = w; bestCid = cid; }
    }
    if (bestW >= minEdges) {
      const list = reclaimedByCluster.get(bestCid) ?? [];
      list.push(p);
      reclaimedByCluster.set(bestCid, list);
    } else {
      stillNoise.push(p);
    }
  }

  const newClusters: ClusterAssignment[] = [];
  for (const c of cluster.clusters) {
    if (c.cluster_id === -1) {
      if (stillNoise.length > 0) {
        newClusters.push({ ...c, member_paths: [...stillNoise].sort() });
      }
      continue;
    }
    const reclaimed = reclaimedByCluster.get(c.cluster_id);
    if (!reclaimed || reclaimed.length === 0) { newClusters.push(c); continue; }
    newClusters.push({
      ...c,
      member_paths: [...c.member_paths, ...reclaimed].sort(),
      reclaimed_paths: [...(c.reclaimed_paths ?? []), ...reclaimed].sort(),
    });
  }

  return { ...cluster, clusters: newClusters, noise_count: stillNoise.length };
}
