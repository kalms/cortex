import { describe, it, expect, afterEach, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { GraphStore } from "../../src/graph/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function createTestCbmDb(dir: string): string {
  const dbPath = join(dir, "test-cbm.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE projects (
      name TEXT PRIMARY KEY,
      indexed_at TEXT NOT NULL,
      root_path TEXT NOT NULL
    );
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      label TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      file_path TEXT DEFAULT '',
      start_line INTEGER DEFAULT 0,
      end_line INTEGER DEFAULT 0,
      properties TEXT DEFAULT '{}'
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      properties TEXT DEFAULT '{}'
    );
    INSERT INTO projects VALUES ('test', '2026-04-13T00:00:00Z', '/test/repo');
    INSERT INTO nodes (project, label, name, qualified_name, file_path, start_line, end_line)
      VALUES ('test', 'Function', 'handleRequest', 'src/server.ts::handleRequest', 'src/server.ts', 10, 25);
    INSERT INTO nodes (project, label, name, qualified_name, file_path, start_line, end_line)
      VALUES ('test', 'Function', 'parseBody', 'src/server.ts::parseBody', 'src/server.ts', 30, 45);
    INSERT INTO nodes (project, label, name, qualified_name, file_path, start_line, end_line)
      VALUES ('test', 'Class', 'Router', 'src/router.ts::Router', 'src/router.ts', 1, 80);
    INSERT INTO edges (project, source_id, target_id, type)
      VALUES ('test', 1, 2, 'CALLS');
    INSERT INTO edges (project, source_id, target_id, type)
      VALUES ('test', 3, 1, 'CALLS');
  `);
  db.close();
  return dbPath;
}

describe("CBM ATTACH", () => {
  let store: GraphStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cortex-test-"));
    store = new GraphStore(":memory:");
  });

  afterEach(() => {
    store?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("attaches a CBM database and reports attached state", () => {
    const cbmPath = createTestCbmDb(tmpDir);
    expect(store.isCbmAttached()).toBe(false);
    store.attachCbm(cbmPath);
    expect(store.isCbmAttached()).toBe(true);
  });

  it("returns false for isCbmAttached when no db attached", () => {
    expect(store.isCbmAttached()).toBe(false);
  });

  it("handles missing CBM database gracefully", () => {
    expect(() => store.attachCbm("/nonexistent/path.db")).not.toThrow();
    expect(store.isCbmAttached()).toBe(false);
  });
});
