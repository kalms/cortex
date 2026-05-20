// scripts/frame-extraction/merge-indexed-db.ts
/**
 * Merge a project's indexed graph DB into a target shared DB, re-keying
 * node IDs with a caller-supplied prefix so IDs don't collide.
 *
 * Workaround for two limitations of the C indexer (as of 2026-05):
 *
 * 1. The dump pass replaces ALL nodes/edges on each run, so indexing two
 *    repos into the same DB sequentially destroys the earlier one.
 *
 * 2. Node IDs are sequential `ctx-N` per DB — not project-namespaced —
 *    so cross-DB merges collide on PRIMARY KEY.
 *
 * The longer-term fix is in the indexer itself. Until then, the canonical
 * recipe is:
 *
 *   index repo A → A.db
 *   index repo B → B.db
 *   merge-indexed-db --source A.db --target shared.db --prefix a
 *   merge-indexed-db --source B.db --target shared.db --prefix b
 *
 * Then point the viewer at shared.db.
 *
 * CLI:
 *   tsx scripts/frame-extraction/merge-indexed-db.ts \
 *     --source <path-to-source.db> \
 *     --target <path-to-target.db> \
 *     --prefix <stable-id-prefix> \
 *     [--force]
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

interface CliArgs {
  source: string;
  target: string;
  prefix: string;
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = { force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source") out.source = argv[++i];
    else if (argv[i] === "--target") out.target = argv[++i];
    else if (argv[i] === "--prefix") out.prefix = argv[++i];
    else if (argv[i] === "--force") out.force = true;
  }
  if (!out.source || !out.target || !out.prefix) {
    console.error(
      "usage: tsx merge-indexed-db.ts " +
      "--source <path-to-source.db> " +
      "--target <path-to-target.db> " +
      "--prefix <stable-id-prefix> " +
      "[--force]",
    );
    process.exit(2);
  }
  return out as CliArgs;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourcePath = resolve(args.source);
  const targetPath = resolve(args.target);

  if (!existsSync(sourcePath)) {
    console.error(`Source DB not found: ${sourcePath}`);
    process.exit(2);
  }
  if (!existsSync(targetPath)) {
    console.error(`Target DB not found: ${targetPath}`);
    process.exit(2);
  }

  if (!/^[a-z0-9_-]+$/i.test(args.prefix)) {
    console.error(
      `Prefix must match [a-zA-Z0-9_-]+. Got: ${JSON.stringify(args.prefix)}`,
    );
    process.exit(2);
  }

  const target = new Database(targetPath);
  try {
    const sourceProjects = readSourceProjects(sourcePath);
    const targetProjectsBefore = new Set(
      (target
        .prepare("SELECT name FROM ctx_projects")
        .all() as Array<{ name: string }>).map((r) => r.name),
    );

    const collisions = sourceProjects.filter((p) => targetProjectsBefore.has(p.name));
    if (collisions.length > 0 && !args.force) {
      console.error(
        `Target already contains data for: ${collisions.map((c) => c.name).join(", ")}. ` +
        `Pass --force to drop and re-merge.`,
      );
      process.exit(3);
    }

    target.exec(`ATTACH '${sourcePath.replace(/'/g, "''")}' AS src`);
    try {
      target.transaction(() => {
        if (collisions.length > 0) {
          for (const c of collisions) {
            const dropped = dropProjectRows(target, c.name);
            console.log(
              `[merge-indexed-db] dropped existing project=${c.name} ` +
              `nodes=${dropped.nodes} edges=${dropped.edges}`,
            );
          }
        }

        const inserted = mergeProjectRows(target, args.prefix);

        console.log(
          `[merge-indexed-db] merged ` +
          `nodes=${inserted.nodes} edges=${inserted.edges} ` +
          `projects=${inserted.projects.join(",")} ` +
          `prefix=${args.prefix}`,
        );
      })();
    } finally {
      target.exec("DETACH src");
    }
  } finally {
    target.close();
  }
}

function readSourceProjects(sourcePath: string): Array<{ name: string }> {
  const db = new Database(sourcePath, { readonly: true });
  try {
    return db
      .prepare("SELECT name FROM ctx_projects")
      .all() as Array<{ name: string }>;
  } finally {
    db.close();
  }
}

function dropProjectRows(
  target: Database.Database,
  projectName: string,
): { nodes: number; edges: number } {
  const e = target
    .prepare("DELETE FROM edges WHERE project = ?")
    .run(projectName);
  const n = target
    .prepare("DELETE FROM nodes WHERE project = ?")
    .run(projectName);
  target
    .prepare("DELETE FROM ctx_projects WHERE name = ?")
    .run(projectName);
  return { nodes: n.changes, edges: e.changes };
}

function mergeProjectRows(
  target: Database.Database,
  prefix: string,
): { nodes: number; edges: number; projects: string[] } {
  // Carry across ctx_projects first.
  const projectsResult = target
    .prepare(`INSERT INTO ctx_projects SELECT * FROM src.ctx_projects`)
    .run();

  const projects = (target
    .prepare("SELECT name FROM src.ctx_projects")
    .all() as Array<{ name: string }>).map((r) => r.name);

  // Re-key node IDs. Use a single SQL statement so the rewrite is atomic
  // and the column ordering doesn't drift from the schema.
  const nodesResult = target
    .prepare(
      `INSERT INTO nodes (id, kind, name, qualified_name, file_path, data, tier,
                          created_at, updated_at, start_line, end_line, project)
       SELECT
         ? || '-' || id,
         kind, name, qualified_name, file_path, data, tier,
         created_at, updated_at, start_line, end_line, project
       FROM src.nodes`,
    )
    .run(prefix);

  const edgesResult = target
    .prepare(
      `INSERT INTO edges (id, source_id, target_id, relation, data, created_at, project)
       SELECT
         ? || '-' || id,
         ? || '-' || source_id,
         ? || '-' || target_id,
         relation, data, created_at, project
       FROM src.edges`,
    )
    .run(prefix, prefix, prefix);

  return {
    nodes: nodesResult.changes,
    edges: edgesResult.changes,
    projects,
  };
}

const isDirect =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("merge-indexed-db.ts");
if (isDirect) main();
