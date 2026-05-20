// src/mcp-server/api-edges.ts
/**
 * Adapter: aggregate entity-level edges (typically CALLS between
 * functions/methods) into file-level edges for the viewer. Pure —
 * no I/O, fully unit-testable.
 *
 * Input: all nodes + all edges for a project, as they come back from
 * `GraphStore.getAllNodesUnified` / `getAllEdgesUnified`.
 *
 * Output: one record per unordered (file_a, file_b) pair, with `weight`
 * = the count of underlying entity-level edges. Self-edges (both ends
 * in the same file) are dropped. Edges whose endpoints aren't in the
 * supplied `nodes` list are silently skipped.
 *
 * The viewer uses this to replace its prototype-era `Math.random()`
 * edge generator with real connectivity.
 */
import type { NodeRow, EdgeRow } from "../graph/store.js";

export interface FileEdge {
  /** Lexically smaller of the two file paths. */
  from_path: string;
  /** Lexically larger of the two file paths. */
  to_path: string;
  /** Number of underlying entity-level edges between these files. */
  weight: number;
}

export interface BuildFileEdgesOptions {
  /** Edge relations to include. Default `["CALLS"]` — the most semantically
   *  rich connectivity for the viewer's purpose. */
  relations?: readonly string[];
  /** Drop file-pairs with weight below this threshold. Default 2 — a
   *  single one-off call between two files is usually noise. */
  min_weight?: number;
}

const DEFAULT_RELATIONS: readonly string[] = ["CALLS"];
const DEFAULT_MIN_WEIGHT = 2;

export function buildFileEdges(
  nodes: readonly NodeRow[],
  edges: readonly EdgeRow[],
  options: BuildFileEdgesOptions = {},
): FileEdge[] {
  const relations = new Set(options.relations ?? DEFAULT_RELATIONS);
  const minWeight = options.min_weight ?? DEFAULT_MIN_WEIGHT;

  const pathById = new Map<string, string>();
  for (const n of nodes) {
    if (!n.file_path) continue;
    pathById.set(n.id, n.file_path);
  }

  const weights = new Map<string, number>();
  for (const e of edges) {
    if (!relations.has(e.relation)) continue;
    const a = pathById.get(e.source_id);
    const b = pathById.get(e.target_id);
    if (!a || !b) continue;
    if (a === b) continue;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${lo}\x00${hi}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }

  const out: FileEdge[] = [];
  for (const [key, weight] of weights) {
    if (weight < minWeight) continue;
    const sep = key.indexOf("\x00");
    out.push({
      from_path: key.slice(0, sep),
      to_path: key.slice(sep + 1),
      weight,
    });
  }
  out.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    if (a.from_path !== b.from_path) return a.from_path.localeCompare(b.from_path);
    return a.to_path.localeCompare(b.to_path);
  });
  return out;
}
