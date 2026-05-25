import { execFileSync } from "node:child_process";
import { GraphStore } from "../../graph/store.js";
import { searchGraph, getGraphSchema, tracePath } from "../../graph/code-queries.js";
import type { ProjectContext } from "../context.js";
import { UsageError, DomainError, EnvironmentError } from "../errors.js";
import { resolveInput, type Disambiguation } from "../resolve-input.js";
import { formatRows, chooseFormat } from "../format.js";
import { indexerBinPath } from "../paths.js";

const INDEXER_BIN = indexerBinPath();

export type CodeCommand = {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

function requireIndexed(
  ctx: ProjectContext,
): asserts ctx is ProjectContext & { graphDbPath: string; projectName: string } {
  if (ctx.state !== "indexed" || !ctx.graphDbPath || !ctx.projectName) {
    throw new EnvironmentError(
      "no indexed project for the current directory",
      "cortex index .  (to index the current repo)",
    );
  }
}

function renderDisambiguation(d: Disambiguation): never {
  const lines = [`Multiple matches for '${d.input}'. Pick one:`, ""];
  d.candidates.forEach((c, i) => {
    lines.push(`  ${i + 1}. ${c.qn}  (${c.kind}, ${c.file_path})`);
  });
  lines.push("");
  lines.push(`Run: cortex code show '<full qn from above>'`);
  throw new DomainError("ambiguous input", lines.join("\n"));
}

export async function runCodeCommand(cmd: CodeCommand, ctx: ProjectContext): Promise<void> {
  switch (cmd.command) {
    case "search":
      return cmdSearch(cmd, ctx);
    case "find":
      return cmdFind(cmd, ctx);
    case "show":
      return cmdShow(cmd, ctx);
    case "where":
      return cmdTrace(cmd, ctx, "callers");
    case "calls":
      return cmdTrace(cmd, ctx, "calls");
    case "arch":
      return cmdArch(cmd, ctx);
    case "schema":
      return cmdSchema(cmd, ctx);
    default:
      throw new UsageError(`unknown command 'cortex code ${cmd.command}'`, "Run: cortex code --help");
  }
}

function cmdSearch(cmd: CodeCommand, ctx: ProjectContext): void {
  requireIndexed(ctx);
  const pattern = cmd.positionals[0];
  if (!pattern) throw new UsageError("missing <pattern>", "Usage: cortex code search <pattern>");
  const out = execFileSync(
    INDEXER_BIN,
    ["cli", "search_code", JSON.stringify({ pattern, project: ctx.projectName })],
    { encoding: "utf-8", env: { ...process.env, CORTEX_DB: ctx.graphDbPath } },
  );
  process.stdout.write(out);
}

function cmdFind(cmd: CodeCommand, ctx: ProjectContext): void {
  requireIndexed(ctx);
  const pattern = cmd.positionals[0];
  if (!pattern) throw new UsageError("missing <name-pattern>", "Usage: cortex code find <name>");
  const store = new GraphStore(ctx.graphDbPath);
  const results = searchGraph(store, ctx.projectName, { name_pattern: pattern });
  const rows = results.map((r) => ({
    name: r.name,
    kind: r.kind,
    qualified_name: r.qualified_name,
    file_path: r.file_path,
  }));
  const fmt = chooseFormat(cmd.flags.format as string | undefined, process.stdout.isTTY);
  process.stdout.write(formatRows(rows, fmt) + "\n");
}

function cmdShow(cmd: CodeCommand, ctx: ProjectContext): void {
  requireIndexed(ctx);
  const input = cmd.positionals[0];
  if (!input) throw new UsageError("missing <input>", "Usage: cortex code show <input>");
  const resolved = resolveInput(input, ctx.projectName, ctx.graphDbPath);
  if ("candidates" in resolved) renderDisambiguation(resolved);
  // Shell out to indexer for snippet retrieval — it has the file-read + content logic.
  const out = execFileSync(
    INDEXER_BIN,
    ["cli", "get_code_snippet", JSON.stringify({ qualified_name: resolved.qn, project: ctx.projectName })],
    { encoding: "utf-8", env: { ...process.env, CORTEX_DB: ctx.graphDbPath } },
  );
  process.stdout.write(out);
}

function cmdTrace(cmd: CodeCommand, ctx: ProjectContext, mode: "calls" | "callers"): void {
  requireIndexed(ctx);
  const input = cmd.positionals[0];
  if (!input) {
    throw new UsageError(
      `missing <input>`,
      `Usage: cortex code ${mode === "callers" ? "where" : "calls"} <input>`,
    );
  }
  const resolved = resolveInput(input, ctx.projectName, ctx.graphDbPath);
  if ("candidates" in resolved) renderDisambiguation(resolved);
  const store = new GraphStore(ctx.graphDbPath);
  const fnName = resolved.qn.split(".").pop()!;
  const results = tracePath(store, ctx.projectName, { function_name: fnName, mode });
  const rows = results.map((r) => ({
    depth: r.depth,
    name: r.node.name,
    kind: r.node.kind,
    file_path: r.node.file_path,
  }));
  const fmt = chooseFormat(cmd.flags.format as string | undefined, process.stdout.isTTY);
  process.stdout.write(formatRows(rows, fmt) + "\n");
}

function cmdArch(cmd: CodeCommand, ctx: ProjectContext): void {
  requireIndexed(ctx);
  const aspects = (cmd.flags.aspects as string | undefined)?.split(",") ?? ["all"];
  const out = execFileSync(
    INDEXER_BIN,
    ["cli", "get_architecture", JSON.stringify({ aspects, project: ctx.projectName })],
    { encoding: "utf-8", env: { ...process.env, CORTEX_DB: ctx.graphDbPath } },
  );
  process.stdout.write(out);
}

function cmdSchema(cmd: CodeCommand, ctx: ProjectContext): void {
  requireIndexed(ctx);
  const store = new GraphStore(ctx.graphDbPath);
  const schema = getGraphSchema(store, ctx.projectName);
  const fmt = chooseFormat(cmd.flags.format as string | undefined, process.stdout.isTTY);
  // getGraphSchema returns { labels: [{name, count}], edgeTypes: [{name, count}] }
  const rows = schema.labels.map((l) => ({ label: l.name, count: l.count }));
  process.stdout.write(formatRows(rows, fmt) + "\n");
}
