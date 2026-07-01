import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { TodoService } from "../../src/todos/service.js";
import { TodosRepository } from "../../src/todos/repository.js";
import { TodoLinksRepository } from "../../src/todos/links-repository.js";
import { EventBus } from "../../src/events/bus.js";
import type { Event } from "../../src/events/types.js";

function svcWithBus() {
  const db = openDecisionsDb(join(mkdtempSync(join(tmpdir(), "cortex-todoevt-")), "decisions.db"));
  const bus = new EventBus();
  const emitted: Event[] = [];
  bus.onEvent((e) => emitted.push(e));
  const svc = new TodoService({
    db,
    todos: new TodosRepository(db),
    links: new TodoLinksRepository(db),
    bus,
    project_id: "proj-x",
  });
  return { svc, emitted };
}

describe("TodoService event emission", () => {
  it("emits todo.proposed on propose()", () => {
    const { svc, emitted } = svcWithBus();
    const t = svc.propose({ summary: "wire the sync engine" });
    expect(emitted.length).toBe(1);
    const e = emitted[0];
    expect(e.kind).toBe("todo.proposed");
    expect(e.project_id).toBe("proj-x");
    expect(e.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
    if (e.kind === "todo.proposed") {
      expect(e.payload.todo_id).toBe(t.id);
      expect(e.payload.summary).toBe("wire the sync engine");
    }
  });

  it("emits todo.updated with changed_fields on update()", () => {
    const { svc, emitted } = svcWithBus();
    const t = svc.propose({ summary: "a" });
    emitted.length = 0;
    svc.update(t.id, { summary: "b", assignee: "rka" });
    expect(emitted.length).toBe(1);
    expect(emitted[0].kind).toBe("todo.updated");
    if (emitted[0].kind === "todo.updated") {
      expect(emitted[0].payload.changed_fields).toEqual(["summary", "assignee"]);
    }
  });

  it("emits todo.transitioned with from/to on transition()", () => {
    const { svc, emitted } = svcWithBus();
    const t = svc.propose({ summary: "a" });
    emitted.length = 0;
    svc.transition(t.id, { to: "in_progress" });
    expect(emitted[0].kind).toBe("todo.transitioned");
    if (emitted[0].kind === "todo.transitioned") {
      expect(emitted[0].payload.from).toBe("open");
      expect(emitted[0].payload.to).toBe("in_progress");
    }
  });

  it("emits todo.linked on link()", () => {
    const { svc, emitted } = svcWithBus();
    const t = svc.propose({ summary: "a" });
    emitted.length = 0;
    svc.link({ todo_id: t.id, target: "src/viewer/store.js", relation: "GOVERNS" });
    expect(emitted[0].kind).toBe("todo.linked");
    if (emitted[0].kind === "todo.linked") {
      expect(emitted[0].payload.relation).toBe("GOVERNS");
    }
  });

  it("emits nothing without a bus (CLI construction stays silent)", () => {
    const db = openDecisionsDb(join(mkdtempSync(join(tmpdir(), "cortex-todoevt-")), "decisions.db"));
    const svc = new TodoService({ db, todos: new TodosRepository(db), links: new TodoLinksRepository(db) });
    expect(() => svc.propose({ summary: "no bus" })).not.toThrow();
  });
});
