// scripts/frame-extraction/graph-stats.ts
import { callIndexer } from "./indexer.js";
import type { GraphStats, IndexerEnvelope, NodeLabelCount } from "./types.js";

interface ArchitectureResponse {
  project: string;
  total_nodes: number;
  total_edges: number;
  node_labels: NodeLabelCount[];
}

const ENTITY_LABELS = new Set([
  "function", "class", "method", "interface", "type",
]);

export function deriveGraphStats(resp: ArchitectureResponse): GraphStats {
  const entity_count = resp.node_labels
    .filter(l => ENTITY_LABELS.has(l.label))
    .reduce((sum, l) => sum + l.count, 0);
  const edge_density = resp.total_nodes > 0
    ? resp.total_edges / resp.total_nodes
    : 0;
  return {
    total_nodes: resp.total_nodes,
    total_edges: resp.total_edges,
    edge_density,
    node_labels: resp.node_labels,
    entity_count,
  };
}

export function fetchGraphStats(project: string): IndexerEnvelope<GraphStats> {
  const env = callIndexer<ArchitectureResponse>("get_architecture", {
    aspects: ["structure"],
    project,
  });
  if (!env.ok) return env;
  return { ok: true, data: deriveGraphStats(env.data) };
}
