import Database from "better-sqlite3";
import type { Binding } from "./types.js";

const anchorId = (tool: string) => `anchor:rpc_tool:${tool}`;

/** Idempotently write Anchor nodes + BINDS_KEY edges for the project. Edges
 *  attach to the FILE node of the binding's source file (resolved by path);
 *  bindings whose file has no node are skipped. Mirrors inject-frames' raw-
 *  better-sqlite3 + transaction style. Re-running first deletes the project's
 *  prior anchors/edges. */
export function injectContracts(args: { bindings: readonly Binding[]; project: string; dbPath: string }): number {
  const db = new Database(args.dbPath);
  db.pragma("foreign_keys = ON");
  try {
    const now = new Date().toISOString();
    const fileNodeId = db.prepare(`SELECT id FROM nodes WHERE project=? AND kind='file' AND file_path=?`);
    const upsertAnchor = db.prepare(`
      INSERT INTO nodes (id,kind,name,qualified_name,data,tier,created_at,updated_at,project)
      VALUES (@id,'anchor',@name,@name,@data,'personal',@now,@now,@project)
      ON CONFLICT(id) DO UPDATE SET updated_at=@now`);
    const insertEdge = db.prepare(`
      INSERT INTO edges (id,source_id,target_id,relation,data,created_at,project)
      VALUES (@id,@source_id,@target_id,'BINDS_KEY',@data,@now,@project)
      ON CONFLICT(id) DO NOTHING`);

    let written = 0;
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM edges WHERE relation='BINDS_KEY' AND project=?`).run(args.project);
      db.prepare(`DELETE FROM nodes WHERE kind='anchor' AND project=?`).run(args.project);

      const seenAnchor = new Set<string>();
      for (const b of args.bindings) {
        const aid = anchorId(b.tool);
        if (!seenAnchor.has(aid)) {
          upsertAnchor.run({ id: aid, name: b.tool, data: JSON.stringify({ kind: "rpc_tool" }), now, project: args.project });
          seenAnchor.add(aid);
        }
        const fileRow = fileNodeId.get(args.project, b.file) as { id: string } | undefined;
        if (!fileRow) continue;
        const info = insertEdge.run({
          id: `binds:${b.role}:${b.tool}:${b.file}:${b.line}`,
          source_id: fileRow.id, target_id: aid,
          data: JSON.stringify({ role: b.role, keys: b.keys, symbol: b.symbol, line: b.line }),
          now, project: args.project,
        });
        if (info.changes > 0) written++;
      }
    });
    tx();
    return written;
  } finally {
    db.close();
  }
}
