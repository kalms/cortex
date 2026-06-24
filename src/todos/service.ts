import type Database from "better-sqlite3";
import { mintId } from "../ids/allocator.js";
import { parseRef } from "../ids/short-id.js";
import { TodosRepository } from "./repository.js";
import { TodoLinksRepository, type TodoLink } from "./links-repository.js";
import {
  rowToTodo, type Todo, type TodoRecord, type TodoWithRefs, type TodoRefRow,
  type ProposeTodoInput, type UpdateTodoInput, type LinkTodoInput, type TodoLinkRelation,
} from "./types.js";

export interface TodoServiceDeps {
  db: Database.Database;
  todos: TodosRepository;
  links: TodoLinksRepository;
}

/** path-like → 'path', has '::' → 'qn', T-/D- → 'todo'/'decision', all-digits → 'pr'. */
function classifyTarget(target: string): string {
  if (/^T-/.test(target)) return "todo";
  if (/^D-/.test(target)) return "decision";
  if (/^\d+$/.test(target)) return "pr";
  if (target.includes("::")) return "qn";
  return "path";
}

export class TodoService {
  private db: Database.Database;
  private todos: TodosRepository;
  private links: TodoLinksRepository;

  constructor(deps: TodoServiceDeps) {
    this.db = deps.db; this.todos = deps.todos; this.links = deps.links;
  }

  private resolveRecord(ref: string): TodoRecord | null {
    const direct = this.todos.get(ref);
    if (direct) return direct;
    const parsed = parseRef("todo", ref);
    if (!parsed) return null;
    return parsed.kind === "seq" ? this.todos.getBySeq(parsed.seq) : this.todos.get(parsed.id);
  }

  private addLink(todoId: string, ref: string, relation: TodoLinkRelation, now: string): void {
    const owner = this.resolveRecord(todoId);
    const ownerId = owner ? owner.id : todoId;
    let targetRef = ref;
    const kind = classifyTarget(ref);
    if (kind === "todo") {
      const t = this.resolveRecord(ref);
      targetRef = t ? t.id : ref;
    }
    this.links.add({ todo_id: ownerId, target_kind: kind, target_ref: targetRef, relation, created_at: now });
  }

  propose(input: ProposeTodoInput): Todo {
    const now = new Date().toISOString();
    const { id, seq } = mintId(this.db, "todo", (cand) => this.todos.get(cand) != null);
    const rec: TodoRecord = {
      id, seq, summary: input.summary, description: input.description ?? null,
      state: "open", state_reason: null, proposed_by: input.proposed_by ?? "claude",
      proposed_at: now, started_at: null, closed_at: null, assignee: null,
      created_at: now, updated_at: now,
    };
    this.todos.insert(rec);
    for (const g of input.governs ?? []) this.addLink(id, g, "GOVERNS", now);
    if (input.spawns_from) this.addLink(id, input.spawns_from, "SPAWNS_FROM", now);
    for (const b of input.blocked_by ?? []) this.addLink(id, b, "BLOCKED_BY", now);
    return rowToTodo(rec);
  }

  get(idOrSeq: string): Todo | null {
    const rec = this.resolveRecord(idOrSeq);
    return rec ? rowToTodo(rec) : null;
  }

  getWithRefs(idOrSeq: string): TodoWithRefs | null {
    const rec = this.resolveRecord(idOrSeq);
    if (!rec) return null;
    const links = this.links.findByTodo(rec.id);
    const pick = (relation: TodoLinkRelation): TodoRefRow[] =>
      links.filter((l) => l.relation === relation).map((l) => ({ target_kind: l.target_kind, target_ref: l.target_ref }));
    const blocks: TodoRefRow[] = this.links.findBlocking(rec.id)
      .map((l) => ({ target_kind: "todo", target_ref: l.todo_id }));
    return {
      ...rowToTodo(rec),
      governs: pick("GOVERNS"),
      blocked_by: pick("BLOCKED_BY"),
      blocks,
      related_to: pick("RELATED_TO"),
      spawns_from: pick("SPAWNS_FROM")[0] ?? null,
      resolved_by: pick("RESOLVED_BY"),
    };
  }

  update(idOrSeq: string, input: UpdateTodoInput): Todo {
    const existing = this.resolveRecord(idOrSeq);
    if (!existing) throw new Error(`Todo not found: ${idOrSeq}`);
    const now = new Date().toISOString();
    const patch: Partial<TodoRecord> = { updated_at: now };
    if (input.summary !== undefined) patch.summary = input.summary;
    if (input.description !== undefined) patch.description = input.description;
    if (input.assignee !== undefined) patch.assignee = input.assignee;
    this.todos.update(existing.id, patch);
    if (input.governs !== undefined) this.replaceLinks(existing.id, "GOVERNS", input.governs, now);
    return rowToTodo({ ...existing, ...patch } as TodoRecord);
  }

  search(query: string): Todo[] { return this.todos.search(query).map(rowToTodo); }
  list(): Todo[] { return this.todos.list().map(rowToTodo); }

  link(input: LinkTodoInput): void {
    if (!this.resolveRecord(input.todo_id)) throw new Error(`Todo not found: ${input.todo_id}`);
    this.addLink(input.todo_id, input.target, input.relation, new Date().toISOString());
  }

  private replaceLinks(todoId: string, relation: TodoLinkRelation, newTargets: string[], now: string): void {
    const current = this.links.findByTodo(todoId).filter((l) => l.relation === relation);
    const currentRefs = new Set(current.map((l) => l.target_ref));
    const newRefs = new Set(newTargets);
    for (const l of current) if (!newRefs.has(l.target_ref)) this.links.remove(todoId, l.target_kind, l.target_ref, relation);
    for (const t of newTargets) if (!currentRefs.has(t)) this.addLink(todoId, t, relation, now);
  }
}
