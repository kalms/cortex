/**
 * Event envelope common to every event kind.
 *
 * Persisted verbatim in events.db (one row per event). ULID `id` is sortable by
 * time, which saves an extra indexed timestamp column. `actor` is the entity
 * that performed the action (currently 'claude' for MCP-initiated actions,
 * '<git-author-name>' for commits, 'system' for future automated events).
 *
 * `project_id` is denormalized onto every event so multi-project filtering
 * later requires no schema change.
 */
export interface EventEnvelope {
  /** 26-char ULID; monotonic in same-ms calls. */
  id: string;
  /** Dotted `<entity>.<verb>` — see `Event` union. */
  kind: string;
  /** 'claude' | git-author | 'system'. */
  actor: string;
  /** Unix milliseconds. */
  created_at: number;
  /** CBM project name if attached, else ''. */
  project_id: string;
}

/**
 * Discriminated union of all v1 event kinds.
 *
 * Add a new kind by extending this union + adding a case to the mutation
 * deriver. Nothing else needs to change for the event to flow end-to-end.
 */
export type Event =
  | (EventEnvelope & {
      kind: 'decision.created';
      payload: {
        decision_id: string;
        title: string;
        rationale: string;
        governed_file_ids: string[];
        tags: string[];
      };
    })
  | (EventEnvelope & {
      kind: 'decision.updated';
      payload: { decision_id: string; changed_fields: string[] };
    })
  | (EventEnvelope & {
      kind: 'decision.deleted';
      /** `title` snapshotted at delete-time for tombstone rendering in the stream. */
      payload: { decision_id: string; title: string };
    })
  | (EventEnvelope & {
      kind: 'decision.superseded';
      payload: { old_id: string; new_id: string; reason: string };
    })
  | (EventEnvelope & {
      kind: 'decision.promoted';
      payload: { decision_id: string; from_tier: string; to_tier: string };
    })
  | (EventEnvelope & {
      kind: 'decision.proposed';
      payload: {
        decision_id: string;
        title: string;
        would_govern_file_ids: string[];
      };
    })
  | (EventEnvelope & {
      kind: 'commit';
      payload: {
        hash: string;
        message: string;
        files: { path: string; status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' }[];
        /** Decisions governing any of the touched files. Computed at emission, not render. */
        decision_links: string[];
      };
    });

/**
 * Shape of a node as broadcast over the wire.
 *
 * Matches the shape returned by `/api/graph` (which the viewer uses to bootstrap).
 * Only the fields actually consumed by the viewer are declared; the backend
 * may carry additional fields.
 */
export interface WireNode {
  id: string;
  kind: string;
  name: string;
  /** decision-only; 'active' | 'proposed' | 'superseded' */
  status?: string;
  /** Free-form JSON, shape depends on kind. */
  data?: Record<string, unknown>;
}

/** Edge shape as broadcast over the wire. */
export interface WireEdge {
  source_id: string;
  target_id: string;
  relation: string;
}

/**
 * Graph mutation — a single delta applied to the viewer's graph state.
 *
 * Derived from events by `mutation-deriver`. Routed to the graph component;
 * the stream component ignores these (it consumes events, not mutations).
 */
export type GraphMutation =
  | { op: 'add_node'; node: WireNode }
  | { op: 'update_node'; id: string; fields: Partial<WireNode> }
  | { op: 'remove_node'; id: string }
  | { op: 'add_edge'; edge: WireEdge }
  | {
      op: 'remove_edge';
      source: string;
      target: string;
      relation: string;
    };

/**
 * Messages sent from server to client over the WebSocket at `/ws`.
 *
 * See `docs/superpowers/specs/2026-04-17-graph-ui-and-activity-stream-design.md#websocket-protocol`.
 */
export type ServerMsg =
  | { type: 'hello'; project_id: string; server_version: string }
  | { type: 'event'; event: Event }
  | { type: 'mutation'; mutation: GraphMutation }
  | {
      type: 'backfill_page';
      events: Event[];
      mutations: GraphMutation[];
      has_more: boolean;
    }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string };

/** Messages sent from client to server over the WebSocket at `/ws`. */
export type ClientMsg =
  | { type: 'backfill'; before_id?: string; limit?: number }
  | { type: 'ping' };
