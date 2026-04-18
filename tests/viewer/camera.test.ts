import { describe, it, expect } from 'vitest';
import {
  createCamera,
  clampZoom,
  screenToWorld,
  worldToScreen,
  fitToBounds,
  zoomAtPoint,
  lerpCamera,
} from '../../src/viewer/shared/camera.js';

describe('camera', () => {
  it('createCamera returns identity', () => {
    expect(createCamera()).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('clampZoom clamps to [0.2, 5]', () => {
    expect(clampZoom(0.1)).toBe(0.2);
    expect(clampZoom(0.2)).toBe(0.2);
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(5)).toBe(5);
    expect(clampZoom(10)).toBe(5);
  });

  it('worldToScreen: identity camera maps world origin to canvas center', () => {
    const [sx, sy] = worldToScreen(createCamera(), 0, 0, 400, 300);
    expect(sx).toBe(200);
    expect(sy).toBe(150);
  });

  it('worldToScreen / screenToWorld round-trip for arbitrary camera', () => {
    const cam = { x: 50, y: -30, zoom: 2 };
    const [sx, sy] = worldToScreen(cam, 10, 20, 400, 300);
    const [wx, wy] = screenToWorld(cam, sx, sy, 400, 300);
    expect(wx).toBeCloseTo(10);
    expect(wy).toBeCloseTo(20);
  });

  it('screenToWorld at canvas center returns camera.x, camera.y', () => {
    const [wx, wy] = screenToWorld({ x: 42, y: -17, zoom: 1 }, 200, 150, 400, 300);
    expect(wx).toBeCloseTo(42);
    expect(wy).toBeCloseTo(-17);
  });

  it('fitToBounds: 0 nodes → identity camera', () => {
    expect(fitToBounds([], 400, 300)).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('fitToBounds: 1 node → centered on that node at zoom=1', () => {
    expect(fitToBounds([{ x: 50, y: -10 }], 400, 300)).toEqual({ x: 50, y: -10, zoom: 1 });
  });

  it('fitToBounds: many nodes → centered on bbox center, zoom fits within padding', () => {
    const cam = fitToBounds([
      { x: -100, y: -100 },
      { x: 100, y: 100 },
    ], 500, 400, 40);
    expect(cam.x).toBe(0);
    expect(cam.y).toBe(0);
    // width 200 in canvas 500 with 40 padding each side → zoomX = 420/200 = 2.1
    // height 200 in canvas 400 with 40 padding each side → zoomY = 320/200 = 1.6
    // min = 1.6
    expect(cam.zoom).toBeCloseTo(1.6);
  });

  it('fitToBounds clamps zoom to [0.2, 5]', () => {
    const tiny = fitToBounds([{ x: 0, y: 0 }, { x: 0.01, y: 0.01 }], 400, 300, 40);
    expect(tiny.zoom).toBeLessThanOrEqual(5);
    const huge = fitToBounds([{ x: -100000, y: -100000 }, { x: 100000, y: 100000 }], 400, 300, 40);
    expect(huge.zoom).toBeGreaterThanOrEqual(0.2);
  });

  it('zoomAtPoint: world point under cursor stays under cursor', () => {
    const cam = { x: 0, y: 0, zoom: 1 };
    const canvasW = 400, canvasH = 300;
    const cursorX = 300, cursorY = 100;
    const [wxBefore, wyBefore] = screenToWorld(cam, cursorX, cursorY, canvasW, canvasH);
    const zoomed = zoomAtPoint(cam, 2, cursorX, cursorY, canvasW, canvasH);
    const [wxAfter, wyAfter] = screenToWorld(zoomed, cursorX, cursorY, canvasW, canvasH);
    expect(wxAfter).toBeCloseTo(wxBefore);
    expect(wyAfter).toBeCloseTo(wyBefore);
    expect(zoomed.zoom).toBe(2);
  });

  it('zoomAtPoint: clamps at max', () => {
    const cam = zoomAtPoint({ x: 0, y: 0, zoom: 4 }, 3, 200, 150, 400, 300);
    expect(cam.zoom).toBe(5);
  });

  it('zoomAtPoint: clamps at min', () => {
    const cam = zoomAtPoint({ x: 0, y: 0, zoom: 0.3 }, 0.1, 200, 150, 400, 300);
    expect(cam.zoom).toBe(0.2);
  });

  it('lerpCamera: endpoints and midpoint', () => {
    const a = { x: 0, y: 0, zoom: 1 };
    const b = { x: 100, y: -50, zoom: 2 };
    expect(lerpCamera(a, b, 0)).toEqual(a);
    expect(lerpCamera(a, b, 1)).toEqual(b);
    expect(lerpCamera(a, b, 0.5)).toEqual({ x: 50, y: -25, zoom: 1.5 });
  });
});
