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

/**
 * The ordering contract, enforced rather than merely documented.
 *
 * `runStalenessSweep` reads the PREVIOUS index's `indexed_commit`;
 * `captureIndexMeta` overwrites it with the current HEAD. Reversed, every
 * sweep compares HEAD against HEAD and itemizes nothing, forever, with no
 * error and no output — the only symptom is a headline that stops appearing,
 * which is indistinguishable from "nothing is stale". Every test in
 * tests/staleness/ calls runStalenessSweep directly, so none of them would
 * notice. This one would.
 */
describe("sweep-before-captureIndexMeta ordering", () => {
  it("is honoured at every index call site in src/", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join: pjoin } = await import("node:path");

    const files: string[] = [];
    (function walk(dir: string) {
      for (const e of readdirSync(dir)) {
        const p = pjoin(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    })("src");

    const sites: Array<{ file: string; sweep: number; capture: number }> = [];
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        // Calls only — skip the declaration in graph/capture-index-meta.ts.
        if (!line.includes("captureIndexMeta(dbPath")) return;
        if (line.includes("export function")) return;
        // Find the nearest preceding runStalenessSweep call (within 8 lines).
        let sweep = -1;
        for (let j = i - 1; j >= 0 && j >= i - 8; j--) {
          if (lines[j].includes("runStalenessSweep(")) { sweep = j; break; }
        }
        sites.push({ file: f, sweep, capture: i });
      });
    }

    // Guard against a vacuous pass: if the call sites are ever renamed away,
    // this must fail loudly rather than silently assert over an empty list.
    expect(sites.length).toBe(3);
    for (const s of sites) {
      expect(s.sweep, `${s.file}: runStalenessSweep must precede captureIndexMeta`).toBeGreaterThanOrEqual(0);
      expect(s.sweep).toBeLessThan(s.capture);
    }
  });
});
