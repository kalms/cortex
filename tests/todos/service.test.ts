import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { TodosRepository } from "../../src/todos/repository.js";
import { TodoLinksRepository } from "../../src/todos/links-repository.js";
import { TodoService } from "../../src/todos/service.js";

function svc() {
  const db = openDecisionsDb(join(mkdtempSync(join(tmpdir(), "cortex-todosvc-")), "decisions.db"));
  return new TodoService({ db, todos: new TodosRepository(db), links: new TodoLinksRepository(db) });
}

describe("TodoService", () => {
  let s: TodoService;
  beforeEach(() => { s = svc(); });

  it("propose mints a T- id, seq, and open state", () => {
    const t = s.propose({ summary: "migrate auth", description: "to oauth" });
    expect(t.id).toMatch(/^T-[0-9abcdefghjkmnpqrstvwxyz]{4}$/);
    expect(t.seq).toBe(1);
    expect(t.state).toBe("open");
  });
  it("propose records governs / spawns_from / blocked_by links", () => {
    const dep = s.propose({ summary: "dep" });
    const t = s.propose({ summary: "main", governs: ["src/a.ts"], spawns_from: "D-zzzz", blocked_by: [dep.id] });
    const refs = s.getWithRefs(t.id)!;
    expect(refs.governs.map((g) => g.target_ref)).toEqual(["src/a.ts"]);
    expect(refs.spawns_from?.target_ref).toBe("D-zzzz");
    expect(refs.blocked_by.map((b) => b.target_ref)).toEqual([dep.id]);
  });
  it("get resolves bare seq and T-<seq>", () => {
    const t = s.propose({ summary: "x" });
    expect(s.get(String(t.seq))?.id).toBe(t.id);
    expect(s.get(`T-${t.seq}`)?.id).toBe(t.id);
  });
  it("update replaces governs as a full set", () => {
    const t = s.propose({ summary: "x", governs: ["a", "b"] });
    s.update(t.id, { governs: ["b", "c"] });
    expect(s.getWithRefs(t.id)!.governs.map((g) => g.target_ref).sort()).toEqual(["b", "c"]);
  });
  it("getWithRefs exposes derived blocks", () => {
    const a = s.propose({ summary: "a" });
    const b = s.propose({ summary: "b", blocked_by: [a.id] });
    expect(s.getWithRefs(a.id)!.blocks.map((x) => x.target_ref)).toEqual([b.id]);
  });

  // Fix 1 regression: GOVERNS ref with T- prefix must classify as path, not todo
  it("governs a T-prefixed path ref gets target_kind 'path', not 'todo'", () => {
    const t = s.propose({ summary: "migration", governs: ["T-legacy/file.ts"] });
    const refs = s.getWithRefs(t.id)!;
    expect(refs.governs[0].target_kind).toBe("path");
    expect(refs.governs[0].target_ref).toBe("T-legacy/file.ts");
  });

  it("spawns_from target_kind is 'decision'", () => {
    const t = s.propose({ summary: "child", spawns_from: "D-zzzz" });
    const refs = s.getWithRefs(t.id)!;
    expect(refs.spawns_from?.target_kind).toBe("decision");
  });

  it("update throws on missing id", () => {
    expect(() => s.update("T-nope", { summary: "x" })).toThrow(/not found/i);
  });

  it("link happy path: RELATED_TO stored with correct target_ref", () => {
    const t = s.propose({ summary: "linker" });
    s.link({ todo_id: t.id, target: "src/b.ts", relation: "RELATED_TO" });
    expect(s.getWithRefs(t.id)!.related_to[0].target_ref).toBe("src/b.ts");
  });

  it("search returns matching todo and empty for nonexistent term", () => {
    s.propose({ summary: "xyzzyunique term for search" });
    expect(s.search("xyzzyunique").length).toBeGreaterThan(0);
    expect(s.search("no_such_term_ever_exists_1234")).toEqual([]);
  });

  it("list returns all proposed todos", () => {
    s.propose({ summary: "first" });
    s.propose({ summary: "second" });
    expect(s.list().length).toBe(2);
  });

  it("get returns null for missing id", () => {
    expect(s.get("T-0000")).toBeNull();
  });
});
