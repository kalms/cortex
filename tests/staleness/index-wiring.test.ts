import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { publishStagedDb } from "../../src/db/swap-graph-db.js";
import { writeIndexMeta, readIndexMeta } from "../../src/graph/index-meta.js";

describe("publishStagedDb preserves the freshness baseline", () => {
  it("leaves cortex_index_meta untouched, so the sweep can read the PREVIOUS commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-publish-"));
    const live = join(dir, "db");
    const stage = join(dir, "db.stage");

    const liveDb = new Database(live);
    liveDb.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT)");
    liveDb.close();
    writeIndexMeta(live, { indexed_commit: "prevcommit", indexed_dirty_sig: null, indexed_at: "t0" });

    const stageDb = new Database(stage);
    stageDb.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT)");
    stageDb.prepare("INSERT INTO nodes (id, name) VALUES ('ctx-1', 'n')").run();
    stageDb.close();

    publishStagedDb({ stagePath: stage, liveDbPath: live });

    const after = new Database(live, { readonly: true });
    try {
      // If this ever fails, runStalenessSweep silently compares HEAD to HEAD.
      expect(readIndexMeta(after)?.indexed_commit).toBe("prevcommit");
    } finally { after.close(); }
  });
});
