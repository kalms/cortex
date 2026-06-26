import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TSX = join(process.cwd(), "node_modules/.bin/tsx");
const CLI = join(process.cwd(), "src/cli/main.ts");

function run(args: string[], cwd: string, dbPath: string): string {
  return execFileSync(TSX, [CLI, "todo", ...args], {
    cwd, encoding: "utf-8", env: { ...process.env, CORTEX_DECISIONS_DB: dbPath },
  });
}
function runFail(args: string[], cwd: string, dbPath: string): { status: number; stderr: string } {
  try {
    execFileSync(TSX, [CLI, "todo", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CORTEX_DECISIONS_DB: dbPath } });
    return { status: 0, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer | string };
    return { status: err.status ?? 1, stderr: typeof err.stderr === "string" ? err.stderr : err.stderr?.toString() ?? "" };
  }
}

describe("cortex todo write round-trip (flag path)", () => {
  it("propose → show (links) → transition → done", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-todo-w-"));
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    const dbPath = join(root, "todos.db");
    try {
      const created = JSON.parse(run(["propose", "Wire it up", "--governs=src/a.ts", "--spawns-from=D-0j21"], root, dbPath));
      expect(created.summary).toBe("Wire it up");
      expect(created.state).toBe("open");

      const shown = JSON.parse(run(["show", created.id], root, dbPath));
      expect(shown.governs.map((g: { target_ref: string }) => g.target_ref)).toContain("src/a.ts");
      expect(shown.spawns_from.target_ref).toBe("D-0j21");

      const inProgress = JSON.parse(run(["transition", created.id, "in_progress"], root, dbPath));
      expect(inProgress.state).toBe("in_progress");
      const finalized = JSON.parse(run(["transition", created.id, "done"], root, dbPath));
      expect(finalized.state).toBe("done");

      const search = run(["search", "Wire", "--format=plain"], root, dbPath);
      expect(search).toContain(created.id);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects an illegal transition (open → done) with a non-zero exit", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-todo-w-"));
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    const dbPath = join(root, "todos.db");
    try {
      const created = JSON.parse(run(["propose", "Skip a step"], root, dbPath));
      const { status, stderr } = runFail(["transition", created.id, "done"], root, dbPath);
      expect(status).toBe(3); // DomainError
      expect(stderr).toMatch(/Invalid transition/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects --relation=WRONG with exit code 2 (UsageError)", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-todo-w-"));
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    const dbPath = join(root, "todos.db");
    try {
      const created = JSON.parse(run(["propose", "Relation validation test"], root, dbPath));
      const { status, stderr } = runFail(["link", created.id, "src/foo.ts", "--relation=WRONG"], root, dbPath);
      expect(status).toBe(2); // UsageError
      expect(stderr).toMatch(/unknown --relation/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects a nonexistent todo id in link with exit code 3 (DomainError)", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-todo-w-"));
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    const dbPath = join(root, "todos.db");
    try {
      const { status, stderr } = runFail(["link", "T-nonexistent", "src/foo.ts"], root, dbPath);
      expect(status).toBe(3); // DomainError
      expect(stderr).toMatch(/not found/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
