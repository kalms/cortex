import type Database from "better-sqlite3";
import { mintId } from "../ids/allocator.js";
import { parseRef } from "../ids/short-id.js";
import { classifyGovernsTarget } from "../shared/classify-ref.js";
import type { OriginFields } from "../git/origin.js";
import { TodosRepository } from "./repository.js";
import { TodoLinksRepository } from "./links-repository.js";
import {
  rowToTodo, type Todo, type TodoRecord, type TodoWithRefs, type TodoRefRow,
  type ProposeTodoInput, type UpdateTodoInput, type LinkTodoInput, type TodoLinkRelation, type TransitionTodoInput,
} from "./types.js";
import type { EventBus } from "../events/bus.js";
import type { Event } from "../events/types.js";
import { newUlid } from "../events/ulid.js";

export interface TodoServiceDeps {
  db: Database.Database;
  todos: TodosRepository;
  links: TodoLinksRepository;
  bus?: EventBus;
  project_id?: string;
}

const TRANSITIONS: Record<string, ReadonlySet<string>> = {
  open: new Set(["in_progress", "cancelled"]),
  in_progress: new Set(["blocked", "done", "cancelled"]),
  blocked: new Set(["in_progress", "open", "cancelled"]),
  done: new Set(),
  cancelled: new Set(),
};

export class TodoService {
  private db: Database.Database;
  private todos: TodosRepository;
  private links: TodoLinksRepository;
  private bus: EventBus | undefined;
  private projectId: string;

  constructor(deps: TodoServiceDeps) {
    this.db = deps.db;
    this.todos = deps.todos;
    this.links = deps.links;
    this.bus = deps.bus;
    this.projectId = deps.project_id ?? "";
  }

  private emit(event: Event): void { this.bus?.emit(event); }

  private envelope(kind: string, actor: string) {
    return { id: newUlid(), kind, actor, created_at: Date.now(), project_id: this.projectId };
  }

  private resolveRecord(ref: string): TodoRecord | null {
    const direct = this.todos.get(ref);
    if (direct) return direct;
    const parsed = parseRef("todo", ref);
    if (!parsed) return null;
    return parsed.kind === "seq" ? this.todos.getBySeq(parsed.seq) : this.todos.get(parsed.id);
  }

  private addLink(
    todoId: string, ref: string, relation: TodoLinkRelation, now: string,
    origin?: OriginFields | null,
  ): void {
    const owner = this.resolveRecord(todoId);
    const ownerId = owner ? owner.id : todoId;
    let targetRef = ref;
    let kind: string;
    switch (relation) {
      case "GOVERNS":
        kind = classifyGovernsTarget(ref);
        break;
      case "BLOCKED_BY":
      case "RELATED_TO": {
        kind = "todo";
        const t = this.resolveRecord(ref);
        targetRef = t ? t.id : ref;
        break;
      }
      case "SPAWNS_FROM":
        kind = "decision";
        break;
      case "RESOLVED_BY":
        kind = "pr";
        break;
      default:
        kind = ref.includes("::") ? "qn" : ref.includes("/") ? "path" : "todo";
    }
    this.links.add({ todo_id: ownerId, target_kind: kind, target_ref: targetRef, relation, created_at: now });

    // A link IS a modification of the owning todo — bump updated_at +
    // last_touched_* in the same beat, closing the pre-existing bug where
    // adding a link never touched the todo row at all (mirrors
    // DecisionService.addLink).
    this.todos.update(ownerId, {
      updated_at: now,
      last_touched_branch: origin?.branch ?? null,
      last_touched_commit: origin?.commit ?? null,
      last_touched_thread: origin?.thread ?? null,
    });
  }

