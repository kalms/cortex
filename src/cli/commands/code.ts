import { execFileSync } from "node:child_process";
import { GraphStore } from "../../graph/store.js";
import { searchGraph, getGraphSchema, tracePath } from "../../graph/code-queries.js";
import type { ProjectContext } from "../context.js";
import { UsageError, DomainError, EnvironmentError } from "../errors.js";
import { resolveInput, type Disambiguation } from "../resolve-input.js";
import { writeRows, chooseFormat } from "../format.js";
import { indexerBinPath } from "../paths.js";
import { unwrapIndexerResult, renderIndexerResult } from "../indexer-output.js";

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

function runIndexer(tool: string, payload: object, ctx: ProjectContext & { graphDbPath: string }): string {
  const raw = execFileSync(
    INDEXER_BIN,
    ["cli", tool, JSON.stringify(payload)],
    {
      encoding: "utf-8",
      env: { ...process.env, CORTEX_DB: ctx.graphDbPath },
      // Silence the indexer's level=info startup logs unless --debug. They're
      // not useful to CLI users and pollute the terminal between commands.
      stdio: ["ignore", "pipe", process.env.CORTEX_CLI_DEBUG === "1" ? "inherit" : "ignore"],
    },
  );
  return renderIndexerResult(unwrapIndexerResult(raw));
}

function cmdSearch(cmd: CodeCommand, ctx: ProjectContext): void {
  requireIndexed(ctx);
  const pattern = cmd.positionals[0];
  if (!pattern) throw new UsageError("missing <pattern>", "Usage: cortex code search <pattern>");
  process.stdout.write(runIndexer("search_code", { pattern, project: ctx.projectName }, ctx) + "\n");
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
  writeRows(rows, fmt, `no symbols matched '${pattern}' in ${ctx.projectName}`);
}

function cmdShow(cmd: CodeCommand, ctx: ProjectContext): void {
  requireIndexed(ctx);
  const input = cmd.positionals[0];
  if (!input) throw new UsageError("missing <input>", "Usage: cortex code show <input>");
  const resolved = resolveInput(input, ctx.projectName, ctx.graphDbPath);
  if ("candidates" in resolved) renderDisambiguation(resolved);
  const rendered = runIndexer(
    "get_code_snippet",
    { qualified_name: resolved.qn, project: ctx.projectName },
    ctx,
  );
  // The indexer returns a JSON node payload; surface the .source field if
  // present so the user sees source code, not a JSON wrapper.
  try {
    const parsed = JSON.parse(rendered);
    if (parsed && typeof parsed === "object" && typeof parsed.source === "string") {
      process.stdout.write(parsed.source);
      if (!parsed.source.endsWith("\n")) process.stdout.write("\n");
      return;
    }
  } catch {
    // not JSON, fall through
  }
  process.stdout.write(rendered + "\n");
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
  const verb = mode === "callers" ? "callers" : "callees";
  writeRows(rows, fmt, `no ${verb} found for '${fnName}'`);
}

function cmdArch(cmd: CodeCommand, ctx: ProjectContext): void {
  requireIndexed(ctx);
  const aspects = (cmd.flags.aspects as string | undefined)?.split(",") ?? ["all"];
  process.stdout.write(runIndexer("get_architecture", { aspects, project: ctx.projectName }, ctx) + "\n");
}

function cmdSchema(cmd: CodeCommand, ctx: ProjectContext): void {
  requireIndexed(ctx);
  const store = new GraphStore(ctx.graphDbPath);
  const schema = getGraphSchema(store, ctx.projectName);
  const fmt = chooseFormat(cmd.flags.format as string | undefined, process.stdout.isTTY);
  const rows = schema.labels.map((l) => ({ label: l.name, count: l.count }));
  writeRows(rows, fmt, `no nodes indexed for ${ctx.projectName}`);
}
