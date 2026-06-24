import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { TodosRepository } from "../../src/todos/repository.js";
import { TodoLinksRepository } from "../../src/todos/links-repository.js";
import { TodoService } from "../../src/todos/service.js";

function svc() {
  const db = openDecisionsDb(join(mkdtempSync(join(tmpdir(), "cortex-trans-")), "decisions.db"));
  return new TodoService({ db, todos: new TodosRepository(db), links: new TodoLinksRepository(db) });
}

describe("TodoService.transition", () => {
  let s: TodoService;
  beforeEach(() => { s = svc(); });

  it("open → in_progress sets started_at", () => {
    const t = s.propose({ summary: "x" });
    const moved = s.transition(t.id, { to: "in_progress" });
    expect(moved.state).toBe("in_progress");
    expect(moved.started_at).not.toBeNull();
  });
  it("in_progress → done sets closed_at and records resolved_by", () => {
    const t = s.propose({ summary: "x" });
    s.transition(t.id, { to: "in_progress" });
    s.transition(t.id, { to: "done", resolved_by: ["42"] });
    const refs = s.getWithRefs(t.id)!;
    expect(refs.state).toBe("done");
    expect(refs.closed_at).not.toBeNull();
    expect(refs.resolved_by.map((r) => r.target_ref)).toEqual(["42"]);
  });
  it("in_progress → blocked records reason + blocked_by", () => {
    const dep = s.propose({ summary: "dep" });
    const t = s.propose({ summary: "x" });
    s.transition(t.id, { to: "in_progress" });
    const blocked = s.transition(t.id, { to: "blocked", reason: "waiting on dep", blocked_by: [dep.id] });
    expect(blocked.state).toBe("blocked");
    expect(blocked.state_reason).toBe("waiting on dep");
    expect(s.getWithRefs(t.id)!.blocked_by.map((b) => b.target_ref)).toEqual([dep.id]);
  });
  it("rejects an invalid transition with no mutation", () => {
    const t = s.propose({ summary: "x" });            // open
    expect(() => s.transition(t.id, { to: "done" })).toThrow(/Invalid transition/);
    expect(s.get(t.id)!.state).toBe("open");
  });
  it("terminal states reject all transitions", () => {
    const t = s.propose({ summary: "x" });
    s.transition(t.id, { to: "cancelled", reason: "nope" });
    expect(() => s.transition(t.id, { to: "in_progress" })).toThrow(/Invalid transition/);
  });
});
