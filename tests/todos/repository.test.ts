import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { TodosRepository } from "../../src/todos/repository.js";
import type { TodoRecord } from "../../src/todos/types.js";

function rec(over: Partial<TodoRecord> = {}): TodoRecord {
  return {
    id: "T-aaaa", seq: 1, summary: "migrate auth to oauth", description: "body",
    state: "open", state_reason: null, proposed_by: "rka", proposed_at: "t",
    started_at: null, closed_at: null, assignee: null, created_at: "t", updated_at: "t",
    ...over,
  };
}

describe("TodosRepository", () => {
  let repo: TodosRepository;
  beforeEach(() => {
    const db = openDecisionsDb(join(mkdtempSync(join(tmpdir(), "cortex-todorepo-")), "decisions.db"));
    repo = new TodosRepository(db);
  });

  it("insert + get round-trips", () => {
    repo.insert(rec());
    expect(repo.get("T-aaaa")?.summary).toBe("migrate auth to oauth");
  });
  it("getBySeq resolves by per-repo seq", () => {
    repo.insert(rec({ id: "T-bbbb", seq: 7 }));
    expect(repo.getBySeq(7)?.id).toBe("T-bbbb");
  });
  it("update patches fields", () => {
    repo.insert(rec());
    repo.update("T-aaaa", { state: "in_progress", started_at: "now" });
    expect(repo.get("T-aaaa")?.state).toBe("in_progress");
  });
  it("search hits FTS over summary/description", () => {
    repo.insert(rec());
    expect(repo.search("oauth").map((t) => t.id)).toEqual(["T-aaaa"]);
    expect(repo.search("nonexistentterm")).toEqual([]);
  });
  it("delete removes the row", () => {
    repo.insert(rec());
    expect(repo.delete("T-aaaa")).toBe(true);
    expect(repo.get("T-aaaa")).toBeNull();
  });
});
