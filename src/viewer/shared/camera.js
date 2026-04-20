/**
 * Pure camera state + transform math for the 2D viewer.
 *
 * Camera = { x, y, zoom }
 *   - x, y: world-space point that appears at the canvas center
 *   - zoom: scalar; 1 means 1:1 world-to-screen (clamped to [0.2, 5])
 *
 * The module is DOM-less; it operates on plain numbers. The entry file keeps
 * `camera` as mutable state and passes it to these helpers each frame.
 */

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 5;

export function createCamera() {
  return { x: 0, y: 0, zoom: 1 };
}

export function clampZoom(z) {
  if (z < ZOOM_MIN) return ZOOM_MIN;
  if (z > ZOOM_MAX) return ZOOM_MAX;
  return z;
}

/**
 * Forward transform: world point → screen pixel.
 *   screen = (world - camera) * zoom + (canvas / 2)
 */
export function worldToScreen(camera, wx, wy, canvasW, canvasH) {
  const sx = (wx - camera.x) * camera.zoom + canvasW / 2;
  const sy = (wy - camera.y) * camera.zoom + canvasH / 2;
  return [sx, sy];
}

/**
 * Inverse transform: screen pixel → world point.
 *   world = (screen - canvas / 2) / zoom + camera
 */
export function screenToWorld(camera, sx, sy, canvasW, canvasH) {
  const wx = (sx - canvasW / 2) / camera.zoom + camera.x;
  const wy = (sy - canvasH / 2) / camera.zoom + camera.y;
  return [wx, wy];
}

/**
 * Camera that frames every node in the iterable within `canvas` minus `padding`
 * on all sides. With 0 nodes returns identity; with 1 node, centers it at
 * zoom = 1. Zoom is clamped to [ZOOM_MIN, ZOOM_MAX].
 */
export function fitToBounds(nodes, canvasW, canvasH, padding = 40) {
  const arr = Array.isArray(nodes) ? nodes : [...nodes];
  if (arr.length === 0) return createCamera();
  if (arr.length === 1) {
    const n = arr[0];
    return { x: n.x ?? 0, y: n.y ?? 0, zoom: 1 };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of arr) {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const availW = Math.max(1, canvasW - 2 * padding);
  const availH = Math.max(1, canvasH - 2 * padding);
  const zoom = clampZoom(Math.min(availW / w, availH / h));
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom };
}

/**
 * Zoom by `factor` while keeping the world point currently under (sx, sy)
 * pinned under the same screen coordinate after the zoom.
 *
 * Derivation:
 *   world = (screen - W/2) / zoom + camera
 *   world_before = world_after → solve for new camera:
 *     camera_new = camera_old + (screen - W/2) * (1/zoom_old - 1/zoom_new)
 */
export function zoomAtPoint(camera, factor, sx, sy, canvasW, canvasH) {
  const newZoom = clampZoom(camera.zoom * factor);
  const dx = (sx - canvasW / 2) * (1 / camera.zoom - 1 / newZoom);
  const dy = (sy - canvasH / 2) * (1 / camera.zoom - 1 / newZoom);
  return { x: camera.x + dx, y: camera.y + dy, zoom: newZoom };
}

/**
 * Per-frame interpolation used for smooth recenter / focus-fit animations.
 * t = 0 → from, t = 1 → to, no clamping outside [0, 1] (caller's responsibility).
 */
export function lerpCamera(from, to, t) {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    zoom: from.zoom + (to.zoom - from.zoom) * t,
  };
}

/**
 * Camera state container used by the entry file. Wraps a camera with mode
 * (overview | focus) and a save slot for search return-to.
 */
export function createCameraState() {
  return {
    camera: createCamera(),
    mode: 'overview',
    saved: null,
  };
}

/** Snapshot the current camera for later restore. */
export function saveCamera(state) {
  state.saved = { x: state.camera.x, y: state.camera.y, zoom: state.camera.zoom };
}

/** Restore a previously-saved camera; no-op if none. Clears the slot. */
export function restoreCamera(state) {
  if (!state.saved) return;
  state.camera = state.saved;
  state.saved = null;
}
