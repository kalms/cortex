import { GraphStore } from "../graph/store.js";
import type { ProjectContext } from "./context.js";

function pickSampleFunction(dbPath: string, project: string): string | null {
  try {
    const store = new GraphStore(dbPath);
    // Prefer a short, non-anonymous name so the worked example reads well.
    // `project IS NULL` lets test fixtures without a project column populated
    // still surface a sample; production data always has project set.
    const rows = store.queryRaw<{ name: string }>(
      `SELECT name FROM nodes
       WHERE kind = 'function' AND (project = ? OR project IS NULL)
         AND name NOT LIKE '<%' AND length(name) BETWEEN 3 AND 30
       ORDER BY length(name) LIMIT 1`,
      [project],
    );
    return rows[0]?.name ?? null;
  } catch {
    return null;
  }
}

export function renderTour(ctx: ProjectContext): string {
  if (ctx.state === "indexed" && ctx.graphDbPath && ctx.projectName) {
    const sample = pickSampleFunction(ctx.graphDbPath, ctx.projectName);
    if (!sample) {
      return [
        `Hi — cortex indexes your codebase into a graph and tracks decisions about it.`,
        ``,
        `You're in a project (${ctx.projectName}) that's recognized but appears to`,
        `have no function nodes indexed yet (or the wrong graph.db is in use).`,
        ``,
        `Quickest fix:`,
        `  cortex index .                refresh the index for the current repo`,
        `  cortex index status           confirm node/edge counts`,
        ``,
        `Or just explore what's in the graph today:`,
        `  cortex code schema            see node labels + counts`,
        `  cortex code search '<text>'   full-text search`,
      ].join("\n");
    }
    return [
      `Hi — cortex indexes your codebase into a graph and tracks decisions about it.`,
      ``,
      `You're in an indexed project: ${ctx.projectName}.`,
      `Skipping index setup — let's explore what's here.`,
      ``,
      `Step 1 — find a symbol by name`,
      `  cortex code find ${sample}`,
      ``,
      `Step 2 — show its source`,
      `  cortex code show <qn from step 1>`,
      ``,
      `Step 3 — who calls it`,
      `  cortex code where ${sample}`,
      ``,
      `Step 4 — what calls it depends on`,
      `  cortex code calls ${sample}`,
      ``,
      `Step 5 — why it was built this way`,
      `  cortex decision why src/some/file.ts`,
      ``,
      `Step 6 — the deep end`,
      `  cortex graph query 'MATCH (f:function) WHERE f.name = "${sample}" RETURN f'`,
      ``,
      `Next: \`cortex help projects\`, \`cortex --help\` for the full surface.`,
    ].join("\n");
  }
  if (ctx.state === "unindexed-repo") {
    return [
      `Hi — cortex indexes your codebase into a graph and tracks decisions about it.`,
      ``,
      `This looks like a git repo, but it's not indexed yet.`,
      ``,
      `Step 1 — index it`,
      `  cortex index`,
      `  (takes 5–30 seconds depending on size)`,
      ``,
      `Step 2 — then re-run \`cortex tour\` to continue.`,
      ``,
      `Or jump straight in:`,
      `  cortex code find <name>`,
      `  cortex code show <qn>`,
    ].join("\n");
  }
  // no-project
  return [
    `Hi — cortex indexes your codebase into a graph and tracks decisions about it.`,
    ``,
    `You're not in a project right now. Two ways to start:`,
    ``,
    `  • cd into a git repo you want to explore, then run: cortex index`,
    `  • Or look at an existing indexed project:`,
    `      cortex index list      see what's indexed`,
    `      cortex code find ...   try a query (use --project=<name>)`,
    ``,
    `Run \`cortex tour\` again once you're in an indexed project for the full walkthrough.`,
  ].join("\n");
}
