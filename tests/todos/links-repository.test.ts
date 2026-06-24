import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { TodosRepository } from "../../src/todos/repository.js";
import { TodoLinksRepository } from "../../src/todos/links-repository.js";

describe("TodoLinksRepository", () => {
  let links: TodoLinksRepository;
  let todos: TodosRepository;
  beforeEach(() => {
    const db = openDecisionsDb(join(mkdtempSync(join(tmpdir(), "cortex-todolinks-")), "decisions.db"));
    todos = new TodosRepository(db);
    links = new TodoLinksRepository(db);
    for (const id of ["T-aaaa", "T-bbbb"]) {
      todos.insert({ id, seq: 1, summary: id, description: null, state: "open",
        state_reason: null, proposed_by: null, proposed_at: "t", started_at: null,
        closed_at: null, assignee: null, created_at: "t", updated_at: "t" });
    }
  });

  it("add + findByTodo", () => {
    links.add({ todo_id: "T-aaaa", target_kind: "todo", target_ref: "T-bbbb", relation: "BLOCKED_BY", created_at: "t" });
    expect(links.findByTodo("T-aaaa")).toHaveLength(1);
  });

  it("findBlocking derives `blocks` (reverse of BLOCKED_BY)", () => {
    // T-aaaa is BLOCKED_BY T-bbbb  ⇒  T-bbbb blocks T-aaaa
    links.add({ todo_id: "T-aaaa", target_kind: "todo", target_ref: "T-bbbb", relation: "BLOCKED_BY", created_at: "t" });
    const blocking = links.findBlocking("T-bbbb");
    expect(blocking.map((l) => l.todo_id)).toEqual(["T-aaaa"]);
  });

  it("remove deletes a specific link", () => {
    links.add({ todo_id: "T-aaaa", target_kind: "pr", target_ref: "42", relation: "RESOLVED_BY", created_at: "t" });
    expect(links.remove("T-aaaa", "pr", "42", "RESOLVED_BY")).toBe(true);
    expect(links.findByTodo("T-aaaa")).toHaveLength(0);
  });
});
