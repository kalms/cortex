import { describe, it, expect } from 'vitest';
import {
  nodeSize,
  nodeCharge,
  linkDistance,
  linkStrength,
  createSimulation,
  forceBoundary,
  forceGroup,
  forceGovernance,
} from '../../src/viewer/shared/layout.js';

describe('layout', () => {
  describe('nodeSize', () => {
    it('returns per-kind world sizes from sizing module', () => {
      expect(nodeSize('decision')).toBe(10);
      expect(nodeSize('file')).toBe(5);
      expect(nodeSize('function')).toBe(2.5);
    });

    it('accepts a node object too', () => {
      expect(nodeSize({ kind: 'file' })).toBe(5);
    });

    it('uses groupWorldSize for group nodes', () => {
      const small = nodeSize({ kind: 'group', memberCount: 2 });
      const big   = nodeSize({ kind: 'group', memberCount: 64 });
      expect(big).toBeGreaterThan(small);
    });

    it('falls back for unknown kinds', () => {
      expect(nodeSize('unknown')).toBeGreaterThan(0);
    });
  });

  describe('nodeCharge', () => {
    it('decisions repel more than files, files more than functions', () => {
      expect(Math.abs(nodeCharge({ kind: 'decision' })))
        .toBeGreaterThan(Math.abs(nodeCharge({ kind: 'file' })));
      expect(Math.abs(nodeCharge({ kind: 'file' })))
        .toBeGreaterThan(Math.abs(nodeCharge({ kind: 'function' })));
    });

    it('returns negative (repulsive) values per spec', () => {
      expect(nodeCharge({ kind: 'decision' })).toBeLessThan(0);
      expect(nodeCharge({ kind: 'file' })).toBeLessThan(0);
    });
  });

  describe('linkDistance', () => {
    it('GOVERNS shorter than CALLS, CALLS shorter than IMPORTS, IMPORTS shorter than co-changed', () => {
      const g = linkDistance({ relation: 'GOVERNS' });
      const c = linkDistance({ relation: 'CALLS' });
      const i = linkDistance({ relation: 'IMPORTS' });
      const cc = linkDistance({ relation: 'co-changed' });
      expect(g).toBeLessThanOrEqual(c);
      expect(c).toBeLessThan(i);
      expect(i).toBeLessThan(cc);
    });

    it('has a fallback for unknown relations', () => {
      expect(linkDistance({ relation: 'UNKNOWN' })).toBeGreaterThan(0);
    });
  });

  describe('linkStrength', () => {
    it('GOVERNS strongest, co-changed weakest', () => {
      expect(linkStrength({ relation: 'GOVERNS' }))
        .toBeGreaterThan(linkStrength({ relation: 'CALLS' }));
      expect(linkStrength({ relation: 'co-changed' }))
        .toBeLessThan(linkStrength({ relation: 'IMPORTS' }));
    });
  });

  describe('createSimulation', () => {
    it('returns a running d3 simulation with configured forces', () => {
      const sim = createSimulation();
      expect(sim.force('link')).toBeTruthy();
      expect(sim.force('charge')).toBeTruthy();
      expect(sim.force('center')).toBeTruthy();
      expect(sim.force('collide')).toBeTruthy();
      sim.stop();
    });

    it('center force strength is > 0.05 (pinned — emergent disk requires a real center pull)', () => {
      const sim = createSimulation();
      expect(sim.force('center').strength()).toBeGreaterThan(0.05);
      sim.stop();
    });
  });

  describe('forceBoundary', () => {
    it('applies zero force to a node inside the radius', () => {
      const n = { x: 50, y: 0, vx: 0, vy: 0 };
      const f = forceBoundary(100, 1.0, 0, 0);
      f.initialize([n]);
      f(0.5); // alpha = 0.5
      expect(n.vx).toBe(0);
      expect(n.vy).toBe(0);
    });

    it('applies inward spring force to a node outside the radius', () => {
      const n = { x: 200, y: 0, vx: 0, vy: 0 };  // 100 units outside R=100
      const f = forceBoundary(100, 1.0, 0, 0);
      f.initialize([n]);
      f(0.5);
      expect(n.vx).toBeLessThan(0);       // pushed back toward center
      expect(n.vy).toBe(0);                // no vertical component (on axis)
    });

    it('scales strength with excess distance (farther = stronger pull)', () => {
      const near = { x: 110, y: 0, vx: 0, vy: 0 };   // 10 outside
      const far  = { x: 200, y: 0, vx: 0, vy: 0 };   // 100 outside
      const f = forceBoundary(100, 1.0, 0, 0);
      f.initialize([near, far]);
      f(1.0);
      expect(Math.abs(far.vx)).toBeGreaterThan(Math.abs(near.vx));
    });

    it('.radius(r) setter updates the active radius', () => {
      const n = { x: 150, y: 0, vx: 0, vy: 0 };
      const f = forceBoundary(100, 1.0, 0, 0);
      f.initialize([n]);
      f(1.0);
      const pushAt100 = n.vx;
      n.vx = 0;
      f.radius(200);                        // widen radius — now node is inside
      f(1.0);
      expect(n.vx).toBe(0);
      expect(pushAt100).toBeLessThan(0);
    });

    it('.strength(s) setter scales force magnitude', () => {
      const n1 = { x: 200, y: 0, vx: 0, vy: 0 };
      const n2 = { x: 200, y: 0, vx: 0, vy: 0 };
      const f1 = forceBoundary(100, 1.0, 0, 0);
      const f2 = forceBoundary(100, 2.0, 0, 0);
      f1.initialize([n1]); f2.initialize([n2]);
      f1(1.0); f2(1.0);
      expect(Math.abs(n2.vx)).toBeCloseTo(Math.abs(n1.vx) * 2, 5);
    });
  });

  describe('forceGroup', () => {
    it('pulls non-super nodes toward their group centroid', () => {
      const a = { id: 'a', kind: 'file', group: 'g1', x: 0,   y: 0,   vx: 0, vy: 0 };
      const b = { id: 'b', kind: 'file', group: 'g1', x: 100, y: 0,   vx: 0, vy: 0 };
      const c = { id: 'c', kind: 'file', group: 'g1', x: 50,  y: 100, vx: 0, vy: 0 };
      const f = forceGroup(0.5);
      f.initialize([a, b, c]);
      f(1.0);
      // centroid of g1 = (50, 33.33). 'a' at (0,0) should be pulled toward it.
      expect(a.vx).toBeGreaterThan(0);    // pulled rightward
      expect(a.vy).toBeGreaterThan(0);    // pulled downward
    });

    it('does not pull supernodes themselves', () => {
      const sup = { id: 'g1', kind: 'group', group: 'g1', x: 0, y: 0, vx: 0, vy: 0 };
      const leaf = { id: 'a', kind: 'file', group: 'g1', x: 100, y: 0, vx: 0, vy: 0 };
      const f = forceGroup(0.5);
      f.initialize([sup, leaf]);
      f(1.0);
      expect(sup.vx).toBe(0);
      expect(sup.vy).toBe(0);
    });

    it('ignores nodes with no group', () => {
      const n = { id: 'x', kind: 'decision', group: null, x: 50, y: 50, vx: 0, vy: 0 };
      const f = forceGroup(0.5);
      f.initialize([n]);
      f(1.0);
      expect(n.vx).toBe(0);
      expect(n.vy).toBe(0);
    });

    it('.strength(s) scales force magnitude linearly', () => {
      const mk = () => ([
        { id: 'a', kind: 'file', group: 'g', x: 0,   y: 0, vx: 0, vy: 0 },
        { id: 'b', kind: 'file', group: 'g', x: 100, y: 0, vx: 0, vy: 0 },
      ]);
      const ns1 = mk();  const f1 = forceGroup(0.3); f1.initialize(ns1); f1(1.0);
      const ns2 = mk();  const f2 = forceGroup(0.6); f2.initialize(ns2); f2(1.0);
      expect(Math.abs(ns2[0].vx)).toBeCloseTo(Math.abs(ns1[0].vx) * 2, 5);
    });
  });

  describe('forceGovernance', () => {
    it('pulls a decision toward the centroid of its governed nodes', () => {
      const d = { id: 'd1', kind: 'decision', governs: ['a', 'b'], x: 0, y: 0, vx: 0, vy: 0 };
      const a = { id: 'a', kind: 'group', x: 100, y: 0, vx: 0, vy: 0 };
      const b = { id: 'b', kind: 'group', x: 100, y: 100, vx: 0, vy: 0 };
      const f = forceGovernance(0.5);
      f.initialize([d, a, b]);
      f(1.0);
      expect(d.vx).toBeGreaterThan(0);    // territory centroid is at (100, 50)
      expect(d.vy).toBeGreaterThan(0);
    });

    it('leaves decisions with empty territory alone (no NaN, no drift)', () => {
      const d = { id: 'd1', kind: 'decision', governs: [], x: 10, y: 10, vx: 0, vy: 0 };
      const f = forceGovernance(0.5);
      f.initialize([d]);
      f(1.0);
      expect(d.vx).toBe(0);
      expect(d.vy).toBe(0);
      expect(Number.isNaN(d.vx)).toBe(false);
    });

    it('ignores governs members that are not in the node set', () => {
      const d = { id: 'd1', kind: 'decision', governs: ['ghost', 'a'], x: 0, y: 0, vx: 0, vy: 0 };
      const a = { id: 'a', kind: 'group', x: 100, y: 0, vx: 0, vy: 0 };
      const f = forceGovernance(0.5);
      f.initialize([d, a]);
      f(1.0);
      // Only 'a' counts → pull toward (100, 0)
      expect(d.vx).toBeGreaterThan(0);
      expect(d.vy).toBe(0);
    });

    it('does not affect non-decision nodes', () => {
      const file = { id: 'f', kind: 'file', governs: ['a'], x: 0, y: 0, vx: 0, vy: 0 };
      const a = { id: 'a', kind: 'group', x: 100, y: 0, vx: 0, vy: 0 };
      const f = forceGovernance(0.5);
      f.initialize([file, a]);
      f(1.0);
      expect(file.vx).toBe(0);
    });
  });
});
