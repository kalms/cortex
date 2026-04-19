import { describe, it, expect } from 'vitest';
import {
  drawDiamond,
  drawCircle,
  drawPill,
  drawHex,
  drawTri,
  drawStrike,
} from '../../src/viewer/shared/shapes.js';
import { drawRoundedRect, drawHull, SHAPE_FOR_KIND } from '../../src/viewer/shared/shapes.js';

function mockCtx() {
  const calls: Array<[string, ...unknown[]]> = [];
  const rec = (n: string) => (...args: unknown[]) => { calls.push([n, ...args]); };
  const ctx = {
    calls,
    beginPath: rec('beginPath'),
    moveTo:    rec('moveTo'),
    lineTo:    rec('lineTo'),
    closePath: rec('closePath'),
    arc:       rec('arc'),
    fill:      rec('fill'),
    stroke:    rec('stroke'),
    save:      rec('save'),
    restore:   rec('restore'),
    translate: rec('translate'),
    rotate:    rec('rotate'),
    _fill: '', _stroke: '', _lw: 0,
    set fillStyle(v: string)   { this._fill   = v; calls.push(['fillStyle=', v]); },
    set strokeStyle(v: string) { this._stroke = v; calls.push(['strokeStyle=', v]); },
    set lineWidth(v: number)   { this._lw     = v; calls.push(['lineWidth=', v]); },
  };
  return ctx;
}

describe('shapes', () => {
  it('drawCircle: arc + fill', () => {
    const ctx = mockCtx();
    drawCircle(ctx as any, 10, 20, 5, 'rgba(1,1,1,1)');
    const names = ctx.calls.map(c => c[0]);
    expect(names).toContain('arc');
    expect(names).toContain('fill');
    expect(ctx._fill).toBe('rgba(1,1,1,1)');
  });

  it('drawDiamond: 4 lineTo calls + closePath', () => {
    const ctx = mockCtx();
    drawDiamond(ctx as any, 0, 0, 8, 'rgba(180,160,224,1)');
    const lineTos = ctx.calls.filter(c => c[0] === 'lineTo');
    expect(lineTos.length).toBe(3); // moveTo + 3 lineTo + closePath = 4 vertices
    expect(ctx.calls.some(c => c[0] === 'closePath')).toBe(true);
  });

  it('drawHex: 5 lineTo calls + closePath (6 vertices)', () => {
    const ctx = mockCtx();
    drawHex(ctx as any, 0, 0, 5, 'rgba(68,68,68,1)');
    const lineTos = ctx.calls.filter(c => c[0] === 'lineTo');
    expect(lineTos.length).toBe(5);
  });

  it('drawTri: 2 lineTo calls + closePath (3 vertices)', () => {
    const ctx = mockCtx();
    drawTri(ctx as any, 0, 0, 4, 'rgba(51,51,51,1)');
    const lineTos = ctx.calls.filter(c => c[0] === 'lineTo');
    expect(lineTos.length).toBe(2);
  });

  it('drawPill: two arcs (caps) + lineTos (sides)', () => {
    const ctx = mockCtx();
    drawPill(ctx as any, 0, 0, 4, 'rgba(85,85,85,1)');
    const arcs = ctx.calls.filter(c => c[0] === 'arc');
    expect(arcs.length).toBe(2);
    expect(ctx.calls.some(c => c[0] === 'fill')).toBe(true);
  });

  it('drawStrike: diagonal line across node', () => {
    const ctx = mockCtx();
    drawStrike(ctx as any, 0, 0, 8, 'rgba(255,255,255,0.6)');
    expect(ctx.calls.some(c => c[0] === 'moveTo')).toBe(true);
    expect(ctx.calls.some(c => c[0] === 'lineTo')).toBe(true);
    expect(ctx.calls.some(c => c[0] === 'stroke')).toBe(true);
  });

  it('fillStyle is set before fill()', () => {
    const ctx = mockCtx();
    drawCircle(ctx as any, 0, 0, 3, 'rgba(1,2,3,0.4)');
    const fillIdx = ctx.calls.findIndex(c => c[0] === 'fill');
    const fillStyleIdx = ctx.calls.findIndex(c => c[0] === 'fillStyle=');
    expect(fillStyleIdx).toBeGreaterThanOrEqual(0);
    expect(fillStyleIdx).toBeLessThan(fillIdx);
  });
});

describe('drawRoundedRect', () => {
  it('draws a filled rect with arcTo corners and fill style', () => {
    const calls: string[] = [];
    const ctx: any = {
      beginPath: () => calls.push('beginPath'),
      moveTo:    () => calls.push('moveTo'),
      lineTo:    () => calls.push('lineTo'),
      arcTo:     () => calls.push('arcTo'),
      closePath: () => calls.push('closePath'),
      fill:      () => calls.push('fill'),
      stroke:    () => calls.push('stroke'),
      set fillStyle(v) { calls.push(`fill=${v}`); },
      set strokeStyle(v) { calls.push(`stroke=${v}`); },
    };
    drawRoundedRect(ctx, 0, 0, 10, '#abc');
    expect(calls).toContain('beginPath');
    expect(calls).toContain('fill=#abc');
    expect(calls).toContain('fill');
    expect(calls.filter((c) => c === 'arcTo').length).toBeGreaterThanOrEqual(4);
  });
});

describe('drawHull', () => {
  it('draws a convex hull polygon for 3+ points', () => {
    const calls: string[] = [];
    const ctx: any = {
      beginPath: () => calls.push('beginPath'),
      moveTo:    () => calls.push('moveTo'),
      lineTo:    () => calls.push('lineTo'),
      closePath: () => calls.push('closePath'),
      fill:      () => calls.push('fill'),
      stroke:    () => calls.push('stroke'),
      set fillStyle(v) { calls.push(`fill=${v}`); },
      set strokeStyle(v) { calls.push(`stroke=${v}`); },
      set lineWidth(v) {},
    };
    const points = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ];
    drawHull(ctx, points, 'rgba(100,100,200,0.1)', 'rgba(100,100,200,0.8)');
    expect(calls).toContain('beginPath');
    expect(calls).toContain('closePath');
    expect(calls).toContain('fill');
    expect(calls).toContain('stroke');
  });

  it('does nothing for fewer than 3 points', () => {
    const calls: string[] = [];
    const ctx: any = {
      beginPath: () => calls.push('beginPath'),
      moveTo:    () => calls.push('moveTo'),
      fill:      () => calls.push('fill'),
      stroke:    () => calls.push('stroke'),
      set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {},
    };
    drawHull(ctx, [{ x: 0, y: 0 }, { x: 1, y: 1 }], '#fff', '#fff');
    expect(calls).toEqual([]);
  });
});

describe('SHAPE_FOR_KIND', () => {
  it('includes group kind pointing to drawRoundedRect', () => {
    expect(SHAPE_FOR_KIND.group).toBe(drawRoundedRect);
  });
});
