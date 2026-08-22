import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { GraphStore } from "../../src/graph/store.js";
import { runCodeSearch, rankSearchHits } from "../../src/graph/code-search.js";
import type { SearchHit } from "../../src/graph/code-search.js";

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

describe("rankSearchHits", () => {
  const fn = (over: Partial<SearchHit>): SearchHit => ({ file: "f", line: 1, text: "t", ...over });

  it("ranks function-enclosed hits above module-enclosed above unenclosed", () => {
    const hits = [
      fn({ file: "z.md", enclosing: undefined }),
      fn({ file: "m.ts", enclosing: { kind: "module", qualified_name: "m", file_path: "m.ts" } }),
      fn({ file: "a.ts", enclosing: { kind: "function", qualified_name: "a.fn", file_path: "a.ts" } }),
    ];
    const ranked = rankSearchHits(hits);
    expect(ranked.map((h) => h.file)).toEqual(["a.ts", "m.ts", "z.md"]);
  });

  it("is a stable file/line tiebreak at equal weight", () => {
    const e = { kind: "function", qualified_name: "x", file_path: "x" };
    const hits = [fn({ file: "b.ts", line: 2, enclosing: e }), fn({ file: "b.ts", line: 1, enclosing: e }), fn({ file: "a.ts", line: 9, enclosing: e })];
    const ranked = rankSearchHits(hits);
    expect(ranked.map((h) => `${h.file}:${h.line}`)).toEqual(["a.ts:9", "b.ts:1", "b.ts:2"]);
  });

  it("does not mutate the input array", () => {
    const e = { kind: "function", qualified_name: "x", file_path: "x" };
    const hits = [fn({ file: "b.ts", enclosing: e }), fn({ file: "a.ts", enclosing: e })];
    const before = hits.map((h) => h.file);
    rankSearchHits(hits);
    expect(hits.map((h) => h.file)).toEqual(before);
  });
});

describe("runCodeSearch — scoping options", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-code-scope-"));
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "src", "a.ts"), "const ribbon = 1;\n");
    writeFileSync(join(dir, "docs", "guide.md"), "the ribbon is described here\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("path scopes results to a subtree", async () => {
    const out = await runCodeSearch({ pattern: "ribbon", repoRoot: dir, path: "docs" });
    expect(out.kind).toBe("hits");
    if (out.kind !== "hits") return;
    expect(out.hits.map((h) => h.file)).toEqual(["docs/guide.md"]);
  });

  it("glob scopes results by filename pattern", async () => {
    const out = await runCodeSearch({ pattern: "ribbon", repoRoot: dir, glob: "*.ts" });
    expect(out.kind).toBe("hits");
    if (out.kind !== "hits") return;
    expect(out.hits.map((h) => h.file)).toEqual(["src/a.ts"]);
  });

  it("filesOnly returns a files outcome, not hits", async () => {
    const out = await runCodeSearch({ pattern: "ribbon", repoRoot: dir, filesOnly: true });
    expect(out.kind).toBe("files");
    if (out.kind !== "files") return;
    expect(out.files.sort()).toEqual(["docs/guide.md", "src/a.ts"]);
  });

  it("multiline matches a pattern spanning two lines", async () => {
    writeFileSync(join(dir, "src", "b.ts"), "function open() {\n  return close();\n}\n");
    const out = await runCodeSearch({ pattern: "open\\(\\).*close", repoRoot: dir, multiline: true });
    expect(out.kind).toBe("hits");
    if (out.kind !== "hits") return;
    expect(out.hits.some((h) => h.file === "src/b.ts")).toBe(true);
  });

  it("without multiline the same pattern does not match", async () => {
    writeFileSync(join(dir, "src", "b.ts"), "function open() {\n  return close();\n}\n");
    const out = await runCodeSearch({ pattern: "open\\(\\).*close", repoRoot: dir });
    expect(out.kind).toBe("empty");
  });
});

describe("runCodeSearch — path validation and caps", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-code-guard-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "const ribbon = 1;\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("rejects a path that escapes the repo root", async () => {
    const out = await runCodeSearch({ pattern: "x", repoRoot: dir, path: "../../etc" });
    expect(out.kind).toBe("invalid_path");
  });

  it("rejects an absolute path (it also breaks hit parsing)", async () => {
    const out = await runCodeSearch({ pattern: "x", repoRoot: dir, path: "/etc" });
    expect(out.kind).toBe("invalid_path");
  });

  it("reports a nonexistent path instead of answering 'no results'", async () => {
    const out = await runCodeSearch({ pattern: "ribbon", repoRoot: dir, path: "nosuchdir" });
    expect(out.kind).toBe("invalid_path");
    if (out.kind !== "invalid_path") return;
    expect(out.detail).toContain("does not exist");
  });

  it("searches dotfile directories like .github", async () => {
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".github", "ci.yml"), "name: ribbon\n");
    const out = await runCodeSearch({ pattern: "ribbon", repoRoot: dir });
    expect(out.kind).toBe("hits");
    if (out.kind !== "hits") return;
    expect(out.hits.some((h) => h.file === ".github/ci.yml")).toBe(true);
  });

  it("filesOnly honors maxHits", async () => {
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, "src", `f${i}.ts`), "ribbon\n");
    const out = await runCodeSearch({ pattern: "ribbon", repoRoot: dir, filesOnly: true, maxHits: 2 });
    expect(out.kind).toBe("files");
    if (out.kind !== "files") return;
    expect(out.files).toHaveLength(2);
  });
});
