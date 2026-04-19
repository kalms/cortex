import { describe, it, expect } from 'vitest';
import {
  nodeSize,
  nodeCharge,
  linkDistance,
  linkStrength,
  createSimulation,
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
});
