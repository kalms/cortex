/**
 * Per-kind sizing model for the 2D viewer.
 *
 * Each kind has a `world` size (used by d3-force collide/link distance —
 * constant across zoom for stable physics), and a screen-space range
 * [min_px, max_px] that bounds the apparent on-screen radius.
 *
 * `sizeAt(kind, zoom)` returns a world-space radius such that
 * `returnedRadius * zoom` falls inside [min_px, max_px]. The render divides
 * by zoom after clamping so the draw call operates in world space.
 */

export const SIZE = {
  decision:  { world: 10,  min_px: 14, max_px: 22 },
  file:      { world: 5,   min_px: 7,  max_px: 12 },
  component: { world: 4.5, min_px: 6,  max_px: 11 },
  reference: { world: 3,   min_px: 5,  max_px: 9  },
  function:  { world: 2.5, min_px: 5,  max_px: 8  },
  path:      { world: 2.5, min_px: 5,  max_px: 8  },
  group:     { world: 8,   min_px: 12, max_px: 26 },
};

const DEFAULT_SIZE = { world: 4, min_px: 5, max_px: 10 };

export function worldSize(kind) {
  return (SIZE[kind] ?? DEFAULT_SIZE).world;
}

export function sizeAt(kind, zoom) {
  const s = SIZE[kind] ?? DEFAULT_SIZE;
  const apparent = clamp(s.world * zoom, s.min_px, s.max_px);
  return apparent / zoom;
}

export function groupWorldSize(memberCount) {
  return 4 + 2 * Math.log2(Math.max(1, memberCount));
}

// Edge stroke ranges by relation. Values are screen-space px.
const EDGE_STROKE = {
  GOVERNS:      { world: 0.8, min_px: 0.6, max_px: 2.4 },
  SUPERSEDES:   { world: 0.8, min_px: 0.5, max_px: 2.0 },
  CALLS:        { world: 0.5, min_px: 0.3, max_px: 1.6 },
  IMPORTS:      { world: 0.5, min_px: 0.3, max_px: 1.6 },
  REFERENCES:   { world: 0.4, min_px: 0.3, max_px: 1.4 },
  'co-changed': { world: 0.3, min_px: 0.2, max_px: 1.0 },
};
const DEFAULT_EDGE = { world: 0.5, min_px: 0.3, max_px: 1.6 };

export function edgeStrokeAt(relation, zoom) {
  const s = EDGE_STROKE[relation] ?? DEFAULT_EDGE;
  const apparent = clamp(s.world * zoom, s.min_px, s.max_px);
  return apparent / zoom;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
