// src/viewer/canvas/layout-morph.js
/**
 * Pure layout-morph math for the viewer engine.
 *
 * Re-indexing recomputes the whole frame map, so a data swap can move every
 * frame at once — which reads as a hard "blip" between two layouts. A morph
 * interpolates each SURVIVING frame from where it was to where it now is, so a
 * re-index glides instead of cutting.
 *
 * Pure, like camera.js: no canvas, no clock, no engine state. The caller owns
 * `now` and the easing curve, so the engine's single `ease` stays the one source
 * of the motion feel and this module stays trivially testable.
 *
 * The morph is PRESENTATIONAL ONLY. The engine's FRAMES always holds the true
 * new layout; a morph merely changes what is drawn while it runs. Anything
 * asking the engine a question about the graph gets the settled answer.
 */

/** Morph window (ms). Longer than FOCUS_DURATION (550): a re-index can move a
 *  frame clear across the stage, and that travel needs time to read as motion
 *  rather than a jump. */
export const LAYOUT_MORPH_DURATION = 900;

/** Snapshot the geometry of a frame list into an id → {x,y,w,h} map. Positions
 *  are normalized stage coords, sizes reference-stage px — whatever the caller
 *  holds; this module only interpolates. */
export function captureGeometry(frames) {
  return new Map((frames || []).map((f) => [f.id, { x: f.x, y: f.y, w: f.w, h: f.h }]));
}

/** True when at least one frame present in BOTH layouts changed geometry. A
 *  pure arrival/departure is not a morph — there is nothing to interpolate
 *  between — so a resync that only adds or drops frames stays visually inert. */
export function geometryChanged(from, frames) {
  for (const f of frames || []) {
    const p = from.get(f.id);
    if (p && (p.x !== f.x || p.y !== f.y || p.w !== f.w || p.h !== f.h)) return true;
  }
  return false;
}

/**
 * Start a morph from the previous geometry into `frames`, or return null when
 * there is nothing to animate: a first load (no previous frames), a no-op
 * resync (nothing moved), or reduced-motion (snap, consistent with every other
 * transition in the engine).
 */
export function beginMorph(from, frames, now, { reducedMotion = false } = {}) {
  if (reducedMotion || !from || from.size === 0) return null;
  if (!geometryChanged(from, frames)) return null;
  return { t0: now, from };
}

/** Morph progress in [0,1]; 1 once the window has elapsed. */
export function morphProgress(morph, now) {
  if (!morph) return 1;
  return Math.min(1, Math.max(0, (now - morph.t0) / LAYOUT_MORPH_DURATION));
}

/** Still running at `now`? The engine's render loop uses this to stay hot. */
export function morphActive(morph, now) {
  return !!morph && morphProgress(morph, now) < 1;
}

/**
 * Geometry for one frame at `now`, eased between its previous and current
 * values. Returns the frame object ITSELF (not a copy) whenever there is
 * nothing to interpolate — no morph, a frame absent from the previous layout
 * (it is new; the reveal/birth treatments cover its entrance), or a settled
 * morph. That keeps the steady state allocation-free and exactly untouched.
 */
export function morphGeom(morph, frame, now, ease) {
  if (!morph) return frame;
  const prev = morph.from.get(frame.id);
  if (!prev) return frame;
  const t = morphProgress(morph, now);
  if (t >= 1) return frame;
  const e = ease(t);
  return {
    x: prev.x + (frame.x - prev.x) * e,
    y: prev.y + (frame.y - prev.y) * e,
    w: prev.w + (frame.w - prev.w) * e,
    h: prev.h + (frame.h - prev.h) * e,
  };
}
