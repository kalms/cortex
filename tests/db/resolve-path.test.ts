import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";
import {
  resolveCortexDbPath,
  resolveDecisionsDbPath,
  resolveGraphDbForRead,
} from "../../src/db/resolve-path.js";

/** Create a graph DB at `path`; populate `nodes` with one row when `withNode`. */
function writeGraphDb(path: string, withNode: boolean): void {
  const db = new BetterSqlite3(path);
  db.exec("CREATE TABLE nodes (id TEXT, kind TEXT, name TEXT, project TEXT, data TEXT)");
  if (withNode) {
    db.prepare("INSERT INTO nodes (id, kind, name) VALUES ('n1','file','a.ts')").run();
  }
  db.close();
}

describe("resolveCortexDbPath", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cortex-resolve-"));
    mkdirSync(join(tmp, ".git"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("finds .git from repo root", () => {
    expect(resolveCortexDbPath(tmp)).toBe(join(tmp, ".cortex", "db"));
  });

  it("walks up from a subdirectory", () => {
    const sub = join(tmp, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(resolveCortexDbPath(sub)).toBe(join(tmp, ".cortex", "db"));
  });

  it("IGNORES CORTEX_DB_PATH when an explicit repo is addressed (per-call routing wins)", () => {
    // Regression guard for the read-path bug: a global override must never
    // collapse an explicitly-addressed repo to one path.
    process.env.CORTEX_DB_PATH = "/tmp/override.db";
    try {
      expect(resolveCortexDbPath(tmp)).toBe(join(tmp, ".cortex", "db"));
    } finally {
      delete process.env.CORTEX_DB_PATH;
    }
  });

  it("honors CORTEX_DB_PATH only for the implicit (no-arg/cwd) case", () => {
    process.env.CORTEX_DB_PATH = "/tmp/override.db";
    try {
      expect(resolveCortexDbPath()).toBe("/tmp/override.db");
    } finally {
      delete process.env.CORTEX_DB_PATH;
    }
  });

  it("falls back to startDir-relative when no .git found", () => {
    const noGit = mkdtempSync(join(tmpdir(), "cortex-nogit-"));
    expect(resolveCortexDbPath(noGit)).toBe(join(noGit, ".cortex", "db"));
    rmSync(noGit, { recursive: true, force: true });
  });
});

describe("resolveGraphDbForRead", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cortex-read-"));
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, ".cortex"));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("returns null when the repo has no store at all", () => {
    expect(resolveGraphDbForRead(repo)).toBeNull();
  });

  it("returns a populated .cortex/db", () => {
    const db = join(repo, ".cortex", "db");
    writeGraphDb(db, true);
    expect(resolveGraphDbForRead(repo)).toBe(db);
  });

  it("skips an empty .cortex/db and returns a populated .cortex/graph.db", () => {
    writeGraphDb(join(repo, ".cortex", "db"), false); // exists, 0 nodes
    const graph = join(repo, ".cortex", "graph.db");
    writeGraphDb(graph, true);
    expect(resolveGraphDbForRead(repo)).toBe(graph);
  });

  it("ignores a non-DB file at a candidate path and uses the populated one", () => {
    writeFileSync(join(repo, ".cortex", "db"), "not a sqlite db");
    const graph = join(repo, ".cortex", "graph.db");
    writeGraphDb(graph, true);
    expect(resolveGraphDbForRead(repo)).toBe(graph);
  });

  it("returns the highest-priority EXISTING path when none are populated", () => {
    const db = join(repo, ".cortex", "db");
    writeGraphDb(db, false); // exists but empty
    expect(resolveGraphDbForRead(repo)).toBe(db);
  });

  it("is independent of CORTEX_DB_PATH (repo-scoped, override never consulted)", () => {
    const db = join(repo, ".cortex", "db");
    writeGraphDb(db, true);
    process.env.CORTEX_DB_PATH = "/tmp/override.db";
    try {
      expect(resolveGraphDbForRead(repo)).toBe(db);
    } finally {
      delete process.env.CORTEX_DB_PATH;
    }
  });
});

describe("resolveDecisionsDbPath", () => {
  let root: string;
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-dec-")));
    execFileSync("git", ["init", "-q"], { cwd: root });
    home = realpathSync(mkdtempSync(join(tmpdir(), "cortex-home-")));
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("resolves to ~/.cortex/<repo-id>/decisions.db, minting the id", () => {
    const p = resolveDecisionsDbPath(root);
    const id = JSON.parse(readFileSync(join(root, "cortex.json"), "utf-8")).repoId;
    expect(p).toBe(join(home, ".cortex", id, "decisions.db"));
  });

  it("is stable across calls (same minted id)", () => {
    expect(resolveDecisionsDbPath(root)).toBe(resolveDecisionsDbPath(root));
  });

  it("honors $CORTEX_DECISIONS_DB override verbatim", () => {
    const override = join(root, "custom", "decisions.db");
    process.env.CORTEX_DECISIONS_DB = override;
    try { expect(resolveDecisionsDbPath(root)).toBe(override); }
    finally { delete process.env.CORTEX_DECISIONS_DB; }
  });

  it("falls back to <startDir>/.cortex/decisions.db outside any git repo", () => {
    const noGit = realpathSync(mkdtempSync(join(tmpdir(), "cortex-nogit2-")));
    try { expect(resolveDecisionsDbPath(noGit)).toBe(join(noGit, ".cortex", "decisions.db")); }
    finally { rmSync(noGit, { recursive: true, force: true }); }
  });
});
