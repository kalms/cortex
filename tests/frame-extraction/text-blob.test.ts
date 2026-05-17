// tests/frame-extraction/text-blob.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { collectBlobsFromGraph } from "../../scripts/frame-extraction/text-blob.js";

let root: string;
let db: Database.Database;

const ENTITY_KINDS = ["function", "class", "method", "interface", "type", "variable"];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cortex-text-blob-"));
  db = new Database(join(root, "graph.db"));
  // Minimal schema covering only the columns we read. Real Cortex graph
  // DBs have more columns — we explicitly do NOT depend on those.
  db.exec(`
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      file_path TEXT,
      project TEXT
    );
  `);
  const insert = db.prepare(
    "INSERT INTO nodes (kind, name, file_path, project) VALUES (?, ?, ?, ?)",
  );
  // src/auth/middleware.ts: 2 functions
  insert.run("function", "authMiddleware", "src/auth/middleware.ts", "p");
  insert.run("function", "extractToken", "src/auth/middleware.ts", "p");
  // src/billing/invoice.ts: 1 class + 1 function
  insert.run("class", "InvoiceList", "src/billing/invoice.ts", "p");
  insert.run("function", "computeTotal", "src/billing/invoice.ts", "p");
  // node with no file_path (e.g. project node) — must be ignored
  insert.run("project", "p", null, "p");
  // wrong project — must be ignored
  insert.run("function", "ignored", "src/x.ts", "other_project");
  // wrong kind — must be ignored
  insert.run("section", "## intro", "README.md", "p");
});
afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

describe("collectBlobsFromGraph", () => {
  it("groups entity names per file_path, scoped to the project", () => {
    const blobs = collectBlobsFromGraph(db, "p", ENTITY_KINDS);
    const middleware = blobs.find((b) => b.path === "src/auth/middleware.ts");
    const invoice = blobs.find((b) => b.path === "src/billing/invoice.ts");

    // Path tokens come from tokenizePath; symbol words are derived from
    // each identifier via the same word-splitting rules. We expect both
    // sets to appear in the blob text (order-stable join).
    expect(middleware?.text).toMatch(/\bauth\b/);
    expect(middleware?.text).toMatch(/\bmiddleware\b/);
    expect(middleware?.text).toMatch(/\bauthmiddleware\b|\bauth middleware\b/i);
    expect(middleware?.text).toMatch(/\bextract\b/);
    expect(middleware?.text).toMatch(/\btoken\b/);

    expect(invoice?.text).toMatch(/\bbilling\b/);
    expect(invoice?.text).toMatch(/\binvoice\b/);
    expect(invoice?.text).toMatch(/\bcompute\b/);
    expect(invoice?.text).toMatch(/\btotal\b/);
  });

  it("excludes other projects' nodes", () => {
    const blobs = collectBlobsFromGraph(db, "p", ENTITY_KINDS);
    expect(blobs.find((b) => b.path === "src/x.ts")).toBeUndefined();
  });

  it("excludes non-entity node kinds", () => {
    const blobs = collectBlobsFromGraph(db, "p", ENTITY_KINDS);
    expect(blobs.find((b) => b.path === "README.md")).toBeUndefined();
  });

  it("excludes rows with NULL file_path", () => {
    const blobs = collectBlobsFromGraph(db, "p", ENTITY_KINDS);
    // The project node had file_path = null. No blob for null path.
    expect(blobs.every((b) => b.path !== "" && b.path !== null && b.path !== undefined)).toBe(true);
  });

  it("returns deterministic ordering (paths sorted, tokens deduped)", () => {
    const a = collectBlobsFromGraph(db, "p", ENTITY_KINDS);
    const b = collectBlobsFromGraph(db, "p", ENTITY_KINDS);
    expect(a).toEqual(b);
    // Paths sorted lexically.
    const paths = a.map((b) => b.path);
    expect([...paths]).toEqual([...paths].sort());
  });
});
