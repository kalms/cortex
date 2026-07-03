/**
 * Directed counterpart to frame-pair-rollup: roll symbol-level CALLS/USAGE/
 * IMPORTS edges up to DIRECTED frame→frame flows plus per-frame fan-in/fan-out
 * totals. The undirected rollup feeds the layout's gravity force; this one
 * feeds layer classification (frame-kind.ts), where direction is the signal —
 * a frame that is mostly imported is substrate, a frame that mostly imports
 * is surface. Design: docs/architecture/frame-extraction.md ("Layer taxonomy").
 *
 * PURE — no I/O.
 */
import type { NodeRow, EdgeRow } from "../../graph/store.js";
import { buildNodeFrameIndex, ROLLUP_RELATIONS } from "./frame-pair-rollup.js";

export interface FrameFlow {
  from: number;
  to: number;
  /** Count of underlying symbol-level edges in this direction. */
  weight: number;
}

export interface FrameFlowStats {
  frame_id: number;
  /** Σ inbound inter-frame edge weight. */
  fanIn: number;
  /** Σ outbound inter-frame edge weight. */
  fanOut: number;
}

export function rollupFrameFlows(
  nodes: readonly NodeRow[],
  edges: readonly EdgeRow[],
): { flows: FrameFlow[]; stats: FrameFlowStats[] } {
  const frameById = buildNodeFrameIndex(nodes);

  // Every frame that exists gets a stats row, flows or not.
  const statsById = new Map<number, FrameFlowStats>();
  for (const fid of frameById.values()) {
    if (!statsById.has(fid)) statsById.set(fid, { frame_id: fid, fanIn: 0, fanOut: 0 });
  }

  const flowByKey = new Map<string, FrameFlow>();
  for (const e of edges) {
    if (!ROLLUP_RELATIONS.has(e.relation)) continue;
    const from = frameById.get(e.source_id);
    const to = frameById.get(e.target_id);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}:${to}`;
    let flow = flowByKey.get(key);
    if (!flow) {
      flow = { from, to, weight: 0 };
      flowByKey.set(key, flow);
    }
    flow.weight += 1;
    statsById.get(from)!.fanOut += 1;
    statsById.get(to)!.fanIn += 1;
  }

  const flows = [...flowByKey.values()].sort(
    (x, y) => y.weight - x.weight || x.from - y.from || x.to - y.to,
  );
  const stats = [...statsById.values()].sort((x, y) => x.frame_id - y.frame_id);
  return { flows, stats };
}
