import { execFileSync } from "node:child_process";
import { GraphStore } from "../../graph/store.js";
import { searchGraph, countSuppressedSections, getGraphSchema, tracePath } from "../../graph/code-queries.js";
import { rankNodes } from "../../graph/node-ranker.js";
import { clampLimit, clampOffset } from "../../graph/search-params.js";
import type { ProjectContext } from "../context.js";
import { UsageError, DomainError, EnvironmentError } from "../errors.js";
import { resolveInput, type Disambiguation } from "../resolve-input.js";
import { writeRows, chooseFormat } from "../format.js";
import { indexerBinPath } from "../paths.js";
import { unwrapIndexerResult, renderIndexerResult } from "../indexer-output.js";
import { runCodeSearch, rankSearchHits } from "../../graph/code-search.js";
import { computeHotspots } from "../../architecture/hotspots.js";
import { loadGovernedPaths } from "../../architecture/governed.js";

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

async function cmdSearch(cmd: CodeCommand, ctx: ProjectContext): Promise<void> {
  requireIndexed(ctx);
  const pattern = cmd.positionals[0];
  if (!pattern) throw new UsageError("missing <pattern>", "Usage: cortex code search <pattern>");

  // `search` is full-text; kind filtering belongs to symbol search (`find`).
  if (cmd.flags.kind !== undefined || cmd.flags.kinds !== undefined) {
    process.stderr.write(
      "note: --kind has no effect on 'search' (full-text). " +
        `Use: cortex code find ${pattern} --kind=…  (symbol search)\n`,
    );
  }

  const store = new GraphStore(ctx.graphDbPath);
  const outcome = await runCodeSearch({
    pattern,
    repoRoot: ctx.gitRoot ?? ctx.cwd,
    store,
    project: ctx.projectName,
    maxHits: 500,
  });
  if (outcome.kind === "invalid_pattern") {
    throw new DomainError(`pattern rejected: ${outcome.detail}`, "Escape regex metacharacters (e.g. \\( \\[ \\. \\*) to match them literally.");
  }
  if (outcome.kind === "error") throw new DomainError(outcome.detail);

  const fmt = chooseFormat(cmd.flags.format as string | undefined, process.stdout.isTTY);
  const ranked = rankSearchHits(outcome.kind === "hits" ? outcome.hits : []);
  const limit = clampLimit(cmd.flags.limit !== undefined ? Number(cmd.flags.limit) : undefined);
  const offset = clampOffset(cmd.flags.offset !== undefined ? Number(cmd.flags.offset) : undefined);
  const page = ranked.slice(offset, offset + limit);
  const rows = page.map((h) => ({
    file: h.file,
    line: h.line,
    symbol: h.enclosing ? `${h.enclosing.kind} ${h.enclosing.qualified_name}` : "",
    text: h.text.trim(),
  }));
  writeRows(rows, fmt, ranked.length === 0
    ? `no matches for '${pattern}' in ${ctx.projectName}`
    : `offset ${offset} is past the ${ranked.length} match(es)`);
  if (page.length > 0) {
    process.stderr.write(`# showing ${offset + 1}–${offset + page.length} of ${ranked.length}\n`);
  }
}

function cmdFind(cmd: CodeCommand, ctx: ProjectContext): void {
  requireIndexed(ctx);
  const pattern = cmd.positionals[0];
  if (!pattern) throw new UsageError("missing <name-pattern>", "Usage: cortex code find <name>");

  // --kind / --kinds: comma-separated kind allow-list (e.g. --kind=function,route).
  // An explicit list replaces the default (which excludes doc/plan sections).
  const kindsFlag = (cmd.flags.kinds ?? cmd.flags.kind) as string | boolean | undefined;
  const kinds = typeof kindsFlag === "string"
    ? kindsFlag.split(",").map((k) => k.trim()).filter(Boolean)
    : undefined;
  const usesDefaultFilter = !kinds || kinds.length === 0;
  const limit = clampLimit(cmd.flags.limit !== undefined ? Number(cmd.flags.limit) : undefined);
  const offset = clampOffset(cmd.flags.offset !== undefined ? Number(cmd.flags.offset) : undefined);

  const store = new GraphStore(ctx.graphDbPath);
  const ranked = rankNodes(searchGraph(store, ctx.projectName, { name_pattern: pattern, kinds }), pattern);
  const fmt = chooseFormat(cmd.flags.format as string | undefined, process.stdout.isTTY);

  // Sections are hidden only by the default filter; report the count so the
  // user knows they exist and how to opt in (mirrors the search_graph tool).
  const suppressed = usesDefaultFilter
    ? countSuppressedSections(store, ctx.projectName, { name_pattern: pattern })
    : 0;

  if (ranked.length === 0) {
    const msg = suppressed > 0
      ? `no code symbols matched '${pattern}' — ${suppressed} section(s) match (--kind=section to include)`
      : `no symbols matched '${pattern}' in ${ctx.projectName}`;
    writeRows([], fmt, msg);
    return;
  }

  const page = ranked.slice(offset, offset + limit);
  const rows = page.map((r) => ({
    name: r.name,
    kind: r.kind,
    qualified_name: r.qualified_name,
    file_path: r.file_path,
  }));
  writeRows(rows, fmt, `offset ${offset} is past the ${ranked.length} match(es)`);

  // On overshoot, writeRows already emitted the past-the-end message; don't
  // also print a status line (one diagnostic per event).
  if (page.length === 0) return;

  // Status line on stderr — keeps stdout clean for pipes / --format json.
  let note = `# showing ${offset + 1}–${offset + page.length} of ${ranked.length}`;
  if (suppressed > 0) note += ` · ${suppressed} section node(s) hidden (--kind=section to include)`;
  process.stderr.write(note + "\n");
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
  if (cmd.flags.hotspots || cmd.flags.headline) {
    // --headline formatting is added in Task 9; for now both route to the table.
    return cmdArchHotspots(ctx, cmd.flags);
  }
  const aspects = (cmd.flags.aspects as string | undefined)?.split(",") ?? ["all"];
  process.stdout.write(runIndexer("get_architecture", { aspects, project: ctx.projectName }, ctx) + "\n");
}

/** `cortex code arch --hotspots` — ranked source modules by inbound fan-in. */
export function cmdArchHotspots(
  ctx: ProjectContext & { graphDbPath: string; projectName: string },
  flags: Record<string, string | boolean>,
): void {
  const root = ctx.gitRoot ?? ctx.cwd;
  const store = new GraphStore(ctx.graphDbPath, { readonly: true });
  try {
    const areas = computeHotspots(store, ctx.projectName, loadGovernedPaths(root));
    const fmt = chooseFormat(flags.format as string | undefined, process.stdout.isTTY);
    const rows = areas.map((a) => ({
      module: a.path,
      in_edges: a.in_edges,
      nodes: a.nodes,
      decisions: a.governing_decisions,
    }));
    writeRows(rows, fmt, `no source modules found for ${ctx.projectName}`);
  } finally {
    store.close?.();
  }
}

function cmdSchema(cmd: CodeCommand, ctx: ProjectContext): void {
  requireIndexed(ctx);
  const store = new GraphStore(ctx.graphDbPath);
  const schema = getGraphSchema(store, ctx.projectName);
  const fmt = chooseFormat(cmd.flags.format as string | undefined, process.stdout.isTTY);
  const rows = schema.labels.map((l) => ({ label: l.name, count: l.count }));
  writeRows(rows, fmt, `no nodes indexed for ${ctx.projectName}`);
}
