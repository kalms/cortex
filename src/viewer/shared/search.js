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
