// src/viewer/canvas/camera.js
/**
 * Pure camera math for the viewer engine. The camera acts on the engine's
 * fit-space OUTPUT: screen = fitPx * zoom + pan. Composing at that single
 * point means identity (zoom 1, pan 0) reproduces the fit-to-content render
 * exactly, and every existing draw/hit-test path inherits the camera for free.
 *
 * Fit is the floor state: zooming out below 1 is a transient elastic
 * overscroll; settleTarget() is where the gesture-end spring lands.
 */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const OVERSCROLL_MIN = 0.8;

export function createCamera() { return { zoom: 1, panX: 0, panY: 0 }; }

export function isIdentity(cam) {
  return cam.zoom === 1 && cam.panX === 0 && cam.panY === 0;
}

export function compose(fit, cam) {
  return {
    scale: fit.scale * cam.zoom,
    ox: fit.ox * cam.zoom + cam.panX,
    oy: fit.oy * cam.zoom + cam.panY,
  };
}

export function zoomAt(cam, cursorX, cursorY, factor) {
  const zoom = Math.min(MAX_ZOOM, Math.max(OVERSCROLL_MIN, cam.zoom * factor));
  const r = zoom / cam.zoom;
  return {
    zoom,
    panX: cursorX - (cursorX - cam.panX) * r,
    panY: cursorY - (cursorY - cam.panY) * r,
  };
}

export function panBy(cam, dx, dy) {
  return { zoom: cam.zoom, panX: cam.panX + dx, panY: cam.panY + dy };
}

/** Where an out-of-bounds camera settles when the gesture ends. At or below
 *  the fit floor the ONLY resting state is identity (a leftover pan at fit
 *  would leave the scene off-center with no visual cue why). */
export function settleTarget(cam) {
  if (cam.zoom <= MIN_ZOOM) return createCamera();
  return cam;
}

export function lerpCamera(a, b, t) {
  return {
    zoom: a.zoom + (b.zoom - a.zoom) * t,
    panX: a.panX + (b.panX - a.panX) * t,
    panY: a.panY + (b.panY - a.panY) * t,
  };
}
