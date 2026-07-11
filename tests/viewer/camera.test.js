import { describe, it, expect } from "vitest";
import {
  createCamera, compose, zoomAt, panBy, settleTarget, lerpCamera, isIdentity,
  MAX_ZOOM, OVERSCROLL_MIN,
} from "../../src/viewer/canvas/camera.js";

describe("camera", () => {
  it("identity camera composes to the fit transform unchanged", () => {
    const fit = { scale: 0.7, ox: 120, oy: 40 };
    expect(compose(fit, createCamera())).toEqual(fit);
  });

  it("zoomAt keeps the scene point under the cursor fixed", () => {
    // screen = u * zoom + pan, where u is the fit-space px position.
    let cam = { zoom: 1.5, panX: 20, panY: -10 };
    const cursor = { x: 300, y: 200 };
    const u = { x: (cursor.x - cam.panX) / cam.zoom, y: (cursor.y - cam.panY) / cam.zoom };
    cam = zoomAt(cam, cursor.x, cursor.y, 1.4);
    expect(u.x * cam.zoom + cam.panX).toBeCloseTo(cursor.x, 6);
    expect(u.y * cam.zoom + cam.panY).toBeCloseTo(cursor.y, 6);
  });

  it("clamps zoom to [OVERSCROLL_MIN, MAX_ZOOM]", () => {
    expect(zoomAt(createCamera(), 0, 0, 100).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(createCamera(), 0, 0, 0.001).zoom).toBe(OVERSCROLL_MIN);
  });

  it("panBy offsets without touching zoom", () => {
    const cam = panBy({ zoom: 2, panX: 5, panY: 5 }, 10, -3);
    expect(cam).toEqual({ zoom: 2, panX: 15, panY: 2 });
  });

  it("settleTarget springs a below-fit camera back to identity", () => {
    expect(settleTarget({ zoom: 0.85, panX: 40, panY: 40 })).toEqual(createCamera());
    expect(settleTarget({ zoom: 1, panX: 40, panY: 40 })).toEqual(createCamera()); // fit floor: pan settles too
    const zoomed = { zoom: 2.2, panX: -100, panY: 30 };
    expect(settleTarget(zoomed)).toBe(zoomed);
  });

  it("lerpCamera interpolates and isIdentity detects the origin", () => {
    const mid = lerpCamera(createCamera(), { zoom: 3, panX: 100, panY: -50 }, 0.5);
    expect(mid).toEqual({ zoom: 2, panX: 50, panY: -25 });
    expect(isIdentity(createCamera())).toBe(true);
    expect(isIdentity(mid)).toBe(false);
  });
});
