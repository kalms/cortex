import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import type { ProjectContext } from "../context.js";
import { UsageError } from "../errors.js";
import { indexerBinPath } from "../paths.js";
import { unwrapIndexerResult, renderIndexerResult } from "../indexer-output.js";
import { startSpinner } from "../style.js";
import { runFrameExtraction, type FrameResult } from "../../frame-extraction/run-frames.js";
import { runContractExtraction } from "../../contracts/run-contracts.js";
import type { ContractResult } from "../../contracts/types.js";
import { deriveProjectName } from "../../frame-extraction/cluster-tfidf-hdbscan.js";
import { resolveCortexDbPath } from "../../db/resolve-path.js";
import { Registry } from "../../db/registry.js";
import { captureIndexMeta } from "../../graph/capture-index-meta.js";
import type { IndexMode } from "../../db/cache.js";
import { stagingDbPath, cleanupStagingDb } from "../../db/staging-path.js";
import { publishStagedDb } from "../../db/swap-graph-db.js";
import { withIndexLock } from "../../db/index-lock.js";
import { worktreeRoot, mainWorktreeRoot } from "../../db/git-root.js";
import { gitBranch } from "../../git/worktree-state.js";
import { reapRepoSlugCache, sweepCurrentRepo } from "../../db/store-gc.js";

const execFileAsync = promisify(execFile);

const INDEXER_BIN = indexerBinPath();

const INDEX_MODES: readonly IndexMode[] = ["fast", "moderate", "full"];

/**
 * Resolve the optional `--mode` flag for `cortex index` into a validated
 * {@link IndexMode}. Returns `undefined` when the flag is absent (the indexer
 * defaults to `full`). Throws {@link UsageError} on an unknown value or a bare
 * `--mode` (which the router parses as `true`).
 */
export function resolveIndexMode(flags: Record<string, string | boolean>): IndexMode | undefined {
  const raw = flags.mode;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !INDEX_MODES.includes(raw as IndexMode)) {
    throw new UsageError(
      `invalid --mode '${String(raw)}'`,
      `Usage: cortex index [path] --mode=<${INDEX_MODES.join("|")}>`,
    );
  }
  return raw as IndexMode;
}

