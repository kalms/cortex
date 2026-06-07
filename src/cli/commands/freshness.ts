import Database from "better-sqlite3";
import type { ProjectContext } from "../context.js";
import { resolveGraphDbForRead, resolveCortexDbPath } from "../../db/resolve-path.js";
import { freshnessForContext, type Freshness } from "../../mcp-server/freshness.js";

/** One-line human render of a Freshness verdict (also reused by the hook). */
export function renderFreshnessLine(f: Freshness): string {
  return f.state === "fresh" ? "fresh" : `${f.state}${f.note ? ` — ${f.note}` : ""}`;
}

/** `cortex freshness` — print the freshness verdict for the cwd repo. */
export function runFreshnessCommand(ctx: ProjectContext): void {
  const repoPath = ctx.gitRoot ?? ctx.cwd;
  const graphDbPath = resolveGraphDbForRead(repoPath);
  if (!graphDbPath) {
    process.stdout.write("not-indexed — run: cortex index\n");
    return;
  }
  const db = new Database(graphDbPath, { readonly: true });
  try {
    const f = freshnessForContext({
      repoPath,
      graphDb: db,
      canonical: graphDbPath === resolveCortexDbPath(repoPath),
    });
    process.stdout.write(renderFreshnessLine(f) + "\n");
  } finally {
    db.close();
  }
}
