import { describe, it, expect } from 'vitest';
import {
  diffProjection,
  createTransitionState,
  advanceTransitions,
  enterTransition,
  exitTransition,
  interpolated,
} from '../../src/viewer/shared/transitions.js';

function mkProj(ids: string[]) {
  return {
    visibleNodes: new Map(ids.map((id) => [id, { id, kind: 'file', name: id }])),
    visibleEdges: new Map(),
    groups: [],
  };
}

describe('transitions', () => {
  describe('diffProjection', () => {
    it('returns {entering, exiting} node id sets', () => {
      const prev = mkProj(['a', 'b']);
      const curr = mkProj(['b', 'c']);
      const d = diffProjection(prev, curr);
      expect(d.entering.map((e: { id: string }) => e.id)).toEqual(['c']);
      expect([...d.exiting]).toEqual(['a']);
    });

    it('null previous treats everything as entering', () => {
      const curr = mkProj(['a', 'b']);
      const d = diffProjection(null, curr);
      expect(d.entering.map((e: { id: string }) => e.id).sort()).toEqual(['a', 'b']);
      expect([...d.exiting]).toEqual([]);
    });
  });

  describe('transition state', () => {
    it('creates empty state', () => {
      const s = createTransitionState();
      expect(s.transitions.size).toBe(0);
    });

    it('enterTransition adds an entering entry', () => {
      const s = createTransitionState();
      enterTransition(s, 'a', { x: 0, y: 0 }, 280);
      expect(s.transitions.get('a')).toMatchObject({ phase: 'entering', age: 0, duration: 280 });
    });

    it('exitTransition adds an exiting entry with provided from/to', () => {
      const s = createTransitionState();
      exitTransition(s, 'a', { x: 10, y: 0, opacity: 1, scale: 1 }, { x: 5, y: 5 }, 220);
      expect(s.transitions.get('a')?.phase).toBe('exiting');
    });

    it('advanceTransitions increments age and removes completed', () => {
      const s = createTransitionState();
      enterTransition(s, 'a', { x: 0, y: 0 }, 100);
      advanceTransitions(s, 50);
      expect(s.transitions.get('a')?.age).toBe(50);
      advanceTransitions(s, 60);
      expect(s.transitions.has('a')).toBe(false);
    });
  });

  describe('interpolated', () => {
    it('at age 0 returns from', () => {
      const t = { phase: 'entering', age: 0, duration: 100,
                  from: { x: 0, y: 0, opacity: 0, scale: 0 },
                  to:   { x: 10, y: 10, opacity: 1, scale: 1 } };
      const v = interpolated(t);
      expect(v).toMatchObject({ x: 0, y: 0, opacity: 0, scale: 0 });
    });

    it('at age = duration returns to', () => {
      const t = { phase: 'entering', age: 100, duration: 100,
                  from: { x: 0, y: 0, opacity: 0, scale: 0 },
                  to:   { x: 10, y: 10, opacity: 1, scale: 1 } };
      const v = interpolated(t);
      expect(v).toMatchObject({ x: 10, y: 10, opacity: 1, scale: 1 });
    });

    it('interpolates smoothly in between', () => {
      const t = { phase: 'entering', age: 50, duration: 100,
                  from: { x: 0, y: 0, opacity: 0, scale: 0 },
                  to:   { x: 10, y: 10, opacity: 1, scale: 1 } };
      const v = interpolated(t);
      expect(v.opacity).toBeGreaterThan(0);
      expect(v.opacity).toBeLessThan(1);
    });
  });
});

describe('edge reclassification', () => {
  it('diffProjection returns reclassified when raw↔aggregate swap', () => {
    const prev = {
      visibleNodes: new Map([['a', {id:'a'}], ['b', {id:'b'}]]),
      visibleEdges: new Map([['a→b', { source_id:'a', target_id:'b', relation:'CALLS' }]]),
    };
    const curr = {
      visibleNodes: new Map([['ga', {id:'ga'}], ['gb', {id:'gb'}]]),
      visibleEdges: new Map([['agg:ga→gb', { aggregate:true, source_id:'ga', target_id:'gb', count:1, relation:'CALLS' }]]),
    };
    const diff = diffProjection(prev, curr);
    expect(diff.reclassified).toBeDefined();
    expect(Array.isArray(diff.reclassified)).toBe(true);
  });
});

describe('re-parenting on unfold', () => {
  it('entering leaves get initial position from their ex-supernode', () => {
    const prev = {
      visibleNodes: new Map([
        ['group:path:src/events', { id: 'group:path:src/events', kind: 'group', x: 120, y: 40 }],
      ]),
      visibleEdges: new Map(),
    };
    const curr = {
      visibleNodes: new Map([
        ['f1', { id: 'f1', kind: 'file', group: 'group:path:src/events' }],
        ['f2', { id: 'f2', kind: 'file', group: 'group:path:src/events' }],
      ]),
      visibleEdges: new Map(),
    };
    const { entering } = diffProjection(prev, curr);
    for (const t of entering) {
      expect(Math.abs(t.from.x - 120)).toBeLessThan(25); // within ~20px jitter
      expect(Math.abs(t.from.y - 40)).toBeLessThan(25);
    }
  });
});
