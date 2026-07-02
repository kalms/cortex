export interface HotspotArea {
  module: string;               // display name, e.g. "mcp-server"
  path: string;                 // repo-relative module path, e.g. "src/mcp-server"
  in_edges: number;             // score — external inbound fan-in
  nodes: number;                // annotation only
  governing_paths: number;      // count of active-decision GOVERNS path-refs resolving into this module (display annotation, not ranked)
}

export interface HotspotOpts {
  limit?: number;               // default 12
}

/** Node kinds counted as "symbols" for the nodes annotation. */
export const CODE_KINDS = new Set([
  "function", "class", "method", "interface", "type", "variable", "route", "channel",
]);
