// src/frame-extraction/positioning/frame-pair-rollup.ts
/**
 * Roll symbol-level connectivity up to frame-pair weights for the layout's
 * import-neighbourhood force. Mirrors the file_path→frame_id approach used by
 * `buildFileEdges` (api-edges.ts): every node — file OR symbol — carries the
 * file_path of its defining file, so a node→frame lookup needs no DEFINES
 * traversal. Self-edges within a frame and edges touching a frameless file are
 * excluded (spec "Risks / open questions").
 *
 * PURE — no I/O.
 */
import type { NodeRow, EdgeRow } from "../../graph/store.js";

/** Relations rolled up into frame-pair affinity (spec §B force 1). */
export const ROLLUP_RELATIONS = new Set(["CALLS", "USAGE", "IMPORTS"]);

export interface FramePairWeight {
  /** Smaller frame_id. */
  a: number;
  /** Larger frame_id. */
  b: number;
  /** Count of underlying symbol-level edges between the two frames. */
  weight: number;
}

/** Map every node id → the frame_id of its defining file (via file_path).
 *  Nodes whose file carries no frame_id are omitted. */
export function buildNodeFrameIndex(nodes: readonly NodeRow[]): Map<string, number> {
  const frameByPath = new Map<string, number>();
  for (const n of nodes) {
    if (n.kind !== "file" || !n.file_path) continue;
    try {
      const d = JSON.parse(n.data) as { frame_id?: number };
      if (typeof d.frame_id === "number") frameByPath.set(n.file_path, d.frame_id);
    } catch {
      /* malformed data — skip */
    }
  }
  const frameById = new Map<string, number>();
  for (const n of nodes) {
    if (!n.file_path) continue;
    const fid = frameByPath.get(n.file_path);
    if (fid !== undefined) frameById.set(n.id, fid);
  }
  return frameById;
}

/** Aggregate CALLS/USAGE/IMPORTS edges into deterministic frame-pair weights. */
export function rollupFramePairs(
  nodes: readonly NodeRow[],
  edges: readonly EdgeRow[],
): FramePairWeight[] {
  const frameById = buildNodeFrameIndex(nodes);
  const weights = new Map<string, number>();
  for (const e of edges) {
    if (!ROLLUP_RELATIONS.has(e.relation)) continue;
    const fa = frameById.get(e.source_id);
    const fb = frameById.get(e.target_id);
    if (fa === undefined || fb === undefined) continue;
    if (fa === fb) continue; // intra-frame edge: no inter-frame pull
    const [lo, hi] = fa < fb ? [fa, fb] : [fb, fa];
    const key = `${lo}:${hi}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }
  const out: FramePairWeight[] = [];
  for (const [key, weight] of weights) {
    const sep = key.indexOf(":");
    out.push({ a: Number(key.slice(0, sep)), b: Number(key.slice(sep + 1)), weight });
  }
  out.sort((x, y) => y.weight - x.weight || x.a - y.a || x.b - y.b);
  return out;
}
