/**
 * Pure graph state for the 2D viewer.
 *
 * State is a plain object with two Maps: `nodes` (id → WireNode) and `edges`
 * (edgeKey → WireEdge). `version` is incremented on every applyMutation call;
 * render-loop code can compare versions to decide whether a redraw is needed.
 *
 * This module has no DOM dependency; it is the unit-testable core of the viewer.
 */

export function createGraphState() {
  return {
    nodes: new Map(),
    edges: new Map(),
    version: 0,
  };
}

/**
 * Canonical key for an edge: source→target:relation. A node pair can have
 * multiple edges of different relations; the relation must be part of the key.
 */
export function edgeKey(edge) {
  return edge.source_id + '→' + edge.target_id + ':' + edge.relation;
}

/**
 * Seed state from a /api/graph response. Call once on boot, before the first
 * WS mutation is applied.
 */
export function hydrate(state, graph) {
  for (const node of graph.nodes) state.nodes.set(node.id, node);
  for (const edge of graph.edges) state.edges.set(edgeKey(edge), edge);
}

/**
 * Apply a single GraphMutation to state. Bumps `version` by one on every call,
 * including no-op updates (keeps downstream change-detection simple).
 */
export function applyMutation(state, m) {
  state.version++;
  switch (m.op) {
    case 'add_node':
      state.nodes.set(m.node.id, m.node);
      return;
    case 'update_node': {
      const existing = state.nodes.get(m.id);
      if (existing) state.nodes.set(m.id, { ...existing, ...m.fields });
      return;
    }
    case 'remove_node':
      state.nodes.delete(m.id);
      for (const [k, e] of state.edges) {
        if (e.source_id === m.id || e.target_id === m.id) state.edges.delete(k);
      }
      return;
    case 'add_edge':
      state.edges.set(edgeKey(m.edge), m.edge);
      return;
    case 'remove_edge':
      state.edges.delete(
        edgeKey({ source_id: m.source, target_id: m.target, relation: m.relation }),
      );
      return;
  }
}
