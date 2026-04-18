import { describe, it, expect } from 'vitest';
import {
  PALETTE_REST,
  PALETTE_HOVER,
  BACKGROUND,
  lerpRGB,
  rgbString,
} from '../../src/viewer/shared/colors.js';

describe('colors', () => {
  it('palettes define every known kind', () => {
    const kinds = ['decision', 'file', 'function', 'component', 'reference', 'path'];
    for (const k of kinds) {
      expect(PALETTE_REST[k]).toHaveLength(3);
      expect(PALETTE_HOVER[k]).toHaveLength(3);
    }
  });

  it('decision lavender at rest matches spec', () => {
    expect(PALETTE_REST.decision).toEqual([180, 160, 224]);
  });

  it('lerpRGB endpoints return endpoint colors', () => {
    expect(lerpRGB([0, 0, 0], [100, 200, 50], 0)).toEqual([0, 0, 0]);
    expect(lerpRGB([0, 0, 0], [100, 200, 50], 1)).toEqual([100, 200, 50]);
  });

  it('lerpRGB midpoint rounds componentwise', () => {
    expect(lerpRGB([0, 0, 0], [100, 200, 50], 0.5)).toEqual([50, 100, 25]);
  });

  it('rgbString defaults to alpha 1 and emits rgba()', () => {
    expect(rgbString([10, 20, 30])).toBe('rgba(10,20,30,1)');
    expect(rgbString([10, 20, 30], 0.5)).toBe('rgba(10,20,30,0.5)');
  });

  it('background constant is defined', () => {
    expect(BACKGROUND).toBe('#09090b');
  });
});
