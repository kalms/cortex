// tests/frame-extraction/run-frames-hierarchy.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runFrameExtraction } from "../../src/frame-extraction/run-frames.js";
import { hasVenv } from "../../src/frame-extraction/venv.js";

const RUN = hasVenv() ? describe : describe.skip;
RUN("run-frames hierarchy gate", () => {
  let root: string; let project: string; let dbPath: string;
  beforeEach(() => {
    root = join(tmpdir(), `cortex_rfh_${Date.now()}`);
    project = root.replace(/[/:]/g, "-").replace(/-+/g, "-").replace(/^-+/, "");
    mkdirSync(join(root, ".cortex"), { recursive: true });
    dbPath = join(root, ".cortex", "graph.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, project TEXT, data TEXT);`);
    const f = db.prepare("INSERT INTO nodes (kind,name,file_path,project,data) VALUES ('file',?,?,?,NULL)");
    for (let i = 0; i < 8; i++) f.run(`f${i}`, `src/f${i}.ts`, project);
    db.close();
  });
  afterEach(() => { if (existsSync(root)) rmSync(root, { recursive: true, force: true }); });

  it("CORTEX_FRAME_HIERARCHY=0 disables the term (runs without error)", async () => {
    const prev = process.env.CORTEX_FRAME_HIERARCHY;
    process.env.CORTEX_FRAME_HIERARCHY = "0";
    try {
      const r = await runFrameExtraction({ repoPath: root, project, dbPath });
      expect(r.status === "ok" || r.status === "skipped").toBe(true);
    } finally { process.env.CORTEX_FRAME_HIERARCHY = prev; }
  }, 30_000);
});
