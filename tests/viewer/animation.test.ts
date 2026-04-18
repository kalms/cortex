import { describe, it, expect } from 'vitest';
import {
  createAnimState,
  advance,
  setHover,
  clearHover,
  triggerSynapse,
  LERP_FACTOR,
} from '../../src/viewer/shared/animation.js';

describe('animation', () => {
  it('createAnimState returns empty maps', () => {
    const a = createAnimState();
    expect(a.nodes.size).toBe(0);
    expect(a.edges.size).toBe(0);
    expect(a.synapses.length).toBe(0);
  });

  it('setHover marks hovered node highlight=1, neighbors 0.6, others 0', () => {
    const a = createAnimState();
    setHover(a, 'n1', new Set(['n2', 'n3']));
    expect(a.nodes.get('n1').targetHighlight).toBe(1);
    expect(a.nodes.get('n2').targetHighlight).toBe(0.6);
    expect(a.nodes.get('n3').targetHighlight).toBe(0.6);
  });

  it('clearHover zeros all targets', () => {
    const a = createAnimState();
    setHover(a, 'n1', new Set(['n2']));
    clearHover(a);
    expect(a.nodes.get('n1').targetHighlight).toBe(0);
    expect(a.nodes.get('n2').targetHighlight).toBe(0);
  });

  it('advance lerps highlight toward target', () => {
    const a = createAnimState();
    setHover(a, 'n1', new Set());
    const before = a.nodes.get('n1').highlight;
    advance(a, 1);
    const after = a.nodes.get('n1').highlight;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(1);
    // After many frames, highlight approaches 1.
    for (let i = 0; i < 60; i++) advance(a, 1);
    expect(a.nodes.get('n1').highlight).toBeGreaterThan(0.95);
  });

  it('LERP_FACTOR is a small positive fraction', () => {
    expect(LERP_FACTOR).toBeGreaterThan(0);
    expect(LERP_FACTOR).toBeLessThan(1);
  });

  it('triggerSynapse appends an entry with expected shape', () => {
    const a = createAnimState();
    triggerSynapse(a, { kind: 'ring', nodeId: 'n1', duration: 60 });
    expect(a.synapses.length).toBe(1);
    expect(a.synapses[0].age).toBe(0);
    expect(a.synapses[0].kind).toBe('ring');
    expect(a.synapses[0].nodeId).toBe('n1');
  });

  it('advance increments synapse age and prunes expired entries', () => {
    const a = createAnimState();
    triggerSynapse(a, { kind: 'ring', nodeId: 'n1', duration: 3 });
    advance(a, 1);
    expect(a.synapses[0].age).toBe(1);
    advance(a, 1);
    advance(a, 1);
    advance(a, 1);
    expect(a.synapses.length).toBe(0);
  });
});