export type IndexCommand = {
  command: string | null;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

/** SessionStart current-repo storage sweep — reaps this repo's guarded slug
 *  cache + stale `db.stage-*` + stale `tmp-ctx_incr_*` (see {@link sweepCurrentRepo}).
 *  Best-effort and silent by default: never throws, and only emits a
 *  one-line stderr summary when `CORTEX_CLI_DEBUG=1`. No-op when
 *  `CORTEX_GC=0`. Called both from `cortex index sweep` and, indirectly,
 *  the SessionStart hook (hooks/check-index.sh). */
export function runSweep(repoRoot: string): void {
  if (process.env.CORTEX_GC === "0") return;
  try {
    const res = sweepCurrentRepo(repoRoot);
    if (res.bytes > 0 && process.env.CORTEX_CLI_DEBUG === "1") {
      process.stderr.write(`cortex gc: reclaimed ${(res.bytes / 1e6).toFixed(1)}MB (${res.removed.length} files)\n`);
    }
  } catch { /* best-effort */ }
}

export async function runIndexCommand(cmd: IndexCommand, ctx: ProjectContext): Promise<void> {
  // 'cortex index' with no subcommand → index the cwd (or given path)
  if (cmd.command === null || cmd.command === undefined || cmd.command === ".") {
    // Checkout axis: index the working tree the caller named. A linked worktree
    // gets its own store and its own lock, so worktrees index concurrently
    // without contending with the main checkout.
    const repoPath = worktreeRoot(resolve(cmd.positionals[0] ?? ctx.cwd));
    const mode = resolveIndexMode(cmd.flags);
    const dbPath = resolveCortexDbPath(repoPath); // <repo>/.cortex/db — canonical READ/PUBLISH target

    await withIndexLock(repoPath, async () => {
      const stagePath = stagingDbPath(repoPath);    // build target — no live handle holds it
      cleanupStagingDb(stagePath);                  // clear any stale staging from an interrupted run
      try {
        const indexerArgs = mode ? { repo_path: repoPath, mode } : { repo_path: repoPath };
        const project = deriveProjectName(repoPath);

        const spinner = startSpinner(`indexing ${project}…`);
        let result;
        try {
          const { stdout: raw, stderr } = await execFileAsync(
            INDEXER_BIN,
            ["cli", "index_repository", JSON.stringify(indexerArgs)],
            {
              encoding: "utf-8",
              maxBuffer: 64 * 1024 * 1024, // indexer can emit a large MCP envelope
              env: { ...process.env, CORTEX_DB: stagePath },
            },
          );
          result = unwrapIndexerResult(raw);
          if (process.env.CORTEX_CLI_DEBUG === "1" && stderr) process.stderr.write(stderr);
        } catch (e) {
          spinner.fail("indexing failed");
          throw e;
        }

        // renderIndexerResult throws on a failed index today, but guard explicitly
        // so a future refactor can't let frames/register run against an empty
        // .cortex/db (which would leave a registry row pointing at no graph).
        if (result.isError) {
          spinner.fail("indexing failed");
          process.stdout.write(renderIndexerResult(result) + "\n"); // throws DomainError → exit 3
          return;
        }
        spinner.succeed(`indexed ${project}`);
        process.stdout.write(renderIndexerResult(result) + "\n");

        // Frames + contracts build INTO staging, so the published graph is complete.
        const frames = await runFrameExtraction({ repoPath, project, dbPath: stagePath });
        process.stdout.write(renderFramesLine(frames) + "\n");
        const contracts = await runContractExtraction({ repoPath, project, dbPath: stagePath });
        process.stdout.write(renderContractsLine(contracts) + "\n");

        // Checkpoint staging, then publish its contents into the canonical db via
        // one libsqlite3 transaction (corruption-impossible; visible to open handles).
        try {
          const conn = new Database(stagePath);
          try { conn.pragma("wal_checkpoint(TRUNCATE)"); } finally { conn.close(); }
        } catch { /* non-fatal */ }
        publishStagedDb({ stagePath, liveDbPath: dbPath });

        captureIndexMeta(dbPath, repoPath); // freshness baseline on the canonical path

        // Register in the master registry (best-effort; never fail the index).
        try {
          const reg = new Registry();
          try {
            const canonicalRoot = mainWorktreeRoot(repoPath);
            reg.register(project, repoPath, undefined, {
              worktree_of: canonicalRoot && canonicalRoot !== repoPath ? canonicalRoot : null,
              branch: gitBranch(repoPath),
            });
          } finally { reg.close(); }
        } catch { /* non-fatal */ }

        // Reap the now-consumed indexer slug cache (best-effort; never fail the index).
        if (process.env.CORTEX_GC !== "0") {
          try { reapRepoSlugCache(repoPath); } catch { /* non-fatal */ }
        }
      } finally {
        cleanupStagingDb(stagePath); // never leak staging — even on indexer error / throw
      }
    });
    return;
  }
  switch (cmd.command) {
    case "status":
      shell("index_status", { project: ctx.projectName ?? "" });
      return;
    case "changes": {
      // detect_changes now routes by repo_path + a pinned CORTEX_DB (per-call
      // routing), matching the MCP contract — it no longer resolves a project
      // name. Fall back to the canonical .cortex/db when the repo isn't indexed
      // yet (git diff still works; impacted symbols just come back empty).
      const repoPath = ctx.gitRoot;
      if (!repoPath) {
        throw new UsageError("not in a git repository", "Run 'cortex index changes' from inside a git repo");
      }
      const dbPath = ctx.graphDbPath ?? resolveCortexDbPath(repoPath);
      shell("detect_changes", { repo_path: repoPath }, { CORTEX_DB: dbPath });
      return;
    }
    case "sweep": {
      // SessionStart hook entry — best-effort current-repo storage GC.
      // No-op (not an error) outside a git repo, since the hook fires in
      // every cwd regardless of whether it's a Cortex-managed repo.
      const repoPath = ctx.gitRoot;
      if (!repoPath) {
        process.stdout.write("Not in a git repository — nothing to sweep.\n");
        return;
      }
      runSweep(repoPath);
      return;
    }
    case "list": {
      const projects = listProjectsFromRegistry();
      if (projects.length === 0) { process.stdout.write("No indexed projects.\n"); return; }
      for (const p of projects) process.stdout.write(`${p.name} — ${p.root_path}\n`);
      return;
    }
    case "delete": {
      const project = cmd.positionals[0];
      if (!project) throw new UsageError("missing <project>", "Usage: cortex index delete <project>");
      const found = listProjectsFromRegistry().find((p) => p.name === project);
      const removed = deleteProjectFromRegistry(project);
      if (found && process.env.CORTEX_GC !== "0") {
        try { reapRepoSlugCache(found.root_path); } catch { /* best-effort */ }
      }
      process.stdout.write(removed ? `Removed ${project}.\n` : `No such project: ${project}\n`);
      return;
    }
    default:
      throw new UsageError(`unknown command 'cortex index ${cmd.command}'`, "Run: cortex index --help");
  }
}

/** Enumerate registered projects from the master `Registry` — the same
 *  audited surface `cortex doctor` and the MCP `list_projects` tool use.
 *  Replaces the old `shell("list_projects")` cache-dir scan, which surfaced
 *  phantom `.tmp` corpus entries the registry's `isTmpPath` guard excludes. */
export function listProjectsFromRegistry(): { name: string; root_path: string }[] {
  const reg = new Registry();
  try { return reg.list().map((r) => ({ name: r.name, root_path: r.root_path })); }
  finally { reg.close(); }
}

/** Remove a project's registry row; returns whether it existed beforehand. */
export function deleteProjectFromRegistry(name: string): boolean {
  const reg = new Registry();
  try {
    const existed = reg.findByName(name) !== null;
    reg.remove(name);
    return existed;
  } finally { reg.close(); }
}

function shell(tool: string, args: Record<string, unknown>, extraEnv?: Record<string, string>): void {
  const raw = execFileSync(
    INDEXER_BIN,
    ["cli", tool, JSON.stringify(args)],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", process.env.CORTEX_CLI_DEBUG === "1" ? "inherit" : "ignore"],
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    },
  );
  process.stdout.write(renderIndexerResult(unwrapIndexerResult(raw)) + "\n");
}

function renderFramesLine(r: FrameResult): string {
  switch (r.status) {
    case "ok":
      return `frames: ${r.framesAssigned} assigned across ${r.clusters} clusters (${(r.elapsedMs / 1000).toFixed(1)}s)`;
    case "skipped":
      return r.reason === "venv_missing"
        ? "frames: skipped (python venv not set up — run 'cortex setup frames')"
        : `frames: skipped (${r.reason})`;
    case "failed":
      return `frames: failed (${r.reason})`;
  }
}

function renderContractsLine(r: ContractResult): string {
  switch (r.status) {
    case "ok":
      return `contracts: ${r.anchors} anchors, ${r.mismatches} mismatches (${(r.elapsedMs / 1000).toFixed(1)}s)`;
    case "skipped":
      return `contracts: skipped (${r.reason})`;
    case "failed":
      return `contracts: failed (${r.reason})`;
  }
}
