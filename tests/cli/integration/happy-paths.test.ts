import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import BetterSqlite3 from "better-sqlite3";
import { runIndexCommand } from "../../../src/cli/commands/index.js";
import { loadContext, deriveProjectName } from "../../../src/cli/context.js";
import { Registry } from "../../../src/db/registry.js";

const CORTEX = resolve(process.cwd(), "bin/cortex");

function run(args: string[]): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(CORTEX, args, { encoding: "utf-8" });
    return { stdout, stderr: "", code: 0 };
  } catch (e: any) {
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : "",
      code: typeof e.status === "number" ? e.status : 1,
    };
  }
}

describe("cli integration — happy paths", () => {
  it("--version prints a version", () => {
    const r = run(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/cortex \d+\.\d+\.\d+/);
  });

  it("--help prints top-level help", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Namespaces:");
    expect(r.stdout).toContain("code");
  });

  it("code --help prints namespace help", () => {
    const r = run(["code", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("search");
  });

  it("help qualified-names prints the topic", () => {
    const r = run(["help", "qualified-names"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("qualified name");
  });

  it("unknown namespace returns code 2", () => {
    const r = run(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown namespace");
  });
});

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
}

// Real-indexer integration: exercises the checkout-axis change end to end
// (worktreeRoot in runIndexCommand's entry + the registry meta it records).
// Fixture matches tests/db/worktree-root.test.ts (main checkout + a linked
// worktree on branch "feature/x") so both tests can assert the same
// worktree_of/branch values a reader would expect from that reference fixture.
describe("cli integration — checkout-axis indexing", () => {
  let base: string, main: string, wt: string;
  let origIndexerPath: string | undefined;
  let origRegistryDb: string | undefined;

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "cortex-idx-wt-")));
    main = join(base, "main");
    mkdirSync(main);
    git(main, "init", "-b", "main");
    git(main, "config", "user.email", "t@t.t");
    git(main, "config", "user.name", "t");
    writeFileSync(join(main, "a.txt"), "a");
    git(main, "add", "-A");
    git(main, "commit", "-m", "init");
    wt = join(base, "wt");
    git(main, "worktree", "add", "-b", "feature/x", wt);

    // Never let this suite shell out against the developer's real registry.
    origRegistryDb = process.env.CORTEX_REGISTRY_DB;
    process.env.CORTEX_REGISTRY_DB = join(base, "registry.db");

    // Point at the primary checkout's real indexer binary. In this worktree
    // bin/cortex-indexer is already a symlink to that same binary, so
    // runIndexCommand's INDEXER_BIN (resolved from cli/paths.ts, which does
    // NOT read this env var) shells out to the real thing regardless — this
    // assignment documents intent and is harmless.
    origIndexerPath = process.env.CORTEX_INDEXER_PATH;
    process.env.CORTEX_INDEXER_PATH = resolve(process.cwd(), "..", "cortex", "bin", "cortex-indexer");
  });

  afterAll(() => {
    if (origRegistryDb === undefined) delete process.env.CORTEX_REGISTRY_DB;
    else process.env.CORTEX_REGISTRY_DB = origRegistryDb;
    if (origIndexerPath === undefined) delete process.env.CORTEX_INDEXER_PATH;
    else process.env.CORTEX_INDEXER_PATH = origIndexerPath;
    rmSync(base, { recursive: true, force: true });
  });

  it("indexes a linked worktree into its own .cortex/db", async () => {
    await runIndexCommand(
      { command: ".", positionals: [wt], flags: {} },
      loadContext(wt),
    );
    expect(existsSync(join(wt, ".cortex", "db"))).toBe(true);
    expect(existsSync(join(main, ".cortex", "db"))).toBe(false);
  }, 30_000);

  // Regression: ruevu/cortex#81. A live store written before the indexer grew
  // ctx_projects.extract_schema used to fail at publish — AFTER the run had
  // printed its node and frame counts — so the freshly built index was
  // discarded and the stale graph stayed live, silently.
  it("publishes into a live store that predates an indexer column addition", async () => {
    await runIndexCommand({ command: ".", positionals: [wt], flags: {} }, loadContext(wt));
    const dbPath = join(wt, ".cortex", "db");

    // Age the live store back to the pre-extract_schema shape.
    const down = new BetterSqlite3(dbPath);
    down.exec("ALTER TABLE ctx_projects DROP COLUMN extract_schema");
    down.prepare("UPDATE ctx_projects SET indexed_at = '1970-01-01T00:00:00Z'").run();
    down.close();

    await runIndexCommand({ command: ".", positionals: [wt], flags: {} }, loadContext(wt));

    const db = new BetterSqlite3(dbPath, { readonly: true });
    const cols = (db.pragma("table_info(ctx_projects)") as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("extract_schema");
    // The publish actually landed — not the stale row the downgrade left behind.
    const row = db.prepare("SELECT indexed_at FROM ctx_projects").get() as { indexed_at: string };
    expect(row.indexed_at).not.toBe("1970-01-01T00:00:00Z");
    db.close();
  }, 60_000);

  it("registers a worktree with its parent and branch", async () => {
    const regPath = join(base, "registry.db");
    process.env.CORTEX_REGISTRY_DB = regPath;
    try {
      await runIndexCommand({ command: ".", positionals: [wt], flags: {} }, loadContext(wt));
      const reg = new Registry(regPath);
      const row = reg.findByName(deriveProjectName(wt))!;
      expect(row.worktree_of).toBe(main);
      expect(row.branch).toBe("feature/x");
      reg.close();
    } finally {
      process.env.CORTEX_REGISTRY_DB = origRegistryDb ?? join(base, "registry.db");
    }
  }, 30_000);
});
