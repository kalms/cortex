import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../../src/db/registry.js";
import { listProjectsFromRegistry, deleteProjectFromRegistry } from "../../src/cli/commands/index.js";

let tmp: string;
const saved = process.env.CORTEX_REGISTRY_DB;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "enum-")); process.env.CORTEX_REGISTRY_DB = join(tmp, "registry.db"); });
afterEach(() => { process.env.CORTEX_REGISTRY_DB = saved; rmSync(tmp, { recursive: true, force: true }); });

describe("index list/delete via registry", () => {
  it("list reads the registry (never the cache dir), so .tmp corpus never appears", () => {
    const reg = new Registry();
    reg.register("real-repo", "/Users/x/real", new Date(0).toISOString());
    reg.register("tmp-corpus", "/Users/x/.tmp/corpus", new Date(0).toISOString()); // rejected by isTmpPath guard
    reg.close();
    const names = listProjectsFromRegistry().map((p) => p.name);
    expect(names).toContain("real-repo");
    expect(names).not.toContain("tmp-corpus");
  });

  it("delete removes the registry row", () => {
    const reg = new Registry(); reg.register("gone", "/Users/x/gone", new Date(0).toISOString()); reg.close();
    expect(deleteProjectFromRegistry("gone")).toBe(true);
    expect(listProjectsFromRegistry().find((p) => p.name === "gone")).toBeUndefined();
  });
});
