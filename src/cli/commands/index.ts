import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import type { ProjectContext } from "../context.js";
import { UsageError } from "../errors.js";
import { indexerBinPath } from "../paths.js";
import { unwrapIndexerResult, renderIndexerResult } from "../indexer-output.js";
import { runFrameExtraction, type FrameResult } from "../../frame-extraction/run-frames.js";
import { deriveProjectName } from "../../frame-extraction/cluster-tfidf-hdbscan.js";
import { resolveCortexDbPath } from "../../db/resolve-path.js";
import { Registry } from "../../db/registry.js";

const INDEXER_BIN = indexerBinPath();

export type IndexCommand = {
  command: string | null;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

export async function runIndexCommand(cmd: IndexCommand, ctx: ProjectContext): Promise<void> {
  // 'cortex index' with no subcommand → index the cwd (or given path)
  if (cmd.command === null || cmd.command === undefined || cmd.command === ".") {
    const repoPath = resolve(cmd.positionals[0] ?? ctx.cwd);
    const dbPath = resolveCortexDbPath(repoPath); // <repo>/.cortex/db — canonical
    const raw = execFileSync(
      INDEXER_BIN,
      ["cli", "index_repository", JSON.stringify({ repo_path: repoPath })],
      {
        encoding: "utf-8",
        stdio: ["inherit", "pipe", "inherit"],
        // Tell the indexer binary to write the canonical per-repo store, not
        // the legacy ~/.cache/cortex-indexer/<slug>.db default.
        env: { ...process.env, CORTEX_DB: dbPath },
      },
    );
    process.stdout.write(renderIndexerResult(unwrapIndexerResult(raw)) + "\n");

    // Auto frame extraction into the SAME canonical store (additive; never blocks).
    const project = deriveProjectName(repoPath);
    const frames = await runFrameExtraction({ repoPath, project, dbPath });
    process.stdout.write(renderFramesLine(frames) + "\n");

    // Checkpoint WAL so a reader opening .cortex/db immediately sees a complete
    // state (no pending frame writes stranded in the -wal sidecar).
    try {
      const conn = new Database(dbPath);
      try { conn.pragma("wal_checkpoint(TRUNCATE)"); } finally { conn.close(); }
    } catch { /* non-fatal */ }

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
    case "changes":
      shell("detect_changes", { project: ctx.projectName ?? "" });
      return;
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

function shell(tool: string, args: Record<string, unknown>): void {
  const raw = execFileSync(
    INDEXER_BIN,
    ["cli", tool, JSON.stringify(args)],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", process.env.CORTEX_CLI_DEBUG === "1" ? "inherit" : "ignore"],
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
