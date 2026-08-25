import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  MissingRepoPathError,
  PathNotFoundError,
  NotAGitRepoError,
  RepoNotIndexedError,
  RepoContextResolver,
  WorktreeIndexPendingError,
} from "../../src/mcp-server/repo-context.js";
import { Registry } from "../../src/db/registry.js";

function makeIndexedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-repo-"));
  execSync(`git init -q "${root}"`);
  mkdirSync(join(root, ".cortex"));
  // Create an empty placeholder so the resolver sees this repo as indexed.
  // The resolver's GraphStore construction will initialize the SQLite schema
  // on first open (idempotent CREATE TABLE IF NOT EXISTS), so no real graph
  // data is needed for these tests.
  writeFileSync(join(root, ".cortex", "db"), "");
  return root;
}

function projectSlug(absPath: string): string {
  return absPath.replace(/^\//, "").replace(/\//g, "-");
}

/**
 * Run `fn` with CORTEX_AUTO_INDEX disabled. resolve() on an unindexed
 * checkout now kicks a REAL detached `cortex index` (see kickBackgroundIndex
 * in repo-context.ts); tests that only assert the thrown error SHAPE must
 * not let a real indexer loose on a scratch fixture.
 */
function withAutoIndexDisabled<T>(fn: () => T): T {
  const prev = process.env.CORTEX_AUTO_INDEX;
  process.env.CORTEX_AUTO_INDEX = "0";
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CORTEX_AUTO_INDEX;
    else process.env.CORTEX_AUTO_INDEX = prev;
  }
}

/**
 * Seed a registry entry in the master registry (~/.cache/cortex-indexer/_registry.db).
 * listKnownRepos / list_projects enumerate from the registry now. Returns the
 * slug so teardown can remove it.
 */
function seedRegistryEntry(rootPath: string, name?: string): string {
  const slug = name ?? projectSlug(rootPath);
  const reg = new Registry();
  try { reg.register(slug, rootPath); } finally { reg.close(); }
  return slug;
}

describe("Resolver error classes", () => {
  it("MissingRepoPathError carries name, hint, available_projects", () => {
    const err = new MissingRepoPathError("create_decision", []);
    expect(err.name).toBe("MissingRepoPathError");
    expect(err.message).toContain("create_decision");
    expect(err.hint).toMatch(/list_projects/);
    expect(err.availableProjects).toEqual([]);
  });

  it("PathNotFoundError mentions the path", () => {
    const err = new PathNotFoundError("/no/such/path");
    expect(err.message).toContain("/no/such/path");
  });

  it("NotAGitRepoError carries inferred git_root when known", () => {
    const err = new NotAGitRepoError("/repo/subdir/file", "/repo");
    expect(err.message).toContain("/repo/subdir/file");
    expect(err.gitRoot).toBe("/repo");
  });

  it("RepoNotIndexedError carries available_projects", () => {
    const err = new RepoNotIndexedError("/repo/x", [
      { name: "p", path: "/repo/p", indexed: true },
    ]);
    expect(err.availableProjects).toHaveLength(1);
    expect(err.availableProjects[0].path).toBe("/repo/p");
  });
});

describe("RepoContextResolver.resolve — happy path", () => {
  it("returns a RepoContext for a valid indexed git root", () => {
    const repo = makeIndexedRepo();
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      const ctx = resolver.resolve(repo);
      // ctx.repoPath is the realpath-normalized canonical repo root, which
      // on macOS resolves /tmp → /private/tmp. Compare via realpath so the
      // test is symlink-tolerant.
      expect(ctx.repoPath).toBe(realpathSync(repo));
      expect(ctx.graphDb).toBeDefined();
      expect(ctx.decisionsDb).toBeDefined();
    } finally {
      resolver.shutdown();
    }
  });

  it("returns the same context on repeated calls (pool hit)", () => {
    const repo = makeIndexedRepo();
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      expect(resolver.resolve(repo)).toBe(resolver.resolve(repo));
    } finally {
      resolver.shutdown();
    }
  });
});

