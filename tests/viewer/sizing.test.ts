import { describe, it, expect } from 'vitest';
import {
  SIZE,
  worldSize,
  sizeAt,
  groupWorldSize,
  edgeStrokeAt,
} from '../../src/viewer/shared/sizing.js';

describe('sizing', () => {
  describe('SIZE table', () => {
    it('has {world, min_px, max_px} for every known kind', () => {
      const kinds = ['decision', 'file', 'function', 'component', 'reference', 'path'];
      for (const k of kinds) {
        expect(SIZE[k]).toMatchObject({
          world: expect.any(Number),
          min_px: expect.any(Number),
          max_px: expect.any(Number),
        });
        expect(SIZE[k].min_px).toBeLessThan(SIZE[k].max_px);
      }
    });

    it('decisions have largest range, functions smallest', () => {
      expect(SIZE.decision.max_px).toBeGreaterThan(SIZE.file.max_px);
      expect(SIZE.file.max_px).toBeGreaterThan(SIZE.function.max_px);
    });
  });

  describe('worldSize', () => {
    it('returns SIZE[kind].world', () => {
      expect(worldSize('decision')).toBe(SIZE.decision.world);
      expect(worldSize('file')).toBe(SIZE.file.world);
    });

    it('falls back for unknown kind', () => {
      expect(worldSize('unknown')).toBeGreaterThan(0);
    });
  });

  describe('sizeAt', () => {
    it('returns s.world (unclamped) when the apparent size falls in [min_px, max_px]', () => {
      const s = SIZE.file;
      const midZoom = (s.min_px / s.world + s.max_px / s.world) / 2;
      // In the unclamped band, sizeAt returns the world-space radius (which is s.world);
      // the apparent screen-space size is sizeAt() * zoom.
      expect(sizeAt('file', midZoom)).toBeCloseTo(s.world, 5);
      expect(sizeAt('file', midZoom) * midZoom).toBeCloseTo(s.world * midZoom, 5);
    });

    it('clamps to min_px (in apparent screen space) at far zoom', () => {
      const tinyZoom = 0.01;
      const apparent = sizeAt('file', tinyZoom) * tinyZoom;
      expect(apparent).toBeCloseTo(SIZE.file.min_px, 5);
    });

    it('clamps to max_px (in apparent screen space) at close zoom', () => {
      const hugeZoom = 100;
      const apparent = sizeAt('file', hugeZoom) * hugeZoom;
      expect(apparent).toBeCloseTo(SIZE.file.max_px, 5);
    });

    it('ratios between kinds are stable within unclamped band', () => {
      // Pick a zoom where decision, file, and function are all unclamped.
      // Unclamped ranges: decision [1.4,2.2], file [1.4,2.4], function [2.0,3.2]
      // Intersection: [2.0, 2.2]
      const z = 2.1;
      const dec = sizeAt('decision', z);
      const file = sizeAt('file', z);
      const fn = sizeAt('function', z);
      expect(dec / file).toBeCloseTo(SIZE.decision.world / SIZE.file.world, 2);
      expect(file / fn).toBeCloseTo(SIZE.file.world / SIZE.function.world, 2);
    });
  });

  describe('groupWorldSize', () => {
    it('scales sublinearly with member count', () => {
      const s3 = groupWorldSize(3);
      const s30 = groupWorldSize(30);
      const s300 = groupWorldSize(300);
      expect(s30).toBeGreaterThan(s3);
      expect(s300).toBeGreaterThan(s30);
      // sublinear: 10x members < 2x size
      expect(s30 / s3).toBeLessThan(2);
    });

    it('has a minimum for 1-member groups', () => {
      expect(groupWorldSize(1)).toBeGreaterThan(0);
    });
  });

  describe('edgeStrokeAt', () => {
    it('GOVERNS never thins below its floor', () => {
      const tinyZoom = 0.01;
      const apparent = edgeStrokeAt('GOVERNS', tinyZoom) * tinyZoom;
      expect(apparent).toBeGreaterThan(0.4);
    });

    it('CALLS can thin more than GOVERNS at far zoom', () => {
      const z = 0.2;
      expect(edgeStrokeAt('GOVERNS', z)).toBeGreaterThan(edgeStrokeAt('CALLS', z));
    });
  });
});
