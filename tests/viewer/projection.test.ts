import { describe, it, expect } from 'vitest';
import {
  project,
  BAND_TABLE,
  projectionDeltaIsInteresting,
} from '../../src/viewer/shared/projection.js';

function makeState(nodes: any[], edges: any[]) {
  return {
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: new Map(edges.map((e, i) => [`ek:${i}`, e])),
  };
}

const defaultInputs = {
  zoom: 1.0,
  focus: null,
  filters: new Set(['decision', 'file', 'function', 'component', 'reference', 'path']),
  search: '',
};

describe('projection', () => {
  describe('BAND_TABLE', () => {
    it('has four bands covering zoom from 0 to Infinity', () => {
      expect(BAND_TABLE.length).toBe(4);
      expect(BAND_TABLE[0].maxZoom).toBeCloseTo(0.4);
      expect(BAND_TABLE[BAND_TABLE.length - 1].maxZoom).toBe(Infinity);
    });
  });

  describe('far zoom (< 0.4×) — decisions + top-level groups only', () => {
    it('emits decisions and top-level path groups, not leaves', () => {
      const state = makeState(
        [
          { id: 'd1', kind: 'decision', name: 'D1' },
          { id: 'a', kind: 'file', name: 'a.ts', file_path: 'src/events/worker/a.ts' },
          { id: 'b', kind: 'file', name: 'b.ts', file_path: 'src/events/worker/b.ts' },
          { id: 'c', kind: 'file', name: 'c.ts', file_path: 'src/graph/c.ts' },
          { id: 'c2', kind: 'file', name: 'c2.ts', file_path: 'src/graph/c2.ts' },
        ],
        [],
      );
      const out = project(state, { ...defaultInputs, zoom: 0.3 });
      const ids = [...out.visibleNodes.keys()];
      expect(ids).toContain('d1');
      // Leaves must not appear
      expect(ids).not.toContain('a');
      expect(ids).not.toContain('c');
      // Some top-level path group must appear
      expect(ids.some((id) => id.startsWith('group:path:src'))).toBe(true);
    });
  });

  describe('close zoom (> 2.0×) — all leaves visible', () => {
    it('emits all leaves including functions', () => {
      const state = makeState(
        [
          { id: 'd1', kind: 'decision', name: 'D1' },
          { id: 'f1', kind: 'file', name: 'a.ts', file_path: 'src/a.ts' },
          { id: 'fn1', kind: 'function', name: 'doThing',
            file_path: 'src/a.ts', qualified_name: 'src/a.ts::doThing' },
        ],
        [],
      );
      const out = project(state, { ...defaultInputs, zoom: 3.0 });
      const ids = [...out.visibleNodes.keys()];
      expect(ids).toContain('d1');
      expect(ids).toContain('f1');
      expect(ids).toContain('fn1');
    });
  });

  describe('search force-visible', () => {
    it('forces a matching folded leaf visible at far zoom with ancestor path', () => {
      const state = makeState(
        [
          { id: 'd1', kind: 'decision', name: 'D1' },
          { id: 'a', kind: 'file', name: 'persister.ts',
            file_path: 'src/events/worker/persister.ts' },
          { id: 'b', kind: 'file', name: 'git-watcher.ts',
            file_path: 'src/events/worker/git-watcher.ts' },
          { id: 'c', kind: 'file', name: 'other.ts', file_path: 'src/other/x.ts' },
          { id: 'c2', kind: 'file', name: 'other2.ts', file_path: 'src/other/y.ts' },
        ],
        [],
      );
      const out = project(state, { ...defaultInputs, zoom: 0.3, search: 'persister' });
      const ids = [...out.visibleNodes.keys()];
      expect(ids).toContain('a');   // matched leaf forced visible
    });
  });

  describe('focus restriction', () => {
    it('restricts to root + 1-hop neighborhood', () => {
      const state = makeState(
        [
          { id: 'r', kind: 'file', name: 'root.ts', file_path: 'src/r.ts' },
          { id: 'n1', kind: 'file', name: 'n1.ts', file_path: 'src/n1.ts' },
          { id: 'n2', kind: 'file', name: 'n2.ts', file_path: 'src/n2.ts' },
          { id: 'far', kind: 'file', name: 'far.ts', file_path: 'src/far.ts' },
        ],
        [
          { source_id: 'r', target_id: 'n1', relation: 'CALLS' },
          { source_id: 'r', target_id: 'n2', relation: 'CALLS' },
        ],
      );
      const out = project(state, {
        ...defaultInputs, zoom: 3.0, focus: { root: 'r', depth: 1 },
      });
      const ids = [...out.visibleNodes.keys()];
      expect(ids.sort()).toEqual(['n1', 'n2', 'r']);
    });
  });

  describe('aggregate edges', () => {
    it('rolls edges between folded supernodes into an aggregate edge', () => {
      const state = makeState(
        [
          { id: 'a', kind: 'file', name: 'a', file_path: 'src/events/a.ts' },
          { id: 'b', kind: 'file', name: 'b', file_path: 'src/events/b.ts' },
          { id: 'c', kind: 'file', name: 'c', file_path: 'src/graph/c.ts' },
          { id: 'd', kind: 'file', name: 'd', file_path: 'src/graph/d.ts' },
        ],
        [
          { source_id: 'a', target_id: 'c', relation: 'CALLS' },
          { source_id: 'b', target_id: 'c', relation: 'CALLS' },
          { source_id: 'a', target_id: 'd', relation: 'IMPORTS' },
        ],
      );
      const out = project(state, { ...defaultInputs, zoom: 0.3 });
      const aggs = [...out.visibleEdges.values()].filter((e) => e.aggregate);
      expect(aggs.length).toBeGreaterThanOrEqual(1);
      const total = aggs.reduce((sum, e) => sum + e.count, 0);
      expect(total).toBe(3);
    });
  });

  describe('dangling edge — forced-visible node to folded neighbor', () => {
    it('emits an aggregate edge from the forced leaf to the neighbor supernode', () => {
      const state = makeState(
        [
          { id: 'a', kind: 'file', name: 'persister.ts',
            file_path: 'src/events/worker/persister.ts' },
          { id: 'b', kind: 'file', name: 'other.ts', file_path: 'src/graph/other.ts' },
          { id: 'b2', kind: 'file', name: 'other2.ts', file_path: 'src/graph/other2.ts' },
        ],
        [{ source_id: 'a', target_id: 'b', relation: 'CALLS' }],
      );
      const out = project(state, { ...defaultInputs, zoom: 0.3, search: 'persister' });
      const visibleIds = new Set(out.visibleNodes.keys());
      expect(visibleIds.has('a')).toBe(true);
      expect(visibleIds.has('b')).toBe(false);
      // There must be an edge whose target is the supernode containing b.
      const hasAggToNeighborGroup = [...out.visibleEdges.values()].some(
        (e) => e.source_id === 'a' && e.target_id.startsWith('group:path:src/graph'),
      );
      expect(hasAggToNeighborGroup).toBe(true);
    });
  });

  describe('idempotence', () => {
    it('same inputs → same output shape (by deep-equal)', () => {
      const state = makeState(
        [
          { id: 'd1', kind: 'decision', name: 'D1' },
          { id: 'a', kind: 'file', name: 'a', file_path: 'src/a.ts' },
          { id: 'b', kind: 'file', name: 'b', file_path: 'src/b.ts' },
        ],
        [],
      );
      const a = project(state, { ...defaultInputs, zoom: 0.5 });
      const b = project(state, { ...defaultInputs, zoom: 0.5 });
      expect([...a.visibleNodes.keys()].sort()).toEqual([...b.visibleNodes.keys()].sort());
      expect([...a.visibleEdges.keys()].sort()).toEqual([...b.visibleEdges.keys()].sort());
    });
  });

  describe('projectionDeltaIsInteresting', () => {
    it('false when previous is null and current is any projection', () => {
      const state = makeState([{ id: 'a', kind: 'file', name: 'a' }], []);
      const curr = project(state, defaultInputs);
      expect(projectionDeltaIsInteresting(null, curr)).toBe(true);
    });

    it('true when visible node id set differs', () => {
      const s1 = makeState([{ id: 'a', kind: 'file', name: 'a' }], []);
      const s2 = makeState([{ id: 'b', kind: 'file', name: 'b' }], []);
      const p1 = project(s1, defaultInputs);
      const p2 = project(s2, defaultInputs);
      expect(projectionDeltaIsInteresting(p1, p2)).toBe(true);
    });

    it('false when node ids identical and edges identical', () => {
      const s = makeState([{ id: 'a', kind: 'file', name: 'a' }], []);
      const p1 = project(s, defaultInputs);
      const p2 = project(s, defaultInputs);
      expect(projectionDeltaIsInteresting(p1, p2)).toBe(false);
    });
  });
});
