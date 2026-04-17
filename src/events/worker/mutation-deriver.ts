import type { Event, GraphMutation, WireNode } from '../types.js';

/**
 * Function the deriver calls to look up current node state when needed.
 *
 * The deriver is pure WRT its inputs; this interface is how it gets the
 * current graph state without reaching into the main thread's store.
 *
 * In production, this is backed by a snapshot the worker holds (populated
 * from the same `/api/graph` response the viewer hydrates with). In tests,
 * pass a Map-based implementation.
 */
export type NodeLookup = (id: string) => WireNode | undefined;

/**
 * Pure function: event → ordered array of graph mutations the viewer applies.
 *
 * Order matters: `add_node` must precede any `add_edge` referencing that node.
 * Viewer applies them in array order.
 *
 * `commit` events intentionally produce no mutations in v1 — commits don't
 * change the graph structure, only the stream.
 */
export function deriveMutations(event: Event, lookup: NodeLookup): GraphMutation[] {
  switch (event.kind) {
    case 'decision.created': {
      const node = lookup(event.payload.decision_id);
      if (!node) return [];
      const mutations: GraphMutation[] = [{ op: 'add_node', node }];
      for (const fid of event.payload.governed_file_ids) {
        mutations.push({
          op: 'add_edge',
          edge: {
            source_id: event.payload.decision_id,
            target_id: fid,
            relation: 'GOVERNS',
          },
        });
      }
      return mutations;
    }

    case 'decision.updated': {
      const node = lookup(event.payload.decision_id);
      if (!node) return [];
      const fields: Partial<WireNode> = {};
      for (const f of event.payload.changed_fields) {
        if (f === 'title') fields.name = node.name;
        if (f === 'status') fields.status = node.status;
        if (f === 'data') fields.data = node.data;
      }
      return Object.keys(fields).length
        ? [{ op: 'update_node', id: event.payload.decision_id, fields }]
        : [];
    }

    case 'decision.deleted':
      return [{ op: 'remove_node', id: event.payload.decision_id }];

    case 'decision.superseded':
      return [
        { op: 'update_node', id: event.payload.old_id, fields: { status: 'superseded' } },
        {
          op: 'add_edge',
          edge: {
            source_id: event.payload.new_id,
            target_id: event.payload.old_id,
            relation: 'SUPERSEDES',
          },
        },
      ];

    case 'decision.promoted':
      return [
        {
          op: 'update_node',
          id: event.payload.decision_id,
          fields: { data: { tier: event.payload.to_tier } },
        },
      ];

    case 'decision.proposed': {
      const node = lookup(event.payload.decision_id);
      return node ? [{ op: 'add_node', node }] : [];
    }

    case 'commit':
      return [];
  }
}
