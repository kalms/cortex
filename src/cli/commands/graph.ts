import { execFileSync } from "node:child_process";
import type { ProjectContext } from "../context.js";
import { UsageError, EnvironmentError } from "../errors.js";
import { indexerBinPath } from "../paths.js";

const INDEXER_BIN = indexerBinPath();

export type GraphCommand = {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

export async function runGraphCommand(cmd: GraphCommand, ctx: ProjectContext): Promise<void> {
  if (ctx.state !== "indexed" || !ctx.graphDbPath || !ctx.projectName) {
    throw new EnvironmentError("no indexed project for the current directory", "cortex index .");
  }
  switch (cmd.command) {
    case "query": {
      const query = cmd.positionals[0];
      if (!query) throw new UsageError("missing <cypher>", "Usage: cortex graph query '<cypher>'");
      const out = execFileSync(
        INDEXER_BIN,
        ["cli", "query_graph", JSON.stringify({ query, project: ctx.projectName })],
        { encoding: "utf-8", env: { ...process.env, CORTEX_DB: ctx.graphDbPath } },
      );
      process.stdout.write(out);
      return;
    }
    case "sql": {
      const sql = cmd.positionals[0];
      if (!sql) throw new UsageError("missing <sql>", "Usage: cortex graph sql '<sql>'");
      // Shell out to sqlite3 directly — no MCP equivalent.
      const out = execFileSync("sqlite3", [ctx.graphDbPath, sql], { encoding: "utf-8" });
      process.stdout.write(out);
      return;
    }
    default:
      throw new UsageError(`unknown command 'cortex graph ${cmd.command}'`, "Run: cortex graph --help");
  }
}
