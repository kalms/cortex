import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { TodosRepository } from "../../src/todos/repository.js";
import { TodoLinksRepository } from "../../src/todos/links-repository.js";
import { TodoService } from "../../src/todos/service.js";

const TSX = join(process.cwd(), "node_modules/.bin/tsx");
const CLI = join(process.cwd(), "src/cli/main.ts");

function run(args: string[], cwd: string, dbPath: string): string {
  return execFileSync(TSX, [CLI, "todo", ...args], {
    cwd, encoding: "utf-8", env: { ...process.env, CORTEX_DECISIONS_DB: dbPath },
  });
}

describe("cortex todo list/show (subprocess, live store)", () => {
  it("lists a todo seeded into the resolved store", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-todo-read-"));
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    const dbPath = join(root, "todos.db");
    try {
      const db = openDecisionsDb(dbPath);
      const svc = new TodoService({ db, todos: new TodosRepository(db), links: new TodoLinksRepository(db) });
      const t = svc.propose({ summary: "Seeded task" });
      db.close();
      const out = run(["list", "--format=plain"], root, dbPath);
      expect(out).toContain(t.id);
      expect(out).toContain("Seeded task");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
