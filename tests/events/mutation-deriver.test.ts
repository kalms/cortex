import { describe, it, expect } from 'vitest';
import { deriveMutations } from '../../src/events/worker/mutation-deriver.js';
import type { Event, WireNode } from '../../src/events/types.js';

function env<E extends Event>(overrides: Partial<E>): E {
  return {
    id: '01HXZ00000000000000000000A',
    kind: 'decision.created',
    actor: 'claude',
    created_at: 1_700_000_000_000,
    project_id: 'cortex',
    payload: {},
    ...(overrides as object),
  } as E;
}

const nodes = new Map<string, WireNode>([
  ['d1', { id: 'd1', kind: 'decision', name: 'Use WAL', status: 'active' }],
  ['f1', { id: 'f1', kind: 'file', name: 'store.ts' }],
  ['f2', { id: 'f2', kind: 'file', name: 'schema.sql' }],
]);
const lookup = (id: string) => nodes.get(id);

describe('deriveMutations', () => {
  it('decision.created produces add_node + one add_edge per governed file', () => {
    const e = env<Event & { kind: 'decision.created' }>({
      kind: 'decision.created',
      payload: {
        decision_id: 'd1',
        title: 'Use WAL',
        rationale: 'r',
        governed_file_ids: ['f1', 'f2'],
        tags: [],
      },
    });
    const ms = deriveMutations(e, lookup);
    expect(ms).toEqual([
      { op: 'add_node', node: nodes.get('d1') },
      { op: 'add_edge', edge: { source_id: 'd1', target_id: 'f1', relation: 'GOVERNS' } },
      { op: 'add_edge', edge: { source_id: 'd1', target_id: 'f2', relation: 'GOVERNS' } },
    ]);
  });

  it('decision.deleted produces remove_node', () => {
    const e = env<Event & { kind: 'decision.deleted' }>({
      kind: 'decision.deleted',
      payload: { decision_id: 'd1', title: 'Use WAL' },
    });
    expect(deriveMutations(e, lookup)).toEqual([
      { op: 'remove_node', id: 'd1' },
    ]);
  });

  it('decision.superseded produces update_node for both old and new + add_edge SUPERSEDES', () => {
    const e = env<Event & { kind: 'decision.superseded' }>({
      kind: 'decision.superseded',
      payload: { old_id: 'd1', new_id: 'd2', reason: 'ported' },
    });
    expect(deriveMutations(e, lookup)).toEqual([
      { op: 'update_node', id: 'd1', fields: { status: 'superseded' } },
      { op: 'add_edge', edge: { source_id: 'd2', target_id: 'd1', relation: 'SUPERSEDES' } },
    ]);
  });

  it('decision.updated produces update_node with changed fields', () => {
    const e = env<Event & { kind: 'decision.updated' }>({
      kind: 'decision.updated',
      payload: { decision_id: 'd1', changed_fields: ['title'] },
    });
    const ms = deriveMutations(e, lookup);
    expect(ms).toEqual([
      { op: 'update_node', id: 'd1', fields: { name: 'Use WAL' } },
    ]);
  });

  it('commit produces no mutations in v1', () => {
    const e = env<Event & { kind: 'commit' }>({
      kind: 'commit',
      payload: {
        hash: 'abc',
        message: 'm',
        files: [{ path: 'a.ts', status: 'M' }],
        decision_links: [],
      },
    });
    expect(deriveMutations(e, lookup)).toEqual([]);
  });

  it('decision.proposed produces add_node only (no GOVERNS edges yet — would_govern is advisory)', () => {
    const e = env<Event & { kind: 'decision.proposed' }>({
      kind: 'decision.proposed',
      payload: {
        decision_id: 'd3',
        title: 'Proposed',
        would_govern_file_ids: ['f1'],
      },
    });
    const lookupWithD3 = (id: string) =>
      id === 'd3'
        ? { id: 'd3', kind: 'decision', name: 'Proposed', status: 'proposed' }
        : nodes.get(id);
    expect(deriveMutations(e, lookupWithD3)).toEqual([
      { op: 'add_node', node: { id: 'd3', kind: 'decision', name: 'Proposed', status: 'proposed' } },
    ]);
  });

  it('decision.promoted produces update_node with new tier', () => {
    const e = env<Event & { kind: 'decision.promoted' }>({
      kind: 'decision.promoted',
      payload: { decision_id: 'd1', from_tier: 'personal', to_tier: 'team' },
    });
    expect(deriveMutations(e, lookup)).toEqual([
      { op: 'update_node', id: 'd1', fields: { data: { tier: 'team' } } },
    ]);
  });
});