  propose(input: ProposeTodoInput): Todo {
    const now = new Date().toISOString();
    const { id, seq } = mintId(this.db, "todo", (cand) => this.todos.get(cand) != null);
    const origin = input.origin ?? null;
    const rec: TodoRecord = {
      id, seq, summary: input.summary, description: input.description ?? null,
      state: "open", state_reason: null, proposed_by: input.proposed_by ?? "claude",
      proposed_at: now, started_at: null, closed_at: null, assignee: null,
      created_at: now, updated_at: now,
      // Origin is stamped once, here, and never rewritten. Last-touched
      // starts equal to origin.
      origin_branch: origin?.branch ?? null,
      origin_commit: origin?.commit ?? null,
      origin_thread: origin?.thread ?? null,
      last_touched_branch: origin?.branch ?? null,
      last_touched_commit: origin?.commit ?? null,
      last_touched_thread: origin?.thread ?? null,
    };
    this.todos.insert(rec);
    for (const g of input.governs ?? []) this.addLink(id, g, "GOVERNS", now, origin);
    if (input.spawns_from) this.addLink(id, input.spawns_from, "SPAWNS_FROM", now, origin);
    for (const b of input.blocked_by ?? []) this.addLink(id, b, "BLOCKED_BY", now, origin);
    this.emit({ ...this.envelope("todo.proposed", rec.proposed_by ?? "claude"),
      payload: { todo_id: id, summary: input.summary } } as Event);
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
    const changedFields: string[] = [];
    if (input.summary !== undefined) { patch.summary = input.summary; changedFields.push("summary"); }
    if (input.description !== undefined) { patch.description = input.description; changedFields.push("description"); }
    if (input.assignee !== undefined) { patch.assignee = input.assignee; changedFields.push("assignee"); }
    // Rewrite last-touched to the checkout this update came from. undefined
    // (caller didn't thread origin through) leaves last_touched_* untouched
    // rather than nulling out a previously-good value. Origin itself is
    // never touched — TodoRecordUpdate excludes it entirely.
    if (input.origin !== undefined) {
      patch.last_touched_branch = input.origin?.branch ?? null;
      patch.last_touched_commit = input.origin?.commit ?? null;
      patch.last_touched_thread = input.origin?.thread ?? null;
    }
    // Record patch + governance replacement land atomically — same guarantee
    // as DecisionService.update. The replaceLinks transaction nests as a savepoint.
    if (input.governs !== undefined) changedFields.push("governs");
    this.db.transaction(() => {
      this.todos.update(existing.id, patch);
      if (input.governs !== undefined) this.replaceLinks(existing.id, "GOVERNS", input.governs, now, input.origin);
    })();
    this.emit({ ...this.envelope("todo.updated", "claude"),
      payload: { todo_id: existing.id, changed_fields: changedFields } } as Event);
    return rowToTodo({ ...existing, ...patch } as TodoRecord);
  }

  transition(idOrSeq: string, input: TransitionTodoInput): Todo {
    const existing = this.resolveRecord(idOrSeq);
    if (!existing) throw new Error(`Todo not found: ${idOrSeq}`);
    if (!TRANSITIONS[existing.state]?.has(input.to)) {
      throw new Error(`Invalid transition: ${existing.state} → ${input.to}`);
    }
    const from = existing.state;
    const now = new Date().toISOString();
    const patch: Partial<TodoRecord> = { state: input.to, updated_at: now };
    if (input.to === "in_progress" && !existing.started_at) patch.started_at = now;
    if (input.to === "done" || input.to === "cancelled") patch.closed_at = now;
    if (input.to === "blocked" || input.to === "cancelled") patch.state_reason = input.reason ?? null;
    if (input.origin !== undefined) {
      patch.last_touched_branch = input.origin?.branch ?? null;
      patch.last_touched_commit = input.origin?.commit ?? null;
      patch.last_touched_thread = input.origin?.thread ?? null;
    }
    this.todos.update(existing.id, patch);
    if (input.to === "done") for (const pr of input.resolved_by ?? []) this.addLink(existing.id, pr, "RESOLVED_BY", now, input.origin);
    if (input.to === "blocked") for (const b of input.blocked_by ?? []) this.addLink(existing.id, b, "BLOCKED_BY", now, input.origin);
    this.emit({ ...this.envelope("todo.transitioned", "claude"),
      payload: { todo_id: existing.id, from, to: input.to } } as Event);
    return rowToTodo({ ...existing, ...patch } as TodoRecord);
  }

  search(query: string): Todo[] { return this.todos.search(query).map(rowToTodo); }
  list(): Todo[] { return this.todos.list().map(rowToTodo); }

  link(input: LinkTodoInput, origin?: OriginFields | null): void {
    if (!this.resolveRecord(input.todo_id)) throw new Error(`Todo not found: ${input.todo_id}`);
    this.addLink(input.todo_id, input.target, input.relation, new Date().toISOString(), origin);
    this.emit({ ...this.envelope("todo.linked", "claude"),
      payload: { todo_id: input.todo_id, target: input.target, relation: input.relation } } as Event);
  }

  // Delete + insert must commit or roll back together — same guarantee as
  // DecisionService.replaceLinks.
  private replaceLinks(
    todoId: string, relation: TodoLinkRelation, newTargets: string[], now: string,
    origin?: OriginFields | null,
  ): void {
    this.db.transaction(() => {
      const current = this.links.findByTodo(todoId).filter((l) => l.relation === relation);
      const currentRefs = new Set(current.map((l) => l.target_ref));
      const newRefs = new Set(newTargets);
      for (const l of current) if (!newRefs.has(l.target_ref)) this.links.remove(todoId, l.target_kind, l.target_ref, relation);
      for (const t of newTargets) if (!currentRefs.has(t)) this.addLink(todoId, t, relation, now, origin);
    })();
  }
}
