export interface HotspotArea {
  module: string;               // display name, e.g. "mcp-server"
  path: string;                 // repo-relative module path, e.g. "src/mcp-server"
  score: number;                // composite rank score, 0–100 (fan-in + decisions + todos, normalized)
  in_edges: number;            // external inbound fan-in (dependency signal)
  nodes: number;                // symbol count (annotation only, not scored)
  governing_decisions: number;  // distinct active decisions governing refs in this module (scored)
  open_todos: number;           // distinct non-terminal todos governing refs in this module (scored)
}

/** Relative weights for the composite score. Each defaults to 1 (equal weight). */
export interface HotspotWeights {
  fanIn?: number;
  decisions?: number;
  todos?: number;
}

export interface HotspotOpts {
  limit?: number;               // default 12
  weights?: HotspotWeights;     // composite-score weights; default all 1
}

/** Node kinds counted as "symbols" for the nodes annotation. */
export const CODE_KINDS = new Set([
  "function", "class", "method", "interface", "type", "variable", "route", "channel",
]);
