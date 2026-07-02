import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { TodosRepository } from "../../src/todos/repository.js";
import { TodoLinksRepository, type TodoLink } from "../../src/todos/links-repository.js";
import { TodoService } from "../../src/todos/service.js";

/** Fault injection: throws on insert of a sentinel target, after deletes ran. */
class FailingTodoLinks extends TodoLinksRepository {
  override add(link: TodoLink): void {
    if (link.target_ref === "src/boom.ts") throw new Error("injected insert failure");
    super.add(link);
  }
}

describe("TodoService.update — link replacement is atomic", () => {
  let dir: string;
  let db: Database.Database;
  let links: TodoLinksRepository;
  let svc: TodoService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-todo-txn-links-"));
    db = openDecisionsDb(join(dir, "decisions.db"));
    links = new FailingTodoLinks(db);
    svc = new TodoService({
      db,
      todos: new TodosRepository(db),
      links,
    });
  });

  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  function governsFor(todoId: string): string[] {
    return links.findByTodo(todoId)
      .filter((l) => l.relation === "GOVERNS")
      .map((l) => l.target_ref)
      .sort();
  }

  it("keeps the old GOVERNS set when an insert fails mid-replacement", () => {
    const t = svc.propose({ summary: "S", governs: ["src/a.ts", "src/b.ts"] });
    expect(() => svc.update(t.id, { governs: ["src/boom.ts"] })).toThrow("injected insert failure");
    expect(governsFor(t.id)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("rolls back the record patch when link replacement fails", () => {
    const t = svc.propose({ summary: "S", governs: ["src/a.ts"] });
    expect(() => svc.update(t.id, { summary: "S2", governs: ["src/boom.ts"] })).toThrow();
    expect(svc.get(t.id)?.summary).toBe("S");
    expect(governsFor(t.id)).toEqual(["src/a.ts"]);
  });

  it("rolls back removals AND partial inserts together", () => {
    const t = svc.propose({ summary: "S", governs: ["src/old.ts"] });
    expect(() => svc.update(t.id, { governs: ["src/aaa.ts", "src/boom.ts"] })).toThrow();
    expect(governsFor(t.id)).toEqual(["src/old.ts"]);
  });
});