describe("RepoContextResolver.resolve — error paths", () => {
  it("throws PathNotFoundError when path does not exist", () => {
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      expect(() => resolver.resolve("/nonexistent/path/abc")).toThrow(PathNotFoundError);
    } finally {
      resolver.shutdown();
    }
  });

  it("throws RepoNotIndexedError (not NotAGitRepoError) for a non-git, unindexed path — T-119", () => {
    // Post-T-119, resolve() never throws NotAGitRepoError: a path outside any
    // git repo routes by its own realpath instead of being rejected, so an
    // unindexed non-git dir surfaces the same RepoNotIndexedError a genuinely
    // non-git-but-indexed dir would clear (see resolve-canonical.test.ts).
    const dir = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      withAutoIndexDisabled(() => {
        expect(() => resolver.resolve(dir)).toThrow(RepoNotIndexedError);
      });
    } finally {
      resolver.shutdown();
    }
  });

  it("throws RepoNotIndexedError when .cortex/graph.db is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "unindexed-repo-"));
    execSync(`git init -q "${root}"`);
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      withAutoIndexDisabled(() => {
        try {
          resolver.resolve(root);
          throw new Error("should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(RepoNotIndexedError);
          expect((e as RepoNotIndexedError).availableProjects).toBeDefined();
        }
      });
    } finally {
      resolver.shutdown();
    }
  });
});

describe("RepoContextResolver.listKnownRepos", () => {
  const seededNames: string[] = [];

  afterEach(() => {
    if (seededNames.length === 0) return;
    const reg = new Registry();
    try { for (const n of seededNames.splice(0)) reg.remove(n); } finally { reg.close(); }
  });

  it("returns pooled repos with indexed=true", () => {
    const repo = makeIndexedRepo();
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      resolver.resolve(repo);
      const list = resolver.listKnownRepos();
      const entry = list.find((p) => p.path === resolver.resolve(repo).repoPath);
      expect(entry).toBeDefined();
      expect(entry!.indexed).toBe(true);
    } finally {
      resolver.shutdown();
    }
  });

  it("reads the master cache registry and surfaces unpooled projects", () => {
    // Phantom path: registry entry need not exist on disk for listKnownRepos
    // to surface it — the registry IS the answer. Use a unique pretend-path
    // so we don't collide with the user's actual indexed repos.
    //
    // NOTE: avoid slugs that start with `tmp-` — the resolver skips those
    // alongside `_*.db` as staging files, mirroring the indexer's convention.
    const phantomRoot = `/cortex-test-phantom-${Date.now()}`;
    const slug = projectSlug(phantomRoot);
    seededNames.push(seedRegistryEntry(phantomRoot, slug));

    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      const list = resolver.listKnownRepos();
      const match = list.find((p) => p.path === phantomRoot);
      expect(match, `expected ${phantomRoot} in ${JSON.stringify(list)}`).toBeDefined();
      expect(match!.name).toBe(slug);
      expect(match!.indexed).toBe(true);
    } finally {
      resolver.shutdown();
    }
  });

  it("dedupes pooled + cache entries on path", () => {
    const repo = makeIndexedRepo();
    // Seed registry to point at the same realpath; pooled should NOT be duplicated.
    seededNames.push(seedRegistryEntry(realpathSync(repo)));
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      resolver.resolve(repo);
      const list = resolver.listKnownRepos();
      // Compare via realpath: resolver normalizes ctx.repoPath through
      // symlinks (macOS /tmp → /private/tmp), so the pooled entry's path
      // is the realpath form, not the symlink form `repo` carries.
      const repoReal = realpathSync(repo);
      const matches = list.filter((p) => p.path === repoReal);
      expect(matches).toHaveLength(1);
    } finally {
      resolver.shutdown();
    }
  });

  it("ignores _config.db and other non-project cache files", () => {
    // Enumeration is now registry-based (_registry.db). The registry never
    // contains a "_config" entry — only real project slugs — so this must
    // always return undefined.
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      const list = resolver.listKnownRepos();
      expect(list.find((p) => p.name === "_config")).toBeUndefined();
      // Sanity check — the cache dir exists on dev machines but we don't
      // require any specific count here.
      expect(existsSync(join(homedir(), ".cache", "cortex-indexer"))).toBeTypeOf("boolean");
    } finally {
      resolver.shutdown();
    }
  });
});

