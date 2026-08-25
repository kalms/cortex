import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import {
  resolveCortexDbPath,
  resolveDecisionsDbPath,
  resolveGraphDbForRead,
} from "../../src/db/resolve-path.js";

describe("resolve-path — checkout axis (worktree)", () => {
  let main: string;
  let wt: string;
  beforeAll(() => {
    main = realpathSync(mkdtempSync(join(tmpdir(), "cortex-rp-")));
    execSync(`git init -q "${main}"`);
    execSync(`git -C "${main}" commit -q --allow-empty -m init`);
    mkdirSync(join(main, ".cortex"));
    writeFileSync(join(main, ".cortex", "db"), ""); // openable (0-byte) SQLite
    wt = realpathSync(mkdtempSync(join(tmpdir(), "cortex-rp-wt-")));
    execSync(`git -C "${main}" worktree add -q "${wt}"`);
  });

  afterAll(() => {
    rmSync(wt, { recursive: true, force: true });
    rmSync(main, { recursive: true, force: true });
  });

  it("resolveCortexDbPath points a worktree at its OWN .cortex/db", () => {
    expect(resolveCortexDbPath(wt)).toBe(join(wt, ".cortex", "db"));
  });

  it("resolveCortexDbPath(subdir) points at the canonical root db", () => {
    const sub = join(main, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(resolveCortexDbPath(sub)).toBe(join(main, ".cortex", "db"));
  });

  it("resolveDecisionsDbPath still collapses a worktree to the shared store", () => {
    expect(resolveDecisionsDbPath(wt)).toBe(resolveDecisionsDbPath(main));
  });

  it("resolveGraphDbForRead returns null when the worktree has no store of its own (no cross-checkout fallback)", () => {
    // Re-fixtured for strict reads: an earlier "Stage 1" transitional cut
    // ceded to the canonical root's db here. That fallback is gone — a
    // checkout with nothing of its own resolves to null even though its
    // canonical repo (`main`) is fully indexed, and the caller
    // (RepoContextResolver.resolve) raises RepoNotIndexedError /
    // WorktreeIndexPendingError rather than silently reading another branch.
    expect(resolveGraphDbForRead(wt)).toBeNull();
  });

  it("resolveGraphDbForRead prefers the worktree store when it is POPULATED", () => {
    mkdirSync(join(wt, ".cortex"), { recursive: true });
    seedNodes(join(wt, ".cortex", "db"));
    expect(resolveGraphDbForRead(wt)).toBe(join(wt, ".cortex", "db"));
  });

  it("resolveGraphDbForRead returns null again once the worktree store is removed, regardless of the canonical repo's store", () => {
    // Re-fixtured for strict reads (was "falls back to canonical again").
    rmSync(join(wt, ".cortex"), { recursive: true, force: true });
    mkdirSync(join(main, ".cortex"), { recursive: true });
    new BetterSqlite3(join(main, ".cortex", "db")).close();
    expect(resolveGraphDbForRead(wt)).toBeNull();
  });
});

/** Create an openable SQLite file whose `nodes` table has at least one row —
 *  what `hasNodes()` in resolve-path.ts calls "populated". */
function seedNodes(dbPath: string): void {
  const db = new BetterSqlite3(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS nodes (id TEXT); INSERT INTO nodes VALUES ('n1')");
  db.close();
}

/**
 * Regression — finding 1(b), re-fixtured for strict reads. Merely BOOTING the
 * server in a worktree creates an empty `<wt>/.cortex/db` (mkdirSync + `new
 * GraphStore` in src/index.ts). Under the old Stage 1 fallback this
 * empty-but-openable file had to be specially excluded from "usable" so it
 * didn't shadow the canonical store. Under strict reads there is no
 * cross-checkout fallback to shadow: an empty-but-openable checkout store is
 * simply THIS checkout's own (under-populated) graph and must resolve to
 * itself uniformly — main checkout, orphan worktree, or worktree-with-an-
 * indexed-canonical-parent all behave the same way now.
 */
describe("resolve-path — an EMPTY checkout store always resolves to itself", () => {
  let main: string;
  let wt: string;

  beforeAll(() => {
    main = realpathSync(mkdtempSync(join(tmpdir(), "cortex-rp-empty-")));
    execSync(`git init -q "${main}"`);
    execSync(`git -C "${main}" commit -q --allow-empty -m init`);
    mkdirSync(join(main, ".cortex"));
    seedNodes(join(main, ".cortex", "db"));
    wt = realpathSync(mkdtempSync(join(tmpdir(), "cortex-rp-empty-wt-")));
    execSync(`git -C "${main}" worktree add -q "${wt}"`);
  });

  afterAll(() => {
    rmSync(wt, { recursive: true, force: true });
    rmSync(main, { recursive: true, force: true });
  });

  it("a worktree whose own store is present-but-empty reads ITS OWN store, never the canonical one", () => {
    // Re-fixtured for strict reads (was "...still reads the canonical
    // store"): the empty file is this checkout's own graph, not a stand-in
    // for its (indexed, populated) canonical parent's.
    mkdirSync(join(wt, ".cortex"), { recursive: true });
    new BetterSqlite3(join(wt, ".cortex", "db")).close(); // valid, zero nodes
    expect(resolveGraphDbForRead(wt)).toBe(join(wt, ".cortex", "db"));
  });

  it("a MAIN checkout still resolves its own EMPTY store (freshness must see `empty`, not `not indexed`)", () => {
    const solo = realpathSync(mkdtempSync(join(tmpdir(), "cortex-rp-solo-")));
    try {
      execSync(`git init -q "${solo}"`);
      execSync(`git -C "${solo}" commit -q --allow-empty -m init`);
      mkdirSync(join(solo, ".cortex"));
      new BetterSqlite3(join(solo, ".cortex", "db")).close(); // valid, zero nodes
      expect(resolveGraphDbForRead(solo)).toBe(join(solo, ".cortex", "db"));
    } finally {
      rmSync(solo, { recursive: true, force: true });
    }
  });

  it("a worktree with NO canonical store to cede to still resolves its own empty store", () => {
    const orphanMain = realpathSync(mkdtempSync(join(tmpdir(), "cortex-rp-orphan-")));
    const orphanWt = realpathSync(mkdtempSync(join(tmpdir(), "cortex-rp-orphan-wt-")));
    try {
      execSync(`git init -q "${orphanMain}"`);
      execSync(`git -C "${orphanMain}" commit -q --allow-empty -m init`);
      execSync(`git -C "${orphanMain}" worktree add -q "${orphanWt}"`);
      mkdirSync(join(orphanWt, ".cortex"), { recursive: true });
      new BetterSqlite3(join(orphanWt, ".cortex", "db")).close();
      expect(resolveGraphDbForRead(orphanWt)).toBe(join(orphanWt, ".cortex", "db"));
    } finally {
      rmSync(orphanWt, { recursive: true, force: true });
      rmSync(orphanMain, { recursive: true, force: true });
    }
  });
});
