import { execFileSync } from "node:child_process";
import type { ProjectContext } from "../context.js";
import { UsageError } from "../errors.js";
import { indexerBinPath } from "../paths.js";
import { unwrapIndexerResult, renderIndexerResult } from "../indexer-output.js";

const INDEXER_BIN = indexerBinPath();

export type IndexCommand = {
  command: string | null;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

export async function runIndexCommand(cmd: IndexCommand, ctx: ProjectContext): Promise<void> {
  // 'cortex index' with no subcommand → index the cwd (or given path)
  if (cmd.command === null || cmd.command === undefined || cmd.command === ".") {
    const repoPath = cmd.positionals[0] ?? ctx.cwd;
    const raw = execFileSync(
      INDEXER_BIN,
      ["cli", "index_repository", JSON.stringify({ repo_path: repoPath })],
      { encoding: "utf-8", stdio: ["inherit", "pipe", "inherit"] },
    );
    process.stdout.write(renderIndexerResult(unwrapIndexerResult(raw)) + "\n");
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