describe("RepoContextResolver.resolve — checkout axis (worktrees no longer collapse)", () => {
  // Two-axis model: the graph/store side keys on the CHECKOUT
  // (`worktreeRoot`, `git rev-parse --show-toplevel`) — a linked worktree
  // resolves to itself and gets its own pooled RepoContext, not the
  // canonical repo's. The repo-identity axis (decisions store, repoId)
  // still routes through `mainWorktreeRoot` and is exposed here via
  // `ctx.worktreeOf`. See src/mcp-server/repo-context.ts JSDoc on resolve().

  function makeCanonicalRepoWithCommit(): string {
    const root = mkdtempSync(join(tmpdir(), "cortex-canonical-"));
    execSync(`git -C "${root}" init -q`);
    execSync(`git -C "${root}" config user.email t@t.test`);
    execSync(`git -C "${root}" config user.name Test`);
    execSync(`git -C "${root}" commit --allow-empty -m init -q`);
    mkdirSync(join(root, ".cortex"));
    writeFileSync(join(root, ".cortex", "db"), "");
    return root;
  }

  it("resolves a worktree path to its OWN checkout root, not the canonical repo", () => {
    const canonical = makeCanonicalRepoWithCommit();
    const wtParent = mkdtempSync(join(tmpdir(), "cortex-wt-"));
    const wtDir = join(wtParent, "wt");
    execSync(
      `git -C "${canonical}" worktree add --quiet "${wtDir}" -b wt-test-branch-${Date.now()}`,
    );
    // Strict reads: give the worktree its OWN store too, so resolve()
    // succeeds without needing (and without being able to use) the Stage 1
    // cross-checkout fallback, which is gone.
    mkdirSync(join(wtDir, ".cortex"));
    writeFileSync(join(wtDir, ".cortex", "db"), "");

    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      const ctx = resolver.resolve(wtDir);
      // ctx.repoPath reflects the checkout the caller passed in — realpath
      // compare to tolerate /private/tmp. worktreeOf still surfaces the
      // canonical repo root (repo-identity axis).
      expect(realpathSync(ctx.repoPath)).toBe(realpathSync(wtDir));
      expect(realpathSync(ctx.worktreeOf!)).toBe(realpathSync(canonical));
    } finally {
      resolver.shutdown();
      try {
        execSync(`git -C "${canonical}" worktree remove --force "${wtDir}"`);
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it("does NOT dedupe worktree and canonical — each gets its own pooled RepoContext", () => {
    const canonical = makeCanonicalRepoWithCommit();
    const wtParent = mkdtempSync(join(tmpdir(), "cortex-wt-"));
    const wtDir = join(wtParent, "wt");
    execSync(
      `git -C "${canonical}" worktree add --quiet "${wtDir}" -b wt-dedupe-branch-${Date.now()}`,
    );
    // Strict reads: the worktree needs its own store to resolve at all now —
    // there is no cross-checkout fallback to ride on.
    mkdirSync(join(wtDir, ".cortex"));
    writeFileSync(join(wtDir, ".cortex", "db"), "");

    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      const ctxFromWorktree = resolver.resolve(wtDir);
      const ctxFromCanonical = resolver.resolve(canonical);
      // Different RepoContext objects — separate pool entries keyed by
      // checkout, each with its own DB handles and its own store.
      expect(ctxFromWorktree).not.toBe(ctxFromCanonical);
    } finally {
      resolver.shutdown();
      try {
        execSync(`git -C "${canonical}" worktree remove --force "${wtDir}"`);
      } catch {
        /* best-effort cleanup */
      }
    }
  });
});

describe("kickBackgroundIndex (via resolve() on an unindexed checkout)", () => {
  // kickBackgroundIndex is not exported — every existing test either sets
  // CORTEX_AUTO_INDEX=0 (skipping the function) or pre-seeds a fresh
  // sentinel (short-circuiting before the spawn), so the actual
  // `spawn(bin, ["index", ".", checkout], …)` line was never exercised by a
  // committed test. Drive it here through resolve() on a genuinely unindexed
  // repo, with CORTEX_BIN pointed at a stub so nothing real gets spawned.

  /** A fake `cortex` CLI that records its argv (one per line, to
   *  `${markerPath}.args`), touches the marker, and exits 0. Mirrors
   *  tests/hooks/prefer-cortex.test.ts's stubCortex. */
  function stubCortex(markerPath: string): string {
    const dir = mkdtempSync(join(tmpdir(), "cortex-kick-stub-"));
    const bin = join(dir, "cortex");
    writeFileSync(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${markerPath}.args"\ntouch "${markerPath}"\n`,
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  /**
   * Poll `predicate` up to timeoutMs, yielding the event loop between checks
   * via a real (async) timer. The detached spawn's completion is async, and
   * so — separately — is the in-process `child.on("error", …)` diagnostic
   * handler this fix adds: a synchronous busy-wait (e.g. blocking on
   * `execFileSync("sleep", …)` in a tight loop) never returns control to
   * Node's event loop between iterations, so it can observe an EXTERNAL
   * process's filesystem writes (which need no callback of ours to run) but
   * will starve our OWN pending `error` callback indefinitely. `await` on a
   * real timer avoids both failure modes.
   */
  async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return predicate();
  }

  /** Set env vars for the duration of `fn`, then restore exactly what was there. */
  function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) prev[k] = process.env[k];
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  function makeUnindexedRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "cortex-kick-repo-"));
    execSync(`git init -q "${root}"`);
    return realpathSync(root); // realpath: macOS /tmp -> /private/tmp
  }

  it("spawns `cortex index . <checkout>`, writes the sentinel, and reports pending", async () => {
    const checkout = makeUnindexedRepo();
    const marker = join(checkout, ".index-fired");
    const bin = stubCortex(marker);

    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      withEnv({ CORTEX_BIN: bin, CORTEX_AUTO_INDEX: undefined }, () => {
        // Never CORTEX_AUTO_INDEX=0'd and no pre-seeded sentinel: this is the
        // path that actually reaches the spawn. WorktreeIndexPendingError
        // (rather than RepoNotIndexedError) is only thrown when
        // kickBackgroundIndex returned true, i.e. the spawn was issued.
        expect(() => resolver.resolve(checkout)).toThrow(WorktreeIndexPendingError);
      });

      expect(await waitFor(() => existsSync(marker))).toBe(true);
      expect(existsSync(join(checkout, ".cortex", ".auto-index-attempted"))).toBe(true);

      // Invocation form must be one the real CLI accepts: `index . <path>`
      // (the `.` makes "index" the command; <path> is the positional target).
      const recordedArgs = readFileSync(`${marker}.args`, "utf-8").trim().split("\n");
      expect(recordedArgs).toEqual(["index", ".", checkout]);
    } finally {
      resolver.shutdown();
    }
  });

  it("never throws from the kick itself when CORTEX_BIN is unresolvable, and logs the swallowed spawn error", async () => {
    const checkout = makeUnindexedRepo();
    const badBin = join(checkout, "no-such-cortex-binary-abc123");
    const logPath = join(checkout, ".cortex", "auto-index.log");

    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      withEnv({ CORTEX_BIN: badBin, CORTEX_AUTO_INDEX: undefined }, () => {
        // "Never throws" is about kickBackgroundIndex's own contract: an
        // unresolvable binary must not crash the process (unhandled 'error'
        // on the child) or propagate synchronously. resolve() still raises
        // its documented WorktreeIndexPendingError — kickBackgroundIndex
        // optimistically returns true once the spawn is issued, and the
        // ENOENT only surfaces asynchronously afterward.
        expect(() => resolver.resolve(checkout)).toThrow(WorktreeIndexPendingError);
      });

      const gotDiagnostic = await waitFor(() => {
        if (!existsSync(logPath)) return false;
        return readFileSync(logPath, "utf-8").length > 0;
      });
      expect(gotDiagnostic).toBe(true);
      const content = readFileSync(logPath, "utf-8");
      expect(content).toContain(badBin);
    } finally {
      resolver.shutdown();
    }
  });
});
