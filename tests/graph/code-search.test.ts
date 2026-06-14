import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { GraphStore } from "../../src/graph/store.js";
import { runCodeSearch } from "../../src/graph/code-search.js";

describe("runCodeSearch", () => {
  let dir: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-code-search-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "export function extractThing() {\n  return doExtract();\n}\n");
    writeFileSync(join(dir, "notes.md"), "# Doc\nthis mentions extract in prose\n");
    const dbPath = join(dir, "graph.db");
    store = new GraphStore(dbPath);
    const fn = store.createNode({ kind: "function", name: "extractThing", qualified_name: "p.src.a.extractThing", file_path: "src/a.ts" });
    const db = new Database(dbPath);
    db.prepare("UPDATE nodes SET project = ?, start_line = 1, end_line = 3 WHERE id = ?").run("p", fn.id);
    db.close();
  });
  afterEach(() => { store?.close(); rmSync(dir, { recursive: true, force: true }); });

  it("returns hits with file/line/text parsed from rg output", async () => {
    const out = await runCodeSearch({ pattern: "extract", repoRoot: dir, maxHits: 50 });
    expect(out.kind).toBe("hits");
    if (out.kind !== "hits") return;
    const files = out.hits.map((h) => h.file);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("notes.md");
    const aHit = out.hits.find((h) => h.file === "src/a.ts")!;
    expect(aHit.line).toBeGreaterThan(0);
    expect(aHit.text).toContain("extract");
  });

  it("annotates the enclosing symbol when store + project are given", async () => {
    const out = await runCodeSearch({ pattern: "extract", repoRoot: dir, store, project: "p", maxHits: 50 });
    if (out.kind !== "hits") throw new Error("expected hits");
    const aHit = out.hits.find((h) => h.file === "src/a.ts" && h.enclosing)!;
    expect(aHit.enclosing!.kind).toBe("function");
    expect(aHit.enclosing!.qualified_name).toBe("p.src.a.extractThing");
    const mdHit = out.hits.find((h) => h.file === "notes.md")!;
    expect(mdHit.enclosing).toBeUndefined();
  });

  it("caps the number of hits at maxHits", async () => {
    const out = await runCodeSearch({ pattern: "extract", repoRoot: dir, maxHits: 1 });
    if (out.kind !== "hits") throw new Error("expected hits");
    expect(out.hits.length).toBe(1);
  });

  it("returns empty for a pattern with no matches", async () => {
    const out = await runCodeSearch({ pattern: "zzznomatchzzz", repoRoot: dir });
    expect(out.kind).toBe("empty");
  });

  it("returns invalid_pattern for a bad regex", async () => {
    const out = await runCodeSearch({ pattern: "(", repoRoot: dir });
    expect(out.kind).toBe("invalid_pattern");
  });
});
