/**
 * Pure ranker for search_graph results. No I/O — mirrors frame-ranker.ts.
 *
 * score = KIND_WEIGHT[kind] × nameMatchQuality(name, query)
 *
 * Sort is total and deterministic (score desc → shorter name → qualified_name
 * asc), so paginated calls over the same match set return a stable ordering.
 *
 * Forward-compat: a `layerWeight` argument can be added later (P2.1, frame/
 * layer-aware ranking) without changing existing call sites.
 */
import type { IndexerNode } from "./code-queries.js";

export const KIND_WEIGHT: Record<string, number> = {
  route: 1.0, function: 0.95, class: 0.95, method: 0.9,
  interface: 0.75, type: 0.75,
  module: 0.55, file: 0.5, folder: 0.45, variable: 0.5,
  channel: 0.4, anchor: 0.35,
  section: 0.1,
};
const DEFAULT_KIND_WEIGHT = 0.5;

/** Match quality of a node name against the search query.
 *  Absent query (qn-only search) → neutral 1. */
export function nameMatchQuality(name: string, query?: string): number {
  if (!query) return 1;
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n === q) return 1.0;
  if (n.startsWith(q)) return 0.7;
  return 0.4;
}

export function scoreNode(node: IndexerNode, query?: string): number {
  const w = KIND_WEIGHT[node.kind] ?? DEFAULT_KIND_WEIGHT;
  return w * nameMatchQuality(node.name, query);
}

/** Returns a new array sorted by relevance; never mutates the input. */
export function rankNodes(nodes: IndexerNode[], query?: string): IndexerNode[] {
  return [...nodes].sort((a, b) => {
    const sb = scoreNode(b, query) - scoreNode(a, query);
    if (sb !== 0) return sb;
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.qualified_name < b.qualified_name ? -1 : a.qualified_name > b.qualified_name ? 1 : 0;
  });
}
