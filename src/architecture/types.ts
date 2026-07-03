export interface HotspotArea {
  module: string;               // display name, e.g. "mcp-server"
  path: string;                 // repo-relative module path, e.g. "src/mcp-server"
  in_edges: number;             // score — external inbound fan-in
  nodes: number;                // annotation only
  governing_decisions: number;  // distinct active decisions governing refs in this module (annotation, not ranked)
  open_todos: number;           // distinct non-terminal todos governing refs in this module (annotation, not ranked)
}

export interface HotspotOpts {
  limit?: number;               // default 12
}

/** Node kinds counted as "symbols" for the nodes annotation. */
export const CODE_KINDS = new Set([
  "function", "class", "method", "interface", "type", "variable", "route", "channel",
]);
