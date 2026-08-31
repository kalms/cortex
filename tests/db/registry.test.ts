// tests/db/registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Registry, isTmpPath, defaultRegistryPath } from "../../src/db/registry.js";

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
      {
        name: "a-b-c",
        root_path: "/a/b/c",
        indexed_at: "2026-06-05T00:00:00.000Z",
        worktree_of: null,
        branch: null,
      },
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

  it("throws when a different name claims an already-registered root_path", () => {
    reg.register("name-a", "/shared/path", "t");
    expect(() => reg.register("name-b", "/shared/path", "t")).toThrow();
  });

  it("finds a repo by root_path", () => {
    reg.register("a-b-c", "/a/b/c", "2026-06-05T00:00:00.000Z");
    expect(reg.findByRootPath("/a/b/c")).toMatchObject({ name: "a-b-c", root_path: "/a/b/c" });
  });

  it("returns null for an unknown root_path", () => {
    reg.register("a-b-c", "/a/b/c", "2026-06-05T00:00:00.000Z");
    expect(reg.findByRootPath("/nope")).toBeNull();
  });

  it("finds a worktree row by its own root_path, carrying worktree_of", () => {
    reg.register("wt", "/a/b/c-wt", "t", { worktree_of: "/a/b/c", branch: "feature/x" });
    expect(reg.findByRootPath("/a/b/c-wt")).toMatchObject({
      name: "wt", root_path: "/a/b/c-wt", worktree_of: "/a/b/c", branch: "feature/x",
    });
  });

  it("follows a row moved to a new root_path", () => {
    reg.register("a-b-c", "/a/b/c", "t");
    reg.register("a-b-c", "/moved", "t");
    expect(reg.findByRootPath("/a/b/c")).toBeNull();
    expect(reg.findByRootPath("/moved")).toMatchObject({ name: "a-b-c" });
  });
});

describe("defaultRegistryPath", () => {
  it("honors the CORTEX_REGISTRY_DB env override", () => {
    const prev = process.env.CORTEX_REGISTRY_DB;
    process.env.CORTEX_REGISTRY_DB = "/tmp/custom-registry.db";
    try {
      expect(defaultRegistryPath()).toBe("/tmp/custom-registry.db");
    } finally {
      if (prev === undefined) delete process.env.CORTEX_REGISTRY_DB;
      else process.env.CORTEX_REGISTRY_DB = prev;
    }
  });

  it("defaults to ~/.local/share/cortex-indexer/registry.db (XDG data home) when no env set", () => {
    const prevReg = process.env.CORTEX_REGISTRY_DB;
    const prevXdg = process.env.XDG_DATA_HOME;
    delete process.env.CORTEX_REGISTRY_DB;
    delete process.env.XDG_DATA_HOME;
    try {
      expect(defaultRegistryPath().endsWith("/.local/share/cortex-indexer/registry.db")).toBe(true);
    } finally {
      if (prevReg !== undefined) process.env.CORTEX_REGISTRY_DB = prevReg;
      if (prevXdg !== undefined) process.env.XDG_DATA_HOME = prevXdg;
    }
  });

  it("honors $XDG_DATA_HOME for the registry location", () => {
    const prevReg = process.env.CORTEX_REGISTRY_DB;
    const prevXdg = process.env.XDG_DATA_HOME;
    delete process.env.CORTEX_REGISTRY_DB;
    process.env.XDG_DATA_HOME = "/custom/data";
    try {
      expect(defaultRegistryPath()).toBe("/custom/data/cortex-indexer/registry.db");
    } finally {
      if (prevReg !== undefined) process.env.CORTEX_REGISTRY_DB = prevReg;
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
    }
  });
});
