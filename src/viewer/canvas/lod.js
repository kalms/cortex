/**
 * Pure level-of-detail policy. The dot budget is driven by a frame's ON-SCREEN
 * area, so one rule yields both squeeze relief at fit view (dense scenes shed
 * per-frame dots — the activator fix) and progressive reveal as the camera
 * zooms (area grows ∝ zoom²). PX_PER_DOT is calibrated so a full-size
 * 150×120 frame at fit shows ≈22 dots — today's MAX_FRAME_NODES look.
 */
export const PX_PER_DOT = 800;
export const MIN_DOTS = 6;
export const LABEL_SPACING_MIN = 64;  // px between dots where file labels start
export const LABEL_SPACING_FULL = 96; // fully legible

export function dotBudget(frameAreaPx, memberCount) {
  if (memberCount <= 0) return 0;
  const byArea = Math.floor(frameAreaPx / PX_PER_DOT);
  return Math.max(Math.min(MIN_DOTS, memberCount), Math.min(memberCount, byArea));
}

export function labelAlpha(spacingPx) {
  if (spacingPx <= LABEL_SPACING_MIN) return 0;
  if (spacingPx >= LABEL_SPACING_FULL) return 1;
  return (spacingPx - LABEL_SPACING_MIN) / (LABEL_SPACING_FULL - LABEL_SPACING_MIN);
}

/** Sub-frame detail alpha during the below-fit elastic overscroll. */
export function shedAlpha(zoom) {
  if (zoom >= 1) return 1;
  const t = Math.max(0, (zoom - 0.8) / 0.2);
  return 0.35 + 0.65 * t;
}

/** Deadband so a budget hovering on a floor() boundary can't flicker. */
export function applyHysteresis(current, target) {
  return Math.abs(target - current) < 2 ? current : target;
}

/** Inter-frame edges recede as the camera zooms past fit — zoomed-in reading
 *  is local; long context edges otherwise dominate the viewport. */
export function interEdgeZoomFade(zoom) {
  if (zoom <= 1.25) return 1;
  return Math.max(0.3, 1.25 / zoom);
}
