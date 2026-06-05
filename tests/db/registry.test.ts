// tests/db/registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Registry, isTmpPath } from "../../src/db/registry.js";

describe("Registry", () => {
  let dir: string;
  let reg: Registry;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-registry-"));
    reg = new Registry(join(dir, "_registry.db"));
  });
  afterEach(() => {
    reg.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers and lists a repo", () => {
    reg.register("a-b-c", "/a/b/c", "2026-06-05T00:00:00.000Z");
    expect(reg.list()).toEqual([
      { name: "a-b-c", root_path: "/a/b/c", indexed_at: "2026-06-05T00:00:00.000Z" },
    ]);
  });

  it("upserts on repeated register (no duplicate rows)", () => {
    reg.register("a-b-c", "/a/b/c", "2026-06-05T00:00:00.000Z");
    reg.register("a-b-c", "/a/b/c", "2026-06-06T00:00:00.000Z");
    const rows = reg.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexed_at).toBe("2026-06-06T00:00:00.000Z");
  });

  it("rejects paths under a .tmp segment", () => {
    reg.register("tmp-proj", "/Users/x/cortex/.tmp/frame-extraction-corpus/foo", "t");
    expect(reg.list()).toEqual([]);
    expect(isTmpPath("/a/.tmp/b")).toBe(true);
    expect(isTmpPath("/a/tmpfoo/b")).toBe(false);
  });

  it("removes a repo by name", () => {
    reg.register("a", "/a", "t");
    reg.remove("a");
    expect(reg.list()).toEqual([]);
  });

  it("two registrations both land (no lost update)", () => {
    reg.register("a", "/a", "t");
    reg.register("b", "/b", "t");
    expect(reg.list().map((r) => r.name)).toEqual(["a", "b"]);
  });
});
