import { describe, it, expect } from 'vitest';
import {
  createGraphState,
  applyMutation,
  hydrate,
  edgeKey,
} from '../../src/viewer/shared/state.js';

describe('graph state', () => {
  it('creates empty state', () => {
    const s = createGraphState();
    expect(s.nodes.size).toBe(0);
    expect(s.edges.size).toBe(0);
    expect(s.version).toBe(0);
  });

  it('edgeKey is deterministic and relation-aware', () => {
    const a = edgeKey({ source_id: 'x', target_id: 'y', relation: 'CALLS' });
    const b = edgeKey({ source_id: 'x', target_id: 'y', relation: 'CALLS' });
    const c = edgeKey({ source_id: 'x', target_id: 'y', relation: 'IMPORTS' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('hydrate loads from /api/graph shape', () => {
    const s = createGraphState();
    hydrate(s, {
      nodes: [{ id: 'n1', kind: 'file', name: 'a.ts' }],
      edges: [{ source_id: 'n1', target_id: 'n2', relation: 'CALLS' }],
    });
    expect(s.nodes.get('n1').name).toBe('a.ts');
    expect(s.edges.size).toBe(1);
  });

  it('add_node inserts and bumps version', () => {
    const s = createGraphState();
    applyMutation(s, { op: 'add_node', node: { id: 'n1', kind: 'file', name: 'a.ts' } });
    expect(s.nodes.get('n1').name).toBe('a.ts');
    expect(s.version).toBe(1);
  });

  it('update_node merges fields on existing node, no-op on missing', () => {
    const s = createGraphState();
    s.nodes.set('n1', { id: 'n1', kind: 'file', name: 'a.ts' });
    applyMutation(s, { op: 'update_node', id: 'n1', fields: { name: 'a2.ts' } });
    expect(s.nodes.get('n1').name).toBe('a2.ts');
    expect(s.nodes.get('n1').kind).toBe('file');

    applyMutation(s, { op: 'update_node', id: 'missing', fields: { name: 'x' } });
    expect(s.nodes.has('missing')).toBe(false);
  });

  it('remove_node cascades to attached edges', () => {
    const s = createGraphState();
    s.nodes.set('n1', { id: 'n1', kind: 'file', name: 'a' });
    s.nodes.set('n2', { id: 'n2', kind: 'file', name: 'b' });
    s.edges.set(
      edgeKey({ source_id: 'n1', target_id: 'n2', relation: 'CALLS' }),
      { source_id: 'n1', target_id: 'n2', relation: 'CALLS' },
    );
    applyMutation(s, { op: 'remove_node', id: 'n1' });
    expect(s.nodes.has('n1')).toBe(false);
    expect(s.edges.size).toBe(0);
  });

  it('add_edge / remove_edge by (source,target,relation)', () => {
    const s = createGraphState();
    applyMutation(s, {
      op: 'add_edge',
      edge: { source_id: 'a', target_id: 'b', relation: 'CALLS' },
    });
    expect(s.edges.size).toBe(1);
    applyMutation(s, {
      op: 'remove_edge',
      source: 'a',
      target: 'b',
      relation: 'CALLS',
    });
    expect(s.edges.size).toBe(0);
  });
});
