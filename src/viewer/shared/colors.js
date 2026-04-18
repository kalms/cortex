/**
 * Palette + color math for the 2D viewer.
 *
 * Rest palette is greyscale-except-decision (decision = lavender); hover palette
 * introduces per-kind accent colors. The renderer lerps between the two based
 * on each node's `colorMix` animation state.
 */

export const BACKGROUND = '#09090b';
export const SURFACE = '#0d0d0d';

export const PALETTE_REST = {
  decision:  [180, 160, 224],
  file:      [102, 102, 102],
  function:  [ 85,  85,  85],
  component: [ 85,  85,  85],
  reference: [ 68,  68,  68],
  path:      [ 51,  51,  51],
};

export const PALETTE_HOVER = {
  decision:  [190, 170, 235],
  file:      [140, 200, 210],
  function:  [130, 170, 140],
  component: [160, 140, 180],
  reference: [140, 130, 160],
  path:      [100, 100, 100],
};

/** Edge base alpha at rest and when endpoint is highlighted. */
export const EDGE_ALPHA = {
  GOVERNS:     { rest: 0.05,  hover: 0.35 },
  CALLS:       { rest: 0.05,  hover: 0.35 },
  IMPORTS:     { rest: 0.035, hover: 0.35 },
  SUPERSEDES:  { rest: 0.05,  hover: 0.35 },
  REFERENCES:  { rest: 0.05,  hover: 0.35 },
  'co-changed':{ rest: 0.02,  hover: 0.25 },
};

/** Component-wise integer linear interpolation between two RGB triples. */
export function lerpRGB(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Format a color for canvas fillStyle/strokeStyle. */
export function rgbString(rgb, alpha = 1) {
  return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')';
}
