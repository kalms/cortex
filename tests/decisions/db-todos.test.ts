import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";

function freshDb() {
  return openDecisionsDb(join(mkdtempSync(join(tmpdir(), "cortex-todos-")), "decisions.db"));
}

describe("openDecisionsDb — todos tables", () => {
  it("creates todos, todo_links, and todos_fts", () => {
    const db = freshDb();
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all()
      .map((r: any) => r.name);
    expect(names).toContain("todos");
    expect(names).toContain("todo_links");
    expect(names).toContain("todos_fts");
  });

  it("FTS stays in sync via triggers on insert", () => {
    const db = freshDb();
    db.prepare(`INSERT INTO todos (id, seq, summary, description, state, proposed_at, created_at, updated_at)
                VALUES ('T-aaaa', 1, 'migrate auth to oauth', 'body', 'open', 't', 't', 't')`).run();
    const hit = db.prepare(`SELECT t.id FROM todos t JOIN todos_fts f ON f.rowid = t.rowid
                            WHERE todos_fts MATCH 'oauth'`).get() as any;
    expect(hit.id).toBe("T-aaaa");
  });

  it("is idempotent — re-open does not throw or duplicate", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-todos-"));
    const p = join(dir, "decisions.db");
    openDecisionsDb(p).close();
    expect(() => openDecisionsDb(p).close()).not.toThrow();
  });
});
