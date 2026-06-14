import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { IndexerNode } from "../../graph/code-queries.js";
import { ok, error as errorResponse } from "../response.js";
import { denormalize } from "../qualified-name.js";
import type { RepoContext } from "../repo-context.js";

/**
 * Derive the project name from the addressed repo's graph DB.
 *
 * Each `.cortex/db` written by the indexer holds rows for exactly one project
 * (its `ctx_projects` table). We pick the first row rather than filtering by
 * `root_path` because the path stored at indexing time can diverge from the
 * agent's current absolute path (symlinks, copied fixtures, moved trees) —
 * but the DB always contains a single project, so LIMIT 1 is unambiguous.
 * Returns null when the table is missing (pre-migration DB) or empty.
 */
export function projectFromCtx(ctx: RepoContext): string | null {
  try {
    const rows = ctx.store.queryRaw<{ name: string }>(
      "SELECT name FROM ctx_projects LIMIT 1",
    );
    return rows[0]?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Read a code snippet for a resolved node off disk.
 *
 * Honors the stored `ctx_projects.root_path` because the indexer wrote
 * `file_path` relative to *that* root, not relative to the path the caller
 * addressed (`ctx.repoPath`). The two can diverge when a fixture clones the
 * graph DB into a tmp tree without copying the source files alongside.
 */
export async function readSnippet(
  ctx: RepoContext,
  project: string,
  node: IndexerNode,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
  try {
    const projectRow = ctx.store.queryRaw<{ root_path: string }>(
      "SELECT root_path FROM ctx_projects WHERE name = ?",
      [project],
    );
    if (projectRow.length === 0) {
      return errorResponse("project_not_found", `Project ${project} not found in indexer DB`);
    }
    const fullPath = join(projectRow[0].root_path, node.file_path);
    const content = await readFile(fullPath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, node.start_line - 1);
    const end = Math.min(lines.length, node.end_line);
    const snippet = lines.slice(start, end).join("\n");
    const display = denormalize(node.qualified_name, node.file_path);
    return ok(`// ${display} (${node.file_path}:${node.start_line}-${node.end_line})\n${snippet}`);
  } catch (e) {
    return errorResponse("fs_error", e instanceof Error ? e.message : String(e));
  }
}
