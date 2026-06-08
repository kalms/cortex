// tests/db/repo-id.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRepoId, ensureRepoId, repoIdFile } from "../../src/db/repo-id.js";

describe("repo-id", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cortex-repoid-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("returns null when no cortex.json exists", () => {
    expect(readRepoId(root)).toBeNull();
  });

  it("reads the repoId from an existing cortex.json", () => {
    writeFileSync(repoIdFile(root), JSON.stringify({ repoId: "abc-123" }));
    expect(readRepoId(root)).toBe("abc-123");
  });

  it("returns null when cortex.json exists but has no repoId", () => {
    writeFileSync(repoIdFile(root), JSON.stringify({ other: 1 }));
    expect(readRepoId(root)).toBeNull();
  });

  it("ensureRepoId mints, persists, and returns a UUID when absent", () => {
    const id = ensureRepoId(root);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(readFileSync(repoIdFile(root), "utf-8")).repoId).toBe(id);
  });

  it("ensureRepoId is idempotent — second call returns the same id", () => {
    const first = ensureRepoId(root);
    const second = ensureRepoId(root);
    expect(second).toBe(first);
  });

  it("ensureRepoId preserves other keys already in cortex.json", () => {
    writeFileSync(repoIdFile(root), JSON.stringify({ name: "demo" }, null, 2));
    ensureRepoId(root);
    const parsed = JSON.parse(readFileSync(repoIdFile(root), "utf-8"));
    expect(parsed.name).toBe("demo");
    expect(parsed.repoId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
