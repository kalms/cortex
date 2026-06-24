export type TodoState = "open" | "in_progress" | "blocked" | "done" | "cancelled";

/** Link relations TODOs can hold. `blocks` is DERIVED (reverse of blockedBy),
 *  never stored — see TodoLinksRepository.findBlocking. */
export type TodoLinkRelation =
  | "GOVERNS"       // → code ref / frame (string qn or path)
  | "BLOCKED_BY"    // → todo id
  | "RELATED_TO"    // → todo id
  | "SPAWNS_FROM"   // → decision id (0..1)
  | "RESOLVED_BY";  // → pr number (string)

export interface Todo {
  id: string;            // "T-9m2x"
  seq: number;
  summary: string;
  description: string;
  state: TodoState;
  state_reason: string | null;
  proposed_by: string | null;   // author-style string, NOT a typed AgentRef
  proposed_at: string;
  started_at: string | null;
  closed_at: string | null;
  assignee: string | null;
  created_at: string;
  updated_at: string;
}

/** Row shape as stored/read by TodosRepository (Task 1.3). Kept structurally
 *  identical to `Todo` so `rowToTodo` is a pass-through today; the split mirrors
 *  decisions (DecisionRecord vs Decision) and leaves room for stored-only cols. */
export interface TodoRecord {
  id: string; seq: number; summary: string; description: string | null;
  state: string; state_reason: string | null; proposed_by: string | null;
  proposed_at: string; started_at: string | null; closed_at: string | null;
  assignee: string | null; created_at: string; updated_at: string;
}

export interface ProposeTodoInput {
  summary: string;
  description?: string;
  proposed_by?: string;
  governs?: string[];        // code refs / frames
  spawns_from?: string;      // decision id
  blocked_by?: string[];     // todo ids
}

export interface UpdateTodoInput {
  summary?: string;
  description?: string;
  assignee?: string | null;
  governs?: string[];        // full-set replacement when provided
}

export interface TransitionTodoInput {
  to: TodoState;
  reason?: string;           // recorded as state_reason on blocked/cancelled
  resolved_by?: string[];    // pr numbers, recorded as RESOLVED_BY on → done
  blocked_by?: string[];     // todo ids, recorded as BLOCKED_BY on → blocked
}

export interface LinkTodoInput {
  todo_id: string;
  target: string;
  relation: TodoLinkRelation;
}

export interface TodoRefRow { target_kind: string; target_ref: string; }
export interface TodoWithRefs extends Todo {
  governs: TodoRefRow[];
  blocked_by: TodoRefRow[];
  blocks: TodoRefRow[];        // derived
  related_to: TodoRefRow[];
  spawns_from: TodoRefRow | null;
  resolved_by: TodoRefRow[];
}

export function rowToTodo(rec: TodoRecord): Todo {
  return {
    id: rec.id,
    seq: rec.seq,
    summary: rec.summary,
    description: rec.description ?? "",
    state: rec.state as TodoState,
    state_reason: rec.state_reason ?? null,
    proposed_by: rec.proposed_by ?? null,
    proposed_at: rec.proposed_at,
    started_at: rec.started_at ?? null,
    closed_at: rec.closed_at ?? null,
    assignee: rec.assignee ?? null,
    created_at: rec.created_at,
    updated_at: rec.updated_at,
  };
}
