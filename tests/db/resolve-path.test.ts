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
  isCanonicalGraphDbPath,
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
    // A real git repo, not just a `.git` dir stub: resolveCortexDbPath now
    // roots via mainWorktreeRoot, which shells out to `git rev-parse` and
    // requires an actual repository — a bare `.git` directory (no HEAD,
    // objects, etc.) satisfied the old existsSync-based findGitRoot walk-up
    // but is correctly rejected by real git as "not a git repository".
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "cortex-resolve-")));
    execFileSync("git", ["init", "-q"], { cwd: tmp });
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
    // realpathSync: matches the discipline the newer worktree-axis test
    // files already use — resolveCortexDbPath's non-git fallback now routes
    // through worktreeRoot → canonicalRepoPath, which realpaths symlinked
    // tmpdirs (e.g. macOS /var → /private/var). A raw mkdtempSync() result
    // would spuriously mismatch even though it names the same directory.
    const noGit = realpathSync(mkdtempSync(join(tmpdir(), "cortex-nogit-")));
    expect(resolveCortexDbPath(noGit)).toBe(join(noGit, ".cortex", "db"));
    rmSync(noGit, { recursive: true, force: true });
  });
});

describe("resolveGraphDbForRead", () => {
  let repo: string;

  beforeEach(() => {
    // realpathSync: this fixture's ".git" is a bare stub dir, not a real
    // repo, so resolveGraphDbForRead's root derivation takes the same
    // non-git fallback as the "no .git found" case above and now realpaths
    // (see the comment there) — match it or a symlinked tmpdir spuriously
    // mismatches.
    repo = realpathSync(mkdtempSync(join(tmpdir(), "cortex-read-")));
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

  it("prefers an empty-but-valid .cortex/db over a populated legacy graph.db", () => {
    // Canonical store wins unconditionally once it's an openable SQLite file:
    // an empty .cortex/db means "reindex needed" and must surface as empty,
    // never be shadowed by a stale sibling graph.db (the 2026-06-09 viewer
    // stale-map bug). graph.db is consulted ONLY when .cortex/db is absent or
    // unopenable garbage.
    writeGraphDb(join(repo, ".cortex", "db"), false); // exists, valid, 0 nodes
    const graph = join(repo, ".cortex", "graph.db");
    writeGraphDb(graph, true);
    expect(resolveGraphDbForRead(repo)).toBe(join(repo, ".cortex", "db"));
  });

  it("prefers a 0-byte .cortex/db over a populated graph.db (drift → reindex, not stale shadow)", () => {
    // A 0-byte .cortex/db is an openable (empty) SQLite DB — the documented
    // drift mode. It must resolve to .cortex/db so freshness flags it `empty`
    // and prompts a reindex, instead of silently serving the stale sibling.
    writeFileSync(join(repo, ".cortex", "db"), "");
    const graph = join(repo, ".cortex", "graph.db");
    writeGraphDb(graph, true);
    expect(resolveGraphDbForRead(repo)).toBe(join(repo, ".cortex", "db"));
  });

  it("falls back to a populated graph.db when .cortex/db is unopenable garbage", () => {
    // Only a structurally-unusable canonical file (not a SQLite DB) cedes to
    // the legacy fallback — a 0-byte or valid-empty .cortex/db does not.
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

describe("isCanonicalGraphDbPath", () => {
  // Guards against eval/merge tooling clobbering a per-repo canonical graph
  // store. The canonical write target is `<gitroot>/.cortex/db`; the legacy
  // read-fallback `<gitroot>/.cortex/graph.db` is also off-limits as a merge
  // target. Anything else (dedicated eval/demo DBs) is allowed.
  it("flags <repo>/.cortex/db", () => {
    expect(isCanonicalGraphDbPath("/Users/x/proj/.cortex/db")).toBe(true);
  });

  it("flags the legacy <repo>/.cortex/graph.db fallback", () => {
    expect(isCanonicalGraphDbPath("/Users/x/proj/.cortex/graph.db")).toBe(true);
  });

  it("normalizes relative + redundant segments before judging", () => {
    expect(isCanonicalGraphDbPath("proj/./.cortex/../.cortex/db")).toBe(true);
  });

  it("allows a dedicated eval/demo DB outside .cortex", () => {
    expect(isCanonicalGraphDbPath("/Users/x/proj/.tmp/eval-shared.db")).toBe(false);
  });

  it("does not flag a file literally named db outside a .cortex dir", () => {
    expect(isCanonicalGraphDbPath("/Users/x/proj/build/db")).toBe(false);
  });

  it("does not flag the sibling decisions DB", () => {
    expect(isCanonicalGraphDbPath("/Users/x/proj/.cortex/decisions.db")).toBe(false);
  });
});

describe("resolveDecisionsDbPath", () => {
  let root: string;
  let home: string;
  let prevCortexHome: string | undefined;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-dec-")));
    execFileSync("git", ["init", "-q"], { cwd: root });
    home = realpathSync(mkdtempSync(join(tmpdir(), "cortex-home-")));
    prevCortexHome = process.env.CORTEX_HOME;
    process.env.CORTEX_HOME = home;
  });
  afterEach(() => {
    if (prevCortexHome === undefined) delete process.env.CORTEX_HOME; else process.env.CORTEX_HOME = prevCortexHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("resolves to ~/.cortex/<repo-id>/decisions.db, minting the id", () => {
    const p = resolveDecisionsDbPath(root);
    const id = JSON.parse(readFileSync(join(root, "cortex.json"), "utf-8")).repoId;
    expect(p).toBe(join(process.env.CORTEX_HOME!, ".cortex", id, "decisions.db"));
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
