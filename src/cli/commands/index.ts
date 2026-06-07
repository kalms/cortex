import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import type { ProjectContext } from "../context.js";
import { UsageError } from "../errors.js";
import { indexerBinPath } from "../paths.js";
import { unwrapIndexerResult, renderIndexerResult } from "../indexer-output.js";
import { runFrameExtraction, type FrameResult } from "../../frame-extraction/run-frames.js";
import { runContractExtraction } from "../../contracts/run-contracts.js";
import type { ContractResult } from "../../contracts/types.js";
import { deriveProjectName } from "../../frame-extraction/cluster-tfidf-hdbscan.js";
import { resolveCortexDbPath } from "../../db/resolve-path.js";
import { Registry } from "../../db/registry.js";
import { captureIndexMeta } from "../../graph/capture-index-meta.js";
import type { IndexMode } from "../../db/cache.js";

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

export async function runIndexCommand(cmd: IndexCommand, ctx: ProjectContext): Promise<void> {
  // 'cortex index' with no subcommand → index the cwd (or given path)
  if (cmd.command === null || cmd.command === undefined || cmd.command === ".") {
    const repoPath = resolve(cmd.positionals[0] ?? ctx.cwd);
    const mode = resolveIndexMode(cmd.flags);
    const dbPath = resolveCortexDbPath(repoPath); // <repo>/.cortex/db — canonical
    const indexerArgs = mode ? { repo_path: repoPath, mode } : { repo_path: repoPath };
    const raw = execFileSync(
      INDEXER_BIN,
      ["cli", "index_repository", JSON.stringify(indexerArgs)],
      {
        encoding: "utf-8",
        stdio: ["inherit", "pipe", "inherit"],
        // Tell the indexer binary to write the canonical per-repo store, not
        // the legacy ~/.cache/cortex-indexer/<slug>.db default.
        env: { ...process.env, CORTEX_DB: dbPath },
      },
    );
    const result = unwrapIndexerResult(raw);
    process.stdout.write(renderIndexerResult(result) + "\n");
    // renderIndexerResult throws on a failed index today, but guard explicitly
    // so a future refactor can't let frames/register run against an empty
    // .cortex/db (which would leave a registry row pointing at no graph).
    if (result.isError) return;

    // Auto frame extraction into the SAME canonical store (additive; never blocks).
    const project = deriveProjectName(repoPath);
    const frames = await runFrameExtraction({ repoPath, project, dbPath });
    process.stdout.write(renderFramesLine(frames) + "\n");
    const contracts = await runContractExtraction({ repoPath, project, dbPath });
    process.stdout.write(renderContractsLine(contracts) + "\n");

    captureIndexMeta(dbPath, repoPath);

    // Checkpoint WAL so a reader opening .cortex/db immediately sees a complete
    // state (no pending frame writes stranded in the -wal sidecar).
    try {
      const conn = new Database(dbPath);
      try { conn.pragma("wal_checkpoint(TRUNCATE)"); } finally { conn.close(); }
    } catch (e) {
      if (process.env.CORTEX_CLI_DEBUG === "1") {
        process.stderr.write(`Cortex: WAL checkpoint failed: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }

    // Register in the master registry (best-effort; never fail the index).
    try {
      const reg = new Registry();
      try { reg.register(project, repoPath); } finally { reg.close(); }
    } catch { /* non-fatal */ }
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
    case "list":
      shell("list_projects", {});
      return;
    case "delete": {
      const project = cmd.positionals[0];
      if (!project) throw new UsageError("missing <project>", "Usage: cortex index delete <project>");
      shell("delete_project", { project });
      return;
    }
    default:
      throw new UsageError(`unknown command 'cortex index ${cmd.command}'`, "Run: cortex index --help");
  }
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
