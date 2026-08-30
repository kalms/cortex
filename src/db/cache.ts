import BetterSqlite3 from "better-sqlite3";
import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { indexerBinPath } from "../cli/paths.js";
import { worktreeRoot } from "./git-root.js";
import { cacheSlug } from "./store-paths.js";

const CACHE_DIR = join(homedir(), ".cache", "cortex");

/**
 * The indexer binary's `--version`, or null when it cannot be determined.
 *
 * Resolved via {@link indexerBinPath} (i.e. `repoRoot()`), never relative to
 * `process.cwd()` — the same rule {@link cliVersion} states next door, and for
 * a sharper reason here. A cwd-relative `bin/cortex-indexer` does not resolve
 * whenever the server runs from anywhere but the install root, which is the
 * normal case for an embedded sidecar: Mesh spawns it with cwd set to its own
 * state dir, so this threw on every call and the old code answered with the
 * constant `"unknown"`. A version component that is constant in the field is
 * not a version component — it silently removed indexer-version invalidation
 * from the cache key for every embedded deployment.
 *
 * Null rather than a sentinel, so {@link computeCacheKey} can decline to build
 * a key at all. Serving no cache is always safe; serving one keyed on a
 * constant is not.
 */
function indexerVersion(): string | null {
  const bin = process.env.CORTEX_INDEXER_PATH || indexerBinPath();
  try {
    // execFileSync, not execSync: `bin` is an absolute path that may contain
    // spaces (`~/Library/Application Support/...`), which a shell would split.
    return execFileSync(bin, ["--version"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function grammarPackHash(): string {
  // Post-split the grammars live in the separate cortex-indexer repo, not here,
  // so this dir is normally absent in cortex — that's expected, not an error.
  // Grammar changes ship via a new indexer release with a bumped version, and
  // indexerVersion() (the binary's --version, which includes the version) is
  // already part of the cache key, so it invalidates on grammar changes. The
  // constant below keeps the key stable; the branch survives only for repos
  // that still vendor grammars in-tree (e.g. a local cortex-indexer checkout).
  const grammarRoot = join(process.cwd(), "internal", "indexer", "vendored", "grammars");
  if (!existsSync(grammarRoot)) {
    return "no-grammars";
  }
  const h = createHash("sha256");
  function walk(dir: string) {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else {
        h.update(relative(grammarRoot, p));
        h.update("\0");
        h.update(readFileSync(p));
      }
    }
  }
  walk(grammarRoot);
  return h.digest("hex");
}

function gitTreeHash(repo: string): string {
  try {
    return execSync("git rev-parse HEAD^{tree}", { cwd: repo, encoding: "utf8" }).trim();
  } catch {
    return "no-tree";
  }
}

/** Index depth the indexer binary supports. `full` is the default and indexes
 * every pass; `fast`/`moderate` skip passes, so they produce a different graph
 * and must NOT share a cache entry with `full` (or each other). */
export type IndexMode = "fast" | "moderate" | "full";

/**
 * The project identity a store built for `repo` declares — the same string the
 * indexer writes into `ctx_projects.name` and stamps into every node's
 * `qualified_name`. Checkout axis, so each linked worktree is its own identity.
 */
function repoIdentity(repo: string): string {
  return cacheSlug(worktreeRoot(repo));
}

/**
 * The cache key for `repo`, or null when no key can be trusted.
 *
 * **Repo identity is part of the key, and must stay that way.** A cached store
 * is a whole SQLite file: it carries its writer's `ctx_projects` row, its
 * `root_path`, and its project name baked into every `qualified_name`. Serving
 * one to a different checkout hands that checkout another project's identity,
 * whole — the canvas then queries by its own name, matches nothing, and draws
 * nothing, while every search result comes back annotated with the stranger's
 * name and snippets resolve to paths that may not exist.
 *
 * Keying on the git tree alone made that a certainty rather than a risk: two
 * checkouts of one repo sitting on the same commit have the same tree by
 * definition, which is the *normal* state for a worktree just branched from
 * main. Observed 2026-08-30: an index run replaced a worktree's own store with
 * another worktree's, wholesale, eighteen seconds after an unrelated commit had
 * given the two the same tree. The store's own timestamps showed it had never
 * seen that branch's work — every node carried the other checkout's index time.
 *
 * The adjacent hazard was already guarded at the call site: no `.git` means no
 * tree to key on, "which would let an unrelated repo serve stale results". This
 * is the same hazard one step over — same tree, different repo.
 */
export function computeCacheKey(repo: string, mode: IndexMode = "full"): string | null {
  const version = indexerVersion();
  if (version === null) return null;
  const parts = [version, grammarPackHash(), gitTreeHash(repo), `repo:${repoIdentity(repo)}`];
  // `full` is the historical default — omit it so the full-mode key stays the
  // one a bare `computeCacheKey(repo)` produces. Non-full modes hash a distinct
  // key so a partial snapshot can never be served for a deeper request.
  //
  // This no longer preserves entries written before `mode` existed: adding repo
  // identity above changes every key, so the whole cache misses once and
  // refills. That is the intended trade — entries are a reindex-time
  // optimisation, and a stale miss costs one index while a wrong hit is silent.
  if (mode !== "full") parts.push(`mode:${mode}`);
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

export function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}.db`);
}

export function hasCacheEntry(key: string): boolean {
  return existsSync(cachePath(key));
}

export function writeCacheEntry(key: string, sourceDbPath: string): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  copyFileSync(sourceDbPath, cachePath(key));
}

/** The project name a cached store declares, or null if it declares none or
 *  cannot be read. */
function entryProject(dbPath: string): string | null {
  let db: BetterSqlite3.Database | null = null;
  try {
    db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT name FROM ctx_projects LIMIT 1").get() as { name?: string } | undefined;
    return row?.name ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Copy the cached store for `key` to `destDbPath`.
 *
 * `repo` makes this belt-and-braces rather than merely a copy: the entry must
 * declare the identity this checkout expects, or it is treated as a miss and
 * deleted. Identity is in the key already, so a mismatch should be impossible —
 * which is the point. It costs one `SELECT` against a file we are about to copy
 * anyway, and it is the invariant that actually matters, asserted where it is
 * cheap to assert. It also disposes of entries written by an older build whose
 * key had no identity in it.
 *
 * An entry declaring nothing (no `ctx_projects` row) is allowed through: an
 * empty store is not a foreign one.
 *
 * @returns true if the entry was copied, false on a miss or a rejected entry.
 */
export function readCacheEntry(key: string, destDbPath: string, repo?: string): boolean {
  if (!hasCacheEntry(key)) return false;
  const src = cachePath(key);
  if (repo !== undefined) {
    const declared = entryProject(src);
    if (declared !== null && declared !== repoIdentity(repo)) {
      rmSync(src, { force: true });
      return false;
    }
  }
  copyFileSync(src, destDbPath);
  return true;
}
