import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
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
  let db: Database.Database;
  beforeEach(() => {
    db = openDecisionsDb(join(mkdtempSync(join(tmpdir(), "cortex-todorepo-")), "decisions.db"));
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

  it("update silently drops write-once keys even when a caller bypasses the compile-time exclusion", () => {
    // TodoRecordUpdate excludes origin_*/id/seq/created_at at compile time,
    // but that guard is walkable with `as never` — proves the runtime
    // allow-list in TodosRepository.update is the actual backstop (mirrors
    // the equivalent DecisionsRepository test).
    repo.insert(rec({ origin_branch: "feature/orig", origin_commit: "aaa" } as never));
    repo.update("T-aaaa", {
      origin_branch: "HACKED-AT-REPO-LEVEL",
      origin_commit: "HACKED",
      id: "not-T-aaaa",
      seq: 999,
      created_at: "1970-01-01T00:00:00Z",
      summary: "still updates ordinary fields",
    } as never);
    // TodosRepository.get()'s COLS doesn't project origin_* (a pre-existing
    // gap predating this task) — query the raw row instead.
    const row = db.prepare("SELECT * FROM todos WHERE id='T-aaaa'").get() as Record<string, unknown>;
    expect(row.origin_branch).toBe("feature/orig"); // NOT overwritten
    expect(row.origin_commit).toBe("aaa"); // NOT overwritten
    expect(row.created_at).toBe("t"); // NOT overwritten
    expect(row.summary).toBe("still updates ordinary fields"); // ordinary field still applies
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
