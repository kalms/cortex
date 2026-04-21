/**
 * Predicate used by the 2D viewer to decide whether a node "matches" the
 * current search query. Pure; name-only; case-insensitive; empty query is
 * treated as "match everything" so the caller can always multiply its output
 * through without a special-case.
 */
export function searchMatch(node, query) {
  if (!query) return true;
  const name = String(node && node.name ? node.name : '').toLowerCase();
  return name.includes(query.toLowerCase());
}

/**
 * Returns the subset of `nodes` whose name contains `query`
 * (case-insensitive). Empty query → empty array (no match = no camera move).
 */
export function findMatches(nodes, query) {
  if (!query) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const n of nodes) {
    const name = String(n && n.name ? n.name : '').toLowerCase();
    if (name.includes(q)) out.push(n);
  }
  return out;
}
